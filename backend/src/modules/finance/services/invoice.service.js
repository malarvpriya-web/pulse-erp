import pool from '../db.js';
import invoiceRepo from '../repositories/invoice.repository.js';
import journalRepo from '../repositories/journal.repository.js';
import cogsService from './cogsJournal.service.js';
import { fulfilmentCost } from '../../warehouse/pickListWorkflow.service.js';
import { detectGSTFromGSTIN, detectGSTFromState, validateGstSplit } from '../../../utils/gst.js';

/** A refusal while preparing fulfilment-linked lines (inside the invoice transaction). */
function fulfilmentError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

/**
 * Validate and cost the lines of an invoice that bill shipped goods, inside
 * the invoice's own transaction. Pick-list lines are locked FOR UPDATE (in id
 * order, so two invoices touching the same lines cannot deadlock), which makes
 * the "uninvoiced quantity" check race-free: a second invoice for the same pick
 * line waits here and then sees the first one's lines.
 *
 * Returns the lines with item_id and the VERIFIED unit_cost filled in. A
 * unit_cost sent by the caller is ignored — cost comes from what the pick
 * actually consumed, never from the request.
 */
async function prepareFulfilmentLines(client, linked, { companyId, salesOrderId }) {
  if (companyId == null) {
    throw fulfilmentError(422, 'COMPANY_REQUIRED', 'An invoice that bills shipped goods must belong to a company.');
  }
  if (salesOrderId == null || String(salesOrderId).trim() === '') {
    throw fulfilmentError(422, 'SALES_ORDER_REQUIRED',
      'An invoice that bills shipped goods must name its sales_order_id; every pick line must belong to that order.');
  }
  const ids = linked.map(l => Number(l.pick_list_line_id));
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) {
    throw fulfilmentError(422, 'FULFILMENT_LINE_INVALID', 'pick_list_line_id must be a record id.');
  }
  if (new Set(ids).size !== ids.length) {
    throw fulfilmentError(422, 'FULFILMENT_LINE_DUPLICATED', 'An invoice may bill each pick-list line once; combine the quantities.');
  }

  // The order first, then its pick lines — the order sales-order invoicing and
  // return receipts take them in — so the order-item rule below is checked
  // one invoice at a time across ALL the order's pick lines, not just these.
  if (/^\d+$/.test(String(salesOrderId))) {
    await client.query(`SELECT id FROM sales_orders WHERE id = $1 AND company_id IS NOT DISTINCT FROM $2 FOR UPDATE`,
      [salesOrderId, companyId]);
  }
  const { rows: pickLines } = await client.query(`
    SELECT l.id, l.item_id, l.item_name, l.picked_qty, l.pick_list_id,
           p.company_id, p.status, p.sales_order_id
      FROM pick_list_lines l JOIN pick_lists p ON p.id = l.pick_list_id
     WHERE l.id = ANY($1::int[])
     ORDER BY l.id
       FOR UPDATE OF l`, [ids]);
  const byId = new Map(pickLines.map(r => [r.id, r]));

  const prepared = [];
  for (const line of linked) {
    const pl = byId.get(Number(line.pick_list_line_id));
    // Another company's line is "not found", never "forbidden": its existence is not disclosed.
    if (!pl || String(pl.company_id) !== String(companyId)) {
      throw fulfilmentError(404, 'FULFILMENT_LINE_NOT_FOUND', `Pick-list line ${line.pick_list_line_id} not found.`);
    }
    if (String(pl.status || '').toLowerCase() !== 'dispatched') {
      throw fulfilmentError(409, 'FULFILMENT_NOT_DISPATCHED',
        `Pick-list line ${pl.id} belongs to a ${pl.status} pick list; only dispatched goods can be invoiced.`);
    }
    if (String(pl.sales_order_id) !== String(salesOrderId)) {
      throw fulfilmentError(422, 'FULFILMENT_ORDER_MISMATCH',
        `Pick-list line ${pl.id} belongs to sales order ${pl.sales_order_id}, not ${salesOrderId}.`);
    }
    const itemId = line.item_id != null && String(line.item_id).trim() !== '' ? Number(line.item_id) : pl.item_id;
    if (String(itemId) !== String(pl.item_id)) {
      throw fulfilmentError(422, 'FULFILMENT_ITEM_MISMATCH', `Pick-list line ${pl.id} is item ${pl.item_id}, not ${line.item_id}.`);
    }
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw fulfilmentError(422, 'FULFILMENT_QUANTITY_INVALID', `Quantity for pick-list line ${pl.id} must be positive.`);
    }
    // Invoiced = billed on live invoices less what posted credit notes released
    // (pick_line_invoiced_qty, migration 20261028000001 — the trigger uses it too).
    // Costed = units whose COGS was already recognised; a released quantity
    // billed again is not expensed again.
    const { rows: [billed] } = await client.query(`
      SELECT pick_line_invoiced_qty($1)::float AS qty,
             (SELECT COALESCE(SUM(COALESCE(ii.cogs_qty, ii.quantity)), 0)
                FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
               WHERE ii.pick_list_line_id = $1 AND LOWER(COALESCE(i.status, '')) <> 'cancelled')::float AS costed`,
      [pl.id]);
    const remaining = Number(pl.picked_qty || 0) - billed.qty;
    if (qty > remaining + 1e-9) {
      throw fulfilmentError(409, 'FULFILMENT_OVER_INVOICED',
        `Pick-list line ${pl.id} has ${remaining} uninvoiced unit(s); ${qty} requested.`,
        { pick_list_line_id: pl.id, uninvoiced: remaining });
    }
    const cost = await fulfilmentCost(client, pl.pick_list_id, pl.item_id);
    if (!cost.verified) {
      throw fulfilmentError(422, 'FULFILMENT_COST_UNVERIFIED',
        `The cost of the goods shipped on pick list ${pl.pick_list_id} (item ${pl.item_id}) cannot be verified from FIFO `
        + `records (${cost.costed_qty} of ${cost.ledger_net_qty} unit(s) costed), so no COGS can be posted for them.`,
        { pick_list_id: pl.pick_list_id, item_id: pl.item_id });
    }
    const cogsQty = Math.max(0, Math.min(qty, Number(pl.picked_qty || 0) - billed.costed));
    prepared.push({ ...line, item_id: pl.item_id, pick_list_line_id: pl.id, unit_cost: cost.unit_cost, cogs_qty: cogsQty,
                    _so: pl.sales_order_id });
  }
  // The order-item rule (Phase 3G; also the trigger's): what is invoiced net of
  // releases across the order's dispatched pick lines of an item never exceeds
  // what shipped less what came back — a returned unit is not billable again,
  // even when a credit note released it.
  const groups = new Map();
  for (const p of prepared) {
    const k = `${p._so}:${p.item_id}`;
    groups.set(k, { so: p._so, item: p.item_id, qty: (groups.get(k)?.qty || 0) + Number(p.quantity) });
  }
  for (const g of groups.values()) {
    const { rows: [a] } = await client.query(`
      SELECT COALESCE(SUM(l.picked_qty), 0)::float AS shipped,
             COALESCE(SUM(pick_line_invoiced_qty(l.id)), 0)::float AS invoiced,
             so_item_returned_qty($1, $2)::float AS returned
        FROM pick_list_lines l JOIN pick_lists p ON p.id = l.pick_list_id
       WHERE p.sales_order_id = $1 AND l.item_id = $2 AND LOWER(COALESCE(p.status, '')) = 'dispatched'`, [g.so, g.item]);
    const billable = a.shipped - a.returned - a.invoiced;
    if (g.qty > billable + 1e-9) {
      throw fulfilmentError(409, 'FULFILMENT_RETURNED',
        `Item ${g.item} of order ${g.so}: ${a.shipped} shipped, ${a.returned} returned, ${a.invoiced} invoiced — ${Math.max(0, billable)} billable, ${g.qty} requested.`,
        { item_id: g.item, billable: Math.max(0, billable) });
    }
  }
  return prepared.map(({ _so, ...p }) => p);
}

class InvoiceService {
  // Credit-limit enforcement only ever guarded the direct manual POST
  // /finance/invoices route (finance.routes.js). Sales-order invoicing and
  // Project milestone invoicing were switched to call this service directly
  // (see the 2026-07-21 dual-ledger fix), which bypassed that middleware
  // entirely — same check, applied here so no caller can skip it.
  async checkCreditLimit(client, { customerId, partyId, totalAmount, companyId }) {
    const partyRef = customerId || partyId;
    if (!partyRef || !totalAmount) return;
    const { rows: [party] } = await client.query(
      'SELECT credit_limit, name FROM parties WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)',
      [partyRef, companyId ?? null]
    ).catch(() => ({ rows: [] }));
    if (!party || !party.credit_limit || parseFloat(party.credit_limit) <= 0) return;

    const { rows: [arRow] } = await client.query(`
      SELECT COALESCE(SUM(total_amount - COALESCE(paid_amount, 0)), 0) AS outstanding
      FROM invoices
      WHERE customer_id = $1 AND ($2::int IS NULL OR company_id = $2)
        AND LOWER(status) NOT IN ('paid','cancelled','draft')
    `, [partyRef, companyId ?? null]);

    const outstanding = parseFloat(arRow?.outstanding ?? 0);
    const thisInvoice  = parseFloat(totalAmount);
    const creditLimit  = parseFloat(party.credit_limit);
    const projectedTotal = outstanding + thisInvoice;
    if (projectedTotal > creditLimit) {
      throw Object.assign(new Error(
        `Credit limit exceeded for ${party.name}. Limit: ₹${creditLimit.toLocaleString('en-IN')}, Outstanding: ₹${outstanding.toLocaleString('en-IN')}, This Invoice: ₹${thisInvoice.toLocaleString('en-IN')}.`
      ), { status: 422, code: 'CREDIT_LIMIT_EXCEEDED', credit_limit: creditLimit, outstanding, this_invoice: thisInvoice, projected_total: projectedTotal });
    }
  }

  /**
   * Create an invoice, its lines, its journal and (for shipped goods) its COGS.
   * With `{ client }` it runs inside the caller's open transaction and the
   * caller commits — so an invoice and whatever the caller links to it are one
   * commit (sales-order invoicing). Without it, it owns its own transaction.
   */
  async createInvoice(data, userId, { client: outer = null } = {}) {
    // ── STOCK_LINE rule ──────────────────────────────────────────────────────
    // A line carrying item_id bills physical goods. Stock for warehouse sales
    // leaves when it is PICKED, so an invoice line may bill goods only by naming
    // the shipped pick-list line it bills (pick_list_line_id, migration
    // 20261027000003). Such a line moves no stock; it gets a COGS journal at the
    // pick's verified FIFO cost. A line with item_id and no pick line is still
    // refused: nothing would tell its goods apart from goods also picked in the
    // warehouse, and posting a stock-out for it could deduct them twice.
    // Nothing is written when this fires.
    const lines = Array.isArray(data?.items) ? data.items : [];
    const hasItem = (i) => i && i.item_id != null && String(i.item_id).trim() !== '';
    const hasPick = (i) => i && i.pick_list_line_id != null && String(i.pick_list_line_id).trim() !== '';
    const unlinked = lines.filter(i => hasItem(i) && !hasPick(i));
    if (unlinked.length) {
      throw Object.assign(new Error(
        `${unlinked.length} invoice line(s) carry item_id without pick_list_line_id. A line that bills goods must name `
        + 'the dispatched pick-list line it bills: stock leaves the warehouse when it is picked, and an invoice line '
        + 'that is not tied to that pick could deduct the same goods twice.'),
      { status: 422, code: 'STOCK_LINE_REQUIRES_FULFILMENT' });
    }
    const linked = lines.filter(hasPick);

    const client = outer || await pool.connect();
    try {
      if (!outer) await client.query('BEGIN');

      // Lines that bill shipped goods: locked, validated and costed before
      // anything is written (see prepareFulfilmentLines).
      const preparedLinked = linked.length
        ? await prepareFulfilmentLines(client, linked, { companyId: data.company_id, salesOrderId: data.sales_order_id })
        : [];
      const preparedById = new Map(preparedLinked.map(l => [Number(l.pick_list_line_id), l]));

      await this.checkCreditLimit(client, {
        customerId: data.customer_id, partyId: data.party_id,
        totalAmount: data.total_amount, companyId: data.company_id,
      });

      const invoiceNumber = await invoiceRepo.getNextNumber();

      // ── Derive GST heads server-side ────────────────────────────────────────
      // Intra-state (same state as company/Karnataka) → CGST + SGST (equal halves);
      // inter-state → IGST. If the client already supplied a split we keep it but
      // still validate consistency. Prevents client-side GST misclassification.
      const taxAmount = parseFloat(data.tax_amount || 0);
      let cgst = parseFloat(data.cgst) || 0;
      let sgst = parseFloat(data.sgst) || 0;
      let igst = parseFloat(data.igst) || 0;
      const cess = parseFloat(data.cess) || 0;
      let placeOfSupply = data.place_of_supply || null;

      if (taxAmount > 0 && cgst === 0 && sgst === 0 && igst === 0) {
        let gstin = data.party_gstin || null;
        const partyRef = data.party_id || data.customer_id || null;
        if ((!gstin || !placeOfSupply) && partyRef) {
          // party_id may be UUID or int depending on install — degrade gracefully.
          const { rows } = await client.query(
            'SELECT gstin, state FROM parties WHERE id = $1', [partyRef]
          ).catch(() => ({ rows: [] }));
          gstin = gstin || rows[0]?.gstin || null;
          placeOfSupply = placeOfSupply || rows[0]?.state || null;
        }
        const gstType = gstin ? detectGSTFromGSTIN(gstin) : detectGSTFromState(placeOfSupply);
        if (gstType === 'IGST') {
          igst = taxAmount;
        } else {
          cgst = Math.round((taxAmount / 2) * 100) / 100;
          sgst = Math.round((taxAmount - cgst) * 100) / 100; // remainder avoids paisa drift
        }
      }

      const gstCheck = validateGstSplit({ cgst, sgst, igst });
      if (!gstCheck.valid) {
        throw Object.assign(new Error(gstCheck.error), { status: 422 });
      }

      const invoice = await invoiceRepo.create(client, {
        ...data,
        invoice_number: invoiceNumber,
        created_by: userId,
        company_id: data.company_id ?? null,
        cgst, sgst, igst, cess, place_of_supply: placeOfSupply,
      });

      for (const item of data.items) {
        const prepared = item && item.pick_list_line_id != null ? preparedById.get(Number(item.pick_list_line_id)) : null;
        await invoiceRepo.createItem(client, {
          invoice_id: invoice.id,
          ...(prepared || item),
        });
      }
      if (preparedLinked.length) {
        // The order the shipped goods belong to, recorded on the invoice inside
        // the same transaction (invoiceRepo.create has no sales_order_id column).
        await client.query(`UPDATE invoices SET sales_order_id = $1 WHERE id = $2`, [data.sales_order_id, invoice.id]);
      }

      // Create journal entry
      const entryNumber = await journalRepo.getNextEntryNumber();
      const journalEntry = await journalRepo.createEntry(client, {
        entry_number: entryNumber,
        entry_date: data.invoice_date,
        entry_type: 'Invoice',
        reference_type: 'invoice',
        reference_id: invoice.id,
        description: `Invoice ${invoiceNumber}`,
        created_by: userId,
        company_id: data.company_id ?? invoice.company_id ?? null,
      });

      // DR: Accounts Receivable (full invoice amount)
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_code: '1010',
        description: `Invoice ${invoiceNumber}`,
        debit: invoice.total_amount,
        credit: 0
      });

      // CR: Sales Revenue (taxable value only)
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_code: data.revenue_account_code || '4001',
        description: `Revenue — Invoice ${invoiceNumber}`,
        debit: 0,
        credit: invoice.subtotal
      });

      // CR: GST payable — split by head (persisted on the invoice above).
      const jCgst = parseFloat(invoice.cgst || 0);
      const jSgst = parseFloat(invoice.sgst || 0);
      const jIgst = parseFloat(invoice.igst || 0);

      if (jCgst > 0) {
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_code: '2010',
          description: `CGST — Invoice ${invoiceNumber}`,
          debit: 0,
          credit: jCgst
        });
      }
      if (jSgst > 0) {
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_code: '2011',
          description: `SGST — Invoice ${invoiceNumber}`,
          debit: 0,
          credit: jSgst
        });
      }
      if (jIgst > 0) {
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_code: '2012',
          description: `IGST — Invoice ${invoiceNumber}`,
          debit: 0,
          credit: jIgst
        });
      }

      await journalRepo.postEntry(client, journalEntry.id);
      await invoiceRepo.linkJournalEntry(client, invoice.id, journalEntry.id);
      await invoiceRepo.updateStatus(client, invoice.id, 'Sent');

      // COGS for lines that bill goods the warehouse shipped: the journal at the
      // pick's verified cost, and NO stock movement — the pick already moved it.
      if (preparedLinked.length) {
        // Only the units not costed before (cogs_qty): a quantity released by a
        // credit note and billed again was expensed the first time.
        await cogsService.createForFulfilledInvoice(client, {
          invoice_id:     invoice.id,
          invoice_number: invoiceNumber,
          entry_date:     data.invoice_date,
          items:          preparedLinked.filter(l => l.cogs_qty > 0).map(l => ({ ...l, quantity: l.cogs_qty })),
          created_by:     userId,
          company_id:     invoice.company_id ?? data.company_id ?? null,
        });
      }

      // Unlinked stock lines are refused by the STOCK_LINE rule above, so this
      // finds nothing to cost today; it is kept for the service-line contract.
      await cogsService.createForInvoice(client, {
        invoice_id:     invoice.id,
        invoice_number: invoiceNumber,
        dispatch_date:  data.invoice_date,
        items:          data.items.filter(i => !(i && i.pick_list_line_id != null)),
        created_by:     userId,
        company_id:     invoice.company_id ?? data.company_id ?? null,
      });

      if (outer) {
        const { rows: [row] } = await client.query(`SELECT * FROM invoices WHERE id = $1`, [invoice.id]);
        return row;
      }
      await client.query('COMMIT');
      return await invoiceRepo.findById(invoice.id);
    } catch (error) {
      if (!outer) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!outer) client.release();
    }
  }

  async getInvoices(filters) {
    return await invoiceRepo.findAll(filters);
  }

  async getInvoiceById(id, companyId = null) {
    const invoice = await invoiceRepo.findById(id, companyId);
    if (invoice) {
      invoice.items = await invoiceRepo.getItems(id);
    }
    return invoice;
  }

  async getOverdueInvoices(companyId = null) {
    return await invoiceRepo.getOverdue(companyId);
  }

  async getDueSoonInvoices(days = 7, companyId = null) {
    return await invoiceRepo.getDueSoon(days, companyId);
  }
}

export default new InvoiceService();
