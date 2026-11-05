/**
 * 20260915000004_einvoice_irn_persistence.js
 *
 * Finance audit finding F15.
 *
 * POST /gst/e-invoice/generate guarded against duplicates with:
 *
 *     if (inv.irn) return res.status(409).json({ error: 'IRN already generated' });
 *
 * `invoices` has no `irn` column. The guard read undefined every time and never
 * fired — so nothing prevented the same invoice being submitted for an IRN
 * repeatedly, and there was nowhere to keep an acknowledgement if one ever came
 * back. The same was true of the e-way bill route.
 *
 * These columns give both flows somewhere to record what the portal returned,
 * which is what makes the duplicate guard real and the result auditable.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS irn               character varying(64),
      ADD COLUMN IF NOT EXISTS irn_ack_no        character varying(32),
      ADD COLUMN IF NOT EXISTS irn_ack_date      timestamptz,
      ADD COLUMN IF NOT EXISTS irn_status        character varying(20),
      ADD COLUMN IF NOT EXISTS irn_cancelled_at  timestamptz,
      ADD COLUMN IF NOT EXISTS signed_qr_code    text,
      ADD COLUMN IF NOT EXISTS ewb_no            character varying(24),
      ADD COLUMN IF NOT EXISTS ewb_date          timestamptz,
      ADD COLUMN IF NOT EXISTS ewb_valid_until   timestamptz
  `);

  // An IRN is unique per invoice nationally. Partial unique index so the many
  // rows with no IRN yet do not collide with each other.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_irn
      ON invoices (irn)
   WHERE irn IS NOT NULL
  `);

  console.log('[migration 20260915000004] invoices can now record IRN and e-way-bill acknowledgements.');
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS uq_invoices_irn`);
  await knex.raw(`
    ALTER TABLE invoices
      DROP COLUMN IF EXISTS irn,
      DROP COLUMN IF EXISTS irn_ack_no,
      DROP COLUMN IF EXISTS irn_ack_date,
      DROP COLUMN IF EXISTS irn_status,
      DROP COLUMN IF EXISTS irn_cancelled_at,
      DROP COLUMN IF EXISTS signed_qr_code,
      DROP COLUMN IF EXISTS ewb_no,
      DROP COLUMN IF EXISTS ewb_date,
      DROP COLUMN IF EXISTS ewb_valid_until
  `);
}
