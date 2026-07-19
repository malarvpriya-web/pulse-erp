import pool from '../db.js';
import invoiceRepo from '../repositories/invoice.repository.js';
import journalRepo from '../repositories/journal.repository.js';
import cogsService from './cogsJournal.service.js';
import { detectGSTFromGSTIN, detectGSTFromState, validateGstSplit } from '../../../utils/gst.js';

class InvoiceService {
  async createInvoice(data, userId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const invoiceNumber = await invoiceRepo.getNextNumber();

      // ── Derive GST heads server-side ────────────────────────────────────────
      // Intra-state (same state as company/Karnataka) → CGST + SGST (equal halves);
      // inter-state → IGST. If the client already supplied a split we keep it but
      // still validate consistency. Prevents client-side GST misclassification.
      const taxAmount = parseFloat(data.tax_amount || 0);
      let cgst = parseFloat(data.cgst) || 0;
      let sgst = parseFloat(data.sgst) || 0;
      let igst = parseFloat(data.igst) || 0;
      const cess = parseFloat(data.cess) || 0;
      let placeOfSupply = data.place_of_supply || null;

      if (taxAmount > 0 && cgst === 0 && sgst === 0 && igst === 0) {
        let gstin = data.party_gstin || null;
        const partyRef = data.party_id || data.customer_id || null;
        if ((!gstin || !placeOfSupply) && partyRef) {
          // party_id may be UUID or int depending on install — degrade gracefully.
          const { rows } = await client.query(
            'SELECT gstin, state FROM parties WHERE id = $1', [partyRef]
          ).catch(() => ({ rows: [] }));
          gstin = gstin || rows[0]?.gstin || null;
          placeOfSupply = placeOfSupply || rows[0]?.state || null;
        }
        const gstType = gstin ? detectGSTFromGSTIN(gstin) : detectGSTFromState(placeOfSupply);
        if (gstType === 'IGST') {
          igst = taxAmount;
        } else {
          cgst = Math.round((taxAmount / 2) * 100) / 100;
          sgst = Math.round((taxAmount - cgst) * 100) / 100; // remainder avoids paisa drift
        }
      }

      const gstCheck = validateGstSplit({ cgst, sgst, igst });
      if (!gstCheck.valid) {
        throw Object.assign(new Error(gstCheck.error), { status: 422 });
      }

      const invoice = await invoiceRepo.create(client, {
        ...data,
        invoice_number: invoiceNumber,
        created_by: userId,
        company_id: data.company_id ?? null,
        cgst, sgst, igst, cess, place_of_supply: placeOfSupply,
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

      // DR: Accounts Receivable (full invoice amount)
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_code: '1010',
        description: `Invoice ${invoiceNumber}`,
        debit: invoice.total_amount,
        credit: 0
      });

      // CR: Sales Revenue (taxable value only)
      await journalRepo.createLine(client, {
        journal_entry_id: journalEntry.id,
        account_code: data.revenue_account_code || '4001',
        description: `Revenue — Invoice ${invoiceNumber}`,
        debit: 0,
        credit: invoice.subtotal
      });

      // CR: GST payable — split by head (persisted on the invoice above).
      const jCgst = parseFloat(invoice.cgst || 0);
      const jSgst = parseFloat(invoice.sgst || 0);
      const jIgst = parseFloat(invoice.igst || 0);

      if (jCgst > 0) {
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_code: '2010',
          description: `CGST — Invoice ${invoiceNumber}`,
          debit: 0,
          credit: jCgst
        });
      }
      if (jSgst > 0) {
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_code: '2011',
          description: `SGST — Invoice ${invoiceNumber}`,
          debit: 0,
          credit: jSgst
        });
      }
      if (jIgst > 0) {
        await journalRepo.createLine(client, {
          journal_entry_id: journalEntry.id,
          account_code: '2012',
          description: `IGST — Invoice ${invoiceNumber}`,
          debit: 0,
          credit: jIgst
        });
      }

      await journalRepo.postEntry(client, journalEntry.id);
      await invoiceRepo.linkJournalEntry(client, invoice.id, journalEntry.id);
      await invoiceRepo.updateStatus(client, invoice.id, 'Sent');

      // COGS entry: only generated when invoice items carry item_id and unit_cost
      // (physical goods dispatch). Service invoices without inventory items are skipped.
      await cogsService.createForInvoice(client, {
        invoice_id:     invoice.id,
        invoice_number: invoiceNumber,
        dispatch_date:  data.invoice_date,
        items:          data.items,
        created_by:     userId,
      });

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

  async getInvoiceById(id, companyId = null) {
    const invoice = await invoiceRepo.findById(id, companyId);
    if (invoice) {
      invoice.items = await invoiceRepo.getItems(id);
    }
    return invoice;
  }

  async getOverdueInvoices(companyId = null) {
    return await invoiceRepo.getOverdue(companyId);
  }

  async getDueSoonInvoices(days = 7, companyId = null) {
    return await invoiceRepo.getDueSoon(days, companyId);
  }
}

export default new InvoiceService();
