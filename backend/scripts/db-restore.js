#!/usr/bin/env node
/**
 * db-restore.js — Pulse ERP database point-in-time restore
 *
 * Usage:
 *   npm run restore -- --dry-run              # validate target without writing
 *   npm run restore -- --file backups/pulse-2026-05-29_02-00-00.sql
 *   npm run restore -- --latest               # restore the most-recent local backup
 *   npm run restore -- --s3 <key>             # download from S3 and restore
 *
 * Safety checks performed on every run (dry-run or live):
 *   1. DB connectivity verified before any write
 *   2. Backup file validated (header + size sanity)
 *   3. Migration table verified post-restore
 *   4. Live restore requires explicit --confirm flag (prevents accidental wipes)
 *
 * Environment variables:
 *   DATABASE_URL     — preferred (Render/Neon/Supabase)
 *   DB_HOST/PORT/NAME/USER/PASSWORD — alternate individual vars
 *   BACKUP_S3_BUCKET — for --s3 downloads
 *   BACKUP_S3_REGION — default: ap-south-1
 */

import { spawnSync } from 'child_process';
import fs            from 'fs';
import path          from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(__dirname, '../backups');

// ── Load .env (dev only) ──────────────────────────────────────────────────────
const dotenvPath = path.join(__dirname, '../.env');
if (fs.existsSync(dotenvPath)) {
  const vars = fs.readFileSync(dotenvPath, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && l.includes('='));
  for (const line of vars) {
    const [k, ...rest] = line.split('=');
    if (!process.env[k.trim()]) {
      process.env[k.trim()] = rest.join('=').trim();
    }
  }
}

// ── DB config ─────────────────────────────────────────────────────────────────
function dbFromUrl(url) {
  const u = new URL(url);
  return {
    host:     u.hostname,
    port:     u.port     || '5432',
    name:     u.pathname.slice(1),
    user:     u.username,
    password: u.password,
  };
}

const DB = process.env.DATABASE_URL
  ? dbFromUrl(process.env.DATABASE_URL)
  : {
      host:     process.env.DB_HOST     || 'localhost',
      port:     process.env.DB_PORT     || '5432',
      name:     process.env.DB_NAME     || 'Pulse',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
    };

const pgEnv = { ...process.env, PGPASSWORD: DB.password };

// ── Helpers ───────────────────────────────────────────────────────────────────
function psql(args, opts = {}) {
  return spawnSync('psql', [
    '-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', DB.name,
    ...args,
  ], { env: pgEnv, encoding: 'utf8', ...opts });
}

function checkTools() {
  for (const tool of ['psql', 'pg_restore']) {
    const r = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (r.error) {
      console.error(`❌  ${tool} not found in PATH. Install PostgreSQL client tools.`);
      process.exit(1);
    }
  }
}

function latestLocalBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return null;
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sql') || f.endsWith('.dump'))
    .sort()
    .reverse();
  return files.length ? path.join(BACKUP_DIR, files[0]) : null;
}

// ── Step 1: Verify DB connectivity ────────────────────────────────────────────
function verifyConnection(dryRun) {
  console.log('\n[1/4] Verifying database connectivity...');
  const r = psql(['-c', 'SELECT current_database(), NOW()::text', '-t', '--no-psqlrc']);
  if (r.status !== 0 || r.error) {
    console.error('❌  Cannot connect to database:');
    console.error('   ', r.stderr || r.error?.message);
    console.error('\n   Check DB_HOST / DATABASE_URL and that the database is reachable.');
    process.exit(1);
  }
  const row = r.stdout.trim();
  console.log(`✅  Connected — ${row}`);
  if (dryRun) console.log('    (DRY-RUN: no changes will be made)');
}

// ── Step 2: Validate backup file ──────────────────────────────────────────────
function validateBackup(file) {
  console.log(`\n[2/4] Validating backup: ${path.basename(file)} ...`);

  if (!fs.existsSync(file)) {
    console.error(`❌  File not found: ${file}`);
    process.exit(1);
  }

  const stat = fs.statSync(file);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

  if (stat.size < 1024) {
    console.error(`❌  Backup file is suspiciously small (${stat.size} bytes) — aborting.`);
    process.exit(1);
  }

  const sample = fs.readFileSync(file, 'utf8').slice(0, 4096);
  const hasHeader = sample.includes('PostgreSQL database dump');
  const hasSchema = sample.includes('CREATE TABLE') || sample.includes('ALTER TABLE') || sample.includes('SET ');

  console.log(`    Size   : ${sizeMB} MB`);
  console.log(`    Header : ${hasHeader ? '✅ valid pg_dump header' : '❌ MISSING — not a pg_dump file'}`);
  console.log(`    Schema : ${hasSchema ? '✅ DDL statements present' : '⚠️  no DDL detected (may be data-only)'}`);

  if (!hasHeader) {
    console.error('\n❌  This does not appear to be a valid pg_dump backup file.');
    process.exit(1);
  }

  console.log('✅  Backup file is valid');
  return { sizeMB };
}

// ── Step 3: Restore ───────────────────────────────────────────────────────────
function runRestore(file, dryRun) {
  console.log(`\n[3/4] ${dryRun ? '[DRY-RUN] Skipping' : 'Running'} restore...`);

  if (dryRun) {
    console.log('    Would execute: psql ... -f', path.basename(file));
    console.log('✅  Dry-run complete — no data written');
    return;
  }

  console.log(`    Restoring ${path.basename(file)} → ${DB.name} @ ${DB.host}...`);
  console.log('    This may take several minutes for large databases.\n');

  const r = psql(['-f', file, '-q', '--no-psqlrc']);

  if (r.status !== 0 || r.error) {
    console.error('❌  Restore failed:');
    console.error(r.stderr || r.error?.message);
    process.exit(1);
  }

  console.log('✅  Restore complete');
}

// ── Step 4: Verify migration integrity ───────────────────────────────────────
function verifyMigrations(dryRun) {
  console.log('\n[4/4] Verifying migration integrity...');

  if (dryRun) {
    console.log('    (DRY-RUN: skipping post-restore migration check)');
    return;
  }

  // Check schema_migrations table exists
  const tableCheck = psql([
    '-c',
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'schema_migrations'",
    '-t', '--no-psqlrc',
  ]);
  const count = parseInt((tableCheck.stdout || '').trim());

  if (count === 0) {
    console.warn('⚠️   schema_migrations table not found — migrations may not have run yet.');
    console.warn('    Run: npm run migrate');
    return;
  }

  // Count applied migrations
  const countCheck = psql(['-c', 'SELECT COUNT(*) FROM schema_migrations', '-t', '--no-psqlrc']);
  const applied = parseInt((countCheck.stdout || '').trim());

  // Count migration files on disk
  const migrationsDir = path.join(__dirname, '../src/database/migrations');
  const filesOnDisk = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter(f => f.endsWith('.js')).length
    : 0;

  console.log(`    Applied migrations : ${applied}`);
  console.log(`    Files on disk      : ${filesOnDisk}`);

  if (filesOnDisk > applied) {
    console.warn(`⚠️   ${filesOnDisk - applied} migration(s) pending. Run: npm run migrate`);
  } else {
    console.log('✅  Migration state is consistent');
  }
}

// ── S3 download ───────────────────────────────────────────────────────────────
async function downloadFromS3(key) {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const region = process.env.BACKUP_S3_REGION || 'ap-south-1';

  if (!bucket) {
    console.error('❌  BACKUP_S3_BUCKET env var is required for --s3 downloads.');
    process.exit(1);
  }

  console.log(`\n☁️  Downloading s3://${bucket}/${key} ...`);

  let S3Client, GetObjectCommand;
  try {
    ({ S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3'));
  } catch {
    console.error('❌  @aws-sdk/client-s3 is not installed. Run: npm install @aws-sdk/client-s3');
    process.exit(1);
  }

  const client = new S3Client({ region });
  const resp   = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, path.basename(key));
  const ws   = fs.createWriteStream(dest);

  await new Promise((resolve, reject) => {
    resp.Body.pipe(ws).on('finish', resolve).on('error', reject);
  });

  console.log(`✅  Downloaded → ${dest}`);
  return dest;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const dryRun  = args.includes('--dry-run');
const confirm = args.includes('--confirm');
const latest  = args.includes('--latest');

let targetFile = null;

if (args.includes('--file')) {
  const idx = args.indexOf('--file');
  targetFile = args[idx + 1];
  if (!targetFile) {
    console.error('❌  --file requires a path argument');
    process.exit(1);
  }
} else if (args.includes('--s3')) {
  const idx = args.indexOf('--s3');
  const key = args[idx + 1];
  if (!key) {
    console.error('❌  --s3 requires an S3 key argument (e.g. pulse-backups/pulse-2026-05-29.sql)');
    process.exit(1);
  }
  targetFile = await downloadFromS3(key);
} else if (latest) {
  targetFile = latestLocalBackup();
  if (!targetFile) {
    console.error(`❌  No backup files found in ${BACKUP_DIR}`);
    console.error('    Run: npm run backup  or  npm run restore -- --s3 <key>');
    process.exit(1);
  }
  console.log(`Using latest backup: ${path.basename(targetFile)}`);
} else if (!dryRun) {
  console.error('Usage:');
  console.error('  npm run restore -- --dry-run');
  console.error('  npm run restore -- --latest --confirm');
  console.error('  npm run restore -- --file <path> --confirm');
  console.error('  npm run restore -- --s3 <key> --confirm');
  process.exit(1);
}

// Safety gate: live restore requires --confirm
if (!dryRun && !confirm) {
  console.error('\n⚠️  LIVE RESTORE — this will overwrite the target database.');
  console.error('   Re-run with --confirm to proceed:');
  console.error(`   npm run restore -- ${args.filter(a => a !== '--confirm').join(' ')} --confirm\n`);
  process.exit(1);
}

console.log('\n══════════════════════════════════════════════════════');
console.log(`  Pulse ERP Database Restore${dryRun ? ' (DRY-RUN)' : ''}`);
console.log('══════════════════════════════════════════════════════');

checkTools();
verifyConnection(dryRun);
if (targetFile) validateBackup(targetFile);
runRestore(targetFile, dryRun);
verifyMigrations(dryRun);

console.log('\n══════════════════════════════════════════════════════');
console.log(dryRun
  ? '  DRY-RUN PASSED — no changes were made'
  : '  RESTORE COMPLETE — verify the application before routing traffic');
console.log('══════════════════════════════════════════════════════\n');
