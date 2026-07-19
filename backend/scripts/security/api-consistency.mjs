/**
 * API consistency audit — Phase 1 item 2.
 *
 * Measures the checklist items that can be determined statically across every
 * route file: pagination, sorting, filtering, validation, error shape, and
 * audit logging on mutations.
 *
 * Deliberately reports RATIOS per concern rather than a single score. "62% of
 * list endpoints paginate" is actionable; a composite number is not.
 *
 * Not measured here (needs runtime): actual HTTP status correctness per path,
 * and whether a filter parameter is honoured rather than merely referenced.
 */
import { readFileSync } from 'fs';
import { ROOT, routeFiles } from './authz-config.mjs';

const ROUTE_ANY =
  /router\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]*)\2\s*,([\s\S]*?)(?=\n\s*router\.|$)/g;

const has = (s, re) => re.test(s);

const stats = {
  list:        { total: 0, paginated: 0, sorted: 0, filtered: 0 },
  mutation:    { total: 0, validated: 0, audited: 0 },
  errors:      { total: 0, bareMessage: 0, structured: 0, leaksRaw: 0, leaks4xx: 0, leaks5xx: 0 },
  statusCodes: { create201: 0, createTotal: 0, delete204: 0, deleteTotal: 0 },
};
const offenders = { pagination: [], audit: [], rawError: [] };

for (const f of routeFiles()) {
  const src = readFileSync(f, 'utf8');
  const short = f.replace(ROOT, 'src');
  let m; ROUTE_ANY.lastIndex = 0;

  while ((m = ROUTE_ANY.exec(src)) !== null) {
    const [, verb, , path, body] = m;

    // ── list endpoints: GET with no :param (collection, not item) ──
    if (verb === 'get' && !/:\w/.test(path)) {
      stats.list.total++;
      const paged = has(body, /\b(limit|per_page|pageSize)\b/) && has(body, /\b(offset|page)\b/);
      if (paged) stats.list.paginated++; else offenders.pagination.push(`${short} GET ${path || '/'}`);
      if (has(body, /\b(sort|order_by|orderBy|sortBy)\b/))            stats.list.sorted++;
      if (has(body, /req\.query\.\w+/) && has(body, /WHERE|where/))    stats.list.filtered++;
    }

    // ── mutations ──
    if (verb !== 'get') {
      stats.mutation.total++;
      const validated = has(body, /\bvalidate\(|\bjoi\b|\bzod\b|required|res\.status\(400\)/i);
      if (validated) stats.mutation.validated++;
      const audited = has(body, /logAudit|writeAuditLog|auditRepository|logaudit/i);
      if (audited) stats.mutation.audited++; else offenders.audit.push(`${short} ${verb.toUpperCase()} ${path || '/'}`);

      if (verb === 'post') { stats.statusCodes.createTotal++; if (has(body, /status\(201\)/)) stats.statusCodes.create201++; }
      if (verb === 'delete') { stats.statusCodes.deleteTotal++; if (has(body, /status\(204\)/)) stats.statusCodes.delete204++; }
    }

    // ── error shape ──
    // The 4xx/5xx split matters: sanitizeErrorResponse rewrites 5xx bodies in
    // production, so a raw err.message there is contained. It only fires on
    // statusCode >= 500, so a raw message on a 4xx reaches the client verbatim.
    const errs = body.match(/res\.status\(\s*([45]\d\d)\s*\)\.json\(([^)]*)\)/g) || [];
    for (const e of errs) {
      stats.errors.total++;
      const is4xx = /status\(\s*4\d\d/.test(e);
      if (/error:\s*(err|e|error)\.message/.test(e)) {
        stats.errors.leaksRaw++;
        if (is4xx) { stats.errors.leaks4xx++; offenders.rawError.push(`${short} ${verb.toUpperCase()} ${path || '/'}`); }
        else stats.errors.leaks5xx++;
      }
      else if (/code:/.test(e)) stats.errors.structured++;
      else stats.errors.bareMessage++;
    }
  }
}

const pct = (a, b) => b ? `${(100 * a / b).toFixed(0)}%` : 'n/a';
const line = (label, a, b) => console.log(`  ${label.padEnd(34)} ${String(a).padStart(4)} / ${String(b).padEnd(4)}  ${pct(a, b).padStart(4)}`);

console.log('\n═══ API CONSISTENCY AUDIT ═══\n');
console.log('LIST ENDPOINTS (GET collections)');
line('paginated (limit + offset/page)', stats.list.paginated, stats.list.total);
line('sortable',                        stats.list.sorted,    stats.list.total);
line('filterable',                      stats.list.filtered,  stats.list.total);

console.log('\nMUTATIONS (POST/PUT/PATCH/DELETE)');
line('input validation present',        stats.mutation.validated, stats.mutation.total);
line('audit logged',                    stats.mutation.audited,   stats.mutation.total);

console.log('\nHTTP STATUS CONVENTION');
line('POST returning 201',              stats.statusCodes.create201, stats.statusCodes.createTotal);
line('DELETE returning 204',            stats.statusCodes.delete204, stats.statusCodes.deleteTotal);

console.log('\nERROR RESPONSES');
line('structured (has code:)',          stats.errors.structured,  stats.errors.total);
line('bare { error: "..." }',           stats.errors.bareMessage, stats.errors.total);
line('raw err.message on 5xx (scrubbed)', stats.errors.leaks5xx, stats.errors.total);
line('raw err.message on 4xx (LEAKS)',   stats.errors.leaks4xx, stats.errors.total);

const top = (arr, n = 8) => [...new Set(arr)].slice(0, n).forEach(x => console.log(`     ${x}`));
console.log('\n  Unpaginated list endpoints (sample):');       top(offenders.pagination);
console.log('\n  Mutations with no audit log (sample):');      top(offenders.audit);
console.log('\n  Handlers echoing raw err.message (sample):'); top(offenders.rawError);
console.log('');
