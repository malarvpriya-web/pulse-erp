// backend/src/modules/crm/customer360.controller.js
import * as svc from './customer360.service.js';
import { companyOf } from '../../shared/scope.js';

// GET /api/v1/crm/customer-360/:customerId
export async function getCustomer360(req, res) {
  try {
    const { customerId } = req.params;
    const companyId = companyOf(req);

    const data = await svc.getCustomer360(customerId, companyId);
    if (!data) return res.status(404).json({ error: 'Customer not found' });

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/v1/crm/customer-360/:customerId/timeline
export async function getTimeline(req, res) {
  try {
    const { customerId } = req.params;
    const companyId = companyOf(req);

    const events = await svc.getTimeline(customerId, companyId);
    res.json({ data: events, total: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/v1/crm/customer-360/:customerId/health
export async function getHealth(req, res) {
  try {
    const { customerId } = req.params;
    const companyId = companyOf(req);

    const health = await svc.getHealth(customerId, companyId);
    res.json({ data: health });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/v1/crm/customer-360/:customerId/documents
export async function getDocuments(req, res) {
  try {
    const { customerId } = req.params;
    const docs = await svc.getDocuments(customerId);
    if (!docs.root) return res.status(404).json({ error: 'Customer not found' });
    res.json({ data: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
