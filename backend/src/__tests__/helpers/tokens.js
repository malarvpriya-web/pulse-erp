import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;

export const makeToken = (overrides = {}) =>
  jwt.sign({ userId: 1, role: 'admin', email: 'admin@test.com', ...overrides }, SECRET, { expiresIn: '1h' });

/**
 * `employee_id` on the employee/manager tokens is not decoration.
 *
 * `verifyToken` does `req.user = decoded`, and the real login signs
 * `employee_id: user.employee_id ?? null` (auth.service.js makeToken) — so a
 * genuine employee's token ALWAYS carries one, because the login policy links
 * every employee account to an employees row. A token without it models an admin
 * or service account, not an employee.
 *
 * Omitting it here let two leave tests pass against a mocked repository while the
 * same request 500'd against a real database: `leave_applications.employee_id` is
 * NOT NULL, and the handler resolved the employee from this claim. The mock never
 * saw the constraint, so the fixture hid the defect rather than catching it.
 *
 * adminToken deliberately keeps NO employee_id — that is accurate: the three admin
 * logins are intentionally unlinked, which is exactly the case that produced the
 * 500 in production.
 */
export const adminToken    = () => makeToken({ userId: 1, role: 'admin' });
export const hrToken       = () => makeToken({ userId: 2, role: 'hr', employee_id: 2 });
export const managerToken  = () => makeToken({ userId: 3, role: 'manager', employee_id: 3 });
export const employeeToken = () => makeToken({ userId: 4, role: 'employee', employee_id: 4 });
