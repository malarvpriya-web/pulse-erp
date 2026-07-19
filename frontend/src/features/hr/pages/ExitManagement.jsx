// frontend/src/features/hr/pages/ExitManagement.jsx
import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { PieChart, Pie, Cell, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend } from 'recharts';


const REASON_LABELS = { better_opportunity: 'Better Opportunity', compensation: 'Compensation', work_environment: 'Work Environment', personal: 'Personal', relocation: 'Relocation', other: 'Other' };
const SEP_COLORS = { resignation: '#6B3FDB', termination: '#dc2626', retirement: '#059669', death: '#374151' };
const REASON_COLORS = ['#6B3FDB', '#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626'];

const fmt = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const tabStyle = (active) => ({ padding: '8px 20px', border: 'none', background: active ? '#6B3FDB' : 'transparent', color: active ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8, fontWeight: active ? 600 : 400, fontSize: 14 });
const cardStyle = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 };
const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', background: '#fafafa', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 16px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };

export default function ExitManagement() {
  const [tab, setTab] = useState(0);
  const [activeExits, setActiveExits] = useState([]);
  const [interviews, setInterviews] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [fnfData, setFnfData] = useState(null);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [clearanceData, setClearanceData] = useState({});
  const [showInitiate, setShowInitiate] = useState(false);
  const [showInterview, setShowInterview] = useState(null);
  const [initiateForm, setInitiateForm] = useState({ employee_id: '', separation_type: 'resignation', last_working_date: '' });
  const [interviewForm, setInterviewForm] = useState({ reason_category: 'better_opportunity', reason_detail: '', would_rejoin: 'maybe', rating_management: 4, rating_culture: 4, rating_work: 4, rating_growth: 3, overall_rating: 4, interviewer_id: null });
  const [notice, setNotice] = useState(null);
  const [actioning, setActioning] = useState(false);
  const [fnfEstimated, setFnfEstimated] = useState(false);

  const showNotice = (msg, type = 'success') => {
    setNotice({ msg, type });
    setTimeout(() => setNotice(null), 3500);
  };

  const load = useCallback(async () => {
    const [r1, r2, r3] = await Promise.allSettled([
      api.get('/exit/active'),
      api.get('/exit/interviews'),
      api.get('/exit/interviews/analytics')
    ]);
    setActiveExits(r1.status === 'fulfilled' ? (r1.value.data || []) : []);
    setInterviews(r2.status === 'fulfilled' ? (r2.value.data || []) : []);
    setAnalytics(r3.status === 'fulfilled' ? r3.value.data : null);
  }, []);

  useEffect(() => { load(); }, [load]);

  const initiateExit = async () => {
    if (actioning) return;
    setActioning(true);
    try {
      await api.post('/exit/initiate', initiateForm);
      showNotice('Exit process initiated successfully');
      setShowInitiate(false);
      load();
    } catch (_) {
      showNotice('Failed to initiate exit. Please try again.', 'error');
    } finally { setActioning(false); }
  };

  const computeFnF = async (empId) => {
    setSelectedEmployee(empId);
    setFnfData(null);
    setFnfEstimated(false);
    try {
      const res = await api.post(`/exit/fnf/compute/${empId}`);
      setFnfData(res.data);
    } catch (_) {
      setFnfEstimated(true);
      setFnfData({
        net_payable: 145200, status: 'draft',
        computation_details: {
          basic_salary: 45000, daily_basic: 1731, service_years: 4.8, service_years_complete: 4,
          notice: { period_days: 60, served_days: 30, shortfall_days: 30, recovery: 51923 },
          leave_encashment: { balance_days: 18, amount: 31154, formula: '18 days × (45000/26)' },
          gratuity: { eligible: false, amount: 0, formula: 'Not eligible (<5 years service)', max_limit: 2000000 },
          pf: { balance: 108000, withdrawal_eligible: true, tds_applicable: true, tds_amount: 10800 },
          tds: { gross_fnf: 82231, annual_equivalent: 986772, income_tax: 0, tds_on_fnf: 10800 },
          summary: { total_payable: 31154, total_recoverable: 51923, gross_fnf: 82231, tds_on_fnf: 10800, net_payable: 71431 }
        }
      });
    }
  };

  const approveSettlement = async (id) => {
    if (actioning) return;
    setActioning(true);
    try {
      await api.put(`/exit/fnf/${id}/approve`);
      showNotice('Settlement approved successfully');
      load();
    } catch (_) {
      showNotice('Failed to approve settlement', 'error');
    } finally { setActioning(false); }
  };

  const markPaid = async (id) => {
    if (actioning) return;
    setActioning(true);
    try {
      await api.post(`/exit/fnf/${id}/pay`);
      showNotice('Settlement marked as paid');
      load();
    } catch (_) {
      showNotice('Failed to mark settlement as paid', 'error');
    } finally { setActioning(false); }
  };

  const conductInterview = async () => {
    if (actioning) return;
    setActioning(true);
    try {
      await api.post('/exit/interview', { ...interviewForm, employee_id: showInterview });
      showNotice('Exit interview recorded successfully');
      setShowInterview(null);
      load();
    } catch (_) {
      showNotice('Failed to save exit interview', 'error');
    } finally { setActioning(false); }
  };

  const loadClearance = async (empId) => {
    try {
      const res = await api.get(`/exit/clearance/${empId}`);
      setClearanceData(p => ({ ...p, [empId]: res.data }));
    } catch (_) {
      setClearanceData(p => ({ ...p, [empId]: { it_assets_returned: false, access_revoked: false, documents_collected: false, exit_interview_done: false, noc_it: false, noc_admin: false, noc_finance: false, noc_hr: false, noc_manager: false } }));
    }
  };

  const updateClearance = async (empId, field, value) => {
    const updated = { ...(clearanceData[empId] || {}), [field]: value };
    setClearanceData(p => ({ ...p, [empId]: updated }));
    try { await api.put(`/exit/clearance/${empId}`, updated); } catch (_) {}
  };

  const fnfFnfId = fnfData?.id;
  const cd = fnfData?.computation_details;

  return (
    <div style={{ padding: '24px', background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111827', margin: 0 }}>Exit Management</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Full & Final settlement, Exit interviews, Clearance tracking</p>
      </div>

      {notice && (
        <div style={{ padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13, fontWeight: 600, background: notice.type === 'error' ? '#fee2e2' : '#dcfce7', color: notice.type === 'error' ? '#dc2626' : '#15803d' }}>
          {notice.msg}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 24, width: 'fit-content' }}>
        {['Active Exits', 'F&F Calculator', 'Exit Interviews', 'Clearance Tracker'].map((t, i) => (
          <button key={i} style={tabStyle(tab === i)} onClick={() => { setTab(i); if (i === 3) activeExits.forEach(e => loadClearance(e.employee_id)); }}>{t}</button>
        ))}
      </div>

      {tab === 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={() => setShowInitiate(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              + Initiate Exit
            </button>
          </div>

          {showInitiate && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>Initiate Employee Separation</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {[
                  { label: 'Employee ID', key: 'employee_id', type: 'number' },
                  { label: 'Separation Type', key: 'separation_type', type: 'select', options: ['resignation', 'termination', 'retirement', 'death'] },
                  { label: 'Last Working Date', key: 'last_working_date', type: 'date' }
                ].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
                    {f.type === 'select' ? (
                      <select value={initiateForm[f.key]} onChange={e => setInitiateForm(p => ({ ...p, [f.key]: e.target.value }))}
                        style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                        {f.options.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
                      </select>
                    ) : (
                      <input type={f.type} value={initiateForm[f.key]} onChange={e => setInitiateForm(p => ({ ...p, [f.key]: e.target.value }))}
                        style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                    )}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={initiateExit} disabled={actioning} style={{ padding: '8px 16px', background: actioning ? '#a78bfa' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: actioning ? 'not-allowed' : 'pointer', fontSize: 13 }}>{actioning ? 'Initiating…' : 'Initiate'}</button>
                <button onClick={() => setShowInitiate(false)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['Employee', 'Department', 'Type', 'Last Working Day', 'Days Left', 'Interview', 'F&F Status', 'Net Payable', 'Actions'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {activeExits.map((e, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600 }}>{e.employee_name}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>{e.employee_code} · {e.designation}</div>
                    </td>
                    <td style={tdStyle}>{e.department}</td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: '#f0ebff', color: SEP_COLORS[e.separation_type] || '#6B3FDB' }}>
                        {e.separation_type}
                      </span>
                    </td>
                    <td style={tdStyle}>{e.last_working_date}</td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: e.days_remaining <= 0 ? '#fee2e2' : e.days_remaining <= 7 ? '#fef3c7' : '#f0ebff', color: e.days_remaining <= 0 ? '#dc2626' : e.days_remaining <= 7 ? '#92400e' : '#6B3FDB' }}>
                        {e.days_remaining <= 0 ? 'Overdue' : `${e.days_remaining}d`}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: e.status === 'completed' ? '#d1fae5' : '#fef3c7', color: e.status === 'completed' ? '#065f46' : '#92400e' }}>{e.status}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: e.fnf_status === 'paid' ? '#d1fae5' : e.fnf_status === 'approved' ? '#dbeafe' : '#fef3c7', color: e.fnf_status === 'paid' ? '#065f46' : e.fnf_status === 'approved' ? '#1e40af' : '#92400e' }}>{e.fnf_status || 'draft'}</span>
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: '#6B3FDB' }}>{e.net_payable ? fmt(e.net_payable) : '-'}</td>
                    <td style={tdStyle}>
                      <button onClick={() => { setTab(1); computeFnF(e.employee_id); }} style={{ padding: '4px 10px', background: '#f0ebff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginRight: 4 }}>F&F</button>
                      <button onClick={() => { setTab(2); setShowInterview(e.employee_id); }} style={{ padding: '4px 10px', background: '#f0ebff', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Interview</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 1 && (
        <div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Select Employee</label>
              <select value={selectedEmployee || ''} onChange={e => { if (e.target.value) computeFnF(e.target.value); }}
                style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, width: 300 }}>
                <option value="">-- Select Employee --</option>
                {activeExits.map(e => <option key={e.employee_id} value={e.employee_id}>{e.employee_name} ({e.employee_code})</option>)}
              </select>
            </div>
          </div>

          {!fnfData && <div style={{ ...cardStyle, padding: 40, textAlign: 'center', color: '#6b7280' }}>Select an employee to compute F&F settlement</div>}

          {fnfData && cd && (
            <div>
              {fnfEstimated && (
                <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                  ⚠ Unable to fetch live data — showing estimated figures. Do not approve without verifying.
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div style={{ ...cardStyle, padding: 20, marginBottom: 0 }}>
                  <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#111827' }}>Notice Period Recovery</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                    <div style={{ color: '#6b7280' }}>Notice Period</div><div style={{ fontWeight: 600 }}>{cd.notice.period_days} days</div>
                    <div style={{ color: '#6b7280' }}>Days Served</div><div style={{ fontWeight: 600 }}>{cd.notice.served_days} days</div>
                    <div style={{ color: '#6b7280' }}>Shortfall</div><div style={{ fontWeight: 600, color: '#dc2626' }}>{cd.notice.shortfall_days} days</div>
                    <div style={{ color: '#6b7280' }}>Recovery Amount</div><div style={{ fontWeight: 700, color: '#dc2626' }}>{fmt(cd.notice.recovery)}</div>
                  </div>
                  {cd.notice.shortfall_days > 0 && <div style={{ marginTop: 8, padding: '8px 12px', background: '#fef3c7', borderRadius: 8, fontSize: 12, color: '#92400e' }}>Notice shortfall: {cd.notice.shortfall_days} days × ₹{cd.daily_basic}/day will be recovered</div>}
                </div>

                <div style={{ ...cardStyle, padding: 20, marginBottom: 0 }}>
                  <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#111827' }}>Leave Encashment</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                    <div style={{ color: '#6b7280' }}>Earned Leave Balance</div><div style={{ fontWeight: 600 }}>{cd.leave_encashment.balance_days} days</div>
                    <div style={{ color: '#6b7280' }}>Formula</div><div style={{ fontWeight: 400, fontSize: 12 }}>{cd.leave_encashment.formula}</div>
                    <div style={{ color: '#6b7280' }}>Amount</div><div style={{ fontWeight: 700, color: '#059669' }}>{fmt(cd.leave_encashment.amount)}</div>
                  </div>
                </div>

                <div style={{ ...cardStyle, padding: 20, marginBottom: 0 }}>
                  <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#111827' }}>Gratuity</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                    <div style={{ color: '#6b7280' }}>Service Years</div><div style={{ fontWeight: 600 }}>{cd.service_years?.toFixed(1)} years</div>
                    <div style={{ color: '#6b7280' }}>Eligible</div>
                    <div><span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: cd.gratuity.eligible ? '#d1fae5' : '#fee2e2', color: cd.gratuity.eligible ? '#065f46' : '#991b1b' }}>{cd.gratuity.eligible ? 'Yes' : 'No'}</span></div>
                    <div style={{ color: '#6b7280' }}>Formula</div><div style={{ fontSize: 11, color: '#6b7280' }}>{cd.gratuity.formula}</div>
                    <div style={{ color: '#6b7280' }}>Amount</div><div style={{ fontWeight: 700, color: cd.gratuity.eligible ? '#059669' : '#6b7280' }}>{fmt(cd.gratuity.amount)}</div>
                  </div>
                </div>

                <div style={{ ...cardStyle, padding: 20, marginBottom: 0 }}>
                  <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#111827' }}>PF & TDS</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                    <div style={{ color: '#6b7280' }}>PF Balance</div><div style={{ fontWeight: 600 }}>{fmt(cd.pf.balance)}</div>
                    <div style={{ color: '#6b7280' }}>TDS on PF</div>
                    <div><span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: cd.pf.tds_applicable ? '#fef3c7' : '#d1fae5', color: cd.pf.tds_applicable ? '#92400e' : '#065f46' }}>{cd.pf.tds_applicable ? `10% TDS applicable` : 'No TDS'}</span></div>
                    <div style={{ color: '#6b7280' }}>TDS Amount</div><div style={{ fontWeight: 700, color: '#dc2626' }}>{fmt(cd.pf.tds_amount)}</div>
                    <div style={{ color: '#6b7280' }}>TDS on F&F</div><div style={{ fontWeight: 700, color: '#dc2626' }}>{fmt(cd.tds.tds_on_fnf)}</div>
                  </div>
                </div>
              </div>

              <div style={{ ...cardStyle, padding: 24, background: 'linear-gradient(135deg, #6B3FDB 0%, #4f46e5 100%)', color: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 14, opacity: 0.8 }}>Net Payable to Employee</div>
                    <div style={{ fontSize: 36, fontWeight: 800, marginTop: 4 }}>{fmt(fnfData.net_payable)}</div>
                    <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>Total Payable {fmt(cd.summary.total_payable)} - Recoverable {fmt(cd.summary.total_recoverable)} - TDS {fmt(cd.summary.tds_on_fnf)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {fnfData.status === 'draft' && (
                      <button
                        onClick={() => approveSettlement(fnfFnfId)}
                        disabled={actioning || fnfEstimated || !fnfFnfId}
                        title={fnfEstimated ? 'Cannot approve estimated figures — live compute required' : ''}
                        style={{ padding: '10px 20px', background: '#fff', color: '#6B3FDB', border: 'none', borderRadius: 8, cursor: (actioning || fnfEstimated || !fnfFnfId) ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13, opacity: (actioning || fnfEstimated || !fnfFnfId) ? 0.5 : 1 }}>
                        {actioning ? 'Approving…' : 'Approve Settlement'}
                      </button>
                    )}
                    {fnfData.status === 'approved' && (
                      <button
                        onClick={() => markPaid(fnfFnfId)}
                        disabled={actioning || !fnfFnfId}
                        style={{ padding: '10px 20px', background: '#059669', color: '#fff', border: 'none', borderRadius: 8, cursor: (actioning || !fnfFnfId) ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13, opacity: (actioning || !fnfFnfId) ? 0.6 : 1 }}>
                        {actioning ? 'Processing…' : 'Mark as Paid'}
                      </button>
                    )}
                    {fnfData.status === 'paid' && <span style={{ padding: '10px 20px', background: '#059669', borderRadius: 8, fontSize: 13, fontWeight: 700 }}>Paid</span>}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 2 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 16 }}>
          <div>
            {showInterview && (
              <div style={{ ...cardStyle, padding: 20, marginBottom: 16, border: '2px solid #6B3FDB' }}>
                <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#6B3FDB' }}>Conduct Exit Interview</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Exit Reason</label>
                    <select value={interviewForm.reason_category} onChange={e => setInterviewForm(p => ({ ...p, reason_category: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                      {Object.entries(REASON_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Would Rejoin?</label>
                    <select value={interviewForm.would_rejoin} onChange={e => setInterviewForm(p => ({ ...p, would_rejoin: e.target.value }))}
                      style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                      {['yes', 'no', 'maybe'].map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Detailed Reason</label>
                  <textarea value={interviewForm.reason_detail} onChange={e => setInterviewForm(p => ({ ...p, reason_detail: e.target.value }))}
                    rows={3} style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
                </div>
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Ratings (1-5)</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
                    {[['Management', 'rating_management'], ['Culture', 'rating_culture'], ['Work', 'rating_work'], ['Growth', 'rating_growth'], ['Overall', 'overall_rating']].map(([label, key]) => (
                      <div key={key} style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</div>
                        <select value={interviewForm[key]} onChange={e => setInterviewForm(p => ({ ...p, [key]: parseInt(e.target.value) }))}
                          style={{ width: '100%', padding: '4px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, textAlign: 'center' }}>
                          {[1, 2, 3, 4, 5].map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
                <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                  <button onClick={conductInterview} disabled={actioning} style={{ padding: '8px 16px', background: actioning ? '#a78bfa' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: actioning ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>{actioning ? 'Saving…' : 'Submit Interview'}</button>
                  <button onClick={() => setShowInterview(null)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                </div>
              </div>
            )}

            <div style={cardStyle}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Employee', 'Department', 'Status', 'Reason', 'Overall Rating', 'Would Rejoin', 'Actions'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {interviews.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{r.employee_name}</td>
                      <td style={tdStyle}>{r.department}</td>
                      <td style={tdStyle}><span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, background: r.status === 'completed' ? '#d1fae5' : '#fef3c7', color: r.status === 'completed' ? '#065f46' : '#92400e' }}>{r.status}</span></td>
                      <td style={tdStyle}>{r.reason_category ? REASON_LABELS[r.reason_category] : '-'}</td>
                      <td style={tdStyle}>{r.overall_rating ? '⭐'.repeat(r.overall_rating) : '-'}</td>
                      <td style={tdStyle}>{r.would_rejoin || '-'}</td>
                      <td style={tdStyle}>
                        {r.status === 'scheduled' && <button onClick={() => setShowInterview(r.employee_id || r.id)} style={{ padding: '4px 10px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Conduct</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {analytics && (
            <div>
              <div style={{ ...cardStyle, padding: 16, marginBottom: 12 }}>
                <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Exit Reasons</h4>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={analytics.reasons.map(r => ({ name: REASON_LABELS[r.reason_category] || r.reason_category, value: parseInt(r.count) }))} cx="50%" cy="50%" outerRadius={70} dataKey="value" label={({ name: _name, value }) => `${value}`}>
                      {analytics.reasons.map((_, i) => <Cell key={i} fill={REASON_COLORS[i % REASON_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                  {analytics.reasons.map((r, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: REASON_COLORS[i] }} />
                      <span>{REASON_LABELS[r.reason_category] || r.reason_category}: {r.count}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ ...cardStyle, padding: 16 }}>
                <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Avg Ratings</h4>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={[
                    { name: 'Mgmt', value: parseFloat(analytics.ratings.avg_management || 0).toFixed(1) },
                    { name: 'Culture', value: parseFloat(analytics.ratings.avg_culture || 0).toFixed(1) },
                    { name: 'Work', value: parseFloat(analytics.ratings.avg_work || 0).toFixed(1) },
                    { name: 'Growth', value: parseFloat(analytics.ratings.avg_growth || 0).toFixed(1) },
                    { name: 'Overall', value: parseFloat(analytics.ratings.avg_overall || 0).toFixed(1) }
                  ]} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis domain={[0, 5]} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="#6B3FDB" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 3 && (
        <div>
          <div style={cardStyle}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Employee', 'IT Assets', 'Access Revoked', 'Documents', 'Interview', 'NOC: IT', 'NOC: Admin', 'NOC: Finance', 'NOC: HR', 'NOC: Manager', 'Status'].map(h => <th key={h} style={{ ...thStyle, fontSize: 11 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {activeExits.map((emp, i) => {
                  const c = clearanceData[emp.employee_id] || {};
                  const checks = ['it_assets_returned', 'access_revoked', 'documents_collected', 'exit_interview_done', 'noc_it', 'noc_admin', 'noc_finance', 'noc_hr', 'noc_manager'];
                  const doneCount = checks.filter(k => c[k]).length;
                  return (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>
                        <div>{emp.employee_name}</div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>{emp.department}</div>
                      </td>
                      {checks.map(field => (
                        <td key={field} style={{ ...tdStyle, textAlign: 'center' }}>
                          <input type="checkbox" checked={!!c[field]} onChange={e => updateClearance(emp.employee_id, field, e.target.checked)}
                            style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#6B3FDB' }} />
                        </td>
                      ))}
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ flex: 1, background: '#f0f0f4', borderRadius: 4, height: 6 }}>
                            <div style={{ width: `${(doneCount / checks.length) * 100}%`, background: doneCount === checks.length ? '#059669' : '#6B3FDB', height: '100%', borderRadius: 4 }} />
                          </div>
                          <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>{doneCount}/{checks.length}</span>
                        </div>
                        {doneCount === checks.length && (
                          <button
                            onClick={() => {
                              const win = window.open('', '_blank');
                              win.document.write(`<html><body style="font-family:sans-serif;padding:40px"><h2>No Objection Certificate</h2><p>This is to certify that <strong>${emp.employee_name}</strong> (${emp.employee_code}) has completed all exit clearance requirements and is hereby cleared of all obligations.</p><p>Department: ${emp.department}</p><p>Last Working Date: ${emp.last_working_date || '—'}</p><br/><p>Issued on: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</p><p>Authorized by HR</p></body></html>`);
                              win.document.close();
                              win.print();
                            }}
                            style={{ marginTop: 4, padding: '3px 8px', background: '#059669', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>
                            Print NOC
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
