// backend/src/modules/logistics/logistics.routes.js
import { Router } from 'express';
import pool from '../../config/db.js';
import { uploadFile } from '../../services/StorageService.js';

const router = Router();

const cid = (req) => req.scope?.company_id ?? null;

/* ── GET /shipments ── */
router.get('/shipments', async (req, res) => {
  try {
    const companyId = cid(req);
    const { status, direction, courier } = req.query;
    const params = [companyId];
    let q = 'SELECT * FROM shipments WHERE ($1::int IS NULL OR company_id=$1)';
    if (status)    { params.push(status);          q += ` AND status=$${params.length}`; }
    if (direction) { params.push(direction);       q += ` AND direction=$${params.length}`; }
    if (courier)   { params.push(`%${courier}%`);  q += ` AND courier_partner ILIKE $${params.length}`; }
    q += ' ORDER BY created_at DESC LIMIT 100';
    const { rows } = await pool.query(q, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── POST /shipments ── */
router.post('/shipments', async (req, res) => {
  try {
    const companyId = cid(req);
    const {
      reference_type, reference_id, courier_partner, tracking_number,
      dispatch_date, expected_delivery, weight_kg, dimensions,
      freight_cost, from_address, to_address, notes,
      direction = 'outbound',
    } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO shipments
         (company_id, reference_type, reference_id, courier_partner, tracking_number,
          dispatch_date, expected_delivery, weight_kg, dimensions,
          freight_cost, from_address, to_address, notes, direction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [companyId, reference_type, reference_id, courier_partner, tracking_number,
       dispatch_date || null, expected_delivery || null, weight_kg || null, dimensions || null,
       freight_cost || null, from_address || null, to_address || null, notes || null, direction]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── PATCH /shipments/:id/deliver ── */
router.patch('/shipments/:id/deliver', async (req, res) => {
  try {
    const companyId = cid(req);
    const { actual_delivery } = req.body;
    const { rows } = await pool.query(
      `UPDATE shipments SET status='delivered', actual_delivery=$1, updated_at=NOW()
       WHERE id=$2 AND ($3::int IS NULL OR company_id=$3) RETURNING *`,
      [actual_delivery || new Date().toISOString().split('T')[0], req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Shipment not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── GET /shipments/:id/track ── */
router.get('/shipments/:id/track', async (req, res) => {
  try {
    const { rows: [shipment] } = await pool.query('SELECT * FROM shipments WHERE id=$1', [req.params.id]);
    if (!shipment) return res.status(404).json({ error: 'Shipment not found' });

    if (!process.env.SHIPROCKET_TOKEN) {
      return res.status(503).json({ error: 'Live tracking unavailable: SHIPROCKET_TOKEN is not configured.' });
    }
    if (!shipment.tracking_number) {
      return res.status(422).json({ error: 'Shipment has no tracking number assigned.' });
    }

    const resp = await fetch(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${shipment.tracking_number}`,
      { headers: { Authorization: `Bearer ${process.env.SHIPROCKET_TOKEN}` }, signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return res.status(502).json({ error: `Shiprocket returned ${resp.status}`, detail: body });
    }
    const data = await resp.json();
    res.json({ shipment, tracking: data, source: 'shiprocket' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── POST /shipments/:id/pod ── */
router.post('/shipments/:id/pod', async (req, res) => {
  try {
    const { pod_image_base64, delivery_date } = req.body;
    if (!pod_image_base64) return res.status(400).json({ error: 'pod_image_base64 is required' });

    const base64Data = pod_image_base64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const filename = `pod_${req.params.id}.jpg`;
    const podUrl = await uploadFile(buffer, filename, 'image/jpeg');

    const { rows } = await pool.query(
      `UPDATE shipments SET pod_image_url=$1, actual_delivery=$2, status='delivered', updated_at=NOW()
       WHERE id=$3 RETURNING *`,
      [podUrl, delivery_date || new Date().toISOString().split('T')[0], req.params.id]
    );
    res.json({ success: true, data: { ...rows[0], message: 'POD recorded' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── GET /eway-bills ── */
router.get('/eway-bills', async (req, res) => {
  try {
    const companyId = cid(req);
    const { status } = req.query;
    const params = [companyId];
    let q = `SELECT e.*, s.courier_partner, s.tracking_number, s.to_address
      FROM eway_bills e
      LEFT JOIN shipments s ON s.id = e.shipment_id
      WHERE ($1::int IS NULL OR e.company_id=$1)`;
    if (status) { params.push(status); q += ` AND e.status=$${params.length}`; }
    q += ' ORDER BY e.generated_at DESC LIMIT 50';
    const { rows } = await pool.query(q, params);
    const now = new Date();
    res.json({ success: true, data: rows.map(r => ({ ...r, expired: new Date(r.valid_until) < now })) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── POST /eway-bills — manual entry (NIC API optional) ── */
router.post('/eway-bills', async (req, res) => {
  try {
    const companyId = cid(req);
    const {
      shipment_id, eway_bill_number, from_gstin, to_gstin,
      vehicle_number, distance_km, goods_description, taxable_value,
      transport_mode = 'road', supply_type = 'outward',
      valid_from, valid_until,
    } = req.body;

    if (!eway_bill_number) {
      return res.status(400).json({ success: false, error: 'eway_bill_number is required (manual entry)' });
    }

    // Calculate validity from distance if valid_until not provided
    let computedValidUntil = valid_until;
    if (!computedValidUntil && distance_km != null) {
      const km = parseInt(distance_km) || 0;
      let days = 1;
      if (km > 300) days = 5;
      else if (km > 100) days = 3;
      const d = new Date(valid_from || new Date());
      d.setDate(d.getDate() + days);
      computedValidUntil = d.toISOString();
    }

    const { rows } = await pool.query(
      `INSERT INTO eway_bills
         (company_id, shipment_id, eway_bill_number, valid_until, from_gstin, to_gstin,
          vehicle_number, distance_km, goods_description, taxable_value, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') RETURNING *`,
      [companyId, shipment_id || null, eway_bill_number, computedValidUntil || null,
       from_gstin || null, to_gstin || null, vehicle_number || null,
       distance_km || null, goods_description || null, taxable_value || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── PATCH /eway-bills/:id/cancel ── */
router.patch('/eway-bills/:id/cancel', async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `UPDATE eway_bills SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND ($2::int IS NULL OR company_id=$2) RETURNING *`,
      [req.params.id, companyId]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'E-Way Bill not found' });
    res.json({ success: true, data: rows[0] });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── POST /eway-bills/generate — attempt NIC GST portal (legacy) ── */
router.post('/eway-bills/generate', async (req, res) => {
  try {
    const { shipment_id, from_gstin, to_gstin, vehicle_number,
            distance_km, goods_description, taxable_value } = req.body;

    if (!process.env.GSTIN || !process.env.GST_API_KEY) {
      return res.status(503).json({
        error: 'Live e-way bill generation unavailable: GSTIN and GST_API_KEY env vars are not configured. Use POST /eway-bills for manual entry.',
      });
    }

    let ewayBillNumber;
    try {
      const resp = await fetch('https://einvoice1.gst.gov.in/IRP/OTP/EWBGenerateEWaybill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'gstin': process.env.GSTIN, 'user_name': process.env.GST_USER },
        body: JSON.stringify({ FromGstin: from_gstin, ToGstin: to_gstin, VehicleNo: vehicle_number }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        ewayBillNumber = data.ewayBillNo;
      }
    } catch { /* fall through */ }

    if (!ewayBillNumber) {
      return res.status(502).json({ error: 'NIC GST portal did not return an e-way bill number.' });
    }

    const companyId = cid(req);
    const km = parseInt(distance_km) || 100;
    let days = 1;
    if (km > 300) days = 5;
    else if (km > 100) days = 3;
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + days);

    const { rows } = await pool.query(
      `INSERT INTO eway_bills
         (company_id, shipment_id, eway_bill_number, valid_until, from_gstin, to_gstin,
          vehicle_number, distance_km, goods_description, taxable_value, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') RETURNING *`,
      [companyId, shipment_id || null, ewayBillNumber, validUntil,
       from_gstin, to_gstin, vehicle_number, distance_km, goods_description, taxable_value]
    );
    res.status(201).json({ success: true, data: rows[0], source: 'nic', days_valid: days });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/* ── GET /dashboard ── */
router.get('/dashboard', async (req, res) => {
  try {
    const companyId = cid(req);
    const p = [companyId];
    const [inTransit, avgDelivery, onTime, freightCost] = await Promise.allSettled([
      pool.query(`SELECT COUNT(*) as n FROM shipments WHERE status IN ('dispatched','in_transit') AND ($1::int IS NULL OR company_id=$1)`, p),
      pool.query(`
        SELECT ROUND(AVG(actual_delivery::date - dispatch_date::date),1) as avg_days
        FROM shipments WHERE actual_delivery IS NOT NULL AND dispatch_date IS NOT NULL AND ($1::int IS NULL OR company_id=$1)
      `, p),
      pool.query(`
        SELECT COUNT(*) FILTER (WHERE actual_delivery <= expected_delivery) as on_time, COUNT(*) as total
        FROM shipments WHERE actual_delivery IS NOT NULL AND ($1::int IS NULL OR company_id=$1)
      `, p),
      pool.query(`
        SELECT COALESCE(SUM(freight_cost),0) as total
        FROM shipments WHERE created_at >= date_trunc('month',NOW()) AND ($1::int IS NULL OR company_id=$1)
      `, p),
    ]);
    const ot = onTime.status === 'fulfilled' ? onTime.value.rows[0] : { on_time: 0, total: 0 };
    res.json({
      in_transit: parseInt(inTransit.status === 'fulfilled' ? inTransit.value.rows[0].n : 0),
      avg_delivery_days: parseFloat(avgDelivery.status === 'fulfilled' ? avgDelivery.value.rows[0].avg_days || 0 : 0),
      on_time_pct: ot.total > 0 ? Math.round((ot.on_time / ot.total) * 100) : 0,
      freight_cost_mtd: parseFloat(freightCost.status === 'fulfilled' ? freightCost.value.rows[0].total : 0),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
