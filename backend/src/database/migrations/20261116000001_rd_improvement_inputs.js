/**
 * 20261116000001_rd_improvement_inputs.js — win/loss evidence + R&D inputs (§277).
 *
 * Owner request 2026-11-16: after a bid is decided, win OR lose, the salesperson
 * records why, uploads a file, and lists the requirements R&D should work on.
 * After commissioning, the service engineer adds R&D points too.
 *
 * 1. opportunities: close_remarks (what happened, in words), close_file_url /
 *    close_file_name (the evidence — PO, LOA, regret letter, comparison sheet),
 *    closed_by (users.id). The existing close_reason / lost_reason / competitor
 *    stay as they were.
 *
 * 2. rd_improvement_inputs: ONE register of improvement inputs for R&D, whatever
 *    raised them.
 *      source       sales_won | sales_lost | commissioning | service
 *      opportunity_id / commissioning_id   the record it came from (SET NULL on delete)
 *      category     product_feature | performance | quality | cost | documentation
 *                   | installation | software | other
 *      requirement  the point itself (required)
 *      priority     low | medium | high
 *      status       new → under_review → accepted | rejected → implemented
 *      rd_response  what R&D decided and why; reviewed_by / reviewed_at
 *
 * 3. Permission: R&D review (status + response) is rd:edit. Roles that raise
 *    inputs already hold crm:edit (sales) or servicedesk:edit (service); no new
 *    module. sales_manager / service_manager get rd:view so they can read the
 *    register they feed — nothing else changes in the matrix.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export const VIEW_GRANTS = ['sales_manager', 'service_manager'];

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS close_remarks   TEXT,
      ADD COLUMN IF NOT EXISTS close_file_url  TEXT,
      ADD COLUMN IF NOT EXISTS close_file_name VARCHAR(255),
      ADD COLUMN IF NOT EXISTS closed_by       INTEGER`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rd_improvement_inputs (
      id               SERIAL PRIMARY KEY,
      company_id       INTEGER,
      source           VARCHAR(20)  NOT NULL,
      opportunity_id   INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
      commissioning_id INTEGER REFERENCES commissioning_workflows(id) ON DELETE SET NULL,
      customer_name    VARCHAR(255),
      product_line     VARCHAR(255),
      category         VARCHAR(30)  NOT NULL DEFAULT 'other',
      requirement      TEXT         NOT NULL,
      priority         VARCHAR(10)  NOT NULL DEFAULT 'medium',
      status           VARCHAR(20)  NOT NULL DEFAULT 'new',
      rd_response      TEXT,
      reviewed_by      INTEGER,
      reviewed_by_name VARCHAR(255),
      reviewed_at      TIMESTAMPTZ,
      raised_by        INTEGER,
      raised_by_name   VARCHAR(255),
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
      deleted_at       TIMESTAMPTZ,
      CONSTRAINT rd_inputs_source_known   CHECK (source IN ('sales_won', 'sales_lost', 'commissioning', 'service')),
      CONSTRAINT rd_inputs_category_known CHECK (category IN ('product_feature', 'performance', 'quality', 'cost',
                                                              'documentation', 'installation', 'software', 'other')),
      CONSTRAINT rd_inputs_priority_known CHECK (priority IN ('low', 'medium', 'high')),
      CONSTRAINT rd_inputs_status_known   CHECK (status IN ('new', 'under_review', 'accepted', 'rejected', 'implemented')),
      CONSTRAINT rd_inputs_requirement_nonblank CHECK (length(btrim(requirement)) > 0),
      CONSTRAINT rd_inputs_sales_has_opportunity
        CHECK (source NOT IN ('sales_won', 'sales_lost') OR opportunity_id IS NOT NULL) NOT VALID,
      CONSTRAINT rd_inputs_commissioning_has_workflow
        CHECK (source <> 'commissioning' OR commissioning_id IS NOT NULL) NOT VALID
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS rd_inputs_company_status ON rd_improvement_inputs (company_id, status) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS rd_inputs_opportunity ON rd_improvement_inputs (opportunity_id) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS rd_inputs_commissioning ON rd_improvement_inputs (commissioning_id) WHERE deleted_at IS NULL`);

  const { rows: roles } = await knex.raw(`SELECT id FROM roles WHERE LOWER(code) = ANY($1)`, [VIEW_GRANTS]);
  for (const role of roles) {
    await knex.raw(
      `INSERT INTO role_permissions (role_id, module, can_view)
       VALUES ($1, 'rd', true)
       ON CONFLICT (role_id, module) DO UPDATE SET can_view = true`,
      [role.id],
    );
  }
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS rd_improvement_inputs`);
  await knex.raw(`
    ALTER TABLE opportunities
      DROP COLUMN IF EXISTS close_remarks,
      DROP COLUMN IF EXISTS close_file_url,
      DROP COLUMN IF EXISTS close_file_name,
      DROP COLUMN IF EXISTS closed_by`);
}
