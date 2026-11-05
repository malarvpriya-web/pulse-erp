/**
 * Migration fixture: 20260926000013_batch_tenant_invariant_and_suggestion_fk (§226).
 *
 * Replaces two assertions that could only pass on the developer database
 * ("the FK is NOT VALID", "suggestion 9 -> PR 1451 is the one grandfathered
 * row"). Those were facts about one database's history. What the migration
 * actually promises is a branch:
 *   - dangling pointers exist  → FK added NOT VALID, every dangling row kept
 *                                byte-for-byte, new writes checked;
 *   - none exist               → FK added and VALIDATED.
 * plus PART 1: NULL batch tenants filled from the item, then NOT NULL — or a
 * skip with a warning when a tenant cannot be derived.
 *
 * Each scenario runs the REAL migration, through the runner's own adapter, in
 * its own scratch database (helpers/migrationFixtureDb.js). The before-state is
 * the columns the migration reads, as they stood before it ran.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb, captureConsole } = await import('./helpers/migrationFixtureDb.js');
const migration = await import('../database/migrations/20260926000013_batch_tenant_invariant_and_suggestion_fk.js');

/** The tables and columns the migration reads, as they stood before it. */
async function beforeState(c) {
  await c.query(`
    CREATE TABLE inventory_items (id SERIAL PRIMARY KEY, company_id INTEGER, item_code TEXT);
    CREATE TABLE inventory_batches (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES inventory_items(id),
      company_id INTEGER,                         -- nullable before this migration
      batch_number TEXT NOT NULL);
    CREATE TABLE purchase_requests (id SERIAL PRIMARY KEY, pr_number TEXT);
    CREATE TABLE purchase_suggestions (
      id SERIAL PRIMARY KEY,
      item_id INTEGER,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      converted_to_pr_id INTEGER);               -- no FK before this migration`);
}
const fk = async (c) => (await c.query(
  `SELECT convalidated, confdeltype, confrelid::regclass::text AS ref
     FROM pg_constraint WHERE conname = 'fk_suggestions_converted_pr'`)).rows;
const rowJson = async (c, id) => (await c.query(
  `SELECT to_jsonb(s) AS j FROM purchase_suggestions s WHERE id = $1`, [id])).rows[0]?.j;

describe('20260926000013 — a dangling pointer is grandfathered, not destroyed', () => {
  it('adds the FK NOT VALID, keeps the dangling row exactly, and checks every new write', async () => {
    await withFixtureDb('sugfk', async ({ client: c, apply }) => {
      await beforeState(c);
      await c.query(`INSERT INTO inventory_items (id, company_id, item_code) VALUES (1, 5, 'ITM-1')`);
      await c.query(`INSERT INTO inventory_batches (item_id, company_id, batch_number) VALUES (1, NULL, 'LOT-1')`);
      await c.query(`INSERT INTO purchase_requests (id, pr_number) VALUES (10, 'PR-10')`);
      await c.query(`
        INSERT INTO purchase_suggestions (id, item_id, status, converted_to_pr_id) VALUES
          (1, 1, 'converted_to_pr', 10),     -- a real conversion
          (2, 1, 'converted_to_pr', 777),    -- PR 777 does not exist: dangling
          (3, 1, 'pending', NULL)`);
      const danglingBefore = await rowJson(c, 2);

      const out = await captureConsole(() => apply(migration));

      expect(await fk(c)).toEqual([{ convalidated: false, confdeltype: 'n', ref: 'purchase_requests' }]);
      expect(await rowJson(c, 2)).toEqual(danglingBefore);              // not deleted, not rewritten
      expect(out.log.join('\n')).toMatch(/1 pre-existing dangling pointer\(s\) grandfathered: suggestion 2 -> PR 777/);

      // A NEW dangling pointer is refused, and the row is left as it was.
      const before3 = await rowJson(c, 3);
      const err = await c.query(`UPDATE purchase_suggestions SET converted_to_pr_id = 778, status = 'converted_to_pr' WHERE id = 3`).catch((e) => e);
      expect([err.code, err.constraint]).toEqual(['23503', 'fk_suggestions_converted_pr']);
      expect(await rowJson(c, 3)).toEqual(before3);

      // ON DELETE SET NULL: deleting a requisition keeps the suggestion.
      await c.query(`DELETE FROM purchase_requests WHERE id = 10`);
      expect((await rowJson(c, 1)).converted_to_pr_id).toBeNull();

      // PART 1: the NULL tenant was filled from the item, then NOT NULL.
      expect((await c.query(`SELECT company_id FROM inventory_batches`)).rows).toEqual([{ company_id: 5 }]);
      expect((await c.query(`SELECT is_nullable FROM information_schema.columns
                              WHERE table_name = 'inventory_batches' AND column_name = 'company_id'`)).rows[0].is_nullable).toBe('NO');

      // Idempotent: a re-run changes nothing and leaves the FK NOT VALID.
      await captureConsole(() => apply(migration));
      expect(await fk(c)).toEqual([{ convalidated: false, confdeltype: 'n', ref: 'purchase_requests' }]);
      expect(await rowJson(c, 2)).toEqual(danglingBefore);

      // The decision is deferred, not lost: VALIDATE refuses while the pointer
      // dangles, and succeeds once a human resolves it.
      const v = await c.query(`ALTER TABLE purchase_suggestions VALIDATE CONSTRAINT fk_suggestions_converted_pr`).catch((e) => e);
      expect(v.code).toBe('23503');
      expect((await fk(c))[0].convalidated).toBe(false);
      await c.query(`UPDATE purchase_suggestions SET converted_to_pr_id = NULL WHERE id = 2`);
      await c.query(`ALTER TABLE purchase_suggestions VALIDATE CONSTRAINT fk_suggestions_converted_pr`);
      expect((await fk(c))[0].convalidated).toBe(true);
    });
  }, 60000);
});

describe('20260926000013 — with nothing to grandfather the FK is validated', () => {
  it('adds the FK and VALIDATES it straight away', async () => {
    await withFixtureDb('sugfk', async ({ client: c, apply }) => {
      await beforeState(c);
      await c.query(`INSERT INTO inventory_items (id, company_id) VALUES (1, 5)`);
      await c.query(`INSERT INTO purchase_requests (id) VALUES (10)`);
      await c.query(`INSERT INTO purchase_suggestions (id, item_id, status, converted_to_pr_id) VALUES (1, 1, 'converted_to_pr', 10), (2, 1, 'pending', NULL)`);
      const out = await captureConsole(() => apply(migration));
      expect(await fk(c)).toEqual([{ convalidated: true, confdeltype: 'n', ref: 'purchase_requests' }]);
      expect(out.log.join('\n')).toMatch(/added and VALIDATED \(no dangling pointers\)/);
      expect((await c.query(`SELECT id, converted_to_pr_id FROM purchase_suggestions ORDER BY id`)).rows)
        .toEqual([{ id: 1, converted_to_pr_id: 10 }, { id: 2, converted_to_pr_id: null }]);
    });
  }, 60000);
});

describe('20260926000013 — a lot whose tenant cannot be derived is not guessed at', () => {
  it('skips NOT NULL with a warning, leaves the lot as it was, and still installs the tenant guard', async () => {
    await withFixtureDb('sugfk', async ({ client: c, apply }) => {
      await beforeState(c);
      await c.query(`INSERT INTO inventory_items (id, company_id) VALUES (1, NULL), (2, 7)`);   // item 1 has no tenant
      await c.query(`INSERT INTO inventory_batches (id, item_id, company_id, batch_number) VALUES (1, 1, NULL, 'LOT-ORPHAN')`);
      await c.query(`SELECT setval('inventory_batches_id_seq', 1)`);
      const out = await captureConsole(() => apply(migration));
      expect(out.warn.join('\n')).toMatch(/SKIPPING NOT NULL on inventory_batches\.company_id — 1 row\(s\)/);
      expect((await c.query(`SELECT is_nullable FROM information_schema.columns
                              WHERE table_name = 'inventory_batches' AND column_name = 'company_id'`)).rows[0].is_nullable).toBe('YES');
      expect((await c.query(`SELECT company_id FROM inventory_batches WHERE id = 1`)).rows[0].company_id).toBeNull();
      // The trigger is there regardless: a lot for item 2 filled from its item, a mismatch refused.
      const { rows: [filled] } = await c.query(`INSERT INTO inventory_batches (item_id, batch_number) VALUES (2, 'LOT-2') RETURNING company_id`);
      expect(filled.company_id).toBe(7);
      const mismatch = await c.query(`INSERT INTO inventory_batches (item_id, company_id, batch_number) VALUES (2, 8, 'LOT-3')`).catch((e) => e);
      expect(mismatch.code).toBe('23514');
    });
  }, 60000);
});
