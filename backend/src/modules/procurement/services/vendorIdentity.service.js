/**
 * vendorIdentity.service.js — the ONE place a vendor's finance identity is resolved.
 *
 * WHY THIS EXISTS
 * ---------------
 * Procurement's vendor master (`vendors`, integer PK) and Finance's party ledger
 * (`parties`, uuid PK) are two different tables describing the same counterparty.
 * Every payable document FKs the party: `bills.supplier_id -> parties(id)`,
 * `payments.party_id -> parties(id)`. Nothing in procurement produced a party, so
 * the two masters were bridged AT RUNTIME, BY NAME:
 *
 *   -- procurement.routes.js, 3-way-match approval (the only path that raises an
 *   -- AP bill from a receipt):
 *   SELECT id FROM parties WHERE LOWER(name) = LOWER($1) AND deleted_at IS NULL LIMIT 1
 *
 *   -- paymentBatch.service.js, the payment run:
 *   (SELECT id FROM parties WHERE LOWER(name) = LOWER(v.vendor_name) ...) AS matched_id
 *
 * A name match is not an identity. It fails three ways, all of them silent:
 *   - MISS  — "Dell Technologies" (vendor) vs "Dell Technologies Pvt Ltd" (party)
 *             resolves to NULL, the bill is raised with no supplier_id at all and
 *             drops out of AP ageing, vendor statements and the payment run.
 *   - WRONG — two companies in one database with a similarly named supplier
 *             resolve to whichever row LIMIT 1 happened to return. The LOWER(name)
 *             lookup carried NO company predicate, so a cross-tenant hit was
 *             reachable: a bill in company 1 payable to company 2's party.
 *   - DRIFT — renaming either side silently severs every future document while
 *             leaving the historic ones pointing at the old identity.
 *
 * `vendors.party_id` (uuid, FK to parties, added by migration 20260722000002)
 * is the deterministic join key. It existed but was populated on 0 of 6 rows:
 * that migration's backfill matched `party_type ILIKE 'vendor' OR 'both'` while
 * every supplier party in this database is typed 'Supplier', so it matched
 * nothing — and nothing at runtime ever set the column either.
 *
 * THE CONTRACT
 * ------------
 * Every path that brings a vendor into existence, or that needs a vendor's
 * finance identity, calls resolveVendorParty(). It is idempotent, transaction-
 * scoped, and never fabricates a link:
 *
 *   1. an existing vendors.party_id is verified and returned (already bound);
 *   2. else exact GSTIN match within the vendor's company — GSTIN is a legal
 *      identity and outranks a name;
 *   3. else normalised-name match within the vendor's company, using the same
 *      crm_norm_name() SQL function the customer side is keyed on, so
 *      "ABC Pvt Ltd" and "ABC Private Limited" are one supplier, not two;
 *   4. else a new Supplier party is created from the vendor's own trading
 *      identity and bound.
 *
 * Step 4 is the important one. Creating the party is what makes the mapping
 * DETERMINISTIC rather than best-effort: after this runs, every vendor has
 * exactly one party and no downstream code ever has to guess again. The
 * alternative — leaving party_id NULL when no match is found — is what produced
 * the silent-miss failure above.
 *
 * SAFEGUARDS (enforced in the database by migration 20260903000010)
 *   - vendors_party_id_unique   one party may back at most one vendor, so two
 *                               vendor rows can never both draw on the same AP
 *                               ledger identity;
 *   - vendors_party_company_ck  trigger: a vendor may only bind a party in its
 *                               own company (or a global NULL-company party),
 *                               which closes the cross-tenant bridge by
 *                               construction rather than by predicate hygiene.
 */
import pool from '../../shared/db.js';

/**
 * The party_type values that denote a payable counterparty.
 *
 * 'Supplier' is what this database actually uses (5 rows, SUPP-001..005);
 * 'Vendor' and 'Both' are accepted because the 20260722000002 migration and the
 * parties-schema hardening notes both name them, and a deployment that seeded
 * either must not silently mint duplicates. Compared case-insensitively — the
 * column is a bare varchar with no check constraint.
 */
export const SUPPLIER_PARTY_TYPES = ['supplier', 'vendor', 'both'];

/**
 * Next code in the SUPP-nnn series.
 *
 * Scoped to supplier-type parties on purpose: customers run their own CUST-nnn
 * series (see customerIdentity.service.nextPartyCode) and sharing one counter
 * across both would make every new supplier code jump by the customer count.
 * Caller must hold a transaction — this is a read-then-insert.
 */
async function nextSupplierPartyCode(client) {
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(party_code, '\\D', '', 'g'), ''))::int, 0) AS mx
       FROM parties p
      WHERE LOWER(p.party_type) = ANY($1)`,
    [SUPPLIER_PARTY_TYPES]
  );
  return `SUPP-${String((rows[0]?.mx ?? 0) + 1).padStart(3, '0')}`;
}

/**
 * Bind a vendor to its canonical finance party, creating the party if needed.
 *
 * @param {object} client  an open transaction client — identity creation MUST
 *                         commit or roll back with whatever caused it.
 * @param {number} vendorId
 * @param {object} [opts]
 * @param {boolean} [opts.create=true]  when false, resolve only: returns
 *                         `{ party: null }` instead of minting one. For
 *                         read-only reporting paths that must not write.
 * @returns {Promise<{party: object|null, vendor: object, created: boolean, matchedOn: string}>}
 */
export async function resolveVendorParty(client, vendorId, { create = true } = {}) {
  const id = parseInt(vendorId, 10);
  if (!Number.isFinite(id)) {
    throw Object.assign(new Error('A vendor id is required to resolve a finance identity'), { status: 400 });
  }

  // FOR UPDATE: two concurrent requests for the same never-bound vendor would
  // otherwise both fall through to step 4 and mint two parties for one supplier
  // — the exact duplicate-identity problem this service exists to prevent.
  // Locking the vendor row serialises them; the loser re-reads a bound party_id.
  const { rows: vendorRows } = await client.query(
    `SELECT id, vendor_name, name, gstin, pan, email, phone, website, address, city, state,
            country, postal_code, company_id, party_id, payment_terms_days, credit_limit,
            bank_name, account_number, ifsc, udyam_number
       FROM vendors
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [id]
  );
  const vendor = vendorRows[0];
  if (!vendor) {
    throw Object.assign(new Error(`Vendor ${id} not found`), { status: 404 });
  }

  // 1. Already bound
  if (vendor.party_id) {
    const { rows } = await client.query(
      `SELECT * FROM parties WHERE id = $1 AND deleted_at IS NULL`, [vendor.party_id]
    );
    if (rows[0]) return { party: rows[0], vendor, created: false, matchedOn: 'existing' };
    // The FK guarantees the row exists; a soft-delete does not. A vendor whose
    // party was archived is re-resolved rather than left pointing at an identity
    // no AP screen will show.
    await client.query(`UPDATE vendors SET party_id = NULL WHERE id = $1`, [id]);
    vendor.party_id = null;
  }

  const displayName = String(vendor.vendor_name || vendor.name || '').trim();
  if (!displayName) {
    throw Object.assign(
      new Error(`Vendor ${id} has no name — a finance party cannot be created without one`),
      { status: 422 }
    );
  }

  // 2. GSTIN — a legal identity outranks a name
  if (vendor.gstin) {
    const { rows } = await client.query(
      `SELECT p.* FROM parties p
        WHERE p.gstin = $1 AND p.deleted_at IS NULL
          AND (p.company_id IS NOT DISTINCT FROM $2 OR p.company_id IS NULL)
          AND LOWER(p.party_type) = ANY($3)
          AND NOT EXISTS (SELECT 1 FROM vendors v2 WHERE v2.party_id = p.id AND v2.id <> $4)
        ORDER BY (p.company_id IS NOT NULL) DESC, p.created_at
        LIMIT 1`,
      [vendor.gstin, vendor.company_id, SUPPLIER_PARTY_TYPES, id]
    );
    if (rows[0]) return bind(client, id, rows[0], vendor, 'gstin');
  }

  // 3. Normalised name, within the vendor's own company.
  // crm_norm_name() is the same function the customer-side unique index is built
  // on (migration 20260819000002), so both masters agree on what "the same
  // organisation" means. The company predicate is what the old runtime
  // LOWER(name) lookup was missing.
  {
    const { rows } = await client.query(
      `SELECT p.* FROM parties p
        WHERE p.deleted_at IS NULL
          AND (p.company_id IS NOT DISTINCT FROM $1)
          AND LOWER(p.party_type) = ANY($2)
          AND crm_norm_name(p.name) = crm_norm_name($3)
          AND NOT EXISTS (SELECT 1 FROM vendors v2 WHERE v2.party_id = p.id AND v2.id <> $4)
        ORDER BY p.created_at
        LIMIT 1`,
      [vendor.company_id, SUPPLIER_PARTY_TYPES, displayName, id]
    );
    if (rows[0]) return bind(client, id, rows[0], vendor, 'name');
  }

  if (!create) return { party: null, vendor, created: false, matchedOn: 'none' };

  // 4. Mint the party from the vendor's own trading identity.
  const code = await nextSupplierPartyCode(client);
  const { rows } = await client.query(
    `INSERT INTO parties
       (party_code, party_type, name, email, phone, mobile, address, city, state,
        country, pincode, website, gstin, pan, company_id, currency, payment_terms, credit_limit,
        bank_name, bank_account, ifsc, msme_number, is_active)
     VALUES ($1,'Supplier',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'INR',$15,$16,$17,$18,$19,$20,true)
     RETURNING *`,
    [
      code, displayName, vendor.email, vendor.phone, vendor.phone, vendor.address, vendor.city,
      vendor.state, vendor.country || 'India', vendor.postal_code, vendor.website, vendor.gstin,
      vendor.pan, vendor.company_id,
      // parties.payment_terms is a day count, the same unit as vendors.payment_terms_days.
      vendor.payment_terms_days ?? 30,
      vendor.credit_limit ?? 0,
      vendor.bank_name, vendor.account_number, vendor.ifsc, vendor.udyam_number,
    ]
  );
  return bind(client, id, rows[0], vendor, 'created', true);
}

async function bind(client, vendorId, party, vendor, matchedOn, created = false) {
  await client.query(`UPDATE vendors SET party_id = $1, updated_at = NOW() WHERE id = $2`, [party.id, vendorId]);
  return { party, vendor: { ...vendor, party_id: party.id }, created, matchedOn };
}

/**
 * The party id for a vendor, resolving and binding it if this is the first time.
 * Convenience wrapper for callers that only want the uuid.
 */
export async function vendorPartyId(client, vendorId, opts) {
  const { party } = await resolveVendorParty(client, vendorId, opts);
  return party?.id ?? null;
}

/**
 * Read-only lookup for report/analytics paths that must not write.
 * Returns null when the vendor has never been bound — callers should treat that
 * as "no finance identity yet", not as "no spend".
 */
export async function lookupVendorPartyId(vendorId, client = null) {
  const db = client ?? pool;
  const { rows } = await db.query(
    `SELECT party_id FROM vendors WHERE id = $1 AND deleted_at IS NULL`, [vendorId]
  );
  return rows[0]?.party_id ?? null;
}

export default { resolveVendorParty, vendorPartyId, lookupVendorPartyId, SUPPLIER_PARTY_TYPES };
