# Inventory / SCA — what is still open

**Re-verified 2026-09-11 16:5x** against the running server and the working tree.
Supersedes the 2026-09-10 version of this file, which is no longer accurate.

> **Read this first.** A large SCA build landed between 10 Sep ~21:00 and 11 Sep
> ~16:45 (uncommitted at the time of writing — `git HEAD` is still `19aacea`).
> It added `inventoryPlanning.service.js`, `demandForecast.service.js`,
> `planning.routes.js` and six migrations (`sca_spine_identity`,
> `inventory_planning_params`, `demand_forecasting`,
> `fulfilment_pack_ship_return`, `capacity_labour_fifo`, `batch_quality_states`).
> The broad 198-component audit lives in its own report
> (see `project_sca_audit_planning_spine_dead`). This file is only the residue:
> defects I confirmed **still reproduce right now**.

---

## Superseded — do not re-raise from the 09-10 version

| item | 09-10 verdict | now |
|---|---|---|
| Safety stock calculation | not built | **built** — `zForServiceLevel()` + `recomputePlanningParameters()`; live item CBL-25 carries `safety_stock: 104.28` |
| ROP calculation | computed but never persisted | **persisted** — live `reorder_point: 200.17` |
| ABC / dynamic ABC | computed, never written back | **built** — `GET /planning/abc`, recompute writes the master |
| Demand variability | not built | **built** — moving average, exponential smoothing, Holt, seasonal indices, MAPE |
| MRP → PR → PO | I called this "built & correct" | **I was wrong at the time.** `mrp_runs` then held 14 seed rows with `planned_order_count = 0`; the engine emitted nothing to convert. It is now genuinely live: run #653 produced **52 planned orders, 10 exceptions** |

My 09-10 pass verified the *conversion endpoint* by reading it and took
`mrp_planned_orders` having rows as evidence the chain ran. Those rows were seed.
The chain was dead; it is alive now for a different reason than I recorded.

---

## Status — every finding closed

| # | finding | closed by | verified |
|---|---|---|---|
| 1 | Every ledger balance nets to zero | this pass (script bug) + rebuild re-run | 9 of 11 item/warehouse pairs now hold positive stock |
| 2 | FIFO not implemented, method label lied | the parallel SCA session | `inventory_fifo_layers` exists; FIFO/FEFO are real |
| 3 | Reservations had no effect | this pass | 12 checks |
| 4 | Cycle-count variance from the request body | this pass | 11 checks |
| 5 | Batch identity destroyed at issue | the parallel SCA session | `material_issue_logs.batch_id` added |
| 6 | Tenant scoping gaps | this pass | 12 checks + 4 on reorder alerts |

---

### 1. Ledger zero balances — CLOSED

`scripts/sca/rebuild-supply-chain-data.mjs` seeded opening stock at line 519 and
then deleted it at line 520: `seedHistory`'s idempotency sweep matched the
`SCA-REF` tag alone and wiped the nine `opening` rows one line after they were
inserted. The 24 months of paired receipt/consumption history nets to nil by
design, so with the opening position gone every balance landed on exactly zero.

Each function now clears only the rows it writes (`transaction_type <> 'opening'`
in `seedHistory`, `= 'opening'` in `seedOpeningStock`). The script has since been
re-run: **9 of 11 item/warehouse pairs now carry stock** — CBL-25 900, TB-32 260,
RLY-24 70, CU-BUS-100 40, and so on.

### 3. Reservations — CLOSED

Three defects, one cause: nothing ever checked whether the stock being claimed
existed.

- **No availability check.** `createReservation()` inserted unconditionally — a
  million units of an item with three on hand was accepted. It now runs in a
  transaction, takes `SELECT … FOR UPDATE` on the item row to serialise
  concurrent claims, and refuses with 422 when the request exceeds
  on-hand minus what is already reserved. The error names both figures.
- **Reserved vs Available could never return a row.** It read
  `inventory_batches.quantity_reserved`, which nothing in the codebase has ever
  written, behind a `HAVING SUM(quantity_reserved) > 0`. Both sides are now
  derived from the rows that record the facts — on-hand from `stock_ledger`,
  reserved from open reservations (`active` / `partially_consumed` only).
  Deliberately derived rather than starting to maintain that counter: a second
  hand-kept quantity column is exactly how `current_stock` drifted away from
  `stock_ledger`.
- **No tenant boundary.** `getReservations()` listed every tenant's reservations
  to any authenticated caller; it now scopes through `inventory_items.company_id`.

Verified with 12 checks, including a genuine race: two concurrent claims for the
same remaining stock, exactly one of which wins.

### 6. Tenant scoping and the alert fan-out — CLOSED

- `/stock/valuation` — `getInventoryValuation()` gained a `companyId` parameter
  and a tenant predicate; it had been pricing every company's stock into one
  caller's total.
- `/slow-movers` — tenant predicate added.
- `/abc-analysis` — the cache read ignored the `company_id` the table now
  carries and handed whichever tenant computed last to whoever asked. The read
  is scoped, the run is scoped, and the row it writes is stamped.
- `/reorder-alerts` — was `CROSS JOIN warehouses`, testing every item against
  every store, so a store that never carried an item read 0, counted that as
  "below reorder point", and alerted. **25 alerts for 5 items became 9 real
  ones.** Candidate pairs now come from `SELECT DISTINCT item_id, warehouse_id
  FROM stock_ledger`. `reorder_level` is item-level and Pulse has no
  item × warehouse planning row, so ledger history is the honest proxy for
  "this store carries this item"; an item never stocked anywhere now raises no
  alert, which is right — you cannot be below a reorder point at a location that
  does not hold the item.

**Also fixed in passing:** the "Weighted Average" valuation was
`AVG(NULLIF(sl.rate, 0))` — the unweighted mean of the rates on the ledger rows.
A 1-unit receipt at ₹1,000 beside a 1,000-unit receipt at ₹10 priced the stock at
₹505/unit. It is now `SUM(qty_in × rate) / SUM(qty_in)`, verified at ₹10.99.

---

## Issue paths now respect reservations — CLOSED

The last open item, and the only one that needed a decision rather than a fix.
Previously every issue path asked the same narrow question — *is the ledger
balance at least the quantity I want?* — so stock reserved for one order was
freely issuable to the next caller. A reservation constrained other
reservations and nothing else, which made it a note rather than a claim.

New shared helper, `services/stockAvailability.service.js`:

- **Issuing without a reservation draws on free stock only** —
  `available = on hand − everything currently reserved`.
- **Issuing with a `reservation_id` draws on that reservation's own remaining
  quantity.** Its claim is what the reservation was for, so it is not blocked by
  itself — but it still cannot exceed what is physically on hand, and it draws
  the reservation down (`quantity_consumed` up, `quantity_remaining` down,
  status to `partially_consumed` / `fully_consumed`) under `FOR UPDATE`, so two
  issues cannot spend the same remaining quantity.

Both readings run inside the caller's transaction, so the figures cannot move
between the check and the ledger write.

Wired into four paths:

| path | behaviour |
|---|---|
| `POST /inventory/stock/movement` (OUT) | accepts `reservation_id` |
| `POST /inventory/consumption` | accepts `reservation_id` |
| `rmIssue.service.js` | accepts `reservation_id` per line |
| `PUT /inventory/warehouse-transfers/:id/dispatch` | free stock only — see below |

A transfer moves stock out of the location the reservation was made against, so
there is no reservation for it to draw on; the claim has to be released first.
That is deliberate, and the comment at the call site says so.

**Stock adjustments were left alone on purpose.** An adjustment is a correction
of what the book says against reality — blocking one because the stock it is
correcting happens to be reserved would make the book permanently wrong. Their
guards still read the raw balance.

Verified with 14 checks, including the full sequence on a real item
(CBL-25, 900 on hand, 540 reserved, 360 free):

```
PASS  issue beyond free stock refused
      "360 available (900 on hand, 540 reserved). Requested 370.
       Issue against a reservation to draw on reserved stock."
PASS  issue within free stock succeeds
PASS  further un-reserved issue refused once free stock is gone
PASS  issue against its own reservation succeeds
PASS  reservation drawn down          (remaining 270, consumed 270)
PASS  reservation marked partially_consumed
PASS  over-drawing a reservation refused
PASS  reservation for another item refused
PASS  receipts unaffected by reservations
PASS  database restored: ledger 442 -> 442, on-hand 900 -> 900
```

---

## Changes made in this pass

All uncommitted, on top of `19aacea`:

| file | change |
|---|---|
| `backend/scripts/sca/rebuild-supply-chain-data.mjs` | Scoped two idempotency deletes so `seedHistory` stops wiping the opening stock `seedOpeningStock` writes one line earlier |
| `backend/src/modules/warehouse/warehouse.routes.js` | Cycle-count variance reads the frozen book quantity from `cycle_count_lines`; rejects foreign `line_id` and non-numeric `counted_qty` |
| `backend/src/modules/inventory/repositories/advancedInventory.repository.js` | Reservation availability check + `FOR UPDATE` serialisation; Reserved-vs-Available derived from ledger and open reservations; reservation listing scoped |
| `backend/src/modules/inventory/routes/advancedInventory.routes.js` | Pass `companyOf(req)` into the two reservation reads |
| `backend/src/modules/inventory/repositories/stockLedger.repository.js` | Valuation takes a `companyId` and filters on it; weighted average is quantity-weighted |
| `backend/src/modules/inventory/routes/inventory.routes.js` | Tenant predicates on valuation / slow-movers / ABC; ABC cache stamped and read per company; `/reorder-alerts` de-fanned and scoped; three issue paths routed through `authorizeIssue` |
| `backend/src/modules/inventory/services/stockAvailability.service.js` | **New.** `availability()` and `authorizeIssue()` — free-stock arithmetic and reservation draw-down, shared by every issue path |
| `backend/src/modules/inventory/services/rmIssue.service.js` | Raw-material issue draws on free stock, or on a named reservation per line |

No permanent regression tests were added — `src/__tests__/` has no inventory
reservation or cycle-count suite today, and standing new suites up was outside
these fixes. Each fix was verified by a throwaway harness that created its own
rows and asserted the database was back to its starting figures afterwards.
