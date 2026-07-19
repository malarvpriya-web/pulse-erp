/**
 * 20260709000003_brand_templates_seed.js
 *
 * Ensures the Home Dashboard "Brand Vault" panel always has the core templates
 * (PPT template, logo, colour codex) even on databases where
 * 20260709000001_company_documents already ran with the earlier seed set.
 *
 * Each row is inserted only when a document with the same title+category
 * doesn't already exist for company 1, so this is safe to run repeatedly and
 * never duplicates an admin-curated row.
 */
const TEMPLATES = [
  ['PPT Template',   'Branded PowerPoint slide deck template for client presentations.', '/documents/brand/presentation-template.pptx', 'presentation'],
  ['Logo Pack',      'Primary, mono and favicon logo files (SVG/PNG).',                  '/documents/brand/logo-pack.zip',              'image'],
  ['Colour Codex',   'Brand colour palette with HEX / RGB / CMYK codes.',                '/documents/brand/colour-codex.pdf',           'palette'],
];

export async function up(knex) {
  // Table may not exist if the create migration hasn't run yet — bail quietly.
  const { rows } = await knex.raw(`SELECT to_regclass('public.company_documents') AS t`);
  if (!rows[0].t) return;

  for (const [title, description, file_url, icon] of TEMPLATES) {
    await knex.raw(
      `INSERT INTO company_documents (company_id, title, category, description, file_url, icon)
       SELECT 1, $1::text, 'brand_assets', $2::text, $3::text, $4::text
        WHERE NOT EXISTS (
          SELECT 1 FROM company_documents
           WHERE category = 'brand_assets' AND title = $5::text
             AND (company_id = 1 OR company_id IS NULL)
        )`,
      [title, description, file_url, icon, title]
    );
  }
}

export async function down(knex) {
  const { rows } = await knex.raw(`SELECT to_regclass('public.company_documents') AS t`);
  if (!rows[0].t) return;
  for (const [title] of TEMPLATES) {
    await knex.raw(
      `DELETE FROM company_documents WHERE category = 'brand_assets' AND title = $1`,
      [title]
    );
  }
}
