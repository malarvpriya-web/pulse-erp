/**
 * Manifest Analyzer — step 18. Self-contained interactive dashboard.
 *
 * Produces analysis/index.html: one offline HTML file, no external requests,
 * light/dark aware, responsive. All data is inlined as JSON at build time.
 */
import path from 'node:path';
import { DIRS } from './config.js';
import { write } from './fsx.js';
import { escapeHtml, ratingClass, rating } from './report.js';

export function generateDashboard(ctx) {
  const { stats, api, moduleStats, health, dead, duplicates, todos, routes, frontend, backend, heatmap, runLog } = ctx;

  const scoreCards = [
    ['Architecture', health.scores.architecture.score],
    ['Maintainability', health.scores.maintainability.score],
    ['Complexity', health.scores.complexity.score],
    ['Dependency', health.scores.dependencies.score],
    ['Unused Code', health.scores.unusedCode.score],
    ['Documentation', health.scores.documentation.score],
    ['Security', health.scores.security.score],
    ['Testing', health.scores.testing.score],
  ];

  const heatRows = heatmap.rows.slice(0, 15).map((r) => ({
    module: moduleStats.modules.find((m) => m.slug === r.module)?.module ?? r.module,
    fanOut: r.fanOut, fanIn: r.fanIn, coupling: r.coupling,
  }));
  const maxCoupling = Math.max(1, ...heatRows.map((r) => r.coupling));

  const data = {
    generatedAt: new Date().toISOString(),
    health, stats, api: { total: api.endpoints.length, byMethod: api.byMethod, unmounted: api.unmounted.length, shadowed: api.shadowed.length },
    modules: moduleStats.modules,
    heatRows, maxCoupling,
    dead: { unreachable: dead.unreachable.length, unusedDeps: dead.unusedDeps?.length ?? 0 },
    duplicates: { identical: duplicates.identical.length, dupApis: duplicates.dupApis.length, dupExports: duplicates.dupExports.length },
    todos: { total: todos.todos.length, urgent: todos.urgent.length, byTag: todos.byTag },
    routes: { total: routes?.routes.length ?? 0, missing: routes?.missing.length ?? 0, unused: routes?.unused.length ?? 0 },
    circular: { frontend: frontend?.madge?.circular?.length ?? 0, backend: backend?.madge?.circular?.length ?? 0 },
    runLog: runLog?.entries ?? [],
  };

  const reportLinks = [
    ['Health Report', 'reports/project-health.md'],
    ['AI Summary', 'summary/ai-summary.md'],
    ['API Report', 'reports/api-report.md'],
    ['Route Report', 'reports/route-report.md'],
    ['Dead Code', 'reports/dead-code-report.md'],
    ['Duplicates', 'reports/duplicate-report.md'],
    ['TODOs', 'reports/todo-report.md'],
    ['Dependency Heatmap', 'reports/dependency-heatmap.md'],
    ['madge (frontend)', 'reports/madge-frontend.txt'],
    ['madge (backend)', 'reports/madge-backend.txt'],
    ['ESLint', 'reports/eslint-report.txt'],
    ['knip', 'reports/knip-report.txt'],
    ['npm audit', 'reports/audit-report.txt'],
    ['Dependency graph (HTML)', 'reports/dependency-report.html'],
  ];
  const docLinks = [
    ['Architecture', 'documentation/Architecture.md'],
    ['Frontend', 'documentation/Frontend.md'],
    ['Backend', 'documentation/Backend.md'],
    ['Modules', 'documentation/Modules.md'],
    ['Folder Structure', 'documentation/FolderStructure.md'],
    ['Coding Patterns', 'documentation/CodingPatterns.md'],
    ['Services', 'documentation/Services.md'],
    ['APIs', 'documentation/APIs.md'],
  ];
  const diagramLinks = [
    ['Frontend Architecture', 'graphs/frontend-architecture.md'],
    ['Backend Architecture', 'graphs/backend-architecture.md'],
    ['Module Dependencies', 'graphs/module-dependency-graph.md'],
    ['API Flow', 'graphs/api-flow.md'],
    ['Folder Structure', 'graphs/folder-structure.md'],
  ];

  const html = renderHtml({ data, scoreCards, reportLinks, docLinks, diagramLinks });
  write(path.join(DIRS.root, 'index.html'), html);
}

function linkList(links) {
  return links.map(([label, href]) =>
    `<a class="link" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`).join('');
}

function renderHtml({ data, scoreCards, reportLinks, docLinks, diagramLinks }) {
  const t = data.stats.totals;
  const overallClass = ratingClass(data.health.overall);

  const scoreCardHtml = scoreCards.map(([name, score]) => {
    if (score == null) return `<div class="score-card excluded"><div class="score-name">${name}</div><div class="score-val">n/a</div><div class="score-rating">excluded</div></div>`;
    const cls = ratingClass(score);
    return `<div class="score-card ${cls}">
      <div class="score-name">${name}</div>
      <div class="score-val">${score}</div>
      <div class="meter"><span style="width:${score}%"></span></div>
      <div class="score-rating">${rating(score)}</div>
    </div>`;
  }).join('');

  const statCard = (label, value, sub = '') =>
    `<div class="stat"><div class="stat-val">${value}</div><div class="stat-label">${label}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;

  const moduleRows = data.modules.map((m) => `<tr>
    <td>${escapeHtml(m.module)}</td>
    <td class="c">${m.hasFrontend ? '●' : ''}</td>
    <td class="c">${m.hasBackend ? '●' : ''}</td>
    <td class="n">${m.pages}</td><td class="n">${m.components}</td>
    <td class="n">${m.services}</td><td class="n">${m.hooks}</td>
    <td class="n">${m.apis}</td><td class="n">${m.totalFiles}</td>
    <td class="n">${m.linesOfCode.toLocaleString('en-US')}</td></tr>`).join('');

  const heatBars = data.heatRows.map((r) => `<div class="heat-row">
    <div class="heat-label">${escapeHtml(r.module)}</div>
    <div class="heat-track"><div class="heat-fill" style="width:${Math.round((r.coupling / data.maxCoupling) * 100)}%"></div></div>
    <div class="heat-val">${r.coupling}</div></div>`).join('');

  const methodChips = Object.entries(data.stats.backend.endpointsByMethod ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `<span class="chip method-${m}">${m} ${n}</span>`).join('');

  const todoChips = Object.entries(data.todos.byTag).sort((a, b) => b[1] - a[1])
    .map(([tag, n]) => `<span class="chip">${tag} ${n}</span>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Manifest Analyzer — Pulse ERP</title>
<style>
:root{
  --bg:#f6f7fb;--panel:#fff;--ink:#1a1d29;--muted:#6b7280;--line:#e6e8ef;
  --brand:#6d28d9;--brand-soft:#ede9fe;
  --excellent:#16a34a;--good:#65a30d;--average:#d97706;--poor:#dc2626;
  --shadow:0 1px 3px rgba(16,20,40,.06),0 8px 24px rgba(16,20,40,.06);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0f1117;--panel:#171a23;--ink:#e8eaf2;--muted:#9aa1b2;--line:#252a37;
  --brand:#a78bfa;--brand-soft:#241b3d;--shadow:0 1px 3px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink)}
a{color:var(--brand)}
header{background:linear-gradient(120deg,var(--brand),#4c1d95);color:#fff;padding:28px 24px}
.wrap{max-width:1200px;margin:0 auto;padding:0 20px}
header h1{margin:0;font-size:24px;letter-spacing:.2px}
header p{margin:6px 0 0;opacity:.85;font-size:13px}
nav{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line);box-shadow:var(--shadow)}
nav .wrap{display:flex;gap:4px;overflow-x:auto;padding:8px 20px}
nav button{border:0;background:transparent;color:var(--muted);padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;font-weight:600}
nav button.active{background:var(--brand-soft);color:var(--brand)}
section{padding:24px 0;display:none}
section.active{display:block}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin:0 0 14px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:var(--shadow);margin-bottom:20px}
.hero{display:grid;grid-template-columns:220px 1fr;gap:24px;align-items:center}
@media(max-width:720px){.hero{grid-template-columns:1fr}}
.ring{position:relative;width:180px;height:180px;margin:0 auto}
.ring svg{transform:rotate(-90deg)}
.ring .big{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring .big b{font-size:44px;line-height:1}
.ring .big span{font-size:12px;color:var(--muted)}
.grid{display:grid;gap:14px}
.scores{grid-template-columns:repeat(4,1fr)}
.stats{grid-template-columns:repeat(4,1fr)}
.links{grid-template-columns:repeat(3,1fr)}
@media(max-width:900px){.scores,.stats{grid-template-columns:repeat(2,1fr)}.links{grid-template-columns:1fr 1fr}}
@media(max-width:560px){.scores,.stats,.links{grid-template-columns:1fr}}
.score-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.score-card{border-left:4px solid var(--muted)}
.score-card.excellent{border-left-color:var(--excellent)}
.score-card.good{border-left-color:var(--good)}
.score-card.average{border-left-color:var(--average)}
.score-card.poor{border-left-color:var(--poor)}
.score-name{font-size:12px;color:var(--muted);font-weight:600}
.score-val{font-size:30px;font-weight:700;margin:2px 0}
.meter{height:6px;background:var(--line);border-radius:99px;overflow:hidden;margin:6px 0}
.meter span{display:block;height:100%;background:var(--brand)}
.score-rating{font-size:11px;color:var(--muted)}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;text-align:center}
.stat-val{font-size:26px;font-weight:700;color:var(--brand)}
.stat-label{font-size:12px;color:var(--muted);margin-top:2px}
.stat-sub{font-size:11px;color:var(--muted);margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}
th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.4px;position:sticky;top:52px;background:var(--panel)}
td.n,td.c{text-align:center}
.tbl-wrap{overflow-x:auto}
.heat-row{display:grid;grid-template-columns:150px 1fr 44px;gap:10px;align-items:center;margin-bottom:6px}
.heat-label{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.heat-track{background:var(--line);border-radius:99px;height:14px;overflow:hidden}
.heat-fill{height:100%;background:linear-gradient(90deg,var(--brand),#4c1d95)}
.heat-val{font-size:12px;color:var(--muted);text-align:right}
.chip{display:inline-block;background:var(--brand-soft);color:var(--brand);border-radius:99px;padding:3px 10px;font-size:12px;font-weight:600;margin:0 6px 6px 0}
.link{display:block;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;text-decoration:none;color:var(--ink);font-weight:600;font-size:13px;transition:.15s}
.link:hover{border-color:var(--brand);color:var(--brand);transform:translateY(-1px)}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:700;color:#fff}
.badge.excellent{background:var(--excellent)}.badge.good{background:var(--good)}
.badge.average{background:var(--average)}.badge.poor{background:var(--poor)}
.note{font-size:12px;color:var(--muted);margin-top:8px}
footer{text-align:center;color:var(--muted);font-size:12px;padding:30px 0}
.readonly{display:inline-block;background:var(--brand-soft);color:var(--brand);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;margin-top:10px}
</style>
</head>
<body>
<header><div class="wrap">
  <h1>Manifest Analyzer</h1>
  <p>Read-only health &amp; architecture report for Pulse ERP · generated ${escapeHtml(data.generatedAt)}</p>
  <div class="readonly">🔒 Read-only — no application source was modified</div>
</div></header>
<nav><div class="wrap" id="tabs">
  <button data-tab="overview" class="active">Overview</button>
  <button data-tab="health">Health</button>
  <button data-tab="statistics">Statistics</button>
  <button data-tab="modules">Modules</button>
  <button data-tab="dependencies">Dependencies</button>
  <button data-tab="quality">Quality</button>
  <button data-tab="reports">Reports</button>
</div></nav>
<div class="wrap">

<section id="overview" class="active">
  <div class="panel hero">
    <div class="ring">
      <svg width="180" height="180" viewBox="0 0 180 180">
        <circle cx="90" cy="90" r="78" fill="none" stroke="var(--line)" stroke-width="16"/>
        <circle cx="90" cy="90" r="78" fill="none" stroke="var(--${overallClass})" stroke-width="16"
          stroke-linecap="round" stroke-dasharray="${(2 * Math.PI * 78).toFixed(1)}"
          stroke-dashoffset="${(2 * Math.PI * 78 * (1 - data.health.overall / 100)).toFixed(1)}"/>
      </svg>
      <div class="big"><b>${data.health.overall}</b><span>/ 100</span></div>
    </div>
    <div>
      <h2>Overall health</h2>
      <p style="font-size:20px;margin:0 0 8px"><span class="badge ${overallClass}">${data.health.rating}</span></p>
      <p class="note">Average of ${scoreCards.filter(([, s]) => s != null).length} scored dimensions (Security excluded when npm audit is offline). Every score is derived from measured facts — see the Health tab for formulas.</p>
    </div>
  </div>
  <h2>Key metrics</h2>
  <div class="grid stats">
    ${statCard('Source files', t.sourceFiles)}
    ${statCard('Lines of code', t.linesOfCode.toLocaleString('en-US'))}
    ${statCard('API endpoints', t.apiEndpoints)}
    ${statCard('Modules', data.modules.length)}
    ${statCard('React components', data.stats.frontend.components)}
    ${statCard('Pages', data.stats.frontend.pages)}
    ${statCard('npm packages', t.npmPackages)}
    ${statCard('Test files', data.stats.frontend.tests + data.stats.backend.tests)}
  </div>
  <h2>Risk snapshot</h2>
  <div class="grid stats">
    ${statCard('Circular deps', data.circular.frontend + data.circular.backend, `${data.circular.frontend} FE / ${data.circular.backend} BE`)}
    ${statCard('Unreachable files', data.dead.unreachable, 'verify before removal')}
    ${statCard('Duplicate file groups', data.duplicates.identical, `${data.duplicates.dupApis} dup APIs`)}
    ${statCard('FIXME/HACK/XXX', data.todos.urgent, `${data.todos.total} total markers`)}
  </div>
</section>

<section id="health">
  <h2>Score breakdown</h2>
  <div class="grid scores">${scoreCardHtml}</div>
  <div class="panel"><h2>Method</h2>
    <p class="note">Each dimension starts at 100 and is penalised by measured facts (circular dependencies, lint errors, dead-file ratio, test ratio, audit findings, …). Formulas are documented in <b>reports/project-health.md</b>. Scores are a triage aid, not a grade.</p>
  </div>
</section>

<section id="statistics">
  <h2>Frontend</h2>
  <div class="grid stats">
    ${statCard('Components', data.stats.frontend.components)}
    ${statCard('Pages', data.stats.frontend.pages)}
    ${statCard('Hooks', data.stats.frontend.hooks)}
    ${statCard('Services', data.stats.frontend.services)}
    ${statCard('Contexts', data.stats.frontend.contexts)}
    ${statCard('Stores', data.stats.frontend.stores)}
    ${statCard('Utilities', data.stats.frontend.utilities)}
    ${statCard('CSS files', data.stats.frontend.styles)}
  </div>
  <h2>Backend</h2>
  <div class="grid stats">
    ${statCard('Route files', data.stats.backend.routes)}
    ${statCard('Controllers', data.stats.backend.controllers)}
    ${statCard('Services', data.stats.backend.services)}
    ${statCard('Models', data.stats.backend.models)}
    ${statCard('Middleware', data.stats.backend.middleware)}
    ${statCard('Jobs', data.stats.backend.jobs)}
    ${statCard('Migrations/seeds', data.stats.backend.database)}
    ${statCard('Endpoints', data.stats.backend.endpoints)}
  </div>
  <div class="panel"><h2>Endpoints by method</h2>${methodChips || '<span class="note">none</span>'}</div>
  <h2>File types</h2>
  <div class="grid stats">
    ${statCard('.js', t.jsFiles)}${statCard('.jsx', t.jsxFiles)}
    ${statCard('.ts', t.tsFiles)}${statCard('.tsx', t.tsxFiles)}
  </div>
</section>

<section id="modules">
  <h2>Module matrix (${data.modules.length})</h2>
  <div class="panel tbl-wrap">
    <table>
      <thead><tr><th>Module</th><th>FE</th><th>BE</th><th>Pages</th><th>Comp</th><th>Svc</th><th>Hooks</th><th>APIs</th><th>Files</th><th>LOC</th></tr></thead>
      <tbody>${moduleRows}</tbody>
    </table>
  </div>
</section>

<section id="dependencies">
  <h2>Coupling heatmap (top 15)</h2>
  <div class="panel">${heatBars || '<span class="note">no cross-module edges detected</span>'}
    <p class="note">Bar = combined fan-in + fan-out of internal imports. Full table in reports/dependency-heatmap.md.</p>
  </div>
  <h2>Circular dependencies</h2>
  <div class="grid stats">
    ${statCard('Frontend cycles', data.circular.frontend)}
    ${statCard('Backend cycles', data.circular.backend)}
    ${statCard('Unmounted route files', data.api.unmounted)}
    ${statCard('Shadowed endpoints', data.api.shadowed)}
  </div>
</section>

<section id="quality">
  <h2>Dead code</h2>
  <div class="grid stats">
    ${statCard('Unreachable files', data.dead.unreachable)}
    ${statCard('Unused deps (knip)', data.dead.unusedDeps)}
    ${statCard('Unused routes', data.routes.unused)}
    ${statCard('Missing routes', data.routes.missing)}
  </div>
  <h2>Duplicates</h2>
  <div class="grid stats">
    ${statCard('Identical file groups', data.duplicates.identical)}
    ${statCard('Duplicate exports', data.duplicates.dupExports)}
    ${statCard('Duplicate APIs', data.duplicates.dupApis)}
    ${statCard('Routes defined', data.routes.total)}
  </div>
  <div class="panel"><h2>TODO markers</h2>${todoChips || '<span class="note">none</span>'}
    <p class="note">Full lists in reports/dead-code-report.md, duplicate-report.md and todo-report.md. Nothing has been deleted or modified.</p>
  </div>
</section>

<section id="reports">
  <h2>Reports</h2>
  <div class="grid links">${linkList(reportLinks)}</div>
  <h2>Documentation</h2>
  <div class="grid links">${linkList(docLinks)}</div>
  <h2>Diagrams</h2>
  <div class="grid links">${linkList(diagramLinks)}</div>
  <p class="note">Markdown and text reports open in the browser; some browsers download .md files instead of rendering them — open with any Markdown viewer or a text editor.</p>
</section>

</div>
<footer>Manifest Analyzer v1.0 · read-only · run <code>npm run analyze</code> to regenerate</footer>
<script>
  const tabs=document.getElementById('tabs');
  tabs.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('section').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById(b.dataset.tab).classList.add('active');
    window.scrollTo({top:0,behavior:'smooth'});
  });
</script>
</body>
</html>`;
}
