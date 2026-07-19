import pool from '../db.js';
import paymentBatchRepo from '../repositories/paymentBatch.repository.js';
import { paymentRepository } from '../repositories/payment.repository.js';
import billRepo from '../repositories/bill.repository.js';
import bankAccountRepo from '../repositories/bankAccount.repository.js';
import journalRepo from '../repositories/journal.repository.js';

class PaymentBatchService {
  async createBatch(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batchNumber = await paymentBatchRepo.getNextBatchNumber();
      const batch = await paymentBatchRepo.create({
        ...data,
        batch_number: batchNumber,
        created_by: userId,
        status: data.status || 'draft',
      });

      const items = data.items || [];
      for (const item of items) {
        await paymentBatchRepo.addItem(client, {
          batch_id: batch.id,
          company_id: data.company_id || null,
          party_id: item.supplier_id || item.party_id || null,
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

  async submitForApproval(batchId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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

  async approveBatch(batchId, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batch = await paymentBatchRepo.findById(batchId);
      if (!batch) throw new Error('Batch not found');
      if (batch.status !== 'pending_approval') {
        throw new Error('Batch is not awaiting approval');
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

  async rejectBatch(batchId, userId, reason = '') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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

  async processBatch(batchId, accountData) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batch = await paymentBatchRepo.findById(batchId);
      if (!batch) throw new Error('Batch not found');
      if (batch.status !== 'approved') {
        throw new Error('Batch must be approved before processing');
      }

      const items = await paymentBatchRepo.getItems(batchId);

      for (const item of items) {
        const paymentNumber = await paymentRepository.getNextNumber();
        const payment = await paymentRepository.create(client, {
          payment_number: paymentNumber,
          payment_date: batch.batch_date || new Date().toISOString().split('T')[0],
          payment_type: 'Supplier',
          party_id: item.party_id,
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

        // Journal entry: Dr AP / Cr Bank
        if (accountData?.accounts_payable_id && accountData?.bank_account_chart_id) {
          const entryNumber = await journalRepo.getNextEntryNumber();
          const journalEntry = await journalRepo.createEntry(client, {
            entry_number: entryNumber,
            entry_date: batch.batch_date,
            entry_type: 'Payment',
            reference_type: 'payment',
            reference_id: payment.id,
            description: `Payment Batch ${batch.batch_number} — ${item.supplier || item.supplier_name || ''}`,
            company_id: batch.company_id,
            created_by: batch.created_by,
          });

          await journalRepo.createLine(client, {
            journal_entry_id: journalEntry.id,
            account_id: accountData.accounts_payable_id,
            description: `Payment ${paymentNumber}`,
            debit: item.amount,
            credit: 0,
          });
          await journalRepo.createLine(client, {
            journal_entry_id: journalEntry.id,
            account_id: accountData.bank_account_chart_id,
            description: `Payment ${paymentNumber}`,
            debit: 0,
            credit: item.amount,
          });

          await journalRepo.postEntry(client, journalEntry.id);
          await paymentRepository.linkJournalEntry(client, payment.id, journalEntry.id);
        }

        if (batch.bank_account_id) {
          await bankAccountRepo.createTransaction(client, {
            bank_account_id: batch.bank_account_id,
            transaction_date: batch.batch_date,
            transaction_type: 'Debit',
            amount: item.amount,
            reference_number: paymentNumber,
            description: `Payment to ${item.supplier || item.supplier_name || ''}`,
            journal_entry_id: null,
          });
        }

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

  async getBatchById(id) {
    const batch = await paymentBatchRepo.findById(id);
    if (batch) {
      batch.items = await paymentBatchRepo.getItems(id);
    }
    return batch;
  }

  async getBankFileData(batchId) {
    const batch = await paymentBatchRepo.findById(batchId);
    if (!batch) throw new Error('Batch not found');
    const items = await paymentBatchRepo.getItemsWithBankDetails(batchId);
    return { batch, items };
  }
}

export default new PaymentBatchService();
