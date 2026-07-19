import invoiceService from '../services/invoice.service.js';
import { evaluateRules } from '../../../services/RuleEngineService.js';
import { logAudit } from '../../../services/AuditService.js';

class InvoiceController {
  async create(req, res) {
    try {
      const invoice = await invoiceService.createInvoice({ ...req.body, company_id: req.scope?.company_id ?? null }, req.user.userId ?? req.user.id);
      logAudit({ userId: req.user?.userId ?? req.user?.id, module: 'finance', recordId: invoice.id, recordType: 'invoice', action: 'create', newData: invoice, req });
      const ruleResults = await evaluateRules('finance', invoice).catch(() => []);
      const ruleAlerts = ruleResults.filter(r => r.triggered);
      res.status(201).json({ ...invoice, ...(ruleAlerts.length ? { rule_alerts: ruleAlerts } : {}) });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  }

  async getAll(req, res) {
    try {
      const invoices = await invoiceService.getInvoices({ ...req.query, company_id: req.scope?.company_id ?? null });
      res.json(invoices);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getById(req, res) {
    try {
      const invoice = await invoiceService.getInvoiceById(req.params.id, req.scope?.company_id ?? null);
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
      const invoices = await invoiceService.getOverdueInvoices(req.scope?.company_id ?? null);
      res.json(invoices);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  async getDueSoon(req, res) {
    try {
      const days = parseInt(req.query.days) || 7;
      const invoices = await invoiceService.getDueSoonInvoices(days, req.scope?.company_id ?? null);
      res.json(invoices);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
}

export default new InvoiceController();
