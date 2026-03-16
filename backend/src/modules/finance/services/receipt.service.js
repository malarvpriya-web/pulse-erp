import pool from '../db.js';
import { receiptRepository } from '../repositories/payment.repository.js';
import invoiceRepo from '../repositories/invoice.repository.js';
import journalRepo from '../repositories/journal.repository.js';

class ReceiptService {
  async createReceipt(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const receiptNumber = await receiptRepository.getNextNumber();
      const receipt = await receiptRepository.create(client, {
        ...data,
        receipt_number: receiptNumber,
        created_by: userId
      });

      // Allocate to invoices
      let remainingAmount = data.amount;
      for (const allocation of data.allocations) {
        if (remainingAmount <= 0) break;
        
        const allocAmount = Math.min(allocation.amount, remainingAmount);
        await receiptRepository.createAllocation(client, {
          receipt_id: receipt.id,
          invoice_id: allocation.invoice_id,
          allocated_amount: allocAmount
        });

        await invoiceRepo.updatePayment(client, allocation.invoice_id, allocAmount);
        remainingAmount -= allocAmount;
      }

      // Create journal entry
      const entryNumber = await journalRepo.getNextEntryNumber();
      const journalEntry = await journalRepo.createEntry(client, {
        entry_number: entryNumber,
        entry_date: data.receipt_date,
        entry_type: 'Receipt',
        reference_type: 'receipt',
        reference_id: receipt.id,
        description: `Receipt ${receiptNumber}`,
        created_by: userId
      });

      // Debit: Bank/Cash
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_id: data.bank_account_id,
        description: `Receipt ${receiptNumber}`,
        debit: data.amount,
        credit: 0
      });

      // Credit: Accounts Receivable
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_id: data.accounts_receivable_id,
        description: `Receipt ${receiptNumber}`,
        debit: 0,
        credit: data.amount
      });

      await journalRepo.postEntry(client, journalEntry.id);
      await receiptRepository.linkJournalEntry(client, receipt.id, journalEntry.id);

      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getReceipts(filters) {
    return await receiptRepository.findAll(filters);
  }
}

export default new ReceiptService();
