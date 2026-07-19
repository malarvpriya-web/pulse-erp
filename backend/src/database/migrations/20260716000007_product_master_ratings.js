/**
 * 20260716000007_product_master_ratings.js
 *
 * Makes product_lines the real Product Setup master (owner decision, 2026-07-16)
 * and gives it the Ratings child the reference Product Setup screen shows.
 *
 * Background: 20260716000003 created product_lines for the IPS work and settled
 * that `projects` owns the product line. Nothing has read or written it since —
 * Product Setup instead points at a `products` table whose live schema (6 cols)
 * never matched the 17 columns admin.routes.js selects, so GET /admin/products
 * has always thrown and been swallowed into an empty grid. This migration makes
 * product_lines the master the page manages; `products` is left standing but
 * unused, and its retirement is a later migration once nothing references it.
 *
 *  1. voltage becomes NULLABLE (owner decision) — three of the ten real product
 *     codes have no voltage suffix: ACB, MBheem AHF, MV-VAJRA. voltage_class is
 *     still required, so the LV/MV/HV rollup Project Master reads never goes NULL.
 *
 *  2. display_name is rebuilt around that: 'ASTRA' + '415V' => 'ASTRA - 415V',
 *     but 'ACB' + NULL => 'ACB' rather than the NULL the old expression produced
 *     (anything || NULL is NULL). A generated column's expression cannot be
 *     ALTERed in place, so it is dropped and re-added; nothing referenced it.
 *
 *  3. The uniqueness rule needs NULLS NOT DISTINCT. The old index would let 'ACB'
 *     be inserted unlimited times, because NULL <> NULL under a plain unique
 *     index — exactly the null-voltage rows this migration introduces. PG 15+;
 *     server is 18.2.
 *
 *  4. product_ratings — the 1:N child. The dead ProductSetup form modelled rating
 *     as ONE free-text field on the product; the reference screen shows a
 *     sub-grid of N ratings per product, which is the shape a 100kVAR and a
 *     50kVAR APFC-440V actually need.
 *
 * Seeded with the ten product codes from the owner's reference catalogue. This is
 * the evidence 20260716000003 lacked when it seeded ASTRA alone and said the rest
 * would be authored in the UI. Ratings are deliberately NOT seeded: no rating
 * values were evidenced, and the reference screen itself shows "No data available
 * in table" for products without them — an empty child is a legitimate state, and
 * inventing kVAR figures would put fiction in a master table.
 *
 * The migration runner's `knex` is a thin pg shim: bindings are $n, never `?`.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_pm_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate object/i.test(err.message || '')) throw err;
    }
  };

  // ── 1. voltage is optional; voltage_class stays mandatory ────────────────────
  await safe(`ALTER TABLE product_lines ALTER COLUMN voltage DROP NOT NULL`);

  // ── 2. display_name tolerates a missing voltage ──────────────────────────────
  await safe(`ALTER TABLE product_lines DROP COLUMN IF EXISTS display_name`);
  await safe(`
    ALTER TABLE product_lines
      ADD COLUMN display_name VARCHAR(90)
      GENERATED ALWAYS AS (
        CASE WHEN voltage IS NULL OR voltage = '' THEN line_name
             ELSE line_name || ' - ' || voltage END
      ) STORED
  `);

  // ── 3. uniqueness that counts two NULL voltages as the same row ──────────────
  await safe(`DROP INDEX IF EXISTS uq_product_lines_line_voltage`);
  await safe(`
    CREATE UNIQUE INDEX uq_product_lines_line_voltage
      ON product_lines (company_id, line_name, voltage) NULLS NOT DISTINCT
      WHERE deleted_at IS NULL
  `);

  // ── 4. ratings child ─────────────────────────────────────────────────────────
  // company_id is carried on the child too, so the ratings grid can scope without
  // joining up to the parent on every read.
  await safe(`
    CREATE TABLE IF NOT EXISTS product_ratings (
      id              SERIAL PRIMARY KEY,
      product_line_id INTEGER NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
      rating          VARCHAR(60) NOT NULL,
      description     TEXT,
      company_id      INTEGER,
      is_active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_product_ratings_line ON product_ratings(product_line_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_product_ratings_company ON product_ratings(company_id)`);
  await safe(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_product_ratings_line_rating
      ON product_ratings (product_line_id, rating)
      WHERE deleted_at IS NULL
  `);

  // ── 5. seed the reference catalogue, per company ─────────────────────────────
  // ASTRA/415V already exists from 20260716000003; the NOT EXISTS guard skips it
  // rather than tripping the unique index. IS NOT DISTINCT FROM (not `=`) so the
  // NULL-voltage rows match themselves on a re-run.
  const CATALOGUE = [
    // line_name,     voltage, voltage_class, description
    ['ACB',           null,   'LV', 'Air circuit breaker'],
    ['APFC',          '440V', 'LV', 'Automatic power factor correction panel'],
    ['APFC',          '690V', 'LV', 'Automatic power factor correction panel'],
    ['ASTRA',         '415V', 'LV', 'ASTRA series'],
    ['ASTRA',         '690V', 'LV', 'ASTRA series'],
    ['LEONINE',       '415V', 'LV', 'LEONINE series'],
    ['MBheem AHF',    null,   'LV', 'MBheem active harmonic filter'],
    ['MV-VAJRA',      null,   'MV', 'VAJRA medium-voltage series'],
    ['RTPFC',         '440V', 'LV', 'Real-time power factor correction panel'],
    ['RTPFC',         '690V', 'LV', 'Real-time power factor correction panel'],
  ];

  for (const [line_name, voltage, voltage_class, description] of CATALOGUE) {
    await safe(
      `INSERT INTO product_lines (line_name, voltage, voltage_class, description, company_id)
       SELECT $1::text, $2::text, $3::text, $4::text, c.id
         FROM companies c
        WHERE NOT EXISTS (
          SELECT 1 FROM product_lines pl
           WHERE pl.company_id = c.id
             AND pl.line_name = $1::text
             AND pl.voltage IS NOT DISTINCT FROM $2::text
             AND pl.deleted_at IS NULL
        )`,
      [line_name, voltage, voltage_class, description]
    );
  }

  // The ASTRA row seeded by 20260716000003 carries a note about the catalogue
  // being unknown. It is known now, so retire the note rather than leave the
  // grid explaining a state that no longer holds.
  await safe(
    `UPDATE product_lines SET description = $1, updated_at = NOW()
      WHERE line_name = 'ASTRA' AND voltage = '415V'
        AND description LIKE 'Seeded from the IPS reference%'`,
    ['ASTRA series']
  );
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };

  await safe(`DROP TABLE IF EXISTS product_ratings`);

  // Seeded catalogue rows are removed only where nothing points at them, so a
  // rollback cannot orphan a project's product_line_id. ASTRA/415V predates this
  // migration and stays.
  await safe(`
    DELETE FROM product_lines pl
     WHERE (pl.line_name, COALESCE(pl.voltage,'')) IN (
             ('ACB',''), ('APFC','440V'), ('APFC','690V'), ('ASTRA','690V'),
             ('LEONINE','415V'), ('MBheem AHF',''), ('MV-VAJRA',''),
             ('RTPFC','440V'), ('RTPFC','690V')
           )
       AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.product_line_id = pl.id)
  `);

  await safe(`DROP INDEX IF EXISTS uq_product_lines_line_voltage`);
  await safe(`ALTER TABLE product_lines DROP COLUMN IF EXISTS display_name`);
  await safe(`
    ALTER TABLE product_lines
      ADD COLUMN display_name VARCHAR(90)
      GENERATED ALWAYS AS (line_name || ' - ' || voltage) STORED
  `);
  // Only restorable if no null-voltage row survived (a referenced ACB, say).
  await safe(`ALTER TABLE product_lines ALTER COLUMN voltage SET NOT NULL`);
  await safe(`
    CREATE UNIQUE INDEX uq_product_lines_line_voltage
      ON product_lines (company_id, line_name, voltage)
      WHERE deleted_at IS NULL
  `);
}
