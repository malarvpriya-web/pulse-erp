/**
 * scope.js — tenant scope resolution for the IoT module, with the fail-open
 * removed.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 * -------------------------------
 * Every IoT route used to open with:
 *
 *     const companyId = req.scope?.company_id ?? null;
 *     ...
 *     if (companyId != null) { q += ' AND ce.company_id = $n'; }
 *
 * verifyToken sets `req.scope = null` for any authenticated non-super-admin who
 * has no `user_scope` row — which is not a rare state: it is the state of every
 * account created before scoping existed, every service account, and every user
 * whose scope row was not backfilled. For those callers `companyId` was null, the
 * predicate was omitted, and the query returned **every company's devices,
 * telemetry, alerts and rules**. The same null also made the ownership check in
 * `scopedEquipment()` vanish, so a device id from another tenant resolved
 * successfully and could be provisioned, rotated or ruled on.
 *
 * Missing scope now means DENY. Only a scope that is explicitly global — a
 * super-admin, which verifyToken marks with `isGlobal: true` — may read across
 * companies, and even then every write still names a single company.
 *
 * USAGE
 *   const scope = iotScope(req);
 *   if (!scope.ok) return denyScope(res, scope);
 *   // scope.companyId : number, or null ONLY when scope.isGlobal is true
 *   // scope.isGlobal  : true for super-admin
 *
 * For writes, prefer writeCompany(scope, body) — a global caller must state which
 * company it is writing for rather than having one silently defaulted.
 */

/**
 * Resolve the caller's IoT tenant scope.
 * @returns {{ok: true, companyId: number|null, isGlobal: boolean} | {ok: false, reason: string}}
 */
export function iotScope(req) {
  if (!req?.user) return { ok: false, reason: 'UNAUTHENTICATED' };

  const s = req.scope;

  // Explicit global scope — super admin. verifyToken is the only place that sets
  // this, and only for a role in SUPER_CODES.
  if (s && s.isGlobal === true) {
    return { ok: true, companyId: null, isGlobal: true };
  }

  const raw = s?.company_id;
  if (raw == null || raw === '') {
    // No company, and not global. This is the case that used to read as
    // "all companies".
    return { ok: false, reason: 'NO_COMPANY_SCOPE' };
  }

  const companyId = parseInt(String(raw), 10);
  if (!Number.isInteger(companyId)) return { ok: false, reason: 'BAD_COMPANY_SCOPE' };

  return { ok: true, companyId, isGlobal: false };
}

/** Standard 403 for a caller with no usable scope. */
export function denyScope(res, scope) {
  const reason = scope?.reason || 'NO_COMPANY_SCOPE';
  if (reason === 'UNAUTHENTICATED') {
    return res.status(401).json({ error: 'Unauthorized', code: reason });
  }
  return res.status(403).json({
    error: 'Forbidden',
    code: reason,
    message:
      'Your account has no company assignment, so it cannot access company data. ' +
      'Ask an administrator to assign your user scope.',
  });
}

/**
 * The company a WRITE belongs to.
 *
 * A scoped caller writes to their own company and may not name another. A global
 * (super-admin) caller must name one explicitly — defaulting it to 1, which the
 * old `req.scope?.company_id ?? 1` did, silently filed super-admin writes under
 * Manifest Electra regardless of which tenant the operator was looking at.
 *
 * @returns {{ok: true, companyId: number} | {ok: false, reason: string}}
 */
export function writeCompany(scope, body = {}) {
  if (!scope?.ok) return { ok: false, reason: scope?.reason || 'NO_COMPANY_SCOPE' };
  if (!scope.isGlobal) {
    const asked = body?.company_id;
    if (asked != null && parseInt(String(asked), 10) !== scope.companyId) {
      return { ok: false, reason: 'COMPANY_MISMATCH' };
    }
    return { ok: true, companyId: scope.companyId };
  }
  const asked = body?.company_id;
  const companyId = asked == null ? NaN : parseInt(String(asked), 10);
  if (!Number.isInteger(companyId)) return { ok: false, reason: 'COMPANY_REQUIRED' };
  return { ok: true, companyId };
}

/**
 * SQL fragment + params for "rows this caller may see".
 *
 * Returns `{ sql, params }` where sql is either '' (global) or
 * ' AND <col> = $n'. The caller passes the running params array so numbering
 * stays correct.
 */
export function companyPredicate(scope, column, params) {
  if (scope.isGlobal) return '';
  params.push(scope.companyId);
  return ` AND ${column} = $${params.length}`;
}

/**
 * Fetch one equipment row the caller is allowed to act on, or null.
 *
 * Unlike the old scopedEquipment(), a caller with no company scope never gets
 * here — iotScope() has already denied. A global caller may resolve any row.
 */
export async function scopedEquipment(pool, id, scope, { forUpdate = false } = {}) {
  const numeric = parseInt(String(id), 10);
  if (!Number.isInteger(numeric)) return null;
  const params = [numeric];
  let sql = `SELECT * FROM customer_equipment WHERE id = $1`;
  sql += companyPredicate(scope, 'company_id', params);
  if (forUpdate) sql += ' FOR UPDATE';
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}
