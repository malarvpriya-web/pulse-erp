/**
 * legacyFulfilmentLinks.js — link legacy orders to the stock issue that
 * fulfilled them (decision 2026-10-28: "Link as reconciled"). Library; the CLI
 * is link-legacy-fulfilment.mjs.
 *
 * `candidates` is read-only. `link` writes, in one transaction: it re-reads
 * every candidate under row locks, requires each order still to match the
 * evidence exactly, and requires the set to equal the expected set (so it
 * links exactly what the dry run showed), or links nothing. It never creates
 * or changes a stock movement. One audit_logs row per order.
 *
 * An order is a candidate when every stock line (item_id) has exactly one
 * stock_ledger issue referencing the order (reference_type 'sales_order'),
 * same item and company, quantity_out = ordered, nothing put back; it has no
 * dispatched pick list, no invoice, no return, and no link yet.
 */
export async function candidates(db, companyId, { orderNumberPrefix = null, lock = false } = {}) {
  const { rows } = await db.query(`
    SELECT so.id AS sales_order_id, so.order_number, so.company_id,
           s.id AS sales_order_item_id, s.item_id, s.quantity::float AS ordered,
           (SELECT json_agg(json_build_object('id', sl.id, 'item_id', sl.item_id, 'out', sl.quantity_out::float,
                                              'in', sl.quantity_in::float, 'company_id', sl.company_id) ORDER BY sl.id)
              FROM stock_ledger sl WHERE sl.reference_type = 'sales_order' AND sl.reference_id = so.id) AS ledger,
           (SELECT COUNT(*) FROM sales_order_items x WHERE x.order_id = so.id AND x.item_id IS NOT NULL)::int AS stock_lines,
           EXISTS (SELECT 1 FROM pick_lists p WHERE p.sales_order_id = so.id AND LOWER(p.status) = 'dispatched') AS has_pick,
           EXISTS (SELECT 1 FROM invoices i WHERE i.sales_order_id = so.id) AS has_invoice,
           EXISTS (SELECT 1 FROM sales_returns r WHERE r.sales_order_id = so.id) AS has_return,
           EXISTS (SELECT 1 FROM legacy_fulfilment_links k WHERE k.sales_order_item_id = s.id) AS linked
      FROM sales_orders so
      JOIN sales_order_items s ON s.order_id = so.id AND s.item_id IS NOT NULL
     WHERE so.company_id = $1 AND so.deleted_at IS NULL
       AND ($2::text IS NULL OR so.order_number LIKE $2 || '%')
       AND EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.reference_type = 'sales_order' AND sl.reference_id = so.id)
     ORDER BY so.id, s.id
     ${lock ? 'FOR UPDATE OF so' : ''}`, [companyId, orderNumberPrefix]);
  const out = [], rejected = [];
  for (const r of rows) {
    const ledger = r.ledger || [];
    const reasons = [];
    if (r.stock_lines !== 1) reasons.push(`${r.stock_lines} stock lines (one ledger issue per order cannot be attributed to a line)`);
    if (ledger.length !== 1) reasons.push(`${ledger.length} ledger rows reference the order`);
    const sl = ledger[0];
    if (sl && (sl.item_id !== r.item_id || sl.company_id !== r.company_id || sl.in !== 0 || sl.out !== r.ordered)) {
      reasons.push(`ledger row ${sl.id} does not match the line (item ${sl.item_id}/${r.item_id}, qty ${sl.out}/${r.ordered}, back ${sl.in})`);
    }
    if (r.has_pick) reasons.push('has a dispatched pick list');
    if (r.has_invoice) reasons.push('has an invoice');
    if (r.has_return) reasons.push('has a return');
    if (r.linked) reasons.push('already linked');
    const c = { sales_order_id: r.sales_order_id, order_number: r.order_number, sales_order_item_id: r.sales_order_item_id,
                item_id: r.item_id, quantity: r.ordered, stock_ledger_id: sl?.id ?? null };
    (reasons.length ? rejected : out).push(reasons.length ? { ...c, reasons } : c);
  }
  return { candidates: out, rejected };
}

const key = (c) => `${c.sales_order_item_id}:${c.stock_ledger_id}:${c.quantity}`;

export async function link(client, companyId, expected, { approvedBy, orderNumberPrefix = null, createdBy = null } = {}) {
  if (!String(approvedBy ?? '').trim()) throw new Error('approvedBy is required');
  await client.query('BEGIN');
  try {
    const { candidates: now, rejected } = await candidates(client, companyId, { orderNumberPrefix, lock: true });
    const want = new Set(expected.map(key)), got = new Set(now.map(key));
    if (want.size !== got.size || [...want].some(k => !got.has(k))) {
      throw Object.assign(new Error('the eligible set differs from the expected set; nothing linked'), { now, rejected });
    }
    const ledgerBefore = (await client.query(`SELECT COUNT(*)::int n, COALESCE(SUM(quantity_in - quantity_out), 0)::float q FROM stock_ledger WHERE company_id = $1`, [companyId])).rows[0];
    for (const c of now) {
      await client.query(`
        INSERT INTO legacy_fulfilment_links (company_id, sales_order_item_id, stock_ledger_id, quantity, evidence, approved_by, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [companyId, c.sales_order_item_id, c.stock_ledger_id, c.quantity,
         `stock_ledger ${c.stock_ledger_id}: sales_order ${c.sales_order_id} issue of ${c.quantity} × item ${c.item_id}, verified equal to the ordered quantity`,
         approvedBy, createdBy]);
      await client.query(`INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, new_data_json, company_id)
        VALUES ($1, 'sales', 'legacy_fulfilment_linked', $2, 'sales_order', $3, $4)`,
        [createdBy, String(c.sales_order_id), JSON.stringify({ ...c, approved_by: approvedBy }), companyId]);
    }
    const ledgerAfter = (await client.query(`SELECT COUNT(*)::int n, COALESCE(SUM(quantity_in - quantity_out), 0)::float q FROM stock_ledger WHERE company_id = $1`, [companyId])).rows[0];
    if (ledgerAfter.n !== ledgerBefore.n || ledgerAfter.q !== ledgerBefore.q) throw new Error('stock changed during linking; rolled back');
    await client.query('COMMIT');
    return { linked: now.length, orders: [...new Set(now.map(c => c.sales_order_id))].length, quantity: now.reduce((t, c) => t + c.quantity, 0) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}
