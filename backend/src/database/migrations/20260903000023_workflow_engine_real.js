/**
 * 20260903000023_workflow_engine_real.js
 *
 * Schema for an automation engine that actually evaluates and executes.
 *
 * WHY
 * ---
 * The Salesforce-parity audit (2026-09-03) traced what `POST /api/workflows/:id/trigger`
 * does. In full, it:
 *   1. increments `trigger_count` and stamps `last_triggered_at`,
 *   2. writes a run log with a HARDCODED status of 'completed',
 *   3. returns `{ simulated_actions: rules.actions }`.
 *
 * It reads no conditions, executes no actions, and reports success
 * unconditionally — including for a rule whose conditions do not hold. Nothing
 * anywhere else in the codebase triggers a rule from a business event, so the
 * "IF condition THEN action" engine the brief asks about did not exist; the
 * table, the builder UI and the run-log viewer were a shell around it.
 *
 * WHAT THIS MIGRATION ADDS
 * ------------------------
 * company_id on workflow_rules. The table had NONE. That was harmless while
 * nothing executed rules, and becomes a cross-tenant defect the moment they do:
 * without it, one company's automation fires against another company's records.
 * Existing rows are backfilled to the single real tenant (the seeder's SEED rows
 * are the only rows present) and the column is indexed for the dispatcher's
 * hot lookup, which is (company, module, event, active).
 *
 * Run-log columns for the things "error handling and retry logic" require:
 *   actions_result — what each action did, per action, so a partial failure is
 *                    inspectable instead of collapsing to one status word
 *   attempt        — which try this was
 *   matched        — whether the CONDITIONS held. Distinct from status: a rule
 *                    that correctly declined to fire is a successful evaluation,
 *                    not a failure, and conflating the two makes "why didn't my
 *                    automation run" unanswerable.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await knex.raw(`ALTER TABLE workflow_rules ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 100`);

  // Backfill to the sole tenant that owns the existing rows. A NULL company_id
  // would be read as "every tenant" by the standard
  // ($1::int IS NULL OR company_id = $1) predicate — exactly the fail-open shape
  // this column exists to close.
  const { rows: [co] } = await knex.raw(
    `SELECT id FROM companies WHERE id < 999900 ORDER BY id LIMIT 1`
  );
  if (co?.id) {
    const { rowCount } = await knex.raw(
      `UPDATE workflow_rules SET company_id = $1 WHERE company_id IS NULL`, [co.id]
    );
    console.log(`[workflow_engine_real] backfilled company_id on ${rowCount ?? 0} rule(s) -> ${co.id}`);
  }

  await knex.raw(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_rules_company_id_fkey') THEN
        ALTER TABLE workflow_rules ADD CONSTRAINT workflow_rules_company_id_fkey
          FOREIGN KEY (company_id) REFERENCES companies(id);
      END IF;
    END
    $do$;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_workflow_rules_dispatch
      ON workflow_rules (company_id, trigger_module, trigger_event, priority)
     WHERE is_active = true
  `);

  // -- run-log detail ---------------------------------------------------------
  await knex.raw(`ALTER TABLE workflow_run_logs ADD COLUMN IF NOT EXISTS company_id     INTEGER`);
  await knex.raw(`ALTER TABLE workflow_run_logs ADD COLUMN IF NOT EXISTS actions_result JSONB`);
  await knex.raw(`ALTER TABLE workflow_run_logs ADD COLUMN IF NOT EXISTS attempt        INTEGER NOT NULL DEFAULT 1`);
  await knex.raw(`ALTER TABLE workflow_run_logs ADD COLUMN IF NOT EXISTS matched        BOOLEAN`);
  await knex.raw(`ALTER TABLE workflow_run_logs ADD COLUMN IF NOT EXISTS triggered_by   INTEGER`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_workflow_run_logs_company
      ON workflow_run_logs (company_id, triggered_at DESC)
  `);

  console.log('[workflow_engine_real] workflow_rules scoped, run logs detailed');
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_workflow_run_logs_company`);
  for (const c of ['triggered_by', 'matched', 'attempt', 'actions_result', 'company_id']) {
    await knex.raw(`ALTER TABLE workflow_run_logs DROP COLUMN IF EXISTS ${c}`);
  }
  await knex.raw(`DROP INDEX IF EXISTS idx_workflow_rules_dispatch`);
  await knex.raw(`ALTER TABLE workflow_rules DROP CONSTRAINT IF EXISTS workflow_rules_company_id_fkey`);
  await knex.raw(`ALTER TABLE workflow_rules DROP COLUMN IF EXISTS priority`);
  await knex.raw(`ALTER TABLE workflow_rules DROP COLUMN IF EXISTS company_id`);
}
