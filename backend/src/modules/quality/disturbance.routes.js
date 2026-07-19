/**
 * disturbance.routes.js — Industrial Power Disturbance Event Historian
 * Mounted at /api/quality/disturbance-events in server.js
 *
 * Tracks power disturbance events: voltage sags/swells, harmonic spikes,
 * transients, breaker trips, overloads, frequency deviations, reactive anomalies.
 *
 * Endpoints:
 *   GET  /               — paginated event list with filtering
 *   POST /               — log a new disturbance event
 *   GET  /summary        — counts by type/severity + 6-month monthly trend (IST)
 *   GET  /export         — CSV download
 *   PUT  /:id/resolve    — mark event resolved
 */

import { Router } from 'express';
import pool from '../../config/db.js';

const router = Router();

const cid   = (req) => req.scope?.company_id ?? null;
const actor = (req) => ({
  id:   req.user?.userId || req.user?.id   || null,
  name: req.user?.name   || req.user?.email || 'System',
});

const EVENT_TYPES = [
  'voltage_sag', 'voltage_swell', 'harmonic_spike', 'transient',
  'breaker_trip', 'overload', 'frequency_deviation', 'reactive_anomaly',
];
const SEVERITIES = ['info', 'warning', 'critical'];

const EVENT_LABELS = {
  voltage_sag:        'Voltage Sag',
  voltage_swell:      'Voltage Swell',
  harmonic_spike:     'Harmonic Spike',
  transient:          'Transient',
  breaker_trip:       'Breaker Trip',
  overload:           'Overload',
  frequency_deviation:'Frequency Deviation',
  reactive_anomaly:   'Reactive Power Anomaly',
};

/* ── Schema bootstrap ────────────────────────────────────────────────────────
   Creates table and indexes on first startup. Idempotent via IF NOT EXISTS.  */
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disturbance_events (
      id               SERIAL PRIMARY KEY,
      company_id       INT,
      equipment_id     INT,
      event_type       TEXT NOT NULL,
      severity         TEXT NOT NULL DEFAULT 'warning',
      site_name        TEXT,
      measured_value   NUMERIC,
      threshold_value  NUMERIC,
      unit             TEXT,
      duration_ms      INT,
      waveform_ref     TEXT,
      event_ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by       INT,
      created_by_name  TEXT,
      resolved_at      TIMESTAMPTZ,
      resolved_by_name TEXT,
      notes            TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dist_evt_ts  ON disturbance_events(event_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_dist_evt_typ ON disturbance_events(event_type, severity);
    CREATE INDEX IF NOT EXISTS idx_dist_evt_co  ON disturbance_events(company_id);
  `).catch(e => console.error('[disturbance] schema init error:', e.message));
})();

/* ── GET / — paginated event list ────────────────────────────────────────────
   Query params: event_type, severity, site_name, from, to, resolved, page, limit */
router.get('/', async (req, res) => {
  try {
    const {
      event_type, severity, site_name, from, to,
      resolved, page = 1, limit = 50,
    } = req.query;

    const companyId = cid(req);
    const params    = [companyId];
    const where     = [`($1::int IS NULL OR company_id = $1)`];

    if (event_type)         { params.push(event_type);          where.push(`event_type = $${params.length}`); }
    if (severity)           { params.push(severity);            where.push(`severity = $${params.length}`); }
    if (site_name)          { params.push(`%${site_name}%`);   where.push(`site_name ILIKE $${params.length}`); }
    if (from)               { params.push(from);                where.push(`event_ts >= $${params.length}`); }
    if (to)                 { params.push(to);                  where.push(`event_ts <= $${params.length}`); }
    if (resolved === 'true') where.push(`resolved_at IS NOT NULL`);
    if (resolved === 'false') where.push(`resolved_at IS NULL`);

    const lim    = Math.min(parseInt(limit)  || 50, 200);
    const offset = (Math.max(parseInt(page) || 1, 1) - 1) * lim;

    // Clone params for count query (without pagination args)
    const countParams = [...params];
    params.push(lim, offset);

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT *,
                TO_CHAR(event_ts AT TIME ZONE 'Asia/Kolkata', 'DD-Mon-YYYY HH24:MI IST') AS event_ts_ist
         FROM disturbance_events
         WHERE ${where.join(' AND ')}
         ORDER BY event_ts DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::INT AS total FROM disturbance_events WHERE ${where.join(' AND ')}`,
        countParams
      ),
    ]);

    res.json({
      rows:  dataResult.rows,
      total: countResult.rows[0]?.total ?? 0,
      page:  Math.max(parseInt(page) || 1, 1),
      limit: lim,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── POST / — log a disturbance event ───────────────────────────────────────
   Body: event_type*, severity, site_name, measured_value, threshold_value,
         unit, duration_ms, waveform_ref, event_ts, notes                    */
router.post('/', async (req, res) => {
  try {
    const {
      event_type, severity = 'warning', site_name,
      measured_value, threshold_value, unit,
      duration_ms, waveform_ref, event_ts, notes,
    } = req.body;

    if (!event_type || !EVENT_TYPES.includes(event_type)) {
      return res.status(400).json({
        error: `event_type is required. Must be one of: ${EVENT_TYPES.join(', ')}`,
      });
    }
    if (!SEVERITIES.includes(severity)) {
      return res.status(400).json({
        error: `severity must be one of: ${SEVERITIES.join(', ')}`,
      });
    }

    const companyId = cid(req);
    const a         = actor(req);
    const ts        = event_ts ? new Date(event_ts) : new Date();

    const { rows } = await pool.query(
      `INSERT INTO disturbance_events
         (company_id, event_type, severity, site_name, measured_value, threshold_value,
          unit, duration_ms, waveform_ref, event_ts, created_by, created_by_name, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *,
         TO_CHAR(event_ts AT TIME ZONE 'Asia/Kolkata', 'DD-Mon-YYYY HH24:MI IST') AS event_ts_ist`,
      [
        companyId, event_type, severity, site_name || null,
        measured_value != null ? Number(measured_value) : null,
        threshold_value != null ? Number(threshold_value) : null,
        unit || null, duration_ms ? parseInt(duration_ms) : null,
        waveform_ref || null, ts, a.id, a.name, notes || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /summary — aggregated counts + IST monthly trend ───────────────────
   Returns: totals, by_type, by_severity, monthly (last 6 months, IST bounds) */
router.get('/summary', async (req, res) => {
  try {
    const companyId = cid(req);
    const scope     = [`($1::int IS NULL OR company_id = $1)`];

    const [byType, bySeverity, monthly] = await Promise.all([

      pool.query(
        `SELECT
           event_type,
           COUNT(*)::INT                                           AS count,
           COUNT(*) FILTER (WHERE resolved_at IS NULL)::INT       AS open,
           COUNT(*) FILTER (WHERE severity = 'critical')::INT     AS critical
         FROM disturbance_events
         WHERE ${scope.join(' AND ')}
           AND event_ts >= NOW() - INTERVAL '30 days'
         GROUP BY event_type
         ORDER BY count DESC`,
        [companyId]
      ),

      pool.query(
        `SELECT severity, COUNT(*)::INT AS count
         FROM disturbance_events
         WHERE ${scope.join(' AND ')}
           AND event_ts >= NOW() - INTERVAL '30 days'
         GROUP BY severity`,
        [companyId]
      ),

      pool.query(
        `SELECT
           TO_CHAR(DATE_TRUNC('month', event_ts AT TIME ZONE 'Asia/Kolkata'), 'Mon YY') AS month,
           DATE_TRUNC('month', event_ts AT TIME ZONE 'Asia/Kolkata')                   AS month_ts,
           COUNT(*)::INT                                           AS count,
           COUNT(*) FILTER (WHERE severity = 'critical')::INT     AS critical_count,
           COUNT(*) FILTER (WHERE severity = 'warning')::INT      AS warning_count
         FROM disturbance_events
         WHERE ${scope.join(' AND ')}
           AND event_ts >= NOW() - INTERVAL '6 months'
         GROUP BY DATE_TRUNC('month', event_ts AT TIME ZONE 'Asia/Kolkata')
         ORDER BY month_ts`,
        [companyId]
      ),
    ]);

    const totals = byType.rows.reduce(
      (acc, r) => ({ total: acc.total + r.count, open: acc.open + r.open }),
      { total: 0, open: 0 }
    );

    res.json({
      totals,
      by_type:    byType.rows.map(r => ({ ...r, label: EVENT_LABELS[r.event_type] || r.event_type })),
      by_severity: bySeverity.rows,
      monthly:    monthly.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── PUT /:id/resolve — mark event resolved ──────────────────────────────────
   Body: notes (optional)                                                     */
router.put('/:id/resolve', async (req, res) => {
  try {
    const { notes } = req.body;
    const a = actor(req);
    const { rows } = await pool.query(
      `UPDATE disturbance_events
       SET resolved_at      = NOW(),
           resolved_by_name = $1,
           notes            = COALESCE($2, notes)
       WHERE id = $3
       RETURNING *,
         TO_CHAR(event_ts AT TIME ZONE 'Asia/Kolkata', 'DD-Mon-YYYY HH24:MI IST') AS event_ts_ist`,
      [a.name, notes || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /export — CSV export ────────────────────────────────────────────────
   Query params: days (default 90, max 365)                                   */
router.get('/export', async (req, res) => {
  try {
    const days      = Math.min(parseInt(req.query.days || 90), 365);
    const companyId = cid(req);

    const { rows } = await pool.query(
      `SELECT
         id, event_type, severity, site_name,
         measured_value, threshold_value, unit, duration_ms,
         TO_CHAR(event_ts AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI IST') AS event_ts_ist,
         created_by_name, resolved_at IS NOT NULL AS resolved, resolved_by_name, notes
       FROM disturbance_events
       WHERE ($1::int IS NULL OR company_id = $1)
         AND event_ts >= NOW() - ($2 || ' days')::INTERVAL
       ORDER BY event_ts DESC`,
      [companyId, days]
    );

    const exportedAt = new Date().toLocaleString('en-GB', {
      timeZone: 'Asia/Kolkata', year: '2-digit', month: 'short',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }) + ' IST';

    const dateTag = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).replace(/\//g, '-');

    const headers = [
      'ID', 'Event Type', 'Severity', 'Site', 'Measured Value',
      'Threshold', 'Unit', 'Duration (ms)', 'Event Time (IST)',
      'Logged By', 'Resolved', 'Resolved By', 'Notes',
    ];

    const csvRows = rows.map(r =>
      [
        r.id, EVENT_LABELS[r.event_type] || r.event_type, r.severity,
        r.site_name || '', r.measured_value ?? '', r.threshold_value ?? '',
        r.unit || '', r.duration_ms ?? '', r.event_ts_ist,
        r.created_by_name || '', r.resolved ? 'Yes' : 'No',
        r.resolved_by_name || '', r.notes || '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    );

    const csv = [
      `# Pulse ERP — Disturbance Event Export`,
      `# Exported: ${exportedAt}`,
      `# Period: last ${days} days`,
      `# Records: ${rows.length}`,
      `#`,
      headers.join(','),
      ...csvRows,
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="disturbance-events-${dateTag}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
