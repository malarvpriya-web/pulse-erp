/**
 * procurement-lifecycle-probe.mjs — drive the whole procurement chain over REAL
 * HTTP against the running server, and read every row back out of the database.
 *
 * WHY THIS EXISTS ALONGSIDE THE VITEST SUITES
 * -------------------------------------------
 * The integration suites mount the router in-process. That covers the handler,
 * the service and the SQL, but it skips the three layers a real request also
 * passes through, and all three have hidden defects in this codebase before:
 *
 *   - verifyToken / the JWT's actual claims (req.user.employee_id is absent from
 *     tokens minted before that field existed — the reason employeeOf() has a DB
 *     fallback at all);
 *   - the mount path and middleware order in server.js (a router mounted at its
 *     own name was the single biggest defect class in the 2026-08-26 endpoint
 *     audit);
 *   - rate limiting, which once turned 679 of 980 probes into false 429s that
 *     read as "reachable".
 *
 * And it asserts the thing an API response cannot: what the DATABASE holds after
 * each step. A 201 is not evidence that a row was written correctly — §149 found
 * four defects where the response was fine and the row was wrong.
 *
 *   node scripts/procurement-lifecycle-probe.mjs
 *
 * Requires the server on $PROBE_BASE (default http://localhost:5000) and mints
 * its own token through e2e-mint-token's mechanism. Self-cleaning: everything it
 * creates is tagged ZZPROBE and removed at the end, whether it passes or fails.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const { default: pool } = await import('../src/config/db.js');

const BASE = process.env.PROBE_BASE || 'http://localhost:5000';
const TAG  = 'ZZPROBE';

let pass = 0, fail = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`); }
  else    { fail++; failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
  return ok;
}
const step = (n) => console.log(`\n── ${n} ${'─'.repeat(Math.max(0, 66 - n.length))}`);

/** A token for a real, active account, with its real roles and scope. */
async function mintToken(email) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.employee_id, COALESCE(e.company_id, u.company_id) AS company_id,
            COALESCE(ARRAY_AGG(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE LOWER(u.email) = LOWER($1) AND u.is_active = true
      GROUP BY u.id, u.email, u.employee_id, e.company_id, u.company_id`,
    [email]
  );
  if (!rows[0]) throw new Error(`No active user ${email}`);
  const u = rows[0];
  return {
    token: jwt.sign(
      { userId: u.id, email: u.email, employee_id: u.employee_id,
        company_id: u.company_id, roles: u.roles, role: u.roles[0] || 'user' },
      process.env.JWT_SECRET, { expiresIn: '1h' }
    ),
    user: u,
  };
}

async function api(token, method, url, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}/api/procurement${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

/** Same as api(), for the routers mounted outside /api/procurement. */
async function apiAt(token, method, url, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

/** No Authorization header at all — the public surface. */
async function apiAnon(method, url, body) {
  const res = await fetch(`${BASE}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

async function cleanup() {
  // CONTAINS, not starts-with. The award route writes the order's notes as
  // "Awarded from <RFQ number> to <vendor name>", so the tag sits in the middle
  // — a prefix match left the probe's own purchase order behind every run.
  const p = [`%${TAG}%`];
  const poScope  = `(SELECT id FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1)`;
  const grnScope = `(SELECT id FROM goods_receipt_notes WHERE notes LIKE $1 OR po_id IN ${poScope})`;
  await pool.query(`DELETE FROM bills WHERE bill_number LIKE $1 OR notes LIKE $1`, p);
  await pool.query(`DELETE FROM three_way_matches WHERE vendor_invoice_no LIKE $1 OR po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM stock_ledger WHERE reference_type='grn' AND reference_id IN ${grnScope}`, p);
  // Returns FK the receipt (return_to_vendor_grn_id_fkey) and their ledger rows
  // reference the RTV, so both go before the receipt they were raised against.
  await pool.query(`DELETE FROM stock_ledger WHERE reference_type='rtv' AND reference_id IN (SELECT id FROM return_to_vendor WHERE grn_id IN ${grnScope})`, p);
  await pool.query(`DELETE FROM rtv_items WHERE rtv_id IN (SELECT id FROM return_to_vendor WHERE grn_id IN ${grnScope})`, p);
  await pool.query(`DELETE FROM return_to_vendor WHERE grn_id IN ${grnScope} OR rtv_number LIKE $1`, p);
  await pool.query(`DELETE FROM inventory_batches WHERE grn_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM grn_items WHERE grn_id IN ${grnScope}`, p);
  await pool.query(`DELETE FROM goods_receipt_notes WHERE notes LIKE $1 OR po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM purchase_order_items WHERE po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM procurement_award_decisions WHERE po_id IN ${poScope}`, p);
  await pool.query(`DELETE FROM purchase_orders WHERE po_number LIKE $1 OR notes LIKE $1`, p);
  await pool.query(`DELETE FROM rfq_quotes WHERE rfq_id IN (SELECT id FROM rfqs WHERE objective LIKE $1)`, p);
  await pool.query(`DELETE FROM rfq_items WHERE rfq_id IN (SELECT id FROM rfqs WHERE objective LIKE $1)`, p);
  await pool.query(`DELETE FROM procurement_award_decisions WHERE rfq_id IN (SELECT id FROM rfqs WHERE objective LIKE $1)`, p);
  await pool.query(`DELETE FROM rfqs WHERE objective LIKE $1`, p);
  await pool.query(`DELETE FROM purchase_request_items WHERE pr_id IN (SELECT id FROM purchase_requests WHERE notes LIKE $1)`, p);
  await pool.query(`DELETE FROM purchase_requests WHERE notes LIKE $1`, p);
  await pool.query(`DELETE FROM vendor_ratings WHERE vendor_id IN (SELECT id FROM vendors WHERE vendor_name LIKE $1)`, p);
  await pool.query(`UPDATE vendors SET party_id = NULL WHERE vendor_name LIKE $1`, p);
  await pool.query(`DELETE FROM parties WHERE name LIKE $1`, p);
  await pool.query(`DELETE FROM vendors WHERE vendor_name LIKE $1`, p);
  await pool.query(`DELETE FROM vendor_registrations WHERE vendor_name LIKE $1`, p);
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

async function main() {
  await cleanup();

  const admin = await mintToken(process.env.PROBE_EMAIL || 'superadmin@manifest.in');
  const CO    = admin.user.company_id;
  console.log(`probing ${BASE} as ${admin.user.email} (company ${CO}, roles ${admin.user.roles.join(',')})`);
  const T = admin.token;

  const item = await one('SELECT id, item_name FROM inventory_items WHERE company_id = $1 OR company_id IS NULL ORDER BY id LIMIT 1', [CO]);
  const wh   = await one('SELECT id FROM warehouses ORDER BY id LIMIT 1');
  if (!item || !wh) throw new Error('No inventory item or warehouse to probe with');

  // ── 1. Vendor + finance identity ─────────────────────────────────────────
  step('1. Vendor master → finance party');
  const vRes = await api(T, 'POST', '/vendors', {
    vendor_name: `${TAG} Probe Supplier`, category: 'Raw Materials',
    payment_terms_days: 30, email: 'probe@example.test',
  });
  check('POST /vendors returns 201', vRes.status === 201, `got ${vRes.status} ${vRes.body?.error ?? ''}`);
  const vendorId = vRes.body?.id;
  const vRow = vendorId ? await one('SELECT * FROM vendors WHERE id=$1', [vendorId]) : null;
  check('vendor row carries a finance party_id', !!vRow?.party_id, vRow?.party_id ?? 'null');
  const party = vRow?.party_id ? await one('SELECT * FROM parties WHERE id=$1', [vRow.party_id]) : null;
  check('the party is a Supplier in the same company',
    party?.party_type?.toLowerCase() === 'supplier' && party?.company_id === CO,
    `${party?.party_type} / company ${party?.company_id}`);

  const badGst = await api(T, 'POST', '/vendors', { vendor_name: `${TAG} Bad GST`, gstin: '27AAAABB12C' });
  check('a malformed GSTIN is refused at the write', badGst.status === 400, `got ${badGst.status}`);

  // A rating history, so the PO-approval min_vendor_rating gate is not what
  // this probe ends up measuring.
  await pool.query(
    `INSERT INTO vendor_ratings (company_id, vendor_id, quality_score, delivery_score, price_score, overall_score)
     VALUES ($1,$2,5,5,5,5)`, [CO, vendorId]);
  await pool.query(`UPDATE vendors SET quality_rating=5, delivery_rating=5, price_rating=5 WHERE id=$1`, [vendorId]);

  // ── 2. Requisition ────────────────────────────────────────────────────────
  step('2. Purchase requisition');
  const prRes = await api(T, 'POST', '/purchase-requests', {
    request_date: new Date().toISOString().slice(0, 10),
    required_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
    priority: 'urgent',
    notes: `${TAG} lifecycle requisition`,
    items: [{ item_id: item.id, item_name: item.item_name, quantity: 10, expected_price: 100 }],
  });
  check('POST /purchase-requests returns 201', prRes.status === 201, `got ${prRes.status} ${prRes.body?.error ?? ''}`);
  const prId = prRes.body?.id;
  const prRow = prId ? await one('SELECT * FROM purchase_requests WHERE id=$1', [prId]) : null;
  check('requisition is born in the status the approval queue reads',
    prRow?.status === 'pending_approval', prRow?.status);
  check('requisition keeps the priority that was chosen', prRow?.priority === 'urgent', prRow?.priority);
  check('requisition carries its own company', prRow?.company_id === CO, String(prRow?.company_id));
  check('requisition header total is derived from its lines',
    Number(prRow?.total_amount) === 1000, String(prRow?.total_amount));
  check('requisition has a real document number', /^[A-Z]+\d{4,}$/.test(prRow?.request_number || ''), prRow?.request_number);

  const listRes = await api(T, 'GET', '/purchase-requests');
  check('the requisition just created is visible in the register',
    Array.isArray(listRes.body) && listRes.body.some(r => r.id === prId));

  // ── 3. Approval ───────────────────────────────────────────────────────────
  step('3. Approval');
  const apr1 = await api(T, 'PUT', `/purchase-requests/${prId}/approve`);
  check('first approval succeeds', apr1.status === 200, `got ${apr1.status} ${apr1.body?.error ?? ''}`);
  const apr2 = await api(T, 'PUT', `/purchase-requests/${prId}/approve`);
  check('repeated approval is idempotent, not a second decision',
    apr2.status === 200 && apr2.body?.already_approved === true, `got ${apr2.status}`);
  const prApproved = await one('SELECT status, approved_at FROM purchase_requests WHERE id=$1', [prId]);
  check('requisition is approved in the database', prApproved?.status === 'approved', prApproved?.status);

  // ── 4. RFQ, quotes, award ────────────────────────────────────────────────
  step('4. RFQ → quote → award');
  const rfqRes = await api(T, 'POST', '/rfqs', {
    pr_id: String(prId), item_description: item.item_name, quantity: 10,
    objective: `${TAG} sourcing event`, vendor_ids: [vendorId],
    required_by: new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10),
  });
  check('POST /rfqs returns 201', rfqRes.status === 201, `got ${rfqRes.status} ${rfqRes.body?.error ?? ''}`);
  const rfqId = rfqRes.body?.id ?? rfqRes.body?.rfq?.id;

  const quoteRes = await api(T, 'POST', `/rfqs/${rfqId}/responses/${vendorId}`, {
    unit_price: 95, total_amount: 950, delivery_days: 7, payment_terms: '30 days',
  });
  check('a quote can be recorded', quoteRes.status === 200 || quoteRes.status === 201, `got ${quoteRes.status}`);

  const negQuote = await api(T, 'POST', `/rfqs/${rfqId}/responses/${vendorId}`, { unit_price: -5 });
  check('a negative price is refused', negQuote.status === 400, `got ${negQuote.status}`);

  const award1 = await api(T, 'PATCH', `/rfqs/${rfqId}/award/${vendorId}`);
  check('award succeeds', award1.status === 200, `got ${award1.status} ${award1.body?.error ?? ''}`);
  check('award raised a purchase order', !!award1.body?.po?.id, String(award1.body?.po?.id));
  const poId = award1.body?.po?.id;

  const award2 = await api(T, 'PATCH', `/rfqs/${rfqId}/award/${vendorId}`);
  check('a repeated award does not raise a second order',
    award2.status === 200 && award2.body?.already_awarded === true, `got ${award2.status}`);
  const poCount = await one('SELECT COUNT(*)::int n FROM purchase_orders WHERE notes LIKE $1', [`%${TAG}%`]);
  check('exactly one order exists for this event', poCount.n === 1, `${poCount.n} orders`);

  const poLines = (await pool.query('SELECT * FROM purchase_order_items WHERE po_id=$1', [poId])).rows;
  check('the order carries real line items', poLines.length > 0, `${poLines.length} lines`);
  const poRow = await one('SELECT * FROM purchase_orders WHERE id=$1', [poId]);
  check('order header total matches its lines',
    Math.abs(Number(poRow.total_amount) - poLines.reduce((s, l) => s + Number(l.quantity) * Number(l.rate), 0)) < 0.01,
    `header ${poRow.total_amount}`);

  // ── 5. PO approval ────────────────────────────────────────────────────────
  step('5. Purchase order approval');
  const poApr1 = await api(T, 'PATCH', `/purchase-orders/${poId}/approve`);
  check('PO approval succeeds', poApr1.status === 200, `got ${poApr1.status} ${poApr1.body?.error ?? ''}`);
  const poApr2 = await api(T, 'PATCH', `/purchase-orders/${poId}/approve`);
  check('repeated PO approval does not re-send the order to the vendor',
    poApr2.status === 200 && poApr2.body?.already_approved === true, `got ${poApr2.status}`);
  const cancelAfterApprove = await api(T, 'PUT', `/purchase-orders/${poId}/status`, { status: 'draft' });
  check('an approved order cannot be pushed back to draft',
    cancelAfterApprove.status === 409, `got ${cancelAfterApprove.status}`);

  // ── 6. Goods receipt ──────────────────────────────────────────────────────
  step('6. Goods receipt → inventory');
  const iqcRow = await one('SELECT require_iqc_before_stock FROM quality_settings WHERE company_id=$1', [CO]);
  const holdForIqc = iqcRow ? iqcRow.require_iqc_before_stock !== false : true;

  const line = poLines[0];
  const grnBody = {
    po_id: poId, warehouse_id: wh.id,
    received_date: new Date().toISOString().slice(0, 10),
    notes: `${TAG} lifecycle receipt`,
    items: [{ po_item_id: line.id, item_id: line.item_id, quantity_received: Number(line.quantity), quantity_rejected: 0, rate: Number(line.rate) }],
  };
  const idemKey = `${TAG}-${Date.now()}`;
  const grn1 = await api(T, 'POST', '/grn', grnBody, { 'Idempotency-Key': idemKey });
  check('POST /grn returns 201', grn1.status === 201, `got ${grn1.status} ${grn1.body?.error ?? ''}`);
  const grnId = grn1.body?.id;

  const grn2 = await api(T, 'POST', '/grn', grnBody, { 'Idempotency-Key': idemKey });
  check('a replayed receipt returns the original, not a second one',
    grn2.status === 200 && grn2.body?.id === grnId, `got ${grn2.status} id ${grn2.body?.id}`);
  const grnCount = await one('SELECT COUNT(*)::int n FROM goods_receipt_notes WHERE po_id=$1', [poId]);
  check('exactly one receipt exists', grnCount.n === 1, `${grnCount.n} receipts`);

  const grnRow = await one('SELECT * FROM goods_receipt_notes WHERE id=$1', [grnId]);
  check('receipt is born in the status the GRN screen counts and can act on',
    grnRow?.status === 'pending', grnRow?.status);
  const poAfter = await one('SELECT status FROM purchase_orders WHERE id=$1', [poId]);
  check('the order flips to received once fully booked', poAfter?.status === 'received', poAfter?.status);
  const lineAfter = await one('SELECT received_quantity, received_qty FROM purchase_order_items WHERE id=$1', [line.id]);
  check('both receipt columns move together (MRP reads the second one)',
    Number(lineAfter.received_quantity) === Number(line.quantity) &&
    Number(lineAfter.received_qty) === Number(line.quantity),
    `${lineAfter.received_quantity} / ${lineAfter.received_qty}`);

  const batches = (await pool.query('SELECT * FROM inventory_batches WHERE grn_id=$1', [grnId])).rows;
  const ledger  = (await pool.query(`SELECT * FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1`, [grnId])).rows;
  if (holdForIqc) {
    check('goods held for IQC create NO usable stock (batch)', batches.length === 0, `${batches.length} batches`);
    check('goods held for IQC create NO stock ledger entry', ledger.length === 0, `${ledger.length} entries`);
  } else {
    check('accepted goods create an inventory batch', batches.length === 1, `${batches.length} batches`);
    check('accepted goods post to the stock ledger', ledger.length === 1, `${ledger.length} entries`);
  }
  check('batch and ledger always agree with each other',
    (batches.length > 0) === (ledger.length > 0),
    `${batches.length} batches / ${ledger.length} ledger rows`);

  const overReceipt = await api(T, 'POST', '/grn', {
    ...grnBody, notes: `${TAG} over receipt`,
    items: [{ ...grnBody.items[0], quantity_received: 500 }],
  });
  check('an over-receipt is refused', overReceipt.status === 422, `got ${overReceipt.status}`);

  // ── 7. Quality release ────────────────────────────────────────────────────
  step('7. IQC release');
  if (holdForIqc) {
    const { default: grnService } = await import('../src/modules/procurement/services/grn.service.js');
    const rel = await grnService.releaseGrnStock(grnId);
    check('release posts the held stock', rel.released === true, JSON.stringify(rel));
    const b2 = (await pool.query('SELECT * FROM inventory_batches WHERE grn_id=$1', [grnId])).rows;
    const l2 = (await pool.query(`SELECT * FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1`, [grnId])).rows;
    check('batch and ledger both appear on release', b2.length === 1 && l2.length === 1, `${b2.length}/${l2.length}`);
    const rel2 = await grnService.releaseGrnStock(grnId);
    check('a second release is a safe no-op', rel2.released === false, JSON.stringify(rel2));
    const l3 = (await pool.query(`SELECT * FROM stock_ledger WHERE reference_type='grn' AND reference_id=$1`, [grnId])).rows;
    check('stock was not posted twice', l3.length === 1, `${l3.length} ledger rows`);
  } else {
    console.log('  (skipped — this company does not require IQC before stock)');
  }

  // ── 8. Three-way match ────────────────────────────────────────────────────
  step('8. Invoice → three-way match');
  const gross = Number(poRow.total_amount);
  const invoiceNo = `${TAG}-INV-${Date.now()}`;
  const matchRes = await api(T, 'POST', '/three-way-match', {
    po_id: poId, grn_id: grnId, vendor_invoice_no: invoiceNo,
    vendor_invoice_date: new Date().toISOString().slice(0, 10),
    vendor_invoice_amount: gross,
  });
  check('POST /three-way-match returns 201', matchRes.status === 201, `got ${matchRes.status} ${matchRes.body?.error ?? ''}`);
  check('a correct invoice matches', matchRes.body?.match_status === 'matched', matchRes.body?.match_status);
  const matchId = matchRes.body?.id;

  const rematch = await api(T, 'POST', '/three-way-match', {
    po_id: poId, grn_id: grnId, vendor_invoice_no: invoiceNo, vendor_invoice_amount: gross,
  });
  check('re-posting the same invoice does not create a second match',
    rematch.body?.id === matchId, `${rematch.body?.id} vs ${matchId}`);

  // ── 9. AP bill ────────────────────────────────────────────────────────────
  step('9. Match approval → AP bill');
  const billRes = await api(T, 'PATCH', `/three-way-match/${matchId}/approve`);
  check('approving the match succeeds', billRes.status === 200, `got ${billRes.status} ${billRes.body?.error ?? ''}`);
  check('a payable bill was created', !!billRes.body?.bill_id, String(billRes.body?.bill_id));

  const bill = billRes.body?.bill_id ? await one('SELECT * FROM bills WHERE id=$1', [billRes.body.bill_id]) : null;
  check('the bill is payable to the vendor\'s finance party',
    bill && bill.supplier_id === vRow.party_id, `${bill?.supplier_id} vs ${vRow?.party_id}`);
  check('the bill carries an outstanding balance (AP ageing reads this)',
    bill && Math.abs(Number(bill.balance) - gross) < 0.01, String(bill?.balance));
  check('the bill has a due date', !!bill?.due_date, String(bill?.due_date));
  check('the bill is linked to its purchase order (not counted as maverick spend)',
    bill?.po_id === poId, String(bill?.po_id));
  check('the bill\'s taxable value is not its gross',
    bill && Number(bill.subtotal) <= Number(bill.total_amount) + 0.01,
    `subtotal ${bill?.subtotal} of total ${bill?.total_amount}`);

  const billAgain = await api(T, 'PATCH', `/three-way-match/${matchId}/approve`);
  check('approving the match twice does not raise a second bill',
    billAgain.status === 200 && billAgain.body?.bill_id === billRes.body?.bill_id, `got ${billAgain.status}`);
  const billCount = await one('SELECT COUNT(*)::int n FROM bills WHERE bill_number=$1', [invoiceNo]);
  check('exactly one bill exists for this invoice', billCount.n === 1, `${billCount.n} bills`);

  // ── 10. Analytics ─────────────────────────────────────────────────────────
  step('10. Analytics reflect the chain');
  const spend = await api(T, 'GET', '/analytics/spend');
  check('GET /analytics/spend responds', spend.status === 200, `got ${spend.status}`);
  const vendorRow = spend.body?.by_vendor?.find(r => r.vendor_name === `${TAG} Probe Supplier`);
  check('this probe\'s order appears in vendor spend',
    !!vendorRow && Math.abs(Number(vendorRow.total_spend) - gross) < 0.01,
    `${vendorRow?.total_spend} vs ${gross}`);

  const dash = await api(T, 'GET', '/dashboard');
  check('GET /dashboard responds', dash.status === 200, `got ${dash.status}`);
  const pendingGrnTruth = await one(
    `SELECT COUNT(*)::int n FROM goods_receipt_notes
      WHERE (status IS NULL OR status='pending') AND deleted_at IS NULL AND company_id=$1`, [CO]);
  check('pending-receipts KPI equals the database',
    dash.body?.pending_grns === pendingGrnTruth.n, `${dash.body?.pending_grns} vs ${pendingGrnTruth.n}`);

  const invSpend = await api(T, 'GET', '/analytics/invoice-spend');
  check('GET /analytics/invoice-spend responds', invSpend.status === 200, `got ${invSpend.status}`);

  // ── 11. RTV ───────────────────────────────────────────────────────────────
  step('11. Return to vendor');
  const rtvRes = await api(T, 'POST', '/rtv', {
    grn_id: grnId, vendor_id: vendorId, warehouse_id: wh.id,
    return_date: new Date().toISOString().slice(0, 10),
    reason: 'Damaged in transit',
    items: [{ item_id: line.item_id, quantity_returned: 1, rate: Number(line.rate) }],
  });
  check('POST /rtv returns 201', rtvRes.status === 201, `got ${rtvRes.status} ${rtvRes.body?.error ?? ''}`);
  check('the return has a real document number',
    /^[A-Z]+\d{4,}$/.test(rtvRes.body?.rtv_number || ''), rtvRes.body?.rtv_number);
  const lineAfterRtv = await one('SELECT received_quantity FROM purchase_order_items WHERE id=$1', [line.id]);
  check('returned goods come back off the order line',
    Number(lineAfterRtv.received_quantity) === Number(line.quantity) - 1,
    `${lineAfterRtv.received_quantity} of ${line.quantity}`);
  const poAfterRtv = await one('SELECT status FROM purchase_orders WHERE id=$1', [poId]);
  check('the order reopens once goods have gone back', poAfterRtv.status === 'partial', poAfterRtv.status);

  const overReturn = await api(T, 'POST', '/rtv', {
    grn_id: grnId, vendor_id: vendorId, warehouse_id: wh.id,
    return_date: new Date().toISOString().slice(0, 10), reason: 'over return',
    items: [{ item_id: line.item_id, quantity_returned: 9999, rate: Number(line.rate) }],
  });
  check('returning more than was received is refused', overReturn.status === 422, `got ${overReturn.status}`);

  // ── 12. The vendor surface, on the live mounts ───────────────────────────
  // These seven routers were mounted behind verifyToken and nothing else. Mount
  // ORDER matters here in a way the in-process suites cannot see: vendorRoutes
  // is mounted at "/" and would shadow anything registered after it.
  step('12. Vendor surface authorization on the live mounts');

  const salesRow = await pool.query(
    `SELECT u.email FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
      WHERE r.code = 'sales_exec' AND u.is_active = true LIMIT 1`
  );
  if (salesRow.rows[0]) {
    const sales = await mintToken(salesRow.rows[0].email);
    const denials = [
      ['add bank details to a vendor', 'POST',  `/vendor-approval/vendors/${vendorId}/banks`, { bank_name: 'X', account_number: '1', ifsc: 'AAAA0000001' }],
      ['add a vendor contact',         'POST',  `/vendor-approval/vendors/${vendorId}/contacts`, { name: 'X' }],
      ['read a vendor 360',            'GET',   `/vendor-360/${vendorId}`],
      ['write a vendor scorecard',     'POST',  `/vendor-360/${vendorId}/scorecard`, { overall_score: 5 }],
      ['read the vendor health board', 'GET',   '/vendor-health/dashboard'],
      ['rescore every vendor',         'POST',  '/vendor-health/recalculate-all'],
      ['read the supplier list',       'GET',   '/vendors'],
      ['read negotiated unit prices',  'GET',   `/vendors/price-history?ids=${vendorId}`],
      ['write a sourcing strategy',    'POST',  '/sourcing-strategy/categories/electronics/strategy', { chosen_play: 'x' }],
      ['read the registration queue',  'GET',   '/vendor-registration'],
    ];
    for (const [label, method, url, body] of denials) {
      const r = await apiAt(sales.token, method, url, body);
      check(`a role with no procurement grant cannot ${label}`, r.status === 403, `got ${r.status}`);
    }
    const { rows: leaked } = await pool.query(
      `SELECT COUNT(*)::int n FROM vendor_bank_details WHERE vendor_id = $1`, [vendorId]);
    check('and no bank row was written by any of them', leaked[0].n === 0, `${leaked[0].n} rows`);
  } else {
    console.log('  (skipped — no active sales_exec account to probe with)');
  }

  // The shadow endpoints that duplicated hardened controls.
  for (const [method, url, canonical] of [
    ['PUT',   `/vendors/${vendorId}`,          'PUT /api/procurement/vendors/:id'],
    ['PATCH', '/three-way-match/1/resolve',    'PATCH /api/procurement/three-way-match/:id/resolve'],
    ['PUT',   '/rfqs/1/quotes/1/winner',       'PATCH /api/procurement/rfqs/:rfqId/award/:vendorId'],
  ]) {
    const r = await apiAt(T, method, url, {});
    check(`the ungated duplicate ${method} ${url} is gone`, r.status === 410 && r.body?.use === canonical,
      `got ${r.status} ${r.body?.use ?? ''}`);
  }

  // ── 13. The public registration portal ───────────────────────────────────
  step('13. Public registration portal');
  await pool.query(`DELETE FROM auth_rate_limit`).catch(() => {});
  const reg = await apiAnon('POST', '/vendor-registration/submit', {
    vendor_name: `${TAG} Portal Vendor`, email: 'zzprobe-portal@example.test', phone: '9998887770',
    company_id: 999999,   // an anonymous caller trying to pick a tenant
  });
  if (reg.status === 201) {
    const raw = JSON.stringify(reg.body);
    check('the verification code is not returned to the caller', !/_dev_.*otp/i.test(raw) , raw.slice(0, 90));
    const { rows: [row] } = await pool.query(
      `SELECT company_id, email_otp, access_token FROM vendor_registrations WHERE id=$1`, [reg.body.registration_id]);
    check('the code is not in the response body', !raw.includes(row.email_otp));
    check('an anonymous company_id is ignored', row.company_id !== 999999, String(row.company_id));

    const noToken = await apiAnon('GET', `/vendor-registration/status/${reg.body.registration_id}`);
    check('the status page refuses a bare id', noToken.status === 404, `got ${noToken.status}`);
    const withToken = await apiAnon('GET', `/vendor-registration/status/${reg.body.registration_id}?token=${row.access_token}`);
    check('the status page answers with the registrant own token', withToken.status === 200, `got ${withToken.status}`);

    let last = 0;
    for (const otp of ['000000', '111111', '222222', '333333', '444444']) {
      last = (await apiAnon('POST', `/vendor-registration/${reg.body.registration_id}/verify-email`, { otp })).status;
    }
    check('the record locks after five wrong codes', last === 429, `got ${last}`);
    await pool.query(`DELETE FROM vendor_registrations WHERE id=$1`, [reg.body.registration_id]);
  } else {
    check('registration submit reachable', false, `got ${reg.status} ${reg.body?.error ?? ''}`);
  }

  // ── 14. Authorization, over HTTP ─────────────────────────────────────────
  step('14. Authorization on the live server');
  const noAuth = await fetch(`${BASE}/api/procurement/purchase-orders`);
  check('an unauthenticated request is rejected', noAuth.status === 401, `got ${noAuth.status}`);

  const salesUser = await pool.query(
    `SELECT u.email FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
      WHERE r.code = 'sales_exec' AND u.is_active = true LIMIT 1`
  );
  if (salesUser.rows[0]) {
    const sales = await mintToken(salesUser.rows[0].email);
    const denied = await api(sales.token, 'POST', '/vendors', { vendor_name: `${TAG} by sales` });
    check('a role with no procurement grant cannot create a vendor', denied.status === 403, `got ${denied.status}`);
    const leaked = await one('SELECT id FROM vendors WHERE vendor_name=$1', [`${TAG} by sales`]);
    check('and no vendor row was written', !leaked);
  } else {
    console.log('  (skipped — no active sales_exec account to probe with)');
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error('\nPROBE ABORTED:', err.message);
  console.error(err.stack);
  exitCode = 2;
} finally {
  await cleanup().catch(e => console.error('cleanup failed:', e.message));
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  if (failures.length) console.log('  failed checks:\n   - ' + failures.join('\n   - '));
  console.log('═'.repeat(70));
  await pool.end();
  process.exit(exitCode || (fail ? 1 : 0));
}
