/**
 * scripts/db/schema-compare.mjs must report real differences, and its two "expected"
 * rules and "cosmetic" class must not be able to hide one (DB-01C2, manual §239).
 * Scratch databases only (helpers/migrationFixtureDb.js).
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
const { withFixtureDb } = await import('./helpers/migrationFixtureDb.js');
const { compareSchemas, canonicalDefinition, canonicalBody } = await import('../../scripts/db/schema-compare.mjs');

const BASE = `
  CREATE TABLE purchase_requests (id serial PRIMARY KEY);
  CREATE TABLE purchase_suggestions (id serial PRIMARY KEY, converted_to_pr_id integer, status varchar(30) DEFAULT 'pending');
  CREATE TABLE device_telemetry (ts timestamptz NOT NULL, v numeric) PARTITION BY RANGE (ts);
  CREATE TABLE device_telemetry_2026_01 PARTITION OF device_telemetry FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');`;
const FK = (suffix = '') => `ALTER TABLE purchase_suggestions ADD CONSTRAINT fk_suggestions_converted_pr
  FOREIGN KEY (converted_to_pr_id) REFERENCES purchase_requests(id) ON DELETE SET NULL ${suffix}`;

async function pair(sqlA, sqlB) {
  let out;
  await withFixtureDb('schcmp', async ({ client: a }) => {
    await withFixtureDb('schcmp', async ({ client: b }) => {
      await a.query(BASE); await b.query(BASE);
      if (sqlA) await a.query(sqlA);
      if (sqlB) await b.query(sqlB);
      out = await compareSchemas(a, b);
    });
  });
  return out;
}
const keys = (list) => list.map((e) => e.key);

describe('schema-compare', () => {
  it('identical schemas report nothing', async () => {
    const r = await pair();
    expect([r.genuine, r.expected, r.cosmetic]).toEqual([[], [], []]);
  }, 60000);

  it.each([
    ['an extra table', `CREATE TABLE zz_extra (id int)`, null, 'zz_extra'],
    ['an extra column', `ALTER TABLE purchase_suggestions ADD COLUMN note text`, null, 'purchase_suggestions.note'],
    ['a different column type', `ALTER TABLE purchase_suggestions ALTER COLUMN status TYPE text`, null, 'purchase_suggestions.status'],
    ['a dropped NOT NULL', `ALTER TABLE purchase_suggestions ALTER COLUMN status SET NOT NULL`, null, 'purchase_suggestions.status'],
    ['a different default', `ALTER TABLE purchase_suggestions ALTER COLUMN status SET DEFAULT 'x'`, null, 'purchase_suggestions.status'],
    ['an extra index', `CREATE INDEX zz_idx ON purchase_suggestions (status)`, null, 'zz_idx'],
    ['an extra constraint', `ALTER TABLE purchase_suggestions ADD CONSTRAINT zz_c CHECK (id > 0)`, null, 'purchase_suggestions.zz_c'],
    ['a different CHECK literal list', `ALTER TABLE purchase_suggestions ADD CONSTRAINT zz_c CHECK (status IN ('a','b'))`,
      `ALTER TABLE purchase_suggestions ADD CONSTRAINT zz_c CHECK (status IN ('a','c'))`, 'purchase_suggestions.zz_c'],
    ['a sequence', `CREATE SEQUENCE zz_seq`, null, 'zz_seq'],
    ['a sequence with a different start', `CREATE SEQUENCE zz_seq START 5`, `CREATE SEQUENCE zz_seq START 6`, 'zz_seq'],
    ['a view', `CREATE VIEW zz_v AS SELECT 1 AS n`, null, 'zz_v'],
    ['a function body', `CREATE FUNCTION zz_f() RETURNS int LANGUAGE sql AS 'SELECT 1'`, `CREATE FUNCTION zz_f() RETURNS int LANGUAGE sql AS 'SELECT 2'`, 'zz_f()'],
    ['SECURITY DEFINER', `CREATE FUNCTION zz_f() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`, `CREATE FUNCTION zz_f() RETURNS int LANGUAGE sql AS 'SELECT 1'`, 'zz_f()'],
    ['a disabled trigger', `CREATE FUNCTION zz_t() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
       CREATE TRIGGER zz_tr BEFORE INSERT ON purchase_suggestions FOR EACH ROW EXECUTE FUNCTION zz_t();
       ALTER TABLE purchase_suggestions DISABLE TRIGGER zz_tr;`,
      `CREATE FUNCTION zz_t() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
       CREATE TRIGGER zz_tr BEFORE INSERT ON purchase_suggestions FOR EACH ROW EXECUTE FUNCTION zz_t();`, 'purchase_suggestions.zz_tr'],
  ])('reports %s as genuine', async (_label, a, b, key) => {
    const r = await pair(a, b);
    expect(keys(r.genuine)).toContain(key);
  }, 60000);

  it('a telemetry partition is expected only if it really is a partition', async () => {
    const real = await pair(`CREATE TABLE device_telemetry_2026_02 PARTITION OF device_telemetry FOR VALUES FROM ('2026-02-01') TO ('2026-03-01')`);
    expect(real.genuine).toEqual([]);
    expect(keys(real.expected)).toContain('device_telemetry_2026_02');

    const impostor = await pair(`CREATE TABLE device_telemetry_2026_02 (id int)`);
    expect(keys(impostor.genuine)).toContain('device_telemetry_2026_02');
  }, 60000);

  it('the FK is expected as NOT VALID only while a pointer really dangles', async () => {
    const dangling = await pair(
      `INSERT INTO purchase_suggestions (converted_to_pr_id) VALUES (1451); ${FK('NOT VALID')}`, FK());
    expect(dangling.genuine).toEqual([]);
    expect(dangling.expected.map((e) => e.rule)).toEqual(['NOT VALID with 1 dangling pointer(s)']);

    const clean = await pair(FK('NOT VALID'), FK());
    expect(keys(clean.genuine)).toEqual(['purchase_suggestions.fk_suggestions_converted_pr']);
  }, 60000);

  it('a different FK action is genuine even with a dangling pointer', async () => {
    const r = await pair(
      `INSERT INTO purchase_suggestions (converted_to_pr_id) VALUES (1451); ALTER TABLE purchase_suggestions ADD CONSTRAINT fk_suggestions_converted_pr FOREIGN KEY (converted_to_pr_id) REFERENCES purchase_requests(id) ON DELETE CASCADE NOT VALID`,
      FK());
    expect(keys(r.genuine)).toEqual(['purchase_suggestions.fk_suggestions_converted_pr']);
  }, 60000);

  it('the two print forms of one varchar list are cosmetic, and nothing else is', () => {
    const a = `CHECK (((status)::text = ANY ((ARRAY['Pending'::character varying, 'Clear'::character varying])::text[])))`;
    const b = `CHECK (((status)::text = ANY (ARRAY[('Pending'::character varying)::text, ('Clear'::character varying)::text])))`;
    expect(canonicalDefinition(a)).toBe(canonicalDefinition(b));
    expect(canonicalDefinition(a)).not.toBe(canonicalDefinition(b.replace('Clear', 'Other')));
    expect(canonicalDefinition(`CHECK ((a > 1))`)).not.toBe(canonicalDefinition(`CHECK ((a > 2))`));
    expect(canonicalDefinition(`CHECK ((a)::text = 'x')`)).not.toBe(canonicalDefinition(`CHECK ((a)::integer = 'x')`));
  });

  it('a function body differs cosmetically only in comments and whitespace', () => {
    expect(canonicalBody(`BEGIN\n  -- note\n  RETURN NEW;\nEND`)).toBe(canonicalBody(`BEGIN RETURN NEW; END`));
    expect(canonicalBody(`RAISE EXCEPTION 'Bad'`)).not.toBe(canonicalBody(`RAISE EXCEPTION 'bad'`));
    expect(canonicalBody(`RETURN NEW`)).not.toBe(canonicalBody(`RETURN OLD`));
  });
});
