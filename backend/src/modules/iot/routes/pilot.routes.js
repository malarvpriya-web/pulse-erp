/**
 * pilot.routes.js — hardware pilot evidence.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The hardware pilot is the last thing standing between this module and
 * certification. It cannot be performed in software — it needs a physical device
 * — but everything AROUND it can be made reliable, and that is what these
 * endpoints do: they turn the pilot from a markdown form into a recorded,
 * queryable fact with the raw bytes attached.
 *
 * ENDPOINTS
 *   POST /iot/pilots                      open a pilot
 *   GET  /iot/pilots                      list
 *   GET  /iot/pilots/:id                  one pilot with its readings
 *   PUT  /iot/pilots/:id                  record what the engineer observed
 *   PUT  /iot/pilots/:id/readings/:metric one register's comparison
 *   POST /iot/pilots/:id/complete         pass / fail — requires a human's evidence
 *   GET  /iot/pilots/status               is any device verified? (certification reads this)
 *
 * THE ONE RULE THIS FILE ENFORCES ABOVE ALL
 * -----------------------------------------
 * Nothing here can mark a pilot passed on its own. `complete` refuses without a
 * named engineer, a named reference instrument, all three confirmed conventions,
 * and at least one register comparison that a human entered. The database carries
 * the same rule as a CHECK constraint, so a future route that forgets still
 * cannot do it.
 *
 * A successful Modbus read is NOT evidence. The device answering proves the
 * transport works; it says nothing about whether the number means what the
 * profile claims. That distinction is the entire point of the pilot.
 */

import { Router } from 'express';
import crypto from 'crypto';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { logAudit } from '../../../services/AuditService.js';
import { iotScope, denyScope, companyPredicate, writeCompany, scopedEquipment } from '../scope.js';

const router = Router();

/**
 * The commissioning tool runs ON the gateway and has no user session, so its
 * endpoint authenticates with the device token instead. It lives on a SEPARATE
 * router because Express does not fall through: mounting one router twice, once
 * without verifyToken, means the first mount answers everything — every
 * user-authed pilot route would have 401'd on a missing req.user.
 */
const deviceRouter = Router();

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const ADDRESSING = ['one_based', 'zero_based'];
const ORDERS = ['big', 'little'];

// ── POST /iot/pilots ──────────────────────────────────────────────────────────
router.post('/pilots', requirePermission('iot', 'add'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  const target = writeCompany(scope, req.body);
  if (!target.ok) return res.status(400).json({ error: 'company scope required', code: target.reason });
  try {
    const b = req.body || {};
    if (b.equipment_id != null) {
      const eq = await scopedEquipment(pool, b.equipment_id, scope);
      if (!eq) return res.status(404).json({ error: 'equipment not found in this company' });
    }
    if (b.device_profile_id != null) {
      const { rows } = await pool.query(
        `SELECT id FROM iot_device_profiles WHERE id = $1 AND (company_id IS NULL OR company_id = $2)`,
        [b.device_profile_id, target.companyId]);
      if (!rows.length) return res.status(404).json({ error: 'device profile not found in this company' });
    }

    const { rows } = await pool.query(
      `INSERT INTO iot_hardware_pilots
         (company_id, equipment_id, device_profile_id, manufacturer, model, firmware,
          serial_number, register_map_ver, site, host, port, unit_id, protocol,
          declared_addressing_mode, declared_byte_order, declared_word_order,
          reference_instrument, engineer_user_id, engineer_name, notes, tool_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [target.companyId, b.equipment_id ?? null, b.device_profile_id ?? null,
       b.manufacturer ?? null, b.model ?? null, b.firmware ?? null, b.serial_number ?? null,
       b.register_map_ver ?? null, b.site ?? null, b.host ?? null, b.port ?? null,
       b.unit_id ?? null, b.protocol || 'modbus_tcp',
       b.declared_addressing_mode ?? null, b.declared_byte_order ?? null, b.declared_word_order ?? null,
       b.reference_instrument ?? null, req.user?.userId ?? null, b.engineer_name ?? null,
       b.notes ?? null, b.tool_version ?? null]);

    logAudit({ userId: req.user?.userId, module: 'iot', recordId: rows[0].id, recordType: 'iot_hardware_pilot', action: 'create', newData: rows[0], req, company_id: target.companyId });
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[iot pilot create]', e.message);
    res.status(500).json({ error: 'failed to open pilot' });
  }
});

// ── GET /iot/pilots ───────────────────────────────────────────────────────────
router.get('/pilots', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [];
    let sql = `
      SELECT p.*, ce.equipment_name, pr.profile_code, u.name AS engineer_user_name,
             (SELECT COUNT(*) FROM iot_hardware_pilot_readings r WHERE r.pilot_id = p.id)::int AS readings,
             (SELECT COUNT(*) FROM iot_hardware_pilot_readings r WHERE r.pilot_id = p.id AND r.verdict = 'passed')::int AS readings_passed,
             (SELECT COUNT(*) FROM iot_hardware_pilot_readings r WHERE r.pilot_id = p.id AND r.verdict = 'failed')::int AS readings_failed
        FROM iot_hardware_pilots p
        LEFT JOIN customer_equipment ce ON ce.id = p.equipment_id
        LEFT JOIN iot_device_profiles pr ON pr.id = p.device_profile_id
        LEFT JOIN users u ON u.id = p.engineer_user_id
       WHERE 1 = 1`;
    sql += companyPredicate(scope, 'p.company_id', params);
    if (req.query.verdict) { params.push(req.query.verdict); sql += ` AND p.verdict = $${params.length}`; }
    sql += ` ORDER BY p.performed_at DESC LIMIT 200`;
    const { rows } = await pool.query(sql, params);
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: 'failed to load pilots' }); }
});

// ── GET /iot/pilots/status ────────────────────────────────────────────────────
// The certification question, answered from data rather than from a document.
// Deliberately blunt: with no passed pilot it says so in as many words.
router.get('/pilots/status', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [];
    const where = `WHERE 1=1${companyPredicate(scope, 'company_id', params)}`;
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int                                        AS total,
             COUNT(*) FILTER (WHERE verdict = 'passed')::int       AS passed,
             COUNT(*) FILTER (WHERE verdict = 'failed')::int       AS failed,
             COUNT(*) FILTER (WHERE verdict = 'in_progress')::int  AS in_progress,
             MAX(completed_at) FILTER (WHERE verdict = 'passed')   AS last_passed_at
        FROM iot_hardware_pilots ${where}`, params);

    const pp = [];
    const pWhere = `WHERE company_id IS NOT NULL${companyPredicate(scope, 'company_id', pp)}`;
    const { rows: profiles } = await pool.query(`
      SELECT COUNT(*)::int AS company_profiles,
             COUNT(*) FILTER (WHERE verified_by_pilot_id IS NOT NULL)::int AS verified_profiles,
             COUNT(*) FILTER (WHERE jsonb_array_length(register_map) > 0)::int AS with_register_map
        FROM iot_device_profiles ${pWhere}`, pp);

    const s = rows[0], p = profiles[0];
    res.json({
      ...s, ...p,
      hardware_validated: s.passed > 0,
      statement: s.passed > 0
        ? `${s.passed} pilot(s) passed. ${p.verified_profiles} of ${p.company_profiles} company profiles carry a verified register map.`
        : 'NO hardware pilot has passed. Every register map in this company is unverified: the decoder is tested, but no evidence exists that any particular device is being read correctly. See IOT_HARDWARE_PILOT.md.',
    });
  } catch (e) {
    console.error('[iot pilot status]', e.message);
    res.status(500).json({ error: 'failed to load pilot status' });
  }
});

// ── GET /iot/pilots/:id ───────────────────────────────────────────────────────
router.get('/pilots/:id', requirePermission('iot', 'view'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [parseInt(req.params.id, 10)];
    let sql = `SELECT p.*, ce.equipment_name, pr.profile_code, u.name AS engineer_user_name
                 FROM iot_hardware_pilots p
                 LEFT JOIN customer_equipment ce ON ce.id = p.equipment_id
                 LEFT JOIN iot_device_profiles pr ON pr.id = p.device_profile_id
                 LEFT JOIN users u ON u.id = p.engineer_user_id
                WHERE p.id = $1`;
    sql += companyPredicate(scope, 'p.company_id', params);
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: 'pilot not found' });

    const { rows: readings } = await pool.query(
      `SELECT * FROM iot_hardware_pilot_readings WHERE pilot_id = $1 ORDER BY metric`, [rows[0].id]);
    res.json({ ...rows[0], readings, blockers: completionBlockers(rows[0], readings) });
  } catch (e) { res.status(500).json({ error: 'failed to load pilot' }); }
});

/** What still stands between this pilot and a pass. Returned so the UI can show it. */
function completionBlockers(pilot, readings) {
  const out = [];
  if (!pilot.engineer_user_id) out.push('No engineer is recorded against this pilot.');
  if (!pilot.reference_instrument) out.push('No reference instrument is named.');
  if (!pilot.confirmed_addressing_mode) out.push('Addressing mode has not been confirmed against the device display.');
  if (!pilot.confirmed_byte_order) out.push('Byte order has not been confirmed against the device display.');
  if (!pilot.confirmed_word_order) out.push('Word order has not been confirmed against the device display.');
  const compared = (readings || []).filter((r) => r.device_display != null);
  if (!compared.length) out.push('No register has been compared against the device display. A successful read is not evidence.');
  const failed = (readings || []).filter((r) => r.verdict === 'failed');
  if (failed.length) out.push(`${failed.length} register(s) are outside tolerance: ${failed.map((r) => r.metric).join(', ')}.`);
  return out;
}

// ── PUT /iot/pilots/:id ───────────────────────────────────────────────────────
router.put('/pilots/:id', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [parseInt(req.params.id, 10)];
    let find = `SELECT * FROM iot_hardware_pilots WHERE id = $1`;
    find += companyPredicate(scope, 'company_id', params);
    const { rows: existing } = await pool.query(find, params);
    if (!existing.length) return res.status(404).json({ error: 'pilot not found' });
    const pilot = existing[0];
    if (pilot.verdict !== 'in_progress') {
      return res.status(409).json({ error: `this pilot is ${pilot.verdict} and can no longer be edited`, code: 'PILOT_CLOSED' });
    }

    const b = req.body || {};
    for (const [k, allowed] of [
      ['confirmed_addressing_mode', ADDRESSING],
      ['confirmed_byte_order', ORDERS],
      ['confirmed_word_order', ORDERS],
    ]) {
      if (b[k] != null && !allowed.includes(b[k])) {
        return res.status(400).json({ error: `${k} must be one of ${allowed.join(', ')}` });
      }
    }

    const fields = ['manufacturer', 'model', 'firmware', 'serial_number', 'register_map_ver', 'site',
                    'host', 'port', 'unit_id', 'declared_addressing_mode', 'declared_byte_order',
                    'declared_word_order', 'confirmed_addressing_mode', 'confirmed_byte_order',
                    'confirmed_word_order', 'reference_instrument', 'engineer_name', 'notes',
                    'device_profile_id', 'equipment_id'];
    const sets = [], up = [];
    for (const k of fields) {
      if (b[k] !== undefined) { up.push(b[k]); sets.push(`${k} = $${up.length + 1}`); }
    }
    if (!sets.length) return res.status(400).json({ error: 'no updatable fields supplied' });
    // Whoever last recorded an observation owns it.
    up.push(req.user?.userId ?? null); sets.push(`engineer_user_id = COALESCE($${up.length + 1}, engineer_user_id)`);

    const { rows } = await pool.query(
      `UPDATE iot_hardware_pilots SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [pilot.id, ...up]);
    logAudit({ userId: req.user?.userId, module: 'iot', recordId: pilot.id, recordType: 'iot_hardware_pilot', action: 'update', oldData: pilot, newData: rows[0], req, company_id: pilot.company_id });
    res.json(rows[0]);
  } catch (e) {
    console.error('[iot pilot update]', e.message);
    res.status(500).json({ error: 'failed to update pilot' });
  }
});

// ── PUT /iot/pilots/:id/readings/:metric ──────────────────────────────────────
// One register's comparison. The tolerance check is computed here rather than
// trusted from the client, so a verdict cannot be asserted without the numbers
// that justify it.
router.put('/pilots/:id/readings/:metric', requirePermission('iot', 'edit'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  try {
    const params = [parseInt(req.params.id, 10)];
    let find = `SELECT * FROM iot_hardware_pilots WHERE id = $1`;
    find += companyPredicate(scope, 'company_id', params);
    const { rows: pilots } = await pool.query(find, params);
    if (!pilots.length) return res.status(404).json({ error: 'pilot not found' });
    const pilot = pilots[0];
    if (pilot.verdict !== 'in_progress') {
      return res.status(409).json({ error: `this pilot is ${pilot.verdict}`, code: 'PILOT_CLOSED' });
    }

    const b = req.body || {};
    const num = (v) => (v == null || v === '' ? null : Number(v));
    const pulseValue = num(b.pulse_value);
    const display = num(b.device_display);
    const reference = num(b.reference_value);
    const tolerance = num(b.tolerance_pct);

    // The comparison is against the reference instrument where one exists, and
    // against the device display otherwise. Computed here — a client-supplied
    // "within tolerance" flag would be an opinion, not a measurement.
    let differencePct = null;
    let withinTolerance = null;
    const truth = reference ?? display;
    if (pulseValue != null && truth != null) {
      if (Math.abs(truth) < 1e-9) {
        differencePct = Math.abs(pulseValue) < 1e-9 ? 0 : null;
      } else {
        differencePct = Number((((pulseValue - truth) / Math.abs(truth)) * 100).toFixed(4));
      }
      if (differencePct != null && tolerance != null) withinTolerance = Math.abs(differencePct) <= tolerance;
    }

    // A verdict is only allowed where the numbers support it.
    let verdict = b.verdict || 'pending';
    if (verdict === 'passed' && withinTolerance !== true) {
      return res.status(400).json({
        error: 'a register cannot be marked passed without a comparison inside tolerance',
        code: 'NO_COMPARISON',
        detail: pulseValue == null ? 'pulse_value is missing'
          : truth == null ? 'no device_display or reference_value to compare against'
          : tolerance == null ? 'no tolerance_pct given'
          : `difference is ${differencePct}% against a tolerance of ${tolerance}%`,
      });
    }
    if (withinTolerance === false && verdict === 'pending') verdict = 'failed';

    const { rows } = await pool.query(
      `INSERT INTO iot_hardware_pilot_readings
         (pilot_id, metric, documented_address, protocol_address, register_table, data_type,
          scale, reg_offset, unit, raw_hex, decoded_variants,
          pulse_value, device_display, reference_value, difference_pct, tolerance_pct,
          within_tolerance, verdict, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (pilot_id, metric) DO UPDATE SET
         documented_address = EXCLUDED.documented_address,
         protocol_address   = EXCLUDED.protocol_address,
         register_table     = EXCLUDED.register_table,
         data_type          = EXCLUDED.data_type,
         scale              = EXCLUDED.scale,
         reg_offset         = EXCLUDED.reg_offset,
         unit               = EXCLUDED.unit,
         raw_hex            = COALESCE(EXCLUDED.raw_hex, iot_hardware_pilot_readings.raw_hex),
         decoded_variants   = COALESCE(EXCLUDED.decoded_variants, iot_hardware_pilot_readings.decoded_variants),
         pulse_value        = EXCLUDED.pulse_value,
         device_display     = EXCLUDED.device_display,
         reference_value    = EXCLUDED.reference_value,
         difference_pct     = EXCLUDED.difference_pct,
         tolerance_pct      = EXCLUDED.tolerance_pct,
         within_tolerance   = EXCLUDED.within_tolerance,
         verdict            = EXCLUDED.verdict,
         notes              = EXCLUDED.notes
       RETURNING *`,
      [pilot.id, String(req.params.metric).slice(0, 40), b.documented_address ?? null,
       b.protocol_address ?? null, b.register_table ?? null, b.data_type ?? null,
       num(b.scale), num(b.offset ?? b.reg_offset), b.unit ?? null, b.raw_hex ?? null,
       b.decoded_variants ? JSON.stringify(b.decoded_variants) : null,
       pulseValue, display, reference, differencePct, tolerance, withinTolerance, verdict,
       b.notes ?? null]);

    res.json(rows[0]);
  } catch (e) {
    console.error('[iot pilot reading]', e.message);
    res.status(500).json({ error: 'failed to record reading' });
  }
});

// ── POST /iot/pilots/:id/complete ─────────────────────────────────────────────
router.post('/pilots/:id/complete', requirePermission('iot', 'approve'), async (req, res) => {
  const scope = iotScope(req);
  if (!scope.ok) return denyScope(res, scope);
  const client = await pool.connect();
  try {
    const params = [parseInt(req.params.id, 10)];
    let find = `SELECT * FROM iot_hardware_pilots WHERE id = $1`;
    find += companyPredicate(scope, 'company_id', params);
    const { rows: pilots } = await client.query(find + ' FOR UPDATE', params);
    if (!pilots.length) return res.status(404).json({ error: 'pilot not found' });
    const pilot = pilots[0];
    if (pilot.verdict !== 'in_progress') {
      return res.status(409).json({ error: `this pilot is already ${pilot.verdict}`, code: 'PILOT_CLOSED' });
    }

    const verdict = req.body?.verdict;
    if (!['passed', 'failed', 'abandoned'].includes(verdict)) {
      return res.status(400).json({ error: "verdict must be 'passed', 'failed' or 'abandoned'" });
    }

    const { rows: readings } = await client.query(
      `SELECT * FROM iot_hardware_pilot_readings WHERE pilot_id = $1`, [pilot.id]);

    if (verdict === 'passed') {
      const blockers = completionBlockers(pilot, readings);
      if (blockers.length) {
        // This is the guard the whole file exists for. A pilot passes when a
        // person says the values matched a device — not when the code ran.
        return res.status(409).json({
          error: 'this pilot cannot be marked passed yet',
          code: 'PILOT_INCOMPLETE',
          blockers,
        });
      }
    }

    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE iot_hardware_pilots
          SET verdict = $2, completed_at = NOW(),
              notes = COALESCE($3, notes),
              engineer_user_id = COALESCE(engineer_user_id, $4)
        WHERE id = $1 RETURNING *`,
      [pilot.id, verdict, req.body?.notes ?? null, req.user?.userId ?? null]);

    // Only a PASSED pilot stamps the profile as verified. A failed one leaves it
    // unverified, which is the honest state — the map was tried and was wrong.
    if (verdict === 'passed' && pilot.device_profile_id) {
      await client.query(
        `UPDATE iot_device_profiles
            SET verified_by_pilot_id = $2, verified_at = NOW(),
                addressing_mode = COALESCE($3, addressing_mode),
                byte_order      = COALESCE($4, byte_order),
                word_order      = COALESCE($5, word_order),
                updated_at = NOW()
          WHERE id = $1 AND company_id IS NOT NULL`,
        [pilot.device_profile_id, pilot.id, pilot.confirmed_addressing_mode,
         pilot.confirmed_byte_order, pilot.confirmed_word_order]);
    }
    await client.query('COMMIT');

    logAudit({
      userId: req.user?.userId, module: 'iot', recordId: pilot.id,
      recordType: 'iot_hardware_pilot', action: 'approve',
      oldData: pilot, newData: updated[0], req, company_id: pilot.company_id,
    });
    res.json({ ...updated[0], readings_recorded: readings.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[iot pilot complete]', e.message);
    res.status(500).json({ error: 'failed to complete pilot' });
  } finally { client.release(); }
});

// ── POST /iot/pilot-evidence — device-token, from the commissioning tool ───────
// The gateway's `verify.mjs --post` lands here. It authenticates with the device
// token because the tool runs on the gateway, which has no user session.
//
// It creates a pilot in 'in_progress' with the raw readings attached, and CANNOT
// create one that is already passed — the tool has no standing to say a device
// reads correctly, only that it answered.
deviceRouter.post('/pilot-evidence', async (req, res) => {
  try {
    const raw = req.get('X-Device-Token') || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const deviceUid = req.body?.device_uid;
    if (!raw || !deviceUid) return res.status(401).json({ error: 'device_uid and device token are required' });

    const { rows } = await pool.query(
      `SELECT id, company_id, telemetry_token_hash, device_profile_id, serial_number
         FROM customer_equipment WHERE device_uid = $1`, [deviceUid]);
    const eq = rows[0];
    const expected = eq?.telemetry_token_hash || '';
    const supplied = sha256(raw);
    const ok = expected.length === supplied.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
    if (!eq || !expected || !ok) return res.status(401).json({ error: 'invalid device credentials' });

    const ev = req.body?.evidence;
    if (!ev || !Array.isArray(ev.registers)) {
      return res.status(400).json({ error: 'evidence.registers[] is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: pilotRows } = await client.query(
        `INSERT INTO iot_hardware_pilots
           (company_id, equipment_id, device_profile_id, serial_number, host, port, unit_id,
            declared_addressing_mode, declared_byte_order, declared_word_order,
            performed_at, verdict, tool_version, raw_evidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz, NOW()),'in_progress',$12,$13::jsonb)
         RETURNING *`,
        [eq.company_id, eq.id, eq.device_profile_id, eq.serial_number,
         ev.device?.host ?? null, ev.device?.port ?? null, ev.device?.unit_id ?? null,
         ev.declared_conventions?.addressing_mode ?? null,
         ev.declared_conventions?.byte_order ?? null,
         ev.declared_conventions?.word_order ?? null,
         ev.performed_at ?? null, ev.version ?? null, JSON.stringify(ev)]);
      const pilot = pilotRows[0];

      let stored = 0;
      for (const r of ev.registers.slice(0, 200)) {
        // Prefer the reading under the DECLARED addressing mode; fall back to
        // whichever succeeded, so a misconfigured mode still lands its bytes.
        const declaredMode = ev.declared_conventions?.addressing_mode || 'one_based';
        const reading = r.readings?.[declaredMode]?.raw_hex ? r.readings[declaredMode]
          : (r.readings?.one_based?.raw_hex ? r.readings.one_based : r.readings?.zero_based);
        if (!reading) continue;
        await client.query(
          `INSERT INTO iot_hardware_pilot_readings
             (pilot_id, metric, documented_address, protocol_address, register_table, data_type,
              scale, reg_offset, unit, raw_hex, decoded_variants, verdict)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'pending')
           ON CONFLICT (pilot_id, metric) DO NOTHING`,
          [pilot.id, String(r.metric).slice(0, 40), r.documented_address ?? null,
           reading.protocol_address ?? null, r.table ?? null, r.type ?? null,
           r.scale ?? null, r.offset ?? null, r.unit ?? null,
           reading.raw_hex ?? null, JSON.stringify(reading.decoded ?? {})]);
        stored += 1;
      }
      await client.query('COMMIT');

      console.log(JSON.stringify({
        ts: new Date().toISOString(), level: 'INFO', event: 'iot_pilot_evidence_received',
        company_id: eq.company_id, equipment_id: eq.id, pilot_id: pilot.id, registers: stored,
      }));

      res.status(201).json({
        ok: true, pilot_id: pilot.id, registers_stored: stored, verdict: 'in_progress',
        next: 'Open IoT -> Hardware Pilots in Pulse and record, per register, what the device display and the reference instrument showed. A pilot cannot pass on read data alone.',
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  } catch (e) {
    console.error('[iot pilot-evidence]', e.message);
    res.status(500).json({ error: 'failed to store pilot evidence' });
  }
});

export default router;
export { deviceRouter, completionBlockers };
