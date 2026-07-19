/**
 * Retire `status_values` — the Status Setup registry that nothing ever read.
 *
 * Status Setup shipped as a full CRUD screen (StatusSetup.jsx + four
 * /admin/status-setup routes) over a `status_values` table seeded with 37 rows
 * by defaultSeed.js. An audit on 2026-07-16 found it had ZERO readers: no
 * module, service or query ever selected from the table. Every module instead
 * hardcodes its own list — Leads.jsx:17, Projects.jsx:40, ProjectPipelineBoard,
 * ProductionDeliveryTracker, complaintsConstants.js and ~20 others. Admins
 * could edit the screen all day and nothing anywhere changed.
 *
 * The seeded values had already drifted from the code they nominally described:
 * status_values held crm = new/contacted/qualified/won/lost, while Leads.jsx
 * actually renders New/Contacted/Qualified/Unqualified/Converted — different
 * casing AND different members. That drift is the proof it was never a source.
 *
 * Retiring rather than wiring it up: these statuses drive logic, not just
 * labels — workflow transitions, badge colour maps and filter predicates all
 * branch on the exact string. Making them admin-editable would mean an admin
 * renaming 'won' to 'Won' silently breaks CRM queries. A config screen with no
 * effect is safer deleted than made real.
 *
 * Data loss: none. The live table held exactly 37 rows against a 37-row seed
 * list, so no operator had ever added a custom value through the screen in its
 * entire lifetime.
 *
 * Companion changes: StatusSetup.jsx deleted; /admin/status-setup CRUD removed;
 * defaultSeed.js status_values group removed; routes.jsx / moduleRegistry.js /
 * SettingsCenter.jsx entries removed; test manifests updated.
 */
export async function up(knex) {
  await knex.raw(`DROP TABLE IF EXISTS status_values`);
}

/**
 * Recreates the table and its seed so a rollback restores the pre-drop state
 * byte-for-byte. It is still dead on arrival — nothing reads it — but `down`
 * exists to reverse `up`, not to re-litigate the decision.
 */
export async function down(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS status_values (
      id          SERIAL       PRIMARY KEY,
      table_name  VARCHAR(100) NOT NULL,
      field_name  VARCHAR(100) NOT NULL,
      field_value VARCHAR(200) NOT NULL,
      is_active   BOOLEAN      DEFAULT TRUE,
      created_at  TIMESTAMPTZ  DEFAULT NOW()
    )
  `);

  const seed = [
    ['employees', 'active'], ['employees', 'probation'], ['employees', 'notice'],
    ['employees', 'resigned'], ['employees', 'terminated'],
    ['leaves', 'pending'], ['leaves', 'approved'], ['leaves', 'rejected'],
    ['leaves', 'cancelled'],
    ['recruitment', 'applied'], ['recruitment', 'screening'],
    ['recruitment', 'interview'], ['recruitment', 'offer'],
    ['recruitment', 'hired'], ['recruitment', 'rejected'],
    ['approvals', 'pending'], ['approvals', 'approved'], ['approvals', 'rejected'],
    ['crm', 'new'], ['crm', 'contacted'], ['crm', 'qualified'], ['crm', 'won'],
    ['crm', 'lost'],
    ['complaints', 'open'], ['complaints', 'in_progress'],
    ['complaints', 'resolved'], ['complaints', 'closed'],
    ['invoices', 'draft'], ['invoices', 'sent'], ['invoices', 'paid'],
    ['invoices', 'overdue'], ['invoices', 'cancelled'],
    ['projects', 'planning'], ['projects', 'active'], ['projects', 'on_hold'],
    ['projects', 'completed'], ['projects', 'cancelled'],
  ];

  for (const [table_name, field_value] of seed) {
    await knex.raw(
      `INSERT INTO status_values (table_name, field_name, field_value)
       VALUES ($1, 'status', $2)`,
      [table_name, field_value]
    );
  }
}
