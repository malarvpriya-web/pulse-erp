/**
 * 20261112000003_gate_access_production.js — Gate Pass & Visitors made
 * production-ready (owner decisions 2026-11-12). MODULE_FEATURE_CONNECTION_MANUAL.md §272.
 *
 * 1. `gate_access` permission module. The page and its routes were gated on
 *    `hr`, so a gate-desk login needed HR rights over every employee record.
 *      view     the pass and visitor registers       add     issue passes for anyone, check visitors in
 *      edit     gate actions (out / in / returns / close), edit or cancel any pass, check out
 *      approve  the HR fallback approver (a department with no head and an employee with no manager)
 *      export   CSV
 *    Granted to the roles that held hr:add/edit (super_admin, admin, hr,
 *    hr_manager, hr_exec), so nobody loses what they had. Every other role gets
 *    a row of falses. Employees need NO grant to request their own pass or
 *    pre-register their own visitor — the routes allow that to anyone signed in
 *    with a linked employee.
 *
 * 2. gate_passes: person AND material passes.
 *      pass_type person | material; category (person: official, personal,
 *      medical, other); returnable + expected_return_at (material, RGP / NRGP);
 *      vehicle_number, carried_by, destination; requested_by; actual out/in
 *      times and who recorded them; close_reason; updated_at.
 *    Lifecycle  pending → approved → out → completed, or → cancelled. The
 *    legacy stored 'active' becomes 'approved' (it meant approved).
 *    gate_pass_items: the goods on a material pass, with returned quantity.
 *
 * 3. visitors: pre-registration (check_in_time NULL until arrival,
 *    expected_at), who pre-registered / checked in / checked out, cancel,
 *    vehicle, group size, updated_at. check_in_time loses its DEFAULT now():
 *    a pre-registered visitor has not arrived.
 *    ⚠ id_number is now stored MASKED (last 4 characters only). Existing values
 *    are masked here; the full number is never written again.
 *
 * 4. access_events: the history of every pass and visit (who did what, when).
 *
 * 5. Foreign keys to employees on every employee column, and the indexes the
 *    lists filter on. The FKs are added NOT VALID and then validated when no
 *    orphan exists, so a DB still holding a dangling legacy row migrates (new
 *    rows are checked either way) — the developer DB's 10 SEED rows, two of
 *    which pointed at a missing / deleted employee, were deleted first by
 *    scripts/cleanup/gate-access-seed-cleanup.mjs.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export const MODULE = 'gate_access';
export const GRANTS = {
  super_admin: 'vaepx',
  admin:       'vaepx',
  hr:          'vaepx',
  hr_manager:  'vaepx',
  hr_exec:     'vaepx',
};
const FLAG = { v: 'can_view', a: 'can_add', e: 'can_edit', d: 'can_delete', p: 'can_approve', x: 'can_export' };
const COLS = Object.values(FLAG);
export function rowFor(roleCode) {
  const flags = GRANTS[roleCode] || '';
  return Object.fromEntries(Object.entries(FLAG).map(([k, col]) => [col, flags.includes(k)]));
}

/** Keep the last 4 letters/digits; everything else becomes X. */
export function maskIdNumber(value) {
  if (value == null) return null;
  const s = String(value).replace(/[\s-]/g, '').toUpperCase();
  if (!s) return null;
  if (/^X+[A-Z0-9]{0,4}$/.test(s)) return s;            // already masked
  const keep = Math.min(4, Math.max(0, s.length - 2));
  return 'X'.repeat(s.length - keep) + s.slice(s.length - keep);
}

const FKS = [
  ['gate_passes', 'employee_id'], ['gate_passes', 'approved_by'], ['gate_passes', 'cancelled_by'],
  ['gate_passes', 'completed_by'], ['gate_passes', 'out_by'], ['gate_passes', 'in_by'], ['gate_passes', 'requested_by'],
  ['visitors', 'host_employee_id'], ['visitors', 'pre_registered_by'], ['visitors', 'checked_in_by'],
  ['visitors', 'checked_out_by'], ['visitors', 'cancelled_by'],
];
const fkName = (t, c) => `${t}_${c}_fkey`;

export async function up(knex) {
  // 1. permission module
  const { rows: roles } = await knex.raw(`SELECT id, LOWER(code) AS code FROM roles`);
  for (const role of roles) {
    const r = rowFor(role.code);
    await knex.raw(
      `INSERT INTO role_permissions (role_id, module, ${COLS.join(', ')})
       VALUES ($1, $2, ${COLS.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (role_id, module) DO NOTHING`,
      [role.id, MODULE, ...COLS.map(c => r[c])],
    );
  }

  // 2. gate passes
  await knex.raw(`
    ALTER TABLE gate_passes
      ADD COLUMN IF NOT EXISTS pass_type          VARCHAR(10) NOT NULL DEFAULT 'person',
      ADD COLUMN IF NOT EXISTS category           VARCHAR(20),
      ADD COLUMN IF NOT EXISTS returnable         BOOLEAN,
      ADD COLUMN IF NOT EXISTS expected_return_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS vehicle_number     VARCHAR(30),
      ADD COLUMN IF NOT EXISTS carried_by         VARCHAR(200),
      ADD COLUMN IF NOT EXISTS destination        VARCHAR(300),
      ADD COLUMN IF NOT EXISTS requested_by       INTEGER,
      ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS out_at             TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS out_by             INTEGER,
      ADD COLUMN IF NOT EXISTS in_at              TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS in_by              INTEGER,
      ADD COLUMN IF NOT EXISTS close_reason       TEXT,
      ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ`);
  await knex.raw(`UPDATE gate_passes SET status = 'approved' WHERE status = 'active'`);
  await knex.raw(`ALTER TABLE gate_passes DROP CONSTRAINT IF EXISTS gate_passes_status_known`);
  await knex.raw(`ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_status_known
                    CHECK (status IN ('pending', 'approved', 'out', 'completed', 'cancelled'))`);
  await knex.raw(`ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_type_known CHECK (pass_type IN ('person', 'material'))`);
  await knex.raw(`ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_category_known
                    CHECK (category IS NULL OR category IN ('official', 'personal', 'medical', 'other'))`);
  // New rows only (NOT VALID): a pass names its employee; a material pass says
  // whether the goods come back, and a returnable one says when.
  await knex.raw(`ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_names_employee CHECK (employee_id IS NOT NULL) NOT VALID`);
  await knex.raw(`ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_material_terms
                    CHECK (pass_type <> 'material' OR (returnable IS NOT NULL AND (returnable = false OR expected_return_at IS NOT NULL))) NOT VALID`);
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_gate_pass`);
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_material_gate_pass`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS gate_passes_company_number_uq ON gate_passes (company_id, pass_number) WHERE pass_number IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS gate_passes_company_status_idx ON gate_passes (company_id, status, created_at DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS gate_passes_employee_idx ON gate_passes (employee_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS gate_pass_items (
      id                SERIAL PRIMARY KEY,
      gate_pass_id      INTEGER NOT NULL REFERENCES gate_passes(id) ON DELETE CASCADE,
      company_id        INTEGER,
      line_no           INTEGER NOT NULL,
      description       VARCHAR(300) NOT NULL,
      item_code         VARCHAR(100),
      quantity          NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
      unit              VARCHAR(20) NOT NULL DEFAULT 'Nos',
      returned_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
      last_returned_at  TIMESTAMPTZ,
      remarks           VARCHAR(500),
      CONSTRAINT gate_pass_items_returned_range CHECK (returned_quantity >= 0 AND returned_quantity <= quantity)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS gate_pass_items_pass_idx ON gate_pass_items (gate_pass_id, line_no)`);

  // 3. visitors
  await knex.raw(`
    ALTER TABLE visitors
      ADD COLUMN IF NOT EXISTS expected_at       TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS pre_registered_by INTEGER,
      ADD COLUMN IF NOT EXISTS checked_in_by     INTEGER,
      ADD COLUMN IF NOT EXISTS checked_out_by    INTEGER,
      ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS cancelled_by      INTEGER,
      ADD COLUMN IF NOT EXISTS cancel_reason     TEXT,
      ADD COLUMN IF NOT EXISTS vehicle_number    VARCHAR(30),
      ADD COLUMN IF NOT EXISTS visitor_count     SMALLINT NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE visitors ALTER COLUMN check_in_time DROP DEFAULT`);
  await knex.raw(`ALTER TABLE visitors ADD CONSTRAINT visitors_count_range CHECK (visitor_count BETWEEN 1 AND 100)`);
  await knex.raw(`ALTER TABLE visitors ADD CONSTRAINT visitors_out_needs_in CHECK (check_out_time IS NULL OR check_in_time IS NOT NULL)`);
  await knex.raw(`ALTER TABLE visitors ADD CONSTRAINT visitors_arrival_known CHECK (check_in_time IS NOT NULL OR expected_at IS NOT NULL OR cancelled_at IS NOT NULL) NOT VALID`);
  const { rows: ids } = await knex.raw(`SELECT id, id_number FROM visitors WHERE id_number IS NOT NULL AND id_number <> ''`);
  for (const r of ids) {
    const masked = maskIdNumber(r.id_number);
    if (masked !== r.id_number) await knex.raw(`UPDATE visitors SET id_number = $1 WHERE id = $2`, [masked, r.id]);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS visitors_company_open_idx ON visitors (company_id, check_out_time, check_in_time DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS visitors_company_phone_idx ON visitors (company_id, phone)`);

  // 4. history
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS access_events (
      id                BIGSERIAL PRIMARY KEY,
      company_id        INTEGER,
      entity_type       VARCHAR(20) NOT NULL CHECK (entity_type IN ('gate_pass', 'visitor')),
      entity_id         INTEGER NOT NULL,
      action            VARCHAR(30) NOT NULL,
      actor_user_id     INTEGER,
      actor_employee_id INTEGER,
      note              TEXT,
      data              JSONB,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS access_events_entity_idx ON access_events (entity_type, entity_id, created_at)`);

  // 5. foreign keys
  for (const [t, c] of FKS) {
    await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${fkName(t, c)}`);
    await knex.raw(`ALTER TABLE ${t} ADD CONSTRAINT ${fkName(t, c)} FOREIGN KEY (${c}) REFERENCES employees(id) NOT VALID`);
    await knex.raw(`DO $$ BEGIN
        ALTER TABLE ${t} VALIDATE CONSTRAINT ${fkName(t, c)};
      EXCEPTION WHEN foreign_key_violation THEN
        RAISE NOTICE '${t}.${c}: orphan rows remain, constraint left NOT VALID (new rows are still checked)';
      END $$`);
  }
}

export async function down(knex) {
  for (const [t, c] of FKS) await knex.raw(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${fkName(t, c)}`);
  await knex.raw(`DROP TABLE IF EXISTS access_events`);
  await knex.raw(`DROP TABLE IF EXISTS gate_pass_items`);
  await knex.raw(`DROP INDEX IF EXISTS visitors_company_open_idx`);
  await knex.raw(`DROP INDEX IF EXISTS visitors_company_phone_idx`);
  await knex.raw(`ALTER TABLE visitors DROP CONSTRAINT IF EXISTS visitors_count_range,
                    DROP CONSTRAINT IF EXISTS visitors_out_needs_in, DROP CONSTRAINT IF EXISTS visitors_arrival_known`);
  await knex.raw(`UPDATE visitors SET check_in_time = COALESCE(check_in_time, expected_at, cancelled_at, created_at) WHERE check_in_time IS NULL`);
  await knex.raw(`ALTER TABLE visitors ALTER COLUMN check_in_time SET DEFAULT now()`);
  await knex.raw(`ALTER TABLE visitors
      DROP COLUMN IF EXISTS expected_at, DROP COLUMN IF EXISTS pre_registered_by, DROP COLUMN IF EXISTS checked_in_by,
      DROP COLUMN IF EXISTS checked_out_by, DROP COLUMN IF EXISTS cancelled_at, DROP COLUMN IF EXISTS cancelled_by,
      DROP COLUMN IF EXISTS cancel_reason, DROP COLUMN IF EXISTS vehicle_number, DROP COLUMN IF EXISTS visitor_count,
      DROP COLUMN IF EXISTS updated_at`);
  await knex.raw(`DROP INDEX IF EXISTS gate_passes_company_number_uq`);
  await knex.raw(`DROP INDEX IF EXISTS gate_passes_company_status_idx`);
  await knex.raw(`DROP INDEX IF EXISTS gate_passes_employee_idx`);
  await knex.raw(`ALTER TABLE gate_passes DROP CONSTRAINT IF EXISTS gate_passes_type_known,
                    DROP CONSTRAINT IF EXISTS gate_passes_category_known, DROP CONSTRAINT IF EXISTS gate_passes_names_employee,
                    DROP CONSTRAINT IF EXISTS gate_passes_material_terms, DROP CONSTRAINT IF EXISTS gate_passes_status_known`);
  await knex.raw(`DELETE FROM gate_passes WHERE pass_type = 'material'`);
  await knex.raw(`UPDATE gate_passes SET status = 'completed' WHERE status = 'out'`);
  await knex.raw(`ALTER TABLE gate_passes ADD CONSTRAINT gate_passes_status_known
                    CHECK (status IN ('pending', 'approved', 'active', 'cancelled', 'completed'))`);
  await knex.raw(`ALTER TABLE gate_passes
      DROP COLUMN IF EXISTS pass_type, DROP COLUMN IF EXISTS category, DROP COLUMN IF EXISTS returnable,
      DROP COLUMN IF EXISTS expected_return_at, DROP COLUMN IF EXISTS vehicle_number, DROP COLUMN IF EXISTS carried_by,
      DROP COLUMN IF EXISTS destination, DROP COLUMN IF EXISTS requested_by, DROP COLUMN IF EXISTS created_by_user_id,
      DROP COLUMN IF EXISTS out_at, DROP COLUMN IF EXISTS out_by, DROP COLUMN IF EXISTS in_at, DROP COLUMN IF EXISTS in_by,
      DROP COLUMN IF EXISTS close_reason, DROP COLUMN IF EXISTS updated_at`);
  await knex.raw(`DROP SEQUENCE IF EXISTS seq_gate_pass`);
  await knex.raw(`DROP SEQUENCE IF EXISTS seq_material_gate_pass`);
  await knex.raw(`DELETE FROM role_permissions WHERE module = $1`, [MODULE]);
}
