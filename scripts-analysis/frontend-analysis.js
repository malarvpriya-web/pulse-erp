/**
 * Manifest Analyzer — frontend analysis.
 *
 * Covers: madge graph + circular check (step 1), dependency-cruiser (step 2),
 * knip (step 3), eslint (step 4) and the React route report (step 16).
 *
 * Every tool invocation is read-only. ESLint runs WITHOUT --fix by design;
 * knip runs in report mode only. Nothing here writes outside analysis/.
 */
import path from 'node:path';
import {
  FRONTEND, FRONTEND_SRC, DIRS, TOOLS, toolAvailable, REPORT_HEADER,
} from './lib/config.js';
import { runNode } from './lib/exec.js';
import { write, writeJson, exists } from './lib/fsx.js';
import { buildRouteMap } from './lib/scan.js';
import { h1, h2, stamp, table, bulletList, section } from './lib/report.js';

/** Madge output is relative to the cwd we pass, so run it from frontend/. */
function madgeFrontend(log) {
  if (!toolAvailable('madge')) {
    log.skip('madge (frontend)', 'madge not installed at workspace root');
    return { circular: [], ok: false };
  }
  const entry = 'src/main.jsx';
  const common = [TOOLS.madge, entry, '--extensions', 'js,jsx,ts,tsx'];

  // 1a. Circular dependency check (JSON so we can score it later).
  const circ = runNode([...common, '--circular', '--json'], { cwd: FRONTEND });
  let circular = [];
  try {
    circular = JSON.parse(circ.stdout || '[]');
  } catch {
    circular = [];
  }

  // 1b. Human-readable text report.
  const text = runNode([...common, '--circular'], { cwd: FRONTEND });
  const summary = runNode([...common, '--summary'], { cwd: FRONTEND });
  write(
    path.join(DIRS.reports, 'madge-frontend.txt'),
    REPORT_HEADER('MADGE — FRONTEND DEPENDENCY ANALYSIS') +
      section('ENTRY POINT', `${FRONTEND}/${entry}`) +
      section(`CIRCULAR DEPENDENCIES (${circular.length} cycle${circular.length === 1 ? '' : 's'})`,
        circular.length
          ? circular.map((cycle, i) => `${i + 1}. ${cycle.join(' -> ')} -> ${cycle[0]}`).join('\n')
          : 'None detected.') +
      section('MADGE CIRCULAR OUTPUT (raw)', (text.stdout + text.stderr).trim() || '(no output)') +
      section('DEPENDENCY SUMMARY (raw)', (summary.stdout + summary.stderr).trim() || '(no output)'),
  );
  log.record('madge (frontend) circular', circular.length ? 'warn' : 'ok',
    `${circular.length} cycles`, circ.ms);

  // 1c. SVG graph — needs Graphviz `dot` on PATH; degrade to a note if absent.
  const svgOut = path.join(DIRS.graphs, 'frontend.svg');
  const svg = runNode([...common, '--image', svgOut], { cwd: FRONTEND });
  if (svg.ok && exists(svgOut)) {
    log.ok('madge (frontend) svg', 'analysis/graphs/frontend.svg', svg.ms);
  } else {
    write(path.join(DIRS.graphs, 'frontend.svg.SKIPPED.txt'),
      REPORT_HEADER('FRONTEND SVG GRAPH — NOT GENERATED') +
      'Graphviz `dot` is required to render the madge SVG.\n' +
      'Install Graphviz and re-run `npm run analyze`, or view the Mermaid\n' +
      'architecture diagrams in analysis/graphs/*.md instead.\n\n' +
      `stderr:\n${svg.stderr || '(none)'}\n`);
    log.warn('madge (frontend) svg', 'Graphviz dot unavailable — see frontend.svg.SKIPPED.txt', svg.ms);
  }
  return { circular, ok: true };
}

function dependencyCruiser(log) {
  if (!toolAvailable('depcruise')) {
    log.skip('dependency-cruiser', 'not installed in Pulse/frontend');
    return { violations: [], modules: 0 };
  }
  const config = path.join(FRONTEND, '.dependency-cruiser.cjs');
  const cfgArgs = exists(config) ? ['--config', config] : ['--no-config'];

  const json = runNode(
    [TOOLS.depcruise, 'src', '--output-type', 'json', ...cfgArgs],
    { cwd: FRONTEND },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(json.stdout);
  } catch { /* tool failed; handled below */ }

  if (parsed) {
    writeJson(path.join(DIRS.reports, 'dependency-report.json'), parsed);
  } else {
    write(path.join(DIRS.reports, 'dependency-report.json'),
      JSON.stringify({ error: 'dependency-cruiser produced no parsable JSON', stderr: json.stderr.slice(0, 4000) }, null, 2));
  }

  const html = runNode(
    [TOOLS.depcruise, 'src', '--output-type', 'err-html', ...cfgArgs],
    { cwd: FRONTEND },
  );
  write(path.join(DIRS.reports, 'dependency-report.html'),
    html.stdout || `<!doctype html><meta charset="utf-8"><title>Dependency report unavailable</title>
<body><h1>dependency-cruiser report unavailable</h1><pre>${(html.stderr || 'no output').slice(0, 4000)}</pre>`);

  const violations = parsed?.summary?.violations ?? [];
  const modules = parsed?.summary?.totalCruised ?? 0;
  log.record('dependency-cruiser', violations.length ? 'warn' : 'ok',
    `${modules} modules cruised, ${violations.length} violations`, json.ms);
  return { violations, modules, summary: parsed?.summary ?? null };
}

function knip(log) {
  if (!toolAvailable('knip')) {
    log.skip('knip', 'not installed in Pulse/frontend');
    return null;
  }
  // --no-exit-code: knip exits non-zero when it finds issues; findings are the
  // point here, not a failure. Reporter output is captured, never applied.
  const json = runNode([TOOLS.knip, '--reporter', 'json', '--no-exit-code'], { cwd: FRONTEND });
  let parsed = null;
  try {
    parsed = JSON.parse(json.stdout);
  } catch { /* fall through to text-only report */ }

  const text = runNode([TOOLS.knip, '--no-exit-code'], { cwd: FRONTEND });
  const counts = summariseKnip(parsed);

  write(path.join(DIRS.reports, 'knip-report.txt'),
    REPORT_HEADER('KNIP — UNUSED FILES, EXPORTS & DEPENDENCIES') +
      section('SUMMARY', counts
        ? Object.entries(counts).map(([k, v]) => `${String(k).padEnd(24)} ${v}`).join('\n')
        : '(knip JSON unavailable — see raw output below)') +
      section('RAW OUTPUT', (text.stdout + text.stderr).trim() || '(no output)'),
  );
  if (parsed) writeJson(path.join(DIRS.reports, 'knip-report.json'), parsed);
  log.ok('knip', counts ? `${counts['unused files'] ?? 0} unused files, ${counts['unused exports'] ?? 0} unused exports` : 'text report only', json.ms);
  return parsed;
}

/** knip's JSON reporter emits an array of {file, ...issue arrays}. Fold it into counts. */
function summariseKnip(parsed) {
  if (!parsed) return null;
  const issues = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
  const counts = {
    'unused files': 0, 'unused exports': 0, 'unused types': 0,
    'unused dependencies': 0, 'unused devDependencies': 0, 'duplicate exports': 0,
  };
  for (const entry of issues) {
    if (entry.files) counts['unused files'] += Array.isArray(entry.files) ? entry.files.length : 1;
    counts['unused exports'] += (entry.exports?.length ?? 0);
    counts['unused types'] += (entry.types?.length ?? 0);
    counts['unused dependencies'] += (entry.dependencies?.length ?? 0);
    counts['unused devDependencies'] += (entry.devDependencies?.length ?? 0);
    counts['duplicate exports'] += (entry.duplicates?.length ?? 0);
  }
  return counts;
}

function eslint(log) {
  if (!toolAvailable('eslint')) {
    log.skip('eslint', 'not installed in Pulse/frontend');
    return { errors: 0, warnings: 0, files: 0 };
  }
  // NOTE: no --fix. This toolkit reports; it never rewrites source.
  const json = runNode([TOOLS.eslint, '.', '--format', 'json'], { cwd: FRONTEND });
  let results = [];
  try {
    results = JSON.parse(json.stdout || '[]');
  } catch { /* handled below */ }

  const errors = results.reduce((n, r) => n + r.errorCount, 0);
  const warnings = results.reduce((n, r) => n + r.warningCount, 0);
  const withIssues = results.filter((r) => r.errorCount || r.warningCount);

  const byRule = new Map();
  for (const r of results) {
    for (const m of r.messages) {
      const key = m.ruleId ?? '(parse error)';
      const cur = byRule.get(key) ?? { rule: key, errors: 0, warnings: 0 };
      if (m.severity === 2) cur.errors++; else cur.warnings++;
      byRule.set(key, cur);
    }
  }
  const ranked = [...byRule.values()].sort((a, b) => (b.errors + b.warnings) - (a.errors + a.warnings));

  const detail = withIssues.map((r) => {
    const file = path.relative(FRONTEND, r.filePath);
    const lines = r.messages.map((m) =>
      `  ${String(m.line).padStart(5)}:${String(m.column).padEnd(4)} ${m.severity === 2 ? 'error  ' : 'warning'} ${m.message}  ${m.ruleId ?? ''}`);
    return `${file}\n${lines.join('\n')}`;
  }).join('\n\n');

  write(path.join(DIRS.reports, 'eslint-report.txt'),
    REPORT_HEADER('ESLINT — FRONTEND (report only, --fix NEVER used)') +
      section('TOTALS', `Files linted:        ${results.length}\nFiles with issues:   ${withIssues.length}\nErrors:              ${errors}\nWarnings:            ${warnings}`) +
      section('TOP RULES', ranked.length
        ? ranked.slice(0, 30).map((r) => `${String(r.errors + r.warnings).padStart(6)}  ${r.rule} (${r.errors} err / ${r.warnings} warn)`).join('\n')
        : 'No rule violations.') +
      section('DETAIL', detail || 'No issues.') +
      (json.stderr ? section('STDERR', json.stderr.slice(0, 4000)) : ''),
  );
  log.record('eslint (frontend)', errors ? 'warn' : 'ok', `${errors} errors, ${warnings} warnings`, json.ms);
  return { errors, warnings, files: results.length, rules: ranked };
}

/** Step 16 — React route report. */
function routeReport(log) {
  const rm = buildRouteMap();
  const md = [
    h1('Route Report'),
    stamp(),
    `Source of truth: \`${rm.file ?? 'frontend/src/config/routes.jsx'}\`\n`,
    '\nThis app does not use `<Route>` elements. `ROUTES` maps a **page key** to a lazy-loaded\n' +
    'component, and `NAV_ITEMS` (the sidebar) references those keys. So:\n' +
    '- **Missing route** = the sidebar points at a page key that `ROUTES` does not define (dead menu entry).\n' +
    '- **Unused route** = `ROUTES` defines a page that no sidebar entry reaches (may still be opened programmatically via `setPage`).\n',
    h2('Summary'),
    table(['Metric', 'Count'], [
      ['Routes defined', rm.routes.length],
      ['Lazy-loaded routes', rm.routes.filter((r) => r.lazy).length],
      ['Eagerly-loaded routes', rm.routes.filter((r) => !r.lazy).length],
      ['Sidebar page references', rm.navPages.length],
      ['Sidebar modules (role-gated)', rm.navModules.length],
      ['Missing routes (sidebar → nowhere)', rm.missing.length],
      ['Unused routes (not in sidebar)', rm.unused.length],
      ['Broken imports (target file absent)', rm.broken.length],
    ]),
    h2('Missing routes'),
    rm.missing.length
      ? table(['Sidebar page key', 'Problem'], rm.missing.map((k) => [k, 'No entry in ROUTES — menu item cannot render']))
      : '_None — every sidebar entry resolves to a defined route._\n',
    h2('Broken imports'),
    rm.broken.length
      ? table(['Page key', 'Import path'], rm.broken.map((r) => [r.key, `\`${r.importPath}\``]))
      : '_None — every route import resolves to a real file._\n',
    h2('Role-based / protected routes'),
    'Route protection is applied by module, not per-route. Sidebar sections carry a\n' +
    '`module:` key which is checked against the user\'s menu permissions.\n\n' +
    bulletList(rm.navModules.map((m) => `\`${m}\``)),
    h2('Unused routes'),
    rm.unused.length
      ? table(['Page key', 'Component'], rm.unused.map((k) => {
        const r = rm.routes.find((x) => x.key === k);
        return [k, `\`${r?.importPath ?? '?'}\``];
      }))
      : '_None._\n',
    h2('All routes'),
    table(['Page key', 'Lazy', 'In sidebar', 'Import'], rm.routes.map((r) => [
      r.key,
      r.lazy ? 'yes' : 'no',
      rm.navPages.includes(r.key) ? 'yes' : 'no',
      `\`${r.importPath}\``,
    ])),
  ].join('');
  write(path.join(DIRS.reports, 'route-report.md'), md);
  log.record('route report', rm.missing.length ? 'warn' : 'ok',
    `${rm.routes.length} routes, ${rm.missing.length} missing, ${rm.unused.length} unused`);
  return rm;
}

/** Entry point — returns the facts later steps (health, dashboard) consume. */
export function runFrontendAnalysis(log) {
  console.log('\n▸ Frontend analysis');
  if (!exists(FRONTEND_SRC)) {
    log.skip('frontend analysis', `not found: ${FRONTEND_SRC}`);
    return null;
  }
  const madge = madgeFrontend(log);
  const depcruise = dependencyCruiser(log);
  const knipResult = knip(log);
  const lint = eslint(log);
  const routes = routeReport(log);
  return { madge, depcruise, knip: knipResult, knipCounts: summariseKnip(knipResult), lint, routes };
}
