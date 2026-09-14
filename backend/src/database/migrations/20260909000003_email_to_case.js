/**
 * 20260909000003_email_to_case.js
 *
 * Email-to-case: a customer emails support and a ticket exists, with their reply
 * threaded onto it instead of starting a new one.
 *
 * WHAT EXISTED
 * ------------
 * `support_tickets` has requester_email, and `ticket_conversations` holds the
 * thread — but nothing could turn an inbound message INTO either. Every ticket
 * had to be typed by an agent, which means the channel customers actually use
 * was the one channel the system could not receive on.
 *
 * ⚠ NO FAKE INBOX. This migration and the route that uses it accept messages
 * that genuinely arrive — posted by a mail provider's webhook or by an IMAP
 * poller running against a real mailbox. Nothing here invents mail, and the
 * ingestion endpoint refuses unauthenticated posts, because an open endpoint
 * that creates tickets from arbitrary JSON is a spam relay with a database
 * behind it.
 *
 * THREADING
 * ---------
 * Three keys, in order of reliability:
 *   1. an explicit case reference in the subject (the token WE put there);
 *   2. RFC 5322 In-Reply-To / References naming a message we sent;
 *   3. same sender + same normalised subject within a recent window.
 * Rule 3 is a heuristic and is deliberately last and time-bounded: matching on
 * subject alone would thread two unrelated "Not working" emails from the same
 * customer six months apart into one case.
 *
 * NOTE: the migration runner passes a THIN PG SHIM, not knex — .raw() only.
 */

export async function up(knex) {
  // ── the mailboxes we accept mail for ─────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS support_mailboxes (
      id              SERIAL PRIMARY KEY,
      company_id      INTEGER      NOT NULL REFERENCES companies(id),
      email_address   VARCHAR(255) NOT NULL,
      display_name    VARCHAR(160)     NULL,
      -- Shared secret the provider's webhook must present. Without one, anybody
      -- who finds the URL can open tickets in this company's name.
      ingest_secret   VARCHAR(120)     NULL,
      default_team    VARCHAR(80)      NULL,
      default_priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
      default_category VARCHAR(80)     NULL,
      auto_reply      BOOLEAN      NOT NULL DEFAULT false,
      is_active       BOOLEAN      NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_support_mailbox UNIQUE (company_id, email_address)
    )
  `);

  // ── every inbound message, whether or not it became a ticket ─────────────
  // Kept even when rejected: "why did that customer's email never arrive" is
  // otherwise unanswerable, and it is the first question support asks.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS inbound_emails (
      id             SERIAL PRIMARY KEY,
      company_id     INTEGER          NULL REFERENCES companies(id),
      mailbox_id     INTEGER          NULL REFERENCES support_mailboxes(id),
      message_id     VARCHAR(998)     NULL,
      in_reply_to    VARCHAR(998)     NULL,
      references_hdr TEXT             NULL,
      from_email     VARCHAR(320)     NULL,
      from_name      VARCHAR(255)     NULL,
      to_email       VARCHAR(320)     NULL,
      subject        TEXT             NULL,
      body_text      TEXT             NULL,
      body_html      TEXT             NULL,
      received_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      status         VARCHAR(20)  NOT NULL DEFAULT 'received',
      ticket_id      INTEGER          NULL,
      threaded_by    VARCHAR(20)      NULL,
      reject_reason  TEXT             NULL,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT inbound_email_status_check CHECK (status IN
        ('received','created_ticket','appended','rejected','duplicate','ignored')),
      CONSTRAINT inbound_email_threaded_by_check CHECK (threaded_by IS NULL OR threaded_by IN
        ('subject_token','in_reply_to','heuristic'))
    )
  `);

  // ⚠ IDEMPOTENCY. Providers retry webhooks, and a retried delivery must not
  // open a second ticket. Partial, because message_id is occasionally absent
  // from malformed mail and NULLs must not collide with each other.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_email_message_id
      ON inbound_emails (company_id, message_id)
     WHERE message_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_inbound_emails_thread
      ON inbound_emails (company_id, from_email, received_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_inbound_emails_ticket
      ON inbound_emails (ticket_id)
  `);

  // ── the outbound message ids we can be replied TO ────────────────────────
  // Rule 2 threading needs to recognise our own Message-ID coming back in an
  // In-Reply-To header, which means remembering what we sent.
  await knex.raw(`
    ALTER TABLE ticket_conversations ADD COLUMN IF NOT EXISTS message_id VARCHAR(998)
  `);
  await knex.raw(`
    ALTER TABLE ticket_conversations ADD COLUMN IF NOT EXISTS in_reply_to VARCHAR(998)
  `);
  await knex.raw(`
    ALTER TABLE ticket_conversations ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'web'
  `);
  await knex.raw(`
    ALTER TABLE ticket_conversations ADD COLUMN IF NOT EXISTS inbound_email_id INTEGER
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_ticket_conversations_message_id
      ON ticket_conversations (message_id) WHERE message_id IS NOT NULL
  `);

  // How a ticket arrived. Existing rows are 'web' — they were all typed in.
  await knex.raw(`
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS channel VARCHAR(20) NOT NULL DEFAULT 'web'
  `);
  await knex.raw(`
    ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS requester_name_raw VARCHAR(255)
  `);

  const { rows: [n] } = await knex.raw(
    `SELECT COUNT(*)::int AS mailboxes FROM support_mailboxes`);
  console.log(`[email_to_case] tables ready, ${n.mailboxes} mailboxes configured`);
}

export async function down(knex) {
  await knex.raw(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS requester_name_raw`);
  await knex.raw(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS channel`);
  await knex.raw(`DROP INDEX IF EXISTS idx_ticket_conversations_message_id`);
  for (const c of ['inbound_email_id', 'channel', 'in_reply_to', 'message_id']) {
    await knex.raw(`ALTER TABLE ticket_conversations DROP COLUMN IF EXISTS ${c}`);
  }
  await knex.raw(`DROP TABLE IF EXISTS inbound_emails`);
  await knex.raw(`DROP TABLE IF EXISTS support_mailboxes`);
}
