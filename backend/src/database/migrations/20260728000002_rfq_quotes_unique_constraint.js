/**
 * 20260728000002_rfq_quotes_unique_constraint.js
 *
 * Both `POST /rfqs/:id/send-to-vendors` and `POST /rfqs/:rfqId/responses/:vendorId`
 * (procurement.routes.js) `INSERT INTO rfq_quotes ... ON CONFLICT (rfq_id, vendor_id)`
 * — but `rfq_quotes` has never had a unique constraint or index on that pair,
 * only a PK on `id` plus two separate single-column indexes. Every call to
 * either endpoint throws "there is no unique or exclusion constraint matching
 * the ON CONFLICT specification", confirmed live — meaning an RFQ could never
 * actually be sent to a vendor, and a vendor's quote could never actually be
 * recorded, through the app's own UI. Found while smoke-testing the RFQ
 * multi-line-items feature (rfq_items, see the previous migration) end-to-end
 * — this earlier break in the same pipeline had been silently making the
 * award/PO-carryover step unreachable through the real flow all along.
 *
 * 0 rows in rfq_quotes in this environment (checked live), so the unique
 * constraint applies cleanly with no conflicting data to resolve first.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_rfqquniq_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE rfq_quotes ADD CONSTRAINT rfq_quotes_rfq_vendor_unique UNIQUE (rfq_id, vendor_id)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE rfq_quotes DROP CONSTRAINT IF EXISTS rfq_quotes_rfq_vendor_unique`);
}
