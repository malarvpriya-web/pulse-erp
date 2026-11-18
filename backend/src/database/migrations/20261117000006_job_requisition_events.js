/**
 * 20261117000006_job_requisition_events.js — the job's timeline (Jobs page, 2026-11-17).
 *
 * One row per step in a job's life, from the request to the last hire:
 * raised, edited, submitted, withdrawn, approved, sent back (with the
 * approver's comment), cancelled, job posted / saved as draft / published /
 * paused / reopened / closed / deleted, requisition closed. Written by the
 * routes at the moment each step happens (recordJobEvent in
 * recruitment.repository.js). Applications and hires are read live from the
 * candidate tables, so they are not copied here.
 *
 * audit_logs could not serve: reference_id is shared across record types (a
 * careers portal and a requisition both appear as "910"), and the generic
 * request logger stores raw request bodies, not the step that happened.
 *
 * Backfill for existing jobs: raised (created_at), every decision in
 * `approvals`, and the opening's creation.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`CREATE TABLE IF NOT EXISTS job_requisition_events (
    id              serial PRIMARY KEY,
    company_id      integer REFERENCES companies(id) ON DELETE CASCADE,
    requisition_id  integer NOT NULL REFERENCES job_requisitions(id) ON DELETE CASCADE,
    job_opening_id  integer REFERENCES job_openings(id) ON DELETE SET NULL,
    event           varchar(30) NOT NULL,
    from_status     varchar(30),
    to_status       varchar(30),
    comment         text,
    actor_user_id   integer,
    created_at      timestamptz NOT NULL DEFAULT now()
  )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS job_requisition_events_req_idx
                    ON job_requisition_events (requisition_id, created_at)`);

  // Backfill — only for requisitions that have no events yet, so a re-run adds nothing.
  await knex.raw(`
    INSERT INTO job_requisition_events (company_id, requisition_id, event, to_status, created_at)
    SELECT jr.company_id, jr.id, 'raised', 'draft', jr.created_at
      FROM job_requisitions jr
     WHERE NOT EXISTS (SELECT 1 FROM job_requisition_events e WHERE e.requisition_id = jr.id)`);
  await knex.raw(`
    INSERT INTO job_requisition_events (company_id, requisition_id, event, from_status, to_status, comment, actor_user_id, created_at)
    SELECT jr.company_id, jr.id,
           CASE WHEN a.status = 'Approved' THEN 'approved' ELSE 'sent_back' END,
           'pending_approval',
           CASE WHEN a.status = 'Approved' THEN 'approved' ELSE 'draft' END,
           a.comments, a.approver_id, COALESCE(a.decision_date, a.created_at)
      FROM approvals a
      JOIN job_requisitions jr ON jr.id = a.reference_id
     WHERE a.module_name = 'requisition' AND a.status IN ('Approved', 'Rejected')
       AND NOT EXISTS (SELECT 1 FROM job_requisition_events e
                        WHERE e.requisition_id = jr.id AND e.event IN ('approved', 'sent_back'))`);
  await knex.raw(`
    INSERT INTO job_requisition_events (company_id, requisition_id, job_opening_id, event, to_status, created_at)
    SELECT jo.company_id, jo.requisition_id, jo.id, 'job_posted', jo.status, jo.created_at
      FROM job_openings jo
     WHERE jo.requisition_id IS NOT NULL AND jo.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM job_requisition_events e
                        WHERE e.requisition_id = jo.requisition_id AND e.event = 'job_posted')`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS job_requisition_events`);
}
