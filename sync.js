const mysql = require("mysql2/promise");
const { Pool } = require("pg");
require("dotenv").config();

const MYSQL_CONFIG = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  dateStrings: true,
};

const PG_CONFIG = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DB,
  ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : undefined,
};

const BATCH_SIZE = Number(process.env.SYNC_BATCH_SIZE || 2000);

const MYSQL_TABLES = {
  invoiceItem: "tabSales Invoice Item",
  invoice: "tabSales Invoice",
  item: "tabItem",
};

const DEFAULT_CURSOR_TIME = "1970-01-01 00:00:00.000000";
const VERBOSE = process.env.SYNC_VERBOSE === "true";
const ONLY = process.env.SYNC_ONLY;
const QUERY_TIMEOUT_MS = Number(process.env.SYNC_QUERY_TIMEOUT_MS || 60000);

function log(...args) {
  if (VERBOSE) {
    console.log(...args);
  }
}

function shouldRun(name) {
  if (!ONLY) return true;
  const wanted = ONLY.split(",").map((v) => v.trim()).filter(Boolean);
  return wanted.includes(name);
}

async function ensureSchema(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS sales_invoice (
      name TEXT PRIMARY KEY,
      posting_date DATE,
      modified TIMESTAMP,
      customer TEXT,
      docstatus INT,
      grand_total NUMERIC,
      outstanding_amount NUMERIC,
      raw JSONB
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS sales_invoice_item (
      name TEXT PRIMARY KEY,
      parent TEXT,
      item_code TEXT,
      warehouse TEXT,
      qty NUMERIC,
      rate NUMERIC,
      amount NUMERIC,
      creation TIMESTAMP,
      modified TIMESTAMP,
      docstatus INT,
      idx INT,
      raw JSONB
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS item (
      name TEXT PRIMARY KEY,
      item_category TEXT,
      cost NUMERIC,
      modified TIMESTAMP,
      raw JSONB
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS sync_state_kv (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  await pg.query(`ALTER TABLE sync_state_kv ALTER COLUMN value TYPE TEXT;`);

  await pg.query(`
    ALTER TABLE sales_invoice_item
      ADD COLUMN IF NOT EXISTS creation TIMESTAMP,
      ADD COLUMN IF NOT EXISTS docstatus INT;
  `);
  await pg.query(`
    ALTER TABLE sales_invoice
      ADD COLUMN IF NOT EXISTS modified TIMESTAMP;
  `);

  await pg.query(`CREATE INDEX IF NOT EXISTS idx_sales_invoice_posting_date ON sales_invoice (posting_date);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_sales_invoice_docstatus ON sales_invoice (docstatus);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_sales_invoice_modified ON sales_invoice (modified);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_sales_invoice_item_parent ON sales_invoice_item (parent);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_sales_invoice_item_modified ON sales_invoice_item (modified);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_item_modified ON item (modified);`);
}

async function getState(pg, key) {
  const result = await pg.query(`SELECT value FROM sync_state_kv WHERE key = $1`, [key]);
  if (result.rows.length === 0) return null;
  return result.rows[0].value;
}

async function setState(pg, key, value) {
  await pg.query(
    `INSERT INTO sync_state_kv (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

function baseCursorState(prefix) {
  return {
    timeKey: `${prefix}_modified`,
    nameKey: `${prefix}_modified_name`,
  };
}

async function loadCursor(pg, prefix) {
  const { timeKey, nameKey } = baseCursorState(prefix);
  const lastTime = (await getState(pg, timeKey)) || DEFAULT_CURSOR_TIME;
  const lastName = (await getState(pg, nameKey)) || "";
  return { lastTime, lastName, timeKey, nameKey };
}

async function saveCursor(pg, keys, row) {
  await setState(pg, keys.timeKey, row.modified || DEFAULT_CURSOR_TIME);
  await setState(pg, keys.nameKey, row.name);
}

async function syncInvoiceItems(mysqlConn, pg) {
  const cursor = await loadCursor(pg, "sales_invoice_item");
  let total = 0;

  while (true) {
    const [rows] = await mysqlConn.query(
      {
        sql: `SELECT * FROM \`${MYSQL_TABLES.invoiceItem}\`
              WHERE modified > ? OR (modified = ? AND name > ?)
              ORDER BY modified ASC, name ASC
              LIMIT ?`,
        timeout: QUERY_TIMEOUT_MS,
      },
      [cursor.lastTime, cursor.lastTime, cursor.lastName, BATCH_SIZE]
    );

    if (rows.length === 0) break;

    total += rows.length;
    const values = [];
    const placeholders = rows
      .map((row, index) => {
        const base = index * 12;
        values.push(
          row.name,
          row.parent,
          row.item_code,
          row.warehouse,
          row.qty,
          row.rate,
          row.amount,
          row.creation,
          row.modified,
          row.docstatus,
          row.idx,
          JSON.stringify(row)
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`;
      })
      .join(",");

    await pg.query(
      `INSERT INTO sales_invoice_item
       (name, parent, item_code, warehouse, qty, rate, amount, creation, modified, docstatus, idx, raw)
       VALUES ${placeholders}
       ON CONFLICT (name)
       DO UPDATE SET
         parent = EXCLUDED.parent,
         item_code = EXCLUDED.item_code,
         warehouse = EXCLUDED.warehouse,
         qty = EXCLUDED.qty,
         rate = EXCLUDED.rate,
         amount = EXCLUDED.amount,
         creation = EXCLUDED.creation,
         modified = EXCLUDED.modified,
         docstatus = EXCLUDED.docstatus,
         idx = EXCLUDED.idx,
         raw = EXCLUDED.raw`,
      values
    );

    const lastRow = rows[rows.length - 1];
    await saveCursor(pg, cursor, lastRow);
    cursor.lastTime = lastRow.modified;
    cursor.lastName = lastRow.name;
    log("[invoice_item] batch", rows.length, "last", cursor.lastTime, cursor.lastName);

    if (rows.length < BATCH_SIZE) break;
  }

  log("[invoice_item] total", total);
}

async function syncInvoices(mysqlConn, pg) {
  const cursor = await loadCursor(pg, "sales_invoice");
  let total = 0;

  while (true) {
    const [rows] = await mysqlConn.query(
      {
        sql: `SELECT * FROM \`${MYSQL_TABLES.invoice}\`
              WHERE modified > ? OR (modified = ? AND name > ?)
              ORDER BY modified ASC, name ASC
              LIMIT ?`,
        timeout: QUERY_TIMEOUT_MS,
      },
      [cursor.lastTime, cursor.lastTime, cursor.lastName, BATCH_SIZE]
    );

    if (rows.length === 0) break;

    total += rows.length;
    const values = [];
    const placeholders = rows
      .map((row, index) => {
        const base = index * 8;
        values.push(
          row.name,
          row.posting_date,
          row.modified,
          row.customer,
          row.docstatus,
          row.grand_total,
          row.outstanding_amount,
          JSON.stringify(row)
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
      })
      .join(",");

    await pg.query(
      `INSERT INTO sales_invoice
       (name, posting_date, modified, customer, docstatus, grand_total, outstanding_amount, raw)
       VALUES ${placeholders}
       ON CONFLICT (name)
       DO UPDATE SET
         posting_date = EXCLUDED.posting_date,
         modified = EXCLUDED.modified,
         customer = EXCLUDED.customer,
         docstatus = EXCLUDED.docstatus,
         grand_total = EXCLUDED.grand_total,
         outstanding_amount = EXCLUDED.outstanding_amount,
         raw = EXCLUDED.raw`,
      values
    );

    const lastRow = rows[rows.length - 1];
    await saveCursor(pg, cursor, lastRow);
    cursor.lastTime = lastRow.modified;
    cursor.lastName = lastRow.name;
    log("[invoice] batch", rows.length, "last", cursor.lastTime, cursor.lastName);

    if (rows.length < BATCH_SIZE) break;
  }

  log("[invoice] total", total);
}

async function syncItems(mysqlConn, pg) {
  const cursor = await loadCursor(pg, "item");
  let total = 0;

  while (true) {
    const [rows] = await mysqlConn.query(
      {
        sql: `SELECT * FROM \`${MYSQL_TABLES.item}\`
              WHERE modified > ? OR (modified = ? AND name > ?)
              ORDER BY modified ASC, name ASC
              LIMIT ?`,
        timeout: QUERY_TIMEOUT_MS,
      },
      [cursor.lastTime, cursor.lastTime, cursor.lastName, BATCH_SIZE]
    );

    if (rows.length === 0) break;

    total += rows.length;
    const values = [];
    const placeholders = rows
      .map((row, index) => {
        const base = index * 5;
        values.push(row.name, row.item_category, row.cost, row.modified, JSON.stringify(row));
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      })
      .join(",");

    await pg.query(
      `INSERT INTO item (name, item_category, cost, modified, raw)
       VALUES ${placeholders}
       ON CONFLICT (name)
       DO UPDATE SET
         item_category = EXCLUDED.item_category,
         cost = EXCLUDED.cost,
         modified = EXCLUDED.modified,
         raw = EXCLUDED.raw`,
      values
    );

    const lastRow = rows[rows.length - 1];
    await saveCursor(pg, cursor, lastRow);
    cursor.lastTime = lastRow.modified;
    cursor.lastName = lastRow.name;
    log("[item] batch", rows.length, "last", cursor.lastTime, cursor.lastName);

    if (rows.length < BATCH_SIZE) break;
  }

  log("[item] total", total);
}

async function main() {
  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG);
  const pg = new Pool(PG_CONFIG);

  try {
    log("Sync start", new Date().toISOString(), "MySQL", MYSQL_CONFIG.host, MYSQL_CONFIG.database, "PG", PG_CONFIG.host, PG_CONFIG.database);
    await ensureSchema(pg);
    if (shouldRun("item")) {
      log("Sync items start");
      await syncItems(mysqlConn, pg);
    }
    if (shouldRun("invoice")) {
      log("Sync invoices start");
      await syncInvoices(mysqlConn, pg);
    }
    if (shouldRun("invoice_item")) {
      log("Sync invoice items start");
      await syncInvoiceItems(mysqlConn, pg);
    }
    console.log("Sync complete");
  } finally {
    await mysqlConn.end();
    await pg.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
