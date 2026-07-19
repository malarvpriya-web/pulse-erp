export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_mktgs_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS notify_new_lead BOOLEAN DEFAULT false`);
  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS notify_campaign_end BOOLEAN DEFAULT false`);
  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS notify_budget_alert BOOLEAN DEFAULT false`);
  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS default_owner_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`);
  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS auto_close_days INTEGER DEFAULT 90`);
  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS lead_expiry_days INTEGER DEFAULT 30`);
  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'INR'`);
  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS campaign_prefix VARCHAR(20) DEFAULT 'CAMP'`);
  await safe(`ALTER TABLE marketing_settings ADD COLUMN IF NOT EXISTS campaign_next INTEGER DEFAULT 1001`);
}

export async function down(knex) {
  for (const col of [
    'notify_new_lead', 'notify_campaign_end', 'notify_budget_alert',
    'default_owner_id', 'auto_close_days', 'lead_expiry_days',
    'currency', 'campaign_prefix', 'campaign_next',
  ]) {
    await knex.raw(`ALTER TABLE marketing_settings DROP COLUMN IF EXISTS ${col}`);
  }
}
