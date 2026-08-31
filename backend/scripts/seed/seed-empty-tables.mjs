/**
 * Seeds every empty table in the public schema with realistic fixture rows.
 *
 *   node scripts/seed/seed-empty-tables.mjs [--rows=5] [--only=a,b] [--dry] [--include-unsafe]
 *
 * Rows are generated from live schema introspection (types, FKs, CHECK
 * vocabularies, UNIQUE keys) and inserted in FK-topological order. Every insert
 * that fails goes through a repair loop that reads the Postgres SQLSTATE and
 * adapts the row; whatever still fails after that is reported as a finding —
 * those are the real schema/constraint defects worth fixing.
 *
 * Every inserted row is recorded in _manifest.json so unseed.mjs can undo it.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makePool, introspect, rowCounts, topoSort } from './lib-schema.mjs';
import { genValue, parseChecks, nextSeq, COMPANY_ID, TAG } from './lib-values.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const m = argv.find(a => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const flag = (k) => argv.includes(`--${k}`);

const ROWS = Number(arg('rows', 5));
const ONLY = arg('only', '') ? arg('only', '').split(',').map(s => s.trim()) : null;
const DRY = flag('dry');
const MAX_ATTEMPTS = 10;

/**
 * Tables deliberately left empty: writing fixtures here changes authentication,
 * session or page-access behaviour and can lock real users out of the live app.
 * Pass --include-unsafe to override.
 */
const UNSAFE = new Map([
  ['ip_whitelist', 'any row turns IP whitelisting ON — locks every other IP out'],
  ['auth_rate_limit', 'fake attempt counters can block real logins'],
  ['revoked_tokens', 'can invalidate live sessions'],
  ['active_sessions', 'fabricated sessions confuse the session manager'],
  ['face_locked_accounts', 'locks employees out of face attendance'],
  ['password_reset_otps', 'live credential-reset material'],
  ['menu_permissions', 'per-role page access — partial rows hide real pages'],
  ['user_menu_permissions', 'per-user page access — partial rows hide real pages'],
]);

const pool = makePool();
const log = (...a) => console.log(...a);

// ── FK value cache ───────────────────────────────────────────────────────────
const fkCache = new Map();
async function fkValues(table, cols) {
  const key = `${table}|${cols.join(',')}`;
  if (fkCache.has(key)) return fkCache.get(key);
  let rows = [];
  try {
    const sel = cols.map(c => `"${c}"`).join(', ');
    const where = cols.map(c => `"${c}" is not null`).join(' and ');
    rows = (await pool.query(`select distinct ${sel} from "${table}" where ${where} limit 50`)).rows;
  } catch { rows = []; }
  fkCache.set(key, rows);
  return rows;
}
const bustFk = (table) => { for (const k of [...fkCache.keys()]) if (k.startsWith(`${table}|`)) fkCache.delete(k); };

// ── row building ─────────────────────────────────────────────────────────────
function skipColumn(c) {
  if (c.is_generated === 'ALWAYS') return true;                 // GENERATED ALWAYS AS
  if (c.identity_generation === 'ALWAYS') return true;          // GENERATED ALWAYS AS IDENTITY
  if (c.column_default && /nextval\(/.test(c.column_default)) return true;  // serial PK
  return false;
}

async function buildRow(meta, idx, enumMap, inserted) {
  const hints = parseChecks(meta.checks);
  const uniqueCols = new Set(meta.uniques.flat());
  const row = {};
  const fkByCol = new Map();
  // Several FK columns can point at the same parent (week_1_shift_id /
  // week_2_shift_id). Offset each constraint into the parent so they pick
  // *different* rows — otherwise `week_1 <> week_2` style CHECKs can never pass.
  const seenPerParent = new Map();
  for (const f of meta.fks) {
    const off = seenPerParent.get(f.ref_table) || 0;
    seenPerParent.set(f.ref_table, off + 1);
    f.cols.forEach((c, i) => fkByCol.set(c, { f, i, off }));
  }

  for (const c of meta.cols) {
    if (skipColumn(c)) continue;
    const name = c.column_name;

    // timestamps: let the column default stand where there is one
    if (/^(created_at|updated_at|modified_at)$/.test(name) && c.column_default) continue;

    // never soft-delete/void a fixture — the row would be invisible everywhere
    if (/^(deleted_at|archived_at|voided_at|cancelled_at|rejected_at|closed_at|is_deleted|is_archived)$/.test(name)
        && (c.is_nullable === 'YES' || c.column_default)) continue;

    // Tenant scoping: pin every fixture to the real company. This must win over
    // the FK sampler below — a row on any other company_id is invisible to every
    // scoped user, which would defeat the point of seeding it.
    if (/^(company_id|tenant_id)$/.test(name)) { row[name] = COMPANY_ID; continue; }

    if (fkByCol.has(name)) {
      const { f, i, off } = fkByCol.get(name);
      if (f.ref_table === meta.name) {                          // self-reference
        row[name] = idx > 0 && inserted.length ? inserted[0][f.ref_cols[i]] ?? null : null;
        continue;
      }
      const vals = await fkValues(f.ref_table, f.ref_cols);
      if (!vals.length) { row[name] = null; continue; }
      row[name] = vals[(idx + off) % vals.length][f.ref_cols[i]];
      continue;
    }

    row[name] = genValue(c, { table: meta.name, idx, hints, enumMap, rowSeq: nextSeq(), uniqueCols });
  }

  // keep obvious date pairs ordered so range CHECKs pass
  orderDatePairs(row);
  return row;
}

function orderDatePairs(row) {
  const pairs = [
    ['start_date', 'end_date'], ['from_date', 'to_date'], ['valid_from', 'valid_to'],
    ['period_start', 'period_end'], ['effective_from', 'effective_to'],
    ['contract_start', 'contract_end'], ['planned_start', 'planned_end'],
    ['actual_start', 'actual_end'], ['issue_date', 'due_date'], ['start_time', 'end_time'],
  ];
  // only reorder real date/time values — a varchar holding prose must not swap
  const temporal = (v) => typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}|\d{2}:\d{2})/.test(v);
  for (const [a, b] of pairs) {
    if (temporal(row[a]) && temporal(row[b]) && row[b] < row[a]) {
      const t = row[a]; row[a] = row[b]; row[b] = t;
    }
  }
}

// ── insert with SQLSTATE-driven repair ───────────────────────────────────────
function nullableOrDefaulted(meta, col) {
  const c = meta.cols.find(x => x.column_name === col);
  return c && (c.is_nullable === 'YES' || c.column_default);
}

async function insertRow(meta, row, enumMap, trace) {
  const hints = parseChecks(meta.checks);
  const returning = meta.pk ? ` returning ${meta.pk.map(c => `"${c}"`).join(', ')}` : '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const keys = Object.keys(row).filter(k => row[k] !== undefined);
    if (!keys.length) return { ok: false, error: 'no insertable columns' };
    const sql = `insert into "${meta.name}" (${keys.map(k => `"${k}"`).join(', ')}) ` +
      `values (${keys.map((_, i) => `$${i + 1}`).join(', ')})${returning}`;
    const params = keys.map(k => row[k]);
    try {
      const r = await pool.query(sql, params);
      return { ok: true, pk: r.rows[0] || null, attempts: attempt };
    } catch (e) {
      trace.push({ attempt, code: e.code, message: e.message, detail: e.detail, constraint: e.constraint });
      if (attempt === MAX_ATTEMPTS || !repair(e, row, meta, hints, enumMap)) {
        return { ok: false, code: e.code, error: e.message, detail: e.detail, constraint: e.constraint, sql };
      }
    }
  }
  return { ok: false, error: 'attempts exhausted' };
}

/** Mutates `row` to answer one Postgres error. Returns false when unrecoverable. */
function repair(e, row, meta, hints, enumMap) {
  const colsOf = (conname) => (meta.checks.find(c => c.conname === conname)?.cols) || [];

  switch (e.code) {
    case '23502': {                                     // not_null_violation
      const col = e.column;
      if (!col) return false;
      const c = meta.cols.find(x => x.column_name === col);
      if (!c) return false;
      row[col] = genValue(c, {
        table: meta.name, idx: 0, hints, enumMap, rowSeq: nextSeq(),
        uniqueCols: new Set(meta.uniques.flat()),
      });
      if (row[col] === null) row[col] = fallbackByType(c);
      return true;
    }
    case '23514': {                                     // check_violation
      const cols = colsOf(e.constraint);
      if (!cols.length) return false;
      let changed = false;
      for (const col of cols) {
        const allowed = hints.allowed.get(col);
        if (allowed) {                                  // rotate to another legal literal
          const i = allowed.indexOf(row[col]);
          row[col] = allowed[(i + 1 + allowed.length) % allowed.length];
          changed = true;
        } else if (nullableOrDefaulted(meta, col)) {
          row[col] = null; changed = true;              // drop and let default/NULL stand
        }
      }
      return changed;
    }
    case '23503': {                                     // foreign_key_violation
      const m = /Key \(([^)]+)\)=/.exec(e.detail || '');
      const cols = m ? m[1].split(',').map(s => s.trim()) : [];
      let changed = false;
      for (const col of cols) {
        if (nullableOrDefaulted(meta, col)) { row[col] = null; changed = true; }
      }
      return changed;
    }
    case '23505': {                                     // unique_violation
      const m = /Key \(([^)]+)\)=/.exec(e.detail || '');
      const cols = m ? m[1].split(',').map(s => s.trim()) : [];
      // Never perturb the scoping key or a FK column to dodge a unique clash —
      // that silently moves the row to another tenant / a non-existent parent.
      const fkCols = new Set(meta.fks.flatMap(f => f.cols));
      const bumpable = cols.filter(c => !/^(company_id|tenant_id)$/.test(c) && !fkCols.has(c));
      let changed = false;
      for (const col of (bumpable.length ? bumpable : cols.filter(c => !/^(company_id|tenant_id)$/.test(c)))) {
        const c = meta.cols.find(x => x.column_name === col);
        if (!c) continue;
        const s = nextSeq();
        if (typeof row[col] === 'string') {
          const v = `${row[col].replace(/-SEED\d+$/, '')}-${TAG}${s}`;
          row[col] = c.character_maximum_length ? v.slice(-c.character_maximum_length) : v;
          changed = true;
        } else if (typeof row[col] === 'number' && !fkCols.has(col)) {
          row[col] = row[col] + s; changed = true;
        } else if (c.data_type === 'date' || c.data_type.startsWith('timestamp')) {
          const d = new Date(Date.parse(row[col]) + 864e5 * s);
          row[col] = c.data_type === 'date' ? d.toISOString().slice(0, 10) : d.toISOString();
          changed = true;
        }
      }
      return changed;
    }
    case '22001': {                                     // string_data_right_truncation
      let changed = false;
      for (const c of meta.cols) {
        const v = row[c.column_name];
        if (typeof v === 'string' && c.character_maximum_length && v.length > c.character_maximum_length) {
          row[c.column_name] = v.slice(0, c.character_maximum_length); changed = true;
        }
      }
      if (!changed) {                                   // unknown width: shrink every string
        for (const k of Object.keys(row)) {
          if (typeof row[k] === 'string' && row[k].length > 8) { row[k] = row[k].slice(0, 8); changed = true; }
        }
      }
      return changed;
    }
    case '22003': {                                     // numeric_value_out_of_range
      let changed = false;
      for (const k of Object.keys(row)) {
        if (typeof row[k] === 'number' && Math.abs(row[k]) > 99) { row[k] = 9; changed = true; }
      }
      return changed;
    }
    case '22P02':
    case '22007':
    case '22008': {                                     // invalid input syntax / datetime
      const m = /:\s*"([^"]*)"/.exec(e.message || '');
      if (m) {
        for (const k of Object.keys(row)) {
          if (String(row[k]) === m[1]) {
            const c = meta.cols.find(x => x.column_name === k);
            row[k] = c && nullableOrDefaulted(meta, k) ? null : fallbackByType(c);
            return true;
          }
        }
      }
      return false;
    }
    case '42703': {                                     // undefined_column
      const m = /column "([^"]+)"/.exec(e.message || '');
      if (m && m[1] in row) { delete row[m[1]]; return true; }
      return false;
    }
    case '23P01': {                                     // exclusion_violation
      for (const k of Object.keys(row)) {
        if (/date|_at$|_time$/.test(k) && typeof row[k] === 'string') {
          row[k] = new Date(Date.parse(row[k]) + 864e5 * (1 + nextSeq())).toISOString().slice(0, row[k].length);
          return true;
        }
      }
      return false;
    }
    default:
      return false;
  }
}

function fallbackByType(c) {
  if (!c) return null;
  const t = c.data_type;
  if (['integer', 'bigint', 'smallint'].includes(t)) return 1;
  if (['numeric', 'real', 'double precision'].includes(t)) return 1;
  if (t === 'boolean') return false;
  if (t === 'date') return '2026-08-20';
  if (t.startsWith('timestamp')) return '2026-08-20T10:00:00.000Z';
  if (c.udt_name === 'uuid') return '00000000-0000-4000-8000-000000000000';
  if (c.udt_name === 'jsonb' || c.udt_name === 'json') return '{}';
  if (t === 'ARRAY') return [];
  return TAG;
}

// ── partition handling ───────────────────────────────────────────────────────
// A partition only accepts keys inside its bound, so seed the parent with a
// timestamp that routes into this partition instead of inserting directly.
function partitionKeyValue(bound) {
  // DEFAULT partition: the key must fall outside every sibling's range
  if (/DEFAULT/.test(bound || '')) return new Date('2019-03-15T08:00:00Z').toISOString();
  const m = /FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(bound || '');
  if (!m) return null;
  const from = Date.parse(m[1]), to = Date.parse(m[2]);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return new Date(from + Math.min(864e5, (to - from) / 2)).toISOString();
}

/**
 * A FK column that is also uniquely constrained on its own makes the table 1:1
 * with its parent — it can never hold more rows than the parent has. Cap there
 * instead of generating rows that are guaranteed to violate one or the other.
 */
async function rowCap(meta, want) {
  let cap = want;
  const singleUniques = new Set(meta.uniques.filter(u => u.length === 1).map(u => u[0]));
  for (const f of meta.fks) {
    if (f.cols.length !== 1 || !singleUniques.has(f.cols[0])) continue;
    const vals = await fkValues(f.ref_table, f.ref_cols);
    cap = Math.min(cap, vals.length);
  }
  return cap;
}

/** Tops thin FK-parent master tables up to `n` rows so children have variety. */
async function topUpParents(T, targets, enumMap, n, manifest) {
  const parents = new Set();
  for (const t of targets) for (const f of T.get(t).fks) if (!targets.includes(f.ref_table)) parents.add(f.ref_table);
  const done = [];
  parents.delete('companies');   // extra tenants would strand child rows out of scope
  for (const p of [...parents].sort()) {
    const meta = T.get(p); if (!meta) continue;
    let have;
    try { have = (await pool.query(`select count(*)::int c from "${p}"`)).rows[0].c; } catch { continue; }
    if (have === 0 || have >= n) continue;
    let added = 0;
    for (let i = have; i < n; i++) {
      const row = await buildRow(meta, i + 7, enumMap, []);
      const r = await insertRow(meta, row, enumMap, []);
      if (r.ok) { added++; if (r.pk) manifest.push({ table: p, pk: r.pk }); }
    }
    if (added) { bustFk(p); done.push(`${p} +${added}`); }
  }
  return done;
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  log(`Introspecting ${process.env.DB_NAME} …`);
  const { T, enumMap } = await introspect(pool);
  const all = [...T.keys()];
  const counts = await rowCounts(pool, all);

  let targets = all.filter(t => counts[t] === 0);
  const partitions = targets.filter(t => T.get(t).isPartition);
  const skipped = [];

  if (ONLY) {
    targets = ONLY.filter(t => T.has(t));
  } else {
    targets = targets.filter(t => {
      if (T.get(t).relkind === 'p') return false;                        // partitioned parent
      if (/^(schema_migrations|audit_logs_backup)$/.test(t)) return false;
      if (!flag('include-unsafe') && UNSAFE.has(t)) { skipped.push(t); return false; }
      return true;
    });
  }

  const order = topoSort(T, targets);
  log(`Empty tables: ${all.filter(t => counts[t] === 0).length} · seeding ${order.length}` +
      (skipped.length ? ` · skipped ${skipped.length} auth/access-critical` : '') +
      ` · ${ROWS} rows each`);
  if (DRY) { log(order.join('\n')); await pool.end(); return; }

  const results = [], manifest = [];
  let okTables = 0, okRows = 0;

  const TOPUP = Number(arg('topup', 0));
  if (TOPUP) {
    const done = await topUpParents(T, order, enumMap, TOPUP, manifest);
    log(`Topped up ${done.length} thin master tables: ${done.join(', ') || '(none)'}\n`);
  }

  for (const name of order) {
    const meta = T.get(name);
    const inserted = [], failures = [];
    const partKey = meta.isPartition ? partitionKeyValue(meta.partBound) : null;
    const want = await rowCap(meta, ROWS);

    for (let i = 0; i < want; i++) {
      const trace = [];
      const row = await buildRow(meta, i, enumMap, inserted);
      if (partKey) {                                    // force the key into this partition's range
        const pcols = meta.cols.filter(c => c.data_type.startsWith('timestamp') || c.data_type === 'date');
        for (const c of pcols) if (row[c.column_name] !== undefined) {
          row[c.column_name] = c.data_type === 'date' ? partKey.slice(0, 10) : partKey;
        }
      }
      const r = await insertRow(meta, row, enumMap, trace);
      if (r.ok) { inserted.push(r.pk || {}); okRows++; if (r.pk) manifest.push({ table: name, pk: r.pk }); }
      else failures.push({ i, code: r.code, error: r.error, detail: r.detail, constraint: r.constraint, trace });
    }

    if (inserted.length) { okTables++; bustFk(name); }
    results.push({ table: name, inserted: inserted.length, attempted: want, failures });
    const mark = inserted.length === want ? 'ok  ' : inserted.length ? 'part' : 'FAIL';
    log(`  [${mark}] ${name} ${inserted.length}/${want}` +
        (failures.length ? `  ← ${failures[0].code || ''} ${String(failures[0].error).slice(0, 110)}` : ''));
  }

  // Merge, never clobber: a targeted --only run must not throw away the rollback
  // record for rows a previous full run inserted.
  const manifestPath = path.join(HERE, '_manifest.json');
  let prior = [];
  try { prior = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { prior = []; }
  const seen = new Set();
  const merged = [...prior, ...manifest].filter(r => {
    const k = `${r.table}|${JSON.stringify(r.pk)}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  fs.writeFileSync(manifestPath, JSON.stringify(merged, null, 1));
  fs.writeFileSync(path.join(HERE, '_results.json'), JSON.stringify({
    seededAt: new Date().toISOString(), rowsPerTable: ROWS,
    skippedUnsafe: skipped.map(t => ({ table: t, why: UNSAFE.get(t) })),
    partitions, results,
  }, null, 1));

  const failed = results.filter(r => r.inserted === 0 && r.attempted > 0);
  const partial = results.filter(r => r.inserted > 0 && r.inserted < r.attempted);
  log(`\nDone. tables seeded ${okTables}/${order.length} · rows ${okRows} · ` +
      `fully failed ${failed.length} · partial ${partial.length}`);
  log(`Reports: scripts/seed/_results.json · scripts/seed/_manifest.json`);
  await pool.end();
})().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
