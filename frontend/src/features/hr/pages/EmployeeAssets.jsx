// frontend/src/features/hr/pages/EmployeeAssets.jsx
import { useState, useEffect, useCallback, useRef } from 'react';
import { Users } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import VocabSelect from '@/components/core/VocabSelect';
import { downloadCsv } from '@/features/employees/csvExport';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { localDay } from '@/utils/dateFormatter';

const P = '#6B3FDB';

const STATUS_STYLE = {
  allocated:         { bg: '#dbeafe', color: '#1e40af' },
  returned:          { bg: '#d1fae5', color: '#065f46' },
  under_maintenance: { bg: '#ede9fe', color: '#5b21b6' },
  disposed:          { bg: '#e5e7eb', color: '#374151' },
  lost:              { bg: '#fee2e2', color: '#991b1b' },
  damaged:           { bg: '#ede9fe', color: '#5b21b6' },
};
function Badge({ status }) {
  const s = STATUS_STYLE[status?.toLowerCase()] || { bg: '#f3f4f6', color: '#6b7280' };
  return <span style={{ background: s.bg, color: s.color, padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 600, textTransform: 'capitalize', whiteSpace: 'nowrap' }}>{status ? status.replace(/_/g, ' ') : '—'}</span>;
}

// Asset types come from the ASSET_TYPE master (Master Data → Asset Type), the
// same list Add Employee uses and the API validates against. A hard-coded copy
// here lacked Access Card and SIM Card, so those could never be allocated.
const DELETABLE = ['returned', 'disposed'];
const EDIT_FIELDS = ['asset_type', 'asset_name', 'asset_tag', 'serial_number', 'brand', 'model', 'allocated_date', 'condition_in', 'notes'];

/** DD Mon YY. A bare 'YYYY-MM-DD' is read as a LOCAL date — `new Date('Y-M-D')` is UTC midnight. */
function fmtDate(v) {
  if (!v) return '—';
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) && s.length <= 10
    ? new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))
    : new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

/** Under maintenance and past its expected return date. */
const isOverdue = (a, today) => a.status === 'under_maintenance'
  && a.maintenance_expected_return && String(a.maintenance_expected_return).slice(0, 10) < today;
const DISPOSABLE = ['allocated', 'returned', 'under_maintenance', 'lost', 'damaged'];
const EMPTY_FORM  = { employee_id: '', asset_type: '', asset_name: '', asset_tag: '', serial_number: '', brand: '', model: '', allocated_date: localDay(), condition_in: 'good', notes: '' };

export default function EmployeeAssets() {
  const [assets,      setAssets]      = useState([]);
  const [employees,   setEmployees]   = useState([]);
  const [masterTypes, setMasterTypes] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [msg,         setMsg]         = useState({ text: '', type: '' });
  const [showForm,    setShowForm]    = useState(false);
  const [form,        setForm]        = useState(EMPTY_FORM);
  const [saving,      setSaving]      = useState(false);
  const [filterEmp,   setFilterEmp]   = useState('');
  const [filterStatus,setFilterStatus]= useState('');
  const [filterType,  setFilterType]  = useState('');
  // Hide rows whose employee has left or was deleted. On by default; the
  // choice is remembered per browser (a convenience only, so storage may fail).
  const [hideLeft, setHideLeft] = useState(() => {
    try { return localStorage.getItem('employeeAssets.hideLeft') !== '0'; } catch { return true; }
  });
  const toggleHideLeft = (v) => {
    setHideLeft(v);
    try { localStorage.setItem('employeeAssets.hideLeft', v ? '1' : '0'); } catch { /* ignore */ }
  };
  const [returnModal, setReturnModal] = useState(null);
  const [returnForm,  setReturnForm]  = useState({ return_date: localDay(), condition_out: 'good', notes: '' });
  const [transferModal, setTransferModal] = useState(null);
  const [transferForm,  setTransferForm]  = useState({ to_employee_id: '', notes: '' });
  const [maintModal,    setMaintModal]    = useState(null);
  const [maintForm,     setMaintForm]     = useState({ expected_return_date: '', notes: '' });
  const [completeModal, setCompleteModal] = useState(null);
  const [completeForm,  setCompleteForm]  = useState({ condition_in: 'good', notes: '' });
  const [disposeModal,  setDisposeModal]  = useState(null);
  const [disposeForm,   setDisposeForm]   = useState({ reason: '', notes: '' });
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const [editModal,     setEditModal]     = useState(null);
  const [editForm,      setEditForm]      = useState({});
  const [reissueModal,  setReissueModal]  = useState(null);
  const [reissueForm,   setReissueForm]   = useState({ employee_id: '', allocated_date: localDay(), condition_in: '', notes: '' });
  const [historyModal,  setHistoryModal]  = useState(null);
  const [history,       setHistory]       = useState({ loading: false, error: '', data: null });
  const today = localDay();
  const abortRef = useRef(null);

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 4000);
  };

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError('');
    try {
      const [aRes, eRes] = await Promise.all([
        api.get('/employee-assets', { signal: ctrl.signal }),
        api.get('/employees?status=active,probation', { signal: ctrl.signal }),
      ]);
      setAssets(aRes.data || []);
      setEmployees(eRes.data?.employees || eRes.data?.data || eRes.data || []);
      // The type filter lists the master; a failure here only narrows the
      // filter to the types already on screen, so it must not fail the page.
      api.get('/master/v/asset-types', { signal: ctrl.signal })
        .then(r => setMasterTypes((Array.isArray(r.data) ? r.data : []).map(t => t.name).filter(Boolean)))
        .catch(() => {});
    } catch (e) {
      /* Axios rejects a cancelled request with `CanceledError` / `ERR_CANCELED`,
       * never a DOM `AbortError` — so the old test matched nothing and reported
       * every abort as a failure. Under StrictMode the mount → cleanup → mount
       * cycle aborts the first request, which painted "Failed to load asset
       * data" over the data the second request had just loaded. Same defect as
       * HRBenchmarkingDashboard; these two were the only pages checking for the
       * name axios does not throw. */
      if (e?.name !== 'CanceledError' && e?.code !== 'ERR_CANCELED') {
        setError('Failed to load asset data');
      }
    } finally {
      // A superseded request must not clear the spinner the live one turned on.
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);

  // Master types plus any legacy type already on a record, so every row stays filterable.
  const typeOptions = [...new Set([...masterTypes, ...assets.map(a => a.asset_type).filter(Boolean)])]
    .sort((x, y) => x.localeCompare(y));

  // Filtered view. Search is by name or employee code (EMP001) — matching the
  // raw numeric id as a substring made "2" hit every id containing a 2.
  const leftCount = assets.filter(a => a.employee_left).length;
  // The KPI counts and the table both follow the checkbox, so they agree.
  const shown = hideLeft ? assets.filter(a => !a.employee_left) : assets;
  const filtered = shown.filter(a => {
    const q = filterEmp.trim().toLowerCase();
    if (q && !a.employee_name?.toLowerCase().includes(q) && !String(a.employee_code || '').toLowerCase().includes(q)) return false;
    if (filterStatus && a.status?.toLowerCase() !== filterStatus.toLowerCase()) return false;
    if (filterType   && a.asset_type?.toLowerCase() !== filterType.toLowerCase()) return false;
    return true;
  });

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.employee_id) return flash('Select an employee', 'error');
    if (!form.asset_type)  return flash('Select an asset type', 'error');
    if (!form.asset_name)  return flash('Asset name is required', 'error');
    setSaving(true);
    try {
      await api.post('/employee-assets', form);
      flash('Asset allocated successfully');
      setShowForm(false);
      setForm(EMPTY_FORM);
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to allocate asset', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleReturn(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/employee-assets/${returnModal.id}/return`, returnForm);
      flash(returnForm.condition_out === 'lost' ? 'Asset marked lost'
        : returnForm.condition_out === 'damaged' ? 'Asset returned as damaged'
        : 'Asset returned successfully');
      setReturnModal(null);
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to process return', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleTransfer(e) {
    e.preventDefault();
    if (!transferForm.to_employee_id) return flash('Select an employee to transfer to', 'error');
    setSaving(true);
    try {
      await api.post(`/employee-assets/${transferModal.id}/transfer`, transferForm);
      flash('Asset transferred successfully');
      setTransferModal(null);
      setTransferForm({ to_employee_id: '', notes: '' });
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to transfer asset', 'error');
    } finally { setSaving(false); }
  }

  async function handleSendToMaintenance(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/employee-assets/${maintModal.id}/maintenance`, maintForm);
      flash('Asset sent to maintenance');
      setMaintModal(null);
      setMaintForm({ expected_return_date: '', notes: '' });
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to send asset to maintenance', 'error');
    } finally { setSaving(false); }
  }

  async function handleCompleteMaintenance(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/employee-assets/${completeModal.id}/maintenance/complete`, completeForm);
      flash('Asset back in service');
      setCompleteModal(null);
      setCompleteForm({ condition_in: 'good', notes: '' });
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to complete maintenance', 'error');
    } finally { setSaving(false); }
  }

  async function handleDispose(e) {
    e.preventDefault();
    if (!disposeForm.reason) return flash('A disposal reason is required', 'error');
    setSaving(true);
    try {
      await api.patch(`/employee-assets/${disposeModal.id}/dispose`, disposeForm);
      flash('Asset disposed');
      setDisposeModal(null);
      setDisposeForm({ reason: '', notes: '' });
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to dispose asset', 'error');
    } finally { setSaving(false); }
  }

  function openEdit(a) {
    setEditModal(a);
    setEditForm(Object.fromEntries(EDIT_FIELDS.map(k => [k,
      k === 'allocated_date' ? String(a[k] || '').slice(0, 10) : (a[k] ?? '')])));
  }

  async function handleEdit(e) {
    e.preventDefault();
    if (!String(editForm.asset_name || '').trim()) return flash('Asset name is required', 'error');
    // Send only what changed, so an untouched field is never rewritten.
    const changed = Object.fromEntries(EDIT_FIELDS
      .filter(k => String(editForm[k] ?? '') !== String((k === 'allocated_date' ? String(editModal[k] || '').slice(0, 10) : editModal[k]) ?? ''))
      .map(k => [k, editForm[k]]));
    if (!Object.keys(changed).length) { setEditModal(null); return; }
    setSaving(true);
    try {
      await api.put(`/employee-assets/${editModal.id}`, changed);
      flash('Asset details updated');
      setEditModal(null);
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to update asset', 'error');
    } finally { setSaving(false); }
  }

  async function handleReissue(e) {
    e.preventDefault();
    if (!reissueForm.employee_id) return flash('Select an employee', 'error');
    setSaving(true);
    try {
      await api.post(`/employee-assets/${reissueModal.id}/reissue`, {
        ...reissueForm, condition_in: reissueForm.condition_in || undefined,
      });
      flash('Asset re-issued');
      setReissueModal(null);
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Failed to re-issue asset', 'error');
    } finally { setSaving(false); }
  }

  async function openHistory(a) {
    setHistoryModal(a);
    setHistory({ loading: true, error: '', data: null });
    try {
      const r = await api.get(`/employee-assets/${a.id}/history`);
      setHistory({ loading: false, error: '', data: r.data });
    } catch (e) {
      setHistory({ loading: false, error: e.response?.data?.message || 'Could not load history', data: null });
    }
  }

  function exportCsv() {
    const headers = ['Employee', 'Employee Code', 'Employee Left', 'Asset Name', 'Type', 'Asset Tag', 'Serial Number',
      'Brand', 'Model', 'Allocated', 'Condition In', 'Status', 'Returned', 'Condition Out',
      'Maintenance Due Back', 'Maintenance Overdue', 'Disposal Reason', 'Notes'];
    const rows = filtered.map(a => [
      a.employee_name?.trim() || `Employee #${a.employee_id}`, a.employee_code || '', a.employee_left ? 'Yes' : '',
      a.asset_name, a.asset_type, a.asset_tag || '', a.serial_number || '', a.brand || '', a.model || '',
      fmtDate(a.allocated_date), a.condition_in || '', a.status, a.return_date ? fmtDate(a.return_date) : '',
      a.condition_out || '', a.maintenance_expected_return ? fmtDate(a.maintenance_expected_return) : '',
      isOverdue(a, today) ? 'Yes' : '', a.disposal_reason || '', a.notes || '',
    ]);
    downloadCsv(headers, rows, `asset-register-${today}.csv`);
  }

  async function handleDelete() {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/employee-assets/${id}`);
      flash('Deleted');
      load();
    } catch (e) {
      flash(e.response?.data?.message || 'Delete failed', 'error');
    }
  }

  // Summary counts
  const totalAllocated  = shown.filter(a => a.status === 'allocated').length;
  const totalMaint      = shown.filter(a => a.status === 'under_maintenance').length;
  const totalReturned   = shown.filter(a => a.status === 'returned').length;
  const totalDisposed   = shown.filter(a => a.status === 'disposed').length;
  const totalLost       = shown.filter(a => a.status === 'lost' || a.status === 'damaged').length;
  const totalOverdue    = shown.filter(a => isOverdue(a, today)).length;

  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
  const lbl = { fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 };
  const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
  const sheet = (maxWidth) => ({ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' });
  const btnCancel = { padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' };
  const btnGo = (bg) => ({ padding: '9px 20px', borderRadius: 8, border: 'none', background: bg, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' });
  const xBtn = { background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' };

  return (
    <PageShell dock={
      <PageHero
        icon={Users}
        eyebrow="Human Resources"
        title="Employee Assets"
        subtitle="IT assets, tools and equipment allocated to employees"
        actions={<>
          <button className="plh-cta plh-cta--ghost" onClick={load}>↻ Refresh</button>
          <button className="plh-cta plh-cta--ghost" onClick={exportCsv} disabled={!filtered.length}
            title="Download the rows currently shown, with the filters applied">⤓ Export CSV</button>
          <button className="plh-cta" onClick={() => { setShowForm(true); setForm(EMPTY_FORM); }}>+ Allocate Asset</button>
        </>}
      />
    }>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Asset Record"
        message="Delete this asset record?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {/* Toast */}
      {msg.text && (
        <div style={{ position: 'fixed', top: 20, right: 24, background: msg.type === 'error' ? '#fee2e2' : '#d1fae5', color: msg.type === 'error' ? '#991b1b' : '#065f46', padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 12px rgba(0,0,0,.15)' }}>{msg.text}</div>
      )}

      {/* Header */}


      {/* KPI strip */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          { label: 'Total Assets', value: shown.length, accent: P },
          { label: 'Currently Allocated', value: totalAllocated, accent: '#2563eb' },
          { label: 'Under Maintenance', value: totalMaint, accent: '#6d28d9' },
          { label: 'Maintenance Overdue', value: totalOverdue, accent: totalOverdue ? '#dc2626' : '#6b7280' },
          { label: 'Returned', value: totalReturned, accent: '#059669' },
          { label: 'Disposed', value: totalDisposed, accent: '#6b7280' },
          { label: 'Lost / Damaged', value: totalLost, accent: '#dc2626' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 20px', minWidth: 140 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: k.accent }}>{k.value}</div>
          </div>
        ))}
      </div>

      {error && <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', color: '#991b1b', fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <input placeholder="Search employee…" value={filterEmp} onChange={e => setFilterEmp(e.target.value)}
          style={{ ...inp, width: 200 }} />
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inp, width: 140 }}>
          <option value="">All Statuses</option>
          <option value="allocated">Allocated</option>
          <option value="under_maintenance">Under Maintenance</option>
          <option value="returned">Returned</option>
          <option value="disposed">Disposed</option>
          <option value="lost">Lost</option>
          <option value="damaged">Damaged</option>
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ ...inp, width: 160 }}>
          <option value="">All Asset Types</option>
          {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', cursor: 'pointer', padding: '0 4px', userSelect: 'none' }}
          title="Hide assets whose employee has left the company or was deleted">
          <input type="checkbox" checked={hideLeft} onChange={e => toggleHideLeft(e.target.checked)}
            style={{ width: 15, height: 15, accentColor: P, cursor: 'pointer' }} />
          Hide employees who have left{leftCount ? ` (${leftCount})` : ''}
        </label>
        {(filterEmp || filterStatus || filterType) && (
          <button onClick={() => { setFilterEmp(''); setFilterStatus(''); setFilterType(''); }}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#6b7280' }}>Clear</button>
        )}
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        {loading
          ? <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading assets…</div>
          : !filtered.length
            ? <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>
                No asset records found
                {hideLeft && leftCount > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12 }}>
                    {leftCount} record{leftCount === 1 ? '' : 's'} of employees who have left {leftCount === 1 ? 'is' : 'are'} hidden.{' '}
                    <button onClick={() => toggleHideLeft(false)} style={{ background: 'none', border: 'none', color: P, cursor: 'pointer', fontSize: 12, fontWeight: 600, padding: 0 }}>Show them</button>
                  </div>
                )}
              </div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['Employee', 'Asset Name', 'Type', 'Tag / Serial', 'Brand / Model', 'Allocated', 'Condition', 'Status', 'Actions'].map(h => (
                        <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(a => (
                      <tr key={a.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>
                          {a.employee_name || `Employee #${a.employee_id}`}
                          {a.employee_code && <div style={{ fontSize: 11, fontWeight: 400, color: '#9ca3af' }}>{a.employee_code}</div>}
                          {a.employee_left && (
                            <span title="This employee has left or was deleted. Recover or dispose of anything still out with them."
                              style={{ display: 'inline-block', marginTop: 2, background: 'var(--color-danger-bg, #fee2e2)', color: 'var(--color-danger, #991b1b)', padding: '1px 6px', borderRadius: 10, fontSize: 10, fontWeight: 700 }}>
                              Left
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#374151' }}>{a.asset_name}</td>
                        <td style={{ padding: '10px 14px', color: '#6b7280' }}>{a.asset_type}</td>
                        <td style={{ padding: '10px 14px', color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>
                          {a.asset_tag && <div>{a.asset_tag}</div>}
                          {a.serial_number && <div style={{ color: '#9ca3af' }}>{a.serial_number}</div>}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                          {a.brand && <div>{a.brand}</div>}
                          {a.model && <div style={{ color: '#9ca3af', fontSize: 11 }}>{a.model}</div>}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>
                          {fmtDate(a.allocated_date)}
                          {a.return_date && <div style={{ fontSize: 11, color: '#6b7280' }}>Returned: {fmtDate(a.return_date)}</div>}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                          {a.condition_in && <span>In: {a.condition_in}</span>}
                          {a.condition_out && <span style={{ marginLeft: 6 }}>Out: {a.condition_out}</span>}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <Badge status={a.status} />
                          {a.status === 'under_maintenance' && a.maintenance_expected_return && (
                            <div style={{ fontSize: 11, marginTop: 3, whiteSpace: 'nowrap', color: isOverdue(a, today) ? '#dc2626' : '#6b7280', fontWeight: isOverdue(a, today) ? 700 : 400 }}>
                              {isOverdue(a, today) ? 'Overdue · ' : 'Due back '}{fmtDate(a.maintenance_expected_return)}
                            </div>
                          )}
                          {a.reissued_as && <div style={{ fontSize: 11, marginTop: 3, color: '#6b7280' }}>Re-issued</div>}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {a.status === 'allocated' && (
                              <>
                                <button onClick={() => setReturnModal(a)}
                                  style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #059669', background: 'transparent', color: '#059669', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Return</button>
                                <button onClick={() => setTransferModal(a)}
                                  style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #2563eb', background: 'transparent', color: '#2563eb', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Transfer</button>
                                <button onClick={() => setMaintModal(a)}
                                  style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #6d28d9', background: 'transparent', color: '#6d28d9', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Maintenance</button>
                              </>
                            )}
                            {a.status === 'under_maintenance' && (
                              <button onClick={() => setCompleteModal(a)}
                                style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #059669', background: 'transparent', color: '#059669', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Back in Service</button>
                            )}
                            {a.status === 'returned' && !a.reissued_as && (
                              <button onClick={() => { setReissueModal(a); setReissueForm({ employee_id: '', allocated_date: localDay(), condition_in: '', notes: '' }); }}
                                style={{ padding: '4px 10px', borderRadius: 5, border: `1px solid ${P}`, background: 'transparent', color: P, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Re-issue</button>
                            )}
                            {a.status !== 'disposed' && !a.reissued_as && (
                              <button onClick={() => openEdit(a)}
                                style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #d1d5db', background: 'transparent', color: '#374151', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Edit</button>
                            )}
                            <button onClick={() => openHistory(a)}
                              style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #d1d5db', background: 'transparent', color: '#374151', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>History</button>
                            {DISPOSABLE.includes(a.status) && !a.reissued_as && (
                              <button onClick={() => setDisposeModal(a)}
                                style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #6b7280', background: 'transparent', color: '#6b7280', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Dispose</button>
                            )}
                            {/* Only closed-out records can be deleted (the API refuses the rest). */}
                            {DELETABLE.includes(a.status) && !a.reissued_as && (
                              <button onClick={() => setPendingHandleDelete(a.id)}
                                style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #fca5a5', background: 'transparent', color: '#dc2626', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Delete</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        }
      </div>

      {/* Allocate Asset Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>Allocate Asset</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Employee *</label>
                  <select value={form.employee_id} onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))} style={inp} required>
                    <option value="">— Select employee —</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name || ''} ({e.office_id || e.id})</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Asset Type *</label>
                  <VocabSelect searchable vocab="asset-types" id="ea-asset-type" ariaLabel="Asset type"
                    value={form.asset_type} selectStyle={inp}
                    onChange={v => setForm(f => ({ ...f, asset_type: v }))} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Asset Name *</label>
                  <input value={form.asset_name} onChange={e => setForm(f => ({ ...f, asset_name: e.target.value }))} style={inp} placeholder="e.g. Dell Laptop" required />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Asset Tag</label>
                  <input value={form.asset_tag} onChange={e => setForm(f => ({ ...f, asset_tag: e.target.value }))} style={inp} placeholder="e.g. IT-0042" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Serial Number</label>
                  <input value={form.serial_number} onChange={e => setForm(f => ({ ...f, serial_number: e.target.value }))} style={inp} placeholder="SN-XXXXXX" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Brand</label>
                  <input value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))} style={inp} placeholder="Dell, Apple…" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Model</label>
                  <input value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} style={inp} placeholder="XPS 15, MacBook Pro…" />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Allocated Date</label>
                  <input type="date" value={form.allocated_date} onChange={e => setForm(f => ({ ...f, allocated_date: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Condition (In)</label>
                  <select value={form.condition_in} onChange={e => setForm(f => ({ ...f, condition_in: e.target.value }))} style={inp}>
                    {['new', 'good', 'fair', 'poor'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                  <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 64, resize: 'vertical' }} placeholder="Any special instructions or remarks…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowForm(false)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Saving…' : 'Allocate Asset'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Return Modal */}
      {returnModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Process Return</h2>
              <button onClick={() => setReturnModal(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{returnModal.asset_name}</strong> — {returnModal.employee_name}
            </div>
            <form onSubmit={handleReturn}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Return Date</label>
                  <input type="date" value={returnForm.return_date} onChange={e => setReturnForm(f => ({ ...f, return_date: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Condition on Return</label>
                  <select value={returnForm.condition_out} onChange={e => setReturnForm(f => ({ ...f, condition_out: e.target.value }))} style={inp}>
                    {['new', 'good', 'fair', 'poor', 'damaged', 'lost'].map(c => <option key={c}>{c}</option>)}
                  </select>
                  {returnForm.condition_out === 'lost' && (
                    <div style={{ marginTop: 6, fontSize: 12, color: '#991b1b' }}>
                      The asset will be marked <strong>Lost</strong>, not returned. It keeps blocking this employee's exit clearance until you dispose of it (write it off).
                    </div>
                  )}
                  {returnForm.condition_out === 'damaged' && (
                    <div style={{ marginTop: 6, fontSize: 12, color: '#5b21b6' }}>
                      The asset will be marked <strong>Damaged</strong>. It counts as handed back, so it no longer blocks exit clearance.
                    </div>
                  )}
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                  <textarea value={returnForm.notes} onChange={e => setReturnForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} placeholder="Condition remarks, damage notes…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setReturnModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Processing…' : 'Confirm Return'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Transfer Modal */}
      {transferModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Transfer Asset</h2>
              <button onClick={() => setTransferModal(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{transferModal.asset_name}</strong> — currently with {transferModal.employee_name}
            </div>
            <form onSubmit={handleTransfer}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Transfer To *</label>
                  <select value={transferForm.to_employee_id} onChange={e => setTransferForm(f => ({ ...f, to_employee_id: e.target.value }))} style={inp} required>
                    <option value="">— Select employee —</option>
                    {employees.filter(e => String(e.id) !== String(transferModal.employee_id)).map(e => (
                      <option key={e.id} value={e.id}>{e.first_name} {e.last_name || ''} ({e.office_id || e.id})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                  <textarea value={transferForm.notes} onChange={e => setTransferForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} placeholder="Reason for transfer…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setTransferModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Transferring…' : 'Confirm Transfer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Send to Maintenance Modal */}
      {maintModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Send to Maintenance</h2>
              <button onClick={() => setMaintModal(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{maintModal.asset_name}</strong> — {maintModal.employee_name}
            </div>
            <form onSubmit={handleSendToMaintenance}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Expected Return Date</label>
                  <input type="date" value={maintForm.expected_return_date} onChange={e => setMaintForm(f => ({ ...f, expected_return_date: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                  <textarea value={maintForm.notes} onChange={e => setMaintForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} placeholder="Issue being serviced…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setMaintModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#6d28d9', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Saving…' : 'Send to Maintenance'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Complete Maintenance Modal */}
      {completeModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Back in Service</h2>
              <button onClick={() => setCompleteModal(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{completeModal.asset_name}</strong> — {completeModal.employee_name}
            </div>
            <form onSubmit={handleCompleteMaintenance}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Condition</label>
                  <select value={completeForm.condition_in} onChange={e => setCompleteForm(f => ({ ...f, condition_in: e.target.value }))} style={inp}>
                    {['new', 'good', 'fair', 'poor'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                  <textarea value={completeForm.notes} onChange={e => setCompleteForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} placeholder="Repair/service summary…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setCompleteModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Saving…' : 'Confirm'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Dispose Modal */}
      {disposeModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Dispose Asset</h2>
              <button onClick={() => setDisposeModal(null)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{disposeModal.asset_name}</strong> — {disposeModal.employee_name}
              <div style={{ marginTop: 4, color: '#991b1b', fontSize: 12 }}>This is terminal — the asset will no longer count against anyone's exit clearance.</div>
            </div>
            <form onSubmit={handleDispose}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Reason *</label>
                  <select value={disposeForm.reason} onChange={e => setDisposeForm(f => ({ ...f, reason: e.target.value }))} style={inp} required>
                    <option value="">— Select reason —</option>
                    {['End of life', 'Beyond repair', 'Lost', 'Stolen', 'Obsolete', 'Other'].map(r => <option key={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                  <textarea value={disposeForm.notes} onChange={e => setDisposeForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} placeholder="Additional detail…" />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setDisposeModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
                <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#6b7280', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>
                  {saving ? 'Disposing…' : 'Confirm Disposal'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Details Modal — details only; holder and status change via their own actions. */}
      {editModal && (
        <div style={overlay}>
          <div style={sheet(540)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827' }}>Edit Asset Details</h2>
              <button onClick={() => setEditModal(null)} style={xBtn}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
              With {editModal.employee_name?.trim() || `Employee #${editModal.employee_id}`}. To change who has it or its status, use Transfer, Return, Maintenance or Dispose.
            </div>
            <form onSubmit={handleEdit}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
                <div>
                  <label style={lbl} htmlFor="ea-edit-type">Asset Type *</label>
                  <VocabSelect searchable vocab="asset-types" id="ea-edit-type" ariaLabel="Asset type"
                    value={editForm.asset_type} selectStyle={inp}
                    onChange={v => setEditForm(f => ({ ...f, asset_type: v }))} />
                </div>
                <div>
                  <label style={lbl}>Asset Name *</label>
                  <input value={editForm.asset_name} onChange={e => setEditForm(f => ({ ...f, asset_name: e.target.value }))} style={inp} required />
                </div>
                {[['asset_tag', 'Asset Tag'], ['serial_number', 'Serial Number'], ['brand', 'Brand'], ['model', 'Model']].map(([k, label]) => (
                  <div key={k}>
                    <label style={lbl}>{label}</label>
                    <input value={editForm[k]} onChange={e => setEditForm(f => ({ ...f, [k]: e.target.value }))} style={inp} />
                  </div>
                ))}
                <div>
                  <label style={lbl}>Allocated Date</label>
                  <input type="date" value={editForm.allocated_date} onChange={e => setEditForm(f => ({ ...f, allocated_date: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label style={lbl}>Condition (In)</label>
                  <select value={editForm.condition_in} onChange={e => setEditForm(f => ({ ...f, condition_in: e.target.value }))} style={inp}>
                    {[...new Set(['new', 'good', 'fair', 'poor', editForm.condition_in].filter(Boolean))].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={lbl}>Notes</label>
                  <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 64, resize: 'vertical' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setEditModal(null)} style={btnCancel}>Cancel</button>
                <button type="submit" disabled={saving} style={btnGo(P)}>{saving ? 'Saving…' : 'Save Changes'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Re-issue Modal — a returned asset goes out again, linked to its earlier record. */}
      {reissueModal && (
        <div style={overlay}>
          <div style={sheet(420)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Re-issue Asset</h2>
              <button onClick={() => setReissueModal(null)} style={xBtn}>×</button>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{reissueModal.asset_name}</strong>{reissueModal.asset_tag ? ` · ${reissueModal.asset_tag}` : ''}
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                Returned by {reissueModal.employee_name?.trim() || `Employee #${reissueModal.employee_id}`} on {fmtDate(reissueModal.return_date)}, condition {reissueModal.condition_out || '—'}
              </div>
            </div>
            <form onSubmit={handleReissue}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <label style={lbl}>Issue To *</label>
                  <select value={reissueForm.employee_id} onChange={e => setReissueForm(f => ({ ...f, employee_id: e.target.value }))} style={inp} required>
                    <option value="">— Select employee —</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name || ''} ({e.office_id || e.id})</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Issue Date</label>
                  <input type="date" value={reissueForm.allocated_date} onChange={e => setReissueForm(f => ({ ...f, allocated_date: e.target.value }))} style={inp} />
                </div>
                <div>
                  <label style={lbl}>Condition (In)</label>
                  <select value={reissueForm.condition_in} onChange={e => setReissueForm(f => ({ ...f, condition_in: e.target.value }))} style={inp}>
                    <option value="">As returned ({reissueModal.condition_out || 'good'})</option>
                    {['new', 'good', 'fair', 'poor'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={lbl}>Notes</label>
                  <textarea value={reissueForm.notes} onChange={e => setReissueForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setReissueModal(null)} style={btnCancel}>Cancel</button>
                <button type="submit" disabled={saving} style={btnGo(P)}>{saving ? 'Issuing…' : 'Re-issue'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* History Modal — every event for this physical asset, across re-issues. */}
      {historyModal && (
        <div style={overlay} onClick={() => setHistoryModal(null)}>
          <div style={sheet(560)} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Asset History</h2>
              <button onClick={() => setHistoryModal(null)} style={xBtn}>×</button>
            </div>
            <div style={{ fontSize: 13, color: '#374151', marginBottom: 16 }}>
              <strong>{historyModal.asset_name}</strong>
              {[historyModal.asset_tag, historyModal.serial_number].filter(Boolean).map(t => <span key={t} style={{ color: '#9ca3af', fontFamily: 'monospace', fontSize: 12 }}> · {t}</span>)}
            </div>
            {history.loading && <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>Loading history…</div>}
            {history.error && <div style={{ background: '#fee2e2', color: '#991b1b', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>{history.error}</div>}
            {history.data && (
              <>
                {history.data.records.length > 1 && (
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
                    Issued {history.data.records.length} times: {history.data.records.map(r => r.holder).join(' → ')}
                  </div>
                )}
                {!history.data.events.length
                  ? <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>No recorded events</div>
                  : (
                    <ol style={{ listStyle: 'none', margin: 0, padding: 0, borderLeft: '2px solid #e5e7eb' }}>
                      {history.data.events.map((ev, k) => (
                        <li key={k} style={{ position: 'relative', padding: '0 0 14px 16px' }}>
                          <span style={{ position: 'absolute', left: -6, top: 4, width: 10, height: 10, borderRadius: '50%', background: P }} />
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>
                            {ev.label}
                            <span style={{ fontWeight: 400, color: '#9ca3af', fontSize: 12 }}> · {fmtDate(ev.at)}{ev.by ? ` · by ${ev.by}` : ''}</span>
                          </div>
                          {ev.detail && <div style={{ fontSize: 12, color: '#4b5563', marginTop: 2 }}>{ev.detail}</div>}
                          {ev.source === 'record' && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>From the record's dates (no audit entry)</div>}
                        </li>
                      ))}
                    </ol>
                  )}
              </>
            )}
          </div>
        </div>
      )}
    </PageShell>
  );
}
