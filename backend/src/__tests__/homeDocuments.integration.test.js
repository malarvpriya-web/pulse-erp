/**
 * Home Policies + Brand Vault — what reaches every employee, and what the
 * Download button returns (20261019000001, home/documentDownload.js).
 *
 * Against the live database and the real routers + verifyToken:
 *   - the Policies panel lists only active, company-wide (applicable_to='all')
 *     policies of the caller's company, ONE tile per policy at its latest
 *     version in effect; internal SOPs, retired rows, a future version and
 *     another tenant's policies never appear;
 *   - no Drive link is shipped to the browser; each tile says how it downloads;
 *   - GET /home/documents/:kind/:id/download returns the FILE: bytes,
 *     Content-Disposition: attachment with the real filename, and a Google
 *     Doc exported to .docx — and refuses (404) anything the panel would not
 *     show, including Brand Vault items restricted to other roles;
 *   - a file that is not shared ends as a JSON NOT_SHARED error, never as
 *     Google's sign-in page passed off as the document;
 *   - /hr/policies keeps internal and retired policies away from employees;
 *   - Brand Vault writes are tenant-scoped, refuse folder links, and cannot
 *     create a second active item with the same title.
 *
 * Google is replaced by a local HTTP stub (DRIVE_PUBLIC) that reproduces the
 * two responses observed from the real endpoint: the file with an attachment
 * header, or a redirect to an HTML sign-in page. Fixtures live in two registry
 * tenants (testTenantIds.contract.test.js) and are deleted in afterAll.
 * ⚠ Do not run this while a Playwright crawl is going.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import http from 'node:http';

if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pw = readFileSync(resolve(here, '../../.env'), 'utf8').match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!pw) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = pw;
}
// The public-link path is what this suite exercises; the service-account path
// needs real Google credentials.
delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_PATH;

const { default: pool } = await import('../config/db.js');
const { default: bcrypt } = await import('bcryptjs');
const { default: express } = await import('express');
const { default: request } = await import('supertest');
const { loginUser } = await import('../auth/auth.service.js');
const { syncPrimaryRole } = await import('../services/userRoles.js');
const { verifyToken } = await import('../middlewares/auth.middleware.js');
const { default: homeRoutes } = await import('../home/home.routes.js');
const { default: hrRoutes } = await import('../modules/hr/hr.routes.js');
const { default: adminRoutes } = await import('../modules/admin/admin.routes.js');
const dl = await import('../home/documentDownload.js');

const A = 999977;
const B = 999978;
const PW = 'Zz-HomeDoc-Test-9!';
const fx = { tok: {}, user: {}, pol: {}, brand: {} };

const PDF = Buffer.from('%PDF-1.4\n% zz home-doc fixture\n%%EOF\n');
const DOCX = Buffer.from('PK\u0003\u0004 zz docx export fixture');
const FILES = {
  ZZPUBLICFILE01: { body: PDF, name: 'Leave Policy v1.0.pdf' },
  ZZPUBLICFILE02: { body: PDF, name: 'Leave Policy – v1.1.pdf' },   // non-ASCII on purpose
  ZZPUBLICLOGO03: { body: Buffer.from('PK\u0003\u0004 zz logo pack'), name: 'Logo Pack.zip', type: 'application/zip' },
};
const exportsRequested = [];

const stub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  if (u.pathname === '/download') {
    const id = u.searchParams.get('id');
    if (FILES[id]) {
      const f = FILES[id];
      res.writeHead(200, {
        'Content-Type': f.type || 'application/pdf',
        'Content-Disposition': `attachment; filename="${f.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Content-Length': f.body.length,
      });
      return res.end(f.body);
    }
    if (id === 'ZZRESTRICTED04') { res.writeHead(302, { Location: '/signin' }); return res.end(); }
    res.writeHead(404); return res.end();
  }
  if (u.pathname === '/signin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><body>Sign in - Google Accounts</body></html>');
  }
  const exp = u.pathname.match(/^\/document\/d\/([^/]+)\/export$/);
  if (exp) {
    exportsRequested.push(`${exp[1]}:${u.searchParams.get('format')}`);
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    return res.end(DOCX);
  }
  res.writeHead(404); res.end();
});

const app = express();
app.use(express.json());
app.use('/api/home', homeRoutes);
app.use('/api/hr', verifyToken, hrRoutes);
app.use('/api/admin', verifyToken, adminRoutes);
const as = (who) => ({ Authorization: `Bearer ${fx.tok[who]}` });
const binary = (res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); };
const summary = async (who) => (await request(app).get('/api/home/summary').set(as(who))).body;
const download = (who, kind, id) => request(app).get(`/api/home/documents/${kind}/${id}/download`)
  .set(as(who)).buffer(true).parse(binary);
const json = (res) => JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : JSON.stringify(res.body));

const drive = (id) => `https://drive.google.com/file/d/${id}/view?usp=sharing`;

async function cleanup() {
  const c = [A, B];
  const users = `SELECT id FROM users WHERE email LIKE 'zz.homedoc.%@example.com'`;
  await pool.query(`DELETE FROM hr_policy_acknowledgements WHERE policy_id IN (SELECT id FROM hr_policies WHERE company_id = ANY($1::int[]))`, [c]);
  await pool.query(`DELETE FROM hr_policies WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM company_documents WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM user_scope WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM user_roles WHERE user_id IN (${users})`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'zz.homedoc.%@example.com'`);
  // talent.routes.js seeds default interview questions for every active company.
  await pool.query(`DELETE FROM interview_questions WHERE company_id = ANY($1::int[])`, [c]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1::int[])`, [c]);
}

async function login(key, role, cid) {
  const email = `zz.homedoc.${key}@example.com`;
  const hash = await bcrypt.hash(PW, 4);
  fx.user[key] = (await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, company_id)
     VALUES ($1,$2,$3,$4,true,$5) RETURNING id`, [`Zz ${key}`, email, hash, role, cid])).rows[0].id;
  await pool.query(`INSERT INTO user_scope (user_id, company_id, is_primary) VALUES ($1,$2,true)`, [fx.user[key], cid]);
  await syncPrimaryRole(fx.user[key], role, cid);
  fx.tok[key] = (await loginUser(email, PW)).token;
}

let ageSeq = 0;
async function policy(key, cid, title, version, url, { audience = 'all', active = true, effective = null } = {}) {
  ageSeq += 1;
  fx.pol[key] = (await pool.query(
    `INSERT INTO hr_policies (company_id, title, category, version, file_url, drive_url, applicable_to,
                              is_active, effective_date, created_at)
     VALUES ($1,$2,'General',$3,$4,$5,$6,$7,$8, NOW() - make_interval(mins => 100 - $9::int)) RETURNING id`,
    [cid, title, version, url, url?.includes('drive.google.com') ? url : null, audience, active, effective, ageSeq],
  )).rows[0].id;
}
async function brand(key, cid, title, url, roles = null) {
  fx.brand[key] = (await pool.query(
    `INSERT INTO company_documents (company_id, title, category, file_url, visible_roles)
     VALUES ($1,$2,'brand_assets',$3,$4) RETURNING id`, [cid, title, url, roles])).rows[0].id;
}

beforeAll(async () => {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${stub.address().port}`;
  dl.DRIVE_PUBLIC.content = base;
  dl.DRIVE_PUBLIC.docs = base;

  await cleanup();
  await pool.query(`INSERT INTO companies (id, name, code) VALUES ($1,'ZZ HomeDoc A','ZZHDA'), ($2,'ZZ HomeDoc B','ZZHDB')`, [A, B]);
  await login('hr', 'hr', A);
  await login('employee', 'employee', A);
  await login('hrB', 'hr', B);

  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  await policy('leaveOld', A, 'Leave Policy', 'v1.0', drive('ZZPUBLICFILE01'));
  await policy('leaveCur', A, 'Leave Policy', 'v1.1', drive('ZZPUBLICFILE02'), { effective: '2026-01-01' });
  await policy('leaveNext', A, 'leave policy ', 'v2.0', drive('ZZPUBLICFILE01'), { effective: future });
  await policy('sop', A, 'Payroll Run SOP', 'v1.0', drive('ZZPUBLICFILE01'), { audience: 'internal' });
  await policy('retired', A, 'Travel Policy', 'v3.0', drive('ZZPUBLICFILE01'), { active: false });
  await policy('seedAudience', A, 'SEED Hr Policies 1', 'v1.0', drive('ZZPUBLICFILE01'), { audience: 'SEED applicable to 1' });
  await policy('conduct', A, 'Code of Conduct', 'v2.0', 'https://docs.google.com/document/d/ZZGOOGLEDOC05/edit?usp=sharing');
  await policy('dress', A, 'Dress Code', 'v1.0', drive('ZZRESTRICTED04'));
  await policy('gone', A, 'Grievance Policy', 'v1.0', drive('ZZDELETEDFILE6'));
  await policy('holidays', A, 'Holiday List', 'v1.0', 'https://example.com/holidays-2026');
  await policy('unlinked', A, 'IT Policy', 'v1.0', '#');
  await policy('otherTenant', B, 'B Only Policy', 'v1.0', drive('ZZPUBLICFILE01'));

  await brand('logo', A, 'Logo Pack', drive('ZZPUBLICLOGO03'));
  await brand('letterhead', A, 'Letterhead Template', drive('ZZPUBLICFILE01'), ['hr']);
  await brand('quotation', A, 'Quotation Template', null);
  await brand('otherLogo', B, 'Logo Pack', drive('ZZPUBLICLOGO03'));
}, 90000);

afterAll(async () => {
  await cleanup();
  await new Promise((r) => stub.close(r));
});

describe('Home Policies panel — company-wide, latest version only', () => {
  it('shows one tile per active company-wide policy, latest version in effect', async () => {
    const { policies } = await summary('employee');
    const titles = policies.map((p) => p.title);
    expect(titles).toEqual(['Code of Conduct', 'Dress Code', 'Grievance Policy', 'Holiday List', 'IT Policy', 'Leave Policy']);
    const leave = policies.find((p) => p.title === 'Leave Policy');
    expect(leave.id).toBe(fx.pol.leaveCur);           // not v1.0 (superseded), not v2.0 (not yet effective)
    expect(leave.version).toBe('v1.1');
    expect(String(leave.effective_date)).toMatch(/^2026-01-01|2025-12-31/);
  });

  it('never lists internal SOPs, retired policies, unknown audiences, or another tenant', async () => {
    const ids = (await summary('hr')).policies.map((p) => p.id);   // HR's own Home is no different
    for (const k of ['sop', 'retired', 'seedAudience', 'otherTenant', 'leaveOld', 'leaveNext']) {
      expect(ids, k).not.toContain(fx.pol[k]);
    }
  });

  it('ships no Drive link to the browser; each tile says how it downloads', async () => {
    const { policies } = await summary('employee');
    const by = Object.fromEntries(policies.map((p) => [p.title, p]));
    expect(by['Leave Policy']).toMatchObject({ download: 'file', file_url: null });
    expect(by['Code of Conduct']).toMatchObject({ download: 'file', file_url: null });
    expect(by['Holiday List']).toMatchObject({ download: 'link', file_url: 'https://example.com/holidays-2026' });
    expect(by['IT Policy']).toMatchObject({ download: null, file_url: null });
    expect(JSON.stringify(policies)).not.toContain('drive.google.com');
  });
});

describe('Download returns the actual file', () => {
  it('streams a Drive file as an attachment with its real (UTF-8) filename', async () => {
    const res = await download('employee', 'policy', fx.pol.leaveCur);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Leave Policy – v1.1.pdf')}`);
    expect(Buffer.compare(res.body, PDF)).toBe(0);
  });

  it('exports a Google Doc to .docx', async () => {
    const res = await download('employee', 'policy', fx.pol.conduct);
    expect(res.status).toBe(200);
    expect(exportsRequested).toContain('ZZGOOGLEDOC05:docx');
    expect(res.headers['content-disposition']).toContain('filename="Code of Conduct.docx"');
    expect(Buffer.compare(res.body, DOCX)).toBe(0);
  });

  it('a file that is not shared is a JSON NOT_SHARED error, not the sign-in page', async () => {
    const res = await download('employee', 'policy', fx.pol.dress);
    expect(res.status).toBe(502);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(json(res)).toMatchObject({ code: 'NOT_SHARED' });
    expect(res.body.toString('utf8')).not.toContain('Sign in');
  });

  it('a file deleted from Drive and an unlinked policy are 404s with a reason', async () => {
    expect(json(await download('employee', 'policy', fx.pol.gone))).toMatchObject({ code: 'DRIVE_NOT_FOUND' });
    const unlinked = await download('employee', 'policy', fx.pol.unlinked);
    expect(unlinked.status).toBe(404);
    expect(json(unlinked)).toMatchObject({ code: 'NO_FILE' });
  });

  it('refuses every policy the panel would not show', async () => {
    for (const k of ['sop', 'retired', 'seedAudience', 'otherTenant']) {
      const res = await download('employee', 'policy', fx.pol[k]);
      expect(res.status, k).toBe(404);
      expect(json(res), k).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect((await download('employee', 'nonsense', fx.pol.leaveCur)).status).toBe(404);
    expect((await request(app).get(`/api/home/documents/policy/${fx.pol.leaveCur}/download`)).status).toBe(401);
  });

  it('Brand Vault: downloads the file, respects role restrictions and tenants', async () => {
    const logo = await download('employee', 'brand', fx.brand.logo);
    expect(logo.status).toBe(200);
    expect(logo.headers['content-disposition']).toContain('filename="Logo Pack.zip"');
    expect(Buffer.compare(logo.body, FILES.ZZPUBLICLOGO03.body)).toBe(0);

    expect((await download('employee', 'brand', fx.brand.letterhead)).status).toBe(404);
    expect((await download('hr', 'brand', fx.brand.letterhead)).status).toBe(200);
    expect((await download('employee', 'brand', fx.brand.otherLogo)).status).toBe(404);
    expect(json(await download('employee', 'brand', fx.brand.quotation))).toMatchObject({ code: 'NO_FILE' });

    const tiles = (await summary('employee')).brandAssets.map((b) => b.title);
    expect(tiles).toEqual(['Logo Pack', 'Quotation Template']);
  });
});

describe('HR Policies page — audience and active status', () => {
  it('employees see only active company-wide policies; HR sees all of its company', async () => {
    const emp = (await request(app).get('/api/hr/policies').set(as('employee'))).body.map((p) => p.id);
    expect(emp).toContain(fx.pol.leaveCur);
    for (const k of ['sop', 'retired', 'seedAudience']) expect(emp, k).not.toContain(fx.pol[k]);
    const hr = (await request(app).get('/api/hr/policies').set(as('hr'))).body.map((p) => p.id);
    for (const k of ['sop', 'retired', 'seedAudience', 'leaveCur']) expect(hr, k).toContain(fx.pol[k]);
    expect(hr).not.toContain(fx.pol.otherTenant);
  });

  it('HR creates an internal policy and retires a company-wide one — both leave Home', async () => {
    const created = await request(app).post('/api/hr/policies').set(as('hr')).send({
      title: 'Offer Letter SOP', version: 'v1.0', category: 'General',
      file_url: drive('ZZPUBLICFILE01'), applicable_to: 'internal',
    });
    expect(created.status).toBe(200);
    expect(created.body.applicable_to).toBe('internal');
    fx.pol.created = created.body.id;

    const retire = await request(app).put(`/api/hr/policies/${fx.pol.holidays}`).set(as('hr')).send({ is_active: false });
    expect(retire.status).toBe(200);
    expect(retire.body.is_active).toBe(false);
    expect(retire.body.file_url).toBe('https://example.com/holidays-2026');   // a partial update keeps the link

    const titles = (await summary('employee')).policies.map((p) => p.title);
    expect(titles).not.toContain('Offer Letter SOP');
    expect(titles).not.toContain('Holiday List');
  });

  it('an unknown audience is stored as internal (fail closed); a folder link is refused', async () => {
    const odd = await request(app).post('/api/hr/policies').set(as('hr')).send({
      title: 'Odd Audience', version: 'v1.0', file_url: drive('ZZPUBLICFILE01'), applicable_to: 'everyone',
    });
    expect(odd.body.applicable_to).toBe('internal');
    const folder = await request(app).post('/api/hr/policies').set(as('hr')).send({
      title: 'Folder Link', version: 'v1.0', file_url: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn',
    });
    expect(folder.status).toBe(400);
    expect(folder.body.error).toMatch(/not a Drive folder/);
  });

  it('changing the link off Drive also replaces the stored Drive copy', async () => {
    const res = await request(app).put(`/api/hr/policies/${fx.pol.leaveOld}`).set(as('hr'))
      .send({ file_url: 'https://example.com/leave.pdf' });
    expect(res.status).toBe(200);
    expect(res.body.drive_url).toBeNull();
  });

  it('employees cannot write policies', async () => {
    expect((await request(app).put(`/api/hr/policies/${fx.pol.leaveCur}`).set(as('employee')).send({ is_active: false })).status).toBe(403);
  });
});

describe('Brand Vault editor — scoped, validated, one item per title', () => {
  it('cannot edit or remove another company\'s item', async () => {
    const put = await request(app).put(`/api/admin/company-documents/${fx.brand.otherLogo}`).set(as('hr'))
      .send({ title: 'Hijacked', file_url: drive('ZZPUBLICFILE01') });
    // hr is not an admin role at all; the tenant check is exercised by hrB → A below via admin.
    expect([403, 404]).toContain(put.status);
    const { rows } = await pool.query(`SELECT title FROM company_documents WHERE id = $1`, [fx.brand.otherLogo]);
    expect(rows[0].title).toBe('Logo Pack');
  });

  it('as an admin: cross-tenant 404, folder link 400, duplicate title 409, version saved', async () => {
    await login('admin', 'admin', A);
    const cross = await request(app).put(`/api/admin/company-documents/${fx.brand.otherLogo}`).set(as('admin'))
      .send({ title: 'Hijacked', file_url: drive('ZZPUBLICFILE01') });
    expect(cross.status).toBe(404);
    expect((await request(app).delete(`/api/admin/company-documents/${fx.brand.otherLogo}`).set(as('admin'))).status).toBe(404);

    const folder = await request(app).put(`/api/admin/company-documents/${fx.brand.quotation}`).set(as('admin'))
      .send({ title: 'Quotation Template', file_url: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn' });
    expect(folder.status).toBe(400);

    const dup = await request(app).post('/api/admin/company-documents').set(as('admin'))
      .send({ title: 'logo pack', file_url: drive('ZZPUBLICLOGO03') });
    expect(dup.status).toBe(409);

    const linked = await request(app).put(`/api/admin/company-documents/${fx.brand.quotation}`).set(as('admin'))
      .send({ title: 'Quotation Template', file_url: drive('ZZPUBLICFILE01'), version: 'v3', effective_date: '2026-10-01' });
    expect(linked.status).toBe(200);
    expect(linked.body.version).toBe('v3');
    const tile = (await summary('employee')).brandAssets.find((b) => b.id === fx.brand.quotation);
    expect(tile).toMatchObject({ download: 'file', version: 'v3' });
    expect((await download('employee', 'brand', fx.brand.quotation)).status).toBe(200);
  });
});

describe('documentDownload unit rules', () => {
  it('parses Drive file, open?id, uc and Google-native links; rejects folders and look-alikes', () => {
    expect(dl.parseDriveRef('https://drive.google.com/file/d/1MzrwMCzYdk4WBIZbLFIvoGe_-C05FAEB/view?usp=sharing'))
      .toEqual({ kind: 'file', id: '1MzrwMCzYdk4WBIZbLFIvoGe_-C05FAEB' });
    expect(dl.parseDriveRef('https://drive.google.com/open?id=ABCDEFGHIJ12')).toEqual({ kind: 'file', id: 'ABCDEFGHIJ12' });
    expect(dl.parseDriveRef('https://drive.google.com/uc?export=download&id=ABCDEFGHIJ12')).toEqual({ kind: 'file', id: 'ABCDEFGHIJ12' });
    expect(dl.parseDriveRef('https://docs.google.com/presentation/d/ABCDEFGHIJ12/edit')).toEqual({ kind: 'presentation', id: 'ABCDEFGHIJ12' });
    expect(dl.parseDriveRef('https://drive.google.com/drive/folders/ABCDEFGHIJ12?id=ABCDEFGHIJ12')).toBeNull();
    expect(dl.parseDriveRef('https://drive.google.com.evil.example/file/d/ABCDEFGHIJ12/view')).toBeNull();
    expect(dl.classifySource('/documents/brand/logo-pack.zip')).toBeNull();
    expect(dl.classifySource('https://drive.google.com/drive/folders/ABCDEFGHIJ12')).toBeNull();
    expect(dl.classifySource('https://example.com/x.pdf')).toBe('link');
  });

  it('filenames: strips path characters, adds the extension the content type implies', () => {
    expect(dl.safeFilename('../../etc/passwd', 'application/pdf')).toBe('.. .. etc passwd.pdf');
    expect(dl.safeFilename(null, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Presentation Template'))
      .toBe('Presentation Template.pptx');
    expect(dl.contentDisposition('Leave – 2026.pdf'))
      .toBe(`attachment; filename="Leave _ 2026.pdf"; filename*=UTF-8''${encodeURIComponent('Leave – 2026.pdf')}`);
  });
});
