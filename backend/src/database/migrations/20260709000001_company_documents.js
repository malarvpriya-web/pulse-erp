/**
 * 20260709000001_company_documents.js
 *
 * Single home for company reference documents surfaced on the Home Dashboard.
 *   - category = 'policy'        → Policies panel (Travel/Leave/Uniform/etc.)
 *   - category = 'brand_assets'  → Brand Vault panel (logo, deck, letterhead,
 *                                  email-signature templates, reference downloads)
 *
 * Rows are company-scoped (company_id). A NULL company_id row is treated as a
 * global default visible to every company. Seed rows use company_id = 1
 * (the primary tenant) — see NULL company_id scoping notes in project memory.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS company_documents (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER,
      title        VARCHAR(200) NOT NULL,
      category     VARCHAR(40)  NOT NULL,   -- 'policy' | 'brand_assets'
      description  TEXT,
      file_url     TEXT,
      icon         VARCHAR(40),
      is_active    BOOLEAN      NOT NULL DEFAULT true,
      updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_company_documents_category
      ON company_documents (category, is_active, company_id)
  `);

  // Seed a starter set only when the table is empty, so re-running the migration
  // (or running it after an admin has curated documents) never duplicates rows.
  const { rows } = await knex.raw(`SELECT COUNT(*)::int AS n FROM company_documents`);
  if (rows[0].n === 0) {
    await knex.raw(`
      INSERT INTO company_documents (company_id, title, category, description, file_url, icon) VALUES
        (1, 'Travel Policy',            'policy', 'Domestic & international travel, per-diem and booking rules.', '/documents/policies/travel-policy.pdf',        'plane'),
        (1, 'Leave Policy',             'policy', 'Leave types, accrual, carry-forward and application process.', '/documents/policies/leave-policy.pdf',         'calendar'),
        (1, 'Uniform / Dress Code',     'policy', 'Workplace dress code and uniform guidelines.',                 '/documents/policies/dress-code-policy.pdf',    'shirt'),
        (1, 'Code of Conduct',          'policy', 'Expected standards of professional behaviour and ethics.',     '/documents/policies/code-of-conduct.pdf',      'scale'),
        (1, 'Information Security',      'policy', 'Data handling, device and password security policy.',          '/documents/policies/infosec-policy.pdf',       'shield'),
        (1, 'PPT Template',             'brand_assets', 'Branded PowerPoint slide deck template for client presentations.', '/documents/brand/presentation-template.pptx', 'presentation'),
        (1, 'Logo Pack',                'brand_assets', 'Primary, mono and favicon logo files (SVG/PNG).',         '/documents/brand/logo-pack.zip',               'image'),
        (1, 'Colour Codex',             'brand_assets', 'Brand colour palette with HEX / RGB / CMYK codes.',       '/documents/brand/colour-codex.pdf',            'palette'),
        (1, 'Brand Deck',               'brand_assets', 'Full brand guidelines — logo usage, typography, tone.',   '/documents/brand/brand-deck.pdf',              'book'),
        (1, 'Letterhead Template',      'brand_assets', 'Official letterhead (DOCX) for formal correspondence.',   '/documents/brand/letterhead.docx',             'file-text'),
        (1, 'Email Signature Template', 'brand_assets', 'Standard HTML email signature template.',                 '/documents/brand/email-signature.html',        'mail')
    `);
  }
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS company_documents`);
}
