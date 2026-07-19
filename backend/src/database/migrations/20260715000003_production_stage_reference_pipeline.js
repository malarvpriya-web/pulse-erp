/**
 * 20260715000003_production_stage_reference_pipeline.js
 *
 * Adopts the canonical Manifest SST/HVDC production pipeline as the single
 * `production_stage` vocabulary used by the Project Pipeline (kanban), the
 * Project Master / Delivery Tracker grid, and the project Edit drawer.
 *
 * Canonical pipeline (order):
 *   created → handover → dr_approval → procurement → production → clearing → dispatched
 *
 * Legacy → canonical remap (idempotent — a second run matches nothing):
 *   design                              → dr_approval
 *   fabrication                         → production
 *   testing, pre_commission, commission → clearing    (final QA / commissioning clearance)
 *   dispatch                            → dispatched
 *   handover (legacy = final delivery)  → dispatched   ⚠ semantic collision: in the new
 *        model `handover` is the early order→production handover, NOT final delivery, so
 *        legacy "delivered" rows are moved to the terminal `dispatched` stage instead of
 *        being sent back to stage 2.
 *   procurement, planning, created      → unchanged
 *
 * Also adds `projects.actual_delivery_date` — stamped when a project reaches
 * `dispatched` (see PATCH /projects/projects/:id/stage). The kanban card's
 * "Delivery date" shows actual_delivery_date, falling back to target_date.
 *
 * down() drops the new column and cannot un-merge the many→one remaps
 * (testing/pre_commission/commission → clearing); it is best-effort.
 */

const REMAP = [
  { to: 'dr_approval', from: ['design'] },
  { to: 'production',  from: ['fabrication'] },
  { to: 'clearing',    from: ['testing', 'pre_commission', 'commission'] },
  { to: 'dispatched',  from: ['dispatch', 'handover'] },
];

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_prodpipe_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS actual_delivery_date DATE`);

  for (const { to, from } of REMAP) {
    await safe(
      `UPDATE projects SET production_stage = $1 WHERE production_stage = ANY($2::text[])`,
      [to, from]
    );
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE projects DROP COLUMN IF EXISTS actual_delivery_date`);
  // Best-effort partial reversal of the 1:1 remaps only.
  await knex.raw(`UPDATE projects SET production_stage = 'design'      WHERE production_stage = 'dr_approval'`);
  await knex.raw(`UPDATE projects SET production_stage = 'fabrication' WHERE production_stage = 'production'`);
  await knex.raw(`UPDATE projects SET production_stage = 'dispatch'    WHERE production_stage = 'dispatched'`);
  // 'clearing' cannot be split back into testing/pre_commission/commission — left as-is.
}
