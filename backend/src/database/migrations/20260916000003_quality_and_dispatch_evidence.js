/**
 * 20260916000003_quality_and_dispatch_evidence.js
 *
 * Closes the two remaining data worklists — audit findings 16 and 34 — and makes
 * both classes of defect structurally impossible to recreate.
 *
 * ── THE PRINCIPLE APPLIED TO BOTH ───────────────────────────────────────────
 * Each worklist is a record ASSERTING something that no evidence in the database
 * supports. There are exactly three honest responses to such a record, and this
 * migration applies them in order:
 *
 *   1. Where evidence exists, DERIVE the correct value from it.
 *   2. Where no evidence exists, REMOVE the unsupported assertion — preserving
 *      the original value, so nothing is destroyed and the change is auditable.
 *      This is not inventing data; it is withdrawing an invention.
 *   3. Make it impossible to assert it again without the evidence.
 *
 * Step 2 is the one that needs stating plainly: a `quality_status = 'passed'`
 * with zero inspections is not a fact about the material, it is a claim nobody
 * earned. Leaving it reads as a release; flipping it to a pass fabricates a QC
 * record. Returning it to 'pending' says the true thing — this has not been
 * inspected — and the original value is kept alongside.
 *
 * ── FINDING 16: 8 GRNs whose stamp contradicted their inspections ───────────
 * Measured before deciding:
 *
 *   GRN0005  1 inspection, result 'pass'         -> DERIVABLE to passed
 *   GRN0007  1 inspection, result 'fail'         -> DERIVABLE to failed
 *   GRN0006  1 inspection, result 'conditional'  -> a real third verdict the GRN
 *            vocabulary could not express; 'conditional' is added rather than
 *            collapsing it into pass or fail, either of which would misstate it
 *   5 x TRC-* 0 inspections, 0 GRN lines, stamped 'passed' -> UNSUPPORTED,
 *            returned to 'pending' with the original preserved
 *
 * ── FINDING 34: 5 serials flagged shipped with no package line ──────────────
 * Measured before deciding: none has a sales order, a package, or a package
 * line. There is no evidence of dispatch of any kind — not a weak link, an
 * absent one. Their production orders exist, so what IS provable is that they
 * were built. `status` returns to 'active' and the original is preserved.
 *
 * ── PREVENTION ──────────────────────────────────────────────────────────────
 * Two triggers, because a comment asking people not to do this again is not a
 * control:
 *
 *   grn_release_requires_inspection  a GRN cannot be stamped 'passed' unless a
 *                                    passing inspection exists for it
 *   serial_shipped_requires_package  a unit cannot be marked shipped unless a
 *                                    package line or package_id accounts for it
 *
 * Both are BEFORE triggers on the status transition only, so they cost nothing
 * on unrelated updates and never block a correction back to an earlier state.
 */

export async function up(knex) {
  // ── Vocabulary: 'conditional' is a real inspection verdict ────────────────
  await knex.raw(`
    ALTER TABLE goods_receipt_notes DROP CONSTRAINT IF EXISTS goods_receipt_notes_quality_status_check
  `);
  await knex.raw(`
    ALTER TABLE goods_receipt_notes
      ADD CONSTRAINT goods_receipt_notes_quality_status_check
      CHECK (quality_status IS NULL OR quality_status = ANY (ARRAY[
        'not_required','pending','in_progress','passed','failed','conditional'
      ]))
  `);

  // ── Preserve the original before changing anything ───────────────────────
  await knex.raw(`
    ALTER TABLE goods_receipt_notes
      ADD COLUMN IF NOT EXISTS quality_status_prior       text,
      ADD COLUMN IF NOT EXISTS quality_status_prior_note  text
  `);
  await knex.raw(`
    ALTER TABLE serial_numbers
      ADD COLUMN IF NOT EXISTS status_prior       text,
      ADD COLUMN IF NOT EXISTS status_prior_note  text
  `);

  // ── 16.1 DERIVE where the inspections say something definite ─────────────
  await knex.raw(`
    WITH verdict AS (
      SELECT qi.grn_id,
             COUNT(*)                                                                    AS n,
             COUNT(*) FILTER (WHERE LOWER(qi.overall_result) IN ('fail','failed','rejected'))    AS failed,
             COUNT(*) FILTER (WHERE LOWER(qi.overall_result) IN ('pass','passed','accepted'))    AS passed,
             COUNT(*) FILTER (WHERE LOWER(qi.overall_result) = 'conditional')            AS conditional
        FROM quality_inspections qi
       WHERE qi.grn_id IS NOT NULL
       GROUP BY qi.grn_id
    )
    UPDATE goods_receipt_notes g
       SET quality_status_prior = COALESCE(g.quality_status_prior, g.quality_status),
           quality_status_prior_note = 'derived from ' || v.n || ' inspection(s) on 2026-09-16',
           quality_status = CASE
             WHEN v.failed > 0      THEN 'failed'
             WHEN v.conditional > 0 THEN 'conditional'
             WHEN v.passed = v.n    THEN 'passed'
             ELSE g.quality_status
           END,
           quality_status_source = 'derived',
           quality_status_at = NOW(),
           updated_at = NOW()
      FROM verdict v
     WHERE v.grn_id = g.id
       AND g.deleted_at IS NULL
       AND (v.failed > 0 OR v.conditional > 0 OR v.passed = v.n)
  `);

  // ── 16.2 WITHDRAW the unsupported releases ───────────────────────────────
  await knex.raw(`
    UPDATE goods_receipt_notes g
       SET quality_status_prior = COALESCE(g.quality_status_prior, g.quality_status),
           quality_status_prior_note =
             'returned to pending on 2026-09-16: stamped ' || g.quality_status ||
             ' with zero inspection records, so the release could not be evidenced',
           quality_status = 'pending',
           quality_status_source = 'unverified',
           quality_status_at = NOW(),
           updated_at = NOW()
     WHERE g.deleted_at IS NULL
       AND g.quality_status = 'passed'
       AND NOT EXISTS (SELECT 1 FROM quality_inspections qi WHERE qi.grn_id = g.id)
  `);

  // ── 34.1 WITHDRAW the unsupported dispatches ─────────────────────────────
  await knex.raw(`
    UPDATE serial_numbers sn
       SET status_prior = COALESCE(sn.status_prior, sn.status),
           status_prior_note =
             'returned to active on 2026-09-16: flagged ' || sn.status ||
             ' with no package line, package or sales order accounting for it',
           status = 'active',
           updated_at = NOW()
     WHERE sn.deleted_at IS NULL
       AND LOWER(COALESCE(sn.status,'')) IN ('shipped','dispatched','delivered')
       AND sn.package_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM package_lines pl WHERE pl.serial_id = sn.id)
  `);

  // ── PREVENTION 1: no release without an inspection ───────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION grn_release_requires_inspection() RETURNS trigger AS $fn$
    DECLARE v_pass int; v_total int;
    BEGIN
      IF NEW.quality_status IS DISTINCT FROM 'passed' THEN RETURN NEW; END IF;
      IF TG_OP = 'UPDATE' AND OLD.quality_status = 'passed' THEN RETURN NEW; END IF;

      SELECT COUNT(*),
             COUNT(*) FILTER (WHERE LOWER(overall_result) IN ('pass','passed','accepted'))
        INTO v_total, v_pass
        FROM quality_inspections WHERE grn_id = NEW.id;

      IF v_total = 0 THEN
        RAISE EXCEPTION
          'GRN % cannot be released as passed: no incoming inspection has been recorded against it',
          COALESCE(NEW.grn_number, NEW.id::text)
          USING ERRCODE = 'check_violation',
                HINT = 'Record the IQC inspection first, then set the quality status.';
      END IF;
      IF v_pass = 0 THEN
        RAISE EXCEPTION
          'GRN % cannot be released as passed: none of its % inspection(s) recorded a pass',
          COALESCE(NEW.grn_number, NEW.id::text), v_total
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_grn_release_requires_inspection ON goods_receipt_notes;
    CREATE TRIGGER trg_grn_release_requires_inspection
      BEFORE INSERT OR UPDATE OF quality_status ON goods_receipt_notes
      FOR EACH ROW EXECUTE FUNCTION grn_release_requires_inspection();
  `);

  // ── PREVENTION 2: no dispatch without a package ──────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION serial_shipped_requires_package() RETURNS trigger AS $fn$
    BEGIN
      IF LOWER(COALESCE(NEW.status,'')) NOT IN ('shipped','dispatched','delivered') THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE'
         AND LOWER(COALESCE(OLD.status,'')) IN ('shipped','dispatched','delivered') THEN
        RETURN NEW;   -- already in that state; not this trigger's business
      END IF;

      IF NEW.package_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM package_lines pl WHERE pl.serial_id = NEW.id) THEN
        RAISE EXCEPTION
          'Serial % cannot be marked % : no package line or package accounts for it',
          NEW.serial_number, NEW.status
          USING ERRCODE = 'check_violation',
                HINT = 'Pack the unit first — packing links it to a package and its customer.';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_serial_shipped_requires_package ON serial_numbers;
    CREATE TRIGGER trg_serial_shipped_requires_package
      BEFORE INSERT OR UPDATE OF status ON serial_numbers
      FOR EACH ROW EXECUTE FUNCTION serial_shipped_requires_package();
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_grn_release_requires_inspection ON goods_receipt_notes;
    DROP FUNCTION IF EXISTS grn_release_requires_inspection();
    DROP TRIGGER IF EXISTS trg_serial_shipped_requires_package ON serial_numbers;
    DROP FUNCTION IF EXISTS serial_shipped_requires_package();
  `);
  // Restore the preserved originals.
  await knex.raw(`
    UPDATE goods_receipt_notes SET quality_status = quality_status_prior
     WHERE quality_status_prior IS NOT NULL;
    UPDATE serial_numbers SET status = status_prior WHERE status_prior IS NOT NULL;
  `);
  await knex.raw(`
    ALTER TABLE goods_receipt_notes
      DROP COLUMN IF EXISTS quality_status_prior, DROP COLUMN IF EXISTS quality_status_prior_note;
    ALTER TABLE serial_numbers
      DROP COLUMN IF EXISTS status_prior, DROP COLUMN IF EXISTS status_prior_note;
  `);
}
