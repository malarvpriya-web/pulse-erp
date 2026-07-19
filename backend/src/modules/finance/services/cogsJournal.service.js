/**
 * cogsJournal.service.js
 *
 * Generates Cost of Goods Sold journal entries when finished goods are dispatched.
 *
 * Journal entry:
 *   DR  <item.expense_account_id  | fallback 5001>  Cost of Goods Sold
 *   CR  <item.inventory_account_id | fallback 1032>  Inventory Asset
 *
 * Stock ledger is the SOLE source of truth for quantity.
 * This service writes a stock_ledger OUT entry; it does NOT touch
 * inventory_items.current_stock (removed dual-tracking).
 */

import pool from '../db.js';
import journalRepo from '../repositories/journal.repository.js';

class CogsJournalService {

  async _resolveAccounts(client, item_id) {
    if (!item_id) return { cogsCode: '5001', inventoryCode: '1032' };
    try {
      const { rows: [item] } = await client.query(
        `SELECT
           COALESCE(
             (SELECT code FROM chart_of_accounts WHERE id = inventory_items.expense_account_id LIMIT 1),
             '5001'
           ) AS cogs_code,
           COALESCE(
             (SELECT code FROM chart_of_accounts WHERE id = inventory_items.inventory_account_id LIMIT 1),
             '1032'
           ) AS inventory_code
         FROM inventory_items WHERE id = $1`,
        [item_id]
      );
      return { cogsCode: item?.cogs_code || '5001', inventoryCode: item?.inventory_code || '1032' };
    } catch {
      return { cogsCode: '5001', inventoryCode: '1032' };
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
   */
  async createForInvoice(client, { invoice_id, invoice_number, dispatch_date, items, created_by }) {
    if (!items || items.length === 0) return null;

    const cogsItems = items.filter(i => i.item_id && parseFloat(i.unit_cost || 0) > 0);
    if (cogsItems.length === 0) return null;

    const totalCogs = cogsItems.reduce((s, i) => s + parseFloat(i.unit_cost) * parseFloat(i.quantity), 0);
    const roundedCogs = Math.round(totalCogs * 100) / 100;

    // Resolve account codes from item master (use first item's accounts for the journal header)
    const { cogsCode, inventoryCode } = await this._resolveAccounts(client, cogsItems[0].item_id);

    const entryNumber = await journalRepo.getNextEntryNumber();
    const journalEntry = await journalRepo.createEntry(client, {
      entry_number:   entryNumber,
      entry_date:     dispatch_date,
      entry_type:     'COGS',
      reference_type: 'invoice',
      reference_id:   invoice_id,
      description:    `COGS — Invoice ${invoice_number}`,
      created_by,
    });

    await journalRepo.createLine(client, {
      journal_entry_id: journalEntry.id,
      account_code:     cogsCode,
      description:      `COGS dispatch — Invoice ${invoice_number}`,
      debit:            roundedCogs,
      credit:           0,
    });

    await journalRepo.createLine(client, {
      journal_entry_id: journalEntry.id,
      account_code:     inventoryCode,
      description:      `Inventory dispatched — Invoice ${invoice_number}`,
      debit:            0,
      credit:           roundedCogs,
    });

    await journalRepo.postEntry(client, journalEntry.id);

    // Write stock_ledger OUT entry — stock_ledger is sole source of truth
    for (const item of cogsItems) {
      const qty = parseFloat(item.quantity);
      const rate = parseFloat(item.unit_cost);

      // Calculate running balance
      const { rows: [bal] } = await client.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS balance
           FROM stock_ledger WHERE item_id = $1`,
        [item.item_id]
      );
      const newBalance = Math.max(0, parseFloat(bal.balance) - qty);

      await client.query(
        `INSERT INTO stock_ledger
           (item_id, transaction_type, quantity_in, quantity_out, balance_qty,
            rate, value, reference_type, reference_id, transaction_date, created_by)
         VALUES ($1, 'sales_dispatch', 0, $2, $3, $4, $5, 'invoice', $6, $7, $8)`,
        [
          item.item_id, qty, newBalance, rate,
          Math.round(qty * rate * 100) / 100,
          invoice_id, dispatch_date, created_by || null,
        ]
      );
    }

    return journalEntry;
  }

  /**
   * Create a COGS entry from a standalone dispatch event (e.g., delivery order).
   */
  async createForDispatch(client, { reference_id, reference_type = 'delivery', dispatch_date, items, created_by, description }) {
    if (!items || items.length === 0) return null;

    const cogsItems = items.filter(i => i.item_id && parseFloat(i.unit_cost || 0) > 0);
    if (cogsItems.length === 0) return null;

    const totalCogs = cogsItems.reduce((s, i) => s + parseFloat(i.unit_cost) * parseFloat(i.quantity), 0);
    const roundedCogs = Math.round(totalCogs * 100) / 100;

    const { cogsCode, inventoryCode } = await this._resolveAccounts(client, cogsItems[0].item_id);

    const entryNumber = await journalRepo.getNextEntryNumber();
    const journalEntry = await journalRepo.createEntry(client, {
      entry_number:   entryNumber,
      entry_date:     dispatch_date,
      entry_type:     'COGS',
      reference_type,
      reference_id,
      description:    description || 'COGS dispatch',
      created_by,
    });

    await journalRepo.createLine(client, {
      journal_entry_id: journalEntry.id,
      account_code:     cogsCode,
      description:      `COGS — ${description || 'dispatch'}`,
      debit:            roundedCogs,
      credit:           0,
    });

    await journalRepo.createLine(client, {
      journal_entry_id: journalEntry.id,
      account_code:     inventoryCode,
      description:      `Inventory dispatched — ${description || ''}`,
      debit:            0,
      credit:           roundedCogs,
    });

    await journalRepo.postEntry(client, journalEntry.id);
    return journalEntry;
  }
}

export default new CogsJournalService();
