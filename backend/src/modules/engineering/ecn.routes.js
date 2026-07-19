import { Router } from 'express';
import pool from '../shared/db.js';
import { nextEcnNumber } from '../../shared/docNumber.js';

const router = Router();

// Extract optional company scope (null = no isolation, backward compat)
const cid = (req) => req.scope?.company_id ?? null;

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

router.get('/changes', async (req, res) => {
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

router.post('/changes', async (req, res) => {
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

    for (const approver of approvers) {
      if (!approver?.approver_id) continue;
      await client.query(
        `INSERT INTO engineering_change_approvals
          (engineering_change_id, approver_id, approver_name, role_name, status)
         VALUES ($1,$2,$3,$4,'pending')`,
        [created.id, approver.approver_id, approver.approver_name || null, approver.role_name || null]
      );
    }
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

router.get('/changes/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM engineering_changes WHERE id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Engineering change not found' });
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

router.put('/changes/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { title, severity, reason, impact_summary, owner_id, owner_name, effective_from, implementation_due } = req.body;
    await client.query('BEGIN');
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

router.post('/changes/:id/items', async (req, res) => {
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

router.delete('/changes/items/:itemId', async (req, res) => {
  try {
    await pool.query(`DELETE FROM engineering_change_items WHERE id = $1`, [req.params.itemId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/changes/:id/submit', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemsCheck = await client.query(
      `SELECT COUNT(*)::INT AS n FROM engineering_change_items WHERE engineering_change_id = $1`,
      [req.params.id]
    );
    if ((itemsCheck.rows[0]?.n || 0) === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot submit change without impacted items' });
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

router.post('/changes/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    const { remarks } = req.body;
    const actor = actorFromReq(req);
    await client.query('BEGIN');
    await client.query(
      `UPDATE engineering_change_approvals
       SET status = 'approved', remarks = $1, acted_at = NOW()
       WHERE engineering_change_id = $2 AND approver_id = $3 AND status = 'pending'`,
      [remarks || null, req.params.id, actor.id]
    );

    const pending = await client.query(
      `SELECT COUNT(*)::INT AS n
       FROM engineering_change_approvals
       WHERE engineering_change_id = $1 AND status = 'pending'`,
      [req.params.id]
    );
    if ((pending.rows[0]?.n || 0) === 0) {
      await client.query(
        `UPDATE engineering_changes
         SET status = 'approved', approved_at = NOW(), approved_by = $1, approved_by_name = $2, updated_at = NOW()
         WHERE id = $3 AND status = 'submitted'`,
        [actor.id, actor.name, req.params.id]
      );
    }
    await logEvent(client, req.params.id, 'approved', req, 'Approval action recorded', { remarks: remarks || null });
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/changes/:id/reject', async (req, res) => {
  const client = await pool.connect();
  try {
    const { remarks } = req.body;
    const actor = actorFromReq(req);
    await client.query('BEGIN');
    await client.query(
      `UPDATE engineering_change_approvals
       SET status = 'rejected', remarks = $1, acted_at = NOW()
       WHERE engineering_change_id = $2 AND approver_id = $3 AND status = 'pending'`,
      [remarks || null, req.params.id, actor.id]
    );
    const { rows } = await client.query(
      `UPDATE engineering_changes
       SET status = 'rejected', updated_at = NOW()
       WHERE id = $1 AND status IN ('submitted','approved')
       RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Change cannot be rejected in current state' });
    }
    await logEvent(client, req.params.id, 'rejected', req, 'Engineering change rejected', { remarks: remarks || null });
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.post('/changes/:id/implement', async (req, res) => {
  const client = await pool.connect();
  try {
    const { implementation_note } = req.body;
    const actor = actorFromReq(req);
    await client.query('BEGIN');
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
    await logEvent(client, req.params.id, 'implemented', req, implementation_note || 'Engineering change implemented');
    await client.query('COMMIT');
    res.json(rows[0]);
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
router.get('/changes/:id/documents', async (req, res) => {
  try {
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

router.get('/changes/:id/signatures', async (req, res) => {
  try {
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
