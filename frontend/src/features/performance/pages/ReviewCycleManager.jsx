import { useState, useEffect } from 'react';
import { Plus, Play, X, Edit2, RefreshCw, ChevronDown, ChevronUp, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const STATUS_COLOR = {
  draft: { bg: '#f59e0b18', text: '#f59e0b' },
  active: { bg: '#10b98118', text: '#10b981' },
  calibration: { bg: '#3b82f618', text: '#3b82f6' },
  closed: { bg: '#6b728018', text: '#6b7280' },
};

function Badge({ status }) {
  const c = STATUS_COLOR[status] || STATUS_COLOR.draft;
  return (
    <span style={{ background: c.bg, color: c.text, padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600, textTransform: 'uppercase' }}>
      {status}
    </span>
  );
}

const BLANK = {
  name: '', cycle_type: 'annual', review_period: '', financial_year: '',
  start_date: '', end_date: '',
  self_review_deadline: '', manager_review_deadline: '', calibration_deadline: '',
  l2_review_enabled: false, hr_review_enabled: true, description: '',
};

export default function ReviewCycleManager() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid these controls from anyone holding hr as a
  // secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isHR = hasAnyRole('hr', 'super_admin', 'admin');

  const [cycles, setCycles]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  const [form, setForm]         = useState(BLANK);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState(null);
  const [expanded, setExpanded] = useState({});
  const [pendingClose, setPendingClose] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get('/performance/cycles');
      setCycles(res.data || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function openNew() { setForm(BLANK); setEditing(null); setShowForm(true); }
  function openEdit(c) {
    setForm({
      name: c.name || '', cycle_type: c.cycle_type || 'annual',
      review_period: c.review_period || '', financial_year: c.financial_year || '',
      start_date: c.start_date?.slice(0, 10) || '', end_date: c.end_date?.slice(0, 10) || '',
      self_review_deadline: c.self_review_deadline?.slice(0, 10) || '',
      manager_review_deadline: c.manager_review_deadline?.slice(0, 10) || '',
      calibration_deadline: c.calibration_deadline?.slice(0, 10) || '',
      l2_review_enabled: c.l2_review_enabled || false,
      hr_review_enabled: c.hr_review_enabled ?? true,
      description: c.description || '',
    });
    setEditing(c.id);
    setShowForm(true);
  }

  async function save() {
    if (!form.name || !form.review_period) return;
    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/performance/cycles/${editing}`, form);
      } else {
        await api.post('/performance/cycles', form);
      }
      setShowForm(false);
      load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function activate(id) {
    try { await api.post(`/performance/cycles/${id}/activate`); load(); }
    catch (e) { setError(e.message); }
  }

  async function close() {
    if (!pendingClose) return;
    const id = pendingClose;
    setPendingClose(null);
    try { await api.post(`/performance/cycles/${id}/close`); load(); }
    catch (e) { setError(e.message); }
  }

  const inp = { background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%', color: 'var(--color-text-primary)' };

  return (
    <div style={{ padding: 24, margin: '0 auto' }}>

      <ConfirmDialog
        open={!!pendingClose}
        title="Close Review Cycle"
        message="Close this review cycle? This cannot be undone."
        confirmLabel="Close"
        variant="warning"
        onConfirm={close}
        onCancel={() => setPendingClose(null)}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--color-text-primary)' }}>Review Cycle Manager</h1>
        {isHR && (
          <button onClick={openNew} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
            background: 'var(--color-primary)', color: '#fff', border: 'none',
            borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}>
            <Plus size={15} /> New Cycle
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: '#ef444418', color: '#ef4444', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={15} /> {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><X size={14} /></button>
        </div>
      )}

      {/* Create/Edit Form */}
      {showForm && (
        <div style={{
          background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)',
          borderRadius: 'var(--border-radius-lg)', padding: 24, marginBottom: 24,
        }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 20px', color: 'var(--color-text-primary)' }}>
            {editing ? 'Edit Cycle' : 'New Review Cycle'}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Cycle Name *</label>
              <input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Annual Review FY 2026-27" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Type</label>
              <select style={inp} value={form.cycle_type} onChange={e => setForm(f => ({ ...f, cycle_type: e.target.value }))}>
                {['annual', 'half_yearly', 'quarterly', 'project', 'probation'].map(t => (
                  <option key={t} value={t}>{t.replace('_', ' ')}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Review Period *</label>
              <input style={inp} value={form.review_period} onChange={e => setForm(f => ({ ...f, review_period: e.target.value }))} placeholder="e.g. FY 2026-27" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Financial Year</label>
              <input style={inp} value={form.financial_year} onChange={e => setForm(f => ({ ...f, financial_year: e.target.value }))} placeholder="e.g. 2026-27" />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Start Date</label>
              <input type="date" style={inp} value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>End Date</label>
              <input type="date" style={inp} value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Self Review Deadline</label>
              <input type="date" style={inp} value={form.self_review_deadline} onChange={e => setForm(f => ({ ...f, self_review_deadline: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Manager Review Deadline</label>
              <input type="date" style={inp} value={form.manager_review_deadline} onChange={e => setForm(f => ({ ...f, manager_review_deadline: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Calibration Deadline</label>
              <input type="date" style={inp} value={form.calibration_deadline} onChange={e => setForm(f => ({ ...f, calibration_deadline: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', paddingTop: 20 }}>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.l2_review_enabled} onChange={e => setForm(f => ({ ...f, l2_review_enabled: e.target.checked }))} />
                L2 Review Enabled
              </label>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.hr_review_enabled} onChange={e => setForm(f => ({ ...f, hr_review_enabled: e.target.checked }))} />
                HR Review Enabled
              </label>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Description</label>
              <textarea style={{ ...inp, resize: 'vertical', minHeight: 60 }} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional description" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button onClick={save} disabled={saving} style={{
              padding: '8px 20px', background: 'var(--color-primary)', color: '#fff',
              border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}>{saving ? 'Saving...' : editing ? 'Update' : 'Create'}</button>
            <button onClick={() => setShowForm(false)} style={{
              padding: '8px 20px', background: 'var(--color-background)',
              border: '1px solid var(--color-border-tertiary)', borderRadius: 8,
              cursor: 'pointer', fontSize: 13, color: 'var(--color-text-secondary)',
            }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Cycles List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--color-text-secondary)' }}>
          <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} /> Loading...
        </div>
      ) : cycles.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)' }}>
          <Clock size={36} style={{ marginBottom: 12, color: 'var(--color-text-tertiary)' }} />
          <p style={{ margin: 0, fontWeight: 500 }}>No review cycles yet</p>
          <p style={{ margin: '4px 0 0', fontSize: 13 }}>Create a cycle to start managing performance reviews</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cycles.map(c => (
            <div key={c.id} style={{
              background: 'var(--color-background-secondary)',
              border: '0.5px solid var(--color-border-tertiary)',
              borderRadius: 'var(--border-radius-lg)', overflow: 'hidden',
            }}>
              <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer' }}
                onClick={() => setExpanded(e => ({ ...e, [c.id]: !e[c.id] }))}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>{c.name}</span>
                    <Badge status={c.status} />
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{c.cycle_type}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2, display: 'flex', gap: 16 }}>
                    <span>Period: {c.review_period}</span>
                    <span>Reviews: {c.review_count} ({c.completed_count} completed)</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  {isHR && c.status === 'draft' && (
                    <button onClick={e => { e.stopPropagation(); activate(c.id); }} style={{
                      padding: '5px 12px', background: '#10b981', color: '#fff',
                      border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600,
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}>
                      <Play size={12} /> Activate
                    </button>
                  )}
                  {isHR && c.status !== 'closed' && c.status !== 'draft' && (
                    <button onClick={e => { e.stopPropagation(); setPendingClose(c.id); }} style={{
                      padding: '5px 12px', background: '#6b728018', color: '#6b7280',
                      border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                    }}>
                      Close
                    </button>
                  )}
                  {isHR && c.status !== 'closed' && (
                    <button onClick={e => { e.stopPropagation(); openEdit(c); }} style={{
                      padding: 6, background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--color-text-secondary)',
                    }}>
                      <Edit2 size={14} />
                    </button>
                  )}
                  {expanded[c.id] ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </div>

              {expanded[c.id] && (
                <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', padding: '16px 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 }}>
                  {[
                    { label: 'Self Review Deadline', value: c.self_review_deadline?.slice(0, 10) },
                    { label: 'Manager Review Deadline', value: c.manager_review_deadline?.slice(0, 10) },
                    { label: 'Calibration Deadline', value: c.calibration_deadline?.slice(0, 10) },
                    { label: 'Start Date', value: c.start_date?.slice(0, 10) },
                    { label: 'End Date', value: c.end_date?.slice(0, 10) },
                    { label: 'Financial Year', value: c.financial_year },
                    { label: 'L2 Review', value: c.l2_review_enabled ? 'Enabled' : 'Disabled' },
                    { label: 'HR Review', value: c.hr_review_enabled ? 'Enabled' : 'Disabled' },
                  ].map(d => d.value && (
                    <div key={d.label}>
                      <p style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: '0 0 2px' }}>{d.label}</p>
                      <p style={{ fontSize: 13, fontWeight: 500, margin: 0, color: 'var(--color-text-primary)' }}>{d.value}</p>
                    </div>
                  ))}
                  {c.description && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <p style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: '0 0 2px' }}>Description</p>
                      <p style={{ fontSize: 13, margin: 0, color: 'var(--color-text-primary)' }}>{c.description}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
