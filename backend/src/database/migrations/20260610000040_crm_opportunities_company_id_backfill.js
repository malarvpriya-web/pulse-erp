export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_opp_cid_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  // Ensure column exists (idempotent)
  await safe(`ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS company_id INTEGER`);

  // Backfill from the linked lead's company_id
  await safe(`
    UPDATE opportunities o
    SET company_id = l.company_id
    FROM leads l
    WHERE o.lead_id = l.id
      AND o.company_id IS NULL
      AND l.company_id IS NOT NULL
      AND o.deleted_at IS NULL
  `);

  // Backfill remaining nulls via the assigned employee's primary company scope
  await safe(`
    UPDATE opportunities o
    SET company_id = us.company_id
    FROM users u
    JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
    WHERE o.created_by = u.id::text::uuid
      AND o.company_id IS NULL
      AND o.deleted_at IS NULL
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_opportunities_company_stage_created
    ON opportunities(company_id, stage, created_at DESC)
    WHERE deleted_at IS NULL`);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_opportunities_company_stage_created`);
}
