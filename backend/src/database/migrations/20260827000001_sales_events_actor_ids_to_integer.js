/**
 * sales_events.owner_id / account_id / opportunity_id — uuid → integer.
 *
 * All three were declared `uuid`, but every table they name is integer-keyed:
 * `users.id`, `accounts.id` and `opportunities.id` are all `integer`. The
 * consequence was that the Sales Calendar could not save a single event.
 * POST /api/sales/calendar/events stamps `owner_id` with `req.user.userId`
 * (= users.id, an integer), so every insert died on
 * `invalid input syntax for type uuid: "1"` (22P02) and came back as a 500 —
 * the modal reported "Failed to save event" and the user learned nothing.
 * PATCH had the same fault waiting on account_id / opportunity_id.
 *
 * The only rows in the table are the five `SEED Sales Events N` rows written by
 * the 20 Aug table-population seeder, and their uuids are fabricated: no uuid
 * can address an integer-keyed row, so none of the 15 links point at anything.
 * They are dropped to NULL rather than guarded against (the precedent set by
 * 20260820000001_payment_invoice_id_to_integer) because here there is nothing a
 * re-key could recover — the events themselves are kept.
 */

const COLUMNS = [
  { column: 'owner_id',       references: 'users(id)' },
  { column: 'account_id',     references: 'accounts(id)' },
  { column: 'opportunity_id', references: 'opportunities(id)' },
];

export async function up(knex) {
  const { rows } = await knex.raw(`
    SELECT COUNT(*) FILTER (WHERE owner_id IS NOT NULL)::int       AS owner,
           COUNT(*) FILTER (WHERE account_id IS NOT NULL)::int     AS account,
           COUNT(*) FILTER (WHERE opportunity_id IS NOT NULL)::int AS opportunity
      FROM sales_events
  `);
  const dropped = rows[0] ?? {};
  console.log(
    `[sales_events] dropping unmappable uuid links: ` +
    `owner_id=${dropped.owner ?? 0} account_id=${dropped.account ?? 0} ` +
    `opportunity_id=${dropped.opportunity ?? 0}`
  );

  for (const { column, references } of COLUMNS) {
    await knex.raw(`ALTER TABLE sales_events DROP CONSTRAINT IF EXISTS sales_events_${column}_fkey;`);
    await knex.raw(`ALTER TABLE sales_events ALTER COLUMN ${column} TYPE integer USING NULL;`);
    await knex.raw(`
      ALTER TABLE sales_events
        ADD CONSTRAINT sales_events_${column}_fkey
        FOREIGN KEY (${column}) REFERENCES ${references} ON DELETE SET NULL;
    `);
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_sales_events_${column} ON sales_events(${column});`);
  }

  // The month grid reads one company's events for one month on every arrow
  // click; that pair is the only access path the page has.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_sales_events_company_start
      ON sales_events(company_id, start_at);
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_sales_events_company_start;`);
  for (const { column } of COLUMNS) {
    await knex.raw(`DROP INDEX IF EXISTS idx_sales_events_${column};`);
    await knex.raw(`ALTER TABLE sales_events DROP CONSTRAINT IF EXISTS sales_events_${column}_fkey;`);
    await knex.raw(`ALTER TABLE sales_events ALTER COLUMN ${column} TYPE uuid USING NULL;`);
  }
}
