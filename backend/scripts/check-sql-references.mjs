#!/usr/bin/env node
/**
 * check-sql-references.mjs
 *
 * Scans the analytics/dashboard/AI route files for table and column references
 * and verifies each one exists in the live database.
 *
 * WHY
 * ---
 * Four references in shipped code pointed at things that did not exist:
 *   - `assessment_submissions` (HR Benchmarking training effectiveness)
 *   - `recruitment_costs`      (HR Benchmarking cost per hire)
 *   - `invoices.client_name`   (the invoice-outlier anomaly detector)
 *   - `inventory_items.name`   (the AI assistant's low-stock answer)
 * Every one of them was wrapped in a try/catch or a `.catch(() => [])`, so the
 * error never surfaced. The features simply reported "no data" forever, which is
 * indistinguishable from a genuinely quiet dataset.
 *
 * The scan is deliberately conservative: it only reports a reference it is
 * confident about, because a false positive here is worse than a miss.
 *
 * Usage:
 *   node backend/scripts/check-sql-references.mjs
 *   node backend/scripts/check-sql-references.mjs --json
 */
import dotenv from 'dotenv';
import path from 'node:path';
// Load backend/.env explicitly so the script works from either the repo root or
// backend/ — Playwright and CI both run it with cwd outside backend/.
// `override: false` (the default) means a real environment variable always wins,
// which is what lets CI supply DATABASE_URL with no .env present at all.
dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env'), quiet: true });
import fs from 'node:fs';

// Reuse the application's own pool rather than building a second client here.
// The previous version constructed a pg.Client from DB_HOST/DB_USER/DB_PASSWORD,
// which is only how a dev box is configured — CI has no .env and connects via
// DATABASE_URL, so the checker could not run there at all. db.js already handles
// both, plus SSL, so the checker now connects exactly the way the server does.
const pool = (await import('../src/config/db.js')).default;

const JSON_OUT = process.argv.includes('--json');
/**
 * Root the scan is relative to.
 *
 * Defaults to backend/. `CHECK_SRC_ROOT` points it at a copy of the tree so the
 * negative-fixture tests in src/__tests__/analytics.schemaGuards.test.js can
 * inject a defect without editing the working tree — those files
 * (statusSets.js, analytics.routes.js) are imported by other test files, and
 * rewriting them mid-run crashed a sibling vitest worker reading a half-written
 * file. The database is still the real one; only the source location moves.
 */
const ROOT = process.env.CHECK_SRC_ROOT
  ? path.resolve(process.env.CHECK_SRC_ROOT)
  : path.resolve(import.meta.dirname, '..');

/**
 * Files to scan.
 *
 * This was a hand-maintained allowlist of 15 analytics/AI files, and that is
 * exactly how the Reports module shipped with eleven dead reports: it was never
 * added, so `employees.employee_code`, `inventory_items.category`,
 * `projects.name`, `payroll_runs.company_id`, `sales_targets.employee_id` and a
 * `parties.id uuid = purchase_orders.supplier_id integer` join all sailed past a
 * gate that was already running green in CI on every build.
 *
 * The list is now DISCOVERED, not maintained: every .js under src/ that contains
 * SQL is scanned. A new module is covered the day it is written, and there is no
 * list for anyone to forget. `SCAN_ONLY` narrows the sweep to matching paths for
 * a fast local loop; the negative-fixture tests still use CHECK_SRC_ROOT.
 */
const SQL_HINT = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i;

function discoverFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      // Migrations declare the schema rather than query it, and __tests__ carry
      // deliberate negative fixtures.
      if (['node_modules', '__tests__', 'migrations', 'seeds'].includes(entry.name)) continue;
      discoverFiles(rel, acc);
    } else if (entry.name.endsWith('.js')) {
      const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (SQL_HINT.test(body)) acc.push(rel);
    }
  }
  return acc;
}

const SCAN_ONLY = process.env.SCAN_ONLY ? process.env.SCAN_ONLY.split(',') : null;
const FILES = discoverFiles('src')
  .filter(f => !SCAN_ONLY || SCAN_ONLY.some(p => f.includes(p)))
  .sort();

// Discovering nothing must be a hard failure, never a silent PASS. A checker
// that scans zero files still prints "PASS — every referenced table and column
// exists" and guards nothing, which is precisely how this gate ran green in CI
// over a stale 15-file allowlist while eleven Reports queries were dead.
if (FILES.length === 0) {
  console.error([
    'FAIL — the scan discovered no files, so it is guarding nothing.',
    SCAN_ONLY
      ? `SCAN_ONLY=${SCAN_ONLY.join(',')} matched no paths.`
      : 'Check ROOT and the SQL_HINT pattern.',
  ].join('\n'));
  process.exit(1);
}

/**
 * Tables that have never existed in any migration, whose routes are explicitly
 * short-circuited to 501 in src/modules/intelligence/intelligence.routes.js
 * (see UNBACKED_PREFIXES there).
 *
 * These are reported as UNIMPLEMENTED rather than MISSING and do not fail the
 * gate: the query text is retained deliberately as the record of the intended
 * schema, and no request can reach it. They are listed — not silently skipped —
 * so the debt stays visible on every run, and
 * src/__tests__/analytics.intelligenceContract.test.js asserts the 501s, so
 * deleting the short-circuit while leaving the queries turns the gate red.
 */
const UNIMPLEMENTED_TABLES = new Set([
  'sla_config', 'sla_tracking', 'dashboard_widgets', 'documents',
  'project_costs', 'budget_vs_actual', 'profit_tracker', 'masters',
  'insights_cache',
]);

// SQL keywords and CTE-ish words that follow FROM/JOIN but are not tables.
//
// The `pg_*` entries are PostgreSQL system catalogs. They live in pg_catalog,
// not in information_schema.tables, so the schema snapshot this gate builds can
// never contain them and every one of them reads as a phantom table. They were
// enumerated one at a time, which meant the gate went red the first time a query
// reached for a catalog nobody had listed yet — `pg_inherits`, added by the
// System Health partitioned-table fix (§127), turned the build red while being
// entirely correct. `isSystemCatalog()` below generalises the rule instead:
// `pg_` is a prefix PostgreSQL reserves, so no application table can claim it.
const NOT_A_TABLE = new Set([
  'select', 'lateral', 'unnest', 'generate_series', 'values', 'information_schema',
  'pg_class', 'pg_namespace', 'pg_stat_user_tables', 'pg_constraint', 'dual',
  // SQL niladic functions that appear after FROM inside EXTRACT(...).
  'current_date', 'current_timestamp', 'now', 'localtimestamp', 'current_time',
]);

// PostgreSQL reserves the `pg_` prefix for its own catalogs and no user table
// may be created with it, so a `FROM pg_<anything>` is a catalog read by
// definition, not a reference this gate can resolve against the schema.
const isSystemCatalog = (name) => name.startsWith('pg_');

const { rows: tableRows } = await pool.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
const TABLES = new Set(tableRows.map(r => r.table_name));

const { rows: colRows } = await pool.query(
  `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`);
const COLUMNS = new Map();
/**
 * Every column name in the schema, regardless of table.
 *
 * `EXTRACT(MONTH FROM dob)` and `EXTRACT(EPOCH FROM ts)` put a column name
 * directly after the FROM keyword, where a table would normally sit. Rather than
 * try to parse SQL properly, the scan simply never reports a token that is a
 * real column somewhere — a table and a column sharing a name is rare, and a
 * missed report costs far less than a false one.
 */
const ALL_COLUMN_NAMES = new Set();
for (const r of colRows) {
  if (!COLUMNS.has(r.table_name)) COLUMNS.set(r.table_name, new Set());
  COLUMNS.get(r.table_name).add(r.column_name);
  ALL_COLUMN_NAMES.add(r.column_name);
}
await pool.end();

/**
 * SQL keywords, type names and built-in functions that can appear where an
 * unqualified column would. Used only by the single-table unqualified-column
 * pass; a name in here is never reported. Kept deliberately generous — the pass
 * already requires the token to be a real column name somewhere in the schema,
 * so the cost of an extra entry is a miss, and the cost of a missing one is a
 * false positive that trains people to ignore the check.
 */
const SQL_WORDS = new Set([
  'select','from','where','and','or','not','in','is','null','as','on','join','left','right',
  'inner','outer','full','cross','lateral','group','by','order','having','limit','offset',
  'union','all','distinct','case','when','then','else','end','asc','desc','nulls','first','last',
  'insert','into','values','update','set','delete','returning','conflict','do','nothing',
  'with','recursive','exists','between','like','ilike','similar','escape','any','some','array',
  'true','false','unknown','default','cast','collate','filter','over','partition','window',
  'count','sum','avg','min','max','coalesce','nullif','greatest','least','round','abs','ceil',
  'floor','length','lower','upper','trim','btrim','ltrim','rtrim','substring','substr','replace',
  'concat','concat_ws','split_part','position','strpos','regexp_replace','regexp_match',
  'to_char','to_date','to_number','to_timestamp','date_trunc','date_part','extract','age','now',
  'current_date','current_time','current_timestamp','localtime','localtimestamp','interval',
  'int','integer','bigint','smallint','numeric','decimal','real','float','double','precision',
  'text','varchar','char','character','varying','boolean','bool','date','time','timestamp',
  'timestamptz','uuid','json','jsonb','bytea','serial','bigserial','money',
  'row_number','rank','dense_rank','lag','lead','first_value','last_value','ntile',
  'string_agg','array_agg','json_agg','jsonb_agg','json_build_object','jsonb_build_object',
  'unnest','generate_series','nextval','currval','setval','md5','random','sign','mod','power',
  'asc_nulls_last','epoch','day','month','year','week','hour','minute','second','quarter','dow','doy',
]);


/**
 * Template literals that are actually SQL.
 *
 * A literal counts only when it opens with a SQL verb. Matching any literal that
 * merely CONTAINS the word FROM pulled in prose — JSDoc lines like "derived from
 * real DB history" produced phantom missing tables named "real", "the" and
 * "actual". Requiring the literal to start with SELECT/WITH/INSERT/UPDATE/DELETE
 * costs nothing in coverage and removes that entire class of noise.
 */
/**
 * Blank out the parts of a SQL string that are not SQL: line comments, block
 * comments, and — the one that actually bit — single-quoted string literals.
 *
 * English prose inside a SQL literal was being read as schema. Real examples
 * that reached the baseline as "missing tables":
 *   'Imported from CSV'                  -> table `csv`
 *   ' [Delegated from user ', id, ']'    -> table `user`
 *   'Sourced from our vendor list'       -> table `our`
 * Each one is a value, not a relation, and no amount of tightening the FROM
 * pattern can tell them apart — the fix is to stop looking inside quotes.
 *
 * Replaced with spaces rather than removed so byte offsets (and therefore the
 * reported line numbers) stay correct.
 */
function stripSqlNoise(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {                 // -- line comment
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      out += ' '.repeat(end - i); i = end;
    } else if (ch === '/' && sql[i + 1] === '*') {          /* block comment */
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      out += ' '.repeat(end - i); i = end;
    } else if (ch === "'") {                                // 'string literal'
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }  // '' escape
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      out += ' '.repeat(j - i); i = j;
    } else {
      out += ch; i++;
    }
  }
  return out;
}

/**
 * Blank out JavaScript comments before any template literal is extracted.
 *
 * A JSDoc block is prose, and prose is full of backticks — this codebase marks
 * up identifiers as `purchase_orders.total_amount`, `LIMIT 20`, `PO_VOID`.
 * sqlLiterals() cannot tell an inline-code backtick from a template-literal
 * delimiter, so the CLOSING backtick of a markup span opens what it believes is
 * a SQL literal, and everything up to the next backtick in the paragraph gets
 * scanned as schema.
 *
 * That is not hypothetical. spendAnalytics.service.js:24 reads
 *
 *     3. SILENT TRUNCATION. A hard `LIMIT 20` with no total and no flag.
 *
 * The backtick after "20" is followed by the English word "with", which the
 * leading-verb alternation happily matched as the SQL keyword WITH. The scan
 * then ran on into "...share-of-spend computed from it was a share of..." and
 * reported a missing table named `it`. One prose sentence, one phantom
 * finding, in a file whose SQL is entirely correct — exactly the "a check that
 * reports things that are fine is a check people stop reading" failure this
 * script's own comments warn about.
 *
 * Comments cannot contain a real query, so blanking them first costs no
 * coverage. Strings and template literals are walked over rather than blanked,
 * so a `//` inside a URL or a SQL body is never mistaken for a comment.
 *
 * Replaced with spaces rather than removed so byte offsets — and therefore the
 * reported line numbers — stay correct, the same convention as stripSqlNoise().
 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {                  // // line comment
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i); i = end;
    } else if (ch === '/' && src[i + 1] === '*') {           /* block comment */
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      // Newlines are preserved so a multi-line JSDoc does not collapse the line
      // numbering of everything after it.
      out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end;
    } else if (ch === "'" || ch === '"' || ch === '`') {    // string / template
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }           // escaped char
        if (src[j] === ch) { j++; break; }
        // An unterminated single/double quote would otherwise swallow the rest
        // of the file; a real one never spans a line.
        if (ch !== '`' && src[j] === '\n') break;
        j++;
      }
      out += src.slice(i, j); i = j;
    } else {
      out += ch; i++;
    }
  }
  return out;
}

function sqlLiterals(src) {
  // Comments first — see stripJsComments(). Offsets are preserved, so `offset`
  // still maps to the right line in the ORIGINAL source.
  const code = stripJsComments(src);
  return [...code.matchAll(/`(\s*(?:--[^\n]*\n\s*)*(?:SELECT|WITH|INSERT|UPDATE|DELETE)\b[^`]*)`/gis)]
    .map(m => ({ raw: m[1], offset: m.index }));
}

const missingTables = [];
const missingColumns = [];
const unimplemented = [];
const checked = { tables: 0, columns: 0 };

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');

  // CTE names declared in this file are legitimate FROM targets.
  const ctes = new Set([...src.matchAll(/(?:WITH|,)\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)].map(m => m[1].toLowerCase()));

  // ── tables ──────────────────────────────────────────────────────────────
  //
  //
  // Only scanned inside actual SQL template literals, and only where the token
  // after FROM/JOIN really is a relation. Earlier revisions scanned whole files
  // and reported "age", "now", "mean" and "general" as missing tables — those
  // came from `EXTRACT(MONTH FROM AGE(...))`, `FROM now()`, an English sentence
  // ("2.5σ from 90-day mean") and a JSDoc line. A check that reports things that
  // are fine is a check people stop reading, so precision is preferred to recall.
  for (const { raw, offset } of sqlLiterals(src)) {
    const text = stripSqlNoise(raw);
    for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b/gi)) {
      const name = m[1].toLowerCase();
      if (NOT_A_TABLE.has(name) || isSystemCatalog(name) || ctes.has(name)) continue;
      // NOTE: this used to `continue` on any name that is a column somewhere in
      // the schema, as a crude guard against EXTRACT(unit FROM column). That made
      // every phantom table whose name collides with any column invisible to this
      // check — which is exactly how `FROM departments` (a column on hr_shifts) and
      // `FROM events` (a column on esign_webhooks) survived the 226->0 burndown and
      // kept 500ing at runtime. The precise openCall guard below covers the real
      // EXTRACT/SUBSTRING case, so the blunt one is gone. Removing it widened the
      // scan by ~245 references and added no false positives.
      const after  = text.slice(m.index + m[0].length);
      const before = text.slice(Math.max(0, m.index - 120), m.index);
      // FROM age( — a function call, e.g. EXTRACT(MONTH FROM AGE(...)).
      if (/^\s*\(/.test(after)) continue;
      // `IS DISTINCT FROM next.state` — a qualified COLUMN, not a relation. A
      // relation is never immediately followed by a dot.
      if (/^\./.test(after)) continue;
      // A SQL keyword can never be a relation here. This matters because
      // stripSqlNoise() blanks string literals, so `IS DISTINCT FROM 'Left'
      // LIMIT 1` collapses to `FROM      LIMIT 1` and the next token read as a
      // table name. Blanking is still the right call — it kills a whole class of
      // prose-as-schema false positives — so the keyword guard goes here.
      if (SQL_WORDS.has(name)) continue;
      // ) ts — the alias of a derived table or VALUES list, not a base table.
      if (/\)\s*$/.test(before.trim())) continue;
      // EXTRACT(unit FROM col) / SUBSTRING(x FROM y) — here FROM is an argument
      // separator, and what follows is a column or expression, never a relation.
      // Detected by an EXTRACT/SUBSTRING/POSITION/TRIM call still open to our left.
      const openCall = /\b(EXTRACT|SUBSTRING|POSITION|TRIM|OVERLAY)\s*\(([^()]*)$/i.test(before);
      if (openCall) continue;
      checked.tables++;
      if (!TABLES.has(name)) {
        const line = src.slice(0, offset + m.index).split('\n').length;
        const bucket = UNIMPLEMENTED_TABLES.has(name) ? unimplemented : missingTables;
        if (!bucket.some(x => x.table === name && x.file === rel)) {
          bucket.push({ file: rel, line, table: name });
        }
      }
    }
  }

  // ── columns ─────────────────────────────────────────────────────────────
  //
  // Checked PER SQL STRING, not per file, and with comments stripped first.
  //
  // An earlier version built one alias->table map for the whole file, so `p`
  // bound to `projects` in one query was then applied to `p` meaning a derived
  // table in another, and every output alias of that subquery (p.revenue,
  // p.cost, ...) was reported as missing. It also scanned SQL comments, so a
  // note explaining a column that USED to be referenced was flagged as a live
  // reference to it. A false positive here trains people to ignore the check,
  // so the scan is scoped tightly and skips anything it cannot resolve
  // confidently — a miss is cheaper than noise.
  for (const { raw, offset } of sqlLiterals(src)) {
    // Strip -- line comments; they describe code rather than being it.
    const text = stripSqlNoise(raw);

    // A query containing a derived table or CTE is skipped: its aliases can
    // legitimately expose columns that exist on no base table.
    if (/\(\s*SELECT/i.test(text) || /\bWITH\b/i.test(text)) continue;

    const aliases = new Map();
    for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)\s+(?:AS\s+)?([a-z][a-z0-9_]{0,3})\b(?!\s*\()/gi)) {
      const t = m[1].toLowerCase(), a = m[2].toLowerCase();
      if (!TABLES.has(t) || ctes.has(t)) continue;
      if (['on','as','and','or','set','where','left','join','group','order','is','not','in','by'].includes(a)) continue;
      if (aliases.has(a) && aliases.get(a) !== t) aliases.set(a, null);
      else if (!aliases.has(a)) aliases.set(a, t);
    }

    for (const [alias, table] of aliases) {
      if (!table) continue;
      const cols = COLUMNS.get(table);
      if (!cols) continue;
      const re = new RegExp(`\\b${alias}\\.([a-z_][a-z0-9_]*)\\b`, 'gi');
      for (const m of text.matchAll(re)) {
        const col = m[1].toLowerCase();
        if (col === '*') continue;
        checked.columns++;
        if (!cols.has(col)) {
          const line = src.slice(0, offset + m.index).split('\n').length;
          if (!missingColumns.some(x => x.table === table && x.column === col && x.file === rel)) {
            missingColumns.push({ file: rel, line, table, column: col });
          }
        }
      }
    }

    // ── Unqualified columns on writes ─────────────────────────────────────
    //
    // Until the CRM audit (2026-08-19) this checker validated only `alias.col`
    // references — its own summary said so ("qualified column reference(s)").
    // That blind spot hid a live defect: Customer 360 filtered invoices on
    // `LOWER(customer_name)`, written unqualified, against a table whose column
    // is `party_name`. It threw 42703 on every call, the caller swallowed it,
    // and the panel rendered empty forever, while both the failures list and
    // the ratchet baseline stayed silent.
    //
    // Only INSERT column lists and UPDATE ... SET targets are scanned. Those
    // parse unambiguously: the table is named right there, and every identifier
    // in the list IS a column of it by definition — no aliases, no select list,
    // no `FILTER (WHERE …)`, nothing to guess. Scanning SELECT predicates was
    // tried and abandoned: `COUNT(*) FILTER (WHERE …) AS active` and friends
    // produced a flood of false positives, and this file's standing rule is that
    // noise is worse than a miss, because a noisy gate is one people stop
    // reading. SELECT-side unqualified columns remain unchecked — see the
    // limitation printed in the summary.
    for (const m of text.matchAll(/\bINSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
      const table = m[1].toLowerCase();
      if (!TABLES.has(table) || ctes.has(table)) continue;
      const cols = COLUMNS.get(table);
      if (!cols) continue;
      for (const rawCol of m[2].split(',')) {
        const col = rawCol.trim().toLowerCase();
        if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue;
        checked.columns++;
        if (!cols.has(col)) {
          const line = src.slice(0, offset + m.index).split('\n').length;
          if (!missingColumns.some(x => x.table === table && x.column === col && x.file === rel)) {
            missingColumns.push({ file: rel, line, table, column: col });
          }
        }
      }
    }

    for (const m of text.matchAll(/\bUPDATE\s+([a-z_][a-z0-9_]*)\s+SET\b([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/gi)) {
      const table = m[1].toLowerCase();
      if (!TABLES.has(table) || ctes.has(table)) continue;
      const cols = COLUMNS.get(table);
      if (!cols) continue;
      // Only the assignment targets: the identifier immediately before each `=`
      // at the start of a clause. Right-hand sides can reference anything.
      for (const a of m[2].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/gi)) {
        const col = a[1].toLowerCase();
        checked.columns++;
        if (!cols.has(col)) {
          const line = src.slice(0, offset + m.index).split('\n').length;
          if (!missingColumns.some(x => x.table === table && x.column === col && x.file === rel)) {
            missingColumns.push({ file: rel, line, table, column: col });
          }
        }
      }
    }
  }
}

/* ── Ratchet ──────────────────────────────────────────────────────────────────
 * Widening the scan from a 15-file allowlist to every SQL-bearing file under
 * src/ surfaced 149 pre-existing broken references across 20 modules. Fixing
 * all of them is its own project; refusing to widen the scan until someone does
 * is how the allowlist stayed stale long enough for eleven Reports queries to
 * ship dead.
 *
 * So the gate ratchets. Everything is scanned; findings already recorded in
 * sql-reference-baseline.json are reported as known debt and do not fail the
 * build; anything NEW fails it. A module written today — or a query edited
 * today — is protected from the first commit, and the baseline can only shrink:
 * a reference that has been fixed is reported as stale so it gets removed.
 *
 * Regenerate deliberately, never as a reflex, with:  node check-sql-references.mjs --update-baseline
 */
const BASELINE_PATH = path.resolve(import.meta.dirname, 'sql-reference-baseline.json');
const keyOf = m => `${m.file}|${m.table}${m.column ? '.' + m.column : ''}`;

const allFindings = [
  ...missingTables.map(m => ({ ...m, kind: 'table' })),
  ...missingColumns.map(m => ({ ...m, kind: 'column' })),
];

let baseline = new Set();
if (fs.existsSync(BASELINE_PATH)) {
  baseline = new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).known || []);
}

if (process.argv.includes('--update-baseline')) {
  const known = [...new Set(allFindings.map(keyOf))].sort();
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({
    note: 'Known-broken SQL references, carried so the repo-wide gate can fail on NEW ones. This list may only shrink.',
    generated: new Date().toISOString().slice(0, 10),
    known,
  }, null, 2) + '\n');
  console.log(`Baseline written: ${known.length} known finding(s).`);
  process.exit(0);
}

// SCAN_ONLY narrows the sweep, so a baseline entry outside the swept paths is
// not stale — it simply was not looked at.
const sweptFiles = new Set(FILES);
const inSweep = key => sweptFiles.has(key.split('|')[0]);

const newFindings = allFindings.filter(m => !baseline.has(keyOf(m)));
const knownHit = new Set(allFindings.map(keyOf).filter(k => baseline.has(k)));
const staleBaseline = [...baseline].filter(k => inSweep(k) && !knownHit.has(k));

if (JSON_OUT) {
  // Fenced so callers can extract the payload deterministically. dotenv v17
  // prints a rotating tip banner to STDOUT that sometimes contains a brace
  // ('{ processEnv: myObject }'), which made a naive indexOf('{') parse the
  // banner instead of the report — an intermittent failure that looked like a
  // schema problem. Same sentinel convention as e2e-mint-token.mjs.
  console.log('---REPORT_BEGIN---');
  console.log(JSON.stringify({ missingTables, missingColumns, unimplemented, checked }));
  console.log('---REPORT_END---');
} else {
  console.log('\nSQL reference check\n' + '='.repeat(60));
  console.log(`Scanned ${FILES.length} file(s): ${checked.tables} table reference(s), ${checked.columns} qualified column reference(s).\n`);
  if (unimplemented.length) {
    for (const m of unimplemented) {
      console.log(`UNIMPLEMENTED   ${m.file}:${m.line}  ${m.table}  (route 501s; never existed in any migration)`);
    }
    console.log('');
  }
  if (newFindings.length) {
    for (const m of newFindings) {
      const what = m.kind === 'table' ? `MISSING TABLE   ${m.file}:${m.line}  ${m.table}`
                                      : `MISSING COLUMN  ${m.file}:${m.line}  ${m.table}.${m.column}`;
      console.log(what);
    }
    console.log('\nFAIL — these references resolve to nothing. Any query using them fails at runtime,');
    console.log('and if it is wrapped in a catch it will report "no data" indefinitely.');
    console.log('They are not in the baseline, so they are new. Fix them rather than baselining them.');
  } else {
    console.log('PASS — no new broken references'
      + (unimplemented.length ? `; the ${unimplemented.length} unimplemented reference(s) above are declared.` : '.'));
  }

  if (knownHit.size) {
    console.log(`\n${knownHit.size} known finding(s) carried in the baseline (pre-existing debt, not failing the build).`);
    console.log('Run with --json to list them, or open scripts/sql-reference-baseline.json.');
  }
  if (staleBaseline.length) {
    console.log(`\n${staleBaseline.length} baseline entr(ies) no longer resolve to a defect — these were fixed:`);
    for (const k of staleBaseline) console.log(`  FIXED  ${k.replace('|', '  ')}`);
    console.log('Remove them from the baseline so it cannot silently grow back.');
  }
}
process.exit(newFindings.length ? 1 : 0);

process.exit(missingTables.length + missingColumns.length === 0 ? 0 : 1);
