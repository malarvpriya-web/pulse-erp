export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_p51_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|multiple primary/i.test(err.message || '')) throw err;
    }
  };

  // ── CUSTOMER PORTAL USERS ─────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS customer_portal_users (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER NOT NULL,
      customer_name   VARCHAR(255) NOT NULL,
      contact_person  VARCHAR(255),
      email           VARCHAR(255) NOT NULL,
      phone           VARCHAR(50),
      password_hash   TEXT NOT NULL,
      crm_account_id  INTEGER,
      project_ids     INTEGER[] DEFAULT '{}',
      is_active       BOOLEAN DEFAULT true,
      last_login      TIMESTAMPTZ,
      reset_token     TEXT,
      reset_expires   TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE UNIQUE INDEX IF NOT EXISTS ux_portal_users_email_company ON customer_portal_users(email, company_id)`);

  // ── CUSTOMER EQUIPMENT ────────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS customer_equipment (
      id                      SERIAL PRIMARY KEY,
      company_id              INTEGER NOT NULL,
      customer_portal_user_id INTEGER REFERENCES customer_portal_users(id) ON DELETE SET NULL,
      crm_account_id          INTEGER,
      project_id              INTEGER,
      equipment_tag           VARCHAR(100),
      equipment_name          VARCHAR(255) NOT NULL,
      model_number            VARCHAR(100),
      serial_number           VARCHAR(100),
      rating                  VARCHAR(100),
      installation_date       DATE,
      site_location           TEXT,
      gps_lat                 NUMERIC(10,7),
      gps_lng                 NUMERIC(10,7),
      warranty_status         VARCHAR(30) DEFAULT 'active',
      warranty_expiry         DATE,
      amc_status              VARCHAR(30) DEFAULT 'none',
      amc_contract_id         INTEGER,
      last_service_date       DATE,
      next_service_date       DATE,
      status                  VARCHAR(30) DEFAULT 'operational',
      notes                   TEXT,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_customer_equipment_company ON customer_equipment(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_customer_equipment_portal_user ON customer_equipment(customer_portal_user_id)`);

  // ── CUSTOMER PORTAL TICKETS ───────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS customer_portal_tickets (
      id                      SERIAL PRIMARY KEY,
      company_id              INTEGER NOT NULL,
      ticket_number           VARCHAR(30) UNIQUE,
      customer_portal_user_id INTEGER REFERENCES customer_portal_users(id),
      equipment_id            INTEGER REFERENCES customer_equipment(id),
      subject                 TEXT NOT NULL,
      description             TEXT,
      priority                VARCHAR(20) DEFAULT 'medium',
      status                  VARCHAR(30) DEFAULT 'open',
      category                VARCHAR(50),
      assigned_engineer_id    INTEGER,
      assigned_engineer_name  VARCHAR(255),
      internal_ticket_id      INTEGER,
      resolved_at             TIMESTAMPTZ,
      resolution_notes        TEXT,
      customer_rating         INTEGER CHECK(customer_rating BETWEEN 1 AND 5),
      customer_feedback       TEXT,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_cpt_company ON customer_portal_tickets(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_cpt_user ON customer_portal_tickets(customer_portal_user_id)`);

  // ── CUSTOMER PORTAL UPLOADS ───────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS customer_portal_uploads (
      id           SERIAL PRIMARY KEY,
      ticket_id    INTEGER REFERENCES customer_portal_tickets(id) ON DELETE CASCADE,
      company_id   INTEGER,
      filename     TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      file_type    VARCHAR(50),
      file_size    INTEGER,
      uploaded_by  VARCHAR(255),
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── CUSTOMER PORTAL DOCUMENTS ─────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS customer_portal_documents (
      id                      SERIAL PRIMARY KEY,
      company_id              INTEGER NOT NULL,
      customer_portal_user_id INTEGER REFERENCES customer_portal_users(id),
      equipment_id            INTEGER REFERENCES customer_equipment(id),
      document_type           VARCHAR(50),
      document_name           VARCHAR(255) NOT NULL,
      file_path               TEXT,
      external_url            TEXT,
      is_visible              BOOLEAN DEFAULT true,
      created_at              TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── COMMISSIONING WORKFLOWS ───────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS commissioning_workflows (
      id                    SERIAL PRIMARY KEY,
      company_id            INTEGER NOT NULL,
      workflow_number       VARCHAR(30) UNIQUE,
      project_id            INTEGER,
      equipment_id          INTEGER REFERENCES customer_equipment(id),
      customer_name         VARCHAR(255),
      site_name             TEXT,
      site_address          TEXT,
      engineer_id           INTEGER,
      engineer_name         VARCHAR(255),
      status                VARCHAR(30) DEFAULT 'pending',
      checkin_time          TIMESTAMPTZ,
      checkin_lat           NUMERIC(10,7),
      checkin_lng           NUMERIC(10,7),
      checkin_address       TEXT,
      checkout_time         TIMESTAMPTZ,
      fat_reference         VARCHAR(100),
      sat_reference         VARCHAR(100),
      scheduled_date        DATE,
      completed_date        DATE,
      customer_sign_name    VARCHAR(255),
      customer_sign_data    TEXT,
      customer_sign_time    TIMESTAMPTZ,
      customer_feedback     TEXT,
      customer_rating       INTEGER CHECK(customer_rating BETWEEN 1 AND 5),
      certificate_number    VARCHAR(50),
      certificate_issued    BOOLEAN DEFAULT false,
      certificate_issued_at TIMESTAMPTZ,
      warranty_activated    BOOLEAN DEFAULT false,
      warranty_activated_at TIMESTAMPTZ,
      amc_eligible          BOOLEAN DEFAULT false,
      notes                 TEXT,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_comm_wf_company ON commissioning_workflows(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_comm_wf_engineer ON commissioning_workflows(engineer_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_comm_wf_project ON commissioning_workflows(project_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_comm_wf_status ON commissioning_workflows(company_id, status)`);

  // ── COMMISSIONING CHECKLIST ITEMS ─────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS commissioning_checklist_items (
      id           SERIAL PRIMARY KEY,
      company_id   INTEGER NOT NULL,
      workflow_id  INTEGER REFERENCES commissioning_workflows(id) ON DELETE CASCADE,
      category     VARCHAR(100),
      item_text    TEXT NOT NULL,
      is_completed BOOLEAN DEFAULT false,
      completed_by VARCHAR(255),
      completed_at TIMESTAMPTZ,
      remarks      TEXT,
      sort_order   INTEGER DEFAULT 0,
      is_mandatory BOOLEAN DEFAULT true,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── COMMISSIONING PARAMETER READINGS ──────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS commissioning_readings (
      id             SERIAL PRIMARY KEY,
      workflow_id    INTEGER REFERENCES commissioning_workflows(id) ON DELETE CASCADE,
      company_id     INTEGER,
      parameter      VARCHAR(100) NOT NULL,
      unit           VARCHAR(30),
      set_value      VARCHAR(50),
      measured_value VARCHAR(50),
      status         VARCHAR(20) DEFAULT 'ok',
      notes          TEXT,
      recorded_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── COMMISSIONING PHOTOS ──────────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS commissioning_photos (
      id          SERIAL PRIMARY KEY,
      workflow_id INTEGER REFERENCES commissioning_workflows(id) ON DELETE CASCADE,
      company_id  INTEGER,
      caption     TEXT,
      file_path   TEXT NOT NULL,
      phase       VARCHAR(50),
      uploaded_by VARCHAR(255),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── COMMISSIONING CHECKLIST TEMPLATES ────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS commissioning_checklist_templates (
      id         SERIAL PRIMARY KEY,
      company_id INTEGER NOT NULL,
      name       VARCHAR(255) NOT NULL,
      category   VARCHAR(100),
      items      JSONB DEFAULT '[]',
      is_default BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── SERVICE FAILURE ANALYTICS ─────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS service_failure_records (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER NOT NULL,
      ticket_id           INTEGER,
      equipment_id        INTEGER REFERENCES customer_equipment(id),
      customer_name       VARCHAR(255),
      zone                VARCHAR(100),
      product_name        VARCHAR(255),
      model_number        VARCHAR(100),
      fault_code          VARCHAR(50),
      fault_description   TEXT,
      root_cause          TEXT,
      root_cause_category VARCHAR(100),
      component_failed    VARCHAR(255),
      vendor_component    VARCHAR(255),
      resolution          TEXT,
      resolution_time_hrs NUMERIC(6,2),
      is_repeat_failure   BOOLEAN DEFAULT false,
      repeat_failure_ref  INTEGER,
      engineer_id         INTEGER,
      engineer_name       VARCHAR(255),
      failure_date        DATE,
      resolved_date       DATE,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_sfr_company ON service_failure_records(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_sfr_zone ON service_failure_records(company_id, zone)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_sfr_product ON service_failure_records(company_id, product_name)`);

  // ── VOICE OF CUSTOMER (VOC) ───────────────────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS voc_surveys (
      id            SERIAL PRIMARY KEY,
      company_id    INTEGER NOT NULL,
      name          VARCHAR(255) NOT NULL,
      trigger_event VARCHAR(50) DEFAULT 'service_visit',
      questions     JSONB DEFAULT '[]',
      is_active     BOOLEAN DEFAULT true,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await safe(`
    CREATE TABLE IF NOT EXISTS voc_responses (
      id                   SERIAL PRIMARY KEY,
      company_id           INTEGER NOT NULL,
      survey_id            INTEGER REFERENCES voc_surveys(id),
      trigger_event        VARCHAR(50),
      trigger_ref_id       INTEGER,
      customer_name        VARCHAR(255),
      customer_email       VARCHAR(255),
      project_id           INTEGER,
      ticket_id            INTEGER,
      commissioning_id     INTEGER,
      rating               INTEGER CHECK(rating BETWEEN 1 AND 10),
      nps_score            INTEGER CHECK(nps_score BETWEEN 0 AND 10),
      category             VARCHAR(50),
      sentiment            VARCHAR(20),
      response_data        JSONB DEFAULT '{}',
      suggestions          TEXT,
      improvement_ideas    TEXT,
      new_feature_requests TEXT,
      classification       VARCHAR(50),
      is_actioned          BOOLEAN DEFAULT false,
      actioned_by          VARCHAR(255),
      actioned_at          TIMESTAMPTZ,
      submitted_at         TIMESTAMPTZ DEFAULT NOW(),
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS idx_voc_responses_company ON voc_responses(company_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_voc_responses_event ON voc_responses(company_id, trigger_event)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_voc_nps ON voc_responses(company_id, nps_score)`);

  // ── RECRUITMENT AUTO-EMPLOYEE CREATION LOG ────────────────────────────────────
  await safe(`
    CREATE TABLE IF NOT EXISTS recruitment_employee_creation_log (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER NOT NULL,
      candidate_id    INTEGER NOT NULL,
      candidate_name  VARCHAR(255),
      job_opening_id  INTEGER,
      job_title       VARCHAR(255),
      employee_id     INTEGER,
      employee_code   VARCHAR(50),
      status          VARCHAR(30) DEFAULT 'pending',
      triggered_by    INTEGER,
      triggered_at    TIMESTAMPTZ DEFAULT NOW(),
      completed_at    TIMESTAMPTZ,
      error_log       TEXT,
      checklist_items JSONB DEFAULT '[]'
    )
  `);

  // ── ENHANCE SERVICE_ENGINEERS TABLE ──────────────────────────────────────────
  await safe(`ALTER TABLE service_engineers ADD COLUMN IF NOT EXISTS employee_id  INTEGER`);
  await safe(`ALTER TABLE service_engineers ADD COLUMN IF NOT EXISTS avg_rating   NUMERIC(3,2) DEFAULT 0`);
  await safe(`ALTER TABLE service_engineers ADD COLUMN IF NOT EXISTS total_tickets INTEGER DEFAULT 0`);
}

export async function down(knex) {
  const tables = [
    'recruitment_employee_creation_log',
    'voc_responses', 'voc_surveys',
    'service_failure_records',
    'commissioning_photos', 'commissioning_readings',
    'commissioning_checklist_items', 'commissioning_checklist_templates',
    'commissioning_workflows',
    'customer_portal_documents', 'customer_portal_uploads',
    'customer_portal_tickets', 'customer_equipment',
    'customer_portal_users',
  ];
  for (const t of tables) {
    await knex.raw(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
}
