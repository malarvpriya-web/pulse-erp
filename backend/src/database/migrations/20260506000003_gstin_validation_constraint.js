/**
 * 20260506000003_gstin_validation_constraint.js
 *
 * Compliance fix — adds DB-level GSTIN format constraint to parties table
 * and ensures state column exists.
 *
 * GSTIN format: SS AAAAA 9999 A Z C
 *   SS    = 2-digit state code (01-37)
 *   AAAAA = 5 uppercase letters (from PAN)
 *   9999  = 4 digits (from PAN)
 *   A     = 1 uppercase letter (from PAN)
 *   Z     = entity number (1-9 or A-Z)
 *   Z     = literal Z
 *   C     = check digit (0-9 or A-Z)
 */

export async function up(knex) {

  // Ensure state column exists on parties
  await knex.raw(`
    ALTER TABLE parties
      ADD COLUMN IF NOT EXISTS gstin VARCHAR(15),
      ADD COLUMN IF NOT EXISTS pan   VARCHAR(10),
      ADD COLUMN IF NOT EXISTS state VARCHAR(100)
  `);

  // Normalise existing GSTINs to uppercase before adding constraint
  await knex.raw(`
    UPDATE parties
    SET gstin = UPPER(TRIM(gstin))
    WHERE gstin IS NOT NULL
  `);

  // Remove any rows that would violate the new constraint (malformed GSTINs → NULL)
  await knex.raw(`
    UPDATE parties
    SET gstin = NULL
    WHERE gstin IS NOT NULL
      AND gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
  `);

  // Add constraint (non-blocking — parties with NULL gstin are unregistered, which is valid)
  await knex.raw(`
    ALTER TABLE parties
      DROP CONSTRAINT IF EXISTS chk_parties_gstin_format,
      ADD CONSTRAINT chk_parties_gstin_format
        CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
  `);

  // Also add GSTIN column to companies table if missing
  await knex.raw(`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS pan   VARCHAR(10),
      ADD COLUMN IF NOT EXISTS tan   VARCHAR(10),
      ADD COLUMN IF NOT EXISTS cin   VARCHAR(21)
  `);

  await knex.raw(`
    UPDATE companies SET gstin = UPPER(TRIM(gstin)) WHERE gstin IS NOT NULL
  `);

  await knex.raw(`
    ALTER TABLE companies
      DROP CONSTRAINT IF EXISTS chk_companies_gstin_format,
      ADD CONSTRAINT chk_companies_gstin_format
        CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$')
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_parties_gstin ON parties(gstin) WHERE gstin IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE parties DROP CONSTRAINT IF EXISTS chk_parties_gstin_format`);
  await knex.raw(`ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_gstin_format`);
}
