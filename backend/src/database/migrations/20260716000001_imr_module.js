/**
 * 20260716000001_imr_module.js
 *
 * Module Production Batch Request (IMR) — the request layer that sits between a
 * project (IPP) and a production batch (a production_orders row, the de-facto MPP).
 *
 * Two tables + one sequence:
 *   module_production_requests        — header / grid row (IMR-00001 …)
 *   module_production_request_lines   — each "Requested Module" line (spec + qty)
 *   seq_imr                           — atomic IMR number generator
 *
 * Relationship chain (traceable both ways):
 *   IMR.project_id            → projects(id)            (IMR → IPP)
 *   IMR.production_order_id   → production_orders(id)   (IMR → MPP/batch, set on Assign)
 *   production_orders.project_id → projects(id)         (backbone FK, 20260715000001)
 *
 * Status lifecycle (enforced in imr.routes.js, guarded by CHECK here):
 *   draft → submitted → partially_assigned → completed   (+ cancelled from any pre-terminal state)
 *
 * Total Quantity / Assigned Qty are NEVER stored on the header — they are summed
 * from the lines on read, so they can never drift from the line items.
 */

export async function up(knex) {
  let sp = 0;
  const safe = async (sql, params) => {
    const name = `sp_imr_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql, params);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate/i.test(err.message || '')) throw err;
    }
  };

  // ── header ──────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS module_production_requests (
      id                  SERIAL PRIMARY KEY,
      imr_no              VARCHAR(20) UNIQUE NOT NULL,
      company_id          INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      project_id          INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      production_order_id INTEGER REFERENCES production_orders(id) ON DELETE SET NULL,
      status              VARCHAR(20) NOT NULL DEFAULT 'draft',
      notes               TEXT,
      created_by          INTEGER,
      created_by_name     VARCHAR(150),
      submitted_at        TIMESTAMPTZ,
      completed_at        TIMESTAMPTZ,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_imr_status
        CHECK (status IN ('draft','submitted','partially_assigned','completed','cancelled'))
    )
  `);

  // ── lines ───────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS module_production_request_lines (
      id             SERIAL PRIMARY KEY,
      request_id     INTEGER NOT NULL REFERENCES module_production_requests(id) ON DELETE CASCADE,
      module_spec    VARCHAR(255) NOT NULL,
      product_id     INTEGER,
      unit           VARCHAR(20) NOT NULL DEFAULT 'No.',
      requested_qty  NUMERIC(14,3) NOT NULL DEFAULT 0,
      assigned_qty   NUMERIC(14,3) NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // ── indexes ──────────────────────────────────────────────────────────────────
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_imr_company     ON module_production_requests(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_imr_project     ON module_production_requests(project_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_imr_prod_order  ON module_production_requests(production_order_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_imr_status      ON module_production_requests(status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_imr_lines_req   ON module_production_request_lines(request_id)`);

  // ── sequence (this migration set runs after 20260520000002, so create fresh) ──
  await safe(`CREATE SEQUENCE IF NOT EXISTS seq_imr START WITH 1 INCREMENT BY 1 NO CYCLE`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS module_production_request_lines`);
  await knex.raw(`DROP TABLE IF EXISTS module_production_requests`);
  await knex.raw(`DROP SEQUENCE IF EXISTS seq_imr`);
}
