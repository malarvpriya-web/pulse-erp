import cron from 'node-cron';
import pool from '../config/db.js';
import { purgeQueuedResumes } from './candidateResumePurge.js';

/**
 * Candidate data retention — the half of a retention policy that actually runs.
 *
 * Migration 20260917000037 added consent and a `retain_until` date. A date
 * nothing acts on is a promise, not a policy, so this is the job that keeps it:
 * every night it finds candidates whose retention has expired, or who have
 * withdrawn consent, and ANONYMISES them.
 *
 * ── ANONYMISE, NOT DELETE ───────────────────────────────────────────────────
 * `DELETE FROM candidates` would cascade through interviews, offers, stage
 * history and applications, and take the company's own hiring record with it —
 * "how many people did we interview for this role in 2026" is a legitimate
 * question that survives the individual's right to be forgotten. So the personal
 * data is destroyed in place and the skeleton is kept: stage, dates, outcome,
 * the opening they applied to. What is erased is everything that identifies a
 * person — name, email, phone, employer, notes, résumé text and the résumé file
 * itself.
 *
 * The email is replaced with a per-candidate placeholder rather than NULL,
 * because `candidates_company_email_uniq` would otherwise collide the moment a
 * second candidate is anonymised.
 *
 * ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
 *  - anyone under LEGAL HOLD (`candidates.legal_hold`), whatever their retention
 *    date — and even after a consent withdrawal: a hold exists precisely so that
 *    erasure waits for the legal matter. Checked in findDue() AND again under the
 *    row lock in anonymise(); nothing of theirs is queued for file deletion.
 *    Placed / amended / released only by recruitment:approve holders
 *    (POST/PUT/DELETE /recruitment/candidates/:id/legal-hold). Counted per run
 *    as `held_skipped`;
 *  - anyone still active in a pipeline (`overall_status = 'active'`), unless
 *    they have explicitly withdrawn consent. A retention date must not delete
 *    someone mid-interview;
 *  - anyone who was hired. Their record has become an employment record with a
 *    different lawful basis and a different retention period, handled by HR;
 *  - `consent_basis = 'legacy'` rows, which predate consent capture and have no
 *    retention date — somebody has to decide about those deliberately.
 *
 * Every action is written to `candidate_retention_log`. A purge that leaves no
 * evidence cannot answer the one question a regulator asks.
 */

const SCHEDULE = process.env.CANDIDATE_RETENTION_CRON || '25 3 * * *';   // 03:25 daily
const BATCH    = parseInt(process.env.CANDIDATE_RETENTION_BATCH || '500', 10);

/**
 * Candidates due for anonymisation.
 *
 * Two independent reasons, deliberately kept in one query so a withdrawal and
 * an expiry are handled by exactly the same code path — the difference is only
 * what gets written to the log.
 */
// Due for anonymisation, BEFORE the legal hold is considered. Shared by
// findDue() (not held) and countHeldDue() (held), so "skipped because of a hold"
// counts exactly the candidates the hold actually protected. $1 = company or NULL.
const DUE_WHERE = `
        anonymised_at IS NULL
        AND deleted_at IS NULL
        AND ($1::int IS NULL OR company_id = $1::int)
        AND (
          -- Withdrawal is immediate and overrides the pipeline guard: someone
          -- who has asked to be removed has asked now, not at the end of the
          -- process. (A legal hold overrides even a withdrawal — see below.)
          consent_withdrawn_at IS NOT NULL
          OR (
            retain_until IS NOT NULL
            AND retain_until < CURRENT_DATE
            AND COALESCE(overall_status, '') NOT IN ('active', 'hired')
          )
        )`;

async function findDue(companyId = null) {
  const { rows } = await pool.query(
    `SELECT id, company_id, retain_until,
            CASE WHEN consent_withdrawn_at IS NOT NULL THEN 'consent_withdrawn'
                 ELSE 'retention_expired' END AS reason
       FROM candidates
      WHERE ${DUE_WHERE}
        AND legal_hold = false
      ORDER BY retain_until NULLS FIRST
      LIMIT $2`,
    [companyId, BATCH]
  );
  return rows;
}

/** Candidates that WOULD be due but are under legal hold — reported every run. */
async function countHeldDue(companyId = null) {
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM candidates WHERE ${DUE_WHERE} AND legal_hold = true`,
    [companyId]
  );
  return r.n;
}

async function anonymise(candidate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row and re-check it: a retried or overlapping run must not
    // anonymise twice (and the stored references must be read before they are
    // nulled below).
    //
    // The legal hold is checked HERE, under the lock — not only in findDue().
    // A hold placed after findDue() read the candidate takes the same row lock
    // (routes: legal-hold place/amend/release use SELECT … FOR UPDATE), so this
    // SELECT either waits for that transaction and then sees legal_hold = true,
    // or runs first and the hold request then finds an anonymised record and is
    // refused. Either way, a held candidate is never anonymised and nothing of
    // theirs is queued for deletion (the queueing below is after this check).
    const { rows: [current] } = await client.query(
      `SELECT resume_file_url, resume_url, resume_gdrive_file_id, legal_hold
         FROM candidates WHERE id = $1 AND anonymised_at IS NULL FOR UPDATE`,
      [candidate.id]
    );
    if (!current) { await client.query('ROLLBACK'); return 'skipped'; }
    if (current.legal_hold) { await client.query('ROLLBACK'); return 'held'; }

    // Queue every stored résumé reference in THIS transaction, so the files of a
    // committed anonymisation are always queued and a rolled-back one queues
    // nothing. The files are removed after COMMIT by candidateResumePurge.js,
    // which deletes only a file no other record references. (There was never a
    // "storage sweep"; the file used to stay in uploads/ for good.)
    const refs = [...new Set([
      current.resume_file_url, current.resume_url,
      current.resume_gdrive_file_id ? `gdrive:${current.resume_gdrive_file_id}` : null,
    ].map(v => (v == null ? '' : String(v).trim())).filter(Boolean))];
    for (const ref of refs) {
      await client.query(
        `INSERT INTO candidate_resume_purges (company_id, candidate_id, file_ref)
         VALUES ($1, $2, $3) ON CONFLICT (candidate_id, file_ref) DO NOTHING`,
        [candidate.company_id, candidate.id, ref]
      );
    }

    await client.query(
      `UPDATE candidates
          SET full_name           = 'Removed at candidate request',
              email               = 'anonymised+' || id || '@redacted.invalid',
              phone               = NULL,
              current_company     = NULL,
              current_designation = NULL,
              location            = NULL,
              notes               = NULL,
              resume_text         = NULL,
              resume_file_url     = NULL,
              resume_url          = NULL,
              resume_gdrive_url   = NULL,
              resume_gdrive_file_id = NULL,
              institution         = NULL,
              skills              = '[]'::jsonb,
              tags                = '[]'::jsonb,
              expected_ctc        = NULL,
              current_salary      = NULL,
              expected_salary     = NULL,
              first_name          = NULL,
              last_name           = NULL,
              anonymised_at       = NOW(),
              updated_at          = NOW()
        WHERE id = $1`,
      [candidate.id]
    );

    // Free-text written ABOUT the candidate is personal data too — an interview
    // note naming someone is not anonymous just because the candidate row is.
    await client.query(
      `UPDATE interview_notes SET comments = NULL WHERE candidate_id = $1`, [candidate.id]
    );
    await client.query(
      `UPDATE candidate_stage_history SET notes = NULL WHERE candidate_id = $1`, [candidate.id]
    );
    await client.query(
      `UPDATE candidate_applications SET notes = NULL WHERE candidate_id = $1`, [candidate.id]
    );
    // The careers-portal submission payload is a verbatim copy of what they typed.
    await client.query(
      `UPDATE careers_applications SET payload = NULL WHERE candidate_id = $1`, [candidate.id]
    ).catch(() => {});

    await client.query(
      `INSERT INTO candidate_retention_log (company_id, candidate_id, action, reason, retain_until)
       VALUES ($1, $2, 'anonymised', $3, $4)`,
      [candidate.company_id, candidate.id, candidate.reason, candidate.retain_until]
    );

    await client.query('COMMIT');
    return 'anonymised';
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'ERROR',
      event: 'candidate_anonymise_failed', candidateId: candidate.id, message: err.message,
    }));
    return 'failed';
  } finally {
    client.release();
  }
}

/**
 * @param {{ companyId?: number|null, uploadDir?: string, unlink?: Function }} [opts]
 *   companyId scopes the run to one company (tests; the nightly run passes none).
 *   uploadDir / unlink are passed to the résumé purge (test seams).
 */
export async function runCandidateRetention({ companyId = null, ...purgeOpts } = {}) {
  const due = await findDue(companyId);
  // Held when the run started (never selected) …
  const heldAtSelection = await countHeldDue(companyId);

  let done = 0;
  let heldAtLock = 0;   // … plus held between selection and the row lock
  for (const candidate of due) {
    const outcome = await anonymise(candidate);
    if (outcome === 'anonymised') done++;
    else if (outcome === 'held') heldAtLock++;
  }
  const held_skipped = heldAtSelection + heldAtLock;

  // Files of this run's anonymisations, plus anything an earlier run left
  // pending or failed — every run is also the retry.
  const files = await purgeQueuedResumes({ companyId, ...purgeOpts });

  // Loud on purpose. This job destroys data; a silent run gives nobody the
  // chance to notice it is destroying the wrong data. A file that could not be
  // removed is an ERROR line, not a quiet count.
  if (due.length || held_skipped || files.processed || files.failed_permanently) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: files.failed || files.failed_permanently ? 'ERROR' : 'INFO',
      event: 'candidate_retention_run',
      due: due.length, anonymised: done, held_skipped,
      withdrawals: due.filter(d => d.reason === 'consent_withdrawn').length,
      files,
    }));
  }

  return { scanned: due.length, anonymised: done, held_skipped, files };
}

export function startCandidateRetentionCron() {
  if (String(process.env.CANDIDATE_RETENTION_ENABLED).toLowerCase() === 'false') {
    console.log('[candidateRetention] disabled by CANDIDATE_RETENTION_ENABLED=false');
    return;
  }
  cron.schedule(SCHEDULE, () => {
    runCandidateRetention().catch(err =>
      console.error('[candidateRetention] run failed:', err.message)
    );
  });
  console.log(`[candidateRetention] scheduled (${SCHEDULE})`);
}

export default { startCandidateRetentionCron, runCandidateRetention };
