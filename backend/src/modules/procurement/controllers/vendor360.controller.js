import { Vendor360Service as svc } from '../services/vendor360.service.js';
import { hasRole } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';

// Guard: every handler requires company_id from JWT except superadmin (platform-level role).
// Superadmin has no company_id in JWT — they operate across tenants, so null is allowed.
// Returns false (not null) when a 403 response was already sent, so callers can distinguish
// "valid null company_id for superadmin" from "error, bail out".
const requireCompany = (req, res) => {
  const companyId = companyOf(req);
  if (!companyId && !hasRole(req, 'super_admin')) {
    res.status(403).json({ error: 'Company context required' });
    return false;
  }
  return companyId ?? null;
};

const vendorId = req => parseInt(req.params.vendorId, 10);

export const Vendor360Controller = {

  // GET /vendor-360
  async listVendors(req, res) {
    try {
      const companyId = requireCompany(req, res);
      if (companyId === false) return;
      const { search, status } = req.query;
      const rows = await svc.listVendors(companyId, { search, status });
      res.json(rows.map(r => ({
        ...r,
        po_count:  parseInt(r.po_count  || 0),
        po_value:  parseFloat(r.po_value  || 0),
        score:     parseFloat(r.score    || 0),
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  // GET /vendor-360/:vendorId
  async getFull360(req, res) {
    try {
      const companyId = requireCompany(req, res);
      if (companyId === false) return;
      const data = await svc.getFull360(vendorId(req), companyId);
      if (!data) return res.status(404).json({ error: 'Vendor not found' });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  // GET /vendor-360/:vendorId/timeline
  async getTimeline(req, res) {
    try {
      const companyId = requireCompany(req, res);
      if (companyId === false) return;
      const events = await svc.getTimeline(vendorId(req), companyId);
      res.json(events);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  // GET /vendor-360/:vendorId/scorecard
  async getScorecard(req, res) {
    try {
      const companyId = requireCompany(req, res);
      if (companyId === false) return;
      const sc = await svc.getScorecard(vendorId(req), companyId);
      res.json(sc);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  // POST /vendor-360/:vendorId/scorecard
  async saveScorecard(req, res) {
    try {
      const companyId = requireCompany(req, res);
      if (companyId === false) return;
      const entry = await svc.saveScorecard(
        vendorId(req), companyId, req.body, req.user?.id
      );
      res.status(201).json(entry);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  // GET /vendor-360/:vendorId/risk
  async getRisk(req, res) {
    try {
      const companyId = requireCompany(req, res);
      if (companyId === false) return;
      const risk = await svc.getRisk(vendorId(req), companyId);
      if (!risk) return res.status(404).json({ error: 'Vendor not found' });
      res.json(risk);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  // GET /vendor-360/:vendorId/documents
  async getDocuments(req, res) {
    try {
      const companyId = requireCompany(req, res);
      if (companyId === false) return;
      const docs = await svc.getDocuments(vendorId(req), companyId);
      if (!docs) return res.status(404).json({ error: 'Vendor not found' });
      res.json(docs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },

  // GET /vendor-360/command-center
  async commandCenter(req, res) {
    try {
      const companyId = requireCompany(req, res);
      if (companyId === false) return;
      const data = await svc.commandCenter(companyId);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
};
