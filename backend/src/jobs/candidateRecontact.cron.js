import cron from 'node-cron';
import pool from '../config/db.js';
import notificationsRepository from '../modules/notifications/repositories/notifications.repository.js';

/**
 * Future Opportunity reminders — the half of §18 that actually fires.
 *
 * `candidate_recontact.recontact_on` is a date, and a date nothing acts on is a
 * note to self, not a reminder. This job is what makes "recontact Arun in March
 * 2027" a thing the recruiter is actually told about.
 *
 * ── WHY NOT A ROW IN `tasks` ────────────────────────────────────────────────
 * §18 asks the system to "create a reminder/task for the recruiter", and the
 * obvious reading is a row in `tasks`. It is the wrong table: `tasks` requires a
 * project_id and is the project-management work breakdown, so a recruitment
 * reminder there would surface as an orphan bar in somebody's Gantt chart and be
 * counted in project progress. The reminder lives on the recontact row; this job
 * turns the due ones into notifications.
 *
 * ── FIRES ONCE ──────────────────────────────────────────────────────────────
 * `notified_at` is stamped when the notification is created, and the query skips
 * anything already stamped. Without it a recruiter who does not act on a reminder
 * gets the same one every night until they do, which trains them to ignore the
 * whole channel — the failure mode that makes notification systems useless.
 *
 * A reminder with no owner still fires: it goes to every holder of
 * recruitment:edit in that company rather than nowhere. An unowned reminder is a
 * data problem, and silently dropping it would hide the data problem AND lose the
 * candidate, which is the one outcome §41 rules out.
 */

const SCHEDULE = process.env.CANDIDATE_RECONTACT_CRON || '15 8 * * *';   // 08:15 daily
const BATCH    = parseInt(process.env.CANDIDATE_RECONTACT_BATCH || '200', 10);

/**
 * Reminders due today or earlier that nobody has been told about.
 *
 * `<= CURRENT_DATE`, not `= CURRENT_DATE`: if the job does not run for two days
 * (deploy, outage, weekend restart) an `=` comparison would skip those days'
 * reminders permanently. Catching up is the correct behaviour for a reminder.
 */
async function findDue() {
  const { rows } = await pool.query(
    `SELECT rc.id, rc.company_id, rc.candidate_id, rc.recontact_on, rc.potential_role,
            rc.department, rc.reason, rc.owner_user_id,
            c.full_name, c.candidate_code, c.email, c.phone, c.disposition
       FROM candidate_recontact rc
       JOIN candidates c ON c.id = rc.candidate_id
      WHERE rc.status = 'pending'
        AND rc.notified_at IS NULL
        AND rc.recontact_on <= CURRENT_DATE
        -- A candidate anonymised under the retention policy must not generate a
        -- reminder to contact them: there is nothing left to contact. The
        -- retention job erases the identifiers, it does not close the reminder,
        -- so the guard belongs here.
        AND c.deleted_at IS NULL
        AND c.anonymised_at IS NULL
      ORDER BY rc.recontact_on ASC, rc.id ASC
      LIMIT $1`,
    [BATCH]
  );
  return rows;
}

/** Everyone who could act on a recruitment reminder in this company. */
async function recruitersFor(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN user_roles ur       ON ur.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE rp.module = 'recruitment' AND rp.can_edit = TRUE
        AND u.is_active = TRUE
        AND ($1::int IS NULL OR u.company_id = $1)`,
    [companyId]
  ).catch(() => ({ rows: [] }));
  return rows.map(r => r.id);
}

export async function runCandidateRecontact() {
  const due = await findDue();
  let notified = 0;
  let unowned = 0;

  for (const rc of due) {
    const targets = rc.owner_user_id ? [rc.owner_user_id] : await recruitersFor(rc.company_id);
    if (!rc.owner_user_id) unowned += 1;

    const overdueDays = Math.max(
      0,
      Math.floor((Date.now() - new Date(`${String(rc.recontact_on).slice(0, 10)}T00:00:00Z`).getTime()) / 86400000)
    );

    const message =
      `Recontact ${rc.full_name} (${rc.candidate_code || `#${rc.candidate_id}`})`
      + (rc.potential_role ? ` about ${rc.potential_role}` : '')
      + (overdueDays > 0 ? ` — due ${overdueDays} day${overdueDays === 1 ? '' : 's'} ago` : ' — due today');

    for (const userId of targets) {
      await notificationsRepository.create({
        user_id: userId,
        title: 'Talent Bank recontact due',
        message,
        module_name: 'recruitment',
        reference_id: rc.candidate_id,
        notification_type: 'info',
        company_id: rc.company_id,
      }).catch(() => {});
    }

    // Stamped whether or not there was anyone to tell. If there was nobody, the
    // reminder is still surfaced by the work queue's `recontact_due` count, which
    // reads recontact_on directly — so a stamp cannot lose it, and leaving it
    // unstamped would re-notify forever.
    await pool.query(
      `UPDATE candidate_recontact SET notified_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [rc.id]
    );

    // The reminder firing is itself a candidate event: "we were reminded on this
    // date" is part of the long-term memory §21 is asking for, and it explains a
    // gap if nobody then acted.
    await pool.query(
      `INSERT INTO candidate_activity
         (company_id, candidate_id, event_type, summary, detail, actor_user_id, actor_name)
       VALUES ($1, $2, 'recontact_due', $3, $4::jsonb, NULL, 'Pulse (scheduled)')`,
      [
        rc.company_id, rc.candidate_id,
        `Recontact reminder fired${rc.potential_role ? ` for ${rc.potential_role}` : ''}`,
        JSON.stringify({ recontact_id: rc.id, recontact_on: rc.recontact_on, recipients: targets.length }),
      ]
    ).catch(() => {});

    notified += 1;
  }

  if (due.length) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), level: 'INFO', event: 'candidate_recontact_run',
      due: due.length, notified, unowned,
    }));
  }
  return { due: due.length, notified, unowned };
}

export function startCandidateRecontactCron() {
  if (String(process.env.CANDIDATE_RECONTACT_ENABLED).toLowerCase() === 'false') {
    console.log('[candidateRecontact] disabled by CANDIDATE_RECONTACT_ENABLED=false');
    return;
  }
  cron.schedule(SCHEDULE, () => {
    runCandidateRecontact().catch(err =>
      console.error('[candidateRecontact] run failed:', err.message)
    );
  });
  console.log(`[candidateRecontact] Talent Bank recontact reminders scheduled (${SCHEDULE})`);
}

export default { startCandidateRecontactCron, runCandidateRecontact };
