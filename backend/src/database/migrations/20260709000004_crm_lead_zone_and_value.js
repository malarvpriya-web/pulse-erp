/**
 * 20260709000004_crm_lead_zone_and_value.js
 *
 * Backing store for the CRM lead-analytics dashboard (funnel / monthly /
 * per-user / won-vs-lost / by-range / by-zone, each in count and value form).
 *
 * 1. `leads.zone`            — regional split (North/South/East/West/Central).
 *    The table only ever had a free-text `location`, so "Leads by zone" had no
 *    queryable column. Backfilled by mapping the existing city strings.
 *
 * 2. `leads.estimated_value` — deal size at lead stage. A lead previously had no
 *    monetary column at all; value could only be read off a linked opportunity,
 *    which exists for converted leads only. The dashboard reads
 *    COALESCE(estimated_value, SUM(linked opportunities), 0), so this column is
 *    left NULL here rather than copied from opportunities — a copy would go
 *    stale the moment an opportunity is revalued.
 *
 * 3. Guarded backfill of `leads.company_id` NULL -> 1. Every existing lead row
 *    has a NULL company_id, which makes them invisible to company-scoped users
 *    (superadmin resolves to company 1) and would render the new dashboard
 *    permanently empty. Same fix as 20260706000003 applied to other tenant tables.
 */

// City -> zone. Kept in the migration (not the app) because it exists only to
// interpret the legacy free-text `location`; new leads pick a zone in the UI.
const CITY_ZONES = {
  North:   ['delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'chandigarh', 'jaipur',
            'lucknow', 'kanpur', 'ludhiana', 'amritsar', 'faridabad', 'ghaziabad',
            'dehradun', 'srinagar', 'shimla', 'meerut', 'agra', 'varanasi'],
  South:   ['bangalore', 'bengaluru', 'chennai', 'hyderabad', 'kochi', 'cochin',
            'coimbatore', 'mysore', 'mysuru', 'trivandrum', 'thiruvananthapuram',
            'vijayawada', 'visakhapatnam', 'vizag', 'madurai', 'mangalore', 'salem',
            'tirupati', 'warangal'],
  East:    ['kolkata', 'calcutta', 'bhubaneswar', 'guwahati', 'patna', 'ranchi',
            'jamshedpur', 'siliguri', 'cuttack', 'durgapur', 'asansol', 'dhanbad',
            'shillong', 'agartala'],
  West:    ['mumbai', 'bombay', 'pune', 'ahmedabad', 'surat', 'nagpur', 'vadodara',
            'baroda', 'rajkot', 'nashik', 'goa', 'panaji', 'thane', 'aurangabad',
            'kolhapur', 'bhavnagar'],
  Central: ['bhopal', 'indore', 'raipur', 'jabalpur', 'gwalior', 'ujjain', 'bilaspur',
            'sagar', 'satna'],
};

export async function up(knex) {
  await knex.raw(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS zone            VARCHAR(20),
      ADD COLUMN IF NOT EXISTS estimated_value NUMERIC(15,2)
  `);

  // Legacy rows carry NULL company_id and are invisible to scoped queries.
  // Only touch NULLs, and only when company 1 exists.
  //
  // `leads_company_email_unique` is a partial unique index on (company_id, email)
  // WHERE email <> '' AND deleted_at IS NULL, so a blind backfill collides on any
  // duplicate email. Scope the lowest id per email and leave duplicates NULL
  // rather than destroying rows — they stay exactly as invisible as they are today.
  await knex.raw(`
    UPDATE leads l SET company_id = 1
     WHERE l.company_id IS NULL
       AND EXISTS (SELECT 1 FROM companies WHERE id = 1)
       AND (
             l.email IS NULL OR l.email = '' OR l.deleted_at IS NOT NULL
             OR l.id = (
                  SELECT MIN(l2.id) FROM leads l2
                   WHERE l2.company_id IS NULL
                     AND l2.deleted_at IS NULL
                     AND l2.email = l.email
                )
           )
       AND NOT EXISTS (
             SELECT 1 FROM leads l3
              WHERE l3.company_id = 1
                AND l3.deleted_at IS NULL
                AND l3.email IS NOT NULL AND l3.email <> ''
                AND l3.email = l.email
           )
  `);

  // Backfill zone from the free-text location. Only fills NULLs.
  // The migration runner's `knex` is a thin pg shim, so bindings are $n — not `?`
  // (which Postgres reads as the jsonb exists operator).
  for (const [zone, cities] of Object.entries(CITY_ZONES)) {
    // $1 is the zone; cities start at $2.
    const ph = cities.map((_, i) => `$${i + 2}`).join(',');

    // Exact match: "Bangalore"
    await knex.raw(
      `UPDATE leads
          SET zone = $1
        WHERE zone IS NULL
          AND location IS NOT NULL
          AND LOWER(TRIM(location)) IN (${ph})`,
      [zone, ...cities]
    );

    // Partial match for "City, State" style values the exact pass missed.
    await knex.raw(
      `UPDATE leads
          SET zone = $1
        WHERE zone IS NULL
          AND location IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM (VALUES ${cities.map((_, i) => `($${i + 2})`).join(',')}) AS c(city)
             WHERE LOWER(leads.location) LIKE '%' || c.city || '%'
          )`,
      [zone, ...cities]
    );
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_leads_company_created
      ON leads (company_id, created_at) WHERE deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_leads_zone
      ON leads (zone) WHERE deleted_at IS NULL
  `);
}

export async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_leads_company_created`);
  await knex.raw(`DROP INDEX IF EXISTS idx_leads_zone`);
  await knex.raw(`ALTER TABLE leads DROP COLUMN IF EXISTS zone`);
  await knex.raw(`ALTER TABLE leads DROP COLUMN IF EXISTS estimated_value`);
}
