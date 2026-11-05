import pool from '../config/db.js';

/**
 * Generate a sequential reference code for any table.
 * Falls back to MAX()+1 counting for tables not covered by a DB sequence.
 *
 * ⚠ NOT for Employee IDs. `employees.office_id` follows the company's own
 * convention (EMP001, no hyphen, per-company sequence) and is minted only by
 * `shared/employeeCode.js`. This helper produces the hyphenated `PREFIX-0001`
 * shape used by document numbers, and its EMP example was one of the things that
 * misled an earlier pass into backfilling employees as `EMP-0013`.
 *
 * @param {string} table      - table name (e.g. 'vendors')
 * @param {string} prefix     - code prefix (e.g. 'VND')
 * @param {number} companyId  - company_id for scoping
 * @param {object} [client]   - optional pg transaction client
 * @returns {Promise<string>} - e.g. 'VND-0001'
 */
async function generateCode(table, prefix, companyId, client) {
  const db = client || pool;
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(
       CAST(SUBSTRING(code FROM LENGTH($1)+2) AS INTEGER)
     ), 0) + 1 AS next_seq
     FROM ${table}
     WHERE company_id = $2
       AND code LIKE $3`,
    [prefix, companyId, `${prefix}-%`]
  );
  const seq = rows[0].next_seq;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

export { generateCode };
