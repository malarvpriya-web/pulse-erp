/**
 * 20261117000004_candidate_code_on_insert.js — recruitment follow-up 2026-11-17.
 *
 * candidates.candidate_code ('CAND-00123') was filled ONCE, by the backfill in
 * 20260927000001, and by nothing afterwards: no insert path (Add candidate,
 * bulk upload, careers apply) ever set it. Every candidate added since then had
 * no Candidate ID, so the list's ID column, ID search and the CSV export showed
 * blanks.
 *
 * A BEFORE INSERT trigger covers every path at once — column defaults (the id)
 * are applied before BEFORE triggers run, so NEW.id is known. Same format as
 * the backfill. Rows missing a code are backfilled.
 *
 * The runner is a pg shim: placeholders are $n, never ?.
 */
export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION candidates_set_code() RETURNS trigger AS $$
    BEGIN
      IF NEW.candidate_code IS NULL OR BTRIM(NEW.candidate_code) = '' THEN
        NEW.candidate_code := 'CAND-' || LPAD(NEW.id::text, 5, '0');
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_candidates_set_code ON candidates`);
  await knex.raw(`CREATE TRIGGER trg_candidates_set_code BEFORE INSERT ON candidates
                    FOR EACH ROW EXECUTE FUNCTION candidates_set_code()`);
  await knex.raw(`UPDATE candidates SET candidate_code = 'CAND-' || LPAD(id::text, 5, '0')
                   WHERE candidate_code IS NULL OR BTRIM(candidate_code) = ''`);
}

export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_candidates_set_code ON candidates`);
  await knex.raw(`DROP FUNCTION IF EXISTS candidates_set_code()`);
}
