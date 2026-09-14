#!/usr/bin/env node
/**
 * Manifest Analyzer v1.0 — main orchestrator.
 *
 * `npm run analyze` runs this. It executes every analysis step in order and is
 * fully idempotent: re-running overwrites only files under analysis/ and never
 * touches, renames, deletes or "fixes" any application source, dependency or
 * git state. All work is offline.
 *
 * Steps:
 *   1  madge dependency graphs + circular checks (frontend & backend)
 *   2  dependency-cruiser (HTML + JSON)
 *   3  knip (unused files/exports/deps/duplicates)
 *   4  eslint (report only, never --fix)
 *   5  npm audit (report only, never --fix)
 *   6  project statistics        11  AI summary
 *   7  module statistics         12  dependency heatmap
 *   8  mermaid diagrams          13  dead code report
 *   9  documentation set         14  duplicate report
 *   10 health report             15  todo report
 *   16 route report              17  api report
 *   18 interactive dashboard (analysis/index.html)
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ANALYSIS, DIRS, PULSE } from './lib/config.js';
import { ensureDirs, write, exists } from './lib/fsx.js';
import { RunLog } from './lib/exec.js';
import { runFrontendAnalysis } from './frontend-analysis.js';
import { runBackendAnalysis } from './backend-analysis.js';
import { generateSummary } from './generate-summary.js';

function banner() {
  console.log('\n' + '='.repeat(64));
  console.log('  Manifest Analyzer v1.0 — Pulse ERP Health & Architecture');
  console.log('  READ-ONLY: application source is never modified.');
  console.log('='.repeat(64));
}

async function main() {
  const t0 = performance.now();
  banner();

  if (!exists(PULSE)) {
    console.error(`\n[fatal] Expected Pulse project at ${PULSE} — not found. Aborting without writing anything.`);
    process.exitCode = 1;
    return;
  }

  ensureDirs();
  const log = new RunLog();

  // Steps 1–4 (frontend) and 1–2 + 5 (backend) + route/api reports (16, 17).
  const feResult = safe(() => runFrontendAnalysis(log), log, 'frontend analysis');
  const beResult = safe(() => runBackendAnalysis(log), log, 'backend analysis');

  // Steps 6–15, 18 (synthesis).
  const summary = safe(() => generateSummary(log, feResult, beResult), log, 'summary generation');

  // Persist the run log (step-by-step outcome) under analysis/logs.
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  write(path.join(DIRS.logs, 'analyze-run.log'), log.toText());
  writeManifest(log, summary, elapsed);

  const c = log.counts;
  console.log('\n' + '-'.repeat(64));
  console.log(`  Done in ${elapsed}s — ${c.ok ?? 0} ok, ${c.warn ?? 0} warn, ${c.skip ?? 0} skipped, ${c.fail ?? 0} failed.`);
  if (summary?.health) {
    console.log(`  Project health: ${summary.health.overall}/100 (${summary.health.rating})`);
  }
  console.log(`  Open the dashboard:  ${path.join(ANALYSIS, 'index.html')}`);
  console.log('-'.repeat(64) + '\n');
}

/** Run a phase; on an unexpected throw, log it and continue so later steps still produce output. */
function safe(fn, log, name) {
  try {
    return fn();
  } catch (err) {
    log.fail(name, err?.stack?.split('\n').slice(0, 3).join(' | ') ?? String(err));
    return null;
  }
}

function writeManifest(log, summary, elapsed) {
  const manifest = {
    tool: 'Manifest Analyzer',
    version: '1.0',
    generatedAt: new Date().toISOString(),
    elapsedSeconds: Number(elapsed),
    readOnly: true,
    outputRoot: 'analysis/',
    health: summary?.health ? { overall: summary.health.overall, rating: summary.health.rating } : null,
    stepCounts: log.counts,
    steps: log.entries.map((e) => ({ step: e.step, status: e.status, ms: e.ms, detail: e.detail })),
  };
  write(path.join(DIRS.root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((err) => {
  console.error('\n[fatal] Manifest Analyzer crashed:', err);
  process.exitCode = 1;
});
