import express from 'express';
import pool from '../../config/db.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();

async function safeCount(sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return parseInt(r.rows[0]?.count ?? 0, 10);
  } catch {
    return 0;
  }
}

async function safeRow(sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

function pct(done, total) {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

// GET /settings/status  — per-domain completion percentages from real table data
router.get('/status', async (req, res) => {
  try {
    const [
      deptCount,
      userCount,
      salaryCount,
      leaveCount,
      attendancePolCount,
      attendanceGenCount,
      attendanceGeoCount,
      workflowCount,
      financeSettingsCount,
      coaCount,
      bankCount,
    ] = await Promise.all([
      safeCount(`SELECT COUNT(*) FROM master_departments WHERE is_active = true`),
      safeCount(`SELECT COUNT(*) FROM users WHERE is_active = true AND LOWER(role) != 'super_admin'`),
      safeCount(`SELECT COUNT(*) FROM salary_structures`),
      safeCount(`SELECT COUNT(*) FROM leave_types WHERE is_active = true AND deleted_at IS NULL`),
      safeCount(`SELECT COUNT(*) FROM attendance_policies WHERE is_active = true`),
      safeCount(`SELECT COUNT(*) FROM attendance_general_settings`),
      safeCount(`SELECT COUNT(*) FROM attendance_geo_rules WHERE is_active = true`),
      safeCount(`SELECT COUNT(*) FROM workflow_templates`),
      safeCount(`SELECT COUNT(*) FROM company_settings WHERE module = 'finance'`),
      safeCount(`SELECT COUNT(*) FROM chart_of_accounts`),
      safeCount(`SELECT COUNT(*) FROM bank_accounts`),
    ]);

    // Company profile completeness: needs GSTIN + address + state
    const company = await safeRow(
      `SELECT gstin, address, state FROM companies ORDER BY id LIMIT 1`
    );
    const companyProfileComplete = !!(company?.gstin && company?.address && company?.state);

    // Finance GST correctness: if place_of_supply_state is saved it must match company state
    const finRow = await safeRow(
      `SELECT settings FROM company_settings WHERE module = 'finance' LIMIT 1`
    );
    const fs = finRow?.settings ?? {};
    const gstStateCorrect = financeSettingsCount > 0 &&
      (!fs.place_of_supply_state || fs.place_of_supply_state === (company?.state ?? ''));

    // ── Domain 1: Company & Organization ──────────────────────────────────────
    // Check 1: company profile complete (GSTIN + address + state filled)
    // Check 2: org structure exists (at least one department created)
    const companyChecks = [companyProfileComplete, deptCount > 0];
    const companyDone   = companyChecks.filter(Boolean).length;

    // ── Domain 2: People & HR ─────────────────────────────────────────────────
    const hrChecks = [
      userCount > 0,
      salaryCount > 0,
      leaveCount > 0,
      attendancePolCount > 0,
      attendanceGenCount > 0,
    ];
    const hrDone = hrChecks.filter(Boolean).length;

    // ── Domain 3: Finance & Tax ───────────────────────────────────────────────
    // Check 1: Finance settings saved with correct GST state (not Maharashtra when company is Karnataka)
    // Check 2: Chart of accounts seeded
    // Check 3: Bank accounts configured
    const finChecks = [gstStateCorrect, coaCount > 0, bankCount > 0];
    const finDone   = finChecks.filter(Boolean).length;

    // ── Domain 4: Operations & Workflow ───────────────────────────────────────
    const opsChecks = [workflowCount > 0, attendancePolCount > 0];
    const opsDone   = opsChecks.filter(Boolean).length;

    // ── Domain 5: Integrations & Security ────────────────────────────────────
    const intChecks = [attendanceGeoCount > 0, attendanceGenCount > 0];
    const intDone   = intChecks.filter(Boolean).length;

    // ── Domain 6: User Preferences ───────────────────────────────────────────
    // Always partially configured (profile exists for every logged-in user)
    const prefDone  = 1;
    const prefTotal = 2;

    const domains = {
      company:      { pct: pct(companyDone, companyChecks.length), configured: companyDone, total: companyChecks.length },
      people_hr:    { pct: pct(hrDone, hrChecks.length),           configured: hrDone,      total: hrChecks.length },
      finance_tax:  { pct: pct(finDone, finChecks.length),         configured: finDone,     total: finChecks.length },
      operations:   { pct: pct(opsDone, opsChecks.length),         configured: opsDone,     total: opsChecks.length },
      integrations: { pct: pct(intDone, intChecks.length),         configured: intDone,     total: intChecks.length },
      preferences:  { pct: pct(prefDone, prefTotal),               configured: prefDone,    total: prefTotal },
    };

    const overall = Math.round(
      Object.values(domains).reduce((sum, d) => sum + d.pct, 0) / Object.keys(domains).length
    );

    res.json({ domains, overall });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /settings/setup-progress — DB-authoritative wizard state (used by AuthContext)
// Reads system_wizard table directly so every browser/device sees the same truth.
router.get('/setup-progress', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT dismissed, completed FROM system_wizard WHERE id = 1`
    );
    const row = r.rows[0] || { dismissed: false, completed: false };
    res.json({
      needsSetup: !row.dismissed && !row.completed,
      dismissed:  row.dismissed,
      completed:  row.completed,
    });
  } catch {
    // Return safe default — do not block login on DB hiccup
    res.json({ needsSetup: false, dismissed: false, completed: false });
  }
});

// GET /settings/:module — read module settings (falls back to {} if not saved)
router.get('/:module', async (req, res) => {
  const { module } = req.params;
  const cid = req.scope?.company_id != null ? req.scope.company_id : 0;
  try {
    const { rows } = await pool.query(
      `SELECT settings FROM company_settings WHERE company_id = $1 AND module = $2 LIMIT 1`,
      [cid, module]
    );
    res.json(rows[0]?.settings || {});
  } catch {
    res.json({});
  }
});

// POST /settings/:module — save module settings (upsert) + audit log
router.post('/:module', async (req, res) => {
  const { module } = req.params;
  const cid = req.scope?.company_id != null ? req.scope.company_id : 0;
  const uid = req.user?.userId ?? req.user?.id ?? null;
  try {
    // Fetch old value for audit diff
    const { rows: existing } = await pool.query(
      `SELECT settings FROM company_settings WHERE company_id = $1 AND module = $2 LIMIT 1`,
      [cid, module]
    ).catch(() => ({ rows: [] }));
    const oldSettings = existing[0]?.settings ?? null;

    await pool.query(
      `INSERT INTO company_settings (company_id, module, settings, updated_at)
       VALUES ($1, $2, $3::JSONB, NOW())
       ON CONFLICT (company_id, module)
       DO UPDATE SET settings = EXCLUDED.settings, updated_at = NOW()`,
      [cid, module, JSON.stringify(req.body)]
    );

    // Write audit log (best-effort — never fail the save on audit error)
    pool.query(
      `INSERT INTO audit_log (company_id, user_id, action, entity_type, old_value, new_value, created_at)
       VALUES ($1, $2, 'UPDATE', $3, $4::JSONB, $5::JSONB, NOW())`,
      [cid || null, uid, `settings:${module}`, JSON.stringify(oldSettings), JSON.stringify(req.body)]
    ).catch(() => {});

    // Sync SLA settings → sla_policies table so SLA Policies tab stays in-sync
    if (module === 'servicedesk') {
      const s = req.body;
      const priorities = [
        { priority: 'critical', name: 'Critical',  first_response_hours: Number(s.sla_response_critical) || 1,  resolution_hours: Number(s.sla_resolution_critical) || 4  },
        { priority: 'high',     name: 'High',       first_response_hours: Number(s.sla_response_high)     || 4,  resolution_hours: Number(s.sla_resolution_high)     || 24 },
        { priority: 'medium',   name: 'Medium',     first_response_hours: Number(s.sla_response_medium)   || 8,  resolution_hours: Number(s.sla_resolution_medium)   || 72 },
        { priority: 'low',      name: 'Low',        first_response_hours: Number(s.sla_response_low)      || 24, resolution_hours: Number(s.sla_resolution_low)      || 168 },
      ];
      const companyIdForSla = cid || null;
      for (const p of priorities) {
        pool.query(`
          WITH upd AS (
            UPDATE sla_policies
               SET name = $1, first_response_hours = $2, resolution_hours = $3
             WHERE ($4::int IS NULL OR company_id = $4)
               AND LOWER(priority) = LOWER($5)
             RETURNING id
          )
          INSERT INTO sla_policies (name, priority, first_response_hours, resolution_hours, escalation_hours, business_hours_only, company_id)
          SELECT $1, $5, $2, $3, 8, true, $4
          WHERE NOT EXISTS (SELECT 1 FROM upd)
        `, [p.name, p.first_response_hours, p.resolution_hours, companyIdForSla, p.priority]).catch(() => {});
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /settings/tally — retrieve saved Tally config for the company ── */
router.get('/tally', async (req, res) => {
  try {
    const company_id = companyOf(req);
    const row = await safeRow(`SELECT * FROM tally_config WHERE company_id = $1`, [company_id]);
    res.json({
      tally_url:    row?.tally_url    || process.env.TALLY_GATEWAY_URL || 'http://localhost:9000',
      company_name: row?.company_name || '',
      fy_start:     row?.fy_start     || null,
      fy_end:       row?.fy_end       || null,
      sync_ledgers:  row?.sync_ledgers  ?? true,
      sync_invoices: row?.sync_invoices ?? true,
      sync_payments: row?.sync_payments ?? true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /settings/tally — save Tally config scoped by company_id ── */
router.post('/tally', async (req, res) => {
  try {
    const { tally_url, company, company_name, fy_start, fy_end, sync_ledgers, sync_invoices, sync_payments } = req.body;
    const company_id = companyOf(req);

    await pool.query(`
      INSERT INTO tally_config
        (company_id, tally_url, company_name, fy_start, fy_end, sync_ledgers, sync_invoices, sync_payments, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (company_id) DO UPDATE SET
        tally_url     = EXCLUDED.tally_url,
        company_name  = EXCLUDED.company_name,
        fy_start      = EXCLUDED.fy_start,
        fy_end        = EXCLUDED.fy_end,
        sync_ledgers  = EXCLUDED.sync_ledgers,
        sync_invoices = EXCLUDED.sync_invoices,
        sync_payments = EXCLUDED.sync_payments,
        updated_at    = NOW()
    `, [
      company_id,
      tally_url    || 'http://localhost:9000',
      company_name || company || null,
      fy_start     || null,
      fy_end       || null,
      sync_ledgers  ?? true,
      sync_invoices ?? true,
      sync_payments ?? true,
    ]);

    res.json({ success: true, message: 'Tally configuration saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
