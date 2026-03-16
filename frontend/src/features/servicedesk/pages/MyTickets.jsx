import { useState, useEffect, useCallback } from 'react';
import { Plus, Ticket, RefreshCw, X } from 'lucide-react';
import api from '@/services/api/client';

const priorityColor = p => {
  const m = (p || '').toLowerCase();
  if (m === 'critical') return { bg: '#fef2f2', color: '#7f1d1d' };
  if (m === 'high')     return { bg: '#fee2e2', color: '#dc2626' };
  if (m === 'medium')   return { bg: '#fef3c7', color: '#92400e' };
  return { bg: '#f0fdf4', color: '#15803d' };
};

const statusColor = s => {
  const m = (s || '').toLowerCase();
  if (m === 'open')        return { bg: '#eef2ff', color: '#4338ca' };
  if (m === 'in progress') return { bg: '#fef3c7', color: '#92400e' };
  if (m === 'resolved')    return { bg: '#f0fdf4', color: '#15803d' };
  return { bg: '#f3f4f6', color: '#6b7280' };
};

export default function MyTickets() {
  const [tickets,    setTickets]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [drawer,     setDrawer]     = useState(false);
  const [form,       setForm]       = useState({ title: '', description: '', category: '', priority: 'Medium' });
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/servicedesk/tickets/my');
      setTickets(r.data.tickets || []);
    } catch { setTickets([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    if (!form.title) return showToast('Title is required', 'error');
    setSubmitting(true);
    try {
      await api.post('/servicedesk/tickets', form);
      showToast('Ticket raised successfully');
      setDrawer(false);
      setForm({ title: '', description: '', category: '', priority: 'Medium' });
      load();
    } catch (e) { showToast(e.response?.data?.error || 'Failed to raise ticket', 'error'); }
    finally { setSubmitting(false); }
  };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>

      {toast && (
        <div style={{ position: 'fixed', top: 24, right: 24, zIndex: 9999, padding: '12px 20px',
          borderRadius: 10, background: toast.type === 'error' ? '#ef4444' : '#10b981',
          color: '#fff', fontWeight: 500, fontSize: 14, boxShadow: '0 4px 12px rgba(0,0,0,.15)' }}>
          {toast.msg}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>My Tickets</h2>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '2px 0 0' }}>{tickets.length} ticket{tickets.length !== 1 ? 's' : ''} raised by you</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', color: '#6b7280' }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={() => setDrawer(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            <Plus size={15} /> Raise Ticket
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200 }}>
          <div style={{ width: 28, height: 28, border: '3px solid #e5e7eb', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'mytkt-spin .7s linear infinite' }} />
        </div>
      ) : tickets.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 240, gap: 12, background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', color: '#9ca3af' }}>
          <Ticket size={40} color="#d1d5db" />
          <p style={{ margin: 0, fontSize: 14 }}>No tickets yet. Need help? Raise a ticket.</p>
          <button onClick={() => setDrawer(true)} style={{ padding: '8px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            + Raise Ticket
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {tickets.map(t => {
            const pc = priorityColor(t.priority);
            const sc = statusColor(t.status);
            return (
              <div key={t.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ background: '#eef2ff', width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Ticket size={18} color="#6366f1" />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#6366f1', fontWeight: 600 }}>{t.ticket_number}</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{t.title}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {t.category && <span style={{ fontSize: 11, color: '#6b7280' }}>{t.category}</span>}
                    {t.team && <span style={{ fontSize: 11, color: '#6b7280' }}>· {t.team}</span>}
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>· {t.created_at ? new Date(t.created_at).toLocaleDateString('en-IN') : '—'}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: pc.bg, color: pc.color }}>{t.priority}</span>
                  <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color }}>{t.status}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}
          onClick={() => setDrawer(false)}>
          <div style={{ background: '#fff', width: 420, height: '100vh', display: 'flex', flexDirection: 'column', boxShadow: '-8px 0 32px rgba(0,0,0,.12)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottom: '1px solid #f0f0f4' }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Raise a Support Ticket</h3>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
            </div>
            <div style={{ flex: 1, padding: 20, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
              {[
                { label: 'Title *', key: 'title', type: 'input', placeholder: 'Brief issue summary' },
                { label: 'Description', key: 'description', type: 'textarea', placeholder: 'Describe the issue' },
              ].map(f => (
                <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{f.label}</label>
                  {f.type === 'textarea' ? (
                    <textarea rows={4} placeholder={f.placeholder} value={form[f.key]}
                      onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, resize: 'none', outline: 'none', fontFamily: 'inherit' }} />
                  ) : (
                    <input placeholder={f.placeholder} value={form[f.key]}
                      onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                      style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none' }} />
                  )}
                </div>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Category</label>
                  <select value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                    style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', background: '#fff' }}>
                    <option value="">Select…</option>
                    {['IT Support','Finance','HR','CRM','System','Access','Performance','Documents'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Priority</label>
                  <select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}
                    style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px', fontSize: 13, outline: 'none', background: '#fff' }}>
                    {['Low','Medium','High','Critical'].map(x => <option key={x}>{x}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: '16px 20px', borderTop: '1px solid #f0f0f4', background: '#f9fafb' }}>
              <button onClick={() => setDrawer(false)} style={{ padding: '8px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSubmit} disabled={submitting}
                style={{ padding: '8px 16px', background: submitting ? '#9ca3af' : '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: submitting ? 'default' : 'pointer' }}>
                {submitting ? 'Submitting…' : 'Submit Ticket'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes mytkt-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
