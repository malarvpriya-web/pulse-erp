/**
 * 20261027000002 — shipment references are unique per company, not globally.
 *
 * Shipment references (DSP-nnnnnn) are numbered per company — MAX + 1 over the
 * company's own shipments (pickListWorkflow.service nextDispatchRef) — but
 * 20260911000013 made dispatch_ref unique across ALL companies. So the second
 * company to dispatch computed DSP-000001, which another company already held,
 * and its insert failed — every time, because its own MAX never moves. In
 * practice: only one tenant (beyond company 1, whose legacy references use a
 * different format) could ever dispatch anything.
 *
 * The index becomes (company_id, dispatch_ref). Every existing row was globally
 * unique, so it is certainly unique per company: this cannot fail on existing
 * data. The new index is created before the old one is dropped, so there is no
 * moment with no uniqueness at all.
 *
 * Rollback: down() restores the global index — which only succeeds while no two
 * companies share a reference, i.e. before a second tenant has dispatched.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_company_dispatch_ref
      ON shipments (company_id, dispatch_ref) WHERE dispatch_ref IS NOT NULL
  `);
  await knex.raw(`DROP INDEX IF EXISTS uq_shipments_dispatch_ref`);
}

export async function down(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_shipments_dispatch_ref
      ON shipments (dispatch_ref) WHERE dispatch_ref IS NOT NULL
  `);
  await knex.raw(`DROP INDEX IF EXISTS uq_shipments_company_dispatch_ref`);
}
