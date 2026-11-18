/**
 * 20261111000001 — owner decision (11 Nov 26): employees no longer change
 * their own HR / tax records. IT declarations are entered by Finance; documents
 * and profile changes by HR. The Employee Self-Service page is removed.
 * Expense claims are NOT affected (Travel Desk → Expense Claims stays).
 *
 * CHANGED rows:
 *   self_service      can_add, can_edit  true → false   for every role that held them
 *                     (can_view kept: reading one's own record stays allowed)
 *   it_declarations   finance_manager  can_view false → true, can_add false → true
 *                     hr_manager       can_add  true  → false   (still views / reviews)
 *
 * Every own-record write in selfservice.routes.js already requires
 * self_service:add or :edit, so turning those off is what makes the server
 * refuse an employee filing a declaration, uploading a document or editing
 * their profile. Filing FOR an employee stays it_declarations:add.
 *
 * Each change is made only if the row still holds the expected old value; a row
 * that does not is skipped for self_service (a role may never have held it) but
 * FAILS for it_declarations (never overwrite an administrator's later edit).
 * The runner is a pg shim: placeholders are $n, never ?.
 * Rollback: down() restores exactly the rows up() changed.
 */
export const SELF_SERVICE_ROLES = ['admin', 'employee', 'hr', 'hr_exec', 'hr_manager', 'manager', 'payroll_admin', 'super_admin'];
export const DECLARATION_CHANGES = [
  ['finance_manager', 'it_declarations', 'can_view', false, true],
  ['finance_manager', 'it_declarations', 'can_add',  false, true],
  ['hr_manager',      'it_declarations', 'can_add',  true,  false],
];

async function setFlag(knex, role, module, column, from, to, { strict }) {
  // module and column come from the constants above, never from input
  const { rows } = await knex.raw(
    `UPDATE role_permissions rp SET ${column} = $3
       FROM roles r
      WHERE r.id = rp.role_id AND LOWER(r.code) = $1 AND rp.module = $4 AND rp.${column} = $2
      RETURNING rp.id`,
    [role, from, to, module],
  );
  if (strict && rows.length !== 1) {
    throw new Error(`${module}.${column} for role ${role} is not ${from} as expected (rows matched: ${rows.length}) — refusing to change the matrix`);
  }
}

export async function up(knex) {
  for (const role of SELF_SERVICE_ROLES) {
    for (const col of ['can_add', 'can_edit']) await setFlag(knex, role, 'self_service', col, true, false, { strict: false });
  }
  for (const [role, module, column, from, to] of DECLARATION_CHANGES) {
    await setFlag(knex, role, module, column, from, to, { strict: true });
  }
}

export async function down(knex) {
  for (const [role, module, column, from, to] of DECLARATION_CHANGES) {
    await setFlag(knex, role, module, column, to, from, { strict: true });
  }
  for (const role of SELF_SERVICE_ROLES) {
    for (const col of ['can_add', 'can_edit']) await setFlag(knex, role, 'self_service', col, false, true, { strict: false });
  }
}
