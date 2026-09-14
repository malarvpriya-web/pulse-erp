/**
 * Manifest Analyzer — step 8. Mermaid architecture diagrams.
 * Emits GitHub-renderable ```mermaid fenced markdown into analysis/graphs/.
 */
import path from 'node:path';
import { DIRS, FRONTEND_SRC, BACKEND_SRC } from './config.js';
import { write } from './fsx.js';
import { stamp, mermaidId } from './report.js';
import { walk, posix } from './scan.js';

const fence = (title, diagram, notes = '') =>
  `# ${title}\n\n${stamp()}\n${notes}\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`;

function frontendArchitecture() {
  const d = `flowchart TD
  main["main.jsx (entry)"] --> App["App.jsx"]
  App --> Router["config/routes.jsx<br/>ROUTES + NAV_ITEMS"]
  App --> Ctx["context/<br/>Auth · Toast · FY"]
  App --> Store["store/ (zustand)"]
  Router --> Pages["pages/ + features/*/pages/"]
  Pages --> Components["components/ + features/*/components/"]
  Pages --> Hooks["hooks/"]
  Components --> Hooks
  Hooks --> Services["services/ (axios API layer)"]
  Pages --> Services
  Services --> API["/api/v1 (backend)"]
  Components --> Utils["utils/ (fmtDate, gst, …)"]
  Ctx --> Services`;
  write(path.join(DIRS.graphs, 'frontend-architecture.md'),
    fence('Frontend Architecture', d,
      'Layered view of the React SPA. Requests flow downward; every network call goes through the axios services layer.'));
}

function backendArchitecture() {
  const d = `flowchart TD
  Client["Frontend SPA"] -->|HTTP /api/v1| Server["server.js<br/>express app"]
  Server --> MW["middlewares/<br/>verifyToken · auditLogger · scope"]
  MW --> V1["v1Router (mount table)"]
  V1 --> Routes["modules/*/routes/*.routes.js<br/>inline async handlers"]
  Routes --> Gates["requirePermission / allowRoles"]
  Routes --> Shared["shared/ (scope, safeUpdate)"]
  Routes --> DB[("pg pool → PostgreSQL")]
  Server --> Jobs["jobs/ (node-cron)"]
  Jobs --> DB
  Server --> Migrations["config/migrations.js"]
  Migrations --> DB`;
  write(path.join(DIRS.graphs, 'backend-architecture.md'),
    fence('Backend Architecture', d,
      'Express 5 app. Most modules have no controller/service/model layer — handlers query `pg` directly inside the route files.'));
}

function moduleDependencyGraph(heatmap, moduleStats) {
  const label = (slug) => moduleStats.modules.find((m) => m.slug === slug)?.module ?? slug;
  const top = [...heatmap.crossModule.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 35);
  const seen = new Set();
  const lines = ['flowchart LR'];
  for (const [edge, count] of top) {
    const [from, to] = edge.split(' -> ');
    for (const n of [from, to]) {
      if (!seen.has(n)) {
        seen.add(n);
        lines.push(`  ${mermaidId(n)}["${label(n)}"]`);
      }
    }
    lines.push(`  ${mermaidId(from)} -->|${count}| ${mermaidId(to)}`);
  }
  if (top.length === 0) lines.push('  none["No cross-module imports detected"]');
  write(path.join(DIRS.graphs, 'module-dependency-graph.md'),
    fence('Module Dependency Graph', lines.join('\n'),
      'Cross-module import edges (top 35 by weight). Edge labels are the number of importing files. See `analysis/reports/dependency-heatmap.md` for the full table.'));
}

function apiFlow(api) {
  const modules = [...new Set(api.endpoints.map((e) => e.module))]
    .map((m) => ({ m, n: api.endpoints.filter((e) => e.module === m).length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 20);
  const lines = [
    'flowchart LR',
    '  UI["React SPA"] --> AX["services/ axios client"]',
    '  AX -->|"Bearer JWT"| GW["/api/v1 (verifyToken)"]',
    '  GW --> PERM["requirePermission / allowRoles"]',
  ];
  for (const { m, n } of modules) {
    lines.push(`  PERM --> ${mermaidId('mod_' + m)}["/${m}<br/>${n} endpoints"]`);
    lines.push(`  ${mermaidId('mod_' + m)} --> DB[("PostgreSQL")]`);
  }
  write(path.join(DIRS.graphs, 'api-flow.md'),
    fence('API Flow', lines.join('\n'),
      'Request lifecycle from the SPA through auth gates to the per-module route groups and the database. Top 20 modules by endpoint count.'));
}

/** Build a folder-structure Mermaid tree, capped in depth so it stays readable. */
function folderStructure() {
  const build = (root, label, maxDepth = 2) => {
    const rootId = mermaidId(label);
    const lines = [`  ${rootId}["${label}/"]`];
    const seen = new Set();
    for (const file of walk(root)) {
      const relPath = posix(path.relative(root, file));
      const parts = relPath.split('/');
      let parentId = rootId;
      let acc = label;
      for (let i = 0; i < Math.min(parts.length - 1, maxDepth); i++) {
        acc += '/' + parts[i];
        const id = mermaidId(acc);
        if (!seen.has(id)) {
          seen.add(id);
          lines.push(`  ${id}["${parts[i]}/"]`);
          lines.push(`  ${parentId} --> ${id}`);
        }
        parentId = id;
      }
    }
    return lines;
  };
  const d = ['flowchart TD',
    ...build(FRONTEND_SRC, 'frontend/src'),
    ...build(BACKEND_SRC, 'backend/src')].join('\n');
  write(path.join(DIRS.graphs, 'folder-structure.md'),
    fence('Folder Structure', d,
      'Top two directory levels of each source tree. The full tree is in `analysis/documentation/FolderStructure.md`.'));
}

export function generateDiagrams(api, heatmap, moduleStats) {
  frontendArchitecture();
  backendArchitecture();
  moduleDependencyGraph(heatmap, moduleStats);
  apiFlow(api);
  folderStructure();
}
