/**
 * e2e-quote-fixture.mjs — throwaway data for the §219 quote-entry browser test.
 *
 *   node scripts/e2e-quote-fixture.mjs setup | teardown
 *
 * Company ZZQEE2E: one admin login, two vendors INVITED to a sent, single-line
 * RFQ (empty quote rows, exactly what send-to-vendors creates), an approved
 * EUR rate so freight quoted in EUR can be restated. Rows are inserted with
 * literal numbers — no document sequence is consumed. Teardown removes only
 * this company's rows.
 */
const { default: pool } = await import('../src/config/db.js');
const { syncPrimaryRole } = await import('../src/services/userRoles.js');
const CODE = 'ZZQEE2E';
const MAIL = 'zzqee2e.';

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
    await pool.query(`DELETE FROM procurement_settings WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1)`, [co]).catch(() => {});
    await pool.query(`DELETE FROM inventory_items WHERE company_id = ANY($1)`, [co]);
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
  const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const co = (await one(`INSERT INTO companies (name, code) VALUES ('ZZ Quote E2E Co', $1) RETURNING id`, [CODE])).id;
  const email = `${MAIL}buyer@example.com`;
  const user = (await one(`INSERT INTO users (name, email, password_hash, role, is_active, company_id) VALUES ('ZZ QE buyer',$1,'not-a-login','admin',true,$2) RETURNING id`, [email, co])).id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [user, co]);
  await syncPrimaryRole(user, 'admin', co);
  const v1 = (await one(`INSERT INTO vendors (vendor_name, company_id) VALUES ('ZZ QE Alpha Supplier',$1) RETURNING id`, [co])).id;
  const v2 = (await one(`INSERT INTO vendors (vendor_name, company_id) VALUES ('ZZ QE Beta Supplier',$1) RETURNING id`, [co])).id;
  const item = (await one(`INSERT INTO inventory_items (item_code,item_name,company_id,unit_of_measure,standard_cost) VALUES ('ZZQE-1','ZZ QE part',$1,'NOS',100) RETURNING id`, [co])).id;
  const rfq = (await one(`INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id) VALUES ('ZZQEE2E-RFQ-1','ZZ QE part',100,'sent',$1) RETURNING id`, [co])).id;
  await pool.query(`INSERT INTO rfq_items (rfq_id, item_id, item_name, quantity, unit) VALUES ($1,$2,'ZZ QE part',100,'NOS')`, [rfq, item]);
  const q1 = (await one(`INSERT INTO rfq_quotes (rfq_id, vendor_id) VALUES ($1,$2) RETURNING id`, [rfq, v1])).id;
  const q2 = (await one(`INSERT INTO rfq_quotes (rfq_id, vendor_id) VALUES ($1,$2) RETURNING id`, [rfq, v2])).id;
  await pool.query(`INSERT INTO forex_rate_history (company_id,currency_code,rate_vs_inr,rate_date,source,status,approved_by_user_id,approved_at)
                    VALUES ($1,'EUR',96,CURRENT_DATE,'rbi','approved',$2,NOW())`, [co, user]);
  return { company_id: co, email, rfq_id: rfq, rfq_number: 'ZZQEE2E-RFQ-1', quotes: { alpha: q1, beta: q2 } };
}

try {
  const cmd = process.argv[2];
  if (cmd === 'setup') console.log(`---E2E_QE_BEGIN---\n${JSON.stringify(await setup())}\n---E2E_QE_END---`);
  else if (cmd === 'teardown') { await teardown(); console.log('---E2E_QE_BEGIN---\n{"ok":true}\n---E2E_QE_END---'); }
  else throw new Error('usage: e2e-quote-fixture.mjs setup|teardown');
} finally {
  await pool.end();
}
