/**
 * esignReminder.cron.js — auto-reminder scheduler for outstanding signatures.
 *
 * Runs hourly. For every 'sent' request with auto_reminder enabled, emails the
 * pending signers again once reminder_interval_days have elapsed since the last
 * reminder (or the send date), up to max_reminders. Skips expired requests.
 */

import cron from 'node-cron';
import pool from '../config/db.js';
import { sendSigningReminder } from '../utils/mailer.js';

async function runReminderSweep() {
  const { rows: due } = await pool.query(
    `SELECT * FROM document_signings
      WHERE auto_reminder = TRUE
        AND status = 'sent'
        AND is_locked = FALSE
        AND COALESCE(reminder_count, 0) < COALESCE(max_reminders, 3)
        AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
        AND (
          last_reminder_at IS NULL
          OR last_reminder_at < NOW() - (COALESCE(reminder_interval_days, 3) || ' days')::interval
        )
        AND COALESCE(sent_date, created_at::date) < CURRENT_DATE
      LIMIT 200`
  );

  for (const doc of due) {
    const { rows: pending } = await pool.query(
      `SELECT * FROM signature_signers
        WHERE signing_id = $1 AND status NOT IN ('signed','declined')
        ORDER BY signing_order`,
      [doc.id]
    );
    if (!pending.length) continue;

    // Sequential requests: remind only the current signer
    const targets = doc.signing_mode === 'sequential' ? [pending[0]] : pending;

    for (const s of targets) {
      try {
        await sendSigningReminder(s.signer_email, {
          signerName: s.signer_name, documentTitle: doc.title, token: s.sign_token,
        });
      } catch (e) {
        console.error(`[esignReminder] ${doc.id}/${s.signer_email}:`, e.message);
      }
    }

    await pool.query(
      `UPDATE document_signings
          SET reminder_count = COALESCE(reminder_count,0) + 1, last_reminder_at = NOW()
        WHERE id = $1`,
      [doc.id]
    );

    await pool.query(
      `INSERT INTO signature_audit_log (signing_id, event, actor_name, event_data)
       VALUES ($1, 'auto_reminder', 'system', $2)`,
      [doc.id, JSON.stringify({ signers: targets.map(t => t.signer_email) })]
    ).catch(() => {});
  }

  if (due.length) console.log(`[esignReminder] processed ${due.length} request(s)`);
}

export function startEsignReminderCron() {
  // Hourly, on the hour
  cron.schedule('0 * * * *', () => {
    runReminderSweep().catch(err => console.error('[esignReminder] sweep failed:', err.message));
  });
  console.log('✍️  E-sign auto-reminder cron started (hourly)');
}
