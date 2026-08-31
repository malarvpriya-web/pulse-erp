/**
 * Restore the two account-level uniqueness guarantees the CRM consolidation was
 * supposed to leave behind, and add the one it never had.
 *
 * ── Why this is needed ─────────────────────────────────────────────────────
 * `20260819000002_crm_module_integrity` created:
 *
 *     CREATE UNIQUE INDEX accounts_company_normname_unique
 *       ON accounts (company_id, crm_norm_name(COALESCE(name, account_name)))
 *       WHERE deleted_at IS NULL;
 *
 * Two migrations later, `20260819000004_accounts_name_single_source` collapsed
 * the duplicate name pair with:
 *
 *     ALTER TABLE accounts DROP COLUMN account_name;
 *
 * Postgres drops every index whose expression mentions a dropped column, without
 * an error and without a notice. The index vanished. Nothing failed, no test
 * covered it, and `check:schema` does not look at indexes — so the module's only
 * database-level duplicate-customer guard has been absent since 19 Aug while the
 * audit register recorded it as closed.
 *
 * Verified live before writing this: two accounts named "Acme Industries Pvt Ltd"
 * and "Acme Industries Private Limited." — identical under crm_norm_name — both
 * INSERT cleanly. `resolveCustomer()` still does a SELECT-then-INSERT, which is
 * exactly the pattern that needs a unique index underneath it to be safe under
 * concurrency.
 *
 * The rebuilt index keys on `name` alone. `name` is NOT NULL (set by 000004) and
 * `account_name` is now GENERATED ALWAYS AS (name), so COALESCE bought nothing
 * and re-introducing the reference to the generated column would make this index
 * droppable by the same accident a second time.
 *
 * ── accounts.party_id UNIQUE ───────────────────────────────────────────────
 * Separately: party_id was made NOT NULL with a foreign key, but never unique,
 * so N account extensions could hang off one canonical party — the "one party →
 * at most one CRM account extension" rule was documented and unenforced. Live
 * check found 0 violations, so it can be enforced now.
 */

export async function up(knex) {
  // Guard rather than let CREATE UNIQUE INDEX fail halfway: report what blocks it.
  const { rows: dupNames } = await knex.raw(`
    SELECT company_id, crm_norm_name(name) AS k, COUNT(*)::int AS n
      FROM accounts WHERE deleted_at IS NULL
     GROUP BY 1, 2 HAVING COUNT(*) > 1
  `);
  if (dupNames.length) {
    throw new Error(
      `accounts holds ${dupNames.length} duplicate normalised name group(s) — ` +
      `merge them via POST /crm/accounts/merge before this migration can run: ` +
      dupNames.map(d => `company ${d.company_id}/"${d.k}" x${d.n}`).join(', ')
    );
  }

  const { rows: dupParty } = await knex.raw(`
    SELECT party_id, COUNT(*)::int AS n FROM accounts
     WHERE deleted_at IS NULL AND party_id IS NOT NULL
     GROUP BY 1 HAVING COUNT(*) > 1
  `);
  if (dupParty.length) {
    throw new Error(
      `${dupParty.length} party_id(s) carry more than one CRM account extension — ` +
      `merge them before party_id can be made unique: ` +
      dupParty.map(d => `${d.party_id} x${d.n}`).join(', ')
    );
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_company_normname_unique
      ON accounts (company_id, crm_norm_name(name))
      WHERE deleted_at IS NULL;
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS accounts_party_id_unique
      ON accounts (party_id)
      WHERE deleted_at IS NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS accounts_party_id_unique;`);
  await knex.raw(`DROP INDEX IF EXISTS accounts_company_normname_unique;`);
}
