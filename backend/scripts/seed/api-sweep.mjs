/**
 * Sweeps every paramless GET endpoint and reports the ones that break.
 *
 *   node scripts/seed/api-sweep.mjs [--base=http://localhost:5000] [--params]
 *
 * Route table is derived statically: `v1Router.use("<prefix>", xRoutes)` in
 * server.js is paired with the `router.get("<path>")` calls in the imported
 * file. With the previously-empty tables now populated, list endpoints execute
 * row-formatting code that has never run before — that is where the bugs are.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const m = argv.find(a => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; };
const BASE = arg('base', 'http://localhost:5000');
const WITH_PARAMS = argv.includes('--params');

// ── token ────────────────────────────────────────────────────────────────────
const out = execFileSync('node', [path.join(ROOT, 'scripts/e2e-mint-token.mjs')], { encoding: 'utf8', cwd: ROOT });
const fenced = /---E2E_AUTH_BEGIN---\s*([\s\S]*?)\s*---E2E_AUTH_END---/.exec(out);
const { token } = JSON.parse(fenced[1]);

// ── static route table ───────────────────────────────────────────────────────
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const imports = new Map();                       // ident -> absolute file path
for (const m of server.matchAll(/import\s+(\w+)\s+from\s+["']([^"']+)["']/g)) {
  if (!m[2].startsWith('.')) continue;
  let p = path.resolve(ROOT, m[2]);
  if (!fs.existsSync(p) && fs.existsSync(p + '.js')) p += '.js';
  if (fs.existsSync(p)) imports.set(m[1], p);
}

const mounts = [];                               // {prefix, ident}
for (const m of server.matchAll(/v1Router\.use\(\s*["']([^"']+)["']\s*,([^)]*)\)/g)) {
  const idents = [...m[2].matchAll(/\b(\w+Routes?|\w+Router)\b/g)].map(x => x[1]);
  for (const id of idents) if (imports.has(id)) mounts.push({ prefix: '/api' + m[1], ident: id });
}
for (const m of server.matchAll(/app\.use\(\s*["'](\/api[^"']*)["']\s*,([^)]*)\)/g)) {
  const idents = [...m[2].matchAll(/\b(\w+Routes?|\w+Router)\b/g)].map(x => x[1]);
  for (const id of idents) if (imports.has(id)) mounts.push({ prefix: m[1], ident: id });
}

const endpoints = new Map();                     // url -> {url, file}
for (const { prefix, ident } of mounts) {
  const file = imports.get(ident);
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  for (const g of src.matchAll(/router\.get\(\s*["']([^"']*)["']/g)) {
    let sub = g[1];
    if (sub === '/' || sub === '') sub = '';
    let url = (prefix + sub).replace(/\/+$/, '') || prefix;
    if (/[:*]/.test(url)) {
      if (!WITH_PARAMS) continue;
      url = url.replace(/:(\w+)/g, (_, n) => (/id$/i.test(n) ? '1' : 'SEED'));
    }
    if (!endpoints.has(url)) endpoints.set(url, { url, file: path.relative(ROOT, file) });
  }
}

const list = [...endpoints.values()].sort((a, b) => a.url.localeCompare(b.url));
console.log(`Sweeping ${list.length} GET endpoints on ${BASE}\n`);

// ── sweep ────────────────────────────────────────────────────────────────────
// The server allows GLOBAL_RL_MAX (default 300) requests per 60s window, so the
// sweep is paced under that. A 429 still costs nothing but a wait-and-retry.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const GAP = Number(arg('gap', 240));

const results = [];
let n = 0, throttled = 0;
for (const ep of list) {
  n++;
  let status = 0, body = '', ms = 0;
  const t0 = Date.now();
  for (let tryN = 1; tryN <= 3; tryN++) {
    try {
      const r = await fetch(BASE + ep.url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      });
      status = r.status;
      body = (await r.text()).slice(0, 600);
    } catch (e) {
      status = -1; body = String(e.message);
    }
    if (status !== 429) break;
    throttled++;
    console.log(`  … rate-limited, waiting 61s (${n}/${list.length})`);
    await sleep(61000);
  }
  ms = Date.now() - t0;
  results.push({ ...ep, status, ms, body });
  await sleep(GAP);
  if (status >= 500 || status === -1) {
    console.log(`  ${status} ${ep.url}  (${ep.file})\n      ${body.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  if (n % 50 === 0) console.log(`  … ${n}/${list.length}`);
}

fs.writeFileSync(path.join(HERE, '_api-sweep.json'), JSON.stringify(results, null, 1));
const by = (f) => results.filter(f).length;
console.log(`\nSwept ${results.length}: ` +
  `2xx ${by(r => r.status >= 200 && r.status < 300)} · ` +
  `3xx/4xx ${by(r => r.status >= 300 && r.status < 500)} · ` +
  `5xx ${by(r => r.status >= 500)} · ` +
  `429 ${by(r => r.status === 429)} · network ${by(r => r.status === -1)}`);
const slow = results.filter(r => r.ms > 3000).sort((a, b) => b.ms - a.ms).slice(0, 10);
if (slow.length) console.log(`\nSlowest:\n${slow.map(r => `  ${r.ms}ms ${r.url}`).join('\n')}`);
console.log(`\nFull results: scripts/seed/_api-sweep.json`);
