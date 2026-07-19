/**
 * 20260718000001_iot_telemetry.js
 *
 * Phase 1 of the IoT / Device Telemetry gap: the ingest data model.
 *
 * WHY NO NEW REGISTRY:
 *   Deployed units already live in `customer_equipment` (Phase 51,
 *   20260617000010) — company-scoped, with project_id, crm_account_id,
 *   serial_number, gps_lat/lng, warranty_expiry, amc_contract_id and service
 *   dates. This migration only EXTENDS it with the connectivity identity a
 *   telemetry pipeline needs; it does not duplicate the registry.
 *
 * STORAGE:
 *   `device_telemetry` is native-Postgres RANGE-partitioned by month. There is
 *   no TimescaleDB in this stack (verified), and native partitions carry us to
 *   low-millions of rows/month without new infrastructure. The table shape does
 *   not change if Timescale is adopted later. A DEFAULT partition catches any
 *   sample whose ts falls outside the pre-created monthly partitions so ingest
 *   never fails on a missing partition; a cron rolls new months forward.
 *
 * LATEST-VALUE CACHE:
 *   `device_latest` is an upsert-per-(equipment,metric) table standing in for
 *   the Redis cache named in the plan — Redis is not wired in this codebase, so
 *   this keeps "current reading" queries O(1) with zero new infra. Swap to
 *   Redis later without touching callers of the read API.
 *
 * SCOPING:
 *   Every table is company_id INTEGER NOT NULL DEFAULT 1. Nullable company_id
 *   is the documented scoping bug here (NULL rows are invisible to scoped users
 *   and read as 0 in KPIs); these tables start correct.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_iot_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[iot_telemetry] skipped (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── 1. Extend the EXISTING registry with connectivity identity ───────────────
  await safe('extend_customer_equipment', `
    ALTER TABLE customer_equipment
      ADD COLUMN IF NOT EXISTS device_uid          VARCHAR(120),
      ADD COLUMN IF NOT EXISTS telemetry_token_hash VARCHAR(64),
      ADD COLUMN IF NOT EXISTS comms_protocol      VARCHAR(30),
      ADD COLUMN IF NOT EXISTS sampling_secs       INTEGER,
      ADD COLUMN IF NOT EXISTS last_seen_at        TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS connection_state    VARCHAR(20) DEFAULT 'never'
  `);
  // device_uid is the gateway-reported hardware id; unique WHERE present so many
  // legacy rows with NULL device_uid coexist (partial unique index, not a column
  // UNIQUE which would collapse all NULLs into a single allowed row on some pg).
  await safe('uq_device_uid', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_equipment_device_uid
    ON customer_equipment(device_uid) WHERE device_uid IS NOT NULL
  `);

  // ── 2. device_telemetry — one row per sample, monthly RANGE partitions ───────
  await safe('create_device_telemetry', `
    CREATE TABLE IF NOT EXISTS device_telemetry (
      id           BIGSERIAL,
      company_id   INTEGER      NOT NULL DEFAULT 1,
      equipment_id INTEGER      NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      ts           TIMESTAMPTZ  NOT NULL,
      metric       VARCHAR(40)  NOT NULL,
      value        NUMERIC(14,4),
      quality      SMALLINT     NOT NULL DEFAULT 0,
      PRIMARY KEY (id, ts)
    ) PARTITION BY RANGE (ts)
  `);
  await safe('create_device_telemetry_default', `
    CREATE TABLE IF NOT EXISTS device_telemetry_default
    PARTITION OF device_telemetry DEFAULT
  `);
  // Pre-create the current month plus the next two so early ingest lands in a
  // dedicated partition, not the catch-all default.
  const monthStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  const base = monthStart(new Date());
  for (let i = 0; i < 3; i++) {
    const from = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i, 1));
    const to   = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + i + 1, 1));
    const name = `device_telemetry_${from.getUTCFullYear()}_${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
    await safe(`part_${name}`, `
      CREATE TABLE IF NOT EXISTS ${name}
      PARTITION OF device_telemetry
      FOR VALUES FROM ('${iso(from)}') TO ('${iso(to)}')
    `);
  }
  await safe('idx_telemetry_eq_metric_ts', `
    CREATE INDEX IF NOT EXISTS idx_device_telemetry_eq_metric_ts
    ON device_telemetry (equipment_id, metric, ts DESC)
  `);
  await safe('idx_telemetry_company', `
    CREATE INDEX IF NOT EXISTS idx_device_telemetry_company
    ON device_telemetry (company_id)
  `);

  // ── 3. device_latest — upsert-per-(equipment,metric) latest-value cache ───────
  await safe('create_device_latest', `
    CREATE TABLE IF NOT EXISTS device_latest (
      equipment_id INTEGER     NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      company_id   INTEGER     NOT NULL DEFAULT 1,
      metric       VARCHAR(40) NOT NULL,
      ts           TIMESTAMPTZ NOT NULL,
      value        NUMERIC(14,4),
      quality      SMALLINT    NOT NULL DEFAULT 0,
      PRIMARY KEY (equipment_id, metric)
    )
  `);

  // ── 4. device_alert_rules — threshold / stale rules ──────────────────────────
  // Phase 1 scope: rules target a specific equipment_id, OR are company-wide
  // (equipment_id IS NULL). Product-line templating is deferred — customer_equipment
  // identifies units by model_number/rating, not product_line_id, so there is no
  // clean join yet.
  await safe('create_device_alert_rules', `
    CREATE TABLE IF NOT EXISTS device_alert_rules (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER     NOT NULL DEFAULT 1,
      equipment_id INTEGER     REFERENCES customer_equipment(id) ON DELETE CASCADE,
      name         VARCHAR(120) NOT NULL,
      metric       VARCHAR(40)  NOT NULL,
      operator     VARCHAR(8)   NOT NULL DEFAULT '>',   -- > < >= <= = stale
      threshold    NUMERIC(14,4),
      stale_secs   INTEGER,                             -- for operator = 'stale'
      severity     VARCHAR(20)  NOT NULL DEFAULT 'warning', -- info | warning | critical
      is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
      created_by   INTEGER,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await safe('idx_rules_lookup', `
    CREATE INDEX IF NOT EXISTS idx_device_alert_rules_lookup
    ON device_alert_rules (company_id, metric, is_active)
  `);

  // ── 5. device_alerts — fired alerts, open -> acknowledged -> resolved ────────
  // work_order_id / ticket_id are plain INTEGERs, not FKs: the writers that
  // populate them (maintenance_logs, support_tickets) are wired in Phase 3, and
  // leaving them unconstrained avoids coupling this migration to those schemas.
  await safe('create_device_alerts', `
    CREATE TABLE IF NOT EXISTS device_alerts (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER     NOT NULL DEFAULT 1,
      equipment_id  INTEGER     NOT NULL REFERENCES customer_equipment(id) ON DELETE CASCADE,
      rule_id       INTEGER     REFERENCES device_alert_rules(id) ON DELETE SET NULL,
      metric        VARCHAR(40),
      value         NUMERIC(14,4),
      severity      VARCHAR(20) NOT NULL DEFAULT 'warning',
      state         VARCHAR(20) NOT NULL DEFAULT 'open', -- open | acknowledged | resolved
      message       TEXT,
      work_order_id INTEGER,
      ticket_id     INTEGER,
      opened_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_at  TIMESTAMPTZ,
      resolved_at      TIMESTAMPTZ
    )
  `);
  // One open alert per (equipment, rule) at a time — the ingest rule check relies
  // on this to avoid a flood of duplicate alerts while a condition persists.
  await safe('uq_open_alert', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_device_alerts_open
    ON device_alerts (equipment_id, rule_id) WHERE state <> 'resolved'
  `);
  await safe('idx_alerts_company_state', `
    CREATE INDEX IF NOT EXISTS idx_device_alerts_company_state
    ON device_alerts (company_id, state, opened_at DESC)
  `);

  console.log('[migration 20260718000001] iot_telemetry applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP TABLE IF EXISTS device_alerts CASCADE`);
  await safe(`DROP TABLE IF EXISTS device_alert_rules CASCADE`);
  await safe(`DROP TABLE IF EXISTS device_latest CASCADE`);
  await safe(`DROP TABLE IF EXISTS device_telemetry CASCADE`); // drops all partitions
  await safe(`DROP INDEX IF EXISTS uq_customer_equipment_device_uid`);
  await safe(`
    ALTER TABLE customer_equipment
      DROP COLUMN IF EXISTS device_uid,
      DROP COLUMN IF EXISTS telemetry_token_hash,
      DROP COLUMN IF EXISTS comms_protocol,
      DROP COLUMN IF EXISTS sampling_secs,
      DROP COLUMN IF EXISTS last_seen_at,
      DROP COLUMN IF EXISTS connection_state
  `);
}
