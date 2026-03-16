import invoiceService from '../services/invoice.service.js';

class InvoiceController {
  async create(req, res) {
    try {
      const invoice = await invoiceService.createInvoice(req.body, req.user.id);
      res.status(201).json(invoice);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getAll(req, res) {
    try {
      const invoices = await invoiceService.getInvoices(req.query);
      res.json(invoices);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getById(req, res) {
    try {
      const invoice = await invoiceService.getInvoiceById(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: 'Invoice not found' });
      }
      res.json(invoice);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getOverdue(req, res) {
    try {
      const invoices = await invoiceService.getOverdueInvoices();
      res.json(invoices);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getDueSoon(req, res) {
    try {
      const days = parseInt(req.query.days) || 7;
      const invoices = await invoiceService.getDueSoonInvoices(days);
      res.json(invoices);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
}

export default new InvoiceController();
