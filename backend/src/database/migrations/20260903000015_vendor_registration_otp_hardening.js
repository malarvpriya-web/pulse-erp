/**
 * Close the public vendor-registration portal's verification holes.
 *
 * `/api/vendor-registration/*` is the one procurement surface that is reachable
 * WITHOUT a session — a supplier registers themselves. Three things were wrong
 * with it, and all three are only reachable from the open internet:
 *
 * ── 1. THE OTP WAS RETURNED IN THE API RESPONSE ─────────────────────────────
 *   res.status(201).json({ ..., _dev_email_otp: process.env.NODE_ENV !== 'production' ? emailOtp : undefined })
 *
 * `NODE_ENV` is `development` in this deployment's .env, so the submit and
 * resend endpoints hand the caller both OTPs. The verification step is not
 * weakened by that, it is ABSENT: anyone can register any company, read the OTP
 * out of their own response, and verify it. A NODE_ENV check is the wrong
 * control for a secret — a staging box that is internet-reachable leaks it, and
 * the value should never be serialised at all. The backend already has
 * `sendSignerOtp()` and `sendPasswordResetOTP()`; this route ignored both.
 *
 * ── 2. UNLIMITED OTP GUESSES ────────────────────────────────────────────────
 * `resendLimit` capped how often a NEW code could be requested. Nothing capped
 * how many times an EXISTING six-digit code could be guessed. These columns add
 * the attempt counter and lockout the verify endpoints now enforce.
 *
 * ── 3. THE STATUS PAGE WAS AN ENUMERATION ORACLE ────────────────────────────
 * `GET /vendor-registration/status/:id` takes a sequential integer and needs no
 * session, so walking 1..n returns every registration in the database along with
 * the internal SCM, quality, finance and management review remarks. `access_token`
 * gives the registrant an unguessable handle to their own record; the id alone
 * no longer answers.
 *
 * Existing rows get a token so an in-flight registration does not lose access.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS email_otp_attempts  INTEGER NOT NULL DEFAULT 0`);
  await knex.raw(`ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS mobile_otp_attempts INTEGER NOT NULL DEFAULT 0`);
  await knex.raw(`ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS otp_locked_until    TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE vendor_registrations ADD COLUMN IF NOT EXISTS access_token        VARCHAR(64)`);

  // gen_random_bytes lives in pgcrypto; md5(random()) is the portable fallback
  // and is only used to seed rows that already exist, never to mint a new token
  // (the application uses crypto.randomBytes for those).
  await knex.raw(`
    UPDATE vendor_registrations
       SET access_token = COALESCE(access_token, md5(random()::text || id::text || clock_timestamp()::text)
                                                 || md5(clock_timestamp()::text || random()::text))
     WHERE access_token IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS vendor_registrations_access_token_uq
        ON vendor_registrations (access_token) WHERE access_token IS NOT NULL
  `);

  const { rows: [n] } = await knex.raw(`SELECT COUNT(*)::int AS c FROM vendor_registrations`);
  console.log(
    `[20260903000015] vendor_registrations: OTP attempt counters + lockout + access_token added; ` +
    `${n.c} existing registration(s) issued a token.`
  );
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS vendor_registrations_access_token_uq`);
  await knex.raw(`ALTER TABLE vendor_registrations DROP COLUMN IF EXISTS access_token`);
  await knex.raw(`ALTER TABLE vendor_registrations DROP COLUMN IF EXISTS otp_locked_until`);
  await knex.raw(`ALTER TABLE vendor_registrations DROP COLUMN IF EXISTS mobile_otp_attempts`);
  await knex.raw(`ALTER TABLE vendor_registrations DROP COLUMN IF EXISTS email_otp_attempts`);
}
