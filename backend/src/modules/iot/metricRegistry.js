/**
 * metricRegistry.js — the declared meaning of every telemetry metric.
 *
 * Before this, `device_telemetry.metric` was a free-text VARCHAR(40) and a value
 * was whatever number arrived. There was no unit, no physical range, no statement
 * of how to aggregate it and no way to know whether a given device even exposes
 * it. So an AHF could report THD_I = 899 (the same shape of defect as
 * master_hsn_sac.gst_rate holding 899) and every downstream average, alert and
 * trend would treat it as a measurement.
 *
 * Lookups resolve the tenant's own definition first, then the global catalogue.
 * The cache is per-process with a short TTL: the catalogue changes rarely, and an
 * ingest path cannot afford a lookup round-trip per sample.
 */

import pool from '../../config/db.js';

const TTL_MS = 60_000;
let cache = { at: 0, byKey: new Map() };

const key = (companyId, code) => `${companyId ?? 'G'}:${code}`;

async function refresh() {
  const { rows } = await pool.query(
    `SELECT company_id, metric_code, display_name, unit, data_type, device_types,
            min_physical, max_physical, precision_digits, aggregation, quality_policy,
            rising_is_bad, is_counter, enabled, sampling_expect_s, version
       FROM iot_metric_definitions`
  );
  const byKey = new Map();
  for (const r of rows) {
    byKey.set(key(r.company_id, r.metric_code), {
      metric_code: r.metric_code,
      display_name: r.display_name,
      unit: r.unit,
      data_type: r.data_type,
      device_types: r.device_types || [],
      min_physical: r.min_physical == null ? null : Number(r.min_physical),
      max_physical: r.max_physical == null ? null : Number(r.max_physical),
      precision_digits: r.precision_digits,
      aggregation: r.aggregation,
      quality_policy: r.quality_policy,
      rising_is_bad: r.rising_is_bad,
      is_counter: r.is_counter,
      enabled: r.enabled,
      sampling_expect_s: r.sampling_expect_s,
      version: r.version,
      company_id: r.company_id,
    });
  }
  cache = { at: Date.now(), byKey };
}

async function ensureFresh() {
  if (Date.now() - cache.at > TTL_MS) {
    try { await refresh(); } catch (e) {
      // A registry lookup failure must not take ingest down; it downgrades to
      // "metric not declared", which the caller treats as UNKNOWN_METRIC rather
      // than as an implicit pass.
      console.warn('[iot metricRegistry] refresh failed:', e.message);
      cache.at = Date.now();
    }
  }
}

/** Force a reload — call after a metric definition is written. */
export function invalidateMetricCache() { cache.at = 0; }

/** One metric definition for a company (tenant override wins), or null. */
export async function getMetric(companyId, code) {
  await ensureFresh();
  const c = String(code || '').trim();
  if (!c) return null;
  return cache.byKey.get(key(companyId, c)) || cache.byKey.get(key(null, c)) || null;
}

/** Every metric visible to a company: the global catalogue with tenant overrides. */
export async function listMetrics(companyId) {
  await ensureFresh();
  const out = new Map();
  for (const [k, v] of cache.byKey) {
    if (k.startsWith('G:')) out.set(v.metric_code, v);
  }
  if (companyId != null) {
    for (const [k, v] of cache.byKey) {
      if (k.startsWith(`${companyId}:`)) out.set(v.metric_code, v);
    }
  }
  return [...out.values()].sort((a, b) => a.metric_code.localeCompare(b.metric_code));
}

/**
 * Validate one reading against its declaration.
 *
 * @returns {{ok: true, def, value: number|null}}
 *        | {ok: false, reason: 'UNKNOWN_METRIC'|'METRIC_DISABLED'|'NOT_NUMERIC'|'OUT_OF_RANGE'|'NOT_SUPPORTED_BY_PROFILE', def, detail}
 *
 * UNKNOWN_METRIC is a rejection, not a pass. A gateway sending a metric nobody
 * declared is a configuration error, and storing it would recreate exactly the
 * free-text situation this registry replaces.
 */
export async function validateReading(companyId, code, rawValue, { capabilities = null } = {}) {
  const def = await getMetric(companyId, code);
  if (!def) return { ok: false, reason: 'UNKNOWN_METRIC', def: null, detail: `metric '${code}' is not declared` };
  if (!def.enabled) return { ok: false, reason: 'METRIC_DISABLED', def, detail: `metric '${code}' is disabled` };

  // Capability gate: a profile declares what the model actually publishes.
  if (Array.isArray(capabilities) && capabilities.length && !capabilities.includes(def.metric_code)) {
    return {
      ok: false, reason: 'NOT_SUPPORTED_BY_PROFILE', def,
      detail: `device profile does not declare '${def.metric_code}'`,
    };
  }

  if (rawValue == null) return { ok: true, def, value: null };
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'NOT_NUMERIC', def, detail: `value '${rawValue}' is not a finite number` };
  }
  if (def.min_physical != null && value < def.min_physical) {
    return { ok: false, reason: 'OUT_OF_RANGE', def, detail: `${value} < min ${def.min_physical} ${def.unit}` };
  }
  if (def.max_physical != null && value > def.max_physical) {
    return { ok: false, reason: 'OUT_OF_RANGE', def, detail: `${value} > max ${def.max_physical} ${def.unit}` };
  }
  return { ok: true, def, value };
}
