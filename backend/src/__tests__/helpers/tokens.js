import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;

export const makeToken = (overrides = {}) =>
  jwt.sign({ userId: 1, role: 'admin', email: 'admin@test.com', ...overrides }, SECRET, { expiresIn: '1h' });

export const adminToken    = () => makeToken({ userId: 1, role: 'admin' });
export const hrToken       = () => makeToken({ userId: 2, role: 'hr' });
export const managerToken  = () => makeToken({ userId: 3, role: 'manager' });
export const employeeToken = () => makeToken({ userId: 4, role: 'employee' });
