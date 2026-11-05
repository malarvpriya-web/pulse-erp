/**
 * "Today" for date fixtures, taken from the DATABASE — the clock the server
 * compares against (`CURRENT_DATE`, `created_at::date`, in the session time
 * zone, Asia/Calcutta in dev).
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC calendar date. Between
 * 00:00 and 05:30 IST it is still yesterday, so fixtures built from it are a
 * day off and day-count assertions fail for 5½ hours every night
 * (PAYROLL_DATA_FLOW_AUDIT.md Part 6, T1).
 */

/** The database's current date, 'YYYY-MM-DD'. */
export async function dbToday(pool) {
  const { rows: [r] } = await pool.query('SELECT CURRENT_DATE::text AS d');
  return r.d;
}

/** Calendar arithmetic on a 'YYYY-MM-DD' string; independent of the process time zone. */
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
