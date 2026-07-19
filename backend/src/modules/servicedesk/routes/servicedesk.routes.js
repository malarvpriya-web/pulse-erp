import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission, hasRole, rolesOf } from '../../../middlewares/auth.middleware.js';
import { validate } from '../../../services/ValidationEngineService.js';
import { evaluateRules } from '../../../services/RuleEngineService.js';
import { logAudit } from '../../../services/AuditService.js';
import { nextTicketNumber, nextServiceTicketNumber } from '../../../shared/docNumber.js';
import { PROJECT_TYPES } from '../../../shared/projectTypes.js';
import { pageParams } from '../../../shared/pagination.js';
import { validateOptionalMobile } from '../../../shared/validators.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

// Shared by both ticket kinds (Phase 0 decision 2). 'Analysis' is the IPS
// field-service step; helpdesk tickets never enter it.
const TICKET_STATUSES = ['Open', 'Analysis', 'In Progress', 'Pending', 'Resolved', 'Closed'];

// Compass regions — the app-wide convention (leads.zone already holds exactly
// these; projects.zone was realigned onto them in 20260716000003).
const ZONES = ['North', 'South', 'East', 'West', 'Central'];

// ── access model ──────────────────────────────────────────────────────────────
// Management endpoints (SLA config, engineers, contracts, customers, sites,
// service master, analytics, exports, all-ticket list) use requirePermission on
// the 'servicedesk' module — the same module the role matrix seeds. NOTE: these
// were historically checked against a 'service' module that is never seeded,
// which made the gate fail-open for every role (employees included).
//
// Self-service endpoints (a user's own tickets + knowledge base) can't use the
// coarse 'servicedesk' permission — employees are seeded servicedesk=NONE — so
// they are open to any authenticated user and scoped to the caller in-handler.
const svcAdmin = (action) => requirePermission('servicedesk', action);

// Roles that operate the service desk (see every ticket, manage config).
const SERVICE_STAFF_ROLES = new Set([
  'super_admin', 'admin', 'service_manager', 'service_engineer',
  // legacy coarse roles kept for backward compatibility
  'manager', 'hr',
]);
// rolesOf() unions every role the user holds. This previously read
// `req.user.role` — the PRIMARY role only — so someone provisioned as
// `employee` + `service_engineer` was not recognised as service staff and was
// treated as an ordinary requester: they could see only tickets raised from
// their own email address, not the queue they are meant to work.
//
// It fails safe (too little access, not too much), which is why it went
// unnoticed — but it silently breaks the multi-role setup the pilot will use,
// where an engineer holds `employee` for self-service plus a job role.
const isServiceStaff = (req) => rolesOf(req).some(r => SERVICE_STAFF_ROLES.has(r));

// Self-service passthrough — authentication is already guaranteed by verifyToken
// at mount; ownership is enforced in each handler.
const svcSelfService = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// Knowledge base is an admin-only tool: visible to super_admin/admin, hidden
// from every other role (employees included) — mirrors ADMIN_ONLY_PAGES in the
// frontend menuCatalog.
const KB_ROLES = ['super_admin', 'admin'];
const svcKnowledgeBase = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  // hasRole covers every role held — an admin whose primary role is something
  // else still gets in.
  if (!hasRole(req, KB_ROLES)) {
    return res.status(403).json({ error: 'Knowledge base is restricted to administrators' });
  }
  next();
};

// True when the caller may act on this ticket: service staff, or the requester.
const ownsTicket = (req, ticket) =>
  isServiceStaff(req) ||
  (!!ticket?.requester_email && ticket.requester_email === req.user?.email);

// ── table init ────────────────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_engineers (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT,
        phone      TEXT,
        skills     TEXT,
        zone       TEXT,
        status     TEXT DEFAULT 'Active',
        company_id INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS field_visits (
        id            SERIAL PRIMARY KEY,
        customer_name TEXT NOT NULL,
        address       TEXT,
        visit_date    DATE NOT NULL,
        visit_time    TEXT,
        engineer_name TEXT,
        purpose       TEXT,
        ticket_id     TEXT,
        status        TEXT DEFAULT 'Scheduled',
        notes         TEXT,
        company_id    INTEGER,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS service_contracts (
        id                 SERIAL PRIMARY KEY,
        customer_name      TEXT NOT NULL,
        contract_type      TEXT DEFAULT 'AMC',
        start_date         DATE NOT NULL,
        end_date           DATE NOT NULL,
        value              NUMERIC DEFAULT 0,
        sla_response_hrs   INTEGER DEFAULT 4,
        sla_resolution_hrs INTEGER DEFAULT 24,
        status             TEXT DEFAULT 'Active',
        notes              TEXT,
        company_id         INTEGER,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sla_policies (
        id                   SERIAL PRIMARY KEY,
        name                 TEXT NOT NULL,
        priority             TEXT NOT NULL,
        first_response_hours NUMERIC NOT NULL DEFAULT 4,
        resolution_hours     NUMERIC NOT NULL DEFAULT 24,
        escalation_hours     NUMERIC DEFAULT 8,
        business_hours_only  BOOLEAN DEFAULT true,
        company_id           INTEGER,
        created_at           TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS auto_assignment_rules (
        id                SERIAL PRIMARY KEY,
        name              TEXT NOT NULL,
        priority          INTEGER DEFAULT 10,
        conditions        JSONB DEFAULT '[]',
        assign_to_team    TEXT,
        assign_to_user_id INTEGER,
        round_robin_group TEXT,
        is_active         BOOLEAN DEFAULT true,
        company_id        INTEGER,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS csat_responses (
        id              SERIAL PRIMARY KEY,
        ticket_id       INTEGER REFERENCES support_tickets(id) ON DELETE SET NULL,
        ticket_subject  TEXT,
        rating          INTEGER CHECK(rating >= 1 AND rating <= 5),
        product_rating  INTEGER CHECK(product_rating  BETWEEN 1 AND 5),
        engineer_rating INTEGER CHECK(engineer_rating BETWEEN 1 AND 5),
        visited_on_time BOOLEAN,
        resolved        BOOLEAN,
        customer_name   TEXT,
        complaint_id    INTEGER,
        feedback        TEXT,
        agent_name      TEXT,
        company_id      INTEGER,
        responded_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS service_master (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        category    TEXT,
        description TEXT,
        price       NUMERIC DEFAULT 0,
        is_active   BOOLEAN DEFAULT true,
        company_id  INTEGER,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS service_sites (
        id            SERIAL PRIMARY KEY,
        name          TEXT NOT NULL,
        customer_id   INTEGER,
        customer_name TEXT,
        address       TEXT NOT NULL,
        city          TEXT,
        state         TEXT,
        pincode       TEXT,
        contact_name  TEXT,
        contact_phone TEXT,
        site_type     TEXT DEFAULT 'Office',
        status        TEXT DEFAULT 'Active',
        company_id    INTEGER,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS delivery_notes (
        id              SERIAL PRIMARY KEY,
        dn_number       TEXT UNIQUE,
        ticket_id       INTEGER,
        customer_name   TEXT NOT NULL,
        delivery_date   DATE NOT NULL,
        delivered_by    TEXT,
        items_delivered TEXT,
        status          TEXT DEFAULT 'Pending',
        notes           TEXT,
        company_id      INTEGER,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Backfill company_id column on tables that may have been created before this column was added
    await pool.query(`
      ALTER TABLE service_engineers     ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE service_engineers     ADD COLUMN IF NOT EXISTS employee_id INTEGER;
      ALTER TABLE field_visits          ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE service_contracts     ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE sla_policies          ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE auto_assignment_rules ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE csat_responses        ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE service_master        ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE service_sites         ADD COLUMN IF NOT EXISTS company_id INTEGER;
      ALTER TABLE delivery_notes        ADD COLUMN IF NOT EXISTS company_id INTEGER;
    `);

    // Self-heal the feedback->ticket FK on DBs where csat_responses was created
    // before it carried the constraint (PG has no ADD CONSTRAINT IF NOT EXISTS).
    // Mirrors migration 20260715000001; safe to run every boot.
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_csat_responses_ticket'
        ) THEN
          UPDATE csat_responses SET ticket_id = NULL
           WHERE ticket_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM support_tickets t WHERE t.id = csat_responses.ticket_id);
          ALTER TABLE csat_responses
            ADD CONSTRAINT fk_csat_responses_ticket
            FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  } catch (e) {
    console.error('Servicedesk table init error:', e.message);
  }
})();

// ── helpers ────────────────────────────────────────────────────────────────────
const safe = async (sql, params = []) => {
  try { return (await pool.query(sql, params)).rows; }
  catch { return []; }
};

const cid = (req) => companyOf(req);

// ── stats ──────────────────────────────────────────────────────────────────────
router.get('/stats', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const w = companyId != null
      ? 'WHERE company_id = $1 AND deleted_at IS NULL'
      : 'WHERE deleted_at IS NULL';
    const p = companyId != null ? [companyId] : [];

    const stats = await pool.query(`
      SELECT
        COUNT(*)                                                                      AS total,
        COUNT(*) FILTER (WHERE LOWER(status) = 'open')                               AS open,
        COUNT(*) FILTER (WHERE LOWER(status) = 'in progress')                        AS in_progress,
        COUNT(*) FILTER (WHERE LOWER(status) = 'resolved')                           AS resolved,
        COUNT(*) FILTER (WHERE LOWER(priority) = 'high')                             AS high_priority,
        COUNT(*) FILTER (WHERE created_at >= DATE_TRUNC('month', NOW()))             AS this_month,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')              AS this_week,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE LOWER(status) = 'resolved') /
          NULLIF(COUNT(*), 0), 1
        )                                                                             AS resolution_rate
      FROM support_tickets ${w}
    `, p);

    const byCategory = await pool.query(`
      SELECT INITCAP(LOWER(category)) AS category, COUNT(*) AS count
      FROM support_tickets ${w}
      GROUP BY INITCAP(LOWER(category)) ORDER BY count DESC
    `, p);

    const byPriority = await pool.query(`
      SELECT INITCAP(LOWER(priority)) AS priority, COUNT(*) AS count
      FROM support_tickets ${w}
      GROUP BY INITCAP(LOWER(priority))
      ORDER BY CASE INITCAP(LOWER(priority)) WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 ELSE 4 END
    `, p);

    const byTeamWhere = companyId != null
      ? 'WHERE company_id = $1 AND deleted_at IS NULL'
      : 'WHERE deleted_at IS NULL';
    const byTeam = await pool.query(`
      SELECT COALESCE(team, 'Unassigned') AS team,
             COUNT(*) AS count,
             COUNT(*) FILTER (WHERE LOWER(status) = 'open') AS open,
             COUNT(*) FILTER (WHERE LOWER(status) = 'in progress') AS in_progress,
             COUNT(*) FILTER (WHERE LOWER(status) IN ('resolved','closed')) AS closed
      FROM support_tickets ${byTeamWhere}
      GROUP BY COALESCE(team, 'Unassigned')
      ORDER BY count DESC
    `, p);

    const recent = await pool.query(`
      SELECT id, ticket_number, title, category, requester_name, priority, status, created_at
      FROM support_tickets ${w}
      ORDER BY created_at DESC LIMIT 5
    `, p);

    const agentWhere = companyId != null
      ? 'WHERE assigned_to IS NOT NULL AND company_id = $1 AND deleted_at IS NULL'
      : 'WHERE assigned_to IS NOT NULL AND deleted_at IS NULL';
    const byAgent = await pool.query(`
      SELECT assigned_to AS agent_name,
             COUNT(*) AS total_tickets,
             COUNT(*) FILTER (WHERE LOWER(status) = 'open') AS open_tickets,
             COUNT(*) FILTER (WHERE LOWER(status) = 'in progress') AS in_progress
      FROM support_tickets ${agentWhere}
      GROUP BY assigned_to
      ORDER BY open_tickets DESC
    `, p);

    const slaJoinCond = 'ON LOWER(sp.priority) = LOWER(t.priority)';
    const slaWhere = companyId != null
      ? 'WHERE t.company_id = $1 AND t.deleted_at IS NULL'
      : 'WHERE t.deleted_at IS NULL';
    const slaSummaryRaw = await pool.query(`
      SELECT
        CASE
          WHEN sp.id IS NULL THEN 'not_applicable'
          WHEN t.status IN ('Resolved','Closed')
            AND t.resolved_at <= t.created_at + sp.resolution_time_hours * INTERVAL '1 hour' THEN 'within_sla'
          WHEN t.status IN ('Resolved','Closed')
            AND t.resolved_at > t.created_at + sp.resolution_time_hours * INTERVAL '1 hour' THEN 'breached'
          WHEN t.status NOT IN ('Resolved','Closed')
            AND NOW() > t.created_at + sp.resolution_time_hours * INTERVAL '1 hour' THEN 'breached'
          WHEN t.status NOT IN ('Resolved','Closed')
            AND NOW() + INTERVAL '4 hours' > t.created_at + sp.resolution_time_hours * INTERVAL '1 hour' THEN 'at_risk'
          ELSE 'within_sla'
        END AS sla_cat,
        COUNT(*) AS count
      FROM support_tickets t
      LEFT JOIN sla_policies sp ${slaJoinCond}
      ${slaWhere}
      GROUP BY 1
    `, p).catch(() => ({ rows: [] }));
    const slaSummary = { within_sla: 0, breached: 0, at_risk: 0, not_applicable: 0 };
    for (const r of slaSummaryRaw.rows) {
      if (r.sla_cat in slaSummary) slaSummary[r.sla_cat] = parseInt(r.count);
    }

    const row = stats.rows[0] || {};
    res.json({
      total        : parseInt(row.total         || 0),
      open         : parseInt(row.open          || 0),
      inProgress   : parseInt(row.in_progress   || 0),
      resolved     : parseInt(row.resolved      || 0),
      highPriority : parseInt(row.high_priority || 0),
      thisMonth    : parseInt(row.this_month    || 0),
      thisWeek     : parseInt(row.this_week     || 0),
      resolutionRate: parseFloat(row.resolution_rate || 0),
      byCategory   : byCategory.rows,
      byPriority   : byPriority.rows,
      byTeam       : byTeam.rows,
      byAgent      : byAgent.rows,
      recent       : recent.rows,
      slaSummary,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── list all tickets ────────────────────────────────────────────────────────────
router.get('/tickets', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, priority, category, team, search, limit = 50, offset = 0, page } = req.query;
    const lim  = Math.min(200, Math.max(1, parseInt(limit)));
    const pg   = page ? Math.max(1, parseInt(page)) : null;
    const off  = pg ? (pg - 1) * lim : Math.max(0, parseInt(offset));
    const params = [companyId];
    let q = `SELECT * FROM support_tickets WHERE ($1::int IS NULL OR company_id = $1)`;

    if (status)   { params.push(status);          q += ` AND status = $${params.length}`; }
    if (priority) { params.push(priority);         q += ` AND priority = $${params.length}`; }
    if (category) { params.push(category);         q += ` AND category = $${params.length}`; }
    if (team)     { params.push(team);             q += ` AND team = $${params.length}`; }
    if (search)   { params.push(`%${search}%`);   q += ` AND (title ILIKE $${params.length} OR ticket_number ILIKE $${params.length} OR requester_name ILIKE $${params.length})`; }

    params.push(lim, off);
    q += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(q, params);

    const countQ = q.replace(/SELECT \*/, 'SELECT COUNT(*)').replace(/ORDER BY.*$/, '').replace(/LIMIT \$\d+ OFFSET \$\d+/, '');
    const count  = await pool.query(countQ, params.slice(0, -2)).catch(() => ({ rows: [{ count: 0 }] }));
    const total  = parseInt(count.rows[0]?.count || 0);

    res.json({
      tickets: result.rows,
      total,
      pagination: { page: pg ?? Math.floor(off / lim) + 1, limit: lim, total, totalPages: Math.ceil(total / lim) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── my tickets ─────────────────────────────────────────────────────────────────
router.get('/tickets/my', svcSelfService, async (req, res) => {
  try {
    const companyId = cid(req);
    const email = req.user?.email;
    if (!email) return res.json({ tickets: [] });
    // Bounded: a long-tenured requester accumulates tickets indefinitely, and
    // this returned all of them. Response shape is unchanged — page metadata
    // rides in headers so the 51 `Array.isArray(res.data) ? … : []` consumers
    // keep working. See shared/pagination.js.
    const p = pageParams(req, { defaultLimit: 200 });
    const result = await pool.query(
      `SELECT * FROM support_tickets
       WHERE requester_email = $1
         AND ($2::int IS NULL OR company_id = $2)
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [email, companyId, p.limit, p.offset]
    );
    res.setHeader('X-Page', p.page);
    res.setHeader('X-Page-Size', p.size);
    res.json({ tickets: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── single ticket ───────────────────────────────────────────────────────────────
router.get('/tickets/:id', svcSelfService, async (req, res) => {
  try {
    const companyId = cid(req);
    const ticket = await pool.query(
      `SELECT * FROM support_tickets
       WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!ticket.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    // Self-service: a non-staff requester may only read their own ticket.
    if (!ownsTicket(req, ticket.rows[0])) return res.status(403).json({ error: 'Not authorized to view this ticket' });

    const comments = await pool.query(
      `SELECT * FROM ticket_comments WHERE ticket_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );

    res.json({ ...ticket.rows[0], comments: comments.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── create ticket ───────────────────────────────────────────────────────────────
router.post('/tickets', svcSelfService, async (req, res) => {
  try {
    const { valid, errors } = await validate('service', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'service', errors });
    const companyId = cid(req);
    const { title, description, category, priority, team } = req.body;
    // Staff may raise a ticket on behalf of any requester; a self-service user
    // is always recorded as the requester (can't spoof someone else).
    const requester_name  = isServiceStaff(req) ? req.body.requester_name  : (req.user?.name  || req.body.requester_name);
    const requester_email = isServiceStaff(req) ? req.body.requester_email : (req.user?.email || req.body.requester_email);

    // helpdesk (TKT-####) vs field-service/IPS (IPS-#####). Only staff may raise
    // an IPS ticket — a self-service requester always lands on the helpdesk.
    const kind = (isServiceStaff(req) && req.body.ticket_kind === 'service') ? 'service' : 'helpdesk';
    const ticket_number = kind === 'service' ? await nextServiceTicketNumber() : await nextTicketNumber();

    // Linkage + field-service dimensions are staff-only for the same reason the
    // requester is pinned above: a self-service user must not be able to attach
    // their ticket to an arbitrary project/site/customer.
    const link = (v) => (isServiceStaff(req) && v !== undefined && v !== null && v !== '' ? v : null);
    const linkId = (v) => { const n = Number(link(v)); return Number.isInteger(n) && n > 0 ? n : null; };
    // Free text can never reach a taxonomy column: unknown values are rejected
    // rather than stored, which is what let the helpdesk's `category` drift.
    const oneOf = (v, allowed) => (allowed.includes(link(v)) ? link(v) : null);

    // No product_type: `projects` owns product line (Phase 0 decision 6) and IPS
    // inherits it through project_id. The Phase 1 column was dropped in
    // 20260716000003.
    const result = await pool.query(
      `INSERT INTO support_tickets
         (ticket_number, title, description, category, priority, status, team, requester_name, requester_email, company_id,
          ticket_kind, project_id, site_id, customer_id, serial_number, zone, service_type, issue_category_id, complaint_id)
       VALUES ($1,$2,$3,$4,$5,'Open',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [ticket_number, title, description, category, priority||'Medium', team, requester_name, requester_email, companyId,
       kind,
       linkId(req.body.project_id),
       linkId(req.body.site_id),
       linkId(req.body.customer_id),
       link(req.body.serial_number),
       oneOf(req.body.zone, ZONES),
       oneOf(req.body.service_type, PROJECT_TYPES),
       linkId(req.body.issue_category_id),
       // The complaint -> service-ticket link. The FK has existed since
       // 20260715000001 but nothing ever wrote it, so IPCS -> IPS -> IPP was
       // dead in practice (0/14 tickets linked). Staff-only via linkId, for the
       // same reason project_id is: a self-service requester must not be able to
       // attach their ticket to an arbitrary complaint.
       linkId(req.body.complaint_id)]
    );
    const ticket = result.rows[0];
    logAudit({ userId: req.user?.userId, module: 'service', recordId: ticket.id, recordType: 'support_ticket', action: 'create', newData: ticket, req });
    const ruleResults = await evaluateRules('service', ticket).catch(() => []);
    const ruleAlerts = ruleResults.filter(r => r.triggered);
    res.status(201).json({ ...ticket, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── update ticket ───────────────────────────────────────────────────────────────
router.put('/tickets/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const { valid, errors } = await validate('service', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'service', errors });
    const companyId = cid(req);
    const { title, description, status, priority, category, team, assigned_to,
            due_date, serial_number, customer_id, site_id, amc_contract_id, department,
            project_id, zone, service_type, issue_category_id } = req.body;
    const { rows: oldRows } = await pool.query(
      `SELECT * FROM support_tickets WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL`,
      [req.params.id, companyId]
    );
    if (!oldRows[0]) return res.status(404).json({ error: 'Ticket not found' });

    const wasOpen = oldRows[0].status !== 'Resolved' && oldRows[0].status !== 'Closed';
    const nowClosed = status === 'Closed';
    const nowResolved = status === 'Resolved';

    const result = await pool.query(
      `UPDATE support_tickets
       SET title=$1, description=$2, status=$3, priority=$4, category=$5, team=$6,
           assigned_to=$7,
           resolved_at = CASE WHEN $3='Resolved' AND resolved_at IS NULL THEN NOW() ELSE resolved_at END,
           closed_at   = CASE WHEN $3='Closed'   AND closed_at IS NULL   THEN NOW() ELSE closed_at   END,
           first_responded_at = CASE WHEN first_responded_at IS NULL AND $7 IS NOT NULL THEN NOW() ELSE first_responded_at END,
           due_date=$8, serial_number=$9, customer_id=$10, site_id=$11, amc_contract_id=$12,
           department=COALESCE($13, department),
           project_id=COALESCE($14, project_id),
           zone=COALESCE($15, zone),
           service_type=COALESCE($16, service_type),
           issue_category_id=COALESCE($17, issue_category_id),
           updated_at=NOW()
       WHERE id=$18 AND ($19::int IS NULL OR company_id = $19) RETURNING *`,
      [title, description, status, priority, category, team, assigned_to,
       due_date||null, serial_number||null, customer_id||null, site_id||null, amc_contract_id||null,
       department||null,
       // COALESCE, not bare overwrite, for the IPS columns: AllTickets.jsx edits
       // the same table and does not send these fields, so a plain assignment
       // would silently wipe the IPP link every time a service ticket was saved
       // from the helpdesk grid — the exact breakage Phase 1 exists to fix.
       // (title..amc_contract_id keep their pre-existing overwrite semantics.)
       // zone/service_type are dropped rather than stored when unrecognised, so
       // an unknown value leaves the previous one intact instead of corrupting it.
       project_id||null,
       ZONES.includes(zone) ? zone : null,
       PROJECT_TYPES.includes(service_type) ? service_type : null,
       issue_category_id||null,
       req.params.id, companyId]
    );
    // ticket_kind is deliberately not updatable: the kind picks the number
    // prefix at creation, so switching it would leave IPS-00001 on a helpdesk
    // ticket (or vice versa).
    const ticket = result.rows[0];
    logAudit({ userId: req.user?.userId, module: 'service', recordId: req.params.id, recordType: 'support_ticket', action: 'update', oldData: oldRows[0] ?? null, newData: ticket, req });

    // Auto-create CSAT request notification when ticket is resolved or closed
    if ((nowClosed || nowResolved) && wasOpen) {
      await pool.query(
        `INSERT INTO service_notifications (notification_type, reference_type, reference_id, title, body, severity, company_id)
         VALUES ('csat_request','support_ticket',$1,'CSAT Requested',$2,'info',$3)`,
        [ticket.id, `Please rate your experience for ticket ${ticket.ticket_number}`, companyId]
      ).catch(() => {});
    }

    const ruleResults = await evaluateRules('service', ticket).catch(() => []);
    const ruleAlerts = ruleResults.filter(r => r.triggered);
    res.json({ ...ticket, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── soft delete ticket ──────────────────────────────────────────────────────────
router.delete('/tickets/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE support_tickets SET deleted_at=NOW(), updated_at=NOW()
       WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) AND deleted_at IS NULL RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    logAudit({ userId: req.user?.userId, module: 'service', recordId: req.params.id, recordType: 'support_ticket', action: 'delete', req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ticket attachments ──────────────────────────────────────────────────────────
router.get('/tickets/:id/attachments', svcSelfService, async (req, res) => {
  try {
    const companyId = cid(req);
    // Verify ticket belongs to this company (and, for self-service, to the caller)
    const { rows: check } = await pool.query(
      `SELECT id, requester_email FROM support_tickets WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!check.length) return res.status(404).json({ error: 'Ticket not found' });
    if (!ownsTicket(req, check[0])) return res.status(403).json({ error: 'Not authorized for this ticket' });
    const { rows } = await pool.query(
      `SELECT * FROM ticket_attachments WHERE ticket_id=$1 ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/tickets/:id/attachments', svcSelfService, async (req, res) => {
  try {
    const companyId = cid(req);
    const { filename, original_name, mime_type, file_size, url } = req.body;
    if (!url || !original_name) return res.status(422).json({ error: 'url and original_name are required' });
    const { rows: check } = await pool.query(
      `SELECT id, requester_email FROM support_tickets WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!check.length) return res.status(404).json({ error: 'Ticket not found' });
    if (!ownsTicket(req, check[0])) return res.status(403).json({ error: 'Not authorized for this ticket' });
    const { rows } = await pool.query(
      `INSERT INTO ticket_attachments (ticket_id, filename, original_name, mime_type, file_size, url, uploaded_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, filename||original_name, original_name, mime_type||null, file_size||null,
       url, req.user?.name||req.user?.email||'Agent', companyId]
    );
    await pool.query(`UPDATE support_tickets SET attachment_count=attachment_count+1, updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/tickets/:ticketId/attachments/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `DELETE FROM ticket_attachments
       WHERE id=$1 AND ticket_id=$2 AND ($3::int IS NULL OR company_id=$3) RETURNING id`,
      [req.params.id, req.params.ticketId, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Attachment not found' });
    await pool.query(`UPDATE support_tickets SET attachment_count=GREATEST(0,attachment_count-1) WHERE id=$1`, [req.params.ticketId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── add comment ─────────────────────────────────────────────────────────────────
router.post('/tickets/:id/comments', svcSelfService, async (req, res) => {
  try {
    const { valid, errors } = await validate('service', req.body);
    if (!valid) return res.status(422).json({ error: 'Validation failed', code: 'VALIDATION_ERROR', module: 'service', errors });
    const companyId = cid(req);
    const { body, is_internal } = req.body;
    const author = req.user?.name || req.user?.email || 'Agent';
    const staff = isServiceStaff(req);

    // Verify ticket belongs to this company (and, for self-service, to the caller)
    const { rows: check } = await pool.query(
      `SELECT id, requester_email FROM support_tickets WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!check.length) return res.status(404).json({ error: 'Ticket not found' });
    if (!ownsTicket(req, check[0])) return res.status(403).json({ error: 'Not authorized for this ticket' });

    const result = await pool.query(
      `INSERT INTO ticket_comments (ticket_id, author, body, is_internal) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, author, body, staff ? (is_internal || false) : false]
    );
    await pool.query(`UPDATE support_tickets SET updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── filter options (categories, teams, priorities) ─────────────────────────────
router.get('/filters', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const cats  = await safe(
      `SELECT DISTINCT category FROM support_tickets WHERE category IS NOT NULL AND ($1::int IS NULL OR company_id = $1) ORDER BY category`,
      [companyId]
    );
    const teams = await safe(
      `SELECT DISTINCT team FROM support_tickets WHERE team IS NOT NULL AND ($1::int IS NULL OR company_id = $1) ORDER BY team`,
      [companyId]
    );
    res.json({
      categories : cats.map(r => r.category),
      teams      : teams.map(r => r.team),
      priorities : ['Low', 'Medium', 'High', 'Critical'],
      // 'Analysis' is the IPS field-service step; both kinds share one status
      // list and helpdesk tickets simply never enter it (Phase 0 decision 2).
      statuses   : TICKET_STATUSES,
      // IPS grid options. service_type mirrors the project-type list because an
      // IPS ticket traces back to an IPP — but it is set PER TICKET, not
      // inherited: an EPC project can legitimately raise a Commissioning ticket.
      service_types : PROJECT_TYPES,
      zones         : ZONES,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── service engineers ──────────────────────────────────────────────────────────
router.get('/engineers', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { limit = 100, offset = 0, search } = req.query;
    const p = [companyId];
    let q = `SELECT se.*,
      COALESCE((
        SELECT COUNT(*) FROM field_visits fv
        WHERE LOWER(fv.engineer_name) = LOWER(se.name)
          AND fv.status NOT IN ('Completed','Cancelled')
          AND ($1::int IS NULL OR fv.company_id = $1)
      ), 0) AS active_visits
    FROM service_engineers se WHERE ($1::int IS NULL OR se.company_id = $1)`;
    if (search) { p.push(`%${search}%`); q += ` AND (se.name ILIKE $${p.length} OR se.skills ILIKE $${p.length} OR se.zone ILIKE $${p.length})`; }
    p.push(parseInt(limit)); p.push(parseInt(offset));
    q += ` ORDER BY se.name ASC LIMIT $${p.length - 1} OFFSET $${p.length}`;
    const result = await pool.query(q, p);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── employee list for engineer form autocomplete ───────────────────────────────
router.get('/employees-list', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT id, name, email, phone, department FROM employees
       WHERE ($1::int IS NULL OR company_id = $1) AND status IN ('active','probation','notice')
       ORDER BY name ASC`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/engineers', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, email, phone, skills, zone, status, employee_id } = req.body;
    if (!name) return res.status(422).json({ error: 'Name is required' });
    const skillsStr = Array.isArray(skills) ? skills.join(', ') : (skills || null);
    const result = await pool.query(
      `INSERT INTO service_engineers (name, email, phone, skills, zone, status, employee_id, company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, email || null, phone || null, skillsStr, zone || null, status || 'Active', employee_id || null, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: result.rows[0].id, recordType: 'service_engineer', action: 'create', newData: result.rows[0], req });
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/engineers/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, email, phone, skills, zone, status, employee_id } = req.body;
    const skillsStr = Array.isArray(skills) ? skills.join(', ') : (skills || null);
    const result = await pool.query(
      `UPDATE service_engineers SET name=$1, email=$2, phone=$3, skills=$4, zone=$5, status=$6, employee_id=$7
       WHERE id=$8 AND ($9::int IS NULL OR company_id = $9) RETURNING *`,
      [name, email || null, phone || null, skillsStr, zone || null, status || 'Active', employee_id || null, req.params.id, companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Engineer not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── field visits ───────────────────────────────────────────────────────────────
router.get('/field-visits', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { limit = 100, offset = 0, search, date, status } = req.query;
    const p = [companyId];
    let q = `SELECT * FROM field_visits WHERE ($1::int IS NULL OR company_id = $1)`;
    if (status) { p.push(status); q += ` AND status = $${p.length}`; }
    if (search) { p.push(`%${search}%`); q += ` AND (customer_name ILIKE $${p.length} OR engineer_name ILIKE $${p.length} OR purpose ILIKE $${p.length})`; }
    if (date)   { p.push(date); q += ` AND visit_date = $${p.length}`; }
    p.push(parseInt(limit)); p.push(parseInt(offset));
    q += ` ORDER BY visit_date DESC, visit_time ASC LIMIT $${p.length - 1} OFFSET $${p.length}`;
    res.json((await pool.query(q, p)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/field-visits', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { customer_name, address, visit_date, visit_time, engineer_name, purpose, ticket_id } = req.body;
    if (!customer_name || !visit_date) return res.status(422).json({ error: 'Customer name and visit date are required' });

    if (engineer_name && visit_time) {
      const clash = await pool.query(
        `SELECT id FROM field_visits WHERE engineer_name=$1 AND visit_date=$2 AND visit_time=$3
           AND status NOT IN ('Cancelled','Completed')
           AND ($4::int IS NULL OR company_id = $4)`,
        [engineer_name, visit_date, visit_time, companyId]
      );
      if (clash.rows.length > 0) return res.status(422).json({ error: `${engineer_name} already has a visit scheduled at ${visit_time} on ${visit_date}` });
    }

    const result = await pool.query(
      `INSERT INTO field_visits (customer_name, address, visit_date, visit_time, engineer_name, purpose, ticket_id, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [customer_name, address || null, visit_date, visit_time || null, engineer_name || null, purpose || null, ticket_id || null, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: result.rows[0].id, recordType: 'field_visit', action: 'create', newData: result.rows[0], req });
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/field-visits/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, notes, engineer_name, visit_date, visit_time, purpose } = req.body;
    const existing = await pool.query(
      `SELECT * FROM field_visits WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, companyId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Visit not found' });
    const row = existing.rows[0];
    const result = await pool.query(
      `UPDATE field_visits SET status=$1, notes=$2, engineer_name=$3, visit_date=$4, visit_time=$5, purpose=$6, updated_at=NOW()
       WHERE id=$7 AND ($8::int IS NULL OR company_id = $8) RETURNING *`,
      [status || row.status, notes ?? row.notes, engineer_name ?? row.engineer_name, visit_date || row.visit_date, visit_time ?? row.visit_time, purpose ?? row.purpose, req.params.id, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: req.params.id, recordType: 'field_visit', action: 'update', oldData: row, newData: result.rows[0], req });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── service contracts ──────────────────────────────────────────────────────────
router.get('/contracts', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { limit = 100, offset = 0, search } = req.query;
    const p = [companyId];
    let q = `SELECT * FROM service_contracts WHERE ($1::int IS NULL OR company_id = $1)`;
    if (search) { p.push(`%${search}%`); q += ` AND (customer_name ILIKE $${p.length} OR contract_type ILIKE $${p.length})`; }
    p.push(parseInt(limit)); p.push(parseInt(offset));
    q += ` ORDER BY created_at DESC LIMIT $${p.length - 1} OFFSET $${p.length}`;
    res.json((await pool.query(q, p)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/contracts', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { customer_name, contract_type, start_date, end_date, value, sla_response_hrs, sla_resolution_hrs, notes } = req.body;
    if (!customer_name || !start_date || !end_date) return res.status(422).json({ error: 'Customer name, start date and end date are required' });
    const today = new Date().toISOString().slice(0, 10);
    const status = end_date < today ? 'Expired' : 'Active';
    const result = await pool.query(
      `INSERT INTO service_contracts (customer_name, contract_type, start_date, end_date, value, sla_response_hrs, sla_resolution_hrs, status, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [customer_name, contract_type || 'AMC', start_date, end_date, Number(value) || 0, parseInt(sla_response_hrs) || 4, parseInt(sla_resolution_hrs) || 24, status, notes || null, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: result.rows[0].id, recordType: 'service_contract', action: 'create', newData: result.rows[0], req });
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── contracts edit / delete ────────────────────────────────────────────────────
router.put('/contracts/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { customer_name, contract_type, start_date, end_date, value, sla_response_hrs, sla_resolution_hrs, notes } = req.body;
    const { rows: old } = await pool.query(
      `SELECT * FROM service_contracts WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!old[0]) return res.status(404).json({ error: 'Contract not found' });
    const today = new Date().toISOString().slice(0, 10);
    const ed = end_date || old[0].end_date;
    const status = ed < today ? 'Expired' : 'Active';
    const { rows } = await pool.query(
      `UPDATE service_contracts
       SET customer_name=$1, contract_type=$2, start_date=$3, end_date=$4, value=$5,
           sla_response_hrs=$6, sla_resolution_hrs=$7, notes=$8, status=$9
       WHERE id=$10 AND ($11::int IS NULL OR company_id=$11) RETURNING *`,
      [customer_name||old[0].customer_name, contract_type||old[0].contract_type,
       start_date||old[0].start_date, ed, Number(value)??old[0].value,
       parseInt(sla_response_hrs)||old[0].sla_response_hrs, parseInt(sla_resolution_hrs)||old[0].sla_resolution_hrs,
       notes??old[0].notes, status, req.params.id, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: req.params.id, recordType: 'service_contract', action: 'update', oldData: old[0], newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/contracts/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `DELETE FROM service_contracts WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Contract not found' });
    logAudit({ userId: req.user?.userId, module: 'service', recordId: req.params.id, recordType: 'service_contract', action: 'delete', req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SLA policies ───────────────────────────────────────────────────────────────
router.get('/sla/policies', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const policies = await pool.query(
      `SELECT * FROM sla_policies WHERE ($1::int IS NULL OR company_id = $1)
       ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END`,
      [companyId]
    );
    const counts = await safe(
      `SELECT LOWER(priority) AS priority, COUNT(*) FILTER (WHERE status NOT IN ('Resolved','Closed')) AS active_tickets
       FROM support_tickets WHERE ($1::int IS NULL OR company_id = $1) GROUP BY priority`,
      [companyId]
    );
    const countMap = Object.fromEntries(counts.map(r => [r.priority, parseInt(r.active_tickets)]));
    res.json(policies.rows.map(p => ({ ...p, active_tickets: countMap[p.priority?.toLowerCase()] || 0 })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sla/policies', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, priority, first_response_hours, resolution_hours, escalation_hours, business_hours_only } = req.body;
    if (!name || !priority) return res.status(422).json({ error: 'Name and priority are required' });
    const result = await pool.query(
      `INSERT INTO sla_policies (name, priority, first_response_hours, resolution_hours, escalation_hours, business_hours_only, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, priority.toLowerCase(), Number(first_response_hours)||4, Number(resolution_hours)||24, Number(escalation_hours)||8, business_hours_only ?? true, companyId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/sla/policies/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, priority, first_response_hours, resolution_hours, escalation_hours, business_hours_only } = req.body;
    const { rows } = await pool.query(
      `UPDATE sla_policies
       SET name=$1, priority=$2, first_response_hours=$3, resolution_hours=$4,
           escalation_hours=$5, business_hours_only=$6
       WHERE id=$7 AND ($8::int IS NULL OR company_id=$8) RETURNING *`,
      [name, priority?.toLowerCase(), Number(first_response_hours)||4, Number(resolution_hours)||24,
       Number(escalation_hours)||8, business_hours_only ?? true, req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/sla/policies/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `DELETE FROM sla_policies WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Policy not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SLA breaches (live computation) ────────────────────────────────────────────
router.get('/sla/breaches', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const result = await pool.query(`
      SELECT
        t.id       AS ticket_id,
        t.title    AS subject,
        t.status   AS ticket_status,
        LOWER(t.priority) AS priority,
        t.requester_name  AS customer_name,
        COALESCE(p.name, t.priority || ' SLA') AS policy_name,
        ROUND(CAST(EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 3600 AS NUMERIC), 2) AS elapsed_hours,
        COALESCE(p.first_response_hours,
          CASE LOWER(t.priority) WHEN 'critical' THEN 0.5 WHEN 'high' THEN 1 WHEN 'medium' THEN 4 ELSE 8 END
        ) AS first_response_hours,
        COALESCE(p.resolution_hours,
          CASE LOWER(t.priority) WHEN 'critical' THEN 4 WHEN 'high' THEN 8 WHEN 'medium' THEN 24 ELSE 72 END
        ) AS resolution_hours
      FROM support_tickets t
      LEFT JOIN sla_policies p ON LOWER(p.priority) = LOWER(t.priority)
        AND ($1::int IS NULL OR p.company_id = $1)
      WHERE t.status NOT IN ('Resolved', 'Closed')
        AND ($1::int IS NULL OR t.company_id = $1)
    `, [companyId]);

    const breaches = result.rows
      .map(r => {
        const elapsed = parseFloat(r.elapsed_hours);
        const fr      = parseFloat(r.first_response_hours);
        const res_h   = parseFloat(r.resolution_hours);
        const frRemaining  = fr  - elapsed;
        const resRemaining = res_h - elapsed;
        const frBreached   = elapsed > fr;
        const resBreached  = elapsed > res_h;
        const atRisk       = !frBreached && !resBreached && (frRemaining <= 2 || resRemaining <= 2);
        return { ...r,
          first_response_hours_remaining : Math.round(frRemaining  * 10) / 10,
          resolution_hours_remaining     : Math.round(resRemaining * 10) / 10,
          first_response_breached_now    : frBreached,
          resolution_breached_now        : resBreached,
          at_risk                        : atRisk,
        };
      })
      .filter(r => r.first_response_breached_now || r.resolution_breached_now || r.at_risk);

    res.json(breaches);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SLA compliance ─────────────────────────────────────────────────────────────
router.get('/sla/compliance', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const result = await pool.query(`
      SELECT
        LOWER(t.priority) AS priority,
        COALESCE(p.name, t.priority || ' SLA') AS policy_name,
        COUNT(*) AS total_tickets,
        COUNT(*) FILTER (
          WHERE t.resolved_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 <=
                COALESCE(p.resolution_hours,
                  CASE LOWER(t.priority) WHEN 'critical' THEN 4 WHEN 'high' THEN 8 WHEN 'medium' THEN 24 ELSE 72 END)
        ) AS met,
        COUNT(*) FILTER (
          WHERE t.resolved_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 3600 >
                COALESCE(p.resolution_hours,
                  CASE LOWER(t.priority) WHEN 'critical' THEN 4 WHEN 'high' THEN 8 WHEN 'medium' THEN 24 ELSE 72 END)
        ) AS breached
      FROM support_tickets t
      LEFT JOIN sla_policies p ON LOWER(p.priority) = LOWER(t.priority)
        AND ($1::int IS NULL OR p.company_id = $1)
      WHERE t.resolved_at IS NOT NULL
        AND ($1::int IS NULL OR t.company_id = $1)
      GROUP BY LOWER(t.priority), p.name
      ORDER BY CASE LOWER(t.priority) WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END
    `, [companyId]);

    const rows = result.rows.map(r => ({
      ...r,
      total_tickets: parseInt(r.total_tickets),
      met          : parseInt(r.met),
      breached     : parseInt(r.breached),
      met_pct      : r.total_tickets > 0
        ? Math.round((parseInt(r.met) / parseInt(r.total_tickets)) * 1000) / 10
        : 100,
    }));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CSAT summary ───────────────────────────────────────────────────────────────
router.get('/csat/summary', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const [overall, byAgent, trend, recent] = await Promise.all([
      pool.query(`
        SELECT ROUND(AVG(rating)::NUMERIC, 1) AS avg_rating,
               COUNT(*) AS total_responses,
               ROUND(
                 (100.0 * COUNT(*) FILTER (WHERE rating >= 4) -
                          COUNT(*) FILTER (WHERE rating <= 2))
                 / NULLIF(COUNT(*), 0), 0
               ) AS nps_score
        FROM csat_responses
        WHERE ($1::int IS NULL OR company_id = $1)
      `, [companyId]),
      pool.query(`
        SELECT agent_name, ROUND(AVG(rating)::NUMERIC, 1) AS avg_rating, COUNT(*) AS response_count
        FROM csat_responses
        WHERE agent_name IS NOT NULL AND ($1::int IS NULL OR company_id = $1)
        GROUP BY agent_name ORDER BY avg_rating DESC
      `, [companyId]),
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', responded_at), 'YYYY-MM') AS month,
               ROUND(AVG(rating)::NUMERIC, 1) AS avg_rating, COUNT(*) AS count
        FROM csat_responses
        WHERE ($1::int IS NULL OR company_id = $1)
        GROUP BY 1 ORDER BY 1 DESC LIMIT 6
      `, [companyId]),
      pool.query(`
        SELECT ticket_id, ticket_subject, rating, feedback, responded_at
        FROM csat_responses
        WHERE ($1::int IS NULL OR company_id = $1)
        ORDER BY responded_at DESC LIMIT 5
      `, [companyId]),
    ]);
    const o = overall.rows[0] || {};
    const distribution = await pool.query(
      `SELECT rating, COUNT(*) AS count FROM csat_responses
       WHERE ($1::int IS NULL OR company_id = $1) GROUP BY rating ORDER BY rating`,
      [companyId]
    );
    res.json({
      avg_rating      : o.avg_rating || '0.0',
      total_responses : parseInt(o.total_responses || 0),
      nps_score       : parseInt(o.nps_score || 0),
      distribution    : distribution.rows.map(r => ({ rating: parseInt(r.rating), count: parseInt(r.count) })),
      by_agent        : byAgent.rows,
      monthly_trend   : trend.rows,
      recent_feedback : recent.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SLA status summary (dashboard widget) ──────────────────────────────────────
router.get('/sla/status', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const result = await pool.query(`
      SELECT
        CASE
          WHEN sp.id IS NULL THEN 'not_applicable'
          WHEN t.status IN ('Resolved','Closed')
            AND t.resolved_at <= t.created_at + sp.resolution_hours * INTERVAL '1 hour' THEN 'within_sla'
          WHEN t.status IN ('Resolved','Closed')
            AND t.resolved_at > t.created_at + sp.resolution_hours * INTERVAL '1 hour' THEN 'breached'
          WHEN t.status NOT IN ('Resolved','Closed')
            AND NOW() > t.created_at + sp.resolution_hours * INTERVAL '1 hour' THEN 'breached'
          WHEN t.status NOT IN ('Resolved','Closed')
            AND NOW() + INTERVAL '4 hours' > t.created_at + sp.resolution_hours * INTERVAL '1 hour' THEN 'at_risk'
          ELSE 'within_sla'
        END AS sla_status,
        COUNT(*) AS count
      FROM support_tickets t
      LEFT JOIN sla_policies sp
        ON LOWER(sp.priority) = LOWER(t.priority)
        AND ($1::int IS NULL OR sp.company_id = $1)
      WHERE ($1::int IS NULL OR t.company_id = $1)
        AND t.deleted_at IS NULL
      GROUP BY 1
    `, [companyId]);

    const map = { within_sla: 0, breached: 0, at_risk: 0, not_applicable: 0 };
    for (const r of result.rows) {
      if (r.sla_status in map) map[r.sla_status] = parseInt(r.count);
    }
    res.json(map);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── auto-assignment rules ──────────────────────────────────────────────────────
router.get('/auto-assignment-rules', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    res.json((await pool.query(
      `SELECT * FROM auto_assignment_rules
       WHERE ($1::int IS NULL OR company_id = $1)
       ORDER BY priority ASC`,
      [companyId]
    )).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/auto-assignment-rules', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, priority, conditions, assign_to_team, assign_to_user_id, round_robin_group } = req.body;
    if (!name) return res.status(422).json({ error: 'Rule name is required' });
    const result = await pool.query(
      `INSERT INTO auto_assignment_rules (name, priority, conditions, assign_to_team, assign_to_user_id, round_robin_group, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, parseInt(priority) || 10, JSON.stringify(conditions || []), assign_to_team || null, assign_to_user_id || null, round_robin_group || null, companyId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/auto-assignment-rules/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, priority, conditions, assign_to_team, assign_to_user_id, round_robin_group, is_active } = req.body;
    const { rows } = await pool.query(
      `UPDATE auto_assignment_rules
       SET name=$1, priority=$2, conditions=$3, assign_to_team=$4, assign_to_user_id=$5,
           round_robin_group=$6, is_active=$7
       WHERE id=$8 AND ($9::int IS NULL OR company_id=$9) RETURNING *`,
      [name, parseInt(priority)||10, JSON.stringify(conditions||[]), assign_to_team||null,
       assign_to_user_id||null, round_robin_group||null, is_active !== false,
       req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rule not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/auto-assignment-rules/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `DELETE FROM auto_assignment_rules WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rule not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── auto-assign preview ────────────────────────────────────────────────────────
router.post('/tickets/auto-assign/preview', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const ticket = req.body.ticket_data || req.body;
    const rules  = (await pool.query(
      `SELECT * FROM auto_assignment_rules WHERE is_active=true AND ($1::int IS NULL OR company_id = $1) ORDER BY priority ASC`,
      [companyId]
    )).rows;

    const matched = rules.find(rule => {
      const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
      if (!conds.length) return true;
      return conds.every(c => {
        const val = (ticket[c.field] || '').toString().toLowerCase();
        const cv  = (c.value || '').toLowerCase();
        if (c.operator === 'equals')   return val === cv;
        if (c.operator === 'contains') return val.includes(cv);
        return false;
      });
    });

    if (matched) {
      res.json({ assigned: true, rule: matched, message: `Matched: ${matched.name} → ${matched.assign_to_team || `User #${matched.assign_to_user_id}`}` });
    } else {
      res.json({ assigned: false, message: 'No rule matched — ticket will remain unassigned' });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── service master ─────────────────────────────────────────────────────────────
router.get('/service-master', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    res.json((await pool.query(
      `SELECT id, name, category, description, price, is_active, created_at FROM service_master
       WHERE ($1::int IS NULL OR company_id = $1)
       ORDER BY category, name`,
      [companyId]
    )).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/service-master', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, category, description, price } = req.body;
    if (!name) return res.status(422).json({ error: 'Service name is required' });
    const result = await pool.query(
      `INSERT INTO service_master (name, category, description, price, company_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, category || null, description || null, Number(price) || 0, companyId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/service-master/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, category, description, price, is_active } = req.body;
    if (!name) return res.status(422).json({ error: 'Service name is required' });
    const { rows } = await pool.query(
      `UPDATE service_master
       SET name=$1, category=$2, description=$3, price=$4, is_active=$5
       WHERE id=$6 AND ($7::int IS NULL OR company_id=$7) RETURNING *`,
      [name, category || null, description || null, Number(price) || 0,
       is_active !== false, req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Service not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/service-master/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE service_master SET is_active=false
       WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Service not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── customers ──────────────────────────────────────────────────────────────────
// Backed by the CRM master: accounts(company) 1-N contacts(person). The old
// `service_customers` table was a FK-less duplicate at the wrong grain and is no
// longer read — see migration 20260717000001. These stay on the 'servicedesk'
// permission (not 'crm') so service staff can manage customers without being
// granted CRM rights; the underlying rows are the same ones CRM edits.
const CUSTOMER_ROLES = ['User', 'Admin'];

// Whitelisted sort keys -> SQL. Never interpolate req.query into ORDER BY.
const CUSTOMER_SORTS = {
  id:            'c.id',
  name:          'c.full_name',
  email:         'c.email',
  mobile:        'c.mobile',
  customer_role: 'c.customer_role',
  account_name:  'account_name',
  created_at:    'c.created_at',
};

// Shared projection so list/create/update all return the same row shape.
const CUSTOMER_COLS = `
  c.id,
  c.full_name     AS name,
  c.first_name,
  c.last_name,
  c.email,
  c.mobile,
  c.phone,
  c.photo_url,
  COALESCE(c.customer_role, 'User') AS customer_role,
  c.designation,
  c.account_id,
  c.is_primary,
  c.created_at,
  COALESCE(a.name, a.account_name) AS account_name
`;

router.get('/customers', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { search, account_id, limit = 100, offset = 0 } = req.query;
    const sortCol = CUSTOMER_SORTS[req.query.sort] || 'c.full_name';
    const sortDir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const p = [companyId, account_id || null, (search || '').trim()];
    p.push(parseInt(limit) || 100, parseInt(offset) || 0);

    const { rows } = await pool.query(
      `SELECT ${CUSTOMER_COLS},
              (SELECT COUNT(*) FROM support_tickets t
                WHERE t.contact_id = c.id AND t.deleted_at IS NULL) AS ticket_count,
              (SELECT COUNT(*) FROM support_tickets t
                WHERE t.contact_id = c.id AND t.deleted_at IS NULL
                  AND t.status NOT IN ('Resolved','Closed'))         AS open_ticket_count
         FROM contacts c
         LEFT JOIN accounts a ON a.id = c.account_id
        WHERE c.deleted_at IS NULL
          AND ($1::int IS NULL OR c.company_id = $1)
          AND ($2::int IS NULL OR c.account_id = $2::int)
          AND ($3 = '' OR c.full_name ILIKE '%'||$3||'%'
                       OR COALESCE(c.email,'')  ILIKE '%'||$3||'%'
                       OR COALESCE(c.mobile,'') ILIKE '%'||$3||'%'
                       OR COALESCE(a.name, a.account_name) ILIKE '%'||$3||'%')
        ORDER BY ${sortCol} ${sortDir} NULLS LAST, c.id ASC
        LIMIT $4 OFFSET $5`,
      p
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Split a submitted display name into the first/last the contacts table stores.
const splitName = (name) => {
  const parts = String(name || '').trim().split(/\s+/);
  return { first: parts.shift() || '', last: parts.join(' ') };
};

router.post('/customers', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, email, mobile, phone, account_id, designation, photo_url, customer_role } = req.body;
    if (!name?.trim()) return res.status(422).json({ error: 'Customer name is required' });

    const mob = validateOptionalMobile(mobile);
    if (!mob.ok) return res.status(422).json({ error: mob.error });
    if (customer_role && !CUSTOMER_ROLES.includes(customer_role)) {
      return res.status(422).json({ error: `Role must be one of: ${CUSTOMER_ROLES.join(', ')}` });
    }

    const { first, last } = splitName(name);
    const { rows } = await pool.query(
      `INSERT INTO contacts
         (first_name, last_name, full_name, email, mobile, phone, account_id,
          designation, photo_url, customer_role, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [first, last, name.trim(), email || null, mob.value, phone || null,
       account_id || null, designation || null, photo_url || null,
       customer_role || 'User', companyId]
    );
    const created = await pool.query(
      `SELECT ${CUSTOMER_COLS} FROM contacts c
         LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id = $1`,
      [rows[0].id]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: rows[0].id, recordType: 'contact', action: 'create', newData: created.rows[0], req });
    res.status(201).json(created.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/customers/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, email, mobile, phone, account_id, designation, photo_url, customer_role } = req.body;
    if (!name?.trim()) return res.status(422).json({ error: 'Customer name is required' });

    const mob = validateOptionalMobile(mobile);
    if (!mob.ok) return res.status(422).json({ error: mob.error });
    if (customer_role && !CUSTOMER_ROLES.includes(customer_role)) {
      return res.status(422).json({ error: `Role must be one of: ${CUSTOMER_ROLES.join(', ')}` });
    }

    const before = await pool.query(
      `SELECT * FROM contacts WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id=$2)`,
      [req.params.id, companyId]
    );
    if (!before.rows[0]) return res.status(404).json({ error: 'Customer not found' });

    const { first, last } = splitName(name);
    await pool.query(
      `UPDATE contacts
          SET first_name=$1, last_name=$2, full_name=$3, email=$4, mobile=$5,
              phone=$6, account_id=$7, designation=$8, photo_url=$9,
              customer_role=$10, updated_at=NOW()
        WHERE id=$11 AND deleted_at IS NULL AND ($12::int IS NULL OR company_id=$12)`,
      [first, last, name.trim(), email || null, mob.value, phone || null,
       account_id || null, designation || null, photo_url || null,
       customer_role || 'User', req.params.id, companyId]
    );
    const updated = await pool.query(
      `SELECT ${CUSTOMER_COLS} FROM contacts c
         LEFT JOIN accounts a ON a.id = c.account_id WHERE c.id = $1`,
      [req.params.id]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: Number(req.params.id), recordType: 'contact', action: 'update', oldData: before.rows[0], newData: updated.rows[0], req });
    res.json(updated.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/customers/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE contacts SET deleted_at=NOW()
        WHERE id=$1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id=$2)
        RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
    logAudit({ userId: req.user?.userId, module: 'service', recordId: Number(req.params.id), recordType: 'contact', action: 'delete', req });
    res.json({ success: true, id: rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Account picker for the customer drawer (company dropdown).
router.get('/customer-accounts', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT id, COALESCE(name, account_name) AS name
         FROM accounts
        WHERE deleted_at IS NULL AND ($1::int IS NULL OR company_id = $1)
        ORDER BY COALESCE(name, account_name) ASC`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── sites ──────────────────────────────────────────────────────────────────────
router.get('/sites', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { search, status, limit = 100, offset = 0 } = req.query;
    const p = [companyId];
    let q = `SELECT * FROM service_sites WHERE ($1::int IS NULL OR company_id = $1)`;
    if (status) { p.push(status); q += ` AND status = $${p.length}`; }
    if (search) { p.push(`%${search}%`); q += ` AND (name ILIKE $${p.length} OR customer_name ILIKE $${p.length} OR city ILIKE $${p.length})`; }
    p.push(parseInt(limit)); p.push(parseInt(offset));
    q += ` ORDER BY name ASC LIMIT $${p.length - 1} OFFSET $${p.length}`;
    res.json((await pool.query(q, p)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/sites', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, customer_id, customer_name, address, city, state, pincode, contact_name, contact_phone, site_type } = req.body;
    if (!name || !address) return res.status(422).json({ error: 'Site name and address are required' });
    const result = await pool.query(
      `INSERT INTO service_sites (name, customer_id, customer_name, address, city, state, pincode, contact_name, contact_phone, site_type, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, customer_id || null, customer_name || null, address, city || null, state || null, pincode || null, contact_name || null, contact_phone || null, site_type || 'Office', companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: result.rows[0].id, recordType: 'service_site', action: 'create', newData: result.rows[0], req });
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/sites/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { name, customer_id, customer_name, address, city, state, pincode, contact_name, contact_phone, site_type, status } = req.body;
    if (!name || !address) return res.status(422).json({ error: 'Site name and address are required' });
    const { rows } = await pool.query(
      `UPDATE service_sites
       SET name=$1, customer_id=$2, customer_name=$3, address=$4, city=$5, state=$6,
           pincode=$7, contact_name=$8, contact_phone=$9, site_type=$10, status=$11
       WHERE id=$12 AND ($13::int IS NULL OR company_id=$13) RETURNING *`,
      [name, customer_id||null, customer_name||null, address, city||null, state||null,
       pincode||null, contact_name||null, contact_phone||null, site_type||'Office',
       status||'Active', req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Site not found' });
    logAudit({ userId: req.user?.userId, module: 'service', recordId: req.params.id, recordType: 'service_site', action: 'update', newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/sites/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `DELETE FROM service_sites WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Site not found' });
    logAudit({ userId: req.user?.userId, module: 'service', recordId: req.params.id, recordType: 'service_site', action: 'delete', req });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── delivery notes ─────────────────────────────────────────────────────────────
router.get('/delivery-notes', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { search, status, limit = 100, offset = 0 } = req.query;
    const p = [companyId];
    let q = `SELECT * FROM delivery_notes WHERE ($1::int IS NULL OR company_id = $1)`;
    if (status) { p.push(status); q += ` AND status = $${p.length}`; }
    if (search) { p.push(`%${search}%`); q += ` AND (customer_name ILIKE $${p.length} OR dn_number ILIKE $${p.length} OR delivered_by ILIKE $${p.length})`; }
    p.push(parseInt(limit)); p.push(parseInt(offset));
    q += ` ORDER BY delivery_date DESC LIMIT $${p.length - 1} OFFSET $${p.length}`;
    res.json((await pool.query(q, p)).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/delivery-notes', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { customer_name, delivery_date, delivered_by, items_delivered, ticket_id, notes } = req.body;
    if (!customer_name || !delivery_date) return res.status(422).json({ error: 'Customer name and delivery date are required' });
    const count = await pool.query(
      `SELECT COUNT(*) FROM delivery_notes WHERE ($1::int IS NULL OR company_id = $1)`,
      [companyId]
    );
    const dn_number = `DN-${String(parseInt(count.rows[0].count) + 1).padStart(4, '0')}`;
    const result = await pool.query(
      `INSERT INTO delivery_notes (dn_number, ticket_id, customer_name, delivery_date, delivered_by, items_delivered, notes, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [dn_number, ticket_id || null, customer_name, delivery_date, delivered_by || null, items_delivered || null, notes || null, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: result.rows[0].id, recordType: 'delivery_note', action: 'create', newData: result.rows[0], req });
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/delivery-notes/:id', svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, delivered_by, notes } = req.body;
    const VALID_STATUSES = ['Pending', 'Delivered', 'Cancelled'];
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(422).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const { rows } = await pool.query(
      `UPDATE delivery_notes
       SET status       = COALESCE($1, status),
           delivered_by = COALESCE($2, delivered_by),
           notes        = COALESCE($3, notes)
       WHERE id = $4 AND ($5::int IS NULL OR company_id = $5) RETURNING *`,
      [status || null, delivered_by || null, notes || null, req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Delivery note not found' });
    logAudit({ userId: req.user?.userId, module: 'service', recordId: req.params.id, recordType: 'delivery_note', action: 'update', newData: rows[0], req });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── feedback (CSAT responses) ──────────────────────────────────────────────────
// Optional filters: from / to (responded_at, YYYY-MM-DD), engineer (agent_name).
router.get('/feedback', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { limit = 100, offset = 0, from = null, to = null, engineer = null } = req.query;
    const result = await pool.query(
      `SELECT c.id, c.ticket_id, c.ticket_subject, c.rating,
              c.product_rating, c.engineer_rating, c.visited_on_time, c.resolved,
              c.customer_name, c.feedback, c.agent_name, c.responded_at,
              COALESCE(c.complaint_id, t.complaint_id) AS complaint_id,
              cmp.complaint_number
         FROM csat_responses c
         LEFT JOIN support_tickets t ON t.id = c.ticket_id
         LEFT JOIN complaints    cmp ON cmp.id = COALESCE(c.complaint_id, t.complaint_id)
        WHERE ($1::int  IS NULL OR c.company_id = $1)
          AND ($4::date IS NULL OR c.responded_at >= $4::date)
          AND ($5::date IS NULL OR c.responded_at <  $5::date + INTERVAL '1 day')
          AND ($6::text IS NULL OR c.agent_name = $6)
        ORDER BY c.responded_at DESC LIMIT $2 OFFSET $3`,
      [companyId, parseInt(limit), parseInt(offset), from, to, engineer]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── feedback KPIs — 4 live service-quality metrics (same filters as the list) ───
router.get('/feedback/kpis', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { from = null, to = null, engineer = null } = req.query;
    const { rows } = await pool.query(
      `SELECT
         ROUND(AVG(product_rating)::numeric, 1)  AS avg_product_rating,
         ROUND(AVG(engineer_rating)::numeric, 1) AS avg_engineer_rating,
         ROUND(100.0 * COUNT(*) FILTER (WHERE visited_on_time IS TRUE)
               / NULLIF(COUNT(*) FILTER (WHERE visited_on_time IS NOT NULL), 0), 0) AS on_time_pct,
         ROUND(100.0 * COUNT(*) FILTER (WHERE resolved IS TRUE)
               / NULLIF(COUNT(*) FILTER (WHERE resolved IS NOT NULL), 0), 0)        AS resolved_pct,
         COUNT(*) AS total
         FROM csat_responses
        WHERE ($1::int  IS NULL OR company_id = $1)
          AND ($2::date IS NULL OR responded_at >= $2::date)
          AND ($3::date IS NULL OR responded_at <  $3::date + INTERVAL '1 day')
          AND ($4::text IS NULL OR agent_name = $4)`,
      [companyId, from, to, engineer]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── complaint lookup for the Log-Feedback form (link feedback to an IPCS record)─
router.get('/feedback/complaints', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { q = null } = req.query;
    const { rows } = await pool.query(
      `SELECT id, complaint_number, customer_name, status
         FROM complaints
        WHERE deleted_at IS NULL
          AND ($1::int  IS NULL OR company_id = $1)
          AND ($2::text IS NULL OR complaint_number ILIKE '%'||$2||'%' OR customer_name ILIKE '%'||$2||'%')
        ORDER BY created_at DESC LIMIT 50`,
      [companyId, q]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── engineer options for the feedback filter (distinct agent names) ─────────────
router.get('/feedback/engineers', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT DISTINCT agent_name FROM csat_responses
        WHERE agent_name IS NOT NULL AND agent_name <> ''
          AND ($1::int IS NULL OR company_id = $1)
        ORDER BY agent_name`,
      [companyId]
    );
    res.json(rows.map(r => r.agent_name));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /feedback — submit CSAT after delivery ────────────────────────────────
router.post('/feedback', svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const {
      ticket_id, ticket_subject, rating, feedback, agent_name,
      product_rating, engineer_rating, visited_on_time, resolved,
      customer_name, complaint_id,
    } = req.body;

    // 1-5 validator shared by the three rating fields.
    const rate = (v) => (v === undefined || v === null || v === '') ? null : parseInt(v);
    const inRange = (v) => v === null || (v >= 1 && v <= 5);
    const pr = rate(product_rating), er = rate(engineer_rating);
    for (const [label, v] of [['product_rating', pr], ['engineer_rating', er]]) {
      if (!inRange(v)) return res.status(400).json({ error: `${label} must be between 1 and 5` });
    }
    // Overall rating: use the supplied value, else the mean of the two dimensions.
    let overall = rate(rating);
    if (!inRange(overall) || overall === null) {
      const parts = [pr, er].filter((v) => v !== null);
      overall = parts.length ? Math.round(parts.reduce((s, v) => s + v, 0) / parts.length) : null;
    }
    if (overall === null) {
      return res.status(400).json({ error: 'provide rating, or product_rating / engineer_rating' });
    }
    const bool = (v) => (v === undefined || v === null || v === '') ? null : Boolean(v);

    const result = await pool.query(
      `INSERT INTO csat_responses
         (ticket_id, ticket_subject, rating, product_rating, engineer_rating,
          visited_on_time, resolved, customer_name, complaint_id,
          feedback, agent_name, company_id, responded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING *`,
      [ticket_id || null, ticket_subject || null, overall, pr, er,
       bool(visited_on_time), bool(resolved), customer_name || null, complaint_id || null,
       feedback || null, agent_name || null, companyId]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: result.rows[0].id,
      recordType: 'csat_response', action: 'create', newData: result.rows[0], req });
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Knowledge Base ─────────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS service_knowledge_base (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER,
        title        TEXT NOT NULL,
        content      TEXT,
        category     TEXT DEFAULT 'General',
        tags         TEXT[],
        author_id    INTEGER,
        views        INTEGER DEFAULT 0,
        helpful_yes  INTEGER DEFAULT 0,
        helpful_no   INTEGER DEFAULT 0,
        is_published BOOLEAN DEFAULT TRUE,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch (e) { console.error('[servicedesk] knowledge-base migration:', e.message); }
})();

router.get('/knowledge-base', svcKnowledgeBase, async (req, res) => {
  try {
    const companyId = cid(req);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { search, category } = req.query;
    const params = [companyId, limit];
    let where = '($1::int IS NULL OR company_id=$1)';
    if (search) { params.push(`%${search}%`); where += ` AND (title ILIKE $${params.length} OR content ILIKE $${params.length})`; }
    if (category) { params.push(category); where += ` AND category=$${params.length}`; }
    const { rows } = await pool.query(
      `SELECT id, company_id, title, content, category, array_to_string(tags, ',') AS tags,
              author_id, views, helpful_yes, helpful_no, is_published, created_at, updated_at
       FROM service_knowledge_base WHERE ${where} AND is_published=true ORDER BY views DESC LIMIT $2`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/knowledge-base', svcKnowledgeBase, svcAdmin('add'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { title, content, category, tags } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    const authorId = req.user?.userId ?? req.user?.id;
    const tagsArr = typeof tags === 'string'
      ? tags.split(',').map(t => t.trim()).filter(Boolean)
      : (Array.isArray(tags) ? tags : []);
    const { rows } = await pool.query(
      `INSERT INTO service_knowledge_base (company_id, title, content, category, tags, author_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, company_id, title, content, category, array_to_string(tags, ',') AS tags,
                 author_id, views, is_published, created_at, updated_at`,
      [companyId, title, content || null, category || 'General', tagsArr, authorId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/knowledge-base/:id', svcKnowledgeBase, svcAdmin('edit'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { title, content, category, tags, is_published } = req.body;
    const tagsArr = typeof tags === 'string'
      ? tags.split(',').map(t => t.trim()).filter(Boolean)
      : (Array.isArray(tags) ? tags : []);
    const { rows } = await pool.query(
      `UPDATE service_knowledge_base SET title=$1,content=$2,category=$3,tags=$4,is_published=$5,updated_at=NOW()
       WHERE id=$6 AND ($7::int IS NULL OR company_id=$7)
       RETURNING id, company_id, title, content, category, array_to_string(tags, ',') AS tags,
                 author_id, views, is_published, created_at, updated_at`,
      [title, content || null, category || 'General', tagsArr, is_published !== false, req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Article not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/knowledge-base/:id', svcKnowledgeBase, svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    await pool.query('DELETE FROM service_knowledge_base WHERE id=$1 AND ($2::int IS NULL OR company_id=$2)', [req.params.id, companyId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── engineer delete ────────────────────────────────────────────────────────────
router.delete('/engineers/:id', svcAdmin('delete'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE service_engineers SET status='Inactive' WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING id`,
      [req.params.id, companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Engineer not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CSV exports ────────────────────────────────────────────────────────────────
const toCSV = (rows, cols) => {
  if (!rows.length) return cols.join(',') + '\n';
  const header = cols.join(',');
  const lines = rows.map(r => cols.map(c => {
    const v = r[c] ?? '';
    const s = String(v).replace(/"/g, '""');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
  }).join(','));
  return [header, ...lines].join('\n');
};

router.get('/export/tickets', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { date_from, date_to, status, priority } = req.query;
    const params = [companyId];
    let q = `SELECT ticket_number, title, category, priority, status, team, assigned_to,
                    requester_name, requester_email, serial_number, department,
                    created_at, resolved_at, closed_at, due_date
             FROM support_tickets
             WHERE ($1::int IS NULL OR company_id=$1) AND deleted_at IS NULL`;
    if (date_from) { params.push(date_from); q += ` AND created_at >= $${params.length}`; }
    if (date_to)   { params.push(date_to);   q += ` AND created_at <= $${params.length}::date + INTERVAL '1 day'`; }
    if (status)    { params.push(status);    q += ` AND status=$${params.length}`; }
    if (priority)  { params.push(priority);  q += ` AND priority=$${params.length}`; }
    q += ' ORDER BY created_at DESC';
    const { rows } = await pool.query(q, params);
    const cols = ['ticket_number','title','category','priority','status','team','assigned_to','requester_name','requester_email','serial_number','department','created_at','resolved_at','closed_at','due_date'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tickets_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(toCSV(rows, cols));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/export/sla-compliance', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { date_from, date_to } = req.query;
    const params = [companyId];
    let q = `
      SELECT t.ticket_number, t.title, LOWER(t.priority) AS priority,
             ROUND(CAST(EXTRACT(EPOCH FROM (COALESCE(t.resolved_at,NOW()) - t.created_at))/3600 AS NUMERIC),2) AS elapsed_hrs,
             COALESCE(p.resolution_hours, CASE LOWER(t.priority) WHEN 'critical' THEN 4 WHEN 'high' THEN 8 WHEN 'medium' THEN 24 ELSE 72 END) AS sla_hrs,
             CASE WHEN t.resolved_at IS NOT NULL AND
               EXTRACT(EPOCH FROM (t.resolved_at - t.created_at))/3600 <=
               COALESCE(p.resolution_hours, CASE LOWER(t.priority) WHEN 'critical' THEN 4 WHEN 'high' THEN 8 WHEN 'medium' THEN 24 ELSE 72 END)
               THEN 'Met' ELSE 'Breached' END AS sla_status,
             t.assigned_to, t.status, t.created_at, t.resolved_at
      FROM support_tickets t
      LEFT JOIN sla_policies p ON LOWER(p.priority)=LOWER(t.priority) AND ($1::int IS NULL OR p.company_id=$1)
      WHERE ($1::int IS NULL OR t.company_id=$1) AND t.deleted_at IS NULL
    `;
    if (date_from) { params.push(date_from); q += ` AND t.created_at >= $${params.length}`; }
    if (date_to)   { params.push(date_to);   q += ` AND t.created_at <= $${params.length}::date + INTERVAL '1 day'`; }
    q += ' ORDER BY t.created_at DESC';
    const { rows } = await pool.query(q, params);
    const cols = ['ticket_number','title','priority','elapsed_hrs','sla_hrs','sla_status','assigned_to','status','created_at','resolved_at'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="sla_compliance_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(toCSV(rows, cols));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/export/csat', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT ticket_id, ticket_subject, rating, feedback, agent_name, responded_at
       FROM csat_responses WHERE ($1::int IS NULL OR company_id=$1) ORDER BY responded_at DESC`,
      [companyId]
    );
    const cols = ['ticket_id','ticket_subject','rating','feedback','agent_name','responded_at'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="csat_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(toCSV(rows, cols));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/export/field-visits', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { date_from, date_to } = req.query;
    const params = [companyId];
    let q = `SELECT customer_name, address, visit_date, visit_time, engineer_name, purpose,
                    serial_number, visit_type, status, work_done, labour_hours, travel_km,
                    cost, completed_at, notes
             FROM field_visits WHERE ($1::int IS NULL OR company_id=$1)`;
    if (date_from) { params.push(date_from); q += ` AND visit_date >= $${params.length}`; }
    if (date_to)   { params.push(date_to);   q += ` AND visit_date <= $${params.length}`; }
    q += ' ORDER BY visit_date DESC';
    const { rows } = await pool.query(q, params);
    const cols = ['customer_name','address','visit_date','visit_time','engineer_name','purpose','serial_number','visit_type','status','work_done','labour_hours','travel_km','cost','completed_at','notes'];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="field_visits_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(toCSV(rows, cols));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── service notifications ──────────────────────────────────────────────────────
router.get('/notifications', svcAdmin('view'), async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT * FROM service_notifications
       WHERE ($1::int IS NULL OR company_id=$1) ORDER BY created_at DESC LIMIT 50`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/notifications/:id/read', svcAdmin('view'), async (req, res) => {
  try {
    await pool.query(`UPDATE service_notifications SET is_read=TRUE WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Field-engineer mobile endpoints ─────────────────────────────────────────────
// Personal to the caller — self-service gate, scoped in-handler. Powers the
// Engineer mobile home (EngineerHome.jsx).
//
// SCHEMA NOTES (verified live, both are drift traps):
//   • support_tickets.assigned_to is an INTEGER employee_id (joins se.employee_id
//     in service-analytics), NOT a name — despite older code aliasing "agent_name".
//   • The JWT's employee_id is unreliable here, so resolve the real integer id
//     from users.employee_id by user id.
//   • support_tickets.customer_id FKs accounts, not leads.
async function callerEmployeeId(req) {
  const uid = req.user?.userId ?? req.user?.id;
  if (uid == null) return null;
  const { rows } = await pool.query(`SELECT employee_id FROM users WHERE id = $1`, [uid]);
  return rows[0]?.employee_id ?? null;
}

// GET /servicedesk/my-tickets — the caller's open assigned service jobs.
router.get('/my-tickets', svcSelfService, async (req, res) => {
  try {
    const empId = await callerEmployeeId(req);
    if (empId == null) return res.json([]); // no employee link → no assignments
    const companyId = cid(req);
    const params = [empId];
    let q = `
      SELECT t.id, t.ticket_number, t.title, t.priority, t.status, t.ticket_kind,
             t.serial_number, t.site_id, t.project_id, t.created_at,
             COALESCE(a.account_name, a.name) AS customer
        FROM support_tickets t
        LEFT JOIN accounts a ON a.id = t.customer_id
       WHERE t.deleted_at IS NULL
         AND t.assigned_to = $1
         AND LOWER(t.status) <> 'resolved'`;
    if (companyId != null) { params.push(companyId); q += ` AND t.company_id = $${params.length}`; }
    q += ` ORDER BY CASE LOWER(t.priority) WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, t.created_at DESC`;
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /servicedesk/tickets/:id/field-update — a field engineer's on-site action:
// GPS check-in, a note, an optional status change (Start/Resolve), and a flag
// that a site photo was captured on-device. Logged as a ticket comment so it
// shows in the ticket history the office already reads.
router.post('/tickets/:id/field-update', svcSelfService, async (req, res) => {
  try {
    const empId = await callerEmployeeId(req);
    const name = req.user?.name || 'Field Engineer';
    const t = (await pool.query(`SELECT id, assigned_to, status FROM support_tickets WHERE id = $1 AND deleted_at IS NULL`, [req.params.id])).rows[0];
    if (!t) return res.status(404).json({ error: 'ticket not found' });
    // Only the assigned engineer (or service staff) may post field updates.
    if (t.assigned_to !== empId && !isServiceStaff(req)) return res.status(403).json({ error: 'not your assigned ticket' });

    const { lat, lng, note, status, photo_captured } = req.body || {};
    const parts = [];
    if (lat != null && lng != null) parts.push(`📍 Checked in at ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`);
    if (photo_captured) parts.push('📷 Site photo captured');
    if (note) parts.push(note);
    const VALID = { start: 'In Progress', resolve: 'Resolved' };
    const newStatus = status && VALID[status] ? VALID[status] : null;
    if (newStatus) parts.push(`Status → ${newStatus}`);
    if (!parts.length) return res.status(400).json({ error: 'nothing to update' });

    await pool.query(
      `INSERT INTO ticket_comments (ticket_id, author, body, is_internal) VALUES ($1,$2,$3,true)`,
      [t.id, name || 'Field Engineer', `[Field] ${parts.join(' · ')}`]);
    if (newStatus) {
      await pool.query(`UPDATE support_tickets SET status = $2, updated_at = NOW() WHERE id = $1`, [t.id, newStatus]);
    }
    res.json({ ok: true, status: newStatus || t.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
