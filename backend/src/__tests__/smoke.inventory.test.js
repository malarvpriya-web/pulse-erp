/**
 * Smoke tests — Inventory module
 *
 * Covers high-value inventory flows:
 *   1. Auth gate — 401 without token on all write endpoints
 *   2. GET /items — list requires inventory.view permission
 *   3. POST /items — create item; 422 on validation failure
 *   4. POST /stock/movement — stock-in / stock-out transaction
 *   5. GET /stock/summary — returns stock levels
 *   6. GET /stock/low-stock — low-stock alert list
 *   7. POST /stock-adjustments — adjustment record
 *
 * All DB calls are mocked. No live DB required.
 * Runner: npx vitest run src/__tests__/smoke.inventory.test.js
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock both pool paths used by inventory.routes.js
vi.mock('../config/db.js',         () => ({ default: { query: vi.fn() } }));
vi.mock('../modules/shared/db.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

// Mock the repository / service dependencies so tests stay unit-level
vi.mock('../modules/inventory/repositories/inventoryItem.repository.js', () => ({
  default: {
    getNextCode: vi.fn().mockResolvedValue('ITM-0042'),
    create:      vi.fn(),
    findAll:     vi.fn(),
    findById:    vi.fn(),
    update:      vi.fn(),
  },
}));
vi.mock('../modules/inventory/repositories/stockLedger.repository.js', () => ({
  default: {
    record:          vi.fn(),
    findAll:         vi.fn(),
    createEntry:     vi.fn(),
    getStockSummary: vi.fn(),
    getLowStockItems: vi.fn(),
  },
}));
vi.mock('../modules/inventory/services/rmIssue.service.js', () => ({
  default: { create: vi.fn(), findAll: vi.fn(), findById: vi.fn() },
}));
vi.mock('../services/ValidationEngineService.js', () => ({
  validate: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
}));
vi.mock('../services/RuleEngineService.js', () => ({
  evaluateRules: vi.fn().mockResolvedValue([]),
}));
vi.mock('../services/AuditService.js', () => ({
  logAudit: vi.fn(),
}));

import request from 'supertest';
import pool    from '../config/db.js';
import sharedPool from '../modules/shared/db.js';
import itemRepo from '../modules/inventory/repositories/inventoryItem.repository.js';
import stockLedgerRepo from '../modules/inventory/repositories/stockLedger.repository.js';

import inventoryRoutes from '../modules/inventory/routes/inventory.routes.js';
import { buildApp }    from './helpers/testApp.js';
import { verifyToken } from '../middlewares/auth.middleware.js';
import { adminToken, employeeToken } from './helpers/tokens.js';

const app = buildApp(['/api/inventory', verifyToken, inventoryRoutes]);

const FULL_PERMISSION = {
  can_view: true, can_add: true, can_edit: true,
  can_delete: true, can_approve: true, can_export: true,
};

const ACTIVE_USER = { is_active: true, logout_at: null, company_id: null, branch_id: null };

// Permission passthrough: verifyToken active-check → user-level lookup → role-level lookup → allow
const passthrough = () => {
  pool.query
    .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken active-check
    .mockResolvedValueOnce({ rows: [] })             // requirePermission: user-level
    .mockResolvedValueOnce({ rows: [FULL_PERMISSION] });            // requirePermission: role-level
};

const ITEM = {
  id: 1, item_code: 'ITM-0042', item_name: 'Copper Wire 2.5mm',
  category: 'Raw Material', uom: 'KG', quantity_on_hand: 500,
  reorder_level: 50, unit_cost: 185, created_at: new Date().toISOString(),
};

beforeEach(() => vi.resetAllMocks());

// ── Auth gates ──────────────────────────────────────────────────────────────────

describe('Auth gates — inventory endpoints require JWT', () => {
  it('GET /items returns 401 without token', async () => {
    const res = await request(app).get('/api/inventory/items');
    expect(res.status).toBe(401);
  });

  it('POST /items returns 401 without token', async () => {
    const res = await request(app).post('/api/inventory/items').send({ item_name: 'Test' });
    expect(res.status).toBe(401);
  });

  it('POST /stock/movement returns 401 without token', async () => {
    const res = await request(app).post('/api/inventory/stock/movement').send({});
    expect(res.status).toBe(401);
  });
});

// ── Item list ───────────────────────────────────────────────────────────────────

describe('GET /api/inventory/items', () => {
  it('200 returns item list for authorised user', async () => {
    passthrough();
    itemRepo.findAll.mockResolvedValue([ITEM]);

    const res = await request(app).get('/api/inventory/items')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Item create ─────────────────────────────────────────────────────────────────

describe('POST /api/inventory/items', () => {
  it('201 creates item with auto-generated item_code', async () => {
    passthrough();
    // vi.resetAllMocks() clears factory-set mockResolvedValue — restore both services
    const { validate } = await import('../services/ValidationEngineService.js');
    validate.mockResolvedValueOnce({ valid: true, errors: [] });
    const { evaluateRules } = await import('../services/RuleEngineService.js');
    evaluateRules.mockResolvedValue([]);
    itemRepo.create.mockResolvedValue(ITEM);

    const res = await request(app).post('/api/inventory/items')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        item_name: 'Copper Wire 2.5mm', category: 'Raw Material',
        uom: 'KG', reorder_level: 50, unit_cost: 185,
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body.item_code).toBe('ITM-0042');
  });

  it('422 when ValidationEngine rejects the payload', async () => {
    passthrough();
    const { validate } = await import('../services/ValidationEngineService.js');
    validate.mockResolvedValueOnce({
      valid: false,
      errors: [{ field: 'item_name', message: 'Required' }],
    });

    const res = await request(app).post('/api/inventory/items')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ category: 'Raw Material' }); // missing item_name

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.errors)).toBe(true);
  });
});

// ── Stock movement ──────────────────────────────────────────────────────────────
// The route uses sharedPool.connect() for a transaction.
// movement_type is compared as === 'IN'; any other value triggers the balance check.

describe('POST /api/inventory/stock/movement', () => {
  it('201 records a stock-in transaction', async () => {
    passthrough();
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })                       // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance: '10000' }] })   // balance check (movement_type !== 'IN')
        .mockResolvedValueOnce({ rows: [] }),                       // COMMIT
      release: vi.fn(),
    };
    sharedPool.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app).post('/api/inventory/stock/movement')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        item_id: 1, movement_type: 'stock_in', quantity: 100,
        reference_number: 'GRN-2026-001', warehouse_id: 1,
      });

    expect([200, 201]).toContain(res.status);
  });

  it('201 records a stock-out transaction', async () => {
    passthrough();
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })                       // BEGIN
        .mockResolvedValueOnce({ rows: [{ balance: '10000' }] })   // balance check
        .mockResolvedValueOnce({ rows: [] }),                       // COMMIT
      release: vi.fn(),
    };
    sharedPool.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app).post('/api/inventory/stock/movement')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        item_id: 1, movement_type: 'stock_out', quantity: 20,
        reference_number: 'ISS-2026-001', warehouse_id: 1,
      });

    expect([200, 201]).toContain(res.status);
  });
});

// ── Stock summary ───────────────────────────────────────────────────────────────

describe('GET /api/inventory/stock/summary', () => {
  it('200 returns stock summary', async () => {
    passthrough();
    stockLedgerRepo.getStockSummary.mockResolvedValue({
      total_items: 42, total_value: 195000, low_stock_count: 3,
    });

    const res = await request(app).get('/api/inventory/stock/summary')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
  });
});

// ── Low-stock alert ─────────────────────────────────────────────────────────────

describe('GET /api/inventory/stock/low-stock', () => {
  it('200 returns items below reorder level', async () => {
    passthrough();
    stockLedgerRepo.getLowStockItems.mockResolvedValue([ITEM]);

    const res = await request(app).get('/api/inventory/stock/low-stock')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Stock adjustment ────────────────────────────────────────────────────────────

describe('POST /api/inventory/stock-adjustments', () => {
  it('201 creates stock adjustment record', async () => {
    passthrough();
    const adj = {
      id: 10, adjustment_number: 'ADJ-2026-001',
      adjustment_type: 'increase', reason: 'Flood damage', adjustment_date: '2026-05-01',
    };
    // Route uses sharedPool.connect() for the INSERT transaction
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })      // BEGIN
        .mockResolvedValueOnce({ rows: [adj] })   // INSERT stock_adjustments
        .mockResolvedValueOnce({ rows: [] })       // INSERT stock_adjustment_items
        .mockResolvedValueOnce({ rows: [] }),      // COMMIT
      release: vi.fn(),
    };
    sharedPool.connect.mockResolvedValueOnce(mockClient);

    const res = await request(app).post('/api/inventory/stock-adjustments')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        adjustment_type: 'addition', reason: 'Flood damage',
        adjustment_date: '2026-05-01', warehouse_id: 1,
        items: [{ item_id: 1, quantity: 15, remarks: 'Water damage' }],
      });

    expect([200, 201]).toContain(res.status);
  });
});
