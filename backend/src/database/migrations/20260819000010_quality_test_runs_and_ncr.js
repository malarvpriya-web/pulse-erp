/**
 * Quality module — the columns its built screens have always written.
 *
 * Three live, mounted features write columns that do not exist, so each threw
 * 42703 at runtime:
 *
 *  1. `POST /quality/test-runs` writes company_id, title, status, project_id,
 *     notes, template_id, created_by, customer_witness, customer_witness_date
 *     and site_location. `test_runs` had none of them — it was built for shop-
 *     floor runs (run_number / overall_result / executed_by) and later reused
 *     for witnessed FAT/SAT runs without ever being extended. Both shapes are
 *     legitimate, so the witness/document columns are added alongside rather
 *     than renaming the shop-floor ones out from under the existing readers.
 *
 *  2. `PATCH /quality/ncr/:id/resolve` writes `resolution` and `resolved_at`.
 *     Resolving an NCR has therefore never worked.
 *
 *  3. CAPA rows are updated but `capa_actions` has no `updated_at`.
 *
 * `notifications.link` is added too: the CAPA-assignment notification writes it,
 * and a notification the user cannot click through to is only half a feature.
 * The other three columns in that INSERT are renames handled in the route.
 */

export async function up(knex) {
  // ── 1. test_runs: the witnessed-test shape ────────────────────────────────
  const testRunCols = [
    ['company_id',             'integer REFERENCES companies(id) ON DELETE SET NULL'],
    ['title',                  'text'],
    ['status',                 "varchar(30) NOT NULL DEFAULT 'planned'"],
    ['project_id',             'integer REFERENCES projects(id) ON DELETE SET NULL'],
    ['notes',                  'text'],
    ['template_id',            'integer'],
    ['created_by',             'integer'],
    ['customer_witness',       'text'],
    ['customer_witness_date',  'date'],
    ['site_location',          'text'],
    ['updated_at',             'timestamptz NOT NULL DEFAULT NOW()'],
    ['deleted_at',             'timestamptz'],
  ];
  for (const [name, type] of testRunCols) {
    await knex.raw(`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS ${name} ${type};`);
  }
  // Existing rows predate the split; carry the shop-floor result across so the
  // new status column is not uniformly 'planned' on historical data.
  await knex.raw(`
    UPDATE test_runs
       SET status = CASE
             WHEN completed_at IS NOT NULL THEN 'completed'
             WHEN started_at   IS NOT NULL THEN 'in_progress'
             ELSE 'planned' END
     WHERE status = 'planned';
  `);
  await knex.raw(`UPDATE test_runs SET title = COALESCE(title, product_name, run_number);`);
  const { rows } = await knex.raw(`SELECT id FROM companies`);
  if (rows.length === 1) {
    await knex.raw(`UPDATE test_runs SET company_id = ${rows[0].id} WHERE company_id IS NULL;`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_test_runs_company ON test_runs (company_id) WHERE deleted_at IS NULL;`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_test_runs_project ON test_runs (project_id) WHERE project_id IS NOT NULL;`);

  // ── 2. NCR resolution ─────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE ncr_reports ADD COLUMN IF NOT EXISTS resolution  text;`);
  await knex.raw(`ALTER TABLE ncr_reports ADD COLUMN IF NOT EXISTS resolved_at timestamptz;`);

  // ── 3. CAPA + notification click-through ──────────────────────────────────
  await knex.raw(`ALTER TABLE capa_actions   ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW();`);
  await knex.raw(`ALTER TABLE notifications  ADD COLUMN IF NOT EXISTS link       text;`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link text;`);
  await knex.raw(`ALTER TABLE notifications DROP COLUMN IF EXISTS link;`);
  await knex.raw(`ALTER TABLE capa_actions  DROP COLUMN IF EXISTS updated_at;`);
  await knex.raw(`ALTER TABLE ncr_reports   DROP COLUMN IF EXISTS resolved_at;`);
  await knex.raw(`ALTER TABLE ncr_reports   DROP COLUMN IF EXISTS resolution;`);
  for (const c of ['company_id','title','status','project_id','notes','template_id','created_by',
                   'customer_witness','customer_witness_date','site_location','updated_at','deleted_at']) {
    await knex.raw(`ALTER TABLE test_runs DROP COLUMN IF EXISTS ${c};`);
  }
}
