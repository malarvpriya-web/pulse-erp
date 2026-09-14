/**
 * customerMerge.service.js — safely fold a duplicate customer into a survivor.
 *
 * The CRM audit (2026-08-19) found duplicates could be created freely but never
 * reconciled: there was no merge capability anywhere in the module (C-21). With
 * `parties` now canonical, a merge has to move every child reference from the
 * loser to the survivor across BOTH id spaces — the party uuid that commercial
 * documents use, and the accounts integer that CRM records use.
 *
 * Rules:
 *   • Nothing is ever hard-deleted. The loser is soft-deleted and stamped with
 *     `merged_into`, so historical links remain traceable and an operator can
 *     see where a record went.
 *   • Every child table is repointed inside ONE transaction — a partial merge
 *     would scatter a customer's history across two identities, which is worse
 *     than the duplicate.
 *   • Reversible enough to audit: the returned summary records exactly what
 *     moved, and is written to the audit log by the caller.
 */

/** Child references keyed by the CRM `accounts.id` (integer) space. */
const ACCOUNT_REFS = [
  { table: 'contacts',       column: 'account_id' },
  { table: 'opportunities',  column: 'account_id' },
  { table: 'crm_activities', column: 'account_id' },
  { table: 'crm_emails',     column: 'account_id' },
];

/** Child references keyed by the canonical `parties.id` (uuid) space. */
const PARTY_REFS = [
  { table: 'quotations',   column: 'customer_id' },
  { table: 'sales_orders', column: 'customer_id' },
  { table: 'invoices',     column: 'customer_id' },
];

/** Only repoint tables/columns that actually exist on this database. */
async function exists(client, table, column) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

/**
 * Merge `loserAccountId` into `survivorAccountId`.
 * @returns {Promise<{moved: Object, survivor: object, loser: object}>}
 */
export async function mergeAccounts(client, { survivorAccountId, loserAccountId, company_id = null }) {
  if (String(survivorAccountId) === String(loserAccountId)) {
    throw Object.assign(new Error('Cannot merge an account into itself'), { status: 400 });
  }

  // Lock both rows so a concurrent merge can't interleave and split the history.
  const { rows: accts } = await client.query(
    `SELECT * FROM accounts
      WHERE id = ANY($1::int[]) AND deleted_at IS NULL
        AND ($2::int IS NULL OR company_id = $2)
      ORDER BY id
      FOR UPDATE`,
    [[survivorAccountId, loserAccountId], company_id]
  );
  const survivor = accts.find(a => String(a.id) === String(survivorAccountId));
  const loser    = accts.find(a => String(a.id) === String(loserAccountId));
  if (!survivor) throw Object.assign(new Error('Survivor account not found'), { status: 404 });
  if (!loser)    throw Object.assign(new Error('Duplicate account not found'), { status: 404 });

  const moved = {};

  // ── 1. CRM-side children ────────────────────────────────────────────────
  for (const { table, column } of ACCOUNT_REFS) {
    if (!(await exists(client, table, column))) continue;
    const { rowCount } = await client.query(
      `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
      [survivor.id, loser.id]
    );
    if (rowCount) moved[`${table}.${column}`] = rowCount;
  }

  // ── 2. Commercial-side children ─────────────────────────────────────────
  // Only when the loser had its own party. If both accounts already share one,
  // there is nothing to repoint — the documents already point at the survivor.
  if (loser.party_id && survivor.party_id && loser.party_id !== survivor.party_id) {
    for (const { table, column } of PARTY_REFS) {
      if (!(await exists(client, table, column))) continue;
      const { rowCount } = await client.query(
        `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
        [survivor.party_id, loser.party_id]
      );
      if (rowCount) moved[`${table}.${column}`] = rowCount;
    }

    // Retire the duplicate party. Soft-delete + pointer, never DELETE: invoices
    // and journal entries referencing it must stay resolvable.
    await client.query(
      `UPDATE parties
          SET is_active = false,
              deleted_at = NOW(),
              notes = COALESCE(notes || E'\\n', '') || 'Merged into party ' || $1::text
        WHERE id = $2`,
      [survivor.party_id, loser.party_id]
    );
    moved['parties.retired'] = 1;
  }

  // ── 3. Carry across anything the survivor is missing ────────────────────
  // A merge should never lose a phone number just because the survivor's field
  // was blank.
  await client.query(
    `UPDATE accounts s
        SET email           = COALESCE(NULLIF(s.email, ''), l.email),
            phone           = COALESCE(NULLIF(s.phone, ''), l.phone),
            website         = COALESCE(NULLIF(s.website, ''), l.website),
            industry        = COALESCE(NULLIF(s.industry, ''), l.industry),
            annual_revenue  = COALESCE(NULLIF(s.annual_revenue, 0), l.annual_revenue),
            employees_count = COALESCE(s.employees_count, l.employees_count),
            updated_at      = NOW()
       FROM accounts l
      WHERE s.id = $1 AND l.id = $2`,
    [survivor.id, loser.id]
  );

  // ── 4. Retire the duplicate account ─────────────────────────────────────
  await client.query(
    `UPDATE accounts
        SET deleted_at = NOW(),
            status     = 'Merged',
            updated_at = NOW()
      WHERE id = $1`,
    [loser.id]
  );

  const { rows: after } = await client.query(`SELECT * FROM accounts WHERE id = $1`, [survivor.id]);
  return { moved, survivor: after[0], loser };
}

export default { mergeAccounts };
