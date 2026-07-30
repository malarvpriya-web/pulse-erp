/**
 * Discount-approval gate at Quotation -> Sales Order conversion.
 *
 * Two real gaps, not one. `discount_approvals` has no link to a quotation
 * (only loose `lead_id`/`order_id` integers) -- flagged repeatedly across
 * this audit's history. But the deeper issue: `quotations` itself has no
 * discount column at all. Quotations.jsx's builder already has a header
 * "Discount %" field and sends it as `discount` in the POST /quotations
 * body, but quotationsRepository.create() never destructures it, so it's
 * silently dropped -- every quotation's discount evaporates the moment the
 * form submits. Nothing to gate without a place for the number to land.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE quotations
      ADD COLUMN IF NOT EXISTS discount_pct NUMERIC(5,2) DEFAULT 0
  `);
  await knex.raw(`
    ALTER TABLE discount_approvals
      ADD COLUMN IF NOT EXISTS quotation_id INTEGER REFERENCES quotations(id)
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE discount_approvals DROP COLUMN IF EXISTS quotation_id`);
  await knex.raw(`ALTER TABLE quotations DROP COLUMN IF EXISTS discount_pct`);
}
