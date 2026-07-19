/**
 * pushSender.js — delivers push notifications to the mobile app's registered
 * device tokens (see device_push_tokens, written by /notifications/push/register
 * and the Capacitor app's registerPush).
 *
 * Implemented with node built-ins ONLY (crypto + http2 + global fetch) — no
 * firebase-admin / apn dependency — so it adds nothing to install and can't
 * break the running backend. It is credential-gated: with no FCM/APNs env
 * configured it no-ops gracefully (returns { skipped: 'push_not_configured' }),
 * exactly like the other optional integrations in this codebase.
 *
 * Configure via env:
 *   FCM (Android / web, HTTP v1):  FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY
 *   APNs (iOS, token auth):        APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY,
 *                                  APNS_BUNDLE_ID, APNS_PRODUCTION=true|false
 * (PEM keys may contain literal "\n" — they are normalised below.)
 *
 * Dead tokens (UNREGISTERED / BadDeviceToken / 410) are pruned from
 * device_push_tokens automatically.
 */

import crypto from 'crypto';
import http2 from 'http2';
import pool from '../../../config/db.js';

const pem = (v) => (v || '').replace(/\\n/g, '\n');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const fcm = {
  projectId: process.env.FCM_PROJECT_ID,
  clientEmail: process.env.FCM_CLIENT_EMAIL,
  privateKey: pem(process.env.FCM_PRIVATE_KEY),
};
const apns = {
  keyId: process.env.APNS_KEY_ID,
  teamId: process.env.APNS_TEAM_ID,
  privateKey: pem(process.env.APNS_PRIVATE_KEY),
  bundleId: process.env.APNS_BUNDLE_ID,
  production: String(process.env.APNS_PRODUCTION).toLowerCase() === 'true',
};

const fcmConfigured = () => !!(fcm.projectId && fcm.clientEmail && fcm.privateKey);
const apnsConfigured = () => !!(apns.keyId && apns.teamId && apns.privateKey && apns.bundleId);
export const isPushConfigured = () => fcmConfigured() || apnsConfigured();

// ── FCM (HTTP v1) ─────────────────────────────────────────────────────────────
let _gToken = { value: null, exp: 0 };
async function googleAccessToken() {
  if (_gToken.value && Date.now() < _gToken.exp) return _gToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: fcm.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signed = crypto.createSign('RSA-SHA256').update(`${header}.${claim}`).sign(fcm.privateKey);
  const jwt = `${header}.${claim}.${b64url(signed)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`FCM OAuth failed: ${res.status}`);
  const j = await res.json();
  _gToken = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return _gToken.value;
}

async function sendFcm(token, { title, body, data }) {
  const access = await googleAccessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${fcm.projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title, body }, data: strData(data) } }),
  });
  if (res.ok) return { ok: true };
  const err = await res.json().catch(() => ({}));
  const status = err?.error?.status;
  const dead = res.status === 404 || status === 'NOT_FOUND' || status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT';
  return { ok: false, dead, error: status || res.status };
}

// FCM data values must all be strings.
const strData = (data = {}) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v == null ? '' : String(v)]));

// ── APNs (token auth, HTTP/2) ─────────────────────────────────────────────────
let _aToken = { value: null, exp: 0 };
function apnsJwt() {
  if (_aToken.value && Date.now() < _aToken.exp) return _aToken.value;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: apns.keyId }));
  const claim = b64url(JSON.stringify({ iss: apns.teamId, iat: now }));
  const signed = crypto.createSign('SHA256').update(`${header}.${claim}`).sign({ key: apns.privateKey, dsaEncoding: 'ieee-p1363' });
  _aToken = { value: `${header}.${claim}.${b64url(signed)}`, exp: Date.now() + 50 * 60 * 1000 };
  return _aToken.value;
}

function sendApns(token, { title, body, data }) {
  return new Promise((resolve) => {
    const host = apns.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
    const client = http2.connect(host);
    client.on('error', () => resolve({ ok: false, dead: false, error: 'apns_connect' }));
    const req = client.request({
      ':method': 'POST', ':path': `/3/device/${token}`,
      authorization: `bearer ${apnsJwt()}`, 'apns-topic': apns.bundleId, 'apns-push-type': 'alert',
    });
    let status = 0, chunks = '';
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => { chunks += d; });
    req.on('end', () => {
      client.close();
      if (status === 200) return resolve({ ok: true });
      let reason = ''; try { reason = JSON.parse(chunks).reason; } catch { /* */ }
      const dead = status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered';
      resolve({ ok: false, dead, error: reason || status });
    });
    req.on('error', () => { client.close(); resolve({ ok: false, dead: false, error: 'apns_stream' }); });
    req.end(JSON.stringify({ aps: { alert: { title, body } }, ...strData(data) }));
  });
}

// ── public API ────────────────────────────────────────────────────────────────
async function pruneDead(tokens) {
  if (tokens.length) {
    await pool.query(`DELETE FROM device_push_tokens WHERE token = ANY($1)`, [tokens]).catch(() => {});
  }
}

/** Send to an explicit set of {token, platform} rows. Never throws. */
export async function sendPushToTokens(rows, payload) {
  if (!isPushConfigured()) return { skipped: 'push_not_configured' };
  let sent = 0; const dead = [];
  for (const r of rows) {
    try {
      const isApple = r.platform === 'ios';
      if (isApple && !apnsConfigured()) continue;
      if (!isApple && !fcmConfigured()) continue;
      const res = isApple ? await sendApns(r.token, payload) : await sendFcm(r.token, payload);
      if (res.ok) sent += 1;
      else if (res.dead) dead.push(r.token);
    } catch { /* keep going */ }
  }
  await pruneDead(dead);
  return { sent, pruned: dead.length };
}

/** Look up a user's devices and push to them. Never throws. */
export async function sendPushToUser(userId, payload) {
  try {
    if (!isPushConfigured() || userId == null) return { skipped: 'push_not_configured' };
    const { rows } = await pool.query(
      `SELECT token, platform FROM device_push_tokens WHERE user_id = $1`, [userId]);
    if (!rows.length) return { sent: 0 };
    return await sendPushToTokens(rows, payload);
  } catch (e) {
    console.error('[pushSender] sendPushToUser failed:', e.message);
    return { error: e.message };
  }
}
