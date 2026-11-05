/**
 * 20260927000002_recruitment_screening_and_pool_seed.js
 *
 * Reference data for the screening workspace and the Talent Bank: §13's nine
 * questions and §17's twenty-three pool categories.
 *
 * Kept separate from 20260927000001 so that migration stays a pure structural
 * change that a reviewer can read in one sitting, and so re-seeding is a
 * one-line rollback that touches no tables.
 *
 * Both seeds are ON CONFLICT DO NOTHING, not DO UPDATE. That is the difference
 * between "ensure this exists" and "overwrite whatever the customer changed" —
 * a recruiter who reworded Q4 for their own use must not have it silently reset
 * the next time migrations run.
 */

// §13 verbatim. `competency` names the rating in candidate_screenings that this
// question is evidence for, so the workspace can put the question beside the
// slider it informs instead of listing nine questions and seven sliders
// separately and leaving the recruiter to map them.
const QUESTIONS = [
  {
    code: 'Q1',
    competency: 'learning_mindset',
    prompt: 'What is something you learned recently that was not part of your formal education?',
  },
  {
    code: 'Q2',
    competency: 'problem_solving',
    prompt: 'When you don’t know how to solve a problem, what do you normally do first?',
  },
  {
    code: 'Q3',
    competency: 'learning_mindset',
    prompt: 'Tell us about something you initially found difficult but eventually learned.',
  },
  {
    code: 'Q4',
    competency: 'adaptability',
    prompt: 'If you join Manifest and are given a technology that you have never worked with, how would you approach learning it?',
  },
  {
    code: 'Q5',
    competency: 'patience',
    prompt: 'Tell us about a difficult problem or project that took longer than expected. How did you handle it?',
  },
  {
    code: 'Q6',
    competency: 'ownership',
    prompt: 'Tell us about a mistake you made in your work or studies. What did you do after discovering it?',
  },
  {
    code: 'Q7',
    competency: 'teamwork',
    prompt: 'Tell us about a situation where you had to work with someone whose working style was very different from yours.',
  },
  {
    code: 'Q8',
    competency: 'career_alignment',
    prompt: 'What factors would make you want to build a long-term career with an organisation?',
  },
  {
    // The only single_choice question in the set, and the only one whose answer
    // feeds a structured field elsewhere: the screening endpoint copies the
    // chosen option onto candidates.willing_to_relocate, so answering Q9 and
    // setting the relocation field are one act rather than two.
    //
    // §13's closing instruction — "Do not use 'lifetime commitment' as a
    // candidate requirement" — is why there is no tenth question asking for one,
    // and why Q8 asks what would MAKE someone stay rather than demanding that
    // they promise to.
    code: 'Q9',
    competency: 'location_alignment',
    answer_type: 'single_choice',
    prompt: 'Manifest’s primary engineering/manufacturing location is planned near Durganagar, Srivilliputtur. Are you comfortable working from this location?',
    options: [
      { value: 'already_local',      label: 'Yes, I already live nearby' },
      { value: 'willing',            label: 'Yes, I can relocate' },
      { value: 'willing_with_support', label: 'Yes, with relocation support' },
      { value: 'needs_information',  label: 'Possibly; need more information' },
      { value: 'not_currently',      label: 'Not currently' },
      { value: 'no',                 label: 'No' },
    ],
  },
];

// §17's list, verbatim and in order. `category` groups them on the Talent Bank
// screen; `department` is set only where the pool corresponds to an actual
// Manifest department, because a pool like 'AHF' or 'Future Leadership' is a
// capability tag, not a department, and writing a department there would make
// the department filter lie.
const POOLS = [
  ['Electrical',              'engineering', 'Electrical'],
  ['Electronics',             'engineering', 'Electronics'],
  ['Power Electronics',       'engineering', 'Power Electronics'],
  ['SST',                     'product',     null],
  ['STATCOM',                 'product',     null],
  ['AHF',                     'product',     null],
  ['SVG',                     'product',     null],
  ['HV',                      'product',     null],
  ['MV',                      'product',     null],
  ['Embedded',                'engineering', 'Embedded'],
  ['Controls',                'engineering', 'Controls'],
  ['Testing',                 'engineering', 'Testing'],
  ['Service',                 'operations',  'Service'],
  ['Production',              'operations',  'Production'],
  ['Quality',                 'operations',  'Quality'],
  ['Application Engineering', 'engineering', 'Application Engineering'],
  ['Mechanical',              'engineering', 'Mechanical'],
  ['Supply Chain',            'operations',  'Supply Chain'],
  ['Sales',                   'commercial',  'Sales'],
  ['Finance',                 'corporate',   'Finance'],
  ['HR',                      'corporate',   'HR'],
  ['Fresh Graduate',          'pipeline',    null],
  ['Future Leadership',       'pipeline',    null],
];

export async function up(knex) {
  // ── Screening questions ────────────────────────────────────────────────
  // company_id NULL = a platform default visible to every tenant. Seeding these
  // once rather than once per company means a new company gets the nine
  // questions without a per-company seed step, and a company that wants its own
  // wording inserts its own row with the same code (the unique index is on
  // COALESCE(company_id,0) + code, so both can coexist and the repository
  // prefers the company's own).
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    // $n placeholders, not '?'. The migration runner's `knex` is a thin shim over
    // a node-postgres client (config/migrations.js makeKnexShim), not real knex —
    // a '?' reaches Postgres as a literal question mark.
    await knex.raw(
      `INSERT INTO screening_questions
         (company_id, code, prompt, answer_type, options, competency, sort_order, is_active)
       VALUES (NULL, $1, $2, $3, $4::jsonb, $5, $6, TRUE)
       ON CONFLICT (COALESCE(company_id, 0), code) DO NOTHING`,
      [
        q.code,
        q.prompt,
        q.answer_type || 'text',
        JSON.stringify(q.options || []),
        q.competency || null,
        (i + 1) * 10,
      ]
    );
  }

  // ── Talent Bank pools ──────────────────────────────────────────────────
  // Per company, because a pool holds that company's candidates. Matched on
  // LOWER(pool_name) so a customer who already created a pool called "Testing"
  // keeps theirs — is_seeded stays FALSE on it, which is how the Talent Bank
  // screen can tell a Manifest-standard category from one the customer added.
  //
  // ── WHY THIS IS NOT "every row in companies" ────────────────────────────
  // It was, on the first draft, and that inserted 1311 pools: this database
  // holds 57 companies of which 56 are ZZGEN_* rows abandoned by integration
  // tests that create a tenant and never sweep it. 23 categories x 56 dead
  // tenants is 1288 rows of noise in a table the Talent Bank screen reads.
  //
  // A migration also cannot answer the question properly even with the garbage
  // removed: a company onboarded TOMORROW is not in this loop, so it would get
  // an empty Talent Bank. So the migration seeds only tenants that demonstrably
  // exist (they have at least one user), and recruitmentRepository's
  // ensureStandardTalentPools() — called by the Talent Bank list endpoint —
  // is what guarantees the categories for every company, including future ones.
  // This loop is therefore a convenience for the installed base, not the
  // mechanism.
  const { rows: companies } = await knex.raw(`
    SELECT c.id FROM companies c
     WHERE EXISTS (SELECT 1 FROM users u WHERE u.company_id = c.id)
     ORDER BY c.id
  `);

  for (const company of companies) {
    for (let i = 0; i < POOLS.length; i++) {
      const [name, category, department] = POOLS[i];
      await knex.raw(
        `INSERT INTO talent_pools
           (company_id, pool_name, description, category, department, skill_focus,
            is_active, is_seeded, created_at, updated_at)
         SELECT $1, $2, $3, $4, $5, $6, TRUE, TRUE, NOW(), NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM talent_pools
             WHERE company_id = $1 AND LOWER(pool_name) = LOWER($7)
          )`,
        // `name` is passed four times rather than reusing $2 in every position.
        // A bare $n used both as an INSERT target value and inside LOWER() is the
        // shape that makes Postgres complain about "inconsistent types deduced" —
        // repeating the binding costs nothing and cannot be deduced two ways.
        [
          company.id,
          name,
          `Talent Bank — ${name}. Candidates retained for current and future ${name} openings.`,
          category,
          department,
          name,
          name,
        ]
      );
    }
  }
}

export async function down(knex) {
  // Only the rows this migration created. A pool the customer added, or one they
  // renamed, has is_seeded = FALSE and is left alone — and a seeded pool that has
  // acquired members is left alone too, because dropping it would take the
  // membership rows with it via ON DELETE CASCADE.
  await knex.raw(`
    DELETE FROM talent_pools tp
     WHERE tp.is_seeded = TRUE
       AND NOT EXISTS (SELECT 1 FROM talent_pool_members m WHERE m.pool_id = tp.id)
  `);
  await knex.raw(`DELETE FROM screening_questions WHERE company_id IS NULL`);
}
