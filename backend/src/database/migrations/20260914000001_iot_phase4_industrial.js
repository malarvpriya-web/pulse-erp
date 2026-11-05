/**
 * 20260914000001_iot_phase4_industrial.js
 *
 * Phase 4 — makes the IoT pipeline industrially trustworthy. It does NOT create a
 * second equipment registry: customer_equipment stays the single identity, as
 * 20260718000001 established. Everything here either extends that row or adds a
 * table the telemetry pipeline genuinely lacked.
 *
 * WHY EACH PIECE EXISTS (audit findings, 2026-09-14):
 *
 *  - iot_metric_definitions: metrics were a free-text VARCHAR(40). "thd_i" had no
 *    unit, no physical range and no aggregation rule, so an out-of-range register
 *    read became a valid number and fed AVG/alerts/trend. Metrics are now declared.
 *
 *  - iot_device_profiles: the Modbus source hardcoded big-endian words and
 *    (address % 10000) - 1. That convention is one of several in the field; a
 *    device using little-endian word order silently produced garbage. Decoding is
 *    now driven by a profile, and a profile also declares WHICH metrics a model
 *    actually exposes (an SVG does not publish the same set as an AHF).
 *
 *  - device_telemetry.sample_uid/batch_uid/seq_no + UNIQUE(equipment_id,sample_uid,ts):
 *    identity was (BIGSERIAL id, ts). A gateway that committed a batch but lost the
 *    HTTP response resent it and got a SECOND copy of every sample. Retry is now a
 *    no-op at the database level, not at the application's discretion.
 *
 *  - device_telemetry.received_at + last_event_ts: ts was both the event time and
 *    the liveness signal, so a sample stamped 2099 made a dead device read "online".
 *    Liveness now comes from server receipt; event time stays the analytical axis.
 *
 *  - device_telemetry.quality_code: quality SMALLINT was written and never read.
 *
 *  - iot_ingest_batches: the batch ledger that lets a replayed batch return the
 *    ORIGINAL response instead of re-processing.
 *
 *  - iot_outbox: ticket creation used to run inside the ingest transaction. A SQL
 *    failure there aborts the Postgres transaction, and the handler's catch block
 *    then issues further statements on an aborted transaction. Telemetry and its
 *    consequences are now separated by an outbox.
 *
 *  - iot_rule_state / alert columns: an alert was a row, not a state machine. There
 *    was no persistence window, no clear threshold, no cooldown, no recovery and no
 *    maintenance suppression, so a metric oscillating across a threshold produced a
 *    new incident per batch.
 *
 *  - iot_device_events: MTBF/MTTR/uptime cannot be computed from a snapshot.
 *
 *  - iot_gateways: operators could not tell an equipment problem from a gateway or
 *    network problem.
 *
 *  - CHECK constraints: added NOT VALID. Five live device_alerts rows hold
 *    state='Tamil Nadu' and severity='Minor' (seed-probe garbage, verified
 *    2026-09-14). NOT VALID enforces the vocabulary on every new write without
 *    destroying rows this migration has no business deleting. They are reported by
 *    the reconciliation queries and by the Data Quality page.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_iot4_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[iot_phase4] skipped (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── 1. Metric registry ──────────────────────────────────────────────────────
  // company_id NULL = the global catalogue every tenant inherits. A tenant may
  // add its own rows; lookups prefer the tenant row over the global one.
  await safe('metric_definitions', `
    CREATE TABLE IF NOT EXISTS iot_metric_definitions (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER,
      metric_code       VARCHAR(40)  NOT NULL,
      display_name      VARCHAR(120) NOT NULL,
      unit              VARCHAR(24)  NOT NULL,
      data_type         VARCHAR(16)  NOT NULL DEFAULT 'number',
      description       TEXT,
      device_types      TEXT[]       NOT NULL DEFAULT '{}',
      min_physical      NUMERIC(18,6),
      max_physical      NUMERIC(18,6),
      precision_digits  SMALLINT     NOT NULL DEFAULT 3,
      sampling_expect_s INTEGER,
      aggregation       VARCHAR(16)  NOT NULL DEFAULT 'avg',
      quality_policy    VARCHAR(24)  NOT NULL DEFAULT 'valid_only',
      rising_is_bad     BOOLEAN      NOT NULL DEFAULT FALSE,
      is_counter        BOOLEAN      NOT NULL DEFAULT FALSE,
      enabled           BOOLEAN      NOT NULL DEFAULT TRUE,
      version           INTEGER      NOT NULL DEFAULT 1,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await safe('uq_metric_global', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_metric_global
      ON iot_metric_definitions (metric_code) WHERE company_id IS NULL
  `);
  await safe('uq_metric_company', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_metric_company
      ON iot_metric_definitions (company_id, metric_code) WHERE company_id IS NOT NULL
  `);

  // ── 2. Device profiles (capability + register map) ──────────────────────────
  await safe('device_profiles', `
    CREATE TABLE IF NOT EXISTS iot_device_profiles (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER,
      profile_code       VARCHAR(60)  NOT NULL,
      device_type        VARCHAR(24)  NOT NULL,
      manufacturer       VARCHAR(120),
      model              VARCHAR(120),
      firmware           VARCHAR(60),
      register_map_ver   VARCHAR(30),
      protocol           VARCHAR(30)  NOT NULL DEFAULT 'modbus_tcp',
      addressing_mode    VARCHAR(16)  NOT NULL DEFAULT 'one_based',
      byte_order         VARCHAR(16)  NOT NULL DEFAULT 'big',
      word_order         VARCHAR(16)  NOT NULL DEFAULT 'big',
      default_sampling_s INTEGER      NOT NULL DEFAULT 60,
      capabilities       TEXT[]       NOT NULL DEFAULT '{}',
      register_map       JSONB        NOT NULL DEFAULT '[]'::jsonb,
      is_template        BOOLEAN      NOT NULL DEFAULT FALSE,
      enabled            BOOLEAN      NOT NULL DEFAULT TRUE,
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await safe('uq_profile_global', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_profile_global
      ON iot_device_profiles (profile_code) WHERE company_id IS NULL
  `);
  await safe('uq_profile_company', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_profile_company
      ON iot_device_profiles (company_id, profile_code) WHERE company_id IS NOT NULL
  `);

  // ── 3. Gateways ─────────────────────────────────────────────────────────────
  await safe('gateways', `
    CREATE TABLE IF NOT EXISTS iot_gateways (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER      NOT NULL,
      gateway_uid       VARCHAR(120) NOT NULL,
      name              VARCHAR(160),
      site_location     TEXT,
      version           VARCHAR(40),
      status            VARCHAR(20)  NOT NULL DEFAULT 'registered',
      last_heartbeat_at TIMESTAMPTZ,
      last_success_at   TIMESTAMPTZ,
      last_failure_at   TIMESTAMPTZ,
      queue_depth       INTEGER      NOT NULL DEFAULT 0,
      oldest_queued_ts  TIMESTAMPTZ,
      spool_bytes       BIGINT       NOT NULL DEFAULT 0,
      disk_free_bytes   BIGINT,
      device_count      INTEGER      NOT NULL DEFAULT 0,
      error_count       INTEGER      NOT NULL DEFAULT 0,
      dead_letter_count INTEGER      NOT NULL DEFAULT 0,
      retry_count       INTEGER      NOT NULL DEFAULT 0,
      poll_secs         INTEGER,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await safe('uq_gateway_uid', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_gateway_uid ON iot_gateways (gateway_uid)
  `);

  // ── 4. Extend customer_equipment ────────────────────────────────────────────
  // NOTE: ADD COLUMN IF NOT EXISTS is a NO-OP when the column exists with another
  // type — none of these names exist on the table (verified against
  // information_schema on 2026-09-14), so each one is a genuine add.
  await safe('extend_equipment', `
    ALTER TABLE customer_equipment
      ADD COLUMN IF NOT EXISTS device_profile_id   INTEGER REFERENCES iot_device_profiles(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS gateway_id          INTEGER REFERENCES iot_gateways(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS device_status       VARCHAR(20) NOT NULL DEFAULT 'unprovisioned',
      ADD COLUMN IF NOT EXISTS last_event_ts       TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_poll_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_success_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_failure_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS actual_sampling_secs INTEGER,
      ADD COLUMN IF NOT EXISTS provisioned_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS disabled_at         TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS disabled_by         INTEGER,
      ADD COLUMN IF NOT EXISTS disabled_reason     TEXT
  `);
  await safe('equipment_status_backfill', `
    UPDATE customer_equipment
       SET device_status = 'active'
     WHERE device_uid IS NOT NULL AND device_status = 'unprovisioned'
  `);
  await safe('ck_device_status', `
    ALTER TABLE customer_equipment
      ADD CONSTRAINT ck_ce_device_status
      CHECK (device_status IN ('unprovisioned','active','disabled','revoked')) NOT VALID
  `);

  // ── 5. Device token lifecycle ───────────────────────────────────────────────
  // customer_equipment.telemetry_token_hash stays as the fast lookup the ingest
  // path reads; this table is the full history, so a rotation or revocation is
  // attributable rather than being an overwrite with no record.
  await safe('device_tokens', `
    CREATE TABLE IF NOT EXISTS iot_device_tokens (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER     NOT NULL,
      equipment_id  INTEGER     NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      token_hash    VARCHAR(64) NOT NULL,
      token_prefix  VARCHAR(12),
      status        VARCHAR(16) NOT NULL DEFAULT 'active',
      created_by    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rotated_by    INTEGER,
      rotated_at    TIMESTAMPTZ,
      revoked_by    INTEGER,
      revoked_at    TIMESTAMPTZ,
      expires_at    TIMESTAMPTZ,
      last_used_at  TIMESTAMPTZ,
      reason        TEXT
    )
  `);
  await safe('idx_tokens_eq', `
    CREATE INDEX IF NOT EXISTS idx_iot_device_tokens_eq ON iot_device_tokens (equipment_id, status)
  `);
  await safe('uq_token_active', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_device_token_active
      ON iot_device_tokens (equipment_id) WHERE status = 'active'
  `);

  // ── 6. Telemetry identity, receipt time and quality ─────────────────────────
  await safe('extend_telemetry', `
    ALTER TABLE device_telemetry
      ADD COLUMN IF NOT EXISTS received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS sample_uid   VARCHAR(80),
      ADD COLUMN IF NOT EXISTS batch_uid    VARCHAR(80),
      ADD COLUMN IF NOT EXISTS seq_no       BIGINT,
      ADD COLUMN IF NOT EXISTS quality_code VARCHAR(24) NOT NULL DEFAULT 'VALID',
      ADD COLUMN IF NOT EXISTS gateway_id   INTEGER,
      ADD COLUMN IF NOT EXISTS unit         VARCHAR(24)
  `);
  // The dedup key. Three things about its shape are deliberate:
  //
  //  - ts is part of it because ts is the partition key and a partitioned unique
  //    index must contain it. Harmless: a retry resends the identical event
  //    timestamp, so the tuple still collides.
  //
  //  - it is NOT a partial index. The first draft was
  //    `... WHERE sample_uid IS NOT NULL`, to let legacy rows with a NULL
  //    sample_uid coexist. That version cannot be used as an ON CONFLICT arbiter
  //    unless every INSERT repeats the predicate, and Postgres reports the
  //    mismatch as "there is no unique or exclusion constraint matching the ON
  //    CONFLICT specification" — which the ingest path would hit on its very
  //    first duplicate, i.e. exactly when deduplication is supposed to work. The
  //    Phase 4 test suite caught it.
  //
  //  - a plain unique index is sufficient for the legacy rows anyway: unique
  //    indexes treat NULLs as distinct by default, so any number of pre-Phase-4
  //    rows with sample_uid IS NULL still coexist.
  await safe('drop_partial_sample_idx', `DROP INDEX IF EXISTS uq_device_telemetry_sample`);
  await safe('uq_telemetry_sample', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_device_telemetry_sample
      ON device_telemetry (equipment_id, sample_uid, ts)
  `);
  await safe('idx_telemetry_received', `
    CREATE INDEX IF NOT EXISTS idx_device_telemetry_received ON device_telemetry (received_at DESC)
  `);
  await safe('idx_telemetry_quality', `
    CREATE INDEX IF NOT EXISTS idx_device_telemetry_quality ON device_telemetry (company_id, quality_code)
  `);

  await safe('extend_latest', `
    ALTER TABLE device_latest
      ADD COLUMN IF NOT EXISTS received_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS quality_code VARCHAR(24) NOT NULL DEFAULT 'VALID',
      ADD COLUMN IF NOT EXISTS unit         VARCHAR(24)
  `);

  // ── 7. Batch ledger (idempotent replay) ─────────────────────────────────────
  await safe('ingest_batches', `
    CREATE TABLE IF NOT EXISTS iot_ingest_batches (
      id            BIGSERIAL PRIMARY KEY,
      company_id    INTEGER     NOT NULL,
      equipment_id  INTEGER     NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      gateway_uid   VARCHAR(120),
      batch_uid     VARCHAR(80) NOT NULL,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sample_count  INTEGER     NOT NULL DEFAULT 0,
      accepted      INTEGER     NOT NULL DEFAULT 0,
      duplicates    INTEGER     NOT NULL DEFAULT 0,
      rejected      INTEGER     NOT NULL DEFAULT 0,
      response      JSONB
    )
  `);
  await safe('uq_batch', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_ingest_batch ON iot_ingest_batches (equipment_id, batch_uid)
  `);
  await safe('idx_batch_recv', `
    CREATE INDEX IF NOT EXISTS idx_iot_ingest_batch_recv ON iot_ingest_batches (company_id, received_at DESC)
  `);

  // ── 8. Rejected / quarantined samples (dead-letter for ingest) ──────────────
  await safe('rejected_samples', `
    CREATE TABLE IF NOT EXISTS iot_rejected_samples (
      id           BIGSERIAL PRIMARY KEY,
      company_id   INTEGER     NOT NULL,
      equipment_id INTEGER,
      gateway_uid  VARCHAR(120),
      batch_uid    VARCHAR(80),
      sample_uid   VARCHAR(80),
      metric       VARCHAR(40),
      raw_value    TEXT,
      event_ts     TIMESTAMPTZ,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reason       VARCHAR(40) NOT NULL,
      detail       TEXT
    )
  `);
  await safe('idx_rejected', `
    CREATE INDEX IF NOT EXISTS idx_iot_rejected ON iot_rejected_samples (company_id, received_at DESC)
  `);

  // ── 9. Outbox ───────────────────────────────────────────────────────────────
  await safe('outbox', `
    CREATE TABLE IF NOT EXISTS iot_outbox (
      id              BIGSERIAL PRIMARY KEY,
      company_id      INTEGER     NOT NULL,
      topic           VARCHAR(40) NOT NULL,
      dedupe_key      VARCHAR(160) NOT NULL,
      payload         JSONB       NOT NULL,
      status          VARCHAR(16) NOT NULL DEFAULT 'pending',
      attempts        INTEGER     NOT NULL DEFAULT 0,
      max_attempts    INTEGER     NOT NULL DEFAULT 8,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at    TIMESTAMPTZ
    )
  `);
  await safe('uq_outbox_dedupe', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_outbox_dedupe ON iot_outbox (dedupe_key)
  `);
  await safe('idx_outbox_due', `
    CREATE INDEX IF NOT EXISTS idx_iot_outbox_due ON iot_outbox (status, next_attempt_at)
  `);

  // ── 10. Alert rules: the state-machine parameters ───────────────────────────
  await safe('extend_rules', `
    ALTER TABLE device_alert_rules
      ADD COLUMN IF NOT EXISTS clear_threshold   NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS persistence_secs  INTEGER     NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS recovery_secs     INTEGER     NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS cooldown_secs     INTEGER     NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS suppress_in_maintenance BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS notify_channels   TEXT[]      NOT NULL DEFAULT '{in_app}',
      ADD COLUMN IF NOT EXISTS notify_roles      TEXT[]      NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS notify_user_ids   INTEGER[]   NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS escalation_mins   INTEGER,
      ADD COLUMN IF NOT EXISTS repeat_mins       INTEGER,
      ADD COLUMN IF NOT EXISTS create_ticket     BOOLEAN     NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS active_from       TIME,
      ADD COLUMN IF NOT EXISTS active_to         TIME,
      ADD COLUMN IF NOT EXISTS quality_policy    VARCHAR(24) NOT NULL DEFAULT 'valid_only',
      ADD COLUMN IF NOT EXISTS updated_by        INTEGER
  `);
  await safe('ck_rule_operator', `
    ALTER TABLE device_alert_rules
      ADD CONSTRAINT ck_iot_rule_operator
      CHECK (operator IN ('>','<','>=','<=','=','stale')) NOT VALID
  `);
  await safe('ck_rule_severity', `
    ALTER TABLE device_alert_rules
      ADD CONSTRAINT ck_iot_rule_severity
      CHECK (severity IN ('info','warning','critical')) NOT VALID
  `);

  // ── 11. Alerts: incident identity + state machine ───────────────────────────
  await safe('extend_alerts', `
    ALTER TABLE device_alerts
      ADD COLUMN IF NOT EXISTS incident_uid      VARCHAR(80),
      ADD COLUMN IF NOT EXISTS first_detected_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_detected_at  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS breach_count      INTEGER     NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS observed_value    NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS worst_value       NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS threshold         NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS clear_threshold   NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS unit              VARCHAR(24),
      ADD COLUMN IF NOT EXISTS quality_code      VARCHAR(24),
      ADD COLUMN IF NOT EXISTS acknowledged_by   INTEGER,
      ADD COLUMN IF NOT EXISTS resolved_by       INTEGER,
      ADD COLUMN IF NOT EXISTS resolution_reason TEXT,
      ADD COLUMN IF NOT EXISTS resolution_source VARCHAR(30),
      ADD COLUMN IF NOT EXISTS recovery_since    TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS suppressed_until  TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS notified_at       TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS escalated_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS last_notified_at  TIMESTAMPTZ
  `);
  await safe('backfill_alert_times', `
    UPDATE device_alerts
       SET first_detected_at = COALESCE(first_detected_at, opened_at),
           last_detected_at  = COALESCE(last_detected_at, opened_at)
     WHERE first_detected_at IS NULL OR last_detected_at IS NULL
  `);
  await safe('ck_alert_state', `
    ALTER TABLE device_alerts
      ADD CONSTRAINT ck_iot_alert_state
      CHECK (state IN ('pending_confirmation','active','acknowledged','recovery_pending','resolved','suppressed')) NOT VALID
  `);
  await safe('ck_alert_severity', `
    ALTER TABLE device_alerts
      ADD CONSTRAINT ck_iot_alert_severity
      CHECK (severity IN ('info','warning','critical')) NOT VALID
  `);
  // Replace the old open-alert index. The old one was WHERE state <> 'resolved',
  // which five rows holding state='Tamil Nadu' satisfied — permanently occupying
  // the open slot for equipment 37-41 so no genuine alert could ever open on them.
  // The replacement names the live states explicitly, so an unrecognised state
  // cannot block a real incident.
  await safe('drop_old_open_idx', `DROP INDEX IF EXISTS uq_device_alerts_open`);
  await safe('uq_alert_live', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_device_alerts_live
      ON device_alerts (equipment_id, rule_id)
      WHERE state IN ('pending_confirmation','active','acknowledged','recovery_pending')
  `);
  await safe('uq_alert_incident', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_device_alerts_incident
      ON device_alerts (incident_uid) WHERE incident_uid IS NOT NULL
  `);
  await safe('idx_alerts_equipment', `
    CREATE INDEX IF NOT EXISTS idx_device_alerts_equipment ON device_alerts (equipment_id, opened_at DESC)
  `);

  // ── 12. Rule runtime state (persistence / hysteresis / cooldown) ────────────
  await safe('rule_state', `
    CREATE TABLE IF NOT EXISTS iot_rule_state (
      rule_id        INTEGER     NOT NULL REFERENCES device_alert_rules(id) ON DELETE CASCADE,
      equipment_id   INTEGER     NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      company_id     INTEGER     NOT NULL,
      breach_since   TIMESTAMPTZ,
      clear_since    TIMESTAMPTZ,
      last_event_ts  TIMESTAMPTZ,
      last_value     NUMERIC(14,4),
      cooldown_until TIMESTAMPTZ,
      alert_id       INTEGER,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (rule_id, equipment_id)
    )
  `);

  // ── 13. Maintenance windows ─────────────────────────────────────────────────
  await safe('maintenance_windows', `
    CREATE TABLE IF NOT EXISTS iot_maintenance_windows (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER     NOT NULL,
      equipment_id   INTEGER     NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      starts_at      TIMESTAMPTZ NOT NULL,
      ends_at        TIMESTAMPTZ NOT NULL,
      reason         TEXT        NOT NULL,
      authorized_by  INTEGER,
      ticket_id      INTEGER,
      cancelled_at   TIMESTAMPTZ,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (ends_at > starts_at)
    )
  `);
  await safe('idx_maint_window', `
    CREATE INDEX IF NOT EXISTS idx_iot_maint_window
      ON iot_maintenance_windows (equipment_id, starts_at, ends_at)
  `);

  // ── 14. Device event history (uptime / MTBF / MTTR) ─────────────────────────
  await safe('device_events', `
    CREATE TABLE IF NOT EXISTS iot_device_events (
      id           BIGSERIAL PRIMARY KEY,
      company_id   INTEGER     NOT NULL,
      equipment_id INTEGER     NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      event_type   VARCHAR(30) NOT NULL,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source       VARCHAR(30) NOT NULL DEFAULT 'system',
      alert_id     INTEGER,
      ticket_id    INTEGER,
      detail       JSONB,
      CHECK (event_type IN ('ONLINE','OFFLINE','STALE','NEVER_CONNECTED','FAULT','RECOVERY',
                            'SERVICE_STARTED','SERVICE_COMPLETED','MAINTENANCE_START','MAINTENANCE_END',
                            'PROVISIONED','TOKEN_ROTATED','TOKEN_REVOKED','DISABLED','ENABLED'))
    )
  `);
  await safe('idx_device_events', `
    CREATE INDEX IF NOT EXISTS idx_iot_device_events
      ON iot_device_events (equipment_id, occurred_at DESC)
  `);

  // ── 15. Rule ↔ equipment company equality, enforced in the database ─────────
  // A composite FK is the mechanism: it is impossible to point a rule at
  // equipment in another company once (company_id, id) is the referenced key.
  await safe('uq_equipment_company_id', `
    ALTER TABLE customer_equipment
      ADD CONSTRAINT uq_customer_equipment_company_id UNIQUE (company_id, id)
  `);
  await safe('fk_rule_equipment_company', `
    ALTER TABLE device_alert_rules
      ADD CONSTRAINT fk_rule_equipment_company
      FOREIGN KEY (company_id, equipment_id)
      REFERENCES customer_equipment (company_id, id) ON DELETE CASCADE NOT VALID
  `);
  await safe('fk_alert_equipment_company', `
    ALTER TABLE device_alerts
      ADD CONSTRAINT fk_alert_equipment_company
      FOREIGN KEY (company_id, equipment_id)
      REFERENCES customer_equipment (company_id, id) ON DELETE CASCADE NOT VALID
  `);

  console.log('[migration 20260914000001] iot_phase4_industrial applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`ALTER TABLE device_alerts DROP CONSTRAINT IF EXISTS fk_alert_equipment_company`);
  await safe(`ALTER TABLE device_alert_rules DROP CONSTRAINT IF EXISTS fk_rule_equipment_company`);
  await safe(`ALTER TABLE customer_equipment DROP CONSTRAINT IF EXISTS uq_customer_equipment_company_id`);
  await safe(`DROP TABLE IF EXISTS iot_device_events CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_maintenance_windows CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_rule_state CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_outbox CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_rejected_samples CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_ingest_batches CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_device_tokens CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_device_profiles CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_metric_definitions CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_gateways CASCADE`);
}
