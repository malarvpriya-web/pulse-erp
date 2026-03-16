import pool from '../db.js';
import invoiceRepo from '../repositories/invoice.repository.js';
import journalRepo from '../repositories/journal.repository.js';

class InvoiceService {
  async createInvoice(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const invoiceNumber = await invoiceRepo.getNextNumber();
      const invoice = await invoiceRepo.create(client, {
        ...data,
        invoice_number: invoiceNumber,
        created_by: userId
      });

      for (const item of data.items) {
        await invoiceRepo.createItem(client, {
          invoice_id: invoice.id,
          ...item
        });
      }

      // Create journal entry
      const entryNumber = await journalRepo.getNextEntryNumber();
      const journalEntry = await journalRepo.createEntry(client, {
        entry_number: entryNumber,
        entry_date: data.invoice_date,
        entry_type: 'Invoice',
        reference_type: 'invoice',
        reference_id: invoice.id,
        description: `Invoice ${invoiceNumber}`,
        created_by: userId
      });

      // Debit: Accounts Receivable
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_id: data.accounts_receivable_id,
        description: `Invoice ${invoiceNumber}`,
        debit: invoice.total_amount,
        credit: 0
      });

      // Credit: Sales Revenue
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_id: data.revenue_account_id,
        description: `Invoice ${invoiceNumber}`,
        debit: 0,
        credit: invoice.subtotal
      });

      // Credit: Tax Payable (if applicable)
      if (invoice.tax_amount > 0) {
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_id: data.tax_account_id,
          description: `Tax on Invoice ${invoiceNumber}`,
          debit: 0,
          credit: invoice.tax_amount
        });
      }

      await journalRepo.postEntry(client, journalEntry.id);
      await invoiceRepo.linkJournalEntry(client, invoice.id, journalEntry.id);
      await invoiceRepo.updateStatus(client, invoice.id, 'Sent');

      await client.query('COMMIT');
      return await invoiceRepo.findById(invoice.id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getInvoices(filters) {
    return await invoiceRepo.findAll(filters);
  }

  async getInvoiceById(id) {
    const invoice = await invoiceRepo.findById(id);
    if (invoice) {
      invoice.items = await invoiceRepo.getItems(id);
    }
    return invoice;
  }

  async getOverdueInvoices() {
    return await invoiceRepo.getOverdue();
  }

  async getDueSoonInvoices(days = 7) {
    return await invoiceRepo.getDueSoon(days);
  }
}

export default new InvoiceService();
