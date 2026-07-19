#!/usr/bin/env node
/**
 * pre-deploy.js — Pre-deployment safety checks
 *
 * Usage:
 *   node scripts/pre-deploy.js              # run all checks + take backup
 *   node scripts/pre-deploy.js --skip-backup  # checks only (CI environments with own backup)
 *   node scripts/pre-deploy.js --json       # machine-readable output
 *
 * Exits 0 on success, 1 on any failure (hard-blocks deployment pipeline).
 *
 * Checks performed:
 *   1. .env sanity — required variables present
 *   2. DB connectivity
 *   3. Migration tamper detection — applied migrations not modified on disk
 *   4. Pending migration preview — lists what WILL be applied
 *   5. Pre-deploy database backup (unless --skip-backup)
 *   6. Writes pre-deploy manifest to backups/pre-deploy-TIMESTAMP.json
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

const args       = process.argv.slice(2);
const skipBackup = args.includes('--skip-backup');
const jsonMode   = args.includes('--json');

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

// ── Check 1: required env vars ────────────────────────────────────────────────
function checkEnv() {
  log('\n[1/5] Checking environment variables...');
  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET'];
  const missing  = required.filter(k => !process.env[k]);

  if (missing.length) {
    err(`  ❌  Missing required env vars: ${missing.join(', ')}`);
  } else {
    note('  ✅  All required env vars present');
  }

  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    warn('  ⚠️   JWT_SECRET is shorter than 32 characters — consider strengthening it');
  }

  if (process.env.NODE_ENV !== 'production') {
    warn(`  ⚠️   NODE_ENV="${process.env.NODE_ENV || 'unset'}" — expected "production" for a deploy`);
  }
}

// ── Check 2: DB connectivity ──────────────────────────────────────────────────
function checkDbConnectivity() {
  log('\n[2/5] Checking database connectivity...');
  const r = spawnSync('psql', [
    '-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', DB.name,
    '-c', 'SELECT 1 AS ok',
    '-t', '-A',
  ], { env: pgEnv, encoding: 'utf8', timeout: 10000 });

  if (r.error || r.status !== 0) {
    err(`  ❌  Cannot connect to ${DB.user}@${DB.host}:${DB.port}/${DB.name}`);
    err(`       ${(r.stderr || r.error?.message || '').trim()}`);
    return false;
  }
  note(`  ✅  Connected to ${DB.name}@${DB.host}:${DB.port}`);
  return true;
}

// ── Check 3: migration tamper detection ──────────────────────────────────────
function checkMigrationIntegrity() {
  log('\n[3/5] Checking migration integrity...');

  // Query applied migrations with their stored checksums
  const r = spawnSync('psql', [
    '-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', DB.name,
    '-c', `SELECT name, checksum FROM schema_migrations WHERE checksum IS NOT NULL ORDER BY name`,
    '-t', '-A', '--field-separator=|',
  ], { env: pgEnv, encoding: 'utf8', timeout: 10000 });

  if (r.status !== 0) {
    warn('  ⚠️   schema_migrations table not found — migrations have not run yet');
    return;
  }

  const rows = r.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [name, checksum] = line.split('|');
    return { name, checksum };
  });

  let tampered = 0;
  for (const { name, checksum } of rows) {
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
      err('       This migration was modified after being applied — this is dangerous.');
      tampered++;
    }
  }

  if (tampered === 0) {
    note(`  ✅  All ${rows.length} applied migration(s) have valid checksums`);
  }
}

// ── Check 4: pending migrations preview ──────────────────────────────────────
function checkPendingMigrations() {
  log('\n[4/5] Previewing pending migrations...');

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    warn('  ⚠️   Migrations directory not found: ' + MIGRATIONS_DIR);
    return [];
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js')).sort();

  const r = spawnSync('psql', [
    '-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', DB.name,
    '-c', 'SELECT name FROM schema_migrations ORDER BY name',
    '-t', '-A',
  ], { env: pgEnv, encoding: 'utf8', timeout: 10000 });

  const appliedNames = new Set(
    (r.status === 0 ? r.stdout.trim().split('\n') : []).filter(Boolean)
  );

  const pending = files.filter(f => !appliedNames.has(f));

  if (pending.length === 0) {
    note('  ✅  No pending migrations — schema is up to date');
  } else {
    note(`  📋  ${pending.length} migration(s) will be applied:`);
    pending.forEach(f => note(`       → ${f}  (sha256:${fileChecksum(path.join(MIGRATIONS_DIR, f)).slice(0, 12)}…)`));
  }

  return pending;
}

// ── Check 5: pre-deploy backup ────────────────────────────────────────────────
function takeBackup() {
  log('\n[5/5] Taking pre-deploy backup...');

  const r = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (r.error) {
    warn('  ⚠️   pg_dump not found — skipping backup (install PostgreSQL client tools)');
    return null;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts   = timestamp();
  const file = path.join(BACKUP_DIR, `pre-deploy-${ts}.sql`);

  const result = spawnSync('pg_dump', [
    '-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', DB.name,
    '--format=plain', '--no-owner', '--no-acl', '-f', file,
  ], { env: pgEnv, encoding: 'utf8' });

  if (result.status !== 0) {
    err('  ❌  Backup failed:\n' + result.stderr);
    return null;
  }

  const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  note(`  ✅  Backup written: ${path.basename(file)} (${sizeMB} MB)`);
  return file;
}

// ── Write manifest ────────────────────────────────────────────────────────────
function writeManifest(data) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts   = timestamp();
  const file = path.join(BACKUP_DIR, `pre-deploy-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

// ── Main ──────────────────────────────────────────────────────────────────────
log('╔══════════════════════════════════════════════════════════╗');
log('║              Pulse ERP — Pre-Deploy Checks               ║');
log('╚══════════════════════════════════════════════════════════╝');
log(`  Database : ${DB.name}@${DB.host}:${DB.port}`);
log(`  Node     : ${process.version}`);
log(`  Time     : ${new Date().toISOString()}`);

checkEnv();
const dbOk   = checkDbConnectivity();
if (dbOk) {
  checkMigrationIntegrity();
}
const pending = dbOk ? checkPendingMigrations() : [];
const backupFile = (!skipBackup && dbOk) ? takeBackup() : null;

const manifest = {
  timestamp:   new Date().toISOString(),
  database:    `${DB.name}@${DB.host}:${DB.port}`,
  node:        process.version,
  errors,
  warnings,
  pending_migrations: pending,
  backup_file: backupFile ? path.basename(backupFile) : null,
};

const manifestFile = writeManifest(manifest);

log('\n── Summary ──────────────────────────────────────────────────');
log(`  Errors   : ${errors.length}`);
log(`  Warnings : ${warnings.length}`);
log(`  Pending  : ${pending.length} migration(s)`);
if (backupFile) log(`  Backup   : ${path.basename(backupFile)}`);
log(`  Manifest : ${path.basename(manifestFile)}`);
log('─────────────────────────────────────────────────────────────\n');

if (jsonMode) {
  console.log(JSON.stringify(manifest, null, 2));
}

if (errors.length > 0) {
  console.error(`\n🚫  Pre-deploy checks FAILED (${errors.length} error(s)). Deployment blocked.\n`);
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn(`\n⚠️   Pre-deploy completed with ${warnings.length} warning(s). Review before proceeding.\n`);
}

console.log('✅  Pre-deploy checks passed. Safe to deploy.\n');
