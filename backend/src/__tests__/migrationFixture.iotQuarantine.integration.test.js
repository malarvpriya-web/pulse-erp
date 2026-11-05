/**
 * Migration fixture: 20260915000001_iot_gap_closure (§226).
 *
 * Replaces "the archived rows are preserved" in iot.gapclosure, which could only
 * pass on the developer database (it counted that database's own quarantined
 * history). What the migration promises: every out-of-vocabulary alert and rule,
 * and every 'SEED %' latest/telemetry row, is copied WHOLE into
 * iot_legacy_quarantine with its reason and then removed; valid rows stay; the
 * seven constraints 20260914000001 added NOT VALID are then VALIDATED.
 *
 * Every step of this migration runs inside safe(): a failing step is rolled back
 * to a savepoint and only WARNED about. So this fixture fails if ANY step was
 * skipped — a before-state that silently lacked a table would otherwise pass.
 *
 * The before-state is 20260914000001's schema for the columns this migration
 * reads. Its constraint definitions are checked against that file's text below,
 * so the fixture cannot drift from the migration it stands in for.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
const { withFixtureDb, captureConsole } = await import('./helpers/migrationFixtureDb.js');
const migration = await import('../database/migrations/20260915000001_iot_gap_closure.js');
const PREDECESSOR = readFileSync(resolve(here, '../database/migrations/20260914000001_iot_phase4_industrial.js'), 'utf8');

// Verbatim from 20260914000001 (checked in the first test).
const CK = {
  ck_ce_device_status: `CHECK (device_status IN ('unprovisioned','active','disabled','revoked')) NOT VALID`,
  ck_iot_rule_operator: `CHECK (operator IN ('>','<','>=','<=','=','stale')) NOT VALID`,
  ck_iot_rule_severity: `CHECK (severity IN ('info','warning','critical')) NOT VALID`,
  ck_iot_alert_state: `CHECK (state IN ('pending_confirmation','active','acknowledged','recovery_pending','resolved','suppressed')) NOT VALID`,
  ck_iot_alert_severity: `CHECK (severity IN ('info','warning','critical')) NOT VALID`,
};
const EVENT_TYPES_BEFORE = `'ONLINE','OFFLINE','STALE','NEVER_CONNECTED','FAULT','RECOVERY',
                            'SERVICE_STARTED','SERVICE_COMPLETED','MAINTENANCE_START','MAINTENANCE_END',
                            'PROVISIONED','TOKEN_ROTATED','TOKEN_REVOKED','DISABLED','ENABLED'`;
const STEPS = ['quarantine_table', 'idx_quarantine', 'archive_alerts', 'delete_alerts', 'archive_rules', 'delete_rules',
  'archive_latest', 'delete_latest', 'archive_telemetry', 'delete_telemetry',
  'validate_alert_state', 'validate_alert_severity', 'validate_rule_operator', 'validate_rule_severity',
  'validate_device_status', 'validate_fk_rule', 'validate_fk_alert',
  'service_parts', 'idx_service_parts_eq', 'idx_service_parts_ticket', 'extend_event_types', 'extend_event_types_add',
  'notification_log', 'idx_notification_log', 'idx_notification_log_company', 'notification_rules'];

async function beforeState(c) {
  await c.query(`
    CREATE TABLE companies (id SERIAL PRIMARY KEY, name TEXT);
    CREATE TABLE customer_equipment (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, equipment_name TEXT,
      device_status VARCHAR(20) NOT NULL DEFAULT 'unprovisioned');
    ALTER TABLE customer_equipment ADD CONSTRAINT uq_customer_equipment_company_id UNIQUE (company_id, id);
    CREATE TABLE spare_parts (id SERIAL PRIMARY KEY, part_name TEXT);
    CREATE TABLE device_alert_rules (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL DEFAULT 1, equipment_id INTEGER,
      metric VARCHAR(40) NOT NULL, operator VARCHAR(8) NOT NULL DEFAULT '>', threshold NUMERIC(14,4),
      severity VARCHAR(20) NOT NULL DEFAULT 'warning');
    CREATE TABLE device_alerts (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL DEFAULT 1, equipment_id INTEGER NOT NULL,
      metric VARCHAR(40), value NUMERIC(14,4),
      severity VARCHAR(20) NOT NULL DEFAULT 'warning', state VARCHAR(20) NOT NULL DEFAULT 'open', message TEXT);
    CREATE TABLE device_latest (
      equipment_id INTEGER NOT NULL, company_id INTEGER NOT NULL DEFAULT 1, metric VARCHAR(40) NOT NULL,
      ts TIMESTAMPTZ NOT NULL, value NUMERIC(14,4), PRIMARY KEY (equipment_id, metric));
    CREATE TABLE device_telemetry (
      id BIGSERIAL PRIMARY KEY, company_id INTEGER NOT NULL DEFAULT 1, equipment_id INTEGER NOT NULL,
      ts TIMESTAMPTZ NOT NULL, metric VARCHAR(40) NOT NULL, value NUMERIC(14,4));
    CREATE TABLE iot_device_events (
      id BIGSERIAL PRIMARY KEY, company_id INTEGER NOT NULL,
      equipment_id INTEGER NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      event_type VARCHAR(30) NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT iot_device_events_event_type_check CHECK (event_type IN (${EVENT_TYPES_BEFORE})));
    CREATE TABLE notification_rules (
      id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL, event_key VARCHAR(100) NOT NULL,
      title VARCHAR(200) NOT NULL, channel VARCHAR(100) NOT NULL DEFAULT 'in_app',
      recipient_roles TEXT[] NOT NULL DEFAULT ARRAY['employee'], enabled BOOLEAN NOT NULL DEFAULT true,
      UNIQUE (company_id, event_key));`);
}

/**
 * What 20260914000001 did to that history: add the vocabulary and tenant
 * constraints NOT VALID — new writes checked, existing rows left alone. Run
 * AFTER the legacy rows exist, exactly as it was in the real sequence.
 */
async function predecessorConstraints(c) {
  await c.query(`
    ALTER TABLE customer_equipment ADD CONSTRAINT ck_ce_device_status ${CK.ck_ce_device_status};
    ALTER TABLE device_alert_rules ADD CONSTRAINT ck_iot_rule_operator ${CK.ck_iot_rule_operator};
    ALTER TABLE device_alert_rules ADD CONSTRAINT ck_iot_rule_severity ${CK.ck_iot_rule_severity};
    ALTER TABLE device_alert_rules ADD CONSTRAINT fk_rule_equipment_company
      FOREIGN KEY (company_id, equipment_id) REFERENCES customer_equipment (company_id, id) ON DELETE CASCADE NOT VALID;
    ALTER TABLE device_alerts ADD CONSTRAINT ck_iot_alert_state ${CK.ck_iot_alert_state};
    ALTER TABLE device_alerts ADD CONSTRAINT ck_iot_alert_severity ${CK.ck_iot_alert_severity};
    ALTER TABLE device_alerts ADD CONSTRAINT fk_alert_equipment_company
      FOREIGN KEY (company_id, equipment_id) REFERENCES customer_equipment (company_id, id) ON DELETE CASCADE NOT VALID;`);
}

/** Legacy rows as the pre-vocabulary code wrote them, plus valid neighbours. */
async function legacyData(c) {
  await c.query(`
    INSERT INTO companies (id, name) VALUES (1, 'Fixture Co');
    INSERT INTO customer_equipment (id, company_id, equipment_name, device_status) VALUES (1, 1, 'Chiller', 'active');
    INSERT INTO device_alerts (id, company_id, equipment_id, metric, value, severity, state, message) VALUES
      (1, 1, 1, 'THD_I_L1', 12.5, 'critical', 'active',     'valid alert'),
      (2, 1, 1, 'THD_I_L1', 13.0, 'critical', 'Tamil Nadu', 'state outside the vocabulary'),
      (3, 1, 1, 'V_L1',     251,  'high',     'active',     'severity outside the vocabulary'),
      (4, 1, 1, 'V_L2',     252,  'warning',  'open',       'the old column default state');
    INSERT INTO device_alert_rules (id, company_id, equipment_id, metric, operator, threshold, severity) VALUES
      (1, 1, 1, 'THD_I_L1', '>',  10, 'warning'),
      (2, 1, 1, 'V_L1',     'gt', 250, 'warning');
    INSERT INTO device_latest (equipment_id, company_id, metric, ts, value) VALUES
      (1, 1, 'THD_I_L1',     '2026-09-01T10:00:00Z', 12.5),
      (1, 1, 'SEED Probe 1', '2026-08-20T10:00:00Z', 1);
    INSERT INTO device_telemetry (id, company_id, equipment_id, ts, metric, value) VALUES
      (1, 1, 1, '2026-09-01T10:00:00Z', 'THD_I_L1', 12.5),
      (2, 1, 1, '2026-08-20T10:00:00Z', 'SEED Probe 1', 1);`);
}
const snap = async (c, sql) => (await c.query(sql)).rows.map((r) => r.j);
const skipped = (out) => out.warn.filter((w) => /\[iot_gap_closure\] skipped/.test(w));

describe('20260915000001 — legacy IoT rows are quarantined whole, then constraints validated', () => {
  it('the fixture constraints are the ones 20260914000001 declared', () => {
    for (const [name, def] of Object.entries(CK)) {
      expect(PREDECESSOR, name).toContain(`ADD CONSTRAINT ${name}\n      ${def}`);
    }
    expect(PREDECESSOR).toContain(`CHECK (event_type IN (${EVENT_TYPES_BEFORE}))`);
  });

  it('archives exactly the out-of-vocabulary and SEED rows, keeps the valid ones, validates, runs every step', async () => {
    await withFixtureDb('iot', async ({ client: c, apply }) => {
      await beforeState(c);
      await legacyData(c);
      await predecessorConstraints(c);
      const original = {
        alerts: await snap(c, `SELECT to_jsonb(a) j FROM device_alerts a WHERE id IN (2,3,4) ORDER BY id`),
        rule: await snap(c, `SELECT to_jsonb(r) j FROM device_alert_rules r WHERE id = 2`),
        latest: await snap(c, `SELECT to_jsonb(l) j FROM device_latest l WHERE metric LIKE 'SEED %'`),
        telemetry: await snap(c, `SELECT to_jsonb(t) j FROM device_telemetry t WHERE metric LIKE 'SEED %'`),
      };

      const out = await captureConsole(() => apply(migration));
      expect(skipped(out), 'every step must run').toEqual([]);

      const q = (await c.query(`
        SELECT source_table, source_id, company_id, reason, row_data, migration
          FROM iot_legacy_quarantine ORDER BY source_table, source_id`)).rows;
      expect(q.map((r) => [r.source_table, r.source_id, r.company_id, r.reason, r.migration])).toEqual([
        ['device_alert_rules', '2', 1, 'device_alert_rules.operator outside the declared vocabulary', '20260915000001_iot_gap_closure'],
        ['device_alerts', '2', 1, 'device_alerts.state outside the declared vocabulary', '20260915000001_iot_gap_closure'],
        ['device_alerts', '3', 1, 'device_alerts.severity outside the declared vocabulary', '20260915000001_iot_gap_closure'],
        ['device_alerts', '4', 1, 'device_alerts.state outside the declared vocabulary', '20260915000001_iot_gap_closure'],
        ['device_latest', '1:SEED Probe 1', 1, "metric name matches the seed-probe prefix 'SEED %'", '20260915000001_iot_gap_closure'],
        ['device_telemetry', '2', 1, "metric name matches the seed-probe prefix 'SEED %'", '20260915000001_iot_gap_closure'],
      ]);
      // The whole row is recoverable, not just an id.
      const data = (t) => q.filter((r) => r.source_table === t).map((r) => r.row_data);
      expect(data('device_alerts')).toEqual(original.alerts);
      expect(data('device_alert_rules')).toEqual(original.rule);
      expect(JSON.parse(JSON.stringify(data('device_latest')))).toEqual(JSON.parse(JSON.stringify(original.latest)));
      expect(JSON.parse(JSON.stringify(data('device_telemetry')))).toEqual(JSON.parse(JSON.stringify(original.telemetry)));

      // Valid rows stay; quarantined ones are gone from the live tables.
      expect((await c.query(`SELECT id FROM device_alerts ORDER BY id`)).rows).toEqual([{ id: 1 }]);
      expect((await c.query(`SELECT id FROM device_alert_rules ORDER BY id`)).rows).toEqual([{ id: 1 }]);
      expect((await c.query(`SELECT metric FROM device_latest`)).rows).toEqual([{ metric: 'THD_I_L1' }]);
      expect((await c.query(`SELECT id FROM device_telemetry`)).rows).toEqual([{ id: '1' }]);

      // All seven constraints are now VALIDATED.
      const { rows: cons } = await c.query(`
        SELECT conname, convalidated FROM pg_constraint
         WHERE conname IN ('ck_iot_alert_state','ck_iot_alert_severity','ck_iot_rule_operator','ck_iot_rule_severity',
                           'ck_ce_device_status','fk_rule_equipment_company','fk_alert_equipment_company') ORDER BY conname`);
      expect(cons).toHaveLength(7);
      expect(cons.filter((r) => !r.convalidated)).toEqual([]);

      // And a vocabulary violation is now refused rather than stored.
      expect((await c.query(`INSERT INTO device_alerts (company_id, equipment_id, severity, state) VALUES (1, 1, 'warning', 'open')`).catch((e) => e)).code).toBe('23514');

      // The rest of the migration landed too.
      expect((await c.query(`SELECT to_regclass('iot_service_parts') IS NOT NULL AND to_regclass('iot_notification_log') IS NOT NULL AS ok`)).rows[0].ok).toBe(true);
      await c.query(`INSERT INTO iot_device_events (company_id, equipment_id, event_type) VALUES (1, 1, 'PART_REPLACED')`);
      expect((await c.query(`SELECT COUNT(*)::int n FROM notification_rules WHERE company_id = 1 AND event_key LIKE 'iot.%'`)).rows[0].n).toBe(5);

      // Idempotent: a second run quarantines nothing more, skips nothing, adds no rules.
      const again = await captureConsole(() => apply(migration));
      expect(skipped(again)).toEqual([]);
      expect((await c.query(`SELECT COUNT(*)::int n FROM iot_legacy_quarantine`)).rows[0].n).toBe(6);
      expect((await c.query(`SELECT COUNT(*)::int n FROM notification_rules`)).rows[0].n).toBe(5);
    });
  }, 60000);

  it('reports a step it could not complete instead of passing silently (the skip check is real)', async () => {
    await withFixtureDb('iot', async ({ client: c, apply }) => {
      await beforeState(c);
      await legacyData(c);
      // A device_status outside the vocabulary: the migration does not quarantine
      // equipment, so validate_device_status cannot succeed.
      await c.query(`UPDATE customer_equipment SET device_status = 'online' WHERE id = 1`);
      await predecessorConstraints(c);
      const out = await captureConsole(() => apply(migration));
      expect(skipped(out)).toHaveLength(1);
      expect(skipped(out)[0]).toMatch(/skipped \(validate_device_status\)/);
      expect((await c.query(`SELECT convalidated FROM pg_constraint WHERE conname = 'ck_ce_device_status'`)).rows[0].convalidated).toBe(false);
      // Every other step still ran.
      expect(STEPS.filter((s) => out.warn.some((w) => w.includes(`(${s})`)))).toEqual(['validate_device_status']);
    });
  }, 60000);
});
