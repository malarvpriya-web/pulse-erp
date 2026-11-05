/**
 * 20261019000001_home_documents_governance.js
 *
 * Home's Policies and Brand Vault panels: what reaches every employee, and
 * what each tile downloads.
 *
 * hr_policies
 *   + is_active  — HR retires a policy without deleting its acknowledgement
 *                  history. Home and the employee view show active rows only.
 *   applicable_to already exists ('all' default). It is now the audience flag:
 *   'all' = company-wide, employee-facing (shown on Home); anything else
 *   ('internal', or the SEED placeholders) stays inside the HR module. Read
 *   fail-closed, so no data change is needed here.
 *
 * company_documents (Brand Vault)
 *   + version, effective_date — same metadata the Policies page carries.
 *   - Exactly one Presentation Template: 'PPT Template' and 'Presentation
 *     Template' were both live with the same file. The duplicate is retired;
 *     a lone 'PPT Template' is renamed instead.
 *   - 'Colour Codex' → 'Colour Codex / Brand Guidelines'.
 *   - Adds Quotation Template, Purchase Order Template, Certificate Templates
 *     as unlinked placeholders (an admin pastes the Drive link in Settings →
 *     Brand Vault; until then the tile says "Not linked yet").
 *   - Clears the '/documents/brand/…' paths: no such files have ever existed
 *     (the SPA served its own index.html for every one), so the tile offered a
 *     download of a web page. NULL makes the tile say so honestly.
 *   - One active row per (company, category, title), so the duplicate cannot
 *     come back through the admin editor.
 */
const NEW_BRAND = [
  ['Quotation Template',       'Standard customer quotation format'],
  ['Purchase Order Template',  'Standard purchase order format'],
  ['Certificate Templates',    'Company certificate formats (completion, experience, training)'],
];

export async function up(knex) {
  await knex.raw(`ALTER TABLE hr_policies ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);

  const { rows } = await knex.raw(`SELECT to_regclass('public.company_documents') AS t`);
  if (!rows[0].t) return;

  await knex.raw(`
    ALTER TABLE company_documents
      ADD COLUMN IF NOT EXISTS version        VARCHAR(20),
      ADD COLUMN IF NOT EXISTS effective_date DATE
  `);

  // One Presentation Template per company.
  await knex.raw(`
    UPDATE company_documents d
       SET is_active = false, updated_at = NOW()
     WHERE d.category = 'brand_assets' AND d.is_active AND d.title = 'PPT Template'
       AND EXISTS (SELECT 1 FROM company_documents p
                    WHERE p.category = 'brand_assets' AND p.is_active
                      AND p.title = 'Presentation Template'
                      AND p.company_id IS NOT DISTINCT FROM d.company_id)
  `);
  await knex.raw(`
    UPDATE company_documents SET title = 'Presentation Template', updated_at = NOW()
     WHERE category = 'brand_assets' AND is_active AND title = 'PPT Template'
  `);
  await knex.raw(`
    UPDATE company_documents SET title = 'Colour Codex / Brand Guidelines', updated_at = NOW()
     WHERE category = 'brand_assets' AND title = 'Colour Codex'
  `);
  await knex.raw(`
    UPDATE company_documents SET file_url = NULL, updated_at = NOW()
     WHERE category = 'brand_assets' AND file_url LIKE '/documents/%'
  `);

  for (const [title, description] of NEW_BRAND) {
    await knex.raw(`
      INSERT INTO company_documents (company_id, title, category, description, file_url, icon)
      SELECT c.company_id, $1::text, 'brand_assets', $2::text, NULL, 'file-text'
        FROM (SELECT DISTINCT company_id FROM company_documents WHERE category = 'brand_assets') c
       WHERE NOT EXISTS (SELECT 1 FROM company_documents x
                          WHERE x.category = 'brand_assets' AND x.is_active
                            AND LOWER(x.title) = LOWER($1::text)
                            AND x.company_id IS NOT DISTINCT FROM c.company_id)
    `, [title, description]);
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS company_documents_active_title_uq
      ON company_documents (COALESCE(company_id, 0), category, LOWER(BTRIM(title)))
      WHERE is_active
  `);
}

export async function down(knex) {
  const { rows } = await knex.raw(`SELECT to_regclass('public.company_documents') AS t`);
  if (rows[0].t) {
    await knex.raw(`DROP INDEX IF EXISTS company_documents_active_title_uq`);
    await knex.raw(`
      DELETE FROM company_documents
       WHERE category = 'brand_assets' AND file_url IS NULL
         AND title IN ('Quotation Template','Purchase Order Template','Certificate Templates')
    `);
    await knex.raw(`
      UPDATE company_documents SET title = 'Colour Codex', updated_at = NOW()
       WHERE category = 'brand_assets' AND title = 'Colour Codex / Brand Guidelines'
    `);
    // The cleared placeholder paths and the retired duplicate are not
    // restored: neither pointed at a file.
    await knex.raw(`
      ALTER TABLE company_documents
        DROP COLUMN IF EXISTS version,
        DROP COLUMN IF EXISTS effective_date
    `);
  }
  await knex.raw(`ALTER TABLE hr_policies DROP COLUMN IF EXISTS is_active`);
}
