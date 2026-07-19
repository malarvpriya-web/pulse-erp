/**
 * 20260621000003_engineering_company_id_certify.js
 *
 * Certifies that every engineering table has company_id.
 * Idempotent — safe to run even if 20260618000002 already ran.
 * Also ensures power_quality_logs exists with company_id.
 */

export async function up(knex) {
  const safe = async (label, sql) => {
    const sp = `sp_engcid_${label.replace(/\W/g, '_').slice(0, 40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[engineering_company_id_certify] skipped (${label}): ${e.message.split('\n')[0]}`);
    }
  };

  // ── Core engineering tables ────────────────────────────────────────────────
  const engTables = [
    'eng_rd_projects',
    'eng_design_phases',
    'eng_prototypes',
    'eng_test_plans',
  ];

  for (const t of engTables) {
    await safe(`${t}_add_company_id`, `
      ALTER TABLE ${t}
        ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
    `);
    await safe(`${t}_backfill`, `
      UPDATE ${t}
      SET company_id = (SELECT id FROM companies WHERE name = 'Manifest Technologies' LIMIT 1)
      WHERE company_id IS NULL
    `);
    await safe(`idx_${t}_company`, `
      CREATE INDEX IF NOT EXISTS idx_${t}_company ON ${t}(company_id)
    `);
  }

  // ── power_quality_logs ─────────────────────────────────────────────────────
  await safe('pql_create', `
    CREATE TABLE IF NOT EXISTS power_quality_logs (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      reading_date DATE NOT NULL DEFAULT CURRENT_DATE,
      reading_time TIME,
      voltage      NUMERIC(8,2),
      current_amps NUMERIC(8,2),
      power_factor NUMERIC(5,3),
      frequency    NUMERIC(6,2),
      thd_pct      NUMERIC(5,2),
      location     VARCHAR(255),
      equipment    VARCHAR(255),
      notes        TEXT,
      logged_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe('pql_add_company_id', `
    ALTER TABLE power_quality_logs
      ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
  `);
  await safe('pql_backfill', `
    UPDATE power_quality_logs
    SET company_id = (SELECT id FROM companies WHERE name = 'Manifest Technologies' LIMIT 1)
    WHERE company_id IS NULL
  `);
  await safe('idx_pql_company', `
    CREATE INDEX IF NOT EXISTS idx_power_quality_logs_company ON power_quality_logs(company_id)
  `);

  console.log('[migration 20260621000003] engineering_company_id_certify applied.');
}

export async function down(knex) {
  // Destructive — left intentionally empty.
}
