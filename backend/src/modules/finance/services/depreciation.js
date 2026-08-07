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

// fixed_assets.category holds free-text labels (e.g. 'IT Equipment',
// 'Plant & Machinery') — this maps them to the USEFUL_LIFE keys above.
// Only used as a fallback when useful_life_years isn't set on the asset.
const CATEGORY_TO_CLASS = {
  'machinery':          'plant_machinery',
  'plant & machinery':  'plant_machinery',
  'it equipment':       'computers',
  'computers & it':     'computers',
  'computers':          'computers',
  'vehicles':           'vehicles',
  'furniture':           'furniture',
  'furniture & fixtures': 'furniture',
  'land & building':    'buildings',
  'building':           'buildings',
  'buildings':          'buildings',
};

// GL accounts, by chart_of_accounts.code — same accounts the (now-retired)
// manual "Run Depreciation" button posted to (assets.routes.js), so an
// asset's depreciation stays in the same ledger account across its life
// regardless of which mechanism posted it.
const DEPRECIATION_EXPENSE_CODE = '5040';
// NOTE: the (retired) annual route's own accumAcctMap mapped
// 'Plant & Machinery'/'Machinery' -> '1110', but '1110' is this company's
// Cash account, not an accumulated-depreciation account (confirmed live —
// see MODULE_FEATURE_CONNECTION_MANUAL.md for the historical-entry finding).
// There is no dedicated Plant & Machinery accumulated-depreciation account
// in the live chart_of_accounts, so it falls back to the generic '1101'
// ("Accumulated Depreciation") like any other unmapped category.
const ACCUM_DEP_CODE_BY_CATEGORY = {
  'furniture & fixtures': '1111',
  'furniture':            '1111',
  'computers & it':       '1112',
  'it equipment':         '1112',
  'vehicles':             '1113',
  'land & building':      '1114',
  'building':             '1114',
};
const DEFAULT_ACCUM_DEP_CODE = '1101';

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
 * @param {{ purchase_cost, salvage_value, useful_life_years, category,
 *            depreciation_method, wdv_rate, purchase_date }} asset
 * @returns {Array<{ year, fy, opening, depreciation, closing, accumulated }>}
 */
function buildSchedule(asset) {
  const cost      = parseFloat(asset.purchase_cost || 0);
  const life      = parseFloat(asset.useful_life_years)
                    || USEFUL_LIFE[CATEGORY_TO_CLASS[(asset.category || '').toLowerCase()]]
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
 * Called by the monthly cron job (jobs/depreciation.cron.js).
 *
 * Assets that already have an `asset_depreciation_log` row for the current
 * financial year are skipped entirely for that year — that table is written
 * by the legacy annual "Run Depreciation" posting (assets.routes.js, retired
 * as a live posting path but its history stays authoritative for years it
 * already covered), so this avoids double-posting the same FY twice under
 * two different mechanisms. Once an asset rolls into a FY with no legacy
 * row, monthly posting picks it up automatically.
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
  const fyYear    = month >= 4 ? year : year - 1;
  const fyLabel   = `${fyYear}-${String(fyYear + 1).slice(-2)}`;

  const client = await pool.connect();
  let posted = 0, skipped = 0;
  const errors = [];

  try {
    await client.query('BEGIN');

    // Load all active, not-yet-fully-depreciated assets
    const { rows: assets } = await client.query(
      `SELECT * FROM fixed_assets
       WHERE company_id = $1 AND status = 'active' AND purchase_cost > 0
         AND current_book_value > salvage_value`,
      [companyId]
    );

    for (const asset of assets) {
      // Per-asset savepoint: one asset's failure must not poison the shared
      // transaction and silently roll back assets already posted this run.
      await client.query('SAVEPOINT sp_asset');
      try {
        // Already posted this calendar month?
        const { rows: [existingMonth] } = await client.query(
          `SELECT id FROM journal_entries
           WHERE reference_type = 'depreciation'
             AND reference_id   = $1
             AND to_char(entry_date, 'YYYY-MM') = $2
           LIMIT 1`,
          [asset.id, periodKey]
        );
        if (existingMonth) { skipped++; await client.query('RELEASE SAVEPOINT sp_asset'); continue; }

        // Already covered for this FY by the legacy annual mechanism?
        const { rows: [legacyFy] } = await client.query(
          `SELECT id FROM asset_depreciation_log WHERE asset_id = $1 AND financial_year = $2 LIMIT 1`,
          [asset.id, fyLabel]
        );
        if (legacyFy) { skipped++; await client.query('RELEASE SAVEPOINT sp_asset'); continue; }

        const schedule = buildSchedule(asset);
        const fyEntry  = schedule.find(s => s.fy === fyLabel);
        if (!fyEntry || fyEntry.depreciation <= 0) {
          skipped++;
          await client.query('RELEASE SAVEPOINT sp_asset');
          continue;
        }

        const monthlyDep = parseFloat((fyEntry.depreciation / 12).toFixed(2));
        const assetLabel = asset.name || asset.asset_code || String(asset.id);
        const accumCode  = ACCUM_DEP_CODE_BY_CATEGORY[(asset.category || '').toLowerCase()] || DEFAULT_ACCUM_DEP_CODE;

        const entryNumber = await journalRepo.getNextEntryNumber();
        const entry = await journalRepo.createEntry(client, {
          entry_number:   entryNumber,
          entry_date:     depDate.toISOString().split('T')[0],
          entry_type:     'Depreciation',
          reference_type: 'depreciation',
          reference_id:   asset.id,
          description:    `Depreciation — ${assetLabel} — ${periodKey}`,
        });

        // account_code is resolved against chart_of_accounts by journalRepo
        // itself — same resolution the (retired) annual route relied on.
        await journalRepo.createLine(client, {
          journal_entry_id: entry.id,
          account_code:     DEPRECIATION_EXPENSE_CODE,
          description:      `Depreciation expense — ${assetLabel}`,
          debit:             monthlyDep,
          credit:            0,
          company_id:        companyId,
        });
        await journalRepo.createLine(client, {
          journal_entry_id: entry.id,
          account_code:     accumCode,
          description:      `Accumulated depreciation — ${assetLabel}`,
          debit:             0,
          credit:            monthlyDep,
          company_id:        companyId,
        });
        await journalRepo.postEntry(client, entry.id);

        await client.query(
          `UPDATE fixed_assets
           SET accumulated_depreciation = COALESCE(accumulated_depreciation, 0) + $1,
               current_book_value       = current_book_value - $1,
               updated_at               = NOW()
           WHERE id = $2`,
          [monthlyDep, asset.id]
        );

        posted++;
        await client.query('RELEASE SAVEPOINT sp_asset');
      } catch (assetErr) {
        await client.query('ROLLBACK TO SAVEPOINT sp_asset');
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
