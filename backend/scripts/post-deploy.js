#!/usr/bin/env node
/**
 * post-deploy.js — Post-deployment migration verification
 *
 * Usage:
 *   node scripts/post-deploy.js              # verify + write manifest
 *   node scripts/post-deploy.js --json       # machine-readable output
 *   node scripts/post-deploy.js --strict     # exit 1 on ANY warning
 *
 * Exits 0 on success, 1 on failure.
 *
 * Checks performed:
 *   1. All migration files on disk are recorded in schema_migrations
 *   2. No checksum mismatches (tamper detection)
 *   3. Core tables exist in the database
 *   4. schema_migrations rows have checksums (detects legacy rows)
 *   5. Writes post-deploy manifest to backups/post-deploy-TIMESTAMP.json
 */

import { spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load env ──────────────────────────────────────────────────────────────────
const dotenvPath = path.join(__dirname, '../.env');
if (fs.existsSync(dotenvPath)) {
  const vars = fs.readFileSync(dotenvPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='));
  for (const line of vars) {
    const [k, ...rest] = line.split('=');
    process.env[k.trim()] = rest.join('=').trim();
  }
}

const args   = process.argv.slice(2);
const strict = args.includes('--strict');
const jsonMode = args.includes('--json');

const MIGRATIONS_DIR = path.join(__dirname, '../src/database/migrations');
const BACKUP_DIR     = path.join(__dirname, '../backups');

const DB = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || '5432',
  name:     process.env.DB_NAME     || 'Pulse',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
};

const pgEnv = { ...process.env, PGPASSWORD: DB.password };

// Core tables that must exist in every Pulse deployment
const REQUIRED_TABLES = [
  'employees',
  'users',
  'schema_migrations',
];

// Strongly-expected tables (warn if missing, don't fail)
const EXPECTED_TABLES = [
  'leaves',
  'payroll_runs',
  'health_checks',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
let errors   = [];
let warnings = [];
let info     = [];

function log(msg)  { if (!jsonMode) console.log(msg); }
function err(msg)  { errors.push(msg);   if (!jsonMode) console.error(msg); }
function warn(msg) { warnings.push(msg); if (!jsonMode) console.warn(msg); }
function note(msg) { info.push(msg);     if (!jsonMode) console.log(msg); }

function fileChecksum(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function psql(sql) {
  return spawnSync('psql', [
    '-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', DB.name,
    '-c', sql, '-t', '-A',
  ], { env: pgEnv, encoding: 'utf8', timeout: 15000 });
}

function psqlRows(sql, sep = '|') {
  const r = psql(sql);
  if (r.status !== 0) return null;
  return r.stdout.trim().split('\n').filter(Boolean).map(l => l.split(sep));
}

// ── Check 1: all migration files applied ─────────────────────────────────────
function checkAllMigrationsApplied() {
  log('\n[1/4] Verifying all migrations are applied...');

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    warn('  ⚠️   Migrations directory not found');
    return { ok: true, applied: [], missing: [] };
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js')).sort();

  const rows = psqlRows('SELECT name FROM schema_migrations ORDER BY name');
  if (rows === null) {
    err('  ❌  Cannot query schema_migrations — migrations may not have run');
    return { ok: false, applied: [], missing: files };
  }

  const appliedNames = new Set(rows.map(r => r[0]).filter(Boolean));
  const missing = files.filter(f => !appliedNames.has(f));

  if (missing.length === 0) {
    note(`  ✅  All ${files.length} migration(s) applied`);
  } else {
    missing.forEach(f => err(`  ❌  Not applied: ${f}`));
  }

  return { ok: missing.length === 0, applied: [...appliedNames], missing };
}

// ── Check 2: checksum integrity ───────────────────────────────────────────────
function checkChecksums() {
  log('\n[2/4] Verifying migration checksums...');

  const rows = psqlRows(
    'SELECT name, checksum FROM schema_migrations WHERE checksum IS NOT NULL ORDER BY name'
  );
  if (rows === null) {
    warn('  ⚠️   Could not read schema_migrations');
    return;
  }

  let mismatches = 0;
  let noChecksum = 0;

  // Check stored checksums match current files
  for (const [name, checksum] of rows) {
    if (!name) continue;
    const filePath = path.join(MIGRATIONS_DIR, name);
    if (!fs.existsSync(filePath)) {
      warn(`  ⚠️   Applied migration missing from disk: ${name}`);
      continue;
    }
    const current = fileChecksum(filePath);
    if (current !== checksum) {
      err(`  ❌  Checksum mismatch: ${name}`);
      err(`       Stored : ${checksum}`);
      err(`       Current: ${current}`);
      mismatches++;
    }
  }

  // Warn about rows without checksums (applied before versioning was added)
  const allRows = psqlRows('SELECT name, checksum FROM schema_migrations ORDER BY name');
  if (allRows) {
    noChecksum = allRows.filter(([, cs]) => !cs).length;
    if (noChecksum > 0) {
      warn(`  ⚠️   ${noChecksum} migration row(s) have no checksum — applied before versioning`);
      warn('       Re-run npm run migrate to backfill (checksums are set on new applications only)');
    }
  }

  if (mismatches === 0) {
    note(`  ✅  All ${rows.length} checksums valid`);
  }
}

// ── Check 3: required tables exist ───────────────────────────────────────────
function checkTables() {
  log('\n[3/4] Verifying database tables...');

  const rows = psqlRows(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );

  if (rows === null) {
    err('  ❌  Cannot query pg_tables');
    return;
  }

  const existingTables = new Set(rows.map(r => r[0]).filter(Boolean));
  note(`  📋  Public tables found: ${existingTables.size}`);

  for (const t of REQUIRED_TABLES) {
    if (existingTables.has(t)) {
      note(`  ✅  ${t}`);
    } else {
      err(`  ❌  Required table missing: ${t}`);
    }
  }

  for (const t of EXPECTED_TABLES) {
    if (existingTables.has(t)) {
      note(`  ✅  ${t}`);
    } else {
      warn(`  ⚠️   Expected table not found: ${t}`);
    }
  }
}

// ── Check 4: schema_migrations row count sanity ───────────────────────────────
function checkMigrationCount() {
  log('\n[4/4] Checking schema_migrations record count...');

  const r = psql('SELECT COUNT(*) FROM schema_migrations');
  if (r.status !== 0) {
    warn('  ⚠️   Could not count schema_migrations rows');
    return;
  }

  const count = parseInt(r.stdout.trim());
  if (count === 0) {
    warn('  ⚠️   schema_migrations has 0 rows — no migrations recorded');
  } else {
    note(`  ✅  ${count} migration(s) recorded in schema_migrations`);
  }
}

// ── Write manifest ────────────────────────────────────────────────────────────
function writeManifest(data) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts   = timestamp();
  const file = path.join(BACKUP_DIR, `post-deploy-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

// ── Main ──────────────────────────────────────────────────────────────────────
log('╔══════════════════════════════════════════════════════════╗');
log('║           Pulse ERP — Post-Deploy Verification           ║');
log('╚══════════════════════════════════════════════════════════╝');
log(`  Database : ${DB.name}@${DB.host}:${DB.port}`);
log(`  Time     : ${new Date().toISOString()}`);

const { ok, applied, missing } = checkAllMigrationsApplied();
checkChecksums();
checkTables();
checkMigrationCount();

const manifest = {
  timestamp: new Date().toISOString(),
  database:  `${DB.name}@${DB.host}:${DB.port}`,
  node:      process.version,
  ok:        errors.length === 0,
  errors,
  warnings,
  applied_migrations:  applied,
  missing_migrations:  missing,
};

const manifestFile = writeManifest(manifest);

log('\n── Summary ──────────────────────────────────────────────────');
log(`  Errors   : ${errors.length}`);
log(`  Warnings : ${warnings.length}`);
log(`  Applied  : ${applied.length} migration(s)`);
if (missing.length) log(`  Missing  : ${missing.length} migration(s)`);
log(`  Manifest : ${path.basename(manifestFile)}`);
log('─────────────────────────────────────────────────────────────\n');

if (jsonMode) {
  console.log(JSON.stringify(manifest, null, 2));
}

const exitFailure = errors.length > 0 || (strict && warnings.length > 0);

if (exitFailure) {
  console.error(`\n🚫  Post-deploy verification FAILED (${errors.length} error(s), ${warnings.length} warning(s)).\n`);
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn(`⚠️   Verification passed with ${warnings.length} warning(s).\n`);
} else {
  console.log('✅  Post-deploy verification passed. Deployment successful.\n');
}
