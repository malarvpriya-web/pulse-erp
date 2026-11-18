/**
 * it_declarations.claimed_amount defaults to amount (§263 follow-up).
 *
 * 20261110000003 made claimed_amount NOT NULL. Writers that predate it (test
 * fixtures, any direct INSERT) name only `amount`; a declaration filed without
 * a claim was declared at exactly that amount, so the row says so instead of
 * failing. The runner is a pg shim: placeholders are $n.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION it_declarations_claimed_default() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.claimed_amount IS NULL THEN NEW.claimed_amount := NEW.amount; END IF;
      RETURN NEW;
    END $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_it_declarations_claimed_default ON it_declarations`);
  await knex.raw(`
    CREATE TRIGGER trg_it_declarations_claimed_default
      BEFORE INSERT ON it_declarations
      FOR EACH ROW EXECUTE FUNCTION it_declarations_claimed_default()`);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_it_declarations_claimed_default ON it_declarations`);
  await knex.raw(`DROP FUNCTION IF EXISTS it_declarations_claimed_default()`);
}
