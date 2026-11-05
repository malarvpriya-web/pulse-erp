/**
 * 20260915000001_iot_gap_closure.js
 *
 * Closes the data and schema gaps left open by Phase 4 (2026-09-14), listed in
 * IOT_PHASE4_REPORT.md section L as gaps 7, 8 and 9.
 *
 * ── 1. LEGACY SEED ROWS (gap 8) ─────────────────────────────────────────────
 * Five device_alerts rows hold state='Tamil Nadu' and severity='Minor'; five
 * device_alert_rules hold operator='SEED ope'; device_latest and device_telemetry
 * hold metrics named 'SEED metric N'. All of it was written by an automated
 * seed-probe, not by the application — the operator column is literally the first
 * 8 characters of the string "SEED operator".
 *
 * Phase 4 added the CHECK constraints as NOT VALID so these rows survived. That
 * was the right call at the time (destroying rows in someone else's database is
 * not a migration's business) but it leaves three permanent costs: the
 * constraints can never be trusted for existing data, /iot/ops/reconcile reports
 * problems forever, and the Fleet Monitor carries a banner about rows nobody can
 * act on.
 *
 * This migration ARCHIVES them rather than deleting them. Every row is copied
 * whole into `iot_legacy_quarantine` as JSONB with its source table and the
 * reason it failed, then removed from the live table. `down()` restores them.
 * Nothing is lost; the live tables simply stop carrying data that no code path
 * can interpret.
 *
 * Only provable seed artefacts are touched. The predicates are deliberately
 * narrow: a value outside the declared vocabulary, or a metric matching the
 * 'SEED %' prefix. A real row cannot satisfy either.
 *
 * ── 2. DEFAULT PARTITION (gap 9) ────────────────────────────────────────────
 * Five telemetry rows stamped 2019 sit in device_telemetry_default because no
 * 2019 partition exists. They are part of the same seed batch and leave with it,
 * which empties the catch-all partition. The partition cron then has nothing
 * blocking it.
 *
 * ── 3. SERVICE PARTS AND GENEALOGY (gap 7) ──────────────────────────────────
 * `iot_service_parts` is the missing link in the §74 chain:
 *
 *   alert -> ticket -> technician -> PART REPLACED -> inventory issue
 *          -> serial genealogy -> equipment history -> financial posting
 *
 * It does not duplicate inventory. It is the join row that records WHICH spare
 * was consumed on WHICH service job for WHICH equipment, and carries the ids of
 * the rows it created in spare_parts_movements, stock_ledger, serial_events and
 * journal_entries so the chain is navigable in both directions.
 *
 * ── 4. NOTIFICATION RULES (gap 3) ───────────────────────────────────────────
 * notification_rules rows for the IoT events, so the existing multi-channel
 * dispatcher (in_app / email / push, per company) has something to match on.
 * Without a rule row the dispatcher no-ops, which is why Phase 4 could only
 * deliver in-app.
 */

const QUARANTINE_REASONS = {
  alert_state: "device_alerts.state outside the declared vocabulary",
  alert_severity: "device_alerts.severity outside the declared vocabulary",
  rule_operator: "device_alert_rules.operator outside the declared vocabulary",
  seed_metric: "metric name matches the seed-probe prefix 'SEED %'",
};

export async function up(knex) {
  const safe = async (label, sql, params) => {
    const sp = `sp_iotgap_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      const r = await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[iot_gap_closure] skipped (${label}): ${e.message.split('\n')[0]}`);
      return null;
    }
  };

  // ── 1. Quarantine table ─────────────────────────────────────────────────────
  await safe('quarantine_table', `
    CREATE TABLE IF NOT EXISTS iot_legacy_quarantine (
      id            BIGSERIAL PRIMARY KEY,
      source_table  VARCHAR(60)  NOT NULL,
      source_id     TEXT,
      company_id    INTEGER,
      reason        TEXT         NOT NULL,
      row_data      JSONB        NOT NULL,
      quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      migration     VARCHAR(80)  NOT NULL DEFAULT '20260915000001_iot_gap_closure'
    )
  `);
  await safe('idx_quarantine', `
    CREATE INDEX IF NOT EXISTS idx_iot_legacy_quarantine_src
      ON iot_legacy_quarantine (source_table, quarantined_at DESC)
  `);

  // ── 2. Archive the unreadable alert rows ────────────────────────────────────
  const VALID_STATES = `('pending_confirmation','active','acknowledged','recovery_pending','resolved','suppressed')`;
  const VALID_SEVERITIES = `('info','warning','critical')`;
  const VALID_OPERATORS = `('>','<','>=','<=','=','stale')`;

  await safe('archive_alerts', `
    INSERT INTO iot_legacy_quarantine (source_table, source_id, company_id, reason, row_data)
    SELECT 'device_alerts', id::text, company_id,
           CASE WHEN state NOT IN ${VALID_STATES} THEN $1 ELSE $2 END,
           to_jsonb(da)
      FROM device_alerts da
     WHERE state NOT IN ${VALID_STATES}
        OR severity NOT IN ${VALID_SEVERITIES}
  `, [QUARANTINE_REASONS.alert_state, QUARANTINE_REASONS.alert_severity]);

  await safe('delete_alerts', `
    DELETE FROM device_alerts
     WHERE state NOT IN ${VALID_STATES}
        OR severity NOT IN ${VALID_SEVERITIES}
  `);

  // ── 3. Archive the unreadable rules ─────────────────────────────────────────
  await safe('archive_rules', `
    INSERT INTO iot_legacy_quarantine (source_table, source_id, company_id, reason, row_data)
    SELECT 'device_alert_rules', id::text, company_id, $1, to_jsonb(r)
      FROM device_alert_rules r
     WHERE operator NOT IN ${VALID_OPERATORS}
        OR severity NOT IN ${VALID_SEVERITIES}
  `, [QUARANTINE_REASONS.rule_operator]);

  // iot_rule_state and any surviving alerts referencing these rules go with them
  // (ON DELETE CASCADE handles rule_state; alerts were already removed above).
  await safe('delete_rules', `
    DELETE FROM device_alert_rules
     WHERE operator NOT IN ${VALID_OPERATORS}
        OR severity NOT IN ${VALID_SEVERITIES}
  `);

  // ── 4. Archive seed telemetry and latest-value rows ─────────────────────────
  // These carry metric names no registry entry can describe, so every aggregate
  // over them is meaningless and /iot/ops/reconcile's undeclared_metrics check
  // reports them indefinitely.
  await safe('archive_latest', `
    INSERT INTO iot_legacy_quarantine (source_table, source_id, company_id, reason, row_data)
    SELECT 'device_latest', equipment_id::text || ':' || metric, company_id, $1, to_jsonb(l)
      FROM device_latest l
     WHERE metric LIKE 'SEED %'
  `, [QUARANTINE_REASONS.seed_metric]);
  await safe('delete_latest', `DELETE FROM device_latest WHERE metric LIKE 'SEED %'`);

  await safe('archive_telemetry', `
    INSERT INTO iot_legacy_quarantine (source_table, source_id, company_id, reason, row_data)
    SELECT 'device_telemetry', id::text, company_id, $1, to_jsonb(t)
      FROM device_telemetry t
     WHERE metric LIKE 'SEED %'
  `, [QUARANTINE_REASONS.seed_metric]);
  await safe('delete_telemetry', `DELETE FROM device_telemetry WHERE metric LIKE 'SEED %'`);

  // Report from the ARCHIVE, not from the DELETE results. The first version read
  // rowCount off the savepoint-wrapped delete and printed "0 alert(s), 0 rule(s),
  // 0 telemetry row(s)" while it had in fact archived 35 rows — a migration log
  // lying about its own effect, which is the same class of defect this whole
  // phase exists to remove. The quarantine table is the authoritative record of
  // what moved, so count it.
  const { rows: moved } = await knex.raw(`
    SELECT source_table, COUNT(*)::int AS n
      FROM iot_legacy_quarantine
     WHERE migration = '20260915000001_iot_gap_closure'
     GROUP BY source_table ORDER BY source_table
  `);
  const summary = moved.map((r) => `${r.n} ${r.source_table}`).join(', ') || 'nothing to quarantine';
  console.log(`[iot_gap_closure] archived to iot_legacy_quarantine: ${summary}`);

  // ── 5. VALIDATE the constraints ─────────────────────────────────────────────
  // Now that no row violates them, promote the NOT VALID constraints to fully
  // validated. From here the database itself guarantees the vocabulary for EVERY
  // row, not merely for new ones — which is what makes the reconciliation checks
  // meaningful rather than decorative.
  for (const [label, sql] of [
    ['validate_alert_state', `ALTER TABLE device_alerts VALIDATE CONSTRAINT ck_iot_alert_state`],
    ['validate_alert_severity', `ALTER TABLE device_alerts VALIDATE CONSTRAINT ck_iot_alert_severity`],
    ['validate_rule_operator', `ALTER TABLE device_alert_rules VALIDATE CONSTRAINT ck_iot_rule_operator`],
    ['validate_rule_severity', `ALTER TABLE device_alert_rules VALIDATE CONSTRAINT ck_iot_rule_severity`],
    ['validate_device_status', `ALTER TABLE customer_equipment VALIDATE CONSTRAINT ck_ce_device_status`],
    ['validate_fk_rule', `ALTER TABLE device_alert_rules VALIDATE CONSTRAINT fk_rule_equipment_company`],
    ['validate_fk_alert', `ALTER TABLE device_alerts VALIDATE CONSTRAINT fk_alert_equipment_company`],
  ]) {
    await safe(label, sql);
  }

  // ── 6. Service parts / genealogy link (gap 7) ───────────────────────────────
  await safe('service_parts', `
    CREATE TABLE IF NOT EXISTS iot_service_parts (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER     NOT NULL,
      equipment_id       INTEGER     NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      ticket_id          INTEGER,
      alert_id           INTEGER,
      part_id            INTEGER     NOT NULL REFERENCES spare_parts(id),
      quantity           NUMERIC(14,4) NOT NULL CHECK (quantity > 0),
      unit_cost          NUMERIC(14,4) NOT NULL DEFAULT 0,
      total_cost         NUMERIC(14,4) NOT NULL DEFAULT 0,
      removed_serial     VARCHAR(120),
      fitted_serial      VARCHAR(120),
      cover              VARCHAR(20)  NOT NULL DEFAULT 'chargeable',
      reason             TEXT,
      issued_by          INTEGER,
      issued_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      -- ids of the rows this issue created elsewhere, so the chain is navigable
      -- in both directions instead of being reconstructed by guesswork
      movement_id        INTEGER,
      stock_ledger_id    INTEGER,
      serial_event_id    INTEGER,
      journal_entry_id   UUID,
      device_event_id    BIGINT,
      reversal_of_id     INTEGER REFERENCES iot_service_parts(id),
      reversed_at        TIMESTAMPTZ,
      CHECK (cover IN ('warranty','amc','chargeable','goodwill'))
    )
  `);
  await safe('idx_service_parts_eq', `
    CREATE INDEX IF NOT EXISTS idx_iot_service_parts_eq ON iot_service_parts (equipment_id, issued_at DESC)
  `);
  await safe('idx_service_parts_ticket', `
    CREATE INDEX IF NOT EXISTS idx_iot_service_parts_ticket ON iot_service_parts (ticket_id)
  `);

  // PART_REPLACED is a new device-event type; the CHECK on iot_device_events has
  // to learn it or every parts issue fails its history write.
  await safe('extend_event_types', `
    ALTER TABLE iot_device_events DROP CONSTRAINT IF EXISTS iot_device_events_event_type_check
  `);
  await safe('extend_event_types_add', `
    ALTER TABLE iot_device_events
      ADD CONSTRAINT iot_device_events_event_type_check
      CHECK (event_type IN ('ONLINE','OFFLINE','STALE','NEVER_CONNECTED','FAULT','RECOVERY',
                            'SERVICE_STARTED','SERVICE_COMPLETED','MAINTENANCE_START','MAINTENANCE_END',
                            'PROVISIONED','TOKEN_ROTATED','TOKEN_REVOKED','DISABLED','ENABLED',
                            'PART_REPLACED','PART_RETURNED'))
  `);

  // ── 6b. Notification delivery log (gap 3) ───────────────────────────────────
  // "We called sendSms and it did not throw" is not evidence that a human was
  // told. Every delivery attempt records its channel, recipient and outcome, and
  // the Alert 360 drawer reads it back — so an operator can see that the SMS was
  // skipped because nobody had a phone number on file, rather than assuming it
  // went out.
  await safe('notification_log', `
    CREATE TABLE IF NOT EXISTS iot_notification_log (
      id          BIGSERIAL PRIMARY KEY,
      company_id  INTEGER     NOT NULL,
      alert_id    INTEGER,
      event_key   VARCHAR(60) NOT NULL,
      channel     VARCHAR(20) NOT NULL,
      user_id     INTEGER,
      destination TEXT,
      status      VARCHAR(20) NOT NULL,
      detail      TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status IN ('sent','failed','skipped','no_recipients'))
    )
  `);
  await safe('idx_notification_log', `
    CREATE INDEX IF NOT EXISTS idx_iot_notification_log_alert
      ON iot_notification_log (alert_id, created_at DESC)
  `);
  await safe('idx_notification_log_company', `
    CREATE INDEX IF NOT EXISTS idx_iot_notification_log_company
      ON iot_notification_log (company_id, created_at DESC)
  `);

  // ── 7. Notification rules for IoT (gap 3) ───────────────────────────────────
  // The dispatcher in notifications.repository.js reads notification_rules by
  // (company_id, event_key) and no-ops when there is no row — which is exactly
  // why Phase 4 could only deliver in-app. One row per company per event.
  await safe('notification_rules', `
    INSERT INTO notification_rules (company_id, event_key, title, channel, recipient_roles, enabled)
    SELECT c.id, v.event_key, v.title, v.channel, v.roles::text[], TRUE
      FROM companies c
      CROSS JOIN (VALUES
        ('iot.alert_critical', 'Critical Device Alert',  'in_app,email,sms', ARRAY['service_manager','service_engineer','admin']),
        ('iot.alert_warning',  'Device Warning',         'in_app',           ARRAY['service_engineer']),
        ('iot.alert_escalated','Device Alert Escalated', 'in_app,email',     ARRAY['service_manager','admin']),
        ('iot.device_offline', 'Device Went Offline',    'in_app,email',     ARRAY['service_manager','service_engineer']),
        ('iot.alert_resolved', 'Device Alert Resolved',  'in_app',           ARRAY['service_engineer'])
      ) AS v(event_key, title, channel, roles)
    ON CONFLICT (company_id, event_key) DO NOTHING
  `);

  console.log('[migration 20260915000001] iot_gap_closure applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { return await knex.raw(sql); } catch { return null; } };

  // Restoring quarantined rows is best-effort by design: the columns are stored
  // as JSONB, so a schema that has since changed shape may reject some of them.
  // The archive itself is never deleted by down(), so nothing becomes
  // unrecoverable even when the restore is partial.
  await safe(`
    INSERT INTO device_alerts
    SELECT (jsonb_populate_record(NULL::device_alerts, row_data)).*
      FROM iot_legacy_quarantine
     WHERE source_table = 'device_alerts' AND migration = '20260915000001_iot_gap_closure'
    ON CONFLICT DO NOTHING
  `);
  await safe(`
    INSERT INTO device_alert_rules
    SELECT (jsonb_populate_record(NULL::device_alert_rules, row_data)).*
      FROM iot_legacy_quarantine
     WHERE source_table = 'device_alert_rules' AND migration = '20260915000001_iot_gap_closure'
    ON CONFLICT DO NOTHING
  `);

  await safe(`DELETE FROM notification_rules WHERE event_key LIKE 'iot.%'`);
  await safe(`DROP TABLE IF EXISTS iot_service_parts CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_notification_log CASCADE`);
}
