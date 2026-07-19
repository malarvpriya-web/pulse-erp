import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts';
import {
  Users, TrendingUp, CheckCircle, Target,
  RefreshCw, ArrowUpRight, Plus, ChevronRight, Inbox,
} from 'lucide-react';
import api from '@/services/api/client';
import { ChartExpandButton } from '@/components/dashboard/DashCard';
import './SalesDashboard.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

// Axis ticks need to stay short; 0 must not render as "₹0K".
const axisMoney = v => (v ? fmt(v) : '0');

const STAGE_COLORS = {
  Prospecting:   '#6366f1',
  Qualification: '#3b82f6',
  Proposal:      '#f59e0b',
  Negotiation:   '#ef4444',
  Won:           '#10b981',
};

// Categorical hues for zones, in fixed order — a zone keeps its colour no matter
// how the slices rank or which zones a filter leaves behind. Validated for the
// light chart surface (lightness band, chroma floor, CVD separation, contrast).
// "Unassigned" is deliberately a neutral: it is an absence, not a region.
const ZONE_COLORS = {
  North:      '#6B3FDB',
  South:      '#d97706',
  East:       '#0d9488',
  West:       '#db2777',
  Central:    '#0284c7',
  Unassigned: '#9ca3af',
};
const ZONE_ORDER = ['North', 'South', 'East', 'West', 'Central', 'Unassigned'];

// Deal size is ordered, so it gets a sequential ramp (light -> dark), not
// categorical hues. "Unvalued" sits outside the ramp as a neutral.
const RANGE_COLORS = {
  '0-10L':    '#c4b5fd',
  '10-25L':   '#a78bfa',
  '25-50L':   '#8b5cf6',
  '50L+':     '#6B3FDB',
  'Unvalued': '#d1d5db',
};

const WON_COLOR  = '#16a34a';
const LOST_COLOR = '#dc2626';
const BRAND      = '#6B3FDB';

const GRID  = { strokeDasharray: '3 3', stroke: '#f0f0f4' };
const TICK  = { fontSize: 11, fill: '#6b7280' };
const fyLabel = y => `FY ${y}-${String(y + 1).slice(2)}`;

const KPI = ({ icon: IconComp, label, value, sub, color, alert }) => (
  <div className={`csd-kpi${alert ? ' csd-kpi-alert' : ''}`} style={{ '--c': color }}>
    <div className="csd-kpi-icon"><IconComp size={19} /></div>
    <div>
      <p className="csd-kpi-label">{label}</p>
      <h3 className="csd-kpi-val">{value}</h3>
      {sub && <p className="csd-kpi-sub">{sub}</p>}
    </div>
  </div>
);

/** Count / Value switch. Each widget keeps its own, so a funnel by value can sit
 *  next to a monthly trend by count. */
const Seg = ({ value, onChange }) => (
  <div className="csd-seg" role="group" aria-label="Measure">
    {['count', 'value'].map(m => (
      <button
        key={m}
        type="button"
        aria-pressed={value === m}
        className={value === m ? 'csd-seg-on' : ''}
        onClick={() => onChange(m)}
      >
        {m === 'count' ? 'Count' : 'Value'}
      </button>
    ))}
  </div>
);

const Empty = ({ height = 200, title, hint }) => (
  <div className="csd-empty" style={{ height }}>
    <Inbox size={30} strokeWidth={1.2} color="#d1d5db" />
    <p className="csd-empty-t">{title}</p>
    {hint && <p>{hint}</p>}
  </div>
);

const Card = ({ title, span, action, children }) => (
  <div className={`csd-card csd-fc${span}`}>
    <div className="csd-card-hd">
      <span className="csd-card-title">{title}</span>
      <div className="csd-card-hd-r">{action}</div>
    </div>
    <div className="csd-card-body">{children}</div>
  </div>
);

const moneyTip = (v, _n, metric) => (metric === 'value' ? fmt(v) : v);

export default function SalesDashboard({ setPage }) {
  const [stats,   setStats]   = useState(null);
  const [topOpps, setTopOpps] = useState([]);
  const [an,      setAn]      = useState(null);   // lead-analytics payload
  const [loading, setLoading] = useState(false);
  const [anLoading, setAnLoading] = useState(false);
  const [anError,   setAnError]   = useState(false);

  // null => let the server pick the FY (current FY, or the latest one with data)
  const [fy,    setFy]    = useState(null);
  const [owner, setOwner] = useState('');

  // per-widget measure
  const [mFunnel,  setMFunnel]  = useState('count');
  const [mMonth,   setMMonth]   = useState('count');
  const [mUser,    setMUser]    = useState('count');
  const [mWonLost, setMWonLost] = useState('count');
  const [mRange,   setMRange]   = useState('count');
  const [mZone,    setMZone]    = useState('count');

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Stats + top opportunities are not FY-scoped, so they load once.
  const loadBase = useCallback(async () => {
    setLoading(true);
    const [statsRes, oppsRes] = await Promise.allSettled([
      api.get('/crm/stats'),
      api.get('/crm/opportunities'),
    ]);
    if (!isMounted.current) return;

    setStats(statsRes.status === 'fulfilled' ? statsRes.value.data : null);

    const rawOpps = oppsRes.status === 'fulfilled'
      ? (oppsRes.value.data.opportunities || oppsRes.value.data || [])
      : [];
    if (Array.isArray(rawOpps) && rawOpps.length > 0) {
      const active = rawOpps.filter(o => (o.stage || '').toLowerCase() !== 'lost');
      setTopOpps([...active]
        .sort((a, b) => parseFloat(b.expected_value) - parseFloat(a.expected_value))
        .slice(0, 5));
    } else {
      setTopOpps([]);
    }
    setLoading(false);
  }, []);

  const loadAnalytics = useCallback(async () => {
    setAnLoading(true);
    setAnError(false);
    const params = {};
    if (fy    != null) params.fy = fy;
    if (owner !== '')  params.assigned_to = owner;
    try {
      const res = await api.get('/crm/analytics/lead-dashboard', { params });
      if (isMounted.current) setAn(res.data || null);
    } catch {
      // Keep this distinct from "no leads" — an empty chart and a failed request
      // look identical otherwise.
      if (isMounted.current) { setAn(null); setAnError(true); }
    } finally {
      if (isMounted.current) setAnLoading(false);
    }
  }, [fy, owner]);

  useEffect(() => { loadBase(); }, [loadBase]);
  useEffect(() => { loadAnalytics(); }, [loadAnalytics]);

  const refresh = () => { loadBase(); loadAnalytics(); };

  const s = stats || {};

  // The selector shows every FY with pipeline plus the current one, newest first.
  const fyChoices = useMemo(() => {
    const set = new Set(an?.fy_options || []);
    if (an?.current_fy) set.add(an.current_fy);
    if (fy != null) set.add(fy);
    return [...set].sort((a, b) => b - a);
  }, [an, fy]);

  // Server resolves the FY on first load; mirror it into the selector.
  const selectedFy = fy ?? an?.fy ?? '';

  const funnel   = an?.funnel   || [];
  const monthly  = an?.monthly  || [];
  const byUser   = an?.by_user  || [];
  const wonLost  = an?.won_lost || [];
  const byRange  = an?.by_range || [];
  const byZone   = an?.by_zone  || [];
  const owners   = an?.owners   || [];

  const hasFunnel  = funnel.some(f  => f[mFunnel] > 0);
  const hasMonthly = monthly.some(m => m[mMonth]  > 0);
  const hasUser    = byUser.some(u  => u[mUser]   > 0);
  const hasWonLost = wonLost.some(w => w.won_count || w.lost_count);
  const hasRange   = byRange.some(r => r[mRange]  > 0);
  const hasZone    = byZone.some(z  => z[mZone]   > 0);

  // Fixed zone order so a slice keeps its position (and colour) as filters change.
  // Anything unrecognised sorts last rather than jumping to the front.
  const zoneRank = z => { const i = ZONE_ORDER.indexOf(z); return i === -1 ? 99 : i; };
  const zoneData = useMemo(() => (
    [...byZone].filter(z => z[mZone] > 0).sort((a, b) => zoneRank(a.zone) - zoneRank(b.zone))
  ), [byZone, mZone]);

  /* ── charts ──────────────────────────────────────────────────────────────── */

  const funnelChart = h => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={funnel} layout="vertical" margin={{ top: 4, right: 56, left: 4, bottom: 4 }}>
        <CartesianGrid {...GRID} horizontal={false} />
        <XAxis type="number" tick={TICK} tickFormatter={mFunnel === 'value' ? axisMoney : undefined} />
        <YAxis type="category" dataKey="stage" tick={{ ...TICK, fontSize: 12 }} width={92} />
        <Tooltip
          cursor={{ fill: 'rgba(107,63,219,0.05)' }}
          formatter={v => [moneyTip(v, null, mFunnel), mFunnel === 'value' ? 'Value' : 'Deals']}
        />
        <Bar dataKey={mFunnel} radius={[0, 4, 4, 0]} barSize={20}>
          {funnel.map(f => <Cell key={f.stage} fill={STAGE_COLORS[f.stage] || BRAND} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const monthlyChart = h => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={monthly} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid {...GRID} vertical={false} />
        {/* 12 FY months: let recharts thin the labels rather than overlap them */}
        <XAxis dataKey="month" tick={{ ...TICK, fontSize: 10 }} />
        <YAxis tick={TICK} tickFormatter={mMonth === 'value' ? axisMoney : undefined} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'rgba(107,63,219,0.05)' }}
          formatter={v => [moneyTip(v, null, mMonth), mMonth === 'value' ? 'Lead value' : 'Leads']}
        />
        <Bar dataKey={mMonth} fill={BRAND} radius={[4, 4, 0, 0]} maxBarSize={34} />
      </BarChart>
    </ResponsiveContainer>
  );

  const userChart = h => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={byUser} layout="vertical" margin={{ top: 4, right: 56, left: 4, bottom: 4 }}>
        <CartesianGrid {...GRID} horizontal={false} />
        <XAxis type="number" tick={TICK} tickFormatter={mUser === 'value' ? axisMoney : undefined} allowDecimals={false} />
        <YAxis type="category" dataKey="name" tick={{ ...TICK, fontSize: 11.5 }} width={130} />
        <Tooltip
          cursor={{ fill: 'rgba(107,63,219,0.05)' }}
          formatter={v => [moneyTip(v, null, mUser), mUser === 'value' ? 'Lead value' : 'Leads']}
        />
        <Bar dataKey={mUser} fill={BRAND} radius={[0, 4, 4, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );

  const wonLostChart = h => {
    const wonKey  = mWonLost === 'value' ? 'won_value'  : 'won_count';
    const lostKey = mWonLost === 'value' ? 'lost_value' : 'lost_count';
    return (
      <ResponsiveContainer width="100%" height={h}>
        <BarChart data={wonLost} margin={{ top: 4, right: 8, left: 0, bottom: 4 }} barGap={2}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="month" tick={{ ...TICK, fontSize: 10 }} />
          <YAxis tick={TICK} tickFormatter={mWonLost === 'value' ? axisMoney : undefined} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: 'rgba(107,63,219,0.05)' }}
            formatter={v => moneyTip(v, null, mWonLost)}
          />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11.5, paddingTop: 4 }} />
          <Bar dataKey={wonKey}  name="Won"  fill={WON_COLOR}  radius={[4, 4, 0, 0]} maxBarSize={16} />
          <Bar dataKey={lostKey} name="Lost" fill={LOST_COLOR} radius={[4, 4, 0, 0]} maxBarSize={16} />
        </BarChart>
      </ResponsiveContainer>
    );
  };

  const rangeChart = h => (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={byRange} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid {...GRID} vertical={false} />
        <XAxis dataKey="bucket" tick={{ ...TICK, fontSize: 10.5 }} interval={0} />
        <YAxis tick={TICK} tickFormatter={mRange === 'value' ? axisMoney : undefined} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'rgba(107,63,219,0.05)' }}
          formatter={v => [moneyTip(v, null, mRange), mRange === 'value' ? 'Value' : 'Leads']}
        />
        <Bar dataKey={mRange} radius={[4, 4, 0, 0]} maxBarSize={44}>
          {byRange.map(r => <Cell key={r.bucket} fill={RANGE_COLORS[r.bucket] || BRAND} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );

  const zoneChart = h => {
    const big = h > 300;
    return (
      <ResponsiveContainer width="100%" height={h}>
        <PieChart>
          <Pie
            data={zoneData}
            dataKey={mZone}
            nameKey="zone"
            cx="50%"
            cy="50%"
            innerRadius={big ? 88 : 46}
            outerRadius={big ? 140 : 74}
            paddingAngle={2}
            stroke="#fff"
            strokeWidth={2}
            labelLine={false}
            // Direct labels only where they fit; the small card leans on legend + tooltip.
            label={big ? ({ zone, [mZone]: v }) => `${zone} ${mZone === 'value' ? fmt(v) : v}` : false}
          >
            {zoneData.map(z => <Cell key={z.zone} fill={ZONE_COLORS[z.zone] || '#9ca3af'} />)}
          </Pie>
          <Tooltip formatter={(v, n) => [moneyTip(v, n, mZone), n]} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11.5 }} />
        </PieChart>
      </ResponsiveContainer>
    );
  };

  const busy = anLoading && !an;

  // Returns a placeholder when a chart can't be drawn, or null to draw it.
  const placeholder = (has, height, title, hint) => {
    if (busy)    return <Empty height={height} title="Loading…" />;
    if (anError) return <Empty height={height} title="Couldn't load lead analytics" hint="Use refresh to try again." />;
    if (!has)    return <Empty height={height} title={title} hint={hint} />;
    return null;
  };

  const fySub = selectedFy ? fyLabel(selectedFy) : '';

  return (
    <div className="csd-root">

      {/* header */}
      <div className="csd-header">
        <div>
          <h2 className="csd-title">CRM Dashboard</h2>
          <p className="csd-sub">Sales pipeline overview &amp; lead performance</p>
        </div>
        <div className="csd-header-r">
          <button className="csd-btn-outline" onClick={() => setPage && setPage('Leads')}>
            All Leads <ChevronRight size={13} />
          </button>
          <button className="csd-btn-primary" onClick={() => setPage && setPage('Leads')}>
            <Plus size={14} /> New Lead
          </button>
          <button className="csd-icon-btn" onClick={refresh} aria-label="Refresh"><RefreshCw size={14} /></button>
        </div>
      </div>

      {/* filters */}
      <div className="csd-filters">
        <div className="csd-filter">
          <label className="csd-filter-lbl" htmlFor="csd-fy">Financial Year</label>
          <select
            id="csd-fy"
            className="csd-select"
            value={selectedFy}
            onChange={e => setFy(Number(e.target.value))}
          >
            {fyChoices.length === 0 && <option value="">—</option>}
            {fyChoices.map(y => (
              <option key={y} value={y}>
                {fyLabel(y)}{y === an?.current_fy ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="csd-filter">
          <label className="csd-filter-lbl" htmlFor="csd-owner">Salesperson</label>
          <select
            id="csd-owner"
            className="csd-select"
            value={owner}
            onChange={e => setOwner(e.target.value)}
          >
            <option value="">All salespeople</option>
            {owners.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>

        {!anLoading && owners.length === 0 && (
          <span className="csd-filter-note">No leads have an owner assigned yet</span>
        )}
        {anLoading && <span className="csd-filter-note">Updating…</span>}
      </div>

      {/* KPIs */}
      <div className="csd-kpis">
        <KPI icon={Users}       label="Total Leads"     value={s.total_leads ?? 0}    color="#6366f1" sub={`${s.leads_this_month ?? 0} this month`} />
        <KPI icon={TrendingUp}  label="Pipeline Value"  value={fmt(s.pipeline_value)} color="#3b82f6"
          sub={s.pipeline_change != null
            ? `${s.pipeline_change >= 0 ? '+' : ''}${s.pipeline_change}% vs last month`
            : 'No prior month data'} />
        <KPI icon={CheckCircle} label="Won Deals"       value={s.won_deals ?? 0}      color="#10b981" sub="Closed won" />
        <KPI icon={Target}      label="Conversion Rate" value={s.conversion_rate != null ? `${s.conversion_rate}%` : 'N/A'} color="#f59e0b" sub="Leads converted" />
      </div>

      <div className="csd-grid">

        {/* pipeline funnel — count | value */}
        <Card
          title="Pipeline Funnel"
          span={7}
          action={<>
            <Seg value={mFunnel} onChange={setMFunnel} />
            {hasFunnel && (
              <ChartExpandButton title="Pipeline Funnel" subtitle={`Open pipeline by stage · ${fySub}`}>
                {funnelChart(420)}
              </ChartExpandButton>
            )}
          </>}
        >
          {placeholder(hasFunnel, 240, 'No open pipeline', 'Move leads into an active stage to see the funnel.') ?? (
            <>
              {funnelChart(200)}
              <div className="csd-funnel-legend">
                {funnel.map(f => (
                  <div key={f.stage} className="csd-funnel-row">
                    <span className="csd-funnel-dot" style={{ background: STAGE_COLORS[f.stage] || BRAND }} />
                    <span className="csd-funnel-stage">{f.stage}</span>
                    <span className="csd-funnel-count">{f.count} deals</span>
                    <span className="csd-funnel-val">{fmt(f.value)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        {/* top opportunities */}
        <div className="csd-card csd-fc5">
          <div className="csd-card-hd">
            <span className="csd-card-title">Top Opportunities</span>
            <button className="csd-text-btn" onClick={() => setPage && setPage('OpportunitiesKanban')}>
              View All <ArrowUpRight size={12} />
            </button>
          </div>
          <div className="csd-card-body csd-top-opps">
            {loading ? <Empty height={200} title="Loading…" />
              : topOpps.length === 0 ? <Empty height={200} title="No open opportunities" />
              : topOpps.map((o, i) => {
                const color = STAGE_COLORS[o.stage] || '#6b7280';
                return (
                  <div key={o.id || i} className="csd-opp-row">
                    <div className="csd-opp-rank">{i + 1}</div>
                    <div className="csd-opp-info">
                      <span className="csd-opp-name">{o.opportunity_name}</span>
                      <span className="csd-opp-company">{o.company_name}</span>
                    </div>
                    <div className="csd-opp-right">
                      <span className="csd-opp-val">{fmt(o.expected_value)}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="csd-badge" style={{ background: color + '20', color }}>{o.stage}</span>
                        <span className="csd-opp-pct">{o.probability_percentage}%</span>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        {/* leads each month — count | value */}
        <Card
          title="Leads by Month"
          span={7}
          action={<>
            <Seg value={mMonth} onChange={setMMonth} />
            {hasMonthly && (
              <ChartExpandButton title="Leads by Month" subtitle={fySub}>
                {monthlyChart(420)}
              </ChartExpandButton>
            )}
          </>}
        >
          {placeholder(hasMonthly, 210, 'No leads this financial year', 'Pick another FY, or capture a lead.')
            ?? monthlyChart(210)}
        </Card>

        {/* leads by zone — count | value */}
        <Card
          title="Leads by Zone"
          span={5}
          action={<>
            <Seg value={mZone} onChange={setMZone} />
            {hasZone && (
              <ChartExpandButton title="Leads by Zone" subtitle={`Regional split · ${fySub}`}>
                {zoneChart(420)}
              </ChartExpandButton>
            )}
          </>}
        >
          {placeholder(hasZone, 210, 'No zone data', 'Set a zone on a lead to see the regional split.')
            ?? zoneChart(210)}
        </Card>

        {/* won vs lost — count | value */}
        <Card
          title="Leads Won vs Lost"
          span={7}
          action={<>
            <Seg value={mWonLost} onChange={setMWonLost} />
            {hasWonLost && (
              <ChartExpandButton title="Leads Won vs Lost" subtitle={`Monthly outcome · ${fySub}`}>
                {wonLostChart(420)}
              </ChartExpandButton>
            )}
          </>}
        >
          {placeholder(hasWonLost, 210, 'No won or lost leads yet', 'Outcomes appear once leads are marked won or lost.')
            ?? wonLostChart(210)}
        </Card>

        {/* leads by deal-size range — count | value */}
        <Card
          title="Leads by Deal Size"
          span={5}
          action={<>
            <Seg value={mRange} onChange={setMRange} />
            {hasRange && (
              <ChartExpandButton title="Leads by Deal Size" subtitle={`Bucketed by lead value · ${fySub}`}>
                {rangeChart(420)}
              </ChartExpandButton>
            )}
          </>}
        >
          {placeholder(hasRange, 210, 'No valued leads', 'Add an estimated value, or link an opportunity.')
            ?? rangeChart(210)}
        </Card>

        {/* leads per salesperson — count | value */}
        <Card
          title="Leads by Salesperson"
          span={12}
          action={<>
            <Seg value={mUser} onChange={setMUser} />
            {hasUser && (
              <ChartExpandButton title="Leads by Salesperson" subtitle={fySub}>
                {userChart(460)}
              </ChartExpandButton>
            )}
          </>}
        >
          {placeholder(hasUser, 200, 'No leads to attribute', 'Assign leads to a salesperson to compare performance.')
            ?? userChart(Math.max(160, byUser.length * 30 + 40))}
        </Card>

        {/* quick nav cards */}
        <div className="csd-fc12 csd-nav-cards">
          {[
            { label: 'Leads',    sub: `${s.total_leads ?? 0} total`,        page: 'Leads',               color: '#6366f1', Icon: Users },
            { label: 'Pipeline', sub: fmt(s.pipeline_value),                page: 'OpportunitiesKanban', color: '#3b82f6', Icon: TrendingUp },
            { label: 'Accounts', sub: `${s.total_accounts ?? 0} companies`, page: 'Accounts',            color: '#10b981', Icon: CheckCircle },
            { label: 'Contacts', sub: `${s.total_contacts ?? 0} contacts`,  page: 'Contacts',            color: '#f59e0b', Icon: Target },
          ].map(({ label, sub, page, color, Icon: NavIcon }) => (
            <div key={label} className="csd-nav-card" onClick={() => setPage && setPage(page)} style={{ '--c': color }}>
              <div className="csd-nav-icon"><NavIcon size={20} /></div>
              <span className="csd-nav-label">{label}</span>
              <span className="csd-nav-sub">{sub}</span>
              <ChevronRight size={14} className="csd-nav-arrow" />
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
