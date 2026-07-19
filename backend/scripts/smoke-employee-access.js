#!/usr/bin/env node
/**
 * Smoke test — employee self-service scoping (backend).
 *
 * Verifies the changes to servicedesk.routes.js + exit.routes.js:
 *   - an employee CAN still use self-service (My Tickets, raise ticket, KB)
 *   - an employee CANNOT reach management endpoints (SLA config, all tickets,
 *     exit/offboarding) — these must return 403 now that the 'service' →
 *     'servicedesk' module-name bug is fixed and exit is HR-only.
 *
 * Usage (PowerShell):
 *   $env:EMP_EMAIL="employee@company.com"; $env:EMP_PASSWORD="secret"; npm run smoke:access
 *
 * Or, to test authorization without passwords, pass pre-minted JWTs:
 *   $env:EMP_TOKEN="<jwt>"; $env:ADMIN_TOKEN="<jwt>"; npm run smoke:access
 *   (see scripts/mint-token.js — minted with the app's own JWT_SECRET)
 *
 * Optional:
 *   $env:BASE_URL="http://localhost:5000/api/v1"   (default; use 127.0.0.1 if
 *                                                    Node resolves localhost to IPv6)
 *   $env:ADMIN_EMAIL / $env:ADMIN_PASSWORD          (positive control: admin
 *                                                    SHOULD reach the same
 *                                                    management endpoints)
 *
 * Requires Node 18+ (global fetch). Exit code is non-zero if any check fails.
 */

const BASE = process.env.BASE_URL || 'http://localhost:5000/api/v1';

const EMP = { email: process.env.EMP_EMAIL, password: process.env.EMP_PASSWORD, token: process.env.EMP_TOKEN };
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, token: process.env.ADMIN_TOKEN };

let failures = 0;

function log(pass, name, detail) {
  const tag = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!pass) failures++;
}

// Decode a JWT payload (no verification) — used to recover email/role when the
// caller supplies a pre-minted token instead of credentials.
function decodeJwt(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return { email: p.email, role: p.role };
  } catch { return {}; }
}

async function authenticate({ email, password, token }) {
  if (token) return { token, user: decodeJwt(token) };
  if (!email || !password) throw new Error('missing credentials (set *_EMAIL/*_PASSWORD or *_TOKEN)');
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.token) throw new Error(`login failed (${r.status}): ${body.error || body.message || 'no token'}`);
  return { token: body.token, user: body.user };
}

async function call(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

// A check that asserts an expected HTTP status.
async function expectStatus(name, expected, method, path, token, body) {
  try {
    const { status } = await call(method, path, token, body);
    log(status === expected, name, `expected ${expected}, got ${status}`);
  } catch (e) {
    log(false, name, e.message);
  }
}

(async () => {
  console.log(`\nSmoke test against ${BASE}\n`);

  // ── Employee ───────────────────────────────────────────────────────────────
  let emp;
  try {
    emp = await authenticate(EMP);
    log(emp.user?.role === 'employee', 'employee auth', `role=${emp.user?.role}`);
  } catch (e) {
    log(false, 'employee auth', e.message);
    console.log('\nCannot continue without an employee token. Set EMP_EMAIL/EMP_PASSWORD or EMP_TOKEN.\n');
    process.exit(1);
  }

  console.log('\n Self-service (should WORK):');
  await expectStatus('GET /servicedesk/tickets/my            → 200', 200, 'GET', '/servicedesk/tickets/my', emp.token);
  await expectStatus('GET /servicedesk/knowledge-base        → 200', 200, 'GET', '/servicedesk/knowledge-base', emp.token);

  // Create own ticket, then confirm the requester was forced to the caller.
  let createdTicketId = null;
  try {
    const { status, body } = await call('POST', '/servicedesk/tickets', emp.token, {
      title: 'Smoke test ticket', description: 'automated smoke test', category: 'IT', priority: 'Low',
      // deliberately try to spoof another requester — server must override it:
      requester_email: 'someone-else@evil.com', requester_name: 'Someone Else',
    });
    log(status === 201, 'POST /servicedesk/tickets           → 201', `got ${status}`);
    if (status === 201) {
      createdTicketId = body.id;
      log(body.requester_email === emp.user.email,
          'created ticket requester forced to caller',
          `requester_email=${body.requester_email}`);
    }
  } catch (e) {
    log(false, 'POST /servicedesk/tickets', e.message);
  }

  console.log('\n Management endpoints (should be BLOCKED → 403):');
  await expectStatus('GET /servicedesk/sla/policies          → 403', 403, 'GET', '/servicedesk/sla/policies', emp.token);
  await expectStatus('GET /servicedesk/tickets (all)         → 403', 403, 'GET', '/servicedesk/tickets', emp.token);
  await expectStatus('GET /servicedesk/engineers             → 403', 403, 'GET', '/servicedesk/engineers', emp.token);
  await expectStatus('GET /servicedesk/contracts             → 403', 403, 'GET', '/servicedesk/contracts', emp.token);
  await expectStatus('GET /exit/requests                     → 403', 403, 'GET', '/exit/requests', emp.token);
  await expectStatus('GET /exit/interviews                   → 403', 403, 'GET', '/exit/interviews', emp.token);

  // ── Admin positive control (optional) ────────────────────────────────────────
  let adminToken = null;
  if ((ADMIN.email && ADMIN.password) || ADMIN.token) {
    console.log('\n Admin positive control (should WORK → 200):');
    try {
      const admin = await authenticate(ADMIN);
      adminToken = admin.token;
      await expectStatus('GET /servicedesk/sla/policies          → 200', 200, 'GET', '/servicedesk/sla/policies', admin.token);
      await expectStatus('GET /exit/requests                     → 200', 200, 'GET', '/exit/requests', admin.token);
    } catch (e) {
      log(false, 'admin login', e.message);
    }
  } else {
    console.log('\n (skip admin positive control — set ADMIN_EMAIL / ADMIN_PASSWORD to enable)');
  }

  // ── Cleanup — soft-delete the ticket we created (needs admin) ─────────────────
  if (createdTicketId && adminToken) {
    const { status } = await call('DELETE', `/servicedesk/tickets/${createdTicketId}`, adminToken);
    console.log(`\n cleanup: deleted smoke ticket #${createdTicketId} (status ${status})`);
  } else if (createdTicketId) {
    console.log(`\n cleanup: left ticket #${createdTicketId} (provide ADMIN creds to auto-delete)`);
  }

  console.log(`\n${failures === 0 ? '\x1b[32mAll checks passed.\x1b[0m' : `\x1b[31m${failures} check(s) failed.\x1b[0m`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
