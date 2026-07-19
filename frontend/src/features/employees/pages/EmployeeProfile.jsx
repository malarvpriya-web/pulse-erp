import { useState, useEffect, useRef } from "react";
import api from "@/services/api/client";
import './EmployeesData.css';
import { useToast } from '@/context/ToastContext';

const P      = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const BASE_TABS = ['Overview', 'Personal', 'Job', 'Payroll', 'Documents', 'Assets', 'Onboarding', 'History', 'Notes'];

// NOTE: InfoRow and Card are defined at module scope (not inside the component)
// so their identity is stable across renders. Defining them inline would make
// React remount the subtree on every keystroke, stealing focus from inputs
// like the Notes textarea.
const InfoRow = ({ label, value }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 0', borderBottom: `1px solid ${BORDER}` }}>
    <span style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
    <span style={{ fontSize: 14, color: '#111827', fontWeight: 500 }}>{value || '—'}</span>
  </div>
);

const Card = ({ title, children }) => (
  <div style={{
    background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
    padding: '20px 24px', display: 'flex', flexDirection: 'column',
  }}>
    <div style={{ fontSize: 13, fontWeight: 700, color: P, marginBottom: 8, paddingBottom: 10, borderBottom: `1px solid ${BORDER}` }}>{title}</div>
    {children}
  </div>
);

const EX_STATUSES = new Set(['left','terminated','resigned','inactive','ex-employee','notice_period','notice period']);
function isExStatus(s) { return EX_STATUSES.has((s || '').toLowerCase()); }

const SEPARATION_OPTIONS = [
  { value: 'resignation',  label: 'Resignation' },
  { value: 'termination',  label: 'Termination' },
  { value: 'retirement',   label: 'Retirement' },
  { value: 'contract_end', label: 'Contract End' },
  { value: 'attrition',    label: 'Attrition' },
];

// ── Offboard Modal ────────────────────────────────────────────────────────────
function OffboardModal({ employee, onClose, onDone }) {
  const today = new Date().toISOString().slice(0, 10);
  const toast = useToast();
  const [form, setForm] = useState({
    separation_type: 'resignation',
    last_working_date: today,
    notice_period: '',
    reason: '',
  });
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState('');

  async function submit() {
    if (!form.last_working_date) { setErr('Last working date is required'); return; }
    setSaving(true); setErr('');
    try {
      await api.post(`/employees/${employee.id}/offboard`, {
        ...form,
        notice_period: form.notice_period ? Number(form.notice_period) : undefined,
      });
      onDone();
      onClose();
    } catch (e) {
      setErr(e.response?.data?.error || 'Offboard failed');
    } finally { setSaving(false); }
  }

  const inp = {
    padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 7,
    fontSize: 13, width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, width: 460, padding: 28, boxShadow: '0 24px 64px rgba(0,0,0,.22)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#111827' }}>Initiate Offboarding</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>×</button>
        </div>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>
          <strong>{employee.first_name} {employee.last_name}</strong> · {employee.designation} · {employee.department}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Separation Type *</label>
            <select value={form.separation_type} onChange={e => setForm(f => ({ ...f, separation_type: e.target.value }))} style={inp}>
              {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Last Working Date *</label>
            <input type="date" value={form.last_working_date}
              onChange={e => setForm(f => ({ ...f, last_working_date: e.target.value }))}
              style={inp} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notice Period (days)</label>
            <input type="number" min="0" value={form.notice_period}
              onChange={e => setForm(f => ({ ...f, notice_period: e.target.value }))}
              placeholder="e.g. 60"
              style={inp} />
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Reason / Notes</label>
            <textarea rows={3} value={form.reason}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
              placeholder="Brief reason for separation…"
              style={{ ...inp, resize: 'vertical' }} />
          </div>
        </div>

        {err && <p style={{ margin: '10px 0 0', color: '#b91c1c', fontSize: 12 }}>{err}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 22 }}>
          <button onClick={onClose} style={{ padding: '9px 18px', border: `1px solid ${BORDER}`, borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{
            padding: '9px 18px', border: 'none', borderRadius: 8,
            background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700,
            cursor: saving ? 'default' : 'pointer', opacity: saving ? .7 : 1,
          }}>
            {saving ? 'Processing…' : 'Confirm Offboarding'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EmployeeProfile({ employee: employeeProp, setPage, setSelectedEmployee: _setSelectedEmployee, urlParams }) {
  const toast = useToast();

  const [employee, setEmployee] = useState(employeeProp || null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const isMounted = useRef(true);

  const [activeTab, setActiveTab] = useState("Overview");
  const [notesText, setNotesText] = useState("");
  const [notesList, setNotesList] = useState([]);
  const [showOffboardModal, setShowOffboardModal] = useState(false);
  const [exitData, setExitData] = useState(null);
  const [clearanceData, setClearanceData] = useState(null);
  const [docRecords, setDocRecords] = useState([]);
  const [assetRecords, setAssetRecords] = useState([]);
  const [assetLoading, setAssetLoading] = useState(false);
  const [onboardingData, setOnboardingData] = useState(null);
  const [onboardingLoading, setOnboardingLoading] = useState(false);
  const [onboardingInit, setOnboardingInit] = useState(false);
  const [salaryRevisions, setSalaryRevisions] = useState([]);
  const [salaryLoading, setSalaryLoading] = useState(false);
  const [clearanceSaving, setClearanceSaving] = useState(false);
  const [showExitEdit, setShowExitEdit] = useState(false);
  const [exitEditForm, setExitEditForm] = useState({ separation_type: '', last_working_date: '', exit_reason: '' });
  const [savingExit,   setSavingExit]   = useState(false);
  const [exitEditErr,  setExitEditErr]  = useState('');

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    if (employee) return;
    // Fast path: full object already in sessionStorage (skip if URL param overrides)
    const urlId = urlParams?.id ? String(urlParams.id) : null;
    try {
      const stored = JSON.parse(sessionStorage.getItem('selectedEmployee') || 'null');
      if (stored?.id && (!urlId || String(stored.id) === urlId)) { setEmployee(stored); return; }
    } catch {}
    // Slow path: fetch from backend using URL param or sessionStorage id
    const empId = urlId || sessionStorage.getItem('selectedEmployeeId');
    if (!empId) return;
    setLoading(true);
    setFetchError(null);
    api.get(`/employees/${empId}`)
      .then(res => {
        if (!isMounted.current) return;
        const data = res.data?.employee || res.data;
        if (data?.id) setEmployee(data);
        else setFetchError('Employee not found');
      })
      .catch(() => { if (isMounted.current) setFetchError('Failed to load employee'); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, [employee]);

  const fetchNotes = async () => {
    try {
      const res = await api.get(`/notes/${employee.id}`);
      setNotesList(Array.isArray(res.data) ? res.data : []);
    } catch {
      /* notes fetch failure is non-critical */
    }
  };

  useEffect(() => {
    if (employee?.id) fetchNotes();
  }, [employee?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveNote = async () => {
    if (!notesText.trim()) return;
    try {
      await api.post("/notes", { employeeId: employee.id, noteText: notesText });
      setNotesText("");
      fetchNotes();
    } catch (_err) {
      toast.error("Failed to save note");
    }
  };

  const openExitEdit = () => {
    setExitEditForm({
      separation_type:   exitData?.separation_type || employee?.separation_type || '',
      last_working_date: exitData?.last_working_date
        ? exitData.last_working_date.slice(0, 10)
        : (employee?.exit_date ? String(employee.exit_date).slice(0, 10) : ''),
      exit_reason: exitData?.reason || employee?.exit_reason || '',
    });
    setExitEditErr('');
    setShowExitEdit(true);
  };

  const saveExitDetails = async () => {
    setSavingExit(true); setExitEditErr('');
    try {
      await api.patch(`/employees/ex/${employee.id}/exit-details`, {
        separation_type:   exitEditForm.separation_type   || null,
        last_working_date: exitEditForm.last_working_date || null,
        exit_date:         exitEditForm.last_working_date || null,
        exit_reason:       exitEditForm.exit_reason       || null,
      });
      const r = await api.get(`/exit/employee/${employee.id}`);
      if (isMounted.current) {
        setExitData(r.data?.exit_request ?? null);
        setClearanceData(r.data?.clearance ?? null);
      }
      setShowExitEdit(false);
    } catch (e) {
      setExitEditErr(e.response?.data?.error || 'Save failed');
    } finally { setSavingExit(false); }
  };

  // Load exit request + clearance data when viewing an ex-employee
  useEffect(() => {
    if (!employee?.id) return;
    if (!isExStatus(employee.status)) return;
    api.get(`/exit/employee/${employee.id}`)
      .then(r => {
        if (!isMounted.current) return;
        setExitData(r.data?.exit_request ?? null);
        setClearanceData(r.data?.clearance ?? null);
      })
      .catch(() => { if (isMounted.current) toast.error('Could not load exit data'); });
  }, [employee?.id, employee?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load supplemental document records from employee_documents table
  useEffect(() => {
    if (!employee?.id) return;
    api.get('/self-service/documents', { params: { employee_id: employee.id } })
      .then(r => {
        if (!isMounted.current) return;
        setDocRecords(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {});
  }, [employee?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load employee asset allocations
  useEffect(() => {
    if (!employee?.id || activeTab !== 'Assets') return;
    setAssetLoading(true);
    api.get('/employee-assets', { params: { employee_id: employee.id } })
      .then(r => {
        if (!isMounted.current) return;
        setAssetRecords(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {})
      .finally(() => { if (isMounted.current) setAssetLoading(false); });
  }, [employee?.id, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load onboarding checklist progress
  useEffect(() => {
    if (!employee?.id || activeTab !== 'Onboarding') return;
    setOnboardingLoading(true);
    api.get(`/onboarding/progress/${employee.id}`)
      .then(r => { if (isMounted.current) setOnboardingData(r.data); })
      .catch(() => {})
      .finally(() => { if (isMounted.current) setOnboardingLoading(false); });
  }, [employee?.id, activeTab, onboardingInit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load salary revisions for History tab
  useEffect(() => {
    if (!employee?.id || activeTab !== 'History') return;
    setSalaryLoading(true);
    api.get(`/employees/${employee.id}/salary-revisions`)
      .then(r => { if (isMounted.current) setSalaryRevisions(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (isMounted.current) setSalaryRevisions([]); })
      .finally(() => { if (isMounted.current) setSalaryLoading(false); });
  }, [employee?.id, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
        Loading employee data…
      </div>
    );
  }

  if (fetchError || !employee) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
        {fetchError || 'No employee selected.'}{' '}
        <button onClick={() => setPage('EmployeesData')} style={{ color: P, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Go back</button>
      </div>
    );
  }

  const isEx  = isExStatus(employee.status);
  const TABS  = isEx ? [...BASE_TABS, 'Exit Details'] : BASE_TABS;

  const initials = `${(employee.first_name || '?').charAt(0)}${(employee.last_name || '').charAt(0)}`.toUpperCase();

  const fmtDate = (d) => d ? new Date(d.split('T')[0] + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
  const yearsFrom = (d) => d ? Math.floor((new Date() - new Date(d.split('T')[0] + 'T00:00:00')) / (365.25 * 24 * 60 * 60 * 1000)) : null;

  const STATUS_STYLE = {
    Active:    { bg: '#dcfce7', color: '#166534' },
    Probation: { bg: '#fef3c7', color: '#92400e' },
    Notice:    { bg: '#fee2e2', color: '#991b1b' },
    Left:      { bg: '#f3f4f6', color: '#6b7280' },
  };
  const ss = STATUS_STYLE[employee.status] || STATUS_STYLE.Active;

  return (
    <div style={{ margin: '-20px', background: '#f5f3ff', minHeight: '100vh' }}>

      {/* Edit Exit Details modal */}
      {showExitEdit && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, width: 440, padding: 24, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Edit Exit Details</h3>
              <button onClick={() => setShowExitEdit(false)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>×</button>
            </div>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
              {employee.first_name} {employee.last_name} · {employee.office_id}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Separation Type</label>
                <select value={exitEditForm.separation_type}
                  onChange={e => setExitEditForm(f => ({ ...f, separation_type: e.target.value }))}
                  style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' }}>
                  <option value="">— Not specified —</option>
                  {SEPARATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Last Working Date</label>
                <input type="date" value={exitEditForm.last_working_date}
                  onChange={e => setExitEditForm(f => ({ ...f, last_working_date: e.target.value }))}
                  style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Exit Reason / Details</label>
                <textarea rows={3} value={exitEditForm.exit_reason}
                  onChange={e => setExitEditForm(f => ({ ...f, exit_reason: e.target.value }))}
                  placeholder="Reason for leaving…"
                  style={{ padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
              </div>
            </div>
            {exitEditErr && <p style={{ margin: '12px 0 0', color: '#b91c1c', fontSize: 12 }}>{exitEditErr}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setShowExitEdit(false)} style={{ padding: '8px 16px', border: `1px solid ${BORDER}`, borderRadius: 7, background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveExitDetails} disabled={savingExit} style={{ padding: '8px 16px', border: 'none', borderRadius: 7, background: P, color: '#fff', fontSize: 13, fontWeight: 600, cursor: savingExit ? 'default' : 'pointer', opacity: savingExit ? .7 : 1 }}>
                {savingExit ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Offboard modal */}
      {showOffboardModal && (
        <OffboardModal
          employee={employee}
          onClose={() => setShowOffboardModal(false)}
          onDone={() => {
            // Reload employee so status badge and tabs update
            api.get(`/employees/${employee.id}`).then(r => {
              const data = r.data?.employee || r.data;
              if (data?.id) setEmployee(data);
            }).catch(() => {});
          }}
        />
      )}

      {/* ── Hero ── */}
      <div style={{
        background: 'linear-gradient(135deg, #4f46e5 0%, #6d28d9 60%, #6B3FDB 100%)',
        padding: '28px 32px 32px',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* decorative circles */}
        <div style={{ position:'absolute', top:-40, right:-40, width:180, height:180, borderRadius:'50%', background:'rgba(255,255,255,.06)' }} />
        <div style={{ position:'absolute', bottom:-30, left:'40%', width:120, height:120, borderRadius:'50%', background:'rgba(255,255,255,.05)' }} />

        {/* top row: back + actions */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24, position:'relative', zIndex:1 }}>
          <button onClick={() => setPage(isEx ? 'ExEmployees' : 'EmployeesData')} style={{
            display:'flex', alignItems:'center', gap:6,
            background:'rgba(255,255,255,.15)', border:'1px solid rgba(255,255,255,.25)',
            color:'#fff', borderRadius:8, padding:'7px 14px', fontSize:13, fontWeight:600, cursor:'pointer',
          }}>
            ← Back to List
          </button>
          <div style={{ display:'flex', gap:8 }}>
            {!isEx && (
              <button onClick={() => setShowOffboardModal(true)} style={{
                display:'flex', alignItems:'center', gap:6,
                background:'rgba(220,38,38,.85)', border:'none',
                color:'#fff', borderRadius:8, padding:'7px 14px', fontSize:13, fontWeight:700, cursor:'pointer',
              }}>
                🚪 Offboard
              </button>
            )}
            <button onClick={() => {
              sessionStorage.setItem('selectedEmployee', JSON.stringify(employee));
              sessionStorage.setItem('selectedEmployeeId', String(employee.id));
              setPage('EditEmployee');
            }} style={{
              display:'flex', alignItems:'center', gap:6,
              background:'#fff', border:'none',
              color: P, borderRadius:8, padding:'7px 16px', fontSize:13, fontWeight:700, cursor:'pointer',
            }}>
              ✏️ Edit Employee
            </button>
          </div>
        </div>

        {/* profile info row */}
        <div style={{ display:'flex', alignItems:'center', gap:20, position:'relative', zIndex:1 }}>
          {employee.photo_url ? (
            <img
              src={`${import.meta.env.VITE_API_URL?.replace('/api', '')}${employee.photo_url}`}
              alt={employee?.name ? `${employee.name} profile photo` : 'Employee profile photo'}
              style={{ width:80, height:80, borderRadius:'50%', border:'3px solid rgba(255,255,255,.4)', objectFit:'cover', flexShrink:0 }}
            />
          ) : (
            <div style={{
              width:80, height:80, borderRadius:'50%',
              background:'rgba(255,255,255,.2)', border:'3px solid rgba(255,255,255,.4)',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:28, fontWeight:800, color:'#fff', flexShrink:0,
            }}>
              {initials}
            </div>
          )}
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
              <h1 style={{ margin:0, fontSize:22, fontWeight:800, color:'#fff' }}>
                {employee.first_name} {employee.last_name}
              </h1>
              <span style={{
                padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700,
                background: ss.bg, color: ss.color,
              }}>
                {employee.status || 'Active'}
              </span>
            </div>
            <p style={{ margin:'4px 0 0', fontSize:14, color:'rgba(255,255,255,.8)' }}>
              {employee.designation}{employee.department ? ` · ${employee.department}` : ''}
            </p>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'12px 20px', marginTop:8 }}>
              {employee.office_id && (
                <span style={{ fontSize:12, color:'rgba(255,255,255,.7)' }}>🪪 {employee.office_id}</span>
              )}
              {employee.company_email && (
                <span style={{ fontSize:12, color:'rgba(255,255,255,.7)' }}>✉️ {employee.company_email}</span>
              )}
              {employee.phone && (
                <span style={{ fontSize:12, color:'rgba(255,255,255,.7)' }}>📱 {employee.phone}</span>
              )}
              {employee.joining_date && (
                <span style={{ fontSize:12, color:'rgba(255,255,255,.7)' }}>📅 Joined {fmtDate(employee.joining_date)}</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="emp-profile-tabs" style={{
        background:'#fff', borderBottom:`1px solid ${BORDER}`,
        padding:'0 32px', display:'flex', gap:0, overflowX:'auto',
        boxShadow:'0 1px 4px rgba(0,0,0,.04)',
      }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding:'14px 18px', border:'none', background:'none', cursor:'pointer',
              fontSize:13, fontWeight:600, whiteSpace:'nowrap',
              color: activeTab === tab ? P : '#6b7280',
              borderBottom: activeTab === tab ? `2px solid ${P}` : '2px solid transparent',
              transition:'color .15s',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="emp-profile-content" style={{ padding:'24px 32px 40px' }}>

        {/* OVERVIEW */}
        {activeTab === 'Overview' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            <Card title="Personal">
              <InfoRow label="Full Name" value={`${employee.first_name || ''} ${employee.last_name || ''}`.trim()} />
              <InfoRow label="Gender" value={employee.gender} />
              <InfoRow label="Blood Group" value={employee.blood_group} />
              <InfoRow label="Marital Status" value={employee.marital_status} />
              <InfoRow label="Date of Birth" value={fmtDate(employee.dob)} />
              <InfoRow label="Age" value={yearsFrom(employee.dob) != null ? `${yearsFrom(employee.dob)} years` : null} />
            </Card>
            <Card title="Work">
              <InfoRow label="Department" value={employee.department} />
              <InfoRow label="Designation" value={employee.designation} />
              <InfoRow label="Reporting Manager" value={employee.reporting_manager} />
              <InfoRow label="Location" value={employee.location} />
              <InfoRow label="Employment Type" value={employee.employment_type} />
              <InfoRow label="Zone" value={employee.zone} />
            </Card>
            <Card title="Joining">
              <InfoRow label="Joining Date" value={fmtDate(employee.joining_date)} />
              <InfoRow label="Experience Here" value={yearsFrom(employee.joining_date) != null ? `${yearsFrom(employee.joining_date)} years` : null} />
              <InfoRow label="Total Experience" value={(() => {
                const here = yearsFrom(employee.joining_date) || 0;
                const prev = (employee.previous_years_1 || 0) + (employee.previous_years_2 || 0);
                return `${here + prev} years`;
              })()} />
              <InfoRow label="Skill Type" value={employee.skill_type} />
            </Card>
          </div>
        )}

        {/* PERSONAL */}
        {activeTab === 'Personal' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            <Card title="Basic Info">
              <InfoRow label="Date of Birth" value={fmtDate(employee.dob)} />
              <InfoRow label="Gender" value={employee.gender} />
              <InfoRow label="Blood Group" value={employee.blood_group} />
              <InfoRow label="Marital Status" value={employee.marital_status} />
              <InfoRow label="Father's Name" value={employee.father_name} />
            </Card>
            <Card title="Contact">
              <InfoRow label="Mobile" value={employee.phone} />
              <InfoRow label="Company Email" value={employee.company_email} />
              <InfoRow label="Personal Email" value={employee.personal_email} />
              <InfoRow label="Current Address" value={employee.current_address} />
              <InfoRow label="Permanent Address" value={employee.permanent_address} />
            </Card>
            <Card title="Family">
              <InfoRow label="Mother's Name" value={employee.mother_name} />
              <InfoRow label="Spouse" value={employee.spouse_name} />
              <InfoRow label="Emergency Contact" value={employee.emergency_name} />
              <InfoRow label="Emergency Phone" value={employee.emergency_phone} />
              <InfoRow label="Relationship" value={employee.emergency_relationship} />
            </Card>
          </div>
        )}

        {/* JOB */}
        {activeTab === 'Job' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            <Card title="Position">
              <InfoRow label="Designation" value={employee.designation} />
              <InfoRow label="Department" value={employee.department} />
              <InfoRow label="Reporting Manager" value={employee.reporting_manager} />
              <InfoRow label="Location" value={employee.location} />
            </Card>
            <Card title="Employment">
              <InfoRow label="Employment Type" value={employee.employment_type} />
              <InfoRow label="Joining Date" value={fmtDate(employee.joining_date)} />
              <InfoRow label="Skill Type" value={employee.skill_type} />
              <InfoRow label="Zone" value={employee.zone} />
            </Card>
            <Card title="Previous Experience">
              <InfoRow label="Company 1" value={employee.previous_company_1} />
              <InfoRow label="Role" value={employee.previous_role_1} />
              <InfoRow label="Years" value={employee.previous_years_1 ? `${employee.previous_years_1} yr` : null} />
              <InfoRow label="Company 2" value={employee.previous_company_2} />
              <InfoRow label="Role" value={employee.previous_role_2} />
              <InfoRow label="Years" value={employee.previous_years_2 ? `${employee.previous_years_2} yr` : null} />
            </Card>
          </div>
        )}

        {/* PAYROLL */}
        {activeTab === 'Payroll' && (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:16 }}>
            <Card title="Bank Details">
              <InfoRow label="Bank Name" value={employee.bank_name} />
              <InfoRow label="Branch" value={employee.branch_name} />
              <InfoRow label="Account Number" value={employee.account_number} />
              <InfoRow label="IFSC Code" value={employee.ifsc_code} />
              <InfoRow label="Nominee" value={employee.nominee_name} />
            </Card>
            <Card title="Government IDs">
              <InfoRow label="PAN Number" value={employee.pan_number} />
              <InfoRow label="Aadhaar Number" value={employee.aadhaar_number} />
              <InfoRow label="PF Number" value={employee.pf_number} />
              <InfoRow label="UAN Number" value={employee.uan_number} />
              <InfoRow label="ESIC Number" value={employee.esic_number} />
            </Card>
            <Card title="Education">
              <InfoRow label="Highest Qualification" value={employee.highest_qualification} />
              <InfoRow label="Basic Qualification" value={employee.basic_qualification} />
            </Card>
          </div>
        )}

        {/* DOCUMENTS */}
        {activeTab === 'Documents' && (
          <div style={{ display:'flex', flexDirection:'column', gap:24 }}>

            {/* Section A: Compliance uploads (stored as employees columns) */}
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:P, marginBottom:12 }}>Compliance Uploads</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12 }}>
                {[
                  { key:'photo_url',            label:'Photo',            icon:'📷' },
                  { key:'resume_file',          label:'Resume',           icon:'📄' },
                  { key:'offer_letter_file',    label:'Offer Letter',     icon:'📋' },
                  { key:'pan_file',             label:'PAN Card',         icon:'🪪' },
                  { key:'aadhaar_file',         label:'Aadhaar',          icon:'🪪' },
                  { key:'cancelled_cheque_file',label:'Cancelled Cheque', icon:'🏦' },
                  { key:'bank_statement_file',  label:'Bank Statement',   icon:'📊' },
                ].filter(d => employee[d.key]).map(doc => (
                  <div
                    key={doc.key}
                    onClick={() => window.open(`${import.meta.env.VITE_API_URL?.replace('/api', '')}${employee[doc.key]}`, '_blank')}
                    style={{
                      background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12,
                      padding:'18px 14px', cursor:'pointer', textAlign:'center',
                      transition:'all .15s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = P; e.currentTarget.style.background = LIGHT; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = BORDER; e.currentTarget.style.background = '#fff'; }}
                  >
                    <div style={{ fontSize:28, marginBottom:6 }}>{doc.icon}</div>
                    <div style={{ fontSize:12, fontWeight:600, color:'#374151' }}>{doc.label}</div>
                    <div style={{ fontSize:11, color:P, marginTop:3, fontWeight:600 }}>View →</div>
                  </div>
                ))}
                {!['photo_url','resume_file','offer_letter_file','pan_file','aadhaar_file','cancelled_cheque_file','bank_statement_file'].some(k => employee[k]) && (
                  <div style={{ gridColumn:'1/-1', padding:'24px 0', color:'#9ca3af', fontSize:13 }}>
                    No compliance documents uploaded
                  </div>
                )}
              </div>
            </div>

            {/* Section B: HR document records (from employee_documents table) */}
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:P, marginBottom:12 }}>
                HR Document Records
                {docRecords.length > 0 && (
                  <span style={{ marginLeft:8, fontWeight:400, color:'#6b7280' }}>({docRecords.length})</span>
                )}
              </div>
              {docRecords.length === 0 ? (
                <div style={{ color:'#9ca3af', fontSize:13, padding:'8px 0' }}>
                  No supplemental document records. HR can add records from the Employee Documents audit page.
                </div>
              ) : (
                <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, overflow:'hidden' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead>
                      <tr style={{ background:'#f9fafb', borderBottom:`1px solid ${BORDER}` }}>
                        {['Document','Type','Source','Date','Expiry','Status'].map(h => (
                          <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11, fontWeight:600, color:'#9ca3af', textTransform:'uppercase', letterSpacing:'.04em' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {docRecords.map(doc => {
                        const status   = doc.status || (doc.verified ? 'verified' : 'pending');
                        const viewUrl  = doc.drive_url || doc.file_url || null;
                        const STATUS_C = { verified:'#15803d', pending:'#92400e', rejected:'#dc2626' };
                        const STATUS_B = { verified:'#dcfce7', pending:'#fef3c7', rejected:'#fee2e2' };
                        return (
                          <tr key={doc.id} style={{ borderBottom:`1px solid #f3f4f6` }}>
                            <td style={{ padding:'10px 14px' }}>
                              <span
                                onClick={() => viewUrl && window.open(viewUrl, '_blank', 'noopener,noreferrer')}
                                style={{ fontSize:13, fontWeight:500, color: viewUrl ? P : '#111827', cursor: viewUrl ? 'pointer' : 'default', textDecoration: viewUrl ? 'underline' : 'none' }}
                              >
                                {doc.document_name || doc.name || '—'}
                              </span>
                            </td>
                            <td style={{ padding:'10px 14px', fontSize:12, color:'#6b7280' }}>{doc.document_type || doc.type || '—'}</td>
                            <td style={{ padding:'10px 14px', fontSize:11, color:'#6b7280' }}>{doc.drive_url ? 'Drive' : doc.file_url ? 'Upload' : '—'}</td>
                            <td style={{ padding:'10px 14px', fontSize:12, color:'#6b7280' }}>{(doc.uploaded_at || doc.created_at || '').slice(0,10) || '—'}</td>
                            <td style={{ padding:'10px 14px', fontSize:12, color:'#6b7280' }}>{doc.expiry_date ? doc.expiry_date.slice(0,10) : '—'}</td>
                            <td style={{ padding:'10px 14px' }}>
                              <span style={{ fontSize:11, fontWeight:600, padding:'2px 8px', borderRadius:20, background: STATUS_B[status] || '#f3f4f6', color: STATUS_C[status] || '#6b7280' }}>
                                {(status.charAt(0).toUpperCase() + status.slice(1))}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        )}

        {/* ASSETS */}
        {activeTab === 'Assets' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <div style={{ fontSize:13, fontWeight:700, color:P }}>
                Allocated Assets
                {assetRecords.length > 0 && <span style={{ marginLeft:8, fontWeight:400, color:'#6b7280' }}>({assetRecords.length} items)</span>}
              </div>
            </div>
            {assetLoading ? (
              <div style={{ padding:24, textAlign:'center', color:'#9ca3af' }}>Loading assets…</div>
            ) : assetRecords.length === 0 ? (
              <div style={{ padding:24, textAlign:'center', color:'#9ca3af', background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12 }}>
                No assets allocated to this employee.
              </div>
            ) : (
              <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead>
                    <tr style={{ background:'#f5f3ff', borderBottom:`2px solid ${BORDER}` }}>
                      {['Asset','Type','Tag / Serial','Allocated On','Condition','Status'].map(h => (
                        <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontWeight:700, color:P, fontSize:12 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {assetRecords.map((a, i) => {
                      const statusColor = a.status === 'returned' ? '#6b7280' : a.status === 'allocated' ? '#16a34a' : '#d97706';
                      return (
                        <tr key={a.id} style={{ borderBottom:`1px solid #f0ebff`, background: i%2===0?'#fff':'#faf9ff' }}>
                          <td style={{ padding:'10px 14px', fontWeight:600, color:'#1f2937' }}>
                            {a.asset_name}
                            {a.brand && <div style={{ fontSize:11, color:'#9ca3af' }}>{a.brand}{a.model ? ` · ${a.model}` : ''}</div>}
                          </td>
                          <td style={{ padding:'10px 14px', color:'#374151' }}>{a.asset_type}</td>
                          <td style={{ padding:'10px 14px', fontFamily:'monospace', fontSize:12, color:'#6b7280' }}>
                            {a.asset_tag || '—'}{a.serial_number ? ` / ${a.serial_number}` : ''}
                          </td>
                          <td style={{ padding:'10px 14px', color:'#6b7280' }}>{a.allocated_date?.slice(0,10) || '—'}</td>
                          <td style={{ padding:'10px 14px', color:'#374151' }}>{a.condition_in || '—'}</td>
                          <td style={{ padding:'10px 14px' }}>
                            <span style={{ padding:'2px 10px', borderRadius:10, fontSize:12, fontWeight:600, background:statusColor+'20', color:statusColor }}>
                              {a.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ONBOARDING CHECKLIST */}
        {activeTab === 'Onboarding' && (
          <div>
            {onboardingLoading ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Loading onboarding checklist…</div>
            ) : !onboardingData?.items?.length ? (
              <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 32, textAlign: 'center' }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
                <div style={{ fontWeight: 700, color: '#374151', marginBottom: 6 }}>No onboarding checklist yet</div>
                <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>Initialize to create a checklist from default templates</div>
                <button
                  onClick={async () => {
                    try {
                      await api.post(`/onboarding/progress/${employee.id}/init`);
                      setOnboardingInit(v => !v);
                    } catch (e) { toast.error(e.response?.data?.message || 'Failed to initialize'); }
                  }}
                  style={{ padding: '9px 20px', background: P, color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  Initialize Onboarding Checklist
                </button>
              </div>
            ) : (
              <div>
                {/* Progress bar */}
                <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontWeight: 700, color: '#374151', fontSize: 14 }}>Onboarding Progress</span>
                    <span style={{ fontWeight: 800, fontSize: 18, color: P }}>{onboardingData.pct}%</span>
                  </div>
                  <div style={{ background: '#f3f4f6', borderRadius: 8, height: 10 }}>
                    <div style={{ width: `${onboardingData.pct}%`, background: `linear-gradient(90deg, ${P}, #4f46e5)`, height: '100%', borderRadius: 8, transition: 'width 0.4s ease' }} />
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>{onboardingData.done} of {onboardingData.total} items completed</div>
                </div>
                {/* Items grouped by category */}
                {Object.entries(
                  onboardingData.items.reduce((acc, item) => {
                    if (!acc[item.category]) acc[item.category] = [];
                    acc[item.category].push(item);
                    return acc;
                  }, {})
                ).map(([cat, items]) => (
                  <div key={cat} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: '#374151', fontSize: 13, marginBottom: 12 }}>{cat}</div>
                    {items.map((item, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: i < items.length - 1 ? '1px solid #f3f4f6' : 'none' }}>
                        <button
                          onClick={async () => {
                            try {
                              await api.patch(`/onboarding/progress/${employee.id}/item`, {
                                category: item.category,
                                item_label: item.item_label,
                                done: !item.done,
                              });
                              setOnboardingInit(v => !v);
                            } catch { toast.error('Failed to update checklist item'); }
                          }}
                          style={{ fontSize: 20, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
                          title={item.done ? 'Mark incomplete' : 'Mark complete'}
                        >
                          {item.done ? '✅' : '⬜'}
                        </button>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, color: item.done ? '#6b7280' : '#111827', textDecoration: item.done ? 'line-through' : 'none' }}>{item.item_label}</div>
                          {item.due_date && <div style={{ fontSize: 11, color: '#9ca3af' }}>Due: {new Date(item.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })} · {item.assignee}</div>}
                        </div>
                        {item.done && item.completed_at && (
                          <span style={{ fontSize: 11, color: '#059669', whiteSpace: 'nowrap' }}>✓ {new Date(item.completed_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* HISTORY */}
        {activeTab === 'History' && (
          <div style={{ maxWidth: 700 }}>
            <Card title="Salary Revision History">
              {salaryLoading ? (
                <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>Loading salary history…</div>
              ) : salaryRevisions.length === 0 ? (
                <div style={{ padding: '24px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                  No salary revisions on record yet.
                </div>
              ) : (
                <>
                  {/* Bar chart */}
                  {(() => {
                    const maxSalary = Math.max(...salaryRevisions.map(r => Number(r.basic_salary) || 0), 1);
                    return (
                      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 160, padding: '20px 0 0', marginBottom: 20 }}>
                        {salaryRevisions.slice().reverse().map((r, i) => {
                          const val = Number(r.basic_salary) || 0;
                          const barH = Math.max(8, Math.round((val / maxSalary) * 120));
                          const label = val >= 100000
                            ? `₹${(val / 100000).toFixed(1)}L`
                            : val >= 1000
                            ? `₹${(val / 1000).toFixed(0)}k`
                            : `₹${val}`;
                          const month = r.effective_from ? new Date(r.effective_from).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) : `Rev ${i + 1}`;
                          return (
                            <div key={r.id || i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>{label}</span>
                              <div style={{ width: '100%', borderRadius: '5px 5px 0 0', height: `${barH}px`, background: `linear-gradient(180deg, ${P}, #4f46e5)` }} />
                              <span style={{ fontSize: 10, color: '#6b7280', textAlign: 'center' }}>{month}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  {/* Detail table */}
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                        {['Effective From', 'Structure', 'Basic Salary', 'Special Allowance', 'Loan Deduction'].map(h => (
                          <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {salaryRevisions.map((r, i) => (
                        <tr key={r.id || i} style={{ borderBottom: `1px solid #f3f4f6` }}>
                          <td style={{ padding: '9px 10px', color: '#374151' }}>{r.effective_from ? new Date(r.effective_from).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                          <td style={{ padding: '9px 10px', color: '#6b7280' }}>{r.structure_name || '—'}</td>
                          <td style={{ padding: '9px 10px', fontWeight: 600, color: '#111827' }}>{r.basic_salary != null ? `₹${Number(r.basic_salary).toLocaleString('en-IN')}` : '—'}</td>
                          <td style={{ padding: '9px 10px', color: '#6b7280' }}>{r.special_allowance != null ? `₹${Number(r.special_allowance).toLocaleString('en-IN')}` : '—'}</td>
                          <td style={{ padding: '9px 10px', color: '#6b7280' }}>{r.loan_deduction != null ? `₹${Number(r.loan_deduction).toLocaleString('en-IN')}` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </Card>
          </div>
        )}

        {/* EXIT DETAILS — visible only for ex-employees */}
        {activeTab === 'Exit Details' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 16 }}>

            {/* Separation summary */}
            <Card title="Separation Summary">
              <InfoRow label="Separation Type"  value={exitData?.separation_type?.replace(/_/g,' ') || employee.exit_reason || '—'} />
              <InfoRow label="Last Working Date" value={exitData?.last_working_date ? new Date(exitData.last_working_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : (employee.exit_date ? new Date(employee.exit_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—')} />
              <InfoRow label="Notice Period"     value={exitData?.notice_period ? `${exitData.notice_period} days` : '—'} />
              <InfoRow label="Reason"            value={exitData?.reason || employee.exit_reason || '—'} />
              <InfoRow label="Exit Request Status" value={exitData?.status || '—'} />
              <InfoRow label="Initiated On"      value={exitData?.created_at ? new Date(exitData.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button onClick={openExitEdit} style={{
                  padding: '6px 14px', background: P, color: '#fff', border: 'none',
                  borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}>
                  Edit Exit Details
                </button>
              </div>
            </Card>

            {/* F&F Settlement */}
            <Card title="Full & Final Settlement">
              <InfoRow label="F&F Status"  value={exitData?.fnf_status || 'Pending'} />
              <InfoRow label="Net Payable" value={exitData?.net_payable != null ? `₹${Number(exitData.net_payable).toLocaleString('en-IN')}` : '—'} />
              <InfoRow label="Interview Done" value={exitData?.interview_done ? 'Yes' : 'No'} />
            </Card>

            {/* Clearance checklist */}
            <Card title="Exit Clearance">
              {(() => {
                const CLEARANCE_FIELDS = [
                  ['IT Assets Returned',    'it_assets_returned'],
                  ['System Access Revoked', 'access_revoked'],
                  ['Documents Collected',   'documents_collected'],
                  ['Exit Interview Done',   'exit_interview_done'],
                  ['NOC — IT',             'noc_it'],
                  ['NOC — Admin',          'noc_admin'],
                  ['NOC — Finance',        'noc_finance'],
                  ['NOC — HR',             'noc_hr'],
                  ['NOC — Manager',        'noc_manager'],
                ];
                const data = clearanceData || {};
                const toggleClearance = async (field, currentVal) => {
                  if (clearanceSaving) return;
                  setClearanceSaving(true);
                  const updated = { ...data, [field]: !currentVal };
                  try {
                    const r = await api.put(`/exit/clearance/${employee.id}`, updated);
                    if (isMounted.current) setClearanceData(r.data);
                  } catch { toast.error('Failed to update clearance'); }
                  finally { if (isMounted.current) setClearanceSaving(false); }
                };
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                    {CLEARANCE_FIELDS.map(([label, field]) => {
                      const done = data[field];
                      return (
                        <div key={field} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${BORDER}` }}>
                          <span style={{ fontSize: 13, color: '#374151' }}>{label}</span>
                          <button
                            onClick={() => toggleClearance(field, done)}
                            disabled={clearanceSaving}
                            style={{
                              fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
                              background: done ? '#dcfce7' : '#fef9c3',
                              color: done ? '#166534' : '#92400e',
                              border: `1px solid ${done ? '#bbf7d0' : '#fde68a'}`,
                              opacity: clearanceSaving ? 0.6 : 1,
                            }}
                          >
                            {done ? '✓ Done' : 'Pending'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </Card>

          </div>
        )}

        {/* NOTES */}
        {activeTab === 'Notes' && (
          <div style={{ maxWidth:720, display:'flex', flexDirection:'column', gap:16 }}>
            <Card title="Add HR Note">
              <textarea
                value={notesText}
                onChange={e => setNotesText(e.target.value)}
                placeholder="Write an HR note about this employee…"
                style={{
                  width:'100%', minHeight:100, border:`1px solid ${BORDER}`, borderRadius:8,
                  padding:12, fontSize:14, fontFamily:'inherit', resize:'vertical',
                  outline:'none', boxSizing:'border-box', marginTop:8,
                }}
              />
              <button
                onClick={saveNote}
                style={{
                  alignSelf:'flex-start', marginTop:10,
                  padding:'8px 20px', background:P, color:'#fff',
                  border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer',
                }}
              >
                Save Note
              </button>
            </Card>

            {notesList.length > 0 && (
              <Card title="Notes History">
                {notesList.map(note => (
                  <div key={note.id} style={{
                    padding:'12px 0', borderBottom:`1px solid ${BORDER}`,
                  }}>
                    <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, marginBottom:4 }}>
                      {new Date(note.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </div>
                    <div style={{ fontSize:14, color:'#374151', lineHeight:1.6 }}>{note.note_text}</div>
                  </div>
                ))}
              </Card>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

/* Inject responsive tab/content overrides once */
if (typeof document !== 'undefined' && !document.getElementById('emp-profile-style')) {
  const _s = document.createElement('style');
  _s.id = 'emp-profile-style';
  _s.textContent = `
    @media (max-width: 768px) {
      .emp-profile-tabs {
        padding-left: 0 !important;
        padding-right: 0 !important;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .emp-profile-tabs::-webkit-scrollbar { display: none; }
      .emp-profile-content { padding: 16px 12px 32px !important; }
      .emp-profile-header-inner { flex-direction: column !important; align-items: flex-start !important; }
      .emp-profile-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .emp-profile-table-wrap table { min-width: 480px; }
    }
    @media (max-width: 480px) {
      .emp-profile-tabs button { padding: 10px 12px !important; font-size: 12px !important; }
    }
  `;
  document.head.appendChild(_s);
}
