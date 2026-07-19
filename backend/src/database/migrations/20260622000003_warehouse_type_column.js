export async function up(knex) {
  await knex.raw(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS warehouse_type VARCHAR(50)`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE warehouses DROP COLUMN IF EXISTS warehouse_type`);
}
