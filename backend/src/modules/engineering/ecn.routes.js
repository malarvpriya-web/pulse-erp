import { Router } from 'express';
import pool from '../shared/db.js';
import { nextEcnNumber } from '../../shared/docNumber.js';
import notificationsRepository from '../notifications/repositories/notifications.repository.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { companyOf } from '../../shared/scope.js';

const router = Router();

// Company scope (null = global super admin). companyOf() also falls back to the
// user's own row for a token without a company claim (shared/scope.js).
const cid = (req) => companyOf(req);

/**
 * Load one engineering change inside the caller's company — every
 * `/changes/:id` route goes through this. They used to read and write
 * `WHERE id = $1` alone, so any engineering user could read, edit, submit,
 * approve, reject or implement another company's ECN by id. A change in another
 * company is reported exactly like a missing one (404).
 * `lock` takes a row lock for the decision routes, so two decisions on the same
 * change serialise instead of both acting on what they read.
 */
async function loadEcn(db, req, id, { lock = false } = {}) {
  if (!/^\d+$/.test(String(id))) return null;
  const { rows } = await db.query(
    `SELECT * FROM engineering_changes
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
      ${lock ? 'FOR UPDATE' : ''}`,
    [id, cid(req)]
  );
  return rows[0] || null;
}
const notFound = (res) => res.status(404).json({ error: 'Engineering change not found' });

/**
 * Policy (2026-10-20): an ECN is decided only by its NAMED approvers. A change
 * with none used to be approvable by anyone holding engineering:add. Now:
 *   - it cannot be submitted (400 APPROVERS_REQUIRED);
 *   - approve/reject on one that is already submitted fail closed
 *     (409 APPROVER_CONFIGURATION_REQUIRED) and change nothing;
 *   - approvers are named at creation, or added to a change that has none via
 *     PUT /changes/:id { approvers } — the same list shape POST /changes takes.
 */
const APPROVER_HELP = 'Name at least one approver: PUT /engineering/ecn/changes/:id with '
  + '{ approvers: [{ approver_id: <user id> }] } (allowed while the change has none), then submit.';

/**
 * Named approvers come from the request body, so each is checked: an active
 * login in the change's company that holds engineering:add (what the approve
 * route requires — anyone else could never act), and not the requester.
 * Returns { error } or { list } (deduplicated).
 */
async function vetApprovers(db, approvers, companyId, requesterUserId) {
  const ids = [...new Set((Array.isArray(approvers) ? approvers : [])
    .map((a) => Number(a?.approver_id)).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { list: [] };
  if (requesterUserId != null && ids.includes(Number(requesterUserId))) {
    return { error: 'The requester cannot be an approver of their own change.' };
  }
  const { rows } = await db.query(
    `SELECT u.id, COALESCE(u.name, u.email) AS name
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.id = ANY($1::int[]) AND u.is_active = TRUE
        AND ($2::int IS NULL OR COALESCE(e.company_id, u.company_id) = $2)
        AND (EXISTS (SELECT 1 FROM permissions p
                      WHERE p.user_id = u.id AND p.module = 'engineering' AND p.can_add)
             OR (NOT EXISTS (SELECT 1 FROM permissions p WHERE p.user_id = u.id AND p.module = 'engineering')
                 AND EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                              WHERE ur.user_id = u.id AND rp.module = 'engineering' AND rp.can_add)))`,
    [ids, companyId ?? null]
  );
  if (rows.length !== ids.length) {
    return { error: 'Every approver must be an active user in this company with engineering access.' };
  }
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  const supplied = new Map((approvers || []).map((a) => [Number(a?.approver_id), a]));
  return { list: ids.map((id) => ({ approver_id: id, approver_name: supplied.get(id)?.approver_name || byId.get(id),
                                    role_name: supplied.get(id)?.role_name || null })) };
}
async function insertApprovers(client, ecnId, list) {
  for (const a of list) {
    await client.query(
      `INSERT INTO engineering_change_approvals
        (engineering_change_id, approver_id, approver_name, role_name, status)
       VALUES ($1,$2,$3,$4,'pending')`,
      [ecnId, a.approver_id, a.approver_name || null, a.role_name || null]
    );
  }
}

const actorFromReq = (req) => ({
  id: req.user?.userId || req.user?.id || null,
  name: req.user?.name || req.user?.email || 'System',
});

async function logEvent(client, engineeringChangeId, eventName, req, eventNote = null, eventData = {}) {
  const actor = actorFromReq(req);
  await client.query(
    `INSERT INTO engineering_change_events
      (engineering_change_id, event_name, event_note, actor_id, actor_name, event_data)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [engineeringChangeId, eventName, eventNote, actor.id, actor.name, JSON.stringify(eventData || {})]
  );
}

// Automation Opportunity Audit §18.2 — submit/approve/reject/implement only
// ever called logEvent(), writing an audit row nobody sees unless they open
// the ECN. Production, Quality, and Procurement are the three departments an
// engineering change actually affects; none of them were told. Named roles
// straight from the audit's own automation flow, resolved the same way
// vendorDocExpiry.cron.js resolves its receivers (role code, not permission
// grant, since these are specific named departments, not "whoever can edit
// module X").
async function notifyEcnImplemented(ecn) {
  const { rows } = await pool.query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = true
       AND r.code IN ('production_manager', 'qc_manager', 'procurement_manager')
       AND COALESCE(e.company_id, u.company_id) = $1`,
    [ecn.company_id]
  );
  for (const { id: userId } of rows) {
    await notificationsRepository.create({
      user_id: userId,
      title: `ECN Implemented: ${ecn.ecn_number}`,
      message: `${ecn.title} (${ecn.ecn_number}) has been implemented. Review affected specs/stock/purchasing for impact.`,
      module_name: 'engineering',
      reference_id: ecn.id,
      notification_type: 'ecn_implemented',
    });
  }
}

// Gated on the owning module 2026-09-04. A live probe with a plain
// `employee` token returned other people's records from this router, and an
// employee has no routine need for this register — their own record reaches
// them through self-service. `employee` is denied engineering in role_permissions,
// which is what makes this gate real rather than decorative.
router.get('/changes', requirePermission('engineering', 'view'), async (req, res) => {
  try {
    const { status, change_type, severity, search } = req.query;
    const companyId = cid(req);
    const params = [companyId];
    const where = [`($1::int IS NULL OR c.company_id = $1)`];
    if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
    if (change_type) { params.push(change_type); where.push(`c.change_type = $${params.length}`); }
    if (severity) { params.push(severity); where.push(`c.severity = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(c.ecn_number ILIKE $${params.length} OR c.title ILIKE $${params.length})`);
    }
    const { rows } = await pool.query(
      `SELECT c.*,
        (SELECT COUNT(*) FROM engineering_change_items i WHERE i.engineering_change_id = c.id) AS impacted_items,
        (SELECT COUNT(*) FROM engineering_change_approvals a WHERE a.engineering_change_id = c.id AND a.status = 'approved') AS approvals_done
       FROM engineering_changes c
       WHERE ${where.join(' AND ')}
       ORDER BY c.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/changes', requirePermission('engineering', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      title,
      change_type = 'ECN',
      severity = 'medium',
      reason,
      impact_summary,
      owner_id,
      owner_name,
      effective_from,
      implementation_due,
      approvers = [],
    } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });

    await client.query('BEGIN');
    const actor = actorFromReq(req);
    const companyId = cid(req);
    const vetted = await vetApprovers(client, approvers, companyId, actor.id);
    if (vetted.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: vetted.error, code: 'INVALID_APPROVERS' });
    }
    const ecnNumber = await nextEcnNumber(client);
    const { rows } = await client.query(
      `INSERT INTO engineering_changes
        (ecn_number, title, change_type, status, severity, reason, impact_summary,
         requested_by, requested_by_name, owner_id, owner_name, effective_from, implementation_due, company_id)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [ecnNumber, title, change_type, severity, reason, impact_summary, actor.id, actor.name, owner_id || null, owner_name || null, effective_from || null, implementation_due || null, companyId]
    );
    const created = rows[0];

    await insertApprovers(client, created.id, vetted.list);
    await logEvent(client, created.id, 'created', req, 'Engineering change created');
    await client.query('COMMIT');
    res.status(201).json(created);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.get('/changes/:id', requirePermission('engineering', 'view'), async (req, res) => {
  try {
    const ecn = await loadEcn(pool, req, req.params.id);
    if (!ecn) return notFound(res);
    const rows = [ecn];
    const [items, approvals, events] = await Promise.all([
      pool.query(`SELECT * FROM engineering_change_items WHERE engineering_change_id = $1 ORDER BY id`, [req.params.id]),
      pool.query(`SELECT * FROM engineering_change_approvals WHERE engineering_change_id = $1 ORDER BY id`, [req.params.id]),
      pool.query(`SELECT * FROM engineering_change_events WHERE engineering_change_id = $1 ORDER BY created_at DESC`, [req.params.id]),
    ]);
    res.json({ ...rows[0], items: items.rows, approvals: approvals.rows, events: events.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/changes/:id', requirePermission('engineering', 'edit'), captureBefore('engineering_changes'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { title, severity, reason, impact_summary, owner_id, owner_name, effective_from, implementation_due, approvers } = req.body;
    await client.query('BEGIN');
    const current = await loadEcn(client, req, req.params.id, { lock: true });
    if (!current) {
      await client.query('ROLLBACK');
      return notFound(res);
    }
    if (approvers !== undefined) {
      // Only a change with NO approvers can be given some here — re-pointing a
      // review that is under way is not supported.
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM engineering_change_approvals WHERE engineering_change_id = $1`, [current.id]);
      if (n > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This change already has approvers; they cannot be replaced here.' });
      }
      const vetted = await vetApprovers(client, approvers, current.company_id, current.requested_by);
      if (vetted.error || !vetted.list.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: vetted.error || 'approvers must name at least one approver', code: 'INVALID_APPROVERS' });
      }
      if (!['draft', 'submitted'].includes(current.status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Only draft/submitted changes can be edited' });
      }
      await insertApprovers(client, current.id, vetted.list);
    }
    const { rows } = await client.query(
      `UPDATE engineering_changes
       SET title = COALESCE($1, title),
           severity = COALESCE($2, severity),
           reason = COALESCE($3, reason),
           impact_summary = COALESCE($4, impact_summary),
           owner_id = COALESCE($5, owner_id),
           owner_name = COALESCE($6, owner_name),
           effective_from = COALESCE($7, effective_from),
           implementation_due = COALESCE($8, implementation_due),
           updated_at = NOW()
       WHERE id = $9 AND status IN ('draft','submitted')
       RETURNING *`,
      [title, severity, reason, impact_summary, owner_id, owner_name, effective_from, implementation_due, req.params.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft/submitted changes can be edited' });
    }
    await logEvent(client, req.params.id, 'updated', req, 'Engineering change updated');
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/changes/:id/items', requirePermission('engineering', 'add'), async (req, res) => {
  try {
    const {
      item_type,
      item_ref_id,
      item_code,
      item_name,
      current_revision,
      proposed_revision,
      effectivity_note,
      change_summary,
    } = req.body;
    if (!item_type) return res.status(400).json({ error: 'item_type is required' });
    if (!(await loadEcn(pool, req, req.params.id))) return notFound(res);
    const { rows } = await pool.query(
      `INSERT INTO engineering_change_items
        (engineering_change_id, item_type, item_ref_id, item_code, item_name, current_revision,
         proposed_revision, effectivity_note, change_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [req.params.id, item_type, item_ref_id || null, item_code || null, item_name || null, current_revision || null, proposed_revision || null, effectivity_note || null, change_summary || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/changes/items/:itemId', requirePermission('engineering', 'delete'), async (req, res) => {
  try {
    // Scoped through the parent change's company.
    const { rowCount } = await pool.query(
      `DELETE FROM engineering_change_items i
        USING engineering_changes c
        WHERE i.id = $1 AND c.id = i.engineering_change_id
          AND ($2::int IS NULL OR c.company_id = $2)`,
      [req.params.itemId, cid(req)]
    );
    if (!rowCount) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/changes/:id/submit', requirePermission('engineering', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await loadEcn(client, req, req.params.id, { lock: true }))) {
      await client.query('ROLLBACK');
      return notFound(res);
    }
    const itemsCheck = await client.query(
      `SELECT COUNT(*)::INT AS n FROM engineering_change_items WHERE engineering_change_id = $1`,
      [req.params.id]
    );
    if ((itemsCheck.rows[0]?.n || 0) === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot submit change without impacted items' });
    }
    const { rows: [{ n: approverCount }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM engineering_change_approvals WHERE engineering_change_id = $1`, [req.params.id]);
    if (!approverCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `This change has no approvers, so nobody could approve it. ${APPROVER_HELP}`,
        code: 'APPROVERS_REQUIRED' });
    }
    const { rows } = await client.query(
      `UPDATE engineering_changes SET status = 'submitted', updated_at = NOW()
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only draft changes can be submitted' });
    }
    await logEvent(client, req.params.id, 'submitted', req, 'Engineering change submitted for approval');
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/changes/:id/approve', requirePermission('engineering', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { remarks } = req.body;
    const actor = actorFromReq(req);
    await client.query('BEGIN');
    const ecn = await loadEcn(client, req, req.params.id, { lock: true });
    if (!ecn) { await client.query('ROLLBACK'); return notFound(res); }
    if (ecn.status !== 'submitted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This change is ${ecn.status}, not awaiting approval` });
    }

    // Parallel approvers: each named approver records their own decision; the
    // change is approved when none remain pending. The caller must hold a
    // PENDING approver row. Before this, a caller who was not an approver got
    // `{ success: true }` while nothing changed, and a change whose approvers
    // had all acted could be "approved" by anyone with engineering:add.
    const { rows: named } = await client.query(
      `SELECT id FROM engineering_change_approvals WHERE engineering_change_id = $1`, [ecn.id]);
    if (!named.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This change has no named approvers, so it cannot be approved. ${APPROVER_HELP}`,
        code: 'APPROVER_CONFIGURATION_REQUIRED' });
    }
    {
      const mine = await client.query(
        `UPDATE engineering_change_approvals
            SET status = 'approved', remarks = $1, acted_at = NOW()
          WHERE engineering_change_id = $2 AND approver_id = $3 AND status = 'pending'
          RETURNING id`,
        [remarks || null, ecn.id, actor.id]
      );
      if (!mine.rowCount) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You are not a pending approver on this change' });
      }
    }

    const { rows: [{ n }] } = await client.query(
      `SELECT COUNT(*)::INT AS n FROM engineering_change_approvals
        WHERE engineering_change_id = $1 AND status = 'pending'`, [ecn.id]);
    let status = ecn.status;
    if (n === 0) {
      const { rows } = await client.query(
        `UPDATE engineering_changes
            SET status = 'approved', approved_at = NOW(), approved_by = $1, approved_by_name = $2, updated_at = NOW()
          WHERE id = $3 AND status = 'submitted'
          RETURNING status`,
        [actor.id, actor.name, ecn.id]
      );
      status = rows[0]?.status ?? status;
    }
    await logEvent(client, ecn.id, 'approved', req, 'Approval action recorded', { remarks: remarks || null });
    await client.query('COMMIT');
    res.json({ success: true, status, approvals_pending: n });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/changes/:id/reject', requirePermission('engineering', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { remarks } = req.body;
    const actor = actorFromReq(req);
    await client.query('BEGIN');
    const ecn = await loadEcn(client, req, req.params.id, { lock: true });
    if (!ecn) { await client.query('ROLLBACK'); return notFound(res); }

    // One named approver's rejection rejects the change (unchanged rule) — but
    // it must BE a named approver with a pending decision. Any engineering:add
    // holder could reject any company's change before this.
    const { rows: named } = await client.query(
      `SELECT id FROM engineering_change_approvals WHERE engineering_change_id = $1`, [ecn.id]);
    if (!named.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This change has no named approvers, so it cannot be decided. ${APPROVER_HELP}`,
        code: 'APPROVER_CONFIGURATION_REQUIRED' });
    }
    {
      if (ecn.status !== 'submitted') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `This change is ${ecn.status}, not awaiting approval` });
      }
      const mine = await client.query(
        `UPDATE engineering_change_approvals
            SET status = 'rejected', remarks = $1, acted_at = NOW()
          WHERE engineering_change_id = $2 AND approver_id = $3 AND status = 'pending'
          RETURNING id`,
        [remarks || null, ecn.id, actor.id]
      );
      if (!mine.rowCount) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'You are not a pending approver on this change' });
      }
    }
    const { rows } = await client.query(
      `UPDATE engineering_changes
       SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND status IN ('submitted','approved')
       RETURNING *`,
      [ecn.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Change cannot be rejected in current state' });
    }
    await logEvent(client, ecn.id, 'rejected', req, 'Engineering change rejected', { remarks: remarks || null });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/changes/:id/implement', requirePermission('engineering', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { implementation_note } = req.body;
    const actor = actorFromReq(req);
    await client.query('BEGIN');
    if (!(await loadEcn(client, req, req.params.id, { lock: true }))) {
      await client.query('ROLLBACK');
      return notFound(res);
    }
    const { rows } = await client.query(
      `UPDATE engineering_changes
       SET status = 'implemented',
           implemented_at = NOW(),
           implemented_by = $1,
           implemented_by_name = $2,
           updated_at = NOW()
       WHERE id = $3 AND status = 'approved'
       RETURNING *`,
      [actor.id, actor.name, req.params.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only approved changes can be implemented' });
    }

    // Promote any BOM version drafted under this ECN (via bom.routes.js's
    // POST /bom/:id/version) to the live version, retiring whatever was active
    // before. This is what makes "implement" actually change production data
    // instead of just flipping a status flag — production keeps building to
    // the old spec otherwise.
    const promoted = [];
    const { rows: draftBoms } = await client.query(
      `SELECT * FROM bom_headers WHERE ecn_id = $1 AND status = 'draft'`,
      [req.params.id]
    );
    for (const draft of draftBoms) {
      await client.query(
        `UPDATE bom_headers SET status='superseded', updated_at=NOW()
         WHERE status='active' AND id <> $1
           AND (product_name = $2 OR (product_id IS NOT NULL AND product_id = $3))
           AND ($4::int IS NULL OR company_id = $4)`,
        [draft.id, draft.product_name, draft.product_id, draft.company_id ?? null]
      );
      await client.query(`UPDATE bom_headers SET status='active', updated_at=NOW() WHERE id=$1`, [draft.id]);
      promoted.push({ bom_id: draft.id, version: draft.version });
    }
    if (promoted.length) {
      await logEvent(client, req.params.id, 'bom_promoted', req, 'Draft BOM version(s) promoted to active', { promoted });
    }

    await logEvent(client, req.params.id, 'implemented', req, implementation_note || 'Engineering change implemented');
    await client.query('COMMIT');
    res.json({ ...rows[0], promoted_boms: promoted });

    // Best-effort, after the response is sent — notification failure must not
    // undo an implementation that already committed.
    notifyEcnImplemented(rows[0]).catch((err) =>
      console.error(`[ecn.routes] implement notify failed for ECN ${rows[0].id}:`, err.message)
    );
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── Document Traceability (Phase 30F) ─────────────────────────────────────
   GET /changes/:id/documents  — all documents linked to an ECN
   GET /changes/:id/signatures — all signature requests linked to an ECN
   ────────────────────────────────────────────────────────────────────────── */
router.get('/changes/:id/documents', requirePermission('engineering', 'view'), async (req, res) => {
  try {
    if (!(await loadEcn(pool, req, req.params.id))) return notFound(res);
    const { rows } = await pool.query(
      `SELECT * FROM document_master
       WHERE linked_entity_type = 'ecn' AND linked_entity_id = $1
         AND deleted_at IS NULL
       ORDER BY revision DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/changes/:id/signatures', requirePermission('engineering', 'view'), async (req, res) => {
  try {
    if (!(await loadEcn(pool, req, req.params.id))) return notFound(res);
    const { rows } = await pool.query(
      `SELECT s.*,
         (SELECT json_agg(al ORDER BY al.occurred_at)
          FROM signature_audit_log al WHERE al.signing_id = s.id) AS audit_trail
       FROM document_signings s
       WHERE s.linked_entity_type = 'ecn' AND s.linked_entity_id = $1
       ORDER BY s.created_at`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
export { notifyEcnImplemented };
