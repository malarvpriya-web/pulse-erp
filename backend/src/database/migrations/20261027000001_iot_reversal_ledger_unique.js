/**
 * 20261027000001 — one ledger reversal per IoT service-part issue, at most.
 *
 * reverseIssue (modules/iot/serviceParts.js) now posts the stock_ledger line it
 * always claimed to: quantity_in against the original issue line, with
 * reference_type 'iot_service_reversal' and reference_id = the reversed
 * iot_service_parts row. Its own guard (reversed_at, under a row lock) stops a
 * repeat; this index makes a second reversal line impossible even for a path
 * that skipped that guard.
 *
 * Partial, so it constrains only these lines and nothing else in the ledger.
 * At the time of writing there are no such lines (and no IoT service parts at
 * all in the development database), so it cannot fail on existing data.
 *
 * Rollback: down() drops the index; the application guard remains.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_ledger_iot_service_reversal
      ON stock_ledger (reference_id)
      WHERE reference_type = 'iot_service_reversal'
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ux_stock_ledger_iot_service_reversal`);
}
