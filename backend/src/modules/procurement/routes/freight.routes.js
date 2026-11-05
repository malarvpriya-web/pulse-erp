/**
 * freight.routes.js — lanes and rate cards for tonne-km freight (§216).
 * Mounted at /procurement/freight (behind verifyToken + auditMutations('procurement')).
 *
 *   GET  /lanes                       procurement:view
 *   PUT  /lanes                       procurement:edit   upsert (vendor, warehouse); a person confirms km + source
 *   DELETE /lanes/:id                 procurement:edit
 *   GET  /lanes/suggest-distance      procurement:view   straight-line ESTIMATE, never saved
 *   GET  /rate-cards?status=          procurement:view
 *   POST /rate-cards                  procurement:edit   creates a DRAFT
 *   POST /rate-cards/:id/approve      procurement:approve  maker ≠ checker
 *   POST /rate-cards/:id/reject       procurement:approve  note required
 *   POST /rate-cards/:id/retire       procurement:approve  approved → retired
 *
 * There is no PUT on a rate card: a changed rate is a new card (new version,
 * own effective date). The DB trigger refuses term changes once a card leaves
 * draft, so this is enforced below the API too. Same review pattern as the
 * Finance FX approval (forex.routes.js, §215).
 */
import express from 'express';
import pool from '../../shared/db.js';
import { companyOf } from '../../../shared/scope.js';
import { requireProcurement } from '../procurement.authz.js';
import { logAudit } from '../../../services/AuditService.js';
import { normCurrency } from '../../finance/services/fxRate.service.js';
import { haversineKm } from '../../logistics/services/routeOptimiser.service.js';
import { vocabularyValues } from '../../../shared/masterVocabulary.js';
import { TRANSPORT_MODES, SERVICE_LEVELS, DISTANCE_SOURCES } from '../services/freight.service.js';

const router = express.Router();
const userIdOf = (req) => req.user?.userId ?? req.user?.id ?? null;
const int = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const FREIGHT_CATEGORY_SEEDS = ['General', 'Fragile', 'Hazardous', 'Oversize'];

function bad(res, msg, status = 422) { res.status(status).json({ error: msg }); return null; }

// ── Lanes ────────────────────────────────────────────────────────────────────
router.get('/lanes', requireProcurement('view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.*, v.vendor_name, COALESCE(w.warehouse_name, w.name) AS warehouse_name, u.name AS confirmed_by_name
         FROM freight_lanes l
         JOIN vendors v    ON v.id = l.vendor_id
         JOIN warehouses w ON w.id = l.warehouse_id
         LEFT JOIN users u ON u.id = l.confirmed_by_user_id
        WHERE l.company_id = $1
        ORDER BY v.vendor_name, w.id`, [companyOf(req)]);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Both ends must belong to the caller's company. */
async function ownEnds(companyId, vendorId, warehouseId) {
  const [{ rows: v }, { rows: w }] = await Promise.all([
    pool.query(`SELECT id, vendor_name, city, state, country FROM vendors WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, [vendorId, companyId]),
    pool.query(`SELECT id, COALESCE(warehouse_name, name) AS name, latitude, longitude FROM warehouses WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`, [warehouseId, companyId]),
  ]);
  return { vendor: v[0] ?? null, warehouse: w[0] ?? null };
}

router.put('/lanes', requireProcurement('edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const userId = userIdOf(req);
    if (companyId == null) return bad(res, 'No company scope on the request', 400);
    if (userId == null) return bad(res, 'No user identity on the request', 401);
    const b = req.body || {};
    const vendorId = int(b.vendor_id); const warehouseId = int(b.warehouse_id);
    const km = Number(b.distance_km);
    if (vendorId == null || warehouseId == null) return bad(res, 'vendor_id and warehouse_id are required');
    if (!Number.isFinite(km) || km <= 0) return bad(res, 'distance_km must be a positive number');
    // The person saving the lane states where the number came from. There is
    // no default: an unconfirmed straight-line figure must not become a route.
    if (!DISTANCE_SOURCES.includes(b.distance_source)) {
      return bad(res, `distance_source is required and must be one of ${DISTANCE_SOURCES.join(', ')}`);
    }
    const mode = b.default_transport_mode || null;
    if (mode && !TRANSPORT_MODES.includes(mode)) return bad(res, `default_transport_mode must be one of ${TRANSPORT_MODES.join(', ')}`);
    const sl = b.default_service_level ? String(b.default_service_level).toUpperCase() : null;
    if (sl && !SERVICE_LEVELS.includes(sl)) return bad(res, `default_service_level must be one of ${SERVICE_LEVELS.join(', ')}`);
    const { vendor, warehouse } = await ownEnds(companyId, vendorId, warehouseId);
    if (!vendor) return bad(res, 'Vendor not found', 404);
    if (!warehouse) return bad(res, 'Warehouse not found', 404);

    const { rows: [before] } = await pool.query(
      `SELECT * FROM freight_lanes WHERE company_id = $1 AND vendor_id = $2 AND warehouse_id = $3`, [companyId, vendorId, warehouseId]);
    const { rows: [lane] } = await pool.query(
      `INSERT INTO freight_lanes (company_id, vendor_id, warehouse_id, distance_km, distance_source, distance_note,
                                  default_transport_mode, default_service_level, confirmed_by_user_id, confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (company_id, vendor_id, warehouse_id) DO UPDATE SET
         distance_km = EXCLUDED.distance_km, distance_source = EXCLUDED.distance_source,
         distance_note = EXCLUDED.distance_note, default_transport_mode = EXCLUDED.default_transport_mode,
         default_service_level = EXCLUDED.default_service_level,
         confirmed_by_user_id = EXCLUDED.confirmed_by_user_id, confirmed_at = NOW(), updated_at = NOW()
       RETURNING *`,
      [companyId, vendorId, warehouseId, km, b.distance_source, b.distance_note || null, mode, sl, userId]);
    logAudit({ userId, module: 'procurement', recordId: lane.id, recordType: 'freight_lane',
      action: before ? 'update' : 'create', oldData: before ?? null, newData: lane, req });
    res.status(before ? 200 : 201).json({ data: lane });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/lanes/:id', requireProcurement('edit'), async (req, res) => {
  try {
    const { rows: [lane] } = await pool.query(
      `DELETE FROM freight_lanes WHERE id = $1 AND company_id = $2 RETURNING *`, [int(req.params.id), companyOf(req)]);
    if (!lane) return bad(res, 'Lane not found', 404);
    logAudit({ userId: userIdOf(req), module: 'procurement', recordId: lane.id, recordType: 'freight_lane', action: 'delete', oldData: lane, req });
    res.json({ data: lane });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * A straight-line (great-circle) distance between the vendor's city and the
 * warehouse — a SUGGESTION to prefill the form, labelled as an estimate. Road
 * distance is longer. Nothing is written; a person still enters the km and
 * picks the source when they save the lane.
 */
router.get('/lanes/suggest-distance', requireProcurement('view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { vendor, warehouse } = await ownEnds(companyId, int(req.query.vendor_id), int(req.query.warehouse_id));
    if (!vendor) return bad(res, 'Vendor not found', 404);
    if (!warehouse) return bad(res, 'Warehouse not found', 404);
    const { rows: [geo] } = vendor.city ? await pool.query(
      `SELECT latitude, longitude, city, state FROM geo_locations
        WHERE LOWER(city) = LOWER($1) AND (company_id IS NULL OR company_id = $2)
        ORDER BY (LOWER(COALESCE(state,'')) = LOWER(COALESCE($3,''))) DESC, company_id NULLS LAST LIMIT 1`,
      [vendor.city, companyId, vendor.state || '']) : { rows: [] };
    const from = geo ? { lat: Number(geo.latitude), lng: Number(geo.longitude) } : null;
    const to = warehouse.latitude != null ? { lat: Number(warehouse.latitude), lng: Number(warehouse.longitude) } : null;
    const km = haversineKm(from, to);
    res.json({
      suggestion: km == null ? null : {
        distance_km: km, method: 'great_circle', source_if_accepted: 'estimated',
        note: `Straight-line distance ${vendor.city} → ${warehouse.name}. Road distance is usually longer; confirm before saving.`,
      },
      reason: km != null ? null
        : !vendor.city ? 'The vendor has no city on record.'
        : !geo ? `No reference coordinates for ${vendor.city}.`
        : 'The warehouse has no coordinates.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Rate cards ───────────────────────────────────────────────────────────────
router.get('/rate-cards', requireProcurement('view'), async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !['draft', 'approved', 'rejected', 'retired'].includes(status)) return bad(res, 'Unknown status', 400);
    const { rows } = await pool.query(
      `SELECT c.*, c.effective_from::text AS effective_from,
              eu.name AS entered_by_name, au.name AS approved_by_name, ru.name AS retired_by_name
         FROM freight_rate_cards c
         LEFT JOIN users eu ON eu.id = c.entered_by_user_id
         LEFT JOIN users au ON au.id = c.approved_by_user_id
         LEFT JOIN users ru ON ru.id = c.retired_by_user_id
        WHERE c.company_id = $1 AND ($2::text IS NULL OR c.status = $2)
        ORDER BY c.transport_mode, c.service_level NULLS LAST, c.freight_category NULLS LAST, c.effective_from DESC, c.id DESC
        LIMIT 500`, [companyOf(req), status]);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/rate-cards', requireProcurement('edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const userId = userIdOf(req);
    if (companyId == null) return bad(res, 'No company scope on the request', 400);
    if (userId == null) return bad(res, 'No user identity on the request', 401);
    const b = req.body || {};
    if (!TRANSPORT_MODES.includes(b.transport_mode)) return bad(res, `transport_mode must be one of ${TRANSPORT_MODES.join(', ')}`);
    const sl = b.service_level ? String(b.service_level).toUpperCase() : null;
    if (sl && !SERVICE_LEVELS.includes(sl)) return bad(res, `service_level must be one of ${SERVICE_LEVELS.join(', ')}`);
    const rate = Number(b.rate_per_tonne_km);
    if (!Number.isFinite(rate) || rate <= 0) return bad(res, 'rate_per_tonne_km must be a positive number');
    const currency = normCurrency(b.currency);
    if (!currency) return bad(res, 'currency must be a 3-letter ISO code');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.effective_from || ''))) return bad(res, 'effective_from (YYYY-MM-DD) is required');
    let category = b.freight_category ? String(b.freight_category).trim() : null;
    if (category) {
      const allowed = await vocabularyValues('FREIGHT_CATEGORY', companyId, FREIGHT_CATEGORY_SEEDS);
      const hit = allowed.find((v) => v.toLowerCase() === category.toLowerCase());
      if (!hit) return bad(res, `freight_category '${category}' is not in the Freight Category master`);
      category = hit;
    }
    const { rows: [card] } = await pool.query(
      `INSERT INTO freight_rate_cards (company_id, transport_mode, service_level, freight_category, rate_per_tonne_km,
                                       currency, effective_from, source, notes, status, entered_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)
       RETURNING *, effective_from::text AS effective_from`,
      [companyId, b.transport_mode, sl, category, rate, currency, b.effective_from, b.source || null, b.notes || null, userId]);
    logAudit({ userId, module: 'procurement', recordId: card.id, recordType: 'freight_rate_card', action: 'create', newData: card, req });
    res.status(201).json({ data: card, message: 'Saved as a draft. Comparisons use it only after a different approver approves it.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function reviewCard(req, res, action) {
  const companyId = companyOf(req);
  const userId = userIdOf(req);
  const id = int(req.params.id);
  if (id == null) return bad(res, 'id must be an integer', 400);
  if (userId == null) return bad(res, 'No user identity on the request', 401);
  const note = req.body?.note ? String(req.body.note).trim() : null;
  if (action === 'reject' && !(note && note.length >= 5)) return bad(res, 'A note of at least 5 characters is required to reject a rate card.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [card] } = await client.query(
      `SELECT * FROM freight_rate_cards WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId]);
    if (!card) { await client.query('ROLLBACK'); return bad(res, 'Rate card not found', 404); }
    const from = { approve: 'draft', reject: 'draft', retire: 'approved' }[action];
    if (card.status !== from) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This rate card is ${card.status}; ${action} needs a ${from} card.`, code: 'WRONG_STATUS' });
    }
    if (action !== 'retire' && Number(card.entered_by_user_id) === Number(userId)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You created this rate card, so a different approver must review it.', code: 'SELF_APPROVAL' });
    }
    const sql = {
      approve: `UPDATE freight_rate_cards SET status='approved', approved_by_user_id=$2, approved_at=NOW(), review_note=$3 WHERE id=$1 RETURNING *`,
      // As in the FX review (§215), approved_by/approved_at record the REVIEWER
      // for a rejection too; status says which way the review went.
      reject:  `UPDATE freight_rate_cards SET status='rejected', approved_by_user_id=$2, approved_at=NOW(), review_note=$3 WHERE id=$1 RETURNING *`,
      retire:  `UPDATE freight_rate_cards SET status='retired', retired_by_user_id=$2, retired_at=NOW(), review_note=COALESCE($3, review_note) WHERE id=$1 RETURNING *`,
    }[action];
    const { rows: [out] } = await client.query(sql, [id, userId, note]);
    await client.query('COMMIT');
    logAudit({ userId, module: 'procurement', recordId: id, recordType: 'freight_rate_card', action,
      oldData: card, newData: out, req });
    res.json({ data: out });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
}

router.post('/rate-cards/:id/approve', requireProcurement('approve'), (req, res) => reviewCard(req, res, 'approve'));
router.post('/rate-cards/:id/reject',  requireProcurement('approve'), (req, res) => reviewCard(req, res, 'reject'));
router.post('/rate-cards/:id/retire',  requireProcurement('approve'), (req, res) => reviewCard(req, res, 'retire'));

export default router;
