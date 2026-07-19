import pool from '../config/db.js';

/**
 * Generate a sequential reference code for any table.
 * Falls back to MAX()+1 counting for tables not covered by a DB sequence.
 *
 * @param {string} table      - table name (e.g. 'employees')
 * @param {string} prefix     - code prefix (e.g. 'EMP')
 * @param {number} companyId  - company_id for scoping
 * @param {object} [client]   - optional pg transaction client
 * @returns {Promise<string>} - e.g. 'EMP-0001'
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
