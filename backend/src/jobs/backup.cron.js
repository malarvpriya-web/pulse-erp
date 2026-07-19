/**
 * backup.cron.js — Automated daily database backup
 *
 * Schedule: 02:00 IST daily (20:30 UTC previous day — expressed as 20:30 UTC)
 * Override: BACKUP_CRON_SCHEDULE env var (cron syntax, UTC)
 *
 * On each run:
 *   1. pg_dump → local backups/ directory (plain SQL)
 *   2. Prune old backups (keep BACKUP_RETAIN_DAYS, default 7)
 *   3. Upload to S3 if BACKUP_S3_BUCKET is set
 *   4. Alert via ALERT_WEBHOOK_URL on failure
 *
 * Requires pg_dump in PATH. Skips silently in test environment.
 */

import cron         from 'node-cron';
import { spawnSync } from 'child_process';
import fs            from 'fs';
import path          from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.join(__dirname, '../../../backups');
const LOGS_DIR   = path.join(__dirname, '../../../logs');
const BACKUP_LOG = path.join(LOGS_DIR, 'backup.log');

// In production, stdout is captured by the platform (Render/Railway).
// File-based logging is only enabled in development.
const LOG_TO_FILE = process.env.NODE_ENV !== 'production';

const RETAIN_DAYS    = parseInt(process.env.BACKUP_RETAIN_DAYS || '7', 10);
// Default: 02:00 IST = 20:30 UTC
const CRON_SCHEDULE  = process.env.BACKUP_CRON_SCHEDULE || '30 20 * * *';

const DB = () => ({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || '5432',
  name:     process.env.DB_NAME     || 'Pulse',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeLog(entry) {
  if (LOG_TO_FILE) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFile(BACKUP_LOG, JSON.stringify(entry) + '\n', () => {});
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function backupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .reverse();
}

async function sendAlert(text) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    });
  } catch { /* never crash on webhook failure */ }
}

// ── S3 Upload (lazy-loaded — only when BACKUP_S3_BUCKET is set) ───────────────

async function uploadToS3(filePath) {
  const bucket = process.env.BACKUP_S3_BUCKET;
  const region = process.env.BACKUP_S3_REGION || 'ap-south-1';
  if (!bucket) return null;

  try {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = new S3Client({ region });
    const key    = `pulse-backups/${path.basename(filePath)}`;
    const body   = fs.createReadStream(filePath);

    await client.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        body,
      ContentType: 'application/sql',
      StorageClass: process.env.BACKUP_S3_STORAGE_CLASS || 'STANDARD_IA',
    }));

    console.log(`[backup] S3 upload complete: s3://${bucket}/${key}`);
    return `s3://${bucket}/${key}`;
  } catch (err) {
    console.error('[backup] S3 upload failed:', err.message);
    return null;
  }
}

// ── Core backup ───────────────────────────────────────────────────────────────

async function runBackup() {
  const ts  = new Date().toISOString();
  const db  = DB();
  const env = { ...process.env, PGPASSWORD: db.password };

  // Guard: pg_dump must be available
  const check = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (check.error) {
    const msg = 'pg_dump not found in PATH — backup skipped';
    console.error(`[backup] ${msg}`);
    writeLog({ ts, status: 'error', error: msg });
    await sendAlert(`❌ *Pulse ERP — BACKUP FAILED*\n${msg}\nTime: ${ts}`);
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `pulse-${timestamp()}.sql`);

  console.log(`[backup] starting daily backup → ${path.basename(file)}`);

  const result = spawnSync('pg_dump', [
    '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.name,
    '--format=plain', '--no-owner', '--no-acl', '-f', file,
  ], { env, encoding: 'utf8', timeout: 10 * 60 * 1000 });

  if (result.status !== 0 || result.error) {
    const err = result.stderr || result.error?.message || 'unknown error';
    console.error(`[backup] pg_dump failed: ${err}`);
    writeLog({ ts, status: 'error', file: path.basename(file), error: err });
    await sendAlert(`❌ *Pulse ERP — BACKUP FAILED*\npg_dump error: ${err}\nTime: ${ts}`);
    return;
  }

  const stat   = fs.statSync(file);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(2);

  // Sanity check — file must have a valid PostgreSQL dump header
  const sample = fs.readFileSync(file, 'utf8').slice(0, 2048);
  if (!sample.includes('PostgreSQL database dump')) {
    const msg = 'Backup file does not contain a valid PostgreSQL header';
    console.error(`[backup] ${msg}`);
    writeLog({ ts, status: 'error', file: path.basename(file), error: msg });
    await sendAlert(`❌ *Pulse ERP — BACKUP INVALID*\n${msg}\nFile: ${path.basename(file)}\nTime: ${ts}`);
    return;
  }

  // Prune old backups
  const all      = backupFiles();
  const toPrune  = all.slice(RETAIN_DAYS);
  for (const f of toPrune) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* ignore race */ }
  }

  // Upload to S3
  const s3Path = await uploadToS3(file);

  const entry = {
    ts,
    status:    'ok',
    file:      path.basename(file),
    size_mb:   parseFloat(sizeMB),
    pruned:    toPrune.length,
    retained:  Math.min(all.length, RETAIN_DAYS),
    s3_path:   s3Path ?? 'not configured',
  };
  writeLog(entry);
  console.log(`[backup] ok — ${sizeMB}MB | pruned ${toPrune.length} | s3: ${s3Path ?? 'disabled'}`);

  if (s3Path === null && process.env.BACKUP_S3_BUCKET) {
    // S3 was configured but upload failed — send alert
    await sendAlert(
      `⚠️ *Pulse ERP — BACKUP S3 UPLOAD FAILED*\n` +
      `Local backup OK (${sizeMB}MB) but S3 upload failed.\n` +
      `Check BACKUP_S3_BUCKET, BACKUP_S3_REGION, and AWS credentials.\n` +
      `Time: ${ts}`
    );
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export function startBackupCron() {
  if (process.env.NODE_ENV === 'test') return;

  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`[backup] Invalid BACKUP_CRON_SCHEDULE: "${CRON_SCHEDULE}" — cron not started`);
    return;
  }

  cron.schedule(CRON_SCHEDULE, runBackup, { timezone: 'UTC' });
  console.log(`💾 Backup cron started — schedule: "${CRON_SCHEDULE}" UTC (default: 02:00 IST daily)`);
}
