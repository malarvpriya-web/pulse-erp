/**
 * systemHealth.routes.js
 * Live database introspection for the System Health Monitor.
 *
 * GET /system-health/db-tables
 *   Returns EVERY base table in the public schema with a live row count and a
 *   derived module group. Because it reads the catalog at request time, any
 *   newly-created table automatically appears in the connection test with zero
 *   manual edits — this is what makes the health check self-updating.
 */
import express from 'express';
import pool from '../../config/db.js';

const router = express.Router();

// ── Table prefix → module group ────────────────────────────────────────────────
// First matching rule wins. Groups intentionally line up with GROUP_ORDER in the
// SystemHealth UI so the results render under sensible, ordered sections.
const GROUP_RULES = [
  [/^(employees?|emp_|org_|designation|department|grade|band)/,          'Core'],
  [/^(leave|comp_off|encashment|holiday)/,                               'HR'],
  [/^(attendance|shift|geo|biometric|gate_pass|visitor|face_|device)/,   'Attendance'],
  [/^(payroll|salary|payslip|pf_|esi_|pt_|form16|form24)/,               'Payroll'],
  [/^(performance|goal|kra|okr|review|appraisal|feedback|calibration|increment|promotion)/, 'Performance'],
  [/^(recruit|candidate|job_|requisition|interview|offer|onboard|talent|resume)/, 'Recruitment'],
  [/^(training|course|learning|competency|assessment|certification|trainer|lnd_)/, 'HR'],
  [/^(succession|nine_box|development_plan)/,                             'HR'],
  [/^(self_service|exit_|probation|announcement)/,                       'HR'],
  [/^(invoice|bill|party|parties|credit_note|debit_note|credit_limit|receivable|payable|payment|pdc)/, 'Finance'],
  [/^(account|journal|ledger|trial_balance|period_clos|cost_cent|voucher|contra|daybook)/, 'Accounting'],
  [/^(gst|einvoice|eway)/,                                               'GST'],
  [/^tds/,                                                               'TDS'],
  [/^tcs/,                                                               'TDS'],
  [/^budget/,                                                            'Budgets'],
  [/^(fixed_asset|asset_depr|depreciation)/,                            'Fixed Assets'],
  [/^(forex|exchange_rate)/,                                            'Forex'],
  [/^(procurement|vendor|purchase|rfq|grn|po_|three_way)/,              'Procurement'],
  [/^(inventory|stock|item|warehouse|bin|zone_|pick_|serial|batch|reorder)/, 'Inventory'],
  [/^(logistics|shipment|delivery_note|dispatch)/,                     'Logistics'],
  [/^(bom|work_cent|production|shop_floor|mrp)/,                       'Production'],
  [/^(quality|qc_|ncr|capa|inspection|disturbance)/,                  'Quality'],
  [/^(maintenance|mtbf|mttr|amc|warranty)/,                           'Maintenance'],
  [/^(crm|lead|opportunit|contact|account_|pipeline|scoring)/,        'CRM'],
  [/^(sales|quotation|order|commission|pricing|price_list|target|funnel|playbook|territor|competitor|subscription)/, 'Sales'],
  [/^(marketing|campaign)/,                                           'Marketing'],
  [/^(project|task|gantt|milestone|issue|fat_|sat_|evm|commissioning)/, 'Projects'],
  [/^(timesheet|utilization)/,                                        'Timesheets'],
  [/^(ticket|servicedesk|service_|sla_|csat|complaint|voc_|failure)/, 'Service Desk'],
  [/^(workflow|approval|lifecycle)/,                                  'Workflows'],
  [/^(security|session|ip_whitelist|permission|role|menu_)/,         'Security'],
  [/^(travel|reimbursement|visit)/,                                  'Travel'],
  [/^(document|signature|esign|template)/,                           'Documents'],
  [/^(audit|activity_log)/,                                          'Audit'],
  [/^(notification|announcement)/,                                   'Admin'],
  [/^(report|saved_report)/,                                         'Reports'],
  [/^(dashboard|kpi_|analytic)/,                                     'Analytics'],
  [/^(ai_|intelligence|ml_|anomal|prediction)/,                     'AI'],
  [/^(integration|tally|zoho|whatsapp|webhook|email_)/,             'Integrations'],
  [/^(company|branch|master|setting|wizard|config|user)/,           'Admin'],
  [/^(schema_migrations|migrations)/,                               'Core'],
];

function deriveGroup(tableName) {
  const name = String(tableName).toLowerCase();
  for (const [re, group] of GROUP_RULES) {
    if (re.test(name)) return group;
  }
  return 'Other';
}

/** employee_leave_balance → Employee Leave Balance */
function humanize(tableName) {
  return String(tableName)
    .split('_')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

router.get('/db-tables', async (_req, res) => {
  const t0 = Date.now();
  try {
    // reltuples / n_live_tup are catalog-maintained estimates — instant, no table
    // scan, and accurate enough for a health check even on very large tables.
    const { rows } = await pool.query(`
      SELECT
        c.relname                              AS table_name,
        GREATEST(COALESCE(s.n_live_tup, c.reltuples::bigint), 0) AS rows,
        (SELECT count(*)::int
           FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name   = c.relname)  AS columns
      FROM pg_class c
      JOIN pg_namespace n        ON n.oid   = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind = 'r'
        AND n.nspname = 'public'
      ORDER BY c.relname
    `);

    // n_live_tup / reltuples are only refreshed by ANALYZE/VACUUM, so a table
    // seeded by a migration but never analysed still estimates 0 rows and gets
    // mis-reported as empty. Re-count only the zero-estimate tables exactly:
    // counting a genuinely empty table is near-free, and a populated table
    // stuck at 0 is precisely the case this needs to correct.
    const zeroTables = rows.filter(r => Number(r.rows) === 0).map(r => r.table_name);
    const exactCounts = new Map();
    for (let i = 0; i < zeroTables.length; i += 100) {
      const sql = zeroTables.slice(i, i + 100)
        .map(t => `SELECT '${t.replace(/'/g, "''")}' AS t, (SELECT count(*) FROM "${t.replace(/"/g, '""')}") AS n`)
        .join(' UNION ALL ');
      const { rows: counted } = await pool.query(sql);
      for (const c of counted) exactCounts.set(c.t, Number(c.n));
    }

    const tables = rows.map(r => ({
      table:   r.table_name,
      label:   humanize(r.table_name),
      group:   deriveGroup(r.table_name),
      rows:    exactCounts.has(r.table_name) ? exactCounts.get(r.table_name) : (Number(r.rows) || 0),
      columns: r.columns,
    }));

    res.json({
      ok:    true,
      ms:    Date.now() - t0,
      count: tables.length,
      tables,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ms: Date.now() - t0 });
  }
});

export default router;
