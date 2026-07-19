/**
 * 20260603000003_parties_schema_hardening.js
 *
 * Root cause: the parties table (created by initDb.js) has no company_id column.
 * partiesRepo.findAll() adds "WHERE company_id = $1" → PostgreSQL throws an error
 * → route returns 500 → frontend silently gets [] → 0 parties shown despite invoices
 * existing for named companies.
 *
 * Two schema variants exist in the wild:
 *   initDb.js  — id UUID,   name VARCHAR(255),  has deleted_at,  NO company_id
 *   runMigrations.js — id SERIAL, party_name VARCHAR(200), NO deleted_at, NO company_id
 *
 * This migration handles both paths (SAVEPOINT pattern) and also:
 *   1. Adds company_id + all columns the frontend form sends but the table is missing
 *   2. Renames party_name → name on the runMigrations.js path
 *   3. Back-fills party records from unique invoice/bill party_name values
 *   4. Links invoices.party_id / bills.party_id back to the newly created parties
 *
 * Safe to re-run: all DDL uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
 */

export async function up(knex) {
  let sp = 0;

  const tryAlter = async (sql) => {
    const name = `sp_parties_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      const msg = err.message?.split('\n')[0] ?? err.message;
      if (!msg.includes('does not exist') && !msg.includes('already exists') && !msg.includes('duplicate column')) {
        throw err;
      }
      console.warn(`[parties-harden] Skipped: ${msg}`);
    }
  };

  // ── 1. Rename party_name → name (runMigrations.js path only) ────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'parties' AND column_name = 'party_name'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'parties' AND column_name = 'name'
      ) THEN
        ALTER TABLE parties RENAME COLUMN party_name TO name;
      END IF;
    END $$
  `);

  // ── 2. Add every column the frontend / repository expects ───────────────────
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS company_id     INTEGER`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS deleted_at     TIMESTAMPTZ`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS gstin          VARCHAR(20)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS pan            VARCHAR(20)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS city           VARCHAR(100)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS state          VARCHAR(100)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS country        VARCHAR(100) DEFAULT 'India'`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS pincode        VARCHAR(10)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS website        VARCHAR(200)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS designation    VARCHAR(100)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS mobile         VARCHAR(20)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS industry       VARCHAR(100)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS currency       VARCHAR(10)  DEFAULT 'INR'`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS bank_name      VARCHAR(100)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS bank_account   VARCHAR(50)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS ifsc           VARCHAR(11)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS msme_number    VARCHAR(50)`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS notes          TEXT`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(15,2) DEFAULT 0`);
  await tryAlter(`ALTER TABLE parties ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW()`);

  // ── 3. Performance indexes ───────────────────────────────────────────────────
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_parties_company_id ON parties(company_id)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_parties_party_type  ON parties(party_type)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_parties_name        ON parties(name)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_parties_gstin       ON parties(gstin) WHERE gstin IS NOT NULL`);

  // ── 4. Back-fill parties from invoices.party_name (free-text customer names) ─
  // invoices may use party_name (free text) without a FK to parties.
  // Create one Customer party record per unique (party_name, company_id) combo.
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'invoices' AND column_name = 'party_name'
      ) THEN
        INSERT INTO parties (party_code, party_type, name, company_id, created_at, updated_at)
        SELECT
          'CUST-' || LPAD(ROW_NUMBER() OVER (ORDER BY first_seen)::text, 3, '0'),
          'Customer',
          party_name,
          company_id,
          first_seen,
          NOW()
        FROM (
          SELECT DISTINCT
            i.party_name,
            i.company_id,
            MIN(i.created_at) AS first_seen
          FROM invoices i
          WHERE i.party_name IS NOT NULL
            AND i.party_name <> ''
            AND NOT EXISTS (
              SELECT 1 FROM parties p
              WHERE p.name = i.party_name
                AND (
                  (p.company_id = i.company_id) OR
                  (p.company_id IS NULL AND i.company_id IS NULL)
                )
            )
          GROUP BY i.party_name, i.company_id
        ) sub
        ON CONFLICT DO NOTHING;
      END IF;
    END $$
  `);

  // ── 5. Back-fill parties from bills.party_name (free-text supplier names) ────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bills' AND column_name = 'party_name'
      ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bills' AND column_name = 'company_id'
      ) THEN
        INSERT INTO parties (party_code, party_type, name, company_id, created_at, updated_at)
        SELECT
          'SUPP-' || LPAD(ROW_NUMBER() OVER (ORDER BY first_seen)::text, 3, '0'),
          'Supplier',
          party_name,
          company_id,
          first_seen,
          NOW()
        FROM (
          SELECT DISTINCT
            b.party_name,
            b.company_id,
            MIN(b.created_at) AS first_seen
          FROM bills b
          WHERE b.party_name IS NOT NULL
            AND b.party_name <> ''
            AND NOT EXISTS (
              SELECT 1 FROM parties p
              WHERE p.name = b.party_name
                AND (
                  (p.company_id = b.company_id) OR
                  (p.company_id IS NULL AND b.company_id IS NULL)
                )
            )
          GROUP BY b.party_name, b.company_id
        ) sub
        ON CONFLICT DO NOTHING;
      END IF;
    END $$
  `);

  // ── 6. Link invoices.party_id back to the newly created party records ────────
  //   Guard: only run if invoices.party_id and parties.id share the same data type.
  //   On some installs invoices.party_id is INTEGER while parties.id is UUID —
  //   attempting the UPDATE in that case would throw a type mismatch error.
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'invoices' AND column_name = 'party_id'
      ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'invoices' AND column_name = 'party_name'
      ) AND (
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'invoices' AND column_name = 'party_id'
      ) = (
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'parties' AND column_name = 'id'
      ) THEN
        UPDATE invoices i
        SET party_id = p.id
        FROM parties p
        WHERE p.name = i.party_name
          AND (
            (p.company_id = i.company_id) OR
            (p.company_id IS NULL AND i.company_id IS NULL)
          )
          AND i.party_id IS NULL
          AND i.party_name IS NOT NULL;
      END IF;
    END $$
  `);

  // ── 7. Link bills.party_id similarly ─────────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bills' AND column_name = 'party_id'
      ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'bills' AND column_name = 'party_name'
      ) AND (
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'bills' AND column_name = 'party_id'
      ) = (
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'parties' AND column_name = 'id'
      ) THEN
        UPDATE bills b
        SET party_id = p.id
        FROM parties p
        WHERE p.name = b.party_name
          AND (
            (p.company_id = b.company_id) OR
            (p.company_id IS NULL AND b.company_id IS NULL)
          )
          AND b.party_id IS NULL
          AND b.party_name IS NOT NULL;
      END IF;
    END $$
  `);
}

export async function down(knex) {
  // Removing the added columns is destructive — intentionally left empty.
  // Run a manual rollback only if this migration caused a regression.
}
