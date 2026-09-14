/**
 * PART 36 - controlled reconciliation chain, driven entirely through the live
 * HTTP API, then verified by reading the database directly.
 *   Lead -> Party -> Account -> Contact -> Opportunity -> Stage History
 *        -> Quotation -> Sales Order -> Invoice -> Receipt
 * Everything created is removed at the end.
 */
import dotenv from 'dotenv'; dotenv.config({ quiet: true });
import pg from 'pg';
import jwt from 'jsonwebtoken';

const pool = new pg.Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
const API = 'http://localhost:5000/api';
const u = await pool.query(`SELECT id, email, employee_id FROM users WHERE email='superadmin@manifest.in'`);
const tok = jwt.sign({ userId: u.rows[0].id, id: u.rows[0].id, email: u.rows[0].email,
  employee_id: u.rows[0].employee_id, company_id: 1, role: 'super_admin' },
  process.env.JWT_SECRET, { expiresIn: '15m' });

const call = async (method, path, body) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, text };
};

const TAG = 'ZZCHAIN';
const ids = {};
let failed = 0;
const check = (n, ok, d) => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`);
};

try {
  // 1 - Lead
  let r = await call('POST', '/crm/leads', {
    company_name: `${TAG} Recon Industries Pvt Ltd`,
    contact_person: 'Recon Tester',
    email: 'zzchain@recon.test',
    phone: '9000000001', lead_source: 'Manual', status: 'New', estimated_value: 500000,
  });
  ids.lead = r.json?.id ?? r.json?.lead?.id;
  check('Lead created', r.status < 300 && !!ids.lead, `id=${ids.lead} (${r.status}) ${r.status >= 300 ? r.text.slice(0, 140) : ''}`);

  // 2 - Convert: party + account + contact + opportunity, atomically
  r = await call('POST', `/crm/leads/${ids.lead}/convert`, { opportunity_name: `${TAG} Recon Deal`, expected_value: 500000 });
  ids.opp = r.json?.opportunity?.id ?? r.json?.id;
  check('Lead converted', r.status < 300 && !!ids.opp, `opportunity=${ids.opp} (${r.status}) ${r.status >= 300 ? r.text.slice(0, 140) : ''}`);

  if (ids.opp) {
    const q = await pool.query(
      `SELECT o.id opp, o.account_id, o.lead_id, a.party_id, p.name party_name,
              (SELECT count(*) FROM contacts c WHERE c.account_id = a.id AND c.deleted_at IS NULL)::int contacts,
              (SELECT count(*) FROM opportunity_stage_history h WHERE h.opportunity_id = o.id)::int history
         FROM opportunities o
         LEFT JOIN accounts a ON a.id = o.account_id
         LEFT JOIN parties  p ON p.id = a.party_id
        WHERE o.id = $1`, [ids.opp]);
    const row = q.rows[0] || {};
    ids.account = row.account_id; ids.party = row.party_id;
    check('  -> CRM account extension', !!row.account_id, `account_id=${row.account_id}`);
    check('  -> canonical party', !!row.party_id, `party=${row.party_id} "${row.party_name}"`);
    check('  -> contact', row.contacts > 0, `${row.contacts} contact(s)`);
    check('  -> lead back-reference', row.lead_id === ids.lead, `lead_id=${row.lead_id}`);
    check('  -> opening stage history', row.history > 0, `${row.history} row(s)`);
  }

  // 3 - Stage transition writes history
  r = await call('PATCH', `/crm/opportunities/${ids.opp}/stage`, { stage: 'Proposal', notes: `${TAG} moved for reconciliation` });
  const hist = await pool.query(
    `SELECT from_stage, to_stage, changed_by FROM opportunity_stage_history WHERE opportunity_id=$1 ORDER BY id DESC LIMIT 1`, [ids.opp]);
  check('Stage change -> history', r.status < 300 && hist.rows[0]?.to_stage === 'Proposal',
    `${hist.rows[0]?.from_stage} -> ${hist.rows[0]?.to_stage}, by user ${hist.rows[0]?.changed_by}`);

  // 4 - Quotation
  r = await call('POST', `/crm/opportunities/${ids.opp}/create-quotation`, {});
  ids.quote = r.json?.quotation?.id;
  check('Opportunity -> Quotation', r.status < 300 && !!ids.quote,
    `quotation=${r.json?.quotation?.quotation_number} (${r.status}) ${r.status >= 300 ? r.text.slice(0, 160) : ''}`);
  if (ids.quote) {
    const q = await pool.query(`SELECT customer_id, customer_name FROM quotations WHERE id=$1`, [ids.quote]);
    check('  -> quotation party == opp party', q.rows[0].customer_id === ids.party, `${q.rows[0].customer_id}`);
    const b = await pool.query(`SELECT quotation_id FROM opportunities WHERE id=$1`, [ids.opp]);
    check('  -> back-reference on opportunity', b.rows[0].quotation_id === ids.quote, `opportunities.quotation_id=${b.rows[0].quotation_id}`);
  }

  // 5 - Sales order
  r = await call('POST', `/sales/orders/from-quotation/${ids.quote}`, {});
  ids.so = r.json?.data?.id ?? r.json?.id ?? r.json?.order?.id;
  check('Quotation -> Sales Order', r.status < 300 && !!ids.so, `so=${ids.so} (${r.status}) ${r.status >= 300 ? r.text.slice(0, 160) : ''}`);
  if (ids.so) {
    const q = await pool.query(`SELECT customer_id, quotation_id FROM sales_orders WHERE id=$1`, [ids.so]);
    check('  -> SO party == quotation party', q.rows[0].customer_id === ids.party, `${q.rows[0].customer_id}`);
  }

  // 6 - Invoice
  r = await call('PATCH', `/sales/orders/${ids.so}/invoice`, {});
  ids.invoice = r.json?.invoice_id;
  check('Sales Order -> Invoice', r.status < 300 && !!ids.invoice,
    `invoice=${r.json?.invoice_number} (${r.status}) ${r.status >= 300 ? r.text.slice(0, 200) : ''}`);
  if (ids.invoice) {
    const q = await pool.query(`SELECT customer_id, sales_order_id FROM invoices WHERE id=$1`, [ids.invoice]);
    check('  -> invoice party == SO party', q.rows[0].customer_id === ids.party, `${q.rows[0].customer_id}`);
    check('  -> invoice -> sales order link', q.rows[0].sales_order_id === ids.so, `sales_order_id=${q.rows[0].sales_order_id}`);
  }

  // 7 - Receipt against the invoice
  r = await call('POST', '/finance/receipts', {
    receipt_date: new Date().toISOString().slice(0, 10),
    customer_id: ids.party, amount: 100, payment_method: 'bank',
    reference_number: 'ZZCHAIN-RCPT',
    allocations: [{ invoice_id: ids.invoice, allocated_amount: 100 }],
  });
  ids.receipt = r.json?.data?.id ?? r.json?.id;
  check('Invoice -> Receipt', r.status < 300 && !!ids.receipt, `receipt=${ids.receipt} (${r.status}) ${r.status >= 300 ? r.text.slice(0, 200) : ''}`);

  console.log(`\n  ${failed === 0 ? 'CHAIN COMPLETE - every hop carries a valid foreign key' : failed + ' step(s) failed'}`);
  console.log(`  ids: ${JSON.stringify(ids)}`);
} finally {
  const del = async (sql, p) => { try { await pool.query(sql, p); } catch (e) { console.log('  cleanup:', e.message.slice(0, 90)); } };
  if (ids.receipt) { await del(`DELETE FROM receipt_allocations WHERE receipt_id=$1`, [ids.receipt]); await del(`DELETE FROM receipts WHERE id=$1`, [ids.receipt]); }
  if (ids.invoice) {
    // The journal entry has to outlive the invoice: invoices.journal_entry_id
    // FKs it, so deleting the JE first fails with invoices_journal_entry_id_fkey.
    // Capture the id, delete the invoice, then the JE and its lines.
    const je = await pool.query(`SELECT journal_entry_id FROM invoices WHERE id=$1`, [ids.invoice])
      .then(r => r.rows[0]?.journal_entry_id).catch(() => null);
    await del(`DELETE FROM invoice_items WHERE invoice_id=$1`, [ids.invoice]);
    await del(`UPDATE sales_orders SET invoice_id=NULL WHERE invoice_id=$1`, [ids.invoice]);
    await del(`DELETE FROM invoices WHERE id=$1`, [ids.invoice]);
    if (je) {
      await del(`DELETE FROM journal_entry_lines WHERE journal_entry_id=$1`, [je]);
      await del(`DELETE FROM journal_entries WHERE id=$1`, [je]);
    }
  }
  // sales_order_items keys on `order_id`, not `sales_order_id`.
  if (ids.so) { await del(`DELETE FROM sales_order_items WHERE order_id=$1`, [ids.so]); await del(`DELETE FROM sales_orders WHERE id=$1`, [ids.so]); }
  if (ids.opp) await del(`UPDATE opportunities SET quotation_id=NULL WHERE id=$1`, [ids.opp]);
  if (ids.quote) { await del(`DELETE FROM quotation_items WHERE quotation_id=$1`, [ids.quote]); await del(`DELETE FROM quotations WHERE id=$1`, [ids.quote]); }
  if (ids.opp) { await del(`DELETE FROM opportunity_stage_history WHERE opportunity_id=$1`, [ids.opp]); await del(`DELETE FROM opportunities WHERE id=$1`, [ids.opp]); }
  if (ids.account) { await del(`DELETE FROM contacts WHERE account_id=$1`, [ids.account]); await del(`DELETE FROM accounts WHERE id=$1`, [ids.account]); }
  if (ids.party) await del(`DELETE FROM parties WHERE id=$1`, [ids.party]);
  if (ids.lead) {
    await del(`DELETE FROM lead_activities WHERE lead_id=$1`, [ids.lead]);
    await del(`DELETE FROM crm_activities WHERE lead_id=$1`, [ids.lead]);
    await del(`DELETE FROM leads WHERE id=$1`, [ids.lead]);
  }
  console.log('  test data removed');
  await pool.end();
}
