/**
 * 20260904000003_unified_activity_timeline.js
 *
 * One chronological timeline across the seven activity tables, and the
 * polymorphic links that let a NEW activity attach to anything.
 *
 * WHY
 * ---
 * The CRM parity audit (§153) found seven disjoint activity tables —
 * `crm_activities`, `lead_activities`, `tasks`, `meetings`, `sales_events`,
 * `customer_visits`, `marketing_tasks` — each with its own shape and its own
 * idea of what an activity links to. `crm_activities`, the closest thing to a
 * canonical model, linked only lead / opportunity / account / contact. There was
 * no way to answer "what has happened on this customer", because a quotation, an
 * order, a service case and a project each recorded their history somewhere
 * else, and nothing joined them.
 *
 * WHY A VIEW AND NOT A DATA MIGRATION
 * -----------------------------------
 * Collapsing seven live tables into one would mean rewriting every writer in the
 * codebase and moving production rows, in a single change, with no way to verify
 * the result short of re-testing every module that logs anything. That is the
 * riskiest possible shape for this repair.
 *
 * Instead the unification happens on the READ side. `v_activity_timeline` maps
 * all seven onto one column contract; every existing writer is untouched and
 * cannot break. New activities gain the missing links through columns added to
 * `crm_activities`, so the model grows toward the canonical shape rather than
 * being swapped for it. A later pass can migrate writers table by table, with
 * the view proving at each step that the timeline still reconciles.
 *
 * WHAT THE VIEW DELIBERATELY DOES NOT DO
 * --------------------------------------
 * It does not deduplicate. If a customer visit was also logged as a
 * `crm_activities` row, both appear, each labelled with its `source`. Guessing
 * that two rows in different tables are "the same event" is exactly the kind of
 * inference that turns a timeline into fiction; showing both, attributed, is
 * honest and lets a human decide.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // ── polymorphic links for NEW activities ──────────────────────────────────
  for (const col of ['quotation_id', 'sales_order_id', 'ticket_id', 'project_id', 'campaign_id']) {
    await knex.raw(`ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS ${col} INTEGER`);
  }
  // No foreign keys on purpose: an activity must survive the deletion of the
  // record it describes, or the audit history disappears with the thing it was
  // evidence about. Indexed for the lookups the timeline actually performs.
  for (const col of ['quotation_id', 'sales_order_id', 'ticket_id', 'project_id', 'campaign_id']) {
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_crm_activities_${col}
        ON crm_activities (${col}) WHERE ${col} IS NOT NULL
    `);
  }
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_crm_activities_timeline
      ON crm_activities (company_id, activity_date DESC)
     WHERE deleted_at IS NULL
  `);

  // ── the unified read model ────────────────────────────────────────────────
  //
  // Column contract, identical across every branch:
  //   source            which table the row came from — never hidden from the caller
  //   source_id         its id in that table, as TEXT. marketing_tasks and
  //                     sales_events use uuid primary keys while the other five
  //                     use integers, so there is no numeric common type; the
  //                     caller pairs (source, source_id) and never does
  //                     arithmetic on it.
  //   activity_type     normalised verb (call / email / meeting / task / visit / note)
  //   subject / body    what happened
  //   occurred_at       the single timestamp the timeline sorts on
  //   actor_employee_id who did it, where the source records it
  //   status
  //   *_id              every entity this activity can be attached to
  //
  // occurred_at is COALESCEd down to created_at in every branch: a row whose own
  // date column is NULL must still appear on the timeline, at the moment it was
  // recorded, rather than vanishing from it.
  await knex.raw(`DROP VIEW IF EXISTS v_activity_timeline`);
  await knex.raw(`
    CREATE VIEW v_activity_timeline AS

      SELECT 'crm_activity'::text                       AS source,
             a.id::text                                 AS source_id,
             a.company_id,
             LOWER(COALESCE(a.activity_type, 'note'))    AS activity_type,
             a.subject                                  AS subject,
             a.description                              AS body,
             COALESCE(a.activity_date, a.created_at)    AS occurred_at,
             a.performed_by                             AS actor_employee_id,
             a.status,
             a.lead_id, a.opportunity_id, a.account_id, a.contact_id,
             a.project_id, a.campaign_id, a.ticket_id,
             a.quotation_id, a.sales_order_id
        FROM crm_activities a
       WHERE a.deleted_at IS NULL

      UNION ALL

      SELECT 'lead_activity', la.id::text, la.company_id,
             LOWER(COALESCE(la.activity_type, 'note')),
             NULL::varchar, la.notes,
             COALESCE(la.activity_date, la.created_at),
             la.created_by, NULL::varchar,
             la.lead_id, NULL::int, NULL::int, NULL::int,
             NULL::int, NULL::int, NULL::int, NULL::int, NULL::int
        FROM lead_activities la
       WHERE la.deleted_at IS NULL

      UNION ALL

      -- tasks carries no company_id of its own; it inherits the project's.
      SELECT 'project_task', t.id::text, p.company_id,
             'task', t.task_title, t.task_description,
             COALESCE(t.due_date::timestamptz, t.created_at::timestamptz),
             t.assigned_to, t.status,
             NULL::int, NULL::int, NULL::int, NULL::int,
             t.project_id, NULL::int, NULL::int, NULL::int, NULL::int
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.deleted_at IS NULL

      UNION ALL

      SELECT 'meeting', m.id::text, m.company_id,
             'meeting', m.title, m.notes,
             COALESCE(m.meeting_date::timestamptz, m.created_at),
             m.organiser_employee_id, m.status,
             NULL::int, NULL::int, NULL::int, NULL::int,
             NULL::int, NULL::int, NULL::int, NULL::int, NULL::int
        FROM meetings m
       WHERE m.deleted_at IS NULL

      UNION ALL

      -- sales_events.owner_id keys users, not employees. Resolved through
      -- users.employee_id so the actor column means the same thing in every
      -- branch; joining it straight into actor_employee_id would silently name
      -- a different person.
      SELECT 'sales_event', se.id::text, se.company_id,
             LOWER(COALESCE(se.type, 'event')), se.title, se.notes,
             COALESCE(se.start_at, se.created_at),
             u.employee_id, NULL::varchar,
             NULL::int, se.opportunity_id, se.account_id, NULL::int,
             NULL::int, NULL::int, NULL::int, NULL::int, NULL::int
        FROM sales_events se
        LEFT JOIN users u ON u.id = se.owner_id

      UNION ALL

      SELECT 'customer_visit', cv.id::text, cv.company_id,
             LOWER(COALESCE(cv.visit_type, 'visit')), cv.purpose,
             COALESCE(cv.discussion_notes, cv.visit_report),
             COALESCE(cv.visit_date::timestamptz, cv.created_at),
             cv.visited_by, cv.status,
             NULL::int, cv.opportunity_id, cv.customer_id, NULL::int,
             cv.project_id, NULL::int, NULL::int, NULL::int, NULL::int
        FROM customer_visits cv

      UNION ALL

      SELECT 'marketing_task', mt.id::text, mt.company_id,
             'task', mt.title, mt.description,
             COALESCE(mt.due_date::timestamptz, mt.created_at),
             mt.assigned_to, mt.status,
             NULL::int, NULL::int, NULL::int, NULL::int,
             NULL::int, mt.campaign_id, NULL::int, NULL::int, NULL::int
        FROM marketing_tasks mt
  `);

  const { rows } = await knex.raw(
    `SELECT source, COUNT(*)::int AS n FROM v_activity_timeline GROUP BY source ORDER BY source`
  );
  console.log('[unified_activity_timeline] ' + rows.map(r => `${r.source}=${r.n}`).join(' '));
}

export async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS v_activity_timeline`);
  await knex.raw(`DROP INDEX IF EXISTS idx_crm_activities_timeline`);
  for (const col of ['quotation_id', 'sales_order_id', 'ticket_id', 'project_id', 'campaign_id']) {
    await knex.raw(`DROP INDEX IF EXISTS idx_crm_activities_${col}`);
    await knex.raw(`ALTER TABLE crm_activities DROP COLUMN IF EXISTS ${col}`);
  }
}
