/**
 * Smoke tests — Product Master (admin/product-lines + admin/product-ratings)
 *
 * The master behind Product Setup and every Product dropdown. See
 * 20260716000007.
 *
 * NOTE ON WHAT THESE CAN AND CANNOT CATCH: every DB call here is mocked, so
 * these tests prove the route contract (auth, validation, status codes) and
 * nothing about whether the SQL matches the live schema. The sibling
 * smoke.products.test.js passes 14/14 against /products endpoints that have
 * always thrown in production, because the mock happily returns columns the real
 * `products` table does not have. Schema agreement is verified against the live
 * DB instead; do not read a green run here as "the endpoint works".
 *
 * Runner: npx vitest run src/__tests__/smoke.productLines.test.js
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../config/db.js', () => ({ default: { query: vi.fn() } }));
vi.mock('../modules/audit/repositories/audit.repository.js', () => ({
  default: { create: vi.fn().mockResolvedValue({}) },
}));

import request from 'supertest';
import pool    from '../config/db.js';
import auditRepository from '../modules/audit/repositories/audit.repository.js';
import adminRoutes from '../modules/admin/admin.routes.js';
import { buildApp } from './helpers/testApp.js';
import { verifyToken } from '../middlewares/auth.middleware.js';
import { makeToken, employeeToken } from './helpers/tokens.js';

const app = buildApp(['/api/admin', verifyToken, adminRoutes]);

const ACTIVE_USER = { is_active: true, logout_at: null, company_id: 1, branch_id: null };

// company_id on the token gives req.scope the JWT fast-path, so resolveCompanyId
// answers without the extra companies lookup.
const adminTok = () => makeToken({ userId: 1, role: 'admin', company_id: 1 });

// verifyToken makes one pool.query (active-check); allowRoles does not query.
const auth = () => pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] });

const PRODUCT = {
  id: 1, line_name: 'ASTRA', voltage: '415V', voltage_class: 'LV',
  display_name: 'ASTRA - 415V', description: 'ASTRA series',
  company_id: 1, is_active: true, rating_count: 2,
};

const NO_VOLTAGE_PRODUCT = {
  ...PRODUCT, id: 3, line_name: 'ACB', voltage: null,
  display_name: 'ACB', description: 'Air circuit breaker', rating_count: 0,
};

const RATING = {
  id: 1, product_line_id: 1, rating: '100kVAR',
  description: '100kVAR variant', company_id: 1, is_active: true,
};

const dupErr = () => Object.assign(new Error('duplicate key'), { code: '23505' });

beforeEach(() => {
  vi.resetAllMocks();
  auditRepository.create.mockResolvedValue({});
});

// ── Auth gates ────────────────────────────────────────────────────────────────

describe('Auth gates', () => {
  it('GET /product-lines returns 401 without token', async () => {
    expect((await request(app).get('/api/admin/product-lines')).status).toBe(401);
  });

  it('POST /product-lines returns 401 without token', async () => {
    const res = await request(app).post('/api/admin/product-lines').send({ line_name: 'X', voltage_class: 'LV' });
    expect(res.status).toBe(401);
  });

  it('DELETE /product-lines/1 returns 401 without token', async () => {
    expect((await request(app).delete('/api/admin/product-lines/1')).status).toBe(401);
  });

  // The master is reference data every module's dropdown reads, so reads are
  // deliberately open to any authenticated user — not just admins.
  it('GET /product-lines is readable by a non-admin', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [PRODUCT] });

    const res = await request(app)
      .get('/api/admin/product-lines')
      .set('Authorization', `Bearer ${employeeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body[0].display_name).toBe('ASTRA - 415V');
  });

  it('POST /product-lines is refused for a non-admin', async () => {
    auth();
    const res = await request(app)
      .post('/api/admin/product-lines')
      .set('Authorization', `Bearer ${employeeToken()}`)
      .send({ line_name: 'X', voltage_class: 'LV' });

    expect(res.status).toBe(403);
  });
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe('GET /api/admin/product-lines', () => {
  it('200 returns the master with its rating counts', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [PRODUCT, NO_VOLTAGE_PRODUCT] });

    const res = await request(app)
      .get('/api/admin/product-lines?show_all=1')
      .set('Authorization', `Bearer ${adminTok()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].rating_count).toBe(2);
  });

  it('a product with no voltage keeps its bare name', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [NO_VOLTAGE_PRODUCT] });

    const res = await request(app)
      .get('/api/admin/product-lines')
      .set('Authorization', `Bearer ${adminTok()}`);

    expect(res.body[0].voltage).toBeNull();
    expect(res.body[0].display_name).toBe('ACB');
  });

  // Regression: the endpoint this replaced answered 200 [] on failure, which is
  // why a totally broken read looked like an empty table for months.
  it('500s on a DB error rather than masking it as an empty list', async () => {
    auth();
    pool.query.mockRejectedValueOnce(new Error('column does not exist'));

    const res = await request(app)
      .get('/api/admin/product-lines')
      .set('Authorization', `Bearer ${adminTok()}`);

    expect(res.status).toBe(500);
    expect(res.body).not.toEqual([]);
    expect(res.body.error).toMatch(/could not load/i);
  });
});

// ── POST ──────────────────────────────────────────────────────────────────────

describe('POST /api/admin/product-lines', () => {
  it('201 creates a product', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [PRODUCT] });

    const res = await request(app)
      .post('/api/admin/product-lines')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ line_name: 'ASTRA', voltage: '415V', voltage_class: 'LV', description: 'ASTRA series' });

    expect(res.status).toBe(201);
    expect(res.body.display_name).toBe('ASTRA - 415V');
  });

  it('201 creates a product with no voltage, storing NULL not empty string', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [NO_VOLTAGE_PRODUCT] });

    const res = await request(app)
      .post('/api/admin/product-lines')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ line_name: 'ACB', voltage: '   ', voltage_class: 'LV' });

    expect(res.status).toBe(201);
    // '' would slip past the NULLS NOT DISTINCT unique index and allow a second ACB.
    const params = pool.query.mock.calls.at(-1)[1];
    expect(params[1]).toBeNull();
  });

  it('400 when line_name is missing', async () => {
    auth();
    const res = await request(app)
      .post('/api/admin/product-lines')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ voltage_class: 'LV' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/line_name/i);
  });

  it('400 when voltage_class is not LV/MV/HV', async () => {
    auth();
    const res = await request(app)
      .post('/api/admin/product-lines')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ line_name: 'ACB', voltage_class: 'EHV' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voltage_class/i);
  });

  it('409 on a duplicate line + voltage', async () => {
    auth();
    pool.query.mockRejectedValueOnce(dupErr());

    const res = await request(app)
      .post('/api/admin/product-lines')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ line_name: 'ASTRA', voltage: '415V', voltage_class: 'LV' });

    expect(res.status).toBe(409);
  });

  // A NULL company_id row is invisible to every scoped user; better to refuse.
  it('400 when the caller has no company and the answer would be a guess', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...ACTIVE_USER, company_id: null }] }); // auth
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });                 // companies

    const res = await request(app)
      .post('/api/admin/product-lines')
      .set('Authorization', `Bearer ${makeToken({ userId: 1, role: 'super_admin' })}`)
      .send({ line_name: 'ACB', voltage_class: 'LV' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/company_id/i);
  });
});

// ── PUT / DELETE ──────────────────────────────────────────────────────────────

describe('PUT + DELETE /api/admin/product-lines/:id', () => {
  it('200 updates a product', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [{ ...PRODUCT, description: 'edited' }] });

    const res = await request(app)
      .put('/api/admin/product-lines/1')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ line_name: 'ASTRA', voltage: '415V', voltage_class: 'LV', description: 'edited' });

    expect(res.status).toBe(200);
    expect(res.body.description).toBe('edited');
  });

  it('404 when the product does not exist', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/api/admin/product-lines/9999')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ line_name: 'X', voltage_class: 'LV' });

    expect(res.status).toBe(404);
  });

  it('200 soft-deletes, leaving projects.product_line_id intact', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete('/api/admin/product-lines/1')
      .set('Authorization', `Bearer ${adminTok()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(pool.query.mock.calls.at(-1)[0]).toMatch(/deleted_at=NOW\(\)/i);
  });

  it('404 when deleting something already gone', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete('/api/admin/product-lines/9999')
      .set('Authorization', `Bearer ${adminTok()}`);

    expect(res.status).toBe(404);
  });
});

// ── Ratings ───────────────────────────────────────────────────────────────────

describe('Product ratings', () => {
  it('200 returns an empty list for a product with no ratings', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/admin/product-lines/3/ratings')
      .set('Authorization', `Bearer ${adminTok()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('201 adds a rating to a product', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, company_id: 1 }] }); // parent lookup
    pool.query.mockResolvedValueOnce({ rows: [RATING] });

    const res = await request(app)
      .post('/api/admin/product-lines/1/ratings')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ rating: '100kVAR', description: '100kVAR variant' });

    expect(res.status).toBe(201);
    expect(res.body.rating).toBe('100kVAR');
  });

  it('the rating inherits its company from the parent product', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, company_id: 7 }] });
    pool.query.mockResolvedValueOnce({ rows: [{ ...RATING, company_id: 7 }] });

    await request(app)
      .post('/api/admin/product-lines/1/ratings')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ rating: '100kVAR' });

    const params = pool.query.mock.calls.at(-1)[1];
    expect(params[3]).toBe(7);
  });

  it('404 when the parent product does not exist', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/admin/product-lines/9999/ratings')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ rating: '100kVAR' });

    expect(res.status).toBe(404);
  });

  it('400 when rating is missing', async () => {
    auth();
    const res = await request(app)
      .post('/api/admin/product-lines/1/ratings')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ description: 'no rating value' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rating/i);
  });

  it('409 on a duplicate rating for the same product', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, company_id: 1 }] });
    pool.query.mockRejectedValueOnce(dupErr());

    const res = await request(app)
      .post('/api/admin/product-lines/1/ratings')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ rating: '100kVAR' });

    expect(res.status).toBe(409);
  });

  it('200 updates a rating', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [{ ...RATING, rating: '200kVAR' }] });

    const res = await request(app)
      .put('/api/admin/product-ratings/1')
      .set('Authorization', `Bearer ${adminTok()}`)
      .send({ rating: '200kVAR' });

    expect(res.status).toBe(200);
    expect(res.body.rating).toBe('200kVAR');
  });

  it('200 deletes a rating', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete('/api/admin/product-ratings/1')
      .set('Authorization', `Bearer ${adminTok()}`);

    expect(res.status).toBe(200);
  });

  it('404 when the rating does not exist', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete('/api/admin/product-ratings/9999')
      .set('Authorization', `Bearer ${adminTok()}`);

    expect(res.status).toBe(404);
  });
});
