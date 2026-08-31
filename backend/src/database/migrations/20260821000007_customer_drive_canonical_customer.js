/**
 * customer_drive_folders / customer_drive_files: customer_id INTEGER → uuid.
 *
 * `customerDrive.controller.js` is written entirely against the canonical party:
 * provision, folder listing and upload all resolve the name with
 * `SELECT name FROM parties WHERE id = $1` and then store that same id as
 * `customer_id`. Customer360.jsx calls every one of them with a party uuid.
 *
 * The two tables were created with `customer_id INTEGER`. So:
 *
 *   GET /crm/customer-drive/<party-uuid>/folders
 *     → the parties lookup succeeds, the folder query then fails with
 *       22P02 invalid input syntax for type integer
 *   GET /crm/customer-drive/<account-int>/folders
 *     → the parties lookup fails first with
 *       22P02 invalid input syntax for type uuid
 *
 * Broken for every possible input — the Drive panel on Customer 360 has never
 * listed a folder. `/files` skips the parties check, so it answers an integer,
 * but the UI never sends one.
 *
 * The code is right and the schema is the outlier, so the columns move to uuid.
 * The existing rows are seed data holding account ids, mapped through
 * `accounts.party_id`; anything unresolvable is left NULL rather than guessed.
 */

async function convert(knex, table) {
  // $1, not ?: the migration runner is a thin pg shim, not knex's query builder,
  // so a `?` placeholder reaches Postgres verbatim and fails to parse.
  const { rows: col } = await knex.raw(
    `SELECT data_type FROM information_schema.columns
      WHERE table_name = $1 AND column_name = 'customer_id'`, [table]
  );
  if (col[0]?.data_type === 'uuid') return;

  await knex.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS customer_party_id uuid`);
  const { rows: mapped } = await knex.raw(`
    UPDATE ${table} t SET customer_party_id = a.party_id
      FROM accounts a WHERE a.id = t.customer_id
     RETURNING t.id
  `);
  const { rows: left } = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE customer_id IS NOT NULL AND customer_party_id IS NULL`
  );
  console.log(`   ↳ ${table}: ${mapped.length} mapped to a canonical party, ${left[0].n} left NULL`);

  // Drop first: any unique constraint over the old column goes with it, and the
  // provision upsert's ON CONFLICT target has to be rebuilt on the new one.
  await knex.raw(`ALTER TABLE ${table} DROP COLUMN customer_id`);
  await knex.raw(`ALTER TABLE ${table} RENAME COLUMN customer_party_id TO customer_id`);
  await knex.raw(`
    ALTER TABLE ${table}
      ADD CONSTRAINT ${table}_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES parties(id) ON DELETE CASCADE
  `);
}

export async function up(knex) {
  await convert(knex, 'customer_drive_folders');
  await convert(knex, 'customer_drive_files');

  // provisionCustomerFolders upserts on (customer_id, doc_type) — recreate the
  // target the DROP COLUMN above removed, or every re-provision inserts a
  // duplicate folder row instead of refreshing the existing one.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_drive_folders_customer_doctype_unique
      ON customer_drive_folders (customer_id, doc_type)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_customer_drive_files_customer
      ON customer_drive_files (customer_id)
  `);
}

export async function down(knex) {
  for (const table of ['customer_drive_files', 'customer_drive_folders']) {
    await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_customer_id_fkey`);
    await knex.raw(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS customer_account_id integer`);
    await knex.raw(`
      UPDATE ${table} t SET customer_account_id = a.id
        FROM accounts a WHERE a.party_id = t.customer_id
    `);
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN customer_id`);
    await knex.raw(`ALTER TABLE ${table} RENAME COLUMN customer_account_id TO customer_id`);
  }
}
