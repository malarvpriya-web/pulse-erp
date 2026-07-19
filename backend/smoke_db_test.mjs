/**
 * Pulse ERP — DB write-path smoke test
 * Mints an admin JWT, POSTs one sample record to each core module's create
 * endpoint, records the result, then cleans up every row it created.
 * Nothing permanent is left behind (best-effort DB cleanup by returned id).
 */
import pkg from "pg";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
dotenv.config();

const { Pool } = pkg;
const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "Pulse",
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || "5432"),
});

const BASE = "http://localhost:5000/api/v1";
const TAG = "SMOKE_" + Date.now();
const today = new Date().toISOString().slice(0, 10);
const nextWk = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);

// ── Mint an admin token identical in shape to auth.service.makeToken ──────────
async function mintToken() {
  const { rows } = await pool.query(
    "select id, email, role, employee_id from users where email='superadmin@manifest.in' and is_active=true limit 1"
  );
  if (!rows.length) throw new Error("superadmin@manifest.in not found/active");
  const u = rows[0];
  return jwt.sign(
    { userId: u.id, email: u.email, role: u.role, company_id: 1, branch_id: null, employee_id: u.employee_id ?? null },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
}

// ── Endpoint manifest: {name, path, body, table (for cleanup), idKey} ─────────
const TESTS = [
  { name: "Announcements", path: "/announcements", table: "announcements",
    body: { title: TAG, message: "smoke", from_date: today, to_date: nextWk, target_type: "all" } },
  { name: "Holidays", path: "/holidays", table: "holidays",
    body: { name: TAG, date: "2099-12-31", type: "Optional", description: "smoke" },
    after: async () => pool.query("delete from attendance_records where attendance_date='2099-12-31' and source='holiday_sync'") },
  { name: "Vendors", path: "/vendors", table: "vendors",
    body: { vendor_name: TAG, category: "General", email: "smoke@x.com", phone: "9000000000", status: "active" } },
  { name: "Finance/Parties", path: "/finance/parties", table: "parties",
    body: { party_code: TAG, party_type: "Customer", name: TAG, gstin: null } },
  { name: "CRM/Accounts", path: "/crm/accounts", table: "accounts",
    body: { name: TAG, account_type: "Customer", status: "Active", email: "smoke@x.com" } },
  { name: "CRM/Leads", path: "/crm/leads", table: "leads",
    body: { lead_name: TAG, name: TAG, email: `${TAG}@x.com`, phone: "9000000001", company: TAG, source: "Website", status: "New" } },
  { name: "CRM/Contacts", path: "/crm/contacts", table: "contacts",
    body: { full_name: TAG, first_name: "Smoke", last_name: "Test", email: `${TAG}c@x.com`, phone: "9000000002" } },
  { name: "Projects", path: "/projects/projects", table: "projects",
    body: { project_code: TAG, project_name: TAG, status: "planning", start_date: today, end_date: nextWk, description: "smoke", budget: 1000 } },
  { name: "Tasks", path: "/projects/tasks", table: "tasks",
    body: { task_title: TAG, project_id: 2, status: "todo", priority: "medium", description: "smoke" } },
  { name: "Complaints", path: "/complaints", table: "complaints",
    body: { title: TAG, customer_name: TAG, description: "smoke", priority: "medium" } },
  { name: "Leaves/Apply", path: "/leaves/apply", table: "leave_applications",
    body: { employee_id: 1, leave_type_id: 1, start_date: nextWk, end_date: nextWk, from_date: nextWk, to_date: nextWk, reason: "smoke test leave application", days: 1 } },
  { name: "Inventory/Items", path: "/inventory/items", table: "inventory_items",
    body: { item_name: TAG, item_code: TAG, uom: "NOS", category: "General", hsn_code: "1234", current_stock: 0, reorder_level: 0 } },
  { name: "Inventory/Warehouses", path: "/inventory/warehouses", table: "warehouses",
    body: { warehouse_name: TAG, warehouse_code: TAG.slice(0, 20), warehouse_type: "main", location: "Smoke" } },
  { name: "Sales/Quotations", path: "/sales/quotations", table: "quotations",
    body: { quotation_number: TAG, customer_name: TAG, quotation_date: today, valid_until: nextWk, status: "draft", items: [] } },
  { name: "Sales/Orders", path: "/sales/orders", table: "sales_orders",
    body: { order_number: TAG, customer_name: TAG, order_date: today, status: "draft", items: [] } },
  { name: "Finance/Invoices", path: "/finance/invoices", table: "invoices",
    body: { invoice_number: TAG, invoice_date: today, due_date: nextWk, party_type: "Customer", total_amount: 100, items: [{ description: "smoke", quantity: 1, unit_price: 100, rate: 100, amount: 100 }] } },
  { name: "Master/UOM", path: "/master/uom", table: "master_uom",
    body: { name: TAG, code: TAG.slice(0, 10), description: "smoke" } },
];

const results = [];
const created = []; // {table, id, after}

function extractId(j) {
  if (j == null) return null;
  return j.id ?? j.data?.id ?? j.data?.[0]?.id ?? j.rows?.[0]?.id ?? (Array.isArray(j) ? j[0]?.id : null) ?? null;
}

async function run() {
  const token = await mintToken();
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  for (const t of TESTS) {
    let status = 0, body = null, id = null, err = null;
    try {
      const r = await fetch(BASE + t.path, { method: "POST", headers: H, body: JSON.stringify(t.body) });
      status = r.status;
      const txt = await r.text();
      try { body = JSON.parse(txt); } catch { body = txt; }
      id = extractId(body);
      if ((status === 200 || status === 201) && id != null) created.push({ table: t.table, id, after: t.after });
    } catch (e) { err = e.message; }

    let verdict;
    if (status === 200 || status === 201) verdict = id != null ? "CREATED ✅" : "OK(no-id) ✅";
    else if ([400, 409, 422].includes(status)) verdict = "ALIVE/validated ⚠️";
    else if (status === 401) verdict = "AUTH-FAIL ❌";
    else if (status === 403) verdict = "FORBIDDEN ⛔";
    else if (status === 404) verdict = "ROUTE-404 ❌";
    else if (status >= 500) verdict = "SERVER-ERR ❌";
    else if (err) verdict = "NO-CONNECT ❌";
    else verdict = `HTTP ${status}`;

    let msg = err || (typeof body === "object" ? (body?.error || body?.message || body?.detail || "") : String(body).slice(0, 120));
    if (typeof body === "object" && Array.isArray(body?.errors) && body.errors.length)
      msg = (msg ? msg + " | " : "") + JSON.stringify(body.errors).slice(0, 120);
    results.push({ name: t.name, path: t.path, status, verdict, id, msg: String(msg).slice(0, 140) });
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  let cleaned = 0, cleanFail = [];
  for (const c of created) {
    try {
      if (c.after) await c.after();
      const del = await pool.query(`delete from ${c.table} where id = $1`, [c.id]);
      cleaned += del.rowCount;
    } catch (e) { cleanFail.push(`${c.table}#${c.id}: ${e.message}`); }
  }
  // sweep any stray rows still carrying the run TAG in a name-ish column
  const sweeps = [
    ["announcements", "title"], ["holidays", "name"], ["vendors", "vendor_name"],
    ["parties", "party_code"], ["accounts", "name"], ["leads", "lead_name"],
    ["contacts", "full_name"], ["projects", "project_code"], ["tasks", "task_title"],
    ["complaints", "title"], ["inventory_items", "item_code"], ["warehouses", "code"],
    ["quotations", "quotation_number"], ["sales_orders", "order_number"],
    ["invoices", "invoice_number"], ["master_uom", "code"], ["warehouses", "warehouse_code"],
  ];
  for (const [tbl, col] of sweeps) {
    try { const r = await pool.query(`delete from ${tbl} where ${col} like $1`, [TAG + "%"]); cleaned += r.rowCount; } catch {}
  }

  // ── Report ───────────────────────────────────────────────────────────────
  console.log("\n=================  PULSE DB SMOKE TEST  =================");
  console.log("run tag:", TAG, " base:", BASE, "\n");
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad("MODULE", 22), pad("HTTP", 6), pad("VERDICT", 20), "DETAIL");
  console.log("-".repeat(90));
  for (const r of results)
    console.log(pad(r.name, 22), pad(r.status, 6), pad(r.verdict, 20), r.msg);
  const ok = results.filter(r => r.verdict.startsWith("CREATED") || r.verdict.startsWith("OK")).length;
  const alive = results.filter(r => r.verdict.startsWith("ALIVE")).length;
  const bad = results.filter(r => r.verdict.includes("❌")).length;
  const forb = results.filter(r => r.verdict.startsWith("FORBIDDEN")).length;
  console.log("\nSUMMARY:", `${ok} created/ok · ${alive} alive-validated · ${forb} forbidden · ${bad} broken · ${results.length} total`);
  console.log("CLEANUP:", `${cleaned} rows removed`, cleanFail.length ? `| FAILED: ${cleanFail.join("; ")}` : "| all clean");
  console.log("========================================================\n");
  await pool.end();
}
run().catch(async e => { console.error("FATAL:", e); await pool.end(); process.exit(1); });
