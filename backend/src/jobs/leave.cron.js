/**
 * leave.cron.js — Automated leave lifecycle jobs
 *
 * Schedule summary:
 *  Monthly accrual     : 1st of every month  @ 01:00 IST
 *  Year-end carry-fwd  : 1 Jan               @ 02:00 IST
 *  Carry-fwd expiry    : 1st of every month  @ 01:30 IST
 *  Comp-off expiry     : Daily               @ 00:30 IST
 *  Escalation check    : Daily (weekdays)    @ 09:00 IST
 */
import cron from 'node-cron';
import pool from '../config/db.js';
import { logAudit } from '../services/AuditService.js';

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

async function runMonthlyAccrual(companyId, month, year) {
  const { rows: leaveTypes } = await pool.query(`
    SELECT id, leave_name, accrual_days_per_month
    FROM leave_types
    WHERE accrual_type = 'monthly'
      AND is_active = true AND deleted_at IS NULL
      AND accrual_days_per_month > 0
      AND (company_id IS NULL OR company_id = $1)
  `, [companyId]);

  if (!leaveTypes.length) return 0;

  const { rows: employees } = await pool.query(`
    SELECT id, joining_date FROM employees
    WHERE status IS DISTINCT FROM 'Left'
      AND ($1::integer IS NULL OR company_id = $1)
  `, [companyId]);

  let accrued = 0;
  for (const emp of employees) {
    let factor = 1;
    if (emp.joining_date) {
      const jd = new Date(emp.joining_date);
      if (jd.getFullYear() === year && jd.getMonth() + 1 === month) {
        const daysInMonth = new Date(year, month, 0).getDate();
        factor = (daysInMonth - jd.getDate() + 1) / daysInMonth;
      } else if (jd > new Date(year, month - 1, 1)) {
        continue;
      }
    }
    for (const lt of leaveTypes) {
      const days = Number((lt.accrual_days_per_month * factor).toFixed(2));
      if (days <= 0) continue;
      await pool.query(`
        INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, used_days)
        VALUES ($1, $2, $3, $4, 0)
        ON CONFLICT (employee_id, leave_type_id, year)
        DO UPDATE SET allocated_days = leave_balances.allocated_days + $4, updated_at = NOW()
      `, [emp.id, lt.id, year, days]);
      accrued++;
    }
  }
  return accrued;
}

cron.schedule('0 1 1 * *', async () => {
  log('monthly-accrual', 'Starting');
  const now = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();
  const companies = await getAllCompanies();
  let total = 0;
  for (const c of companies) {
    try {
      const count = await runMonthlyAccrual(c.id, month, year);
      total += count;
    } catch (err) {
      log('monthly-accrual', `Company ${c.id} error: ${err.message}`);
    }
  }
  log('monthly-accrual', `Done — ${total} balance rows updated`);
  logAudit({ userId: null, module: 'leave_accrual', recordId: null, recordType: 'leave_accrual', action: 'cron_run', newData: { month, year, records: total } }).catch(() => {});
}, { timezone: 'Asia/Kolkata' });

// ── 2. Year-End Carry-Forward ─────────────────────────────────────────────────
// Runs on 1 Jan at 02:00. Carries forward eligible balance (capped by policy)
// from the previous year into the new year.

async function runCarryForward(companyId, fromYear) {
  const toYear = fromYear + 1;

  const { rows: leaveTypes } = await pool.query(`
    SELECT id, leave_name, max_carry_forward_days, carry_forward_expiry_months
    FROM leave_types
    WHERE carry_forward_allowed = true AND is_active = true AND deleted_at IS NULL
      AND (company_id IS NULL OR company_id = $1)
  `, [companyId]);

  if (!leaveTypes.length) return 0;

  let carried = 0;
  for (const lt of leaveTypes) {
    const { rows: balances } = await pool.query(`
      SELECT lb.employee_id,
             GREATEST(COALESCE(lb.allocated_days,0) - COALESCE(lb.used_days,0) - COALESCE(lb.encashed_days,0), 0) AS remaining
      FROM leave_balances lb
      JOIN employees e ON lb.employee_id = e.id
      WHERE lb.leave_type_id = $1 AND lb.year = $2
        AND e.status IS DISTINCT FROM 'Left'
        AND ($3::integer IS NULL OR e.company_id = $3)
        AND GREATEST(COALESCE(lb.allocated_days,0) - COALESCE(lb.used_days,0) - COALESCE(lb.encashed_days,0), 0) > 0
    `, [lt.id, fromYear, companyId]);

    for (const bal of balances) {
      const carryDays = Math.min(Number(bal.remaining), lt.max_carry_forward_days || 0);
      if (carryDays <= 0) continue;
      await pool.query(`
        INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days, carried_forward_days, opening_balance, used_days)
        VALUES ($1, $2, $3, $4, $4, $4, 0)
        ON CONFLICT (employee_id, leave_type_id, year)
        DO UPDATE SET
          allocated_days       = leave_balances.allocated_days + $4,
          carried_forward_days = COALESCE(leave_balances.carried_forward_days, 0) + $4,
          opening_balance      = COALESCE(leave_balances.opening_balance, 0) + $4,
          updated_at           = NOW()
      `, [bal.employee_id, lt.id, toYear, carryDays]);
      carried++;
    }
  }
  return carried;
}

cron.schedule('0 2 1 1 *', async () => {
  log('carry-forward', 'Starting year-end carry-forward');
  const fromYear = new Date().getFullYear() - 1;
  const companies = await getAllCompanies();
  let total = 0;
  for (const c of companies) {
    try {
      const count = await runCarryForward(c.id, fromYear);
      total += count;
    } catch (err) {
      log('carry-forward', `Company ${c.id} error: ${err.message}`);
    }
  }
  log('carry-forward', `Done — ${total} carry-forward records created`);
  logAudit({ userId: null, module: 'leave_accrual', recordId: null, recordType: 'leave_carry_forward', action: 'cron_run', newData: { from_year: fromYear, to_year: fromYear + 1, records: total } }).catch(() => {});
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
        await notifyWorkflowEvent('escalated', {
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
        }).catch(() => {});
      }
    }

    log('sla-escalation', `Escalated ${stale.length} application(s) pending > 3 days`);
  } catch (err) {
    log('sla-escalation', `Error: ${err.message}`);
  }
}, { timezone: 'Asia/Kolkata' });

log('init', 'Leave cron jobs registered: monthly-accrual, carry-forward, cf-expiry, compoff-expiry, sla-escalation');
