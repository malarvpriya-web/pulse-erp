/**
 * accountGraph.routes.js — account hierarchy and account/opportunity teams.
 *
 * Two capabilities the CRM brief names and the system did not have:
 *   §2  parent/child accounts and account hierarchy
 *   §12 account teams and opportunity teams
 *
 * Mounted inside the CRM router, so everything here is already behind
 * verifyToken and the module's audit middleware.
 */

import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import { logAudit } from '../../../services/AuditService.js';
import { sqlOpportunityWon, sqlOpportunityOpen } from '../../../shared/statusSets.js';

const router = express.Router();

const canView   = requirePermission('crm', 'view');
const canEdit   = requirePermission('crm', 'edit');
const canDelete = requirePermission('crm', 'delete');

const TEAM_ROLES = ['owner', 'sales_lead', 'technical', 'commercial', 'executive_sponsor', 'support', 'contributor'];
const ACCESS_LEVELS = ['read', 'edit'];

const fail = (res, err) => res.status(err.status || 500).json({ error: err.message || 'Internal error' });

/* ══════════════════════════════════════════════════════════════════════════
   Account hierarchy
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/crm/accounts/:id/hierarchy
 *
 * The whole tree the account belongs to — its ancestors, itself and every
 * descendant — with revenue rolled up.
 *
 * Walks UP to the root first, then down, so the caller gets the same tree
 * whichever member they ask about. Asking about a subsidiary and getting only
 * its own branch is the answer nobody wants: the question "who is this customer,
 * really" is about the group.
 */
router.get('/accounts/:id/hierarchy', canView, async (req, res) => {
  try {
    const cid = companyOf(req);
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });

    const { rows: [root] } = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_account_id, 0 AS depth
           FROM accounts
          WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)
         UNION ALL
         SELECT a.id, a.parent_account_id, up.depth + 1
           FROM accounts a JOIN up ON a.id = up.parent_account_id
          WHERE a.deleted_at IS NULL
       )
       SELECT id FROM up ORDER BY depth DESC LIMIT 1`,
      [id, cid]
    );
    if (!root) return res.status(404).json({ error: 'Account not found' });

    const { rows } = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT a.id, a.name, a.parent_account_id, a.account_type, a.industry,
                a.assigned_to, 0 AS depth, ARRAY[a.id] AS path
           FROM accounts a
          WHERE a.id = $1 AND a.deleted_at IS NULL
         UNION ALL
         SELECT c.id, c.name, c.parent_account_id, c.account_type, c.industry,
                c.assigned_to, t.depth + 1, t.path || c.id
           FROM accounts c
           JOIN tree t ON c.parent_account_id = t.id
          WHERE c.deleted_at IS NULL
            -- Belt and braces: the trigger prevents cycles, but a recursive CTE
            -- that meets one never terminates, so it refuses to revisit a node.
            AND NOT c.id = ANY(t.path)
       )
       SELECT t.*,
              e.name AS owner_name,
              (SELECT COUNT(*) FROM opportunities o
                WHERE o.account_id = t.id AND o.deleted_at IS NULL)::int          AS opportunity_count,
              (SELECT COALESCE(SUM(o.expected_value), 0) FROM opportunities o
                WHERE o.account_id = t.id AND o.deleted_at IS NULL
                  AND ${sqlOpportunityOpen('o.stage')})                            AS open_pipeline,
              (SELECT COALESCE(SUM(o.expected_value), 0) FROM opportunities o
                WHERE o.account_id = t.id AND o.deleted_at IS NULL
                  AND ${sqlOpportunityWon('o.stage')})                             AS won_value
         FROM tree t
         LEFT JOIN employees e ON e.id = t.assigned_to
        ORDER BY t.depth, t.name`,
      [root.id]
    );

    const num = (v) => parseFloat(v) || 0;
    res.json({
      root_account_id: root.id,
      requested_account_id: id,
      count: rows.length,
      // Group totals are what the hierarchy exists to answer.
      totals: {
        accounts: rows.length,
        opportunity_count: rows.reduce((t, r) => t + (Number(r.opportunity_count) || 0), 0),
        open_pipeline: rows.reduce((t, r) => t + num(r.open_pipeline), 0),
        won_value: rows.reduce((t, r) => t + num(r.won_value), 0),
      },
      nodes: rows.map((r) => ({
        ...r,
        open_pipeline: num(r.open_pipeline),
        won_value: num(r.won_value),
      })),
    });
  } catch (err) { fail(res, err); }
});

/**
 * PATCH /api/crm/accounts/:id/parent  { parent_account_id }
 *
 * `null` detaches the account and makes it a root. The database trigger rejects
 * a cycle; this maps that to a 400 with the reason rather than letting a raw
 * plpgsql RAISE reach the caller as a 500.
 */
router.patch('/accounts/:id/parent', canEdit, async (req, res) => {
  try {
    const cid = companyOf(req);
    const id = parseInt(req.params.id, 10);
    const parent = req.body?.parent_account_id == null ? null : parseInt(req.body.parent_account_id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be an integer' });
    if (parent !== null && !Number.isInteger(parent)) {
      return res.status(400).json({ error: 'parent_account_id must be an integer or null' });
    }

    const { rows: [before] } = await pool.query(
      `SELECT id, name, parent_account_id FROM accounts
        WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
      [id, cid]
    );
    if (!before) return res.status(404).json({ error: 'Account not found' });

    if (parent !== null) {
      // Cross-tenant parenting would merge two companies' customer graphs.
      const { rows: [p] } = await pool.query(
        `SELECT id FROM accounts WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`,
        [parent, cid]
      );
      if (!p) return res.status(400).json({ error: 'Parent account not found in this company' });
    }

    let after;
    try {
      ({ rows: [after] } = await pool.query(
        `UPDATE accounts SET parent_account_id = $1, updated_at = NOW()
          WHERE id = $2 AND ($3::int IS NULL OR company_id = $3)
          RETURNING id, name, parent_account_id`,
        [parent, id, cid]
      ));
    } catch (e) {
      // The trigger raises for a self-parent, a cycle, or excessive depth. All
      // three are the caller's input being wrong, not the server failing.
      if (/cycle|own parent|deeper than/i.test(e.message)) {
        return res.status(400).json({ error: e.message.replace(/^.*?:\s*/, '') });
      }
      throw e;
    }

    logAudit({
      userId: req.user?.userId, module: 'crm', recordId: id, recordType: 'account_hierarchy',
      action: 'update', oldData: { parent_account_id: before.parent_account_id },
      newData: { parent_account_id: parent }, req, company_id: cid,
    });
    res.json(after);
  } catch (err) { fail(res, err); }
});

/* ══════════════════════════════════════════════════════════════════════════
   Teams
   ══════════════════════════════════════════════════════════════════════════ */

function parentOf(req) {
  const account_id = req.query.account_id ?? req.body?.account_id;
  const opportunity_id = req.query.opportunity_id ?? req.body?.opportunity_id;
  const a = account_id == null || account_id === '' ? null : parseInt(account_id, 10);
  const o = opportunity_id == null || opportunity_id === '' ? null : parseInt(opportunity_id, 10);
  if ((a == null) === (o == null)) {
    throw Object.assign(
      new Error('Supply exactly one of account_id or opportunity_id'),
      { status: 400 }
    );
  }
  return { account_id: a, opportunity_id: o };
}

/** GET /api/crm/team?account_id= | ?opportunity_id= */
router.get('/team', canView, async (req, res) => {
  try {
    const { account_id, opportunity_id } = parentOf(req);
    const { rows } = await pool.query(
      `SELECT tm.*, e.name AS employee_name, e.designation, e.company_email,
              ab.name AS added_by_name
         FROM crm_team_members tm
         JOIN employees e ON e.id = tm.employee_id
         LEFT JOIN employees ab ON ab.id = tm.added_by
        WHERE ($1::int IS NULL OR tm.company_id = $1)
          AND ($2::int IS NULL OR tm.account_id = $2)
          AND ($3::int IS NULL OR tm.opportunity_id = $3)
        ORDER BY CASE tm.team_role WHEN 'owner' THEN 0 WHEN 'sales_lead' THEN 1 ELSE 2 END,
                 e.name`,
      [companyOf(req), account_id, opportunity_id]
    );
    res.json({ account_id, opportunity_id, count: rows.length, data: rows });
  } catch (err) { fail(res, err); }
});

/** POST /api/crm/team  { account_id | opportunity_id, employee_id, team_role, access_level } */
router.post('/team', canEdit, async (req, res) => {
  try {
    const cid = companyOf(req);
    if (cid == null) return res.status(400).json({ error: 'A company scope is required' });
    const { account_id, opportunity_id } = parentOf(req);

    const employeeId = parseInt(req.body?.employee_id, 10);
    if (!Number.isInteger(employeeId)) return res.status(400).json({ error: 'employee_id is required' });

    const teamRole = req.body?.team_role ?? 'contributor';
    if (!TEAM_ROLES.includes(teamRole)) {
      return res.status(400).json({ error: `team_role must be one of ${TEAM_ROLES.join(', ')}` });
    }
    const accessLevel = req.body?.access_level ?? 'read';
    if (!ACCESS_LEVELS.includes(accessLevel)) {
      return res.status(400).json({ error: `access_level must be one of ${ACCESS_LEVELS.join(', ')}` });
    }

    // The parent must exist IN THIS COMPANY, or a team could be attached to
    // another tenant's record.
    const parentSql = account_id != null
      ? `SELECT id FROM accounts WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`
      : `SELECT id FROM opportunities WHERE id = $1 AND deleted_at IS NULL AND ($2::int IS NULL OR company_id = $2)`;
    const { rows: [parent] } = await pool.query(parentSql, [account_id ?? opportunity_id, cid]);
    if (!parent) return res.status(404).json({ error: 'Parent record not found in this company' });

    const { rows: [emp] } = await pool.query(
      `SELECT id FROM employees WHERE id = $1 AND deleted_at IS NULL`, [employeeId]
    );
    if (!emp) return res.status(400).json({ error: `Employee ${employeeId} does not exist` });

    const { rows: [row] } = await pool.query(
      `INSERT INTO crm_team_members
         (company_id, account_id, opportunity_id, employee_id, team_role, access_level, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (COALESCE(account_id, -1), COALESCE(opportunity_id, -1), employee_id)
       DO UPDATE SET team_role = EXCLUDED.team_role, access_level = EXCLUDED.access_level
       RETURNING *`,
      [cid, account_id, opportunity_id, employeeId, teamRole, accessLevel, await employeeOf(req, pool)]
    );

    logAudit({
      userId: req.user?.userId, module: 'crm', recordId: row.id, recordType: 'crm_team_member',
      action: 'create', newData: row, req, company_id: cid,
    });
    res.status(201).json(row);
  } catch (err) { fail(res, err); }
});

/** DELETE /api/crm/team/:id */
router.delete('/team/:id', canDelete, async (req, res) => {
  try {
    const cid = companyOf(req);
    const { rows: [before] } = await pool.query(
      `SELECT * FROM crm_team_members WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]
    );
    if (!before) return res.status(404).json({ error: 'Team member not found' });

    await pool.query(`DELETE FROM crm_team_members WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`,
      [req.params.id, cid]);

    logAudit({
      userId: req.user?.userId, module: 'crm', recordId: req.params.id, recordType: 'crm_team_member',
      action: 'delete', oldData: before, req, company_id: cid,
    });
    res.json({ success: true });
  } catch (err) { fail(res, err); }
});

/**
 * GET /api/crm/team/mine — every record I am on the team for.
 *
 * This is the question single-valued ownership could not answer: "what am I
 * working on" previously meant "what do I personally own".
 */
router.get('/team/mine', canView, async (req, res) => {
  try {
    const me = await employeeOf(req, pool);
    if (me == null) return res.json({ employee_id: null, accounts: [], opportunities: [] });

    const cid = companyOf(req);
    const [{ rows: accounts }, { rows: opportunities }] = await Promise.all([
      pool.query(
        `SELECT a.id, a.name, tm.team_role, tm.access_level
           FROM crm_team_members tm
           JOIN accounts a ON a.id = tm.account_id AND a.deleted_at IS NULL
          WHERE tm.employee_id = $1 AND ($2::int IS NULL OR tm.company_id = $2)
          ORDER BY a.name`,
        [me, cid]
      ),
      pool.query(
        `SELECT o.id, o.opportunity_name, o.stage, o.expected_value, tm.team_role, tm.access_level
           FROM crm_team_members tm
           JOIN opportunities o ON o.id = tm.opportunity_id AND o.deleted_at IS NULL
          WHERE tm.employee_id = $1 AND ($2::int IS NULL OR tm.company_id = $2)
          ORDER BY o.expected_value DESC NULLS LAST`,
        [me, cid]
      ),
    ]);
    res.json({ employee_id: me, accounts, opportunities });
  } catch (err) { fail(res, err); }
});

export default router;
