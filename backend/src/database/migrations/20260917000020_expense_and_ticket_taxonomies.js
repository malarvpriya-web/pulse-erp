/**
 * 20260917000020 — the two taxonomies §172 left open.
 *
 * §172 closed eleven module vocabularies and reported two it did not touch,
 * because each turned out to be hiding something bigger than a missing picker.
 *
 * ── 1. EXPENSE: three vocabularies, one domain ───────────────────────────────
 *
 *   ExpenseClaims.jsx      a hardcoded TWO-LEVEL list (5 groups, 20 items)
 *                          writing expense_claims.expense_type/.expense_category
 *   EmployeeSelfService    a different, lowercase CLAIM_TYPES
 *                          (medical/fuel/internet/mobile/travel/other)
 *                          writing reimbursement_claims.claim_type
 *   expense_categories     11 curated rows WITH descriptions, written only by
 *                          the seed script, read by NOTHING
 *
 * Three descriptions of the same domain at three granularities, and the only
 * one an administrator could see was the one nothing read.
 *
 * ⚠ EXPENSE_TYPE is a policy key, not just a vocabulary. Both the claim path and
 * the preview map it to a limit column on `travel_policy_rules`:
 * Accommodation→hotel, Food→meal, Travel→local_conveyance, **anything else→
 * miscellaneous**. That final `else` exists in BOTH files — checked, because
 * without it a user-added type would have created a class of spend that passes
 * no policy check, and this would have had to stay a fixed list.
 *
 * Every value seeded below comes from one of those three existing lists. None
 * is invented: a taxonomy someone has to guess at is worse than the three that
 * at least described real spend.
 *
 * ── 2. TICKETS: an FK that has never been set ────────────────────────────────
 *
 * `support_tickets` carries BOTH `category` (varchar, live — 15 rows) and
 * `category_id` (FK → ticket_categories, **NULL on every row ever created**).
 * `ticket.repository.js` bound `category_id` into the `category` COLUMN, so a
 * ticket raised from the finance Tickets page stored the numeric id as text
 * and `category_id` stayed null — while `findById` joined on `category_id` and
 * therefore always reported a null category name.
 *
 * There were FOUR vocabularies here, not two:
 *   ticket_categories             Hardware, Software, Network, Access Request, …  (8, unused)
 *   support_tickets.category      HR, Finance, IT, Attendance, Payroll, …        (11, live)
 *   SupportDashboard.jsx inline   …, IT Support, Facilities, Security, Other      (9, the one
 *                                 users actually reach — Service Desk's New Ticket dialog)
 *   finance Tickets.jsx           read ticket_categories by id — but that page is
 *                                 registered in routes.jsx and in NO menu, so nobody reaches it
 *
 * This seeds the union of all of them, so making `ticket_categories` the single
 * master takes nothing away: no existing ticket is orphaned, and no value the
 * live dialog used to offer disappears.
 */

/** The placeholder words an earlier empty-table seeding pass spread everywhere. */
const PLACEHOLDERS = ['Primary', 'Standard', 'Routine'];

/**
 * Expense type → its categories.
 *
 * Provenance for every entry:
 *   (A) EXPENSE_TYPES in ExpenseClaims.jsx — the hierarchy already being stored
 *   (B) the expense_categories table — curated, with descriptions
 *   (C) CLAIM_TYPES in EmployeeSelfService.jsx
 */
const EXPENSE_TAXONOMY = [
  // (A) groups, in the order the form offered them. The first three are the
  // policy-mapped ones and must keep these exact spellings.
  ['Travel',        ['Flight', 'Train', 'Metro', 'Bus', 'Taxi', 'Cab', 'Fuel', 'Toll',
                     'Parking', 'Local Conveyance']],           // Local Conveyance from (B)
  ['Accommodation', ['Hotel', 'Guest House', 'Lodging']],
  ['Food',          ['Breakfast', 'Lunch', 'Dinner', 'Meals']], // Meals from (B)
  ['Customer',      ['Meeting Expense', 'Entertainment', 'Client Entertainment']], // last from (B)
  ['Site',          ['Consumables', 'Tools', 'Miscellaneous']],

  // Groups the flat curated list implied but the hierarchy never had. Each gets
  // at least one category so the cascade is never empty.
  ['Communication', ['Telephone & Internet', 'Internet', 'Mobile']], // (B), (C), (C)
  ['Office',        ['Office Supplies']],                            // (B)
  ['Training',      ['Training']],                                   // (B)
  ['Medical',       ['Medical']],                                    // (B), (C)
  ['Other',         ['Other']],                                      // (C) 'other'
];

// ⚠ No category name may repeat across two types. The unique index is on
// (type, company, value) and does NOT include the parent, so a second
// 'Miscellaneous' under Other would silently no-op against the one under Site
// and leave Other with an EMPTY child list — a cascading picker whose second
// step has nothing in it, which is the failure this whole taxonomy exists to
// avoid. That constraint is also the right one: once the category is written to
// the record as plain text, two rows with the same name are indistinguishable.

export async function up(knex) {
  // ── Expense types ──────────────────────────────────────────────────────────
  // ⚠ `knex` is a pg shim, not knex: bindings are $1/$2. A `?` is parsed by
  // Postgres as the jsonb-exists operator.
  for (let g = 0; g < EXPENSE_TAXONOMY.length; g++) {
    const [group] = EXPENSE_TAXONOMY[g];
    await knex.raw(
      `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
       VALUES ('EXPENSE_TYPE', $1, NULL, $2, NULL, true)
       ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
      [group, g + 1]
    );
  }

  // ── Expense categories, each parented to its type ──────────────────────────
  // The parent is looked up rather than assumed: the INSERT above is a no-op on
  // a re-run, so the id has to come from the table either way.
  for (const [group, items] of EXPENSE_TAXONOMY) {
    const { rows: [parent] } = await knex.raw(
      `SELECT id FROM master_values
        WHERE type = 'EXPENSE_TYPE' AND company_id IS NULL
          AND LOWER(BTRIM(value)) = LOWER(BTRIM($1)) LIMIT 1`,
      [group]
    );
    if (!parent) continue;
    for (let i = 0; i < items.length; i++) {
      await knex.raw(
        `INSERT INTO master_values (type, value, code, sort_order, company_id, parent_id, is_active)
         VALUES ('EXPENSE_CATEGORY', $1, NULL, $2, NULL, $3, true)
         ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
        [items[i], i + 1, parent.id]
      );
    }
  }

  // ── Ticket categories: the values only the Service Desk dialog offered ─────
  // Its inline list is the one users actually pick from. Three of its nine are
  // in no other list, so without these the master would silently narrow what
  // can be chosen.
  for (const name of ['IT Support', 'Facilities', 'Security']) {
    // ⚠ $1 is cast explicitly: used bare it is inferred as varchar by the
    // INSERT target and as text by BTRIM(), and Postgres refuses with
    // "inconsistent types deduced for parameter $1".
    await knex.raw(
      `INSERT INTO ticket_categories (name, description, is_active)
       SELECT $1::text, 'Adopted from tickets already filed under this category', true
        WHERE NOT EXISTS (
          SELECT 1 FROM ticket_categories t WHERE LOWER(BTRIM(t.name)) = LOWER(BTRIM($1::text))
        )`,
      [name]
    );
  }

  // ── Ticket categories: adopt the vocabulary actually in use ────────────────
  // `ticket_categories` has no company_id, and `name` is not unique, so the
  // NOT EXISTS is what makes this idempotent.
  await knex.raw(
    `INSERT INTO ticket_categories (name, description, is_active)
     SELECT DISTINCT BTRIM(s.category),
            'Adopted from tickets already filed under this category',
            true
       FROM support_tickets s
      WHERE s.category IS NOT NULL
        AND BTRIM(s.category) <> ''
        AND BTRIM(s.category) <> ALL ($1::text[])
        -- the repository's id-into-a-varchar-column bug wrote bare integers here
        AND BTRIM(s.category) !~ '^[0-9]+$'
        AND NOT EXISTS (
          SELECT 1 FROM ticket_categories t
           WHERE LOWER(BTRIM(t.name)) = LOWER(BTRIM(s.category))
        )`,
    [PLACEHOLDERS]
  );

  // ── Backfill the FK the create path never set ──────────────────────────────
  // Only where the text unambiguously names a category. A ticket whose category
  // is one of the bare integers the bug wrote is left alone: guessing which
  // category id 3 meant when the list has since changed would be inventing data.
  await knex.raw(`
    UPDATE support_tickets s
       SET category_id = t.id
      FROM ticket_categories t
     WHERE s.category_id IS NULL
       AND s.category IS NOT NULL
       AND LOWER(BTRIM(s.category)) = LOWER(BTRIM(t.name))
  `);

  // Duplicate names would make that backfill ambiguous on a later run.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_ticket_categories_name
      ON ticket_categories (LOWER(BTRIM(name)))
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ux_ticket_categories_name`);

  // Release the FK before removing the rows it points at. The tickets keep their
  // `category` text either way — that is the column everything actually reads —
  // so this returns them to exactly the state the up() found them in.
  await knex.raw(`
    UPDATE support_tickets s SET category_id = NULL
      FROM ticket_categories t
     WHERE s.category_id = t.id
       AND t.description = 'Adopted from tickets already filed under this category'
  `);

  // Only what this migration added. A ticket_categories row a user has since
  // created, and any expense value a tenant added (company_id NOT NULL), are
  // their data and survive a rollback.
  await knex.raw(
    `DELETE FROM ticket_categories
      WHERE description = 'Adopted from tickets already filed under this category'`
  );
  await knex.raw(
    `DELETE FROM master_values
      WHERE company_id IS NULL AND type = ANY ($1::text[])`,
    [['EXPENSE_TYPE', 'EXPENSE_CATEGORY']]
  );
}
