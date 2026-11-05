/**
 * employeeAssetScope.contract.test.js — every employee-asset write is scoped
 * (2026-09-29).
 *
 * THE DEFECT THIS FILE EXISTS FOR
 * -------------------------------
 * `POST /employee-assets` was tenant-scoped on 2026-09-28. SIX sibling write
 * routes were flagged in that pass and left open, each one reading its row with
 * a bare `WHERE id=$1` and then updating it:
 *
 *     PUT    /:id                      rename / re-tag / change status
 *     PATCH  /:id/return               mark returned
 *     POST   /:id/transfer             reassign to another employee
 *     POST   /:id/maintenance          take out of service
 *     POST   /:id/maintenance/complete put back in service
 *     PATCH  /:id/dispose              scrap / write off
 *
 * An HR user in company A could do any of those to company B's laptop by
 * guessing an id, and the audit entry would be filed against A. `/:id/transfer`
 * was worse still: `to_employee_id` was unchecked, so an asset could be moved
 * OUT of its tenant to a person in another one, leaving a row that claims
 * company A and points at an employee in B — the exact corruption the POST fix
 * was for.
 *
 * This is a source contract; `employeeAssetScope.integration.test.js` proves
 * the predicates work against the live database.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '../modules/hr/employee-assets.routes.js'), 'utf8');

/**
 * The same file with comments stripped.
 *
 * ⚠ The "must not contain" checks below have to run against CODE. The header
 * and several handlers quote the old unscoped patterns verbatim to explain what
 * was wrong, so a plain search matches the explanation and reports a defect
 * that is not there — which is exactly the kind of false positive that gets a
 * real assertion deleted.
 */
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(String.fromCharCode(10))
  .filter(l => !l.trim().startsWith('//'))
  .join(String.fromCharCode(10));

/** Every route this file registers, with its declaration line. */
const ROUTES = [...SRC.matchAll(/^router\.(get|post|put|patch|delete)\('([^']+)'[^\n]*/gm)]
  .map(m => ({ method: m[1].toUpperCase(), path: m[2], line: m[0] }));

const WRITES = ROUTES.filter(r => r.method !== 'GET');

/** The body of one route handler, from its declaration to the next one. */
function bodyOf(route) {
  const start = SRC.indexOf(route.line);
  const nextIdx = ROUTES
    .map(r => SRC.indexOf(r.line))
    .filter(i => i > start)
    .sort((a, b) => a - b)[0] ?? SRC.length;
  return SRC.slice(start, nextIdx);
}

// ═════════════════════════════════════════════════════════════════════════════
describe('every write route is tenant-scoped', () => {
  it('finds the routes it means to check', () => {
    // A rename that made this file silently check nothing would otherwise pass.
    expect(WRITES.length).toBeGreaterThanOrEqual(8);
    const paths = WRITES.map(w => `${w.method} ${w.path}`);
    for (const expected of [
      'POST /', 'PUT /:id', 'PATCH /:id/return', 'POST /:id/transfer',
      'POST /:id/maintenance', 'POST /:id/maintenance/complete',
      'PATCH /:id/dispose', 'DELETE /:id',
    ]) {
      expect(paths, expected).toContain(expected);
    }
  });

  it.each(
    WRITES.filter(w => w.path !== '/').map(w => [`${w.method} ${w.path}`, w])
  )('%s reads its row through the scoped helper', (_name, route) => {
    const body = bodyOf(route);
    // Either the shared loader, or an explicit company predicate on the read.
    const scopedRead = /loadOwnedAllocation\(req, res\)/.test(body)
      || /FROM employee_asset_allocations WHERE id=\$1 AND \(\$2::int IS NULL OR company_id=\$2\)/.test(body);
    expect(scopedRead, `${_name} reads the allocation unscoped`).toBe(true);
  });

  it.each(
    WRITES.filter(w => w.method !== 'DELETE' && w.path !== '/').map(w => [`${w.method} ${w.path}`, w])
  )('%s also scopes the UPDATE itself', (_name, route) => {
    const body = bodyOf(route);
    // Scoping only the read leaves a TOCTOU gap, and more practically it is one
    // refactor away from someone dropping the read.
    expect(body, `${_name} updates without a scope clause`).toMatch(/\$\{scope\.where\}/);
    // …and a scoped UPDATE that matches nothing must 404 rather than throw on
    // rows[0] being undefined.
    expect(body, `${_name} does not handle a 0-row update`).toMatch(/if \(!rows\.length\) return res\.status\(404\)/);
  });

  it('no write route reads an allocation with a bare WHERE id', () => {
    for (const w of WRITES) {
      const body = bodyOf(w);
      expect(
        /SELECT \* FROM employee_asset_allocations WHERE id=\$1`/.test(body),
        `${w.method} ${w.path} still reads unscoped`,
      ).toBe(false);
    }
  });

  it('every route is behind a role gate', () => {
    for (const r of ROUTES) {
      expect(
        /allowRoles\(|requirePermission\(/.test(r.line),
        `${r.method} ${r.path} has no authorization`,
      ).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the destination of a transfer is checked too', () => {
  const transfer = WRITES.find(w => w.path === '/:id/transfer');

  it('verifies to_employee_id belongs to the caller\'s company', () => {
    const body = bodyOf(transfer);
    expect(body).toMatch(/SELECT id FROM employees[\s\S]{0,160}company_id = \$2/);
    expect(body).toMatch(/Employee not found in this company/);
  });

  it('would otherwise move an asset out of its tenant', () => {
    // Documented in the handler, because the scoping on the allocation alone
    // reads as sufficient until you notice the destination is free.
    expect(bodyOf(transfer)).toMatch(/transferred OUT of this tenant/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('scope comes from the token, never the client', () => {
  it('uses companyOf(req) throughout', () => {
    expect(SRC).toMatch(/import \{ companyOf \}/);
    // `req.scope?.company_id` read directly is the pattern companyOf exists to
    // replace — it misses the req.user fallback and reads as scoped when it is
    // not. See shared/scope.js.
    expect(CODE).not.toMatch(/req\.scope\?\.company_id/);
  });

  it('GET / no longer honours ?company_id=', () => {
    // It was `req.scope?.company_id ?? qCid ?? null`, so any caller whose scope
    // resolved to null could name a tenant and read its asset register.
    expect(CODE).not.toMatch(/company_id: qCid/);
    expect(CODE).not.toMatch(/\?\? qCid/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('asset type stays master-validated', () => {
  it('POST still checks the ASSET_TYPE master', () => {
    // Guarding against a regression in the 2026-09-28 fix while this file was
    // rewriting its neighbours.
    const post = bodyOf(WRITES.find(w => w.path === '/'));
    expect(post).toMatch(/type = 'ASSET_TYPE'/);
    expect(post).toMatch(/is not a valid asset type/);
    expect(post).toMatch(/company_id IS NULL OR company_id = \$1/);
  });

  it('POST still checks the employee belongs to the caller', () => {
    const post = bodyOf(WRITES.find(w => w.path === '/'));
    expect(post).toMatch(/SELECT id FROM employees[\s\S]{0,160}company_id = \$2/);
  });
});
