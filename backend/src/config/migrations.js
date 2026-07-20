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

// ── Fresh-database bootstrap ──────────────────────────────────────────────────
// The migration chain cannot build a schema from zero: the earliest files
// ALTER tables that only ever existed in the original dev database. On a
// truly fresh database we therefore execute src/database/baseline.sql (a
// pg_dump snapshot, regenerated via `npm run generate-baseline`) and mark the
// migrations it embodies (baseline-manifest.json) as applied; anything newer
// then applies normally. A database with ANY ledger rows or ANY user tables
// is never touched by this path.

const BASELINE_SQL_PATH      = path.join(__dirname, '../database/baseline.sql');
const BASELINE_DATA_PATH     = path.join(__dirname, '../database/baseline-data.sql');
const BASELINE_MANIFEST_PATH = path.join(__dirname, '../database/baseline-manifest.json');

// The load-bearing tables server.js's own assertRequiredTables() already
// treats as "the app cannot run without these" (kept in sync manually — both
// are small, stable lists; importing from server.js would be circular).
const CORE_TABLES = ['users', 'employees', 'approvals', 'notifications', 'workflow_instances', 'audit_logs'];

async function isFreshDatabase(client) {
  const { rows: [{ n: ledgerRows }] } = await client.query(
    'SELECT COUNT(*)::int AS n FROM schema_migrations'
  );
  // NOT "zero tables of any kind" — 18 route modules across this codebase
  // run their own top-level `(async () => { CREATE TABLE IF NOT EXISTS ... })()`
  // at import time, independent of this migration system and racing ahead of
  // it. On an existing DB those are harmless no-ops; on a genuinely empty one
  // they win the race and create a real but incidental handful of tables
  // before this function ever runs (run #10 measured 17). Checking for zero
  // tables treated a fresh DB with those 17 stray tables as "not fresh" and
  // fell through to the migration chain, which cannot build from zero — the
  // exact bug this bootstrap exists to fix. Checking for absence of the
  // small set of foundational tables those 18 modules never create is the
  // reliable signal instead.
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [CORE_TABLES]
  );
  const foundCore = rows.map(r => r.table_name);
  const fresh = ledgerRows === 0 && foundCore.length === 0;
  console.log(`  🔍 isFreshDatabase: ledgerRows=${ledgerRows}, core tables present=[${foundCore.join(', ')}] → ${fresh}`);
  return fresh;
}

async function bootstrapFromBaseline(client) {
  const sqlExists      = fs.existsSync(BASELINE_SQL_PATH);
  const manifestExists = fs.existsSync(BASELINE_MANIFEST_PATH);
  if (!sqlExists || !manifestExists) {
    // Failing fast here, loudly, beats the alternative: falling through to
    // the migration chain, which is KNOWN to fail from zero (that is the
    // reason this bootstrap exists at all) — and does so with a cryptic
    // 42P01 many seconds later that gives no hint the baseline was even
    // supposed to run. Both files are git-tracked and neither .dockerignore
    // excludes them, so if this fires in a container the COPY step, build
    // context, or checkout is missing them — that is itself the bug to fix.
    const databaseDir = path.dirname(BASELINE_SQL_PATH);
    let dirListing;
    try {
      dirListing = fs.existsSync(databaseDir)
        ? fs.readdirSync(databaseDir).join(', ')
        : '(directory does not exist)';
    } catch (e) {
      dirListing = `(readdir failed: ${e.message})`;
    }
    throw new Error(
      'Fresh database detected but baseline artifacts are missing — refusing ' +
      'to fall through to the migration chain (known broken from zero).\n' +
      `  ${BASELINE_SQL_PATH} exists: ${sqlExists}\n` +
      `  ${BASELINE_MANIFEST_PATH} exists: ${manifestExists}\n` +
      `  __dirname: ${__dirname}\n` +
      `  contents of ${databaseDir}: ${dirListing}\n` +
      '  Run `npm run generate-baseline` against an up-to-date DB and commit both files, ' +
      'or check whether this build/checkout is missing src/database/*.sql.'
    );
  }

  const manifest = JSON.parse(fs.readFileSync(BASELINE_MANIFEST_PATH, 'utf8'));
  // Defense in depth, mirroring generate-baseline.js: psql meta-commands are
  // not SQL, and SET params from a newer pg_dump (e.g. transaction_timeout,
  // PG17+) abort the whole bootstrap on an older server. Harmless to strip —
  // they are session tuning, not schema.
  const UNSAFE_LINE = /^(\\|SET\s+transaction_timeout)/;
  const readSql = p => fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => !UNSAFE_LINE.test(l)).join('\n');
  const sql = readSql(BASELINE_SQL_PATH);

  console.log(`  ⛰  Fresh database — applying baseline snapshot (${manifest.generated_at}, ${manifest.migrations.length} migrations embodied)`);
  const t0 = Date.now();

  await client.query('BEGIN');
  try {
    // 18 route modules run their own top-level CREATE TABLE IF NOT EXISTS
    // IIFEs at import time, independent of this migration system — they fire
    // as soon as server.js's imports resolve, well before this async
    // function is ever reached. On an existing DB those are harmless no-ops;
    // on a genuinely empty one they can win the race and leave a handful of
    // real tables behind (measured 17 in run #10) before this executes.
    // Plain pg_dump output has no IF NOT EXISTS, and some of what it recreates
    // — named PRIMARY KEY/FOREIGN KEY constraints via ALTER TABLE ADD
    // CONSTRAINT — has no idempotent form in Postgres at all, so colliding
    // with any of it aborts this whole transaction. Since isFreshDatabase()
    // already confirmed the core tables are absent, anything sitting in
    // 'public' at this exact point is unambiguously that incidental IIFE
    // debris — nothing could have written real data to it in the seconds
    // since boot started — so it's safe to clear before applying the
    // canonical snapshot. CASCADE also takes each table's owned sequence
    // and indexes with it, so this covers every collision type, not just
    // the ones this comment happened to think of.
    const { rows: strayTables } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`
    );
    if (strayTables.length) {
      console.log(`  🧹 dropping ${strayTables.length} pre-existing table(s) from racing bootstrap IIFEs: ${strayTables.map(r => r.table_name).join(', ')}`);
      for (const { table_name } of strayTables) {
        await client.query(`DROP TABLE IF EXISTS "${table_name}" CASCADE`);
      }
    }
    await client.query(sql);
    // Config rows seeded by data migrations (roles, permission matrix, …) —
    // the schema-only snapshot marks those migrations applied, so their data
    // must ride along or a fresh install fails closed on an empty matrix.
    if (fs.existsSync(BASELINE_DATA_PATH)) {
      const dataSql = fs.readFileSync(BASELINE_DATA_PATH, 'utf8')
        .split('\n').filter(l => !l.startsWith('\\')).join('\n');
      await client.query(dataSql);
    }
    // pg_dump output may clear search_path for the session; the ledger INSERTs
    // below (and every later query on this pooled client) need it back.
    await client.query('SET search_path TO public');
    for (const name of manifest.migrations) {
      const filePath = path.join(MIGRATIONS_DIR, name);
      const checksum = fs.existsSync(filePath) ? fileChecksum(filePath) : null;
      await client.query(
        `INSERT INTO schema_migrations (name, duration_ms, checksum, applied_by)
         VALUES ($1, 0, $2, $3)`,
        [name, checksum, 'baseline-bootstrap']
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`  ❌ baseline bootstrap failed — rolled back. Error: ${err.message}`);
    throw err;
  }

  console.log(`  ✅ baseline applied (${Date.now() - t0}ms)`);
  return true;
}

// ── Public: run all pending migrations ───────────────────────────────────────

export async function runMigrations() {
  console.log('🔄 Running database migrations...');
  const client = await pool.connect();

  try {
    await ensureTrackingTable(client);

    if (await isFreshDatabase(client)) {
      await bootstrapFromBaseline(client);
    }

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
