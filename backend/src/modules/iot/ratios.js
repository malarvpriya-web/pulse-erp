/**
 * ratios.js — every calculated IoT percentage, with its definition attached.
 *
 * THE RULE THIS FILE ENFORCES
 * ---------------------------
 * A ratio is not a number; it is a number plus a numerator, a denominator, a time
 * window, a population and a statement of what happens when the denominator is
 * zero. "Online %" on the old fleet page was computed in the browser as
 * `devices.filter(online).length / devices.length` over a list that was capped at
 * 500 rows AND filtered by whatever the operator had typed into the search box —
 * so typing three characters changed the company's uptime figure.
 *
 * Every function here returns:
 *
 *   {
 *     code, label, value,            // value is null when it cannot be computed
 *     numerator, denominator, unit,
 *     window, population,            // what was counted, over what period
 *     state,                         // 'OK' | 'INSUFFICIENT_DATA' | 'NO_DENOMINATOR'
 *     formula, note
 *   }
 *
 * A caller that wants a bare number must decide what to do with `state` first.
 * That is deliberate: an absent denominator is not 0%.
 */

const ratio = ({ code, label, numerator, denominator, unit = '%', window: win, population, formula, note = null, minDenominator = 1 }) => {
  if (denominator == null || numerator == null) {
    return { code, label, value: null, numerator, denominator, unit, window: win, population, state: 'INSUFFICIENT_DATA', formula, note };
  }
  if (denominator < minDenominator) {
    return { code, label, value: null, numerator, denominator, unit, window: win, population, state: 'NO_DENOMINATOR', formula, note: note || 'denominator is zero — a percentage is undefined, not 0' };
  }
  return {
    code, label,
    value: Number(((numerator / denominator) * 100).toFixed(2)),
    numerator, denominator, unit, window: win, population, state: 'OK', formula, note,
  };
};

/**
 * Online % — of the devices that are PROVISIONED, how many are reporting now.
 *
 * Population is provisioned devices, not all equipment rows: a unit that was
 * never fitted with a gateway is not "offline", it is not monitored, and counting
 * it as downtime makes the number meaningless.
 */
export const onlinePct = ({ online, provisioned, window: win = 'instant' }) => ratio({
  code: 'ONLINE_PCT', label: 'Devices online',
  numerator: online, denominator: provisioned,
  window: win, population: 'provisioned devices (device_uid IS NOT NULL AND device_status = active)',
  formula: 'online devices / provisioned devices × 100',
  note: 'Never-connected devices are counted in the denominator; unprovisioned equipment is not.',
});

/**
 * Sample delivery % — of the samples we EXPECTED, how many valid ones arrived.
 *
 * Expected = window ÷ configured sampling interval × metric count. A device with
 * no declared sampling interval cannot have an expectation, so it is excluded
 * from the denominator rather than assumed to be 60 s.
 */
export const sampleDeliveryPct = ({ validReceived, expected, window: win }) => ratio({
  code: 'SAMPLE_DELIVERY_PCT', label: 'Sample delivery',
  numerator: validReceived, denominator: expected,
  window: win, population: 'devices with a configured sampling interval',
  formula: 'valid samples received / (window ÷ sampling interval × metrics) × 100',
  note: 'Only VALID-quality samples count in the numerator. Duplicates are deduplicated before counting.',
});

/**
 * Monitoring uptime % — of the time a device was ELIGIBLE to be monitored, how
 * much of it was it actually reporting.
 *
 * Eligible time excludes maintenance windows: an engineer disconnecting a unit on
 * purpose is not a monitoring failure.
 */
export const monitoringUptimePct = ({ onlineSecs, eligibleSecs, window: win }) => ratio({
  code: 'MONITORING_UPTIME_PCT', label: 'Monitoring uptime',
  numerator: onlineSecs, denominator: eligibleSecs,
  window: win, population: 'one device, from iot_device_events',
  formula: 'seconds in ONLINE / (window seconds − maintenance seconds) × 100',
  note: 'Derived from the event history, not from the current connection_state.',
});

/**
 * Output utilisation % — actual output against the unit rating.
 *
 * Requires a rating on customer_equipment. `rating` is a free-text VARCHAR in
 * this schema ("100A", "50 kVAr"), so the caller must pass a parsed number; when
 * it cannot be parsed the result is INSUFFICIENT_DATA rather than a guess.
 */
export const outputUtilisationPct = ({ actual, rated, window: win = 'latest sample' }) => ratio({
  code: 'OUTPUT_UTILISATION_PCT', label: 'Output utilisation',
  numerator: actual, denominator: rated,
  window: win, population: 'one device',
  formula: 'actual output / rated output × 100',
  note: 'Rated output is parsed from customer_equipment.rating; an unparseable rating yields no value.',
});

/**
 * Harmonic reduction % — what the AHF is actually achieving.
 *
 * Needs BOTH pre- and post-compensation THD from the same device over the same
 * window. A unit that only publishes one of them cannot report this, which is why
 * THD_I_PRE / THD_I_POST are declared capabilities rather than assumed.
 */
export const harmonicReductionPct = ({ preThd, postThd, window: win }) => {
  if (preThd == null || postThd == null) {
    return {
      code: 'HARMONIC_REDUCTION_PCT', label: 'Harmonic reduction', value: null,
      numerator: preThd == null || postThd == null ? null : preThd - postThd,
      denominator: preThd, unit: '%', window: win, population: 'one device',
      state: 'INSUFFICIENT_DATA',
      formula: '(pre-compensation THD − post-compensation THD) / pre-compensation THD × 100',
      note: 'Requires both THD_I_PRE and THD_I_POST; this device does not report both.',
    };
  }
  return ratio({
    code: 'HARMONIC_REDUCTION_PCT', label: 'Harmonic reduction',
    numerator: preThd - postThd, denominator: preThd,
    window: win, population: 'one device',
    formula: '(pre-compensation THD − post-compensation THD) / pre-compensation THD × 100',
    note: 'A negative result means distortion increased downstream of the filter.',
    minDenominator: 0.0001,
  });
};

/** Data coverage % — how much of the expected series actually exists. */
export const dataCoveragePct = ({ received, expected, window: win }) => ratio({
  code: 'DATA_COVERAGE_PCT', label: 'Data coverage',
  numerator: received, denominator: expected,
  window: win, population: 'one metric on one device',
  formula: 'valid samples in window / expected samples in window × 100',
});

/**
 * POWER FACTOR AGGREGATION
 * ------------------------
 * Averaging PF samples is wrong and the error is not small: the arithmetic mean
 * of PF over a period weights a minute at 2 kW the same as a minute at 200 kW.
 * The correct aggregate is energy-weighted:
 *
 *     true PF over a period = kWh / kVAh
 *
 * so this function takes energy, not power factor. Where kVAh is unavailable it
 * falls back to kWh / sqrt(kWh² + kVArh²), which is the same identity expressed
 * through reactive energy. With neither, it refuses.
 *
 * SIGN CONVENTION (declared in the metric registry and repeated here because it
 * is the thing people get wrong): POSITIVE PF = LAGGING (inductive load),
 * NEGATIVE PF = LEADING (capacitive). An SVG over-compensating shows a negative
 * aggregate PF, which is a real condition and must not be abs()'d away.
 */
export function aggregatePf({ kwh, kvah = null, kvarh = null, window: win }) {
  const base = {
    code: 'PF_AGGREGATE', label: 'True power factor (energy-weighted)',
    unit: 'ratio', window: win, population: 'one device',
    formula: 'kWh / kVAh over the window (fallback: kWh / sqrt(kWh² + kVArh²))',
    note: 'Positive = lagging, negative = leading. Never the arithmetic mean of PF samples.',
  };
  if (kwh == null) return { ...base, value: null, numerator: null, denominator: null, state: 'INSUFFICIENT_DATA' };

  if (kvah != null && Math.abs(kvah) > 1e-9) {
    return { ...base, value: Number((kwh / kvah).toFixed(4)), numerator: kwh, denominator: kvah, state: 'OK', method: 'kwh_over_kvah' };
  }
  if (kvarh != null) {
    const apparent = Math.sqrt(kwh * kwh + kvarh * kvarh);
    if (apparent < 1e-9) return { ...base, value: null, numerator: kwh, denominator: 0, state: 'NO_DENOMINATOR', note: 'no energy flowed in this window — power factor is undefined, not 1.0' };
    const sign = kvarh < 0 ? -1 : 1;
    return { ...base, value: Number((sign * (kwh / apparent)).toFixed(4)), numerator: kwh, denominator: apparent, state: 'OK', method: 'kwh_over_sqrt' };
  }
  return { ...base, value: null, numerator: kwh, denominator: null, state: 'INSUFFICIENT_DATA', note: 'neither kVAh nor kVArh available for this window' };
}

/**
 * ENERGY COUNTER DELTAS
 * ---------------------
 * ENERGY_KWH is a monotonic counter on the device. Subtracting the first reading
 * from the last is wrong whenever the counter reset (firmware update, power
 * cycle, manual clear) or rolled over at its register width — both produce a
 * hugely negative or hugely positive delta that, unchecked, lands in a report as
 * a real number.
 *
 * Walk the series and sum the per-step increases:
 *   - step >= 0            → normal consumption, add it
 *   - step <  0 and the new value is small → counter RESET; count the new value
 *     as consumption since the reset and record the event
 *   - step <  0 and the drop is close to a known register width → ROLLOVER; add
 *     (width − previous) + current
 *
 * @param {Array<{ts: string, value: number}>} series ascending by ts
 * @returns {{total: number|null, steps: number, resets: number, rollovers: number,
 *            gaps: number, coverageSecs: number, state: string, note: string}}
 */
export function energyDelta(series, { registerWidths = [2 ** 16, 2 ** 32, 1e6, 1e9], maxGapSecs = null } = {}) {
  const pts = (series || []).filter((p) => p && p.value != null && Number.isFinite(Number(p.value)));
  if (pts.length < 2) {
    return { total: null, steps: 0, resets: 0, rollovers: 0, gaps: 0, coverageSecs: 0, state: 'INSUFFICIENT_DATA', note: 'fewer than two counter readings in the window' };
  }

  let total = 0, resets = 0, rollovers = 0, gaps = 0, steps = 0;
  for (let i = 1; i < pts.length; i++) {
    const prev = Number(pts[i - 1].value);
    const cur = Number(pts[i].value);
    const gapSecs = (new Date(pts[i].ts) - new Date(pts[i - 1].ts)) / 1000;
    if (maxGapSecs && gapSecs > maxGapSecs) gaps += 1;

    const step = cur - prev;
    if (step >= 0) { total += step; steps += 1; continue; }

    // Negative step. Treat as a ROLLOVER only when the previous reading sat in
    // the top decile of a known register width and the new one is near the
    // bottom — the signature of a counter wrapping rather than being cleared.
    const width = registerWidths.find((w) => prev > w * 0.9 && prev <= w && cur < w * 0.1);
    if (width) { total += (width - prev) + cur; rollovers += 1; steps += 1; continue; }

    // Otherwise a reset: the counter restarted, so `cur` is consumption since.
    total += Math.max(0, cur);
    resets += 1; steps += 1;
  }

  const coverageSecs = (new Date(pts[pts.length - 1].ts) - new Date(pts[0].ts)) / 1000;
  return {
    total: Number(total.toFixed(4)), steps, resets, rollovers, gaps, coverageSecs,
    state: 'OK',
    note: resets || rollovers
      ? `counter discontinuities handled: ${resets} reset(s), ${rollovers} rollover(s)`
      : 'no counter discontinuity detected',
  };
}

/**
 * Three-phase unbalance, the NEMA definition:
 *   max deviation from the mean ÷ mean × 100
 * Returns null rather than 0 when a phase is missing — two phases is not a
 * three-phase measurement.
 */
export function unbalancePct([a, b, c]) {
  const vals = [a, b, c].filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (vals.length < 3) {
    return { code: 'UNBALANCE_PCT', value: null, state: 'INSUFFICIENT_DATA', note: 'needs all three phases', formula: 'max|phase − mean| / mean × 100' };
  }
  const mean = (vals[0] + vals[1] + vals[2]) / 3;
  if (Math.abs(mean) < 1e-9) {
    return { code: 'UNBALANCE_PCT', value: null, state: 'NO_DENOMINATOR', note: 'all three phases are zero — unbalance is undefined', formula: 'max|phase − mean| / mean × 100' };
  }
  const maxDev = Math.max(...vals.map((v) => Math.abs(v - mean)));
  return {
    code: 'UNBALANCE_PCT', value: Number(((maxDev / mean) * 100).toFixed(3)), state: 'OK',
    numerator: maxDev, denominator: mean, unit: '%',
    formula: 'max|phase − mean| / mean × 100 (NEMA)',
  };
}
