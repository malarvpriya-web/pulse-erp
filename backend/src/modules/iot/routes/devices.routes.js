/**
 * devices.routes.js — the operator-facing IoT fleet API.
 *
 * Mounted at /iot WITH verifyToken, after the device-token ingest router.
 *
 * EVERY handler opens with:
 *     const scope = iotScope(req);
 *     if (!scope.ok) return denyScope(res, scope);
 * because the previous pattern — `const companyId = req.scope?.company_id ?? null`
 * followed by `if (companyId != null) { add the predicate }` — turned a MISSING
 * company scope into NO company filter, i.e. every tenant's data. See scope.js.
 *
 * ENDPOINTS
 *   GET  /iot/fleet/summary              company-wide KPIs (not derived from a page)
 *   GET  /iot/devices                    fleet list (paged, filtered)
 *   GET  /iot/devices/:id                device 360
 *   GET  /iot/devices/:id/telemetry      history with coverage + quality + gaps
 *   GET  /iot/devices/:id/risk           condition risk score
 *   GET  /iot/devices/:id/events         connection/service event history
 *   GET  /iot/devices/:id/power-quality  the electrical panel (ratios, PF, energy)
 *   POST /iot/devices/:id/provision      mint device_uid + token   [shown ONCE]
 *   POST /iot/devices/:id/rotate-token   new token, old one revoked [shown ONCE]
 *   POST /iot/devices/:id/revoke-token   stop ingest immediately
 *   POST /iot/devices/:id/disable        disable the device
 *   POST /iot/devices/:id/enable         re-enable
 *   GET  /iot/devices/:id/tokens         token lifecycle history (never the secret)
 *   POST /iot/devices/:id/maintenance    open a maintenance window
 *   GET  /iot/devices/:id/maintenance    windows for this device
 *   DELETE /iot/maintenance/:id          cancel a window
 *   GET  /iot/metrics                    metric registry
 *   GET  /iot/profiles                   device profiles
 *   PUT  /iot/devices/:id/profile        attach a profile
 */

import { Router } from 'express';
import crypto from 'crypto';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { iotScope, denyScope, companyPredicate, scopedEquipment } from '../scope.js';
import { listMetrics, getMetric } from '../metricRegistry.js';
import { eligibleCodes, QUALITY } from '../quality.js';
import { linearTrend, daysToThreshold, conditionRisk, TREND_MIN } from '../trend.js';
import { recordEvent } from '../deviceEvents.js';
import { aggregatePf, energyDelta, harmonicReductionPct, unbalancePct, outputUtilisationPct, dataCoveragePct } from '../ratios.js';

const router = Router();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const LIVE_STATES_SQL = `('pending_confirmation','active','acknowledged','recovery_pending')`;

// ── GET /iot/fleet/summary ────────────────────────────────────────────────────
// Company-wide totals, computed in the database over the WHOLE population.
//
// The fleet page used to compute these in the browser from the device list — a
// list capped at 500 rows and filtered by the search box. Typing three characters
// changed the company's "devices online" figure. KPIs and lists are now different
// questions with different endpoints.
router.get('/fleet/summary', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [];
    const eqWhere = `WHERE 1=1${companyPredicate(scope, 'ce.company_id', params)}`;
    const alertParams = [];
    const alertWhere = `WHERE 1=1${companyPredicate(scope, 'da.company_id', alertParams)}`;

    const [fleet, alerts, quality] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int                                                                  AS equipment_total,
          COUNT(*) FILTER (WHERE ce.device_uid IS NOT NULL)::int                         AS provisioned,
          COUNT(*) FILTER (WHERE ce.device_uid IS NOT NULL AND ce.device_status='active'
                             AND ce.connection_state='online')::int                      AS online,
          COUNT(*) FILTER (WHERE ce.device_uid IS NOT NULL AND ce.connection_state='stale')::int   AS stale,
          COUNT(*) FILTER (WHERE ce.device_uid IS NOT NULL AND ce.connection_state='offline')::int AS offline,
          COUNT(*) FILTER (WHERE ce.device_uid IS NOT NULL AND ce.last_seen_at IS NULL)::int       AS never_connected,
          COUNT(*) FILTER (WHERE ce.device_status IN ('disabled','revoked'))::int         AS disabled,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(ce.amc_status,'')) = 'active')::int       AS under_amc,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(ce.warranty_status,'')) = 'active')::int  AS under_warranty,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM iot_maintenance_windows m
                                          WHERE m.equipment_id = ce.id AND m.cancelled_at IS NULL
                                            AND NOW() BETWEEN m.starts_at AND m.ends_at))::int AS in_maintenance
        FROM customer_equipment ce ${eqWhere}`, params),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE da.state IN ${LIVE_STATES_SQL})::int                     AS open_alerts,
          COUNT(*) FILTER (WHERE da.state IN ${LIVE_STATES_SQL} AND da.severity='critical')::int AS critical,
          COUNT(*) FILTER (WHERE da.state IN ${LIVE_STATES_SQL} AND da.severity='warning')::int  AS warning,
          COUNT(*) FILTER (WHERE da.state = 'acknowledged')::int                          AS acknowledged,
          COUNT(*) FILTER (WHERE da.state IN ${LIVE_STATES_SQL} AND da.ticket_id IS NOT NULL)::int AS awaiting_service,
          COUNT(*) FILTER (WHERE da.state NOT IN ${LIVE_STATES_SQL} AND da.state <> 'resolved'
                             AND da.state <> 'suppressed')::int                           AS invalid_state_rows
        FROM device_alerts da ${alertWhere}`, alertParams),
      (async () => {
        const p = [];
        const w = `WHERE t.received_at > NOW() - INTERVAL '24 hours'${companyPredicate(scope, 't.company_id', p)}`;
        return pool.query(`
          SELECT COUNT(*)::int AS samples_24h,
                 COUNT(*) FILTER (WHERE t.quality_code = 'VALID')::int AS valid_24h
            FROM device_telemetry t ${w}`, p);
      })(),
    ]);

    const f = fleet.rows[0], a = alerts.rows[0], q = quality.rows[0];
    res.json({
      scope: scope.isGlobal ? 'all companies' : `company ${scope.companyId}`,
      as_of: new Date().toISOString(),
      population: 'every customer_equipment row in scope; "provisioned" is device_uid IS NOT NULL',
      ...f, ...a, ...q,
      // Stated, not implied: these five rows hold a state outside the declared
      // vocabulary and are therefore counted nowhere else on this page.
      invalid_state_rows: a.invalid_state_rows,
    });
  } catch (e) {
    console.error('[iot fleet/summary]', e.message);
    res.status(500).json({ error: 'failed to load fleet summary' });
  }
});

// ── GET /iot/devices ──────────────────────────────────────────────────────────
router.get('/devices', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const { search, state, severity, provisioned } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const params = [];
    let q = `
      SELECT ce.id, ce.equipment_name, ce.equipment_tag, ce.model_number, ce.serial_number,
             ce.gps_lat, ce.gps_lng, ce.site_location, ce.connection_state, ce.last_seen_at,
             ce.last_event_ts, ce.warranty_status, ce.amc_status, ce.status, ce.device_status,
             ce.company_id, ce.project_id, ce.crm_account_id, ce.amc_contract_id,
             ce.sampling_secs, ce.actual_sampling_secs,
             (ce.device_uid IS NOT NULL) AS provisioned,
             p.device_type, g.gateway_uid,
             COALESCE(oa.open_alerts, 0)::int AS open_alerts,
             oa.max_severity,
             EXISTS (SELECT 1 FROM iot_maintenance_windows m
                      WHERE m.equipment_id = ce.id AND m.cancelled_at IS NULL
                        AND NOW() BETWEEN m.starts_at AND m.ends_at) AS in_maintenance
        FROM customer_equipment ce
        LEFT JOIN iot_device_profiles p ON p.id = ce.device_profile_id
        LEFT JOIN iot_gateways g ON g.id = ce.gateway_id
        LEFT JOIN (
          SELECT equipment_id,
                 COUNT(*) AS open_alerts,
                 CASE MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
                   WHEN 3 THEN 'critical' WHEN 2 THEN 'warning' ELSE 'info' END AS max_severity
            FROM device_alerts
           WHERE state IN ${LIVE_STATES_SQL}
           GROUP BY equipment_id
        ) oa ON oa.equipment_id = ce.id
       WHERE 1 = 1`;
    q += companyPredicate(scope, 'ce.company_id', params);
    if (state) { params.push(state); q += ` AND ce.connection_state = $${params.length}`; }
    if (severity) { params.push(severity); q += ` AND oa.max_severity = $${params.length}`; }
    if (provisioned === 'true') q += ` AND ce.device_uid IS NOT NULL`;
    if (provisioned === 'false') q += ` AND ce.device_uid IS NULL`;
    if (search) {
      params.push(`%${search}%`);
      const p = params.length;
      q += ` AND (ce.equipment_name ILIKE $${p} OR ce.serial_number ILIKE $${p} OR ce.model_number ILIKE $${p} OR ce.equipment_tag ILIKE $${p})`;
    }
    const countSql = `SELECT COUNT(*)::int AS total FROM (${q}) c`;
    const { rows: countRows } = await pool.query(countSql, params);

    params.push(limit); params.push(offset);
    q += ` ORDER BY open_alerts DESC NULLS LAST, ce.equipment_name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(q, params);

    res.json({
      rows,
      total: countRows[0].total,
      limit, offset,
      // The list is a filtered page. Whoever wants company totals asks
      // /iot/fleet/summary — stated here so no caller recreates the old bug.
      note: 'This is a filtered, paged list. Do not compute company-wide KPIs from it; use /iot/fleet/summary.',
    });
  } catch (e) {
    console.error('[iot devices]', e.message);
    res.status(500).json({ error: 'failed to load devices' });
  }
});

// ── GET /iot/devices/:id — Device 360 ─────────────────────────────────────────
router.get('/devices/:id', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    delete eq.telemetry_token_hash;          // never leak the credential
    eq.provisioned = eq.device_uid != null;

    const [latest, alerts, profile, gateway, maintenance, links, events] = await Promise.all([
      pool.query(
        `SELECT l.metric, l.value::float AS value, l.ts AS event_ts, l.received_at,
                l.quality_code, COALESCE(l.unit, m.unit) AS unit, m.display_name,
                m.min_physical::float AS min_physical, m.max_physical::float AS max_physical,
                m.rising_is_bad
           FROM device_latest l
           LEFT JOIN iot_metric_definitions m
                  ON m.metric_code = l.metric
                 AND (m.company_id = l.company_id OR m.company_id IS NULL)
          WHERE l.equipment_id = $1
          ORDER BY l.metric`, [eq.id]),
      pool.query(
        `SELECT da.id, da.incident_uid, da.metric, da.value::float AS value,
                da.observed_value::float AS observed_value, da.worst_value::float AS worst_value,
                da.threshold::float AS threshold, da.clear_threshold::float AS clear_threshold,
                da.severity, da.state, da.message, da.opened_at, da.first_detected_at,
                da.last_detected_at, da.acknowledged_at, da.resolved_at, da.breach_count,
                da.ticket_id, da.resolution_reason, da.resolution_source,
                t.ticket_number, t.status AS ticket_status, t.priority AS ticket_priority,
                t.assigned_to AS ticket_assigned_to, t.created_at AS ticket_created_at,
                e.name AS technician_name
           FROM device_alerts da
           LEFT JOIN support_tickets t ON t.id = da.ticket_id
           LEFT JOIN employees e ON e.id = t.assigned_to
          WHERE da.equipment_id = $1
          ORDER BY (da.state IN ('pending_confirmation','active','acknowledged','recovery_pending')) DESC,
                   da.opened_at DESC
          LIMIT 50`, [eq.id]),
      eq.device_profile_id
        ? pool.query(`SELECT * FROM iot_device_profiles WHERE id = $1`, [eq.device_profile_id])
        : Promise.resolve({ rows: [] }),
      eq.gateway_id
        ? pool.query(`SELECT * FROM iot_gateways WHERE id = $1`, [eq.gateway_id])
        : Promise.resolve({ rows: [] }),
      pool.query(
        `SELECT id, starts_at, ends_at, reason, authorized_by, ticket_id
           FROM iot_maintenance_windows
          WHERE equipment_id = $1 AND cancelled_at IS NULL AND ends_at > NOW() - INTERVAL '30 days'
          ORDER BY starts_at DESC LIMIT 10`, [eq.id]),
      // The business chain: customer, project, AMC. Read from the EXISTING Pulse
      // entities (accounts / projects / amc_contracts); nothing is duplicated
      // into the IoT module. Note the customer table is `accounts` — `crm_accounts`
      // does not exist in this database, and customer_equipment.crm_account_id
      // carries no foreign key, so a dangling id yields NULLs rather than an error.
      pool.query(
        `SELECT a.id AS customer_id, a.name AS customer_name,
                pr.id AS project_id, pr.project_name,
                amc.id AS amc_id, amc.contract_number AS amc_number, amc.end_date AS amc_end
           FROM customer_equipment ce
           LEFT JOIN accounts a      ON a.id = ce.crm_account_id
           LEFT JOIN projects pr     ON pr.id = ce.project_id
           LEFT JOIN amc_contracts amc ON amc.id = ce.amc_contract_id
          WHERE ce.id = $1`, [eq.id]).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT event_type, occurred_at, source, alert_id, ticket_id, detail
           FROM iot_device_events WHERE equipment_id = $1
          ORDER BY occurred_at DESC LIMIT 25`, [eq.id]),
    ]);

    // Data age is the operator's real question: not "when was the event stamped"
    // but "how long since anything arrived".
    const dataAgeSecs = eq.last_seen_at
      ? Math.round((Date.now() - new Date(eq.last_seen_at).getTime()) / 1000)
      : null;

    res.json({
      ...eq,
      connection: {
        state: eq.last_seen_at == null ? 'never' : eq.connection_state,
        last_telemetry_received: eq.last_seen_at,
        last_event_ts: eq.last_event_ts,
        data_age_secs: dataAgeSecs,
        configured_sampling_secs: eq.sampling_secs,
        actual_sampling_secs: eq.actual_sampling_secs,
      },
      latest: latest.rows,
      alerts: alerts.rows,
      profile: profile.rows[0] || null,
      gateway: gateway.rows[0] || null,
      maintenance: maintenance.rows,
      business: links.rows[0] || null,
      events: events.rows,
    });
  } catch (e) {
    console.error('[iot device]', e.message);
    res.status(500).json({ error: 'failed to load device' });
  }
});

// ── GET /iot/devices/:id/telemetry ────────────────────────────────────────────
// History with the things a chart must not hide: sample count, quality mix,
// expected count, coverage and explicit gaps.
router.get('/devices/:id/telemetry', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });

    const metric = String(req.query.metric || '').trim();
    if (!metric) return res.status(400).json({ error: 'metric is required' });

    // 1h to 90 days — the old UI was hard-limited to 24h with no way to ask for more.
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 90);
    const policy = ['valid_only', 'include_suspect', 'history', 'all'].includes(req.query.quality)
      ? req.query.quality : 'valid_only';

    const def = await getMetric(eq.company_id, metric);
    const bucketMins = hours <= 6 ? 1 : hours <= 48 ? 15 : hours <= 24 * 14 ? 60 : 360;

    const params = [eq.id, metric, bucketMins, String(hours), eligibleCodes(policy)];
    const { rows } = await pool.query(
      `SELECT to_timestamp(floor(extract(epoch FROM ts) / ($3 * 60)) * ($3 * 60)) AS bucket,
              AVG(value)::float AS value,
              MIN(value)::float AS min_value,
              MAX(value)::float AS max_value,
              COUNT(*)::int     AS sample_count,
              COUNT(*) FILTER (WHERE quality_code = 'VALID')::int AS valid_count,
              MAX(ts)           AS last_event_ts
         FROM device_telemetry
        WHERE equipment_id = $1 AND metric = $2
          AND ts >= NOW() - ($4 || ' hours')::interval
          AND quality_code = ANY($5)
        GROUP BY 1 ORDER BY 1`, params);

    const { rows: qmix } = await pool.query(
      `SELECT quality_code, COUNT(*)::int AS n
         FROM device_telemetry
        WHERE equipment_id = $1 AND metric = $2 AND ts >= NOW() - ($3 || ' hours')::interval
        GROUP BY 1 ORDER BY 2 DESC`, [eq.id, metric, String(hours)]);

    // Gaps: a bucket boundary crossed with no sample. Marked explicitly so the
    // chart can break the line instead of drawing a straight segment across a
    // four-hour outage and calling it data.
    const points = rows.map((r) => ({ ...r, bucket: r.bucket }));
    const gaps = [];
    for (let i = 1; i < points.length; i++) {
      const delta = (new Date(points[i].bucket) - new Date(points[i - 1].bucket)) / 60000;
      if (delta > bucketMins * 1.5) {
        gaps.push({ from: points[i - 1].bucket, to: points[i].bucket, minutes: Math.round(delta) });
      }
    }

    const samplingSecs = eq.sampling_secs || eq.actual_sampling_secs || def?.sampling_expect_s || null;
    const expected = samplingSecs ? Math.floor((hours * 3600) / samplingSecs) : null;
    const received = points.reduce((s, p) => s + p.sample_count, 0);
    const valid = points.reduce((s, p) => s + p.valid_count, 0);

    res.json({
      metric,
      unit: def?.unit ?? null,
      display_name: def?.display_name ?? metric,
      hours, bucket_mins: bucketMins, quality_policy: policy,
      points,
      gaps,
      sample_count: received,
      valid_count: valid,
      quality_mix: qmix,
      coverage: dataCoveragePct({ received: valid, expected, window: `${hours}h` }),
      state: points.length === 0 ? 'EMPTY' : 'OK',
    });
  } catch (e) {
    console.error('[iot telemetry]', e.message);
    res.status(500).json({ error: 'failed to load telemetry' });
  }
});

// ── GET /iot/devices/:id/risk ─────────────────────────────────────────────────
router.get('/devices/:id/risk', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });

    const [{ rows: agg }, { rows: risingMetrics }] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM device_alerts WHERE equipment_id = $1 AND state IN ${LIVE_STATES_SQL})::int AS open_alerts,
          (SELECT COUNT(*) FROM device_alerts WHERE equipment_id = $1 AND state IN ${LIVE_STATES_SQL} AND severity='critical')::int AS critical_open,
          (SELECT COUNT(*) FROM device_alerts WHERE equipment_id = $1 AND opened_at > NOW() - INTERVAL '30 days')::int AS alerts_30d,
          (SELECT COUNT(*) FROM device_telemetry WHERE equipment_id = $1 AND ts > NOW() - INTERVAL '30 days')::int AS telemetry_samples_30d
      `, [eq.id]),
      pool.query(`
        SELECT DISTINCT l.metric, m.rising_is_bad
          FROM device_latest l
          JOIN iot_metric_definitions m ON m.metric_code = l.metric AND (m.company_id = l.company_id OR m.company_id IS NULL)
         WHERE l.equipment_id = $1 AND m.rising_is_bad = TRUE`, [eq.id]),
    ]);

    // Trends over 14 days, one query per rising metric, each with its own
    // sufficiency verdict.
    const trends = [];
    for (const m of risingMetrics) {
      const { rows: pts } = await pool.query(
        `SELECT ts, value::float AS value FROM device_telemetry
          WHERE equipment_id = $1 AND metric = $2 AND ts > NOW() - INTERVAL '14 days'
            AND quality_code = 'VALID'
          ORDER BY ts`, [eq.id, m.metric]);
      const trend = linearTrend(pts);
      const { rows: rules } = await pool.query(
        `SELECT threshold::float AS threshold FROM device_alert_rules
          WHERE is_active AND company_id = $1 AND metric = $2
            AND operator IN ('>','>=') AND threshold IS NOT NULL
            AND (equipment_id = $3 OR equipment_id IS NULL)
          ORDER BY threshold LIMIT 1`, [eq.company_id, m.metric, eq.id]);
      trends.push({
        metric: m.metric,
        rising_is_bad: m.rising_is_bad,
        trend,
        projection: daysToThreshold(trend, rules[0]?.threshold ?? null),
      });
    }

    const risk = conditionRisk({ ...eq, ...agg[0] }, trends);
    res.json({
      equipment_id: eq.id,
      equipment_name: eq.equipment_name,
      ...risk,
      trends,
      trend_requirements: TREND_MIN,
    });
  } catch (e) {
    console.error('[iot risk]', e.message);
    res.status(500).json({ error: 'failed to compute condition risk' });
  }
});

// ── GET /iot/devices/:id/power-quality ────────────────────────────────────────
// The electrical panel: aggregate PF done properly, energy with counter handling,
// unbalance, harmonic reduction, utilisation. Everything states its method.
router.get('/devices/:id/power-quality', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 24 * 90);
    const win = `${hours}h`;

    const series = async (metric) => {
      const { rows } = await pool.query(
        `SELECT ts, value::float AS value FROM device_telemetry
          WHERE equipment_id = $1 AND metric = $2 AND ts > NOW() - ($3 || ' hours')::interval
            AND quality_code = 'VALID' ORDER BY ts`,
        [eq.id, metric, String(hours)]);
      return rows;
    };
    const avg = async (metric) => {
      const { rows } = await pool.query(
        `SELECT AVG(value)::float AS v, COUNT(*)::int AS n FROM device_telemetry
          WHERE equipment_id = $1 AND metric = $2 AND ts > NOW() - ($3 || ' hours')::interval
            AND quality_code = 'VALID'`,
        [eq.id, metric, String(hours)]);
      return rows[0].n > 0 ? rows[0].v : null;
    };

    const [kwhS, kvahS, kvarhS] = await Promise.all([
      series('ENERGY_KWH'), series('ENERGY_KVAH'), series('ENERGY_KVARH'),
    ]);
    const kwh = energyDelta(kwhS, { maxGapSecs: (eq.sampling_secs || 60) * 5 });
    const kvah = energyDelta(kvahS, { maxGapSecs: (eq.sampling_secs || 60) * 5 });
    const kvarh = energyDelta(kvarhS, { maxGapSecs: (eq.sampling_secs || 60) * 5 });

    const [v1, v2, v3, i1, i2, i3, pre, post, loading] = await Promise.all([
      avg('V_L1'), avg('V_L2'), avg('V_L3'),
      avg('I_L1'), avg('I_L2'), avg('I_L3'),
      avg('THD_I_PRE'), avg('THD_I_POST'), avg('LOADING_PCT'),
    ]);

    const ratedMatch = String(eq.rating || '').match(/([\d.]+)/);
    const rated = ratedMatch ? Number(ratedMatch[1]) : null;
    const compCurrent = await avg('COMP_CURRENT');

    res.json({
      equipment_id: eq.id,
      window: win,
      energy: {
        kwh, kvah, kvarh,
        note: 'Deltas are the sum of per-step increases with counter reset and rollover detection — never last minus first.',
      },
      power_factor: aggregatePf({
        kwh: kwh.total, kvah: kvah.total, kvarh: kvarh.total, window: win,
      }),
      voltage_unbalance: unbalancePct([v1, v2, v3]),
      current_unbalance: unbalancePct([i1, i2, i3]),
      harmonic_reduction: harmonicReductionPct({ preThd: pre, postThd: post, window: win }),
      utilisation: loading != null
        ? { code: 'OUTPUT_UTILISATION_PCT', label: 'Output utilisation', value: Number(loading.toFixed(2)), state: 'OK', unit: '%', window: win, formula: 'device-reported LOADING_PCT, averaged over the window' }
        : outputUtilisationPct({ actual: compCurrent, rated, window: win }),
      rating_raw: eq.rating ?? null,
    });
  } catch (e) {
    console.error('[iot power-quality]', e.message);
    res.status(500).json({ error: 'failed to compute power quality' });
  }
});

// ── GET /iot/devices/:id/events ───────────────────────────────────────────────
router.get('/devices/:id/events', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 730);
    const { rows } = await pool.query(
      `SELECT id, event_type, occurred_at, source, alert_id, ticket_id, detail
         FROM iot_device_events
        WHERE equipment_id = $1 AND occurred_at > NOW() - ($2 || ' days')::interval
        ORDER BY occurred_at DESC LIMIT 500`,
      [eq.id, String(days)]);
    res.json({ rows, days });
  } catch (e) {
    res.status(500).json({ error: 'failed to load events' });
  }
});

// ── Token lifecycle ───────────────────────────────────────────────────────────
async function issueToken(req, res, eq, { action }) {
  const token = crypto.randomBytes(24).toString('hex');
  const hash = sha256(token);
  const deviceUid = eq.device_uid || `PULSE-${eq.id}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const userId = req.user?.userId ?? null;
  const reason = String(req.body?.reason || '').slice(0, 500) || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Any previously active token is rotated out, so exactly one token can ever
    // authenticate a device. Before this, rotation overwrote a hash and left no
    // record that the old credential had existed at all.
    await client.query(
      `UPDATE iot_device_tokens
          SET status = 'rotated', rotated_at = NOW(), rotated_by = $2
        WHERE equipment_id = $1 AND status = 'active'`,
      [eq.id, userId]);
    await client.query(
      `INSERT INTO iot_device_tokens
         (company_id, equipment_id, token_hash, token_prefix, status, created_by, reason)
       VALUES ($1,$2,$3,$4,'active',$5,$6)`,
      [eq.company_id, eq.id, hash, token.slice(0, 8), userId, reason]);
    await client.query(
      `UPDATE customer_equipment
          SET device_uid = $2, telemetry_token_hash = $3,
              device_status = 'active',
              provisioned_at = COALESCE(provisioned_at, NOW()),
              disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [eq.id, deviceUid, hash]);
    await recordEvent(client, {
      companyId: eq.company_id, equipmentId: eq.id,
      eventType: action === 'provision' ? 'PROVISIONED' : 'TOKEN_ROTATED',
      source: 'operator', detail: { by: userId, reason },
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  logAudit({
    userId, module: 'iot', recordId: eq.id, recordType: 'customer_equipment',
    action: action === 'provision' ? 'create' : 'update',
    newData: { device_uid: deviceUid, token_action: action, token_prefix: token.slice(0, 8), reason },
    req, company_id: eq.company_id,
  });

  // The raw token is returned exactly once — it is never stored recoverably.
  res.json({
    device_uid: deviceUid, token,
    ingest_url: '/api/v1/iot/ingest',
    heartbeat_url: '/api/v1/iot/gateway/heartbeat',
    note: 'Store this token now — it cannot be retrieved again.',
  });
}

router.post('/devices/:id/provision', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    await issueToken(req, res, eq, { action: 'provision' });
  } catch (e) { console.error('[iot provision]', e.message); res.status(500).json({ error: 'provisioning failed' }); }
});

router.post('/devices/:id/rotate-token', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    if (!eq.device_uid) return res.status(400).json({ error: 'device is not provisioned yet' });
    await issueToken(req, res, eq, { action: 'rotate' });
  } catch (e) { console.error('[iot rotate]', e.message); res.status(500).json({ error: 'rotation failed' }); }
});

/**
 * Revoke: ingest stops on the NEXT request, not when someone remembers to rotate.
 * The equipment hash is cleared as well as the token row being marked, so both
 * the fast path and the lifecycle record agree.
 */
router.post('/devices/:id/revoke-token', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  const client = await pool.connect();
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    const userId = req.user?.userId ?? null;
    const reason = String(req.body?.reason || '').slice(0, 500) || null;
    await client.query('BEGIN');
    await client.query(
      `UPDATE iot_device_tokens SET status='revoked', revoked_at=NOW(), revoked_by=$2, reason=COALESCE($3, reason)
        WHERE equipment_id=$1 AND status='active'`, [eq.id, userId, reason]);
    await client.query(
      `UPDATE customer_equipment SET telemetry_token_hash = NULL, device_status='revoked', updated_at=NOW()
        WHERE id = $1`, [eq.id]);
    await recordEvent(client, { companyId: eq.company_id, equipmentId: eq.id, eventType: 'TOKEN_REVOKED', source: 'operator', detail: { by: userId, reason } });
    await client.query('COMMIT');
    logAudit({ userId, module: 'iot', recordId: eq.id, recordType: 'customer_equipment', action: 'update', oldData: { device_status: eq.device_status }, newData: { device_status: 'revoked', reason }, req, company_id: eq.company_id });
    res.json({ ok: true, device_status: 'revoked' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[iot revoke]', e.message);
    res.status(500).json({ error: 'revocation failed' });
  } finally { client.release(); }
});

router.post('/devices/:id/disable', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    const userId = req.user?.userId ?? null;
    const reason = String(req.body?.reason || '').slice(0, 500) || null;
    await pool.query(
      `UPDATE customer_equipment
          SET device_status='disabled', disabled_at=NOW(), disabled_by=$2, disabled_reason=$3, updated_at=NOW()
        WHERE id=$1`, [eq.id, userId, reason]);
    await recordEvent(pool, { companyId: eq.company_id, equipmentId: eq.id, eventType: 'DISABLED', source: 'operator', detail: { by: userId, reason } });
    logAudit({ userId, module: 'iot', recordId: eq.id, recordType: 'customer_equipment', action: 'update', oldData: { device_status: eq.device_status }, newData: { device_status: 'disabled', reason }, req, company_id: eq.company_id });
    res.json({ ok: true, device_status: 'disabled' });
  } catch (e) { res.status(500).json({ error: 'disable failed' }); }
});

router.post('/devices/:id/enable', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    if (!eq.telemetry_token_hash) {
      return res.status(400).json({ error: 'device has no active token — rotate a new one instead', code: 'NO_ACTIVE_TOKEN' });
    }
    const userId = req.user?.userId ?? null;
    await pool.query(
      `UPDATE customer_equipment SET device_status='active', disabled_at=NULL, disabled_by=NULL, disabled_reason=NULL, updated_at=NOW() WHERE id=$1`,
      [eq.id]);
    await recordEvent(pool, { companyId: eq.company_id, equipmentId: eq.id, eventType: 'ENABLED', source: 'operator', detail: { by: userId } });
    logAudit({ userId, module: 'iot', recordId: eq.id, recordType: 'customer_equipment', action: 'update', oldData: { device_status: eq.device_status }, newData: { device_status: 'active' }, req, company_id: eq.company_id });
    res.json({ ok: true, device_status: 'active' });
  } catch (e) { res.status(500).json({ error: 'enable failed' }); }
});

/** Token history — status and timestamps only. The secret is never recoverable. */
router.get('/devices/:id/tokens', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    const { rows } = await pool.query(
      `SELECT t.id, t.token_prefix, t.status, t.created_at, t.rotated_at, t.revoked_at,
              t.expires_at, t.last_used_at, t.reason,
              cu.name AS created_by_name, ru.name AS revoked_by_name
         FROM iot_device_tokens t
         LEFT JOIN users cu ON cu.id = t.created_by
         LEFT JOIN users ru ON ru.id = t.revoked_by
        WHERE t.equipment_id = $1 ORDER BY t.created_at DESC`, [eq.id]);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: 'failed to load token history' }); }
});

// ── Maintenance windows ───────────────────────────────────────────────────────
router.post('/devices/:id/maintenance', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    const { starts_at, ends_at, reason, ticket_id = null } = req.body || {};
    if (!starts_at || !ends_at || !reason) {
      return res.status(400).json({ error: 'starts_at, ends_at and reason are required' });
    }
    const s = new Date(starts_at), e = new Date(ends_at);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) {
      return res.status(400).json({ error: 'ends_at must be a valid time after starts_at' });
    }
    const userId = req.user?.userId ?? null;
    const { rows } = await pool.query(
      `INSERT INTO iot_maintenance_windows (company_id, equipment_id, starts_at, ends_at, reason, authorized_by, ticket_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [eq.company_id, eq.id, s.toISOString(), e.toISOString(), String(reason).slice(0, 1000), userId, ticket_id]);
    await recordEvent(pool, {
      companyId: eq.company_id, equipmentId: eq.id, eventType: 'MAINTENANCE_START',
      occurredAt: s.toISOString(), source: 'operator', ticketId: ticket_id,
      detail: { window_id: rows[0].id, reason, ends_at: e.toISOString() },
    });
    logAudit({ userId, module: 'iot', recordId: rows[0].id, recordType: 'iot_maintenance_window', action: 'create', newData: rows[0], req, company_id: eq.company_id });
    res.status(201).json(rows[0]);
  } catch (e) { console.error('[iot maintenance]', e.message); res.status(500).json({ error: 'failed to open maintenance window' }); }
});

router.get('/devices/:id/maintenance', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    const { rows } = await pool.query(
      `SELECT m.*, u.name AS authorized_by_name
         FROM iot_maintenance_windows m
         LEFT JOIN users u ON u.id = m.authorized_by
        WHERE m.equipment_id = $1 ORDER BY m.starts_at DESC LIMIT 100`, [eq.id]);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: 'failed to load maintenance windows' }); }
});

router.delete('/maintenance/:id', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [req.params.id];
    let sql = `UPDATE iot_maintenance_windows SET cancelled_at = NOW() WHERE id = $1 AND cancelled_at IS NULL`;
    sql += companyPredicate(scope, 'company_id', params);
    const { rows } = await pool.query(sql + ' RETURNING *', params);
    if (!rows.length) return res.status(404).json({ error: 'maintenance window not found' });
    await recordEvent(pool, {
      companyId: rows[0].company_id, equipmentId: rows[0].equipment_id,
      eventType: 'MAINTENANCE_END', source: 'operator', detail: { window_id: rows[0].id, cancelled: true },
    });
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: rows[0].id, recordType: 'iot_maintenance_window', action: 'delete', oldData: rows[0], req, company_id: rows[0].company_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'failed to cancel maintenance window' }); }
});

// ── Metric registry + profiles ────────────────────────────────────────────────
router.get('/metrics', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    res.json({ rows: await listMetrics(scope.companyId) });
  } catch (e) { res.status(500).json({ error: 'failed to load metric registry' }); }
});

router.get('/profiles', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [];
    let sql = `SELECT * FROM iot_device_profiles WHERE (company_id IS NULL`;
    if (!scope.isGlobal) { params.push(scope.companyId); sql += ` OR company_id = $${params.length}`; }
    else sql += ` OR TRUE`;
    sql += `) AND enabled = TRUE ORDER BY device_type, profile_code`;
    const { rows } = await pool.query(sql, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: 'failed to load device profiles' }); }
});

router.put('/devices/:id/profile', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const eq = await scopedEquipment(pool, req.params.id, scope);
    if (!eq) return res.status(404).json({ error: 'device not found' });
    const profileId = req.body?.device_profile_id;
    if (profileId != null) {
      const { rows } = await pool.query(
        `SELECT id FROM iot_device_profiles WHERE id = $1 AND (company_id IS NULL OR company_id = $2)`,
        [profileId, eq.company_id]);
      if (!rows.length) return res.status(400).json({ error: 'profile not found in this company' });
    }
    await pool.query(
      `UPDATE customer_equipment SET device_profile_id = $2, sampling_secs = COALESCE($3, sampling_secs), updated_at = NOW() WHERE id = $1`,
      [eq.id, profileId ?? null, req.body?.sampling_secs ?? null]);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: eq.id, recordType: 'customer_equipment', action: 'update', oldData: { device_profile_id: eq.device_profile_id }, newData: { device_profile_id: profileId }, req, company_id: eq.company_id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'failed to attach profile' }); }
});

export default router;
export { LIVE_STATES_SQL };
