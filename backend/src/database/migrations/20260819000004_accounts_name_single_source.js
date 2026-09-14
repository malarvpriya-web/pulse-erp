/**
 * accounts: collapse the account_name / name duplicate pair.
 *
 * `accounts` carried the organisation name twice. Every writer set them to the
 * same value in the same statement (`VALUES ($1,$1)`), and every reader had to
 * guess, so the codebase is full of `COALESCE(name, account_name)`. Two columns
 * holding one fact is a drift waiting to happen — the moment one writer forgets
 * the second column, half the app shows a different customer name than the other
 * half. Verified before this ran: 8 of 8 rows identical, no NULLs on either side.
 *
 * `name` becomes the single source of truth. `account_name` is retained as a
 * GENERATED column so the ~143 existing read sites keep working unchanged and
 * can be migrated at leisure — but it is now physically impossible for the two
 * to disagree, and any attempt to write to it fails loudly instead of silently
 * creating a divergence.
 *
 * Deliberately NOT touched: `opportunities.expected_value` / `estimate_value`.
 * The audit listed these together with account_name as a duplicate pair, but
 * reading the code they are not — `estimate_value` is the enquiry's ORIGINAL
 * estimate and `expected_value` is the current (possibly revalued) deal size.
 * The Pursuits grid shows both side by side ("Estimate (Lac)" next to value) so
 * the spread is visible. Collapsing them would destroy real information.
 */

export async function up(knex) {
  // Guard: only proceed if the two columns genuinely agree everywhere. A live
  // divergence would mean this is not a duplicate pair after all, and silently
  // discarding one side would lose data.
  const { rows } = await knex.raw(`
    SELECT COUNT(*) FILTER (WHERE name IS DISTINCT FROM account_name)::int AS diverged
      FROM accounts
  `);
  if ((rows[0]?.diverged ?? 0) > 0) {
    throw new Error(
      `accounts.name and accounts.account_name disagree on ${rows[0].diverged} row(s) — ` +
      `resolve those before collapsing the pair.`
    );
  }

  // name is the survivor, so it must be complete and mandatory.
  await knex.raw(`UPDATE accounts SET name = account_name WHERE name IS NULL;`);
  await knex.raw(`ALTER TABLE accounts ALTER COLUMN name SET NOT NULL;`);

  // Replace the stored duplicate with a generated mirror.
  await knex.raw(`ALTER TABLE accounts DROP COLUMN account_name;`);
  await knex.raw(`
    ALTER TABLE accounts
      ADD COLUMN account_name text GENERATED ALWAYS AS (name) STORED;
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE accounts DROP COLUMN account_name;`);
  await knex.raw(`ALTER TABLE accounts ADD COLUMN account_name character varying;`);
  await knex.raw(`UPDATE accounts SET account_name = name;`);
  await knex.raw(`ALTER TABLE accounts ALTER COLUMN name DROP NOT NULL;`);
}
