/**
 * generated_documents — the polymorphic reference the repository filters on.
 *
 * `documents.repository.js` writes and filters `reference_id` / `reference_type`
 * ("show me the documents generated for THIS purchase order"). Neither column
 * has ever existed, so document generation threw 42703 and the "documents for a
 * record" lookup could never return anything. The repository is live — it backs
 * `/documents/templates` and the generation routes.
 *
 * The rest of that repository's mismatches are naming, not missing structure,
 * and are corrected in the code instead:
 *   template_name -> name          template_html      -> content
 *   variables_json -> variables    document_data_json -> content
 *   file_path      -> file_url     document_type      -> category
 *
 * Only the polymorphic pair is genuinely absent, so only it is added.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS reference_id   integer;`);
  await knex.raw(`ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS reference_type varchar(60);`);
  await knex.raw(`ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS company_id     integer REFERENCES companies(id) ON DELETE SET NULL;`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_generated_documents_reference
      ON generated_documents (reference_type, reference_id)
      WHERE reference_id IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_generated_documents_reference;`);
  await knex.raw(`ALTER TABLE generated_documents DROP COLUMN IF EXISTS company_id;`);
  await knex.raw(`ALTER TABLE generated_documents DROP COLUMN IF EXISTS reference_type;`);
  await knex.raw(`ALTER TABLE generated_documents DROP COLUMN IF EXISTS reference_id;`);
}
