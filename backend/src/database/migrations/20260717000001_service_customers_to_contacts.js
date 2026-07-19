/**
 * 20260717000001_service_customers_to_contacts.js
 *
 * Service "Customers" grid was backed by `service_customers` — a flat, FK-less
 * table created inline by the servicedesk route module. It duplicated the CRM
 * customer master and was at the wrong grain: it mixed people and companies,
 * while CRM already models this as accounts(company) 1-N contacts(person).
 *
 * Audit of the live DB (2026-07-17) found:
 *   - service_customers: 0 rows, 0 inbound FKs  -> nothing depends on it
 *   - support_tickets.customer_id: exists, no FK, NULL in 12/12 rows -> unused
 *
 * So this migration makes `contacts` (under `accounts`) the single customer
 * master for Service, and wires the ticket -> customer backbone that was never
 * attached. It does NOT drop service_customers — that is a separate, explicit
 * step so the drop stays reversible on its own.
 *
 *   contacts.photo_url      TEXT             avatar for the grid (fallback = initials)
 *   contacts.customer_role  TEXT 'User'      role badge; 'User' | 'Admin'
 *   support_tickets.customer_id  -> accounts(id)  ON DELETE SET NULL  (company)
 *   support_tickets.contact_id   -> contacts(id)  ON DELETE SET NULL  (person)
 *
 * phone -> mobile normalization: the 10-digit Indian mobile numbers live in
 * contacts.phone while contacts.mobile is NULL, so the grid's Mobile column
 * would render blank. Numbers matching ^[6-9]\d{9}$ are copied into `mobile`
 * (phone is preserved as-is for landlines and is not cleared).
 */

const IN_MOBILE = `^[6-9][0-9]{9}$`;

export async function up(knex) {
  let sp = 0;
  const safe = async (sql) => {
    const name = `sp_sc2c_${sp++}`;
    await knex.raw(`SAVEPOINT ${name}`);
    try {
      await knex.raw(sql);
      await knex.raw(`RELEASE SAVEPOINT ${name}`);
    } catch (err) {
      await knex.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      if (!/already exists|does not exist|duplicate column|duplicate object/i.test(err.message || '')) throw err;
    }
  };

  // ── grid columns CRM lacks ───────────────────────────────────────────────────
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS photo_url     TEXT`);
  await safe(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS customer_role TEXT DEFAULT 'User'`);
  await safe(`UPDATE contacts SET customer_role = 'User' WHERE customer_role IS NULL`);
  await safe(`ALTER TABLE contacts ADD CONSTRAINT chk_contacts_customer_role CHECK (customer_role IN ('User','Admin'))`);

  // ── mobile normalization (see header) ────────────────────────────────────────
  await safe(`
    UPDATE contacts
       SET mobile = regexp_replace(phone, '[^0-9]', '', 'g')
     WHERE mobile IS NULL
       AND phone IS NOT NULL
       AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '${IN_MOBILE}'
  `);

  // ── ticket -> customer backbone (both columns are 100% NULL today) ───────────
  await safe(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_id INTEGER`);
  await safe(`
    ALTER TABLE support_tickets
      ADD CONSTRAINT fk_support_tickets_customer
      FOREIGN KEY (customer_id) REFERENCES accounts(id) ON DELETE SET NULL
  `);
  await safe(`
    ALTER TABLE support_tickets
      ADD CONSTRAINT fk_support_tickets_contact
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  `);

  // Best-effort backfill by requester email. Existing demo tickets use internal
  // @pulse.com requesters that match no contact, so this legitimately links 0
  // rows on the current dataset — it is here for real data.
  await safe(`
    UPDATE support_tickets t
       SET contact_id = c.id
      FROM contacts c
     WHERE t.contact_id IS NULL
       AND t.requester_email IS NOT NULL
       AND c.deleted_at IS NULL
       AND LOWER(c.email) = LOWER(t.requester_email)
  `);
  await safe(`
    UPDATE support_tickets t
       SET customer_id = c.account_id
      FROM contacts c
     WHERE t.customer_id IS NULL
       AND t.contact_id = c.id
       AND c.account_id IS NOT NULL
  `);

  await safe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_contact  ON support_tickets(contact_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON support_tickets(customer_id)`);
  await safe(`CREATE INDEX IF NOT EXISTS idx_contacts_account         ON contacts(account_id)`);
}

export async function down(knex) {
  const safe = async (sql) => { try { await knex.raw(sql); } catch { /* ignore */ } };
  await safe(`DROP INDEX IF EXISTS idx_contacts_account`);
  await safe(`DROP INDEX IF EXISTS idx_support_tickets_customer`);
  await safe(`DROP INDEX IF EXISTS idx_support_tickets_contact`);
  await safe(`ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS fk_support_tickets_contact`);
  await safe(`ALTER TABLE support_tickets DROP CONSTRAINT IF EXISTS fk_support_tickets_customer`);
  await safe(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS contact_id`);
  await safe(`ALTER TABLE contacts DROP CONSTRAINT IF EXISTS chk_contacts_customer_role`);
  await safe(`ALTER TABLE contacts DROP COLUMN IF EXISTS customer_role`);
  await safe(`ALTER TABLE contacts DROP COLUMN IF EXISTS photo_url`);
  // mobile backfill is intentionally not reverted: phone was never cleared, so
  // the copy is additive and dropping it could destroy user-entered mobiles.
}
