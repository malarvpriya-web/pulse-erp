/**
 * docNumber.js — atomic document-number generation via PostgreSQL sequences.
 *
 * Every function accepts either a pg Pool client or the default pool.
 * Pass a transaction client when the number must be part of a BEGIN/COMMIT block.
 *
 * All sequences are created by migration 20260520000002_document_sequences.js,
 * except seq_ips (20260716000002_service_master_ips.js).
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

/** LC-000001 */
export async function nextLifecycleNumber(client) {
  const n = await nextval('seq_lc', client);
  return `LC-${String(n).padStart(6, '0')}`;
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
export async function nextProjectCode(client) {
  const n = await nextval('seq_prj', client);
  return `PRJ-${String(n).padStart(4, '0')}`;
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

/** PR0001 */
export async function nextPurchaseRequestNumber(client) {
  const n = await nextval('seq_pr', client);
  return `PR${String(n).padStart(4, '0')}`;
}

/** PO0001  (purchase orders — procurement module) */
export async function nextPurchaseOrderNumber(client) {
  const n = await nextval('seq_po_purch', client);
  return `PO${String(n).padStart(4, '0')}`;
}

/** GRN0001 */
export async function nextGrnNumber(client) {
  const n = await nextval('seq_grn', client);
  return `GRN${String(n).padStart(4, '0')}`;
}

/** RFQ-YYYY-001  (year label comes from JS, counter is global) */
export async function nextRfqNumber(client) {
  const n = await nextval('seq_rfq', client);
  const year = new Date().getFullYear();
  return `RFQ-${year}-${String(n).padStart(3, '0')}`;
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

/** EMP-0001  (employees) */
export async function nextEmployeeCode(client) {
  const n = await nextval('seq_emp', client);
  return `EMP-${String(n).padStart(4, '0')}`;
}

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
