/**
 * 20260717000005_lead_activities.js
 *
 * Creates `lead_activities` — a table three separate code paths have queried
 * since they were written, and which has never existed.
 *
 * WHAT THIS FIXES (P0) — `POST /crm/leads/:id/convert` writes conversion history
 * into lead_activities inside its transaction, unguarded, before COMMIT. With the
 * table absent that INSERT threw 42P01, the catch rolled the whole transaction
 * back, and the caller got a 500. **Every lead-to-opportunity conversion has
 * failed for the lifetime of the feature.** Verified against the live database:
 * 0 leads have status 'converted'; the 6 opportunities carrying a lead_id were
 * seeded, not converted. The IEM -> IPM funnel is modelled correctly in the
 * schema (opportunities.lead_id) and was dead at runtime.
 *
 * Also dead for the same reason: GET and POST /crm/leads/:id/activities, and
 * leadsRepository.getActivities/addActivity. Same shape of bug as the phantom
 * `project_resources` and `rd_projects` tables.
 *
 * COLUMNS are derived from what the existing callers already pass/select:
 *   addActivity  -> (lead_id, activity_type, activity_date, notes,
 *                    next_followup_date, created_by)
 *   getActivities-> la.*, JOIN employees e ON la.created_by = e.id,
 *                   WHERE la.deleted_at IS NULL ORDER BY la.activity_date DESC
 *   convert      -> (lead_id, 'conversion', NOW(), notes, created_by)
 *
 * created_by REFERENCES employees, not users — matching what getActivities
 * already joins, and leads.owner_id's existing FK. The callers were passing
 * `req.user.userId` (a users.id) into a column read as an employees.id: exactly
 * the stock_ledger.created_by bug that 500'd every stock write. The routes are
 * fixed to pass `req.user?.employee_id ?? null` in the same change. The column is
 * NULLABLE and ON DELETE SET NULL because legacy demo logins have no linked
 * employee — a conversion must not fail just because the actor isn't an employee.
 *
 * company_id is populated by derivation from the parent lead rather than passed
 * in by the caller, so it can never be NULL. NULL company_id is the documented
 * invisible-row trap in this codebase.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS lead_activities (
      id                 SERIAL PRIMARY KEY,
      lead_id            INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      company_id         INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      activity_type      VARCHAR(40) NOT NULL DEFAULT 'note',
      activity_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes              TEXT,
      next_followup_date DATE,
      created_by         INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW(),
      deleted_at         TIMESTAMPTZ
    )
  `);

  // The read is always "activities for one lead, newest first, not deleted".
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_lead
      ON lead_activities (lead_id, activity_date DESC) WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_company
      ON lead_activities (company_id) WHERE deleted_at IS NULL
  `);
  // Feeds the "next follow-up" reads without scanning history.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_lead_activities_followup
      ON lead_activities (next_followup_date)
      WHERE next_followup_date IS NOT NULL AND deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS lead_activities`);
}
