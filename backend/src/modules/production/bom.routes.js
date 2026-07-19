// backend/src/modules/production/bom.routes.js
import { Router } from 'express';
import pool from '../../config/db.js';
import { logAudit } from '../../services/AuditService.js';
import { nextEcnNumber } from '../../shared/docNumber.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();


// Seed removed: work centres must be configured through the Work Centres UI in production environments.

/* ── helper: build full BOM tree from flat list ── */
async function buildBOMTree(bomId) {
  const { rows: lines } = await pool.query(
    `SELECT * FROM bom_lines WHERE bom_id = $1 ORDER BY level, id`, [bomId]
  );
  const map = {};
  lines.forEach(l => { l.children = []; map[l.id] = l; });
  const roots = [];
  lines.forEach(l => {
    if (l.parent_line_id && map[l.parent_line_id]) {
      map[l.parent_line_id].children.push(l);
    } else {
      roots.push(l);
    }
  });
  return roots;
}

/* ── helper: recursive BOM explosion for MRP ── */
async function explodeBOM(bomId, multiplier, companyId, results = {}) {
  const { rows: lines } = await pool.query(
    `SELECT * FROM bom_lines WHERE bom_id = $1`, [bomId]
  );
  for (const line of lines) {
    const required = parseFloat(line.qty) * multiplier;
    if (results[line.component_name]) {
      results[line.component_name].required += required;
    } else {
      results[line.component_name] = {
        component_id: line.component_id,
        component: line.component_name,
        unit: line.unit,
        unit_cost: parseFloat(line.unit_cost || 0),
        required,
      };
    }
    if (line.component_id) {
      const { rows: subBOM } = await pool.query(
        `SELECT id FROM bom_headers
         WHERE product_id = $1 AND status = 'active'
           AND (company_id = $2 OR company_id IS NULL)
         LIMIT 1`,
        [line.component_id, companyId]
      );
      if (subBOM.length) await explodeBOM(subBOM[0].id, required, companyId, results);
    }
  }
  return results;
}

/* ── helper: actor from request ── */
const actorFromReq = (req) => ({
  id: req.user?.userId || req.user?.id || null,
  name: req.user?.name || req.user?.email || 'System',
});

/* ── GET /bom ── */
router.get('/bom', requirePermission('bom', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(`
      SELECT h.*,
        (SELECT COUNT(*) FROM bom_lines WHERE bom_id = h.id) as component_count,
        (SELECT COALESCE(SUM(qty * unit_cost),0) FROM bom_lines WHERE bom_id = h.id) as total_material_cost,
        ec.ecn_number
      FROM bom_headers h
      LEFT JOIN engineering_changes ec ON ec.id = h.ecn_id
      WHERE h.company_id = $1
      ORDER BY h.product_name, h.version DESC
    `, [cid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── helper: generate BOM number from configured convention ── */
async function nextBomNumber(client, companyId) {
  try {
    const { rows } = await client.query(
      `SELECT settings FROM company_settings WHERE company_id=$1 AND module='bom_policies' LIMIT 1`,
      [companyId]
    );
    const convention = rows[0]?.settings?.numberingConvention ?? 'BOM-{YYYY}-{seq}';
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm   = String(now.getMonth() + 1).padStart(2, '0');

    // Derive next sequence within this year
    const { rows: seqRows } = await client.query(
      `SELECT COUNT(*)::INT AS n FROM bom_headers
       WHERE company_id=$1 AND bom_number LIKE $2`,
      [companyId, `%${yyyy}%`]
    );
    const seq = String((seqRows[0]?.n ?? 0) + 1).padStart(3, '0');

    return convention
      .replace(/\{YYYY\}/g, yyyy)
      .replace(/\{MM\}/g,   mm)
      .replace(/\{seq\}/g,  seq);
  } catch {
    return null;
  }
}

/* ── POST /bom ── */
router.post('/bom', requirePermission('bom', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) { client.release(); return res.status(403).json({ error: 'Company scope required' }); }
    const cid = req.scope?.company_id;
    const { product_id, product_name, version = 1, status = 'draft', notes } = req.body;
    if (!product_name || !String(product_name).trim()) {
      return res.status(400).json({ error: 'Product name is required' });
    }
    // Coerce optional numerics — '' from a form must not reach INTEGER columns.
    const safeProductId = Number.parseInt(product_id, 10);
    const safeVersion   = Number.parseInt(version, 10);

    await client.query('BEGIN');
    const bomNumber = await nextBomNumber(client, cid);

    let insertCols = 'company_id, product_id, product_name, version, status, notes';
    let insertPH   = '$1,$2,$3,$4,$5,$6';
    let insertParams = [
      cid,
      Number.isNaN(safeProductId) ? null : safeProductId,
      String(product_name).trim(),
      Number.isNaN(safeVersion) ? 1 : safeVersion,
      status,
      notes || null,
    ];
    if (bomNumber) {
      insertCols += ', bom_number';
      insertPH   += ',$7';
      insertParams.push(bomNumber);
    }

    const { rows } = await client.query(
      `INSERT INTO bom_headers (${insertCols}) VALUES (${insertPH}) RETURNING *`,
      insertParams
    );
    await client.query('COMMIT');

    const actor = actorFromReq(req);
    logAudit({ userId: actor.id, module: 'bom', recordId: rows[0].id, recordType: 'bom_header', action: 'create', newData: rows[0], req });
    res.status(201).json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── GET /bom/:id ── */
router.get('/bom/:id', requirePermission('bom', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: headerRows } = await pool.query(
      `SELECT h.*, ec.ecn_number, ec.status as ecn_status, ec.approved_by_name, ec.approved_at
       FROM bom_headers h
       LEFT JOIN engineering_changes ec ON ec.id = h.ecn_id
       WHERE h.id = $1 AND h.company_id = $2`,
      [req.params.id, cid]
    );
    const header = headerRows[0];
    if (!header) return res.status(404).json({ error: 'BOM not found' });
    const tree = await buildBOMTree(req.params.id);
    const { rows: routing } = await pool.query(
      `SELECT r.*, w.name as work_centre_name, w.cost_per_hour
       FROM routing_steps r LEFT JOIN work_centres w ON w.id = r.work_centre_id
       WHERE r.bom_id = $1 ORDER BY r.step_no`, [req.params.id]
    );
    const { rows: [costRow] } = await pool.query(
      `SELECT COALESCE(SUM(qty*unit_cost),0) as total FROM bom_lines WHERE bom_id=$1`, [req.params.id]
    );
    const totalRouteHrs = routing.reduce((s, r) => s + parseFloat(r.std_time_hrs || 0), 0);
    res.json({ ...header, tree, routing, total_material_cost: costRow.total, total_route_hrs: totalRouteHrs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /bom/:id/versions — history for the same product ── */
router.get('/bom/:id/versions', requirePermission('bom', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [src] } = await pool.query(
      'SELECT product_name, product_id FROM bom_headers WHERE id=$1 AND company_id=$2', [req.params.id, cid]
    );
    if (!src) return res.status(404).json({ error: 'BOM not found' });
    const { rows } = await pool.query(
      `SELECT h.id, h.version, h.status, h.change_reason, h.frozen_at, h.frozen_by_name,
              h.created_at, ec.ecn_number, ec.approved_by_name, ec.approved_at,
              (SELECT COUNT(*) FROM bom_lines WHERE bom_id = h.id) as component_count
       FROM bom_headers h
       LEFT JOIN engineering_changes ec ON ec.id = h.ecn_id
       WHERE h.company_id = $3
         AND (h.product_name = $1 OR (h.product_id IS NOT NULL AND h.product_id = $2))
       ORDER BY h.version DESC`,
      [src.product_name, src.product_id, cid]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /bom/:id ── */
router.put('/bom/:id', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [oldBom] } = await pool.query('SELECT * FROM bom_headers WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    if (!oldBom) return res.status(404).json({ error: 'BOM not found' });
    if (oldBom?.frozen_at) return res.status(400).json({ error: 'BOM is frozen — raise an ECN to create a new version' });
    const { product_name, status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE bom_headers SET product_name=$1, status=$2, notes=$3, updated_at=NOW()
       WHERE id=$4 AND company_id=$5 RETURNING *`,
      [product_name, status, notes, req.params.id, cid]
    );
    const actor = actorFromReq(req);
    logAudit({ userId: actor.id, module: 'bom', recordId: req.params.id, recordType: 'bom_header', action: 'update', oldData: oldBom, newData: rows[0], req });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /bom/:id/lines ── */
router.post('/bom/:id/lines', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [bom] } = await pool.query('SELECT frozen_at FROM bom_headers WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    if (bom?.frozen_at) return res.status(400).json({ error: 'BOM is frozen — raise an ECN to create a new version' });
    const { component_id, component_name, qty, unit, unit_cost, level, parent_line_id } = req.body;
    if (!component_name || !String(component_name).trim()) {
      return res.status(400).json({ error: 'Component name is required' });
    }
    // Coerce numeric inputs — empty strings from optional form fields must not
    // reach NUMERIC columns (PostgreSQL rejects '' with "invalid input syntax").
    const safeQty   = Number.parseFloat(qty);
    const safeCost  = Number.parseFloat(unit_cost);
    const safeCompId = Number.parseInt(component_id, 10);
    const safeLevel  = Number.parseInt(level, 10);
    const { rows } = await pool.query(
      `INSERT INTO bom_lines (bom_id, component_id, component_name, qty, unit, unit_cost, level, parent_line_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        req.params.id,
        Number.isNaN(safeCompId) ? null : safeCompId,
        String(component_name).trim(),
        Number.isNaN(safeQty) ? 1 : safeQty,
        unit || 'pcs',
        Number.isNaN(safeCost) ? 0 : safeCost,
        Number.isNaN(safeLevel) ? 1 : safeLevel,
        parent_line_id || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── DELETE /bom/lines/:lineId ── */
router.delete('/bom/lines/:lineId', requirePermission('bom', 'delete'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [lineRow] } = await pool.query(
      'SELECT l.*, h.frozen_at FROM bom_lines l JOIN bom_headers h ON h.id = l.bom_id WHERE l.id=$1 AND h.company_id=$2',
      [req.params.lineId, cid]
    );
    if (!lineRow) return res.status(404).json({ error: 'BOM line not found' });
    if (lineRow?.frozen_at) return res.status(400).json({ error: 'BOM is frozen — raise an ECN to create a new version' });
    await pool.query('DELETE FROM bom_lines WHERE id=$1', [req.params.lineId]);
    const actor = actorFromReq(req);
    logAudit({ userId: actor.id, module: 'bom', recordId: req.params.lineId, recordType: 'bom_line', action: 'delete', oldData: lineRow, req });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /bom/lines/:lineId ── */
router.put('/bom/lines/:lineId', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [line] } = await pool.query(
      'SELECT h.frozen_at FROM bom_lines l JOIN bom_headers h ON h.id = l.bom_id WHERE l.id=$1 AND h.company_id=$2',
      [req.params.lineId, cid]
    );
    if (!line) return res.status(404).json({ error: 'BOM line not found' });
    if (line?.frozen_at) return res.status(400).json({ error: 'BOM is frozen — raise an ECN to create a new version' });
    const safeQty = Number.parseFloat(req.body.qty);
    if (Number.isNaN(safeQty)) return res.status(400).json({ error: 'A valid quantity is required' });
    const { rows } = await pool.query(
      'UPDATE bom_lines SET qty=$1 WHERE id=$2 RETURNING *', [safeQty, req.params.lineId]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /bom/:id/version — ECN-gated version bump ── */
router.post('/bom/:id/version', requirePermission('bom', 'add'), async (req, res) => {
  const client = await pool.connect();
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { reason, severity = 'medium', change_summary } = req.body;
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'A change reason is required to create a new BOM version' });
    }

    await client.query('BEGIN');
    const { rows: [orig] } = await client.query('SELECT * FROM bom_headers WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    if (!orig) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'BOM not found' }); }

    const ecnNumber = await nextEcnNumber(client);
    const actor = actorFromReq(req);

    // Create the ECN
    const { rows: [ecn] } = await client.query(
      `INSERT INTO engineering_changes
        (ecn_number, title, change_type, status, severity, reason, impact_summary,
         requested_by, requested_by_name)
       VALUES ($1,$2,'ECN','draft',$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        ecnNumber,
        `BOM version bump — ${orig.product_name} v${orig.version} → v${orig.version + 1}`,
        severity,
        reason.trim(),
        change_summary?.trim() || null,
        actor.id,
        actor.name,
      ]
    );

    // Record the BOM header as an impacted item on the ECN
    await client.query(
      `INSERT INTO engineering_change_items
        (engineering_change_id, item_type, item_ref_id, item_name, current_revision, proposed_revision, change_summary)
       VALUES ($1,'bom_header',$2,$3,$4,$5,$6)`,
      [ecn.id, orig.id, orig.product_name, `v${orig.version}`, `v${orig.version + 1}`, reason.trim()]
    );

    // Log event on ECN
    await client.query(
      `INSERT INTO engineering_change_events
        (engineering_change_id, event_name, event_note, actor_id, actor_name, event_data)
       VALUES ($1,'created','BOM version created via ECN',$2,$3,$4)`,
      [ecn.id, actor.id, actor.name, JSON.stringify({ bom_id: orig.id, from_version: orig.version })]
    );

    // Clone the BOM header (inherit company_id)
    const { rows: [newBOM] } = await client.query(
      `INSERT INTO bom_headers (company_id, product_id, product_name, version, status, notes, ecn_id, change_reason)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7) RETURNING *`,
      [cid, orig.product_id, orig.product_name, orig.version + 1, orig.notes, ecn.id, reason.trim()]
    );

    // Clone lines preserving hierarchy
    const { rows: lines } = await client.query(
      'SELECT * FROM bom_lines WHERE bom_id=$1 ORDER BY id', [orig.id]
    );
    const idMap = {};
    for (const line of lines) {
      const { rows: [newLine] } = await client.query(
        `INSERT INTO bom_lines (bom_id, component_id, component_name, qty, unit, unit_cost, level, parent_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL) RETURNING id`,
        [newBOM.id, line.component_id, line.component_name, line.qty, line.unit, line.unit_cost, line.level]
      );
      idMap[line.id] = newLine.id;
    }
    for (const line of lines) {
      if (line.parent_line_id && idMap[line.parent_line_id]) {
        await client.query('UPDATE bom_lines SET parent_line_id=$1 WHERE id=$2',
          [idMap[line.parent_line_id], idMap[line.id]]);
      }
    }

    // Clone routing steps
    const { rows: routing } = await client.query(
      'SELECT * FROM routing_steps WHERE bom_id=$1', [orig.id]
    );
    for (const r of routing) {
      await client.query(
        `INSERT INTO routing_steps (bom_id, step_no, operation, work_centre_id, std_time_hrs, description)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newBOM.id, r.step_no, r.operation, r.work_centre_id, r.std_time_hrs, r.description]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ...newBOM, ecn_number: ecn.ecn_number, ecn_id: ecn.id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* ── POST /bom/:id/freeze — design freeze gate ── */
router.post('/bom/:id/freeze', requirePermission('bom', 'approve'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const actor = actorFromReq(req);
    const { rows } = await pool.query(
      `UPDATE bom_headers
       SET frozen_at = NOW(), frozen_by_name = $1, updated_at = NOW()
       WHERE id = $2 AND company_id = $3 AND frozen_at IS NULL
       RETURNING *`,
      [actor.name, req.params.id, cid]
    );
    if (!rows.length) return res.status(400).json({ error: 'BOM is already frozen or not found' });
    logAudit({ userId: actor.id, module: 'bom', recordId: req.params.id, recordType: 'bom_header', action: 'update', oldData: { frozen_at: null }, newData: { frozen_at: rows[0].frozen_at, frozen_by_name: actor.name, status: 'frozen' }, req });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /mrp/run ── */
router.post('/mrp/run', requirePermission('bom', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { quantity = 1, product_id, bom_id } = req.body;
    let bomRow;
    if (bom_id) {
      const { rows } = await pool.query('SELECT * FROM bom_headers WHERE id=$1 AND company_id=$2', [bom_id, cid]);
      bomRow = rows[0];
    } else if (product_id) {
      const { rows } = await pool.query(
        `SELECT * FROM bom_headers WHERE product_id=$1 AND status='active' AND company_id=$2 ORDER BY version DESC LIMIT 1`,
        [product_id, cid]
      );
      bomRow = rows[0];
    }
    if (!bomRow) return res.status(404).json({ error: 'No active BOM found' });

    const explosionResult = await explodeBOM(bomRow.id, quantity, cid);
    const requirements = [];
    let totalCost = 0;
    const createdPRs = [];

    for (const [, comp] of Object.entries(explosionResult)) {
      let available = 0;
      try {
        const { rows: stock } = await pool.query(
          `SELECT COALESCE(SUM(quantity),0) as qty FROM inventory_items
           WHERE item_name ILIKE $1 OR id=$2`,
          [`%${comp.component}%`, comp.component_id || 0]
        );
        available = parseFloat(stock[0]?.qty || 0);
      } catch (stockErr) {
        console.warn('[mrp] stock lookup failed for', comp.component, '—', stockErr.message);
        available = 0;
      }

      const shortage = Math.max(0, comp.required - available);
      const suggestedPOQty = Math.ceil(shortage * 1.1);
      const lineCost = comp.required * comp.unit_cost;
      totalCost += lineCost;

      requirements.push({
        component: comp.component,
        component_id: comp.component_id,
        unit: comp.unit,
        required: comp.required,
        available,
        shortage,
        suggested_po_qty: suggestedPOQty,
        unit_cost: comp.unit_cost,
        line_cost: lineCost,
      });

      if (shortage > 0) {
        try {
          const { rows: [pr] } = await pool.query(
            `INSERT INTO purchase_requests
               (company_id, item_name, item_id, qty_requested, unit, estimated_cost, status, raised_by, notes)
             VALUES ($1,$2,$3,$4,$5,$6,'draft','MRP System',$7) RETURNING id`,
            [cid, comp.component, comp.component_id, suggestedPOQty, comp.unit,
             suggestedPOQty * comp.unit_cost,
             `MRP run: production qty ${quantity}`]
          );
          createdPRs.push({ pr_id: pr.id, component: comp.component, qty: suggestedPOQty });
        } catch (prErr) {
          console.warn('[mrp] auto-PR creation failed for', comp.component, '—', prErr.message);
        }
      }
    }

    res.json({
      bom: bomRow,
      quantity,
      requirements: requirements.sort((a, b) => b.shortage - a.shortage),
      total_cost_estimate: totalCost,
      shortage_count: requirements.filter(r => r.shortage > 0).length,
      created_prs: createdPRs,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /work-centres ── */
router.get('/work-centres', requirePermission('bom', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(`
      SELECT w.*,
        COALESCE((
          SELECT SUM(r.std_time_hrs)
          FROM routing_steps r
          JOIN bom_headers h ON h.id = r.bom_id
          WHERE r.work_centre_id = w.id AND h.status = 'active'
        ),0) as total_load_hrs
      FROM work_centres w
      WHERE (w.company_id = $1 OR w.company_id IS NULL) AND w.status='active'
      ORDER BY w.name
    `, [cid]);
    const enriched = rows.map(w => {
      const weekCapacity = parseFloat(w.capacity_hours_per_day) * 5;
      const loadPct = weekCapacity > 0
        ? Math.min(100, Math.round((parseFloat(w.total_load_hrs) / weekCapacity) * 100))
        : 0;
      return { ...w, utilization_pct: loadPct, week_capacity_hrs: weekCapacity };
    });
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /work-centres ── */
router.post('/work-centres', requirePermission('bom', 'add'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { name, capacity_hours_per_day, cost_per_hour, department } = req.body;
    if (!name) return res.status(400).json({ error: 'Work centre name is required' });
    const { rows } = await pool.query(
      `INSERT INTO work_centres (company_id, name, capacity_hours_per_day, cost_per_hour, department)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [cid, name, capacity_hours_per_day || 8, cost_per_hour || 0, department || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── PUT /work-centres/:id ── */
router.put('/work-centres/:id', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { name, capacity_hours_per_day, cost_per_hour, department } = req.body;
    const { rows } = await pool.query(
      `UPDATE work_centres
       SET name=$1, capacity_hours_per_day=$2, cost_per_hour=$3, department=$4, updated_at=NOW()
       WHERE id=$5 AND (company_id=$6 OR company_id IS NULL)
       RETURNING *`,
      [name, capacity_hours_per_day || 8, cost_per_hour || 0, department || null, req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Work centre not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── DELETE /work-centres/:id ── */
router.delete('/work-centres/:id', requirePermission('bom', 'delete'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows } = await pool.query(
      `UPDATE work_centres SET status='inactive', updated_at=NOW()
       WHERE id=$1 AND (company_id=$2 OR company_id IS NULL)
       RETURNING id`,
      [req.params.id, cid]
    );
    if (!rows.length) return res.status(404).json({ error: 'Work centre not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /capacity/check ── */
router.post('/capacity/check', requirePermission('bom', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { orders = [], start_date, end_date } = req.body;
    const days = Math.max(1, Math.round(
      (new Date(end_date) - new Date(start_date)) / (1000 * 60 * 60 * 24)
    ));
    const { rows: wcs } = await pool.query(
      `SELECT * FROM work_centres WHERE status=$1 AND (company_id=$2 OR company_id IS NULL)`,
      ['active', cid]
    );
    const results = [];
    for (const wc of wcs) {
      const availableHrs = parseFloat(wc.capacity_hours_per_day) * days;
      let requiredHrs = 0;
      for (const order of orders) {
        if (order.bom_id) {
          const { rows: steps } = await pool.query(
            `SELECT COALESCE(SUM(std_time_hrs),0) * $1 as hrs
             FROM routing_steps WHERE bom_id=$2 AND work_centre_id=$3`,
            [order.quantity || 1, order.bom_id, wc.id]
          );
          requiredHrs += parseFloat(steps[0]?.hrs || 0);
        }
      }
      const loadPct = availableHrs > 0 ? (requiredHrs / availableHrs) * 100 : 0;
      results.push({
        work_centre: wc.name,
        work_centre_id: wc.id,
        available_hrs: availableHrs,
        required_hrs: parseFloat(requiredHrs.toFixed(2)),
        load_pct: Math.round(loadPct),
        overloaded: loadPct > 100,
        status: loadPct > 100 ? 'overloaded' : loadPct > 80 ? 'near_capacity' : 'available',
      });
    }
    res.json({
      date_range: { start_date, end_date, days },
      work_centres: results,
      overloaded_centres: results.filter(r => r.overloaded).map(r => r.work_centre),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Routing steps ── */
router.post('/bom/:id/routing', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [bom] } = await pool.query('SELECT frozen_at FROM bom_headers WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    if (bom?.frozen_at) return res.status(400).json({ error: 'BOM is frozen — raise an ECN to create a new version' });
    const { step_no, operation, work_centre_id, std_time_hrs, setup_time_hrs, is_inspection, description } = req.body;
    if (!operation || !String(operation).trim()) {
      return res.status(400).json({ error: 'Operation is required' });
    }
    // Coerce numeric inputs — the "— None —" work-centre option and blank time
    // fields arrive as empty strings, which INTEGER/NUMERIC columns reject.
    const safeStepNo = Number.parseInt(step_no, 10);
    const safeWcId   = Number.parseInt(work_centre_id, 10);
    const safeStd    = Number.parseFloat(std_time_hrs);
    const safeSetup  = Number.parseFloat(setup_time_hrs);
    const { rows } = await pool.query(
      `INSERT INTO routing_steps (bom_id, step_no, operation, work_centre_id, std_time_hrs, setup_time_hrs, is_inspection, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        req.params.id,
        Number.isNaN(safeStepNo) ? 1 : safeStepNo,
        String(operation).trim(),
        Number.isNaN(safeWcId) ? null : safeWcId,
        Number.isNaN(safeStd) ? 0 : safeStd,
        Number.isNaN(safeSetup) ? 0 : safeSetup,
        is_inspection || false,
        description || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Update routing step ── */
router.put('/bom/routing/:stepId', requirePermission('bom', 'edit'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [step] } = await pool.query(
      'SELECT h.frozen_at FROM routing_steps s JOIN bom_headers h ON h.id = s.bom_id WHERE s.id=$1 AND h.company_id=$2',
      [req.params.stepId, cid]
    );
    if (!step) return res.status(404).json({ error: 'Routing step not found' });
    if (step?.frozen_at) return res.status(400).json({ error: 'BOM is frozen — raise an ECN to create a new version' });
    const { step_no, operation, work_centre_id, std_time_hrs, setup_time_hrs, is_inspection, description } = req.body;
    const safeStepNo = Number.parseInt(step_no, 10);
    const safeWcId   = Number.parseInt(work_centre_id, 10);
    const safeStd    = Number.parseFloat(std_time_hrs);
    const safeSetup  = Number.parseFloat(setup_time_hrs);
    const { rows } = await pool.query(
      `UPDATE routing_steps
       SET step_no=$1, operation=$2, work_centre_id=$3, std_time_hrs=$4,
           setup_time_hrs=$5, is_inspection=$6, description=$7
       WHERE id=$8 RETURNING *`,
      [
        Number.isNaN(safeStepNo) ? 1 : safeStepNo,
        operation,
        Number.isNaN(safeWcId) ? null : safeWcId,
        Number.isNaN(safeStd) ? 0 : safeStd,
        Number.isNaN(safeSetup) ? 0 : safeSetup,
        is_inspection || false,
        description || null,
        req.params.stepId,
      ]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/bom/routing/:stepId', requirePermission('bom', 'delete'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [step] } = await pool.query(
      'SELECT h.frozen_at FROM routing_steps s JOIN bom_headers h ON h.id = s.bom_id WHERE s.id=$1 AND h.company_id=$2',
      [req.params.stepId, cid]
    );
    if (!step) return res.status(404).json({ error: 'Routing step not found' });
    if (step?.frozen_at) return res.status(400).json({ error: 'BOM is frozen — raise an ECN to create a new version' });
    await pool.query('DELETE FROM routing_steps WHERE id=$1', [req.params.stepId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /bom/import-csv — bulk BOM import from CSV ── */
router.post('/bom/import-csv', requirePermission('bom', 'add'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const csvText = req.body?.csv || '';
    if (!csvText.trim()) return res.status(400).json({ error: 'No CSV content provided' });

    const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, '_'));
    const rows = lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return obj;
    });

    // Group rows by finished_product
    const bomMap = {};
    rows.forEach(r => {
      const product = r.finished_product || r.product || '';
      if (!product) return;
      if (!bomMap[product]) bomMap[product] = { quantity: r.quantity || '1', unit: r.unit || 'Nos', components: [] };
      if (r.component_name || r.component) {
        bomMap[product].components.push({
          component_name: r.component_name || r.component || '',
          qty: parseFloat(r.component_qty || r.qty || 1),
          unit: r.component_unit || r.unit || 'pcs',
          unit_cost: parseFloat(r.unit_cost || 0),
          wastage_pct: parseFloat(r.wastage_pct || 0),
        });
      }
    });

    const created = [];
    const errors = [];
    const client = await pool.connect();
    try {
      for (const [product, data] of Object.entries(bomMap)) {
        try {
          await client.query('BEGIN');
          const { rows: [newBom] } = await client.query(
            `INSERT INTO bom_headers (company_id, product_name, version, status, notes)
             VALUES ($1,$2,1,'draft','Imported from CSV') RETURNING *`,
            [cid, product]
          );
          for (const comp of data.components) {
            await client.query(
              `INSERT INTO bom_lines (bom_id, component_name, qty, unit, unit_cost, level)
               VALUES ($1,$2,$3,$4,$5,1)`,
              [newBom.id, comp.component_name, comp.qty, comp.unit, comp.unit_cost]
            );
          }
          await client.query('COMMIT');
          created.push({ product, bom_id: newBom.id, components: data.components.length });
        } catch (err) {
          await client.query('ROLLBACK');
          errors.push({ product, error: err.message });
        }
      }
    } finally {
      client.release();
    }

    res.json({ created: created.length, errors, details: created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Document & Signature Traceability (Phase 30F) ─────────────────────── */
router.get('/bom/:id/documents', requirePermission('bom', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [bom] } = await pool.query('SELECT id FROM bom_headers WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    const { rows } = await pool.query(
      `SELECT * FROM document_master
       WHERE linked_entity_type = 'bom' AND linked_entity_id = $1
         AND deleted_at IS NULL
       ORDER BY revision DESC`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bom/:id/signatures', requirePermission('bom', 'view'), async (req, res) => {
  try {
    if (req.scope === null) return res.status(403).json({ error: 'Company scope required' });
    const cid = req.scope?.company_id;
    const { rows: [bom] } = await pool.query('SELECT id FROM bom_headers WHERE id=$1 AND company_id=$2', [req.params.id, cid]);
    if (!bom) return res.status(404).json({ error: 'BOM not found' });
    const { rows } = await pool.query(
      `SELECT s.*,
         (SELECT json_agg(al ORDER BY al.occurred_at)
          FROM signature_audit_log al WHERE al.signing_id = s.id) AS audit_trail
       FROM document_signings s
       WHERE s.linked_entity_type = 'bom' AND s.linked_entity_id = $1
       ORDER BY s.created_at`,
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
