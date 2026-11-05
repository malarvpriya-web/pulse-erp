/**
 * 20261104000005 — PC-02b-0 B-04: released bank files (04 Nov 26).
 * MODULE_FEATURE_CONNECTION_MANUAL.md §237.
 *
 * GET /finance/payment-batches/:id/bank-file used to rebuild the file on every
 * request, in any batch status, from LIVE unverified vendors.account_number /
 * ifsc, with nothing stored, hashed or audited. A batch's bank file is now
 * released ONCE (POST /payment-batches/:id/release) and stored here:
 *
 *   payment_batch_files — one row per batch (unique batch_id): the rendered
 *   content, its SHA-256, the format, line count and total, the beneficiary
 *   snapshot (from Finance-verified vendor_bank_details), the releasing user and
 *   time, the batch's company. Downloads serve these stored bytes only.
 *
 * Immutable at the database level (B4-6): a trigger refuses every UPDATE and
 * TRUNCATE, and every DELETE unless the transaction has deliberately set
 * `SET LOCAL pulse.allow_bank_file_purge = 'on'` (test cleanup / an explicit,
 * audited administrative purge — no API sets it). Void / re-release is B-05.
 *
 * FKs are RESTRICT: a batch, company or user with a released file cannot be deleted.
 * Down: REFUSES while any released file exists; otherwise drops the table and function.
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS payment_batch_files (
      id             SERIAL PRIMARY KEY,
      batch_id       INTEGER NOT NULL UNIQUE REFERENCES payment_batches(id) ON DELETE RESTRICT,
      company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      format         VARCHAR(20) NOT NULL CHECK (format IN ('generic', 'sbi', 'hdfc', 'icici')),
      file_name      TEXT NOT NULL,
      content        TEXT NOT NULL,
      sha256         CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      line_count     INTEGER NOT NULL CHECK (line_count >= 0),
      total_amount   NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
      beneficiaries  JSONB NOT NULL,
      released_by    INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      released_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_payment_batch_files_company ON payment_batch_files (company_id)`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION payment_batch_files_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF TG_OP = 'DELETE' AND current_setting('pulse.allow_bank_file_purge', true) = 'on' THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'payment_batch_files is immutable: a released bank file cannot be %', lower(TG_OP)
        USING ERRCODE = 'P0001', HINT = 'Void and re-release are handled by B-05; nothing may edit a released file.';
    END
    $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS payment_batch_files_no_change ON payment_batch_files`);
  await knex.raw(`CREATE TRIGGER payment_batch_files_no_change BEFORE UPDATE OR DELETE ON payment_batch_files
                    FOR EACH ROW EXECUTE FUNCTION payment_batch_files_immutable()`);
  await knex.raw(`DROP TRIGGER IF EXISTS payment_batch_files_no_truncate ON payment_batch_files`);
  await knex.raw(`CREATE TRIGGER payment_batch_files_no_truncate BEFORE TRUNCATE ON payment_batch_files
                    FOR EACH STATEMENT EXECUTE FUNCTION payment_batch_files_immutable()`);
}

export async function down(knex) {
  const { rows: [t] } = await knex.raw(`SELECT to_regclass('public.payment_batch_files') AS t`);
  if (t.t) {
    const { rows: [{ n }] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM payment_batch_files`);
    if (n > 0) throw new Error(`Refusing to roll back 20261104000005: ${n} released bank file(s) would be discarded. They are the record of what was sent to the bank.`);
    await knex.raw(`DROP TABLE payment_batch_files`);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS payment_batch_files_immutable()`);
}
