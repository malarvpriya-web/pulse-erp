/**
 * 20260707000001_department_stores.js
 *
 * Department-wise store separation for inventory.
 *
 * 1. Adds columns the POST /inventory/warehouses route already writes but the
 *    table never had (warehouse_code, location, capacity, status) plus a new
 *    `department` tag used by the Stores Cost Analysis management report to
 *    group stock, EOQ and ABC metrics per department.
 * 2. Seeds the four department stores — Admin, Service, R&D, Production —
 *    (guarded by warehouse_code so re-runs are no-ops) and tags the legacy
 *    Main Warehouse as department 'general'.
 */
export async function up(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'warehouses' AND column_name = 'warehouse_code') THEN
        ALTER TABLE warehouses ADD COLUMN warehouse_code VARCHAR(50);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'warehouses' AND column_name = 'location') THEN
        ALTER TABLE warehouses ADD COLUMN location TEXT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'warehouses' AND column_name = 'capacity') THEN
        ALTER TABLE warehouses ADD COLUMN capacity INTEGER;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'warehouses' AND column_name = 'status') THEN
        ALTER TABLE warehouses ADD COLUMN status VARCHAR(30) DEFAULT 'active';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'warehouses' AND column_name = 'department') THEN
        ALTER TABLE warehouses ADD COLUMN department VARCHAR(50);
      END IF;
    END $$
  `);

  // Unique code per warehouse (NULLs allowed for legacy rows until backfilled)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouses_code
      ON warehouses (warehouse_code) WHERE warehouse_code IS NOT NULL AND deleted_at IS NULL
  `);

  // Tag the legacy main warehouse
  await knex.raw(`
    UPDATE warehouses
       SET department = 'general',
           warehouse_code = COALESCE(warehouse_code, 'MAIN-WH'),
           status = COALESCE(status, 'active')
     WHERE department IS NULL AND deleted_at IS NULL
  `);

  // Seed the four department stores (idempotent — guarded by warehouse_code)
  await knex.raw(`
    INSERT INTO warehouses (name, warehouse_name, warehouse_code, warehouse_type, department, status, company_id)
    SELECT s.name, s.name, s.code, 'department_store', s.department, 'active', 1
    FROM (VALUES
      ('Admin Store',      'ADM-STR', 'admin'),
      ('Service Store',    'SVC-STR', 'service'),
      ('R&D Store',        'RND-STR', 'rnd'),
      ('Production Store', 'PRD-STR', 'production')
    ) AS s(name, code, department)
    WHERE NOT EXISTS (
      SELECT 1 FROM warehouses w
      WHERE w.warehouse_code = s.code AND w.deleted_at IS NULL
    )
  `);
}

export async function down(knex) {
  await knex.raw(`
    DELETE FROM warehouses
     WHERE warehouse_code IN ('ADM-STR','SVC-STR','RND-STR','PRD-STR')
       AND NOT EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.warehouse_id = warehouses.id)
  `);
  await knex.raw(`ALTER TABLE warehouses DROP COLUMN IF EXISTS department`);
}
