import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api/client';
import { FileText, Download, Trash2, Search } from 'lucide-react';
import './SavedReports.css';
import ConfirmDialog from '@/components/core/ConfirmDialog';

function exportCSV(data, name) {
  if (!data?.length) return;
  const cols = Object.keys(data[0]);
  const rows = data.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','));
  const csv = [cols.join(','), ...rows].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}-${Date.now()}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

export function SavedReports() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading]  = useState(false);
  const [search,  setSearch]   = useState('');
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    setLoading(true);
    api.get('/reports/saved')
      .then(r => { if (isMounted.current) setReports(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setReports([]); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, []);

  const handleDelete = useCallback(async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/reports/saved/${id}`);
      if (isMounted.current) setReports(prev => prev.filter(r => r.id !== id));
    } catch { /* silent */ }
  }, []);

  const handleExport = useCallback(async (report) => {
    try {
      const raw = report.filters_json;
      const filters = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      const params = {};
      if (filters.start_date) params.start_date = filters.start_date;
      if (filters.end_date)   params.end_date   = filters.end_date;
      if (filters.department) params.department  = filters.department;
      const res  = await api.get(`/reports/${report.report_type || report.type}`, { params });
      const data = Array.isArray(res.data) ? res.data
        : Array.isArray(res.data?.data)    ? res.data.data
        : Array.isArray(res.data?.rows)    ? res.data.rows
        : [];
      exportCSV(data, report.report_name || report.name || 'report');
    } catch { /* silent */ }
  }, []);

  const filtered = reports.filter(r =>
    !search || (r.report_name || r.name || r.title || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="srp-root">

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Report"
        message="Delete this saved report?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      <div className="srp-header">
        <div>
          <h1 className="srp-title">Saved Reports</h1>
          <p className="srp-sub">{filtered.length} saved report{filtered.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      <div className="srp-toolbar">
        <div className="srp-search">
          <Search size={14} color="#9ca3af" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search reports…"
          />
        </div>
      </div>

      <div className="srp-table-wrap">
        {loading ? (
          <div className="srp-loading"><div className="srp-spinner" /></div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '60px 24px', textAlign: 'center', color: '#9ca3af' }}>
            <FileText size={40} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
            <p style={{ margin: 0, fontSize: 13 }}>
              {search ? `No saved reports matching "${search}"` : 'No saved reports yet. Generate a report and save it to see it here.'}
            </p>
          </div>
        ) : (
          <table className="srp-table">
            <thead>
              <tr>
                {['Report Name', 'Type', 'Created', 'Last Run', 'Actions'].map(h => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.id || i} className="srp-row">
                  <td className="srp-name">{r.report_name || r.name || r.title || '—'}</td>
                  <td><span className="srp-type-badge">{r.report_type || r.type || 'Custom'}</span></td>
                  <td style={{ color: '#6b7280', fontSize: 13 }}>{(r.created_at || '').slice(0, 10)}</td>
                  <td style={{ color: '#6b7280', fontSize: 13 }}>{(r.last_run || r.updated_at || '—').toString().slice(0, 10)}</td>
                  <td>
                    <div className="srp-actions">
                      <button className="srp-action-btn" onClick={() => handleExport(r)}>
                        <Download size={12} /> Export
                      </button>
                      <button className="srp-action-btn srp-action-del" onClick={() => setPendingHandleDelete(r.id)}>
                        <Trash2 size={12} /> Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default SavedReports;
