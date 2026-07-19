import express from 'express';
import pool from '../shared/db.js';
import { allowRoles } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import { notifyWorkflowEvent } from '../../services/WorkflowNotificationService.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();

// ── Employee self-scoping ─────────────────────────────────────────────────────
// Employees may only see their own travel data. Ownership is matched on both
// employee_id (employees.id, from the JWT / users.employee_id) and created_by
// (users.id) because legacy rows store either one.
const isEmployeeRole = (req) => String(req.user?.role || '').toLowerCase() === 'employee';

async function ownEmployeeId(req) {
  if (req.user?.employee_id != null) return req.user.employee_id;
  const userId = req.user?.userId ?? req.user?.id;
  if (!userId) return null;
  try {
    const { rows } = await pool.query('SELECT employee_id FROM users WHERE id = $1', [userId]);
    return rows[0]?.employee_id ?? null;
  } catch { return null; }
}

// ── Startup schema bootstrap ─────────────────────────────────────────────────
;(async () => {
  try {
    await pool.query(`
      ALTER TABLE travel_requests
        ADD COLUMN IF NOT EXISTS employee_name    VARCHAR(150),
        ADD COLUMN IF NOT EXISTS department       VARCHAR(100),
        ADD COLUMN IF NOT EXISTS mode             VARCHAR(50),
        ADD COLUMN IF NOT EXISTS hotel_required   BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS advance_required BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS notes            TEXT,
        ADD COLUMN IF NOT EXISTS company_id       INTEGER,
        ADD COLUMN IF NOT EXISTS customer_name    VARCHAR(200),
        ADD COLUMN IF NOT EXISTS project_number   VARCHAR(100),
        ADD COLUMN IF NOT EXISTS request_number   VARCHAR(50)
    `);
  } catch (e) { console.warn('[travel] alter travel_requests:', e.message); }

  try {
    await pool.query(`
      UPDATE travel_requests
        SET request_number = 'TR-' || LPAD(id::text, 3, '0')
        WHERE request_number IS NULL
    `);
  } catch (e) { console.warn('[travel] backfill request_number:', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS travel_advances (
        id                  SERIAL PRIMARY KEY,
        employee_id         INTEGER,
        company_id          INTEGER,
        amount              NUMERIC(12,2) DEFAULT 0,
        purpose             TEXT,
        required_by         DATE,
        travel_request_id   INTEGER,
        settled_amount      NUMERIC(12,2),
        status              VARCHAR(50)  DEFAULT 'Pending',
        created_by          INTEGER,
        created_at          TIMESTAMPTZ  DEFAULT NOW(),
        updated_at          TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
  } catch (e) { console.warn('[travel] create travel_advances:', e.message); }

  try {
    await pool.query(`
      ALTER TABLE travel_advances
        ADD COLUMN IF NOT EXISTS company_id        INTEGER,
        ADD COLUMN IF NOT EXISTS required_by       DATE,
        ADD COLUMN IF NOT EXISTS travel_request_id INTEGER,
        ADD COLUMN IF NOT EXISTS settled_amount    NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS document_link     TEXT,
        ADD COLUMN IF NOT EXISTS finance_comments  TEXT,
        ADD COLUMN IF NOT EXISTS finance_by        INTEGER,
        ADD COLUMN IF NOT EXISTS finance_at        TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS manager_comments  TEXT,
        ADD COLUMN IF NOT EXISTS manager_by        INTEGER,
        ADD COLUMN IF NOT EXISTS manager_at        TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS resubmission_count INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS payment_ref       VARCHAR(100),
        ADD COLUMN IF NOT EXISTS payment_date      DATE,
        ADD COLUMN IF NOT EXISTS disbursed_by      INTEGER,
        ADD COLUMN IF NOT EXISTS disbursed_at      TIMESTAMPTZ
    `);
  } catch (e) { console.warn('[travel] alter travel_advances cols:', e.message); }

  try {
    // Legacy rows created before the Finance→Manager workflow enter at the finance step
    await pool.query(`UPDATE travel_advances SET status='Pending Finance' WHERE status='Pending'`);
  } catch (e) { console.warn('[travel] migrate advance statuses:', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS travel_bookings (
        id                SERIAL PRIMARY KEY,
        travel_request_id INTEGER,
        booking_type      VARCHAR(100),
        booking_ref       VARCHAR(100),
        details           TEXT,
        amount            NUMERIC(12,2) DEFAULT 0,
        status            VARCHAR(50)  DEFAULT 'Pending',
        created_by        INTEGER,
        created_at        TIMESTAMPTZ  DEFAULT NOW(),
        updated_at        TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
  } catch (e) { console.warn('[travel] create travel_bookings:', e.message); }

  try {
    await pool.query(`
      ALTER TABLE travel_bookings
        ADD COLUMN IF NOT EXISTS destination   VARCHAR(200),
        ADD COLUMN IF NOT EXISTS mode          VARCHAR(50),
        ADD COLUMN IF NOT EXISTS from_date     DATE,
        ADD COLUMN IF NOT EXISTS to_date       DATE,
        ADD COLUMN IF NOT EXISTS employee_name VARCHAR(150),
        ADD COLUMN IF NOT EXISTS airline_train VARCHAR(100),
        ADD COLUMN IF NOT EXISTS notes         TEXT,
        ADD COLUMN IF NOT EXISTS company_id    INTEGER
    `);
  } catch (e) { console.warn('[travel] alter travel_bookings columns:', e.message); }

  try {
    // Backfill pending_booking rows for already-Approved requests that have no booking yet
    await pool.query(`
      INSERT INTO travel_bookings
        (travel_request_id, destination, from_date, to_date, mode,
         employee_name, status, company_id, created_by)
      SELECT tr.id, tr.destination, tr.from_date, tr.to_date, tr.mode,
             tr.employee_name, 'pending_booking', tr.company_id, tr.created_by
      FROM travel_requests tr
      WHERE tr.status = 'Approved'
        AND tr.id NOT IN (
          SELECT travel_request_id FROM travel_bookings WHERE travel_request_id IS NOT NULL
        )
    `);
  } catch (e) { console.warn('[travel] backfill pending bookings:', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS travel_expense_items (
        id                    SERIAL PRIMARY KEY,
        company_id            INTEGER,
        category              VARCHAR(100),
        amount                NUMERIC(12,2) DEFAULT 0,
        gst_amount            NUMERIC(12,2) DEFAULT 0,
        total_amount          NUMERIC(12,2),
        expense_date          DATE,
        description           TEXT,
        receipt_ref           VARCHAR(200),
        google_drive_link     TEXT,
        bill_upload_path      TEXT,
        customer_id           INTEGER,
        customer_name         VARCHAR(200),
        project_id            INTEGER,
        project_number        VARCHAR(100),
        site_name             VARCHAR(200),
        opportunity_id        INTEGER,
        opportunity_ref       VARCHAR(100),
        po_number             VARCHAR(100),
        travel_request_id     INTEGER,
        status                VARCHAR(50)  DEFAULT 'Draft',
        reimbursement_status  VARCHAR(50)  DEFAULT 'Pending',
        created_by            INTEGER,
        created_at            TIMESTAMPTZ  DEFAULT NOW(),
        updated_at            TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
  } catch (e) { console.warn('[travel] create travel_expense_items:', e.message); }

  try {
    await pool.query(`
      ALTER TABLE travel_expense_items
        ADD COLUMN IF NOT EXISTS company_id           INTEGER,
        ADD COLUMN IF NOT EXISTS gst_amount           NUMERIC(12,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS total_amount         NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS google_drive_link    TEXT,
        ADD COLUMN IF NOT EXISTS bill_upload_path     TEXT,
        ADD COLUMN IF NOT EXISTS customer_id          INTEGER,
        ADD COLUMN IF NOT EXISTS customer_name        VARCHAR(200),
        ADD COLUMN IF NOT EXISTS project_id           INTEGER,
        ADD COLUMN IF NOT EXISTS project_number       VARCHAR(100),
        ADD COLUMN IF NOT EXISTS site_name            VARCHAR(200),
        ADD COLUMN IF NOT EXISTS opportunity_id       INTEGER,
        ADD COLUMN IF NOT EXISTS opportunity_ref      VARCHAR(100),
        ADD COLUMN IF NOT EXISTS po_number            VARCHAR(100),
        ADD COLUMN IF NOT EXISTS reimbursement_status VARCHAR(50) DEFAULT 'Pending'
    `);
  } catch (e) { console.warn('[travel] alter travel_expense_items cols:', e.message); }
})();

const TRAVEL_APPROVE_ROLES = ['admin', 'super_admin', 'hr', 'manager'];
const VALID_TRAVEL_STATUSES = new Set(['Pending', 'Approved', 'Rejected', 'Cancelled']);

router.get('/requests', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { status, limit = 200 } = req.query;
    const params = [];
    let idx = 1;
    let q = `SELECT tr.*,
              COALESCE(tr.employee_name, CONCAT(e.first_name,' ',e.last_name)) AS employee_name,
              COALESCE(tr.department, e.department) AS department,
              COALESCE(tr.mode, 'Not specified') AS mode
             FROM travel_requests tr
             LEFT JOIN employees e ON e.id = tr.employee_id
             WHERE 1=1`;
    if (companyId) { params.push(companyId); q += ` AND tr.company_id = $${idx++}`; }
    if (isEmployeeRole(req)) {
      const eid = await ownEmployeeId(req);
      const actorId = req.user?.userId ?? req.user?.id;
      params.push(eid ?? -1, actorId ?? -1);
      q += ` AND (tr.employee_id = $${idx++} OR tr.created_by = $${idx++})`;
    }
    if (status && status !== 'All') { params.push(status); q += ` AND tr.status = $${idx++}`; }
    q += ` ORDER BY tr.created_at DESC LIMIT ${parseInt(limit)}`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch { res.json([]); }
});

// ── Calendar view: date-range overlap filter with company scoping ─────────────
router.get('/calendar', async (req, res) => {
  try {
    const { month } = req.query; // expects "YYYY-MM"
    const companyId = companyOf(req);

    let startDate, endDate;
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      startDate = `${y}-${String(m).padStart(2,'0')}-01`;
      endDate   = new Date(y, m, 0).toISOString().slice(0, 10); // last day of month
    } else {
      const now = new Date();
      const y = now.getFullYear(), m = now.getMonth() + 1;
      startDate = `${y}-${String(m).padStart(2,'0')}-01`;
      endDate   = new Date(y, m, 0).toISOString().slice(0, 10);
    }

    const params = [startDate, endDate];
    let cFilter = companyId
      ? (params.push(companyId), `AND tr.company_id = $${params.length}`)
      : '';
    if (isEmployeeRole(req)) {
      const eid = await ownEmployeeId(req);
      params.push(eid ?? -1, req.user?.userId ?? req.user?.id ?? -1);
      cFilter += ` AND (tr.employee_id = $${params.length - 1} OR tr.created_by = $${params.length})`;
    }

    const { rows } = await pool.query(`
      SELECT
        tr.id,
        COALESCE(tr.request_number, 'TR-' || LPAD(tr.id::text, 3, '0')) AS request_number,
        COALESCE(
          NULLIF(TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')), ''),
          tr.employee_name
        ) AS employee_name,
        tr.destination,
        tr.purpose,
        TO_CHAR(tr.from_date, 'YYYY-MM-DD') AS from_date,
        TO_CHAR(COALESCE(tr.to_date, tr.from_date), 'YYYY-MM-DD') AS to_date,
        tr.status
      FROM travel_requests tr
      LEFT JOIN employees e ON e.id = tr.employee_id
      WHERE tr.from_date::date <= $2::date
        AND COALESCE(tr.to_date, tr.from_date)::date >= $1::date
        ${cFilter}
      ORDER BY tr.from_date ASC
    `, params);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recent travel requests (dashboard overview) ───────────────────────────────
router.get('/recent-requests', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const params = [];
    let cFilter = companyId ? (params.push(companyId), ` AND tr.company_id = $${params.length}`) : '';
    if (isEmployeeRole(req)) {
      const eid = await ownEmployeeId(req);
      params.push(eid ?? -1, req.user?.userId ?? req.user?.id ?? -1);
      cFilter += ` AND (tr.employee_id = $${params.length - 1} OR tr.created_by = $${params.length})`;
    }

    // DISTINCT ON tr.id prevents fan-out if any future multi-row JOIN is added.
    // LEFT JOIN employees so rows with NULL employee_id still appear.
    const { rows } = await pool.query(`
      SELECT * FROM (
        SELECT DISTINCT ON (tr.id)
          tr.id,
          COALESCE(tr.request_number, 'TR-' || LPAD(tr.id::text, 3, '0')) AS request_number,
          COALESCE(
            NULLIF(TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')), ''),
            tr.employee_name
          ) AS employee_name,
          tr.destination,
          tr.purpose,
          tr.from_date AS travel_date,
          tr.budget,
          tr.status
        FROM travel_requests tr
        LEFT JOIN employees e ON e.id = tr.employee_id
        WHERE 1=1 ${cFilter}
        ORDER BY tr.id, tr.created_at DESC
      ) sub
      ORDER BY id DESC
      LIMIT 10
    `, params);

    const { rows: [kpi] } = await pool.query(`
      SELECT
        COUNT(*)                                            AS total_requests,
        COALESCE(SUM(budget), 0)                           AS total_budget,
        COUNT(CASE WHEN status = 'Pending'  THEN 1 END)   AS pending_count,
        COUNT(CASE WHEN status = 'Approved' THEN 1 END)   AS approved_count
      FROM travel_requests tr
      WHERE 1=1 ${cFilter}
    `, params);

    res.json({
      requests:       rows,
      total_requests: parseInt(kpi.total_requests),
      total_budget:   parseFloat(kpi.total_budget),
      pending_count:  parseInt(kpi.pending_count),
      approved_count: parseInt(kpi.approved_count),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Approvals list ───────────────────────────────────────────────────────────
router.get('/approvals', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { status } = req.query;
    const filterStatus = status && status !== 'All' ? status : null;
    const params = filterStatus ? [filterStatus] : [];
    let cAnd = companyId ? ` AND tr.company_id = ${parseInt(companyId)}` : '';
    if (isEmployeeRole(req)) {
      const eid = parseInt(await ownEmployeeId(req), 10) || -1;
      const actorId = parseInt(req.user?.userId ?? req.user?.id, 10) || -1;
      cAnd += ` AND (tr.employee_id = ${eid} OR tr.created_by = ${actorId})`;
    }

    const { rows } = await pool.query(
      `SELECT
         tr.id,
         CONCAT('TR-', LPAD(tr.id::text, 3, '0'))          AS "requestNo",
         COALESCE(
           NULLIF(TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')), ''),
           tr.employee_name,
           'Unknown'
         )                                                  AS employee,
         COALESCE(tr.department, e.department)              AS department,
         tr.purpose,
         tr.destination                                     AS "toCity",
         ''                                                 AS "fromCity",
         TO_CHAR(tr.from_date, 'DD/MM/YYYY')               AS "travelDate",
         TO_CHAR(tr.to_date,   'DD/MM/YYYY')               AS "returnDate",
         tr.budget                                          AS "estimatedBudget",
         COALESCE(tr.mode, 'Not specified')                 AS mode,
         false                                              AS "advanceRequired",
         tr.status
       FROM travel_requests tr
       LEFT JOIN employees e ON e.id = tr.employee_id
       ${filterStatus ? `WHERE tr.status = $1` : `WHERE tr.status IN ('Pending','Approved','Rejected')`}
       ${cAnd}
       ORDER BY tr.created_at DESC LIMIT 100`,
      params
    );
    res.json(rows);
  } catch { res.json([]); }
});

// ── Approve / Reject ─────────────────────────────────────────────────────────
router.put('/requests/:id/status', allowRoles(...TRAVEL_APPROVE_ROLES), async (req, res) => {
  try {
    const { status } = req.body;
    if (!VALID_TRAVEL_STATUSES.has(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${[...VALID_TRAVEL_STATUSES].join(', ')}` });
    }
    const { rows: [old] } = await pool.query(`SELECT * FROM travel_requests WHERE id=$1`, [req.params.id]);
    if (!old) return res.status(404).json({ error: 'Request not found' });

    const { rows: [updated] } = await pool.query(
      `UPDATE travel_requests SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );

    const actorId = req.user?.userId ?? req.user?.id;
    logAudit({
      userId: actorId,
      module: 'travel',
      recordId: updated.id,
      recordType: 'travel_request',
      action: status === 'Approved' ? 'approve' : status === 'Rejected' ? 'reject' : 'update',
      oldData: old,
      newData: updated,
      req,
    });

    if (status === 'Approved' || status === 'Rejected') {
      notifyWorkflowEvent(status === 'Approved' ? 'approved' : 'rejected', {
        module: 'Travel',
        recordId: updated.id,
        submitterUserId: updated.employee_id,
      });
    }

    // Auto-create a pending_booking stub when a request is approved for the first time
    if (status === 'Approved' && old.status !== 'Approved') {
      const { rows: existing } = await pool.query(
        `SELECT id FROM travel_bookings WHERE travel_request_id=$1`, [updated.id]
      );
      if (existing.length === 0) {
        await pool.query(`
          INSERT INTO travel_bookings
            (travel_request_id, destination, from_date, to_date, mode,
             employee_name, status, company_id, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,'pending_booking',$7,$8)
        `, [updated.id, updated.destination, updated.from_date, updated.to_date,
            updated.mode, updated.employee_name, updated.company_id,
            req.user?.userId ?? req.user?.id]);
      }
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/requests', async (req, res) => {
  try {
    const {
      employee_id, destination, purpose, from_date, to_date, budget,
      mode, hotel_required, advance_required, notes,
    } = req.body;
    // Employees can only raise requests for themselves.
    const empId = isEmployeeRole(req) ? ((await ownEmployeeId(req)) ?? null) : employee_id;
    const { rows } = await pool.query(
      `INSERT INTO travel_requests
         (employee_id, destination, purpose, from_date, to_date, budget,
          mode, hotel_required, advance_required, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending',$11) RETURNING *`,
      [empId, destination, purpose, from_date, to_date, budget,
       mode, hotel_required ?? false, advance_required ?? false, notes,
       req.user?.userId ?? req.user?.id]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Dashboard summary ────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const companyId = companyOf(req);
    let scope = companyId ? `company_id = ${parseInt(companyId)}` : '1=1';
    if (isEmployeeRole(req)) {
      const eid = parseInt(await ownEmployeeId(req), 10) || -1;
      const actorId = parseInt(req.user?.userId ?? req.user?.id, 10) || -1;
      scope += ` AND (employee_id = ${eid} OR created_by = ${actorId})`;
    }
    const cWhere = `WHERE ${scope}`;
    const cAnd   = `AND ${scope}`;
    const [total, pending, expenses, advance] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM travel_requests ${cWhere}`),
      pool.query(`SELECT COUNT(*) FROM travel_requests WHERE status='Pending' ${cAnd}`),
      pool.query(`SELECT COALESCE(SUM(budget),0) AS total FROM travel_requests WHERE DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW()) ${cAnd}`),
      pool.query(`SELECT COALESCE(SUM(budget),0) AS total FROM travel_requests WHERE status='Approved' ${cAnd}`),
    ]);
    res.json({
      totalTrips:          parseInt(total.rows[0].count),
      pendingApprovals:    parseInt(pending.rows[0].count),
      expensesThisMonth:   parseFloat(expenses.rows[0].total),
      advanceBalance:      parseFloat(advance.rows[0].total),
    });
  } catch {
    res.json({ totalTrips: 0, pendingApprovals: 0, expensesThisMonth: 0, advanceBalance: 0 });
  }
});

// ── Analytics: monthly trend ─────────────────────────────────────────────────
router.get('/analytics/trend', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const params = companyId ? [parseInt(companyId)] : [];
    const companyJoinFilter = companyId ? `AND tr.company_id = $1` : '';
    const { rows } = await pool.query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', NOW() - INTERVAL '5 months'),
          date_trunc('month', NOW()),
          '1 month'::interval
        ) AS month_start
      )
      SELECT
        TO_CHAR(m.month_start, 'Mon') AS month,
        COALESCE(SUM(tr.budget), 0)   AS total_spend
      FROM months m
      LEFT JOIN travel_requests tr
        ON date_trunc('month', tr.created_at) = m.month_start
        ${companyJoinFilter}
      GROUP BY m.month_start
      ORDER BY m.month_start
    `, params);
    res.json(rows.map(r => ({ month: r.month, total_spend: parseFloat(r.total_spend) })));
  } catch {
    res.json([]);
  }
});

// ── Analytics: by category / purpose ────────────────────────────────────────
router.get('/analytics/category', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const cAnd = companyId ? `AND company_id = ${parseInt(companyId)}` : '';
    const { rows } = await pool.query(`
      SELECT purpose AS name, COALESCE(SUM(budget), 0) AS value
      FROM travel_requests
      WHERE purpose IS NOT NULL ${cAnd}
      GROUP BY purpose
      ORDER BY value DESC
      LIMIT 6
    `);
    const colors = ['#6366f1','#8b5cf6','#a78bfa','#c4b5fd','#e0e7ff','#f0f4ff'];
    res.json(rows.map((r, i) => ({ name: r.name, value: parseFloat(r.value), color: colors[i] || '#e0e7ff' })));
  } catch {
    res.json([]);
  }
});

// ── My travel entries ─────────────────────────────────────────────────────────
router.get('/my-entries', async (req, res) => {
  const { status, year } = req.query;
  try {
    const companyId = companyOf(req);
    const actorId = req.user?.userId ?? req.user?.id;
    if (!actorId) return res.status(401).json({ error: 'Unauthorized' });
    const eid = await ownEmployeeId(req);
    // Match on employees.id (correct linkage), created_by, and legacy rows
    // where employee_id was written with the users.id.
    const params = [eid ?? -1, actorId];
    let q = `SELECT id, from_date AS start, to_date AS end,
                    EXTRACT(DAY FROM to_date::date - from_date::date + 1)::int AS days,
                    status, purpose, budget AS total, employee_id,
                    created_at AS created_on, id AS rec_id
             FROM travel_requests
             WHERE (employee_id = $1 OR employee_id = $2 OR created_by = $2)`;
    if (companyId) { params.push(companyId); q += ` AND company_id = $${params.length}`; }
    if (status && status !== 'All') { params.push(status); q += ` AND status = $${params.length}`; }
    if (year) { params.push(year); q += ` AND EXTRACT(YEAR FROM from_date) = $${params.length}`; }
    q += ' ORDER BY created_at DESC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch(e) { res.json([]); }
});

// ── Travel review entries ─────────────────────────────────────────────────────
router.get('/review-entries', async (req, res) => {
  const { status } = req.query;
  try {
    const companyId = companyOf(req);
    let q = `SELECT tr.id, CONCAT(e.first_name,' ',e.last_name) AS name,
                    tr.from_date AS start, tr.to_date AS end,
                    tr.status, tr.purpose, tr.budget AS total,
                    tr.destination
             FROM travel_requests tr LEFT JOIN employees e ON e.id = tr.employee_id WHERE 1=1`;
    const params = [];
    if (companyId) { params.push(companyId); q += ` AND tr.company_id = $${params.length}`; }
    if (isEmployeeRole(req)) {
      const eid = await ownEmployeeId(req);
      params.push(eid ?? -1, req.user?.userId ?? req.user?.id ?? -1);
      q += ` AND (tr.employee_id = $${params.length - 1} OR tr.created_by = $${params.length})`;
    }
    if (status && status !== 'All') { params.push(status); q += ` AND tr.status = $${params.length}`; }
    q += ' ORDER BY tr.created_at DESC';
    const result = await pool.query(q, params);
    res.json(result.rows);
  } catch(e) { res.json([]); }
});

// ── Travel advances ───────────────────────────────────────────────────────────
// Workflow: Pending Finance → (finance approve) Pending Manager → (manager approve) Approved
//           → (finance disburse) Disbursed → (bill paid) Partially Settled / Settled
// Finance reject → Finance Rejected → employee resubmits (fix details / upload doc) → Pending Finance
const ADVANCE_FINANCE_ROLES = ['admin', 'super_admin', 'finance'];
const ADVANCE_MANAGER_ROLES = ['admin', 'super_admin', 'manager', 'hr'];

// Statuses an advance can hold, in workflow order — also drives the UI filter.
const ADVANCE_STATUSES = [
  'Pending Finance', 'Pending Manager', 'Approved', 'Finance Rejected',
  'Disbursed', 'Partially Settled', 'Settled',
];
router.get('/advances/statuses', (_req, res) => res.json(ADVANCE_STATUSES));

// Years that actually have advances, newest first — populates the year filter
// so it never offers a year with nothing behind it.
router.get('/advances/years', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const params = [];
    let q = `SELECT DISTINCT EXTRACT(YEAR FROM COALESCE(required_by, created_at::date))::int AS year
             FROM travel_advances WHERE 1=1`;
    if (companyId) { params.push(companyId); q += ` AND company_id = $${params.length}`; }
    q += ` ORDER BY year DESC`;
    const r = await pool.query(q, params);
    res.json(r.rows.map(x => x.year).filter(Boolean));
  } catch (e) { res.json([]); }
});

router.get('/advances', async (req, res) => {
  const { status, year } = req.query;
  try {
    const companyId = companyOf(req);
    const params = [];
    // ta.employee_id holds the users.id of the requester — resolve the employee
    // via users.employee_id, falling back to the login name, then to a direct
    // employees match for any row that stored an employees.id.
    let q = `SELECT ta.*,
                    COALESCE(
                      NULLIF(TRIM(CONCAT(eu.first_name,' ',eu.last_name)), ''),
                      u.name,
                      NULLIF(TRIM(CONCAT(ed.first_name,' ',ed.last_name)), '')
                    ) AS employee_name,
                    COALESCE(tr.request_number, CASE WHEN tr.id IS NOT NULL THEN 'TR-' || LPAD(tr.id::text,3,'0') END) AS request_number,
                    tr.destination, tr.from_date AS travel_from, tr.to_date AS travel_to,
                    tr.travel_type, tr.purpose AS trip_purpose,
                    CASE WHEN tr.from_date IS NOT NULL AND tr.to_date IS NOT NULL
                         THEN (tr.to_date::date - tr.from_date::date) + 1 END AS days,
                    -- Trip-level expense split. These are per travel request, so
                    -- two advances on the same trip legitimately show the same
                    -- Company/Personal/Total — it's the trip's spend, not the
                    -- advance's. Payable nets off every advance already paid out
                    -- on that trip, so it stays consistent across those rows.
                    exp.company_expense,
                    exp.personal_expense,
                    (exp.company_expense + exp.personal_expense) AS total_expense,
                    advp.advance_paid_trip,
                    (exp.company_expense - advp.advance_paid_trip) AS payable
             FROM travel_advances ta
             LEFT JOIN users u ON u.id = ta.employee_id
             LEFT JOIN employees eu ON eu.id = u.employee_id
             LEFT JOIN employees ed ON ed.id = ta.employee_id
             LEFT JOIN travel_requests tr ON tr.id = ta.travel_request_id
             LEFT JOIN LATERAL (
               SELECT COALESCE(SUM(ec.total_amount) FILTER (WHERE ec.borne_by = 'company'),  0) AS company_expense,
                      COALESCE(SUM(ec.total_amount) FILTER (WHERE ec.borne_by = 'personal'), 0) AS personal_expense
                 FROM expense_claims ec
                WHERE ec.travel_request_id = ta.travel_request_id
                  AND ec.deleted_at IS NULL
             ) exp ON TRUE
             LEFT JOIN LATERAL (
               SELECT COALESCE(SUM(a2.amount), 0) AS advance_paid_trip
                 FROM travel_advances a2
                WHERE a2.travel_request_id = ta.travel_request_id
                  AND a2.status IN ('Disbursed','Partially Settled','Settled')
             ) advp ON TRUE
             WHERE 1=1`;
    if (companyId) { params.push(companyId); q += ` AND ta.company_id = $${params.length}`; }
    if (isEmployeeRole(req)) {
      // ta.employee_id stores the users.id (see POST below); also match
      // employees.id for any legacy row and created_by as a fallback.
      const eid = await ownEmployeeId(req);
      params.push(req.user?.userId ?? req.user?.id ?? -1, eid ?? -1);
      q += ` AND (ta.employee_id = $${params.length - 1} OR ta.created_by = $${params.length - 1} OR ta.employee_id = $${params.length})`;
    }
    if (status && status !== 'All') { params.push(status); q += ` AND ta.status = $${params.length}`; }
    // required_by is the advance's own date; fall back to created_at for rows
    // that never set one, so a year filter can't silently drop them.
    if (year && year !== 'All') {
      params.push(parseInt(year, 10));
      q += ` AND EXTRACT(YEAR FROM COALESCE(ta.required_by, ta.created_at::date)) = $${params.length}`;
    }
    q += ` ORDER BY ta.created_at DESC`;
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});

router.post('/advances', async (req, res) => {
  try {
    const { amount, purpose, required_by, travel_request_id, document_link } = req.body;
    const actorId = req.user?.userId ?? req.user?.id;
    const companyId = companyOf(req);
    if (!amount || !purpose) return res.status(400).json({ error: 'amount and purpose are required' });
    if (!travel_request_id) return res.status(400).json({ error: 'An advance must be created against a travel request' });

    const { rows: [tr] } = await pool.query(
      `SELECT id, status, employee_id, created_by FROM travel_requests WHERE id=$1`, [travel_request_id]);
    if (!tr) return res.status(404).json({ error: 'Travel request not found' });
    if (tr.status === 'Rejected' || tr.status === 'Cancelled') {
      return res.status(400).json({ error: `Cannot request an advance against a ${tr.status.toLowerCase()} travel request` });
    }
    if (isEmployeeRole(req)) {
      const eid = await ownEmployeeId(req);
      const owns = [eid, actorId].some(v => v != null && (tr.employee_id === v || tr.created_by === v));
      if (!owns) return res.status(403).json({ error: 'You can only request an advance against your own travel request' });
    }

    const { rows } = await pool.query(
      `INSERT INTO travel_advances
         (employee_id, company_id, amount, purpose, required_by, travel_request_id, document_link, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Pending Finance',$8) RETURNING *`,
      [actorId, companyId, Number(amount), purpose, required_by || null, travel_request_id, document_link || null, actorId]
    );
    logAudit({ userId: actorId, module: 'travel', recordId: rows[0].id,
      recordType: 'travel_advance', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 1 — Finance review
router.put('/advances/:id/finance-review', allowRoles(...ADVANCE_FINANCE_ROLES), async (req, res) => {
  try {
    const { status, comments } = req.body; // 'Approved' | 'Rejected'
    const actorId = req.user?.userId ?? req.user?.id;
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be Approved or Rejected' });
    }
    if (status === 'Rejected' && !comments?.trim()) {
      return res.status(400).json({ error: 'Comments are required when rejecting an advance' });
    }
    const { rows: [adv] } = await pool.query(`SELECT * FROM travel_advances WHERE id=$1`, [req.params.id]);
    if (!adv) return res.status(404).json({ error: 'Advance not found' });
    if (adv.status !== 'Pending Finance') {
      return res.status(400).json({ error: `Advance is ${adv.status}, not awaiting finance review` });
    }

    const newStatus = status === 'Approved' ? 'Pending Manager' : 'Finance Rejected';
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET status=$1, finance_comments=$2, finance_by=$3, finance_at=NOW(), updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [newStatus, comments || null, actorId, req.params.id]
    );

    if (status === 'Rejected') {
      notifyWorkflowEvent('rejected', { module: 'TravelAdvance', recordId: updated.id, submitterUserId: adv.employee_id });
    }
    logAudit({ userId: actorId, module: 'travel', recordId: updated.id, recordType: 'travel_advance',
      action: `finance_${status.toLowerCase()}`, oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Employee resubmits after a finance rejection (fix details / attach the required document)
router.put('/advances/:id/resubmit', async (req, res) => {
  try {
    const { amount, purpose, required_by, document_link } = req.body;
    const actorId = req.user?.userId ?? req.user?.id;
    const { rows: [adv] } = await pool.query(`SELECT * FROM travel_advances WHERE id=$1`, [req.params.id]);
    if (!adv) return res.status(404).json({ error: 'Advance not found' });
    if (adv.status !== 'Finance Rejected') {
      return res.status(400).json({ error: 'Only finance-rejected advances can be resubmitted' });
    }
    if (adv.employee_id !== actorId && adv.created_by !== actorId) {
      return res.status(403).json({ error: 'Only the requester can resubmit this advance' });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET
         amount        = COALESCE($1, amount),
         purpose       = COALESCE($2, purpose),
         required_by   = COALESCE($3, required_by),
         document_link = COALESCE($4, document_link),
         status='Pending Finance', resubmission_count = COALESCE(resubmission_count,0)+1,
         finance_by=NULL, finance_at=NULL, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [amount ? Number(amount) : null, purpose || null, required_by || null,
       document_link || null, req.params.id]
    );
    logAudit({ userId: actorId, module: 'travel', recordId: updated.id, recordType: 'travel_advance',
      action: 'resubmit', oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 2 — Manager review (after finance approval)
router.put('/advances/:id/manager-review', allowRoles(...ADVANCE_MANAGER_ROLES), async (req, res) => {
  try {
    const { status, comments } = req.body; // 'Approved' | 'Rejected'
    const actorId = req.user?.userId ?? req.user?.id;
    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be Approved or Rejected' });
    }
    const { rows: [adv] } = await pool.query(`SELECT * FROM travel_advances WHERE id=$1`, [req.params.id]);
    if (!adv) return res.status(404).json({ error: 'Advance not found' });
    if (adv.status !== 'Pending Manager') {
      return res.status(400).json({ error: `Advance is ${adv.status}, not awaiting manager review` });
    }

    const newStatus = status === 'Approved' ? 'Approved' : 'Rejected';
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET status=$1, manager_comments=$2, manager_by=$3, manager_at=NOW(), updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [newStatus, comments || null, actorId, req.params.id]
    );

    notifyWorkflowEvent(status === 'Approved' ? 'approved' : 'rejected',
      { module: 'TravelAdvance', recordId: updated.id, submitterUserId: adv.employee_id });
    logAudit({ userId: actorId, module: 'travel', recordId: updated.id, recordType: 'travel_advance',
      action: `manager_${status.toLowerCase()}`, oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 3 — Finance disburses the approved advance
router.put('/advances/:id/disburse', allowRoles(...ADVANCE_FINANCE_ROLES), async (req, res) => {
  try {
    const { payment_ref, payment_date } = req.body;
    const actorId = req.user?.userId ?? req.user?.id;
    const { rows: [adv] } = await pool.query(`SELECT * FROM travel_advances WHERE id=$1`, [req.params.id]);
    if (!adv) return res.status(404).json({ error: 'Advance not found' });
    if (adv.status !== 'Approved') {
      return res.status(400).json({ error: `Advance is ${adv.status}, only Approved advances can be disbursed` });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE travel_advances SET status='Disbursed', payment_ref=$1, payment_date=$2,
         disbursed_by=$3, disbursed_at=NOW(), updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [payment_ref || null, payment_date || null, actorId, req.params.id]
    );
    logAudit({ userId: actorId, module: 'travel', recordId: updated.id, recordType: 'travel_advance',
      action: 'disburse', oldData: adv, newData: updated, req });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Travel bookings ───────────────────────────────────────────────────────────
router.get('/bookings', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const params = [];
    let cFilter = companyId
      ? (params.push(companyId), `AND COALESCE(tb.company_id, tr.company_id) = $${params.length}`)
      : '';
    if (isEmployeeRole(req)) {
      const eid = await ownEmployeeId(req);
      params.push(eid ?? -1, req.user?.userId ?? req.user?.id ?? -1);
      cFilter += ` AND (tr.employee_id = $${params.length - 1} OR tr.created_by = $${params.length} OR tb.created_by = $${params.length})`;
    }
    const { rows } = await pool.query(`
      SELECT
        tb.id,
        tb.travel_request_id,
        COALESCE(tr.request_number, CASE WHEN tr.id IS NOT NULL THEN 'TR-' || LPAD(tr.id::text,3,'0') END) AS request_number,
        COALESCE(tb.destination,    tr.destination)   AS destination,
        COALESCE(tb.mode,           tr.mode)          AS mode,
        COALESCE(tb.from_date,      tr.from_date)     AS from_date,
        COALESCE(tb.to_date,        tr.to_date)       AS to_date,
        COALESCE(
          tb.employee_name,
          NULLIF(TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')), ''),
          tr.employee_name
        )                                             AS employee_name,
        tb.booking_ref,
        tb.airline_train,
        tb.amount,
        tb.notes,
        tb.status,
        tb.created_at
      FROM travel_bookings tb
      LEFT JOIN travel_requests tr ON tr.id = tb.travel_request_id
      LEFT JOIN employees e ON e.id = tr.employee_id
      WHERE 1=1 ${cFilter}
      ORDER BY tb.created_at DESC
    `, params);
    res.json(rows);
  } catch(e) { res.json([]); }
});

router.post('/bookings', async (req, res) => {
  try {
    const {
      travel_request_id, destination, from_date, to_date,
      mode, airline_train, booking_ref, cost, notes,
    } = req.body;
    if (!destination && !travel_request_id) {
      return res.status(400).json({ error: 'destination or travel_request_id is required' });
    }
    const companyId = companyOf(req);
    const actorId   = req.user?.userId ?? req.user?.id;

    const { rows } = await pool.query(`
      INSERT INTO travel_bookings
        (travel_request_id, destination, from_date, to_date, mode, airline_train,
         booking_ref, amount, notes, status, company_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Confirmed',$10,$11)
      RETURNING *
    `, [travel_request_id || null, destination || null, from_date || null, to_date || null,
        mode || null, airline_train || null, booking_ref || null,
        Number(cost) || 0, notes || null, companyId, actorId]);

    // Update travel_request.mode when booking is linked and mode is provided
    if (travel_request_id && mode) {
      await pool.query(
        `UPDATE travel_requests SET mode=$1, updated_at=NOW() WHERE id=$2`,
        [mode, travel_request_id]
      );
    }
    // Remove the auto-seeded pending_booking stub for this request (we have a real booking now)
    if (travel_request_id) {
      await pool.query(
        `DELETE FROM travel_bookings WHERE travel_request_id=$1 AND status='pending_booking' AND id!=$2`,
        [travel_request_id, rows[0].id]
      );
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Expenses ──────────────────────────────────────────────────────────────────
router.get('/expenses', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const params = [];
    let q = `SELECT * FROM travel_expense_items WHERE 1=1`;
    if (companyId) { params.push(companyId); q += ` AND company_id = $${params.length}`; }
    if (isEmployeeRole(req)) {
      params.push(req.user?.userId ?? req.user?.id ?? -1);
      q += ` AND created_by = $${params.length}`;
    }
    q += ` ORDER BY created_at DESC LIMIT 200`;
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch(e) { res.json([]); }
});
router.post('/expenses', async (req, res) => {
  try {
    const { category, amount, expense_date, description, receipt_ref, travel_request_id } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO travel_expense_items (category, amount, expense_date, description, receipt_ref, travel_request_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'Draft',$7) RETURNING *`,
      [category, amount, expense_date, description, receipt_ref, travel_request_id,
       req.user?.userId ?? req.user?.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics/stats', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const cAnd = companyId ? `AND company_id = ${parseInt(companyId)}` : '';
    const { rows } = await pool.query(`
      SELECT
        COUNT(CASE WHEN DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW()) THEN 1 END)::int AS trips_this_month,
        COALESCE(SUM(CASE WHEN DATE_TRUNC('month', created_at) = DATE_TRUNC('month', NOW()) THEN budget ELSE 0 END), 0) AS spend_this_month,
        CASE WHEN COUNT(*) > 0 THEN ROUND(COALESCE(SUM(budget), 0) / COUNT(*)) ELSE 0 END AS avg_cost_per_trip,
        COUNT(DISTINCT employee_id)::int AS active_travelers
      FROM travel_requests WHERE status != 'Rejected' ${cAnd}
    `);
    res.json(rows[0]);
  } catch(e) { res.json({ trips_this_month:0, spend_this_month:0, avg_cost_per_trip:0, active_travelers:0 }); }
});

router.get('/analytics/department', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const cAnd = companyId ? `AND tr.company_id = ${parseInt(companyId)}` : '';
    const r = await pool.query(`
      SELECT e.department,
             COUNT(*) AS trip_count,
             COALESCE(SUM(tr.budget), 0) AS total_spend
      FROM travel_requests tr
      JOIN employees e ON e.id = tr.employee_id
      WHERE 1=1 ${cAnd}
      GROUP BY e.department
      ORDER BY total_spend DESC
    `);
    res.json(r.rows.map(row => ({ ...row, total_spend: parseFloat(row.total_spend) })));
  } catch(e) { res.json([]); }
});

router.get('/analytics/travelers', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const cAnd = companyId ? `AND tr.company_id = ${parseInt(companyId)}` : '';
    const r = await pool.query(`
      SELECT CONCAT(e.first_name,' ',e.last_name) AS employee_name,
             e.department,
             COUNT(*) AS trip_count,
             COALESCE(SUM(tr.budget), 0) AS total_spend,
             CASE WHEN COUNT(*) > 0 THEN ROUND(COALESCE(SUM(tr.budget),0) / COUNT(*)) ELSE 0 END AS avg_spend
      FROM travel_requests tr
      JOIN employees e ON e.id = tr.employee_id
      WHERE 1=1 ${cAnd}
      GROUP BY employee_name, e.department
      ORDER BY trip_count DESC LIMIT 10
    `);
    res.json(r.rows.map(row => ({ ...row, total_spend: parseFloat(row.total_spend), avg_spend: parseFloat(row.avg_spend) })));
  } catch(e) { res.json([]); }
});

// ── Travel cost by project ────────────────────────────────────────────────────
router.get('/analytics/by-project', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT project_number, customer_name,
             COUNT(*) AS trip_count,
             COALESCE(SUM(budget),0) AS total_spend
      FROM travel_requests
      WHERE project_number IS NOT NULL
      GROUP BY project_number, customer_name
      ORDER BY total_spend DESC LIMIT 20
    `);
    res.json(rows.map(r => ({ ...r, total_spend: parseFloat(r.total_spend) })));
  } catch { res.json([]); }
});

// ── Travel cost by employee (for CEO dashboard) ───────────────────────────────
router.get('/analytics/by-employee', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT CONCAT(e.first_name,' ',e.last_name) AS employee_name,
             e.designation,
             e.department,
             COUNT(tr.id) AS trip_count,
             COALESCE(SUM(tr.budget),0) AS total_spend
      FROM travel_requests tr
      JOIN employees e ON e.id = tr.employee_id
      WHERE tr.status != 'Rejected'
      GROUP BY employee_name, e.designation, e.department
      ORDER BY total_spend DESC LIMIT 15
    `);
    res.json(rows.map(r => ({ ...r, total_spend: parseFloat(r.total_spend) })));
  } catch { res.json([]); }
});

// ── POST travel request (enhanced with commercial fields) ─────────────────────
router.post('/requests/v2', async (req, res) => {
  try {
    const {
      employee_id, employee_name, department,
      customer_id, customer_name,
      project_id, project_number, site_name,
      opportunity_id, opportunity_ref, po_number,
      destination, purpose, from_date, to_date, budget,
      mode, hotel_required, advance_required, notes,
    } = req.body;
    const actorId = req.user?.userId ?? req.user?.id;
    // Employees can only raise requests for themselves.
    const empId = isEmployeeRole(req) ? ((await ownEmployeeId(req)) ?? null) : employee_id;
    const { rows } = await pool.query(
      `INSERT INTO travel_requests
         (employee_id, employee_name, department,
          customer_id, customer_name,
          project_id, project_number, site_name,
          opportunity_id, opportunity_ref, po_number,
          destination, purpose, from_date, to_date, budget,
          mode, hotel_required, advance_required, notes,
          status, approval_level, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'Pending',0,$21)
       RETURNING *`,
      [empId, employee_name, department,
       customer_id, customer_name,
       project_id, project_number, site_name,
       opportunity_id, opportunity_ref, po_number,
       destination, purpose, from_date, to_date, budget,
       mode, hotel_required ?? false, advance_required ?? false, notes,
       actorId]
    );
    const req_ = rows[0];
    // Seed level 1 approval row
    await pool.query(
      `INSERT INTO travel_request_approvals (travel_request_id, level, level_name, status)
       VALUES ($1,1,'Reporting Manager','Pending')`,
      [req_.id]
    );
    logAudit({ userId: actorId, module: 'travel', recordId: req_.id, recordType: 'travel_request', action: 'create', newData: req_ });
    res.status(201).json(req_);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Multi-level approval ──────────────────────────────────────────────────────
const LEVEL_NAMES = ['', 'Reporting Manager', 'Department Head', 'Management'];
router.put('/requests/:id/level-approve', allowRoles('admin','super_admin','hr','manager'), async (req, res) => {
  try {
    const { status, remarks } = req.body; // 'Approved' | 'Rejected'
    const actorId = req.user?.userId ?? req.user?.id;
    const { rows: [tr] } = await pool.query(`SELECT * FROM travel_requests WHERE id=$1`, [req.params.id]);
    if (!tr) return res.status(404).json({ error: 'Not found' });

    const nextLevel = (tr.approval_level || 0) + 1;
    if (status === 'Rejected') {
      await pool.query(`UPDATE travel_requests SET status='Rejected', updated_at=NOW() WHERE id=$1`, [req.params.id]);
      await pool.query(
        `UPDATE travel_request_approvals SET status='Rejected', approver_id=$1, remarks=$2, actioned_at=NOW()
         WHERE travel_request_id=$3 AND level=$4`,
        [actorId, remarks, req.params.id, nextLevel]
      );
      notifyWorkflowEvent('rejected', { module: 'Travel', recordId: tr.id, submitterUserId: tr.employee_id });
      return res.json({ message: 'Request rejected' });
    }

    // Approved at this level
    await pool.query(
      `UPDATE travel_request_approvals SET status='Approved', approver_id=$1, remarks=$2, actioned_at=NOW()
       WHERE travel_request_id=$3 AND level=$4`,
      [actorId, remarks, req.params.id, nextLevel]
    );

    const colMap = { 1: 'approved_by_rm', 2: 'approved_by_dh', 3: 'approved_by_mgmt' };
    const col = colMap[nextLevel];
    if (nextLevel < 3) {
      await pool.query(`UPDATE travel_requests SET approval_level=$1, ${col}=$2, updated_at=NOW() WHERE id=$3`,
        [nextLevel, actorId, req.params.id]);
      // Seed next level
      await pool.query(
        `INSERT INTO travel_request_approvals (travel_request_id, level, level_name, status)
         VALUES ($1,$2,$3,'Pending') ON CONFLICT DO NOTHING`,
        [req.params.id, nextLevel + 1, LEVEL_NAMES[nextLevel + 1]]
      );
    } else {
      // Final approval
      await pool.query(
        `UPDATE travel_requests SET approval_level=3, ${col}=$1, status='Approved', updated_at=NOW() WHERE id=$2`,
        [actorId, req.params.id]
      );
      notifyWorkflowEvent('approved', { module: 'Travel', recordId: tr.id, submitterUserId: tr.employee_id });
    }

    logAudit({ userId: actorId, module: 'travel', recordId: tr.id, recordType: 'travel_request',
      action: 'level_approve', newData: { level: nextLevel, status, remarks } });
    res.json({ message: `Level ${nextLevel} approved`, next_level: nextLevel < 3 ? nextLevel + 1 : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Finance: mark posted + payment ───────────────────────────────────────────
router.put('/requests/:id/finance-post', allowRoles('admin','super_admin','finance'), async (req, res) => {
  try {
    const { payment_ref, payment_date } = req.body;
    await pool.query(
      `UPDATE travel_requests SET finance_posted=true, payment_ref=$1, payment_date=$2, updated_at=NOW() WHERE id=$3`,
      [payment_ref, payment_date, req.params.id]
    );
    res.json({ message: 'Finance posted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Closure check (can Project/PO/Opportunity be closed?) ────────────────────
router.get('/closure-check', async (req, res) => {
  try {
    const { project_id, po_number, opportunity_id } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (project_id) { conditions.push(`project_id=$${idx++}`); params.push(project_id); }
    if (po_number) { conditions.push(`po_number=$${idx++}`); params.push(po_number); }
    if (opportunity_id) { conditions.push(`opportunity_id=$${idx++}`); params.push(opportunity_id); }

    if (!conditions.length) return res.json({ canClose: true, blocking: [] });

    const where = conditions.join(' OR ');
    const [travelPending, expensePending] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM travel_requests WHERE (${where}) AND status IN ('Pending','Approved')`, params),
      pool.query(`SELECT COUNT(*) FROM travel_expense_items WHERE (${where}) AND reimbursement_status IN ('Pending','Draft')`, params),
    ]);
    const blocking = [];
    if (parseInt(travelPending.rows[0].count) > 0) blocking.push({ type: 'travel_requests', count: parseInt(travelPending.rows[0].count) });
    if (parseInt(expensePending.rows[0].count) > 0) blocking.push({ type: 'expense_claims', count: parseInt(expensePending.rows[0].count) });
    res.json({ canClose: blocking.length === 0, blocking });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST expense (enhanced with GST, GDrive, commercial fields) ──────────────
router.post('/expenses/v2', async (req, res) => {
  try {
    const {
      category, amount, gst_amount, total_amount,
      expense_date, description, receipt_ref,
      google_drive_link, bill_upload_path,
      customer_id, customer_name, project_id, project_number,
      site_name, opportunity_id, po_number, travel_request_id,
    } = req.body;
    const actorId = req.user?.userId ?? req.user?.id;
    const { rows } = await pool.query(
      `INSERT INTO travel_expense_items
         (category, amount, gst_amount, total_amount, expense_date, description, receipt_ref,
          google_drive_link, bill_upload_path,
          customer_id, customer_name, project_id, project_number,
          site_name, opportunity_id, po_number, travel_request_id,
          status, reimbursement_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'Draft','Pending',$18)
       RETURNING *`,
      [category, amount, gst_amount||0, total_amount||amount,
       expense_date, description, receipt_ref,
       google_drive_link, bill_upload_path,
       customer_id, customer_name, project_id, project_number,
       site_name, opportunity_id, po_number, travel_request_id,
       actorId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Approve expense reimbursement ─────────────────────────────────────────────
router.put('/expenses/:id/reimburse', allowRoles('admin','super_admin','hr','finance','manager'), async (req, res) => {
  try {
    const { reimbursement_status } = req.body;
    const { rows: [updated] } = await pool.query(
      `UPDATE travel_expense_items SET reimbursement_status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [reimbursement_status, req.params.id]
    );
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Approval levels for a request ────────────────────────────────────────────
router.get('/requests/:id/approvals', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tra.*, CONCAT(e.first_name,' ',e.last_name) AS approver_name
       FROM travel_request_approvals tra
       LEFT JOIN employees e ON e.id = tra.approver_id
       WHERE tra.travel_request_id=$1 ORDER BY level`,
      [req.params.id]
    );
    res.json(rows);
  } catch { res.json([]); }
});

// ── Travel types list (Part 1 — 13 types) ────────────────────────────────────
router.get('/travel-types', (req, res) => {
  res.json([
    'Sales Visit',
    'Customer Meeting',
    'Tender Discussion',
    'Site Survey',
    'Application Engineering',
    'Design Discussion',
    'FAT Support',
    'Installation',
    'Commissioning',
    'Service Visit',
    'AMC Visit',
    'Training',
    'Internal Meeting',
  ]);
});

// ── CEO Command Center: travel cost analytics ─────────────────────────────────
router.get('/analytics/ceo-summary', async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? companyOf(req);
    const params = [companyId];
    const cFilter = `AND ($1::int IS NULL OR tr.company_id = $1)`;
    const [byEmployee, byDept, byProject, byCustomer, trend] = await Promise.all([
      pool.query(`
        SELECT CONCAT(e.first_name,' ',e.last_name) AS name,
               e.designation, e.department,
               COUNT(tr.id) AS trips,
               COALESCE(SUM(tr.budget),0) AS total_spend
        FROM travel_requests tr
        JOIN employees e ON e.id=tr.employee_id
        WHERE tr.status != 'Rejected' ${cFilter}
        GROUP BY e.first_name, e.last_name, e.designation, e.department
        ORDER BY total_spend DESC LIMIT 10
      `, params),
      pool.query(`
        SELECT COALESCE(tr.department, e.department, 'Unknown') AS department,
               COUNT(*) AS trips,
               COALESCE(SUM(tr.budget),0) AS total_spend
        FROM travel_requests tr
        LEFT JOIN employees e ON e.id=tr.employee_id
        WHERE tr.status != 'Rejected' ${cFilter}
        GROUP BY COALESCE(tr.department, e.department, 'Unknown') ORDER BY total_spend DESC LIMIT 8
      `, params),
      pool.query(`
        SELECT COALESCE(tr.project_number,'Unlinked') AS project_number,
               COALESCE(tr.customer_name,'Unlinked') AS customer_name,
               COUNT(*) AS trips,
               COALESCE(SUM(tr.budget),0) AS total_spend
        FROM travel_requests tr
        WHERE tr.status != 'Rejected' ${cFilter}
        GROUP BY tr.project_number, tr.customer_name
        ORDER BY total_spend DESC LIMIT 10
      `, params),
      pool.query(`
        SELECT COALESCE(tr.customer_name,'Unlinked') AS customer_name,
               COUNT(*) AS trips,
               COALESCE(SUM(tr.budget),0) AS total_spend
        FROM travel_requests tr
        WHERE tr.status != 'Rejected' ${cFilter}
        GROUP BY tr.customer_name ORDER BY total_spend DESC LIMIT 10
      `, params),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month',created_at),'Mon YYYY') AS month,
               DATE_TRUNC('month',created_at) AS month_date,
               COALESCE(SUM(budget),0) AS spend,
               COUNT(*) AS trips
        FROM travel_requests
        WHERE created_at>=NOW()-INTERVAL '12 months' AND status!='Rejected'
          AND ($1::int IS NULL OR company_id = $1)
        GROUP BY month_date ORDER BY month_date
      `, params),
    ]);
    res.json({
      by_employee: byEmployee.rows.map(r => ({ ...r, total_spend: parseFloat(r.total_spend) })),
      by_department: byDept.rows.map(r => ({ ...r, total_spend: parseFloat(r.total_spend) })),
      by_project: byProject.rows.map(r => ({ ...r, total_spend: parseFloat(r.total_spend) })),
      by_customer: byCustomer.rows.map(r => ({ ...r, total_spend: parseFloat(r.total_spend) })),
      trend: trend.rows.map(r => ({ ...r, spend: parseFloat(r.spend) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Customer 360: travel & visit history ──────────────────────────────────────
router.get('/customer-360/:customerId', async (req, res) => {
  try {
    const cId = req.params.customerId;
    const companyId = companyOf(req);
    const cFilter = companyId ? ` AND company_id=${companyId}` : '';

    const [visits, expenses, travelReqs] = await Promise.all([
      pool.query(`
        SELECT id, visit_type, visit_date, purpose, status,
               discussion_summary, next_followup, visited_by,
               CONCAT(e.first_name,' ',e.last_name) AS visited_by_name
        FROM customer_visits cv
        LEFT JOIN employees e ON e.id=cv.visited_by
        WHERE cv.customer_id=$1 ${cFilter}
        ORDER BY visit_date DESC LIMIT 20
      `, [cId]),
      pool.query(`
        SELECT COALESCE(SUM(total_amount),0) AS total_travel_cost,
               COUNT(*) AS expense_count
        FROM travel_cost_transactions
        WHERE customer_id=$1 ${cFilter}
      `, [cId]),
      pool.query(`
        SELECT id, travel_type, destination, from_date, to_date, budget, status,
               CONCAT(e.first_name,' ',e.last_name) AS employee_name
        FROM travel_requests tr
        LEFT JOIN employees e ON e.id=tr.employee_id
        WHERE tr.customer_id=$1 ${cFilter}
        ORDER BY from_date DESC LIMIT 20
      `, [cId]),
    ]);
    res.json({
      visits: visits.rows,
      total_travel_cost: parseFloat(expenses.rows[0]?.total_travel_cost || 0),
      expense_count: parseInt(expenses.rows[0]?.expense_count || 0),
      travel_requests: travelReqs.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Project 360: travel cost & history ────────────────────────────────────────
router.get('/project-360/:projectId', async (req, res) => {
  try {
    const pId = req.params.projectId;
    const companyId = companyOf(req);
    const cFilter = companyId ? ` AND company_id=${companyId}` : '';

    const [costSummary, travelReqs, visitReports, costByType] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(amount),0) AS base_amount,
               COALESCE(SUM(gst_amount),0) AS gst_amount,
               COALESCE(SUM(amount+gst_amount),0) AS total_cost,
               COUNT(*) AS transaction_count
        FROM travel_cost_transactions
        WHERE project_id=$1 ${cFilter}
      `, [pId]),
      pool.query(`
        SELECT tr.id, tr.travel_type, tr.destination, tr.from_date, tr.to_date,
               tr.budget, tr.status, tr.site_name,
               CONCAT(e.first_name,' ',e.last_name) AS employee_name
        FROM travel_requests tr
        LEFT JOIN employees e ON e.id=tr.employee_id
        WHERE tr.project_id=$1 ${cFilter}
        ORDER BY tr.from_date DESC LIMIT 30
      `, [pId]),
      pool.query(`
        SELECT id, report_number, visit_type, visit_date, visited_by,
               purpose, status, customer_name, site_name,
               CONCAT(e.first_name,' ',e.last_name) AS visited_by_name
        FROM visit_reports vr
        LEFT JOIN employees e ON e.id=vr.visited_by
        WHERE vr.project_id=$1 ${cFilter}
        ORDER BY visit_date DESC LIMIT 20
      `, [pId]),
      pool.query(`
        SELECT cost_type, COUNT(*) AS count,
               COALESCE(SUM(amount),0) AS amount
        FROM travel_cost_transactions
        WHERE project_id=$1 ${cFilter}
        GROUP BY cost_type ORDER BY amount DESC
      `, [pId]),
    ]);

    res.json({
      cost_summary: {
        base_amount:       parseFloat(costSummary.rows[0]?.base_amount || 0),
        gst_amount:        parseFloat(costSummary.rows[0]?.gst_amount || 0),
        total_cost:        parseFloat(costSummary.rows[0]?.total_cost || 0),
        transaction_count: parseInt(costSummary.rows[0]?.transaction_count || 0),
      },
      travel_requests:  travelReqs.rows,
      visit_reports:    visitReports.rows,
      cost_by_type:     costByType.rows.map(r => ({ ...r, amount: parseFloat(r.amount) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Reports: travel by type ───────────────────────────────────────────────────
router.get('/reports/by-travel-type', async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { from_date, to_date } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (companyId) { conditions.push(`tr.company_id=$${idx++}`); params.push(companyId); }
    if (from_date) { conditions.push(`tr.from_date>=$${idx++}`); params.push(from_date); }
    if (to_date) { conditions.push(`tr.to_date<=$${idx++}`); params.push(to_date); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT COALESCE(tr.travel_type, tr.purpose, 'Unspecified') AS travel_type,
             COUNT(*) AS trip_count,
             COALESCE(SUM(tr.budget),0) AS total_budget
      FROM travel_requests tr
      ${where}
      GROUP BY travel_type ORDER BY total_budget DESC
    `, params);
    res.json(rows.map(r => ({ ...r, total_budget: parseFloat(r.total_budget) })));
  } catch { res.json([]); }
});

export default router;
