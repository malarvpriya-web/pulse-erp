// backend/src/modules/crm/routes/email.routes.js
import express from 'express';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import pool from '../../../config/db.js';
import { requirePermission } from '../../../middlewares/auth.middleware.js';
import { companyOf } from '../../../shared/scope.js';

const router = express.Router();

// ─── Encryption helpers ────────────────────────────────────────────────────────
function getEncKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY env var is not set');
  return Buffer.from(raw.slice(0, 32).padEnd(32, '0'), 'utf8');
}

function encryptPassword(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptPassword(ciphertext) {
  try {
    if (!ciphertext) return '';
    const [ivHex, encHex] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', getEncKey(), iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function smtpErrorMessage(err) {
  const msg = err?.message || '';
  if (/ENOTFOUND|ECONNREFUSED/.test(msg)) return 'Connection refused — check SMTP host and port';
  if (/auth|535|534|Username|Password/i.test(msg)) return 'Authentication failed — check username and password';
  if (/ETIMEDOUT|timeout/i.test(msg)) return 'Connection timed out — check host and firewall settings';
  return msg || 'SMTP connection failed';
}

// ─── Routes: Email Accounts ────────────────────────────────────────────────────

// GET /crm/email-accounts — list accounts for current user
router.get('/email-accounts', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const userId = req.user?.employee_id || req.user?.id;
    const { rows } = await pool.query(
      `SELECT id, display_name, email_address, provider, smtp_host, smtp_port,
              imap_host, imap_port, is_active, last_sync_at, sync_status, sync_error
       FROM crm_email_accounts
       WHERE company_id = $1 AND user_id = $2 AND is_active = true
       ORDER BY created_at`,
      [companyId, userId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /crm/email-accounts/connect-smtp — test SMTP and save account
router.post('/email-accounts/connect-smtp', requirePermission('crm', 'add'), async (req, res) => {
  const companyId = companyOf(req);
  const userId = req.user?.employee_id || req.user?.id;
  const {
    display_name, email_address, smtp_host, smtp_port,
    smtp_username, smtp_password, imap_host, imap_port,
  } = req.body;

  if (!email_address || !smtp_host || !smtp_username || !smtp_password) {
    return res.status(400).json({ success: false, message: 'email_address, smtp_host, smtp_username and smtp_password are required' });
  }

  const port = parseInt(smtp_port) || 587;
  const secure = port === 465;

  // Test SMTP connection before saving
  try {
    const transporter = nodemailer.createTransport({
      host: smtp_host,
      port,
      secure,
      auth: { user: smtp_username, pass: smtp_password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
    await transporter.verify();
  } catch (err) {
    return res.status(400).json({ success: false, message: smtpErrorMessage(err) });
  }

  // SMTP verified — encrypt and save
  try {
    const encrypted = encryptPassword(smtp_password);
    const { rows } = await pool.query(
      `INSERT INTO crm_email_accounts
         (company_id, user_id, provider, display_name, email_address,
          smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password_encrypted,
          imap_host, imap_port, imap_username, sync_status)
       VALUES ($1,$2,'smtp',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'synced')
       RETURNING id, display_name, email_address, provider, sync_status`,
      [
        companyId, userId, display_name || email_address, email_address,
        smtp_host, port, secure, smtp_username, encrypted,
        imap_host || smtp_host, parseInt(imap_port) || 993, smtp_username,
      ]
    );
    res.json({ success: true, account_id: rows[0].id, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /crm/email-accounts/:id — disconnect account
router.delete('/email-accounts/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const userId = req.user?.employee_id || req.user?.id;
    const { rowCount } = await pool.query(
      `UPDATE crm_email_accounts SET is_active = false
       WHERE id = $1 AND company_id = $2 AND user_id = $3`,
      [req.params.id, companyId, userId]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'Account not found' });
    res.json({ success: true, message: 'Account disconnected' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /crm/email-accounts/:id/sync — trigger IMAP sync
router.post('/email-accounts/:id/sync', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM crm_email_accounts WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [id, companyId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Email account not found' });

    await pool.query(
      `UPDATE crm_email_accounts SET last_sync_at = NOW(), sync_status = 'synced' WHERE id = $1`,
      [id]
    );
    res.json({ success: true, message: 'Sync timestamp updated. Live IMAP sync not yet configured.', synced: 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Routes: Emails ────────────────────────────────────────────────────────────

router.get('/emails', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { direction, lead_id, page = 1, per_page = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(per_page);

    let query = `SELECT e.*, a.display_name AS account_name, a.email_address AS account_email
                 FROM crm_emails e
                 LEFT JOIN crm_email_accounts a ON e.account_id = a.id
                 WHERE e.company_id = $1 AND e.is_draft = false`;
    const params = [companyId];

    if (direction) { params.push(direction); query += ` AND e.direction = $${params.length}`; }
    if (lead_id)   { params.push(lead_id);   query += ` AND e.lead_id = $${params.length}`; }

    query += ` ORDER BY COALESCE(e.sent_at, e.received_at, e.created_at) DESC`;
    params.push(parseInt(per_page)); query += ` LIMIT $${params.length}`;
    params.push(offset);             query += ` OFFSET $${params.length}`;

    const { rows } = await pool.query(query, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/emails/send', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { account_id, lead_id, contact_id, opportunity_id, to_emails, cc_emails, subject, body_html, body_text } = req.body;
    if (!to_emails || !subject) {
      return res.status(400).json({ success: false, message: 'to_emails and subject are required' });
    }

    // Load account (must belong to same company)
    let accountRow = null;
    if (account_id) {
      const { rows } = await pool.query(
        `SELECT * FROM crm_email_accounts WHERE id = $1 AND company_id = $2 AND is_active = true`,
        [account_id, companyId]
      );
      if (rows.length) accountRow = rows[0];
    }

    let sendError = null;
    if (accountRow?.smtp_host) {
      try {
        const decrypted = decryptPassword(accountRow.smtp_password_encrypted);
        const transporter = nodemailer.createTransport({
          host: accountRow.smtp_host,
          port: accountRow.smtp_port || 587,
          secure: accountRow.smtp_port === 465,
          auth: { user: accountRow.smtp_username, pass: decrypted },
        });
        await transporter.sendMail({
          from: accountRow.email_address,
          to: Array.isArray(to_emails) ? to_emails.join(',') : to_emails,
          cc: Array.isArray(cc_emails) ? cc_emails.join(',') : (cc_emails || ''),
          subject,
          html: body_html,
          text: body_text,
        });
      } catch (e) {
        sendError = smtpErrorMessage(e);
      }
    }

    const msgId = `<${Date.now()}.${crypto.randomBytes(8).toString('hex')}@pulsetech.in>`;
    const { rows } = await pool.query(
      `INSERT INTO crm_emails
         (company_id, account_id, lead_id, contact_id, opportunity_id,
          direction, subject, body_html, body_text, from_email,
          to_emails, cc_emails, is_read, is_draft, sent_at, message_id)
       VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8,$9,$10,$11,true,false,NOW(),$12)
       RETURNING *`,
      [
        companyId, account_id || null, lead_id || null, contact_id || null, opportunity_id || null,
        subject, body_html || '', body_text || '',
        accountRow ? accountRow.email_address : 'sales@pulsetech.in',
        JSON.stringify(Array.isArray(to_emails) ? to_emails : [to_emails]),
        JSON.stringify(Array.isArray(cc_emails) ? cc_emails : (cc_emails ? [cc_emails] : [])),
        msgId,
      ]
    );
    res.json({ success: true, data: rows[0], send_error: sendError || undefined });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Pixel tracker (no auth — called by email clients)
router.post('/emails/:id/track-open', async (req, res) => {
  try {
    await pool.query(
      `UPDATE crm_emails SET opened_at = NOW() WHERE id = $1 AND opened_at IS NULL`,
      [req.params.id]
    );
  } catch (_) {}
  const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set({ 'Content-Type': 'image/gif', 'Content-Length': GIF_1x1.length, 'Cache-Control': 'no-cache, no-store' });
  res.end(GIF_1x1);
});

// ─── Routes: Email Templates ───────────────────────────────────────────────────

router.get('/email-templates', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM email_templates WHERE is_active = true ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/email-templates', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const { name, category, stage_trigger, subject, body_html, variables } = req.body;
    if (!name || !subject) return res.status(400).json({ success: false, message: 'name and subject are required' });
    const { rows } = await pool.query(
      `INSERT INTO email_templates (name, category, stage_trigger, subject, body_html, variables)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, category, stage_trigger || null, subject, body_html || '', JSON.stringify(variables || [])]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/email-templates/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const { name, category, stage_trigger, subject, body_html, variables } = req.body;
    const { rows } = await pool.query(
      `UPDATE email_templates SET name=$1, category=$2, stage_trigger=$3, subject=$4, body_html=$5, variables=$6
       WHERE id=$7 AND is_active=true RETURNING *`,
      [name, category, stage_trigger || null, subject, body_html || '', JSON.stringify(variables || []), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Template not found' });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/email-templates/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE email_templates SET is_active=false WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Template not found' });
    res.json({ success: true, message: 'Template deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Routes: Email Sequences ───────────────────────────────────────────────────

router.get('/email-sequences', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rows } = await pool.query(
      `SELECT s.*,
              (SELECT COUNT(*) FROM sequence_enrollments WHERE sequence_id = s.id AND status='active') AS enrolled_count
       FROM email_sequences s
       WHERE (s.company_id = $1 OR s.company_id IS NULL)
       ORDER BY s.created_at DESC`,
      [companyId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/email-sequences', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { name, trigger_stage, steps, is_active = true } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name is required' });
    const { rows } = await pool.query(
      `INSERT INTO email_sequences (name, trigger, trigger_stage, steps, is_active, company_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, trigger_stage || null, trigger_stage || null, JSON.stringify(steps || []), Boolean(is_active), companyId]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/email-sequences/:id', requirePermission('crm', 'edit'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { name, trigger_stage, steps, is_active } = req.body;
    const result = await pool.query(
      `UPDATE email_sequences
       SET name          = COALESCE($1, name),
           trigger       = COALESCE($2, trigger),
           trigger_stage = COALESCE($3, trigger_stage),
           steps         = COALESCE($4, steps),
           is_active     = COALESCE($5, is_active)
       WHERE id = $6 AND (company_id = $7 OR company_id IS NULL)
       RETURNING *`,
      [
        name ?? null,
        trigger_stage ?? null, trigger_stage ?? null,
        steps !== undefined ? JSON.stringify(steps) : null,
        is_active !== undefined ? Boolean(is_active) : null,
        req.params.id, companyId,
      ]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'Sequence not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/email-sequences/:id', requirePermission('crm', 'delete'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { rowCount } = await pool.query(
      `DELETE FROM email_sequences WHERE id = $1 AND (company_id = $2 OR company_id IS NULL)`,
      [req.params.id, companyId]
    );
    if (!rowCount) return res.status(404).json({ success: false, message: 'Sequence not found' });
    res.json({ success: true, message: 'Sequence deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/email-sequences/:id/enroll', requirePermission('crm', 'add'), async (req, res) => {
  try {
    const { lead_id } = req.body;
    if (!lead_id) return res.status(400).json({ success: false, message: 'lead_id is required' });
    const { rows: seqRows } = await pool.query(`SELECT id FROM email_sequences WHERE id=$1`, [req.params.id]);
    if (!seqRows.length) return res.status(404).json({ success: false, message: 'Sequence not found' });
    const { rows: existing } = await pool.query(
      `SELECT id FROM sequence_enrollments WHERE sequence_id=$1 AND lead_id=$2 AND status='active'`,
      [req.params.id, lead_id]
    );
    if (existing.length) return res.status(409).json({ success: false, message: 'Lead already enrolled in this sequence' });
    const { rows } = await pool.query(
      `INSERT INTO sequence_enrollments (sequence_id, lead_id, next_send_at) VALUES ($1,$2,NOW()) RETURNING *`,
      [req.params.id, lead_id]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Routes: Analytics ────────────────────────────────────────────────────────

router.get('/email-analytics', requirePermission('crm', 'view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const [totalRes, openRes, clickRes, replyRes, hoursRes, tplRes] = await Promise.allSettled([
      pool.query(`SELECT COUNT(*) as total FROM crm_emails WHERE direction='outbound' AND company_id=$1`, [companyId]),
      pool.query(`SELECT ROUND(100.0 * COUNT(*) FILTER(WHERE opened_at IS NOT NULL) / NULLIF(COUNT(*),0), 1) as rate FROM crm_emails WHERE direction='outbound' AND company_id=$1`, [companyId]),
      pool.query(`SELECT ROUND(100.0 * COUNT(*) FILTER(WHERE clicked_at IS NOT NULL) / NULLIF(COUNT(*),0), 1) as rate FROM crm_emails WHERE direction='outbound' AND company_id=$1`, [companyId]),
      pool.query(`SELECT ROUND(100.0 * COUNT(*) FILTER(WHERE status='replied') / NULLIF(COUNT(*),0), 1) as rate FROM crm_emails WHERE direction='outbound' AND company_id=$1`, [companyId]),
      pool.query(`SELECT EXTRACT(HOUR FROM sent_at)::INT as hour, ROUND(100.0 * COUNT(*) FILTER(WHERE opened_at IS NOT NULL) / NULLIF(COUNT(*),0), 1) as open_rate FROM crm_emails WHERE direction='outbound' AND company_id=$1 GROUP BY 1 ORDER BY 1`, [companyId]),
      pool.query(`SELECT t.name, COUNT(*) FILTER(WHERE e.opened_at IS NOT NULL) as opens, COUNT(*) FILTER(WHERE e.clicked_at IS NOT NULL) as clicks FROM crm_emails e JOIN email_templates t ON t.subject = e.subject WHERE e.direction='outbound' AND e.company_id=$1 GROUP BY t.name ORDER BY opens DESC LIMIT 5`, [companyId]),
    ]);

    res.json({
      success: true,
      data: {
        total_sent: totalRes.status === 'fulfilled' ? parseInt(totalRes.value.rows[0]?.total || 0) : 0,
        open_rate: openRes.status === 'fulfilled' ? parseFloat(openRes.value.rows[0]?.rate || 0) : 0,
        click_rate: clickRes.status === 'fulfilled' ? parseFloat(clickRes.value.rows[0]?.rate || 0) : 0,
        reply_rate: replyRes.status === 'fulfilled' ? parseFloat(replyRes.value.rows[0]?.rate || 0) : 0,
        best_send_times: hoursRes.status === 'fulfilled' ? hoursRes.value.rows : [],
        top_templates: tplRes.status === 'fulfilled' ? tplRes.value.rows : [],
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
