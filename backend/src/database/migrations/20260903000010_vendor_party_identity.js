/**
 * Make the vendor -> finance-party mapping deterministic.
 *
 * THE PROBLEM
 * -----------
 * `bills.supplier_id` and `payments.party_id` both FK `parties(id)`. Procurement
 * owns `vendors` (integer PK) and never produced a party, so the only two code
 * paths that turn a receipt into money resolved the counterparty BY NAME at
 * runtime:
 *
 *   procurement.routes.js  3-way-match approve:
 *     SELECT id FROM parties WHERE LOWER(name) = LOWER($1) ... LIMIT 1
 *   paymentBatch.service.js  payment run:
 *     (SELECT id FROM parties WHERE LOWER(name) = LOWER(v.vendor_name) ...)
 *
 * Neither carried a company predicate, so the lookup could cross tenants, and a
 * near-miss on the name silently produced a bill with NULL supplier_id that then
 * disappears from AP ageing and the payment run.
 *
 * `vendors.party_id` was added for exactly this by migration 20260722000002 and
 * was populated on 0 of 6 rows, for two compounding reasons:
 *   - its backfill required `party_type ILIKE 'vendor' OR 'both'`, while every
 *     supplier party in this database is typed 'Supplier' — so it matched nothing
 *     even where the GSTINs agreed;
 *   - nothing at runtime ever wrote the column, so no vendor created since has
 *     been bound either.
 *
 * WHAT THIS DOES
 * --------------
 * 1. Backfills `vendors.party_id` for every live vendor, in a deterministic
 *    order — GSTIN, then normalised name within the same company, then MINT a
 *    Supplier party from the vendor's own trading identity. Step 3 is what makes
 *    this a mapping rather than a best-effort: after this migration no vendor is
 *    unbound, so no downstream code has to guess. It never invents a link between
 *    two rows that do not demonstrably describe the same organisation — an
 *    unmatched vendor gets its OWN new party, it is not attached to a plausible
 *    stranger.
 *
 * 2. Adds the two safeguards that make an invalid mapping unrepresentable:
 *      vendors_party_id_unique   — one party backs at most one vendor. Without
 *                                  it, two vendor rows could draw on the same AP
 *                                  ledger identity and vendor spend would double
 *                                  count.
 *      vendors_party_company_ck  — trigger: a vendor may bind only a party in its
 *                                  own company (a NULL-company/global party is
 *                                  allowed, matching companyOf()'s contract).
 *                                  This closes the cross-tenant bridge by
 *                                  construction, not by remembering a predicate.
 *
 * 3. Adopts existing AP rows onto the mapping. `bills` raised before this had
 *    their supplier resolved by that same name match, or not at all; where a bill
 *    is linked to a PO we can now assert the correct party from the PO's vendor
 *    instead. Only NULL supplier_id is filled — an existing link is never
 *    overwritten, because a human may have set it deliberately and a migration
 *    must not silently repoint money.
 *
 * NOT BROKEN BY THIS: no existing transactional row changes its amount, status
 * or ownership. The only writes are (a) a previously-NULL vendors.party_id,
 * (b) new parties rows, (c) a previously-NULL bills.supplier_id.
 */

const SUPPLIER_TYPES = ['supplier', 'vendor', 'both'];

/**
 * `parties` carries `chk_parties_gstin_format` and `vendors` carries nothing —
 * so the vendor master can hold a tax id the finance master will refuse. This
 * database has one: vendor 6 ('test') stores GSTIN '27AAAABB12C', eleven
 * characters where the format is fifteen, and PAN 'AABCT123', eight where it is
 * ten. Carrying either onto the new party aborts the whole migration on a check
 * violation.
 *
 * The vendor row keeps what it has — this migration does not get to decide that
 * someone's data is wrong — but the party is created with the tax id left NULL
 * and the vendor is named in the log, so the mapping still completes and the bad
 * value is visible rather than blocking. `vendorFields()` in procurement.routes.js
 * now rejects a malformed GSTIN/PAN at the write, so this can only ever apply to
 * rows that predate it.
 */
const GSTIN_RE = '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';
const PAN_RE   = '^[A-Z]{5}[0-9]{4}[A-Z]$';

export async function up(knex) {
  // ── 0. Pre-flight: the unique index cannot be built over existing duplicates.
  // There should be none (the column is empty), but a re-run after a partial
  // apply must not fail here.
  const { rows: dupes } = await knex.raw(`
    SELECT party_id, COUNT(*)::int AS n
      FROM vendors
     WHERE party_id IS NOT NULL AND deleted_at IS NULL
     GROUP BY party_id HAVING COUNT(*) > 1
  `);
  if (dupes.length) {
    // Keep the lowest vendor id bound; unbind the rest so they are re-resolved
    // into their own parties by the backfill below. Reported, never silent.
    await knex.raw(`
      UPDATE vendors v SET party_id = NULL
       WHERE v.party_id IS NOT NULL AND v.deleted_at IS NULL
         AND v.id <> (SELECT MIN(v2.id) FROM vendors v2
                       WHERE v2.party_id = v.party_id AND v2.deleted_at IS NULL)
    `);
    console.log(`[20260903000010] unbound ${dupes.reduce((s, d) => s + d.n - 1, 0)} duplicate vendor->party link(s) before adding the unique index`);
  }

  // ── 1a. GSTIN match — a legal identity, and the strongest evidence available.
  const { rows: byGstin } = await knex.raw(`
    UPDATE vendors v
       SET party_id = p.id, updated_at = NOW()
      FROM parties p
     WHERE v.party_id IS NULL
       AND v.deleted_at IS NULL
       AND v.gstin IS NOT NULL AND v.gstin <> ''
       AND p.gstin = v.gstin
       AND p.deleted_at IS NULL
       AND LOWER(p.party_type) = ANY($1)
       AND (p.company_id IS NOT DISTINCT FROM v.company_id OR p.company_id IS NULL)
       AND NOT EXISTS (SELECT 1 FROM vendors v2 WHERE v2.party_id = p.id AND v2.id <> v.id)
    RETURNING v.id
  `, [SUPPLIER_TYPES]);

  // ── 1b. Normalised name, within the same company.
  // crm_norm_name() is the function the customer-side unique index is built on,
  // so both masters agree on what "the same organisation" means. This is an
  // exact match on a normalised string, not a fuzzy one: "ABC Pvt Ltd" and
  // "ABC Private Limited" are the same supplier; "Dell" and "Dell India" are not
  // and correctly fall through to 1c.
  const { rows: byName } = await knex.raw(`
    UPDATE vendors v
       SET party_id = p.id, updated_at = NOW()
      FROM parties p
     WHERE v.party_id IS NULL
       AND v.deleted_at IS NULL
       AND p.deleted_at IS NULL
       AND LOWER(p.party_type) = ANY($1)
       AND p.company_id IS NOT DISTINCT FROM v.company_id
       AND crm_norm_name(p.name) = crm_norm_name(COALESCE(NULLIF(TRIM(v.vendor_name), ''), v.name))
       AND NOT EXISTS (SELECT 1 FROM vendors v2 WHERE v2.party_id = p.id AND v2.id <> v.id)
    RETURNING v.id
  `, [SUPPLIER_TYPES]);

  // ── 1c. Mint a party for everything still unbound.
  // One statement so the SUPP-nnn series is allocated without a read-then-write
  // race: row_number() over the remaining vendors, offset by the current max.
  const { rows: minted } = await knex.raw(`
    WITH seq AS (
      SELECT COALESCE(MAX(NULLIF(regexp_replace(party_code, '\\D', '', 'g'), ''))::int, 0) AS mx
        FROM parties WHERE LOWER(party_type) = ANY($1)
    ),
    todo AS (
      SELECT v.*, ROW_NUMBER() OVER (ORDER BY v.id) AS rn
        FROM vendors v
       WHERE v.party_id IS NULL AND v.deleted_at IS NULL
         AND COALESCE(NULLIF(TRIM(v.vendor_name), ''), NULLIF(TRIM(v.name), '')) IS NOT NULL
    ),
    ins AS (
      INSERT INTO parties
        (party_code, party_type, name, email, phone, mobile, address, city, state, country,
         pincode, website, gstin, pan, company_id, currency, payment_terms, credit_limit,
         bank_name, bank_account, ifsc, msme_number, is_active)
      SELECT 'SUPP-' || LPAD((seq.mx + todo.rn)::text, 3, '0'), 'Supplier',
             COALESCE(NULLIF(TRIM(todo.vendor_name), ''), TRIM(todo.name)),
             todo.email, todo.phone, todo.phone, todo.address, todo.city, todo.state,
             COALESCE(todo.country, 'India'), todo.postal_code, todo.website,
             CASE WHEN todo.gstin ~ $2 THEN todo.gstin END,
             CASE WHEN todo.pan   ~ $3 THEN todo.pan   END,
             todo.company_id, 'INR', COALESCE(todo.payment_terms_days, 30),
             COALESCE(todo.credit_limit, 0), todo.bank_name, todo.account_number, todo.ifsc,
             todo.udyam_number, true
        FROM todo, seq
      RETURNING id, name
    )
    SELECT id, name FROM ins
  `, [SUPPLIER_TYPES, GSTIN_RE, PAN_RE]);

  const { rows: badTaxIds } = await knex.raw(`
    SELECT id, vendor_name,
           CASE WHEN gstin IS NOT NULL AND gstin !~ $1 THEN gstin END AS bad_gstin,
           CASE WHEN pan   IS NOT NULL AND pan   !~ $2 THEN pan   END AS bad_pan
      FROM vendors
     WHERE deleted_at IS NULL
       AND ((gstin IS NOT NULL AND gstin !~ $1) OR (pan IS NOT NULL AND pan !~ $2))
  `, [GSTIN_RE, PAN_RE]);

  // Bind the freshly created parties back to their vendors. Matching on the
  // normalised name within the company is safe here because these parties were
  // created from those vendor names moments ago and 1b already consumed every
  // pre-existing name collision.
  await knex.raw(`
    UPDATE vendors v
       SET party_id = p.id, updated_at = NOW()
      FROM parties p
     WHERE v.party_id IS NULL
       AND v.deleted_at IS NULL
       AND p.deleted_at IS NULL
       AND LOWER(p.party_type) = 'supplier'
       AND p.company_id IS NOT DISTINCT FROM v.company_id
       AND crm_norm_name(p.name) = crm_norm_name(COALESCE(NULLIF(TRIM(v.vendor_name), ''), v.name))
       AND NOT EXISTS (SELECT 1 FROM vendors v2 WHERE v2.party_id = p.id AND v2.id <> v.id)
  `);

  // ── 2. Safeguards.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS vendors_party_id_unique
        ON vendors (party_id)
     WHERE party_id IS NOT NULL AND deleted_at IS NULL
  `);

  // A CHECK constraint cannot reach another table, so the company invariant is a
  // trigger. It fires only when party_id is being set/changed, so it costs
  // nothing on ordinary vendor edits.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION vendors_party_company_guard() RETURNS trigger AS $fn$
    DECLARE p_company INTEGER;
    BEGIN
      IF NEW.party_id IS NULL THEN RETURN NEW; END IF;
      IF TG_OP = 'UPDATE' AND OLD.party_id IS NOT DISTINCT FROM NEW.party_id THEN RETURN NEW; END IF;
      SELECT company_id INTO p_company FROM parties WHERE id = NEW.party_id;
      IF p_company IS NOT NULL AND NEW.company_id IS NOT NULL AND p_company <> NEW.company_id THEN
        RAISE EXCEPTION 'vendor % (company %) cannot be bound to finance party % which belongs to company %',
          NEW.id, NEW.company_id, NEW.party_id, p_company
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `);
  await knex.raw(`DROP TRIGGER IF EXISTS vendors_party_company_ck ON vendors`);
  await knex.raw(`
    CREATE TRIGGER vendors_party_company_ck
      BEFORE INSERT OR UPDATE OF party_id, company_id ON vendors
      FOR EACH ROW EXECUTE FUNCTION vendors_party_company_guard()
  `);

  // ── 3. Adopt existing AP rows onto the mapping.
  // Only where the bill already names its purchase order: that is an asserted
  // link, so the vendor — and therefore the party — is not in doubt. Bills with
  // no PO are left alone; guessing their supplier is the very failure mode this
  // migration removes.
  const { rows: adopted } = await knex.raw(`
    UPDATE bills b
       SET supplier_id = v.party_id, updated_at = CURRENT_TIMESTAMP
      FROM purchase_orders po
      JOIN vendors v ON v.id = po.supplier_id
     WHERE b.po_id = po.id
       AND b.supplier_id IS NULL
       AND b.deleted_at IS NULL
       AND v.party_id IS NOT NULL
       AND (b.company_id IS NOT DISTINCT FROM po.company_id)
    RETURNING b.id
  `);

  const { rows: [state] } = await knex.raw(`
    SELECT COUNT(*)::int AS total, COUNT(party_id)::int AS bound
      FROM vendors WHERE deleted_at IS NULL
  `);

  console.log(
    `[20260903000010] vendor->party: ${byGstin.length} bound by GSTIN, ${byName.length} by name, ` +
    `${minted.length} new supplier parties created; ${state.bound}/${state.total} live vendors now bound. ` +
    `${adopted.length} PO-linked bill(s) adopted onto the mapping.`
  );

  for (const v of badTaxIds) {
    console.warn(
      `[20260903000010] vendor ${v.id} (${v.vendor_name}) holds a malformed tax id that ` +
      `parties' format check rejects` +
      `${v.bad_gstin ? ` — GSTIN '${v.bad_gstin}'` : ''}${v.bad_pan ? ` — PAN '${v.bad_pan}'` : ''}. ` +
      `Its finance party was created with that field blank; correct the vendor record and re-save to carry it over.`
    );
  }

  if (state.bound !== state.total) {
    // Only reachable for a vendor row with no usable name at all, which cannot
    // become a payable identity. Named, not swallowed.
    const { rows: unbound } = await knex.raw(`
      SELECT id, vendor_name, name FROM vendors WHERE deleted_at IS NULL AND party_id IS NULL
    `);
    console.warn(`[20260903000010] ${unbound.length} vendor(s) could not be bound (no name):`,
      unbound.map(u => u.id).join(', '));
  }
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS vendors_party_company_ck ON vendors`);
  await knex.raw(`DROP FUNCTION IF EXISTS vendors_party_company_guard()`);
  await knex.raw(`DROP INDEX IF EXISTS vendors_party_id_unique`);
  // The party rows and the links are deliberately NOT removed. Deleting parties
  // would orphan any bill or payment raised against them since this ran, and
  // clearing party_id would put the module back on name matching. Both are
  // strictly worse than leaving a correct mapping in place under the old code,
  // which simply ignores the column.
}
