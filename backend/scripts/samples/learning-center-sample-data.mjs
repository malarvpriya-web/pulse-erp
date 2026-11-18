/**
 * learning-center-sample-data.mjs — one or two clearly labelled "(Sample)"
 * records on every Learning Center page (owner, 2026-11-18: "one or two sample
 * data should be there … don't delete that").
 *
 *   node scripts/samples/learning-center-sample-data.mjs
 *
 * Everything goes through the running API (:5000) as the super admin and the
 * employees themselves, so the samples obey the same rules as real data. Dates
 * are then moved back so the completed training sits ~5 months ago and its
 * 6-monthly refresher is due soon — the dashboard, compliance, before / after
 * comparison and reports all have something to show.
 * Idempotent: does nothing if a "(Sample)" training already exists.
 * Remove: delete the rows whose name / title ends in "(Sample)".
 */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(here, '../..');
dotenv.config({ path: path.join(BACKEND, '.env'), quiet: true });
const API = process.env.LND_SAMPLE_API || 'http://localhost:5000/api/v1';

const mint = (email) => {
  const out = execSync('node scripts/e2e-mint-token.mjs', { cwd: BACKEND, env: { ...process.env, E2E_LOGIN_EMAIL: email }, encoding: 'utf8' });
  const a = JSON.parse(out.split('---E2E_AUTH_BEGIN---')[1].split('---E2E_AUTH_END---')[0]);
  if (a.user.email.toLowerCase() !== email.toLowerCase()) throw new Error(`minted ${a.user.email}, wanted ${email}`);
  return a.token;
};
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
async function call(token, method, url, body) {
  const isForm = body instanceof FormData;
  const r = await fetch(API + url, { method, headers: { Authorization: `Bearer ${token}`, ...(isForm ? {} : { 'Content-Type': 'application/json' }) }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}

const db = new pg.Client({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
await db.connect();
try {
  const { rows: ex } = await db.query(`SELECT id FROM training_programs WHERE title LIKE '%(Sample)' AND deleted_at IS NULL LIMIT 1`);
  if (ex.length) { console.log('Learning Center sample data already present — nothing done.'); process.exit(0); }

  const HR = mint('superadmin@manifest.in');
  const people = { malar: { id: 1, email: 'malarvpriya@gmail.com' }, natesh: { id: 2, email: 'natesh.mayavel@manifest.in' }, anu: { id: 3, email: 'anu.natesh@manifest.in' } };
  for (const p of Object.values(people)) p.token = mint(p.email);
  const { rows: [priya] } = await db.query(`SELECT id, designation FROM employees WHERE name LIKE '%(Sample)%' AND deleted_at IS NULL ORDER BY id LIMIT 1`);

  // Skills & competencies, role requirements
  const fire = await call(HR, 'POST', '/competencies', { name: 'Fire Safety (Sample)', category: 'HSE / Safety', expected_level: 3, description: 'Prevent, respond to and evacuate safely from a fire' });
  const plc = await call(HR, 'POST', '/competencies', { name: 'PLC Programming (Sample)', category: 'Software / SCADA', expected_level: 3, description: 'Write and debug ladder logic for plant controls' });
  await call(HR, 'PUT', '/competencies/role-requirements', { role_title: 'Manager', requirements: [{ competency_id: fire.id, required_level: 3 }] });
  if (priya?.designation) await call(HR, 'PUT', '/competencies/role-requirements', { role_title: priya.designation, requirements: [{ competency_id: fire.id, required_level: 3 }, { competency_id: plc.id, required_level: 3 }] });
  await call(HR, 'POST', `/competencies/employee/${people.natesh.id}/assess`, { assessments: [{ competency_id: plc.id, assessed_level: 5, years_experience: 12, notes: 'Sample rating' }] });

  // Trainers
  const ext = await call(HR, 'POST', '/trainers', { name: 'Suresh Kumar (Sample)', trainer_type: 'external', email: 'suresh.sample@example.com', phone: '+91 98400 00000', specialization: 'Fire safety & first aid' });
  const int = await call(HR, 'POST', '/trainers', { trainer_type: 'internal', employee_id: people.natesh.id, name: 'Natesh Mayavel (Sample trainer)', specialization: 'PLC & power electronics' });

  // Certifications
  const cert = await call(HR, 'POST', '/certifications/master', { name: 'First Aid Certificate (Sample)', code: 'FA-01', issuing_body: 'St John Ambulance', category: 'Safety', validity_months: 24, is_mandatory: true, competency_id: fire.id });
  for (const [emp, issued, no] of [[people.anu.id, day(-680), 'FA-2025-118'], [people.natesh.id, day(-760), 'FA-2024-041']]) {
    const fd = new FormData(); fd.append('employee_id', String(emp)); fd.append('certification_id', String(cert.id)); fd.append('issue_date', issued); fd.append('certificate_number', no);
    await call(HR, 'POST', '/certifications/employee', fd);
  }

  // Training 1 — mandatory fire drill, repeats every 6 months, completed.
  const drill = await call(HR, 'POST', '/training/programs', {
    title: 'Fire Safety & Evacuation Drill (Sample)', category: 'Safety', mode: 'offline', scheduled_date: day(1), duration_hours: 3,
    max_participants: 25, budget: 15000, trainer_id: ext.id, venue: 'Plant 1 assembly area', is_mandatory: true, refresher_months: 6,
    competency_id: fire.id, description: 'Extinguisher types, raising the alarm, evacuation routes and the assembly point.',
    self_review_items: ['I can choose the right extinguisher for each type of fire', 'I know my evacuation route and assembly point'],
  });
  const ids = [people.malar.id, people.natesh.id, people.anu.id, ...(priya ? [priya.id] : [])];
  await call(HR, 'POST', `/training/programs/${drill.id}/enroll`, { employee_ids: ids });
  const pre = { malar: [2, 3, [2, 3]], natesh: [3, 3, [3, 2]], anu: [2, 2, [1, 2]] };
  const post = { malar: [4, 4, [4, 5], 'Now confident with CO2 vs water extinguishers.'], natesh: [4, 5, [4, 4], 'Good hands-on practice.'], anu: [4, 4, [4, 5], 'Assembly point drill was very useful.'] };
  const items = drill.self_review_items;
  const { enrollments } = await call(HR, 'GET', `/training/programs/${drill.id}`);
  const enOf = (id) => enrollments.find(e => e.employee_id === id).id;
  for (const [k, [kn, cf, it]] of Object.entries(pre)) {
    await call(people[k].token, 'POST', `/my-learning/enrollments/${enOf(people[k].id)}/self-review`, { phase: 'pre', knowledge: kn, confidence: cf,
      item_ratings: { [items[0]]: it[0], [items[1]]: it[1] }, comments: 'Want to be ready for an emergency on the shop floor.' });
  }
  const sess = await call(HR, 'POST', `/training/programs/${drill.id}/sessions`, { session_date: day(1), start_time: '10:00', end_time: '13:00', trainer_id: ext.id, venue: 'Plant 1 assembly area' });
  await call(HR, 'PUT', `/training/sessions/${sess.id}/attendance`, { records: ids.map(id => ({ employee_id: id, present: id !== priya?.id })) });
  await call(HR, 'POST', `/training/programs/${drill.id}/costs`, { cost_type: 'trainer_fee', amount: 12000, description: 'External trainer — half day' });
  await call(HR, 'POST', `/training/programs/${drill.id}/costs`, { cost_type: 'materials', amount: 2500, description: 'Extinguisher refills for the practical' });
  for (const [k, score] of [['malar', 88], ['natesh', 92], ['anu', 85]]) await call(HR, 'PUT', `/training/enrollments/${enOf(people[k].id)}`, { status: 'completed', score });
  if (priya) await call(HR, 'PUT', `/training/enrollments/${enOf(priya.id)}`, { status: 'no_show' });
  for (const [k, [kn, cf, it, c]] of Object.entries(post)) {
    await call(people[k].token, 'POST', `/my-learning/enrollments/${enOf(people[k].id)}/self-review`, { phase: 'post', knowledge: kn, confidence: cf,
      item_ratings: { [items[0]]: it[0], [items[1]]: it[1] }, comments: c });
    await call(people[k].token, 'POST', `/my-learning/enrollments/${enOf(people[k].id)}/feedback`, { rating: k === 'natesh' ? 5 : 4, comments: c });
  }
  const quiz = await call(HR, 'POST', '/assessments', { title: 'Fire Safety Quiz (Sample)', program_id: drill.id, pass_score: 60, max_attempts: 3, time_limit_mins: 10, description: 'Three quick questions after the drill.' });
  await call(HR, 'PUT', `/assessments/${quiz.id}/questions`, { questions: [
    { question_text: 'Which extinguisher is safe on an electrical panel fire?', question_type: 'mcq', options: ['Water', 'CO2', 'Foam'], correct_answer: 'CO2', marks: 2 },
    { question_text: 'You should use the lift during a fire evacuation.', question_type: 'true_false', correct_answer: 'False', marks: 1 },
    { question_text: 'Where is the assembly point for Plant 1?', question_type: 'short_answer', correct_answer: 'Main gate car park', marks: 2 }] });
  const st = await call(people.anu.token, 'POST', `/my-learning/assessments/${quiz.id}/start`);
  const qs = st.questions;
  await call(people.anu.token, 'POST', `/my-learning/attempts/${st.attempt.id}/submit`, { answers: { [qs[0].id]: 'CO2', [qs[1].id]: 'False', [qs[2].id]: 'The car park near the main gate' } });
  await call(HR, 'POST', `/training/programs/${drill.id}/status`, { status: 'completed' });

  // Move the drill ~5 months back: refresher (6 months) falls due next month.
  const back = 150;
  await db.query(`UPDATE training_programs SET scheduled_date = scheduled_date - $2::int, created_at = created_at - make_interval(days => $2::int) WHERE id = $1`, [drill.id, back + 1]);
  await db.query(`UPDATE training_enrollments SET completion_date = CURRENT_DATE - $2::int, created_at = created_at - make_interval(days => $2::int) WHERE program_id = $1`, [drill.id, back]);
  await db.query(`UPDATE training_sessions SET session_date = session_date - $2::int WHERE program_id = $1`, [drill.id, back + 1]);
  await db.query(`UPDATE training_costs SET cost_date = CURRENT_DATE - $2::int WHERE program_id = $1`, [drill.id, back]);
  await db.query(`UPDATE training_self_reviews SET submitted_at = submitted_at - make_interval(days => CASE WHEN phase = 'pre' THEN $2::int + 2 ELSE $2::int END) WHERE program_id = $1`, [drill.id, back]);
  await db.query(`UPDATE assessment_attempts SET started_at = started_at - make_interval(days => $2::int), submitted_at = submitted_at - make_interval(days => $2::int) WHERE assessment_id = $1`, [quiz.id, back]);
  // Next round, six months after the first, with everyone re-enrolled.
  const round2 = await call(HR, 'POST', `/training/programs/${drill.id}/next-round`, { scheduled_date: day(30), enroll_previous: true });

  // Training 2 — optional technical course, upcoming, internal trainer.
  const plcProg = await call(HR, 'POST', '/training/programs', {
    title: 'PLC Programming Basics (Sample)', category: 'Technical', mode: 'hybrid', scheduled_date: day(21), end_date: day(22), duration_hours: 12,
    max_participants: 12, budget: 8000, cost_per_participant: 500, trainer_id: int.id, venue: 'R&D lab', online_link: 'https://meet.example.com/plc-basics',
    competency_id: plc.id, description: 'Ladder logic, timers and counters on the lab trainer kit.',
    self_review_items: ['I can read a ladder diagram'],
  });
  await call(HR, 'POST', `/training/programs/${plcProg.id}/enroll`, { employee_ids: [people.anu.id, ...(priya ? [priya.id] : [])] });
  await call(HR, 'POST', `/training/programs/${plcProg.id}/costs`, { cost_type: 'materials', amount: 3000, description: 'Trainer kit consumables' });
  const plcQuiz = await call(HR, 'POST', '/assessments', { title: 'PLC Basics Quiz (Sample)', program_id: plcProg.id, pass_score: 70, max_attempts: 2 });
  await call(HR, 'PUT', `/assessments/${plcQuiz.id}/questions`, { questions: [
    { question_text: 'A normally-open contact in ladder logic passes power when…', question_type: 'mcq', options: ['Its input is ON', 'Its input is OFF'], correct_answer: 'Its input is ON', marks: 1 },
    { question_text: 'A TON timer starts timing when its input turns ON.', question_type: 'true_false', correct_answer: 'True', marks: 1 }] });
  await call(people.anu.token, 'POST', `/my-learning/enrollments/${(await call(HR, 'GET', `/training/programs/${plcProg.id}`)).enrollments.find(e => e.employee_id === people.anu.id).id}/self-review`,
    { phase: 'pre', knowledge: 1, confidence: 2, item_ratings: { 'I can read a ladder diagram': 1 }, comments: 'New to PLCs.' });

  // Learning path for new engineers.
  const path_ = await call(HR, 'POST', '/learning-paths', { name: 'New Engineer Onboarding (Sample)', path_type: 'onboarding', target_department: 'Engineering', due_days: 60,
    auto_assign_on_join: true, description: 'Safety first, then plant controls — for every new engineer.' });
  await call(HR, 'PUT', `/learning-paths/${path_.id}/items`, { items: [{ program_id: round2.id, is_mandatory: true }, { program_id: plcProg.id, is_mandatory: true, prerequisite_program_id: round2.id }] });
  if (priya) await call(HR, 'POST', `/learning-paths/${path_.id}/assign`, { employee_ids: [priya.id] });

  console.log(`Learning Center sample data created: trainings ${drill.id} (+ next round ${round2.id}) and ${plcProg.id}, path ${path_.id}, certification ${cert.id}, trainers ${ext.id}/${int.id}, skills ${fire.id}/${plc.id}.`);
} finally {
  await db.end();
}
