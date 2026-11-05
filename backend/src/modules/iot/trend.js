/**
 * trend.js — linear trend with an explicit sufficiency test, and the condition
 * risk score that consumes it.
 *
 * THE DEFECTS THIS EXISTS TO CLOSE
 * --------------------------------
 * 1. The old slope query was `regr_slope(value, epoch) ... HAVING COUNT(*) >= 5`.
 *    Five points is not a trend. Five points taken within one minute, or five
 *    points where four are identical and one is a spike, produced a slope that
 *    was then extrapolated into "reaches 9.0 in ~3 days" and shown to an operator
 *    as a maintenance instruction.
 *
 * 2. Nothing reported how good the fit was, so a slope through noise looked
 *    exactly like a slope through a genuine degradation ramp.
 *
 * 3. `scoreDevice()` summed drivers and returned 0 when there were none — and a
 *    device with NO telemetry at all has no drivers. So an unmonitored unit
 *    scored 0 and the UI printed "No action needed", which is the most dangerous
 *    sentence the page could produce about a device nobody is watching.
 *
 * 4. The score was surfaced as "Predicted health / failure probability". It is a
 *    weighted heuristic over five observable signals. It is not a probability and
 *    no validation set exists, so it is named Condition Risk Score.
 */

/** Minimums below which a slope is not reported. Deliberately strict. */
export const TREND_MIN = Object.freeze({
  samples: 30,          // 30 points
  coverageHours: 6,     // spanning at least 6 hours
  r2: 0.3,              // and explaining at least 30% of the variance
});

/**
 * Ordinary least squares over (epoch seconds, value), with R² and the coverage
 * that justifies it.
 *
 * @param {Array<{ts: string|Date, value: number}>} points
 * @returns {{state: 'OK'|'INSUFFICIENT_DATA'|'POOR_FIT', slopePerDay, r2, n,
 *            coverageHours, latest, first, note}}
 */
export function linearTrend(points, limits = TREND_MIN) {
  const pts = (points || [])
    .filter((p) => p && p.value != null && Number.isFinite(Number(p.value)))
    .map((p) => ({ t: new Date(p.ts).getTime() / 1000, v: Number(p.value) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);

  const n = pts.length;
  const coverageHours = n >= 2 ? (pts[n - 1].t - pts[0].t) / 3600 : 0;

  if (n < limits.samples || coverageHours < limits.coverageHours) {
    return {
      state: 'INSUFFICIENT_DATA', slopePerDay: null, r2: null, n,
      coverageHours: Number(coverageHours.toFixed(2)),
      latest: n ? pts[n - 1].v : null, first: n ? pts[0].v : null,
      note: `needs ${limits.samples} samples over ${limits.coverageHours}h; have ${n} over ${coverageHours.toFixed(1)}h`,
    };
  }

  const meanT = pts.reduce((s, p) => s + p.t, 0) / n;
  const meanV = pts.reduce((s, p) => s + p.v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dt = p.t - meanT, dv = p.v - meanV;
    sxx += dt * dt; sxy += dt * dv; syy += dv * dv;
  }
  if (sxx === 0) {
    return { state: 'INSUFFICIENT_DATA', slopePerDay: null, r2: null, n, coverageHours: Number(coverageHours.toFixed(2)), latest: pts[n - 1].v, first: pts[0].v, note: 'all samples share one timestamp' };
  }
  const slopePerSec = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);

  return {
    state: r2 < limits.r2 ? 'POOR_FIT' : 'OK',
    slopePerDay: Number((slopePerSec * 86400).toFixed(6)),
    r2: Number(r2.toFixed(4)),
    n, coverageHours: Number(coverageHours.toFixed(2)),
    latest: pts[n - 1].v, first: pts[0].v,
    note: r2 < limits.r2 ? `fit explains only ${(r2 * 100).toFixed(0)}% of the variance — the slope is not reliable` : null,
  };
}

/**
 * Days until a rising metric reaches a threshold, with every assumption returned
 * alongside it. Refuses rather than extrapolating from a weak fit.
 */
export function daysToThreshold(trend, threshold, { now = new Date() } = {}) {
  const base = {
    current_value: trend?.latest ?? null,
    threshold: threshold ?? null,
    slope_per_day: trend?.slopePerDay ?? null,
    window_hours: trend?.coverageHours ?? null,
    sample_count: trend?.n ?? 0,
    r2: trend?.r2 ?? null,
    calculated_at: now.toISOString(),
  };
  if (!trend || trend.state !== 'OK') {
    return { ...base, days: null, state: 'INSUFFICIENT_DATA', note: trend?.note || 'no usable trend' };
  }
  if (threshold == null) return { ...base, days: null, state: 'NO_THRESHOLD', note: 'no rule threshold configured for this metric' };
  if (!(trend.slopePerDay > 0)) return { ...base, days: null, state: 'NOT_RISING', note: 'the metric is flat or falling' };
  if (trend.latest >= threshold) return { ...base, days: 0, state: 'ALREADY_EXCEEDED', note: 'the current value is already at or past the threshold' };

  const days = (threshold - trend.latest) / trend.slopePerDay;
  return {
    ...base,
    days: Math.round(days),
    state: 'OK',
    note: `linear extrapolation of a ${trend.coverageHours.toFixed(0)}h fit (R²=${trend.r2}); assumes the trend continues unchanged`,
  };
}

/**
 * CONDITION RISK SCORE
 * --------------------
 * A transparent weighted sum over observable, DB-grounded signals. Each driver
 * names the evidence that produced it. It is NOT a failure probability.
 *
 * The important change from the old scoreDevice(): a device with no usable
 * evidence returns state INSUFFICIENT_DATA and a null score, instead of 0 and
 * "No action needed".
 *
 * @param {object} d  device row + aggregates
 * @param {Array}  trends  [{metric, trend, rising_is_bad}]
 */
export function conditionRisk(d, trends = []) {
  const drivers = [];
  const add = (points, factor, evidence) => {
    if (points > 0) drivers.push({ factor, points: Math.round(points), evidence });
  };

  const hasEvidence =
    (d.telemetry_samples_30d ?? 0) > 0 ||
    (d.open_alerts ?? 0) > 0 ||
    (d.alerts_30d ?? 0) > 0 ||
    d.last_seen_at != null;

  if (!hasEvidence) {
    return {
      score: null, band: null, state: 'INSUFFICIENT_DATA', drivers: [],
      recommendation: 'No telemetry, no alerts and no connection history for this device — its condition is unknown. Check provisioning and gateway connectivity.',
      trend: null,
    };
  }

  if ((d.critical_open ?? 0) > 0) add(40, `${d.critical_open} critical alert(s) open`, 'device_alerts.state in live states, severity=critical');
  const warnings = Math.max(0, (d.open_alerts ?? 0) - (d.critical_open ?? 0));
  add(Math.min(warnings, 2) * 10, `${warnings} unresolved warning(s)`, 'device_alerts live, severity<>critical');

  if (d.connection_state === 'offline') add(25, 'device offline', 'customer_equipment.connection_state');
  else if (d.connection_state === 'stale') add(12, 'telemetry stale', 'customer_equipment.connection_state');
  else if (d.connection_state === 'never') add(5, 'never reported', 'customer_equipment.last_seen_at IS NULL');

  add(Math.min(d.alerts_30d ?? 0, 4) * 5, `${d.alerts_30d ?? 0} alert(s) in the last 30 days`, 'device_alerts.opened_at > now-30d');

  let best = null;
  for (const t of trends) {
    if (!t?.trend || t.trend.state !== 'OK' || !t.rising_is_bad) continue;
    if (!(t.trend.slopePerDay > 0) || !t.trend.latest) continue;
    const pctPerDay = (t.trend.slopePerDay / Math.abs(t.trend.latest)) * 100;
    const pts = Math.min(pctPerDay * 4, 20);
    if (pts >= 1 && (!best || pts > best.pts)) best = { metric: t.metric, pts, pctPerDay, trend: t.trend };
  }
  if (best) {
    add(best.pts, `${best.metric} rising ~${best.pctPerDay.toFixed(1)}%/day`,
        `OLS over ${best.trend.n} samples / ${best.trend.coverageHours}h, R²=${best.trend.r2}`);
  }

  if (d.warranty_status && String(d.warranty_status).toLowerCase() !== 'active') {
    add(10, `warranty ${d.warranty_status}`, 'customer_equipment.warranty_status');
  }
  if (!d.amc_status || String(d.amc_status).toLowerCase() === 'none') {
    add(5, 'no AMC cover', 'customer_equipment.amc_status');
  }

  const score = Math.min(100, drivers.reduce((s, x) => s + x.points, 0));
  const band = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';
  drivers.sort((a, b) => b.points - a.points);

  const recommendation =
    (d.critical_open ?? 0) > 0 ? 'Dispatch a service engineer — a critical condition is active'
    : d.connection_state === 'offline' ? 'Check site connectivity and power — the device is dark'
    : best ? `Schedule an inspection — ${best.metric} is trending up`
    : band === 'medium' ? 'Monitor closely; review at the next AMC visit'
    : 'No elevated risk from the signals currently available';

  return {
    score, band, state: 'OK', drivers,
    recommendation,
    trend: best ? { metric: best.metric, slope_per_day: best.trend.slopePerDay, r2: best.trend.r2 } : null,
    definition: 'Condition Risk Score: a transparent weighted sum of observed alert, connectivity, trend and contract-cover signals, capped at 100. It is not a validated failure probability.',
  };
}
