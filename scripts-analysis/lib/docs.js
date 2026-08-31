/**
 * Manifest Analyzer — steps 9 and 11.
 * Auto-generated documentation set + AI-oriented summary.
 *
 * All content is derived from the live scan, so re-running keeps docs in sync
 * with the code. No prose is hand-copied from source.
 */
import path from 'node:path';
import fs from 'node:fs';
import { DIRS, FRONTEND_SRC, BACKEND_SRC, BACKEND } from './config.js';
import { write } from './fsx.js';
import { h1, h2, h3, stamp, table, bulletList } from './report.js';
import { walk, posix } from './scan.js';

const D = (name, body) => write(path.join(DIRS.documentation, name), body);

function architectureDoc(ctx) {
  const { stats, health, api } = ctx;
  D('Architecture.md', [
    h1('Architecture'),
    stamp(),
    'Pulse ERP (internally "Manifest") is a monorepo with a React 19 SPA frontend and an\n' +
    'Express 5 backend over PostgreSQL, packaged for desktop with Electron.\n',
    h2('At a glance'),
    table(['Aspect', 'Value'], [
      ['Frontend', 'React 19 + Vite 8, react-router-dom 7, zustand, recharts, axios'],
      ['Backend', 'Express 5, pg (raw SQL), JWT auth, node-cron jobs'],
      ['Database', 'PostgreSQL (raw SQL via `pg`, hand-written migrations)'],
      ['Desktop', 'Electron wrapper (`Pulse/electron`)'],
      ['Source files', stats.totals.sourceFiles],
      ['Lines of code', stats.totals.linesOfCode.toLocaleString('en-US')],
      ['API endpoints', api.endpoints.length],
      ['Modules', ctx.moduleStats.moduleCount],
      ['Overall health', `${health.overall}/100 (${health.rating})`],
    ]),
    h2('Layers'),
    h3('Frontend'),
    bulletList([
      '`main.jsx` → `App.jsx` bootstraps the SPA.',
      '`config/routes.jsx` holds `ROUTES` (page-key → lazy component) and `NAV_ITEMS` (sidebar).',
      '`context/` provides Auth, Toast and Financial-Year state via React context.',
      '`services/` is the axios API layer — the only place that talks to `/api/v1`.',
      '`features/<module>/` contains that module\'s pages and components.',
    ]),
    h3('Backend'),
    bulletList([
      '`server.js` builds the express app and mounts every router under `/api/v1` via `v1Router`.',
      '`middlewares/` supplies `verifyToken`, `auditLogger`, scope resolution and permission gates.',
      '`modules/<module>/routes/*.routes.js` hold the endpoints — mostly inline `async (req,res)` handlers querying `pg` directly.',
      '`config/migrations.js` runs hand-written SQL migrations (a thin pg shim; bindings use `$1`).',
      '`jobs/` holds node-cron scheduled tasks.',
    ]),
    h2('Diagrams'),
    'Rendered Mermaid diagrams live in `analysis/graphs/`:\n',
    bulletList([
      '`frontend-architecture.md`', '`backend-architecture.md`',
      '`module-dependency-graph.md`', '`api-flow.md`', '`folder-structure.md`',
      'plus madge SVGs (`frontend.svg`, `backend.svg`) when Graphviz is installed.',
    ]),
    h2('Health'),
    `Overall project health is **${health.overall}/100 (${health.rating})**. See ` +
    '`analysis/reports/project-health.md` for the per-dimension breakdown and recommendations.\n',
  ].join(''));
}

function frontendDoc(ctx) {
  const { stats, routes } = ctx;
  const dirCounts = countTopDirs(FRONTEND_SRC);
  D('Frontend.md', [
    h1('Frontend'),
    stamp(),
    table(['Metric', 'Count'], [
      ['Total files', stats.frontend.totalFiles],
      ['Lines of code', stats.frontend.linesOfCode.toLocaleString('en-US')],
      ['Components', stats.frontend.components],
      ['Pages', stats.frontend.pages],
      ['Hooks', stats.frontend.hooks],
      ['Services', stats.frontend.services],
      ['Contexts', stats.frontend.contexts],
      ['Stores (zustand)', stats.frontend.stores],
      ['Utilities', stats.frontend.utilities],
      ['Styles (CSS)', stats.frontend.styles],
      ['Tests', stats.frontend.tests],
      ['Routes defined', stats.frontend.routesDefined],
      ['Lazy-loaded routes', stats.frontend.lazyRoutes],
    ]),
    h2('Top-level directories under `frontend/src`'),
    table(['Directory', 'Files'], Object.entries(dirCounts).sort((a, b) => b[1] - a[1]).map(([d, c]) => [`\`${d}/\``, c])),
    h2('Routing'),
    'This app does **not** use `<Route>` elements. `ROUTES` maps a page key to a lazy component;\n' +
    '`NAV_ITEMS` (the sidebar) references those keys; navigation is driven by a `setPage(key)`\n' +
    'callback threaded through context. `route-report.md` lists missing/unused routes.\n\n' +
    `Currently **${routes?.routes.length ?? 0}** routes are defined, **${routes?.missing.length ?? 0}** ` +
    `sidebar entries point at an undefined page, and **${routes?.unused.length ?? 0}** routes are not in the sidebar.\n`,
    h2('State management'),
    bulletList([
      'React Context — Auth, Toast, Financial Year (`context/`).',
      'Zustand — client stores (`store/`).',
      'Server state is fetched per-page through the axios services layer; there is no global query cache.',
    ]),
  ].join(''));
}

function backendDoc(ctx) {
  const { stats, api } = ctx;
  const dirCounts = countTopDirs(BACKEND_SRC);
  D('Backend.md', [
    h1('Backend'),
    stamp(),
    table(['Metric', 'Count'], [
      ['Total files', stats.backend.totalFiles],
      ['Lines of code', stats.backend.linesOfCode.toLocaleString('en-US')],
      ['Route files', stats.backend.routes],
      ['Controllers', stats.backend.controllers],
      ['Services', stats.backend.services],
      ['Models', stats.backend.models],
      ['Middleware', stats.backend.middleware],
      ['Utilities', stats.backend.utilities],
      ['Jobs (cron)', stats.backend.jobs],
      ['Database files (migrations/seeds)', stats.backend.database],
      ['Tests', stats.backend.tests],
      ['API endpoints', api.endpoints.length],
    ]),
    h2('Endpoints by method'),
    table(['Method', 'Count'], Object.entries(api.byMethod ?? {}).sort((a, b) => b[1] - a[1])),
    h2('Top-level directories under `backend/src`'),
    table(['Directory', 'Files'], Object.entries(dirCounts).sort((a, b) => b[1] - a[1]).map(([d, c]) => [`\`${d}/\``, c])),
    h2('Handler style'),
    'Most modules have **no controller/service/model split**. Endpoints are inline\n' +
    '`async (req, res)` closures inside the `.routes.js` files, running raw SQL through the\n' +
    'shared `pg` pool. This is why the statistics show many route files but few controllers,\n' +
    'services or models — the layers simply are not separated in this codebase.\n',
    h2('Auth & permissions'),
    bulletList([
      '`verifyToken` middleware validates the JWT and populates `req.user` / `req.scope`.',
      '`requirePermission(module, action)` gates most CRUD endpoints (view/add/edit/delete).',
      '`allowRoles(...)` gates a smaller set of admin-only endpoints.',
      'Tenant scoping is applied per-query; `companyOf(req)` is the correct scope read.',
    ]),
    h2('API surface'),
    'The complete endpoint list, auth gates, unmounted route files and shadowed (unreachable)\n' +
    'routes are in `analysis/reports/api-report.md`.\n',
  ].join(''));
}

function modulesDoc(ctx) {
  const { moduleStats } = ctx;
  D('Modules.md', [
    h1('Modules'),
    stamp(),
    `Detected **${moduleStats.moduleCount}** modules as the union of ` +
    '`frontend/src/features/*` and `backend/src/modules/*`.\n',
    h2('Module matrix'),
    table(['Module', 'FE', 'BE', 'Pages', 'Components', 'Services', 'Hooks', 'APIs', 'Files', 'LOC'],
      moduleStats.modules.map((m) => [
        m.module, m.hasFrontend ? '✓' : '', m.hasBackend ? '✓' : '',
        m.pages, m.components, m.services, m.hooks, m.apis, m.totalFiles, m.linesOfCode,
      ])),
    h2('Largest modules by file count'),
    bulletList(moduleStats.modules.slice(0, 10).map((m) =>
      `**${m.module}** — ${m.totalFiles} files, ${m.apis} APIs, ${m.linesOfCode.toLocaleString('en-US')} LOC`)),
  ].join(''));
}

function folderStructureDoc() {
  const tree = (root, label) => {
    const lines = [`${label}/`];
    const files = walk(root).map((f) => posix(path.relative(root, f)));
    const dirs = new Map();
    for (const f of files) {
      const parts = f.split('/');
      for (let depth = 0; depth < Math.min(parts.length - 1, 3); depth++) {
        const key = parts.slice(0, depth + 1).join('/');
        dirs.set(key, (dirs.get(key) ?? 0) + 1);
      }
    }
    for (const key of [...dirs.keys()].sort()) {
      const depth = key.split('/').length;
      lines.push(`${'  '.repeat(depth)}${key.split('/').pop()}/  (${dirs.get(key)} files)`);
    }
    return lines.join('\n');
  };
  D('FolderStructure.md', [
    h1('Folder Structure'),
    stamp(),
    'Directory tree (max depth 3) with file counts.\n',
    h2('frontend/src'),
    '```\n' + tree(FRONTEND_SRC, 'frontend/src') + '\n```\n',
    h2('backend/src'),
    '```\n' + tree(BACKEND_SRC, 'backend/src') + '\n```\n',
  ].join(''));
}

function codingPatternsDoc(ctx) {
  D('CodingPatterns.md', [
    h1('Coding Patterns'),
    stamp(),
    'Conventions observed in this codebase — follow these when extending it.\n',
    h2('Frontend'),
    bulletList([
      '**Feature-first layout.** Code lives under `features/<module>/pages` and `.../components`, not in a global `pages/` dir (a handful of cross-cutting pages are the exception).',
      '**Lazy routes.** Every page is registered in `config/routes.jsx` via `lazy(() => import(...))` and referenced by a stable page key.',
      '**`@/` alias** resolves to `frontend/src` (Vite). Prefer it over deep relative paths.',
      '**Axios services layer.** UI never calls `fetch` directly; it goes through `services/`.',
      '**Dates** are formatted `DD Mon YY` via the canonical `fmtDate` in `utils/dateFormatter.js`.',
      '**Toasts, not `alert()`** for user feedback.',
    ]),
    h2('Backend'),
    bulletList([
      '**Route-centric.** Endpoints are inline `async (req,res)` handlers inside `*.routes.js`; there is rarely a separate controller/service/model.',
      '**Raw SQL via `pg`** with `$1` positional bindings (never `?`).',
      '**Permission gates** — `requirePermission(module, action)` / `allowRoles(...)` on each route.',
      '**Tenant scope** via `companyOf(req)` from `shared/scope.js`; do not read `req.user.company_id` directly.',
      '**Mass-assignment guard** — generic updates go through `shared/safeUpdate.js` (`pickUpdatable`).',
      '**Migrations** are hand-written SQL run by `config/migrations.js` (`npm run migrate`).',
    ]),
    h2('Testing'),
    bulletList([
      'Frontend: Vitest + Testing Library (`__tests__/`).',
      'Backend: Vitest + supertest; real-DB integration tests must defeat the mocked `DB_PASSWORD` in `setup.js`.',
      'End-to-end: Playwright suites at the workspace root.',
    ]),
  ].join(''));
}

function servicesDoc(ctx) {
  const feServices = fs.existsSync(path.join(FRONTEND_SRC, 'services'))
    ? walk(path.join(FRONTEND_SRC, 'services')).map((f) => posix(path.relative(FRONTEND_SRC, f)))
    : [];
  const beServices = fs.existsSync(path.join(BACKEND_SRC, 'services'))
    ? walk(path.join(BACKEND_SRC, 'services')).map((f) => posix(path.relative(BACKEND_SRC, f)))
    : [];
  D('Services.md', [
    h1('Services'),
    stamp(),
    h2('Frontend services (axios API layer)'),
    feServices.length ? bulletList(feServices.map((f) => `\`services/${f}\``)) : '_None found._\n',
    h2('Backend services'),
    beServices.length ? bulletList(beServices.map((f) => `\`src/services/${f}\``)) : '_None found._\n',
    h2('Note'),
    'On the backend, most business logic lives in the route handlers rather than in a\n' +
    'dedicated service layer; the files above are the exceptions that were factored out.\n',
  ].join(''));
}

function apisDoc(ctx) {
  const { api } = ctx;
  const byModule = new Map();
  for (const e of api.endpoints) {
    if (!byModule.has(e.module)) byModule.set(e.module, []);
    byModule.get(e.module).push(e);
  }
  const sections = [...byModule.entries()].sort((a, b) => b[1].length - a[1].length).map(([mod, eps]) =>
    h3(`${mod} (${eps.length})`) +
    table(['Method', 'Path'], eps.sort((a, b) => a.path.localeCompare(b.path)).map((e) => [e.method, `\`${e.path}\``])));
  D('APIs.md', [
    h1('APIs'),
    stamp(),
    `**${api.endpoints.length}** endpoints across **${byModule.size}** modules. Full detail with\n` +
    'auth gates and handler locations is in `analysis/reports/api-report.md`.\n',
    ...sections,
  ].join(''));
}

function dashboardDoc(ctx) {
  D('Dashboard.md', [
    h1('Analysis Dashboard'),
    stamp(),
    'The interactive HTML dashboard is generated at `analysis/index.html`. Open it in any\n' +
    'browser (double-click on Windows) — it is fully self-contained and offline.\n',
    h2('What it shows'),
    bulletList([
      'Overall health score and per-dimension ratings.',
      'Project and per-module statistics.',
      'Dependency heatmap and circular-dependency counts.',
      'Dead-code, duplicate, TODO, route and API summaries.',
      'Links to every generated report, diagram and document.',
    ]),
    h2('Regenerating'),
    'Run `npm run analyze` from the workspace root. The command is idempotent — it only\n' +
    'overwrites files under `analysis/` and never touches application source.\n',
  ].join(''));
}

export function generateDocumentation(ctx) {
  architectureDoc(ctx);
  frontendDoc(ctx);
  backendDoc(ctx);
  modulesDoc(ctx);
  folderStructureDoc();
  codingPatternsDoc(ctx);
  servicesDoc(ctx);
  apisDoc(ctx);
  dashboardDoc(ctx);
}

/** Step 11 — AI summary. Written for an AI assistant onboarding to the codebase. */
export function generateAiSummary(ctx) {
  const { stats, api, moduleStats, health, dead, duplicates, todos, routes, frontend, backend } = ctx;
  const topModules = moduleStats.modules.slice(0, 12);
  const heaviest = ctx.heatmap.rows.slice(0, 8);
  const modLabel = (slug) => moduleStats.modules.find((m) => m.slug === slug)?.module ?? slug;

  const md = [
    h1('AI Summary — Pulse ERP (Manifest)'),
    stamp(),
    '_Written for an AI assistant that needs to understand this ERP quickly. Every number\n' +
    'below is measured from the current source by Manifest Analyzer._\n',

    h2('1. What this is'),
    `Pulse ERP ("Manifest") is a large multi-tenant ERP: a React 19 SPA (${stats.frontend.totalFiles} files, ` +
    `${stats.frontend.linesOfCode.toLocaleString('en-US')} LOC) over an Express 5 + PostgreSQL backend ` +
    `(${stats.backend.totalFiles} files, ${api.endpoints.length} REST endpoints), wrapped in Electron for desktop. ` +
    `It spans **${moduleStats.moduleCount} business modules** (HR, Finance, CRM, Inventory, Production, Projects, ` +
    'Service Desk, Procurement, and more). Overall health is measured at ' +
    `**${health.overall}/100 (${health.rating})**.`,

    h2('2. Overall architecture'),
    bulletList([
      '**Monorepo**: `Pulse/frontend`, `Pulse/backend`, `Pulse/electron`.',
      '**Frontend**: Vite + React 19, `react-router-dom` present but routing is actually a page-key registry (`config/routes.jsx`) driven by a `setPage()` callback, not `<Route>` trees.',
      '**Backend**: one Express app (`server.js`) mounting ~per-module routers under `/api/v1` through a `v1Router`.',
      '**Data**: raw SQL via `pg`, hand-written migrations. No ORM.',
      '**Handlers are route-centric**: business logic lives inside `*.routes.js` closures, not a service/controller layer.',
    ]),

    h2('3. Entry points'),
    bulletList([
      'Frontend: `Pulse/frontend/src/main.jsx` → `App.jsx`.',
      'Backend: `Pulse/backend/server.js` (builds app, mounts `v1Router`, starts cron jobs).',
      'Routing table: `Pulse/frontend/src/config/routes.jsx` (`ROUTES` + `NAV_ITEMS`).',
      'Migrations: `Pulse/backend/src/config/migrations.js` (`npm run migrate`).',
    ]),

    h2('4. Module relationships'),
    'The most tightly-coupled modules (highest combined fan-in + fan-out of internal imports):\n\n' +
    table(['Module', 'Fan-out', 'Fan-in', 'Coupling'], heaviest.map((r) => [modLabel(r.module), r.fanOut, r.fanIn, r.coupling])) +
    '\nLargest modules by file count:\n\n' +
    bulletList(topModules.map((m) => `**${m.module}** — ${m.totalFiles} files, ${m.apis} endpoints`)),

    h2('5. Routing'),
    `${routes?.routes.length ?? 0} routes defined, ${routes?.routes.filter((r) => r.lazy).length ?? 0} lazy-loaded. ` +
    `Sidebar (NAV_ITEMS) references page keys; ${routes?.missing.length ?? 0} references point at an undefined page ` +
    `and ${routes?.unused.length ?? 0} routes are not reachable from the sidebar. Navigation is via setPage(pageKey), ` +
    'not URL paths.',

    h2('6. State management'),
    bulletList([
      'React Context for Auth, Toast and Financial Year (`context/`).',
      'Zustand stores in `store/`.',
      'No global server-state cache; each page fetches through the axios services layer.',
    ]),

    h2('7. API layer & database communication'),
    bulletList([
      'Frontend → backend only through `services/` (axios), base path `/api/v1`.',
      'Backend endpoints run raw parameterised SQL (`$1` bindings) via a shared `pg` pool.',
      'Multi-tenant: every query should scope by company; `companyOf(req)` is the correct read (reading `req.user.company_id` fails open across tenants).',
      'Generic updates go through `shared/safeUpdate.js` to prevent mass-assignment / SQL injection.',
    ]),

    h2('8. Authentication & permission flow'),
    bulletList([
      'JWT bearer tokens; `verifyToken` middleware populates `req.user` and `req.scope`.',
      'Roles are **many-to-many** (`user_roles` junction); gate via role helpers, never a single `req.user.role`.',
      '`requirePermission(module, action)` enforces view/add/edit/delete per module.',
      '`allowRoles(...)` guards admin-only endpoints.',
      'Frontend mirrors this with per-module menu permissions on `NAV_ITEMS`.',
    ]),

    h2('9. Dashboard flow'),
    'Multiple role-specific dashboards (CEO, CFO, HR, Executive, Employee) plus a consolidated\n' +
    'Home. Dashboards call module analytics endpoints and render with recharts. The analysis\n' +
    'dashboard produced by this toolkit is separate: `analysis/index.html`.\n',

    h2('10. Critical files'),
    bulletList([
      '`backend/server.js` — every route mount and middleware order.',
      '`frontend/src/config/routes.jsx` — the entire page/route/sidebar map.',
      '`backend/src/shared/scope.js` + `safeUpdate.js` — tenant safety and write safety.',
      '`backend/src/config/migrations.js` — schema evolution.',
      '`frontend/src/context/` — Auth/Toast/FY providers every page depends on.',
    ]),

    h2('11. Major risks'),
    bulletList([
      `Circular dependencies: ${(frontend?.madge?.circular?.length ?? 0)} frontend, ${(backend?.madge?.circular?.length ?? 0)} backend.`,
      `Dead/unreachable code: ${dead?.unreachable?.length ?? 0} files flagged (verify before removal — some are dynamically imported).`,
      `Duplicates: ${duplicates?.identical?.length ?? 0} byte-identical file groups, ${duplicates?.dupApis?.length ?? 0} duplicate API routes (Express serves only the first).`,
      `Unmounted route files & shadowed endpoints — see api-report.md (a recurring bug class here).`,
      `Test coverage is thin (${stats.frontend.tests + stats.backend.tests} test files for ${stats.totals.sourceFiles} source files).`,
      `${todos?.urgent?.length ?? 0} FIXME/HACK/XXX/BUG markers flag code the authors knew was broken.`,
      'Tenant scoping bugs: reading `req.user.company_id` instead of `companyOf(req)` silently leaks data across companies.',
    ]),

    h2('12. Suggested improvements & future refactoring'),
    bulletList([
      'Extract a thin service layer for the largest modules so SQL is testable without HTTP.',
      'Add contract tests around the auth gates and tenant scoping (highest-risk, currently under-tested).',
      'Resolve circular dependencies to restore tree-shaking.',
      'Delete verified-dead files and de-duplicate the repeated components/exports.',
      'Introduce a route-registration lint so shadowed / unmounted routes fail CI instead of shipping.',
      'Consider a query cache (React Query) to remove per-page refetch boilerplate from the services layer.',
    ]),

    h2('13. How to keep this summary current'),
    'Re-run `npm run analyze` from the workspace root. This document, all reports, diagrams and\n' +
    'the dashboard regenerate from the live source. The toolkit is strictly read-only with\n' +
    'respect to application code — it only writes under `analysis/`.\n',
  ].join('');

  write(path.join(DIRS.summary, 'ai-summary.md'), md);
}

function countTopDirs(root) {
  const counts = {};
  for (const f of walk(root)) {
    const rel = posix(path.relative(root, f));
    const top = rel.includes('/') ? rel.split('/')[0] : '(root files)';
    counts[top] = (counts[top] ?? 0) + 1;
  }
  return counts;
}
