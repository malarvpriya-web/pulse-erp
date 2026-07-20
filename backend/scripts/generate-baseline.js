#!/usr/bin/env node
/**
 * generate-baseline.js — Snapshot the current DB schema as the fresh-database
 * bootstrap artifact pair used by src/config/migrations.js:
 *
 *   src/database/baseline.sql            full schema DDL (pg_dump --schema-only)
 *   src/database/baseline-manifest.json  the migration files whose effects the
 *                                        snapshot embodies; the runner marks
 *                                        exactly these as applied after
 *                                        executing baseline.sql on a fresh DB
 *
 * Why this exists: the migration chain cannot build a database from zero —
 * the earliest migrations ALTER tables that only ever existed in the original
 * dev database (discovered when CI first ran the chain on an empty Postgres,
 * 2026-07-19). The snapshot is the reconstruction path; incremental
 * migrations continue on top of it.
 *
 * Usage:
 *   node scripts/generate-baseline.js            # writes both artifacts
 *   node scripts/generate-baseline.js --dry-run  # stats only, writes nothing
 *
 * Requires pg_dump on PATH (falls back to the standard Windows install dirs).
 * Regenerate only from a database whose ledger is fully up to date — the
 * script refuses if migration files on disk are missing from the ledger.
 */

import { spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env (same minimal parser the old version used) ──────────────────────
const dotenvPath = path.join(__dirname, '../.env');
if (fs.existsSync(dotenvPath)) {
  const vars = fs.readFileSync(dotenvPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='));
  for (const line of vars) {
    const [k, ...rest] = line.split('=');
    if (!(k.trim() in process.env)) process.env[k.trim()] = rest.join('=').trim();
  }
}

const DB = {
  host:     process.env.DB_HOST || 'localhost',
  port:     process.env.DB_PORT || '5432',
  name:     process.env.DB_NAME || 'Pulse',
  user:     process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
};
const env = { ...process.env, PGPASSWORD: DB.password };

const dryRun = process.argv.includes('--dry-run');

const MIGRATIONS_DIR = path.join(__dirname, '../src/database/migrations');
const OUT_SQL        = path.join(__dirname, '../src/database/baseline.sql');
const OUT_DATA_SQL   = path.join(__dirname, '../src/database/baseline-data.sql');
const OUT_MANIFEST   = path.join(__dirname, '../src/database/baseline-manifest.json');

// Config tables whose ROWS were seeded by data migrations and are therefore
// lost when the schema-only snapshot marks those migrations applied. Order
// matters (FK dependencies) — each is dumped separately and concatenated.
// Never add tables holding operational data or credentials (users, employees…).
const CONFIG_DATA_TABLES = ['companies', 'roles', 'role_permissions'];

// ── Find pg_dump ──────────────────────────────────────────────────────────────
function findPgDump() {
  const probe = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (!probe.error) return 'pg_dump';
  // Windows: PATH rarely includes the Postgres bin dir
  const base = 'C:\\Program Files\\PostgreSQL';
  if (fs.existsSync(base)) {
    const versions = fs.readdirSync(base).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) {
      const exe = path.join(base, v, 'bin', 'pg_dump.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  console.error('❌  pg_dump not found on PATH or under C:\\Program Files\\PostgreSQL.');
  process.exit(1);
}

// ── Dump schema ───────────────────────────────────────────────────────────────
const pgDump = findPgDump();
console.log(`🔍 Capturing schema from "${DB.name}"@${DB.host}:${DB.port}`);

const result = spawnSync(pgDump, [
  '-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', DB.name,
  '--schema-only', '--no-owner', '--no-acl', '--no-comments',
  // The runner manages the ledger itself — and creates it before the baseline
  // runs, so both the table AND its serial sequence must be excluded or the
  // bootstrap collides with them ("relation schema_migrations_id_seq already exists").
  '--exclude-table=schema_migrations',
  '--exclude-table=schema_migrations_id_seq',
], { env, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });

if (result.status !== 0) {
  console.error('❌  pg_dump failed:\n', result.stderr);
  process.exit(1);
}

// Normalize line endings; strip psql meta-commands (pg_dump >= 16.10 emits
// \restrict / \unrestrict lines, which are not SQL and break client.query).
// Also strip the set_config('search_path','') line: every object in the dump
// is schema-qualified anyway, and clearing search_path poisons the session the
// migration runner then uses for its own unqualified ledger INSERTs.
//
// SET lines are whitelisted: pg_dump emits session parameters of ITS major
// version, and the target may be older — pg_dump 18 writes
// `SET transaction_timeout = 0` (PG17+), which PG16 rejects as an
// unrecognized parameter, aborting the whole bootstrap transaction.
const SAFE_SET_PARAMS = new Set([
  'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
  'client_encoding', 'standard_conforming_strings', 'check_function_bodies',
  'xmloption', 'client_min_messages', 'row_security',
  'default_tablespace', 'default_table_access_method',
]);
function keepLine(l) {
  if (l.startsWith('\\')) return false;
  if (/set_config\('search_path'/.test(l)) return false;
  const m = l.match(/^SET\s+([a-z_]+)\s*=/i);
  if (m) return SAFE_SET_PARAMS.has(m[1].toLowerCase());
  return true;
}

const sql = result.stdout
  .replace(/\r\n/g, '\n')
  .split('\n')
  .filter(keepLine)
  .join('\n');

// ── Dump config-table data (INSERT form — COPY cannot run via client.query) ──
function cleanDump(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(keepLine)
    .join('\n');
}

let dataSql = '';
for (const table of CONFIG_DATA_TABLES) {
  const d = spawnSync(pgDump, [
    '-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', DB.name,
    '--data-only', '--no-owner', '--no-acl', '--no-comments',
    '--rows-per-insert=500',
    '-t', `public.${table}`,
  ], { env, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (d.status !== 0) {
    console.error(`❌  pg_dump (data: ${table}) failed:\n`, d.stderr);
    process.exit(1);
  }
  dataSql += `\n-- ── ${table} ──\n` + cleanDump(d.stdout);
}

// ── Build manifest: migration files embodied by this snapshot ────────────────
// A file on disk that is NOT in the source DB's ledger would be silently lost
// (marked applied without its effects being in the dump) — refuse instead.
const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js')).sort();

const { default: pool } = await import('../src/config/db.js');
const { rows } = await pool.query('SELECT name FROM schema_migrations');
const ledger = new Set(rows.map(r => r.name));
const notApplied = files.filter(f => !ledger.has(f));
if (notApplied.length) {
  console.error('❌  Refusing: these migration files are not applied to the source DB,');
  console.error('    so their effects are missing from the snapshot:');
  notApplied.forEach(f => console.error('      • ' + f));
  console.error('    Run `npm run migrate` first, then regenerate.');
  process.exit(1);
}

const manifest = {
  generated_at: new Date().toISOString(),
  source: `${DB.name}@${DB.host}:${DB.port}`,
  migrations: files,
};

const tables = (sql.match(/^CREATE TABLE/gm) || []).length;
const dataRows = (dataSql.match(/^INSERT INTO/gm) || []).length;
console.log(`   ${(sql.length / 1024).toFixed(0)} KB schema (${tables} tables), ${(dataSql.length / 1024).toFixed(0)} KB config data (${CONFIG_DATA_TABLES.join(', ')}), ${files.length} migrations embodied`);

if (dryRun) {
  console.log('✅  Dry run — nothing written.');
  process.exit(0);
}

fs.writeFileSync(OUT_SQL, sql, 'utf8');
fs.writeFileSync(OUT_DATA_SQL, dataSql, 'utf8');
fs.writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`✅  Wrote ${OUT_SQL}`);
console.log(`✅  Wrote ${OUT_DATA_SQL}`);
console.log(`✅  Wrote ${OUT_MANIFEST}`);
console.log('    Commit both. Fresh databases now bootstrap from the snapshot;');
console.log('    existing databases are unaffected.');
process.exit(0);
