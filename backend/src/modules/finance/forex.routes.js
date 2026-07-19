import express from 'express';
import pool from '../../config/db.js';
import { requirePermission } from '../../middlewares/auth.middleware.js';
import { companyOf } from '../../shared/scope.js';

const router = express.Router();
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
router.post('/rates/fetch', async (req, res) => {
  const companyId = companyOf(req);
  try {
    const data = await fetchFromFrankfurter();
    const rateDate = data.date || new Date().toISOString().split('T')[0];
    const now = new Date();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let count = 0;
      for (const [code, inrPerUnit] of Object.entries(data.rates)) {
        // data.rates[code] = how many of that currency 1 INR buys
        // We want rate_vs_inr = how many INR 1 unit of that currency costs
        const rateVsInr = parseFloat((1 / inrPerUnit).toFixed(6));
        const name = CURRENCY_NAMES[code] || code;
        await client.query(`
          INSERT INTO forex_rates (company_id, currency_code, currency_name, rate_vs_inr, rate_date, source, fetched_at, is_active)
          VALUES ($1,$2,$3,$4,$5,'api',$6,true)
          ON CONFLICT (company_id, currency_code)
          DO UPDATE SET rate_vs_inr=$4, rate_date=$5, source='api', fetched_at=$6, updated_at=$6
        `, [companyId, code, name, rateVsInr, rateDate, now]);
        await client.query(`
          INSERT INTO forex_rate_history (company_id, currency_code, rate_vs_inr, rate_date, source)
          VALUES ($1,$2,$3,$4,'api')
          ON CONFLICT (company_id, currency_code, rate_date) DO UPDATE SET rate_vs_inr=$3
        `, [companyId, code, rateVsInr, rateDate]);
        count++;
      }
      await client.query('COMMIT');
      res.json({ message: `Rates updated — ${count} currencies refreshed`, last_updated: now.toISOString() });
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
router.post('/rates', async (req, res) => {
  const companyId = companyOf(req);
  const { from_currency, rate, rate_date } = req.body;
  if (!from_currency || !rate) return res.status(400).json({ error: 'from_currency and rate are required' });
  const code = from_currency.toUpperCase();
  const name = CURRENCY_NAMES[code] || code;
  const rateVal = parseFloat(rate);
  const dateVal = rate_date || new Date().toISOString().split('T')[0];
  try {
    await pool.query(`
      INSERT INTO forex_rates (company_id, currency_code, currency_name, rate_vs_inr, rate_date, source, fetched_at, is_active)
      VALUES ($1,$2,$3,$4,$5,'manual',NOW(),true)
      ON CONFLICT (company_id, currency_code)
      DO UPDATE SET rate_vs_inr=$4, rate_date=$5, source='manual', fetched_at=NOW(), updated_at=NOW()
    `, [companyId, code, name, rateVal, dateVal]);
    await pool.query(`
      INSERT INTO forex_rate_history (company_id, currency_code, rate_vs_inr, rate_date, source)
      VALUES ($1,$2,$3,$4,'manual')
      ON CONFLICT (company_id, currency_code, rate_date) DO UPDATE SET rate_vs_inr=$3
    `, [companyId, code, rateVal, dateVal]);
    res.status(201).json({ message: 'Rate saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
          AND status IN ('sent','overdue','partial')
        GROUP BY currency
      `, [companyId]);
      rows.forEach(r => { recByCcy[r.currency] = parseFloat(r.total); });
    } catch (_) {}

    // Try to get open foreign-currency payables
    let payByCcy = {};
    try {
      const { rows } = await pool.query(`
        SELECT currency, SUM(total_amount) as total
        FROM supplier_bills
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
          AND status IN ('pending','partial','approved')
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
router.post('/revalue', async (req, res) => {
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
        SELECT invoice_number AS reference, customer_name AS party,
               currency, total_amount AS foreign_amount,
               COALESCE(exchange_rate, 1) AS booked_rate
        FROM invoices
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
          AND status IN ('sent','overdue','partial')
      `, [companyId]);
      rows.forEach(r => details.push(buildRevalLine(r, rateMap)));
    } catch (_) {}

    // Bills
    try {
      const { rows } = await pool.query(`
        SELECT bill_number AS reference, supplier_name AS party,
               currency, total_amount AS foreign_amount,
               COALESCE(exchange_rate, 1) AS booked_rate
        FROM supplier_bills
        WHERE company_id = $1
          AND currency IS NOT NULL AND currency != 'INR'
          AND status IN ('pending','partial','approved')
      `, [companyId]);
      rows.forEach(r => details.push(buildRevalLine(r, rateMap)));
    } catch (_) {}

    const totalGain = details.filter(d => d.gl === 'gain').reduce((s, d) => s + d.difference, 0);
    const totalLoss = Math.abs(details.filter(d => d.gl === 'loss').reduce((s, d) => s + d.difference, 0));
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

function buildRevalLine(r, rateMap) {
  const bookedRate = parseFloat(r.booked_rate) || 1;
  const currentRate = rateMap[r.currency] || bookedRate;
  const foreignAmt = parseFloat(r.foreign_amount);
  const bookedInr = foreignAmt * bookedRate;
  const currentInr = foreignAmt * currentRate;
  const diff = currentInr - bookedInr;
  return {
    reference: r.reference,
    party: r.party,
    currency: r.currency,
    foreign_amount: foreignAmt,
    booked_rate: bookedRate,
    current_rate: currentRate,
    booked_inr: bookedInr,
    current_inr: currentInr,
    difference: diff,
    gl: diff >= 0 ? 'gain' : 'loss',
  };
}

// ── PUT /forex/revaluations/:id/post ─ post revaluation journal entries ────────
router.put('/revaluations/:id/post', async (req, res) => {
  const companyId = companyOf(req);
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE forex_revaluations SET status='posted'
       WHERE id=$1 AND company_id=$2 AND status='draft'
       RETURNING id, revaluation_date, status, total_gain, total_loss, net_pgl`,
      [id, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Revaluation not found or already posted' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
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
               customer_name AS party, currency, total_amount AS foreign_amount,
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
               supplier_name AS party, currency, total_amount AS foreign_amount,
               COALESCE(exchange_rate, 1) AS exchange_rate, bill_date AS transaction_date,
               status, created_at
        FROM supplier_bills
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
      `SELECT currency_code, rate_vs_inr FROM forex_rates WHERE company_id = $1 AND is_active = true`,
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
      rate_date: rows.find(r => r.currency_code === fromCode)?.rate_date || new Date().toISOString().split('T')[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
