import express from 'express';
import pool from '../../config/db.js';
import { companyOf } from '../../shared/scope.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { logAudit } from '../../services/AuditService.js';
import {
  INTEGRATION_FIELDS, validateFields, saveConfig, readStored, maskSecrets, resolveStatus,
} from '../integrations/integrationConfig.js';

const router = express.Router();

/**
 * ── PULSE-01 follow-up: gating `/settings/:module` ───────────────────────────
 *
 * `GET` and `POST /settings/:module` were mounted with `verifyToken` alone. POST
 * is a GENERIC arbitrary-JSON writer over `company_settings` for ANY module name
 * — finance, payroll, compliance, servicedesk (which also rewrites
 * `sla_policies`) — so every authenticated user could rewrite every module's
 * configuration for their tenant. Reported as remaining risk 1 of the PULSE-01
 * remediation and closed here.
 *
 * THE GATE IS THE MATRIX ITSELF. The settings key IS a permission module for all
 * but three keys, so `requirePermission(key, action)` is the natural gate:
 * reading `/settings/projects` needs `projects:view`, writing it needs
 * `projects:edit`. Two consequences worth stating, because both are deliberate:
 *
 *  - An UNKNOWN settings key maps to a module with no `role_permissions` rows,
 *    and `requirePermission` fails CLOSED on that (PERMISSION_NOT_CONFIGURED).
 *    So a made-up module name is a 403 without needing its own check, and the
 *    gate cannot drift out of date as modules are added.
 *  - Gating the READS is safe: every frontend caller of these endpoints
 *    (`KanbanBoard`, `ResourceManagement`, `PayslipGenerator`,
 *    `useRecruitmentSettings`, `PerformanceSettings`, `ComplianceSettings`)
 *    already `.catch()`es and falls back to a default, so a user without the
 *    module permission gets the default rather than a broken page — verified
 *    before this gate was added, not assumed.
 */
const SETTINGS_KEY_ALIAS = {
  // Settings keys that are NOT themselves permission modules.
  company:          'company_profile',
  'setup-progress': 'settings',
  // Integration credentials are admin-level, exactly as the real integration
  // config API treats them. See the handlers below — this key does not reach
  // company_settings at all any more.
  integrations:     'admin',
};

const settingsGate = (action) => (req, res, next) => {
  const key = String(req.params.module ?? '');
  const permissionModule = SETTINGS_KEY_ALIAS[key] ?? key;
  return requirePermission(permissionModule, action)(req, res, next);
};

/**
 * ── `/settings/integrations` was a PLAINTEXT credential sink ─────────────────
 *
 * `SetupWizard.jsx` collects real secrets in its Integrations step —
 * `razorpay.key_secret`, `whatsapp.api_key`, `sendgrid.api_key`,
 * `zoho_sign.client_secret`, `aws_s3.secret_key` — and POSTed them here, where
 * the generic handler wrote them into `company_settings.settings`, a plain
 * **JSONB** column with no encryption. `GET /settings/integrations` then read
 * them back UNMASKED to any authenticated caller. That is a worse disclosure
 * than the endpoint PULSE-01 was raised against, which at least masked.
 *
 * The wizard keeps working, but its payload is now translated into the real
 * per-tenant AES-256-GCM store (`company_integrations`) through the same
 * allowlist and validators as `PUT /integrations/config/:key`. The shapes differ
 * (`whatsapp.api_key` vs `WHATSAPP_TOKEN`), so the translation is explicit.
 *
 * ⚠ `aws_s3` IS DELIBERATELY REFUSED. `AWS_S3_*` and `BACKUP_S3_BUCKET` are read
 * by `StorageService.js` and `backup.cron.js` — process-level infrastructure with
 * no tenant, and the backup destination for the whole deployment. A tenant admin
 * must not be able to set them, so the wizard was asking for something it had no
 * business collecting. The refusal is REPORTED in the response (`rejected[]`),
 * never silent: a dropped credential field that answers 200 reads as saved.
 */
const WIZARD_TO_INTEGRATION = {
  whatsapp:  { key: 'whatsapp',   fields: { api_key: 'WHATSAPP_TOKEN', phone_number_id: 'WHATSAPP_PHONE_ID' } },
  sendgrid:  { key: 'sendgrid',   fields: { api_key: 'SENDGRID_API_KEY', from_email: 'SENDGRID_FROM_EMAIL' } },
  razorpay:  { key: 'razorpay',   fields: { key_id: 'RAZORPAY_KEY_ID', key_secret: 'RAZORPAY_KEY_SECRET' } },
  zoho_sign: { key: 'zoho-sign',  fields: { client_id: 'ZOHO_SIGN_CLIENT_ID', client_secret: 'ZOHO_SIGN_CLIENT_SECRET' } },
  // host + port compose one URL; handled specially below.
  tally:     { key: 'tally',      fields: { company: 'TALLY_COMPANY' }, composeUrl: true },
};

const INFRASTRUCTURE_PROVIDERS = {
  aws_s3: 'S3 storage and backup destinations are deployment-level infrastructure, ' +
          'configured by an operator in the server environment. They are not tenant settings.',
};

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

// ⚠ Express matches in definition order, so these two literal /tally routes
// MUST stay above the /:module handlers below. When they sat after them,
// /:module swallowed both: GET returned {} from company_settings instead of
// the tally_config row, and POST wrote the Tally form into company_settings,
// so the integration (which reads tally_config) never saw a saved config.
/* ── GET /settings/tally — retrieve saved Tally config for the company ── */
/**
 * Read gate is `settings:view`, NOT `admin:view`, deliberately. The Tally page
 * sits under the Settings nav group, whose key grants view to finance_manager and
 * hr_manager as well as admin — and `admin:view` is admin/super_admin only, so
 * gating the READ on it would 403 exactly the finance role this page exists for
 * and show them an empty form. tally_config holds no credential (a gateway URL, a
 * company name and sync toggles), so viewing it at that level is appropriate. The
 * WRITE below is `admin:edit`.
 */
router.get('/tally', requirePermission('settings', 'view'), async (req, res) => {
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
/**
 * ⚠ THIS IS AN ALIAS. `PUT /api/v1/integrations/tally/config` writes the same
 * `tally_config` row. Found during the PULSE-01 alternate-path sweep, where it was
 * mounted with `verifyToken` alone — so gating only the integrations copy would
 * have left any authenticated employee able to repoint the tenant's outbound
 * Tally gateway through here instead. The gate and the URL validator are
 * deliberately IDENTICAL to the other path's; if you change one, change both.
 */
router.post('/tally', requirePermission('admin', 'edit'), async (req, res) => {
  try {
    const { tally_url, company, company_name, fy_start, fy_end, sync_ledgers, sync_invoices, sync_payments } = req.body;
    const company_id = companyOf(req);

    if (tally_url) {
      const problem = INTEGRATION_FIELDS.tally.TALLY_GATEWAY_URL.validate(String(tally_url).trim());
      if (problem) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_VALUE',
          message: `Tally gateway URL ${problem}.`,
        });
      }
    }

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

/**
 * GET /settings/integrations — the wizard's view of integration config.
 *
 * Reads the ENCRYPTED per-tenant store and returns the wizard's own field shape
 * with every secret replaced by '***'. The wizard only uses these values to set
 * its `configured` flags (`!!(data.whatsapp?.api_key)`), and '***' is truthy, so
 * the flags stay correct without a secret leaving the server.
 */
async function sendWizardIntegrations(req, res) {
  const cid = companyOf(req);
  try {
    const out = {};
    // Sequential: five small indexed lookups. Promise.all would take five pool
    // connections for a wizard page-load — see the budget note in vitest.config.js.
    for (const [wizardKey, spec] of Object.entries(WIZARD_TO_INTEGRATION)) {
      const masked = maskSecrets(spec.key, await readStored(cid, spec.key));
      const block = {};
      for (const [wizardField, allowField] of Object.entries(spec.fields)) {
        if (masked[allowField] != null) block[wizardField] = masked[allowField];
      }
      if (spec.composeUrl && masked.TALLY_GATEWAY_URL) {
        try {
          const u = new URL(masked.TALLY_GATEWAY_URL);
          // ⚠ THE SCHEME AND THE ABSENCE OF A PORT BOTH HAVE TO SURVIVE THIS.
          // Handing back a bare hostname plus a synthesised port made the wizard
          // post `{host: 'gw.test', port: '443'}`, which composed to
          // `http://gw.test:443` — an https gateway SILENTLY DOWNGRADED TO http on
          // the next save. Found by round-tripping this pair in review, not by a
          // test. So https is handed back scheme-and-all (the composer detects that
          // form) and the port is offered only when the stored URL carried one.
          block.host = u.protocol === 'https:' ? `https://${u.hostname}` : u.hostname;
          block.port = u.port || '';
        } catch { /* a stored value that will not parse is simply not offered back */ }
      }
      if (Object.keys(block).length) out[wizardKey] = block;
    }
    res.json(out);
  } catch (err) {
    console.error('[settings/integrations] read failed:', err.message);
    res.status(500).json({ error: 'Failed to load integration configuration' });
  }
}

/**
 * POST /settings/integrations — translate the wizard payload into the encrypted store.
 *
 * Returns `{ success, saved[], rejected[] }`. `rejected` is the honest half: a
 * provider this endpoint will not store (infrastructure), an unknown provider, or
 * a value that failed the shared validators. Nothing is dropped silently.
 */
async function saveWizardIntegrations(req, res) {
  const cid = companyOf(req);
  const body = req.body ?? {};
  const saved = [];
  const rejected = [];

  try {
    for (const [provider, raw] of Object.entries(body)) {
      if (INFRASTRUCTURE_PROVIDERS[provider]) {
        rejected.push({ provider, reason: INFRASTRUCTURE_PROVIDERS[provider] });
        continue;
      }
      const spec = WIZARD_TO_INTEGRATION[provider];
      if (!spec) {
        rejected.push({ provider, reason: 'Not a supported integration.' });
        continue;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        rejected.push({ provider, reason: 'Expected an object of configuration values.' });
        continue;
      }

      // Translate wizard field names to allowlist field names. `configured` is a
      // UI flag the wizard sends back; it is not configuration.
      const fields = {};
      for (const [wizardField, value] of Object.entries(raw)) {
        if (wizardField === 'configured') continue;
        const allowField = spec.fields[wizardField];
        if (allowField) { fields[allowField] = value; continue; }
        if (spec.composeUrl && (wizardField === 'host' || wizardField === 'port')) continue; // handled below
        rejected.push({ provider, field: wizardField, reason: 'Not part of this integration.' });
      }

      if (spec.composeUrl) {
        const host = String(raw.host ?? '').trim();
        const port = String(raw.port ?? '').trim();
        // Only compose when a host was actually given; a bare port is not a URL.
        // A host that already carries a scheme KEEPS it — that is how an https
        // gateway survives the round trip (see sendWizardIntegrations).
        if (host) {
          const withScheme = /^https?:\/\//i.test(host) ? host : `http://${host}`;
          const trimmed = withScheme.replace(/\/+$/, '');
          fields.TALLY_GATEWAY_URL = port ? `${trimmed}:${port}` : trimmed;
        }
      }

      // Same allowlist and validators as PUT /integrations/config/:key. '***'
      // round-trips as "leave the stored value alone", which is what the masked
      // GET above hands back.
      const validation = validateFields(spec.key, fields);
      if (!validation.ok) {
        for (const bad of validation.invalid) rejected.push({ provider, field: bad.field, reason: bad.message });
        for (const unk of validation.unknown)  rejected.push({ provider, field: unk, reason: 'Not part of this integration.' });
        continue;
      }
      if (!Object.keys(validation.fields).length) continue;   // nothing new to store

      const { changedFields } = await saveConfig(cid, spec.key, validation.fields);
      saved.push({ provider, integration: spec.key, changed_fields: changedFields });
    }

    // Field NAMES only — never the values.
    logAudit({
      userId: req.user?.userId ?? null,
      module: 'admin',
      recordType: 'integration_config',
      recordId: 'setup-wizard',
      action: 'update',
      newData: { via: 'settings/integrations', company_id: cid, saved, rejected: rejected.map((r) => ({ provider: r.provider, field: r.field })) },
      req,
    });

    res.json({ success: true, saved, rejected });
  } catch (err) {
    console.error('[settings/integrations] save failed:', err.message);
    res.status(500).json({ error: 'Failed to save integration configuration' });
  }
}

// GET /settings/:module — read module settings (falls back to {} if not saved)
router.get('/:module', settingsGate('view'), async (req, res) => {
  const { module } = req.params;
  const cid = companyOf(req) ?? 0;

  // Integration credentials come from the encrypted per-tenant store, MASKED —
  // never from company_settings, which used to hold them in clear JSONB.
  if (module === 'integrations') return sendWizardIntegrations(req, res);

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
router.post('/:module', settingsGate('edit'), async (req, res) => {
  const { module } = req.params;
  const cid = companyOf(req) ?? 0;
  const uid = req.user?.userId ?? req.user?.id ?? null;

  if (module === 'integrations') return saveWizardIntegrations(req, res);

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

export default router;
