import pool from "../config/db.js";

/**
 * HR notes on an employee record.
 *
 * Every function here takes the caller's company explicitly. The previous
 * versions keyed on employee_id alone, which made this the one unscoped door
 * into an employee record: an admin of another tenant could read company 1's HR
 * notes and write new ones against company 1's employees (verified live,
 * 2026-09-30). `companyId === null` is a genuinely global scope — a super admin
 * with no company assignment — and is the only caller that may cross it.
 */

/** Is this employee inside the caller's tenant? */
async function employeeInScope(employeeId, companyId) {
  if (companyId == null) return true;
  const { rows } = await pool.query(
    `SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
    [employeeId, companyId]
  );
  return rows.length > 0;
}

export const addNote = async (employeeId, noteText, { companyId = undefined, userId = null } = {}) => {
  // `undefined` means the caller forgot to pass a scope; `null` means a
  // deliberate global one. Collapsing the two would make a missing argument
  // read as "all companies" — the fail-open default this module just lost.
  if (companyId === undefined) throw new Error("addNote requires a company scope");

  const empId = Number(employeeId);
  if (!Number.isInteger(empId) || empId < 1) {
    throw Object.assign(new Error("A valid employeeId is required"), { statusCode: 400 });
  }
  const text = String(noteText ?? "").trim();
  if (!text) {
    throw Object.assign(new Error("Note text is required"), { statusCode: 400 });
  }
  if (!await employeeInScope(empId, companyId)) {
    // Same shape the employees module uses for a cross-tenant :id, so the
    // boundary does not advertise which ids exist elsewhere.
    throw Object.assign(new Error("Employee not found"), { statusCode: 404 });
  }

  // The stored company_id comes from the employee row, not from the caller —
  // the caller's scope decides whether the write is allowed, the employee
  // decides which tenant the note belongs to. They agree by construction here,
  // but only one of them is the record's own truth.
  const { rows } = await pool.query(
    `INSERT INTO hr_notes (employee_id, note_text, company_id, created_by)
     VALUES ($1, $2, (SELECT company_id FROM employees WHERE id = $1), $3::int)
     RETURNING *`,
    [empId, text, userId]
  );
  return decorate(rows[0], await authorName(rows[0].created_by));
};

export const getNotesByEmployee = async (employeeId, { companyId = undefined } = {}) => {
  if (companyId === undefined) throw new Error("getNotesByEmployee requires a company scope");

  const empId = Number(employeeId);
  if (!Number.isInteger(empId) || empId < 1) {
    throw Object.assign(new Error("A valid employeeId is required"), { statusCode: 400 });
  }
  if (!await employeeInScope(empId, companyId)) {
    throw Object.assign(new Error("Employee not found"), { statusCode: 404 });
  }

  // Newest first — the profile renders the list in the order it arrives.
  // Rows written before company_id existed are matched through the employee
  // they hang off, which is the same derivation the backfill migration used;
  // without that fallback a legacy note would vanish from its own employee.
  const { rows } = await pool.query(
    `SELECT n.*,
            COALESCE(NULLIF(TRIM(u.name), ''), u.email) AS created_by_name
       FROM hr_notes n
       LEFT JOIN users u ON u.id = n.created_by
      WHERE n.employee_id = $1
        AND ($2::int IS NULL OR COALESCE(n.company_id, $2::int) = $2::int)
      ORDER BY n.created_at DESC, n.id DESC`,
    [empId, companyId]
  );
  return rows;
};

async function authorName(userId) {
  if (userId == null) return null;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(name), ''), email) AS n FROM users WHERE id = $1`,
      [userId]
    );
    return rows[0]?.n ?? null;
  } catch { return null; }
}

function decorate(row, created_by_name) {
  return { ...row, created_by_name };
}
