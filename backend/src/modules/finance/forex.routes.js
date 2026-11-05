import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';
import journalRepo from './repositories/journal.repository.js';
import { captureBefore } from '../../middlewares/captureBefore.js';
import { FX_SOURCES, normCurrency } from './services/fxRate.service.js';

const router = express.Router();
const userIdOf = (req) => req.user?.userId ?? req.user?.id ?? null;
// The router-level requirePermission('finance','view') below is a floor, not a
// gate on writes: every mutating route must name its own action. Without one, a
// view-only finance role could overwrite exchange rates and run a revaluation. Audit logging records who did it; it does not authorise it.
router.use(requirePermission('finance', 'view'));

const CURRENCY_NAMES = {
  USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound', SGD: 'Singapore Dollar',
  JPY: 'Japanese Yen', CHF: 'Swiss Franc', CAD: 'Canadian Dollar',
  AUD: 'Australian Dollar', CNY: 'Chinese Yuan Renminbi', HKD: 'Hong Kong Dollar',
  NZD: 'New Zealand Dollar', SEK: 'Swedish Krona', NOK: 'Norwegian Krone',
  DKK: 'Danish Krone', MXN: 'Mexican Peso', BRL: 'Brazilian Real',
  ZAR: 'South African Rand', KRW: 'South Korean Won', TRY: 'Turkish Lira',
};

// Frankfurter supports ~33 currencies but not AED/MYR/THB — use this safe set
const TRACKED_CURRENCIES = 'USD,EUR,GBP,SGD,JPY,CHF,CAD,AUD,CNY,HKD,NZD,SEK';

async function fetchFromFrankfurter() {
  const url = `https://api.frankfurter.app/latest?from=INR&to=${TRACKED_CURRENCIES}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!resp.ok) throw new Error(`Frankfurter API returned ${resp.status}`);
  return resp.json();
}

// ── GET /forex/rates ──────────────────────────────────────────────────────────
router.get('/rates', async (req, res) => {
  const companyId = companyOf(req);
  try {
    const { rows } = await pool.query(
      `SELECT currency_code, currency_name, rate_vs_inr, rate_date, source, fetched_at
       FROM forex_rates
       WHERE company_id = $1 AND is_active = true
       ORDER BY currency_code`,
      [companyId]
    );
    const rates = rows.map(r => ({
      from_currency: r.currency_code,
      currency_name: r.currency_name,
      rate: parseFloat(r.rate_vs_inr),
      rate_date: r.rate_date,
      source: r.source,
      fetched_at: r.fetched_at,
    }));
    const lastUpdated = rows.reduce((latest, r) => {
      if (!r.fetched_at) return latest;
      return !latest || new Date(r.fetched_at) > new Date(latest) ? r.fetched_at : latest;
    }, null);
    res.json({ rates, last_updated: lastUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /forex/rates/fetch ─ fetch live rates from frankfurter.app ───────────
router.post('/rates/fetch', requirePermission('finance', 'edit'), async (req, res) => {
  const companyId = companyOf(req);
  try {
    const data = await fetchFromFrankfurter();
    const rateDate = data.date || new Date().toISOString().split('T')[0];
    const now = new Date();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let count = 0;
      let held  = 0;
      for (const [code, inrPerUnit] of Object.entries(data.rates)) {
        // data.rates[code] = how many of that currency 1 INR buys
        // We want rate_vs_inr = how many INR 1 unit of that currency costs
        const rateVsInr = parseFloat((1 / inrPerUnit).toFixed(6));
        const name = CURRENCY_NAMES[code] || code;
        // Same guard as the manual route below: the provider quotes the last
        // business day, so a Monday fetch must not walk a rate a treasury user
        // entered by hand for today back to Friday's number.
        const { rowCount } = await client.query(`
          INSERT INTO forex_rates (company_id, currency_code, currency_name, rate_vs_inr, rate_date, source, fetched_at, is_active)
          VALUES ($1,$2,$3,$4,$5,'api',$6,true)
          ON CONFLICT (company_id, currency_code)
          DO UPDATE SET rate_vs_inr=$4, rate_date=$5, source='api', fetched_at=$6, updated_at=$6
          WHERE EXCLUDED.rate_date >= forex_rates.rate_date
        `, [companyId, code, name, rateVsInr, rateDate, now]);
        // A fetched rate is a DRAFT until Finance approves it (§215), and it
        // never overwrites a rate Finance has already approved for that date.
        await client.query(`
          INSERT INTO forex_rate_history (company_id, currency_code, rate_vs_inr, rate_date, source, status, entered_by_user_id)
          VALUES ($1,$2,$3,$4,'api','draft',$5)
          ON CONFLICT (company_id, currency_code, rate_date)
          DO UPDATE SET rate_vs_inr=$3, source=EXCLUDED.source, entered_by_user_id=$5, updated_at=NOW(),
                        status='draft', approved_by_user_id=NULL, approved_at=NULL, review_note=NULL
          WHERE forex_rate_history.status <> 'approved'
        `, [companyId, code, rateVsInr, rateDate, userIdOf(req)]);
        // Count what actually moved, not what was attempted.
        if (rowCount > 0) count++;
        else held++;
      }
      await client.query('COMMIT');
      res.json({
        message: `Rates updated — ${count} currencies refreshed`
          + (held ? `; ${held} left as-is (a more recent rate is already on file)` : ''),
        last_updated: now.toISOString(),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(502).json({ error: `Could not fetch live rates: ${err.message}` });
  }
});

// ── POST /forex/rates ─ add / update manual rate ──────────────────────────────
router.post('/rates', requirePermission('finance', 'edit'), async (req, res) => {
  const companyId = companyOf(req);
  const { from_currency, rate, rate_date } = req.body;
  if (!from_currency || !rate) return res.status(400).json({ error: 'from_currency and rate are required' });
  const code = normCurrency(from_currency);
  if (!code || code === 'INR') return res.status(400).json({ error: 'from_currency must be a 3-letter ISO code other than INR' });
  const name = CURRENCY_NAMES[code] || code;
  const rateVal = parseFloat(rate);
  if (!Number.isFinite(rateVal) || rateVal <= 0) return res.status(400).json({ error: 'rate must be a positive number' });
  // Where the number came from. 'api' is reserved for the fetch route.
  const source = String(req.body.source || 'manual').toLowerCase();
  if (!FX_SOURCES.includes(source) || source === 'api') {
    return res.status(400).json({ error: `source must be one of ${FX_SOURCES.filter(s => s !== 'api').join(', ')}` });
  }
  // The DATABASE's date (IST), not toISOString()'s UTC one — between 00:00 and
  // 05:30 IST the old default stamped the rate with yesterday's date.
  const dateVal = rate_date || (await pool.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
  try {
    // forex_rates holds the CURRENT rate, one row per currency. The effective
    // date on the form is freely editable, so without the WHERE guard a
    // backdated correction overwrites today's rate with an older number:
    // USD 88.42@09-09 then 87.60@09-05 left the table saying 87.60 as of 5 Sep
    // while the history this route also writes still had 88.42 for the 9th —
    // the page contradicting its own sparkline, and every conversion stale.
    // The history table below is keyed by date and always takes the row, so a
    // backdated correction is still recorded, it just no longer becomes "now".
    const { rowCount } = await pool.query(`
      INSERT INTO forex_rates (company_id, currency_code, currency_name, rate_vs_inr, rate_date, source, fetched_at, is_active)
      VALUES ($1,$2,$3,$4,$5,'manual',NOW(),true)
      ON CONFLICT (company_id, currency_code)
      DO UPDATE SET rate_vs_inr=$4, rate_date=$5, source='manual', fetched_at=NOW(), updated_at=NOW()
      WHERE EXCLUDED.rate_date >= forex_rates.rate_date
    `, [companyId, code, name, rateVal, dateVal]);
    // Entered rates are DRAFTS. Re-entering a rate for a date that was already
    // approved replaces it and sends it back for approval — a corrected number
    // must not inherit the sign-off given to the old one.
    const { rows: [hist] } = await pool.query(`
      INSERT INTO forex_rate_history (company_id, currency_code, rate_vs_inr, rate_date, source, status, entered_by_user_id)
      VALUES ($1,$2,$3,$4,$5,'draft',$6)
      ON CONFLICT (company_id, currency_code, rate_date)
      DO UPDATE SET rate_vs_inr=$3, source=EXCLUDED.source, entered_by_user_id=$6, updated_at=NOW(),
                    status='draft', approved_by_user_id=NULL, approved_at=NULL, review_note=NULL
      RETURNING id, status
    `, [companyId, code, rateVal, dateVal, source, userIdOf(req)]);
    // Say which of the two happened. Answering "Rate saved" to a backdated post
    // that deliberately did not move the current rate is how the caller comes to
    // believe the headline number changed when it did not.
    res.status(201).json({
      message: (rowCount > 0
        ? 'Rate saved'
        : `Recorded in rate history for ${dateVal}. The current ${code} rate is more recent and was left unchanged.`)
        + ' It is a draft until another Finance approver approves it; comparisons do not use it until then.',
      current_rate_updated: rowCount > 0,
      history_id: hist?.id ?? null,
      status: hist?.status ?? 'draft',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rate approval (§215) ──────────────────────────────────────────────────────
// Comparisons (TCO, RFx cost scores, awards) use ONLY approved history rows.
// Approval is finance:approve, and the approver must not be the person who
// entered the rate. A rate whose enterer is unknown (rows that predate this
// workflow) can be approved by any approver; the approver is recorded.

// GET /forex/rate-history?status=draft|approved|rejected&currency=USD
router.get('/rate-history', async (req, res) => {
  const companyId = companyOf(req);
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !['draft', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be draft, approved or rejected' });
  }
  const currency = req.query.currency ? normCurrency(req.query.currency) : null;
  try {
    const { rows } = await pool.query(`
      SELECT h.id, h.currency_code, h.rate_vs_inr, h.rate_date::text AS rate_date, h.source, h.status,
             h.entered_by_user_id, eu.name AS entered_by_name,
             h.approved_by_user_id, au.name AS approved_by_name, h.approved_at, h.review_note,
             h.created_at, h.updated_at
        FROM forex_rate_history h
        LEFT JOIN users eu ON eu.id = h.entered_by_user_id
        LEFT JOIN users au ON au.id = h.approved_by_user_id
       WHERE h.company_id = $1
         AND ($2::text IS NULL OR h.status = $2)
         AND ($3::text IS NULL OR h.currency_code = $3)
       ORDER BY h.rate_date DESC, h.currency_code
       LIMIT 300`, [companyId, status, currency]);
    res.json({ data: rows.map(r => ({ ...r, rate_vs_inr: parseFloat(r.rate_vs_inr) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function review(req, res, decision) {
  const companyId = companyOf(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id must be an integer' });
  const userId = userIdOf(req);
  if (userId == null) return res.status(401).json({ error: 'No user identity on the request' });
  const note = req.body?.note ? String(req.body.note).trim() : null;
  if (decision === 'rejected' && !(note && note.length >= 5)) {
    return res.status(422).json({ error: 'A note of at least 5 characters is required to reject a rate.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `SELECT * FROM forex_rate_history WHERE id = $1 AND company_id = $2 FOR UPDATE`, [id, companyId]);
    if (!row) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Rate not found' }); }
    if (row.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This rate is already ${row.status}. Re-enter it to send a corrected rate for approval.`, code: 'NOT_DRAFT' });
    }
    if (row.entered_by_user_id != null && Number(row.entered_by_user_id) === Number(userId)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You entered this rate, so another Finance approver must review it.', code: 'SELF_APPROVAL' });
    }
    const { rows: [out] } = await client.query(
      `UPDATE forex_rate_history
          SET status = $2, approved_by_user_id = $3, approved_at = NOW(), review_note = $4, updated_at = NOW()
        WHERE id = $1
        RETURNING id, currency_code, rate_vs_inr, rate_date::text AS rate_date, source, status,
                  entered_by_user_id, approved_by_user_id, approved_at, review_note`,
      [id, decision, userId, note]);
    await client.query('COMMIT');
    res.json({ data: { ...out, rate_vs_inr: parseFloat(out.rate_vs_inr) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}

router.post('/rate-history/:id/approve', requirePermission('finance', 'approve'), (req, res) => review(req, res, 'approved'));
router.post('/rate-history/:id/reject',  requirePermission('finance', 'approve'), (req, res) => review(req, res, 'rejected'));

// ── GET /forex/rate-history/:currency ─ 30-day sparkline data ─────────────────
router.get('/rate-history/:currency', async (req, res) => {
  const companyId = companyOf(req);
  const currency = req.params.currency.toUpperCase();
  try {
    const { rows } = await pool.query(`
      SELECT rate_date, rate_vs_inr
      FROM forex_rate_history
      WHERE company_id = $1 AND currency_code = $2
        AND rate_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY rate_date ASC
    `, [companyId, currency]);
    res.json({ history: rows.map(r => ({ date: r.rate_date, rate: parseFloat(r.rate_vs_inr) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /forex/exposure ─ open foreign-currency invoices & bills ───────────────
router.get('/exposure', async (req, res) => {
  const companyId = companyOf(req);
  try {
    // Fetch current rates for INR-value calculations
    const { rows: rateRows } = await pool.query(
      `SELECT currency_code, rate_vs_inr FROM forex_rates WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    const rateMap = {};
    rateRows.forEach(r => { rateMap[r.currency_code] = parseFloat(r.rate_vs_inr); });

    // Try to get open foreign-currency receivables
    let recByCcy = {};
    try {
      const { rows } = await pool.query(`
        SELECT currency, SUM(total_amount) as total
        FROM invoices
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
          AND LOWER(status) NOT IN ('paid','cancelled')
        GROUP BY currency
      `, [companyId]);
      rows.forEach(r => { recByCcy[r.currency] = parseFloat(r.total); });
    } catch (_) {}

    // Try to get open foreign-currency payables
    let payByCcy = {};
    try {
      const { rows } = await pool.query(`
        SELECT currency, SUM(total_amount) as total
        FROM bills
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
          AND LOWER(status) NOT IN ('paid','cancelled')
        GROUP BY currency
      `, [companyId]);
      rows.forEach(r => { payByCcy[r.currency] = parseFloat(r.total); });
    } catch (_) {}

    const allCurrencies = [...new Set([...Object.keys(recByCcy), ...Object.keys(payByCcy)])];
    const exposure = allCurrencies.map(ccy => {
      const rate = rateMap[ccy] || 1;
      const rec = recByCcy[ccy] || 0;
      const pay = payByCcy[ccy] || 0;
      const net = rec - pay;
      const netInr = net * rate;
      return {
        currency: ccy,
        current_rate: rate,
        total_receivable_foreign: rec,
        total_payable_foreign: pay,
        net_exposure_foreign: net,
        net_exposure_inr: netInr,
        impact_1pct: Math.abs(netInr * 0.01),
        impact_5pct: Math.abs(netInr * 0.05),
        impact_10pct: Math.abs(netInr * 0.10),
      };
    });
    res.json(exposure);
  } catch (err) {
    res.json([]);
  }
});

// ── GET /forex/revaluations ─ revaluation history ─────────────────────────────
router.get('/revaluations', async (req, res) => {
  const companyId = companyOf(req);
  try {
    const { rows } = await pool.query(
      `SELECT id, revaluation_date, period, status, total_gain, total_loss, net_pgl
       FROM forex_revaluations
       WHERE company_id = $1
       ORDER BY revaluation_date DESC
       LIMIT 50`,
      [companyId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /forex/revalue ─ compute revaluation preview ─────────────────────────
router.post('/revalue', requirePermission('finance', 'add'), async (req, res) => {
  const companyId = companyOf(req);
  const { revaluation_date } = req.body;
  if (!revaluation_date) return res.status(400).json({ error: 'revaluation_date is required' });

  try {
    const { rows: rateRows } = await pool.query(
      `SELECT currency_code, rate_vs_inr FROM forex_rates WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    const rateMap = {};
    rateRows.forEach(r => { rateMap[r.currency_code] = parseFloat(r.rate_vs_inr); });

    let details = [];

    // Invoices
    try {
      const { rows } = await pool.query(`
        SELECT invoice_number AS reference, party_name AS party,
               currency, total_amount AS foreign_amount,
               COALESCE(exchange_rate, 1) AS booked_rate
        FROM invoices
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
          AND LOWER(status) NOT IN ('paid','cancelled')
      `, [companyId]);
      rows.forEach(r => details.push(buildRevalLine(r, rateMap, 'receivable')));
    } catch (_) {}

    // Bills
    try {
      const { rows } = await pool.query(`
        SELECT bill_number AS reference, party_name AS party,
               currency, total_amount AS foreign_amount,
               COALESCE(exchange_rate, 1) AS booked_rate
        FROM bills
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
          AND LOWER(status) NOT IN ('paid','cancelled')
      `, [companyId]);
      rows.forEach(r => details.push(buildRevalLine(r, rateMap, 'payable')));
    } catch (_) {}

    // Sum MAGNITUDES per corrected label. Summing signed differences and then
    // taking Math.abs() let a favourable and an unfavourable line inside the
    // same bucket cancel each other before the total was taken.
    const totalGain = details.filter(d => d.gl === 'gain')
                             .reduce((s, d) => s + Math.abs(d.difference), 0);
    const totalLoss = details.filter(d => d.gl === 'loss')
                             .reduce((s, d) => s + Math.abs(d.difference), 0);
    const netPgl = totalGain - totalLoss;

    const { rows: [reval] } = await pool.query(`
      INSERT INTO forex_revaluations
        (company_id, revaluation_date, period, status, total_gain, total_loss, net_pgl, details, created_by)
      VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8)
      RETURNING id, revaluation_date, period, status
    `, [
      companyId, revaluation_date, revaluation_date.slice(0, 7),
      totalGain, totalLoss, netPgl, JSON.stringify(details),
      req.user?.userId ?? req.user?.id,
    ]);

    res.json({ revaluation: reval, details, summary: { totalGain, totalLoss, netPgl } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @param {'receivable'|'payable'} source  which side of the book this line is.
 *
 * The gain/loss label USED TO BE `diff >= 0 ? 'gain' : 'loss'` for every line,
 * which is only right for receivables. A payable is an obligation: when the
 * rate moves so that it now costs MORE rupees to settle, that is a LOSS, not a
 * gain. Every bill was therefore classified backwards, and because total_gain
 * and total_loss are derived from this label, both totals and net_pgl were
 * wrong for any company with foreign-currency payables.
 */
function buildRevalLine(r, rateMap, source) {
  const bookedRate = parseFloat(r.booked_rate) || 1;
  const currentRate = rateMap[r.currency] || bookedRate;
  const foreignAmt = parseFloat(r.foreign_amount);
  const bookedInr = foreignAmt * bookedRate;
  const currentInr = foreignAmt * currentRate;
  const diff = currentInr - bookedInr;
  // Receivable: worth more rupees  -> gain.  Payable: costs more rupees -> loss.
  const favourable = source === 'payable' ? diff <= 0 : diff >= 0;
  return {
    reference: r.reference,
    party: r.party,
    currency: r.currency,
    source,
    foreign_amount: foreignAmt,
    booked_rate: bookedRate,
    current_rate: currentRate,
    booked_inr: bookedInr,
    current_inr: currentInr,
    difference: diff,
    gl: favourable ? 'gain' : 'loss',
  };
}

// ── PUT /forex/revaluations/:id/post ─ post revaluation journal entries ────────
// Unrealised exchange differences are POSTED, not just flagged.
//
// This handler used to run a single `UPDATE forex_revaluations SET status='posted'`
// and nothing else — no journal entry of any kind. The gain or loss was
// computed, shown on screen, marked posted, and never reached the ledger, so
// the P&L and balance sheet carried none of it.
//
// The entry it writes, from the per-line details captured at revaluation time:
//
//   receivables worth more rupees  DR 1010 Accounts Receivable / CR 4010 FX Gain
//   receivables worth fewer        DR 5055 FX Loss             / CR 1010
//   payables costing more rupees   DR 5055 FX Loss             / CR 2001 Accounts Payable
//   payables costing fewer         DR 2001                     / CR 4010 FX Gain
//
// Debits equal credits by construction. It goes through journalRepo, so the
// posting guards (balanced, resolvable active accounts, unlocked and open
// period) apply here exactly as they do to an invoice.
const FX_GAIN = '4010';
const FX_LOSS = '5055';
const FX_AR   = '1010';
const FX_AP   = '2001';

router.put('/revaluations/:id/post', requirePermission('finance', 'approve'), captureBefore('forex_revaluations'), async (req, res) => {
  const companyId = companyOf(req);
  const userId = req.user?.userId ?? req.user?.id ?? null;
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row so two approvers cannot both post the same revaluation.
    const { rows: revRows } = await client.query(
      `SELECT id, revaluation_date, status, details, journal_entry_id
         FROM forex_revaluations
        WHERE id = $1 AND company_id = $2
        FOR UPDATE`,
      [id, companyId]
    );
    if (!revRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Revaluation not found' });
    }
    const reval = revRows[0];
    if (reval.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `Revaluation is already '${reval.status}'` +
               (reval.journal_entry_id ? ` (journal ${reval.journal_entry_id})` : ''),
        code: 'ALREADY_POSTED',
      });
    }

    const details = Array.isArray(reval.details) ? reval.details : JSON.parse(reval.details || '[]');

    // Net movement per side. A line's `difference` is currentInr - bookedInr.
    let arDelta = 0, apDelta = 0;
    for (const d of details) {
      const diff = parseFloat(d.difference || 0);
      if (!Number.isFinite(diff) || diff === 0) continue;
      if (d.source === 'payable') apDelta += diff; else arDelta += diff;
    }
    const round2 = (v) => Math.round(v * 100) / 100;
    arDelta = round2(arDelta);
    apDelta = round2(apDelta);

    if (arDelta === 0 && apDelta === 0) {
      // Nothing to post. Recorded as posted so the workflow completes, with no
      // journal — rather than writing a zero-value entry the guards reject.
      const { rows: [updated] } = await client.query(
        `UPDATE forex_revaluations
            SET status='posted', posted_at=NOW(), posted_by=$2
          WHERE id=$1 RETURNING id, revaluation_date, status, total_gain, total_loss, net_pgl, journal_entry_id`,
        [id, userId]
      );
      await client.query('COMMIT');
      return res.json({ ...updated, journal: null, note: 'No exchange difference to post.' });
    }

    const lines = [];
    const push = (code, debit, credit, narration) =>
      lines.push({ account_code: code, debit: round2(debit), credit: round2(credit), description: narration });

    if (arDelta > 0)      { push(FX_AR, arDelta, 0, 'Unrealised FX gain on receivables');
                            push(FX_GAIN, 0, arDelta, 'Unrealised FX gain on receivables'); }
    else if (arDelta < 0) { push(FX_LOSS, -arDelta, 0, 'Unrealised FX loss on receivables');
                            push(FX_AR, 0, -arDelta, 'Unrealised FX loss on receivables'); }

    if (apDelta > 0)      { push(FX_LOSS, apDelta, 0, 'Unrealised FX loss on payables');
                            push(FX_AP, 0, apDelta, 'Unrealised FX loss on payables'); }
    else if (apDelta < 0) { push(FX_AP, -apDelta, 0, 'Unrealised FX gain on payables');
                            push(FX_GAIN, 0, -apDelta, 'Unrealised FX gain on payables'); }

    const entryNumber = await journalRepo.getNextEntryNumber(client);
    const entry = await journalRepo.createEntry(client, {
      entry_number:   entryNumber,
      entry_date:     reval.revaluation_date,
      entry_type:     'ForexRevaluation',
      reference_type: 'forex_revaluation',
      reference_id:   reval.id,
      description:    `Foreign exchange revaluation ${String(reval.revaluation_date).slice(0, 10)}`,
      created_by:     userId,
      company_id:     companyId,
    });

    for (const l of lines) {
      await journalRepo.createLine(client, { journal_entry_id: entry.id, ...l });
    }
    await journalRepo.postEntry(client, entry.id);

    const { rows: [updated] } = await client.query(
      `UPDATE forex_revaluations
          SET status='posted', posted_at=NOW(), posted_by=$2, journal_entry_id=$3
        WHERE id=$1 RETURNING id, revaluation_date, status, total_gain, total_loss, net_pgl, journal_entry_id`,
      [id, userId, entry.id]
    );

    await client.query('COMMIT');
    res.json({ ...updated, journal: { id: entry.id, entry_number: entryNumber, lines } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PUT /forex/revaluations/:id/post]', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  } finally {
    client.release();
  }
});

// ── GET /forex/transactions ─ all foreign-currency transactions ───────────────
router.get('/transactions', async (req, res) => {
  const companyId = companyOf(req);
  try {
    const rows = [];

    try {
      const { rows: invRows } = await pool.query(`
        SELECT 'invoice' AS type, id, invoice_number AS reference,
               party_name AS party, currency, total_amount AS foreign_amount,
               COALESCE(exchange_rate, 1) AS exchange_rate, invoice_date AS transaction_date,
               status, created_at
        FROM invoices
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
        ORDER BY invoice_date DESC
        LIMIT 200
      `, [companyId]);
      rows.push(...invRows);
    } catch (_) {}

    try {
      const { rows: billRows } = await pool.query(`
        SELECT 'bill' AS type, id, bill_number AS reference,
               party_name AS party, currency, total_amount AS foreign_amount,
               COALESCE(exchange_rate, 1) AS exchange_rate, bill_date AS transaction_date,
               status, created_at
        FROM bills
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
        ORDER BY bill_date DESC
        LIMIT 200
      `, [companyId]);
      rows.push(...billRows);
    } catch (_) {}

    rows.sort((a, b) => new Date(b.transaction_date) - new Date(a.transaction_date));
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /forex/convert ─ currency conversion ──────────────────────────────────
router.get('/convert', async (req, res) => {
  const companyId = companyOf(req);
  const { amount, from, to } = req.query;
  if (!amount || !from || !to) return res.status(400).json({ error: 'amount, from, and to are required' });

  try {
    const { rows } = await pool.query(
      // rate_date is SELECTed because the response reports it. It used to be
      // absent from this list while the handler still read `r.rate_date`, so the
      // lookup was always undefined and the `||` fallback stamped TODAY on every
      // conversion — the page printed "as of 09 Sep" over a rate dated the 5th.
      // A field the caller is shown has to come from the row.
      `SELECT currency_code, rate_vs_inr, rate_date FROM forex_rates WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    const rateMap = { INR: 1 };
    rows.forEach(r => { rateMap[r.currency_code] = parseFloat(r.rate_vs_inr); });

    const fromCode = from.toUpperCase();
    const toCode = to.toUpperCase();
    const fromRate = rateMap[fromCode];
    const toRate = rateMap[toCode];

    if (fromRate === undefined) return res.status(400).json({ error: `Rate not available for ${fromCode}` });
    if (toRate === undefined) return res.status(400).json({ error: `Rate not available for ${toCode}` });

    const inrAmount = parseFloat(amount) * fromRate;
    const convertedAmount = inrAmount / toRate;
    const effectiveRate = fromRate / toRate;

    res.json({
      converted_amount: convertedAmount.toFixed(2),
      rate: effectiveRate.toFixed(4),
      from: fromCode,
      to: toCode,
      amount: parseFloat(amount),
      // null, never today's date, when the source currency is INR: the base has
      // no forex_rates row and therefore no rate date to report. The UI already
      // guards this field on truthiness and simply drops the "as of" line.
      rate_date: rows.find(r => r.currency_code === fromCode)?.rate_date ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
