/**
 * Manifest Analyzer — steps 13, 14, 15.
 * Dead code, duplicates and TODO reports.
 *
 * REPORTING ONLY. Nothing here deletes, rewrites or "fixes" anything.
 */
import path from 'node:path';
import { DIRS } from './config.js';
import { write, writeJson } from './fsx.js';
import { scanTodos, scanExports, fingerprint, importGraph } from './scan.js';
import { h1, h2, stamp, table, bulletList } from './report.js';

/**
 * Step 13 — dead code.
 *
 * Two independent signals, deliberately kept separate:
 *  1. knip's own findings (frontend only — it is configured there).
 *  2. Our internal-import reachability walk from the real entry points, which
 *     also covers the backend and catches files knip's config scope misses.
 *
 * Both are heuristics. Dynamic `import()` by computed string, and files loaded
 * only via config, will look unreachable but aren't — hence the caveats section.
 */
export function generateDeadCodeReport(sources, knipCounts, knipRaw, api, routes) {
  const graph = importGraph(sources.all);
  const byRel = new Map(sources.all.map((s) => [s.rel, s]));

  // Entry points: what the runtime actually starts from.
  const entries = new Set();
  for (const s of sources.all) {
    const r = s.rel;
    if (/frontend\/src\/main\.jsx$/.test(r)) entries.add(r);
    if (/frontend\/src\/App\.jsx$/.test(r)) entries.add(r);
    if (/backend\/server\.js$/.test(r)) entries.add(r);
    if (s.kind === 'test') entries.add(r); // tests are roots, not dead code
    if (s.kind === 'route') entries.add(r); // mounted dynamically in server.js
  }
  // Routes are reached via lazy() imports inside routes.jsx — treat targets as roots.
  for (const r of routes?.routes ?? []) if (r.resolved) entries.add(r.resolved);

  const reachable = new Set();
  const stack = [...entries];
  while (stack.length) {
    const cur = stack.pop();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const dep of graph.get(cur) ?? []) if (!reachable.has(dep)) stack.push(dep);
  }

  // Migrations and seeds (kind === 'database') are loaded by the migration runner's
  // directory scan, never via import — so they are never in the import graph and would
  // otherwise dominate this report as false positives. Exclude them by construction.
  const analysable = sources.all.filter(
    (s) => ['js', 'jsx', 'ts', 'tsx'].includes(s.ext) && s.kind !== 'database',
  );
  const unreachable = analysable.filter((s) => !reachable.has(s.rel));

  const group = (kind) => unreachable.filter((s) => s.kind === kind);
  const fmt = (list) => list.map((s) => [`\`${s.rel}\``, s.side, s.module ?? '(core)', s.lines]);

  // knip's unused exports, flattened for display.
  const knipIssues = Array.isArray(knipRaw) ? knipRaw : (knipRaw?.issues ?? []);
  const unusedExports = [];
  const unusedFiles = [];
  const unusedDeps = [];
  for (const entry of knipIssues) {
    if (entry.files) unusedFiles.push(...[].concat(entry.files));
    for (const e of entry.exports ?? []) unusedExports.push({ file: entry.file, name: e.name ?? e, line: e.line ?? '' });
    for (const d of entry.dependencies ?? []) unusedDeps.push({ file: entry.file, name: d.name ?? d, type: 'dependency' });
    for (const d of entry.devDependencies ?? []) unusedDeps.push({ file: entry.file, name: d.name ?? d, type: 'devDependency' });
  }

  const md = [
    h1('Dead Code Report'),
    stamp(),
    '> **Nothing in this report has been deleted.** It is a list of candidates for a\n' +
    '> human to review. Verify each one before acting.\n',
    h2('How to read this'),
    'Two independent detectors are reported separately because they disagree in useful ways:\n\n' +
    '1. **Reachability walk** (this toolkit) — follows internal `import`/`require`/`@/` edges\n' +
    '   from the real entry points (`main.jsx`, `App.jsx`, `server.js`), plus every `lazy()`\n' +
    '   route target, every backend route file, and every test file, as roots.\n' +
    '2. **knip** — configured for the frontend workspace only.\n\n' +
    '**Known blind spots — a file here is not automatically dead:**\n' +
    '- Files imported by a computed/dynamic specifier (`import(`@/x/${name}`)`).\n' +
    '- Files referenced only from config, docs, scripts or migrations.\n' +
    '- Backend route files are treated as reachable by definition; the API report is the\n' +
    '  authority on which are actually *mounted* (see "Route files never mounted" there).\n' +
    '- **Migrations and seeds are excluded entirely** — the migration runner loads them by\n' +
    '  scanning their directory, so they are never in the import graph and are not dead.\n',
    h2('Summary'),
    table(['Signal', 'Count'], [
      ['Unreachable files (reachability walk)', unreachable.length],
      ['— frontend', unreachable.filter((s) => s.side === 'frontend').length],
      ['— backend', unreachable.filter((s) => s.side === 'backend').length],
      ['Dead lines of code (approx.)', unreachable.reduce((n, s) => n + s.lines, 0)],
      ['knip: unused files', knipCounts?.['unused files'] ?? 'n/a'],
      ['knip: unused exports', knipCounts?.['unused exports'] ?? 'n/a'],
      ['knip: unused dependencies', knipCounts?.['unused dependencies'] ?? 'n/a'],
      ['knip: duplicate exports', knipCounts?.['duplicate exports'] ?? 'n/a'],
      ['Backend route files never mounted', api?.unmounted?.length ?? 0],
      ['Frontend routes not in sidebar', routes?.unused?.length ?? 0],
    ]),
    h2('Unused components'),
    table(['File', 'Side', 'Module', 'Lines'], fmt(group('component'))),
    h2('Unused pages'),
    table(['File', 'Side', 'Module', 'Lines'], fmt(group('page'))),
    h2('Unused hooks'),
    table(['File', 'Side', 'Module', 'Lines'], fmt(group('hook'))),
    h2('Unused services'),
    table(['File', 'Side', 'Module', 'Lines'], fmt(group('service'))),
    h2('Unused utilities'),
    table(['File', 'Side', 'Module', 'Lines'], fmt(group('utility'))),
    h2('Other unreachable files'),
    table(['File', 'Side', 'Kind', 'Lines'],
      unreachable.filter((s) => !['component', 'page', 'hook', 'service', 'utility'].includes(s.kind))
        .map((s) => [`\`${s.rel}\``, s.side, s.kind, s.lines])),
    h2('knip — unused exports'),
    unusedExports.length
      ? table(['File', 'Export', 'Line'], unusedExports.slice(0, 300).map((e) => [`\`${e.file}\``, e.name, e.line]))
      : '_None reported._\n',
    h2('knip — unused dependencies'),
    unusedDeps.length
      ? table(['Package', 'Type', 'Declared in'], unusedDeps.map((d) => [`\`${d.name}\``, d.type, `\`${d.file}\``]))
      : '_None reported._\n',
    h2('Backend route files never mounted'),
    (api?.unmounted?.length
      ? table(['File', 'Endpoints defined'], api.unmounted.map((u) => [`\`${u.file}\``, u.endpoints]))
      : '_None._\n'),
  ].join('');

  write(path.join(DIRS.reports, 'dead-code-report.md'), md);
  writeJson(path.join(DIRS.statistics, 'dead-code.json'), {
    generatedAt: new Date().toISOString(),
    note: 'Report only. Nothing was deleted.',
    unreachableCount: unreachable.length,
    unreachable: unreachable.map((s) => ({ file: s.rel, side: s.side, kind: s.kind, module: s.module, lines: s.lines })),
    knip: { unusedExports, unusedFiles, unusedDeps },
  });
  return { unreachable, reachable, unusedExports, unusedDeps };
}

/** Step 14 — duplicate detection. */
export function generateDuplicateReport(sources, api) {
  // 14a. Identical file bodies (comments/whitespace normalised out).
  const byHash = new Map();
  for (const s of sources.all) {
    if (!['js', 'jsx', 'ts', 'tsx', 'css'].includes(s.ext)) continue;
    const fp = fingerprint(s.file);
    if (!fp) continue;
    const key = fp.hash;
    if (!byHash.has(key)) byHash.set(key, { size: fp.size, files: [] });
    byHash.get(key).files.push(s);
  }
  const identical = [...byHash.values()].filter((g) => g.files.length > 1)
    .sort((a, b) => b.size - a.size);

  // 14b. Same basename in different places — the classic "two DeliveryTracker.jsx" trap.
  const byName = new Map();
  for (const s of sources.all) {
    if (!['js', 'jsx', 'ts', 'tsx'].includes(s.ext)) continue;
    const base = path.basename(s.rel);
    if (/^(index|main)\./.test(base)) continue;
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(s);
  }
  const sameName = [...byName.entries()].filter(([, list]) => list.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  // 14c. The same export name declared in multiple files.
  const exportOwners = new Map();
  for (const s of sources.all) {
    if (!['js', 'jsx', 'ts', 'tsx'].includes(s.ext)) continue;
    if (s.kind === 'test') continue;
    for (const name of scanExports(s.file)) {
      if (!exportOwners.has(name)) exportOwners.set(name, []);
      exportOwners.get(name).push(s.rel);
    }
  }
  const dupExports = [...exportOwners.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files.length - a.files.length);

  // 14d. The same METHOD + PATH served by more than one handler.
  const epKey = new Map();
  for (const e of api.endpoints) {
    const key = `${e.method} ${e.path}`;
    if (!epKey.has(key)) epKey.set(key, []);
    epKey.get(key).push(`${e.file}:${e.line}`);
  }
  const dupApis = [...epKey.entries()].filter(([, v]) => v.length > 1)
    .map(([key, files]) => ({ key, files }));

  const isUtil = (s) => ['utility', 'service'].includes(s.kind);
  const isComponent = (s) => ['component', 'page'].includes(s.kind);
  const cssDupes = identical.filter((g) => g.files.every((f) => f.ext === 'css'));

  const md = [
    h1('Duplicate Report'),
    stamp(),
    '> Report only — no file was merged, renamed or deleted.\n',
    h2('How duplicates are detected'),
    '- **Identical bodies** — file content with comments and whitespace stripped, then hashed.\n' +
    '  Files under ~200 normalised characters are ignored (barrels and stubs collide trivially).\n' +
    '- **Same basename** — same filename in different directories. Often intentional\n' +
    '  (`index.js`, per-module `constants.js`), but it is also how two different components\n' +
    '  end up sharing a name and getting imported by mistake.\n' +
    '- **Duplicate exports** — the same exported identifier declared in more than one file.\n' +
    '- **Duplicate APIs** — the same METHOD + path registered by more than one handler.\n' +
    '  Express serves the **first** match, so later ones are silently unreachable.\n',
    h2('Summary'),
    table(['Kind', 'Count'], [
      ['Groups of byte-identical files', identical.length],
      ['— duplicate components / pages', identical.filter((g) => g.files.every(isComponent)).length],
      ['— duplicate utilities / services', identical.filter((g) => g.files.every(isUtil)).length],
      ['— duplicate CSS', cssDupes.length],
      ['Repeated basenames', sameName.length],
      ['Duplicate export names', dupExports.length],
      ['Duplicate API routes', dupApis.length],
    ]),
    h2('Byte-identical files'),
    identical.length
      ? identical.slice(0, 60).map((g) =>
        `**${g.files.length} copies** (~${g.size} chars each)\n${bulletList(g.files.map((f) => `\`${f.rel}\``))}`).join('\n')
      : '_None found._\n',
    h2('Duplicate APIs (same method + path)'),
    dupApis.length
      ? table(['Endpoint', 'Registered in'], dupApis.map((d) => [`\`${d.key}\``, d.files.map((f) => `\`${f}\``).join('<br>')]))
      : '_None._\n',
    h2('Duplicate export names'),
    dupExports.length
      ? table(['Export', 'Declared in'], dupExports.slice(0, 120).map((d) => [
        `\`${d.name}\``, d.files.map((f) => `\`${f}\``).join('<br>')]))
      : '_None._\n',
    h2('Repeated basenames'),
    sameName.length
      ? table(['Filename', 'Copies', 'Paths'], sameName.slice(0, 120).map(([name, list]) => [
        `\`${name}\``, list.length, list.map((s) => `\`${s.rel}\``).join('<br>')]))
      : '_None._\n',
  ].join('');

  write(path.join(DIRS.reports, 'duplicate-report.md'), md);
  writeJson(path.join(DIRS.statistics, 'duplicates.json'), {
    generatedAt: new Date().toISOString(),
    identicalGroups: identical.map((g) => ({ size: g.size, files: g.files.map((f) => f.rel) })),
    duplicateExports: dupExports,
    duplicateApis: dupApis,
    repeatedBasenames: sameName.map(([name, list]) => ({ name, files: list.map((s) => s.rel) })),
  });
  return { identical, dupExports, dupApis, sameName };
}

/** Step 15 — TODO / FIXME / HACK / XXX report. */
export function generateTodoReport(sources) {
  const todos = scanTodos(sources.all);
  const byTag = todos.reduce((a, t) => ({ ...a, [t.tag]: (a[t.tag] ?? 0) + 1 }), {});
  const byModule = todos.reduce((a, t) => {
    const k = t.module ?? '(core)';
    return { ...a, [k]: (a[k] ?? 0) + 1 };
  }, {});

  // FIXME/HACK/BUG/XXX mark known-broken code; TODO is usually just a wish.
  const urgent = todos.filter((t) => ['FIXME', 'HACK', 'XXX', 'BUG'].includes(t.tag));

  const md = [
    h1('TODO Report'),
    stamp(),
    `Scanned ${sources.all.length} source files for \`TODO\`, \`FIXME\`, \`HACK\`, \`XXX\`, \`BUG\` and \`DEPRECATED\` markers.\n`,
    h2('Summary'),
    table(['Tag', 'Count'], Object.entries(byTag).sort((a, b) => b[1] - a[1])),
    `\n**${urgent.length}** of ${todos.length} markers are \`FIXME\`/\`HACK\`/\`XXX\`/\`BUG\` — these flag code the\n` +
    'author knew was wrong, so they carry more weight than a plain `TODO`.\n',
    h2('Markers per module'),
    table(['Module', 'Markers'], Object.entries(byModule).sort((a, b) => b[1] - a[1]).map(([m, c]) => [m, c])),
    h2('Needs attention first (FIXME / HACK / XXX / BUG)'),
    urgent.length
      ? table(['Tag', 'Note', 'Location'], urgent.map((t) => [t.tag, t.text || '_(no text)_', `\`${t.file}:${t.line}\``]))
      : '_None._\n',
    h2('All markers'),
    table(['Tag', 'Note', 'Location', 'Side'],
      todos.map((t) => [t.tag, t.text || '_(no text)_', `\`${t.file}:${t.line}\``, t.side])),
  ].join('');

  write(path.join(DIRS.reports, 'todo-report.md'), md);
  writeJson(path.join(DIRS.statistics, 'todos.json'), {
    generatedAt: new Date().toISOString(),
    total: todos.length,
    urgent: urgent.length,
    byTag,
    byModule,
    todos,
  });
  return { todos, byTag, urgent };
}
