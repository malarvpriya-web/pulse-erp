// frontend/src/features/servicedesk/pages/InstallationRequests.jsx
// Installation as a First-Class Module (Priority 6):
// Dispatch -> Installation Request -> Engineer Assignment -> Travel Planning
// -> Installation -> Commissioning -> Customer Acceptance
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

const P = '#6B3FDB';

const STATUS_META = {
  requested:         { bg: '#f3f4f6', color: '#374151', label: 'Requested' },
  engineer_assigned: { bg: '#dbeafe', color: '#1e40af', label: 'Engineer Assigned' },
  travel_planned:    { bg: '#fef3c7', color: '#92400e', label: 'Travel Planned' },
  in_progress:       { bg: '#e0e7ff', color: '#4338ca', label: 'In Progress' },
  completed:         { bg: '#d1fae5', color: '#065f46', label: 'Completed' },
  cancelled:         { bg: '#fee2e2', color: '#991b1b', label: 'Cancelled' },
};
function Badge({ status }) {
  const s = STATUS_META[status] || { bg: '#f3f4f6', color: '#6b7280', label: status || '—' };
  return <span style={{ background: s.bg, color: s.color, padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{s.label}</span>;
}

const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' };

export default function InstallationRequests() {
  const [requests, setRequests] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);

  const [assignModal, setAssignModal] = useState(null);
  const [engineerId, setEngineerId] = useState('');
  const [travelModal, setTravelModal] = useState(null);
  const [travelForm, setTravelForm] = useState({ from_date: '', to_date: '', mode: 'Road', notes: '' });
  const [completeModal, setCompleteModal] = useState(null);
  const [completeForm, setCompleteForm] = useState({ completion_notes: '', create_commissioning: true });
  const [acceptModal, setAcceptModal] = useState(null);
  const [acceptForm, setAcceptForm] = useState({ accepted_by: '', notes: '' });

  const flash = (text, type = 'success') => { setMsg({ text, type }); setTimeout(() => setMsg(null), 4000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rRes, eRes] = await Promise.allSettled([
        api.get('/installation-requests', { params: filterStatus ? { status: filterStatus } : {} }),
        api.get('/employees?status=active,probation'),
      ]);
      setRequests(rRes.status === 'fulfilled' ? (rRes.value.data || []) : []);
      setEmployees(eRes.status === 'fulfilled' ? (eRes.value.data?.employees || eRes.value.data?.data || eRes.value.data || []) : []);
    } catch { /* */ }
    setLoading(false);
  }, [filterStatus]);

  useEffect(() => { load(); }, [load]);

  async function assignEngineer() {
    if (!engineerId) return flash('Select an engineer', 'error');
    setSaving(true);
    try {
      await api.post(`/installation-requests/${assignModal.id}/assign-engineer`, { engineer_id: engineerId });
      flash('Engineer assigned'); setAssignModal(null); setEngineerId(''); load();
    } catch (e) { flash(e.response?.data?.error || 'Failed to assign engineer', 'error'); }
    finally { setSaving(false); }
  }

  async function planTravel() {
    if (!travelForm.from_date || !travelForm.to_date) return flash('From/To dates are required', 'error');
    setSaving(true);
    try {
      await api.post(`/installation-requests/${travelModal.id}/plan-travel`, travelForm);
      flash('Travel request created'); setTravelModal(null); setTravelForm({ from_date: '', to_date: '', mode: 'Road', notes: '' }); load();
    } catch (e) { flash(e.response?.data?.error || 'Failed to plan travel', 'error'); }
    finally { setSaving(false); }
  }

  async function startInstallation(id) {
    setSaving(true);
    try { await api.post(`/installation-requests/${id}/start`); flash('Installation started'); load(); }
    catch (e) { flash(e.response?.data?.error || 'Failed to start installation', 'error'); }
    finally { setSaving(false); }
  }

  async function completeInstallation() {
    setSaving(true);
    try {
      await api.post(`/installation-requests/${completeModal.id}/complete`, completeForm);
      flash(completeForm.create_commissioning ? 'Installation completed — Commissioning created' : 'Installation completed');
      setCompleteModal(null); setCompleteForm({ completion_notes: '', create_commissioning: true }); load();
    } catch (e) { flash(e.response?.data?.error || 'Failed to complete installation', 'error'); }
    finally { setSaving(false); }
  }

  async function recordAcceptance() {
    if (!acceptForm.accepted_by) return flash('Customer contact name is required', 'error');
    setSaving(true);
    try {
      await api.post(`/installation-requests/${acceptModal.id}/customer-acceptance`, acceptForm);
      flash('Customer acceptance recorded'); setAcceptModal(null); setAcceptForm({ accepted_by: '', notes: '' }); load();
    } catch (e) { flash(e.response?.data?.error || 'Failed to record acceptance', 'error'); }
    finally { setSaving(false); }
  }

  const counts = requests.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {msg && (
        <div style={{ position: 'fixed', top: 20, right: 24, background: msg.type === 'error' ? '#fee2e2' : '#d1fae5', color: msg.type === 'error' ? '#991b1b' : '#065f46', padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 12px rgba(0,0,0,.15)' }}>{msg.text}</div>
      )}

      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Installation Requests</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Dispatch → Installation Request → Engineer Assignment → Travel Planning → Installation → Commissioning → Customer Acceptance</p>
      </div>

      <div style={{ display: 'flex', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
        {Object.entries(STATUS_META).filter(([k]) => k !== 'cancelled').map(([key, meta]) => (
          <div key={key} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 18px', minWidth: 120 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{meta.label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: meta.color }}>{counts[key] || 0}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inp, width: 200 }}>
          <option value="">All Statuses</option>
          {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <button onClick={load} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>↻ Refresh</button>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : !requests.length ? (
          <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No installation requests. These are auto-created when a Sales Order with a linked project is dispatched.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['ID', 'Customer', 'Project / Order', 'Engineer', 'Travel', 'Commissioning', 'Status', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: '#6b7280', fontWeight: 600, whiteSpace: 'nowrap', borderBottom: '1px solid #e5e7eb' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>{r.installation_number}</td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>{r.customer_name || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                      {r.project_code && <div>{r.project_code}</div>}
                      {r.order_number && <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.order_number}</div>}
                    </td>
                    <td style={{ padding: '10px 14px', color: '#374151' }}>{r.engineer_name?.trim() || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{r.travel_status || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>
                      {r.commissioning_workflow_number ? `${r.commissioning_workflow_number} (${r.commissioning_status})` : '—'}
                    </td>
                    <td style={{ padding: '10px 14px' }}><Badge status={r.status} /></td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {r.status === 'requested' && (
                          <button onClick={() => { setAssignModal(r); setEngineerId(''); }}
                            style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #2563eb', background: 'transparent', color: '#2563eb', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Assign Engineer</button>
                        )}
                        {r.status === 'engineer_assigned' && (
                          <button onClick={() => setTravelModal(r)}
                            style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #d97706', background: 'transparent', color: '#d97706', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Plan Travel</button>
                        )}
                        {['engineer_assigned', 'travel_planned'].includes(r.status) && (
                          <button onClick={() => startInstallation(r.id)} disabled={saving}
                            style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #4338ca', background: 'transparent', color: '#4338ca', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Start</button>
                        )}
                        {r.status === 'in_progress' && (
                          <button onClick={() => setCompleteModal(r)}
                            style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #059669', background: 'transparent', color: '#059669', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Complete</button>
                        )}
                        {r.status === 'completed' && !r.customer_accepted && (
                          <button onClick={() => setAcceptModal(r)}
                            style={{ padding: '4px 10px', borderRadius: 5, border: '1px solid #6B3FDB', background: 'transparent', color: '#6B3FDB', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Customer Acceptance</button>
                        )}
                        {r.status === 'completed' && r.customer_accepted && (
                          <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>✓ Accepted by {r.customer_accepted_by}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Assign Engineer Modal */}
      {assignModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700, color: '#111827' }}>Assign Engineer</h2>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{assignModal.installation_number}</strong> — {assignModal.customer_name}
            </div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Engineer *</label>
            <select value={engineerId} onChange={e => setEngineerId(e.target.value)} style={inp}>
              <option value="">— Select engineer —</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name || ''} ({e.office_id || e.id})</option>)}
            </select>
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={() => setAssignModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
              <button onClick={assignEngineer} disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Assigning…' : 'Assign'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Plan Travel Modal */}
      {travelModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700, color: '#111827' }}>Plan Travel</h2>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
              <strong>{travelModal.installation_number}</strong> — creates a real Travel Request for the assigned engineer
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>From Date *</label>
                <input type="date" value={travelForm.from_date} onChange={e => setTravelForm(f => ({ ...f, from_date: e.target.value }))} style={inp} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>To Date *</label>
                <input type="date" value={travelForm.to_date} onChange={e => setTravelForm(f => ({ ...f, to_date: e.target.value }))} style={inp} />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Mode</label>
                <select value={travelForm.mode} onChange={e => setTravelForm(f => ({ ...f, mode: e.target.value }))} style={inp}>
                  {['Road', 'Rail', 'Air'].map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                <textarea value={travelForm.notes} onChange={e => setTravelForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={() => setTravelModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
              <button onClick={planTravel} disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#d97706', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving…' : 'Create Travel Request'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Complete Installation Modal */}
      {completeModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700, color: '#111827' }}>Complete Installation</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                <textarea value={completeForm.completion_notes} onChange={e => setCompleteForm(f => ({ ...f, completion_notes: e.target.value }))} style={{ ...inp, height: 64, resize: 'vertical' }} placeholder="Installation summary…" />
              </div>
              <label style={{ fontSize: 12, color: '#374151', display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={completeForm.create_commissioning} onChange={e => setCompleteForm(f => ({ ...f, create_commissioning: e.target.checked }))} />
                Create Commissioning workflow now
              </label>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={() => setCompleteModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
              <button onClick={completeInstallation} disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#059669', color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving…' : 'Confirm Completion'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Customer Acceptance Modal */}
      {acceptModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: '100%', maxWidth: 420, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <h2 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700, color: '#111827' }}>Customer Acceptance</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Accepted By *</label>
                <input value={acceptForm.accepted_by} onChange={e => setAcceptForm(f => ({ ...f, accepted_by: e.target.value }))} style={inp} placeholder="Customer contact name" />
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Notes</label>
                <textarea value={acceptForm.notes} onChange={e => setAcceptForm(f => ({ ...f, notes: e.target.value }))} style={{ ...inp, height: 56, resize: 'vertical' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={() => setAcceptModal(null)} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600, color: '#374151' }}>Cancel</button>
              <button onClick={recordAcceptance} disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: P, color: '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving…' : 'Record Acceptance'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
