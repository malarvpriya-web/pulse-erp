/**
 * 20261014000001_commissioning_numbering_sequences.js
 *
 * Company-safe numbering for commissioning workflows, certificates, warranties
 * and warranty claims (LEGACY_MIS_TO_PULSE_AUDIT.md, P1).
 *
 * Problem: every generator was COUNT(*) of the caller's company + 1, while
 *   commissioning_workflows.workflow_number   UNIQUE (all companies)
 *   warranty_registrations.warranty_number    UNIQUE (all companies)
 *   warranty_claims.claim_number              UNIQUE (all companies)
 * so a second company's first record reused the first company's number and the
 * insert failed, and two concurrent creates in one company raced on one COUNT.
 *   commissioning_workflows.certificate_number had NO unique constraint, so
 * the same certificate number was silently issued in different companies.
 *
 * Fix: one global sequence per document type, used by shared/docNumber.js —
 * the same mechanism as seq_amc / seq_prj (20260520000002_document_sequences.js).
 * nextval() never returns a value twice, including under concurrency.
 * Formats are unchanged:
 *   seq_cw    CW-YY-NNNN       commissioning_workflows.workflow_number
 *   seq_cert  CERT-YYYY-NNNN   commissioning_workflows.certificate_number
 *   seq_wr    WR-NNNNN         warranty_registrations.warranty_number
 *   seq_wc    WC-NNNNN         warranty_claims.claim_number
 * Each sequence starts after the highest number already in that format, read
 * while the tables are locked against writes, so no existing identifier can
 * be generated again. Existing rows are not touched.
 *
 * Also adds a unique index on certificate_number (non-null) so the database
 * itself refuses a duplicate certificate — but only when the existing data has
 * no duplicates. If it has, the index is skipped with a warning: renumbering a
 * certificate already handed to a customer is a business decision, not a
 * migration step. New numbers stay unique either way (they come from seq_cert).
 *
 * Rollback (`npm run migrate:rollback`) drops the index and the four sequences.
 * It must be deployed together with the previous application code, which does
 * not use them; the new code fails with "relation seq_cw does not exist" without
 * them. Numbers issued in between stay valid — the old generators would then
 * restart from per-company counts and can collide again (the original defect).
 * Re-applying is safe: the sequences are reseeded from the data at that time.
 */

const SEQUENCES = [
  // [sequence, table, column, regex capturing the running number]
  ['seq_cw',   'commissioning_workflows', 'workflow_number',    '^CW-[0-9]{2}-([0-9]+)$'],
  ['seq_cert', 'commissioning_workflows', 'certificate_number', '^CERT-[0-9]{4}-([0-9]+)$'],
  ['seq_wr',   'warranty_registrations',  'warranty_number',    '^WR-([0-9]+)$'],
  ['seq_wc',   'warranty_claims',         'claim_number',       '^WC-([0-9]+)$'],
];

const CERT_INDEX = 'ux_commissioning_workflows_certificate_number';

export async function up(knex) {
  // Block writers while the maxima are read, so a number created by the old
  // code mid-migration cannot slip under a sequence's start value. Readers are
  // not blocked; the runner holds this transaction only for this migration.
  await knex.raw(`LOCK TABLE commissioning_workflows, warranty_registrations, warranty_claims IN SHARE ROW EXCLUSIVE MODE`);

  for (const [seq, table, column, pattern] of SEQUENCES) {
    await knex.raw(`CREATE SEQUENCE IF NOT EXISTS ${seq} START WITH 1 INCREMENT BY 1 NO CYCLE`);
    const { rows } = await knex.raw(
      `SELECT COALESCE(MAX((regexp_match(${column}, '${pattern}'))[1]::bigint), 0) AS max FROM ${table}`
    );
    const max = Number(rows[0].max);
    // The highest number already handed out by the sequence (0 if none), so a
    // re-applied migration never moves a sequence backwards.
    const { rows: st } = await knex.raw(`SELECT last_value, is_called FROM ${seq}`);
    const issued = st[0].is_called ? Number(st[0].last_value) : Number(st[0].last_value) - 1;
    const last = Math.max(max, issued);
    // Next nextval() returns last + 1.
    if (last > 0) await knex.raw(`SELECT setval('${seq}', ${last}, true)`);
    else          await knex.raw(`SELECT setval('${seq}', 1, false)`);
  }

  const { rows: dups } = await knex.raw(
    `SELECT certificate_number, COUNT(*)::int AS n FROM commissioning_workflows
      WHERE certificate_number IS NOT NULL GROUP BY certificate_number HAVING COUNT(*) > 1`
  );
  if (dups.length) {
    console.warn(`  ⚠️  ${CERT_INDEX} NOT created — duplicate certificate numbers already exist: `
      + dups.map(d => `${d.certificate_number} ×${d.n}`).join(', '));
  } else {
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${CERT_INDEX}
         ON commissioning_workflows (certificate_number) WHERE certificate_number IS NOT NULL`
    );
  }
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${CERT_INDEX}`);
  for (const [seq] of SEQUENCES) {
    await knex.raw(`DROP SEQUENCE IF EXISTS ${seq}`);
  }
}
