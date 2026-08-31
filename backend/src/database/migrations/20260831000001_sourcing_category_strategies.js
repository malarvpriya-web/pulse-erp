/**
 * sourcing_category_strategies — the sourcing approach of record for a category.
 *
 * The engine can position a category on the Purchasing Chessboard every time it
 * is asked, from live spend. What it cannot do is remember what a human DECIDED
 * to do about it, and a category strategy that lives in a slide deck is a
 * category strategy nobody executes against.
 *
 * One row per category per company, holding four things:
 *
 *   1. THE DECISION — the quadrant, lever and method chosen (the chessboard
 *      keys are validated against the engine's taxonomy on the way in, so a
 *      method that does not exist cannot be stored), plus the rationale. The
 *      rationale is the point: the framework proposes, a category manager
 *      disposes, and the reason has to outlive the person who had it.
 *
 *   2. THE BASIS IT WAS DECIDED ON — `facts_snapshot` and `position_snapshot`
 *      frozen at decision time, exactly as §128 freezes a TCO award. Spend
 *      moves every week; recomputing the position under today's numbers answers
 *      a different question than the one that was answered on the day, and
 *      without the freeze nobody can tell an out-of-date strategy from a wrong
 *      one.
 *
 *   3. WHO AND WHEN — `decided_by_user_id` is named for its id space on
 *      purpose. `purchase_requests.approved_by` FKs **employees(id)** while the
 *      JWT carries a **users.id**, and confusing the two is the single most
 *      repeated defect in this codebase. A column that states which id it holds
 *      cannot be got wrong by the next writer.
 *
 *   4. THE REVIEW DATE — a sourcing strategy with no expiry is a sourcing
 *      strategy that is silently wrong two years later.
 *
 * `category_id IS NULL` is a legitimate row, not a bug: it is the strategy for
 * the Uncategorised bucket, which in a system where items have not been
 * classified is where most of the spend actually sits. That is also why the
 * uniqueness index below coalesces — Postgres treats NULLs as distinct, so a
 * plain UNIQUE(company_id, category_id) would happily store fifty competing
 * strategies for the uncategorised bucket and the page would show whichever one
 * the planner returned first.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS sourcing_category_strategies (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER,
      category_id         INTEGER      REFERENCES item_categories(id) ON DELETE CASCADE,

      -- The decision, in the engine's own vocabulary.
      quadrant_key        VARCHAR(48)  NOT NULL,
      lever_key           VARCHAR(64)  NOT NULL,
      method_key          VARCHAR(64)  NOT NULL,
      method_label        VARCHAR(160),
      -- Which slice of suppliers the play is aimed at, when it is not all of
      -- them ("Preferred", "Watchlist", a vendor category). NULL = the category.
      supplier_segment    VARCHAR(64),

      rationale           TEXT,
      target_saving_pct   NUMERIC(6,2),
      review_date         DATE,
      status              VARCHAR(24)  NOT NULL DEFAULT 'draft',

      -- Frozen basis. Recomputing instead of freezing loses the decision.
      facts_snapshot      JSONB,
      position_snapshot   JSONB,
      forces_snapshot     JSONB,

      decided_by_user_id  INTEGER,
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  // NULL category_id is the Uncategorised bucket and must still be unique per
  // company; NULLs compare distinct, so both keys are coalesced to a sentinel
  // that no real id can take.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sourcing_strategy_company_category
      ON sourcing_category_strategies (COALESCE(company_id, -1), COALESCE(category_id, -1))
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sourcing_strategy_review
      ON sourcing_category_strategies (review_date)
     WHERE review_date IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sourcing_strategy_status
      ON sourcing_category_strategies (company_id, status)
  `);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS sourcing_category_strategies CASCADE`);
}
