import express from 'express';
import pool from '../../../config/db.js';
import { allowRoles } from '../../../middlewares/auth.middleware.js';

const router = express.Router();

const scopeCompanyId = (req) => req.scope?.company_id ?? null;

// Only HR/admin may modify the holiday calendar — employees are read-only.
// Holidays drive attendance marking and leave (clubbing/LOP) calculations, so
// uncontrolled edits silently change everyone's leave counts.
const HOLIDAY_EDIT_ROLES = [
  'super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec',
  // legacy mixed-case variants stored in older user records
  'Admin', 'SuperAdmin', 'HR',
];
const requireHolidayEditor = allowRoles(...HOLIDAY_EDIT_ROLES);

// GET /holidays?year=2026&zone_id=3&upcoming=1
// NULL company_id rows are global seed data visible to all tenants.
router.get('/', async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { year, zone_id, upcoming } = req.query;

    const conditions = [`($1::integer IS NULL OR h.company_id = $1 OR h.company_id IS NULL)`];
    const params = [companyId];

    if (year) {
      params.push(Number(year));
      conditions.push(`EXTRACT(year FROM h.date) = $${params.length}`);
    }

    if (upcoming === '1' || upcoming === 'true') {
      conditions.push(`h.date >= CURRENT_DATE`);
    }

    if (zone_id) {
      // National holidays (zone_id IS NULL) always included; add zone-specific ones
      params.push(Number(zone_id));
      conditions.push(`(h.zone_id IS NULL OR h.zone_id = $${params.length})`);
    }

    const { rows } = await pool.query(
      `SELECT h.*, mz.name AS zone_name
         FROM holidays h
         LEFT JOIN master_zones mz ON mz.id = h.zone_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY h.date ASC`,
      params
    );
    res.json(rows);
  } catch {
    res.json([]);
  }
});

// POST /holidays — create with duplicate prevention
router.post('/', requireHolidayEditor, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { name, date, type = 'Optional', description = '', zone_id = null } = req.body;
    if (!name?.trim() || !date) return res.status(400).json({ error: 'name and date are required' });

    // Duplicate check: same name (case-insensitive) + date + company
    const dupParams = [name.trim(), date];
    let dupWhere = 'LOWER(name) = LOWER($1) AND date = $2';
    if (companyId) {
      dupParams.push(companyId);
      dupWhere += ` AND company_id = $${dupParams.length}`;
    }
    const { rows: dup } = await pool.query(`SELECT id FROM holidays WHERE ${dupWhere}`, dupParams);
    if (dup.length > 0) {
      return res.status(409).json({ error: `Holiday "${name.trim()}" already exists on ${date}` });
    }

    const { rows } = await pool.query(
      `INSERT INTO holidays (name, date, type, description, company_id, zone_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.trim(), date, type, description, companyId, zone_id || null]
    );
    const createdHoliday = rows[0];

    // Auto-mark attendance as holiday for all active employees on this date (non-blocking)
    pool.query(`
      INSERT INTO attendance_records (employee_id, attendance_date, status, company_id, source)
      SELECT e.id, $1::date, 'holiday', e.company_id, 'holiday_sync'
        FROM employees e
       WHERE e.deleted_at IS NULL
         AND LOWER(e.status) IN ('active','probation')
         AND ($2::integer IS NULL OR e.company_id = $2)
      ON CONFLICT (employee_id, attendance_date) DO UPDATE
        SET status = 'holiday', updated_at = NOW()
        WHERE attendance_records.status NOT IN ('present','late')
    `, [createdHoliday.date, createdHoliday.company_id]).catch(() => {});

    res.status(201).json(createdHoliday);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /holidays/:id — edit holiday fields
router.patch('/:id', requireHolidayEditor, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const { name, date, type, description, zone_id } = req.body;

    const sets = [];
    const params = [req.params.id];

    if (name !== undefined)        { params.push(name.trim());     sets.push(`name = $${params.length}`); }
    if (date !== undefined)        { params.push(date);            sets.push(`date = $${params.length}`); }
    if (type !== undefined)        { params.push(type);            sets.push(`type = $${params.length}`); }
    if (description !== undefined) { params.push(description);     sets.push(`description = $${params.length}`); }
    if (zone_id !== undefined)     { params.push(zone_id || null); sets.push(`zone_id = $${params.length}`); }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    let whereClause = 'id = $1';
    if (companyId) {
      params.push(companyId);
      whereClause += ` AND (company_id = $${params.length} OR company_id IS NULL)`;
    }

    const { rows } = await pool.query(
      `UPDATE holidays SET ${sets.join(', ')} WHERE ${whereClause} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Holiday not found or access denied' });
    const updatedHoliday = rows[0];

    // Auto-mark attendance as holiday for all active employees on the (possibly new) date
    pool.query(`
      INSERT INTO attendance_records (employee_id, attendance_date, status, company_id, source)
      SELECT e.id, $1::date, 'holiday', e.company_id, 'holiday_sync'
        FROM employees e
       WHERE e.deleted_at IS NULL
         AND LOWER(e.status) IN ('active','probation')
         AND ($2::integer IS NULL OR e.company_id = $2)
      ON CONFLICT (employee_id, attendance_date) DO UPDATE
        SET status = 'holiday', updated_at = NOW()
        WHERE attendance_records.status NOT IN ('present','late')
    `, [updatedHoliday.date, updatedHoliday.company_id]).catch(() => {});

    res.json(updatedHoliday);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /holidays/:id — scoped so a tenant can only delete their own holidays
router.delete('/:id', requireHolidayEditor, async (req, res) => {
  try {
    const companyId = scopeCompanyId(req);
    const result = await pool.query(
      `DELETE FROM holidays
        WHERE id = $1 AND ($2::integer IS NULL OR company_id = $2)
       RETURNING id, date, company_id`,
      [req.params.id, companyId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Holiday not found or access denied' });
    const deletedHoliday = result.rows[0];

    // Remove holiday_sync attendance records for this date (non-blocking)
    pool.query(`
      DELETE FROM attendance_records
       WHERE attendance_date = $1::date
         AND status = 'holiday'
         AND source = 'holiday_sync'
         AND ($2::integer IS NULL OR company_id = $2)
    `, [deletedHoliday.date, deletedHoliday.company_id]).catch(() => {});

    res.json({ message: 'Holiday deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
