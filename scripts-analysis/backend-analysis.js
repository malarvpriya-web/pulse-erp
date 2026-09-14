/**
 * Manifest Analyzer — backend analysis.
 *
 * Covers: madge graph + circular check (step 1), dependency-cruiser (step 2),
 * npm audit (step 5) and the API endpoint report (step 17).
 *
 * The backend is never imported — only read as text. Importing it would open
 * database connections and start cron jobs, which a read-only analyzer must not do.
 */
import path from 'node:path';
import {
  BACKEND, BACKEND_SRC, FRONTEND, DIRS, TOOLS, toolAvailable, REPORT_HEADER,
} from './lib/config.js';
import { runNode, runCmd } from './lib/exec.js';
import { write, writeJson, exists } from './lib/fsx.js';
import { buildApiSurface } from './lib/scan.js';
import { h1, h2, stamp, table, bulletList, section } from './lib/report.js';

function madgeBackend(log) {
  if (!toolAvailable('madge')) {
    log.skip('madge (backend)', 'madge not installed at workspace root');
    return { circular: [], ok: false };
  }
  const entry = 'server.js';
  const common = [TOOLS.madge, entry, '--extensions', 'js,mjs,cjs'];

  const circ = runNode([...common, '--circular', '--json'], { cwd: BACKEND });
  let circular = [];
  try {
    circular = JSON.parse(circ.stdout || '[]');
  } catch {
    circular = [];
  }

  const text = runNode([...common, '--circular'], { cwd: BACKEND });
  const summary = runNode([...common, '--summary'], { cwd: BACKEND });
  write(
    path.join(DIRS.reports, 'madge-backend.txt'),
    REPORT_HEADER('MADGE — BACKEND DEPENDENCY ANALYSIS') +
      section('ENTRY POINT', `${BACKEND}/${entry}`) +
      section(`CIRCULAR DEPENDENCIES (${circular.length} cycle${circular.length === 1 ? '' : 's'})`,
        circular.length
          ? circular.map((cycle, i) => `${i + 1}. ${cycle.join(' -> ')} -> ${cycle[0]}`).join('\n')
          : 'None detected.') +
      section('MADGE CIRCULAR OUTPUT (raw)', (text.stdout + text.stderr).trim() || '(no output)') +
      section('DEPENDENCY SUMMARY (raw)', (summary.stdout + summary.stderr).trim() || '(no output)'),
  );
  log.record('madge (backend) circular', circular.length ? 'warn' : 'ok',
    `${circular.length} cycles`, circ.ms);

  const svgOut = path.join(DIRS.graphs, 'backend.svg');
  const svg = runNode([...common, '--image', svgOut], { cwd: BACKEND });
  if (svg.ok && exists(svgOut)) {
    log.ok('madge (backend) svg', 'analysis/graphs/backend.svg', svg.ms);
  } else {
    write(path.join(DIRS.graphs, 'backend.svg.SKIPPED.txt'),
      REPORT_HEADER('BACKEND SVG GRAPH — NOT GENERATED') +
      'Graphviz `dot` is required to render the madge SVG.\n' +
      `stderr:\n${svg.stderr || '(none)'}\n`);
    log.warn('madge (backend) svg', 'Graphviz dot unavailable', svg.ms);
  }
  return { circular, ok: true };
}

/**
 * The backend has no dependency-cruiser of its own, so we borrow the frontend's
 * binary and point it at the backend tree with --no-config (frontend rules encode
 * React/vite assumptions that don't apply here).
 */
function dependencyCruiserBackend(log) {
  if (!toolAvailable('depcruise')) {
    log.skip('dependency-cruiser (backend)', 'not installed');
    return { violations: [], modules: 0 };
  }
  const base = [TOOLS.depcruise, 'src', 'server.js', '--no-config'];

  const json = runNode([...base, '--output-type', 'json'], { cwd: BACKEND });
  let parsed = null;
  try {
    parsed = JSON.parse(json.stdout);
  } catch { /* handled below */ }

  if (parsed) {
    writeJson(path.join(DIRS.reports, 'dependency-report-backend.json'), parsed);
  } else {
    write(path.join(DIRS.reports, 'dependency-report-backend.json'),
      JSON.stringify({ error: 'dependency-cruiser produced no parsable JSON', stderr: json.stderr.slice(0, 4000) }, null, 2));
  }

  const html = runNode([...base, '--output-type', 'err-html'], { cwd: BACKEND });
  write(path.join(DIRS.reports, 'dependency-report-backend.html'),
    html.stdout || `<!doctype html><meta charset="utf-8"><title>Backend dependency report unavailable</title>
<body><h1>dependency-cruiser (backend) unavailable</h1><pre>${(html.stderr || 'no output').slice(0, 4000)}</pre>`);

  const violations = parsed?.summary?.violations ?? [];
  const modules = parsed?.summary?.totalCruised ?? 0;
  log.record('dependency-cruiser (backend)', violations.length ? 'warn' : 'ok',
    `${modules} modules cruised, ${violations.length} violations`, json.ms);
  return { violations, modules, summary: parsed?.summary ?? null };
}

/**
 * Step 5 — npm audit, report only.
 *
 * `npm audit` normally queries the registry advisory endpoint. This toolkit is
 * specified to run offline, so a network failure is an expected outcome, not an
 * error: we record it and move on. We never pass `--fix`, so package.json and
 * package-lock.json are never touched.
 */
function npmAudit(log) {
  const targets = [
    { name: 'frontend', cwd: FRONTEND },
    { name: 'backend', cwd: BACKEND },
  ].filter((t) => exists(path.join(t.cwd, 'package.json')));

  const blocks = [];
  const totals = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0, offline: false };

  for (const t of targets) {
    // --audit-level=none + no --fix: pure report.
    const res = runCmd('npm', ['audit', '--json'], { cwd: t.cwd });
    let parsed = null;
    try {
      parsed = JSON.parse(res.stdout);
    } catch { /* offline or npm error */ }

    if (parsed?.metadata?.vulnerabilities) {
      const v = parsed.metadata.vulnerabilities;
      for (const k of ['critical', 'high', 'moderate', 'low', 'info']) totals[k] += v[k] ?? 0;
      totals.total += v.total ?? Object.values(v).reduce((a, b) => a + b, 0);
      const advisories = Object.entries(parsed.vulnerabilities ?? {}).map(([name, info]) =>
        `  ${String(info.severity).toUpperCase().padEnd(9)} ${name}  (via ${[].concat(info.via ?? []).map((x) => (typeof x === 'string' ? x : x.title ?? x.name)).join(', ').slice(0, 90)})`);
      blocks.push(section(`${t.name.toUpperCase()} — npm audit`,
        `Vulnerabilities: critical=${v.critical ?? 0} high=${v.high ?? 0} moderate=${v.moderate ?? 0} low=${v.low ?? 0} info=${v.info ?? 0}\n` +
        `Dependencies audited: ${parsed.metadata.dependencies?.total ?? 'n/a'}\n\n` +
        (advisories.length ? advisories.join('\n') : '  No advisories.')));
    } else {
      totals.offline = true;
      blocks.push(section(`${t.name.toUpperCase()} — npm audit UNAVAILABLE`,
        'npm audit could not complete. This is expected when running fully offline:\n' +
        'the advisory database lives on the npm registry.\n\n' +
        `exit code: ${res.code}\n${(res.stderr || res.stdout || '(no output)').slice(0, 2000)}`));
    }
    log.record(`npm audit (${t.name})`, parsed ? 'ok' : 'warn',
      parsed ? `${parsed.metadata.vulnerabilities.total ?? 0} vulnerabilities` : 'offline / unavailable', res.ms);
  }

  write(path.join(DIRS.reports, 'audit-report.txt'),
    REPORT_HEADER('NPM AUDIT — REPORT ONLY (no --fix, lockfiles untouched)') +
      section('NOTE',
        'This toolkit never installs, updates or removes packages.\n' +
        '`npm audit fix` was NOT run. Remediation is left entirely to a human.') +
      blocks.join(''));
  return totals;
}

/** Step 17 — API endpoint report. */
function apiReport(log, api) {
  const { endpoints, unmounted, shadowed } = api;

  const byMethod = endpoints.reduce((a, e) => ({ ...a, [e.method]: (a[e.method] ?? 0) + 1 }), {});
  const unauthed = endpoints.filter((e) => !e.gates.length);
  const permGated = endpoints.filter((e) => e.gates.some((g) => g.type === 'permission'));
  const roleGated = endpoints.filter((e) => e.gates.some((g) => g.type === 'roles'));

  const describeGates = (gates) => {
    if (!gates.length) return '_none_';
    return gates.map((g) => {
      if (g.type === 'permission') return `perm:${g.module}.${g.action}`;
      if (g.type === 'roles') return `roles:${g.roles.join('/')}`;
      return 'verifyToken';
    }).join(', ');
  };

  const byModule = new Map();
  for (const e of endpoints) {
    byModule.set(e.module, (byModule.get(e.module) ?? 0) + 1);
  }

  const md = [
    h1('API Report'),
    stamp(),
    'Extracted statically from `router.<method>()` declarations and the `v1Router.use()`\n' +
    'mount table in `Pulse/backend/server.js`. Paths shown are the full mounted paths.\n' +
    '\n**Architecture note:** this backend has no controller/service/model split for most\n' +
    'modules — handlers are inline `async (req, res)` closures inside the route files,\n' +
    'querying `pg` directly. The "Controller" and "Service" columns the spec asks for are\n' +
    'therefore reported as the route file itself where no separate layer exists.\n',
    h2('Summary'),
    table(['Metric', 'Count'], [
      ['Total endpoints', endpoints.length],
      ['Route files mounted', new Set(endpoints.map((e) => e.file)).size],
      ['Route files NOT mounted (dead)', unmounted.length],
      ['GET', byMethod.GET ?? 0],
      ['POST', byMethod.POST ?? 0],
      ['PUT', byMethod.PUT ?? 0],
      ['DELETE', byMethod.DELETE ?? 0],
      ['PATCH', byMethod.PATCH ?? 0],
      ['Permission-gated', permGated.length],
      ['Role-gated', roleGated.length],
      ['No detectable auth gate', unauthed.length],
      ['Unreachable (shadowed by a param route)', shadowed.length],
    ]),
    h2('Endpoints per module'),
    table(['Module', 'Endpoints'],
      [...byModule.entries()].sort((a, b) => b[1] - a[1]).map(([m, c]) => [m, c])),
    h2('Unreachable endpoints'),
    'Express matches routes in declaration order. A literal path declared *after* a\n' +
    'same-prefix parameter route is never reached.\n\n' +
    (shadowed.length
      ? table(['Unreachable', 'Shadowed by', 'File'], shadowed.map((s) => [
        `\`${s.shadowed.method} ${s.shadowed.path}\` (line ${s.shadowed.line})`,
        `\`${s.by.method} ${s.by.path}\` (line ${s.by.line})`,
        s.shadowed.file,
      ]))
      : '_None detected._\n'),
    h2('Route files never mounted'),
    unmounted.length
      ? table(['File', 'Endpoints defined'], unmounted.map((u) => [`\`${u.file}\``, u.endpoints]))
      : '_None — every route file with endpoints is mounted._\n',
    h2('Endpoints with no detectable auth gate'),
    'These may still be protected by a gate applied at mount time or by a router-level\n' +
    '`router.use()`; this is a static scan, so verify before acting.\n\n' +
    (unauthed.length
      ? table(['Method', 'Path', 'File'], unauthed.slice(0, 200).map((e) => [e.method, `\`${e.path}\``, `${e.file}:${e.line}`]))
      : '_None._\n'),
    h2('Full endpoint list'),
    table(['Method', 'Path', 'Module', 'Auth / Permission', 'Handler (file:line)'],
      [...endpoints]
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
        .map((e) => [e.method, `\`${e.path}\``, e.module, describeGates(e.gates), `${e.file}:${e.line}`])),
  ].join('');

  write(path.join(DIRS.reports, 'api-report.md'), md);
  writeJson(path.join(DIRS.statistics, 'api-endpoints.json'), {
    generatedAt: new Date().toISOString(),
    total: endpoints.length,
    byMethod,
    unmountedFiles: unmounted,
    shadowed: shadowed.map((s) => ({ unreachable: `${s.shadowed.method} ${s.shadowed.path}`, blockedBy: `${s.by.method} ${s.by.path}`, file: s.shadowed.file })),
    endpoints,
  });
  log.record('api report', unmounted.length || shadowed.length ? 'warn' : 'ok',
    `${endpoints.length} endpoints, ${unmounted.length} dead files, ${shadowed.length} unreachable`);
  return { endpoints, byMethod, unauthed, unmounted, shadowed };
}

/** Entry point. */
export function runBackendAnalysis(log) {
  console.log('\n▸ Backend analysis');
  if (!exists(BACKEND_SRC)) {
    log.skip('backend analysis', `not found: ${BACKEND_SRC}`);
    return null;
  }
  const madge = madgeBackend(log);
  const depcruise = dependencyCruiserBackend(log);
  const audit = npmAudit(log);
  const api = buildApiSurface();
  const report = apiReport(log, api);
  return { madge, depcruise, audit, api: report };
}
