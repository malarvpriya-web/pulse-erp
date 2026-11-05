// Attendance Import tab — devices, manual CSV import, and the Recent Punch Log.
import { useState, useEffect, useCallback, useRef } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import api from '@/services/api/client';
import { S, fmtStamp, relativeTime, localDay, errText } from './biometricShared';
import { Field, Pager, EmptyRow, EmployeeSelect } from './biometricUi';

const STATUS_COLORS = { online: '#16a34a', offline: '#6b7280', error: '#dc2626' };
const MAX_BYTES = 2 * 1024 * 1024;   // the server refuses more than 2 MB of CSV

/**
 * A device's status as something the page can honestly say. `status` alone is
 * whatever was last written — for the dev-seed devices that is 'online',
 * written by the seed, never by a test or a sync. Only status_checked_at
 * (migration 20261028000012) says a real check happened, and when.
 */
function deviceState(d) {
  if (!d.ip_address) return { label: 'Not configured', color: '#9ca3af', note: 'No IP address set' };
  if (!d.status_checked_at) return { label: 'Not verified', color: '#9ca3af', note: 'Never tested or synced from Pulse' };
  return {
    label: d.status === 'online' ? 'Online' : d.status === 'error' ? 'Error' : 'Offline',
    color: STATUS_COLORS[d.status] || '#6b7280',
    note: `Checked ${relativeTime(d.status_checked_at)}${d.last_error ? ` · ${d.last_error}` : ''}`,
  };
}

const EMPTY_FILTERS = () => ({ from: localDay(), to: localDay(), q: '', department: '', device_id: '', punch_type: '', employee_id: '' });

export default function AttendanceImportTab({ dashStats, employees, flash, onDataChanged, canImport }) {
  const [devices, setDevices] = useState([]);
  const [syncing, setSyncing] = useState({});
  const [syncResult, setSyncResult] = useState({});

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [log, setLog] = useState({ rows: [], total: 0, page_size: 50 });
  const [logError, setLogError] = useState('');
  const [logLoading, setLogLoading] = useState(false);

  const [file, setFile] = useState(null);
  const [csvRaw, setCsvRaw] = useState('');
  const [importDevice, setImportDevice] = useState('');
  const [preview, setPreview] = useState(null);
  const [fileError, setFileError] = useState('');
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  const loadDevices = useCallback(async () => {
    try {
      const res = await api.get('/biometric/devices');
      setDevices(Array.isArray(res.data) ? res.data : []);
    } catch (err) { setDevices([]); flash(errText(err, 'Could not load devices'), 'error'); }
  }, [flash]);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const params = { page, page_size: 50 };
      for (const [k, v] of Object.entries(filters)) if (v !== '') params[k] = v;
      const res = await api.get('/biometric/logs', { params });
      setLog(res.data?.rows ? res.data : { rows: [], total: 0, page_size: 50 });
      setLogError('');
    } catch (err) {
      setLog({ rows: [], total: 0, page_size: 50 });
      setLogError(errText(err, 'Could not load the punch log'));
    } finally { setLogLoading(false); }
  }, [filters, page]);

  useEffect(() => { loadDevices(); }, [loadDevices]);
  useEffect(() => { loadLog(); }, [loadLog]);

  const setFilter = (k, v) => { setFilters((f) => ({ ...f, [k]: v })); setPage(1); };
  const clearFilters = () => { setFilters(EMPTY_FILTERS()); setPage(1); };
  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS());
  const departments = [...new Set(employees.map((e) => e.department).filter(Boolean))].sort();

  const syncDevice = async (d) => {
    setSyncing((s) => ({ ...s, [d.id]: true }));
    setSyncResult((r) => ({ ...r, [d.id]: null }));
    try {
      const res = await api.post(`/biometric/devices/${d.id}/sync`);
      setSyncResult((r) => ({ ...r, [d.id]: { ok: true, text: res.data?.message || 'Sync finished.' } }));
      flash(res.data?.message || `Synced ${d.device_name}`);
      loadLog(); onDataChanged();
    } catch (err) {
      const text = errText(err, 'Sync failed');
      setSyncResult((r) => ({ ...r, [d.id]: { ok: false, text } }));
      flash(text, 'error');
    } finally {
      setSyncing((s) => ({ ...s, [d.id]: false }));
      loadDevices();
    }
  };

  const resetImport = () => {
    setFile(null); setCsvRaw(''); setPreview(null); setFileError('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const runImport = async (raw, dryRun) => {
    setImporting(true);
    try {
      const body = { csv_data: raw, dry_run: dryRun };
      if (importDevice) body.device_id = Number(importDevice);
      const res = await api.post('/biometric/logs/import', body);
      if (dryRun) { setPreview(res.data); return; }
      const r = res.data;
      flash(`Imported ${r.imported} punch(es): ${r.attendance_updated} applied to attendance`
        + (r.duplicates ? `, ${r.duplicates} already imported` : '')
        + (r.attendance_locked ? `, ${r.attendance_locked} in a frozen/locked period` : '')
        + (r.errors?.length ? `, ${r.errors.length} row(s) skipped` : '') + '.');
      resetImport(); loadLog(); onDataChanged();
    } catch (err) {
      setPreview(null);
      setFileError(errText(err, 'Import failed'));
    } finally { setImporting(false); }
  };

  const acceptFile = (f) => {
    resetImport();
    if (!f) return;
    const isCsv = /\.csv$/i.test(f.name) || f.type === 'text/csv';
    if (!isCsv) { setFileError(`"${f.name}" is not a CSV file.`); return; }
    if (f.size === 0) { setFileError(`"${f.name}" is empty.`); return; }
    if (f.size > MAX_BYTES) { setFileError(`"${f.name}" is larger than 2 MB.`); return; }
    setFile(f);
    const reader = new FileReader();
    reader.onload = (ev) => { const raw = String(ev.target.result || ''); setCsvRaw(raw); runImport(raw, true); };
    reader.onerror = () => setFileError(`Could not read "${f.name}".`);
    reader.readAsText(f);
  };

  // Re-preview when the device changes: the device id is part of what is saved.
  useEffect(() => {
    if (csvRaw) runImport(csvRaw, true);
    // Only a device change re-runs the preview; a new file runs its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importDevice]);

  const notPunched = dashStats?.non_working_day ? null : dashStats?.not_yet_punched;
  const pie = [
    { name: 'Punched In', value: dashStats?.punched_in_today ?? 0 },
    { name: 'Not Punched', value: notPunched ?? 0 },
  ];

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 480px', minWidth: 0 }}>
          <h4 style={{ color: '#4c1d95', margin: '0 0 14px' }}>Registered Biometric Devices</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            {devices.length === 0 && (
              <div style={{ padding: 14, color: '#6b7280', fontSize: 13, background: '#faf8ff', borderRadius: 10 }}>
                No devices are registered. Add one under Attendance → Settings → Devices.
              </div>
            )}
            {devices.map((d) => {
              const st = deviceState(d);
              const result = syncResult[d.id];
              return (
                <div key={d.id} data-testid={`device-${d.id}`} style={{ padding: '12px 16px', background: '#f5f3ff', borderRadius: 10, border: '1px solid #e9e4ff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <div style={{ width: 10, height: 10, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{d.device_name} <span style={S.pill(st.color)}>{st.label}</span></div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{[d.location, d.ip_address && `${d.ip_address}:${d.port}`, d.device_type].filter(Boolean).join(' · ')}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{st.note}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                      <div style={{ textAlign: 'right', fontSize: 12 }}>
                        <div style={{ color: '#6b7280' }} title={d.last_sync ? fmtStamp(d.last_sync) : ''}>
                          Last sync: {d.last_sync ? `${fmtStamp(d.last_sync)} (${relativeTime(d.last_sync)})` : 'Never'}
                        </div>
                        <div style={{ color: '#6B3FDB', fontWeight: 600 }}>{Number(d.total_punches_today || 0)} punches today</div>
                      </div>
                      {canImport && (
                        <button type="button" onClick={() => syncDevice(d)} disabled={!!syncing[d.id] || !d.ip_address}
                          style={{ ...S.primary, padding: '6px 14px', fontSize: 12, whiteSpace: 'nowrap', opacity: (syncing[d.id] || !d.ip_address) ? 0.6 : 1, cursor: (syncing[d.id] || !d.ip_address) ? 'not-allowed' : 'pointer' }}>
                          {syncing[d.id] ? '⏳ Syncing…' : '↻ Sync Now'}
                        </button>
                      )}
                    </div>
                  </div>
                  {result && (
                    <div role="status" style={{ marginTop: 8, fontSize: 12, color: result.ok ? '#166534' : '#b91c1c' }}>{result.text}</div>
                  )}
                </div>
              );
            })}
          </div>

          {canImport && (
            <>
              <h4 style={{ color: '#4c1d95', margin: '0 0 10px' }}>Manual CSV Import</h4>
              <div
                data-testid="csv-drop"
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); acceptFile(e.dataTransfer?.files?.[0]); }}
                style={{ background: dragOver ? '#ede9fe' : '#f5f3ff', border: '2px dashed #a78bfa', borderRadius: 10, padding: 20, textAlign: 'center', marginBottom: 14 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
                <p style={{ margin: '0 0 8px', color: '#4c1d95', fontWeight: 600 }}>Drop a CSV file here or select one</p>
                <p style={{ margin: '0 0 12px', fontSize: 12, color: '#6b7280' }}>
                  Columns: <code>employee_id, punch_time, punch_type</code> · employee code (EMP001) or mapped biometric ID ·
                  time as <code>YYYY-MM-DD HH:mm</code> or <code>DD/MM/YYYY HH:mm</code> (company time) · type <code>in</code>/<code>out</code> · max 2 MB
                </p>
                <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => acceptFile(e.target.files?.[0])} style={{ display: 'none' }} id="csv-upload" />
                <label htmlFor="csv-upload" style={{ ...S.primary, display: 'inline-block' }}>Select CSV File</label>
                {file && <div style={{ marginTop: 8, fontSize: 12, color: '#4c1d95' }}>{file.name}</div>}
              </div>
              {fileError && <div role="alert" style={{ marginBottom: 12, color: '#b91c1c', fontSize: 13 }}>{fileError}</div>}

              {preview && (
                <div data-testid="import-preview" style={{ marginBottom: 14, border: '1px solid #e9e4ff', borderRadius: 10, padding: 12 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 10 }}>
                    <Field label="Recorded against device (optional)" width={220}>
                      <select value={importDevice} onChange={(e) => setImportDevice(e.target.value)} style={S.input}>
                        <option value="">No device</option>
                        {devices.map((d) => <option key={d.id} value={String(d.id)}>{d.device_name}</option>)}
                      </select>
                    </Field>
                  </div>
                  <div style={{ fontSize: 13, color: '#374151', marginBottom: 8 }}>
                    <strong>{preview.total_rows}</strong> row(s) checked: <strong>{preview.valid_rows}</strong> valid
                    {' · '}{preview.attendance_updated} will update attendance
                    {preview.duplicates ? ` · ${preview.duplicates} already imported (skipped)` : ''}
                    {preview.attendance_locked ? ` · ${preview.attendance_locked} in a frozen/locked period (logged only)` : ''}
                    {preview.errors?.length ? ` · ${preview.errors.length} with problems (skipped)` : ''}
                  </div>
                  {preview.errors?.length > 0 && (
                    <ul style={{ margin: '0 0 10px', paddingLeft: 18, maxHeight: 140, overflowY: 'auto', fontSize: 12, color: '#b91c1c' }}>
                      {preview.errors.slice(0, 50).map((e) => <li key={e}>{e}</li>)}
                      {preview.errors.length > 50 && <li>…and {preview.errors.length - 50} more</li>}
                    </ul>
                  )}
                  {preview.preview?.length > 0 && (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead><tr style={{ background: '#f5f3ff' }}>{['Row', 'Employee', 'Time', 'Type', 'Result'].map((h) => <th key={h} style={S.th}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.preview.map((r) => (
                            <tr key={r.row} style={{ borderBottom: '1px solid #f0ebff' }}>
                              <td style={S.td}>{r.row}</td>
                              <td style={S.td}>{employees.find((e) => e.id === r.employee_id)?.name || r.employee_key}</td>
                              <td style={S.td}>{fmtStamp(r.punch_time)}</td>
                              <td style={S.td}>{r.punch_type.toUpperCase()}</td>
                              <td style={S.td}>{({ applied: 'Updates attendance', duplicate: 'Already imported', frozen: 'Payroll period frozen — logged only', locked: 'Record locked — logged only' })[r.outcome] || r.outcome}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <button type="button" onClick={() => runImport(csvRaw, false)} disabled={importing || !preview.valid_rows || preview.valid_rows === preview.duplicates}
                      style={{ ...S.primary, background: '#16a34a', opacity: (importing || !preview.valid_rows) ? 0.6 : 1 }}>
                      {importing ? 'Importing…' : `✓ Import ${Math.max(0, preview.valid_rows - preview.duplicates)} punch(es)`}
                    </button>
                    <button type="button" onClick={resetImport} style={S.secondary}>Cancel</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ background: '#f5f3ff', borderRadius: 12, padding: 16, border: '1px solid #e9e4ff', flex: '0 1 220px', minWidth: 200, textAlign: 'center' }}>
          <h4 style={{ margin: '0 0 10px', color: '#4c1d95', fontSize: 13 }}>Today&apos;s Attendance</h4>
          <div style={{ height: 160 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pie} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value">
                  <Cell fill="#6B3FDB" />
                  <Cell fill="#e9e4ff" />
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: '#6B3FDB' }}>{dashStats?.punched_in_today ?? 0}</div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {dashStats?.non_working_day
              ? dashStats.non_working_day
              : `of ${dashStats?.expected ?? 0} expected${dashStats?.on_leave ? ` (${dashStats.on_leave} on leave)` : ''}`}
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, maxWidth: 200 }}>Device and CSV punches only</div>
        </div>
      </div>

      <h4 style={{ color: '#4c1d95', margin: '24px 0 12px' }}>Recent Punch Log</h4>
      <div style={S.filterBar} data-testid="log-filters">
        <Field label="From" width={140}><input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter('from', e.target.value)} style={S.input} /></Field>
        <Field label="To" width={140}><input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter('to', e.target.value)} style={S.input} /></Field>
        <Field label="Search" width={180}><input type="search" placeholder="Name, code or device user" value={filters.q} onChange={(e) => setFilter('q', e.target.value)} style={S.input} /></Field>
        <Field label="Employee" width={180}><EmployeeSelect employees={employees} value={filters.employee_id} onChange={(v) => setFilter('employee_id', v)} placeholder="All employees" /></Field>
        <Field label="Department" width={150}>
          <select value={filters.department} onChange={(e) => setFilter('department', e.target.value)} style={S.input}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="Device" width={150}>
          <select value={filters.device_id} onChange={(e) => setFilter('device_id', e.target.value)} style={S.input}>
            <option value="">All devices</option>
            {devices.map((d) => <option key={d.id} value={String(d.id)}>{d.device_name}</option>)}
          </select>
        </Field>
        <Field label="Type" width={110}>
          <select value={filters.punch_type} onChange={(e) => setFilter('punch_type', e.target.value)} style={S.input}>
            <option value="">In &amp; out</option>
            <option value="in">In</option>
            <option value="out">Out</option>
          </select>
        </Field>
        <button type="button" onClick={clearFilters} style={{ ...S.secondary, padding: '7px 12px' }}>Reset filters</button>
      </div>
      {logError && <div role="alert" style={{ color: '#b91c1c', fontSize: 13, marginBottom: 8 }}>{logError}</div>}
      <div style={{ overflowX: 'auto', opacity: logLoading ? 0.6 : 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="punch-log">
          <thead><tr style={{ background: '#f5f3ff' }}>
            {['Employee', 'Department', 'Date & Time', 'Type', 'Device', 'Source'].map((h) => <th key={h} style={S.th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {log.rows.length === 0 && !logLoading && (
              <EmptyRow cols={6} filtered={filtered} onClear={clearFilters} what="punches" />
            )}
            {log.rows.map((p) => (
              <tr key={p.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                <td style={{ ...S.td, fontWeight: 600 }}>
                  {p.employee_name || (
                    <span style={{ color: '#b45309' }}>
                      {p.employee_id != null ? `Employee #${p.employee_id} (no longer on record)` : `Unmatched device user ${p.device_user_id || '—'}`}
                    </span>
                  )}
                  {p.emp_code && <span style={{ color: '#9ca3af', fontWeight: 400, fontSize: 11 }}> · {p.emp_code}</span>}
                </td>
                <td style={{ ...S.td, color: '#6b7280' }}>{p.department || '—'}</td>
                <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{fmtStamp(p.punch_time)}</td>
                <td style={S.td}>
                  <span style={S.pill(p.punch_type === 'in' ? '#16a34a' : p.punch_type === 'out' ? '#6d28d9' : '#b45309')}>
                    {String(p.punch_type || '?').toUpperCase()}
                  </span>
                </td>
                <td style={{ ...S.td, color: '#6b7280', fontSize: 12 }}>{p.device_name || '—'}</td>
                <td style={{ ...S.td, color: '#6b7280', fontSize: 12 }}>{({ csv_import: 'CSV import', device_sync: 'Device sync', face: 'Face', offline_sync: 'Offline sync' })[p.source] || (p.source ?? '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={log.page || page} pageSize={log.page_size || 50} total={log.total} onPage={setPage} />
    </div>
  );
}
