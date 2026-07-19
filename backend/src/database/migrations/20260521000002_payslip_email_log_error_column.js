/**
 * 20260521000002_payslip_email_log_error_column.js
 * Adds error column to payslip_email_log so failed sends can be distinguished
 * from successful ones and the error reason recorded.
 */

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE payslip_email_log
      ADD COLUMN IF NOT EXISTS error TEXT;
  `);
}

export async function down(knex) {
  await knex.raw(`
    ALTER TABLE payslip_email_log
      DROP COLUMN IF EXISTS error;
  `);
}
