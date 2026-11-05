import { useState, useEffect, useRef } from 'react';
import {
  FileText, Trash2, CheckCircle, XCircle, ExternalLink, X, ChevronDown,
  Users, Download,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { openEmployeeFile } from '@/features/employees/shared/employeeFiles';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  peekEmployeeListFilter, clearEmployeeListFilter,
} from '@/features/employees/employeeListFilter';
import { downloadCsv, maskAadhaarInText } from '@/features/employees/csvExport';
import { localDay } from '@/utils/dateFormatter';

const DOC_TYPES = [
  'Offer Letter', 'Appointment Letter', 'Contract', 'NDA',
  'Aadhar Card', 'PAN Card', 'Passport', 'Driving License',
  'Educational Certificate', 'Experience Letter',
  'Bank Details', 'Cancelled Cheque', 'Address Proof', 'Other',
];

const STATUS_META = {
  verified: { bg: '#dcfce7', color: '#15803d', label: 'Verified' },
  pending:  { bg: '#ede9fe', color: '#5b21b6', label: 'Pending' },
  rejected: { bg: '#fee2e2', color: '#dc2626', label: 'Rejected' },
};

function normalizeDoc(doc) {
  const rawStatus = doc.status || (doc.verified ? 'verified' : 'pending');
  return {
    ...doc,
    name:        doc.document_name || doc.name || 'Untitled',
    type:        doc.document_type || doc.type || 'Other',
    source:      doc.drive_url ? 'Drive' : (doc.file_url ? 'Upload' : '—'),
    view_url:    doc.drive_url || doc.file_url || null,
    uploaded_by: doc.uploaded_by_name || doc.verified_by_name || 'HR',
    uploaded_at: (doc.uploaded_at || doc.created_at || '').slice(0, 10),
    expiry_date: doc.expiry_date ? doc.expiry_date.slice(0, 10) : null,
    status:      rawStatus,
    employee_name: doc.employee_name || null,
    employee_code: doc.employee_code || null,
    employee_department: doc.employee_department || null,
  };
}

function isExpiringSoon(expiryDate) {
  if (!expiryDate) return false;
  const days = Math.ceil((new Date(expiryDate) - Date.now()) / 86400000);
  return days >= 0 && days <= 30;
}

function isExpired(expiryDate) {
  if (!expiryDate) return false;
  return new Date(expiryDate) < new Date();
}

/**
 * The "Export filtered" file: exactly the rows the table is showing, in the
 * columns the table shows, plus Days Left (what the old Document Expiry report
 * on Employee Reports was for). Notes and file links are not on screen and are
 * not exported — the CSV never says more than the page.
 *
 * Every text cell goes through maskAadhaarInText: there is no Aadhaar column
 * here, but a document name is free text and "Aadhar Card 2345 6789 0123" is the
 * obvious thing to type. Formula quoting is applied by downloadCsv/buildCsv.
 */
export const DOCUMENT_EXPORT_HEADERS = [
  'Emp Code', 'Employee', 'Department', 'Document', 'Type', 'Source',
  'Expiry Date', 'Days Left', 'Date', 'Status',
];

export function documentExportRows(docs) {
  return docs.map(d => {
    const daysLeft = d.expiry_date
      ? Math.ceil((new Date(d.expiry_date) - Date.now()) / 86400000)
      : '';
    return [
      d.employee_code, d.employee_name, d.employee_department,
      d.name, d.type, d.source,
      d.expiry_date || '', daysLeft, d.uploaded_at || '',
      (STATUS_META[d.status] || STATUS_META.pending).label,
    ].map(v => (typeof v === 'string' ? maskAadhaarInText(v) : (v ?? '')));
  });
}

export default function EmployeeDocuments({ setPage: _setPage }) {
  // HR runs the cross-employee audit (add/verify/reject/delete). Everyone else
  // — employees — gets a read-only view of their own documents only.
  const { user, hasPermission } = useAuth();
  // employee_documents — the explicit HR document grant the server checks
  // (§202). It used to be the broad 'hr' module, which payroll_admin holds.
  const canManage = hasPermission('employee_documents', 'add') || hasPermission('employee_documents', 'edit');
  const myEmpId   = user?.employee_id ? String(user.employee_id) : null;

  const [docs,        setDocs]        = useState([]);
  const [employees,   setEmployees]   = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [toast,       setToast]       = useState(null);
  const [drawer,      setDrawer]      = useState(false);

  // Filters
  const [filterEmp,    setFilterEmp]    = useState('');   // '' = all
  const [filterType,   setFilterType]   = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  // Expiry is a CLIENT-side filter: the API has no expiry predicate and the
  // page already holds every row it would filter. '' = all, 'attention' =
  // expired or expiring within 30 days, 'expired', 'expiring'.
  // Seeded from the Employees Dashboard's "Expiring Docs" card, which used to
  // land here with no filter at all — a count of 4 followed by the full
  // document register.
  // ⚠ Honour whichever bucket the dashboard sent. This used to test only for
  // 'expiring' and map it to 'attention'; once the Documents tile's overdue
  // badge became its own link it started sending 'expired', which fell
  // straight through to '' and opened the register unfiltered — the exact
  // failure the handoff exists to prevent.
  const [filterExpiry, setFilterExpiry] = useState(() => {
    const wanted = peekEmployeeListFilter()?.expiry;
    return ['expired', 'expiring', 'attention'].includes(wanted) ? wanted : '';
  });
  useEffect(() => { clearEmployeeListFilter(); }, []);

  // Add form
  const [form, setForm] = useState({
    employee_id: '', name: '', type: DOC_TYPES[0],
    drive_url: '', expiry_date: '', notes: '',
  });
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);

  const abortRef = useRef(null);

  // Load employee list for filter dropdown + add form (HR only)
  useEffect(() => {
    if (!canManage) return;
    api.get('/employees')
      .then(r => {
        const raw = r.data?.employees || r.data || [];
        setEmployees(Array.isArray(raw) ? raw : []);
      })
      .catch(() => {});
  }, [canManage]);

  // Load documents — cross-employee for HR, own documents only for employees
  const loadDocs = () => {
    if (!canManage && !myEmpId) { setDocs([]); return; }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    const params = { employee_id: canManage ? (filterEmp || 'all') : myEmpId };
    if (filterType)   params.doc_type = filterType;
    if (filterStatus) params.status   = filterStatus;

    api.get('/self-service/documents', { params, signal: ctrl.signal })
      .then(r => setDocs((Array.isArray(r.data) ? r.data : []).map(normalizeDoc)))
      .catch(e => { if (e.name !== 'CanceledError') showToast('Failed to load documents', 'error'); })
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadDocs(); }, [filterEmp, filterType, filterStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') setDrawer(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleAdd = async () => {
    if (!form.employee_id) return showToast('Select an employee', 'error');
    if (!form.name.trim()) return showToast('Document name is required', 'error');
    try {
      const res = await api.post('/self-service/documents', {
        employee_id:   form.employee_id,
        document_name: form.name,
        document_type: form.type,
        drive_url:     form.drive_url || null,
        expiry_date:   form.expiry_date || null,
        notes:         form.notes || null,
      });
      setDocs(d => [normalizeDoc(res.data), ...d]);
      showToast('Document record added');
      setDrawer(false);
      setForm({ employee_id: '', name: '', type: DOC_TYPES[0], drive_url: '', expiry_date: '', notes: '' });
    } catch (err) {
      showToast(err.response?.data?.message || 'Failed to add document record', 'error');
    }
  };

  const handleVerify = async (id, newStatus) => {
    try {
      const res = await api.patch(`/self-service/documents/${id}`, { status: newStatus });
      setDocs(d => d.map(doc => doc.id === id ? normalizeDoc(res.data) : doc));
      showToast(newStatus === 'verified' ? 'Document verified' : 'Document rejected');
    } catch (err) {
      showToast(err.response?.data?.message || 'Failed to update document', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await api.delete(`/self-service/documents/${id}`);
      setDocs(d => d.filter(doc => doc.id !== id));
      showToast('Document removed');
    } catch (err) {
      showToast(err.response?.data?.message || 'Failed to delete document', 'error');
    }
  };

  // Derived counts for summary chips
  const pendingCount  = docs.filter(d => d.status === 'pending').length;
  const expiredCount  = docs.filter(d => isExpired(d.expiry_date)).length;
  const expiringSoon  = docs.filter(d => isExpiringSoon(d.expiry_date)).length;

  // ⚠ The table used to render `docs` directly while three <select>s sat above
  // it. Those three happen to be server-side (loadDocs re-queries on change),
  // so it worked — but any client-side filter added later would have been
  // silently ignored. One list, one place it is narrowed.
  const visibleDocs = docs.filter(d => {
    if (!filterExpiry) return true;
    const expired  = isExpired(d.expiry_date);
    const expiring = isExpiringSoon(d.expiry_date);
    if (filterExpiry === 'expired')   return expired;
    if (filterExpiry === 'expiring')  return expiring;
    if (filterExpiry === 'attention') return expired || expiring;
    return true;
  });

  return (
    <PageShell dock={
      <PageHero
        icon={Users}
        eyebrow="Human Resources"
        title={canManage ? 'Employee Documents' : 'My Documents'}
        actions={canManage && (
          <button className="plh-cta"
            onClick={() => setDrawer(true)}>
            + Add Document Record
          </button>
        )}
      />
    }>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Document"
        message="Delete this document record? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, padding: '12px 20px',
          borderRadius: 8, zIndex: 9999, fontWeight: 600, fontSize: 13,
          background: toast.type === 'error' ? '#fee2e2' : '#dcfce7',
          color:      toast.type === 'error' ? '#dc2626' : '#15803d',
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}


      {/* Summary chips */}
      {docs.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
          <Chip label={`${docs.length} total`} bg="#f3f4f6" color="#374151" />
          {pendingCount > 0  && <Chip label={`${pendingCount} pending verification`} bg="#ede9fe" color="#5b21b6" onClick={() => setFilterStatus('pending')} />}
          {expiredCount > 0  && <Chip label={`${expiredCount} expired`}             bg="#fee2e2" color="#dc2626" onClick={() => setFilterExpiry('expired')} />}
          {expiringSoon > 0  && <Chip label={`${expiringSoon} expiring in 30 days`} bg="#fff7ed" color="#b45309" onClick={() => setFilterExpiry('expiring')} />}
        </div>
      )}

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {canManage && (
          <SelectFilter
            value={filterEmp}
            onChange={setFilterEmp}
            placeholder="All Employees"
            options={employees.map(e => ({ value: String(e.id), label: `${e.first_name} ${e.last_name}` }))}
          />
        )}
        <SelectFilter
          value={filterType}
          onChange={setFilterType}
          placeholder="All Types"
          options={DOC_TYPES.map(t => ({ value: t, label: t }))}
        />
        <SelectFilter
          value={filterStatus}
          onChange={setFilterStatus}
          placeholder="All Statuses"
          options={[
            { value: 'pending',  label: 'Pending' },
            { value: 'verified', label: 'Verified' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        <SelectFilter
          value={filterExpiry}
          onChange={setFilterExpiry}
          placeholder="Any Expiry"
          options={[
            { value: 'attention', label: 'Expired or expiring' },
            { value: 'expired',   label: 'Expired' },
            { value: 'expiring',  label: 'Expiring in 30 days' },
          ]}
        />
        {(filterEmp || filterType || filterStatus || filterExpiry) && (
          <button
            onClick={() => { setFilterEmp(''); setFilterType(''); setFilterStatus(''); setFilterExpiry(''); }}
            style={{ background: 'none', border: '1px solid #e5e7eb', borderRadius: 7, padding: '7px 12px', fontSize: 12, cursor: 'pointer', color: '#6b7280' }}
          >
            Clear filters
          </button>
        )}
        {/* Replaces the Document Expiry CSV that used to sit on Employee Reports:
            the export now lives with the filters it should respect. */}
        {canManage && (
          <button
            type="button"
            onClick={() => {
              const scope = (filterEmp || filterType || filterStatus || filterExpiry) ? 'filtered' : 'all';
              const stamp = localDay();
              downloadCsv(DOCUMENT_EXPORT_HEADERS, documentExportRows(visibleDocs),
                `employee-documents-${scope}-${stamp}.csv`);
            }}
            disabled={loading || visibleDocs.length === 0}
            title="Download the documents currently listed as CSV"
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 7, padding: '7px 12px', fontSize: 12, fontWeight: 600, color: '#374151', cursor: (loading || visibleDocs.length === 0) ? 'default' : 'pointer', opacity: (loading || visibleDocs.length === 0) ? 0.5 : 1 }}
          >
            <Download size={13} /> Export filtered ({visibleDocs.length})
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading documents…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                {['Employee', 'Document', 'Type', 'Source', 'Expiry', 'Date', 'Status', ''].map(h => (
                  <th key={h} style={{ padding: '11px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleDocs.map(doc => {
                const sm = STATUS_META[doc.status] || STATUS_META.pending;
                const expired    = isExpired(doc.expiry_date);
                const expireSoon = isExpiringSoon(doc.expiry_date);
                return (
                  <tr key={doc.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    {/* Employee */}
                    <td style={{ padding: '11px 14px' }}>
                      {doc.employee_name ? (
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{doc.employee_name}</div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>{doc.employee_code}{doc.employee_department ? ` · ${doc.employee_department}` : ''}</div>
                        </div>
                      ) : <span style={{ color: '#9ca3af', fontSize: 13 }}>—</span>}
                    </td>
                    {/* Document name */}
                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <FileText size={14} color="#6366f1" />
                        <span style={{ fontSize: 13, fontWeight: 500 }}>{doc.name}</span>
                      </div>
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 13, color: '#6b7280' }}>{doc.type}</td>
                    {/* Source */}
                    <td style={{ padding: '11px 14px' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12,
                        background: doc.source === 'Drive' ? '#eff6ff' : doc.source === 'Upload' ? '#f0fdf4' : '#f3f4f6',
                        color:      doc.source === 'Drive' ? '#2563eb' : doc.source === 'Upload' ? '#15803d' : '#9ca3af',
                      }}>
                        {doc.source}
                      </span>
                    </td>
                    {/* Expiry */}
                    <td style={{ padding: '11px 14px', fontSize: 13, whiteSpace: 'nowrap', color: expired ? '#dc2626' : expireSoon ? '#5b21b6' : '#6b7280', fontWeight: (expired || expireSoon) ? 600 : 400 }}>
                      {doc.expiry_date || '—'}
                      {expired    && <span style={{ marginLeft: 4, fontSize: 10, background: '#fee2e2', color: '#dc2626', padding: '1px 5px', borderRadius: 4 }}>EXPIRED</span>}
                      {!expired && expireSoon && <span style={{ marginLeft: 4, fontSize: 10, background: '#fff7ed', color: '#5b21b6', padding: '1px 5px', borderRadius: 4 }}>SOON</span>}
                    </td>
                    <td style={{ padding: '11px 14px', fontSize: 12, color: '#9ca3af', whiteSpace: 'nowrap' }}>{doc.uploaded_at}</td>
                    {/* Status badge */}
                    <td style={{ padding: '11px 14px' }}>
                      <span style={{ fontSize: 11, background: sm.bg, color: sm.color, padding: '3px 10px', borderRadius: 20, fontWeight: 600 }}>
                        {sm.label}
                      </span>
                    </td>
                    {/* Actions */}
                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                        {doc.view_url && (
                          <ActionBtn
                            title="View / Open"
                            // A Drive link opens as-is; an uploaded file goes through the
                            // authenticated /files route (employeeFiles.js).
                            onClick={async () => { const err = await openEmployeeFile(doc.view_url); if (err) showToast(err, 'error'); }}
                            icon={<ExternalLink size={12} color="#6b7280" />}
                            bg="#f3f4f6"
                          />
                        )}
                        {canManage && doc.status !== 'verified' && (
                          <ActionBtn
                            title="Verify document"
                            onClick={() => handleVerify(doc.id, 'verified')}
                            icon={<CheckCircle size={12} color="#15803d" />}
                            bg="#dcfce7"
                          />
                        )}
                        {canManage && doc.status === 'pending' && (
                          <ActionBtn
                            title="Reject document"
                            onClick={() => handleVerify(doc.id, 'rejected')}
                            icon={<XCircle size={12} color="#dc2626" />}
                            bg="#fee2e2"
                          />
                        )}
                        {canManage && doc.status !== 'verified' && (
                          <ActionBtn
                            title="Delete"
                            onClick={() => setPendingHandleDelete(doc.id)}
                            icon={<Trash2 size={12} color="#dc2626" />}
                            bg="#fee2e2"
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {!loading && docs.length === 0 && (
          <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>
            <FileText size={36} color="#d1d5db" style={{ marginBottom: 8, display: 'block', margin: '0 auto 8px' }} />
            <p style={{ margin: 0, fontWeight: 500 }}>No document records found</p>
            {(filterEmp || filterType || filterStatus) && (
              <p style={{ margin: '4px 0 0', fontSize: 12 }}>Try clearing the filters above</p>
            )}
          </div>
        )}
      </div>

      {/* Add Document drawer/modal */}
      {drawer && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setDrawer(false)}
        >
          <div
            style={{ background: '#fff', borderRadius: 14, padding: 28, width: 460, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Add Document Record</h3>
              <button onClick={() => setDrawer(false)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <Field label="Employee *">
                <select
                  style={inputStyle}
                  value={form.employee_id}
                  onChange={e => setForm(f => ({ ...f, employee_id: e.target.value }))}
                >
                  <option value="">— Select employee —</option>
                  {employees.filter(e => e.status !== 'Left').map(e => (
                    <option key={e.id} value={e.id}>{e.first_name} {e.last_name} ({e.office_id || e.department || ''})</option>
                  ))}
                </select>
              </Field>

              <Field label="Document Name *">
                <input
                  style={inputStyle}
                  placeholder="e.g. Passport Copy, Degree Certificate"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </Field>

              <Field label="Document Type">
                <select
                  style={inputStyle}
                  value={form.type}
                  onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                >
                  {DOC_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </Field>

              <Field label="Google Drive URL">
                <input
                  style={inputStyle}
                  placeholder="https://drive.google.com/file/d/…"
                  value={form.drive_url}
                  onChange={e => setForm(f => ({ ...f, drive_url: e.target.value }))}
                />
              </Field>

              <Field label="Expiry Date (for passports, visas, certifications)">
                <input
                  type="date"
                  style={inputStyle}
                  value={form.expiry_date}
                  onChange={e => setForm(f => ({ ...f, expiry_date: e.target.value }))}
                />
              </Field>

              <Field label="Notes">
                <textarea
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical' }}
                  placeholder="Optional HR notes…"
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                />
              </Field>
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 22, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setDrawer(false)}
                style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#6366f1', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
              >
                Add Record
              </button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function Chip({ label, bg, color, onClick }) {
  return (
    <span
      onClick={onClick}
      style={{
        fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 20,
        background: bg, color,
        cursor: onClick ? 'pointer' : 'default',
        border: `1px solid ${color}22`,
      }}
    >
      {label}
    </span>
  );
}

function SelectFilter({ value, onChange, placeholder, options }) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          appearance: 'none', padding: '7px 30px 7px 12px',
          border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13,
          color: value ? '#111827' : '#6b7280', background: value ? '#f5f3ff' : '#fff',
          cursor: 'pointer',
        }}
      >
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={13} color="#9ca3af" style={{ position: 'absolute', right: 9, pointerEvents: 'none' }} />
    </div>
  );
}

function ActionBtn({ title, onClick, icon, bg }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ background: bg, border: 'none', borderRadius: 6, padding: '5px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
    >
      {icon}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%', padding: '8px 12px', borderRadius: 8,
  border: '1px solid #e5e7eb', fontSize: 13, boxSizing: 'border-box',
};
