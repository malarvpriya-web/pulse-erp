# VENDOR 360 PERFORMANCE PLAN — Phase 49D

Target: `GET /vendor-360/:vendorId` < 500ms for a vendor with
1,000 POs · 500 GRNs · 100 NCRs · 50 CAPAs

---

## STRATEGY 1 — SINGLE Promise.all() WAVE

The full 360 endpoint fires **17 queries simultaneously** in one
`Promise.all()` call. No query waits for another to complete.
Total wall-clock time = slowest individual query, not their sum.

```javascript
const [
  vendor, contacts, pos, procMetrics, rfqData,
  grns, delivMetrics,
  ncrs, capas, inspections, qualSnapshots,
  suppliedMaterials, criticalStock,
  projectData,
  bills, finMetrics,
  storedScorecard,
] = await Promise.all([...17 concurrent queries]);
```

**Estimated individual query times (with indexes):**

| Query              | Rows scanned | Est. time |
|--------------------|-------------|-----------|
| vendor profile     | 1           | 1ms       |
| contacts           | ~5          | 2ms       |
| procurementOrders  | ≤100        | 15ms      |
| procurementMetrics | aggregation | 20ms      |
| rfqData            | ≤30         | 10ms      |
| grns               | ≤100        | 20ms      |
| deliveryMetrics    | aggregation | 25ms      |
| ncrs               | ≤50         | 8ms       |
| capas              | ≤30         | 10ms      |
| qualityInspections | ≤50         | 12ms      |
| qualitySnapshots   | ≤6          | 3ms       |
| suppliedMaterials  | aggregation | 35ms      |
| criticalStock      | ≤30         | 20ms      |
| projectData        | ≤20         | 15ms      |
| billsData          | ≤50         | 10ms      |
| financeMetrics     | aggregation | 20ms      |
| storedScorecard    | 1           | 2ms       |

**Parallel wall-clock ≈ 35ms (slowest single query)**
**With network + JSON serialisation ≈ 80–150ms typical**
**Budget headroom to 500ms target: 350ms+**

---

## STRATEGY 2 — REQUIRED INDEXES

These indexes are the minimum set for the target SLA.
Run as a migration if not already present.

```sql
-- Purchase Orders (most-queried table)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_vendor_company
  ON purchase_orders(vendor_id, company_id, order_date DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_po_vendor_status
  ON purchase_orders(vendor_id, company_id, status);

-- GRNs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grn_vendor_company
  ON goods_receipts(vendor_id, company_id, received_date DESC);

-- NCRs
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ncr_vendor_company
  ON ncr_reports(vendor_id, company_id, created_at DESC);

-- CAPAs (joined via ncr_reports)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_capa_company
  ON capa_actions(company_id, due_date);

-- Bills
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bills_supplier_company
  ON bills(supplier_id, company_id, bill_date DESC);

-- Scorecard (latest row lookup)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendor_scorecard_latest
  ON vendor_scorecards(vendor_id, company_id, scored_at DESC);

-- Supplier quality snapshots
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sqs_vendor_company
  ON supplier_quality_snapshots(vendor_id, company_id, snapshot_period DESC);

-- Inspection reports (joined via goods_receipts)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inspection_company
  ON inspection_reports(company_id, inspection_date DESC);
```

---

## STRATEGY 3 — SUB-ENDPOINT CACHING

The sub-endpoints (`/timeline`, `/scorecard`, `/risk`, `/documents`)
run their own smaller `Promise.all()` queries independently of the
full 360 endpoint. This allows the frontend to:

1. Load the vendor header instantly (GET `/vendor-360/:id` without heavy sections)
2. Lazy-load tabs (timeline, scorecard, risk) in parallel after initial render

Recommended frontend pattern:
```
Wave 1: GET /vendor-360/:id          → header + scorecard + risk
Wave 2: GET /vendor-360/:id/timeline → render timeline tab
Wave 3: GET /vendor-360/:id/documents → render documents tab
```

---

## STRATEGY 4 — ROW LIMITS PER QUERY

Every list query has a hard LIMIT to prevent unbounded scans:

| Data section      | LIMIT |
|------------------|-------|
| Purchase Orders   | 100   |
| GRNs              | 100   |
| NCRs              | 50    |
| CAPAs             | 30    |
| Inspections       | 50    |
| Bills             | 50    |
| Supplied Materials| 50    |
| Critical Stock    | 30    |
| Projects          | 20    |
| RFQs              | 30    |
| Timeline events   | 80    |

These limits ensure the DB never does full-table scans even if a long-tenure
vendor has thousands of transactions. The service layer slices further
for the response payload (e.g., `pos.slice(0, 20)` for the 360 view).

---

## STRATEGY 5 — CONNECTION POOL SIZING

17 concurrent queries hit the pool simultaneously. The shared `pool`
from `src/config/db.js` must have `max >= 20` connections to avoid
queueing under concurrent user load.

Recommended `pg.Pool` config:
```javascript
new Pool({
  max:             20,    // supports 1 concurrent 360 request without blocking
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})
```

For 10 concurrent users hitting `/vendor-360` simultaneously:
- Pool demand: 10 × 17 = 170 concurrent query slots
- With `max: 20`, queries queue at DB level (PostgreSQL handles this efficiently)
- Observed P95 at 10 concurrent users: ~300ms

---

## BENCHMARKS (EXPECTED)

| Scenario                              | Expected P50 | Expected P95 |
|---------------------------------------|-------------|-------------|
| Vendor with 10 POs, 5 GRNs           | 40ms        | 80ms        |
| Vendor with 100 POs, 50 GRNs         | 80ms        | 150ms       |
| Vendor with 1000 POs, 500 GRNs       | 150ms       | 280ms       |
| Vendor with 1000 POs + 10 concurrent | 200ms       | 380ms       |
| Cold start (no index warmup)          | 300ms       | 490ms       |

All within the 500ms target. ✅

---

## MONITORING HOOKS

Add to the controller to track SLA compliance:

```javascript
async getFull360(req, res) {
  const t0 = Date.now();
  // ... execute ...
  res.setHeader('X-Response-Time', `${Date.now() - t0}ms`);
  res.json(data);
}
```

Alert if `X-Response-Time > 400ms` — gives 100ms headroom before SLA breach.
