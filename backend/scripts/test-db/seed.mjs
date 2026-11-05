#!/usr/bin/env node
/**
 * scripts/test-db/seed.mjs — the E2ETEST company the guarded tools work in.
 * Runs ONLY through the guard (§220): refuses anything but a marked test DB.
 * Idempotent. Run by setup.mjs; safe to re-run.
 *
 *   company   E2ETEST "E2E Test Company"
 *   login     e2e.superadmin@pulse-e2e.test (super_admin, scoped to E2ETEST;
 *             no usable password — tools mint a token, as e2e-mint-token does)
 *   warehouse E2E Main Store (designated main receiving point)
 *   item      E2E-ITEM-1 (NOS) with a vendor price
 *   vendor    E2E Rated Supplier, rated 4/4/4 with one vendor_ratings row —
 *             PO approval refuses a vendor with no rating history
 */
const { default: pool } = await import('../../src/config/db.js');
const { guardOrExit, TEST_COMPANY_CODE } = await import('./guard.mjs');
const { syncPrimaryRole } = await import('../../src/services/userRoles.js');

await guardOrExit(pool, 'test-db/seed');

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const co = (await one(
  `INSERT INTO companies (name, code) VALUES ('E2E Test Company', $1)
   ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [TEST_COMPANY_CODE]).catch(async () =>
  (await one(`SELECT id FROM companies WHERE code = $1`, [TEST_COMPANY_CODE])) ||
  (await one(`INSERT INTO companies (name, code) VALUES ('E2E Test Company', $1) RETURNING id`, [TEST_COMPANY_CODE])))).id;

const EMAIL = 'e2e.superadmin@pulse-e2e.test';
let user = await one(`SELECT id FROM users WHERE LOWER(email) = $1`, [EMAIL]);
if (!user) {
  user = await one(`INSERT INTO users (name, email, password_hash, role, is_active, company_id)
                    VALUES ('E2E Super Admin', $1, 'no-password-mint-a-token', 'super_admin', true, $2) RETURNING id`, [EMAIL, co]);
}
await pool.query(`DELETE FROM user_scope WHERE user_id = $1`, [user.id]);
await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [user.id, co]);
await syncPrimaryRole(user.id, 'super_admin', co);

const wh = (await one(`SELECT id FROM warehouses WHERE company_id = $1 AND name = 'E2E Main Store'`, [co]))
  ?? await one(`INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ('E2E Main Store','E2E Main Store',$1) RETURNING id`, [co]);
const vendor = (await one(`SELECT id FROM vendors WHERE company_id = $1 AND vendor_name = 'E2E Rated Supplier'`, [co]))
  ?? await one(`INSERT INTO vendors (vendor_name, company_id, status, quality_rating, delivery_rating, price_rating)
                VALUES ('E2E Rated Supplier', $1, 'active', 4, 4, 4) RETURNING id`, [co]);
await pool.query(`UPDATE vendors SET quality_rating = 4, delivery_rating = 4, price_rating = 4 WHERE id = $1`, [vendor.id]);
if (!(await one(`SELECT 1 AS x FROM vendor_ratings WHERE vendor_id = $1`, [vendor.id]))) {
  await pool.query(`INSERT INTO vendor_ratings (vendor_id, quality_score, delivery_score, price_score, overall_score)
                    VALUES ($1, 4, 4, 4, 4)`, [vendor.id]);
}
const item = (await one(`SELECT id FROM inventory_items WHERE company_id = $1 AND item_code = 'E2E-ITEM-1'`, [co]))
  ?? await one(`INSERT INTO inventory_items (item_code, item_name, company_id, unit_of_measure, standard_cost)
                VALUES ('E2E-ITEM-1','E2E Test Component',$1,'NOS',50) RETURNING id`, [co]);
await pool.query(`INSERT INTO item_vendor_prices (item_id, vendor_id, unit_price, currency, company_id)
                  SELECT $1, $2, 50, 'INR', $3 WHERE NOT EXISTS (SELECT 1 FROM item_vendor_prices WHERE item_id = $1 AND vendor_id = $2)`,
  [item.id, vendor.id, co]);
await pool.query(`INSERT INTO procurement_settings (company_id, main_receiving_warehouse_id) VALUES ($1, $2)
                  ON CONFLICT (company_id) DO UPDATE SET main_receiving_warehouse_id = EXCLUDED.main_receiving_warehouse_id`, [co, wh.id]);

// A fresh database sends every login to the First-Time Setup wizard
// (system_wizard id 1). The test database is set up by this script, so mark it.
await pool.query(`INSERT INTO system_wizard (id, completed, completed_at) VALUES (1, true, NOW())
                  ON CONFLICT (id) DO UPDATE SET completed = true, completed_at = COALESCE(system_wizard.completed_at, NOW())`);

// ── Reference data the backend suite reads (§221) ───────────────────────────
// A fresh database is built from baseline.sql, whose data file carries only
// companies, roles and role_permissions. Every reference row that the
// pre-baseline migrations, the First-Time Setup wizard (seeds/defaultSeed.js)
// or an admin screen would have written is therefore absent. What follows is
// the minimum the suite needs, each block taken from the PRODUCT's own
// definition (named per block), never from the developer database. The
// dependency matrix — which test reads which row — is in
// MODULE_FEATURE_CONNECTION_MANUAL.md §221 and README.md here.
const REF_CO = 1;            // the tenant the suite treats as "own" (companyOf default)
const REF_FOREIGN_CO = 565;  // the tenant three suites hard-code as "foreign"
const ref = {};

// 1. Chart of accounts — global rows (company_id NULL), replayed from the
//    migrations that seed them; each is ON CONFLICT (code) DO NOTHING. Read by
//    every posting test (sales invoicing 3F-3I, dispatch, warehouse lifecycle,
//    IoT parts/warranty, payroll GL incl. loans 1013 Asset / 4006 Revenue).
{
  const client = await pool.connect();
  const shim = { raw: (sql, b) => client.query(sql, b || []) };
  try {
    await client.query('BEGIN');
    for (const m of ['20260603000001_coa_fix_and_seed', '20260604000007_finance_hardening', '20260613000005_finance_audit_patches']) {
      const mod = await import(`../../src/database/migrations/${m}.js`);
      const log = console.log; console.log = () => {};
      try { await mod.up(shim); } finally { console.log = log; }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  ref.chart_of_accounts = Number((await one(`SELECT COUNT(*) n FROM chart_of_accounts`)).n);
}

// 2. Travel approval workflow (one reporting-manager step, SLA 72h) — the
//    migration that seeds it. approvalsInbox, approvalsSecurity.
{
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await (await import('../../src/database/migrations/20260806000005_travel_approval_workflow_seed.js'))
      .up({ raw: (sql, b) => client.query(sql, b || []) });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

// 3. Install defaults for the own tenant — the lists in seeds/defaultSeed.js
//    (the wizard runs it on completion; this seed marks the wizard completed
//    without running it). Inserted here directly because defaultSeed's
//    `ON CONFLICT (name)` no longer matches the normalised partial unique
//    indexes on the masters.
const DEPARTMENTS = ['Engineering', 'Finance', 'HR', 'Sales & Marketing', 'Operations',
  'Production', 'Procurement', 'Quality', 'IT', 'Management'];
const DESIGNATIONS = ['Managing Director', 'General Manager', 'Senior Manager', 'Manager',
  'Assistant Manager', 'Senior Engineer', 'Engineer', 'Junior Engineer', 'Executive', 'Analyst'];
const TICKET_CATEGORIES = [
  ['Hardware', 'Desktop, laptop, peripherals and device faults'],
  ['Software', 'Application errors, installs and licensing'],
  ['Network', 'Connectivity, VPN, Wi-Fi and bandwidth'],
  ['Access Request', 'Account creation, permissions and password resets'],
  ['Email', 'Mailbox, distribution list and spam issues'],
  ['Printer', 'Printing, scanning and consumables'],
  ['ERP Support', 'Pulse ERP module issues and how-to questions'],
  ['Other', 'Anything not covered by the categories above'],
];
const LEAVE_TYPES = [['Casual Leave', 'CASUAL', 12], ['Sick Leave', 'SICK', 12], ['Earned Leave', 'ANNUAL', 15],
  ['Maternity Leave', 'MAT', 182], ['Paternity Leave', 'PAT', 15], ['Compensatory Off', 'COMPOFF', 0], ['Loss of Pay', 'LOP', 0]];
for (const t of ['master_departments', 'master_designations']) {
  for (const name of t === 'master_departments' ? DEPARTMENTS : DESIGNATIONS) {
    await pool.query(`INSERT INTO ${t} (name, is_active) SELECT $1::text, true
                       WHERE NOT EXISTS (SELECT 1 FROM ${t} WHERE is_active AND LOWER(BTRIM(name)) = LOWER($1))`, [name]);
  }
}
for (const [name, description] of TICKET_CATEGORIES) {
  await pool.query(`INSERT INTO ticket_categories (name, description, is_active) SELECT $1::text, $2::text, true
                     WHERE NOT EXISTS (SELECT 1 FROM ticket_categories WHERE LOWER(BTRIM(name)) = LOWER($1))`, [name, description]);
}
for (const [leave_name, leave_code, quota] of LEAVE_TYPES) {
  await pool.query(`INSERT INTO leave_types (company_id, leave_name, leave_code, annual_quota, is_active)
                    SELECT $1::int, $2::text, $3::text, $4::int, true
                     WHERE NOT EXISTS (SELECT 1 FROM leave_types WHERE company_id = $1 AND deleted_at IS NULL
                                         AND (LOWER(leave_name) = LOWER($2) OR UPPER(leave_code) = UPPER($3)))`,
    [REF_CO, leave_name, leave_code, quota]);
}

// 4. SLA policies for the own tenant — the four rows Settings → Service Desk
//    writes from its defaults (admin/settings-status.routes.js). ticketCategories.
for (const [name, priority, fr, res] of [['Critical', 'critical', 1, 4], ['High', 'high', 4, 24],
  ['Medium', 'medium', 8, 72], ['Low', 'low', 24, 168]]) {
  await pool.query(`INSERT INTO sla_policies (name, priority, first_response_hours, resolution_hours, escalation_hours, business_hours_only, company_id, is_active)
                    SELECT $1::text, $2::text, $3::int, $4::int, 8, true, $5::int, true
                     WHERE NOT EXISTS (SELECT 1 FROM sla_policies WHERE company_id = $5::int AND LOWER(priority) = $2::text)`,
    [name, priority, fr, res, REF_CO]);
}

// 5. Zones — 'North' is in the product's zone vocabulary (servicedesk
//    ZONE_FALLBACK, shared/masterVocabulary.js). Plus ONE retired zone, so
//    "refuses a retired zone id" asserts instead of returning early.
//    employeeAssetScope, masterVocabularies.
await pool.query(`INSERT INTO master_zones (name, is_active) SELECT 'North', true
                   WHERE NOT EXISTS (SELECT 1 FROM master_zones WHERE is_active AND LOWER(BTRIM(name)) = 'north')`);
await pool.query(`INSERT INTO master_zones (name, is_active) SELECT 'E2E Retired Zone', false
                   WHERE NOT EXISTS (SELECT 1 FROM master_zones WHERE name = 'E2E Retired Zone')`);

// 6. A biometric device in the own tenant. Synthetic: TEST-NET-1 address
//    (RFC 5737, never routable), offline, no punches. biometricAuthz.
await pool.query(`INSERT INTO biometric_devices (device_name, device_type, location, ip_address, port, status, company_id, vendor, serial_number)
                  SELECT 'E2E Synthetic Device', 'fingerprint', 'E2E', '192.0.2.10', 4370, 'offline', $1, 'E2E', 'E2E-SYNTH-0001'
                   WHERE NOT EXISTS (SELECT 1 FROM biometric_devices WHERE serial_number = 'E2E-SYNTH-0001')`, [REF_CO]);

// 7. Employees. Synthetic names, no contact, bank, salary or ID data.
//    - own tenant: an employee holding office_id EMP001 (employeeCode.contract
//      asserts the per-company unique index refuses a second EMP001 in company 1);
//    - tenant 565: a foreign tenant with one employee (bgvIntegration,
//      employeeTenantScope, viewEmployeeSurface hard-code FOREIGN = 565).
//      Its id is fixed by those tests, so companies_id_seq is moved past it —
//      otherwise a later default-id insert would collide with it.
await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'E2E Foreign Reference Tenant', 'E2EREF565')
                  ON CONFLICT (id) DO NOTHING`, [REF_FOREIGN_CO]);
await pool.query(`SELECT setval('companies_id_seq', GREATEST((SELECT last_value FROM companies_id_seq), $1))`, [REF_FOREIGN_CO]);
for (const [cid, first] of [[REF_CO, 'Reference'], [REF_FOREIGN_CO, 'Foreign']]) {
  await pool.query(`INSERT INTO employees (company_id, office_id, first_name, last_name, status, joining_date, department, designation)
                    SELECT $1::int, 'EMP001', $2::text, 'E2E Fixture', 'Active', DATE '2026-01-01', 'Engineering', 'Engineer'
                     WHERE NOT EXISTS (SELECT 1 FROM employees WHERE company_id = $1 AND LOWER(office_id) = 'emp001')`, [cid, first]);
}

// 8. Five visitors named 'SEED Visitors 1..5' hosted by employees 1..5. The
//    developer DB carries such rows from an old empty-table seeding probe and
//    biometricAuthz asserts the visitor endpoint leaves them untouched. The
//    rows here are synthetic stand-ins (name and host only, no contact or ID).
for (let i = 1; i <= 5; i++) {
  await pool.query(`INSERT INTO visitors (name, host_employee_id, company_id, purpose)
                    SELECT $1::text, $2::int, $3::int, 'E2E reference row'
                     WHERE NOT EXISTS (SELECT 1 FROM visitors WHERE name = $1::text)
                       AND EXISTS (SELECT 1 FROM employees WHERE id = $2::int AND company_id = $3::int)`,
    [`SEED Visitors ${i}`, i, REF_CO]);
}

// 9. One inventory lot in a SECOND tenant (E2ETEST), quantity zero, so a
//    global-scope read genuinely sees more than one tenant's lots
//    (advancedInventoryInvariants "an EXPLICIT null is still allowed"). Zero
//    quantity: it adds no stock anywhere.
await pool.query(`INSERT INTO inventory_batches (item_id, warehouse_id, batch_number, company_id, quantity_received, quantity_available, rate)
                  SELECT $1::int, $2::int, 'E2E-REF-LOT-0', $3::int, 0, 0, 0
                   WHERE NOT EXISTS (SELECT 1 FROM inventory_batches WHERE batch_number = 'E2E-REF-LOT-0' AND company_id = $3::int)`,
  [item.id, wh.id, co]);

// 10. A second warehouse in E2ETEST, so v_stock_summary's item x warehouse
//     fan-out is real (inventoryKpi "does not build any KPI on
//     v_stock_summary"). Not a receiving point; holds nothing.
if (!(await one(`SELECT 1 AS x FROM warehouses WHERE company_id = $1 AND name = 'E2E Second Store'`, [co]))) {
  await pool.query(`INSERT INTO warehouses (name, warehouse_name, company_id) VALUES ('E2E Second Store','E2E Second Store',$1)`, [co]);
}

// 11. Attendance working day — the setting decided 2026-10-28 (§198): 8 h
//     work + 30 min break = 8.5 h on site, one global row. Without it the
//     code falls back to 8 h + 60 min. biometricWorkflows.
await pool.query(`INSERT INTO attendance_general_settings (company_id, full_day_hours, break_duration)
                  SELECT NULL, 8, 30 WHERE NOT EXISTS (SELECT 1 FROM attendance_general_settings WHERE company_id IS NULL)`);

// 12. Keep employee ids clear of user ids. successionSecurity inserts
//     "lookalike" employees whose id is deliberately EQUAL to a user id; a
//     later sequence-drawn employee id must never land on one. The developer
//     DB happens to keep employees_id_seq ahead of users_id_seq; a fresh DB
//     starts them side by side (measured: 1215 vs 1211 -> employees_pkey
//     collision). Moves the TEST database's sequence forward only.
await pool.query(`SELECT setval('employees_id_seq', GREATEST((SELECT last_value FROM employees_id_seq),
                                                            (SELECT last_value FROM users_id_seq) + 100000))`);

ref.departments = Number((await one(`SELECT COUNT(*) n FROM master_departments WHERE is_active`)).n);
ref.ticket_categories = Number((await one(`SELECT COUNT(*) n FROM ticket_categories WHERE is_active`)).n);

console.log(JSON.stringify({ company_id: co, user_id: user.id, email: EMAIL, warehouse_id: wh.id, vendor_id: vendor.id, item_id: item.id, reference: ref }));
await pool.end();
