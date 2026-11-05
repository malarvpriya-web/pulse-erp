/**
 * iot.pilot.e2e.test.js — the pilot chain over real HTTP against a real Postgres.
 *
 *   commissioning-tool evidence (real bytes, captured below)
 *        -> POST /iot/pilot-evidence  (device token)
 *        -> a pilot in_progress carrying the RAW bytes
 *        -> complete REFUSED — a successful read is not evidence
 *        -> engineer records what the device display showed
 *        -> a register outside tolerance CANNOT be claimed as passed
 *        -> complete still refused while that register fails
 *        -> scale corrected, re-measured
 *        -> complete ACCEPTED, profile marked verified
 *
 * The middle steps are the point. The evidence comes from a device that really
 * answered, and the pilot STILL cannot pass, because reading a number is not the
 * same as knowing what the number means. That distinction is the only thing
 * standing between this module and a certification that would be a claim about
 * nothing.
 *
 * WHERE THE DEVICE HALF LIVES
 * ---------------------------
 * The live Modbus half — connect, read, decode under each convention, partial
 * failure, reconnect — is proven in `edge-gateway/__tests__/modbus.integration.test.mjs`
 * against a real Modbus TCP server, and the tool itself in
 * `edge-gateway/__tests__/verify.tool.test.mjs`.
 *
 * It is NOT imported here. A backend test that reaches into ../../../edge-gateway
 * makes the backend un-deployable on its own, and `moduleGraphGuard.test.js`
 * caught exactly that on the first attempt — correctly. The two packages meet
 * over HTTP, which is how they meet in production, so the fixture below is the
 * seam: the bytes are real (captured from that gateway suite's server), and this
 * file owns everything from the HTTP boundary inwards.
 *
 * Run:  npx vitest run src/__tests__/iot.pilot.e2e.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool } = await import('../config/db.js');
const { default: pilotRoutes, deviceRouter } = await import('../modules/iot/routes/pilot.routes.js');
const { buildApp } = await import('./helpers/testApp.js');

const TAG = `PILOTE2E_${Date.now()}`;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ctx = {};
let app;

/**
 * Evidence exactly as `verify.mjs` produces it, captured from the real Modbus TCP
 * server in edge-gateway/__tests__/modbus.integration.test.mjs.
 *
 * The bytes are genuine reads, not invented numbers:
 *   0x43CF 0xC000  IEEE-754 float32 = 415.5        (V_L1)
 *   0xFFCE         int16 = -50, which at the WRONG configured scale of 0.1
 *                  reads as -5 against a device display of 44 degC  (TEMPERATURE)
 *
 * The second one is the whole reason a pilot exists: the read succeeded, the
 * value is finite and plausible in isolation, and it is wrong by a factor of ten
 * with the sign inverted. Nothing in the pipeline can tell. Only the display can.
 */
const TOOL_EVIDENCE = {
  version: '1.0.0',
  device: { host: '127.0.0.1', port: 502, unit_id: 1 },
  declared_conventions: { addressing_mode: 'zero_based', byte_order: 'big', word_order: 'big' },
  // Left empty by the tool on purpose — see verify.tool.test.mjs, which asserts it.
  observed: { confirmed_addressing_mode: null, confirmed_byte_order: null, confirmed_word_order: null },
  registers: [
    {
      metric: 'V_L1', documented_address: 0, table: 'holding', type: 'float32', scale: 1, unit: 'V',
      readings: {
        one_based: { protocol_address: -1, error: 'protocol address -1 is negative under one_based' },
        zero_based: {
          protocol_address: 0, raw_hex: '0x43CF 0xC000', raw_words: [0x43CF, 0xC000],
          decoded: { 'big/big': 415.5, 'big/little': -2.0041, 'little/big': -2.0041, 'little/little': 415.5 },
        },
      },
    },
    {
      metric: 'TEMPERATURE', documented_address: 5, table: 'holding', type: 'int16', scale: 0.1, unit: 'degC',
      readings: {
        one_based: { protocol_address: 4, raw_hex: '0x0000', raw_words: [0], decoded: { 'big/big': 0, 'big/little': 0, 'little/big': 0, 'little/little': 0 } },
        zero_based: { protocol_address: 5, raw_hex: '0xFFCE', raw_words: [0xFFCE], decoded: { 'big/big': -5, 'big/little': -5, 'little/big': -5, 'little/little': -5 } },
      },
    },
  ],
};

function fakeAuth(userId, scope) {
  return (req, _res, next) => { req.user = { userId, roles: ['admin'] }; req.scope = scope; next(); };
}

beforeAll(async () => {
  const { rows: c } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} Co`, TAG.slice(-12)]);
  ctx.companyId = c[0].id;
  ctx.token = `${TAG}-token`;

  const { rows: eq } = await pool.query(
    `INSERT INTO customer_equipment
       (company_id, equipment_name, serial_number, device_uid, telemetry_token_hash, device_status)
     VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
    [ctx.companyId, `${TAG} AHF`, `${TAG}-SN`, `${TAG}-UID`, sha256(ctx.token)]);
  ctx.equipment = eq[0];

  const { rows: prof } = await pool.query(
    `INSERT INTO iot_device_profiles
       (company_id, profile_code, device_type, manufacturer, model,
        addressing_mode, byte_order, word_order, capabilities, register_map)
     VALUES ($1,$2,'AHF','TestCorp','AHF-100','zero_based','big','big',
             ARRAY['V_L1','TEMPERATURE'],'[]'::jsonb) RETURNING *`,
    [ctx.companyId, `${TAG}_PROFILE`]);
  ctx.profile = prof[0];
  await pool.query(`UPDATE customer_equipment SET device_profile_id = $2 WHERE id = $1`,
    [ctx.equipment.id, ctx.profile.id]);

  const { rows: admin } = await pool.query(
    `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id
      WHERE LOWER(r.code) IN ('admin','super_admin') AND u.is_active ORDER BY u.id LIMIT 1`);
  ctx.adminId = admin[0]?.id ?? null;

  app = buildApp(
    ['/iot', deviceRouter],
    ['/iot', fakeAuth(ctx.adminId, { company_id: ctx.companyId }), pilotRoutes],
  );
}, 60000);

afterAll(async () => {
  await pool.query(
    `DELETE FROM iot_hardware_pilot_readings WHERE pilot_id IN (SELECT id FROM iot_hardware_pilots WHERE company_id=$1)`,
    [ctx.companyId]).catch(() => {});
  for (const t of ['iot_hardware_pilots', 'customer_equipment', 'iot_device_profiles']) {
    await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [ctx.companyId]).catch(() => {});
  }
  await pool.query(`DELETE FROM companies WHERE id = $1`, [ctx.companyId]).catch(() => {});
}, 60000);

// ─────────────────────────────────────────────────────────────────────────────
describe('the pilot chain, end to end', () => {
  it('1 — the commissioning tool posts its evidence and gets an UNPROVEN pilot', async () => {
    const vl1 = TOOL_EVIDENCE.registers.find((r) => r.metric === 'V_L1');
    expect(vl1.readings.zero_based.raw_hex).toBe('0x43CF 0xC000');
    expect(vl1.readings.zero_based.decoded['big/big']).toBe(415.5);
    // The one_based read of address 0 resolves to protocol -1 and is refused,
    // which is the off-by-one the engineer needs to SEE rather than guess at.
    expect(vl1.readings.one_based.error).toBeTruthy();

    const res = await request(app).post('/iot/pilot-evidence')
      .set('X-Device-Token', ctx.token)
      .send({
        device_uid: ctx.equipment.device_uid,
        evidence: { ...TOOL_EVIDENCE, performed_at: new Date().toISOString() },
      });

    expect(res.status).toBe(201);
    expect(res.body.registers_stored).toBe(2);
    // The tool CANNOT create a passed pilot. It has no standing to say a device
    // reads correctly — only that it answered.
    expect(res.body.verdict).toBe('in_progress');
    ctx.pilotId = res.body.pilot_id;
  });

  it('2 — the raw bytes and every decode variant are stored for later re-interpretation', async () => {
    const { rows } = await pool.query(
      `SELECT * FROM iot_hardware_pilot_readings WHERE pilot_id = $1 ORDER BY metric`, [ctx.pilotId]);
    expect(rows.length).toBe(2);
    const v = rows.find((r) => r.metric === 'V_L1');
    expect(v.raw_hex).toBe('0x43CF 0xC000');
    expect(Object.keys(v.decoded_variants).length).toBe(4);
    // A stored engineering value cannot be un-scaled back into evidence; the hex can.
    expect(rows.every((r) => r.verdict === 'pending')).toBe(true);
  });

  it('3 — completion is REFUSED on read data alone, and every blocker is named', async () => {
    const res = await request(app).post(`/iot/pilots/${ctx.pilotId}/complete`).send({ verdict: 'passed' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PILOT_INCOMPLETE');
    expect(res.body.blockers.length).toBeGreaterThanOrEqual(4);
    expect(res.body.blockers.join(' ')).toMatch(/A successful read is not evidence/);
    expect(res.body.blockers.join(' ')).toMatch(/reference instrument/);
  });

  it('4 — the engineer records what the DEVICE display showed', async () => {
    const res = await request(app).put(`/iot/pilots/${ctx.pilotId}`).send({
      confirmed_addressing_mode: 'zero_based',
      confirmed_byte_order: 'big',
      confirmed_word_order: 'big',
      reference_instrument: 'Fluke 435-II, cal. 2026-03',
      engineer_name: 'E2E engineer',
    });
    expect(res.status).toBe(200);
    expect(res.body.confirmed_word_order).toBe('big');
  });

  it('5 — a register inside tolerance passes, with the difference COMPUTED', async () => {
    const res = await request(app).put(`/iot/pilots/${ctx.pilotId}/readings/V_L1`).send({
      pulse_value: 415.5, device_display: 415.4, reference_value: 415.6,
      tolerance_pct: 0.5, verdict: 'passed',
    });
    expect(res.status).toBe(200);
    expect(res.body.within_tolerance).toBe(true);
    expect(Math.abs(Number(res.body.difference_pct))).toBeLessThan(0.5);
  });

  it('6 — a register OUTSIDE tolerance cannot be claimed as passed', async () => {
    // The device reports -50 at the configured scale of 0.1 => -5, against a
    // display of 44. The scale is wrong, which is exactly the class of error the
    // pilot exists to catch — and a claim of "passed" must not override the numbers.
    const res = await request(app).put(`/iot/pilots/${ctx.pilotId}/readings/TEMPERATURE`).send({
      pulse_value: -5, device_display: 44.0, tolerance_pct: 2, verdict: 'passed',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_COMPARISON');
    expect(res.body.detail).toMatch(/difference is/);
  });

  it('7 — recorded honestly, it is auto-marked failed', async () => {
    const res = await request(app).put(`/iot/pilots/${ctx.pilotId}/readings/TEMPERATURE`).send({
      pulse_value: -5, device_display: 44.0, tolerance_pct: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('failed');
    expect(res.body.within_tolerance).toBe(false);
  });

  it('8 — the pilot still cannot pass while a register is failing, and it is named', async () => {
    const res = await request(app).post(`/iot/pilots/${ctx.pilotId}/complete`).send({ verdict: 'passed' });
    expect(res.status).toBe(409);
    expect(res.body.blockers.join(' ')).toMatch(/TEMPERATURE/);
    expect(res.body.blockers.join(' ')).toMatch(/outside tolerance/);
  });

  it('9 — with the scale corrected and re-measured, the pilot passes', async () => {
    await request(app).put(`/iot/pilots/${ctx.pilotId}/readings/TEMPERATURE`).send({
      pulse_value: 44.2, device_display: 44.0, reference_value: 44.1,
      tolerance_pct: 2, verdict: 'passed',
    });
    const res = await request(app).post(`/iot/pilots/${ctx.pilotId}/complete`)
      .send({ verdict: 'passed', notes: 'TEMPERATURE scale corrected to 1.0 after comparison' });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('passed');
    expect(res.body.completed_at).toBeTruthy();
  });

  it('10 — only now is the device profile marked verified, by THAT pilot', async () => {
    const { rows } = await pool.query(
      `SELECT verified_by_pilot_id, verified_at FROM iot_device_profiles WHERE id = $1`, [ctx.profile.id]);
    expect(rows[0].verified_by_pilot_id).toBe(ctx.pilotId);
    expect(rows[0].verified_at).toBeTruthy();
  });

  it('11 — the status endpoint stops saying the hardware is unvalidated', async () => {
    const res = await request(app).get('/iot/pilots/status');
    expect(res.status).toBe(200);
    expect(res.body.hardware_validated).toBe(true);
    expect(res.body.passed).toBeGreaterThanOrEqual(1);
    expect(res.body.verified_profiles).toBeGreaterThanOrEqual(1);
    expect(res.body.statement).toMatch(/pilot\(s\) passed/);
  });

  it('12 — a closed pilot can no longer be edited', async () => {
    const res = await request(app).put(`/iot/pilots/${ctx.pilotId}`).send({ notes: 'tampering' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PILOT_CLOSED');
  });
});

describe('the boundary between the two packages', () => {
  it('this suite owns the HTTP side; the gateway suite owns the device side', () => {
    // Recorded so the split is a decision rather than an accident. The first
    // version of this file imported the gateway's decoder directly and made the
    // backend un-deployable alone; moduleGraphGuard.test.js failed the build for
    // it, which is the guard doing its job.
    const provenHere = [
      'POST /iot/pilot-evidence accepts tool output under a device token',
      'raw bytes and all four decode variants are persisted',
      'a pilot cannot be completed on read data alone',
      'a register outside tolerance cannot be claimed as passed',
      'a passing pilot marks the profile verified',
    ];
    const provenInTheGatewaySuite = [
      'connecting to a real Modbus TCP server',
      'reading holding and input registers',
      'decoding under each byte/word convention over the wire',
      'partial read failure and reconnect',
      'the commissioning tool as a process',
    ];
    expect(provenHere.length).toBe(5);
    expect(provenInTheGatewaySuite.length).toBe(5);
  });
});
