/**
 * serviceParts.js — the missing half of the §74 chain.
 *
 * WHAT THIS CLOSES
 * ----------------
 * Phase 4 delivered the left-hand half of the business loop:
 *
 *     telemetry -> alert -> incident -> service ticket -> technician
 *
 * and stopped. The right-hand half — what the technician actually DID, what it
 * consumed, what it cost and what it changed about the machine — existed nowhere.
 * A ticket could be closed with a fan replaced and Pulse would show: no stock
 * movement, no change to the equipment's component history, and no cost. The
 * spare simply evaporated from inventory's point of view.
 *
 * This module completes it:
 *
 *     ... -> technician -> PART REPLACED
 *                            |
 *          +-----------------+------------------+---------------+
 *          |                 |                  |               |
 *    spare_parts       stock_ledger       serial_events   journal_entries
 *    (issue, stock      (item-level        (genealogy:     (Dr warranty or
 *     decremented)       ledger line)       component       repairs expense
 *                                           replaced on     Cr stores & spares
 *                                           this serial)    inventory)
 *          |                 |                  |               |
 *          +-----------------+------------------+---------------+
 *                            |
 *              iot_service_parts (the join row, holding every id above)
 *                            |
 *              iot_device_events PART_REPLACED  -> equipment history
 *              support_tickets.parts_cost       -> job costing
 *
 * NOTHING HERE IS A PARALLEL INVENTORY. Every write lands in the table that
 * module already owns, using its own vocabulary: `spare_parts_movements` with
 * movement_type 'issue', `stock_ledger` with a quantity_out line,
 * `serial_events` against the equipment's own serial, and a balanced
 * `journal_entries` + `journal_lines` pair using the existing chart of accounts.
 *
 * ACCOUNTING
 *   Consuming a spare on a service job moves value out of inventory into expense:
 *
 *     Dr  5052 Warranty Cost            (cover = warranty | amc)
 *     Dr  5024 Repairs & Maintenance    (cover = chargeable | goodwill)
 *         Cr  1034 Stores & Spares Inventory
 *
 *   Which expense account is used depends on who bears the cost, and that is
 *   decided by the equipment's cover at the time of the job — not by a default.
 *   The entry is created as `draft`, exactly like every other auto-entry in
 *   accounting.routes.js, so finance posts it rather than having IoT post
 *   directly into the ledger.
 *
 * ATOMICITY
 *   All of it in ONE transaction. A part issue that decremented stock but failed
 *   to write genealogy would be worse than one that failed entirely: the second
 *   is visible, the first is a silent divergence between two sources of truth.
 */

import pool from '../../config/db.js';
import { recordEvent } from './deviceEvents.js';
import { nextAccountingJournalNumber } from '../../shared/docNumber.js';

/** Which expense account bears the cost, by cover type. */
const EXPENSE_ACCOUNT = {
  warranty: '5052',    // Warranty Cost — the company bears it
  amc: '5052',         // AMC is a pre-sold warranty; same treatment
  goodwill: '5024',    // Repairs & Maintenance — a discretionary write-off
  chargeable: '5024',  // Repairs & Maintenance — recovered on the service invoice
};
const INVENTORY_ACCOUNT = '1034';   // Stores & Spares Inventory

/**
 * Decide the cover for a job from the equipment's own contract state.
 * Explicitly passed cover wins, because a service manager can legitimately
 * declare a goodwill repair on an out-of-warranty unit.
 */
export function resolveCover(equipment, requested = null) {
  if (requested) return requested;
  if (String(equipment?.amc_status || '').toLowerCase() === 'active') return 'amc';
  if (String(equipment?.warranty_status || '').toLowerCase() === 'active') return 'warranty';
  return 'chargeable';
}

async function accountsByCode(db, companyId, codes) {
  const { rows } = await db.query(
    `SELECT id, code, name FROM chart_of_accounts
      WHERE code = ANY($1) AND deleted_at IS NULL
        AND (company_id = $2 OR company_id IS NULL)
      ORDER BY company_id NULLS LAST`,
    [codes, companyId],
  );
  const map = {};
  for (const a of rows) if (!map[a.code]) map[a.code] = a;   // company row wins
  return map;
}

/**
 * Issue a spare part against an IoT-originated service job.
 *
 * @param {object} opts
 * @param {number} opts.companyId
 * @param {number} opts.equipmentId
 * @param {number} opts.partId
 * @param {number} opts.quantity
 * @param {number|null} opts.ticketId
 * @param {number|null} opts.alertId
 * @param {string|null} opts.removedSerial   serial of the component coming OUT
 * @param {string|null} opts.fittedSerial    serial of the component going IN
 * @param {string|null} opts.cover           warranty | amc | chargeable | goodwill
 * @param {string|null} opts.reason
 * @param {number|null} opts.userId
 * @returns {Promise<object>} the iot_service_parts row with every downstream id
 */
export async function issuePart(opts) {
  const {
    companyId, equipmentId, partId, quantity,
    ticketId = null, alertId = null,
    removedSerial = null, fittedSerial = null,
    cover: requestedCover = null, reason = null, userId = null,
  } = opts;

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, code: 'BAD_QUANTITY', error: 'quantity must be a positive number' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Lock the equipment and the part, in a fixed order ──────────────────
    // Equipment first, then part — the same ordering discipline the ingest path
    // uses, so a concurrent part issue and a concurrent telemetry batch on the
    // same device cannot deadlock against each other.
    const { rows: eqRows } = await client.query(
      `SELECT id, company_id, equipment_name, serial_number, project_id, crm_account_id,
              amc_contract_id, amc_status, warranty_status
         FROM customer_equipment WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [equipmentId, companyId],
    );
    const equipment = eqRows[0];
    if (!equipment) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'EQUIPMENT_NOT_FOUND', error: 'equipment not found in this company' };
    }

    const { rows: partRows } = await client.query(
      `SELECT id, part_code, name, stock_qty, unit_cost, unit, company_id
         FROM spare_parts WHERE id = $1 AND (company_id = $2 OR company_id IS NULL) FOR UPDATE`,
      [partId, companyId],
    );
    const part = partRows[0];
    if (!part) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'PART_NOT_FOUND', error: 'spare part not found in this company' };
    }

    const stockBefore = Number(part.stock_qty) || 0;
    if (stockBefore < qty) {
      // Refused, not allowed to go negative. A negative spare stock is the kind of
      // number that gets explained away for months.
      await client.query('ROLLBACK');
      return {
        ok: false, code: 'INSUFFICIENT_STOCK',
        error: `only ${stockBefore} ${part.unit || 'unit(s)'} of ${part.part_code} in stock, ${qty} requested`,
      };
    }
    const stockAfter = stockBefore - qty;
    const unitCost = Number(part.unit_cost) || 0;
    const totalCost = Number((unitCost * qty).toFixed(4));
    const cover = resolveCover(equipment, requestedCover);

    // ── 2. Spare-parts stock movement ─────────────────────────────────────────
    const { rows: movRows } = await client.query(
      `INSERT INTO spare_parts_movements
         (part_id, movement_type, quantity, reference_type, reference_id,
          unit_cost, total_cost, stock_before, stock_after, remarks, done_by, company_id)
       VALUES ($1,'issue',$2,'iot_service',$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [part.id, qty, ticketId, unitCost, totalCost, stockBefore, stockAfter,
       `IoT service on ${equipment.equipment_name}${reason ? ' — ' + reason : ''}`.slice(0, 500),
       userId != null ? String(userId) : null, companyId],
    );
    await client.query(`UPDATE spare_parts SET stock_qty = $2, updated_at = NOW() WHERE id = $1`, [part.id, stockAfter]);

    // ── 3. Stock ledger line ──────────────────────────────────────────────────
    // spare_parts and inventory_items are separate registries in this schema, so
    // the ledger line is written only when the spare maps to an inventory item by
    // code. Where it does not, that is stated on the returned row rather than
    // being silently skipped.
    let stockLedgerId = null;
    let ledgerNote = null;
    const { rows: itemRows } = await client.query(
      `SELECT id, current_stock FROM inventory_items
        WHERE (item_code = $1 OR item_name = $2) AND company_id = $3 AND deleted_at IS NULL
        LIMIT 1`,
      [part.part_code, part.name, companyId],
    ).catch(() => ({ rows: [] }));

    if (itemRows.length) {
      const balance = Number(itemRows[0].current_stock ?? 0) - qty;
      const { rows: slRows } = await client.query(
        `INSERT INTO stock_ledger
           (item_id, transaction_type, quantity_in, quantity_out, balance_qty, rate, value,
            reference_type, reference_id, transaction_date, remarks, created_by, company_id)
         VALUES ($1,'issue',0,$2,$3,$4,$5,'iot_service',$6,CURRENT_DATE,$7,$8,$9)
         RETURNING id`,
        [itemRows[0].id, qty, balance, unitCost, totalCost, ticketId,
         `IoT service part issue for ${equipment.equipment_name}`, userId, companyId],
      );
      stockLedgerId = slRows[0].id;
    } else {
      ledgerNote = `spare '${part.part_code}' has no matching inventory_items row, so no stock_ledger line was written`;
    }

    // ── 4. Serial genealogy ───────────────────────────────────────────────────
    // The equipment's serial is the parent record; a component swap is an event
    // on it. Without this, "what is inside this unit today" is unanswerable.
    let serialEventId = null;
    let genealogyNote = null;
    if (equipment.serial_number) {
      const { rows: snRows } = await client.query(
        `SELECT id FROM serial_numbers
          WHERE serial_number = $1 AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [equipment.serial_number, companyId],
      );
      if (snRows.length) {
        const description = [
          `Component replaced during IoT-originated service`,
          `Part: ${part.part_code} (${part.name}) x${qty}`,
          removedSerial ? `Removed: ${removedSerial}` : null,
          fittedSerial ? `Fitted: ${fittedSerial}` : null,
          `Cover: ${cover}`,
          reason || null,
        ].filter(Boolean).join('. ');
        const { rows: seRows } = await client.query(
          `INSERT INTO serial_events
             (serial_id, event_type, event_date, description, performed_by, reference_type, reference_id)
           VALUES ($1,'COMPONENT_REPLACED',CURRENT_DATE,$2,$3,'iot_service',$4)
           RETURNING id`,
          [snRows[0].id, description.slice(0, 2000), userId, ticketId],
        );
        serialEventId = seRows[0].id;
      } else {
        genealogyNote = `equipment serial '${equipment.serial_number}' has no serial_numbers master row, so no genealogy event was written`;
      }
    } else {
      genealogyNote = 'equipment has no serial number recorded, so genealogy cannot be updated';
    }

    // ── 5. Financial posting ──────────────────────────────────────────────────
    let journalEntryId = null;
    let financeNote = null;
    if (totalCost > 0) {
      const expenseCode = EXPENSE_ACCOUNT[cover] || EXPENSE_ACCOUNT.chargeable;
      const accts = await accountsByCode(client, companyId, [expenseCode, INVENTORY_ACCOUNT]);
      if (accts[expenseCode] && accts[INVENTORY_ACCOUNT]) {
        const entryNumber = await nextAccountingJournalNumber(client);
        const narration = `IoT service: ${part.part_code} x${qty} on ${equipment.equipment_name}${ticketId ? ` (ticket #${ticketId})` : ''}`;
        const { rows: jeRows } = await client.query(
          `INSERT INTO journal_entries
             (entry_number, entry_date, description, entry_type, reference_type, reference_id,
              status, total_debit, total_credit, company_id, created_by)
           VALUES ($1, CURRENT_DATE, $2, 'auto', 'iot_service', $3, 'draft', $4, $4, $5, $6)
           RETURNING id`,
          [entryNumber, narration.slice(0, 500), ticketId != null ? String(ticketId) : null, totalCost, companyId, userId],
        );
        journalEntryId = jeRows[0].id;
        for (const line of [
          { acct: accts[expenseCode], debit: totalCost, credit: 0 },
          { acct: accts[INVENTORY_ACCOUNT], debit: 0, credit: totalCost },
        ]) {
          await client.query(
            `INSERT INTO journal_lines
               (entry_id, account_id, account_code, account_name, debit, credit, narration, project_id, company_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [journalEntryId, line.acct.id, line.acct.code, line.acct.name,
             line.debit, line.credit, narration.slice(0, 500), equipment.project_id, companyId],
          );
        }
      } else {
        financeNote = `chart of accounts is missing ${expenseCode} or ${INVENTORY_ACCOUNT}, so no journal entry was created`;
      }
    } else {
      financeNote = 'part has no unit cost recorded, so there is nothing to post';
    }

    // ── 6. Ticket job costing ─────────────────────────────────────────────────
    if (ticketId) {
      await client.query(
        `UPDATE support_tickets
            SET parts_cost = COALESCE(parts_cost, 0) + $2, updated_at = NOW()
          WHERE id = $1 AND company_id = $3`,
        [ticketId, totalCost, companyId],
      ).catch(() => {});
    }

    // ── 7. Equipment history ──────────────────────────────────────────────────
    const deviceEventId = await recordEvent(client, {
      companyId, equipmentId: equipment.id, eventType: 'PART_REPLACED',
      source: 'service', alertId, ticketId,
      detail: {
        part_code: part.part_code, part_name: part.name, quantity: qty,
        unit_cost: unitCost, total_cost: totalCost, cover,
        removed_serial: removedSerial, fitted_serial: fittedSerial, reason,
      },
    });

    // ── 8. The join row that ties all of it together ──────────────────────────
    const { rows: spRows } = await client.query(
      `INSERT INTO iot_service_parts
         (company_id, equipment_id, ticket_id, alert_id, part_id, quantity, unit_cost, total_cost,
          removed_serial, fitted_serial, cover, reason, issued_by,
          movement_id, stock_ledger_id, serial_event_id, journal_entry_id, device_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [companyId, equipment.id, ticketId, alertId, part.id, qty, unitCost, totalCost,
       removedSerial, fittedSerial, cover, reason, userId,
       movRows[0].id, stockLedgerId, serialEventId, journalEntryId, deviceEventId],
    );

    await client.query('COMMIT');

    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'INFO', event: 'iot_service_part_issued',
      company_id: companyId, equipment_id: equipment.id, ticket_id: ticketId, alert_id: alertId,
      part_code: part.part_code, quantity: qty, total_cost: totalCost, cover,
      movement_id: movRows[0].id, stock_ledger_id: stockLedgerId,
      serial_event_id: serialEventId, journal_entry_id: journalEntryId,
    }));

    return {
      ok: true,
      row: spRows[0],
      part: { code: part.part_code, name: part.name, stock_before: stockBefore, stock_after: stockAfter },
      // Gaps in the chain are REPORTED, not hidden. A part issued against a spare
      // with no inventory item and no serial master still succeeds — but the
      // caller is told which links were not made, so nobody believes a chain that
      // is only three-quarters there.
      chain: {
        stock_movement: true,
        stock_ledger: stockLedgerId != null,
        genealogy: serialEventId != null,
        finance: journalEntryId != null,
        equipment_history: deviceEventId != null,
        ticket_costed: ticketId != null,
      },
      notes: [ledgerNote, genealogyNote, financeNote].filter(Boolean),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'ERROR', event: 'iot_service_part_failed',
      company_id: companyId, equipment_id: equipmentId, part_id: partId, message: e.message,
    }));
    return { ok: false, code: 'ISSUE_FAILED', error: e.message };
  } finally {
    client.release();
  }
}

/**
 * Reverse a part issue — a wrong part fitted, or a part returned unused.
 *
 * Writes the inverse of the stock side: a 'return' movement, a stock_ledger
 * quantity_in line against the recorded original, and a PART_RETURNED event —
 * and of the money side: a journal entry that mirrors the issue's journal
 * (each line's debit and credit swapped), linked to it by reversal_of_id, the
 * convention accounting.routes.js uses for every reversal. Like the issue's
 * own entry it is created as a DRAFT: IoT never posts into the ledger, finance
 * does (see ACCOUNTING above). The original is identified only by the id the
 * issue recorded, and verified; if it cannot be, nothing at all is reversed.
 * It does NOT delete the original rows, because an audit trail that can be
 * edited is not an audit trail.
 */
export async function reverseIssue({ servicePartId, companyId, userId = null, reason = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM iot_service_parts WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [servicePartId, companyId],
    );
    const orig = rows[0];
    if (!orig) { await client.query('ROLLBACK'); return { ok: false, code: 'NOT_FOUND', error: 'service part record not found' }; }
    if (orig.reversed_at) { await client.query('ROLLBACK'); return { ok: false, code: 'ALREADY_REVERSED', error: 'this issue has already been reversed' }; }

    // ── The original journal, verified before anything is written ─────────────
    // It is the entry this issue recorded (journal_entry_id) — its
    // reference_id is the ticket, so searching for it would be a guess. It must
    // be this company's, live, an IoT service entry, not itself a reversal,
    // balanced with lines totalling the issue's cost, and not reversed already.
    // An issue that posted no journal (no cost, or accounts missing) has none
    // to reverse.
    let journal = null;
    if (orig.journal_entry_id != null) {
      const { rows: [je] } = await client.query(
        `SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE`, [orig.journal_entry_id]);
      const { rows: lines } = je ? await client.query(
        `SELECT * FROM journal_lines WHERE entry_id = $1 ORDER BY id`, [je.id]) : { rows: [] };
      const dr = lines.reduce((t, l) => t + Number(l.debit || 0), 0);
      const cr = lines.reduce((t, l) => t + Number(l.credit || 0), 0);
      const cost = Number(orig.total_cost || 0);
      const reliable = je && String(je.company_id) === String(companyId) && je.deleted_at == null
        && je.reference_type === 'iot_service' && je.reversal_of_id == null && lines.length > 0
        && Math.abs(dr - cr) < 0.005 && Math.abs(dr - cost) < 0.005
        && Math.abs(Number(je.total_debit) - cost) < 0.005 && Math.abs(Number(je.total_credit) - cost) < 0.005;
      if (!reliable) {
        await client.query('ROLLBACK');
        return {
          ok: false, code: 'JOURNAL_ORIGINAL_UNVERIFIED',
          error: `the journal entry this issue recorded (${orig.journal_entry_id}) is missing, deleted, of another company, `
               + "unbalanced or does not match the issue's cost, so it cannot be reversed reliably; nothing was changed",
        };
      }
      const { rows: [prior] } = await client.query(
        `SELECT entry_number FROM journal_entries WHERE reversal_of_id = $1 AND deleted_at IS NULL LIMIT 1`, [je.id]);
      if (prior) {
        await client.query('ROLLBACK');
        return { ok: false, code: 'JOURNAL_ALREADY_REVERSED',
                 error: `the issue's journal entry ${je.entry_number} has already been reversed by ${prior.entry_number}; nothing was changed` };
      }
      journal = { entry: je, lines };
    }

    const { rows: partRows } = await client.query(
      `SELECT id, part_code, name, stock_qty FROM spare_parts WHERE id = $1 FOR UPDATE`, [orig.part_id]);
    const part = partRows[0];
    const stockBefore = Number(part.stock_qty) || 0;
    const qty = Number(orig.quantity);
    const stockAfter = stockBefore + qty;

    // ── The item-level ledger line ───────────────────────────────────────────
    // This reversal used to restore spare_parts and write NO stock_ledger row,
    // although this function's header said it did: the item's ledger stock
    // stayed deducted and the issue went on counting as demand for ever.
    //
    // The original line is identified by the id the issue recorded
    // (iot_service_parts.stock_ledger_id) — never by searching for a likely
    // match. It must still exist, belong to this company and be an outward
    // movement of exactly the issued quantity; anything else is refused rather
    // than reversed on a guess. An issue that never reached the ledger (a spare
    // with no inventory item) has nothing to reverse there.
    //
    // The inverse is posted under the SAME transaction type with quantity_in,
    // which ledgerSemantics reads as an issue reversal — so ledger stock comes
    // back and demand nets to zero. reversed_at under the row lock above stops
    // a repeat; a unique index on (reference_type, reference_id) for these
    // lines (migration 20261027000001) stops a second line even if that guard
    // were ever bypassed.
    let ledgerReversalId = null;
    if (orig.stock_ledger_id != null) {
      const { rows: [sl] } = await client.query(
        `SELECT * FROM stock_ledger WHERE id = $1 FOR UPDATE`, [orig.stock_ledger_id]);
      const reliable = sl && String(sl.company_id) === String(companyId)
        && Number(sl.quantity_out) === qty && !(Number(sl.quantity_in) > 0);
      if (!reliable) {
        await client.query('ROLLBACK');
        return {
          ok: false, code: 'LEDGER_ORIGINAL_UNVERIFIED',
          error: `the stock ledger line this issue recorded (#${orig.stock_ledger_id}) is missing or does not match `
               + 'the issue, so its stock movement cannot be reversed reliably; nothing was changed',
        };
      }
      const { rows: [bal] } = await client.query(
        `SELECT COALESCE(SUM(quantity_in - quantity_out), 0) AS q FROM stock_ledger WHERE item_id = $1`, [sl.item_id]);
      const { rows: [rev] } = await client.query(
        `INSERT INTO stock_ledger
           (item_id, warehouse_id, transaction_type, quantity_in, quantity_out, balance_qty, rate, value,
            reference_type, reference_id, transaction_date, remarks, created_by, company_id)
         VALUES ($1,$2,$3,$4,0,$5,$6,$7,'iot_service_reversal',$8,CURRENT_DATE,$9,NULL,$10)
         RETURNING id`,
        [sl.item_id, sl.warehouse_id, sl.transaction_type, qty, Number(bal.q) + qty, sl.rate, sl.value,
         orig.id, `Reversal of IoT service issue #${orig.id} (ledger #${sl.id})`.slice(0, 500), companyId]);
      ledgerReversalId = rev.id;
    }

    await client.query(
      `INSERT INTO spare_parts_movements
         (part_id, movement_type, quantity, reference_type, reference_id,
          unit_cost, total_cost, stock_before, stock_after, remarks, done_by, company_id)
       VALUES ($1,'return',$2,'iot_service_reversal',$3,$4,$5,$6,$7,$8,$9,$10)`,
      [part.id, qty, orig.id, orig.unit_cost, orig.total_cost, stockBefore, stockAfter,
       `Reversal of IoT service issue #${orig.id}${reason ? ' — ' + reason : ''}`.slice(0, 500),
       userId != null ? String(userId) : null, companyId],
    );
    await client.query(`UPDATE spare_parts SET stock_qty = $2, updated_at = NOW() WHERE id = $1`, [part.id, stockAfter]);

    if (orig.ticket_id) {
      await client.query(
        `UPDATE support_tickets SET parts_cost = GREATEST(0, COALESCE(parts_cost,0) - $2) WHERE id = $1`,
        [orig.ticket_id, orig.total_cost],
      ).catch(() => {});
    }

    await recordEvent(client, {
      companyId, equipmentId: orig.equipment_id, eventType: 'PART_RETURNED',
      source: 'service', ticketId: orig.ticket_id,
      detail: { reverses: orig.id, part_code: part.part_code, quantity: qty, reason },
    });

    const { rows: newRows } = await client.query(
      `INSERT INTO iot_service_parts
         (company_id, equipment_id, ticket_id, alert_id, part_id, quantity, unit_cost, total_cost,
          cover, reason, issued_by, reversal_of_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [companyId, orig.equipment_id, orig.ticket_id, orig.alert_id, orig.part_id,
       qty, orig.unit_cost, orig.total_cost, orig.cover,
       `Reversal: ${reason || 'no reason given'}`, userId, orig.id],
    );
    await client.query(`UPDATE iot_service_parts SET reversed_at = NOW() WHERE id = $1`, [orig.id]);

    // ── The mirror journal ────────────────────────────────────────────────────
    // Each line of the original with debit and credit swapped, same accounts,
    // same project; balanced because the original is. Draft, like the issue's
    // entry. ux_journal_entries_single_reversal (migration 20261028000003)
    // refuses a second reversal of the same entry even past the checks above.
    let journalReversalId = null;
    if (journal) {
      const { entry: je, lines } = journal;
      const entryNumber = await nextAccountingJournalNumber(client);
      const narration = `Reversal of IoT service issue #${orig.id}${reason ? ' — ' + reason : ''}`.slice(0, 500);
      const { rows: [rev] } = await client.query(
        `INSERT INTO journal_entries
           (entry_number, entry_date, description, entry_type, reference_type, reference_id,
            status, reversal_of_id, total_debit, total_credit, company_id, created_by)
         VALUES ($1, CURRENT_DATE, $2, 'auto', 'iot_service_reversal', $3, 'draft', $4, $5, $6, $7, $8)
         RETURNING id`,
        [entryNumber, narration, String(newRows[0].id), je.id, je.total_credit, je.total_debit, companyId, userId]);
      for (const l of lines) {
        await client.query(
          `INSERT INTO journal_lines
             (entry_id, account_id, account_code, account_name, debit, credit, narration, cost_centre, project_id, company_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [rev.id, l.account_id, l.account_code, l.account_name, Number(l.credit || 0), Number(l.debit || 0),
           `Reversal: ${l.narration || ''}`.slice(0, 500), l.cost_centre, l.project_id, companyId]);
      }
      journalReversalId = rev.id;
      await client.query(`UPDATE iot_service_parts SET journal_entry_id = $2 WHERE id = $1`, [newRows[0].id, rev.id]);
    }

    await client.query('COMMIT');
    // The reversing entry is a DRAFT, so the accounting reversal is not done
    // until finance posts it (after the original — accounting.routes.js
    // refuses the other order). journal_reversed says only that.
    return { ok: true, row: { ...newRows[0], journal_entry_id: journalReversalId }, stock_after: stockAfter,
             stock_ledger_reversal_id: ledgerReversalId,
             journal_reversed: false,
             journal_reversal_id: journalReversalId,
             ...(journal
               ? { journal_reversal: { id: journalReversalId, status: 'draft', posting_required: true,
                                       original_journal_id: journal.entry.id, original_status: journal.entry.status } }
               : { journal_note: 'the issue posted no journal entry, so there was none to reverse' }) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, code: 'REVERSAL_FAILED', error: e.message };
  } finally {
    client.release();
  }
}

/**
 * The as-built / as-maintained picture for one unit: what it is made of now,
 * what has been swapped, and what each swap cost.
 */
export async function equipmentGenealogy(db, { equipmentId, companyId }) {
  const { rows: eq } = await db.query(
    `SELECT id, equipment_name, serial_number, model_number, installation_date, company_id
       FROM customer_equipment WHERE id = $1 AND company_id = $2`,
    [equipmentId, companyId],
  );
  if (!eq.length) return null;
  const equipment = eq[0];

  // The serial master row, if this unit's serial is registered in production.
  const { rows: serial } = await db.query(
    `SELECT sn.id, sn.serial_number, sn.status, sn.manufactured_date, sn.warranty_expiry,
            sn.production_order_id, sn.batch_id,
            i.item_name, i.item_code,
            b.batch_number
       FROM serial_numbers sn
       LEFT JOIN inventory_items i ON i.id = sn.item_id
       LEFT JOIN inventory_batches b ON b.id = sn.batch_id
      WHERE sn.serial_number = $1 AND sn.company_id = $2 AND sn.deleted_at IS NULL
      LIMIT 1`,
    [equipment.serial_number, companyId],
  ).catch(() => ({ rows: [] }));

  const { rows: events } = serial.length
    ? await db.query(
        `SELECT se.id, se.event_type, se.event_date, se.description,
                se.reference_type, se.reference_id, u.name AS performed_by_name
           FROM serial_events se
           LEFT JOIN users u ON u.id = se.performed_by
          WHERE se.serial_id = $1 ORDER BY se.event_date DESC, se.id DESC LIMIT 200`,
        [serial[0].id])
    : { rows: [] };

  const { rows: parts } = await db.query(
    `SELECT sp.*, p.part_code, p.name AS part_name, p.unit,
            t.ticket_number, t.status AS ticket_status,
            je.entry_number, je.status AS journal_status,
            u.name AS issued_by_name
       FROM iot_service_parts sp
       JOIN spare_parts p ON p.id = sp.part_id
       LEFT JOIN support_tickets t ON t.id = sp.ticket_id
       LEFT JOIN journal_entries je ON je.id = sp.journal_entry_id
       LEFT JOIN users u ON u.id = sp.issued_by
      WHERE sp.equipment_id = $1 AND sp.company_id = $2
      ORDER BY sp.issued_at DESC LIMIT 200`,
    [equipmentId, companyId],
  );

  const spend = parts
    .filter((p) => !p.reversal_of_id && !p.reversed_at)
    .reduce((s, p) => s + Number(p.total_cost || 0), 0);

  return {
    equipment,
    serial: serial[0] || null,
    // Stated plainly rather than left as an empty array the reader has to interpret
    serial_note: serial.length
      ? null
      : equipment.serial_number
        ? `Serial '${equipment.serial_number}' is not registered in serial_numbers, so production genealogy (batch, production order, as-built components) is NOT AVAILABLE for this unit.`
        : 'No serial number is recorded against this equipment, so genealogy cannot be linked.',
    production_events: events,
    service_parts: parts,
    totals: {
      parts_issued: parts.filter((p) => !p.reversal_of_id).length,
      reversals: parts.filter((p) => p.reversal_of_id).length,
      lifetime_parts_cost: Number(spend.toFixed(2)),
    },
  };
}
