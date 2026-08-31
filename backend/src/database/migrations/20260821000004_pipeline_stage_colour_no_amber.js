/**
 * Bring the seeded pipeline-stage colours onto the Pulse ramp.
 *
 * The opportunity board used to hardcode its own stage colours and the Hero Kit
 * rollout retuned them there — Proposal moved off amber `#D97706` onto violet
 * `#6d28d9`, because the app-wide rule is that nothing is orange (the amber
 * ramp was replaced with lavender). `crm_pipeline_stages` never got the same
 * treatment, since nothing read it.
 *
 * Now that the board takes its columns from the stage master, that stale amber
 * is what renders. This aligns the master, which is the single lever for stage
 * appearance.
 *
 * Scoped to rows still carrying the exact seeded value: a company that has
 * picked its own colour in Pipeline Settings keeps it.
 */

const SEEDED_AMBER = '#D97706';
const RAMP_VIOLET  = '#6d28d9';

export async function up(knex) {
  const { rowCount } = await knex.raw(
    `UPDATE crm_pipeline_stages SET color = $1 WHERE color = $2`,
    [RAMP_VIOLET, SEEDED_AMBER]
  );
  if (rowCount) console.log(`   ↳ retinted ${rowCount} pipeline stage(s) off amber`);
}

export async function down(knex) {
  await knex.raw(
    `UPDATE crm_pipeline_stages SET color = $1 WHERE color = $2`,
    [SEEDED_AMBER, RAMP_VIOLET]
  );
}
