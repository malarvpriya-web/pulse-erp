/**
 * 20261013000003 — Education vocabularies for the intern form.
 *
 * Course / Degree, Specialization and Current Year / Semester were free text on
 * Add/Edit Intern. They become three master_values vocabularies, registered in
 * modules/master/vocabularies.js, so they are maintained in Settings -> Master
 * Data and extended from the form's "+ Add new" like every other HR vocabulary.
 *
 * WHY NEW VOCABULARIES AND NOT AN EXISTING ONE
 *   QUALIFICATION (employees) holds education LEVELS — PhD, Post Graduate,
 *   Graduate, 12th — not degrees, so "B.Tech" has no place in it.
 *   candidates.qualification holds degrees, but as a fixed CHECK list, which is
 *   not maintainable. Its spellings ARE reused below ('BE/BTech', 'ME/MTech',
 *   'BSc' …) so one degree is spelled one way across recruitment and interns.
 *
 * Shared seeds (company_id NULL); a tenant's own additions carry its company_id.
 * ON CONFLICT targets ux_master_values_type_company_value, so re-running is a
 * no-op. No intern row is rewritten: a stored value outside these lists stays
 * exactly as it is, and the form offers it back as its own option.
 */

const SEEDS = {
  COURSE: [
    'ITI', 'Diploma', 'BE/BTech', 'ME/MTech', 'BSc', 'MSc', 'BCA', 'MCA',
    'BCom', 'MCom', 'BBA', 'MBA', 'BA', 'MA', 'PhD',
  ],
  SPECIALIZATION: [
    'Computer Science', 'Information Technology', 'Electronics & Communication',
    'Electrical', 'Mechanical', 'Civil', 'Chemical', 'Instrumentation',
    'Data Science', 'Finance', 'Marketing', 'Human Resources', 'Operations',
    'Accounting', 'Business Analytics', 'Design',
  ],
  ACADEMIC_YEAR: [
    '1st Year - Semester 1', '1st Year - Semester 2',
    '2nd Year - Semester 3', '2nd Year - Semester 4',
    '3rd Year - Semester 5', '3rd Year - Semester 6',
    '4th Year - Semester 7', '4th Year - Semester 8',
    '5th Year - Semester 9', '5th Year - Semester 10',
    'Final Year', 'Completed - Awaiting Results',
  ],
};

export async function up(knex) {
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
}

export async function down(knex) {
  // Only the shared seeds. A tenant's own added values are their data.
  for (const [type, values] of Object.entries(SEEDS)) {
    await knex.raw(
      `DELETE FROM master_values
        WHERE type = $1 AND company_id IS NULL AND value = ANY ($2::text[])`,
      [type, values]
    );
  }
}
