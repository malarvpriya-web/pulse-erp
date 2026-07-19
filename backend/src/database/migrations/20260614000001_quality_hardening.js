/**
 * 20260614000001_quality_hardening.js
 *
 * Quality Management Full Hardening — Audit Remediation
 *
 * Changes:
 *  1. Unified NCR: add grn_id, vendor_id, project_id, source, containment_action,
 *     approver_id, approved_at, approved_by_name to ncr_reports
 *  2. Complaints: add ncr_id FK for Complaint→NCR chain
 *  3. CAPA: add employee_id, verifier_id, verified_at, verified_by_name, company_id
 *  4. test_runs: add customer_witness, customer_witness_date, customer_accepted,
 *     site_location, project_id, dispatch_blocked
 *  5. New table: punch_points (FAT punch list)
 *  6. New table: calibration_equipment (ISO 9001 §7.1.5)
 *  7. New table: calibration_records
 *  8. New table: quality_settings
 *  9. New table: supplier_quality_snapshots
 * 10. Indexes for all new FKs
 */

export async function up(knex) {
  const safe = async (label, fn) => {
    const sp = `sp_qh_${label.replace(/\W/g,'_').slice(0,40)}`;
    await knex.raw(`SAVEPOINT ${sp}`);
    try { await fn(); }
    catch (e) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${sp}`);
      console.warn(`[quality_hardening] skipped (${label}): ${e.message}`);
    } finally {
      await knex.raw(`RELEASE SAVEPOINT ${sp}`);
    }
  };

  // ── 1. Unified NCR (ncr_reports) ─────────────────────────────────────────
  await safe('ncr_grn_id',           () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN grn_id INTEGER REFERENCES goods_receipt_notes(id) ON DELETE SET NULL`));
  await safe('ncr_vendor_id',        () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL`));
  await safe('ncr_project_id',       () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN project_id INTEGER`));
  await safe('ncr_source',           () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN source VARCHAR(30) DEFAULT 'quality'`));
  await safe('ncr_containment',      () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN containment_action TEXT`));
  await safe('ncr_approver_id',      () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN approver_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`));
  await safe('ncr_approved_at',      () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN approved_at TIMESTAMPTZ`));
  await safe('ncr_approved_by_name', () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN approved_by_name VARCHAR(150)`));
  await safe('ncr_company_id',       () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`));
  await safe('ncr_type',             () => knex.raw(`ALTER TABLE ncr_reports ADD COLUMN type VARCHAR(50) DEFAULT 'general'`));
  await safe('idx_ncr_vendor',       () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_ncr_reports_vendor ON ncr_reports(vendor_id)`));
  await safe('idx_ncr_grn',          () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_ncr_reports_grn ON ncr_reports(grn_id)`));
  await safe('idx_ncr_project',      () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_ncr_reports_project ON ncr_reports(project_id)`));
  await safe('idx_ncr_source',       () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_ncr_reports_source ON ncr_reports(source)`));

  // ── 2. Complaints → NCR linkage ──────────────────────────────────────────
  await safe('complaints_ncr_id',    () => knex.raw(`ALTER TABLE complaints ADD COLUMN ncr_id INTEGER REFERENCES ncr_reports(id) ON DELETE SET NULL`));
  await safe('complaints_root_cause',() => knex.raw(`ALTER TABLE complaints ADD COLUMN root_cause TEXT`));
  await safe('complaints_rca_method',() => knex.raw(`ALTER TABLE complaints ADD COLUMN rca_method VARCHAR(30) DEFAULT '5-why'`));
  await safe('idx_complaints_ncr',   () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_complaints_ncr_id ON complaints(ncr_id)`));

  // ── 3. CAPA improvements ─────────────────────────────────────────────────
  await safe('capa_emp_id',          () => knex.raw(`ALTER TABLE capa_actions ADD COLUMN employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`));
  await safe('capa_verifier_id',     () => knex.raw(`ALTER TABLE capa_actions ADD COLUMN verifier_id INTEGER REFERENCES employees(id) ON DELETE SET NULL`));
  await safe('capa_verified_at',     () => knex.raw(`ALTER TABLE capa_actions ADD COLUMN verified_at TIMESTAMPTZ`));
  await safe('capa_verified_by',     () => knex.raw(`ALTER TABLE capa_actions ADD COLUMN verified_by_name VARCHAR(150)`));
  await safe('capa_company_id',      () => knex.raw(`ALTER TABLE capa_actions ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL`));
  await safe('capa_recurrence',      () => knex.raw(`ALTER TABLE capa_actions ADD COLUMN recurrence_count INTEGER DEFAULT 0`));
  await safe('idx_capa_emp',         () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_capa_employee ON capa_actions(employee_id)`));
  await safe('idx_capa_company',     () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_capa_company ON capa_actions(company_id)`));

  // ── 4. test_runs improvements (FAT/SAT) ──────────────────────────────────
  await safe('tr_customer_witness',  () => knex.raw(`ALTER TABLE test_runs ADD COLUMN customer_witness VARCHAR(200)`));
  await safe('tr_witness_date',      () => knex.raw(`ALTER TABLE test_runs ADD COLUMN customer_witness_date DATE`));
  await safe('tr_customer_accepted', () => knex.raw(`ALTER TABLE test_runs ADD COLUMN customer_accepted BOOLEAN DEFAULT FALSE`));
  await safe('tr_customer_accepted_at',()=> knex.raw(`ALTER TABLE test_runs ADD COLUMN customer_accepted_at TIMESTAMPTZ`));
  await safe('tr_site_location',     () => knex.raw(`ALTER TABLE test_runs ADD COLUMN site_location VARCHAR(300)`));
  await safe('tr_project_id',        () => knex.raw(`ALTER TABLE test_runs ADD COLUMN project_id INTEGER`));
  await safe('tr_dispatch_blocked',  () => knex.raw(`ALTER TABLE test_runs ADD COLUMN dispatch_blocked BOOLEAN DEFAULT FALSE`));
  await safe('tr_template_id',       () => knex.raw(`ALTER TABLE test_runs ADD COLUMN template_id INTEGER`));
  await safe('tr_ncr_id',            () => knex.raw(`ALTER TABLE test_runs ADD COLUMN ncr_id INTEGER REFERENCES ncr_reports(id) ON DELETE SET NULL`));
  await safe('idx_tr_project',       () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_test_runs_project ON test_runs(project_id)`));

  // ── 5. punch_points (FAT punch list) ─────────────────────────────────────
  await safe('punch_points', () => knex.raw(`
    CREATE TABLE IF NOT EXISTS punch_points (
      id               SERIAL PRIMARY KEY,
      test_run_id      INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
      company_id       INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      description      TEXT NOT NULL,
      raised_by        VARCHAR(150),
      assigned_to      VARCHAR(150),
      assigned_to_id   INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      severity         VARCHAR(20) DEFAULT 'minor' CHECK (severity IN ('minor','major','critical')),
      status           VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','in_progress','closed','waived')),
      due_date         DATE,
      closed_at        TIMESTAMPTZ,
      closed_by        VARCHAR(150),
      remarks          TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `));
  await safe('idx_punch_run',        () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_punch_points_run ON punch_points(test_run_id)`));

  // ── 6. calibration_equipment (ISO 9001 §7.1.5) ───────────────────────────
  await safe('calibration_equipment', () => knex.raw(`
    CREATE TABLE IF NOT EXISTS calibration_equipment (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      equipment_id      VARCHAR(50) NOT NULL,
      name              VARCHAR(200) NOT NULL,
      description       TEXT,
      make              VARCHAR(100),
      model             VARCHAR(100),
      serial_number     VARCHAR(100),
      location          VARCHAR(200),
      department        VARCHAR(100),
      category          VARCHAR(100) DEFAULT 'General',
      range_min         NUMERIC(18,4),
      range_max         NUMERIC(18,4),
      unit              VARCHAR(30),
      accuracy_class    VARCHAR(50),
      calibration_frequency_days INTEGER DEFAULT 365,
      last_calibration_date DATE,
      next_calibration_date DATE,
      certificate_number VARCHAR(100),
      status            VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','expired','out_of_service','scrapped')),
      calibration_status VARCHAR(20) DEFAULT 'due' CHECK (calibration_status IN ('calibrated','due','overdue','expired')),
      owner_name        VARCHAR(150),
      owner_id          INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      notes             TEXT,
      deleted_at        TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `));
  await safe('idx_cal_eq_company',   () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_cal_equip_company ON calibration_equipment(company_id)`));
  await safe('idx_cal_eq_status',    () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_cal_equip_status ON calibration_equipment(calibration_status)`));
  await safe('idx_cal_eq_next_date', () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_cal_equip_next_date ON calibration_equipment(next_calibration_date)`));

  // ── 7. calibration_records ───────────────────────────────────────────────
  await safe('calibration_records', () => knex.raw(`
    CREATE TABLE IF NOT EXISTS calibration_records (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      equipment_id        INTEGER NOT NULL REFERENCES calibration_equipment(id) ON DELETE CASCADE,
      calibration_date    DATE NOT NULL DEFAULT CURRENT_DATE,
      next_due_date       DATE,
      performed_by        VARCHAR(200),
      performed_by_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      calibrating_lab     VARCHAR(200),
      certificate_number  VARCHAR(100),
      certificate_url     TEXT,
      standard_used       VARCHAR(200),
      traceability        TEXT,
      result              VARCHAR(20) DEFAULT 'pass' CHECK (result IN ('pass','fail','conditional')),
      as_found_condition  TEXT,
      as_left_condition   TEXT,
      remarks             TEXT,
      approved_by         VARCHAR(150),
      approved_by_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      approved_at         TIMESTAMPTZ,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `));
  await safe('idx_cal_rec_equip',    () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_cal_records_equip ON calibration_records(equipment_id)`));
  await safe('idx_cal_rec_date',     () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_cal_records_date ON calibration_records(calibration_date)`));

  // ── 8. quality_settings ──────────────────────────────────────────────────
  await safe('quality_settings', () => knex.raw(`
    CREATE TABLE IF NOT EXISTS quality_settings (
      id                         SERIAL PRIMARY KEY,
      company_id                 INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      require_iqc_before_stock   BOOLEAN DEFAULT TRUE,
      iqc_auto_ncr_on_fail       BOOLEAN DEFAULT TRUE,
      iqc_sampling_plan          VARCHAR(20) DEFAULT 'AQL2.5',
      ncr_auto_number_prefix     VARCHAR(10) DEFAULT 'NCR',
      ncr_approval_required      BOOLEAN DEFAULT TRUE,
      ncr_escalate_critical_mins INTEGER DEFAULT 60,
      ncr_containment_required   BOOLEAN DEFAULT TRUE,
      capa_default_due_days      INTEGER DEFAULT 14,
      capa_verification_required BOOLEAN DEFAULT TRUE,
      capa_auto_notify_assignee  BOOLEAN DEFAULT TRUE,
      capa_overdue_notify_days   INTEGER DEFAULT 2,
      calibration_alert_days     INTEGER DEFAULT 30,
      fat_customer_witness_req   BOOLEAN DEFAULT FALSE,
      fat_punch_point_closure_req BOOLEAN DEFAULT TRUE,
      fat_dispatch_gate          BOOLEAN DEFAULT TRUE,
      sat_customer_signoff_req   BOOLEAN DEFAULT TRUE,
      created_at                 TIMESTAMPTZ DEFAULT NOW(),
      updated_at                 TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (company_id)
    )
  `));

  // ── 9. supplier_quality_snapshots ────────────────────────────────────────
  await safe('supplier_quality_snapshots', () => knex.raw(`
    CREATE TABLE IF NOT EXISTS supplier_quality_snapshots (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      vendor_id       INTEGER REFERENCES vendors(id) ON DELETE CASCADE,
      snapshot_period VARCHAR(7) NOT NULL,
      total_received  NUMERIC(14,2) DEFAULT 0,
      total_rejected  NUMERIC(14,2) DEFAULT 0,
      ncr_count       INTEGER DEFAULT 0,
      critical_ncr    INTEGER DEFAULT 0,
      ppm             NUMERIC(10,2) DEFAULT 0,
      on_time_pct     NUMERIC(5,2) DEFAULT 0,
      quality_score   NUMERIC(5,2) DEFAULT 0,
      delivery_score  NUMERIC(5,2) DEFAULT 0,
      overall_score   NUMERIC(5,2) DEFAULT 0,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (company_id, vendor_id, snapshot_period)
    )
  `));
  await safe('idx_sqsnap_vendor',    () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_sqsnap_vendor ON supplier_quality_snapshots(vendor_id, snapshot_period DESC)`));

  // ── 10a. inspection_reports — add stage + overall_result ─────────────────
  await safe('insp_reports_stage',   () => knex.raw(`ALTER TABLE inspection_reports ADD COLUMN stage VARCHAR(10) DEFAULT 'IQC'`));
  await safe('insp_reports_overall', () => knex.raw(`ALTER TABLE inspection_reports ADD COLUMN overall_result VARCHAR(20)`));
  await safe('insp_reports_status2', () => knex.raw(`ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`));
  await safe('idx_insp_stage',       () => knex.raw(`CREATE INDEX IF NOT EXISTS idx_inspection_reports_stage ON inspection_reports(stage)`));

  // ── 10. fat_templates ────────────────────────────────────────────────────
  await safe('fat_templates', () => knex.raw(`
    CREATE TABLE IF NOT EXISTS fat_templates (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      name            VARCHAR(200) NOT NULL,
      product_type    VARCHAR(100),
      test_stage      VARCHAR(20) DEFAULT 'FAT' CHECK (test_stage IN ('FAT','SAT','IQC')),
      steps           JSONB DEFAULT '[]',
      is_active       BOOLEAN DEFAULT TRUE,
      created_by      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  console.log('[quality_hardening] migration complete');
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS fat_templates CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS supplier_quality_snapshots CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS quality_settings CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS calibration_records CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS calibration_equipment CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS punch_points CASCADE`);
}
