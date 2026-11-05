/**
 * candidateLegalHold.js — place, amend or release a legal hold on a candidate.
 *
 * A hold stops the retention job (jobs/candidateRetention.cron.js) from
 * anonymising the candidate and from queueing their résumé for deletion, until
 * it is released. Authority is the route's: recruitment:approve (admin,
 * super_admin, hr_manager in the matrix) — not recruitment:edit, which recruiters,
 * managers and department heads hold.
 *
 * Every change runs in ONE transaction that:
 *   1. locks the candidate row (SELECT … FOR UPDATE, own company only) — the same
 *      lock the retention job's anonymise() takes, so a hold and an anonymisation
 *      of the same candidate are strictly ordered, never interleaved;
 *   2. refuses an anonymised record (nothing left to hold) and a state that does
 *      not fit the action (place on held, amend/release on not held);
 *   3. updates the candidate and writes a candidate_retention_log row
 *      (hold_placed / hold_amended / hold_released, full reason, triggered_by).
 * After COMMIT the change is also written to audit_logs (logAudit) with the
 * before and after hold fields.
 */
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';

export class LegalHoldError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const REASON_MIN = 5;
export const REASON_MAX = 500;

const ACTIONS = {
  place:   { log: 'hold_placed',   needsHeld: false, audit: 'legal_hold_place' },
  amend:   { log: 'hold_amended',  needsHeld: true,  audit: 'legal_hold_amend' },
  release: { log: 'hold_released', needsHeld: true,  audit: 'legal_hold_release' },
};

const HOLD_FIELDS = 'id, company_id, legal_hold, legal_hold_reason, legal_hold_by, legal_hold_at, anonymised_at';

/**
 * @param {{ action: 'place'|'amend'|'release', candidateId: any, companyId: number,
 *           userId: number|null, reason: any, req?: object }} p
 * @returns {Promise<object>} the candidate's hold fields after the change
 * @throws {LegalHoldError} 400 bad input, 403 no company, 404 not found, 409 wrong state
 */
export async function changeLegalHold({ action, candidateId, companyId, userId, reason, req = null }) {
  const spec = ACTIONS[action];
  if (!spec) throw new LegalHoldError(400, 'Unknown legal-hold action');
  if (companyId == null) throw new LegalHoldError(403, 'No company context for this login');
  if (!/^\d+$/.test(String(candidateId))) throw new LegalHoldError(400, 'Invalid candidate id');
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < REASON_MIN || text.length > REASON_MAX) {
    throw new LegalHoldError(400, `A reason of ${REASON_MIN}–${REASON_MAX} characters is required`);
  }

  const client = await pool.connect();
  let before;
  let after;
  try {
    await client.query('BEGIN');
    ({ rows: [before] } = await client.query(
      `SELECT ${HOLD_FIELDS} FROM candidates
        WHERE id = $1 AND company_id = $2::int AND deleted_at IS NULL
        FOR UPDATE`,
      [Number(candidateId), companyId]));
    if (!before) throw new LegalHoldError(404, 'Candidate not found');
    if (before.anonymised_at) {
      throw new LegalHoldError(409, 'This candidate has already been anonymised; there is no record left to hold.');
    }
    if (spec.needsHeld && !before.legal_hold) throw new LegalHoldError(409, 'This candidate is not under legal hold.');
    if (!spec.needsHeld && before.legal_hold) {
      throw new LegalHoldError(409, 'This candidate is already under legal hold. Amend the hold to change its reason.');
    }

    ({ rows: [after] } = await client.query(
      action === 'release'
        ? `UPDATE candidates
              SET legal_hold = false, legal_hold_reason = NULL, legal_hold_by = NULL, legal_hold_at = NULL,
                  updated_at = NOW()
            WHERE id = $1 RETURNING ${HOLD_FIELDS}`
        : `UPDATE candidates
              SET legal_hold = true, legal_hold_reason = $2, legal_hold_by = $3, legal_hold_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1 RETURNING ${HOLD_FIELDS}`,
      action === 'release' ? [before.id] : [before.id, text, userId]));

    await client.query(
      `INSERT INTO candidate_retention_log (company_id, candidate_id, action, reason, triggered_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [before.company_id, before.id, spec.log, text, userId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // logAudit is fire-and-forget and returns undefined — never .catch() it.
  logAudit({
    userId, module: 'recruitment', recordId: after.id, recordType: 'candidate',
    action: spec.audit, company_id: after.company_id, req,
    oldData: { legal_hold: before.legal_hold, legal_hold_reason: before.legal_hold_reason,
               legal_hold_by: before.legal_hold_by, legal_hold_at: before.legal_hold_at },
    newData: { legal_hold: after.legal_hold, legal_hold_reason: after.legal_hold_reason,
               legal_hold_by: after.legal_hold_by, legal_hold_at: after.legal_hold_at, reason: text },
  });
  const { anonymised_at: _a, ...hold } = after;
  return hold;
}
