/**
 * Depreciation service — Companies Act 2013, Schedule II.
 * Supports SLM (Straight Line Method) and WDV (Written Down Value).
 */

import pool from '../db.js';
import journalRepo from '../repositories/journal.repository.js';

// Useful life in years per asset class (Schedule II, Companies Act 2013)
const USEFUL_LIFE = {
  computers:       3,
  servers:         6,
  office_equip:    5,
  furniture:       10,
  vehicles:        8,
  plant_machinery: 15,
  buildings:       30,
};

// Default residual value: 5% of cost (Schedule II para 4)
const DEFAULT_RESIDUAL_PCT = 0.05;

/**
 * Annual SLM depreciation amount.
 * @param {number} cost
 * @param {number} residualValue
 * @param {number} usefulLifeYears
 * @returns {number}
 */
function calculateSLM(cost, residualValue, usefulLifeYears) {
  return (cost - residualValue) / usefulLifeYears;
}

/**
 * WDV depreciation for a single period.
 * @param {number} openingWDV  - book value at start of period
 * @param {number} rate        - WDV rate as percentage (e.g. 33.33 for computers)
 * @returns {number}
 */
function calculateWDV(openingWDV, rate) {
  return openingWDV * (rate / 100);
}

/**
 * Build a full depreciation schedule for an asset.
 * Respects Companies Act 2013 useful-life defaults when not overridden.
 *
 * @param {{ purchase_cost, salvage_value, useful_life_years, asset_class,
 *            depreciation_method, wdv_rate, purchase_date }} asset
 * @returns {Array<{ year, fy, opening, depreciation, closing, accumulated }>}
 */
function buildSchedule(asset) {
  const cost      = parseFloat(asset.purchase_cost || 0);
  const life      = parseFloat(asset.useful_life_years)
                    || USEFUL_LIFE[asset.asset_class]
                    || 5;
  const residual  = parseFloat(asset.salvage_value)
                    || parseFloat((cost * DEFAULT_RESIDUAL_PCT).toFixed(2));
  const method    = (asset.depreciation_method || 'SLM').toUpperCase();
  const wdvRate   = parseFloat(asset.wdv_rate || 0) || Math.round((1 - Math.pow(residual / cost, 1 / life)) * 10000) / 100;
  const startYear = asset.purchase_date
    ? new Date(asset.purchase_date).getFullYear()
    : new Date().getFullYear();

  const maxYears = Math.ceil(method === 'SLM' ? life : life * 2);
  const schedule = [];
  let opening = cost;

  for (let i = 0; i < maxYears; i++) {
    if (opening <= residual + 0.01) break;
    const fyStart = startYear + i;
    const fy = `${fyStart}-${String(fyStart + 1).slice(-2)}`;
    let dep = method === 'SLM'
      ? calculateSLM(cost, residual, life)
      : calculateWDV(opening, wdvRate);
    dep = Math.min(dep, opening - residual);
    dep = Math.max(0, parseFloat(dep.toFixed(2)));
    const closing = parseFloat((opening - dep).toFixed(2));
    schedule.push({
      year: i + 1,
      fy,
      opening: parseFloat(opening.toFixed(2)),
      depreciation: dep,
      closing,
      accumulated: parseFloat((cost - closing).toFixed(2)),
    });
    opening = closing;
  }
  return schedule;
}

/**
 * Post monthly depreciation journal entries for all active assets of a company.
 * Called by the monthly cron job.
 *
 * @param {string|number} companyId
 * @param {string} [asOfDate]  - ISO date string; defaults to today
 * @returns {{ posted: number, skipped: number, errors: string[] }}
 */
async function postMonthlyDepreciation(companyId, asOfDate) {
  const depDate   = asOfDate ? new Date(asOfDate) : new Date();
  const month     = depDate.getMonth() + 1;
  const year      = depDate.getFullYear();
  const periodKey = `${year}-${String(month).padStart(2, '0')}`;

  const client = await pool.connect();
  let posted = 0, skipped = 0;
  const errors = [];

  try {
    await client.query('BEGIN');

    // Load all active assets
    const { rows: assets } = await client.query(
      `SELECT * FROM fixed_assets
       WHERE company_id = $1 AND status = 'active' AND purchase_cost > 0`,
      [companyId]
    );

    for (const asset of assets) {
      try {
        // Skip if already posted this period
        const { rows: [existing] } = await client.query(
          `SELECT id FROM journal_entries
           WHERE company_id = $1
             AND reference_type = 'depreciation'
             AND reference_id   = $2
             AND to_char(entry_date, 'YYYY-MM') = $3
           LIMIT 1`,
          [companyId, asset.id, periodKey]
        );
        if (existing) { skipped++; continue; }

        const schedule = buildSchedule(asset);
        const fyYear   = month >= 4 ? year : year - 1;
        const fyLabel  = `${fyYear}-${String(fyYear + 1).slice(-2)}`;
        const fyEntry  = schedule.find(s => s.fy === fyLabel);
        if (!fyEntry || fyEntry.depreciation <= 0) { skipped++; continue; }

        const monthlyDep = parseFloat((fyEntry.depreciation / 12).toFixed(2));

        // Resolve GL accounts for depreciation expense and accumulated depreciation
        const { rows: [depExpAcc] } = await client.query(
          `SELECT id FROM chart_of_accounts
           WHERE account_code = ANY(ARRAY['6100','6101','6000'])
             AND (company_id = $1 OR company_id IS NULL) AND is_active = true
           ORDER BY company_id DESC NULLS LAST LIMIT 1`,
          [companyId]
        );
        const { rows: [accDepAcc] } = await client.query(
          `SELECT id FROM chart_of_accounts
           WHERE account_code = ANY(ARRAY['1600','1601','1610'])
             AND (company_id = $1 OR company_id IS NULL) AND is_active = true
           ORDER BY company_id DESC NULLS LAST LIMIT 1`,
          [companyId]
        );

        if (!depExpAcc || !accDepAcc) { skipped++; continue; }

        const entryNumber = await journalRepo.getNextEntryNumber();
        const entry = await journalRepo.createEntry(client, {
          company_id:     companyId,
          entry_number:   entryNumber,
          entry_date:     depDate.toISOString().split('T')[0],
          entry_type:     'Depreciation',
          reference_type: 'depreciation',
          reference_id:   asset.id,
          description:    `Depreciation ${asset.asset_name || asset.id} — ${periodKey}`,
        });

        await journalRepo.createLine(client, {
          journal_entry_id: entry.id,
          account_id:       depExpAcc.id,
          description:      `Depreciation expense — ${asset.asset_name || asset.id}`,
          debit:            monthlyDep,
          credit:           0,
        });
        await journalRepo.createLine(client, {
          journal_entry_id: entry.id,
          account_id:       accDepAcc.id,
          description:      `Accumulated depreciation — ${asset.asset_name || asset.id}`,
          debit:            0,
          credit:           monthlyDep,
        });
        await journalRepo.postEntry(client, entry.id);

        // Update accumulated depreciation on the asset record
        await client.query(
          `UPDATE fixed_assets
           SET accumulated_depreciation = COALESCE(accumulated_depreciation, 0) + $1,
               book_value               = purchase_cost - COALESCE(accumulated_depreciation, 0) - $1,
               updated_at               = NOW()
           WHERE id = $2`,
          [monthlyDep, asset.id]
        );

        posted++;
      } catch (assetErr) {
        errors.push(`Asset ${asset.id}: ${assetErr.message}`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { posted, skipped, errors };
}

export { USEFUL_LIFE, calculateSLM, calculateWDV, buildSchedule, postMonthlyDepreciation };
