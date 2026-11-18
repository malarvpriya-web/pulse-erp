#!/usr/bin/env node
/**
 * Sample data for checking "My Recruitment Work" live — DEV ONLY.
 *
 *   node scripts/samples/recruitment-work-queue.mjs          # create
 *   node scripts/samples/recruitment-work-queue.mjs --clean  # remove it (do this before go-live)
 *   node scripts/samples/recruitment-work-queue.mjs --clean --dry-run  # show what --clean would remove, delete nothing
 *
 * Everything is created THROUGH THE RUNNING API (backend on :5000) as
 * superadmin@manifest.in, so the app's own rules run: requisition approval via
 * the Approval Center, stage history, the timeline, the auto-drafted offer. Only
 * the dates the queue measures are moved back afterwards with SQL (the API
 * records "now"), and each such change is listed in BACKDATES below.
 *
 * Every row is marked so --clean removes exactly this and nothing else:
 *   candidates  name "(Sample)", email @example.com, tag 'sample'
 *   jobs        title starts "[SAMPLE]"
 *   pool        "[SAMPLE] Power electronics bench"
 *
 * Interviews use real employees 2 (lead) and 3 (panel) so "My interviews" has
 * something to show when they sign in. They get in-app notifications only — no
 * SMTP is configured, so no email leaves the system.
 *
 * Expected tile counts after a create (company 1, nothing else in Recruitment):
 *   need screening 2 · interviews today 1 · feedbacks pending 1 · waiting 3+ days 1
 *   offers pending 2 · joining pending 2 · due for recontact 1 · suited to a role 1
 *   Talent Bank 1 · unassigned 3 · assigned to me (superadmin) 4 · my draft screenings 1
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import pool from '../../src/config/db.js';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to run in production.'); process.exit(1); }

const BASE = process.env.SAMPLE_API || 'http://localhost:5000/api/v1';
const ACTOR = 'superadmin@manifest.in';
const LEAD_EMP = 2;    // Natesh Mayavel (Engineering)
const PANEL_EMP = 3;   // Anu Natesh
const COMPANY = 1;

const { rows: [actor] } = await pool.query(
  `SELECT u.id, u.email, u.role, us.company_id FROM users u
     LEFT JOIN user_scope us ON us.user_id = u.id AND us.is_primary = true
    WHERE u.email = $1 AND u.is_active`, [ACTOR]);
if (!actor) { console.error(`${ACTOR} not found or inactive`); process.exit(1); }
const token = jwt.sign({ userId: actor.id, email: actor.email, role: actor.role, company_id: actor.company_id ?? COMPANY },
  process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data)}`);
  return data;
}

// ── --clean ────────────────────────────────────────────────────────────────
async function clean() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: cands } = await c.query(
      `SELECT id FROM candidates WHERE company_id = $1 AND full_name LIKE '%(Sample)' AND email LIKE '%@example.com'`, [COMPANY]);
    const ids = cands.map(r => r.id);
    const { rows: jobs } = await c.query(`SELECT id FROM job_openings WHERE company_id = $1 AND job_title LIKE '[SAMPLE]%'`, [COMPANY]);
    const jids = jobs.map(r => r.id);
    const done = {};
    const del = async (label, sql, args) => { const r = await c.query(sql, args); done[label] = r.rowCount; };
    // Employees hired from a sample candidate (the live check of 2026-11-18
    // accepted one): their login (+ roles, scope), joining checklist and the
    // creation log. A hire writes nothing else (checked table by table).
    const { rows: emps } = await c.query(
      `SELECT id FROM employees WHERE company_id = $1 AND source_candidate_id = ANY($2)`, [COMPANY, ids]);
    const eids = emps.map(r => r.id);
    const { rows: logins } = await c.query(`SELECT id FROM users WHERE employee_id = ANY($1)`, [eids]);
    const uids = logins.map(r => r.id);
    await del('user_roles', `DELETE FROM user_roles WHERE user_id = ANY($1)`, [uids]);
    await del('user_scope', `DELETE FROM user_scope WHERE user_id = ANY($1)`, [uids]);
    await del('users', `DELETE FROM users WHERE id = ANY($1)`, [uids]);
    await del('hr_onboarding_checklist_progress', `DELETE FROM hr_onboarding_checklist_progress WHERE employee_id = ANY($1)`, [eids]);
    await del('recruitment_employee_creation_log', `DELETE FROM recruitment_employee_creation_log WHERE candidate_id = ANY($1)`, [ids]);
    await del('recruitment_agency_fees', `DELETE FROM recruitment_agency_fees WHERE candidate_id = ANY($1)`, [ids]);
    // "Prepare salary proposal" on a sample offer (draft only — an approved one
    // would also have an employee_salary_assignments row).
    await del('employee_salary_assignments', `DELETE FROM employee_salary_assignments WHERE employee_id = ANY($1)`, [eids]);
    await del('salary_revision_proposals', `DELETE FROM salary_revision_proposals WHERE employee_id = ANY($1)`, [eids]);
    await del('employees', `DELETE FROM employees WHERE id = ANY($1)`, [eids]);
    // Offer decision history (Approval Center) for the sample offers.
    await del('approvals (offers)', `DELETE FROM approvals WHERE module_name = 'offer' AND title IN
      (SELECT 'Offer #' || id::text FROM offer_letters WHERE candidate_id = ANY($1))`, [ids]);
    await del('interview_notes', `DELETE FROM interview_notes WHERE candidate_id = ANY($1)`, [ids]);
    await del('interview_schedules', `DELETE FROM interview_schedules WHERE candidate_id = ANY($1)`, [ids]);
    await del('offer_letters', `DELETE FROM offer_letters WHERE candidate_id = ANY($1)`, [ids]);
    await del('candidate_recontact', `DELETE FROM candidate_recontact WHERE candidate_id = ANY($1)`, [ids]);
    await del('candidate_role_suitability', `DELETE FROM candidate_role_suitability WHERE candidate_id = ANY($1)`, [ids]);
    await del('talent_pool_members', `DELETE FROM talent_pool_members WHERE candidate_id = ANY($1)`, [ids]);
    await del('candidate_screenings', `DELETE FROM candidate_screenings WHERE candidate_id = ANY($1)`, [ids]);
    await del('candidate_notes', `DELETE FROM candidate_notes WHERE candidate_id = ANY($1)`, [ids]);
    await del('candidate_activity', `DELETE FROM candidate_activity WHERE candidate_id = ANY($1)`, [ids]);
    await del('candidate_stage_history', `DELETE FROM candidate_stage_history WHERE candidate_id = ANY($1)`, [ids]);
    await del('candidate_applications', `DELETE FROM candidate_applications WHERE candidate_id = ANY($1) OR job_opening_id = ANY($2)`, [ids, jids]);
    await del('notifications', `DELETE FROM notifications WHERE module_name = 'recruitment' AND reference_id::text = ANY($1)`, [ids.map(String)]);
    await del('candidates', `DELETE FROM candidates WHERE id = ANY($1)`, [ids]);
    await del('job_distributions', `DELETE FROM job_distributions WHERE job_opening_id = ANY($1)`, [jids]);
    const { rows: reqs } = await c.query(`SELECT requisition_id FROM job_openings WHERE id = ANY($1)`, [jids]);
    await del('job_openings', `DELETE FROM job_openings WHERE id = ANY($1)`, [jids]);
    await del('approvals', `DELETE FROM approvals WHERE module_name = 'requisition' AND reference_id IN
      (SELECT id FROM job_requisitions WHERE company_id = $1 AND job_title LIKE '[SAMPLE]%')`, [COMPANY]);
    await del('job_requisitions', `DELETE FROM job_requisitions WHERE company_id = $1 AND (job_title LIKE '[SAMPLE]%' OR id = ANY($2))`,
      [COMPANY, reqs.map(r => r.requisition_id).filter(Boolean)]);
    await del('talent_pools', `DELETE FROM talent_pools WHERE company_id = $1 AND pool_name LIKE '[SAMPLE]%'`, [COMPANY]);
    const { rows: [a] } = await c.query(
      `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, old_data_json, company_id, created_at)
       VALUES (NULL, 'recruitment', 'delete', 'work-queue sample set', 'sample_data', $1::jsonb, $2, NOW()) RETURNING id`,
      [JSON.stringify(done), COMPANY]);
    // --dry-run: everything above ran (so every FK is proven), then undone.
    if (process.argv.includes('--dry-run')) {
      await c.query('ROLLBACK');
      console.log('DRY RUN — would remove (nothing deleted):', done);
      return;
    }
    await c.query('COMMIT');
    console.log('Removed:', done, 'audit', a.id);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// ── create ─────────────────────────────────────────────────────────────────
async function create() {
  const { rows: [exists] } = await pool.query(
    `SELECT COUNT(*)::int n FROM candidates WHERE company_id = $1 AND full_name LIKE '%(Sample)'`, [COMPANY]);
  if (exists.n) { console.error(`${exists.n} sample candidates already exist — run with --clean first.`); process.exit(1); }

  const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: process.env.APP_TIMEZONE || 'Asia/Kolkata' });
  const today = ymd(new Date());
  const plus = (n) => ymd(new Date(Date.now() + n * 86400000));

  // Requisitions → Approval Center → openings.
  async function opening(title, department, extra) {
    const rq = await api('POST', '/recruitment/requisitions', {
      job_title: title, department, number_of_positions: 2, priority: 'high', employment_type: 'Full-time',
      job_description: `${title} — sample requisition for checking the work queue.`, location: 'Coimbatore',
    });
    await api('PUT', `/recruitment/requisitions/${rq.id}`, { status: 'pending_approval' });
    await api('POST', `/approvals/requisition:${rq.id}/approve`, { comment: 'Sample data' });
    const op = await api('POST', '/recruitment/openings', {
      requisition_id: rq.id, job_title: title, department, location: 'Coimbatore', employment_type: 'Full-time', ...extra,
    });
    return { req: rq.id, opening: op.id };
  }
  const pe = await opening('[SAMPLE] Power Electronics Engineer', 'Engineering',
    { experience_min: 2, experience_max: 6, salary_min: 600000, salary_max: 1000000, skills_required: 'SMPS, MATLAB, PCB design' });
  const fs = await opening('[SAMPLE] Field Service Engineer', 'Service',
    { experience_min: 1, experience_max: 4, salary_min: 400000, salary_max: 650000, skills_required: 'UPS servicing, battery testing' });
  console.log('Openings', pe, fs);

  const people = [
    ['A', 'Arun Prakash',      'Diploma',  3, 'L&T Electrical',     'Service Technician'],
    ['B', 'Divya Lakshmi',     'BE/BTech', 4, 'Delta Electronics',  'Design Engineer'],
    ['C', 'Karthik Raman',     'BE/BTech', 5, 'Schneider Electric', 'Senior Engineer'],
    ['D', 'Meena Sundaram',    'ME/MTech', 3, 'Microtek',           'R&D Engineer'],
    ['E', 'Suresh Kumar',      'BE/BTech', 6, 'Luminous Power',     'Lead Engineer'],
    ['F', 'Priya Venkatesh',   'BE/BTech', 4, 'APC by Schneider',   'Hardware Engineer'],
    ['G', 'Rahul Das',         'ME/MTech', 5, 'Exide Industries',   'Power Engineer'],
    ['H', 'Lakshmi Narayanan', 'BE/BTech', 2, 'Su-Kam',             'Graduate Engineer'],
    ['I', 'Vignesh Bala',      'Diploma',  2, 'Amara Raja',         'Field Technician'],
  ];
  const id = {};
  for (const [k, name, qual, exp, company, desig] of people) {
    const slug = name.toLowerCase().replace(/\s+/g, '.');
    const c = await api('POST', '/recruitment/candidates', {
      full_name: `${name} (Sample)`, email: `${slug}.sample@example.com`, phone: `90000000${10 + Object.keys(id).length}`,
      source: 'careers', applied_job_id: pe.opening, current_company: company, current_designation: desig,
      experience_years: exp, notice_period_days: [30, 60, 90][exp % 3], expected_ctc: 500000 + exp * 90000,
      skills: ['Power electronics', 'Troubleshooting'], location: 'Coimbatore', qualification: qual,
      graduation_year: 2025 - exp, notes: 'Sample candidate for checking My Recruitment Work.',
    });
    id[k] = c.id ?? c.candidate?.id;
  }
  await api('POST', '/recruitment/candidates/bulk-action', { candidate_ids: Object.values(id), action: 'add_tag', value: 'sample' });

  const move = async (k, ...stages) => { for (const s of stages) await api('POST', `/recruitment/candidates/${id[k]}/move-stage`, { new_stage: s, notes: 'Sample' }); };

  // B: in screening, assigned to me, screening saved as a draft.
  await move('B', 'screening');
  await api('POST', `/recruitment/candidates/${id.B}/screening`, {
    qualification_fit: 'meets', experience_fit: 'meets', communication: 4, problem_solving: 3, summary_note: 'Draft — call back on notice period.',
  }).catch(e => console.warn('  screening draft skipped:', e.message));
  // C: shortlisted, then left alone (backdated below).
  await move('C', 'screening', 'shortlisted');
  // D: 1st level; interview "yesterday" with no feedback.
  await move('D', 'screening', 'shortlisted', '1st_level');
  const ivD = await api('POST', '/recruitment/interviews', {
    candidate_id: id.D, job_opening_id: pe.opening, interview_date: today, interview_time: '11:00', interview_mode: 'in_person',
    interviewer_id: LEAD_EMP, interview_round: '1st_level', notes: 'Sample',
  });
  // E: 2nd level; interview today 15:00, video, lead + panel.
  await move('E', 'screening', 'shortlisted', '1st_level', '2nd_level');
  await api('POST', '/recruitment/interviews', {
    candidate_id: id.E, job_opening_id: pe.opening, interview_date: today, interview_time: '15:00', interview_mode: 'video',
    meeting_link: 'https://meet.example.com/sample-2nd-level', interviewer_id: LEAD_EMP, panel_employee_ids: [PANEL_EMP],
    interview_round: '2nd_level', notes: 'Sample',
  });
  // F: selected, offer drafted.
  await move('F', 'screening', 'shortlisted', '1st_level', '2nd_level', 'selected');
  await api('POST', '/recruitment/offers', {
    candidate_id: id.F, job_opening_id: pe.opening, designation: 'Power Electronics Engineer',
    offered_salary: 840000, joining_date: plus(30), offer_expiry_date: plus(7), notes: 'Sample',
  });
  // G: offer stage (auto-drafted offer), sent for approval.
  await move('G', 'screening', 'shortlisted', '1st_level', '2nd_level', 'offer');
  let offerG = null;
  for (let i = 0; i < 10 && !offerG; i++) {
    const { rows } = await pool.query(`SELECT id FROM offer_letters WHERE candidate_id = $1 AND deleted_at IS NULL`, [id.G]);
    offerG = rows[0]?.id; if (!offerG) await new Promise(r => setTimeout(r, 300));
  }
  if (offerG) {
    await api('PUT', `/recruitment/offers/${offerG}`, { designation: 'Senior Power Electronics Engineer', offered_salary: 960000, joining_date: plus(45) });
    await api('PUT', `/recruitment/offers/${offerG}`, { offer_status: 'pending_approval' });
  } else console.warn('  G: no auto-drafted offer appeared');
  // H: Talent Bank, recontact due today.
  const tp = await api('POST', '/talent/pools', { pool_name: '[SAMPLE] Power electronics bench', department: 'Engineering', description: 'Sample pool' });
  await move('H', 'screening');
  await api('POST', `/recruitment/candidates/${id.H}/talent-bank`, { pool_ids: [tp.id ?? tp.pool?.id], tags: ['sample'], reason: 'Good fit, no vacancy at his level now' });
  await api('POST', `/recruitment/candidates/${id.H}/recontact`, {
    recontact_on: today, reason: 'future_opening', potential_role: 'Junior Design Engineer', department: 'Engineering',
  });
  // I: not right for this role, but suits Service (open vacancy).
  await move('I', 'screening', 'rejected');
  await api('POST', `/recruitment/candidates/${id.I}/suitability`, { departments: ['Service'], reason: 'Strong field background; suits Field Service Engineer', identified_from_job_id: pe.opening });

  // Assign me (superadmin) on B, C, F, G.
  await api('POST', '/recruitment/candidates/bulk-action', { candidate_ids: [id.B, id.C, id.F, id.G], action: 'recruiter', value: actor.id });

  // ── BACKDATES — the API stamps "now"; the queue measures age. ──────────
  await pool.query(`UPDATE interview_schedules SET interview_date = CURRENT_DATE - 1 WHERE id = $1`, [ivD.id]);
  await pool.query(`UPDATE candidates SET last_activity_at = NOW() - INTERVAL '6 days' WHERE id = $1`, [id.C]);
  await pool.query(`UPDATE candidate_recontact SET recontact_on = CURRENT_DATE - 1 WHERE candidate_id = $1`, [id.H]);

  const { rows: [a] } = await pool.query(
    `INSERT INTO audit_logs (user_id, module_name, action_type, reference_id, reference_type, new_data_json, company_id, created_at)
     VALUES ($1, 'recruitment', 'create', 'work-queue sample set', 'sample_data', $2::jsonb, $3, NOW()) RETURNING id`,
    [actor.id, JSON.stringify({ candidates: id, openings: [pe, fs], pool: tp.id ?? null }), COMPANY]);

  const wq = await api('GET', '/recruitment/work-queue');
  console.log('Candidates', id, 'audit', a.id);
  console.log('Work queue now:', wq.counts);
}

try { if (process.argv.includes('--clean')) await clean(); else await create(); }
catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
finally { await pool.end(); }
