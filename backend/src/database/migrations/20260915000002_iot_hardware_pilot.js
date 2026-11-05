/**
 * 20260915000002_iot_hardware_pilot.js
 *
 * Pilot evidence, stored.
 *
 * WHY
 * ---
 * IOT_HARDWARE_PILOT.md was a markdown form. A form is where a result goes to be
 * forgotten: it is filled in once on site, photographed, and never seen again by
 * the system that depends on it. Six months later, when a reading looks wrong,
 * nobody can answer "was this register ever verified, by whom, against what?"
 *
 * These two tables make the answer queryable:
 *
 *   iot_hardware_pilots            one pilot run against one device
 *   iot_hardware_pilot_readings    one row per register, with the RAW bytes
 *
 * Raw bytes are recorded deliberately. If a register map turns out to be wrong
 * later, recorded hex can be re-decoded under a different convention; a recorded
 * engineering value cannot be un-scaled back into evidence.
 *
 * WHAT THE SCHEMA REFUSES TO ASSUME
 * ---------------------------------
 * `verdict` starts as 'in_progress' and only a human moves it. There is no code
 * path that marks a pilot passed — not from the commissioning tool, not from a
 * cron, not from a successful read. A pilot passes when an engineer says the
 * values matched the device display and a reference instrument, and that
 * statement carries their user id.
 *
 * `confirmed_*` columns are NULLABLE and start NULL even though the profile
 * already carries declared values, because "what the config says" and "what the
 * device does" are different facts and collapsing them is the whole defect class
 * this phase exists to remove.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_iotpilot_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[iot_hardware_pilot] skipped (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  await safe('pilots', `
    CREATE TABLE IF NOT EXISTS iot_hardware_pilots (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER     NOT NULL,
      equipment_id       INTEGER     REFERENCES customer_equipment(id) ON DELETE SET NULL,
      device_profile_id  INTEGER     REFERENCES iot_device_profiles(id) ON DELETE SET NULL,

      -- what was in front of the engineer
      manufacturer       VARCHAR(120),
      model              VARCHAR(120),
      firmware           VARCHAR(60),
      serial_number      VARCHAR(120),
      register_map_ver   VARCHAR(30),
      site               TEXT,

      -- how it was reached
      host               VARCHAR(120),
      port               INTEGER,
      unit_id            INTEGER,
      protocol           VARCHAR(30) NOT NULL DEFAULT 'modbus_tcp',

      -- what the CONFIG claimed
      declared_addressing_mode VARCHAR(16),
      declared_byte_order      VARCHAR(16),
      declared_word_order      VARCHAR(16),

      -- what the DEVICE turned out to do. NULL until a human confirms it against
      -- the display; nothing in the codebase may set these automatically.
      confirmed_addressing_mode VARCHAR(16),
      confirmed_byte_order      VARCHAR(16),
      confirmed_word_order      VARCHAR(16),

      reference_instrument TEXT,
      engineer_user_id   INTEGER,
      engineer_name      VARCHAR(160),
      performed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at       TIMESTAMPTZ,

      verdict            VARCHAR(20) NOT NULL DEFAULT 'in_progress',
      notes              TEXT,
      tool_version       VARCHAR(40),
      raw_evidence       JSONB,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CHECK (verdict IN ('in_progress','passed','failed','abandoned')),
      CHECK (confirmed_addressing_mode IS NULL OR confirmed_addressing_mode IN ('one_based','zero_based')),
      CHECK (confirmed_byte_order IS NULL OR confirmed_byte_order IN ('big','little')),
      CHECK (confirmed_word_order IS NULL OR confirmed_word_order IN ('big','little')),
      -- A pilot cannot be declared passed without naming who said so and what
      -- they compared against. This is the constraint that stops a pilot being
      -- "completed" by a script.
      CHECK (verdict <> 'passed' OR (engineer_user_id IS NOT NULL
                                     AND confirmed_addressing_mode IS NOT NULL
                                     AND confirmed_byte_order IS NOT NULL
                                     AND confirmed_word_order IS NOT NULL
                                     AND reference_instrument IS NOT NULL))
    )
  `);
  await safe('idx_pilots', `
    CREATE INDEX IF NOT EXISTS idx_iot_hardware_pilots
      ON iot_hardware_pilots (company_id, performed_at DESC)
  `);
  await safe('idx_pilots_equipment', `
    CREATE INDEX IF NOT EXISTS idx_iot_hardware_pilots_eq
      ON iot_hardware_pilots (equipment_id)
  `);

  await safe('readings', `
    CREATE TABLE IF NOT EXISTS iot_hardware_pilot_readings (
      id                 SERIAL PRIMARY KEY,
      pilot_id           INTEGER     NOT NULL REFERENCES iot_hardware_pilots(id) ON DELETE CASCADE,
      metric             VARCHAR(40) NOT NULL,
      documented_address INTEGER,
      protocol_address   INTEGER,
      register_table     VARCHAR(10),
      data_type          VARCHAR(16),
      scale              NUMERIC(18,8),
      reg_offset         NUMERIC(18,8),
      unit               VARCHAR(24),

      -- the bytes themselves, so a wrong map can be re-decoded later
      raw_hex            VARCHAR(120),
      decoded_variants   JSONB,

      -- the three numbers the pilot is actually about
      pulse_value        NUMERIC(18,6),
      device_display     NUMERIC(18,6),
      reference_value    NUMERIC(18,6),
      difference_pct     NUMERIC(10,4),
      tolerance_pct      NUMERIC(10,4),

      within_tolerance   BOOLEAN,
      verdict            VARCHAR(20) NOT NULL DEFAULT 'pending',
      notes              TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CHECK (verdict IN ('pending','passed','failed','not_applicable'))
    )
  `);
  await safe('idx_readings', `
    CREATE INDEX IF NOT EXISTS idx_iot_pilot_readings ON iot_hardware_pilot_readings (pilot_id)
  `);
  await safe('uq_reading_metric', `
    CREATE UNIQUE INDEX IF NOT EXISTS uq_iot_pilot_reading_metric
      ON iot_hardware_pilot_readings (pilot_id, metric)
  `);

  // A profile records WHICH pilot verified it, so the Metric & Device Registry can
  // show verified and unverified maps differently instead of treating a guess and
  // a measurement as the same thing.
  await safe('profile_verification', `
    ALTER TABLE iot_device_profiles
      ADD COLUMN IF NOT EXISTS verified_by_pilot_id INTEGER,
      ADD COLUMN IF NOT EXISTS verified_at          TIMESTAMPTZ
  `);

  console.log('[migration 20260915000002] iot_hardware_pilot applied.');
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`ALTER TABLE iot_device_profiles DROP COLUMN IF EXISTS verified_by_pilot_id`);
  await safe(`ALTER TABLE iot_device_profiles DROP COLUMN IF EXISTS verified_at`);
  await safe(`DROP TABLE IF EXISTS iot_hardware_pilot_readings CASCADE`);
  await safe(`DROP TABLE IF EXISTS iot_hardware_pilots CASCADE`);
}
