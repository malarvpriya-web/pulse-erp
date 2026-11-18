import { useCallback, useEffect, useMemo, useState } from 'react';
import { Briefcase, CalendarClock, RefreshCw, TrendingUp, Users, ClipboardList } from 'lucide-react';
import api from '@/services/api/client';
import { exportCSV } from '@/features/_shared/exportUtils';
import { fmtDate } from '@/utils/dateFormatter';
import './HiringForecasts.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

/**
 * Hiring Forecasts (Recruitment → Reports & Setup).
 *
 * Demand per department = seats on open jobs + approved requisitions not yet
 * posted as a job + requisitions awaiting approval (GET /recruitment/reports/
 * forecast). Pipeline = applicants still active on those jobs.
 *
 * Expected hires = pipeline × conversion rate, capped at the open seats. The
 * rate starts at the company's real interview-to-hire rate, and can be typed
 * over to try a different assumption — that number is a what-if on this
 * screen only and is not saved.
 *
 * Review 2026-11-17: it read job openings only (requisitions invisible),
 * counted rejected applicants as pipeline, filtered by calendar quarters of
 * the closing date while always keeping jobs with no closing date, and its
 * "All (2026)" option included every year.
 */

const WITHIN = [
  { value: '', label: 'All open demand' },
  { value: '30', label: 'Jobs closing within 30 days' },
  { value: '90', label: 'Jobs closing within 90 days' },
];

const pctText = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);

export default function HiringForecasts({ embedded = false }) {
  const [within, setWithin] = useState('');
  const [data, setData] = useState({ rows: [], rates: {} });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rate, setRate] = useState(''); // what-if conversion %, '' = use actual

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/recruitment/reports/forecast', { params: within ? { within_days: within } : {} });
      setData({ rows: Array.isArray(res.data?.rows) ? res.data.rows : [], rates: res.data?.rates || {} });
      setError('');
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not load the forecast');
    } finally { setLoading(false); }
  }, [within]);

  useEffect(() => { loadData(); }, [loadData]);

  const actualRate = data.rates.interview_to_hire_pct;
  const usedRate = rate !== '' && Number.isFinite(Number(rate)) ? Math.min(100, Math.max(0, Number(rate))) : (actualRate ?? null);

  const rows = useMemo(() => {
    const today = new Date();
    return data.rows.map((r) => {
      const demand = r.open_seats + r.approved_not_posted;
      const expected = usedRate == null ? null : Math.min(r.open_seats, Math.round(r.pipeline * (usedRate / 100)));
      const perSeat = r.open_seats ? r.pipeline / r.open_seats : null;
      const daysLeft = r.soonest_closing ? Math.ceil((new Date(`${r.soonest_closing}T00:00:00`) - today) / 86400000) : null;
      // Thin pipeline (under 2 active applicants per open seat), or a job
      // closing within 14 days → High; under 4 per seat → Medium.
      const priority = demand === 0 ? 'Low'
        : (r.open_seats && (perSeat < 2 || (daysLeft != null && daysLeft <= 14))) || (!r.open_seats && r.approved_not_posted) ? 'High'
        : perSeat != null && perSeat < 4 ? 'Medium' : 'Low';
      const status = demand === 0 ? (r.awaiting_approval ? 'Awaiting approval' : 'Filled')
        : r.approved_not_posted && !r.open_seats ? 'Not posted yet'
        : r.pipeline < r.open_seats ? 'Pipeline risk' : 'On track';
      return { ...r, demand, expected, priority, status, daysLeft };
    });
  }, [data.rows, usedRate]);

  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const expectedTotal = rows.some(r => r.expected != null) ? sum('expected') : null;
  const maxDemand = Math.max(1, ...rows.map(r => r.demand + r.awaiting_approval));

  const exportRows = () => exportCSV(rows.map(r => ({
    department: r.department, open_jobs: r.open_roles, open_seats: r.open_seats, approved_not_posted: r.approved_not_posted,
    awaiting_approval: r.awaiting_approval, active_pipeline: r.pipeline, offers_out: r.offers_out,
    expected_hires: r.expected ?? '', conversion_rate_used: usedRate ?? '', priority: r.priority, status: r.status,
    soonest_closing: r.soonest_closing || '',
  })), 'hiring_forecast');

  const body = (
    <>
      <div className="hfc-header">
        <div className="hfc-actions" style={{ flexWrap: 'wrap' }}>
          <select className="hfc-sel" aria-label="Period" value={within} onChange={(e) => setWithin(e.target.value)}>
            {WITHIN.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151' }}>
            Conversion rate
            <input type="number" min="0" max="100" step="0.5" aria-label="Conversion rate (%)" value={rate}
              placeholder={actualRate != null ? String(actualRate) : '—'} onChange={(e) => setRate(e.target.value)}
              style={{ width: 80, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />%
          </label>
          {rate !== '' && <button type="button" className="pulse-btn-secondary" onClick={() => setRate('')}>Use actual</button>}
          <button type="button" className="hfc-refresh-btn" onClick={loadData}><RefreshCw size={14} /> Refresh</button>
          <button type="button" className="pulse-btn-secondary" onClick={exportRows} disabled={!rows.length}>Export CSV</button>
        </div>
      </div>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 14px' }}>
        {rate !== ''
          ? `Expected hires use your what-if rate of ${usedRate}% (not saved). The company's actual interview-to-hire rate is ${pctText(actualRate)}.`
          : actualRate != null
            ? `Expected hires use the company's actual interview-to-hire rate, ${pctText(actualRate)} (${data.rates.interviewed} candidates interviewed). Type a rate to try another.`
            : 'No one has been interviewed yet, so there is no rate to forecast with. Type an assumed rate to estimate.'}
      </p>

      {error && <div style={{ padding: 16, color: '#b91c1c', background: '#fef2f2', borderRadius: 10, marginBottom: 14 }}>{error}</div>}

      <div className="hfc-summary">
        <div className="hfc-sum-card">
          <div className="hfc-sum-icon" style={{ background: '#ede9fe', color: '#6d28d9' }}><Briefcase size={16} /></div>
          <div><div className="hfc-sum-num">{sum('open_seats')}</div><div className="hfc-sum-lbl">Open seats ({sum('open_roles')} jobs)</div></div>
        </div>
        <div className="hfc-sum-card">
          <div className="hfc-sum-icon" style={{ background: '#fef3c7', color: '#92400e' }}><ClipboardList size={16} /></div>
          <div><div className="hfc-sum-num">{sum('approved_not_posted')}</div><div className="hfc-sum-lbl">Approved, not posted · {sum('awaiting_approval')} awaiting approval</div></div>
        </div>
        <div className="hfc-sum-card">
          <div className="hfc-sum-icon" style={{ background: '#f3e8ff', color: '#7e22ce' }}><CalendarClock size={16} /></div>
          <div><div className="hfc-sum-num">{data.rates.avg_days_to_hire != null ? `${data.rates.avg_days_to_hire}d` : '—'}</div><div className="hfc-sum-lbl">Avg time to hire{data.rates.hires_measured ? ` (${data.rates.hires_measured} hires)` : ''}</div></div>
        </div>
        <div className="hfc-sum-card">
          <div className="hfc-sum-icon" style={{ background: '#dcfce7', color: '#15803d' }}><TrendingUp size={16} /></div>
          <div><div className="hfc-sum-num">{expectedTotal ?? '—'}</div><div className="hfc-sum-lbl" title="Active applicants × conversion rate, capped at open seats">Expected hires</div></div>
        </div>
      </div>

      <div className="hfc-chart-card">
        <div className="hfc-card-title">Demand by department</div>
        <div className="hfc-metric-strip">
          <span>Offer acceptance: <strong>{pctText(data.rates.offer_acceptance_pct)}</strong></span>
          <span>Interview to hire: <strong>{pctText(actualRate)}</strong></span>
          <span><Users size={12} style={{ verticalAlign: -1 }} /> Active pipeline: <strong>{sum('pipeline')}</strong></span>
        </div>
        {loading ? <div className="hfc-empty">Loading…</div> : rows.length === 0 ? (
          <div className="hfc-empty">No open jobs or approved requisitions{within ? ' closing in this window' : ''}.</div>
        ) : (
          <div className="hfc-bars">
            {rows.map((row) => (
              <div key={row.department} className="hfc-bar-row" title={`${row.open_seats} open seats, ${row.approved_not_posted} approved not posted, ${row.awaiting_approval} awaiting approval`}>
                <div className="hfc-bar-label">{row.department}</div>
                <div className="hfc-bar-track" style={{ display: 'flex' }}>
                  <div className="hfc-bar-fill" style={{ width: `${(row.open_seats / maxDemand) * 100}%` }} />
                  <div style={{ width: `${(row.approved_not_posted / maxDemand) * 100}%`, background: '#c4b5fd' }} />
                  <div style={{ width: `${(row.awaiting_approval / maxDemand) * 100}%`, background: '#e5e7eb' }} />
                </div>
                <div className="hfc-bar-val">{row.demand}{row.awaiting_approval ? ` +${row.awaiting_approval}` : ''}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hfc-table-wrap">
        <table className="hfc-table">
          <thead>
            <tr>
              <th>Department</th>
              <th className="hfc-center">Open jobs</th>
              <th className="hfc-center">Open seats</th>
              <th className="hfc-center">Approved, not posted</th>
              <th className="hfc-center">Awaiting approval</th>
              <th className="hfc-center">Active pipeline</th>
              <th className="hfc-center">Offers out</th>
              <th className="hfc-center">Expected hires</th>
              <th className="hfc-center">Soonest closing</th>
              <th className="hfc-center">Priority</th>
              <th className="hfc-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr className="hfc-row"><td colSpan={11} className="hfc-empty">No data.</td></tr>
            ) : rows.map((row) => (
              <tr key={row.department} className="hfc-row">
                <td><div className="hfc-dept-cell">{row.department}</div></td>
                <td className="hfc-center">{row.open_roles}</td>
                <td className="hfc-center">{row.open_seats}</td>
                <td className="hfc-center">{row.approved_not_posted}</td>
                <td className="hfc-center">{row.awaiting_approval}</td>
                <td className="hfc-center">{row.pipeline}</td>
                <td className="hfc-center">{row.offers_out}</td>
                <td className="hfc-center">{row.expected ?? '—'}</td>
                <td className="hfc-center">{row.soonest_closing ? fmtDate(row.soonest_closing) : '—'}</td>
                <td className="hfc-center hfc-priority">{row.priority}</td>
                <td className="hfc-center">
                  <span className={`hfc-status-badge ${row.status === 'On track' || row.status === 'Filled' ? 'hfc-status-ok' : 'hfc-status-risk'}`}>{row.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={<PageHero icon={TrendingUp} eyebrow="Recruitment" title="Hiring Forecasts" subtitle="Hiring demand, pipeline and expected hires by department" />}>
      {body}
    </PageShell>
  );
}
