/**
 * 20260926000014_pulse01_strip_unknown_integration_fields.js
 *
 * PULSE-01 data cleanup: remove non-allowlisted keys from stored integration
 * credentials, and drop rows whose integration_key is not a real integration.
 *
 * WHY
 * ---
 * Before the fix, `PUT /api/integrations/config/:key` merged the request body
 * into `company_integrations.credentials_enc` with no allowlist, and then
 * exported every key of that merge into `process.env`. Any authenticated user
 * could therefore leave a value AT REST under any name they liked — including
 * PERMISSION_FAIL_OPEN, NODE_ENV or ENCRYPTION_KEY. The code fix stops new ones
 * and `readStored()` already filters on the way out, so nothing planted is served
 * to a consumer. This removes what is already there, because:
 *
 *   - a stored PERMISSION_FAIL_OPEN is evidence a reviewer should not have to
 *     decrypt a blob to find, and
 *   - if a later change ever reintroduces a wholesale read, the planted value
 *     should not still be sitting there waiting for it.
 *
 * WHAT IT DOES
 * ------------
 * Decrypts each row, keeps only the fields in that integration's schema, and
 * re-encrypts. A row left with nothing is deleted rather than stored empty, so
 * the status endpoints report "Not Configured" instead of "configured with no
 * fields". Rows whose integration_key is not one of the eight real integrations
 * are deleted outright — they cannot be reached by any endpoint (isKnownIntegration
 * 404s them) and are dead weight.
 *
 * ⚠ THIS MIGRATION NEEDS `ENCRYPTION_KEY` TO BE THE SAME VALUE THE ROWS WERE
 * WRITTEN UNDER. decrypt() returns `{}` on any failure rather than throwing, so a
 * wrong key would look exactly like "the row held nothing" and would DELETE every
 * row. It therefore refuses to delete on an empty decrypt unless the ciphertext is
 * genuinely absent, and reports counts so the operator can check the arithmetic
 * against `SELECT count(*) FROM company_integrations` taken beforehand.
 *
 * ⚠ `knex` here is a SHIM over a raw pg client (src/config/migrations.js:25), so
 * bind parameters are `$1`, `$2` — NOT knex's `?`. A `?` binds nothing and the
 * statement fails at parse time.
 *
 * NOT REVERSIBLE. down() is a no-op: the removed values were not supposed to
 * exist, they are unrecoverable once dropped, and "restore the attacker's
 * environment variable" is not a rollback anyone wants. Rolling the CODE back is
 * safe and independent — the old handler simply re-accepts unknown fields.
 */

const KNOWN_FIELDS = {
  whatsapp:     ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_VERIFY_TOKEN'],
  sendgrid:     ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL', 'SENDGRID_FROM_NAME'],
  'aws-ses':    ['AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_REGION', 'AWS_SES_FROM_EMAIL'],
  smtp:         ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'],
  razorpay:     ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'],
  tally:        ['TALLY_GATEWAY_URL', 'TALLY_COMPANY'],
  'zoho-books': ['ZOHO_BOOKS_CLIENT_ID', 'ZOHO_BOOKS_CLIENT_SECRET', 'ZOHO_BOOKS_ACCESS_TOKEN',
                 'ZOHO_BOOKS_REFRESH_TOKEN', 'ZOHO_BOOKS_ORG_ID', 'ZOHO_BOOKS_DC'],
  'zoho-sign':  ['ZOHO_SIGN_CLIENT_ID', 'ZOHO_SIGN_CLIENT_SECRET', 'ZOHO_SIGN_ACCESS_TOKEN',
                 'ZOHO_SIGN_REFRESH_TOKEN', 'ZOHO_SIGN_DC'],
};

const REQUIRED = {
  whatsapp: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'],
  sendgrid: ['SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL'],
  'aws-ses': ['AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_REGION'],
  smtp: ['SMTP_HOST', 'SMTP_USER'],
  razorpay: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'],
  tally: ['TALLY_GATEWAY_URL'],
  'zoho-books': ['ZOHO_BOOKS_CLIENT_ID', 'ZOHO_BOOKS_ACCESS_TOKEN'],
  'zoho-sign': ['ZOHO_SIGN_CLIENT_ID', 'ZOHO_SIGN_ACCESS_TOKEN'],
};

export async function up(knex) {
  // Imported here rather than at module scope so the migration runner can load
  // this file even when the app's module graph is not available to it.
  const { createCipheriv, createDecipheriv, randomBytes, createHash } = await import('crypto');

  const key = () =>
    createHash('sha256')
      .update(process.env.ENCRYPTION_KEY || 'pulse_erp_dev_insecure_key_change_in_prod')
      .digest();

  const decrypt = (b64) => {
    try {
      const buf = Buffer.from(b64, 'base64');
      const d = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
    } catch {
      return null;   // null = could not decrypt, distinct from {} = decrypted empty
    }
  };

  const encrypt = (obj) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  };

  const { rows } = await knex.raw(
    `SELECT id, company_id, integration_key, credentials_enc FROM company_integrations`
  );

  const report = { scanned: rows.length, unknownKeyRowsDeleted: 0, rowsStripped: 0, rowsEmptied: 0, undecryptable: 0, fieldsRemoved: [] };

  for (const row of rows) {
    const schema = KNOWN_FIELDS[row.integration_key];

    // Not one of the eight real integrations — unreachable by any endpoint.
    if (!schema) {
      await knex.raw(`DELETE FROM company_integrations WHERE id = $1`, [row.id]);
      report.unknownKeyRowsDeleted++;
      continue;
    }

    if (!row.credentials_enc) continue;

    const creds = decrypt(row.credentials_enc);
    if (creds === null) {
      // Wrong ENCRYPTION_KEY, or corrupt ciphertext. LEAVE IT ALONE. Deleting
      // here would destroy a working tenant's credentials on a key mismatch.
      report.undecryptable++;
      continue;
    }

    const extra = Object.keys(creds).filter((f) => !schema.includes(f));
    if (!extra.length) continue;

    report.fieldsRemoved.push(...extra.map((f) => `${row.integration_key}.${f}`));

    const kept = {};
    for (const f of schema) if (creds[f] != null && String(creds[f]).trim()) kept[f] = String(creds[f]);

    if (!Object.keys(kept).length) {
      await knex.raw(`DELETE FROM company_integrations WHERE id = $1`, [row.id]);
      report.rowsEmptied++;
      continue;
    }

    const status = (REQUIRED[row.integration_key] || []).every((f) => kept[f]) ? 'connected' : 'configured';
    await knex.raw(
      `UPDATE company_integrations SET credentials_enc = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [encrypt(kept), status, row.id]
    );
    report.rowsStripped++;
  }

  // Field NAMES only — the values are exactly what must not be written anywhere.
  console.log('[PULSE-01 cleanup]', JSON.stringify({
    ...report,
    fieldsRemoved: [...new Set(report.fieldsRemoved)],
  }));

  if (report.undecryptable) {
    console.warn(
      `[PULSE-01 cleanup] ${report.undecryptable} row(s) could not be decrypted and were LEFT UNCHANGED. ` +
      `That usually means ENCRYPTION_KEY differs from the value they were written under. ` +
      `Confirm the key and re-run this migration, or those rows keep any unknown fields they hold.`
    );
  }
}

export async function down() {
  // Intentionally a no-op — see the header.
}
