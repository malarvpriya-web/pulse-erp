#!/usr/bin/env node
/**
 * db-backup.js — Pulse ERP database backup + restore drill
 *
 * Usage:
 *   node scripts/db-backup.js              # create a backup
 *   node scripts/db-backup.js --drill      # backup + verify it can be read back
 *   node scripts/db-backup.js --list       # list existing backups
 *   node scripts/db-backup.js --prune N    # keep only the N most-recent backups
 *   node scripts/db-backup.js --upload     # backup + upload to S3 (requires BACKUP_S3_BUCKET)
 *   node scripts/db-backup.js --drill --upload  # drill + upload
 *
 * Requires: pg_dump / pg_restore in PATH (shipped with PostgreSQL client tools)
 * S3 upload: set BACKUP_S3_BUCKET, BACKUP_S3_REGION (default: ap-south-1),
 *            and AWS credentials via env vars or IAM role.
 */

import { spawnSync, execFileSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(__dirname, '../backups');
const KEEP_COUNT = 7; // default retention

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

const DB = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || '5432',
  name:     process.env.DB_NAME     || 'Pulse',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
};

const env = { ...process.env, PGPASSWORD: DB.password };

// ── Helpers ───────────────────────────────────────────────────────────────────
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function backupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sql') || f.endsWith('.dump'))
    .sort()
    .reverse(); // newest first
}

function checkPgDump() {
  const r = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (r.error) {
    console.error('❌  pg_dump not found in PATH. Install PostgreSQL client tools.');
    console.error('    Windows: https://www.postgresql.org/download/windows/');
    console.error('    Mac:     brew install postgresql');
    console.error('    Linux:   apt install postgresql-client');
    process.exit(1);
  }
  return r.stdout.trim();
}

// ── Commands ──────────────────────────────────────────────────────────────────
function listBackups() {
  const files = backupFiles();
  if (!files.length) {
    console.log('No backups found in', BACKUP_DIR);
    return;
  }
  console.log(`\nBackups in ${BACKUP_DIR}:\n`);
  for (const f of files) {
    const stat = fs.statSync(path.join(BACKUP_DIR, f));
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`  ${f}  (${sizeMB} MB)`);
  }
  console.log();
}

function createBackup() {
  checkPgDump();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const ts   = timestamp();
  const file = path.join(BACKUP_DIR, `pulse-${ts}.sql`);

  console.log(`\n📦 Backing up "${DB.name}" → ${path.basename(file)} ...`);

  const result = spawnSync('pg_dump', [
    '-h', DB.host,
    '-p', DB.port,
    '-U', DB.user,
    '-d', DB.name,
    '--format=plain',
    '--no-owner',
    '--no-acl',
    '-f', file,
  ], { env, encoding: 'utf8' });

  if (result.status !== 0) {
    console.error('❌  pg_dump failed:\n', result.stderr);
    process.exit(1);
  }

  const stat   = fs.statSync(file);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
  console.log(`✅  Backup complete: ${path.basename(file)} (${sizeMB} MB)\n`);
  return file;
}

function drillVerify(file) {
  console.log('🔍 Restore drill — verifying backup integrity...\n');

  // 1. File exists and is not empty
  const stat = fs.statSync(file);
  if (stat.size < 100) {
    console.error('❌  Backup file is suspiciously small:', stat.size, 'bytes');
    process.exit(1);
  }
  console.log('  ✅  File present:', (stat.size / 1024 / 1024).toFixed(2), 'MB');

  // 2. Contains expected SQL markers
  const sample = fs.readFileSync(file, 'utf8').slice(0, 4096);
  const hasHeader   = sample.includes('PostgreSQL database dump');
  const hasInsertOrCopy = sample.includes('INSERT INTO') || sample.includes('COPY ');
  const hasCreate   = sample.includes('CREATE TABLE') || sample.includes('ALTER TABLE');
  console.log('  ' + (hasHeader ? '✅' : '❌') + '  PostgreSQL dump header present');
  console.log('  ' + (hasCreate ? '✅' : '⚠️ ') + '  Schema DDL (CREATE/ALTER) found');
  console.log('  ' + (hasInsertOrCopy ? '✅' : '⚠️ ') + '  Data statements (INSERT/COPY) found');

  if (!hasHeader) {
    console.error('\n❌  Backup does not appear to be a valid pg_dump file.');
    process.exit(1);
  }

  // 3. Restore to a test database to fully validate (optional — only if TEST_DB_NAME is set)
  const testDb = process.env.TEST_DB_NAME;
  if (testDb) {
    // The restore target is DROPPED and recreated so the drill is repeatable —
    // with ON_ERROR_STOP a second run into the same database fails on objects
    // that already exist, which looks like a corrupt backup and is not.
    //
    // Because this drops a database, the name must look disposable. Without
    // this guard a typo in TEST_DB_NAME — or copying a production .env — would
    // destroy live data while running what reads like a safety check.
    if (!/(test|drill|scratch|tmp)/i.test(testDb)) {
      console.error(`  ❌  Refusing to use "${testDb}" as a restore target.`);
      console.error(`      The drill DROPS this database. Its name must contain`);
      console.error(`      "test", "drill", "scratch" or "tmp" to confirm it is disposable.`);
      process.exit(1);
    }
    if (testDb === DB.name) {
      console.error(`  ❌  TEST_DB_NAME is the LIVE database ("${DB.name}"). Refusing.`);
      process.exit(1);
    }

    console.log(`\n  🔄  Recreating "${testDb}" and restoring for full validation...`);
    spawnSync('dropdb',   ['-h', DB.host, '-p', DB.port, '-U', DB.user, '--if-exists', testDb], { env, encoding: 'utf8' });
    const mk = spawnSync('createdb', ['-h', DB.host, '-p', DB.port, '-U', DB.user, testDb], { env, encoding: 'utf8' });
    if (mk.status !== 0) {
      console.error('  ❌  Could not create the test database:\n', mk.stderr);
      process.exit(1);
    }
    // ON_ERROR_STOP is essential: without it psql reports success (exit 0) even
    // when every statement in the file failed, so the drill would certify a
    // backup that restores nothing. A drill that cannot fail is not a drill.
    const r = spawnSync('psql', [
      '-h', DB.host, '-p', DB.port, '-U', DB.user,
      '-d', testDb, '-f', file, '-q', '-v', 'ON_ERROR_STOP=1',
    ], { env, encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('  ❌  Test restore failed:\n', r.stderr);
      process.exit(1);
    }

    // Exit code alone still only proves the statements ran. Compare the actual
    // contents: table count, plus row counts for the largest tables in the
    // source. A restore that produces an empty schema passes every check above.
    const count = (db, sql) => {
      const out = spawnSync('psql', ['-h', DB.host, '-p', DB.port, '-U', DB.user, '-d', db, '-tAc', sql],
                            { env, encoding: 'utf8' });
      return out.status === 0 ? (out.stdout || '').trim() : null;
    };
    const TABLES_SQL = `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'`;
    const srcTables = count(DB.name, TABLES_SQL);
    const dstTables = count(testDb,  TABLES_SQL);
    if (srcTables !== dstTables) {
      console.error(`  ❌  Table count mismatch — source ${srcTables}, restored ${dstTables}`);
      process.exit(1);
    }

    const topSql = `SELECT relname FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 8`;
    const top = (count(DB.name, topSql) || '').split('\n').map(s => s.trim()).filter(Boolean);
    let mismatches = 0;
    for (const t of top) {
      const a = count(DB.name, `SELECT COUNT(*) FROM "${t}"`);
      const b = count(testDb,  `SELECT COUNT(*) FROM "${t}"`);
      if (a !== b) { console.error(`  ❌  ${t}: source ${a} rows, restored ${b}`); mismatches++; }
    }
    if (mismatches) {
      console.error(`  ❌  ${mismatches} table(s) restored with the wrong row count`);
      process.exit(1);
    }

    console.log(`  ✅  Full restore verified — ${srcTables} tables, row counts match on ${top.length} largest tables`);
  } else {
    console.log('\n  ℹ️   Set TEST_DB_NAME env var to enable full restore drill');
  }

  console.log('\n✅  Restore drill passed\n');
}

function pruneBackups(keepN) {
  const files = backupFiles();
  const toDelete = files.slice(keepN);
  if (!toDelete.length) {
    console.log(`Nothing to prune (${files.length} backup(s), keeping ${keepN})`);
    return;
  }
  for (const f of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log('  🗑  Deleted', f);
  }
  console.log(`✅  Pruned ${toDelete.length} old backup(s)`);
}

// ── S3 Upload ─────────────────────────────────────────────────────────────────
async function uploadToS3(file) {
  const bucket  = process.env.BACKUP_S3_BUCKET;
  const region  = process.env.BACKUP_S3_REGION || 'ap-south-1';
  const storage = process.env.BACKUP_S3_STORAGE_CLASS || 'STANDARD_IA';

  if (!bucket) {
    console.error('❌  BACKUP_S3_BUCKET env var is not set. Set it to your S3 bucket name.');
    process.exit(1);
  }

  console.log(`\n☁️  Uploading to s3://${bucket}/pulse-backups/${path.basename(file)} ...`);

  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3'));
  } catch {
    console.error('❌  @aws-sdk/client-s3 is not installed. Run: npm install @aws-sdk/client-s3');
    process.exit(1);
  }

  const client = new S3Client({ region });
  const key    = `pulse-backups/${path.basename(file)}`;

  try {
    await client.send(new PutObjectCommand({
      Bucket:       bucket,
      Key:          key,
      Body:         fs.createReadStream(file),
      ContentType:  'application/sql',
      StorageClass: storage,
    }));
    const stat   = fs.statSync(file);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
    console.log(`✅  S3 upload complete: s3://${bucket}/${key} (${sizeMB} MB)\n`);
  } catch (err) {
    console.error('❌  S3 upload failed:', err.message);
    if (err.name === 'NoCredentialsError' || err.name === 'CredentialsProviderError') {
      console.error('    Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or attach an IAM role.');
    }
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--list')) {
  listBackups();
} else if (args.includes('--prune')) {
  const idx  = args.indexOf('--prune');
  const keep = parseInt(args[idx + 1]) || KEEP_COUNT;
  pruneBackups(keep);
} else if (args.includes('--drill')) {
  const file = createBackup();
  drillVerify(file);
  pruneBackups(KEEP_COUNT);
  if (args.includes('--upload')) await uploadToS3(file);
} else if (args.includes('--upload')) {
  const file = createBackup();
  pruneBackups(KEEP_COUNT);
  await uploadToS3(file);
} else {
  const file = createBackup();
  pruneBackups(KEEP_COUNT);
  console.log('Run with --drill to verify the backup  |  --upload to push to S3.');
}
