/**
 * 20261012000002 — login emails are case-insensitive and normalised on write.
 *
 * Before: `users.email` was unique on the EXACT string (users_email_key) and
 * sign-in, password reset, Google sign-in and self-registration all looked it
 * up with an exact `email = $1`. So:
 *   - a login stored as 'Asha@Acme.in' could not sign in as 'asha@acme.in';
 *   - registration accepted 'A@x.com' beside 'a@x.com' — two accounts, one
 *     mailbox, and password reset would pick whichever matched the typing;
 *   - Add Employee lowercased its logins while admin/register did not, so the
 *     same person's address depended on which screen made the account.
 * customer_portal_users had the mirror-image bug: the portal login LOWERCASED
 * what was typed and compared it to the stored value exactly, and all 5 stored
 * rows held capitals — no portal account could sign in at all.
 *
 * Measured 2026-10-12, before writing this:
 *   users                 320 rows, 243 not lower/trimmed, 0 case-insensitive
 *                         duplicates, 0 blank, 0 with surrounding whitespace
 *   customer_portal_users 5 rows, 5 not lower/trimmed, 0 duplicates per company
 *
 * What this does:
 *   1. REFUSES to run if any case-insensitive duplicate exists, naming the ids.
 *      Two accounts that differ only by case are a business decision (which one
 *      is the person?), never something to merge automatically.
 *   2. A UNIQUE index on LOWER(BTRIM(email)) — global for users (a login is
 *      global: one address signs in to one account in one tenant), and per
 *      company for portal accounts (that table's existing rule). This is what
 *      makes two simultaneous registrations of 'A@x' and 'a@x' safe: the second
 *      INSERT fails on the index, whatever the application checked first.
 *   3. A trigger that lowercases and trims email on INSERT and on an UPDATE
 *      that SETS email — so every writer (API, seeds, dev-tools scripts) stores
 *      the canonical form. It does NOT fire on other updates, and this
 *      migration does not backfill: existing accounts keep their stored
 *      spelling, which is display-only now that every lookup compares
 *      LOWER(BTRIM(email)).
 *
 * users_email_key (exact) is kept: it is implied by the new index, and some
 * seeds name it in ON CONFLICT (email).
 */

const USERS_IDX = 'users_email_ci_uniq';
const PORTAL_IDX = 'customer_portal_users_company_email_ci_uniq';

export async function up(knex) {
  const { rows: userDupes } = await knex.raw(`
    SELECT LOWER(BTRIM(email)) AS k, array_agg(id ORDER BY id) AS ids
      FROM users GROUP BY 1 HAVING COUNT(*) > 1`);
  const { rows: portalDupes } = await knex.raw(`
    SELECT company_id, LOWER(BTRIM(email)) AS k, array_agg(id ORDER BY id) AS ids
      FROM customer_portal_users GROUP BY 1, 2 HAVING COUNT(*) > 1`);
  if (userDupes.length || portalDupes.length) {
    const lines = [
      ...userDupes.map(d => `users ids ${d.ids.join(', ')}`),
      ...portalDupes.map(d => `customer_portal_users company ${d.company_id} ids ${d.ids.join(', ')}`),
    ];
    throw new Error(
      'Login emails that differ only by case/whitespace must be resolved by the business before ' +
      'case-insensitive uniqueness can be enforced. Nothing was changed. Duplicates:\n  ' + lines.join('\n  '));
  }

  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${USERS_IDX} ON users (LOWER(BTRIM(email)))`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${PORTAL_IDX}
                    ON customer_portal_users (company_id, LOWER(BTRIM(email)))`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION normalize_login_email() RETURNS trigger AS $$
    BEGIN
      IF NEW.email IS NOT NULL THEN
        NEW.email := LOWER(BTRIM(NEW.email));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`);
  for (const table of ['users', 'customer_portal_users']) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_${table}_normalize_email ON ${table}`);
    await knex.raw(`CREATE TRIGGER trg_${table}_normalize_email
                      BEFORE INSERT OR UPDATE OF email ON ${table}
                      FOR EACH ROW EXECUTE FUNCTION normalize_login_email()`);
  }
}

export async function down(knex) {
  for (const table of ['users', 'customer_portal_users']) {
    await knex.raw(`DROP TRIGGER IF EXISTS trg_${table}_normalize_email ON ${table}`);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS normalize_login_email()`);
  await knex.raw(`DROP INDEX IF EXISTS ${PORTAL_IDX}`);
  await knex.raw(`DROP INDEX IF EXISTS ${USERS_IDX}`);
}
