/**
 * 20260630000004_routing_steps_full_schema.js
 * The routing_steps table was created by an earlier migration with a minimal schema.
 * Migration 20260505000001 tried CREATE TABLE IF NOT EXISTS — which no-ops on an existing table —
 * so none of the expected columns were added.  Add them all with IF NOT EXISTS guards.
 */
export async function up(knex) {
  const safe = (sql) => knex.raw(sql).catch(() => {});

  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS bom_id         INTEGER REFERENCES bom_headers(id) ON DELETE CASCADE`);
  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS step_no        INTEGER NOT NULL DEFAULT 1`);
  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS operation      VARCHAR(200)`);
  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS std_time_hrs   NUMERIC(8,4) DEFAULT 0`);
  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS setup_time_hrs NUMERIC(8,4) DEFAULT 0`);
  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS is_inspection  BOOLEAN DEFAULT FALSE`);
  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS description    TEXT`);
  await safe(`ALTER TABLE routing_steps ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ DEFAULT NOW()`);

  await safe(`CREATE INDEX IF NOT EXISTS idx_routing_steps_bom ON routing_steps(bom_id)`);
}

export async function down(knex) {
  // Only drop columns we added; preserve any original columns
  for (const col of ['bom_id','step_no','operation','std_time_hrs','setup_time_hrs','is_inspection','description']) {
    await knex.raw(`ALTER TABLE routing_steps DROP COLUMN IF EXISTS ${col}`).catch(() => {});
  }
}
