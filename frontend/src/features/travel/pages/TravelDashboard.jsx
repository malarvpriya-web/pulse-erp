import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { Plane, Clock, CheckCircle, Plus, TrendingUp, Receipt, AlertCircle, Users, Building2, CreditCard } from 'lucide-react';
import { STATUS_COLOR, fmt } from './travelUtils';
import '@/components/dashboard/dashkit.css';

const fmtDate = (d) => {
  if (!d) return '—';
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.split('-').reverse().join('/');
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

function KPICard({ label, value, icon: Icon, color, isText, index = 0 }) {
  return (
    <div className="dk-anim" style={{ background: '#fff', borderRadius: 11, padding: 13, border: '1px solid #f0f0f4', boxShadow: '0 1px 3px rgba(0,0,0,.06)', '--dk-i': index }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <p style={{ fontSize: 11.5, color: '#9ca3af', margin: '0 0 5px', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</p>
          <p style={{ fontSize: isText ? 18 : 24, fontWeight: 700, color: '#1f2937', margin: 0 }}>{value}</p>
        </div>
        <div style={{ background: color + '18', borderRadius: 10, padding: 8 }}>
          <Icon size={17} color={color} />
        </div>
      </div>
    </div>
  );
}

// ── Employee Dashboard ────────────────────────────────────────────────────────
function EmployeeDashboard({ setPage }) {
  const [stats,  setStats]  = useState({});
  const [claims, setClaims] = useState([]);
  const [reqs,   setReqs]   = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get('/reimbursement/dashboard'),
      api.get('/reimbursement/claims', { params: { limit: 5 } }),
      api.get('/travel/my-entries'),
    ]).then(([st, cl, rq]) => {
      setStats(st.status === 'fulfilled' ? (st.value?.data || {}) : {});
      setClaims(cl.status === 'fulfilled' ? (cl.value?.data || []).slice(0, 5) : []);
      setReqs(rq.status === 'fulfilled' ? (rq.value?.data || []).slice(0, 5) : []);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 12 }}>
        <KPICard index={0} label="Pending Claims"    value={stats.pending_claims || 0}      icon={Clock}       color="#f59e0b" />
        <KPICard index={1} label="Reimbursed"        value={stats.reimbursed_claims || 0}    icon={CheckCircle} color="#10b981" />
        <KPICard index={2} label="Rejected"          value={stats.rejected_claims || 0}      icon={AlertCircle} color="#ef4444" />
        <KPICard index={3} label="Amount Receivable" value={fmt(stats.pending_amount || 0)}  icon={CreditCard}  color="#6B3FDB" isText />
      </div>

      {/* Quick actions */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 12 }}>
        {[
          { label: 'New Travel Request', page: 'TravelRequests',   color: '#6B3FDB' },
          { label: 'Submit Expense',     page: 'ExpenseClaims',    color: '#10b981' },
          { label: 'Visit Report',       page: 'VisitReports',     color: '#6366f1' },
          { label: 'My Approvals',       page: 'TravelApprovals',  color: '#f59e0b' },
        ].map(a => (
          <button key={a.page} onClick={() => setPage?.(a.page)}
            style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '12px 14px', cursor: 'pointer', textAlign: 'left', fontWeight: 600, color: a.color, fontSize: 13 }}
            onMouseEnter={e => e.currentTarget.style.background = '#f5f3ff'}
            onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
            {a.label} →
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Recent travel requests */}
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4' }}>
          <div style={{ padding: '11px 15px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>My Travel Requests</h3>
            <button onClick={() => setPage?.('TravelRequests')} style={{ fontSize: 11, color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>View All</button>
          </div>
          <div style={{ padding: '0 4px', maxHeight: 280, overflowY: 'auto' }}>
            {reqs.length === 0 ? (
              <p style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No requests yet</p>
            ) : reqs.map(r => {
              const sc = STATUS_COLOR[r.status] || { bg: '#f3f4f6', color: '#374151' };
              return (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #f9fafb' }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: '#1f2937' }}>TR-{String(r.id).padStart(3,'0')}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtDate(r.start)} · {fmt(r.total || 0)}</div>
                  </div>
                  <span style={{ background: sc.bg, color: sc.color, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{r.status}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent claims */}
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4' }}>
          <div style={{ padding: '11px 15px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>Recent Claims</h3>
            <button onClick={() => setPage?.('ExpenseClaims')} style={{ fontSize: 11, color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>View All</button>
          </div>
          <div style={{ padding: '0 4px', maxHeight: 280, overflowY: 'auto' }}>
            {claims.length === 0 ? (
              <p style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No claims yet</p>
            ) : claims.map(c => (
              <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #f9fafb' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#1f2937' }}>{c.claim_number}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.expense_type} · {c.expense_date?.slice(0,10)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#6B3FDB' }}>{fmt(c.total_amount || 0)}</div>
                  <span style={{ fontSize: 11, color: '#9ca3af' }}>{c.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Recent Travel Requests (shared admin/manager section) ────────────────────
function RecentTravelRequests({ setPage }) {
  const [data,    setData]    = useState({ requests: [], total_requests: 0, total_budget: 0, pending_count: 0, approved_count: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/travel/recent-requests')
      .then(r => setData(r?.data ?? {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const requests = data?.requests ?? [];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 12 }}>
        <KPICard index={0} label="Total Requests" value={data?.total_requests ?? 0}    icon={Plane}       color="#6B3FDB" />
        <KPICard index={1} label="Total Budget"   value={fmt(data?.total_budget ?? 0)} icon={CreditCard}  color="#10b981" isText />
        <KPICard index={2} label="Pending"        value={data?.pending_count ?? 0}      icon={Clock}       color="#f59e0b" />
        <KPICard index={3} label="Approved"       value={data?.approved_count ?? 0}     icon={CheckCircle} color="#10b981" />
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        <div style={{ padding: '11px 15px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>Recent Travel Requests</h3>
          <button onClick={() => setPage?.('TravelRequests')} style={{ fontSize: 11, color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>View All</button>
        </div>
        <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 330px)', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['REQUEST #','EMPLOYEE','DESTINATION','PURPOSE','TRAVEL DATE','BUDGET','STATUS'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 11, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Loading…</td></tr>
              ) : requests.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No travel requests found</td></tr>
              ) : requests.map((r, i) => {
                const sc = STATUS_COLOR[r?.status] ?? { bg: '#f3f4f6', color: '#374151' };
                return (
                  <tr key={r?.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '9px 14px', fontWeight: 600, color: '#6B3FDB' }}>{r?.request_number ?? '—'}</td>
                    <td style={{ padding: '9px 14px', fontWeight: 500 }}>{r?.employee_name ?? 'Unassigned'}</td>
                    <td style={{ padding: '9px 14px', color: '#6b7280' }}>{r?.destination ?? '—'}</td>
                    <td style={{ padding: '9px 14px', color: '#6b7280', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r?.purpose ?? '—'}</td>
                    <td style={{ padding: '9px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(r?.travel_date)}</td>
                    <td style={{ padding: '9px 14px', fontWeight: 600, color: '#374151' }}>{fmt(r?.budget ?? 0)}</td>
                    <td style={{ padding: '9px 14px' }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{r?.status ?? 'pending'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Manager Dashboard ─────────────────────────────────────────────────────────
function ManagerDashboard({ setPage }) {
  const [stats,    setStats]    = useState({});
  const [pending,  setPending]  = useState([]);
  const [overPolicy, setOverPolicy] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get('/reimbursement/dashboard'),
      api.get('/reimbursement/pending-for-approval'),
      api.get('/reimbursement/over-policy'),
      api.get('/travel/analytics/department'),
    ]).then(([st, pnd, op]) => {
      setStats(st.status === 'fulfilled' ? (st.value?.data || {}) : {});
      setPending(pnd.status === 'fulfilled' ? (pnd.value?.data || []) : []);
      setOverPolicy(op.status === 'fulfilled' ? (op.value?.data || []).slice(0, 5) : []);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 12 }}>
        <KPICard index={0} label="Pending My Approval" value={stats.manager_pending || 0}   icon={Clock}       color="#f59e0b" />
        <KPICard index={1} label="Accounts Pending"    value={stats.accounts_pending || 0}  icon={Receipt}     color="#6366f1" />
        <KPICard index={2} label="Over Policy Claims"  value={overPolicy.length}            icon={AlertCircle} color="#ef4444" />
        <KPICard index={3} label="Monthly Paid"        value={fmt(stats.monthly_paid || 0)} icon={CreditCard}  color="#10b981" isText />
      </div>

      {/* Pending approvals table */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ padding: '11px 15px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>Pending Approvals</h3>
          <button onClick={() => setPage?.('ExpenseClaims')} style={{ fontSize: 11, color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 500 }}>View All</button>
        </div>
        <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 330px)', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Claim #','Employee','Type','Date','Total','Customer','Status'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 11, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No pending approvals</td></tr>
              ) : pending.slice(0, 8).map((c, i) => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '9px 14px', fontWeight: 600, color: '#6B3FDB' }}>{c.claim_number}</td>
                  <td style={{ padding: '9px 14px', fontWeight: 500 }}>{c.employee_name}</td>
                  <td style={{ padding: '9px 14px', color: '#6b7280' }}>{c.expense_type}</td>
                  <td style={{ padding: '9px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>{c.expense_date?.slice(0,10)}</td>
                  <td style={{ padding: '9px 14px', fontWeight: 600, color: '#374151' }}>{fmt(c.total_amount || 0)}</td>
                  <td style={{ padding: '9px 14px', color: '#6b7280' }}>{c.customer_name || '—'}</td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{c.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Over policy */}
      {overPolicy.length > 0 && (
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#c2410c', marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
            <AlertCircle size={15} /> Over-Policy Claims ({overPolicy.length})
          </div>
          {overPolicy.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid #fed7aa', fontSize: 12 }}>
              <span style={{ color: '#9a3412' }}>{c.claim_number} · {c.employee_name}</span>
              <span style={{ fontWeight: 600, color: '#c2410c' }}>{fmt(c.total_amount)} (limit: {fmt(c.policy_limit || 0)})</span>
            </div>
          ))}
        </div>
      )}

      <RecentTravelRequests setPage={setPage} />
    </div>
  );
}

// ── Accounts Dashboard ────────────────────────────────────────────────────────
function AccountsDashboard({ setPage }) {
  const [stats,   setStats]   = useState({});
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get('/reimbursement/dashboard'),
      api.get('/reimbursement/pending-for-approval'),
    ]).then(([st, pnd]) => {
      setStats(st.status === 'fulfilled' ? (st.value?.data || {}) : {});
      setPending(pnd.status === 'fulfilled' ? (pnd.value?.data || []) : []);
    }).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 12 }}>
        <KPICard index={0} label="Pending Verification" value={stats.accounts_pending || 0}    icon={Receipt}     color="#6366f1" />
        <KPICard index={1} label="Pending Payment"       value={0}                               icon={CreditCard}  color="#6B3FDB" />
        <KPICard index={2} label="Monthly Reimbursed"    value={fmt(stats.monthly_paid || 0)}   icon={CheckCircle} color="#10b981" isText />
        <KPICard index={3} label="GST Recoverable"       value={fmt(stats.gst_recoverable || 0)}icon={TrendingUp}  color="#f59e0b" isText />
      </div>

      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #f0f0f4' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>Claims Pending Accounts Verification</h3>
        </div>
        <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 330px)', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Claim #','Employee','Category','Date','Amount','GST','Total','Bill','Drive','Status'].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 11, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 ? (
                <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No claims pending verification</td></tr>
              ) : pending.slice(0, 10).map((c, i) => (
                <tr key={c.id} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ padding: '9px 14px', fontWeight: 600, color: '#6B3FDB' }}>{c.claim_number}</td>
                  <td style={{ padding: '9px 14px', fontWeight: 500 }}>{c.employee_name}</td>
                  <td style={{ padding: '9px 14px', color: '#6b7280' }}>{c.expense_category}</td>
                  <td style={{ padding: '9px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>{c.expense_date?.slice(0,10)}</td>
                  <td style={{ padding: '9px 14px' }}>{fmt(c.amount)}</td>
                  <td style={{ padding: '9px 14px', color: '#f59e0b' }}>{fmt(c.gst_amount || 0)}</td>
                  <td style={{ padding: '9px 14px', fontWeight: 600, color: '#10b981' }}>{fmt(c.total_amount || 0)}</td>
                  <td style={{ padding: '9px 14px', color: '#6b7280' }}>{c.bill_number || '—'}</td>
                  <td style={{ padding: '9px 14px' }}>
                    {c.google_drive_link
                      ? <a href={c.google_drive_link} target="_blank" rel="noopener noreferrer" style={{ color: '#6366f1', fontSize: 11 }}>View</a>
                      : <span style={{ color: '#d1d5db', fontSize: 11 }}>—</span>}
                  </td>
                  <td style={{ padding: '9px 14px' }}>
                    <span style={{ background: '#dbeafe', color: '#1e40af', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{c.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function TravelDashboard({ setPage }) {
  const { hasAnyRole } = useAuth();

  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set. These pick which dashboard tab you land on, so gating on it alone
  // dropped a secondary-role manager onto the employee view. See AuthContext.
  const isAdmin    = hasAnyRole('admin', 'super_admin');
  const isManager  = hasAnyRole('manager', 'hr');
  const isFinance  = hasAnyRole('finance');

  const [activeTab, setActiveTab] = useState(
    isAdmin ? 'ceo' : isManager ? 'manager' : isFinance ? 'accounts' : 'employee'
  );

  const TABS = [
    { key: 'employee', label: 'My Dashboard',          show: true },
    { key: 'manager',  label: 'Manager Dashboard',     show: isManager || isAdmin },
    { key: 'accounts', label: 'Accounts Dashboard',    show: isFinance || isAdmin },
    { key: 'ceo',      label: 'Command Center',        show: isAdmin },
  ].filter(t => t.show);

  return (
    <div style={{ padding: '16px 18px 20px', background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1f2937', margin: 0 }}>Travel & Reimbursement</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>Complete travel management — request, claim, approve, reimburse</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => setPage?.('TravelRequests')}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={15} /> New Request
          </button>
        </div>
      </div>

      {/* Tab selector */}
      {TABS.length > 1 && (
        <div style={{ display: 'flex', gap: 0, marginBottom: 12, background: '#fff', borderRadius: 10, padding: 4, border: '1px solid #f0f0f4', width: 'fit-content' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              style={{ padding: '7px 16px', borderRadius: 7, border: 'none', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                background: activeTab === t.key ? '#6B3FDB' : 'transparent',
                color: activeTab === t.key ? '#fff' : '#6b7280' }}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Role-based dashboard content */}
      {activeTab === 'employee' && <EmployeeDashboard setPage={setPage} />}
      {activeTab === 'manager'  && <ManagerDashboard  setPage={setPage} />}
      {activeTab === 'accounts' && <AccountsDashboard setPage={setPage} />}
      {activeTab === 'ceo' && (
        <div>
          <RecentTravelRequests setPage={setPage} />
          <div style={{ textAlign: 'center', marginTop: 20 }}>
            <button onClick={() => setPage?.('TravelCommandCenter')}
              style={{ padding: '10px 24px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              Open CEO Travel Command Center →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
