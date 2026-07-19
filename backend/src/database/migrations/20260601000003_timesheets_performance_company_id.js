/**
 * Phase 46 Fix — Add company_id to timesheet_entries, performance_reviews,
 * training records, and marketing campaign tables.
 */
export async function up(knex) {
  let sp = 0;
  const tryAlter = async (sql) => {
    const name = `sp_misc_cid_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (err.message && err.message.includes('does not exist')) {
        console.warn(`[misc-cid] Skipped — ${err.message.split('\n')[0]}`);
      } else {
        throw err;
      }
    }
  };

  // Timesheets
  await tryAlter(`ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Performance
  await tryAlter(`ALTER TABLE performance_reviews ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE goals               ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Training
  await tryAlter(`ALTER TABLE training_programs   ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE training_enrollments ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Succession
  await tryAlter(`ALTER TABLE succession_plans    ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Marketing
  await tryAlter(`ALTER TABLE campaigns           ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await tryAlter(`ALTER TABLE campaign_leads      ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Reports saved
  await tryAlter(`ALTER TABLE saved_reports       ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Indexes
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_ts_company_id   ON timesheet_entries(company_id)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_pr_company_id   ON performance_reviews(company_id)`);
  await tryAlter(`CREATE INDEX IF NOT EXISTS idx_camp_company_id ON campaigns(company_id)`);
}

export async function down(knex) {
  const drop = async (table, col) => {
    await knex.schema.table(table, t => t.dropColumn(col)).catch(() => {});
  };
  await drop('timesheet_entries', 'company_id');
  await drop('performance_reviews', 'company_id');
  await drop('goals', 'company_id');
  await drop('training_programs', 'company_id');
  await drop('training_enrollments', 'company_id');
  await drop('succession_plans', 'company_id');
  await drop('campaigns', 'company_id');
  await drop('campaign_leads', 'company_id');
  await drop('saved_reports', 'company_id');
}
