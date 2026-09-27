/**
 * email.routes.js — provider status for the Integrations page.
 *
 * PULSE-01: these three handlers used to report `process.env`, and the config
 * route wrote a tenant's credentials INTO process.env. A tenant that had
 * configured nothing was therefore shown "Connected" off whichever tenant saved
 * last. They now resolve per tenant through resolveConfig(), which reads that
 * company's encrypted row and falls back to the deployment's env vars only for
 * fields the tenant has not set.
 *
 * ⚠ These endpoints report whether a provider is configured. They must never
 * return the credential itself — only booleans and non-secret fields (region,
 * host, port, the account name the provider echoes back).
 */
import { Router } from 'express';
import { companyOf } from '../../shared/scope.js';
import { resolveConfig } from './integrationConfig.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';

const router = Router();

// ── SendGrid ──────────────────────────────────────────────────────────────────
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
router.get('/sendgrid/status', requirePermission('settings', 'view'), async (req, res) => {
  const cfg = await resolveConfig(companyOf(req), 'sendgrid');
  const apiKey = cfg.SENDGRID_API_KEY;
  if (!apiKey) return res.json({ configured: false, connected: false, provider: 'sendgrid' });
  try {
    const r = await fetch('https://api.sendgrid.com/v3/user/account', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (r.ok) {
      const data = await r.json();
      res.json({ configured: true, connected: true, provider: 'sendgrid', username: data.email || null });
    } else {
      res.json({ configured: true, connected: false, provider: 'sendgrid', error: `HTTP ${r.status}` });
    }
  } catch (e) {
    res.json({ configured: true, connected: false, provider: 'sendgrid', error: e.message });
  }
});

// ── AWS SES ───────────────────────────────────────────────────────────────────
router.get('/aws-ses/status', requirePermission('settings', 'view'), async (req, res) => {
  const cfg = await resolveConfig(companyOf(req), 'aws-ses');
  const region = cfg.AWS_SES_REGION || 'ap-south-1';
  if (!cfg.AWS_SES_ACCESS_KEY_ID || !cfg.AWS_SES_SECRET_ACCESS_KEY) {
    return res.json({ configured: false, connected: false, provider: 'aws-ses' });
  }
  res.json({ configured: true, connected: true, provider: 'aws-ses', region });
});

// ── SMTP ──────────────────────────────────────────────────────────────────────
router.get('/smtp/status', requirePermission('settings', 'view'), async (req, res) => {
  const cfg = await resolveConfig(companyOf(req), 'smtp');
  if (!cfg.SMTP_HOST || !cfg.SMTP_USER) {
    return res.json({ configured: false, connected: false, provider: 'smtp' });
  }
  res.json({
    configured: true,
    connected: true,
    provider: 'smtp',
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT || 587,
  });
});

export default router;
