import express from 'express';
import multer from 'multer';
import pool from '../../shared/db.js';
import leadsRepository from '../repositories/leads.repository.js';
import opportunitiesRepository from '../repositories/opportunities.repository.js';
import { requirePermission, allowRoles } from '../../../middlewares/auth.middleware.js';
import * as drive from '../../../services/googleDrive.service.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Accounts ──────────────────────────────────────────────────────────────────
router.get('/accounts', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid  = companyOf(req);
    const type = (req.query.type   || '').toLowerCase();
    const srch = (req.query.search || '').trim();

    const { rows } = await pool.query(
      `SELECT
         a.id,
         COALESCE(a.name, a.account_name) AS name,
         a.industry, a.account_type, a.phone, a.website,
         NULL::text AS city,
         a.annual_revenue, a.employees_count AS employee_count,
         (a.status = 'active') AS is_active, a.status, a.logo_url, a.created_at,
         COUNT(DISTINCT c.id)  AS contacts_count,
         COUNT(DISTINCT o.id)  AS opportunities_count,
         COALESCE(SUM(o.expected_value)
           FILTER (WHERE LOWER(COALESCE(o.stage,'')) NOT IN ('won','lost')), 0)
           AS open_pipeline_value
       FROM accounts a
       LEFT JOIN contacts      c ON c.account_id = a.id
       LEFT JOIN opportunities o ON o.account_id = a.id
       WHERE (a.deleted_at IS NULL)
         AND ($1::int IS NULL OR a.company_id = $1)
         AND ($2 = '' OR LOWER(a.account_type) = $2)
         AND ($3 = '' OR
              COALESCE(a.name, a.account_name) ILIKE '%' || $3 || '%' OR
              a.industry ILIKE '%' || $3 || '%')
       GROUP BY a.id
       ORDER BY COALESCE(a.name, a.account_name) ASC`,
      [cid, type, srch]
    );
    res.json({ accounts: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Account stats ─────────────────────────────────────────────────────────────
router.get('/accounts/stats', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                                                  AS total,
         COUNT(*) FILTER (WHERE LOWER(account_type)='customer')   AS customers,
         COUNT(*) FILTER (WHERE LOWER(account_type)='prospect')   AS prospects,
         COUNT(*) FILTER (WHERE LOWER(account_type)='partner')    AS partners,
         COUNT(*) FILTER (WHERE LOWER(account_type)='competitor') AS competitors,
         COUNT(*) FILTER (WHERE account_type IS NULL
           OR LOWER(account_type) NOT IN
             ('customer','prospect','partner','competitor'))       AS other,
         COALESCE(SUM(annual_revenue),0) AS total_revenue
       FROM accounts
       WHERE (deleted_at IS NULL)
         AND ($1::int IS NULL OR company_id = $1)`,
      [cid]
    );
    res.json(rows[0] || {});
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Account search for combobox autocomplete ──────────────────────────────────
router.get('/accounts/search', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const srch = (req.query.q || '').trim();
    const cid  = companyOf(req);
    const { rows } = await pool.query(
      `SELECT id,
              COALESCE(name, account_name) AS name,
              industry, account_type AS type
       FROM accounts
       WHERE (deleted_at IS NULL)
         AND ($1::int IS NULL OR company_id = $1)
         AND ($2 = '' OR COALESCE(name, account_name) ILIKE '%' || $2 || '%')
       ORDER BY COALESCE(name, account_name) ASC LIMIT 10`,
      [cid, srch]
    );
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/accounts/:id', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: accRows } = await pool.query(
      `SELECT a.*, COALESCE(a.name, a.account_name) AS name
       FROM accounts a
       WHERE a.id = $1 AND (a.deleted_at IS NULL)
         AND ($2::int IS NULL OR a.company_id = $2)`,
      [req.params.id, cid]
    );
    if (!accRows[0]) return res.status(404).json({ error: 'Account not found' });

    const [contactsRes, oppsRes, activitiesRes] = await Promise.allSettled([
      pool.query(`SELECT * FROM contacts WHERE account_id=$1 AND (deleted_at IS NULL) ORDER BY created_at DESC`, [req.params.id]),
      pool.query(`SELECT * FROM opportunities WHERE account_id=$1 AND (deleted_at IS NULL) ORDER BY created_at DESC`, [req.params.id]),
      pool.query(`SELECT * FROM crm_activities WHERE account_id=$1 ORDER BY created_at DESC LIMIT 30`, [req.params.id]).catch(() => ({ rows: [] })),
    ]);

    res.json({
      account:       accRows[0],
      contacts:      contactsRes.status === 'fulfilled'   ? contactsRes.value.rows   : [],
      opportunities: oppsRes.status === 'fulfilled'       ? oppsRes.value.rows       : [],
      activities:    activitiesRes.status === 'fulfilled' ? activitiesRes.value.rows : [],
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/accounts', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, industry, website, phone, email, city, account_type, annual_revenue, employee_count, status } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Account name is required' });

    if (cid) {
      const dup = await pool.query(
        `SELECT id FROM accounts WHERE company_id=$1
           AND LOWER(COALESCE(name,account_name))=LOWER($2)
           AND deleted_at IS NULL LIMIT 1`,
        [cid, name.trim()]
      );
      if (dup.rowCount > 0) return res.status(409).json({ error: 'An account with this name already exists' });
    }

    const { rows } = await pool.query(
      `INSERT INTO accounts
         (name, account_name, industry, website, phone, email,
          account_type, annual_revenue, employees_count, status, company_id)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *, COALESCE(name, account_name) AS name`,
      [name.trim(), industry||null, website||null, phone||null,
       email||null, account_type||'Customer',
       annual_revenue||null, employee_count||null, status||'Active', cid]
    );
    res.status(201).json(rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/accounts/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { name, industry, website, phone, email, city, account_type, annual_revenue, employee_count, status } = req.body;
    const { rows } = await pool.query(
      `UPDATE accounts
       SET name=$1, account_name=$1, industry=$2, website=$3, phone=$4,
           email=$5, account_type=$6, annual_revenue=$7,
           employees_count=$8, status=$9, updated_at=NOW()
       WHERE id=$10 AND (deleted_at IS NULL)
         AND ($11::int IS NULL OR company_id=$11)
       RETURNING *, COALESCE(name, account_name) AS name`,
      [name||null, industry||null, website||null, phone||null,
       email||null, account_type||null,
       annual_revenue||null, employee_count||null,
       status||null, req.params.id, cid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.json(rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/accounts/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: deps } = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM contacts      WHERE account_id=$1 AND deleted_at IS NULL) AS contacts,
         (SELECT COUNT(*) FROM opportunities WHERE account_id=$1 AND deleted_at IS NULL) AS opps`,
      [req.params.id]
    );
    if (parseInt(deps[0]?.contacts) > 0 || parseInt(deps[0]?.opps) > 0) {
      return res.status(409).json({ error: 'Remove all contacts and opportunities before deleting this account' });
    }
    await pool.query(
      `UPDATE accounts SET deleted_at=NOW() WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    res.json({ message: 'Account deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Contacts ──────────────────────────────────────────────────────────────────
router.get('/contacts', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid    = companyOf(req);
    const search = (req.query.search || '').trim();
    const params = [cid, req.query.account_id || null, search];

    const { rows } = await pool.query(
      `SELECT
         c.id, c.first_name, c.last_name, c.title,
         c.designation, c.department, c.email, c.phone, c.mobile,
         c.linkedin, c.notes, c.is_primary, c.account_id, c.created_at,
         COALESCE(a.name, a.account_name) AS account_name
       FROM contacts c
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE c.deleted_at IS NULL
         AND ($1::int IS NULL OR c.company_id = $1)
         AND ($2::int IS NULL OR c.account_id = $2::int)
         AND ($3 = '' OR
              c.first_name  ILIKE '%' || $3 || '%' OR
              c.last_name   ILIKE '%' || $3 || '%' OR
              c.email       ILIKE '%' || $3 || '%' OR
              COALESCE(a.name, a.account_name) ILIKE '%' || $3 || '%')
       ORDER BY c.first_name ASC, c.last_name ASC`,
      params
    );
    res.json({ contacts: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/contacts/stats', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                                      AS total,
         COUNT(*) FILTER (WHERE is_primary = true)    AS primary_contacts,
         COUNT(DISTINCT account_id)
           FILTER (WHERE account_id IS NOT NULL)       AS accounts_with_contacts
       FROM contacts
       WHERE deleted_at IS NULL
         AND ($1::int IS NULL OR company_id = $1)`,
      [cid]
    );
    res.json(rows[0] || {});
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/contacts/:id', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT c.*,
              COALESCE(a.name, a.account_name) AS account_name
       FROM contacts c
       LEFT JOIN accounts a ON a.id = c.account_id
       WHERE c.id = $1 AND c.deleted_at IS NULL
         AND ($2::int IS NULL OR c.company_id = $2)`,
      [req.params.id, cid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/contacts', requirePermission('crm', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const cid = companyOf(req);
    const {
      first_name, last_name, title, designation, department,
      email, phone, mobile, linkedin, notes, account_id, is_primary,
    } = req.body;

    if (!first_name?.trim()) return res.status(400).json({ error: 'first_name is required' });

    await client.query('BEGIN');

    if (is_primary && account_id) {
      await client.query(
        `UPDATE contacts SET is_primary = false
         WHERE account_id = $1 AND company_id IS NOT DISTINCT FROM $2 AND deleted_at IS NULL`,
        [account_id, cid]
      );
    }

    const full = `${first_name.trim()} ${(last_name || '').trim()}`.trim();
    const { rows } = await client.query(
      `INSERT INTO contacts
         (first_name, last_name, title, full_name, designation, department,
          email, phone, mobile, linkedin, notes, account_id, is_primary, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        first_name.trim(), (last_name || '').trim(), title || null, full,
        designation || null, department || null,
        email || null, phone || null, mobile || null,
        linkedin || null, notes || null,
        account_id || null, is_primary ?? false, cid,
      ]
    );
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally { client.release(); }
});

router.put('/contacts/:id', requirePermission('crm', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const cid = companyOf(req);
    const {
      first_name, last_name, title, designation, department,
      email, phone, mobile, linkedin, notes, account_id, is_primary,
    } = req.body;

    await client.query('BEGIN');

    if (is_primary && account_id) {
      await client.query(
        `UPDATE contacts SET is_primary = false
         WHERE account_id = $1 AND id <> $2
           AND company_id IS NOT DISTINCT FROM $3 AND deleted_at IS NULL`,
        [account_id, req.params.id, cid]
      );
    }

    const full = `${(first_name || '').trim()} ${(last_name || '').trim()}`.trim();
    const { rows } = await client.query(
      `UPDATE contacts
       SET first_name=$1, last_name=$2, title=$3, full_name=$4,
           designation=$5, department=$6, email=$7, phone=$8,
           mobile=$9, linkedin=$10, notes=$11,
           account_id=$12, is_primary=$13, updated_at=NOW()
       WHERE id=$14 AND deleted_at IS NULL
         AND ($15::int IS NULL OR company_id=$15)
       RETURNING *`,
      [
        (first_name || '').trim(), (last_name || '').trim(),
        title || null, full,
        designation || null, department || null,
        email || null, phone || null, mobile || null,
        linkedin || null, notes || null,
        account_id || null, is_primary ?? false,
        req.params.id, cid,
      ]
    );
    await client.query('COMMIT');
    if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
    res.json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally { client.release(); }
});

router.delete('/contacts/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const cid = companyOf(req);
    await pool.query(
      `UPDATE contacts SET deleted_at=NOW()
       WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, cid]
    );
    res.json({ message: 'Contact deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Leads ─────────────────────────────────────────────────────────────────────

router.get('/leads/stats', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const stats = await leadsRepository.getStats(companyOf(req));
    res.json({ data: stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leads', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const leads = await leadsRepository.findAll({
      ...req.query,
      company_id: companyOf(req),
    });
    res.json(leads);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// IEM summary matrix — Count / Value / Estimate per bucket, plus conversion rate.
// Registered above '/leads/:id': Express matches in registration order, so any
// literal /leads/<word> route declared after the :id route is dead. That is
// exactly what had happened to /leads/export (see below).
router.get('/leads/summary', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const summary = await leadsRepository.getSummary(
      companyOf(req),
      { assigned_to: req.query.assigned_to, fy: req.query.fy }
    );
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Filter dropdown options for the IEM toolbar: owners, partners, zones, FYs.
// Only values that actually occur on an enquiry — an "all employees" list would
// let the user pick a name that filters the grid to empty.
router.get('/leads/filters', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);

    const [users, partners, zones, years] = await Promise.all([
      pool.query(
        `SELECT DISTINCT e.id, e.name
           FROM leads l
           JOIN employees e ON e.id = COALESCE(l.assigned_to, l.owner_id)
          WHERE l.deleted_at IS NULL
            AND ($1::int IS NULL OR l.company_id = $1)
            AND e.name IS NOT NULL
          ORDER BY e.name`, [cid]),
      // Partners are listed from the IPU master, not from what leads reference,
      // so a freshly created partner is selectable before it has any enquiry.
      // sales_partners is soft-deleted (migration 20260717000004), so an archived
      // partner must be excluded or it reappears in the filter.
      pool.query(
        `SELECT id, name, ipu_number FROM sales_partners
          WHERE ($1::int IS NULL OR company_id = $1)
            AND deleted_at IS NULL
            AND LOWER(COALESCE(status, 'active')) = 'active'
          ORDER BY name`, [cid]),
      pool.query(
        `SELECT DISTINCT zone FROM leads
          WHERE deleted_at IS NULL AND zone IS NOT NULL AND TRIM(zone) <> ''
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY zone`, [cid]),
      pool.query(
        `SELECT DISTINCT
                CASE WHEN EXTRACT(MONTH FROM created_at) >= 4
                     THEN EXTRACT(YEAR FROM created_at)::int
                     ELSE EXTRACT(YEAR FROM created_at)::int - 1 END AS fy
           FROM leads
          WHERE deleted_at IS NULL
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY fy DESC`, [cid]),
    ]);

    res.json({
      users:    users.rows,
      partners: partners.rows,
      zones:    zones.rows.map(r => r.zone),
      fiscal_years: years.rows.map(r => ({
        value: r.fy,
        label: `FY ${r.fy}-${String((r.fy + 1) % 100).padStart(2, '0')}`,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// IEM grid export. Honours the same filters as the grid.
//
// This replaces the /leads/export handler that used to sit ~1300 lines below,
// after '/leads/:id'. Because Express matches routes in registration order, that
// one was unreachable: GET /leads/export resolved to findById('export'), which
// returned 404 "Lead not found" (or 500 on the int cast). It was dead the day it
// was written, which is why the Leads grid never had an export button.
router.get('/leads/export', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const rows = await leadsRepository.findAll({
      ...req.query,
      company_id: companyOf(req),
    });

    const d = v => (v ? new Date(v).toISOString().split('T')[0] : '');
    const data = rows.map(r => ({
      'IEM No':      r.iem_no || '',
      Customer:      r.company_name || '',
      Partner:       r.partner_name || '',
      Contact:       r.contact_person || '',
      'Source Type': r.lead_source || '',
      Phone:         r.phone || '',
      Email:         r.email || '',
      Zone:          r.zone || '',
      Status:        r.status || '',
      'Probability %': r.probability ?? '',
      'Value (₹)':   Number(r.lead_value || 0),
      'Estimate (₹)': Number(r.estimated_value || 0),
      Owner:         r.assigned_to_name || '',
      'Created On':  d(r.created_at),
    }));
    const totalValue = rows.reduce((s, r) => s + (parseFloat(r.lead_value) || 0), 0);
    const totalEst   = rows.reduce((s, r) => s + (parseFloat(r.estimated_value) || 0), 0);
    data.push({
      'IEM No': '', Customer: '', Partner: '', Contact: '', 'Source Type': '',
      Phone: '', Email: '', Zone: '', Status: 'TOTAL', 'Probability %': '',
      'Value (₹)': totalValue, 'Estimate (₹)': totalEst, Owner: '', 'Created On': '',
    });

    const XLSX = (await import('xlsx')).default;
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'IEM Enquiries');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="iem_enquiries_${Date.now()}.xlsx"`);
    res.send(buf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leads/:id', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const lead = await leadsRepository.findById(req.params.id, companyOf(req));
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const userId     = req.user?.userId ?? req.user?.id;
    const company_id = companyOf(req);

    // 409 on duplicate email within the same company
    if (req.body.email && company_id) {
      const dup = await pool.query(
        `SELECT id FROM leads
         WHERE company_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1`,
        [company_id, req.body.email]
      );
      if (dup.rowCount > 0) {
        return res.status(409).json({ error: 'A lead with this email already exists.' });
      }
    }

    // Load CRM settings to check automation flags
    let crmSettings = {};
    if (company_id) {
      try {
        const sr = await pool.query(
          `SELECT auto_assign_owner, auto_score_on_create, lead_assignment_method
           FROM crm_settings WHERE company_id = $1`,
          [company_id]
        );
        crmSettings = sr.rows[0] || {};
      } catch (_) {}
    }

    // Auto-assign via assignment rules when auto_assign_owner is enabled
    let assignedTo = req.body.assigned_to || userId;
    if (crmSettings.auto_assign_owner && crmSettings.lead_assignment_method === 'round_robin' && company_id) {
      try {
        const rules = await pool.query(
          `SELECT * FROM crm_assignment_rules
           WHERE company_id = $1 AND is_active = true ORDER BY priority ASC`,
          [company_id]
        );
        for (const rule of rules.rows) {
          const fieldVal = (req.body[rule.condition_field] || '').toString().toLowerCase();
          if (fieldVal === (rule.condition_value || '').toLowerCase()) {
            // Find employee by name match
            const emp = await pool.query(
              `SELECT id FROM employees WHERE LOWER(name) = LOWER($1) AND company_id = $2
               AND LOWER(status) IN ('active','probation') LIMIT 1`,
              [rule.assign_to_name, company_id]
            );
            if (emp.rowCount > 0) { assignedTo = emp.rows[0].id; break; }
          }
        }
      } catch (_) {}
    }

    // Compute lead score from scoring rules when auto_score_on_create is enabled
    let lead_score = parseInt(req.body.lead_score) || 0;
    if (crmSettings.auto_score_on_create && company_id) {
      try {
        const scoringRules = await pool.query(
          `SELECT * FROM crm_lead_scoring_rules WHERE company_id = $1 AND is_active = true`,
          [company_id]
        );
        for (const rule of scoringRules.rows) {
          const fieldVal = (req.body[rule.field] || '').toString().toLowerCase();
          const ruleVal  = (rule.value || '').toString().toLowerCase();
          let match = false;
          if (rule.operator === 'equals')       match = fieldVal === ruleVal;
          else if (rule.operator === 'contains') match = fieldVal.includes(ruleVal);
          else if (rule.operator === 'not_empty') match = fieldVal.length > 0;
          if (match) lead_score = Math.max(0, Math.min(100, lead_score + (parseInt(rule.score_delta) || 0)));
        }
      } catch (_) {}
    }

    const lead = await leadsRepository.create({
      ...req.body,
      lead_score,
      created_by:  userId,
      company_id,
      assigned_to: assignedTo,
    });
    res.status(201).json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/leads/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const lead = await leadsRepository.update(req.params.id, req.body);
    res.json(lead);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/leads/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    await leadsRepository.delete(req.params.id);
    res.json({ message: 'Lead deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /leads/:id/assign — re-assign owner (managers/admins only)
router.patch('/leads/:id/assign', allowRoles('manager', 'admin', 'super_admin', 'hr'), async (req, res) => {
  try {
    const { owner_id } = req.body;
    if (!owner_id) return res.status(400).json({ error: 'owner_id required' });
    const result = await pool.query(
      `UPDATE leads SET assigned_to = $1, updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
      [owner_id, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Lead not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH /leads/:id/score — manual score override
router.patch('/leads/:id/score', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const score = parseInt(req.body.lead_score);
    if (isNaN(score) || score < 0 || score > 100) {
      return res.status(400).json({ error: 'lead_score must be 0–100' });
    }
    const result = await pool.query(
      `UPDATE leads SET lead_score = $1, updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
      [score, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Lead not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /leads/bulk-assign — bulk re-assign multiple leads
router.post('/leads/bulk-assign', allowRoles('manager', 'admin', 'super_admin', 'hr'), async (req, res) => {
  try {
    const { lead_ids, owner_id } = req.body;
    if (!Array.isArray(lead_ids) || !lead_ids.length || !owner_id) {
      return res.status(400).json({ error: 'lead_ids (array) and owner_id required' });
    }
    const company_id = companyOf(req);
    await pool.query(
      `UPDATE leads SET assigned_to = $1, updated_at = NOW()
       WHERE id = ANY($2::int[])
         AND deleted_at IS NULL
         AND ($3::int IS NULL OR company_id = $3)`,
      [owner_id, lead_ids, company_id]
    );
    res.json({ updated: lead_ids.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /leads/import — CSV import with duplicate detection
router.post('/leads/import', requirePermission('crm', 'add'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required (field: file)' });

    const userId     = req.user?.userId ?? req.user?.id;
    const company_id = companyOf(req);
    const text       = req.file.buffer.toString('utf8');

    // Minimal CSV parser (handles quoted fields)
    const parseCSV = (raw) => {
      const lines = raw.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) return [];
      const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
      return lines.slice(1).map(line => {
        const vals = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
        return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
      });
    };

    const rows = parseCSV(text);
    let imported = 0;
    let skipped  = 0;
    const errors = [];

    for (const row of rows) {
      const email = row.email?.trim();
      try {
        // Skip duplicates within this company
        if (email && company_id) {
          const dup = await pool.query(
            `SELECT id FROM leads WHERE company_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1`,
            [company_id, email]
          );
          if (dup.rowCount > 0) { skipped++; continue; }
        }

        await leadsRepository.create({
          company_name:   row.company_name   || row.company   || '',
          contact_person: row.contact_name   || row.contact   || '',
          email:          email || null,
          phone:          row.phone          || null,
          lead_source:    row.source         || row.lead_source || 'Manual',
          industry:       row.industry       || null,
          location:       row.city           || row.location  || null,
          lead_score:     parseInt(row.lead_score) || 0,
          status:         row.status         || 'New',
          created_by:     userId,
          company_id,
          assigned_to:    userId,
        });
        imported++;
      } catch (err) {
        skipped++;
        errors.push({ row: row.company_name || email, error: err.message });
      }
    }

    res.json({ imported, skipped, errors: errors.slice(0, 10) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/leads/:id/activities', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const activities = await leadsRepository.getActivities(req.params.id);
    res.json(activities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/leads/:id/activities', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const activity = await leadsRepository.addActivity({
      ...req.body,
      lead_id: req.params.id,
      // employee_id, not userId: lead_activities.created_by FKs employees (which is
      // what getActivities has always joined). Passing a users.id here is the
      // stock_ledger.created_by bug. NULL for logins with no linked employee.
      created_by: req.user?.employee_id ?? null,
    });
    if (!activity) return res.status(404).json({ error: 'Lead not found' });
    res.status(201).json(activity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /leads/:id/convert — atomic lead-to-opportunity conversion
// Runs in a single transaction: validates lead, prevents duplicate conversion,
// creates opportunity, marks lead converted, writes activity history.
router.post('/leads/:id/convert', requirePermission('crm', 'add'), async (req, res) => {
  const leadId = req.params.id;
  const userId = req.user?.userId ?? req.user?.id;
  const {
    opportunity_name,
    expected_value,
    probability_percentage,
    expected_closing_date,
    stage = 'Qualification',
    assigned_to,
  } = req.body;

  if (!opportunity_name || !opportunity_name.trim()) {
    return res.status(400).json({ error: 'opportunity_name is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the lead row to prevent concurrent double-conversion
    const leadRes = await client.query(
      'SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [leadId]
    );
    if (leadRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found' });
    }
    const lead = leadRes.rows[0];
    if ((lead.status || '').toLowerCase() === 'converted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Lead has already been converted to an opportunity' });
    }

    // Prevent duplicate opportunities for the same lead
    const dupRes = await client.query(
      'SELECT id FROM opportunities WHERE lead_id = $1 AND deleted_at IS NULL LIMIT 1',
      [leadId]
    );
    if (dupRes.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'An opportunity already exists for this lead',
        opportunity_id: dupRes.rows[0].id,
      });
    }

    // Carry the enquiry forward rather than making the user retype it. Anything
    // the caller supplied wins; otherwise the value already captured on the IEM
    // is inherited. Previously only lead_id/company_id crossed this boundary, so
    // an enquiry with a value and a zone produced an opportunity with neither.
    //
    // zone -> region matters most: opportunities.region was left NULL on every
    // converted enquiry, which silently broke regional reporting downstream of IPM.
    const value = expected_value === undefined || expected_value === null || expected_value === ''
      ? (lead.estimated_value != null ? parseFloat(lead.estimated_value) : null)
      : parseFloat(expected_value);
    if (value == null || Number.isNaN(value)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'expected_value is required — this enquiry has no estimated value to carry forward',
      });
    }

    const prob = probability_percentage === undefined || probability_percentage === null || probability_percentage === ''
      ? (lead.probability ?? 50)
      : parseInt(probability_percentage, 10);

    // Create the opportunity — inherit company_id from the lead
    const oppRes = await client.query(
      `INSERT INTO opportunities
         (lead_id, opportunity_name, expected_value, probability_percentage,
          expected_closing_date, stage, assigned_to, created_by, company_id,
          region, notes, estimate_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        leadId,
        opportunity_name.trim(),
        value,
        Math.min(100, Math.max(0, Number.isNaN(prob) ? 50 : prob)),
        expected_closing_date || null,
        stage || 'Qualification',
        assigned_to || lead.assigned_to || null,
        userId,
        lead.company_id || null,
        lead.zone || null,
        lead.notes || null,
        // The enquiry's original estimate, preserved alongside the (possibly
        // revalued) expected_value so the IEM summary can show the spread.
        lead.estimated_value ?? null,
      ]
    );
    const opportunity = oppRes.rows[0];

    // Mark lead as converted
    const updatedLeadRes = await client.query(
      `UPDATE leads SET status = 'converted', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [leadId]
    );

    // Write immutable activity history for the conversion.
    // created_by is the actor's EMPLOYEE id — the column FKs employees, and
    // passing req.user.userId here would be the stock_ledger.created_by bug.
    // company_id is derived from the lead so it can never be NULL.
    await client.query(
      `INSERT INTO lead_activities
         (lead_id, company_id, activity_type, activity_date, notes, created_by)
       VALUES ($1, $2, 'conversion', NOW(), $3, $4)`,
      [
        leadId,
        lead.company_id || null,
        `Converted to opportunity: "${opportunity_name.trim()}"`,
        req.user?.employee_id ?? null,
      ]
    );

    await client.query('COMMIT');

    logAudit({ userId, module: 'CRM', recordId: leadId, recordType: 'lead', action: 'convert', newData: { opportunity_id: opportunity.id }, req });
    const assignedUserId = opportunity.assigned_to || null;
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('submitted', { module: 'CRM', recordId: opportunity.id, submitterId: userId, recipientIds: assignedUserId ? [assignedUserId] : [] }).catch(() => {});
    }).catch(() => {});

    res.status(201).json({
      opportunity,
      lead: updatedLeadRes.rows[0],
      message: 'Lead successfully converted to opportunity',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Opportunities
router.get('/opportunities', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const opportunities = await opportunitiesRepository.findAll({ ...req.query, company_id: companyOf(req) });
    res.json(opportunities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/opportunities/kanban', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const board = await opportunitiesRepository.getKanbanBoard(companyOf(req));
    res.json(board);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/opportunities/stats', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const params = cid != null ? [cid] : [];
    const cidClause = cid != null ? 'AND company_id = $1' : '';
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                                        AS total,
        COALESCE(SUM(expected_value), 0)                                               AS total_value,
        COUNT(*) FILTER (WHERE LOWER(stage) = 'won')                                   AS won_count,
        COALESCE(SUM(expected_value) FILTER (WHERE LOWER(stage) = 'won'), 0)           AS won_value,
        COUNT(*) FILTER (WHERE LOWER(stage) = 'lost')                                  AS lost_count,
        COUNT(*) FILTER (
          WHERE expected_closing_date < CURRENT_DATE
            AND LOWER(stage) NOT IN ('won','lost')
        )                                                                               AS overdue_count,
        COALESCE(AVG(expected_value) FILTER (
          WHERE LOWER(stage) NOT IN ('won','lost')
        ), 0)                                                                           AS avg_deal_size,
        ROUND(
          COUNT(*) FILTER (WHERE LOWER(stage) = 'won')::numeric /
          NULLIF(COUNT(*) FILTER (WHERE LOWER(stage) IN ('won','lost')), 0) * 100, 1
        )                                                                               AS win_rate
      FROM opportunities
      WHERE deleted_at IS NULL ${cidClause}
    `, params);
    const r = rows[0];
    res.json({
      total:         parseInt(r.total)          || 0,
      total_value:   parseFloat(r.total_value)  || 0,
      won_count:     parseInt(r.won_count)       || 0,
      won_value:     parseFloat(r.won_value)     || 0,
      lost_count:    parseInt(r.lost_count)      || 0,
      overdue_count: parseInt(r.overdue_count)   || 0,
      avg_deal_size: parseFloat(r.avg_deal_size) || 0,
      win_rate:      parseFloat(r.win_rate)      || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/opportunities/win-loss', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const params = companyId != null ? [companyId] : [];
    const cw = companyId != null ? 'AND company_id = $1' : '';

    const summaryResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE LOWER(stage) IN ('won','lost'))                AS total,
        COUNT(*) FILTER (WHERE LOWER(stage) = 'won')                          AS won,
        COUNT(*) FILTER (WHERE LOWER(stage) = 'lost')                         AS lost,
        COALESCE(AVG(expected_value) FILTER (WHERE LOWER(stage) = 'won'), 0)  AS avg_deal_size,
        COALESCE(AVG(EXTRACT(EPOCH FROM (closed_date - created_at)) / 86400)
          FILTER (WHERE LOWER(stage) = 'won' AND closed_date IS NOT NULL), 0) AS avg_cycle_days
      FROM opportunities
      WHERE deleted_at IS NULL ${cw}
    `, params);
    const s = summaryResult.rows[0];

    const lossResult = await pool.query(`
      SELECT COALESCE(notes, 'Other') AS reason, COUNT(*) AS count
      FROM opportunity_stage_history
      WHERE LOWER(to_stage) = 'lost' ${cw ? 'AND company_id = $1' : ''}
      GROUP BY COALESCE(notes, 'Other') ORDER BY count DESC LIMIT 20
    `, params).catch(() => ({ rows: [] }));
    const totalLost = parseInt(s.lost) || 1;
    const loss_reasons = lossResult.rows.map(r => ({
      reason: r.reason, count: parseInt(r.count),
      pct: parseFloat(((parseInt(r.count) / totalLost) * 100).toFixed(1)),
    }));

    const monthlyResult = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(closed_date, updated_at)), 'Mon YYYY') AS month,
             DATE_TRUNC('month', COALESCE(closed_date, updated_at)) AS month_start,
             COUNT(*) FILTER (WHERE LOWER(stage) = 'won')  AS won,
             COUNT(*) FILTER (WHERE LOWER(stage) = 'lost') AS lost
      FROM opportunities
      WHERE deleted_at IS NULL AND LOWER(stage) IN ('won','lost')
        AND COALESCE(closed_date, updated_at) >= NOW() - INTERVAL '12 months' ${cw}
      GROUP BY DATE_TRUNC('month', COALESCE(closed_date, updated_at))
      ORDER BY month_start ASC
    `, params).catch(() => ({ rows: [] }));
    const monthly = monthlyResult.rows.map(r => {
      const won = parseInt(r.won) || 0; const lost = parseInt(r.lost) || 0;
      const total = won + lost;
      return { month: r.month, won, lost, rate: total > 0 ? parseFloat(((won / total) * 100).toFixed(1)) : 0 };
    });

    res.json({
      summary: {
        total: parseInt(s.total) || 0, won: parseInt(s.won) || 0, lost: parseInt(s.lost) || 0,
        avg_deal_size: parseFloat(s.avg_deal_size) || 0,
        avg_cycle_days: parseFloat(s.avg_cycle_days) || 0,
        win_rate: parseInt(s.total) > 0 ? parseFloat(((parseInt(s.won) / parseInt(s.total)) * 100).toFixed(1)) : 0,
      },
      loss_reasons,
      monthly,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/opportunities/:id', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const opportunity = await opportunitiesRepository.findById(req.params.id, companyOf(req));
    if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });
    res.json(opportunity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/opportunities', requirePermission('crm', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { lead_id, opportunity_name, expected_value, probability_percentage, expected_closing_date, stage, assigned_to, notes, estimate_value, held_by, follow_up_date } = req.body;
    const userId     = req.user?.userId ?? req.user?.id;
    const company_id = companyOf(req);

    // Validate require_close_date setting
    if (company_id && !expected_closing_date) {
      try {
        const sr = await pool.query(
          `SELECT required_fields_to_close FROM crm_settings WHERE company_id = $1`,
          [company_id]
        );
        const required = sr.rows[0]?.required_fields_to_close || [];
        if (Array.isArray(required) && required.includes('expected_close_date')) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Expected closing date is required (configured in CRM settings)' });
        }
      } catch (_) {}
    }

    // Prevent duplicate opportunities for the same lead when lead_id is supplied
    if (lead_id) {
      const dup = await client.query(
        `SELECT id FROM opportunities WHERE lead_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [lead_id]
      );
      if (dup.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'An opportunity already exists for this lead',
          opportunity_id: dup.rows[0].id,
        });
      }
    }

    const oppRes = await client.query(
      `INSERT INTO opportunities
         (lead_id, opportunity_name, expected_value, probability_percentage,
          expected_closing_date, stage, assigned_to, notes, created_by, company_id,
          estimate_value, held_by, follow_up_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [lead_id || null, opportunity_name, expected_value, probability_percentage,
       expected_closing_date || null, stage, assigned_to || userId, notes || null, userId, company_id,
       estimate_value === '' || estimate_value == null ? null : estimate_value,
       held_by || null, follow_up_date || null]
    );
    const opportunity = oppRes.rows[0];

    // Atomically mark the lead converted if linked
    if (lead_id) {
      await client.query(
        `UPDATE leads SET status = 'converted', updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL`,
        [lead_id]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(opportunity);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

router.patch('/opportunities/:id/stage', requirePermission('crm', 'edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { stage, notes: stageNotes, close_reason } = req.body;
    if (!stage) return res.status(400).json({ error: 'stage is required' });
    const cid    = companyOf(req);
    const userId = req.user?.userId ?? req.user?.id ?? null;

    await client.query('BEGIN');

    // Fetch current stage for history
    const current = await client.query(
      `SELECT stage FROM opportunities WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    const prevStage = current.rows[0]?.stage || null;

    const params = [stage, req.params.id];
    let extraSet = '';
    const stageLc = stage.toLowerCase();
    if (stageLc === 'won') {
      extraSet = ', closed_date = NOW(), probability_percentage = 100';
    } else if (stageLc === 'lost') {
      extraSet = ', closed_date = NOW(), probability_percentage = 0';
    }
    if (close_reason && (stageLc === 'won' || stageLc === 'lost')) {
      extraSet += `, close_reason = $${params.push(close_reason)}`;
    }
    const cidClause = cid != null ? ` AND company_id = $${params.push(cid)}` : '';

    const { rows } = await client.query(
      `UPDATE opportunities
       SET stage = $1, updated_at = NOW()${extraSet}
       WHERE id = $2 AND deleted_at IS NULL${cidClause}
       RETURNING *`,
      params
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    // Write stage history record
    await client.query(
      `INSERT INTO opportunity_stage_history
         (opportunity_id, company_id, from_stage, to_stage, changed_by, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.params.id, cid, prevStage, stage, userId, stageNotes || null]
    ).catch(() => {}); // graceful — table may not exist until migration runs

    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

router.put('/opportunities/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const opportunity = await opportunitiesRepository.update(req.params.id, req.body);
    res.json(opportunity);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/opportunities/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    await opportunitiesRepository.delete(req.params.id);
    res.json({ message: 'Opportunity deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /opportunities/:id/create-quotation — convert opportunity to quotation
router.post('/opportunities/:id/create-quotation', requirePermission('sales', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cid_val   = companyOf(req);
    const userId    = req.user?.userId ?? req.user?.id ?? null;

    const oppRes = await client.query(
      `SELECT o.*, COALESCE(a.name, a.account_name) AS customer_name
       FROM opportunities o
       LEFT JOIN accounts a ON a.id = o.account_id
       WHERE o.id=$1 AND o.deleted_at IS NULL AND ($2::int IS NULL OR o.company_id=$2)
       FOR UPDATE`,
      [req.params.id, cid_val]
    );
    if (!oppRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Opportunity not found' });
    }
    const opp = oppRes.rows[0];

    // Prevent duplicate quotation creation
    if (opp.quotation_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'A quotation already exists for this opportunity',
        quotation_id: opp.quotation_id,
      });
    }

    // Generate quotation number
    const seqRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM quotations WHERE ($1::int IS NULL OR company_id=$1)`,
      [cid_val]
    );
    const seq = String((seqRes.rows[0]?.n || 0) + 1).padStart(4, '0');
    const yr  = new Date().getFullYear();
    const qNo = `QT-${yr}-${seq}`;

    const validityDate = req.body.validity_date || null;
    const { rows: qRows } = await client.query(
      `INSERT INTO quotations
         (quotation_number, company_id, customer_id, customer_name, opportunity_id,
          quotation_date, validity_date, subtotal, tax_amount, total_amount, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,CURRENT_DATE,$6,$7,0,$7,$8,'draft',$9) RETURNING *`,
      [qNo, cid_val, opp.account_id, opp.customer_name, opp.id,
       validityDate, opp.expected_value || 0,
       req.body.notes || `From opportunity: ${opp.opportunity_name}`,
       userId]
    );

    // Link opportunity → quotation
    await client.query(
      `UPDATE opportunities SET quotation_id=$1, stage='negotiation', updated_at=NOW() WHERE id=$2`,
      [qRows[0].id, opp.id]
    ).catch(() => {});

    await client.query('COMMIT');

    logAudit({ userId, module: 'CRM', recordId: qRows[0].id, recordType: 'quotation', action: 'create', newData: { quotation_number: qRows[0].quotation_number, opportunity_id: opp.id }, req });
    import('../../../services/WorkflowNotificationService.js').then(({ notifyWorkflowEvent }) => {
      notifyWorkflowEvent('submitted', { module: 'CRM', recordId: qRows[0].id, submitterId: userId, recipientIds: [] }).catch(() => {});
    }).catch(() => {});

    res.status(201).json({ quotation: qRows[0], opportunity_id: opp.id });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Stats summary for CRM dashboard
router.get('/stats', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const cp  = cid != null ? [cid] : [];
    const cw  = cid != null ? 'AND company_id = $1' : '';

    const [leadsRow, oppsRow, thisMonthRow, acctRow, contactRow, prevMonthRow] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS total_leads,
           COUNT(*) FILTER (WHERE LOWER(status) = 'converted') AS converted_leads
         FROM leads WHERE deleted_at IS NULL ${cw}`,
        cp
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE LOWER(stage) = 'won') AS won_deals,
           COALESCE(SUM(expected_value) FILTER (WHERE LOWER(stage) NOT IN ('won','lost')), 0) AS pipeline_value,
           COALESCE(SUM(expected_value) FILTER (
             WHERE LOWER(stage) NOT IN ('won','lost')
               AND created_at >= DATE_TRUNC('month', NOW())
           ), 0) AS pipeline_this_month
         FROM opportunities WHERE deleted_at IS NULL ${cw}`,
        cp
      ),
      pool.query(
        `SELECT COUNT(*) AS leads_this_month
         FROM leads WHERE deleted_at IS NULL ${cw}
           AND created_at >= DATE_TRUNC('month', NOW())`,
        cp
      ),
      pool.query(
        `SELECT COUNT(*) AS total_accounts FROM accounts WHERE deleted_at IS NULL ${cw}`,
        cp
      ),
      pool.query(
        `SELECT COUNT(*) AS total_contacts FROM contacts WHERE deleted_at IS NULL ${cw}`,
        cp
      ),
      pool.query(
        `SELECT COALESCE(SUM(expected_value) FILTER (
           WHERE LOWER(stage) NOT IN ('won','lost')
             AND created_at >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
             AND created_at <  DATE_TRUNC('month', NOW())
         ), 0) AS pipeline_prev_month
         FROM opportunities WHERE deleted_at IS NULL ${cw}`,
        cp
      ),
    ]);

    const totalLeads        = parseInt(leadsRow.rows[0].total_leads)          || 0;
    const convertedLeads    = parseInt(leadsRow.rows[0].converted_leads)      || 0;
    const wonDeals          = parseInt(oppsRow.rows[0].won_deals)             || 0;
    const pipelineValue     = parseFloat(oppsRow.rows[0].pipeline_value)      || 0;
    const pipelineThisMonth = parseFloat(oppsRow.rows[0].pipeline_this_month) || 0;
    const pipelinePrevMonth = parseFloat(prevMonthRow.rows[0].pipeline_prev_month) || 0;
    const convRate = totalLeads > 0
      ? parseFloat((convertedLeads / totalLeads * 100).toFixed(1))
      : null;
    const pipelineChange = pipelinePrevMonth > 0
      ? parseFloat(((pipelineThisMonth - pipelinePrevMonth) / pipelinePrevMonth * 100).toFixed(1))
      : null;

    res.json({
      total_leads:      totalLeads,
      leads_this_month: parseInt(thisMonthRow.rows[0].leads_this_month) || 0,
      won_deals:        wonDeals,
      pipeline_value:   pipelineValue,
      conversion_rate:  convRate,
      pipeline_change:  pipelineChange,
      total_accounts:   parseInt(acctRow.rows[0].total_accounts)        || 0,
      total_contacts:   parseInt(contactRow.rows[0].total_contacts)     || 0,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Analytics
router.get('/analytics/leads-by-source', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const data = await leadsRepository.getLeadsBySource(companyOf(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/conversion-rate', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const data = await leadsRepository.getConversionRate(companyOf(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/pipeline-value', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const data = await opportunitiesRepository.getPipelineValue(companyOf(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/analytics/avg-deal-size', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const data = await opportunitiesRepository.getAverageDealSize(companyOf(req));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Lead analytics for the CRM dashboard — every widget in one round trip.
 *
 * Query: ?fy=<FY start year>&assigned_to=<employee id>
 * The financial year runs from crm_settings.fiscal_year_start_month (India: April),
 * so FY 2026 = 01 Apr 2026 → 31 Mar 2027.
 *
 * A lead's value is COALESCE(estimated_value, sum of its linked opportunities, 0):
 * leads captured before `estimated_value` existed still price off their opportunity.
 */
router.get('/analytics/lead-dashboard', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);

    let fyStartMonth = 4;
    if (cid != null) {
      const { rows } = await pool
        .query('SELECT fiscal_year_start_month FROM crm_settings WHERE company_id = $1', [cid])
        .catch(() => ({ rows: [] }));
      const m = parseInt(rows[0]?.fiscal_year_start_month, 10);
      if (m >= 1 && m <= 12) fyStartMonth = m;
    }

    const now = new Date();
    const currentFy = (now.getMonth() + 1) >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;

    // Financial years that actually carry pipeline, newest first. Drives the
    // selector, and picks the default: the current FY when it has data, else the
    // most recent FY that does — otherwise the dashboard opens blank whenever the
    // FY has just rolled over.
    const { rows: fyRows } = await pool.query(
      `SELECT DISTINCT
              EXTRACT(YEAR FROM (d - make_interval(months => $2::int - 1)))::int AS fy
         FROM (
           SELECT created_at::date AS d FROM leads
            WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
           UNION ALL
           SELECT created_at::date FROM opportunities
            WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
         ) x
        ORDER BY 1 DESC`,
      [cid, fyStartMonth]
    ).catch(() => ({ rows: [] }));

    const fyOptions = fyRows.map(r => r.fy);

    const fyRaw = parseInt(req.query.fy, 10);
    const fy = fyRaw >= 1990 && fyRaw <= 2999
      ? fyRaw
      : (fyOptions.includes(currentFy) ? currentFy : (fyOptions[0] ?? currentFy));

    let assignedTo = null;
    if (req.query.assigned_to) {
      if (!/^\d+$/.test(String(req.query.assigned_to))) {
        return res.status(400).json({ error: 'assigned_to must be an employee id' });
      }
      assignedTo = parseInt(req.query.assigned_to, 10);
    }

    const params = [cid, fy, fyStartMonth, assignedTo];

    const { rows } = await pool.query(
      `
      WITH b AS (
        SELECT make_date($2::int, $3::int, 1)                               AS fy_start,
               (make_date($2::int, $3::int, 1) + INTERVAL '1 year')::date   AS fy_end
      ),
      months AS (
        SELECT generate_series(
                 (SELECT fy_start FROM b)::timestamp,
                 (SELECT fy_end   FROM b)::timestamp - INTERVAL '1 day',
                 INTERVAL '1 month'
               )::date AS m
      ),
      lv AS (
        SELECT l.id,
               l.status,
               l.zone,
               l.created_at,
               COALESCE(l.assigned_to, l.owner_id)                          AS owner,
               COALESCE(l.estimated_value, o.opp_value, 0)::numeric         AS lead_value
          FROM leads l
          LEFT JOIN LATERAL (
                 SELECT SUM(o2.expected_value) AS opp_value
                   FROM opportunities o2
                  WHERE o2.lead_id = l.id AND o2.deleted_at IS NULL
               ) o ON TRUE
         WHERE l.deleted_at IS NULL
           AND ($1::int IS NULL OR l.company_id = $1)
           AND l.created_at >= (SELECT fy_start FROM b)
           AND l.created_at <  (SELECT fy_end   FROM b)
           AND ($4::int IS NULL OR COALESCE(l.assigned_to, l.owner_id) = $4::int)
      ),
      opp AS (
        SELECT o.stage, o.expected_value
          FROM opportunities o
         WHERE o.deleted_at IS NULL
           AND ($1::int IS NULL OR o.company_id = $1)
           AND o.created_at >= (SELECT fy_start FROM b)
           AND o.created_at <  (SELECT fy_end   FROM b)
           AND ($4::int IS NULL OR o.assigned_to = $4::int)
      )
      SELECT
        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT s.stage,
                  COUNT(opp.stage)::int                          AS count,
                  COALESCE(SUM(opp.expected_value), 0)::float8   AS value
             FROM (VALUES ('Prospecting',1),('Qualification',2),
                          ('Proposal',3),('Negotiation',4)) AS s(stage, ord)
             LEFT JOIN opp ON LOWER(opp.stage) = LOWER(s.stage)
            GROUP BY s.stage, s.ord
            ORDER BY s.ord
        ) t) AS funnel,

        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT to_char(m.m, 'Mon YY')                         AS month,
                  COUNT(lv.id)::int                              AS count,
                  COALESCE(SUM(lv.lead_value), 0)::float8        AS value
             FROM months m
             LEFT JOIN lv ON date_trunc('month', lv.created_at)::date = m.m
            GROUP BY m.m
            ORDER BY m.m
        ) t) AS monthly,

        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT COALESCE(e.name, 'Unassigned')                 AS name,
                  COUNT(lv.id)::int                              AS count,
                  COALESCE(SUM(lv.lead_value), 0)::float8        AS value
             FROM lv
             LEFT JOIN employees e ON e.id = lv.owner
            GROUP BY COALESCE(e.name, 'Unassigned')
            ORDER BY 2 DESC
            LIMIT 12
        ) t) AS by_user,

        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT to_char(m.m, 'Mon YY') AS month,
                  COUNT(lv.id) FILTER (WHERE LOWER(lv.status) IN ('converted','won'))::int        AS won_count,
                  COUNT(lv.id) FILTER (WHERE LOWER(lv.status) IN ('lost','unqualified'))::int     AS lost_count,
                  COALESCE(SUM(lv.lead_value) FILTER (WHERE LOWER(lv.status) IN ('converted','won')), 0)::float8    AS won_value,
                  COALESCE(SUM(lv.lead_value) FILTER (WHERE LOWER(lv.status) IN ('lost','unqualified')), 0)::float8 AS lost_value
             FROM months m
             LEFT JOIN lv ON date_trunc('month', lv.created_at)::date = m.m
            GROUP BY m.m
            ORDER BY m.m
        ) t) AS won_lost,

        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT r.bucket,
                  COUNT(lv.id)::int                              AS count,
                  COALESCE(SUM(lv.lead_value), 0)::float8        AS value
             FROM (VALUES ('0-10L',1),('10-25L',2),('25-50L',3),
                          ('50L+',4),('Unvalued',5)) AS r(bucket, ord)
             LEFT JOIN lv ON r.bucket = (CASE
                    WHEN lv.lead_value <= 0       THEN 'Unvalued'
                    WHEN lv.lead_value < 1000000  THEN '0-10L'
                    WHEN lv.lead_value < 2500000  THEN '10-25L'
                    WHEN lv.lead_value < 5000000  THEN '25-50L'
                    ELSE '50L+' END)
            GROUP BY r.bucket, r.ord
            ORDER BY r.ord
        ) t) AS by_range,

        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT COALESCE(NULLIF(TRIM(lv.zone), ''), 'Unassigned') AS zone,
                  COUNT(lv.id)::int                                 AS count,
                  COALESCE(SUM(lv.lead_value), 0)::float8           AS value
             FROM lv
            GROUP BY 1
            ORDER BY 2 DESC
        ) t) AS by_zone,

        -- Enquiry status breakdown. Grouped on the status column as it actually
        -- is rather than against a fixed list, because the live data carries
        -- statuses the UI never offered (Won / Lost / Negotiation) and a fixed
        -- list would silently drop them from the chart.
        (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
           SELECT INITCAP(COALESCE(NULLIF(TRIM(lv.status), ''), 'Unknown')) AS status,
                  COUNT(lv.id)::int                                         AS count,
                  COALESCE(SUM(lv.lead_value), 0)::float8                   AS value
             FROM lv
            GROUP BY 1
            ORDER BY 2 DESC
        ) t) AS by_status
      `,
      params
    );

    // Owners that actually carry pipeline — an "All" list of every employee
    // would be unusable, and a name with no leads filters to an empty dashboard.
    const { rows: owners } = await pool.query(
      `SELECT DISTINCT e.id, e.name
         FROM employees e
        WHERE ($1::int IS NULL OR e.company_id = $1)
          AND LOWER(COALESCE(e.status, 'active')) IN ('active','probation')
          AND (
            EXISTS (SELECT 1 FROM leads l
                     WHERE COALESCE(l.assigned_to, l.owner_id) = e.id
                       AND l.deleted_at IS NULL
                       AND ($1::int IS NULL OR l.company_id = $1))
            OR
            EXISTS (SELECT 1 FROM opportunities o
                     WHERE o.assigned_to = e.id
                       AND o.deleted_at IS NULL
                       AND ($1::int IS NULL OR o.company_id = $1))
          )
        ORDER BY e.name`,
      [cid]
    ).catch(() => ({ rows: [] }));

    const r = rows[0] || {};
    res.json({
      fy,
      current_fy: currentFy,
      fy_options: fyOptions,
      fiscal_year_start_month: fyStartMonth,
      owners,
      funnel:    r.funnel    || [],
      monthly:   r.monthly   || [],
      by_user:   r.by_user   || [],
      won_lost:  r.won_lost  || [],
      by_range:  r.by_range  || [],
      by_zone:   r.by_zone   || [],
      by_status: r.by_status || [],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Marketing dashboard views ─────────────────────────────────────────────────
router.get('/delivery-tracker', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT so.id, so.order_number, so.status, so.total_amount,
              p.name AS customer_name, so.delivery_date, so.created_at
       FROM sales_orders so
       LEFT JOIN parties p ON p.id = so.customer_id
       WHERE ($1::int IS NULL OR so.company_id=$1)
         AND so.status NOT IN ('cancelled')
       ORDER BY so.delivery_date NULLS LAST LIMIT 200`,
      [cid]
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

router.get('/marketing-dashboard', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const [leadRows, campRows] = await Promise.all([
      pool.query(
        `SELECT source, status, COUNT(*) AS count, COALESCE(SUM(estimated_value),0) AS value
         FROM leads WHERE ($1::int IS NULL OR company_id=$1)
         GROUP BY source, status ORDER BY count DESC LIMIT 50`,
        [cid]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT name, status, budget, actual_cost, leads_generated, created_at
         FROM marketing_campaigns WHERE ($1::int IS NULL OR company_id=$1)
         ORDER BY created_at DESC LIMIT 20`,
        [cid]
      ).catch(() => ({ rows: [] })),
    ]);
    res.json({ leads: leadRows.rows, campaigns: campRows.rows });
  } catch { res.json({ leads: [], campaigns: [] }); }
});

router.get('/orders-won-lost', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT o.id, o.opportunity_name AS title, o.stage, o.expected_value AS value,
              o.expected_closing_date, o.closed_date,
              COALESCE(a.name, a.account_name) AS customer_name,
              e.first_name || ' ' || COALESCE(e.last_name,'') AS owner_name
       FROM opportunities o
       LEFT JOIN accounts a  ON a.id = o.account_id AND a.deleted_at IS NULL
       LEFT JOIN employees e ON e.id = o.assigned_to
       WHERE ($1::int IS NULL OR o.company_id=$1)
         AND LOWER(o.stage) IN ('won','lost')
         AND o.deleted_at IS NULL
       ORDER BY o.closed_date DESC NULLS LAST LIMIT 200`,
      [cid]
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

router.get('/pursuit-list', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT o.id, o.opportunity_name AS title, o.stage, o.expected_value AS value,
              o.expected_closing_date, o.probability_percentage,
              COALESCE(a.name, a.account_name) AS customer_name,
              e.first_name || ' ' || COALESCE(e.last_name,'') AS owner_name
       FROM opportunities o
       LEFT JOIN accounts a  ON a.id = o.account_id AND a.deleted_at IS NULL
       LEFT JOIN employees e ON e.id = o.assigned_to
       WHERE ($1::int IS NULL OR o.company_id=$1)
         AND LOWER(o.stage) NOT IN ('won','lost')
         AND o.deleted_at IS NULL
       ORDER BY o.expected_value DESC NULLS LAST LIMIT 200`,
      [cid]
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

router.get('/user-performance', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows } = await pool.query(
      `SELECT e.first_name || ' ' || COALESCE(e.last_name,'') AS name,
              e.department,
              COUNT(o.id)                                                     AS total_opportunities,
              COUNT(o.id) FILTER (WHERE LOWER(o.stage)='won')               AS won,
              COALESCE(SUM(o.expected_value) FILTER (WHERE LOWER(o.stage)='won'), 0) AS revenue_won,
              ROUND(COUNT(o.id) FILTER (WHERE LOWER(o.stage)='won')::numeric /
                    NULLIF(COUNT(o.id),0) * 100, 1)                          AS win_rate,
              COUNT(o.id) FILTER (WHERE LOWER(o.stage)='lost')              AS lost,
              COALESCE(SUM(o.expected_value)
                FILTER (WHERE LOWER(o.stage) NOT IN ('won','lost')), 0)      AS active_pipeline
       FROM employees e
       LEFT JOIN opportunities o
         ON o.assigned_to = e.id
         AND o.deleted_at IS NULL
         AND ($1::int IS NULL OR o.company_id=$1)
       WHERE LOWER(COALESCE(e.status,'active')) IN ('active','probation')
         AND ($1::int IS NULL OR e.company_id=$1)
       GROUP BY e.id, e.first_name, e.last_name, e.department
       HAVING COUNT(o.id) > 0
       ORDER BY revenue_won DESC LIMIT 50`,
      [cid]
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch { res.json([]); }
});

// ── CRM Settings ──────────────────────────────────────────────────────────────
router.get('/settings', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const result = await pool.query(
      'SELECT * FROM crm_settings WHERE company_id = $1',
      [companyId]
    );
    res.json({ data: result.rows[0] ?? null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/settings', allowRoles('admin', 'super_admin'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    if (!companyId) return res.status(400).json({ error: 'company_id required' });

    const {
      default_currency, deal_scoring_enabled, lead_lifetime_days, auto_assign_owner,
      duplicate_detection, activity_reminders,
      lead_sources, lead_statuses, default_lead_score, auto_score_on_create,
      fiscal_year_start, deal_probability_auto_update, show_lost_reasons, show_win_reasons,
      required_fields_to_close,
      email_tracking_enabled, email_open_tracking, email_click_tracking, bcc_crm_email,
      lead_assignment_method, stale_lead_alert_days, auto_close_lost_after_days,
      default_report_period, include_lost_in_pipeline,
    } = req.body;

    const result = await pool.query(`
      INSERT INTO crm_settings (
        company_id,
        default_currency, deal_scoring_enabled, lead_lifetime_days, auto_assign_owner,
        duplicate_detection, activity_reminders,
        lead_sources, lead_statuses, default_lead_score, auto_score_on_create,
        fiscal_year_start, deal_probability_auto_update, show_lost_reasons, show_win_reasons,
        required_fields_to_close,
        email_tracking_enabled, email_open_tracking, email_click_tracking, bcc_crm_email,
        lead_assignment_method, stale_lead_alert_days, auto_close_lost_after_days,
        default_report_period, include_lost_in_pipeline,
        updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,NOW()
      )
      ON CONFLICT (company_id) DO UPDATE SET
        default_currency            = EXCLUDED.default_currency,
        deal_scoring_enabled        = EXCLUDED.deal_scoring_enabled,
        lead_lifetime_days          = EXCLUDED.lead_lifetime_days,
        auto_assign_owner           = EXCLUDED.auto_assign_owner,
        duplicate_detection         = EXCLUDED.duplicate_detection,
        activity_reminders          = EXCLUDED.activity_reminders,
        lead_sources                = EXCLUDED.lead_sources,
        lead_statuses               = EXCLUDED.lead_statuses,
        default_lead_score          = EXCLUDED.default_lead_score,
        auto_score_on_create        = EXCLUDED.auto_score_on_create,
        fiscal_year_start           = EXCLUDED.fiscal_year_start,
        deal_probability_auto_update = EXCLUDED.deal_probability_auto_update,
        show_lost_reasons           = EXCLUDED.show_lost_reasons,
        show_win_reasons            = EXCLUDED.show_win_reasons,
        required_fields_to_close    = EXCLUDED.required_fields_to_close,
        email_tracking_enabled      = EXCLUDED.email_tracking_enabled,
        email_open_tracking         = EXCLUDED.email_open_tracking,
        email_click_tracking        = EXCLUDED.email_click_tracking,
        bcc_crm_email               = EXCLUDED.bcc_crm_email,
        lead_assignment_method      = EXCLUDED.lead_assignment_method,
        stale_lead_alert_days       = EXCLUDED.stale_lead_alert_days,
        auto_close_lost_after_days  = EXCLUDED.auto_close_lost_after_days,
        default_report_period       = EXCLUDED.default_report_period,
        include_lost_in_pipeline    = EXCLUDED.include_lost_in_pipeline,
        updated_at                  = NOW()
      RETURNING *
    `, [
      companyId,
      default_currency          ?? 'INR',
      deal_scoring_enabled      ?? true,
      lead_lifetime_days        ?? 90,
      auto_assign_owner         ?? false,
      duplicate_detection       ?? true,
      activity_reminders        ?? true,
      lead_sources              ?? ['Website','Referral','LinkedIn','Cold Call','Exhibition','Direct'],
      lead_statuses             ?? ['New','Contacted','Qualified','Unqualified','Converted'],
      default_lead_score        ?? 0,
      auto_score_on_create      ?? true,
      fiscal_year_start         ?? 4,
      deal_probability_auto_update ?? true,
      show_lost_reasons         ?? true,
      show_win_reasons          ?? true,
      required_fields_to_close  ?? ['value','expected_close_date'],
      email_tracking_enabled    ?? false,
      email_open_tracking       ?? false,
      email_click_tracking      ?? false,
      bcc_crm_email             ?? null,
      lead_assignment_method    ?? 'manual',
      stale_lead_alert_days     ?? 7,
      auto_close_lost_after_days ?? 0,
      default_report_period     ?? 'this_month',
      include_lost_in_pipeline  ?? false,
    ]);

    res.json({ data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── CSV Exports ───────────────────────────────────────────────────────────────
// The leads export lives with the other /leads routes, above '/leads/:id' — it
// cannot be registered here or the :id route swallows it.

// ── IEM Won / Lost Leads report ─────────────────────────────────────────────────
// A closed-enquiry grid: leads whose linked opportunity closed Won or Lost (or the
// lead itself was marked Unqualified). "IEM No" is a deterministic display number
// derived from the fiscal year of creation + the lead id — leads carry no number
// column of their own. Value prefers the won opportunity's expected_value, then the
// lead's own estimated_value / value, then any linked opportunity value.
//
// Filters (all optional): user (assigned_to), status (won|lost|all), min_value /
// max_value (in LAKHS), fy (fiscal-year start year, e.g. 2025 → 01 Apr 2025…31 Mar 2026).
// Everything is company-scoped via req.scope.company_id (NULL for superadmin = all).
const buildWonLostLeadsQuery = (cid, q) => {
  const params = [cid];                         // $1 = company id
  const inner  = [];                            // conditions applied before deriving status/value
  const outer  = [];                            // conditions applied on the derived columns

  if (q.user) { params.push(parseInt(q.user, 10)); inner.push(`AND l.assigned_to = $${params.length}`); }

  if (q.fy) {
    const y = parseInt(q.fy, 10);
    params.push(`${y}-04-01`);      const s = params.length;
    params.push(`${y + 1}-04-01`);  const e = params.length;
    inner.push(`AND l.created_at >= $${s} AND l.created_at < $${e}`);
  }

  const status = (q.status || '').toLowerCase();
  if (status === 'won' || status === 'lost') {
    params.push(status.charAt(0).toUpperCase() + status.slice(1));
    outer.push(`AND status = $${params.length}`);
  }

  // min/max are lakhs → convert to rupees for comparison against the derived value.
  if (q.min_value !== undefined && q.min_value !== '') {
    params.push(parseFloat(q.min_value) * 100000); outer.push(`AND value >= $${params.length}`);
  }
  if (q.max_value !== undefined && q.max_value !== '') {
    params.push(parseFloat(q.max_value) * 100000); outer.push(`AND value <= $${params.length}`);
  }

  const sql = `
    WITH o_agg AS (
      SELECT lead_id,
             BOOL_OR(LOWER(stage) = 'won')  AS has_won,
             BOOL_OR(LOWER(stage) = 'lost') AS has_lost,
             SUM(expected_value) FILTER (WHERE LOWER(stage) = 'won')  AS won_value,
             SUM(expected_value)                                      AS opp_value,
             MAX(closed_date) FILTER (WHERE LOWER(stage) IN ('won','lost')) AS closed_date
        FROM opportunities
       WHERE deleted_at IS NULL AND lead_id IS NOT NULL
       GROUP BY lead_id
    ),
    base AS (
      SELECT
        l.id,
        'IEM/' ||
          CASE WHEN EXTRACT(MONTH FROM l.created_at) >= 4
               THEN EXTRACT(YEAR FROM l.created_at)::int
               ELSE EXTRACT(YEAR FROM l.created_at)::int - 1 END
          || '/' || LPAD(l.id::text, 4, '0')                                    AS iem_no,
        l.company_name                                                          AS customer,
        l.contact_person                                                        AS contact,
        l.phone,
        l.email,
        l.lead_source                                                           AS channel,
        CASE WHEN COALESCE(o.has_won, false) OR LOWER(l.status) = 'won'
             THEN 'Won' ELSE 'Lost' END                                         AS status,
        COALESCE(NULLIF(o.won_value, 0), NULLIF(l.estimated_value, 0),
                 o.opp_value, 0)                                                AS value,
        l.created_at,
        o.closed_date,
        l.assigned_to,
        e.name                                                                  AS assigned_to_name,
        l.industry, l.location, l.zone, l.lead_score, l.notes
      FROM leads l
      LEFT JOIN o_agg     o ON o.lead_id    = l.id
      LEFT JOIN employees e ON e.id         = l.assigned_to
      WHERE l.deleted_at IS NULL
        AND ($1::int IS NULL OR l.company_id = $1)
        AND (COALESCE(o.has_won, false) OR COALESCE(o.has_lost, false)
             OR LOWER(l.status) IN ('won', 'lost', 'unqualified'))
        ${inner.join('\n        ')}
    )
    SELECT * FROM base
    WHERE 1 = 1
      ${outer.join('\n      ')}
    ORDER BY created_at DESC`;

  return { sql, params };
};

router.get('/won-lost-leads', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { sql, params } = buildWonLostLeadsQuery(cid, req.query);
    const { rows } = await pool.query(sql, params);
    const total_value = rows.reduce((s, r) => s + (parseFloat(r.value) || 0), 0);
    res.json({
      data: rows,
      total_value,
      count: rows.length,
      won_count:  rows.filter(r => r.status === 'Won').length,
      lost_count: rows.filter(r => r.status === 'Lost').length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/won-lost-leads/filters', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);

    const users = await pool.query(
      `SELECT DISTINCT e.id, e.name
         FROM leads l
         JOIN employees e ON e.id = l.assigned_to
        WHERE l.deleted_at IS NULL
          AND ($1::int IS NULL OR l.company_id = $1)
          AND e.name IS NOT NULL
        ORDER BY e.name`,
      [cid]
    );

    const years = await pool.query(
      `SELECT DISTINCT
              CASE WHEN EXTRACT(MONTH FROM created_at) >= 4
                   THEN EXTRACT(YEAR FROM created_at)::int
                   ELSE EXTRACT(YEAR FROM created_at)::int - 1 END AS fy
         FROM leads
        WHERE deleted_at IS NULL
          AND ($1::int IS NULL OR company_id = $1)
        ORDER BY fy DESC`,
      [cid]
    );

    res.json({
      users: users.rows,
      fiscal_years: years.rows.map(r => ({ value: r.fy, label: `FY ${r.fy}-${String((r.fy + 1) % 100).padStart(2, '0')}` })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/won-lost-leads/export', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const { sql, params } = buildWonLostLeadsQuery(cid, req.query);
    const { rows } = await pool.query(sql, params);

    const d = v => (v ? new Date(v).toISOString().split('T')[0] : '');
    const data = rows.map(r => ({
      'IEM No':     r.iem_no,
      Customer:     r.customer || '',
      'Created On': d(r.created_at),
      Status:       r.status,
      'Value (₹)':  Number(r.value || 0),
      Contact:      r.contact || '',
      Phone:        r.phone || 'NA',
      Email:        r.email || 'NA',
      Channel:      r.channel || '',
    }));
    // Footer total row summing Value.
    const total_value = rows.reduce((s, r) => s + (parseFloat(r.value) || 0), 0);
    data.push({ 'IEM No': '', Customer: '', 'Created On': '', Status: 'TOTAL', 'Value (₹)': total_value, Contact: '', Phone: '', Email: '', Channel: '' });

    const XLSX = (await import('xlsx')).default;
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Won-Lost Leads');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="won_lost_leads_${Date.now()}.xlsx"`);
    res.send(buf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/opportunities/export', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid = companyOf(req);

    const { rows } = await pool.query(
      `SELECT o.id, o.opportunity_name, o.stage, o.expected_value, o.probability_percentage,
              o.expected_closing_date, o.closed_date, o.notes, o.created_at,
              e.name AS assigned_to,
              COALESCE(a.name, a.account_name) AS account_name
       FROM opportunities o
       LEFT JOIN employees e ON e.id = o.assigned_to
       LEFT JOIN accounts  a ON a.id = o.account_id AND a.deleted_at IS NULL
       WHERE o.deleted_at IS NULL
         AND ($1::int IS NULL OR o.company_id = $1)
       ORDER BY o.created_at DESC`,
      [cid]
    );

    const headers = ['ID','Opportunity Name','Account','Stage','Expected Value','Probability %','Expected Close','Closed Date','Assigned To','Notes','Created At'];
    const toRow = r => [
      r.id, r.opportunity_name, r.account_name, r.stage,
      r.expected_value, r.probability_percentage,
      r.expected_closing_date ? new Date(r.expected_closing_date).toISOString().split('T')[0] : '',
      r.closed_date           ? new Date(r.closed_date).toISOString().split('T')[0] : '',
      r.assigned_to, (r.notes || '').replace(/[\r\n,]/g, ' '),
      new Date(r.created_at).toISOString().split('T')[0],
    ].map(v => `"${(v ?? '').toString().replace(/"/g, '""')}"`).join(',');

    const csv = [headers.join(','), ...rows.map(toRow)].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="opportunities_${Date.now()}.csv"`);
    res.send(csv);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── CRM Activities CRUD ───────────────────────────────────────────────────────

router.get('/activities', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const cid         = companyOf(req);
    const type        = req.query.type        || '';
    const lead_id     = req.query.lead_id     || null;
    const opp_id      = req.query.opportunity_id || null;
    const account_id  = req.query.account_id  || null;
    const search      = req.query.search      || '';

    let q = `
      SELECT ca.*,
             e.name      AS performed_by_name,
             l.company_name AS lead_name,
             o.opportunity_name,
             COALESCE(a.name, a.account_name) AS account_name
      FROM crm_activities ca
      LEFT JOIN employees    e ON e.id  = ca.performed_by
      LEFT JOIN leads        l ON l.id  = ca.lead_id
      LEFT JOIN opportunities o ON o.id = ca.opportunity_id
      LEFT JOIN accounts      a ON a.id = ca.account_id AND a.deleted_at IS NULL
      WHERE ($1::int IS NULL OR ca.company_id = $1)
        AND ca.deleted_at IS NULL
    `;
    const params = [cid];
    let n = 2;

    if (type)       { q += ` AND ca.activity_type = $${n++}`;   params.push(type); }
    if (lead_id)    { q += ` AND ca.lead_id = $${n++}`;         params.push(lead_id); }
    if (opp_id)     { q += ` AND ca.opportunity_id = $${n++}`;  params.push(opp_id); }
    if (account_id) { q += ` AND ca.account_id = $${n++}`;      params.push(account_id); }
    if (search)     {
      q += ` AND (ca.subject ILIKE $${n} OR ca.description ILIKE $${n})`;
      params.push(`%${search}%`); n++;
    }

    q += ` ORDER BY ca.activity_date DESC NULLS LAST LIMIT 200`;

    const { rows } = await pool.query(q, params).catch(() => ({ rows: [] }));
    res.json({ activities: rows });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/activities', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const cid    = companyOf(req);
    const userId = req.user?.userId ?? req.user?.id;
    const {
      activity_type, subject, description, activity_date,
      duration_mins, lead_id, opportunity_id, account_id, contact_id,
    } = req.body;

    if (!activity_type) return res.status(400).json({ error: 'activity_type is required' });

    const { rows } = await pool.query(
      `INSERT INTO crm_activities
         (company_id, activity_type, subject, description, activity_date, duration_mins,
          lead_id, opportunity_id, account_id, contact_id, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [cid, activity_type, subject || null, description || null,
       activity_date || new Date().toISOString(), duration_mins || null,
       lead_id || null, opportunity_id || null, account_id || null, contact_id || null, userId]
    );
    res.status(201).json(rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/activities/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const cid = companyOf(req);
    const {
      activity_type, subject, description, activity_date, duration_mins,
    } = req.body;
    const { rows } = await pool.query(
      `UPDATE crm_activities
       SET activity_type  = COALESCE($1, activity_type),
           subject        = COALESCE($2, subject),
           description    = COALESCE($3, description),
           activity_date  = COALESCE($4, activity_date),
           duration_mins  = COALESCE($5, duration_mins),
           updated_at     = NOW()
       WHERE id = $6 AND ($7::int IS NULL OR company_id = $7)
       RETURNING *`,
      [activity_type || null, subject || null, description || null,
       activity_date || null, duration_mins || null, req.params.id, cid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Activity not found' });
    res.json(rows[0]);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/activities/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const cid = companyOf(req);
    await pool.query(
      `UPDATE crm_activities SET deleted_at = NOW()
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    res.json({ message: 'Activity deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Customer 360 — single-call comprehensive account view ─────────────────────
router.get('/customer-360/:accountId', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { accountId } = req.params;
    const cid = companyOf(req);

    const accRes = await pool.query(
      'SELECT * FROM accounts WHERE id = $1 AND deleted_at IS NULL',
      [accountId]
    );
    if (!accRes.rows[0]) return res.status(404).json({ error: 'Account not found' });
    const account = accRes.rows[0];

    const [contactsRes, oppsRes, emailsRes, activitiesRes, invoicesRes] = await Promise.allSettled([
      pool.query(
        `SELECT * FROM contacts WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [accountId]
      ),
      pool.query(
        `SELECT * FROM opportunities WHERE account_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [accountId]
      ),
      pool.query(
        `SELECT * FROM crm_emails WHERE account_id = $1 ORDER BY sent_at DESC LIMIT 10`,
        [accountId]
      ),
      pool.query(
        `SELECT * FROM crm_activities WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [accountId]
      ),
      pool.query(
        `SELECT * FROM invoices
         WHERE ($1::int IS NULL OR company_id = $1)
           AND LOWER(customer_name) = LOWER($2)
         ORDER BY created_at DESC LIMIT 20`,
        [cid || null, account.account_name]
      ),
    ]);

    const contacts      = contactsRes.status    === 'fulfilled' ? contactsRes.value.rows    : [];
    const opportunities = oppsRes.status        === 'fulfilled' ? oppsRes.value.rows        : [];
    const emails        = emailsRes.status      === 'fulfilled' ? emailsRes.value.rows      : [];
    const activities    = activitiesRes.status  === 'fulfilled' ? activitiesRes.value.rows  : [];
    const invoices      = invoicesRes.status    === 'fulfilled' ? invoicesRes.value.rows    : [];

    const wonOpps    = opportunities.filter(o => (o.stage || '').toLowerCase() === 'won');
    const activeOpps = opportunities.filter(o => !['won', 'lost'].includes((o.stage || '').toLowerCase()));

    const allDates = [
      ...emails.map(e => e.sent_at),
      ...activities.map(a => a.created_at),
    ].filter(Boolean).sort().reverse();

    res.json({
      account,
      contacts,
      opportunities,
      emails,
      activities,
      invoices,
      stats: {
        total_pipeline_value: activeOpps.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0),
        total_won_value:      wonOpps.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0),
        open_opportunities:   activeOpps.length,
        total_contacts:       contacts.length,
        last_contact_date:    allDates[0] || null,
        days_as_customer:     account.created_at
          ? Math.floor((Date.now() - new Date(account.created_at).getTime()) / 86400000)
          : 0,
        avg_deal_size: opportunities.length
          ? opportunities.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0) / opportunities.length
          : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
