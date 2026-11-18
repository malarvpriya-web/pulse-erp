/**
 * Creates (and removes) an employee carrying four REAL uploaded documents, for
 * the View Employee → Documents browser test.
 *
 * The test used to read EMP003, whose document columns happened to be populated.
 * That is not a fixture, it is a coincidence: the moment those columns were
 * cleaned up (five of them named files that were no longer in storage) the test
 * started failing for a reason that had nothing to do with the code under test.
 *
 * Files go in through POST /employees as multipart, exactly as Add Employee
 * sends them, so this exercises the real upload path rather than writing rows.
 * Each document carries its own marker so "the right file came back" is
 * checkable rather than assumed.
 *
 *   node scripts/zzve-doc-employee.mjs create <suffix>
 *   node scripts/zzve-doc-employee.mjs clean  <suffix>
 *
 * Lives under Pulse/backend/scripts, beside e2e-mint-token.mjs, because Node
 * resolves a bare `jsonwebtoken` import from the SCRIPT's directory, not the
 * process cwd — from tests/fixtures there is no node_modules to find it in.
 * Run with cwd = Pulse/backend, the same arrangement tests/auth.setup.ts uses.
 */
import jwt from 'jsonwebtoken';
import fs from 'node:fs';

const pool = (await import('../src/config/db.js')).default;
const BASE = process.env.PULSE_API_BASE ?? 'http://localhost:5000';
const API = `${BASE}/api/v1`;
const [, , mode, suffix] = process.argv;
const last = `Doc${suffix}`;
const email = `zzve.${last.toLowerCase()}@manifest.in`;

const FILE_COLUMNS = ['photo_url', 'pan_file', 'aadhaar_file', 'resume_file'];

async function adminToken() {
  const { rows: [u] } = await pool.query(
    "SELECT id, email, role, company_id FROM users WHERE email = 'superadmin@manifest.in'");
  if (!u) throw new Error('superadmin@manifest.in not found');
  return jwt.sign(
    { userId: u.id, email: u.email, role: u.role, roles: [u.role], company_id: u.company_id, branch_id: null, employee_id: null },
    process.env.JWT_SECRET, { expiresIn: '1h' });
}

if (mode === 'create') {
  const pdf = (marker) => Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  const fd = new FormData();
  fd.append('first_name', 'ZZVE');
  fd.append('last_name', last);
  fd.append('company_email', email);
  fd.append('department', 'IT');
  fd.append('designation', 'Engineer');
  fd.append('status', 'Active');
  fd.append('joining_date', '2026-09-01');
  fd.append('photo_file',   new Blob([png],                    { type: 'image/png' }),       'zzve-face.png');
  fd.append('pan_file',     new Blob([pdf('PAN-MARKER')],      { type: 'application/pdf' }), 'zzve-pan.pdf');
  fd.append('aadhaar_file', new Blob([pdf('AADHAAR-MARKER')],  { type: 'application/pdf' }), 'zzve-aadhaar.pdf');
  fd.append('resume_file',  new Blob([pdf('RESUME-MARKER')],   { type: 'application/pdf' }), 'zzve-resume.pdf');

  const token = await adminToken();
  const res = await fetch(`${API}/employees`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200 || !body.id) throw new Error(`create failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);

  const { rows: [row] } = await pool.query(
    `SELECT id, ${FILE_COLUMNS.join(', ')} FROM employees WHERE id = $1`, [body.id]);
  const onDisk = FILE_COLUMNS.filter(c => row[c] && fs.existsSync(`.${row[c]}`));
  if (onDisk.length !== FILE_COLUMNS.length) {
    throw new Error(`only ${onDisk.length}/${FILE_COLUMNS.length} uploads reached storage: ${JSON.stringify(row)}`);
  }
  console.log(`ZZVE_DOC_EMPLOYEE=${JSON.stringify({ id: row.id, files: FILE_COLUMNS.length })}`);
} else {
  const { rows } = await pool.query(
    `SELECT id, ${FILE_COLUMNS.join(', ')} FROM employees WHERE last_name = $1`, [last]);
  for (const r of rows) {
    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    await pool.query('DELETE FROM employee_salary_assignments WHERE employee_id = $1', [r.id]);
    await pool.query('DELETE FROM hr_onboarding_checklist_progress WHERE employee_id = $1', [r.id]);
    await pool.query('DELETE FROM hr_notes WHERE employee_id = $1', [r.id]);
    await pool.query('DELETE FROM employees WHERE id = $1', [r.id]);
    for (const c of FILE_COLUMNS) if (r[c]) fs.rmSync(`.${r[c]}`, { force: true });
  }
  console.log(`ZZVE_DOC_EMPLOYEE_REMOVED=${rows.length}`);
}

await pool.end();
