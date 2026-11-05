/**
 * integration.documentMasterSecurity.test.js — /api/document-master authorization,
 * tenant isolation, confidentiality and self-approval, against the REAL database.
 * LEGACY_MIS_TO_PULSE_AUDIT.md Table 6 row 1, P0 Task 2.
 *
 * Pre-fix, documentMaster.routes.js had no requirePermission on any verb and no
 * company filter on any query; upload took company_id from the request body, and
 * approve wrote the caller in as approver even when the caller was the uploader.
 *
 * Real users with real roles (verifyToken re-reads roles from user_roles, so a
 * role claimed in the token proves nothing), in two synthetic companies:
 *   A: admin, admin2, manager (documents view/add/edit), 2 employees (view only),
 *      store_keeper (no documents:view)
 *   B: admin, employee
 *
 * Self-cleaning: sweep() removes both companies and everything under them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error('Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.');
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}
// Never touch a real Google Drive from a test: uploads stay metadata-only.
delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH;

const { default: pool }            = await import('../config/db.js');
const { verifyToken }              = await import('../middlewares/auth.middleware.js');
const { auditMutations }           = await import('../middlewares/auditMutations.js');
const { buildApp }                 = await import('./helpers/testApp.js');
const { default: documentMaster }  = await import('../modules/documents/routes/documentMaster.routes.js');

// Mounted exactly as server.js mounts it.
const app = buildApp(['/api/document-master', verifyToken, auditMutations('documents'), documentMaster]);

const TAG = `ZZDMS${Date.now().toString(36).toUpperCase()}`;
const CODES = [`${TAG}A`, `${TAG}B`];

const u = {};   // users
const co = {};  // companies
const doc = {}; // documents

const token = (userId, companyId) =>
  jwt.sign({ userId, company_id: companyId }, process.env.JWT_SECRET, { expiresIn: '1h' });
const as = (who) => `Bearer ${token(u[who].id, u[who].company)}`;

async function sweep() {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE code = ANY($1)`, [CODES]);
  for (const { id } of rows) {
    const users = `(SELECT id FROM users WHERE company_id = ${Number(id)})`;
    await pool.query(
      `DELETE FROM document_download_log
        WHERE document_id IN (SELECT id FROM document_master WHERE company_id = $1 OR uploaded_by IN ${users})`, [id]);
    await pool.query(`DELETE FROM document_master WHERE company_id = $1 OR uploaded_by IN ${users}`, [id]);
    await pool.query(`DELETE FROM document_signings WHERE company_id = $1 AND title LIKE $2`, [id, `${TAG}%`]);
    await pool.query(`DELETE FROM audit_logs WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM access_denials WHERE user_id IN ${users}`, []).catch(() => {});
    await pool.query(`DELETE FROM user_roles WHERE user_id IN ${users}`, []);
    await pool.query(`DELETE FROM user_scope WHERE user_id IN ${users}`, []).catch(() => {});
    // talent.routes.js seeds interview_questions into every company at import
    // time when imported in the same worker; see integration.integrationsConfigSecurity.
    await pool.query(`DELETE FROM interview_questions WHERE company_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE company_id = $1`, [id]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [id]);
  }
}

async function makeCompany(code) {
  const { rows } = await pool.query(
    `INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id`, [`${code} Co`, code]);
  return rows[0].id;
}

async function makeUser(key, companyId, roleCode) {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, company_id, is_active)
     VALUES ($1, $2, 'not-a-real-hash', $3, true) RETURNING id`,
    [`${TAG} ${key}`, `${TAG.toLowerCase()}.${key}@test.invalid`, companyId]);
  const { rows: role } = await pool.query(`SELECT id FROM roles WHERE LOWER(code) = $1 LIMIT 1`, [roleCode]);
  if (!role.length) throw new Error(`role '${roleCode}' is missing from the matrix — this suite needs it`);
  await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [rows[0].id, role[0].id]);
  u[key] = { id: rows[0].id, company: companyId };
}

async function makeDoc(key, { company, uploader, confidential = false, accessLevel = 'internal', entity = null, status = 'draft' }) {
  const { rows } = await pool.query(
    `INSERT INTO document_master
       (file_name, original_file_name, mime_type, module_type, linked_entity_type, linked_entity_id,
        revision, revision_label, checksum_sha256, approval_status, signed_status,
        is_confidential, access_level, uploaded_by, uploaded_by_name, company_id, drive_link)
     VALUES ($1,$1,'application/pdf','engineering',$2,$3,1,'Rev A','abc123',$4,'unsigned',$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [`${TAG}-${key}.pdf`, entity ? 'project' : null, entity, status, confidential, accessLevel,
     u[uploader].id, `${TAG} ${uploader}`, company, `https://example.invalid/${TAG}/${key}`]
  );
  doc[key] = rows[0];
}

const reload = async (key) =>
  (await pool.query(`SELECT * FROM document_master WHERE id = $1`, [doc[key].id])).rows[0];

const ENTITY_B = 900000000 + Math.floor(Math.random() * 1e6);

beforeAll(async () => {
  await sweep();
  co.A = await makeCompany(CODES[0]);
  co.B = await makeCompany(CODES[1]);
  await makeUser('adminA',  co.A, 'admin');
  await makeUser('admin2A', co.A, 'admin');
  await makeUser('managerA', co.A, 'manager');
  await makeUser('employeeA', co.A, 'employee');
  await makeUser('employee2A', co.A, 'employee');
  await makeUser('storeA',  co.A, 'store_keeper');
  await makeUser('adminB',  co.B, 'admin');
  await makeUser('employeeB', co.B, 'employee');

  await makeDoc('publicA',       { company: co.A, uploader: 'managerA' });
  await makeDoc('confidentialA', { company: co.A, uploader: 'managerA', confidential: true });
  await makeDoc('restrictedA',   { company: co.A, uploader: 'managerA', accessLevel: 'restricted' });
  await makeDoc('ownConfA',      { company: co.A, uploader: 'employeeA', confidential: true });
  await makeDoc('byAdminA',      { company: co.A, uploader: 'adminA' });
  await makeDoc('toApproveA',    { company: co.A, uploader: 'managerA' });
  await makeDoc('toDeleteA',     { company: co.A, uploader: 'managerA' });
  await makeDoc('toRejectA',     { company: co.A, uploader: 'managerA' });
  await makeDoc('publicB',       { company: co.B, uploader: 'employeeB', entity: ENTITY_B });
  await makeDoc('confidentialB', { company: co.B, uploader: 'employeeB', confidential: true, entity: ENTITY_B });
}, 60_000);

// Never pool.end(): the pool is shared across this worker's suites.
afterAll(async () => { await sweep(); }, 60_000);

const ids = (res) => (res.body.data || []).map(d => d.id);

// ── 1. Listing ──────────────────────────────────────────────────────────────
describe('GET /document-master (list)', () => {
  it('denies a user whose role has no documents:view', async () => {
    const res = await request(app).get('/api/document-master').set('Authorization', as('storeA'));
    expect(res.status).toBe(403);
  });

  it("never returns another company's documents", async () => {
    const res = await request(app).get('/api/document-master?limit=1000').set('Authorization', as('employeeA'));
    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(doc.publicB.id);
    expect(ids(res)).not.toContain(doc.confidentialB.id);
    expect(res.body.data.every(d => d.company_id === co.A)).toBe(true);
  });

  it("hides colleagues' confidential and restricted documents from a plain viewer, but shows their own", async () => {
    const res = await request(app).get('/api/document-master?limit=1000').set('Authorization', as('employeeA'));
    expect(ids(res)).toContain(doc.publicA.id);
    expect(ids(res)).toContain(doc.ownConfA.id);
    expect(ids(res)).not.toContain(doc.confidentialA.id);
    expect(ids(res)).not.toContain(doc.restrictedA.id);
  });

  it('shows confidential documents of its own company to a document manager (documents:edit)', async () => {
    const res = await request(app).get('/api/document-master?limit=1000').set('Authorization', as('managerA'));
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(expect.arrayContaining([doc.publicA.id, doc.confidentialA.id, doc.restrictedA.id]));
    expect(ids(res)).not.toContain(doc.confidentialB.id);
  });

  it('drive-status needs documents:view', async () => {
    const denied = await request(app).get('/api/document-master/drive-status').set('Authorization', as('storeA'));
    expect(denied.status).toBe(403);
    const ok = await request(app).get('/api/document-master/drive-status').set('Authorization', as('employeeA'));
    expect(ok.status).toBe(200);
  });
});

// ── 2. Detail, download and revisions ───────────────────────────────────────
describe('GET /document-master/:id, /:id/download, /entity/:type/:id/revisions', () => {
  it("returns 404 for another company's document (detail)", async () => {
    const res = await request(app).get(`/api/document-master/${doc.confidentialB.id}`).set('Authorization', as('adminA'));
    expect(res.status).toBe(404);
  });

  it("refuses to download another company's confidential document, and logs no download", async () => {
    const res = await request(app).get(`/api/document-master/${doc.confidentialB.id}/download`).set('Authorization', as('adminA'));
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
    const { rows } = await pool.query(`SELECT 1 FROM document_download_log WHERE document_id = $1`, [doc.confidentialB.id]);
    expect(rows).toHaveLength(0);
  });

  it("refuses to download another company's ordinary document", async () => {
    const res = await request(app).get(`/api/document-master/${doc.publicB.id}/download`).set('Authorization', as('employeeA'));
    expect(res.status).toBe(404);
  });

  it("refuses a colleague's confidential document to a plain viewer (detail and download)", async () => {
    const d = await request(app).get(`/api/document-master/${doc.confidentialA.id}`).set('Authorization', as('employeeA'));
    expect(d.status).toBe(404);
    const dl = await request(app).get(`/api/document-master/${doc.confidentialA.id}/download`).set('Authorization', as('employeeA'));
    expect(dl.status).toBe(404);
  });

  it('denies detail and download without documents:view', async () => {
    const d = await request(app).get(`/api/document-master/${doc.publicA.id}`).set('Authorization', as('storeA'));
    expect(d.status).toBe(403);
    const dl = await request(app).get(`/api/document-master/${doc.publicA.id}/download`).set('Authorization', as('storeA'));
    expect(dl.status).toBe(403);
  });

  it('lets a same-company viewer open and download an ordinary document (and logs it)', async () => {
    const d = await request(app).get(`/api/document-master/${doc.publicA.id}`).set('Authorization', as('employeeA'));
    expect(d.status).toBe(200);
    expect(d.body.data.checksum_sha256).toBe('abc123');
    const dl = await request(app).get(`/api/document-master/${doc.publicA.id}/download`).set('Authorization', as('employeeA'));
    expect(dl.status).toBe(302);
    expect(dl.headers.location).toBe(doc.publicA.drive_link);
    const { rows } = await pool.query(
      `SELECT downloaded_by FROM document_download_log WHERE document_id = $1`, [doc.publicA.id]);
    expect(rows.map(r => r.downloaded_by)).toContain(u.employeeA.id);
  });

  it('lets a document manager download a confidential document of its own company', async () => {
    const dl = await request(app).get(`/api/document-master/${doc.confidentialA.id}/download`).set('Authorization', as('managerA'));
    expect(dl.status).toBe(302);
  });

  it("never lists another company's revisions", async () => {
    const res = await request(app).get(`/api/document-master/entity/project/${ENTITY_B}/revisions`).set('Authorization', as('adminA'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    const own = await request(app).get(`/api/document-master/entity/project/${ENTITY_B}/revisions`).set('Authorization', as('adminB'));
    expect(own.body.data.map(d => d.id)).toEqual(expect.arrayContaining([doc.publicB.id, doc.confidentialB.id]));
  });
});

// ── 3. Upload ───────────────────────────────────────────────────────────────
describe('POST /document-master/upload', () => {
  const upload = (who, fields = {}) => {
    const r = request(app).post('/api/document-master/upload').set('Authorization', as(who));
    Object.entries(fields).forEach(([k, v]) => r.field(k, String(v)));
    return r.attach('file', Buffer.from(`${TAG} content`), `${TAG}-upload.txt`);
  };

  it('denies an upload without documents:add', async () => {
    const res = await upload('employeeA', { module_type: 'engineering' });
    expect(res.status).toBe(403);
  });

  it('ignores a company_id in the body: the document lands in the caller company', async () => {
    const res = await upload('managerA', { module_type: 'engineering', company_id: co.B });
    expect(res.status).toBe(201);
    expect(res.body.data.company_id).toBe(co.A);
    expect(res.body.data.uploaded_by).toBe(u.managerA.id);
    expect(res.body.data.approval_status).toBe('draft');
  });

  it("refuses to supersede another company's document", async () => {
    const res = await upload('managerA', { module_type: 'engineering', supersedes_id: doc.publicB.id });
    expect(res.status).toBe(400);
  });

  it('still lets an employee attach a leave document, stored confidential to their company', async () => {
    const res = await upload('employeeA', { module_type: 'leave', linked_entity_type: 'leave_application' });
    expect(res.status).toBe(201);
    expect(res.body.data.company_id).toBe(co.A);
    expect(res.body.data.is_confidential).toBe(true);
    // ...readable by its uploader, not by another plain viewer of the company.
    const own = await request(app).get(`/api/document-master/${res.body.data.id}`).set('Authorization', as('employeeA'));
    expect(own.status).toBe(200);
    const other = await request(app).get(`/api/document-master/${res.body.data.id}`).set('Authorization', as('employee2A'));
    expect(other.status).toBe(404);
  });
});

// ── 4. Approval workflow ────────────────────────────────────────────────────
describe('POST /document-master/:id/approve and /reject', () => {
  it('denies approval without documents:approve', async () => {
    const res = await request(app).post(`/api/document-master/${doc.toApproveA.id}/approve`).set('Authorization', as('managerA'));
    expect(res.status).toBe(403);
    expect((await reload('toApproveA')).approval_status).toBe('draft');
  });

  it('refuses self-approval, even for an approver', async () => {
    const res = await request(app).post(`/api/document-master/${doc.byAdminA.id}/approve`).set('Authorization', as('adminA'));
    expect(res.status).toBe(403);
    const after = await reload('byAdminA');
    expect(after.approval_status).toBe('draft');
    expect(after.approved_by).toBeNull();
  });

  it('ignores a client-supplied approver', async () => {
    const res = await request(app).post(`/api/document-master/${doc.byAdminA.id}/approve`)
      .set('Authorization', as('adminA')).send({ approved_by: u.admin2A.id, user_id: u.admin2A.id });
    expect(res.status).toBe(403);
    expect((await reload('byAdminA')).approval_status).toBe('draft');
  });

  it("returns 404 when approving another company's document, and leaves it untouched", async () => {
    const res = await request(app).post(`/api/document-master/${doc.publicB.id}/approve`).set('Authorization', as('adminA'));
    expect(res.status).toBe(404);
    expect((await reload('publicB')).approval_status).toBe('draft');
  });

  it("returns 404 when rejecting another company's document", async () => {
    const res = await request(app).post(`/api/document-master/${doc.publicA.id}/reject`).set('Authorization', as('adminB'));
    expect(res.status).toBe(404);
    expect((await reload('publicA')).approval_status).toBe('draft');
  });

  it('denies rejection without documents:approve', async () => {
    const res = await request(app).post(`/api/document-master/${doc.toApproveA.id}/reject`).set('Authorization', as('employeeA'));
    expect(res.status).toBe(403);
  });

  it('lets an approver of the same company reject', async () => {
    const res = await request(app).post(`/api/document-master/${doc.toRejectA.id}/reject`).set('Authorization', as('admin2A'));
    expect(res.status).toBe(200);
    expect((await reload('toRejectA')).approval_status).toBe('rejected');
  });

  it('lets a different approver of the same company approve, recording the authenticated user', async () => {
    const res = await request(app).post(`/api/document-master/${doc.toApproveA.id}/approve`).set('Authorization', as('admin2A'));
    expect(res.status).toBe(200);
    const after = await reload('toApproveA');
    expect(after.approval_status).toBe('approved');
    expect(after.approved_by).toBe(u.admin2A.id);
    expect(after.approved_at).not.toBeNull();
    // Revision and checksum untouched by the decision.
    expect(after.revision).toBe(doc.toApproveA.revision);
    expect(after.checksum_sha256).toBe('abc123');
  });
});

// ── 5. Expiry, signature link, delete ───────────────────────────────────────
describe('PATCH /:id/expiry, POST /:id/link-signature, DELETE /:id', () => {
  it('expiry: denied without documents:edit; 404 across companies; allowed in-company', async () => {
    const denied = await request(app).patch(`/api/document-master/${doc.publicA.id}/expiry`)
      .set('Authorization', as('employeeA')).send({ expiry_date: '2030-01-01' });
    expect(denied.status).toBe(403);
    const cross = await request(app).patch(`/api/document-master/${doc.publicB.id}/expiry`)
      .set('Authorization', as('managerA')).send({ expiry_date: '2030-01-01' });
    expect(cross.status).toBe(404);
    expect((await reload('publicB')).expiry_date).toBeNull();
    const ok = await request(app).patch(`/api/document-master/${doc.publicA.id}/expiry`)
      .set('Authorization', as('managerA')).send({ expiry_date: '2030-01-01' });
    expect(ok.status).toBe(200);
  });

  it('link-signature: denied without documents:edit; 404 across companies', async () => {
    const denied = await request(app).post(`/api/document-master/${doc.publicA.id}/link-signature`)
      .set('Authorization', as('employeeA')).send({ signing_id: 1 });
    expect(denied.status).toBe(403);
    const cross = await request(app).post(`/api/document-master/${doc.publicB.id}/link-signature`)
      .set('Authorization', as('managerA')).send({ signing_id: 1 });
    expect(cross.status).toBe(404);
    expect((await reload('publicB')).signing_id).toBeNull();
  });

  it("link-signature: links a same-company signature request, refuses another company's", async () => {
    const sig = async (company) => (await pool.query(
      `INSERT INTO document_signings (title, recipient_name, recipient_email, company_id)
       VALUES ($1, 'Signer', 'signer@test.invalid', $2) RETURNING id`, [`${TAG} sig`, company])).rows[0].id;
    const sigA = await sig(co.A);
    const sigB = await sig(co.B);
    const foreign = await request(app).post(`/api/document-master/${doc.restrictedA.id}/link-signature`)
      .set('Authorization', as('managerA')).send({ signing_id: sigB });
    expect(foreign.status).toBe(400);
    expect((await reload('restrictedA')).signing_id).toBeNull();
    const ok = await request(app).post(`/api/document-master/${doc.restrictedA.id}/link-signature`)
      .set('Authorization', as('managerA')).send({ signing_id: sigA });
    expect(ok.status).toBe(200);
    const after = await reload('restrictedA');
    expect(after.signing_id).toBe(sigA);
    expect(after.signed_status).toBe('pending');
  });

  it('delete: denied without documents:delete', async () => {
    const res = await request(app).delete(`/api/document-master/${doc.toDeleteA.id}`).set('Authorization', as('managerA'));
    expect(res.status).toBe(403);
    expect((await reload('toDeleteA')).deleted_at).toBeNull();
  });

  it("delete: 404 for another company's document, which stays", async () => {
    const res = await request(app).delete(`/api/document-master/${doc.publicB.id}`).set('Authorization', as('adminA'));
    expect(res.status).toBe(404);
    expect((await reload('publicB')).deleted_at).toBeNull();
  });

  it('delete: an in-company admin can still soft-delete a draft, and approved documents stay protected', async () => {
    const ok = await request(app).delete(`/api/document-master/${doc.toDeleteA.id}`).set('Authorization', as('adminA'));
    expect(ok.status).toBe(200);
    expect((await reload('toDeleteA')).deleted_at).not.toBeNull();
    const approved = await request(app).delete(`/api/document-master/${doc.toApproveA.id}`).set('Authorization', as('adminA'));
    expect(approved.status).toBe(409);
  });
});
