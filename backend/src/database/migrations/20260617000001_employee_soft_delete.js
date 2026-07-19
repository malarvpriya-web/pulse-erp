/**
 * Add deleted_at to employees for soft-delete support.
 * Replaces hard DELETE with status='terminated' + deleted_at timestamp.
 */
export async function up(knex) {
  await knex.raw(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS deleted_at`);
}
