# Sales & Warehouse — Phase 3D design decisions

Status: **proposals awaiting business approval**. Nothing in this document is implemented
unless a section says so. Written 2026-10-27 against the code as it stands after Phase 3C/3D.

Related code: `backend/src/modules/warehouse/pickListWorkflow.service.js` (pick, pack, dispatch,
cancel, quality gate), `backend/src/modules/finance/services/invoice.service.js` (STOCK_LINE rule),
`backend/src/modules/finance/creditNotes.routes.js`, `backend/src/modules/finance/gst.routes.js`,
`backend/src/modules/inventory/services/ledgerSemantics.js`.

---

## 1. Invoice cancellation

### What exists today

| Piece | State |
|---|---|
| Invoice creation | `invoiceService.createInvoice` posts the AR/revenue/GST journal **at creation** and sets status `sent`. There is no unposted "draft" invoice in practice. |
| Invoice cancellation | **None.** Since Phase 3C, `PUT /finance/invoices/:id` refuses `status: cancelled/paid` (it was the only, accidental, way to "cancel"). |
| Credit notes | `POST /finance/credit-notes` → `/:id/issue` posts a reversing revenue + GST journal (`journal_entry_id` recorded). `/:id/cancel` exists for credit notes. **No stock effect.** |
| E-invoice / IRN | `POST /gst/e-invoice/generate` validates and builds the IRP payload, but `submitToIrp` deliberately throws 501 — **no IRN can exist yet**. `invoices.irn_cancelled_at` exists, unused. |
| GST returns | `gst_filings` records filed periods per company/return type. Nothing checks it when an invoice is changed. |
| Period close | `assertPeriodOpen` guards journal posting dates. |

### Recommendation

**Keep the credit note as the only correction for an issued invoice.** Do not build invoice
cancellation now.

Reasons:
- Every invoice is journal-posted when created, so "cancelling" one is always a financial reversal,
  which the credit note already performs with its own audit trail and journal.
- The usual Indian GST position (to be **confirmed by the company's tax advisor**, not assumed here):
  an e-invoice IRN can be cancelled on the IRP only within a short window (24 hours) and only before
  the invoice is reported in GSTR-1; after that, a credit note is the instrument. Pulse cannot cancel
  an IRN at all today because it cannot generate one.
- A cancellation that bypassed GSTR-1 reporting state would misstate the return.

### If cancellation is wanted later — required rules before building

Each of these is a **business/tax decision**:

1. Which invoices are cancellable: only within N hours of creation? only if no payment, no
   credit note, no IRN (or IRN still inside the IRP window), and the period not filed in `gst_filings`?
2. Journal treatment: reverse the original entry (mirror DR/CR, same date or cancellation date?)
   — and in a closed period, reject or post into the current period?
3. COGS / stock: none today (invoices cannot carry stock lines — see §2). If §2 is built, a cancelled
   invoice must release its invoiced fulfilment quantity but **never** move warehouse stock.
4. Numbering: is the cancelled number retained (it must be, for GST continuity)?

Proposed workflow once approved: `POST /finance/invoices/:id/cancel` — lock invoice row; check the
rules above; post the reversing journal through `journalRepo` (period guard applies); set
`status='cancelled'`, `cancelled_at`, `cancelled_by`, `cancel_reason`; if IRN active, call IRP cancel
first and abort on failure; audit row; all in one transaction. Idempotent: a cancelled invoice returns
409.

---

## 2. Invoice-to-fulfilment linkage

### Today

Invoice lines carrying `item_id` are refused (`422 STOCK_LINE_REQUIRES_FULFILMENT`). Sales-order
invoicing raises lines **without** `item_id`, so warehouse-fulfilled sales get revenue but
**no COGS journal** (stock left at pick; nothing books its cost).

### Proposed schema (additive)

```sql
ALTER TABLE invoice_items
  ADD COLUMN item_id           integer REFERENCES inventory_items(id),
  ADD COLUMN pick_list_line_id integer REFERENCES pick_list_lines(id),
  ADD COLUMN unit_cost         numeric(15,4);

-- One invoice may bill a fulfilment line once (it may bill several lines).
CREATE UNIQUE INDEX ux_invoice_items_invoice_pick_line
  ON invoice_items (invoice_id, pick_list_line_id) WHERE pick_list_line_id IS NOT NULL;
CREATE INDEX ix_invoice_items_pick_line ON invoice_items (pick_list_line_id)
  WHERE pick_list_line_id IS NOT NULL;
```

Why `pick_list_lines` and not `package_lines`: the pick line is where stock left the ledger
(`stock_ledger` reference `pick_list`), it carries `item_id`, `batch_id`, `serial_id` and
`sales_order_item_id`, and every package line points back to it. Package lines can be several per
pick line (cartons), which would complicate the quantity limit without adding traceability.

### Rules the service must enforce (in one transaction)

1. **Ownership** — the invoice, the pick list (`pick_lists.company_id`) and the item belong to the
   caller's company; the pick list's `sales_order_id` equals the invoice's `sales_order_id` when set.
2. **Eligibility** — the pick list is `dispatched` (business choice: or also `packed`? — **decision**).
3. **Quantity limit (partial invoicing)** — lock the pick line `FOR UPDATE`, then
   `SUM(invoice_items.quantity)` over non-cancelled invoices (minus quantities released by issued
   credit notes, if credit notes gain item lines) + this line ≤ `pick_list_lines.picked_qty`.
4. **No second stock movement** — a linked line never calls `_writeStockOut`. Only the COGS journal
   is posted.
5. **COGS** — cost = the pick's own cost basis: `inventory_fifo_consumption` rows referencing the
   pick list for that item (FIFO value / quantity), falling back to the ledger rate of the pick's
   `dispatch` rows. Journal: DR COGS / CR Inventory per account mapping (existing
   `cogsJournal._groupByMapping`). **Decision:** recognise COGS at invoice (as now designed) or at
   dispatch?
6. **Unlinked stock lines stay refused.** A standalone counter sale with no pick list would need its
   own fulfilment record (a direct issue) first — **decision** whether that workflow is wanted.
7. **Sales-order invoicing** builds its lines from the order's dispatched pick lines (one invoice line
   per pick line), so partial shipments are invoiced as they ship.

### Compatibility

Legacy invoices: new columns NULL, untouched. API clients: lines with `item_id` keep getting 422
unless they also send a valid `pick_list_line_id`. The STOCK_LINE rule changes from "refuse" to
"refuse unless linked".

---

## 3. Packed pick lists — unpack / return workflows

Cancellation of a `packed` list stays blocked (`409 PACKED_NOT_CANCELLABLE`).

### Required: Unpack (`POST /warehouse/pick-lists/:id/unpack`)
- Lock the pick list and its packages; refuse if any package has `shipment_id` (already shipped).
- Set packages `status='unpacked'` (keep rows — audit), clear `serial_numbers.package_id` and
  restore each serial's status **to what it was before packing** — which requires recording the
  prior status at pack time (`package_lines.serial_prior_status`, new column). Without it, unpack
  would have to guess the status → **schema change needed**.
- Pick list back to `completed` (or `in-progress` if partially picked). No stock movement.
- After unpack, the existing cancel path returns the stock.

### Required: Return after dispatch
`sales_returns` / `sales_return_items` exist (migration 20260911000013) with `shipment_id`,
`disposition`, `qc_result`, `restocked_qty`, `credit_note_id`. A return workflow should: receive
against the shipment/pick line; QC disposition; restock posts `sales_return` (quantity_in — an issue
reversal under `ledgerSemantics`) only for `restocked_qty`; link the credit note. **Decisions:**
restock vs scrap accounting, and whether a return without a credit note is allowed.

---

## 4. Quality dispatch gate (item 5 of Phase 3D)

### Current, enforced rule (unchanged)
When `quality_settings.fat_dispatch_gate` is on (default when no settings row): any non-cancelled
`quality_tests` row with `result = 'fail'` on a production order of the sales order blocks dispatch.
Now applied by **both** warehouse dispatch and sales-order dispatch (one function,
`assertFinalInspectionGate`). `force:true` on sales-order dispatch overrides only the production
gate, never the quality gate.

### Not enforced — needs approval
- **Incomplete tests** (no result yet / status not `completed`) do **not** block. Whether they
  should is a policy decision. Note: `quality_tests.status` has no constrained vocabulary; the dev
  database holds `completed` and 5 seed rows with status `active` and result `'SEED result '`.
  Blocking on "incomplete" would block those orders.
- **Missing tests** — an order with no FAT at all passes. Blocking that needs a definition of which
  products/orders require FAT (a QC plan), which does not exist.
- `fat_punch_point_closure_req` and `fat_customer_witness_req` exist in `quality_settings` but no
  dispatch code reads them.

**Recommendation:** if approved, block on `result IS NULL OR status <> 'completed'` *only* for tests
of type FAT, after (a) constraining the status/result vocabularies and (b) cleaning the seed rows;
and treat "missing FAT" as a separate QC-plan feature.

---

## 5. Other decisions carried forward
- Sales-order-level dispatch now creates a shipment and passes the gates, but **moves no stock**: an
  order shipped without a pick list never leaves the ledger. Should orders with stock items be
  required to go through a pick list? (The order lines carry `item_code`, not `item_id`, so this
  cannot be enforced reliably today.)
- IoT service-part reversal now reverses the stock ledger line, but **not the journal** recorded at
  issue (`journal_reversed: false` in the response) — finance to decide reverse vs returns account.

---

# Phase 3E — what was built (2026-10-27)

Approved: posted invoices are corrected by credit note only (no invoice cancellation); invoice lines
link to fulfilment; packed lists stay non-cancellable until a safe unpack exists; failed or
incomplete mandatory QC blocks dispatch.

## A. Invoice → fulfilment linkage (migration 20261027000003)
- `invoice_items.item_id` (FK inventory_items), `pick_list_line_id` (FK pick_list_lines),
  `unit_cost numeric(15,4)`; unique (invoice_id, pick_list_line_id); trigger
  `trg_invoice_items_fulfilment_guard` refuses a link to another company's line, an undispatched
  list, another item, or billing beyond `picked_qty`.
- `POST /finance/invoices`: a line with `item_id` must name `pick_list_line_id` (else 422
  `STOCK_LINE_REQUIRES_FULFILMENT`, unchanged). Linked lines are locked, validated and costed in the
  invoice transaction; the caller's `unit_cost` is ignored — cost is the pick's FIFO cost
  (`fulfilmentCost`), and if that does not reconcile with the ledger the line is refused (422
  `FULFILMENT_COST_UNVERIFIED`). COGS journal per account mapping; **no stock movement**.
- Error codes: `COMPANY_REQUIRED`, `SALES_ORDER_REQUIRED`, `FULFILMENT_LINE_INVALID`,
  `FULFILMENT_LINE_DUPLICATED`, `FULFILMENT_LINE_NOT_FOUND` (also another company's),
  `FULFILMENT_NOT_DISPATCHED`, `FULFILMENT_ORDER_MISMATCH`, `FULFILMENT_ITEM_MISMATCH`,
  `FULFILMENT_QUANTITY_INVALID`, `FULFILMENT_OVER_INVOICED` (with `uninvoiced`).

## B1. Unpack (migrations 20261027000004/5/6)
- Pack records each serial's prior `status`, `package_id`, `customer_id` on its package line
  (`serial_prior_*`, `serial_prior_recorded`), reading the serial under a row lock.
- `POST /warehouse/pick-lists/:id/unpack` restores them exactly, marks packages `unpacked`
  (`unpacked_at/by/by_name`) and their lines `unpacked`, moves no stock, and returns the list to
  `completed`/`in-progress`. Refused with nothing written: `NOT_PACKED`, `PACKAGE_SHIPPED`,
  `PACKAGE_ON_UNIT_LOAD` (no detach step exists), `PACK_STATE_UNRECORDED` (lines packed before
  0004), `SERIAL_STATE_CHANGED`.
- `uq_package_lines_serial` became `uq_package_lines_serial_live` (one *live* package line per
  serial), so an unpacked serial can be packed again.
- Cancel of a packed list is still 409 `PACKED_NOT_CANCELLABLE`; unpack first, then cancel returns
  the stock. Dispatch ignores unpacked packages; genealogy forward-trace excludes them and the
  movement history labels them "Packed (later unpacked)".

## B2. Customer returns (`/scm/returns`, migration 20261027000007)
- Receive restocks only units that verifiably left stock for the order through its dispatched pick
  lists, less units already returned (`RETURN_EXCEEDS_SHIPPED`, `RETURN_NOT_FROM_STOCK`), at the FIFO
  cost they left at (was: the selling price), into the warehouse they left from or a named company
  warehouse (`WAREHOUSE_REQUIRED`, `WAREHOUSE_NOT_FOUND`); sales order row locked, so concurrent
  receipts cannot over-restock. Serial lines are not restocked (`SERIAL_RESTOCK_UNSUPPORTED`).
  `restocked_qty` records only what actually moved. Empty, duplicated, unknown or out-of-range
  lines are refused. No accounting is posted; the credit note is linked at close and must belong
  to the company (`CREDIT_NOTE_NOT_FOUND`).
- RMA numbers became unique per company (they were global, so every company after the first got a
  500 on its first return).

## C. Quality gate
One function (`finalInspectionBlockers`) for both dispatch paths; `force` never bypasses it;
409 `FAT_GATE` with a `blockers` array (`source`, `id`, `production_order_id`, `kind`, `message`).
Kinds: `FAILED` (any test, mandatory or optional), `INCOMPLETE` (mandatory pending; FAT
`in_progress`/`hold`), `UNRESOLVED` (mandatory test with any other result — never read as a pass),
`OPEN_PUNCH_POINTS` (when `fat_punch_point_closure_req`, default on), `WITNESS_MISSING` (when
`fat_customer_witness_req`, default off). The five seed rows (471–475) reference production orders
1–5, which do not exist: they cannot reach any order and block nothing.

## Still open (decisions, not built)
1. Should a failed **optional** test block? (It does today — the pre-existing rule.)
2. Orders with no QC plan / no FAT pass the gate — needs a QC-plan definition.
3. Sales-order invoicing (`PATCH /sales/orders/:id/invoice`) does not use the linkage and posts no COGS.
4. Credit notes do not release invoiced quantity on a pick line (by design until a credit-note
   line model exists).
5. Serial returns: no defined serial state for a returned unit.
6. The RMA screen (`ReturnsRMA.jsx`) does not match the API: it raises returns without lines (400),
   receives with an empty body (now 400 `RECEIPT_LINES_REQUIRED`), and sends a close
   `disposition` the API ignores. It needs a line-level rebuild.
7. Re-packing a list that is already `packed` re-packs every picked line (double-counts non-serial
   quantities); serial lines are protected by the unique index.
8. `PUT /quality/test-runs/:id` writes columns that do not exist; `dispatch_blocked` is never read;
   `fat_trackers` is seed-only.
9. IoT reversal does not reverse its journal.

---

# Phase 3F — what was built (2026-10-28)

## 1. Sales-order invoicing and credit notes (migration 20261028000001)
- `PATCH /sales/orders/:id/invoice` is one transaction (order row + billed pick lines locked;
  `invoiceService.createInvoice(..., { client })` runs on the same connection). It bills goods only
  from the order's **dispatched** pick lines, uninvoiced quantity only, linked to the pick line and
  priced from the order line (`pick_list_lines.sales_order_item_id`, else the one order line of that
  item, else 422 `SO_LINE_UNRESOLVED`); lines without `item_id` once each. COGS at the pick's FIFO
  cost; no stock moves. Partial invoicing across dispatches; `invoiced` once every order line is
  billed. 409 `ALREADY_INVOICED` (nothing left, or an older whole-order invoice whose lines name no
  pick/order line), 409 `NOTHING_TO_INVOICE` (with `not_invoiced`). Response adds `fully_invoiced`,
  `lines`, `not_invoiced`.
- `pick_line_invoiced_qty(line)` — the one definition (service and trigger): billed on live invoices
  less what **posted** credit notes released (status `issued` + `posted_journal_entry_id`, same
  company, raised against that invoice, never more than the line billed).
- `invoice_items.cogs_qty`: a released quantity billed again is not expensed again.
- Credit notes: company from the request scope (never the body); every write scoped; credit lines
  must be lines of the original invoice, never beyond what the line billed (counting other issued
  notes) — 409 `CREDIT_EXCEEDS_INVOICED`, 422 `CREDIT_LINE_NOT_ON_INVOICE`, 404
  `ORIGINAL_INVOICE_NOT_FOUND`. Issue is claimed under a row lock (409 `CREDIT_NOTE_NOT_DRAFT`);
  its journal now posts (the entry number used `MAX(uuid)`, which always failed) and is recorded in
  `posted_journal_entry_id`. Cancel refuses 409 `CREDIT_RELEASE_CONSUMED` when the released quantity
  was invoiced again.

## 2. Packing idempotency
`packPickList` packs only what live package lines do not already hold; a retry/concurrent request
writes nothing and returns `already_packed: true` (POST `/warehouse/pack` → 200). Explicit lines:
422 `PACK_LINE_UNRESOLVED`, 409 `PACK_EXCEEDS_PICKED`. Package numbers serialised per company.

## 3. Returns & RMA
- API: `GET /scm/returns/eligible?sales_order_id=` (shipped, returned, open-requested, requestable
  per item; serials; company warehouses). Create validates lines against it
  (`RETURN_NOT_FROM_STOCK`, `RETURN_EXCEEDS_SHIPPED`, `RETURN_LINE_DUPLICATED`,
  `SERIAL_ITEM_MISMATCH`, …). Receipt requires an explicit disposition (`DISPOSITION_REQUIRED` /
  `_INVALID`) and pass/fail QC. Close accepts only `credit_note_id` (`CLOSE_FIELD_UNKNOWN`), of the
  company and of this order's invoice (`CREDIT_NOTE_ORDER_MISMATCH`), once (`ALREADY_CLOSED`). The
  list returns lines, quantity and value.
- `ReturnsRMA.jsx` rebuilt on that contract; server errors shown verbatim; success only after the
  server confirms; restock not offered for serial lines.

## 4. QC (migration 20261028000002)
- `PUT /quality/test-runs/:id` maps the screen's contract onto the schema (`result` →
  `overall_result`; measurements → new `test_run_measurements` rows) and refuses unknown fields
  and out-of-vocabulary values.
- `qc_requirements` (order- or product-level FAT / quality test): a configured requirement with no
  passed record blocks dispatch as `REQUIRED_MISSING`; product requirements are met only on a
  production order naming that product. Nothing seeded: `GET /quality/dispatch-readiness` and both
  dispatch responses report `qc_plan: 'not_configured'`. Failed tests (optional included) still block.

## 5. IoT journal reversal (migration 20261028000003)
`reverseIssue` verifies the issue's recorded journal (company, live, `iot_service`, balanced, equal
to the issue cost, not reversed) — else 409 `JOURNAL_ORIGINAL_UNVERIFIED` /
`JOURNAL_ALREADY_REVERSED`, nothing changed — and writes a mirror **draft** entry linked by
`reversal_of_id`. `ux_journal_entries_single_reversal` stops any second reversal of one entry.

## Still open (decisions)
1. Goods shipped by sales-order-level dispatch moved no stock: they can't be invoiced as goods
   through the order (listed in `not_invoiced`) nor raised as returns.
2. A credit note releases quantity whatever its reason; should a price-revision note release
   quantity, and should a release be possible for goods that were also returned?
3. Cancelling an issued credit note does not reverse its journal (unchanged).
4. Credit-note numbering: two generators (COUNT-based and a sequence) can collide.
5. QC requirements are enforced only while `fat_dispatch_gate` is on; should explicit requirements
   hold even with the gate off?
6. `production_orders.product_id` has no FK; product-level requirements rely on it.
7. IoT reversal journals are drafts; finance must post them with the original.
8. Whether a 'requested' RMA may be closed without receipt (allowed, unchanged).

---

# Phase 3G — what was built (2026-10-28)

## Invariants now enforced (API and database)
- **Stock leaves once, through a pick.** Sales-order dispatch refuses an order whose stock lines
  (`item_id`) are not fully shipped by dispatched pick lists (409 `STOCK_REQUIRES_PICK_LIST`,
  `force` included); service-only orders dispatch there. Stock invoices and returns already require a
  pick-line stock movement (3E/3F).
- **Quantity is released only explicitly.** `credit_note_items.released_qty` (exact quantity, on a
  pick-linked line of the original invoice, ≤ the line's credited quantity), only for reasons
  `sales_return` / `other`; `price_revision`, `post_sale_discount`, `deficiency_of_service` never
  release. Sales-return releases ≤ units received back for that order item. Triggers:
  `credit_note_items_release_guard`, `credit_notes_issue_guard` (locks the invoice lines on issue).
- **A returned unit is never billable again.** Per order item: net invoiced ≤ shipped − returned
  (`so_item_returned_qty`), in `prepareFulfilmentLines` (409 `FULFILMENT_RETURNED`, with the order
  row locked before the pick lines), in the sales-order route's billable quantity, and in
  `invoice_items_fulfilment_guard`.
- **Issued credit notes are not cancelled** (409 `ISSUED_CREDIT_NOTE_CANCEL_BLOCKED`; the trigger
  refuses un-issuing and reason changes). Drafts still cancel.
- **One credit-note number per company and year**, `creditNoteNumber.service.js` (advisory lock,
  MAX + 1), used by both writers; `ux_credit_notes_company_number` replaces the global key.
- **Explicit QC requirements hold with the gate off**; the switch governs only the record checks.
- **`production_orders.product_id` → `inventory_items`** (validated FK, 0 orphans at migration;
  create route checks the company).
- **Reversal pairs:** `is_reversed` only for a posted reversal (`reversal_pending`,
  `reversal_status` otherwise); a reversal posts only after its original
  (409 `ORIGINAL_NOT_POSTED`); neither leg editable/deletable (409 `REVERSAL_PAIR_LOCKED`). IoT
  reversal reports `journal_reversed: false` + `journal_reversal: {status:'draft', posting_required}`.
- **Returns close only when every line is received** (`received_qty` recorded per line, receipts in
  parts, each line once), the record is consistent and the stock it posted equals what it restocked
  (`RECEIPT_OUTSTANDING`, `RETURN_RECORD_INCONSISTENT`, `RETURN_STOCK_MISMATCH`), with an issued
  credit note if one is linked (`CREDIT_NOTE_NOT_ISSUED`). `POST /scm/returns/:id/withdraw`
  (sales:approve, reason, nothing received) is the only non-receipt closure.

## Migrations
`20261028000004` credit-note number per company · `20261028000005` production order product FK ·
`20261028000006` release rules, return receipts, order-item rule, credit-note guards.

## Still open (decisions)
1. **Cancelling an issued credit note** — needs finance/tax approval: cancel vs debit note, GSTR-1
   amendment for filed notes, reversal period, and what to do with a release already re-invoiced.
2. Whether reason `other` should be split into an explicit "quantity correction" reason.
3. Returns received before 3G have no `received_qty` (scrapped/failed quantities were not stored);
   such returns cannot be closed until their receipt is re-recorded.
4. Orders shipped before 3G without a pick list carry no stock movement: in dev (non-test
   companies, checked 2026-10-28) 24 `completed` and 5 `dispatched` orders have stock lines and no
   dispatched pick list (the 1 `delivered` order has one). Their goods can neither be invoiced as
   goods nor returned. Needs a data decision.
5. Test-fixture journals: 938 journal entries in dev name companies that no longer exist — test
   teardowns deleted journals before the invoices that reference them (fixed for the 3C–3G suites);
   not deleted, because they cannot be attributed to a suite by any stored field.

---

# Phase 3H — reconciliation and reason codes (2026-10-28)

- Reason `quantity_correction` (migration `20261028000007`): with `sales_return`, the only reasons that
  release invoiced quantity; `other` and price reasons never do. A quantity correction is release lines
  only (`released_qty = quantity`), checked by the API and the issue guard. Existing reasons unchanged.
- Historical receipts: `GET /scm/returns/receipt-gaps` (read-only classification) and
  `POST /scm/returns/:id/lines/:lineId/receipt-correction` (sales:approve, evidence-backed, one line once,
  no stock movement, `sales_return_receipt_corrections` + audit).
- Legacy orders: `GET /sales/orders/fulfilment-reconciliation` (read-only, company-scoped).
- Orphan journals: `backend/scripts/reconciliation/orphan-journals-report.mjs` (read-only).
- Findings and the proposed (unexecuted) cleanup: `docs/reconciliation/PHASE3H_RECONCILIATION_2026-10-28.md`.

---

# Issued credit-note cancellation — decided and built (2026-10-28)

Decision (account holder): **cancel only while not filed in GSTR-1**. Migration
`20261028000010_credit_note_cancellation_unfiled`.

- `POST /finance/credit-notes/:id/cancel` on an **issued** note: needs `finance:approve` and a `reason`;
  refused for a note marked filed (409 `CREDIT_NOTE_FILED` — a GSTR-1 amendment instead). In one
  transaction, locking the order rows then the pick lines its releases touch: posts a balanced mirror
  journal (`CreditNoteCancellation`, `reversal_of_id` = the note's journal, dated the cancellation day,
  through the posting guards: balance, usable accounts, lock date, open period); takes back the note's
  quantity release — refused (409 `CREDIT_RELEASE_CONSUMED`) if that quantity was invoiced again;
  records `cancelled_at/by`, `cancel_reason`, `cancellation_journal_entry_id`; audited. Drafts cancel as
  before.
- `POST /finance/credit-notes/:id/mark-gstr1-filed` (finance:approve): records filing (`gstr1_filed_at/by`);
  one-way; issued notes only. Nothing set `gstr1_filed` before.
- Database: the issue guard allows issued → cancelled only when unfiled, with a reason, and (if posted)
  with a posted reversing journal; never issued → draft; never un-filing. `credit_notes_cancel_guard`
  (after update) refuses a cancellation that would leave a pick line or order item invoiced beyond what
  shipped (less returns).
- Credit Notes screen: Cancel on drafts and unfiled issued notes (asks for the reason); "Mark filed";
  a "GSTR-1 filed" tag.
