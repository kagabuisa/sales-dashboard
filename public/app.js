const currency = new Intl.NumberFormat("en-UG", {
  style: "currency",
  currency: "UGX",
  maximumFractionDigits: 0,
});

const $ = (id) => document.getElementById(id);

const state = {
  chart: null,
  calendar: {
    year: null,
    month: null,
    selectedDate: null,
    years: [],
    rangeStart: null,
    rangeEnd: null,
  },
  invoices: [],
  preload: {
    ready: false,
    range: null,
    defaultDocstatus: "1",
    invoices: [],
    items: [],
    products: [],
    invoiceById: {},
    itemsByInvoice: {},
    productByName: {},
  },
};

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDateYMD(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatMonthLabel(date) {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const year = String(date.getFullYear()).slice(-2);
  return `${monthNames[date.getMonth()]}-${year}`;
}

function monthRange(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return { start: formatDateYMD(start), end: formatDateYMD(end) };
}

function normalizeDateYMD(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return formatDateYMD(date);
}

function formatDateShort(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function getParams() {
  const start = $("start").value;
  const end = $("end").value;
  const granularity = $("granularity").value;
  const item = $("itemFilter").value;
  const warehouse = $("warehouseFilter").value;
  const category = $("categoryFilter").value;
  const customer = $("customerFilter").value;
  const docstatus = $("statusFilter").value;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  if (granularity) params.set("granularity", granularity);
  if (item) params.set("item", item);
  if (warehouse) params.set("warehouse", warehouse);
  if (category) params.set("category", category);
  if (customer) params.set("customer", customer);
  if (docstatus !== "") params.set("docstatus", docstatus);
  return params.toString();
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Request failed");
  }
  return res.json();
}

function renderList(target, rows, labelKey) {
  const container = $(target);
  container.className = "list";
  container.innerHTML = "";
  rows.forEach((row, index) => {
    const margin = row.revenue ? row.profit / row.revenue : 0;
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = `
      <div>
        <div>${row[labelKey] || "Unknown"}</div>
        <div class="badge">#${index + 1}</div>
      </div>
      <div>
        <div>${currency.format(row.revenue)}</div>
        <div class="hint">Qty ${row.qty}</div>
        <div class="hint">Profit ${currency.format(row.profit)} · ${formatPercent(margin)}</div>
      </div>
    `;
    container.appendChild(div);
  });
}

function renderInvoiceList(rows) {
  const container = $("invoiceList");
  container.className = "list";
  container.innerHTML = "";
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "No invoices for the selected filters.";
    container.appendChild(empty);
    return;
  }
  rows.forEach((row) => {
    const div = document.createElement("div");
    div.className = "list-item clickable";
    div.innerHTML = `
      <div>
        <div>${row.invoiceNo}</div>
        <div class="hint">${row.postingDate} · ${row.customer || "Unknown"}</div>
      </div>
      <div>
        <div>${currency.format(row.revenue)}</div>
        <div class="hint">Qty ${row.qty}</div>
      </div>
    `;
    div.addEventListener("click", () => {
      openInvoice(row.invoiceNo).catch((err) => alert(err.message));
    });
    container.appendChild(div);
  });
}

function applyInvoiceSearch() {
  const term = $("invoiceSearch").value.trim().toLowerCase();
  if (!term) {
    renderInvoiceList(state.invoices);
    return;
  }
  const filtered = state.invoices.filter((row) => {
    const invoice = String(row.invoiceNo || "").toLowerCase();
    const customer = String(row.customer || "").toLowerCase();
    return invoice.includes(term) || customer.includes(term);
  });
  renderInvoiceList(filtered);
}

function renderInvoiceItems(rows) {
  const container = $("invoiceItems");
  container.className = "table";
  container.innerHTML = "";

  const warehouses = Array.from(new Set(rows.map((row) => row.warehouse).filter((value) => value)));
  const warehouseLabel =
    warehouses.length === 0 ? "N/A" : warehouses.length === 1 ? warehouses[0] : "Multiple";

  const head = document.createElement("div");
  head.className = "table-row head";
  head.innerHTML = `
    <div>Item</div>
    <div>Qty</div>
    <div>Rate</div>
    <div>Amount</div>
  `;
  container.appendChild(head);

  rows.forEach((row) => {
    const div = document.createElement("div");
    div.className = "table-row";
    div.innerHTML = `
      <div>${row.item}</div>
      <div>${row.qty}</div>
      <div>${currency.format(row.rate)}</div>
      <div>${currency.format(row.amount)}</div>
    `;
    container.appendChild(div);
  });

  return { warehouseLabel };
}

async function openInvoice(invoiceNo) {
  if (state.preload.ready && state.preload.invoiceById[invoiceNo]) {
    const invoice = state.preload.invoiceById[invoiceNo];
    const items = state.preload.itemsByInvoice[invoiceNo] || [];
    const rows = items.map((item) => ({
      invoiceNo,
      postingDate: invoice.postingDateYMD,
      customer: invoice.customer,
      grandTotal: Number(invoice.grand_total || 0),
      outstandingAmount: Number(invoice.outstanding_amount || 0),
      warehouse: item.warehouse,
      item: item.item_code,
      qty: Number(item.qty || 0),
      rate: Number(item.rate || 0),
      amount: Number(item.amount || 0),
    }));
    if (!rows.length) {
      $("drawerInvoiceNo").textContent = "No items";
      $("drawerTitle").textContent = "—";
      $("drawerSubtitle").textContent = "";
      $("invoiceItems").innerHTML = "";
      return;
    }
    const first = rows[0];
    const { warehouseLabel } = renderInvoiceItems(rows);
    $("drawerInvoiceNo").textContent = first.invoiceNo || "Invoice";
    $("drawerTitle").textContent = first.customer || "Unknown Customer";
    $("drawerSubtitle").innerHTML = `
      <span class="meta-chip">Date ${formatDateShort(first.postingDate)}</span>
      <span class="meta-chip">Warehouse ${warehouseLabel}</span>
      <span class="meta-group">
        <span class="meta-chip strong">Total ${currency.format(first.grandTotal)}</span>
        <span class="meta-chip danger strong">Outstanding ${currency.format(first.outstandingAmount)}</span>
      </span>
    `;
    return;
  }

  const rows = await fetchJson(`/api/invoices/${encodeURIComponent(invoiceNo)}`);
  if (!rows.length) {
    $("drawerInvoiceNo").textContent = "No items";
    $("drawerTitle").textContent = "—";
    $("drawerSubtitle").textContent = "";
    $("invoiceItems").innerHTML = "";
    return;
  }
  const first = rows[0];
  const { warehouseLabel } = renderInvoiceItems(rows);
  $("drawerInvoiceNo").textContent = first.invoiceNo || "Invoice";
  $("drawerTitle").textContent = first.customer || "Unknown Customer";
  $("drawerSubtitle").innerHTML = `
    <span class="meta-chip">Date ${formatDateShort(first.postingDate)}</span>
    <span class="meta-chip">Warehouse ${warehouseLabel}</span>
    <span class="meta-group">
      <span class="meta-chip strong">Total ${currency.format(first.grandTotal)}</span>
      <span class="meta-chip danger strong">Outstanding ${currency.format(first.outstandingAmount)}</span>
    </span>
  `;
}

function populateSelect(id, values) {
  const select = $(id);
  const current = select.value;
  select.innerHTML = "";
  const optionAll = document.createElement("option");
  optionAll.value = "";
  optionAll.textContent = "All";
  select.appendChild(optionAll);

  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });

  if (current && values.includes(current)) {
    select.value = current;
  }
}

function resolveDocstatus(filters) {
  if (filters?.docstatus !== null && filters?.docstatus !== undefined && filters?.docstatus !== "") {
    return String(filters.docstatus);
  }
  return state.preload.defaultDocstatus || "1";
}

function withinRange(dateValue, start, end) {
  if (!dateValue) return false;
  const value = normalizeDateYMD(dateValue);
  if (start && value < start) return false;
  if (end && value > end) return false;
  return true;
}

function canUsePreload(start, end) {
  if (!state.preload.ready || !state.preload.range) return false;
  if (!start || !end) return false;
  return start >= state.preload.range.start && end <= state.preload.range.end;
}

function computeBucket(dateValue, granularity) {
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return String(dateValue || "");
  if (granularity === "month") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
  }
  if (granularity === "week") {
    const day = date.getDay();
    const diff = (day + 6) % 7;
    const monday = new Date(date);
    monday.setDate(date.getDate() - diff);
    return formatDateYMD(monday);
  }
  return formatDateYMD(date);
}

function buildLocalFilters(range, docstatus) {
  const invoiceIds = new Set();
  const itemsSet = new Set();
  const warehouseSet = new Set();
  const categorySet = new Set();
  const customerSet = new Set();
  const yearsSet = new Set();

  state.preload.invoices.forEach((inv) => {
    if (!withinRange(inv.postingDateYMD, range.start, range.end)) return;
    if (docstatus && String(inv.docstatus) !== String(docstatus)) return;
    invoiceIds.add(inv.name);
    if (inv.customer) customerSet.add(inv.customer);
    const date = new Date(inv.posting_date);
    if (!Number.isNaN(date.getTime())) yearsSet.add(date.getFullYear());
  });

  state.preload.items.forEach((item) => {
    if (!invoiceIds.has(item.parent)) return;
    if (item.item_code) itemsSet.add(item.item_code);
    if (item.warehouse) warehouseSet.add(item.warehouse);
    const product = state.preload.productByName[item.item_code];
    if (product?.item_category) categorySet.add(product.item_category);
  });

  return {
    items: Array.from(itemsSet).sort(),
    warehouses: Array.from(warehouseSet).sort(),
    categories: Array.from(categorySet).sort(),
    customers: Array.from(customerSet).sort(),
    years: Array.from(yearsSet).sort(),
  };
}

function applyDashboard(metrics, series, topItems, topCustomers, topCategories, topWarehouses, invoices) {
  $("totalRevenue").textContent = currency.format(metrics.totalRevenue);
  $("totalQty").textContent = metrics.totalQty.toLocaleString();
  $("totalInvoices").textContent = metrics.totalInvoices.toLocaleString();
  $("avgOrderValue").textContent = currency.format(metrics.avgOrderValue);
  $("totalProfit").textContent = currency.format(metrics.totalProfit);
  $("profitMargin").textContent = formatPercent(metrics.profitMargin);
  $("avgOrderProfit").textContent = currency.format(metrics.avgOrderProfit);

  renderList("topItems", topItems, "item");
  renderList("topCustomers", topCustomers, "customer");
  renderList("topCategories", topCategories, "category");
  renderList("topWarehouses", topWarehouses, "warehouse");
  state.invoices = invoices;
  applyInvoiceSearch();

  const labels = series.map((s) => s.bucket);
  const revenueData = series.map((s) => s.revenue);
  const qtyData = series.map((s) => s.qty);
  const profitData = series.map((s) => s.profit);

  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = revenueData;
    state.chart.data.datasets[1].data = qtyData;
    state.chart.data.datasets[2].data = profitData;
    state.chart.update();
    return;
  }

  const ctx = $("salesChart").getContext("2d");
  state.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Revenue",
          data: revenueData,
          borderColor: "#d7263d",
          backgroundColor: "rgba(215, 38, 61, 0.6)",
        },
        {
          label: "Qty",
          data: qtyData,
          borderColor: "#1b5f8c",
          backgroundColor: "rgba(27, 95, 140, 0.6)",
        },
        {
          label: "Profit",
          data: profitData,
          borderColor: "#2e7d32",
          backgroundColor: "rgba(46, 125, 50, 0.6)",
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: "top",
        },
      },
      scales: {
        y: {
          ticks: {
            callback: (value) => value,
          },
        },
      },
    },
  });
}

function loadFiltersLocal(range, docstatus) {
  const filters = buildLocalFilters(range, docstatus);
  populateSelect("itemFilter", filters.items);
  populateSelect("warehouseFilter", filters.warehouses);
  populateSelect("categoryFilter", filters.categories);
  populateSelect("customerFilter", filters.customers);
  state.calendar.years = Array.isArray(filters.years) ? filters.years : [];
}

function loadDashboardLocal(range, filters, granularity) {
  const local = computeLocalDashboard(range, filters, granularity);
  applyDashboard(
    local.metrics,
    local.series,
    local.topItems,
    local.topCustomers,
    local.topCategories,
    local.topWarehouses,
    local.invoices
  );
}

function computeLocalDashboard(range, filters, granularity) {
  const docstatus = resolveDocstatus(filters);
  const invoiceTotals = new Map();
  const invoiceProfit = new Map();
  const invoiceQty = new Map();
  const bucketMap = new Map();
  const itemMap = new Map();
  const customerMap = new Map();
  const categoryMap = new Map();
  const warehouseMap = new Map();

  let totalRevenue = 0;
  let totalQty = 0;
  let totalProfit = 0;

  state.preload.items.forEach((item) => {
    const invoice = state.preload.invoiceById[item.parent];
    if (!invoice) return;
    if (!withinRange(invoice.postingDateYMD, range.start, range.end)) return;
    if (docstatus && String(invoice.docstatus) !== String(docstatus)) return;
    if (filters.customer && invoice.customer !== filters.customer) return;
    if (filters.item && item.item_code !== filters.item) return;
    if (filters.warehouse && item.warehouse !== filters.warehouse) return;

    const product = state.preload.productByName[item.item_code] || {};
    const category = product.item_category || "Uncategorized";
    if (filters.category && category !== filters.category) return;

    const amount = Number(item.amount || 0);
    const qty = Number(item.qty || 0);
    const cost = Number(product.cost || 0);
    const profit = amount - qty * cost;

    totalRevenue += amount;
    totalQty += qty;
    totalProfit += profit;

    invoiceTotals.set(item.parent, (invoiceTotals.get(item.parent) || 0) + amount);
    invoiceProfit.set(item.parent, (invoiceProfit.get(item.parent) || 0) + profit);
    invoiceQty.set(item.parent, (invoiceQty.get(item.parent) || 0) + qty);

    const bucket = computeBucket(invoice.posting_date, granularity);
    const bucketEntry = bucketMap.get(bucket) || { revenue: 0, qty: 0, profit: 0 };
    bucketEntry.revenue += amount;
    bucketEntry.qty += qty;
    bucketEntry.profit += profit;
    bucketMap.set(bucket, bucketEntry);

    const itemKey = item.item_code || "Unknown";
    const itemEntry = itemMap.get(itemKey) || { item: itemKey, revenue: 0, qty: 0, profit: 0 };
    itemEntry.revenue += amount;
    itemEntry.qty += qty;
    itemEntry.profit += profit;
    itemMap.set(itemKey, itemEntry);

    const customerKey = invoice.customer || "Unknown";
    const customerEntry = customerMap.get(customerKey) || {
      customer: customerKey,
      revenue: 0,
      qty: 0,
      profit: 0,
    };
    customerEntry.revenue += amount;
    customerEntry.qty += qty;
    customerEntry.profit += profit;
    customerMap.set(customerKey, customerEntry);

    const categoryKey = category || "Uncategorized";
    const categoryEntry = categoryMap.get(categoryKey) || {
      category: categoryKey,
      revenue: 0,
      qty: 0,
      profit: 0,
    };
    categoryEntry.revenue += amount;
    categoryEntry.qty += qty;
    categoryEntry.profit += profit;
    categoryMap.set(categoryKey, categoryEntry);

    const warehouseKey = item.warehouse || "Unassigned";
    const warehouseEntry = warehouseMap.get(warehouseKey) || {
      warehouse: warehouseKey,
      revenue: 0,
      qty: 0,
      profit: 0,
    };
    warehouseEntry.revenue += amount;
    warehouseEntry.qty += qty;
    warehouseEntry.profit += profit;
    warehouseMap.set(warehouseKey, warehouseEntry);
  });

  const invoiceCount = invoiceTotals.size;
  let avgOrderValue = 0;
  let avgOrderProfit = 0;
  if (invoiceCount > 0) {
    let totalInvoiceRevenue = 0;
    let totalInvoiceProfit = 0;
    invoiceTotals.forEach((value) => {
      totalInvoiceRevenue += value;
    });
    invoiceProfit.forEach((value) => {
      totalInvoiceProfit += value;
    });
    avgOrderValue = totalInvoiceRevenue / invoiceCount;
    avgOrderProfit = totalInvoiceProfit / invoiceCount;
  }

  const series = Array.from(bucketMap.entries())
    .map(([bucket, values]) => ({ bucket, ...values }))
    .sort((a, b) => (a.bucket > b.bucket ? 1 : -1));

  const topItems = Array.from(itemMap.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  const topCustomers = Array.from(customerMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);
  const topCategories = Array.from(categoryMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);
  const topWarehouses = Array.from(warehouseMap.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const invoices = Array.from(invoiceTotals.entries())
    .map(([invoiceId, revenue]) => {
      const invoice = state.preload.invoiceById[invoiceId] || {};
      return {
        invoiceNo: invoiceId,
        postingDate: invoice.postingDateYMD || invoice.posting_date || "",
        customer: invoice.customer || "",
        revenue: Number(revenue || 0),
        qty: Number(invoiceQty.get(invoiceId) || 0),
      };
    })
    .sort((a, b) => (a.postingDate < b.postingDate ? 1 : -1))
    .slice(0, 50);

  return {
    metrics: {
      totalRevenue,
      totalQty,
      totalInvoices: invoiceCount,
      avgOrderValue,
      totalProfit,
      profitMargin: totalRevenue ? totalProfit / totalRevenue : 0,
      avgOrderProfit,
    },
    series,
    topItems,
    topCustomers,
    topCategories,
    topWarehouses,
    invoices,
  };
}

async function loadFilters() {
  const start = $("start").value;
  const end = $("end").value;
  const docstatus = $("statusFilter").value;

  if (canUsePreload(start, end)) {
    loadFiltersLocal({ start, end }, resolveDocstatus({ docstatus }));
    return;
  }

  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  if (docstatus !== "") params.set("docstatus", docstatus);

  const data = await fetchJson(`/api/filters?${params.toString()}`);
  populateSelect("itemFilter", data.items);
  populateSelect("warehouseFilter", data.warehouses);
  populateSelect("categoryFilter", data.categories);
  populateSelect("customerFilter", data.customers);
  state.calendar.years = Array.isArray(data.years) ? data.years : [];
}

function buildMonthDays(year, month) {
  const result = [];
  if (year === null || month === null) return result;
  const date = new Date(year, month, 1);
  while (date.getMonth() === month) {
    result.push(new Date(date));
    date.setDate(date.getDate() + 1);
  }
  return result;
}

function populateCalendarSelects() {
  const yearSelect = $("yearSelect");
  const monthSelect = $("monthSelect");
  const startValue = $("start").value;
  const endValue = $("end").value;
  const start = startValue ? new Date(startValue) : new Date();
  const end = endValue ? new Date(endValue) : new Date(start.getFullYear(), start.getMonth(), 1);

  yearSelect.innerHTML = "";
  const years =
    state.calendar.years.length > 0
      ? state.calendar.years
      : Array.from({ length: Math.max(1, end.getFullYear() - start.getFullYear() + 1) }, (_, i) =>
          start.getFullYear() + i
        );
  years.forEach((year) => {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    yearSelect.appendChild(option);
  });

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  monthSelect.innerHTML = "";
  monthNames.forEach((name, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = name;
    monthSelect.appendChild(option);
  });

  if (state.calendar.year !== null) {
    yearSelect.value = String(state.calendar.year);
  }
  if (state.calendar.month !== null) {
    monthSelect.value = String(state.calendar.month);
  }
}

function renderDateList() {
  const list = $("dateList");
  const dates = buildMonthDays(state.calendar.year, state.calendar.month);
  const selected = state.calendar.selectedDate;
  list.innerHTML = "";
  dates.forEach((date) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate()
    ).padStart(2, "0")}`;
    btn.className = `date-chip${selected === value ? " active" : ""}`;
    btn.textContent = String(date.getDate());
    btn.addEventListener("click", () => {
      if ($("start").value !== $("end").value) {
        state.calendar.rangeStart = $("start").value;
        state.calendar.rangeEnd = $("end").value;
      }
      state.calendar.selectedDate = value;
      state.calendar.year = date.getFullYear();
      state.calendar.month = date.getMonth();
      $("start").value = value;
      $("end").value = value;
      loadFilters()
        .then(() => loadDashboard())
        .catch((err) => alert(err.message));
      populateCalendarSelects();
      renderDateList();
    });
    list.appendChild(btn);
  });
}

async function loadDashboard() {
  const range = { start: $("start").value, end: $("end").value };
  const granularity = $("granularity").value || "day";
  const filters = {
    item: $("itemFilter").value || null,
    warehouse: $("warehouseFilter").value || null,
    category: $("categoryFilter").value || null,
    customer: $("customerFilter").value || null,
    docstatus: $("statusFilter").value || null,
  };

  if (canUsePreload(range.start, range.end)) {
    loadDashboardLocal(range, filters, granularity);
    return;
  }

  const params = getParams();
  const metrics = await fetchJson(`/api/metrics?${params}`);
  const series = await fetchJson(`/api/timeseries?${params}`);
  const topItems = await fetchJson(`/api/top-items?${params}`);
  const topCustomers = await fetchJson(`/api/top-customers?${params}`);
  const topCategories = await fetchJson(`/api/top-categories?${params}`);
  const topWarehouses = await fetchJson(`/api/top-warehouses?${params}`);
  const invoices = await fetchJson(`/api/invoices?${params}`);

  applyDashboard(metrics, series, topItems, topCustomers, topCategories, topWarehouses, invoices);
}

async function loadPreload() {
  try {
    const data = await fetchJson("/api/months?months=4");
    const invoiceById = {};
    const itemsByInvoice = {};
    const productByName = {};

    const invoices = (data.invoices || []).map((inv) => ({
      ...inv,
      postingDateYMD: normalizeDateYMD(inv.posting_date),
    }));

    invoices.forEach((inv) => {
      invoiceById[inv.name] = inv;
    });

    (data.items || []).forEach((item) => {
      if (!itemsByInvoice[item.parent]) {
        itemsByInvoice[item.parent] = [];
      }
      itemsByInvoice[item.parent].push(item);
    });

    (data.products || []).forEach((product) => {
      productByName[product.name] = product;
    });

    state.preload.ready = true;
    state.preload.range = data.range || null;
    state.preload.defaultDocstatus = String(data.defaultDocstatus || "1");
    state.preload.invoices = invoices;
    state.preload.items = data.items || [];
    state.preload.products = data.products || [];
    state.preload.invoiceById = invoiceById;
    state.preload.itemsByInvoice = itemsByInvoice;
    state.preload.productByName = productByName;
  } catch (err) {
    state.preload.ready = false;
  }
}

function initDefaults() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  $("start").value = formatDateYMD(start);
  $("end").value = formatDateYMD(today);
  state.calendar.year = start.getFullYear();
  state.calendar.month = start.getMonth();
  state.calendar.selectedDate = null;
  state.calendar.rangeStart = $("start").value;
  state.calendar.rangeEnd = $("end").value;
}

function setActiveMonthButton(activeIndex) {
  ["monthBtn0", "monthBtn1", "monthBtn2", "monthBtn3"].forEach((id, index) => {
    const btn = $(id);
    if (!btn) return;
    if (index === activeIndex) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

function updateMonthButtons() {
  const now = new Date();
  const months = [0, 1, 2, 3].map((offset) => {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const range = monthRange(date);
    if (offset === 0) {
      range.end = formatDateYMD(now);
    }
    return { date, range };
  });

  months.forEach((entry, index) => {
    const btn = $(`monthBtn${index}`);
    if (!btn) return;
    btn.textContent = formatMonthLabel(entry.date);
    btn.dataset.start = entry.range.start;
    btn.dataset.end = entry.range.end;
  });

  const start = $("start").value;
  const end = $("end").value;
  const matchIndex = months.findIndex(
    (entry) => entry.range.start === start && entry.range.end === end
  );
  setActiveMonthButton(matchIndex >= 0 ? matchIndex : null);
}

function applyMonthButton(index) {
  const btn = $(`monthBtn${index}`);
  if (!btn) return;
  const start = btn.dataset.start;
  const end = btn.dataset.end;
  if (!start || !end) return;
  $("start").value = start;
  $("end").value = end;
  const startDate = new Date(start);
  if (!Number.isNaN(startDate.getTime())) {
    state.calendar.year = startDate.getFullYear();
    state.calendar.month = startDate.getMonth();
  }
  state.calendar.selectedDate = null;
  state.calendar.rangeStart = start;
  state.calendar.rangeEnd = end;
  setActiveMonthButton(index);
  const range = { start, end };
  if (canUsePreload(start, end)) {
    const docstatus = $("statusFilter").value;
    loadFiltersLocal(range, resolveDocstatus({ docstatus }));
    const filters = {
      item: $("itemFilter").value || null,
      warehouse: $("warehouseFilter").value || null,
      category: $("categoryFilter").value || null,
      customer: $("customerFilter").value || null,
      docstatus: $("statusFilter").value || null,
    };
    loadDashboardLocal(range, filters, $("granularity").value || "day");
  } else {
    loadFilters()
      .then(() => loadDashboard())
      .catch((err) => alert(err.message));
  }
  populateCalendarSelects();
  renderDateList();
}

$("refresh").addEventListener("click", () => {
  const range = { start: $("start").value, end: $("end").value };
  if (canUsePreload(range.start, range.end)) {
    const filters = {
      item: $("itemFilter").value || null,
      warehouse: $("warehouseFilter").value || null,
      category: $("categoryFilter").value || null,
      customer: $("customerFilter").value || null,
      docstatus: $("statusFilter").value || null,
    };
    loadDashboardLocal(range, filters, $("granularity").value || "day");
    return;
  }
  loadDashboard().catch((err) => alert(err.message));
});

initDefaults();
updateMonthButtons();
loadPreload()
  .then(() => loadFilters())
  .then(() => {
    populateCalendarSelects();
    renderDateList();
    return loadDashboard();
  })
  .catch((err) => alert(err.message));

["start", "end"].forEach((id) => {
  $(id).addEventListener("change", () => {
    const startValue = $("start").value;
    if (startValue) {
      const date = new Date(startValue);
      if (!Number.isNaN(date.getTime())) {
        state.calendar.year = date.getFullYear();
        state.calendar.month = date.getMonth();
        state.calendar.selectedDate = $("start").value === $("end").value ? $("start").value : null;
      }
    }
    if ($("start").value !== $("end").value) {
      state.calendar.rangeStart = $("start").value;
      state.calendar.rangeEnd = $("end").value;
    }
    loadFilters()
      .then(() => loadDashboard())
      .catch((err) => alert(err.message));
    populateCalendarSelects();
    renderDateList();
    updateMonthButtons();
  });
});

["granularity", "itemFilter", "warehouseFilter", "categoryFilter", "customerFilter", "statusFilter"].forEach(
  (id) => {
    $(id).addEventListener("change", () => {
      loadDashboard().catch((err) => alert(err.message));
    });
  }
);

$("invoiceSearch").addEventListener("input", () => {
  applyInvoiceSearch();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((btn) => btn.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.getAttribute("data-tab");
    const panel = document.querySelector(`[data-panel=\"${target}\"]`);
    if (panel) {
      panel.classList.add("active");
    }
  });
});

["yearSelect", "monthSelect"].forEach((id) => {
  $(id).addEventListener("change", () => {
    state.calendar.year = Number($("yearSelect").value);
    state.calendar.month = Number($("monthSelect").value);
    renderDateList();
  });
});

$("clearDateFilter").addEventListener("click", () => {
  const start = state.calendar.rangeStart || $("start").value;
  const end = state.calendar.rangeEnd || $("end").value;
  $("start").value = start;
  $("end").value = end;
  state.calendar.selectedDate = null;
  const date = new Date(start);
  if (!Number.isNaN(date.getTime())) {
    state.calendar.year = date.getFullYear();
    state.calendar.month = date.getMonth();
  }
  loadFilters()
    .then(() => loadDashboard())
    .catch((err) => alert(err.message));
  populateCalendarSelects();
  renderDateList();
  updateMonthButtons();
});

["monthBtn0", "monthBtn1", "monthBtn2", "monthBtn3"].forEach((id, index) => {
  const btn = $(id);
  if (btn) {
    btn.addEventListener("click", () => applyMonthButton(index));
  }
});
