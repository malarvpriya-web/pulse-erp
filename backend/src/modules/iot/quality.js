/**
 * quality.js — the telemetry quality vocabulary, and the rule that decides which
 * samples a calculation is allowed to consume.
 *
 * THE DEFECT THIS EXISTS TO CLOSE
 * -------------------------------
 * `device_telemetry.quality` was a SMALLINT that ingest wrote and NOTHING ever
 * read. Every AVG, MIN, MAX, trend, risk score and "latest reading" consumed
 * every stored row regardless of whether the gateway had flagged it as a
 * communication error or an out-of-range reading. A bad register read therefore
 * became a valid measurement, and the operator had no way to tell.
 *
 * Quality is now a named state, and every consumer declares a policy.
 *
 * STATES
 *   VALID                - measured, in range, on time. The only state eligible
 *                          everywhere by default.
 *   SUSPECT              - measured, but the gateway or a range check is unsure
 *                          (e.g. near a sensor limit). Eligible only under the
 *                          'include_suspect' policy, and always labelled.
 *   INVALID              - the device reported the value as invalid.
 *   OUT_OF_RANGE         - outside the metric's declared physical range. Stored
 *                          in the quarantine table, never in the series.
 *   COMMUNICATION_ERROR  - the gateway could not read the register.
 *   STALE                - the gateway re-sent a cached value because the device
 *                          did not answer this poll.
 *   REPLAY               - accepted historically (event time well in the past).
 *                          Legitimate for history; must NOT drive liveness or the
 *                          latest-value cache.
 *   OUT_OF_ORDER         - arrived after a newer sample for the same metric.
 *                          Kept in history; does not overwrite the latest value.
 *   MISSING              - a gap marker; never carries a value.
 *
 * POLICIES
 *   'valid_only'      - VALID only. The default for alerts, trends and averages.
 *   'include_suspect' - VALID + SUSPECT. For a metric whose sensor is known to
 *                       sit near its limit and where a gap is worse than doubt.
 *   'history'         - VALID + SUSPECT + REPLAY + OUT_OF_ORDER. Everything that
 *                       is a real measurement, for charting the past.
 *   'all'             - everything stored. Diagnostics only.
 */

export const QUALITY = Object.freeze({
  VALID: 'VALID',
  SUSPECT: 'SUSPECT',
  INVALID: 'INVALID',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  COMMUNICATION_ERROR: 'COMMUNICATION_ERROR',
  STALE: 'STALE',
  REPLAY: 'REPLAY',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  MISSING: 'MISSING',
});

const ALL_CODES = new Set(Object.values(QUALITY));

export const POLICY_CODES = Object.freeze({
  valid_only: [QUALITY.VALID],
  include_suspect: [QUALITY.VALID, QUALITY.SUSPECT],
  history: [QUALITY.VALID, QUALITY.SUSPECT, QUALITY.REPLAY, QUALITY.OUT_OF_ORDER],
  all: Object.values(QUALITY),
});

/** Codes a policy admits. Unknown policy falls back to the strictest. */
export function eligibleCodes(policy) {
  return POLICY_CODES[policy] || POLICY_CODES.valid_only;
}

/**
 * SQL predicate for a quality policy.
 * Returns ' AND quality_code = ANY($n)' and pushes the array onto params.
 */
export function qualityPredicate(policy, params, column = 'quality_code') {
  params.push(eligibleCodes(policy));
  return ` AND ${column} = ANY($${params.length})`;
}

/**
 * Normalise whatever a gateway sent into a known code.
 *
 * Accepts the string codes above, and the legacy numeric `quality` field the
 * Phase-1 gateway sent, where 0 meant good. Anything unrecognised becomes
 * SUSPECT rather than VALID: an unknown quality flag is not evidence of a good
 * reading, and silently upgrading it is how bad data became trusted data.
 */
export function normaliseQuality(raw) {
  if (raw == null) return QUALITY.VALID;
  if (typeof raw === 'number' || /^-?\d+$/.test(String(raw))) {
    const n = Number(raw);
    if (n === 0) return QUALITY.VALID;
    if (n === 1) return QUALITY.SUSPECT;
    if (n === 2) return QUALITY.COMMUNICATION_ERROR;
    return QUALITY.SUSPECT;
  }
  const code = String(raw).trim().toUpperCase();
  return ALL_CODES.has(code) ? code : QUALITY.SUSPECT;
}

/** True when a sample in this state may set the latest-value cache / liveness. */
export function drivesCurrentState(code) {
  return code === QUALITY.VALID || code === QUALITY.SUSPECT;
}

/** True when the sample is a real measurement worth persisting in the series. */
export function isStorable(code) {
  return code !== QUALITY.OUT_OF_RANGE && code !== QUALITY.MISSING;
}
