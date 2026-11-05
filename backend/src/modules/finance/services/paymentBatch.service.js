import pool from '../db.js';
import paymentBatchRepo from '../repositories/paymentBatch.repository.js';
import { paymentRepository } from '../repositories/payment.repository.js';
import billRepo from '../repositories/bill.repository.js';
import bankAccountRepo from '../repositories/bankAccount.repository.js';
import journalRepo from '../repositories/journal.repository.js';
import { getPaymentGlMapping } from './paymentGlMapping.service.js';
import { vendorPartyId } from '../../procurement/services/vendorIdentity.service.js';
import { BANK_FILE_FORMATS, renderBankFile, sha256Of, toPaise, fromPaise } from './bankFileFormat.js';

/**
 * Lock one batch inside the caller's company for a status transition.
 * Every transition used to read the batch through the pool with no company
 * predicate and no lock: a finance user in another company could approve,
 * reject or PROCESS (i.e. pay) a batch by id; reject and submit had no state
 * check at all (a processed batch could be rejected, or pushed back to
 * pending_approval and processed — paid — a second time); and two concurrent
 * process calls both read 'approved' and both paid. A batch in another company
 * is reported exactly like a missing one.
 */
async function lockBatch(client, batchId, companyId) {
  if (!/^\d+$/.test(String(batchId))) throw httpErr(404, 'Batch not found');
  const { rows } = await client.query(
    `SELECT * FROM payment_batches
      WHERE id = $1 AND ($2::int IS NULL OR company_id = $2)
      FOR UPDATE`,
    [batchId, companyId ?? null]
  );
  if (!rows.length) throw httpErr(404, 'Batch not found');
  return rows[0];
}
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Active logins in the batch's company, other than its creator, holding
// finance:approve (user-level grant first, else any role grant — the order
// permissionFor() uses). For the self-approval message only.
async function countIndependentApprovers(client, batch) {
  const { rows: [r] } = await client.query(
    `SELECT COUNT(DISTINCT u.id)::int AS n
       FROM users u LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.is_active = TRUE AND u.id <> $2
        AND COALESCE(e.company_id, u.company_id) = $1
        AND (EXISTS (SELECT 1 FROM permissions p WHERE p.user_id = u.id AND p.module = 'finance' AND p.can_approve)
             OR (NOT EXISTS (SELECT 1 FROM permissions p WHERE p.user_id = u.id AND p.module = 'finance')
                 AND EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                              WHERE ur.user_id = u.id AND rp.module = 'finance' AND rp.can_approve)))`,
    [batch.company_id, batch.created_by]
  );
  return r?.n ?? 0;
}

const coded = (status, code, message, extra = {}) => Object.assign(httpErr(status, message), { code, ...extra });

// The paying bank account: the batch's company's, active, not deleted — held for
// the transaction so it cannot be deleted or re-assigned meanwhile.
async function assertPayingBank(client, batch) {
  if (batch.company_id == null) {
    throw coded(422, 'BATCH_COMPANY_REQUIRED', 'This batch has no company, so its accounts cannot be resolved');
  }
  if (!batch.bank_account_id) {
    throw coded(422, 'BANK_ACCOUNT_REQUIRED', 'Choose the bank account this batch is paid from before processing');
  }
  const { rows: [bank] } = await client.query(
    `SELECT id FROM bank_accounts WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL AND is_active = true FOR UPDATE`,
    [batch.bank_account_id, batch.company_id]);
  if (!bank) throw coded(422, 'BANK_ACCOUNT_INVALID', 'The batch\'s bank account is not an active bank account of this company');
}

const ACCOUNT_RE = /^\d{9,18}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const VENDOR_BLOCKED = new Set(['inactive', 'blocked', 'blacklisted', 'suspended', 'rejected']);

/**
 * The bank detail a vendor is paid to, from its Finance-verified records in the
 * batch's company (B4-1). The vendor's primary account when it has one: a new
 * unverified primary refuses the line instead of silently paying the older
 * account. With no primary, the single verified account; several is ambiguous.
 * Returns { detail } or { reason }. The reasons never carry an account number.
 */
function chooseVerifiedDetail(details) {
  const verified = details.filter(d => d.finance_verified === true);
  const primaries = details.filter(d => d.is_primary === true);
  if (!verified.length) return { reason: 'No Finance-verified bank detail in this company' };
  if (primaries.length > 1) return { reason: 'More than one primary bank detail' };
  if (primaries.length === 1) {
    return primaries[0].finance_verified === true
      ? { detail: primaries[0] }
      : { reason: 'The primary bank detail is not Finance-verified' };
  }
  if (verified.length > 1) return { reason: 'Several verified bank details and none is primary' };
  return { detail: verified[0] };
}

/**
 * Validate every line against the batch company's vendor and verified bank
 * records and build the beneficiary snapshot. The vendor rows and bank details
 * are held FOR SHARE so verification cannot change under the release.
 */
async function buildBeneficiarySnapshot(client, batch, items) {
  const problems = [];
  const lines = [];
  for (const item of items) {
    const label = item.supplier || item.supplier_name || `Line ${item.id}`;
    const refuse = (reason) => problems.push({ item_id: item.id, supplier: label, reason });
    const paise = toPaise(item.amount);
    if (!paise) { refuse('The amount must be greater than zero, to two decimals'); continue; }
    if (item.payment_id) { refuse('The line already carries a payment'); continue; }
    if (item.company_id != null && Number(item.company_id) !== Number(batch.company_id)) { refuse('The line belongs to another company'); continue; }
    if (!item.supplier_id) { refuse('The line has no supplier'); continue; }
    const { rows: [vendor] } = await client.query(
      `SELECT * FROM vendors WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL FOR SHARE`,
      [item.supplier_id, batch.company_id]);
    if (!vendor) { refuse('The supplier is not a vendor of this company'); continue; }
    if ([vendor.status, vendor.classification].some(s => VENDOR_BLOCKED.has(String(s ?? '').toLowerCase()))) {
      refuse('The vendor is inactive or blocked'); continue;
    }
    const { rows: details } = await client.query(
      `SELECT * FROM vendor_bank_details WHERE vendor_id = $1 AND company_id = $2 ORDER BY id FOR SHARE`,
      [vendor.id, batch.company_id]);
    const { detail, reason } = chooseVerifiedDetail(details);
    if (!detail) { refuse(reason); continue; }
    const account = String(detail.account_number ?? '').trim();
    const ifsc = String(detail.ifsc ?? '').trim().toUpperCase();
    if (!ACCOUNT_RE.test(account)) { refuse('The verified account number is not 9 to 18 digits'); continue; }
    if (!IFSC_RE.test(ifsc)) { refuse('The verified IFSC is not valid'); continue; }
    lines.push({
      item_id: item.id,
      supplier_id: vendor.id,
      beneficiary_name: vendor.vendor_name || vendor.name,
      vendor_bank_detail_id: detail.id,
      finance_verified_by: detail.finance_verified_by ?? null,
      finance_verified_at: detail.finance_verified_at ?? null,
      bank_name: detail.bank_name ?? null,
      account_number: account,
      ifsc,
      amount: fromPaise(paise),
      payment_method: item.payment_method || null,
      bill_id: item.bill_id ?? null,
      bill_ref: item.bill_ref ?? null,
    });
  }
  return { problems, lines };
}

const fileMeta = (f) => ({
  format: f.format, file_name: f.file_name, sha256: f.sha256, line_count: f.line_count,
  total_amount: f.total_amount, released_at: f.released_at, released_by: f.released_by,
});

// Written on the caller's transaction, so the event and what it records stand or
// fall together. Metadata only: never an account number.
async function auditBankFile(client, action, batch, file, ctx) {
  await client.query(
    `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, new_data_json, ip_address, user_agent, company_id)
     VALUES ($1, 'finance', $2, $3, 'payment_batch', $4, $5, $6, $7)`,
    [ctx.userId, action, String(batch.id),
     JSON.stringify({ batch_number: batch.batch_number, format: file.format, file_name: file.file_name, sha256: file.sha256, line_count: file.line_count, total_amount: file.total_amount }),
     ctx.ip ?? null, ctx.userAgent ?? null, batch.company_id]);
}

/**
 * Processing pays what was released, exactly (B4-4): the stored bytes match their
 * hash and their snapshot, and the snapshot's lines are this batch's lines, id
 * for id and amount for amount, with the batch's count and total.
 */
async function assertReleasedFileMatches(client, batch, items) {
  const { rows: [file] } = await client.query(`SELECT * FROM payment_batch_files WHERE batch_id = $1`, [batch.id]);
  if (!file) throw coded(422, 'FILE_NOT_RELEASED', 'Release the bank file before processing this batch');
  const problems = [];
  if (Number(file.company_id) !== Number(batch.company_id)) problems.push('The file belongs to another company');
  if (sha256Of(file.content) !== file.sha256) problems.push('The stored file does not match its SHA-256');
  const lines = Array.isArray(file.beneficiaries) ? file.beneficiaries : [];
  if (renderBankFile(batch.batch_number, file.format, lines) !== file.content) problems.push('The stored file does not match its beneficiary snapshot');
  if (file.line_count !== items.length || lines.length !== items.length) {
    problems.push(`The file has ${file.line_count} line(s); the batch has ${items.length}`);
  }
  const lineTotal = items.reduce((s, i) => s + (toPaise(i.amount) ?? NaN), 0);
  if (toPaise(file.total_amount) !== lineTotal || toPaise(batch.total_amount) !== lineTotal) {
    problems.push(`The file total ${file.total_amount} and batch total ${batch.total_amount} must equal the batch lines`);
  }
  const byId = new Map(lines.map(l => [Number(l.item_id), l]));
  for (const item of items) {
    const l = byId.get(Number(item.id));
    if (!l) problems.push(`Batch line ${item.id} is not in the released file`);
    else if (toPaise(l.amount) !== toPaise(item.amount) || Number(l.supplier_id) !== Number(item.supplier_id)) {
      problems.push(`Batch line ${item.id} differs from the released file`);
    }
  }
  if (problems.length) {
    throw coded(409, 'FILE_BATCH_MISMATCH', `Processing refused: the released bank file does not match this batch (${problems.join('; ')})`, { problems });
  }
}

class PaymentBatchService {
  async createBatch(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batchNumber = await paymentBatchRepo.getNextBatchNumber(client);
      const batch = await paymentBatchRepo.create({
        ...data,
        batch_number: batchNumber,
        created_by: userId,
        status: data.status || 'draft',
      }, client);

      const items = data.items || [];
      for (const item of items) {
        await paymentBatchRepo.addItem(client, {
          batch_id: batch.id,
          company_id: data.company_id || null,
          supplier_id: item.supplier_id || item.party_id || null,
          supplier_name: item.supplier_name || item.supplier || null,
          bill_id: item.bill_id || null,
          bill_ref: item.bill_ref || null,
          amount: item.amount,
          payment_method: item.method || item.payment_method || 'neft',
          reference_number: item.reference || item.reference_number || null,
          notes: item.notes || null,
        });
      }

      // If submitted directly (not draft), update status
      if (data.status === 'pending_approval') {
        await client.query(
          `UPDATE payment_batches SET status = 'pending_approval', updated_at = NOW() WHERE id = $1`,
          [batch.id]
        );
      }

      await client.query('COMMIT');
      return await paymentBatchRepo.findById(batch.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async submitForApproval(batchId, companyId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await lockBatch(client, batchId, companyId);
      // A draft, or a rejected batch being resubmitted. Never an approved or
      // processed one — that re-opened a paid batch for payment.
      if (!['draft', 'rejected'].includes(batch.status)) {
        throw httpErr(409, `Batch is ${batch.status}; only draft or rejected batches can be submitted`);
      }
      await paymentBatchRepo.updateStatus(client, batchId, 'pending_approval');
      await client.query('COMMIT');
      return await paymentBatchRepo.findById(batchId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async approveBatch(batchId, userId, companyId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batch = await lockBatch(client, batchId, companyId);
      if (batch.status !== 'pending_approval') {
        throw httpErr(409, 'Batch is not awaiting approval');
      }
      // Policy (2026-10-20): maker ≠ checker. created_by and the actor are both
      // users.id taken from the database row and the authenticated session.
      // Thrown before any write, so the batch stays pending_approval, nothing
      // is paid and no approval is recorded.
      if (batch.created_by != null && String(batch.created_by) === String(userId)) {
        const others = await countIndependentApprovers(client, batch);
        throw Object.assign(httpErr(403, others > 0
          ? `You created this batch, so you cannot approve it. It stays pending for another finance approver (${others} eligible in your company).`
          : 'You created this batch, so you cannot approve it, and no other user in your company holds finance approval. '
            + 'It stays pending until an administrator grants finance:approve to a second user.'),
        { code: 'SELF_APPROVAL_BLOCKED', eligible_alternates: others });
      }

      await paymentBatchRepo.updateStatus(client, batchId, 'approved', userId);
      await client.query('COMMIT');
      return await paymentBatchRepo.findById(batchId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectBatch(batchId, userId, reason = '', companyId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await lockBatch(client, batchId, companyId);
      if (batch.status !== 'pending_approval') {
        throw httpErr(409, 'Batch is not awaiting approval');
      }
      await paymentBatchRepo.updateStatus(client, batchId, 'rejected', userId);
      if (reason) {
        await client.query(
          `UPDATE payment_batches SET rejection_reason = $1 WHERE id = $2`,
          [reason, batchId]
        );
      }
      await client.query('COMMIT');
      return await paymentBatchRepo.findById(batchId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Process (pay) an approved batch — PC-02b-0 B-02 (04 Nov 26).
   *
   * ONE transaction holds every write: the payments, the bill allocations and
   * bill balances, a balanced Dr Accounts Payable / Cr Bank journal per payment
   * (through journalRepo.postEntry, so the posting guards apply: balanced lines,
   * usable accounts, lock date, open period), the bank transaction (linked to
   * its journal, and referenced by the payment number) and the processed status. Any refusal or error rolls all of it
   * back and the batch stays approved.
   *
   * The accounts are NEVER taken from the request (they used to be: the Payments
   * screen sent none, so processing wrote payments and bank debits with no
   * journal at all). They come from the company's Finance-approved payment
   * mapping (paymentGlMapping.service.js) for the batch's own bank account,
   * which must belong to the batch's company and be active.
   *
   * Idempotent: the batch row is locked; a second or concurrent call finds it
   * processed (409) and writes nothing; a line already carrying a payment is
   * refused rather than paid again.
   */
  async processBatch(batchId, companyId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Locked: a second concurrent call waits here, then sees 'processed'.
      const batch = await lockBatch(client, batchId, companyId);
      if (batch.status !== 'approved') {
        throw httpErr(409, 'Batch must be approved before processing');
      }
      await assertPayingBank(client, batch);
      const mapping = await getPaymentGlMapping(batch.company_id, client);
      const bankLedger = mapping.bankLedgers?.[String(batch.bank_account_id)];
      if (mapping.status !== 'approved' || !mapping.payable || !bankLedger) {
        const problems = mapping.status === 'approved'
          ? ['The batch\'s bank account has no approved ledger account in the payment mapping']
          : mapping.problems;
        throw Object.assign(httpErr(422, `Processing refused: Finance has not approved the accounts for this payment (${problems.join('; ')})`),
          { code: 'PAYMENT_GL_MAPPING_REQUIRED', problems });
      }

      // An empty batch moves no money and posts nothing; it is marked processed as before.
      const items = await paymentBatchRepo.getItems(batchId, client);
      for (const item of items) {
        if (item.payment_id) {
          throw Object.assign(httpErr(409, 'A line of this batch already carries a payment; it is not paid again'), { code: 'LINE_ALREADY_PAID' });
        }
        if (!(parseFloat(item.amount) > 0)) {
          throw Object.assign(httpErr(422, 'Every payment line needs an amount greater than zero'), { code: 'LINE_AMOUNT_INVALID' });
        }
      }

      await assertReleasedFileMatches(client, batch, items);

      const paymentDate = batch.batch_date || new Date().toISOString().split('T')[0];
      for (const item of items) {
        const paymentNumber = await paymentRepository.getNextNumber(client);
        // payment_batch_items.supplier_id is a vendors.id integer; payments.party_id
        // is a parties.id uuid. The bridge is vendors.party_id — the deterministic
        // key, resolved and bound by procurement's vendorIdentity service. (The
        // name-match fallback this replaced had no company predicate, on the path
        // that MOVES MONEY.)
        let resolvedPartyId = null;
        if (item.supplier_id) {
          resolvedPartyId = await vendorPartyId(client, item.supplier_id);
        }
        const payment = await paymentRepository.create(client, {
          payment_number: paymentNumber,
          payment_date: paymentDate,
          payment_type: 'Supplier',
          party_id: resolvedPartyId,
          amount: item.amount,
          payment_method: item.payment_method || item.method,
          reference_number: item.reference_number,
          notes: item.notes,
          company_id: batch.company_id,
          created_by: batch.created_by,
        });

        if (item.bill_id) {
          await paymentRepository.createAllocation(client, {
            payment_id: payment.id,
            bill_id: item.bill_id,
            allocated_amount: item.amount,
          });
          await billRepo.updatePayment(client, item.bill_id, item.amount);
        }

        // Dr Accounts Payable / Cr Bank — the mapping's accounts, posted through
        // the posting guards; a refusal (locked or closed period, unusable
        // account) rolls the whole batch back.
        let journalEntry;
        try {
          journalEntry = await journalRepo.createEntry(client, {
            entry_number: await journalRepo.getNextEntryNumber(client),
            entry_date: paymentDate,
            entry_type: 'Payment',
            reference_type: 'payment',
            reference_id: payment.id,
            description: `Payment Batch ${batch.batch_number} — ${item.supplier || item.supplier_name || ''}`,
            company_id: batch.company_id,
            created_by: batch.created_by,
          });
          await journalRepo.createLine(client, {
            journal_entry_id: journalEntry.id, account_id: mapping.payable.id,
            description: `Payment ${paymentNumber}`, debit: item.amount, credit: 0, company_id: batch.company_id,
          });
          await journalRepo.createLine(client, {
            journal_entry_id: journalEntry.id, account_id: bankLedger.id,
            description: `Payment ${paymentNumber}`, debit: 0, credit: item.amount, company_id: batch.company_id,
          });
          await journalRepo.postEntry(client, journalEntry.id);
        } catch (jeErr) {
          if (jeErr.status && jeErr.status < 500) {
            throw Object.assign(httpErr(422, `Processing refused: the payment journal could not be posted — ${jeErr.message}`),
              { code: 'PAYMENT_JOURNAL_REFUSED', journal_code: jeErr.code });
          }
          throw jeErr;
        }
        await paymentRepository.linkJournalEntry(client, payment.id, journalEntry.id);

        await bankAccountRepo.createTransaction(client, {
          bank_account_id: batch.bank_account_id,
          transaction_date: paymentDate,
          transaction_type: 'Debit',
          amount: item.amount,
          reference_number: paymentNumber,
          description: `Payment to ${item.supplier || item.supplier_name || ''}`,
          // A uuid FK to journal_entries since migration 20261104000004 (B-03).
          journal_entry_id: journalEntry.id,
        });

        await paymentBatchRepo.linkPayment(client, item.id, payment.id);
      }

      await paymentBatchRepo.updateStatus(client, batchId, 'processed');
      await client.query('COMMIT');
      return await paymentBatchRepo.findById(batchId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getBatches(filters) {
    return paymentBatchRepo.findAll(filters);
  }

  async getBatchById(id, companyId = null) {
    const batch = await paymentBatchRepo.findById(id, companyId);
    if (batch) {
      batch.items = await paymentBatchRepo.getItems(id);
    }
    return batch;
  }

  /**
   * Release the bank file of an approved batch — PC-02b-0 B-04 (04 Nov 26).
   *
   * ONE transaction holds the beneficiary snapshot, the rendered content, its
   * SHA-256, the file row and the audit event: any refusal or error leaves no
   * file and no event. Every line must resolve to a Finance-verified bank detail
   * of the batch's company, or the whole release is refused with every problem
   * listed. A batch releases once; the batch row lock makes a concurrent second
   * call wait and then find the file (409). Void / re-release is B-05.
   */
  async releaseBankFile(batchId, format, companyId, ctx) {
    if (!BANK_FILE_FORMATS.includes(format)) {
      throw coded(400, 'FORMAT_INVALID', `Bank file format must be one of: ${BANK_FILE_FORMATS.join(', ')}`);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await lockBatch(client, batchId, companyId);
      if (batch.status !== 'approved') throw coded(409, 'BATCH_NOT_APPROVED', 'Only an approved batch can release its bank file');
      await assertPayingBank(client, batch);
      const { rows: [existing] } = await client.query(`SELECT id FROM payment_batch_files WHERE batch_id = $1`, [batch.id]);
      if (existing) throw coded(409, 'FILE_ALREADY_RELEASED', 'This batch has already released its bank file; a released file cannot be replaced');

      const items = await paymentBatchRepo.getItems(batch.id, client);
      const { problems, lines } = await buildBeneficiarySnapshot(client, batch, items);
      if (problems.length) {
        throw coded(422, 'BENEFICIARY_INVALID', `Release refused: ${problems.length} line(s) cannot be paid from verified bank details`, { problems });
      }
      const total = lines.reduce((s, l) => s + toPaise(l.amount), 0);
      if (toPaise(batch.total_amount) !== total) {
        throw coded(422, 'BATCH_TOTAL_MISMATCH', `Release refused: the batch total ${batch.total_amount} does not equal its lines (${fromPaise(total)})`);
      }

      const content = renderBankFile(batch.batch_number, format, lines);
      const { rows: [file] } = await client.query(
        `INSERT INTO payment_batch_files
           (batch_id, company_id, format, file_name, content, sha256, line_count, total_amount, beneficiaries, released_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING *`,
        [batch.id, batch.company_id, format, `batch-${batch.batch_number}-${format}.csv`.replace(/[^\w.-]/g, '_'),
         content, sha256Of(content), lines.length, fromPaise(total), JSON.stringify(lines), ctx.userId]);
      await auditBankFile(client, 'BANK_FILE_RELEASED', batch, file, ctx);
      await client.query('COMMIT');
      return fileMeta(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The stored bytes of a released file, after their hash is verified: nothing is
   * ever regenerated. The audit event commits before the bytes are handed over,
   * so a download that cannot be recorded does not happen. A hash failure is
   * itself recorded and serves nothing.
   */
  async downloadBankFile(batchId, format, companyId, ctx) {
    if (!/^\d+$/.test(String(batchId))) throw httpErr(404, 'Batch not found');
    const batch = await paymentBatchRepo.findById(batchId, companyId);
    if (!batch) throw httpErr(404, 'Batch not found');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [file] } = await client.query(
        `SELECT * FROM payment_batch_files WHERE batch_id = $1 AND company_id = $2`, [batch.id, batch.company_id]);
      if (!file) throw coded(409, 'FILE_NOT_RELEASED', 'This batch has no released bank file');
      if (format && format !== file.format) {
        throw coded(409, 'FILE_FORMAT_FIXED', `This batch's bank file was released in the ${file.format} format`);
      }
      if (sha256Of(file.content) !== file.sha256) {
        await auditBankFile(client, 'BANK_FILE_INTEGRITY_FAILED', batch, file, ctx);
        await client.query('COMMIT');
        throw coded(409, 'FILE_INTEGRITY_FAILED', 'The stored bank file does not match its SHA-256, so it was not served');
      }
      await auditBankFile(client, 'BANK_FILE_DOWNLOADED', batch, file, ctx);
      await client.query('COMMIT');
      return { file_name: file.file_name, sha256: file.sha256, bytes: Buffer.from(file.content, 'utf8') };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export default new PaymentBatchService();
