/**
 * Lead/opportunity auto-assignment — Automation Opportunity Audit §2.1.
 *
 * A real, configurable assignment system already existed (crm_settings.auto_assign_owner
 * + lead_assignment_method, crm_assignment_rules table), wired only into POST /leads.
 * Three concrete bugs found while closing this gap:
 *   1. CRMSettings.jsx's "Load Balanced" dropdown option did nothing — crm.routes.js
 *      only ever checked `=== 'round_robin'`, so picking it silently fell through to
 *      self-assign-to-creator.
 *   2. "Round Robin" didn't rotate at all — it only ran crm_assignment_rules (a static
 *      condition_field=condition_value -> named-employee table), with no actual rotation
 *      when no rule matched.
 *   3. Bulk CSV lead import and both opportunity-create paths never ran any of this —
 *      always self-assign-to-creator or inherit-from-lead.
 *
 * This module is the single resolver all four call sites now share. crm_assignment_rules
 * is kept as the highest-priority path regardless of method — a company that configured
 * explicit named-employee rules expects them honored whichever rotation method they also
 * picked. Below that, 'round_robin' and 'load_balanced' are now genuinely different:
 * round-robin picks whoever was assigned longest ago (stateless — no cursor table needed,
 * derived from MAX(created_at) of their existing assignments), load-balanced picks whoever
 * currently holds the fewest open leads+opportunities.
 *
 * Eligible pool = employees linked to an active user holding sales_exec or sales_manager
 * (via user_roles/roles — the many-to-many join, not the legacy flat users.role column).
 */

import pool from '../../shared/db.js';
import { resolveTerritoryAssignment } from './territoryAssignment.service.js';

const ELIGIBLE_ROLES = ['sales_exec', 'sales_manager'];

async function getEligiblePool(companyId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT e.id
       FROM employees e
       JOIN users u ON u.employee_id = e.id
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE u.is_active = true
        AND LOWER(COALESCE(e.status, 'active')) IN ('active', 'probation')
        AND LOWER(r.code) = ANY($1)
        AND (u.company_id = $2 OR u.company_id IS NULL)`,
    [ELIGIBLE_ROLES, companyId]
  );
  return rows.map((r) => r.id);
}

// Pre-existing feature, unchanged in behavior — same query crm.routes.js already ran.
async function ruleBasedAssignee(companyId, payload) {
  const { rows } = await pool.query(
    `SELECT * FROM crm_assignment_rules
      WHERE company_id = $1 AND is_active = true ORDER BY priority ASC`,
    [companyId]
  );
  for (const rule of rows) {
    const fieldVal = (payload[rule.condition_field] || '').toString().toLowerCase();
    if (fieldVal === (rule.condition_value || '').toLowerCase()) {
      const emp = await pool.query(
        `SELECT id FROM employees WHERE LOWER(name) = LOWER($1) AND company_id = $2
           AND LOWER(status) IN ('active','probation') LIMIT 1`,
        [rule.assign_to_name, companyId]
      );
      if (emp.rowCount > 0) return emp.rows[0].id;
    }
  }
  return null;
}

async function loadBalancedAssignee(eligibleIds) {
  const { rows } = await pool.query(
    `SELECT e.id,
            (SELECT COUNT(*) FROM leads l
              WHERE l.assigned_to = e.id AND l.deleted_at IS NULL
                AND LOWER(l.status) NOT IN ('converted', 'lost'))
          + (SELECT COUNT(*) FROM opportunities o
              WHERE o.assigned_to = e.id AND o.deleted_at IS NULL
                AND LOWER(o.stage) NOT IN ('won', 'lost')) AS open_count
       FROM employees e
      WHERE e.id = ANY($1)
      ORDER BY open_count ASC, e.id ASC
      LIMIT 1`,
    [eligibleIds]
  );
  return rows[0]?.id || null;
}

async function roundRobinAssignee(eligibleIds) {
  const { rows } = await pool.query(
    `SELECT e.id,
            GREATEST(
              COALESCE((SELECT MAX(l.created_at) FROM leads l WHERE l.assigned_to = e.id), 'epoch'::timestamptz),
              COALESCE((SELECT MAX(o.created_at) FROM opportunities o WHERE o.assigned_to = e.id), 'epoch'::timestamptz)
            ) AS last_assigned
       FROM employees e
      WHERE e.id = ANY($1)
      ORDER BY last_assigned ASC, e.id ASC
      LIMIT 1`,
    [eligibleIds]
  );
  return rows[0]?.id || null;
}

/**
 * Resolve an owner AND the territory the record falls in.
 *
 * Order of precedence, most deliberate first:
 *   1. crm_assignment_rules — explicit named-employee rules someone configured.
 *   2. TERRITORY — sales_territories matched on zone/city/state/industry.
 *      Added 2026-09-03: territories existed as a CRUD screen whose table no
 *      assignment path had ever read, so "territory" influenced nothing.
 *   3. round_robin / load_balanced rotation over the eligible sales pool.
 *
 * Territory sits ABOVE rotation because a territory is a standing statement
 * about who covers a region; rotation is what you fall back to when nobody has
 * said. It sits BELOW crm_assignment_rules because those name a person outright.
 *
 * The territory is returned even when it has no owner, so the record is still
 * STAMPED with where it landed — territory performance reporting needs the
 * stamp regardless of whether the territory was staffed at the time.
 *
 * @param {number|null} companyId
 * @param {string} method - 'manual' | 'round_robin' | 'load_balanced' (crm_settings.lead_assignment_method)
 * @param {object} payload - the incoming lead/opportunity body (zone, location, industry, lead_source, ...)
 * @returns {Promise<{ assigned_to: number|null, territory_id: number|null, source: string }>}
 */
export async function resolveAssignment(companyId, method, payload = {}) {
  const none = { assigned_to: null, territory_id: null, source: 'none' };
  if (!companyId) return none;

  // Territory is resolved even under 'manual' — a manually-assigned lead still
  // belongs to a territory, and stamping it costs nothing.
  const territory = await resolveTerritoryAssignment(pool, companyId, payload);

  if (!method || method === 'manual') {
    return territory.territory_id
      ? { assigned_to: null, territory_id: territory.territory_id, source: 'territory_stamp_only' }
      : none;
  }

  const ruleMatch = await ruleBasedAssignee(companyId, payload);
  if (ruleMatch) {
    return { assigned_to: ruleMatch, territory_id: territory.territory_id, source: 'assignment_rule' };
  }

  if (territory.assigned_to) {
    return { assigned_to: territory.assigned_to, territory_id: territory.territory_id, source: 'territory' };
  }

  const eligibleIds = await getEligiblePool(companyId);
  if (!eligibleIds.length) {
    return { assigned_to: null, territory_id: territory.territory_id, source: 'no_eligible_pool' };
  }

  let rotated = null;
  if (method === 'load_balanced') rotated = await loadBalancedAssignee(eligibleIds);
  else if (method === 'round_robin') rotated = await roundRobinAssignee(eligibleIds);

  return { assigned_to: rotated, territory_id: territory.territory_id, source: rotated ? method : 'unresolved' };
}

/**
 * Back-compatible wrapper. Four call sites depended on the employees.id-or-null
 * return shape before territories existed; they keep working unchanged, and
 * callers that also want the territory stamp use resolveAssignment() above.
 *
 * @returns {Promise<number|null>} an employees.id, or null if nothing resolved
 */
export async function resolveAutoAssignee(companyId, method, payload = {}) {
  if (!companyId || !method || method === 'manual') return null;
  const { assigned_to } = await resolveAssignment(companyId, method, payload);
  return assigned_to;
}
