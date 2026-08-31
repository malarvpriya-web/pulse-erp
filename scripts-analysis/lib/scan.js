/**
 * Manifest Analyzer — source scanning and static parsing.
 *
 * Everything here is regex/heuristic based on purpose: the toolkit must run
 * offline with no build step and no import of application code (importing
 * backend modules would open DB connections). Heuristics are tuned to the
 * conventions actually used in this repo, documented per-function.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EXT, IGNORED_DIRS, FRONTEND_SRC, BACKEND_SRC, BACKEND, ROOT,
} from './config.js';
import { readSafe } from './fsx.js';

/** Recursively collect every file under `dir`, skipping IGNORED_DIRS. */
export function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

export const posix = (p) => p.split(path.sep).join('/');
export const relRoot = (p) => posix(path.relative(ROOT, p));

const extOf = (f) => path.extname(f).toLowerCase();
const inDir = (f, name) => posix(f).includes(`/${name}/`);

export function extKind(file) {
  const e = extOf(file);
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(e)) return kind;
  return 'other';
}

const isTest = (f) => /(__tests__|\.test\.|\.spec\.)/.test(posix(f));

/**
 * Classify a frontend source file into the buckets the spec asks for.
 * Order matters: a file under features/x/pages/ is a page, not a component,
 * even though it also exports a React component.
 */
export function classifyFrontend(file) {
  const p = posix(file);
  const kind = extKind(file);
  if (isTest(file)) return 'test';
  if (kind === 'css') return 'style';
  if (kind === 'image') return 'asset';
  if (!['js', 'jsx', 'ts', 'tsx'].includes(kind)) return 'other';
  if (inDir(p, 'pages')) return 'page';
  if (inDir(p, 'context') || /Context\.(jsx?|tsx?)$/.test(p)) return 'context';
  if (inDir(p, 'hooks') || /\/use[A-Z][A-Za-z0-9]*\.(jsx?|tsx?)$/.test(p)) return 'hook';
  if (inDir(p, 'services') || /\.service\.(jsx?|tsx?)$/.test(p)) return 'service';
  if (inDir(p, 'utils') || inDir(p, 'helpers')) return 'utility';
  if (inDir(p, 'store') || /store\.(jsx?|tsx?)$/.test(p)) return 'store';
  if (inDir(p, 'config')) return 'config';
  if (inDir(p, 'components') || kind === 'jsx' || kind === 'tsx') return 'component';
  return 'other';
}

/** Classify a backend source file. `.routes.js` naming wins over folder position. */
export function classifyBackend(file) {
  const p = posix(file);
  if (isTest(file)) return 'test';
  if (!['js', 'ts'].includes(extKind(file))) return 'other';
  if (/\.routes?\.(js|ts)$/.test(p) || inDir(p, 'routes')) return 'route';
  if (/\.controller\.(js|ts)$/.test(p) || inDir(p, 'controllers')) return 'controller';
  if (/\.service\.(js|ts)$/.test(p) || inDir(p, 'services')) return 'service';
  if (/\.model\.(js|ts)$/.test(p) || inDir(p, 'models') || inDir(p, 'repositories')) return 'model';
  if (inDir(p, 'middleware') || inDir(p, 'middlewares') || /\.middleware\.(js|ts)$/.test(p)) return 'middleware';
  if (inDir(p, 'utils') || inDir(p, 'shared') || inDir(p, 'helpers')) return 'utility';
  if (inDir(p, 'config')) return 'config';
  if (inDir(p, 'database') || inDir(p, 'migrations') || inDir(p, 'seeds')) return 'database';
  if (inDir(p, 'jobs')) return 'job';
  return 'other';
}

/** Infer a module slug from `features/<slug>/` or `modules/<slug>/` in the path. */
export function moduleOf(file) {
  const m = posix(file).match(/\/(?:features|modules)\/([^/]+)\//);
  return m ? m[1] : null;
}

/** Collect frontend + backend source files once; every later step reuses this. */
export function collectSources() {
  const frontend = walk(FRONTEND_SRC).map((file) => ({
    file,
    rel: relRoot(file),
    side: 'frontend',
    kind: classifyFrontend(file),
    ext: extKind(file),
    module: moduleOf(file),
    lines: countLines(file),
  }));
  const backendFiles = [...walk(BACKEND_SRC), path.join(BACKEND, 'server.js')].filter(fs.existsSync);
  const backend = backendFiles.map((file) => ({
    file,
    rel: relRoot(file),
    side: 'backend',
    kind: classifyBackend(file),
    ext: extKind(file),
    module: moduleOf(file),
    lines: countLines(file),
  }));
  return { frontend, backend, all: [...frontend, ...backend] };
}

export function countLines(file) {
  if (!['js', 'jsx', 'ts', 'tsx', 'css'].includes(extKind(file))) return 0;
  const text = readSafe(file);
  return text ? text.split('\n').length : 0;
}

/* ── Backend API extraction ─────────────────────────────────────────────── */

const METHOD_RE = /\brouter\s*\.\s*(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]*)\2([^\n]*)/g;
const MOUNT_RE = /\b(?:v1Router|app|router)\s*\.\s*use\s*\(\s*(['"`])(\/[^'"`]*)\1\s*,([^\n]*)/g;

/** Parse `requirePermission('mod','action')` / `allowRoles(...)` / `verifyToken` off the handler line. */
function parseGates(tail) {
  const gates = [];
  const perm = /requirePermission\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = perm.exec(tail))) gates.push({ type: 'permission', module: m[1], action: m[2] });
  const roles = /allowRoles\(([^)]*)\)/g;
  while ((m = roles.exec(tail))) {
    gates.push({ type: 'roles', roles: m[1].split(',').map((r) => r.trim().replace(/['"]/g, '')).filter(Boolean) });
  }
  if (/\bverifyToken\b/.test(tail)) gates.push({ type: 'verifyToken' });
  return gates;
}

/**
 * Map `v1Router.use("/crm", verifyToken, crmRoutes)` → the imported identifier's
 * source file, so each route file can be prefixed with its real mount path.
 */
export function parseMounts(serverFile) {
  const text = readSafe(serverFile);
  if (!text) return [];

  const imports = new Map(); // identifier -> resolved absolute file
  const importRe = /import\s+([A-Za-z0-9_$]+)\s+from\s+(['"])([^'"]+)\2/g;
  let m;
  while ((m = importRe.exec(text))) {
    const [, ident, , spec] = m;
    if (!spec.startsWith('.')) continue;
    const resolved = resolveImport(path.dirname(serverFile), spec);
    if (resolved) imports.set(ident, resolved);
  }

  const mounts = [];
  while ((m = MOUNT_RE.exec(text))) {
    const [, , mountPath, tail] = m;
    const line = text.slice(0, m.index).split('\n').length;
    const idents = [...tail.matchAll(/([A-Za-z0-9_$]+)/g)].map((x) => x[1]);
    const target = idents.map((i) => imports.get(i)).find(Boolean);
    if (!target) continue;
    mounts.push({
      mountPath,
      file: target,
      line,
      gates: parseGates(tail),
    });
  }
  return mounts;
}

/** Resolve a relative import specifier to a real file, trying the usual extensions. */
export function resolveImport(fromDir, spec) {
  const base = path.resolve(fromDir, spec);
  const candidates = [
    base,
    ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].map((e) => base + e),
    ...['index.js', 'index.mjs', 'index.jsx', 'index.ts'].map((f) => path.join(base, f)),
  ];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

/** Extract every `router.METHOD(...)` declaration from a route file. */
export function parseEndpoints(file) {
  const text = readSafe(file);
  if (!text) return [];
  const out = [];
  let m;
  METHOD_RE.lastIndex = 0;
  while ((m = METHOD_RE.exec(text))) {
    const [, method, , routePath, tail] = m;
    out.push({
      method: method.toUpperCase(),
      path: routePath,
      line: text.slice(0, m.index).split('\n').length,
      gates: parseGates(tail),
    });
  }
  return out;
}

/**
 * Build the full API surface: every endpoint with its mounted prefix.
 * Route files that are never mounted in server.js are reported as `unmounted`,
 * which is how dead route files surface.
 */
export function buildApiSurface() {
  const serverFile = path.join(BACKEND, 'server.js');
  const mounts = parseMounts(serverFile);
  const byFile = new Map();
  for (const mt of mounts) {
    if (!byFile.has(mt.file)) byFile.set(mt.file, []);
    byFile.get(mt.file).push(mt);
  }

  const routeFiles = walk(BACKEND_SRC).filter((f) => classifyBackend(f) === 'route');
  const endpoints = [];
  const unmounted = [];

  for (const file of routeFiles) {
    const eps = parseEndpoints(file);
    if (!eps.length) continue;
    const fileMounts = byFile.get(file);
    if (!fileMounts) {
      unmounted.push({ file: relRoot(file), endpoints: eps.length });
      continue;
    }
    for (const mt of fileMounts) {
      for (const ep of eps) {
        const suffix = ep.path === '/' ? '' : ep.path;
        endpoints.push({
          method: ep.method,
          path: `/api/v1${mt.mountPath}${suffix}`.replace(/\/+$/, '') || '/api/v1',
          module: moduleOf(file) ?? 'core',
          file: relRoot(file),
          line: ep.line,
          mountPath: mt.mountPath,
          // A route inherits the mount's gates (e.g. verifyToken) plus its own.
          gates: [...mt.gates, ...ep.gates],
        });
      }
    }
  }

  // A route registered after a same-prefix wildcard (`/:id`) can never be reached.
  const shadowed = findShadowedRoutes(endpoints);
  return { endpoints, unmounted, mounts, shadowed };
}

/**
 * Detect endpoints shadowed by an earlier param route in the same file+mount,
 * e.g. `GET /leads/:id` declared before `GET /leads/export` swallows /export.
 */
function findShadowedRoutes(endpoints) {
  const out = [];
  const groups = new Map();
  for (const ep of endpoints) {
    const key = `${ep.file}|${ep.method}|${ep.mountPath}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ep);
  }
  for (const list of groups.values()) {
    const ordered = [...list].sort((a, b) => a.line - b.line);
    const params = ordered.filter((e) => /\/:[^/]+$/.test(e.path));
    for (const literal of ordered) {
      if (/\/:/.test(literal.path)) continue;
      const parent = literal.path.replace(/\/[^/]+$/, '');
      const blocker = params.find((p) => p.line < literal.line && p.path.replace(/\/:[^/]+$/, '') === parent);
      if (blocker) out.push({ shadowed: literal, by: blocker });
    }
  }
  return out;
}

/* ── Frontend route extraction ──────────────────────────────────────────── */

/**
 * Parse config/routes.jsx. Routes are page-keys mapped to lazy() imports, and
 * NAV_ITEMS references those keys — so "unused route" = defined but never
 * reachable from the sidebar.
 */
export function buildRouteMap() {
  const file = path.join(FRONTEND_SRC, 'config', 'routes.jsx');
  const text = readSafe(file);
  if (!text) return { routes: [], navPages: [], missing: [], unused: [], file: null };

  const routes = [];
  // Entry shape: `Key: { [module: 'x',] component: [lazy(() =>] import('@/path') ... }`.
  // Other keys (module, props) may precede `component:`, so match non-greedily up to it.
  const routeRe = /^\s*([A-Za-z0-9_]+)\s*:\s*\{[^\n]*?component:\s*(lazy\(\s*\(\)\s*=>\s*)?\s*import\(\s*(['"])([^'"]+)\3/gm;
  let m;
  while ((m = routeRe.exec(text))) {
    const [, key, lazyMark, , importPath] = m;
    routes.push({
      key,
      importPath,
      lazy: Boolean(lazyMark),
      line: text.slice(0, m.index).split('\n').length,
      resolved: resolveAlias(importPath),
    });
  }

  const navStart = text.indexOf('export const NAV_ITEMS');
  const navText = navStart >= 0 ? text.slice(navStart) : '';
  const navPages = [];
  const navRe = /\bpage:\s*(['"])([^'"]+)\1/g;
  while ((m = navRe.exec(navText))) navPages.push(m[2]);

  const navModuleRe = /\bmodule:\s*(['"])([^'"]+)\1/g;
  const navModules = [];
  while ((m = navModuleRe.exec(navText))) navModules.push(m[2]);

  const keys = new Set(routes.map((r) => r.key));
  const navSet = new Set(navPages);
  const missing = [...new Set(navPages)].filter((p) => !keys.has(p)); // sidebar → nowhere
  const unused = routes.filter((r) => !navSet.has(r.key)).map((r) => r.key); // defined, not in sidebar
  const broken = routes.filter((r) => r.resolved === null);

  return {
    file: relRoot(file),
    routes,
    navPages: [...new Set(navPages)],
    navModules: [...new Set(navModules)],
    missing,
    unused,
    broken,
  };
}

/** Resolve the `@/` vite alias to frontend/src. Returns null if the target is absent. */
export function resolveAlias(spec) {
  if (!spec.startsWith('@/')) return null;
  const base = path.join(FRONTEND_SRC, spec.slice(2));
  const candidates = [
    ...['.jsx', '.js', '.tsx', '.ts'].map((e) => base + e),
    ...['index.jsx', 'index.js'].map((f) => path.join(base, f)),
    base,
  ];
  const hit = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  return hit ? relRoot(hit) : null;
}

/* ── Cross-cutting scans ────────────────────────────────────────────────── */

const TODO_RE = /(?:\/\/|\/\*|\*|#)\s*(TODO|FIXME|HACK|XXX|BUG|DEPRECATED)\b[:\s-]*(.*)/i;

/** Step 15 — collect TODO/FIXME/HACK/XXX markers with file, line and context. */
export function scanTodos(sources) {
  const out = [];
  for (const s of sources) {
    if (!['js', 'jsx', 'ts', 'tsx', 'css'].includes(s.ext)) continue;
    const text = readSafe(s.file);
    if (!text || !/TODO|FIXME|HACK|XXX|BUG|DEPRECATED/i.test(text)) continue;
    text.split('\n').forEach((line, i) => {
      const m = line.match(TODO_RE);
      if (!m) return;
      out.push({
        tag: m[1].toUpperCase(),
        text: (m[2] || '').trim().slice(0, 200),
        file: s.rel,
        line: i + 1,
        side: s.side,
        module: s.module,
      });
    });
  }
  return out;
}

/** Extract named + default exports (heuristic) for the duplicate-export scan. */
export function scanExports(file) {
  const text = readSafe(file);
  if (!text) return [];
  const names = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
    /export\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) names.add(m[1]);
  }
  const braceRe = /export\s*\{([^}]+)\}/g;
  let m;
  while ((m = braceRe.exec(text))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/i).pop().trim();
      if (name && name !== 'default') names.add(name);
    }
  }
  return [...names];
}

/** Cheap content fingerprint: strips comments + whitespace so formatting noise doesn't hide clones. */
export function fingerprint(file) {
  const text = readSafe(file);
  if (!text) return null;
  const normalized = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length < 200) return null; // ignore trivial/barrel files
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) h = ((h * 33) ^ normalized.charCodeAt(i)) >>> 0;
  return { hash: h.toString(16), size: normalized.length };
}

/** Build the import graph for internal (relative + `@/`) imports only. */
export function importGraph(sources) {
  const graph = new Map();
  const byRel = new Map(sources.map((s) => [s.rel, s]));
  for (const s of sources) {
    if (!['js', 'jsx', 'ts', 'tsx'].includes(s.ext)) continue;
    const text = readSafe(s.file);
    if (!text) continue;
    const deps = new Set();
    const re = /(?:import\s[^'"]*from\s*|import\s*\(\s*|require\s*\(\s*)(['"])([^'"]+)\1/g;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[2];
      let resolved = null;
      if (spec.startsWith('@/')) resolved = resolveAlias(spec);
      else if (spec.startsWith('.')) {
        const abs = resolveImport(path.dirname(s.file), spec);
        resolved = abs ? relRoot(abs) : null;
      } else continue; // external package — not part of the internal graph
      if (resolved && byRel.has(resolved)) deps.add(resolved);
    }
    graph.set(s.rel, [...deps]);
  }
  return graph;
}
