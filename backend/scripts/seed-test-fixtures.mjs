#!/usr/bin/env node
/**
 * seed-test-fixtures.mjs — Create the four fixture users the backend test
 * suite's token helper assumes (src/__tests__/helpers/tokens.js mints JWTs
 * for userId 1–4 with roles admin/hr/manager/employee; authorization is
 * DB-authoritative, so those rows must exist for real-DB tests to pass).
 *
 * CI runs this between `npm run migrate` and `npm test`. It is idempotent
 * (ON CONFLICT DO NOTHING) and safe on a dev DB, but it is a TEST fixture —
 * never run it against production. It refuses when NODE_ENV=production.
 *
 * Passwords are random per run: no test logs in with a password against the
 * real DB (login tests mock the pool), so no known value is needed.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool   from '../src/config/db.js';

if (process.env.NODE_ENV === 'production') {
  console.error('❌  seed-test-fixtures is a test fixture — refusing to run in production.');
  process.exit(1);
}

const FIXTURES = [
  { id: 1, name: 'Test Admin',    email: 'admin@test.com',    role: 'admin'    },
  { id: 2, name: 'Test HR',       email: 'hr@test.com',       role: 'hr'       },
  { id: 3, name: 'Test Manager',  email: 'manager@test.com',  role: 'manager'  },
  { id: 4, name: 'Test Employee', email: 'employee@test.com', role: 'employee' },
  // The procurement and sales suites refuse to run against a database where
  // nobody holds these roles — a 403 would then be indistinguishable from a
  // working gate, and the authorization assertions would pass vacuously.
  { id: 5, name: 'Test Procurement Manager', email: 'proc.manager@test.com', role: 'procurement_manager' },
  { id: 6, name: 'Test Procurement Exec',    email: 'proc.exec@test.com',    role: 'procurement_exec'    },
  { id: 7, name: 'Test Sales Exec',          email: 'sales.exec@test.com',   role: 'sales_exec'          },
];

const client = await pool.connect();
try {
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString('base64'), 10);

  await client.query('BEGIN');
  for (const f of FIXTURES) {
    await client.query(
      `INSERT INTO users (id, name, email, password_hash, role, is_active, company_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true, 1, false)
       ON CONFLICT (id) DO NOTHING`,
      [f.id, f.name, f.email, hash, f.role]
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role_id, company_id, is_primary)
       SELECT $1, r.id, 1, true FROM roles r WHERE r.code = $2
       ON CONFLICT DO NOTHING`,
      [f.id, f.role]
    );
    // Company scope: scope-guarded routes treat a user without a user_scope
    // row as global; the tenancy integration tests require company_id = 1.
    await client.query(
      `INSERT INTO user_scope (user_id, company_id, is_primary)
       SELECT $1, 1, true
        WHERE NOT EXISTS (SELECT 1 FROM user_scope WHERE user_id = $1 AND company_id = 1)`,
      [f.id]
    );
  }
  // Keep the sequence ahead of the explicit ids so later INSERTs don't collide
  await client.query(`SELECT setval('users_id_seq', GREATEST((SELECT MAX(id) FROM users), 100))`);

  // ── Reference data ────────────────────────────────────────────────────────
  //
  // The migrations create companies, roles and the permission matrix, and
  // nothing else. The real-DB integration suites need a populated company to
  // say anything: several refuse outright — "No active account holds …", "No
  // active company-1 component with a master GST rate", "Receipt … has no
  // warehouse" — because a suite that passes on an empty database is worse
  // than no suite. This is the smallest set that lets them run for real.
  //
  // Every row is company 1, matching the fixture users' scope. Employee
  // addresses are deliberately @staff.test, NOT the @test.com the accounts
  // use: one suite needs an active account that resolves to NO employee, and
  // it matches the two on users.email = employees.company_email.

  // employees.status is Capitalized. A lowercase 'active' matches nothing —
  // one forecast query was written that way and returned an empty set.
  // The status spread is deliberate, not decoration. EMPLOYEE_ACTIVE covers
  // active | probation | notice | confirmed, and a guard test proves the
  // vocabulary checker notices when 'notice' is dropped from that set — it can
  // only notice if somebody actually holds the value. A population that is
  // uniformly 'Active' makes that guard pass vacuously.
  const STAFF = [
    ['Asha',   'Rao',     'Engineering', 'Design Engineer',        'Active'],
    ['Vikram', 'Shah',    'Procurement', 'Buyer',                  'Active'],
    ['Leena',  'Menon',   'Finance',     'Accounts Executive',     'Confirmed'],
    ['Rahul',  'Iyer',    'Sales',       'Territory Manager',      'Notice'],
    ['Priya',  'Nair',    'Operations',  'Production Supervisor', 'Probation'],
    ['Imran',  'Sheikh',  'Quality',     'QA Inspector',           'Active'],
  ];
  for (const [first, last, dept, designation, status] of STAFF) {
    const email = `${first}.${last}@staff.test`.toLowerCase();
    await client.query(
      `INSERT INTO employees (first_name, last_name, company_email, department,
                              designation, status, company_id)
       SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, 1
        WHERE NOT EXISTS (SELECT 1 FROM employees WHERE company_email = $3)`,
      [first, last, email, dept, designation, status]);
  }

  // A warehouse: without one, an accepted receipt has nowhere to release its
  // stock to and the lifecycle suite stops at "has no warehouse".
  await client.query(
    `INSERT INTO warehouses (name, warehouse_name, warehouse_code, company_id)
     SELECT 'Test Main Store', 'Test Main Store', 'TST-WH', 1
      WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE warehouse_code = 'TST-WH')`);

  // Two vendors, because one suite compares a pair; the first carries a rating
  // so PO approval's minimum-rating gate is not what stops a conversion test.
  for (const [code, name] of [['TSTV-1', 'Test Components Pvt Ltd'], ['TSTV-2', 'Test Fabrication Co']]) {
    await client.query(
      `INSERT INTO vendors (vendor_name, vendor_code, company_id, status)
       SELECT $2::text, $1::text, 1, 'active'
        WHERE NOT EXISTS (SELECT 1 FROM vendors WHERE vendor_code = $1)`,
      [code, name]);
  }
  await client.query(
    `INSERT INTO vendor_ratings (company_id, vendor_id, quality_score, delivery_score,
                                 price_score, overall_score, comments)
     SELECT 1, v.id, 4, 4, 4, 4, 'Seeded baseline rating'
       FROM vendors v
      WHERE v.vendor_code = 'TSTV-1'
        AND NOT EXISTS (SELECT 1 FROM vendor_ratings r WHERE r.vendor_id = v.id)`);

  // An HSN code carrying a real GST rate, and components that inherit it. The
  // tax carry-over test needs default_gst_rate > 0 to have anything to carry.
  await client.query(
    `INSERT INTO master_hsn_sac (code, description, gst_rate, is_active)
     SELECT '8538', 'Parts for electrical apparatus', 18, true
      WHERE NOT EXISTS (SELECT 1 FROM master_hsn_sac WHERE code = '8538')`);
  const PARTS = [
    ['TST-ITM-1', 'Test Contactor 25A', 'Nos', 1200],
    ['TST-ITM-2', 'Test Terminal Block', 'Nos', 45],
  ];
  for (const [code, name, uom, cost] of PARTS) {
    await client.query(
      `INSERT INTO inventory_items (item_code, item_name, item_type, unit_of_measure,
                                    hsn_code, default_gst_rate, gst_rate, standard_cost,
                                    reorder_level, is_active, company_id)
       SELECT $1::text, $2::text, 'Component', $3::text, '8538', 18, 18, $4::numeric, 10, true, 1
        WHERE NOT EXISTS (SELECT 1 FROM inventory_items WHERE item_code = $1)`,
      [code, name, uom, cost]);
  }

  // Cost centres: a purchase order can be charged to a project or a cost
  // centre, and an empty picker is the 'API-only' state one test exists to
  // catch. Two, so a test can tell one from the other.
  for (const [code, name, dept] of [['CC-OPS', 'Operations', 'Operations'], ['CC-ENG', 'Engineering', 'Engineering']]) {
    await client.query(
      `INSERT INTO cost_centers (company_id, code, name, department, is_active)
       SELECT 1, $1::text, $2::text, $3::text, true
        WHERE NOT EXISTS (SELECT 1 FROM cost_centers WHERE code = $1 AND company_id = 1)`,
      [code, name, dept]);
  }

  // One account linked to an employee, and the rest deliberately not. The
  // reverification suite needs both: a login that resolves to an employees row
  // (the claim fallback) and one that resolves to nothing (the actor-stamping
  // class). Linking the buyer is the semantically honest choice — ids 1-4, 6
  // and 7 stay unlinked and keep the second case testable.
  await client.query(
    `UPDATE users u SET employee_id = e.id
       FROM employees e
      WHERE u.email = 'proc.manager@test.com'
        AND e.company_email = 'vikram.shah@staff.test'
        AND u.employee_id IS DISTINCT FROM e.id`);

  // A customer, so the CRM and reporting suites have a counterparty to hang
  // an opportunity or an invoice on.
  await client.query(
    `INSERT INTO parties (party_code, party_type, name, company_id)
     SELECT 'TSTC-1', 'customer', 'Test Customer Industries', 1
      WHERE NOT EXISTS (SELECT 1 FROM parties WHERE party_code = 'TSTC-1')`);

  // Per-company settings rows. Their absence is not equivalent to their
  // defaults: the IQC gate reads
  //   holdForIqc = settings ? settings.require_iqc_before_stock !== false : true
  // so NO ROW means hold, and the helper that flips the toggle for a test is a
  // plain UPDATE — with no row it changes nothing and the test silently
  // exercises the opposite path. The same goes for notify_po_approval and the
  // three-way-match tolerances. Columns otherwise take their own DB defaults,
  // so this seeds the documented behaviour rather than a second opinion about
  // what those defaults should be — with one deliberate exception below.
  await client.query(
    `INSERT INTO quality_settings (company_id) SELECT 1
      WHERE NOT EXISTS (SELECT 1 FROM quality_settings WHERE company_id = 1)`);
  // notify_po_approval defaults to false, and the fixture tenant is meant to be
  // one that has the toggle ON: the delivery test exists to prove an approved
  // order reaches somebody, and with the default it would assert against a
  // tenant that has switched notifications off.
  await client.query(
    `INSERT INTO procurement_settings (company_id, notify_po_approval) SELECT 1, true
      WHERE NOT EXISTS (SELECT 1 FROM procurement_settings WHERE company_id = 1)`);

  // An opportunity, so the CRM graph tests have a second kind of parent to
  // attach a team member to — the constraint they exercise is that a row may
  // name an account or an opportunity, never both. opportunity_number is
  // GENERATED ALWAYS and must not be supplied.
  await client.query(
    `INSERT INTO opportunities (opportunity_name, company_id, stage, forecast_category, expected_value)
     SELECT 'Test Panel Retrofit', 1, 'qualification', 'pipeline', 250000
      WHERE NOT EXISTS (SELECT 1 FROM opportunities WHERE opportunity_name = 'Test Panel Retrofit')`);

  // ── Transactional documents ───────────────────────────────────────────────
  //
  // Reference data alone leaves a class of test unable to say anything: a
  // spend cube whose total is 0 agrees with any other definition of 0, and a
  // date filter cannot be shown to narrow a report that is empty at every
  // width. Both tests say so themselves rather than pass on nothing. These are
  // the smallest documents that make those comparisons real.

  // Purchase orders, dated well in the past so a bounded window still contains
  // them. 'approved' is deliberate: PO_VOID excludes draft, cancelled and
  // rejected from committed spend, so a draft would seed a total of zero and
  // change nothing.
  for (const [num, days, amount] of [['PO-TST-0001', 45, 120000], ['PO-TST-0002', 20, 48000]]) {
    await client.query(
      `INSERT INTO purchase_orders (po_number, supplier_id, company_id, status, order_date,
                                    subtotal, tax_amount, total_amount, total_amount_inr, currency)
       SELECT $1::text, v.id, 1, 'approved', CURRENT_DATE - $2::int,
              $3::numeric, ROUND($3::numeric * 0.18, 2), ROUND($3::numeric * 1.18, 2),
              ROUND($3::numeric * 1.18, 2), 'INR'
         FROM vendors v
        WHERE v.vendor_code = 'TSTV-1'
          AND NOT EXISTS (SELECT 1 FROM purchase_orders WHERE po_number = $1)`,
      [num, days, amount]);
  }

  // Sales invoices across two widely separated dates, so a narrow window can
  // demonstrably exclude one. The GST report sums total_amount over
  // invoice_date; with a single date, narrow and wide return the same figure
  // and the filter proves nothing.
  for (const [num, days, amount] of [['INV-TST-0001', 200, 90000], ['INV-TST-0002', 10, 35000]]) {
    await client.query(
      // No party_id: parties.id is a uuid and invoices.party_id is an integer,
      // a mismatch this codebase carries deliberately. The GST report sums
      // total_amount over invoice_date and joins no counterparty, so the link
      // is not needed to make the date filter demonstrable.
      `INSERT INTO invoices (invoice_number, company_id, status, invoice_date, due_date,
                             subtotal, tax_amount, total_amount)
       SELECT $1::text, 1, 'paid', CURRENT_DATE - $2::int, CURRENT_DATE - $2::int + 30,
              $3::numeric, ROUND($3::numeric * 0.18, 2), ROUND($3::numeric * 1.18, 2)
        WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE invoice_number = $1)`,
      [num, days, amount]);
  }

  await client.query('COMMIT');

  const { rows } = await client.query(
    `SELECT u.id, u.email, COALESCE(string_agg(r.code, ','), '—') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r      ON r.id = ur.role_id
      WHERE u.id <= 7
      GROUP BY u.id, u.email ORDER BY u.id`
  );
  console.log('✅  Test fixtures present:');
  rows.forEach(r => console.log(`    ${r.id}  ${r.email}  [${r.roles}]`));

  const { rows: [counts] } = await client.query(
    `SELECT (SELECT count(*) FROM employees       WHERE company_id = 1) AS employees,
            (SELECT count(*) FROM vendors         WHERE company_id = 1) AS vendors,
            (SELECT count(*) FROM inventory_items WHERE company_id = 1) AS items,
            (SELECT count(*) FROM warehouses      WHERE company_id = 1) AS warehouses,
            (SELECT count(*) FROM parties         WHERE company_id = 1) AS parties,
            (SELECT count(*) FROM purchase_orders WHERE company_id = 1) AS pos,
            (SELECT count(*) FROM invoices        WHERE company_id = 1) AS invoices`);
  console.log('✅  Company-1 reference data: '
    + `${counts.employees} employees, ${counts.vendors} vendors, ${counts.items} items, `
    + `${counts.warehouses} warehouse(s), ${counts.parties} party(ies), `
    + `${counts.pos} purchase order(s), ${counts.invoices} invoice(s)`);
  process.exit(0);
} catch (err) {
  await client.query('ROLLBACK');
  console.error('❌  seed-test-fixtures failed:', err.message);
  process.exit(1);
} finally {
  client.release();
}
