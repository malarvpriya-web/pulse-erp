/**
 * 20261028000009 — journal_entries.company_id → companies(id).
 *
 * Phase 3I, stage 5, applied after the approved orphan-journal cleanup
 * (2026-10-28: 938 orphaned test-artefact entries removed by
 * scripts/reconciliation/orphan-journals-cleanup.mjs; log in
 * docs/reconciliation/orphan-journals-cleanup-log.json). Before it, 938 of 953
 * entries named companies that no longer existed — journal_entries had no FK,
 * and test teardowns deleted companies while their journals survived.
 *
 * Writers (audited 2026-10-28): all 22 INSERT INTO journal_entries sites set
 * company_id from the caller's company scope or the record being journalled;
 * NULL (an unscoped administrative call) stays permitted by the FK.
 *
 * ON DELETE NO ACTION — never CASCADE: a company with journal history cannot be
 * deleted out from under its ledger. (idx_je_company_id already indexes the
 * column.) Added NOT VALID first, then validated, so the existing-row scan is
 * a separate, fail-loud step; refuses to run while any orphan exists.
 *
 * Rollback: down() drops the constraint.
 */
export async function up(knex) {
  const { rows: [o] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM journal_entries je
     WHERE je.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = je.company_id)`);
  if (o.n > 0) throw new Error(`${o.n} journal entries name a company that does not exist; run the approved cleanup first (nothing was changed)`);
  const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = 'journal_entries_company_id_fkey'`);
  if (!rows.length) {
    await knex.raw(`
      ALTER TABLE journal_entries
        ADD CONSTRAINT journal_entries_company_id_fkey
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE NO ACTION NOT VALID
    `);
  }
  await knex.raw(`ALTER TABLE journal_entries VALIDATE CONSTRAINT journal_entries_company_id_fkey`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_company_id_fkey`);
}
