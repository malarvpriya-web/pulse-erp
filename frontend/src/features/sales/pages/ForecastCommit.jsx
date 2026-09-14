/**
 * ForecastCommit.jsx — the forecast a PERSON states, as distinct from the number
 * the pipeline happens to add up to.
 *
 * SalesForecasts.jsx already renders the computed roll-up
 * (/api/sales/forecasts/*). This page is the capability that was missing behind
 * it: forecast categories, the drill-down from a category to the deals in it,
 * a rep's submission, a manager's override, and the snapshot history that makes
 * forecast accuracy measurable at all.
 *
 * Two things are kept visually separate on purpose:
 *   - `forecast` is UNWEIGHTED — "if all of these land, this is the money".
 *   - `weighted` is probability-weighted.
 * The endpoints this replaces returned SUM(value x probability) under the bare
 * label "forecast", which presents a weighted number as if it were a commitment.
 * Both are shown, both are labelled.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Target, ChevronRight, Camera, Check, AlertTriangle } from 'lucide-react';
import { PageHero, PageShell } from '@/components/pulse-ui';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmtL = (n) => {
  const v = Number(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  return `₹${v.toLocaleString('en-IN')}`;
};

/** Colour and copy per category. `omitted` is grey, not red — deliberately
 *  excluding a deal is a decision, not a problem. */
const CATEGORY_META = {
  commit:    { label: 'Commit',    color: '#10b981', hint: 'Standing behind it' },
  best_case: { label: 'Best Case', color: '#6B3FDB', hint: 'Real upside, not promised' },
  pipeline:  { label: 'Pipeline',  color: '#2563eb', hint: 'Everything else still open' },
  omitted:   { label: 'Omitted',   color: '#9ca3af', hint: 'Deliberately excluded' },
  closed:    { label: 'Closed Won', color: '#059669', hint: 'Already banked' },
};
const CATEGORY_ORDER = ['commit', 'best_case', 'pipeline', 'omitted', 'closed'];

const card = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20 };
const selBase = { padding: '7px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, color: '#374151', background: '#fff', cursor: 'pointer' };
const btnBase = { padding: '7px 16px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const th = { textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const td = { padding: '10px 14px', fontSize: 13, color: '#374151', borderBottom: '1px solid #f7f7fa' };

export default function ForecastCommit({ embedded = false }) {
  const toast = useToast();
  const now = new Date();

  const [periodType, setPeriodType] = useState('quarterly');
  const [periodYear, setPeriodYear] = useState(now.getFullYear());
  const [periodValue, setPeriodValue] = useState(Math.ceil((now.getMonth() + 1) / 3));

  const [forecast, setForecast] = useState(null);
  const [byRep, setByRep] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [accuracy, setAccuracy] = useState(null);
  const [openCategory, setOpenCategory] = useState(null);
  const [drill, setDrill] = useState({ loading: false, rows: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const abortRef = useRef(null);
  const pval = periodType === 'annual' ? '' : periodValue;
  const qs = `period_type=${periodType}&period_year=${periodYear}${pval === '' ? '' : `&period_value=${pval}`}`;

  const load = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setErr(null);
    Promise.all([
      api.get(`/sales/forecasting/categories?${qs}`, { signal: ctrl.signal }),
      api.get(`/sales/forecasting/by-rep?${qs}`, { signal: ctrl.signal }),
      api.get(`/sales/forecasting/submissions?${qs}`, { signal: ctrl.signal }),
      api.get(`/sales/forecasting/accuracy?period_type=${periodType}&period_year=${periodYear}`, { signal: ctrl.signal }),
    ])
      .then(([f, r, s, a]) => {
        setForecast(f.data);
        setByRep(r.data?.data ?? []);
        setSubmissions(s.data ?? []);
        setAccuracy(a.data);
      })
      .catch((e) => {
        // axios aborts surface as CanceledError, never AbortError — guarding on
        // the wrong name reads every cancelled refresh as a load failure.
        if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError') return;
        setErr(e.response?.data?.error || e.message || 'Failed to load forecast');
      })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [qs, periodType, periodYear]);

  useEffect(() => { load(); }, [load]);

  const openDrill = async (category) => {
    if (openCategory === category) { setOpenCategory(null); return; }
    setOpenCategory(category);
    setDrill({ loading: true, rows: [] });
    try {
      const { data } = await api.get(`/sales/forecasting/categories/${category}/opportunities?${qs}`);
      setDrill({ loading: false, rows: data?.data ?? [] });
    } catch (e) {
      setDrill({ loading: false, rows: [] });
      toast?.error?.(e.response?.data?.error || 'Could not load the deals behind this category');
    }
  };

  const recategorise = async (oppId, category) => {
    try {
      await api.patch(`/sales/forecasting/opportunities/${oppId}/category`, { forecast_category: category || null });
      toast?.success?.(category ? `Moved to ${CATEGORY_META[category].label}` : 'Category cleared — back to the derived default');
      load();
      if (openCategory) openDrill(openCategory === category ? category : openCategory);
    } catch (e) {
      toast?.error?.(e.response?.data?.error || 'Could not change the forecast category');
    }
  };

  const submitForecast = async (status) => {
    setBusy(true);
    try {
      const { data } = await api.post('/sales/forecasting/submissions', {
        period_type: periodType, period_year: periodYear,
        ...(pval === '' ? {} : { period_value: pval }),
        status,
      });
      toast?.success?.(status === 'submitted' ? 'Forecast submitted' : 'Draft saved');
      setSubmissions((prev) => [data, ...prev.filter((s) => s.id !== data.id)]);
      load();
    } catch (e) {
      toast?.error?.(e.response?.data?.error || 'Could not save the forecast');
    } finally { setBusy(false); }
  };

  const captureSnapshot = async () => {
    setBusy(true);
    try {
      await api.post('/sales/forecasting/snapshots', {
        period_type: periodType, period_year: periodYear,
        ...(pval === '' ? {} : { period_value: pval }),
      });
      toast?.success?.('Snapshot captured — this period is now measurable for accuracy');
      load();
    } catch (e) {
      toast?.error?.(e.response?.data?.error || 'Could not capture a snapshot');
    } finally { setBusy(false); }
  };

  const override = async (submissionId) => {
    const amount = window.prompt('Manager override — committed amount (₹):');
    if (amount == null) return;
    const reason = window.prompt('Reason for the override (required):');
    if (!reason) { toast?.error?.('An override needs a reason'); return; }
    try {
      await api.post(`/sales/forecasting/submissions/${submissionId}/override`, {
        override_commit_amount: Number(amount), override_reason: reason,
      });
      toast?.success?.('Override recorded');
      load();
    } catch (e) {
      toast?.error?.(e.response?.data?.error || 'Could not record the override');
    }
  };

  const yearOpts = [];
  for (let y = now.getFullYear() - 2; y <= now.getFullYear() + 1; y++) yearOpts.push(y);
  const pvOptions = periodType === 'monthly'
    ? MONTHS.map((m, i) => ({ label: m, value: i + 1 }))
    : periodType === 'quarterly'
      ? [1, 2, 3, 4].map((q) => ({ label: `Q${q}`, value: q }))
      : [];

  const totals = forecast?.totals;

  const body = (
    <>
      {/* Period */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {['monthly', 'quarterly', 'annual'].map((t) => (
          <button key={t} onClick={() => {
            setPeriodType(t);
            if (t === 'quarterly') setPeriodValue(Math.ceil((now.getMonth() + 1) / 3));
            if (t === 'monthly') setPeriodValue(now.getMonth() + 1);
          }}
            style={{ ...btnBase, background: periodType === t ? '#6B3FDB' : '#fff', color: periodType === t ? '#fff' : '#374151' }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
        <select value={periodYear} onChange={(e) => setPeriodYear(Number(e.target.value))} style={selBase}>
          {yearOpts.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        {pvOptions.length > 0 && (
          <select value={periodValue} onChange={(e) => setPeriodValue(Number(e.target.value))} style={selBase}>
            {pvOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={captureSnapshot} disabled={busy} style={{ ...btnBase, display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff' }}>
          <Camera size={14} /> Capture snapshot
        </button>
        <button onClick={() => submitForecast('draft')} disabled={busy} style={{ ...btnBase, background: '#fff' }}>Save draft</button>
        <button onClick={() => submitForecast('submitted')} disabled={busy}
          style={{ ...btnBase, background: '#6B3FDB', color: '#fff', border: '1px solid #6B3FDB', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Check size={14} /> Submit forecast
        </button>
      </div>

      {/* The window this page is answering for. A forecast that does not say
          which dates it covers is indistinguishable from one covering the wrong
          ones — an empty period then reads as a broken page. */}
      {forecast?.period && (
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 16px' }}>
          Deals closing {forecast.period.start} to {forecast.period.end} (end exclusive)
        </p>
      )}

      {err && (
        <div style={{ ...card, borderColor: '#fecaca', background: '#fef2f2', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'center' }}>
          <AlertTriangle size={18} color="#dc2626" />
          <span style={{ color: '#991b1b', fontSize: 13 }}>{err}</span>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading forecast…</div>
      ) : (
        <>
          {/* Category cards — click to drill into the deals behind the number */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16, marginBottom: 20 }}>
            {CATEGORY_ORDER.map((key) => {
              const c = forecast?.categories?.find((x) => x.category === key)
                ?? { amount: 0, opportunity_count: 0, weighted_amount: 0 };
              const meta = CATEGORY_META[key];
              const open = openCategory === key;
              return (
                <button key={key} onClick={() => openDrill(key)}
                  style={{ ...card, textAlign: 'left', cursor: 'pointer', borderColor: open ? meta.color : '#f0f0f4', borderWidth: open ? 2 : 1 }}>
                  <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 6px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{meta.label}</p>
                  <p style={{ fontSize: 22, fontWeight: 700, color: meta.color, margin: '0 0 4px' }}>{fmtL(c.amount)}</p>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
                    {c.opportunity_count} deal{c.opportunity_count === 1 ? '' : 's'} · weighted {fmtL(c.weighted_amount)}
                  </p>
                  <p style={{ fontSize: 11, color: '#b6b6c2', margin: '6px 0 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                    {meta.hint} <ChevronRight size={12} />
                  </p>
                </button>
              );
            })}
          </div>

          {/* Roll-up. Unweighted and weighted are labelled, never merged. */}
          <div style={{ ...card, marginBottom: 20, display: 'flex', gap: 32, flexWrap: 'wrap' }}>
            <div>
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 4px', fontWeight: 700, textTransform: 'uppercase' }}>Forecast (unweighted)</p>
              <p style={{ fontSize: 26, fontWeight: 700, color: '#111827', margin: 0 }}>{fmtL(totals?.forecast)}</p>
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>commit + best case + pipeline</p>
            </div>
            <div>
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 4px', fontWeight: 700, textTransform: 'uppercase' }}>Probability-weighted</p>
              <p style={{ fontSize: 26, fontWeight: 700, color: '#6B3FDB', margin: 0 }}>{fmtL(totals?.weighted_forecast)}</p>
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>the same deals × probability</p>
            </div>
            <div>
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '0 0 4px', fontWeight: 700, textTransform: 'uppercase' }}>Forecast accuracy</p>
              <p style={{ fontSize: 26, fontWeight: 700, color: accuracy?.overall_accuracy_pct == null ? '#9ca3af' : '#10b981', margin: 0 }}>
                {accuracy?.overall_accuracy_pct == null ? '—' : `${accuracy.overall_accuracy_pct}%`}
              </p>
              {/* An unmeasurable metric says so rather than reporting a default. */}
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 0' }}>
                {accuracy?.measured_periods
                  ? `from ${accuracy.measured_periods} snapshotted period${accuracy.measured_periods === 1 ? '' : 's'}`
                  : 'no snapshot captured yet — capture one to start measuring'}
              </p>
            </div>
          </div>

          {/* Drill-down */}
          {openCategory && (
            <div style={{ ...card, marginBottom: 20, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>
                  {CATEGORY_META[openCategory].label} — deals behind the number
                </span>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>({drill.rows.length})</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                {drill.loading ? (
                  <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading deals…</div>
                ) : drill.rows.length === 0 ? (
                  <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                    No deals in this category for this period.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={th}>Opportunity</th><th style={th}>Account</th><th style={th}>Owner</th>
                      <th style={th}>Stage</th><th style={th}>Close date</th>
                      <th style={{ ...th, textAlign: 'right' }}>Value</th>
                      <th style={{ ...th, textAlign: 'right' }}>Weighted</th>
                      <th style={th}>Move to</th>
                    </tr></thead>
                    <tbody>
                      {drill.rows.map((r) => (
                        <tr key={r.id}>
                          <td style={{ ...td, fontWeight: 600, color: '#111827' }}>{r.opportunity_name}</td>
                          <td style={td}>{r.account_name || '—'}</td>
                          <td style={td}>{r.owner_name || 'Unassigned'}</td>
                          <td style={td}>{r.stage}</td>
                          <td style={td}>{r.expected_closing_date || '—'}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtL(r.expected_value)}</td>
                          <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>{fmtL(r.weighted_value)}</td>
                          <td style={td}>
                            <select value={r.explicit_category ?? ''} style={{ ...selBase, padding: '4px 8px', fontSize: 12 }}
                              onChange={(e) => recategorise(r.id, e.target.value)}>
                              {/* '' clears the explicit judgement and returns the
                                  deal to the engine's derived default — a real
                                  choice, not an absence of one. */}
                              <option value="">Derived ({CATEGORY_META[r.category]?.label})</option>
                              {CATEGORY_ORDER.map((k) => <option key={k} value={k}>{CATEGORY_META[k].label}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(420px,1fr))', gap: 16 }}>
            {/* By rep */}
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', fontWeight: 700, fontSize: 14, color: '#111827' }}>Forecast by owner</div>
              <div style={{ overflowX: 'auto' }}>
                {byRep.length === 0 ? (
                  <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No deals close in this period.</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={th}>Owner</th>
                      <th style={{ ...th, textAlign: 'right' }}>Commit</th>
                      <th style={{ ...th, textAlign: 'right' }}>Best case</th>
                      <th style={{ ...th, textAlign: 'right' }}>Forecast</th>
                      <th style={{ ...th, textAlign: 'right' }}>Deals</th>
                    </tr></thead>
                    <tbody>
                      {byRep.map((r) => (
                        <tr key={r.employee_id ?? 'unassigned'}>
                          <td style={{ ...td, fontWeight: 600, color: r.employee_id == null ? '#9ca3af' : '#111827' }}>{r.name}</td>
                          <td style={{ ...td, textAlign: 'right', color: '#10b981', fontWeight: 600 }}>{fmtL(r.commit)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{fmtL(r.best_case)}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtL(r.forecast)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{r.opportunity_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Submissions */}
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4', fontWeight: 700, fontSize: 14, color: '#111827' }}>Submitted forecasts</div>
              <div style={{ overflowX: 'auto' }}>
                {submissions.length === 0 ? (
                  <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                    Nothing filed for this period yet.
                  </div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={th}>Owner</th><th style={th}>Status</th>
                      <th style={{ ...th, textAlign: 'right' }}>Rep commit</th>
                      <th style={{ ...th, textAlign: 'right' }}>Manager override</th>
                      <th style={th} />
                    </tr></thead>
                    <tbody>
                      {submissions.map((s) => (
                        <tr key={s.id}>
                          <td style={{ ...td, fontWeight: 600, color: '#111827' }}>{s.owner_name || `Employee ${s.owner_employee_id}`}</td>
                          <td style={td}>
                            <span style={{
                              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                              background: s.status === 'approved' ? '#dcfce7' : s.status === 'submitted' ? '#ede9fe' : '#f3f4f6',
                              color: s.status === 'approved' ? '#166534' : s.status === 'submitted' ? '#5b21b6' : '#6b7280',
                            }}>{s.status}</span>
                          </td>
                          {/* The rep's number is never overwritten by an override —
                              both are shown so the pair stays answerable. */}
                          <td style={{ ...td, textAlign: 'right' }}>{fmtL(s.commit_amount)}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: s.override_commit_amount == null ? '#d1d5db' : '#6B3FDB' }}
                            title={s.override_reason || ''}>
                            {s.override_commit_amount == null ? '—' : fmtL(s.override_commit_amount)}
                          </td>
                          <td style={td}>
                            <button onClick={() => override(s.id)} style={{ ...btnBase, padding: '4px 10px', fontSize: 12, background: '#fff' }}>
                              Override
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );

  if (embedded) return body;

  return (
    <PageShell dock={<PageHero icon={Target} eyebrow="Sales" title="Forecast & Commit" />}>
      {body}
    </PageShell>
  );
}
