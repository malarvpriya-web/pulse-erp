/**
 * threeWayMatch.routes.js — purchase order vs goods receipt vs supplier invoice,
 * and the payable bill that comes out of it.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * This is the only path in the system that turns a receipt into money, and it
 * was ~450 lines buried in the middle of a 3,800-line router, split into two
 * halves 600 lines apart — the matcher near the RFQ code and the approval that
 * raises the bill down among the analytics endpoints. Nothing about it was
 * reviewable as one thing, which is how it came to hold, simultaneously: no
 * tenant predicate on the approval, an `approved_by` written from the wrong id
 * space, three autocommit statements where one transaction was needed, no
 * idempotency, a vendor resolved by name, and a bill whose taxable value was its
 * gross and whose balance was zero.
 *
 * The routes below are mounted into the procurement router at the same paths
 * they always had (`router.use('/', threeWayMatchRoutes)`), so the API is
 * unchanged: /api/procurement/three-way-match and its three verbs.
 *
 * THE MATCHING RULE, STATED ONCE
 * ------------------------------
 *   receipt leg : accepted GRN value  vs  po.subtotal      (both EX-tax)
 *   invoice leg : supplier invoice    vs  po.total_amount  (both INC-tax)
 *
 * Each leg is measured on its own basis. Measuring both against the tax-
 * inclusive total — which is what this did — builds a guaranteed 15.25% variance
 * into every 18% GST receipt whose numbers agree to the paisa, and with
 * `block_payment_on_mismatch` on (what the setting is FOR) would hold payment on
 * every invoice the company receives.
 *
 * Tolerance comes from `procurement_settings.allowable_price_variance_pct`.
 */
import express from 'express';
import pool from '../../shared/db.js';
import billRepo from '../../finance/repositories/bill.repository.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { requireProcurement } from '../procurement.authz.js';
import { getProcSettings } from '../services/procurementSettings.service.js';
import { resolveVendorParty } from '../services/vendorIdentity.service.js';

const router = express.Router();
const cid = req => companyOf(req);

router.get('/three-way-match', requireProcurement('view', 'finance', 'finance_manager'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, po_id } = req.query;
    const conditions = ['1=1'];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`twm.company_id = $${idx++}`); params.push(companyId); }
    if (status)    { conditions.push(`twm.match_status = $${idx++}`); params.push(status); }
    if (po_id)     { conditions.push(`twm.po_id = $${idx++}`); params.push(po_id); }
    try {
      const { rows } = await pool.query(`
        SELECT twm.*, po.po_number, v.vendor_name
        FROM three_way_matches twm
        JOIN purchase_orders po ON po.id = twm.po_id
        LEFT JOIN vendors v ON v.id = po.supplier_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY twm.created_at DESC
      `, params);
      res.json({ matches: rows });
    } catch {
      // three_way_matches table may not exist yet — return empty list gracefully
      res.json({ matches: [] });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Extracted so §5.6's GRN-creation auto-trigger can run the exact same
// matching logic as the manual POST below instead of a second
// re-implementation. Behavior unchanged from the original inline handler.
async function createThreeWayMatchRecord(companyId, { po_id, grn_id, vendor_invoice_no, vendor_invoice_date, vendor_invoice_amount }) {
  if (!po_id) throw Object.assign(new Error('po_id is required'), { status: 400 });
  const { rows: poRows } = await pool.query(
    'SELECT subtotal, tax_amount, total_amount FROM purchase_orders WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
    [po_id, companyId]
  );
  if (!poRows[0]) throw Object.assign(new Error('Purchase order not found'), { status: 404 });
  const po_amount  = parseFloat(poRows[0]?.total_amount || 0);
  // The goods-value leg of the PO, exclusive of tax — see the basis note below.
  const po_goods   = parseFloat(poRows[0]?.subtotal || 0) || po_amount;
  const inv_amount = parseFloat(vendor_invoice_amount  || 0);
  let grn_amount   = 0;
  if (grn_id) {
    // The receipt must belong to this company AND to this purchase order.
    // Neither was checked: `WHERE gi.grn_id = $1` took the id straight from the
    // request body, so a caller could value the receipt leg of their own match
    // from ANOTHER TENANT'S goods receipt, or from an unrelated receipt in their
    // own company — in both cases producing a "matched" verdict, and therefore a
    // payable bill, from numbers that have nothing to do with the order.
    const { rows: [grn] } = await pool.query(
      `SELECT id, grn_number, po_id, company_id, status FROM goods_receipt_notes
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [grn_id, companyId]
    );
    if (!grn) throw Object.assign(new Error('Goods receipt not found'), { status: 404 });
    if (String(grn.po_id) !== String(po_id)) {
      throw Object.assign(
        new Error(`Receipt ${grn.grn_number} was booked against purchase order ${grn.po_id}, not ${po_id}. A three-way match compares one order with its own receipt.`),
        { status: 400 }
      );
    }
    if (grn.status === 'cancelled' || grn.status === 'rejected') {
      throw Object.assign(
        new Error(`Receipt ${grn.grn_number} is '${grn.status}' — goods that were rejected or whose receipt was cancelled cannot be matched for payment.`),
        { status: 422 }
      );
    }

    // goods_receipt_notes has no value column — derive the GRN leg from its own
    // lines. Value the ACCEPTED quantity (received - rejected), since that is
    // what entered stock and what the vendor should be paid for. Errors are no
    // longer swallowed: a silent catch here is what pinned grn_amount at 0 and
    // made every 3-way match classify as a discrepancy.
    const { rows: gr } = await pool.query(
      `SELECT COALESCE(SUM(
                GREATEST(COALESCE(gi.quantity_received, 0) - COALESCE(gi.quantity_rejected, 0), 0)
                * COALESCE(gi.rate, 0)
              ), 0) AS amt
       FROM grn_items gi WHERE gi.grn_id = $1`, [grn_id]
    );
    grn_amount = parseFloat(gr[0]?.amt || 0);
  }
  if (inv_amount < 0) {
    throw Object.assign(new Error('An invoice amount cannot be negative.'), { status: 400 });
  }
  if (vendor_invoice_date && Number.isNaN(new Date(vendor_invoice_date).getTime())) {
    throw Object.assign(new Error('The vendor invoice date is not a valid date.'), { status: 400 });
  }
  // Tolerance comes from procurement_settings.allowable_price_variance_pct, the
  // control the Settings screen presents for exactly this decision. It was
  // hardcoded to 1% here, so a company that configured its tolerance at the
  // default 3% still had every 1–3% invoice flagged as a discrepancy and held
  // out of auto-billing — the setting appeared to work (it saved and read back)
  // while changing nothing about the outcome it names.
  const settings = await getProcSettings(companyId);
  const tolerancePct = parseFloat(settings.allowable_price_variance_pct ?? 3);
  const tolerance = (Number.isFinite(tolerancePct) ? tolerancePct : 3) / 100;

  // ── The two legs are compared on their OWN basis ────────────────────────────
  //
  // Both legs used to be measured against `po.total_amount`, which is
  // tax-INCLUSIVE, while the GRN leg above values accepted quantity at the line
  // rate, which is tax-EXCLUSIVE. On a PO carrying 18% GST that is a guaranteed
  // 15.25% variance between two numbers that agree perfectly — verified on
  // PO0010, whose subtotal (₹200.00) equals its GRN value (₹200.00) to the paisa
  // while its total (₹236.00) does not. Every GST-bearing receipt therefore
  // classified as a discrepancy no matter how correct it was, and with
  // `enforce_3way_match` / `block_payment_on_mismatch` switched on that would
  // have held payment on every invoice the company received.
  //
  //   receipt leg : GRN goods value  vs  po.subtotal      (both ex-tax)
  //   invoice leg : vendor invoice   vs  po.total_amount  (both inc-tax)
  const legs = [];
  if (po_amount > 0 && inv_amount > 0) {
    legs.push({ name: 'invoice', variance: Math.abs(po_amount - inv_amount) / po_amount });
  }
  if (po_goods > 0 && grn_id) {
    legs.push({ name: 'receipt', variance: Math.abs(po_goods - grn_amount) / po_goods });
  }

  // A three-way match needs three legs. With no grn_id there is no receipt leg,
  // and `grn_amount` stays 0 — which the old comparison read as a 100% variance
  // and stamped 'discrepancy'. An invoice that arrives before the goods is a
  // normal, temporary state, not a mismatch; calling it a discrepancy pushed
  // clean invoices into the exception queue for a human to clear.
  let match_status = 'pending';
  let discrepancy_reason = null;
  if (legs.length) {
    const breached = legs.filter(l => l.variance > tolerance);
    const complete = grn_id && inv_amount > 0;
    if (breached.length) {
      match_status = 'discrepancy';
      discrepancy_reason = breached
        .map(l => `${l.name} leg differs from the order by ${(l.variance * 100).toFixed(2)}% (tolerance ${tolerancePct}%)`)
        .join('; ');
    } else if (complete) {
      match_status = 'matched';
    }
    // else: within tolerance but a leg is still outstanding — stays 'pending'.
  }

  // discrepancy_reason is a real column that nothing had ever written, so the
  // exception queue could say a match had failed but never why.
  // One match per (company, order, supplier invoice). Without this the same
  // invoice could be matched against the same order repeatedly — and each match
  // approved into its own payable bill. Backed by the partial unique index
  // three_way_matches_invoice_uq (migration 20260903000011); ON CONFLICT makes
  // the re-post return the existing row instead of a 500, so an auto-match fired
  // a second time by a retried GRN is a no-op rather than an error.
  const { rows } = await pool.query(`
    INSERT INTO three_way_matches (company_id, po_id, grn_id, vendor_invoice_no, vendor_invoice_date, vendor_invoice_amount, po_amount, grn_amount, match_status, discrepancy_reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (company_id, po_id, LOWER(TRIM(vendor_invoice_no)))
      WHERE vendor_invoice_no IS NOT NULL AND TRIM(vendor_invoice_no) <> ''
      DO UPDATE SET
        -- Only ever ADDS information: a match created at receipt time with no
        -- invoice, then re-posted once the invoice arrives, should learn the
        -- invoice. An APPROVED match is never re-opened by a re-post.
        grn_id                = COALESCE(three_way_matches.grn_id, EXCLUDED.grn_id),
        vendor_invoice_date   = COALESCE(three_way_matches.vendor_invoice_date, EXCLUDED.vendor_invoice_date),
        vendor_invoice_amount = CASE WHEN COALESCE(three_way_matches.vendor_invoice_amount,0) = 0
                                     THEN EXCLUDED.vendor_invoice_amount
                                     ELSE three_way_matches.vendor_invoice_amount END,
        grn_amount            = GREATEST(COALESCE(three_way_matches.grn_amount,0), EXCLUDED.grn_amount),
        match_status          = CASE WHEN three_way_matches.match_status = 'approved'
                                     THEN three_way_matches.match_status ELSE EXCLUDED.match_status END,
        discrepancy_reason    = CASE WHEN three_way_matches.match_status = 'approved'
                                     THEN three_way_matches.discrepancy_reason ELSE EXCLUDED.discrepancy_reason END
    RETURNING *
  `, [companyId, po_id, grn_id || null, vendor_invoice_no || null, vendor_invoice_date || null, inv_amount, po_amount, grn_amount, match_status, discrepancy_reason]);
  return rows[0];
}

router.post('/three-way-match', requireProcurement('add', 'finance', 'finance_manager'), async (req, res) => {
  try {
    const match = await createThreeWayMatchRecord(cid(req), req.body);
    res.status(201).json(match);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/**
 * PATCH /three-way-match/:id/approve — the one path in the system that turns a
 * goods receipt into a payable bill.
 *
 * Rewritten because every defect below was live on it at once:
 *
 *  1. NO TENANT SCOPE. The status read, and the UPDATE that approves the match,
 *     were both `WHERE id = $1`. A company-1 token could approve company-2's
 *     match — and then this route raised a bill in company 1, for company 2's
 *     purchase order, payable to whichever party a name match happened to find.
 *     That is a cross-tenant write that ends in money.
 *
 *  2. WRONG ID SPACE. `approved_by` was `req.user.userId`, a users.id, while
 *     `three_way_matches.approved_by` FKs employees(id). Only 7 of the 62
 *     accounts in this database have a users.id that is coincidentally also a
 *     valid employees.id, so for the other 55 — including every admin — this
 *     UPDATE raised a foreign key violation and the route 500'd. The AP bill
 *     path had therefore never once completed for a normal operator. (Seventh
 *     instance of the stock_ledger.created_by trap; use employeeOf().)
 *
 *  3. NOT ATOMIC. Match-approve, bill-insert and the PO-linking UPDATE were
 *     three separate autocommit statements. A failure in the second left a match
 *     marked 'approved' with no bill behind it, and nothing to retry against
 *     because the guard in (4) then treated it as already done.
 *
 *  4. NOT IDEMPOTENT. Nothing checked the current match_status, so a double
 *     click ran the whole thing twice. The duplicate bill was caught only by
 *     `ON CONFLICT (company_id, bill_number)` — which does not fire when
 *     bill_number is NULL, because NULLs are distinct in a unique index. A match
 *     approved without a vendor invoice number therefore created a SECOND
 *     payable bill on every retry, each for the full invoice amount.
 *
 *  5. VENDOR RESOLVED BY NAME. `SELECT id FROM parties WHERE LOWER(name) =
 *     LOWER($1) LIMIT 1`, with no company predicate. Now `vendors.party_id`, the
 *     deterministic key — see vendorIdentity.service.js.
 *
 *  6. WRONG BILL FIGURES. The insert wrote `subtotal = total_amount` (so a GST
 *     invoice booked its gross as its taxable value, and tax_amount stayed 0),
 *     and set neither `balance` nor `net_payable` nor `due_date`. `balance`
 *     defaults to 0, and AP ageing, the payment run and the supplier statement
 *     all read `balance` — so an auto-created bill was invisible as a payable
 *     the moment it was created. Now built through billRepo.create(), the same
 *     path a manually keyed bill takes, which derives all three.
 */
router.patch('/three-way-match/:id/approve', requireProcurement('approve', 'finance', 'finance_manager'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req);
    const actorUserId = req.user?.userId ?? req.user?.id ?? null;
    // employeeOf() is async and needs the pool — it falls back to users.employee_id
    // when the JWT does not carry the claim, which is the case for every token
    // minted before that field was added. Calling it without awaiting would put a
    // Promise into the bind parameter.
    const actorEmpId  = await employeeOf(req, pool);

    await client.query('BEGIN');

    // FOR UPDATE serialises concurrent approvals of the same match: the second
    // request blocks here, then reads match_status = 'approved' and takes the
    // already-done branch instead of raising a second bill.
    const { rows: [match] } = await client.query(
      `SELECT * FROM three_way_matches
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
        FOR UPDATE`,
      [req.params.id, companyId]
    );
    if (!match) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Match record not found' });
    }

    // ── Idempotency ──────────────────────────────────────────────────────────
    // An already-approved match returns the bill it already produced. This is a
    // 200, not a 409: the caller asked for a state that holds, and a retry after
    // a dropped response must not read as a failure.
    if (match.match_status === 'approved') {
      const { rows: [existing] } = await client.query(
        `SELECT id FROM bills
          WHERE company_id IS NOT DISTINCT FROM $1 AND po_id = $2 AND deleted_at IS NULL
            AND ($3::text IS NULL OR bill_number = $3)
          ORDER BY id LIMIT 1`,
        [match.company_id, match.po_id, match.vendor_invoice_no]
      );
      await client.query('ROLLBACK');
      return res.json({ ...match, bill_id: existing?.id ?? null, already_approved: true });
    }

    // A discrepancy must be cleared before it can become money — this is the
    // choke point `block_payment_on_mismatch` names.
    if (match.match_status === 'discrepancy') {
      const settings = await getProcSettings(companyId);
      if (settings.block_payment_on_mismatch) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'This PO/GRN/invoice match has a flagged discrepancy and payment-blocking is enabled in Procurement Settings. Resolve the discrepancy first (PATCH /three-way-match/:id/resolve) before approving for payment.',
        });
      }
    }

    // A bill cannot be raised without the vendor's own invoice reference: it is
    // the document number AP pays against, the key GST reconciliation joins on,
    // and — see (4) above — the only thing that makes a duplicate detectable.
    if (!String(match.vendor_invoice_no || '').trim()) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'This match has no vendor invoice number. Record the supplier\'s invoice reference on the match before approving it for payment — it is what the bill is raised against and what prevents the same invoice being paid twice.',
      });
    }
    if (!(parseFloat(match.vendor_invoice_amount) > 0)) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: 'This match has no vendor invoice amount — there is nothing to raise a bill for.' });
    }

    // ── Duplicate-invoice guard ──────────────────────────────────────────────
    // Checked BEFORE the write, so the caller is told what happened rather than
    // silently receiving a match with bill_id: null. The same supplier invoice
    // number must not become two payable bills in one company, whichever PO it
    // arrived through — that is the classic double-payment path.
    const { rows: [dupe] } = await client.query(
      `SELECT id, po_id, total_amount FROM bills
        WHERE company_id IS NOT DISTINCT FROM $1
          AND bill_number = $2 AND deleted_at IS NULL
        LIMIT 1`,
      [companyId ?? match.company_id, match.vendor_invoice_no]
    );

    const { rows: [po] } = await client.query(
      `SELECT po.id, po.supplier_id, po.subtotal, po.tax_amount, po.total_amount,
              po.currency, po.exchange_rate, po.company_id,
              v.vendor_name, v.party_id, v.payment_terms_days
         FROM purchase_orders po
         LEFT JOIN vendors v ON v.id = po.supplier_id
        WHERE po.id = $1 AND po.deleted_at IS NULL`,
      [match.po_id]
    );
    if (!po) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'The purchase order behind this match no longer exists.' });
    }
    if (!po.supplier_id) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'The purchase order behind this match has no supplier, so there is nobody to raise a payable bill to. Set the vendor on the purchase order first.',
      });
    }

    let billId = dupe?.id ?? null;
    let duplicateBill = Boolean(dupe);

    if (!dupe) {
      // Deterministic vendor -> finance party. resolveVendorParty binds the
      // vendor on first use and is idempotent thereafter, so a supplier that
      // predates the identity service acquires a real party here rather than
      // producing a bill with a NULL supplier_id that AP would never show.
      const { party } = await resolveVendorParty(client, po.supplier_id);

      // Split the invoice on the PO's OWN tax basis rather than collapsing it.
      // The vendor invoice amount is gross (it is compared against
      // po.total_amount by the invoice leg of the match), so the taxable value
      // is that gross scaled by the order's subtotal/total ratio. On a zero-tax
      // order the ratio is 1 and subtotal == total, which is correct.
      const poTotal    = parseFloat(po.total_amount) || 0;
      const poSubtotal = parseFloat(po.subtotal) || 0;
      const gross      = parseFloat(match.vendor_invoice_amount) || 0;
      const ratio      = poTotal > 0 && poSubtotal > 0 ? poSubtotal / poTotal : 1;
      const subtotal   = Number((gross * ratio).toFixed(2));
      const taxAmount  = Number((gross - subtotal).toFixed(2));

      // Payment terms come from the vendor, defaulting to the procurement
      // setting and then to 30 — the same precedence vendor creation uses.
      const settings = await getProcSettings(companyId);
      const terms = Number.isFinite(parseInt(po.payment_terms_days, 10))
        ? parseInt(po.payment_terms_days, 10)
        : (parseInt(settings.default_payment_terms_days, 10) || 30);
      const billDate = match.vendor_invoice_date
        ? new Date(match.vendor_invoice_date)
        : new Date();
      const dueDate = new Date(billDate.getTime() + terms * 86400000);

      const bill = await billRepo.create(client, {
        bill_number:  match.vendor_invoice_no,
        supplier_id:  party?.id ?? null,
        bill_date:    billDate.toISOString().slice(0, 10),
        due_date:     dueDate.toISOString().slice(0, 10),
        subtotal,
        tax_amount:   taxAmount,
        total_amount: gross,
        notes:        `Auto-created from 3-way match approval (match #${match.id})`,
        created_by:   actorUserId,
        company_id:   companyId ?? match.company_id,
        currency:     po.currency || 'INR',
        exchange_rate: po.exchange_rate || 1,
        // Asserted, not inferred: the match being approved names the order. A
        // bill without it lands in AP as non-PO spend and inflates the maverick
        // ratio (see the spend-cube work in §138).
        po_id:        match.po_id,
      });
      billId = bill.id;
    } else if (dupe.po_id == null) {
      // A bill that demonstrably belongs to a purchase order must not stay in
      // the non-PO bucket. Only a NULL is filled — an existing link is never
      // repointed by a second match.
      await client.query(`UPDATE bills SET po_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [match.po_id, dupe.id]);
    }

    const { rows: [approved] } = await client.query(
      `UPDATE three_way_matches
          SET match_status = 'approved', approved_by = $1, approved_at = NOW()
        WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)
        RETURNING *`,
      // employees.id, per the FK. NULL is accepted and is the honest value for
      // an admin account with no employee record — better than a 500.
      [actorEmpId, req.params.id, companyId]
    );

    await client.query('COMMIT');

    logAudit({
      userId: actorUserId, module: 'procurement', recordId: approved.id,
      recordType: 'three_way_match', action: 'approve',
      oldData: match, newData: { ...approved, bill_id: billId }, req,
    });

    res.json({
      ...approved,
      bill_id: billId,
      ...(duplicateBill ? {
        duplicate_invoice: true,
        message: `Invoice ${match.vendor_invoice_no} was already recorded as bill #${billId}; this match was linked to it rather than raising a second payable.`,
      } : {}),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── 3-Way Match: resolve discrepancy ─────────────────────────────────────────
router.patch('/three-way-match/:id/resolve', requireProcurement('approve', 'finance', 'finance_manager'), async (req, res) => {
  try {
    const { discrepancy_reason } = req.body;
    // Scoped: this is the control that clears an invoice for payment, so
    // resolving another tenant's exception is the most consequential of the
    // unscoped writes in this module.
    const { rows } = await pool.query(
      `UPDATE three_way_matches SET match_status='matched', discrepancy_reason=$1
        WHERE id=$2 AND ($3::int IS NULL OR company_id = $3) RETURNING *`,
      [discrepancy_reason || null, req.params.id, cid(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Match record not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export { createThreeWayMatchRecord };
export default router;
