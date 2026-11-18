/**
 * 20261112000004_visitor_entry_approval_security_role.js — owner decisions
 * 2026-11-12 (MODULE_FEATURE_CONNECTION_MANUAL.md §273):
 *
 *   · A visitor needs a SECURITY-approved visitor pass before entering.
 *     visitors + pass_number (VP-YYYY-00001, issued on approval), approved_at/by,
 *     rejected_at/by, reject_reason. Check-in is refused until approved.
 *   · A visitor taking goods out: a material gate pass linked to the visit
 *     (gate_passes.visitor_id). The HOST approves it, security releases it at
 *     the gate; the visitor cannot check out while it is still open.
 *   · A Security / Gate Desk role (code `security`).
 *
 * Permission module `gate_security` — approve = approve or reject visitor entry.
 * Kept apart from gate_access:approve, which is the HR fallback approver of
 * EMPLOYEE passes: a guard must not approve an employee's personal pass, and HR
 * does not approve visitor entry ("security only").
 *   super_admin, admin  view + approve (administrators hold everything)
 *   security            view + approve
 *   every other role    a row of falses
 * The `security` role also gets gate_access view/add/edit — the registers,
 * walk-in registration and check-in, and gate movements — but NOT gate_access
 * approve or export.
 *
 * Existing visitors (none in the developer DB since the §272 cleanup) that are
 * already inside or checked out keep working; any still-expected visitor waits
 * for security like a new one.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
const FLAG = { v: 'can_view', a: 'can_add', e: 'can_edit', d: 'can_delete', p: 'can_approve', x: 'can_export' };
const COLS = Object.values(FLAG);
const rowFor = (flags = '') => Object.fromEntries(Object.entries(FLAG).map(([k, col]) => [col, flags.includes(k)]));

export const SECURITY_GRANTS = { super_admin: 'vp', admin: 'vp', security: 'vp' };
export const SECURITY_ROLE = { code: 'security', role_name: 'Security / Gate Desk', label: 'Security / Gate Desk',
  description: 'Gate desk: approves visitor entry, registers and checks visitors in and out, records gate-pass movements' };

async function upsertGrant(knex, roleId, module, flags) {
  const r = rowFor(flags);
  await knex.raw(
    `INSERT INTO role_permissions (role_id, module, ${COLS.join(', ')})
     VALUES ($1, $2, ${COLS.map((_, i) => `$${i + 3}`).join(', ')})
     ON CONFLICT (role_id, module) DO NOTHING`,
    [roleId, module, ...COLS.map(c => r[c])]);
}

export async function up(knex) {
  // 1. visitor entry approval
  await knex.raw(`
    ALTER TABLE visitors
      ADD COLUMN IF NOT EXISTS pass_number   VARCHAR(30),
      ADD COLUMN IF NOT EXISTS approved_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS approved_by   INTEGER REFERENCES employees(id),
      ADD COLUMN IF NOT EXISTS approved_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS rejected_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS rejected_by   INTEGER REFERENCES employees(id),
      ADD COLUMN IF NOT EXISTS reject_reason TEXT`);
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_visitor_pass`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS visitors_company_pass_uq ON visitors (company_id, pass_number) WHERE pass_number IS NOT NULL`);

  // 2. visitor goods
  await knex.raw(`ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS visitor_id INTEGER REFERENCES visitors(id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS gate_passes_visitor_idx ON gate_passes (visitor_id) WHERE visitor_id IS NOT NULL`);
  await knex.raw(`ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_visitor_goods
                    CHECK (visitor_id IS NULL OR pass_type = 'material') NOT VALID`);

  // 3. the Security / Gate Desk role, in the company that owns the role catalogue
  const { rows: [owner] } = await knex.raw(`SELECT company_id FROM roles WHERE LOWER(code) = 'super_admin' ORDER BY id LIMIT 1`);
  const { rows: existing } = await knex.raw(`SELECT id FROM roles WHERE LOWER(code) = $1`, [SECURITY_ROLE.code]);
  if (!existing.length) {
    await knex.raw(
      `INSERT INTO roles (role_name, code, label, description, is_active, company_id) VALUES ($1, $2, $3, $4, true, $5)`,
      [SECURITY_ROLE.role_name, SECURITY_ROLE.code, SECURITY_ROLE.label, SECURITY_ROLE.description, owner?.company_id ?? null]);
  }

  // 4. permissions
  const { rows: roles } = await knex.raw(`SELECT id, LOWER(code) AS code FROM roles`);
  for (const role of roles) {
    await upsertGrant(knex, role.id, 'gate_security', SECURITY_GRANTS[role.code] || '');
    if (role.code === 'security') await upsertGrant(knex, role.id, 'gate_access', 'vae');
  }
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = 'gate_security'`);
  await knex.raw(`DELETE FROM role_permissions WHERE module = 'gate_access' AND role_id IN (SELECT id FROM roles WHERE LOWER(code) = 'security')`);
  await knex.raw(`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE LOWER(code) = 'security')`);
  await knex.raw(`DELETE FROM roles WHERE LOWER(code) = 'security'`);
  await knex.raw(`ALTER TABLE gate_passes DROP CONSTRAINT IF EXISTS gate_passes_visitor_goods`);
  await knex.raw(`DROP INDEX IF EXISTS gate_passes_visitor_idx`);
  await knex.raw(`ALTER TABLE gate_passes DROP COLUMN IF EXISTS visitor_id`);
  await knex.raw(`DROP INDEX IF EXISTS visitors_company_pass_uq`);
  await knex.raw(`DROP SEQUENCE IF EXISTS seq_visitor_pass`);
  await knex.raw(`ALTER TABLE visitors
      DROP COLUMN IF EXISTS pass_number, DROP COLUMN IF EXISTS approved_at, DROP COLUMN IF EXISTS approved_by,
      DROP COLUMN IF EXISTS approved_by_user_id, DROP COLUMN IF EXISTS rejected_at, DROP COLUMN IF EXISTS rejected_by,
      DROP COLUMN IF EXISTS reject_reason`);
}
