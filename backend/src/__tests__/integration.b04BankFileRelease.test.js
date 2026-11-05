/**
 * PC-02b-0 B-04 — bank-file security and lifecycle (manual §237).
 *
 *   - release and download need finance:approve, and the batch's company;
 *   - only Finance-verified vendor_bank_details of the batch's company; one bad
 *     line refuses the whole release, with every problem listed;
 *   - release is atomic: snapshot, content, hash, file and audit together;
 *   - released files are immutable; downloads serve the stored bytes after a hash
 *     check and never regenerate them, whatever later happens to the vendor;
 *   - processing requires the released file and proves it against the exact batch;
 *   - events are company-scoped and name the acting user; batch reads show
 *     metadata only.
 *
 * Real routers and database; two throwaway companies — all removed afterwards.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }             = await import('../config/db.js');
const { verifyToken }               = await import('../middlewares/auth.middleware.js');
const { buildApp }                  = await import('./helpers/testApp.js');
const { createIsolatedCompany, dropIsolatedCompany, leftoverCompanies, addUser } = await import('./helpers/isolatedCompany.js');
const { paymentGlFixture, verifiedVendorFixture, dropBeneficiaryFixtures, withBankFileTriggerSkipped } = await import('./helpers/paymentGlFixture.js');
const { default: financeRoutes }    = await import('../modules/finance/routes/extended.routes.js');
const { default: paymentBatchService } = await import('../modules/finance/services/paymentBatch.service.js');

const app = buildApp(['/api/finance', verifyToken, financeRoutes]);

const PREFIX = 'ZZB04';
let co, other, today, bank, good;
const U = {};
const call = (who, method, path) => request(app)[method](path).set('Authorization', `Bearer ${who.token()}`);
const base = '/api/finance/payment-batches';
const release = (who, id, format) => call(who, 'post', `${base}/${id}/release`).send(format ? { format } : {});
const download = (who, id, q = '') => call(who, 'get', `${base}/${id}/bank-file${q}`).buffer(true).parse((res, cb) => {
  const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const process_ = (who, id) => call(who, 'post', `${base}/${id}/process`).send({});

async function sweep(companyId) {
  const q = (sql) => pool.query(sql, [companyId]);
  await dropBeneficiaryFixtures(pool, [companyId]);
  await q(`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE company_id = $1)`);
  await q(`UPDATE payment_batch_items SET payment_id = NULL WHERE batch_id IN (SELECT id FROM payment_batches WHERE company_id = $1)`);
  await q(`DELETE FROM bank_transactions WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE company_id = $1)`);
  await q(`DELETE FROM payments WHERE company_id = $1`);
  await q(`DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE company_id = $1)`);
  await q(`DELETE FROM journal_entries WHERE company_id = $1`);
  await q(`DELETE FROM payment_batch_items WHERE batch_id IN (SELECT id FROM payment_batches WHERE company_id = $1)`);
  await q(`DELETE FROM payment_batches WHERE company_id = $1`);
  await q(`DELETE FROM parties WHERE company_id = $1`);
  await q(`DELETE FROM bank_accounts WHERE company_id = $1`);
  await q(`DELETE FROM company_settings WHERE company_id = $1`);
}

/** Create → submit → approve through the API; returns the batch id. */
async function approved(items, { bankId = bank, maker = U.maker, checker = U.checker } = {}) {
  const c = await call(maker, 'post', base).send({ batch_date: today, bank_account_id: bankId, items });
  if (c.status !== 201) throw new Error(`create ${c.status} ${JSON.stringify(c.body)}`);
  await call(maker, 'post', `${base}/${c.body.id}/submit`);
  const a = await call(checker, 'post', `${base}/${c.body.id}/approve`);
  if (a.status !== 200) throw new Error(`approve ${a.status} ${JSON.stringify(a.body)}`);
  return c.body.id;
}
const fileOf = async (id) => (await pool.query(`SELECT * FROM payment_batch_files WHERE batch_id = $1`, [id])).rows[0];
const auditOf = async (id) => (await pool.query(
  `SELECT user_id, action_type, company_id, reference_type, new_data_json FROM audit_logs
    WHERE reference_id = $1 AND reference_type = 'payment_batch' ORDER BY id`, [String(id)])).rows;
const writes = async (id) => (await pool.query(
  `SELECT (SELECT COUNT(*) FROM payments WHERE company_id = $2)::int AS payments,
          (SELECT COUNT(*) FROM journal_entries WHERE company_id = $2 AND reference_type = 'payment')::int AS journals,
          (SELECT COUNT(*) FROM bank_transactions t JOIN bank_accounts a ON a.id = t.bank_account_id WHERE a.company_id = $2)::int AS bank_txns,
          (SELECT status FROM payment_batches WHERE id = $1) AS status`, [id, co.companyId])).rows[0];
/** Swap a stored file: test database only, past the trigger that stops any edit. */
async function replaceFile(id, change) {
  const f = await fileOf(id);
  const n = { ...f, ...change(f) };
  await withBankFileTriggerSkipped(pool, async (client) => {
    await client.query(`DELETE FROM payment_batch_files WHERE batch_id = $1`, [id]);
    await client.query(
      `INSERT INTO payment_batch_files (batch_id, company_id, format, file_name, content, sha256, line_count, total_amount, beneficiaries, released_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [n.batch_id, n.company_id, n.format, n.file_name, n.content, n.sha256, n.line_count, n.total_amount, JSON.stringify(n.beneficiaries), n.released_by]);
  });
}

beforeAll(async () => {
  for (const id of await leftoverCompanies(pool, PREFIX)) { await sweep(id); await dropIsolatedCompany(pool, id); }
  co = await createIsolatedCompany(pool, PREFIX);
  other = await createIsolatedCompany(pool, `${PREFIX}X`);
  ({ rows: [{ d: today }] } = await pool.query(`SELECT CURRENT_DATE::text AS d`));
  U.maker = await addUser(pool, co, { label: 'r_maker', roleCode: 'accounts_exec' });
  U.checker = await addUser(pool, co, { label: 'r_checker', roleCode: 'finance_manager' });
  U.processor = await addUser(pool, co, { label: 'r_processor', roleCode: 'finance_manager' });
  U.fmB = await addUser(pool, other, { label: 'r_fmb', roleCode: 'finance_manager' });
  bank = await paymentGlFixture(pool, co.companyId, U.checker.userId);
  good = await verifiedVendorFixture(pool, co.companyId, { name: 'ZZ Good Supplier' });
}, 60000);

afterAll(async () => {
  for (const c of [co, other]) if (c) { await sweep(c.companyId); await dropIsolatedCompany(pool, c.companyId); }
});

describe('permissions and company scope', () => {
  it('finance:view alone can neither release nor download, and that is decided by the server', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 100 }]);
    expect((await call(U.maker, 'get', `${base}/${id}`)).status).toBe(200);
    expect((await release(U.maker, id)).status).toBe(403);
    expect(await fileOf(id)).toBeUndefined();
    expect((await release(U.checker, id)).status).toBe(201);
    expect((await download(U.maker, id)).status).toBe(403);
    expect((await auditOf(id)).map(a => a.action_type)).toEqual(['BANK_FILE_RELEASED']);
  });

  it('another company\'s approver gets the same 404 as a missing batch, and writes nothing', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 100 }]);
    expect((await release(U.fmB, id)).status).toBe(404);
    expect(await fileOf(id)).toBeUndefined();
    expect((await release(U.checker, id)).status).toBe(201);
    expect((await download(U.fmB, id)).status).toBe(404);
    expect((await call(U.fmB, 'get', `${base}/${id}`)).status).toBe(404);
    expect((await auditOf(id)).map(a => a.action_type)).toEqual(['BANK_FILE_RELEASED']);
    expect((await release(U.checker, '999999999')).status).toBe(404);
    expect((await download(U.checker, 'abc')).status).toBe(404);
  });

  it('batch reads and the release response carry metadata only, never the snapshot or content', async () => {
    const v = await verifiedVendorFixture(pool, co.companyId, { name: 'ZZ Meta Supplier' });
    const id = await approved([{ supplier_id: v.vendorId, amount: 321.5 }]);
    const r = await release(U.checker, id, 'icici');
    expect(r.status).toBe(201);
    const list = await call(U.maker, 'get', base);
    const one = await call(U.maker, 'get', `${base}/${id}`);
    const summary = list.body.find(b => b.id === id);
    expect(one.body.bank_file.sha256).toBe((await fileOf(id)).sha256);
    expect(summary.bank_file.format).toBe('icici');
    for (const body of [r.body, one.body.bank_file, summary.bank_file]) {
      expect(Object.keys(body).sort()).toEqual(['file_name', 'format', 'line_count', 'released_at', 'released_by', 'sha256', 'total_amount']);
    }
    for (const text of [JSON.stringify(r.body), JSON.stringify(one.body), JSON.stringify(summary), JSON.stringify(await auditOf(id))]) {
      expect(text).not.toContain(v.account);
    }
  });
});

describe('verified beneficiaries only', () => {
  it('refuses the whole release if any line is bad, listing every problem without an account number', async () => {
    const cid = co.companyId;
    const unverified = await verifiedVendorFixture(pool, cid, { name: 'ZZ Unverified', verified: false });
    const { rows: [noDetail] } = await pool.query(`INSERT INTO vendors (vendor_name, company_id, status) VALUES ('ZZ No Detail', $1, 'active') RETURNING id`, [cid]);
    const foreignDetail = await verifiedVendorFixture(pool, cid, { name: 'ZZ Foreign Detail', detailCompanyId: other.companyId });
    const foreignVendor = await verifiedVendorFixture(pool, other.companyId, { name: 'ZZ Foreign Vendor' });
    const badAccount = await verifiedVendorFixture(pool, cid, { name: 'ZZ Bad Account', account: '12AB' });
    const badIfsc = await verifiedVendorFixture(pool, cid, { name: 'ZZ Bad IFSC', ifsc: 'NOPE' });
    const blocked = await verifiedVendorFixture(pool, cid, { name: 'ZZ Blocked', status: 'Blocked' });
    const deleted = await verifiedVendorFixture(pool, cid, { name: 'ZZ Deleted' });
    await pool.query(`UPDATE vendors SET deleted_at = NOW() WHERE id = $1`, [deleted.vendorId]);
    const newPrimary = await verifiedVendorFixture(pool, cid, { name: 'ZZ New Primary', isPrimary: false });
    await pool.query(`INSERT INTO vendor_bank_details (vendor_id, bank_name, account_number, ifsc, is_primary, finance_verified, company_id)
                      VALUES ($1, 'ZZ', '111122223333', 'HDFC0001234', true, false, $2)`, [newPrimary.vendorId, cid]);
    const ambiguous = await verifiedVendorFixture(pool, cid, { name: 'ZZ Ambiguous', isPrimary: false });
    await pool.query(`INSERT INTO vendor_bank_details (vendor_id, bank_name, account_number, ifsc, is_primary, finance_verified, company_id)
                      VALUES ($1, 'ZZ', '444455556666', 'HDFC0001234', false, true, $2)`, [ambiguous.vendorId, cid]);

    const bad = [
      [unverified.vendorId, /No Finance-verified/],
      [noDetail.id, /No Finance-verified/],
      [foreignDetail.vendorId, /No Finance-verified/],
      [foreignVendor.vendorId, /not a vendor of this company/],
      [badAccount.vendorId, /9 to 18 digits/],
      [badIfsc.vendorId, /IFSC/],
      [blocked.vendorId, /inactive or blocked/],
      [deleted.vendorId, /not a vendor of this company/],
      [newPrimary.vendorId, /primary bank detail is not Finance-verified/],
      [ambiguous.vendorId, /none is primary/],
      [null, /no supplier/],
    ];
    const id = await approved([{ supplier_id: good.vendorId, amount: 100 }, ...bad.map(([v]) => ({ supplier_id: v, supplier_name: 'ZZ Line', amount: 10 }))]);
    const { rows: lines } = await pool.query(`SELECT id, supplier_id FROM payment_batch_items WHERE batch_id = $1`, [id]);

    const r = await release(U.checker, id);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('BENEFICIARY_INVALID');
    expect(r.body.problems).toHaveLength(bad.length);
    for (const [vendorId, reason] of bad) {
      const line = lines.find(l => l.supplier_id === vendorId);
      expect(r.body.problems.find(p => p.item_id === line.id).reason).toMatch(reason);
    }
    const text = JSON.stringify(r.body);
    for (const secret of [unverified.account, foreignDetail.account, foreignVendor.account, good.account, '111122223333']) expect(text).not.toContain(secret);
    expect(await fileOf(id)).toBeUndefined();
    expect(await auditOf(id)).toEqual([]);
  });

  it('uses the verified bank detail, not the live vendors columns or the line\'s typed name', async () => {
    const v = await verifiedVendorFixture(pool, co.companyId, { name: 'ZZ Master Name' });
    await pool.query(`UPDATE vendors SET account_number = '777788889999', ifsc = 'FAKE0000000' WHERE id = $1`, [v.vendorId]);
    const id = await approved([{ supplier_id: v.vendorId, supplier_name: 'Typed Name', amount: 100 }]);
    expect((await release(U.checker, id)).status).toBe(201);
    const { content, beneficiaries } = await fileOf(id);
    expect(content).toContain(v.account);
    expect(content).toContain('ZZ Master Name');
    expect(content).not.toContain('777788889999');
    expect(content).not.toContain('Typed Name');
    expect(beneficiaries[0]).toMatchObject({ supplier_id: v.vendorId, vendor_bank_detail_id: v.detailId, account_number: v.account, ifsc: 'HDFC0001234', amount: '100.00' });
  });

  it('one verified account with no primary is accepted', async () => {
    const v = await verifiedVendorFixture(pool, co.companyId, { name: 'ZZ Sole Verified', isPrimary: false });
    const id = await approved([{ supplier_id: v.vendorId, amount: 75 }]);
    expect((await release(U.checker, id)).status).toBe(201);
  });
});

describe('release lifecycle', () => {
  it('only an approved batch releases; a seed-style "active" batch and a draft are refused', async () => {
    const c = await call(U.maker, 'post', base).send({ batch_date: today, bank_account_id: bank, items: [{ supplier_id: good.vendorId, amount: 10 }] });
    const r = await release(U.checker, c.body.id);
    expect([r.status, r.body.code]).toEqual([409, 'BATCH_NOT_APPROVED']);
    const { rows: [seed] } = await pool.query(
      `INSERT INTO payment_batches (batch_number, batch_date, status, company_id, bank_account_id, total_amount) VALUES ($1, CURRENT_DATE, 'active', $2, $3, 0) RETURNING id`,
      [`ZZB04-S${Date.now()}`, co.companyId, bank]);
    expect((await release(U.checker, seed.id)).body.code).toBe('BATCH_NOT_APPROVED');
    expect((await download(U.checker, seed.id)).body.toString()).toContain('FILE_NOT_RELEASED');
    expect(await fileOf(seed.id)).toBeUndefined();
  });

  it('refuses an unknown format, a total that disagrees with the lines, and a missing bank account', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 10 }]);
    const f = await release(U.checker, id, 'axis');
    expect([f.status, f.body.code]).toEqual([400, 'FORMAT_INVALID']);
    await pool.query(`UPDATE payment_batches SET total_amount = 11 WHERE id = $1`, [id]);
    const t = await release(U.checker, id);
    expect([t.status, t.body.code]).toEqual([422, 'BATCH_TOTAL_MISMATCH']);
    await pool.query(`UPDATE payment_batches SET total_amount = 10, bank_account_id = NULL WHERE id = $1`, [id]);
    expect((await release(U.checker, id)).body.code).toBe('BANK_ACCOUNT_REQUIRED');
    expect(await fileOf(id)).toBeUndefined();
  });

  it('is atomic: an audit failure after the file insert leaves no file and no event', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 10 }]);
    // The audit insert, the last write of the transaction, fails on the release's own client.
    const realConnect = pool.connect.bind(pool);
    let wrapped;
    const spy = vi.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      wrapped = await realConnect();
      const realQuery = wrapped.query.bind(wrapped);
      wrapped.query = (sql, ...rest) => (/INSERT INTO audit_logs/.test(sql) ? Promise.reject(new Error('audit write failed')) : realQuery(sql, ...rest));
      return wrapped;
    });
    try {
      await expect(paymentBatchService.releaseBankFile(id, 'generic', co.companyId, { userId: U.checker.userId }))
        .rejects.toThrow('audit write failed');
    } finally {
      spy.mockRestore();
      if (wrapped) delete wrapped.query;
    }
    expect(await fileOf(id)).toBeUndefined();
    expect(await auditOf(id)).toEqual([]);
    expect((await release(U.checker, id)).status).toBe(201);          // nothing left behind to block a retry
  });

  it('releases once: two simultaneous calls give one file and one event; a later call cannot replace it', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 10 }]);
    const res = await Promise.all([release(U.checker, id, 'sbi'), release(U.processor, id, 'hdfc')]);
    expect(res.map(r => r.status).sort()).toEqual([201, 409]);
    expect(res.find(r => r.status === 409).body.code).toBe('FILE_ALREADY_RELEASED');
    const f = await fileOf(id);
    expect((await auditOf(id)).filter(a => a.action_type === 'BANK_FILE_RELEASED')).toHaveLength(1);
    expect((await release(U.checker, id, 'icici')).status).toBe(409);
    expect((await fileOf(id)).sha256).toBe(f.sha256);
  });

  it('the event is company-scoped and names the acting user, with metadata only', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 10.5 }]);
    await release(U.processor, id, 'hdfc');
    const [a] = await auditOf(id);
    const f = await fileOf(id);
    expect(a).toMatchObject({ action_type: 'BANK_FILE_RELEASED', company_id: co.companyId, reference_type: 'payment_batch' });
    expect(Number(a.user_id)).toBe(U.processor.userId);
    expect(f.released_by).toBe(U.processor.userId);
    expect(f.company_id).toBe(co.companyId);
    expect(Object.keys(a.new_data_json).sort()).toEqual(['batch_number', 'file_name', 'format', 'line_count', 'sha256', 'total_amount']);
    expect(JSON.stringify(a)).not.toContain(good.account);
  });

  it('renders each bank format, with a beneficiary name defused for spreadsheets', async () => {
    const v = await verifiedVendorFixture(pool, co.companyId, { name: '=HYPERLINK("x"),Ltd' });
    for (const [format, header] of [
      ['generic', 'Party Name,Account Number'], ['sbi', 'PRODUCT_CODE,PAYMENT_AMT'],
      ['hdfc', 'PAYMENT TYPE,AMOUNT'], ['icici', 'Beneficiary Name,Beneficiary Account No'],
    ]) {
      const id = await approved([{ supplier_id: v.vendorId, amount: 1250.5 }]);
      expect((await release(U.checker, id, format)).status).toBe(201);
      const { content, sha256, line_count, total_amount } = await fileOf(id);
      const [head, row, ...rest] = content.split('\n');
      expect(head.startsWith(header)).toBe(true);
      expect(rest).toEqual([]);
      expect(row).toContain('1250.50');
      expect(row).toContain(v.account);
      expect(row).not.toMatch(/(^|,)"?=HYPERLINK/);
      expect(sha256).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
      expect([line_count, Number(total_amount)]).toEqual([1, 1250.5]);
    }
  });
});

describe('immutability', () => {
  it('the database refuses UPDATE, DELETE and TRUNCATE, and the batch cannot be deleted from under its file', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 10 }]);
    await release(U.checker, id);
    const before = await fileOf(id);
    for (const sql of [
      `UPDATE payment_batch_files SET content = 'x' WHERE batch_id = ${Number(id)}`,
      `UPDATE payment_batch_files SET released_by = released_by WHERE batch_id = ${Number(id)}`,
      `DELETE FROM payment_batch_files WHERE batch_id = ${Number(id)}`,
    ]) {
      await expect(pool.query(sql)).rejects.toThrow(/immutable/);
    }
    await expect(pool.query(`DELETE FROM payment_batches WHERE id = $1`, [id])).rejects.toThrow(/foreign key/);
    expect(await fileOf(id)).toEqual(before);
  });

  it('the old session setting opens nothing, on the role the application connects as', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 10 }]);
    await release(U.checker, id);
    const before = await fileOf(id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL pulse.allow_bank_file_purge = 'on'`);
      for (const sql of [`DELETE FROM payment_batch_files WHERE batch_id = ${Number(id)}`, `UPDATE payment_batch_files SET content = 'x' WHERE batch_id = ${Number(id)}`]) {
        await client.query('SAVEPOINT s');
        await expect(client.query(sql)).rejects.toThrow(/immutable/);
        await client.query('ROLLBACK TO SAVEPOINT s');
      }
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(await fileOf(id)).toEqual(before);
  });

  it('application code holds no bypass: neither the old setting nor a trigger skip, and no purge route', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.m?js$/.test(e.name) && /allow_bank_file_purge|session_replication_role|DISABLE TRIGGER|DELETE FROM payment_batch_files|UPDATE payment_batch_files/i.test(readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    for (const d of ['modules', 'shared', 'middlewares', 'routes', 'services']) {
      const dir = resolve(here, '..', d);
      if (existsSync(dir)) walk(dir);
    }
    expect(offenders).toEqual([]);
  });
});

describe('download serves the stored bytes', () => {
  it('repeat downloads are byte-identical to the stored file, verified by SHA-256, and each is audited', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 500 }]);
    await release(U.checker, id, 'sbi');
    const f = await fileOf(id);
    const a = await download(U.processor, id);
    const b = await download(U.checker, id);
    expect(a.status).toBe(200);
    expect(a.headers['content-type']).toMatch(/text\/csv/);
    expect(a.headers['content-disposition']).toContain(f.file_name);
    expect(a.headers['cache-control']).toBe('no-store');
    expect(a.headers['x-content-sha256']).toBe(f.sha256);
    expect(createHash('sha256').update(a.body).digest('hex')).toBe(f.sha256);
    expect(a.body.equals(Buffer.from(f.content, 'utf8'))).toBe(true);
    expect(b.body.equals(a.body)).toBe(true);
    const events = await auditOf(id);
    expect(events.map(e => e.action_type)).toEqual(['BANK_FILE_RELEASED', 'BANK_FILE_DOWNLOADED', 'BANK_FILE_DOWNLOADED']);
    expect(events.slice(1).map(e => Number(e.user_id))).toEqual([U.processor.userId, U.checker.userId]);
    expect(events.every(e => e.company_id === co.companyId)).toBe(true);
  });

  it('a different format is refused, not regenerated; an unreleased batch serves nothing', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 500 }]);
    expect((await download(U.checker, id)).status).toBe(409);
    await release(U.checker, id, 'sbi');
    const d = await download(U.checker, id, '?format=hdfc');
    expect(d.status).toBe(409);
    expect(d.body.toString()).toContain('FILE_FORMAT_FIXED');
    expect((await download(U.checker, id, '?format=sbi')).status).toBe(200);
  });

  it('live vendor changes after release change neither the download nor the payment', async () => {
    const v = await verifiedVendorFixture(pool, co.companyId, { name: 'ZZ Before Change' });
    const id = await approved([{ supplier_id: v.vendorId, amount: 60 }]);
    await release(U.checker, id);
    const before = (await download(U.checker, id)).body;
    await pool.query(`UPDATE vendor_bank_details SET account_number = '999988887777', ifsc = 'ICIC0009999', finance_verified = false WHERE id = $1`, [v.detailId]);
    await pool.query(`UPDATE vendors SET vendor_name = 'ZZ After Change', status = 'Blocked' WHERE id = $1`, [v.vendorId]);
    const after = await download(U.checker, id);
    expect(after.status).toBe(200);
    expect(after.body.equals(before)).toBe(true);
    expect(after.body.toString()).toContain(v.account);
    expect(after.body.toString()).not.toContain('999988887777');
    expect((await process_(U.processor, id)).status).toBe(200);
  });

  it('a hash mismatch serves nothing, records the failure, and blocks processing', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 90 }]);
    await release(U.checker, id);
    await replaceFile(id, f => ({ content: f.content.replace('90.00', '9000.00') }));
    const d = await download(U.checker, id);
    expect(d.status).toBe(409);
    expect(d.body.toString()).toContain('FILE_INTEGRITY_FAILED');
    expect(d.body.toString()).not.toContain('9000.00');
    expect((await auditOf(id)).map(a => a.action_type)).toEqual(['BANK_FILE_RELEASED', 'BANK_FILE_INTEGRITY_FAILED']);
    const before = await writes(id);
    const p = await process_(U.processor, id);
    expect([p.status, p.body.code]).toEqual([409, 'FILE_BATCH_MISMATCH']);
    expect(p.body.problems.join()).toMatch(/SHA-256/);
    expect(await writes(id)).toEqual(before);
  });
});

describe('processing validates the released file against the exact batch', () => {
  const refusedWith = async (id, code, pattern) => {
    const before = await writes(id);
    const p = await process_(U.processor, id);
    expect(p.body.code).toBe(code);
    if (pattern) expect(p.body.problems.join()).toMatch(pattern);
    expect(await writes(id)).toEqual(before);
    expect(before.status).toBe('approved');
  };

  it('no released file: refused, nothing written, and the batch stays approved', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 20 }]);
    await refusedWith(id, 'FILE_NOT_RELEASED');
  });

  it('a changed line amount is refused even when the batch total is kept in step', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 20 }, { supplier_id: good.vendorId, amount: 30 }]);
    await release(U.checker, id);
    const { rows: [l1, l2] } = await pool.query(`SELECT id FROM payment_batch_items WHERE batch_id = $1 ORDER BY id`, [id]);
    await pool.query(`UPDATE payment_batch_items SET amount = 25 WHERE id = $1`, [l1.id]);
    await pool.query(`UPDATE payment_batch_items SET amount = 25 WHERE id = $1`, [l2.id]);
    await refusedWith(id, 'FILE_BATCH_MISMATCH', /differs from the released file/);
  });

  it('a changed supplier on a line is refused', async () => {
    const swap = await verifiedVendorFixture(pool, co.companyId, { name: 'ZZ Swapped In' });
    const id = await approved([{ supplier_id: good.vendorId, amount: 20 }]);
    await release(U.checker, id);
    await pool.query(`UPDATE payment_batch_items SET supplier_id = $1 WHERE batch_id = $2`, [swap.vendorId, id]);
    await refusedWith(id, 'FILE_BATCH_MISMATCH', /differs from the released file/);
  });

  it('an added line, and a batch total out of step, are each refused', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 20 }]);
    await release(U.checker, id);
    await pool.query(`UPDATE payment_batches SET total_amount = 21 WHERE id = $1`, [id]);
    await refusedWith(id, 'FILE_BATCH_MISMATCH', /must equal the batch lines/);
    await pool.query(`UPDATE payment_batches SET total_amount = 20 WHERE id = $1`, [id]);
    await pool.query(`INSERT INTO payment_batch_items (batch_id, company_id, supplier_id, amount) VALUES ($1, $2, $3, 0.01)`, [id, co.companyId, good.vendorId]);
    await refusedWith(id, 'FILE_BATCH_MISMATCH', /1 line\(s\); the batch has 2/);
  });

  it('content changed with its hash recomputed still fails against the snapshot', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 20 }]);
    await release(U.checker, id);
    await replaceFile(id, f => {
      const content = f.content.replace(good.account, '123456789012');
      return { content, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
    });
    await refusedWith(id, 'FILE_BATCH_MISMATCH', /beneficiary snapshot/);
  });

  it('a matching file pays once; the batch cannot re-release and the file still downloads', async () => {
    const id = await approved([{ supplier_id: good.vendorId, amount: 40 }, { supplier_id: good.vendorId, amount: 2.25 }]);
    await release(U.checker, id);
    const before = await writes(id);
    const p = await process_(U.processor, id);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const after = await writes(id);
    expect(after.status).toBe('processed');
    expect(after.payments - before.payments).toBe(2);
    expect(after.journals - before.journals).toBe(2);
    expect((await release(U.checker, id)).body.code).toBe('BATCH_NOT_APPROVED');
    expect((await download(U.checker, id)).status).toBe(200);
  });
});
