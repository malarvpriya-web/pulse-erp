import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { BarChart2, Download, Search, RefreshCw } from 'lucide-react';
import { fmt } from './travelUtils';

const REPORT_TYPES = [
  { key: 'by-employee',    label: 'By Employee',   endpoint: '/travel/analytics/by-employee' },
  { key: 'by-department',  label: 'By Department', endpoint: '/travel/analytics/department' },
  { key: 'by-project',     label: 'By Project',    endpoint: '/travel/analytics/by-project' },
  { key: 'by-customer',    label: 'By Customer',   endpoint: null },
  { key: 'by-travel-type', label: 'By Travel Type',endpoint: '/travel/reports/by-travel-type' },
  { key: 'expense-claims', label: 'Expense Claims', endpoint: '/reimbursement/claims' },
];

// Config per report type: columns to display
const COLUMNS = {
  'by-employee': [
    { key: 'employee_name', label: 'Employee' },
    { key: 'designation',   label: 'Designation' },
    { key: 'department',    label: 'Department' },
    { key: 'trip_count',    label: 'Trips' },
    { key: 'total_spend',   label: 'Total Spend', money: true },
    { key: 'avg_spend',     label: 'Avg/Trip', money: true },
  ],
  'by-department': [
    { key: 'department',   label: 'Department' },
    { key: 'trip_count',   label: 'Trips' },
    { key: 'total_spend',  label: 'Total Spend', money: true },
  ],
  'by-project': [
    { key: 'project_number', label: 'Project #' },
    { key: 'customer_name',  label: 'Customer' },
    { key: 'trip_count',     label: 'Trips' },
    { key: 'total_spend',    label: 'Total Spend', money: true },
  ],
  'by-customer': [
    { key: 'customer_name', label: 'Customer' },
    { key: 'trip_count',    label: 'Trips' },
    { key: 'total_spend',   label: 'Total Spend', money: true },
  ],
  'by-travel-type': [
    { key: 'travel_type',   label: 'Travel Type' },
    { key: 'trip_count',    label: 'Trips' },
    { key: 'total_budget',  label: 'Total Budget', money: true },
  ],
  'expense-claims': [
    { key: 'claim_number',     label: 'Claim #' },
    { key: 'employee_name',    label: 'Employee' },
    { key: 'expense_type',     label: 'Type' },
    { key: 'expense_category', label: 'Category' },
    { key: 'expense_date',     label: 'Date', date: true },
    { key: 'amount',           label: 'Base', money: true },
    { key: 'gst_amount',       label: 'GST', money: true },
    { key: 'total_amount',     label: 'Total', money: true },
    { key: 'status',           label: 'Status' },
    { key: 'customer_name',    label: 'Customer' },
    { key: 'project_number',   label: 'Project #' },
  ],
};

function downloadCSV(data, columns, filename) {
  const headers = columns.map(c => c.label).join(',');
  const rows = data.map(row =>
    columns.map(c => {
      let v = row[c.key] ?? '';
      if (c.money) v = Number(v).toFixed(2);
      if (c.date) v = v?.toString().slice(0,10);
      return `"${String(v).replace(/"/g, '""')}"`;
    }).join(',')
  );
  const csv = [headers, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${filename}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

const CUSTOMER_REPORT_DATA = (requests) => {
  const map = {};
  requests.forEach(r => {
    if (!r.customer_name) return;
    if (!map[r.customer_name]) map[r.customer_name] = { customer_name: r.customer_name, trip_count: 0, total_spend: 0 };
    map[r.customer_name].trip_count++;
    map[r.customer_name].total_spend += Number(r.budget || 0);
  });
  return Object.values(map).sort((a, b) => b.total_spend - a.total_spend);
};

export default function TravelReports() {
  const [reportType, setReportType] = useState('by-employee');
  const [data,    setData]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [search,  setSearch]  = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate,   setToDate]   = useState('');
  const [allRequests, setAllRequests] = useState([]);

  const reportConfig = REPORT_TYPES.find(r => r.key === reportType);
  const columns = COLUMNS[reportType] || [];

  const loadReport = useCallback(async () => {
    setLoading(true);
    setData([]);
    try {
      if (reportType === 'by-customer') {
        const r = await api.get('/travel/requests', { params: { limit: 500 } });
        const reqs = Array.isArray(r.data) ? r.data : [];
        setAllRequests(reqs);
        setData(CUSTOMER_REPORT_DATA(reqs));
      } else if (reportConfig?.endpoint) {
        const params = {};
        if (fromDate) params.from_date = fromDate;
        if (toDate)   params.to_date   = toDate;
        if (reportType === 'expense-claims') params.limit = 500;
        const r = await api.get(reportConfig.endpoint, { params });
        setData(Array.isArray(r.data) ? r.data : []);
      }
    } catch {
      setData([]);
    } finally { setLoading(false); }
  }, [reportType, fromDate, toDate, reportConfig]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const filtered = data.filter(row => {
    if (!search) return true;
    return columns.some(c => String(row[c.key] || '').toLowerCase().includes(search.toLowerCase()));
  });

  const totals = {};
  columns.filter(c => c.money).forEach(c => {
    totals[c.key] = filtered.reduce((s, r) => s + Number(r[c.key] || 0), 0);
  });

  const handleExportCSV = () => downloadCSV(filtered, columns, reportConfig?.label || 'travel_report');

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Travel & Expense Reports</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            Comprehensive travel cost analytics with export
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={loadReport}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={handleExportCSV}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* Report type tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {REPORT_TYPES.map(r => (
          <button key={r.key} onClick={() => setReportType(r.key)}
            style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer',
              borderColor: reportType === r.key ? '#6B3FDB' : '#e5e7eb',
              background: reportType === r.key ? '#6B3FDB' : '#fff',
              color: reportType === r.key ? '#fff' : '#374151' }}>
            {r.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter results..."
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>From</span>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, outline: 'none' }} />
          <span style={{ fontSize: 12, color: '#9ca3af' }}>To</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, outline: 'none' }} />
        </div>
      </div>

      {/* Summary strip */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ background: '#fff', borderRadius: 10, padding: '10px 16px', border: '1px solid #f0f0f4', fontSize: 13 }}>
          <span style={{ color: '#9ca3af' }}>Records: </span><strong>{filtered.length}</strong>
        </div>
        {columns.filter(c => c.money).map(c => (
          <div key={c.key} style={{ background: '#fff', borderRadius: 10, padding: '10px 16px', border: '1px solid #f0f0f4', fontSize: 13 }}>
            <span style={{ color: '#9ca3af' }}>{c.label}: </span>
            <strong style={{ color: '#6B3FDB' }}>{fmt(totals[c.key] || 0)}</strong>
          </div>
        ))}
      </div>

      {/* Data table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'auto' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading report...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
            <BarChart2 size={36} color="#d1d5db" style={{ marginBottom: 10 }} />
            <p style={{ margin: 0 }}>No data for the selected filters</p>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 11 }}>#</th>
                {columns.map(c => (
                  <th key={c.key} style={{ padding: '10px 14px', textAlign: c.money ? 'right' : 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 11 }}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '9px 14px', color: '#9ca3af', fontSize: 12 }}>{i + 1}</td>
                  {columns.map(c => {
                    let val = row[c.key];
                    if (c.money) val = fmt(val || 0);
                    if (c.date) val = val?.slice(0,10) || '—';
                    if (val === null || val === undefined || val === '') val = '—';
                    return (
                      <td key={c.key} style={{ padding: '9px 14px', color: '#374151', textAlign: c.money ? 'right' : 'left', fontWeight: c.money ? 500 : 400 }}>
                        {c.key === 'status' ? (
                          <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600,
                            background: val === 'Paid' ? '#d1fae5' : val === 'Draft' ? '#f3f4f6' : '#dbeafe',
                            color: val === 'Paid' ? '#065f46' : val === 'Draft' ? '#6b7280' : '#1e40af' }}>
                            {val}
                          </span>
                        ) : val}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {/* Totals row */}
            {Object.keys(totals).length > 0 && (
              <tfoot>
                <tr style={{ background: '#f5f3ff', borderTop: '2px solid #ede9fe' }}>
                  <td style={{ padding: '10px 14px', fontWeight: 700, color: '#6B3FDB', fontSize: 12 }}>TOTAL</td>
                  {columns.map(c => (
                    <td key={c.key} style={{ padding: '10px 14px', textAlign: c.money ? 'right' : 'left', fontWeight: 700, color: '#6B3FDB', fontSize: 13 }}>
                      {c.money ? fmt(totals[c.key] || 0) : ''}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
    </div>
  );
}
