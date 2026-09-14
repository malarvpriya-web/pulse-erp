/**
 * 20260908000001_knowledge_workflow.js
 *
 * Turns `service_knowledge_base` from a table of articles into a managed
 * knowledge base: versions, an approval step, publish/unpublish, internal vs
 * public visibility, links to the cases and products an article is about, and
 * effectiveness that is actually measured.
 *
 * WHY
 * ---
 * The CRM audit scored knowledge management WEAK: articles existed and could be
 * written, but nothing governed them. There was no version history, so an edit
 * silently destroyed what the article used to say; no approval, so anything
 * anyone typed was immediately what the business told its customers; no
 * internal/public distinction, so an internal troubleshooting note and a
 * customer-facing FAQ were the same kind of row; and while `views`,
 * `helpful_yes` and `helpful_no` existed as columns, nothing ever incremented
 * them, so "article effectiveness" was three zeroes.
 *
 * WHAT IS REUSED
 * --------------
 * `service_knowledge_base` already carries title, content, category, tags,
 * author_id, views, helpful_yes, helpful_no and is_published. All of that stays.
 * This adds the governance around it rather than a second articles table —
 * a parallel table would immediately raise "which one is the real one", which
 * is the duplicate-table trap this codebase has been bitten by before.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // ── governance columns on the existing article ────────────────────────────
  const COLS = [
    ['status', `VARCHAR(20) NOT NULL DEFAULT 'draft'`],
    ['visibility', `VARCHAR(20) NOT NULL DEFAULT 'internal'`],
    ['version', 'INTEGER NOT NULL DEFAULT 1'],
    ['summary', 'TEXT'],
    ['submitted_by', 'INTEGER'],
    ['submitted_at', 'TIMESTAMPTZ'],
    ['approved_by', 'INTEGER'],
    ['approved_at', 'TIMESTAMPTZ'],
    ['rejected_reason', 'TEXT'],
    ['published_at', 'TIMESTAMPTZ'],
    ['archived_at', 'TIMESTAMPTZ'],
    ['review_due_date', 'DATE'],
    ['product_ids', `JSONB NOT NULL DEFAULT '[]'::jsonb`],
    ['not_helpful_reasons', `JSONB NOT NULL DEFAULT '[]'::jsonb`],
  ];
  for (const [name, type] of COLS) {
    await knex.raw(`ALTER TABLE service_knowledge_base ADD COLUMN IF NOT EXISTS ${name} ${type}`);
  }

  await knex.raw(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skb_status_check') THEN
        ALTER TABLE service_knowledge_base ADD CONSTRAINT skb_status_check
          CHECK (status IN ('draft','in_review','approved','published','rejected','archived'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skb_visibility_check') THEN
        ALTER TABLE service_knowledge_base ADD CONSTRAINT skb_visibility_check
          CHECK (visibility IN ('internal','public'));
      END IF;
    END
    $do$;
  `);

  // `is_published` predates this and something may still read it. Kept in step
  // with `status` by a trigger rather than dropped, so neither can drift.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION skb_sync_published()
    RETURNS trigger AS $fn$
    BEGIN
      IF NEW.status = 'published' THEN
        NEW.is_published := true;
        NEW.published_at := COALESCE(NEW.published_at, NOW());
      ELSE
        NEW.is_published := false;
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_skb_sync_published ON service_knowledge_base`);
  await knex.raw(`
    CREATE TRIGGER trg_skb_sync_published
      BEFORE INSERT OR UPDATE ON service_knowledge_base
      FOR EACH ROW EXECUTE FUNCTION skb_sync_published()
  `);

  // Existing rows: an article already flagged published keeps that meaning.
  await knex.raw(`
    UPDATE service_knowledge_base
       SET status = CASE WHEN is_published THEN 'published' ELSE 'draft' END,
           published_at = CASE WHEN is_published THEN COALESCE(published_at, created_at) ELSE NULL END
     WHERE status = 'draft'
  `);

  // ── version history ───────────────────────────────────────────────────────
  // Append-only. An edit must not destroy what the article used to say — that
  // is the whole point of versioning, and it is also what makes "who changed
  // this and when" answerable after the fact.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS knowledge_article_versions (
      id           SERIAL PRIMARY KEY,
      article_id   INTEGER      NOT NULL REFERENCES service_knowledge_base(id) ON DELETE CASCADE,
      company_id   INTEGER      NOT NULL REFERENCES companies(id),
      version      INTEGER      NOT NULL,
      title        VARCHAR(255) NOT NULL,
      summary      TEXT             NULL,
      content      TEXT             NULL,
      category     VARCHAR(120)     NULL,
      tags         TEXT             NULL,
      visibility   VARCHAR(20)      NULL,
      status       VARCHAR(20)      NULL,
      changed_by   INTEGER          NULL REFERENCES employees(id),
      change_note  TEXT             NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_knowledge_article_version UNIQUE (article_id, version)
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_versions_article
      ON knowledge_article_versions (article_id, version DESC)
  `);

  // ── what an article is about ──────────────────────────────────────────────
  // Links to cases, so "which articles solved this kind of problem" and
  // "how often did this article get attached to a resolution" are answerable.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS knowledge_article_cases (
      id          SERIAL PRIMARY KEY,
      article_id  INTEGER     NOT NULL REFERENCES service_knowledge_base(id) ON DELETE CASCADE,
      ticket_id   INTEGER     NOT NULL,
      company_id  INTEGER     NOT NULL REFERENCES companies(id),
      linked_by   INTEGER         NULL REFERENCES employees(id),
      resolved_it BOOLEAN     NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_knowledge_article_case UNIQUE (article_id, ticket_id)
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_knowledge_cases_ticket ON knowledge_article_cases (ticket_id)`);

  // ── effectiveness, recorded per event rather than only as a counter ───────
  // The counters on the article stay (something may read them), but a row per
  // event is what makes "is this article getting worse over time" answerable —
  // a counter can only ever say "how many, ever".
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS knowledge_article_feedback (
      id          SERIAL PRIMARY KEY,
      article_id  INTEGER     NOT NULL REFERENCES service_knowledge_base(id) ON DELETE CASCADE,
      company_id  INTEGER     NOT NULL REFERENCES companies(id),
      event       VARCHAR(20) NOT NULL,
      reason      TEXT            NULL,
      employee_id INTEGER         NULL REFERENCES employees(id),
      ticket_id   INTEGER         NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT knowledge_feedback_event_check CHECK (event IN ('view','helpful','not_helpful'))
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_knowledge_feedback_article
      ON knowledge_article_feedback (article_id, event, created_at DESC)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_skb_status
      ON service_knowledge_base (company_id, status, visibility)
  `);

  const { rows } = await knex.raw(
    `SELECT status, COUNT(*)::int AS n FROM service_knowledge_base GROUP BY status ORDER BY status`
  );
  console.log('[knowledge_workflow] ' + rows.map(r => `${r.status}=${r.n}`).join(' '));
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS knowledge_article_feedback`);
  await knex.raw(`DROP TABLE IF EXISTS knowledge_article_cases`);
  await knex.raw(`DROP TABLE IF EXISTS knowledge_article_versions`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_skb_sync_published ON service_knowledge_base`);
  await knex.raw(`DROP FUNCTION IF EXISTS skb_sync_published()`);
  await knex.raw(`DROP INDEX IF EXISTS idx_skb_status`);
  await knex.raw(`ALTER TABLE service_knowledge_base DROP CONSTRAINT IF EXISTS skb_status_check`);
  await knex.raw(`ALTER TABLE service_knowledge_base DROP CONSTRAINT IF EXISTS skb_visibility_check`);
  for (const c of ['not_helpful_reasons', 'product_ids', 'review_due_date', 'archived_at',
                   'published_at', 'rejected_reason', 'approved_at', 'approved_by',
                   'submitted_at', 'submitted_by', 'summary', 'version', 'visibility', 'status']) {
    await knex.raw(`ALTER TABLE service_knowledge_base DROP COLUMN IF EXISTS ${c}`);
  }
}
