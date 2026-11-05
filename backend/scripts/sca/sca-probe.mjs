// backend/scripts/sca/sca-probe.mjs
/**
 * Probes used by the 198-component supply-chain scorecard.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first SCA pass scored 198 components by reading code. That is how a
 * scorecard drifts: a capability gets deleted, renamed or unmounted and the
 * score keeps saying "full" because nobody re-read the file. Worse, that pass's
 * own headline defect was exactly that shape - an MRP engine that was excellent
 * in source and emitted nothing at runtime.
 *
 * So every component is scored by a PROBE that fails when the mechanism stops
 * working, not by a claim:
 *
 *   be(re)      the backend implements it - regex over backend/src
 *   ep(spec)    an HTTP route exists AND is reachable from server.js's mount
 *               graph. A router nobody mounts is not a capability.
 *   fe(re)      the frontend calls it - regex over frontend/src
 *   page(name)  a page is registered in ROUTES *and* reachable from NAV_ITEMS.
 *               Registered-but-unnavigable is the "mounted nowhere" defect.
 *   sql(q, fn)  the live database agrees - the mechanism has actually run
 *
 * A component is FULL only when every probe it declares passes. Anything else
 * is reported with the failing probe named, so the gap is actionable rather
 * than a number.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE     = path.dirname(fileURLToPath(import.meta.url));
const BACKEND  = path.resolve(HERE, '../..');
const ROOT     = path.resolve(BACKEND, '..');
const FRONTEND = path.join(ROOT, 'frontend');

// -- source index -------------------------------------------------------------
function walk(dir, out = [], exts = ['.js', '.jsx', '.mjs']) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, exts);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

const load = files => files.map(f => ({ path: f, text: fs.readFileSync(f, 'utf8') }));

export const backendFiles  = load(walk(path.join(BACKEND, 'src')));
export const frontendFiles = load(walk(path.join(FRONTEND, 'src')));
const serverJs  = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
const routesJsx = fs.readFileSync(path.join(FRONTEND, 'src/config/routes.jsx'), 'utf8');

// -- mount graph --------------------------------------------------------------
// server.js:  import xRoutes from "./src/..."   +   v1Router.use("/prefix", ..., xRoutes)
// route file: router.use('/sub', childRouter)   +   import childRouter from './child.js'
function buildMounts() {
  const imports = new Map();
  for (const m of serverJs.matchAll(/import\s+(\w+)\s+from\s+["'](\.\/src\/[^"']+)["']/g)) {
    imports.set(m[1], path.resolve(BACKEND, m[2]));
  }
  const mounts = [];
  for (const m of serverJs.matchAll(/v1Router\.use\(\s*["']([^"']+)["']\s*,([^;]*?)\)\s*;/g)) {
    const args = m[2];
    for (const [name, file] of imports) {
      if (new RegExp('\\b' + name + '\\b').test(args)) mounts.push({ prefix: m[1], file });
    }
  }
  const expanded = [...mounts];
  for (const mnt of mounts) {
    const src = backendFiles.find(f => f.path === mnt.file);
    if (!src) continue;
    const childImports = new Map();
    for (const m of src.text.matchAll(/import\s+(\w+)\s+from\s+['"](\.[^'"]+)['"]/g)) {
      let p = path.resolve(path.dirname(src.path), m[2]);
      if (!fs.existsSync(p) && fs.existsSync(p + '.js')) p += '.js';
      childImports.set(m[1], p);
    }
    for (const m of src.text.matchAll(/router\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g)) {
      const child = childImports.get(m[2]);
      if (child) expanded.push({ prefix: mnt.prefix + m[1], file: child });
    }
  }
  return expanded;
}
const MOUNTS = buildMounts();
export const mountCount = MOUNTS.length;

// -- probe primitives ---------------------------------------------------------
export function be(re, label) {
  const rx = re instanceof RegExp ? re : new RegExp(re);
  return { kind: 'be', label: label || String(rx), run: () => {
    for (const f of backendFiles) {
      if (rx.test(f.text)) return { ok: true, evidence: path.relative(ROOT, f.path).replace(/\\/g, '/') };
    }
    return { ok: false, evidence: 'no backend source matches ' + rx };
  } };
}

export function fe(re, label) {
  const rx = re instanceof RegExp ? re : new RegExp(re);
  return { kind: 'fe', label: label || String(rx), run: () => {
    for (const f of frontendFiles) {
      if (rx.test(f.text)) return { ok: true, evidence: path.relative(ROOT, f.path).replace(/\\/g, '/') };
    }
    return { ok: false, evidence: 'no frontend source matches ' + rx };
  } };
}

/** ep('GET /inventory/planning/abc') - declared and reachable from a mount. */
export function ep(spec) {
  const [methodRaw, full] = spec.split(/\s+/);
  const method = methodRaw.toLowerCase();
  return { kind: 'ep', label: spec, run: () => {
    const candidates = MOUNTS
      .filter(m => full === m.prefix || full.startsWith(m.prefix + '/'))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    for (const c of candidates) {
      const sub = full.slice(c.prefix.length) || '/';
      const src = backendFiles.find(f => f.path === c.file);
      if (!src) continue;
      const escaped = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, ':\\w+');
      const pattern = new RegExp('router\\.' + method + '\\(\\s*[\'"`]' + escaped + '[\'"`]');
      if (pattern.test(src.text)) {
        return { ok: true, evidence: path.relative(ROOT, c.file).replace(/\\/g, '/') + ' @ ' + c.prefix };
      }
    }
    return { ok: false, evidence: 'no mounted router declares ' + spec };
  } };
}

/** page('ScmControlTower') - in the ROUTES registry and reachable from NAV_ITEMS. */
export function page(name) {
  return { kind: 'page', label: 'page ' + name, run: () => {
    const registered = new RegExp('\\n\\s*' + name + '\\s*:\\s*\\{').test(routesJsx);
    const navigable  = new RegExp("page:\\s*'" + name + "'").test(routesJsx);
    if (registered && navigable) return { ok: true, evidence: 'ROUTES.' + name + ' + NAV_ITEMS' };
    if (registered) return { ok: false, evidence: 'ROUTES.' + name + ' exists but no NAV_ITEMS entry' };
    return { ok: false, evidence: 'no ROUTES.' + name };
  } };
}

/** sql('label', 'select ...', rows => rows[0].n > 0) */
export function sql(label, query, predicate, params = []) {
  return { kind: 'sql', label, run: async (q) => {
    try {
      const rows = await q(query, params);
      const ok = !!predicate(rows);
      const shown = rows.length ? JSON.stringify(rows[0]).slice(0, 140) : '(no rows)';
      return { ok, evidence: ok ? shown : 'predicate failed: ' + shown };
    } catch (e) {
      return { ok: false, evidence: 'query failed: ' + e.message };
    }
  } };
}

export { ROOT, BACKEND, FRONTEND };
