import cron from 'node-cron';
import pool from '../config/db.js';
import { emitEvent } from '../shared/eventBus.js';

// Business Event Bus (Priority 8) — "Warranty expiring -> Notify sales".
// This job only detects the condition and emits; shared/eventReactions.js
// owns who gets notified and how (the actual decoupling point). Reads the
// Unified Warranty Engine table (Priority 3) — the one canonical warranty
// source as of 2026-07-28, so this single query covers Commissioning-,
// Projects-, and Operations-sourced warranties alike.
const REMINDER_DAYS = parseInt(process.env.WARRANTY_EXPIRY_REMINDER_DAYS || '30', 10);

async function runWarrantyExpiryCheck() {
  const { rows: expiring } = await pool.query(
    `SELECT id, warranty_number, product_name, customer_name, serial_number, warranty_end, company_id
     FROM warranty_registrations
     WHERE status='Active'
       AND warranty_end BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 * INTERVAL '1 day')`,
    [REMINDER_DAYS]
  );
  for (const warranty of expiring) {
    emitEvent('warranty.expiring', warranty);
  }
}

export function startWarrantyExpiryCron() {
  // Daily at 09:30 server local time (staggered from the 09:00/09:15 AMC and
  // subscription renewal crons)
  cron.schedule('30 9 * * *', () => {
    runWarrantyExpiryCheck().catch((err) =>
      console.error('[warrantyExpiryCron] failed:', err.message)
    );
  });
  console.log(`🔧 Warranty expiry cron started (daily 09:30, reminder window ${REMINDER_DAYS} days before expiry)`);
}
