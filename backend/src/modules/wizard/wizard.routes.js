import express from 'express';
import pool from '../../config/db.js';
import { seedCompanyDefaults } from '../../seeds/defaultSeed.js';

const router = express.Router();

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_wizard (
        id           INTEGER PRIMARY KEY DEFAULT 1,
        dismissed    BOOLEAN NOT NULL DEFAULT false,
        dismissed_at TIMESTAMPTZ,
        completed    BOOLEAN NOT NULL DEFAULT false,
        completed_at TIMESTAMPTZ,
        current_step INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT system_wizard_single_row CHECK (id = 1)
      );
      INSERT INTO system_wizard (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);
    // Non-destructive: add current_step to existing installations
    await pool.query(`
      ALTER TABLE system_wizard ADD COLUMN IF NOT EXISTS current_step INTEGER NOT NULL DEFAULT 0
    `);
  } catch (e) {
    console.error('[wizard] table init failed:', e.message);
  }
})();

async function safeCount(sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return parseInt(r.rows[0]?.count ?? 0, 10);
  } catch {
    return 0;
  }
}

// GET /wizard/status — counts per setup step + dismissed/completed flags + current_step
router.get('/status', async (req, res) => {
  try {
    const [
      depts, desigs, users, salaries, leaveTypes,
      attendanceGen, wizardRow,
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM master_departments WHERE is_active = true`),
      pool.query(`SELECT COUNT(*) FROM master_designations WHERE is_active = true`),
      pool.query(`SELECT COUNT(*) FROM users WHERE is_active = true AND LOWER(role) != 'super_admin'`),
      pool.query(`SELECT COUNT(*) FROM salary_structures`),
      pool.query(`SELECT COUNT(*) FROM leave_types WHERE is_active = true AND deleted_at IS NULL`),
      // attendance_general_settings used as proxy for "attendance configured"
      safeCount(`SELECT COUNT(*) FROM attendance_general_settings`),
      pool.query(`SELECT dismissed, completed, current_step FROM system_wizard WHERE id = 1`),
    ]);

    const wizard      = wizardRow.rows[0] || { dismissed: false, completed: false, current_step: 0 };
    const deptCount   = parseInt(depts.rows[0].count);
    const desigCount  = parseInt(desigs.rows[0].count);
    const userCount   = parseInt(users.rows[0].count);
    const salaryCount = parseInt(salaries.rows[0].count);
    const leaveCount  = parseInt(leaveTypes.rows[0].count);
    const attGenCount = attendanceGen;

    // company_profile: done if departments are set (departments require org to be set up)
    const steps = {
      company_profile:   { count: deptCount,   done: deptCount > 0 },
      departments:       { count: deptCount,   done: deptCount > 0 },
      designations:      { count: desigCount,  done: desigCount > 0 },
      users:             { count: userCount,   done: userCount > 0 },
      salary_structures: { count: salaryCount, done: salaryCount > 0 },
      leave_types:       { count: leaveCount,  done: leaveCount > 0 },
      attendance_setup:  { count: attGenCount, done: attGenCount > 0 },
    };

    const totalDone  = Object.values(steps).filter(s => s.done).length;
    const totalSteps = Object.keys(steps).length;

    res.json({
      dismissed:    wizard.dismissed,
      completed:    wizard.completed,
      current_step: wizard.current_step ?? 0,
      steps,
      total_done:   totalDone,
      total_steps:  totalSteps,
      all_done:     totalDone === totalSteps,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /wizard/step — persist the active step so the wizard is resumable
router.post('/step', async (req, res) => {
  const step = parseInt(req.body?.step ?? 0, 10);
  if (isNaN(step) || step < 0) return res.status(400).json({ error: 'Invalid step' });
  try {
    await pool.query(
      `UPDATE system_wizard SET current_step = $1 WHERE id = 1`,
      [step]
    );
    res.json({ success: true, current_step: step });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /wizard/dismiss — mark wizard dismissed
router.post('/dismiss', async (req, res) => {
  try {
    await pool.query(
      `UPDATE system_wizard SET dismissed = true, dismissed_at = NOW() WHERE id = 1`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /wizard/complete — mark setup fully completed + seed company defaults
router.post('/complete', async (req, res) => {
  try {
    await pool.query(
      `UPDATE system_wizard
       SET completed = true, completed_at = NOW(), dismissed = true, dismissed_at = NOW()
       WHERE id = 1`
    );
    // Fire-and-forget: seed default registry data for the company
    const cid = req.scope?.company_id ?? null;
    if (cid) {
      seedCompanyDefaults(cid, pool).catch(err =>
        console.error('[wizard/complete] seed error:', err.message)
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /wizard/progress — company-scoped detailed setup status (per-step with GSTIN validation)
// Consumed by SetupDashboard, SetupWizard, and SystemSettings to show the same % everywhere.
router.get('/progress', async (req, res) => {
  try {
    const cid = req.scope?.company_id ?? null;

    const [company, branches, departments, holidays, users, bank, payroll, leaveTypes] =
      await Promise.all([
        pool.query(`SELECT gstin, name FROM companies WHERE id = $1`, [cid]).catch(() => ({ rows: [] })),
        pool.query(`SELECT COUNT(*) FROM branches WHERE company_id = $1`, [cid]).catch(() => ({ rows: [{ count: '0' }] })),
        pool.query(`SELECT COUNT(*) FROM master_departments WHERE company_id = $1 AND is_active = true`, [cid]).catch(() => ({ rows: [{ count: '0' }] })),
        pool.query(`SELECT COUNT(*) FROM holidays WHERE company_id = $1`, [cid]).catch(() => ({ rows: [{ count: '0' }] })),
        pool.query(`SELECT COUNT(*) FROM users WHERE company_id = $1 AND is_active = true`, [cid]).catch(() => ({ rows: [{ count: '0' }] })),
        pool.query(`SELECT COUNT(*) FROM bank_accounts WHERE company_id = $1`, [cid]).catch(() => ({ rows: [{ count: '0' }] })),
        pool.query(`SELECT COUNT(*) FROM payroll_settings WHERE company_id = $1`, [cid]).catch(() => ({ rows: [{ count: '0' }] })),
        pool.query(`SELECT COUNT(*) FROM leave_types WHERE company_id = $1 AND is_active = true AND deleted_at IS NULL`, [cid]).catch(() => ({ rows: [{ count: '0' }] })),
      ]);

    const gstin         = company.rows[0]?.gstin;
    const isGSTINValid  = gstin && /^\d{2}/.test(gstin) && gstin.length === 15;
    const branchCount   = parseInt(branches.rows[0]?.count   ?? 0, 10);
    const deptCount     = parseInt(departments.rows[0]?.count ?? 0, 10);
    const holidayCount  = parseInt(holidays.rows[0]?.count   ?? 0, 10);
    const userCount     = parseInt(users.rows[0]?.count       ?? 0, 10);
    const bankCount     = parseInt(bank.rows[0]?.count        ?? 0, 10);
    const payrollCount  = parseInt(payroll.rows[0]?.count     ?? 0, 10);
    const leaveCount    = parseInt(leaveTypes.rows[0]?.count  ?? 0, 10);

    const steps = [
      { key: 'company_info',  label: 'Company Information', status: isGSTINValid ? 'configured' : (company.rows[0]?.name ? 'partial' : 'pending') },
      { key: 'branches',      label: 'Branch Setup',         status: branchCount  > 0 ? 'configured' : 'pending' },
      { key: 'departments',   label: 'Departments & Roles',  status: deptCount    > 0 ? 'configured' : 'pending' },
      { key: 'holidays',      label: 'Holiday Calendar',     status: holidayCount > 0 ? 'configured' : 'pending' },
      { key: 'users',         label: 'User Management',      status: userCount    > 1 ? 'configured' : 'pending' },
      { key: 'payroll',       label: 'Payroll Settings',     status: payrollCount > 0 ? 'configured' : 'pending' },
      { key: 'bank',          label: 'Bank Accounts',        status: bankCount    > 0 ? 'configured' : 'pending' },
      { key: 'leave_types',   label: 'Leave Types',          status: leaveCount   > 0 ? 'configured' : 'pending' },
    ];

    const configured = steps.filter(s => s.status === 'configured').length;
    const partial    = steps.filter(s => s.status === 'partial').length;
    const pending    = steps.filter(s => s.status === 'pending').length;
    const pct        = Math.round((configured / steps.length) * 100);

    res.json({ steps, configured, partial, pending, total: steps.length, percentage: pct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /wizard/reset — clear all flags (testing / re-onboard)
router.post('/reset', async (req, res) => {
  try {
    await pool.query(
      `UPDATE system_wizard
       SET dismissed = false, dismissed_at = NULL,
           completed = false, completed_at = NULL,
           current_step = 0
       WHERE id = 1`
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
