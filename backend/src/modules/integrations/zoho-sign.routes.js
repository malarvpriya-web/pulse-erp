import { Router } from 'express';
import pool from '../../config/db.js';
import { companyOf } from '../../shared/scope.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { encrypt, resolveConfig } from './integrationConfig.js';

const router = Router();

const DC_ACCOUNTS = {
  IN: 'https://accounts.zoho.in',
  US: 'https://accounts.zoho.com',
  EU: 'https://accounts.zoho.eu',
  AU: 'https://accounts.zoho.com.au',
};
const DC_API = {
  IN: 'https://sign.zoho.in',
  US: 'https://sign.zoho.com',
  EU: 'https://sign.zoho.eu',
  AU: 'https://sign.zoho.com.au',
};

const FRIENDLY_ERRORS = {
  401: 'Access token is invalid or expired — refresh the token in Configuration.',
  403: 'Permission denied — ensure the OAuth scope ZohoSign.documents.ALL is granted.',
  429: 'Zoho Sign rate limit reached — try again in a minute.',
};

// ── Credential resolution: company_integrations DB → env var fallback ───────────
// The AES-256-GCM helpers and the row read live in ./integrationConfig.js. This
// file used to carry its own byte-identical copy; two copies of a decrypt path
// drift, and after PULSE-01 there is exactly one place that reads or writes a
// credential row.
async function cfgFromDb(companyId) {
  if (!companyId && companyId !== 0) return {};
  // resolveConfig() reads THIS tenant's encrypted row and falls back to the
  // deployment's ZOHO_SIGN_* env vars for fields it has not set. It is the only
  // place in the codebase that reads a credential from the environment.
  return resolveConfig(companyId, 'zoho-sign').catch(() => ({}));
}

/** Map the resolved field names onto the shape the Zoho helpers expect. */
function resolveCfg(cfg = {}) {
  return {
    client_id:     cfg.ZOHO_SIGN_CLIENT_ID     || '',
    client_secret: cfg.ZOHO_SIGN_CLIENT_SECRET || '',
    access_token:  cfg.ZOHO_SIGN_ACCESS_TOKEN  || '',
    refresh_token: cfg.ZOHO_SIGN_REFRESH_TOKEN || '',
    dc:            cfg.ZOHO_SIGN_DC            || 'IN',
  };
}

function isReady(c) {
  return !!(c.client_id && c.access_token);
}

function friendlyZohoError(err) {
  const msg = err.message || '';
  const match = msg.match(/Zoho Sign (\d+):/);
  if (match) {
    const code = parseInt(match[1], 10);
    if (FRIENDLY_ERRORS[code]) return FRIENDLY_ERRORS[code];
    if (code >= 500) return 'Zoho Sign service is temporarily unavailable. Try again shortly.';
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
    return 'Cannot reach Zoho Sign. Check your network connectivity.';
  }
  return 'Connection to Zoho Sign failed. Verify your credentials and Data Center setting.';
}

async function zohoFetch(path, options = {}, c) {
  const url = `${DC_API[c.dc] || DC_API.IN}/api/v1${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${c.access_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zoho Sign ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function companyId(req) {
  return companyOf(req) ?? req.scope?.company_id ?? 0;
}

/* ── POST /test-connection — validate credentials live ── */
router.post('/test-connection', requirePermission('admin', 'edit'), async (req, res) => {
  const cid = companyId(req);
  const db  = await cfgFromDb(cid);
  const body = req.body || {};

  // Prefer body values (just typed by user) over DB/env, but skip blank/masked values
  const merged = {};
  const fields = ['ZOHO_SIGN_CLIENT_ID', 'ZOHO_SIGN_CLIENT_SECRET', 'ZOHO_SIGN_ACCESS_TOKEN', 'ZOHO_SIGN_REFRESH_TOKEN', 'ZOHO_SIGN_DC'];
  for (const f of fields) {
    const bodyVal = body[f] && body[f] !== '***' ? body[f] : null;
    // `db` is already resolveConfig()'s output, so the env fallback has happened.
    merged[f] = bodyVal || db[f] || (f === 'ZOHO_SIGN_DC' ? 'IN' : '');
  }

  const c = resolveCfg(merged);
  if (!isReady(c)) {
    return res.status(400).json({ connected: false, message: 'Client ID and Access Token are required to test the connection.' });
  }

  try {
    const data = await zohoFetch('/requests?limit=1&page=1', {}, c);
    const total = data?.page_context?.total || 0;
    res.json({ connected: true, dc: c.dc, total_requests: total });
  } catch (err) {
    res.status(400).json({ connected: false, message: friendlyZohoError(err) });
  }
});

/* ── GET /status ── */
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
  const cid = companyId(req);
  const db  = await cfgFromDb(cid);
  const c   = resolveCfg(db);

  if (!isReady(c)) return res.json({ configured: false, connected: false });

  try {
    const data = await zohoFetch('/requests?limit=1&page=1', {}, c);
    const total = data?.page_context?.total || 0;
    res.json({ configured: true, connected: true, dc: c.dc, total_requests: total });
  } catch (err) {
    res.json({ configured: true, connected: false, error: friendlyZohoError(err) });
  }
});

/* ── GET /requests ── */
router.get('/requests', async (req, res) => {
  const cid = companyId(req);
  const db  = await cfgFromDb(cid);
  const c   = resolveCfg(db);

  if (!isReady(c)) return res.json({ requests: [], total: 0, simulated: true });

  try {
    const { limit = 50, page = 1, status } = req.query;
    let path = `/requests?limit=${limit}&page=${page}`;
    if (status) path += `&action_status=${encodeURIComponent(status)}`;
    const data = await zohoFetch(path, {}, c);
    res.json({ requests: data.requests || [], total: data.page_context?.total || 0 });
  } catch (err) {
    res.status(500).json({ error: friendlyZohoError(err) });
  }
});

/* ── GET /requests/:id ── */
router.get('/requests/:id', async (req, res) => {
  const cid = companyId(req);
  const db  = await cfgFromDb(cid);
  const c   = resolveCfg(db);

  if (!isReady(c)) return res.json({ simulated: true, request_id: req.params.id });
  try {
    const data = await zohoFetch(`/requests/${req.params.id}`, {}, c);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: friendlyZohoError(err) });
  }
});

/* ── POST /requests — create a new signing request ── */
router.post('/requests', async (req, res) => {
  const cid = companyId(req);
  const db  = await cfgFromDb(cid);
  const c   = resolveCfg(db);

  if (!isReady(c)) {
    return res.json({
      simulated: true,
      request_id: `DEMO-${Date.now()}`,
      status: 'sent',
      message: 'Demo mode — configure Zoho Sign credentials to send real requests',
    });
  }
  try {
    const { title, recipient_name, recipient_email, message, expiry_days = 7 } = req.body;
    if (!title || !recipient_email) {
      return res.status(400).json({ error: 'title and recipient_email are required' });
    }
    const payload = {
      requests: {
        request_name: title,
        actions: [{ action_type: 'SIGN', recipient_name: recipient_name || recipient_email.split('@')[0], recipient_email, signing_order: 1 }],
        expiration_days: Number(expiry_days),
        notes: message || '',
      },
    };
    const data = await zohoFetch('/requests', { method: 'POST', body: JSON.stringify(payload) }, c);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: friendlyZohoError(err) });
  }
});

/* ── POST /sync — sync document_signings statuses from Zoho Sign ── */
router.post('/sync', async (req, res) => {
  const cid = companyId(req);
  const db  = await cfgFromDb(cid);
  const c   = resolveCfg(db);

  if (!isReady(c)) {
    return res.json({ synced: 0, checked: 0, simulated: true, message: 'Configure Zoho Sign to enable sync' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, sign_token FROM document_signings
       WHERE status = 'sent' AND sign_token IS NOT NULL LIMIT 50`
    );
    let synced = 0;
    for (const row of rows) {
      try {
        const data = await zohoFetch(`/requests/${row.sign_token}`, {}, c);
        const reqStatus = data?.requests?.request_status?.toLowerCase();
        if (reqStatus === 'completed') {
          await pool.query(`UPDATE document_signings SET status='signed', signed_date=CURRENT_DATE WHERE id=$1`, [row.id]);
          synced++;
        } else if (reqStatus === 'declined' || reqStatus === 'revoked') {
          await pool.query(`UPDATE document_signings SET status='declined' WHERE id=$1`, [row.id]);
          synced++;
        }
      } catch (_) {}
    }
    res.json({ synced, checked: rows.length });
  } catch (err) {
    res.status(500).json({ error: friendlyZohoError(err) });
  }
});

/* ── POST /refresh-token ── */
router.post('/refresh-token', requirePermission('admin', 'edit'), async (req, res) => {
  const cid = companyId(req);
  const db  = await cfgFromDb(cid);
  const c   = resolveCfg(db);

  if (!c.client_id || !c.refresh_token) {
    return res.status(400).json({ error: 'Client ID and Refresh Token must be configured first.' });
  }
  try {
    const accountsBase = DC_ACCOUNTS[c.dc] || DC_ACCOUNTS.IN;
    const params = new URLSearchParams({
      grant_type: 'refresh_token', client_id: c.client_id,
      client_secret: c.client_secret, refresh_token: c.refresh_token,
    });
    const tokenRes = await fetch(`${accountsBase}/oauth/v2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
    });
    const data = await tokenRes.json();
    if (data.access_token) {
      // Persist new access token back to company_integrations
      const updated = { ...db, ZOHO_SIGN_ACCESS_TOKEN: data.access_token };
      const enc = encrypt(updated);
      await pool.query(
        `INSERT INTO company_integrations (company_id, integration_key, credentials_enc, status, updated_at)
         VALUES ($1, 'zoho-sign', $2, 'connected', NOW())
         ON CONFLICT (company_id, integration_key)
         DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc, status = 'connected', updated_at = NOW()`,
        [cid, enc]
      ).catch(() => {});
      // NOT written to process.env — see PULSE-01. process.env is process-global,
      // so assigning the new token here made one tenant's credential the fallback
      // every other tenant's resolveCfg() read. The row above is per-tenant and
      // cfgFromDb() re-reads it on the next request, so nothing is lost.
      res.json({ success: true, message: 'Access token refreshed' });
    } else {
      const msg = data.error === 'invalid_client'
        ? 'Invalid Client ID or Secret — check your OAuth app credentials.'
        : (data.error || 'Token refresh failed. Check your Refresh Token.');
      res.status(400).json({ error: msg });
    }
  } catch (err) {
    res.status(500).json({ error: friendlyZohoError(err) });
  }
});

/* ── POST /send-for-signing/:signingId ── */
router.post('/send-for-signing/:signingId', async (req, res) => {
  const cid = companyId(req);
  const db  = await cfgFromDb(cid);
  const c   = resolveCfg(db);

  try {
    const { rows } = await pool.query(`SELECT * FROM document_signings WHERE id = $1`, [req.params.signingId]);
    if (!rows.length) return res.status(404).json({ error: 'Document signing not found' });
    const doc = rows[0];

    if (!isReady(c)) {
      return res.json({ simulated: true, message: 'Demo mode — request would be sent to Zoho Sign' });
    }

    const payload = {
      requests: {
        request_name: doc.title,
        actions: [{ action_type: 'SIGN', recipient_name: doc.recipient_name, recipient_email: doc.recipient_email, signing_order: 1 }],
        expiration_days: 7, notes: doc.message || '',
      },
    };
    const data = await zohoFetch('/requests', { method: 'POST', body: JSON.stringify(payload) }, c);
    const zohoRequestId = data?.requests?.request_id;
    if (zohoRequestId) {
      await pool.query(`UPDATE document_signings SET sign_token = $1 WHERE id = $2`, [zohoRequestId, doc.id]);
    }
    res.json({ success: true, zoho_request_id: zohoRequestId, data });
  } catch (err) {
    res.status(500).json({ error: friendlyZohoError(err) });
  }
});

export default router;
