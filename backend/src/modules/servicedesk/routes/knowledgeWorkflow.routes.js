/**
 * knowledgeWorkflow.routes.js — managed knowledge base.
 *
 * Mounted at /api/servicedesk/knowledge. The legacy /knowledge-base CRUD stays
 * where it is and keeps working; this is the governed surface on the SAME table,
 * not a second knowledge base.
 *
 * Authorization, stated once:
 *   - reading the staff view needs `servicedesk.view`;
 *   - writing needs `servicedesk.add` / `.edit`;
 *   - approving and publishing additionally need a manager role, checked in the
 *     service (TRANSITION_ROLES) so the rule holds no matter who calls it;
 *   - `/public` is the portal surface: published + public only, no drafts, no
 *     internal articles, and it never carries author identity.
 * Every mutation is audited with a before image.
 */

import express from 'express';
import pool from '../../../config/db.js';
import { requirePermission, rolesOf } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { companyOf, employeeOf } from '../../../shared/scope.js';
import {
  TRANSITIONS, editArticle, transition, recordFeedback,
  effectiveness, summary, snapshotVersion,
} from '../services/knowledgeWorkflow.service.js';

const router = express.Router();

const canView = requirePermission('servicedesk', 'view');
const canAdd  = requirePermission('servicedesk', 'add');
const canEdit = requirePermission('servicedesk', 'edit');

const cid = (req) => companyOf(req);
const fail = (res, err) => res.status(500).json({ error: err.message });

/** Maps a service refusal to the status code and message that explain it. */
const REFUSALS = {
  not_found:           [404, 'Article not found'],
  bad_event:           [400, 'event must be view, helpful or not_helpful'],
  self_approval:       [403, 'An article cannot be approved by the person who submitted it'],
  not_approved:        [409, 'Only an approved article can be published'],
  illegal_transition:  [409, null],
  role_required:       [403, null],
};
function refuse(res, out) {
  const [code, msg] = REFUSALS[out.error] || [400, out.error];
  if (out.error === 'illegal_transition') {
    return res.status(code).json({
      error: `Cannot move an article from ${out.from} to ${out.to}`,
      from: out.from, to: out.to, allowed: out.allowed,
    });
  }
  if (out.error === 'role_required') {
    return res.status(code).json({
      error: `Moving an article to ${out.to} requires one of: ${out.roles.join(', ')}`,
      required_roles: out.roles,
    });
  }
  return res.status(code).json({ error: msg });
}

// ── list ─────────────────────────────────────────────────────────────────────
router.get('/', canView, async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, visibility, category, search, review_due } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const params = [companyId];
    let where = '($1::int IS NULL OR a.company_id = $1)';
    const add = (frag, val) => { params.push(val); where += ` AND ${frag.replace('?', `$${params.length}`)}`; };

    if (status)     add('a.status = ?', status);
    if (visibility) add('a.visibility = ?', visibility);
    if (category)   add('a.category = ?', category);
    if (search) {
      // One value, two placeholders — written out rather than run through add(),
      // which assumes one of each.
      params.push(`%${search}%`);
      where += ` AND (a.title ILIKE $${params.length} OR a.content ILIKE $${params.length})`;
    }
    if (review_due === 'true') where += ' AND a.review_due_date IS NOT NULL AND a.review_due_date < CURRENT_DATE';

    params.push(limit);
    const { rows } = await pool.query(
      `SELECT a.id, a.company_id, a.title, a.summary, a.content, a.category,
              array_to_string(a.tags, ',') AS tags, a.author_id, a.status, a.visibility,
              a.version, a.views, a.helpful_yes, a.helpful_no, a.is_published,
              a.submitted_by, a.submitted_at, a.approved_by, a.approved_at,
              a.rejected_reason, a.published_at, a.archived_at, a.review_due_date,
              a.created_at, a.updated_at,
              CASE WHEN COALESCE(a.helpful_yes,0) + COALESCE(a.helpful_no,0) = 0 THEN NULL
                   ELSE ROUND(100.0 * a.helpful_yes / (a.helpful_yes + a.helpful_no), 1)
              END AS helpful_pct,
              (SELECT COUNT(*)::int FROM knowledge_article_cases c WHERE c.article_id = a.id) AS cases_linked
         FROM service_knowledge_base a
        WHERE ${where}
        ORDER BY a.updated_at DESC NULLS LAST, a.id DESC
        LIMIT $${params.length}`,
      params
    );
    res.json(rows.map(r => ({ ...r, helpful_pct: r.helpful_pct === null ? null : Number(r.helpful_pct) })));
  } catch (err) { fail(res, err); }
});

router.get('/summary', canView, async (req, res) => {
  try { res.json(await summary(pool, { companyId: cid(req) })); }
  catch (err) { fail(res, err); }
});

router.get('/effectiveness', canView, async (req, res) => {
  try {
    res.json(await effectiveness(pool, {
      companyId: cid(req),
      days:  Math.min(parseInt(req.query.days, 10)  || 90, 730),
      limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
    }));
  } catch (err) { fail(res, err); }
});

/**
 * The customer-facing surface. Published AND public only.
 *
 * Deliberately does NOT require servicedesk.view — a portal reader has no ERP
 * permissions. It is also the reason the SELECT is an explicit column list:
 * `SELECT *` here would ship author_id, approver, rejection reasons and internal
 * review dates to a customer the first time someone adds a column.
 */
router.get('/public', async (req, res) => {
  try {
    const companyId = cid(req);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const params = [companyId];
    let where = `($1::int IS NULL OR company_id = $1) AND status = 'published' AND visibility = 'public'`;
    if (req.query.search) {
      params.push(`%${req.query.search}%`);
      where += ` AND (title ILIKE $${params.length} OR content ILIKE $${params.length})`;
    }
    if (req.query.category) { params.push(req.query.category); where += ` AND category = $${params.length}`; }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, title, summary, content, category, array_to_string(tags, ',') AS tags,
              views, helpful_yes, helpful_no, published_at
         FROM service_knowledge_base
        WHERE ${where}
        ORDER BY views DESC NULLS LAST
        LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/:id', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, array_to_string(a.tags, ',') AS tags
         FROM service_knowledge_base a
        WHERE a.id = $1 AND ($2::int IS NULL OR a.company_id = $2)`,
      [req.params.id, cid(req)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Article not found' });
    res.json(rows[0]);
  } catch (err) { fail(res, err); }
});

router.get('/:id/versions', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.id, v.version, v.title, v.summary, v.category, v.tags, v.visibility,
              v.status, v.change_note, v.created_at, v.changed_by,
              e.first_name || ' ' || COALESCE(e.last_name,'') AS changed_by_name
         FROM knowledge_article_versions v
         LEFT JOIN employees e ON e.id = v.changed_by
        WHERE v.article_id = $1 AND ($2::int IS NULL OR v.company_id = $2)
        ORDER BY v.version DESC`,
      [req.params.id, cid(req)]
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

// ── create ───────────────────────────────────────────────────────────────────
router.post('/', canAdd, async (req, res) => {
  try {
    const companyId = cid(req);
    const { title, summary: sum, content, category, tags, visibility, review_due_date } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (visibility && !['internal', 'public'].includes(visibility)) {
      return res.status(400).json({ error: "visibility must be 'internal' or 'public'" });
    }
    const employeeId = await employeeOf(req, pool);
    const tagsArr = typeof tags === 'string' ? tags.split(',').map(t => t.trim()).filter(Boolean)
                  : Array.isArray(tags) ? tags : [];

    // Always born a draft. An article that appears on the customer portal the
    // instant somebody types it is the failure the approval step exists to stop.
    const { rows: [article] } = await pool.query(
      `INSERT INTO service_knowledge_base
         (company_id, title, summary, content, category, tags, author_id,
          status, visibility, version, review_due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,1,$9)
       RETURNING *`,
      [companyId, title, sum || null, content || null, category || 'General', tagsArr,
       employeeId, visibility || 'internal', review_due_date || null]
    );
    logAudit({ userId: req.user?.userId, module: 'service', recordId: article.id,
      recordType: 'knowledge_article', action: 'create', newData: article, req });
    res.status(201).json(article);
  } catch (err) { fail(res, err); }
});

// ── edit (versioned) ─────────────────────────────────────────────────────────
router.put('/:id', canEdit, async (req, res) => {
  try {
    const employeeId = await employeeOf(req, pool);
    const { rows: [before] } = await pool.query(
      'SELECT * FROM service_knowledge_base WHERE id = $1', [req.params.id]);

    const out = await editArticle(pool, {
      id: req.params.id, companyId: cid(req), employeeId,
      patch: req.body, note: req.body.change_note || null,
    });
    if (out.error) return refuse(res, out);

    logAudit({ userId: req.user?.userId, module: 'service', recordId: out.article.id,
      recordType: 'knowledge_article', action: 'update', oldData: before, newData: out.article, req });

    res.json({
      ...out.article,
      version_saved: out.previousVersion,
      // Said plainly rather than left for the author to discover: their edit took
      // a live article off the portal and it needs re-approval.
      notice: out.unpublishedOnEdit
        ? 'Editing a published article returns it to draft. Submit it for review to publish again.'
        : undefined,
    });
  } catch (err) { fail(res, err); }
});

// ── lifecycle ────────────────────────────────────────────────────────────────
const move = (to) => async (req, res) => {
  try {
    const employeeId = await employeeOf(req, pool);
    const { rows: [before] } = await pool.query(
      'SELECT * FROM service_knowledge_base WHERE id = $1', [req.params.id]);

    const out = await transition(pool, {
      id: req.params.id, companyId: cid(req), to, employeeId,
      roles: rolesOf(req), reason: req.body?.reason,
    });
    if (out.error) return refuse(res, out);

    logAudit({ userId: req.user?.userId, module: 'service', recordId: out.article.id,
      recordType: 'knowledge_article', action: to, oldData: before, newData: out.article, req });
    res.json({ ...out.article, from: out.from, to: out.to });
  } catch (err) { fail(res, err); }
};

router.post('/:id/submit',    canEdit, move('in_review'));
router.post('/:id/approve',   canEdit, move('approved'));
router.post('/:id/reject',    canEdit, move('rejected'));
router.post('/:id/publish',   canEdit, move('published'));
router.post('/:id/archive',   canEdit, move('archived'));
router.post('/:id/unpublish', canEdit, move('draft'));

/** Restore an older version's text as a new version. Nothing is overwritten. */
router.post('/:id/restore/:version', canEdit, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const companyId = cid(req);
    const employeeId = await employeeOf(req, pool);

    const { rows: [current] } = await client.query(
      `SELECT * FROM service_knowledge_base
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) FOR UPDATE`,
      [req.params.id, companyId]);
    if (!current) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Article not found' }); }

    const { rows: [old] } = await client.query(
      `SELECT * FROM knowledge_article_versions WHERE article_id = $1 AND version = $2`,
      [req.params.id, req.params.version]);
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Version not found' }); }

    await snapshotVersion(client, current, {
      changedBy: employeeId, note: `superseded by restore of v${old.version}` });

    const { rows: [restored] } = await client.query(
      `UPDATE service_knowledge_base
          SET title=$1, summary=$2, content=$3, category=$4,
              tags = string_to_array(NULLIF($5,''), ','),
              version = version + 1, status = 'draft', published_at = NULL, updated_at = NOW()
        WHERE id = $6 RETURNING *`,
      [old.title, old.summary, old.content, old.category, old.tags || '', req.params.id]);

    await client.query('COMMIT');
    logAudit({ userId: req.user?.userId, module: 'service', recordId: restored.id,
      recordType: 'knowledge_article', action: 'restore', oldData: current, newData: restored, req });
    res.json({ ...restored, restored_from_version: Number(req.params.version) });
  } catch (err) {
    await client.query('ROLLBACK'); fail(res, err);
  } finally { client.release(); }
});

// ── effectiveness signals ────────────────────────────────────────────────────
/**
 * A read, a thumbs up or a thumbs down.
 *
 * Needs only a logged-in caller: an agent rating an article is the measurement,
 * and requiring an edit permission to say "this did not help" would guarantee the
 * signal never arrives.
 */
router.post('/:id/feedback', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const out = await recordFeedback(pool, {
      articleId: req.params.id, companyId: cid(req),
      event: req.body?.event, reason: req.body?.reason,
      employeeId: await employeeOf(req, pool), ticketId: req.body?.ticket_id || null,
    });
    if (out.error) return refuse(res, out);
    res.json(out.article);
  } catch (err) { fail(res, err); }
});

/** Link an article to the case it was used on, and say whether it resolved it. */
router.post('/:id/cases', canEdit, async (req, res) => {
  try {
    const { ticket_id, resolved_it } = req.body || {};
    if (!ticket_id) return res.status(400).json({ error: 'ticket_id is required' });
    const companyId = cid(req);

    const { rows: [article] } = await pool.query(
      `SELECT id, company_id FROM service_knowledge_base
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)`, [req.params.id, companyId]);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    // The ticket must belong to the same company. Without this the link itself
    // becomes a cross-tenant read: "article 4 was used on ticket 91" tells you
    // ticket 91 exists.
    const { rows: [ticket] } = await pool.query(
      `SELECT id FROM support_tickets
        WHERE id = $1 AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL`,
      [ticket_id, companyId]);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const { rows: [link] } = await pool.query(
      `INSERT INTO knowledge_article_cases (article_id, ticket_id, company_id, linked_by, resolved_it)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (article_id, ticket_id)
         DO UPDATE SET resolved_it = EXCLUDED.resolved_it
       RETURNING *`,
      [req.params.id, ticket_id, article.company_id, await employeeOf(req, pool), resolved_it === true]);
    res.status(201).json(link);
  } catch (err) { fail(res, err); }
});

router.get('/:id/cases', canView, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.ticket_id, c.resolved_it, c.created_at,
              t.ticket_number, t.title AS subject, t.status AS ticket_status
         FROM knowledge_article_cases c
         LEFT JOIN support_tickets t ON t.id = c.ticket_id
        WHERE c.article_id = $1 AND ($2::int IS NULL OR c.company_id = $2)
        ORDER BY c.created_at DESC`,
      [req.params.id, cid(req)]);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

/** The transition table, so a UI can offer exactly the moves that will succeed. */
router.get('/meta/transitions', canView, (_req, res) => res.json(TRANSITIONS));

export default router;
