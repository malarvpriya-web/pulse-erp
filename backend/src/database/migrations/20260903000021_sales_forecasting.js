/**
 * 20260903000021_sales_forecasting.js
 *
 * Real sales forecasting: categories, rep submissions, manager overrides,
 * period snapshots and measurable accuracy.
 *
 * WHY
 * ---
 * The Salesforce-parity audit (2026-09-03) found "forecasting" was four
 * read-only aggregate endpoints over `opportunities` (/forecasts/summary,
 * /by-month, /by-rep, /pipeline-breakdown). Everything the capability actually
 * means was absent:
 *
 *   - no forecast CATEGORY — commit / best case / pipeline / omitted. Every
 *     open deal contributed `expected_value x probability` and nothing else, so
 *     a rep could not say "this one is committed" and a manager could not read
 *     a commit number at all.
 *   - no SUBMISSION — a forecast was never a thing a person stated, only a
 *     number the database recomputed on every page load.
 *   - no manager OVERRIDE, so no judgement could be applied over the roll-up.
 *   - no HISTORY. /forecasts/summary answers "what does the pipeline say right
 *     now"; with no stored snapshot there was no way to ask what it said last
 *     month, which makes forecast ACCURACY unmeasurable by construction.
 *
 * DESIGN
 * ------
 * opportunities.forecast_category is the per-deal judgement. It is nullable:
 * NULL means "not yet categorised", and the engine derives a default from stage
 * + probability rather than writing one, so an untouched deal still forecasts
 * sensibly and an explicitly-set one is never silently overwritten.
 *
 * sales_forecast_submissions is one row per (company, owner, period, scope).
 * The rep's numbers and the manager's override live in the SAME row, so the
 * pair can never drift apart, and both actors and both timestamps are stored —
 * an override that cannot say who made it is not an audit trail.
 *
 * sales_forecast_snapshots is append-only. Accuracy is computed by comparing a
 * snapshot taken during a period against what that period actually closed, so
 * the table must never be updated in place.
 *
 * All three carry company_id and are indexed on it — every read in this module
 * is tenant-scoped through companyOf().
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only,
 * with $1-style bindings.
 */

export async function up(knex) {
  // -- per-deal forecast judgement -------------------------------------------
  await knex.raw(`
    ALTER TABLE opportunities
      ADD COLUMN IF NOT EXISTS forecast_category VARCHAR(20)
  `);

  // Separate statement on purpose: ADD COLUMN IF NOT EXISTS is a silent no-op
  // when the column already exists, and a CHECK bundled into it would then
  // never be created. (Same trap as ADD COLUMN IF NOT EXISTS x TEXT over an
  // existing INTEGER x.)
  await knex.raw(`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'opportunities_forecast_category_check'
      ) THEN
        ALTER TABLE opportunities
          ADD CONSTRAINT opportunities_forecast_category_check
          CHECK (forecast_category IS NULL OR forecast_category IN
                 ('commit','best_case','pipeline','omitted','closed'));
      END IF;
    END
    $do$;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_opportunities_forecast_category
      ON opportunities (company_id, forecast_category)
     WHERE deleted_at IS NULL
  `);

  // -- what a person actually committed to ------------------------------------
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sales_forecast_submissions (
      id                     SERIAL PRIMARY KEY,
      company_id             INTEGER       NOT NULL REFERENCES companies(id),
      owner_employee_id      INTEGER           NULL REFERENCES employees(id),
      scope                  VARCHAR(20)   NOT NULL DEFAULT 'rep',
      period_type            VARCHAR(20)   NOT NULL,
      period_year            INTEGER       NOT NULL,
      period_value           INTEGER           NULL,
      currency               VARCHAR(3)    NOT NULL DEFAULT 'INR',

      commit_amount          NUMERIC(16,2) NOT NULL DEFAULT 0,
      best_case_amount       NUMERIC(16,2) NOT NULL DEFAULT 0,
      pipeline_amount        NUMERIC(16,2) NOT NULL DEFAULT 0,
      closed_amount          NUMERIC(16,2) NOT NULL DEFAULT 0,
      quota_amount           NUMERIC(16,2) NOT NULL DEFAULT 0,

      status                 VARCHAR(20)   NOT NULL DEFAULT 'draft',
      notes                  TEXT              NULL,
      submitted_by           INTEGER           NULL REFERENCES employees(id),
      submitted_at           TIMESTAMPTZ       NULL,

      override_commit_amount NUMERIC(16,2)     NULL,
      override_reason        TEXT              NULL,
      override_by            INTEGER           NULL REFERENCES employees(id),
      override_at            TIMESTAMPTZ       NULL,

      created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

      CONSTRAINT sales_forecast_submissions_scope_check
        CHECK (scope IN ('rep','team','company')),
      CONSTRAINT sales_forecast_submissions_status_check
        CHECK (status IN ('draft','submitted','approved','rejected')),
      CONSTRAINT sales_forecast_submissions_period_type_check
        CHECK (period_type IN ('monthly','quarterly','annual')),
      CONSTRAINT sales_forecast_submissions_amounts_check
        CHECK (commit_amount >= 0 AND best_case_amount >= 0
               AND pipeline_amount >= 0 AND closed_amount >= 0
               AND quota_amount >= 0
               AND (override_commit_amount IS NULL OR override_commit_amount >= 0))
    )
  `);

  // One submission per owner per period per scope. COALESCE on the two nullable
  // key parts because NULL never equals NULL in a unique index, which would let
  // a company-scope or annual submission be inserted twice.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_forecast_submission
      ON sales_forecast_submissions
         (company_id, COALESCE(owner_employee_id, -1), scope,
          period_type, period_year, COALESCE(period_value, -1))
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sales_forecast_submissions_period
      ON sales_forecast_submissions (company_id, period_year, period_type, period_value)
  `);

  // -- append-only history, so accuracy is measurable -------------------------
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sales_forecast_snapshots (
      id                 SERIAL PRIMARY KEY,
      company_id         INTEGER       NOT NULL REFERENCES companies(id),
      owner_employee_id  INTEGER           NULL REFERENCES employees(id),
      period_type        VARCHAR(20)   NOT NULL,
      period_year        INTEGER       NOT NULL,
      period_value       INTEGER           NULL,
      forecast_category  VARCHAR(20)   NOT NULL,
      amount             NUMERIC(16,2) NOT NULL DEFAULT 0,
      opportunity_count  INTEGER       NOT NULL DEFAULT 0,
      captured_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      captured_by        INTEGER           NULL REFERENCES employees(id),
      source             VARCHAR(20)   NOT NULL DEFAULT 'manual'
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sales_forecast_snapshots_lookup
      ON sales_forecast_snapshots
         (company_id, period_year, period_type, period_value, captured_at DESC)
  `);

  console.log('[sales_forecasting] forecast_category + submissions + snapshots ready');
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS sales_forecast_snapshots`);
  await knex.raw(`DROP TABLE IF EXISTS sales_forecast_submissions`);
  await knex.raw(`DROP INDEX IF EXISTS idx_opportunities_forecast_category`);
  await knex.raw(`ALTER TABLE opportunities DROP CONSTRAINT IF EXISTS opportunities_forecast_category_check`);
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS forecast_category`);
}
