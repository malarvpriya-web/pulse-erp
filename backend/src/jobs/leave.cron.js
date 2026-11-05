/**
 * leave.cron.js — Automated leave lifecycle jobs
 *
 * Schedule summary:
 *  Monthly accrual     : 1st of every month  @ 01:00 IST
 *  Year-end carry-fwd  : 1 Jan               @ 02:00 IST
 *  Carry-fwd expiry    : 1st of every month  @ 01:30 IST
 *  Comp-off expiry     : Daily               @ 00:30 IST
 *  Escalation check    : Daily (weekdays)    @ 09:00 IST
 *
 * ⚠ THE ACCRUAL AND CARRY-FORWARD BODIES ARE NO LONGER HERE. They were
 * copy-paste twins of `modules/leaves/routes/accrual.routes.js`, and the two
 * copies shared a defect neither could detect from inside itself: the
 * `ON CONFLICT (employee_id, leave_type_id, year) DO UPDATE SET allocated_days =
 * allocated_days + $4` statement is idempotent about the balance ROW and purely
 * ADDITIVE about the days. This cron firing and then an HR user running the same
 * month by hand credited that month TWICE, and neither side could see the other's
 * work — this job wrote NO `leave_accrual_log` row at all, and the route wrote one
 * un-awaited inside `.catch(() => {})`.
 *
 * `modules/leaves/services/leaveAccrual.service.js` is now the one owner. Both
 * schedules below call it; it takes `leave_accrual_log` as a LOCK (unique index
 * `uq_accrual_log_period`, migration 20260926000012) so a period can be credited
 * at most once however many writers attempt it — including two app instances both
 * running this file's crons.
 */
import cron from 'node-cron';
import pool from '../config/db.js';
import { logAudit } from '../services/AuditService.js';
import {
  runMonthlyAccrual,
  runCarryForward,
} from '../modules/leaves/services/leaveAccrual.service.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(tag, msg) {
  console.log(`[leave-cron][${tag}] ${new Date().toISOString()} — ${msg}`);
}

async function getAllCompanies() {
  const { rows } = await pool.query(
    `SELECT id FROM companies WHERE is_active = true`
  ).catch(() => ({ rows: [{ id: null }] }));
  return rows.length ? rows : [{ id: null }];
}

// ── 1. Monthly Accrual ────────────────────────────────────────────────────────
// Runs on 1st of every month at 01:00. Credits accrual_days_per_month to every
// active employee for each leave type with accrual_type = 'monthly'.
//
// `runMode: 'cron'` and `runBy: null` are recorded in leave_accrual_log but are
// deliberately NOT part of its uniqueness key — if they were, a cron run and a
// manual run of the same month would be distinct keys and the double-credit would
// be back. See the service header.

cron.schedule('0 1 1 * *', async () => {
  log('monthly-accrual', 'Starting');
  const now = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const companies = await getAllCompanies();
  const totals = { credited: 0, skipped: 0, failed: 0 };
  for (const c of companies) {
    try {
      const r = await runMonthlyAccrual({ companyId: c.id, month, year, runMode: 'cron', runBy: null });
      totals.credited += r.credited;
      totals.skipped  += r.skipped;
      totals.failed   += r.failed;
    } catch (err) {
      log('monthly-accrual', `Company ${c.id} error: ${err.message}`);
    }
  }
  // `skipped` is the number that used to be a silent second credit. A non-zero
  // value here is normal and healthy — it means HR had already run this month, or
  // this job already had — not a fault.
  log('monthly-accrual',
      `Done — ${totals.credited} credited, ${totals.skipped} already accrued, ${totals.failed} failed`);
  logAudit({ userId: null, module: 'leave_accrual', recordId: null, recordType: 'leave_accrual', action: 'cron_run', newData: { month, year, records: totals.credited, skipped: totals.skipped, failed: totals.failed } }).catch(() => {});
}, { timezone: 'Asia/Kolkata' });

// ── 2. Year-End Carry-Forward ─────────────────────────────────────────────────
// Runs on 1 Jan at 02:00. Carries forward eligible balance (capped by policy)
// from the previous year into the new year.

cron.schedule('0 2 1 1 *', async () => {
  log('carry-forward', 'Starting year-end carry-forward');
  const fromYear = new Date().getFullYear() - 1;
  const companies = await getAllCompanies();
  const totals = { credited: 0, skipped: 0, failed: 0 };
  for (const c of companies) {
    try {
      const r = await runCarryForward({ companyId: c.id, fromYear, runMode: 'cron', runBy: null });
      totals.credited += r.credited;
      totals.skipped  += r.skipped;
      totals.failed   += r.failed;
    } catch (err) {
      log('carry-forward', `Company ${c.id} error: ${err.message}`);
    }
  }
  log('carry-forward',
      `Done — ${totals.credited} carried, ${totals.skipped} already carried, ${totals.failed} failed`);
  logAudit({ userId: null, module: 'leave_accrual', recordId: null, recordType: 'leave_carry_forward', action: 'cron_run', newData: { from_year: fromYear, to_year: fromYear + 1, records: totals.credited, skipped: totals.skipped, failed: totals.failed } }).catch(() => {});
}, { timezone: 'Asia/Kolkata' });

// ── 3. Carry-Forward Expiry ───────────────────────────────────────────────────
// Runs on 1st of every month at 01:30. Zeros out carried_forward_days that
// have exceeded carry_forward_expiry_months since Jan 1 of their year.

cron.schedule('30 1 1 * *', async () => {
  log('cf-expiry', 'Starting carry-forward expiry check');
  try {
    const now = new Date();
    const expiryYear  = now.getFullYear();
    const expiryMonth = now.getMonth() + 1;

    const { rows: expired } = await pool.query(`
      UPDATE leave_balances lb
      SET allocated_days       = allocated_days - COALESCE(carried_forward_days, 0),
          carried_forward_days = 0,
          updated_at           = NOW()
      FROM leave_types lt
      WHERE lb.leave_type_id = lt.id
        AND lt.carry_forward_allowed = true
        AND lt.carry_forward_expiry_months IS NOT NULL
        AND lb.carried_forward_days > 0
        AND lb.year = $1
        AND $2 > lt.carry_forward_expiry_months
      RETURNING lb.employee_id, lb.leave_type_id
    `, [expiryYear, expiryMonth]);

    log('cf-expiry', `Done — ${expired.length} balances expired`);
    if (expired.length) {
      logAudit({ userId: null, module: 'leave_accrual', recordId: null, recordType: 'leave_expiry', action: 'cron_run', newData: { year: expiryYear, records_expired: expired.length } }).catch(() => {});
    }
  } catch (err) {
    log('cf-expiry', `Error: ${err.message}`);
  }
}, { timezone: 'Asia/Kolkata' });

// ── 4. Comp-Off Expiry ────────────────────────────────────────────────────────
// Runs daily at 00:30. Marks expired comp-off records and REVERSES the credit
// from leave_balances so balances remain accurate.

cron.schedule('30 0 * * *', async () => {
  log('compoff-expiry', 'Starting comp-off expiry check');
  try {
    // Find approved comp-offs that have expired but not yet been marked
    const { rows: expiring } = await pool.query(`
      SELECT co.*, lt.id AS comp_lt_id
      FROM compensatory_off co
      LEFT JOIN leave_types lt
        ON lt.is_comp_off_type = true AND lt.is_active = true AND lt.deleted_at IS NULL
        AND (lt.company_id IS NULL OR lt.company_id = co.company_id)
      WHERE co.status = 'approved'
        AND co.credited = true
        AND co.expires_on < CURRENT_DATE
    `);

    if (!expiring.length) {
      log('compoff-expiry', 'No expired comp-offs found');
      return;
    }

    for (const co of expiring) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Mark as expired
        await client.query(`
          UPDATE compensatory_off
          SET status = 'used',
              comments = COALESCE(comments || ' | ', '') || 'Expired — not utilised within validity period',
              updated_at = NOW()
          WHERE id = $1
        `, [co.id]);

        // Reverse the credited days from leave_balances
        if (co.comp_lt_id) {
          const creditDays = co.hours_worked >= 8 ? 1 : 0.5;
          const year = new Date(co.work_date).getFullYear();
          await client.query(`
            UPDATE leave_balances
            SET allocated_days = GREATEST(COALESCE(allocated_days, 0) - $1, 0),
                updated_at     = NOW()
            WHERE employee_id    = $2
              AND leave_type_id  = $3
              AND year           = $4
          `, [creditDays, co.employee_id, co.comp_lt_id, year]);
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        log('compoff-expiry', `Row ${co.id} rollback: ${err.message}`);
      } finally {
        client.release();
      }
    }

    log('compoff-expiry', `Done — ${expiring.length} comp-off(s) expired and balances reversed`);
    logAudit({ userId: null, module: 'comp_off', recordId: null, recordType: 'comp_off_expiry', action: 'cron_run', newData: { records_expired: expiring.length } }).catch(() => {});
  } catch (err) {
    log('compoff-expiry', `Error: ${err.message}`);
  }
}, { timezone: 'Asia/Kolkata' });

// ── 5. Approval SLA Escalation ────────────────────────────────────────────────
// Runs weekdays at 09:00. Flags leave applications pending > 3 days and sends
// escalation notifications to HR / the approver's manager.

cron.schedule('0 9 * * 1-5', async () => {
  log('sla-escalation', 'Checking pending approvals');
  try {
    const { rows: stale } = await pool.query(`
      SELECT la.id, la.employee_id, la.manager_id, la.applied_at,
             COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
             lt.leave_name,
             EXTRACT(DAY FROM NOW() - la.applied_at)::int AS pending_days
      FROM leave_applications la
      JOIN employees e  ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE la.status = 'pending'
        AND la.deleted_at IS NULL
        AND la.applied_at < NOW() - INTERVAL '3 days'
      ORDER BY la.applied_at ASC
    `);

    if (!stale.length) {
      log('sla-escalation', 'No SLA breaches');
      return;
    }

    const { notifyWorkflowEvent } = await import('../services/WorkflowNotificationService.js').catch(() => ({ notifyWorkflowEvent: null }));
    for (const app of stale) {
      if (notifyWorkflowEvent) {
        // notifyWorkflowEvent is fire-and-forget and returns undefined (phase3
        // test pins that). The `await …(…).catch()` that was here threw a
        // TypeError on `undefined.catch`, aborting this loop after the FIRST
        // stale application — every later one was never escalated.
        notifyWorkflowEvent('escalated', {
          module: 'Leave',
          recordId: app.id,
          actorId: null,
          actorName: 'System',
          context: {
            employee_name: app.employee_name,
            leave_type: app.leave_name,
            pending_days: app.pending_days,
          },
          recipientIds: [app.manager_id].filter(Boolean),
        });
      }
    }

    log('sla-escalation', `Escalated ${stale.length} application(s) pending > 3 days`);
  } catch (err) {
    log('sla-escalation', `Error: ${err.message}`);
  }
}, { timezone: 'Asia/Kolkata' });

log('init', 'Leave cron jobs registered: monthly-accrual, carry-forward, cf-expiry, compoff-expiry, sla-escalation');
