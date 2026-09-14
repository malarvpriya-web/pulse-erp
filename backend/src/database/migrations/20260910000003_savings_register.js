/**
 * 20260910000003_savings_register.js
 *
 * The savings register: identified → negotiated → contracted → realised.
 *
 * WHY THIS EXISTS
 * ---------------
 * From the spend & BI parity audit:
 *
 *   "Savings pipeline & realisation — ABSENT. No savings register, no
 *    identified → negotiated → contracted → realised lifecycle, no finance
 *    sign-off, no run-rate tracking. This is the module a CPO is measured on."
 *
 * Pulse is genuinely good at IDENTIFYING savings — `savings_vs_preferred` in the
 * component catalog, the TCO award delta, the price-vs-standard gap, and the TCO
 * portfolio board (§166). Every one of those is computed, displayed, and then
 * forgotten. Nothing carries a saving from "we noticed this" to "finance agrees
 * we banked it", which is the only part anyone is actually measured on.
 *
 * ⚠ A SAVINGS REGISTER IS THE MOST GAMEABLE OBJECT IN PROCUREMENT
 * ---------------------------------------------------------------
 * Every design decision below exists to stop a specific, well-known way of
 * inflating a savings number. These are not hypothetical; they are why savings
 * reporting has the reputation it has.
 *
 *   1. THE SAME SAVING BOOKED TWICE. Two initiatives, one price reduction. Or
 *      one initiative posted to the same month twice. The unique index on
 *      (initiative_id, period_start, period_end) for realisation events makes
 *      the second posting an error rather than a bigger number.
 *
 *   2. AN ANNUAL SAVING BOOKED EVERY MONTH. A ₹1.2M/year initiative realised
 *      twelve times is ₹14.4M of fiction. Realisation is therefore always FOR A
 *      NAMED PERIOD, never a running total the user types.
 *
 *   3. A SAVING WITH NO BASELINE. "We got a better price" against what? The
 *      baseline carries a `basis` tag on the same quoted/observed/estimated/
 *      assumed scale the TCO engine uses, so a saving computed against an
 *      ASSUMED baseline can be told apart from one against a real prior invoice.
 *      Not forbidden — sometimes assumed is all you have — but never invisible.
 *
 *   4. A SAVING THAT UNWOUND. The price went back up in month 7. `effective_to`
 *      bounds the window, and `lapsed` is a real terminal stage, so an
 *      initiative cannot keep earning after it stopped being true.
 *
 *   5. SELF-CERTIFICATION. `finance_approved_by` gates the `realised` stage.
 *      Procurement identifies; finance confirms. A register where the claimant
 *      is also the approver is a press release.
 *
 * WHY TWO TABLES
 * --------------
 * `savings_initiatives` is the current state of a thing being pursued.
 * `savings_events` is an append-only ledger of what happened to it — every
 * stage change and every realisation posting, with who and when.
 *
 * The realised total is SUMMED FROM THE LEDGER, never stored on the initiative.
 * A stored running total and its own history drift the moment anything is
 * corrected, and the drift is invisible because both numbers look plausible.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // SAV-00001, matching the convention in shared/docNumber.js.
  await knex.raw(`CREATE SEQUENCE IF NOT EXISTS seq_savings START 1`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS savings_initiatives (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      initiative_number   VARCHAR(30)  NOT NULL,

      title               VARCHAR(300) NOT NULL,
      description         TEXT,

      -- What kind of saving. A register that cannot say HOW it saved cannot be
      -- audited, and "negotiated price" and "we bought less" are not the same
      -- claim — the second is a demand decision procurement did not make.
      lever               VARCHAR(40)  NOT NULL DEFAULT 'negotiated_price'
                          CHECK (lever IN (
                            'negotiated_price', 'volume_consolidation', 'spec_change',
                            'payment_terms', 'tco_award', 'demand_reduction',
                            'vendor_switch', 'contract_renegotiation', 'other')),

      stage               VARCHAR(20)  NOT NULL DEFAULT 'identified'
                          CHECK (stage IN (
                            'identified', 'negotiated', 'contracted', 'realised',
                            'rejected', 'lapsed')),

      category_id         INTEGER      REFERENCES item_categories(id) ON DELETE SET NULL,
      vendor_id           INTEGER      REFERENCES vendors(id) ON DELETE SET NULL,
      item_id             INTEGER      REFERENCES inventory_items(id) ON DELETE SET NULL,

      -- ── the baseline, and how much to believe it ────────────────────────────
      baseline_unit_price NUMERIC(18,4),
      target_unit_price   NUMERIC(18,4),
      baseline_annual_qty NUMERIC(18,4),

      -- Same scale the TCO engine tags every cost line with. An estimate is
      -- allowed; an estimate that looks like a measurement is not.
      baseline_basis      VARCHAR(20)  NOT NULL DEFAULT 'estimated'
                          CHECK (baseline_basis IN ('quoted', 'observed', 'estimated', 'assumed')),
      baseline_note       TEXT,

      -- Frozen at identification. Recomputing this from today's prices would
      -- make a target move to meet whatever actually happened.
      estimated_annual_saving NUMERIC(18,2) NOT NULL DEFAULT 0,

      currency            VARCHAR(3)   NOT NULL DEFAULT 'INR',

      -- The window in which this initiative can earn. A realisation outside it
      -- is refused: an initiative that stopped being true in month 7 must not
      -- keep banking in month 8.
      effective_from      DATE,
      effective_to        DATE,
      CONSTRAINT savings_effective_window_ordered
        CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),

      owner_user_id       INTEGER      REFERENCES users(id) ON DELETE SET NULL,

      -- ⚠ The sign-off gate. Enforced in the service, not here, because the
      -- check would have to read a second table; the service refuses the
      -- transition to 'realised' without it.
      finance_approved_by INTEGER      REFERENCES users(id) ON DELETE SET NULL,
      finance_approved_at TIMESTAMPTZ,

      -- Where this came from. A saving raised BY the TCO board carries the RFQ
      -- it was found on, so the claim can be walked back to its evidence.
      source_type         VARCHAR(30)  NOT NULL DEFAULT 'manual'
                          CHECK (source_type IN ('manual', 'tco_award', 'price_variance',
                                                 'catalog_gap', 'contract_renewal')),
      source_ref_id       INTEGER,

      created_by          INTEGER      REFERENCES users(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      deleted_at          TIMESTAMPTZ,

      CONSTRAINT savings_initiative_number_unique UNIQUE (initiative_number)
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_savings_company  ON savings_initiatives(company_id) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_savings_stage    ON savings_initiatives(company_id, stage) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_savings_vendor   ON savings_initiatives(vendor_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_savings_category ON savings_initiatives(category_id)`);

  // ⚠ One initiative per source record, where the source IS a record. Stops the
  // same TCO award being raised as three separate initiatives by three people.
  // Partial, so 'manual' initiatives (source_ref_id NULL) are unconstrained.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_source_unique
      ON savings_initiatives(company_id, source_type, source_ref_id)
     WHERE source_ref_id IS NOT NULL AND deleted_at IS NULL
  `);

  // ── the ledger ────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS savings_events (
      id             SERIAL PRIMARY KEY,
      initiative_id  INTEGER     NOT NULL REFERENCES savings_initiatives(id) ON DELETE CASCADE,
      company_id     INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

      event_type     VARCHAR(20) NOT NULL
                     CHECK (event_type IN ('stage_change', 'realisation', 'adjustment')),

      from_stage     VARCHAR(20),
      to_stage       VARCHAR(20),

      -- Realisations and adjustments carry money; stage changes do not.
      amount         NUMERIC(18,2),

      -- ⚠ THE ANTI-DOUBLE-COUNT KEY. A realisation is always FOR A PERIOD, never
      -- a running total someone types. See the unique index below.
      period_start   DATE,
      period_end     DATE,

      -- What proves it. A realisation with evidence_type 'manual' is a claim; one
      -- pointing at a PO or an invoice is a fact. Both are allowed and they are
      -- reported separately.
      evidence_type  VARCHAR(20) CHECK (evidence_type IN ('po', 'invoice', 'contract', 'manual')),
      evidence_ref   VARCHAR(100),

      note           TEXT,
      created_by     INTEGER     REFERENCES users(id) ON DELETE SET NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      CONSTRAINT savings_event_realisation_has_period
        CHECK (event_type <> 'realisation'
               OR (period_start IS NOT NULL AND period_end IS NOT NULL AND amount IS NOT NULL)),
      CONSTRAINT savings_event_period_ordered
        CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_savings_events_initiative ON savings_events(initiative_id, created_at)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_savings_events_company    ON savings_events(company_id, event_type)`);

  // ⚠ The constraint the whole register rests on: an initiative cannot be
  // realised twice for the same period. Without it, "book the annual saving each
  // month" turns ₹1.2M into ₹14.4M and nothing in the data looks wrong.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_savings_realisation_period_unique
      ON savings_events(initiative_id, period_start, period_end)
     WHERE event_type = 'realisation'
  `);

  // A ledger row must belong to the same tenant as its initiative — otherwise a
  // realisation could be filed under company 2 against company 1's initiative
  // and the initiative-level scope check would pass it.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION savings_event_company_matches() RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.company_id IS DISTINCT FROM
         (SELECT company_id FROM savings_initiatives WHERE id = NEW.initiative_id) THEN
        RAISE EXCEPTION 'savings event company_id % does not match its initiative', NEW.company_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_savings_event_company ON savings_events`);
  await knex.raw(`
    CREATE TRIGGER trg_savings_event_company
      BEFORE INSERT OR UPDATE ON savings_events
      FOR EACH ROW EXECUTE FUNCTION savings_event_company_matches()
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_savings_event_company ON savings_events`);
  await knex.raw(`DROP FUNCTION IF EXISTS savings_event_company_matches()`);
  await knex.raw(`DROP TABLE IF EXISTS savings_events`);
  await knex.raw(`DROP TABLE IF EXISTS savings_initiatives`);
  await knex.raw(`DROP SEQUENCE IF EXISTS seq_savings`);
}
