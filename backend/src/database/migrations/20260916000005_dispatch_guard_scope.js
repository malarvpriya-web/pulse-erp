/**
 * 20260916000005_dispatch_guard_scope.js
 *
 * Narrows `serial_shipped_requires_package` from INSERT OR UPDATE to UPDATE.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * As written in 20260916000003 the trigger also refused INSERTs, which broke a
 * legitimate case immediately: `iot.gapclosure.test.js` seeds a serial that is
 * already `Delivered`, because its subject is telemetry on a delivered unit, not
 * the dispatch process. Creating a record in a terminal state is what fixtures,
 * data migrations and legacy imports all do, and there is no package to point at
 * because the shipment happened in another system or never happened at all.
 *
 * ── THE BOUNDARY, AND WHY IT IS THE RIGHT ONE ───────────────────────────────
 * The defect this guard exists to prevent is an operational one: the application
 * moving a unit INTO a shipped state without a package accounting for it. That
 * is a TRANSITION, and transitions are updates — the five bad rows the audit
 * found were units the system marked shipped, not units loaded as shipped.
 *
 * An INSERT already in a terminal state is a different act: an assertion about
 * history. Blocking it would make importing historical serials impossible while
 * protecting nothing, because no application path inserts a serial as shipped —
 * packing updates one that already exists.
 *
 * So the transition is constrained and the historical assertion is DETECTED
 * instead: `v_shipped_serials_unlinked` lists any unit in a shipped state with
 * no package behind it, whatever route it arrived by, and the verification
 * script asserts that list is empty. A bad import shows up there rather than
 * being silently impossible to load.
 *
 * ── WHY THE GRN TRIGGER IS NOT NARROWED THE SAME WAY ────────────────────────
 * It is left on INSERT OR UPDATE, and that is a fitted decision rather than an
 * inconsistent one. Nothing in this codebase creates a goods receipt already
 * stamped 'passed' — the full suite passes with the insert path guarded, which
 * is the evidence. Serials demonstrably are created in a terminal state; GRNs
 * demonstrably are not. The guards differ because the traffic differs.
 */

export async function up(knex) {
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_serial_shipped_requires_package ON serial_numbers;
    CREATE TRIGGER trg_serial_shipped_requires_package
      BEFORE UPDATE OF status ON serial_numbers
      FOR EACH ROW EXECUTE FUNCTION serial_shipped_requires_package();
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_serial_shipped_requires_package ON serial_numbers;
    CREATE TRIGGER trg_serial_shipped_requires_package
      BEFORE INSERT OR UPDATE OF status ON serial_numbers
      FOR EACH ROW EXECUTE FUNCTION serial_shipped_requires_package();
  `);
}
