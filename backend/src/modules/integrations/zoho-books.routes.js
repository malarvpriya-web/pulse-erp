import { Router } from 'express';

const router = Router();

const DC_API = {
  IN: 'https://www.zohoapis.in/books/v3',
  US: 'https://www.zohoapis.com/books/v3',
  EU: 'https://www.zohoapis.eu/books/v3',
  AU: 'https://www.zohoapis.com.au/books/v3',
};

function cfg() {
  return {
    client_id:    process.env.ZOHO_BOOKS_CLIENT_ID    || '',
    access_token: process.env.ZOHO_BOOKS_ACCESS_TOKEN || '',
    org_id:       process.env.ZOHO_BOOKS_ORG_ID       || '',
    dc:           process.env.ZOHO_BOOKS_DC           || 'IN',
  };
}

function isConfigured() {
  const c = cfg();
  return !!(c.client_id && c.access_token);
}

async function booksFetch(path) {
  const c = cfg();
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

router.get('/status', async (req, res) => {
  if (!isConfigured()) return res.json({ configured: false, connected: false });
  try {
    const data = await booksFetch('/organizations');
    const orgs = data.organizations || [];
    const org = orgs[0];
    res.json({
      configured: true,
      connected: true,
      dc: cfg().dc,
      org_name: org?.name || null,
      org_id: org?.organization_id || cfg().org_id,
      total_orgs: orgs.length,
    });
  } catch (e) {
    res.json({ configured: true, connected: false, error: e.message });
  }
});

router.get('/organizations', async (req, res) => {
  if (!isConfigured()) return res.json({ organizations: [], simulated: true });
  try {
    const data = await booksFetch('/organizations');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
