/**
 * leads / opportunities / accounts `.assigned_to` — one id space, enforced.
 *
 * §132 left this open: `opportunities.assigned_to` carried no foreign key and
 * had been written from BOTH id spaces. Every reader in the codebase already
 * agrees it is an `employees.id`:
 *
 *   crm/repositories/opportunities.repository.js  LEFT JOIN employees e ON e.id = o.assigned_to   (x3)
 *   crm/repositories/leads.repository.js          LEFT JOIN employees e ON l.assigned_to = e.id   (x3)
 *   crm/services/leadAssignment.service.js        WHERE l.assigned_to = e.id / o.assigned_to = e.id
 *   sales/routes/sales-command-center.routes.js   LEFT JOIN employees e_opp ON e_opp.id = opp.assigned_to
 *   sales/routes/sales.routes.js                  LEFT JOIN opportunities o ON o.assigned_to = e.id
 *
 * and every writer already resolves one:
 *
 *   crm.routes.js:1551  "assigned_to FKs employees, not users — see the same fix in POST /leads."
 *                       finalAssignedTo = autoAssignedId (resolveAutoAssignee → employees.id)
 *                                      || req.user.employee_id
 *
 * The comment was true; the constraint was missing. One row disagreed —
 * `opportunities.assigned_to = 848`, a `users.id` (superadmin@manifest.in),
 * written before that fix landed. It cannot be re-keyed: that user has no
 * `employees` row at all, so there is no employee the deal could be handed to.
 * It surfaced as a lone "848" in Sales Intelligence's "Win Rate by Salesperson"
 * — a raw id rendered as a person's name, on a soft-deleted opportunity.
 *
 * Unmappable values drop to NULL (the precedent from
 * 20260827000001_sales_events_actor_ids_to_integer), values that ARE a users.id
 * with a real employee link are re-keyed to that employee rather than discarded.
 * `accounts.assigned_to` is included because resolveCustomer() writes it from
 * the same `finalAssignedTo` variable — it is empty today, so the FK is purely
 * preventive there.
 *
 * NOT fixed here, deliberately: `opportunities.held_by` already FKs employees
 * and means the same thing as `assigned_to`. Collapsing the two is a data-model
 * decision, not a constraint fix.
 */

const TABLES = ['leads', 'opportunities', 'accounts'];

export async function up(knex) {
  for (const table of TABLES) {
    // Re-key the values that are a users.id belonging to someone who DOES have
    // an employees row. Ordered before the NULL sweep so a recoverable row is
    // never discarded by it.
    const rekeyed = await knex.raw(
      `UPDATE ${table} t
          SET assigned_to = u.employee_id
         FROM users u
        WHERE t.assigned_to IS NOT NULL
          AND u.id = t.assigned_to
          AND u.employee_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = t.assigned_to)`
    );

    // Whatever is left pointing at no employee cannot be honoured by the FK and
    // has no owner to recover.
    const cleared = await knex.raw(
      `UPDATE ${table} t
          SET assigned_to = NULL
        WHERE t.assigned_to IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = t.assigned_to)`
    );

    console.log(
      `[${table}.assigned_to] re-keyed ${rekeyed.rowCount ?? 0} users.id → employees.id, ` +
      `cleared ${cleared.rowCount ?? 0} unmappable`
    );

    await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_assigned_to_fkey;`);
    await knex.raw(`
      ALTER TABLE ${table}
        ADD CONSTRAINT ${table}_assigned_to_fkey
        FOREIGN KEY (assigned_to) REFERENCES employees(id) ON DELETE SET NULL;
    `);
    // Every "my pipeline" and per-owner rollup filters on this column.
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_${table}_assigned_to ON ${table}(assigned_to);`
    );
  }
}

export async function down(knex) {
  for (const table of TABLES) {
    await knex.raw(`DROP INDEX IF EXISTS idx_${table}_assigned_to;`);
    await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_assigned_to_fkey;`);
  }
}
