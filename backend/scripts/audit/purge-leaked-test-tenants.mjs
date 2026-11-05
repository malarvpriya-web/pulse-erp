/**
 * purge-leaked-test-tenants.mjs — report (and, with --apply, remove) tenants
 * that integration runs created and never cleaned up.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * A suite that only cleans up in `afterAll` leaks its company the moment one
 * assertion throws. Because `companies.code` is UNIQUE, that leak then fails
 * EVERY LATER RUN at INSERT time — which reads as a flaky suite rather than a
 * stale row (see the 1589/1, 1572/1, 1551/2 moving failing-set chase). Leaked
 * tenants also inflate every company picker, every "empty table" probe and
 * every cross-tenant count in the app.
 *
 * `tenant-fixture.mjs --down` already sweeps correctly, but only for its own
 * ZZTENANT fixture. This reports the same sweep for every leaked fixture in the
 * database, whichever suite wrote it.
 *
 * ── HOW A TENANT IS JUDGED A LEAK ───────────────────────────────────────────
 * Only by a fixture marker its own suite stamped into the name or code: a
 * ZZ-prefixed token, or an IOT/TSP-style prefix followed by the epoch
 * milliseconds the run started. Real tenants carry neither. The script prints
 * the KEEP list as well as the PURGE list on every run, so the judgement is
 * visible and falsifiable before anything is removed — and company 1 is
 * excluded unconditionally, marker or no marker.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   node scripts/audit/purge-leaked-test-tenants.mjs            # report only
 *   node scripts/audit/purge-leaked-test-tenants.mjs --apply    # remove them
 *
 * Report-only is the default on purpose: --apply is irreversible, so it has to
 * be something you typed, not something you got. Take a backup first
 * (`npm run backup`) — the removal is not transactional across tenants.
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BACKEND = path.resolve(import.meta.dirname, '..', '..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const pool = (await import(pathToFileURL(path.join(BACKEND, 'src/config/db.js')).href)).default;

const APPLY = process.argv.includes('--apply');

/**
 * --ids 565,566,…  — the exact tenants to remove, required by --apply.
 *
 * The marker rule decides what is a CANDIDATE; this decides what is actually
 * touched, and the two are intersected. `--apply` on its own is refused, so the
 * command that deletes states its own scope: a reader of the shell history, or
 * of an approval prompt, sees every id being removed without having to trust
 * what the regex above matched at the time. An id that is not a candidate is
 * refused rather than removed, so a typo cannot reach a real tenant.
 */
function requestedIds() {
  const i = process.argv.indexOf('--ids');
  if (i === -1 || !process.argv[i + 1]) return null;
  return process.argv[i + 1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
}

// The real tenant. Never a candidate, whatever its name happens to contain.
const PROTECTED_COMPANY_IDS = [1];

// Fixture markers, each anchored to the shape a test harness generates:
//   ZZGEN_1789390254454, ZZTSP_1789486524532   — ZZ<tag>_<epoch ms>
//   IOTP4_1789486167265, IOTE2E_1789486626518  — <tag><digits>_<epoch ms>
//   ZZPROC foreign tenant, ZZAN analytics      — ZZ<tag> + a fixture noun
// A human-named company matches none of these.
const MARKER_PATTERNS = [
  String.raw`ZZ[A-Z0-9]+_[0-9]{10,}`,
  String.raw`IOT[A-Z0-9]*_[0-9]{10,}`,
  String.raw`\mZZ[A-Z]{2,}\M.*\m(foreign|analytics|tenant)\M`,
];
const MARKER_SQL = MARKER_PATTERNS.map(p => `name ~ '${p}' OR code ~ '${p}'`).join(' OR ');

async function classify() {
  const { rows } = await pool.query(
    `SELECT id, name, code, created_at,
            (${MARKER_SQL}) AS looks_like_fixture
       FROM companies ORDER BY id`);
  const purge = rows.filter(r => r.looks_like_fixture && !PROTECTED_COMPANY_IDS.includes(r.id));
  const keep = rows.filter(r => !purge.includes(r));
  return { purge, keep };
}

// Every table carrying a company_id, discovered from the catalog rather than
// listed by hand — a hand-written list goes stale the moment a migration adds
// a table and leaves the company unremovable.
async function ownedTables() {
  const { rows } = await pool.query(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name`);
  return rows.map(r => r.table_name);
}

async function countRows(tables, ids) {
  const counts = {};
  let total = 0;
  for (const t of tables) {
    try {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM "${t}" WHERE company_id = ANY($1)`, [ids]);
      if (rows[0].n > 0) { counts[t] = rows[0].n; total += rows[0].n; }
    } catch { /* shape we cannot count; the sweep reports it as stuck instead */ }
  }
  return { counts, total };
}

// Clears one fixture tenant, repeating while progress is being made so that
// foreign-key ordering resolves itself instead of being hand-maintained.
// Scoped to a single company id on every statement.
async function clearCompany(id, tables) {
  let remaining = tables;
  for (let pass = 0; pass < 8 && remaining.length; pass++) {
    const stuck = [];
    for (const t of remaining) {
      try { await pool.query(`DELETE FROM "${t}" WHERE company_id = $1`, [id]); }
      catch { stuck.push(t); }
    }
    if (stuck.length === remaining.length) break;   // no progress
    remaining = stuck;
  }
  try {
    await pool.query('DELETE FROM companies WHERE id = $1', [id]);
    return { id, removed: true, stuck: remaining };
  } catch (e) {
    return { id, removed: false, blocked_by: e.table ?? e.message, stuck: remaining };
  }
}

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run against NODE_ENV=production.');
  process.exit(2);
}

const { purge, keep } = await classify();

console.log(`\nKEEP (${keep.length}) — no fixture marker, or protected:`);
for (const c of keep) console.log(`   ${String(c.id).padStart(6)}  ${c.name}  [${c.code}]`);

console.log(`\nLEAKED FIXTURE TENANTS (${purge.length}):`);
for (const c of purge) {
  console.log(`   ${String(c.id).padStart(6)}  ${c.name}  [${c.code}]  created ${c.created_at.toISOString().slice(0, 10)}`);
}

if (!purge.length) { console.log('\nNothing to clean up.\n'); await pool.end(); process.exit(0); }

const ids = purge.map(c => c.id);
const tables = await ownedTables();
const { counts, total } = await countRows(tables, ids);

console.log(`\nRows owned by those tenants — ${total} across ${Object.keys(counts).length} of ${tables.length} company-scoped tables:`);
for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${String(n).padStart(5)}  ${t}`);
}

if (!APPLY) {
  console.log('\nREPORT ONLY — nothing changed. To remove them, name them explicitly:');
  console.log(`  node scripts/audit/purge-leaked-test-tenants.mjs --apply --ids ${ids.join(',')}\n`);
  await pool.end();
  process.exit(0);
}

const asked = requestedIds();
if (!asked) {
  console.error('\n--apply requires --ids <comma-separated company ids>. Run without --apply to see the list.\n');
  await pool.end();
  process.exit(2);
}
const notCandidates = asked.filter(id => !ids.includes(id));
if (notCandidates.length) {
  console.error(`\nRefusing: ${notCandidates.join(', ')} ${notCandidates.length === 1 ? 'is not a' : 'are not'} leaked-fixture candidate(s).\n`);
  await pool.end();
  process.exit(2);
}

const target = purge.filter(c => asked.includes(c.id));
console.log(`\nApplying to the ${target.length} tenant(s) named on the command line…`);
const results = [];
for (const c of target) results.push(await clearCompany(c.id, tables));
const gone = results.filter(r => r.removed);
const left = results.filter(r => !r.removed);
console.log(`\n  removed ${gone.length}/${results.length} tenants`);
for (const r of left) console.log(`  ⚠ ${r.id} NOT removed — blocked by ${r.blocked_by}`);

const after = await countRows(tables, ids);
console.log(`  residual rows for those company ids: ${after.total}`);
console.log(`  companies now: ${(await pool.query('SELECT COUNT(*)::int n FROM companies')).rows[0].n}\n`);
await pool.end();
