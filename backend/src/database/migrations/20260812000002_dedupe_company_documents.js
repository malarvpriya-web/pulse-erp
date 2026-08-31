/**
 * 20260812000002_dedupe_company_documents.js
 *
 * 20260709000001_company_documents seeded 'Presentation Template' (brand_assets)
 * pointing at /documents/brand/presentation-template.pptx. The seed source was
 * later edited to 'PPT Template', and 20260709000003_brand_templates_seed's
 * exact-title dedup check didn't match the older row, so it inserted a second
 * row for the same file — the Brand Vault panel on Home showed both.
 *
 * Collapse any (category, file_url) group down to one active row (the newest),
 * deactivating the rest. Soft-delete via is_active=false, not DELETE, so any
 * existing download links / ids referencing the old row don't 404.
 */
export async function up(knex) {
  const { rows } = await knex.raw(`SELECT to_regclass('public.company_documents') AS t`);
  if (!rows[0].t) return;

  await knex.raw(`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY category, file_url, COALESCE(company_id, -1)
               ORDER BY created_at DESC, id DESC
             ) AS rn
        FROM company_documents
       WHERE is_active = true AND file_url IS NOT NULL
    )
    UPDATE company_documents
       SET is_active = false, updated_at = NOW()
     WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  `);
}

export async function down(_knex) {
  // Soft-delete dedup is not reversible — which row was "canonical" isn't recoverable.
}
