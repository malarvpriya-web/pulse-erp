/**
 * Second follow-up to 20260728000006 — same class of miss as
 * 20260728000007 (warranty_months): `exclusions` also only existed on the
 * now-superseded `project_warranties`, not `warranty_registrations`. Caught
 * by the same live smoke test, next query in the chain.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE warranty_registrations
      ADD COLUMN IF NOT EXISTS exclusions TEXT
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE warranty_registrations DROP COLUMN IF EXISTS exclusions`);
}
