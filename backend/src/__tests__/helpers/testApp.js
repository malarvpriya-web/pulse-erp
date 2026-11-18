import express from 'express';
import multer from 'multer';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { errorHandler } from '../../middlewares/errorHandler.js';
import { LOCAL_UPLOAD_DIR } from '../../services/StorageService.js';

/**
 * Builds a minimal Express app mounting only the routes under test.
 * Does NOT start listeners, crons, or DB migrations.
 *
 * `/api/employees` gets what server.js puts in front of it — the multipart
 * parser for the employee document fields — plus a stand-in for a test that
 * sends JSON: a new account needs a cancelled cheque and the account-holder
 * name (§267), so a JSON POST/PUT carrying an account number or IFSC gets a
 * fixture cheque, and a POST a fixture holder name when it names none.
 * Send `x-test-bank-proof: none` to leave both out (the tests of that rule).
 *
 * @param  {...[string, Router]} mounts  e.g. ['/api/auth', authRouter]
 */
export const TEST_BANK_PROOF_NAME = 'zz_test_bank_proof.pdf';
export const TEST_ACCOUNT_HOLDER = 'Fixture Holder';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const EMPLOYEE_FILE_FIELDS = ['photo_file', 'pan_file', 'aadhaar_file', 'cancelled_cheque_file', 'bank_statement_file', 'resume_file', 'offer_letter_file']
  .map(name => ({ name, maxCount: 1 }));

export function employeeUploadForTests(req, res, next) {
  if (req.method === 'GET' || req.method === 'DELETE') return next();
  if (req.is('multipart/form-data')) return upload.fields(EMPLOYEE_FILE_FIELDS)(req, res, next);
  const body = req.body || {};
  const bankSent = 'account_number' in body || 'ifsc_code' in body;
  if (bankSent && req.get('x-test-bank-proof') !== 'none') {
    if (!req.files) {
      req.files = { cancelled_cheque_file: [{ buffer: Buffer.from('%PDF-1.4 fixture cheque'), originalname: TEST_BANK_PROOF_NAME, mimetype: 'application/pdf', size: 23 }] };
    }
    if (req.method === 'POST' && !('account_holder_name' in body)) body.account_holder_name = TEST_ACCOUNT_HOLDER;
  }
  next();
}

/** Remove the fixture cheques the stand-in stored (called from the suite's global teardown). */
export function removeTestBankProofs() {
  try {
    for (const f of readdirSync(LOCAL_UPLOAD_DIR)) if (f.endsWith(`_${TEST_BANK_PROOF_NAME.replace('.pdf', '')}.pdf`)) rmSync(join(LOCAL_UPLOAD_DIR, f), { force: true });
  } catch { /* no upload dir */ }
}

export function buildApp(...mounts) {
  const app = express();
  app.use(express.json());
  for (const [path, ...middlewaresAndRouter] of mounts) {
    if (path === '/api/employees') app.use(path, employeeUploadForTests);
    app.use(path, ...middlewaresAndRouter);
  }
  app.use(errorHandler);
  return app;
}
