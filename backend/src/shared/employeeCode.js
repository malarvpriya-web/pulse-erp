/**
 * employeeCode — the canonical Employee ID (`employees.office_id`) format and the
 * ONE generator every employee-creation path mints codes with.
 *
 * ── THE FORMAT IS THE COMPANY'S OWN CONVENTION ──────────────────────────────
 *
 *     EMP001, EMP002, EMP003 … EMP012, EMP013 … EMP099, EMP100 … EMP999, EMP1000
 *
 * No hyphen. Three digits minimum, zero-padded, and NOT capped at three — the
 * 1000th employee is `EMP1000`, not an error and not `EMP999` again.
 *
 *     ^EMP[0-9]{3,}$
 *
 * This is how the first employees in the system were created (`EMP001`…`EMP012`
 * are live in company 1 and predate all of this work), so it is the convention,
 * full stop.
 *
 * ⚠ An earlier pass of mine got this backwards. It read the dashed `EMP-0001`
 * shape produced by `shared/docNumber.js`, `utils/generateCode.js` and the
 * recruitment hire path, concluded that was "the format the codebase had settled
 * on", treated the real `EMP001` rows as legacy to be tolerated, and backfilled
 * 35 rows as `EMP-0013`…`EMP-0036`. Three dead or peripheral code paths outvoted
 * the eight rows that were actually the business's numbering. The lesson is in the
 * ordering: LIVE DATA THAT PREDATES THE CODE IS THE SPEC. That backfill was
 * reverted by `scripts/hr/renumber-employee-codes.mjs`.
 *
 * ── Why generation must be centralised ──────────────────────────────────────
 * Three generators once disagreed, and one was broken. It read
 * `SELECT office_id FROM employees ORDER BY id DESC LIMIT 1` with NO company
 * filter; on live data the newest row belonged to another tenant with a NULL
 * office_id, so it fell to its "first ever employee" branch and returned
 * `EMP001` — a code employee id=1 had held since February. `POST /employees`
 * then created a second `EMP001` in the same company, verified live.
 *
 * It was also one row from emitting something that is not a code at all, because
 * it sliced the suffix at a fixed offset:
 *
 *   parseInt('EMP-0002'.substring(3), 10)  →  parseInt('-0002')  →  -2
 *   `EMP${String(-2 + 1).padStart(3, '0')}`                      →  'EMP0-1'
 *
 * `codeSeq` strips non-digits instead, so the suffix is read correctly whatever
 * sits in front of it.
 */

/** The one canonical pattern. Every Employee ID, new or old, matches this. */
export const CODE_RE = /^EMP\d{3,}$/;

/** The SQL form, for the CHECK constraint. */
export const CODE_CHECK_SQL = `office_id IS NULL OR office_id ~ '^EMP[0-9]{3,}$'`;

export const CODE_PREFIX = 'EMP';

/**
 * Minimum digits. `padStart` never truncates, so this pads 1 → `001` and leaves
 * 1000 → `1000` alone. The company is not limited to 999 employees.
 */
const MIN_DIGITS = 3;

/**
 * Suffixes at or above this belong to test fixtures, never to people.
 *
 * `FIXTURE_CODE_SQL` mints from this range so a fixture row is recognisable on
 * sight. `nextEmployeeCode` must therefore IGNORE them when it takes its MAX —
 * otherwise one fixture row inserted into company 1 (which
 * `integration.reports.test.js` does) would push the next real hire to
 * `EMP900002` and abandon the company's numbering permanently.
 */
export const FIXTURE_FLOOR = 900000;

/** `1` → `'EMP001'`, `13` → `'EMP013'`, `1000` → `'EMP1000'`. */
export const formatEmployeeCode = (n) =>
  `${CODE_PREFIX}${String(n).padStart(MIN_DIGITS, '0')}`;

/**
 * The numeric suffix of a code, or null when it has none.
 *
 * Strips every non-digit rather than slicing at a fixed offset, so it reads
 * `EMP001` → 1 and also `EMP-0001` → 1. The second form should no longer exist
 * anywhere, but a reader that copes with it is what lets the renumbering script
 * and this generator agree during a migration instead of producing a negative
 * number.
 */
export function codeSeq(code) {
  if (!code) return null;
  const digits = String(code).replace(/\D+/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export const isValidEmployeeCode = (code) => CODE_RE.test(String(code ?? '').trim());

function badRequest(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * The next free Employee ID for a company.
 *
 * ── Highest SUFFIX, not highest row id ──────────────────────────────────────
 * Given EMP001, EMP002, EMP005 the next code is EMP006 — one past the highest
 * number in use, not one past the count and not derived from `employees.id`.
 * Gaps (EMP004 here) are left alone: a gap means someone's record was removed,
 * and reissuing their number to a different person is worse than a gap.
 *
 * ── Scoped to the company ───────────────────────────────────────────────────
 * Employee IDs are a company's own numbering, so two tenants may both hold
 * EMP001. The predecessor read the whole table and handed out another tenant's
 * next number.
 *
 * ── Serialised ─────────────────────────────────────────────────────────────
 * MAX()+1 is a check-then-act pair: two concurrent hires read the same max and
 * mint the same code. A company-scoped advisory lock, held to COMMIT, closes that
 * window without serialising unrelated tenants. The caller MUST be inside a
 * transaction — `pg_advisory_xact_lock` on a pooled connection outside one
 * releases immediately and protects nothing.
 *
 * `employees_office_id_company_uniq` is the backstop underneath: a lock only
 * holds within one process, and Pulse can run more than one.
 *
 * @param {import('pg').PoolClient} client  a client inside an open transaction
 * @param {number|null} companyId           null = unscoped/global
 */
export async function nextEmployeeCode(client, companyId) {
  if (companyId === undefined) {
    // `undefined` means a caller forgot to pass scope; `null` is the explicit
    // unscoped/global case. Conflating them is how a tenant filter goes missing.
    throw new Error('nextEmployeeCode: companyId is required (pass null for unscoped)');
  }

  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('employees.office_id')::int, $1::int)`,
    [companyId ?? 0],
  );

  // Any EMP-prefixed code counts toward the max, whatever punctuation follows the
  // prefix — so a straggler in an older shape cannot cause the generator to
  // reissue a number that is already on someone's ID card. Fixture-range
  // suffixes are excluded; see FIXTURE_FLOOR.
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(seq), 0) AS max_seq
       FROM (
         SELECT NULLIF(REGEXP_REPLACE(office_id, '\\D', '', 'g'), '')::bigint AS seq
           FROM employees
          WHERE ($1::int IS NULL OR company_id = $1)
            AND office_id ~ '^EMP'
            AND REGEXP_REPLACE(office_id, '\\D', '', 'g') <> ''
       ) s
      WHERE seq < $2::bigint`,
    [companyId ?? null, FIXTURE_FLOOR],
  );

  return formatEmployeeCode(Number(rows[0]?.max_seq || 0) + 1);
}

/**
 * Validate a caller-supplied Employee ID and prove it is free in this company.
 *
 * Runs against the same `client`/lock the generator uses, so a supplied code and
 * a minted code cannot race each other either.
 */
export async function assertCodeAvailable(client, code, companyId) {
  const trimmed = String(code ?? '').trim();
  if (!trimmed) throw badRequest('Employee ID is required');
  if (!isValidEmployeeCode(trimmed)) {
    throw badRequest(
      `"${trimmed}" is not a valid Employee ID. Expected the form ${formatEmployeeCode(1)} ` +
      `(EMP followed by at least three digits, no hyphen).`,
    );
  }
  const { rows } = await client.query(
    `SELECT id FROM employees
      WHERE LOWER(office_id) = LOWER($1)
        AND ($2::int IS NULL OR company_id = $2)
      LIMIT 1`,
    [trimmed, companyId ?? null],
  );
  if (rows.length) throw badRequest(`Employee ID ${trimmed} is already in use`, 409);
  return trimmed;
}

/**
 * A unique, well-formed Employee ID for FIXTURES AND SEED SCRIPTS only.
 *
 * `employees.office_id` is NOT NULL, so a fixture that inserts an employee with
 * raw SQL has to supply one. A SQL expression rather than a JS call, so it drops
 * into an existing INSERT without restructuring it or renumbering placeholders.
 *
 * ⚠ NOT for application code. It draws on `seq_emp` (a global sequence) offset
 * past `FIXTURE_FLOOR`: unique by construction, obviously not a person's number,
 * and deliberately excluded from `nextEmployeeCode`'s MAX so a fixture row cannot
 * drag a real company's sequence into the 900000s. `nextEmployeeCode()` is the
 * only thing that should mint a code anyone will ever see.
 */
export const FIXTURE_CODE_SQL =
  "('EMP' || LPAD((900000 + nextval('seq_emp'))::text, 6, '0'))";

export default {
  CODE_RE, CODE_CHECK_SQL, CODE_PREFIX, FIXTURE_FLOOR,
  formatEmployeeCode, codeSeq, isValidEmployeeCode,
  nextEmployeeCode, assertCodeAvailable, FIXTURE_CODE_SQL,
};
