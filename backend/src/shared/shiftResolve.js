/**
 * shiftResolve.js — which shift an employee works on a date, and whether an
 * arrival time is late against it.
 *
 * Lived inside attendance.routes.js, so only the in-app punch (/clock) could
 * work out lateness. The punch machine sync (hr/biometric.routes.js), which is
 * how every office employee records attendance, wrote 'present' with no late
 * minutes at all — the Late Arrivals report could never show a machine punch.
 * One definition now, imported by both. §278.
 */
import pool from '../config/db.js';

// ── parseTimeToMins: "HH:MM", "HH:MM:SS", "H:MM AM/PM" → minutes since midnight
export function parseTimeToMins(str) {
  if (!str) return null;
  const ampm = String(str).match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  const hr24  = String(str).match(/^(\d{1,2}):(\d{2})/);
  let h, m;
  if (ampm) {
    h = parseInt(ampm[1]); m = parseInt(ampm[2]);
    const ap = ampm[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
  } else if (hr24) {
    h = parseInt(hr24[1]); m = parseInt(hr24[2]);
  } else return null;
  return h * 60 + m;
}

// ── calcLateAndStatus: handles night-shifts crossing midnight (e.g. 21:00–06:00)
export function calcLateAndStatus(arrivalTimeStr, shift, fallbackGrace = 10) {
  const arrivalMins  = parseTimeToMins(arrivalTimeStr);
  if (arrivalMins === null) return { lateMinutes: 0, derivedStatus: 'present' };
  const [sh, sm]      = shift.start_time.split(':').map(Number);
  const scheduledMins = sh * 60 + sm;
  let   arrival       = arrivalMins;
  // Night-shift: start ≥ 18:00 and employee arrives before 06:00 (crossed midnight)
  if (shift.is_night_shift && scheduledMins >= 18 * 60 && arrival < 6 * 60) {
    arrival += 1440;
  }
  const lateMinutes  = Math.max(0, arrival - scheduledMins);
  const grace        = parseInt(shift.grace_minutes ?? fallbackGrace);
  return { lateMinutes, derivedStatus: lateMinutes > grace ? 'late' : 'present' };
}

// ── resolveEmployeeShift: 4-level priority chain
// Returns { shift, source }. shift = { id, name, start_time, end_time,
//   grace_minutes, is_night_shift, half_day_hours } or null.
// Priority: date_override > assignment > dept_rotation > employee_default
export async function resolveEmployeeShift(employee_id, date) {
  // 1 — single-date override
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.start_time, s.end_time,
             s.grace_minutes, s.is_night_shift, s.half_day_hours
        FROM hr_shift_date_overrides o
        JOIN hr_shifts s ON s.id = o.shift_id
       WHERE o.employee_id = $1 AND o.override_date = $2
         AND o.is_active = TRUE
         AND (s.deleted_at IS NULL OR s.deleted_at > NOW())
       LIMIT 1
    `, [employee_id, date]);
    if (r.rows.length) return { shift: r.rows[0], source: 'date_override' };
  } catch { /* table may not exist yet */ }

  // 2 — direct permanent assignment
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.start_time, s.end_time,
             s.grace_minutes, s.is_night_shift, s.half_day_hours
        FROM hr_shift_assignments sa
        JOIN hr_shifts s ON s.id = sa.shift_id
       WHERE sa.employee_id = $1 AND sa.is_active = TRUE
         AND (sa.effective_from IS NULL OR sa.effective_from <= $2)
         AND (s.deleted_at IS NULL OR s.deleted_at > NOW())
       ORDER BY sa.effective_from DESC NULLS LAST LIMIT 1
    `, [employee_id, date]);
    if (r.rows.length) return { shift: r.rows[0], source: 'assignment' };
  } catch { /* non-blocking */ }

  // 3 — department rotation (2-week or 4-week cycle from effective_from)
  try {
    const empRow = await pool.query(
      `SELECT department FROM employees WHERE id = $1 LIMIT 1`, [employee_id]
    );
    const dept = empRow.rows[0]?.department;
    if (dept) {
      const rot = await pool.query(`
        SELECT r.effective_from,
               s1.id AS w1_id, s1.name AS w1_name,
               s1.start_time AS w1_start, s1.end_time AS w1_end,
               s1.grace_minutes AS w1_grace, s1.is_night_shift AS w1_night,
               s1.half_day_hours AS w1_half,
               s2.id AS w2_id, s2.name AS w2_name,
               s2.start_time AS w2_start, s2.end_time AS w2_end,
               s2.grace_minutes AS w2_grace, s2.is_night_shift AS w2_night,
               s2.half_day_hours AS w2_half,
               s3.id AS w3_id, s3.name AS w3_name,
               s3.start_time AS w3_start, s3.end_time AS w3_end,
               s3.grace_minutes AS w3_grace, s3.is_night_shift AS w3_night,
               s3.half_day_hours AS w3_half,
               s4.id AS w4_id, s4.name AS w4_name,
               s4.start_time AS w4_start, s4.end_time AS w4_end,
               s4.grace_minutes AS w4_grace, s4.is_night_shift AS w4_night,
               s4.half_day_hours AS w4_half
          FROM hr_shift_rotations r
          JOIN hr_shifts s1 ON s1.id = r.week_1_shift_id
          JOIN hr_shifts s2 ON s2.id = r.week_2_shift_id
          LEFT JOIN hr_shifts s3 ON s3.id = r.week_3_shift_id
          LEFT JOIN hr_shifts s4 ON s4.id = r.week_4_shift_id
         WHERE r.team = $1 AND r.is_active = TRUE
           AND (r.effective_from IS NULL OR r.effective_from <= $2)
           AND (s1.deleted_at IS NULL OR s1.deleted_at > NOW())
           AND (s2.deleted_at IS NULL OR s2.deleted_at > NOW())
         ORDER BY r.effective_from DESC NULLS LAST LIMIT 1
      `, [dept, date]);
      if (rot.rows.length) {
        const row    = rot.rows[0];
        const refMs  = row.effective_from
          ? new Date(row.effective_from).setHours(0, 0, 0, 0)
          : 0;
        const weeks  = Math.floor((new Date(date).setHours(0, 0, 0, 0) - refMs) / (7 * 86400000));
        // 4-week cycle if week_3 and week_4 shifts are configured, else 2-week
        const is4Week = row.w3_id && row.w4_id;
        const cycle   = is4Week ? 4 : 2;
        const weekIdx = ((weeks % cycle) + cycle) % cycle; // 0-indexed, always positive
        const weekShifts = [
          row.w1_id ? { id: row.w1_id, name: row.w1_name, start_time: row.w1_start, end_time: row.w1_end, grace_minutes: row.w1_grace, is_night_shift: row.w1_night, half_day_hours: row.w1_half } : null,
          row.w2_id ? { id: row.w2_id, name: row.w2_name, start_time: row.w2_start, end_time: row.w2_end, grace_minutes: row.w2_grace, is_night_shift: row.w2_night, half_day_hours: row.w2_half } : null,
          row.w3_id ? { id: row.w3_id, name: row.w3_name, start_time: row.w3_start, end_time: row.w3_end, grace_minutes: row.w3_grace, is_night_shift: row.w3_night, half_day_hours: row.w3_half } : null,
          row.w4_id ? { id: row.w4_id, name: row.w4_name, start_time: row.w4_start, end_time: row.w4_end, grace_minutes: row.w4_grace, is_night_shift: row.w4_night, half_day_hours: row.w4_half } : null,
        ];
        const s = weekShifts[weekIdx] || weekShifts[0];
        if (s) return { shift: s, source: 'rotation' };
      }
    }
  } catch { /* non-blocking */ }

  // 4 — employee default shift
  try {
    const r = await pool.query(`
      SELECT s.id, s.name, s.start_time, s.end_time,
             s.grace_minutes, s.is_night_shift, s.half_day_hours
        FROM employees e
        JOIN hr_shifts s ON s.id = e.default_shift_id
       WHERE e.id = $1 AND e.default_shift_id IS NOT NULL
         AND (s.deleted_at IS NULL OR s.deleted_at > NOW())
       LIMIT 1
    `, [employee_id]);
    if (r.rows.length) return { shift: r.rows[0], source: 'employee_default' };
  } catch { /* non-blocking */ }

  return { shift: null, source: 'none' };
}

