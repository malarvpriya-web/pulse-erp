/**
 * 20260916000010 — module master vocabularies.
 *
 * §172 audited every dropdown in the app: ~148 vocabularies were held as
 * `const X = ['a','b','c']` inside a page file. Thirteen of them are genuine
 * user-extensible master data, and several were copy-pasted into two or three
 * pages that had since drifted apart. This gives those thirteen a single home
 * in `master_values` — the generic type/value table that has been in the schema
 * since the platform-foundation migration with 18 seeded rows and no readers.
 *
 * WHAT THIS DOES
 *   1. A unique index that actually prevents duplicates. The existing one is
 *      UNIQUE (type, code, company_id); `code` is nullable, and in Postgres
 *      NULLs are distinct, so two rows both called "Technology" with a NULL
 *      code never conflicted. The new index is on the VALUE, case- and
 *      whitespace-insensitive, with COALESCE(company_id, 0) so shared rows
 *      collide with each other too.
 *   2. Promotes the four platform-foundation EMPLOYMENT_TYPE rows from
 *      company 1 to shared (company_id NULL). They are product defaults that
 *      happened to be stamped with a tenant, not that tenant's data — and
 *      leaving them scoped would hide them from every other company while the
 *      new shared seeds sat alongside as near-duplicates.
 *   3. Seeds the thirteen vocabularies as shared rows.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not adopt the values currently sitting in the target columns. The
 *   usual move — union the master with SELECT DISTINCT so nothing drops out of
 *   its dropdown — is wrong here, because four of those columns hold the SAME
 *   four words:
 *       project_issues.issue_type              Primary, General, Standard, Routine
 *       visit_reports.visit_type               Primary, General, Standard, Routine
 *       customer_visits.visit_type             Primary, General, Standard, Routine
 *       employee_asset_allocations.asset_type  Primary, General, Standard, Routine
 *   That is not four vocabularies, it is one placeholder list written across
 *   every free-text *_type column by an earlier empty-table seeding pass.
 *   Adopting it would enshrine junk as configuration. Nothing is lost by
 *   leaving it out: MasterSelect renders a stored value that is absent from the
 *   master as its own option, so an existing record still shows its value and
 *   still round-trips a save.
 *
 *   The one exception is INDUSTRY, where the live values are real customer
 *   data ('IT Services', 'Analytics', 'Engineering', 'FMCG' — four of the seven
 *   in `accounts` were not in the hardcoded list). Those are adopted, minus the
 *   placeholder words.
 *
 *   LEAVE_TYPE, PRIORITY and APPROVAL_STATUS rows already in master_values are
 *   left exactly as they are and are not exposed by the API: leave types live
 *   in the `leave_types` table, and the other two drive code.
 */

// The four words an earlier seeding pass wrote into every free-text *_type
// column. 'General' is excluded from the deny-list — it is a real issue type.
const PLACEHOLDERS = ['Primary', 'Standard', 'Routine'];

const SEEDS = {
  INDUSTRY: ['Technology', 'Manufacturing', 'Retail', 'Healthcare', 'Finance',
             'Construction', 'Education', 'Logistics', 'Media', 'Consulting', 'Other'],

  LEAD_SOURCE: ['Website', 'LinkedIn', 'Referral', 'Campaign', 'Cold Call', 'Exhibition',
                'Tender Portal', 'Direct', 'Phone', 'IndiaMart', 'Manual'],

  ACCOUNT_TYPE: ['Customer', 'Prospect', 'Partner', 'Competitor', 'Other'],

  // The union of the three lists that existed: VisitReports (13),
  // CustomerVisits (7) and TravelRequests' own overlapping set.
  VISIT_TYPE: ['Sales Visit', 'Customer Visit', 'Customer Meeting', 'Site Visit', 'Site Survey',
               'Service Visit', 'AMC Visit', 'Commissioning Visit', 'Review Meeting',
               'FAT Witness', 'FAT Support', 'Warranty Inspection', 'Application Engineering',
               'Design Discussion', 'Tender Discussion', 'Installation', 'Commissioning',
               'Training', 'Internal Meeting'],

  PROJECT_TYPE: ['EPC', 'HVDC', 'STATCOM', 'SST', 'AMC', 'Installation',
                 'Commissioning', 'O&M', 'Supply', 'Turnkey'],

  // Title case, not the lowercase keys the page hardcoded. `project_issues`
  // stores Title Case and the <select> offered lowercase, so every issue in the
  // table rendered with an empty Type. The column is free text with a DEFAULT
  // of 'general', which is preserved as a value below.
  ISSUE_TYPE: ['General', 'Technical', 'Scope', 'Resource', 'Schedule', 'Quality', 'Commercial'],

  // Two vocabularies had been writing to employees.employment_type: HR's
  // ('Permanent','Probation','Contract') and recruitment's
  // ('full_time','part_time','contract','intern'). Both sets are seeded so no
  // existing record is orphaned; the recruitment keys are what job_openings
  // stores and are kept in their stored form on purpose.
  EMPLOYMENT_TYPE: ['Permanent', 'Probation', 'Contract', 'Full Time', 'Part Time',
                    'Intern', 'Consultant', 'Apprentice'],

  QUALIFICATION: ['PhD', 'Post Graduate', 'Graduate', 'Diploma', 'ITI', '12th', '10th'],

  SKILL_TYPE: ['Skilled', 'Semi Skilled', 'Unskilled'],

  ASSET_TYPE: ['Laptop', 'Desktop', 'Mobile', 'SIM Card', 'Tablet', 'Monitor', 'Keyboard',
               'Mouse', 'Headset', 'Access Card', 'Vehicle', 'Tools', 'Other'],

  VENDOR_CATEGORY: ['Raw Materials', 'Electronic Components (Active)',
                    'Electronic Components (Passive)', 'IGBT / Power Modules',
                    'PCB Manufacturers', 'Magnetics (Transformers / Inductors)',
                    'Contract Manufacturers (EMS)', 'Consumables', 'IT', 'Services',
                    'Logistics', 'Import Agents / CHA'],

  PAYMENT_TERM: ['Advance', '50% Advance, 50% on Delivery', 'Net 15', 'Net 30', 'Net 45',
                 'Net 60', 'Net 90', 'Against Delivery', 'Letter of Credit', 'Milestone Based'],

  TRAVEL_TYPE: ['Sales Visit', 'Customer Meeting', 'Tender Discussion', 'Site Survey',
                'Application Engineering', 'Design Discussion', 'FAT Support', 'Installation',
                'Commissioning', 'Service Visit', 'AMC Visit', 'Training', 'Internal Meeting'],
};

export async function up(knex) {
  // 1. Real duplicate prevention. Built first so the seeds below cannot create
  //    the very thing it exists to stop.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_master_values_type_company_value
      ON master_values (type, COALESCE(company_id, 0), LOWER(BTRIM(value)))
  `);

  // 2. Product defaults, wrongly stamped with company 1 by the foundation
  //    migration. Guarded: if some tenant has since added their own row with
  //    the same value the promotion would collide, so promote only when the
  //    shared slot is free.
  await knex.raw(`
    UPDATE master_values m
       SET company_id = NULL
     WHERE m.type = 'EMPLOYMENT_TYPE'
       AND m.company_id = 1
       AND NOT EXISTS (
         SELECT 1 FROM master_values o
          WHERE o.type = m.type AND o.company_id IS NULL
            AND LOWER(BTRIM(o.value)) = LOWER(BTRIM(m.value))
       )
  `);

  // 3. Shared seeds. ON CONFLICT targets the new index, so re-running is a
  //    no-op and a value a tenant already added is left alone.
  //
  //    ⚠ `knex` here is a pg shim, not knex: bindings are $1/$2, and a `?`
  //    would be parsed by Postgres as the jsonb-exists operator.
  for (const [type, values] of Object.entries(SEEDS)) {
    for (let i = 0; i < values.length; i++) {
      await knex.raw(
        `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
         VALUES ($1, $2, NULL, $3, NULL, true)
         ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
        [type, values[i], i + 1]
      );
    }
  }

  // 4. Industries actually in use that the hardcoded list never offered. Scoped
  //    to the company that holds the account, so one tenant's customer industry
  //    does not appear in another tenant's dropdown.
  await knex.raw(
    `INSERT INTO master_values (type, value, code, sort_order, company_id, is_active)
     SELECT 'INDUSTRY', BTRIM(a.industry), NULL, 900, a.company_id, true
       FROM accounts a
      WHERE a.industry IS NOT NULL AND BTRIM(a.industry) <> ''
        AND BTRIM(a.industry) <> ALL ($1::text[])
        AND a.company_id IS NOT NULL
      GROUP BY BTRIM(a.industry), a.company_id
     ON CONFLICT (type, COALESCE(company_id, 0), LOWER(BTRIM(value))) DO NOTHING`,
    [PLACEHOLDERS]
  );
  // The same value may exist as a shared seed, which the per-company conflict
  // target cannot see. Drop those company rows rather than show the word twice.
  await knex.raw(`
    DELETE FROM master_values c
     WHERE c.type = 'INDUSTRY' AND c.company_id IS NOT NULL AND c.sort_order = 900
       AND EXISTS (
         SELECT 1 FROM master_values s
          WHERE s.type = 'INDUSTRY' AND s.company_id IS NULL
            AND LOWER(BTRIM(s.value)) = LOWER(BTRIM(c.value))
       )
  `);
}

export async function down(knex) {
  // Put the four foundation EMPLOYMENT_TYPE rows back where step 2 found them.
  // They are told apart from this migration's seeds by carrying a `code` —
  // every row inserted above has code NULL. Done BEFORE the delete, or the
  // delete takes them with it.
  await knex.raw(`
    UPDATE master_values SET company_id = 1
     WHERE type = 'EMPLOYMENT_TYPE' AND company_id IS NULL AND code IS NOT NULL
  `);

  // Only the shared seeds this migration created. A tenant's own additions
  // (company_id NOT NULL) are their data and are never removed by a rollback —
  // except the INDUSTRY rows step 4 adopted, which are marked by sort_order 900.
  await knex.raw(
    `DELETE FROM master_values
      WHERE company_id IS NULL AND code IS NULL AND type = ANY ($1::text[])`,
    [Object.keys(SEEDS)]
  );
  await knex.raw(`DROP INDEX IF EXISTS ux_master_values_type_company_value`);
}
