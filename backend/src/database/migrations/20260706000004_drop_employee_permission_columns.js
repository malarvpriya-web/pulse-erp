/**
 * 20260706000004_drop_employee_permission_columns.js
 *
 * The Add/Edit Employee form used to carry a "System Permissions" section that
 * wrote 12 boolean flags directly onto the employees table
 * (employee_view/add/edit/delete, finance_view/edit/approve,
 * project_view/add/edit, report_view/export).
 *
 * These per-employee flags were never read by any access-control logic — real
 * authorization is driven by roles + the menu_permissions table (Settings →
 * Access Control → Page Access), configured per role/department on its own
 * page. The columns were therefore write-only dead data and caused a mismatch
 * between the (now simplified) form and the backend.
 *
 * This migration drops the 12 columns so the schema matches the form and the
 * addEmployee/updateEmployee service, which no longer reference them.
 */
const PERMISSION_COLUMNS = [
  "employee_view",
  "employee_add",
  "employee_edit",
  "employee_delete",
  "finance_view",
  "finance_edit",
  "finance_approve",
  "project_view",
  "project_add",
  "project_edit",
  "report_view",
  "report_export",
];

export async function up(knex) {
  const drops = PERMISSION_COLUMNS.map((c) => `DROP COLUMN IF EXISTS ${c}`).join(",\n      ");
  await knex.raw(`ALTER TABLE employees\n      ${drops};`);
}

export async function down(knex) {
  const adds = PERMISSION_COLUMNS.map(
    (c) => `ADD COLUMN IF NOT EXISTS ${c} BOOLEAN DEFAULT false`
  ).join(",\n      ");
  await knex.raw(`ALTER TABLE employees\n      ${adds};`);
}
