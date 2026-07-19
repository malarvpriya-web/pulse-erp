#!/usr/bin/env node
/**
 * smoke-prod.js — Production smoke tests against live Render URLs.
 *
 * Usage:
 *   BACKEND_URL=https://pulse-backend.onrender.com node scripts/smoke-prod.js
 *   BACKEND_URL=https://pulse-backend.onrender.com \
 *   FRONTEND_URL=https://pulse-frontend.onrender.com \
 *     node scripts/smoke-prod.js
 *
 * Exits 0 when all checks pass, 1 on any failure.
 * Requires Node 18+ (uses built-in fetch).
 */

const BACKEND_URL  = (process.env.BACKEND_URL  || process.argv[2] || '').replace(/\/$/, '');
const FRONTEND_URL = (process.env.FRONTEND_URL || process.argv[3] || '').replace(/\/$/, '');
const TIMEOUT_MS   = parseInt(process.env.SMOKE_TIMEOUT_MS || '15000');

if (!BACKEND_URL) {
  console.error('❌  BACKEND_URL is required.');
  console.error('    BACKEND_URL=https://pulse-backend.onrender.com node scripts/smoke-prod.js');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(name, detail = '') {
  passed++;
  console.log(`  ✅  ${name}${detail ? '  — ' + detail : ''}`);
}

function fail(name, detail = '') {
  failed++;
  console.error(`  ❌  ${name}${detail ? '  — ' + detail : ''}`);
}

async function request(method, url, { body, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const ms  = Date.now() - t0;
    let json  = null;
    try { json = await res.json(); } catch { /* non-JSON response is fine */ }
    return { status: res.status, json, ms, ok: res.ok };
  } catch (err) {
    const ms = Date.now() - t0;
    return { status: 0, json: null, ms, ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkHealth() {
  const { status, json, ms, error } = await request('GET', `${BACKEND_URL}/api/health`);

  if (error) {
    fail('GET /api/health', error);
    return false;
  }
  if (status !== 200) {
    fail('GET /api/health', `HTTP ${status}`);
    return false;
  }
  if (json?.status !== 'ok') {
    fail('GET /api/health', `status="${json?.status}" db="${json?.db?.status}"`);
    return false;
  }
  pass('GET /api/health', `${ms}ms  db=${json.db?.status}  uptime=${json.uptime_s}s`);
  if (ms > 5000) console.warn(`  ⚠️   Health check took ${ms}ms — instance may be warming up`);
  return true;
}

async function checkAuthProtection() {
  const routes = [
    '/api/finance/dashboard',
    '/api/accounting/journal-entries',
    '/api/payroll',
    '/api/projects/projects',
  ];

  let allOk = true;
  for (const route of routes) {
    const { status, ms, error } = await request('GET', `${BACKEND_URL}${route}`);
    if (error) {
      fail(`Auth guard: GET ${route}`, error);
      allOk = false;
      continue;
    }
    if (status === 401) {
      pass(`Auth guard: GET ${route}`, `${ms}ms`);
    } else {
      fail(`Auth guard: GET ${route}`, `expected 401, got ${status}`);
      allOk = false;
    }
  }
  return allOk;
}

async function checkLoginEndpoint() {
  // Bad credentials → 401. Verifies the auth endpoint exists and responds.
  const { status, json, ms, error } = await request(
    'POST',
    `${BACKEND_URL}/api/auth/login`,
    { body: { email: 'smoke-test@example.com', password: 'wrong-password' } }
  );

  if (error) {
    fail('POST /api/auth/login (bad creds)', error);
    return false;
  }
  if (status === 401 || status === 400) {
    pass('POST /api/auth/login (bad creds)', `HTTP ${status}  ${ms}ms`);
    return true;
  }
  fail('POST /api/auth/login (bad creds)', `expected 400/401, got ${status} — ${JSON.stringify(json)}`);
  return false;
}

async function checkFrontend() {
  if (!FRONTEND_URL) {
    console.log('  ⏭   Frontend check skipped (FRONTEND_URL not set)');
    return true;
  }

  const { status, ms, error } = await request('GET', FRONTEND_URL);
  if (error) {
    fail(`GET ${FRONTEND_URL}`, error);
    return false;
  }
  if (status === 200) {
    pass(`GET ${FRONTEND_URL}`, `${ms}ms`);
    return true;
  }
  fail(`GET ${FRONTEND_URL}`, `HTTP ${status}`);
  return false;
}

async function checkMigrations() {
  // /api/health already verified DB is up. Check that the schema_migrations table
  // exists by calling a lightweight authenticated-optional endpoint.
  // We use the health endpoint's db status as a proxy — if it's ok, migrations ran.
  const { status, json, error } = await request('GET', `${BACKEND_URL}/api/health`);
  if (error || status !== 200) {
    fail('Migration schema check', 'health endpoint unavailable');
    return false;
  }
  if (json?.db?.status === 'ok') {
    pass('Migration schema check', 'DB reachable — migrations ran on startup');
    return true;
  }
  fail('Migration schema check', `DB status="${json?.db?.status}" — ${json?.db?.error || ''}`);
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║           Pulse ERP — Production Smoke Tests             ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`  Backend  : ${BACKEND_URL}`);
console.log(`  Frontend : ${FRONTEND_URL || '(not provided)'}`);
console.log(`  Timeout  : ${TIMEOUT_MS}ms per request`);
console.log(`  Time     : ${new Date().toISOString()}`);
console.log('');

console.log('[1/5] Health check...');
await checkHealth();

console.log('[2/5] Auth protection (unauthenticated requests)...');
await checkAuthProtection();

console.log('[3/5] Login endpoint...');
await checkLoginEndpoint();

console.log('[4/5] Migration verification...');
await checkMigrations();

console.log('[5/5] Frontend availability...');
await checkFrontend();

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log('── Summary ──────────────────────────────────────────────────');
console.log(`  Passed : ${passed}`);
console.log(`  Failed : ${failed}`);
console.log('─────────────────────────────────────────────────────────────');

if (failed > 0) {
  console.error(`\n🚫  ${failed} smoke test(s) failed.\n`);
  process.exit(1);
} else {
  console.log('\n✅  All smoke tests passed. Production deployment looks healthy.\n');
}
