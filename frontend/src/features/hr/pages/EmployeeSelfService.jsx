// frontend/src/features/hr/pages/EmployeeSelfService.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import FaceClockModal, { getLocationString } from '@/components/attendance/FaceClockModal';

/* ─── helpers ─────────────────────────────────────────────────── */
function fmtINR(n) {
  const v = Math.abs(parseFloat(n) || 0);
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}
function getCurrentFY() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}
const FY = getCurrentFY();
const LIMIT_80C = 150000;

const DOC_TYPES = ['Aadhaar Card','PAN Card','Passport','Offer Letter','Degree Certificate','Experience Letter','Bank Passbook','Salary Certificate','Other'];
const CLAIM_TYPES = ['medical','fuel','internet','mobile','travel','other'];
const STATUS_COLORS = { draft:'#6b7280', submitted:'#d97706', approved:'#16a34a', rejected:'#dc2626', paid:'#6B3FDB' };
const EMPTY_DASHBOARD = {
  leave_balance: 0,
  pending_reimbursements: 0,
  ytd_tax_deducted: 0,
  document_count: 0,
  pending_it_declarations: 0,
  expiring_docs: 0,
};

function tabStyle(active) {
  return { padding: '8px 20px', border: 'none', cursor: 'pointer', borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14, background: active ? '#6B3FDB' : '#e9e4ff', color: active ? '#fff' : '#6B3FDB' };
}

export default function EmployeeSelfService() {
  const { user } = useAuth();
  const EMPLOYEE_ID = user?.employee_id || null;
  const [tab, setTab]             = useState('dashboard');
  const [dashboard, setDashboard] = useState(EMPTY_DASHBOARD);
  const [declarations, setDecl]   = useState([]);
  const [documents, setDocs]      = useState([]);
  const [claims, setClaims]       = useState([]);
  const [profile, setProfile]     = useState({ address: '', emergency_contact: '', blood_group: '', bank_account: '', ifsc_code: '', bank_name: '', account_type: 'savings' });
  const [msg, setMsg]             = useState({ text:'', type:'' });
  const [loading, setLoading]     = useState(false);

  // Live data for dashboard tab
  const [empProfile, setEmpProfile]           = useState(null);
  const [holidays, setHolidays]               = useState([]);
  const [announcements, setAnnouncements]     = useState([]);
  const [todayTasks, setTodayTasks]           = useState([]);
  const [attendanceToday, setAttendanceToday] = useState(null);
  const [clockLoading, setClockLoading]       = useState(false);
  const [faceOpen, setFaceOpen]               = useState(false);

  // IT Declaration form
  const [declForm, setDeclForm]   = useState({ declaration_type:'80C', amount:'', description:'', proof_url:'' });
  const [showDeclForm, setShowDeclForm] = useState(false);

  // Document form
  const [showDocForm, setShowDocForm] = useState(false);
  const [docForm, setDocForm]     = useState({ document_type:'', document_name:'', file_url:'' });

  // Reimbursement form
  const [showClaimForm, setShowClaimForm] = useState(false);
  const [claimForm, setClaimForm] = useState({ claim_type:'medical', amount:'', description:'', claim_date: new Date().toISOString().split('T')[0], receipt_url:'' });

  // Profile edit
  const [editProfile, setEditProfile] = useState(false);
  const [bankConfirmModal, setBankConfirm] = useState(false);
  const [tempProfile, setTempProfile] = useState({ ...profile });

  const flash = (text, type = 'success') => { setMsg({ text, type }); setTimeout(() => setMsg({ text:'', type:'' }), 3500); };

  const load = useCallback(async () => {
    if (!EMPLOYEE_ID) return;
    const [dRes, decRes, docRes, clRes, empRes, holRes, annRes, taskRes, attRes] = await Promise.allSettled([
      api.get(`/self-service/dashboard?employee_id=${EMPLOYEE_ID}`),
      api.get(`/self-service/it-declarations?employee_id=${EMPLOYEE_ID}&financial_year=${FY}`),
      api.get(`/self-service/documents?employee_id=${EMPLOYEE_ID}`),
      api.get(`/self-service/reimbursements?employee_id=${EMPLOYEE_ID}`),
      api.get(`/employees/${EMPLOYEE_ID}`),
      api.get('/holidays'),
      api.get('/announcements/active'),
      api.get('/tasks/today'),
      api.get(`/attendance/today/${EMPLOYEE_ID}`),
    ]);
    if (dRes.status === 'fulfilled') setDashboard({ ...EMPTY_DASHBOARD, ...(dRes.value.data || {}) });
    if (decRes.status === 'fulfilled') setDecl(Array.isArray(decRes.value.data) ? decRes.value.data : []);
    if (docRes.status === 'fulfilled') setDocs(Array.isArray(docRes.value.data) ? docRes.value.data : []);
    if (clRes.status === 'fulfilled') setClaims(Array.isArray(clRes.value.data) ? clRes.value.data : []);
    if (empRes.status === 'fulfilled') {
      const raw = empRes.value.data?.employee || empRes.value.data;
      if (raw && typeof raw === 'object') {
        setEmpProfile(raw);
        setProfile(p => ({
          address:           raw.address            || p.address,
          emergency_contact: raw.emergency_contact  || p.emergency_contact,
          blood_group:       raw.blood_group        || p.blood_group,
          bank_account:      raw.bank_account       || p.bank_account,
          ifsc_code:         raw.ifsc_code          || p.ifsc_code,
          bank_name:         raw.bank_name          || p.bank_name,
          account_type:      raw.account_type       || p.account_type || 'savings',
        }));
      }
    }
    if (holRes.status === 'fulfilled') {
      const raw = holRes.value.data;
      setHolidays(Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []));
    }
    if (annRes.status === 'fulfilled') {
      const raw = annRes.value.data;
      setAnnouncements(Array.isArray(raw) ? raw : []);
    }
    if (taskRes.status === 'fulfilled') {
      const raw = taskRes.value?.data;
      const arr = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);
      setTodayTasks(arr);
    }
    if (attRes.status === 'fulfilled' && attRes.value?.data) {
      const data = attRes.value.data;
      const rec = Array.isArray(data)
        ? (data.find(r => r.employee_id === EMPLOYEE_ID || r.user_id === EMPLOYEE_ID) ?? data[0] ?? null)
        : data;
      setAttendanceToday(rec ?? null);
    }
  }, [EMPLOYEE_ID]);
  useEffect(() => { load(); }, [load]);

  // computed IT summary
  const total80C = declarations.filter(d => d.declaration_type === '80C' && d.status !== 'rejected').reduce((s, d) => s + parseFloat(d.amount), 0);
  const _total80D = declarations.filter(d => d.declaration_type === '80D' && d.status !== 'rejected').reduce((s, d) => s + parseFloat(d.amount), 0);
  const remaining80C = Math.max(0, LIMIT_80C - total80C);

  // clock-in / clock-out
  const handleClock = async (faceData = null) => {
    if (clockLoading) return;
    if (!EMPLOYEE_ID) {
      flash('Your login is not linked to an employee record — ask HR to link your account to an employee profile.', 'error');
      return;
    }
    setClockLoading(true);
    try {
      const now = new Date().toTimeString().slice(0, 5);
      const isIn = !attendanceToday?.check_in;
      // Location is server-enforced for clock-in when a mandatory geo-fence exists
      const location = isIn ? await getLocationString() : null;
      const { data } = await api.post('/attendance/clock', {
        employee_id: EMPLOYEE_ID,
        action: isIn ? 'in' : 'out',
        time: now,
        ...(location ? { location } : {}),
        ...(faceData?.face_token ? { face_token: faceData.face_token } : {}),
      });
      setAttendanceToday(data);
      flash(isIn ? 'Clocked in successfully' : 'Clocked out successfully');
    } catch (err) {
      flash(err.response?.data?.message || err.response?.data?.error || 'Failed to record attendance', 'error');
    } finally {
      setClockLoading(false);
    }
  };

  const [pendingDeleteDocId, setPendingDeleteDocId] = useState(null);

  const submitDeclaration = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/self-service/it-declarations', { ...declForm, employee_id: EMPLOYEE_ID, financial_year: FY });
      flash('Declaration submitted'); setShowDeclForm(false);
      setDeclForm({ declaration_type:'80C', amount:'', description:'', proof_url:'' }); load();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
    finally { setLoading(false); }
  };

  const uploadDocument = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/self-service/documents', { ...docForm, employee_id: EMPLOYEE_ID });
      flash('Document uploaded'); setShowDocForm(false); setDocForm({ document_type:'', document_name:'', file_url:'' }); load();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
    finally { setLoading(false); }
  };

  const deleteDoc = async (id) => {
    setLoading(true);
    try {
      await api.delete(`/self-service/documents/${id}`);
      flash('Deleted'); load();
    } catch (err) { flash(err.response?.data?.message || 'Cannot delete verified document', 'error'); }
    finally { setLoading(false); setPendingDeleteDocId(null); }
  };

  const submitClaim = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/self-service/reimbursements', { ...claimForm, employee_id: EMPLOYEE_ID });
      flash('Claim submitted'); setShowClaimForm(false); setClaimForm({ claim_type:'medical', amount:'', description:'', claim_date: new Date().toISOString().split('T')[0], receipt_url:'' }); load();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
    finally { setLoading(false); }
  };

  const saveProfile = async () => {
    setLoading(true);
    try {
      const r = await api.put(`/self-service/employees/${EMPLOYEE_ID}/profile`, tempProfile);
      setProfile({ ...tempProfile, bank_account: r.data?.masked_bank || tempProfile.bank_account });
      setEditProfile(false); setBankConfirm(false); flash('Profile updated');
    } catch (err) { flash(err.response?.data?.message || 'Update failed', 'error'); }
    finally { setLoading(false); }
  };

  // Computed display values from real employee data
  const empName = empProfile
    ? (`${empProfile.first_name || ''} ${empProfile.last_name || ''}`.trim() || empProfile.name || '')
    : (user?.name || `${user?.first_name || ''} ${user?.last_name || ''}`.trim() || 'Employee');
  const empId       = empProfile?.employee_id || user?.employee_id || EMPLOYEE_ID || '—';
  const empDesig    = empProfile?.designation  || empProfile?.job_title   || '—';
  const empDept     = empProfile?.department   || '—';
  const empLocation = empProfile?.location     || empProfile?.branch_name || '—';

  // Upcoming holidays — only future dates, sorted ascending
  const todayISO = new Date().toISOString().split('T')[0];
  const upcomingHolidays = holidays
    .filter(h => (h.date || '') >= todayISO)
    .slice(0, 5);

  // Clock state helpers
  const clockedIn  = !!(attendanceToday?.check_in && !attendanceToday?.check_out);
  const clockedOut = !!(attendanceToday?.check_in && attendanceToday?.check_out);
  const pendingTasks = todayTasks.filter(t => t.status !== 'done' && t.status !== 'completed').length;

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>🧑‍💼 Employee Self-Service</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Manage your declarations, documents, claims and personal information</p>
      </div>

      {msg.text && <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>}

      {/* Delete document confirmation */}
      {pendingDeleteDocId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, maxWidth: 360, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Delete Document?</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>This cannot be undone.</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setPendingDeleteDocId(null)} style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={() => deleteDoc(pendingDeleteDocId)} disabled={loading} style={{ padding: '8px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {loading ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }}>
        {[['dashboard','Dashboard'],['it_decl','IT Declaration'],['documents','Document Vault'],['reimb','Reimbursements'],['profile','Profile Update']].map(([k,l]) => (
          <button key={k} style={tabStyle(tab===k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: 20 }}>

        {/* ── DASHBOARD ── */}
        {tab === 'dashboard' && (
          <div>
            {/* welcome card with real user data */}
            <div style={{ display: 'flex', gap: 20, marginBottom: 16, alignItems: 'center', background: 'linear-gradient(135deg,#6B3FDB,#4c1d95)', borderRadius: 12, padding: 20, color: '#fff', flexWrap: 'wrap' }}>
              <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, flexShrink: 0 }}>👤</div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>Welcome, {empName}</div>
                <div style={{ fontSize: 13, opacity: 0.8, marginTop: 2 }}>
                  {empId}{empDesig !== '—' ? ` · ${empDesig}` : ''}{empDept !== '—' ? ` · ${empDept}` : ''}
                </div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                  {empLocation !== '—' ? `${empLocation} · ` : ''}{FY} Financial Year
                </div>
              </div>
            </div>

            {/* clock-in / clock-out banner */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: 10, border: '1px solid #e9e4ff', background: clockedOut ? '#f0fdf4' : clockedIn ? '#eff6ff' : '#fef9c3', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
              <div>
                <div style={{ fontWeight: 600, color: '#1f2937', fontSize: 13 }}>
                  {clockedOut
                    ? `✅ Clocked out at ${attendanceToday.check_out}`
                    : clockedIn
                      ? `🟢 Clocked in at ${attendanceToday.check_in}`
                      : '⏰ Not clocked in today'}
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  {new Date().toLocaleTimeString('en-IN')}
                </div>
              </div>
              {!clockedOut && (
                <button onClick={() => (clockedIn || !EMPLOYEE_ID ? handleClock() : setFaceOpen(true))} disabled={clockLoading}
                  style={{ padding: '8px 18px', borderRadius: 8, border: 'none', cursor: clockLoading ? 'default' : 'pointer', fontWeight: 600, fontSize: 13, background: clockedIn ? '#ef4444' : '#16a34a', color: '#fff' }}>
                  {clockLoading ? 'Recording…' : clockedIn ? '🔴 Clock Out' : '📷 Clock In'}
                </button>
              )}
            </div>

            {/* face-verified clock-in */}
            {faceOpen && EMPLOYEE_ID && (
              <FaceClockModal
                employeeId={EMPLOYEE_ID}
                action="in"
                onVerified={(fd) => { setFaceOpen(false); handleClock(fd); }}
                onClose={() => setFaceOpen(false)}
              />
            )}

            {/* quick stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 24 }}>
              {[
                { label:'Leave Balance',   value:`${dashboard.leave_balance} days`,            icon:'🏖️', color:'#2563eb', tab:'dashboard' },
                { label:'Pending Claims',  value:`${dashboard.pending_reimbursements}`,        icon:'📋', color:'#d97706', tab:'reimb' },
                { label:'YTD Tax Paid',    value:fmtINR(dashboard.ytd_tax_deducted),           icon:'🏛️', color:'#dc2626', tab:'it_decl' },
                { label:'Documents',       value:`${dashboard.document_count}`,                icon:'📄', color:'#6B3FDB', tab:'documents' },
                { label:'Pending Tasks',   value:`${pendingTasks}`,                            icon:'✅', color:'#16a34a', tab:'dashboard' },
                { label:'Docs Expiring',   value:`${dashboard.expiring_docs}`,                 icon:'⚠️', color: dashboard.expiring_docs > 0 ? '#dc2626' : '#6b7280', tab:'documents' },
              ].map(s => (
                <div key={s.label} onClick={() => setTab(s.tab)} style={{ background: s.label === 'Docs Expiring' && dashboard.expiring_docs > 0 ? '#fef2f2' : '#f5f3ff', border: `1px solid ${s.label === 'Docs Expiring' && dashboard.expiring_docs > 0 ? '#fecaca' : '#e9e4ff'}`, borderRadius: 10, padding: '14px 16px', cursor: 'pointer' }}>
                  <div style={{ fontSize: 22 }}>{s.icon}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: s.color, marginTop: 4 }}>{s.value}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* quick actions */}
            <h4 style={{ color: '#4c1d95', margin: '0 0 12px' }}>Quick Actions</h4>
            <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
              {[
                { label:'Apply Leave',      icon:'🏖️', color:'#2563eb', action: () => setTab('leaves') },
                { label:'Submit Expense',   icon:'💸', color:'#d97706', action: () => setTab('reimb') },
                { label:'IT Declaration',   icon:'📝', color:'#dc2626', action: () => setTab('it_decl') },
                { label:'Upload Document',  icon:'📄', color:'#6B3FDB', action: () => setTab('documents') },
                { label:'Update Profile',   icon:'✏️', color:'#16a34a', action: () => setTab('profile') },
              ].map(q => (
                <button key={q.label} onClick={q.action}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 8, border: `1px solid ${q.color}30`, background: q.color + '10', color: q.color, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  {q.icon} {q.label}
                </button>
              ))}
            </div>

            {/* two-column: announcements + tasks */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 20, marginBottom: 24 }}>

              {/* announcements */}
              <div>
                <h4 style={{ color: '#4c1d95', margin: '0 0 12px' }}>📢 Company Announcements</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {announcements.length === 0 ? (
                    <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>No announcements</div>
                  ) : announcements.slice(0, 3).map((ann, i) => (
                    <div key={ann.id || i} style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #6366f130', background: '#6366f108' }}>
                      <div style={{ fontWeight: 600, color: '#1f2937', fontSize: 13 }}>{ann.title}</div>
                      {ann.description && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{ann.description}</div>}
                      {ann.date && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{ann.date}</div>}
                    </div>
                  ))}
                </div>
              </div>

              {/* today's tasks */}
              <div>
                <h4 style={{ color: '#4c1d95', margin: '0 0 12px' }}>✅ Today's Tasks</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {todayTasks.length === 0 ? (
                    <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>No tasks due today</div>
                  ) : todayTasks.slice(0, 5).map((task, i) => {
                    const done = task.status === 'done' || task.status === 'completed';
                    const pColor = task.priority === 'high' ? '#ef4444' : task.priority === 'low' ? '#6b7280' : '#f59e0b';
                    return (
                      <div key={task.id || i} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#f5f3ff' }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: pColor, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 500, color: done ? '#9ca3af' : '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: done ? 'line-through' : 'none' }}>
                            {task.title || task.name}
                          </div>
                          {task.project_name && <div style={{ fontSize: 11, color: '#9ca3af' }}>{task.project_name}</div>}
                        </div>
                        {done && <span style={{ fontSize: 14 }}>✅</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* upcoming holidays — live from DB, future dates only */}
            <h4 style={{ color: '#4c1d95', margin: '0 0 12px' }}>🗓️ Upcoming Holidays</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {upcomingHolidays.length === 0 ? (
                <div style={{ color: '#9ca3af', fontSize: 13, padding: '8px 0' }}>No upcoming holidays</div>
              ) : upcomingHolidays.map((h, i) => {
                const daysLeft = Math.ceil((new Date(h.date) - new Date()) / 86400000);
                return (
                  <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '10px 14px', borderRadius: 8, border: '1px solid #d9770630', background: '#d9770610' }}>
                    <span style={{ fontSize: 20 }}>🏖️</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, color: '#1f2937', fontSize: 13 }}>{h.name}</div>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>{h.date}{h.day ? ` · ${h.day}` : ''}</div>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#d97706' }}>
                      {daysLeft === 0 ? 'Today' : `In ${daysLeft} days`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── IT DECLARATION ── */}
        {tab === 'it_decl' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: '#4c1d95' }}>IT Declarations — FY {FY}</h3>
              <button onClick={() => setShowDeclForm(f => !f)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                {showDeclForm ? '✕ Cancel' : '+ Add Declaration'}
              </button>
            </div>

            {/* progress bar for 80C */}
            <div style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 20, border: '1px solid #e9e4ff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontWeight: 700, color: '#4c1d95' }}>Section 80C Limit</span>
                <span style={{ fontSize: 13, color: '#6b7280' }}>{fmtINR(total80C)} / {fmtINR(LIMIT_80C)}</span>
              </div>
              <div style={{ height: 10, background: '#e9e4ff', borderRadius: 5 }}>
                <div style={{ height: '100%', width: `${Math.min(100, (total80C / LIMIT_80C) * 100)}%`, background: total80C >= LIMIT_80C ? '#16a34a' : '#6B3FDB', borderRadius: 5, transition: 'width 0.5s' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12 }}>
                <span style={{ color: '#6b7280' }}>Remaining: <strong style={{ color: remaining80C > 0 ? '#d97706' : '#16a34a' }}>{fmtINR(remaining80C)}</strong></span>
                <span style={{ color: '#6b7280' }}>Est. tax saving: <strong style={{ color: '#16a34a' }}>{fmtINR(Math.min(total80C, LIMIT_80C) * 0.3)}</strong></span>
              </div>
            </div>

            {/* add declaration form */}
            {showDeclForm && (
              <form onSubmit={submitDeclaration} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Declaration Type</label>
                    <select value={declForm.declaration_type} onChange={e => setDeclForm(f => ({ ...f, declaration_type: e.target.value }))}
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                      {['80C','80D','HRA','LTA','other'].map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Amount (₹) *</label>
                    <input type="number" required value={declForm.amount} onChange={e => setDeclForm(f => ({ ...f, amount: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Description *</label>
                    <input required value={declForm.description} onChange={e => setDeclForm(f => ({ ...f, description: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Proof URL (optional)</label>
                    <input value={declForm.proof_url} onChange={e => setDeclForm(f => ({ ...f, proof_url: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                </div>
                <button type="submit" disabled={loading} style={{ marginTop: 14, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                  {loading ? 'Submitting…' : 'Submit for Approval'}
                </button>
              </form>
            )}

            {/* declarations table grouped by type */}
            {['80C','80D','HRA','LTA','other'].map(type => {
              const items = declarations.filter(d => d.declaration_type === type);
              if (!items.length) return null;
              return (
                <div key={type} style={{ marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14, marginBottom: 8 }}>Section {type}</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead><tr style={{ background: '#f5f3ff' }}>
                      {['Description','Amount','Proof','Status'].map(h => <th key={h} style={{ padding: '7px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                      {items.map(d => (
                        <tr key={d.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                          <td style={{ padding: '7px 12px' }}>{d.description}</td>
                          <td style={{ padding: '7px 12px', fontWeight: 600 }}>{fmtINR(d.amount)}</td>
                          <td style={{ padding: '7px 12px' }}>{d.proof_url ? <a href={d.proof_url} target="_blank" rel="noreferrer" style={{ color: '#6B3FDB', fontSize: 12 }}>View</a> : <span style={{ color: '#9ca3af', fontSize: 12 }}>Not uploaded</span>}</td>
                          <td style={{ padding: '7px 12px' }}>
                            <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: STATUS_COLORS[d.status] + '20', color: STATUS_COLORS[d.status] }}>{d.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}

        {/* ── DOCUMENT VAULT ── */}
        {tab === 'documents' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: '#4c1d95' }}>Document Vault</h3>
              <button onClick={() => setShowDocForm(f => !f)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                {showDocForm ? '✕ Cancel' : '+ Upload Document'}
              </button>
            </div>

            {showDocForm && (
              <form onSubmit={uploadDocument} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Document Type *</label>
                    <select required value={docForm.document_type} onChange={e => setDocForm(f => ({ ...f, document_type: e.target.value }))}
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                      <option value="">Select type</option>
                      {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Document Name *</label>
                    <input required value={docForm.document_name} onChange={e => setDocForm(f => ({ ...f, document_name: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>File URL</label>
                    <input value={docForm.file_url} onChange={e => setDocForm(f => ({ ...f, file_url: e.target.value }))}
                      placeholder="https://..."
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                </div>
                <button type="submit" disabled={loading} style={{ marginTop: 14, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                  {loading ? 'Uploading…' : 'Upload'}
                </button>
              </form>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 14 }}>
              {documents.map(doc => {
                const todayISO2 = new Date().toISOString().split('T')[0];
                const daysToExpiry = doc.expiry_date
                  ? Math.ceil((new Date(doc.expiry_date) - new Date(todayISO2)) / 86400000)
                  : null;
                const isExpired  = daysToExpiry !== null && daysToExpiry < 0;
                const isExpiring = daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= 30;
                const borderColor = isExpired ? '#fecaca' : isExpiring ? '#fed7aa' : doc.verified ? '#bbf7d0' : '#e9e4ff';
                return (
                <div key={doc.id} style={{ background: '#f5f3ff', border: `1px solid ${borderColor}`, borderRadius: 12, padding: 16 }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>📄</div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: '#1f2937', marginBottom: 4 }}>{doc.document_type}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.document_name}</div>
                  {doc.expiry_date && (
                    <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: isExpired ? '#dc2626' : isExpiring ? '#d97706' : '#6b7280' }}>
                      {isExpired ? `⚠ Expired ${Math.abs(daysToExpiry)}d ago` : isExpiring ? `⚠ Expires in ${daysToExpiry}d` : `Expires: ${doc.expiry_date}`}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 10 }}>Uploaded: {doc.uploaded_at?.split('T')[0]}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: doc.verified ? '#d1fae5' : '#fef3c7', color: doc.verified ? '#16a34a' : '#d97706' }}>
                      {doc.verified ? '✓ Verified' : '⏳ Pending'}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {doc.file_url && <a href={doc.file_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#6B3FDB', fontWeight: 600 }}>⬇</a>}
                      {!doc.verified && <button onClick={() => setPendingDeleteDocId(doc.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 14 }}>🗑</button>}
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── REIMBURSEMENTS ── */}
        {tab === 'reimb' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: '#4c1d95' }}>Reimbursement Claims</h3>
              <button onClick={() => setShowClaimForm(f => !f)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                {showClaimForm ? '✕ Cancel' : '+ New Claim'}
              </button>
            </div>

            {showClaimForm && (
              <form onSubmit={submitClaim} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Claim Type</label>
                    <select value={claimForm.claim_type} onChange={e => setClaimForm(f => ({ ...f, claim_type: e.target.value }))}
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                      {CLAIM_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Amount (₹) *</label>
                    <input type="number" required value={claimForm.amount} onChange={e => setClaimForm(f => ({ ...f, amount: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Date</label>
                    <input type="date" value={claimForm.claim_date} onChange={e => setClaimForm(f => ({ ...f, claim_date: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Receipt URL</label>
                    <input value={claimForm.receipt_url} onChange={e => setClaimForm(f => ({ ...f, receipt_url: e.target.value }))} placeholder="https://..."
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  <div style={{ gridColumn: '1/-1' }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Description</label>
                    <input required value={claimForm.description} onChange={e => setClaimForm(f => ({ ...f, description: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                </div>
                <button type="submit" disabled={loading} style={{ marginTop: 14, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                  {loading ? 'Submitting…' : 'Submit Claim'}
                </button>
              </form>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {claims.map(c => (
                <div key={c.id} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, border: '1px solid #e9e4ff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#1f2937', fontSize: 14 }}>{c.claim_type.charAt(0).toUpperCase() + c.claim_type.slice(1)} Reimbursement</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{c.description} · {c.claim_date}</div>
                    {c.status === 'approved' && c.approved_amount !== c.amount && (
                      <div style={{ fontSize: 12, color: '#d97706', marginTop: 4 }}>Approved amount: {fmtINR(c.approved_amount)} (claimed: {fmtINR(c.amount)})</div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontWeight: 800, fontSize: 16, color: c.status === 'paid' ? '#6B3FDB' : '#1f2937' }}>{fmtINR(c.approved_amount || c.amount)}</span>
                    <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: STATUS_COLORS[c.status] + '20', color: STATUS_COLORS[c.status] }}>{c.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── PROFILE UPDATE ── */}
        {tab === 'profile' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: '#4c1d95' }}>Update Profile</h3>
              {!editProfile && <button onClick={() => { setEditProfile(true); setTempProfile({ ...profile }); }}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                ✏️ Edit
              </button>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
              {/* personal info */}
              <div>
                <h4 style={{ color: '#4c1d95', margin: '0 0 12px', fontSize: 14, borderBottom: '1px solid #e9e4ff', paddingBottom: 8 }}>Personal Information</h4>
                {[['address','Address'],['emergency_contact','Emergency Contact']].map(([key, label]) => (
                  <div key={key} style={{ marginBottom: 14 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>{label}</label>
                    {editProfile ? (
                      <input value={tempProfile[key] || ''} onChange={e => setTempProfile(p => ({ ...p, [key]: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                    ) : (
                      <div style={{ padding: '8px 10px', background: '#f5f3ff', borderRadius: 7, fontSize: 13, color: '#374151' }}>{profile[key] || '—'}</div>
                    )}
                  </div>
                ))}
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Blood Group</label>
                  {editProfile ? (
                    <select value={tempProfile.blood_group || ''} onChange={e => setTempProfile(p => ({ ...p, blood_group: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                      <option value="">-- Select Blood Group --</option>
                      {['A+','A-','B+','B-','O+','O-','AB+','AB-'].map(bg => <option key={bg} value={bg}>{bg}</option>)}
                    </select>
                  ) : (
                    <div style={{ padding: '8px 10px', background: '#f5f3ff', borderRadius: 7, fontSize: 13, color: '#374151' }}>{profile.blood_group || '—'}</div>
                  )}
                </div>
              </div>

              {/* bank details */}
              <div>
                <h4 style={{ color: '#4c1d95', margin: '0 0 12px', fontSize: 14, borderBottom: '1px solid #e9e4ff', paddingBottom: 8 }}>
                  Bank Details
                  {!editProfile && <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 400, marginLeft: 8 }}>(Account number masked for security)</span>}
                </h4>
                {[['bank_account','Account Number'],['ifsc_code','IFSC Code'],['bank_name','Bank Name']].map(([key, label]) => (
                  <div key={key} style={{ marginBottom: 14 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>{label}</label>
                    {editProfile ? (
                      <input value={tempProfile[key] || ''} onChange={e => setTempProfile(p => ({ ...p, [key]: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                    ) : (
                      <div style={{ padding: '8px 10px', background: '#f5f3ff', borderRadius: 7, fontSize: 13, color: '#374151', fontFamily: key === 'bank_account' ? 'monospace' : 'inherit' }}>{profile[key] || '—'}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {editProfile && (
              <div style={{ display: 'flex', gap: 10, marginTop: 20, borderTop: '1px solid #e9e4ff', paddingTop: 20 }}>
                <button onClick={() => setBankConfirm(true)}
                  style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 24px', cursor: 'pointer', fontWeight: 600 }}>
                  Save Changes
                </button>
                <button onClick={() => setEditProfile(false)}
                  style={{ background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600 }}>
                  Cancel
                </button>
              </div>
            )}

            {/* bank confirmation modal */}
            {bankConfirmModal && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 360, maxWidth: '95vw' }}>
                  <h3 style={{ color: '#d97706', margin: '0 0 12px' }}>⚠️ Confirm Profile Update</h3>
                  <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>
                    You are about to update your bank details. Changes will take effect from the next payroll cycle. Please verify the information is correct.
                  </p>
                  <div style={{ background: '#fef3c7', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13 }}>
                    <div><strong>Bank:</strong> {tempProfile.bank_name}</div>
                    <div><strong>IFSC:</strong> {tempProfile.ifsc_code}</div>
                    <div><strong>Account:</strong> XXXX{String(tempProfile.bank_account || '').slice(-4)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={saveProfile} disabled={loading}
                      style={{ flex: 1, background: '#d97706', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 0', cursor: 'pointer', fontWeight: 600 }}>
                      {loading ? 'Saving…' : 'Confirm & Save'}
                    </button>
                    <button onClick={() => setBankConfirm(false)}
                      style={{ flex: 1, background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '8px 0', cursor: 'pointer', fontWeight: 600 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
