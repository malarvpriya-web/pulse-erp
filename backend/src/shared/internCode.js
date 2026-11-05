/**
 * internCode — the Intern ID (`interns.intern_code`) format and its ONE generator.
 *
 *     INT001, INT002 … INT099, INT100 … INT999, INT1000
 *
 * The same shape as the company's Employee ID (shared/employeeCode.js): prefix,
 * at least three zero-padded digits, no hyphen, not capped at 999. A different
 * PREFIX on purpose — an intern must never hold an EMP number, and the two series
 * are independent, so INT001 and EMP001 can both exist in one company.
 *
 * Generation follows employeeCode.js exactly, for the reasons recorded there:
 *   - highest SUFFIX + 1, never row count — a gap is a removed record, and
 *     reissuing its number to someone else is worse than the gap;
 *   - scoped to the company — numbering is a tenant's own;
 *   - serialised by a company-scoped advisory lock held to COMMIT, with
 *     `interns_code_company_uniq` as the backstop across processes.
 */

export const INTERN_CODE_RE = /^INT\d{3,}$/;
export const INTERN_CODE_PREFIX = 'INT';
const MIN_DIGITS = 3;

/** `1` → `'INT001'`, `1000` → `'INT1000'`. */
export const formatInternCode = (n) =>
  `${INTERN_CODE_PREFIX}${String(n).padStart(MIN_DIGITS, '0')}`;

export const isValidInternCode = (code) => INTERN_CODE_RE.test(String(code ?? '').trim());

/**
 * The next free Intern ID for a company.
 *
 * @param {import('pg').PoolClient} client  a client inside an open transaction
 * @param {number|null} companyId           null = unscoped/global
 */
export async function nextInternCode(client, companyId) {
  if (companyId === undefined) {
    // `undefined` is a caller that forgot to pass scope; `null` is explicit.
    throw new Error('nextInternCode: companyId is required (pass null for unscoped)');
  }
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('interns.intern_code')::int, $1::int)`,
    [companyId ?? 0],
  );
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(intern_code, '\\D', '', 'g'), '')::bigint), 0) AS max_seq
       FROM interns
      WHERE ($1::int IS NULL OR company_id = $1)
        AND intern_code ~ '^INT[0-9]+$'`,
    [companyId ?? null],
  );
  return formatInternCode(Number(rows[0]?.max_seq || 0) + 1);
}

export default { INTERN_CODE_RE, INTERN_CODE_PREFIX, formatInternCode, isValidInternCode, nextInternCode };
