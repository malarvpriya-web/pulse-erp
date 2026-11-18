/**
 * deviceSync.cron.js — automatic punch-machine sync (§278).
 *
 * Owner, 2026-11-18: "I'll give the device input later, that have to be
 * synchronized automatically." Every 5 minutes this looks at each punch
 * machine that has an IP address and syncs it when its company's
 * Attendance Settings → Punch Machines → Automatic sync is on and the last
 * sync is older than the chosen interval (default 15 min).
 *
 * A device with no IP address is skipped (it is a placeholder until the
 * owner enters the address). Uses the same runDeviceSync() as the Sync now
 * button, so the punches follow the same rules (late, freeze, duplicates).
 */
import cron from 'node-cron';
import pool from '../config/db.js';
import { scheduled } from './jobRun.js';
import { runDeviceSync, deviceDriver } from '../modules/hr/biometric.routes.js';
import { getAttendanceSettingsRow } from '../shared/attendanceRules.js';

let running = false;

export async function runDeviceAutoSyncNow() {
  if (running) return { skipped: 'already running' };
  if (!deviceDriver.available()) return { skipped: 'device SDK not installed' };
  running = true;
  const out = { checked: 0, synced: 0, failed: 0 };
  try {
    const { rows: devices } = await pool.query(`
      SELECT * FROM biometric_devices
       WHERE COALESCE(NULLIF(TRIM(ip_address), ''), NULL) IS NOT NULL
       ORDER BY id`);
    for (const d of devices) {
      out.checked++;
      const s = await getAttendanceSettingsRow(d.company_id);
      const cfg = { auto_sync: true, sync_interval_minutes: 15, ...(s?.device_settings || {}) };
      if (cfg.auto_sync === false) continue;
      const interval = Math.max(5, Number(cfg.sync_interval_minutes) || 15);
      if (d.last_sync && Date.now() - new Date(d.last_sync).getTime() < (interval - 1) * 60000) continue;
      const res = await runDeviceSync(d, d.company_id).catch((e) => ({ status: 500, body: { message: e.message } }));
      if (res.status === 200) out.synced++; else out.failed++;
    }
  } finally {
    running = false;
  }
  return out;
}

export function startDeviceSyncCron() {
  cron.schedule('*/5 * * * *', scheduled('deviceAutoSync', () => runDeviceAutoSyncNow()), { scheduled: true, timezone: 'Asia/Kolkata' });
  console.log('✅ Punch machine auto-sync scheduled — every 5 min (per-company interval)');
}
