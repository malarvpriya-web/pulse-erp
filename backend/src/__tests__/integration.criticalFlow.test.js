// Integration tests for the full order-to-service flow:
// Lead → Opportunity → Quotation → Sales Order → Production Order →
// MRP Run → Dispatch → Deliver → Feedback → Complaint → Service Ticket
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock both db paths — routes use config/db, repositories use modules/shared/db
vi.mock('../config/db.js',         () => ({ default: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../modules/shared/db.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));

// Stub platform engines so they don't consume configPool query slots in these tests.
// engineHooks.test.js and phase2.test.js test these services independently.
vi.mock('../services/ValidationEngineService.js', () => ({
  validate:      vi.fn().mockResolvedValue({ valid: true, errors: [] }),
  validateField: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
}));
vi.mock('../services/RuleEngineService.js', () => ({
  evaluateRules: vi.fn().mockResolvedValue([]),
}));

import request            from 'supertest';
import configPool         from '../config/db.js';
import sharedPool         from '../modules/shared/db.js';
import salesRoutes        from '../modules/sales/routes/sales.routes.js';
import bomRoutes          from '../modules/production/bom.routes.js';
import crmCoreRoutes      from '../modules/crm/routes/crm.routes.js';
import productionRoutes   from '../modules/production/execution.routes.js';
import complaintsRoutes   from '../modules/complaints/complaints.routes.js';
import servicedeskRoutes  from '../modules/servicedesk/routes/servicedesk.routes.js';
import { validate }       from '../services/ValidationEngineService.js';
import { evaluateRules }  from '../services/RuleEngineService.js';
import { buildApp }       from './helpers/testApp.js';
import { verifyToken }    from '../middlewares/auth.middleware.js';
import { adminToken }     from './helpers/tokens.js';

// ── Test apps ─────────────────────────────────────────────────────────────────
const salesApp       = buildApp(['/api/sales', salesRoutes]);
const bomApp         = buildApp(['/api', verifyToken, bomRoutes]);
const crmApp         = buildApp(['/api/crm', verifyToken, crmCoreRoutes]);
const productionApp  = buildApp(['/api/production', verifyToken, productionRoutes]);
const complaintsApp  = buildApp(['/api/complaints', verifyToken, complaintsRoutes]);
const servicedeskApp = buildApp(['/api/servicedesk', verifyToken, servicedeskRoutes]);

// ── ACTIVE_USER ───────────────────────────────────────────────────────────────
// company_id must be non-null so scope-guarded routes pass (otherwise 403).
const FULL_PERMISSION = {
  can_view: true, can_add: true, can_edit: true,
  can_delete: true, can_approve: true, can_export: true,
};

const ACTIVE_USER = { is_active: true, logout_at: null, company_id: 1, branch_id: null };

// ── Fixtures ──────────────────────────────────────────────────────────────────
const LEAD = {
  id: 10, lead_source: 'Website', company_name: 'Manifest Tech',
  contact_person: 'Raj Kumar', email: 'raj@manifest.com', status: 'new',
  created_at: new Date().toISOString(),
};

const OPPORTUNITY = {
  id: 5, opportunity_name: 'Power Inverter Deal', lead_id: 10,
  expected_value: 500000, stage: 'Qualification', probability_percentage: 50,
  created_at: new Date().toISOString(),
};

const QUOTATION = {
  id: 20, quotation_number: 'QT-0001', customer_name: 'Manifest Tech',
  total_amount: 500000, status: 'draft',
  created_at: new Date().toISOString(),
};

const ORDER = {
  id: 42, order_number: 'SO-2026-042', customer_name: 'Manifest Tech',
  total_amount: 500000, order_status: 'confirmed', created_at: new Date().toISOString(),
};

const BOM = {
  id: 1, product_name: 'Power Inverter 10kVA', version: '1.0', status: 'active',
};

const PROD_ORDER = {
  id: 1, production_order_no: 'PO-00001', product_name: 'Power Inverter 10kVA',
  quantity_planned: 5, status: 'planned', company_id: 1,
  created_at: new Date().toISOString(),
};

const COMPLAINT = {
  id: 100, complaint_number: 'CMP-2026-0001',
  title: 'Inverter overheating after delivery',
  customer_name: 'Manifest Tech', status: 'open',
  created_at: new Date().toISOString(),
};

const TICKET = {
  id: 200, ticket_number: 'TKT-0001',
  title: 'Post-delivery service request',
  requester_name: 'Raj Kumar', status: 'Open',
  created_at: new Date().toISOString(),
};

const CSAT = {
  id: 300, ticket_id: 200, ticket_subject: 'Delivery feedback',
  rating: 4, feedback: 'Good delivery experience', company_id: 1,
  responded_at: new Date().toISOString(),
};

// ── Transaction client mock (shared for all pool.connect() calls) ─────────────
let txClient;

// ── Global beforeEach ─────────────────────────────────────────────────────────
// Sets up standard auth overhead: verifyToken (1) + requirePermission (2).
// Describes that override this pattern provide their own nested beforeEach.
beforeEach(() => {
  vi.resetAllMocks();

  txClient = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  configPool.connect.mockResolvedValue(txClient);
  sharedPool.connect.mockResolvedValue(txClient);

  configPool.query
    .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken
    .mockResolvedValueOnce({ rows: [] })             // requirePermission: user-level
    .mockResolvedValueOnce({ rows: [FULL_PERMISSION] });            // requirePermission: role-level
  configPool.query.mockResolvedValue({ rows: [] });
  sharedPool.query.mockResolvedValue({ rows: [] });

  // Re-configure engine stubs after vi.resetAllMocks() clears their implementations.
  validate.mockResolvedValue({ valid: true, errors: [] });
  evaluateRules.mockResolvedValue([]);
});

// ── Step 1: Create CRM Lead ───────────────────────────────────────────────────

describe('Step 1 — Create CRM Lead', () => {
  it('requires authentication', async () => {
    const res = await request(crmApp).post('/api/crm/leads')
      .send({ company_name: 'Manifest Tech' });
    expect(res.status).toBe(401);
  });

  it('creates a new lead', async () => {
    // POST /crm/leads query order (all via sharedPool):
    //   1. duplicate email check (SELECT id FROM leads WHERE company_id=$1 AND email=$2)
    //   2. CRM settings (SELECT auto_assign_owner ... FROM crm_settings WHERE company_id=$1)
    //   3. INSERT INTO leads → LEAD
    sharedPool.query
      .mockResolvedValueOnce({ rows: [] })     // dup email check → no duplicate
      .mockResolvedValueOnce({ rows: [] })     // CRM settings → no settings (auto features off)
      .mockResolvedValueOnce({ rows: [LEAD] }); // INSERT leads → LEAD

    const res = await request(crmApp).post('/api/crm/leads')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        lead_source: 'Website', company_name: 'Manifest Tech',
        contact_person: 'Raj Kumar', email: 'raj@manifest.com',
        status: 'new',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('id', 10);
    expect(res.body.company_name).toBe('Manifest Tech');
  });
});

// ── Step 2: Convert Lead to Opportunity ──────────────────────────────────────

describe('Step 2 — Convert Lead to Opportunity', () => {
  it('requires authentication', async () => {
    const res = await request(crmApp).post('/api/crm/leads/10/convert')
      .send({ opportunity_name: 'Power Inverter Deal', expected_value: 500000 });
    expect(res.status).toBe(401);
  });

  it('converts a lead to an opportunity', async () => {
    // Transaction runs on sharedPool.connect() → txClient
    txClient.query
      .mockResolvedValueOnce({ rows: [] })                              // BEGIN
      .mockResolvedValueOnce({ rows: [LEAD], rowCount: 1 })            // SELECT lead FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                // SELECT dup check
      .mockResolvedValueOnce({ rows: [OPPORTUNITY] })                  // INSERT opportunity
      .mockResolvedValueOnce({ rows: [{ ...LEAD, status: 'converted' }] }) // UPDATE lead
      .mockResolvedValueOnce({ rows: [] })                             // INSERT activity
      .mockResolvedValueOnce({ rows: [] });                            // COMMIT

    const res = await request(crmApp).post('/api/crm/leads/10/convert')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        opportunity_name: 'Power Inverter Deal',
        expected_value: 500000,
        stage: 'Qualification',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('opportunity');
    expect(res.body.opportunity.opportunity_name).toBe('Power Inverter Deal');
    expect(res.body.lead.status).toBe('converted');
  });

  it('rejects duplicate lead conversion', async () => {
    txClient.query
      .mockResolvedValueOnce({ rows: [] })                    // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...LEAD, status: 'converted' }], rowCount: 1 }) // lead already converted
      .mockResolvedValueOnce({ rows: [] });                   // ROLLBACK

    const res = await request(crmApp).post('/api/crm/leads/10/convert')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ opportunity_name: 'Duplicate', expected_value: 100 });

    expect(res.status).toBe(409);
  });
});

// ── Step 3: Create Quotation ──────────────────────────────────────────────────

describe('Step 3 — Create Quotation', () => {
  it('requires authentication', async () => {
    const res = await request(salesApp).post('/api/sales/quotations')
      .send({ customer_name: 'Manifest Tech' });
    expect(res.status).toBe(401);
  });

  it('creates a quotation linked to the opportunity', async () => {
    // POST /sales/quotations query order:
    //   configPool: nextQuotationNumber calls SELECT nextval('seq_qt') via config/db.js
    //   sharedPool: INSERT INTO quotations via quotations.repository.js (modules/shared/db.js)
    configPool.query.mockResolvedValueOnce({ rows: [{ n: 1 }] }); // nextval → QT-0001
    sharedPool.query.mockResolvedValueOnce({ rows: [QUOTATION] }); // INSERT quotations

    const res = await request(salesApp).post('/api/sales/quotations')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        customer_name: 'Manifest Tech',
        total_amount: 500000,
        opportunity_id: 5,
        valid_until: '2026-07-31',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('id', 20);
    expect(res.body.quotation_number).toBe('QT-0001');
  });
});

// ── Step 4: Create Sales Order ────────────────────────────────────────────────

describe('Step 4 — Create Sales Order', () => {
  it('requires authentication', async () => {
    const res = await request(salesApp).post('/api/sales/orders')
      .send({ customer_name: 'Manifest Tech', total_amount: 500000 });
    expect(res.status).toBe(401);
  });

  it('creates a confirmed sales order', async () => {
    // POST /sales/orders query order:
    //   configPool: nextSalesOrderNumber calls SELECT nextval('seq_so') via config/db.js
    //   sharedPool: INSERT INTO sales_orders via salesOrders.repository.js (modules/shared/db.js)
    // Route wraps result in { data: order }.
    configPool.query.mockResolvedValueOnce({ rows: [{ n: 1 }] }); // nextval → SO-0001
    sharedPool.query.mockResolvedValueOnce({ rows: [ORDER] });     // INSERT sales_orders

    const res = await request(salesApp).post('/api/sales/orders')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        customer_name: 'Manifest Tech', total_amount: 500000,
        delivery_date: '2026-06-30', payment_terms: 'Net 30',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body.data).toHaveProperty('id', 42);
    expect(res.body.data.order_number).toBe('SO-2026-042');
    expect(res.body.data.customer_name).toBe('Manifest Tech');
  });

  it('validates required customer_name field', async () => {
    sharedPool.query.mockRejectedValueOnce(new Error('NOT NULL violation'));

    const res = await request(salesApp).post('/api/sales/orders')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ total_amount: 500000 }); // missing customer_name

    expect([400, 422, 500]).toContain(res.status);
  });
});

// ── Step 5: Move Order to Picking ─────────────────────────────────────────────

describe('Step 5 — Move Order to Picking', () => {
  it('requires authentication', async () => {
    const res = await request(salesApp).put('/api/sales/orders/42/status')
      .send({ status: 'picking' });
    expect(res.status).toBe(401);
  });

  it('transitions order status to picking', async () => {
    const picking = { ...ORDER, order_status: 'picking' };
    sharedPool.query.mockResolvedValueOnce({ rows: [picking] });

    const res = await request(salesApp).put('/api/sales/orders/42/status')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'picking' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('picking');
  });

  it('advances order from picking to packed', async () => {
    const packed = { ...ORDER, order_status: 'packed' };
    sharedPool.query.mockResolvedValueOnce({ rows: [packed] });

    const res = await request(salesApp).put('/api/sales/orders/42/status')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ status: 'packed' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('packed');
  });
});

// ── Step 6: Create Production Order ──────────────────────────────────────────

describe('Step 6 — Create Production Order', () => {
  it('requires authentication', async () => {
    const res = await request(productionApp).post('/api/production/orders')
      .send({ product_name: 'Power Inverter 10kVA', quantity_planned: 5 });
    expect(res.status).toBe(401);
  });

  it('creates a production order linked to the sales order', async () => {
    // Transaction on configPool.connect() → txClient
    txClient.query
      .mockResolvedValueOnce({ rows: [] })           // BEGIN
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })  // nextProdOrderNumber (SELECT nextval)
      .mockResolvedValueOnce({ rows: [PROD_ORDER] }) // INSERT production_orders
      .mockResolvedValueOnce({ rows: [] });          // COMMIT

    const res = await request(productionApp).post('/api/production/orders')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        product_name: 'Power Inverter 10kVA',
        quantity_planned: 5,
        sales_order_id: 42,
        priority: 'high',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('production_order_no');
    expect(res.body.status).toBe('planned');
  });

  it('requires product_name and quantity_planned', async () => {
    const res = await request(productionApp).post('/api/production/orders')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ sales_order_id: 42 }); // missing required fields

    expect(res.status).toBe(400);
  });
});

// ── Step 7: Run MRP to Plan Production ───────────────────────────────────────

describe('Step 7 — MRP Run (Production Planning)', () => {
  it('returns 404 when no active BOM exists (no product_id given)', async () => {
    configPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(bomApp).post('/api/mrp/run')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});

    expect(res.status).toBe(404);
  });

  it('runs MRP for a product and returns plan with requirements', async () => {
    configPool.query
      .mockResolvedValueOnce({ rows: [BOM] })  // SELECT bom_headers WHERE product_id=1
      .mockResolvedValueOnce({ rows: [] });    // SELECT bom_lines (empty → no components)

    const res = await request(bomApp).post('/api/mrp/run')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ product_id: 1, quantity: 5 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bom');
    expect(res.body).toHaveProperty('requirements');
    expect(res.body).toHaveProperty('total_cost_estimate');
    expect(res.body.bom.product_name).toBe('Power Inverter 10kVA');
    expect(Array.isArray(res.body.requirements)).toBe(true);
  });

  it('returns 404 when no active BOM exists for product', async () => {
    configPool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(bomApp).post('/api/mrp/run')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ product_id: 999, quantity: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/BOM/i);
  });
});

// ── Step 8: Dispatch the Order ────────────────────────────────────────────────

describe('Step 8 — Dispatch Sales Order', () => {
  it('requires authentication', async () => {
    const res = await request(salesApp).put('/api/sales/orders/42/dispatch')
      .send({ carrier: 'DTDC', tracking_number: 'DTDC123456' });
    expect(res.status).toBe(401);
  });

  it('dispatches order with carrier and tracking number', async () => {
    const dispatched = {
      ...ORDER, order_status: 'dispatched',
      carrier: 'DTDC', tracking_number: 'DTDC123456',
    };
    // sales.routes.js uses pool from config/db.js (not shared/db.js)
    configPool.query.mockResolvedValueOnce({ rows: [dispatched] }); // UPDATE → dispatched order

    const res = await request(salesApp).put('/api/sales/orders/42/dispatch')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ carrier: 'DTDC', tracking_number: 'DTDC123456' });

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('dispatched');
    expect(res.body.carrier).toBe('DTDC');
    expect(res.body.tracking_number).toBe('DTDC123456');
  });
});

// ── Step 9: Mark Order as Delivered ──────────────────────────────────────────

describe('Step 9 — Mark Order as Delivered', () => {
  it('requires authentication', async () => {
    const res = await request(salesApp).put('/api/sales/orders/42/deliver');
    expect(res.status).toBe(401);
  });

  it('marks dispatched order as delivered', async () => {
    const delivered = {
      ...ORDER, order_status: 'delivered',
      delivery_date: new Date().toISOString().split('T')[0],
    };
    // sales.routes.js uses pool from config/db.js (not shared/db.js)
    configPool.query.mockResolvedValueOnce({ rows: [delivered] }); // UPDATE → delivered order

    const res = await request(salesApp).put('/api/sales/orders/42/deliver')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.order_status).toBe('delivered');
    expect(res.body.delivery_date).toBeDefined();
  });

  it('full flow — order progresses through all statuses', () => {
    const flowStatuses = ['confirmed', 'picking', 'packed', 'dispatched', 'delivered'];
    for (let i = 1; i < flowStatuses.length; i++) {
      expect(['picking', 'packed', 'dispatched', 'delivered'].includes(flowStatuses[i])).toBe(true);
    }
    expect(flowStatuses[0]).toBe('confirmed');
    expect(flowStatuses[flowStatuses.length - 1]).toBe('delivered');
  });
});

// ── Step 10: Submit Post-Delivery Feedback (CSAT) ─────────────────────────────

describe('Step 10 — Post-Delivery Feedback', () => {
  it('requires authentication', async () => {
    const res = await request(servicedeskApp).post('/api/servicedesk/feedback')
      .send({ rating: 4, ticket_subject: 'Delivery' });
    expect(res.status).toBe(401);
  });

  it('submits CSAT feedback after delivery', async () => {
    configPool.query.mockResolvedValueOnce({ rows: [CSAT] }); // INSERT csat_responses

    const res = await request(servicedeskApp).post('/api/servicedesk/feedback')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        ticket_id: 200,
        ticket_subject: 'Delivery feedback',
        rating: 4,
        feedback: 'Good delivery experience',
        agent_name: 'Sales Team',
        sales_order_id: 42,
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('id');
    expect(res.body.rating).toBe(4);
  });

  it('rejects invalid rating (out of 1-5 range)', async () => {
    const res = await request(servicedeskApp).post('/api/servicedesk/feedback')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ rating: 6, ticket_subject: 'Bad rating' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rating/i);
  });
});

// ── Step 11: Create Customer Complaint ────────────────────────────────────────

describe('Step 11 — Customer Complaint', () => {
  // Complaints routes ARE gated on the `servicedesk` permission module as of
  // 2026-07-17 (complaints.routes.js) — they previously had no requirePermission
  // at all, which is what the old "verifyToken only" override here assumed.
  // The auth overhead is now 3 configPool.query calls, not 1, matching the global
  // beforeEach; without the two extra Once values, requirePermission's user-level
  // lookup swallows the next queued mock and reads it as a permission row.
  beforeEach(() => {
    vi.resetAllMocks();
    txClient = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    configPool.connect.mockResolvedValue(txClient);
    sharedPool.connect.mockResolvedValue(txClient);
    configPool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] })  // verifyToken
      .mockResolvedValueOnce({ rows: [] })             // requirePermission: user-level
      .mockResolvedValueOnce({ rows: [FULL_PERMISSION] });            // requirePermission: role-level
    configPool.query.mockResolvedValue({ rows: [] });
    sharedPool.query.mockResolvedValue({ rows: [] });
    validate.mockResolvedValue({ valid: true, errors: [] });
    evaluateRules.mockResolvedValue([]);
  });

  it('requires authentication', async () => {
    const res = await request(complaintsApp).post('/api/complaints')
      .send({ title: 'Test', customer_name: 'X' });
    expect(res.status).toBe(401);
  });

  it('creates a complaint after delivery', async () => {
    configPool.query
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })     // nextComplaintNumber (SELECT nextval)
      .mockResolvedValueOnce({ rows: [COMPLAINT] });    // INSERT complaint

    const res = await request(complaintsApp).post('/api/complaints')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        title: 'Inverter overheating after delivery',
        customer_name: 'Manifest Tech',
        category: 'Product Quality',
        priority: 'High',
        description: 'Inverter heats up within 10 minutes of use',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('complaint_number');
    expect(res.body.status).toBe('open');
  });

  it('validates required fields (title and customer_name)', async () => {
    const res = await request(complaintsApp).post('/api/complaints')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ description: 'Missing required fields' });

    expect(res.status).toBe(400);
  });
});

// ── Step 12: Create Service Ticket ────────────────────────────────────────────

describe('Step 12 — Service Ticket', () => {
  it('requires authentication', async () => {
    const res = await request(servicedeskApp).post('/api/servicedesk/tickets')
      .send({ title: 'Service needed', requester_name: 'Raj Kumar' });
    expect(res.status).toBe(401);
  });

  it('creates a service ticket linked to the delivered order', async () => {
    // Overrides the global beforeEach per this file's convention: POST /tickets is
    // self-service (svcSelfService), NOT requirePermission, so it consumes the
    // verifyToken query only. The global chain reserves two further slots for
    // requirePermission, which would otherwise swallow the nextval and INSERT
    // mocks below — nextval would read {rows: []} and throw on rows[0].n.
    configPool.query.mockReset();
    configPool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_USER] }) // verifyToken
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })    // nextTicketNumber (SELECT nextval)
      .mockResolvedValueOnce({ rows: [TICKET] });     // INSERT support_tickets
    configPool.query.mockResolvedValue({ rows: [] });

    const res = await request(servicedeskApp).post('/api/servicedesk/tickets')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        title: 'Post-delivery service request',
        description: 'Customer requires on-site support',
        category: 'Technical',
        priority: 'Medium',
        requester_name: 'Raj Kumar',
        requester_email: 'raj@manifest.com',
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body).toHaveProperty('ticket_number');
    expect(res.body.status).toBe('Open');
  });
});
