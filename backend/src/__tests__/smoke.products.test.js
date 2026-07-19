/**
 * Smoke tests — Product Master (admin/products)
 *
 * Covers:
 *   1. Auth gates — 401 without token on all write endpoints
 *   2. GET /products?show_all=1 — list with new extended fields
 *   3. POST /products — create success (201)
 *   4. POST /products — 400 on missing product_name
 *   5. POST /products — 400 on missing product_family
 *   6. POST /products — 400 on invalid gst_rate
 *   7. PUT /products/:id — update success (200)
 *   8. PUT /products/:id — 404 when product not found
 *   9. DELETE /products/:id — soft-deactivate (200)
 *  10. DELETE /products/:id — 404 when not found
 *
 * All DB calls are mocked. No live DB required.
 * Runner: npx vitest run src/__tests__/smoke.products.test.js
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
import { adminToken } from './helpers/tokens.js';

const app = buildApp(['/api/admin', verifyToken, adminRoutes]);

const ACTIVE_USER = { is_active: true, logout_at: null, company_id: null, branch_id: null };

// verifyToken makes one pool.query (active-check); allowRoles does not query DB
const auth = () => pool.query.mockResolvedValueOnce({ rows: [ACTIVE_USER] });

const PRODUCT = {
  id: 1,
  product_name:     'APFC-100kVAR',
  product_family:   'APFC',
  model_sku:        'SKU-APF-100-LV',
  description:      '100kVAR APFC panel',
  rating:           '100kVAR',
  voltage_class:    '415V',
  phase:            'Three Phase',
  frequency:        '50 Hz',
  topology:         'VSI',
  cooling:          'Air-cooled (Forced)',
  ip_rating:        'IP42',
  bom_template:     'BOM-APFC-STD',
  routing_template: 'RT-APFC-STD',
  test_plan_template: 'TP-APFC-STD',
  warranty_months:  24,
  hsn_sac:          '85044030',
  gst_rate:         '18.00',
  is_active:        true,
  created_at:       new Date().toISOString(),
  updated_at:       new Date().toISOString(),
};

const VALID_BODY = {
  product_name:     'APFC-100kVAR',
  product_family:   'APFC',
  model_sku:        'SKU-APF-100-LV',
  rating:           '100kVAR',
  voltage_class:    '415V',
  phase:            'Three Phase',
  frequency:        '50 Hz',
  topology:         'VSI',
  cooling:          'Air-cooled (Forced)',
  ip_rating:        'IP42',
  warranty_months:  24,
  hsn_sac:          '85044030',
  gst_rate:         18,
};

beforeEach(() => {
  vi.resetAllMocks();
  // logAudit calls auditRepository.create({}).catch(...); restore the Promise after reset.
  auditRepository.create.mockResolvedValue({});
});

// ── Auth gates ─────────────────────────────────────────────────────────────────

describe('Auth gates — product endpoints require JWT', () => {
  it('GET /products returns 401 without token', async () => {
    const res = await request(app).get('/api/admin/products');
    expect(res.status).toBe(401);
  });

  it('POST /products returns 401 without token', async () => {
    const res = await request(app).post('/api/admin/products').send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('PUT /products/1 returns 401 without token', async () => {
    const res = await request(app).put('/api/admin/products/1').send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('DELETE /products/1 returns 401 without token', async () => {
    const res = await request(app).delete('/api/admin/products/1');
    expect(res.status).toBe(401);
  });
});

// ── GET /products ──────────────────────────────────────────────────────────────

describe('GET /api/admin/products', () => {
  it('200 returns product list with extended fields', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [PRODUCT] });

    const res = await request(app)
      .get('/api/admin/products?show_all=1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].product_family).toBe('APFC');
    expect(res.body[0].rating).toBe('100kVAR');
    expect(res.body[0].hsn_sac).toBe('85044030');
  });

  it('200 returns empty array on DB error', async () => {
    auth();
    pool.query.mockRejectedValueOnce(new Error('DB down'));

    const res = await request(app)
      .get('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── POST /products ─────────────────────────────────────────────────────────────

describe('POST /api/admin/products', () => {
  it('201 creates product with all extended fields', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [PRODUCT] });

    const res = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.product_family).toBe('APFC');
    expect(res.body.model_sku).toBe('SKU-APF-100-LV');
    expect(res.body.voltage_class).toBe('415V');
    expect(res.body.warranty_months).toBe(24);
  });

  it('400 when product_name is missing', async () => {
    auth();
    const body = { ...VALID_BODY };
    delete body.product_name;

    const res = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/product_name/i);
  });

  it('400 when product_family is missing', async () => {
    auth();
    const body = { ...VALID_BODY };
    delete body.product_family;

    const res = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/product_family/i);
  });

  it('400 when gst_rate is not a standard slab', async () => {
    auth();
    const res = await request(app)
      .post('/api/admin/products')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ...VALID_BODY, gst_rate: 7 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gst_rate/i);
  });
});

// ── PUT /products/:id ──────────────────────────────────────────────────────────

describe('PUT /api/admin/products/:id', () => {
  it('200 updates product with all extended fields', async () => {
    auth();
    const updated = { ...PRODUCT, rating: '200kVAR', is_active: false };
    pool.query.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .put('/api/admin/products/1')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ...VALID_BODY, rating: '200kVAR', is_active: false });

    expect(res.status).toBe(200);
    expect(res.body.rating).toBe('200kVAR');
  });

  it('404 when product does not exist', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .put('/api/admin/products/9999')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});

// ── DELETE /products/:id ───────────────────────────────────────────────────────

describe('DELETE /api/admin/products/:id', () => {
  it('200 soft-deactivates the product', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app)
      .delete('/api/admin/products/1')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('404 when product does not exist', async () => {
    auth();
    pool.query.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app)
      .delete('/api/admin/products/9999')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not found');
  });
});
