/**
 * Reports module data-integrity remediation (audit 2026-08-19).
 *
 * Four independent problems, all of which produced wrong report output on the
 * live database:
 *
 * 1. `user_scope` gaps make tenant filters fail OPEN.
 *    7 of 37 active accounts had `users.company_id` set but no `user_scope`
 *    row. `verifyToken` builds `req.scope` from `user_scope` — NOT from
 *    `users.company_id` — so those accounts resolved to a null scope, and every
 *    predicate written as `if (company_id != null) …` simply dropped. Proven
 *    live: an Employee saw 8 expense claims and 6 pending POs where the super
 *    admin, correctly scoped, saw 0 and 2. The routes now deny an unresolvable
 *    scope, so without this backfill those users would be locked out instead —
 *    both halves are needed.
 *
 * 2. `saved_reports.created_by` pointed at the wrong id space.
 *    The column FK'd `employees(id)` while every writer supplies a `users.id`.
 *    Those are different sequences, so ownership matched the wrong person or
 *    nobody. The table holds zero rows (its INSERT had never succeeded — six of
 *    the eight columns it wrote do not exist), so repointing the FK is safe.
 *
 * 3. `purchase_requests.company_id` was NULL on 4 of 6 rows.
 *    Written by a path that never set it. Any correctly-scoped query is blind to
 *    them — which is exactly why the Pending Approvals report disagreed between
 *    a scoped and an unscoped caller. Backfilled from the PO that consumed the
 *    request, else from the creating employee, else from the sole company.
 *
 * 4. Missing indexes on columns the reports filter and sort by.
 */

/** Single-company installs can be backfilled unambiguously; multi-company ones must not guess. */
async function soleCompanyId(knex) {
  const { rows } = await knex.raw(`SELECT id FROM companies`);
  return rows.length === 1 ? rows[0].id : null;
}

export async function up(knex) {
  // ── 1. user_scope backfill ────────────────────────────────────────────────
  await knex.raw(`
    INSERT INTO user_scope (user_id, company_id, branch_id, is_primary)
    SELECT u.id, u.company_id, u.branch_id, true
      FROM users u
     WHERE u.company_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM user_scope us WHERE us.user_id = u.id AND us.is_primary)
  `);

  // ── 2. saved_reports.created_by → users(id) ───────────────────────────────
  // Drop whatever FK currently constrains the column, by name lookup rather than
  // a guessed constraint name, then re-add against users.
  const { rows: fks } = await knex.raw(`
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey)
     WHERE rel.relname = 'saved_reports' AND con.contype = 'f' AND att.attname = 'created_by'
  `);
  for (const { conname } of fks) {
    await knex.raw(`ALTER TABLE saved_reports DROP CONSTRAINT IF EXISTS "${conname}"`);
  }
  // Any pre-existing row would carry an employees.id here; there are none, but
  // clear defensively so the new constraint cannot fail on legacy data.
  await knex.raw(`
    UPDATE saved_reports SET created_by = NULL
     WHERE created_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = saved_reports.created_by)
  `);
  await knex.raw(`
    ALTER TABLE saved_reports
      ADD CONSTRAINT saved_reports_created_by_users_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_saved_reports_owner ON saved_reports(created_by) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_saved_reports_company ON saved_reports(company_id) WHERE deleted_at IS NULL`);

  // ── 3. purchase_requests.company_id backfill ──────────────────────────────
  await knex.raw(`
    UPDATE purchase_requests pr
       SET company_id = po.company_id
      FROM purchase_orders po
     WHERE po.pr_id = pr.id AND pr.company_id IS NULL AND po.company_id IS NOT NULL
  `);
  await knex.raw(`
    UPDATE purchase_requests pr
       SET company_id = e.company_id
      FROM employees e
     WHERE e.id = pr.requested_by_employee_id AND pr.company_id IS NULL AND e.company_id IS NOT NULL
  `);
  const sole = await soleCompanyId(knex);
  if (sole != null) {
    // The migration runner is a thin pg shim, so bindings are $n — never `?`.
    await knex.raw(`UPDATE purchase_requests SET company_id = $1 WHERE company_id IS NULL`, [sole]);
  }

  // ── 4. Indexes for the report access patterns ─────────────────────────────
  // stock_ledger: /stock-movement filters AND orders by transaction_date.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_stock_ledger_txn_date ON stock_ledger(transaction_date DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_stock_ledger_item ON stock_ledger(item_id)`);
  // leave_approval_history had only a primary key; /leave/approval-performance
  // joins both of these columns.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_lah_approver ON leave_approval_history(approver_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_lah_application ON leave_approval_history(leave_application_id)`);
  // attendance_records: the attendance report joins employee and ranges on date.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_att_records_emp_date ON attendance_records(employee_id, attendance_date)`);
  // payroll_runs is scoped through employees and grouped by period.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payroll_runs_period ON payroll_runs(year, month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payroll_runs_employee ON payroll_runs(employee_id)`);
  // /purchase-orders and /vendor-performance join vendors and range on order_date.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_po_order_date ON purchase_orders(order_date DESC)`);
  // /outstanding-invoices nets receipts per invoice.
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_receipt_alloc_invoice ON receipt_allocations(invoice_id)`);
}

export async function down(knex) {
  for (const idx of [
    'idx_stock_ledger_txn_date', 'idx_stock_ledger_item',
    'idx_lah_approver', 'idx_lah_application',
    'idx_att_records_emp_date',
    'idx_payroll_runs_period', 'idx_payroll_runs_employee',
    'idx_po_supplier', 'idx_po_order_date',
    'idx_receipt_alloc_invoice',
    'idx_saved_reports_owner', 'idx_saved_reports_company',
  ]) {
    await knex.raw(`DROP INDEX IF EXISTS ${idx}`);
  }
  await knex.raw(`ALTER TABLE saved_reports DROP CONSTRAINT IF EXISTS saved_reports_created_by_users_fkey`);
  // The user_scope and company_id backfills are left in place deliberately:
  // reversing them would restore the fail-open tenant behaviour this migration
  // exists to remove.
}
