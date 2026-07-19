export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_crm_pa_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate/.test(err.message || '')) throw err;
    }
  };

  // ── crm_pipeline_stages ────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS crm_pipeline_stages (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id  INTEGER NOT NULL,
      name        VARCHAR(100) NOT NULL,
      stage_key   VARCHAR(50) NOT NULL,
      sort_order  INTEGER DEFAULT 0,
      color       VARCHAR(20) DEFAULT '#6B7280',
      probability INTEGER DEFAULT 0,
      is_won      BOOLEAN DEFAULT false,
      is_lost     BOOLEAN DEFAULT false,
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, stage_key)
    )
  `);

  // ── crm_lead_scoring_rules ────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS crm_lead_scoring_rules (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id  INTEGER NOT NULL,
      field       VARCHAR(100) NOT NULL,
      operator    VARCHAR(30) DEFAULT 'equals',
      value       VARCHAR(255),
      score_delta INTEGER NOT NULL DEFAULT 0,
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── crm_assignment_rules ──────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS crm_assignment_rules (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id        INTEGER NOT NULL,
      name              VARCHAR(255),
      condition_field   VARCHAR(100),
      condition_value   VARCHAR(255),
      assign_to_name    VARCHAR(255),
      priority          INTEGER DEFAULT 0,
      is_active         BOOLEAN DEFAULT true,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── crm_win_loss_reasons ──────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS crm_win_loss_reasons (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id  INTEGER NOT NULL,
      type        VARCHAR(10) NOT NULL CHECK (type IN ('win','loss')),
      reason      VARCHAR(255) NOT NULL,
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_id, type, reason)
    )
  `);

  // ── crm_settings ─────────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS crm_settings (
      id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id                  INTEGER NOT NULL UNIQUE,
      default_currency            VARCHAR(10) DEFAULT 'INR',
      fiscal_year_start_month     INTEGER DEFAULT 4,
      lead_auto_assign            BOOLEAN DEFAULT false,
      lead_scoring_enabled        BOOLEAN DEFAULT true,
      deal_probability_auto_update BOOLEAN DEFAULT true,
      email_open_tracking         BOOLEAN DEFAULT false,
      duplicate_detection_leads   BOOLEAN DEFAULT true,
      duplicate_detection_contacts BOOLEAN DEFAULT true,
      duplicate_detection_accounts BOOLEAN DEFAULT true,
      updated_at                  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Seed default pipeline stages for all existing companies ───────────────
  await safe(`
    INSERT INTO crm_pipeline_stages
      (company_id, name, stage_key, sort_order, color, probability, is_won, is_lost)
    SELECT
      c.id, s.name, s.stage_key, s.sort_order, s.color, s.probability, s.is_won, s.is_lost
    FROM companies c
    CROSS JOIN (VALUES
      ('Prospecting',   'prospecting',   1, '#5B6CF6', 10,  false, false),
      ('Qualification', 'qualification', 2, '#2563EB', 25,  false, false),
      ('Proposal',      'proposal',      3, '#D97706', 50,  false, false),
      ('Negotiation',   'negotiation',   4, '#DC2626', 75,  false, false),
      ('Won',           'won',           5, '#059669', 100, true,  false),
      ('Lost',          'lost',          6, '#6B7280', 0,   false, true)
    ) AS s(name, stage_key, sort_order, color, probability, is_won, is_lost)
    ON CONFLICT (company_id, stage_key) DO NOTHING
  `);

  // ── Seed default win/loss reasons for all existing companies ─────────────
  await safe(`
    INSERT INTO crm_win_loss_reasons (company_id, type, reason)
    SELECT c.id, r.type, r.reason
    FROM companies c
    CROSS JOIN (VALUES
      ('win',  'Best Price'),
      ('win',  'Feature Set'),
      ('win',  'Strong Relationship'),
      ('win',  'Better Support'),
      ('win',  'Brand Trust'),
      ('loss', 'Budget Constraints'),
      ('loss', 'Chose Competitor'),
      ('loss', 'No Decision'),
      ('loss', 'Poor Timing'),
      ('loss', 'Feature Gap')
    ) AS r(type, reason)
    ON CONFLICT (company_id, type, reason) DO NOTHING
  `);

  // ── Seed default lead scoring rules for all existing companies ────────────
  await safe(`
    INSERT INTO crm_lead_scoring_rules (company_id, field, operator, value, score_delta)
    SELECT c.id, r.field, r.operator, r.value, r.score_delta
    FROM companies c
    CROSS JOIN (VALUES
      ('source',   'equals',   'Referral',    20),
      ('source',   'equals',   'Website',     10),
      ('source',   'equals',   'Cold Call',   5),
      ('industry', 'equals',   'Technology',  15),
      ('industry', 'equals',   'Manufacturing', 10),
      ('email',    'is_set',   NULL,          5),
      ('phone',    'is_set',   NULL,          5)
    ) AS r(field, operator, value, score_delta)
  `);

  // ── Add company_id to email_sequences if missing ──────────────────────────
  await safe(`ALTER TABLE email_sequences ADD COLUMN IF NOT EXISTS company_id INTEGER`);
  await safe(`ALTER TABLE email_sequences ADD COLUMN IF NOT EXISTS trigger VARCHAR(100)`);
  await safe(`ALTER TABLE email_sequences ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
}

export async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS crm_lead_scoring_rules');
  await knex.raw('DROP TABLE IF EXISTS crm_assignment_rules');
  await knex.raw('DROP TABLE IF EXISTS crm_win_loss_reasons');
  await knex.raw('DROP TABLE IF EXISTS crm_settings');
  await knex.raw('DROP TABLE IF EXISTS crm_pipeline_stages');
}
