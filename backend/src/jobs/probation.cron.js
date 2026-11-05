/**
 * Probation reminder job — daily at 09:00 IST.
 * ──────────────────────────────────────────────────────────────────────────────
 * For every company, for every employee whose status is Probation and who has a
 * stored probation_end_date (the canonical date — shared/probationDates.js):
 *
 *   due_soon  today is within the company's reminder lead time before the end
 *             date (probation_review_reminder_days, default 14):
 *               end - lead <= today < end
 *   ended     today is the end date or later, and the employee is STILL on
 *             probation — the decision is due or overdue.
 *
 * Each (employee, end date, kind) is sent at most once, ever. That is enforced
 * by a UNIQUE row in probation_reminder_log, inserted in the SAME transaction
 * as the notifications it stands for: either both commit or neither does, so a
 * failed run is retried next time and a repeated run sends nothing new.
 *
 * WHAT CHANGED, AND WHY
 *   - The old job fired only when CURRENT_DATE was EXACTLY joining + 165 or
 *     joining + 180. One missed day — a restart, a deploy, an outage at 09:00 —
 *     and that reminder never happened. A window is checked instead: a missed
 *     run is caught up by the next one. A run that misses the WHOLE due-soon
 *     window sends the single 'ended' reminder, not a stale "due soon".
 *   - It ignored probation_end_date and assumed 180 days from joining. It now
 *     reads the stored date, and skips an employee who has none (that gap is
 *     reported by the dashboard's data-quality tile; this job does not invent
 *     a date).
 *   - Recipients were the reporting manager matched BY NAME across every
 *     company, plus every super admin of every company. They are now this
 *     company's HR users (hr, hr_manager, hr_exec), this company's super
 *     admins, and the employee's reporting manager resolved by id — all within
 *     the employee's company.
 *   - De-duplication looked for an existing notification row, which is
 *     per-recipient, deletable by its reader and has no company. The ledger
 *     replaces it.
 *
 * An employee with no one to notify (no HR login in the company yet) gets NO
 * ledger row, so the reminder goes out on the first run after someone exists to
 * receive it.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import { scheduled } from './jobRun.js';
import { statusExpr } from '../shared/employeeStatus.js';
import { getProbationPolicy } from '../shared/probationDates.js';
import {
  companyUsersWithRoles, userForEmployee, insertNotifications, dispatchAfterCommit,
} from '../probation/probation.service.js';

export const HR_RECIPIENT_ROLES = ['hr', 'hr_manager', 'hr_exec', 'super_admin'];

const fmt = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

function payloadFor(emp, kind, daysLeft) {
  const name = `${emp.first_name ?? ''} ${emp.last_name ?? ''}`.trim() || 'An employee';
  const who = `${name} (${emp.office_id || 'no ID'})`;
  const end = fmt(emp.probation_end_date);
  if (kind === 'due_soon') {
    return {
      title: `Probation Ending Soon — ${name}`,
      message: `${who}'s probation ends on ${end} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left). `
        + `Start the probation review so a decision is ready by then.`,
      notification_type: 'probation_warning',
    };
  }
  const when = daysLeft === 0 ? 'ends today' : `ended on ${end} (${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago)`;
  return {
    title: `Probation ${daysLeft === 0 ? 'Ends Today' : 'Ended'} — ${name}`,
    message: `${who}'s probation ${when} and they are still on probation. `
      + `Record the confirmation decision.`,
    notification_type: 'probation_due',
  };
}

/**
 * Remind for one employee. Returns 'sent' | 'duplicate' | 'no_recipient'.
 * Throws on a real failure (after rolling back) — the caller counts it.
 */
async function remindOne(companyId, emp, kind) {
  const client = await pool.connect();
  let sent = [];
  try {
    await client.query('BEGIN');
    const recipients = [
      ...(await companyUsersWithRoles(client, companyId, HR_RECIPIENT_ROLES)),
      await userForEmployee(client, companyId, emp.reporting_manager_id),
    ].filter((id) => id != null);
    const unique = [...new Set(recipients)];
    if (!unique.length) {
      await client.query('ROLLBACK');
      return 'no_recipient';
    }
    const { rows } = await client.query(
      `INSERT INTO probation_reminder_log
         (company_id, employee_id, probation_end_date, reminder_kind, recipient_count)
       VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT (employee_id, probation_end_date, reminder_kind) DO NOTHING
       RETURNING id`,
      [companyId, emp.id, emp.probation_end_date, kind, unique.length],
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return 'duplicate';
    }
    sent = await insertNotifications(client, unique, {
      ...payloadFor(emp, kind, emp.days_left),
      module_name: 'probation',
      reference_id: emp.id,
      company_id: companyId,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await dispatchAfterCommit(sent);
  return 'sent';
}

/**
 * One pass. `asOf` ('YYYY-MM-DD') replaces today for tests; `companyId` limits
 * the pass to one company (the manual trigger, run by a company admin).
 * Returns counters; throws AFTER processing everything else if any employee
 * failed, so runJob logs a FAIL with the first error rather than a clean run.
 */
export async function runProbationCheck({ asOf = null, companyId = null } = {}) {
  const counters = { companies: 0, due_soon: 0, ended: 0, duplicate: 0, no_recipient: 0, failed: 0 };
  const failures = [];

  const { rows: companies } = await pool.query(
    `SELECT DISTINCT company_id
       FROM employees
      WHERE company_id IS NOT NULL AND deleted_at IS NULL
        AND probation_end_date IS NOT NULL
        AND ${statusExpr()} = 'probation'
        AND ($1::int IS NULL OR company_id = $1)
      ORDER BY company_id`,
    [companyId],
  );

  for (const { company_id: cid } of companies) {
    counters.companies += 1;
    const policy = await getProbationPolicy(pool, cid);
    const { rows: due } = await pool.query(
      `SELECT id, office_id, first_name, last_name, reporting_manager_id,
              probation_end_date::text AS probation_end_date,
              (probation_end_date - COALESCE($2::date, CURRENT_DATE))::int AS days_left
         FROM employees
        WHERE company_id = $1 AND deleted_at IS NULL
          AND ${statusExpr()} = 'probation'
          AND probation_end_date IS NOT NULL
          AND probation_end_date <= COALESCE($2::date, CURRENT_DATE) + $3::int
        ORDER BY probation_end_date, id`,
      [cid, asOf, policy.reminder_days],
    );
    for (const emp of due) {
      const kind = emp.days_left > 0 ? 'due_soon' : 'ended';
      try {
        const outcome = await remindOne(cid, emp, kind);
        if (outcome === 'sent') counters[kind] += 1;
        else counters[outcome] += 1;
      } catch (err) {
        counters.failed += 1;
        failures.push(`company ${cid} employee ${emp.id}: ${err.message}`);
      }
    }
  }

  if (failures.length) {
    const err = new Error(`${failures.length} probation reminder(s) failed — ${failures.join('; ')}`);
    err.counters = counters;
    throw err;
  }
  return counters;
}

export function startProbationCron() {
  cron.schedule('0 9 * * *', scheduled('probationReminders', () => runProbationCheck()), {
    scheduled: true,
    timezone: 'Asia/Kolkata',
  });
  console.log('✅ Probation cron scheduled — runs daily at 09:00 IST');
}

/** Manual trigger (notifications.routes.js). Resolves to the counters or throws. */
export const runProbationCheckNow = (opts = {}) => runProbationCheck(opts);
