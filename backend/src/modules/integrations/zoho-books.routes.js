/**
 * zoho-books.routes.js
 *
 * PULSE-01: `cfg()` read process.env, and the config route wrote a tenant's
 * credentials into process.env — so every tenant's Zoho Books calls used
 * whichever tenant had saved last. `cfg()` now takes the request and resolves
 * that tenant's encrypted row, with the deployment's env vars as the fallback for
 * fields it has not set.
 */
import { Router } from 'express';
import { companyOf } from '../../shared/scope.js';
import { resolveConfig } from './integrationConfig.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();

const DC_API = {
  IN: 'https://www.zohoapis.in/books/v3',
  US: 'https://www.zohoapis.com/books/v3',
  EU: 'https://www.zohoapis.eu/books/v3',
  AU: 'https://www.zohoapis.com.au/books/v3',
};

/** This tenant's Zoho Books credentials. Async now — it reads a row. */
async function cfg(req) {
  const c = await resolveConfig(companyOf(req), 'zoho-books');
  return {
    client_id:    c.ZOHO_BOOKS_CLIENT_ID    || '',
    access_token: c.ZOHO_BOOKS_ACCESS_TOKEN || '',
    org_id:       c.ZOHO_BOOKS_ORG_ID       || '',
    dc:           c.ZOHO_BOOKS_DC           || 'IN',
  };
}

const isConfigured = (c) => !!(c.client_id && c.access_token);

async function booksFetch(path, c) {
  const base = DC_API[c.dc] || DC_API.IN;
  const sep = path.includes('?') ? '&' : '?';
  const url = `${base}${path}${c.org_id ? `${sep}organization_id=${c.org_id}` : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${c.access_token}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zoho Books ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ⚠ GATED AT settings:view, NOT LEFT OPEN. Found while reviewing the PULSE-01 gate:
// `IntegrationsHub.jsx` catches a 403 from `/integrations/config/all` and FALLS BACK
// to these per-provider status endpoints, so leaving them open routed straight around
// the gate — any authenticated employee could still enumerate which providers a tenant
// uses, and read the SMTP host and port and the SendGrid account email. That is the
// same reconnaissance the config read was gated for.
//
// `settings:view` (admin, super_admin, finance_manager, hr_manager) is the bar because
// these return non-secret operational status rather than credentials, and those are the
// roles that legitimately reach the integration pages.
router.get('/status', requirePermission('settings', 'view'), async (req, res) => {
  const c = await cfg(req);
  if (!isConfigured(c)) return res.json({ configured: false, connected: false });
  try {
    const data = await booksFetch('/organizations', c);
    const orgs = data.organizations || [];
    const org = orgs[0];
    res.json({
      configured: true,
      connected: true,
      dc: c.dc,
      org_name: org?.name || null,
      org_id: org?.organization_id || c.org_id,
      total_orgs: orgs.length,
    });
  } catch (e) {
    res.json({ configured: true, connected: false, error: e.message });
  }
});

router.get('/organizations', async (req, res) => {
  const c = await cfg(req);
  if (!isConfigured(c)) return res.json({ organizations: [], simulated: true });
  try {
    const data = await booksFetch('/organizations', c);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
