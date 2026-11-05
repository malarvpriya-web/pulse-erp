// Set required env vars before any module imports
process.env.JWT_SECRET = 'test-secret-for-vitest-suite-minimum-32-chars';
process.env.NODE_ENV   = 'test';
process.env.DB_PASSWORD = 'test-db-password';

// There is deliberately NO global teardown closing the pg pool, and no suite
// should close it either: config/db.js exports one pool per vitest WORKER, and
// a worker runs many test files. `pool.end()` in one file's afterAll takes the
// connection away from every file scheduled after it in that worker, which
// surfaces as "Connection terminated unexpectedly" or silently skipped tests in
// files nobody touched — and moves between runs, because vitest's packing
// decides who is affected. The pool dies with the worker process on its own.
// Enforced by sharedPoolLifecycle.contract.test.js.

// ── PO numbers never come from the live sequence in a test (§218) ──────────
// nextPurchaseOrderNumber() takes nextval('seq_po_purch'), and sequences are
// NOT transactional: a test that awards an RFQ or raises a PO for a throwaway
// company — even one rolled back or deleted in afterAll — permanently consumed
// a value of the ONE global sequence real purchase orders are numbered from.
// By 2026-10-30 the sequence stood at 9,358 against two live PO-numbered
// orders (highest PO0007): the next real PO would be PO9359.
//
// Here, in vitest only, that one generator is replaced by a test generator that
// never touches the database. Every other docNumber export stays real. The
// production function, the sequence and the numbering format are unchanged —
// this file is loaded only by vitest (vitest.config setupFiles). Test numbers
// are prefixed ZZT-PO- so a leaked test order is recognisable at a glance, and
// unique across parallel workers (pid + time + counter) for the UNIQUE index on
// purchase_orders.po_number (varchar 50).
// Guarded by poSequenceIsolation.contract.test.js. Set
// PULSE_TEST_REAL_PO_SEQUENCE=1 only for a deliberate test of the real
// generator against a database whose sequence you are free to consume.
import { vi } from 'vitest';

vi.mock('../shared/docNumber.js', async (importOriginal) => {
  const real = await importOriginal();
  if (process.env.PULSE_TEST_REAL_PO_SEQUENCE === '1') return real;
  let n = 0;
  return {
    ...real,
    nextPurchaseOrderNumber: async () => `ZZT-PO-${process.pid}-${Date.now().toString(36)}-${++n}`,
  };
});
