/**
 * 20260916000004_iqc_exemption_override.js
 *
 * Corrects a silent side effect of 20260916000003, and adds the check that would
 * have surfaced it.
 *
 * ── WHAT HAPPENED ───────────────────────────────────────────────────────────
 * The derive step in the previous migration was written for the 8 GRNs listed in
 * v_iqc_status_conflicts. Its WHERE clause selected on "has inspections with a
 * definite verdict" and did not exclude `quality_status = 'not_required'` — so it
 * also touched a ninth GRN that was never on the worklist:
 *
 *   GRN-01523-SEED00523   not_required -> failed
 *
 * `not_required` is not an absence of a decision, it is a decision: somebody
 * declared this receipt exempt from incoming inspection. Overriding it as a side
 * effect of fixing a different problem is exactly the kind of quiet, unannounced
 * change this audit exists to find.
 *
 * ── WHY THE RESULT IS NEVERTHELESS LEFT IN PLACE ────────────────────────────
 * That GRN has TWO inspections — a pass on 10 Aug and a FAIL on 14 Aug. The
 * exemption was an a-priori judgement that inspection was unnecessary; the
 * failure is a-posteriori evidence that the material is bad. Evidence outranks
 * the prior judgement, and it does so in the safe direction: material that failed
 * an inspection must not read as releasable merely because inspecting it was
 * optional.
 *
 * Reverting to `not_required` to tidy up the side effect would leave a receipt
 * with a recorded failure looking exempt. So the value stays `failed` — but the
 * note now SAYS the exemption was overridden and why, instead of the generic
 * "derived from 2 inspection(s)" it inherited.
 *
 * ── THE RULE, STATED ────────────────────────────────────────────────────────
 * An exemption is overridden by a FAILURE and by nothing else. A `not_required`
 * GRN whose inspections all passed keeps its exemption: there is no contradiction
 * to resolve and no safety reason to churn the record.
 *
 * ── AND THE CHECK THAT WOULD HAVE CAUGHT IT ─────────────────────────────────
 * `exempt_but_inspected` is added to v_iqc_status_conflicts: a receipt still
 * marked exempt that nonetheless carries inspection records. It reads zero now —
 * the only such row resolved to `failed` above — but the class is visible from
 * here on rather than needing someone to notice it in a diff.
 */

export async function up(knex) {
  // Say what was actually done to the overridden row.
  await knex.raw(`
    UPDATE goods_receipt_notes g
       SET quality_status_prior_note =
             'exemption overridden on 2026-09-16: marked not_required, but an incoming '
             || 'inspection recorded a FAIL. A failure outranks an exemption — material that '
             || 'failed inspection must not read as releasable because inspecting it was optional.'
     WHERE g.quality_status_prior = 'not_required'
       AND g.quality_status = 'failed'
       AND EXISTS (
         SELECT 1 FROM quality_inspections qi
          WHERE qi.grn_id = g.id
            AND LOWER(qi.overall_result) IN ('fail','failed','rejected'))
  `);

  // Restore any exemption that was overridden WITHOUT a failure behind it —
  // there is no such row today, and this makes sure there is never one.
  await knex.raw(`
    UPDATE goods_receipt_notes g
       SET quality_status = 'not_required',
           quality_status_source = 'not_required',
           quality_status_prior_note = 'exemption restored on 2026-09-16: no failing inspection '
             || 'justified overriding it',
           updated_at = NOW()
     WHERE g.quality_status_prior = 'not_required'
       AND g.quality_status <> 'not_required'
       AND NOT EXISTS (
         SELECT 1 FROM quality_inspections qi
          WHERE qi.grn_id = g.id
            AND LOWER(qi.overall_result) IN ('fail','failed','rejected'))
  `);

  await knex.raw(`
    CREATE OR REPLACE VIEW v_iqc_status_conflicts AS
    SELECT g.id                AS grn_id,
           g.grn_number,
           g.company_id,
           g.received_date,
           g.quality_status,
           g.quality_status_source,
           COUNT(qi.id)        AS inspection_count,
           COUNT(qi.id) FILTER (WHERE LOWER(COALESCE(qi.overall_result,'')) IN ('pass','passed','accepted')) AS passed_count,
           COUNT(qi.id) FILTER (WHERE LOWER(COALESCE(qi.overall_result,'')) IN ('fail','failed','rejected')) AS failed_count,
           CASE
             WHEN g.quality_status = 'passed' AND COUNT(qi.id) = 0
               THEN 'released_without_inspection'
             WHEN g.quality_status = 'pending' AND COUNT(qi.id) > 0
               THEN 'inspected_but_not_released'
             WHEN g.quality_status = 'passed'
                  AND COUNT(qi.id) FILTER (WHERE LOWER(COALESCE(qi.overall_result,'')) IN ('fail','failed','rejected')) > 0
               THEN 'released_despite_failure'
             WHEN g.quality_status = 'not_required' AND COUNT(qi.id) > 0
               THEN 'exempt_but_inspected'
           END AS conflict
      FROM goods_receipt_notes g
      LEFT JOIN quality_inspections qi ON qi.grn_id = g.id
     WHERE g.deleted_at IS NULL
     GROUP BY g.id, g.grn_number, g.company_id, g.received_date,
              g.quality_status, g.quality_status_source
    HAVING (g.quality_status = 'passed' AND COUNT(qi.id) = 0)
        OR (g.quality_status = 'pending' AND COUNT(qi.id) > 0)
        OR (g.quality_status = 'not_required' AND COUNT(qi.id) > 0)
        OR (g.quality_status = 'passed'
            AND COUNT(qi.id) FILTER (WHERE LOWER(COALESCE(qi.overall_result,'')) IN ('fail','failed','rejected')) > 0)
  `);
}

export async function down(knex) {
  // The previous migration's view definition, without exempt_but_inspected.
  await knex.raw(`
    CREATE OR REPLACE VIEW v_iqc_status_conflicts AS
    SELECT g.id AS grn_id, g.grn_number, g.company_id, g.received_date,
           g.quality_status, g.quality_status_source,
           COUNT(qi.id) AS inspection_count,
           COUNT(qi.id) FILTER (WHERE LOWER(COALESCE(qi.overall_result,'')) IN ('pass','passed','accepted')) AS passed_count,
           COUNT(qi.id) FILTER (WHERE LOWER(COALESCE(qi.overall_result,'')) IN ('fail','failed','rejected')) AS failed_count,
           CASE
             WHEN g.quality_status = 'passed' AND COUNT(qi.id) = 0 THEN 'released_without_inspection'
             WHEN g.quality_status = 'pending' AND COUNT(qi.id) > 0 THEN 'inspected_but_not_released'
             WHEN g.quality_status = 'passed'
                  AND COUNT(qi.id) FILTER (WHERE LOWER(COALESCE(qi.overall_result,'')) IN ('fail','failed','rejected')) > 0
               THEN 'released_despite_failure'
           END AS conflict
      FROM goods_receipt_notes g
      LEFT JOIN quality_inspections qi ON qi.grn_id = g.id
     WHERE g.deleted_at IS NULL
     GROUP BY g.id, g.grn_number, g.company_id, g.received_date, g.quality_status, g.quality_status_source
    HAVING (g.quality_status = 'passed' AND COUNT(qi.id) = 0)
        OR (g.quality_status = 'pending' AND COUNT(qi.id) > 0)
        OR (g.quality_status = 'passed'
            AND COUNT(qi.id) FILTER (WHERE LOWER(COALESCE(qi.overall_result,'')) IN ('fail','failed','rejected')) > 0)
  `);
}
