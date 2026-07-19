import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Shield, Search, RefreshCw, Download, ChevronRight,
  Plus, Edit2, Trash2, CheckCircle, XCircle, LogIn, LogOut,
  Eye, FileText, Activity, Clock, User, Monitor, Hash,
  AlertTriangle, Database,
} from 'lucide-react';
import api from '@/services/api/client';
import './AuditLogs.css';

// ── FY helpers ────────────────────────────────────────────────────────────────
function getFYOptions() {
  const now  = new Date();
  const year = now.getFullYear();
  const mon  = now.getMonth(); // 0-based; April = 3
  // current FY end year: if Apr–Dec → FY(year+1); Jan–Mar → FY(year)
  const curFYEnd = mon >= 3 ? year + 1 : year;
  return Array.from({ length: 5 }, (_, i) => {
    const fyEnd   = curFYEnd - i;
    const fyStart = fyEnd - 1;
    return {
      label    : `FY${String(fyEnd).slice(-2)}`,
      start    : `${fyStart}-04-01`,
      end      : `${fyEnd}-03-31`,
      key      : `FY${fyEnd}`,
      isCurrent: i === 0,
    };
  });
}
const FY_OPTIONS = getFYOptions();

// ── Action config ─────────────────────────────────────────────────────────────
const ACTION_CFG = {
  CREATE  : { icon: Plus,         color: '#10b981', bg: '#f0fdf4', label: 'Create',  risk: 'low'    },
  UPDATE  : { icon: Edit2,        color: '#3b82f6', bg: '#eff6ff', label: 'Update',  risk: 'low'    },
  DELETE  : { icon: Trash2,       color: '#ef4444', bg: '#fef2f2', label: 'Delete',  risk: 'high'   },
  APPROVE : { icon: CheckCircle,  color: '#059669', bg: '#ecfdf5', label: 'Approve', risk: 'medium' },
  REJECT  : { icon: XCircle,      color: '#f59e0b', bg: '#fffbeb', label: 'Reject',  risk: 'medium' },
  LOGIN   : { icon: LogIn,        color: '#6366f1', bg: '#eef2ff', label: 'Login',   risk: 'low'    },
  LOGOUT  : { icon: LogOut,       color: '#8b5cf6', bg: '#f5f3ff', label: 'Logout',  risk: 'low'    },
  VIEW    : { icon: Eye,          color: '#0ea5e9', bg: '#f0f9ff', label: 'View',    risk: 'info'   },
  EXPORT  : { icon: Download,     color: '#d97706', bg: '#fffbeb', label: 'Export',  risk: 'medium' },
  IMPORT  : { icon: Database,     color: '#6B3FDB', bg: '#f5f3ff', label: 'Import',  risk: 'medium' },
  default : { icon: Activity,     color: '#6b7280', bg: '#f9fafb', label: '—',       risk: 'info'   },
};

const RISK_CFG = {
  high:   { label: 'HIGH',   bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
  medium: { label: 'MED',    bg: '#fffbeb', color: '#d97706', border: '#fde68a' },
  low:    { label: 'LOW',    bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
  info:   { label: 'INFO',   bg: '#f0f9ff', color: '#0284c7', border: '#bae6fd' },
};

function getActionCfg(type = '') {
  return ACTION_CFG[type.toUpperCase()] || ACTION_CFG.default;
}

// ── Module color hash ─────────────────────────────────────────────────────────
const MOD_COLORS = [
  { bg:'#eff6ff', color:'#1d4ed8' }, { bg:'#f0fdf4', color:'#15803d' },
  { bg:'#fdf4ff', color:'#9333ea' }, { bg:'#fff7ed', color:'#c2410c' },
  { bg:'#f0fdfa', color:'#0f766e' }, { bg:'#fefce8', color:'#a16207' },
  { bg:'#fef2f2', color:'#b91c1c' }, { bg:'#f8fafc', color:'#334155' },
];
function modColor(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return MOD_COLORS[h % MOD_COLORS.length];
}

// ── Time ago ──────────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)  return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

// ── JSON formatter ────────────────────────────────────────────────────────────
function fmtJson(val) {
  if (!val) return null;
  try {
    const obj = typeof val === 'string' ? JSON.parse(val) : val;
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(val);
  }
}

// ── Export CSV ────────────────────────────────────────────────────────────────
function exportCSV(logs) {
  const hdr = ['ID','Timestamp','User','Module','Action','Reference Type','Reference ID','IP Address'];
  const rows = logs.map(l => [
    l.id,
    new Date(l.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }),
    l.user_name || 'System',
    l.module_name || '',
    (l.action_type || '').toUpperCase(),
    l.reference_type || '',
    l.reference_id || '',
    l.ip_address || '',
  ]);
  const csv = [hdr, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  const a   = Object.assign(document.createElement('a'), { href:url, download:`audit-logs-${Date.now()}.csv` });
  a.click(); URL.revokeObjectURL(url);
}

const PAGE_SIZE = 50;

// ── KPI card ──────────────────────────────────────────────────────────────────
function KpiCard({ icon: Icon, label, value, color, bg }) {
  return (
    <div className="al-kpi">
      <div className="al-kpi-icon" style={{ background: bg, color }}>
        <Icon size={20} />
      </div>
      <div>
        <div className="al-kpi-val">{value ?? '—'}</div>
        <div className="al-kpi-label">{label}</div>
      </div>
    </div>
  );
}

// ── Log entry row ─────────────────────────────────────────────────────────────
function LogEntry({ log, expanded, onToggle }) {
  const cfg  = getActionCfg(log.action_type);
  const Icon = cfg.icon;
  const mc   = modColor(log.module_name || '');
  const hasDetail = log.old_data_json || log.new_data_json;
  const riskCfg = RISK_CFG[cfg.risk] || RISK_CFG.info;

  return (
    <>
      <div
        className={`al-entry${expanded ? ' al-entry-expanded' : ''}${cfg.risk === 'high' ? ' al-entry-high-risk' : ''}`}
        onClick={onToggle}
      >
        <div className="al-entry-icon" style={{ background: cfg.bg, color: cfg.color }}>
          <Icon size={16} />
        </div>
        <div className="al-entry-body">
          <div className="al-entry-top">
            <span className="al-action-badge" style={{ background: cfg.bg, color: cfg.color }}>
              {(log.action_type || 'UNKNOWN').toUpperCase()}
            </span>
            <span className="al-module-badge" style={{ background: mc.bg, color: mc.color }}>
              {log.module_name || 'System'}
            </span>
            {log.reference_type && (
              <span style={{ fontSize:11, color:'#9ca3af' }}>
                {log.reference_type}{log.reference_id ? ` #${log.reference_id}` : ''}
              </span>
            )}
            <span
              className="al-risk-badge"
              style={{ background: riskCfg.bg, color: riskCfg.color, borderColor: riskCfg.border }}
            >
              {riskCfg.label}
            </span>
          </div>
          <div className="al-entry-desc">
            <strong>{log.user_name || 'System'}</strong>
            {' performed '}
            <strong>{(log.action_type || 'action').toLowerCase()}</strong>
            {log.module_name ? ` in ${log.module_name}` : ''}
            {log.reference_type ? ` on ${log.reference_type}` : ''}
          </div>
          <div className="al-entry-meta">
            <span className="al-meta-item"><Clock size={11}/>{timeAgo(log.created_at)}</span>
            <span className="al-meta-item" title={new Date(log.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}>
              <FileText size={11}/>{new Date(log.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
            {log.ip_address && (
              <span className="al-meta-item"><Monitor size={11}/>{log.ip_address}</span>
            )}
            {log.user_id && (
              <span className="al-meta-item"><User size={11}/>ID: {log.user_id}</span>
            )}
          </div>
        </div>
        {hasDetail && (
          <ChevronRight
            size={15}
            className={`al-entry-chevron${expanded ? ' open' : ''}`}
          />
        )}
      </div>

      {expanded && hasDetail && (
        <div className="al-detail">
          <div className="al-detail-meta">
            <div className="al-detail-meta-item">
              <strong>Log ID:</strong> #{log.id}
            </div>
            <div className="al-detail-meta-item">
              <strong>Timestamp:</strong> {new Date(log.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </div>
            {log.user_agent && (
              <div className="al-detail-meta-item">
                <strong>User Agent:</strong> {log.user_agent.slice(0, 80)}{log.user_agent.length > 80 ? '…' : ''}
              </div>
            )}
          </div>
          <div className="al-detail-grid">
            <div className="al-detail-block">
              <div className="al-detail-block-label">Before (old values)</div>
              {log.old_data_json
                ? <pre className="al-detail-json">{fmtJson(log.old_data_json)}</pre>
                : <div className="al-detail-empty">No previous state recorded</div>
              }
            </div>
            <div className="al-detail-block">
              <div className="al-detail-block-label">After (new values)</div>
              {log.new_data_json
                ? <pre className="al-detail-json">{fmtJson(log.new_data_json)}</pre>
                : <div className="al-detail-empty">No new state recorded</div>
              }
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function AuditLogs() {
  const [logs,      setLogs]      = useState([]);
  const [stats,     setStats]     = useState(null);
  const [total,     setTotal]     = useState(0);
  const [loading,   setLoading]   = useState(false);
  const [page,      setPage]      = useState(0);
  const [expanded,  setExpanded]  = useState(null);

  // filters
  const [search,     setSearch]     = useState('');
  const [module,     setModule]     = useState('');
  const [actionType, setActionType] = useState('');
  const [startDate,  setStartDate]  = useState('');
  const [endDate,    setEndDate]    = useState('');
  const [activeFY,   setActiveFY]   = useState('');
  const [activePreset, setActivePreset] = useState('');

  const [modules, setModules] = useState([]);
  const searchRef    = useRef(null);
  const isMounted    = useRef(true);
  const didMount     = useRef(false);  // skip filter effect on initial mount
  const searchInited = useRef(false);  // skip search debounce on initial mount

  // ── preset helpers ──────────────────────────────────────────────────────────
  const applyPreset = (preset) => {
    setActiveFY(''); setActivePreset(preset);
    const today = new Date();
    const fmt   = d => d.toISOString().slice(0, 10);
    if (preset === 'today') {
      setStartDate(fmt(today)); setEndDate(fmt(today));
    } else if (preset === '7d') {
      const d = new Date(today); d.setDate(d.getDate() - 7);
      setStartDate(fmt(d)); setEndDate(fmt(today));
    } else if (preset === '30d') {
      const d = new Date(today); d.setDate(d.getDate() - 30);
      setStartDate(fmt(d)); setEndDate(fmt(today));
    } else if (preset === '3m') {
      const d = new Date(today); d.setMonth(d.getMonth() - 3);
      setStartDate(fmt(d)); setEndDate(fmt(today));
    } else {
      setStartDate(''); setEndDate('');
    }
  };

  const applyFY = (fy) => {
    setActiveFY(fy.key); setActivePreset('');
    setStartDate(fy.start); setEndDate(fy.end);
  };

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // ── fetch ───────────────────────────────────────────────────────────────────
  const fetchLogs = useCallback(async (pg) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit : PAGE_SIZE,
        offset: pg * PAGE_SIZE,
      });
      if (search)     params.set('search',      search);
      if (module)     params.set('module_name', module);
      if (actionType) params.set('action_type', actionType);
      if (startDate)  params.set('start_date',  startDate);
      if (endDate)    params.set('end_date',     endDate);

      const [logsRes, statsRes] = await Promise.all([
        api.get(`/audit?${params}`),
        api.get(`/audit/stats?${new URLSearchParams({
          ...(startDate && { start_date: startDate }),
          ...(endDate   && { end_date:   endDate   }),
        })}`),
      ]);

      if (!isMounted.current) return;

      const logsData  = logsRes.data;
      const statsData = statsRes.data;

      setLogs(Array.isArray(logsData) ? logsData : (logsData.logs || []));
      setTotal(logsData.total ?? (Array.isArray(logsData) ? logsData.length : 0));
      setStats(statsData);

      // collect unique modules for filter dropdown
      if (statsData?.byModule) {
        setModules(statsData.byModule.map(m => m.module).filter(Boolean));
      }
    } catch (err) {
      if (!isMounted.current) return;
      console.error('AuditLogs fetch error:', err);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [search, module, actionType, startDate, endDate]);

  // Filter changes → reset to page 0 and fetch; initial mount is handled by the page effect below
  useEffect(() => {
    if (!didMount.current) return;
    setPage(0);
    fetchLogs(0);
  }, [module, actionType, startDate, endDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Page navigation and initial load
  useEffect(() => {
    if (!didMount.current) { didMount.current = true; }
    fetchLogs(page);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // debounce search; skip on mount (page effect already fetches on load)
  useEffect(() => {
    if (!searchInited.current) { searchInited.current = true; return; }
    const t = setTimeout(() => { setPage(0); fetchLogs(0); }, 400);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages  = Math.ceil(total / PAGE_SIZE);
  const pageNumbers = () => {
    const pages = [];
    const range = 2;
    for (let i = 0; i < totalPages; i++) {
      if (i === 0 || i === totalPages - 1 || Math.abs(i - page) <= range) pages.push(i);
      else if (pages[pages.length - 1] !== '…') pages.push('…');
    }
    return pages;
  };

  const clearAll = () => {
    setSearch(''); setModule(''); setActionType('');
    setStartDate(''); setEndDate(''); setActiveFY(''); setActivePreset('');
    setPage(0);
  };

  const hasFilters = search || module || actionType || startDate || endDate;

  return (
    <div className="al-root al-audit-page">

      {/* Header */}
      <div className="al-header">
        <div className="al-header-left">
          <div className="al-header-icon"><Shield size={22}/></div>
          <div>
            <h1 className="al-title">Audit Logs</h1>
            <p className="al-subtitle">Complete trail of all system events and user actions</p>
          </div>
        </div>
        <div className="al-header-right">
          {hasFilters && (
            <button className="al-btn al-btn-ghost" onClick={clearAll}>
              Clear Filters
            </button>
          )}
          <button className="al-btn al-btn-ghost" onClick={() => fetchLogs(page)} title="Refresh">
            <RefreshCw size={14}/>
          </button>
          <button className="al-btn al-btn-primary" onClick={() => exportCSV(logs)}>
            <Download size={14}/> Export CSV
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <div className="al-kpi-row">
        <KpiCard icon={FileText}      label="Total Logs"   value={stats?.total?.toLocaleString()}       color="#6b7280" bg="#f3f4f6"/>
        <KpiCard icon={AlertTriangle} label="Today"        value={stats?.today?.toLocaleString()}       color="#6b7280" bg="#f3f4f6"/>
        <KpiCard icon={User}          label="Unique Users" value={stats?.uniqueUsers?.toLocaleString()} color="#6b7280" bg="#f3f4f6"/>
        <KpiCard icon={Database}      label="Modules"      value={stats?.modules?.toLocaleString()}     color="#6b7280" bg="#f3f4f6"/>
      </div>

      {/* Security risk summary */}
      {stats?.byAction?.length > 0 && (() => {
        const deleteCount = stats.byAction.find(a => a.action?.toUpperCase() === 'DELETE')?.count || 0;
        const totalCount  = stats.total || 1;
        const riskScore   = Math.min(100, Math.round((deleteCount / totalCount) * 100 * 10));
        const riskLevel   = riskScore >= 20 ? 'high' : riskScore >= 5 ? 'medium' : 'low';
        const riskStyle   = RISK_CFG[riskLevel];
        return (
          <div className="al-risk-summary" style={{ background: riskStyle.bg, borderColor: riskStyle.border }}>
            <div className="al-risk-summary-left">
              <Shield size={18} color={riskStyle.color} />
              <div>
                <div className="al-risk-summary-title" style={{ color: riskStyle.color }}>
                  Security Risk: <strong>{riskStyle.label}</strong>
                </div>
                <div className="al-risk-summary-desc">
                  {deleteCount} destructive operations ({Math.round((deleteCount / totalCount) * 100)}% of all events)
                  {riskLevel === 'high' && ' — review DELETE actions immediately'}
                </div>
              </div>
            </div>
            <div className="al-risk-bar-wrap">
              {stats.byAction.slice(0, 6).map(a => {
                const cfg = getActionCfg(a.action);
                const pct = Math.max(4, Math.round((a.count / (stats.total || 1)) * 100));
                return (
                  <div key={a.action} className="al-risk-bar-item" title={`${a.action}: ${a.count}`}>
                    <div className="al-risk-bar" style={{ height: `${Math.min(pct * 1.5, 40)}px`, background: cfg.color }} />
                    <span className="al-risk-bar-label">{a.action?.slice(0,3)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Filters */}
      <div className="al-filters">
        {/* Row 1: FY + Presets */}
        <div className="al-filter-row">
          <span className="al-filter-label">FY</span>
          <select
            className="al-select"
            value={activeFY}
            onChange={e => {
              const key = e.target.value;
              if (!key) { setActiveFY(''); setStartDate(''); setEndDate(''); setActivePreset(''); }
              else { const fy = FY_OPTIONS.find(f => f.key === key); if (fy) applyFY(fy); }
            }}
          >
            <option value="">All Time</option>
            {FY_OPTIONS.map(fy => (
              <option key={fy.key} value={fy.key}>
                {fy.label}{fy.isCurrent ? ' (Current)' : ''}
              </option>
            ))}
          </select>
          <div style={{width:1, height:20, background:'#e5e7eb', margin:'0 4px'}}/>
          {[
            { key:'today', label:'Today'  },
            { key:'7d',    label:'7 Days' },
            { key:'30d',   label:'30 Days'},
            { key:'3m',    label:'3 Months'},
            { key:'all',   label:'All Time'},
          ].map(p => (
            <button
              key={p.key}
              className={`al-preset${activePreset === p.key ? ' al-preset-active' : ''}`}
              onClick={() => applyPreset(p.key)}
            >{p.label}</button>
          ))}
        </div>

        {/* Row 2: Custom dates */}
        <div className="al-filter-row">
          <span className="al-filter-label">Date</span>
          <div className="al-date-wrap">
            <input type="date" className="al-date-input" value={startDate}
              onChange={e => { setStartDate(e.target.value); setActiveFY(''); setActivePreset(''); }}/>
            <span className="al-date-sep">→</span>
            <input type="date" className="al-date-input" value={endDate}
              onChange={e => { setEndDate(e.target.value); setActiveFY(''); setActivePreset(''); }}/>
          </div>
        </div>

        {/* Row 3: Search + Module + Action */}
        <div className="al-filter-row">
          <div className="al-search-wrap">
            <Search size={14} className="al-search-icon"/>
            <input
              ref={searchRef}
              className="al-search"
              placeholder="Search user, module, action, reference…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className="al-search-clear" onClick={() => setSearch('')}>
                <XCircle size={14}/>
              </button>
            )}
          </div>

          <select className="al-select" value={module} onChange={e => setModule(e.target.value)}>
            <option value="">All Modules</option>
            {modules.map(m => <option key={m} value={m}>{m}</option>)}
          </select>

          <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
            {['', 'CREATE','UPDATE','DELETE','APPROVE','REJECT','LOGIN','LOGOUT'].map(act => {
              const cfg = act ? getActionCfg(act) : null;
              const active = actionType === act;
              const DISPLAY = { CREATE: 'Created', UPDATE: 'Updated', DELETE: 'Deleted', APPROVE: 'Approved', REJECT: 'Rejected', LOGIN: 'Login', LOGOUT: 'Logout' };
              return (
                <button
                  key={act || 'all'}
                  className="al-action-chip"
                  style={{
                    background  : active ? (cfg?.color || '#374151')    : (cfg?.bg || '#f3f4f6'),
                    color       : active ? '#fff'                        : (cfg?.color || '#374151'),
                    borderColor : active ? (cfg?.color || '#374151')     : (cfg?.bg || '#e5e7eb'),
                  }}
                  onClick={() => setActionType(act)}
                >
                  {act ? (DISPLAY[act] || act) : 'All Actions'}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Action activity strip */}
      {stats?.byAction?.length > 0 && (
        <div className="al-list-wrap" style={{ padding:'12px 20px' }}>
          <div style={{ display:'flex', gap:16, flexWrap:'wrap', alignItems:'center' }}>
            <span style={{ fontSize:12, fontWeight:700, color:'#6b7280', textTransform:'uppercase', letterSpacing:'.04em' }}>
              Activity Breakdown
            </span>
            {stats.byAction.map(a => {
              const cfg = getActionCfg(a.action);
              return (
                <div key={a.action} style={{ display:'flex', alignItems:'center', gap:5, fontSize:12, color:'#374151', cursor:'pointer' }}
                  onClick={() => setActionType(actionType === a.action ? '' : a.action)}>
                  <span style={{ width:8, height:8, borderRadius:2, background:cfg.color }}/>
                  <span style={{ fontWeight:600 }}>{a.action}</span>
                  <span style={{ color:'#9ca3af' }}>({a.count})</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Log list */}
      <div className="al-list-wrap">
        <div className="al-list-header">
          <span className="al-list-count">
            {loading ? 'Loading…' : `${total.toLocaleString()} log${total !== 1 ? 's' : ''} found`}
          </span>
          <span className="al-list-sort">
            Page {page + 1} of {Math.max(totalPages, 1)}
          </span>
        </div>

        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <div key={i} className="al-skeleton"/>)
        ) : logs.length === 0 ? (
          <div className="al-empty">
            <Shield size={40} color="#e5e7eb"/>
            <div className="al-empty-title">No logs found</div>
            <div className="al-empty-sub">
              {hasFilters ? 'Try adjusting your filters or clearing them.' : 'No audit events recorded yet.'}
            </div>
          </div>
        ) : (
          logs.map(log => (
            <LogEntry
              key={log.id}
              log={log}
              expanded={expanded === log.id}
              onToggle={() => setExpanded(expanded === log.id ? null : log.id)}
            />
          ))
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="al-pagination">
            <span className="al-page-info">
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <div className="al-page-btns">
              <button className="al-page-btn" disabled={page === 0} onClick={() => setPage(0)}>«</button>
              <button className="al-page-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹</button>
              {pageNumbers().map((p, i) =>
                p === '…' ? (
                  <span key={`e${i}`} className="al-page-btn" style={{cursor:'default',border:'none',color:'#9ca3af'}}>…</span>
                ) : (
                  <button
                    key={p}
                    className={`al-page-btn${page === p ? ' al-page-btn-active' : ''}`}
                    onClick={() => setPage(p)}
                  >{p + 1}</button>
                )
              )}
              <button className="al-page-btn" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>›</button>
              <button className="al-page-btn" disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
