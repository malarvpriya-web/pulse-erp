/**
 * presence.js — today's attendance state, in the vocabulary the dashboards' status dots use.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Manager dashboard paints a coloured dot per team member. Its data came from
 * `/employees`, whose `status` column is the EMPLOYMENT status ('Active',
 * 'Probation', 'Notice') — never an attendance state. `STATUS_META[m.status]`
 * therefore missed on every row and fell through to a default of `present`, so
 * the page showed a green "Present" dot for the entire company every day,
 * asserting attendance that nobody had marked.
 *
 * The fix is a real presence value derived from `attendance_records`, plus an
 * explicit 'unknown' for "no row today". 'unknown' is the important one: the bug
 * was not a wrong colour, it was treating absence of evidence as evidence.
 *
 * Expects a row LEFT JOINed on today's attendance:
 *   ar.status AS att_status, ar.work_mode AS att_work_mode, ar.late_minutes AS att_late_minutes
 */

const ABSENT_STATUSES = ['absent', 'leave', 'on_leave', 'on leave', 'holiday', 'weekoff', 'week_off'];
const WFH_MODES = ['wfh', 'remote', 'home', 'work_from_home'];

export function presenceOf(row) {
  const raw = String(row?.att_status || '').toLowerCase().trim();
  const mode = String(row?.att_work_mode || '').toLowerCase().trim();

  // No attendance row for today at all.
  if (!raw) return 'unknown';

  if (ABSENT_STATUSES.includes(raw)) return 'absent';
  if (WFH_MODES.includes(mode)) return 'wfh';
  if (raw === 'late' || Number(row?.att_late_minutes) > 0) return 'late';
  return 'present';
}

export default presenceOf;
