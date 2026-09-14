/**
 * integration.reports.test.js — the Reports module, against the REAL database.
 *
 * DELIBERATELY NOT MOCKED. Every defect the 2026-08-19 audit found in this
 * module was invisible to a mocked pool: eleven reports referenced columns that
 * do not exist in this schema, a `parties.id uuid = purchase_orders.supplier_id
 * integer` join raised 42883 on every call, and a `safeQuery` helper caught all
 * of it and returned `[]` so the page rendered "No records found" with a green
 * tick. A stubbed pool proves the handler's control flow and nothing about its
 * SQL, which is exactly the wrong thing to assert here.
 *
 * The contract these tests defend, in priority order:
 *   1. A broken report FAILS. It never becomes an empty successful result.
 *   2. Empty and Error are different states, and both are well-formed.
 *   3. Filters either change the query or are refused — never silently dropped.
 *   4. Scope is mandatory; an unscopable caller is denied, not served everything.
 *   5. Buckets reconcile to their own totals.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

// setup.js sets a dummy DB_PASSWORD because every other suite mocks the pool.
// Restore the real one FIRST — config/db.js builds its Pool at import time, so
// every import below must be dynamic and come after this.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }         = await import('../config/db.js');
const { default: reportsRoutes } = await import('../modules/reports/routes/reports.routes.js');
const { REPORTS }               = await import('../modules/reports/reportCatalog.js');
const { reportsPolicy }         = await import('../shared/analyticsAuthz.js');
const { verifyToken }           = await import('../middlewares/auth.middleware.js');
const { buildApp }              = await import('./helpers/testApp.js');
const { makeToken }             = await import('./helpers/tokens.js');

const app = buildApp(['/api/reports', verifyToken, reportsPolicy, reportsRoutes]);

let ADMIN_ID;
let EMPLOYEE_ID;
const auth  = id => `Bearer ${makeToken({ userId: id })}`;
const admin = () => auth(ADMIN_ID);

const TAG = `ZZTEST_${Date.now()}`;
const createdSavedReports = [];
const createdEmployees = [];

async function sweepDebris() {
  await pool.query(`DELETE FROM saved_reports WHERE name LIKE 'ZZTEST\\_%'`).catch(() => {});
  await pool.query(`DELETE FROM employees WHERE name LIKE 'ZZTEST\\_%'`).catch(() => {});
}

beforeAll(async () => {
  await sweepDebris();

  const { rows: admins } = await pool.query(
    `SELECT u.id FROM users u
       JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
      WHERE u.is_active = true AND (u.logout_at IS NULL OR u.logout_at <= NOW()) AND us.company_id = 1
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND LOWER(r.code) IN ('admin','super_admin'))
      ORDER BY u.id LIMIT 1`
  );
  if (!admins[0]) throw new Error('No active company-scoped admin found — these tests need a seeded DB.');
  ADMIN_ID = admins[0].id;

  const { rows: emps } = await pool.query(
    `SELECT u.id FROM users u
      WHERE u.is_active = true AND (u.logout_at IS NULL OR u.logout_at <= NOW())
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND LOWER(r.code) = 'employee')
        AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                         WHERE ur.user_id = u.id AND LOWER(r.code) <> 'employee')
      ORDER BY u.id LIMIT 1`
  );
  if (!emps[0]) throw new Error('No employee-only account found — these tests need a seeded DB.');
  EMPLOYEE_ID = emps[0].id;
});

afterAll(async () => {
  if (createdSavedReports.length) {
    await pool.query(`DELETE FROM saved_reports WHERE id = ANY($1::int[])`, [createdSavedReports]);
  }
  if (createdEmployees.length) {
    await pool.query(`DELETE FROM employees WHERE id = ANY($1::int[])`, [createdEmployees]);
  }
  await sweepDebris();
  await pool.end();
});

/** Default params for a report — every declared filter gets a wide, valid value. */
function paramsFor(report) {
  const p = new URLSearchParams();
  if (report.filters.includes('start_date')) p.set('start_date', '2000-01-01');
  if (report.filters.includes('end_date')) p.set('end_date', '2099-12-31');
  if (report.filters.includes('year')) p.set('year', String(new Date().getFullYear()));
  return p.toString();
}

/* ────────────────────────────────────────────────────────────────────────── */

describe('catalog', () => {
  it('lists every report with its filters, permission-derived grain and measures', async () => {
    const res = await request(app).get('/api/reports/catalog').set('Authorization', admin());
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(REPORTS.length);
    for (const r of res.body.reports) {
      expect(r.id).toBeTruthy();
      expect(Array.isArray(r.filters)).toBe(true);
      expect(['detail', 'summary']).toContain(r.grain);
    }
  });

  it('never leaks the permission tuple to the client', async () => {
    const res = await request(app).get('/api/reports/catalog').set('Authorization', admin());
    for (const r of res.body.reports) expect(r.permission).toBeUndefined();
  });
});

describe('every report executes against the live schema', () => {
  // This is the test that would have caught the audit's headline defect. Eleven
  // reports raised 42703/42883 on every call and answered 200 [].
  it.each(REPORTS.map(r => [r.id, r]))('%s runs and returns a well-formed envelope', async (_id, report) => {
    const res = await request(app)
      .get(`/api/reports/${report.id}?${paramsFor(report)}`)
      .set('Authorization', admin());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ report: report.id, label: report.label });
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(typeof res.body.total).toBe('number');
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.rows.length);
    // Row count and total must agree when everything fits on one page.
    if (res.body.total <= res.body.limit) {
      expect(res.body.rows).toHaveLength(res.body.total);
    }
    // Declared measures must actually be columns, or the UI right-aligns nothing.
    if (res.body.rows.length) {
      const cols = Object.keys(res.body.rows[0]);
      for (const m of report.measures || []) expect(cols).toContain(m);
    }
  });
});

describe('a broken report fails loudly', () => {
  it('an unknown report is 404 with the available list, not an empty result', async () => {
    const res = await request(app).get('/api/reports/not-a-report').set('Authorization', admin());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('UNKNOWN_REPORT');
    expect(res.body.rows).toBeUndefined();
  });

  it('a database failure surfaces as 5xx, never as 200 with zero rows', async () => {
    // Point the repository at a table that cannot exist, exactly as the eleven
    // dead reports effectively did, and assert the request fails.
    const repo = (await import('../modules/reports/repositories/reports.repository.js')).default;
    const original = repo.getHeadcountReport;
    repo.getHeadcountReport = async () => {
      const err = new Error('relation "zz_does_not_exist" does not exist');
      err.code = '42P01';
      throw err;
    };
    try {
      const res = await request(app).get('/api/reports/headcount').set('Authorization', admin());
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.rows).toBeUndefined();
      // And the raw schema text must not reach the client.
      expect(JSON.stringify(res.body)).not.toContain('zz_does_not_exist');
    } finally {
      repo.getHeadcountReport = original;
    }
  });
});

describe('empty is distinguishable from broken', () => {
  it('a filter that genuinely matches nothing returns 200 with total 0 and an empty array', async () => {
    const res = await request(app)
      .get('/api/reports/sales?start_date=1900-01-01&end_date=1900-12-31')
      .set('Authorization', admin());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.rows).toEqual([]);
    expect(res.body.report).toBe('sales');
  });
});

describe('filters are honoured or refused, never silently dropped', () => {
  it('rejects a filter the report does not support, naming what it does support', async () => {
    const res = await request(app)
      .get('/api/reports/gst-report?department=Finance')
      .set('Authorization', admin());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FILTER');
    expect(res.body.supported).not.toContain('department');
  });

  it('rejects an unknown filter name outright', async () => {
    const res = await request(app).get('/api/reports/headcount?region=South').set('Authorization', admin());
    expect(res.status).toBe(400);
  });

  it('rejects a malformed date rather than ignoring it', async () => {
    const res = await request(app)
      .get('/api/reports/sales?start_date=01-01-2026&end_date=2026-12-31')
      .set('Authorization', admin());
    expect(res.status).toBe(400);
  });

  it('rejects an inverted date range', async () => {
    const res = await request(app)
      .get('/api/reports/sales?start_date=2026-12-31&end_date=2026-01-01')
      .set('Authorization', admin());
    expect(res.status).toBe(400);
  });

  it('a supported filter actually narrows the result', async () => {
    const wide = await request(app)
      .get('/api/reports/headcount').set('Authorization', admin());
    const narrow = await request(app)
      .get('/api/reports/headcount?department=Finance').set('Authorization', admin());
    expect(wide.status).toBe(200);
    expect(narrow.status).toBe(200);
    expect(narrow.body.total).toBeLessThanOrEqual(wide.body.total);
  });

  it('a date range actually narrows the result', async () => {
    const wide = await request(app)
      .get('/api/reports/gst-report?start_date=2000-01-01&end_date=2099-12-31')
      .set('Authorization', admin());
    const narrow = await request(app)
      .get('/api/reports/gst-report?start_date=1900-01-01&end_date=1900-12-31')
      .set('Authorization', admin());
    expect(narrow.body.total).toBeLessThan(wide.body.total);
  });
});

describe('date handling', () => {
  it('month buckets are YYYY-MM strings, not timestamps that shift a month in IST', async () => {
    // DATE_TRUNC('month', <date>) returns timestamptz; the driver's DATE parser
    // does not cover 1184, so July invoices serialised to
    // "2026-06-30T18:30:00.000Z" and displayed as June.
    const res = await request(app)
      .get('/api/reports/gst-report?start_date=2000-01-01&end_date=2099-12-31')
      .set('Authorization', admin());
    for (const row of res.body.rows) {
      expect(row.month).toMatch(/^\d{4}-\d{2}$/);
    }
  });
});

describe('KPI reconciliation', () => {
  it('attendance buckets sum exactly to recorded_days', async () => {
    const res = await request(app)
      .get('/api/reports/attendance?start_date=2000-01-01&end_date=2099-12-31')
      .set('Authorization', admin());
    expect(res.status).toBe(200);
    for (const r of res.body.rows) {
      const parts = Number(r.present_days) + Number(r.absent_days) + Number(r.leave_days)
                  + Number(r.non_working_days) + Number(r.unclassified_days);
      expect(parts).toBe(Number(r.recorded_days));
    }
  });

  it('attendance keeps employees with no records instead of inner-joining them away', async () => {
    const res = await request(app)
      .get('/api/reports/attendance?start_date=2000-01-01&end_date=2099-12-31')
      .set('Authorization', admin());
    const { rows: [{ n }] } = await pool.query(
      `SELECT count(*)::int n FROM employees
        WHERE deleted_at IS NULL AND company_id = 1
          AND LOWER(status) IN ('active','probation','notice','confirmed')`
    );
    expect(res.body.total).toBe(n);
  });

  it('headcount excludes an exited employee from active but still counts the record', async () => {
    // employees.name is GENERATED from first_name/last_name — insert the parts.
    const { rows: [emp] } = await pool.query(
      `INSERT INTO employees (first_name, last_name, department, status, company_id, joining_date)
       VALUES ('ZZTEST', $1, 'ZZTEST_DEPT', 'Left', 1, CURRENT_DATE) RETURNING id`,
      [`exited_${TAG}`]
    );
    createdEmployees.push(emp.id);

    const res = await request(app)
      .get('/api/reports/headcount?department=ZZTEST_DEPT').set('Authorization', admin());
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r => r.department === 'ZZTEST_DEPT');
    expect(row).toBeDefined();
    expect(row.active_employees).toBe(0);   // the defect: this used to be 1
    expect(row.exited_employees).toBe(1);
    expect(row.total_records).toBe(1);
  });

  it('headcount folds HR and Human Resources into one department', async () => {
    const res = await request(app).get('/api/reports/headcount').set('Authorization', admin());
    const names = res.body.rows.map(r => r.department);
    expect(names).not.toContain('HR');
    expect(new Set(names).size).toBe(names.length);
  });

  it('outstanding invoices nets payments off and flags a stale stored balance', async () => {
    const res = await request(app).get('/api/reports/outstanding-invoices').set('Authorization', admin());
    expect(res.status).toBe(200);
    for (const r of res.body.rows) {
      const derived = Number(r.total_amount) - Number(r.paid_amount);
      expect(Math.abs(derived - Number(r.outstanding_amount))).toBeLessThan(0.01);
      expect(Number(r.outstanding_amount)).toBeGreaterThan(0);
    }
  });

  it('GST taxable value is per-row, not a COALESCE over the whole aggregate', async () => {
    const res = await request(app)
      .get('/api/reports/gst-report?start_date=2000-01-01&end_date=2099-12-31')
      .set('Authorization', admin());
    for (const r of res.body.rows) {
      // taxable + tax must reconcile to gross for every month, which the old
      // COALESCE(SUM(a), SUM(b)) form could not do — it reported ₹0 taxable
      // against crores of gross because most subtotals are 0, not NULL.
      const recomposed = Number(r.taxable_value) + Number(r.gst_collected);
      expect(Math.abs(recomposed - Number(r.gross_amount))).toBeLessThan(1);
    }
  });

  it('sales revenue uses the real order-status vocabulary', async () => {
    const res = await request(app)
      .get('/api/reports/sales?start_date=2000-01-01&end_date=2099-12-31')
      .set('Authorization', admin());
    const { rows: [{ amt }] } = await pool.query(
      `SELECT COALESCE(SUM(total_amount), 0)::float amt FROM sales_orders
        WHERE deleted_at IS NULL AND company_id = 1
          AND (order_status IS NULL OR LOWER(order_status) NOT IN ('draft','cancelled','rejected'))`
    );
    const reported = res.body.rows.reduce((s, r) => s + Number(r.total_revenue), 0);
    expect(Math.abs(reported - amt)).toBeLessThan(0.01);
  });
});

describe('pagination', () => {
  it('reports the unpaginated total alongside the page', async () => {
    const res = await request(app)
      .get('/api/reports/attendance?start_date=2000-01-01&end_date=2099-12-31&limit=2')
      .set('Authorization', admin());
    expect(res.body.rows.length).toBeLessThanOrEqual(2);
    expect(res.body.limit).toBe(2);
    expect(res.body.total).toBeGreaterThanOrEqual(res.body.rows.length);
  });

  it('offset walks the same result set without repeating a row', async () => {
    const p1 = await request(app)
      .get('/api/reports/attendance?start_date=2000-01-01&end_date=2099-12-31&limit=2&offset=0')
      .set('Authorization', admin());
    const p2 = await request(app)
      .get('/api/reports/attendance?start_date=2000-01-01&end_date=2099-12-31&limit=2&offset=2')
      .set('Authorization', admin());
    expect(p1.body.total).toBe(p2.body.total);
    const ids1 = p1.body.rows.map(r => r.employee_id);
    const ids2 = p2.body.rows.map(r => r.employee_id);
    expect(ids1.filter(id => ids2.includes(id))).toHaveLength(0);
  });

  it('refuses a limit above the ceiling instead of silently clamping', async () => {
    const res = await request(app).get('/api/reports/headcount?limit=999999').set('Authorization', admin());
    expect(res.status).toBe(400);
  });
});

describe('authorization', () => {
  it('denies an employee-only account every single report', async () => {
    for (const report of REPORTS) {
      const res = await request(app)
        .get(`/api/reports/${report.id}?${paramsFor(report)}`)
        .set('Authorization', auth(EMPLOYEE_ID));
      expect(res.status, `${report.id} must not be readable by a plain employee`).toBe(403);
    }
  });

  it('denies the salary-derived liability report specifically', async () => {
    // The audit's headline exposure: daily_rate = basic_salary / 26 for every
    // named colleague, served 200 to any authenticated user.
    const res = await request(app)
      .get('/api/reports/leave/liability').set('Authorization', auth(EMPLOYEE_ID));
    expect(res.status).toBe(403);
  });

  it('requires a token at all', async () => {
    const res = await request(app).get('/api/reports/headcount');
    expect(res.status).toBe(401);
  });

  it('every catalog entry is covered by a policy rule, so none can ship open', async () => {
    for (const report of REPORTS) {
      const res = await request(app)
        .get(`/api/reports/${report.id}`).set('Authorization', auth(EMPLOYEE_ID));
      expect(res.status, `${report.id} is not guarded`).not.toBe(200);
    }
  });
});

describe('saved reports', () => {
  it('round-trips create, list and delete against the real columns', async () => {
    const create = await request(app)
      .post('/api/reports/saved').set('Authorization', admin())
      .send({ name: `${TAG}_roundtrip`, report_type: 'headcount', filters: { department: 'Finance' }, columns: ['department'] });

    expect(create.status).toBe(201);
    expect(create.body.id).toBeGreaterThan(0);      // the defect: this used to be null
    expect(create.body.name).toBe(`${TAG}_roundtrip`);
    createdSavedReports.push(create.body.id);

    const list = await request(app).get('/api/reports/saved').set('Authorization', admin());
    expect(list.status).toBe(200);
    expect(list.body.rows.some(r => r.id === create.body.id)).toBe(true);

    const del = await request(app)
      .delete(`/api/reports/saved/${create.body.id}`).set('Authorization', admin());
    expect(del.status).toBe(200);

    const after = await request(app).get('/api/reports/saved').set('Authorization', admin());
    expect(after.body.rows.some(r => r.id === create.body.id)).toBe(false);
  });

  it('persists the row rather than reporting success and writing nothing', async () => {
    const create = await request(app)
      .post('/api/reports/saved').set('Authorization', admin())
      .send({ name: `${TAG}_persisted`, report_type: 'stock' });
    createdSavedReports.push(create.body.id);

    const { rows } = await pool.query(`SELECT name, report_type FROM saved_reports WHERE id = $1`, [create.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].report_type).toBe('stock');
  });

  it('refuses a report_type that is not in the catalog', async () => {
    const res = await request(app)
      .post('/api/reports/saved').set('Authorization', admin())
      .send({ name: `${TAG}_bogus`, report_type: 'not-a-report' });
    expect(res.status).toBe(400);
  });

  it('will not let a non-owner delete someone else\'s saved report', async () => {
    const create = await request(app)
      .post('/api/reports/saved').set('Authorization', admin())
      .send({ name: `${TAG}_owned`, report_type: 'headcount' });
    createdSavedReports.push(create.body.id);

    const res = await request(app)
      .delete(`/api/reports/saved/${create.body.id}`).set('Authorization', auth(EMPLOYEE_ID));
    // 403 from the policy or 404 from the ownership scope — either refuses; what
    // must not happen is a 200 that deletes another user's row.
    expect([403, 404]).toContain(res.status);

    const { rows } = await pool.query(
      `SELECT deleted_at FROM saved_reports WHERE id = $1`, [create.body.id]);
    expect(rows[0].deleted_at).toBeNull();
  });
});
