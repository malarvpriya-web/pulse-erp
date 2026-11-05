#!/usr/bin/env node
/**
 * scripts/db/schema-compare.mjs — compare two database schemas, read-only.
 *
 *   node scripts/db/schema-compare.mjs <urlA> <urlB>     # exit 0 = no genuine difference
 *
 * Every connection is forced read-only. Nothing is hidden: each difference is
 * reported in one of three classes, and the output says how many of each and which:
 *
 *   genuine  — a real structural difference. Any of these fails the comparison.
 *   expected — one of the two rules below, each re-proved from the data every run:
 *     1. device_telemetry monthly partitions, and the indexes and constraints they
 *        carry: created over time by a job, so a database's age decides how many
 *        it has. Only names matching device_telemetry_YYYY_MM qualify, and only if
 *        the object really is a partition of device_telemetry in that database.
 *     2. fk_suggestions_converted_pr being NOT VALID, only while that database
 *        really holds a dangling pointer (20260926000013 branches on exactly this).
 *        NOT VALID with nothing dangling is genuine.
 *   cosmetic — the same definition printed differently: a CHECK or partial index
 *     whose ARRAY of varchar literals PostgreSQL printed in its other form, or a
 *     function body differing only in comments and whitespace. The literal lists,
 *     their casts and everything else must still match exactly.
 */
import { pathToFileURL } from 'node:url';

const QUERIES = {
  tables: `SELECT c.relname k, c.relkind::text v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p')`,
  columns: `SELECT c.relname||'.'||a.attname k,
                   format_type(a.atttypid,a.atttypmod)||' notnull='||a.attnotnull||' generated='||a.attgenerated::text||' default='||COALESCE(pg_get_expr(d.adbin,d.adrelid),'') v
              FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
              LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
             WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`,
  constraints: `SELECT c.conrelid::regclass::text||'.'||c.conname k, pg_get_constraintdef(c.oid) v
                  FROM pg_constraint c WHERE c.connamespace='public'::regnamespace AND c.contype <> 'n'`,
  indexes: `SELECT indexname k, indexdef v FROM pg_indexes WHERE schemaname='public'`,
  triggers: `SELECT c.relname||'.'||t.tgname k, pg_get_triggerdef(t.oid)||' enabled='||t.tgenabled::text v
               FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND NOT t.tgisinternal`,
  functions: `SELECT p.oid::regprocedure::text k, p.prosecdef::text||'|'||COALESCE(array_to_string(p.proconfig,','),'')||'|'||p.prosrc v
                FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`,
  sequences: `SELECT c.relname k, s.seqtypid::regtype::text||' inc='||s.seqincrement||' start='||s.seqstart||' cycle='||s.seqcycle v
                FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid
               WHERE n.nspname='public' AND c.relkind='S'`,
  views: `SELECT c.relname k, pg_get_viewdef(c.oid) v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relkind='v'`,
  extensions: `SELECT extname k, extversion v FROM pg_extension`,
};

const PARTITION_NAME = /^device_telemetry_\d{4}_\d{2}$/;
const FK = 'fk_suggestions_converted_pr';

/** The other print form of a varchar IN-list, with nothing else changed. */
export function canonicalDefinition(def) {
  return String(def)
    .replace(/\('((?:[^']|'')*)'::character varying\)::text/g, "'$1'::character varying")
    .replace(/\(ARRAY\[([^\]]*)\]\)::text\[\]/g, 'ARRAY[$1]');
}

/** A function body without comments and whitespace; case is kept, so string contents still compare. */
export function canonicalBody(v) {
  return String(v).replace(/--[^\n]*/g, '').replace(/\s+/g, '');
}

async function load(client) {
  await client.query('SET default_transaction_read_only = on');
  const out = {};
  for (const [kind, sql] of Object.entries(QUERIES)) {
    out[kind] = new Map((await client.query(sql)).rows.map((r) => [r.k, r.v]));
  }
  const { rows: parts } = await client.query(
    `SELECT child.relname FROM pg_inherits i JOIN pg_class child ON child.oid=i.inhrelid
      JOIN pg_class parent ON parent.oid=i.inhparent WHERE parent.relname='device_telemetry' AND child.relkind='r'`);
  out.partitions = new Set(parts.map((r) => r.relname));
  const has = (await client.query(`SELECT to_regclass('public.purchase_suggestions') a, to_regclass('public.purchase_requests') b`)).rows[0];
  out.dangling = has.a && has.b
    ? (await client.query(`SELECT COUNT(*)::int n FROM purchase_suggestions ps LEFT JOIN purchase_requests pr ON pr.id=ps.converted_to_pr_id
                            WHERE ps.converted_to_pr_id IS NOT NULL AND pr.id IS NULL`)).rows[0].n
    : 0;
  return out;
}

const partitionOf = (kind, key) => {
  // tables: the name; columns and constraints: table.x; indexes: <partition>_...; sequences never.
  if (kind === 'tables') return key;
  if (kind === 'columns' || kind === 'constraints') return key.split('.')[0];
  if (kind === 'indexes') return key.match(/^device_telemetry_\d{4}_\d{2}/)?.[0] ?? null;
  return null;
};
const isKnownPartition = (side, kind, key) => {
  const p = partitionOf(kind, key);
  return !!p && PARTITION_NAME.test(p) && side.partitions.has(p);
};

/** Compare two connected clients. Returns { genuine, expected, cosmetic, counts }. */
export async function compareSchemas(clientA, clientB) {
  const A = await load(clientA);
  const B = await load(clientB);
  const genuine = [], expected = [], cosmetic = [];
  const counts = {};
  for (const kind of Object.keys(QUERIES)) {
    counts[kind] = { a: A[kind].size, b: B[kind].size };
    for (const key of A[kind].keys()) {
      if (!B[kind].has(key)) {
        (isKnownPartition(A, kind, key) ? expected : genuine).push({ kind, key, only: 'a' });
      }
    }
    for (const key of B[kind].keys()) {
      if (!A[kind].has(key)) {
        (isKnownPartition(B, kind, key) ? expected : genuine).push({ kind, key, only: 'b' });
      }
    }
    for (const [key, va] of A[kind]) {
      if (!B[kind].has(key)) continue;
      const vb = B[kind].get(key);
      if (va === vb) continue;
      const entry = { kind, key, a: va, b: vb };
      if (kind === 'constraints' && key.endsWith(`.${FK}`)) {
        const same = va.replace(/ NOT VALID$/, '') === vb.replace(/ NOT VALID$/, '');
        const notValidSide = va.endsWith(' NOT VALID') ? A : (vb.endsWith(' NOT VALID') ? B : null);
        if (same && notValidSide && notValidSide.dangling > 0) { expected.push({ ...entry, rule: `NOT VALID with ${notValidSide.dangling} dangling pointer(s)` }); continue; }
        genuine.push(entry);
        continue;
      }
      if ((kind === 'constraints' || kind === 'indexes') && canonicalDefinition(va) === canonicalDefinition(vb)) { cosmetic.push(entry); continue; }
      if (kind === 'functions' && canonicalBody(va) === canonicalBody(vb)) { cosmetic.push(entry); continue; }
      genuine.push(entry);
    }
  }
  return { genuine, expected, cosmetic, counts, dangling: { a: A.dangling, b: B.dangling } };
}

export function printReport(r, labelA = 'A', labelB = 'B', log = console.log) {
  for (const [k, c] of Object.entries(r.counts)) log(`  ${k.padEnd(12)} ${labelA}=${c.a} ${labelB}=${c.b}`);
  log(`  genuine=${r.genuine.length} expected=${r.expected.length} cosmetic=${r.cosmetic.length} dangling ${labelA}=${r.dangling.a} ${labelB}=${r.dangling.b}`);
  const line = (e) => `    [${e.kind}] ${e.key}${e.only ? ` only in ${e.only === 'a' ? labelA : labelB}` : ''}${e.rule ? ` (${e.rule})` : ''}`;
  if (r.genuine.length) { log('  GENUINE differences:'); r.genuine.forEach((e) => { log(line(e)); if (e.a !== undefined) { log(`      ${labelA}: ${String(e.a).slice(0, 220)}`); log(`      ${labelB}: ${String(e.b).slice(0, 220)}`); } }); }
  if (r.expected.length) {
    const partitions = new Set(r.expected.filter((e) => e.only).map((e) => partitionOf(e.kind, e.key)));
    log(`  expected: ${[...partitions].sort().join(', ') || 'no partitions'}${r.expected.some((e) => e.rule) ? `; ${r.expected.filter((e) => e.rule).map((e) => `${e.key}: ${e.rule}`).join('; ')}` : ''}`);
  }
  if (r.cosmetic.length) log(`  cosmetic: ${r.cosmetic.map((e) => e.key).join(', ').slice(0, 900)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [urlA, urlB] = process.argv.slice(2);
  if (!urlA || !urlB) { console.error('Usage: node scripts/db/schema-compare.mjs <urlA> <urlB>'); process.exit(2); }
  const { default: pg } = await import('pg');
  const a = new pg.Client({ connectionString: urlA, options: '-c default_transaction_read_only=on' });
  const b = new pg.Client({ connectionString: urlB, options: '-c default_transaction_read_only=on' });
  await a.connect(); await b.connect();
  const result = await compareSchemas(a, b);
  await a.end(); await b.end();
  printReport(result, a.database, b.database);
  process.exit(result.genuine.length ? 1 : 0);
}
