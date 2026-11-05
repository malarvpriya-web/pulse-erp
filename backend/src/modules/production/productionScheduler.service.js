// backend/src/modules/production/productionScheduler.service.js
/**
 * Finite scheduling: put operations in a sequence on a work centre, at a time.
 *
 * WHAT "PRODUCTION SCHEDULING" MEANT BEFORE
 * -----------------------------------------
 * A production order carried `planned_start_date` and `planned_end_date`, both
 * typed by whoever released it. Nothing sequenced the operations inside it, and
 * nothing checked whether the work centre those operations need was already
 * committed to something else at that hour. Two orders could hold the same
 * machine for the same afternoon and no part of the system objected, because no
 * part of the system was looking.
 *
 * CRP measured that after the fact - load percentage per bucket, which tells you
 * a work centre is at 609% but not which job to move. That is capacity
 * PLANNING. This is capacity SCHEDULING: one queue per work centre, each
 * operation given a start and an end that does not overlap the operation before
 * it.
 *
 * THE MODEL, STATED PLAINLY
 * -------------------------
 *   - One queue per work centre, sequenced by the chosen rule.
 *   - A work centre runs `capacity_hours_per_day` hours on a working day,
 *     derated by `efficiency_pct`, times `num_machines` parallel streams.
 *   - Operations are not split across machines; an operation runs on one stream.
 *   - Weekends off, from `working_days_per_week`. No shift calendar, no
 *     holidays: Pulse does not hold a manufacturing calendar, and inventing one
 *     would make the dates look more precise than they are.
 *
 * It is a forward-loading finite scheduler, which is the honest thing to build
 * on this data. It is NOT a solver: it does not search for a better sequence
 * than the rule gives it. `late_operations` on the run says how many commitments
 * the resulting sequence misses, so a planner can see the cost of the rule and
 * change it rather than being told a schedule is optimal.
 */
import pool from '../../config/db.js';

const HOURS = 3600 * 1000;
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

export const SEQUENCING_RULES = {
  edd:      { label: 'Earliest due date', sort: (a, b) => dateOf(a.due_date) - dateOf(b.due_date) },
  spt:      { label: 'Shortest processing time', sort: (a, b) => num(a.hours) - num(b.hours) },
  priority: { label: 'Order priority, then due date',
              sort: (a, b) => (priorityRank(a.priority) - priorityRank(b.priority))
                           || (dateOf(a.due_date) - dateOf(b.due_date)) },
};

function dateOf(v) { return v ? new Date(v).getTime() : Number.MAX_SAFE_INTEGER; }
function priorityRank(p) {
  const order = { urgent: 0, critical: 0, high: 1, normal: 2, medium: 2, low: 3 };
  return order[String(p || 'normal').toLowerCase()] ?? 2;
}

/** A work centre's daily productive capacity per machine stream, in hours. */
function dailyHours(wc) {
  const base = num(wc.capacity_hours_per_day) || num(wc.shift_hours) || 8;
  const eff  = (num(wc.efficiency_pct) || 100) / 100;
  const machineHours = base * eff;
  const operators = num(wc.num_operators);
  if (!operators) return machineHours;
  // Effective capacity is the lesser of machine and labour - the same rule CRP
  // applies, kept identical here so the schedule cannot promise hours the
  // capacity plan says do not exist.
  const labourHours = operators * (num(wc.labour_hours_per_operator) || base)
                    * ((num(wc.labour_efficiency_pct) || 100) / 100);
  return Math.min(machineHours, labourHours / Math.max(1, num(wc.num_machines) || 1));
}

function isWorkingDay(d, workingDaysPerWeek) {
  const dow = d.getDay();                     // 0 Sun .. 6 Sat
  const wd = num(workingDaysPerWeek) || 5;
  if (wd >= 7) return true;
  if (wd === 6) return dow !== 0;
  return dow !== 0 && dow !== 6;
}

/**
 * Place `hours` of work on a stream, starting no earlier than `from`, and
 * return {start, end}. Work only happens on working days, and only up to
 * `perDay` hours of it.
 */
function placeWork(from, hours, perDay, workingDaysPerWeek) {
  let cursor = new Date(from);
  let remaining = hours;
  let start = null;
  let guard = 0;

  while (remaining > 0 && guard++ < 3650) {
    if (!isWorkingDay(cursor, workingDaysPerWeek)) {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0);
      continue;
    }
    const dayStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 0, 0, 0);
    const dayEnd   = new Date(dayStart.getTime() + perDay * HOURS);
    if (cursor >= dayEnd) {
      cursor = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1, 0, 0, 0);
      continue;
    }
    if (!start) start = new Date(cursor);
    const availableToday = (dayEnd - cursor) / HOURS;
    const used = Math.min(availableToday, remaining);
    cursor = new Date(cursor.getTime() + used * HOURS);
    remaining -= used;
    if (remaining > 0) {
      cursor = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1, 0, 0, 0);
    }
  }
  return { start: start || new Date(from), end: cursor };
}

/**
 * Sequence every unfinished operation on every work centre.
 *
 * Returns the run summary plus the scheduled operations, and writes
 * `scheduled_seq`, `scheduled_start` and `scheduled_end` onto the operations so
 * the shop floor sees the same order the planner does.
 */
export async function finiteSchedule({
  companyId = null, horizonDays = 60, rule = 'edd', actor = {}, persist = true,
} = {}) {
  const chosen = SEQUENCING_RULES[rule] ? rule : 'edd';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: centres } = await client.query(`
      SELECT id, name, capacity_hours_per_day, shift_hours, efficiency_pct,
             working_days_per_week, num_machines, num_operators,
             labour_hours_per_operator, labour_efficiency_pct
        FROM work_centres
       WHERE ($1::int IS NULL OR company_id = $1)`, [companyId]);
    const centreById = new Map(centres.map(c => [Number(c.id), c]));

    const { rows: ops } = await client.query(`
      SELECT o.id, o.production_order_id, o.step_no, o.operation, o.work_centre_id,
             o.work_centre_name, o.std_time_hrs, o.status,
             p.production_order_no, p.priority,
             COALESCE(p.planned_end_date, p.planned_start_date) AS due_date,
             GREATEST(COALESCE(p.quantity_planned,0) - COALESCE(p.quantity_completed,0), 0) AS open_qty
        FROM production_operations o
        JOIN production_orders p ON p.id = o.production_order_id
       WHERE ($1::int IS NULL OR o.company_id = $1)
         AND o.work_centre_id IS NOT NULL
         AND LOWER(COALESCE(o.status,'pending')) NOT IN ('completed','cancelled','skipped')
         AND LOWER(COALESCE(p.status,'')) NOT IN ('completed','cancelled','closed')`, [companyId]);

    const queued = ops.map(o => ({
      ...o,
      // std_time_hrs is per operation as routed. A zero is treated as a minimum
      // slice rather than as instantaneous, so an unrouted step still occupies
      // the machine and cannot hide a real conflict.
      hours: Math.max(0.25, num(o.std_time_hrs)),
    }));

    const byCentre = new Map();
    for (const op of queued) {
      const k = Number(op.work_centre_id);
      if (!byCentre.has(k)) byCentre.set(k, []);
      byCentre.get(k).push(op);
    }

    const now = new Date();
    const horizonEnd = new Date(now.getTime() + horizonDays * 24 * HOURS);
    const scheduled = [];
    let lateCount = 0;
    let makespanEnd = now;

    for (const [centreId, list] of byCentre) {
      const wc = centreById.get(centreId);
      if (!wc) continue;
      const perDay  = dailyHours(wc);
      const streams = Math.max(1, num(wc.num_machines) || 1);
      // One cursor per parallel machine; each operation goes to whichever stream
      // frees up first.
      const cursors = Array.from({ length: streams }, () => new Date(now));

      list.sort(SEQUENCING_RULES[chosen].sort);

      let seq = 0;
      for (const op of list) {
        let pick = 0;
        for (let i = 1; i < cursors.length; i++) if (cursors[i] < cursors[pick]) pick = i;
        const { start, end } = placeWork(cursors[pick], op.hours, perDay, wc.working_days_per_week);
        cursors[pick] = end;
        seq += 1;
        const late = op.due_date ? end > new Date(op.due_date) : false;
        if (late) lateCount++;
        if (end > makespanEnd) makespanEnd = end;
        scheduled.push({
          ...op, scheduled_seq: seq, scheduled_start: start, scheduled_end: end,
          stream: pick + 1, late, beyond_horizon: end > horizonEnd,
        });
      }
    }

    let run = null;
    if (persist) {
      const runNo = `SCH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`;
      const { rows: [created] } = await client.query(`
        INSERT INTO production_schedule_runs
          (company_id, run_no, horizon_days, rule, operations_scheduled, work_centres,
           makespan_hours, late_operations, run_by, run_by_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [companyId, runNo, horizonDays, chosen, scheduled.length, byCentre.size,
         Math.round(((makespanEnd - now) / HOURS) * 100) / 100, lateCount,
         actor.id ?? null, actor.name ?? 'System']);
      run = created;

      for (const s of scheduled) {
        await client.query(`
          UPDATE production_operations
             SET scheduled_seq = $2, scheduled_start = $3, scheduled_end = $4,
                 scheduled_run_id = $5, updated_at = NOW()
           WHERE id = $1`, [s.id, s.scheduled_seq, s.scheduled_start, s.scheduled_end, run.id]);
      }
    }

    await client.query('COMMIT');
    return {
      run, rule: chosen, rule_label: SEQUENCING_RULES[chosen].label,
      work_centres: byCentre.size, operations: scheduled.length,
      late_operations: lateCount,
      makespan_hours: Math.round(((makespanEnd - now) / HOURS) * 100) / 100,
      scheduled,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** The current queue for one work centre, in scheduled order. */
export async function sequenceWorkCentre({ workCentreId, companyId = null }) {
  const { rows } = await pool.query(`
    SELECT o.id, o.production_order_id, o.operation, o.step_no, o.std_time_hrs,
           o.scheduled_seq, o.scheduled_start, o.scheduled_end, o.status,
           p.production_order_no, p.priority,
           COALESCE(p.planned_end_date, p.planned_start_date) AS due_date
      FROM production_operations o
      JOIN production_orders p ON p.id = o.production_order_id
     WHERE o.work_centre_id = $1
       AND ($2::int IS NULL OR o.company_id = $2)
       AND LOWER(COALESCE(o.status,'pending')) NOT IN ('completed','cancelled','skipped')
     ORDER BY o.scheduled_seq NULLS LAST, o.step_no`, [workCentreId, companyId]);
  return rows.map(r => ({
    ...r,
    late: r.scheduled_end && r.due_date ? new Date(r.scheduled_end) > new Date(r.due_date) : false,
  }));
}
