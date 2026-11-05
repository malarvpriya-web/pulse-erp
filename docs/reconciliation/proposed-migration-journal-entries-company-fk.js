/**
 * PROPOSED migration — NOT in src/database/migrations (files there are applied
 * automatically). Copy it there, as the next number, only AFTER the approved
 * orphan-journal cleanup (Phase 3I stage 1) has run and the orphan report
 * shows 0.
 *
 * journal_entries.company_id → companies(id)
 *
 * Why it is not applied now (checked 2026-10-28): of 953 journal entries, 15
 * name an existing company, 0 have no company, and 938 name companies that no
 * longer exist (the test artefacts awaiting cleanup). VALIDATE would fail on
 * those 938.
 *
 * Writers (audited 2026-10-28): all 22 INSERT INTO journal_entries sites set
 * company_id — from the caller's company scope or from the record being
 * journalled (invoice, bill, payment, credit/debit note, asset, payroll run,
 * GST settlement, the original entry for a reversal, IoT service issue). None
 * writes a company id it did not read from a live record; NULL (an unscoped
 * administrative call) remains allowed by the FK.
 *
 * ON DELETE NO ACTION — never CASCADE: a company with journal history cannot be
 * deleted out from under its ledger. Test teardowns must delete a test
 * company's journals (after the invoices that reference them) before the
 * company; the Phase 3C–3H suites already do.
 *
 * Added NOT VALID first (enforced for every new or changed row immediately),
 * then validated, so the existing-row scan is a separate, fail-loud step.
 *
 * When applied, integration.phase3I.test.js's fixture orphans (journals of a
 * company it then deletes) can no longer be made by a company DELETE; that
 * fixture must then insert them with session_replication_role = replica (the
 * test role is a superuser) or be retired along with the cleanup tool.
 */
export async function up(knex) {
  const { rows: [o] } = await knex.raw(`
    SELECT COUNT(*)::int AS n FROM journal_entries je
     WHERE je.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = je.company_id)`);
  if (o.n > 0) throw new Error(`${o.n} journal entries name a company that does not exist; run the approved cleanup first (nothing was changed)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_journal_entries_company ON journal_entries (company_id)`);
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
  await knex.raw(`DROP INDEX IF EXISTS ix_journal_entries_company`);
}
