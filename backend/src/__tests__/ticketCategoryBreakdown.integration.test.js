/**
 * 'Breakdown' in the ticket-category master — 20261014000005.
 *
 * modules/iot/alertActions.js files every IoT alert ticket under 'Breakdown',
 * and the master never held it: the pickers could not offer it back, and
 * integration.ticketCategories' "every category in use is in the master"
 * failed whenever such a ticket existed.
 *
 * Covered here:
 *   - the migration is idempotent, never duplicates under any case/spacing,
 *     never touches other categories or any ticket, and its rollback removes
 *     only its own row (and refuses while a ticket references it);
 *   - the category the IoT code writes IS in the master (read from the source,
 *     so a future rename of either side fails here);
 *   - a real IoT critical alert (handleAlertOpened) creates a Breakdown ticket
 *     that the master-membership invariant accepts;
 *   - GET /finance/ticket-categories — what both ticket forms read — offers it.
 *
 * The migration checks run inside a transaction that is always rolled back.
 * IoT fixtures live in a registry tenant (testTenantIds.contract.test.js) and
 * are deleted in afterAll. ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}

const { default: pool } = await import('../config/db.js');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { default: extended } = await import('../modules/finance/routes/extended.routes.js');
const { handleAlertOpened } = await import('../modules/iot/alertActions.js');
const migration = await import('../database/migrations/20261014000005_ticket_category_breakdown.js');

const CO = 999968;
const fx = {};

/** Same shim the migration runner passes as `knex` (config/migrations.js). */
const shim = (client) => ({ raw: (sql, b) => client.query(sql, b || []) });
const breakdownRows = async (db) => (await db.query(
  `SELECT id, name, is_active, description FROM ticket_categories WHERE LOWER(BTRIM(name)) = 'breakdown' ORDER BY id`)).rows;
const othersChecksum = async (db) => (await db.query(
  `SELECT count(*)::int n,
          md5(string_agg(id || '|' || name || '|' || coalesce(description,'') || '|' || is_active, ',' ORDER BY id)) h
     FROM ticket_categories WHERE LOWER(BTRIM(name)) <> 'breakdown'`)).rows[0];
const ticketsChecksum = async (db) => (await db.query(
  `SELECT count(*)::int n,
          md5(string_agg(id || '|' || coalesce(category,'') || '|' || coalesce(category_id::text,''), ',' ORDER BY id)) h
     FROM support_tickets`)).rows[0];

/**
 * Run fn inside a transaction that is ALWAYS rolled back.
 *
 * REPEATABLE READ (§221): every statement in the transaction reads ONE
 * snapshot, plus the transaction's own writes. Under the default READ
 * COMMITTED each SELECT saw rows other suites committed meanwhile, so a ticket
 * created by a parallel worker between the before- and after-checksums made
 * "touches no other ticket" fail at random (expected n 17 to be 16). The
 * assertion is unchanged — still the whole table — it now compares like with like.
 */
async function inRolledBackTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function cleanup() {
  for (const sql of [
    `DELETE FROM iot_notification_log WHERE company_id = $1`,
    `DELETE FROM iot_device_events WHERE company_id = $1`,
    `DELETE FROM device_alerts WHERE company_id = $1`,
    `DELETE FROM support_tickets WHERE company_id = $1`,
    `DELETE FROM customer_equipment WHERE company_id = $1`,
    `DELETE FROM interview_questions WHERE company_id = $1`,
    `DELETE FROM companies WHERE id = $1`,
  ]) await pool.query(sql, [CO]);
}

beforeAll(async () => {
  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1, 'ZZ Ticket Breakdown', 'ZZTCBD')`, [CO]);
  fx.equipment = (await pool.query(
    `INSERT INTO customer_equipment
       (company_id, equipment_name, serial_number, device_uid, telemetry_token_hash,
        sampling_secs, device_status, connection_state)
     VALUES ($1, 'ZZTCBD Chiller', 'ZZTCBD-SN-1', 'ZZTCBD-UID-1', 'zz-not-a-real-hash', 60, 'active', 'never')
     RETURNING id`, [CO])).rows[0];
}, 60000);

afterAll(cleanup);

describe('migration 20261014000005', () => {
  it('has added exactly one active Breakdown row to the live master', async () => {
    const rows = await breakdownRows(pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Breakdown', is_active: true });
  });

  it('is idempotent: re-running adds nothing and touches no other category or ticket', async () => {
    await inRolledBackTx(async (c) => {
      const others = await othersChecksum(c);
      const tickets = await ticketsChecksum(c);
      await migration.up(shim(c));
      await migration.up(shim(c));
      expect(await breakdownRows(c)).toHaveLength(1);
      expect(await othersChecksum(c)).toEqual(others);
      expect(await ticketsChecksum(c)).toEqual(tickets);
    });
  });

  it('on a database without it, inserts exactly one; with a variant already present, inserts none', async () => {
    await inRolledBackTx(async (c) => {
      await c.query(`DELETE FROM ticket_categories WHERE LOWER(BTRIM(name)) = 'breakdown'`);
      await migration.up(shim(c));
      await migration.up(shim(c));
      expect((await breakdownRows(c)).map((r) => r.name)).toEqual(['Breakdown']);

      await c.query(`DELETE FROM ticket_categories WHERE LOWER(BTRIM(name)) = 'breakdown'`);
      await c.query(`INSERT INTO ticket_categories (name, description, is_active) VALUES ('  BREAKDOWN ', 'admin', false)`);
      await migration.up(shim(c));
      const rows = await breakdownRows(c);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: '  BREAKDOWN ', is_active: false });   // an admin's choice stands
    });
  });

  it('rollback removes only its own row, and refuses while a ticket references it', async () => {
    await inRolledBackTx(async (c) => {
      // Other suites (IoT) may have live tickets linked to the real row, which
      // would — correctly — make down() refuse. So, inside this rolled-back
      // transaction only, hold the real row aside under another name and let
      // up() create a fresh one that only this test references. Readers in
      // other transactions keep seeing the committed row (MVCC); nothing here
      // survives the ROLLBACK.
      await c.query(`UPDATE ticket_categories SET name = 'ZZTCBD held' WHERE LOWER(BTRIM(name)) = 'breakdown'`);
      await migration.up(shim(c));
      const [row] = await breakdownRows(c);
      await c.query(
        `INSERT INTO support_tickets (ticket_number, title, description, category, category_id, priority, status, company_id)
         VALUES ('ZZTCBD-1', 'ZZTCBD ref', 'x', 'Breakdown', $1, 'High', 'Open', $2)`, [row.id, CO]);
      await expect(migration.down(shim(c))).rejects.toThrow(/1 ticket\(s\) reference/);
      await c.query(`DELETE FROM support_tickets WHERE ticket_number = 'ZZTCBD-1'`);
      const others = await othersChecksum(c);
      await migration.down(shim(c));
      expect(await breakdownRows(c)).toEqual([]);
      expect(await othersChecksum(c)).toEqual(others);
    });
  });
});

describe('IoT alert tickets', () => {
  it('the category the IoT code writes is the one in the master', async () => {
    const src = readFileSync(resolve(here, '../modules/iot/alertActions.js'), 'utf8');
    const insert = src.slice(src.indexOf('INSERT INTO support_tickets'));
    const literals = [...insert.slice(0, insert.indexOf('RETURNING')).matchAll(/'([A-Za-z][A-Za-z ]*)'/g)].map((m) => m[1]);
    expect(literals).toContain('Breakdown');
    const master = (await pool.query(`SELECT LOWER(BTRIM(name)) AS n FROM ticket_categories WHERE is_active`)).rows.map((r) => r.n);
    expect(master).toContain('breakdown');
  });

  it('a critical alert creates a Breakdown ticket that the master accepts', async () => {
    const { rows: [alert] } = await pool.query(
      `INSERT INTO device_alerts (company_id, equipment_id, metric, severity, state, message)
       VALUES ($1, $2, 'THD_I_L1', 'critical', 'active', 'ZZTCBD trip') RETURNING id`,
      [CO, fx.equipment.id]);
    const out = await handleAlertOpened(pool, { alert_id: alert.id, create_ticket: true });
    expect(out.ticket_id).toBeTruthy();

    const { rows: [t] } = await pool.query(`SELECT category, category_id, ticket_kind FROM support_tickets WHERE id = $1`, [out.ticket_id]);
    const [master] = await breakdownRows(pool);
    // Linked to the master row, like every other ticket — so the
    // integration.ticketCategories "no unlinked ticket" invariant holds too.
    expect(t).toEqual({ category: 'Breakdown', category_id: master.id, ticket_kind: 'service' });

    // The invariant integration.ticketCategories asserts, scoped to this ticket.
    const { rows: orphan } = await pool.query(
      `SELECT 1 FROM support_tickets s
        WHERE s.id = $1
          AND NOT EXISTS (SELECT 1 FROM ticket_categories c WHERE LOWER(BTRIM(c.name)) = LOWER(BTRIM(s.category)))`,
      [out.ticket_id]);
    expect(orphan).toEqual([]);
  });
});

describe('the ticket forms offer it', () => {
  it('GET /finance/ticket-categories — read by Service Desk and Tickets — lists Breakdown once', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { userId: 1, roles: ['admin'], company_id: 1 }; next(); });
    app.use('/finance', extended);
    const res = await request(app).get('/finance/ticket-categories');
    expect(res.status).toBe(200);
    const names = res.body.map((c) => c.name);
    expect(names.filter((n) => n.toLowerCase() === 'breakdown')).toEqual(['Breakdown']);
    // ...and every category that was there before still is.
    for (const n of ['Hardware', 'Software', 'Network', 'IT Support', 'Facilities', 'Security', 'Other']) {
      expect(names).toContain(n);
    }
  });
});
