/**
 * Supplier Development — the last stage of the supplier loop, and the only one
 * that was never an object.
 *
 * `sourcingStrategyEngine.js` has had a `supplier_development` strategy for some
 * time, with four methods (capability_build, quality_programme,
 * lead_time_project, capacity_reservation), each carrying a `signal` that says
 * when to reach for it and a `requires` that says what it costs. All of it is a
 * LABEL: a string the advisory panel renders. There is no plan, no owner, no
 * target, no review date, and nothing that can say afterwards whether the
 * supplier actually got better. So the loop
 *
 *   … → Rating → Corrective Action → Supplier Development → next Selection
 *
 * stopped dead at the second-to-last arrow.
 *
 * THREE DECISIONS, TAKEN DELIBERATELY
 * -----------------------------------
 * 1. WHO OWNS A PLAN — a named employee (`owner_employee_id`), plus the
 *    supplier-side counterpart (`vendor_contact_id`). A development programme
 *    owned by "procurement" is owned by nobody, and the supplier half matters
 *    because half the actions are theirs.
 *
 * 2. WHAT TRIGGERS ONE — nothing, automatically. The engine RECOMMENDS and a
 *    person opens. Auto-creating a plan for every Critical supplier would fill
 *    this table with records nobody agreed to and nobody works, which is exactly
 *    how a feature ends up mounted-but-dead. `trigger_reason` records the
 *    evidence the recommendation was made on, so the decision stays auditable.
 *
 * 3. AN OPEN PLAN DOES NOT SUPPRESS A RATING. Deliberately. A plan is a RESPONSE
 *    to a bad score, not a cure for it, and folding it into `health_score` would
 *    let good intentions hide a bad supplier — the same failure as scoring an
 *    unmeasured dimension at its default. `vendor_health_scores` is untouched by
 *    this migration. A supplier under active development is distinguishable from
 *    one nobody is helping because the plan is its own badge, beside the rating,
 *    never inside it.
 *
 * MEASURING WHETHER IT WORKED
 * ---------------------------
 * `baseline_value` is frozen when the plan opens and `outcome_value` captured
 * when it closes, both against the single `target_metric` the plan names. That
 * is what makes this a loop rather than a filing cabinet: a development
 * programme that cannot say whether the score moved is indistinguishable from
 * one that did nothing. `effectiveness` is derived from the two, never typed.
 *
 * ⚠ `target_metric` names a column on `vendor_health_scores` on purpose — those
 * are the KPIs the scorecard actually computes now (including the four added by
 * 20260910000008). A plan cannot target something nothing measures.
 */

const METHODS = ['capability_build', 'quality_programme', 'lead_time_project',
  'capacity_reservation', 'cost_reduction', 'other'];

const TARGET_METRICS = ['health_score', 'quality_score', 'delivery_score', 'cost_score',
  'support_score', 'otd_pct', 'pass_rate_pct', 'capa_closure_pct', 'fill_rate_pct',
  'lead_time_adherence_pct', 'ppv_pct', 'open_ncr_count'];

export async function up(knex) {
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_sdp START WITH 1 INCREMENT BY 1 NO CYCLE`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS supplier_development_plans (
      id                   SERIAL PRIMARY KEY,
      plan_number          VARCHAR(30) NOT NULL,
      company_id           INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      vendor_id            INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,

      -- The first four mirror sourcingStrategyEngine's supplier_development
      -- methods exactly, so the advisory panel and the plan speak one vocabulary.
      -- cost_reduction is added here: the scorecard measures PPV, and a supplier
      -- programme that cannot target cost would leave that KPI with no response.
      method               VARCHAR(30) NOT NULL,
      title                VARCHAR(200) NOT NULL,
      objective            TEXT,

      -- Accountability, both sides of it.
      owner_employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      vendor_contact_id    INTEGER REFERENCES vendor_contacts(id) ON DELETE SET NULL,

      -- Why this was opened. Written from the recommendation that prompted it,
      -- so "who decided this, on what evidence" survives the people involved.
      trigger_reason       TEXT,

      -- What "better" means for this plan, and the frozen reading it started from.
      target_metric        VARCHAR(40) NOT NULL,
      baseline_value       NUMERIC(10,2),
      baseline_captured_at TIMESTAMPTZ,
      target_value         NUMERIC(10,2),
      target_date          DATE,
      review_date          DATE,

      status               VARCHAR(20) NOT NULL DEFAULT 'draft',

      -- Filled on close, from the same metric as the baseline.
      outcome_value        NUMERIC(10,2),
      outcome_captured_at  TIMESTAMPTZ,
      effectiveness        VARCHAR(20),

      created_by           INTEGER,
      closed_at            TIMESTAMPTZ,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`
    ALTER TABLE supplier_development_plans
      DROP CONSTRAINT IF EXISTS sdp_method_chk`);
  await knex.raw(`
    ALTER TABLE supplier_development_plans
      ADD CONSTRAINT sdp_method_chk CHECK (method IN (${METHODS.map((m) => `'${m}'`).join(', ')}))`);

  await knex.raw(`
    ALTER TABLE supplier_development_plans
      DROP CONSTRAINT IF EXISTS sdp_status_chk`);
  await knex.raw(`
    ALTER TABLE supplier_development_plans
      ADD CONSTRAINT sdp_status_chk
      CHECK (status IN ('draft', 'active', 'in_review', 'completed', 'abandoned'))`);

  await knex.raw(`
    ALTER TABLE supplier_development_plans
      DROP CONSTRAINT IF EXISTS sdp_metric_chk`);
  await knex.raw(`
    ALTER TABLE supplier_development_plans
      ADD CONSTRAINT sdp_metric_chk
      CHECK (target_metric IN (${TARGET_METRICS.map((m) => `'${m}'`).join(', ')}))`);

  await knex.raw(`
    ALTER TABLE supplier_development_plans
      DROP CONSTRAINT IF EXISTS sdp_effectiveness_chk`);
  await knex.raw(`
    ALTER TABLE supplier_development_plans
      ADD CONSTRAINT sdp_effectiveness_chk
      CHECK (effectiveness IS NULL
             OR effectiveness IN ('improved', 'no_change', 'worsened', 'unmeasured'))`);

  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sdp_plan_number ON supplier_development_plans(plan_number)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sdp_vendor  ON supplier_development_plans(vendor_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sdp_company ON supplier_development_plans(company_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sdp_status  ON supplier_development_plans(status)`);

  // ── Actions ────────────────────────────────────────────────────────────────
  // A plan without actions is an intention. Each action carries its own owner:
  // some belong to us (share a drawing, run a joint FMEA) and some to them.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS supplier_development_actions (
      id                SERIAL PRIMARY KEY,
      company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      plan_id           INTEGER NOT NULL REFERENCES supplier_development_plans(id) ON DELETE CASCADE,
      description       TEXT NOT NULL,
      -- 'buyer' or 'supplier' — which side is on the hook for this one.
      responsible_party VARCHAR(12) NOT NULL DEFAULT 'buyer',
      owner_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      due_date          DATE,
      status            VARCHAR(20) NOT NULL DEFAULT 'open',
      completed_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await knex.raw(`ALTER TABLE supplier_development_actions DROP CONSTRAINT IF EXISTS sda_status_chk`);
  await knex.raw(`
    ALTER TABLE supplier_development_actions
      ADD CONSTRAINT sda_status_chk
      CHECK (status IN ('open', 'in_progress', 'done', 'cancelled'))`);
  await knex.raw(`ALTER TABLE supplier_development_actions DROP CONSTRAINT IF EXISTS sda_party_chk`);
  await knex.raw(`
    ALTER TABLE supplier_development_actions
      ADD CONSTRAINT sda_party_chk CHECK (responsible_party IN ('buyer', 'supplier'))`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sda_plan ON supplier_development_actions(plan_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sda_status ON supplier_development_actions(status)`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS supplier_development_actions`);
  await knex.raw(`DROP TABLE IF EXISTS supplier_development_plans`);
  await knex.raw(`DROP SEQUENCE IF EXISTS seq_sdp`);
}
