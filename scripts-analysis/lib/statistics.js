/**
 * Manifest Analyzer — steps 6, 7 and 12.
 * Project statistics, per-module statistics and the dependency heatmap.
 */
import path from 'node:path';
import { DIRS, FRONTEND, BACKEND, ROOT, detectModules } from './config.js';
import { writeJson, write, readJsonSafe } from './fsx.js';
import { walk, extKind, importGraph } from './scan.js';
import { h1, h2, stamp, table, bar } from './report.js';

const countBy = (items, pred) => items.filter(pred).length;

function packageCounts() {
  const read = (dir) => readJsonSafe(path.join(dir, 'package.json'), {}) ?? {};
  const fe = read(FRONTEND);
  const be = read(BACKEND);
  const root = read(ROOT);
  const n = (o) => Object.keys(o ?? {}).length;
  const all = new Set([
    ...Object.keys(fe.dependencies ?? {}), ...Object.keys(fe.devDependencies ?? {}),
    ...Object.keys(be.dependencies ?? {}), ...Object.keys(be.devDependencies ?? {}),
    ...Object.keys(root.dependencies ?? {}), ...Object.keys(root.devDependencies ?? {}),
  ]);
  return {
    frontend: { dependencies: n(fe.dependencies), devDependencies: n(fe.devDependencies) },
    backend: { dependencies: n(be.dependencies), devDependencies: n(be.devDependencies) },
    workspaceRoot: { dependencies: n(root.dependencies), devDependencies: n(root.devDependencies) },
    uniquePackagesDeclared: all.size,
    total:
      n(fe.dependencies) + n(fe.devDependencies) +
      n(be.dependencies) + n(be.devDependencies) +
      n(root.dependencies) + n(root.devDependencies),
  };
}

/** Step 6 — project-wide statistics. */
export function generateProjectStatistics(sources, api, routes) {
  const { frontend, backend, all } = sources;
  const fileExts = all.map((s) => s.ext);
  const assets = walk(path.join(FRONTEND, 'public')).concat(walk(path.join(FRONTEND, 'src', 'assets')));

  const stats = {
    generatedAt: new Date().toISOString(),
    generator: 'Manifest Analyzer v1.0',
    readOnly: true,
    totals: {
      sourceFiles: all.length,
      linesOfCode: all.reduce((n, s) => n + s.lines, 0),
      jsFiles: countBy(fileExts, (e) => e === 'js'),
      jsxFiles: countBy(fileExts, (e) => e === 'jsx'),
      tsFiles: countBy(fileExts, (e) => e === 'ts'),
      tsxFiles: countBy(fileExts, (e) => e === 'tsx'),
      cssFiles: countBy(fileExts, (e) => e === 'css'),
      images: assets.filter((f) => extKind(f) === 'image').length,
      apiEndpoints: api.endpoints.length,
      npmPackages: packageCounts().total,
    },
    frontend: {
      totalFiles: frontend.length,
      linesOfCode: frontend.reduce((n, s) => n + s.lines, 0),
      components: countBy(frontend, (s) => s.kind === 'component'),
      pages: countBy(frontend, (s) => s.kind === 'page'),
      hooks: countBy(frontend, (s) => s.kind === 'hook'),
      services: countBy(frontend, (s) => s.kind === 'service'),
      utilities: countBy(frontend, (s) => s.kind === 'utility'),
      contexts: countBy(frontend, (s) => s.kind === 'context'),
      stores: countBy(frontend, (s) => s.kind === 'store'),
      configs: countBy(frontend, (s) => s.kind === 'config'),
      styles: countBy(frontend, (s) => s.kind === 'style'),
      tests: countBy(frontend, (s) => s.kind === 'test'),
      routesDefined: routes?.routes.length ?? 0,
      lazyRoutes: routes?.routes.filter((r) => r.lazy).length ?? 0,
    },
    backend: {
      totalFiles: backend.length,
      linesOfCode: backend.reduce((n, s) => n + s.lines, 0),
      routes: countBy(backend, (s) => s.kind === 'route'),
      controllers: countBy(backend, (s) => s.kind === 'controller'),
      services: countBy(backend, (s) => s.kind === 'service'),
      models: countBy(backend, (s) => s.kind === 'model'),
      middleware: countBy(backend, (s) => s.kind === 'middleware'),
      utilities: countBy(backend, (s) => s.kind === 'utility'),
      database: countBy(backend, (s) => s.kind === 'database'),
      jobs: countBy(backend, (s) => s.kind === 'job'),
      configs: countBy(backend, (s) => s.kind === 'config'),
      tests: countBy(backend, (s) => s.kind === 'test'),
      endpoints: api.endpoints.length,
      endpointsByMethod: api.byMethod,
    },
    packages: packageCounts(),
  };
  writeJson(path.join(DIRS.statistics, 'project-statistics.json'), stats);
  return stats;
}

/** Step 7 — per-module statistics. */
export function generateModuleStatistics(sources, api) {
  const modules = detectModules();
  const endpointsByModule = api.endpoints.reduce((acc, e) => {
    acc[e.module] = (acc[e.module] ?? 0) + 1;
    return acc;
  }, {});

  const rows = modules.map((mod) => {
    const fe = sources.frontend.filter((s) => s.module === mod.slug);
    const be = sources.backend.filter((s) => s.module === mod.slug);
    return {
      module: mod.label,
      slug: mod.slug,
      hasFrontend: mod.frontend,
      hasBackend: mod.backend,
      pages: countBy(fe, (s) => s.kind === 'page'),
      components: countBy(fe, (s) => s.kind === 'component'),
      hooks: countBy(fe, (s) => s.kind === 'hook'),
      services: countBy(fe, (s) => s.kind === 'service') + countBy(be, (s) => s.kind === 'service'),
      utilities: countBy(fe, (s) => s.kind === 'utility') + countBy(be, (s) => s.kind === 'utility'),
      apis: endpointsByModule[mod.slug] ?? 0,
      routeFiles: countBy(be, (s) => s.kind === 'route'),
      frontendFiles: fe.length,
      backendFiles: be.length,
      totalFiles: fe.length + be.length,
      linesOfCode: [...fe, ...be].reduce((n, s) => n + s.lines, 0),
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    detection: 'union of Pulse/frontend/src/features/* and Pulse/backend/src/modules/*',
    moduleCount: rows.length,
    modules: rows.sort((a, b) => b.totalFiles - a.totalFiles),
  };
  writeJson(path.join(DIRS.statistics, 'module-statistics.json'), payload);
  return payload;
}

/**
 * Step 12 — dependency heatmap.
 * Ranks modules by how many internal imports they pull in (fan-out) and how many
 * other files import them (fan-in). High fan-in = a change there ripples widely.
 */
export function generateHeatmap(sources, moduleStats) {
  const graph = importGraph(sources.all);
  const byRel = new Map(sources.all.map((s) => [s.rel, s]));

  const fanOut = new Map();
  const fanIn = new Map();
  const crossModule = new Map();

  for (const [from, deps] of graph) {
    const fromMod = byRel.get(from)?.module ?? '(core)';
    fanOut.set(fromMod, (fanOut.get(fromMod) ?? 0) + deps.length);
    for (const to of deps) {
      const toMod = byRel.get(to)?.module ?? '(core)';
      fanIn.set(toMod, (fanIn.get(toMod) ?? 0) + 1);
      if (toMod !== fromMod) {
        const key = `${fromMod} -> ${toMod}`;
        crossModule.set(key, (crossModule.get(key) ?? 0) + 1);
      }
    }
  }

  const names = [...new Set([...fanOut.keys(), ...fanIn.keys()])];
  const rows = names.map((name) => ({
    module: name,
    fanOut: fanOut.get(name) ?? 0,
    fanIn: fanIn.get(name) ?? 0,
    coupling: (fanOut.get(name) ?? 0) + (fanIn.get(name) ?? 0),
  })).sort((a, b) => b.coupling - a.coupling);

  const maxOut = Math.max(1, ...rows.map((r) => r.fanOut));
  const maxIn = Math.max(1, ...rows.map((r) => r.fanIn));

  const label = (slug) =>
    moduleStats.modules.find((m) => m.slug === slug)?.module ?? slug;

  const md = [
    h1('Dependency Heatmap'),
    stamp(),
    'Modules ranked by internal import coupling.\n\n' +
    '- **Fan-out** — imports this module makes into other files. High fan-out means the module depends on a lot.\n' +
    '- **Fan-in** — imports *other* files make into this module. High fan-in means a change here ripples widely.\n' +
    '- `(core)` covers shared, non-module code (`pages/`, `components/`, `utils/`, `server.js`, …).\n',
    h2('Fan-out — modules that depend on the most'),
    `\`\`\`\n${rows.filter((r) => r.fanOut > 0).slice(0, 30)
      .map((r) => `${label(r.module).padEnd(22)} ${bar(r.fanOut, maxOut).padEnd(26)} ${r.fanOut}`)
      .join('\n')}\n\`\`\`\n`,
    h2('Fan-in — modules most depended upon'),
    `\`\`\`\n${[...rows].sort((a, b) => b.fanIn - a.fanIn).filter((r) => r.fanIn > 0).slice(0, 30)
      .map((r) => `${label(r.module).padEnd(22)} ${bar(r.fanIn, maxIn).padEnd(26)} ${r.fanIn}`)
      .join('\n')}\n\`\`\`\n`,
    h2('Full coupling table'),
    table(['Module', 'Fan-out', 'Fan-in', 'Total coupling'],
      rows.map((r) => [label(r.module), r.fanOut, r.fanIn, r.coupling])),
    h2('Heaviest cross-module edges'),
    'Direct imports that cross a module boundary. These are the seams that make modules\n' +
    'hard to extract or test in isolation.\n\n' +
    table(['Edge', 'Imports'],
      [...crossModule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
        .map(([edge, n]) => [`\`${edge}\``, n])),
  ].join('');

  write(path.join(DIRS.reports, 'dependency-heatmap.md'), md);
  writeJson(path.join(DIRS.statistics, 'dependency-heatmap.json'), {
    generatedAt: new Date().toISOString(),
    modules: rows,
    crossModuleEdges: [...crossModule.entries()].map(([edge, count]) => ({ edge, count }))
      .sort((a, b) => b.count - a.count),
  });
  return { rows, crossModule, graph };
}
