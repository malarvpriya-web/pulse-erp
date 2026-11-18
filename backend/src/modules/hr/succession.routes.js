// backend/src/modules/hr/succession.routes.js
import express from 'express';
import pool from '../../config/db.js';
import { companyOf, employeeOf } from '../../shared/scope.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { toCsvObjects } from '../../shared/csv.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { ratingProblem } from '../../shared/ratings.js';
import { vocabularyValues } from '../../shared/masterVocabulary.js';
import { linkTrainingAction } from './lnd/lndSuccession.js';

// performance_score is numeric(3,2) (§209): two decimals are kept, a third
// would be rounded by PostgreSQL, so it is refused.
const scoreProblem = (v) => ratingProblem(v, { label: 'performance_score', decimals: 2 });

const router = express.Router();

/* ─── Company scope: fails CLOSED (§209) ─────────────────────────────────────
   Every succession table is per-company. A login with no company (including a
   global-scope super admin) used to reach `cidClause(null)`, which adds NO
   filter — every company's talent ratings in one grid. Refused here, before
   any SQL runs, so getCid() below is never null. */
router.use((req, res, next) => {
  if (companyOf(req) == null) {
    return res.status(403).json({ message: 'Succession data needs a company — this login has none' });
  }
  next();
});

/* ─── helpers ────────────────────────────────────────────────────────────── */

function scoreToAxis(score) {
  if (score <= 2) return 1;
  if (score <= 3) return 2;
  return 3;
}

const CELL_LABELS = {
  '3_3': 'Stars',                 '3_2': 'High Performers',   '3_1': 'Workhorses',
  '2_3': 'Diamonds in the Rough', '2_2': 'Core Contributors', '2_1': 'Inconsistent Players',
  '1_3': 'Question Marks',        '1_2': 'Underperformers',   '1_1': 'Low Performance / Low Potential',
};

// A null company used to return '' — no filter at all. The router guard above
// makes that unreachable; throwing keeps it so if a route is ever mounted
// without the guard.
function cidClause(cid, params, alias = '') {
  if (cid == null) throw new Error('succession: company scope missing');
  const col = alias ? `${alias}.company_id` : 'company_id';
  params.push(cid);
  return ` AND ${col} = $${params.length}`;
}

const getCid = (req) => companyOf(req);

/* ─── Access: the `succession` permission (§209) ─────────────────────────────
   These used to be two role lists checked against the single `req.user.role`.
   A non-primary role was invisible, the live `hr` role was in neither list, and
   `manager` / `department_head` read every colleague's ratings company-wide.
   requirePermission resolves the union of every role held and fails closed;
   who holds it is administered in Roles Setup (migration 20261029000004). */
const requireHRRead = requirePermission('succession', 'view');
const requireExport = requirePermission('succession', 'export');
const WRITE_ACTION  = { POST: 'add', PUT: 'edit', PATCH: 'edit', DELETE: 'delete' };
const writeGuards   = Object.fromEntries(
  Object.entries(WRITE_ACTION).map(([m, a]) => [m, requirePermission('succession', a)]));
function requireHRWrite(req, res, next) {
  const guard = writeGuards[req.method];
  if (!guard) return res.status(405).json({ message: 'Method not allowed' });
  return guard(req, res, next);
}
/** CSV downloads additionally need succession:export. */
const exportGate = (req, res, next) =>
  (req.query.format === 'csv' ? requireExport(req, res, next) : next());

/* ─── Same-company references ────────────────────────────────────────────────
   Ids in a request body or path were trusted as-is, so a caller could attach
   another company's employee to its plans, or reach another company's role,
   pool or plan by id. Each check answers "does every one of these ids belong
   to the caller's company?". A missing id counts as foreign. */
async function allInCompany(db, table, ids, cid) {
  const list = [...new Set(ids.filter(v => v != null && v !== '').map(Number))];
  if (!list.length) return true;
  if (list.some(n => !Number.isInteger(n))) return false;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${table} WHERE id = ANY($1::int[]) AND company_id = $2`, [list, cid]);
  return rows[0].n === list.length;
}
const employeesInCompany = (db, ids, cid) => allInCompany(db, 'employees', ids, cid);
/** Pipeline levels may be the company's own or a shared (NULL-company) default. */
async function levelsUsable(db, ids, cid) {
  const list = [...new Set(ids.filter(v => v != null && v !== '').map(Number))];
  if (!list.length) return true;
  if (list.some(n => !Number.isInteger(n))) return false;
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM leadership_pipeline_levels
      WHERE id = ANY($1::int[]) AND (company_id = $2 OR company_id IS NULL)`, [list, cid]);
  return rows[0].n === list.length;
}
const ownsRow = (db, table, id, cid) => allInCompany(db, table, [id], cid);

/* ─── Test employees ─────────────────────────────────────────────────────────
   employees.is_test marks records the user explicitly approved as test data
   (2026-10-29: EMP005 and EMP006 only). Succession READS leave them out — every
   grid, count, alert, report and export below — and nothing else in the app
   changes. Their stored succession rows are kept as they are. NOT EXISTS, so a
   row whose employee is missing (e.g. employee_id 4) still shows as before. */
const notTest = (col) => `NOT EXISTS (SELECT 1 FROM employees tx WHERE tx.id = ${col} AND tx.is_test)`;
const testEmployee = (res) =>
  res.status(400).json({ message: 'This employee is marked as a test record and is excluded from succession', code: 'TEST_EMPLOYEE' });
/** Is any of these employees a test record? (A write must not add one.) */
async function anyTestEmployee(db, ids) {
  const list = [...new Set(ids.filter(v => v != null && v !== '').map(Number))].filter(Number.isInteger);
  if (!list.length) return false;
  const { rows } = await db.query(`SELECT 1 FROM employees WHERE id = ANY($1::int[]) AND is_test LIMIT 1`, [list]);
  return rows.length > 0;
}
const notInCompany = (res, what = 'employee') =>
  res.status(400).json({ message: `Every ${what} must belong to your company` });

/* ─── Employees who have left (2026-11-12) ───────────────────────────────────
   succession_employment_phase() (migration 20261112000001) reads an employee's
   status and deleted_at as 'employed', 'notice' or 'left', with the spellings
   of employeeStatus.js. One rule everywhere in Succession:
     - someone who has LEFT is never COUNTED (bench strength, candidate counts,
       pipeline headcount, pool sizes, the 9-box, HiPo, reports);
     - lists that hold work to clean up (role holder, candidates, pipeline,
       plans, mentoring, pools) still SHOW them, with employment_phase, so HR
       can see and replace them;
     - nobody who has left can be ADDED anywhere.
   Someone serving notice still counts and is shown with a notice badge.
   The employees trigger raises the alert and the notifications when it happens. */
const phaseOf = (alias) => `succession_employment_phase(${alias}.status, ${alias}.deleted_at)`;
const counted = (col) =>
  `EXISTS (SELECT 1 FROM employees cx WHERE cx.id = ${col} AND NOT cx.is_test AND ${phaseOf('cx')} <> 'left')`;
/** Ids among `ids` whose employee has left. */
async function leftEmployees(db, ids) {
  const list = [...new Set(ids.filter(v => v != null && v !== '').map(Number))].filter(Number.isInteger);
  if (!list.length) return [];
  const { rows } = await db.query(
    `SELECT id FROM employees e WHERE id = ANY($1::int[]) AND ${phaseOf('e')} = 'left'`, [list]);
  return rows.map(r => r.id);
}
const leftEmployee = (res) =>
  res.status(400).json({ message: 'This employee has left the company and cannot be added to succession', code: 'EMPLOYEE_LEFT' });

/* Readiness has ONE source: the employee's 9-box rating (talent_assessments
   .readiness). The candidate and pipeline readiness columns are no longer read
   or written (migration 20261112000001). A successor with no rating, or a
   rating outside the vocabulary, is 'unclassified' ("Not rated"). */
const readinessOf = (empCol, cidCol) =>
  `(SELECT ${readinessClass('rx.readiness')} FROM talent_assessments rx WHERE rx.employee_id = ${empCol} AND rx.company_id = ${cidCol})`;
const readyCol = (empCol, cidCol) => `COALESCE(${readinessOf(empCol, cidCol)}, '${UNCLASSIFIED}')`;

/* ─── Partial updates ────────────────────────────────────────────────────────
   The PATCH routes used COALESCE($n, col), so a field could never be cleared
   (a target level, a due date, notes), and the critical-role PATCH cleared the
   holder whenever the body left it out. A column is now changed only when its
   key is present in the body; '' and null clear it; `required` columns ignore
   a clear. Returns the SET fragments; values are pushed onto `params`. */
function patchSet(body, cols, params) {
  const sets = [];
  for (const [col, opt = {}] of Object.entries(cols)) {
    if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
    let v = body[col];
    if (v === '' || v === undefined) v = null;
    if (v == null && opt.required) continue;
    if (opt.json && v != null) v = JSON.stringify(v);
    params.push(v);
    sets.push(`${col} = $${params.length}${opt.cast ? `::${opt.cast}` : ''}`);
  }
  return sets;
}
const isDate = (v) => v == null || v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(v)));
function dateProblem(fields) {
  for (const [name, v] of Object.entries(fields)) {
    if (!isDate(v)) return { message: `${name} must be a date (YYYY-MM-DD)`, field: name, code: 'INVALID_DATE' };
  }
  return null;
}
function textProblem(fields, max = 200) {
  for (const [name, v] of Object.entries(fields)) {
    if (v != null && (typeof v !== 'string' || v.length > max)) return { message: `${name} must be text of at most ${max} characters`, field: name };
  }
  return null;
}

/* ─── Vocabularies (§210) ────────────────────────────────────────────────────
   No column below has a CHECK, so any string was stored as-is. Every
   succession_plans row in Manifest carries 'SEED readiness level', which no
   count recognises: each role showed a successor ("Covered") while the
   ready-now, 1–2 and 3–5 year counts were all 0. The lists are the ones the
   screens offer (READY_LABELS, the risk selects). Writes are checked; stored
   rows are not touched. */
const READINESS   = ['ready-now', '1-2-years', '3-5-years', 'not_ready'];
const RISK        = ['low', 'medium', 'high'];
const FREQUENCIES = ['monthly', 'quarterly', 'half-yearly', 'annually'];
const PLAN_STATUS   = ['active', 'paused', 'completed', 'cancelled'];        // DevelopmentPlans STATUS_COLORS
const ACTION_STATUS = ['pending', 'in_progress', 'completed', 'cancelled'];  // DevelopmentPlans ACTION_STATUS
const MENTOR_STATUS = ['active', 'completed', 'cancelled'];
const ACTION_TYPES  = ['task', 'training', 'stretch_assignment', 'mentoring', 'project', 'certification', 'secondment'];
// Pool types are the SUCCESSION_POOL_TYPE master (Settings → Master Data),
// not a constant (HR audit 2026-11-16, migration 20261116000008). The fallback
// is the seed, used only if the master cannot be read.
const POOL_TYPE_SEED = ['Leadership', 'Technical', 'High Potential', 'Project Leaders', 'Graduate', 'General'];
async function poolTypeProblem(req, value) {
  if (value == null || value === '') return null;
  const allowed = await vocabularyValues('SUCCESSION_POOL_TYPE', companyOf(req), POOL_TYPE_SEED);
  const hit = allowed.some(v => v.toLowerCase() === String(value).trim().toLowerCase());
  return hit ? null : { message: `pool_type must be one of: ${allowed.join(', ')}`, field: 'pool_type', code: 'INVALID_VALUE' };
}
const MOBILITY      = ['flexible', 'local_only', 'regional', 'international', 'remote_only'];
const SUCCESSOR_TYPES = ['primary', 'secondary', 'tertiary', 'emergency'];
const ENTRY_STATUS  = ['active', 'inactive', 'promoted', 'exited'];
// The CHECK constraints of migration 20261112000001 hold the same lists.
/* Unclassified readiness (§211): a stored readiness that is NULL or outside
   READINESS — in Manifest, the seeder's 'SEED readiness level'. It counts as a
   successor but in none of the readiness categories. Stored values are kept;
   only the reporting names them. */
const UNCLASSIFIED = 'unclassified';
const readinessClass = (col) =>
  `CASE WHEN ${col} IN (${READINESS.map(r => `'${r}'`).join(',')}) THEN ${col} ELSE '${UNCLASSIFIED}' END`;

/** First problem with `fields` ({name: [value, allowed]}); absent values pass. */
function vocabProblem(fields) {
  for (const [name, [value, allowed]] of Object.entries(fields)) {
    if (value != null && value !== '' && !allowed.includes(value)) {
      return { message: `${name} must be one of: ${allowed.join(', ')}`, field: name, code: 'INVALID_VALUE' };
    }
  }
  return null;
}
/** potential_score / leadership_score are INTEGER 1–5 columns. */
function intScoreProblem(fields) {
  for (const [name, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return { message: `${name} must be a whole number from 1 to 5`, field: name, code: 'INVALID_RATING' };
    }
  }
  return null;
}

/* talent_assessments.assessed_by, development_plans.created_by,
   employee_talent_pools.created_by and the other "by" columns are read as
   EMPLOYEES (every reader joins employees). They were written with users.id,
   so "Assessed by" named whichever employee shared that number. They now
   store the caller's linked employee, or NULL for a login without one. The
   login itself is still recorded in audit_logs and changed_by_user_id. */

/* ─── Assessment history ─────────────────────────────────────────────────────
   The previous version of an assessment is copied into history BEFORE it is
   replaced, edited or deleted, in the same transaction, with who did it and
   how. `assessed_by` on the copy is the previous assessor; the actor of the
   change is `changed_by_user_id` (a users.id). Returns the rows copied. */
async function snapshotAssessment(client, { where, params, action, req }) {
  const n = params.length;
  const { rowCount } = await client.query(
    `INSERT INTO talent_assessment_history
       (employee_id, assessed_by, assessment_date, assessment_period, performance_score,
        potential_score, flight_risk, readiness, leadership_score, mobility,
        talent_classification, notes, company_id,
        assessment_id, change_action, changed_by_user_id)
     SELECT employee_id, assessed_by, assessment_date, assessment_period, performance_score,
            potential_score, flight_risk, readiness, leadership_score, mobility,
            talent_classification, notes, company_id,
            id, $${n + 1}, $${n + 2}
       FROM talent_assessments WHERE ${where}`,
    [...params, action, req.user?.userId ?? null]
  );
  return rowCount;
}

// CSV helper
// Delegates to the shared writer, which additionally neutralises values a
// spreadsheet would EVALUATE as formulas (a leading = + - @). `minimal: true`
// preserves this helper's conditional quoting, so only the injection changes.
// See shared/csv.js.
const toCSV = (rows) => (rows.length ? toCsvObjects(rows, { minimal: true }) : '');

/* No automatic assessments (§209). A RUN_SUCCESSION_SEED import-time block used
   to give the first 12 employees of the whole table fabricated performance,
   potential, flight-risk and readiness ratings — real people included; five of
   Manifest's six assessments carry its "Auto-generated seed assessment" note.
   A rating is an authorised person's judgement, so it is only ever written by
   an HR request below. Existing rows, seeded ones included, are left alone. */

/* ═══════════════════════════════════════════════════════════════════════════
   TALENT ASSESSMENTS — Full CRUD + history
═══════════════════════════════════════════════════════════════════════════ */

router.get('/assessments', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const params = [];
  try {
    const { rows } = await pool.query(
      `SELECT ta.id, ta.employee_id, ta.performance_score, ta.potential_score,
              ta.flight_risk, ta.readiness, ta.notes, ta.assessment_date,
              ta.leadership_score, ta.mobility, ta.talent_classification, ta.assessment_period,
              e.name AS employee_name, e.department, e.designation,
              a.name AS assessed_by_name
       FROM talent_assessments ta
       JOIN  employees e ON e.id = ta.employee_id
       LEFT JOIN employees a ON a.id = ta.assessed_by
       WHERE NOT e.is_test AND ${phaseOf('e')} <> 'left'${cidClause(cid, params, 'ta')}
       ORDER BY ta.potential_score DESC, ta.performance_score DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/assessments', requireHRWrite, async (req, res) => {
  const {
    employee_id, performance_score, potential_score,
    flight_risk = 'low', readiness = '1-2-years', notes,
    leadership_score, mobility = 'flexible', talent_classification, assessment_period,
  } = req.body;
  if (!employee_id || !performance_score || !potential_score)
    return res.status(400).json({ message: 'employee_id, performance_score, potential_score required' });
  const badScore = scoreProblem(performance_score);
  if (badScore) return res.status(400).json({ message: badScore });
  const bad = intScoreProblem({ potential_score, leadership_score })
    || vocabProblem({ flight_risk: [flight_risk, RISK], readiness: [readiness, READINESS], mobility: [mobility, MOBILITY] })
    || textProblem({ assessment_period, talent_classification }, 100)
    || textProblem({ notes }, 2000);
  if (bad) return res.status(400).json(bad);

  const cid        = getCid(req);
  const assessedBy = await employeeOf(req, pool);
  // talent_assessments is UNIQUE (employee_id) across ALL companies, so the
  // upsert below would otherwise overwrite another company's assessment of an
  // employee id posted from here.
  if (!(await employeesInCompany(pool, [employee_id], cid))) return notInCompany(res);
  if (await anyTestEmployee(pool, [employee_id])) return testEmployee(res);
  if ((await leftEmployees(pool, [employee_id])).length) return leftEmployee(res);
  const client     = await pool.connect();
  try {
    await client.query('BEGIN');

    // Snapshot existing assessment into history before overwriting
    await snapshotAssessment(client, {
      where: 'employee_id = $1 AND company_id = $2', params: [employee_id, cid],
      action: 'reassessed', req,
    });

    const { rows } = await client.query(
      `INSERT INTO talent_assessments
         (employee_id, assessed_by, performance_score, potential_score,
          flight_risk, readiness, notes, assessment_date, leadership_score,
          mobility, talent_classification, assessment_period, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE,$8,$9,$10,$11,$12)
       ON CONFLICT (employee_id) DO UPDATE SET
         performance_score=$3, potential_score=$4, flight_risk=$5,
         readiness=$6, notes=$7, assessed_by=$2, assessment_date=CURRENT_DATE,
         leadership_score=$8, mobility=$9, talent_classification=$10,
         assessment_period=$11
       WHERE talent_assessments.company_id = $12
       RETURNING *`,
      [employee_id, assessedBy, performance_score, potential_score, flight_risk,
       readiness, notes, leadership_score || null, mobility,
       talent_classification || null, assessment_period || null, cid]
    );

    // Log perf sync
    await client.query(
      `INSERT INTO succession_perf_sync_log
         (employee_id, source, performance_score, potential_score, synced_by, company_id)
       VALUES ($1,'manual',$2,$3,$4,$5)`,
      [employee_id, performance_score, potential_score, req.user?.userId ?? null, cid]
    );

    // The employee is ours but the existing assessment row is not (the upsert's
    // WHERE refused it): change nothing rather than create or move it.
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This employee\'s assessment is held under another company' });
    }

    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

router.patch('/assessments/:id', requireHRWrite, captureBefore('talent_assessments'), async (req, res) => {
  const {
    performance_score, potential_score, flight_risk, readiness, notes,
    leadership_score, mobility, talent_classification, assessment_period,
  } = req.body;
  const badScore = performance_score == null ? null : scoreProblem(performance_score);
  if (badScore) return res.status(400).json({ message: badScore });
  const bad = intScoreProblem({ potential_score, leadership_score })
    || vocabProblem({ flight_risk: [flight_risk, RISK], readiness: [readiness, READINESS], mobility: [mobility, MOBILITY] })
    || textProblem({ assessment_period, talent_classification }, 100)
    || textProblem({ notes }, 2000);
  if (bad) return res.status(400).json(bad);
  const cid    = getCid(req);
  // Scores, risk and readiness cannot be cleared; notes, classification,
  // period, leadership and mobility can (they used to stick once set).
  const params = [req.params.id];
  const sets = patchSet(req.body, {
    performance_score: { required: true }, potential_score: { required: true },
    flight_risk: { required: true }, readiness: { required: true },
    notes: {}, leadership_score: {}, mobility: {}, talent_classification: {}, assessment_period: {},
  }, params);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock, then keep the version being replaced. An edit used to overwrite in
    // place with no history row at all.
    const { rows: locked } = await client.query(
      `SELECT id FROM talent_assessments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, cid]);
    if (!locked.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Assessment not found' });
    }
    await snapshotAssessment(client, {
      where: 'id = $1 AND company_id = $2', params: [req.params.id, cid], action: 'edited', req,
    });
    const { rows } = await client.query(
      `UPDATE talent_assessments SET ${[...sets, 'assessment_date = CURRENT_DATE'].join(', ')}
       WHERE id = $1${cidClause(cid, params)} RETURNING *`,
      params
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

router.delete('/assessments/:id', requireHRWrite, captureBefore('talent_assessments'), async (req, res) => {
  const cid    = getCid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The deleted assessment survives in history — a deletion used to leave
    // no trace of the rating that had been recorded.
    const kept = await snapshotAssessment(client, {
      where: 'id = $1 AND company_id = $2', params: [req.params.id, cid], action: 'deleted', req,
    });
    if (!kept) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Assessment not found' });
    }
    await client.query(`DELETE FROM talent_assessments WHERE id = $1 AND company_id = $2`, [req.params.id, cid]);
    await client.query('COMMIT');
    res.json({ message: 'Deleted' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

// Assessment history for an employee. `changed_by_name` is who made each
// change (users.id); `assessed_by_name` is the assessor of that version.
router.get('/assessments/:employeeId/history', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const params = [req.params.employeeId];
  try {
    const { rows } = await pool.query(
      `SELECT h.*, e.name AS assessed_by_name, u.name AS changed_by_name
       FROM talent_assessment_history h
       LEFT JOIN employees e ON e.id = h.assessed_by
       LEFT JOIN users u ON u.id = h.changed_by_user_id
       WHERE h.employee_id = $1${cidClause(cid, params, 'h')}
       ORDER BY h.created_at DESC, h.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* Catch-up sync from completed performance reviews (2026-11-12). A review
   already writes its rating here when it is finalised (performance.routes.js
   syncReviewToAssessment). This button covers reviews finished before that
   existed, or a rating changed by hand since. For each current employee of the
   company, the latest COMPLETED review (calibrated rating, else final rating)
   replaces the 9-box performance score when it differs. The replaced version
   goes to history first. `dry_run: true` only lists what would change. */
router.post('/assessments/sync-from-reviews', requireHRWrite, async (req, res) => {
  const cid = getCid(req);
  const dryRun = req.body?.dry_run === true;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: candidates } = await client.query(
      `SELECT DISTINCT ON (pr.employee_id)
              pr.employee_id, e.name, COALESCE(pr.calibrated_rating, pr.final_rating) AS score,
              ta.id AS assessment_id, ta.performance_score AS current_score
         FROM performance_reviews pr
         JOIN employees e ON e.id = pr.employee_id AND e.company_id = $1
         LEFT JOIN talent_assessments ta ON ta.employee_id = pr.employee_id
        WHERE pr.company_id = $1 AND pr.deleted_at IS NULL AND pr.status = 'completed'
          AND COALESCE(pr.calibrated_rating, pr.final_rating) BETWEEN 1 AND 5
          AND NOT e.is_test AND ${phaseOf('e')} <> 'left'
          AND (ta.id IS NULL OR ta.company_id = $1)
        ORDER BY pr.employee_id, COALESCE(pr.hr_submitted_at, pr.updated_at) DESC NULLS LAST, pr.id DESC`,
      [cid]);
    const changes = candidates.filter(c => c.current_score == null || Number(c.current_score) !== Number(c.score));
    if (dryRun) {
      await client.query('ROLLBACK');
      return res.json({ dry_run: true, would_update: changes.length, changes });
    }
    const assessedBy = await employeeOf(req, pool);
    for (const c of changes) {
      await snapshotAssessment(client, {
        where: 'employee_id = $1 AND company_id = $2', params: [c.employee_id, cid], action: 'performance_sync', req });
      await client.query(
        `INSERT INTO talent_assessments (employee_id, assessed_by, performance_score, assessment_date, company_id)
         VALUES ($1, $2, $3, CURRENT_DATE, $4)
         ON CONFLICT (employee_id) DO UPDATE SET performance_score = $3, assessed_by = $2, assessment_date = CURRENT_DATE
         WHERE talent_assessments.company_id = $4`,
        [c.employee_id, assessedBy, c.score, cid]);
      await client.query(
        `INSERT INTO succession_perf_sync_log (employee_id, source, performance_score, potential_score, synced_by, company_id)
         SELECT $1, 'performance_review', $2, potential_score, $3, $4 FROM talent_assessments WHERE employee_id = $1`,
        [c.employee_id, c.score, req.user?.userId ?? null, cid]);
    }
    await client.query('COMMIT');
    res.json({ updated: changes.length, checked: candidates.length, changes });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

// Sync one employee from a performance review (API; the screen uses the
// catch-up sync above).
router.post('/assessments/sync-from-performance', requireHRWrite, async (req, res) => {
  const { employee_id, performance_score, potential_score } = req.body;
  if (!employee_id || !performance_score)
    return res.status(400).json({ message: 'employee_id and performance_score required' });
  const badScore = scoreProblem(performance_score);
  if (badScore) return res.status(400).json({ message: badScore });
  const badPotential = intScoreProblem({ potential_score });
  if (badPotential) return res.status(400).json(badPotential);

  const cid = getCid(req);
  const assessedBy = await employeeOf(req, pool);
  if (!(await employeesInCompany(pool, [employee_id], cid))) return notInCompany(res);
  if (await anyTestEmployee(pool, [employee_id])) return testEmployee(res);
  if ((await leftEmployees(pool, [employee_id])).length) return leftEmployee(res);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Snapshot existing
    await snapshotAssessment(client, {
      where: 'employee_id = $1 AND company_id = $2', params: [employee_id, cid],
      action: 'performance_sync', req,
    });
    const { rows } = await client.query(
      `INSERT INTO talent_assessments
         (employee_id, assessed_by, performance_score, potential_score, assessment_date, company_id)
       VALUES ($1,$2,$3,$4,CURRENT_DATE,$5)
       ON CONFLICT (employee_id) DO UPDATE SET
         performance_score = $3,
         potential_score   = COALESCE($4, talent_assessments.potential_score),
         assessed_by       = $2,
         assessment_date   = CURRENT_DATE
       WHERE talent_assessments.company_id = $5
       RETURNING *`,
      [employee_id, assessedBy, performance_score, potential_score || null, cid]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This employee\'s assessment is held under another company' });
    }
    await client.query(
      `INSERT INTO succession_perf_sync_log
         (employee_id, source, performance_score, potential_score, synced_by, company_id)
       VALUES ($1,'performance_review',$2,$3,$4,$5)`,
      [employee_id, performance_score, potential_score || null, req.user?.userId ?? null, cid]
    );
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   9-BOX MATRIX
═══════════════════════════════════════════════════════════════════════════ */

router.get('/nine-box', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const params = [];
  try {
    const { rows } = await pool.query(
      `SELECT ta.id, ta.employee_id, ta.performance_score, ta.potential_score,
              ta.flight_risk, ta.readiness, ta.notes, ta.leadership_score, ta.mobility,
              ta.talent_classification, ta.assessment_period,
              e.name AS employee_name, e.department, e.designation, ${phaseOf('e')} AS employment_phase
       FROM talent_assessments ta
       JOIN employees e ON e.id = ta.employee_id
       WHERE NOT e.is_test AND ${phaseOf('e')} <> 'left'${cidClause(cid, params, 'ta')}`,
      params
    );

    const boxes = {};
    for (let perf = 1; perf <= 3; perf++)
      for (let pot = 1; pot <= 3; pot++) {
        const key = `${perf}_${pot}`;
        boxes[key] = { performance: perf, potential: pot, label: CELL_LABELS[key], employees: [] };
      }
    for (const r of rows) {
      const perf = scoreToAxis(r.performance_score);
      const pot  = scoreToAxis(r.potential_score);
      boxes[`${perf}_${pot}`].employees.push({
        id: r.id, employee_id: r.employee_id, name: r.employee_name,
        department: r.department, designation: r.designation,
        performance_score: r.performance_score, potential_score: r.potential_score,
        flight_risk: r.flight_risk, readiness: r.readiness, notes: r.notes,
        leadership_score: r.leadership_score, mobility: r.mobility,
        talent_classification: r.talent_classification,
        assessment_period: r.assessment_period, employment_phase: r.employment_phase,
      });
    }
    res.json(Object.values(boxes));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   CRITICAL ROLES — Full CRUD (enhanced)
═══════════════════════════════════════════════════════════════════════════ */

router.get('/critical-roles', requireHRRead, async (req, res) => {
  const cid    = getCid(req);
  const params = [];
  try {
    const { rows } = await pool.query(
      `SELECT cr.*,
              e.name AS current_holder_name,
              CASE WHEN e.id IS NULL THEN NULL ELSE ${phaseOf('e')} END AS holder_phase,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${counted('sp.candidate_employee_id')})::int AS candidate_count,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id
                  AND NOT ${counted('sp.candidate_employee_id')}
                  AND NOT EXISTS (SELECT 1 FROM employees tx WHERE tx.id = sp.candidate_employee_id AND tx.is_test))::int AS left_candidate_count,
              EXISTS(SELECT 1 FROM succession_plans sp
                     WHERE sp.critical_role_id=cr.id AND ${counted('sp.candidate_employee_id')}
                       AND ${readyCol('sp.candidate_employee_id', 'cr.company_id')} = 'ready-now') AS has_ready_now,
              EXISTS(SELECT 1 FROM succession_plans sp
                     WHERE sp.critical_role_id=cr.id AND ${counted('sp.candidate_employee_id')}) AS has_any_successor
       FROM critical_roles cr
       LEFT JOIN employees e ON e.id = cr.current_holder_id AND NOT e.is_test
       WHERE 1=1${cidClause(cid, params, 'cr')}
       ORDER BY
         CASE cr.risk_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
         cr.role_title`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/critical-roles', requireHRWrite, async (req, res) => {
  const {
    role_title, department, current_holder_id, risk_level = 'medium',
    reason, knowledge_domain, vacancy_impact, expected_vacancy_date,
    min_experience_years = 0, required_certifications = [],
  } = req.body;
  if (!role_title || !String(role_title).trim()) return res.status(400).json({ message: 'role_title required', field: 'role_title' });
  const badRisk = vocabProblem({ risk_level: [risk_level, RISK] })
    || textProblem({ role_title, department, knowledge_domain }, 200)
    || textProblem({ reason, vacancy_impact }, 2000)
    || dateProblem({ expected_vacancy_date });
  if (badRisk) return res.status(400).json(badRisk);
  const cid = getCid(req);
  try {
    if (!(await employeesInCompany(pool, [current_holder_id], cid))) return notInCompany(res);
    if (await anyTestEmployee(pool, [current_holder_id])) return testEmployee(res);
    if ((await leftEmployees(pool, [current_holder_id])).length) return leftEmployee(res);
    const { rows } = await pool.query(
      `INSERT INTO critical_roles
         (role_title, department, current_holder_id, risk_level, reason,
          knowledge_domain, vacancy_impact, expected_vacancy_date,
          min_experience_years, required_certifications, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [role_title, department, current_holder_id || null, risk_level, reason,
       knowledge_domain || null, vacancy_impact || null, expected_vacancy_date || null,
       min_experience_years, JSON.stringify(required_certifications), cid]
    );
    // Check zero-successor alert on creation
    await _checkAndCreateAlert(rows[0].id, cid);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/critical-roles/:id', requireHRWrite, captureBefore('critical_roles'), async (req, res) => {
  const {
    role_title, department, current_holder_id, risk_level, reason,
    knowledge_domain, vacancy_impact, expected_vacancy_date,
  } = req.body;
  const cid    = getCid(req);
  const badRisk = vocabProblem({ risk_level: [risk_level, RISK] })
    || textProblem({ role_title, department, knowledge_domain }, 200)
    || textProblem({ reason, vacancy_impact }, 2000)
    || dateProblem({ expected_vacancy_date });
  if (badRisk) return res.status(400).json(badRisk);
  try {
    if (!(await employeesInCompany(pool, [current_holder_id], cid))) return notInCompany(res);
    if (await anyTestEmployee(pool, [current_holder_id])) return testEmployee(res);
    // A holder who has left may stay as the stored holder (shown "left"),
    // but nobody who has left can be newly made the holder.
    if (current_holder_id) {
      const { rows: [cur] } = await pool.query(`SELECT current_holder_id FROM critical_roles WHERE id = $1 AND company_id = $2`, [req.params.id, cid]);
      if (Number(cur?.current_holder_id) !== Number(current_holder_id) && (await leftEmployees(pool, [current_holder_id])).length)
        return leftEmployee(res);
    }
    const params = [req.params.id];
    const sets = patchSet(req.body, {
      role_title: { required: true }, department: {}, current_holder_id: {}, risk_level: { required: true },
      reason: {}, knowledge_domain: {}, vacancy_impact: {}, expected_vacancy_date: { cast: 'date' },
      min_experience_years: { required: true }, required_certifications: { json: true, cast: 'jsonb', required: true },
    }, params);
    const { rows } = await pool.query(
      `UPDATE critical_roles SET ${[...sets, 'updated_at = NOW()'].join(', ')}
       WHERE id = $1${cidClause(cid, params)} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Critical role not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/critical-roles/:id', requireHRWrite, captureBefore('critical_roles'), async (req, res) => {
  const cid    = getCid(req);
  const params = [req.params.id];
  try {
    const { rows } = await pool.query(
      `DELETE FROM critical_roles WHERE id = $1${cidClause(cid, params)} RETURNING id`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Critical role not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── Candidates (succession pipeline) ──────────────────────────────────── */

// Both candidate routes keyed on the role id ALONE: any company could read
// another's successors with their ratings, and the PUT deleted another
// company's succession plan before re-inserting its own rows into it.
router.get('/critical-roles/:id/candidates', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    if (!(await ownsRow(pool, 'critical_roles', req.params.id, cid)))
      return res.status(404).json({ message: 'Critical role not found' });
    const { rows } = await pool.query(
      `SELECT sp.id, sp.critical_role_id, sp.candidate_employee_id, sp.rank, sp.development_actions,
              sp.last_reviewed, sp.is_emergency_successor, sp.successor_type,
              e.name AS candidate_name, e.department, e.designation, ${phaseOf('e')} AS employment_phase,
              ta.performance_score, ta.potential_score, ta.flight_risk,
              ta.leadership_score, ta.mobility, ta.talent_classification,
              -- one source: the 9-box rating (§ readiness, 2026-11-12)
              ${readinessClass('ta.readiness')} AS readiness, ta.readiness IS NOT NULL AS is_rated
       FROM succession_plans sp
       JOIN  employees e ON e.id = sp.candidate_employee_id
       LEFT JOIN talent_assessments ta ON ta.employee_id = sp.candidate_employee_id AND ta.company_id = $2
       WHERE sp.critical_role_id = $1 AND sp.company_id = $2 AND NOT e.is_test
       ORDER BY sp.rank`,
      [req.params.id, cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/critical-roles/:id/candidates', requireHRWrite, async (req, res) => {
  const { candidates = [] } = req.body;
  const cid = getCid(req);
  if (!Array.isArray(candidates)) return res.status(400).json({ message: 'candidates must be a list' });
  try {
    if (!(await ownsRow(pool, 'critical_roles', req.params.id, cid)))
      return res.status(404).json({ message: 'Critical role not found' });
    if (!(await employeesInCompany(pool, candidates.map(c => c?.candidate_employee_id), cid))
        || candidates.some(c => c?.candidate_employee_id == null))
      return notInCompany(res, 'candidate');
    if (await anyTestEmployee(pool, candidates.map(c => c?.candidate_employee_id)))
      return res.status(400).json({ message: 'A test employee cannot be added as a candidate', code: 'TEST_EMPLOYEE' });
    // Readiness is no longer part of a candidacy: it is the 9-box rating. A
    // readiness_level in the body is ignored.
    for (const c of candidates) {
      const bad = vocabProblem({ successor_type: [c.successor_type, SUCCESSOR_TYPES] });
      if (bad) return res.status(400).json(bad);
      if (c.rank != null && !(Number.isInteger(Number(c.rank)) && Number(c.rank) >= 1 && Number(c.rank) <= 99))
        return res.status(400).json({ message: 'rank must be a whole number from 1 to 99', field: 'rank' });
      if (c.development_actions != null && !(Array.isArray(c.development_actions) && c.development_actions.every(a => typeof a === 'string' && a.length <= 500)))
        return res.status(400).json({ message: 'development_actions must be a list of short texts', field: 'development_actions' });
    }
    const ids = candidates.map(c => Number(c.candidate_employee_id));
    if (new Set(ids).size !== ids.length)
      return res.status(400).json({ message: 'Each candidate can appear only once', code: 'DUPLICATE_CANDIDATE' });
    // Someone who has left may stay on the slate (they are shown, not counted,
    // until HR removes them), but cannot be added.
    const { rows: stored } = await pool.query(
      `SELECT candidate_employee_id FROM succession_plans WHERE critical_role_id = $1 AND company_id = $2`, [req.params.id, cid]);
    const already = new Set(stored.map(r => Number(r.candidate_employee_id)));
    if ((await leftEmployees(pool, ids.filter(id => !already.has(id)))).length) return leftEmployee(res);
  } catch (err) { return res.status(500).json({ message: err.message }); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The whole slate is replaced, so the before-image is the whole slate —
    // captureBefore() keyed this route's role id against succession_plans.id
    // and recorded an unrelated plan row.
    const { rows: before } = await client.query(
      `SELECT * FROM succession_plans WHERE critical_role_id = $1 AND company_id = $2 ORDER BY rank, id`,
      [req.params.id, cid]);
    req._auditBefore = { critical_role_id: Number(req.params.id), candidates: before };
    const { rows: [{ n: prevCount }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM succession_plans sp
        WHERE sp.critical_role_id = $1 AND sp.company_id = $2 AND ${counted('sp.candidate_employee_id')}`, [req.params.id, cid]);
    // The slate the screen sends no longer shows test employees, so their
    // stored candidacies are kept rather than replaced.
    await client.query(
      `DELETE FROM succession_plans WHERE critical_role_id=$1 AND company_id=$2 AND ${notTest('candidate_employee_id')}`,
      [req.params.id, cid]);
    for (const c of candidates) {
      await client.query(
        `INSERT INTO succession_plans
           (critical_role_id, candidate_employee_id, rank, readiness_level,
            development_actions, is_emergency_successor, successor_type, company_id)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7)`,
        [req.params.id, c.candidate_employee_id, c.rank ?? 1,
         JSON.stringify(c.development_actions || []),
         c.successor_type === 'emergency' || c.is_emergency_successor === true,
         c.successor_type ?? (c.is_emergency_successor ? 'emergency' : Number(c.rank) === 1 ? 'primary' : 'secondary'),
         cid]
      );
    }
    await client.query('COMMIT');
    // Check alerts
    await _checkAndCreateAlert(parseInt(req.params.id), cid, prevCount);
    res.json({ message: 'Candidates updated', count: candidates.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

/* ─── Internal helper: create succession alerts ──────────────────────────── */
/* The count is the COUNTED successors (not test, not left). One unread alert
   per role and kind: saving the same slate again used to add another
   "only ONE successor" alert every time. An unread zero/single alert that no
   longer describes the role is closed (marked read) when the slate changes. */
async function _checkAndCreateAlert(roleId, cid, prevCount = null) {
  try {
    const settingsRes = await pool.query(
      `SELECT zero_successor_alert, single_successor_alert FROM succession_settings
       WHERE company_id = $1`, [cid]
    );
    const settings = settingsRes.rows[0] || { zero_successor_alert: true, single_successor_alert: true };
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM succession_plans sp
        WHERE sp.critical_role_id = $1 AND sp.company_id = $2 AND ${counted('sp.candidate_employee_id')}`, [roleId, cid]);
    const want = n === 0 && settings.zero_successor_alert ? 'zero_successor'
               : n === 1 && settings.single_successor_alert ? 'single_successor' : null;
    await pool.query(
      `UPDATE succession_alerts SET is_read = TRUE
        WHERE role_id = $1 AND company_id = $2 AND NOT is_read
          AND alert_type IN ('zero_successor','single_successor') AND alert_type IS DISTINCT FROM $3::varchar`,
      [roleId, cid, want]);
    // Raised when the role ENTERS the state. Re-saving an unchanged slate used
    // to raise it again, including right after someone had marked it read.
    if (!want || (prevCount !== null && prevCount === n)) return;
    const message = want === 'zero_successor'
      ? `'Critical role "' || role_title || '" has NO successors defined.'`
      : `'Critical role "' || role_title || '" has only ONE successor — single point of failure.'`;
    await pool.query(
      `INSERT INTO succession_alerts (alert_type, role_id, message, severity, company_id)
       SELECT $3::varchar, $1, ${message}, $4::varchar, $2
         FROM critical_roles cr WHERE cr.id = $1 AND cr.company_id = $2
          AND NOT EXISTS (SELECT 1 FROM succession_alerts sa
                           WHERE sa.role_id = $1 AND sa.company_id = $2 AND sa.alert_type = $3::varchar AND NOT sa.is_read)`,
      [roleId, cid, want, want === 'zero_successor' ? 'critical' : 'warning']);
  } catch (err) {
    console.error('[succession] alert check failed:', err.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   LEADERSHIP PIPELINE
═══════════════════════════════════════════════════════════════════════════ */

router.get('/pipeline/levels', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    // ?all=1 includes inactive levels (the level manager); the pipeline shows active ones.
    const all = req.query.all === '1';
    const { rows } = await pool.query(
      `SELECT l.*, l.company_id IS NULL AS is_shared,
              (SELECT COUNT(*) FROM leadership_pipeline_entries lpe
                WHERE lpe.company_id = $1 AND lpe.status = 'active'
                  AND (lpe.current_level_id = l.id OR lpe.target_level_id = l.id))::int AS entry_count
       FROM leadership_pipeline_levels l
       WHERE (l.company_id = $1 OR l.company_id IS NULL)${all ? '' : ' AND l.is_active = TRUE'}
       ORDER BY l.level_order, l.id`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

function levelProblem(b, creating) {
  if (creating && (!b.level_name || !String(b.level_name).trim())) return { message: 'level_name required', field: 'level_name' };
  return textProblem({ level_name: b.level_name }, 100)
    || textProblem({ description: b.description }, 1000)
    || (b.level_order != null && !(Number.isInteger(Number(b.level_order)) && Number(b.level_order) >= 1 && Number(b.level_order) <= 99)
        ? { message: 'level_order must be a whole number from 1 to 99', field: 'level_order' } : null)
    || (b.required_experience_yrs != null && b.required_experience_yrs !== '' && !(Number.isInteger(Number(b.required_experience_yrs)) && Number(b.required_experience_yrs) >= 0 && Number(b.required_experience_yrs) <= 60)
        ? { message: 'required_experience_yrs must be a whole number from 0 to 60', field: 'required_experience_yrs' } : null)
    || (b.is_active != null && typeof b.is_active !== 'boolean' ? { message: 'is_active must be true or false', field: 'is_active' } : null);
}

router.post('/pipeline/levels', requireHRWrite, async (req, res) => {
  const { level_name, level_order, description, required_experience_yrs, required_competencies } = req.body;
  const bad = levelProblem(req.body, true);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO leadership_pipeline_levels
         (level_name, level_order, description, required_experience_yrs, required_competencies, company_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [level_name, level_order || 0, description || null,
       required_experience_yrs || 0,
       JSON.stringify(required_competencies || []), cid]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/pipeline/levels/:id', requireHRWrite, captureBefore('leadership_pipeline_levels'), async (req, res) => {
  const bad = levelProblem(req.body, false);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    const params = [req.params.id, cid];
    const sets = patchSet(req.body, {
      level_name: { required: true }, level_order: { required: true }, description: {},
      required_experience_yrs: { required: true }, is_active: { required: true },
    }, params);
    if (!sets.length) return res.status(400).json({ message: 'Nothing to change' });
    const { rows } = await pool.query(
      `UPDATE leadership_pipeline_levels SET ${sets.join(', ')}
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Level not found (shared default levels cannot be edited)' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// A level that an active pipeline entry still uses cannot be deleted; it can be
// deactivated (PATCH is_active=false) or the entries moved first.
router.delete('/pipeline/levels/:id', requireHRWrite, captureBefore('leadership_pipeline_levels'), async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows: [use] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM leadership_pipeline_entries
        WHERE company_id = $2 AND (current_level_id = $1 OR target_level_id = $1)`, [req.params.id, cid]);
    if (use.n > 0)
      return res.status(409).json({ message: `${use.n} pipeline entr${use.n === 1 ? 'y uses' : 'ies use'} this level. Move them or deactivate the level instead.`, code: 'LEVEL_IN_USE' });
    const { rowCount } = await pool.query(`DELETE FROM leadership_pipeline_levels WHERE id = $1 AND company_id = $2`, [req.params.id, cid]);
    if (!rowCount) return res.status(404).json({ message: 'Level not found (shared default levels cannot be deleted)' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/pipeline/entries', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT lpe.id, lpe.employee_id, lpe.current_level_id, lpe.target_level_id, lpe.current_since,
              lpe.target_date, lpe.status, lpe.notes, lpe.company_id, lpe.created_at, lpe.updated_at,
              e.name AS employee_name, e.department, e.designation, ${phaseOf('e')} AS employment_phase,
              cl.level_name AS current_level_name, cl.level_order AS current_level_order,
              tl.level_name AS target_level_name,  tl.level_order AS target_level_order,
              ta.performance_score, ta.potential_score, ta.flight_risk,
              ${readinessClass('ta.readiness')} AS readiness, ta.readiness IS NOT NULL AS is_rated
       FROM leadership_pipeline_entries lpe
       JOIN employees e ON e.id = lpe.employee_id
       LEFT JOIN leadership_pipeline_levels cl ON cl.id = lpe.current_level_id
       LEFT JOIN leadership_pipeline_levels tl ON tl.id = lpe.target_level_id
       LEFT JOIN talent_assessments ta ON ta.employee_id = lpe.employee_id AND ta.company_id = lpe.company_id
       WHERE lpe.company_id = $1 AND lpe.status = 'active' AND NOT e.is_test
       ORDER BY cl.level_order, e.name`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/pipeline/entries', requireHRWrite, async (req, res) => {
  const {
    employee_id, current_level_id, target_level_id,
    current_since, target_date, notes,
  } = req.body;
  if (!employee_id || !current_level_id)
    return res.status(400).json({ message: 'employee_id and current_level_id required' });
  // Readiness is the employee's 9-box rating; a `readiness` in the body is ignored.
  const bad = dateProblem({ current_since, target_date }) || textProblem({ notes }, 2000);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    if (!(await employeesInCompany(pool, [employee_id], cid))) return notInCompany(res);
    if (await anyTestEmployee(pool, [employee_id])) return testEmployee(res);
    if ((await leftEmployees(pool, [employee_id])).length) return leftEmployee(res);
    if (!(await levelsUsable(pool, [current_level_id, target_level_id], cid))) return notInCompany(res, 'pipeline level');
    // An employee is in the pipeline once. Adding them again used to overwrite
    // their entry silently; now it says so and the screen offers Edit.
    const { rows: [dup] } = await pool.query(
      `SELECT id, status FROM leadership_pipeline_entries WHERE employee_id = $1 AND company_id = $2`, [employee_id, cid]);
    if (dup && dup.status === 'active')
      return res.status(409).json({ message: 'This employee is already in the pipeline. Edit their entry instead.', code: 'ALREADY_IN_PIPELINE', id: dup.id });
    const { rows } = await pool.query(
      `INSERT INTO leadership_pipeline_entries
         (employee_id, current_level_id, target_level_id, current_since,
          target_date, readiness, notes, company_id, created_by)
       VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,NULL,$6,$7,$8)
       ON CONFLICT (employee_id, company_id) DO UPDATE SET
         current_level_id = $2, target_level_id = $3,
         current_since = COALESCE($4::date, CURRENT_DATE),
         target_date = $5, notes = $6, status = 'active', updated_at = NOW()
       RETURNING *`,
      [employee_id, current_level_id, target_level_id || null,
       current_since || null, target_date || null,
       notes || null, cid, await employeeOf(req, pool)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/pipeline/entries/:id', requireHRWrite, captureBefore('leadership_pipeline_entries'), async (req, res) => {
  const { current_level_id, target_level_id, target_date, current_since, notes, status } = req.body;
  const bad = vocabProblem({ status: [status, ENTRY_STATUS] })
    || dateProblem({ current_since, target_date }) || textProblem({ notes }, 2000);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    if (!(await levelsUsable(pool, [current_level_id, target_level_id], cid))) return notInCompany(res, 'pipeline level');
    // readiness is not editable here: it is the 9-box rating.
    const params = [req.params.id, cid];
    const sets = patchSet(req.body, {
      current_level_id: { required: true }, target_level_id: {}, target_date: { cast: 'date' },
      current_since: { cast: 'date', required: true }, notes: {}, status: { required: true },
    }, params);
    const { rows } = await pool.query(
      `UPDATE leadership_pipeline_entries SET ${[...sets, 'updated_at = NOW()'].join(', ')}
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Entry not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/pipeline/entries/:id', requireHRWrite, captureBefore('leadership_pipeline_entries'), async (req, res) => {
  const cid = getCid(req);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM leadership_pipeline_entries WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    if (!rowCount) return res.status(404).json({ message: 'Entry not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   DEVELOPMENT PLANS
═══════════════════════════════════════════════════════════════════════════ */

router.get('/development-plans', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const { employee_id, status } = req.query;
  try {
    const params = [cid];
    let where = `dp.company_id = $1 AND NOT e.is_test`;
    if (employee_id) { params.push(employee_id); where += ` AND dp.employee_id = $${params.length}`; }
    if (status)      { params.push(status);      where += ` AND dp.status = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT dp.*,
              e.name AS employee_name, e.department, e.designation, succession_employment_phase(e.status, e.deleted_at) AS employment_phase,
              cr.role_title AS target_role,
              (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id = dp.id)::int AS action_count,
              (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id = dp.id AND da.status='completed')::int AS completed_count,
              (SELECT COUNT(*) FROM mentoring_assignments ma WHERE ma.development_plan_id = dp.id AND ma.status='active')::int AS mentor_count
       FROM development_plans dp
       JOIN employees e ON e.id = dp.employee_id
       LEFT JOIN critical_roles cr ON cr.id = dp.critical_role_id
       WHERE ${where}
       ORDER BY dp.updated_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/development-plans/:id', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const [planRes, actionsRes, mentorsRes] = await Promise.all([
      pool.query(
        `SELECT dp.*, e.name AS employee_name, e.department, e.designation,
                succession_employment_phase(e.status, e.deleted_at) AS employment_phase,
                cr.role_title AS target_role, c.name AS created_by_name,
                (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id = dp.id)::int AS action_count,
                (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id = dp.id AND da.status='completed')::int AS completed_count
         FROM development_plans dp
         JOIN employees e ON e.id = dp.employee_id
         LEFT JOIN critical_roles cr ON cr.id = dp.critical_role_id
         LEFT JOIN employees c ON c.id = dp.created_by
         WHERE dp.id = $1 AND dp.company_id = $2`,
        [req.params.id, cid]
      ),
      pool.query(
        `SELECT da.*, e.name AS owner_name,
                CASE WHEN e.id IS NULL THEN NULL ELSE succession_employment_phase(e.status, e.deleted_at) END AS owner_phase,
                tp.title AS training_title, tp.scheduled_date::text AS training_date, tp.status AS training_status,
                (SELECT te.status FROM training_enrollments te JOIN training_programs r ON r.id = te.program_id
                   JOIN development_plans p2 ON p2.id = da.plan_id
                  WHERE te.employee_id = p2.employee_id AND COALESCE(r.series_id, r.id) = COALESCE(tp.series_id, tp.id)
                  ORDER BY (te.status = 'completed') DESC, r.scheduled_date DESC LIMIT 1) AS training_enrolment_status
         FROM development_actions da
         LEFT JOIN employees e ON e.id = da.owner_employee_id
         LEFT JOIN training_programs tp ON tp.id = da.linked_training_id AND tp.deleted_at IS NULL
         WHERE da.plan_id = $1
         ORDER BY da.action_order, da.created_at`,
        [req.params.id]
      ),
      pool.query(
        `SELECT ma.*, e.name AS mentor_name, e.designation AS mentor_designation,
                succession_employment_phase(e.status, e.deleted_at) AS mentor_phase
         FROM mentoring_assignments ma
         JOIN employees e ON e.id = ma.mentor_employee_id
         WHERE ma.development_plan_id = $1 AND ma.company_id = $2`,
        [req.params.id, cid]
      ),
    ]);
    if (!planRes.rows.length) return res.status(404).json({ message: 'Plan not found' });
    res.json({ ...planRes.rows[0], actions: actionsRes.rows, mentors: mentorsRes.rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/development-plans', requireHRWrite, async (req, res) => {
  const {
    employee_id, critical_role_id, plan_title, plan_type = 'succession',
    start_date, target_date, notes,
  } = req.body;
  if (!employee_id || !plan_title || !String(plan_title).trim())
    return res.status(400).json({ message: 'employee_id and plan_title required' });
  const bad = textProblem({ plan_title, plan_type }, 200) || textProblem({ notes }, 2000)
    || dateProblem({ start_date, target_date })
    || (start_date && target_date && target_date < start_date ? { message: 'target_date cannot be before start_date', field: 'target_date' } : null);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    if (!(await employeesInCompany(pool, [employee_id], cid))) return notInCompany(res);
    if (await anyTestEmployee(pool, [employee_id])) return testEmployee(res);
    if ((await leftEmployees(pool, [employee_id])).length) return leftEmployee(res);
    if (critical_role_id && !(await ownsRow(pool, 'critical_roles', critical_role_id, cid)))
      return notInCompany(res, 'critical role');
    const { rows } = await pool.query(
      `INSERT INTO development_plans
         (employee_id, critical_role_id, plan_title, plan_type,
          start_date, target_date, notes, company_id, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7,$8,$9) RETURNING *`,
      [employee_id, critical_role_id || null, plan_title, plan_type,
       start_date || null, target_date || null, notes || null, cid,
       await employeeOf(req, pool)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/development-plans/:id', requireHRWrite, captureBefore('development_plans'), async (req, res) => {
  const {
    plan_title, status, start_date, target_date, completion_date,
    overall_progress, notes, critical_role_id,
  } = req.body;
  const badStatus = vocabProblem({ status: [status, PLAN_STATUS] })
    || textProblem({ plan_title }, 200) || textProblem({ notes }, 2000)
    || dateProblem({ start_date, target_date, completion_date });
  if (badStatus) return res.status(400).json(badStatus);
  if (overall_progress != null && !(Number.isInteger(Number(overall_progress)) && overall_progress >= 0 && overall_progress <= 100))
    return res.status(400).json({ message: 'overall_progress must be a whole number from 0 to 100', field: 'overall_progress' });
  const cid = getCid(req);
  try {
    if (critical_role_id && !(await ownsRow(pool, 'critical_roles', critical_role_id, cid)))
      return notInCompany(res, 'critical role');
    // Editing one date alone is checked against the stored other one.
    if ('start_date' in req.body || 'target_date' in req.body) {
      const { rows: [cur] } = await pool.query(
        `SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(target_date, 'YYYY-MM-DD') AS t
           FROM development_plans WHERE id = $1 AND company_id = $2`, [req.params.id, cid]);
      if (!cur) return res.status(404).json({ message: 'Plan not found' });
      const s = 'start_date' in req.body ? (start_date || cur.s) : cur.s;
      const t = 'target_date' in req.body ? (target_date || null) : cur.t;
      if (s && t && t < s) return res.status(400).json({ message: 'target_date cannot be before start_date', field: 'target_date' });
    }
    const body = { ...req.body };
    // Completing stamps today unless a date is given; reopening clears it.
    // (CURRENT_DATE, not the JS date: the session runs in the business time zone.)
    const stampToday = status === 'completed' && !body.completion_date;
    if (stampToday) delete body.completion_date;
    if (status && status !== 'completed') body.completion_date = null;
    const params = [req.params.id, cid];
    const sets = patchSet(body, {
      plan_title: { required: true }, status: { required: true }, start_date: { cast: 'date', required: true },
      target_date: { cast: 'date' }, completion_date: { cast: 'date' }, overall_progress: { required: true },
      notes: {}, critical_role_id: {},
    }, params);
    if (stampToday) sets.push('completion_date = CURRENT_DATE');
    // §211: with actions, progress is completed ÷ all actions and is not typed
    // in. Checked in the same statement, so an action added concurrently
    // cannot slip past a separate pre-check.
    const progressGuard = overall_progress != null
      ? ' AND NOT EXISTS (SELECT 1 FROM development_actions da WHERE da.plan_id = $1)' : '';
    const { rows } = await pool.query(
      `UPDATE development_plans SET ${[...sets, 'updated_at = NOW()'].join(', ')}
       WHERE id = $1 AND company_id = $2${progressGuard}
       RETURNING *`,
      params
    );
    if (!rows.length) {
      if (overall_progress != null && (await ownsRow(pool, 'development_plans', req.params.id, cid))) {
        return res.status(409).json({
          message: 'This plan has actions, so its progress is calculated from completed actions and cannot be set by hand',
          code: 'PROGRESS_FROM_ACTIONS', field: 'overall_progress',
        });
      }
      return res.status(404).json({ message: 'Plan not found' });
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/development-plans/:id', requireHRWrite, captureBefore('development_plans'), async (req, res) => {
  const cid = getCid(req);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM development_plans WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    if (!rowCount) return res.status(404).json({ message: 'Plan not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Development Actions (within a plan) ─────────────────────────────────── */
// development_actions has no company_id; it belongs to a company through its
// plan. These routes keyed on the plan id alone, so any company could add,
// edit, complete or delete actions on another company's plan (and rewrite that
// plan's progress). Every action route now proves the plan is the caller's.
const planGate = async (req, res, next) => {
  try {
    if (!(await ownsRow(pool, 'development_plans', req.params.id, getCid(req))))
      return res.status(404).json({ message: 'Plan not found' });
    next();
  } catch (err) { res.status(500).json({ message: err.message }); }
};

/* A plan's overall_progress is the share of its actions that are completed
   (the rule the action PATCH already used). It was recalculated only on that
   PATCH, so adding an action to a finished plan left it at 100%, and deleting
   one left the old figure. Now every action change recalculates it. A plan
   with no actions reads 0, which is what the screens already showed for NULL. */
async function recalcPlanProgress(planId) {
  await pool.query(
    `UPDATE development_plans SET
       overall_progress = COALESCE((
         SELECT ROUND(COUNT(*) FILTER (WHERE status='completed') * 100.0 / NULLIF(COUNT(*),0))
           FROM development_actions WHERE plan_id = $1), 0),
       updated_at = NOW()
     WHERE id = $1`,
    [planId]
  );
}

router.post('/development-plans/:id/actions', requireHRWrite, planGate, async (req, res) => {
  const {
    action_type = 'task', title, description, due_date,
    owner_employee_id, linked_skill, action_order, linked_training_id,
  } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ message: 'title required', field: 'title' });
  const bad = vocabProblem({ action_type: [action_type, ACTION_TYPES] })
    || textProblem({ title, linked_skill }, 200) || textProblem({ description }, 2000) || dateProblem({ due_date });
  if (bad) return res.status(400).json(bad);
  try {
    if (!(await employeesInCompany(pool, [owner_employee_id], getCid(req)))) return notInCompany(res);
    if (await anyTestEmployee(pool, [owner_employee_id])) return testEmployee(res);
    if ((await leftEmployees(pool, [owner_employee_id])).length) return leftEmployee(res);
    const { rows } = await pool.query(
      `INSERT INTO development_actions
         (plan_id, action_type, title, description, due_date,
          owner_employee_id, linked_skill, action_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, action_type, title, description || null, due_date || null,
       owner_employee_id || null, linked_skill || null, action_order || 0]
    );
    // A training action can name a real training: the plan's employee is
    // enrolled, and completing it completes the action (Learning Center, 2026-11-18).
    let action = rows[0];
    if (linked_training_id) {
      try { action = await linkTrainingAction(pool, action, linked_training_id, getCid(req), req.user?.userId ?? req.user?.id ?? null); }
      catch (e) { await pool.query(`DELETE FROM development_actions WHERE id = $1`, [action.id]); return res.status(e.status || 500).json({ message: e.message }); }
    }
    await recalcPlanProgress(req.params.id);
    res.status(201).json(action);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/development-plans/:id/actions/:actionId', requireHRWrite, planGate, captureBefore('development_actions', { param: 'actionId' }), async (req, res) => {
  const { title, description, due_date, status, completion_date, action_type, owner_employee_id, linked_skill } = req.body;
  const badStatus = vocabProblem({ status: [status, ACTION_STATUS], action_type: [action_type, ACTION_TYPES] })
    || textProblem({ title, linked_skill }, 200) || textProblem({ description }, 2000)
    || dateProblem({ due_date, completion_date });
  if (badStatus) return res.status(400).json(badStatus);
  try {
    if (owner_employee_id) {
      const cid = getCid(req);
      if (!(await employeesInCompany(pool, [owner_employee_id], cid))) return notInCompany(res);
      if (await anyTestEmployee(pool, [owner_employee_id])) return testEmployee(res);
      const { rows: [cur] } = await pool.query(`SELECT owner_employee_id FROM development_actions WHERE id = $1`, [req.params.actionId]);
      if (Number(cur?.owner_employee_id) !== Number(owner_employee_id) && (await leftEmployees(pool, [owner_employee_id])).length)
        return leftEmployee(res);
    }
    const body = { ...req.body };
    const stampToday = status === 'completed' && !body.completion_date;
    if (stampToday) delete body.completion_date;
    if (status && status !== 'completed') body.completion_date = null;
    const params = [req.params.actionId, req.params.id];
    const sets = patchSet(body, {
      title: { required: true }, description: {}, due_date: { cast: 'date' }, status: { required: true },
      completion_date: { cast: 'date' }, action_type: { required: true }, owner_employee_id: {}, linked_skill: {},
    }, params);
    if (stampToday) sets.push('completion_date = CURRENT_DATE');
    const { rows } = await pool.query(
      `UPDATE development_actions SET ${[...sets, 'updated_at = NOW()'].join(', ')}
       WHERE id = $1 AND plan_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Action not found' });
    let action = rows[0];
    if (req.body.linked_training_id !== undefined) {
      if (req.body.linked_training_id) {
        try { action = await linkTrainingAction(pool, action, req.body.linked_training_id, getCid(req), req.user?.userId ?? req.user?.id ?? null); }
        catch (e) { return res.status(e.status || 500).json({ message: e.message }); }
      } else {
        action = (await pool.query(`UPDATE development_actions SET linked_training_id = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`, [action.id])).rows[0];
      }
    }

    await recalcPlanProgress(req.params.id);

    res.json(action);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/development-plans/:id/actions/:actionId', requireHRWrite, planGate, captureBefore('development_actions', { param: 'actionId' }), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM development_actions WHERE id=$1 AND plan_id=$2`,
      [req.params.actionId, req.params.id]
    );
    if (!rowCount) return res.status(404).json({ message: 'Action not found' });
    await recalcPlanProgress(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Mentoring Assignments ────────────────────────────────────────────────── */

router.get('/mentoring', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT ma.*,
              mentee.name AS mentee_name, mentee.department AS mentee_department,
              ${phaseOf('mentee')} AS mentee_phase,
              mentor.name AS mentor_name, mentor.designation AS mentor_designation,
              ${phaseOf('mentor')} AS mentor_phase,
              dp.plan_title,
              (SELECT MAX(ms.session_date) FROM mentoring_sessions ms WHERE ms.assignment_id = ma.id) AS last_session_date
       FROM mentoring_assignments ma
       JOIN employees mentee ON mentee.id = ma.mentee_employee_id
       JOIN employees mentor ON mentor.id = ma.mentor_employee_id
       LEFT JOIN development_plans dp ON dp.id = ma.development_plan_id
       WHERE ma.company_id = $1 AND NOT mentee.is_test AND NOT mentor.is_test
       ORDER BY CASE ma.status WHEN 'active' THEN 0 ELSE 1 END, ma.created_at DESC`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

function mentoringProblem(b) {
  return vocabProblem({ status: [b.status, MENTOR_STATUS] })
    || textProblem({ focus_area: b.focus_area }, 200) || textProblem({ notes: b.notes }, 2000)
    || dateProblem({ start_date: b.start_date, end_date: b.end_date, next_session_date: b.next_session_date })
    || (b.start_date && b.end_date && b.end_date < b.start_date ? { message: 'end_date cannot be before start_date', field: 'end_date' } : null);
}

router.post('/mentoring', requireHRWrite, async (req, res) => {
  const {
    mentee_employee_id, mentor_employee_id, development_plan_id,
    focus_area, start_date, end_date, notes,
  } = req.body;
  if (!mentee_employee_id || !mentor_employee_id)
    return res.status(400).json({ message: 'mentee_employee_id and mentor_employee_id required' });
  if (Number(mentee_employee_id) === Number(mentor_employee_id))
    return res.status(400).json({ message: 'An employee cannot mentor themselves', code: 'SELF_MENTORING' });
  const bad = mentoringProblem(req.body);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    if (!(await employeesInCompany(pool, [mentee_employee_id, mentor_employee_id], cid))) return notInCompany(res);
    if (await anyTestEmployee(pool, [mentee_employee_id, mentor_employee_id])) return testEmployee(res);
    if ((await leftEmployees(pool, [mentee_employee_id, mentor_employee_id])).length) return leftEmployee(res);
    if (development_plan_id && !(await ownsRow(pool, 'development_plans', development_plan_id, cid)))
      return notInCompany(res, 'development plan');
    const { rows: [dup] } = await pool.query(
      `SELECT id FROM mentoring_assignments
        WHERE company_id = $1 AND mentee_employee_id = $2 AND mentor_employee_id = $3 AND status = 'active'
          AND development_plan_id IS NOT DISTINCT FROM $4::int`,
      [cid, mentee_employee_id, mentor_employee_id, development_plan_id || null]);
    if (dup) return res.status(409).json({ message: 'This mentor is already assigned to this mentee', code: 'DUPLICATE_MENTORING', id: dup.id });
    const { rows } = await pool.query(
      `INSERT INTO mentoring_assignments
         (mentee_employee_id, mentor_employee_id, development_plan_id,
          focus_area, start_date, end_date, notes, company_id)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7,$8) RETURNING *`,
      [mentee_employee_id, mentor_employee_id, development_plan_id || null,
       focus_area || null, start_date || null, end_date || null, notes || null, cid]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// session_count and next_session_date follow the logged sessions (below);
// they are not typed in.
router.patch('/mentoring/:id', requireHRWrite, captureBefore('mentoring_assignments'), async (req, res) => {
  const bad = mentoringProblem(req.body);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    if ('start_date' in req.body || 'end_date' in req.body) {
      const { rows: [cur] } = await pool.query(
        `SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e
           FROM mentoring_assignments WHERE id = $1 AND company_id = $2`, [req.params.id, cid]);
      if (!cur) return res.status(404).json({ message: 'Assignment not found' });
      const s = 'start_date' in req.body ? (req.body.start_date || cur.s) : cur.s;
      const e = 'end_date' in req.body ? (req.body.end_date || null) : cur.e;
      if (s && e && e < s) return res.status(400).json({ message: 'end_date cannot be before start_date', field: 'end_date' });
    }
    const body = { ...req.body };
    const params = [req.params.id, cid];
    const sets = patchSet(body, {
      status: { required: true }, focus_area: {}, start_date: { cast: 'date', required: true },
      end_date: { cast: 'date' }, notes: {}, next_session_date: { cast: 'date' },
    }, params);
    // Completing or cancelling with no end date stamps today.
    if (req.body.status && req.body.status !== 'active' && !('end_date' in req.body))
      sets.push('end_date = COALESCE(end_date, CURRENT_DATE)');
    if (!sets.length) return res.status(400).json({ message: 'Nothing to change' });
    const { rows } = await pool.query(
      `UPDATE mentoring_assignments SET ${[...sets, 'updated_at = NOW()'].join(', ')}
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Assignment not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/mentoring/:id', requireHRWrite, captureBefore('mentoring_assignments'), async (req, res) => {
  const cid = getCid(req);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM mentoring_assignments WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    if (!rowCount) return res.status(404).json({ message: 'Assignment not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ── Mentoring sessions (2026-11-12) ─────────────────────────────────────────
   The Sessions column always read 0: nothing could record a session. Each
   session is a row; the assignment's session_count and next_session_date are
   recalculated from them on every change. */
const mentoringGate = async (req, res, next) => {
  try {
    if (!(await ownsRow(pool, 'mentoring_assignments', req.params.id, getCid(req))))
      return res.status(404).json({ message: 'Assignment not found' });
    next();
  } catch (err) { res.status(500).json({ message: err.message }); }
};
async function recalcSessions(db, assignmentId) {
  await db.query(
    `UPDATE mentoring_assignments ma SET
       session_count = (SELECT COUNT(*) FROM mentoring_sessions ms WHERE ms.assignment_id = ma.id),
       next_session_date = (SELECT ms.next_session_date FROM mentoring_sessions ms
                             WHERE ms.assignment_id = ma.id ORDER BY ms.session_date DESC, ms.id DESC LIMIT 1),
       updated_at = NOW()
     WHERE ma.id = $1`, [assignmentId]);
}

router.get('/mentoring/:id/sessions', requireHRRead, mentoringGate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ms.*, u.name AS created_by_name FROM mentoring_sessions ms
         LEFT JOIN users u ON u.id = ms.created_by_user_id
        WHERE ms.assignment_id = $1 ORDER BY ms.session_date DESC, ms.id DESC`, [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/mentoring/:id/sessions', requireHRWrite, mentoringGate, async (req, res) => {
  const { session_date, duration_minutes, topic, notes, next_session_date } = req.body;
  if (!session_date) return res.status(400).json({ message: 'session_date required', field: 'session_date' });
  const bad = dateProblem({ session_date, next_session_date })
    || textProblem({ topic }, 200) || textProblem({ notes }, 4000)
    || (duration_minutes != null && duration_minutes !== '' && !(Number.isInteger(Number(duration_minutes)) && Number(duration_minutes) >= 1 && Number(duration_minutes) <= 1440)
        ? { message: 'duration_minutes must be a whole number from 1 to 1440', field: 'duration_minutes' } : null)
    || (next_session_date && next_session_date < session_date ? { message: 'next_session_date cannot be before session_date', field: 'next_session_date' } : null);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [a] } = await client.query(
      `SELECT status FROM mentoring_assignments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [req.params.id, cid]);
    if (a.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: `This assignment is ${a.status}; sessions can only be logged while it is active`, code: 'ASSIGNMENT_CLOSED' });
    }
    const { rows } = await client.query(
      `INSERT INTO mentoring_sessions (assignment_id, session_date, duration_minutes, topic, notes, next_session_date, company_id, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.params.id, session_date, duration_minutes || null, topic || null, notes || null,
       next_session_date || null, cid, req.user?.userId ?? null]);
    await recalcSessions(client, req.params.id);
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

router.delete('/mentoring/:id/sessions/:sessionId', requireHRWrite, mentoringGate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM mentoring_sessions WHERE id = $1 AND assignment_id = $2 RETURNING *`, [req.params.sessionId, req.params.id]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Session not found' }); }
    req._auditBefore = rows[0];
    await recalcSessions(client, req.params.id);
    await client.query('COMMIT');
    res.json({ message: 'Deleted' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ message: err.message });
  } finally { client.release(); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   EMPLOYEE TALENT POOLS (succession-side, employee-based)
═══════════════════════════════════════════════════════════════════════════ */

router.get('/pools', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT etp.*,
              COUNT(DISTINCT epm.employee_id)::int AS member_count,
              creator.name AS created_by_name
       FROM employee_talent_pools etp
       LEFT JOIN employee_pool_members epm ON epm.pool_id = etp.id AND ${counted('epm.employee_id')}
       LEFT JOIN employees creator ON creator.id = etp.created_by
       WHERE etp.company_id = $1
       GROUP BY etp.id, creator.name
       ORDER BY etp.pool_type, etp.pool_name`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/pools', requireHRWrite, async (req, res) => {
  const { pool_name, pool_type = 'General', description, department } = req.body;
  if (!pool_name || !String(pool_name).trim()) return res.status(400).json({ message: 'pool_name required', field: 'pool_name' });
  const bad = (await poolTypeProblem(req, pool_type))
    || textProblem({ pool_name, department }, 200) || textProblem({ description }, 2000);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `INSERT INTO employee_talent_pools
         (pool_name, pool_type, description, department, company_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [pool_name, pool_type, description || null, department || null, cid,
       await employeeOf(req, pool)]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/pools/:id', requireHRWrite, captureBefore('employee_talent_pools'), async (req, res) => {
  const { pool_name, pool_type, description, department, is_active } = req.body;
  const bad = (await poolTypeProblem(req, pool_type))
    || textProblem({ pool_name, department }, 200) || textProblem({ description }, 2000)
    || (is_active != null && typeof is_active !== 'boolean' ? { message: 'is_active must be true or false', field: 'is_active' } : null);
  if (bad) return res.status(400).json(bad);
  const cid = getCid(req);
  try {
    const params = [req.params.id, cid];
    const sets = patchSet(req.body, {
      pool_name: { required: true }, pool_type: { required: true }, description: {}, department: {}, is_active: { required: true },
    }, params);
    const { rows } = await pool.query(
      `UPDATE employee_talent_pools SET ${[...sets, 'updated_at = NOW()'].join(', ')}
       WHERE id = $1 AND company_id = $2 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ message: 'Pool not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// employee_pool_members has no company_id; it belongs to a company through its
// pool. The member routes keyed on the pool id alone, and DELETE /pools/:id
// emptied the membership BEFORE its company-scoped delete of the pool — so a
// foreign pool id lost all its members while its pool row survived.
const poolGate = async (req, res, next) => {
  try {
    if (!(await ownsRow(pool, 'employee_talent_pools', req.params.id, getCid(req))))
      return res.status(404).json({ message: 'Pool not found' });
    next();
  } catch (err) { res.status(500).json({ message: err.message }); }
};

router.delete('/pools/:id', requireHRWrite, poolGate, async (req, res) => {
  const cid = getCid(req);
  try {
    // Two tables, so captureBefore() cannot do this: it reads one. Deleting a
    // talent pool destroys the pool AND its membership, and the membership is
    // the part nobody can reconstruct — "who was in the high-potential pool
    // before it was deleted" has no other record.
    try {
      const [poolRow, members] = await Promise.all([
        pool.query(`SELECT * FROM employee_talent_pools WHERE id=$1 AND company_id=$2`, [req.params.id, cid]),
        pool.query(`SELECT * FROM employee_pool_members WHERE pool_id=$1 ORDER BY employee_id`, [req.params.id]),
      ]);
      if (poolRow.rows[0]) req._auditBefore = { ...poolRow.rows[0], members: members.rows };
    } catch { /* no before-image is a worse audit entry; a 500 is a worse product */ }

    // Members go with the pool (FK ON DELETE CASCADE), in one statement.
    await pool.query(
      `DELETE FROM employee_talent_pools WHERE id=$1 AND company_id=$2`,
      [req.params.id, cid]
    );
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/pools/:id/members', requireHRRead, poolGate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT epm.*, e.name, e.department, e.designation, e.office_id, ${phaseOf('e')} AS employment_phase,
              ta.performance_score, ta.potential_score, ta.flight_risk, ta.readiness,
              ta.talent_classification, ta.leadership_score
       FROM employee_pool_members epm
       JOIN employees e ON e.id = epm.employee_id
       LEFT JOIN talent_assessments ta ON ta.employee_id = epm.employee_id AND ta.company_id = $2
       WHERE epm.pool_id = $1 AND NOT e.is_test
       ORDER BY epm.added_date DESC`,
      [req.params.id, getCid(req)]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/pools/:id/members', requireHRWrite, poolGate, async (req, res) => {
  const { employee_id, notes } = req.body;
  if (!employee_id) return res.status(400).json({ message: 'employee_id required' });
  try {
    if (!(await employeesInCompany(pool, [employee_id], getCid(req)))) return notInCompany(res);
    if (await anyTestEmployee(pool, [employee_id])) return testEmployee(res);
    if ((await leftEmployees(pool, [employee_id])).length) return leftEmployee(res);
    const badNotes = textProblem({ notes }, 1000);
    if (badNotes) return res.status(400).json(badNotes);
    // added_by is read as an employee, like the other "by" columns.
    const { rowCount } = await pool.query(
      `INSERT INTO employee_pool_members (pool_id, employee_id, notes, added_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT (pool_id, employee_id) DO NOTHING`,
      [req.params.id, employee_id, notes || null, await employeeOf(req, pool)]
    );
    if (!rowCount) return res.status(409).json({ message: 'This employee is already in the pool', code: 'ALREADY_MEMBER' });
    res.status(201).json({ message: 'Member added' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete('/pools/:id/members/:employeeId', requireHRWrite, poolGate, async (req, res) => {
  try {
    // One table, but a COMPOSITE key. captureBefore() keys on a single column,
    // so pointing it at :id would have snapshotted an arbitrary one of the
    // pool's members — the wrong row, which is worse than no row.
    try {
      const { rows } = await pool.query(
        `SELECT * FROM employee_pool_members WHERE pool_id=$1 AND employee_id=$2`,
        [req.params.id, req.params.employeeId]
      );
      if (rows[0]) req._auditBefore = rows[0];
    } catch { /* as above */ }

    const { rowCount } = await pool.query(
      `DELETE FROM employee_pool_members WHERE pool_id=$1 AND employee_id=$2`,
      [req.params.id, req.params.employeeId]
    );
    if (!rowCount) return res.status(404).json({ message: 'Member not found' });
    res.json({ message: 'Member removed' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SUCCESSION SETTINGS
═══════════════════════════════════════════════════════════════════════════ */

const SETTINGS_DEFAULTS = {
  zero_successor_alert: true, single_successor_alert: true,
  flight_risk_threshold: 'high', review_frequency: 'quarterly',
  notify_roles: [],
  hiPo_threshold_potential: 4, hiPo_threshold_performance: 3,
};

/* The HiPo columns were created unquoted, so PostgreSQL stores them as
   hipo_threshold_*. A saved row came back with those keys while the screen
   (and the no-row default above) use hiPo_threshold_*: the saved value never
   showed after a reload, and the next save of ANY setting wrote the screen's
   default (4 / 3) back over it. Both keys are returned in one shape. */
function settingsOut(row) {
  if (!row) return { ...SETTINGS_DEFAULTS };
  const { hipo_threshold_potential, hipo_threshold_performance, ...rest } = row;
  return { ...rest,
    hiPo_threshold_potential:   hipo_threshold_potential   ?? SETTINGS_DEFAULTS.hiPo_threshold_potential,
    hiPo_threshold_performance: hipo_threshold_performance ?? SETTINGS_DEFAULTS.hiPo_threshold_performance };
}
async function loadSettings(cid) {
  const { rows } = await pool.query(`SELECT * FROM succession_settings WHERE company_id=$1`, [cid]);
  return settingsOut(rows[0]);
}

router.get('/settings', requireHRRead, async (req, res) => {
  try {
    res.json(await loadSettings(getCid(req)));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* Who can be notified: roles that can open Succession, with how many active
   users of this company hold each. Settings → Notification Recipients offers
   exactly these. */
router.get('/settings/recipient-roles', requireHRRead, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `WITH eligible AS (
         SELECT LOWER(r.code) AS code, MIN(COALESCE(NULLIF(r.label, ''), r.role_name, r.code)) AS label
           FROM roles r
          WHERE EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.module = 'succession' AND rp.can_view)
          GROUP BY LOWER(r.code))
       SELECT el.code, el.label,
              (SELECT COUNT(DISTINCT u.id) FROM users u
                 JOIN user_roles ur ON ur.user_id = u.id
                 JOIN roles r2 ON r2.id = ur.role_id AND LOWER(r2.code) = el.code
                WHERE u.is_active
                  AND (u.company_id = $1 OR EXISTS (SELECT 1 FROM user_scope us WHERE us.user_id = u.id AND us.company_id = $1)))::int AS user_count
         FROM eligible el
        ORDER BY 1`, [getCid(req)]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put('/settings', requireHRWrite, async (req, res) => {
  const {
    zero_successor_alert, single_successor_alert, flight_risk_threshold,
    review_frequency, notify_roles, hiPo_threshold_potential, hiPo_threshold_performance,
  } = req.body;
  const cid = getCid(req);
  for (const [k, v] of [['zero_successor_alert', zero_successor_alert], ['single_successor_alert', single_successor_alert]]) {
    if (v != null && typeof v !== 'boolean') return res.status(400).json({ message: `${k} must be true or false`, field: k });
  }
  const bad = vocabProblem({ flight_risk_threshold: [flight_risk_threshold, RISK], review_frequency: [review_frequency, FREQUENCIES] })
    || intScoreProblem({ hiPo_threshold_potential, hiPo_threshold_performance });
  if (bad) return res.status(400).json(bad);
  if (notify_roles != null && !(Array.isArray(notify_roles) && notify_roles.every(r => typeof r === 'string' && r.length <= 64)))
    return res.status(400).json({ message: 'notify_roles must be a list of role codes', field: 'notify_roles' });
  // notify_roles now decides who is notified (employees trigger), so every
  // code must be a real role that can open Succession.
  if (Array.isArray(notify_roles) && notify_roles.length) {
    const { rows } = await pool.query(
      `SELECT DISTINCT LOWER(r.code) AS code FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
        WHERE rp.module = 'succession' AND rp.can_view AND LOWER(r.code) = ANY($1::text[])`,
      [notify_roles.map(r => r.toLowerCase())]);
    const ok = new Set(rows.map(r => r.code));
    const badRole = notify_roles.find(r => !ok.has(r.toLowerCase()));
    if (badRole) return res.status(400).json({ message: `"${badRole}" is not a role that can open Succession`, field: 'notify_roles', code: 'INVALID_VALUE' });
  }

  // A settings singleton has no :id, so captureBefore() has nothing to key on —
  // the company is the key. Settings changes are exactly what an audit trail is
  // asked about later ("who raised the flight-risk threshold, and from what").
  try {
    const { rows: prior } = await pool.query(
      `SELECT * FROM succession_settings WHERE company_id=$1`, [cid]);
    req._auditBefore = prior[0] ?? null;
  } catch { /* no before-image is a worse audit entry; a 500 is a worse product */ }

  try {
    const { rows } = await pool.query(
      `INSERT INTO succession_settings
         (company_id, zero_successor_alert, single_successor_alert, flight_risk_threshold,
          review_frequency, notify_roles, hiPo_threshold_potential, hiPo_threshold_performance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id) DO UPDATE SET
         zero_successor_alert        = $2,
         single_successor_alert      = $3,
         flight_risk_threshold       = $4,
         review_frequency            = $5,
         notify_roles                = $6,
         hiPo_threshold_potential    = $7,
         hiPo_threshold_performance  = $8,
         updated_at                  = NOW()
       RETURNING *`,
      [cid,
       zero_successor_alert ?? true, single_successor_alert ?? true,
       flight_risk_threshold || 'high', review_frequency || 'quarterly',
       JSON.stringify((notify_roles ?? (req._auditBefore?.notify_roles || [])).map(r => r.toLowerCase())),
       hiPo_threshold_potential ?? 4, hiPo_threshold_performance ?? 3]
    );
    res.json(settingsOut(rows[0]));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ─── Alerts ──────────────────────────────────────────────────────────────── */

router.get('/alerts', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  try {
    const { rows } = await pool.query(
      `SELECT sa.*, cr.role_title, cr.department, cr.risk_level, e.name AS employee_name
       FROM succession_alerts sa
       LEFT JOIN critical_roles cr ON cr.id = sa.role_id
       LEFT JOIN employees e ON e.id = sa.employee_id
       WHERE sa.company_id = $1${req.query.unread === '1' ? ' AND NOT sa.is_read' : ''}
       ORDER BY sa.is_read, sa.created_at DESC
       LIMIT 100`,
      [cid]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/alerts/read-all', requireHRRead, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE succession_alerts SET is_read = TRUE WHERE company_id = $1 AND NOT is_read`, [getCid(req)]);
    res.json({ message: 'Marked read', count: rowCount });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch('/alerts/:id/read', requireHRRead, captureBefore('succession_alerts'), async (req, res) => {
  try {
    // Keyed on the id alone, this marked any company's alert as read.
    const { rowCount } = await pool.query(
      `UPDATE succession_alerts SET is_read=TRUE WHERE id=$1 AND company_id=$2`, [req.params.id, getCid(req)]
    );
    if (!rowCount) return res.status(404).json({ message: 'Alert not found' });
    res.json({ message: 'Marked read' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   DASHBOARD (enhanced)
═══════════════════════════════════════════════════════════════════════════ */

router.get('/dashboard', requireHRRead, async (req, res) => {
  const cid = getCid(req);
  const bench_p = [];  const bench_w  = cidClause(cid, bench_p, 'cr');
  const flight_p = []; const flight_w = cidClause(cid, flight_p, 'ta');
  const ready_p = [];  const ready_w  = cidClause(cid, ready_p, 'sp');
  const top_p = [];    const top_w    = cidClause(cid, top_p, 'ta');
  const pool_p = [];   const pool_w   = cidClause(cid, pool_p, 'lpe');
  const alert_p = [];  const alert_w  = cidClause(cid, alert_p);

  try {
    // "High potential" is what Settings says it is (§210): potential AND
    // performance at or above the saved thresholds. This list used a fixed
    // potential >= 4 and ignored both settings.
    const settings = await loadSettings(cid);
    top_p.push(settings.hiPo_threshold_potential, settings.hiPo_threshold_performance);
    const hipo_w = ` AND ta.potential_score >= $${top_p.length - 1} AND ta.performance_score >= $${top_p.length}`;
    const [benchRes, flightRes, readyRes, topRes, pipeRes, alertRes, zeroRes, devRes] =
      await Promise.allSettled([
        pool.query(
          `SELECT
             COUNT(*)::int AS total_critical_roles,
             COUNT(CASE WHEN EXISTS(
               SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${readyCol('sp.candidate_employee_id', 'sp.company_id')}='ready-now' AND ${counted('sp.candidate_employee_id')}
             ) THEN 1 END)::int AS ready_now_count,
             COUNT(CASE WHEN NOT EXISTS(
               SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${counted('sp.candidate_employee_id')}
             ) THEN 1 END)::int AS zero_successor_count,
             ROUND(100.0 * COUNT(CASE WHEN EXISTS(
               SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${readyCol('sp.candidate_employee_id', 'sp.company_id')}='ready-now' AND ${counted('sp.candidate_employee_id')}
             ) THEN 1 END) / NULLIF(COUNT(*),0),0) AS bench_strength_pct
           FROM critical_roles cr WHERE 1=1${bench_w}`,
          bench_p
        ),
        pool.query(
          `SELECT flight_risk, COUNT(*)::int AS cnt
           FROM talent_assessments ta WHERE ${counted('ta.employee_id')}${flight_w} GROUP BY flight_risk`,
          flight_p
        ),
        pool.query(
          `SELECT ${readyCol('sp.candidate_employee_id', 'sp.company_id')} AS readiness, COUNT(*)::int AS cnt
           FROM succession_plans sp WHERE ${counted('sp.candidate_employee_id')}${ready_w} GROUP BY 1`,
          ready_p
        ),
        pool.query(
          `SELECT e.name, e.department, e.designation,
                  ta.performance_score, ta.potential_score, ta.flight_risk,
                  ta.readiness, ta.talent_classification, ta.leadership_score
           FROM talent_assessments ta
           JOIN employees e ON e.id = ta.employee_id
           WHERE NOT e.is_test AND ${phaseOf('e')} <> 'left'${top_w}${hipo_w}
           ORDER BY ta.potential_score DESC, ta.performance_score DESC LIMIT 10`,
          top_p
        ),
        pool.query(
          `SELECT cl.level_name, cl.level_order, COUNT(lpe.id)::int AS headcount
           FROM leadership_pipeline_entries lpe
           JOIN leadership_pipeline_levels cl ON cl.id = lpe.current_level_id
           WHERE lpe.status='active' AND ${counted('lpe.employee_id')}${pool_w}
           GROUP BY cl.level_name, cl.level_order
           ORDER BY cl.level_order`,
          pool_p
        ),
        pool.query(
          `SELECT COUNT(*)::int AS unread_alerts FROM succession_alerts
           WHERE is_read=FALSE${alert_w}`,
          alert_p
        ),
        pool.query(
          `SELECT cr.role_title, cr.department, cr.risk_level
           FROM critical_roles cr
           WHERE NOT EXISTS(SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${counted('sp.candidate_employee_id')})
             ${bench_w.replace('AND cr.company_id', 'AND cr.company_id')}
           ORDER BY CASE cr.risk_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
           LIMIT 10`,
          bench_p
        ),
        pool.query(
          `SELECT COUNT(*)::int AS active_plans,
                  ROUND(AVG(overall_progress))::int AS avg_progress
           FROM development_plans WHERE company_id=$1 AND status='active' AND ${counted('employee_id')}`,
          [cid]
        ),
      ]);
    // allSettled turned any failed query into a 0 on the dashboard — an
    // outage read as "no successors". One failure now fails the request.
    const failed = [benchRes, flightRes, readyRes, topRes, pipeRes, alertRes, zeroRes, devRes].find(r => r.status === 'rejected');
    if (failed) throw failed.reason;

    const flightMap = {};
    for (const r of (flightRes.value?.rows || [])) flightMap[r.flight_risk] = r.cnt;
    const benchRow  = benchRes.value?.rows[0] || {};

    res.json({
      bench_strength_pct:     parseInt(benchRow.bench_strength_pct || 0),
      total_critical_roles:   parseInt(benchRow.total_critical_roles || 0),
      ready_now_count:        parseInt(benchRow.ready_now_count || 0),
      zero_successor_count:   parseInt(benchRow.zero_successor_count || 0),
      flight_risk:            { low: flightMap.low || 0, medium: flightMap.medium || 0, high: flightMap.high || 0 },
      readiness_summary:      readyRes.value?.rows || [],
      top_high_potential:     topRes.value?.rows || [],
      pipeline_distribution:  pipeRes.value?.rows || [],
      unread_alerts:          parseInt(alertRes.value?.rows[0]?.unread_alerts || 0),
      zero_successor_roles:   zeroRes.value?.rows || [],
      development_summary:    devRes.value?.rows[0] || { active_plans: 0, avg_progress: 0 },
      hipo_thresholds:        { potential: settings.hiPo_threshold_potential, performance: settings.hiPo_threshold_performance },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   REPORTS — all with CSV export
═══════════════════════════════════════════════════════════════════════════ */

router.get('/reports/bench-strength', requireHRRead, exportGate, async (req, res) => {
  const cid    = getCid(req);
  const fmt    = req.query.format || 'json';
  const params = [cid];
  try {
    const { rows } = await pool.query(
      `SELECT cr.role_title, cr.department, cr.risk_level,
              cr.knowledge_domain, cr.expected_vacancy_date,
              e.name AS current_holder,
              CASE WHEN e.id IS NULL THEN NULL ELSE ${phaseOf('e')} END AS holder_phase,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${counted('sp.candidate_employee_id')})::int AS successor_count,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${readyCol('sp.candidate_employee_id', 'sp.company_id')}='ready-now' AND ${counted('sp.candidate_employee_id')})::int AS ready_now,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${readyCol('sp.candidate_employee_id', 'sp.company_id')}='1-2-years' AND ${counted('sp.candidate_employee_id')})::int AS ready_1_2yr,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${readyCol('sp.candidate_employee_id', 'sp.company_id')}='3-5-years' AND ${counted('sp.candidate_employee_id')})::int AS ready_3_5yr,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${readyCol('sp.candidate_employee_id', 'sp.company_id')}='not_ready' AND ${counted('sp.candidate_employee_id')})::int AS not_ready,
              (SELECT COUNT(*) FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${readyCol('sp.candidate_employee_id', 'sp.company_id')}='${UNCLASSIFIED}' AND ${counted('sp.candidate_employee_id')})::int AS ready_unclassified,
              -- Same three states as the Critical Roles tab (has_ready_now /
              -- has_any_successor). This said 'Covered' for ANY successor, so
              -- roles with no ready-now cover read as covered beside a 0% bench.
              CASE WHEN EXISTS(SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${readyCol('sp.candidate_employee_id', 'sp.company_id')}='ready-now' AND ${counted('sp.candidate_employee_id')})
                   THEN 'Ready Now'
                   WHEN EXISTS(SELECT 1 FROM succession_plans sp WHERE sp.critical_role_id=cr.id AND ${counted('sp.candidate_employee_id')})
                   THEN 'Developing'
                   ELSE 'No Successor' END AS coverage_status
       FROM critical_roles cr LEFT JOIN employees e ON e.id=cr.current_holder_id AND NOT e.is_test
       WHERE cr.company_id=$1
       ORDER BY CASE cr.risk_level WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, cr.role_title`,
      params
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="bench_strength.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/talent-risk', requireHRRead, exportGate, async (req, res) => {
  const cid    = getCid(req);
  const fmt    = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name AS employee_name, e.department, e.designation,
              ta.performance_score, ta.potential_score,
              ta.flight_risk, ta.readiness, ta.talent_classification,
              ta.leadership_score, ta.mobility,
              (SELECT STRING_AGG(cr.role_title, ', ')
               FROM succession_plans sp2
               JOIN critical_roles cr ON cr.id=sp2.critical_role_id
               WHERE sp2.candidate_employee_id=ta.employee_id AND cr.company_id=ta.company_id) AS successor_to_roles,
              ta.assessment_date
       FROM talent_assessments ta
       JOIN employees e ON e.id=ta.employee_id
       WHERE ta.company_id=$1 AND NOT e.is_test AND ${phaseOf('e')} <> 'left'
       ORDER BY CASE ta.flight_risk WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                ta.potential_score DESC`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="talent_risk.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/nine-box-summary', requireHRRead, exportGate, async (req, res) => {
  const cid    = getCid(req);
  const fmt    = req.query.format || 'json';
  try {
    const { rows: raw } = await pool.query(
      `SELECT e.name, e.department, e.designation,
              ta.performance_score, ta.potential_score,
              ta.flight_risk, ta.readiness, ta.assessment_date
       FROM talent_assessments ta
       JOIN employees e ON e.id=ta.employee_id
       WHERE ta.company_id=$1 AND NOT e.is_test AND ${phaseOf('e')} <> 'left'
       ORDER BY ta.potential_score DESC, ta.performance_score DESC`,
      [cid]
    );
    // The quadrant comes from the grid's own banding. A separate SQL CASE had
    // no branch for 'Inconsistent Players' (2_1) or 'Underperformers' (1_2),
    // so both were reported as 'Core Contributors' while the grid said otherwise.
    const quadrantOf = (r) => CELL_LABELS[`${scoreToAxis(Number(r.performance_score))}_${scoreToAxis(Number(r.potential_score))}`];
    const rows = raw.map(({ flight_risk, readiness, assessment_date, ...r }) =>
      ({ ...r, quadrant: quadrantOf(r), flight_risk, readiness, assessment_date }));
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="nine_box_summary.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/development-progress', requireHRRead, exportGate, async (req, res) => {
  const cid = getCid(req);
  const fmt = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name AS employee_name, e.department,
              ${phaseOf('e')} AS employment_phase,
              dp.plan_title, dp.status, dp.overall_progress,
              dp.start_date, dp.target_date,
              cr.role_title AS target_role,
              (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id=dp.id)::int AS total_actions,
              (SELECT COUNT(*) FROM development_actions da WHERE da.plan_id=dp.id AND da.status='completed')::int AS completed_actions,
              (SELECT COUNT(*) FROM mentoring_assignments ma WHERE ma.development_plan_id=dp.id AND ma.status='active')::int AS active_mentors
       FROM development_plans dp
       JOIN employees e ON e.id=dp.employee_id
       LEFT JOIN critical_roles cr ON cr.id=dp.critical_role_id
       WHERE dp.company_id=$1 AND NOT e.is_test
       ORDER BY dp.overall_progress ASC`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="development_progress.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/readiness', requireHRRead, exportGate, async (req, res) => {
  const cid = getCid(req);
  const fmt = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name, e.department, e.designation,
              ta.performance_score, ta.potential_score, ta.leadership_score,
              ta.readiness, ta.talent_classification, ta.mobility,
              ta.assessment_date,
              (SELECT STRING_AGG(cr.role_title, ', ')
               FROM succession_plans sp
               JOIN critical_roles cr ON cr.id=sp.critical_role_id
               WHERE sp.candidate_employee_id=ta.employee_id AND cr.company_id=ta.company_id) AS succession_roles,
              (SELECT COUNT(*) FROM development_plans dp WHERE dp.employee_id=ta.employee_id AND dp.company_id=ta.company_id AND dp.status='active')::int AS active_plans
       FROM talent_assessments ta
       JOIN employees e ON e.id=ta.employee_id
       WHERE ta.company_id=$1 AND NOT e.is_test AND ${phaseOf('e')} <> 'left'
       ORDER BY CASE ta.readiness WHEN 'ready-now' THEN 1 WHEN '1-2-years' THEN 2 WHEN '3-5-years' THEN 3 ELSE 4 END`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="readiness_report.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/reports/pipeline', requireHRRead, exportGate, async (req, res) => {
  const cid = getCid(req);
  const fmt = req.query.format || 'json';
  try {
    const { rows } = await pool.query(
      `SELECT e.name, e.department, e.designation,
              cl.level_name AS current_level, cl.level_order AS current_order,
              tl.level_name AS target_level,
              lpe.current_since, lpe.target_date,
              ${readinessClass('ta.readiness')} AS readiness, lpe.status,
              ${phaseOf('e')} AS employment_phase,
              ta.performance_score, ta.potential_score
       FROM leadership_pipeline_entries lpe
       JOIN employees e ON e.id=lpe.employee_id
       LEFT JOIN leadership_pipeline_levels cl ON cl.id=lpe.current_level_id
       LEFT JOIN leadership_pipeline_levels tl ON tl.id=lpe.target_level_id
       LEFT JOIN talent_assessments ta ON ta.employee_id=lpe.employee_id AND ta.company_id=lpe.company_id
       WHERE lpe.company_id=$1 AND NOT e.is_test
       ORDER BY cl.level_order, e.name`,
      [cid]
    );
    if (fmt === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="pipeline_report.csv"');
      return res.send(toCSV(rows));
    }
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

export default router;
