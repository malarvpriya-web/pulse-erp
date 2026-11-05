/**
 * 20261028000008 — a shipped unit is always accounted for by a package, on
 * every write path.
 *
 * Phase 3I, stage 4. trg_serial_shipped_requires_package (20260915000019) runs
 * BEFORE UPDATE OF status only, so:
 *   - an INSERT of a serial already 'shipped' / 'dispatched' / 'delivered'
 *     with no package was never checked (POST /inventory/serials accepts any
 *     status; the IoT suite's fixture did exactly this and polluted the
 *     traceability worklist v_shipped_serials_unlinked);
 *   - deleting or reassigning the package line that accounted for a shipped
 *     unit, or moving its package to another company, was never checked.
 *
 * The rule, checked at COMMIT (a deferred constraint trigger), so a unit and
 * the package line that accounts for it can be written in one transaction in
 * either order:
 *   a serial whose status is shipped / dispatched / delivered (case-blind) and
 *   that is not deleted must have, in ITS OWN company, either
 *     - package_id naming a package, or
 *     - a live (not unpacked) package line naming it, in a package.
 * Every other status — in_stock, active, in_production, packed, sold, … — is
 * untouched, so valid intermediate states are unaffected.
 *
 * Fired by: serial_numbers INSERT / UPDATE OF status, package_id, company_id,
 * deleted_at; package_lines DELETE / UPDATE OF serial_id, package_id, unpacked,
 * company_id (re-checks the serial the line accounted for); packages UPDATE OF
 * company_id (re-checks the serials it holds). The check locks the serial row
 * (FOR UPDATE) and reads its package lines FOR SHARE, so a status change and a
 * concurrent line deletion cannot both pass: the second waits for the first
 * and sees its result.
 *
 * Existing data (checked 2026-10-28): no serial is in a shipped status, so no
 * row is in breach. The existing immediate trigger stays.
 *
 * Rollback: down() drops the three constraint triggers and the function.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION serial_shipped_is_accounted(p_serial integer) RETURNS void AS $fn$
    DECLARE
      sn record;
    BEGIN
      IF p_serial IS NULL THEN RETURN; END IF;
      SELECT id, serial_number, status, package_id, company_id, deleted_at
        INTO sn FROM serial_numbers WHERE id = p_serial FOR UPDATE;
      IF NOT FOUND OR sn.deleted_at IS NOT NULL
         OR LOWER(COALESCE(sn.status, '')) NOT IN ('shipped', 'dispatched', 'delivered') THEN
        RETURN;
      END IF;
      PERFORM 1 FROM package_lines pl WHERE pl.serial_id = sn.id FOR SHARE;
      IF EXISTS (SELECT 1 FROM packages p WHERE p.id = sn.package_id AND p.company_id IS NOT DISTINCT FROM sn.company_id)
         OR EXISTS (SELECT 1 FROM package_lines pl JOIN packages p ON p.id = pl.package_id
                     WHERE pl.serial_id = sn.id AND NOT pl.unpacked
                       AND p.company_id IS NOT DISTINCT FROM sn.company_id) THEN
        RETURN;
      END IF;
      RAISE EXCEPTION 'Serial % is %, but no package of its own company accounts for it', sn.serial_number, sn.status
        USING ERRCODE = 'check_violation',
              HINT = 'Pack the unit (a package line in the same transaction is enough) before marking it shipped.';
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION serial_shipped_accounted_check() RETURNS trigger AS $fn$
    BEGIN
      IF TG_TABLE_NAME = 'serial_numbers' THEN
        PERFORM serial_shipped_is_accounted(NEW.id);
      ELSIF TG_TABLE_NAME = 'package_lines' THEN
        IF TG_OP IN ('DELETE', 'UPDATE') THEN PERFORM serial_shipped_is_accounted(OLD.serial_id); END IF;
        IF TG_OP = 'UPDATE' AND NEW.serial_id IS DISTINCT FROM OLD.serial_id THEN
          PERFORM serial_shipped_is_accounted(NEW.serial_id);
        END IF;
      ELSIF TG_TABLE_NAME = 'packages' THEN
        PERFORM serial_shipped_is_accounted(s.id)
           FROM (SELECT sn.id FROM serial_numbers sn WHERE sn.package_id = NEW.id
                 UNION SELECT pl.serial_id FROM package_lines pl WHERE pl.package_id = NEW.id AND pl.serial_id IS NOT NULL) s;
      END IF;
      RETURN NULL;
    END
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_serial_shipped_accounted ON serial_numbers`);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER trg_serial_shipped_accounted
      AFTER INSERT OR UPDATE OF status, package_id, company_id, deleted_at ON serial_numbers
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION serial_shipped_accounted_check()
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_package_line_serial_accounted ON package_lines`);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER trg_package_line_serial_accounted
      AFTER DELETE OR UPDATE OF serial_id, package_id, unpacked, company_id ON package_lines
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION serial_shipped_accounted_check()
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_package_serial_accounted ON packages`);
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER trg_package_serial_accounted
      AFTER UPDATE OF company_id ON packages
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION serial_shipped_accounted_check()
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_package_serial_accounted ON packages`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_package_line_serial_accounted ON package_lines`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_serial_shipped_accounted ON serial_numbers`);
  await knex.raw(`DROP FUNCTION IF EXISTS serial_shipped_accounted_check()`);
  await knex.raw(`DROP FUNCTION IF EXISTS serial_shipped_is_accounted(integer)`);
}
