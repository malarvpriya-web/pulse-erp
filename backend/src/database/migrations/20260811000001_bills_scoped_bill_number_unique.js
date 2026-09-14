/**
 * `bills_bill_number_key` was a bare UNIQUE(bill_number) — global across every
 * company, not per-tenant. Two unrelated companies (or two different vendors
 * within the same company) using the same invoice number — trivially common
 * with sequential vendor numbering like "INV-1001" — collided. The 3-way-match
 * auto-bill insert (procurement.routes.js, PATCH /three-way-match/:id/approve)
 * relies on `ON CONFLICT (bill_number) DO NOTHING`, so the second bill silently
 * never got created: the match record shows "approved" with no payable bill
 * behind it, and nobody is told. Scoping the constraint to (company_id,
 * bill_number) fixes the false-collision case; the route's ON CONFLICT target
 * is updated to match in the same change.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_bill_number_key`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'bills_company_bill_number_key'
      ) THEN
        ALTER TABLE bills ADD CONSTRAINT bills_company_bill_number_key UNIQUE (company_id, bill_number);
      END IF;
    END $$;
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_company_bill_number_key`);
  await knex.raw(`ALTER TABLE bills ADD CONSTRAINT bills_bill_number_key UNIQUE (bill_number)`);
}
