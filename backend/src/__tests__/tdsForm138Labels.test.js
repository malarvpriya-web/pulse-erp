/**
 * Form 138 / Form 24Q statutory labels by tax year (manual §200).
 *
 * From tax year 2026-27 (Income-tax Act 2025 / Income-tax Rules 2026):
 *   salary TDS is DEDUCTED under s.392 (was s.192), and the QUARTERLY
 *   STATEMENT is Form No. 138 under s.397(3)(b) / Rule 219 (was Form 24Q).
 * Protean RPU/FVU v1.1 "Key Features" (effective FY 2026-27): Form 24Q →
 * Form No. 138, "Financial Year" → "Tax Year", "See Sections 192" removed.
 * 2025-26 keeps the 1961 Act's labels.
 *
 * Only the labels are under test. The pool is mocked — no real database —
 * and the internal ledger key tds_transactions.section stays '192'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../config/db.js', () => ({ default: { query: db.query, connect: vi.fn() } }));
vi.mock('../middlewares/auth.middleware.js', () => ({ requirePermission: () => (_q, _s, n) => n() }));
vi.mock('../middlewares/captureBefore.js', () => ({ captureBefore: () => (_q, _s, n) => n() }));

const { default: tdsRouter, salaryTdsLabels } = await import('../modules/finance/tds.routes.js');

const app = express();
app.use((req, _res, next) => { req.user = { id: 1, company_id: 1, role: 'admin' }; next(); });
app.use('/api/tds', tdsRouter);

// One approved, valid, fully deposited salary month for the requested quarter.
function stub({ year, month }) {
  db.query.mockImplementation((sql) => {
    if (/FROM payroll_runs pr JOIN employees e[\s\S]*ORDER BY/.test(sql)) {
      return Promise.resolve({ rows: [{ id: 1, employee_id: 7, month, year, status: 'approved', tds: 1000, gross: 50000,
        period_label: 'x', is_test: false, first_name: 'Asha', last_name: 'K', pan_number: 'ABCDE1234F', office_id: 'EMP007' }] });
    }
    if (/FROM companies/.test(sql)) return Promise.resolve({ rows: [{ name: 'Manifest', tan: 'CHEM12345A', pan: null }] });
    if (/GROUP BY pr.is_test/.test(sql)) return Promise.resolve({ rows: [] });
    if (/FROM tds_transactions/.test(sql)) {
      // The deposit lookup still keys on the stored ledger value '192'.
      expect(sql).toMatch(/section = '192'/);
      return Promise.resolve({ rows: [{ employee_id: 7, month, year, deposited: 1000 }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => db.query.mockReset());

describe('salaryTdsLabels', () => {
  it('tax year 2026-27: s.392 deduction, Form 138 under s.397(3)(b), "Tax Year"', () => {
    expect(salaryTdsLabels(2026)).toMatchObject({ form_type: '138', section: '392', period_term: 'Tax Year' });
    expect(salaryTdsLabels(2026).statute).toMatch(/s\.397\(3\)\(b\).*Rule 219.*s\.392/);
  });
  it('2025-26: legacy Form 24Q, s.192, FY', () => {
    expect(salaryTdsLabels(2025)).toMatchObject({ form_type: '24Q', section: '192', period_term: 'FY' });
    expect(salaryTdsLabels(2025).statute).toMatch(/s\.200\(3\).*Rule 31A.*s\.192/);
  });
});

describe('GET /tds/form24q', () => {
  it('2026-27 rows carry section 392', async () => {
    stub({ year: 2026, month: 7 });
    const r = await request(app).get('/api/tds/form24q?financial_year=2026-27&quarter=Q2');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ form_type: '138', salary_tds_section: '392', period_term: 'Tax Year' });
    expect(r.body.quarters[0].deductees[0].section).toBe('392');
  });
  it('2025-26 rows keep section 192', async () => {
    stub({ year: 2026, month: 1 });
    const r = await request(app).get('/api/tds/form24q?financial_year=2025-26&quarter=Q4');
    expect(r.body).toMatchObject({ form_type: '24Q', salary_tds_section: '192', period_term: 'FY' });
    expect(r.body.quarters[0].deductees[0].section).toBe('192');
  });
});

describe('GET /tds/form24q-download (data extract)', () => {
  it('2026-27: Tax Year, the statute line, and "Act Section" 392', async () => {
    stub({ year: 2026, month: 7 });
    const r = await request(app).get('/api/tds/form24q-download?financial_year=2026-27&quarter=Q2');
    expect(r.status).toBe(200);
    const lines = r.text.split('\n');
    expect(lines[0]).toMatch(/^FORM 138 \(formerly FORM 24Q\) - Salary TDS statement data extract \| Tax Year 2026-2027 \| Q2$/);
    expect(lines[1]).toMatch(/s\.397\(3\)\(b\) of the Income-tax Act 2025 .*s\.392/);
    expect(r.text).toMatch(/\|Act Section\|/);
    expect(r.text).toMatch(/\|EMP007\|ABCDE1234F\|Asha K\|392\|/);
    expect(r.text).not.toMatch(/\|192\|/);
    expect(r.text).toMatch(/not an RPU section code/);
  });
  it('2025-26: legacy labels preserved', async () => {
    stub({ year: 2026, month: 1 });
    const r = await request(app).get('/api/tds/form24q-download?financial_year=2025-26&quarter=Q4');
    expect(r.status).toBe(200);
    expect(r.text.split('\n')[0]).toMatch(/^FORM 24Q - Salary TDS statement data extract \| FY 2025-2026 \| Q4$/);
    expect(r.text).toMatch(/\|Asha K\|192\|/);
  });
});
