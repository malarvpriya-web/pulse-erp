/**
 * 20261104000006 — PC-02b-0 B-04: remove the bank-file purge bypass (04 Nov 26).
 * MODULE_FEATURE_CONNECTION_MANUAL.md §238.
 *
 * 20261104000005's trigger let a DELETE through when the transaction had set
 * `pulse.allow_bank_file_purge = 'on'`. Any database user can set a custom setting,
 * so that was no protection. The trigger now refuses UPDATE, DELETE and TRUNCATE
 * with no condition, and PUBLIC holds no destructive right on the table.
 *
 * A trigger still does not bind a superuser or the table's owner, and these are
 * the role the application connects as today. The boundary for those is role
 * separation: scripts/db/bank-file-least-privilege.mjs, run with privileged
 * credentials after the application has moved to an ordinary role. A migration
 * cannot do this, because it runs on the application's own credentials.
 *
 * No rows change. Down: REFUSES while any released file exists, because it would
 * restore the bypass over real records; otherwise restores 20261104000005's
 * function exactly. The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION payment_batch_files_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION 'payment_batch_files is immutable: a released bank file cannot be %', lower(TG_OP)
        USING ERRCODE = 'P0001', HINT = 'Void and re-release are handled by B-05; nothing may edit a released file.';
    END
    $fn$`);
  await knex.raw(`REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES ON payment_batch_files FROM PUBLIC`);
  await knex.raw(`REVOKE ALL ON FUNCTION payment_batch_files_immutable() FROM PUBLIC`);
}

export async function down(knex) {
  const { rows: [{ n }] } = await knex.raw(`SELECT COUNT(*)::int AS n FROM payment_batch_files`);
  if (n > 0) throw new Error(`Refusing to roll back 20261104000006: ${n} released bank file(s) exist, and rolling back restores a settable bypass over them.`);
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
  await knex.raw(`GRANT EXECUTE ON FUNCTION payment_batch_files_immutable() TO PUBLIC`);
}
