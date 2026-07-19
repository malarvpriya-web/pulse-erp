import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Briefcase,
  CalendarClock,
  RefreshCw,
  TrendingUp,
  Users,
} from 'lucide-react';
import api from '@/services/api/client';
import './HiringForecasts.css';

const toNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const quarterFromMonth = (monthIndex) => Math.floor(monthIndex / 3) + 1;

const isOpenStatus = (status) => ['open', 'draft', 'pending_approval'].includes(String(status || '').toLowerCase());

const parseOpenings = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.openings)) return payload.openings;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const parseMetricValue = (payload, keys) => {
  if (Array.isArray(payload)) {
    const first = payload[0] || {};
    for (const key of keys) {
      if (first[key] != null) return toNum(first[key], 0);
    }
    return 0;
  }
  if (payload && typeof payload === 'object') {
    for (const key of keys) {
      if (payload[key] != null) return toNum(payload[key], 0);
    }
  }
  return 0;
};

const formatPct = (n) => `${Math.max(0, Math.min(100, n)).toFixed(1)}%`;

export default function HiringForecasts() {
  const [selectedQuarter, setSelectedQuarter] = useState('all');
  const [openings, setOpenings] = useState([]);
  const [metrics, setMetrics] = useState({ timeToHire: 0, offerAcceptance: 0, interviewToHire: 0 });
  const [loading, setLoading] = useState(false);

  const quarterOptions = useMemo(() => {
    const year = new Date().getFullYear();
    return [
      { value: 'all', label: `All (${year})` },
      { value: `${year}-Q1`, label: `Q1 ${year}` },
      { value: `${year}-Q2`, label: `Q2 ${year}` },
      { value: `${year}-Q3`, label: `Q3 ${year}` },
      { value: `${year}-Q4`, label: `Q4 ${year}` },
    ];
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [openingsRes, tthRes, offerRes, i2hRes] = await Promise.allSettled([
      api.get('/recruitment/openings'),
      api.get('/recruitment/analytics/time-to-hire'),
      api.get('/recruitment/analytics/offer-acceptance-rate'),
      api.get('/recruitment/analytics/interview-to-hire-ratio'),
    ]);

    const incomingOpenings =
      openingsRes.status === 'fulfilled'
        ? parseOpenings(openingsRes.value?.data)
        : [];
    setOpenings(Array.isArray(incomingOpenings) ? incomingOpenings : []);

    const timeToHire =
      tthRes.status === 'fulfilled'
        ? parseMetricValue(tthRes.value?.data, ['avg_days', 'average_days', 'days', 'time_to_hire'])
        : 0;
    const offerAcceptance =
      offerRes.status === 'fulfilled'
        ? parseMetricValue(offerRes.value?.data, ['offer_acceptance_rate', 'acceptance_rate', 'rate', 'percentage'])
        : 0;
    const interviewToHire =
      i2hRes.status === 'fulfilled'
        ? parseMetricValue(i2hRes.value?.data, ['interview_to_hire_ratio', 'ratio', 'rate', 'percentage'])
        : 0;

    setMetrics({
      timeToHire,
      offerAcceptance,
      interviewToHire,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const filteredOpenings = useMemo(() => {
    if (selectedQuarter === 'all') return openings;
    const [year, qPart] = selectedQuarter.split('-');
    const q = Number(String(qPart || '').replace('Q', ''));
    return openings.filter((o) => {
      if (!o?.closing_date) return true;
      const dt = new Date(o.closing_date);
      if (Number.isNaN(dt.getTime())) return true;
      return String(dt.getFullYear()) === String(year) && quarterFromMonth(dt.getMonth()) === q;
    });
  }, [openings, selectedQuarter]);

  const deptRows = useMemo(() => {
    const map = new Map();
    for (const o of filteredOpenings) {
      if (!isOpenStatus(o.status)) continue;
      const dept = (o.department || 'Unassigned').trim() || 'Unassigned';
      const positions = toNum(o.number_of_positions, 1);
      const filled = toNum(o.positions_filled, 0);
      const openPositions = Math.max(positions - filled, 0);
      const applicants = toNum(o.applicants_count, 0);
      const current = map.get(dept) || { department: dept, roles: 0, openPositions: 0, pipeline: 0 };
      current.roles += 1;
      current.openPositions += openPositions;
      current.pipeline += applicants;
      map.set(dept, current);
    }

    const acceptanceRate = Math.max(0.05, Math.min(0.95, metrics.offerAcceptance / 100));
    return [...map.values()]
      .map((row) => {
        const forecast = Math.round(row.openPositions * acceptanceRate);
        const priority = row.openPositions >= 4 || row.pipeline < row.openPositions * 2 ? 'High' : row.openPositions >= 2 ? 'Medium' : 'Low';
        const status = row.pipeline < row.openPositions ? 'Pipeline Risk' : 'On Track';
        return { ...row, forecastHires: forecast, priority, status };
      })
      .sort((a, b) => b.openPositions - a.openPositions);
  }, [filteredOpenings, metrics.offerAcceptance]);

  const maxOpenPositions = useMemo(
    () => Math.max(1, ...deptRows.map((r) => r.openPositions)),
    [deptRows]
  );

  const summary = useMemo(() => {
    const openRoles = deptRows.reduce((acc, r) => acc + r.roles, 0);
    const openPositions = deptRows.reduce((acc, r) => acc + r.openPositions, 0);
    const forecastedHires = deptRows.reduce((acc, r) => acc + r.forecastHires, 0);
    return {
      openRoles,
      openPositions,
      avgTimeToHire: metrics.timeToHire,
      forecastedHires,
    };
  }, [deptRows, metrics.timeToHire]);

  if (loading) {
    return (
      <div className="hfc-loading">
        <div className="hfc-spinner" />
      </div>
    );
  }

  return (
    <div className="hfc-root">
      <div className="hfc-header">
        <div>
          <h2 className="hfc-title">Hiring Forecasts</h2>
          <p className="hfc-sub">Recruitment demand and capacity forecast by department</p>
        </div>
        <div className="hfc-actions">
          <select
            className="hfc-sel"
            value={selectedQuarter}
            onChange={(e) => setSelectedQuarter(e.target.value)}
          >
            {quarterOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button className="hfc-refresh-btn" onClick={loadData}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <div className="hfc-summary">
        <div className="hfc-sum-card">
          <div className="hfc-sum-icon" style={{ background: '#eff6ff', color: '#2563eb' }}><Briefcase size={16} /></div>
          <div><div className="hfc-sum-num">{summary.openRoles}</div><div className="hfc-sum-lbl">Open Roles</div></div>
        </div>
        <div className="hfc-sum-card">
          <div className="hfc-sum-icon" style={{ background: '#fef9c3', color: '#a16207' }}><Users size={16} /></div>
          <div><div className="hfc-sum-num">{summary.openPositions}</div><div className="hfc-sum-lbl">Open Positions</div></div>
        </div>
        <div className="hfc-sum-card">
          <div className="hfc-sum-icon" style={{ background: '#f3e8ff', color: '#7e22ce' }}><CalendarClock size={16} /></div>
          <div><div className="hfc-sum-num">{summary.avgTimeToHire.toFixed(0)}d</div><div className="hfc-sum-lbl">Avg Time to Hire</div></div>
        </div>
        <div className="hfc-sum-card">
          <div className="hfc-sum-icon" style={{ background: '#dcfce7', color: '#15803d' }}><TrendingUp size={16} /></div>
          <div><div className="hfc-sum-num">{summary.forecastedHires}</div><div className="hfc-sum-lbl">Forecasted Hires</div></div>
        </div>
      </div>

      <div className="hfc-chart-card">
        <div className="hfc-card-title">Department Demand Snapshot</div>
        <div className="hfc-metric-strip">
          <span>Offer Acceptance: <strong>{formatPct(metrics.offerAcceptance)}</strong></span>
          <span>Interview to Hire: <strong>{formatPct(metrics.interviewToHire)}</strong></span>
        </div>
        {deptRows.length === 0 ? (
          <div className="hfc-empty">No open requisitions in this period.</div>
        ) : (
          <div className="hfc-bars">
            {deptRows.map((row) => (
              <div key={row.department} className="hfc-bar-row">
                <div className="hfc-bar-label">{row.department}</div>
                <div className="hfc-bar-track">
                  <div
                    className="hfc-bar-fill"
                    style={{ width: `${(row.openPositions / maxOpenPositions) * 100}%` }}
                  />
                </div>
                <div className="hfc-bar-val">{row.openPositions}</div>
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
              <th className="hfc-center">Open Roles</th>
              <th className="hfc-center">Open Positions</th>
              <th className="hfc-center">Pipeline</th>
              <th className="hfc-center">Forecasted Hires</th>
              <th className="hfc-center">Priority</th>
              <th className="hfc-center">Status</th>
            </tr>
          </thead>
          <tbody>
            {deptRows.length === 0 ? (
              <tr className="hfc-row"><td colSpan={7} className="hfc-empty">No data available.</td></tr>
            ) : (
              deptRows.map((row, idx) => (
                <tr key={row.department} className="hfc-row">
                  <td>
                    <div className="hfc-dept-cell">
                      <span className="hfc-dept-dot" style={{ background: ['#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ef4444'][idx % 5] }} />
                      {row.department}
                    </div>
                  </td>
                  <td className="hfc-center">{row.roles}</td>
                  <td className="hfc-center">{row.openPositions}</td>
                  <td className="hfc-center">{row.pipeline}</td>
                  <td className="hfc-center">{row.forecastHires}</td>
                  <td className="hfc-center hfc-priority">{row.priority}</td>
                  <td className="hfc-center">
                    <span className={`hfc-status-badge ${row.status === 'On Track' ? 'hfc-status-ok' : 'hfc-status-risk'}`}>
                      {row.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
