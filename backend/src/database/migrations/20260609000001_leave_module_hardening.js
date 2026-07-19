/**
 * 20260609000001_leave_module_hardening
 *
 * Adds:
 *  1. compensatory_off.project_id          — link comp-off to a project
 *  2. leave_applications.delegate_approver_id — manager delegation
 *  3. payroll_runs.leave_encashment_amount — encashment auto-post landing column
 *  4. New leave types: Travel Leave, Emergency Leave, Site Leave,
 *     Shutdown Leave, Field Duty Leave
 *  5. Performance indexes for new columns
 */
export async function up(knex) {
  // 1. project_id on compensatory_off
  await knex.raw(`
    ALTER TABLE compensatory_off
      ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_comp_off_project ON compensatory_off(project_id) WHERE project_id IS NOT NULL`);

  // 2. delegate_approver_id on leave_applications
  await knex.raw(`
    ALTER TABLE leave_applications
      ADD COLUMN IF NOT EXISTS delegate_approver_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_la_delegate ON leave_applications(delegate_approver_id) WHERE delegate_approver_id IS NOT NULL`);

  // 3. leave_encashment_amount on payroll_runs (staging column for auto-post)
  await knex.raw(`
    ALTER TABLE payroll_runs
      ADD COLUMN IF NOT EXISTS leave_encashment_amount NUMERIC(12,2) DEFAULT 0
  `);

  // 4. probation_end_date on employees (if not already present)
  await knex.raw(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS probation_end_date DATE
  `);

  // 5. Manifest Technologies — industrial leave type seeds
  const industrialTypes = [
    {
      leave_name: 'Travel Leave',
      leave_code: 'TL',
      annual_quota: 6,
      description: 'Leave for field engineers travelling to customer sites or project locations',
      accrual_type: 'manual',
      accrual_days_per_month: 0,
      carry_forward_allowed: false,
      max_carry_forward_days: 0,
      allow_half_day: true,
      requires_attachment: false,
      allow_negative_balance: false,
      min_notice_days: 1,
      is_paid: true,
      is_lop_type: false,
      is_comp_off_type: false,
      is_encashable: false,
      gender_restriction: null,
      allowed_in_probation: true,
    },
    {
      leave_name: 'Emergency Leave',
      leave_code: 'EML',
      annual_quota: 3,
      description: 'Emergency leave for unforeseen critical situations — zero notice required',
      accrual_type: 'manual',
      accrual_days_per_month: 0,
      carry_forward_allowed: false,
      max_carry_forward_days: 0,
      allow_half_day: false,
      requires_attachment: false,
      allow_negative_balance: true,
      min_notice_days: 0,
      is_paid: true,
      is_lop_type: false,
      is_comp_off_type: false,
      is_encashable: false,
      gender_restriction: null,
      allowed_in_probation: true,
    },
    {
      leave_name: 'Site Leave',
      leave_code: 'SL2',
      annual_quota: 12,
      description: 'Leave for engineers deployed at customer sites / commissioning locations',
      accrual_type: 'manual',
      accrual_days_per_month: 0,
      carry_forward_allowed: true,
      max_carry_forward_days: 6,
      allow_half_day: true,
      requires_attachment: false,
      allow_negative_balance: false,
      min_notice_days: 3,
      is_paid: true,
      is_lop_type: false,
      is_comp_off_type: false,
      is_encashable: true,
      max_encash_days_per_year: 3,
      gender_restriction: null,
      allowed_in_probation: false,
    },
    {
      leave_name: 'Shutdown Leave',
      leave_code: 'SDL',
      annual_quota: 5,
      description: 'Mandatory plant/factory shutdown leave — does not count against personal quota',
      accrual_type: 'manual',
      accrual_days_per_month: 0,
      carry_forward_allowed: false,
      max_carry_forward_days: 0,
      allow_half_day: false,
      requires_attachment: false,
      allow_negative_balance: false,
      min_notice_days: 0,
      is_paid: true,
      is_lop_type: false,
      is_comp_off_type: false,
      is_encashable: false,
      gender_restriction: null,
      allowed_in_probation: true,
    },
    {
      leave_name: 'Field Duty Leave',
      leave_code: 'FDL',
      annual_quota: 10,
      description: 'Compensatory leave for HVDC/STATCOM/SST field engineers on extended deployment',
      accrual_type: 'manual',
      accrual_days_per_month: 0,
      carry_forward_allowed: true,
      max_carry_forward_days: 5,
      allow_half_day: true,
      requires_attachment: false,
      allow_negative_balance: false,
      min_notice_days: 2,
      is_paid: true,
      is_lop_type: false,
      is_comp_off_type: false,
      is_encashable: true,
      max_encash_days_per_year: 5,
      gender_restriction: null,
      allowed_in_probation: false,
    },
  ];

  let spIdx = 0;
  const safe = async (sql, bindings = []) => {
    const sp = `sp_lmh_${spIdx++}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await knex.raw(sql, bindings);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
  };

  for (const t of industrialTypes) {
    // Use WHERE NOT EXISTS to avoid ON CONFLICT (leave_name) — unique constraint
    // on leave_name was dropped by an earlier migration (company-scoping).
    await safe(
      `INSERT INTO leave_types (
         leave_name, leave_code, annual_quota, description,
         accrual_type, accrual_days_per_month,
         carry_forward_allowed, max_carry_forward_days,
         allow_half_day, requires_attachment, allow_negative_balance,
         min_notice_days, is_paid, is_lop_type, is_comp_off_type,
         is_encashable, gender_restriction, allowed_in_probation,
         is_active
       )
       SELECT $1,$2,$3,$4, $5,$6, $7,$8, $9,$10,$11, $12,$13,$14,$15, $16,$17,$18, true
       WHERE NOT EXISTS (
         SELECT 1 FROM leave_types WHERE leave_name = $1 AND company_id IS NULL
       )`,
      [
        t.leave_name, t.leave_code, t.annual_quota, t.description,
        t.accrual_type, t.accrual_days_per_month,
        t.carry_forward_allowed, t.max_carry_forward_days,
        t.allow_half_day, t.requires_attachment, t.allow_negative_balance,
        t.min_notice_days, t.is_paid, t.is_lop_type, t.is_comp_off_type,
        t.is_encashable, t.gender_restriction, t.allowed_in_probation,
      ]
    );
  }
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE compensatory_off DROP COLUMN IF EXISTS project_id`);
  await knex.raw(`ALTER TABLE leave_applications DROP COLUMN IF EXISTS delegate_approver_id`);
  await knex.raw(`ALTER TABLE payroll_runs DROP COLUMN IF EXISTS leave_encashment_amount`);
  await knex.raw(`ALTER TABLE employees DROP COLUMN IF EXISTS probation_end_date`);
  const names = ['Travel Leave', 'Emergency Leave', 'Site Leave', 'Shutdown Leave', 'Field Duty Leave'];
  for (const n of names) {
    await knex.raw(`DELETE FROM leave_types WHERE leave_name = ? AND company_id IS NULL`, [n]);
  }
}
