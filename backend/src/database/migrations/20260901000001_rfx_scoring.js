/**
 * RFx scoring — turning an RFQ into a defensible vendor selection (spec 1.7.5).
 *
 * WHAT WAS MISSING
 * The app could raise an RFQ, collect quotes, and award one. Three things it
 * could not do:
 *
 *   1. RUN AN RFI OR AN RFP. `rfqs` only ever meant "request for quotation", so
 *      the two stages that come BEFORE price — can this supplier do it at all
 *      (RFI), and whose proposal is better (RFP) — had nowhere to live. Buyers
 *      were either skipping them or keeping them in email.
 *
 *   2. SCORE ON ANYTHING BUT MONEY. §128 gave the award a total cost of
 *      ownership, which is a genuinely better price — but still a price. A
 *      preferred-vendor decision weighs capability, quality record, delivery
 *      reliability and compliance alongside cost, and there was no structure
 *      that could hold those together, let alone weight them.
 *
 *   3. RECORD A PREFERRED VENDOR AS AN OUTCOME. Awarding an RFQ closes one
 *      transaction. It writes nothing to `approved_vendor_list`, nothing to
 *      `item_vendor_prices.is_preferred`, and nothing to
 *      `inventory_items.preferred_vendor_id` — so the next buyer starts from
 *      scratch and the AVL stays as the seed data left it.
 *
 * THREE CHANGES
 *
 *   `rfqs` grows `rfx_type` (RFI | RFP | RFQ), a `category_id` linking the
 *   event back to the sourcing category whose strategy called for it (§136),
 *   and the `scoring_model` actually used — frozen, because a weighting changed
 *   after the fact turns a documented decision into an undocumented one.
 *
 *   `rfx_criteria_scores` holds one score per (event, vendor, criterion). A
 *   criterion nobody scored has NO ROW — deliberately, so the engine can tell
 *   "scored zero" from "not scored", which is the difference between a vendor
 *   who failed a check and one nobody has assessed yet.
 *
 *   `rfx_vendor_selections` freezes the scorecard at the moment a preferred
 *   vendor was chosen, the runner-up, and the margin between them.
 */

export async function up(knex) {
  // ── rfqs becomes the RFx event table ────────────────────────────────────────
  // `rfx_type` is a genuinely closed three-value vocabulary that this migration
  // owns, so it carries a CHECK. (Contrast `purchase_orders.status`, which is
  // open and is therefore handled by exclusion in statusSets.js.)
  await knex.raw(`
    ALTER TABLE rfqs
      ADD COLUMN IF NOT EXISTS rfx_type      VARCHAR(8) NOT NULL DEFAULT 'RFQ',
      ADD COLUMN IF NOT EXISTS category_id   INTEGER REFERENCES item_categories(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS objective     TEXT,
      ADD COLUMN IF NOT EXISTS scoring_model JSONB,
      ADD COLUMN IF NOT EXISTS evaluated_at  TIMESTAMPTZ
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'rfqs_rfx_type_check'
      ) THEN
        ALTER TABLE rfqs
          ADD CONSTRAINT rfqs_rfx_type_check CHECK (rfx_type IN ('RFI','RFP','RFQ'));
      END IF;
    END $$;
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rfqs_rfx_type ON rfqs (rfx_type)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rfqs_category ON rfqs (category_id) WHERE category_id IS NOT NULL`);

  // ── One score per event / vendor / criterion ─────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rfx_criteria_scores (
      id                 SERIAL PRIMARY KEY,
      rfq_id             INTEGER      NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      vendor_id          INTEGER      NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      criterion_key      VARCHAR(48)  NOT NULL,

      -- 0-100. NULL is not permitted: a row exists only where a score exists.
      -- "Not yet scored" is the ABSENCE of a row, which is what lets the engine
      -- report coverage instead of averaging in a zero nobody meant.
      score              NUMERIC(6,2) NOT NULL CHECK (score >= 0 AND score <= 100),

      -- 'benchmarked' — computed from the field of bids (price, lead time)
      -- 'observed'    — taken from our own record of this vendor (health, NCR)
      -- 'assessed'    — a human scored it
      basis              VARCHAR(16)  NOT NULL DEFAULT 'assessed',
      note              TEXT,

      scored_by_user_id  INTEGER,
      company_id         INTEGER,
      created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_rfx_score_event_vendor_criterion
      ON rfx_criteria_scores (rfq_id, vendor_id, criterion_key)
  `);

  // ── The selection itself, with its basis frozen ─────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS rfx_vendor_selections (
      id                    SERIAL PRIMARY KEY,
      rfq_id                INTEGER      NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      vendor_id             INTEGER      NOT NULL REFERENCES vendors(id),
      company_id            INTEGER,

      -- What the engine said, and what the human did about it. They are allowed
      -- to differ; they are not allowed to be indistinguishable afterwards.
      engine_recommendation VARCHAR(24),
      followed_recommendation BOOLEAN,

      total_score           NUMERIC(6,2),
      coverage_pct          NUMERIC(6,2),
      rank                  INTEGER,
      runner_up_vendor_id   INTEGER REFERENCES vendors(id),
      score_gap             NUMERIC(6,2),

      scorecard_snapshot    JSONB,
      model_snapshot        JSONB,
      -- Which items the preferred status was applied to, and what was written
      -- where. A selection that silently touched nothing is the failure mode.
      applied_to            JSONB,

      rationale             TEXT,
      selected_by_user_id   INTEGER,
      created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rfx_selection_rfq ON rfx_vendor_selections (rfq_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_rfx_selection_vendor ON rfx_vendor_selections (vendor_id)`);

  // `approved_vendor_list` is the AVL of record and gains a pointer back to the
  // event that put a vendor on it, so "why is this vendor approved?" has an
  // answer that is not a free-text note.
  await knex.raw(`
    ALTER TABLE approved_vendor_list
      ADD COLUMN IF NOT EXISTS source_rfq_id INTEGER REFERENCES rfqs(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS is_preferred  BOOLEAN NOT NULL DEFAULT FALSE
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS rfx_vendor_selections CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS rfx_criteria_scores CASCADE`);
  await knex.raw(`ALTER TABLE approved_vendor_list DROP COLUMN IF EXISTS source_rfq_id`);
  await knex.raw(`ALTER TABLE approved_vendor_list DROP COLUMN IF EXISTS is_preferred`);
  await knex.raw(`ALTER TABLE rfqs DROP CONSTRAINT IF EXISTS rfqs_rfx_type_check`);
  await knex.raw(`
    ALTER TABLE rfqs
      DROP COLUMN IF EXISTS rfx_type,
      DROP COLUMN IF EXISTS category_id,
      DROP COLUMN IF EXISTS objective,
      DROP COLUMN IF EXISTS scoring_model,
      DROP COLUMN IF EXISTS evaluated_at
  `);
}
