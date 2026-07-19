import pool from "../../config/db.js";
import { notifyWorkflowEvent } from "../../services/WorkflowNotificationService.js";
import { logAudit } from "../../services/AuditService.js";
import { canOverride } from "./approvals.authz.js";

const uid  = (req) => req.user?.userId ?? req.user?.id ?? null;
const cid  = (req) => req.scope?.company_id ?? null;
const role = (req) => req.user?.role ?? '';

// ─── helpers ────────────────────────────────────────────────────────────────

function isSupervisor(req) {
  const r = (role(req) || '').toLowerCase();
  return ['super_admin', 'admin', 'manager', 'l1_manager', 'l2_manager', 'l3_manager', 'hr'].includes(r);
}

// Safe query: returns [] instead of throwing when a source table doesn't exist yet.
// Only silences undefined-table (42P01) errors — column errors (42703) and others still throw,
// so a missing column in an UPDATE is never silently swallowed.
async function safeQuery(sql, params) {
  try {
    const r = await pool.query(sql, params);
    return r.rows;
  } catch (e) {
    if (e.code === '42P01' || e.code === 'undefined_table') return [];
    throw e;
  }
}

// ─── source-table queries (each returns normalized pending rows) ──────────────

async function pendingLeaves(companyId) {
  const params  = companyId != null ? [companyId] : [];
  const cFilter = companyId != null ? `AND e.company_id = $1` : '';
  const rows = await safeQuery(
    `SELECT
       'leave:' || la.id::text          AS id,
       'leave'                           AS module_name,
       la.id::text                       AS source_id,
       'Leave'                           AS request_type,
       CONCAT(e.first_name, ' ', COALESCE(e.last_name,'')) AS requested_by,
       NULL::integer                     AS requester_id,
       e.company_email                   AS requester_email,
       NULL                              AS department,
       la.applied_at                     AS request_date,
       NULL::numeric                     AS amount,
       'Medium'                          AS priority,
       'Pending'                         AS status,
       NULL::integer                     AS approver_id,
       CONCAT('Leave request from ', e.first_name) AS request_title,
       la.reason                         AS description,
       e.company_id                      AS company_id
     FROM leave_applications la
     LEFT JOIN employees e ON e.id::text = la.employee_id::text
     WHERE la.status = 'pending' ${cFilter}
     ORDER BY la.applied_at ASC`,
    params
  );
  return rows;
}

async function pendingRegularizations(companyId) {
  const params = companyId != null ? [companyId] : [];
  const cFilter = companyId != null ? `AND arr.company_id = $1` : '';
  return safeQuery(
    `SELECT
       'reg:' || arr.id::text            AS id,
       'regularization'                  AS module_name,
       arr.id::text                      AS source_id,
       'Regularization'                  AS request_type,
       arr.employee_id::text             AS requested_by,
       NULL::integer                     AS requester_id,
       NULL                              AS requester_email,
       NULL                              AS department,
       arr.created_at                    AS request_date,
       NULL::numeric                     AS amount,
       'Medium'                          AS priority,
       'Pending'                         AS status,
       arr.manager_id                    AS approver_id,
       CONCAT('Attendance regularization for ', arr.date) AS request_title,
       arr.reason                        AS description,
       arr.company_id
     FROM attendance_regularization_requests arr
     WHERE arr.status = 'pending' ${cFilter}
     ORDER BY arr.created_at ASC`,
    params
  );
}

async function pendingOT(companyId) {
  const params = companyId != null ? [companyId] : [];
  const cFilter = companyId != null ? `AND ot.company_id = $1` : '';
  return safeQuery(
    `SELECT
       'ot:' || ot.id::text              AS id,
       'ot'                              AS module_name,
       ot.id::text                       AS source_id,
       'OT'                              AS request_type,
       ot.employee_id::text              AS requested_by,
       ot.employee_id                    AS requester_id,
       NULL                              AS requester_email,
       NULL                              AS department,
       ot.created_at                     AS request_date,
       ot.ot_hours                       AS amount,
       'Medium'                          AS priority,
       'Pending'                         AS status,
       ot.approved_by                    AS approver_id,
       CONCAT('Overtime ', ot.ot_hours, 'h on ', ot.attendance_date) AS request_title,
       ot.reason                         AS description,
       ot.company_id
     FROM attendance_ot_records ot
     WHERE ot.status = 'pending' ${cFilter}
     ORDER BY ot.created_at ASC`,
    params
  );
}

async function pendingPurchaseRequests(companyId) {
  const params  = companyId != null ? [companyId] : [];
  const cFilter = companyId != null ? `AND e.company_id = $1` : '';
  return safeQuery(
    `SELECT
       'pr:' || pr.id::text              AS id,
       'purchase_request'                AS module_name,
       pr.id::text                       AS source_id,
       'Purchase'                        AS request_type,
       COALESCE(TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')), pr.requested_by_employee_id::text) AS requested_by,
       pr.requested_by_employee_id       AS requester_id,
       e.company_email                   AS requester_email,
       NULL                              AS department,
       pr.request_date                   AS request_date,
       NULL::numeric                     AS amount,
       'High'                            AS priority,
       'Pending'                         AS status,
       pr.approved_by                    AS approver_id,
       CONCAT('Purchase Request ', pr.request_number) AS request_title,
       pr.notes                          AS description,
       e.company_id
     FROM purchase_requests pr
     LEFT JOIN employees e ON e.id = pr.requested_by_employee_id
     WHERE pr.status IN ('pending_approval', 'pending') ${cFilter}
     ORDER BY pr.request_date ASC`,
    params
  );
}

async function pendingExpenses(companyId) {
  const params  = companyId != null ? [companyId] : [];
  const cFilter = companyId != null ? `AND e.company_id = $1` : '';
  return safeQuery(
    `SELECT
       'exp:' || ec.id::text             AS id,
       'expense'                         AS module_name,
       ec.id::text                       AS source_id,
       'Expense'                         AS request_type,
       COALESCE(TRIM(e.first_name || ' ' || COALESCE(e.last_name,'')), ec.employee_id::text) AS requested_by,
       ec.employee_id                    AS requester_id,
       e.company_email                   AS requester_email,
       NULL                              AS department,
       ec.claim_date                     AS request_date,
       ec.total_amount                   AS amount,
       'Medium'                          AS priority,
       'Pending'                         AS status,
       ec.approved_by                    AS approver_id,
       CONCAT('Expense Claim ', ec.claim_number) AS request_title,
       ec.notes                          AS description,
       e.company_id
     FROM expense_claims ec
     LEFT JOIN employees e ON e.id = ec.employee_id
     WHERE ec.status = 'Pending' ${cFilter}
     ORDER BY ec.claim_date ASC`,
    params
  );
}

async function pendingECNs(companyId) {
  const params  = companyId != null ? [companyId] : [];
  const cFilter = companyId != null ? `AND emp.company_id = $1` : '';
  return safeQuery(
    `SELECT
       'ecn:' || ec.id::text             AS id,
       'ecn'                             AS module_name,
       ec.id::text                       AS source_id,
       'ECN'                             AS request_type,
       COALESCE(ec.requested_by_name, ec.requested_by::text) AS requested_by,
       ec.requested_by                   AS requester_id,
       emp.company_email                 AS requester_email,
       NULL                              AS department,
       ec.created_at                     AS request_date,
       NULL::numeric                     AS amount,
       CASE ec.severity
         WHEN 'critical' THEN 'High'
         WHEN 'high'     THEN 'High'
         WHEN 'medium'   THEN 'Medium'
         ELSE 'Low'
       END                               AS priority,
       'Pending'                         AS status,
       ec.approved_by                    AS approver_id,
       CONCAT('[', ec.change_type, '] ', ec.title) AS request_title,
       ec.reason                         AS description,
       emp.company_id
     FROM engineering_changes ec
     LEFT JOIN employees emp ON emp.id = ec.requested_by
     WHERE ec.status = 'submitted' ${cFilter}
     ORDER BY ec.created_at ASC`,
    params
  );
}

async function pendingPaymentBatches(companyId) {
  return safeQuery(
    `SELECT
       'pay:' || pb.id::text             AS id,
       'payment'                         AS module_name,
       pb.id::text                       AS source_id,
       'Payment'                         AS request_type,
       pb.created_by::text               AS requested_by,
       pb.created_by                     AS requester_id,
       NULL                              AS requester_email,
       NULL                              AS department,
       pb.batch_date                     AS request_date,
       pb.total_amount                   AS amount,
       'High'                            AS priority,
       'Pending'                         AS status,
       pb.approved_by                    AS approver_id,
       CONCAT('Payment Batch ', pb.batch_number) AS request_title,
       pb.notes                          AS description,
       NULL::integer                     AS company_id
     FROM payment_batches pb
     WHERE pb.status = 'Awaiting_Approval'
     ORDER BY pb.batch_date ASC`,
    []
  );
}

// Central approvals table rows (existing + probation etc.)
async function pendingCentral(userId, companyId) {
  const cidFilter = companyId != null ? `AND company_id = $2` : '';
  // Exclude module types already handled by dedicated source queries — those source queries
  // scan the live tables directly, so showing them here too creates phantom duplicates that
  // persist after the source record is approved.
  const SOURCE_MODULES = `('leave','regularization','reg','ot','purchase_request','purchase','pr','expense','exp','ecn','payment','pay')`;
  const rows = await safeQuery(
    `SELECT
       id::text                                    AS id,
       COALESCE(module_name, reference_type)       AS module_name,
       reference_id::text                          AS source_id,
       COALESCE(module_name, reference_type)       AS request_type,
       COALESCE(requester_name, requested_by::text)  AS requested_by,
       requested_by                                AS requester_id,
       NULL                                        AS requester_email,
       NULL                                        AS department,
       request_date,
       NULL::numeric                               AS amount,
       NULL                                        AS priority,
       status,
       approver_id,
       title                                       AS request_title,
       description,
       company_id
     FROM approvals
     WHERE approver_id = $1 AND status = 'Pending' ${cidFilter}
     AND COALESCE(module_name, reference_type) NOT IN ${SOURCE_MODULES}
     ORDER BY request_date ASC`,
    companyId != null ? [userId, companyId] : [userId]
  );
  return rows;
}

// ─── controller functions ────────────────────────────────────────────────────

export const getAllApprovals = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const companyId = cid(req);
    const { status, module_name, limit = 100, offset = 0 } = req.query;

    const conditions = ['1=1'];
    const params = [];

    if (companyId != null) { params.push(companyId); conditions.push(`company_id = $${params.length}`); }
    if (status)      { params.push(status);      conditions.push(`status = $${params.length}`); }
    if (module_name) { params.push(module_name); conditions.push(`module_name = $${params.length}`); }
    params.push(parseInt(limit, 10), parseInt(offset, 10));

    const result = await pool.query(
      `SELECT * FROM approvals
       WHERE ${conditions.join(' AND ')}
       ORDER BY request_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get all approvals error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getPendingApprovals = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const userId    = uid(req);
    const companyId = cid(req);
    const isAdmin   = isSupervisor(req);
    const limit     = Math.min(parseInt(req.query.limit  || '200', 10), 500);
    const offset    = parseInt(req.query.offset || '0', 10);

    // Fetch from all sources in parallel; each is resilient to missing tables
    const [central, leaves, regs, ots, prs, exps, ecns, pays] = await Promise.all([
      pendingCentral(userId, companyId),
      pendingLeaves(companyId),
      pendingRegularizations(companyId),
      pendingOT(companyId),
      pendingPurchaseRequests(companyId),
      pendingExpenses(companyId),
      pendingECNs(companyId),
      pendingPaymentBatches(companyId),
    ]);

    let all = [...central, ...leaves, ...regs, ...ots, ...prs, ...exps, ...ecns, ...pays];

    // Non-admins only see items assigned to them or unassigned within their company
    if (!isAdmin) {
      all = all.filter(r =>
        r.approver_id == null || String(r.approver_id) === String(userId)
      );
    }

    // Sort by request_date ascending (oldest first), then paginate
    all.sort((a, b) => new Date(a.request_date) - new Date(b.request_date));

    res.json(all.slice(offset, offset + limit));
  } catch (err) {
    console.error("Get pending approvals error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getApprovalHistory = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const userId    = uid(req);
    const companyId = cid(req);
    const cidFilter = companyId != null ? `AND company_id = $2` : '';

    const result = await pool.query(
      `SELECT *,
              COALESCE(requester_name, requested_by::text) AS requested_by,
              COALESCE(module_name, reference_type) AS request_type,
              title AS request_title
       FROM approvals
       WHERE approver_id = $1 AND status IN ('Approved', 'Rejected', 'Escalated') ${cidFilter}
       ORDER BY decision_date DESC
       LIMIT 100`,
      companyId != null ? [userId, companyId] : [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get approval history error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getApprovalStats = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const userId    = uid(req);
    const companyId = cid(req);
    const isAdmin   = isSupervisor(req);
    const today     = new Date().toISOString().split('T')[0];
    const cidFilter = companyId != null ? `AND company_id = $2` : '';

    // Central approvals table counts
    const [centralPending, approvedToday, rejectedToday, centralOverdue] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count FROM approvals WHERE approver_id = $1 AND status = 'Pending' ${cidFilter}`,
        companyId != null ? [userId, companyId] : [userId]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM approvals WHERE approver_id = $1 AND status = 'Approved' AND DATE(decision_date) = $2 ${companyId != null ? 'AND company_id = $3' : ''}`,
        companyId != null ? [userId, today, companyId] : [userId, today]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM approvals WHERE approver_id = $1 AND status = 'Rejected' AND DATE(decision_date) = $2 ${companyId != null ? 'AND company_id = $3' : ''}`,
        companyId != null ? [userId, today, companyId] : [userId, today]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM approvals WHERE approver_id = $1 AND status = 'Pending' AND request_date < NOW() - INTERVAL '48 hours' ${cidFilter}`,
        companyId != null ? [userId, companyId] : [userId]
      ),
    ]);

    // Reuse source-table functions for user-scoped, company-scoped counts
    const [leaves, regs, ots, prs, exps, ecns, pays] = await Promise.all([
      pendingLeaves(companyId),
      pendingRegularizations(companyId),
      pendingOT(companyId),
      pendingPurchaseRequests(companyId),
      pendingExpenses(companyId),
      pendingECNs(companyId),
      pendingPaymentBatches(companyId),
    ]);

    let allSource = [...leaves, ...regs, ...ots, ...prs, ...exps, ...ecns, ...pays];
    if (!isAdmin) {
      allSource = allSource.filter(r =>
        r.approver_id == null || String(r.approver_id) === String(userId)
      );
    }

    const overdueSource = allSource.filter(r =>
      r.request_date && (Date.now() - new Date(r.request_date).getTime()) > 172800000
    ).length;

    const pendingTotal = parseInt(centralPending.rows[0].count) + allSource.length;
    const overdueTotal = parseInt(centralOverdue.rows[0].count) + overdueSource;

    // SLA: % of decisions (approved+rejected) made within 48h of submission in last 30 days
    const slaResult = await safeQuery(
      `SELECT
         COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (decision_date - request_date)) <= 172800) AS within_sla,
         COUNT(*) AS total
       FROM approvals
       WHERE approver_id = $1
         AND status IN ('Approved','Rejected')
         AND decision_date >= NOW() - INTERVAL '30 days'
         ${cidFilter}`,
      companyId != null ? [userId, companyId] : [userId]
    );
    const slaTotalRows = slaResult[0]?.total ?? 0;
    const slaWithin    = slaResult[0]?.within_sla ?? 0;
    const slaCompliance = slaTotalRows > 0
      ? Math.round((parseInt(slaWithin) / parseInt(slaTotalRows)) * 100)
      : null;

    res.json({
      pending:       pendingTotal,
      approvedToday: parseInt(approvedToday.rows[0].count),
      rejectedToday: parseInt(rejectedToday.rows[0].count),
      overdue:       overdueTotal,
      slaCompliance,
    });
  } catch (err) {
    console.error("Get approval stats error:", err);
    res.status(500).json({ error: err.message });
  }
};

// ─── source-table dispatch for approve/reject ───────────────────────────────

async function approveSourceItem(modulePrefix, sourceId, userId, actorRole = null) {
  switch (modulePrefix) {
    case 'leave':
      await safeQuery(
        `UPDATE leave_applications SET status = 'approved', manager_status = 'approved', manager_approved_at = NOW() WHERE id = $1::integer`,
        [sourceId]
      );
      break;
    case 'reg': {
      const regRows = await safeQuery(
        `SELECT * FROM attendance_regularization_requests WHERE id = $1`,
        [sourceId]
      );
      await safeQuery(
        `UPDATE attendance_regularization_requests
            SET status = 'approved', manager_id = $2, manager_actioned_at = NOW(), approval_level = 'done'
          WHERE id = $1`,
        [sourceId, userId]
      );
      const r = regRows[0];
      if (r) {
        // Apply the attendance correction so the record reflects the corrected times
        await safeQuery(`
          INSERT INTO attendance_records (employee_id, attendance_date, status, company_id)
          VALUES ($1, $2, 'present', $3)
          ON CONFLICT (employee_id, attendance_date) DO UPDATE
            SET status         = 'present',
                check_in_time  = COALESCE($4::time, attendance_records.check_in_time),
                check_out_time = COALESCE($5::time, attendance_records.check_out_time),
                updated_at     = NOW()
        `, [r.employee_id, r.date, r.company_id, r.check_in || null, r.check_out || null]);
        // Notify the employee
        await safeQuery(`
          INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
          SELECT u.id, 'Regularization Approved',
                 'Your attendance correction for ' || $2 || ' has been approved.',
                 'attendance', $3, 'regularization'
            FROM users u WHERE u.employee_id = $1::integer LIMIT 1
        `, [r.employee_id, r.date, r.id]);
      }
      break;
    }
    case 'ot':
      await safeQuery(
        `UPDATE attendance_ot_records SET status = 'approved', approved_by = $2, approved_at = NOW() WHERE id = $1`,
        [sourceId, userId]
      );
      break;
    case 'pr': {
      // Enforce the same amount-based approval limits as the procurement route
      // (see requiredApprovalLevel/canApprove in procurement.routes.js) so this
      // generic Approval Center cannot become a back door around L1/L2/CFO gating.
      const prRows = await safeQuery(
        `SELECT pr.company_id,
                GREATEST(
                  COALESCE(pr.total_amount, 0),
                  COALESCE((SELECT SUM(COALESCE(quantity, 0) * COALESCE(expected_price, 0))
                            FROM purchase_request_items WHERE pr_id = pr.id), 0)
                ) AS amount
           FROM purchase_requests pr WHERE pr.id = $1::integer`,
        [sourceId]
      );
      const pr = prRows[0];
      if (pr) {
        const amount  = parseFloat(pr.amount || 0);
        const setRows = await safeQuery(
          `SELECT auto_approve_below, l1_approval_limit, l2_approval_limit
             FROM procurement_settings WHERE company_id = $1 LIMIT 1`,
          [pr.company_id]
        );
        const s        = setRows[0] || {};
        const autoBelow = parseFloat(s.auto_approve_below ?? 5000);
        const l1        = parseFloat(s.l1_approval_limit  ?? 25000);
        const l2        = parseFloat(s.l2_approval_limit  ?? 100000);
        let required = 'auto';
        if      (amount > l2)        required = 'cfo';
        else if (amount > l1)        required = 'l2';
        else if (amount > autoBelow) required = 'l1';

        const rank     = { auto: 0, l1: 1, l2: 2, cfo: 3 };
        const roleRank = {
          manager: 1, department_head: 1,
          senior_manager: 2, procurement_manager: 2,
          cfo: 3, finance_head: 3, admin: 3, super_admin: 3,
        };
        if (required !== 'auto' && (roleRank[actorRole] ?? 0) < rank[required]) {
          const err = new Error(
            `This purchase request (₹${amount.toLocaleString('en-IN')}) requires ${required.toUpperCase()} approval; ` +
            `your role (${actorRole || 'unknown'}) is insufficient. Approve it from Procurement › Purchase Requests.`
          );
          err.statusCode = 403;
          throw err;
        }
      }
      await safeQuery(
        `UPDATE purchase_requests SET status = 'approved', approved_by = $2, approved_at = NOW() WHERE id = $1::integer`,
        [sourceId, userId]
      );
      break;
    }
    case 'exp':
      await safeQuery(
        `UPDATE expense_claims SET status = 'Approved', approved_by = $2, approved_at = NOW() WHERE id = $1::integer`,
        [sourceId, userId]
      );
      break;
    case 'ecn':
      await safeQuery(
        `UPDATE engineering_changes SET status = 'approved', approved_by = $2, approved_by_name = (SELECT CONCAT(first_name,' ',last_name) FROM employees WHERE id = $2 LIMIT 1), approved_at = NOW() WHERE id = $1`,
        [sourceId, userId]
      );
      break;
    case 'pay':
      await safeQuery(
        `UPDATE payment_batches SET status = 'Approved', approved_by = $2, approved_at = NOW() WHERE id = $1::integer`,
        [sourceId, userId]
      );
      break;
    default:
      break;
  }
}

async function rejectSourceItem(modulePrefix, sourceId, userId, comment) {
  switch (modulePrefix) {
    case 'leave':
      await safeQuery(
        `UPDATE leave_applications SET status = 'rejected', manager_status = 'rejected', manager_comments = $2, manager_approved_at = NOW() WHERE id = $1::integer`,
        [sourceId, comment]
      );
      break;
    case 'reg': {
      await safeQuery(
        `UPDATE attendance_regularization_requests
            SET status = 'rejected', manager_remarks = $2, manager_id = $3, manager_actioned_at = NOW()
          WHERE id = $1`,
        [sourceId, comment, userId]
      );
      // Notify the employee of the rejection
      await safeQuery(`
        INSERT INTO notifications (user_id, title, message, module_name, reference_id, notification_type)
        SELECT u.id, 'Regularization Rejected',
               'Your attendance correction request for ' || r.date || ' was rejected' ||
               CASE WHEN $2 <> '' THEN ': ' || $2 ELSE '.' END,
               'attendance', $1::integer, 'regularization'
          FROM attendance_regularization_requests r
          JOIN users u ON u.employee_id = r.employee_id::integer
         WHERE r.id = $1::integer
         LIMIT 1
      `, [sourceId, comment || '']);
      break;
    }
    case 'ot':
      await safeQuery(
        `UPDATE attendance_ot_records SET status = 'rejected', rejection_remarks = $2 WHERE id = $1`,
        [sourceId, comment]
      );
      break;
    case 'pr':
      await safeQuery(
        `UPDATE purchase_requests SET status = 'rejected', rejection_reason = $2, approved_at = NOW() WHERE id = $1::integer`,
        [sourceId, comment]
      );
      break;
    case 'exp':
      await safeQuery(
        `UPDATE expense_claims SET status = 'Rejected', rejection_reason = $2, approved_at = NOW() WHERE id = $1::integer`,
        [sourceId, comment]
      );
      break;
    case 'ecn':
      await safeQuery(
        `UPDATE engineering_changes SET status = 'rejected' WHERE id = $1`,
        [sourceId]
      );
      break;
    case 'pay':
      await safeQuery(
        `UPDATE payment_batches SET status = 'Rejected', rejection_reason = $2 WHERE id = $1::integer`,
        [sourceId, comment]
      );
      break;
    default:
      break;
  }
}

// ─── approve / reject / bulk ─────────────────────────────────────────────────

export const approveRequest = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.params;
    const userId    = uid(req);
    const companyId = cid(req);
    const isSource  = id.includes(':');

    if (isSource) {
      const [prefix, sourceId] = id.split(':');
      await approveSourceItem(prefix, sourceId, userId, role(req));

      // Close any existing pending central-approval row for the same reference
      const refId = /^\d+$/.test(sourceId) ? parseInt(sourceId, 10) : null;
      const updated = await safeQuery(
        `UPDATE approvals
           SET status = 'Approved', decision_date = NOW(), approver_id = $1
         WHERE module_name = $2 AND reference_id = $3 AND status = 'Pending'
         RETURNING id`,
        [userId, prefix, refId]
      );

      // Only insert a history row if no existing row was updated
      if (!updated.length) {
        const label = prefix.charAt(0).toUpperCase() + prefix.slice(1);
        await safeQuery(
          `INSERT INTO approvals
             (module_name, reference_id, reference_type, title,
              requester_name, approver_id, status, decision_date, company_id)
           VALUES ($1, $2, $3, $4, 'System', $5, 'Approved', NOW(), $6)`,
          [prefix, refId, label, `${label} #${sourceId}`, userId, companyId]
        );
      }

      logAudit({
        userId, module: 'approvals', recordId: sourceId,
        recordType: prefix, action: 'approve',
        oldData: { status: 'Pending' }, newData: { status: 'Approved' }, req,
      });
      notifyWorkflowEvent('approved', { module: prefix, recordId: sourceId, submitterUserId: userId });
      return res.json({ id, status: 'Approved', decision_date: new Date() });
    }

    // Central approvals table
    const cidFilter = companyId != null ? `AND company_id = $3` : '';
    const result = await pool.query(
      `UPDATE approvals
       SET status = 'Approved', decision_date = NOW(), approver_id = $1
       WHERE id = $2 AND status = 'Pending' ${cidFilter}
       RETURNING *`,
      companyId != null ? [userId, id, companyId] : [userId, id]
    );
    const approval = result.rows[0];
    if (!approval) return res.status(409).json({ error: 'Approval not found or already processed' });

    // Also approve the linked source-table record so it no longer shows as pending
    if (approval.reference_id && approval.module_name) {
      await approveSourceItem(approval.module_name, String(approval.reference_id), userId, role(req));
    }

    logAudit({
      userId, module: 'approvals', recordId: id,
      recordType: approval.module_name || 'approval', action: 'approve',
      oldData: { status: 'Pending' }, newData: { status: 'Approved', decision_date: approval.decision_date }, req,
    });
    notifyWorkflowEvent('approved', {
      module: approval.module_name || 'Approval',
      recordId: approval.reference_id || approval.id,
      submitterUserId: approval.requested_by,
    });
    res.json(approval);
  } catch (err) {
    console.error("Approve request error:", err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

export const rejectRequest = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.params;
    const { comment } = req.body;
    const userId    = uid(req);
    const companyId = cid(req);
    const isSource  = id.includes(':');

    if (isSource) {
      const [prefix, sourceId] = id.split(':');
      await rejectSourceItem(prefix, sourceId, userId, comment || '');

      // Close any existing pending central-approval row for the same reference
      const refId = /^\d+$/.test(sourceId) ? parseInt(sourceId, 10) : null;
      const updated = await safeQuery(
        `UPDATE approvals
           SET status = 'Rejected', decision_date = NOW(), approver_id = $1, comments = $2
         WHERE module_name = $3 AND reference_id = $4 AND status = 'Pending'
         RETURNING id`,
        [userId, comment || '', prefix, refId]
      );

      // Only insert a history row if no existing row was updated
      if (!updated.length) {
        const label = prefix.charAt(0).toUpperCase() + prefix.slice(1);
        await safeQuery(
          `INSERT INTO approvals
             (module_name, reference_id, reference_type, title,
              requester_name, approver_id, status, decision_date, comments, company_id)
           VALUES ($1, $2, $3, $4, 'System', $5, 'Rejected', NOW(), $6, $7)`,
          [prefix, refId, label, `${label} #${sourceId}`, userId, comment || '', companyId]
        );
      }

      logAudit({
        userId, module: 'approvals', recordId: sourceId,
        recordType: prefix, action: 'reject',
        oldData: { status: 'Pending' }, newData: { status: 'Rejected', comment }, req,
      });
      notifyWorkflowEvent('rejected', { module: prefix, recordId: sourceId, submitterUserId: userId, comments: comment });
      return res.json({ id, status: 'Rejected', decision_date: new Date() });
    }

    const cidFilter = companyId != null ? `AND company_id = $4` : '';
    const result = await pool.query(
      `UPDATE approvals
       SET status = 'Rejected', decision_date = NOW(), approver_id = $1, comments = $2
       WHERE id = $3 AND status = 'Pending' ${cidFilter}
       RETURNING *`,
      companyId != null ? [userId, comment, id, companyId] : [userId, comment, id]
    );
    const approval = result.rows[0];
    if (!approval) return res.status(409).json({ error: 'Approval not found or already processed' });

    // Also reject the linked source-table record so it no longer shows as pending
    if (approval.reference_id && approval.module_name) {
      await rejectSourceItem(approval.module_name, String(approval.reference_id), userId, comment || '');
    }

    logAudit({
      userId, module: 'approvals', recordId: id,
      recordType: approval.module_name || 'approval', action: 'reject',
      oldData: { status: 'Pending' }, newData: { status: 'Rejected', comment, decision_date: approval.decision_date }, req,
    });
    notifyWorkflowEvent('rejected', {
      module: approval.module_name || 'Approval',
      recordId: approval.reference_id || approval.id,
      submitterUserId: approval.requested_by,
      comments: comment,
    });
    res.json(approval);
  } catch (err) {
    console.error("Reject request error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const bulkApprove = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });

    const userId    = uid(req);
    const companyId = cid(req);
    const cidFilter = companyId != null ? `AND company_id = $3` : '';

    const sourceIds  = ids.filter(i => String(i).includes(':'));
    const centralIds = ids.filter(i => !String(i).includes(':'));
    const results    = [];

    // Process source items
    for (const id of sourceIds) {
      const [prefix, sourceId] = String(id).split(':');
      await approveSourceItem(prefix, sourceId, userId, role(req));
      const refId = /^\d+$/.test(sourceId) ? parseInt(sourceId, 10) : null;
      await safeQuery(
        `UPDATE approvals SET status = 'Approved', decision_date = NOW(), approver_id = $1
         WHERE module_name = $2 AND reference_id = $3 AND status = 'Pending'`,
        [userId, prefix, refId]
      );
      logAudit({ userId, module: 'approvals', recordId: sourceId, recordType: prefix, action: 'approve', oldData: { status: 'Pending' }, newData: { status: 'Approved', bulk: true }, req });
      results.push({ id, status: 'Approved' });
    }

    // Process central items
    if (centralIds.length > 0) {
      // Ownership filter, matching the single-item path in approvals.authz.js.
      // Without it, holding any approver role let you bulk-approve items assigned
      // to a DIFFERENT approver — e.g. a sales_manager clearing a purchase request
      // routed to finance. The route-level guard only checks that you may approve
      // *something*; this restricts it to items that are actually yours.
      // Rows that fail the filter are simply not updated and are reported as skipped.
      const ownFilter = canOverride(req) ? '' : `AND (approver_id = $1 OR approver_id IS NULL)`;
      const r = await pool.query(
        `UPDATE approvals SET status = 'Approved', decision_date = NOW(), approver_id = $1
         WHERE id = ANY($2::int[]) AND status = 'Pending' ${cidFilter} ${ownFilter} RETURNING *`,
        companyId != null ? [userId, centralIds.map(Number), companyId] : [userId, centralIds.map(Number)]
      );
      for (const approval of r.rows) {
        if (approval.reference_id && approval.module_name) {
          await approveSourceItem(approval.module_name, String(approval.reference_id), userId, role(req));
        }
        logAudit({ userId, module: 'approvals', recordId: approval.id, recordType: approval.module_name || 'approval', action: 'approve', oldData: { status: 'Pending' }, newData: { status: 'Approved', bulk: true }, req });
        notifyWorkflowEvent('approved', { module: approval.module_name || 'Approval', recordId: approval.reference_id || approval.id, submitterUserId: approval.requested_by });
        results.push(approval);
      }
    }

    // Surface anything the ownership filter withheld, so the caller sees a
    // partial success rather than silently believing all ids were approved.
    const done    = new Set(results.map(r => String(r.id ?? r)));
    const skipped = ids.filter(i => !done.has(String(i)));
    res.json({
      count: results.length,
      approvals: results,
      ...(skipped.length ? {
        skipped,
        message: 'Some items were not approved: already processed, or assigned to a different approver.',
      } : {}),
    });
  } catch (err) {
    console.error("Bulk approve error:", err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
};

export const bulkReject = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { ids, comment } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });

    const userId    = uid(req);
    const companyId = cid(req);
    const cidFilter = companyId != null ? `AND company_id = $4` : '';

    const sourceIds  = ids.filter(i => String(i).includes(':'));
    const centralIds = ids.filter(i => !String(i).includes(':'));
    const results    = [];

    for (const id of sourceIds) {
      const [prefix, sourceId] = String(id).split(':');
      await rejectSourceItem(prefix, sourceId, userId, comment || '');
      const refId = /^\d+$/.test(sourceId) ? parseInt(sourceId, 10) : null;
      await safeQuery(
        `UPDATE approvals SET status = 'Rejected', decision_date = NOW(), approver_id = $1, comments = $2
         WHERE module_name = $3 AND reference_id = $4 AND status = 'Pending'`,
        [userId, comment || '', prefix, refId]
      );
      logAudit({ userId, module: 'approvals', recordId: sourceId, recordType: prefix, action: 'reject', oldData: { status: 'Pending' }, newData: { status: 'Rejected', comment, bulk: true }, req });
      results.push({ id, status: 'Rejected' });
    }

    if (centralIds.length > 0) {
      // Ownership filter — see the matching comment in bulkApprove.
      const ownFilter = canOverride(req) ? '' : `AND (approver_id = $1 OR approver_id IS NULL)`;
      const r = await pool.query(
        `UPDATE approvals SET status = 'Rejected', decision_date = NOW(), approver_id = $1, comments = $2
         WHERE id = ANY($3::int[]) AND status = 'Pending' ${cidFilter} ${ownFilter} RETURNING *`,
        companyId != null ? [userId, comment || '', centralIds.map(Number), companyId] : [userId, comment || '', centralIds.map(Number)]
      );
      for (const approval of r.rows) {
        if (approval.reference_id && approval.module_name) {
          await rejectSourceItem(approval.module_name, String(approval.reference_id), userId, comment || '');
        }
        logAudit({ userId, module: 'approvals', recordId: approval.id, recordType: approval.module_name || 'approval', action: 'reject', oldData: { status: 'Pending' }, newData: { status: 'Rejected', comment: comment || '', bulk: true }, req });
        notifyWorkflowEvent('rejected', { module: approval.module_name || 'Approval', recordId: approval.reference_id || approval.id, submitterUserId: approval.requested_by, comments: comment });
        results.push(approval);
      }
    }

    res.json({ count: results.length, approvals: results });
  } catch (err) {
    console.error("Bulk reject error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const escalateRequest = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { id } = req.params;
    const { approver_user_id } = req.body;
    const userId    = uid(req);
    const companyId = cid(req);
    const isSource  = String(id).includes(':');

    if (isSource) {
      logAudit({ userId, module: 'approvals', recordId: id, recordType: 'escalation', action: 'escalate', oldData: { status: 'Pending' }, newData: { status: 'Escalated', escalated_to: approver_user_id ?? null }, req });
      return res.json({ id, status: 'Escalated' });
    }

    const cidFilter = companyId != null ? `AND company_id = $2` : '';
    const result = await pool.query(
      `UPDATE approvals SET status = 'Escalated', decision_date = NOW()
       WHERE id = $1 AND status = 'Pending' ${cidFilter} RETURNING *`,
      companyId != null ? [id, companyId] : [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Approval not found or not in Pending status' });

    const approval = result.rows[0];
    logAudit({ userId, module: 'approvals', recordId: id, recordType: approval.module_name || 'approval', action: 'escalate', oldData: { status: 'Pending' }, newData: { status: 'Escalated', escalated_to: approver_user_id ?? null }, req });
    if (approver_user_id) notifyWorkflowEvent('escalated', { module: approval.module_name || 'Approval', recordId: approval.reference_id || approval.id, approverUserId: approver_user_id });
    res.json(approval);
  } catch (err) {
    console.error("Escalate error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getDelegateUsers = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const companyId = cid(req);
    const q = (req.query.q || '').trim();
    const params = [];
    let cFilter = '';
    if (companyId != null) { params.push(companyId); cFilter = `AND e.company_id = $${params.length}`; }
    if (q) { params.push(`%${q}%`); cFilter += ` AND (e.first_name ILIKE $${params.length} OR e.last_name ILIKE $${params.length} OR e.company_email ILIKE $${params.length})`; }
    params.push(50); // limit
    const rows = await safeQuery(
      `SELECT e.id, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name,
              e.company_email AS email, e.designation, e.department
       FROM employees e
       WHERE e.id IS NOT NULL
         AND LOWER(e.status) IN ('active', 'probation', 'notice')
         ${cFilter}
       ORDER BY e.first_name
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error("Get delegate users error:", err);
    res.status(500).json({ error: err.message });
  }
};

async function delegateSourceItem(prefix, sourceId, newApproverId) {
  switch (prefix) {
    case 'reg':
      await safeQuery(
        `UPDATE attendance_regularization_requests SET manager_id = $2 WHERE id = $1`,
        [sourceId, newApproverId]
      );
      break;
    case 'ot':
      await safeQuery(
        `UPDATE attendance_ot_records SET approved_by = $2 WHERE id = $1`,
        [sourceId, newApproverId]
      );
      break;
    default:
      break;
  }
}

export const delegateApprovals = async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { ids, delegate_to_user_id } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    if (!delegate_to_user_id)
      return res.status(400).json({ error: 'delegate_to_user_id is required' });

    const userId    = uid(req);
    const companyId = cid(req);
    const cidFilter = companyId != null ? `AND company_id = $3` : '';

    const sourceIds  = ids.filter(i => String(i).includes(':'));
    const centralIds = ids.filter(i => !String(i).includes(':'));
    const results    = [];

    // For source table items: re-assign at source table level is complex;
    // we log the delegation intent and note it in the audit trail
    for (const id of sourceIds) {
      const [prefix, sourceId] = String(id).split(':');
      await delegateSourceItem(prefix, sourceId, delegate_to_user_id);
      logAudit({ userId, module: 'approvals', recordId: sourceId, recordType: prefix, action: 'delegate', oldData: { approver_id: userId }, newData: { approver_id: delegate_to_user_id }, req });
      results.push({ id, delegated: true });
    }

    if (centralIds.length > 0) {
      const r = await pool.query(
        `UPDATE approvals
         SET approver_id = $1,
             comments = CONCAT(COALESCE(comments, ''), ' [Delegated from user ', approver_id::text, ']')
         WHERE id = ANY($2::int[]) AND status = 'Pending' ${cidFilter}
         RETURNING *`,
        companyId != null ? [delegate_to_user_id, centralIds.map(Number), companyId] : [delegate_to_user_id, centralIds.map(Number)]
      );
      for (const approval of r.rows) {
        logAudit({ userId, module: 'approvals', recordId: approval.id, recordType: approval.module_name || 'approval', action: 'delegate', oldData: { approver_id: userId }, newData: { approver_id: delegate_to_user_id }, req });
        results.push(approval);
      }
    }

    res.json({ count: results.length, delegate_to_user_id, approvals: results });
  } catch (err) {
    console.error("Delegate error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getApprovalChain = async (req, res) => {
  try {
    const { id } = req.params;
    // Source items don't have chain entries yet; return empty gracefully
    if (String(id).includes(':')) return res.json([]);

    const result = await pool.query(
      `SELECT approver_name, approver, status, decision_date, comment
       FROM approval_chain WHERE approval_id = $1 ORDER BY step_order ASC`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    if (!err.message?.includes('does not exist')) {
      console.error('[approvals] getApprovalChain error:', err.message);
    }
    res.json([]);
  }
};
