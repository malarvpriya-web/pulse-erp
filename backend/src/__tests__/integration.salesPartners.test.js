/**
 * integration.salesPartners.test.js — the Partner (IPU) master, against the REAL
 * database.
 *
 * DELIBERATELY NOT MOCKED. Every other route test in this repo stubs the pool,
 * which proves the handler's control flow and nothing about its SQL. The failure
 * mode this module actually had was schema drift — a table with four conflicting
 * definitions and a route selecting columns that did not exist — and a mocked
 * pool cannot see that. These tests run the real statements against the real
 * schema, so a column rename breaks them.
 *
 * They are self-cleaning: every row created is removed in afterAll, keyed off the
 * TAG below so a crashed run cannot leave debris behind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import request from 'supertest';

// ── real DB credentials ───────────────────────────────────────────────────────
// __tests__/setup.js sets DB_PASSWORD='test-db-password' because every other
// test mocks the pool. This suite does not, so the real password is restored
// FIRST — config/db.js builds its Pool at import time, which is why every
// import below that reaches it must be dynamic and come after this.
// JWT_SECRET is deliberately left as setup.js's test value so the tokens helper
// and verifyToken agree.
//
// config/db.js prefers DATABASE_URL over discrete DB_* vars, so when it is
// already set (CI, Docker — both pass the real connection string as an env
// var, not a checked-out .env file) DB_PASSWORD is irrelevant and there is
// nothing to restore. Only a local run without DATABASE_URL needs the real
// password pulled from the gitignored backend/.env.
if (!process.env.DATABASE_URL) {
  const here = dirname(fileURLToPath(import.meta.url));
  let envText;
  try {
    envText = readFileSync(resolve(here, '../../.env'), 'utf8');
  } catch {
    throw new Error(
      'Neither DATABASE_URL nor backend/.env is available — this suite needs a real database.'
    );
  }
  const dbPassword = envText.match(/^DB_PASSWORD=(.*)$/m)?.[1]?.trim();
  if (!dbPassword) throw new Error('DB_PASSWORD not found in backend/.env — this suite needs a real database.');
  process.env.DB_PASSWORD = dbPassword;
}

const { default: pool }    = await import('../config/db.js');
const { default: partnersRoutes } = await import('../modules/sales/routes/partners.routes.js');
const { verifyToken }      = await import('../middlewares/auth.middleware.js');
const { buildApp }         = await import('./helpers/testApp.js');
const { makeToken }        = await import('./helpers/tokens.js');

const app = buildApp(['/api/sales/partners', verifyToken, partnersRoutes]);

// The admin is DISCOVERED, not hardcoded: verifyToken re-reads the user from the
// DB on every request, and the tokens helper's default userId:1 is not an active
// account here (the canonical logins start at 848). Resolved in beforeAll.
let ADMIN_ID;
const auth = () => `Bearer ${makeToken({ userId: ADMIN_ID, role: 'admin' })}`;

const TAG = `ZZTEST_${Date.now()}`;
const created = { partners: [], leads: [] };

// A syntactically valid GSTIN that is not Karnataka — proves the module accepts
// any state, which is the point of the checklist's GSTIN note.
const GSTIN_MH = '27AAPCA0000A1Z5'; // Maharashtra
const GSTIN_KA = '29AAPCA0000A1Z5'; // Karnataka

beforeAll(async () => {
  // An active admin WITH a company scope: company_id must be non-null or the
  // scope-guarded routes read as global and the tenancy assertions prove nothing.
  // logout_at must be null too — a token minted now would otherwise read as
  // revoked (verifyToken compares iat against it).
  const { rows } = await pool.query(
    `SELECT u.id FROM users u
       JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
      WHERE u.is_active = true AND u.logout_at IS NULL AND us.company_id = 1
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                     WHERE ur.user_id = u.id AND LOWER(r.code) IN ('admin','super_admin'))
      ORDER BY u.id LIMIT 1`
  );
  if (!rows[0]) throw new Error('No active company-scoped admin found — these tests need a seeded DB.');
  ADMIN_ID = rows[0].id;
});

afterAll(async () => {
  if (created.partners.length) {
    await pool.query(`DELETE FROM sales_partners WHERE id = ANY($1::int[])`, [created.partners]);
  }
  if (created.leads.length) {
    await pool.query(`DELETE FROM leads WHERE id = ANY($1::int[])`, [created.leads]);
  }
  await pool.end();
});

const mkPartner = async (body) => {
  const res = await request(app).post('/api/sales/partners').set('Authorization', auth()).send(body);
  if (res.body?.id) created.partners.push(res.body.id);
  return res;
};

describe('Partner master (IPU) — grid', () => {
  it('returns a paginated envelope with the checklist columns', async () => {
    const res = await request(app).get('/api/sales/partners').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('total_pages');
  });

  it('accepts every sortable column the grid offers', async () => {
    // Guards the SORTABLE map against the column rename that started all this:
    // a key pointing at a dropped column would 500 here, not silently fall back.
    for (const sort of ['ipu_number', 'name', 'association_type', 'email', 'phone',
      'website', 'city', 'state', 'country', 'gstin', 'status', 'lead_count', 'created_at']) {
      const res = await request(app).get(`/api/sales/partners?sort=${sort}&dir=asc`).set('Authorization', auth());
      expect(res.status, `sort=${sort}`).toBe(200);
    }
  });

  it('serves filter options from the shared taxonomy', async () => {
    const res = await request(app).get('/api/sales/partners/filters').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.association_types).toEqual(['System Integrator', 'Partner']);
  });
});

describe('Partner master (IPU) — create', () => {
  it('issues a sequential IPU-##### number', async () => {
    const res = await mkPartner({ name: `${TAG} Alpha`, association_type: 'System Integrator' });
    expect(res.status).toBe(201);
    expect(res.body.ipu_number).toMatch(/^IPU-\d{5}$/);
  });

  it('persists every checklist column', async () => {
    const res = await mkPartner({
      name: `${TAG} Beta`, association_type: 'Partner', email: 'b@x.com',
      phone: '+91 80 555', website: 'beta.example', city: 'Pune',
      country: 'India', gstin: GSTIN_MH,
    });
    expect(res.status).toBe(201);

    const grid = await request(app)
      .get(`/api/sales/partners?search=${TAG} Beta`).set('Authorization', auth());
    const row = grid.body.data.find(r => r.id === res.body.id);
    expect(row).toMatchObject({
      name: `${TAG} Beta`, association_type: 'Partner', email: 'b@x.com',
      website: 'beta.example', city: 'Pune', country: 'India', gstin: GSTIN_MH,
    });
    expect(row.lead_count).toBe(0);
  });

  // Regression: commission_pct is NUMERIC(5,2) but COALESCE($n, 0) made Postgres
  // infer the parameter as INTEGER from the literal, so any fractional commission
  // 500'd — the form offers step="0.01", so this was the common case. Every test
  // above happened to use whole numbers or omit the field, which is exactly why a
  // browser run caught it and the suite did not.
  it('accepts a fractional commission_pct', async () => {
    const res = await mkPartner({ name: `${TAG} Frac`, commission_pct: 7.5 });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT commission_pct FROM sales_partners WHERE id=$1`, [res.body.id]);
    expect(Number(rows[0].commission_pct)).toBe(7.5);
  });

  it('accepts a fractional commission_pct when converting a lead', async () => {
    const lead = await pool.query(
      `INSERT INTO leads (company_name, status, company_id) VALUES ($1,'New',1) RETURNING id`,
      [`${TAG} FracLead`]
    );
    created.leads.push(lead.rows[0].id);
    const res = await request(app).post('/api/sales/partners/convert-lead')
      .set('Authorization', auth()).send({ lead_id: lead.rows[0].id, commission_pct: 2.25 });
    expect(res.status).toBe(201);
    created.partners.push(res.body.id);
    const { rows } = await pool.query(`SELECT commission_pct FROM sales_partners WHERE id=$1`, [res.body.id]);
    expect(Number(rows[0].commission_pct)).toBe(2.25);
  });

  it('rejects an association type outside the confirmed list', async () => {
    const res = await mkPartner({ name: `${TAG} Bad`, association_type: 'Reseller' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/System Integrator/);
  });

  it('rejects a malformed GSTIN', async () => {
    const res = await mkPartner({ name: `${TAG} BadGst`, gstin: 'NOTAGSTIN123456' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/GSTIN/i);
  });

  it('rejects an unknown GSTIN state code', async () => {
    const res = await mkPartner({ name: `${TAG} BadState`, gstin: '99AAPCA0000A1Z5' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/state code/i);
  });

  it('refuses a duplicate GSTIN with 409, not a 500', async () => {
    const a = await mkPartner({ name: `${TAG} Dup1`, gstin: GSTIN_KA });
    expect(a.status).toBe(201);
    const b = await mkPartner({ name: `${TAG} Dup2`, gstin: GSTIN_KA });
    expect(b.status).toBe(409);
    expect(b.body.error).toMatch(/already exists/i);
  });
});

describe('GSTIN state derivation', () => {
  // The checklist asked for the Karnataka '29' rule while noting partners may sit
  // anywhere. Both halves are asserted here.
  it('derives Karnataka from a 29 prefix', async () => {
    const res = await mkPartner({ name: `${TAG} KA`, gstin: '29AAPCB0000A1Z5', state: 'Wrong State' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT state FROM sales_partners WHERE id=$1`, [res.body.id]);
    // The typed State loses to the GSTIN prefix — they can never disagree.
    expect(rows[0].state).toBe('Karnataka');
  });

  it('accepts a non-Karnataka partner and derives its state', async () => {
    const res = await mkPartner({ name: `${TAG} MH`, gstin: '27AAPCB0000A1Z5' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT state FROM sales_partners WHERE id=$1`, [res.body.id]);
    expect(rows[0].state).toBe('Maharashtra');
  });
});

describe('Partner -> lead relationship', () => {
  it('View Leads returns leads attributed to the partner', async () => {
    const p = await mkPartner({ name: `${TAG} WithLeads` });
    const lead = await pool.query(
      `INSERT INTO leads (company_name, contact_person, email, status, company_id, partner_id)
       VALUES ($1,'Ravi','r@x.com','New',1,$2) RETURNING id`,
      [`${TAG} Lead A`, p.body.id]
    );
    created.leads.push(lead.rows[0].id);

    const res = await request(app)
      .get(`/api/sales/partners/${p.body.id}/leads`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].company_name).toBe(`${TAG} Lead A`);
    expect(res.body.partner.ipu_number).toBe(p.body.ipu_number);
  });

  it('counts leads in the grid so the action can be disabled honestly', async () => {
    const grid = await request(app)
      .get(`/api/sales/partners?search=${TAG} WithLeads`).set('Authorization', auth());
    expect(grid.body.data[0].lead_count).toBe(1);
  });

  it('404s View Leads for a partner outside the caller scope', async () => {
    const res = await request(app).get('/api/sales/partners/99999999/leads').set('Authorization', auth());
    expect(res.status).toBe(404);
  });
});

describe('Convert to Partner', () => {
  let leadId;

  beforeAll(async () => {
    const r = await pool.query(
      `INSERT INTO leads (company_name, contact_person, email, phone, location, status, company_id)
       VALUES ($1,'Meera','meera@conv.com','+91 99999','Chennai','Qualified',1) RETURNING id`,
      [`${TAG} Convertible`]
    );
    leadId = r.rows[0].id;
    created.leads.push(leadId);
  });

  it('offers the lead in the convertible list', async () => {
    const res = await request(app).get('/api/sales/partners/convertible-leads').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.some(l => l.id === leadId)).toBe(true);
  });

  it('carries the lead fields over instead of requiring re-entry', async () => {
    const res = await request(app).post('/api/sales/partners/convert-lead')
      .set('Authorization', auth())
      .send({ lead_id: leadId, gstin: '33AAPCC0000A1Z5' }); // only the lead can't supply
    expect(res.status).toBe(201);
    created.partners.push(res.body.id);

    const { rows } = await pool.query(
      `SELECT name, contact_name, email, phone, city, state, gstin, converted_from_lead_id
         FROM sales_partners WHERE id=$1`, [res.body.id]);
    expect(rows[0]).toMatchObject({
      name: `${TAG} Convertible`,     // <- from lead.company_name
      contact_name: 'Meera',          // <- from lead.contact_person
      email: 'meera@conv.com',
      phone: '+91 99999',
      city: 'Chennai',                // <- from lead.location
      state: 'Tamil Nadu',            // <- derived from the GSTIN supplied at convert
      converted_from_lead_id: leadId,
    });
  });

  it('attributes the originating lead to the new partner', async () => {
    const { rows } = await pool.query(`SELECT partner_id FROM leads WHERE id=$1`, [leadId]);
    expect(rows[0].partner_id).not.toBeNull();
  });

  it('does NOT mark the lead converted — that status means "became an opportunity"', async () => {
    const { rows } = await pool.query(`SELECT status FROM leads WHERE id=$1`, [leadId]);
    expect(String(rows[0].status).toLowerCase()).not.toBe('converted');
  });

  it('refuses a second conversion of the same lead', async () => {
    const res = await request(app).post('/api/sales/partners/convert-lead')
      .set('Authorization', auth()).send({ lead_id: leadId });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been converted/i);
  });

  it('drops the converted lead from the convertible list', async () => {
    const res = await request(app).get('/api/sales/partners/convertible-leads').set('Authorization', auth());
    expect(res.body.some(l => l.id === leadId)).toBe(false);
  });

  it('404s an unknown lead', async () => {
    const res = await request(app).post('/api/sales/partners/convert-lead')
      .set('Authorization', auth()).send({ lead_id: 99999999 });
    expect(res.status).toBe(404);
  });
});

describe('Update and soft delete', () => {
  it('updates and re-derives state from a changed GSTIN', async () => {
    const p = await mkPartner({ name: `${TAG} Upd`, gstin: '29AAPCD0000A1Z5' });
    const res = await request(app).put(`/api/sales/partners/${p.body.id}`)
      .set('Authorization', auth())
      .send({ name: `${TAG} Upd2`, gstin: '24AAPCD0000A1Z5', association_type: 'System Integrator' });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT name, state, association_type FROM sales_partners WHERE id=$1`, [p.body.id]);
    expect(rows[0]).toMatchObject({ name: `${TAG} Upd2`, state: 'Gujarat', association_type: 'System Integrator' });
  });

  it('soft deletes — the row survives and leaves the grid', async () => {
    const p = await mkPartner({ name: `${TAG} Del` });
    const res = await request(app).delete(`/api/sales/partners/${p.body.id}`).set('Authorization', auth());
    expect(res.status).toBe(200);

    const { rows } = await pool.query(`SELECT deleted_at FROM sales_partners WHERE id=$1`, [p.body.id]);
    expect(rows[0].deleted_at).not.toBeNull();

    const grid = await request(app).get(`/api/sales/partners?search=${TAG} Del`).set('Authorization', auth());
    expect(grid.body.data.find(r => r.id === p.body.id)).toBeUndefined();
  });
});
