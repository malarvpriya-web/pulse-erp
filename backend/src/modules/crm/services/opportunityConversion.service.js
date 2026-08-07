// backend/src/modules/crm/services/opportunityConversion.service.js
// Opportunity -> Project conversion, extracted from the manual
// POST /opportunities/:id/convert-to-project route (crm.routes.js) so the
// stage-update route can auto-fire it when an opportunity reaches 'won'
// instead of depending on someone clicking "Convert to Project" by hand.
// Automation Opportunity Audit §13.3.

import { nextProjectCode, nextLifecycleNumber } from '../../../shared/docNumber.js';

/**
 * Creates a projects row (and a best-effort lifecycle_instances row) from a
 * won opportunity. Idempotent — a second call for the same opportunity_id
 * returns the existing project instead of creating a duplicate, which is
 * also what makes it safe to call automatically alongside the pre-existing
 * Sales Order -> Project bootstrap (sales.routes.js) without risking two
 * projects for the same opportunity.
 *
 * @param {import('pg').PoolClient} client - must be inside an open transaction
 * @param {number} opportunityId
 * @param {number|null} companyId
 * @param {{ userId?: number|null, employeeId?: number|null, userEmail?: string|null, userName?: string|null }} actor
 * @returns {Promise<{ project: object, already_existed: boolean } | null>} null if the opportunity doesn't exist
 */
export async function convertOpportunityToProject(client, opportunityId, companyId, actor = {}) {
  const oppRes = await client.query(
    `SELECT o.*, COALESCE(a.name, a.account_name) AS customer_name
     FROM opportunities o
     LEFT JOIN accounts a ON a.id = o.account_id
     WHERE o.id=$1 AND o.deleted_at IS NULL AND ($2::int IS NULL OR o.company_id=$2)
     FOR UPDATE OF o`,
    [opportunityId, companyId]
  );
  const opp = oppRes.rows[0];
  if (!opp) return null;

  const existingRes = await client.query(
    `SELECT * FROM projects WHERE opportunity_id=$1 AND deleted_at IS NULL LIMIT 1`,
    [opp.id]
  );
  if (existingRes.rows[0]) {
    return { project: existingRes.rows[0], already_existed: true };
  }

  // projects.created_by FKs employees(id), not users(id) — resolve like
  // projects.routes.js's actingEmployeeId does.
  let createdByEmployeeId = actor.employeeId ?? null;
  if (createdByEmployeeId == null && actor.userEmail) {
    const empRes = await client.query(
      `SELECT id FROM employees WHERE company_email=$1 AND deleted_at IS NULL LIMIT 1`,
      [actor.userEmail]
    );
    createdByEmployeeId = empRes.rows[0]?.id ?? null;
  }

  const projectCode = await nextProjectCode(client);
  const { rows: pRows } = await client.query(
    `INSERT INTO projects
       (project_code, project_name, customer_name, start_date, status, budget_amount,
        description, created_by, company_id, opportunity_id)
     VALUES ($1,$2,$3,CURRENT_DATE,'planning',$4,$5,$6,$7,$8) RETURNING *`,
    [projectCode, opp.opportunity_name, opp.customer_name || null, opp.expected_value || 0,
     `Converted from opportunity ${opp.opportunity_number || opp.id}`,
     createdByEmployeeId, companyId, opp.id]
  );
  const project = pRows[0];

  const lifecycleNumber = await nextLifecycleNumber(client);
  await client.query(
    `INSERT INTO lifecycle_instances
      (lifecycle_number, project_id, customer_id, current_stage, status, stage_notes, created_by, created_by_name, company_id)
     VALUES ($1,$2,$3,'order','active',$4,$5,$6,$7)`,
    [lifecycleNumber, project.id, opp.account_id || null,
     `Created from opportunity: ${opp.opportunity_name}`, actor.userId ?? null, actor.userName ?? null, companyId]
  ).catch(() => {}); // best-effort — Operations tracking is secondary to the project record itself

  return { project, already_existed: false };
}
