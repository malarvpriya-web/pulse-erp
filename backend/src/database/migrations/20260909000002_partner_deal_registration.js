/**
 * 20260909000002_partner_deal_registration.js
 *
 * Deal registration — the mechanism that stops two partners, or a partner and
 * the direct sales team, working the same customer and then arguing about who
 * gets paid.
 *
 * `sales_partners` exists (5 rows) and carries a commission_pct, but there was
 * nothing a partner could register a deal AGAINST. Without it "partner channel"
 * means a list of partner names: no claim, no approval, no protection window,
 * and no link from a registration to the opportunity it became — so commission
 * attribution had no evidence behind it.
 *
 * WHAT MAKES A REGISTRATION REAL
 * ------------------------------
 *   - a CLAIM: this partner, this end customer, this scope, this value;
 *   - an APPROVAL decision by someone other than the partner;
 *   - a PROTECTION WINDOW with an expiry, so an approved-and-forgotten
 *     registration does not lock a customer for ever;
 *   - CONFLICT DETECTION against live registrations for the same customer;
 *   - a link to the opportunity, so the commission has a paper trail.
 *
 * A partial unique index enforces the protection in the DATABASE rather than in
 * a handler: two concurrent approvals for the same customer would both pass an
 * application-level check and both commit.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS partner_deal_registrations (
      id                  SERIAL PRIMARY KEY,
      company_id          INTEGER      NOT NULL REFERENCES companies(id),
      registration_number VARCHAR(40)      NULL,
      partner_id          INTEGER      NOT NULL REFERENCES sales_partners(id),

      -- The end customer, however the partner can identify them. A registration
      -- usually arrives BEFORE the customer exists as a party, so the name is
      -- required and the link is optional — demanding a customer_id would make
      -- the feature unusable at exactly the moment it matters.
      customer_name       VARCHAR(255) NOT NULL,
      customer_id         INTEGER          NULL,
      contact_name        VARCHAR(160)     NULL,
      contact_email       VARCHAR(255)     NULL,
      contact_phone       VARCHAR(40)      NULL,
      region              VARCHAR(80)      NULL,

      deal_description    TEXT             NULL,
      estimated_value     NUMERIC(14,2)    NULL,
      expected_close_date DATE             NULL,

      status              VARCHAR(20)  NOT NULL DEFAULT 'submitted',
      protection_days     INTEGER      NOT NULL DEFAULT 90,
      approved_at         TIMESTAMPTZ      NULL,
      approved_by         INTEGER          NULL REFERENCES employees(id),
      expires_at          TIMESTAMPTZ      NULL,
      rejected_reason     TEXT             NULL,

      -- What it became. Both nullable: a registration that never converts is the
      -- normal case, and the whole point is to know that.
      lead_id             INTEGER          NULL,
      opportunity_id      INTEGER          NULL,
      converted_at        TIMESTAMPTZ      NULL,
      outcome             VARCHAR(20)      NULL,

      submitted_by        INTEGER          NULL REFERENCES employees(id),
      created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

      CONSTRAINT pdr_status_check CHECK (status IN
        ('submitted','approved','rejected','expired','converted','lost','withdrawn')),
      CONSTRAINT pdr_outcome_check CHECK (outcome IS NULL OR outcome IN ('won','lost','expired')),
      CONSTRAINT pdr_value_check CHECK (estimated_value IS NULL OR estimated_value >= 0),
      CONSTRAINT pdr_protection_check CHECK (protection_days > 0 AND protection_days <= 365)
    )
  `);

  // ⚠ THE PROTECTION RULE, IN THE DATABASE.
  // One live registration per customer per company. Enforced as a partial unique
  // index on the normalised customer name, because two partners registering the
  // same customer at the same moment would both pass an application-level
  // "is there a conflict?" query and both commit — which is precisely the
  // dispute this feature exists to prevent.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_registration_live_customer
      ON partner_deal_registrations (company_id, LOWER(TRIM(customer_name)))
   WHERE status = 'approved'
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_deal_registration_partner
      ON partner_deal_registrations (company_id, partner_id, status)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_deal_registration_expiry
      ON partner_deal_registrations (status, expires_at)
     WHERE status = 'approved'
  `);

  // Decision history. An approval that cannot be traced to a person and a moment
  // is not an approval, and this is a commercial commitment worth real money.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS partner_deal_registration_events (
      id              SERIAL PRIMARY KEY,
      registration_id INTEGER     NOT NULL REFERENCES partner_deal_registrations(id) ON DELETE CASCADE,
      company_id      INTEGER         NULL,
      event           VARCHAR(30) NOT NULL,
      detail          TEXT            NULL,
      actor_employee  INTEGER         NULL REFERENCES employees(id),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_deal_registration_events
      ON partner_deal_registration_events (registration_id, created_at DESC)
  `);

  // Attribution on the opportunity itself, so a deal that came through a partner
  // says so where the money is recorded rather than only in the channel module.
  await knex.raw(`
    ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS deal_registration_id INTEGER
  `);

  console.log('[partner_deal_registration] tables created, protection index active');
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE opportunities DROP COLUMN IF EXISTS deal_registration_id`);
  await knex.raw(`DROP TABLE IF EXISTS partner_deal_registration_events`);
  await knex.raw(`DROP TABLE IF EXISTS partner_deal_registrations`);
}
