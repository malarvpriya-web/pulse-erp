/**
 * savingsRegister.service.js — identified → negotiated → contracted → realised.
 *
 * WHY THIS EXISTS
 * ---------------
 * The audit: *"No savings register, no identified → negotiated → contracted →
 * realised lifecycle, no finance sign-off, no run-rate tracking. This is the
 * module a CPO is measured on."*
 *
 * Pulse identifies savings in four places already and persists none of them.
 * This is the part that carries one from "we noticed" to "finance agrees we
 * banked it".
 *
 * WHAT THIS FILE REFUSES TO DO
 * ----------------------------
 * A savings register's only real engineering problem is that every incentive
 * points at making the number bigger. So the rules below are refusals:
 *
 *   - `realised` requires finance sign-off. Procurement identifies; finance
 *     confirms. A register where the claimant approves their own claim is a
 *     press release with a schema.
 *   - A realisation is FOR A PERIOD and the same period cannot be posted twice
 *     (unique index). "Book the annual saving each month" is the single most
 *     common way a ₹1.2M initiative becomes ₹14.4M, and nothing about the
 *     resulting data looks wrong.
 *   - A realisation outside `effective_from`/`effective_to` is refused. An
 *     initiative that stopped being true in month 7 must not bank in month 8.
 *   - Stage transitions follow a graph. You cannot jump identified → realised,
 *     because the intermediate states are the evidence.
 *   - The realised total is SUMMED FROM THE LEDGER, never stored. A stored
 *     running total and its own history drift the moment anything is corrected,
 *     and both numbers look plausible afterwards.
 *
 * RUN RATE vs IN-PERIOD
 * ---------------------
 * `estimated_annual_saving` is a RUN RATE — what a full year at the new price
 * is worth. `realised` is what the ledger says was actually banked in the
 * window asked for. Reporting a run rate as if it were banked money is the
 * other classic inflation, so the two are never added and never share a column.
 */
import pool from '../../shared/db.js';
import { nextSavingsNumber } from '../../../shared/docNumber.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v, fallback = 0) => {
  if (v == null || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

export const STAGES = Object.freeze([
  'identified', 'negotiated', 'contracted', 'realised', 'rejected', 'lapsed',
]);

export const LEVERS = Object.freeze([
  'negotiated_price', 'volume_consolidation', 'spec_change', 'payment_terms',
  'tco_award', 'demand_reduction', 'vendor_switch', 'contract_renegotiation', 'other',
]);

export const BASES = Object.freeze(['quoted', 'observed', 'estimated', 'assumed']);

/**
 * The stage graph.
 *
 * Deliberately NOT a free-for-all. identified → realised in one hop would mean
 * a saving that was never negotiated and never contracted was nonetheless
 * banked, which is either a data-entry error or a claim nobody can substantiate.
 *
 * `rejected` and `lapsed` are reachable from any live stage and are terminal:
 * an initiative that died stays dead, because re-opening it is how the same
 * saving gets counted in two years.
 */
const TRANSITIONS = Object.freeze({
  identified: ['negotiated', 'rejected', 'lapsed'],
  negotiated: ['contracted', 'identified', 'rejected', 'lapsed'],
  contracted: ['realised', 'negotiated', 'rejected', 'lapsed'],
  realised:   ['lapsed'],   // it unwound; it cannot un-realise
  rejected:   [],
  lapsed:     [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** The run-rate figure, frozen at identification. */
export function computeAnnualSaving({ baseline_unit_price, target_unit_price, baseline_annual_qty }) {
  const base = num(baseline_unit_price, null);
  const target = num(target_unit_price, null);
  const qty = num(baseline_annual_qty, null);
  if (base == null || target == null || qty == null) return 0;
  // A negative delta is a cost increase, not a saving. Stored as 0 rather than
  // as a negative "saving", which would net off against real savings elsewhere
  // and quietly reduce the visible size of a problem.
  return Math.max(0, round2((base - target) * qty));
}

/**
 * Raise an initiative.
 *
 * `source_type` + `source_ref_id` are unique per company, so the same TCO award
 * cannot be raised as three initiatives by three people. The unique-violation is
 * translated into a 409-shaped error rather than a 500.
 */
export async function createInitiative({ companyId, userId, body }) {
  const {
    title, description, lever, category_id, vendor_id, item_id,
    baseline_unit_price, target_unit_price, baseline_annual_qty,
    baseline_basis, baseline_note, currency,
    effective_from, effective_to, owner_user_id,
    source_type, source_ref_id,
  } = body ?? {};

  if (!title || !String(title).trim()) {
    return { error: 'title is required', status: 400 };
  }
  if (lever && !LEVERS.includes(lever)) {
    return { error: `lever must be one of: ${LEVERS.join(', ')}`, status: 400 };
  }
  if (baseline_basis && !BASES.includes(baseline_basis)) {
    return { error: `baseline_basis must be one of: ${BASES.join(', ')}`, status: 400 };
  }
  if (!companyId) {
    return { error: 'A savings initiative must belong to a company.', status: 400 };
  }

  const estimated = computeAnnualSaving({ baseline_unit_price, target_unit_price, baseline_annual_qty });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const number = await nextSavingsNumber(client);
    const { rows } = await client.query(`
      INSERT INTO savings_initiatives (
        company_id, initiative_number, title, description, lever,
        category_id, vendor_id, item_id,
        baseline_unit_price, target_unit_price, baseline_annual_qty,
        baseline_basis, baseline_note, estimated_annual_saving, currency,
        effective_from, effective_to, owner_user_id,
        source_type, source_ref_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [
        companyId, number, String(title).trim(), description ?? null,
        lever ?? 'negotiated_price',
        category_id ?? null, vendor_id ?? null, item_id ?? null,
        baseline_unit_price ?? null, target_unit_price ?? null, baseline_annual_qty ?? null,
        baseline_basis ?? 'estimated', baseline_note ?? null, estimated, currency ?? 'INR',
        effective_from ?? null, effective_to ?? null, owner_user_id ?? userId ?? null,
        source_type ?? 'manual', source_ref_id ?? null, userId ?? null,
      ]
    );

    // The ledger starts where the initiative does, so its history is complete
    // rather than beginning at the first change.
    await client.query(`
      INSERT INTO savings_events (initiative_id, company_id, event_type, to_stage, note, created_by)
      VALUES ($1,$2,'stage_change','identified','Initiative raised',$3)`,
      [rows[0].id, companyId, userId ?? null]);

    await client.query('COMMIT');
    return { initiative: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && /source_unique/.test(err.constraint ?? '')) {
      return {
        error: 'A savings initiative already exists for that source record.',
        status: 409,
      };
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Move an initiative along the pipeline.
 *
 * ⚠ `realised` is gated on finance sign-off. The gate lives here rather than in
 * a CHECK constraint because it spans two facts (the target stage and the
 * approval columns) and must produce an explainable refusal, not a 23514.
 */
export async function changeStage({ companyId, userId, id, toStage, note, financeApproval }) {
  if (!STAGES.includes(toStage)) {
    return { error: `stage must be one of: ${STAGES.join(', ')}`, status: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      `SELECT * FROM savings_initiatives
        WHERE id = $1 AND deleted_at IS NULL
          AND ($2::INTEGER IS NULL OR company_id = $2::INTEGER)
        FOR UPDATE`,
      [id, companyId ?? null]);

    const init = cur[0];
    if (!init) { await client.query('ROLLBACK'); return { error: 'Initiative not found', status: 404 }; }

    if (init.stage === toStage) {
      await client.query('ROLLBACK');
      return { error: `Initiative is already ${toStage}.`, status: 409 };
    }
    if (!canTransition(init.stage, toStage)) {
      await client.query('ROLLBACK');
      return {
        error: `Cannot move a '${init.stage}' initiative to '${toStage}'. Allowed from here: ${
          (TRANSITIONS[init.stage] ?? []).join(', ') || 'nothing — this stage is terminal'}.`,
        status: 409,
      };
    }

    // ⚠ The sign-off gate.
    let approvedBy = init.finance_approved_by;
    let approvedAt = init.finance_approved_at;
    if (toStage === 'realised') {
      if (!financeApproval && !approvedBy) {
        return await refuse(client, {
          error: 'A saving cannot be marked realised without finance sign-off.',
          status: 403,
        });
      }
      if (financeApproval) {
        // The approver must not be the person who raised it. Self-certification
        // is the failure mode the gate exists for, so it is refused explicitly
        // rather than left to policy.
        if (init.created_by != null && userId != null && Number(init.created_by) === Number(userId)) {
          return await refuse(client, {
            error: 'The person who raised an initiative cannot sign it off. Finance sign-off must come from someone else.',
            status: 403,
          });
        }
        approvedBy = userId ?? null;
        approvedAt = new Date();
      }
    }

    const { rows } = await client.query(
      `UPDATE savings_initiatives
          SET stage = $1, finance_approved_by = $2, finance_approved_at = $3, updated_at = NOW()
        WHERE id = $4 RETURNING *`,
      [toStage, approvedBy ?? null, approvedAt ?? null, id]);

    await client.query(
      `INSERT INTO savings_events (initiative_id, company_id, event_type, from_stage, to_stage, note, created_by)
       VALUES ($1,$2,'stage_change',$3,$4,$5,$6)`,
      [id, init.company_id, init.stage, toStage, note ?? null, userId ?? null]);

    await client.query('COMMIT');
    return { initiative: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function refuse(client, payload) {
  await client.query('ROLLBACK');
  return payload;
}

/**
 * Post a realisation for a named period.
 *
 * ⚠ Three refusals, each guarding a specific inflation:
 *   - outside the effective window → an initiative that lapsed cannot bank;
 *   - a period already posted     → the unique index; "book it every month";
 *   - stage below `contracted`    → you cannot bank what was never agreed.
 */
export async function postRealisation({ companyId, userId, id, body }) {
  const { amount, period_start, period_end, evidence_type, evidence_ref, note } = body ?? {};

  const amt = num(amount, null);
  if (amt == null) return { error: 'amount is required', status: 400 };
  if (!period_start || !period_end) {
    return { error: 'period_start and period_end are required — a realisation is always for a named period.', status: 400 };
  }
  if (new Date(period_end) < new Date(period_start)) {
    return { error: 'period_end must not precede period_start', status: 400 };
  }

  const { rows: cur } = await pool.query(
    `SELECT * FROM savings_initiatives
      WHERE id = $1 AND deleted_at IS NULL
        AND ($2::INTEGER IS NULL OR company_id = $2::INTEGER)`,
    [id, companyId ?? null]);
  const init = cur[0];
  if (!init) return { error: 'Initiative not found', status: 404 };

  if (!['contracted', 'realised'].includes(init.stage)) {
    return {
      error: `A '${init.stage}' initiative cannot post a realisation — a saving must be contracted before it can be banked.`,
      status: 409,
    };
  }

  if (init.effective_from && new Date(period_start) < new Date(init.effective_from)) {
    return { error: `Period starts before this initiative was effective (${String(init.effective_from).slice(0, 10)}).`, status: 409 };
  }
  if (init.effective_to && new Date(period_end) > new Date(init.effective_to)) {
    return { error: `Period ends after this initiative lapsed (${String(init.effective_to).slice(0, 10)}).`, status: 409 };
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO savings_events
         (initiative_id, company_id, event_type, amount, period_start, period_end,
          evidence_type, evidence_ref, note, created_by)
       VALUES ($1,$2,'realisation',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [id, init.company_id, round2(amt), period_start, period_end,
       evidence_type ?? 'manual', evidence_ref ?? null, note ?? null, userId ?? null]);
    return { event: rows[0] };
  } catch (err) {
    if (err.code === '23505') {
      return {
        error: `A realisation has already been posted for ${period_start} → ${period_end}. Correct the existing entry rather than adding a second one.`,
        status: 409,
      };
    }
    throw err;
  }
}

/** One initiative with its full ledger and its summed realisation. */
export async function getInitiative({ companyId, id }) {
  const { rows } = await pool.query(
    `SELECT i.*,
            v.vendor_name, ic.name AS category_name, it.item_name,
            COALESCE((SELECT SUM(e.amount) FROM savings_events e
                       WHERE e.initiative_id = i.id AND e.event_type = 'realisation'), 0) AS realised_amount
       FROM savings_initiatives i
       LEFT JOIN vendors v          ON v.id  = i.vendor_id
       LEFT JOIN item_categories ic ON ic.id = i.category_id AND ic.deleted_at IS NULL
       LEFT JOIN inventory_items it ON it.id = i.item_id
      WHERE i.id = $1 AND i.deleted_at IS NULL
        AND ($2::INTEGER IS NULL OR i.company_id = $2::INTEGER)`,
    [id, companyId ?? null]);
  if (!rows[0]) return null;

  const { rows: events } = await pool.query(
    `SELECT * FROM savings_events WHERE initiative_id = $1 ORDER BY created_at ASC, id ASC`, [id]);

  return {
    ...rows[0],
    estimated_annual_saving: round2(num(rows[0].estimated_annual_saving)),
    realised_amount: round2(num(rows[0].realised_amount)),
    events,
  };
}

/**
 * The pipeline board.
 *
 * ⚠ `pipeline_value` and `realised_value` are DIFFERENT KINDS OF NUMBER and are
 * never added. Pipeline is a run rate — what a full year at the new price is
 * worth if it lands. Realised is what the ledger says was banked in the window
 * asked for. A single "savings" headline mixing the two is the reason nobody
 * believes savings reporting.
 */
export async function loadPipeline({ companyId, from = null, to = null } = {}) {
  const params = [];
  const where = ['i.deleted_at IS NULL'];
  if (companyId) { params.push(companyId); where.push(`i.company_id = $${params.length}`); }
  const scoped = where.join(' AND ');

  // The realisation window is applied to the LEDGER, not to the initiative:
  // asking "what did we bank in Q3" must not also filter out initiatives raised
  // in Q2 that banked in Q3.
  const evParams = [...params];
  const evWhere = ["e.event_type = 'realisation'"];
  if (from) { evParams.push(from); evWhere.push(`e.period_start >= $${evParams.length}::date`); }
  if (to)   { evParams.push(to);   evWhere.push(`e.period_end   <= $${evParams.length}::date`); }

  const [stageRes, leverRes, categoryRes, realisedRes, basisRes] = await Promise.all([
    pool.query(`
      SELECT i.stage AS label, i.stage,
             COUNT(*)::INT AS initiatives,
             COALESCE(SUM(i.estimated_annual_saving), 0) AS pipeline_value
        FROM savings_initiatives i WHERE ${scoped}
       GROUP BY i.stage`, params),

    pool.query(`
      SELECT i.lever AS label, i.lever,
             COUNT(*)::INT AS initiatives,
             COALESCE(SUM(i.estimated_annual_saving), 0) AS pipeline_value
        FROM savings_initiatives i WHERE ${scoped}
       GROUP BY i.lever
       ORDER BY pipeline_value DESC`, params),

    pool.query(`
      SELECT COALESCE(ic.name, 'Unclassified') AS label,
             COALESCE(ic.name, 'Unclassified') AS category,
             COUNT(*)::INT AS initiatives,
             COALESCE(SUM(i.estimated_annual_saving), 0) AS pipeline_value
        FROM savings_initiatives i
        LEFT JOIN item_categories ic ON ic.id = i.category_id AND ic.deleted_at IS NULL
       WHERE ${scoped}
       GROUP BY COALESCE(ic.name, 'Unclassified')
       ORDER BY pipeline_value DESC`, params),

    pool.query(`
      SELECT COALESCE(SUM(e.amount), 0) AS realised_value,
             COUNT(*)::INT              AS postings,
             COUNT(DISTINCT e.initiative_id)::INT AS initiatives_realising,
             COALESCE(SUM(e.amount) FILTER (WHERE e.evidence_type <> 'manual'), 0) AS evidenced_value
        FROM savings_events e
        JOIN savings_initiatives i ON i.id = e.initiative_id
       WHERE ${scoped} AND ${evWhere.join(' AND ')}`, evParams),

    // How much of the pipeline rests on a real baseline versus an assumed one.
    pool.query(`
      SELECT i.baseline_basis AS label, i.baseline_basis,
             COUNT(*)::INT AS initiatives,
             COALESCE(SUM(i.estimated_annual_saving), 0) AS pipeline_value
        FROM savings_initiatives i WHERE ${scoped}
       GROUP BY i.baseline_basis`, params),
  ]);

  const byStage = Object.fromEntries(stageRes.rows.map((r) => [r.stage, {
    initiatives: num(r.initiatives), pipeline_value: round2(num(r.pipeline_value)),
  }]));
  for (const s of STAGES) byStage[s] ??= { initiatives: 0, pipeline_value: 0 };

  const live = ['identified', 'negotiated', 'contracted'];
  const openPipeline = round2(live.reduce((s, k) => s + byStage[k].pipeline_value, 0));

  const rl = realisedRes.rows[0] ?? {};
  const realisedValue = round2(num(rl.realised_value));
  const evidenced = round2(num(rl.evidenced_value));

  const shape = (rows) => rows.map((r) => ({
    ...r, initiatives: num(r.initiatives), pipeline_value: round2(num(r.pipeline_value)),
  }));

  return {
    currency: 'INR',
    from: from || null,
    to: to || null,

    // A run rate. What a full year at the new price is worth IF it lands.
    pipeline: {
      open_value: openPipeline,
      by_stage: byStage,
      basis: 'annual run rate, frozen at identification',
      note: 'Pipeline is a run rate and realised is banked money. They are different kinds of number and are never added.',
    },

    // Banked money, from the ledger, for the window asked for.
    realised: {
      value: realisedValue,
      postings: num(rl.postings),
      initiatives_realising: num(rl.initiatives_realising),
      // A realisation pointing at a PO or invoice is a fact; 'manual' is a claim.
      evidenced_value: evidenced,
      evidenced_pct: realisedValue > 0 ? round2((evidenced / realisedValue) * 100) : null,
      basis: 'sum of realisation postings whose period falls in the window',
    },

    by_lever: shape(leverRes.rows),
    by_category: shape(categoryRes.rows),
    by_baseline_basis: shape(basisRes.rows),

    integrity: {
      note: 'A realisation is unique per (initiative, period): the same period cannot be banked twice. Realised totals are summed from the ledger and never stored on the initiative.',
    },
  };
}

/** The register list, filtered. */
export async function listInitiatives({ companyId, stage, lever, vendorId, limit = 100 }) {
  const params = [];
  const where = ['i.deleted_at IS NULL'];
  if (companyId) { params.push(companyId); where.push(`i.company_id = $${params.length}`); }
  if (stage)     { params.push(stage);     where.push(`i.stage = $${params.length}`); }
  if (lever)     { params.push(lever);     where.push(`i.lever = $${params.length}`); }
  if (vendorId)  { params.push(vendorId);  where.push(`i.vendor_id = $${params.length}`); }

  const { rows } = await pool.query(`
    SELECT i.*, v.vendor_name, ic.name AS category_name,
           COALESCE((SELECT SUM(e.amount) FROM savings_events e
                      WHERE e.initiative_id = i.id AND e.event_type = 'realisation'), 0) AS realised_amount
      FROM savings_initiatives i
      LEFT JOIN vendors v          ON v.id  = i.vendor_id
      LEFT JOIN item_categories ic ON ic.id = i.category_id AND ic.deleted_at IS NULL
     WHERE ${where.join(' AND ')}
     ORDER BY i.created_at DESC
     LIMIT ${Math.min(Number(limit) || 100, 500)}`, params);

  return rows.map((r) => ({
    ...r,
    estimated_annual_saving: round2(num(r.estimated_annual_saving)),
    realised_amount: round2(num(r.realised_amount)),
  }));
}

export default {
  createInitiative, changeStage, postRealisation, getInitiative,
  loadPipeline, listInitiatives, canTransition, computeAnnualSaving,
  STAGES, LEVERS, BASES,
};
