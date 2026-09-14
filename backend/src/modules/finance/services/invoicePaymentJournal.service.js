/**
 * invoicePaymentJournal.service.js
 *
 * Posts a double-entry GL journal (DR 1001 Cash/Bank, CR 1002 Accounts
 * Receivable) for an invoice payment. Reuses the same 1001/1002 pair and
 * journal_lines ledger that accounting.routes.js's manual
 * POST /auto-entries/from-payment/:paymentId and the Receipts screen
 * (receipt.service.js) already post through.
 *
 * Previously only the formal Receipts screen posted a journal entry at all —
 * PATCH /invoices/:id/mark-paid (finance.routes.js), PATCH /payments/mark-paid
 * (manual cash/cheque override), and POST /payments/verify (Razorpay webhook)
 * all flipped an invoice to 'paid' with no journal entry, so cash/bank and AR
 * balances silently drifted from what Finance actually collected. All three
 * now call this helper inside the same transaction as their invoice update.
 */

import journalRepo from '../repositories/journal.repository.js';

const CASH_ACCOUNT_CODE = '1001';
const AR_ACCOUNT_CODE = '1002';

export async function postInvoicePaymentJournal(client, {
  paymentTransactionId, invoiceId, invoiceNumber, amount, paymentDate,
  paymentMode = 'payment', companyId = null, userId = null,
}) {
  if (!paymentTransactionId || !invoiceId) {
    throw new Error('paymentTransactionId and invoiceId are required');
  }
  const amt = parseFloat(amount || 0);
  if (amt <= 0) {
    return { skipped: true, reason: 'Payment amount must be greater than zero' };
  }

  // Idempotent — a transaction already posted (e.g. a retried webhook) is left alone.
  const { rows: existing } = await client.query(
    `SELECT id FROM journal_entries WHERE reference_type = 'payment_transaction' AND reference_id = $1`,
    [String(paymentTransactionId)]
  );
  if (existing.length > 0) {
    return { skipped: true, reason: 'already_posted', journal_entry_id: existing[0].id };
  }

  const { rows: accts } = await client.query(
    `SELECT id, code, name FROM chart_of_accounts WHERE code IN ($1,$2) AND is_active = true`,
    [CASH_ACCOUNT_CODE, AR_ACCOUNT_CODE]
  );
  const am = accts.reduce((m, a) => { m[a.code] = a; return m; }, {});
  if (!am[CASH_ACCOUNT_CODE] || !am[AR_ACCOUNT_CODE]) {
    return { skipped: true, reason: `Required accounts ${CASH_ACCOUNT_CODE} (Cash/Bank) and ${AR_ACCOUNT_CODE} (Accounts Receivable) not found in COA` };
  }

  const label = invoiceNumber || invoiceId;
  const entryNumber = await journalRepo.getNextEntryNumber(client);
  const entry = await journalRepo.createEntry(client, {
    entry_number: entryNumber,
    entry_date: paymentDate || new Date().toISOString().split('T')[0],
    entry_type: 'Payment',
    reference_type: 'payment_transaction',
    reference_id: String(paymentTransactionId),
    description: `Invoice payment (${paymentMode}) — ${label}`,
    created_by: userId,
  });

  await journalRepo.createLine(client, {
    journal_entry_id: entry.id,
    account_code: CASH_ACCOUNT_CODE,
    description: `Payment received — invoice ${label}`,
    debit: amt, credit: 0,
    company_id: companyId,
  });
  await journalRepo.createLine(client, {
    journal_entry_id: entry.id,
    account_code: AR_ACCOUNT_CODE,
    description: `Accounts Receivable cleared — invoice ${label}`,
    debit: 0, credit: amt,
    company_id: companyId,
  });

  const posted = await journalRepo.postEntry(client, entry.id);
  return { success: true, journal_entry_id: posted.id, entry_number: entryNumber };
}
