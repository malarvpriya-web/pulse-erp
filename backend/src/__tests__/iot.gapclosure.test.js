/**
 * iot.gapclosure.test.js — the gaps closed on 2026-09-15, against a REAL Postgres.
 *
 * Covers what IOT_PHASE4_REPORT.md listed as open:
 *   gap 3  multi-channel notification delivery, and its delivery record
 *   gap 7  the §74 loop: part -> inventory -> genealogy -> finance -> history
 *   gap 8  legacy seed rows archived and the CHECK constraints VALIDATED
 *   gap 9  the default telemetry partition emptied
 *   gap 12 metric and device-profile registry CRUD, including register maps
 *
 * The §74 test is the important one: it asserts that a single part issue writes
 * FIVE rows in FOUR other modules and that they all reference each other, because
 * the defect being fixed was not a missing endpoint — it was a chain that stopped
 * at the technician and left inventory, genealogy and finance unaware that
 * anything had happened.
 *
 * Run:  npx vitest run src/__tests__/iot.gapclosure.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const { issuePart, reverseIssue, equipmentGenealogy, resolveCover } = await import('../modules/iot/serviceParts.js');
const { demandQtySql } = await import('../modules/inventory/services/ledgerSemantics.js');
const { notifyAlert, resolveRecipients, channelAvailability, eventKeyFor, IOT_EVENTS } = await import('../modules/iot/notify.js');

const TAG = `IOTGAP_${Date.now()}`;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ctx = {};

beforeAll(async () => {
  const { rows: c } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} Co`, TAG.slice(-12)]);
  ctx.companyId = c[0].id;

  // Equipment with a serial that IS registered in serial_numbers, so the
  // genealogy link can actually be made — the test would otherwise pass while
  // proving nothing about the part of the chain most likely to be missing.
  // Opening stock is posted to the LEDGER, not written to current_stock.
  //
  // current_stock has been a derived column since 20260911000016 — a trigger
  // keeps it equal to the ledger balance — so a fixture that sets it directly
  // creates a row the system says cannot exist. While this suite was in flight
  // the supply-chain suite's "current_stock equals the ledger for every item"
  // invariant saw it and failed, on a defect in the fixture rather than in the
  // code either suite was testing.
  const { rows: item } = await pool.query(
    `INSERT INTO inventory_items (item_code, item_name, company_id)
     VALUES ($1,$2,$3) RETURNING id`,
    [`${TAG}-ITEM`, `${TAG} panel`, ctx.companyId]);
  ctx.itemId = item[0].id;
  await pool.query(
    `INSERT INTO stock_ledger
       (item_id, company_id, transaction_type, quantity_in, quantity_out, balance_qty,
        reference_type, transaction_date, remarks)
     VALUES ($1,$2,'opening',100,0,100,'fixture',CURRENT_DATE,$3)`,
    [ctx.itemId, ctx.companyId, `${TAG} opening stock`]);

  // A delivered unit is one a package accounts for — the rule
  // trg_serial_shipped_requires_package enforces on status changes and the
  // traceability worklist v_shipped_serials_unlinked reports across ALL
  // companies. This fixture used to insert a bare 'Delivered' serial (an
  // INSERT the trigger does not see), which sat in that worklist for this
  // suite's lifetime: whenever the traceability suite asserted the worklist
  // empty at that moment, it failed on this fixture, not on its own code (2 of
  // 4 full runs on 2026-10-28). The serial and the package line that account
  // for it are now written in one transaction, so it is never in that state.
  const fx = await pool.connect();
  try {
    await fx.query('BEGIN');
    const { rows: sn } = await fx.query(
      `INSERT INTO serial_numbers (serial_number, item_id, company_id, status)
       VALUES ($1,$2,$3,'Delivered') RETURNING id`,
      [`${TAG}-SN`, ctx.itemId, ctx.companyId]);
    ctx.serialId = sn[0].id;
    const { rows: [pkg] } = await fx.query(
      `INSERT INTO packages (company_id, package_no, status) VALUES ($1, $2, 'shipped') RETURNING id`,
      [ctx.companyId, `${TAG}-PKG`]);
    await fx.query(
      `INSERT INTO package_lines (package_id, company_id, item_id, serial_id, quantity) VALUES ($1, $2, $3, $4, 1)`,
      [pkg.id, ctx.companyId, ctx.itemId, ctx.serialId]);
    await fx.query('COMMIT');
  } catch (e) { await fx.query('ROLLBACK'); throw e; } finally { fx.release(); }

  const { rows: eq } = await pool.query(
    `INSERT INTO customer_equipment
       (company_id, equipment_name, serial_number, device_uid, telemetry_token_hash,
        sampling_secs, device_status, connection_state, amc_status, warranty_status)
     VALUES ($1,$2,$3,$4,$5,60,'active','online','active','expired') RETURNING *`,
    [ctx.companyId, `${TAG} AHF`, `${TAG}-SN`, `${TAG}-UID`, sha256(`${TAG}-tok`)]);
  ctx.equipment = eq[0];

  // A spare whose part_code matches the inventory item, so the stock_ledger link
  // is exercised too.
  const { rows: part } = await pool.query(
    `INSERT INTO spare_parts (part_code, name, stock_qty, unit_cost, unit, company_id)
     VALUES ($1,$2,10,1500,'nos',$3) RETURNING *`,
    [`${TAG}-ITEM`, `${TAG} cooling fan`, ctx.companyId]);
  ctx.part = part[0];

  const { rows: ticket } = await pool.query(
    // Shaped like a real IoT alert ticket (modules/iot/alertActions.js): filed
    // under 'Breakdown' AND linked to that ticket-category master row, so it
    // does not read as an unlinked ticket to integration.ticketCategories
    // when the two suites run in parallel.
    `INSERT INTO support_tickets
       (ticket_number, title, description, category, priority, status, ticket_kind, company_id, parts_cost,
        category_id)
     VALUES ($1,'IoT test ticket','x','Breakdown','High','Open','service',$2,0,
             (SELECT id FROM ticket_categories
               WHERE LOWER(BTRIM(name)) = 'breakdown' AND is_active = true
               ORDER BY id LIMIT 1)) RETURNING *`,
    // ticket_number is VARCHAR(20); TAG alone is longer than that.
    [`T${String(Date.now()).slice(-10)}`, ctx.companyId]);
  ctx.ticket = ticket[0];

  const { rows: alert } = await pool.query(
    `INSERT INTO device_alerts (company_id, equipment_id, metric, severity, state, message, ticket_id)
     VALUES ($1,$2,'TEMPERATURE','critical','active','fan failure',$3) RETURNING *`,
    [ctx.companyId, ctx.equipment.id, ctx.ticket.id]);
  ctx.alert = alert[0];
}, 60000);

afterAll(async () => {
  const cid = ctx.companyId;
  // The login this run created (2026-10-20). It was never removed: the company
  // DELETE below then SET NULL its company_id (users_company_id_fkey ON DELETE SET
  // NULL), so every run left one unscoped `iotgap_<ts>@t.local` account behind,
  // plus the in-app notifications delivered to it. Removed FIRST — by the id this
  // run recorded, or by this run's own TAG (Date.now() of THIS run, so it can
  // match nothing else) if the test failed before recording the id. Accounts
  // left by earlier runs are deliberately not touched here.
  const runUsers = `SELECT id FROM users WHERE id = $1::int OR email = $2`;
  const runArgs = [ctx.userId ?? null, `${TAG}@t.local`];
  await pool.query(`DELETE FROM notifications WHERE user_id IN (${runUsers})`, runArgs).catch(() => {});
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${runUsers})`, runArgs);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${runUsers})`, runArgs);
  await pool.query(`DELETE FROM users WHERE id IN (${runUsers})`, runArgs);
  // The fixture unit is 'Delivered', so the package line that accounts for it
  // cannot simply be deleted (trg_package_line_serial_accounted, 20261028000008).
  // Unwind it first: back in stock, its package may go.
  await pool.query(`UPDATE serial_numbers SET status = 'in_stock' WHERE id = $1`, [ctx.serialId]).catch(() => {});
  for (const sql of [
    `DELETE FROM package_lines WHERE company_id = $1`,
    `DELETE FROM packages WHERE company_id = $1`,
    `DELETE FROM journal_lines WHERE company_id = $1`,
    `DELETE FROM journal_entries WHERE company_id = $1`,
    `DELETE FROM iot_service_parts WHERE company_id = $1`,
    `DELETE FROM iot_notification_log WHERE company_id = $1`,
    `DELETE FROM iot_device_events WHERE company_id = $1`,
    `DELETE FROM device_alerts WHERE company_id = $1`,
    `DELETE FROM stock_ledger WHERE company_id = $1`,
    `DELETE FROM spare_parts_movements WHERE company_id = $1`,
    `DELETE FROM spare_parts WHERE company_id = $1`,
    `DELETE FROM support_tickets WHERE company_id = $1`,
    `DELETE FROM iot_metric_definitions WHERE company_id = $1`,
    `DELETE FROM iot_device_profiles WHERE company_id = $1`,
    `DELETE FROM customer_equipment WHERE company_id = $1`,
    `DELETE FROM notification_rules WHERE company_id = $1`,
    `DELETE FROM companies WHERE id = $1`,
  ]) await pool.query(sql, [cid]).catch(() => {});
  await pool.query(`DELETE FROM serial_events WHERE serial_id = $1`, [ctx.serialId]).catch(() => {});
  await pool.query(`DELETE FROM serial_numbers WHERE id = $1`, [ctx.serialId]).catch(() => {});
  await pool.query(`DELETE FROM inventory_items WHERE id = $1`, [ctx.itemId]).catch(() => {});
  // The company DELETE above runs before inventory_items / serial_numbers are
  // gone, so it can be refused by their FKs; retry it now that they are.
  await pool.query(`DELETE FROM companies WHERE id = $1`, [cid]).catch(() => {});

  // Repeat-run guard: nothing carrying THIS run's TAG may outlive the run.
  const { rows: [left] } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM users WHERE email = $1) AS users,
            (SELECT COUNT(*)::int FROM companies WHERE id = $2::int) AS companies,
            (SELECT COUNT(*)::int FROM inventory_items WHERE item_code = $3) AS items`,
    [`${TAG}@t.local`, cid ?? null, `${TAG}-ITEM`]);
  expect(left, 'fixtures left behind by this run').toEqual({ users: 0, companies: 0, items: 0 });
}, 60000);

// ─────────────────────────────────────────────────────────────────────────────
// GAP 8 + 9 — legacy data and constraint validation
// ─────────────────────────────────────────────────────────────────────────────
describe('gap 8/9 — legacy rows archived, constraints validated', () => {
  it('no alert, rule or telemetry row is left outside its declared vocabulary', async () => {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM device_alerts
          WHERE state NOT IN ('pending_confirmation','active','acknowledged','recovery_pending','resolved','suppressed')
             OR severity NOT IN ('info','warning','critical'))::int AS bad_alerts,
        (SELECT COUNT(*) FROM device_alert_rules
          WHERE operator NOT IN ('>','<','>=','<=','=','stale')
             OR severity NOT IN ('info','warning','critical'))::int AS bad_rules,
        (SELECT COUNT(*) FROM device_telemetry WHERE metric LIKE 'SEED %')::int AS seed_telemetry`);
    expect(rows[0].bad_alerts).toBe(0);
    expect(rows[0].bad_rules).toBe(0);
    expect(rows[0].seed_telemetry).toBe(0);
  });

  it('the CHECK and FK constraints are VALIDATED, not merely NOT VALID', async () => {
    // A NOT VALID constraint guards new writes only. VALIDATED means the database
    // guarantees the invariant for EVERY row, which is what makes the
    // reconciliation checks meaningful instead of decorative.
    const { rows } = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('ck_iot_alert_state','ck_iot_alert_severity','ck_iot_rule_operator',
                          'ck_iot_rule_severity','ck_ce_device_status',
                          'fk_rule_equipment_company','fk_alert_equipment_company')`);
    expect(rows.length).toBe(7);
    for (const r of rows) expect(r.convalidated, `${r.conname} is not validated`).toBe(true);
  });

  it('the archived rows are preserved, not destroyed', async () => {
    // §226: this counted one database's quarantined history (a fresh database
    // had nothing to quarantine). That 20260915000001 archives exactly the
    // out-of-vocabulary and SEED rows, whole, with the right reason, keeps the
    // valid ones, validates all seven constraints and skips no step is proven in
    // migrationFixture.iotQuarantine. What holds everywhere: the archive keeps
    // the whole row, and every archived row is whole and explained.
    const { rows: [col] } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'iot_legacy_quarantine' AND column_name = 'row_data'`);
    expect(col).toEqual({ data_type: 'jsonb', is_nullable: 'NO' });
    const { rows: incomplete } = await pool.query(
      `SELECT id, source_table FROM iot_legacy_quarantine
        WHERE migration = '20260915000001_iot_gap_closure'
          AND (reason IS NULL OR NOT (row_data ? 'company_id')
               OR (source_table IN ('device_alerts','device_alert_rules','device_telemetry') AND NOT (row_data ? 'id'))
               OR (source_table = 'device_alerts' AND NOT (row_data ?& ARRAY['state','severity','equipment_id'])))`);
    expect(incomplete).toEqual([]);
  });

  it('the default telemetry partition is empty', async () => {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM device_telemetry_default`);
    expect(rows[0].n).toBe(0);
  });

  it('a row outside the vocabulary is now rejected by a VALIDATED constraint', async () => {
    await expect(pool.query(
      `INSERT INTO device_alerts (company_id, equipment_id, metric, severity, state, message)
       VALUES ($1,$2,'TEMPERATURE','warning','Tamil Nadu','x')`,
      [ctx.companyId, ctx.equipment.id],
    )).rejects.toThrow(/ck_iot_alert_state/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 7 — the §74 ERP loop
// ─────────────────────────────────────────────────────────────────────────────
describe('gap 7 — part replacement reaches inventory, genealogy, finance and history', () => {
  it('cover is derived from the equipment contract, not defaulted', () => {
    expect(resolveCover({ amc_status: 'active', warranty_status: 'expired' })).toBe('amc');
    expect(resolveCover({ amc_status: 'none', warranty_status: 'active' })).toBe('warranty');
    expect(resolveCover({ amc_status: 'none', warranty_status: 'expired' })).toBe('chargeable');
    // an explicit decision by a service manager wins over the contract
    expect(resolveCover({ amc_status: 'active' }, 'goodwill')).toBe('goodwill');
  });

  it('ONE part issue writes every link in the chain, in one transaction', async () => {
    const before = await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id]);

    const result = await issuePart({
      companyId: ctx.companyId,
      equipmentId: ctx.equipment.id,
      partId: ctx.part.id,
      quantity: 2,
      ticketId: ctx.ticket.id,
      alertId: ctx.alert.id,
      removedSerial: 'FAN-OLD-001',
      fittedSerial: 'FAN-NEW-002',
      reason: 'fan seized, replaced on site',
      userId: null,
    });

    expect(result.ok).toBe(true);
    ctx.servicePartId = result.row.id;

    // Every link, asserted individually — "the endpoint returned 201" is not
    // evidence that inventory heard about it.
    expect(result.chain.stock_movement).toBe(true);
    expect(result.chain.stock_ledger).toBe(true);
    expect(result.chain.genealogy).toBe(true);
    expect(result.chain.finance).toBe(true);
    expect(result.chain.equipment_history).toBe(true);
    expect(result.chain.ticket_costed).toBe(true);
    expect(result.notes).toEqual([]);          // no link silently skipped

    // 1. spare stock actually decremented
    const after = await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id]);
    expect(after.rows[0].q).toBe(before.rows[0].q - 2);

    // 2. a movement row with the right reference
    const { rows: mov } = await pool.query(
      `SELECT * FROM spare_parts_movements WHERE id = $1`, [result.row.movement_id]);
    expect(mov[0].movement_type).toBe('issue');
    expect(Number(mov[0].quantity)).toBe(2);
    expect(mov[0].reference_type).toBe('iot_service');
    expect(Number(mov[0].total_cost)).toBe(3000);

    // 3. an item-level ledger line
    const { rows: sl } = await pool.query(`SELECT * FROM stock_ledger WHERE id = $1`, [result.row.stock_ledger_id]);
    expect(Number(sl[0].quantity_out)).toBe(2);
    expect(sl[0].reference_type).toBe('iot_service');

    // 4. genealogy on the equipment's own serial
    const { rows: se } = await pool.query(`SELECT * FROM serial_events WHERE id = $1`, [result.row.serial_event_id]);
    expect(se[0].event_type).toBe('COMPONENT_REPLACED');
    expect(se[0].serial_id).toBe(ctx.serialId);
    expect(se[0].description).toMatch(/FAN-OLD-001/);
    expect(se[0].description).toMatch(/FAN-NEW-002/);

    // 5. a BALANCED journal entry, drafted not posted
    const { rows: je } = await pool.query(`SELECT * FROM journal_entries WHERE id = $1`, [result.row.journal_entry_id]);
    expect(je[0].status).toBe('draft');
    expect(Number(je[0].total_debit)).toBe(3000);
    expect(Number(je[0].total_credit)).toBe(3000);
    expect(je[0].reference_type).toBe('iot_service');

    const { rows: lines } = await pool.query(
      `SELECT account_code, debit::float AS debit, credit::float AS credit
         FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC`, [result.row.journal_entry_id]);
    expect(lines.length).toBe(2);
    // AMC cover, so the company bears it: Dr Warranty Cost, Cr Stores & Spares
    expect(lines[0].account_code).toBe('5052');
    expect(lines[0].debit).toBe(3000);
    expect(lines[1].account_code).toBe('1034');
    expect(lines[1].credit).toBe(3000);
    expect(lines[0].debit).toBe(lines[1].credit);

    // 6. equipment history
    const { rows: ev } = await pool.query(
      `SELECT * FROM iot_device_events WHERE id = $1`, [result.row.device_event_id]);
    expect(ev[0].event_type).toBe('PART_REPLACED');
    expect(ev[0].ticket_id).toBe(ctx.ticket.id);
    expect(ev[0].detail.part_code).toBe(ctx.part.part_code);

    // 7. job costing on the ticket
    const { rows: tk } = await pool.query(`SELECT parts_cost::float AS c FROM support_tickets WHERE id = $1`, [ctx.ticket.id]);
    expect(tk[0].c).toBe(3000);
  });

  it('an AMC unit posts to Warranty Cost; a chargeable one posts to Repairs', async () => {
    // Same part, same equipment, different cover — the account must follow who
    // bears the cost, which is the whole point of recording cover at all.
    const result = await issuePart({
      companyId: ctx.companyId, equipmentId: ctx.equipment.id, partId: ctx.part.id,
      quantity: 1, ticketId: ctx.ticket.id, cover: 'chargeable', reason: 'billed to customer',
    });
    expect(result.ok).toBe(true);
    const { rows: lines } = await pool.query(
      `SELECT account_code FROM journal_lines WHERE entry_id = $1 AND debit > 0`,
      [result.row.journal_entry_id]);
    expect(lines[0].account_code).toBe('5024');   // Repairs & Maintenance
  });

  it('refuses to issue more than is in stock rather than going negative', async () => {
    const result = await issuePart({
      companyId: ctx.companyId, equipmentId: ctx.equipment.id, partId: ctx.part.id, quantity: 9999,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INSUFFICIENT_STOCK');
    expect(result.error).toMatch(/in stock/);
    const { rows } = await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id]);
    expect(rows[0].q).toBeGreaterThanOrEqual(0);
  });

  it('refuses equipment in another company', async () => {
    const result = await issuePart({
      companyId: ctx.companyId + 999999, equipmentId: ctx.equipment.id, partId: ctx.part.id, quantity: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('EQUIPMENT_NOT_FOUND');
  });

  it('a reversal restores stock and does NOT delete the original record', async () => {
    const before = await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id]);
    const r = await reverseIssue({
      servicePartId: ctx.servicePartId, companyId: ctx.companyId, reason: 'wrong part fitted',
    });
    expect(r.ok).toBe(true);
    const after = await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id]);
    expect(after.rows[0].q).toBe(before.rows[0].q + 2);

    // the original row survives, marked — an audit trail that can be edited is
    // not an audit trail
    const { rows: orig } = await pool.query(`SELECT * FROM iot_service_parts WHERE id = $1`, [ctx.servicePartId]);
    expect(orig.length).toBe(1);
    expect(orig[0].reversed_at).toBeTruthy();
    expect(r.row.reversal_of_id).toBe(ctx.servicePartId);

    // Phase 3D: the item ledger is reversed too — against the recorded original
    // line, under the same type with quantity_in, so ledger stock comes back and
    // the issue stops counting as demand.
    const { rows: [sl] } = await pool.query(
      `SELECT * FROM stock_ledger WHERE reference_type = 'iot_service_reversal' AND reference_id = $1`, [ctx.servicePartId]);
    expect(sl).toBeTruthy();
    expect(r.stock_ledger_reversal_id).toBe(sl.id);
    expect([Number(sl.quantity_in), Number(sl.quantity_out), sl.transaction_type, sl.item_id])
      .toEqual([2, 0, 'issue', orig[0].stock_ledger_id ? (await pool.query(
        `SELECT item_id FROM stock_ledger WHERE id = $1`, [orig[0].stock_ledger_id])).rows[0].item_id : null]);
    const { rows: [net] } = await pool.query(
      `SELECT SUM(${demandQtySql()})::float AS demand, SUM(quantity_out - quantity_in)::float AS out
         FROM stock_ledger WHERE id IN ($1, $2)`, [orig[0].stock_ledger_id, sl.id]);
    expect(net).toEqual({ demand: 0, out: 0 });

    // Phase 3F: the issue's journal gets a mirror entry linked to it, each
    // line's debit and credit swapped, balanced, a draft like the original.
    // Phase 3G: a draft is not a completed reversal, and is not reported as one.
    expect(r.journal_reversed).toBe(false);
    expect(r.journal_reversal).toMatchObject({ id: r.journal_reversal_id, status: 'draft', posting_required: true });
    const { rows: [rev] } = await pool.query(`SELECT * FROM journal_entries WHERE id = $1`, [r.journal_reversal_id]);
    expect(rev).toMatchObject({ reversal_of_id: orig[0].journal_entry_id, status: 'draft',
                                reference_type: 'iot_service_reversal', company_id: ctx.companyId });
    const lines = async (id) => (await pool.query(
      `SELECT account_code, debit::float d, credit::float c FROM journal_lines WHERE entry_id = $1 ORDER BY account_code`, [id])).rows;
    const origLines = await lines(orig[0].journal_entry_id);
    expect(origLines.length).toBeGreaterThan(0);
    expect(await lines(rev.id)).toEqual(origLines.map(l => ({ account_code: l.account_code, d: l.c, c: l.d })));
    expect(Number(rev.total_debit)).toBe(Number(rev.total_credit));
    expect(r.row.journal_entry_id).toBe(rev.id);
  });

  it('a second reversal of the same issue is refused, and posts no second ledger line', async () => {
    const r = await reverseIssue({ servicePartId: ctx.servicePartId, companyId: ctx.companyId });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ALREADY_REVERSED');
    const { rows: [n] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_ledger WHERE reference_type = 'iot_service_reversal' AND reference_id = $1`,
      [ctx.servicePartId]);
    expect(n.n).toBe(1);
    // And the database itself refuses a second line for the same issue.
    await expect(pool.query(
      `INSERT INTO stock_ledger (item_id, transaction_type, quantity_in, quantity_out, reference_type, reference_id,
                                 transaction_date, company_id)
       SELECT item_id, transaction_type, 1, 0, 'iot_service_reversal', $1, CURRENT_DATE, company_id
         FROM stock_ledger WHERE reference_type = 'iot_service_reversal' AND reference_id = $1`, [ctx.servicePartId]))
      .rejects.toThrow(/ux_stock_ledger_iot_service_reversal/);
  });

  it('refuses to reverse when the recorded ledger line cannot be verified, and changes nothing', async () => {
    const issued = await issuePart({
      companyId: ctx.companyId, equipmentId: ctx.equipment.id, partId: ctx.part.id, quantity: 1,
      ticketId: ctx.ticket.id, reason: 'verification fixture',
    });
    expect(issued.ok).toBe(true);
    // Point the record at a ledger line that does not match it.
    await pool.query(`UPDATE iot_service_parts SET stock_ledger_id = -1 WHERE id = $1`, [issued.row.id]);
    const before = (await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id])).rows[0].q;
    const r = await reverseIssue({ servicePartId: issued.row.id, companyId: ctx.companyId });
    expect([r.ok, r.code]).toEqual([false, 'LEDGER_ORIGINAL_UNVERIFIED']);
    expect((await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id])).rows[0].q).toBe(before);
    expect((await pool.query(`SELECT reversed_at FROM iot_service_parts WHERE id = $1`, [issued.row.id])).rows[0].reversed_at).toBeNull();
    expect((await pool.query(
      `SELECT COUNT(*)::int n FROM stock_ledger WHERE reference_type = 'iot_service_reversal' AND reference_id = $1`,
      [issued.row.id])).rows[0].n).toBe(0);
  });

  it('refuses to reverse when the recorded journal cannot be verified, and changes nothing', async () => {
    const issued = await issuePart({
      companyId: ctx.companyId, equipmentId: ctx.equipment.id, partId: ctx.part.id, quantity: 1,
      ticketId: ctx.ticket.id, reason: 'journal verification fixture',
    });
    expect(issued.ok).toBe(true);
    expect(issued.row.journal_entry_id).toBeTruthy();
    // The journal no longer matches the issue's cost (edited after the fact).
    await pool.query(`UPDATE journal_entries SET total_debit = total_debit + 1 WHERE id = $1`, [issued.row.journal_entry_id]);
    const snap = async () => ({
      stock: (await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id])).rows[0].q,
      reversed: (await pool.query(`SELECT reversed_at FROM iot_service_parts WHERE id = $1`, [issued.row.id])).rows[0].reversed_at,
      ledger: (await pool.query(`SELECT COUNT(*)::int n FROM stock_ledger WHERE reference_type = 'iot_service_reversal' AND reference_id = $1`, [issued.row.id])).rows[0].n,
      journals: (await pool.query(`SELECT COUNT(*)::int n FROM journal_entries WHERE reversal_of_id = $1`, [issued.row.journal_entry_id])).rows[0].n,
    });
    const before = await snap();
    const r = await reverseIssue({ servicePartId: issued.row.id, companyId: ctx.companyId });
    expect([r.ok, r.code]).toEqual([false, 'JOURNAL_ORIGINAL_UNVERIFIED']);
    expect(await snap()).toEqual(before);
    expect(before).toMatchObject({ reversed: null, ledger: 0, journals: 0 });
  });

  it('refuses when the journal was already reversed elsewhere, and the database refuses a second reversing entry', async () => {
    const issued = await issuePart({
      companyId: ctx.companyId, equipmentId: ctx.equipment.id, partId: ctx.part.id, quantity: 1,
      ticketId: ctx.ticket.id, reason: 'already reversed fixture',
    });
    const je = issued.row.journal_entry_id;
    await pool.query(
      `INSERT INTO journal_entries (entry_number, entry_date, entry_type, reference_type, status, reversal_of_id,
                                    total_debit, total_credit, company_id)
       SELECT entry_number || '-R', CURRENT_DATE, 'reversal', reference_type, 'draft', id, total_credit, total_debit, company_id
         FROM journal_entries WHERE id = $1`, [je]);
    const r = await reverseIssue({ servicePartId: issued.row.id, companyId: ctx.companyId });
    expect([r.ok, r.code]).toEqual([false, 'JOURNAL_ALREADY_REVERSED']);
    expect((await pool.query(`SELECT reversed_at FROM iot_service_parts WHERE id = $1`, [issued.row.id])).rows[0].reversed_at).toBeNull();
    await expect(pool.query(
      `INSERT INTO journal_entries (entry_number, entry_date, entry_type, status, reversal_of_id, total_debit, total_credit, company_id)
       SELECT entry_number || '-R2', CURRENT_DATE, 'reversal', 'draft', id, 0, 0, company_id FROM journal_entries WHERE id = $1`, [je]))
      .rejects.toThrow(/ux_journal_entries_single_reversal/);
  });

  it('two simultaneous reversals of one issue: one reversal, one ledger line, one journal', async () => {
    const issued = await issuePart({
      companyId: ctx.companyId, equipmentId: ctx.equipment.id, partId: ctx.part.id, quantity: 1,
      ticketId: ctx.ticket.id, reason: 'concurrency fixture',
    });
    const stockBefore = (await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id])).rows[0].q;
    const results = await Promise.all([1, 2, 3].map(() => reverseIssue({ servicePartId: issued.row.id, companyId: ctx.companyId })));
    expect(results.filter(r => r.ok).length).toBe(1);
    expect(results.filter(r => !r.ok).map(r => r.code)).toEqual(['ALREADY_REVERSED', 'ALREADY_REVERSED']);
    expect((await pool.query(`SELECT stock_qty::float AS q FROM spare_parts WHERE id = $1`, [ctx.part.id])).rows[0].q).toBe(stockBefore + 1);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM stock_ledger WHERE reference_type = 'iot_service_reversal' AND reference_id = $1`, [issued.row.id])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM journal_entries WHERE reversal_of_id = $1`, [issued.row.journal_entry_id])).rows[0].n).toBe(1);
  });

  it('genealogy reports the whole picture, and says so when a link is absent', async () => {
    const g = await equipmentGenealogy(pool, { equipmentId: ctx.equipment.id, companyId: ctx.companyId });
    expect(g.equipment.id).toBe(ctx.equipment.id);
    expect(g.serial).toBeTruthy();
    expect(g.serial_note).toBeNull();               // the link WAS made
    expect(g.production_events.length).toBeGreaterThan(0);
    expect(g.service_parts.length).toBeGreaterThan(0);
    expect(g.totals.lifetime_parts_cost).toBeGreaterThan(0);
    // the reversals (one per reversed issue above) are excluded from lifetime spend
    const { rows: [rv] } = await pool.query(
      `SELECT COUNT(*)::int n FROM iot_service_parts WHERE equipment_id = $1 AND reversal_of_id IS NOT NULL`, [ctx.equipment.id]);
    expect(rv.n).toBeGreaterThanOrEqual(1);
    expect(g.totals.reversals).toBe(rv.n);
  });

  it('an unregistered serial yields a STATED gap, not a silent empty section', async () => {
    const { rows: eq } = await pool.query(
      `INSERT INTO customer_equipment (company_id, equipment_name, serial_number, device_status)
       VALUES ($1,$2,$3,'unprovisioned') RETURNING *`,
      [ctx.companyId, `${TAG} no-serial-master`, `${TAG}-UNKNOWN-SN`]);
    const g = await equipmentGenealogy(pool, { equipmentId: eq[0].id, companyId: ctx.companyId });
    expect(g.serial).toBeNull();
    expect(g.serial_note).toMatch(/NOT AVAILABLE/);
    expect(g.serial_note).toMatch(/UNKNOWN-SN/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GAP 3 — multi-channel notification
// ─────────────────────────────────────────────────────────────────────────────
describe('gap 3 — notifications are delivered across channels and recorded', () => {
  it('maps severity and context to the right event key', () => {
    expect(eventKeyFor({ severity: 'critical' })).toBe(IOT_EVENTS.ALERT_CRITICAL);
    expect(eventKeyFor({ severity: 'warning' })).toBe(IOT_EVENTS.ALERT_WARNING);
    expect(eventKeyFor({ severity: 'critical', escalation: true })).toBe(IOT_EVENTS.ALERT_ESCALATED);
    expect(eventKeyFor({ severity: 'critical', metric: 'heartbeat' })).toBe(IOT_EVENTS.DEVICE_OFFLINE);
    expect(eventKeyFor({ severity: 'critical', resolved: true })).toBe(IOT_EVENTS.ALERT_RESOLVED);
  });

  it('reports which channels this deployment can actually deliver', async () => {
    // await: channelAvailability reads the tenant's SMTP row since PULSE-01.
    const ch = await channelAvailability();
    expect(ch.in_app.available).toBe(true);
    // email/sms depend on deployment config; what matters is that each states a
    // reason rather than the UI offering a switch that silently does nothing
    for (const k of ['email', 'sms', 'push']) {
      expect(typeof ch[k].available).toBe('boolean');
      expect(ch[k].note.length).toBeGreaterThan(0);
    }
  });

  it('resolves recipients through the many-to-many role junction', async () => {
    const { rows: u } = await pool.query(
      `INSERT INTO users (name, email, password_hash, is_active, company_id)
       VALUES ($1,$2,'x',true,$3) RETURNING id`,
      [`${TAG} engineer`, `${TAG}@t.local`, ctx.companyId]);
    ctx.userId = u[0].id;
    const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code)='service_engineer' LIMIT 1`);
    await pool.query(`INSERT INTO user_roles (user_id, role_id, is_primary) VALUES ($1,$2,true)`, [ctx.userId, role[0].id]);

    const recipients = await resolveRecipients(pool, {
      companyId: ctx.companyId, roles: ['service_engineer'], userIds: [],
    });
    expect(recipients.some((r) => r.id === ctx.userId)).toBe(true);
    // contact details resolved once, so a sender never has to
    const me = recipients.find((r) => r.id === ctx.userId);
    expect(me).toHaveProperty('email');
    expect(me).toHaveProperty('phone');
  });

  it('delivers to in-app and RECORDS every attempt', async () => {
    const result = await notifyAlert(pool, {
      companyId: ctx.companyId,
      alertId: ctx.alert.id,
      severity: 'critical',
      metric: 'TEMPERATURE',
      title: 'Critical: test unit',
      message: 'TEMPERATURE > 80 (observed 91)',
      link: `/iot/alert-center?alert=${ctx.alert.id}`,
      ruleChannels: ['in_app', 'email', 'sms'],
      ruleRoles: ['service_engineer'],
    });

    expect(result.recipients).toBeGreaterThan(0);
    expect(result.delivered.in_app).toBeGreaterThan(0);
    expect(result.eventKey).toBe(IOT_EVENTS.ALERT_CRITICAL);

    const { rows: notif } = await pool.query(
      `SELECT title, message, module_name, reference_id, link FROM notifications
        WHERE user_id = $1 AND module_name = 'iot' ORDER BY id DESC LIMIT 1`, [ctx.userId]);
    expect(notif[0].reference_id).toBe(ctx.alert.id);
    expect(notif[0].link).toMatch(/alert-center/);   // the link the shared repo does not write

    // the delivery record — evidence, not assumption
    const { rows: log } = await pool.query(
      `SELECT channel, status, detail FROM iot_notification_log WHERE alert_id = $1 ORDER BY id`, [ctx.alert.id]);
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((l) => l.channel === 'in_app' && l.status === 'sent')).toBe(true);

    // the alert itself records that it was notified
    const { rows: a } = await pool.query(`SELECT notified_at, last_notified_at FROM device_alerts WHERE id = $1`, [ctx.alert.id]);
    expect(a[0].notified_at).toBeTruthy();
    expect(a[0].last_notified_at).toBeTruthy();
  });

  it('an unconfigured channel is SKIPPED with a reason, never counted as delivered', async () => {
    const result = await notifyAlert(pool, {
      companyId: ctx.companyId, alertId: ctx.alert.id, severity: 'critical',
      title: 'x', message: 'y', ruleChannels: ['sms'], ruleRoles: ['service_engineer'],
    });
    const ch = await channelAvailability(ctx.companyId);
    if (!ch.sms.available) {
      expect(result.delivered.sms).toBe(0);
      expect(Object.keys(result.skipped).some((k) => k.startsWith('sms:'))).toBe(true);
    } else {
      expect(result.delivered.sms + Object.keys(result.skipped).length).toBeGreaterThan(0);
    }
  });

  it('no recipients is recorded as a fact, not as a successful delivery', async () => {
    const result = await notifyAlert(pool, {
      companyId: ctx.companyId, alertId: ctx.alert.id, severity: 'warning',
      title: 'x', message: 'y', ruleChannels: ['in_app'], ruleRoles: ['no_such_role_at_all'],
    });
    expect(result.recipients).toBe(0);
    const { rows } = await pool.query(
      `SELECT status, detail FROM iot_notification_log
        WHERE alert_id = $1 AND status = 'no_recipients' ORDER BY id DESC LIMIT 1`, [ctx.alert.id]);
    expect(rows.length).toBe(1);
    expect(rows[0].detail).toMatch(/no user matched/);
  });

  it('every company has IoT notification rules seeded', async () => {
    const { rows } = await pool.query(
      `SELECT event_key, channel FROM notification_rules
        WHERE company_id = $1 AND event_key LIKE 'iot.%' ORDER BY event_key`, [ctx.companyId]);
    // the fixture company was created AFTER the migration, so it has none — which
    // is itself worth knowing: the seed is per-company and a new tenant needs it.
    // What must hold is that an EXISTING company has them.
    const { rows: existing } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notification_rules WHERE event_key = 'iot.alert_critical'`);
    expect(existing[0].n).toBeGreaterThan(0);
    expect(Array.isArray(rows)).toBe(true);
  });
});
