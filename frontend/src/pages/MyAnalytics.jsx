import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Calendar, Plane, Wallet, Clock, Layers, TrendingUp, RefreshCw, AlertCircle,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '../services/api/client';
import {
  VizCard, TrendArea, StackedBars, RoundBars, Donut, DonutLegend, PULSE_SERIES,
} from '@/components/charts/PulseViz';
import DataTable from '@/components/core/DataTable';

// Roles allowed to drill into another employee (mirrors backend PRIVILEGED_ROLES).
const DRILL_ROLES = new Set([
  'admin', 'super_admin', 'manager', 'hr', 'HR Manager',
  'hr_manager', 'hr_exec', 'Finance Manager', 'Project Manager',
]);

function fmtINR(n) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(Number(n) || 0);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── Metric card ──────────────────────────────────────────────────────────────
function MetricCard({ icon, color, label, value, sub, loading }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #eee9fb', borderRadius: 12,
      padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 220,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: color + '18', color,
      }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>{label}</div>
        {loading ? (
          <div style={{ height: 22, width: 90, marginTop: 4, borderRadius: 6,
            background: 'linear-gradient(90deg,#f3f4f6 25%,#e5e7eb 50%,#f3f4f6 75%)',
            backgroundSize: '200% 100%', animation: 'ma-shimmer 1.4s infinite' }} />
        ) : (
          <>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>{value}</div>
            {sub && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 1 }}>{sub}</div>}
          </>
        )}
      </div>
    </div>
  );
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 5 }, (_, i) => CURRENT_YEAR - i);
const selectStyle = {
  padding: '7px 12px', border: '1px solid #e9e4ff', borderRadius: 8,
  fontSize: 13, color: '#374151', background: '#fff', fontFamily: 'inherit', cursor: 'pointer',
};

export default function MyAnalytics() {
  const { user, role } = useAuth();
  const canDrill = DRILL_ROLES.has(role);

  const [year, setYear]         = useState(CURRENT_YEAR);
  const [empId, setEmpId]       = useState(user?.employee_id ?? null);
  const [dept, setDept]         = useState('');
  const [filters, setFilters]   = useState({ departments: [], users: [], self: user?.employee_id ?? null });

  const [summary, setSummary]       = useState(null);
  const [timeLogged, setTimeLogged] = useState([]);
  const [byType, setByType]         = useState({ categories: [], data: [] });
  const [travelMonth, setTravelMonth] = useState([]);
  const [leaveMonth, setLeaveMonth]   = useState([]);
  const [leaveStats, setLeaveStats]   = useState({ total: 0, breakdown: [] });
  const [missed, setMissed]           = useState([]);

  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  // Missed-timesheet table: client-side search / sort / pagination.
  const [msSearch, setMsSearch] = useState('');
  const [msSort, setMsSort]     = useState({ key: 'date', dir: 'desc' });
  const [msPage, setMsPage]     = useState(1);
  const MS_PAGE_SIZE = 12;

  const abortRef = useRef(null);

  // Resolve the effective employee: privileged users may drill, others = self.
  const effectiveEmpId = canDrill ? empId : (filters.self ?? user?.employee_id ?? null);

  // Load filter options once (departments + users). Non-privileged → empty.
  useEffect(() => {
    let alive = true;
    api.get('/user-dashboard/filters')
      .then(({ data }) => {
        if (!alive) return;
        setFilters(data || { departments: [], users: [], self: user?.employee_id ?? null });
        setEmpId(prev => prev ?? data?.self ?? user?.employee_id ?? null);
      })
      .catch(() => { /* non-fatal — view falls back to self */ });
    return () => { alive = false; };
  }, [user]);

  const loadData = useCallback(async () => {
    const eid = effectiveEmpId;
    if (!eid) { setLoading(false); setError('no_employee'); return; }
    setLoading(true);
    setError(null);

    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const cfg = { params: { year, employee_id: eid }, signal: ctrl.signal };

    const [sum, tl, bt, tm, lm, ls, ms] = await Promise.allSettled([
      api.get('/user-dashboard/summary', cfg),
      api.get('/user-dashboard/time-logged', cfg),
      api.get('/user-dashboard/time-by-type', cfg),
      api.get('/user-dashboard/travel-by-month', cfg),
      api.get('/user-dashboard/leave-by-month', cfg),
      api.get('/user-dashboard/leave-stats', cfg),
      api.get('/user-dashboard/missed-timesheets', { ...cfg, params: { ...cfg.params, limit: 400 } }),
    ]);

    if (ctrl.signal.aborted) return;

    if (sum.status === 'fulfilled') setSummary(sum.value.data);
    if (tl.status  === 'fulfilled') setTimeLogged(tl.value.data || []);
    if (bt.status  === 'fulfilled') setByType(bt.value.data || { categories: [], data: [] });
    if (tm.status  === 'fulfilled') setTravelMonth(tm.value.data || []);
    if (lm.status  === 'fulfilled') setLeaveMonth(lm.value.data || []);
    if (ls.status  === 'fulfilled') setLeaveStats(ls.value.data || { total: 0, breakdown: [] });
    if (ms.status  === 'fulfilled') setMissed(ms.value.data?.rows || []);

    if ([sum, tl, bt, tm, lm, ls, ms].every(r => r.status === 'rejected')) setError('load_failed');
    setLoading(false);
    setMsPage(1);
  }, [effectiveEmpId, year]);

  useEffect(() => { loadData(); return () => abortRef.current?.abort(); }, [loadData]);

  // ── Missed-timesheet derived rows ──
  const missedView = useMemo(() => {
    const q = msSearch.trim().toLowerCase();
    let rows = q
      ? missed.filter(m => m.name?.toLowerCase().includes(q) || m.date?.includes(q))
      : missed.slice();
    rows.sort((a, b) => {
      const av = a[msSort.key] ?? '', bv = b[msSort.key] ?? '';
      const cmp = String(av).localeCompare(String(bv));
      return msSort.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [missed, msSearch, msSort]);

  const missedPage = missedView.slice((msPage - 1) * MS_PAGE_SIZE, msPage * MS_PAGE_SIZE);

  const toggleMsSort = (key) =>
    setMsSort(s => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });

  // Users filtered by selected department (for the user dropdown).
  const usersInDept = dept ? filters.users.filter(u => u.department === dept) : filters.users;

  // ── Leave-stats donut data (drops rejected from the ring, keeps it in legend) ──
  const leaveDonut = (leaveStats.breakdown || []).filter(b => b.key !== 'rejected' && b.value > 0);
  const rejected = (leaveStats.breakdown || []).find(b => b.key === 'rejected');

  const leaveKpi = summary?.leaves || {};
  const travelDaysKpi = summary?.travel_days || {};
  const travelCostKpi = summary?.travel_cost || {};

  return (
    <div className="pulse-page" style={{ padding: 24, background: 'var(--color-bg-page, #f8f9fc)' }}>
      <style>{`@keyframes ma-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>

      {/* ── Header + filters ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>My Analytics</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            {canDrill && empId && empId !== filters.self
              ? `Viewing ${filters.users.find(u => u.id === empId)?.name || `employee ${empId}`}`
              : 'Your time, travel and leave — full-year view'}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Year */}
          <select value={year} onChange={e => setYear(Number(e.target.value))} style={selectStyle} title="Year">
            {YEAR_OPTIONS.map(y => <option key={y} value={y}>{y}</option>)}
          </select>

          {/* Department + User — privileged roles only */}
          {canDrill && filters.users.length > 0 && (
            <>
              <select value={dept} onChange={e => { setDept(e.target.value); }} style={selectStyle} title="Department">
                <option value="">All departments</option>
                {filters.departments.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
              <select value={empId ?? ''} onChange={e => setEmpId(Number(e.target.value))} style={selectStyle} title="Employee">
                {filters.self && <option value={filters.self}>Me</option>}
                {usersInDept.filter(u => u.id !== filters.self).map(u => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </>
          )}

          <button onClick={loadData} disabled={loading} style={{
            display: 'flex', alignItems: 'center', gap: 5, background: '#fff',
            border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 12px',
            cursor: loading ? 'default' : 'pointer', fontSize: 12, color: '#6B3FDB', fontFamily: 'inherit',
          }}>
            <RefreshCw size={13} style={{ animation: loading ? 'ed-spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>
      </div>

      {error === 'no_employee' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#b91c1c', fontSize: 13, marginBottom: 16 }}>
          <AlertCircle size={16} /> Your login isn’t linked to an employee record — ask HR to link your account.
        </div>
      )}

      {/* ── Metric cards ── */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 18 }}>
        <MetricCard icon={<Calendar size={22} />} color="#6366f1" label="Leaves Taken" loading={loading}
          value={`${leaveKpi.total ?? 0} days`} sub={`avg ${leaveKpi.avg_per_month ?? 0} / month`} />
        <MetricCard icon={<Plane size={22} />} color="#0ea5e9" label="Travel Days" loading={loading}
          value={`${travelDaysKpi.total ?? 0} days`} sub={`avg ${travelDaysKpi.avg_per_month ?? 0} / month`} />
        <MetricCard icon={<Wallet size={22} />} color="#10b981" label="Travel Cost" loading={loading}
          value={fmtINR(travelCostKpi.total)} sub={`avg ${fmtINR(travelCostKpi.avg_per_day)} / day`} />
      </div>

      {/* ── Charts row 1 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14, marginBottom: 14 }}>
        <VizCard title="Time Logged" subtitle={`Hours per week · ${year}`} icon={<Clock size={15} />}
          loading={loading} empty={!loading && timeLogged.every(w => w.value === 0)} emptyText="No hours logged this year">
          <TrendArea data={timeLogged} xKey="label" yKey="value" name="Hours" height={230} />
        </VizCard>

        <VizCard title="Time by Task Type" subtitle="Hours per week, by project" icon={<Layers size={15} />}
          loading={loading} empty={!loading && byType.categories.length === 0} emptyText="No timesheet data">
          <StackedBars data={byType.data} xKey="label" categories={byType.categories} height={230} />
        </VizCard>
      </div>

      {/* ── Charts row 2 ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14, marginBottom: 14 }}>
        <VizCard title="Travel Expense" subtitle={`By month · ${year}`} icon={<Wallet size={15} />}
          loading={loading} empty={!loading && travelMonth.every(m => m.value === 0)} emptyText="No travel expense recorded">
          <RoundBars data={travelMonth} xKey="label" yKey="value" name="Amount" currency height={220} />
        </VizCard>

        <VizCard title="Leave by Month" subtitle={`Approved days · ${year}`} icon={<Calendar size={15} />}
          loading={loading} empty={!loading && leaveMonth.every(m => m.value === 0)} emptyText="No approved leave this year">
          <RoundBars data={leaveMonth} xKey="label" yKey="value" name="Days" multiColor height={220} />
        </VizCard>
      </div>

      {/* ── Missed timesheet + Leave statistics ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)', gap: 14 }}>
        <VizCard title="Missed Timesheet Entries" subtitle="Working days with no logged time" icon={<AlertCircle size={15} />}
          loading={loading}
          action={
            <input value={msSearch} onChange={e => { setMsSearch(e.target.value); setMsPage(1); }}
              placeholder="Search name or date…"
              style={{ padding: '6px 10px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 12, width: 180, fontFamily: 'inherit' }} />
          }>
          <DataTable
            columns={[
              { key: 'name', label: 'Name', sortable: true },
              { key: 'date', label: 'Date', sortable: true, render: (v) => fmtDate(v) },
            ]}
            rows={missedPage}
            sort={msSort}
            onSort={toggleMsSort}
            page={msPage}
            pageSize={MS_PAGE_SIZE}
            totalCount={missedView.length}
            onPageChange={setMsPage}
            selectable={false}
            emptyText="🎉 No missed entries — every working day is logged"
          />
        </VizCard>

        <VizCard title="Leave Statistics" subtitle={`${leaveStats.total} days taken · ${year}`} icon={<TrendingUp size={15} />}
          loading={loading} empty={!loading && leaveStats.total === 0 && (!rejected || rejected.value === 0)}
          emptyText="No leave activity this year">
          <Donut data={leaveDonut} centerLabel="Days taken" centerValue={leaveStats.total} height={180} />
          <DonutLegend data={leaveStats.breakdown} max={4} />
        </VizCard>
      </div>
    </div>
  );
}
