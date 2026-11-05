# Phase 3H — Legacy data reconciliation (2026-10-28)

All findings below come from **read-only** queries against the dev database (`BEGIN READ ONLY`, rolled
back). No historical row was changed to produce them. Every proposed correction requires approval and is
separate from the application code shipped in Phase 3H.

Re-run the reports at any time:

| Report | How | Scope |
|---|---|---|
| Receipt gaps (returns without `received_qty`) | `GET /api/v1/scm/returns/receipt-gaps` | caller's company |
| Legacy order fulfilment | `GET /api/v1/sales/orders/fulfilment-reconciliation` | caller's company |
| Orphaned journals | `node backend/scripts/reconciliation/orphan-journals-report.mjs [--json out.json]` | whole database, read-only |

---

## 1. Credit-note reason classification — done (code)

- New reason **`quantity_correction`** (quantity billed in error, not coming back). With `sales_return` it is
  the only reason that releases invoiced quantity. **`other` no longer releases**; nor do
  `price_revision`, `post_sale_discount`, `deficiency_of_service`.
- A quantity correction must consist of release lines: each names its original invoice line and releases
  exactly the quantity it credits (`released_qty = quantity`) — API (422
  `QUANTITY_CORRECTION_LINES_REQUIRED` / `QUANTITY_CORRECTION_LINE_INVALID`) and database (issue guard).
- History preserved: the five existing credit notes keep their reasons; none released quantity, which the
  migration checks before it runs (it refuses if any `other` note had released quantity).
- UI: the Credit Notes screen offers *Quantity Correction*, which asks for the original invoice and the
  quantity billed in error on each shipped-goods line.

## 2. Historical returns — no case in this database; tooling in place

| Returns in the database | 1 (`RMA-000001`, company 1, `requested`, never received) |
|---|---|
| Received returns with a line missing `received_qty` | **0** |

`RMA-000001` is an ordinary open return, not a historical gap: it can be received or withdrawn through the
normal workflow.

For databases that do have pre-3G receipts, the report classifies each gap line:

- **verified_receipt** — restocked after a passed `restock` and the stock the return posted for the item
  equals `restocked_qty`. The receipt code of that era posted exactly what it received, so
  `received_qty = restocked_qty` is a recorded fact, offered as `proposed_received_qty`.
- **unresolved** — everything else (scrap / repair / replace / failed QC, a restock that does not reconcile, a
  line the receipt never processed). A requested quantity is never taken as received.
- **verified_non_receipt** — only ever recorded by a correction with documentary evidence; no stored field
  proves that nothing came back.

Correction path: `POST /scm/returns/:id/lines/:lineId/receipt-correction` (sales:approve) with
`received_qty`, `evidence_type` (`receipt_document` · `stock_ledger` — must equal the stock posted ·
`non_receipt_confirmation` — must be 0 with nothing restocked) and `evidence_reference`. One line, once, never
overwriting; never moves stock; recorded in `sales_return_receipt_corrections` and the audit log.

## 3. Legacy sales orders — 29 orders, company 1 (Manifest Electra)

**Origin.** All 29 were written by `backend/scripts/sca/rebuild-supply-chain-data.mjs` on 2026-09-11 — the
**SCA-REF reference dataset** (rows tagged `SCA-REF`; order numbers `SO-REF-…` / `SO-TRANSIT-…`;
dispatch refs `DSP-REF-…`). Two suites (`integration.inventoryKpi`, `integration.supplyChain`) assert against
this dataset read-only. No order has an invoice, return, pick list, production order, installation or
warranty record.

| Group | Orders | Status | Evidence | Classification | Recommended action |
|---|---|---|---|---|---|
| `SO-REF-YYYYMMDD-n` | 24 (ids 815–838) | completed | one `stock_ledger` issue each, `reference_type='sales_order'`, `transaction_type='dispatch'`, item 418 (Control Panel 400A), quantity **equal to the ordered quantity in 24/24**; remark `SCA-REF panel dispatch`; ledger rows created in the same 2026-09-11 batch with back-dated transaction dates (2024-10 → 2026-09) | `fulfilled_by_legacy_ledger` | Treat as verified reference demand history. Stock already left, so **no stock movement is needed**. They cannot be invoiced or returned (Phase 3G), which is correct for demo history. If they must ever be invoiceable, approve a legacy-fulfilment link (ledger issue ↔ order line) first. |
| `SO-TRANSIT-2001…2005` | 5 (ids 842–846) | dispatched | one shipment each (`DSP-REF-0001…0005`, `in_transit`, no pick list) and one package (`PKG-REF-0001…0005`, CP-1000 × 3/2/4/2/3 = **14 units**); **no stock issue at all** — the seeding script deliberately writes shipments and packages for the logistics demo without moving stock | `shipped_without_stock_issue` | Data gap by construction: the ledger still holds 14 panels shown as in transit. Choose one, with approval: (a) re-seed these through the pick workflow so stock leaves; (b) an approved stock-issue adjustment for 14 × CP-1000; (c) remove the transit demo orders (the script's own purge does this). Until then they stay blocked from invoicing and returns. |

Safeguards unchanged: none of the 29 can be invoiced as goods or returned until reconciled through an
approved workflow.

## 4. Orphaned journal entries — 938, all classified as test artefacts

| | |
|---|---|
| Entries | **938**, across **101** company ids, all in **11209–12459** |
| Created | 2026-10-22 05:45 UTC → 2026-10-28 03:54 UTC (the Phase 3C–3G test runs) |
| Types | Invoice 530 · COGS 324 · CreditNote 84 — all `posted` |
| Header totals (Dr = Cr) | Invoice ₹337,100.00 · COGS ₹207,388.00 · CreditNote ₹53,700.00 · **₹598,188.00** |
| Entries still with lines | 193 (Invoice 185, COGS 8): ₹74,376.00 Dr = ₹74,376.00 Cr, accounts 1010 / 4001 / 1032 / 5001, all balanced |
| Entries without lines | 745 (their lines were deleted by the old teardown) |

**Evidence (every entry meets every criterion — `TEST_ARTEFACT`, 0 `NEEDS_REVIEW`):**

1. The company does not exist; **no live company** has an id in 11209–12459. Of the 127 live companies,
   126 carry a test marker in their name or code (ZZ…, IOT…, TSP…, CA_/CB_…, run timestamps); the only one
   that does not is id 1 (Manifest Electra).
2. No user, employee or audit-log row names any of the 101 company ids.
3. The record each entry refers to is gone: 854/854 invoices and 84/84 credit notes no longer exist.
4. Nothing references any entry (invoices, credit notes, payments, reversals).
5. Lines, where present, balance; credit-note numbers are the per-company test sequence `CN-2026-000n`.

Root cause: `journal_entries` has no FK to `companies`, and test teardowns deleted journals before the
invoices referencing them (`invoices_journal_entry_id_fkey`), so the journal delete failed while the company
delete succeeded. Fixed in the 3C–3G suites (2026-10-28); the count stayed at 938 across the two full runs
that followed.

**Impact.** No company-scoped report sees them (their company ids do not exist). An unscoped (all-company)
ledger view includes ₹74,376.00 on 1010/4001/1032/5001 from the 193 entries with lines — balanced, so trial
balance totals still agree.

### Proposed cleanup (NOT executed — needs approval)

1. Freeze the list: `docs/reconciliation/orphan-journals-2026-10-28.json` (938 ids, generated by the report
   script).
2. Back up: export those entries and their lines (`COPY … TO` / `pg_dump --table` filtered) and keep the file.
3. In **one transaction**: load the frozen ids; re-run the report query and require that **every** frozen id
   still meets all five criteria and that the count is exactly 938 — otherwise roll back.
   `DELETE FROM journal_entries WHERE id = ANY(:frozen_ids)` (lines cascade); require 938 rows deleted;
   commit.
4. Re-run the report: expect 0 orphans.
5. Optional, separate approval: add an FK `journal_entries.company_id → companies(id)` (after cleanup), so the
   database cannot produce orphans again.

---

## Unresolved / decisions needed

1. Approve (or not) the orphan-journal cleanup above.
2. Decide the 5 `SO-TRANSIT` orders: re-seed, adjust stock, or remove.
3. Decide whether the 24 `SO-REF` orders need a legacy-fulfilment link (only if they must ever be
   invoiced or returned).
4. Cancelling issued credit notes is still blocked pending the finance/tax decision (Phase 3G).
