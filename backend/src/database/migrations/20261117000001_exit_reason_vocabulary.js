/**
 * 20261117000001_exit_reason_vocabulary.js — Exit Management review 2026-11-17.
 *
 * Exit-interview reasons were six keys fixed in ExitManagement.jsx
 * (REASON_LABELS). They become the EXIT_REASON master_values vocabulary
 * (registry key 'exit-reasons', modules/master/vocabularies.js), editable in
 * Settings → Master Data and from the interview form's picker, like the three
 * HR lists of 20261116000008.
 *
 * The seeds are the old six, shared (company_id NULL). Reasons are stored by
 * name from now on ('Better Opportunity', not 'better_opportunity'); stored
 * keys are renamed below so old interviews still group with new ones.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const SEED = ['Better Opportunity', 'Compensation', 'Work Environment', 'Personal', 'Relocation', 'Other'];
const RENAMES = {
  better_opportunity: 'Better Opportunity', compensation: 'Compensation', work_environment: 'Work Environment',
  personal: 'Personal', relocation: 'Relocation', other: 'Other',
};

export async function up(knex) {
  for (let i = 0; i < SEED.length; i++) {
    await knex.raw(
      `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
       VALUES ('EXIT_REASON', $1, NULL, $2, NULL, true)
       ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
      [SEED[i], i + 1]);
  }
  for (const [key, name] of Object.entries(RENAMES)) {
    await knex.raw(`UPDATE exit_interviews SET reason_category = $2 WHERE reason_category = $1`, [key, name]);
  }
}

export async function down(knex) {
  for (const [key, name] of Object.entries(RENAMES)) {
    await knex.raw(`UPDATE exit_interviews SET reason_category = $1 WHERE reason_category = $2`, [key, name]);
  }
  await knex.raw(`DELETE FROM master_values WHERE company_id IS NULL AND type = 'EXIT_REASON'`);
}
