/**
 * fxRate.service.js — the ONLY place a comparison gets an exchange rate.
 * See MODULE_FEATURE_CONNECTION_MANUAL.md §215.
 *
 * Rules (each one is a way a cost comparison has lied before):
 *   - Only APPROVED rows of forex_rate_history count. A draft — including an
 *     API fetch nobody reviewed — is not a rate a buyer can defend an award on.
 *   - The latest approved rate ON OR BEFORE the comparison date, never a later
 *     one (that would be hindsight) and never the forex_rates "current" row,
 *     which takes unreviewed fetches.
 *   - Older than the company's tco_fx_max_age_days → stale → not used. There is
 *     no "use the last one we had" fallback: the quote is shown as needing a
 *     rate and drops out of the ranking.
 *   - Rates are stored as INR per unit (rate_vs_inr). A non-INR base currency is
 *     handled as a cross rate through INR, which needs an approved, fresh rate
 *     for the base currency too; the result says it is a cross rate.
 *   - A quote-specific override (rfq_quotes.fx_rate_override, with a reason)
 *     beats the table, and says so.
 *
 * Every resolution carries its provenance (row id, date, source, approver) so
 * the TCO breakdown — and the frozen award snapshot — can show it.
 */
import pool from '../../../config/db.js';

export const FX_SOURCES = Object.freeze(['api', 'manual', 'rbi', 'bank', 'finance_approved']);
const INR = 'INR';

const ymd = (d) => {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  // pg returns DATE as a local-midnight Date (project_pg_date_parser_fix);
  // format it in local time, never toISOString(), which shifts IST back a day.
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export const normCurrency = (c) => {
  const s = c == null ? '' : String(c).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
};

/**
 * resolveFxRates(companyId, currencies, { baseCurrency, asOf, maxAgeDays, db })
 *
 * Returns Map<currency, resolution>. A resolution is either
 *   { ok: true,  rate, rate_date, source, rate_id, approved_by_user_id, approved_at, method }
 *   { ok: false, reason: 'no_approved_rate' | 'stale' | 'base_rate_unavailable',
 *     message, latest_rate_date? }
 * `rate` converts ONE unit of the currency into the base currency.
 */
export async function resolveFxRates(companyId, currencies, {
  baseCurrency = INR, asOf = null, maxAgeDays = 30, db = pool,
} = {}) {
  const base = normCurrency(baseCurrency) || INR;
  const wanted = [...new Set((currencies || []).map(normCurrency).filter(c => c && c !== base))];
  const out = new Map();
  if (!wanted.length) return out;
  if (companyId == null) {
    // No tenant, no rates: a comparison without a company must not borrow one.
    for (const c of wanted) out.set(c, { ok: false, reason: 'no_approved_rate', message: 'No company scope to read approved rates from.' });
    return out;
  }

  const lookup = [...new Set([...wanted, ...(base !== INR ? [base] : [])])].filter(c => c !== INR);
  const { rows } = await db.query(
    `SELECT DISTINCT ON (currency_code)
            id, currency_code, rate_vs_inr, rate_date, source, approved_by_user_id, approved_at,
            COALESCE($3::date, CURRENT_DATE)::text AS as_of
       FROM forex_rate_history
      WHERE company_id = $1 AND currency_code = ANY($2::text[])
        AND status = 'approved'
        AND rate_date <= COALESCE($3::date, CURRENT_DATE)
      ORDER BY currency_code, rate_date DESC`,
    [companyId, lookup, asOf]
  );
  // as_of comes from the DB so "today" is the database's (IST) date, not UTC's.
  const asOfDate = rows[0]?.as_of ?? (asOf || (await db.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d);

  const inr = new Map();
  for (const r of rows) {
    const rateDate = ymd(r.rate_date);
    const age = daysBetween(rateDate, asOfDate);
    inr.set(r.currency_code, age > maxAgeDays
      ? { ok: false, reason: 'stale', latest_rate_date: rateDate,
          message: `Latest approved ${r.currency_code} rate is dated ${rateDate}, ${age} days before ${asOfDate} (limit ${maxAgeDays}).` }
      : { ok: true, inr_rate: parseFloat(r.rate_vs_inr), rate_date: rateDate, source: r.source,
          rate_id: r.id, approved_by_user_id: r.approved_by_user_id, approved_at: r.approved_at });
  }
  const missing = (c) => ({ ok: false, reason: 'no_approved_rate',
    message: `No approved ${c} rate on or before ${asOfDate}. Finance must approve one under Forex Management.` });

  for (const c of wanted) {
    const from = c === INR ? { ok: true, inr_rate: 1 } : (inr.get(c) || missing(c));
    if (!from.ok) { out.set(c, from); continue; }
    if (base === INR) {
      out.set(c, { ok: true, rate: from.inr_rate, rate_date: from.rate_date, source: from.source,
        rate_id: from.rate_id, approved_by_user_id: from.approved_by_user_id, approved_at: from.approved_at,
        method: 'approved_rate', as_of: asOfDate });
      continue;
    }
    const to = inr.get(base) || missing(base);
    if (!to.ok) {
      out.set(c, { ok: false, reason: 'base_rate_unavailable',
        message: `Base currency ${base} is converted through INR and its own approved rate is unusable: ${to.message}` });
      continue;
    }
    out.set(c, { ok: true, rate: from.inr_rate / to.inr_rate, rate_date: [from.rate_date, to.rate_date].filter(Boolean).sort()[0] ?? null,
      source: `cross via INR (${from.source ?? 'INR'} / ${to.source})`, rate_id: from.rate_id ?? null, base_rate_id: to.rate_id,
      approved_by_user_id: from.approved_by_user_id ?? to.approved_by_user_id, approved_at: from.approved_at ?? to.approved_at,
      method: 'cross_rate', as_of: asOfDate });
  }
  return out;
}

/**
 * Engine fields for one priced option. `override` is a quote's documented
 * override ({ rate, reason, by_user_id, at }) and beats the table.
 * Returns { currency, fx_rate?, fx_rate_source?, fx_meta?, fx_unavailable? }.
 */
export function fxFieldsFor(currency, resolved, baseCurrency, override = null) {
  const c = normCurrency(currency);
  const base = normCurrency(baseCurrency) || INR;
  if (!c || c === base) return { currency: c };
  if (override && Number(override.rate) > 0) {
    return {
      currency: c, fx_rate: Number(override.rate),
      fx_rate_source: `quote override: ${override.reason}`,
      fx_meta: { method: 'quote_override', reason: override.reason,
                 set_by_user_id: override.by_user_id ?? null, set_at: override.at ?? null },
    };
  }
  const r = resolved?.get(c);
  if (!r || !r.ok) {
    return { currency: c, fx_unavailable: r ? { reason: r.reason, message: r.message, latest_rate_date: r.latest_rate_date ?? null }
                                            : { reason: 'no_approved_rate', message: `No approved ${c} rate.` } };
  }
  return {
    currency: c, fx_rate: r.rate,
    fx_rate_source: `${r.source}, approved rate dated ${r.rate_date}`,
    fx_meta: { method: r.method, rate_id: r.rate_id, base_rate_id: r.base_rate_id ?? null,
               rate_date: r.rate_date, source: r.source, approved_by_user_id: r.approved_by_user_id,
               approved_at: r.approved_at, as_of: r.as_of },
  };
}

export default { resolveFxRates, fxFieldsFor, normCurrency, FX_SOURCES };
