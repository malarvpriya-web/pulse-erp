export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_leads_hrd_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate/i.test(err.message || '')) throw err;
    }
  };

  // ── 1. Add lead_score column (missing from original schema) ──────────────────
  await safe(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_score INTEGER DEFAULT 0`);

  // ── 2. Backfill company_id on leads that are missing it ──────────────────────
  //    Path: leads.created_by → users.id → user_scope (is_primary) → company_id
  await safe(`
    UPDATE leads l
    SET company_id = us.company_id
    FROM users u
    JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
    WHERE l.created_by = u.id
      AND l.company_id IS NULL
      AND l.deleted_at IS NULL
  `);

  // ── 3. Delete duplicate and test data for Manifest Technologies ───────────────
  await safe(`
    DELETE FROM leads
    WHERE company_id = (
      SELECT id FROM companies WHERE LOWER(name) = 'manifest technologies' LIMIT 1
    )
    AND (
      company_name ILIKE '%DB Test%'
      OR company_name ILIKE '%test%'
      OR lead_score = 0 AND company_name ILIKE '%DB%'
    )
    AND deleted_at IS NULL
  `);

  // ── 4. Remove true duplicates (same company_id + email, keep the oldest) ─────
  await safe(`
    DELETE FROM leads
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY company_id, email ORDER BY created_at ASC) AS rn
        FROM leads
        WHERE email IS NOT NULL AND email != '' AND company_id IS NOT NULL AND deleted_at IS NULL
      ) ranked
      WHERE rn > 1
    )
  `);

  // ── 5. Unique constraint: one email per company (non-null emails only) ────────
  await safe(`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_company_email_unique
    ON leads(company_id, email)
    WHERE email IS NOT NULL AND email != '' AND deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS leads_company_email_unique`);
}
