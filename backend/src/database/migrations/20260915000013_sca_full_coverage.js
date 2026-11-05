/**
 * Schema for the last supply-chain gaps the 198-component scorecard still fails.
 *
 * Each addition exists because a probe in scripts/sca/sca-registry.mjs cannot
 * pass without it. Nothing speculative is added here.
 *
 *  1. demand_forecast_method_scores
 *     The forecast engine backtests four methods and stores only the winner.
 *     From the database you therefore cannot tell whether Holt was ever tried -
 *     "time-series forecasting", "exponential smoothing" and "seasonality" were
 *     claims about source code, not observable facts. Every candidate's score is
 *     now kept, so the selection is auditable and a method that silently stops
 *     competing is visible.
 *
 *  2. inventory_items.lead_time_*
 *     Lead time was a hand-typed field, uniform at 7 days on every item, while
 *     PO-to-GRN actuals sat in the database unused. These columns hold the
 *     measured value and how many receipts it came from, and `lead_time_source`
 *     records whether planning is using a measurement or someone's guess.
 *
 *  3. production_operations.scheduled_*
 *     Production "scheduling" was a planned start and end on the ORDER. Nothing
 *     sequenced operations against a work centre, so two orders could hold the
 *     same machine at the same hour and no part of the system objected.
 *
 *  4. put_away_tasks
 *     Goods receipt created stock in a warehouse; nothing recorded moving it to
 *     a bin. Without it "store / location" on the trace stops at the building.
 *
 *  5. DROP TABLE tickets
 *     A dead duplicate of support_tickets: no write path, no company_id, and
 *     zero rows. It was not merely unused - service-analytics joined it, so
 *     every engineer's ticket count read 0 while support_tickets held the real
 *     rows. Dropping it is what stops that from happening again.
 */

export async function up(knex) {
  // 1 ── forecast method scores ───────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS demand_forecast_method_scores (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER     NOT NULL,
      run_id        INTEGER     NOT NULL,
      item_id       INTEGER     NOT NULL,
      item_code     VARCHAR(64),
      method        VARCHAR(32) NOT NULL,
      mape          NUMERIC(10,4),
      mad           NUMERIC(14,4),
      bias          NUMERIC(14,4),
      observations  INTEGER,
      is_selected   BOOLEAN     NOT NULL DEFAULT FALSE,
      not_scored_reason VARCHAR(64),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dfms_run   ON demand_forecast_method_scores (run_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_dfms_item  ON demand_forecast_method_scores (company_id, item_id)`);

  // 2 ── measured supplier lead time ──────────────────────────────────────────
  await knex.raw(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS lead_time_source        VARCHAR(16)`);
  await knex.raw(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS lead_time_measured_days NUMERIC(10,2)`);
  await knex.raw(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS lead_time_observations  INTEGER`);
  await knex.raw(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS lead_time_measured_at   TIMESTAMPTZ`);

  // 3 ── finite scheduling on operations ──────────────────────────────────────
  await knex.raw(`ALTER TABLE production_operations ADD COLUMN IF NOT EXISTS scheduled_seq   INTEGER`);
  await knex.raw(`ALTER TABLE production_operations ADD COLUMN IF NOT EXISTS scheduled_start TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE production_operations ADD COLUMN IF NOT EXISTS scheduled_end   TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE production_operations ADD COLUMN IF NOT EXISTS scheduled_run_id INTEGER`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_prodops_sched ON production_operations (work_centre_id, scheduled_start)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS production_schedule_runs (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER     NOT NULL,
      run_no          VARCHAR(32),
      horizon_days    INTEGER,
      rule            VARCHAR(24),
      operations_scheduled INTEGER DEFAULT 0,
      work_centres    INTEGER DEFAULT 0,
      makespan_hours  NUMERIC(12,2),
      late_operations INTEGER DEFAULT 0,
      run_by          INTEGER,
      run_by_name     VARCHAR(160),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // 4 ── put-away ─────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS put_away_tasks (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER     NOT NULL,
      task_no        VARCHAR(32),
      grn_id         INTEGER,
      batch_id       INTEGER,
      item_id        INTEGER     NOT NULL,
      quantity       NUMERIC(14,3) NOT NULL,
      from_warehouse_id INTEGER,
      to_warehouse_id   INTEGER,
      to_bin_id      INTEGER,
      mhe_id         INTEGER,
      status         VARCHAR(16) NOT NULL DEFAULT 'open',
      put_away_by    INTEGER,
      put_away_by_name VARCHAR(160),
      completed_at   TIMESTAMPTZ,
      notes          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_putaway_co ON put_away_tasks (company_id, status)`);

  // 5 ── the dead tickets duplicate ───────────────────────────────────────────
  // Guarded: only drop it if it is genuinely empty. A table with rows in someone
  // else's install is data, whatever this one looks like.
  const { rows } = await knex.raw(`
    SELECT COALESCE((SELECT COUNT(*) FROM tickets), 0)::int AS n
     WHERE EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'tickets')
  `);
  if (rows.length && Number(rows[0].n) === 0) {
    await knex.raw(`DROP TABLE IF EXISTS tickets CASCADE`);
  }
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS put_away_tasks`);
  await knex.raw(`DROP TABLE IF EXISTS production_schedule_runs`);
  await knex.raw(`DROP TABLE IF EXISTS demand_forecast_method_scores`);
  await knex.raw(`ALTER TABLE production_operations DROP COLUMN IF EXISTS scheduled_seq`);
  await knex.raw(`ALTER TABLE production_operations DROP COLUMN IF EXISTS scheduled_start`);
  await knex.raw(`ALTER TABLE production_operations DROP COLUMN IF EXISTS scheduled_end`);
  await knex.raw(`ALTER TABLE production_operations DROP COLUMN IF EXISTS scheduled_run_id`);
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS lead_time_source`);
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS lead_time_measured_days`);
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS lead_time_observations`);
  await knex.raw(`ALTER TABLE inventory_items DROP COLUMN IF EXISTS lead_time_measured_at`);
  // `tickets` is not recreated: it had no write path and no rows.
}
