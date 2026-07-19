import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import {
  LineChart, Line, ResponsiveContainer,
} from 'recharts';

const fmt = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const fmtFx = (n, decimals = 4) => parseFloat(n || 0).toFixed(decimals);
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '';

const tabStyle = (active) => ({
  padding: '8px 20px', border: 'none', background: active ? '#6B3FDB' : 'transparent',
  color: active ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8,
  fontWeight: active ? 600 : 400, fontSize: 14, transition: 'all 0.2s'
});
const cardStyle = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 };
const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', background: '#fafafa', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 16px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };

// Inline SVG sparkline — 30-day trend
function Sparkline({ data }) {
  if (!data || data.length < 2) return <span style={{ fontSize: 11, color: '#9ca3af' }}>—</span>;
  const rates = data.map(d => d.rate);
  const max = Math.max(...rates);
  const min = Math.min(...rates);
  const range = max - min || 1;
  const pts = rates.map((v, i) =>
    `${(i / (rates.length - 1)) * 60},${20 - ((v - min) / range) * 18}`
  ).join(' ');
  const color = rates[rates.length - 1] >= rates[0] ? '#16a34a' : '#dc2626';
  return (
    <svg width="60" height="20" viewBox="0 0 60 20">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function ForexManagement() {
  const [tab, setTab] = useState(0);
  const [rates, setRates] = useState([]);
  const [exposure, setExposure] = useState([]);
  const [revaluations, setRevaluations] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [fetchingLive, setFetchingLive] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [showAddRate, setShowAddRate] = useState(false);
  const [rateForm, setRateForm] = useState({ from_currency: 'USD', to_currency: 'INR', rate: '', rate_date: new Date().toISOString().split('T')[0] });
  const [historyData, setHistoryData] = useState({});
  const [revalRunning, setRevalRunning] = useState(false);
  const [revalPreview, setRevalPreview] = useState(null);
  const [revalDate, setRevalDate] = useState(new Date().toISOString().split('T')[0]);
  const [convertForm, setConvertForm] = useState({ amount: '', from: 'USD', to: 'INR', result: null });

  // true if lastUpdated is more than 24 hours ago
  const isStale = lastUpdated && (Date.now() - new Date(lastUpdated).getTime()) > 24 * 60 * 60 * 1000;

  const loadRates = useCallback(async () => {
    const [r1, r2, r3] = await Promise.allSettled([
      api.get('/forex/rates'),
      api.get('/forex/exposure'),
      api.get('/forex/revaluations'),
    ]);
    if (r1.status === 'fulfilled') {
      const d = r1.value.data;
      setRates(d?.rates || (Array.isArray(d) ? d : []));
      if (d?.last_updated) setLastUpdated(d.last_updated);
    }
    setExposure(r2.status === 'fulfilled' ? (r2.value.data || []) : []);
    setRevaluations(r3.status === 'fulfilled' ? (r3.value.data || []) : []);
  }, []);

  useEffect(() => { loadRates(); }, [loadRates]);

  const fetchLiveRates = async () => {
    setFetchingLive(true);
    setFetchError(null);
    try {
      const res = await api.post('/forex/rates/fetch');
      setLastUpdated(res.data.last_updated);
      await loadRates();
    } catch (err) {
      setFetchError(err.response?.data?.error || 'Could not fetch live rates. Try again.');
    } finally {
      setFetchingLive(false);
    }
  };

  const addManualRate = async () => {
    try {
      await api.post('/forex/rates', rateForm);
      setShowAddRate(false);
      setRateForm({ from_currency: 'USD', to_currency: 'INR', rate: '', rate_date: new Date().toISOString().split('T')[0] });
      loadRates();
    } catch (_) {}
  };

  const loadHistory = async (currency) => {
    if (historyData[currency] !== undefined) return;
    // Optimistically set empty so we don't re-fetch on every hover
    setHistoryData(p => ({ ...p, [currency]: [] }));
    try {
      const res = await api.get(`/forex/rate-history/${currency}`);
      setHistoryData(p => ({ ...p, [currency]: res.data.history || [] }));
    } catch (_) {}
  };

  const runRevaluation = async () => {
    setRevalRunning(true);
    try {
      const res = await api.post('/forex/revalue', { revaluation_date: revalDate });
      setRevalPreview(res.data);
    } catch (_) {
      setRevalPreview(null);
    } finally { setRevalRunning(false); }
  };

  const postRevaluation = async (id) => {
    try {
      await api.put(`/forex/revaluations/${id}/post`);
      setRevalPreview(null);
      loadRates();
    } catch (_) {}
  };

  const doConvert = async () => {
    if (!convertForm.amount) return;
    try {
      const res = await api.get('/forex/convert', { params: { amount: convertForm.amount, from: convertForm.from, to: convertForm.to } });
      setConvertForm(p => ({ ...p, result: res.data }));
    } catch (err) {
      const errMsg = err.response?.data?.error;
      if (errMsg?.includes('Rate not available')) {
        setConvertForm(p => ({ ...p, result: { error: errMsg } }));
      } else {
        // Local fallback using rates already in state
        const rateMap = { INR: 1 };
        rates.forEach(r => { rateMap[r.from_currency] = r.rate; });
        const fromRate = rateMap[convertForm.from];
        const toRate = rateMap[convertForm.to];
        if (fromRate && toRate) {
          const converted = (parseFloat(convertForm.amount) * fromRate) / toRate;
          const effRate = fromRate / toRate;
          setConvertForm(p => ({ ...p, result: { converted_amount: converted.toFixed(2), rate: effRate.toFixed(4), from: p.from, to: p.to, amount: parseFloat(p.amount) } }));
        }
      }
    }
  };

  const swapCurrencies = () => {
    setConvertForm(p => ({ ...p, from: p.to, to: p.from, result: null }));
  };

  const allCurrencies = ['INR', ...rates.map(r => r.from_currency).filter(c => c !== 'INR')];

  return (
    <div style={{ padding: '24px', background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111827', margin: 0 }}>Forex Management</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Multi-currency exchange rates, exposure &amp; revaluation</p>
      </div>

      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 16, width: 'fit-content' }}>
        {['Exchange Rates', 'Forex Exposure', 'Revaluation'].map((t, i) => (
          <button key={i} style={tabStyle(tab === i)} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>

      {/* Staleness warning banner */}
      {isStale && (
        <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          <span style={{ fontSize: 16 }}>⚠</span>
          <span style={{ color: '#92400e' }}>
            Exchange rates may be outdated — last updated {fmtDate(lastUpdated)}.
          </span>
          <button onClick={fetchLiveRates} disabled={fetchingLive}
            style={{ marginLeft: 'auto', padding: '4px 12px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
            {fetchingLive ? 'Fetching…' : 'Fetch Live Rates'}
          </button>
        </div>
      )}

      {fetchError && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, color: '#991b1b' }}>
          {fetchError}
        </div>
      )}

      {/* ── Tab 0: Exchange Rates ── */}
      {tab === 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={fetchLiveRates} disabled={fetchingLive}
                style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: fetchingLive ? 0.7 : 1 }}>
                {fetchingLive ? '⟳ Fetching…' : '⟳ Fetch Live Rates'}
              </button>
              <button onClick={() => setShowAddRate(v => !v)}
                style={{ padding: '8px 16px', background: '#fff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                + Add Manual Rate
              </button>
            </div>
            {lastUpdated && !isStale && (
              <span style={{ fontSize: 12, color: '#6b7280' }}>Last updated: {fmtDate(lastUpdated)}</span>
            )}
          </div>

          {showAddRate && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#111827' }}>Add Manual Rate</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                {[
                  { label: 'From Currency', key: 'from_currency', type: 'text', placeholder: 'USD' },
                  { label: 'To Currency', key: 'to_currency', type: 'text', placeholder: 'INR', disabled: true },
                  { label: 'Rate (1 unit = ₹)', key: 'rate', type: 'number', placeholder: '83.45' },
                  { label: 'Effective Date', key: 'rate_date', type: 'date' },
                ].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
                    <input type={f.type} value={rateForm[f.key]} placeholder={f.placeholder}
                      disabled={f.disabled}
                      onChange={e => setRateForm(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', background: f.disabled ? '#f9f9f9' : '#fff' }} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={addManualRate} disabled={!rateForm.from_currency || !rateForm.rate}
                  style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                  Save Rate
                </button>
                <button onClick={() => setShowAddRate(false)}
                  style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Currency', 'Name', 'Rate (per 1 unit = ₹)', 'Date', 'Source', '30-Day Trend'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rates.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: '48px 16px', textAlign: 'center', color: '#9ca3af' }}>
                      <div style={{ fontSize: 36, marginBottom: 8 }}>💱</div>
                      <div style={{ fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>No exchange rates yet</div>
                      <div style={{ fontSize: 13 }}>Click <strong>Fetch Live Rates</strong> to load rates from frankfurter.app (free, no API key required)</div>
                    </td>
                  </tr>
                ) : rates.map((r, i) => {
                  const isRateStale = r.source === 'manual'
                    ? (Date.now() - new Date(r.rate_date).getTime()) > 7 * 24 * 60 * 60 * 1000
                    : (Date.now() - new Date(r.fetched_at || r.rate_date).getTime()) > 24 * 60 * 60 * 1000;
                  return (
                    <tr key={i} onMouseEnter={() => loadHistory(r.from_currency)}
                      style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 700, color: '#6B3FDB', fontSize: 14 }}>{r.from_currency}</span>
                      </td>
                      <td style={tdStyle}>{r.currency_name}</td>
                      <td style={{ ...tdStyle, fontWeight: 600, fontSize: 15 }}>
                        ₹{fmtFx(r.rate, 4)}
                        {isRateStale && (
                          <span title={`Last updated ${fmtDate(r.fetched_at || r.rate_date)}`}
                            style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 4, fontSize: 10, background: '#fef3c7', color: '#92400e' }}>
                            ⚠ Stale
                          </span>
                        )}
                      </td>
                      <td style={tdStyle}>{r.rate_date}</td>
                      <td style={tdStyle}>
                        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: r.source === 'api' ? '#d1fae5' : '#f0ebff', color: r.source === 'api' ? '#065f46' : '#6B3FDB' }}>
                          {r.source}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, width: 80, padding: '6px 16px' }}>
                        <Sparkline data={historyData[r.from_currency]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Currency Converter */}
          <div style={{ ...cardStyle, padding: 20 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#111827' }}>Currency Converter</h3>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Amount</label>
                <input type="number" value={convertForm.amount}
                  onChange={e => setConvertForm(p => ({ ...p, amount: e.target.value, result: null }))}
                  placeholder="10000"
                  style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, width: 120 }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>From</label>
                <select value={convertForm.from}
                  onChange={e => setConvertForm(p => ({ ...p, from: e.target.value, result: null }))}
                  style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                  {allCurrencies.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <button onClick={swapCurrencies} title="Swap currencies"
                style={{ padding: '8px 10px', background: '#f0ebff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontSize: 16, marginBottom: 0, lineHeight: 1 }}>
                ⇄
              </button>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>To</label>
                <select value={convertForm.to}
                  onChange={e => setConvertForm(p => ({ ...p, to: e.target.value, result: null }))}
                  style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                  {allCurrencies.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <button onClick={doConvert}
                disabled={rates.length === 0 || convertForm.from === convertForm.to}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: (rates.length === 0 || convertForm.from === convertForm.to) ? 0.5 : 1 }}>
                Convert
              </button>
            </div>

            {convertForm.from === convertForm.to && (
              <div style={{ marginTop: 12, fontSize: 13, color: '#9ca3af' }}>
                Select different currencies to convert.
              </div>
            )}

            {convertForm.result && !convertForm.result.error && (
              <div style={{ marginTop: 16, padding: '12px 16px', background: '#f0ebff', borderRadius: 8 }}>
                <span style={{ fontWeight: 700, color: '#6B3FDB', fontSize: 20 }}>
                  {parseFloat(convertForm.amount).toLocaleString('en-IN')} {convertForm.from} = {convertForm.to === 'INR' ? '₹' : ''}{parseFloat(convertForm.result.converted_amount).toLocaleString('en-IN')} {convertForm.to !== 'INR' ? convertForm.to : ''}
                </span>
                <span style={{ color: '#6b7280', fontSize: 12, marginLeft: 10 }}>
                  @ rate {fmtFx(convertForm.result.rate, 4)}
                  {convertForm.result.rate_date && ` · as of ${fmtDate(convertForm.result.rate_date)}`}
                </span>
              </div>
            )}
            {convertForm.result?.error && (
              <div style={{ marginTop: 12, padding: '10px 14px', background: '#fef2f2', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>
                {convertForm.result.error} — <button onClick={() => setShowAddRate(true)}
                  style={{ background: 'none', border: 'none', color: '#6B3FDB', cursor: 'pointer', textDecoration: 'underline', fontSize: 13, padding: 0 }}>
                  add it manually
                </button>
              </div>
            )}
            {rates.length === 0 && (
              <div style={{ marginTop: 12, fontSize: 13, color: '#9ca3af' }}>
                Fetch live rates first to enable conversion.
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Tab 1: Forex Exposure ── */}
      {tab === 1 && (
        <div>
          {exposure.length === 0 ? (
            <div style={{ ...cardStyle, padding: '48px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: 36, marginBottom: 8 }}>📊</div>
              <div style={{ fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>No foreign currency exposure</div>
              <div style={{ fontSize: 13, color: '#9ca3af' }}>
                Forex exposure is calculated from open invoices and supplier bills in non-INR currencies.
                No such transactions exist for this company yet.
              </div>
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 24 }}>
                {exposure.map((e, i) => (
                  <div key={i} style={{ ...cardStyle, padding: 20, marginBottom: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Net Exposure</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: '#111827' }}>{e.currency}</div>
                        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>@ ₹{fmtFx(e.current_rate)}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: 18, fontWeight: 700, color: e.net_exposure_inr >= 0 ? '#059669' : '#dc2626' }}>
                          {fmt(Math.abs(e.net_exposure_inr))}
                        </div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>
                          {e.net_exposure_foreign > 0 ? '+' : ''}{e.net_exposure_foreign.toLocaleString('en-IN')} {e.currency}
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <div style={{ background: '#f0fdf4', borderRadius: 8, padding: '8px 12px' }}>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>Receivable</div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#059669' }}>{e.total_receivable_foreign.toLocaleString('en-IN')} {e.currency}</div>
                      </div>
                      <div style={{ background: '#fef2f2', borderRadius: 8, padding: '8px 12px' }}>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>Payable</div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#dc2626' }}>{e.total_payable_foreign.toLocaleString('en-IN')} {e.currency}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div style={cardStyle}>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4' }}>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Sensitivity Analysis</h3>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>P&amp;L impact for rate movements on net INR exposure</p>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Currency', 'Net Exposure (INR)', '+1%', '+5%', '+10%', '-1%', '-5%', '-10%'].map(h => <th key={h} style={thStyle}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {exposure.map((e, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>{e.currency}</td>
                        <td style={tdStyle}>{fmt(e.net_exposure_inr)}</td>
                        {[e.impact_1pct, e.impact_5pct, e.impact_10pct].map((v, j) => (
                          <td key={j} style={{ ...tdStyle, color: '#059669', fontWeight: 500 }}>+{fmt(v)}</td>
                        ))}
                        {[e.impact_1pct, e.impact_5pct, e.impact_10pct].map((v, j) => (
                          <td key={j} style={{ ...tdStyle, color: '#dc2626', fontWeight: 500 }}>-{fmt(v)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Tab 2: Revaluation ── */}
      {tab === 2 && (
        <div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
            <div>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Revaluation Date</label>
              <input type="date" value={revalDate} onChange={e => setRevalDate(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }} />
            </div>
            <button onClick={runRevaluation} disabled={revalRunning || rates.length === 0}
              style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, marginTop: 20, opacity: (revalRunning || rates.length === 0) ? 0.6 : 1 }}>
              {revalRunning ? 'Computing…' : 'Run Revaluation'}
            </button>
            {rates.length === 0 && (
              <span style={{ marginTop: 20, fontSize: 12, color: '#9ca3af' }}>Fetch exchange rates first</span>
            )}
          </div>

          {revalPreview && (
            <div style={cardStyle}>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Revaluation Preview — {fmtDate(revalDate)}</h3>
                <div style={{ display: 'flex', gap: 24 }}>
                  {[
                    { label: 'Total Gain', val: revalPreview.summary?.totalGain, color: '#059669' },
                    { label: 'Total Loss', val: revalPreview.summary?.totalLoss, color: '#dc2626' },
                    { label: 'Net P&L', val: revalPreview.summary?.netPgl, color: revalPreview.summary?.netPgl >= 0 ? '#059669' : '#dc2626' },
                  ].map(({ label, val, color }) => (
                    <div key={label} style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{label}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color }}>{val >= 0 ? '' : '-'}{fmt(Math.abs(val || 0))}</div>
                    </div>
                  ))}
                </div>
              </div>
              {revalPreview.details?.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Reference', 'Party', 'CCY', 'Foreign Amount', 'Booked Rate', 'Current Rate', 'Booked ₹', 'Current ₹', 'Difference', 'G/L'].map(h => (
                        <th key={h} style={thStyle}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {revalPreview.details.map((d, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ ...tdStyle, fontWeight: 600 }}>{d.reference}</td>
                        <td style={tdStyle}>{d.party}</td>
                        <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 600 }}>{d.currency}</td>
                        <td style={tdStyle}>{parseFloat(d.foreign_amount).toLocaleString('en-IN')}</td>
                        <td style={tdStyle}>{fmtFx(d.booked_rate)}</td>
                        <td style={tdStyle}>{fmtFx(d.current_rate)}</td>
                        <td style={tdStyle}>{fmt(d.booked_inr)}</td>
                        <td style={tdStyle}>{fmt(d.current_inr)}</td>
                        <td style={{ ...tdStyle, fontWeight: 600, color: parseFloat(d.difference) >= 0 ? '#059669' : '#dc2626' }}>
                          {parseFloat(d.difference) >= 0 ? '+' : ''}{fmt(d.difference)}
                        </td>
                        <td style={tdStyle}>
                          <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: d.gl === 'gain' ? '#d1fae5' : '#fee2e2', color: d.gl === 'gain' ? '#065f46' : '#991b1b' }}>
                            {d.gl === 'gain' ? 'Gain' : 'Loss'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ padding: '32px 24px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                  No open foreign-currency invoices or bills found for revaluation.
                </div>
              )}
              <div style={{ padding: 16, display: 'flex', gap: 8, borderTop: '1px solid #f0f0f4' }}>
                <button onClick={() => postRevaluation(revalPreview.revaluation?.id)}
                  style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  Post Journal Entries
                </button>
                <button onClick={() => setRevalPreview(null)}
                  style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                  Discard
                </button>
              </div>
            </div>
          )}

          <div style={cardStyle}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Revaluation History</h3>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Date', 'Period', 'Status', 'Total Gain', 'Total Loss', 'Net P&L'].map(h => <th key={h} style={thStyle}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {revaluations.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: '32px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                      No revaluations run yet. Run a revaluation above to create journal entries for forex gain/loss.
                    </td>
                  </tr>
                ) : revaluations.map((r, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{fmtDate(r.revaluation_date)}</td>
                    <td style={tdStyle}>{r.period}</td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: r.status === 'posted' ? '#d1fae5' : '#fef3c7', color: r.status === 'posted' ? '#065f46' : '#92400e' }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, color: '#059669', fontWeight: 500 }}>{fmt(r.total_gain)}</td>
                    <td style={{ ...tdStyle, color: '#dc2626', fontWeight: 500 }}>{fmt(r.total_loss)}</td>
                    <td style={{ ...tdStyle, fontWeight: 700, color: parseFloat(r.net_pgl) >= 0 ? '#059669' : '#dc2626' }}>
                      {parseFloat(r.net_pgl) >= 0 ? '+' : ''}{fmt(r.net_pgl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
