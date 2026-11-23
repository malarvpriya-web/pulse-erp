// backend/src/modules/hr/biometric.routes.js
import express from 'express';
import net from 'net';
import { createRequire } from 'module';
import pool from '../../config/db.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { requirePermission, permissionFor, permissionColumn } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import { CURRENT_STATUSES, sqlList } from '../../shared/employeeStatus.js';
import { LEAVE_APPROVED } from '../../shared/statusSets.js';
import { getWeekendDays, dayIsWeekend } from '../../shared/weekend.js';
import { getFullDayHours, isPeriodFrozen, recordOvertime, notifyLateArrival, getAttendanceSwitches } from '../../shared/attendanceRules.js';
import { autoGrantHolidayCompOff } from '../../shared/compOff.js';
import { resolveEmployeeShift, calcLateAndStatus, parseTimeToMins } from '../../shared/shiftResolve.js';
import { blank, listPage, dateRange, positiveIntOrNull } from './listQuery.js';

const router = express.Router();
const require = createRequire(import.meta.url);

/**
 * Authorization.
 *
 * server.js mounts this router behind `verifyToken` for the /biometric,
 * /gate-passes and /visitors prefixes, and that was the ONLY gate: not one of
 * the 20 routes below called requirePermission, so any authenticated user —
 * including a plain `employee` — could read and write gate passes and visitor
 * records, and reconfigure or delete biometric hardware.
 *
 * The module key per route follows the screen that consumes it, because
 * requirePermission FAILS CLOSED on a missing row and the wrong key 403s the
 * page's own users:
 *
 *   `attendance` — devices and punch logs. Consumed by DeviceManagement
 *     (Attendance → Configuration → Settings → Devices) as well as the HR page,
 *     and every role that reaches either holds an attendance row. Gating these
 *     on `hr` instead would 403 manager/department_head, who hold attendance but
 *     no hr grant at all.
 *
 *   `hr` — gate passes, visitors, and the employee↔device mapping. Consumed only
 *     by BiometricAccess, which lives in the HR menu section (hr, hr_manager,
 *     hr_exec, payroll_admin, admin, super_admin).
 *
 * ── READ vs WRITE on the attendance side ───────────────────────────────────
 *
 * ⚠⚠ Every attendance route here was originally gated on `attendanceAdmin`
 * (= attendance:EDIT), including the GETs, because this file defined no view
 * gate at all — `attendanceAdd`/`attendanceAdmin`/`attendanceDelete` were the
 * only three, and the reads took the closest one to hand. The effect was that
 * `payroll_admin` (attendance can_view=true, can_edit=false) was refused every
 * read on a page the HR menu lists it as a user of — contradicting the note
 * below, which says in so many words that it "gets a read-only page". It had no
 * page at all. `integration.biometricAuthz.test.js` asserts the documented
 * intent and was correct to fail.
 *
 * The five GETs that are pure reads of OUR OWN tables now take `biometricRead`
 * — `hr:view` OR `attendance:edit`, for the reason set out on
 * requireAnyPermission below. Each was confirmed tenant-scoped FIRST: loosening
 * a gate on an unscoped read widens who can reach another tenant's rows, so the
 * scope predicate is a precondition for the looser gate, not a separate
 * concern. (That check is what turned up the missing filter on
 * `/devices/:id/users`, fixed below.)
 *
 * `GET /biometric/devices/:id/users` deliberately stays on `attendanceAdmin`.
 * It is not a read of our data: it opens a TCP socket to the device's own IP and
 * asks the hardware to enumerate its enrolled fingerprints. No page calls it
 * (grep the frontend — nothing does); it belongs to the enrolment/mapping
 * workflow next to `POST /biometric/employees/map`, which is `hr:edit`. A
 * read-only dashboard user has no reason to dial a device, and a 10-second
 * connect timeout per call is not something to hand to a wider audience.
 *
 * Checked against the live matrix rather than assumed. Two consequences worth
 * knowing, both intended:
 *   · `payroll_admin` holds view only on both modules, so it gets a read-only
 *     page. Writes return 403, which BiometricAccess renders as an error toast
 *     (it reads err.response.data.message) — not a silent failure.
 *   · the gate-pass approve route takes `hr:edit`, NOT `hr:approve`. The `hr`
 *     role — the page's primary user — has can_approve=false on hr, so an
 *     approve gate would lock gate-pass approval away from the team that owns
 *     it. Narrowing approval to hr_manager is a policy change, not a security
 *     fix; left for whoever wants to make that call deliberately.
 */
const attendanceAdd    = requirePermission('attendance', 'add');
const attendanceAdmin  = requirePermission('attendance', 'edit');
const attendanceDelete = requirePermission('attendance', 'delete');
const hrView           = requirePermission('hr', 'view');
const hrEdit           = requirePermission('hr', 'edit');

/**
 * requireAnyPermission([[module, action], ...]) — allow if ANY grant holds.
 *
 * ⚠⚠ Why the biometric READS need this, and why `attendance:view` is the WRONG
 * answer even though the reads are reads. Measured, not assumed:
 *
 *   role             attendance v/a/e/d   hr v/a/e/d
 *   employee         Y/-/-/-              (no row)
 *   payroll_admin    Y/-/-/-              Y/-/-/-
 *
 * `employee` and `payroll_admin` hold IDENTICAL attendance permissions, so no
 * attendance action can separate them. Gating the device reads on
 * `attendance:view` — the obvious reading of "a read needs view" — hands every
 * employee the device inventory: names, IP addresses and ports. The two
 * audiences are only separable through `hr`:
 *
 *   · BiometricAccess (HR → Gate Pass & Visitors) — hr, hr_manager, hr_exec,
 *     payroll_admin, admin, super_admin. All hold `hr:view`.
 *   · DeviceManagement (Attendance → Configuration → Devices) — manager and
 *     department_head, which hold NO hr row at all but do hold `attendance:edit`.
 *
 * So the rule is "an HR-page user, OR an attendance administrator" — a union of
 * two grants, not one looser grant. `employee` (attendance view only, no hr) and
 * `sales_exec` (neither) fall outside it.
 *
 * Fails CLOSED: an unmatched or unconfigured grant denies, exactly like
 * requirePermission. It reuses `permissionFor`, so a user-level override still
 * wins and the per-request permission cache is shared.
 */
export const requireAnyPermission = (grants) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    for (const [module, action] of grants) {
      const col = permissionColumn(action);
      if (!col) return res.status(400).json({ error: `Unknown permission action: ${action}` });
      const perm = await permissionFor(req, module);
      if (perm?.[col]) return next();
    }
    return res.status(403).json({
      error: 'Forbidden',
      code: 'PERMISSION_DENIED',
      // Named, so a denial is debuggable without opening this file.
      accepts: grants.map(([m, a]) => `${m}:${a}`),
      message: 'You do not have permission to perform this action.',
    });
  } catch (err) {
    console.error('[requireAnyPermission]', err.message);
    return res.status(500).json({ error: 'Permission check failed' });
  }
};

/**
 * The read tier for biometric data: devices, device stats, punch logs and the
 * dashboard. See requireAnyPermission above for why it is a union and not
 * `attendance:view`.
 */
const biometricRead = requireAnyPermission([['hr', 'view'], ['attendance', 'edit']]);

// ── node-zklib SDK (installed: npm install node-zklib) ─────────────────────
let ZKLib;
try {
  ZKLib = require('node-zklib');
} catch {
  console.warn('[biometric] node-zklib not found — fingerprint sync disabled. Run: npm install node-zklib');
}

/**
 * The hardware boundary, as one replaceable object.
 *
 * Everything that talks to a device goes through `deviceDriver.read()`, which
 * returns the raw logs and users the device handed over. Everything after that
 * — mapping device users to employees, de-duplication, attendance — is our
 * code and is what the tests exercise, by swapping `read` for a fake that
 * returns a fixed payload. That proves the PROCESSING; it proves nothing about
 * any physical device, and the tests say so. §197.
 */
export const deviceDriver = {
  available: () => !!ZKLib,
  async read(ipAddress, port) {
    const zk = new ZKLib(ipAddress, parseInt(port) || 4370, 10000, 4000);
    try {
      await zk.createSocket();
      const users = await zk.getUsers().catch(() => ({ data: [] }));
      const att   = await zk.getAttendances();
      return { users: users.data || [], logs: att.data || [] };
    } finally {
      try { await zk.disconnect(); } catch { /* ignore */ }
    }
  },
};

/** node-zklib rejects with a ZKError that has no `message`; dig one out. */
function deviceErrorText(err) {
  if (!err) return 'unknown device error';
  if (typeof err.toast === 'function') { try { return err.toast(); } catch { /* fall through */ } }
  return err.message || err.err?.message || String(err);
}

// The caller's tenant. companyOf() rather than `req.scope` alone: it carries
// the user-row fallback, so a scope-less request can never read as global.
const cid = (req) => companyOf(req);

/**
 * Quick TCP reachability test — no ZKTeco protocol, just raw socket.
 * Returns { connected: true, latency_ms } or { connected: false, error }.
 * Used both standalone (test button) and as a pre-flight before SDK sync.
 */
async function testZKDevice(ipAddress, port = 4370) {
  return new Promise((resolve) => {
    const socket    = new net.Socket();
    const startTime = Date.now();
    let resolved    = false;
    const done = (result) => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(result); }
    };
    socket.setTimeout(5000);
    socket.connect(parseInt(port) || 4370, ipAddress, () =>
      done({ connected: true, latency_ms: Date.now() - startTime })
    );
    socket.on('error',   (err) => done({ connected: false, error: err.message }));
    socket.on('timeout', ()    => done({ connected: false, error: 'Connection timed out (5s)' }));
  });
}

/* ─── attendance-day rules: timezone, shift window, late grace ──────────────
 *
 * Read from the same rows Attendance Settings writes: the company row when
 * there is one, else the global row (company_id IS NULL) — the lookup
 * shared/weekend.js uses. The dashboard hardcoded `hour > 9` as late (which is
 * 10:00, not the configured 09:00 + 10 min grace) and `hour < 17` as early,
 * against a configured 18:00 end. */
const DEFAULT_TZ = 'Asia/Kolkata';

export async function dayRules(companyId, db = pool) {
  const out = { tz: DEFAULT_TZ, workStart: '09:00:00', workEnd: '18:00:00', graceMinutes: 10 };  // no late policy → 10 min, the in-app punch's default (§278)
  try {
    const { rows: [s] } = await db.query(
      `SELECT timezone, work_start_time::text AS ws, work_end_time::text AS we
         FROM attendance_general_settings
        WHERE ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
        ORDER BY (company_id IS NULL), id LIMIT 1`,
      [companyId]
    );
    if (s?.ws) out.workStart = s.ws;
    if (s?.we) out.workEnd = s.we;
    if (s?.timezone) {
      // An unknown zone name would make every AT TIME ZONE below raise.
      const ok = await db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [s.timezone]);
      if (ok.rows.length) out.tz = s.timezone;
    }
    const { rows: [p] } = await db.query(
      `SELECT rules->>'grace_minutes' AS g FROM attendance_policies
        WHERE policy_type = 'late' AND is_active = true
          AND ($1::int IS NULL OR company_id = $1 OR company_id IS NULL)
        ORDER BY company_id DESC NULLS LAST LIMIT 1`,
      [companyId]
    );
    const g = parseInt(p?.g, 10);
    if (Number.isFinite(g) && g >= 0) out.graceMinutes = g;
  } catch { /* defaults */ }
  return out;
}

/* ─── punch ingestion: the one path from a punch to attendance ──────────────
 *
 * Both the device sync and the CSV import go through applyPunch(). Before,
 * the import wrote biometric_logs ONLY — an imported punch never reached
 * attendance_records, which is what the attendance reports and payroll read —
 * while the sync wrote attendance through `.catch(() => {})` on every
 * statement, counted the punch "processed" whether the write landed or not,
 * and dated it with `toISOString()` (UTC), so a punch between 00:00 and 05:30
 * IST landed on the previous day.
 *
 * Rules, in order:
 *   · the log row is written once — the unique indexes from migration
 *     20261028000012 make a repeated punch a `duplicate`, not a second row;
 *   · an unmatched punch is kept (it can be mapped later) and goes no further;
 *   · a month payroll has frozen (shared isPeriodFrozen) is `frozen`, and a
 *     day whose record is frozen or soft-deleted is `locked`: the punch is
 *     logged, processed=false, and attendance is NOT touched;
 *   · otherwise the day's record MERGES the punch — earliest in, latest out —
 *     and status is promoted from 'absent' only (the §103 contract: leave,
 *     holiday and every other status are never overwritten);
 *   · hours are recomputed only when out > in, with the shared OT threshold.
 */
const PUNCH_IN  = ['in', 'checkin', 'clockin', 'entry', '0', '3', '4'];
const PUNCH_OUT = ['out', 'checkout', 'clockout', 'exit', '1', '2', '5'];

export function normalisePunchType(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (PUNCH_IN.includes(s))  return 'in';
  if (PUNCH_OUT.includes(s)) return 'out';
  return null;
}

async function applyPunch(client, p, ctx) {
  const { employeeId, employeeCompanyId, deviceId, punchAt, punchType, raw } = p;
  const ins = await client.query(
    `INSERT INTO biometric_logs
       (employee_id, device_id, punch_time, punch_type, raw_data, company_id, processed)
     VALUES ($1, $2, $3, $4, $5, $6, false)
     ON CONFLICT DO NOTHING
     RETURNING id,
               to_char(punch_time AT TIME ZONE $7, 'YYYY-MM-DD') AS day,
               to_char(punch_time AT TIME ZONE $7, 'HH24:MI:SS') AS t`,
    [employeeId, deviceId ?? null, punchAt, punchType, JSON.stringify(raw ?? {}),
     employeeCompanyId ?? ctx.companyId, ctx.tz]
  );
  if (!ins.rows.length) return 'duplicate';
  if (employeeId == null) return 'unmatched';

  const { id: logId, day, t } = ins.rows[0];
  const companyId = employeeCompanyId ?? ctx.companyId;

  const monthKey = `${companyId}:${day.slice(0, 7)}`;
  if (!ctx.frozenMonths.has(monthKey)) {
    ctx.frozenMonths.set(monthKey, await isPeriodFrozen(day, companyId, client));
  }
  if (ctx.frozenMonths.get(monthKey)) return 'frozen';

  const { rows: [existing] } = await client.query(
    `SELECT id, is_frozen, deleted_at FROM attendance_records
      WHERE employee_id = $1 AND attendance_date = $2 FOR UPDATE`,
    [employeeId, day]
  );
  if (existing && (existing.is_frozen || existing.deleted_at)) return 'locked';

  if (punchType === 'in') {
    await client.query(
      `INSERT INTO attendance_records
         (employee_id, attendance_date, check_in_time, status, company_id, source)
       VALUES ($1, $2, $3::time, 'present', $4, 'biometric')
       ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
         check_in_time = CASE
           WHEN attendance_records.check_in_time IS NULL OR $3::time < attendance_records.check_in_time
           THEN $3::time ELSE attendance_records.check_in_time END,
         status = CASE WHEN LOWER(attendance_records.status) = 'absent'
                       THEN 'present' ELSE attendance_records.status END,
         updated_at = NOW()`,
      [employeeId, day, t, companyId]
    );
  } else {
    await client.query(
      `INSERT INTO attendance_records
         (employee_id, attendance_date, check_out_time, status, company_id, source)
       VALUES ($1, $2, $3::time, 'present', $4, 'biometric')
       ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
         check_out_time = CASE
           WHEN attendance_records.check_out_time IS NULL OR $3::time > attendance_records.check_out_time
           THEN $3::time ELSE attendance_records.check_out_time END,
         status = CASE WHEN LOWER(attendance_records.status) = 'absent'
                       THEN 'present' ELSE attendance_records.status END,
         updated_at = NOW()`,
      [employeeId, day, t, companyId]
    );
  }

  if (!ctx.fullDayHours.has(companyId)) {
    ctx.fullDayHours.set(companyId, await getFullDayHours(companyId, client));
  }
  await client.query(
    `UPDATE attendance_records
        SET total_hours = ROUND((EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600)::numeric, 2),
            ot_hours    = ROUND(GREATEST(0, EXTRACT(EPOCH FROM (check_out_time - check_in_time)) / 3600 - $3)::numeric, 2)
      WHERE employee_id = $1 AND attendance_date = $2
        AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL
        AND check_out_time > check_in_time`,
    [employeeId, day, ctx.fullDayHours.get(companyId)]
  );
  // Late against the shift the employee actually works that day (§278 — the
  // machine path never set late_minutes, so Late Arrivals could not show a
  // single machine punch). Only the first check-in of the day decides it.
  if (punchType === 'in') {
    const { rows: [rec] } = await client.query(
      `SELECT check_in_time::text AS cin, status, late_minutes FROM attendance_records
        WHERE employee_id = $1 AND attendance_date = $2`, [employeeId, day]);
    if (rec?.cin && ['present', 'late'].includes(String(rec.status).toLowerCase())) {
      const { shift } = await resolveEmployeeShift(employeeId, day);
      const sh = shift || { start_time: ctx.workStart || '09:00:00', grace_minutes: ctx.graceMinutes ?? 0 };
      const { lateMinutes, derivedStatus } = calcLateAndStatus(rec.cin, sh, ctx.graceMinutes ?? 10);
      await client.query(
        `UPDATE attendance_records SET late_minutes = $3, status = $4 WHERE employee_id = $1 AND attendance_date = $2`,
        [employeeId, day, lateMinutes, derivedStatus]);
      if (derivedStatus === 'late' && String(rec.status).toLowerCase() !== 'late' && day === ctx.today) {
        notifyLateArrival(employeeId, lateMinutes, 'punched in').catch(() => {});
      }
    }
  }
  // Leaving early, against the shift end (§278.3). Only the in-app clock-out
  // ever set early_leave_minutes, so the "leaving early" penalty rule and My
  // Attendance could not see a machine punch. The latest punch-out decides it.
  // Night shifts that end after midnight are skipped: their punch-out falls on
  // the next calendar day's row.
  if (punchType !== 'in') {
    const { rows: [rec] } = await client.query(
      `SELECT check_out_time::text AS cout FROM attendance_records WHERE employee_id = $1 AND attendance_date = $2`,
      [employeeId, day]);
    const { shift } = await resolveEmployeeShift(employeeId, day);
    const end = parseTimeToMins(shift?.end_time || ctx.workEnd || '18:00');
    const start = parseTimeToMins(shift?.start_time || ctx.workStart || '09:00');
    const out = parseTimeToMins(rec?.cout);
    if (out != null && end != null && start != null && !shift?.is_night_shift && end > start) {
      await client.query(
        `UPDATE attendance_records SET early_leave_minutes = $3 WHERE employee_id = $1 AND attendance_date = $2`,
        [employeeId, day, Math.max(0, end - out)]);
    }
  }

  // Overtime request (nothing happens while overtime is switched off).
  const { rows: [h] } = await client.query(
    `SELECT ot_hours FROM attendance_records WHERE employee_id = $1 AND attendance_date = $2`, [employeeId, day]);
  if (Number(h?.ot_hours) >= 0.5) {
    await recordOvertime(client, { companyId, employeeId, date: day, otHours: Number(h.ot_hours) });
  }

  // Comp off for a full day on a holiday (§278.4) — production staff punch on
  // the machine, and this path never granted it. Only when comp off is on in
  // Settings and the employee is chosen for it.
  if (punchType !== 'in') {
    const { rows: [t] } = await client.query(
      `SELECT total_hours FROM attendance_records WHERE employee_id = $1 AND attendance_date = $2`, [employeeId, day]);
    // Its own connection: a failure here must not abort the punch's transaction.
    const { compOffEnabled } = await getAttendanceSwitches(companyId);
    await autoGrantHolidayCompOff(pool, {
      employeeId, companyId, date: day, hours: Number(t?.total_hours || 0),
      fullDayHours: ctx.fullDayHours.get(companyId), enabled: compOffEnabled,
    }).catch(() => {});
  }

  await client.query(
    'UPDATE biometric_logs SET processed = true, processed_at = NOW() WHERE id = $1', [logId]);
  return 'applied';
}

const newIngestContext = (companyId, tz, rules = {}) => ({
  companyId, tz, frozenMonths: new Map(), fullDayHours: new Map(),
  workStart: rules.workStart, workEnd: rules.workEnd, graceMinutes: rules.graceMinutes,
  today: new Date().toLocaleDateString('en-CA', { timeZone: tz || 'Asia/Kolkata' }),
});

const OUTCOMES = ['applied', 'duplicate', 'unmatched', 'frozen', 'locked'];
const emptyTally = () => Object.fromEntries(OUTCOMES.map(k => [k, 0]));

/**
 * Map a ZKTeco device user to an employee of `companyId`.
 *
 *   1. employees.office_id (the employee code) — most reliable
 *   2. employees.biometric_user_id — set by POST /biometric/employees/map
 *   3. the registered name, ONLY when exactly one current employee has it.
 *      This used to take the first of any number of namesakes, which writes
 *      one person's punches onto another's attendance.
 *
 * ⚠ The company clause was `company_id = X OR company_id IS NULL`, so a
 * null-company employee matched every tenant's device. Scoped strictly now;
 * there are no null-company employees, so nothing that matched before stops.
 */
async function resolveDeviceUser(db, deviceUserId, deviceUserName, companyId) {
  const scope = `($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL`;
  const one = async (sql, value) => {
    const { rows } = await db.query(`SELECT id, company_id FROM employees WHERE ${sql} AND ${scope} LIMIT 2`, [value, companyId]);
    return rows.length === 1 ? rows[0] : null;
  };
  if (deviceUserId) {
    const byCode = await one('LOWER(TRIM(office_id)) = LOWER(TRIM($1))', String(deviceUserId));
    if (byCode) return byCode;
    const byBio = await one('biometric_user_id = $1', String(deviceUserId));
    if (byBio) return byBio;
  }
  if (deviceUserName && String(deviceUserName).trim()) {
    const byName = await one(
      `LOWER(TRIM(COALESCE(name, CONCAT(first_name,' ',COALESCE(last_name,''))))) = LOWER(TRIM($1))
       AND LOWER(status) IN (${sqlList(CURRENT_STATUSES)})`,
      String(deviceUserName));
    if (byName) return byName;
  }
  return null;
}

/* The dev-only startup seeder that inserted five fake machines
 * (192.168.1.101–105) whenever the table was empty was REMOVED in §278: it ran
 * on every import of this module (tests included), so the owner's real device
 * list kept refilling with machines that do not exist. The one real machine is
 * added on Attendance → Punch Machines. */

/* ─── GET /biometric/devices ─────────────────────────────────── */
router.get('/biometric/devices', biometricRead, async (req, res) => {
  try {
    const companyId = cid(req);
    const { rows } = await pool.query(
      `SELECT d.*,
              COUNT(bl.id) AS total_punches_today
       FROM biometric_devices d
       LEFT JOIN biometric_logs bl ON bl.device_id=d.id
         AND DATE(bl.punch_time)=CURRENT_DATE
       WHERE ($1::int IS NULL OR d.company_id = $1)
       GROUP BY d.id ORDER BY d.device_name`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/devices/stats ─── must be before /:id routes
 * `unverified` counts devices whose status no test or sync has ever set
 * (status_checked_at IS NULL) — those are excluded from online/offline/error,
 * which used to count a seeded 'online' as a working device. */
router.get('/biometric/devices/stats', biometricRead, async (req, res) => {
  const companyId = cid(req);
  try {
    const [statusRes, punchRes] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='online'  AND status_checked_at IS NOT NULL) AS online,
           COUNT(*) FILTER (WHERE status='offline' AND status_checked_at IS NOT NULL) AS offline,
           COUNT(*) FILTER (WHERE status='error'   AND status_checked_at IS NOT NULL) AS error_count,
           COUNT(*) FILTER (WHERE status_checked_at IS NULL)                          AS unverified
         FROM biometric_devices
         WHERE ($1::int IS NULL OR company_id = $1)`,
        [companyId]
      ),
      pool.query(
        `SELECT COUNT(*) AS punches_today
         FROM biometric_logs bl
         LEFT JOIN biometric_devices d ON d.id=bl.device_id
         WHERE DATE(bl.punch_time)=CURRENT_DATE
           AND ($1::int IS NULL OR d.company_id = $1)`,
        [companyId]
      ),
    ]);
    const s = statusRes.rows[0];
    res.json({
      online:        parseInt(s.online       || 0),
      offline:       parseInt(s.offline      || 0),
      error:         parseInt(s.error_count  || 0),
      unverified:    parseInt(s.unverified   || 0),
      punches_today: parseInt(punchRes.rows[0]?.punches_today || 0),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── device configuration: only the connection is required ──────
 *
 * Setting up a device needs just its address (§198): the IP (or host name)
 * and port — 4370 by default, the ZKTeco/eSSL standard. Everything else is
 * optional: the name defaults to "Device <ip>", direction to both, type to
 * fingerprint. A name used to be required, and nothing validated the address
 * or port, so a typo saved fine and failed only at the first sync.
 *
 * ⚠ The sync library (node-zklib 1.3.0) cannot send a device comm key, so the
 * device's comm key / communication password must be 0. There is deliberately
 * no comm-key field: storing a secret the sync can never use would read as
 * configured and silently not work. */
const DEVICE_TYPES = ['fingerprint', 'face', 'face+finger', 'card_reader', 'iris'];
const DIRECTIONS   = ['in', 'out', 'both'];
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function deviceAddress(body) {
  const errors = [];
  const ip = String(body.ip_address ?? '').trim();
  if (!ip) errors.push('ip_address is required');
  // A dotted number is an IPv4 address or nothing: '999.1.1.1' is also a
  // syntactically valid host name, and must not be accepted as one.
  else if (/^[\d.]+$/.test(ip) ? !IPV4.test(ip) : !HOSTNAME.test(ip)) {
    errors.push('ip_address must be an IPv4 address (e.g. 192.168.1.50) or a host name');
  }
  const rawPort = blank(body.port);
  const port = rawPort === null ? 4370 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port must be a whole number from 1 to 65535');
  return { errors, ip, port };
}

function normaliseDevice(body = {}) {
  const { errors, ip, port } = deviceAddress(body);
  const direction = blank(body.attendance_direction) ?? 'both';
  if (!DIRECTIONS.includes(direction)) errors.push('attendance_direction must be in, out or both');
  const type = blank(body.device_type) ?? 'fingerprint';
  if (!DEVICE_TYPES.includes(type)) errors.push(`device_type must be one of ${DEVICE_TYPES.join(', ')}`);
  const name = String(blank(body.device_name) ?? (ip ? `Device ${ip}` : '')).trim();
  if (name.length > 150) errors.push('device_name must be 150 characters or fewer');
  if (String(body.location ?? '').trim().length > 200) errors.push('location must be 200 characters or fewer');
  const opt = (k) => (blank(body[k]) === null ? null : String(body[k]).trim());
  return {
    errors,
    value: {
      device_name: name, device_type: type, location: opt('location'), ip_address: ip, port,
      vendor: opt('vendor'), serial_number: opt('serial_number'), attendance_direction: direction,
    },
  };
}

/* ─── POST /biometric/devices/probe ─── test an address BEFORE saving ──
 * The registration form's "Test connection": a TCP check of the address
 * typed, with nothing stored. Same gate as registering a device. */
router.post('/biometric/devices/probe', attendanceAdd, async (req, res) => {
  const { errors, ip, port } = deviceAddress(req.body ?? {});
  if (errors.length) return res.status(400).json({ message: errors[0], errors });
  const result = await testZKDevice(ip, port);
  res.json({
    ip_address: ip, port, connected: result.connected,
    latency_ms: result.latency_ms || null, error: result.error || null,
    message: result.connected
      ? `${ip}:${port} answered (${result.latency_ms} ms). This checks the network port only; Sync confirms the device protocol.`
      : `${ip}:${port} did not answer: ${result.error}`,
  });
});

/* ─── POST /biometric/devices ────────────────────────────────── */
router.post('/biometric/devices', attendanceAdd, async (req, res) => {
  const { errors, value: v } = normaliseDevice(req.body);
  if (errors.length) return res.status(400).json({ message: errors[0], errors });
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO biometric_devices
         (device_name, device_type, location, ip_address, port, vendor, serial_number, attendance_direction, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [v.device_name, v.device_type, v.location, v.ip_address, v.port, v.vendor, v.serial_number, v.attendance_direction, companyId]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── PUT /biometric/devices/:id ─────────────────────────────── */
router.put('/biometric/devices/:id', attendanceAdmin, captureBefore('biometric_devices'), async (req, res) => {
  const { errors, value: v } = normaliseDevice(req.body);
  if (errors.length) return res.status(400).json({ message: errors[0], errors });
  const companyId = cid(req);
  try {
    // A changed address invalidates the last check: the status was about the
    // old address, so the device reads "Not verified" until tested again.
    const { rows } = await pool.query(
      `UPDATE biometric_devices
       SET device_name=$1, device_type=$2, location=$3, ip_address=$4::text, port=$5::int,
           vendor=$6, serial_number=$7, attendance_direction=$8, updated_at=NOW(),
           -- Explicit casts: $4/$5 appear both as assigned values and in a
           -- comparison, and Postgres refuses to infer two types for one parameter.
           status_checked_at = CASE WHEN ip_address IS DISTINCT FROM $4::text OR port IS DISTINCT FROM $5::int
                                    THEN NULL ELSE status_checked_at END
       WHERE id=$9 AND ($10::int IS NULL OR company_id = $10) RETURNING *`,
      [
        v.device_name, v.device_type, v.location, v.ip_address, v.port,
        v.vendor, v.serial_number, v.attendance_direction, req.params.id, companyId,
      ]
    );
    if (!rows.length) return res.status(404).json({ message: 'Device not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── DELETE /biometric/devices/:id ──────────────────────────── */
router.delete('/biometric/devices/:id', attendanceDelete, captureBefore('biometric_devices'), async (req, res) => {
  const companyId = cid(req);
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, companyId]
    );
    if (!rowCount) return res.status(404).json({ message: 'Device not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /biometric/devices/:id/test ─── real TCP socket test  */
router.post('/biometric/devices/:id/test', attendanceAdmin, async (req, res) => {
  try {
    // ⚠⚠ TENANT SCOPE. Same defect as /devices/:id/users, and worse: this
    // looked the device up on `WHERE id=$1` alone, then opened a socket to its
    // ip_address, UPDATEd its status, and returned ip_address and port in the
    // body. Scoped the lookup; the UPDATE below is keyed on an id this query
    // has already proven belongs to the caller.
    const scopeId = cid(req);
    const { rows: [device] } = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, scopeId]
    );
    if (!device) return res.status(404).json({ error: 'Device not found', message: 'Device not found' });
    if (!device.ip_address) {
      return res.status(422).json({ status: 'not_configured', message: 'This device has no IP address configured.' });
    }

    const result = await testZKDevice(device.ip_address, device.port);

    // ⚠ This UPDATE wrote `updated_at`, a column biometric_devices did not have
    // until migration 20261028000012, so a REACHABLE device answered 500.
    const newStatus = result.connected ? 'online' : 'offline';
    await pool.query(
      `UPDATE biometric_devices
          SET status=$1, status_checked_at=NOW(), last_error=$2, updated_at=NOW()
        WHERE id=$3`,
      [newStatus, result.connected ? null : result.error, device.id]
    );

    res.json({
      device_id:   device.id,
      device_name: device.device_name,
      ip_address:  device.ip_address,
      port:        device.port,
      connected:   result.connected,
      latency_ms:  result.latency_ms || null,
      error:       result.error || null,
      status:      newStatus,
      message:     result.connected
        ? `${device.device_name} answered on ${device.ip_address}:${device.port} (${result.latency_ms} ms). This checks the network port only, not the attendance protocol.`
        : `${device.device_name} did not answer: ${result.error}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, message: err.message });
  }
});

/* ─── POST /biometric/devices/:id/sync ─── real ZKTeco SDK sync ─
 *
 * ⚠⚠ What this used to report. The final "mark online" UPDATE wrote
 * `updated_at`, which did not exist, so a sync that HAD pulled and written
 * punches threw at the end, answered 500 and tried to mark the device 'error'
 * (that UPDATE failed too, silently). And every write inside was
 * `.catch(() => {})`, so the counts it would have returned were counts of
 * attempts. Now: reach the device first; only if data came back, process it
 * in ONE transaction; the response counts what actually landed. An
 * unreachable device is a 502 with status 'offline' — never a success. */
/**
 * Pull punches from one device and apply them to attendance. Used by
 * POST /biometric/devices/:id/sync ("Sync now") and by the automatic sync job
 * (jobs/deviceSync.cron.js, Attendance → Punch Machines → Automatic sync).
 * Returns { status, body } — the HTTP answer the route sends.
 */
export async function runDeviceSync(device, scopeId) {
  const reply = (status, body) => ({ status, body });
  if (!device.ip_address) {
    return reply(422, {
      synced: false, status: 'not_configured',
      message: `${device.device_name} has no IP address configured, so it cannot be synced.`,
    });
  }
  if (!deviceDriver.available()) {
    return reply(503, {
      synced: false, status: 'not_configured', code: 'SDK_NOT_INSTALLED',
      message: 'Device sync is not available on this server: the ZKTeco SDK (node-zklib) is not installed.',
    });
  }

  const companyId = device.company_id ?? scopeId;
  const direction = device.attendance_direction || 'both';

  let payload;
  try {
    payload = await deviceDriver.read(device.ip_address, device.port);
  } catch (err) {
    const why = deviceErrorText(err);
    await pool.query(
      `UPDATE biometric_devices
          SET status='offline', status_checked_at=NOW(), last_error=$1, updated_at=NOW()
        WHERE id=$2`,
      [why, device.id]
    ).catch(() => {});
    return reply(502, {
      synced: false, status: 'offline', error: why,
      message: `Could not read ${device.device_name} at ${device.ip_address}:${device.port} — ${why}. No punches were imported.`,
      hint: 'Check the device IP address, port and network connectivity.',
    });
  }

  const userMap = {};
  for (const u of payload.users || []) userMap[String(u.userId || u.uid)] = u.name || '';

  const client = await pool.connect();
  const tally = emptyTally();
  let skipped = 0;
  try {
    await client.query('BEGIN');
    const rules = await dayRules(companyId, client);
    const ctx = newIngestContext(companyId, rules.tz, rules);
    const people = new Map();
    for (const log of payload.logs || []) {
      const devUserId = String(log.deviceUserId || log.userId || '');
      const punchAt   = log.attTime instanceof Date ? log.attTime : new Date(log.attTime);
      const punchType = normalisePunchType(log.inOutStatus ?? 0);
      if (isNaN(punchAt.getTime()) || !punchType
          || (direction === 'in' && punchType !== 'in')
          || (direction === 'out' && punchType !== 'out')) { skipped++; continue; }

      if (!people.has(devUserId)) {
        people.set(devUserId, await resolveDeviceUser(client, devUserId, userMap[devUserId], companyId));
      }
      const emp = people.get(devUserId);
      const outcome = await applyPunch(client, {
        employeeId: emp?.id ?? null, employeeCompanyId: emp?.company_id ?? companyId,
        deviceId: device.id, punchAt, punchType,
        raw: { source: 'device_sync', devUserId, devName: userMap[devUserId] || '', inOutStatus: log.inOutStatus, verifyType: log.verifyType },
      }, ctx);
      tally[outcome]++;
    }
    await client.query(
      `UPDATE biometric_devices
          SET last_sync=NOW(), status='online', status_checked_at=NOW(), last_error=NULL, updated_at=NOW()
        WHERE id=$1`,
      [device.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return reply(500, {
      synced: false, error: err.message,
      message: `Punches were read from ${device.device_name} but could not be saved — nothing was imported. ${err.message}`,
    });
  }
  client.release();

  const total = (payload.logs || []).length;
  return reply(200, {
    device_id:    device.id,
    device_name:  device.device_name,
    synced:       true,
    status:       'online',
    total_logs:   total,
    imported:     total - skipped - tally.duplicate,
    processed:    tally.applied,
    duplicates:   tally.duplicate,
    unmatched:    tally.unmatched,
    locked:       tally.frozen + tally.locked,
    skipped,
    sdk_status:   'active',
    last_sync:    new Date().toISOString(),
    message: total === 0
      ? `${device.device_name} answered and returned no punches.`
      : `${device.device_name}: ${total} punch(es) received — ${tally.applied} applied to attendance, `
        + `${tally.duplicate} already imported, ${tally.unmatched} not matched to an employee`
        + (tally.frozen + tally.locked ? `, ${tally.frozen + tally.locked} in a locked/frozen period` : '')
        + (skipped ? `, ${skipped} skipped (invalid or filtered by direction)` : '') + '.',
  });
}

router.post('/biometric/devices/:id/sync', attendanceAdmin, async (req, res) => {
  const scopeId = cid(req);
  let device;
  try {
    // ⚠⚠ TENANT SCOPE, and this one WRITES: a foreign id 404s before any
    // socket is opened (it used to sync another tenant's hardware into that
    // tenant's attendance).
    ({ rows: [device] } = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, scopeId]
    ));
  } catch (err) { return res.status(500).json({ error: err.message, message: err.message }); }
  if (!device) return res.status(404).json({ error: 'Device not found', message: 'Device not found' });
  const out = await runDeviceSync(device, scopeId);
  res.status(out.status).json(out.body);
});

/* ─── GET /biometric/devices/:id/punches ─────────────────────── */
router.get('/biometric/devices/:id/punches', biometricRead, async (req, res) => {
  const companyId = cid(req);
  const { date, limit = 50, offset = 0 } = req.query;
  try {
    const devRes = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, companyId]
    );
    if (!devRes.rows.length) return res.status(404).json({ message: 'Device not found' });

    const params = [req.params.id];
    let q = `SELECT bl.*, e.name AS employee_name, e.office_id AS emp_code, e.department
             FROM biometric_logs bl
             LEFT JOIN employees e ON e.id=bl.employee_id
             WHERE bl.device_id=$1`;
    if (date) { params.push(date); q += ` AND DATE(bl.punch_time)=$${params.length}`; }

    const countParams = [...params];
    const countQ = `SELECT COUNT(*) FROM biometric_logs WHERE device_id=$1${date ? ' AND DATE(punch_time)=$2' : ''}`;

    params.push(parseInt(limit), parseInt(offset));
    q += ` ORDER BY bl.punch_time DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const [punchRes, countRes] = await Promise.all([
      pool.query(q, params),
      pool.query(countQ, countParams),
    ]);
    res.json({ punches: punchRes.rows, total: parseInt(countRes.rows[0].count), device: devRes.rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* Gate passes and visitors: hr/gateAccess.routes.js (§272). The list helpers
 * (blank, listPage, dateRange, positiveIntOrNull) live in ./listQuery.js. */

/* ─── GET /biometric/logs ─── the Recent Punch Log ─────────────
 *
 * Filters: from/to (punch date, company timezone; default today), q (employee
 * name or code), employee_id, department, device_id, punch_type; paged.
 *
 * Scope: the row's own company_id, else its employee's. It was the employee's
 * only, so an unmatched device punch (employee_id NULL) could never be seen —
 * the very rows someone needs to map. */
router.get('/biometric/logs', biometricRead, async (req, res) => {
  const companyId = cid(req);
  const range = dateRange(req.query);
  if (range.error) return res.status(400).json({ message: range.error });
  const employeeId = positiveIntOrNull(req.query.employee_id);
  const deviceId   = positiveIntOrNull(req.query.device_id);
  if (Number.isNaN(employeeId)) return res.status(400).json({ message: 'employee_id must be a positive integer' });
  if (Number.isNaN(deviceId))   return res.status(400).json({ message: 'device_id must be a positive integer' });
  const punchType = blank(req.query.punch_type);
  if (punchType !== null && !['in', 'out'].includes(String(punchType))) {
    return res.status(400).json({ message: "punch_type must be 'in' or 'out'" });
  }
  // The legacy ?date= and ?limit= (no paging) are still honoured.
  const legacyDate = blank(req.query.date);
  if (legacyDate !== null && !range.from && !range.to) {
    const r = dateRange({ from: legacyDate, to: legacyDate });
    if (r.error) return res.status(400).json({ message: 'date must be a date in YYYY-MM-DD format' });
    Object.assign(range, r);
  }
  const { page, pageSize, offset } = listPage(
    { page: req.query.page, page_size: req.query.page_size ?? req.query.limit }, { size: 50, max: 200 });

  try {
    const { tz } = await dayRules(companyId);
    const today = (await pool.query(`SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`, [tz])).rows[0].d;
    const from = range.from ?? (range.to ? null : today);
    const to   = range.to   ?? (range.from ? null : today);

    const where = ['($1::int IS NULL OR COALESCE(bl.company_id, e.company_id) = $1)'];
    const params = [companyId];
    const add = (sql, v) => { params.push(v); where.push(sql.replaceAll('$?', `$${params.length}`)); };
    // `from` or `to` is always set (both default to today), so the zone is
    // always referenced once bound.
    params.push(tz); const tzRef = `$${params.length}::text`;
    if (from)       add(`(bl.punch_time AT TIME ZONE ${tzRef})::date >= $?::date`, from);
    if (to)         add(`(bl.punch_time AT TIME ZONE ${tzRef})::date <= $?::date`, to);
    if (employeeId) add('bl.employee_id = $?', employeeId);
    if (deviceId)   add('bl.device_id = $?', deviceId);
    if (punchType)  add('bl.punch_type = $?', punchType);
    const dept = blank(req.query.department);
    if (dept !== null) add('e.department = $?', String(dept));
    const q = blank(req.query.q);
    if (q !== null) {
      add(`(e.name ILIKE $? OR e.office_id ILIKE $? OR bl.raw_data->>'devUserId' ILIKE $?)`, `%${String(q).trim()}%`);
    }
    const whereSql = where.join(' AND ');
    const from_ = `FROM biometric_logs bl
                   LEFT JOIN employees e ON e.id = bl.employee_id
                   LEFT JOIN biometric_devices d ON d.id = bl.device_id
                  WHERE ${whereSql}`;
    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT bl.id, bl.employee_id, bl.device_id, bl.punch_time, bl.punch_type, bl.processed,
                bl.raw_data->>'source' AS source, bl.raw_data->>'devUserId' AS device_user_id,
                e.name AS employee_name, e.office_id AS emp_code, e.department, d.device_name
           ${from_}
          ORDER BY bl.punch_time DESC, bl.id DESC
          LIMIT ${pageSize} OFFSET ${offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS n ${from_}`, params),
    ]);
    res.json({ rows: rowsRes.rows, total: countRes.rows[0].n, page, page_size: pageSize, from, to });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── POST /biometric/logs/import ─── manual CSV import ──────────
 *
 * Body: { csv_data, device_id?, dry_run? }. `dry_run: true` runs the whole
 * import inside a transaction and ROLLS BACK, so the preview the page shows
 * (valid rows, duplicates, rows that would update attendance) is the exact
 * outcome of confirming, not an estimate.
 *
 * Columns (header row, any order, case-insensitive):
 *   employee_id   employee code (EMP001), mapped biometric user id, or the
 *                 internal id. Aliases: employee_code, emp_code.
 *   punch_time    ISO 8601 (with or without offset), 'YYYY-MM-DD HH:mm[:ss]'
 *                 or 'DD/MM/YYYY HH:mm[:ss]'. No offset = company timezone.
 *   punch_type    in / out (also check-in, check-out, 0/1 as devices export).
 *
 * ⚠ Before: `employee_id` had to be the INTERNAL numeric id, which no device
 * export carries; punch_type was optional and silently defaulted to 'in', so
 * an export without the column recorded every exit as an entry; a bad time
 * failed only inside `new Date(...).toISOString()`; and the punch never
 * reached attendance_records. Each is fixed here, and a value that matches two
 * DIFFERENT employees through different keys (code of one, biometric id of
 * another) is refused as ambiguous rather than guessed. */
const CSV_MAX_CHARS = 2_000_000;
const CSV_MAX_ROWS  = 10_000;
const HEADER_ALIASES = {
  employee_id: ['employee_id', 'employee_code', 'emp_code', 'employee code', 'emp id'],
  punch_time:  ['punch_time', 'punch time', 'datetime', 'timestamp'],
  punch_type:  ['punch_type', 'punch type', 'type', 'direction'],
};

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF/LF, a leading BOM. */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

/**
 * A punch time → { text, hasOffset } in a form Postgres casts exactly, or
 * null. Calendar validity is checked here (31/02 is refused, not rolled over).
 */
export function normalisePunchTime(value) {
  const s = String(value ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  let y, mo, d, h, mi, se, off;
  if (m) { [, y, mo, d, h, mi, se, off] = m; }
  else {
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return null;
    [, d, mo, y, h, mi, se] = m;
  }
  const [Y, Mo, D, H, Mi, Se] = [y, mo, d, h, mi, se || '0'].map(Number);
  const probe = new Date(Date.UTC(Y, Mo - 1, D, H, Mi, Se));
  if (probe.getUTCFullYear() !== Y || probe.getUTCMonth() !== Mo - 1 || probe.getUTCDate() !== D
      || H > 23 || Mi > 59 || Se > 59) return null;
  const p2 = (n) => String(n).padStart(2, '0');
  const base = `${Y}-${p2(Mo)}-${p2(D)} ${p2(H)}:${p2(Mi)}:${p2(Se)}`;
  return off ? { text: `${base}${off.toUpperCase() === 'Z' ? '+00:00' : off}`, hasOffset: true }
             : { text: base, hasOffset: false };
}

router.post('/biometric/logs/import', attendanceAdmin, async (req, res) => {
  const csv = req.body?.csv_data;
  const dryRun = req.body?.dry_run === true || req.body?.dry_run === 'true';
  if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ message: 'csv_data required' });
  if (csv.length > CSV_MAX_CHARS) {
    return res.status(413).json({ message: `The file is too large — the limit is ${CSV_MAX_CHARS / 1_000_000} MB.` });
  }

  // ⚠⚠ TENANT SCOPE. `employee_id` comes from the CSV and `device_id` from the
  // body; both are resolved against the caller's company below, so a row
  // naming a foreign employee is REPORTED, never written.
  const companyId = cid(req);
  const deviceIdRaw = blank(req.body.device_id);
  let deviceId = null;
  try {
    if (deviceIdRaw !== null) {
      const { rows } = await pool.query(
        'SELECT id FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
        [/^\d+$/.test(String(deviceIdRaw)) ? Number(deviceIdRaw) : -1, companyId]
      );
      if (!rows.length) return res.status(404).json({ message: 'Device not found' });
      deviceId = rows[0].id;
    }
  } catch (err) { return res.status(500).json({ message: err.message }); }

  const table = parseCsv(csv);
  if (table.length < 2) return res.status(400).json({ message: 'The file has a header row but no punches.' });
  const header = table[0].map(h => String(h).trim().toLowerCase());
  const col = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    col[key] = header.findIndex(h => aliases.includes(h));
  }
  const missing = Object.keys(HEADER_ALIASES).filter(k => col[k] === -1);
  if (missing.length) {
    return res.status(400).json({
      message: `CSV must have employee_id, punch_time and punch_type columns — missing: ${missing.join(', ')}`,
      missing_columns: missing,
    });
  }
  if (table.length - 1 > CSV_MAX_ROWS) {
    return res.status(413).json({ message: `The file has ${table.length - 1} rows — the limit is ${CSV_MAX_ROWS} per import.` });
  }

  const errors = [];          // "Row n: …" strings — the shape the page and older callers read
  const rowErrors = [];       // the same, structured
  const fail = (row, message) => { errors.push(`Row ${row}: ${message}`); rowErrors.push({ row, message }); };

  const parsed = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const empKey = String(cells[col.employee_id] ?? '').trim();
    const timeRaw = String(cells[col.punch_time] ?? '').trim();
    const typeRaw = String(cells[col.punch_type] ?? '').trim();
    if (!empKey)  { fail(i, 'employee_id is empty'); continue; }
    if (!timeRaw) { fail(i, 'punch_time is empty'); continue; }
    const time = normalisePunchTime(timeRaw);
    if (!time) { fail(i, `punch_time "${timeRaw}" is not a valid date/time`); continue; }
    const punchType = normalisePunchType(typeRaw);
    if (!punchType) { fail(i, `punch_type "${typeRaw}" must be in or out`); continue; }
    parsed.push({ row: i, empKey, time, punchType, timeRaw });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rules = await dayRules(companyId, client);

    // Resolve every employee key the file names, in one query, scoped.
    const keys = [...new Set(parsed.map(p => p.empKey))];
    const lower = keys.map(k => k.toLowerCase());
    const numeric = keys.filter(k => /^\d+$/.test(k) && k.length < 10).map(Number);
    const { rows: emps } = keys.length ? await client.query(
      `SELECT id, company_id, LOWER(TRIM(office_id)) AS code, biometric_user_id AS bio
         FROM employees
        WHERE ($1::int IS NULL OR company_id = $1) AND deleted_at IS NULL
          AND (LOWER(TRIM(office_id)) = ANY($2::text[]) OR biometric_user_id = ANY($3::text[]) OR id = ANY($4::int[]))`,
      [companyId, lower, keys, numeric]
    ) : { rows: [] };
    const resolve = (key) => {
      const k = key.toLowerCase();
      const hits = new Map();
      for (const e of emps) {
        if (e.code === k || e.bio === key || (/^\d+$/.test(key) && e.id === Number(key))) hits.set(e.id, e);
      }
      return [...hits.values()];
    };

    // Convert every time to an instant in one round trip, in the company zone.
    const times = parsed.length ? (await client.query(
      `SELECT x.i, CASE WHEN x.o THEN x.t::timestamptz ELSE x.t::timestamp AT TIME ZONE $4 END AS at
         FROM unnest($1::text[], $2::bool[], $3::int[]) AS x(t, o, i)`,
      [parsed.map(p => p.time.text), parsed.map(p => p.time.hasOffset), parsed.map((_, i) => i), rules.tz]
    )).rows : [];
    const instant = new Map(times.map(r => [r.i, r.at]));
    const ceiling = Date.now() + 5 * 60 * 1000;

    const ctx = newIngestContext(companyId, rules.tz, rules);
    const tally = emptyTally();
    const seen = new Set();
    let duplicatesInFile = 0;
    let valid = 0;
    const preview = [];
    for (const [idx, p] of parsed.entries()) {
      const matches = resolve(p.empKey);
      if (!matches.length) { fail(p.row, `unknown employee ${p.empKey}`); continue; }
      if (matches.length > 1) { fail(p.row, `employee ${p.empKey} matches more than one employee — use the employee code`); continue; }
      const at = instant.get(idx);
      if (at.getTime() > ceiling) { fail(p.row, `punch_time ${p.timeRaw} is in the future`); continue; }
      const emp = matches[0];
      const key = `${emp.id}|${at.toISOString()}`;
      if (seen.has(key)) { duplicatesInFile++; fail(p.row, 'duplicate of an earlier row in this file'); continue; }
      seen.add(key);
      valid++;
      const outcome = await applyPunch(client, {
        employeeId: emp.id, employeeCompanyId: emp.company_id, deviceId, punchAt: at, punchType: p.punchType,
        raw: { source: 'csv_import', row: p.row, employee_key: p.empKey },
      }, ctx);
      tally[outcome]++;
      if (preview.length < 10) {
        preview.push({ row: p.row, employee_id: emp.id, employee_key: p.empKey, punch_time: at, punch_type: p.punchType, outcome });
      }
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    res.json({
      dry_run:            dryRun,
      total_rows:         table.length - 1,
      valid_rows:         valid,
      imported:           tally.applied + tally.frozen + tally.locked,
      attendance_updated: tally.applied,
      attendance_locked:  tally.frozen + tally.locked,
      duplicates:         tally.duplicate,
      duplicates_in_file: duplicatesInFile,
      invalid_rows:       rowErrors.length - duplicatesInFile,
      errors,
      row_errors:         rowErrors,
      preview,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ message: `Import failed and nothing was saved: ${err.message}` });
  } finally {
    client.release();
  }
});

/* ─── GET /biometric/dashboard ───────────────────────────────────
 *
 * Every card, and the population it is measured against:
 *   expected        current employees (shared CURRENT_STATUSES, not deleted)
 *                   minus those on approved leave today. It was COUNT(*) of
 *                   every employees row — Left and resigned included — so Not
 *                   Punched counted people who no longer work here.
 *   punched_in      expected employees with an 'in' punch today.
 *   not_yet_punched expected − punched_in; NULL on a weekend or a declared
 *                   holiday, when nobody is expected (the page says so).
 *   late_arrivals   first 'in' today later than work_start_time + late grace
 *                   (Attendance Settings + the late policy; was `hour > 9`).
 *   early_departures last punch today is an 'out' before work_end_time (was
 *                   any 'out' before 17:00, so a lunch break counted).
 *   visitors_inside every open visit (check_out_time IS NULL), any date — the
 *                   same number the Visitors tab shows. It counted only
 *                   today's check-ins, so the two disagreed.
 * "Today" is the company-timezone date. */
router.get('/biometric/dashboard', biometricRead, async (req, res) => {
  const companyId = cid(req);
  try {
    const rules = await dayRules(companyId);
    const { rows: [{ today }] } = await pool.query(
      `SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS today`, [rules.tz]);

    const holidayQ = pool.query(
      `SELECT name FROM holidays
        WHERE date = $1::date AND ($2::int IS NULL OR company_id = $2 OR company_id IS NULL)
        ORDER BY company_id NULLS LAST LIMIT 1`, [today, companyId]).catch(() => ({ rows: [] }));
    const weekendQ = getWeekendDays(companyId);

    const statsQ = pool.query(
      `WITH pop AS (
         SELECT e.id FROM employees e
          WHERE ($1::int IS NULL OR e.company_id = $1) AND e.deleted_at IS NULL
            AND LOWER(e.status) IN (${sqlList(CURRENT_STATUSES)})
       ),
       on_leave AS (
         SELECT DISTINCT la.employee_id AS id FROM leave_applications la
          WHERE la.employee_id IN (SELECT id FROM pop)
            AND LOWER(la.status) IN (${sqlList(LEAVE_APPROVED)})
            AND $2::date BETWEEN la.start_date AND la.end_date
       ),
       punches AS (
         SELECT bl.employee_id, bl.punch_type, (bl.punch_time AT TIME ZONE $3)::time AS t, bl.punch_time
           FROM biometric_logs bl
          WHERE bl.employee_id IN (SELECT id FROM pop)
            AND (bl.punch_time AT TIME ZONE $3)::date = $2::date
       ),
       per_emp AS (
         SELECT employee_id,
                MIN(t) FILTER (WHERE punch_type = 'in') AS first_in,
                (ARRAY_AGG(punch_type ORDER BY punch_time DESC))[1] AS last_type,
                (ARRAY_AGG(t ORDER BY punch_time DESC))[1] AS last_t
           FROM punches GROUP BY employee_id
       )
       SELECT
         (SELECT COUNT(*) FROM pop)::int                                                   AS total_employees,
         (SELECT COUNT(*) FROM on_leave)::int                                              AS on_leave,
         (SELECT COUNT(*) FROM per_emp WHERE first_in IS NOT NULL)::int                    AS punched_in,
         (SELECT COUNT(*) FROM per_emp WHERE first_in IS NOT NULL
             AND employee_id NOT IN (SELECT id FROM on_leave))::int                        AS punched_in_expected,
         (SELECT COUNT(*) FROM per_emp
           WHERE first_in > ($4::time + make_interval(mins => $5)))::int                   AS late_arrivals,
         (SELECT COUNT(*) FROM per_emp WHERE last_type = 'out' AND last_t < $6::time)::int AS early_departures`,
      [companyId, today, rules.tz, rules.workStart, rules.graceMinutes, rules.workEnd]
    );
    const visitorsQ = pool.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE (check_in_time AT TIME ZONE $2)::date < $3::date)::int AS overdue
         FROM visitors
        WHERE check_in_time IS NOT NULL AND check_out_time IS NULL AND cancelled_at IS NULL
          AND ($1::int IS NULL OR company_id = $1)`,
      [companyId, rules.tz, today]
    );

    const [holiday, weekendDays, stats, visitors] = await Promise.all([holidayQ, weekendQ, statsQ, visitorsQ]);
    const s = stats.rows[0];
    const holidayName = holiday.rows[0]?.name ?? null;
    const isWeekend = dayIsWeekend(today, weekendDays);
    const nonWorking = holidayName ? `Holiday — ${holidayName}` : (isWeekend ? 'Weekend' : null);
    const expected = s.total_employees - s.on_leave;
    res.json({
      date:              today,
      timezone:          rules.tz,
      non_working_day:   nonWorking,
      total_employees:   s.total_employees,
      on_leave:          s.on_leave,
      expected:          nonWorking ? 0 : expected,
      punched_in_today:  s.punched_in,
      not_yet_punched:   nonWorking ? null : Math.max(0, expected - s.punched_in_expected),
      late_arrivals:     s.late_arrivals,
      early_departures:  s.early_departures,
      visitors_inside:   visitors.rows[0].n,
      visitors_overdue:  visitors.rows[0].overdue,
      rules: { work_start: rules.workStart, work_end: rules.workEnd, grace_minutes: rules.graceMinutes },
      source: 'biometric_logs (device sync and CSV import); web/mobile clock-ins are not counted here',
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/devices/:id/users ─── list enrolled users on device ── */
router.get('/biometric/devices/:id/users', attendanceAdmin, async (req, res) => {
  try {
    // ⚠⚠ TENANT SCOPE. This lookup had no company filter, so any caller holding
    // attendance:edit could name another tenant's device id and have the server
    // open a socket to THAT tenant's hardware and read back its enrolled users.
    // The `$2::int IS NULL` arm preserves the global (super-admin) scope;
    // `cid()` returns null only for a caller resolved as global.
    const scopeId = cid(req);
    const { rows: [device] } = await pool.query(
      'SELECT * FROM biometric_devices WHERE id=$1 AND ($2::int IS NULL OR company_id = $2)',
      [req.params.id, scopeId]
    );
    if (!device) return res.status(404).json({ error: 'Device not found' });
    if (!ZKLib) return res.status(503).json({ error: 'node-zklib not installed', hint: 'npm install node-zklib' });

    const zk = new ZKLib(device.ip_address, parseInt(device.port) || 4370, 10000, 4000);
    await zk.createSocket();
    const result = await zk.getUsers().catch(() => ({ data: [] }));
    await zk.disconnect();

    const companyId = device.company_id ?? scopeId;

    // Enrich with matched employee info. ⚠ This selected `employee_id`, a
    // column employees does not have (it is office_id), so every call 500'd
    // after dialling the device. Same matching rules as the sync.
    const enriched = await Promise.all((result.data || []).map(async (u) => {
      const devUserId = String(u.userId || u.uid || '');
      const row = await pool.query(
        `SELECT id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name, office_id AS emp_code, department
           FROM employees
          WHERE (LOWER(TRIM(office_id)) = LOWER(TRIM($1)) OR biometric_user_id = $1)
            AND ($2::int IS NULL OR company_id = $2) AND deleted_at IS NULL
          LIMIT 1`,
        [devUserId, companyId]
      ).catch(() => ({ rows: [] }));
      return {
        device_user_id: devUserId,
        device_name:    u.name || '',
        role:           u.role,
        matched_employee: row.rows[0] || null,
      };
    }));

    res.json({ device_id: device.id, users: enriched, total: enriched.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── POST /biometric/employees/map ─── assign biometric_user_id to employee ─ */
router.post('/biometric/employees/map', hrEdit, async (req, res) => {
  const { employee_id, biometric_user_id } = req.body;
  if (!employee_id || !biometric_user_id) {
    return res.status(400).json({ error: 'employee_id and biometric_user_id required' });
  }
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `UPDATE employees SET biometric_user_id=$1
        WHERE id=$2 AND ($3::int IS NULL OR company_id = $3)
       RETURNING id, biometric_user_id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name`,
      [String(biometric_user_id), employee_id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    res.json({ success: true, employee: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─── GET /biometric/employees/options ─── the page's employee pickers ──
 * Current employees of the caller's company: id, name, code, department.
 * The gate-pass form asked for a raw internal "Employee ID" number and the
 * visitor form for a "Host Employee ID" — numbers no-one in HR knows. */
// Employee picker for the gate-pass register (gate_access:view), the HR pages
// (hr:view) and Attendance → Punch Import (attendance:edit). §272.
const employeeOptionsRead = requireAnyPermission([['hr', 'view'], ['gate_access', 'view'], ['attendance', 'edit']]);
router.get('/biometric/employees/options', employeeOptionsRead, async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      `SELECT id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name, office_id AS emp_code, department
         FROM employees
        WHERE ($1::int IS NULL OR company_id = $1) AND deleted_at IS NULL
          AND LOWER(status) IN (${sqlList(CURRENT_STATUSES)})
        ORDER BY 2`,
      [companyId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── GET /biometric/employees/unmapped ─── employees with no biometric ID ── */
router.get('/biometric/employees/unmapped', hrView, async (req, res) => {
  const companyId = cid(req);
  try {
    const { rows } = await pool.query(
      // office_id, not employee_id — employees has no employee_id column.
      `SELECT id, COALESCE(name, CONCAT(first_name,' ',last_name)) AS name,
              office_id AS emp_code, department, designation
         FROM employees
        WHERE (biometric_user_id IS NULL OR biometric_user_id = '')
          AND deleted_at IS NULL
          AND LOWER(status) IN ('active','probation')
          AND ($1::int IS NULL OR company_id = $1)
        ORDER BY department, name
        LIMIT 200`,
      [companyId]
    );
    res.json({ unmapped: rows, count: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
