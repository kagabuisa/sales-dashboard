const path = require("path");
const express = require("express");
const mysql = require("mysql2/promise");
const LRUCache = require("lru-cache");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

const config = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME"].forEach(requireEnv);

const SALES_ITEM_TABLE = process.env.SALES_ITEM_TABLE || "tabSales Invoice Item";
const SALES_INVOICE_TABLE = process.env.SALES_INVOICE_TABLE || "tabSales Invoice";
const ITEM_TABLE = process.env.ITEM_TABLE || "tabItem";
const AMOUNT_COLUMN = process.env.AMOUNT_COLUMN || "amount";
const QTY_COLUMN = process.env.QTY_COLUMN || "qty";
const INVOICE_ID_COLUMN = process.env.INVOICE_ID_COLUMN || "parent";
const DATE_COLUMN = process.env.DATE_COLUMN || "posting_date";
const CUSTOMER_COLUMN = process.env.CUSTOMER_COLUMN || "customer";
const ITEM_COLUMN = process.env.ITEM_COLUMN || "item_code";
const ITEM_TABLE_ID_COLUMN = process.env.ITEM_TABLE_ID_COLUMN || "name";
const CATEGORY_COLUMN = process.env.CATEGORY_COLUMN || "item_category";
const WAREHOUSE_COLUMN = process.env.WAREHOUSE_COLUMN || "warehouse";
const COST_COLUMN = process.env.COST_COLUMN || "cost";
const RATE_COLUMN = process.env.RATE_COLUMN || "rate";
const ITEM_INDEX_COLUMN = process.env.ITEM_INDEX_COLUMN || "idx";
const STATUS_COLUMN = process.env.STATUS_COLUMN || "docstatus";
const STATUS_VALUE = process.env.STATUS_VALUE || "1";
const DEFAULT_RANGE_DAYS = Number(process.env.DEFAULT_RANGE_DAYS || 30);
const MONTHS_CACHE_TTL_MS = Number(process.env.MONTHS_CACHE_TTL_MS || 300000);

const monthsCache = new LRUCache({
  max: 20,
  ttl: MONTHS_CACHE_TTL_MS,
});

function safeIdent(name) {
  if (!/^[A-Za-z0-9_ ]+$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `\`${name.replace(/`/g, "")}\``;
}

const iTable = safeIdent(SALES_ITEM_TABLE);
const hTable = safeIdent(SALES_INVOICE_TABLE);
const tTable = safeIdent(ITEM_TABLE);
const cAmount = safeIdent(AMOUNT_COLUMN);
const cQty = safeIdent(QTY_COLUMN);
const cInvoiceId = safeIdent(INVOICE_ID_COLUMN);
const cDate = safeIdent(DATE_COLUMN);
const cCustomer = safeIdent(CUSTOMER_COLUMN);
const cItem = safeIdent(ITEM_COLUMN);
const cItemTableId = safeIdent(ITEM_TABLE_ID_COLUMN);
const cCategory = safeIdent(CATEGORY_COLUMN);
const cWarehouse = safeIdent(WAREHOUSE_COLUMN);
const cCost = safeIdent(COST_COLUMN);
const cRate = safeIdent(RATE_COLUMN);
const cItemIndex = safeIdent(ITEM_INDEX_COLUMN);
const cStatus = safeIdent(STATUS_COLUMN);

const profitExpr = `(${iTable}.${cAmount} - (${iTable}.${cQty} * COALESCE(${tTable}.${cCost}, 0)))`;

const pool = mysql.createPool({
  ...config,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 as ok");
    res.json({ ok: rows[0]?.ok === 1 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/months", async (req, res) => {
  try {
    const daysRaw = Number(req.query.days || 0);
    const monthsRaw = Number(req.query.months || 3);
    const useDays = Number.isFinite(daysRaw) && daysRaw > 0;
    const months = Number.isFinite(monthsRaw) ? Math.min(Math.max(monthsRaw, 1), 12) : 3;
    const { start, end } = useDays
      ? getRollingRange(Math.min(Math.max(daysRaw, 1), 366), req.query.end)
      : getMonthRange(months, req.query.end);
    const docstatus =
      req.query.docstatus !== undefined && req.query.docstatus !== null && req.query.docstatus !== ""
        ? req.query.docstatus
        : STATUS_VALUE;
    const cacheKey = JSON.stringify({
      mode: useDays ? "days" : "months",
      months,
      days: useDays ? Math.min(Math.max(daysRaw, 1), 366) : null,
      start,
      end,
      docstatus: String(docstatus),
    });
    const cached = monthsCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    const where = [`${hTable}.${cDate} >= ?`, `${hTable}.${cDate} <= ?`];
    const params = [start, end];
    if (docstatus !== undefined && docstatus !== null && docstatus !== "") {
      where.push(`${hTable}.${cStatus} = ?`);
      params.push(docstatus);
    }
    const whereSql = where.join(" AND ");

    const [invoices] = await pool.query(
      `SELECT
         ${hTable}.name AS name,
         ${hTable}.${cDate} AS posting_date,
         ${hTable}.${cCustomer} AS customer,
         ${hTable}.${cStatus} AS docstatus,
         ${hTable}.grand_total AS grand_total,
         ${hTable}.outstanding_amount AS outstanding_amount
       FROM ${hTable}
       WHERE ${whereSql}
       ORDER BY ${hTable}.${cDate} ASC`,
      params
    );

    const [items] = await pool.query(
      `SELECT
         ${iTable}.${cInvoiceId} AS parent,
         ${iTable}.${cItem} AS item_code,
         ${iTable}.${cWarehouse} AS warehouse,
         ${iTable}.${cQty} AS qty,
         ${iTable}.${cRate} AS rate,
         ${iTable}.${cAmount} AS amount
       FROM ${iTable}
       JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
       WHERE ${whereSql}
       ORDER BY ${iTable}.${cInvoiceId} ASC`,
      params
    );

    const [products] = await pool.query(
      `SELECT DISTINCT
         ${tTable}.${cItemTableId} AS name,
         ${tTable}.${cCategory} AS item_category,
         ${tTable}.${cCost} AS cost
       FROM ${tTable}
       JOIN ${iTable} ON ${iTable}.${cItem} = ${tTable}.${cItemTableId}
       JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
       WHERE ${whereSql}`,
      params
    );

    const payload = {
      range: { start, end },
      mode: useDays ? "days" : "months",
      defaultDocstatus: docstatus,
      invoices,
      items,
      products,
    };
    monthsCache.set(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatDateYMD(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeRange(start, end) {
  if (start || end) {
    return { start, end };
  }
  const today = new Date();
  const endDate = formatDateYMD(today);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (DEFAULT_RANGE_DAYS - 1));
  return { start: formatDateYMD(startDate), end: endDate };
}

function getMonthRange(months, endValue) {
  const safeMonths = Number.isFinite(months) && months > 0 ? months : 3;
  const endDate = endValue ? new Date(endValue) : new Date();
  endDate.setHours(0, 0, 0, 0);
  const end = formatDateYMD(endDate);
  const startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  startDate.setMonth(startDate.getMonth() - (safeMonths - 1));
  return { start: formatDateYMD(startDate), end };
}

function getRollingRange(days, endValue) {
  const safeDays = Number.isFinite(days) && days > 0 ? days : 31;
  const endDate = endValue ? new Date(endValue) : new Date();
  endDate.setHours(0, 0, 0, 0);
  const end = formatDateYMD(endDate);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (safeDays - 1));
  return { start: formatDateYMD(startDate), end };
}

function buildWhere(start, end, filters) {
  const clauses = [];
  const params = [];

  if (start) {
    params.push(start);
    clauses.push(`${hTable}.${cDate} >= ?`);
  }
  if (end) {
    params.push(end);
    clauses.push(`${hTable}.${cDate} <= ?`);
  }

  if (filters?.item) {
    params.push(filters.item);
    clauses.push(`${iTable}.${cItem} = ?`);
  }
  if (filters?.warehouse) {
    params.push(filters.warehouse);
    clauses.push(`${iTable}.${cWarehouse} = ?`);
  }
  if (filters?.category) {
    params.push(filters.category);
    clauses.push(`${tTable}.${cCategory} = ?`);
  }
  if (filters?.customer) {
    params.push(filters.customer);
    clauses.push(`${hTable}.${cCustomer} = ?`);
  }

  if (filters?.docstatus !== null && filters?.docstatus !== undefined && filters?.docstatus !== "") {
    params.push(filters.docstatus);
    clauses.push(`${hTable}.${cStatus} = ?`);
  } else if (STATUS_VALUE !== undefined && STATUS_VALUE !== null && STATUS_VALUE !== "") {
    params.push(STATUS_VALUE);
    clauses.push(`${hTable}.${cStatus} = ?`);
  }

  return { where: clauses.length ? clauses.join(" AND ") : "1=1", params };
}

function withFilters(req) {
  return {
    item: req.query.item || null,
    warehouse: req.query.warehouse || null,
    category: req.query.category || null,
    customer: req.query.customer || null,
    docstatus: req.query.docstatus || null,
  };
}

app.get("/api/metrics", async (req, res) => {
  try {
    const range = normalizeRange(req.query.start, req.query.end);
    const filters = withFilters(req);
    const { where, params } = buildWhere(range.start, range.end, filters);

    const sql = `
      SELECT
        SUM(${iTable}.${cAmount}) AS total_revenue,
        SUM(${iTable}.${cQty}) AS total_qty,
        COUNT(DISTINCT ${iTable}.${cInvoiceId}) AS total_invoices,
        AVG(invoice_totals.invoice_total) AS avg_order_value,
        SUM(${profitExpr}) AS total_profit,
        AVG(invoice_totals.invoice_profit) AS avg_order_profit
      FROM ${iTable}
      JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
      LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
      JOIN (
        SELECT
          ${iTable}.${cInvoiceId} AS invoice_id,
          SUM(${iTable}.${cAmount}) AS invoice_total,
          SUM(${profitExpr}) AS invoice_profit
        FROM ${iTable}
        JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
        LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
        WHERE ${where}
        GROUP BY ${iTable}.${cInvoiceId}
      ) invoice_totals ON invoice_totals.invoice_id = ${iTable}.${cInvoiceId}
      WHERE ${where}
    `;

    const [rows] = await pool.query(sql, [...params, ...params]);
    const row = rows[0] || {};
    const totalRevenue = Number(row.total_revenue || 0);
    const totalProfit = Number(row.total_profit || 0);
    res.json({
      totalRevenue,
      totalQty: Number(row.total_qty || 0),
      totalInvoices: Number(row.total_invoices || 0),
      avgOrderValue: Number(row.avg_order_value || 0),
      totalProfit,
      profitMargin: totalRevenue ? totalProfit / totalRevenue : 0,
      avgOrderProfit: Number(row.avg_order_profit || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/timeseries", async (req, res) => {
  try {
    const range = normalizeRange(req.query.start, req.query.end);
    const { granularity = "day" } = req.query;
    const filters = withFilters(req);
    const { where, params } = buildWhere(range.start, range.end, filters);

    const groupExpr =
      granularity === "month"
        ? `DATE_FORMAT(${hTable}.${cDate}, '%Y-%m-01')`
        : granularity === "week"
          ? `STR_TO_DATE(CONCAT(YEARWEEK(${hTable}.${cDate}, 3), ' Monday'), '%x%v %W')`
          : `DATE(${hTable}.${cDate})`;

    const sql = `
      SELECT
        ${groupExpr} AS bucket,
        SUM(${iTable}.${cAmount}) AS revenue,
        SUM(${iTable}.${cQty}) AS qty,
        SUM(${profitExpr}) AS profit
      FROM ${iTable}
      JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
      LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const [rows] = await pool.query(sql, params);
    res.json(
      rows.map((r) => ({
        bucket: r.bucket,
        revenue: Number(r.revenue || 0),
        qty: Number(r.qty || 0),
        profit: Number(r.profit || 0),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/top-items", async (req, res) => {
  try {
    const range = normalizeRange(req.query.start, req.query.end);
    const { limit = 10 } = req.query;
    const filters = withFilters(req);
    const { where, params } = buildWhere(range.start, range.end, filters);

    const sql = `
      SELECT
        ${iTable}.${cItem} AS item,
        SUM(${iTable}.${cAmount}) AS revenue,
        SUM(${iTable}.${cQty}) AS qty,
        SUM(${profitExpr}) AS profit
      FROM ${iTable}
      JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
      LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
      WHERE ${where}
      GROUP BY ${iTable}.${cItem}
      ORDER BY revenue DESC
      LIMIT ?
    `;

    const [rows] = await pool.query(sql, [...params, Number(limit)]);
    res.json(
      rows.map((r) => ({
        item: r.item,
        revenue: Number(r.revenue || 0),
        qty: Number(r.qty || 0),
        profit: Number(r.profit || 0),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/top-customers", async (req, res) => {
  try {
    const range = normalizeRange(req.query.start, req.query.end);
    const { limit = 10 } = req.query;
    const filters = withFilters(req);
    const { where, params } = buildWhere(range.start, range.end, filters);

    const sql = `
      SELECT
        ${hTable}.${cCustomer} AS customer,
        SUM(${iTable}.${cAmount}) AS revenue,
        SUM(${iTable}.${cQty}) AS qty,
        SUM(${profitExpr}) AS profit
      FROM ${iTable}
      JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
      LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
      WHERE ${where}
      GROUP BY ${hTable}.${cCustomer}
      ORDER BY revenue DESC
      LIMIT ?
    `;

    const [rows] = await pool.query(sql, [...params, Number(limit)]);
    res.json(
      rows.map((r) => ({
        customer: r.customer,
        revenue: Number(r.revenue || 0),
        qty: Number(r.qty || 0),
        profit: Number(r.profit || 0),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/top-categories", async (req, res) => {
  try {
    const range = normalizeRange(req.query.start, req.query.end);
    const { limit = 10 } = req.query;
    const filters = withFilters(req);
    const { where, params } = buildWhere(range.start, range.end, filters);

    const sql = `
      SELECT
        ${tTable}.${cCategory} AS category,
        SUM(${iTable}.${cAmount}) AS revenue,
        SUM(${iTable}.${cQty}) AS qty,
        SUM(${profitExpr}) AS profit
      FROM ${iTable}
      JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
      LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
      WHERE ${where}
      GROUP BY ${tTable}.${cCategory}
      ORDER BY revenue DESC
      LIMIT ?
    `;

    const [rows] = await pool.query(sql, [...params, Number(limit)]);
    res.json(
      rows.map((r) => ({
        category: r.category || "Uncategorized",
        revenue: Number(r.revenue || 0),
        qty: Number(r.qty || 0),
        profit: Number(r.profit || 0),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/top-warehouses", async (req, res) => {
  try {
    const range = normalizeRange(req.query.start, req.query.end);
    const { limit = 10 } = req.query;
    const filters = withFilters(req);
    const { where, params } = buildWhere(range.start, range.end, filters);

    const sql = `
      SELECT
        ${iTable}.${cWarehouse} AS warehouse,
        SUM(${iTable}.${cAmount}) AS revenue,
        SUM(${iTable}.${cQty}) AS qty,
        SUM(${profitExpr}) AS profit
      FROM ${iTable}
      JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
      LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
      WHERE ${where}
      GROUP BY ${iTable}.${cWarehouse}
      ORDER BY revenue DESC
      LIMIT ?
    `;

    const [rows] = await pool.query(sql, [...params, Number(limit)]);
    res.json(
      rows.map((r) => ({
        warehouse: r.warehouse || "Unassigned",
        revenue: Number(r.revenue || 0),
        qty: Number(r.qty || 0),
        profit: Number(r.profit || 0),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/filters", async (req, res) => {
  try {
    const range = normalizeRange(req.query.start, req.query.end);
    const filters = withFilters(req);
    const { where, params } = buildWhere(range.start, range.end, filters);
    const statusValue =
      filters.docstatus !== null && filters.docstatus !== undefined && filters.docstatus !== ""
        ? filters.docstatus
        : STATUS_VALUE;

    const [items] = await pool.query(
      `SELECT DISTINCT ${iTable}.${cItem} AS value
       FROM ${iTable}
       JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
       WHERE ${where}
       ORDER BY value ASC`,
      params
    );

    const [warehouses] = await pool.query(
      `SELECT DISTINCT ${iTable}.${cWarehouse} AS value
       FROM ${iTable}
       JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
       WHERE ${where}
       ORDER BY value ASC`,
      params
    );

    const [categories] = await pool.query(
      `SELECT DISTINCT ${tTable}.${cCategory} AS value
       FROM ${iTable}
       JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
       LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
       WHERE ${where}
       ORDER BY value ASC`,
      params
    );

    const [customers] = await pool.query(
      `SELECT DISTINCT ${hTable}.${cCustomer} AS value
       FROM ${iTable}
       JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
       WHERE ${where}
       ORDER BY value ASC`,
      params
    );

    const [years] = await pool.query(
      `SELECT DISTINCT YEAR(${hTable}.${cDate}) AS value
       FROM ${hTable}
       WHERE ${hTable}.${cStatus} = ?
       ORDER BY value ASC`,
      [statusValue]
    );

    res.json({
      items: items.map((r) => r.value).filter(Boolean),
      warehouses: warehouses.map((r) => r.value).filter(Boolean),
      categories: categories.map((r) => r.value).filter(Boolean),
      customers: customers.map((r) => r.value).filter(Boolean),
      years: years.map((r) => r.value).filter(Boolean),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/invoices", async (req, res) => {
  try {
    const range = normalizeRange(req.query.start, req.query.end);
    const { limit = 50 } = req.query;
    const filters = withFilters(req);
    const { where, params } = buildWhere(range.start, range.end, filters);

    const sql = `
      SELECT
        ${hTable}.name AS invoice_no,
        ${hTable}.${cDate} AS posting_date,
        ${hTable}.${cCustomer} AS customer,
        SUM(${iTable}.${cAmount}) AS revenue,
        SUM(${iTable}.${cQty}) AS qty
      FROM ${iTable}
      JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
      LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
      WHERE ${where}
      GROUP BY ${hTable}.name, ${hTable}.${cDate}, ${hTable}.${cCustomer}
      ORDER BY ${hTable}.${cDate} DESC
      LIMIT ?
    `;

    const [rows] = await pool.query(sql, [...params, Number(limit)]);
    res.json(
      rows.map((r) => ({
        invoiceNo: r.invoice_no,
        postingDate: r.posting_date,
        customer: r.customer,
        revenue: Number(r.revenue || 0),
        qty: Number(r.qty || 0),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/invoices/:id", async (req, res) => {
  try {
    const invoiceId = req.params.id;
    const sql = `
      SELECT
        ${hTable}.name AS invoice_no,
        ${hTable}.${cDate} AS posting_date,
        ${hTable}.${cCustomer} AS customer,
        ${hTable}.grand_total AS grand_total,
        ${hTable}.outstanding_amount AS outstanding_amount,
        ${iTable}.${cWarehouse} AS warehouse,
        ${iTable}.${cItem} AS item,
        ${iTable}.${cQty} AS qty,
        ${iTable}.${cRate} AS rate,
        ${iTable}.${cAmount} AS amount
      FROM ${iTable}
      JOIN ${hTable} ON ${hTable}.name = ${iTable}.${cInvoiceId}
      LEFT JOIN ${tTable} ON ${tTable}.${cItemTableId} = ${iTable}.${cItem}
      WHERE ${hTable}.name = ?
      ORDER BY ${iTable}.${cItemIndex} ASC
    `;

    const [rows] = await pool.query(sql, [invoiceId]);
    if (!rows.length) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }
    res.json(
      rows.map((r) => ({
        invoiceNo: r.invoice_no,
        postingDate: r.posting_date,
        customer: r.customer,
        grandTotal: Number(r.grand_total || 0),
        outstandingAmount: Number(r.outstanding_amount || 0),
        warehouse: r.warehouse,
        item: r.item,
        qty: Number(r.qty || 0),
        rate: Number(r.rate || 0),
        amount: Number(r.amount || 0),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Sales dashboard running on http://localhost:${PORT}`);
});
