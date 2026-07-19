/**
 * The subset that matters most: unguarded PRIVILEGED operations.
 *
 * approve / reject / cancel / void / finalize / close / override, or any DELETE,
 * acting on a record identified by `:id`. These are never "self-service" the way
 * `POST /attendance/clock` is — they act on a record belonging to someone else —
 * so an unguarded one is a finding rather than a design choice.
 *
 * Classification config is shared with authz-sweep.mjs; see authz-config.mjs.
 */
import { readFileSync } from 'fs';
import { ROOT, ROUTE, routeFiles, classifyChain, hasFileWideAuthz } from './authz-config.mjs';

const PRIV = /(approve|reject|cancel|void|post-to-ledger|finalize|close|reopen|publish|activate|deactivate|reset|override)/i;

const hits = [];
for (const f of routeFiles()) {
  const src = readFileSync(f, 'utf8');
  if (hasFileWideAuthz(src)) continue;
  let m; ROUTE.lastIndex = 0;
  while ((m = ROUTE.exec(src)) !== null) {
    const [, method, , path, chain] = m;
    const { authz } = classifyChain(chain);
    if (authz.length) continue;
    if ((PRIV.test(path) || method === 'delete') && /:\w+/.test(path)) {
      hits.push({ file: f.replace(ROOT, 'src'), route: `${method.toUpperCase()} ${path}` });
    }
  }
}

const byFile = {};
for (const h of hits) (byFile[h.file] ||= []).push(h.route);

console.log(`Unguarded PRIVILEGED mutating routes (approve/reject/cancel/delete on :id): ${hits.length}\n`);
for (const [f, rs] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length).slice(0, 20)) {
  console.log(`${String(rs.length).padStart(3)}  ${f}`);
  console.log(`     ${rs.slice(0, 4).join('  |  ')}`);
}

// ── CI gate ───────────────────────────────────────────────────────────────────
// `--max N` exits non-zero when the count rises above N, so newly-added
// ungated privileged routes fail the build. The threshold is a ratchet: lower
// it as routes get gated, never raise it to make a build pass.
const maxArg = process.argv.indexOf('--max');
if (maxArg !== -1) {
  const max = parseInt(process.argv[maxArg + 1], 10);
  if (hits.length > max) {
    console.error(`\n❌ ${hits.length} ungated privileged routes exceeds the limit of ${max}.`);
    console.error(`   Gate the new route, or if it is genuinely public add it to BY_DESIGN.`);
    process.exit(1);
  }
  console.log(`\n✅ ${hits.length} ungated privileged routes (limit ${max}).`);
}
