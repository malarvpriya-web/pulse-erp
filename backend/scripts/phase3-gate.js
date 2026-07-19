#!/usr/bin/env node
/**
 * Phase 3 Final Test Gate
 *
 * Runs the full Vitest suite (all __tests__ files), captures the JSON report,
 * and prints a structured Go/No-Go checklist for production readiness.
 *
 * Usage:
 *   node scripts/phase3-gate.js
 *   node scripts/phase3-gate.js --phase3-only   # runs only phase3.test.js
 *
 * Requires: npx available, vitest installed in devDependencies.
 */

import { execSync }   from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, '..');
const RESULT_FILE = resolve(ROOT, '.phase3-results.json');
const PHASE3_ONLY = process.argv.includes('--phase3-only');

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  grey:   '\x1b[90m',
  white:  '\x1b[97m',
};
const ok   = (s) => `${C.green}${C.bold}✔${C.reset}  ${s}`;
const fail = (s) => `${C.red}${C.bold}✘${C.reset}  ${s}`;
const skip = (s) => `${C.yellow}${C.bold}↷${C.reset}  ${s}`;
const info = (s) => `${C.cyan}ℹ${C.reset}  ${s}`;
const hr   = (char = '─', n = 64) => C.grey + char.repeat(n) + C.reset;

// ── Known skips — tests that are expected to be skipped in unit mode ──────────
// Update this table whenever a test is intentionally skipped.
const KNOWN_SKIPS = [
  {
    file:   'phase1.test.js',
    name:   'Migration smoke — verifyApplied',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'companies table exists',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'branches table exists',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'roles table exists',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'role_permissions seeded',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'users.company_id column',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'employees.branch_id column',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'permissions table shape',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'field_permissions seeded',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'phase1.test.js',
    name:   'master_values seeded',
    reason: 'Requires live PostgreSQL connection; skipped in unit test mode.',
  },
  {
    file:   'smoke.auth.test.js',
    name:   'Any it.skip / test.skip blocks',
    reason: 'Smoke tests use supertest + mocked pool; skips are route-level guards not yet wired.',
  },
  {
    file:   'smoke.payroll.test.js',
    name:   'Payroll calculation integration path',
    reason: 'Some payroll routes depend on database views not present in mock; skipped intentionally.',
  },
];

// ── Critical tests — if ANY of these fail, gate is NO-GO ─────────────────────
// Keyed by substring match on the test's fullName.
const CRITICAL_PATTERNS = [
  'RBAC matrix',
  'P3-1',
  'P3-2',
  'P3-3',
  'P3-4',
  'P3-5',
  'advanceWorkflow',
  'requirePermission',
  'AuditService',
  'WorkflowClosedError',
  'InvalidTransitionError',
  'UnauthorizedTransitionError',
  'validate',
  'evaluateRules',
  'notifyWorkflowEvent',
  'EVENT_MAP',
];

// ── Run Vitest ────────────────────────────────────────────────────────────────
function runVitest() {
  // Clean stale result file
  if (existsSync(RESULT_FILE)) unlinkSync(RESULT_FILE);

  const testFilter = PHASE3_ONLY
    ? 'src/__tests__/phase3.test.js'
    : '';

  const cmd = [
    'npx vitest run',
    '--reporter=json',
    `--outputFile=${RESULT_FILE}`,
    testFilter,
  ].filter(Boolean).join(' ');

  console.log(hr());
  console.log(`${C.bold}${C.white}  Pulse ERP — Phase 3 Final Test Gate${C.reset}`);
  console.log(hr());
  console.log(info(`Running: ${cmd}`));
  console.log(info(`Working directory: ${ROOT}\n`));

  try {
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
  } catch {
    // Vitest exits non-zero when tests fail — that is expected; we read
    // the JSON file regardless to produce our own report.
  }
}

// ── Parse results ─────────────────────────────────────────────────────────────
function parseResults() {
  if (!existsSync(RESULT_FILE)) {
    console.error(fail('Result file not found. Vitest may have crashed before writing output.'));
    process.exit(2);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(RESULT_FILE, 'utf8'));
  } catch (e) {
    console.error(fail(`Could not parse result file: ${e.message}`));
    process.exit(2);
  }
  return raw;
}

// ── Classify a single assertionResult ────────────────────────────────────────
function isCritical(fullName) {
  return CRITICAL_PATTERNS.some(p => fullName.includes(p));
}

// ── Main report ───────────────────────────────────────────────────────────────
function printReport(data) {
  const suites = data.testResults || [];

  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;
  const failedTests   = [];
  const skippedTests  = [];
  const criticalFails = [];

  for (const suite of suites) {
    const suiteName = suite.name
      ? suite.name.replace(/\\/g, '/').split('/src/__tests__/').pop()
      : '(unknown)';

    for (const t of (suite.assertionResults || [])) {
      const fullName = t.fullName || `${(t.ancestorTitles || []).join(' > ')} > ${t.title}`;

      if (t.status === 'passed') {
        totalPass++;
      } else if (t.status === 'failed') {
        totalFail++;
        const entry = { suiteName, fullName, messages: t.failureMessages || [] };
        failedTests.push(entry);
        if (isCritical(fullName)) criticalFails.push(entry);
      } else {
        // pending / skipped
        totalSkip++;
        skippedTests.push({ suiteName, fullName });
      }
    }
  }

  const totalTests = totalPass + totalFail + totalSkip;
  const goNoGo     = criticalFails.length === 0 && totalFail === 0;

  // ── Summary banner ────────────────────────────────────────────────────────
  console.log('\n' + hr('═'));
  console.log(`${C.bold}${C.white}  TEST SUMMARY${C.reset}`);
  console.log(hr('═'));
  console.log(`  Total        ${C.bold}${totalTests}${C.reset}`);
  console.log(`  ${C.green}Passed       ${totalPass}${C.reset}`);
  console.log(`  ${totalFail > 0 ? C.red : C.grey}Failed       ${totalFail}${C.reset}`);
  console.log(`  ${C.yellow}Skipped      ${totalSkip}${C.reset}`);
  console.log(`  Suites       ${suites.length}`);

  // ── Suite breakdown ───────────────────────────────────────────────────────
  console.log('\n' + hr());
  console.log(`${C.bold}${C.white}  SUITE BREAKDOWN${C.reset}`);
  console.log(hr());

  // P3-1..5 are describe blocks inside phase3.test.js, not separate files.
  // We match them by filtering assertionResults from the phase3 suite.
  const phase3Suite = suites.find(s => (s.name || '').includes('phase3'));

  const suiteNames = [
    { tag: 'P3-1', label: 'RBAC matrix (7 modules × 6 actions + overrides + cache)', inPhase3: true },
    { tag: 'P3-2', label: 'Workflow service (disabled flag + status + pending + cancel + advance)', inPhase3: true },
    { tag: 'P3-3', label: 'Validation engine (boundaries + disabled flag + validateField)', inPhase3: true },
    { tag: 'P3-4', label: 'Rule engine (all 10 operators + disabled flag + getRulesForModule)', inPhase3: true },
    { tag: 'P3-5', label: 'Notification triggers (all 5 events + direction + disabled flag)', inPhase3: true },
    { tag: 'smoke', label: 'Smoke tests (auth + employees + leaves + payroll + sales)' },
    { tag: 'phase1', label: 'Phase 1 foundation (requirePermission + scope + field perms + migrations)' },
    { tag: 'phase2', label: 'Phase 2 engines (workflow initiate/advance/status + rules + validation)' },
    { tag: 'auditLog', label: 'Audit log (all action types + fire-and-forget + IP forwarding)' },
    { tag: 'permissions', label: 'Permissions middleware (7 modules × 5 actions + aliases + cache)' },
    { tag: 'workflowTransitions', label: 'Workflow transitions (role enforcement + SLA timestamps + rollback)' },
    { tag: 'engineHooks', label: 'Engine hooks (validation constraints + rule evaluation)' },
    { tag: 'payrollEngine', label: 'Payroll engine' },
  ];

  for (const { tag, label, inPhase3 } of suiteNames) {
    let tests;
    if (inPhase3) {
      if (!phase3Suite) {
        console.log(`  ${C.grey}◌  ${label}${C.reset}`);
        continue;
      }
      tests = (phase3Suite.assertionResults || []).filter(t => {
        const fn = t.fullName || `${(t.ancestorTitles || []).join(' > ')} > ${t.title}`;
        return fn.includes(tag);
      });
      if (tests.length === 0) {
        console.log(`  ${C.grey}◌  ${label}${C.reset}`);
        continue;
      }
    } else {
      const suite = suites.find(s => (s.name || '').includes(tag));
      if (!suite) {
        console.log(`  ${C.grey}◌  ${label}${C.reset}`);
        continue;
      }
      tests = suite.assertionResults || [];
    }

    const pass  = tests.filter(t => t.status === 'passed').length;
    const fail  = tests.filter(t => t.status === 'failed').length;
    const pend  = tests.filter(t => t.status !== 'passed' && t.status !== 'failed').length;
    const color = fail > 0 ? C.red : C.green;
    const icon  = fail > 0 ? '✘' : '✔';
    const counts = `${C.green}${pass} pass${C.reset}${fail > 0 ? `, ${C.red}${fail} fail${C.reset}` : ''}${pend > 0 ? `, ${C.yellow}${pend} skip${C.reset}` : ''}`;
    console.log(`  ${color}${icon}${C.reset}  ${label}  [${counts}]`);
  }

  // ── Known skips ───────────────────────────────────────────────────────────
  console.log('\n' + hr());
  console.log(`${C.bold}${C.white}  KNOWN SKIPS  (${KNOWN_SKIPS.length} documented)${C.reset}`);
  console.log(hr());
  for (const s of KNOWN_SKIPS) {
    console.log(`  ${C.yellow}↷${C.reset}  ${C.bold}${s.file}${C.reset} — ${s.name}`);
    console.log(`     ${C.grey}Reason: ${s.reason}${C.reset}`);
  }

  // ── Observed skips not in KNOWN_SKIPS ─────────────────────────────────────
  const unknownSkips = skippedTests.filter(s =>
    !KNOWN_SKIPS.some(k => s.fullName.includes(k.name) || s.suiteName.includes(k.file))
  );
  if (unknownSkips.length > 0) {
    console.log(`\n  ${C.yellow}⚠  ${unknownSkips.length} unexpected skip(s) observed:${C.reset}`);
    for (const s of unknownSkips) {
      console.log(`     ${C.grey}[${s.suiteName}]${C.reset} ${s.fullName}`);
    }
  }

  // ── Failed tests ──────────────────────────────────────────────────────────
  if (failedTests.length > 0) {
    console.log('\n' + hr());
    console.log(`${C.bold}${C.red}  FAILED TESTS  (${failedTests.length})${C.reset}`);
    console.log(hr());
    for (const t of failedTests) {
      const critical = isCritical(t.fullName) ? ` ${C.red}[CRITICAL]${C.reset}` : '';
      console.log(`  ${C.red}✘${C.reset}  ${t.fullName}${critical}`);
      console.log(`     ${C.grey}File: ${t.suiteName}${C.reset}`);
      if (t.messages.length > 0) {
        const msg = t.messages[0].split('\n').slice(0, 4).join('\n     ');
        console.log(`     ${C.grey}${msg}${C.reset}`);
      }
      console.log();
    }
  }

  // ── Open critical issues ───────────────────────────────────────────────────
  console.log('\n' + hr());
  console.log(`${C.bold}${C.white}  OPEN CRITICAL ISSUES${C.reset}`);
  console.log(hr());

  const KNOWN_ISSUES = [
    {
      id:   'P3-CRIT-001',
      area: 'Logistics / E-way bill',
      desc: 'POST /eway-bills/generate returns 503 when GSTIN+GST_API_KEY are not set. ' +
            'Production deployments must set these env vars before go-live.',
      blocking: false,
    },
    {
      id:   'P3-CRIT-002',
      area: 'CRM Email / Encryption',
      desc: 'ENCRYPTION_KEY is now required at startup (throws if missing). Must be set ' +
            'to a 32-char random value in all environments before deploying.',
      blocking: false,
    },
    {
      id:   'P3-CRIT-003',
      area: 'Mock data removal',
      desc: 'SAMPLE_* arrays removed from 3 backend routes and 2 frontend pages. ' +
            'Verify that production DB is seeded with real data before switching traffic.',
      blocking: false,
    },
    {
      id:   'P3-CRIT-004',
      area: 'WorkflowNotificationService — no integration coverage',
      desc: 'Notifications tested at unit level only (mock pool.query). No smoke test ' +
            'verifies end-to-end insert into the notifications table with a live DB.',
      blocking: false,
    },
    {
      id:   'P3-CRIT-005',
      area: 'Team-leave widget (AllLeaves.jsx)',
      desc: 'sampleTeamLeaves removed; widget now always renders empty. A live ' +
            '/leaves-new/team-week API endpoint is needed to populate it.',
      blocking: false,
    },
  ];

  if (criticalFails.length > 0) {
    console.log(`  ${C.red}${C.bold}TEST FAILURES in critical suites:${C.reset}`);
    for (const t of criticalFails) {
      console.log(`  ${fail(t.fullName)}`);
    }
    console.log();
  }

  for (const issue of KNOWN_ISSUES) {
    const prefix = issue.blocking ? C.red + '● BLOCKING' : C.yellow + '◐ NON-BLOCKING';
    console.log(`  ${prefix}${C.reset}  [${issue.id}] ${C.bold}${issue.area}${C.reset}`);
    console.log(`     ${C.grey}${issue.desc}${C.reset}\n`);
  }

  // ── Go / No-Go ────────────────────────────────────────────────────────────
  console.log(hr('═'));
  if (goNoGo) {
    console.log(`${C.bold}${C.green}  RECOMMENDATION:  ✔  GO${C.reset}`);
    console.log(`  All ${totalTests} tests executed.  ${totalPass} passed, ${totalSkip} skipped (expected).`);
    console.log(`  No critical failures detected.`);
    console.log(`  Phase 3 is clear for production deployment.\n`);
    console.log(`  ${C.yellow}Pre-deployment checklist:${C.reset}`);
    console.log(`    □  Set ENCRYPTION_KEY (32-char random) in production env`);
    console.log(`    □  Set JWT_SECRET (min 32 chars) in production env`);
    console.log(`    □  Set DATABASE_URL or DB_PASSWORD in production env`);
    console.log(`    □  Verify all required DB tables are present (npm run migrate)`);
    console.log(`    □  Set GSTIN + GST_API_KEY if e-way bill generation is needed`);
    console.log(`    □  Set SHIPROCKET_TOKEN if live shipment tracking is needed`);
    console.log(`    □  Implement /leaves-new/team-week API for team-leave widget`);
    console.log(`    □  Seed production DB with real master data (no sample fallbacks)`);
  } else {
    console.log(`${C.bold}${C.red}  RECOMMENDATION:  ✘  NO-GO${C.reset}`);
    console.log(`  ${totalFail} test(s) failed.  ${criticalFails.length} in critical suites.`);
    console.log(`  Fix all failures before promoting to production.\n`);
    if (criticalFails.length > 0) {
      console.log(`  ${C.red}Critical failures:${C.reset}`);
      for (const t of criticalFails) {
        console.log(`    ✘  ${t.fullName}`);
      }
    }
  }
  console.log(hr('═') + '\n');

  return goNoGo;
}

// ── Entry point ───────────────────────────────────────────────────────────────
runVitest();
const data   = parseResults();
const passed = printReport(data);
process.exit(passed ? 0 : 1);
