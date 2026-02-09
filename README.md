# Sales Dashboard (Direct MySQL + Optional Sync)

This app reads directly from your ERP **MySQL** database. A separate sync script still exists if you want to maintain a Postgres analytics copy, but the live dashboard uses MySQL.

Tables synced:

- `tabSales Invoice Item`
- `tabSales Invoice`
- `tabItem`

## Features

- Live KPIs: revenue, qty, invoices, avg order value
- Profitability: computed using `amount - (qty * cost)`
- Top items, customers, categories, warehouses
- Time series chart (day/week/month)
- Invoice list and clickable detail drawer
- Filters: date range, item, warehouse, category, customer, status (Draft/Submitted)
- Calendar day picker with year/month selectors and clear button
- Quick month buttons (current month + previous 3 months)
- Client-side analytics for preloaded data (fast interactions)

## Requirements

- Node.js 18+
- MySQL 5.7+/8.0+

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` with MySQL ERP credentials.

## Run

Start the API/UI:

```bash
npm run dev
```

Optional: run a sync (one-off) if you still want to maintain a Postgres analytics DB:

```bash
npm run sync
```

## Recommended: Scheduled Sync (Optional)

Run every few minutes (example: every 5 minutes):

```bash
*/5 * * * * cd /home/kagabu/sales-dashboard && /usr/bin/node sync.js >> /var/log/sales-sync.log 2>&1
```

## Environment Variables

### MySQL (ERP)

- `DB_HOST`
- `DB_PORT` (default `3306`)
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

### Sync (Optional)

- `SYNC_BATCH_SIZE` (default `2000`)

### App Tables/Columns (MySQL ERP)

- `SALES_ITEM_TABLE=tabSales Invoice Item`
- `SALES_INVOICE_TABLE=tabSales Invoice`
- `ITEM_TABLE=tabItem`
- `AMOUNT_COLUMN=amount`
- `QTY_COLUMN=qty`
- `INVOICE_ID_COLUMN=parent`
- `DATE_COLUMN=posting_date`
- `CUSTOMER_COLUMN=customer`
- `ITEM_COLUMN=item_code`
- `ITEM_TABLE_ID_COLUMN=name`
- `CATEGORY_COLUMN=item_category`
- `WAREHOUSE_COLUMN=warehouse`
- `COST_COLUMN=cost`
- `RATE_COLUMN=rate`
- `ITEM_INDEX_COLUMN=idx`
- `STATUS_COLUMN=docstatus`
- `STATUS_VALUE=1` (default Submitted)
- `DEFAULT_RANGE_DAYS=30` (used when no start/end is provided)
- `MONTHS_CACHE_TTL_MS=300000` (server cache TTL for `/api/months`, default 5 min)

## Profit Calculation

```
profit = amount - (qty * cost)
```

## API Endpoints

- `GET /api/health`
- `GET /api/months?months=4` (preload data for current month + previous months)
- `GET /api/metrics?start=YYYY-MM-DD&end=YYYY-MM-DD&item=...&warehouse=...&category=...&customer=...&docstatus=0|1`
- `GET /api/timeseries?start=YYYY-MM-DD&end=YYYY-MM-DD&granularity=day|week|month&item=...&warehouse=...&category=...&customer=...&docstatus=0|1`
- `GET /api/top-items?start=...&end=...&limit=10&item=...&warehouse=...&category=...&customer=...&docstatus=0|1`
- `GET /api/top-customers?start=...&end=...&limit=10&item=...&warehouse=...&category=...&customer=...&docstatus=0|1`
- `GET /api/top-categories?start=...&end=...&limit=10&item=...&warehouse=...&category=...&customer=...&docstatus=0|1`
- `GET /api/top-warehouses?start=...&end=...&limit=10&item=...&warehouse=...&category=...&customer=...&docstatus=0|1`
- `GET /api/filters?start=...&end=...&docstatus=0|1`
- `GET /api/invoices?start=...&end=...&limit=50&item=...&warehouse=...&category=...&customer=...&docstatus=0|1`
- `GET /api/invoices/:id`

## Important Notes

- The dashboard reads directly from MySQL. The `/api/months` endpoint is cached in-memory and clears on server restart.
- The sync uses `modified` for incremental loads so back-dated records are picked up. Each table uses a stable cursor `(modified, name)` to avoid stalling on ties.

## Troubleshooting

- `Cannot find module 'lru-cache'` → run `npm install`.
- Empty charts → check MySQL credentials and table/column names.
- Wrong profit → confirm `tabItem.cost` is correct.
