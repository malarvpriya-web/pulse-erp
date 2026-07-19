import { Router } from 'express';
import { verifyToken, requirePermission } from '../../middlewares/auth.middleware.js';
import pool from '../shared/db.js';

const router = Router();

// Bootstrap extra columns and tables if they don't exist yet
pool.query(`
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS version VARCHAR(20) DEFAULT 'v1.0';
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS effective_date DATE;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS review_date DATE;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS drive_url TEXT;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS requires_acknowledgement BOOLEAN DEFAULT false;
  ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS applicable_to VARCHAR(50) DEFAULT 'all';
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS company_id INTEGER;
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0;
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS visible_to VARCHAR(50) NOT NULL DEFAULT 'all';
  ALTER TABLE hr_downloads ADD COLUMN IF NOT EXISTS file_type VARCHAR(20);
  CREATE TABLE IF NOT EXISTS hr_policy_acknowledgements (
    id SERIAL PRIMARY KEY,
    policy_id INTEGER NOT NULL REFERENCES hr_policies(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL,
    acknowledged_at TIMESTAMPTZ DEFAULT NOW(),
    ip_address INET,
    UNIQUE(policy_id, employee_id)
  );
  ALTER TABLE hr_policy_acknowledgements ADD COLUMN IF NOT EXISTS ip_address INET;
  ALTER TABLE employees ADD COLUMN IF NOT EXISTS default_shift_id INTEGER REFERENCES hr_shifts(id) ON DELETE SET NULL;
`).catch(e => console.error('[hr] schema bootstrap failed:', e.message));

// Bootstrap shift date-overrides table
pool.query(`
  CREATE TABLE IF NOT EXISTS hr_shift_date_overrides (
    id            SERIAL PRIMARY KEY,
    employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    shift_id      INTEGER NOT NULL REFERENCES hr_shifts(id) ON DELETE CASCADE,
    override_date DATE NOT NULL,
    reason        TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    company_id    INTEGER,
    created_by    INTEGER,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (employee_id, override_date)
  );
  CREATE INDEX IF NOT EXISTS idx_hr_shift_date_overrides_emp_date
    ON hr_shift_date_overrides(employee_id, override_date);
`).catch(e => console.error('[hr] shift-overrides bootstrap failed:', e.message));

// â”€â”€ DOWNLOADS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function visibleToClause(role) {
  const r = String(role || '').toLowerCase();
  if (['admin', 'super_admin', 'hr_admin', 'hr'].includes(r)) return `'all','hr_only','managers'`;
  if (['manager', 'team_lead'].includes(r)) return `'all','managers'`;
  return `'all'`;
}

router.get('/downloads', requirePermission('hr', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { search = '', category = '' } = req.query;
    const allowed = visibleToClause(req.user?.role);
    const r = await pool.query(
      `SELECT * FROM hr_downloads
        WHERE ($1::int IS NULL OR company_id = $1)
          AND COALESCE(visible_to,'all') IN (${allowed})
          AND ($2 = '' OR LOWER(category) = LOWER($2))
          AND ($3 = '' OR LOWER(title) ILIKE '%' || LOWER($3) || '%'
                       OR LOWER(description) ILIKE '%' || LOWER($3) || '%')
        ORDER BY created_at DESC`,
      [cid, category, search]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/downloads', requirePermission('hr', 'add'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { title, category, description, file_url, file_type, visible_to } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
    if (!file_url?.trim()) return res.status(400).json({ error: 'file_url is required' });
    const r = await pool.query(
      `INSERT INTO hr_downloads (company_id, title, category, description, file_url, file_type, visible_to, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cid, title.trim(), category || 'General', description || '', file_url.trim(),
       file_type || null, visible_to || 'all', req.user?.userId || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/downloads/:id', requirePermission('hr', 'edit'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const { title, category, description, file_url, file_type, visible_to } = req.body;
    const r = await pool.query(
      `UPDATE hr_downloads SET
         title       = COALESCE($1, title),
         category    = COALESCE($2, category),
         description = COALESCE($3, description),
         file_url    = COALESCE($4, file_url),
         file_type   = COALESCE($5, file_type),
         visible_to  = COALESCE($6, visible_to)
       WHERE id = $7 AND ($8::int IS NULL OR company_id = $8)
       RETURNING *`,
      [title?.trim() || null, category || null, description?.trim() || null,
       file_url?.trim() || null, file_type || null, visible_to || null, id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Document not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/downloads/:id/increment', requirePermission('hr', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    await pool.query(
      `UPDATE hr_downloads SET download_count = COALESCE(download_count,0) + 1
        WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`,
      [id, cid]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/downloads/:id', requirePermission('hr', 'delete'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
    const r = await pool.query(
      `DELETE FROM hr_downloads WHERE id=$1 AND ($2::int IS NULL OR company_id = $2) RETURNING id`,
      [id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'File not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POLICIES ──────────────────────────────────────────────────────────────────

// Must be registered before /:id routes to avoid conflict
// No requirePermission — any authenticated employee reads/acknowledges policies
router.get('/policies/my-acknowledgements', async (req, res) => {
  const employeeId = req.user?.userId;
  if (!employeeId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const r = await pool.query(
      `SELECT policy_id FROM hr_policy_acknowledgements WHERE employee_id = $1`,
      [employeeId]
    );
    res.json(r.rows.map(row => row.policy_id));
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.get('/policies/acknowledgement-counts', requirePermission('hr', 'view'), async (req, res) => {
  const cid = req.scope?.company_id ?? null;
  try {
    const [acksResult, totalResult] = await Promise.all([
      pool.query(
        `SELECT pa.policy_id, COUNT(*) AS ack_count
         FROM hr_policy_acknowledgements pa
         JOIN hr_policies p ON p.id = pa.policy_id
         WHERE ($1::int IS NULL OR p.company_id = $1 OR p.company_id IS NULL)
         GROUP BY pa.policy_id`,
        [cid]
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM employees
         WHERE LOWER(status) = 'active' AND ($1::int IS NULL OR company_id = $1)`,
        [cid]
      ),
    ]);
    const total = parseInt(totalResult.rows[0]?.total || 0, 10);
    const counts = {};
    acksResult.rows.forEach(row => {
      counts[row.policy_id] = { acknowledged: parseInt(row.ack_count, 10), total };
    });
    res.json({ counts, total_employees: total });
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json({ counts: {}, total_employees: 0 });
    res.status(500).json({ error: e.message });
  }
});

// All authenticated employees can read company policies
router.get('/policies', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const r = await pool.query(
      `SELECT * FROM hr_policies
       WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
       ORDER BY created_at DESC`,
      [cid]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/policies', requirePermission('hr', 'add'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { title, name, category, description, file_url, drive_url,
            version, effective_date, review_date, requires_acknowledgement } = req.body;
    const policyTitle = title || name;
    if (!policyTitle) return res.status(400).json({ error: 'title is required' });
    // If the submitted URL is a Drive link, store it in drive_url too
    const resolvedDriveUrl = drive_url || (file_url?.includes('drive.google.com') ? file_url : null);
    const r = await pool.query(
      `INSERT INTO hr_policies
         (company_id, title, category, description, file_url, drive_url, version,
          effective_date, review_date, requires_acknowledgement, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [cid, policyTitle, category || 'General', description || '',
       file_url || null, resolvedDriveUrl || null,
       version || 'v1.0', effective_date || null, review_date || null,
       !!requires_acknowledgement, req.user?.userId || null]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/policies/:id', requirePermission('hr', 'edit'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid policy id' });
  try {
    const cid = req.scope?.company_id ?? null;
    const { title, name, category, description, file_url, drive_url,
            version, effective_date, review_date, requires_acknowledgement } = req.body;
    const policyTitle = title || name;
    const resolvedDriveUrl = drive_url || (file_url?.includes('drive.google.com') ? file_url : null);
    const r = await pool.query(
      `UPDATE hr_policies SET
         title=COALESCE($1,title), category=COALESCE($2,category),
         description=COALESCE($3,description), file_url=COALESCE($4,file_url),
         drive_url=COALESCE($5,drive_url), version=COALESCE($6,version),
         effective_date=COALESCE($7,effective_date), review_date=COALESCE($8,review_date),
         requires_acknowledgement=COALESCE($9,requires_acknowledgement), updated_at=NOW()
       WHERE id=$10 AND ($11::int IS NULL OR company_id = $11 OR company_id IS NULL)
       RETURNING *`,
      [policyTitle || null, category || null, description || null, file_url || null,
       resolvedDriveUrl || null, version || null, effective_date || null, review_date || null,
       requires_acknowledgement !== undefined ? !!requires_acknowledgement : null, id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Policy not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/policies/:id', requirePermission('hr', 'delete'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid policy id' });
    await pool.query(
      `DELETE FROM hr_policies WHERE id=$1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)`,
      [id, cid]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Any authenticated employee can acknowledge a policy
router.post('/policies/:id/acknowledge', async (req, res) => {
  const policyId = Number(req.params.id);
  if (!Number.isInteger(policyId) || policyId < 1) return res.status(400).json({ error: 'Invalid policy id' });
  const employeeId = req.body?.employee_id || req.user?.userId;
  if (!employeeId) return res.status(400).json({ error: 'employee_id is required' });
  try {
    // DO NOTHING — acknowledgements are immutable; first timestamp is the legal record
    const r = await pool.query(
      `INSERT INTO hr_policy_acknowledgements (policy_id, employee_id, ip_address)
       VALUES ($1,$2,$3)
       ON CONFLICT (policy_id, employee_id) DO NOTHING
       RETURNING *`,
      [policyId, employeeId, req.ip || null]
    );
    res.json(r.rows[0] || { policy_id: policyId, employee_id: employeeId, already_acknowledged: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/policies/:id/acknowledgements', requirePermission('hr', 'view'), async (req, res) => {
  const policyId = Number(req.params.id);
  if (!Number.isInteger(policyId) || policyId < 1) return res.status(400).json({ error: 'Invalid policy id' });
  try {
    const r = await pool.query(
      `SELECT a.*, TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name
       FROM hr_policy_acknowledgements a
       LEFT JOIN employees e ON e.id = a.employee_id
       WHERE a.policy_id=$1 ORDER BY a.acknowledged_at DESC`,
      [policyId]
    );
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/policies/:id/send-reminder', requirePermission('hr', 'edit'), async (req, res) => {
  const policyId = Number(req.params.id);
  if (!Number.isInteger(policyId) || policyId < 1) return res.status(400).json({ error: 'Invalid policy id' });
  try {
    const r = await pool.query(
      `SELECT COUNT(*) AS pending_count
       FROM employees
       WHERE LOWER(status) = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM hr_policy_acknowledgements
           WHERE policy_id = $1 AND employee_id = employees.id
         )`,
      [policyId]
    );
    const pendingCount = parseInt(r.rows[0]?.pending_count || 0, 10);
    // Stub: wire to email/notification service in Phase 50
    res.json({ success: true, pending_count: pendingCount,
      message: `Reminder queued for ${pendingCount} employee(s) who have not yet acknowledged.` });
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json({ success: true, pending_count: 0, message: 'No pending acknowledgements.' });
    res.status(500).json({ error: e.message });
  }
});


// â”€â”€ helper: normalise a db row to the shape the frontend expects â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function normaliseShift(row) {
  let weeklyOff = row.weekly_off;
  if (typeof weeklyOff === 'string') {
    try { weeklyOff = JSON.parse(weeklyOff); } catch { weeklyOff = []; }
  }
  let roleGrace = row.role_grace_minutes;
  if (typeof roleGrace === 'string') {
    try { roleGrace = JSON.parse(roleGrace); } catch { roleGrace = {}; }
  }
  const resolvedOff = Array.isArray(weeklyOff) ? weeklyOff : ['Sat', 'Sun'];
  return {
    ...row,
    start:                row.start_time,
    end:                  row.end_time,
    weekly_off:           resolvedOff,
    weekly_off_days:      resolvedOff,
    departments:          Array.isArray(row.departments) ? row.departments : (row.departments ?? []),
    night_shift_allowance: !!row.is_night_shift,
    role_grace_minutes:   roleGrace || {},
    half_day_hours:       row.half_day_hours ?? 4,
    break_duration:       row.break_duration ?? 30,
    employees_count:      row.employees_count ?? 0,
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateShiftBody({ name, start, end, grace_minutes }) {
  if (!name?.trim())           return 'name is required';
  if (!start || !TIME_RE.test(start)) return 'start must be a valid HH:MM time';
  if (!end   || !TIME_RE.test(end))   return 'end must be a valid HH:MM time';
  const grace = Number(grace_minutes);
  if (!Number.isInteger(grace) || grace < 0 || grace > 120)
    return 'grace_minutes must be an integer between 0 and 120';
  return null;
}

function isValidDateString(v) {
  return !v || (typeof v === 'string' && DATE_RE.test(v));
}

// â”€â”€ SHIFTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/shifts', verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const r = await pool.query(`
      SELECT s.id, s.name,
             s.start_time, s.end_time,
             s.grace_minutes, s.color, s.departments, s.weekly_off,
             s.break_duration, s.is_night_shift, s.ot_eligible, s.capacity,
             s.half_day_hours, s.role_grace_minutes,
             COUNT(DISTINCT sa.employee_id) FILTER (WHERE sa.is_active = TRUE) AS employees_count
        FROM hr_shifts s
        LEFT JOIN hr_shift_assignments sa ON sa.shift_id = s.id
       WHERE (s.deleted_at IS NULL OR s.deleted_at > NOW())
         AND ($1::int IS NULL OR s.company_id = $1 OR s.company_id IS NULL)
       GROUP BY s.id
       ORDER BY s.name ASC
    `, [cid]);
    res.json(r.rows.map(normaliseShift));
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/shifts', verifyToken, requirePermission('hr', 'add'), async (req, res) => {
  const {
    name, start, end, grace_minutes = 15, color = '#6366f1', departments = [],
    weekly_off_days, weekly_off,
    night_shift_allowance, is_night_shift,
    break_duration = 30, half_day_hours = 4,
    role_grace_minutes = {}, ot_eligible = true, capacity = 0,
  } = req.body;
  const err = validateShiftBody({ name, start, end, grace_minutes });
  if (err) return res.status(400).json({ error: err });
  if (!Array.isArray(departments))
    return res.status(400).json({ error: 'departments must be an array' });
  const cid = req.scope?.company_id ?? null;
  const resolvedOff    = weekly_off_days || weekly_off || ['Sat', 'Sun'];
  const resolvedNight  = night_shift_allowance ?? is_night_shift ?? false;
  try {
    const r = await pool.query(
      `INSERT INTO hr_shifts
         (name, start_time, end_time, grace_minutes, color, departments,
          weekly_off, is_night_shift, break_duration, half_day_hours,
          role_grace_minutes, ot_eligible, capacity, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [name.trim(), start, end, Number(grace_minutes), color, JSON.stringify(departments),
       JSON.stringify(Array.isArray(resolvedOff) ? resolvedOff : ['Sat', 'Sun']),
       !!resolvedNight, Number(break_duration) || 30, Number(half_day_hours) || 4,
       JSON.stringify(role_grace_minutes || {}), !!ot_eligible, Number(capacity) || 0, cid]
    );
    res.status(201).json(normaliseShift(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/shifts/:id', verifyToken, requirePermission('hr', 'edit'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ error: 'Invalid shift id' });
  const {
    name, start, end, grace_minutes = 15, color = '#6366f1', departments = [],
    weekly_off_days, weekly_off,
    night_shift_allowance, is_night_shift,
    break_duration = 30, half_day_hours = 4,
    role_grace_minutes = {}, ot_eligible = true, capacity = 0,
  } = req.body;
  const err = validateShiftBody({ name, start, end, grace_minutes });
  if (err) return res.status(400).json({ error: err });
  if (!Array.isArray(departments))
    return res.status(400).json({ error: 'departments must be an array' });
  const cid = req.scope?.company_id ?? null;
  const resolvedOff   = weekly_off_days || weekly_off || ['Sat', 'Sun'];
  const resolvedNight = night_shift_allowance ?? is_night_shift ?? false;
  try {
    const r = await pool.query(
      `UPDATE hr_shifts
          SET name=$1, start_time=$2, end_time=$3,
              grace_minutes=$4, color=$5, departments=$6,
              weekly_off=$7, is_night_shift=$8, break_duration=$9,
              half_day_hours=$10, role_grace_minutes=$11,
              ot_eligible=$12, capacity=$13
        WHERE id=$14
          AND ($15::int IS NULL OR company_id = $15 OR company_id IS NULL)
        RETURNING *`,
      [name.trim(), start, end, Number(grace_minutes), color,
       JSON.stringify(departments),
       JSON.stringify(Array.isArray(resolvedOff) ? resolvedOff : ['Sat', 'Sun']),
       !!resolvedNight, Number(break_duration) || 30, Number(half_day_hours) || 4,
       JSON.stringify(role_grace_minutes || {}), !!ot_eligible, Number(capacity) || 0, id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shift not found' });
    res.json(normaliseShift(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shifts/:id', verifyToken, requirePermission('hr', 'delete'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1)
    return res.status(400).json({ error: 'Invalid shift id' });
  const cid = req.scope?.company_id ?? null;
  try {
    // Guard: refuse if employees are still actively assigned to this shift
    const assigned = await pool.query(
      'SELECT COUNT(*) AS cnt FROM hr_shift_assignments WHERE shift_id=$1 AND is_active=TRUE',
      [id]
    );
    if (parseInt(assigned.rows[0]?.cnt || 0) > 0)
      return res.status(400).json({ error: 'Cannot delete shift while employees are assigned. Remove all assignments first.' });
    // Soft-delete so audit history is preserved
    const r = await pool.query(
      `UPDATE hr_shifts SET deleted_at=NOW()
        WHERE id=$1 AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
       RETURNING id`,
      [id, cid]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shift not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// â”€â”€ OFFBOARDING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns employees in a resignation/notice/termination state, joined with
// any open exit_requests row so we have a reliable last_working_date and reason
// even when the employees.exit_date column has not been populated.
router.get('/offboarding', verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  try {
    const companyId = req.scope?.company_id ?? null;
    const params = companyId != null ? [companyId] : [];
    const cidClause = companyId != null ? `AND e.company_id = $1` : '';
    const r = await pool.query(`
      SELECT
        e.id,
        COALESCE(e.office_id::text, e.id::text)                             AS employee_id,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS name,
        TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name,
        e.department,
        e.designation,
        e.status,
        COALESCE(er.last_working_date, e.exit_date)                         AS exit_date,
        COALESCE(er.last_working_date, e.exit_date)                         AS last_day,
        COALESCE(er.reason, e.exit_reason)                                  AS exit_reason,
        COALESCE(
          (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE p.done = TRUE) / NULLIF(COUNT(*), 0))
           FROM hr_offboarding_checklist_progress p WHERE p.employee_id = e.id),
          0
        )::int                                                               AS checklist_pct
      FROM employees e
      LEFT JOIN LATERAL (
        SELECT * FROM exit_requests
        WHERE employee_id = e.id AND status NOT IN ('rejected','cancelled')
        ORDER BY created_at DESC LIMIT 1
      ) er ON true
      WHERE LOWER(e.status) IN ('resigned', 'terminated', 'notice_period', 'notice period')
        ${cidClause}
      ORDER BY COALESCE(er.last_working_date, e.exit_date) DESC NULLS LAST
      LIMIT 100
    `, params);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.get('/shift-assignments', verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const r = await pool.query(`
      SELECT a.*
      FROM hr_shift_assignments a
      JOIN employees e ON e.id = a.employee_id
      WHERE a.is_active = TRUE
        AND ($1::int IS NULL OR e.company_id = $1)
      ORDER BY a.created_at DESC
    `, [cid]);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/shift-assignments', verifyToken, requirePermission('hr', 'add'), async (req, res) => {
  const { employee_id, shift_id, effective_from = null, note = '' } = req.body || {};
  const employeeId = Number(employee_id);
  const shiftId = Number(shift_id);
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'employee_id must be a valid integer' });
  if (!Number.isInteger(shiftId) || shiftId < 1) return res.status(400).json({ error: 'shift_id must be a valid integer' });
  if (!isValidDateString(effective_from)) return res.status(400).json({ error: 'effective_from must be YYYY-MM-DD' });
  try {
    const r = await pool.query(
      `INSERT INTO hr_shift_assignments (employee_id, shift_id, effective_from, note, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [employeeId, shiftId, effective_from, String(note || ''), req.user?.userId || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shift-assignments/:id', verifyToken, requirePermission('hr', 'delete'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid assignment id' });
  try {
    const r = await pool.query(
      `UPDATE hr_shift_assignments
          SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1
      RETURNING id`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shift assignment not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/shift-rotations', verifyToken, requirePermission('hr', 'view'), async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT r.*
      FROM hr_shift_rotations r
      WHERE r.is_active = TRUE
      ORDER BY r.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/shift-rotations', verifyToken, requirePermission('hr', 'add'), async (req, res) => {
  const { team, week_1_shift_id, week_2_shift_id, effective_from = null } = req.body || {};
  const week1 = Number(week_1_shift_id);
  const week2 = Number(week_2_shift_id);
  if (!team?.trim()) return res.status(400).json({ error: 'team is required' });
  if (!Number.isInteger(week1) || week1 < 1) return res.status(400).json({ error: 'week_1_shift_id must be a valid integer' });
  if (!Number.isInteger(week2) || week2 < 1) return res.status(400).json({ error: 'week_2_shift_id must be a valid integer' });
  if (week1 === week2) return res.status(400).json({ error: 'week_1_shift_id and week_2_shift_id must be different' });
  if (!isValidDateString(effective_from)) return res.status(400).json({ error: 'effective_from must be YYYY-MM-DD' });
  try {
    const r = await pool.query(
      `INSERT INTO hr_shift_rotations (team, week_1_shift_id, week_2_shift_id, effective_from, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [team.trim(), week1, week2, effective_from, req.user?.userId || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shift-rotations/:id', verifyToken, requirePermission('hr', 'delete'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid rotation id' });
  try {
    const r = await pool.query(
      `UPDATE hr_shift_rotations
          SET is_active = FALSE, updated_at = NOW()
        WHERE id = $1
      RETURNING id`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Shift rotation not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── SHIFT DATE OVERRIDES ──────────────────────────────────────────────────────
router.get('/shift-overrides', verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;
    const { employee_id, from_date, to_date } = req.query;
    let q = `
      SELECT o.*, s.name AS shift_name, s.start_time, s.end_time, s.color,
             TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) AS employee_name
        FROM hr_shift_date_overrides o
        JOIN hr_shifts s ON s.id = o.shift_id
        JOIN employees e ON e.id = o.employee_id
       WHERE o.is_active = TRUE
         AND ($1::int IS NULL OR o.company_id = $1 OR o.company_id IS NULL)
    `;
    const params = [cid];
    let n = 2;
    if (employee_id) { q += ` AND o.employee_id = $${n++}`; params.push(employee_id); }
    if (from_date)   { q += ` AND o.override_date >= $${n++}`; params.push(from_date); }
    if (to_date)     { q += ` AND o.override_date <= $${n++}`; params.push(to_date); }
    q += ' ORDER BY o.override_date DESC LIMIT 200';
    const r = await pool.query(q, params);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.post('/shift-overrides', verifyToken, requirePermission('hr', 'add'), async (req, res) => {
  const { employee_id, shift_id, override_date, reason = '' } = req.body || {};
  const empId   = Number(employee_id);
  const shiftId = Number(shift_id);
  if (!Number.isInteger(empId)   || empId < 1)   return res.status(400).json({ error: 'employee_id must be a valid integer' });
  if (!Number.isInteger(shiftId) || shiftId < 1)  return res.status(400).json({ error: 'shift_id must be a valid integer' });
  if (!override_date || !/^\d{4}-\d{2}-\d{2}$/.test(override_date))
    return res.status(400).json({ error: 'override_date must be YYYY-MM-DD' });
  const cid = req.scope?.company_id ?? null;
  try {
    const r = await pool.query(
      `INSERT INTO hr_shift_date_overrides
         (employee_id, shift_id, override_date, reason, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (employee_id, override_date)
       DO UPDATE SET shift_id=$2, reason=$4, is_active=TRUE, created_by=$6
       RETURNING *`,
      [empId, shiftId, override_date, String(reason || ''), cid, req.user?.userId || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shift-overrides/:id', verifyToken, requirePermission('hr', 'delete'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid override id' });
  try {
    const r = await pool.query(
      `UPDATE hr_shift_date_overrides SET is_active=FALSE WHERE id=$1 RETURNING id`, [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Override not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── OFFBOARDING ───────────────────────────────────────────────────────────────
router.get('/offboarding/templates', verifyToken, requirePermission('hr', 'view'), async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT category, item_label, default_assignee, default_offset_days, sort_order
      FROM hr_offboarding_checklist_templates
      WHERE is_active = TRUE
      ORDER BY category ASC, sort_order ASC, id ASC
    `);
    if (!r.rows.length) return res.json([]);
    res.json(r.rows);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.put('/offboarding/templates', verifyToken, requirePermission('hr', 'edit'), async (req, res) => {
  const rows = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!rows.length) return res.status(400).json({ error: 'items array is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE hr_offboarding_checklist_templates SET is_active = FALSE, updated_at = NOW() WHERE is_active = TRUE');
    let order = 0;
    for (const it of rows) {
      const category = String(it.category || '').trim();
      const itemLabel = String(it.item_label || it.item || '').trim();
      if (!category || !itemLabel) continue;
      const defaultAssignee = String(it.default_assignee || 'HR').trim() || 'HR';
      const defaultOffsetDays = Number.isInteger(Number(it.default_offset_days)) ? Number(it.default_offset_days) : 0;
      await client.query(
        `INSERT INTO hr_offboarding_checklist_templates
          (category, item_label, default_assignee, default_offset_days, sort_order, is_active, updated_at)
         VALUES ($1,$2,$3,$4,$5,TRUE,NOW())
         ON CONFLICT (category, item_label)
         DO UPDATE SET
           default_assignee = EXCLUDED.default_assignee,
           default_offset_days = EXCLUDED.default_offset_days,
           sort_order = EXCLUDED.sort_order,
           is_active = TRUE,
           updated_at = NOW()`,
        [category, itemLabel, defaultAssignee, defaultOffsetDays, order++]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/offboarding/:employeeId/checklist', verifyToken, requirePermission('hr', 'view'), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  try {
    const t = await pool.query(`
      SELECT category, item_label, default_assignee, default_offset_days, sort_order
      FROM hr_offboarding_checklist_templates
      WHERE is_active = TRUE
      ORDER BY category ASC, sort_order ASC, id ASC
    `);

    const p = await pool.query(`
      SELECT category, item_label, done, assignee, due_date, handover_notes, completed_at
      FROM hr_offboarding_checklist_progress
      WHERE employee_id = $1
    `, [employeeId]);

    const progressMap = new Map(p.rows.map(x => [`${x.category}__${x.item_label}`, x]));
    const merged = t.rows.map((row) => {
      const key = `${row.category}__${row.item_label}`;
      const pg = progressMap.get(key);
      return {
        category: row.category,
        item_label: row.item_label,
        done: !!pg?.done,
        assignee: pg?.assignee || row.default_assignee || 'HR',
        due_date: pg?.due_date || null,
        handover_notes: pg?.handover_notes || '',
        completed_at: pg?.completed_at || null,
      };
    });

    res.json(merged);
  } catch (e) {
    if (e.message.includes('does not exist')) return res.json([]);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/offboarding/:employeeId/checklist', verifyToken, requirePermission('hr', 'edit'), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  const rows = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  if (!rows.length) return res.status(400).json({ error: 'items array is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of rows) {
      const category = String(it.category || '').trim();
      const itemLabel = String(it.item_label || '').trim();
      if (!category || !itemLabel) continue;
      const done = !!it.done;
      const assignee = String(it.assignee || 'HR').trim() || 'HR';
      const dueDate = isValidDateString(it.due_date) ? it.due_date : null;
      const handoverNotes = String(it.handover_notes || '').trim();

      await client.query(
        `INSERT INTO hr_offboarding_checklist_progress
          (employee_id, category, item_label, done, assignee, due_date, handover_notes, completed_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
         ON CONFLICT (employee_id, category, item_label)
         DO UPDATE SET
           done = EXCLUDED.done,
           assignee = EXCLUDED.assignee,
           due_date = EXCLUDED.due_date,
           handover_notes = EXCLUDED.handover_notes,
           completed_at = EXCLUDED.completed_at,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
        [employeeId, category, itemLabel, done, assignee, dueDate, handoverNotes, done ? new Date().toISOString() : null, req.user?.userId || null]
      );
    }
    // Bridge: "Exit interview conducted" done → sync exit_requests.interview_done + exit_clearance
    const interviewDone = rows.some(
      (r) => r.done && /exit interview/i.test(String(r.item_label || ''))
    );
    if (interviewDone) {
      await client.query(
        `UPDATE exit_requests SET interview_done = TRUE
         WHERE employee_id = $1 AND status NOT IN ('rejected','cancelled')`,
        [employeeId]
      );
      await client.query(
        `INSERT INTO exit_clearance (employee_id, exit_interview_done)
         VALUES ($1, TRUE)
         ON CONFLICT (employee_id) DO UPDATE SET exit_interview_done = TRUE, updated_at = NOW()`,
        [employeeId]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/offboarding/:employeeId/checklist/notify', verifyToken, requirePermission('hr', 'edit'), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'Invalid employee id' });
  const assignee = String(req.body?.assignee || '').trim();
  if (!assignee) return res.status(400).json({ error: 'assignee is required' });
  // Stub notification hook; can be wired to email service later.
  res.json({ success: true, message: `Notification queued for ${assignee}`, employee_id: employeeId });
});

// ── POST /offboarding/:employeeId/complete ─────────────────────────────────────
// Called when all checklist items are done. Marks the employee as 'left',
// closes the exit_request, and stamps exit_date if missing.
router.post('/offboarding/:employeeId/complete', verifyToken, requirePermission('hr', 'edit'), async (req, res) => {
  const employeeId = Number(req.params.employeeId);
  if (!Number.isInteger(employeeId) || employeeId < 1) return res.status(400).json({ error: 'Invalid employee id' });

  const companyId = req.scope?.company_id ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Scope check — ensure employee belongs to caller's company
    const scopeParams = companyId != null ? [employeeId, companyId] : [employeeId];
    const scopeClause = companyId != null ? 'AND company_id = $2' : '';
    const { rows: empRows } = await client.query(
      `SELECT id, status FROM employees WHERE id = $1 ${scopeClause}`,
      scopeParams
    );
    if (!empRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Close any open exit request and capture last_working_date
    const { rows: [er] } = await client.query(
      `UPDATE exit_requests
          SET status = 'closed', updated_at = NOW()
        WHERE employee_id = $1 AND status NOT IN ('rejected','cancelled','closed','paid')
        RETURNING last_working_date`,
      [employeeId]
    );

    // Move employee to 'left' and stamp exit_date
    await client.query(
      `UPDATE employees
          SET status    = 'left',
              exit_date = COALESCE(exit_date, $1, CURRENT_DATE)
        WHERE id = $2`,
      [er?.last_working_date || null, employeeId]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

export default router;


