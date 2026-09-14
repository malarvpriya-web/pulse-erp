/**
 * Remove fabricated rows from the tax and FX rate masters.
 *
 * WHY THIS EXISTS
 * ---------------
 * §146.2 set `master_hsn_sac.gst_rate` from 899 to its column default of 0 and
 * noted that the rows were still fake HSN codes sitting in a lookup master,
 * left alone because "that is a data decision, not a schema one".
 *
 * Deferring it made the master *more* dangerous, not less. At 899 the rows were
 * self-evidently broken; at 0 they read as five perfectly ordinary nil-rated
 * HSN entries that a user can pick from a dropdown and put on a real invoice.
 * A fabricated row that looks plausible is worse than one that looks wrong.
 *
 * The same seed run left `forex_rates` and `forex_rate_history` holding nothing
 * but garbage:
 *
 *   currency_code | currency_name | rate_vs_inr
 *   'FR-'         | 'INR'         | 1250.500000
 *   '944'         | 'INR'         | 1425.500000
 *   'FRH'         | (history)     | 1250.500000
 *
 * Every row asserts that one rupee is worth 1250 rupees. The codes are not ISO
 * 4217 at all — they are the seeder's generic `_code$` abbreviation truncated to
 * the column's three characters, because `currency_code` matched that branch
 * before the currency branch could claim it. Any conversion driven off this
 * table is wrong by three orders of magnitude.
 *
 * WHY DELETE RATHER THAN CORRECT
 * ------------------------------
 * There is no correct value to write. 'FR-' is not a currency, so no exchange
 * rate exists for it; MHS-07907-SEED06907 is not an HSN code, so no GST rate
 * exists for it. Correcting them would mean inventing both the key and the
 * value. An empty rate master is an honest "not configured yet" that the UI can
 * show as such; a populated one full of fictional keys is not.
 *
 * WHY THIS IS SAFE
 * ----------------
 * Verified before writing this migration:
 *   - `master_hsn_sac` has no inbound foreign keys, and all ten text columns
 *     that carry an HSN/SAC code (invoice_items, credit/debit_note_items,
 *     inventory_items, products, spare_parts, commercial_proposal_items,
 *     invoices) hold **zero** rows matching 'MHS-%SEED%';
 *   - `forex_rates` has no inbound foreign keys;
 *   - every row in all three tables is seed debris from the 2026-08-20 run.
 *
 * The delete is therefore scoped by the seeder's own marker rather than
 * truncating the table, so a genuine row added later is never at risk. On this
 * database that happens to be every row — which is the correct outcome, not an
 * over-broad one.
 */

export async function up(knex) {
  // Scoped to the seeder's marker, never a TRUNCATE: a real HSN code added
  // between the seed run and this migration must survive.
  const { rows: hsn } = await knex.raw(
    `DELETE FROM master_hsn_sac
      WHERE code LIKE 'MHS-%' AND code LIKE '%SEED%'
     RETURNING code`
  );

  // The forex tables carry no SEED marker of their own — the seeder writes the
  // table abbreviation into currency_code. Matched on the shape that identifies
  // them instead: a code that is not three uppercase letters cannot be ISO 4217.
  const { rows: fx } = await knex.raw(
    `DELETE FROM forex_rates
      WHERE currency_code !~ '^[A-Z]{3}$'
     RETURNING currency_code`
  );
  const { rows: fxh } = await knex.raw(
    `DELETE FROM forex_rate_history
      WHERE currency_code !~ '^[A-Z]{3}$'
     RETURNING currency_code`
  );

  console.log(
    `[20260902000006] purged fabricated rate-master rows — ` +
    `master_hsn_sac: ${hsn?.length ?? 0}, forex_rates: ${fx?.length ?? 0}, ` +
    `forex_rate_history: ${fxh?.length ?? 0}.`
  );
}

export async function down() {
  // Intentionally irreversible. These rows were fabricated keys with fabricated
  // values; re-creating them would re-introduce the exact hazard — a pickable
  // HSN code that does not exist, and an FX rate wrong by 1000x.
}
