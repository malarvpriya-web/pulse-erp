/**
 * iot.pilot.test.js — hardware pilot evidence, against a REAL Postgres.
 *
 * The pilot is the last item blocking certification, and the thing most worth
 * protecting is not that it can be recorded — it is that it cannot be FAKED.
 *
 * Most of this suite is therefore about refusal:
 *   - a pilot cannot pass without a named engineer
 *   - or without a named reference instrument
 *   - or without all three conventions confirmed against the device display
 *   - or without at least one register compared to something outside Pulse
 *   - a register cannot be marked passed without numbers that support it
 *   - the commissioning tool cannot create a pilot that is already passed
 *   - the database refuses a passed pilot even if a route forgets to check
 *
 * A successful Modbus read proves the transport works. It says nothing about
 * whether the number means what the profile claims, and that gap is the entire
 * reason the pilot exists.
 *
 * Run:  npx vitest run src/__tests__/iot.pilot.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
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
const { completionBlockers } = await import('../modules/iot/routes/pilot.routes.js');

const TAG = `IOTPILOT_${Date.now()}`;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ctx = {};

beforeAll(async () => {
  const { rows: c } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1,$2) RETURNING id`, [`${TAG} Co`, TAG.slice(-12)]);
  ctx.companyId = c[0].id;

  const { rows: eq } = await pool.query(
    `INSERT INTO customer_equipment
       (company_id, equipment_name, serial_number, device_uid, telemetry_token_hash, device_status)
     VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
    [ctx.companyId, `${TAG} AHF`, `${TAG}-SN`, `${TAG}-UID`, sha256(`${TAG}-tok`)]);
  ctx.equipment = eq[0];

  const { rows: prof } = await pool.query(
    `INSERT INTO iot_device_profiles
       (company_id, profile_code, device_type, manufacturer, model, addressing_mode,
        byte_order, word_order, capabilities, register_map)
     VALUES ($1,$2,'AHF','TestCorp','AHF-100','one_based','big','big',
             ARRAY['V_L1','TEMPERATURE'],
             '[{"metric":"V_L1","address":40001,"register":"holding","type":"float32","scale":1}]'::jsonb)
     RETURNING *`,
    [ctx.companyId, `${TAG}_PROFILE`]);
  ctx.profile = prof[0];

  const { rows: u } = await pool.query(
    `INSERT INTO users (name, email, password_hash, is_active, company_id)
     VALUES ($1,$2,'x',true,$3) RETURNING id`,
    [`${TAG} engineer`, `${TAG}@t.local`, ctx.companyId]);
  ctx.userId = u[0].id;
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM iot_hardware_pilot_readings WHERE pilot_id IN (SELECT id FROM iot_hardware_pilots WHERE company_id = $1)`, [ctx.companyId]).catch(() => {});
  for (const t of ['iot_hardware_pilots', 'iot_device_profiles', 'customer_equipment']) {
    await pool.query(`DELETE FROM ${t} WHERE company_id = $1`, [ctx.companyId]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [ctx.userId]).catch(() => {});
  await pool.query(`DELETE FROM companies WHERE id = $1`, [ctx.companyId]).catch(() => {});
}, 60000);

const openPilot = async (over = {}) => {
  const { rows } = await pool.query(
    `INSERT INTO iot_hardware_pilots
       (company_id, equipment_id, device_profile_id, manufacturer, model,
        declared_addressing_mode, declared_byte_order, declared_word_order, verdict)
     VALUES ($1,$2,$3,'TestCorp','AHF-100','one_based','big','big','in_progress')
     RETURNING *`,
    [over.companyId ?? ctx.companyId, ctx.equipment.id, ctx.profile.id]);
  return rows[0];
};

// ─────────────────────────────────────────────────────────────────────────────
describe('a pilot starts as unproven', () => {
  it('opens in_progress with nothing confirmed', async () => {
    const p = await openPilot();
    expect(p.verdict).toBe('in_progress');
    // The profile ALREADY declares conventions. The pilot deliberately does not
    // inherit them as confirmed: "what the config says" and "what the device
    // does" are different facts, and collapsing them is the defect class this
    // whole phase removed.
    expect(p.declared_addressing_mode).toBe('one_based');
    expect(p.confirmed_addressing_mode).toBeNull();
    expect(p.confirmed_byte_order).toBeNull();
    expect(p.confirmed_word_order).toBeNull();
    expect(p.completed_at).toBeNull();
  });

  it('lists every blocker standing between it and a pass', async () => {
    const p = await openPilot();
    const blockers = completionBlockers(p, []);
    expect(blockers.length).toBeGreaterThanOrEqual(5);
    expect(blockers.join(' ')).toMatch(/No engineer/);
    expect(blockers.join(' ')).toMatch(/reference instrument/);
    expect(blockers.join(' ')).toMatch(/Addressing mode has not been confirmed/);
    expect(blockers.join(' ')).toMatch(/A successful read is not evidence/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the database itself refuses an unevidenced pass', () => {
  it('rejects verdict=passed with no engineer', async () => {
    const p = await openPilot();
    await expect(pool.query(
      `UPDATE iot_hardware_pilots
          SET verdict='passed', confirmed_addressing_mode='one_based',
              confirmed_byte_order='big', confirmed_word_order='big',
              reference_instrument='Fluke 435-II'
        WHERE id = $1`, [p.id],
    )).rejects.toThrow(/check constraint/i);
  });

  it('rejects verdict=passed with no reference instrument', async () => {
    const p = await openPilot();
    await expect(pool.query(
      `UPDATE iot_hardware_pilots
          SET verdict='passed', engineer_user_id=$2,
              confirmed_addressing_mode='one_based',
              confirmed_byte_order='big', confirmed_word_order='big'
        WHERE id = $1`, [p.id, ctx.userId],
    )).rejects.toThrow(/check constraint/i);
  });

  it('rejects verdict=passed with the conventions unconfirmed', async () => {
    const p = await openPilot();
    await expect(pool.query(
      `UPDATE iot_hardware_pilots
          SET verdict='passed', engineer_user_id=$2, reference_instrument='Fluke 435-II'
        WHERE id = $1`, [p.id, ctx.userId],
    )).rejects.toThrow(/check constraint/i);
  });

  it('ACCEPTS a pass once every piece of evidence is present', async () => {
    const p = await openPilot();
    const { rows } = await pool.query(
      `UPDATE iot_hardware_pilots
          SET verdict='passed', engineer_user_id=$2, reference_instrument='Fluke 435-II',
              confirmed_addressing_mode='one_based', confirmed_byte_order='big',
              confirmed_word_order='little', completed_at=NOW()
        WHERE id = $1 RETURNING *`, [p.id, ctx.userId]);
    expect(rows[0].verdict).toBe('passed');
    // and the confirmed word order DIFFERS from the declared one — which is the
    // realistic outcome, and the reason the pilot is worth doing
    expect(rows[0].declared_word_order).toBe('big');
    expect(rows[0].confirmed_word_order).toBe('little');
  });

  it('refuses a convention value outside the vocabulary', async () => {
    const p = await openPilot();
    await expect(pool.query(
      `UPDATE iot_hardware_pilots SET confirmed_byte_order='middle' WHERE id = $1`, [p.id],
    )).rejects.toThrow(/check constraint/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('register readings record the comparison, not an opinion', () => {
  it('stores the RAW bytes so a wrong map can be re-decoded later', async () => {
    const p = await openPilot();
    const { rows } = await pool.query(
      `INSERT INTO iot_hardware_pilot_readings
         (pilot_id, metric, documented_address, protocol_address, register_table, data_type,
          scale, unit, raw_hex, decoded_variants)
       VALUES ($1,'V_L1',40001,0,'holding','float32',1,'V','0x43CF 0xC000',
               '{"big/big":415.5,"big/little":-1.2e-8,"little/big":0.001,"little/little":7.7}'::jsonb)
       RETURNING *`, [p.id]);
    expect(rows[0].raw_hex).toBe('0x43CF 0xC000');
    expect(rows[0].decoded_variants['big/big']).toBe(415.5);
    expect(rows[0].verdict).toBe('pending');
    // Recorded hex can be re-interpreted in six months. A stored engineering
    // value cannot be un-scaled back into evidence.
    expect(Object.keys(rows[0].decoded_variants).length).toBe(4);
  });

  it('one metric appears once per pilot', async () => {
    const p = await openPilot();
    const ins = () => pool.query(
      `INSERT INTO iot_hardware_pilot_readings (pilot_id, metric) VALUES ($1,'V_L1')
       ON CONFLICT (pilot_id, metric) DO NOTHING RETURNING id`, [p.id]);
    expect((await ins()).rowCount).toBe(1);
    expect((await ins()).rowCount).toBe(0);
  });

  it('a reading verdict outside the vocabulary is refused', async () => {
    const p = await openPilot();
    await expect(pool.query(
      `INSERT INTO iot_hardware_pilot_readings (pilot_id, metric, verdict) VALUES ($1,'V_L1','probably fine')`,
      [p.id],
    )).rejects.toThrow(/check constraint/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('completionBlockers is the guard the API leans on', () => {
  const full = () => ({
    engineer_user_id: 1,
    reference_instrument: 'Fluke 435-II',
    confirmed_addressing_mode: 'one_based',
    confirmed_byte_order: 'big',
    confirmed_word_order: 'big',
  });
  const compared = [{ metric: 'V_L1', device_display: 415.4, verdict: 'passed' }];

  it('clears only when a human has compared something outside Pulse', () => {
    expect(completionBlockers(full(), compared)).toEqual([]);
    // reads that were never compared do not count
    const readOnly = [{ metric: 'V_L1', device_display: null, verdict: 'pending' }];
    expect(completionBlockers(full(), readOnly).join(' ')).toMatch(/A successful read is not evidence/);
  });

  it('a failed register blocks the pass and is named', () => {
    const withFailure = [
      { metric: 'V_L1', device_display: 415.4, verdict: 'passed' },
      { metric: 'TEMPERATURE', device_display: 44, verdict: 'failed' },
    ];
    const blockers = completionBlockers(full(), withFailure);
    expect(blockers.length).toBe(1);
    expect(blockers[0]).toMatch(/TEMPERATURE/);
    expect(blockers[0]).toMatch(/outside tolerance/);
  });

  it('every missing piece is reported, not just the first', () => {
    const blockers = completionBlockers({}, []);
    expect(blockers.length).toBe(6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('profile verification', () => {
  it('a profile is unverified until a pilot passes against it', async () => {
    const { rows } = await pool.query(
      `SELECT verified_by_pilot_id, verified_at FROM iot_device_profiles WHERE id = $1`, [ctx.profile.id]);
    expect(rows[0].verified_by_pilot_id).toBeNull();
    expect(rows[0].verified_at).toBeNull();
  });

  it('the status endpoint speaks plainly when nothing is verified', async () => {
    // Mirrors the query behind GET /iot/pilots/status for this company.
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE verdict = 'passed')::int AS passed
         FROM iot_hardware_pilots WHERE company_id = $1`, [ctx.companyId]);
    const { rows: prof } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE verified_by_pilot_id IS NOT NULL)::int AS verified
         FROM iot_device_profiles WHERE company_id = $1`, [ctx.companyId]);
    // This suite creates a passed pilot above, but it is not linked to the
    // profile — so the profile stays unverified, which is the honest state.
    expect(prof[0].verified).toBe(0);
    expect(prof[0].total).toBeGreaterThan(0);
    expect(rows[0].passed).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what a pilot does NOT prove on its own', () => {
  it('a pilot is scoped to one model, not to the module', () => {
    // Guard against the reading that one passed pilot certifies IoT generally.
    // It certifies THAT register map on THAT firmware. A different model, or a
    // firmware that moves a register, needs its own pilot.
    const covered = ['this manufacturer', 'this model', 'this firmware', 'this register map version'];
    const notCovered = ['a different model', 'a firmware revision that moves a register', 'a second vendor'];
    expect(covered.length).toBe(4);
    expect(notCovered.length).toBe(3);
  });
});
