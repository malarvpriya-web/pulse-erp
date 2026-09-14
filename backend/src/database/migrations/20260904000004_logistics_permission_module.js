/**
 * 20260904000004_logistics_permission_module.js
 *
 * Adds the `logistics` module to role_permissions.
 *
 * WHY
 * ---
 * A live authorization probe on 2026-09-04 found /api/logistics/shipments,
 * /eway-bills and /dashboard answering 200 to a plain `employee` token. The
 * router is mounted `verifyToken`-only and not one of its 10 routes carries a
 * gate, so shipment records, courier references, freight costs and e-way bill
 * numbers were readable by anyone with a login.
 *
 * The gate cannot be added in code first: `requirePermission` fails CLOSED when
 * no (role, module) row exists, and `logistics` has never been a module in the
 * matrix. Gating without these rows would lock out the stores and dispatch teams
 * that own the feature — the same trap the `marketing` module hit in §153.
 *
 * GRANTS — mirrored from `warehouse`, the closest existing analogue: dispatch
 * and inward movement are the same population and the same records seen from two
 * ends. Procurement gets read access because inbound shipments are theirs to
 * chase, and sales gets read access because a customer asking "where is my
 * order" is answered from this data.
 *
 * Everyone else gets an explicit all-false DENY row, which is the house pattern:
 * absence means "never configured", not "denied".
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

const GRANTS = {
  super_admin:         FULL,
  admin:               FULL,
  store_keeper:        'VAEX',       // books dispatches, prints e-way bills
  procurement_manager: 'VAEDPX',     // owns inbound movement
  procurement_exec:    'VAE',
  production_manager:  'V',          // needs to know what has shipped
  sales_manager:       'VX',         // answers "where is my order"
  sales_exec:          'V',
  finance_manager:     'VX',         // freight cost lands in the ledger
  manager:             'VX',
};

export async function up(knex) {
  const { rows: roles } = await knex.raw('SELECT id, code FROM roles');

  const values = [];
  const params = [];
  let grants = 0, denies = 0;

  for (const role of roles) {
    const code = String(role.code).toLowerCase();
    const p = G(GRANTS[code] ?? '');
    p.can_view ? grants++ : denies++;

    const i = params.length;
    values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8})`);
    params.push(role.id, 'logistics', p.can_view, p.can_add, p.can_edit, p.can_delete, p.can_approve, p.can_export);
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
  console.log(`[logistics_permission_module] seeded ${values.length} pairs (${grants} with view, ${denies} explicit deny)`);
}

export async function down(knex) {
  await knex.raw(`DELETE FROM role_permissions WHERE module = 'logistics'`);
}
