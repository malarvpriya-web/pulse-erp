/**
 * Installation as a First-Class Module (Priority 6).
 *
 * Was only a checklist *category* inside Commissioning (4 checkbox items —
 * "Earthing verified", "Cables torqued", etc.) with no separate table,
 * status, engineer assignment, travel plan, or customer acceptance of its
 * own. This gives it a real lifecycle:
 *   Dispatch -> Installation Request -> Engineer Assignment -> Travel
 *   Planning -> Installation -> Commissioning -> Customer Acceptance
 *
 * Deliberately links to (not duplicates) existing systems: travel_requests
 * for the Travel Planning step (a real row gets created there, not a
 * bespoke travel field here), commissioning_workflows for the handoff at
 * completion, and sales_orders/projects for the Dispatch origin.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS installation_requests (
      id                          SERIAL        PRIMARY KEY,
      company_id                  INTEGER,
      installation_number         VARCHAR(30),
      sales_order_id              INTEGER REFERENCES sales_orders(id) ON DELETE SET NULL,
      project_id                  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
      equipment_id                INTEGER REFERENCES customer_equipment(id) ON DELETE SET NULL,
      customer_name                VARCHAR(255),
      site_address                 TEXT,
      status                       VARCHAR(30) NOT NULL DEFAULT 'requested',
      requested_date               DATE DEFAULT CURRENT_DATE,
      engineer_id                  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      engineer_assigned_at         TIMESTAMPTZ,
      travel_request_id            INTEGER REFERENCES travel_requests(id) ON DELETE SET NULL,
      scheduled_date                DATE,
      actual_start_at               TIMESTAMPTZ,
      actual_end_at                 TIMESTAMPTZ,
      completion_notes              TEXT,
      commissioning_workflow_id     INTEGER REFERENCES commissioning_workflows(id) ON DELETE SET NULL,
      customer_accepted             BOOLEAN DEFAULT false,
      customer_accepted_by          VARCHAR(255),
      customer_accepted_at          TIMESTAMPTZ,
      customer_acceptance_notes     TEXT,
      notes                         TEXT,
      created_by                    INTEGER,
      created_at                    TIMESTAMPTZ DEFAULT NOW(),
      updated_at                    TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT chk_installation_requests_status CHECK (status IN (
        'requested','engineer_assigned','travel_planned','in_progress','completed','cancelled'
      ))
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_installation_requests_status  ON installation_requests(status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_installation_requests_project ON installation_requests(project_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_installation_requests_so      ON installation_requests(sales_order_id)`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_installation_requests_so_active
                   ON installation_requests(sales_order_id) WHERE status NOT IN ('cancelled')`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS installation_requests CASCADE`);
}
