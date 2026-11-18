/**
 * DB-01C3 (manual §248): application code changes no schema.
 *
 * The application role must not be able to create or alter tables, so a statement
 * like this in a route file fails as soon as that role is in use. Schema changes
 * belong in database/migrations. Comments are stripped first, because many files
 * explain their history in them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..');
const BACKEND = path.resolve(SRC, '..');
const SKIP = new Set(['__tests__', 'migrations', 'seeds', 'node_modules']);

const DDL = /\b(CREATE\s+(TEMP(ORARY)?\s+|UNLOGGED\s+)?TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE|DROP\s+(TABLE|INDEX|TRIGGER|FUNCTION|VIEW|SEQUENCE)|CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER|VIEW)|CREATE\s+SEQUENCE|CREATE\s+TYPE|CREATE\s+EXTENSION|TRUNCATE\s+(TABLE\s+)?\w)/i;

// The only two places allowed, each for a reason the role design already accounts for.
const ALLOWED = new Map([
  // The migrator's own ledger table. Runs from `npm run migrate`, never from the server.
  ['src/config/migrations.js', 2],
  // Telemetry retention. Off by default, and it stays with the database owner (§241, §248).
  ['src/jobs/iotPartitions.cron.js', 1],
]);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const count = (s) => (stripComments(s).match(new RegExp(DDL.source, 'gi')) || []).length;

function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('application code runs no DDL', () => {
  it('no file outside the allowed list holds a schema statement', () => {
    const offenders = [...sources(SRC), path.join(BACKEND, 'server.js')]
      .map((f) => [path.relative(BACKEND, f).replace(/\\/g, '/'), count(readFileSync(f, 'utf8'))])
      .filter(([rel, n]) => n > 0 && ALLOWED.get(rel) !== n)
      .map(([rel, n]) => `${rel}: ${n}`);
    expect(offenders).toEqual([]);
  });

  it('the check sees a statement in a template, and ignores one in a comment', () => {
    expect(count('await pool.query(`ALTER TABLE x ADD COLUMN y int`);')).toBe(1);
    expect(count("pool.query('CREATE TABLE IF NOT EXISTS x (id int)')")).toBe(1);
    expect(count('// ALTER TABLE x\n/* CREATE TABLE y */\nconst a = 1;')).toBe(0);
  });
});
