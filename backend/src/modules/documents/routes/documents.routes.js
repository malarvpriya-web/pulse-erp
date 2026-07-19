import express from 'express';
import crypto from 'crypto';
import pool from '../../shared/db.js';
import documentsRepository from '../repositories/documents.repository.js';

const router = express.Router();


// ── Zoho Sign helpers ─────────────────────────────────────────────────────────
const _ZS_API = { IN: 'https://sign.zoho.in', US: 'https://sign.zoho.com', EU: 'https://sign.zoho.eu', AU: 'https://sign.zoho.com.au' };
const _zsBase = () => _ZS_API[process.env.ZOHO_SIGN_DC || 'IN'] || _ZS_API.IN;
const zohoConfigured = () => !!(process.env.ZOHO_SIGN_CLIENT_ID && process.env.ZOHO_SIGN_ACCESS_TOKEN);

async function zohoPost(path, body) {
  const res = await fetch(`${_zsBase()}/api/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Zoho-oauthtoken ${process.env.ZOHO_SIGN_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Zoho Sign ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ── Document Signing ──────────────────────────────────────────────────────────

router.get('/signing', async (req, res) => {
  try {
    const { status, search, limit = 200 } = req.query;
    let q = `SELECT * FROM document_signings WHERE 1=1`;
    const params = [];
    let i = 1;
    if (status) { q += ` AND status = $${i++}`; params.push(status); }
    if (search) {
      q += ` AND (title ILIKE $${i} OR recipient_name ILIKE $${i} OR recipient_email ILIKE $${i} OR doc_type ILIKE $${i})`;
      params.push(`%${search}%`); i++;
    }
    q += ` ORDER BY created_at DESC LIMIT $${i}`;
    params.push(parseInt(limit));
    const { rows } = await pool.query(q, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/signing', async (req, res) => {
  try {
    const { title, doc_type, recipient_name, recipient_email, message, expiry_date } = req.body;
    if (!title || !recipient_name || !recipient_email) {
      return res.status(400).json({ error: 'title, recipient_name and recipient_email are required' });
    }

    // In production, Zoho Sign must be configured before a signing request can be created.
    // Saving as 'sent' when no dispatch occurred would silently mislead the user.
    if (process.env.NODE_ENV === 'production' && !zohoConfigured()) {
      return res.status(503).json({
        error:   'signing_not_configured',
        message: 'Zoho Sign is not configured. Set ZOHO_SIGN_CLIENT_ID and ZOHO_SIGN_ACCESS_TOKEN in environment variables.',
      });
    }

    // In development without Zoho, save as 'draft' so the record is not misleadingly 'sent'.
    const initialStatus = zohoConfigured() ? 'sent' : 'draft';
    const sign_token = crypto.randomBytes(32).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO document_signings (title, doc_type, recipient_name, recipient_email, message, expiry_date, sign_token, status, sent_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8 = 'sent' THEN CURRENT_DATE ELSE NULL END, $9) RETURNING *`,
      [title, doc_type || 'Other', recipient_name, recipient_email, message || null, expiry_date || null, sign_token, initialStatus, req.user?.userId ?? req.user?.id ?? null]
    );
    const doc = rows[0];

    let zoho_mode = 'not_configured';
    if (zohoConfigured()) {
      try {
        const expiryDays = expiry_date
          ? Math.max(1, Math.ceil((new Date(expiry_date) - Date.now()) / 86400000))
          : 7;
        const data = await zohoPost('/requests', {
          requests: {
            request_name: title,
            actions: [{ action_type: 'SIGN', recipient_name, recipient_email, signing_order: 1 }],
            expiration_days: expiryDays,
            notes: message || '',
          },
        });
        const zohoRequestId = data?.requests?.request_id;
        const signingUrl = data?.requests?.actions?.[0]?.signing_url || null;
        if (zohoRequestId) {
          await pool.query(
            `UPDATE document_signings SET sign_token = $1, signing_url = $2 WHERE id = $3`,
            [zohoRequestId, signingUrl, doc.id]
          );
          doc.sign_token = zohoRequestId;
          doc.signing_url = signingUrl;
        }
        zoho_mode = 'sent';
      } catch (zohoErr) {
        console.error('[DocumentSigning/Zoho]', zohoErr.message);
        zoho_mode = 'failed';
        // Downgrade status to draft since the signing request was not dispatched
        await pool.query(`UPDATE document_signings SET status = 'draft', sent_date = NULL WHERE id = $1`, [doc.id]).catch(() => {});
        doc.status = 'draft';
      }
    }

    res.status(201).json({ ...doc, zoho_mode });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/signing/:id/remind', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, recipient_email, sign_token, signing_url FROM document_signings WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    const doc = rows[0];

    if (zohoConfigured() && doc.signing_url && doc.sign_token) {
      try {
        await zohoPost(`/requests/${doc.sign_token}/remind`, {});
      } catch (_) {}
    }

    res.json({ message: 'Reminder sent', id: doc.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/signing/:id/revoke', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE document_signings SET status = 'declined', declined_reason = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, req.body.reason || 'Revoked by sender']
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/signing/:id/sign', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE document_signings SET status = 'signed', signed_date = CURRENT_DATE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/signing/:id', async (req, res) => {
  try {
    const allowed = ['status', 'signed_date', 'declined_reason'];
    const fields = Object.keys(req.body).filter(k => allowed.includes(k));
    if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
    const sets = fields.map((f, idx) => `${f} = $${idx + 2}`).join(', ');
    const vals = fields.map(f => req.body[f]);
    const { rows } = await pool.query(
      `UPDATE document_signings SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id, ...vals]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Templates ─────────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    const templates = await documentsRepository.findTemplates(req.query);
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const template = await documentsRepository.findTemplateById(req.params.id);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const template = await documentsRepository.createTemplate({ ...req.body, created_by: req.user?.userId ?? req.user?.id });
    res.status(201).json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const template = await documentsRepository.updateTemplate(req.params.id, req.body);
    res.json(template);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    await documentsRepository.deleteTemplate(req.params.id);
    res.json({ message: 'Template deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Generated Documents ───────────────────────────────────────────────────────

router.get('/generated', async (req, res) => {
  try {
    const documents = await documentsRepository.findGeneratedDocuments(req.query);
    res.json(documents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const document = await documentsRepository.saveGeneratedDocument({ ...req.body, generated_by: req.user?.userId ?? req.user?.id });
    res.status(201).json(document);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
