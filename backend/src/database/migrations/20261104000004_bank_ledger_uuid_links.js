/**
 * 20261104000004 — PC-02b-0 B-03: bank-to-ledger and bank-to-journal links use
 * the UUID type of what they reference (04 Nov 26). MODULE_FEATURE_CONNECTION_MANUAL.md §236.
 *
 * bank_accounts.chart_account_id and bank_transactions.journal_entry_id were
 * created INTEGER (20260426000001, 20260604000003, 20260819000019, baseline.sql)
 * while chart_of_accounts.id and journal_entries.id are UUID: neither could hold
 * a real link, and the ledger-derived bank balance was disabled for the mismatch.
 *
 * Up:
 *   1. pre-flight — both referenced ids are uuid; the two columns are integer
 *      (already uuid with the legacy column present → nothing to do);
 *   2. bank_accounts.chart_account_id → renamed chart_account_id_legacy_int (every
 *      value kept, D1); a new chart_account_id uuid NULL, FK chart_of_accounts(id)
 *      ON DELETE RESTRICT (D2), indexed;
 *   3. back-fill chart_account_id ONLY from an approved Finance payment mapping
 *      (company_settings 'payment_gl_mapping', B-02): an active Asset / bank
 *      account of the bank account's company or the shared chart. Nothing else is
 *      mapped — the legacy integers reference nothing and are never guessed;
 *   4. bank_transactions.journal_entry_id → renamed journal_entry_id_legacy_int
 *      (kept); a new journal_entry_id uuid NULL, FK journal_entries(id) ON DELETE
 *      RESTRICT, indexed. No back-fill (no deterministic source).
 *
 * Down: REFUSES while either uuid column holds a value (rolling back would
 * silently discard those links — clear them deliberately first). Otherwise drops
 * the uuid columns and restores the legacy columns under their original names,
 * values exactly as they were.
 *
 * Payment posting is unaffected: it uses the approved mapping, never this link (D3).
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const colType = async (knex, table, column) => (await knex.raw(
  `SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
  [table, column])).rows[0]?.data_type ?? null;

const PAIRS = [
  { table: 'bank_accounts', column: 'chart_account_id', ref: 'chart_of_accounts', fk: 'bank_accounts_chart_account_id_fkey', idx: 'idx_bank_accounts_chart_account_id' },
  { table: 'bank_transactions', column: 'journal_entry_id', ref: 'journal_entries', fk: 'bank_transactions_journal_entry_id_fkey', idx: 'idx_bank_transactions_journal_entry_id' },
];

export async function up(knex) {
  for (const p of PAIRS) {
    const refType = await colType(knex, p.ref, 'id');
    if (refType !== 'uuid') throw new Error(`${p.ref}.id is ${refType}, expected uuid — refusing`);
    const cur = await colType(knex, p.table, p.column);
    const legacy = await colType(knex, p.table, `${p.column}_legacy_int`);
    if (cur === 'uuid' && legacy) continue;                       // already applied
    if (cur !== 'integer' || legacy) throw new Error(`${p.table}.${p.column} is ${cur} (legacy column ${legacy ?? 'absent'}) — unexpected state, refusing`);
    await knex.raw(`ALTER TABLE ${p.table} RENAME COLUMN ${p.column} TO ${p.column}_legacy_int`);
    await knex.raw(`ALTER TABLE ${p.table} ADD COLUMN ${p.column} uuid NULL`);
    await knex.raw(`ALTER TABLE ${p.table} ADD CONSTRAINT ${p.fk} FOREIGN KEY (${p.column}) REFERENCES ${p.ref}(id) ON DELETE RESTRICT`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${p.idx} ON ${p.table} (${p.column})`);
  }

  // Back-fill the display link from approved Finance mappings only.
  const { rows: maps } = await knex.raw(
    `SELECT company_id, settings FROM company_settings
      WHERE module = 'payment_gl_mapping' AND settings ? 'approved_by' AND settings ? 'approved_at'
        AND settings->>'approved_by' IS NOT NULL AND settings->>'approved_at' IS NOT NULL`);
  let linked = 0;
  for (const m of maps) {
    for (const [bankId, code] of Object.entries(m.settings?.bank_ledgers || {})) {
      const { rows } = await knex.raw(
        `UPDATE bank_accounts ba SET chart_account_id = acct.id
           FROM (SELECT coa.id FROM chart_of_accounts coa
                  WHERE coa.code = $3 AND coa.is_active = true AND coa.deleted_at IS NULL
                    AND (coa.company_id = $2 OR coa.company_id IS NULL)
                    AND LOWER(coa.account_type) = 'asset' AND LOWER(COALESCE(coa.sub_type, '')) = 'bank'
                  ORDER BY coa.company_id NULLS LAST LIMIT 1) acct
          WHERE ba.id = $1 AND ba.company_id = $2 AND ba.deleted_at IS NULL
          RETURNING ba.id`, [Number(bankId), m.company_id, String(code)]);
      linked += rows.length;
    }
  }
  const { rows: [legacy] } = await knex.raw(
    `SELECT (SELECT COUNT(*) FROM bank_accounts WHERE chart_account_id_legacy_int IS NOT NULL)::int AS accounts,
            (SELECT COUNT(*) FROM bank_transactions WHERE journal_entry_id_legacy_int IS NOT NULL)::int AS txns`);
  console.log(`[20261104000004] linked ${linked} bank account(s) from approved payment mappings; `
    + `kept unmapped legacy values: ${legacy.accounts} bank account(s), ${legacy.txns} bank transaction(s)`);
}

export async function down(knex) {
  for (const p of PAIRS) {
    if (await colType(knex, p.table, p.column) !== 'uuid') continue;
    const { rows: [{ n }] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM ${p.table} WHERE ${p.column} IS NOT NULL`);
    if (n > 0) {
      throw new Error(`Refusing to roll back 20261104000004: ${n} ${p.table} row(s) hold a ${p.column} link that the integer column cannot keep. Clear them deliberately first.`);
    }
  }
  for (const p of PAIRS) {
    if (await colType(knex, p.table, p.column) !== 'uuid') continue;
    await knex.raw(`ALTER TABLE ${p.table} DROP CONSTRAINT IF EXISTS ${p.fk}`);
    await knex.raw(`DROP INDEX IF EXISTS ${p.idx}`);
    await knex.raw(`ALTER TABLE ${p.table} DROP COLUMN ${p.column}`);
    if (await colType(knex, p.table, `${p.column}_legacy_int`)) {
      await knex.raw(`ALTER TABLE ${p.table} RENAME COLUMN ${p.column}_legacy_int TO ${p.column}`);
    } else {
      await knex.raw(`ALTER TABLE ${p.table} ADD COLUMN ${p.column} integer`);
    }
  }
}
