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
        created_by: userId
      });

      for (const item of data.items) {
        await paymentBatchRepo.addItem(client, {
          batch_id: batch.id,
          ...item
        });
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

  async approveBatch(batchId, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const batch = await paymentBatchRepo.findById(batchId);
      if (batch.status !== 'Awaiting_Approval') {
        throw new Error('Batch is not awaiting approval');
      }

      await paymentBatchRepo.updateStatus(client, batchId, 'Approved', userId);

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
      if (batch.status !== 'Approved') {
        throw new Error('Batch must be approved before processing');
      }

      await paymentBatchRepo.updateStatus(client, batchId, 'Processing');

      const items = await paymentBatchRepo.getItems(batchId);

      for (const item of items) {
        // Create payment record
        const paymentNumber = await paymentRepository.getNextNumber();
        const payment = await paymentRepository.create(client, {
          payment_number: paymentNumber,
          payment_date: batch.batch_date,
          payment_type: 'Supplier',
          party_id: item.party_id,
          amount: item.amount,
          payment_method: item.payment_method,
          reference_number: item.reference_number,
          notes: item.notes,
          created_by: batch.created_by
        });

        // Allocate to bill if specified
        if (item.bill_id) {
          await paymentRepository.createAllocation(client, {
            payment_id: payment.id,
            bill_id: item.bill_id,
            allocated_amount: item.amount
          });

          await billRepo.updatePayment(client, item.bill_id, item.amount);
        }

        // Create journal entry
        const entryNumber = await journalRepo.getNextEntryNumber();
        const journalEntry = await journalRepo.createEntry(client, {
          entry_number: entryNumber,
          entry_date: batch.batch_date,
          entry_type: 'Payment',
          reference_type: 'payment',
          reference_id: payment.id,
          description: `Payment ${paymentNumber} - Batch ${batch.batch_number}`,
          created_by: batch.created_by
        });

        // Debit: Accounts Payable
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_id: accountData.accounts_payable_id,
          description: `Payment ${paymentNumber}`,
          debit: item.amount,
          credit: 0
        });

        // Credit: Bank Account
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_id: accountData.bank_account_chart_id,
          description: `Payment ${paymentNumber}`,
          debit: 0,
          credit: item.amount
        });

        await journalRepo.postEntry(client, journalEntry.id);
        await paymentRepository.linkJournalEntry(client, payment.id, journalEntry.id);

        // Create bank transaction
        await bankAccountRepo.createTransaction(client, {
          bank_account_id: batch.bank_account_id,
          transaction_date: batch.batch_date,
          transaction_type: 'Debit',
          amount: item.amount,
          reference_number: paymentNumber,
          description: `Payment to ${item.party_name}`,
          journal_entry_id: journalEntry.id
        });

        // Link payment to batch item
        await paymentBatchRepo.linkPayment(client, item.id, payment.id);
      }

      await paymentBatchRepo.updateStatus(client, batchId, 'Completed');

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
    return await paymentBatchRepo.findAll(filters);
  }

  async getBatchById(id) {
    const batch = await paymentBatchRepo.findById(id);
    if (batch) {
      batch.items = await paymentBatchRepo.getItems(id);
    }
    return batch;
  }

  async submitForApproval(batchId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await paymentBatchRepo.updateStatus(client, batchId, 'Awaiting_Approval');
      await client.query('COMMIT');
      return await paymentBatchRepo.findById(batchId);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export default new PaymentBatchService();
