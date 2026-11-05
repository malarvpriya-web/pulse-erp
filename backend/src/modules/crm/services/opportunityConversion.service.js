// backend/src/modules/crm/services/opportunityConversion.service.js
// Opportunity -> Project conversion, used by the manual
// POST /opportunities/:id/convert-to-project route and by the stage-update
// route when an opportunity reaches 'won' (crm.routes.js).
//
// A thin wrapper over the one project creator, ensureProject()
// (projects/services/projectCreation.service.js), which owns the rules: the
// opportunity must be Won, the project is created in the opportunity's
// company, an existing project for the opportunity (including one a sales
// order already created) is reused with its lifecycle, and a failure anywhere
// — the lifecycle included — throws so the caller rolls everything back. The
// lifecycle used to be best-effort here, which committed projects that the
// Operations tracker never saw.

import { ensureProject, ProjectSetupError } from '../../projects/services/projectCreation.service.js';

/**
 * @param {import('pg').PoolClient} client - must be inside an open transaction
 * @param {number} opportunityId
 * @param {number|null} companyId - the caller's company; null for a global caller
 * @param {{ userId?: number|null, employeeId?: number|null, userEmail?: string|null, userName?: string|null }} actor
 * @returns {Promise<{ project: object, already_existed: boolean } | null>} null if the opportunity doesn't
 *   exist in the caller's company. Throws ProjectSetupError (422 OPPORTUNITY_NOT_WON) when it is not Won.
 */
export async function convertOpportunityToProject(client, opportunityId, companyId, actor = {}) {
  try {
    const { project, projectCreated } = await ensureProject(client, {
      opportunityId,
      scopeCompanyId: companyId,
      actor: { userId: actor.userId ?? null, employeeId: actor.employeeId ?? null, name: actor.userName ?? null },
    });
    return { project, already_existed: !projectCreated };
  } catch (e) {
    if (e instanceof ProjectSetupError && e.code === 'OPPORTUNITY_NOT_FOUND') return null;
    throw e;
  }
}
