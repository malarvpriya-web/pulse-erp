/**
 * Merge the duplicate department names that the multi-editor drift created, and
 * register the departments real rows use but the master list never held.
 *
 * Background: departments used to be creatable from three screens, each with its
 * own hardcoded list, plus a free-text "Other → enter department name" box on
 * AdminDashboard's Add-User drawer. Those surfaces are gone (Master Setup is now
 * the only editor), but the rows they wrote are still here. Code fixes cannot
 * reach data, so this repairs it.
 *
 * ── 1. "Human Resources" → "HR" ─────────────────────────────────────────────
 * The only genuine data-level duplicate. "HR" is the registered master row and
 * carries 10 rows across users/budgets/employees/job_openings/org_relationships;
 * "Human Resources" carries 4 employees written through the free-text box. Any
 * report grouping by department reported the HR headcount split across two
 * buckets, and a department filter set to "HR" silently omitted those 4 people.
 *
 * The sweep is dynamic over every text `department`/`sub_department` column so
 * it stays correct if another table has since acquired the value — with ONE
 * deliberate exclusion, below.
 *
 * ⚠ warehouses.department is EXCLUDED and must stay excluded. It is not an org
 * department: it holds lowercase slugs ('general', 'admin', 'service', 'rnd',
 * 'production') that key the Department Stores feature, and inventory.routes.js
 * groups on `COALESCE(w.department, 'general')` in three places. 'rnd' is not
 * even an org department. Case-folding those into the org vocabulary would split
 * every Department Stores grouping key. The lowercase/Titlecase pairs the audit
 * flagged there ('production' vs 'Production', 'service' vs 'Service') are two
 * different vocabularies that happen to share spellings, not duplicates.
 *
 * ── 2. Retire the unused master duplicate "Sales & Marketing" ───────────────
 * master_departments holds BOTH "Sales" (id 4) and "Sales & Marketing" (id 9).
 * Zero rows anywhere in the database use "Sales & Marketing" — it only ever
 * appeared as a second, confusing option in every department dropdown. It is
 * deactivated rather than deleted: `master_departments.name` is UNIQUE and the
 * GET filters on is_active, so deactivating removes it from every picker while
 * keeping the row recoverable if it turns out to be a real business unit.
 *
 * ── 3. Register the departments the data actually uses ──────────────────────
 * "Service" (18 rows: 3 employees + 15 support_tickets), "Projects" (3) and
 * "Stores" (1) are real departments that were never in master_departments. They
 * reached dropdowns only through the employees-fallback union in
 * GET /master/:type, which makes them second-class: they vanish from a picker
 * the moment the last employee carrying one is moved, and they cannot be renamed
 * or deactivated from Master Setup. Registering them makes Master Setup the
 * complete list, which is the point of having one.
 *
 * NOT touched, on purpose: work_centres.department ('Assembly', 'Dispatch') are
 * production zones, and the asset/contact labels ('Electrical', 'Maintenance',
 * 'Logistics', 'Analytics', 'Technology', 'Design', 'Executive') are free-typed
 * classifications on their own records. Whether any of those should become org
 * departments is a business call, not a data repair.
 */

const MERGES = [
  { from: 'Human Resources', to: 'HR' },
];

// warehouses.department is a Department Stores slug, not an org department.
const EXCLUDED_TABLES = new Set(['warehouses']);

const RETIRE = ['Sales & Marketing'];
const REGISTER = ['Service', 'Projects', 'Stores'];

async function orgDepartmentColumns(knex) {
  const { rows } = await knex.raw(`
    SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c
      FROM information_schema.columns c
      JOIN information_schema.tables tt
        ON tt.table_schema = c.table_schema
       AND tt.table_name   = c.table_name
       AND tt.table_type   = 'BASE TABLE'
     WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
       AND c.column_name IN ('department', 'sub_department')
       AND c.data_type IN ('text', 'character varying', 'character')
  `);
  return rows.filter(r => !EXCLUDED_TABLES.has(r.t));
}

export async function up(knex) {
  const cols = await orgDepartmentColumns(knex);
  let moved = 0;
  const touched = [];

  for (const { from, to } of MERGES) {
    for (const col of cols) {
      // Match case-insensitively and ignore surrounding whitespace so the
      // variants the free-text box produced are all caught, but write the
      // canonical spelling exactly.
      // The runner is a pg shim (src/config/migrations.js: client.query), so
      // bindings are $1-style. A question-mark placeholder binds nothing here
      // and throws.
      const { rowCount } = await knex.raw(
        `UPDATE "${col.s}"."${col.t}"
            SET "${col.c}" = $1
          WHERE LOWER(TRIM("${col.c}")) = LOWER($2)
            AND "${col.c}" IS DISTINCT FROM $1`,
        [to, from]
      );
      const n = rowCount ?? 0;
      if (n > 0) { moved += n; touched.push(`${col.t}.${col.c}×${n}`); }
    }
    // The losing name must not linger in the master list as a pickable option.
    await knex.raw(
      `DELETE FROM master_departments WHERE LOWER(TRIM(name)) = LOWER($1)`, [from]
    );
  }

  for (const name of RETIRE) {
    await knex.raw(
      `UPDATE master_departments SET is_active = FALSE WHERE name = $1`, [name]
    );
  }

  for (const name of REGISTER) {
    await knex.raw(
      `INSERT INTO master_departments (name, is_active) VALUES ($1, TRUE)
       ON CONFLICT (name) DO UPDATE SET is_active = TRUE`, [name]
    );
  }

  console.log(
    `[20260903000001] merged ${moved} row(s) onto canonical department names` +
    (touched.length ? ` (${touched.join(', ')})` : '') +
    `; retired ${RETIRE.join(', ')}; registered ${REGISTER.join(', ')}.`
  );
}

export async function down(knex) {
  // The merged rows are deliberately NOT split back apart. Restoring
  // "Human Resources" onto 4 employees would only re-break the grouping it was
  // fixing, and the canonical name harms nothing under the previous code.
  for (const name of REGISTER) {
    await knex.raw(`DELETE FROM master_departments WHERE name = $1`, [name]);
  }
  for (const name of RETIRE) {
    await knex.raw(`UPDATE master_departments SET is_active = TRUE WHERE name = $1`, [name]);
  }
}
