/**
 * Contacts schema hardening — add first_name, last_name, title, department,
 * mobile, linkedin, notes so the frontend form fields map correctly.
 * Backfills first_name / last_name from full_name for any existing rows.
 */
export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_cth_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS first_name  VARCHAR(100)`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_name   VARCHAR(100)`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS title       VARCHAR(20)`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS department  VARCHAR(100)`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS mobile      VARCHAR(30)`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin    VARCHAR(500)`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes       TEXT`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW()`);

  // Backfill first_name / last_name from full_name where not yet set
  await knex.raw(`
    UPDATE contacts
    SET
      first_name = SPLIT_PART(TRIM(full_name), ' ', 1),
      last_name  = CASE
                     WHEN TRIM(full_name) LIKE '% %'
                     THEN TRIM(SUBSTRING(TRIM(full_name) FROM POSITION(' ' IN TRIM(full_name)) + 1))
                     ELSE ''
                   END
    WHERE first_name IS NULL
      AND full_name  IS NOT NULL
      AND TRIM(full_name) <> ''
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id) WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_contacts_company;
    ALTER TABLE contacts DROP COLUMN IF EXISTS updated_at;
    ALTER TABLE contacts DROP COLUMN IF EXISTS notes;
    ALTER TABLE contacts DROP COLUMN IF EXISTS linkedin;
    ALTER TABLE contacts DROP COLUMN IF EXISTS mobile;
    ALTER TABLE contacts DROP COLUMN IF EXISTS department;
    ALTER TABLE contacts DROP COLUMN IF EXISTS title;
    ALTER TABLE contacts DROP COLUMN IF EXISTS last_name;
    ALTER TABLE contacts DROP COLUMN IF EXISTS first_name;
  `);
}
