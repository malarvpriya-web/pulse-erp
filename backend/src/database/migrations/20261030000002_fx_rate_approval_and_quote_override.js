/**
 * 20261030000002 — approved exchange rates for comparisons, and a documented
 * per-quote override. See MODULE_FEATURE_CONNECTION_MANUAL.md §215.
 *
 * Reuses Finance's existing rate tables rather than adding a second one:
 * `forex_rate_history` is already one row per (company, currency, effective
 * date) with a source. What it lacked was any notion of review — a rate fetched
 * from a public API at 7am was as authoritative as one Finance signed off. TCO
 * comparisons now read ONLY approved history rows, so a rate has to be:
 *   entered (draft) → approved by someone OTHER than the person who entered it.
 *
 * ⚠ Existing rows become 'draft'. Nobody approved them, so marking them
 * approved would assert a review that never happened. Their values are not
 * touched. Finance's own screens (current rates, revaluation, convert) keep
 * reading forex_rates exactly as before; only comparisons require approval.
 *
 * rfq_quotes gains a quote-specific override: a rate plus a mandatory reason,
 * who set it and when. The route allows it only for finance:approve and only
 * while the RFQ is open; an awarded comparison is frozen in
 * procurement_award_decisions and is never recomputed.
 *
 * procurement_settings.tco_fx_max_age_days: an approved rate older than this,
 * relative to the comparison date, is stale and is NOT used. Default 30.
 */
export async function up(knex) {
  await knex.raw(`
    ALTER TABLE forex_rate_history
      ADD COLUMN IF NOT EXISTS status              VARCHAR(10) NOT NULL DEFAULT 'draft',
      ADD COLUMN IF NOT EXISTS entered_by_user_id  INTEGER,
      ADD COLUMN IF NOT EXISTS approved_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS approved_at         TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_note         TEXT,
      ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ DEFAULT NOW()
  `);
  const check = (table, name, def) => knex.raw(`
    DO $$ BEGIN
      ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${def});
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);
  await check('forex_rate_history', 'forex_rate_history_status_chk',
    `status IN ('draft','approved','rejected')`);
  // 'api' and 'manual' are the values already on file; the rest are the
  // sources Finance records a reviewed rate under.
  await check('forex_rate_history', 'forex_rate_history_source_chk',
    `source IN ('api','manual','rbi','bank','finance_approved')`);
  // An approved row must say who approved it and when — otherwise "approved"
  // is a flag anyone could have set.
  await check('forex_rate_history', 'forex_rate_history_approval_chk',
    `status <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_forex_rate_history_approved
      ON forex_rate_history (company_id, currency_code, rate_date DESC)
      WHERE status = 'approved'
  `);

  await knex.raw(`
    ALTER TABLE rfq_quotes
      ADD COLUMN IF NOT EXISTS fx_rate_override       NUMERIC(18,8),
      ADD COLUMN IF NOT EXISTS fx_override_reason     TEXT,
      ADD COLUMN IF NOT EXISTS fx_override_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS fx_override_at         TIMESTAMPTZ
  `);
  await check('rfq_quotes', 'rfq_quotes_fx_override_chk',
    `fx_rate_override IS NULL OR (fx_rate_override > 0 AND length(btrim(COALESCE(fx_override_reason,''))) >= 10
                                  AND fx_override_by_user_id IS NOT NULL AND fx_override_at IS NOT NULL)`);

  await knex.raw(`
    ALTER TABLE procurement_settings
      ADD COLUMN IF NOT EXISTS tco_fx_max_age_days INTEGER NOT NULL DEFAULT 30
  `);
  await check('procurement_settings', 'procurement_settings_tco_fx_max_age_days_check',
    `tco_fx_max_age_days BETWEEN 1 AND 366`);
}

export async function down(knex) {
  const { rows: [r] } = await knex.raw(
    `SELECT COUNT(*)::int AS n FROM rfq_quotes WHERE fx_rate_override IS NOT NULL`);
  if (r.n > 0) throw new Error(`${r.n} quote(s) carry an FX override; clear them deliberately before rolling back.`);
  await knex.raw(`ALTER TABLE procurement_settings DROP CONSTRAINT IF EXISTS procurement_settings_tco_fx_max_age_days_check`);
  await knex.raw(`ALTER TABLE procurement_settings DROP COLUMN IF EXISTS tco_fx_max_age_days`);
  await knex.raw(`ALTER TABLE rfq_quotes DROP CONSTRAINT IF EXISTS rfq_quotes_fx_override_chk`);
  await knex.raw(`ALTER TABLE rfq_quotes
    DROP COLUMN IF EXISTS fx_rate_override, DROP COLUMN IF EXISTS fx_override_reason,
    DROP COLUMN IF EXISTS fx_override_by_user_id, DROP COLUMN IF EXISTS fx_override_at`);
  await knex.raw(`DROP INDEX IF EXISTS idx_forex_rate_history_approved`);
  for (const c of ['forex_rate_history_status_chk', 'forex_rate_history_source_chk', 'forex_rate_history_approval_chk']) {
    await knex.raw(`ALTER TABLE forex_rate_history DROP CONSTRAINT IF EXISTS ${c}`);
  }
  await knex.raw(`ALTER TABLE forex_rate_history
    DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS entered_by_user_id,
    DROP COLUMN IF EXISTS approved_by_user_id, DROP COLUMN IF EXISTS approved_at,
    DROP COLUMN IF EXISTS review_note, DROP COLUMN IF EXISTS updated_at`);
}
