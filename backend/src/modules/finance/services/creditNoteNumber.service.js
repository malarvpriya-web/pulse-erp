/**
 * creditNoteNumber.service.js — the ONE credit-note number generator.
 *
 * CN-<year>-<nnnn>, per company and calendar year (the format both former
 * generators produced). MAX + 1 over the company's own numbers of that year,
 * taken under a transaction-scoped advisory lock on (company, year): two
 * simultaneous creates in one company wait for each other instead of drawing
 * the same number, and companies never wait on each other. The caller must be
 * inside a transaction on `client` and insert before committing — the lock is
 * released at commit. ux_credit_notes_company_number (migration
 * 20261028000004) is the database's backstop.
 *
 * Numbers of another shape (seed rows such as CN-03690-SEED02690) are left as
 * they are and simply not counted.
 */
export async function nextCreditNoteNumber(client, companyId, { year = new Date().getFullYear() } = {}) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('credit_notes.number:' || $1::text), COALESCE($2::int, 0))`,
    [String(year), companyId ?? null]);
  const { rows: [r] } = await client.query(`
    SELECT COALESCE(MAX(substring(credit_note_number FROM '^CN-[0-9]{4}-([0-9]+)$')::bigint), 0) + 1 AS n
      FROM credit_notes
     WHERE COALESCE(company_id, 0) = COALESCE($1::int, 0)
       AND credit_note_number LIKE $2`, [companyId ?? null, `CN-${year}-%`]);
  return `CN-${year}-${String(r.n).padStart(4, '0')}`;
}
