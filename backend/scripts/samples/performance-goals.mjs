#!/usr/bin/env node
/**
 * Sample Performance data for the real employees (owner, 2026-11-11: "add
 * sample data for employees, later I can remove"). Covers Goals & KPIs,
 * My Reviews (with competency scores and past reviews) and 360° Feedback.
 *
 *   node scripts/samples/performance-goals.mjs --add      add it (refuses if already there)
 *   node scripts/samples/performance-goals.mjs --remove   remove all of it
 *   node scripts/samples/performance-goals.mjs --status   count what is there
 *
 * Run from Pulse/backend. How each kind is marked, so --remove touches nothing real:
 *   goals          title "Sample: …" AND review_period "FY 2026-27 (sample)"
 *   review cycles  name "Sample: …" AND review_period ending "(sample)"
 *   reviews, competency scores, 360 feedback   belong to those sample cycles
 *
 * A manager review copies its rating into the employee's talent assessment
 * (performance.routes.js syncReviewToAssessment). --add saves those three
 * assessments to _backups/samples/; --remove puts performance_score and
 * assessment_date back and drops the history rows the sample created.
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../../src/config/db.js';

const COMPANY = 1;
const GOAL_PERIOD = 'FY 2026-27 (sample)';
const PREFIX = 'Sample: ';
const EMPLOYEES = [1, 2, 3];
const SNAPSHOT = path.resolve('../../_backups/samples/performance-sample-talent-snapshot.json');

// ── Goals & KPIs ────────────────────────────────────────────────────────────
// [title, category, priority, unit, target, achieved, weight, due, description, check-in values]
const GOALS = {
  1: [ // Malar Natesh — CEO
    ['Annual revenue', 'Growth', 'High', '₹ lakh', 2000, 1150, 40, '2027-03-31', 'Invoiced revenue for the financial year.', [420, 780, 1150]],
    ['Gross margin', 'Finance', 'High', '%', 32, 29, 25, '2027-03-31', 'Gross margin across all orders shipped.', [27, 29]],
    ['Key hires closed', 'People', 'Medium', 'hires', 4, 1, 20, '2027-03-31', 'Senior roles filled: sales head, two project engineers, QA lead.', [1]],
    ['Customer review meetings held', 'Customers', 'Low', 'meetings', 6, 6, 15, '2027-03-31', 'Half-yearly reviews with the top three customers.', [3, 6]],
  ],
  2: [ // Natesh Mayavel — CTO
    ['Product release milestones delivered', 'Delivery', 'High', 'milestones', 8, 6, 40, '2027-03-31', 'Milestones of the current release plan met on time.', [2, 4, 6]],
    ['System uptime', 'Quality', 'High', '%', 99.5, 99.7, 25, '2027-03-31', 'Uptime of the production systems this year.', [99.6, 99.7]],
    ['Critical defects closed', 'Quality', 'Medium', 'defects', 20, 5, 20, '2027-03-31', 'Open critical defects from the backlog closed and verified.', [2, 5]],
    ['Team technical training', 'Learning', 'Low', 'sessions', 6, 4, 15, '2027-03-31', 'Internal sessions run for the engineering team.', [2, 4]],
  ],
  3: [ // Anu Natesh — Manager, IT
    ['IT tickets resolved within SLA', 'Service', 'High', '%', 95, 91, 40, '2027-03-31', 'Share of helpdesk tickets closed inside the agreed time.', [86, 89, 91]],
    ['Laptop & asset audit completed', 'Operations', 'Medium', 'assets', 60, 60, 20, '2027-03-31', 'Every company laptop and device checked and tagged.', [25, 48, 60]],
    ['Security patches applied', 'Security', 'High', '%', 100, 70, 25, '2027-03-31', 'Servers and laptops on the current patch level.', [40, 70]],
    ['Backup restore tests', 'Operations', 'Low', 'tests', 4, 1, 15, '2027-03-31', 'Monthly restore drills of the database backup.', [1]],
  ],
};

// ── Review cycles ───────────────────────────────────────────────────────────
const CYCLES = {
  // Appraisal is yearly, on the financial year April–March (owner, 2026-11-11).
  past: { name: `${PREFIX}FY 2025-26 Annual Appraisal`, period: 'FY 2025-26 (sample)', fy: '2025-26',
          start: '2025-04-01', end: '2026-03-31', self: '2026-04-10', manager: '2026-04-20', calibration: '2026-04-30', status: 'completed' },
  current: { name: `${PREFIX}FY 2026-27 Annual Appraisal`, period: 'FY 2026-27 (sample)', fy: '2026-27',
             start: '2026-04-01', end: '2027-03-31', self: '2027-03-15', manager: '2027-03-31', calibration: '2027-04-15', status: 'active' },
};

// Reporting lines today: Natesh → Malar, Anu → Natesh, Malar → nobody.
const MANAGER = { 1: null, 2: 1, 3: 2 };

// Completed FY 2025-26 appraisals: [self, manager, final, kra, behavioural, self comments, achievements, challenges, manager comments]
const PAST = {
  1: [4.0, null, 4.2, 4.3, 4.0, 'A strong year for orders; hiring lagged.',
      'Closed the two largest orders of the year; opened the Coimbatore site.',
      'Senior hiring took longer than planned.', 'Board review: growth targets met, hiring plan to be tightened. (sample)'],
  2: [3.8, 4.0, 4.0, 4.1, 3.9, 'Release cadence improved; defect backlog still high.',
      'Moved releases to a fortnightly cycle; uptime above target.',
      'Critical defect backlog grew in the second half.', 'Reliable delivery and good uptime. Bring the defect backlog down next year. (sample)'],
  3: [4.2, 4.3, 4.3, 4.4, 4.2, 'Helpdesk SLA consistently above 90 %.',
      'Rolled out the new laptop image; cut ticket backlog by half.',
      'Patch rollout delayed by vendor issues.', 'Excellent service levels and ownership. Ready for a wider IT scope. (sample)'],
};

// Current FY 2026-27 appraisals: Malar and Natesh have their self-assessment to do; Anu has
// submitted hers, so Natesh (her manager) has one to review.
const CURRENT = {
  1: { status: 'self_review_pending' },
  2: { status: 'self_review_pending' },
  3: { status: 'self_submitted', self: 4.0, selfComments: 'Kept SLA above 90 % and finished the asset audit early.',
       achievements: 'Asset audit 100 % complete; SLA at 91 %.', challenges: 'Patch level at 70 % — two servers need downtime.',
       learnings: 'Planning maintenance windows with the business earlier.', next: 'Patch level to 100 %; quarterly restore drills.' },
};

// Competency scores on the completed FY 2025-26 appraisals (self, manager), out of 5.
const COMPETENCIES = {
  1: [['Strategic thinking', 4.5, 4.5], ['Communication', 4.0, 4.0], ['Decision making', 4.0, 4.5], ['People leadership', 3.5, 3.5], ['Customer focus', 4.5, 4.0]],
  2: [['Technical depth', 4.5, 4.5], ['Delivery & planning', 3.5, 4.0], ['Communication', 3.5, 3.5], ['People leadership', 4.0, 3.5], ['Problem solving', 4.5, 4.5]],
  3: [['Service orientation', 4.5, 4.5], ['Ownership', 4.5, 4.5], ['Communication', 4.0, 4.0], ['Technical depth', 3.5, 4.0], ['Planning', 3.5, 3.5]],
};

// 360° feedback in the FY 2026-27 cycle: [about, from, relationship, anonymous, status, score, text, strengths, improvements]
const FEEDBACK = [
  [2, 1, 'manager', false, 'submitted', 4, 'Dependable on delivery; keeps the team calm under pressure. (sample)',
   'Release planning, calm under pressure', 'Delegate more of the reviews to the team'],
  [2, 3, 'subordinate', true, 'submitted', 4.5, 'Explains decisions clearly and backs the team. (sample)',
   'Clear direction, approachable', 'More regular one-to-ones'],
  [3, 1, 'skip_level', false, 'submitted', 4.5, 'Reliable owner of IT; users trust the helpdesk. (sample)',
   'Ownership, follow-through', 'Plan patch windows further ahead'],
  [1, 2, 'subordinate', false, 'submitted', 4, 'Sets clear targets and is quick to unblock decisions. (sample)',
   'Clarity, quick decisions', 'Share the hiring plan earlier with leads'],
  // Waiting to be given — each person has one in "Feedback to Give".
  [3, 2, 'manager', false, 'pending'],       // Natesh gives feedback on Anu
  [1, 3, 'skip_level', true, 'pending'],     // Anu gives (anonymous) feedback on Malar
  [2, 2, 'self', false, 'pending'],          // Natesh's self-feedback
];

const statusOf = (achieved, target) => {
  const p = Math.min(100, Math.round((achieved / target) * 100));
  return { pct: p, status: p >= 100 ? 'achieved' : p < 30 ? 'at_risk' : 'active' };
};

const cycleIdsSql = `SELECT id FROM review_cycles WHERE name LIKE '${PREFIX}%' AND review_period LIKE '%(sample)'`;

async function count(db) {
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0].n;
  return {
    goals: await one(`SELECT count(*)::int n FROM performance_goals WHERE goal_title LIKE $1 AND review_period = $2`, [`${PREFIX}%`, GOAL_PERIOD]),
    cycles: await one(`SELECT count(*)::int n FROM (${cycleIdsSql}) c`),
    reviews: await one(`SELECT count(*)::int n FROM performance_reviews WHERE review_cycle_id IN (${cycleIdsSql})`),
    competencies: await one(`SELECT count(*)::int n FROM performance_competencies WHERE review_id IN (SELECT id FROM performance_reviews WHERE review_cycle_id IN (${cycleIdsSql}))`),
    feedback: await one(`SELECT count(*)::int n FROM performance_feedback WHERE cycle_id IN (${cycleIdsSql})`),
  };
}

async function addGoals(c) {
  let goals = 0, checkins = 0;
  for (const [empId, list] of Object.entries(GOALS)) {
    for (const [title, category, priority, unit, target, achieved, weight, due, desc, history] of list) {
      const { pct, status } = statusOf(achieved, target);
      const { rows: [g] } = await c.query(
        `INSERT INTO performance_goals (employee_id, review_period, goal_title, goal_description, target_value,
            achieved_value, weightage, status, progress_pct, due_date, priority, category, goal_type, unit, company_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'individual',$13,$14) RETURNING id`,
        [empId, GOAL_PERIOD, PREFIX + title, desc, target, achieved, weight, status, pct, due, priority, category, unit, COMPANY]);
      goals++;
      for (let i = 0; i < history.length; i++) {
        await c.query(
          `INSERT INTO goal_checkins (goal_id, achieved_value, note, checked_in_by, created_at)
           VALUES ($1, $2, $3, $4, NOW() - make_interval(days => $5))`,
          [g.id, history[i], i === history.length - 1 ? 'Latest update (sample)' : 'Progress update (sample)',
           empId, (history.length - 1 - i) * 14]);
        checkins++;
      }
    }
  }
  return { goals, checkins };
}

async function addReviews(c) {
  const ids = {};
  for (const [key, cy] of Object.entries(CYCLES)) {
    const { rows: [r] } = await c.query(
      `INSERT INTO review_cycles (name, period, start_date, end_date, status, company_id, cycle_type,
          self_review_deadline, manager_review_deadline, calibration_deadline, review_period, description)
       VALUES ($1,$2,$3,$4,$5,$6,'annual',$7,$8,$9,$10,'Sample annual appraisal — remove with scripts/samples/performance-goals.mjs --remove')
       RETURNING id`,
      [cy.name, cy.period, cy.start, cy.end, cy.status, COMPANY, cy.self, cy.manager, cy.calibration, cy.period]);
    await c.query('UPDATE review_cycles SET financial_year = $2 WHERE id = $1', [r.id, cy.fy]);
    ids[key] = r.id;
  }
  const out = { reviews: 0, competencies: 0, feedback: 0 };
  for (const emp of EMPLOYEES) {
    // Last year's completed appraisal, created earlier so this year's is "current".
    const [self, mgrRating, final, kra, beh, selfC, ach, chal, mgrC] = PAST[emp];
    const { rows: [past] } = await c.query(
      `INSERT INTO performance_reviews (employee_id, manager_id, review_cycle_id, review_period, status,
          self_rating, manager_rating, final_rating, overall_rating, kra_score, behavioral_score,
          self_comments, achievements, challenges, manager_comments,
          self_submitted_at, manager_submitted_at, review_type, company_id, created_at)
       VALUES ($1,$2,$3,$4,'completed',$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,
               '2026-04-08 10:00+05:30','2026-04-18 16:00+05:30','annual',$14,'2026-04-01 09:00+05:30')
       RETURNING id`,
      [emp, MANAGER[emp], ids.past, CYCLES.past.period, self, mgrRating, final, kra, beh, selfC, ach, chal, mgrC, COMPANY]);
    out.reviews++;
    for (const [name, s, m] of COMPETENCIES[emp]) {
      await c.query(
        `INSERT INTO performance_competencies (review_id, employee_id, competency_name, self_score, manager_score, expected_score, company_id)
         VALUES ($1,$2,$3,$4,$5,4,$6)`, [past.id, emp, name, s, m, COMPANY]);
      out.competencies++;
    }
    const cur = CURRENT[emp];
    await c.query(
      `INSERT INTO performance_reviews (employee_id, manager_id, review_cycle_id, review_period, status,
          self_rating, self_comments, achievements, challenges, learnings, next_goals, self_submitted_at,
          review_type, company_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'annual',$13,NOW())`,
      [emp, MANAGER[emp], ids.current, CYCLES.current.period, cur.status, cur.self ?? null, cur.selfComments ?? null,
       cur.achievements ?? null, cur.challenges ?? null, cur.learnings ?? null, cur.next ?? null,
       cur.status === 'self_submitted' ? new Date() : null, COMPANY]);
    out.reviews++;
  }
  for (const [about, from, rel, anon, status, score, text, strengths, improvements] of FEEDBACK) {
    await c.query(
      `INSERT INTO performance_feedback (employee_id, feedback_provider_id, cycle_id, company_id, relationship,
          is_anonymous, due_date, status, overall_score, feedback_text, strengths, improvements, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [about, from, ids.current, COMPANY, rel, anon, CYCLES.current.self, status, score ?? null, text ?? null,
       strengths ?? null, improvements ?? null, status === 'submitted' ? new Date() : null]);
    out.feedback++;
  }
  return out;
}

async function add() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const have = await count(c);
    if (Object.values(have).some(n => n > 0)) throw new Error(`Sample data is already there (${JSON.stringify(have)}) — run --remove first.`);
    const { rows: emps } = await c.query(
      `SELECT id FROM employees WHERE id = ANY($1) AND company_id = $2 AND deleted_at IS NULL`, [EMPLOYEES, COMPANY]);
    if (emps.length !== EMPLOYEES.length) throw new Error(`Expected employees ${EMPLOYEES.join(', ')} in company ${COMPANY}`);
    // Talent assessments as they stand, for --remove to put back.
    const talent = (await c.query(
      `SELECT id, employee_id, performance_score, assessment_date::text AS assessment_date FROM talent_assessments WHERE employee_id = ANY($1)`, [EMPLOYEES])).rows;
    const maxHistory = (await c.query(`SELECT COALESCE(MAX(id), 0)::int m FROM talent_assessment_history`)).rows[0].m;
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ taken_at: new Date().toISOString(), talent, max_history_id: maxHistory }, null, 1));
    const g = await addGoals(c);
    const r = await addReviews(c);
    await c.query('COMMIT');
    console.log(`Added ${g.goals} goals (${g.checkins} check-ins), 2 review cycles, ${r.reviews} reviews, `
      + `${r.competencies} competency scores and ${r.feedback} 360° feedback rows.`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('Nothing added:', e.message);
    process.exitCode = 1;
  } finally { c.release(); }
}

async function remove() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const cycles = (await c.query(cycleIdsSql)).rows.map(r => r.id);
    const reviews = (await c.query(`SELECT id FROM performance_reviews WHERE review_cycle_id = ANY($1)`, [cycles])).rows.map(r => r.id);
    const goals = (await c.query(
      `SELECT id FROM performance_goals WHERE goal_title LIKE $1 AND review_period = $2`, [`${PREFIX}%`, GOAL_PERIOD])).rows.map(r => r.id);
    const n = {};
    n.feedback = (await c.query(`DELETE FROM performance_feedback WHERE cycle_id = ANY($1) OR review_id = ANY($2)`, [cycles, reviews])).rowCount;
    n.competencies = (await c.query(`DELETE FROM performance_competencies WHERE review_id = ANY($1)`, [reviews])).rowCount;
    n.calibration = (await c.query(`DELETE FROM calibration_adjustments WHERE review_id = ANY($1)`, [reviews]).catch(() => ({ rowCount: 0 }))).rowCount;
    n.reviews = (await c.query(`DELETE FROM performance_reviews WHERE id = ANY($1)`, [reviews])).rowCount;
    n.calibration_sessions = (await c.query(`DELETE FROM calibration_sessions WHERE cycle_id = ANY($1)`, [cycles]).catch(() => ({ rowCount: 0 }))).rowCount;
    n.cycles = (await c.query(`DELETE FROM review_cycles WHERE id = ANY($1)`, [cycles])).rowCount;
    n.checkins = (await c.query(`DELETE FROM goal_checkins WHERE goal_id = ANY($1)`, [goals])).rowCount;
    n.goals = (await c.query(`DELETE FROM performance_goals WHERE id = ANY($1)`, [goals])).rowCount;
    // Undo any talent-assessment sync a manager review on the sample made.
    if (fs.existsSync(SNAPSHOT)) {
      const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
      n.talent_history = (await c.query(
        `DELETE FROM talent_assessment_history WHERE id > $1 AND employee_id = ANY($2) AND change_action = 'performance_review'`,
        [snap.max_history_id, EMPLOYEES])).rowCount;
      n.talent_restored = 0;
      for (const t of snap.talent) {
        const r = await c.query(
          `UPDATE talent_assessments SET performance_score = $2, assessment_date = $3::date
            WHERE id = $1 AND (performance_score IS DISTINCT FROM $2 OR assessment_date IS DISTINCT FROM $3::date)`,
          [t.id, t.performance_score, t.assessment_date]);
        n.talent_restored += r.rowCount;
      }
    }
    await c.query('COMMIT');
    if (fs.existsSync(SNAPSHOT)) fs.unlinkSync(SNAPSHOT);
    console.log('Removed:', JSON.stringify(n));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('Nothing removed:', e.message);
    process.exitCode = 1;
  } finally { c.release(); }
}

const arg = process.argv[2];
try {
  if (arg === '--add') await add();
  else if (arg === '--remove') await remove();
  else if (arg === '--status') console.log('Sample data:', JSON.stringify(await count(pool)));
  else { console.log('Use --add, --remove or --status'); process.exitCode = 1; }
} finally {
  await pool.end();
}
