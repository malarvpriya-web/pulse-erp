export async function up(knex) {
  await knex.raw(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS attachment_url TEXT`);
  await knex.raw(`ALTER TABLE non_conformance_reports ADD COLUMN IF NOT EXISTS attachment_url TEXT`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE invoices DROP COLUMN IF EXISTS attachment_url`);
  await knex.raw(`ALTER TABLE non_conformance_reports DROP COLUMN IF EXISTS attachment_url`);
}
