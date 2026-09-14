/**
 * captureBefore.test.js
 *
 * The before-image capture. The assertions that matter are the ones about what
 * it must NOT do: read another tenant's row into this tenant's audit log, fire
 * on a read, or turn a database blip into a 500.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../config/db.js', () => ({ default: { query: mockQuery } }));

const { captureBefore, __resetTableScopeCache } =
  await import('../middlewares/captureBefore.js');

const run = async (mw, req) => {
  const next = vi.fn();
  await mw(req, { json: vi.fn() }, next);
  return next;
};

const req = (over = {}) => ({
  method: 'PUT', params: { id: '7' },
  user: { userId: 1, company_id: 3 },
  originalUrl: '/api/x/7', ...over,
});

describe('captureBefore()', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // The company_id lookup is cached per table for the life of the process —
    // which is the point of it. Without clearing, one test's lookup silently
    // satisfies the next test's and its assertions pass for the wrong reason.
    __resetTableScopeCache();
  });

  test('refuses an unsafe identifier at mount time, not at request time', () => {
    // The table is interpolated into SQL. A bad one must fail when the route is
    // defined — loudly, at boot — rather than on a request in production.
    expect(() => captureBefore('users; DROP TABLE x')).toThrow(/unsafe identifier/);
    expect(() => captureBefore('ok_table', { column: 'a-b' })).toThrow(/unsafe identifier/);
    expect(() => captureBefore('sales_orders')).not.toThrow();
  });

  test('does nothing on a GET', async () => {
    const next = await run(captureBefore('sales_orders'), req({ method: 'GET' }));
    expect(mockQuery).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  test('does nothing when the route carries no id', async () => {
    const next = await run(captureBefore('sales_orders'), req({ params: {} }));
    expect(mockQuery).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  test('captures the row onto req._auditBefore', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })                       // table has company_id
      .mockResolvedValueOnce({ rows: [{ id: 7, total: 1000, status: 'draft' }] });
    const r = req();
    await run(captureBefore('sales_orders'), r);
    expect(r._auditBefore).toEqual({ id: 7, total: 1000, status: 'draft' });
  });

  test('⚠ SCOPES the fetch by company when the table has company_id', async () => {
    // The row goes into the audit log. Fetching it unscoped would write another
    // tenant's data into this tenant's audit trail — a leak through the one
    // table nobody thinks to check.
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 7 }] });
    await run(captureBefore('sales_orders'), req());

    const [sql, params] = mockQuery.mock.calls[1];
    expect(String(sql)).toContain('company_id');
    expect(params).toEqual(['7', 3]);
  });

  test('omits the company predicate for a table that has no company_id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 7 }] });
    await run(captureBefore('some_global_table'), req());

    const [sql, params] = mockQuery.mock.calls[1];
    expect(String(sql)).not.toContain('company_id');
    expect(params).toEqual(['7']);
  });

  test('a missing row leaves no before-image rather than an empty one', async () => {
    // `{}` would read as "every field was blank before", which is worse than
    // recording nothing.
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] });
    const r = req();
    await run(captureBefore('sales_orders'), r);
    expect(r._auditBefore).toBeUndefined();
  });

  test('a database failure does not break the request', async () => {
    // No before-image is a worse audit entry; a 500 is a worse product.
    mockQuery.mockRejectedValue(new Error('connection terminated'));
    const r = req();
    const next = await run(captureBefore('sales_orders'), r);
    expect(next).toHaveBeenCalled();
    expect(r._auditBefore).toBeUndefined();
  });

  test('honours a non-default param and column', async () => {
    mockQuery
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ code: 'X' }] });
    const r = req({ params: { code: 'X' } });
    await run(captureBefore('lookup', { param: 'code', column: 'code' }), r);

    const [sql, params] = mockQuery.mock.calls[1];
    expect(String(sql)).toContain('WHERE code = $1');
    expect(params).toEqual(['X']);
  });

  test('the company_id lookup happens once per table, not per request', async () => {
    // Otherwise every mutation pays an information_schema round trip.
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 7 }] });
    const mw = captureBefore('cached_table');
    await run(mw, req());
    await run(mw, req());
    await run(mw, req());
    const schemaQueries = mockQuery.mock.calls
      .filter(c => String(c[0]).includes('information_schema'));
    expect(schemaQueries.length).toBe(1);
  });
});
