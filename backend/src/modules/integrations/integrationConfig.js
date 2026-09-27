/**
 * integrationConfig.js — the single source of truth for integration credentials.
 *
 * WHY THIS FILE EXISTS (PULSE-01, audit 2026-09-20/21)
 * ===================================================
 * `integrations-config.routes.js` used to end its PUT handler with:
 *
 *     function applyToEnv(key, creds) {
 *       for (const [envKey, val] of Object.entries(creds)) {
 *         if (val && String(val).trim()) process.env[envKey] = String(val).trim();
 *       }
 *     }
 *
 * `creds` was the merge of the REQUEST BODY with no allowlist, so the body's KEYS
 * were environment variable names. Three things followed, and all three were
 * reproduced against the real router before this file was written:
 *
 *  1. ARBITRARY PROCESS ENV WRITE. The route was mounted with `verifyToken` only,
 *     so any authenticated employee could set any variable in the process. The one
 *     that matters most is PERMISSION_FAIL_OPEN: auth.middleware.js reads it from
 *     process.env on EVERY request (not at boot), and `=true` makes
 *     requirePermission() pass when a module has no permission row. An `employee`
 *     account went from 403 to 200 on a fail-closed gate with one PUT, no deploy
 *     and no restart. NODE_ENV=development was next: auth.service.js returns the
 *     password-reset OTP in the response body outside production, which is
 *     account takeover of anyone including super_admin, and errorSanitizer stands
 *     down. ENCRYPTION_KEY was third — derivedKey() reads it per call, so setting
 *     it makes every later credential write decryptable by the attacker while
 *     every existing row silently decrypts to `{}`.
 *
 *  2. NO TENANT ISOLATION, STRUCTURALLY. `process.env` is process-global. One
 *     tenant's SMTP_HOST, SENDGRID_API_KEY or RAZORPAY_KEY_ID became the value
 *     every other tenant's send path read, and envStatus() then reported
 *     "Connected" to tenants that had configured nothing. For Razorpay that means
 *     one tenant's customers paying into another tenant's account. A per-tenant
 *     encrypted row cannot express that bug.
 *
 *  3. NO SCHEMA. Unknown field names were persisted and exported to the
 *     environment, and values were never validated — SMTP_PORT='not-a-port' was
 *     accepted.
 *
 * WHAT THIS FILE DOES INSTEAD
 * ---------------------------
 * Nothing here ever writes to `process.env`. That is the invariant, and
 * `integration.integrationsConfigSecurity.test.js` asserts it by snapshotting the whole
 * environment across a save. Reads fall back to process.env so a single-tenant
 * that configures credentials in its .env keeps working, but the fallback is
 * one-way: env is deploy-level input, never an output.
 *
 * ⚠ THE ALLOWLIST IS THE CONTROL, NOT A DENYLIST. A denylist of dangerous
 * variable names would have to enumerate every env var any dependency ever reads
 * — NODE_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED, PATH, PGSSLMODE — and would be
 * wrong the next time someone adds a feature flag. INTEGRATION_FIELDS below is
 * the complete set of names a request may name, each with a validator. Anything
 * else is a 400. FORBIDDEN_FIELD_NAMES exists only as a tripwire on this file's
 * own future edits (see assertAllowlistIsSafe) — it is not the gate.
 *
 * ⚠ FIELD NAMES ARE STILL SPELLED LIKE ENV VARS (SMTP_HOST, not smtp_host). That
 * is deliberate: the frontend form in IntegrationsHub.jsx keys its inputs by
 * those exact names and existing encrypted rows are stored under them, so
 * renaming would break both for no security gain now that nothing exports them.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import pool from '../../config/db.js';

// ── Encryption (AES-256-GCM) ──────────────────────────────────────────────────
// Format and key derivation are byte-for-byte what integrations-config.routes.js
// wrote before this refactor, so rows written by the old code still decrypt.

const DEV_FALLBACK_KEY = 'pulse_erp_dev_insecure_key_change_in_prod';
const MIN_KEY_LENGTH = 32;
let warnedWeakKey = false;

/**
 * Thrown when a stored ciphertext will not authenticate.
 *
 * ⚠ THIS EXISTS BECAUSE THE FAILURE USED TO BE INVISIBLE. `decrypt()` caught
 * every error and returned `{}`, which is indistinguishable from "this tenant has
 * configured nothing". So rotating or mistyping ENCRYPTION_KEY did not raise
 * anything — every integration in every tenant simply reported "Not Configured"
 * and silently stopped sending. An AES-GCM tag mismatch is a DETECTABLE event
 * (`decipher.final()` throws), and throwing it away was the bug.
 */
export class CredentialDecryptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialDecryptError';
    this.code = 'CREDENTIAL_DECRYPT_FAILED';
  }
}

/**
 * The AES key, derived from ENCRYPTION_KEY.
 *
 * ⚠ Guarded HERE as well as at boot (`server.js` checkRequiredEnv). The boot
 * check only runs when server.js is the entry point — a cron, a migration, a
 * seed script or a test importing this module directly never sees it, and those
 * are exactly the contexts that write credentials unattended.
 */
function derivedKey() {
  const raw = process.env.ENCRYPTION_KEY;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!raw) {
    if (isProduction) {
      throw new Error(
        'ENCRYPTION_KEY is not set. Integration credentials cannot be encrypted or read. ' +
        'Set it in the server environment — there is no production fallback.'
      );
    }
    if (!warnedWeakKey) {
      warnedWeakKey = true;
      console.warn(JSON.stringify({
        ts: new Date().toISOString(), level: 'WARN', event: 'encryption_key_missing',
        message: 'ENCRYPTION_KEY is not set — integration credentials are encrypted with a ' +
                 'key that is published in this source file. Development only.',
      }));
    }
    return createHash('sha256').update(DEV_FALLBACK_KEY).digest();
  }

  if (isProduction && raw.length < MIN_KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY is only ${raw.length} characters. At least ${MIN_KEY_LENGTH} are required in production.`
    );
  }
  if (!isProduction && raw.length < MIN_KEY_LENGTH && !warnedWeakKey) {
    warnedWeakKey = true;
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'WARN', event: 'encryption_key_weak',
      length: raw.length, required: MIN_KEY_LENGTH,
      message: `ENCRYPTION_KEY is shorter than ${MIN_KEY_LENGTH} characters. This would refuse to boot in production.`,
    }));
  }
  return createHash('sha256').update(raw).digest();
}

export function encrypt(obj) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/**
 * Decrypt, THROWING on a tag mismatch.
 *
 * An empty or absent ciphertext is genuinely "nothing stored" and returns `{}`.
 * Anything else that fails is a wrong key or a corrupt row, and that is an
 * operational fault the operator must see — see CredentialDecryptError.
 */
export function decryptStrict(b64) {
  if (b64 == null || String(b64).trim() === '') return {};
  try {
    const buf = Buffer.from(b64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', derivedKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  } catch (err) {
    // A derivedKey() failure is a configuration error, not a ciphertext problem —
    // let it through as itself rather than relabelling it.
    if (err instanceof Error && /ENCRYPTION_KEY/.test(err.message)) throw err;
    throw new CredentialDecryptError(
      'Stored integration credentials could not be decrypted. This usually means ENCRYPTION_KEY ' +
      'differs from the value they were encrypted under (a rotation without re-encryption), ' +
      'or the row is corrupt.'
    );
  }
}

/**
 * Lenient decrypt — `{}` on any failure.
 *
 * ⚠ Prefer decryptStrict(). This is kept only for callers that genuinely cannot
 * act on the distinction, and it is the shape that hid a key mismatch as
 * "not configured" before PULSE-01. Every caller in this module uses the strict
 * form; the data-cleanup migration deliberately keeps its own lenient copy so a
 * key mismatch there leaves rows untouched instead of deleting them.
 */
export function decrypt(b64) {
  try {
    return decryptStrict(b64);
  } catch {
    return {};
  }
}

// ── Validators ────────────────────────────────────────────────────────────────
// Each returns null when the value is acceptable, or a message explaining why not.
const str = (max = 512) => (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? null : `must be text of 1–${max} characters`;

const oneOf = (...allowed) => (v) =>
  allowed.includes(v) ? null : `must be one of: ${allowed.join(', ')}`;

const port = (v) => {
  if (!/^\d{1,5}$/.test(v)) return 'must be a whole number';
  const n = Number(v);
  return n >= 1 && n <= 65535 ? null : 'must be between 1 and 65535';
};

const email = (v) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254 ? null : 'must be a valid email address';

/**
 * A hostname or bare IP — no scheme, no path, no credentials, no whitespace.
 *
 * Rejecting the scheme is what stops `SMTP_HOST=http://evil/?x=` and the
 * `user:pass@host` form, either of which redirects a connection somewhere the
 * field name does not suggest.
 */
const host = (v) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 253) return 'must be a hostname of 1–253 characters';
  if (/[\s/\\@?#]/.test(v)) return 'must be a bare hostname or IP — no scheme, path, credentials or spaces';
  // An IPv6 literal is a legitimate mail host, and the hostname pattern below
  // cannot express one because of the colons. Accepted bare or bracketed —
  // nodemailer takes both. Found by adversarially testing this validator: the
  // first version simply refused them, which is a functional regression wearing a
  // security control's clothes.
  if (v.includes(':')) {
    const inner = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
    return /^[0-9A-Fa-f:]+$/.test(inner) && (inner.match(/:/g) || []).length >= 2
      ? null
      : 'is not a valid hostname or IPv6 address';
  }
  return /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(v) ? null : 'is not a valid hostname or IP';
};

/**
 * An http(s) URL for an outbound gateway.
 *
 * ⚠ This is NOT an SSRF control. It bounds the scheme and shape; it cannot know
 * whether the host is somewhere this server should be talking to. The gateway URL
 * is a tenant's own on-premise Tally box, frequently a private address, so a
 * private-range block would break the legitimate case. The control that matters
 * is that only an integration administrator can set it — see the route gate.
 */
const httpUrl = (v) => {
  let u;
  try { u = new URL(v); } catch { return 'must be a valid URL'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'must use http:// or https://';
  if (u.username || u.password) return 'must not embed credentials';
  return v.length <= 512 ? null : 'must be 512 characters or fewer';
};

// ── THE ALLOWLIST ─────────────────────────────────────────────────────────────
// `secret: true` means the value is masked in every GET response and redacted
// from every audit entry. Add a field here and nowhere else.
const F = (validate, secret = false) => ({ validate, secret });

export const INTEGRATION_FIELDS = Object.freeze({
  whatsapp: {
    WHATSAPP_TOKEN:        F(str(2048), true),
    WHATSAPP_PHONE_ID:     F(str(64)),
    WHATSAPP_VERIFY_TOKEN: F(str(256), true),
  },
  sendgrid: {
    SENDGRID_API_KEY:    F(str(256), true),
    SENDGRID_FROM_EMAIL: F(email),
    SENDGRID_FROM_NAME:  F(str(128)),
  },
  'aws-ses': {
    AWS_SES_ACCESS_KEY_ID:     F(str(128), true),
    AWS_SES_SECRET_ACCESS_KEY: F(str(256), true),
    AWS_SES_REGION:            F(str(32)),
    AWS_SES_FROM_EMAIL:        F(email),
  },
  smtp: {
    SMTP_HOST:   F(host),
    SMTP_PORT:   F(port),
    SMTP_USER:   F(str(254)),
    SMTP_PASS:   F(str(256), true),
    SMTP_FROM:   F(email),
    SMTP_SECURE: F(oneOf('true', 'false', 'ssl')),
  },
  razorpay: {
    RAZORPAY_KEY_ID:         F(str(128), true),
    RAZORPAY_KEY_SECRET:     F(str(256), true),
    RAZORPAY_WEBHOOK_SECRET: F(str(256), true),
  },
  tally: {
    TALLY_GATEWAY_URL: F(httpUrl),
    TALLY_COMPANY:     F(str(128)),
  },
  'zoho-books': {
    ZOHO_BOOKS_CLIENT_ID:     F(str(128)),
    ZOHO_BOOKS_CLIENT_SECRET: F(str(256), true),
    ZOHO_BOOKS_ACCESS_TOKEN:  F(str(2048), true),
    ZOHO_BOOKS_REFRESH_TOKEN: F(str(2048), true),
    ZOHO_BOOKS_ORG_ID:        F(str(64)),
    ZOHO_BOOKS_DC:            F(oneOf('IN', 'US', 'EU', 'AU')),
  },
  'zoho-sign': {
    ZOHO_SIGN_CLIENT_ID:     F(str(128)),
    ZOHO_SIGN_CLIENT_SECRET: F(str(256), true),
    ZOHO_SIGN_ACCESS_TOKEN:  F(str(2048), true),
    ZOHO_SIGN_REFRESH_TOKEN: F(str(2048), true),
    ZOHO_SIGN_DC:            F(oneOf('IN', 'US', 'EU', 'AU')),
  },
});

/**
 * Integrations whose credentials MOVE MONEY, and which therefore must NOT fall
 * back to the deployment environment when a tenant's stored row fails to decrypt.
 *
 * ⚠⚠ THIS IS A CORRECTION TO AN EARLIER DECISION IN THIS FILE, and the reasoning
 * matters more than the list.
 *
 * `resolveConfig` degrades on a `CredentialDecryptError`: it logs loudly and uses
 * the deployment's env vars, so a key rotation does not take every outbound
 * notification down with it. For mail and messaging that is the right trade — the
 * worst case is a payslip sent from the platform's mail server instead of the
 * tenant's.
 *
 * For Razorpay it is NOT. The env fallback on a multi-tenant deployment holds the
 * PLATFORM's keys, so degrading would take a tenant's customer payment into the
 * platform's Razorpay account — and `/verify` would then check the HMAC with that
 * same platform secret, so the signature VERIFIES and the invoice is marked paid.
 * The money is in the wrong account and nothing looks wrong. A rotated encryption
 * key would quietly redirect revenue.
 *
 * So for these keys a decrypt failure yields `{}` — no stored values, no env
 * fallback — and every payment handler's existing `if (!keyId || !keySecret)`
 * guard turns that into a refusal (503 `payment_gateway_not_configured` in
 * production). Refusing to take a payment is recoverable; taking it into the wrong
 * account is not.
 *
 * Declared here rather than passed by each caller on purpose: a caller can forget,
 * and the property belongs to the integration.
 */
export const FAIL_CLOSED_ON_DECRYPT = Object.freeze(new Set(['razorpay']));

/** Fields that must all be present before an integration counts as connected. */
export const INTEGRATION_REQUIRED = Object.freeze({
  whatsapp:     ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'],
  sendgrid:     ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'],
  'aws-ses':    ['AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_REGION'],
  smtp:         ['SMTP_HOST', 'SMTP_USER'],
  razorpay:     ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
  tally:        ['TALLY_GATEWAY_URL'],
  'zoho-books': ['ZOHO_BOOKS_CLIENT_ID', 'ZOHO_BOOKS_ACCESS_TOKEN'],
  'zoho-sign':  ['ZOHO_SIGN_CLIENT_ID', 'ZOHO_SIGN_ACCESS_TOKEN'],
});

export const INTEGRATION_KEYS = Object.freeze(Object.keys(INTEGRATION_FIELDS));

export const isKnownIntegration = (key) =>
  typeof key === 'string' && Object.prototype.hasOwnProperty.call(INTEGRATION_FIELDS, key);

export const isSecretField = (key, field) => !!INTEGRATION_FIELDS[key]?.[field]?.secret;

/**
 * Names that must never become writable through a tenant-facing API, whatever a
 * later edit to INTEGRATION_FIELDS says.
 *
 * ⚠ This is a tripwire on this file, NOT the request-path gate. The gate is that
 * INTEGRATION_FIELDS is an allowlist, so an attacker cannot name anything absent
 * from it. This list catches the OTHER failure: a future maintainer adding a
 * field that happens to collide with process-wide security configuration. It is
 * asserted by the test suite and by assertAllowlistIsSafe() at import time, and
 * each entry is here because something in this repo reads it at REQUEST time
 * (grep the name to see where) and would therefore change behaviour live.
 */
export const FORBIDDEN_FIELD_NAMES = Object.freeze([
  'NODE_ENV', 'PERMISSION_FAIL_OPEN', 'PERMISSION_STRICT',
  'JWT_SECRET', 'ENCRYPTION_KEY', 'SESSION_SECRET',
  'DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'DB_SSL', 'DB_SSL_REJECT_UNAUTHORIZED',
  'AUTH_RL_MAX', 'AUTH_RL_WINDOW_MS', 'IOT_PREAUTH_RL_MAX',
  'LOG_TO_FILE', 'CORS_ORIGIN', 'PORT',
  'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'PATH', 'LD_PRELOAD',
  'RUN_SUCCESSION_SEED', 'VITEST',
]);

/**
 * Fails fast at import time if the allowlist has grown a field that collides
 * with process-wide configuration. Better a boot failure than a silent
 * reintroduction of PULSE-01.
 */
export function assertAllowlistIsSafe() {
  const forbidden = new Set(FORBIDDEN_FIELD_NAMES);
  const clashes = [];
  for (const [key, fields] of Object.entries(INTEGRATION_FIELDS)) {
    for (const field of Object.keys(fields)) {
      if (forbidden.has(field)) clashes.push(`${key}.${field}`);
    }
  }
  if (clashes.length) {
    throw new Error(
      `[PULSE-01] INTEGRATION_FIELDS names process-wide configuration: ${clashes.join(', ')}. ` +
      `Tenant-facing integration fields must never share a name with security or infrastructure config.`
    );
  }
}
assertAllowlistIsSafe();

// ── Validation ────────────────────────────────────────────────────────────────
/**
 * Validate a submitted body against one integration's schema.
 *
 * Returns `{ ok: true, fields }` where `fields` contains ONLY allowlisted,
 * validated entries, or `{ ok: false, unknown, invalid }`.
 *
 * Unknown fields are REJECTED rather than dropped. Silently ignoring them would
 * let an administrator believe a setting was saved when it was not, and it would
 * hide an attempt to reach a field that is deliberately out of reach.
 *
 * The sentinel '***' means "leave the stored value alone" — it is what a GET
 * returns for a secret, so a form round-trip submits it back unchanged. It is
 * skipped, not treated as a value.
 */
export function validateFields(key, body) {
  const schema = INTEGRATION_FIELDS[key];
  if (!schema) return { ok: false, unknown: [], invalid: [{ field: 'key', message: 'unknown integration' }] };

  const unknown = [];
  const invalid = [];
  const fields = {};

  for (const [field, rawValue] of Object.entries(body ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(schema, field)) { unknown.push(field); continue; }
    // Objects and arrays are never valid here; coercing them would stringify to
    // '[object Object]' and store nonsense.
    if (rawValue !== null && typeof rawValue === 'object') {
      invalid.push({ field, message: 'must be a single text value' });
      continue;
    }
    const value = String(rawValue ?? '').trim();
    if (value === '' || value === '***') continue;        // untouched / masked round-trip
    const message = schema[field].validate(value);
    if (message) invalid.push({ field, message });
    else fields[field] = value;
  }

  if (unknown.length || invalid.length) return { ok: false, unknown, invalid };
  return { ok: true, fields };
}

/** True when every required field for `key` is present in `creds`. */
export function allRequiredPresent(key, creds) {
  return (INTEGRATION_REQUIRED[key] || []).every(
    (f) => creds?.[f] != null && String(creds[f]).trim().length > 0
  );
}

// ── Tenant-scoped store ───────────────────────────────────────────────────────
/**
 * Company id for an integration row.
 *
 * `companyOf(req)` returns null for a genuinely global scope (a super admin with
 * no company assignment). Integration credentials are tenant data, so null is
 * mapped to the reserved id 0 — the deployment-level row, matching the column's
 * own `DEFAULT 0`. Callers that must not write globally check the scope
 * themselves; see requireTenantScope in the routes.
 */
export const GLOBAL_COMPANY_ID = 0;
const rowCompanyId = (companyId) => (companyId == null ? GLOBAL_COMPANY_ID : companyId);

/** Drop anything not in this integration's schema. */
function pickAllowlisted(key, creds) {
  const schema = INTEGRATION_FIELDS[key] ?? {};
  const out = {};
  for (const field of Object.keys(schema)) {
    if (creds?.[field] != null && String(creds[field]).trim()) out[field] = String(creds[field]);
  }
  return out;
}

/**
 * The stored credentials for one tenant and integration — decrypted, no env.
 * `{}` when nothing is stored.
 *
 * ⚠ FILTERED THROUGH THE ALLOWLIST ON THE WAY OUT, not only on the way in. Rows
 * written before PULSE-01 was fixed can hold ANY key, because the old handler
 * merged the request body wholesale. Two things follow, and the filter is what
 * prevents both:
 *
 *  - an attacker-planted value sitting at rest is never handed to a consumer, and
 *    is dropped from the row the next time it is saved (saveConfig merges THIS
 *    output as `prev`);
 *  - the configure form stays usable. It pre-fills from GET and submits what it
 *    was given, so a legacy junk key would come straight back as an UNKNOWN_FIELD
 *    400 and the administrator could never save anything again.
 *
 * migrations/20260921000001_pulse01_strip_unknown_integration_fields.js rewrites
 * existing rows so the data is clean too; this makes the code correct even if the
 * migration has not run.
 */
export async function readStored(companyId, key, executor = pool) {
  if (!isKnownIntegration(key)) return {};
  const { rows } = await executor.query(
    `SELECT credentials_enc FROM company_integrations
      WHERE company_id = $1 AND integration_key = $2 LIMIT 1`,
    [rowCompanyId(companyId), key]
  );
  if (!rows.length) return {};
  // Throws CredentialDecryptError on a key mismatch rather than reporting the
  // tenant as unconfigured. Callers that must degrade instead of failing catch it
  // explicitly — see resolveConfig.
  return pickAllowlisted(key, decryptStrict(rows[0].credentials_enc));
}

/**
 * Effective configuration for one tenant: stored row first, `process.env` only
 * as a fallback for fields the tenant has not set.
 *
 * The env fallback is what keeps a single-tenant deployment that configures
 * SMTP/Razorpay in its .env working unchanged, and what keeps this change
 * backward compatible. It is READ-ONLY in every direction: nothing in this
 * module assigns to process.env.
 *
 * ⚠ Consumers must pass the CALLER'S company (companyOf(req)), not a cached or
 * ambient one. Passing the wrong company here is the tenant-isolation bug this
 * whole change exists to remove.
 *
 * ⚠ `executor` exists because reaching for the module-level pool BROKE A CALLER'S
 * CONTRACT. `journeyEngine.runEnrollment(pool, id)` is given its DB handle by the
 * caller, and its unit tests inject a fake one; when this function quietly used
 * the global pool instead, a pure unit test started opening a real connection and
 * failed with "password authentication failed for user postgres" instead of the
 * assertion it was written for. Any caller that was handed an executor must pass
 * it through — the convention `eInvoice.service.js` already uses.
 */
export async function resolveConfig(companyId, key, executor = pool) {
  const schema = INTEGRATION_FIELDS[key];
  if (!schema) return {};
  // A decrypt failure DEGRADES here rather than failing the send — an operator
  // fixing a key rotation should not also be dealing with 500s on every outbound
  // email — but it is logged loudly, once per company+integration, so it does not
  // become the silent "Not Configured" that hid the problem before. The
  // administration routes let the same error surface as a 500, because that is
  // where someone can act on it.
  let stored = {};
  try {
    stored = await readStored(companyId, key, executor);
  } catch (err) {
    if (err?.code !== 'CREDENTIAL_DECRYPT_FAILED') throw err;   // a missing/short ENCRYPTION_KEY is not something to paper over
    warnDecryptOnce(companyId, key, err);
    // Money integrations do not degrade to the deployment's credentials — see
    // FAIL_CLOSED_ON_DECRYPT. Returning nothing makes the caller's existing
    // "not configured" guard refuse the operation.
    if (FAIL_CLOSED_ON_DECRYPT.has(key)) return {};
  }
  const out = {};
  for (const field of Object.keys(schema)) {
    const value = stored[field] ?? process.env[field] ?? '';
    if (String(value).trim()) out[field] = String(value).trim();
  }
  return out;
}

/**
 * One warning per company+integration per process. Without the dedupe a broken
 * key would print on every notification email and bury everything else.
 */
const _decryptWarned = new Set();
function warnDecryptOnce(companyId, key, err) {
  const id = `${companyId ?? 'global'}:${key}`;
  if (_decryptWarned.has(id)) return;
  _decryptWarned.add(id);
  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'ERROR', event: 'credential_decrypt_failed',
    company_id: companyId ?? null, integration: key, code: err.code,
    message: err.message + ' Falling back to the deployment environment for this integration. ' +
             'Until it is resolved, the credentials saved for this tenant are NOT in use.',
  }));
}

/** 'connected' | 'configured' | 'not_configured' for one tenant. */
export async function resolveStatus(companyId, key) {
  const cfg = await resolveConfig(companyId, key);
  if (allRequiredPresent(key, cfg)) return 'connected';
  return Object.keys(cfg).length ? 'configured' : 'not_configured';
}

/**
 * Merge validated fields into a tenant's stored credentials and persist.
 *
 * Returns `{ status, changedFields }`. `changedFields` is NAMES ONLY — it feeds
 * the audit entry, and an audit log holding credential values is a liability
 * rather than a control.
 */
export async function saveConfig(companyId, key, fields) {
  const prev = await readStored(companyId, key);
  const merged = { ...prev, ...fields };
  const changedFields = Object.keys(fields).filter((f) => prev[f] !== fields[f]);
  const status = allRequiredPresent(key, merged) ? 'connected' : 'configured';

  await pool.query(
    `INSERT INTO company_integrations (company_id, integration_key, credentials_enc, status, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (company_id, integration_key)
     DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc,
                   status          = EXCLUDED.status,
                   updated_at      = NOW()`,
    [rowCompanyId(companyId), key, encrypt(merged), status]
  );

  return { status, changedFields };
}

/** Replace every secret value with '***', leaving non-secret fields readable. */
export function maskSecrets(key, creds) {
  const out = {};
  for (const [field, value] of Object.entries(creds ?? {})) {
    out[field] = value && isSecretField(key, field) ? '***' : value;
  }
  return out;
}
