/**
 * systemHealth.routes.js
 * Live database introspection for the System Health Monitor.
 *
 * GET /system-health/db-tables
 *   Returns EVERY table in the database with a live row count and a derived
 *   module group. Because it reads the catalog at request time, any newly-created
 *   table automatically appears in the connection test with zero manual edits —
 *   this is what makes the health check self-updating.
 *
 *   "Every table" is meant literally, and that is what the catalog filter has to
 *   earn:
 *     • every non-system SCHEMA, not just public — a module that lands its tables
 *       in a schema of its own is still part of this database's health.
 *     • partitioned tables (relkind 'p') as well as ordinary ones (relkind 'r').
 *       A partitioned parent holds no rows itself, so it is invisible to a
 *       relkind='r' filter while its partitions each show up as a bogus
 *       standalone "table" (device_telemetry_2026_07, _2026_08, …). The parent is
 *       the table the application writes to, so it is the row reported here, with
 *       its partitions' live-tuple estimates rolled up into it.
 *     • partitions and legacy inheritance children are therefore excluded from
 *       the top level — they are storage for a parent already listed.
 *   Views and matviews are deliberately NOT listed: they store no rows, so a row
 *   count for one is a query cost, not a health signal.
 */
import express from 'express';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../../config/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Mirrors StorageService.js's LOCAL_UPLOAD_DIR so both agree on what 'local
// storage' means. If that constant moves, this must move with it.
const LOCAL_UPLOAD_DIR = path.resolve(__dirname, '../../../uploads');

const router = express.Router();

// ── Table prefix → module group ────────────────────────────────────────────────
// First matching rule wins. Groups intentionally line up with GROUP_ORDER in the
// SystemHealth UI so the results render under sensible, ordered sections.
const GROUP_RULES = [
  [/^(employees?|emp_|org_|designation|department|grade|band)/,          'Core'],
  [/^(leave|comp_off|encashment|holiday)/,                               'HR'],
  // Ahead of the Attendance rule on purpose: /^device/ there means a biometric
  // punch device, and would otherwise swallow the IoT telemetry tables.
  [/^(iot_|telemetry|device_telemetry|sensor|equipment_telemetry|fleet_)/, 'IoT'],
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
    // A partitioned parent stores nothing itself, so its estimate is the sum of
    // its partitions', walked with pg_partition_tree (which handles sub-partitions
    // too, and returns just the parent for a table that is not partitioned).
    const { rows } = await pool.query(`
      SELECT
        n.nspname                              AS schema_name,
        c.relname                              AS table_name,
        c.relkind                              AS relkind,
        CASE WHEN c.relkind = 'p' THEN (
               SELECT COALESCE(SUM(GREATEST(COALESCE(ps.n_live_tup, pc.reltuples::bigint), 0)), 0)
                 FROM pg_partition_tree(c.oid) pt
                 JOIN pg_class pc ON pc.oid = pt.relid
                 LEFT JOIN pg_stat_user_tables ps ON ps.relid = pc.oid
                WHERE pc.relkind = 'r')
             ELSE GREATEST(COALESCE(s.n_live_tup, c.reltuples::bigint), 0)
        END                                    AS rows,
        CASE WHEN c.relkind = 'p'
             THEN (SELECT count(*)::int FROM pg_partition_tree(c.oid) pt WHERE pt.relid <> c.oid)
             ELSE 0
        END                                    AS partitions,
        (SELECT count(*)::int
           FROM information_schema.columns col
          WHERE col.table_schema = n.nspname
            AND col.table_name   = c.relname)  AS columns
      FROM pg_class c
      JOIN pg_namespace n        ON n.oid   = c.relnamespace
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname <> 'information_schema'
        -- Regex, not LIKE: the underscore in 'pg\_%' would need escaping that a
        -- template literal eats on the way to the server. 'pg_' is reserved by
        -- PostgreSQL, so this drops pg_catalog/pg_toast/pg_temp and nothing else.
        AND n.nspname !~ '^pg_'
        -- A partition (or a legacy inheritance child) is storage for a parent that
        -- is already listed; listing it again would double-count the same rows.
        AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
      ORDER BY n.nspname, c.relname
    `);

    // n_live_tup / reltuples are only refreshed by ANALYZE/VACUUM, so a table
    // seeded by a migration but never analysed still estimates 0 rows and gets
    // mis-reported as empty. Re-count only the zero-estimate tables exactly:
    // counting a genuinely empty table is near-free, and a populated table
    // stuck at 0 is precisely the case this needs to correct. count(*) on a
    // partitioned parent covers all of its partitions.
    const qualify = (schema, table) =>
      `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
    const key = (schema, table) => `${schema}.${table}`;

    const zeroTables = rows.filter(r => Number(r.rows) === 0);
    const exactCounts = new Map();
    for (let i = 0; i < zeroTables.length; i += 100) {
      const sql = zeroTables.slice(i, i + 100)
        .map(r => `SELECT '${key(r.schema_name, r.table_name).replace(/'/g, "''")}' AS t, ` +
                  `(SELECT count(*) FROM ${qualify(r.schema_name, r.table_name)}) AS n`)
        .join(' UNION ALL ');
      const { rows: counted } = await pool.query(sql);
      for (const c of counted) exactCounts.set(c.t, Number(c.n));
    }

    const tables = rows.map(r => {
      const k = key(r.schema_name, r.table_name);
      const isPublic = r.schema_name === 'public';
      return {
        table:      r.table_name,
        schema:     r.schema_name,
        // Schema-qualified only when it has to be, so every public table keeps
        // reading exactly as it did before this became schema-aware.
        qualified_name: isPublic ? r.table_name : k,
        label:      humanize(r.table_name),
        // A table in a schema of its own belongs to that schema's module — the
        // name-prefix rules only ever described the flat public namespace.
        group:      isPublic ? deriveGroup(r.table_name) : humanize(r.schema_name),
        kind:       r.relkind === 'p' ? 'partitioned' : 'table',
        partitions: r.partitions,
        rows:       exactCounts.has(k) ? exactCounts.get(k) : (Number(r.rows) || 0),
        columns:    r.columns,
      };
    });

    res.json({
      ok:      true,
      ms:      Date.now() - t0,
      count:   tables.length,
      schemas: [...new Set(tables.map(t => t.schema))],
      tables,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ms: Date.now() - t0 });
  }
});
// ── Recursive directory size ──────────────────────────────────────────────────
// Returns { bytes, count } for a directory tree. Missing directory is reported
// as an empty store rather than an error: a deployment that has never taken an
// upload legitimately has no uploads dir yet.
async function dirSize(dir) {
  let bytes = 0;
  let count = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { bytes: 0, count: 0, missing: true };
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirSize(full);
      bytes += sub.bytes;
      count += sub.count;
    } else if (entry.isFile()) {
      // A file deleted between readdir and stat is not an error worth failing on.
      try {
        const st = await fsp.stat(full);
        bytes += st.size;
        count += 1;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
  return { bytes, count, missing: false };
}

/**
 * GET /system-health/storage
 *
 * Real storage consumption, split by where it actually lives:
 *   database — pg_database_size(), plus the five largest tables
 *   files    — the upload store, whose location depends on STORAGE_PROVIDER
 *
 * When files are on S3/R2 the size is reported as UNMEASURED, not zero: sizing a
 * bucket needs a fully paginated ListObjectsV2 walk, which does not belong on a
 * dashboard request. A null here means "not measured" and the UI must say so —
 * reporting 0 would be a fabricated number.
 */
router.get('/storage', async (_req, res) => {
  const t0 = Date.now();
  try {
    const { rows: dbRows } = await pool.query(`
      SELECT current_database()                             AS db_name,
             pg_database_size(current_database())::bigint   AS db_bytes
    `);

    const { rows: topTables } = await pool.query(`
      SELECT c.relname                          AS table_name,
             pg_total_relation_size(c.oid)::bigint AS bytes
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'
         AND n.nspname = 'public'
       ORDER BY pg_total_relation_size(c.oid) DESC
       LIMIT 5
    `);

    // pg returns bigint as a string — Number() it here or every arithmetic
    // consumer downstream silently concatenates instead of adding.
    const dbBytes = Number(dbRows[0].db_bytes);
    const provider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();

    let files;
    if (provider === 'local') {
      const { bytes, count, missing } = await dirSize(LOCAL_UPLOAD_DIR);
      files = { provider, measured: true, bytes, file_count: count, empty: missing };
    } else {
      files = { provider, measured: false, bytes: null, file_count: null };
    }

    res.json({
      ok: true,
      ms: Date.now() - t0,
      database: {
        name:  dbRows[0].db_name,
        bytes: dbBytes,
        top_tables: topTables.map(t => ({ table: t.table_name, bytes: Number(t.bytes) })),
      },
      files,
      // Only a real sum when both halves were measured. null = incomplete.
      total_bytes: files.measured ? dbBytes + files.bytes : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ms: Date.now() - t0 });
  }
});

/**
 * GET /system-health/status
 *
 * Measured service status for the Operations Dashboard tile. Every entry is an
 * executed check — nothing is assumed up. The overall verdict is the worst
 * individual verdict, so one failing dependency cannot be averaged away.
 */
router.get('/status', async (_req, res) => {
  const t0 = Date.now();
  const checks = [];

  // API — reached this handler, so it is by definition serving.
  checks.push({ name: 'API', status: 'up', detail: 'Serving requests' });

  // Database — a real round-trip, with its latency.
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    const ms = Date.now() - dbStart;
    checks.push({
      name:   'Database',
      // A reachable-but-slow database is degraded, not healthy. 1s is the point
      // where page loads built on several queries become visibly bad.
      status: ms > 1000 ? 'degraded' : 'up',
      detail: `Responded in ${ms}ms`,
      ms,
    });
  } catch (err) {
    checks.push({ name: 'Database', status: 'down', detail: err.message });
  }

  // Storage — that the configured backend is actually usable, not merely named.
  const provider = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();
  if (provider === 'local') {
    try {
      await fsp.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
      // Writability is the property that matters; existence is not enough.
      await fsp.access(LOCAL_UPLOAD_DIR, (await import('fs')).constants.W_OK);
      checks.push({ name: 'Storage', status: 'up', detail: 'Local upload directory writable' });
    } catch (err) {
      checks.push({ name: 'Storage', status: 'down', detail: `Local upload directory not writable: ${err.message}` });
    }
  } else if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    // StorageService throws on the first upload in this state — surface it here
    // instead of waiting for a user to hit it.
    checks.push({ name: 'Storage', status: 'down', detail: `${provider.toUpperCase()} selected but AWS credentials are not set` });
  } else {
    checks.push({ name: 'Storage', status: 'up', detail: `${provider.toUpperCase()} configured` });
  }

  const rank = { up: 0, degraded: 1, down: 2 };
  const worst = checks.reduce((acc, c) => (rank[c.status] > rank[acc] ? c.status : acc), 'up');
  const label = { up: 'Healthy', degraded: 'Degraded', down: 'Down' }[worst];

  res.json({
    ok: worst !== 'down',
    ms: Date.now() - t0,
    status: worst,
    label,
    checks,
    summary: `${checks.filter(c => c.status === 'up').length}/${checks.length} services healthy`,
  });
});

export default router;
