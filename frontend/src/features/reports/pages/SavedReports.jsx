import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api/client';
import {
  FileText, Download, Trash2, Search, AlertCircle, RefreshCw, Users,
  BarChart3,
} from 'lucide-react';
import { fmtDate } from '@/utils/dateFormatter';
import './SavedReports.css';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero } from '@/components/pulse-ui';

/**
 * Saved Reports.
 *
 * Field names here follow the live `saved_reports` table — name / filters /
 * columns / is_shared. The page previously read report_name / filters_json /
 * is_public, which are columns that have never existed, matching a repository
 * that wrote the same non-existent names. Every insert raised 42703, the error
 * was swallowed, and the API answered 201 with a null body while the Report
 * Builder rendered a "✓ Saved" badge. The table held zero rows.
 *
 * Failures are shown. Delete and Export previously swallowed their errors in an
 * empty catch block, so a rejected delete looked identical to a successful one.
 */
const CSV_INJECTION = /^[=+\-@\t\r]/;

function csvCell(v) {
  if (v === null || v === undefined) return '""';
  let s = String(v);
  if (CSV_INJECTION.test(s)) s = '\t' + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCSV(rows, filename) {
  if (!rows?.length) return false;
  const cols = Object.keys(rows[0]);
  const body = rows.map(r => cols.map(c => csvCell(r[c])).join(','));
  const csv = '﻿' + [cols.map(csvCell).join(','), ...body].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  return true;
}

const errText = (e, fallback) =>
  e?.response?.data?.error || e?.message || fallback;

export function SavedReports() {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = useCallback(() => {
    setLoading(true); setLoadError(null);
    api.get('/reports/saved')
      .then(r => { if (isMounted.current) setReports(r.data?.rows || []); })
      .catch(e => {
        if (!isMounted.current) return;
        setReports([]);
        setLoadError(errText(e, 'Saved reports could not be loaded.'));
      })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, []);

  useEffect(load, [load]);

  /**
   * The id is passed as an argument rather than read from state. The previous
   * version was a `useCallback(..., [])` that closed over `pendingDelete`, so it
   * saw the first-render value of null on every invocation and returned at its
   * own guard — the Delete button did nothing at all, silently.
   */
  const confirmDelete = useCallback(async (id) => {
    if (!id) return;
    setPendingDelete(null); setBusyId(id); setActionError(null);
    try {
      await api.delete(`/reports/saved/${id}`);
      if (isMounted.current) setReports(prev => prev.filter(r => r.id !== id));
    } catch (e) {
      if (isMounted.current) setActionError(errText(e, 'The report could not be deleted.'));
    } finally { if (isMounted.current) setBusyId(null); }
  }, []);

  const handleExport = useCallback(async (report) => {
    setBusyId(report.id); setActionError(null);
    try {
      const raw = report.filters;
      const filters = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
      const res = await api.get(`/reports/${report.report_type}`, {
        params: { ...filters, limit: 5000 },
      });
      const rows = res.data?.rows || [];
      if (!rows.length) {
        setActionError(`“${report.name}” ran successfully but matched no records, so there is nothing to export.`);
        return;
      }
      downloadCSV(rows, `${String(report.report_type).replace(/\//g, '-')}-${new Date().toISOString().slice(0, 10)}.csv`);
      if (res.data.total > rows.length) {
        setActionError(`Exported the first ${rows.length.toLocaleString('en-IN')} of ${res.data.total.toLocaleString('en-IN')} rows.`);
      }
    } catch (e) {
      if (isMounted.current) setActionError(errText(e, 'The report could not be exported.'));
    } finally { if (isMounted.current) setBusyId(null); }
  }, []);

  const filtered = reports.filter(r =>
    !search || (r.name || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="srp-root">
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete Report"
        message={pendingDelete ? `Delete “${pendingDelete.name}”? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => confirmDelete(pendingDelete?.id)}
        onCancel={() => setPendingDelete(null)}
      />

      <PageHero
        icon={BarChart3}
        eyebrow="Reports"
        title="Saved Reports"
        subtitle="Report definitions saved by you and shared with your team"
        meta={loading ? undefined : [
          { value: filtered.length, label: `saved report${filtered.length === 1 ? '' : 's'}` },
        ]}
        actions={
          <button className="plh-cta" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'plh-spin' : undefined} /> Refresh
          </button>
        }
      />

      <div className="srp-toolbar">
        <div className="srp-search">
          <Search size={14} color="#9ca3af" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search reports…" />
        </div>
      </div>

      {loadError && (
        <div className="srp-alert srp-alert-error" role="alert">
          <AlertCircle size={16} />
          <span>{loadError}</span>
          <button className="srp-action-btn" onClick={load}>Try again</button>
        </div>
      )}
      {actionError && (
        <div className="srp-alert srp-alert-notice" role="status">
          <AlertCircle size={16} />
          <span>{actionError}</span>
          <button className="srp-action-btn" onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      <div className="srp-table-wrap">
        {loading ? (
          <div className="srp-loading"><div className="srp-spinner" /></div>
        ) : filtered.length === 0 && !loadError ? (
          <div className="srp-blank">
            <FileText size={40} color="#d1d5db" />
            <p>
              {search
                ? `No saved reports matching “${search}”`
                : 'No saved reports yet. Run a report in the Report Builder and choose Save Report.'}
            </p>
          </div>
        ) : filtered.length > 0 ? (
          <table className="srp-table">
            <thead>
              <tr>
                {['Report Name', 'Type', 'Created', 'Last Run', 'Actions'].map(h => <th key={h}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="srp-row">
                  <td className="srp-name">
                    {r.name}
                    {r.is_shared && <span className="srp-shared" title="Shared with your company"><Users size={11} /> Shared</span>}
                  </td>
                  <td><span className="srp-type-badge">{r.report_type}</span></td>
                  <td className="srp-muted">{fmtDate(r.created_at)}</td>
                  <td className="srp-muted">{r.last_run ? fmtDate(r.last_run) : 'Never'}</td>
                  <td>
                    <div className="srp-actions">
                      <button className="srp-action-btn" disabled={busyId === r.id}
                              onClick={() => handleExport(r)}>
                        <Download size={12} /> {busyId === r.id ? 'Working…' : 'Export'}
                      </button>
                      {/* Only the owner can delete; the server enforces this too. */}
                      {r.is_owner !== false && (
                        <button className="srp-action-btn srp-action-del" disabled={busyId === r.id}
                                onClick={() => setPendingDelete(r)}>
                          <Trash2 size={12} /> Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}

export default SavedReports;
