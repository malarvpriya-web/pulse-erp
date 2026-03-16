import pool from '../db.js';
import billRepo from '../repositories/bill.repository.js';
import { paymentRepository } from '../repositories/payment.repository.js';
import journalRepo from '../repositories/journal.repository.js';

class BillService {
  async createBill(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const billNumber = await billRepo.getNextNumber();
      const bill = await billRepo.create(client, {
        ...data,
        bill_number: billNumber,
        created_by: userId
      });

      for (const item of data.items) {
        await billRepo.createItem(client, {
          bill_id: bill.id,
          ...item
        });
      }

      await client.query('COMMIT');
      return await billRepo.findById(bill.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async approveBill(id, userId, accountData) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const bill = await billRepo.approve(client, id, userId);

      // Create journal entry
      const entryNumber = await journalRepo.getNextEntryNumber();
      const journalEntry = await journalRepo.createEntry(client, {
        entry_number: entryNumber,
        entry_date: bill.bill_date,
        entry_type: 'Bill',
        reference_type: 'bill',
        reference_id: bill.id,
        description: `Bill ${bill.bill_number}`,
        created_by: userId
      });

      // Debit: Expense Account
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_id: accountData.expense_account_id,
        description: `Bill ${bill.bill_number}`,
        debit: bill.subtotal,
        credit: 0
      });

      // Debit: Tax (if applicable)
      if (bill.tax_amount > 0) {
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_id: accountData.tax_account_id,
          description: `Tax on Bill ${bill.bill_number}`,
          debit: bill.tax_amount,
          credit: 0
        });
      }

      // Credit: Accounts Payable
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_id: accountData.accounts_payable_id,
        description: `Bill ${bill.bill_number}`,
        debit: 0,
        credit: bill.total_amount
      });

      await journalRepo.postEntry(client, journalEntry.id);
      await billRepo.linkJournalEntry(client, bill.id, journalEntry.id);

      await client.query('COMMIT');
      return await billRepo.findById(bill.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getBills(filters) {
    return await billRepo.findAll(filters);
  }

  async getBillById(id) {
    const bill = await billRepo.findById(id);
    if (bill) {
      bill.items = await billRepo.getItems(id);
    }
    return bill;
  }

  async getDueSoonBills(days = 7) {
    return await billRepo.getDueSoon(days);
  }
}

class PaymentService {
  async createPayment(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const paymentNumber = await paymentRepository.getNextNumber();
      const payment = await paymentRepository.create(client, {
        ...data,
        payment_number: paymentNumber,
        created_by: userId
      });

      // Allocate to bills
      let remainingAmount = data.amount;
      for (const allocation of data.allocations || []) {
        if (remainingAmount <= 0) break;
        
        const allocAmount = Math.min(allocation.amount, remainingAmount);
        await paymentRepository.createAllocation(client, {
          payment_id: payment.id,
          bill_id: allocation.bill_id,
          allocated_amount: allocAmount
        });

        await billRepo.updatePayment(client, allocation.bill_id, allocAmount);
        remainingAmount -= allocAmount;
      }

      // Create journal entry
      const entryNumber = await journalRepo.getNextEntryNumber();
      const journalEntry = await journalRepo.createEntry(client, {
        entry_number: entryNumber,
        entry_date: data.payment_date,
        entry_type: 'Payment',
        reference_type: 'payment',
        reference_id: payment.id,
        description: `Payment ${paymentNumber}`,
        created_by: userId
      });

      // Debit: Accounts Payable
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_id: data.accounts_payable_id,
        description: `Payment ${paymentNumber}`,
        debit: data.amount,
        credit: 0
      });

      // Credit: Bank/Cash
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_id: data.bank_account_id,
        description: `Payment ${paymentNumber}`,
        debit: 0,
        credit: data.amount
      });

      await journalRepo.postEntry(client, journalEntry.id);
      await paymentRepository.linkJournalEntry(client, payment.id, journalEntry.id);

      await client.query('COMMIT');
      return payment;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getPayments(filters) {
    return await paymentRepository.findAll(filters);
  }
}

export const billService = new BillService();
export const paymentService = new PaymentService();
