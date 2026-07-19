// frontend/src/features/servicedesk/pages/SLAManagement.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, AlertTriangle, Download, Pencil, Trash2, MessageSquare, Zap } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend, PieChart, Pie, Cell } from 'recharts';

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 24px', textAlign: 'center', gap: 8,
      background: 'var(--color-background-secondary)',
      borderRadius: 'var(--border-radius-lg)',
      border: '0.5px solid var(--color-border-tertiary)',
    }}>
      {Icon && <Icon size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }} />}
      <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>{sub}</p>}
    </div>
  );
}

const PRIORITY_COLORS = { critical: '#dc2626', high: '#d97706', medium: '#0891b2', low: '#6b7280' };
const PRIORITY_BG = { critical: '#fee2e2', high: '#fef3c7', medium: '#dbeafe', low: '#f5f5f5' };
const RATING_EMOJIS = { 5: '😊', 4: '😊', 3: '😐', 2: '😞', 1: '😞' };

const tabStyle = (a) => ({ padding: '8px 20px', border: 'none', background: a ? '#6B3FDB' : 'transparent', color: a ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8, fontWeight: a ? 600 : 400, fontSize: 14 });
const cardStyle = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 };
const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', background: '#fafafa', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 16px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };

export default function SLAManagement() {
  const [tab, setTab] = useState(0);
  const [policies, setPolicies] = useState([]);
  const [breaches, setBreaches] = useState([]);
  const [compliance, setCompliance] = useState([]);
  const [csat, setCsat] = useState(null);
  const [rules, setRules] = useState([]);
  const [showNewPolicy, setShowNewPolicy] = useState(false);
  const [showNewRule, setShowNewRule]   = useState(false);
  const [editPolicy, setEditPolicy]     = useState(null);
  const [dateFrom, setDateFrom]         = useState('');
  const [dateTo, setDateTo]             = useState('');
  const [policyForm, setPolicyForm] = useState({ name: '', priority: 'medium', first_response_hours: 4, resolution_hours: 24, escalation_hours: 8, business_hours_only: true });
  const [ruleForm, setRuleForm] = useState({ name: '', priority: 10, conditions: [{ field: 'priority', operator: 'equals', value: '' }], assign_to_team: '', round_robin_group: '' });
  const [testRule, setTestRule] = useState({ priority: 'medium', category: 'general', subject: '' });
  const [testResult, setTestResult] = useState(null);
  const [toast, setToast] = useState(null);
  const [pendingDeletePolicy, setPendingDeletePolicy] = useState(null);
  const [pendingDeleteRule,   setPendingDeleteRule]   = useState(null);
  const timerRef  = useRef(null);
  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = useCallback(async () => {
    const [r1, r2, r3, r4, r5] = await Promise.allSettled([
      api.get('/servicedesk/sla/policies'),
      api.get('/servicedesk/sla/breaches'),
      api.get('/servicedesk/sla/compliance'),
      api.get('/servicedesk/csat/summary'),
      api.get('/servicedesk/auto-assignment-rules')
    ]);
    if (!isMounted.current) return;
    setPolicies(r1.status === 'fulfilled' ? (r1.value.data || []) : []);
    setBreaches(r2.status === 'fulfilled' ? (r2.value.data || []) : []);
    setCompliance(r3.status === 'fulfilled' ? (r3.value.data || []) : []);
    setCsat(r4.status === 'fulfilled' ? r4.value.data : null);
    setRules(r5.status === 'fulfilled' ? (r5.value.data || []) : []);
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(() => { if (tab === 1) load(); }, 60000);
    return () => clearInterval(timerRef.current);
  }, [load, tab]);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const addPolicy = async () => {
    try {
      if (editPolicy) {
        await api.put(`/servicedesk/sla/policies/${editPolicy.id}`, policyForm);
        setEditPolicy(null);
      } else {
        await api.post('/servicedesk/sla/policies', policyForm);
      }
      setShowNewPolicy(false);
      setPolicyForm({ name: '', priority: 'medium', first_response_hours: 4, resolution_hours: 24, escalation_hours: 8, business_hours_only: true });
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to save SLA policy', 'error');
    }
  };

  const deletePolicy = async () => {
    if (!pendingDeletePolicy) return;
    const id = pendingDeletePolicy;
    setPendingDeletePolicy(null);
    try {
      await api.delete(`/servicedesk/sla/policies/${id}`);
      showToast('Policy deleted');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to delete', 'error');
    }
  };

  const addRule = async () => {
    try {
      await api.post('/servicedesk/auto-assignment-rules', ruleForm);
      setShowNewRule(false);
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to create assignment rule', 'error');
    }
  };

  const deleteRule = async () => {
    if (!pendingDeleteRule) return;
    const id = pendingDeleteRule;
    setPendingDeleteRule(null);
    try {
      await api.delete(`/servicedesk/auto-assignment-rules/${id}`);
      showToast('Rule deleted');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to delete', 'error');
    }
  };

  const exportSLACompliance = async () => {
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo)   params.set('date_to', dateTo);
      const res = await api.get(`/servicedesk/export/sla-compliance?${params}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `sla_compliance_${new Date().toISOString().slice(0,10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch { showToast('Export failed', 'error'); }
  };

  const runTestRule = async () => {
    try {
      const res = await api.post('/servicedesk/tickets/auto-assign/preview', { ticket_data: testRule });
      setTestResult(res.data);
    } catch (_) {
      const matched = rules.find(r => {
        if (!r.conditions?.length) return true;
        return r.conditions.every(c => {
          if (c.operator === 'equals') return testRule[c.field] === c.value;
          return false;
        });
      });
      setTestResult(matched ? { assigned: true, rule: matched, message: `Matched: ${matched.name} → ${matched.assign_to_team || 'specific agent'}` } : { assigned: false, message: 'No rule matched' });
    }
  };

  const avgRating = parseFloat(csat?.avg_rating || 0);
  const ratingEmoji = avgRating >= 4 ? '😊' : avgRating >= 3 ? '😐' : '😞';

  return (
    <div style={{ padding: '24px', background: '#f5f3ff', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingDeletePolicy}
        title="Delete SLA Policy"
        message="Delete this SLA policy?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deletePolicy}
        onCancel={() => setPendingDeletePolicy(null)}
      />
      <ConfirmDialog
        open={!!pendingDeleteRule}
        title="Delete Assignment Rule"
        message="Delete this assignment rule?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteRule}
        onCancel={() => setPendingDeleteRule(null)}
      />
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 24, zIndex: 9999, padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600,
          background: toast.type === 'error' ? '#fee2e2' : '#dcfce7', color: toast.type === 'error' ? '#dc2626' : '#15803d',
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)' }}>
          {toast.msg}
        </div>
      )}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111827', margin: 0 }}>SLA & CSAT Management</h1>
        <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>SLA policies, breach tracking, CSAT analytics, auto-assignment</p>
      </div>

      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 24, width: 'fit-content' }}>
        {['SLA Policies', 'SLA Dashboard', 'CSAT', 'Auto Assignment'].map((t, i) => (
          <button key={i} style={tabStyle(tab === i)} onClick={() => setTab(i)}>{t}</button>
        ))}
      </div>

      {tab === 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={() => { setShowNewPolicy(true); setEditPolicy(null); setPolicyForm({ name: '', priority: 'medium', first_response_hours: 4, resolution_hours: 24, escalation_hours: 8, business_hours_only: true }); }}
              style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              + Create Policy
            </button>
          </div>

          {showNewPolicy && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>{editPolicy ? 'Edit SLA Policy' : 'New SLA Policy'}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Policy Name</label>
                  <input value={policyForm.name} onChange={e => setPolicyForm(p => ({ ...p, name: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                {[
                  { label: 'Priority', key: 'priority', type: 'select', options: ['critical', 'high', 'medium', 'low'] },
                  { label: 'First Response (hrs)', key: 'first_response_hours', type: 'number' },
                  { label: 'Resolution (hrs)', key: 'resolution_hours', type: 'number' },
                  { label: 'Escalation (hrs)', key: 'escalation_hours', type: 'number' }
                ].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
                    {f.type === 'select' ? (
                      <select value={policyForm[f.key]} onChange={e => setPolicyForm(p => ({ ...p, [f.key]: e.target.value }))}
                        style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                        {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input type={f.type} value={policyForm[f.key]} onChange={e => setPolicyForm(p => ({ ...p, [f.key]: e.target.value }))}
                        style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                    )}
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
                  <input type="checkbox" checked={policyForm.business_hours_only} onChange={e => setPolicyForm(p => ({ ...p, business_hours_only: e.target.checked }))}
                    style={{ width: 16, height: 16, accentColor: '#6B3FDB' }} />
                  <label style={{ fontSize: 13 }}>Business Hours Only</label>
                </div>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={addPolicy} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>{editPolicy ? 'Update' : 'Create'}</button>
                <button onClick={() => { setShowNewPolicy(false); setEditPolicy(null); }} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {policies.length === 0 && (
            <EmptyState icon={Shield} title="No SLA policies" sub="Create SLA policies to track service levels" />
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {policies?.map((p, i) => (
              <div key={i} style={{ background: '#fff', border: `2px solid ${PRIORITY_COLORS[p?.priority] || '#e9e4ff'}`, borderRadius: 12, padding: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <span style={{ padding: '3px 10px', background: PRIORITY_BG[p?.priority], color: PRIORITY_COLORS[p?.priority], borderRadius: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>{p?.priority ?? 'Unknown'}</span>
                    <h3 style={{ margin: '8px 0 0', fontSize: 15, fontWeight: 600 }}>{p?.name}</h3>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, color: '#6b7280' }}>Active</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#6B3FDB' }}>{p?.active_tickets ?? 0}</div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div style={{ background: '#f5f3ff', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>FIRST RESPONSE</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#6B3FDB' }}>{p?.first_response_hours ?? 0}h</div>
                  </div>
                  <div style={{ background: '#f0fdf4', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, color: '#6b7280' }}>RESOLUTION</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#059669' }}>{p?.resolution_hours ?? 0}h</div>
                  </div>
                </div>
                <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>{p?.business_hours_only ? '🕒 Business hours only' : '⏰ 24/7 coverage'}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { setEditPolicy(p); setPolicyForm({ name: p?.name, priority: p?.priority, first_response_hours: p?.first_response_hours, resolution_hours: p?.resolution_hours, escalation_hours: p?.escalation_hours, business_hours_only: p?.business_hours_only }); setShowNewPolicy(true); }}
                      style={{ background: 'none', border: '1px solid #e9e4ff', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#6B3FDB' }}>
                      <Pencil size={12} />
                    </button>
                    <button onClick={() => setPendingDeletePolicy(p.id)}
                      style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#dc2626' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 1 && (
        <div>
          {policies.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '48px 24px', textAlign: 'center',
              background: 'var(--color-background-secondary, #fafafa)', borderRadius: 12,
              border: '0.5px solid var(--color-border-tertiary, #e9e4ff)' }}>
              <Shield size={40} style={{ color: '#6B3FDB' }} />
              <p style={{ fontSize: 15, fontWeight: 600, color: '#111827', margin: 0 }}>No SLA data yet — create a policy first</p>
              <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
                SLA performance charts and breach tracking will appear once you configure SLA policies and tickets are resolved.
              </p>
              <button onClick={() => setTab(0)}
                style={{ marginTop: 4, padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                + Create SLA Policy
              </button>
            </div>
          ) : (
            <>
              {/* Date range + export */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 13, color: '#6b7280' }}>From</label>
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                  style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
                <label style={{ fontSize: 13, color: '#6b7280' }}>To</label>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                  style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
                <button onClick={load} style={{ padding: '7px 14px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Apply</button>
                {(dateFrom || dateTo) && (
                  <button onClick={() => { setDateFrom(''); setDateTo(''); }} style={{ padding: '7px 12px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Clear</button>
                )}
                <button onClick={exportSLACompliance} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
                  <Download size={14} /> Export CSV
                </button>
              </div>

              {breaches.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#dc2626', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>🚨</span>
                    SLA Breach Alerts — {breaches.length} ticket(s) require immediate attention
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {breaches.map((b, i) => (
                      <div key={i} style={{ background: '#fff', border: '2px solid #dc2626', borderRadius: 10, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>#{b.ticket_id} — {b.subject}</div>
                          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{b.customer_name} · <span style={{ color: PRIORITY_COLORS[b.priority] }}>{b.priority}</span></div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          {b.first_response_breached_now && <span style={{ padding: '4px 10px', background: '#fee2e2', color: '#dc2626', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>Response Breached</span>}
                          {b.resolution_breached_now && <span style={{ padding: '4px 10px', background: '#fef3c7', color: '#92400e', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>Resolution Breached</span>}
                          {!b.first_response_breached_now && !b.resolution_breached_now && <span style={{ padding: '4px 10px', background: '#fef3c7', color: '#92400e', borderRadius: 6, fontSize: 12 }}>
                            Breaching in {Math.min(Math.abs(b.first_response_hours_remaining), Math.abs(b.resolution_hours_remaining)).toFixed(1)}h
                          </span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {compliance.length === 0 && breaches.length === 0 && (
                <EmptyState icon={AlertTriangle} title="No compliance data yet" sub="SLA performance will appear once tickets are resolved against your policies" />
              )}
              {(compliance.length > 0 || breaches.length > 0) && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                  <div style={cardStyle}>
                    <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4' }}>
                      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>SLA Compliance by Policy</h3>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr>{['Policy', 'Total', 'Met', 'Breached', 'Compliance'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                      <tbody>
                        {compliance.map((c, i) => (
                          <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                            <td style={tdStyle}>
                              <span style={{ padding: '2px 8px', background: PRIORITY_BG[c.priority], color: PRIORITY_COLORS[c.priority], borderRadius: 4, fontSize: 11, fontWeight: 600 }}>{c.priority}</span>
                              <span style={{ marginLeft: 8, fontSize: 13 }}>{c.policy_name}</span>
                            </td>
                            <td style={tdStyle}>{c.total_tickets}</td>
                            <td style={{ ...tdStyle, color: '#059669', fontWeight: 600 }}>{c.met}</td>
                            <td style={{ ...tdStyle, color: '#dc2626', fontWeight: 600 }}>{c.breached}</td>
                            <td style={{ ...tdStyle, width: 120 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <div style={{ flex: 1, background: '#f0f0f4', borderRadius: 4, height: 8 }}>
                                  <div style={{ width: `${c.met_pct}%`, height: '100%', background: parseFloat(c.met_pct) >= 90 ? '#059669' : parseFloat(c.met_pct) >= 80 ? '#d97706' : '#dc2626', borderRadius: 4 }} />
                                </div>
                                <span style={{ fontSize: 12, fontWeight: 600, minWidth: 38 }}>{c.met_pct}%</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div style={{ ...cardStyle, padding: 20, marginBottom: 0 }}>
                    <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Compliance Overview</h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={compliance} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="priority" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Legend />
                        <Bar dataKey="met" fill="#6B3FDB" name="Met" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="breached" fill="#fee2e2" name="Breached" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 2 && (!csat || csat.total_responses === 0) && (
        <EmptyState
          icon={MessageSquare}
          title="No CSAT responses yet"
          sub="Customer satisfaction scores will appear after tickets are resolved and customers submit feedback"
        />
      )}

      {tab === 2 && csat && csat.total_responses > 0 && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '200px 200px 1fr', gap: 16, marginBottom: 20 }}>
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '24px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: 48 }}>{ratingEmoji}</div>
              <div style={{ fontSize: 40, fontWeight: 800, color: '#6B3FDB', marginTop: 4 }}>{csat.avg_rating}</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>Avg Rating / 5</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>{csat.total_responses} responses</div>
            </div>
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '24px 20px', textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 4 }}>NPS Score</div>
              <div style={{ fontSize: 40, fontWeight: 800, color: csat.nps_score >= 50 ? '#059669' : csat.nps_score >= 0 ? '#d97706' : '#dc2626' }}>{csat.nps_score}</div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Net Promoter Score</div>
              <div style={{ fontSize: 11, color: csat.nps_score >= 50 ? '#059669' : '#d97706', marginTop: 4 }}>{csat.nps_score >= 50 ? 'Excellent' : csat.nps_score >= 0 ? 'Good' : 'Needs Improvement'}</div>
            </div>
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: '20px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Rating Distribution</div>
              {[...(csat.distribution || [])].reverse().map(d => {
                const max = Math.max(...(csat.distribution || []).map(x => parseInt(x.count)));
                return (
                  <div key={d.rating} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <span style={{ fontSize: 12, width: 20, textAlign: 'right' }}>{'⭐'.repeat(d.rating)}</span>
                    <div style={{ flex: 1, background: '#f0f0f4', borderRadius: 4, height: 16 }}>
                      <div style={{ width: `${(parseInt(d.count) / max) * 100}%`, height: '100%', background: d.rating >= 4 ? '#6B3FDB' : d.rating === 3 ? '#d97706' : '#dc2626', borderRadius: 4 }} />
                    </div>
                    <span style={{ fontSize: 12, width: 24, color: '#6b7280' }}>{d.count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div style={cardStyle}>
              <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4' }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>CSAT by Agent</h3>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['Agent', 'Avg Rating', 'Responses'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {(csat.by_agent || []).map((a, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{a.agent_name}</td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 16 }}>{parseFloat(a.avg_rating) >= 4 ? '😊' : parseFloat(a.avg_rating) >= 3 ? '😐' : '😞'}</span>
                          <span style={{ fontWeight: 700, color: parseFloat(a.avg_rating) >= 4 ? '#059669' : parseFloat(a.avg_rating) >= 3 ? '#d97706' : '#dc2626' }}>{parseFloat(a.avg_rating).toFixed(1)}</span>
                        </div>
                      </td>
                      <td style={tdStyle}>{a.response_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ ...cardStyle, padding: 20, marginBottom: 0 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Monthly CSAT Trend</h3>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={(csat.monthly_trend || []).map(m => ({ month: m.month, rating: parseFloat(m.avg_rating).toFixed(1), count: m.count }))}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis domain={[1, 5]} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="rating" stroke="#6B3FDB" strokeWidth={2} dot={{ fill: '#6B3FDB' }} name="Avg Rating" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #f0f0f4' }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Recent Feedback</h3>
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(csat.recent_feedback || []).map((f, i) => (
                <div key={i} style={{ padding: '12px 16px', background: '#f9f8fe', borderRadius: 10, border: '1px solid #e9e4ff', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 24, flexShrink: 0 }}>{f.rating >= 4 ? '😊' : f.rating >= 3 ? '😐' : '😞'}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>Ticket #{f.ticket_id}: {f.ticket_subject}</span>
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>{f.responded_at ? new Date(f.responded_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '-'}</span>
                    </div>
                    <div style={{ fontSize: 13, color: '#374151', fontStyle: 'italic' }}>"{f.feedback}"</div>
                    <div style={{ marginTop: 4 }}>{'⭐'.repeat(f.rating)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 3 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button onClick={() => setShowNewRule(true)} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
              + New Rule
            </button>
          </div>

          {showNewRule && (
            <div style={{ ...cardStyle, padding: 20, marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15 }}>New Assignment Rule</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Rule Name</label>
                  <input value={ruleForm.name} onChange={e => setRuleForm(p => ({ ...p, name: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Priority (lower = first)</label>
                  <input type="number" value={ruleForm.priority} onChange={e => setRuleForm(p => ({ ...p, priority: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Assign to Team</label>
                  <input value={ruleForm.assign_to_team} onChange={e => setRuleForm(p => ({ ...p, assign_to_team: e.target.value }))}
                    style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>Conditions (all must match)</div>
                {ruleForm.conditions.map((cond, ci) => (
                  <div key={ci} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, marginBottom: 8 }}>
                    <select value={cond.field} onChange={e => { const c = [...ruleForm.conditions]; c[ci].field = e.target.value; setRuleForm(p => ({ ...p, conditions: c })); }}
                      style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                      <option value="priority">Priority</option>
                      <option value="category">Category</option>
                      <option value="subject">Subject contains</option>
                    </select>
                    <select value={cond.operator} onChange={e => { const c = [...ruleForm.conditions]; c[ci].operator = e.target.value; setRuleForm(p => ({ ...p, conditions: c })); }}
                      style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                      <option value="equals">equals</option>
                      <option value="contains">contains</option>
                    </select>
                    <input value={cond.value} onChange={e => { const c = [...ruleForm.conditions]; c[ci].value = e.target.value; setRuleForm(p => ({ ...p, conditions: c })); }}
                      placeholder="Value" style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }} />
                    <button onClick={() => setRuleForm(p => ({ ...p, conditions: p.conditions.filter((_, ii) => ii !== ci) }))}
                      style={{ padding: '8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 8, cursor: 'pointer' }}>✕</button>
                  </div>
                ))}
                <button onClick={() => setRuleForm(p => ({ ...p, conditions: [...p.conditions, { field: 'priority', operator: 'equals', value: '' }] }))}
                  style={{ padding: '6px 12px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #e9e4ff', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
                  + Add Condition
                </button>
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                <button onClick={addRule} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Save Rule</button>
                <button onClick={() => setShowNewRule(false)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {rules.length === 0 && !showNewRule && (
            <EmptyState
              icon={Zap}
              title="No auto-assignment rules"
              sub="Create rules to automatically route incoming tickets by category, priority, or subject to the right team"
            />
          )}

          <div style={{ display: rules.length === 0 ? 'none' : 'grid', gridTemplateColumns: '1fr 360px', gap: 16 }}>
            <div style={cardStyle}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>{['#', 'Rule Name', 'Conditions', 'Assign To', 'Status', ''].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 600 }}>#{r.priority}</td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{r.name}</td>
                      <td style={tdStyle}>
                        {(r.conditions || []).length === 0
                          ? <span style={{ fontSize: 12, color: '#9ca3af' }}>Default (all tickets)</span>
                          : (r.conditions || []).map((c, ci) => (
                            <span key={ci} style={{ padding: '2px 8px', background: '#f0ebff', color: '#6B3FDB', borderRadius: 4, fontSize: 11, marginRight: 4 }}>
                              {c.field} {c.operator} "{c.value}"
                            </span>
                          ))
                        }
                      </td>
                      <td style={tdStyle}>{r.assign_to_team || `User #${r.assign_to_user_id}`}</td>
                      <td style={tdStyle}><span style={{ padding: '2px 8px', background: r.is_active ? '#d1fae5' : '#f5f5f5', color: r.is_active ? '#065f46' : '#6b7280', borderRadius: 4, fontSize: 11 }}>{r.is_active ? 'Active' : 'Inactive'}</span></td>
                      <td style={tdStyle}>
                        <button onClick={() => setPendingDeleteRule(r.id)}
                          style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: '#dc2626' }}>
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ ...cardStyle, padding: 20, marginBottom: 0 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Test Assignment Rule</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[{ label: 'Priority', key: 'priority', type: 'select', options: ['critical', 'high', 'medium', 'low'] },
                  { label: 'Category', key: 'category', type: 'text', placeholder: 'billing / technical / general...' },
                  { label: 'Subject', key: 'subject', type: 'text', placeholder: 'Enter ticket subject...' }
                ].map(f => (
                  <div key={f.key}>
                    <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>{f.label}</label>
                    {f.type === 'select' ? (
                      <select value={testRule[f.key]} onChange={e => setTestRule(p => ({ ...p, [f.key]: e.target.value }))}
                        style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }}>
                        {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input type="text" value={testRule[f.key]} placeholder={f.placeholder}
                        onChange={e => setTestRule(p => ({ ...p, [f.key]: e.target.value }))}
                        style={{ width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                    )}
                  </div>
                ))}
                <button onClick={runTestRule} style={{ padding: '10px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, marginTop: 4 }}>
                  Test Rule
                </button>
                {testResult && (
                  <div style={{ padding: '12px 16px', background: testResult.assigned ? '#d1fae5' : '#fee2e2', borderRadius: 8, border: `1px solid ${testResult.assigned ? '#6ee7b7' : '#fca5a5'}` }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: testResult.assigned ? '#065f46' : '#dc2626' }}>{testResult.assigned ? '✅ Would be assigned' : '❌ No rule matched'}</div>
                    <div style={{ fontSize: 12, color: '#374151', marginTop: 4 }}>{testResult.message}</div>
                    {testResult.rule && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>Rule: {testResult.rule.name} → {testResult.rule.assign_to_team || 'specific agent'}</div>}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
