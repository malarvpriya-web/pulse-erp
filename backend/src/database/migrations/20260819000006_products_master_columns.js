/**
 * products — the columns the Product Master screen has always written.
 *
 * `POST /admin/products` and `PUT /admin/products/:id` write 18 columns; the
 * table had 6. The other 14 have never existed, so every create and update
 * threw 42703, and the matching `GET /admin/products` selected them too but
 * swallowed the failure with `catch(e) { res.json([]) }` — so Setup Master has
 * shown an empty product list rather than an error for as long as it has
 * existed. The screen validates GST rate against the statutory set and warranty
 * months as a non-negative integer, so this is a real, finished feature sitting
 * on a table that was never given its columns.
 *
 * `products` is the right home for these: it is the only table these routes
 * touch, it already holds 11 rows, and nothing else reads it apart from a seed.
 * `product_lines` / `product_ratings` are a different concern — they drive the
 * line/rating dropdowns elsewhere and carry no engineering or statutory
 * attributes, so folding this in there would mean inventing a second meaning
 * for those tables.
 *
 * `company_id` is added at the same time: the routes had no tenant filter at
 * all, which is fine while one company exists and a cross-tenant leak the day a
 * second one is created.
 */

export async function up(knex) {
  const cols = [
    ['product_family',      'text'],
    ['model_sku',           'text'],
    ['rating',              'text'],
    ['voltage_class',       'text'],
    ['phase',               'text'],
    ['frequency',           'text'],
    ['topology',            'text'],
    ['cooling',             'text'],
    ['ip_rating',           'text'],
    ['bom_template',        'text'],
    ['routing_template',    'text'],
    ['test_plan_template',  'text'],
    ['warranty_months',     'integer DEFAULT 12'],
    ['hsn_sac',             'text'],
    ['gst_rate',            'numeric(5,2) DEFAULT 18'],
    ['company_id',          'integer REFERENCES companies(id) ON DELETE SET NULL'],
    ['deleted_at',          'timestamptz'],
  ];
  for (const [name, type] of cols) {
    await knex.raw(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ${name} ${type};`);
  }

  // Single-company installs can claim the existing rows unambiguously.
  const { rows } = await knex.raw(`SELECT id FROM companies`);
  if (rows.length === 1) {
    await knex.raw(`UPDATE products SET company_id = ? WHERE company_id IS NULL;`.replace('?', String(rows[0].id)));
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_company
      ON products (company_id) WHERE deleted_at IS NULL;
  `);
  // The business key for a catalogue entry is family + model, per company.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_company_family_model_unique
      ON products (company_id, lower(product_family), lower(model_sku))
      WHERE deleted_at IS NULL AND product_family IS NOT NULL AND model_sku IS NOT NULL AND model_sku <> '';
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS products_company_family_model_unique;`);
  await knex.raw(`DROP INDEX IF EXISTS idx_products_company;`);
  for (const c of ['product_family','model_sku','rating','voltage_class','phase','frequency',
                   'topology','cooling','ip_rating','bom_template','routing_template',
                   'test_plan_template','warranty_months','hsn_sac','gst_rate','company_id','deleted_at']) {
    await knex.raw(`ALTER TABLE products DROP COLUMN IF EXISTS ${c};`);
  }
}
