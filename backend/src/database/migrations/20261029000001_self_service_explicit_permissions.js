/**
 * 20261029000001 — explicit, least-privilege permissions for employee
 * self-service, IT declarations, expense claims, identity documents and bank
 * details. See MODULE_FEATURE_CONNECTION_MANUAL.md §202.
 *
 * These used to be decided by role lists in code: PAYROLL_READ_ROLES (which let
 * manager and finance_manager read any colleague's IT declarations and claims),
 * the `hr` module (which let payroll_admin read every colleague's Aadhaar and
 * passport uploads), allowRoles('finance') on the claim workflow, and nothing at
 * all on bank details. Each is now its own matrix module, so an administrator
 * can see and change who holds it in Roles Setup.
 *
 *   self_service        view/add/edit  the caller's OWN declarations, documents,
 *                                      claims and profile (the HR-menu roles)
 *   it_declarations     view/add/approve  a colleague's declarations: read,
 *                                      file on their behalf, review
 *   expense_claims      view / edit / approve  colleagues' claims: read,
 *                                      accounts verification, management approval
 *   expense_payments    approve        record a claim's payment
 *   employee_documents  view/add/edit/delete  colleagues' identity documents
 *                                      (edit = verify / reject)
 *   employee_bank       view/edit      see unmasked bank details, change them
 *
 * Every role gets a row (false where nothing is granted), so the matrix stays
 * complete and requirePermission never meets an unconfigured module.
 *
 * Purely additive: rows that already exist are left exactly as they are
 * (ON CONFLICT DO NOTHING), so an administrator's later edits survive a re-run.
 * No employee, bank, payroll, claim, document or accounting row is touched.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() deletes the rows of these six modules only.
 */
export const MODULES = ['self_service', 'it_declarations', 'expense_claims', 'expense_payments', 'employee_documents', 'employee_bank'];

// role code → { module: 'vaedpx' flags }. Absent = no access.
export const GRANTS = {
  super_admin:     { self_service: 'vae', it_declarations: 'vap', expense_claims: 'vep', expense_payments: 'vp', employee_documents: 'vaed', employee_bank: 've' },
  admin:           { self_service: 'vae', it_declarations: 'vap', expense_claims: 'vep', expense_payments: 'vp', employee_documents: 'vaed', employee_bank: 've' },
  hr:              { self_service: 'vae', employee_documents: 'vaed', employee_bank: 've' },
  hr_manager:      { self_service: 'vae', it_declarations: 'vap', employee_documents: 'vaed', employee_bank: 've' },
  hr_exec:         { self_service: 'vae', employee_documents: 'vae' },
  payroll_admin:   { self_service: 'vae', it_declarations: 'vap' },
  finance:         { expense_claims: 've', expense_payments: 'vp' },
  finance_manager: { expense_claims: 've', expense_payments: 'vp' },
  accounts_exec:   { expense_claims: 've' },
  manager:         { self_service: 'vae' },
  employee:        { self_service: 'vae' },
};

const FLAG = { v: 'can_view', a: 'can_add', e: 'can_edit', d: 'can_delete', p: 'can_approve', x: 'can_export' };
const COLS = Object.values(FLAG);

export function rowFor(roleCode, module) {
  const flags = GRANTS[roleCode]?.[module] || '';
  return Object.fromEntries(COLS.map(c => [c, Object.entries(FLAG).some(([k, col]) => col === c && flags.includes(k))]));
}

export async function up(knex) {
  const { rows: roles } = await knex.raw(`SELECT id, LOWER(code) AS code FROM roles`);
  for (const role of roles) {
    for (const module of MODULES) {
      const r = rowFor(role.code, module);
      await knex.raw(
        `INSERT INTO role_permissions (role_id, module, ${COLS.join(', ')})
         VALUES ($1, $2, ${COLS.map((_, i) => `$${i + 3}`).join(', ')})
         ON CONFLICT (role_id, module) DO NOTHING`,
        [role.id, module, ...COLS.map(c => r[c])],
      );
    }
  }
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = ANY($1)`, [MODULES]);
}
