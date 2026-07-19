import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { getPosition } from '@/mobile/native';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { Plus, X, Search, MapPin, FileText, CheckCircle } from 'lucide-react';

const VISIT_TYPES = [
  'Sales Visit', 'Customer Meeting', 'Application Engineering',
  'Site Survey', 'FAT Support', 'Installation', 'Commissioning',
  'Service Visit', 'AMC Visit', 'Training', 'Design Discussion',
  'Tender Discussion', 'Internal Meeting',
];

const OUTCOMES = [
  'Positive', 'Follow-up Required', 'Order Expected', 'No Interest',
  'Technical Query Raised', 'Demo Scheduled', 'Proposal Submitted',
  'Closed Successfully', 'Escalated',
];

const STATUSES = ['Draft', 'Submitted', 'Completed'];

const STATUS_COLOR = {
  Draft:     { bg: '#f3f4f6', color: '#6b7280' },
  Submitted: { bg: '#dbeafe', color: '#1e40af' },
  Completed: { bg: '#d1fae5', color: '#065f46' },
};

const EMPTY = {
  travel_request_id: '', visit_type: 'Sales Visit',
  customer_name: '', customer_id: '',
  project_number: '', site_name: '',
  opportunity_ref: '', visited_by: '',
  visit_date: '', purpose: '', discussion_summary: '',
  next_followup: '', next_followup_notes: '',
  gps_lat: '', gps_lng: '', location: '',
  outcome: 'Follow-up Required', status: 'Draft',
  action_items: [], attachments: [],
};

const inp = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box', background: '#fff' };
const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 };

function StatusBadge({ status }) {
  const sc = STATUS_COLOR[status] || { bg: '#f3f4f6', color: '#374151' };
  return <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>{status}</span>;
}

export default function VisitReports() {
  const toast = useToast();
  const { user } = useAuth();
  const [reports,  setReports]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState(null);
  const [form,     setForm]     = useState(EMPTY);
  const [saving,   setSaving]   = useState(false);
  const [search,   setSearch]   = useState('');
  const [tab,      setTab]      = useState('All');
  const [newAction, setNewAction] = useState({ action: '', owner: '', due_date: '' });
  const [stats,    setStats]    = useState({});

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([
      api.get('/visit-reports'),
      api.get('/visit-reports/summary/stats'),
    ]).then(([reps, st]) => {
      setReports(reps.status === 'fulfilled' ? (reps.value?.data || []) : []);
      setStats(st.status === 'fulfilled' ? (st.value?.data || {}) : {});
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const fld = (key, val) => setForm(p => ({ ...p, [key]: val }));

  const addAction = () => {
    if (!newAction.action) return;
    fld('action_items', [...form.action_items, { ...newAction, status: 'Open' }]);
    setNewAction({ action: '', owner: '', due_date: '' });
  };

  const removeAction = (idx) => fld('action_items', form.action_items.filter((_, i) => i !== idx));

  const getCurrentPosition = async () => {
    try {
      const { latitude, longitude } = await getPosition(); // native GPS on device, browser geo on web
      fld('gps_lat', latitude.toFixed(7)); fld('gps_lng', longitude.toFixed(7));
    } catch { toast.error('Could not get location'); }
  };

  const handleSave = async () => {
    if (!form.visit_date || !form.visit_type) {
      toast.error('Visit Date and Type are required'); return;
    }
    setSaving(true);
    try {
      await api.post('/visit-reports', form);
      toast.success('Visit report created');
      setShowForm(false); setForm(EMPTY); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleUpdateStatus = async (id, status) => {
    try {
      await api.put(`/visit-reports/${id}`, { ...selected, status });
      toast.success(`Status updated to ${status}`);
      setSelected(null); load();
    } catch { toast.error('Update failed'); }
  };

  const filtered = reports.filter(r => {
    if (tab !== 'All' && r.status !== tab) return false;
    if (!search) return true;
    return [r.customer_name, r.project_number, r.visit_type, r.visited_by_name, r.purpose, r.report_number]
      .some(v => (v || '').toLowerCase().includes(search.toLowerCase()));
  });

  const fmtDate = d => d ? d.slice(0, 10) : '—';

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Visit Reports</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            Customer / Site visit documentation with action items
          </p>
        </div>
        <button onClick={() => { setForm(EMPTY); setShowForm(true); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <Plus size={15} /> New Report
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 20 }}>
        {[
          { label: 'Total Reports',      value: stats.total || 0,             color: '#6366f1' },
          { label: 'This Month',         value: stats.this_month || 0,        color: '#6B3FDB' },
          { label: 'Draft / Pending',    value: stats.pending_reports || 0,   color: '#f59e0b' },
          { label: 'Upcoming Follow-ups',value: stats.upcoming_followups || 0,color: '#10b981' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', border: '1px solid #f0f0f4' }}>
            <div style={{ fontSize: 12, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.5px' }}>{k.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, project, visit type..."
            style={{ ...inp, paddingLeft: 32 }} />
        </div>
        {['All', ...STATUSES].map(s => (
          <button key={s} onClick={() => setTab(s)}
            style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid', fontSize: 11, fontWeight: 500, cursor: 'pointer',
              borderColor: tab === s ? '#6B3FDB' : '#e5e7eb',
              background: tab === s ? '#6B3FDB' : '#fff',
              color: tab === s ? '#fff' : '#374151' }}>
            {s}
          </button>
        ))}
      </div>

      {/* Reports grid */}
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 48, textAlign: 'center', color: '#9ca3af' }}>
          <FileText size={36} color="#d1d5db" style={{ marginBottom: 10 }} />
          <p style={{ margin: 0 }}>No visit reports found</p>
          <button onClick={() => setShowForm(true)}
            style={{ marginTop: 12, padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
            Create First Report
          </button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
          {filtered.map(r => (
            <div key={r.id} onClick={() => setSelected(r)}
              style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 20, cursor: 'pointer', transition: 'box-shadow .15s' }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,.08)'}
              onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#6B3FDB' }}>{r.report_number}</div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#1f2937', marginTop: 2 }}>{r.customer_name || 'Internal'}</div>
                </div>
                <StatusBadge status={r.status} />
              </div>

              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <span style={{ background: '#f5f3ff', color: '#6B3FDB', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>
                  {r.visit_type}
                </span>
              </div>

              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                {r.visit_date?.slice(0,10)} · {r.visited_by_name}
              </div>

              {r.purpose && (
                <div style={{ fontSize: 12, color: '#374151', marginBottom: 8, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {r.purpose}
                </div>
              )}

              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#9ca3af', marginTop: 10, borderTop: '1px solid #f9fafb', paddingTop: 10 }}>
                {r.project_number && <span>📋 {r.project_number}</span>}
                {r.site_name && <span><MapPin size={10} style={{ verticalAlign: 'middle' }} /> {r.site_name}</span>}
                {r.next_followup && (
                  <span style={{ color: '#f59e0b' }}>
                    📅 Follow-up: {r.next_followup?.slice(0,10)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 680, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div>
                <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>{selected.report_number}</h2>
                <StatusBadge status={selected.status} />
              </div>
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
              {[
                ['Visit Type', selected.visit_type],
                ['Visited By', selected.visited_by_name],
                ['Visit Date', selected.visit_date?.slice(0,10)],
                ['Customer', selected.customer_name],
                ['Project #', selected.project_number],
                ['Site', selected.site_name],
                ['Opportunity', selected.opportunity_ref],
                ['Location', selected.location],
                ['GPS', selected.gps_lat ? `${selected.gps_lat}, ${selected.gps_lng}` : null],
                ['Outcome', selected.outcome],
                ['Next Follow-up', selected.next_followup?.slice(0,10)],
              ].filter(([, v]) => v).map(([label, value]) => (
                <div key={label}>
                  <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontWeight: 500, color: '#1f2937' }}>{value}</div>
                </div>
              ))}
            </div>

            {selected.purpose && (
              <div style={{ marginTop: 16, padding: 12, background: '#f9fafb', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, marginBottom: 6 }}>PURPOSE</div>
                <p style={{ margin: 0, fontSize: 13, color: '#374151' }}>{selected.purpose}</p>
              </div>
            )}

            {selected.discussion_summary && (
              <div style={{ marginTop: 12, padding: 12, background: '#f9fafb', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, marginBottom: 6 }}>DISCUSSION SUMMARY</div>
                <p style={{ margin: 0, fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap' }}>{selected.discussion_summary}</p>
              </div>
            )}

            {selected.next_followup_notes && (
              <div style={{ marginTop: 12, padding: 12, background: '#fffbeb', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: '#92400e', fontWeight: 600, marginBottom: 6 }}>FOLLOW-UP NOTES</div>
                <p style={{ margin: 0, fontSize: 13, color: '#92400e' }}>{selected.next_followup_notes}</p>
              </div>
            )}

            {/* Action items */}
            {selected.action_items && selected.action_items.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 10 }}>ACTION ITEMS</div>
                {selected.action_items.map((ai, i) => (
                  <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: '1px solid #f0f0f4' }}>
                    <CheckCircle size={14} color={ai.status === 'Closed' ? '#10b981' : '#d1d5db'} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, fontSize: 13 }}>
                      <div style={{ color: '#1f2937', fontWeight: 500 }}>{ai.action}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                        Owner: {ai.owner || '—'} {ai.due_date ? `· Due: ${ai.due_date}` : ''}
                      </div>
                    </div>
                    <span style={{ fontSize: 11, color: ai.status === 'Closed' ? '#10b981' : '#f59e0b', fontWeight: 600 }}>{ai.status}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Status update buttons */}
            {selected.status === 'Draft' && (
              <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
                <button onClick={() => handleUpdateStatus(selected.id, 'Submitted')}
                  style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  Submit Report
                </button>
              </div>
            )}
            {selected.status === 'Submitted' && (
              <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
                <button onClick={() => handleUpdateStatus(selected.id, 'Completed')}
                  style={{ padding: '9px 18px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  Mark Completed
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* New Report Modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 720, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>New Visit Report</h2>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>

            {/* Visit Details */}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Visit Details</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
              <div>
                <label style={lbl}>Visit Type *</label>
                <select value={form.visit_type} onChange={e => fld('visit_type', e.target.value)} style={inp}>
                  {VISIT_TYPES.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Visit Date *</label>
                <input type="date" value={form.visit_date} onChange={e => fld('visit_date', e.target.value)} style={inp} />
              </div>
              <div>
                <label style={lbl}>Customer</label>
                <input value={form.customer_name} onChange={e => fld('customer_name', e.target.value)} placeholder="Customer name" style={inp} />
              </div>
              <div>
                <label style={lbl}>Project Number</label>
                <input value={form.project_number} onChange={e => fld('project_number', e.target.value)} placeholder="PRJ-2026-001" style={inp} />
              </div>
              <div>
                <label style={lbl}>Site Name</label>
                <input value={form.site_name} onChange={e => fld('site_name', e.target.value)} placeholder="Factory / site" style={inp} />
              </div>
              <div>
                <label style={lbl}>Opportunity Ref</label>
                <input value={form.opportunity_ref} onChange={e => fld('opportunity_ref', e.target.value)} placeholder="Opportunity reference" style={inp} />
              </div>
              <div>
                <label style={lbl}>Outcome</label>
                <select value={form.outcome} onChange={e => fld('outcome', e.target.value)} style={inp}>
                  {OUTCOMES.map(o => <option key={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Location / Address</label>
                <input value={form.location} onChange={e => fld('location', e.target.value)} placeholder="City or full address" style={inp} />
              </div>

              {/* GPS capture */}
              <div style={{ gridColumn: '1/-1', display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>GPS Latitude</label>
                  <input type="number" value={form.gps_lat} onChange={e => fld('gps_lat', e.target.value)} placeholder="e.g. 13.0827" style={inp} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={lbl}>GPS Longitude</label>
                  <input type="number" value={form.gps_lng} onChange={e => fld('gps_lng', e.target.value)} placeholder="e.g. 80.2707" style={inp} />
                </div>
                <button onClick={getCurrentPosition}
                  style={{ padding: '9px 14px', background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #ede9fe', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                  <MapPin size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />Capture GPS
                </button>
              </div>
            </div>

            {/* Discussion */}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Visit Content</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
              <div>
                <label style={lbl}>Purpose</label>
                <textarea value={form.purpose} onChange={e => fld('purpose', e.target.value)} rows={2}
                  placeholder="Why was this visit conducted?" style={{ ...inp, resize: 'vertical' }} />
              </div>
              <div>
                <label style={lbl}>Discussion Summary</label>
                <textarea value={form.discussion_summary} onChange={e => fld('discussion_summary', e.target.value)} rows={4}
                  placeholder="What was discussed? Key points, decisions, requirements raised..."
                  style={{ ...inp, resize: 'vertical' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div>
                  <label style={lbl}>Next Follow-up Date</label>
                  <input type="date" value={form.next_followup} onChange={e => fld('next_followup', e.target.value)} style={inp} />
                </div>
                <div>
                  <label style={lbl}>Follow-up Notes</label>
                  <input value={form.next_followup_notes} onChange={e => fld('next_followup_notes', e.target.value)}
                    placeholder="What needs to be done?" style={inp} />
                </div>
              </div>
            </div>

            {/* Action Items */}
            <div style={{ fontSize: 12, fontWeight: 700, color: '#6B3FDB', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Action Items</div>
            {form.action_items.map((ai, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', background: '#f9fafb', borderRadius: 8, marginBottom: 6 }}>
                <CheckCircle size={13} color="#10b981" />
                <span style={{ flex: 1, fontSize: 12, color: '#374151' }}>{ai.action}</span>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>{ai.owner}</span>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>{ai.due_date}</span>
                <button onClick={() => removeAction(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 0 }}><X size={13} /></button>
              </div>
            ))}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, marginBottom: 20 }}>
              <input value={newAction.action} onChange={e => setNewAction(p => ({ ...p, action: e.target.value }))}
                placeholder="Action item description..." style={inp} />
              <input value={newAction.owner} onChange={e => setNewAction(p => ({ ...p, owner: e.target.value }))}
                placeholder="Owner" style={inp} />
              <input type="date" value={newAction.due_date} onChange={e => setNewAction(p => ({ ...p, due_date: e.target.value }))} style={inp} />
              <button onClick={addAction}
                style={{ padding: '9px 14px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                Add
              </button>
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 8 }}>
              <button onClick={() => setShowForm(false)}
                style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151' }}>Cancel</button>
              <button onClick={handleSave} disabled={saving}
                style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Saving...' : 'Save Report'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
