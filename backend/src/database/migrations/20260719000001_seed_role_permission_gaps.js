/**
 * 20260719000001_seed_role_permission_gaps.js
 *
 * Seeds the 148 missing (module, role) pairs that made `requirePermission` fail
 * OPEN. See SECURITY_AUDIT_2026-07-18.md H-2 failure mode (i).
 *
 * Why they were missing:
 *   • `maintenance`, `iot`, `rd`, `compliance`, `assets` were added as modules
 *     but never seeded for ANY role — 125 of the 148 pairs.
 *   • `finance` (the role actually provisioned to finance staff, added after
 *     `finance_manager`) had only 6 rows, so it fell through fail-open on 16
 *     modules it has no business reaching.
 *   • `manager`, `hr`, `department_head` had no rows on 9 operational modules.
 *
 * Method — mirror an existing analogue, never invent:
 *   maintenance ← production   (shop-floor upkeep, same operators)
 *   iot         ← production   (device telemetry sits with the line + service)
 *   rd          ← engineering  (same design population)
 *   compliance  ← quality      (audit/evidence is QC's remit)
 *   assets      ← inventory    (custody and stores)
 *
 * An all-false row is a DENY, and is the established house pattern here — the
 * existing matrix already writes explicit deny rows for out-of-scope roles
 * rather than omitting them. That is precisely what makes PERMISSION_STRICT
 * safe to enable: absence means "never configured", not "denied".
 *
 * ON CONFLICT DO NOTHING throughout: this only fills gaps and can never
 * overwrite a decision someone has already made in the UI. Safe to re-run.
 */

// V=view A=add E=edit D=delete P=approve X=export
const G = (s = '') => ({
  can_view:    s.includes('V'),
  can_add:     s.includes('A'),
  can_edit:    s.includes('E'),
  can_delete:  s.includes('D'),
  can_approve: s.includes('P'),
  can_export:  s.includes('X'),
});

const FULL = 'VAEDPX';

/** module → { role: grantString }. Roles absent from a map get an explicit deny. */
const SEED = {
  // ← production
  maintenance: {
    super_admin: FULL, admin: FULL,
    production_manager: FULL, production_engineer: 'VAE',
    store_keeper: 'VAE',                 // spares issue against work orders
    qc_manager: 'V', qc_engineer: 'V', design_engineer: 'V',
    service_manager: 'VAE', service_engineer: 'VAE',  // breakdown calls land here
  },
  // ← production, plus service (device alerts raise service tickets)
  iot: {
    super_admin: FULL, admin: FULL,
    production_manager: FULL, production_engineer: 'VAE',
    service_manager: 'VAEPX', service_engineer: 'VAE',
    qc_manager: 'V', design_engineer: 'V',
  },
  // ← engineering
  rd: {
    super_admin: FULL, admin: FULL,
    design_engineer: 'VAED', production_manager: 'VAEPX',
    production_engineer: 'V', qc_manager: 'V', project_manager: 'V',
  },
  // ← quality
  compliance: {
    super_admin: FULL, admin: FULL,
    qc_manager: FULL, qc_engineer: 'VAE',
    production_manager: 'VAEDP', production_engineer: 'V',
    hr: 'V',                             // HR owns some certification evidence
  },
  // ← inventory
  assets: {
    super_admin: FULL, admin: FULL,
    procurement_manager: 'VAEDP', procurement_exec: 'V',
    store_keeper: 'VAEX',
    production_manager: 'V', production_engineer: 'V',
    qc_manager: 'V', hr: 'V',            // employee asset allocation
  },
};

/**
 * Roles that keep view access on modules where application code already treats
 * them as staff. servicedesk's SERVICE_STAFF_ROLES names `manager` and `hr` as
 * "legacy coarse roles kept for backward compatibility"; denying them outright
 * here would revoke access the code still grants, so they get read-only rather
 * than nothing. Narrow this once those legacy roles are retired.
 */
const LEGACY_VIEW = { servicedesk: ['manager', 'hr'] };

// Modules referenced by requirePermission() in application code.
const CODE_MODULES = [
  'finance', 'crm', 'inventory', 'projects', 'sales', 'production', 'leaves',
  'hr', 'bom', 'maintenance', 'iot', 'servicedesk', 'procurement', 'rd',
  'engineering', 'compliance', 'assets',
];

// NOTE: the migration runner passes a THIN PG SHIM, not knex — only .raw()/.query()
// with $1-style bindings. The query-builder API is unavailable; `?` never binds.
export async function up(knex) {
  const { rows: roles }    = await knex.raw('SELECT id, code FROM roles');
  const { rows: existing } = await knex.raw('SELECT role_id, module FROM role_permissions');
  const have = new Set(existing.map(r => `${r.role_id}|${r.module}`));

  const values = [];
  const params = [];
  let denies = 0, grants = 0;

  for (const mod of CODE_MODULES) {
    for (const role of roles) {
      const code = String(role.code).toLowerCase();
      if (have.has(`${role.id}|${mod}`)) continue;      // never touch existing decisions

      let grant = SEED[mod]?.[code];
      if (grant === undefined && LEGACY_VIEW[mod]?.includes(code)) grant = 'V';
      // super_admin/admin are unrestricted on every module, including ones with
      // no SEED entry — omitting that would lock administrators out under
      // PERMISSION_STRICT, which is the one failure mode with no recovery path.
      if (grant === undefined && (code === 'super_admin' || code === 'admin')) grant = FULL;

      const p = G(grant ?? '');
      p.can_view ? grants++ : denies++;

      const i = params.length;
      values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8})`);
      params.push(role.id, mod, p.can_view, p.can_add, p.can_edit, p.can_delete, p.can_approve, p.can_export);
    }
  }

  if (values.length) {
    await knex.raw(
      `INSERT INTO role_permissions
         (role_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
       VALUES ${values.join(',')}
       ON CONFLICT (role_id, module) DO NOTHING`,
      params
    );
  }
  console.log(`[role_permission_gaps] seeded ${values.length} pairs (${grants} with view, ${denies} explicit deny)`);
}

export async function down(knex) {
  // Only removes rows on the five modules that had none before this migration.
  // Anything on a pre-existing module is left alone — a down() that deleted a
  // permission an administrator later granted would be worse than not reverting.
  await knex.raw(
    `DELETE FROM role_permissions WHERE module = ANY($1)`,
    [['maintenance', 'iot', 'rd', 'compliance', 'assets']]
  );
}
