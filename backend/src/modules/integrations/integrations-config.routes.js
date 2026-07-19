import { Router } from 'express';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import pool from '../../config/db.js';

const router = Router();

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
function derivedKey() {
  const raw = process.env.ENCRYPTION_KEY || 'pulse_erp_dev_insecure_key_change_in_prod';
  return createHash('sha256').update(raw).digest();
}

function encrypt(obj) {
  const iv  = randomBytes(12);
  const key = derivedKey();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv  = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', derivedKey(), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8'));
  } catch {
    return {};
  }
}

// ── Which env vars each integration uses & which are required ─────────────────
const INTEGRATION_REQUIRED = {
  whatsapp:    ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'],
  sendgrid:    ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'],
  'aws-ses':   ['AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_REGION'],
  smtp:        ['SMTP_HOST', 'SMTP_USER'],
  razorpay:    ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
  tally:       ['TALLY_GATEWAY_URL'],
  'zoho-books':['ZOHO_BOOKS_CLIENT_ID', 'ZOHO_BOOKS_ACCESS_TOKEN'],
  'zoho-sign': ['ZOHO_SIGN_CLIENT_ID', 'ZOHO_SIGN_ACCESS_TOKEN'],
};

// Fields whose values must be masked in GET responses
const SECRET_PATTERN = /TOKEN|SECRET|KEY|PASS|ACCESS_TOKEN|REFRESH_TOKEN/i;

function isRequired(key) {
  return INTEGRATION_REQUIRED[key] !== undefined;
}

function allRequiredPresent(key, creds) {
  const reqs = INTEGRATION_REQUIRED[key] || [];
  return reqs.every(f => creds[f] && String(creds[f]).trim().length > 0);
}

function applyToEnv(key, creds) {
  for (const [envKey, val] of Object.entries(creds)) {
    if (val && String(val).trim()) process.env[envKey] = String(val).trim();
  }
}

function envStatus(key) {
  const reqs = INTEGRATION_REQUIRED[key] || [];
  return reqs.every(f => process.env[f] && process.env[f].trim()) ? 'Connected' : 'Not Configured';
}

// ── GET /config/all — statuses for all integrations for this company ──────────
router.get('/all', async (req, res) => {
  const cid = req.scope?.company_id ?? 0;
  try {
    const { rows } = await pool.query(
      `SELECT integration_key, credentials_enc, status, last_tested_at
         FROM company_integrations WHERE company_id = $1`,
      [cid]
    );

    const dbMap = {};
    for (const row of rows) {
      dbMap[row.integration_key] = {
        status:     row.status,
        last:       row.last_tested_at,
        creds:      decrypt(row.credentials_enc),
      };
    }

    const KEYS = Object.keys(INTEGRATION_REQUIRED);
    const result = {};
    for (const key of KEYS) {
      const db = dbMap[key];
      if (db) {
        // DB record found — use it if credentials are in DB, else fall back to env
        const dbConnected = db.status === 'connected';
        const envConnected = envStatus(key) === 'Connected';
        result[key] = {
          status: dbConnected || envConnected ? 'Connected' : 'Not Configured',
          last:   db.last || null,
        };
      } else {
        // No DB record — check env vars (legacy configuration)
        result[key] = { status: envStatus(key), last: null };
      }
    }

    res.json(result);
  } catch (err) {
    // Fallback: just check env vars
    const result = {};
    for (const key of Object.keys(INTEGRATION_REQUIRED)) {
      result[key] = { status: envStatus(key), last: null };
    }
    res.json(result);
  }
});

// ── GET /config/:key — masked credentials for pre-filling the configure form ──
router.get('/:key', async (req, res) => {
  const { key } = req.params;
  if (!isRequired(key)) return res.status(404).json({ error: 'Unknown integration key' });

  const cid = req.scope?.company_id ?? 0;
  try {
    const { rows } = await pool.query(
      `SELECT credentials_enc, status, last_tested_at
         FROM company_integrations
        WHERE company_id = $1 AND integration_key = $2 LIMIT 1`,
      [cid, key]
    );

    const creds = rows.length ? decrypt(rows[0].credentials_enc) : {};
    const status = rows.length ? rows[0].status : 'not_configured';

    // Mask secrets
    const masked = {};
    for (const [k, v] of Object.entries(creds)) {
      masked[k] = SECRET_PATTERN.test(k) && v ? '***' : v;
    }

    res.json({ key, status, credentials: masked, last_tested_at: rows[0]?.last_tested_at || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /config/:key — save credentials, update env + DB status ───────────────
router.put('/:key', async (req, res) => {
  const { key } = req.params;
  if (!isRequired(key)) return res.status(404).json({ error: 'Unknown integration key' });

  const cid = req.scope?.company_id ?? 0;
  const incoming = req.body || {};

  try {
    // Load existing to merge (keeps previously saved values for blanked/unsubmitted fields)
    const { rows: existing } = await pool.query(
      `SELECT credentials_enc FROM company_integrations
        WHERE company_id = $1 AND integration_key = $2 LIMIT 1`,
      [cid, key]
    );
    const prev = existing.length ? decrypt(existing[0].credentials_enc) : {};

    // Merge: incoming wins unless value is blank or sentinel '***'
    const merged = { ...prev };
    for (const [k, v] of Object.entries(incoming)) {
      const val = String(v || '').trim();
      if (val && val !== '***') merged[k] = val;
    }

    const status = allRequiredPresent(key, merged) ? 'connected' : 'configured';
    const enc    = encrypt(merged);

    await pool.query(
      `INSERT INTO company_integrations (company_id, integration_key, credentials_enc, status, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (company_id, integration_key)
       DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc,
                     status          = EXCLUDED.status,
                     updated_at      = NOW()`,
      [cid, key, enc, status]
    );

    // Apply to process.env for current session so integration routes work immediately
    applyToEnv(key, merged);

    res.json({ success: true, status, key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
