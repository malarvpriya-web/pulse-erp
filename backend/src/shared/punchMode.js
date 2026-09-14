/**
 * punchMode.js — who is allowed to punch attendance from inside the app, and
 * what proof they must supply.
 *
 * The rule is per-employee and keyed on `employees.is_field_employee`:
 *
 *   FIELD staff (is_field_employee = TRUE)
 *     Punch from the app with the CAMERA: a selfie plus GPS coordinates. They
 *     work from customer sites, so the shift window and the geo-fence never
 *     applied to them (see 20260707000002_add_is_field_employee.js) and the
 *     face-match gate does not either — the geotagged selfie is the proof of
 *     presence instead.
 *
 *   EVERYONE ELSE (the default)
 *     Do NOT punch from the app at all. Their attendance arrives from the
 *     office face / biometric terminal, which writes attendance_records through
 *     the device sync path (hr/biometric.routes.js), not through /clock.
 *
 * Both surfaces that accept a self punch — POST /attendance/clock and the
 * offline replay POST /attendance/offline/sync — go through `assertCanSelfPunch`
 * so the offline queue cannot be used to get around the rule.
 */

import pool from '../config/db.js';

export const PUNCH_MODE = {
  CAMERA: 'camera', // field staff: in-app selfie + GPS
  DEVICE: 'device', // everyone else: office face / biometric terminal
};

/**
 * Read the punch-relevant columns for one employee. `department` comes along
 * because the geo-fence lookup in /clock needs it and this saves a round trip.
 * Returns null when the employee row does not exist.
 */
export async function loadPunchProfile(employeeId) {
  if (employeeId == null) return null;
  const { rows } = await pool.query(
    `SELECT id, department, COALESCE(is_field_employee, FALSE) AS is_field_employee
       FROM employees
      WHERE id = $1
      LIMIT 1`,
    [employeeId]
  ).catch(() => ({ rows: [] }));
  if (!rows.length) return null;
  return {
    employee_id: rows[0].id,
    department: rows[0].department || null,
    is_field_employee: rows[0].is_field_employee === true,
  };
}

/** Describe the punch mode for a profile (or a missing profile). */
export function describePunchMode(profile) {
  if (!profile) {
    return {
      mode: PUNCH_MODE.DEVICE,
      is_field_employee: false,
      can_punch_in_app: false,
      selfie_required: false,
      location_required: false,
      reason: 'employee_not_found',
      message: 'No employee record found for this login. Ask HR to link your account.',
    };
  }
  if (profile.is_field_employee) {
    return {
      mode: PUNCH_MODE.CAMERA,
      is_field_employee: true,
      can_punch_in_app: true,
      selfie_required: true,
      location_required: true,
      reason: null,
      message: null,
    };
  }
  return {
    mode: PUNCH_MODE.DEVICE,
    is_field_employee: false,
    can_punch_in_app: false,
    selfie_required: false,
    location_required: false,
    reason: 'device_only',
    message:
      'In-app punching is for field employees only. Record your attendance at the office face / biometric device.',
  };
}

/**
 * Gate a self punch. Returns null when it may proceed, or `{ status, body }`
 * to send back verbatim.
 *
 * `action` is 'in' | 'out'. The selfie + GPS proof is demanded on clock-IN
 * only: attendance_records carries a single selfie_url column, so a clock-out
 * selfie would overwrite the arrival proof rather than add to it.
 */
export function assertCanSelfPunch(profile, { action = 'in', selfie_url, location } = {}) {
  const desc = describePunchMode(profile);

  if (!desc.can_punch_in_app) {
    return {
      status: 403,
      body: {
        error: desc.reason === 'employee_not_found' ? 'employee_not_found' : 'in_app_punch_not_allowed',
        mode: desc.mode,
        message: desc.message,
      },
    };
  }

  if (action === 'in' && desc.selfie_required && !selfie_url) {
    return {
      status: 400,
      body: {
        error: 'selfie_required',
        mode: desc.mode,
        message: 'A camera selfie is required to clock in. Allow camera access and capture your photo.',
      },
    };
  }

  if (action === 'in' && desc.location_required && !location) {
    return {
      status: 403,
      body: {
        error: 'location_required',
        mode: desc.mode,
        message: 'Your GPS location is required to clock in. Enable location access and try again.',
      },
    };
  }

  return null;
}
