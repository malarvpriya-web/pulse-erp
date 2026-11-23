/**
 * Attendance & punctuality for a performance review (§278.3, owner 2026-11-19:
 * "each employee's attendance, i.e. coming punctual on time, also should be
 * considered in performance").
 *
 * For a date range (the review cycle) it counts the days the employee was
 * present, absent, on time and late (in three bands), early exits and the
 * late-coming penalty days, and gives the DEFAULT punctuality rating from the
 * company's table (Settings → Punctuality rating; owner 2026-11-19: "the
 * default — if they are this much, then the rating is this"):
 *
 *   punctuality % = on-time days ÷ days present
 *   rating        = the first band whose min_pct the % reaches
 *                   (default ≥95 % → 5, ≥90 → 4, ≥80 → 3, ≥70 → 2, else 1)
 *
 * "On time" = not marked Late (the shift's grace minutes are already allowed
 * for when Late is marked).
 *
 * Leave rating (§278.5, owner: "like this, from leave also performance should
 * be given a rating automatically"): days off in the period = approved leave
 * (weekly offs not counted, half-day leave = 0.5) + absent days; the rating is
 * the first band whose max_days it does not exceed (default ≤6 → 5, ≤12 → 4,
 * ≤18 → 3, ≤24 → 2, more → 1). Settings → Leave rating.
 * Approved leave, holidays and weekly offs are not counted either way.
 * The score is shown to the manager and HR on the review and saved with the
 * manager's review; it does not change the ratings by itself.
 */
import pool from '../config/db.js';
import { computePenalties } from './attendancePenalties.js';
import { getAttendanceSettingsRow } from './attendanceRules.js';
import { getWeekendDays } from './weekend.js';

export const DEFAULT_LEAVE_BANDS = [
  { max_days: 6, rating: 5 }, { max_days: 12, rating: 4 }, { max_days: 18, rating: 3 },
  { max_days: 24, rating: 2 }, { max_days: null, rating: 1 },
];

/** Rating for days off from a band table ("at most max_days"; null = more than that). */
export function leaveRatingFor(days, bands = DEFAULT_LEAVE_BANDS) {
  const list = bands?.length ? bands : DEFAULT_LEAVE_BANDS;
  const capped = list.filter((b) => b.max_days != null).sort((a, b) => a.max_days - b.max_days);
  const hit = capped.find((b) => days <= Number(b.max_days));
  return (hit || list.find((b) => b.max_days == null) || { rating: 1 }).rating;
}

export const DEFAULT_PUNCTUALITY_BANDS = [
  { min_pct: 95, rating: 5 }, { min_pct: 90, rating: 4 }, { min_pct: 80, rating: 3 },
  { min_pct: 70, rating: 2 }, { min_pct: 0, rating: 1 },
];

/** Rating for a punctuality % from a band table (highest min_pct first). */
export function ratingFor(pct, bands = DEFAULT_PUNCTUALITY_BANDS) {
  if (pct == null) return null;
  const sorted = [...(bands?.length ? bands : DEFAULT_PUNCTUALITY_BANDS)].sort((a, b) => b.min_pct - a.min_pct);
  return (sorted.find((b) => pct >= Number(b.min_pct)) || sorted[sorted.length - 1]).rating;
}

export async function punctualityFor(employeeId, from, to, companyId, db = pool) {
  const { rows: [r] } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE LOWER(status) IN ('present','late','wfh'))                     AS present_days,
      COUNT(*) FILTER (WHERE LOWER(status) = 'half_day')                                    AS half_days,
      COUNT(*) FILTER (WHERE LOWER(status) = 'absent')                                      AS absent_days,
      COUNT(*) FILTER (WHERE LOWER(status) IN ('present','wfh'))                            AS on_time,
      COUNT(*) FILTER (WHERE LOWER(status) = 'late' AND COALESCE(late_minutes, 0) <= 15)   AS late_upto_15,
      COUNT(*) FILTER (WHERE LOWER(status) = 'late' AND late_minutes BETWEEN 16 AND 30)    AS late_15_30,
      COUNT(*) FILTER (WHERE LOWER(status) = 'late' AND late_minutes > 30)                 AS late_over_30,
      COUNT(*) FILTER (WHERE COALESCE(early_leave_minutes, 0) > 0)                          AS early_exits
      FROM attendance_records
     WHERE employee_id = $1 AND attendance_date BETWEEN $2::date AND $3::date AND deleted_at IS NULL`,
  [employeeId, from, to]);
  const n = (k) => Number(r?.[k] || 0);
  const present = n('present_days') + n('half_days') * 0.5;
  const absent = n('absent_days') + n('half_days') * 0.5;
  const punctuality = n('present_days') > 0 ? n('on_time') / n('present_days') : null;
  const attendance = present + absent > 0 ? present / (present + absent) : null;
  const settings = await getAttendanceSettingsRow(companyId, db);
  const bands = Array.isArray(settings?.punctuality_bands) && settings.punctuality_bands.length
    ? settings.punctuality_bands : DEFAULT_PUNCTUALITY_BANDS;
  const punctualityPct = punctuality == null ? null : Math.round(punctuality * 100);
  const score = ratingFor(punctualityPct, bands);
  const pen = (await computePenalties(companyId, [Number(employeeId)], from, to, db)).get(Number(employeeId));
  const weekend = (await getWeekendDays(companyId)).map((d) => String(d).toLowerCase());
  const { rows: [lv] } = await db.query(`
    SELECT COALESCE(SUM(CASE WHEN la.half_day THEN 0.5 ELSE 1 END), 0) AS days
      FROM leave_applications la
      CROSS JOIN LATERAL generate_series(GREATEST(la.start_date, $2::date), LEAST(la.end_date, $3::date), INTERVAL '1 day') d
     WHERE la.employee_id = $1 AND LOWER(la.status) = 'approved'
       AND la.start_date <= $3::date AND la.end_date >= $2::date
       AND NOT (LOWER(TRIM(TO_CHAR(d, 'day'))) = ANY($4::text[]))`, [employeeId, from, to, weekend]).catch(() => ({ rows: [{ days: 0 }] }));
  const leaveDays = Number(lv?.days || 0);
  const daysOff = leaveDays + n('absent_days') + n('half_days') * 0.5;
  const leaveBands = Array.isArray(settings?.leave_rating_bands) && settings.leave_rating_bands.length
    ? settings.leave_rating_bands : DEFAULT_LEAVE_BANDS;
  return {
    from, to,
    present_days: n('present_days'), half_days: n('half_days'), absent_days: n('absent_days'),
    on_time: n('on_time'), late_upto_15: n('late_upto_15'), late_15_30: n('late_15_30'), late_over_30: n('late_over_30'),
    early_exits: n('early_exits'),
    punctuality_pct: punctualityPct,
    attendance_pct: attendance == null ? null : Math.round(attendance * 100),
    penalty_days: pen?.days || 0,
    score,
    bands,
    leave_days: leaveDays,
    days_off: daysOff,
    leave_rating: leaveRatingFor(daysOff, leaveBands),
    leave_bands: leaveBands,
  };
}
