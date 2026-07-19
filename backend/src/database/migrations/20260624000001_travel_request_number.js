export async function up(knex) {
  await knex.raw(`
    ALTER TABLE travel_requests
      ADD COLUMN IF NOT EXISTS request_number VARCHAR(50)
  `);
  await knex.raw(`
    UPDATE travel_requests
       SET request_number = 'TR-' || LPAD(id::text, 3, '0')
     WHERE request_number IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_travel_requests_request_number
      ON travel_requests(request_number)
  `);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE travel_requests DROP COLUMN IF EXISTS request_number`);
}
