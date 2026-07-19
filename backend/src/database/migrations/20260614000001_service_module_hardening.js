/**
 * Service Module Industrial Hardening Migration
 * - company_id on spare_parts, maintenance_schedules, maintenance_logs
 * - Enriched columns on maintenance_logs (root_cause, failure_mode, resolution_notes, ticket_id, priority)
 * - Enriched columns on field_visits (parts_used, cost, completed_at, start_time_actual, end_time_actual, customer_signature, travel_km, serial_number, engineer_id)
 * - Enriched columns on support_tickets (closed_at, due_date, serial_number, customer_id, site_id, amc_contract_id, department)
 * - Enriched columns on amc_contracts (contract_value, billing_frequency, payment_terms, serial_number, next_renewal_date)
 * - Enriched columns on commissioning_reports (serial_number, customer_signature, witness_name, pdf_url)
 * - New tables: ticket_attachments, warranty_registrations, warranty_claims, spare_parts_movements, installation_reports
 * - Performance indexes
 */
export async function up(knex) {
  // ── spare_parts: add company_id + enriched columns ──────────────────────────
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS company_id       INTEGER`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS part_number      TEXT`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS supplier_name    TEXT`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS supplier_id      INTEGER`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS location         TEXT`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS barcode          TEXT`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS hsn_code         TEXT`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS lead_time_days   INTEGER DEFAULT 7`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS min_level        NUMERIC DEFAULT 0`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS max_level        NUMERIC DEFAULT 0`);
  await knex.raw(`ALTER TABLE spare_parts ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ DEFAULT NOW()`);

  // ── maintenance_schedules: add company_id ────────────────────────────────────
  await knex.raw(`ALTER TABLE maintenance_schedules ADD COLUMN IF NOT EXISTS company_id        INTEGER`);
  await knex.raw(`ALTER TABLE maintenance_schedules ADD COLUMN IF NOT EXISTS is_active         BOOLEAN DEFAULT TRUE`);
  await knex.raw(`ALTER TABLE maintenance_schedules ADD COLUMN IF NOT EXISTS standard_ref      TEXT`);

  // ── maintenance_logs: add company_id + RCA + ticket linkage ─────────────────
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS company_id        INTEGER`);
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS priority          TEXT DEFAULT 'Medium'`);
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS ticket_id         INTEGER`);
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS root_cause        TEXT`);
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS failure_mode      TEXT`);
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS resolution_notes  TEXT`);
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS corrective_action TEXT`);
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS preventive_action TEXT`);
  await knex.raw(`ALTER TABLE maintenance_logs ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ DEFAULT NOW()`);

  // ── field_visits: industrial enrichment ─────────────────────────────────────
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS engineer_id       INTEGER`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS serial_number     TEXT`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS ticket_id_int     INTEGER`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS amc_contract_id   INTEGER`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS visit_type        TEXT DEFAULT 'Service'`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS start_time_actual TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS end_time_actual   TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS work_done         TEXT`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS parts_used        JSONB DEFAULT '[]'`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS labour_hours      NUMERIC DEFAULT 0`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS travel_km         NUMERIC DEFAULT 0`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS cost              NUMERIC DEFAULT 0`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS customer_signature TEXT`);
  await knex.raw(`ALTER TABLE field_visits ADD COLUMN IF NOT EXISTS report_url        TEXT`);

  // ── support_tickets: additional service fields ───────────────────────────────
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS closed_at      TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS due_date       DATE`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS serial_number  TEXT`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS customer_id    INTEGER`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS site_id        INTEGER`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS amc_contract_id INTEGER`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS department     TEXT DEFAULT 'Service'`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_responded_at TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_breached   BOOLEAN DEFAULT FALSE`);
  await knex.raw(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS attachment_count INTEGER DEFAULT 0`);

  // ── amc_contracts: billing + serial enrichment ───────────────────────────────
  await knex.raw(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS contract_value     NUMERIC DEFAULT 0`);
  await knex.raw(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS billing_frequency  TEXT DEFAULT 'Annual'`);
  await knex.raw(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS payment_terms      TEXT DEFAULT 'Net 30'`);
  await knex.raw(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS serial_number      TEXT`);
  await knex.raw(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS next_renewal_date  DATE`);
  await knex.raw(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS renewal_count      INTEGER DEFAULT 0`);
  await knex.raw(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS last_invoice_date  DATE`);
  await knex.raw(`ALTER TABLE amc_contracts ADD COLUMN IF NOT EXISTS deleted_at         TIMESTAMPTZ`);

  // ── commissioning_reports: industrial sign-off fields ───────────────────────
  await knex.raw(`ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS serial_number       TEXT`);
  await knex.raw(`ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS customer_signature  TEXT`);
  await knex.raw(`ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS witness_name        TEXT`);
  await knex.raw(`ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS witness_signature   TEXT`);
  await knex.raw(`ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS pdf_url             TEXT`);
  await knex.raw(`ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS iec_standard        TEXT`);
  await knex.raw(`ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS ambient_temp_c      NUMERIC`);
  await knex.raw(`ALTER TABLE commissioning_reports ADD COLUMN IF NOT EXISTS test_voltage_kv     NUMERIC`);

  // ── ticket_attachments ───────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id           SERIAL PRIMARY KEY,
      ticket_id    INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type    TEXT,
      file_size    INTEGER,
      url          TEXT NOT NULL,
      uploaded_by  TEXT,
      company_id   INTEGER,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── warranty_registrations ──────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS warranty_registrations (
      id                SERIAL PRIMARY KEY,
      warranty_number   TEXT UNIQUE,
      asset_id          INTEGER REFERENCES assets_register(id),
      sales_order_id    INTEGER,
      lifecycle_instance_id INTEGER,
      serial_number     TEXT NOT NULL,
      product_name      TEXT NOT NULL,
      customer_name     TEXT NOT NULL,
      customer_id       INTEGER,
      site_id           INTEGER,
      warranty_start    DATE NOT NULL,
      warranty_end      DATE NOT NULL,
      warranty_type     TEXT DEFAULT 'Comprehensive',
      coverage_parts    BOOLEAN DEFAULT TRUE,
      coverage_labour   BOOLEAN DEFAULT TRUE,
      coverage_travel   BOOLEAN DEFAULT FALSE,
      status            TEXT DEFAULT 'Active',
      notes             TEXT,
      company_id        INTEGER,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── warranty_claims ──────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS warranty_claims (
      id                     SERIAL PRIMARY KEY,
      claim_number           TEXT UNIQUE,
      warranty_registration_id INTEGER REFERENCES warranty_registrations(id),
      ticket_id              INTEGER REFERENCES support_tickets(id),
      serial_number          TEXT,
      issue_description      TEXT NOT NULL,
      failure_mode           TEXT,
      parts_replaced         JSONB DEFAULT '[]',
      labour_hours           NUMERIC DEFAULT 0,
      claim_value            NUMERIC DEFAULT 0,
      status                 TEXT DEFAULT 'Open',
      resolution_notes       TEXT,
      approved_by            TEXT,
      approved_at            TIMESTAMPTZ,
      closed_at              TIMESTAMPTZ,
      company_id             INTEGER,
      created_at             TIMESTAMPTZ DEFAULT NOW(),
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── spare_parts_movements ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS spare_parts_movements (
      id              SERIAL PRIMARY KEY,
      part_id         INTEGER NOT NULL REFERENCES spare_parts(id),
      movement_type   TEXT NOT NULL CHECK (movement_type IN ('receipt','issue','return','adjustment','opening')),
      quantity        NUMERIC NOT NULL,
      reference_type  TEXT,
      reference_id    INTEGER,
      unit_cost       NUMERIC DEFAULT 0,
      total_cost      NUMERIC DEFAULT 0,
      stock_before    NUMERIC NOT NULL,
      stock_after     NUMERIC NOT NULL,
      remarks         TEXT,
      done_by         TEXT,
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── installation_reports ─────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS installation_reports (
      id                    SERIAL PRIMARY KEY,
      lifecycle_instance_id INTEGER,
      sales_order_id        INTEGER,
      serial_number         TEXT,
      site_name             TEXT NOT NULL,
      site_address          TEXT,
      installation_date     DATE NOT NULL,
      engineer_name         TEXT,
      customer_contact      TEXT,
      checklist             JSONB DEFAULT '[]',
      punch_points          JSONB DEFAULT '[]',
      customer_signature    TEXT,
      engineer_signature    TEXT,
      status                TEXT DEFAULT 'open',
      notes                 TEXT,
      company_id            INTEGER,
      created_at            TIMESTAMPTZ DEFAULT NOW(),
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── amc_renewal_history ──────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS amc_renewal_history (
      id              SERIAL PRIMARY KEY,
      amc_contract_id INTEGER NOT NULL,
      renewed_by      TEXT,
      old_end_date    DATE,
      new_end_date    DATE NOT NULL,
      new_value       NUMERIC DEFAULT 0,
      notes           TEXT,
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── service_notifications ────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS service_notifications (
      id              SERIAL PRIMARY KEY,
      notification_type TEXT NOT NULL,
      reference_type  TEXT,
      reference_id    INTEGER,
      title           TEXT NOT NULL,
      body            TEXT,
      severity        TEXT DEFAULT 'info',
      is_read         BOOLEAN DEFAULT FALSE,
      company_id      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── performance indexes ──────────────────────────────────────────────────────
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_spare_parts_company   ON spare_parts(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_maint_sched_company   ON maintenance_schedules(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_maint_sched_due       ON maintenance_schedules(next_due_date, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_maint_logs_company    ON maintenance_logs(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_maint_logs_asset      ON maintenance_logs(asset_id, log_type, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_attach_ticket  ON ticket_attachments(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_warranty_reg_serial   ON warranty_registrations(serial_number, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_warranty_reg_end      ON warranty_registrations(warranty_end, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_warranty_claims_status ON warranty_claims(status, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_spm_part_type         ON spare_parts_movements(part_id, movement_type)`,
    `CREATE INDEX IF NOT EXISTS idx_amc_renewal_date      ON amc_contracts(next_renewal_date, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_dept          ON support_tickets(department, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_serial        ON support_tickets(serial_number, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_field_visits_serial   ON field_visits(serial_number, company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_svc_notif_company     ON service_notifications(company_id, is_read, created_at DESC)`,
  ];

  for (const idx of indexes) {
    await knex.raw(idx).catch(() => {});
  }
}

export async function down(knex) {
  // Drop new tables only — column drops are destructive and omitted intentionally
  await knex.raw(`DROP TABLE IF EXISTS service_notifications CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS amc_renewal_history CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS installation_reports CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS spare_parts_movements CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS warranty_claims CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS warranty_registrations CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS ticket_attachments CASCADE`);
}
