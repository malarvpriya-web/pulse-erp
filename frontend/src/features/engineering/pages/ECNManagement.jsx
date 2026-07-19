import { useState, useEffect, useCallback } from 'react';
import { Plus, X, RefreshCw, Search, CheckCircle, XCircle, ArrowRight, Wrench, FileText, AlertTriangle } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const STATUS_META = {
  draft:       { label: 'Draft',       color: '#9ca3af', bg: '#f3f4f6' },
  submitted:   { label: 'Submitted',   color: '#3b82f6', bg: '#eff6ff' },
  approved:    { label: 'Approved',    color: '#10b981', bg: '#ecfdf5' },
  rejected:    { label: 'Rejected',    color: '#ef4444', bg: '#fef2f2' },
  implemented: { label: 'Implemented', color: '#8b5cf6', bg: '#f5f3ff' },
};

const SEVERITY_META = {
  low:      { color: '#10b981', bg: '#ecfdf5' },
  medium:   { color: '#f59e0b', bg: '#fffbeb' },
  high:     { color: '#f97316', bg: '#fff7ed' },
  critical: { color: '#ef4444', bg: '#fef2f2' },
};

const CHANGE_TYPES = ['ECN', 'ECR', 'Deviation', 'Waiver'];
const SEVERITIES   = ['low', 'medium', 'high', 'critical'];

function StatusPill({ status }) {
  const m = STATUS_META[status] || { label: status, color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: m.bg, color: m.color }}>
      {m.label}
    </span>
  );
}

function SeverityPill({ severity }) {
  const m = SEVERITY_META[severity] || { color: '#6b7280', bg: '#f3f4f6' };
  return (
    <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: m.bg, color: m.color }}>
      {(severity || '').toUpperCase()}
    </span>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={onClose}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: '95%', maxWidth: wide ? 680 : 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: '#111827', fontSize: 16, fontWeight: 700 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const EMPTY_FORM = {
  title: '', change_type: 'ECN', severity: 'medium',
  reason: '', impact_summary: '', owner_name: '', effective_from: '', implementation_due: '',
};

function CreateECNForm({ onSave, onCancel, saving }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }}>
      <label style={lbl}>Title *
        <input required value={form.title} onChange={e => set('title', e.target.value)}
          placeholder="e.g. Capacitor spec change — 1000µF → 1200µF"
          style={inp} />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={lbl}>Change Type
          <select value={form.change_type} onChange={e => set('change_type', e.target.value)} style={inp}>
            {CHANGE_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label style={lbl}>Severity
          <select value={form.severity} onChange={e => set('severity', e.target.value)} style={inp}>
            {SEVERITIES.map(s => <option key={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <label style={lbl}>Reason for Change *
        <textarea required rows={3} value={form.reason} onChange={e => set('reason', e.target.value)}
          placeholder="Why is this change needed? Reference supplier EOL, test failure, design improvement…"
          style={{ ...inp, resize: 'vertical' }} />
      </label>
      <label style={lbl}>Impact Summary
        <textarea rows={2} value={form.impact_summary} onChange={e => set('impact_summary', e.target.value)}
          placeholder="Which BOMs, assemblies, production runs are affected?"
          style={{ ...inp, resize: 'vertical' }} />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={lbl}>Owner Name
          <input value={form.owner_name} onChange={e => set('owner_name', e.target.value)}
            placeholder="Responsible engineer" style={inp} />
        </label>
        <label style={lbl}>Implementation Due
          <input type="date" value={form.implementation_due} onChange={e => set('implementation_due', e.target.value)} style={inp} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
        <button type="button" onClick={onCancel}
          style={{ padding: '8px 16px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
          Cancel
        </button>
        <button type="submit" disabled={saving}
          style={{ padding: '8px 20px', background: saving ? '#c4b5fd' : '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
          {saving ? 'Creating…' : 'Create ECN'}
        </button>
      </div>
    </form>
  );
}

function ECNDetail({ ecn, onClose, onRefresh }) {
  const toast = useToast();
  const [detail, setDetail]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting,  setActing]  = useState(false);
  const [remarks, setRemarks] = useState('');

  useEffect(() => {
    api.get(`/engineering/ecn/changes/${ecn.id}`)
      .then(r => setDetail(r.data))
      .catch(() => toast.error('Failed to load ECN detail'))
      .finally(() => setLoading(false));
  }, [ecn.id]);

  const doAction = async (action) => {
    setActing(true);
    try {
      await api.post(`/engineering/ecn/changes/${ecn.id}/${action}`, { remarks });
      toast.success(`ECN ${action}d`);
      setRemarks('');
      onRefresh();
      onClose();
    } catch (e) {
      toast.error(e?.response?.data?.error || `Action '${action}' failed`);
    } finally { setActing(false); }
  };

  const d = detail || ecn;

  return (
    <Modal title={`${d.ecn_number || 'ECN'} — ${d.title}`} onClose={onClose} wide>
      {loading ? (
        <div style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatusPill status={d.status} />
            <SeverityPill severity={d.severity} />
            <span style={{ fontSize: 12, color: '#6b7280', padding: '2px 8px', background: '#f3f4f6', borderRadius: 20 }}>{d.change_type}</span>
          </div>

          <div style={{ background: '#f9fafb', borderRadius: 8, padding: '12px 14px', marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Reason for Change</div>
            <div style={{ fontSize: 13, color: '#111827' }}>{d.reason || '—'}</div>
            {d.impact_summary && (
              <>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 10 }}>Impact</div>
                <div style={{ fontSize: 13, color: '#111827' }}>{d.impact_summary}</div>
              </>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16, fontSize: 12 }}>
            <div><span style={{ color: '#9ca3af' }}>Owner</span><br /><strong>{d.owner_name || '—'}</strong></div>
            <div><span style={{ color: '#9ca3af' }}>Requested By</span><br /><strong>{d.requested_by_name || '—'}</strong></div>
            <div><span style={{ color: '#9ca3af' }}>Due</span><br /><strong>{d.implementation_due ? new Date(d.implementation_due).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</strong></div>
          </div>

          {/* Approvals list */}
          {detail?.approvals?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Approvals</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {detail.approvals.map(a => (
                  <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#f9fafb', borderRadius: 6, fontSize: 12 }}>
                    <span style={{ fontWeight: 600 }}>{a.approver_name}</span>
                    <span style={{ color: a.status === 'approved' ? '#10b981' : a.status === 'rejected' ? '#ef4444' : '#9ca3af', fontWeight: 600 }}>
                      {a.status === 'approved' ? '✓ Approved' : a.status === 'rejected' ? '✕ Rejected' : '… Pending'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Workflow actions */}
          {(d.status === 'draft' || d.status === 'submitted' || d.status === 'approved') && (
            <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 16, marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Remarks / Notes</div>
              <textarea rows={2} value={remarks} onChange={e => setRemarks(e.target.value)}
                placeholder="Optional remarks for this action…"
                style={{ ...inp, resize: 'vertical', marginBottom: 12, width: '100%', boxSizing: 'border-box' }} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {d.status === 'draft' && (
                  <button onClick={() => doAction('submit')} disabled={acting}
                    style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                    <ArrowRight size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />Submit for Approval
                  </button>
                )}
                {d.status === 'submitted' && (
                  <>
                    <button onClick={() => doAction('approve')} disabled={acting}
                      style={{ padding: '7px 16px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                      <CheckCircle size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />Approve
                    </button>
                    <button onClick={() => doAction('reject')} disabled={acting}
                      style={{ padding: '7px 16px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                      <XCircle size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />Reject
                    </button>
                  </>
                )}
                {d.status === 'approved' && (
                  <button onClick={() => doAction('implement')} disabled={acting}
                    style={{ padding: '7px 16px', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                    <Wrench size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />Mark Implemented
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, marginTop: 14 };
const inp = { display: 'block', width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, fontFamily: 'inherit' };

export default function ECNManagement() {
  const toast = useToast();
  const [ecns,    setEcns]    = useState([]);
  const [loading, setLoading] = useState(false);
  const [search,  setSearch]  = useState('');
  const [statusF, setStatusF] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [selected,   setSelected]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusF) params.status = statusF;
      if (search)  params.search = search;
      const r = await api.get('/engineering/ecn/changes', { params });
      setEcns(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to load ECNs');
    } finally { setLoading(false); }
  }, [statusF, search]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (form) => {
    setSaving(true);
    try {
      await api.post('/engineering/ecn/changes', form);
      toast.success('ECN created');
      setShowCreate(false);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to create ECN');
    } finally { setSaving(false); }
  };

  const counts = Object.keys(STATUS_META).reduce((acc, k) => {
    acc[k] = ecns.filter(e => e.status === k).length;
    return acc;
  }, {});

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>Engineering Change Notices</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Manage ECNs, ECRs, and design deviations with full audit trail</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load}
            style={{ padding: '8px 14px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 5 }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
            <Plus size={14} /> New ECN
          </button>
        </div>
      </div>

      {/* Status pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <button onClick={() => setStatusF('')}
          style={{ padding: '4px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid #e5e7eb', background: !statusF ? '#6B3FDB' : '#fff', color: !statusF ? '#fff' : '#374151' }}>
          All <strong style={{ marginLeft: 4 }}>{ecns.length}</strong>
        </button>
        {Object.entries(STATUS_META).map(([k, m]) => (
          <button key={k} onClick={() => setStatusF(k)}
            style={{ padding: '4px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${m.color}30`, background: statusF === k ? m.color : '#fff', color: statusF === k ? '#fff' : m.color }}>
            {m.label} <strong style={{ marginLeft: 4 }}>{counts[k] || 0}</strong>
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by ECN number or title…"
          style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px 8px 30px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af' }}>
          <RefreshCw size={24} style={{ animation: 'spin 1s linear infinite' }} /><br />Loading…
        </div>
      ) : ecns.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af', background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4' }}>
          <FileText size={40} style={{ marginBottom: 12, opacity: 0.4 }} />
          <p style={{ margin: 0, fontWeight: 600 }}>No Engineering Change Notices</p>
          <p style={{ margin: '4px 0 16px', fontSize: 13 }}>{statusF || search ? 'No ECNs match the current filter.' : 'Create your first ECN to start managing design changes.'}</p>
          {!statusF && !search && (
            <button onClick={() => setShowCreate(true)}
              style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              + New ECN
            </button>
          )}
        </div>
      ) : (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['ECN #', 'Title', 'Type', 'Severity', 'Status', 'Owner', 'Due Date', 'Items', ''].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ecns.map(e => (
                <tr key={e.id} style={{ borderTop: '1px solid #f0f0f4' }}>
                  <td style={{ padding: '10px 14px', color: '#6B3FDB', fontWeight: 700, whiteSpace: 'nowrap' }}>{e.ecn_number}</td>
                  <td style={{ padding: '10px 14px', color: '#111827', maxWidth: 260 }}>
                    <div style={{ fontWeight: 500 }}>{e.title}</div>
                    {e.change_reason && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{e.change_reason?.slice(0, 60)}…</div>}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#6b7280' }}>{e.change_type}</td>
                  <td style={{ padding: '10px 14px' }}><SeverityPill severity={e.severity} /></td>
                  <td style={{ padding: '10px 14px' }}><StatusPill status={e.status} /></td>
                  <td style={{ padding: '10px 14px', color: '#374151' }}>{e.owner_name || '—'}</td>
                  <td style={{ padding: '10px 14px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                    {e.implementation_due ? new Date(e.implementation_due).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                    {e.implementation_due && new Date(e.implementation_due) < new Date() && e.status !== 'implemented' && (
                      <AlertTriangle size={11} style={{ marginLeft: 4, color: '#ef4444', verticalAlign: 'middle' }} />
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#6b7280' }}>{e.impacted_items || 0}</td>
                  <td style={{ padding: '10px 14px' }}>
                    <button onClick={() => setSelected(e)}
                      style={{ padding: '4px 12px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <Modal title="New Engineering Change Notice" onClose={() => setShowCreate(false)} wide>
          <CreateECNForm onSave={handleCreate} onCancel={() => setShowCreate(false)} saving={saving} />
        </Modal>
      )}

      {selected && (
        <ECNDetail ecn={selected} onClose={() => setSelected(null)} onRefresh={load} />
      )}
    </div>
  );
}
