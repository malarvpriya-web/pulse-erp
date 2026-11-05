/**
 * integration.phase3I.test.js — the shipped-unit guard and the guarded
 * orphan-journal cleanup (Phase 3I). Real database; isolated TAG-coded
 * companies and fixture-made orphans only — the 938 real orphans are never
 * touched (every call names its own fixture ids).
 *
 * WHAT IS PROVED
 *   Guard (migration 20261028000008), checked at commit:
 *     - a shipped / dispatched / delivered unit with no package of its own
 *       company is refused — inserted, updated, or left so by deleting,
 *       unpacking or re-pointing its package line, or moving its package to
 *       another company; also through the API (create 422, update 409);
 *     - a unit and its package line written in one transaction, in either
 *       order, are accepted; non-shipped statuses are unaffected;
 *     - a status change and a concurrent deletion of the accounting line
 *       cannot both commit.
 *   Cleanup (orphanJournalCleanup.js):
 *     - backup → read back → matches the live rows; a changed row is caught;
 *     - execute refuses without the approver, the exact phrase, a matching
 *       backup, or when any frozen id no longer qualifies (incl. a new
 *       reference from any FK table) — and then deletes nothing;
 *     - when everything holds it deletes exactly the frozen ids and their
 *       lines, nothing else, in one transaction, with before/after evidence.
 *   The SO-TRANSIT cleanup's dry run writes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
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

const allows = (req, key) => req.user?.perms === '*' || (req.user?.perms || []).includes(key);
vi.mock('../middlewares/auth.middleware.js', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    verifyToken: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Unauthorized' })),
    requirePermission: (module, action) => (req, res, next) =>
      (allows(req, `${module}:${action}`) ? next() : res.status(403).json({ error: 'Forbidden' })),
  };
});

const { default: pool }          = await import('../config/db.js');
const { default: serialsRouter } = await import('../modules/inventory/routes/serialNumbers.routes.js');
const cleanup = await import('../../scripts/reconciliation/orphanJournalCleanup.js');

const TAG = 'ZZI3I';
const RUN = Date.now();
const co = {};
let seq = 0;
const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
const num = async (sql, params = []) => Number(Object.values((await pool.query(sql, params)).rows[0])[0]);

function appAs(companyId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 1, id: 1, roles: ['admin'], company_id: companyId, perms: '*' };
    req.scope = { company_id: companyId };
    next();
  });
  app.use('/inventory/serials', serialsRouter);
  return app;
}
const newClient = async () => {
  const c = new pg.Client({ host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await c.connect();
  return c;
};

async function sweep() {
  // This suite's own fixture orphans (their company is already gone), by their
  // own entry-number prefix only — never anything else.
  await pool.query(`DELETE FROM invoices WHERE invoice_number LIKE $1`, [`${TAG}-INV-%`]).catch(() => {});
  await pool.query(`DELETE FROM journal_entries WHERE entry_number LIKE $1
                       AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = journal_entries.company_id)`, [`${TAG}-JE-%`]).catch(() => {});
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code LIKE $1`, [`${TAG}%`]);
  const ids = rows.map(r => r.id);
  if (!ids.length) return;
  // Unwind shipped fixture units first, so their package lines may go.
  await pool.query(`UPDATE serial_numbers SET status = 'in_stock' WHERE company_id = ANY($1)`, [ids]).catch(() => {});
  for (const sql of [
    `DELETE FROM package_lines WHERE company_id = ANY($1)`,
    `DELETE FROM packages WHERE company_id = ANY($1)`,
    `DELETE FROM serial_events WHERE serial_id IN (SELECT id FROM serial_numbers WHERE company_id = ANY($1))`,
    `DELETE FROM serial_numbers WHERE company_id = ANY($1)`,
    `DELETE FROM invoices WHERE company_id = ANY($1)`,
    `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = ANY($1))`,
    `DELETE FROM journal_entries WHERE company_id = ANY($1)`,
    `DELETE FROM audit_logs WHERE company_id = ANY($1)`,
    `DELETE FROM inventory_items WHERE company_id = ANY($1)`,
    `DELETE FROM companies WHERE id = ANY($1)`,
  ]) await pool.query(sql, [ids]).catch(() => {});
}
async function makeCompany(s) {
  const id = (await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} Co ${s}`, `${TAG}${s}`])).rows[0].id;
  const item = (await pool.query(`INSERT INTO inventory_items (item_code, item_name, company_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${TAG}-${s}-ITEM`, `${TAG} panel`, id])).rows[0].id;
  co[s] = { id, item };
}
const serial = (c, status = 'in_stock', db = pool) => db.query(
  `INSERT INTO serial_numbers (serial_number, item_id, company_id, status) VALUES ($1, $2, $3, $4) RETURNING id`,
  [`${TAG}-SN-${RUN}-${++seq}`, c.item, c.id, status]).then(r => r.rows[0].id);
const pkg = (c, db = pool) => db.query(`INSERT INTO packages (company_id, package_no, status) VALUES ($1, $2, 'shipped') RETURNING id`,
  [c.id, `${TAG}-PKG-${RUN}-${++seq}`]).then(r => r.rows[0].id);
const line = (c, packageId, serialId, db = pool) => db.query(
  `INSERT INTO package_lines (package_id, company_id, item_id, serial_id, quantity) VALUES ($1, $2, $3, $4, 1) RETURNING id`,
  [packageId, c.id, c.item, serialId]).then(r => r.rows[0].id);
/** A shipped unit, valid: unit + package + line in one transaction. */
async function shippedUnit(c) {
  const t = await pool.connect();
  try {
    await t.query('BEGIN');
    const s = await serial(c, 'shipped', t);
    const p = await pkg(c, t);
    const l = await line(c, p, s, t);
    await t.query('COMMIT');
    return { s, p, l };
  } catch (e) { await t.query('ROLLBACK'); throw e; } finally { t.release(); }
}
const status = (id) => one(`SELECT status FROM serial_numbers WHERE id = $1`, [id]).then(r => r?.status);

beforeAll(async () => {
  await sweep();
  await makeCompany('A');
  await makeCompany('B');
}, 60_000);
afterAll(async () => {
  await sweep();
}, 60_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('shipped-unit guard', () => {
  it('refuses a shipped unit inserted with no package, and accepts one written with its package line', async () => {
    for (const s of ['shipped', 'Dispatched', 'delivered']) {
      await expect(serial(co.A, s)).rejects.toThrow(/no package of its own company accounts for it/);
    }
    const before = await num(`SELECT COUNT(*)::int FROM serial_numbers WHERE company_id = $1`, [co.A.id]);
    const ok = await shippedUnit(co.A);
    expect(await status(ok.s)).toBe('shipped');
    // Either order inside the transaction: the line first is impossible (it needs the unit), the status last is fine.
    const t = await pool.connect();
    try {
      await t.query('BEGIN');
      const s = await serial(co.A, 'in_stock', t);
      await line(co.A, await pkg(co.A, t), s, t);
      await t.query(`UPDATE serial_numbers SET status = 'delivered' WHERE id = $1`, [s]);
      await t.query('COMMIT');
    } finally { t.release(); }
    expect(await num(`SELECT COUNT(*)::int FROM serial_numbers WHERE company_id = $1`, [co.A.id])).toBe(before + 2);
  });

  it('leaves other statuses alone', async () => {
    for (const s of ['in_stock', 'active', 'in_production', 'packed', 'sold']) {
      const id = await serial(co.A, s);
      expect(await status(id)).toBe(s);
    }
  });

  it('refuses a status change to shipped with no package, in any statement order', async () => {
    const id = await serial(co.A, 'packed');
    await expect(pool.query(`UPDATE serial_numbers SET status = 'shipped' WHERE id = $1`, [id])).rejects.toThrow(/cannot be marked|accounts for it/);
    expect(await status(id)).toBe('packed');
  });

  it('refuses removing, unpacking or re-pointing the line that accounts for a shipped unit', async () => {
    const u = await shippedUnit(co.A);
    const other = await serial(co.A, 'in_stock');
    for (const sql of [
      [`DELETE FROM package_lines WHERE id = $1`, [u.l]],
      [`UPDATE package_lines SET unpacked = true WHERE id = $1`, [u.l]],
      [`UPDATE package_lines SET serial_id = $2 WHERE id = $1`, [u.l, other]],
      [`DELETE FROM packages WHERE id = $1`, [u.p]],
    ]) {
      await expect(pool.query(sql[0], sql[1])).rejects.toThrow(/no package of its own company accounts for it/);
    }
    expect(await num(`SELECT COUNT(*)::int FROM package_lines WHERE id = $1 AND NOT unpacked AND serial_id = $2`, [u.l, u.s])).toBe(1);
    // Unwound first, the line may go.
    const t = await pool.connect();
    try {
      await t.query('BEGIN');
      await t.query(`UPDATE serial_numbers SET status = 'in_stock' WHERE id = $1`, [u.s]);
      await t.query(`DELETE FROM package_lines WHERE id = $1`, [u.l]);
      await t.query('COMMIT');
    } finally { t.release(); }
  });

  it("another company's package does not account for a unit, and a package cannot move company under it", async () => {
    const t = await pool.connect();
    try {
      await t.query('BEGIN');
      const s = await serial(co.A, 'shipped', t);
      await line(co.B, await pkg(co.B, t), s, t);
      await expect(t.query('COMMIT')).rejects.toThrow(/no package of its own company/);
    } finally { t.release(); }
    const u = await shippedUnit(co.A);
    await expect(pool.query(`UPDATE packages SET company_id = $2 WHERE id = $1`, [u.p, co.B.id])).rejects.toThrow(/no package of its own company/);
    expect((await one(`SELECT company_id FROM packages WHERE id = $1`, [u.p])).company_id).toBe(co.A.id);
  });

  it('a status change and a concurrent deletion of its only line cannot both commit', async () => {
    const id = await serial(co.A, 'packed');
    const p = await pkg(co.A);
    const l = await line(co.A, p, id);
    const t1 = await newClient(), t2 = await newClient();
    try {
      await t1.query('BEGIN');
      await t2.query('BEGIN');
      await t1.query(`UPDATE serial_numbers SET status = 'shipped' WHERE id = $1`, [id]);   // the line exists: passes now
      await t2.query(`DELETE FROM package_lines WHERE id = $1`, [l]);
      const results = await Promise.allSettled([t1.query('COMMIT'), t2.query('COMMIT')]);
      expect(results.filter(r => r.status === 'fulfilled').length).toBe(1);
    } finally {
      await t1.query('ROLLBACK').catch(() => {}); await t2.query('ROLLBACK').catch(() => {});
      await t1.end(); await t2.end();
    }
    const after = await one(`SELECT s.status, (SELECT COUNT(*)::int FROM package_lines WHERE id = $2) AS lines FROM serial_numbers s WHERE s.id = $1`, [id, l]);
    expect(after.status === 'shipped' ? after.lines : 1).toBe(1);                // never shipped with its line gone
  });

  it('the API never creates a shipped unit, and reports a refused status change as a conflict', async () => {
    const created = await request(appAs(co.A.id)).post('/inventory/serials').send({ serial_number: `${TAG}-API-${RUN}`, item_id: co.A.item, status: 'shipped' });
    expect([created.status, created.body.code]).toEqual([422, 'SHIPPED_REQUIRES_PACKAGE']);
    expect(await num(`SELECT COUNT(*)::int FROM serial_numbers WHERE serial_number = $1`, [`${TAG}-API-${RUN}`])).toBe(0);
    const ok = await request(appAs(co.A.id)).post('/inventory/serials').send({ serial_number: `${TAG}-API2-${RUN}`, item_id: co.A.item });
    expect(ok.status).toBe(201);
    const upd = await request(appAs(co.A.id)).put(`/inventory/serials/${ok.body.id}`).send({ status: 'delivered' });
    expect([upd.status, upd.body.code]).toEqual([409, 'SHIPPED_REQUIRES_PACKAGE']);
    expect(await status(ok.body.id)).toBe('in_stock');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('guarded orphan-journal cleanup (fixture orphans only)', () => {
  /**
   * Orphans made for this test: journals naming a company id that does not
   * exist. journal_entries.company_id is a real FK since 20261028000009, so the
   * database (rightly) refuses to make one — the fixture writes them on its own
   * connection with session_replication_role = replica, which suspends FK
   * checks for that session only (the test role is a superuser). It writes
   * only TAG-numbered rows; nothing else runs on that connection.
   */
  async function fixtureOrphans(n = 3) {
    const { rows: [{ id: missing }] } = await pool.query(`SELECT COALESCE(MAX(id), 0) + 100000 + $1::int AS id FROM companies`, [++seq]);
    const { rows: accts } = await pool.query(`SELECT id, code, name FROM chart_of_accounts WHERE code IN ('1010','4001') AND company_id IS NULL AND is_active ORDER BY code`);
    const raw = await newClient();
    const ids = [];
    try {
      await raw.query(`SET session_replication_role = replica`);
      for (let i = 0; i < n; i++) {
        const { rows: [e] } = await raw.query(
          `INSERT INTO journal_entries (entry_number, entry_date, entry_type, reference_type, reference_id, status, total_debit, total_credit, company_id)
           VALUES ($1, CURRENT_DATE, 'Invoice', 'invoice', '-1', 'posted', 10, 10, $2) RETURNING id`, [`${TAG}-JE-${RUN}-${++seq}`, missing]);
        for (const [a, d, k] of [[accts[0], 10, 0], [accts[1], 0, 10]]) {
          await raw.query(`INSERT INTO journal_lines (entry_id, account_id, account_code, account_name, debit, credit, company_id)
                            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [e.id, a.id, a.code, a.name, d, k, missing]);
        }
        ids.push(e.id);
      }
    } finally { await raw.end(); }
    return ids;
  }

  it('the database itself now refuses an orphan: journal_entries.company_id is a validated foreign key, never cascading', async () => {
    const { rows: [fk] } = await pool.query(
      `SELECT convalidated, confdeltype FROM pg_constraint WHERE conname = 'journal_entries_company_id_fkey'`);
    expect(fk).toEqual({ convalidated: true, confdeltype: 'a' });          // NO ACTION
    await expect(pool.query(
      `INSERT INTO journal_entries (entry_number, entry_date, entry_type, status, total_debit, total_credit, company_id)
       VALUES ($1, CURRENT_DATE, 'auto', 'draft', 0, 0, -1)`, [`${TAG}-JE-${RUN}-${++seq}`])).rejects.toThrow(/journal_entries_company_id_fkey/);
    const { rows: [tmp] } = await pool.query(`INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${TAG} fk ${++seq}`, `${TAG}F${seq}`]);
    await pool.query(`INSERT INTO journal_entries (entry_number, entry_date, entry_type, status, total_debit, total_credit, company_id)
                      VALUES ($1, CURRENT_DATE, 'auto', 'draft', 0, 0, $2)`, [`${TAG}-JE-${RUN}-${++seq}`, tmp.id]);
    await expect(pool.query(`DELETE FROM companies WHERE id = $1`, [tmp.id])).rejects.toThrow(/journal_entries_company_id_fkey/);
    await pool.query(`DELETE FROM journal_entries WHERE company_id = $1`, [tmp.id]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [tmp.id]);
  });
  const realOrphans = () => num(`SELECT COUNT(*)::int FROM journal_entries je WHERE je.company_id IS NOT NULL
                                  AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = je.company_id)`);

  it('backs up exactly the frozen rows, reads them back, and catches a changed row', async () => {
    const ids = await fixtureOrphans(3);
    const bk = await cleanup.backup(pool, ids);
    expect(bk.totals).toMatchObject({ headers: 3, lines: 6, header_debit: 30, line_debit: 30, line_credit: 30 });
    const roundTrip = JSON.parse(JSON.stringify(bk));
    expect((await cleanup.verifyBackup(pool, roundTrip, ids)).ok).toBe(true);
    await pool.query(`UPDATE journal_entries SET description = 'changed' WHERE id = $1`, [ids[0]]);
    const v = await cleanup.verifyBackup(pool, roundTrip, ids);
    expect([v.ok, v.problems]).toEqual([false, ['live headers differ from the backup']]);
    expect((await cleanup.verifyBackup(pool, roundTrip, ids.slice(1))).ok).toBe(false);
  });

  it('execute refuses — deleting nothing — without approval, the phrase, a matching backup, or a still-qualifying set', async () => {
    const ids = await fixtureOrphans(2);
    const bk = JSON.parse(JSON.stringify(await cleanup.backup(pool, ids)));
    const c = await pool.connect();
    const left = () => num(`SELECT COUNT(*)::int FROM journal_entries WHERE id = ANY($1::uuid[])`, [ids]);
    try {
      await expect(cleanup.execute(c, ids, bk, { confirm: cleanup.CONFIRM_PHRASE(2) })).rejects.toThrow(/approvedBy/);
      await expect(cleanup.execute(c, ids, bk, { approvedBy: 'QA', confirm: 'yes' })).rejects.toThrow(/confirmation phrase/);
      // A new reference from any table with an FK to journal_entries disqualifies the id.
      const { rows: [inv] } = await pool.query(
        `INSERT INTO invoices (invoice_number, invoice_date, due_date, subtotal, tax_amount, total_amount, status, company_id, journal_entry_id)
         VALUES ($1, CURRENT_DATE, CURRENT_DATE, 0, 0, 0, 'draft', $2, $3) RETURNING id`, [`${TAG}-INV-${RUN}-${++seq}`, co.A.id, ids[0]]);
      await expect(cleanup.execute(c, ids, bk, { approvedBy: 'QA', confirm: cleanup.CONFIRM_PHRASE(2) }))
        .rejects.toMatchObject({ failures: [expect.objectContaining({ id: ids[0], failed: [expect.stringMatching(/^C4 referenced by invoices.journal_entry_id/)] })] });
      await pool.query(`DELETE FROM invoices WHERE id = $1`, [inv.id]);
      // A backup that no longer matches.
      const stale = { ...bk, checksums: { ...bk.checksums, lines: 'x' } };
      await expect(cleanup.execute(c, ids, stale, { approvedBy: 'QA', confirm: cleanup.CONFIRM_PHRASE(2) })).rejects.toThrow(/backup does not match/);
      // An id that no longer exists.
      const ghostId = '00000000-0000-0000-0000-000000000000';
      const ghost = [...ids, ghostId];
      await expect(cleanup.execute(c, ghost, bk, { approvedBy: 'QA', confirm: cleanup.CONFIRM_PHRASE(3) }))
        .rejects.toMatchObject({ message: expect.stringMatching(/no longer qualify/),
                                 failures: [{ id: ghostId, failed: ['missing — no longer exists'] }] });
    } finally { c.release(); }
    expect(await left()).toBe(2);
  });

  it('when everything holds, deletes exactly the frozen ids and their lines — nothing else', async () => {
    const ids = await fixtureOrphans(3);
    const keep = await fixtureOrphans(1);                                   // an orphan NOT on the list
    const real = await realOrphans();
    const bk = JSON.parse(JSON.stringify(await cleanup.backup(pool, ids)));
    const c = await pool.connect();
    let result;
    try {
      result = await cleanup.execute(c, ids, bk, { approvedBy: 'QA reviewer', confirm: cleanup.CONFIRM_PHRASE(3) });
    } finally { c.release(); }
    expect(result.deleted).toEqual({ headers: 3, lines: 6, legacy_lines: 0 });
    expect(result.before.orphans - result.after.orphans).toBe(3);
    expect(await num(`SELECT COUNT(*)::int FROM journal_entries WHERE id = ANY($1::uuid[])`, [ids])).toBe(0);
    expect(await num(`SELECT COUNT(*)::int FROM journal_lines WHERE entry_id = ANY($1::uuid[])`, [ids])).toBe(0);
    expect(await num(`SELECT COUNT(*)::int FROM journal_entries WHERE id = ANY($1::uuid[])`, [keep])).toBe(1);
    expect(await realOrphans()).toBe(real - 3);
    // The off-list fixture orphan is this suite's to remove.
    const c2 = await pool.connect();
    try {
      await cleanup.execute(c2, keep, JSON.parse(JSON.stringify(await cleanup.backup(pool, keep))),
        { approvedBy: 'QA reviewer', confirm: cleanup.CONFIRM_PHRASE(1) });
    } finally { c2.release(); }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('SO-TRANSIT cleanup dry run', () => {
  it('writes nothing', async () => {
    const counts = () => one(`SELECT (SELECT COUNT(*)::int FROM sales_orders WHERE order_number LIKE 'SO-TRANSIT-%') so,
                                     (SELECT COUNT(*)::int FROM shipments WHERE dispatch_ref LIKE 'DSP-REF-%') sh,
                                     (SELECT COUNT(*)::int FROM route_stops) rs`);
    const before = await counts();
    let out = '';
    try {
      out = execFileSync(process.execPath, [resolve(here, '../../scripts/reconciliation/transit-orders-cleanup.mjs'), 'dry-run'],
        { encoding: 'utf8', env: { ...process.env } });
    } catch (e) { out = String(e.stdout || ''); }                          // exit 1 = not safe; the report still prints
    const report = JSON.parse(out.slice(out.indexOf('{')));
    expect(report.mode).toMatch(/dry-run/);
    expect(await counts()).toEqual(before);
  }, 60_000);
});
