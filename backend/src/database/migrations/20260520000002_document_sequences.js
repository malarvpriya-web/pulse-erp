/**
 * 20260520000002_document_sequences.js
 *
 * Replaces all COUNT(*)+1 and ORDER BY … DESC LIMIT 1 document-number patterns
 * with PostgreSQL sequences.  Each sequence is seeded from the current MAX
 * of that document type so existing documents are never re-used.
 *
 * Sequences created (prefix → table.column sampled):
 *
 *  Industrial / Ops
 *   seq_ecn        ECN-00001   engineering_changes.ecn_number
 *   seq_lc         LC-000001   lifecycle_instances.lifecycle_number
 *   seq_po_prod    PO-00001    production_orders.production_order_no
 *   seq_amc        AMC-000001  amc_contracts.contract_number
 *   seq_tr         TR-000001   test_runs.run_number
 *
 *  Sales / CRM
 *   seq_so         SO-0001     sales_orders.order_number
 *   seq_qt         QT-0001     quotations.quotation_number
 *   seq_prj        PRJ-0001    projects.project_code
 *
 *  Finance
 *   seq_inv        INV0001     invoices.invoice_number
 *   seq_bill       BILL0001    bills.bill_number
 *   seq_pay        PAY0001     payments.payment_number
 *   seq_rec        REC0001     receipts.receipt_number
 *   seq_exp        EXP0001     expense_claims.claim_number
 *   seq_pb         PB0001      payment_batches.batch_number
 *   seq_je         JE0001      journal_entries.entry_number  (also JE-YYYY-)
 *   seq_je_acct    JE-acct     journal_entries in accounting.routes (year-scoped)
 *   seq_ftkt       TKT0001     finance tickets.ticket_number
 *   seq_party_c    C001        parties (customer)
 *   seq_party_s    S001        parties (supplier)
 *   seq_party_v    V001        parties (vendor)
 *
 *  Procurement / Inventory
 *   seq_pr         PR0001      purchase_requests.request_number
 *   seq_po_purch   PO0001      purchase_orders.po_number
 *   seq_grn        GRN0001     goods_receipts.grn_number
 *   seq_rfq        RFQ-YYYY-   rfqs.rfq_number  (year-scoped counter)
 *   seq_item       ITEM0001    inventory_items.item_code
 *   seq_rmi        RMI0001     rm_issues.issue_number
 *
 *  Helpdesk / CRM
 *   seq_tkt        TKT-0001    support_tickets.ticket_number
 *   seq_cmp        CMP-YYYY-   complaints.complaint_number  (year-scoped counter)
 *
 *  Finance parties (CUST/SUPP prefix variant used by parties.repository.js)
 *   seq_party_cust CUST001     parties (customer, CUST prefix)
 *   seq_party_supp SUPP001     parties (supplier, SUPP prefix)
 */

/** Extract trailing digits from a document number, defaulting to 0. */
function extractNum(str, prefix) {
  if (!str) return 0;
  const raw = String(str).replace(prefix, '').replace(/^[-_]/, '').replace(/^\d{4}[-_]/, '');
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

async function safeMax(knex, table, col, prefix) {
  try {
    const r = await knex(table).max(`${col} as m`).first();
    return extractNum(r?.m, prefix);
  } catch (_) {
    return 0;
  }
}

export async function up(knex) {
  // ── helper: create one sequence starting at max(existing)+1 ─────────────────
  async function makeSeq(name, startVal) {
    const start = Math.max(startVal + 1, 1);
    await knex.raw(`CREATE SEQUENCE IF NOT EXISTS ${name} START WITH ${start} INCREMENT BY 1 NO CYCLE`);
  }

  // ── sample current maxima ────────────────────────────────────────────────────
  const [
    maxEcn, maxLc, maxPoProd, maxAmc, maxTr,
    maxSo, maxQt, maxPrj,
    maxInv, maxBill, maxPay, maxRec, maxExp, maxPb, maxJe, maxJeAcct, maxFtkt,
    maxPartyC, maxPartyS, maxPartyV,
    maxPr, maxPoPurch, maxGrn, maxRfq, maxItem, maxRmi,
    maxTkt, maxCmp,
    maxPartyCust, maxPartySupp,
  ] = await Promise.all([
    safeMax(knex, 'engineering_changes',    'ecn_number',          'ECN-'),
    safeMax(knex, 'lifecycle_instances',    'lifecycle_number',    'LC-'),
    safeMax(knex, 'production_orders',      'production_order_no', 'PO-'),
    safeMax(knex, 'amc_contracts',          'contract_number',     'AMC-'),
    safeMax(knex, 'test_runs',              'run_number',          'TR-'),

    safeMax(knex, 'sales_orders',           'order_number',        'SO-'),
    safeMax(knex, 'quotations',             'quotation_number',    'QT-'),
    safeMax(knex, 'projects',               'project_code',        'PRJ-'),

    safeMax(knex, 'invoices',               'invoice_number',      'INV'),
    safeMax(knex, 'bills',                  'bill_number',         'BILL'),
    safeMax(knex, 'payments',               'payment_number',      'PAY'),
    safeMax(knex, 'receipts',               'receipt_number',      'REC'),
    safeMax(knex, 'expense_claims',         'claim_number',        'EXP'),
    safeMax(knex, 'payment_batches',        'batch_number',        'PB'),
    safeMax(knex, 'journal_entries',        'entry_number',        'JE'),
    safeMax(knex, 'journal_entries',        'entry_number',        'JE-'),
    safeMax(knex, 'tickets',                'ticket_number',       'TKT'),

    // parties by type prefix
    (async () => {
      try {
        const r = await knex('parties').where('party_type', 'customer').max('party_code as m').first();
        return extractNum(r?.m, 'C');
      } catch (_) { return 0; }
    })(),
    (async () => {
      try {
        const r = await knex('parties').where('party_type', 'supplier').max('party_code as m').first();
        return extractNum(r?.m, 'S');
      } catch (_) { return 0; }
    })(),
    (async () => {
      try {
        const r = await knex('parties').where('party_type', 'vendor').max('party_code as m').first();
        return extractNum(r?.m, 'V');
      } catch (_) { return 0; }
    })(),

    safeMax(knex, 'purchase_requests',      'request_number',      'PR'),
    safeMax(knex, 'purchase_orders',        'po_number',           'PO'),
    safeMax(knex, 'goods_receipts',         'grn_number',          'GRN'),
    safeMax(knex, 'rfqs',                   'rfq_number',          'RFQ-'),
    safeMax(knex, 'inventory_items',        'item_code',           'ITEM'),
    safeMax(knex, 'rm_issues',              'issue_number',        'RMI'),

    safeMax(knex, 'support_tickets',        'ticket_number',       'TKT-'),
    safeMax(knex, 'complaints',             'complaint_number',    'CMP-'),

    // CUST / SUPP party codes used by parties.repository.js
    (async () => {
      try {
        const r = await knex('parties').where('party_code', 'like', 'CUST%').max('party_code as m').first();
        return extractNum(r?.m, 'CUST');
      } catch (_) { return 0; }
    })(),
    (async () => {
      try {
        const r = await knex('parties').where('party_code', 'like', 'SUPP%').max('party_code as m').first();
        return extractNum(r?.m, 'SUPP');
      } catch (_) { return 0; }
    })(),
  ]);

  // ── create all sequences ─────────────────────────────────────────────────────
  await makeSeq('seq_ecn',       maxEcn);
  await makeSeq('seq_lc',        maxLc);
  await makeSeq('seq_po_prod',   maxPoProd);
  await makeSeq('seq_amc',       maxAmc);
  await makeSeq('seq_tr',        maxTr);

  await makeSeq('seq_so',        maxSo);
  await makeSeq('seq_qt',        maxQt);
  await makeSeq('seq_prj',       maxPrj);

  await makeSeq('seq_inv',       maxInv);
  await makeSeq('seq_bill',      maxBill);
  await makeSeq('seq_pay',       maxPay);
  await makeSeq('seq_rec',       maxRec);
  await makeSeq('seq_exp',       maxExp);
  await makeSeq('seq_pb',        maxPb);
  await makeSeq('seq_je',        maxJe);
  await makeSeq('seq_je_acct',   maxJeAcct);
  await makeSeq('seq_ftkt',      maxFtkt);

  await makeSeq('seq_party_c',   maxPartyC);
  await makeSeq('seq_party_s',   maxPartyS);
  await makeSeq('seq_party_v',   maxPartyV);

  await makeSeq('seq_pr',        maxPr);
  await makeSeq('seq_po_purch',  maxPoPurch);
  await makeSeq('seq_grn',       maxGrn);
  await makeSeq('seq_rfq',       maxRfq);
  await makeSeq('seq_item',      maxItem);
  await makeSeq('seq_rmi',       maxRmi);

  await makeSeq('seq_tkt',        maxTkt);
  await makeSeq('seq_cmp',        maxCmp);
  await makeSeq('seq_party_cust', maxPartyCust);
  await makeSeq('seq_party_supp', maxPartySupp);
}

export async function down(knex) {
  const seqs = [
    'seq_ecn','seq_lc','seq_po_prod','seq_amc','seq_tr',
    'seq_so','seq_qt','seq_prj',
    'seq_inv','seq_bill','seq_pay','seq_rec','seq_exp','seq_pb','seq_je','seq_je_acct','seq_ftkt',
    'seq_party_c','seq_party_s','seq_party_v',
    'seq_pr','seq_po_purch','seq_grn','seq_rfq','seq_item','seq_rmi',
    'seq_tkt','seq_cmp',
    'seq_party_cust','seq_party_supp',
  ];
  for (const s of seqs) {
    await knex.raw(`DROP SEQUENCE IF EXISTS ${s}`);
  }
}
