/**
 * serviceKpis.js — uptime, MTBF, MTTR and SLA, computed from the event history
 * and refusing to answer when the history cannot support the answer.
 *
 * WHY THE REFUSAL MATTERS
 * -----------------------
 * These four numbers are the ones an operator quotes to a customer. Derived from
 * a connection-state snapshot they are fiction; derived from two events they are
 * a coincidence presented to three significant figures. Every function here
 * returns a `state` of 'OK' or 'INSUFFICIENT_DATA' with the reason, and the UI
 * prints the reason rather than a number.
 *
 * MINIMUMS
 *   MTBF  needs at least 2 failures (1 interval) — reported with n so the reader
 *         can judge it; below 3 it is flagged low_confidence.
 *   MTTR  needs at least 2 completed repairs.
 *   Uptime needs at least 24 hours of observed window.
 */

export const KPI_MIN = Object.freeze({
  mtbfFailures: 2,
  mtbfConfident: 3,
  mttrRepairs: 2,
  uptimeHours: 24,
});

const insufficient = (code, label, note, extra = {}) => ({
  code, label, value: null, unit: null, state: 'INSUFFICIENT_DATA', note, ...extra,
});

/**
 * Monitoring uptime from ONLINE/OFFLINE/STALE transitions.
 *
 * @param {Array<{event_type, occurred_at}>} events  ascending
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {number} maintenanceSecs  excluded from the eligible denominator
 */
export function uptimeFromEvents(events, windowStart, windowEnd, maintenanceSecs = 0) {
  const windowSecs = (windowEnd - windowStart) / 1000;
  if (windowSecs < KPI_MIN.uptimeHours * 3600) {
    return insufficient('UPTIME_PCT', 'Monitoring uptime',
      `window is ${(windowSecs / 3600).toFixed(1)}h; at least ${KPI_MIN.uptimeHours}h is needed`);
  }
  const transitions = (events || [])
    .filter((e) => ['ONLINE', 'OFFLINE', 'STALE', 'NEVER_CONNECTED'].includes(e.event_type))
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  if (!transitions.length) {
    return insufficient('UPTIME_PCT', 'Monitoring uptime', 'no connection events recorded in this window');
  }

  let onlineSecs = 0;
  let cursor = windowStart;
  // The state before the first event in the window is unknown; treat it as the
  // inverse of the first transition, which is the only inference the data
  // supports, and say so in the note.
  let state = transitions[0].event_type === 'ONLINE' ? 'down' : 'up';
  for (const t of transitions) {
    const at = new Date(t.occurred_at);
    if (at < windowStart || at > windowEnd) continue;
    if (state === 'up') onlineSecs += (at - cursor) / 1000;
    state = t.event_type === 'ONLINE' ? 'up' : 'down';
    cursor = at;
  }
  if (state === 'up') onlineSecs += (windowEnd - cursor) / 1000;

  const eligible = windowSecs - maintenanceSecs;
  if (eligible <= 0) {
    return insufficient('UPTIME_PCT', 'Monitoring uptime', 'the entire window was maintenance time');
  }
  return {
    code: 'UPTIME_PCT', label: 'Monitoring uptime',
    value: Number(((onlineSecs / eligible) * 100).toFixed(2)),
    unit: '%', state: 'OK',
    numerator_secs: Math.round(onlineSecs), denominator_secs: Math.round(eligible),
    maintenance_secs_excluded: Math.round(maintenanceSecs),
    transitions: transitions.length,
    note: 'State before the first event in the window is inferred from that event; maintenance time is excluded from the denominator.',
    formula: 'seconds ONLINE / (window seconds − maintenance seconds) × 100',
  };
}

/** Mean time BETWEEN failures — the mean gap between consecutive FAULT events. */
export function mtbfFromEvents(events) {
  const faults = (events || [])
    .filter((e) => e.event_type === 'FAULT')
    .map((e) => new Date(e.occurred_at))
    .sort((a, b) => a - b);
  if (faults.length < KPI_MIN.mtbfFailures) {
    return insufficient('MTBF', 'Mean time between failures',
      `${faults.length} failure(s) recorded; at least ${KPI_MIN.mtbfFailures} are needed to measure an interval`,
      { failures: faults.length });
  }
  let total = 0;
  for (let i = 1; i < faults.length; i++) total += (faults[i] - faults[i - 1]) / 1000;
  const intervals = faults.length - 1;
  return {
    code: 'MTBF', label: 'Mean time between failures',
    value: Number((total / intervals / 3600).toFixed(2)), unit: 'hours', state: 'OK',
    failures: faults.length, intervals,
    low_confidence: faults.length < KPI_MIN.mtbfConfident,
    note: faults.length < KPI_MIN.mtbfConfident
      ? `based on ${intervals} interval(s) — treat as indicative only`
      : null,
    formula: 'sum of gaps between consecutive FAULT events / number of gaps',
  };
}

/**
 * Mean time to repair — FAULT to the matching RECOVERY or SERVICE_COMPLETED.
 * An unpaired fault (still open) is excluded from the mean and reported
 * separately, because counting an ongoing outage as a completed repair of
 * duration "so far" understates MTTR every time it is measured.
 */
export function mttrFromEvents(events) {
  const ordered = (events || []).sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const durations = [];
  let openFault = null;
  let unpaired = 0;
  for (const e of ordered) {
    if (e.event_type === 'FAULT') {
      if (openFault) unpaired += 1;
      openFault = new Date(e.occurred_at);
    } else if ((e.event_type === 'RECOVERY' || e.event_type === 'SERVICE_COMPLETED') && openFault) {
      durations.push((new Date(e.occurred_at) - openFault) / 1000);
      openFault = null;
    }
  }
  if (openFault) unpaired += 1;

  if (durations.length < KPI_MIN.mttrRepairs) {
    return insufficient('MTTR', 'Mean time to repair',
      `${durations.length} completed repair(s); at least ${KPI_MIN.mttrRepairs} are needed`,
      { completed_repairs: durations.length, open_faults: unpaired });
  }
  const mean = durations.reduce((s, d) => s + d, 0) / durations.length;
  return {
    code: 'MTTR', label: 'Mean time to repair',
    value: Number((mean / 3600).toFixed(2)), unit: 'hours', state: 'OK',
    completed_repairs: durations.length, open_faults: unpaired,
    note: unpaired ? `${unpaired} fault(s) are still open and are excluded from the mean` : null,
    formula: 'mean of (RECOVERY or SERVICE_COMPLETED time − matching FAULT time)',
  };
}

/**
 * Mean time to ACKNOWLEDGE, from the alert rows themselves.
 * @param {Array<{opened_at, acknowledged_at}>} alerts
 */
export function mttaFromAlerts(alerts) {
  const acked = (alerts || []).filter((a) => a.acknowledged_at);
  if (acked.length < 2) {
    return insufficient('MTTA', 'Mean time to acknowledge',
      `${acked.length} acknowledged alert(s); at least 2 are needed`, { acknowledged: acked.length });
  }
  const mean = acked.reduce((s, a) => s + (new Date(a.acknowledged_at) - new Date(a.opened_at)) / 1000, 0) / acked.length;
  return {
    code: 'MTTA', label: 'Mean time to acknowledge',
    value: Number((mean / 60).toFixed(1)), unit: 'minutes', state: 'OK',
    acknowledged: acked.length,
    unacknowledged: (alerts || []).length - acked.length,
    formula: 'mean of (acknowledged_at − opened_at) over acknowledged alerts',
  };
}
