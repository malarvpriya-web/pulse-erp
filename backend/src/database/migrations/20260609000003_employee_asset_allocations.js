/**
 * Employee Asset Allocation module — track IT equipment, tools, furniture etc per employee.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS employee_asset_allocations (
      id              SERIAL        PRIMARY KEY,
      company_id      INTEGER       REFERENCES companies(id),
      employee_id     INTEGER       NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      asset_type      VARCHAR(100)  NOT NULL,
      asset_name      VARCHAR(200)  NOT NULL,
      asset_tag       VARCHAR(100),
      serial_number   VARCHAR(200),
      brand           VARCHAR(100),
      model           VARCHAR(100),
      allocated_date  DATE          NOT NULL DEFAULT CURRENT_DATE,
      return_date     DATE,
      condition_in    VARCHAR(50)   DEFAULT 'good',
      condition_out   VARCHAR(50),
      status          VARCHAR(30)   NOT NULL DEFAULT 'allocated',
      notes           TEXT,
      allocated_by    INTEGER       REFERENCES employees(id),
      returned_to     INTEGER       REFERENCES employees(id),
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_asset_alloc_employee ON employee_asset_allocations(employee_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_asset_alloc_company  ON employee_asset_allocations(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_emp_asset_alloc_status   ON employee_asset_allocations(status)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS employee_asset_allocations CASCADE`);
}
