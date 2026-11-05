/**
 * e2e-fx-fixture.mjs — throwaway data for the §215 exchange-rate browser test.
 *
 *   node scripts/e2e-fx-fixture.mjs setup     → creates, prints fenced JSON
 *   node scripts/e2e-fx-fixture.mjs teardown  → deletes everything it made
 *
 * One company (code ZZFXE2E), two admin logins (an enterer and an approver),
 * two vendors, one SENT RFQ with a USD and an INR quote, one DRAFT USD rate
 * entered by the enterer, and one DRAFT EUR rate entered by the approver (to
 * show the self-approval guard). Nothing outside that company is touched;
 * teardown sweeps by company code, so a crashed run is cleaned by the next one.
 * ⚠ Uses no PO sequence (the test does not award).
 */
const { default: pool } = await import('../src/config/db.js');
const { syncPrimaryRole } = await import('../src/services/userRoles.js');

const CODE = 'ZZFXE2E';
const MAIL = 'zzfxe2e.';

async function teardown() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [CODE]);
  const co = rows.map(r => r.id);
  const users = `SELECT id FROM users WHERE email LIKE '${MAIL}%@example.com'`;
  if (co.length) {
    const rfqs = `(SELECT id FROM rfqs WHERE company_id = ANY($1))`;
    await pool.query(`DELETE FROM rfq_quotes WHERE rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM rfq_items WHERE rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM rfqs WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM forex_rate_history WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM forex_rates WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM procurement_settings WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1)`, [co]).catch(() => {});
    await pool.query(`DELETE FROM vendors WHERE company_id = ANY($1)`, [co]);
  }
  await pool.query(`DELETE FROM audit_logs WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM access_denials WHERE user_id IN (${users})`).catch(() => {});
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE '${MAIL}%@example.com'`);
  if (co.length) await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [co]);
}

async function setup() {
  await teardown();
  const co = (await pool.query(`INSERT INTO companies (name, code) VALUES ('ZZ FX E2E Co', $1) RETURNING id`, [CODE])).rows[0].id;
  const user = async (key) => {
    const email = `${MAIL}${key}@example.com`;
    const id = (await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
       VALUES ($1, $2, 'not-a-login', 'admin', true, $3) RETURNING id`, [`ZZ FX ${key}`, email, co])).rows[0].id;
    await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1, $2, true)`, [id, co]);
    await syncPrimaryRole(id, 'admin', co);
    return { id, email };
  };
  const enterer = await user('enterer');
  const approver = await user('approver');
  const vendor = async (name) => (await pool.query(
    `INSERT INTO vendors (vendor_name, company_id) VALUES ($1, $2) RETURNING id`, [name, co])).rows[0].id;
  const vUsd = await vendor('ZZ FX US Supplier');
  const vInr = await vendor('ZZ FX IN Supplier');
  const rfq = (await pool.query(
    `INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id)
     VALUES ('ZZFXE2E-RFQ-1', 'ZZ FX test part', 100, 'responses_received', $1) RETURNING id`, [co])).rows[0].id;
  await pool.query(`INSERT INTO rfq_items (rfq_id, item_name, quantity) VALUES ($1, 'ZZ FX test part', 100)`, [rfq]);
  const q = async (v, unit, total, cur) => (await pool.query(
    `INSERT INTO rfq_quotes (rfq_id, vendor_id, unit_price, total_amount, currency, payment_terms, delivery_days)
     VALUES ($1, $2, $3, $4, $5, 'Net 30', 14) RETURNING id`, [rfq, v, unit, total, cur])).rows[0].id;
  const quoteUsd = await q(vUsd, 10, 1000, 'USD');
  const quoteInr = await q(vInr, 900, 90000, 'INR');
  const rate = async (code, r, by) => (await pool.query(
    `INSERT INTO forex_rate_history (company_id, currency_code, rate_vs_inr, rate_date, source, status, entered_by_user_id)
     VALUES ($1, $2, $3, CURRENT_DATE, 'rbi', 'draft', $4) RETURNING id`, [co, code, r, by])).rows[0].id;
  const usdRateId = await rate('USD', 84.5, enterer.id);
  const eurRateId = await rate('EUR', 96.25, approver.id);
  return { company_id: co, enterer, approver, vendors: { usd: vUsd, inr: vInr }, rfq_id: rfq,
           rfq_number: 'ZZFXE2E-RFQ-1', quotes: { usd: quoteUsd, inr: quoteInr }, rates: { usd: usdRateId, eur: eurRateId } };
}

try {
  const cmd = process.argv[2];
  if (cmd === 'setup') {
    const out = await setup();
    console.log(`---E2E_FX_BEGIN---\n${JSON.stringify(out)}\n---E2E_FX_END---`);
  } else if (cmd === 'teardown') {
    await teardown();
    console.log('---E2E_FX_BEGIN---\n{"ok":true}\n---E2E_FX_END---');
  } else {
    throw new Error('usage: e2e-fx-fixture.mjs setup|teardown');
  }
} finally {
  await pool.end();
}
