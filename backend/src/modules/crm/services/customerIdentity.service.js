/**
 * customerIdentity.service.js — the ONE place a customer identity is resolved.
 *
 * WHY THIS EXISTS
 * ---------------
 * The CRM audit (2026-08-19) found two disjoint customer masters: CRM wrote
 * `accounts` (integer PK) while Sales/Finance wrote `parties` (uuid PK), and the
 * bridge column `accounts.party_id` was set on 1 of 7 rows. The consequence was
 * that a customer acquired in CRM had no commercial identity and a customer
 * being invoiced had no CRM history — quotations, sales orders and invoices FK
 * `parties`, but nothing in CRM ever produced a party.
 *
 * The resolution is a master/extension architecture, NOT a replica and NOT a
 * sync job:
 *
 *   parties   → the canonical customer. One row per real organisation. This is
 *               what every commercial document references.
 *   accounts  → a CRM-attribute extension of a party (industry, revenue band,
 *               logo, assigned rep). MUST carry party_id; enforced NOT NULL by
 *               migration 20260819000002.
 *
 * Every path that can bring a new customer into existence — account creation,
 * lead conversion, quotation creation — goes through `resolveCustomer()` so a
 * second identity for the same organisation can never be minted.
 *
 * All functions take an explicit `client` so callers can run them inside their
 * own transaction; identity creation must commit or roll back with the business
 * record that caused it.
 */

/**
 * JS mirror of the `crm_norm_name(text)` SQL function created in migration
 * 20260819000002. Both MUST stay identical — the unique index
 * `accounts_company_normname_unique` is built on the SQL one, so a divergence
 * would let the application believe a name is free that the database rejects.
 *
 * Collapses legal-form and punctuation noise so these all share a key:
 *   "ABC Engineering Pvt Ltd" / "ABC Engineering Private Limited"
 *   "ABC Engineering Pvt. Ltd." / "ABC ENGINEERING"
 */
export function normalizeOrgName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|llp|inc|incorporated|corporation|corp|company|co)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Next party_code in the existing CUST-nnn series. Caller must hold a transaction. */
async function nextPartyCode(client) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(party_code, '\\D', '', 'g'), ''))::int, 0) AS mx
       FROM parties`
  );
  return `CUST-${String((rows[0]?.mx ?? 0) + 1).padStart(3, '0')}`;
}

/**
 * Find the canonical party for an organisation name, creating it if absent.
 * Matching is on the normalised name within the company, so legal-form variants
 * resolve to the existing party instead of minting a second one.
 *
 * @returns {Promise<{party: object, created: boolean}>}
 */
export async function resolveOrCreateParty(client, {
  name, company_id = null, email = null, phone = null,
  website = null, industry = null, gstin = null,
}) {
  if (!name || !String(name).trim()) {
    throw Object.assign(new Error('Customer name is required to resolve an identity'), { status: 400 });
  }
  const clean = String(name).trim();

  // GSTIN is a legal identity — when present it outranks any name match.
  if (gstin) {
    const byGstin = await client.query(
      `SELECT * FROM parties
        WHERE gstin = $1 AND deleted_at IS NULL
          AND (company_id IS NOT DISTINCT FROM $2)
        LIMIT 1`,
      [gstin, company_id]
    );
    if (byGstin.rows[0]) return { party: byGstin.rows[0], created: false };
  }

  const existing = await client.query(
    `SELECT * FROM parties
      WHERE deleted_at IS NULL
        AND (company_id IS NOT DISTINCT FROM $1)
        AND crm_norm_name(name) = crm_norm_name($2)
      LIMIT 1`,
    [company_id, clean]
  );
  if (existing.rows[0]) return { party: existing.rows[0], created: false };

  const code = await nextPartyCode(client);
  const { rows } = await client.query(
    `INSERT INTO parties
       (party_code, party_type, name, email, phone, website, industry, gstin, company_id, is_active)
     VALUES ($1, 'Customer', $2, $3, $4, $5, $6, $7, $8, true)
     RETURNING *`,
    [code, clean, email, phone, website, industry, gstin, company_id]
  );
  return { party: rows[0], created: true };
}

/**
 * Resolve the full customer identity for a name: the canonical party AND its
 * CRM account extension, creating either where missing.
 *
 * This is what lead conversion and account creation call. It guarantees the
 * invariant the audit found broken everywhere:
 *   ONE CUSTOMER → ONE party.id → ONE accounts row → every document agrees.
 *
 * @returns {Promise<{party: object, account: object, createdParty: boolean, createdAccount: boolean}>}
 */
export async function resolveCustomer(client, {
  name, company_id = null, email = null, phone = null,
  website = null, industry = null, gstin = null,
  account_type = 'Customer', assigned_to = null,
}) {
  const { party, created: createdParty } = await resolveOrCreateParty(client, {
    name, company_id, email, phone, website, industry, gstin,
  });

  // An account may already exist for this party, or under a name variant that
  // normalises the same — check both so we extend rather than duplicate.
  const found = await client.query(
    `SELECT * FROM accounts
      WHERE deleted_at IS NULL
        AND (party_id = $1
             OR ((company_id IS NOT DISTINCT FROM $2)
                 AND crm_norm_name(COALESCE(name, account_name)) = crm_norm_name($3)))
      ORDER BY (party_id = $1) DESC
      LIMIT 1`,
    [party.id, company_id, name]
  );

  if (found.rows[0]) {
    const account = found.rows[0];
    // Adopt an account that predates the party bridge.
    if (!account.party_id) {
      const { rows } = await client.query(
        `UPDATE accounts SET party_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [party.id, account.id]
      );
      return { party, account: rows[0], createdParty, createdAccount: false };
    }
    return { party, account, createdParty, createdAccount: false };
  }

  const { rows } = await client.query(
    // account_name is a GENERATED mirror of name (migration 20260819000004) —
    // writing it is now an error, and there is nothing to keep in sync.
    `INSERT INTO accounts
       (name, email, phone, website, industry,
        account_type, status, company_id, party_id, assigned_to)
     VALUES ($1, $2, $3, $4, $5, $6, 'Active', $7, $8, $9)
     RETURNING *`,
    [party.name, email, phone, website, industry, account_type, company_id, party.id, assigned_to]
  );
  return { party, account: rows[0], createdParty, createdAccount: true };
}

/**
 * Resolve a contact within an account without minting a second row for the same
 * person. Matched on email, else normalised mobile, else full name — the three
 * keys the audit's duplicate tests exercised.
 */
export async function resolveOrCreateContact(client, {
  account_id, company_id = null, first_name = '', last_name = '',
  full_name = null, email = null, phone = null, mobile = null,
  designation = null, is_primary = false,
}) {
  const name = (full_name || `${first_name} ${last_name}`).trim();
  if (!name) return { contact: null, created: false };

  const digits = String(mobile ?? '').replace(/[^0-9]/g, '');
  const { rows: hit } = await client.query(
    `SELECT * FROM contacts
      WHERE deleted_at IS NULL
        AND (company_id IS NOT DISTINCT FROM $1)
        AND (
             ($2::text IS NOT NULL AND $2 <> '' AND LOWER(email) = LOWER($2))
          OR ($3::text <> '' AND regexp_replace(COALESCE(mobile,''), '[^0-9]', '', 'g') = $3)
          OR (account_id = $4 AND LOWER(full_name) = LOWER($5))
        )
      LIMIT 1`,
    [company_id, email, digits, account_id, name]
  );
  if (hit[0]) return { contact: hit[0], created: false };

  const { rows } = await client.query(
    `INSERT INTO contacts
       (first_name, last_name, full_name, email, phone, mobile,
        designation, account_id, company_id, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      first_name || name.split(' ')[0] || name,
      last_name || name.split(' ').slice(1).join(' ') || '',
      name, email, phone, mobile, designation, account_id, company_id, is_primary,
    ]
  );
  return { contact: rows[0], created: true };
}

/**
 * Accounts that look like the same organisation as `name` but are not it —
 * powers the "possible duplicate" warning on create. Read-only; never merges.
 */
export async function findLikelyDuplicates(client, { name, company_id = null, excludeId = null }) {
  const key = normalizeOrgName(name);
  if (!key) return [];
  const { rows } = await client.query(
    `SELECT id, COALESCE(name, account_name) AS name, email, party_id
       FROM accounts
      WHERE deleted_at IS NULL
        AND (company_id IS NOT DISTINCT FROM $1)
        AND ($2::int IS NULL OR id <> $2)
        AND (crm_norm_name(COALESCE(name, account_name)) = $3
             OR crm_norm_name(COALESCE(name, account_name)) LIKE $3 || '%'
             OR $3 LIKE crm_norm_name(COALESCE(name, account_name)) || '%')
      LIMIT 5`,
    [company_id, excludeId, key]
  );
  return rows;
}

export default {
  normalizeOrgName,
  resolveOrCreateParty,
  resolveCustomer,
  resolveOrCreateContact,
  findLikelyDuplicates,
};
