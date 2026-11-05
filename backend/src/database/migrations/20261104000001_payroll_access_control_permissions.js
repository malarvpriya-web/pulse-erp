/**
 * 20261104000001 — PC-01 payroll access control: the permission matrix becomes
 * the single authority for payroll, salary and increment endpoints.
 * See PC-01_PERMISSION_MAPPING_PROPOSAL.md §6 (management approval, 04 Nov 26)
 * and MODULE_FEATURE_CONNECTION_MANUAL.md §229.
 *
 * Until now payroll was guarded by role lists in code (PAYROLL_READ_ROLES,
 * FINANCE_ROLES, PROPOSAL_APPROVERS, isHR/isMgr) that gave manager, hr_exec and
 * finance_manager rights the matrix denies them. The code now reads the matrix;
 * this migration adds the rights the approved decisions need.
 *
 * NEW modules (every role gets a row, false unless listed):
 *   salary_proposals         approve  approve / reject salary proposals (D1)
 *   payroll_payment          approve  mark an approved run paid (D2, temporary
 *                                     until PC-02; payer ≠ preparer is enforced in code)
 *   payroll_statutory_config edit     statutory rule versions, the CTC policy, and the
 *                                     CTC / statutory switches in Payroll Settings (D3, Q3)
 *   payroll_tds_extract      export   the salary Form 138 / 24Q extract only (D6)
 *   increment_team           view/add increment recommendations for the caller's
 *                                     DIRECT REPORTS only (D7, Q5)
 *
 * CHANGED rows in the existing `payroll` module (the only non-additive part):
 *   finance_manager  can_approve  false → true   Finance keeps payroll / arrears approval (D1)
 *   hr_manager       can_approve  true  → false  keeps today's approvers exactly: nothing read
 *                                                payroll:approve before, so hr_manager never
 *                                                approved payroll; it keeps proposal approval
 *                                                through salary_proposals
 * Each change is made only if the row still holds the expected old value; if
 * not, the migration FAILS (it never overwrites an administrator's later edit).
 *
 * No employee, salary, payroll, settings or audit row is touched.
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() restores the two `payroll` values (only if they still hold
 * the values this migration set) and deletes the five new modules' rows only.
 */
export const MODULES = ['salary_proposals', 'payroll_payment', 'payroll_statutory_config', 'payroll_tds_extract', 'increment_team'];

// role code → { module: 'vaedpx' flags }. Absent = no access.
export const GRANTS = {
  super_admin:     { salary_proposals: 'p', payroll_statutory_config: 'e', payroll_tds_extract: 'x' },
  admin:           { salary_proposals: 'p', payroll_statutory_config: 'e', payroll_tds_extract: 'x' },
  payroll_admin:   { salary_proposals: 'p', payroll_statutory_config: 'e' },
  hr_manager:      { salary_proposals: 'p' },
  finance_manager: { salary_proposals: 'p', payroll_payment: 'p', payroll_tds_extract: 'x' },
  finance:         { payroll_tds_extract: 'x' },
  accounts_exec:   { payroll_tds_extract: 'x' },
  manager:         { increment_team: 'va' },
  department_head: { increment_team: 'va' },
};

/** The two existing `payroll` rows this migration changes: [role, column, from, to]. */
export const PAYROLL_CHANGES = [
  ['finance_manager', 'can_approve', false, true],
  ['hr_manager',      'can_approve', true,  false],
];

const FLAG = { v: 'can_view', a: 'can_add', e: 'can_edit', d: 'can_delete', p: 'can_approve', x: 'can_export' };
const COLS = Object.values(FLAG);

export function rowFor(roleCode, module) {
  const flags = GRANTS[roleCode]?.[module] || '';
  return Object.fromEntries(COLS.map(c => [c, Object.entries(FLAG).some(([k, col]) => col === c && flags.includes(k))]));
}

async function setPayrollFlag(knex, role, column, from, to) {
  // column comes from the constant above, never from input
  const { rows } = await knex.raw(
    `UPDATE role_permissions rp SET ${column} = $3
       FROM roles r
      WHERE r.id = rp.role_id AND LOWER(r.code) = $1 AND rp.module = 'payroll' AND rp.${column} = $2
      RETURNING rp.id`,
    [role, from, to],
  );
  if (rows.length !== 1) {
    throw new Error(`payroll.${column} for role ${role} is not ${from} as expected (rows matched: ${rows.length}) — refusing to change the matrix`);
  }
}

export async function up(knex) {
  for (const [role, column, from, to] of PAYROLL_CHANGES) await setPayrollFlag(knex, role, column, from, to);

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
  for (const [role, column, from, to] of PAYROLL_CHANGES) await setPayrollFlag(knex, role, column, to, from);
  await knex.raw(`DELETE FROM role_permissions WHERE module = ANY($1)`, [MODULES]);
}
