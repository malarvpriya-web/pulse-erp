/**
 * docNumber.js — atomic document-number generation via PostgreSQL sequences.
 *
 * Every function accepts either a pg Pool client or the default pool.
 * Pass a transaction client when the number must be part of a BEGIN/COMMIT block.
 *
 * All sequences are created by migration 20260520000002_document_sequences.js,
 * except seq_ips (20260716000002_service_master_ips.js) and seq_cw / seq_cert /
 * seq_wr / seq_wc (20261014000001_commissioning_numbering_sequences.js).
 */

import pool from '../config/db.js';

async function nextval(sequenceName, client) {
  const db = client || pool;
  const { rows } = await db.query(`SELECT nextval($1)::INT AS n`, [sequenceName]);
  return rows[0].n;
}

// ── Industrial / Operations ──────────────────────────────────────────────────

/** ECN-00001 */
export async function nextEcnNumber(client) {
  const n = await nextval('seq_ecn', client);
  return `ECN-${String(n).padStart(5, '0')}`;
}

/** SAV-00001  (savings register initiatives — seq created by 20260910000003) */
export async function nextSavingsNumber(client) {
  const n = await nextval('seq_savings', client);
  return `SAV-${String(n).padStart(5, '0')}`;
}

/**
 * SDP-2026-0001 — supplier development plan.
 *
 * Carries the year because a development programme is read against the period
 * it ran in far more often than against the one before it, and the sequence
 * (seq_sdp, created by 20260911000002) keeps it unique regardless.
 */
export async function nextSupplierDevPlanNumber(client) {
  const n = await nextval('seq_sdp', client);
  return `SDP-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`;
}

/** LC-000001 */
export async function nextLifecycleNumber(client) {
  const n = await nextval('seq_lc', client);
  return `LC-${String(n).padStart(6, '0')}`;
}

// ── Commissioning / warranty ─────────────────────────────────────────────────
// seq_cw / seq_cert / seq_wr / seq_wc — migration
// 20261014000001_commissioning_numbering_sequences.js. These replaced
// per-company COUNT(*)+1, which reused another company's number against the
// globally unique columns. Numbers are global (a company's own numbers may skip
// values); the formats did not change.

/**
 * nextval() for `sequenceName`, formatted, skipping a value that is somehow
 * already in `table.column` (a row written by old code during a deploy, or by
 * hand). Bounded so a misconfigured sequence fails loudly instead of looping.
 */
async function nextUnused(sequenceName, format, table, column, client) {
  const db = client || pool;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = format(await nextval(sequenceName, db));
    const { rows } = await db.query(`SELECT 1 FROM ${table} WHERE ${column} = $1 LIMIT 1`, [candidate]);
    if (!rows.length) return candidate;
  }
  throw new Error(`${sequenceName}: no unused number after 20 attempts — reseed the sequence above ${table}.${column}`);
}

/** CW-YY-0001  (commissioning_workflows.workflow_number) */
export function nextCommissioningWorkflowNumber(client) {
  const yy = String(new Date().getFullYear()).slice(-2);
  return nextUnused('seq_cw', n => `CW-${yy}-${String(n).padStart(4, '0')}`,
    'commissioning_workflows', 'workflow_number', client);
}

/** CERT-YYYY-0001  (commissioning_workflows.certificate_number) */
export function nextCommissioningCertificateNumber(client) {
  const yyyy = new Date().getFullYear();
  return nextUnused('seq_cert', n => `CERT-${yyyy}-${String(n).padStart(4, '0')}`,
    'commissioning_workflows', 'certificate_number', client);
}

/** WR-00001  (warranty_registrations.warranty_number) */
export function nextWarrantyNumber(client) {
  return nextUnused('seq_wr', n => `WR-${String(n).padStart(5, '0')}`,
    'warranty_registrations', 'warranty_number', client);
}

/** WC-00001  (warranty_claims.claim_number) */
export function nextWarrantyClaimNumber(client) {
  return nextUnused('seq_wc', n => `WC-${String(n).padStart(5, '0')}`,
    'warranty_claims', 'claim_number', client);
}

/** PO-00001  (production orders) */
export async function nextProdOrderNumber(client) {
  const n = await nextval('seq_po_prod', client);
  return `PO-${String(n).padStart(5, '0')}`;
}

/** IMR-00001  (module production batch requests) */
export async function nextImrNumber(client) {
  const n = await nextval('seq_imr', client);
  return `IMR-${String(n).padStart(5, '0')}`;
}

/** AMC-000001 */
export async function nextAmcNumber(client) {
  const n = await nextval('seq_amc', client);
  return `AMC-${String(n).padStart(6, '0')}`;
}

/** TR-000001 */
export async function nextTestRunNumber(client) {
  const n = await nextval('seq_tr', client);
  return `TR-${String(n).padStart(6, '0')}`;
}

// ── Sales / CRM ──────────────────────────────────────────────────────────────

/** SO-0001 */
export async function nextSalesOrderNumber(client) {
  const n = await nextval('seq_so', client);
  return `SO-${String(n).padStart(4, '0')}`;
}

/** QT-0001 */
export async function nextQuotationNumber(client) {
  const n = await nextval('seq_qt', client);
  return `QT-${String(n).padStart(4, '0')}`;
}

/** PRJ-0001 */
const projectCodeOf = (n) => `PRJ-${String(n).padStart(4, '0')}`;

/** True for a code in the seq_prj format — one this sequence issues. */
export const isSequenceProjectCode = (code) => /^PRJ-\d{4,}$/.test(String(code ?? ''));

export async function nextProjectCode(client) {
  return projectCodeOf(await nextval('seq_prj', client));
}

/**
 * The code nextProjectCode() would issue next, WITHOUT consuming it — for a
 * form preview. Only a hint: a concurrent create can take it first, so the
 * real code is always assigned on save.
 */
export async function peekProjectCode(client) {
  // pg_sequences.last_value is NULL until the first nextval(); seq_prj has
  // cache 1, so otherwise it is the last value actually handed out.
  const { rows } = await (client || pool).query(
    `SELECT last_value, start_value, increment_by FROM pg_sequences
      WHERE schemaname = current_schema() AND sequencename = 'seq_prj'`
  );
  const { last_value, start_value, increment_by } = rows[0];
  return projectCodeOf(last_value == null ? Number(start_value) : Number(last_value) + Number(increment_by));
}

// ── Finance ──────────────────────────────────────────────────────────────────

/** INV0001 */
export async function nextInvoiceNumber(client) {
  const n = await nextval('seq_inv', client);
  return `INV${String(n).padStart(4, '0')}`;
}

/** BILL0001 */
export async function nextBillNumber(client) {
  const n = await nextval('seq_bill', client);
  return `BILL${String(n).padStart(4, '0')}`;
}

/** PAY0001 */
export async function nextPaymentNumber(client) {
  const n = await nextval('seq_pay', client);
  return `PAY${String(n).padStart(4, '0')}`;
}

/** REC0001 */
export async function nextReceiptNumber(client) {
  const n = await nextval('seq_rec', client);
  return `REC${String(n).padStart(4, '0')}`;
}

/** EXP0001 */
export async function nextExpenseNumber(client) {
  const n = await nextval('seq_exp', client);
  return `EXP${String(n).padStart(4, '0')}`;
}

/** PB0001 */
export async function nextPaymentBatchNumber(client) {
  const n = await nextval('seq_pb', client);
  return `PB${String(n).padStart(4, '0')}`;
}

/** JE0001  (used by finance journal repository) */
export async function nextJournalEntryNumber(client) {
  const n = await nextval('seq_je', client);
  return `JE${String(n).padStart(4, '0')}`;
}

/** JE-YYYY-0001  (used by accounting.routes.js — year-labelled) */
export async function nextAccountingJournalNumber(client) {
  const n = await nextval('seq_je_acct', client);
  const year = new Date().getFullYear();
  return `JE-${year}-${String(n).padStart(4, '0')}`;
}

/** TKT0001  (finance ticket repository) */
export async function nextFinanceTicketNumber(client) {
  const n = await nextval('seq_ftkt', client);
  return `TKT${String(n).padStart(4, '0')}`;
}

/** Party codes — C001 / S001 / V001 */
export async function nextPartyCode(type, client) {
  const seqMap = { customer: 'seq_party_c', supplier: 'seq_party_s', vendor: 'seq_party_v' };
  const seq = seqMap[type?.toLowerCase()] || 'seq_party_c';
  const prefixMap = { customer: 'C', supplier: 'S', vendor: 'V' };
  const prefix = prefixMap[type?.toLowerCase()] || 'C';
  const n = await nextval(seq, client);
  return `${prefix}${String(n).padStart(3, '0')}`;
}

/** CUST001  (parties.repository.js Customer prefix) */
export async function nextCustPartyCode(client) {
  const n = await nextval('seq_party_cust', client);
  return `CUST${String(n).padStart(3, '0')}`;
}

/** SUPP001  (parties.repository.js Supplier prefix) */
export async function nextSuppPartyCode(client) {
  const n = await nextval('seq_party_supp', client);
  return `SUPP${String(n).padStart(3, '0')}`;
}

// ── Procurement / Inventory ──────────────────────────────────────────────────

/**
 * Document prefixes configured per company in `procurement_settings`.
 *
 * The Settings screen has always offered a Numbering card with pr_prefix /
 * po_prefix / grn_prefix / rfq_prefix, and PUT /settings persisted all four
 * faithfully — but every generator below hardcoded its prefix, so a company that
 * set "REQ" still got PR0001 on every requisition. The card was decorative.
 *
 * `companyId` is optional and the lookup is best-effort: numbering must never be
 * the reason a document fails to be created, so any failure (no settings row, no
 * company on the caller, a table that is mid-migration) falls back to the
 * built-in prefix. A prefix is sanitised to the letters/digits the column allows
 * before it reaches a document number.
 */
async function prefixFor(column, fallback, companyId, client) {
  if (companyId == null) return fallback;
  try {
    const db = client || pool;
    const { rows } = await db.query(
      `SELECT ${column} AS p FROM procurement_settings WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    const raw = String(rows[0]?.p ?? '').trim().toUpperCase();
    const clean = raw.replace(/[^A-Z0-9-]/g, '').slice(0, 10);
    return clean || fallback;
  } catch {
    return fallback;
  }
}

/** PR0001 (prefix from procurement_settings.pr_prefix when a company is known) */
export async function nextPurchaseRequestNumber(client, companyId = null) {
  const prefix = await prefixFor('pr_prefix', 'PR', companyId, client);
  const n = await nextval('seq_pr', client);
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** PO0001  (purchase orders — procurement module) */
export async function nextPurchaseOrderNumber(client, companyId = null) {
  const prefix = await prefixFor('po_prefix', 'PO', companyId, client);
  const n = await nextval('seq_po_purch', client);
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** GRN0001 */
export async function nextGrnNumber(client, companyId = null) {
  const prefix = await prefixFor('grn_prefix', 'GRN', companyId, client);
  const n = await nextval('seq_grn', client);
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/**
 * RTV0001 — return to vendor.
 *
 * grn.service.createRTV() minted `RTV-${Date.now()}`. A wall-clock string is not
 * a document number: it cannot be read out over the phone, cannot be searched
 * for, ignores the numbering prefix the company configured, and two returns
 * raised in the same millisecond collide on return_to_vendor's UNIQUE constraint.
 * Shares grn_prefix's sibling convention — an RTV is the reverse of a receipt —
 * but carries its own sequence so the two series never interleave.
 */
export async function nextRtvNumber(client, companyId = null) {
  const prefix = await prefixFor('rtv_prefix', 'RTV', companyId, client);
  const n = await nextval('seq_rtv', client);
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/**
 * LPR0001 — local (off-PO) purchase.
 *
 * Was `LPR${Date.now()}`, with the same problems as the RTV series above. Off-PO
 * spend is exactly the spend a finance review has to be able to cite by number.
 */
export async function nextLocalPurchaseNumber(client, companyId = null) {
  const prefix = await prefixFor('lpr_prefix', 'LPR', companyId, client);
  const n = await nextval('seq_lpr', client);
  return `${prefix}${String(n).padStart(4, '0')}`;
}

/** RFQ-YYYY-001  (year label comes from JS, counter is global) */
export async function nextRfqNumber(client, companyId = null) {
  return nextRfxNumber('RFQ', client, companyId);
}

/**
 * RFI-YYYY-001 / RFP-YYYY-001 / RFQ-YYYY-001.
 *
 * All three RFx stages share `seq_rfq` on purpose. They are one event series
 * living in one table, so a shared counter keeps the numbers unique without a
 * second sequence to create, seed and keep in step — only the prefix says which
 * stage the event is. An unrecognised type falls back to RFQ rather than
 * minting a document with a made-up prefix.
 */
export async function nextRfxNumber(rfxType, client, companyId = null) {
  const n = await nextval('seq_rfq', client);
  const year = new Date().getFullYear();
  const type = String(rfxType || '').toUpperCase();
  // Only the RFQ stage is configurable: rfq_prefix is the one the Settings card
  // exposes, and RFI/RFP keep their stage labels so the number still says which
  // stage minted it.
  const prefix = type === 'RFI' || type === 'RFP'
    ? type
    : await prefixFor('rfq_prefix', 'RFQ', companyId, client);
  return `${prefix}-${year}-${String(n).padStart(3, '0')}`;
}

/** ITEM0001 */
export async function nextItemCode(client) {
  const n = await nextval('seq_item', client);
  return `ITEM${String(n).padStart(4, '0')}`;
}

/** RMI0001 */
export async function nextRmIssueNumber(client) {
  const n = await nextval('seq_rmi', client);
  return `RMI${String(n).padStart(4, '0')}`;
}

// ── Helpdesk ─────────────────────────────────────────────────────────────────

/** TKT-0001  (support_tickets in servicedesk.routes.js) */
export async function nextTicketNumber(client) {
  const n = await nextval('seq_tkt', client);
  return `TKT-${String(n).padStart(4, '0')}`;
}

/**
 * IPS-00001  (field-service tickets — support_tickets.ticket_number where
 * ticket_kind = 'service'). Helpdesk tickets keep nextTicketNumber's TKT-####
 * off seq_tkt; the two kinds share the column but never the sequence.
 */
export async function nextServiceTicketNumber(client) {
  const n = await nextval('seq_ips', client);
  return `IPS-${String(n).padStart(5, '0')}`;
}

/**
 * IPCS-00001  (customer complaints — complaints.complaint_number).
 * Was CMP-YYYY-#### off seq_cmp until 20260717000002, which renumbered every
 * existing row; seq_cmp survives only so that migration's `down` can reverse.
 */
export async function nextComplaintNumber(client) {
  const n = await nextval('seq_ipcs', client);
  return `IPCS-${String(n).padStart(5, '0')}`;
}

// ── HR / Recruitment ──────────────────────────────────────────────────────────

/*
 * Employee codes are deliberately NOT minted here.
 *
 * `nextEmployeeCode()` used to live in this file and returned `EMP-0001` off
 * `seq_emp` — a fourth generator, in the wrong format, with zero callers. It
 * survived only because nothing imported it, and it was one of the three dashed
 * examples that misled an earlier pass into treating `EMP-0001` as the canonical
 * shape when the live data said `EMP001`.
 *
 * The real generator is `nextEmployeeCode` in shared/employeeCode.js, and it
 * cannot be a plain sequence draw like the numbers in this file: an Employee ID
 * is scoped PER COMPANY (two tenants may both hold EMP001) and has to continue
 * that company's own series, which a single global sequence cannot express.
 *
 * `seq_emp` itself is still used, by `FIXTURE_CODE_SQL`, purely to make test rows
 * unique.
 */

/** REQ-0001  (job_requisitions) */
export async function nextRequisitionNumber(client) {
  const n = await nextval('seq_req', client);
  return `REQ-${String(n).padStart(4, '0')}`;
}

/** JOB-0001  (job_openings) */
export async function nextJobOpeningNumber(client) {
  const n = await nextval('seq_job', client);
  return `JOB-${String(n).padStart(4, '0')}`;
}

/** BOM-0001  (bill_of_materials) */
export async function nextBomNumber(client) {
  const n = await nextval('seq_bom', client);
  return `BOM-${String(n).padStart(4, '0')}`;
}

/** OFR-0001  (job_offers) */
export async function nextOfferNumber(client) {
  const n = await nextval('seq_ofr', client);
  return `OFR-${String(n).padStart(4, '0')}`;
}
