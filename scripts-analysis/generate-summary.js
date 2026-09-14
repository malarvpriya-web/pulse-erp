/**
 * Manifest Analyzer — analysis & synthesis (steps 6–18).
 *
 * Consumes the tool outputs produced by frontend-analysis.js / backend-analysis.js
 * plus a single source scan, then generates statistics, diagrams, documentation,
 * the health report, the AI summary, the heatmap and the interactive dashboard.
 *
 * Pure synthesis: reads source as text, writes only under analysis/.
 */
import { DIRS } from './lib/config.js';
import { collectSources } from './lib/scan.js';
import {
  generateProjectStatistics, generateModuleStatistics, generateHeatmap,
} from './lib/statistics.js';
import {
  generateDeadCodeReport, generateDuplicateReport, generateTodoReport,
} from './lib/quality.js';
import { generateDiagrams } from './lib/diagrams.js';
import { computeHealth, generateHealthReport } from './lib/health.js';
import { generateDocumentation, generateAiSummary } from './lib/docs.js';
import { generateDashboard } from './lib/dashboard.js';

/**
 * @param log RunLog
 * @param feResult result of runFrontendAnalysis (may be null)
 * @param beResult result of runBackendAnalysis (may be null)
 */
export function generateSummary(log, feResult, beResult) {
  console.log('\n▸ Statistics, documentation & summary');

  const sources = collectSources();
  log.ok('scan sources', `${sources.frontend.length} FE + ${sources.backend.length} BE files`);

  const api = beResult?.api ?? { endpoints: [], byMethod: {}, unmounted: [], shadowed: [] };
  const routes = feResult?.routes ?? null;

  // Step 6 & 7 — statistics.
  const stats = generateProjectStatistics(sources, api, routes);
  log.ok('project statistics', `analysis/statistics/project-statistics.json`);
  const moduleStats = generateModuleStatistics(sources, api);
  log.ok('module statistics', `${moduleStats.moduleCount} modules`);

  // Step 12 — heatmap (also feeds diagrams + health).
  const heatmap = generateHeatmap(sources, moduleStats);
  log.ok('dependency heatmap', `${heatmap.rows.length} modules ranked`);

  // Steps 13, 14, 15 — quality reports.
  const dead = generateDeadCodeReport(sources, feResult?.knipCounts, feResult?.knip, api, routes);
  log.record('dead code report', dead.unreachable.length ? 'warn' : 'ok', `${dead.unreachable.length} unreachable files`);
  const duplicates = generateDuplicateReport(sources, api);
  log.record('duplicate report', duplicates.identical.length ? 'warn' : 'ok', `${duplicates.identical.length} identical groups`);
  const todos = generateTodoReport(sources);
  log.record('todo report', todos.urgent.length ? 'warn' : 'ok', `${todos.todos.length} markers (${todos.urgent.length} urgent)`);

  // Step 8 — diagrams.
  generateDiagrams(api, heatmap, moduleStats);
  log.ok('mermaid diagrams', '5 diagrams → analysis/graphs/');

  // Step 10 — health (needed by docs + dashboard).
  const health = computeHealth({ stats, frontend: feResult, backend: beResult, dead, duplicates, todos, heatmap });
  generateHealthReport(health, stats);
  log.ok('health report', `overall ${health.overall}/100 (${health.rating})`);

  const ctx = {
    stats, api, moduleStats, health, dead, duplicates, todos, routes,
    frontend: feResult, backend: beResult, heatmap, runLog: log,
  };

  // Step 9 & 11 — documentation + AI summary.
  generateDocumentation(ctx);
  log.ok('documentation', '9 docs → analysis/documentation/');
  generateAiSummary(ctx);
  log.ok('AI summary', 'analysis/summary/ai-summary.md');

  // Step 18 — dashboard.
  generateDashboard(ctx);
  log.ok('dashboard', 'analysis/index.html');

  return { stats, moduleStats, health, ctx };
}
