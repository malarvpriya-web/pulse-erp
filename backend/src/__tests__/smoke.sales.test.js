import { vi, describe, it, expect, beforeEach } from 'vitest';

// Bypass auth/permissions so pool.query is only called by business logic.
// The verifyToken stub still enforces 401 when no token is present.
vi.mock('../middlewares/auth.middleware.js', () => ({
  verifyToken: (req, res, next) => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided' });
    }
    req.user = { userId: 1, id: 1, role: 'admin', company_id: null };
    next();
  },
  requirePermission: () => (_req, _res, next) => next(),
}));

vi.mock('../services/AuditService.js', () => ({ logAudit: vi.fn() }));
vi.mock('../services/WorkflowNotificationService.js', () => ({ notifyWorkflowEvent: vi.fn() }));
vi.mock('../services/googleDrive.service.js', () => ({
  isDriveConfigured: vi.fn(() => false),
  uploadJsonRecord: vi.fn(),
  DOC_TYPES: { QUOTATION: 'quotation' },
}));
vi.mock('../config/db.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

import request    from 'supertest';
import pool       from '../config/db.js';
import salesRoutes from '../modules/sales/routes/sales.routes.js';
import { buildApp } from './helpers/testApp.js';
import { adminToken } from './helpers/tokens.js';

const app = buildApp(['/api/sales', salesRoutes]);

const mockQuotation = {
  id: 1, quotation_number: 'QUO-2026-001', customer_name: 'Acme Corp',
  total_amount: 150000, status: 'draft', created_at: new Date().toISOString(),
};

const mockOrder = {
  id: 1, order_number: 'SO-2026-001', customer_name: 'Acme Corp',
  quotation_id: null, total_amount: 150000, status: 'confirmed',
  order_status: 'confirmed', created_at: new Date().toISOString(),
};

beforeEach(() => vi.resetAllMocks());

// ── Quotations ────────────────────────────────────────────────────────────────

describe('GET /api/sales/quotations', () => {
  it('401 without token', async () => {
    const res = await request(app).get('/api/sales/quotations');
    expect(res.status).toBe(401);
  });

  it('200 returns quotation list', async () => {
    pool.query.mockResolvedValue({ rows: [] }); // findAll → []
    const res = await request(app).get('/api/sales/quotations')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/sales/quotations — create quotation', () => {
  it('401 without token', async () => {
    const res = await request(app).post('/api/sales/quotations')
      .send({ quotation_number: 'QUO-TEST-001', customer_name: 'Acme Corp' });
    expect(res.status).toBe(401);
  });

  it('201 creates a new quotation', async () => {
    // Include quotation_number to bypass the nextval() DB call.
    pool.query
      .mockResolvedValueOnce({ rows: [mockQuotation] }) // INSERT quotation
      .mockResolvedValue({ rows: [] });                 // logAudit etc.

    const res = await request(app).post('/api/sales/quotations')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        quotation_number: 'QUO-TEST-001',
        customer_name: 'Acme Corp', contact_person: 'Raj',
        total_amount: 150000, valid_until: '2026-06-30',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('id');
    expect(res.body.customer_name).toBe('Acme Corp');
  });
});

// ── Sales Orders ──────────────────────────────────────────────────────────────

describe('GET /api/sales/orders', () => {
  it('401 without token', async () => {
    const res = await request(app).get('/api/sales/orders');
    expect(res.status).toBe(401);
  });

  it('200 returns sales order list', async () => {
    pool.query.mockResolvedValue({ rows: [] }); // findAll → []
    const res = await request(app).get('/api/sales/orders')
      .set('Authorization', `Bearer ${adminToken()}`);

    // Route wraps array in { data: [...] }
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('POST /api/sales/orders — create sales order', () => {
  it('401 without token', async () => {
    const res = await request(app).post('/api/sales/orders')
      .send({ order_number: 'SO-TEST-001', customer_name: 'Acme Corp' });
    expect(res.status).toBe(401);
  });

  it('creates sales order', async () => {
    // Include order_number to bypass nextval(). No quotation_id to skip update.
    pool.query
      .mockResolvedValueOnce({ rows: [mockOrder] }) // INSERT orders
      .mockResolvedValue({ rows: [] });             // fallback

    const res = await request(app).post('/api/sales/orders')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        order_number: 'SO-TEST-001',
        customer_name: 'Acme Corp',
        total_amount: 150000, delivery_date: '2026-07-01',
      });

    // Route returns { data: order }
    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.customer_name).toBe('Acme Corp');
  });
});
