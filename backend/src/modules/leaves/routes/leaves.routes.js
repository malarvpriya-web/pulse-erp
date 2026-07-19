import express from 'express';
import pool from '../../../config/db.js';
import leavesRepository from '../repositories/leaves.repository.js';
import { requirePermission, allowRoles } from '../../../middlewares/auth.middleware.js';
import { validate } from '../../../services/ValidationEngineService.js';
import { evaluateRules } from '../../../services/RuleEngineService.js';
import { logAudit } from '../../../services/AuditService.js';

const router = express.Router();

// Leave-type definitions and quota allocations are HR/admin-only. These routes
// share the 'leaves.add' permission with self-service Apply Leave, so a role
// check is required on top — otherwise any employee who can apply for leave
// could also change quotas ("12 leaves" drifting) and leave types.
const LEAVE_ADMIN_ROLES = ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec'];
const requireLeaveAdmin = allowRoles(...LEAVE_ADMIN_ROLES);

// ── Auto-sync approved leave to attendance_records ───────────────────────────
async function syncLeaveToAttendance(application, poolRef) {
  try {
    if (!application || application.status !== 'approved') return;
    const { employee_id, from_date, to_date, leave_type_id, company_id } = application;
    // Support both start_date/end_date and from_date/to_date field names
    const startDate = application.start_date || from_date;
    const endDate   = application.end_date   || to_date;
    if (!employee_id || !startDate || !endDate) return;

    // Get leave type details (for WFH detection)
    const ltRow = await poolRef.query(
      'SELECT name, leave_name FROM leave_types WHERE id=$1 LIMIT 1',
      [leave_type_id]
    ).catch(() => ({ rows: [] }));
    const leaveName = ((ltRow.rows[0]?.name || ltRow.rows[0]?.leave_name || '')).toLowerCase();
    const workMode = leaveName.includes('wfh') || leaveName.includes('work from home') ? 'wfh' : 'office';
    const isHalfDay = application.is_half_day || application.duration === 0.5 || application.half_day;

    // Resolve company_id if not on the application
    let resolvedCompanyId = company_id ?? null;
    if (resolvedCompanyId == null) {
      const empRow = await poolRef.query(
        'SELECT company_id FROM employees WHERE id=$1 LIMIT 1', [employee_id]
      ).catch(() => ({ rows: [] }));
      resolvedCompanyId = empRow.rows[0]?.company_id ?? null;
    }

    // Iterate each date in the leave range
    const start = new Date(startDate);
    const end   = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow === 0 || dow === 6) continue; // Skip weekends
      const dateStr = d.toISOString().split('T')[0];

      // Skip holidays
      const isHoliday = await poolRef.query(
        'SELECT 1 FROM holidays WHERE date=$1::date AND (company_id=$2 OR company_id IS NULL) LIMIT 1',
        [dateStr, resolvedCompanyId]
      ).then(r => r.rows.length > 0).catch(() => false);
      if (isHoliday) continue;

      const status = isHalfDay ? 'half_day' : (workMode === 'wfh' ? 'wfh' : 'on_leave');

      await poolRef.query(`
        INSERT INTO attendance_records
          (employee_id, attendance_date, status, work_mode, company_id, source)
        VALUES ($1, $2, $3, $4, $5, 'leave_sync')
        ON CONFLICT (employee_id, attendance_date)
        DO UPDATE SET
          status = CASE
            WHEN attendance_records.status IN ('present','late') THEN attendance_records.status
            ELSE EXCLUDED.status
          END,
          work_mode = CASE
            WHEN attendance_records.status IN ('present','late') THEN attendance_records.work_mode
            ELSE EXCLUDED.work_mode
          END,
          updated_at = NOW()
      `, [employee_id, dateStr, status, workMode, resolvedCompanyId]);
    }
  } catch (err) {
    console.error('[leave-sync] Error syncing leave to attendance:', err.message);
  }
}

// ── Reverse attendance records created by a previously-approved leave ─────────
async function reverseLeaveAttendance(application, poolRef) {
  try {
    if (!application) return;
    const startDate = application.start_date || application.from_date;
    const endDate   = application.end_date   || application.to_date;
    const { employee_id } = application;
    if (!employee_id || !startDate || !endDate) return;

    // Only delete records that the leave-sync originally inserted (source='leave_sync').
    // This ensures we never clobber biometric or manual attendance entries.
    await poolRef.query(`
      DELETE FROM attendance_records
      WHERE employee_id = $1
        AND attendance_date BETWEEN $2::date AND $3::date
        AND source = 'leave_sync'
    `, [employee_id, startDate, endDate]);
  } catch (err) {
    console.error('[leave-sync] Error reversing attendance for leave:', err.message);
  }
}

// ── Post LOP deduction to active payroll run (non-blocking) ──────────────────
async function postLopToPayroll(application, poolRef) {
  try {
    if (!application) return;
    // Only post once the leave is actually approved — a mid-workflow approval
    // (manager approved, L2/HR still pending) must not charge payroll yet.
    if (application.status && application.status !== 'approved') return;
    // Full-LOP application (probation block or LOP leave type): the whole
    // request is unpaid. Otherwise a paid leave may still carry a clubbing
    // LOP portion (weekend/holiday days auto-charged) in lop_days.
    const isFullLop = application.is_lop || application.is_lop_type;
    const days = isFullLop
      ? Number(application.number_of_days || 0)
      : Number(application.lop_days || 0);
    if (days <= 0) return;
    const startDate = application.start_date || application.from_date;
    if (!startDate) return;
    const month = new Date(startDate).getMonth() + 1;
    const year  = new Date(startDate).getFullYear();

    // Fetch employee's daily rate (basic_salary / 26)
    const { rows: empRows } = await poolRef.query(
      `SELECT basic_salary FROM employees WHERE id = $1 LIMIT 1`, [application.employee_id]
    ).catch(() => ({ rows: [] }));
    const basicSalary = Number(empRows[0]?.basic_salary || 0);
    const lopAmount = basicSalary > 0 ? Number(((basicSalary / 26) * days).toFixed(2)) : 0;

    // Find active payroll run for this employee and period
    const { rows: runRows } = await poolRef.query(`
      SELECT id FROM payroll_runs
      WHERE employee_id = $1 AND month = $2 AND year = $3 AND status NOT IN ('paid','cancelled')
      LIMIT 1
    `, [application.employee_id, month, year]).catch(() => ({ rows: [] }));

    if (runRows.length) {
      await poolRef.query(`
        UPDATE payroll_runs
        SET lop_days   = COALESCE(lop_days, 0) + $1,
            lop_amount = COALESCE(lop_amount, 0) + $2,
            updated_at = NOW()
        WHERE id = $3
      `, [days, lopAmount, runRows[0].id]).catch(() => {});
    }
  } catch {
    // Non-blocking — do not break approval flow
  }
}

// ── Notification helper (non-blocking) ───────────────────────────────────────
async function notifyLeaveEvent(event, application, actor, recipients = []) {
  try {
    const { notifyWorkflowEvent } = await import('../../../services/WorkflowNotificationService.js');
    const ctx = {
      module: 'Leave',
      recordId: application.id,
      actorId: actor?.employee_id || actor?.userId,
      actorName: actor?.name || actor?.email || 'System',
      context: {
        employee_name: application.employee_name || `Employee #${application.employee_id}`,
        leave_type: application.leave_name || application.leave_type || '',
        days: application.number_of_days,
        from: application.start_date,
        to: application.end_date,
        reason: application.reason || '',
      },
      recipientIds: recipients.filter(Boolean),
    };
    await notifyWorkflowEvent(event, ctx).catch(() => {});
  } catch {
    // notifications are best-effort — never break the main flow
  }
}

// ── Project-milestone conflict alert (non-blocking) ──────────────────────────
// Warns the PM when the leave-applying employee has a project milestone due
// within ±3 calendar days of the leave window.
async function notifyProjectMilestoneConflict(application, poolRef) {
  try {
    const startDate = application.start_date || application.from_date;
    const endDate   = application.end_date   || application.to_date;
    if (!application.employee_id || !startDate || !endDate) return;

    const { rows: conflicts } = await poolRef.query(`
      SELECT DISTINCT
        p.id                  AS project_id,
        p.project_name,
        p.project_manager_id,
        pm.title              AS milestone_title,
        pm.due_date           AS milestone_due_date
      FROM project_resources pr
      JOIN projects p          ON p.id = pr.project_id
      JOIN project_milestones pm ON pm.project_id = p.id
      WHERE pr.employee_id = $1
        AND (pr.end_date IS NULL OR pr.end_date >= $2::date)
        AND pm.status != 'completed'
        AND pm.due_date BETWEEN ($2::date - INTERVAL '3 days') AND ($3::date + INTERVAL '3 days')
        AND p.project_manager_id IS NOT NULL
    `, [application.employee_id, startDate, endDate]);

    if (!conflicts.length) return;

    const { notifyWorkflowEvent } = await import('../../../services/WorkflowNotificationService.js');

    // group by PM — one notification per PM, listing all affected milestones
    const pmMap = new Map();
    for (const c of conflicts) {
      if (!pmMap.has(c.project_manager_id)) {
        pmMap.set(c.project_manager_id, { project_name: c.project_name, milestones: [] });
      }
      pmMap.get(c.project_manager_id).milestones.push(
        `${c.milestone_title} (due ${c.milestone_due_date?.toISOString?.().slice(0,10) ?? c.milestone_due_date})`
      );
    }

    for (const [pmId, info] of pmMap) {
      await notifyWorkflowEvent('leave_milestone_conflict', {
        module: 'Leave',
        recordId: application.id,
        actorId: application.employee_id,
        actorName: application.employee_name || `Employee #${application.employee_id}`,
        context: {
          employee_name: application.employee_name || `Employee #${application.employee_id}`,
          project_name: info.project_name,
          milestones: info.milestones.join('; '),
          from: startDate,
          to: endDate,
          days: application.number_of_days,
        },
        recipientIds: [pmId],
      }).catch(() => {});
    }
  } catch {
    // best-effort — never block the apply flow
  }
}

// ── Resolve manager_id from the employee's reporting_manager_id FK first,
//    then fall back to name-string match as a safety net.
async function resolveManagerEmployeeId(employee_id) {
  if (!employee_id) return null;
  try {
    // Primary: direct FK reference (reporting_manager_id column if it exists)
    const { rows: fkRows } = await pool.query(
      `SELECT reporting_manager_id AS id
       FROM employees
       WHERE id = $1
         AND reporting_manager_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM employees m WHERE m.id = reporting_manager_id AND m.status IS DISTINCT FROM 'Left')
       LIMIT 1`,
      [employee_id]
    );
    if (fkRows[0]?.id) return fkRows[0].id;

    // Fallback: name-string match
    const { rows } = await pool.query(
      `SELECT m.id
       FROM employees e
       JOIN employees m
         ON LOWER(TRIM(CONCAT(m.first_name, ' ', COALESCE(m.last_name, ''))))
            = LOWER(TRIM(COALESCE(e.reporting_manager, '')))
       WHERE e.id = $1
         AND COALESCE(e.reporting_manager, '') <> ''
         AND m.status IS DISTINCT FROM 'Left'
       LIMIT 1`,
      [employee_id]
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

function normalizeApplicationPayload(body, employee_id, leave_type_id) {
  return {
    ...body,
    employee_id,
    leave_type_id,
    start_date: body.start_date || body.from_date || body.fromDate,
    end_date: body.end_date || body.to_date || body.toDate,
    number_of_days: body.number_of_days ?? body.days ?? body.total_days ?? body.numberOfDays,
  };
}

function statusForWorkflowError(error) {
  return error.code === 'LEAVE_NOT_ACTIONABLE' ? 409 : 500;
}

async function resolveLeaveTypeId(leave_type, company_id = null) {
  if (!leave_type) return null;
  const candidates = [leave_type];
  if (!/\bleave$/i.test(leave_type)) candidates.push(`${leave_type} Leave`);
  const { rows } = await pool.query(
    `SELECT id FROM leave_types
      WHERE LOWER(leave_name) = ANY($1)
        AND is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $3)
      ORDER BY CASE WHEN LOWER(leave_name) = LOWER($2) THEN 0 ELSE 1 END
      LIMIT 1`,
    [candidates.map(v => v.toLowerCase()), leave_type, company_id]
  );
  return rows[0]?.id ?? null;
}

// ── Role helpers ──────────────────────────────────────────────────────────────
const ADMIN_HR_ROLES = new Set(['admin', 'super_admin', 'hr', 'hr_manager', 'hr_admin', 'hr_exec']);
const isAdminOrHR = (role) => ADMIN_HR_ROLES.has((role || '').toLowerCase());

// ── Generic status update — HR/Admin only; guards against bypassing workflow ──
export async function handleStatusUpdate(req, res) {
  const role = (req.user?.role || '').toLowerCase();
  const { status } = req.body;
  const raw = (status || '').toLowerCase();
  const normalized = raw === 'approve' ? 'approved' : raw === 'reject' ? 'rejected' : raw;
  if (!['approved', 'rejected', 'pending', 'cancelled'].includes(normalized)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }
  // Only admin/HR roles may use the generic status update; managers must use
  // the typed /approve/manager or /reject/manager endpoints.
  if (!isAdminOrHR(role) && normalized !== 'cancelled') {
    return res.status(403).json({ error: 'Use the specific approve/reject endpoints for your role' });
  }
  try {
    const application = await leavesRepository.updateStatus(
      req.params.id,
      normalized,
      req.user?.employee_id || null,
      req.body.comments || req.body.reason || ''
    );
    if (normalized === 'approved' || normalized === 'rejected') {
      notifyLeaveEvent(normalized, application, req.user, [application.employee_id]);
    }
    res.json({ success: true, data: application, ...application });
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE TYPES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/types', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;

    // `applicable=1` scopes the catalogue to what the company has actually
    // configured (used by the Apply Leave screen so employees don't see the
    // global statutory seed types the company never enabled). If the company
    // has NOT configured any of its own types, we fall back to the global seed
    // catalogue so the picker is never empty. Without the flag (e.g. the
    // Settings admin view) the full global + company catalogue is returned.
    const applicable = ['1', 'true', 'yes'].includes(String(req.query.applicable || '').toLowerCase());
    const scopeClause = applicable
      ? `AND (
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM leave_types
                 WHERE company_id = $1 AND is_active = true AND deleted_at IS NULL
               )
               THEN company_id = $1
               ELSE company_id IS NULL
             END
           )`
      : `AND (company_id IS NULL OR company_id = $1)`;

    const { rows } = await pool.query(`
      SELECT id, leave_name, leave_code, annual_quota AS default_days,
             COALESCE(description, '') AS description, is_active,
             COALESCE(carry_forward_allowed, false)    AS carry_forward_allowed,
             COALESCE(max_carry_forward_days, 0)       AS max_carry_forward_days,
             COALESCE(is_encashable, false)             AS is_encashable,
             COALESCE(allow_half_day, true)             AS allow_half_day,
             COALESCE(requires_attachment, false)       AS requires_attachment,
             COALESCE(requires_medical_cert_days, 0)   AS requires_medical_cert_days,
             COALESCE(allow_negative_balance, false)    AS allow_negative_balance,
             COALESCE(min_notice_days, 0)               AS min_notice_days,
             COALESCE(max_consecutive_days, 0)          AS max_consecutive_days,
             COALESCE(accrual_type, 'manual')           AS accrual_type,
             COALESCE(accrual_days_per_month, 0)        AS accrual_days_per_month,
             COALESCE(gender_restriction, '')            AS gender_restriction,
             COALESCE(allowed_in_probation, true)        AS allowed_in_probation,
             COALESCE(is_lop_type, false)                AS is_lop_type,
             COALESCE(is_paid, true)                     AS is_paid,
             COALESCE(l2_required, false)                AS l2_required,
             COALESCE(max_encash_days_per_year, 0)       AS max_encash_days_per_year,
             COALESCE(sandwich_rule, false)              AS sandwich_rule
      FROM leave_types
      WHERE deleted_at IS NULL AND is_active = true
        ${scopeClause}
      ORDER BY leave_name
    `, [companyId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /probation-status — tells the Apply Leave screen whether the target
// employee is currently in their probation period (paid leave blocked, LOP
// only). Employees may only query themselves; HR/Admin may pass ?employee_id.
router.get('/probation-status', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    let empId = req.query.employee_id;
    if (!isAdminOrHR(role) || !empId) empId = req.user?.employee_id;
    if (!empId || isNaN(parseInt(empId, 10))) {
      return res.json({ in_probation: false, probation_end: null });
    }
    const { rows } = await pool.query(
      `SELECT status, joining_date,
              COALESCE(probation_end_date, (joining_date + INTERVAL '90 days')::date) AS prob_end
       FROM employees WHERE id = $1 LIMIT 1`,
      [empId]
    );
    if (!rows.length) return res.json({ in_probation: false, probation_end: null });
    const { status, prob_end } = rows[0];
    const statusProbation = String(status || '').toLowerCase() === 'probation';
    const dateProbation = prob_end ? new Date(prob_end) >= new Date(new Date().toDateString()) : false;
    const inProbation = statusProbation || dateProbation;
    res.json({
      in_probation: inProbation,
      probation_end: prob_end ? String(prob_end).slice(0, 10) : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/types', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const {
      leave_name, default_days, description,
      carry_forward_allowed, max_carry_forward_days, is_encashable,
      allow_half_day, requires_attachment, requires_medical_cert_days,
      allow_negative_balance, min_notice_days, max_consecutive_days,
      accrual_type, accrual_days_per_month, gender_restriction, allowed_in_probation,
      l2_required, max_encash_days_per_year, sandwich_rule,
    } = req.body;
    const trimmed = (leave_name || '').trim();
    if (!trimmed) return res.status(400).json({ error: 'leave_name is required' });
    if (trimmed.length < 2) return res.status(400).json({ error: 'Leave type name must be at least 2 characters' });
    if (!/[A-Za-z]/.test(trimmed)) return res.status(400).json({ error: 'Leave type name must contain at least one letter' });
    const companyId = req.scope?.company_id ?? null;
    const leave_code = trimmed.toUpperCase().replace(/\s+/g, '_').slice(0, 10);
    const { rows } = await pool.query(`
      INSERT INTO leave_types (
        leave_name, leave_code, annual_quota, description, company_id,
        carry_forward_allowed, max_carry_forward_days, is_encashable,
        allow_half_day, requires_attachment, requires_medical_cert_days,
        allow_negative_balance, min_notice_days, max_consecutive_days,
        accrual_type, accrual_days_per_month, gender_restriction, allowed_in_probation,
        l2_required, max_encash_days_per_year, sandwich_rule
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT DO NOTHING
      RETURNING id, leave_name, annual_quota AS default_days, description
    `, [
      trimmed, leave_code, Number(default_days) || 0, description?.trim() || '', companyId,
      carry_forward_allowed ?? false, Number(max_carry_forward_days) || 0, is_encashable ?? false,
      allow_half_day ?? true, requires_attachment ?? false, Number(requires_medical_cert_days) || 0,
      allow_negative_balance ?? false, Number(min_notice_days) || 0, max_consecutive_days ? Number(max_consecutive_days) : null,
      accrual_type || 'manual', Number(accrual_days_per_month) || 0,
      gender_restriction || null, allowed_in_probation ?? true,
      l2_required ?? false, max_encash_days_per_year ? Number(max_encash_days_per_year) : null, sandwich_rule ?? false,
    ]);
    if (!rows.length) return res.status(409).json({ error: 'A leave type with this name already exists' });
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: rows[0].id, recordType: 'leave_type', action: 'create', newData: rows[0], req });
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk create leave types (used by the Setup Wizard — Leave Policies step).
// Tolerant of duplicates so the wizard can be re-run without failing.
router.post('/types/bulk', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const input = Array.isArray(req.body?.leaveTypes) ? req.body.leaveTypes : [];
    const companyId = req.scope?.company_id ?? null;
    const created = [];
    const skipped = [];

    for (const t of input) {
      // Accept both the wizard field names and the canonical leave_types names.
      const name = (t.leave_name ?? t.name ?? '').trim();
      if (!name || name.length < 2 || !/[A-Za-z]/.test(name)) {
        skipped.push({ name: name || '(blank)', reason: 'invalid name' });
        continue;
      }
      const quota          = Number(t.default_days ?? t.quota) || 0;
      const carryForward   = t.carry_forward_allowed ?? t.carry_forward ?? false;
      const maxCarry       = Number(t.max_carry_forward_days ?? t.max_carry) || 0;
      const encashable     = t.is_encashable ?? t.encashable ?? false;
      const genderRaw      = t.gender_restriction ?? t.gender ?? null;
      const genderRestrict = (!genderRaw || genderRaw === 'All') ? null : genderRaw;
      const approval       = t.approval ?? '';
      const l2Required     = t.l2_required ?? /L2/i.test(approval);
      const leaveCode      = name.toUpperCase().replace(/\s+/g, '_').slice(0, 10);

      const { rows } = await pool.query(`
        INSERT INTO leave_types (
          leave_name, leave_code, annual_quota, description, company_id,
          carry_forward_allowed, max_carry_forward_days, is_encashable,
          gender_restriction, l2_required
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT DO NOTHING
        RETURNING id, leave_name, annual_quota AS default_days
      `, [
        name, leaveCode, quota, '', companyId,
        carryForward, maxCarry, encashable,
        genderRestrict, l2Required,
      ]);

      if (rows.length) {
        created.push(rows[0]);
        logAudit({ userId: req.user?.userId, module: 'leaves', recordId: rows[0].id, recordType: 'leave_type', action: 'create', newData: rows[0], req });
      } else {
        skipped.push({ name, reason: 'already exists' });
      }
    }

    res.json({ success: true, created: created.length, skipped: skipped.length, leaveTypes: created, details: { skipped } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/types/:id', requireLeaveAdmin, requirePermission('leaves', 'edit'), async (req, res) => {
  try {
    const {
      leave_name, default_days, description,
      carry_forward_allowed, max_carry_forward_days, is_encashable,
      allow_half_day, requires_attachment, requires_medical_cert_days,
      allow_negative_balance, min_notice_days, max_consecutive_days,
      accrual_type, accrual_days_per_month, gender_restriction, allowed_in_probation,
      l2_required, max_encash_days_per_year, sandwich_rule,
    } = req.body;
    if (!leave_name?.trim()) return res.status(400).json({ error: 'leave_name is required' });
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_types WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!oldRows.length) return res.status(404).json({ error: 'Leave type not found' });
    await pool.query(`
      UPDATE leave_types
      SET leave_name = $1, annual_quota = $2, description = $3,
          carry_forward_allowed = $4, max_carry_forward_days = $5, is_encashable = $6,
          allow_half_day = $7, requires_attachment = $8, requires_medical_cert_days = $9,
          allow_negative_balance = $10, min_notice_days = $11, max_consecutive_days = $12,
          accrual_type = $13, accrual_days_per_month = $14, gender_restriction = $15,
          allowed_in_probation = $16, l2_required = $17, max_encash_days_per_year = $18,
          sandwich_rule = $19, updated_at = NOW()
      WHERE id = $20 AND deleted_at IS NULL
    `, [
      leave_name.trim(), Number(default_days) || 0, description?.trim() || '',
      carry_forward_allowed ?? oldRows[0].carry_forward_allowed,
      Number(max_carry_forward_days) ?? oldRows[0].max_carry_forward_days,
      is_encashable ?? oldRows[0].is_encashable,
      allow_half_day ?? oldRows[0].allow_half_day,
      requires_attachment ?? oldRows[0].requires_attachment,
      Number(requires_medical_cert_days) ?? oldRows[0].requires_medical_cert_days,
      allow_negative_balance ?? oldRows[0].allow_negative_balance,
      Number(min_notice_days) ?? oldRows[0].min_notice_days,
      max_consecutive_days != null ? Number(max_consecutive_days) : oldRows[0].max_consecutive_days,
      accrual_type || oldRows[0].accrual_type,
      Number(accrual_days_per_month) ?? oldRows[0].accrual_days_per_month,
      gender_restriction ?? oldRows[0].gender_restriction,
      allowed_in_probation ?? oldRows[0].allowed_in_probation,
      l2_required ?? oldRows[0].l2_required ?? false,
      max_encash_days_per_year != null ? Number(max_encash_days_per_year) : oldRows[0].max_encash_days_per_year,
      sandwich_rule ?? oldRows[0].sandwich_rule ?? false,
      req.params.id,
    ]);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_type', action: 'update', oldData: oldRows[0], newData: req.body, req });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/types/:id', requireLeaveAdmin, requirePermission('leaves', 'delete'), async (req, res) => {
  try {
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_types WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!oldRows.length) return res.status(404).json({ error: 'Leave type not found' });
    await pool.query(`UPDATE leave_types SET deleted_at = NOW(), is_active = false WHERE id = $1`, [req.params.id]);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_type', action: 'delete', oldData: oldRows[0], req });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE BALANCE
// ─────────────────────────────────────────────────────────────────────────────

// GET /balance/:employee_id — role-scoped: employees can only see their own
router.get('/balance/:employee_id', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const empId = req.params.employee_id;
    if (!empId || empId === 'null' || empId === 'undefined' || isNaN(parseInt(empId, 10))) {
      return res.json([]);
    }
    const role = (req.user?.role || '').toLowerCase();
    const callerEmpId = req.user?.employee_id;
    // Employees may only fetch their own balance
    if (!isAdminOrHR(role) && !['manager','team_lead','department_head','l2_approver'].includes(role)) {
      if (String(callerEmpId) !== String(req.params.employee_id)) {
        return res.status(403).json({ error: 'You can only view your own leave balance' });
      }
    }
    const { year } = req.query;
    const balance = await leavesRepository.getLeaveBalance(req.params.employee_id, year);
    res.json(balance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/balance/initialize', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  try {
    const { employee_id, year } = req.body;
    if (!employee_id) return res.status(400).json({ error: 'employee_id is required' });
    await leavesRepository.initializeLeaveBalance(employee_id, year || new Date().getFullYear());
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: employee_id, recordType: 'leave_balance', action: 'initialize', newData: { employee_id, year }, req });
    res.json({ message: 'Leave balance initialized' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk allocate leave balances to all active employees
router.post('/bulk-allocate', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  const allocYear = Number(req.body.year) || new Date().getFullYear();
  const companyId = req.scope?.company_id ?? null;
  try {
    const { rows: leaveTypes } = await pool.query(`
      SELECT id, annual_quota FROM leave_types
      WHERE is_active = true AND deleted_at IS NULL
        AND (company_id IS NULL OR company_id = $1)
    `, [companyId]);
    const { rows: employees } = await pool.query(`
      SELECT id FROM employees
      WHERE LOWER(COALESCE(status,'active')) NOT IN ('left','terminated','resigned','inactive','ex-employee','notice_period')
        AND ($1::integer IS NULL OR company_id = $1)
    `, [companyId]);
    let count = 0;
    for (const emp of employees) {
      for (const lt of leaveTypes) {
        await pool.query(`
          INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (employee_id, leave_type_id, year) DO NOTHING
        `, [emp.id, lt.id, allocYear, lt.annual_quota]);
        count++;
      }
    }
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: null, recordType: 'leave_balance', action: 'bulk_allocate', newData: { year: allocYear, employees: employees.length, types: leaveTypes.length, records: count }, req });
    res.json({ success: true, year: allocYear, records: count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// All allocations — admin view
router.get('/allocations', requirePermission('leaves', 'view'), async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const companyId = req.scope?.company_id ?? null;
  try {
    const { rows } = await pool.query(`
      SELECT lb.id, lb.employee_id, lb.leave_type_id, lb.year,
             lb.allocated_days,
             COALESCE(lb.used_days, 0)                              AS used_days,
             COALESCE(
               (SELECT SUM(la.number_of_days)
                FROM leave_applications la
                WHERE la.employee_id = lb.employee_id
                  AND la.leave_type_id = lb.leave_type_id
                  AND la.status = 'pending'
                  AND EXTRACT(YEAR FROM la.start_date) = lb.year
                  AND la.deleted_at IS NULL), 0
             )                                                      AS pending_days,
             lb.allocated_days - COALESCE(lb.used_days, 0) - COALESCE(
               (SELECT SUM(la2.number_of_days)
                FROM leave_applications la2
                WHERE la2.employee_id = lb.employee_id
                  AND la2.leave_type_id = lb.leave_type_id
                  AND la2.status = 'pending'
                  AND EXTRACT(YEAR FROM la2.start_date) = lb.year
                  AND la2.deleted_at IS NULL), 0
             )                                                      AS remaining_days,
             CONCAT(e.first_name, ' ', e.last_name)                 AS employee_name,
             lt.leave_name
      FROM   leave_balances lb
      JOIN   employees  e  ON lb.employee_id   = e.id
      JOIN   leave_types lt ON lb.leave_type_id = lt.id
      WHERE  lb.year = $1
        AND ($2::integer IS NULL OR e.company_id = $2)
      ORDER  BY employee_name, lt.leave_name
    `, [year, companyId]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create / update a single allocation
router.post('/allocate', requireLeaveAdmin, requirePermission('leaves', 'add'), async (req, res) => {
  const { employee_id, leave_type_id, allocated_days, year } = req.body;
  if (!employee_id || !leave_type_id || allocated_days == null) {
    return res.status(400).json({ error: 'employee_id, leave_type_id, and allocated_days are required' });
  }
  const allocYear = Number(year) || new Date().getFullYear();
  try {
    const { rows } = await pool.query(`
      INSERT INTO leave_balances (employee_id, leave_type_id, year, allocated_days)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (employee_id, leave_type_id, year)
      DO UPDATE SET allocated_days = $4, updated_at = NOW()
      RETURNING id, employee_id, leave_type_id, year, allocated_days
    `, [employee_id, leave_type_id, allocYear, Number(allocated_days)]);
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE APPLICATIONS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/applications', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    const filters = { ...req.query, company_id: req.scope?.company_id ?? null };

    // For manager-queue requests: if no manager_id provided, resolve from JWT user_id.
    // This avoids frontend sending the wrong ID type (user.userId vs employee_id).
    if (filters.manager_status && !isAdminOrHR(role) && !filters.manager_id) {
      const empId = req.user?.employee_id;
      if (empId) {
        filters.manager_id = empId;
      } else {
        // Fallback: look up employee_id from users.id
        const { rows } = await pool.query(
          `SELECT id FROM employees WHERE user_id = $1 AND status IS DISTINCT FROM 'Left' LIMIT 1`,
          [req.user?.userId || req.user?.id]
        );
        if (rows[0]?.id) filters.manager_id = rows[0].id;
      }
    }

    const applications = await leavesRepository.findApplications(filters);
    res.json(applications);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/applications/:id', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const application = await leavesRepository.findById(req.params.id);
    if (!application) return res.status(404).json({ error: 'Application not found' });
    res.json(application);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approval history for a leave application
router.get('/applications/:id/history', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT lah.*,
        COALESCE(e.name, CONCAT(e.first_name,' ',COALESCE(e.last_name,''))) AS approver_name,
        e.designation AS approver_designation
      FROM leave_approval_history lah
      LEFT JOIN employees e ON lah.approver_id = e.id
      WHERE lah.leave_application_id = $1
      ORDER BY lah.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Apply for leave with backend balance validation, policy enforcement, notification
async function handleApplyLeave(req, res) {
  try {
    let { employee_id, leave_type_id, leave_type } = req.body;
    if (!employee_id) employee_id = req.user?.employee_id;
    const normalizedPayload = normalizeApplicationPayload(req.body, employee_id, leave_type_id);

    // Always use authenticated user as the employee (unless HR/Admin submitting for another)
    const role = (req.user?.role || '').toLowerCase();
    if (!isAdminOrHR(role)) {
      normalizedPayload.employee_id = req.user?.employee_id;
      employee_id = req.user?.employee_id;
    }

    // Auto-resolve manager_id
    if (!normalizedPayload.manager_id) {
      normalizedPayload.manager_id = await resolveManagerEmployeeId(employee_id);
    }

    // Defensive: the validation engine may resolve undefined/null (no schema
    // configured for 'leaves') or reject — treat either as "valid" so a
    // misconfigured/absent validator can't 500 the apply flow. Matches the
    // finance route's guard.
    const vres = await Promise.resolve(
      validate('leaves', { ...normalizedPayload, days: normalizedPayload.number_of_days })
    ).catch(() => null);
    const { valid, errors } = vres ?? { valid: true, errors: [] };
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'leaves', errors });

    if (!leave_type_id && leave_type) {
      leave_type_id = await resolveLeaveTypeId(leave_type, req.scope?.company_id ?? null);
    }
    if (!leave_type_id) {
      return res.status(400).json({ error: `Leave type "${leave_type || 'unknown'}" not found. Please contact HR to set up leave types.` });
    }

    // ── Backend balance validation ──────────────────────────────────────────
    const requestedDays = Number(normalizedPayload.number_of_days) || 0;
    const applyYear = new Date(normalizedPayload.start_date).getFullYear();
    const { rows: balRows } = await pool.query(`
      SELECT
        COALESCE(lb.allocated_days, lt.annual_quota, 0) AS allocated,
        COALESCE(lb.used_days, 0) AS used,
        COALESCE(
          (SELECT SUM(la2.number_of_days)
           FROM leave_applications la2
           WHERE la2.employee_id = $1 AND la2.leave_type_id = $2
             AND la2.status = 'pending'
             AND EXTRACT(YEAR FROM la2.start_date) = $3
             AND la2.deleted_at IS NULL), 0
        ) AS pending_days,
        COALESCE(lt.allow_negative_balance, false) AS allow_negative
      FROM leave_types lt
      LEFT JOIN leave_balances lb
        ON lb.employee_id = $1 AND lb.leave_type_id = lt.id AND lb.year = $3
      WHERE lt.id = $2 AND lt.deleted_at IS NULL
    `, [employee_id, leave_type_id, applyYear]);

    if (balRows.length) {
      const { allocated, used, pending_days, allow_negative } = balRows[0];
      const available = Number(allocated) - Number(used) - Number(pending_days);
      if (!allow_negative && requestedDays > available) {
        return res.status(422).json({
          error: `Insufficient leave balance. Available: ${available} day(s), Requested: ${requestedDays} day(s).`,
          code: 'INSUFFICIENT_BALANCE',
          available,
          requested: requestedDays,
        });
      }
    }

    // ── Policy enforcement ─────────────────────────────────────────────────
    const { rows: typeRows } = await pool.query(
      `SELECT min_notice_days, requires_attachment, requires_medical_cert_days,
              allowed_in_probation, max_consecutive_days, sandwich_rule,
              gender_restriction, include_holidays, include_weekends,
              is_lop_type, is_paid
       FROM leave_types WHERE id = $1`, [leave_type_id]
    );
    if (typeRows.length) {
      const lt = typeRows[0];
      const today = new Date(); today.setHours(0,0,0,0);
      const startDate = new Date(normalizedPayload.start_date);
      const endDate   = new Date(normalizedPayload.end_date);
      const noticeDays = Math.ceil((startDate - today) / 86400000);
      const exemptTypes = ['sick', 'medical', 'emergency', 'bereavement'];

      // Min notice
      if (lt.min_notice_days > 0 && noticeDays < lt.min_notice_days) {
        if (!exemptTypes.some(e => (leave_type || '').toLowerCase().includes(e))) {
          return res.status(422).json({
            error: `This leave type requires at least ${lt.min_notice_days} day(s) advance notice.`,
            code: 'INSUFFICIENT_NOTICE',
          });
        }
      }

      // Max consecutive days
      if (lt.max_consecutive_days && requestedDays > lt.max_consecutive_days) {
        return res.status(422).json({
          error: `This leave type allows a maximum of ${lt.max_consecutive_days} consecutive day(s).`,
          code: 'MAX_CONSECUTIVE_EXCEEDED',
        });
      }

      // Attachment required
      if (lt.requires_attachment && !normalizedPayload.attachment_url) {
        return res.status(422).json({ error: 'An attachment is required for this leave type.', code: 'ATTACHMENT_REQUIRED' });
      }

      // Gender restriction
      if (lt.gender_restriction && lt.gender_restriction !== '') {
        const { rows: empGender } = await pool.query(
          `SELECT LOWER(COALESCE(gender,'')) AS gender FROM employees WHERE id = $1`, [employee_id]
        ).catch(() => ({ rows: [] }));
        const empG = empGender[0]?.gender || '';
        const allowed = lt.gender_restriction.toLowerCase();
        if (empG && allowed && !empG.startsWith(allowed[0])) {
          return res.status(422).json({
            error: `This leave type is restricted to ${lt.gender_restriction} employees only.`,
            code: 'GENDER_RESTRICTED',
          });
        }
      }

      // Probation restriction — company policy: employees serving probation may
      // only take Loss of Pay (unpaid) leave. Any paid leave type is blocked
      // regardless of its per-type allowed_in_probation flag. LOP types are
      // always allowed so probationers can still record unpaid absence.
      if (!lt.is_lop_type) {
        const { rows: empProb } = await pool.query(
          `SELECT status, joining_date,
                  COALESCE(probation_end_date, (joining_date + INTERVAL '90 days')::date) AS prob_end
           FROM employees WHERE id = $1`, [employee_id]
        ).catch(() => ({ rows: [] }));
        if (empProb.length) {
          const probEnd = empProb[0].prob_end ? new Date(empProb[0].prob_end) : null;
          const inProbation =
            String(empProb[0].status || '').toLowerCase() === 'probation' ||
            (probEnd && startDate <= probEnd);
          if (inProbation) {
            return res.status(422).json({
              error: 'You are in your probation period. Paid leave is not available — only Loss of Pay (unpaid) leave can be applied.',
              code: 'PROBATION_RESTRICTED',
            });
          }
        }
      }

      // Sandwich rule: if leave starts on Tuesday or ends on Thursday, adjacent
      // weekend days get counted as leave days (per Indian labour law convention).
      if (lt.sandwich_rule) {
        const dayBefore = new Date(startDate); dayBefore.setDate(dayBefore.getDate() - 1);
        const dayAfter  = new Date(endDate);   dayAfter.setDate(dayAfter.getDate() + 1);
        const dowBefore = dayBefore.getDay();
        const dowAfter  = dayAfter.getDay();
        if ((dowBefore === 0 || dowBefore === 6) && (dowAfter === 0 || dowAfter === 6)) {
          return res.status(422).json({
            error: 'Sandwich rule applies: leave cannot be flanked by weekends for this leave type.',
            code: 'SANDWICH_RULE_VIOLATION',
          });
        }
      }
    }

    // ── Overlap detection — reject if same employee already has approved/pending leave on these dates ──
    const { rows: overlapRows } = await pool.query(`
      SELECT id, start_date, end_date, status
      FROM leave_applications
      WHERE employee_id = $1
        AND deleted_at IS NULL
        AND status IN ('pending','approved')
        AND start_date <= $3::date
        AND end_date   >= $2::date
    `, [employee_id, normalizedPayload.start_date, normalizedPayload.end_date]);
    if (overlapRows.length > 0) {
      const o = overlapRows[0];
      return res.status(409).json({
        error: `A ${o.status} leave application already exists for this date range (${o.start_date?.slice(0,10)} – ${o.end_date?.slice(0,10)}). Cancel it before applying again.`,
        code: 'LEAVE_OVERLAP',
      });
    }

    const application = await leavesRepository.applyLeave({ ...normalizedPayload, leave_type_id });

    // Post-persistence side-effects are best-effort. The leave is already saved,
    // so a failure in auditing / rules / notifications / balance auto-init must
    // never turn a successful application into a 500. Promise.resolve() guards
    // against non-promise returns; the try/catch guards against synchronous throws.
    let ruleAlerts = [];
    try {
      logAudit({ userId: req.user?.userId, module: 'leaves', recordId: application.id, recordType: 'leave_application', action: 'create', newData: application, req });
      const ruleResults = await Promise.resolve(evaluateRules('leaves', application)).catch(() => []);
      ruleAlerts = (ruleResults || []).filter(r => r.triggered);
      // Notify manager
      notifyLeaveEvent('submitted', application, req.user, [normalizedPayload.manager_id]);
      // Alert project manager(s) if any project milestones fall within this leave window
      Promise.resolve(notifyProjectMilestoneConflict(application, pool)).catch(() => {});
      // Auto-init balance if not yet allocated (new employee safety net)
      Promise.resolve(leavesRepository.initializeLeaveBalance(employee_id, applyYear)).catch(() => {});
    } catch (sideEffectErr) {
      console.warn('[leaves] post-apply side-effect failed (leave was saved):', sideEffectErr.message);
    }

    res.status(201).json({ ...application, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

router.post('/apply', requirePermission('leaves', 'add'), handleApplyLeave);

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL WORKFLOW — L1 / L2 / L3
// ─────────────────────────────────────────────────────────────────────────────

// L1 — Manager Approval
router.post('/approve/manager/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id; // Always use authenticated user
    const { comments } = req.body;
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_applications WHERE id = $1`, [req.params.id]);
    const application = await leavesRepository.approveByManager(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'approve', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'manager' }, req });
    // Sync to attendance if this is a single-level approval that results in status='approved'
    syncLeaveToAttendance(application, pool).catch(() => {});
    // Post LOP (probation / clubbing) if this approval finalized the leave
    postLopToPayroll(application, pool).catch(() => {});
    // Notify employee + L2 approver (if configured)
    notifyLeaveEvent('approved', { ...application, employee_name: oldRows[0]?.employee_name }, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

router.post('/reject/manager/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    if (!comments?.trim()) return res.status(400).json({ error: 'A rejection reason (comments) is required' });
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_applications WHERE id = $1`, [req.params.id]);
    const application = await leavesRepository.rejectByManager(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'reject', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'manager' }, req });
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('rejected', application, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// L2 — Dept Head Approval
router.post('/approve/l2/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_applications WHERE id = $1`, [req.params.id]);
    const application = await leavesRepository.approveByL2(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'approve', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'l2_approver' }, req });
    // Sync to attendance if this is a single-level approval that results in status='approved'
    syncLeaveToAttendance(application, pool).catch(() => {});
    // Post LOP (probation / clubbing) if this approval finalized the leave
    postLopToPayroll(application, pool).catch(() => {});
    notifyLeaveEvent('approved', application, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

router.post('/reject/l2/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    if (!comments?.trim()) return res.status(400).json({ error: 'A rejection reason (comments) is required' });
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_applications WHERE id = $1`, [req.params.id]);
    const application = await leavesRepository.rejectByL2(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'reject', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'l2_approver' }, req });
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('rejected', application, req.user, [application.employee_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// L3 — HR Final Approval
router.post('/approve/hr/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_applications WHERE id = $1`, [req.params.id]);
    const application = await leavesRepository.approveByHR(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'approve', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'hr' }, req });
    // Auto-sync attendance records for approved leave dates (WFH-aware, holiday-aware)
    syncLeaveToAttendance(application, pool).catch(() => {});
    // Post LOP deduction to active payroll run if this is a Loss of Pay application
    postLopToPayroll(application, pool).catch(() => {});
    notifyLeaveEvent('approved', application, req.user, [application.employee_id, application.manager_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

router.post('/reject/hr/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const actorEmpId = req.user?.employee_id;
    const { comments } = req.body;
    if (!comments?.trim()) return res.status(400).json({ error: 'A rejection reason (comments) is required' });
    const { rows: oldRows } = await pool.query(`SELECT * FROM leave_applications WHERE id = $1`, [req.params.id]);
    const application = await leavesRepository.rejectByHR(req.params.id, actorEmpId, comments);
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'reject', oldData: oldRows[0] ?? null, newData: { ...application, actor_role: 'hr' }, req });
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('rejected', application, req.user, [application.employee_id, application.manager_id]);
    res.json(application);
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// Bulk approve — HR/Admin only
router.post('/bulk-approve', requirePermission('leaves', 'approve'), async (req, res) => {
  const role = (req.user?.role || '').toLowerCase();
  if (!isAdminOrHR(role)) return res.status(403).json({ error: 'Only HR and Admin can bulk approve leaves' });
  const { ids, comments } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array is required' });
  const actorEmpId = req.user?.employee_id;
  const results = [];
  for (const id of ids) {
    try {
      const app = await leavesRepository.updateStatus(id, 'approved', actorEmpId, comments || 'Bulk approved');
      syncLeaveToAttendance(app, pool).catch(() => {});
      notifyLeaveEvent('approved', app, req.user, [app.employee_id]);
      results.push({ id, status: 'approved' });
    } catch (err) {
      results.push({ id, status: 'error', error: err.message });
    }
  }
  logAudit({ userId: req.user?.userId, module: 'leaves', recordId: null, recordType: 'leave_application', action: 'bulk_approve', newData: { ids, results }, req });
  res.json({ success: true, results });
});

// Generic status update (admin/HR only — guarded)
router.put('/applications/:id/status', requirePermission('leaves', 'approve'), handleStatusUpdate);

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR & ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/calendar', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const calendar = await leavesRepository.getLeaveCalendar({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(calendar);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const analytics = await leavesRepository.getLeaveAnalytics({ ...req.query, company_id: req.scope?.company_id ?? null });
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPAT SHIMS — legacy endpoint signatures
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    res.json(await leavesRepository.findApplications({ ...req.query, company_id: req.scope?.company_id ?? null }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy alias — routes through the same full validation as POST /apply
router.post('/', requirePermission('leaves', 'add'), handleApplyLeave);

router.get('/my', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const employeeId = req.user?.employee_id;
    res.json(await leavesRepository.findApplications({ ...req.query, employee_id: employeeId, company_id: req.scope?.company_id ?? null }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/team', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    const filters = { ...req.query, company_id: req.scope?.company_id ?? null };
    if (!isAdminOrHR(role)) {
      filters.manager_id = req.user?.employee_id || null;
      // Security: employees and managers cannot pass arbitrary employee_id to see others
      if (!['manager','team_lead','department_head','l2_approver'].includes(role)) {
        delete filters.employee_id;
      }
    }
    res.json(await leavesRepository.findApplications(filters));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /balance — current user's own balance (uses employee_id, not userId)
router.get('/balance', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const employeeId = req.user?.employee_id;
    if (!employeeId) return res.status(400).json({ error: 'Employee profile not linked to this user account' });
    res.json(await leavesRepository.getLeaveBalance(employeeId, req.query.year));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Legacy approve/reject/cancel shims
router.patch('/:id/approve', requirePermission('leaves', 'approve'), (req, res) =>
  handleStatusUpdate({ ...req, body: { status: 'approved' } }, res)
);
router.put('/:id/approve', requirePermission('leaves', 'approve'), (req, res) =>
  handleStatusUpdate({ ...req, body: { status: 'approved' } }, res)
);
router.patch('/:id/reject', requirePermission('leaves', 'approve'), (req, res) =>
  handleStatusUpdate({ ...req, body: { status: 'rejected', ...req.body } }, res)
);
router.put('/:id/reject', requirePermission('leaves', 'approve'), (req, res) =>
  handleStatusUpdate({ ...req, body: { status: 'rejected', ...req.body } }, res)
);

// Cancel — employee can cancel their own, HR/Admin can cancel any
router.put('/:id/cancel', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const role = (req.user?.role || '').toLowerCase();
    const { rows: appRows } = await pool.query(`SELECT * FROM leave_applications WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!appRows.length) return res.status(404).json({ error: 'Leave application not found' });
    const app = appRows[0];
    // Non-admin employees can only cancel their own
    if (!isAdminOrHR(role)) {
      if (String(app.employee_id) !== String(req.user?.employee_id)) {
        return res.status(403).json({ error: 'You can only cancel your own leave applications' });
      }
    }
    const application = await leavesRepository.updateStatus(req.params.id, 'cancelled', req.user?.employee_id, req.body.reason || '');
    reverseLeaveAttendance(application, pool).catch(() => {});
    notifyLeaveEvent('cancelled', { ...application, employee_name: app.employee_name }, req.user, [app.manager_id, app.hr_id]);
    res.json({ success: true, ...application });
  } catch (error) {
    res.status(statusForWorkflowError(error)).json({ error: error.message });
  }
});

// Withdraw — employee retracts an already-approved leave (before leave date)
router.post('/:id/withdraw', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ error: 'Withdrawal reason is required' });
    const role = (req.user?.role || '').toLowerCase();
    const { rows: appRows } = await pool.query(`SELECT * FROM leave_applications WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!appRows.length) return res.status(404).json({ error: 'Leave application not found' });
    const app = appRows[0];
    if (!isAdminOrHR(role) && String(app.employee_id) !== String(req.user?.employee_id)) {
      return res.status(403).json({ error: 'You can only withdraw your own leave applications' });
    }
    if (!['approved', 'pending'].includes(app.status)) {
      return res.status(409).json({ error: `Cannot withdraw a leave in '${app.status}' status` });
    }
    const application = await leavesRepository.updateStatus(req.params.id, 'cancelled', req.user?.employee_id, reason);
    await pool.query(`UPDATE leave_applications SET withdrawal_reason = $1 WHERE id = $2`, [reason, req.params.id]);
    reverseLeaveAttendance(application, pool).catch(() => {});
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'withdraw', newData: { withdrawal_reason: reason }, req });
    notifyLeaveEvent('cancelled', { ...application, employee_name: app.employee_name }, req.user, [app.manager_id, app.hr_id]);
    res.json({ success: true, withdrawal_reason: reason, ...application });
  } catch (err) {
    res.status(statusForWorkflowError(err)).json({ error: err.message });
  }
});

// ── GET /on-leave-today — employees on approved leave right now ───────────────
router.get('/on-leave-today', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(`
      SELECT DISTINCT
        la.id AS leave_id,
        la.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department, e.designation,
        lt.leave_name,
        la.start_date, la.end_date, la.number_of_days
      FROM leave_applications la
      JOIN employees e  ON la.employee_id = e.id
      JOIN leave_types lt ON la.leave_type_id = lt.id
      WHERE la.status = 'approved'
        AND la.deleted_at IS NULL
        AND la.start_date <= $1::date
        AND la.end_date   >= $1::date
        AND ($2::integer IS NULL OR e.company_id = $2)
      ORDER BY e.department, employee_name
    `, [today, companyId]);
    res.json({ date: today, count: rows.length, employees: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /delegate/:id — manager sets a delegate approver for a pending leave ─
router.post('/delegate/:id', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const { delegate_employee_id, comments } = req.body;
    if (!delegate_employee_id) return res.status(400).json({ error: 'delegate_employee_id is required' });
    const { rows } = await pool.query(`
      UPDATE leave_applications
      SET delegate_approver_id = $1, updated_at = NOW()
      WHERE id = $2
        AND status = 'pending'
        AND deleted_at IS NULL
      RETURNING *
    `, [delegate_employee_id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Leave not found or not in pending state' });
    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.id, recordType: 'leave_application', action: 'delegate', newData: { delegate_employee_id, comments }, req });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /accrual-history — per-employee monthly accrual log ──────────────────
router.get('/accrual-history', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const year = Number(req.query.year) || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT
        lb.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department,
        lt.leave_name,
        lb.year,
        lb.allocated_days,
        lb.carried_forward_days,
        lb.used_days,
        lb.encashed_days,
        GREATEST(
          COALESCE(lb.allocated_days,0) - COALESCE(lb.used_days,0) - COALESCE(lb.encashed_days,0), 0
        ) AS available_days,
        lb.updated_at
      FROM leave_balances lb
      JOIN employees e  ON lb.employee_id = e.id
      JOIN leave_types lt ON lb.leave_type_id = lt.id
      WHERE lb.year = $1
        AND ($2::integer IS NULL OR e.company_id = $2)
        AND lt.accrual_type = 'monthly'
        AND e.status IS DISTINCT FROM 'Left'
      ORDER BY e.department, employee_name, lt.leave_name
    `, [year, companyId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /carry-forward-report — annual carry-forward audit ───────────────────
router.get('/carry-forward-report', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const year = Number(req.query.year) || new Date().getFullYear();
    const { rows } = await pool.query(`
      SELECT
        lb.employee_id,
        COALESCE(e.name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
        e.department,
        lt.leave_name,
        lb.year,
        COALESCE(lb.carried_forward_days, 0) AS carried_forward_days,
        lt.max_carry_forward_days,
        lt.carry_forward_expiry_months,
        lb.updated_at
      FROM leave_balances lb
      JOIN employees e  ON lb.employee_id = e.id
      JOIN leave_types lt ON lb.leave_type_id = lt.id
      WHERE lb.year = $1
        AND COALESCE(lb.carried_forward_days, 0) > 0
        AND ($2::integer IS NULL OR e.company_id = $2)
        AND e.status IS DISTINCT FROM 'Left'
      ORDER BY e.department, employee_name, lt.leave_name
    `, [year, companyId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE POLICIES — per-company policy overrides for each leave type
// ─────────────────────────────────────────────────────────────────────────────

router.get('/policies', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const { rows } = await pool.query(`
      SELECT lp.*, lt.leave_name, lt.leave_code
      FROM leave_policies lp
      JOIN leave_types lt ON lt.id = lp.leave_type_id
      WHERE lp.company_id = $1
      ORDER BY lt.leave_name
    `, [companyId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/policies/:leave_type_id', requireLeaveAdmin, requirePermission('leaves', 'edit'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    if (!companyId) return res.status(400).json({ error: 'Company context required' });

    const policyFields = [
      'policy_name','accrual_type','accrual_days_per_month','accrual_start',
      'probation_allowed','notice_period_allowed','min_notice_days','max_consecutive_days',
      'sandwich_rule','include_weekends','include_holidays','carry_forward_allowed',
      'max_carry_forward_days','carry_forward_expiry_months','allow_negative_balance',
      'requires_attachment','requires_medical_cert_days','gender_restriction',
      'department_restriction','is_active',
    ];

    const sets = ['updated_at = NOW()'];
    const params = [companyId, req.params.leave_type_id];
    for (const field of policyFields) {
      if (req.body[field] !== undefined) {
        params.push(req.body[field]);
        sets.push(`${field} = $${params.length}`);
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO leave_policies (company_id, leave_type_id, ${policyFields.filter(f => req.body[f] !== undefined).join(', ')})
      VALUES ($1, $2, ${policyFields.filter(f => req.body[f] !== undefined).map((_, i) => `$${i + 3}`).join(', ')})
      ON CONFLICT (company_id, leave_type_id)
      DO UPDATE SET ${sets.join(', ')}
      RETURNING *
    `, params);

    logAudit({ userId: req.user?.userId, module: 'leaves', recordId: req.params.leave_type_id, recordType: 'leave_policy', action: 'update', newData: req.body, req });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Workflow engine integration — protected
router.get('/:id/workflow', requirePermission('leaves', 'view'), async (req, res) => {
  try {
    const { getWorkflowStatus } = await import('../../../services/WorkflowService.js');
    const status = await getWorkflowStatus('leaves', parseInt(req.params.id));
    res.json(status || { status: 'no_workflow' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/workflow/advance', requirePermission('leaves', 'approve'), async (req, res) => {
  try {
    const { getWorkflowStatus, advanceWorkflow } = await import('../../../services/WorkflowService.js');
    const { action, comments } = req.body;
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ error: 'action must be approve or reject' });
    const instance = await getWorkflowStatus('leaves', parseInt(req.params.id));
    if (!instance || instance.status === 'no_workflow')
      return res.status(404).json({ error: 'No active workflow for this leave' });
    if (['approved', 'rejected', 'cancelled'].includes(instance.status))
      return res.status(400).json({ error: `Workflow already ${instance.status}` });
    const result = await advanceWorkflow(instance.id, action, req.user.userId, comments || '');
    if (result.status === 'approved' || result.status === 'rejected') {
      await leavesRepository.updateStatus(req.params.id, result.status, req.user?.employee_id || null, comments || '');
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
