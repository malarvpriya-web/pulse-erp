/**
 * IT declarations: proof file, HRA landlord, 80D self / parents (§264).
 *
 *   proof_file      a stored upload (POST /self-service/it-declarations/:id/proof),
 *                   served by /api/files to the employee and it_declarations:view
 *                   in the company. proof_url (a link) stays for existing rows.
 *   landlord_name   HRA: who the rent is paid to.
 *   landlord_pan    HRA: required by the route when the year's rent is over
 *                   ₹1,00,000 (⚖ Form 12BB practice; confirm for the 2025 Act).
 *   insured_for     80D: 'self' (self, spouse, children) or 'parents' — each has
 *                   its own limit. Existing 80D rows are 'self'.
 *   parents_senior  80D parents: a parent is 60 or over (the higher limit).
 *
 * The runner is a pg shim: placeholders are $n.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE it_declarations
      ADD COLUMN IF NOT EXISTS proof_file text,
      ADD COLUMN IF NOT EXISTS landlord_name text,
      ADD COLUMN IF NOT EXISTS landlord_pan varchar(10),
      ADD COLUMN IF NOT EXISTS insured_for varchar(10),
      ADD COLUMN IF NOT EXISTS parents_senior boolean NOT NULL DEFAULT false`);
  await knex.raw(`UPDATE it_declarations SET insured_for = 'self' WHERE declaration_type = '80D' AND insured_for IS NULL`);
  // The insert default from 20261110000004 also fills an 80D row's insured_for
  // ('self') for writers that predate it.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION it_declarations_claimed_default() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.claimed_amount IS NULL THEN NEW.claimed_amount := NEW.amount; END IF;
      IF NEW.declaration_type = '80D' AND NEW.insured_for IS NULL THEN NEW.insured_for := 'self'; END IF;
      RETURN NEW;
    END $fn$`);
  const add = async (name, def) => {
    const { rows } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = $1`, [name]);
    if (!rows.length) await knex.raw(`ALTER TABLE it_declarations ADD CONSTRAINT ${name} ${def}`);
  };
  await add('it_declarations_insured_for_chk', `CHECK (
    (declaration_type = '80D' AND insured_for IN ('self', 'parents'))
    OR (declaration_type <> '80D' AND insured_for IS NULL))`);
  await add('it_declarations_parents_senior_chk', `CHECK (NOT parents_senior OR insured_for = 'parents')`);
  await add('it_declarations_landlord_pan_chk', `CHECK (landlord_pan IS NULL OR landlord_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$')`);
  await add('it_declarations_landlord_hra_chk', `CHECK (declaration_type = 'HRA' OR (landlord_name IS NULL AND landlord_pan IS NULL))`);
}

export async function down(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION it_declarations_claimed_default() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.claimed_amount IS NULL THEN NEW.claimed_amount := NEW.amount; END IF;
      RETURN NEW;
    END $fn$`);
  for (const n of ['it_declarations_landlord_hra_chk', 'it_declarations_landlord_pan_chk',
    'it_declarations_parents_senior_chk', 'it_declarations_insured_for_chk']) {
    await knex.raw(`ALTER TABLE it_declarations DROP CONSTRAINT IF EXISTS ${n}`);
  }
  await knex.raw(`
    ALTER TABLE it_declarations
      DROP COLUMN IF EXISTS parents_senior, DROP COLUMN IF EXISTS insured_for,
      DROP COLUMN IF EXISTS landlord_pan, DROP COLUMN IF EXISTS landlord_name, DROP COLUMN IF EXISTS proof_file`);
}
