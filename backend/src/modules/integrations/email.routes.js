import { Router } from 'express';

const router = Router();

// ── SendGrid ──────────────────────────────────────────────────────────────────
router.get('/sendgrid/status', async (req, res) => {
  const apiKey = process.env.SENDGRID_API_KEY;
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
router.get('/aws-ses/status', (req, res) => {
  const keyId  = process.env.AWS_SES_ACCESS_KEY_ID;
  const secret = process.env.AWS_SES_SECRET_ACCESS_KEY;
  const region = process.env.AWS_SES_REGION || 'ap-south-1';
  if (!keyId || !secret) return res.json({ configured: false, connected: false, provider: 'aws-ses' });
  res.json({ configured: true, connected: true, provider: 'aws-ses', region });
});

// ── SMTP ──────────────────────────────────────────────────────────────────────
router.get('/smtp/status', (req, res) => {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  if (!host || !user) return res.json({ configured: false, connected: false, provider: 'smtp' });
  res.json({
    configured: true,
    connected: true,
    provider: 'smtp',
    host,
    port: process.env.SMTP_PORT || 587,
  });
});

export default router;
