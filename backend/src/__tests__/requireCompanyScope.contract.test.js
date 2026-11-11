/**
 * requireCompanyScope (shared/scope.js) and where it is mounted (2026-11-10).
 *
 * The routers below scope with `req.scope?.company_id ?? null`, where null is
 * "every company". verifyToken leaves req.scope null for a non-super-admin
 * with no company — 22 active pilot.* logins on 11-10, among them
 * finance_manager, hr_manager and payroll_admin — so each of these routers
 * served them every tenant's data. The guard is what stops that; this file
 * fails if a mount loses it.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCompanyScope } from '../shared/scope.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '..', '..', p), 'utf8');

function run(req) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  const next = vi.fn();
  requireCompanyScope(req, res, next);
  return { res, next, req };
}

describe('requireCompanyScope', () => {
  it('a non-super-admin with no company is refused, and nothing downstream runs', () => {
    const { res, next } = run({ user: { userId: 901, roles: ['hr_exec'], company_id: null }, scope: null });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NO_COMPANY_SCOPE');
  });

  it('a scope that says company null WITHOUT isGlobal is refused too', () => {
    const { res, next } = run({ user: { roles: ['finance_manager'] }, scope: { company_id: null } });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('a global super-admin scope passes unchanged', () => {
    const scope = { company_id: null, branch_id: null, isGlobal: true };
    const { next, req } = run({ user: { roles: ['super_admin'] }, scope });
    expect(next).toHaveBeenCalledOnce();
    expect(req.scope).toBe(scope);
  });

  it('a company scope passes unchanged', () => {
    const scope = { company_id: 1, branch_id: 4 };
    const { next, req } = run({ user: { company_id: 1 }, scope });
    expect(next).toHaveBeenCalledOnce();
    expect(req.scope).toBe(scope);
  });

  it('a company only on the user record is copied onto req.scope, so `req.scope?.company_id` cannot read null', () => {
    const { next, req } = run({ user: { company_id: '7' }, scope: null });
    expect(next).toHaveBeenCalledOnce();
    expect(req.scope).toMatchObject({ company_id: 7, isGlobal: false });
  });
});

describe('where it is mounted', () => {
  const SERVER = read('server.js');
  const mountOf = (prefix, router) => {
    const re = new RegExp(`v1Router\\.use\\("${prefix.replace('/', '\\/')}",([^\\n]*?)\\b${router}\\)`);
    const m = SERVER.match(re);
    expect(m, `${prefix} → ${router} mount`).toBeTruthy();
    return m[1];
  };

  it.each([
    ['/leaves',     'leavesNewRoutes'],
    ['/leaves-new', 'leavesNewRoutes'],
    ['/finance',    'financeRoutes'],
    ['/finance',    'extendedFinanceRoutes'],
    ['/inventory',  'inventoryRoutes'],
    ['/hr',         'hrRoutes'],
    ['/admin',      'adminRoutes'],
    ['/dashboard',  'dashboardRoutes'],
    ['/ai',         'aiCombined'],
  ])('%s (%s): verifyToken, then requireCompanyScope, before anything else', (prefix, router) => {
    const chain = mountOf(prefix, router);
    expect(chain).toMatch(/^\s*verifyToken,\s*requireCompanyScope,/);
  });

  it('orgchart and analytics guard inside their routers (orgchart authenticates itself)', () => {
    const org = read('src/modules/orgchart/routes/orgchart.routes.js');
    expect(org.indexOf('router.use(requireCompanyScope)')).toBeGreaterThan(org.indexOf('router.use(verifyToken)'));
    const analytics = read('src/analytics/routes/analytics.routes.js');
    const guard = analytics.indexOf('router.use(requireCompanyScope)');
    expect(guard).toBeGreaterThan(0);
    // Before the first route and before the sub-routers.
    expect(guard).toBeLessThan(analytics.indexOf("router.use('/pq'"));
    expect(guard).toBeLessThan(analytics.search(/router\.(get|put|post)\(/));
  });

  it('server.js imports the shared guard (one definition, not copies)', () => {
    expect(SERVER).toMatch(/import \{ requireCompanyScope \} from "\.\/src\/shared\/scope\.js"/);
  });
});
