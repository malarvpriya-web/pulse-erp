/**
 * seed-recruitment-demo.js
 *
 * A realistic candidate population for the Recruitment module, so the workbench,
 * the Talent Bank, the work queue and the screening scorecard can be exercised and
 * demonstrated against something other than four rows.
 *
 *   node scripts/seed-recruitment-demo.js            # create / top up
 *   node scripts/seed-recruitment-demo.js --clean    # remove everything it made
 *   node scripts/seed-recruitment-demo.js --count=300
 *
 * ── WHY THE VALUES ARE COMPUTED, NOT LADDERED ───────────────────────────────
 * This repo has been bitten by a seed generator that filled 28 money columns with
 * `55 + i * 6.5`. Every value was a legal 0-100, so no CHECK constraint could
 * catch it, and the defect was purely semantic: discount, tax, commission, margin
 * and increment all carried the same meaningless ramp. The same generator put
 * `experience_years = 350` on a candidate.
 *
 * So every field here is derived from a plausible model of the person rather than
 * from the loop index:
 *
 *   · experience follows the graduation year, so a 2023 graduate cannot have
 *     twelve years' experience;
 *   · relevant experience is a fraction of total, never more than it;
 *   · expected CTC is a function of experience and discipline, with a real spread,
 *     and is always above current salary;
 *   · notice period comes from a distribution of the four real Indian values
 *     (immediate / 30 / 60 / 90) rather than an arithmetic sequence;
 *   · the stage distribution is funnel-shaped — many applied, few at offer —
 *     because a flat spread makes the pipeline board and every conversion metric
 *     meaningless;
 *   · `last_activity_at` is spread over 90 days so the work queue's "waiting more
 *     than 3 days" and the list's staleness column have something real to show.
 *
 * ── EVERYTHING IS TAGGED ────────────────────────────────────────────────────
 * Every row carries `source_tag` in its `tags` array and an @demo.manifest.invalid
 * email, so --clean can remove exactly what this script created and nothing else.
 * It never touches a row it did not write.
 *
 * Deterministic: a fixed seed means two runs produce the same people, so a
 * screenshot or a test written against this data stays valid.
 */

import 'dotenv/config';
import pool from '../src/config/db.js';

const TAG = 'demo-seed';
const EMAIL_DOMAIN = 'demo.manifest.invalid';

const args = process.argv.slice(2);
const CLEAN = args.includes('--clean');
// Opt-in, and deliberately not the default. Candidates are demo data; a JOB OPENING
// is a business record that shows up in vacancy aging, the pipeline board, hiring
// forecasts and the public careers feed. Inventing vacancies in someone's live
// pipeline without being asked is not a seed script's call to make.
const WITH_OPENINGS = args.includes('--with-openings');
const COUNT = Number((args.find(a => a.startsWith('--count=')) || '').split('=')[1]) || 180;

/* ── A deterministic PRNG ─────────────────────────────────────────────────── */
// mulberry32. Not for security — for reproducibility: the same seed gives the same
// people every run, so a screenshot or a Playwright assertion written against this
// data does not rot.
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = rng(20260927);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
/** A weighted pick: [[value, weight], …]. */
function weighted(pairs) {
  const total = pairs.reduce((n, p) => n + p[1], 0);
  let r = rnd() * total;
  for (const [value, w] of pairs) { if ((r -= w) <= 0) return value; }
  return pairs[pairs.length - 1][0];
}

/* ── Names ────────────────────────────────────────────────────────────────── */
// Tamil Nadu-weighted, because Manifest's site is near Srivilliputtur and the
// candidate pool for it realistically is. A name list drawn from one region would
// make the "National Talent" classification untestable, so the north-Indian and
// other-south names are present in smaller numbers.
const FIRST_TN = ['Karthik', 'Vivek', 'Arun', 'Senthil', 'Bala', 'Dinesh', 'Prakash', 'Ramesh',
  'Suresh', 'Vignesh', 'Hari', 'Manikandan', 'Saravanan', 'Gopi', 'Ashwin', 'Naveen',
  'Priya', 'Divya', 'Lakshmi', 'Meena', 'Kavitha', 'Anitha', 'Revathi', 'Sangeetha'];
const FIRST_OTHER = ['Rahul', 'Amit', 'Sanjay', 'Vikram', 'Neha', 'Pooja', 'Rohit', 'Anil',
  'Deepak', 'Sunil', 'Shruti', 'Ananya'];
const LAST_TN = ['Kumar', 'Raman', 'Subramanian', 'Murugan', 'Krishnan', 'Rajan', 'Pandian',
  'Nataraj', 'Sundaram', 'Velu', 'Selvam', 'Balaji', 'Ganesan', 'Chandran'];
const LAST_OTHER = ['Sharma', 'Verma', 'Gupta', 'Singh', 'Reddy', 'Nair', 'Joshi', 'Patel'];

/* ── Places ───────────────────────────────────────────────────────────────── */
const TN_CITIES = ['Madurai', 'Srivilliputtur', 'Virudhunagar', 'Sivakasi', 'Tirunelveli',
  'Coimbatore', 'Chennai', 'Salem', 'Trichy', 'Tuticorin', 'Rajapalayam', 'Dindigul'];
const OTHER_PLACES = [
  ['Bengaluru', 'Karnataka'], ['Hyderabad', 'Telangana'], ['Pune', 'Maharashtra'],
  ['Kochi', 'Kerala'], ['Coimbatore', 'Tamil Nadu'], ['Vadodara', 'Gujarat'],
  ['Noida', 'Uttar Pradesh'], ['Mysuru', 'Karnataka'],
];

/* ── Disciplines ──────────────────────────────────────────────────────────── */
// Each carries the skills, qualifications and salary band that actually go with it,
// so a Power Electronics candidate reads like one.
const DISCIPLINES = [
  {
    name: 'Power Electronics', department: 'Power Electronics',
    designations: ['Power Electronics Engineer', 'Design Engineer', 'R&D Engineer', 'Hardware Engineer'],
    skills: ['Power Electronics', 'Inverters', 'STATCOM', 'AHF', 'SVG', 'MATLAB', 'Simulink', 'PSIM', 'Altium'],
    quals: ['BE/BTech', 'ME/MTech'], specs: ['Electrical and Electronics', 'Power Electronics and Drives', 'Electrical Engineering'],
    base: 480000, perYear: 140000,
  },
  {
    name: 'Embedded', department: 'Embedded',
    designations: ['Embedded Engineer', 'Firmware Engineer', 'Embedded Software Engineer'],
    skills: ['Embedded C', 'ARM Cortex', 'RTOS', 'CAN', 'Modbus', 'STM32', 'Git'],
    quals: ['BE/BTech', 'ME/MTech', 'MCA'], specs: ['Electronics and Communication', 'Electrical and Electronics', 'Computer Science'],
    base: 460000, perYear: 150000,
  },
  {
    name: 'Testing', department: 'Testing',
    designations: ['Test Engineer', 'Validation Engineer', 'QA Engineer (Hardware)'],
    skills: ['Testing', 'HV Testing', 'Type Testing', 'LabVIEW', 'Oscilloscope', 'Power Analyser', 'IEC Standards'],
    quals: ['Diploma', 'BE/BTech'], specs: ['Electrical and Electronics', 'Electrical Engineering', 'Instrumentation'],
    base: 360000, perYear: 105000,
  },
  {
    name: 'Service', department: 'Service',
    designations: ['Service Engineer', 'Field Service Engineer', 'Commissioning Engineer'],
    skills: ['Commissioning', 'Troubleshooting', 'Field Service', 'Inverters', 'Customer Handling', 'Modbus'],
    quals: ['Diploma', 'BE/BTech'], specs: ['Electrical and Electronics', 'Electrical Engineering'],
    base: 330000, perYear: 95000,
  },
  {
    name: 'Production', department: 'Production',
    designations: ['Production Engineer', 'Manufacturing Engineer', 'Assembly Supervisor'],
    skills: ['Assembly', 'Lean Manufacturing', 'SAP PP', 'Kaizen', '5S', 'Wiring Harness'],
    quals: ['Diploma', 'BE/BTech'], specs: ['Mechanical Engineering', 'Electrical and Electronics', 'Production Engineering'],
    base: 300000, perYear: 85000,
  },
  {
    name: 'Quality', department: 'Quality',
    designations: ['Quality Engineer', 'QA/QC Engineer', 'Incoming Inspection Engineer'],
    skills: ['ISO 9001', 'IPQC', 'CAPA', 'Root Cause Analysis', 'Calibration', 'Gauge R&R'],
    quals: ['Diploma', 'BE/BTech'], specs: ['Mechanical Engineering', 'Electrical and Electronics'],
    base: 310000, perYear: 90000,
  },
  {
    name: 'Application Engineering', department: 'Application Engineering',
    designations: ['Application Engineer', 'Pre-sales Engineer', 'Solutions Engineer'],
    skills: ['Power Quality', 'Harmonics', 'Load Analysis', 'Sizing', 'Customer Handling', 'AutoCAD'],
    quals: ['BE/BTech', 'ME/MTech'], specs: ['Electrical and Electronics', 'Electrical Engineering'],
    base: 400000, perYear: 120000,
  },
  {
    name: 'Controls', department: 'Controls',
    designations: ['Controls Engineer', 'Automation Engineer', 'PLC Engineer'],
    skills: ['PLC', 'SCADA', 'Control Loops', 'Siemens TIA', 'Modbus', 'Instrumentation'],
    quals: ['BE/BTech', 'ME/MTech'], specs: ['Instrumentation', 'Electrical and Electronics'],
    base: 390000, perYear: 115000,
  },
  {
    name: 'Mechanical', department: 'Mechanical',
    designations: ['Mechanical Design Engineer', 'Enclosure Design Engineer', 'CAD Engineer'],
    skills: ['SolidWorks', 'AutoCAD', 'Sheet Metal', 'Thermal Design', 'GD&T'],
    quals: ['Diploma', 'BE/BTech', 'ME/MTech'], specs: ['Mechanical Engineering', 'Production Engineering'],
    base: 340000, perYear: 95000,
  },
  {
    name: 'Supply Chain', department: 'Supply Chain',
    designations: ['Purchase Engineer', 'Supply Chain Executive', 'Sourcing Engineer'],
    skills: ['Vendor Development', 'Negotiation', 'SAP MM', 'Costing', 'Import Documentation'],
    quals: ['BE/BTech', 'MBA', 'BCom'], specs: ['Mechanical Engineering', 'Operations', 'Commerce'],
    base: 320000, perYear: 90000,
  },
];

const EMPLOYERS = ['Amara Raja', 'Delta Electronics', 'Schneider India', 'ABB India', 'Hitachi Energy',
  'CG Power', 'Bharat Bijlee', 'Kirloskar Electric', 'Lucas-TVS', 'TVS Electronics',
  'Roots Industries', 'Elgi Equipments', 'Rane Group', 'Sanmina', 'Flex India',
  'Vestas India', 'Suzlon', 'Statcon Electronics', 'Servokon', 'Consul Neowatt'];

const INSTITUTIONS = ['Anna University', 'Thiagarajar College of Engineering', 'Mepco Schlenk',
  'PSG College of Technology', 'Kamaraj College of Engineering', 'SSN College of Engineering',
  'NIT Trichy', 'CIT Coimbatore', 'Sethu Institute of Technology', 'Velammal Engineering College',
  'Government College of Technology', 'Kongu Engineering College'];

const SOURCES = [
  ['naukri', 34], ['referral', 18], ['website', 12], ['linkedin', 10], ['campus', 9],
  ['agency', 7], ['walk_in', 5], ['indeed', 3], ['resume_db', 2],
];

/** Funnel-shaped, because a flat spread makes every conversion metric meaningless. */
const STAGES = [
  ['applied', 30], ['screening', 18], ['shortlisted', 10], ['assessment', 7],
  ['1st_level', 7], ['2nd_level', 4], ['offer', 3], ['selected', 2], ['hired', 3],
  ['not_suitable', 8], ['maybe', 3], ['future_use', 3], ['rejected', 2],
];

const RELOCATION = [
  ['already_local', 26], ['willing', 24], ['willing_with_support', 22],
  ['needs_information', 12], ['not_currently', 8], ['no', 4], ['unknown', 4],
];

const NOTICE = [[0, 14], [30, 38], [60, 26], [90, 22]];

const NOTE_SNIPPETS = [
  'Strong fundamentals. Explained harmonic distortion clearly without prompting.',
  'Good troubleshooting instinct — walked through a real field failure end to end.',
  'Limited exposure to our product range, but keen and asks good questions.',
  'Currently commuting 2 hours each way; the Srivilliputtur site would suit them better.',
  'Wants to move from services into product engineering. Genuine reasons, well articulated.',
  'Solid on paper; communication needs support for a customer-facing role.',
  'Has done type testing to IEC 61439. Directly relevant.',
  'Asked thoughtful questions about our R&D roadmap.',
  'Notice period is the only obstacle — worth waiting for.',
  'Better suited to testing or service than to design.',
];

/* ── Derivations ──────────────────────────────────────────────────────────── */

const THIS_YEAR = 2026;

/**
 * Build one coherent person.
 *
 * Every field is derived from the two facts that actually determine the rest — when
 * they graduated and what they do — so the record holds together. That is the whole
 * point: the previous generator's `55 + i * 6.5` produced values that were
 * individually legal and collectively nonsense.
 */
function makePerson(i) {
  const tn = rnd() < 0.72;                        // Tamil Nadu-weighted pool
  const first = tn ? pick(FIRST_TN) : pick(FIRST_OTHER);
  const last  = tn ? pick(LAST_TN)  : pick(LAST_OTHER);
  const disc  = pick(DISCIPLINES);

  // Graduation first; experience follows from it. A 2024 graduate cannot have 12
  // years behind them, which is the kind of thing a laddered generator produces.
  const gradYear = int(THIS_YEAR - 16, THIS_YEAR);
  const yearsSinceGrad = THIS_YEAR - gradYear;
  const totalExp = Math.max(0, Math.min(yearsSinceGrad, yearsSinceGrad === 0
    ? 0
    : yearsSinceGrad - (rnd() < 0.25 ? 1 : 0)));   // a gap year for some
  // Relevant experience is a slice of total and never exceeds it.
  const relevantExp = totalExp === 0 ? 0 : Math.round(totalExp * (0.45 + rnd() * 0.5) * 10) / 10;

  const fresher = totalExp < 1;

  // Salary from experience and discipline, with a real spread. Current first, then
  // an expectation ABOVE it — an expected CTC below the current one is not a thing.
  const current = fresher ? null
    : Math.round((disc.base + disc.perYear * totalExp * (0.85 + rnd() * 0.3)) / 1000) * 1000;
  const hikePct = 0.18 + rnd() * 0.42;             // 18-60%, which is the real range
  const expected = fresher
    ? Math.round((disc.base * (0.85 + rnd() * 0.25)) / 1000) * 1000
    : Math.round((current * (1 + hikePct)) / 1000) * 1000;

  const [city, state] = tn
    ? [pick(TN_CITIES), 'Tamil Nadu']
    : pick(OTHER_PLACES);
  const native = tn && rnd() < 0.7 ? pick(TN_CITIES) : city;

  const relocation = weighted(RELOCATION);
  // Someone already in Srivilliputtur or Virudhunagar IS local — the classification
  // must agree with the address rather than being rolled independently.
  const nearSite = ['Srivilliputtur', 'Virudhunagar', 'Sivakasi', 'Rajapalayam'].includes(city);
  const classification = fresher ? 'fresh_graduate'
    : nearSite ? 'local'
    : state === 'Tamil Nadu' ? 'regional'
    : totalExp >= 8 ? 'specialist'
    : 'national';

  // Skills: the discipline's DEFINING skill always, plus a random subset of the
  // rest.
  //
  // The defining skill is not optional, and the first draft of this generator made
  // it so — producing Power Electronics Engineers whose skill list did not include
  // "Power Electronics". That is nonsense on its face, and it also made the brief's
  // own §19 worked example ("Power electronics + 2-5 years + Tamil Nadu + willing to
  // relocate") return nothing, because the skill filter had almost nothing to match.
  // Keeping the first skill fixed also guarantees that two candidates in the same
  // discipline overlap, which is what makes "find similar candidates" meaningful.
  const rest = disc.skills.slice(1);
  const nSkills = int(2, Math.min(5, rest.length));
  const skills = [disc.skills[0]];
  for (let k = 0; k < nSkills; k++) skills.push(rest.splice(Math.floor(rnd() * rest.length), 1)[0]);

  const stage = fresher && rnd() < 0.5 ? weighted([['applied', 60], ['screening', 25], ['not_suitable', 15]]) : weighted(STAGES);

  // Spread over 90 days so the work queue and the staleness column mean something.
  const daysAgoApplied = int(0, 90);
  const daysAgoActivity = Math.max(0, daysAgoApplied - int(0, Math.min(daysAgoApplied, 25)));

  const disposition =
    stage === 'hired' ? 'hired'
    : stage === 'rejected' ? 'rejected_from_manifest'
    : stage === 'future_use' ? (rnd() < 0.5 ? 'talent_bank' : 'future_opportunity')
    : stage === 'applied' ? 'new'
    : stage === 'screening' ? 'in_screening'
    : 'active';

  const slug = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');

  return {
    full_name: `${first} ${last}`,
    email: `${slug}.${i}@${EMAIL_DOMAIN}`,
    // A real-looking Indian mobile with formatting, so the digit-normalising phone
    // search has something to normalise.
    phone: `+91 ${int(70, 99)}${int(100, 999)} ${int(10000, 99999)}`,
    discipline: disc,
    designation: fresher ? null : pick(disc.designations),
    company: fresher ? null : pick(EMPLOYERS),
    experience_years: totalExp,
    relevant_experience_years: relevantExp,
    current_salary: current,
    expected_ctc: expected,
    city, state, native,
    willing_to_relocate: nearSite ? 'already_local' : relocation,
    relocation_support_required: relocation === 'willing_with_support',
    classification,
    qualification: fresher ? pick(disc.quals) : pick(disc.quals),
    specialisation: pick(disc.specs),
    institution: pick(INSTITUTIONS),
    graduation_year: gradYear,
    skills,
    source: weighted(SOURCES),
    stage,
    disposition,
    notice_period_days: fresher ? 0 : weighted(NOTICE),
    daysAgoApplied, daysAgoActivity,
  };
}

/* ── Writing ──────────────────────────────────────────────────────────────── */

/**
 * One open vacancy per discipline, so the pipeline board, the department filter and
 * the work queue's "suited to a role we are hiring for" tile have something to show.
 *
 * Titled with a DEMO prefix so they are identifiable at a glance and removable by
 * --clean, and matched on the exact title so a re-run tops up rather than duplicates.
 */
const OPENING_PREFIX = '[DEMO] ';

async function seedOpenings(companyId) {
  let made = 0;
  for (const d of DISCIPLINES) {
    const title = `${OPENING_PREFIX}${d.designations[0]}`;
    const { rowCount } = await pool.query(
      `INSERT INTO job_openings
         (job_title, department, location, employment_type, company_id, status,
          experience_min, experience_max, salary_min, salary_max,
          description, requirements, posted_date, positions_filled, include_in_feed)
       SELECT $1, $2, 'Srivilliputtur, Tamil Nadu', 'full_time', $3, 'open',
              1, 8, $4, $5, $6, $7, CURRENT_DATE - ($8)::int, 0, FALSE
        WHERE NOT EXISTS (
          SELECT 1 FROM job_openings WHERE company_id = $3 AND job_title = $9
        )`,
      // `title` is passed twice ($1 and $9) rather than reused. A bare $n used both
      // as an INSERT target value and inside a comparison is the shape Postgres
      // rejects with "inconsistent types deduced for parameter $1" — the same trap
      // that bit the screening-outcome UPDATE and five queries in the previous audit.
      // Repeating the binding costs nothing and cannot be deduced two ways.
      [
        title, d.department, companyId,
        d.base, d.base + d.perYear * 6,
        `${d.name} role at Manifest's Srivilliputtur engineering and manufacturing site.`,
        d.skills.slice(0, 5).join(', '),
        // Staggered posting dates so vacancy aging is not identical for all ten.
        int(3, 75),
        title,
      ]
    );
    made += rowCount;
  }
  // include_in_feed stays FALSE: these are demo vacancies and must not appear on the
  // public careers portal or in the Indeed XML feed.
  if (made) console.log(`Created ${made} demo job opening(s).`);
  return made;
}

async function clean(companyId) {
  const { rows: cands } = await pool.query(
    `SELECT id FROM candidates WHERE company_id = $1 AND email LIKE $2`,
    [companyId, `%@${EMAIL_DOMAIN}`]
  );
  const idList = cands.map(c => c.id);
  if (!idList.length) {
    console.log('Nothing to clean — no demo candidates found.');
    return 0;
  }
  // Children first. Every one of these cascades, but naming them makes a future FK
  // change fail here rather than somewhere confusing.
  await pool.query(`DELETE FROM screening_responses WHERE screening_id IN (SELECT id FROM candidate_screenings WHERE candidate_id = ANY($1::int[]))`, [idList]);
  await pool.query(`DELETE FROM candidate_screenings      WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM candidate_notes           WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM candidate_activity        WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM candidate_recontact       WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM candidate_role_suitability WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM talent_pool_members       WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM candidate_stage_history   WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM candidate_applications    WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM interview_notes           WHERE candidate_id = ANY($1::int[])`, [idList]);
  await pool.query(`DELETE FROM candidates                WHERE id = ANY($1::int[])`, [idList]);
  // The demo openings, and only those with no real applications left on them.
  const { rowCount: openingsGone } = await pool.query(
    `DELETE FROM job_openings
      WHERE company_id = $1 AND job_title LIKE $2
        AND NOT EXISTS (SELECT 1 FROM candidate_applications a WHERE a.job_opening_id = job_openings.id)
        AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.applied_job_id = job_openings.id)`,
    [companyId, `${OPENING_PREFIX}%`]
  );
  console.log(`Removed ${idList.length} demo candidates and everything attached to them`
    + (openingsGone ? `, and ${openingsGone} demo opening(s).` : '.'));
  return idList.length;
}

// §220 — this writes demo candidates (consuming seq_cand), job openings and screenings. It runs ONLY against an isolated test database (scripts/test-db/README.md);
// against anything else it exits before its first write.
async function main() {
  const { guardOrExit } = await import("./test-db/guard.mjs");
  await guardOrExit(pool, "seed-recruitment-demo");
  const { rows: co } = await pool.query(
    `SELECT id, name FROM companies ORDER BY id LIMIT 1`
  );
  if (!co.length) throw new Error('No company found to seed against.');
  const companyId = co[0].id;
  console.log(`Company: ${co[0].name} (#${companyId})`);

  if (CLEAN) { await clean(companyId); return; }

  if (WITH_OPENINGS) await seedOpenings(companyId);

  const { rows: existing } = await pool.query(
    `SELECT COUNT(*)::int n FROM candidates WHERE company_id = $1 AND email LIKE $2`,
    [companyId, `%@${EMAIL_DOMAIN}`]
  );
  if (existing[0].n >= COUNT) {
    console.log(`${existing[0].n} demo candidates already present — nothing to do. Use --clean first to regenerate.`);
    return;
  }

  // Openings to apply against, and pools to bank into. Both are read, never
  // created: the seed populates CANDIDATES, and inventing job openings would put
  // fictional vacancies in the customer's own pipeline reports.
  const { rows: openings } = await pool.query(
    `SELECT id, job_title, department FROM job_openings
      WHERE company_id = $1 AND deleted_at IS NULL AND status = 'open'`,
    [companyId]
  );
  const { rows: pools } = await pool.query(
    `SELECT id, pool_name, department FROM talent_pools WHERE company_id = $1`, [companyId]
  );
  const { rows: users } = await pool.query(
    `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE rp.module = 'recruitment' AND rp.can_edit = TRUE AND u.company_id = $1
      GROUP BY u.id LIMIT 6`,
    [companyId]
  );
  const recruiterIds = users.map(u => u.id);

  console.log(`${openings.length} open opening(s), ${pools.length} pool(s), ${recruiterIds.length} recruiter(s) available.`);

  let made = 0;
  const client = await pool.connect();
  try {
    for (let i = existing[0].n; i < COUNT; i++) {
      const p = makePerson(i);
      await client.query('BEGIN');

      const appliedAt = `NOW() - INTERVAL '${p.daysAgoApplied} days'`;
      const activeAt  = `NOW() - INTERVAL '${p.daysAgoActivity} days'`;

      // An opening in the candidate's own discipline where one exists, so the
      // pipeline board is coherent. Speculative profiles (no opening) are a real
      // and common case, so ~18% get none.
      const matching = openings.filter(o =>
        String(o.department || '').toLowerCase() === p.discipline.department.toLowerCase());
      const opening = rnd() < 0.18 ? null : (matching.length ? pick(matching) : (openings.length ? pick(openings) : null));

      const { rows: cand } = await client.query(
        `INSERT INTO candidates (
           company_id, candidate_code, full_name, email, phone, source,
           current_stage, overall_status, disposition,
           experience_years, relevant_experience_years,
           current_company, current_designation,
           current_salary, expected_ctc, notice_period_days,
           location, current_city, current_state, native_place,
           willing_to_relocate, relocation_support_required, classification,
           qualification, specialisation, institution, graduation_year,
           skills, tags, applied_job_id, recruiter_id,
           created_at, updated_at, last_activity_at
         ) VALUES (
           $1, 'CAND-' || LPAD(nextval('seq_cand')::text, 5, '0'), $2, $3, $4, $5,
           $6, $7, $8,
           $9, $10,
           $11, $12,
           $13, $14, $15,
           $16, $17, $18, $19,
           $20, $21, $22,
           $23, $24, $25, $26,
           $27::jsonb, $28::jsonb, $29, $30,
           ${appliedAt}, ${activeAt}, ${activeAt}
         ) RETURNING id, full_name`,
        [
          companyId, p.full_name, p.email, p.phone, p.source,
          p.stage,
          // overall_status is DERIVED from the stage, exactly as the repository
          // derives it. Rolling it independently would seed rows that contradict
          // themselves — "stage=screening, status=rejected".
          p.stage === 'hired' ? 'hired'
            : ['rejected', 'not_suitable'].includes(p.stage) ? 'rejected'
            : 'active',
          p.disposition,
          p.experience_years, p.relevant_experience_years,
          p.company, p.designation,
          p.current_salary, p.expected_ctc, p.notice_period_days,
          `${p.city}, ${p.state}`, p.city, p.state, p.native,
          p.willing_to_relocate, p.relocation_support_required, p.classification,
          p.qualification, p.specialisation, p.institution, p.graduation_year,
          JSON.stringify(p.skills), JSON.stringify([TAG]),
          opening?.id ?? null,
          // ~30% unassigned, so the work queue's "unassigned" tile is not always 0.
          recruiterIds.length && rnd() < 0.7 ? pick(recruiterIds) : null,
        ]
      );
      const candidateId = cand[0].id;

      if (opening) {
        await client.query(
          `INSERT INTO candidate_applications
             (company_id, candidate_id, job_opening_id, stage, status, origin, is_primary, applied_at)
           VALUES ($1,$2,$3,$4,$5,'applied',TRUE, ${appliedAt})
           ON CONFLICT (candidate_id, job_opening_id) DO NOTHING`,
          [companyId, candidateId, opening.id, p.stage,
           p.stage === 'hired' ? 'hired' : ['rejected', 'not_suitable'].includes(p.stage) ? 'rejected' : 'active']
        );
      }

      // An arrival event, so every candidate has a timeline rather than a blank tab.
      await client.query(
        `INSERT INTO candidate_activity
           (company_id, candidate_id, event_type, summary, detail, actor_name, created_at)
         VALUES ($1,$2,'application_received',$3,$4::jsonb,'Pulse (demo seed)', ${appliedAt})`,
        [companyId, candidateId,
         opening ? `Application received for ${opening.job_title}` : 'Candidate profile created',
         JSON.stringify({ source: p.source, seeded: true })]
      );

      // Notes on roughly half. A module whose notes tab is always empty cannot be
      // judged.
      if (rnd() < 0.5) {
        for (let k = 0; k < int(1, 3); k++) {
          await client.query(
            `INSERT INTO candidate_notes
               (company_id, candidate_id, note_type, body, visibility, is_pinned, author_user_id, created_at)
             VALUES ($1,$2,$3,$4,'internal',$5,$6, ${activeAt})`,
            [companyId, candidateId,
             pick(['recruiter', 'screening', 'interview', 'technical', 'followup']),
             pick(NOTE_SNIPPETS), k === 0 && rnd() < 0.25,
             recruiterIds.length ? pick(recruiterIds) : null]
          );
        }
      }

      // Screenings on the candidates who have moved past applied — with a score
      // computed from the ratings, not invented, so the scorecard adds up.
      if (!['applied'].includes(p.stage) && rnd() < 0.72) {
        const fit = () => weighted([['meets', 45], ['partial', 35], ['does_not_meet', 12], ['not_assessed', 8]]);
        const rate = () => weighted([[5, 12], [4, 30], [3, 34], [2, 16], [1, 8]]);
        const ratings = {
          learning_mindset: rate(), ownership: rate(), teamwork: rate(), patience: rate(),
          problem_solving: rate(), communication: rate(), adaptability: rate(),
          relevant_knowledge: rate(), career_alignment: rate(),
        };
        const locFit = p.willing_to_relocate === 'already_local' ? 'local'
          : p.willing_to_relocate === 'willing' ? 'relocation_possible'
          : p.willing_to_relocate === 'willing_with_support' ? 'relocation_support_required'
          : p.willing_to_relocate === 'no' || p.willing_to_relocate === 'not_currently' ? 'not_willing'
          : 'not_assessed';

        // The same §14 arithmetic the server uses. Imported rather than
        // re-implemented would be better still, but the seed must not depend on the
        // repository's transaction plumbing — so the weights are spelled out and a
        // test (§14 in the workbench suite) pins the real implementation.
        const W = { eligibility: 10, relevant_knowledge: 15, learning_mindset: 15, problem_solving: 15,
          ownership: 10, teamwork: 10, patience: 10, communication: 5, career_alignment: 5, location_alignment: 5 };
        const FITF = { meets: 1, partial: 0.5, does_not_meet: 0, not_assessed: null };
        const NOTF = { acceptable: 1, needs_discussion: 0.5, not_acceptable: 0, not_assessed: null };
        const LOCF = { local: 1, regional: 0.8, relocation_possible: 0.8, relocation_support_required: 0.6, not_willing: 0, not_assessed: null };
        const fits = { qualification_fit: fit(), experience_fit: fit(), skills_fit: fit(),
          notice_fit: weighted([['acceptable', 55], ['needs_discussion', 30], ['not_acceptable', 10], ['not_assessed', 5]]) };
        const elig = [FITF[fits.qualification_fit], FITF[fits.experience_fit], FITF[fits.skills_fit], NOTF[fits.notice_fit]]
          .filter(v => v != null);
        const breakdown = {};
        let total = 0, assessed = 0;
        const section = (key, frac) => {
          if (frac == null) { breakdown[key] = { weight: W[key], scored: null, assessed: false }; return; }
          const scored = Math.round(W[key] * frac * 10) / 10;
          breakdown[key] = { weight: W[key], scored, assessed: true };
          total += scored; assessed += W[key];
        };
        section('eligibility', elig.length ? elig.reduce((a, b) => a + b, 0) / elig.length : null);
        for (const k of ['relevant_knowledge', 'learning_mindset', 'problem_solving', 'ownership', 'teamwork', 'patience', 'communication', 'career_alignment']) {
          section(k, ratings[k] / 5);
        }
        section('location_alignment', LOCF[locFit] ?? null);
        const score = Math.round(total);
        const pct = assessed ? (total / assessed) * 100 : 0;
        const recommendation = assessed < 50 ? null : pct >= 70 ? 'proceed' : pct >= 50 ? 'hold' : 'not_suitable_current_role';

        const completed = !['screening'].includes(p.stage);
        const decision = !completed ? null
          : p.stage === 'not_suitable' ? weighted([['not_suitable_current_role', 6], ['consider_other_roles', 4]])
          : p.stage === 'rejected' ? 'reject_from_manifest'
          : p.stage === 'future_use' ? (p.disposition === 'talent_bank' ? 'talent_bank' : 'future_opportunity')
          : p.stage === 'maybe' ? 'hold'
          : 'proceed';

        const { rows: appRow } = await client.query(
          `SELECT id FROM candidate_applications WHERE candidate_id = $1 AND is_primary LIMIT 1`, [candidateId]);

        await client.query(
          `INSERT INTO candidate_screenings (
             company_id, candidate_id, application_id, status,
             qualification_fit, experience_fit, skills_fit, notice_fit, location_fit, salary_fit,
             learning_mindset, ownership, teamwork, patience, problem_solving, communication,
             adaptability, relevant_knowledge, career_alignment,
             learning_mindset_evidence, total_score, score_breakdown, recommendation, decision,
             reject_reason, summary_note, screened_by, started_at, completed_at, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,
             $5,$6,$7,$8,$9,$10,
             $11,$12,$13,$14,$15,$16,
             $17,$18,$19,
             $20,$21,$22::jsonb,$23,$24,
             $25,$26,$27, ${activeAt}, ${completed ? activeAt : 'NULL'}, ${activeAt}, ${activeAt}
           )
           ON CONFLICT DO NOTHING`,
          [
            companyId, candidateId, appRow[0]?.id ?? null, completed ? 'completed' : 'draft',
            fits.qualification_fit, fits.experience_fit, fits.skills_fit, fits.notice_fit, locFit,
            weighted([['within_range', 40], ['negotiable', 35], ['above_range', 15], ['not_discussed', 10]]),
            ratings.learning_mindset, ratings.ownership, ratings.teamwork, ratings.patience,
            ratings.problem_solving, ratings.communication, ratings.adaptability,
            ratings.relevant_knowledge, ratings.career_alignment,
            rnd() < 0.5 ? pick(NOTE_SNIPPETS) : null,
            score, JSON.stringify({ ...breakdown, _assessed_weight: assessed }),
            recommendation, decision,
            decision === 'reject_from_manifest' ? 'Did not meet the minimum technical bar for the role.' : null,
            rnd() < 0.6 ? pick(NOTE_SNIPPETS) : null,
            recruiterIds.length ? pick(recruiterIds) : null,
          ]
        );
      }

      // §16: alternative departments for the ones marked not suitable here. This is
      // the whole point of the feature, so the data must show it.
      if (['not_suitable', 'maybe', 'future_use'].includes(p.stage) && rnd() < 0.75) {
        const others = DISCIPLINES.filter(d => d.name !== p.discipline.name);
        const n = int(1, 3);
        for (let k = 0; k < n; k++) {
          const d = others.splice(Math.floor(rnd() * others.length), 1)[0];
          if (!d) break;
          await client.query(
            `INSERT INTO candidate_role_suitability
               (company_id, candidate_id, department, suitability, reason, identified_by, identified_at)
             VALUES ($1,$2,$3,$4,$5,$6, ${activeAt})
             ON CONFLICT (candidate_id, LOWER(department)) DO NOTHING`,
            [companyId, candidateId, d.department,
             weighted([['strong', 3], ['potential', 6], ['not_suitable', 1]]),
             pick(NOTE_SNIPPETS), recruiterIds.length ? pick(recruiterIds) : null]
          );
        }
      }

      // §17: Talent Bank membership.
      //
      // Not only for candidates whose DISPOSITION is talent_bank. Most of the bank
      // is people who were wrong for one role and kept anyway — that is §2's entire
      // argument, and a seed where only the explicitly-banked appear would leave the
      // Talent Bank with four rows and the feature undemonstrable. A `not_suitable`
      // candidate who has been kept is `disposition = 'active'` WITH pool
      // membership, which is why searchTalentBank() treats membership alone as
      // being in the bank.
      const bankThem =
        ['talent_bank', 'future_opportunity'].includes(p.disposition) ? true
        : p.stage === 'not_suitable' ? rnd() < 0.85
        : p.stage === 'maybe' ? rnd() < 0.8
        : p.stage === 'hired' ? false
        : p.stage === 'rejected' ? false          // rejected from Manifest is not banked
        // Candidates still in play get banked too, and generously: in a real ATS
        // the Talent Bank is the LARGEST population in the module, not the
        // smallest, because every serious candidate is worth keeping. A bank of
        // thirty over a pipeline of a hundred and eighty is the wrong shape and
        // makes a four-predicate search return nothing.
        : rnd() < 0.45;

      if (bankThem && pools.length) {
        // Their own discipline's pool, plus the departments they were judged
        // suitable for — which is what makes "we have a Testing vacancy, who do we
        // already know" answerable.
        const wanted = new Set([p.discipline.department]);
        const { rows: suited } = await client.query(
          `SELECT department FROM candidate_role_suitability
            WHERE candidate_id = $1 AND suitability <> 'not_suitable'`, [candidateId]);
        for (const r of suited) wanted.add(r.department);

        for (const dept of wanted) {
          const matchPool = pools.filter(x =>
            String(x.department || '').toLowerCase() === String(dept).toLowerCase());
          const chosen = matchPool.length ? matchPool[0] : null;
          if (!chosen) continue;
          await client.query(
            `INSERT INTO talent_pool_members
               (company_id, pool_id, candidate_id, tags, reason, source_stage, added_by_user_id, added_at)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7, ${activeAt})
             ON CONFLICT (pool_id, candidate_id) DO NOTHING`,
            [companyId, chosen.id, candidateId,
             JSON.stringify(p.skills.slice(0, 2)), pick(NOTE_SNIPPETS), p.stage,
             recruiterIds.length ? pick(recruiterIds) : null]
          );
        }
      }

      // §18: recontact dates, some already due so the work queue and the cron have
      // something real to act on.
      // A recontact for every future_opportunity, and for some of the banked — a
      // recruiter does set a "check back in March" date on a candidate they parked.
      if (p.disposition === 'future_opportunity'
          || (bankThem && p.stage === 'not_suitable' && rnd() < 0.35)) {
        const dueInDays = weighted([[-20, 2], [-5, 3], [0, 2], [45, 5], [120, 6], [210, 4]]);
        await client.query(
          `INSERT INTO candidate_recontact
             (company_id, candidate_id, reason, potential_role, department, preferred_location,
              recontact_on, owner_user_id, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6, CURRENT_DATE + $7::int, $8, $8, ${activeAt})`,
          [companyId, candidateId,
           pick(['not_ready_to_relocate', 'notice_period_long', 'pursuing_course', 'no_opening', 'experience_later']),
           pick(p.discipline.designations), p.discipline.department, p.city,
           dueInDays, recruiterIds.length ? pick(recruiterIds) : null]
        );
      }

      await client.query('COMMIT');
      made += 1;
      if (made % 25 === 0) process.stdout.write(`  … ${made}\n`);
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const { rows: summary } = await pool.query(
    `SELECT
       COUNT(*)::int AS candidates,
       COUNT(*) FILTER (WHERE disposition IN ('talent_bank','future_opportunity'))::int AS banked,
       COUNT(*) FILTER (WHERE current_stage IN ('applied','screening'))::int AS to_screen,
       COUNT(*) FILTER (WHERE willing_to_relocate IN ('already_local','willing','willing_with_support'))::int AS can_relocate,
       COUNT(*) FILTER (WHERE recruiter_id IS NULL)::int AS unassigned
     FROM candidates WHERE company_id = $1 AND email LIKE $2`,
    [companyId, `%@${EMAIL_DOMAIN}`]
  );
  const { rows: extra } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM candidate_screenings s JOIN candidates c ON c.id = s.candidate_id WHERE c.email LIKE $1) AS screenings,
       (SELECT COUNT(*)::int FROM candidate_notes n JOIN candidates c ON c.id = n.candidate_id WHERE c.email LIKE $1) AS notes,
       (SELECT COUNT(*)::int FROM candidate_role_suitability r JOIN candidates c ON c.id = r.candidate_id WHERE c.email LIKE $1) AS suitability,
       (SELECT COUNT(*)::int FROM candidate_recontact rc JOIN candidates c ON c.id = rc.candidate_id WHERE c.email LIKE $1) AS recontacts,
       (SELECT COUNT(*)::int FROM talent_pool_members m JOIN candidates c ON c.id = m.candidate_id WHERE c.email LIKE $1) AS pool_members`,
    [`%@${EMAIL_DOMAIN}`]
  );

  console.log(`\nCreated ${made} candidate(s).`);
  console.log(summary[0]);
  console.log(extra[0]);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('FAILED:', e.message); pool.end(); process.exitCode = 1; });
