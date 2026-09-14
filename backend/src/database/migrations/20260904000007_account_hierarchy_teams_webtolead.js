/**
 * 20260904000007_account_hierarchy_teams_webtolead.js
 *
 * Three capabilities the CRM brief names explicitly and the system did not have:
 * account hierarchy, account/opportunity teams, and web-to-lead capture.
 *
 * ACCOUNT HIERARCHY (brief §2 "parent/child accounts, account hierarchy")
 * ----------------------------------------------------------------------
 * `accounts` had no parent link, so a group and its subsidiaries were unrelated
 * rows and "total revenue for this customer group" was unanswerable.
 *
 * A cycle here is not a theoretical concern: it would make the recursive
 * roll-up query run forever. The trigger below walks the ancestor chain on every
 * write and refuses one, which is the only place that can be enforced reliably —
 * a CHECK constraint cannot see other rows.
 *
 * TEAMS (brief §12 "account teams, opportunity teams")
 * ---------------------------------------------------
 * Ownership was single-valued: one `assigned_to` per record. Real deals are
 * worked by several people with different roles, and "my team's pipeline" could
 * only ever mean "deals I personally own".
 *
 * One table with a polymorphic parent rather than two near-identical ones. The
 * CHECK enforces exactly one parent, so a row cannot belong to both an account
 * and an opportunity, and cannot float free.
 *
 * WEB-TO-LEAD (brief §1 "web lead capture")
 * -----------------------------------------
 * There was no public endpoint a marketing form could post to. Leads could only
 * be created by an authenticated user, so every web enquiry was retyped by hand.
 *
 * A public write endpoint needs a key that identifies the form, can be revoked
 * without touching code, and carries its own limits — hence `web_lead_forms`
 * rather than a shared secret in an env var. `submission_count` and
 * `last_submission_at` make abuse visible; `is_active` makes it stoppable.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // ── account hierarchy ──────────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS parent_account_id INTEGER`);
  await knex.raw(`
    DO $do$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_parent_account_id_fkey') THEN
        ALTER TABLE accounts ADD CONSTRAINT accounts_parent_account_id_fkey
          FOREIGN KEY (parent_account_id) REFERENCES accounts(id) ON DELETE SET NULL;
      END IF;
    END
    $do$;
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_accounts_parent ON accounts (parent_account_id)
     WHERE parent_account_id IS NOT NULL
  `);

  // Cycle guard. A self-parent is the obvious case; a longer loop (A→B→A) is the
  // one that actually reaches production, and only a walk can catch it.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION accounts_reject_hierarchy_cycle()
    RETURNS trigger AS $fn$
    DECLARE
      cursor_id INTEGER := NEW.parent_account_id;
      hops      INTEGER := 0;
    BEGIN
      IF NEW.parent_account_id IS NULL THEN
        RETURN NEW;
      END IF;
      IF NEW.parent_account_id = NEW.id THEN
        RAISE EXCEPTION 'An account cannot be its own parent (account %)', NEW.id;
      END IF;

      WHILE cursor_id IS NOT NULL LOOP
        hops := hops + 1;
        IF cursor_id = NEW.id THEN
          RAISE EXCEPTION 'Account hierarchy cycle: % would become its own ancestor', NEW.id;
        END IF;
        IF hops > 50 THEN
          RAISE EXCEPTION 'Account hierarchy deeper than 50 levels; refusing to add another';
        END IF;
        SELECT parent_account_id INTO cursor_id FROM accounts WHERE id = cursor_id;
      END LOOP;

      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_accounts_hierarchy_cycle ON accounts`);
  await knex.raw(`
    CREATE TRIGGER trg_accounts_hierarchy_cycle
      BEFORE INSERT OR UPDATE OF parent_account_id ON accounts
      FOR EACH ROW EXECUTE FUNCTION accounts_reject_hierarchy_cycle()
  `);

  // ── account / opportunity teams ────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS crm_team_members (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER     NOT NULL REFERENCES companies(id),
      account_id     INTEGER         NULL REFERENCES accounts(id)      ON DELETE CASCADE,
      opportunity_id INTEGER         NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      employee_id    INTEGER     NOT NULL REFERENCES employees(id)     ON DELETE CASCADE,
      team_role      VARCHAR(40) NOT NULL DEFAULT 'contributor',
      access_level   VARCHAR(20) NOT NULL DEFAULT 'read',
      added_by       INTEGER         NULL REFERENCES employees(id),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      -- Exactly one parent. Without this a row can name both (which record does
      -- it belong to?) or neither (a team member of nothing).
      CONSTRAINT crm_team_members_one_parent CHECK (
        (account_id IS NOT NULL AND opportunity_id IS NULL) OR
        (account_id IS NULL AND opportunity_id IS NOT NULL)
      ),
      CONSTRAINT crm_team_members_role_check CHECK (
        team_role IN ('owner','sales_lead','technical','commercial','executive_sponsor','support','contributor')
      ),
      CONSTRAINT crm_team_members_access_check CHECK (
        access_level IN ('read','edit')
      )
    )
  `);
  // One membership per person per record. COALESCE because a NULL never equals a
  // NULL in a unique index, which would let the same person be added twice.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_team_member
      ON crm_team_members (COALESCE(account_id, -1), COALESCE(opportunity_id, -1), employee_id)
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_team_account     ON crm_team_members (account_id)     WHERE account_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_team_opportunity ON crm_team_members (opportunity_id) WHERE opportunity_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_crm_team_employee    ON crm_team_members (company_id, employee_id)`);

  // ── web-to-lead ────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS web_lead_forms (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER      NOT NULL REFERENCES companies(id),
      name                VARCHAR(120) NOT NULL,
      form_key            VARCHAR(64)  NOT NULL UNIQUE,
      lead_source         VARCHAR(60)  NOT NULL DEFAULT 'Website',
      default_zone        VARCHAR(40)      NULL,
      default_industry    VARCHAR(80)      NULL,
      -- Origins allowed to post. Empty means "any", which is a deliberate choice
      -- a person has to make rather than a default that silently allows all.
      allowed_origins     JSONB        NOT NULL DEFAULT '[]'::jsonb,
      max_per_hour        INTEGER      NOT NULL DEFAULT 60,
      is_active           BOOLEAN      NOT NULL DEFAULT true,
      submission_count    INTEGER      NOT NULL DEFAULT 0,
      last_submission_at  TIMESTAMPTZ      NULL,
      created_by          INTEGER          NULL REFERENCES employees(id),
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_web_lead_forms_company ON web_lead_forms (company_id) WHERE is_active`);

  // Every submission, accepted or not. A rejected submission is the only record
  // that a form is being abused or that a legitimate enquiry was lost.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS web_lead_submissions (
      id           SERIAL PRIMARY KEY,
      form_id      INTEGER      NOT NULL REFERENCES web_lead_forms(id) ON DELETE CASCADE,
      company_id   INTEGER      NOT NULL REFERENCES companies(id),
      lead_id      INTEGER          NULL REFERENCES leads(id) ON DELETE SET NULL,
      status       VARCHAR(20)  NOT NULL DEFAULT 'accepted',
      reason       TEXT             NULL,
      payload      JSONB            NULL,
      ip_address   VARCHAR(64)      NULL,
      user_agent   TEXT             NULL,
      created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT web_lead_submissions_status_check CHECK (
        status IN ('accepted','duplicate','rejected','rate_limited','spam')
      )
    )
  `);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_web_lead_submissions_form ON web_lead_submissions (form_id, created_at DESC)`);

  console.log('[account_hierarchy_teams_webtolead] accounts.parent_account_id + cycle guard, crm_team_members, web_lead_forms/submissions');
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS web_lead_submissions`);
  await knex.raw(`DROP TABLE IF EXISTS web_lead_forms`);
  await knex.raw(`DROP TABLE IF EXISTS crm_team_members`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_accounts_hierarchy_cycle ON accounts`);
  await knex.raw(`DROP FUNCTION IF EXISTS accounts_reject_hierarchy_cycle()`);
  await knex.raw(`DROP INDEX IF EXISTS idx_accounts_parent`);
  await knex.raw(`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_parent_account_id_fkey`);
  await knex.raw(`ALTER TABLE accounts DROP COLUMN IF EXISTS parent_account_id`);
}
