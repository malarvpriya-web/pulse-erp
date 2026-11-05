/**
 * cogsJournal.service.js
 *
 * Generates Cost of Goods Sold journal entries when finished goods are dispatched.
 *
 * Journal entry, ONE debit/credit pair per distinct account mapping:
 *   DR  <item.expense_account_id   | default 5001>  Cost of Goods Sold
 *   CR  <item.inventory_account_id | default 1032>  Inventory Asset
 *
 * The per-item mapping resolves for real as of migration 20260915000005, which
 * retyped those columns from INTEGER to uuid with a foreign key. Before that
 * the comparison was `uuid = integer`, which Postgres rejects, and a swallowed
 * error sent every item to the defaults — see the note on _resolveAccounts.
 *
 * Stock ledger is the SOLE source of truth for quantity. This service writes a
 * stock_ledger OUT entry; it does NOT touch inventory_items.current_stock
 * (removed dual-tracking).
 *
 * ── THREE DEFECTS THIS FILE USED TO HAVE (finance audit F17) ────────────────
 *
 * 1. SILENT OMISSION. `items.filter(i => i.item_id && unit_cost > 0)` dropped
 *    every stock line whose cost was missing or zero and posted the rest. COGS
 *    came out understated by an arbitrary amount with nothing logged, no error,
 *    and a journal that still balanced — so nothing downstream could detect it.
 *    A stock line with no cost is now an error that names the offending items.
 *    Lines with no item_id are service/charge lines and are still skipped, which
 *    is correct rather than silent.
 *
 * 2. COLLAPSED ACCOUNT MAPPINGS. The whole invoice was posted against the FIRST
 *    item's accounts — `_resolveAccounts(client, cogsItems[0].item_id)`. An
 *    invoice mixing items mapped to different COGS or inventory accounts put
 *    every rupee into the first item's pair, so per-account inventory and cost
 *    balances were wrong even though the entry balanced. Items are now grouped
 *    by their actual (cogs, inventory) pair and each group gets its own line
 *    pair. Items with no mapping of their own fall back to the defaults, so an
 *    invoice of unmapped items still produces exactly one group.
 *
 * 3. A STOCK BALANCE THAT LIED. `Math.max(0, balance - qty)` clamped the running
 *    balance at zero, so dispatching 10 of an item that had 3 recorded a balance
 *    of 0 rather than -7 — the shortfall vanished from the ledger and the next
 *    movement computed from a figure that was never true. The real balance is
 *    now recorded, and the item row is locked first so two concurrent dispatches
 *    cannot both read the same starting balance.
 *
 *    Recording a negative balance is deliberate and is NOT the same as allowing
 *    one: whether a dispatch may exceed stock on hand is an inventory policy
 *    with backorder implications, and it is not this service's call to invent.
 *    A shortfall is written truthfully and logged loudly; a hard availability
 *    lock belongs with the inventory module review the audit called for.
 */

import pool from '../db.js';
import journalRepo from '../repositories/journal.repository.js';

const DEFAULT_COGS_CODE = '5001';
const DEFAULT_INVENTORY_CODE = '1032';

class CogsJournalService {

  /**
   * COGS + inventory account codes for one item, falling back to the defaults.
   * Also returns the item's name so errors and narrations can identify it.
   *
   * This mapping could not resolve at all until migration 20260915000005.
   * `inventory_items.expense_account_id` and `.inventory_account_id` were
   * INTEGER with no foreign key while `chart_of_accounts.id` is a UUID, so the
   * original lookup —
   *
   *     SELECT code FROM chart_of_accounts WHERE id = inventory_items.expense_account_id
   *
   * — was rejected by Postgres as `uuid = integer` on every call, and a bare
   * catch swallowed the error and returned the defaults. Every item posted to
   * 5001/1032 regardless of configuration, while the item form happily stored
   * values that were then ignored. The columns are now uuid with a foreign key,
   * so the join is real and _groupByMapping can finally produce more than one
   * group. An item with no mapping still falls back to the defaults, which is
   * the normal case rather than an error.
   */
  async _resolveAccounts(client, item_id) {
    if (!item_id) {
      return { cogsCode: DEFAULT_COGS_CODE, inventoryCode: DEFAULT_INVENTORY_CODE, itemName: null };
    }
    try {
      const { rows: [item] } = await client.query(
        `SELECT
           ii.item_name AS item_name,
           exp.code  AS cogs_code,
           inv.code  AS inventory_code,
           ii.expense_account_id,
           ii.inventory_account_id,
           exp.is_active AS exp_active,
           inv.is_active AS inv_active
         FROM inventory_items ii
         LEFT JOIN chart_of_accounts exp ON exp.id = ii.expense_account_id
         LEFT JOIN chart_of_accounts inv ON inv.id = ii.inventory_account_id
        WHERE ii.id = $1`,
        [item_id]
      );
      if (!item) {
        return { cogsCode: DEFAULT_COGS_CODE, inventoryCode: DEFAULT_INVENTORY_CODE, itemName: null };
      }

      // A mapping that points at a missing or inactive account is reported, not
      // used — silently substituting the default is how the old behaviour hid.
      const cogsUsable = item.cogs_code && item.exp_active !== false;
      const invUsable  = item.inventory_code && item.inv_active !== false;
      if (item.expense_account_id && !cogsUsable) {
        this._warnUnusableMapping(item_id, item, 'expense_account_id');
      }
      if (item.inventory_account_id && !invUsable) {
        this._warnUnusableMapping(item_id, item, 'inventory_account_id');
      }

      return {
        cogsCode:      cogsUsable ? item.cogs_code      : DEFAULT_COGS_CODE,
        inventoryCode: invUsable  ? item.inventory_code : DEFAULT_INVENTORY_CODE,
        itemName:      item.item_name ?? null,
      };
    } catch (err) {
      console.warn(`[cogsJournal] could not read item ${item_id} for account mapping: ${err.message}`);
      return { cogsCode: DEFAULT_COGS_CODE, inventoryCode: DEFAULT_INVENTORY_CODE, itemName: null };
    }
  }

  _warnUnusableMapping(itemId, item, column) {
    this._warned ??= new Set();
    const key = itemId + ':' + column;
    if (this._warned.has(key)) return;
    this._warned.add(key);
    console.warn(
      `[cogsJournal] item ${itemId} (${item.item_name ?? 'unnamed'}) maps ${column} to an account ` +
      `that is missing or inactive. Posting that side to the default instead.`
    );
  }
  /**
   * Split the supplied lines into the ones that carry cost, the stock lines that
   * are missing it, and the non-stock lines that were never COGS in the first
   * place. Throws on the middle group rather than dropping it.
   */
  _partition(items, context) {
    const stock = items.filter(i => i.item_id);
    const nonStock = items.filter(i => !i.item_id);
    const costed = stock.filter(i => parseFloat(i.unit_cost || 0) > 0 && parseFloat(i.quantity || 0) !== 0);
    const uncosted = stock.filter(i => !(parseFloat(i.unit_cost || 0) > 0) && parseFloat(i.quantity || 0) !== 0);

    if (uncosted.length) {
      const named = uncosted.map(i => `item ${i.item_id}${i.description ? ` (${i.description})` : ''}`).join(', ');
      const e = new Error(
        `Cannot post COGS for ${context}: ${uncosted.length} stock line(s) have no unit cost — ${named}. ` +
        `Set a valuation for these items, or remove them from the dispatch. ` +
        `They used to be dropped silently, which understated cost of goods sold.`
      );
      e.status = 400;
      e.code = 'COGS_MISSING_COST';
      throw e;
    }
    return { costed, nonStock };
  }

  /**
   * Group costed lines by their ACTUAL (cogs, inventory) account pair.
   * Returns [{ cogsCode, inventoryCode, amount, itemNames }].
   */
  async _groupByMapping(client, costedItems) {
    const groups = new Map();
    for (const item of costedItems) {
      const { cogsCode, inventoryCode, itemName } = await this._resolveAccounts(client, item.item_id);
      const key = `${cogsCode}|${inventoryCode}`;
      const amount = Math.round(parseFloat(item.unit_cost) * parseFloat(item.quantity) * 100) / 100;
      const existing = groups.get(key);
      if (existing) {
        existing.amount = Math.round((existing.amount + amount) * 100) / 100;
        if (itemName) existing.itemNames.push(itemName);
      } else {
        groups.set(key, { cogsCode, inventoryCode, amount, itemNames: itemName ? [itemName] : [] });
      }
    }
    // A group that nets to zero would post a 0/0 line pair, which postingGuards
    // rejects as a zero-value entry. Drop those rather than fail the dispatch.
    return [...groups.values()].filter(g => g.amount !== 0);
  }

  /** Write the DR/CR pair for each mapping group onto an existing entry. */
  async _writeGroupLines(client, entryId, groups, label) {
    for (const g of groups) {
      const suffix = g.itemNames.length ? ` (${[...new Set(g.itemNames)].slice(0, 3).join(', ')}${g.itemNames.length > 3 ? '…' : ''})` : '';
      await journalRepo.createLine(client, {
        journal_entry_id: entryId,
        account_code:     g.cogsCode,
        description:      `COGS — ${label}${suffix}`,
        debit:            g.amount,
        credit:           0,
      });
      await journalRepo.createLine(client, {
        journal_entry_id: entryId,
        account_code:     g.inventoryCode,
        description:      `Inventory dispatched — ${label}${suffix}`,
        debit:            0,
        credit:           g.amount,
      });
    }
  }

  /**
   * Write one stock_ledger OUT row per item.
   *
   * The inventory_items row is locked FOR UPDATE before the balance is read, so
   * two dispatches of the same item serialise instead of both computing from the
   * same starting figure and writing the same balance_qty.
   */
  async _writeStockOut(client, items, { referenceType, referenceId, dispatchDate, createdBy, companyId }) {
    for (const item of items) {
      const qty = parseFloat(item.quantity);
      const rate = parseFloat(item.unit_cost);

      await client.query('SELECT id FROM inventory_items WHERE id = $1 FOR UPDATE', [item.item_id]);

      const { rows: [bal] } = await client.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance
           FROM stock_ledger WHERE item_id = $1`,
        [item.item_id]
      );
      // The true balance, not a clamped one. See note 3 at the top of this file.
      const newBalance = Math.round((parseFloat(bal.balance) - qty) * 10000) / 10000;
      if (newBalance < 0) {
        console.warn(
          `[cogsJournal] item ${item.item_id} dispatched below stock on hand on ${referenceType} ` +
          `${referenceId}: had ${bal.balance}, dispatching ${qty}, balance now ${newBalance}.`
        );
      }

      await client.query(
        `INSERT INTO stock_ledger
           (item_id, transaction_type, quantity_in, quantity_out, balance_qty,
            rate, value, reference_type, reference_id, transaction_date, created_by, company_id)
         VALUES ($1, 'sales_dispatch', 0, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          item.item_id, qty, newBalance, rate,
          Math.round(qty * rate * 100) / 100,
          referenceType, referenceId, dispatchDate, createdBy || null, companyId ?? null,
        ]
      );
    }
  }

  /**
   * Create a COGS journal entry for dispatched items on invoice.
   *
   * @param {object} client  - pg transaction client
   * @param {object} params
   * @param {number} params.invoice_id
   * @param {string} params.invoice_number
   * @param {string} params.dispatch_date   - ISO date string
   * @param {Array}  params.items           - [{ item_id, quantity, unit_cost }]
   * @param {number} params.created_by
   * @param {number} [params.company_id]
   */
  async createForInvoice(client, { invoice_id, invoice_number, dispatch_date, items, created_by, company_id }) {
    if (!items || items.length === 0) return null;

    const { costed } = this._partition(items, `invoice ${invoice_number}`);
    if (costed.length === 0) return null;

    const groups = await this._groupByMapping(client, costed);
    if (groups.length === 0) return null;

    const entryNumber = await journalRepo.getNextEntryNumber();
    const journalEntry = await journalRepo.createEntry(client, {
      entry_number:   entryNumber,
      entry_date:     dispatch_date,
      entry_type:     'COGS',
      reference_type: 'invoice',
      reference_id:   invoice_id,
      description:    `COGS — Invoice ${invoice_number}`,
      created_by,
      company_id,
    });

    await this._writeGroupLines(client, journalEntry.id, groups, `Invoice ${invoice_number}`);
    await journalRepo.postEntry(client, journalEntry.id);

    await this._writeStockOut(client, costed, {
      referenceType: 'invoice',
      referenceId:   invoice_id,
      dispatchDate:  dispatch_date,
      createdBy:     created_by,
      companyId:     journalEntry.company_id ?? company_id,
    });

    return journalEntry;
  }

  /**
   * COGS for an invoice whose lines bill goods the WAREHOUSE already shipped
   * (invoice lines linked to pick-list lines). Same journal as createForInvoice
   * — entry_type 'COGS', reference 'invoice', one DR COGS / CR Inventory pair
   * per account mapping — but it writes NO stock movement: the pick moved the
   * stock, and moving it again here is exactly the double deduction the
   * STOCK_LINE rule exists to prevent. `items` carry the verified fulfilment
   * unit cost (pickListWorkflow.fulfilmentCost), never an estimate.
   */
  async createForFulfilledInvoice(client, { invoice_id, invoice_number, entry_date, items, created_by, company_id }) {
    if (!items || items.length === 0) return null;
    const { costed } = this._partition(items, `invoice ${invoice_number}`);
    if (costed.length === 0) return null;
    const groups = await this._groupByMapping(client, costed);
    if (groups.length === 0) return null;

    const entryNumber = await journalRepo.getNextEntryNumber();
    const journalEntry = await journalRepo.createEntry(client, {
      entry_number:   entryNumber,
      entry_date,
      entry_type:     'COGS',
      reference_type: 'invoice',
      reference_id:   invoice_id,
      description:    `COGS — Invoice ${invoice_number} (warehouse-fulfilled)`,
      created_by,
      company_id,
    });
    await this._writeGroupLines(client, journalEntry.id, groups, `Invoice ${invoice_number}`);
    await journalRepo.postEntry(client, journalEntry.id);
    return journalEntry;
  }

  /**
   * Create a COGS entry from a standalone dispatch event (e.g., delivery order).
   */
  async createForDispatch(client, { reference_id, reference_type = 'delivery', dispatch_date, items, created_by, description, company_id }) {
    if (!items || items.length === 0) return null;

    const label = description || 'dispatch';
    const { costed } = this._partition(items, label);
    if (costed.length === 0) return null;

    const groups = await this._groupByMapping(client, costed);
    if (groups.length === 0) return null;

    const entryNumber = await journalRepo.getNextEntryNumber();
    const journalEntry = await journalRepo.createEntry(client, {
      entry_number:   entryNumber,
      entry_date:     dispatch_date,
      entry_type:     'COGS',
      reference_type,
      reference_id,
      description:    description || 'COGS dispatch',
      created_by,
      company_id,
    });

    await this._writeGroupLines(client, journalEntry.id, groups, label);
    await journalRepo.postEntry(client, journalEntry.id);

    // This path wrote NO stock_ledger movement: the journal recognised the
    // cost while the quantity stayed on the books. It has no callers today, so
    // nothing double-counts by adding it — it is here so that whoever wires up
    // delivery-order dispatch gets the movement rather than rediscovering the
    // gap. If a future caller writes its own stock_ledger row, delete this call
    // rather than letting both run.
    await this._writeStockOut(client, costed, {
      referenceType: reference_type,
      referenceId:   reference_id,
      dispatchDate:  dispatch_date,
      createdBy:     created_by,
      companyId:     journalEntry.company_id ?? company_id,
    });

    return journalEntry;
  }
}

export default new CogsJournalService();
