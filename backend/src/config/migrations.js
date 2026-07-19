import fs            from 'fs';
import path          from 'path';
import crypto        from 'crypto';
import { fileURLToPath } from 'url';
import pool          from './db.js';

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '../database/migrations');

// ── Utilities ─────────────────────────────────────────────────────────────────

// Hash the file's CONTENT, not its bytes: line endings are a checkout artifact,
// not a change to the migration. Git hands the same committed file to a Windows
// dev as CRLF and to CI as LF, which made 181/244 migrations report a false
// "modified after it was applied" — noise that buried the handful of real ones.
// Normalizing to LF is backward compatible: a file already stored as LF hashes
// identically, so existing checksums keep matching.
function fileChecksum(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function makeKnexShim(client) {
  return {
    raw:   (sql, bindings) => client.query(sql, bindings || []),
    query: (sql, bindings) => client.query(sql, bindings || []),
  };
}

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort();
}

// ── Tracking table ────────────────────────────────────────────────────────────
// Adds `checksum` and `applied_by` columns if they don't exist yet (idempotent).

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      name        TEXT        NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_ms INT,
      checksum    TEXT,
      applied_by  TEXT
    )
  `);

  // Non-destructive column additions for existing installs
  await client.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS checksum   TEXT,
      ADD COLUMN IF NOT EXISTS applied_by TEXT
  `);
}

function appliedBy() {
  return `${process.env.HOSTNAME || 'unknown'}/${process.env.USER || process.env.USERNAME || 'unknown'}`;
}

// ── Tamper detection ──────────────────────────────────────────────────────────

async function detectTamperedMigrations(client) {
  const { rows } = await client.query(
    'SELECT name, checksum FROM schema_migrations WHERE checksum IS NOT NULL'
  );

  const warnings = [];
  for (const { name, checksum } of rows) {
    const filePath = path.join(MIGRATIONS_DIR, name);
    if (!fs.existsSync(filePath)) {
      warnings.push(`  ⚠️  Applied migration file missing from disk: ${name}`);
      continue;
    }
    const current = fileChecksum(filePath);
    if (current !== checksum) {
      warnings.push(`  ❌  Checksum mismatch — ${name} was modified after it was applied`);
      warnings.push(`       stored : ${checksum}`);
      warnings.push(`       current: ${current}`);
    }
  }
  return warnings;
}

// ── Public: migration status report ──────────────────────────────────────────

export async function migrationStatus() {
  const client = await pool.connect();
  try {
    await ensureTrackingTable(client);

    const { rows: applied } = await client.query(
      'SELECT name, applied_at, duration_ms, checksum FROM schema_migrations ORDER BY name'
    );
    const appliedMap = new Map(applied.map(r => [r.name, r]));

    const files = migrationFiles();
    const tamperWarnings = await detectTamperedMigrations(client);

    console.log('\n── Migration Status ─────────────────────────────────────────');
    console.log(`   Migrations dir : ${MIGRATIONS_DIR}`);
    console.log(`   Files on disk  : ${files.length}`);
    console.log(`   Applied        : ${applied.length}`);
    console.log(`   Pending        : ${files.length - applied.length}`);
    console.log('');

    for (const file of files) {
      const row = appliedMap.get(file);
      if (row) {
        const ts = new Date(row.applied_at).toISOString().replace('T', ' ').slice(0, 19);
        const cs = row.checksum ? row.checksum.slice(0, 10) + '…' : 'no checksum';
        console.log(`  ✅  [applied]  ${file}  (${ts}, ${row.duration_ms}ms, sha256:${cs})`);
      } else {
        const cs = fs.existsSync(path.join(MIGRATIONS_DIR, file))
          ? fileChecksum(path.join(MIGRATIONS_DIR, file)).slice(0, 10) + '…'
          : 'file missing';
        console.log(`  🕐  [pending]  ${file}  (sha256:${cs})`);
      }
    }

    // Files in DB but not on disk
    for (const row of applied) {
      if (!files.includes(row.name)) {
        console.log(`  ⚠️   [missing]  ${row.name}  — applied but file not on disk`);
      }
    }

    if (tamperWarnings.length) {
      console.log('\n── Integrity Warnings ───────────────────────────────────────');
      tamperWarnings.forEach(w => console.log(w));
    }
    console.log('─────────────────────────────────────────────────────────────\n');

    return { applied: applied.length, pending: files.length - applied.length, tamperWarnings };
  } finally {
    client.release();
  }
}

// ── Public: verify all migrations applied (post-deploy) ──────────────────────

export async function verifyApplied() {
  const client = await pool.connect();
  try {
    await ensureTrackingTable(client);

    const { rows: applied } = await client.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name'
    );
    const appliedNames = new Set(applied.map(r => r.name));

    const files = migrationFiles();
    const missing  = files.filter(f => !appliedNames.has(f));
    const tamperWarnings = await detectTamperedMigrations(client);

    const ok = missing.length === 0 && tamperWarnings.length === 0;

    return {
      ok,
      total:    files.length,
      applied:  applied.length,
      missing,
      tamperWarnings,
    };
  } finally {
    client.release();
  }
}

// ── Public: run all pending migrations ───────────────────────────────────────

export async function runMigrations() {
  console.log('🔄 Running database migrations...');
  const client = await pool.connect();

  try {
    await ensureTrackingTable(client);

    // Tamper check before running anything
    const warnings = await detectTamperedMigrations(client);
    if (warnings.length) {
      console.warn('\n⚠️  Migration integrity warnings:');
      warnings.forEach(w => console.warn(w));
      console.warn('');
    }

    const { rows: applied } = await client.query(
      'SELECT name FROM schema_migrations ORDER BY name'
    );
    const appliedSet = new Set(applied.map(r => r.name));

    const files = migrationFiles();
    let ran = 0;

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const filePath = path.join(MIGRATIONS_DIR, file);
      const checksum = fileChecksum(filePath);
      const { up } = await import(`file://${filePath}`);

      if (typeof up !== 'function') {
        console.warn(`⚠️  Migration ${file} has no up() export — skipping`);
        continue;
      }

      console.log(`  ↑ applying ${file}...`);
      const t0 = Date.now();

      await client.query('BEGIN');
      try {
        await up(makeKnexShim(client));
        const ms = Date.now() - t0;
        await client.query(
          `INSERT INTO schema_migrations (name, duration_ms, checksum, applied_by)
           VALUES ($1, $2, $3, $4)`,
          [file, ms, checksum, appliedBy()]
        );
        await client.query('COMMIT');
        console.log(`  ✅ ${file} (${ms}ms)`);
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  ❌ ${file} failed — rolled back. Error: ${err.message}`);
        throw err;
      }
    }

    if (ran === 0) {
      console.log('✅ Database schema is up to date');
    } else {
      console.log(`✅ Applied ${ran} migration${ran > 1 ? 's' : ''}`);
    }

    return { ran };
  } finally {
    client.release();
  }
}

// ── Public: repair checksums for intentionally-modified migration files ───────
// Use after a backward-compatible edit to a migration file (e.g. adding
// IF NOT EXISTS, fixing a column type that was already safe). Do NOT use to
// silence warnings about destructive schema changes — investigate those first.

export async function repairChecksums() {
  const client = await pool.connect();
  try {
    await ensureTrackingTable(client);

    const { rows } = await client.query(
      'SELECT name, checksum FROM schema_migrations WHERE checksum IS NOT NULL'
    );

    let repaired = 0;
    for (const { name, checksum: stored } of rows) {
      const filePath = path.join(MIGRATIONS_DIR, name);
      if (!fs.existsSync(filePath)) {
        console.warn(`  ⚠️  File not found on disk — skipping: ${name}`);
        continue;
      }
      const current = fileChecksum(filePath);
      if (current === stored) continue;

      console.log(`  🔧 Repairing checksum for ${name}`);
      console.log(`       was    : ${stored}`);
      console.log(`       now    : ${current}`);
      await client.query(
        'UPDATE schema_migrations SET checksum = $1 WHERE name = $2',
        [current, name]
      );
      repaired++;
    }

    if (repaired === 0) {
      console.log('✅ All migration checksums are already correct — nothing to repair.');
    } else {
      console.log(`\n✅ Repaired ${repaired} checksum${repaired > 1 ? 's' : ''}.`);
      console.log('   Run "npm run migrate:status" to verify.');
    }
  } finally {
    client.release();
  }
}

// ── Public: rollback the last applied migration ───────────────────────────────

export async function rollbackLast() {
  const client = await pool.connect();
  try {
    await ensureTrackingTable(client);
    const { rows } = await client.query(
      'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1'
    );
    if (!rows.length) {
      console.log('Nothing to roll back.');
      return;
    }

    const { name } = rows[0];
    const filePath  = path.join(MIGRATIONS_DIR, name);
    const { down }  = await import(`file://${filePath}`);

    if (typeof down !== 'function') {
      throw new Error(`Migration ${name} has no down() function — cannot roll back`);
    }

    console.log(`  ↓ rolling back ${name}...`);
    await client.query('BEGIN');
    try {
      await down(makeKnexShim(client));
      await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
      console.log(`  ✅ Rolled back ${name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ❌ Rollback of ${name} failed. Error: ${err.message}`);
      throw err;
    }
  } finally {
    client.release();
  }
}
