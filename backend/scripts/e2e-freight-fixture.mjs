/**
 * e2e-freight-fixture.mjs — throwaway data for the §216 freight browser test.
 *
 *   node scripts/e2e-freight-fixture.mjs setup     → creates, prints fenced JSON
 *   node scripts/e2e-freight-fixture.mjs teardown  → deletes everything it made
 *
 * Company ZZFRE2E: a maker and an approver login (admin), a Bengaluru receiving
 * warehouse designated as the main receiving point, a Chennai vendor (no lane
 * yet — the test creates it in the UI) and a second vendor that never gets one,
 * an item WITH a shipping weight and one WITHOUT, price-book rows for Component
 * 360, a SENT RFQ with two quotes, and a DRAFT road rate card entered by the
 * maker (the approver approves it in the UI). Assumed freight is OFF so the
 * incomplete state is visible. Nothing outside this company is touched; the
 * test never awards, so no PO number is consumed.
 */
const { default: pool } = await import('../src/config/db.js');
const { syncPrimaryRole } = await import('../src/services/userRoles.js');

const CODE = 'ZZFRE2E';
const MAIL = 'zzfre2e.';

async function teardown() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = $1`, [CODE]);
  const co = rows.map(r => r.id);
  const users = `SELECT id FROM users WHERE email LIKE '${MAIL}%@example.com'`;
  if (co.length) {
    const rfqs = `(SELECT id FROM rfqs WHERE company_id = ANY($1))`;
    await pool.query(`DELETE FROM rfq_quotes WHERE rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM rfq_items WHERE rfq_id IN ${rfqs}`, [co]);
    await pool.query(`DELETE FROM rfqs WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM freight_lanes WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM freight_rate_cards WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM procurement_settings WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM item_vendor_prices WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM audit_logs WHERE company_id = ANY($1)`, [co]).catch(() => {});
    await pool.query(`DELETE FROM inventory_items WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM vendors WHERE company_id = ANY($1)`, [co]);
    await pool.query(`DELETE FROM warehouses WHERE company_id = ANY($1)`, [co]);
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
  const co = (await one(`INSERT INTO companies (name, code) VALUES ('ZZ Freight E2E Co', $1) RETURNING id`, [CODE])).id;
  const user = async (key) => {
    const email = `${MAIL}${key}@example.com`;
    const id = (await one(`INSERT INTO users (name, email, password_hash, role, is_active, company_id)
                           VALUES ($1,$2,'not-a-login','admin',true,$3) RETURNING id`, [`ZZ FR ${key}`, email, co])).id;
    await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [id, co]);
    await syncPrimaryRole(id, 'admin', co);
    return { id, email };
  };
  const maker = await user('maker');
  const approver = await user('approver');
  const wh = (await one(`INSERT INTO warehouses (name, warehouse_name, company_id, latitude, longitude)
                         VALUES ('ZZ FR Bengaluru DC','ZZ FR Bengaluru DC',$1,12.971599,77.594566) RETURNING id`, [co])).id;
  const vLane = (await one(`INSERT INTO vendors (vendor_name, company_id, city, state) VALUES ('ZZ FR Chennai Supplier',$1,'Chennai','Tamil Nadu') RETURNING id`, [co])).id;
  const vNone = (await one(`INSERT INTO vendors (vendor_name, company_id, city) VALUES ('ZZ FR Laneless Supplier',$1,'Nowhere') RETURNING id`, [co])).id;
  const item = async (code, cols) => {
    const all = { item_code: `ZZFR-${code}`, item_name: `ZZ FR ${code}`, company_id: co, unit_of_measure: 'NOS', standard_cost: 100, ...cols };
    const k = Object.keys(all);
    return (await one(`INSERT INTO inventory_items (${k.join(',')}) VALUES (${k.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, k.map(x => all[x]))).id;
  };
  const itemW = await item('WEIGHED', { shipping_weight_kg: 2.5, shipping_weight_basis: 'observed', shipping_weight_uom: 'NOS', freight_category: 'General' });
  const itemU = await item('UNWEIGHED', {});
  await pool.query(`INSERT INTO item_vendor_prices (item_id, vendor_id, unit_price, currency, company_id) VALUES ($1,$2,100,'INR',$4),($1,$3,90,'INR',$4)`,
    [itemW, vLane, vNone, co]);
  await pool.query(`INSERT INTO procurement_settings (company_id, main_receiving_warehouse_id, tco_assumed_freight_enabled) VALUES ($1,$2,false)`, [co, wh]);
  const rfq = (await one(`INSERT INTO rfqs (rfq_number, item_description, quantity, status, company_id)
                          VALUES ('ZZFRE2E-RFQ-1','ZZ FR weighed part',100,'responses_received',$1) RETURNING id`, [co])).id;
  await pool.query(`INSERT INTO rfq_items (rfq_id, item_id, item_name, quantity, unit) VALUES ($1,$2,'ZZ FR WEIGHED',100,'NOS')`, [rfq, itemW]);
  await pool.query(`INSERT INTO rfq_quotes (rfq_id, vendor_id, unit_price, total_amount, currency, payment_terms, delivery_days)
                    VALUES ($1,$2,100,10000,'INR','Net 30',10),($1,$3,90,9000,'INR','Net 30',10)`, [rfq, vLane, vNone]);
  const card = (await one(`INSERT INTO freight_rate_cards (company_id, transport_mode, freight_category, rate_per_tonne_km, currency, effective_from, source, status, entered_by_user_id)
                           VALUES ($1,'road','General',3,'INR',CURRENT_DATE - 1,'ZZ transporter contract','draft',$2) RETURNING id`, [co, maker.id])).id;
  return { company_id: co, maker, approver, warehouse_id: wh, vendors: { lane: vLane, none: vNone },
           items: { weighed: itemW, unweighed: itemU }, rfq_id: rfq, rfq_number: 'ZZFRE2E-RFQ-1', rate_card_id: card };
}

try {
  const cmd = process.argv[2];
  if (cmd === 'setup') console.log(`---E2E_FR_BEGIN---\n${JSON.stringify(await setup())}\n---E2E_FR_END---`);
  else if (cmd === 'teardown') { await teardown(); console.log('---E2E_FR_BEGIN---\n{"ok":true}\n---E2E_FR_END---'); }
  else throw new Error('usage: e2e-freight-fixture.mjs setup|teardown');
} finally {
  await pool.end();
}
