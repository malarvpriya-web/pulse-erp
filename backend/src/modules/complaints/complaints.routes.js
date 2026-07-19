import { Router } from 'express';
import pool from '../../config/db.js';
import { nextComplaintNumber, nextServiceTicketNumber } from '../../shared/docNumber.js';
import { pickUpdatable } from '../../shared/safeUpdate.js';
import { validateOptionalMobile } from '../../shared/validators.js';
import { PROJECT_TYPES } from '../../shared/projectTypes.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();

/**
 * Every route is gated on the `servicedesk` module, matching ips.routes.js.
 *
 * Until now this module had NO permission middleware at all — server.js mounts it
 * with a bare verifyToken, so ANY authenticated user could read every customer
 * complaint in their company, and delete them. That was survivable while the table
 * held generic internal complaints; it is not now that rows carry customer
 * contact details, site, product and serial.
 *
 * `servicedesk` (not a new `complaints` module) because IPCS is one half of the
 * Service module's complaint->ticket loop: the people who work IPCS are exactly
 * the people who work IPS, and a separate matrix would drift out of step with it.
 * The grants are already seeded across 21 roles — super_admin/admin/service_manager
 * full, service_engineer view+add+edit (no delete), everyone else denied.
 *
 * NOTE: requirePermission FAILS OPEN when a module has no permission row seeded
 * (unless PERMISSION_STRICT=true). `servicedesk` IS seeded, so this gate really
 * gates — verified against the live matrix rather than assumed.
 */
const svc = (action) => requirePermission('servicedesk', action);

// Same lists the IPS grid validates against (ips.routes.js) — a converted ticket
// must not be able to carry a zone/type the IPS filters can never select.
const ZONES = ['North', 'South', 'East', 'West', 'Central'];

/** '' / null / 'abc' -> null; '3' -> 3. Keeps a cleared <select> from failing the int cast. */
const intOrNull = (v) => {
  const n = Number(v);
  return v === '' || v == null || !Number.isInteger(n) || n <= 0 ? null : n;
};

// ── VALID TRANSITIONS ─────────────────────────────────────────────────────────
const VALID_TRANSITIONS = {
  open:        ['in_progress', 'resolved', 'closed'],
  in_progress: ['resolved', 'on_hold', 'closed'],
  on_hold:     ['in_progress', 'closed'],
  resolved:    ['closed', 'open'],   // reopen
  closed:      [],
};

const cid = (req) => req.scope?.company_id ?? null;

// ── SHARED SQL ────────────────────────────────────────────────────────────────
/**
 * Customer Complaints (IPCS) read layer — see SERVICE_MASTER_IPCS_PLAN.md.
 *
 * The product-service dimensions landed in 20260717000002. Complaints own their
 * product/serial directly, but Site is INHERITED from the linked project, exactly
 * as the IPS grid does it (ips.routes.js:37) — resolved with the identical
 * expression on purpose, so the two grids can never disagree about what a site
 * is called.
 */
const SITENAME_SQL = `COALESCE(NULLIF(p.site_city, ''), p.project_name)`;
const PRODUCT_SQL  = `pl.display_name`;
// customer_mobile is the validated 10-digit column; customer_phone is legacy
// free text (VARCHAR(50)) that predates validation. Reads prefer the former and
// fall back, so legacy rows still show a number instead of a blank.
const MOBILE_SQL   = `COALESCE(NULLIF(c.customer_mobile, ''), c.customer_phone)`;
// SLA is derived, never stored — a stored column would need a cron to stay true.
const SLA_DUE_SQL  = `
  c.created_at + CASE c.priority
    WHEN 'Critical' THEN INTERVAL '8 hours'
    WHEN 'High'     THEN INTERVAL '24 hours'
    WHEN 'Medium'   THEN INTERVAL '72 hours'
    WHEN 'Low'      THEN INTERVAL '120 hours'
    ELSE INTERVAL '72 hours'
  END`;

/**
 * A complaint may legitimately have MORE THAN ONE service ticket — a reopened
 * complaint can escalate twice. A plain LEFT JOIN would then emit one grid row
 * per ticket and silently duplicate the complaint. LATERAL aggregates them into
 * one row per complaint without dragging every selected column into a GROUP BY.
 * Empty array (not NULL) when there are none, so the frontend's "No IPS" state
 * is a length check rather than a null check.
 */
const IPS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(ARRAY_AGG(t.ticket_number ORDER BY t.created_at), '{}') AS ips_numbers,
           COALESCE(ARRAY_AGG(t.id           ORDER BY t.created_at), '{}') AS ips_ids,
           COUNT(*)::int                                                    AS ips_count
      FROM support_tickets t
     WHERE t.complaint_id = c.id
       AND t.ticket_kind  = 'service'
       AND t.deleted_at IS NULL
  ) ips ON TRUE`;

const BASE_FROM = `
  FROM complaints c
  LEFT JOIN projects      p  ON p.id  = c.project_id
  LEFT JOIN product_lines pl ON pl.id = c.product_line_id
  ${IPS_LATERAL}`;

/**
 * The client sends a key; free text can never reach the ORDER BY.
 * Covers all 7 reference columns plus the legacy grid's own sorts.
 */
const SORTABLE = {
  ipcs_id:       'c.complaint_number',
  site:          SITENAME_SQL,
  customer_name: 'c.customer_name',
  mobile:        MOBILE_SQL,
  product:       PRODUCT_SQL,
  serial:        'c.serial_number',
  ips:           'ips.ips_numbers[1]',
  ipp:           'p.project_number',
  title:         'c.title',
  category:      'c.category',
  priority:      'c.priority',
  status:        'c.status',
  created_at:    'c.created_at',
};

/**
 * Shared WHERE for the list and its count, so a filtered grid and its total can
 * never disagree about which complaints they describe.
 */
function buildWhere(req) {
  const params = [cid(req)];
  const conds = [
    'c.deleted_at IS NULL',
    '($1::int IS NULL OR c.company_id = $1)',
  ];
  const { status, priority, category, project_id, product_line_id, has_ips, search } = req.query;

  if (status)          { params.push(status);          conds.push(`c.status = $${params.length}`); }
  if (priority)        { params.push(priority);        conds.push(`c.priority = $${params.length}`); }
  if (category)        { params.push(category);        conds.push(`c.category = $${params.length}`); }
  if (project_id)      { params.push(project_id);      conds.push(`c.project_id = $${params.length}`); }
  if (product_line_id) { params.push(product_line_id); conds.push(`c.product_line_id = $${params.length}`); }
  // Lets the grid answer "which complaints were never escalated?" — the whole
  // point of the "No IPS" column being a real state.
  if (has_ips === 'true')  conds.push(`ips.ips_count > 0`);
  if (has_ips === 'false') conds.push(`ips.ips_count = 0`);
  if (search) {
    params.push(`%${search}%`);
    const i = params.length;
    conds.push(`(c.complaint_number ILIKE $${i} OR c.title ILIKE $${i} OR c.customer_name ILIKE $${i}
                 OR c.serial_number ILIKE $${i} OR ${MOBILE_SQL} ILIKE $${i}
                 OR ${SITENAME_SQL} ILIKE $${i} OR p.project_number ILIKE $${i}
                 OR ${PRODUCT_SQL} ILIKE $${i})`);
  }
  return { where: `WHERE ${conds.join(' AND ')}`, params };
}

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get('/dashboard', svc('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const [totals, byStatus, byCategory, recent] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                               AS total,
          COUNT(*) FILTER (WHERE status = 'open')               AS open,
          COUNT(*) FILTER (WHERE status = 'in_progress')        AS in_progress,
          COUNT(*) FILTER (WHERE status = 'resolved')           AS resolved,
          COUNT(*) FILTER (WHERE status = 'closed')             AS closed,
          COUNT(*) FILTER (WHERE priority = 'High')             AS high_priority,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS this_month,
          ROUND(
            100.0 * COUNT(*) FILTER (WHERE status IN ('resolved','closed'))
            / NULLIF(COUNT(*), 0), 1
          )                                                      AS resolution_rate,
          ROUND(
            AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 86400)
            FILTER (WHERE resolved_at IS NOT NULL), 1
          )                                                      AS avg_resolution_days
        FROM complaints
        WHERE deleted_at IS NULL
          AND ($1::int IS NULL OR company_id = $1)
      `, [companyId]),
      pool.query(`
        SELECT status, COUNT(*) AS count
        FROM complaints
        WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
        GROUP BY status ORDER BY count DESC
      `, [companyId]),
      pool.query(`
        SELECT category, COUNT(*) AS count
        FROM complaints
        WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
        GROUP BY category ORDER BY count DESC LIMIT 6
      `, [companyId]),
      pool.query(`
        SELECT id, complaint_number, title, customer_name, priority, status, created_at
        FROM complaints
        WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
        ORDER BY created_at DESC LIMIT 5
      `, [companyId]),
    ]);

    const t = totals.rows[0];
    res.json({
      total:           parseInt(t.total)  || 0,
      open:            parseInt(t.open)   || 0,
      in_progress:     parseInt(t.in_progress) || 0,
      resolved:        parseInt(t.resolved) || 0,
      closed:          parseInt(t.closed) || 0,
      high_priority:   parseInt(t.high_priority) || 0,
      this_month:      parseInt(t.this_month) || 0,
      resolution_rate: parseFloat(t.resolution_rate) || 0,
      avg_resolution_days: parseFloat(t.avg_resolution_days) || 0,
      by_status:    byStatus.rows,
      by_category:  byCategory.rows,
      recent:       recent.rows,
    });
  } catch (err) {
    console.error('complaints dashboard:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── LIST ──────────────────────────────────────────────────────────────────────
/**
 * The IPCS grid. Serves the 7 reference columns:
 *   IPCS ID | Site | Customer Name | Mobile | Product | Serial | IPS
 *
 * `page_size` is the IPS-grid spelling; `limit` is accepted as an alias so the
 * legacy AllComplaints grid keeps working until Phase 3 retires it. Likewise the
 * response keeps its {success, data, pagination} envelope rather than adopting
 * the IPS grid's flatter shape — changing it would break that page mid-build.
 */
router.get('/', svc('view'), async (req, res) => {
  try {
    const { where, params } = buildWhere(req);
    const sortCol = SORTABLE[req.query.sort] ?? 'c.created_at';
    const dir     = String(req.query.dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const lim     = Math.min(200, Math.max(1, parseInt(req.query.page_size ?? req.query.limit) || 50));
    const pg      = Math.max(1, parseInt(req.query.page) || 1);

    const [{ rows }, countRes] = await Promise.all([
      pool.query(`
        SELECT
          c.id, c.complaint_number, c.title, c.description,
          c.customer_name, c.customer_email, c.customer_phone,
          c.category, c.priority, c.status,
          c.assigned_to_name, c.resolved_at, c.created_at, c.updated_at,
          ${SLA_DUE_SQL}      AS sla_due,
          -- IPCS reference columns
          c.complaint_number  AS ipcs_id,
          ${SITENAME_SQL}     AS site,
          -- mobile (below) is the COALESCEd display value and may be a legacy
          -- customer_phone: formatted, or even a landline. customer_mobile is the
          -- raw validated column, and an edit form must bind to THAT one -- else
          -- opening a legacy row prefills an unvalidatable number and blocks
          -- saving an unrelated field.
          c.customer_mobile,
          ${MOBILE_SQL}       AS mobile,
          ${PRODUCT_SQL}      AS product,
          c.serial_number     AS serial,
          ips.ips_numbers     AS ips_numbers,
          ips.ips_ids         AS ips_ids,
          ips.ips_count       AS ips_count,
          -- traceability: complaint -> IPS -> IPP
          c.project_id, p.project_number AS ipp, c.product_line_id
        ${BASE_FROM}
        ${where}
        ORDER BY ${sortCol} ${dir} NULLS LAST, c.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, lim, (pg - 1) * lim]),
      pool.query(`SELECT COUNT(*)::int AS n ${BASE_FROM} ${where}`, params),
    ]);
    const total = countRes.rows[0]?.n ?? 0;

    res.json({
      success: true,
      data: rows,
      pagination: { page: pg, limit: lim, page_size: lim, total, totalPages: Math.ceil(total / lim) },
    });
  } catch (err) {
    console.error('complaints list:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── FILTER OPTIONS ────────────────────────────────────────────────────────────
// Registered ahead of GET /:id — Express would otherwise match this as id='filters'.
// Projects and product lines come from their masters, not from DISTINCT over
// complaints, so a valid choice with no complaint against it yet is still
// selectable. Both masters are company-scoped in their own right.
router.get('/filters', svc('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const [cats, projects, productLines] = await Promise.all([
      pool.query(
        `SELECT DISTINCT category FROM complaints
          WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
            AND category IS NOT NULL
          ORDER BY category`,
        [companyId]
      ),
      pool.query(
        `SELECT id, project_number, project_name
           FROM projects
          WHERE deleted_at IS NULL AND project_number IS NOT NULL
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY project_number`,
        [companyId]
      ),
      pool.query(
        `SELECT id, display_name
           FROM product_lines
          WHERE deleted_at IS NULL AND is_active = TRUE
            AND ($1::int IS NULL OR company_id = $1)
          ORDER BY display_name`,
        [companyId]
      ),
    ]);
    res.json({
      success: true,
      data: {
        statuses:      Object.keys(VALID_TRANSITIONS),
        priorities:    ['Critical', 'High', 'Medium', 'Low'],
        categories:    cats.rows.map(r => r.category),
        projects:      projects.rows,
        product_lines: productLines.rows,
      },
    });
  } catch (err) {
    console.error('complaints filters:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CATEGORIES (distinct + defaults) ─────────────────────────────────────────
router.get('/categories', svc('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(`
      SELECT DISTINCT category FROM complaints
      WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
        AND category IS NOT NULL
      ORDER BY category
    `, [companyId]);
    const defaults = ['Finance', 'HR', 'IT', 'Leave', 'Operations', 'Other', 'Payroll'];
    const fromDb   = rows.map(r => r.category);
    const merged   = [...new Set([...fromDb, ...defaults])].sort();
    res.json({ success: true, data: merged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CREATE ────────────────────────────────────────────────────────────────────
router.post('/', svc('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const {
      title, description, customer_name, customer_email, customer_phone,
      category = 'General', priority = 'Medium',
      project_id, product_line_id, serial_number,
    } = req.body;

    if (!title || !customer_name) {
      return res.status(400).json({ error: 'title and customer_name are required' });
    }

    // Mobile is optional, but a supplied one must be a real Indian mobile. The
    // server is the authority here even though the form mirrors the rule — the
    // stored value is the normalized 10 digits, never the formatted input.
    const mob = validateOptionalMobile(req.body.customer_mobile);
    if (!mob.ok) return res.status(400).json({ error: mob.error, field: 'customer_mobile' });

    const complaint_number = await nextComplaintNumber();

    const { rows } = await pool.query(`
      INSERT INTO complaints
        (complaint_number, title, description, customer_name, customer_email,
         customer_phone, customer_mobile, category, priority, status, created_by, company_id,
         project_id, product_line_id, serial_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10,$11,$12,$13,$14)
      RETURNING *
    `, [
      complaint_number, title, description, customer_name,
      customer_email, customer_phone, mob.value, category, priority,
      req.user?.userId || null,
      companyId,
      intOrNull(project_id), intOrNull(product_line_id), serial_number || null,
    ]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('complaints create:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE ────────────────────────────────────────────────────────────────────
/**
 * Field edit. Until now the module had NO edit route at all — only PUT /:id/status
 * (a transition) and POST /:id/comments — so a typo'd customer name was permanent.
 *
 * Routed through pickUpdatable rather than a hand-written column list: the guard
 * derives its allowlist from information_schema, so the four columns added by
 * 20260717000002 are editable without touching this route, and a column added by
 * the next migration will be too. A hand list silently drops new fields.
 *
 * `status` is protected here on purpose: it has a transition machine
 * (VALID_TRANSITIONS) and a history trail, and a generic SET would bypass both.
 * `complaint_number` is protected because it is a real, unprotected column — the
 * guard's PROTECTED set covers id/company_id/audit columns but not an identifier,
 * so without this a client could rewrite an IPCS number.
 */
router.put('/:id', svc('edit'), async (req, res) => {
  try {
    const companyId = cid(req);

    if (req.body.customer_mobile !== undefined) {
      const mob = validateOptionalMobile(req.body.customer_mobile);
      if (!mob.ok) return res.status(400).json({ error: mob.error, field: 'customer_mobile' });
      req.body.customer_mobile = mob.value;
    }

    const safe = await pickUpdatable('complaints', req.body, {
      protect: ['complaint_number', 'status', 'resolved_at'],
    });
    const keys = Object.keys(safe);
    if (!keys.length) return res.status(400).json({ error: 'No updatable fields supplied' });

    // Empty-string FKs from a cleared <select> must become NULL, not fail the cast.
    for (const k of ['project_id', 'product_line_id', 'assigned_to_id']) {
      if (k in safe) safe[k] = intOrNull(safe[k]);
    }

    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map(k => safe[k]);
    vals.push(req.params.id, companyId);

    const { rows } = await pool.query(
      `UPDATE complaints SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length - 1} AND deleted_at IS NULL
          AND ($${vals.length}::int IS NULL OR company_id = $${vals.length})
        RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Complaint not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error('complaints update:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── CONVERT TO IPS ────────────────────────────────────────────────────────────
/**
 * Escalate a complaint into a field-service (IPS) ticket.
 *
 * This is the writer the whole IPCS -> IPS -> IPP chain was missing. The FK
 * (support_tickets.complaint_id) has existed since 20260715000001, but no code
 * path ever set it, so the link was dead in practice: 0 of 14 tickets carried a
 * complaint_id, and the grid's "IPS" column could only ever say "No IPS".
 *
 * Carried over, so the engineer never retypes what the complaint already knows:
 *   complaint_id -> the link itself
 *   project_id   -> the IPP. Site AND product are inherited by IPS THROUGH this,
 *                   not copied: support_tickets has no product column by design
 *                   (the Phase 1 one was dropped in 20260716000003) because
 *                   projects owns the product line. Copying would create a second
 *                   truth that drifts.
 *   serial_number, title, description, priority
 *
 * NOT carried: customer_id / contact_id. Service's customer master is
 * accounts/contacts (20260717000001), but complaints only hold a free-text
 * customer_name and 0 of 5 match an account, so there is nothing honest to link.
 * Converted tickets therefore have no customer link — a known gap, recorded in
 * SERVICE_MASTER_IPCS_PLAN.md rather than papered over with a fuzzy name match.
 *
 * Converting twice is ALLOWED: a reopened complaint can legitimately escalate
 * again, which is exactly why the grid's IPS column aggregates. The frontend
 * shows existing tickets before offering the action.
 */
router.post('/:id/convert-to-ips', svc('add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req);

    // Scoped read first: a complaint from another company must 404, not convert.
    const { rows: found } = await client.query(
      `SELECT * FROM complaints
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!found.length) return res.status(404).json({ error: 'Complaint not found' });
    const c = found[0];

    // The ticket number is drawn inside the transaction: if the INSERT fails, the
    // sequence has still advanced (sequences are non-transactional) — a gap in
    // IPS numbering is acceptable, a duplicate would not be.
    await client.query('BEGIN');
    const ticket_number = await nextServiceTicketNumber(client);

    const { rows: ticket } = await client.query(
      `INSERT INTO support_tickets
         (ticket_number, title, description, status, priority, ticket_kind,
          complaint_id, project_id, serial_number, zone, service_type,
          requester_name, requester_email, company_id)
       VALUES ($1,$2,$3,'Open',$4,'service',$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        ticket_number,
        req.body.title       || c.title,
        req.body.description || c.description,
        req.body.priority    || c.priority,
        c.id,
        c.project_id,
        c.serial_number,
        ZONES.includes(req.body.zone) ? req.body.zone : null,
        PROJECT_TYPES.includes(req.body.service_type) ? req.body.service_type : null,
        req.user?.name || req.user?.email || null,
        req.user?.email || null,
        companyId,
      ]
    );

    // The escalation belongs in the complaint's own trail, not only the ticket's.
    // from_status = to_status: converting is not a transition, so the status
    // machine is untouched — this is a comment-shaped audit row, matching how
    // POST /:id/comments already records non-transition events.
    await client.query(
      `INSERT INTO complaint_history (complaint_id, from_status, to_status, comment, changed_by_name)
       VALUES ($1,$2,$2,$3,$4)`,
      [c.id, c.status, `Escalated to service ticket ${ticket_number}`,
       req.user?.name || req.user?.email || 'System']
    );

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: ticket[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('complaints convert-to-ips:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DETAIL ────────────────────────────────────────────────────────────────────
router.get('/:id', svc('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM complaints
       WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const { rows: history } = await pool.query(
      `SELECT * FROM complaint_history WHERE complaint_id = $1 ORDER BY created_at DESC`,
      [req.params.id]
    );

    res.json({ ...rows[0], history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STATUS UPDATE ─────────────────────────────────────────────────────────────
router.put('/:id/status', svc('edit'), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = cid(req);
    const { status: newStatus, comment, assigned_to_name } = req.body;
    const { rows } = await client.query(
      `SELECT status FROM complaints
       WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const currentStatus = rows[0].status;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot transition from '${currentStatus}' to '${newStatus}'`,
        allowed,
      });
    }

    await client.query('BEGIN');

    const updates = ['status = $1', 'updated_at = NOW()'];
    const vals    = [newStatus];

    if (newStatus === 'in_progress' && assigned_to_name) {
      vals.push(assigned_to_name);
      updates.push(`assigned_to_name = $${vals.length}`);
    }
    if (newStatus === 'resolved' || newStatus === 'closed') {
      updates.push('resolved_at = NOW()');
    }

    vals.push(req.params.id);
    await client.query(
      `UPDATE complaints SET ${updates.join(', ')} WHERE id = $${vals.length}`,
      vals
    );

    await client.query(
      `INSERT INTO complaint_history (complaint_id, from_status, to_status, comment, changed_by_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, currentStatus, newStatus, comment || null,
       req.user?.email || 'System']
    );

    await client.query('COMMIT');
    res.json({ success: true, from: currentStatus, to: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('complaints status:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── Add comment without status change ────────────────────────────────────────
router.post('/:id/comments', svc('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { comment } = req.body;
    if (!comment) return res.status(400).json({ error: 'comment is required' });
    const actor = req.user?.name || req.user?.email || 'User';
    const check = await pool.query(
      `SELECT status FROM complaints WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Complaint not found' });
    await pool.query(
      `INSERT INTO complaint_history (complaint_id, from_status, to_status, comment, changed_by_name)
       VALUES ($1,$2,$2,$3,$4)`,
      [req.params.id, check.rows[0].status, comment, actor]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Link complaint to NCR ─────────────────────────────────────────────────────
router.post('/:id/link-ncr', svc('edit'), async (req, res) => {
  try {
    const { ncr_id, root_cause, rca_method } = req.body;
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE complaints SET ncr_id=$1, root_cause=COALESCE($2,root_cause), rca_method=COALESCE($3,rca_method), updated_at=NOW()
       WHERE id=$4 AND ($5::int IS NULL OR company_id=$5) RETURNING id, complaint_number, ncr_id`,
      [ncr_id, root_cause, rca_method, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Complaint not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE (soft) ─────────────────────────────────────────────────────────────
router.delete('/:id', svc('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const result = await pool.query(
      `UPDATE complaints SET deleted_at = NOW()
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
