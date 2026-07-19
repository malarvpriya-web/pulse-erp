import { useState, useCallback, useRef, useEffect } from 'react';
import {
  BarChart2, Users, FileText, ShoppingCart, Package,
  IndianRupee, Clock, TrendingUp, Download, Play,
  Calendar, ChevronRight, RefreshCw, Search, Filter,
  AlertCircle, CheckCircle, Bookmark, BookmarkCheck
} from 'lucide-react';
import api from '@/services/api/client';
import './Reports.css';

// ── Report catalog ────────────────────────────────────────────────────────────
const CATALOG = [
  {
    category: 'HR & People',
    icon: Users,
    color: '#6366f1',
    bg: '#eef2ff',
    reports: [
      { id: 'attendance', label: 'Attendance Report', desc: 'Daily attendance records with in/out times and status', hasDate: true },
      { id: 'leave', label: 'Leave Report', desc: 'Leave applications, balances and utilization by employee', hasDate: true },
      { id: 'headcount', label: 'Headcount Report', desc: 'Department-wise employee count and joining/exit analysis', hasDate: false },
      { id: 'payroll-summary', label: 'Payroll Summary', desc: 'Monthly payroll breakup, CTC and deductions overview', hasDate: true },
    ],
  },
  {
    category: 'Sales & Revenue',
    icon: TrendingUp,
    color: '#10b981',
    bg: '#f0fdf4',
    reports: [
      { id: 'sales', label: 'Sales Report', desc: 'Invoice-wise revenue with customer and product breakdown', hasDate: true },
      { id: 'sales-targets', label: 'Sales Targets vs Actual', desc: 'Target achievement rate per salesperson and region', hasDate: true },
      { id: 'outstanding-invoices', label: 'Outstanding Invoices', desc: 'Ageing analysis of unpaid invoices by due date bucket', hasDate: false },
    ],
  },
  {
    category: 'Finance & Accounting',
    icon: IndianRupee,
    color: '#f59e0b',
    bg: '#fffbeb',
    reports: [
      { id: 'expense-report', label: 'Expense Report', desc: 'Employee expense claims by category, bill status and GST', hasDate: true },
      { id: 'gst-report', label: 'GST Summary', desc: 'GST collected vs paid with GSTR-1 and GSTR-3B data', hasDate: true },
      { id: 'project-cost', label: 'Project Cost Report', desc: 'Budget vs actual costs per project with variance', hasDate: true },
    ],
  },
  {
    category: 'Procurement',
    icon: ShoppingCart,
    color: '#6B3FDB',
    bg: '#f5f3ff',
    reports: [
      { id: 'purchase-orders', label: 'Purchase Orders', desc: 'PO-wise spend analysis with vendor and status breakdown', hasDate: true },
      { id: 'vendor-performance', label: 'Vendor Performance', desc: 'On-time delivery, quality scores and spend by vendor', hasDate: true },
      { id: 'pending-pos', label: 'Pending Approvals', desc: 'Purchase requests and orders awaiting action', hasDate: false },
    ],
  },
  {
    category: 'Inventory & Stock',
    icon: Package,
    color: '#0ea5e9',
    bg: '#f0f9ff',
    reports: [
      { id: 'stock', label: 'Stock Summary', desc: 'Current stock levels across all warehouses', hasDate: false },
      { id: 'stock-movement', label: 'Stock Movement', desc: 'Inward / outward transactions by item and warehouse', hasDate: true },
      { id: 'low-stock', label: 'Low Stock Alert', desc: 'Items below reorder level requiring replenishment', hasDate: false },
    ],
  },
];

const ALL_REPORTS = CATALOG.flatMap(c => c.reports.map(r => ({ ...r, category: c.category })));

const TODAY = new Date().toISOString().split('T')[0];
const MONTH_START = TODAY.slice(0, 8) + '01';

function fmtDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function exportCSV(data, name) {
  if (!data?.length) return;
  const cols = Object.keys(data[0]);
  const rows = data.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','));
  const csv = [cols.join(','), ...rows].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}-${Date.now()}.csv` });
  a.click(); URL.revokeObjectURL(url);
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Reports() {
  const [search, setSearch]         = useState('');
  const [selected, setSelected]     = useState(null);   // report obj
  const [dateFrom, setDateFrom]     = useState(MONTH_START);
  const [dateTo, setDateTo]         = useState(TODAY);
  const [dept, setDept]             = useState('');
  const [loading, setLoading]       = useState(false);
  const [data, setData]             = useState(null);   // null = not run yet
  const [error, setError]           = useState('');
  const [saving, setSaving]         = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);   // null | 'saved' | 'error'

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const filtered = search.trim()
    ? ALL_REPORTS.filter(r =>
        r.label.toLowerCase().includes(search.toLowerCase()) ||
        r.desc.toLowerCase().includes(search.toLowerCase()) ||
        r.category.toLowerCase().includes(search.toLowerCase()))
    : null;

  const runReport = useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setError(''); setData(null);
    try {
      const params = {};
      if (selected.hasDate) { params.start_date = dateFrom; params.end_date = dateTo; }
      if (dept) params.department = dept;
      const res = await api.get(`/reports/${selected.id}`, { params });
      if (!isMounted.current) return;
      const raw = res.data?.data || res.data?.rows || res.data || [];
      setData(Array.isArray(raw) ? raw : [raw]);
    } catch (e) {
      if (!isMounted.current) return;
      setError(e.response?.data?.error || e.message || 'Failed to load report');
      setData([]);
    } finally { if (isMounted.current) setLoading(false); }
  }, [selected, dateFrom, dateTo, dept]);

  const saveReport = useCallback(async () => {
    if (!selected || !data?.length) return;
    setSaving(true);
    setSaveStatus(null);
    try {
      const filters = {};
      if (selected.hasDate) { filters.start_date = dateFrom; filters.end_date = dateTo; }
      if (dept) filters.department = dept;
      await api.post('/reports/saved', {
        report_name: `${selected.label} — ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}`,
        report_type: selected.id,
        filters_json: filters,
      });
      if (isMounted.current) setSaveStatus('saved');
    } catch {
      if (isMounted.current) setSaveStatus('error');
    } finally {
      if (isMounted.current) setSaving(false);
    }
  }, [selected, data, dateFrom, dateTo, dept]);

  const selectReport = r => { setSelected(r); setData(null); setError(''); setSaveStatus(null); };

  const cols = data?.length ? Object.keys(data[0]) : [];

  return (
    <div className="rp-root">

      {/* ── Header ── */}
      <div className="rp-header">
        <div className="rp-header-left">
          <div className="rp-header-icon"><BarChart2 size={22} /></div>
          <div>
            <h1 className="rp-title">Reports & Analytics</h1>
            <p className="rp-sub">Generate, filter and export business reports</p>
          </div>
        </div>
        <div className="rp-search-wrap">
          <Search size={15} className="rp-search-icon" />
          <input
            className="rp-search"
            placeholder="Search reports…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="rp-body">

        {/* ── Catalog / Search results ── */}
        {!selected ? (
          <div className="rp-catalog">
            {filtered ? (
              <>
                <div className="rp-cat-grid">
                  {filtered.map(r => (
                    <ReportCard key={r.id} r={r} cat={CATALOG.find(c => c.category === r.category)} onSelect={selectReport} />
                  ))}
                </div>
                {filtered.length === 0 && (
                  <div className="rp-empty">
                    <Search size={32} />
                    <p>No reports matching &ldquo;{search}&rdquo;</p>
                  </div>
                )}
              </>
            ) : (
              CATALOG.map(cat => (
                <div key={cat.category} className="rp-cat-section">
                  <div className="rp-cat-hd" style={{ color: cat.color }}>
                    <cat.icon size={16} />
                    <span>{cat.category}</span>
                  </div>
                  <div className="rp-cat-grid">
                    {cat.reports.map(r => <ReportCard key={r.id} r={r} cat={cat} onSelect={selectReport} />)}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (

          /* ── Report Runner ── */
          <div className="rp-runner">
            <div className="rp-runner-hd">
              <button className="rp-back-btn" onClick={() => { setSelected(null); setData(null); }}>
                ← Back
              </button>
              <div className="rp-runner-title">
                <span className="rp-runner-cat">{selected.category}</span>
                <h2>{selected.label}</h2>
                <p>{selected.desc}</p>
              </div>
            </div>

            {/* Filters */}
            <div className="rp-filters">
              <div className="rp-filter-icon"><Filter size={14} /></div>
              {selected.hasDate && (
                <>
                  <div className="rp-filter-group">
                    <label>From</label>
                    <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                  </div>
                  <div className="rp-filter-group">
                    <label>To</label>
                    <input type="date" value={dateTo} min={dateFrom} onChange={e => setDateTo(e.target.value)} />
                  </div>
                </>
              )}
              <div className="rp-filter-group">
                <label>Department</label>
                <input placeholder="All" value={dept} onChange={e => setDept(e.target.value)} style={{ width: 120 }} />
              </div>
              <button className="rp-run-btn" onClick={runReport} disabled={loading}>
                {loading ? <RefreshCw size={14} className="rp-spin" /> : <Play size={14} />}
                {loading ? 'Running…' : 'Run Report'}
              </button>
              {data?.length > 0 && (
                <button className="rp-export-btn" onClick={() => exportCSV(data, selected.id)}>
                  <Download size={14} /> Export CSV
                </button>
              )}
              {data?.length > 0 && (
                <button
                  className={`rp-export-btn${saveStatus === 'saved' ? ' rp-saved-btn' : ''}`}
                  onClick={saveReport}
                  disabled={saving || saveStatus === 'saved'}
                  title={saveStatus === 'saved' ? 'Report saved' : 'Save to Saved Reports'}
                >
                  {saveStatus === 'saved'
                    ? <><BookmarkCheck size={14} /> Saved</>
                    : saving
                      ? <><RefreshCw size={14} className="rp-spin" /> Saving…</>
                      : <><Bookmark size={14} /> Save Report</>
                  }
                </button>
              )}
            </div>

            {/* State feedback */}
            {data === null && !loading && (
              <div className="rp-prompt">
                <BarChart2 size={40} />
                <p>Configure filters above and click <strong>Run Report</strong> to generate results</p>
                {selected.hasDate && (
                  <p className="rp-prompt-sub">
                    Showing data from {fmtDate(dateFrom)} to {fmtDate(dateTo)}
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="rp-error">
                <AlertCircle size={16} />
                {error}
              </div>
            )}

            {data !== null && data.length === 0 && !loading && !error && (
              <div className="rp-prompt">
                <CheckCircle size={40} color="#10b981" />
                <p>No records found for the selected filters</p>
              </div>
            )}

            {/* Results table */}
            {data?.length > 0 && (
              <div className="rp-table-wrap">
                <div className="rp-table-meta">
                  <span><strong>{data.length}</strong> records</span>
                  {selected.hasDate && <span>{fmtDate(dateFrom)} – {fmtDate(dateTo)}</span>}
                </div>
                <div className="rp-table-scroll">
                  <table className="rp-table">
                    <thead>
                      <tr>
                        <th className="rp-th-num">#</th>
                        {cols.map(c => (
                          <th key={c}>{c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.map((row, i) => (
                        <tr key={i}>
                          <td className="rp-td-num">{i + 1}</td>
                          {cols.map(c => (
                            <td key={c}>
                              {row[c] == null ? (
                                <span className="rp-nil">—</span>
                              ) : typeof row[c] === 'boolean' ? (
                                row[c]
                                  ? <span className="rp-badge rp-badge-green">Yes</span>
                                  : <span className="rp-badge rp-badge-gray">No</span>
                              ) : (
                                String(row[c])
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Report card ───────────────────────────────────────────────────────────────
function ReportCard({ r, cat, onSelect }) {
  return (
    <button className="rp-card" onClick={() => onSelect(r)}>
      <div className="rp-card-icon" style={{ background: cat.bg, color: cat.color }}>
        <cat.icon size={18} />
      </div>
      <div className="rp-card-body">
        <div className="rp-card-label">{r.label}</div>
        <div className="rp-card-desc">{r.desc}</div>
        <div className="rp-card-tags">
          <span className="rp-tag" style={{ background: cat.bg, color: cat.color }}>{r.category}</span>
          {r.hasDate && <span className="rp-tag rp-tag-gray"><Calendar size={10} /> Date filter</span>}
        </div>
      </div>
      <ChevronRight size={16} className="rp-card-arrow" />
    </button>
  );
}
