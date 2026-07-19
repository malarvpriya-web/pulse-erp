/**
 * Authorization coverage sweep — all mutating routes.
 *
 * Reports whether ANY verified authorization middleware stands between the
 * router and the handler. It deliberately does not guess: identifiers it cannot
 * classify are listed for triage rather than assumed either way.
 *
 * Why that matters — three earlier versions guessed and were wrong every time:
 *   v1 hardcoded a list       → missed every module-specific guard.
 *   v2 required `name(`       → missed guards passed by reference, which is how
 *                               ordinary middleware is used.
 *   v3 matched require|allow|can|verify
 *                             → missed servicedesk's `svcAdmin`, and counted
 *                               `verifyToken` (authentication) as authorization.
 *
 * Each wrong guess produced a confident number that drove remediation priorities.
 * The hard number below — routes with NO middleware at all — cannot be wrong in
 * that way. See authz-config.mjs to classify a new identifier.
 */
import { readFileSync } from 'fs';
import { ROOT, ROUTE, routeFiles, classifyChain, hasFileWideAuthz } from './authz-config.mjs';

const files = routeFiles();
let total = 0, unguarded = 0, unknownOnly = 0;
const byFile = [], unknownIds = new Map();

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const fileWide = hasFileWideAuthz(src);
  let m; const bare = [];
  ROUTE.lastIndex = 0;

  while ((m = ROUTE.exec(src)) !== null) {
    const [, method, , path, chain] = m;
    total++;
    const { authz, unknown, empty } = classifyChain(chain);
    for (const id of unknown) unknownIds.set(id, (unknownIds.get(id) || 0) + 1);

    if (fileWide || authz.length) continue;
    if (!empty && unknown.length) { unknownOnly++; continue; }
    unguarded++;
    bare.push(`${method.toUpperCase()} ${path || '/'}`);
  }
  if (bare.length) byFile.push({ file: f.replace(ROOT, 'src'), n: bare.length, sample: bare.slice(0, 3) });
}

byFile.sort((a, b) => b.n - a.n);

console.log(`Route files scanned:                 ${files.length}`);
console.log(`Mutating routes:                     ${total}`);
console.log(`NO authorization middleware:         ${unguarded}  (${(100 * unguarded / total).toFixed(1)}%)`);
console.log(`Middleware present but unclassified: ${unknownOnly}  ← triage in authz-config.mjs`);
console.log(`\nTop files by unguarded mutating routes:\n`);
for (const r of byFile.slice(0, 20)) {
  console.log(`${String(r.n).padStart(3)}  ${r.file}`);
  console.log(`     ${r.sample.join('  |  ')}`);
}
if (unknownIds.size) {
  console.log(`\nUnclassified identifiers — add each to KNOWN_AUTHZ or NOT_AUTHZ:`);
  for (const [id, n] of [...unknownIds].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`   ${String(n).padStart(4)}×  ${id}`);
  }
}
