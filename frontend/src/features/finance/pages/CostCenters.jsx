import { useState, useEffect } from 'react';
import { PlusCircle, Edit2, Trash2, TrendingUp, TrendingDown, BarChart2, ChevronRight } from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const fmt = v => `₹${parseFloat(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export default function CostCenters({ setPage }) {
  const [centers, setCenters] = useState([]);
  const [plSummary, setPlSummary] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ open: false, editing: null, code: '', name: '', description: '', parent_id: '' });
  const [error, setError] = useState('');
  const [tab, setTab] = useState('list'); // list | pl
  const [pendingDel, setPendingDel] = useState(null);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [ccRes, plRes] = await Promise.allSettled([
        api.get('/finance/cost-centers'),
        api.get('/finance/cost-centers/pl-summary'),
      ]);
      if (ccRes.status === 'fulfilled') setCenters(ccRes.value.data || []);
      if (plRes.status === 'fulfilled') setPlSummary(plRes.value.data?.cost_centers || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  function openCreate() {
    setForm({ open: true, editing: null, code: '', name: '', description: '', parent_id: '' });
  }

  function openEdit(cc) {
    setForm({ open: true, editing: cc.id, code: cc.code, name: cc.name, description: cc.description || '', parent_id: cc.parent_id || '' });
  }

  async function save() {
    setError('');
    try {
      if (form.editing) {
        await api.put(`/finance/cost-centers/${form.editing}`, { name: form.name, description: form.description, parent_id: form.parent_id || null });
      } else {
        await api.post('/finance/cost-centers', { code: form.code, name: form.name, description: form.description, parent_id: form.parent_id || null });
      }
      setForm({ open: false });
      loadAll();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  }

  async function del() {
    if (!pendingDel) return;
    const id = pendingDel;
    setPendingDel(null);
    try {
      await api.delete(`/finance/cost-centers/${id}`);
      loadAll();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  }

  return (
    <div style={{ padding: 24 }}>

      <ConfirmDialog
        open={!!pendingDel}
        title="Delete Cost Center"
        message="Delete this cost center? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={del}
        onCancel={() => setPendingDel(null)}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Cost Centers</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Manage cost centers for departmental P&L reporting
          </p>
        </div>
        <button onClick={openCreate}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
            background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <PlusCircle size={15}/> Add Cost Center
        </button>
      </div>

      {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {['list', 'pl'].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: '6px 16px', borderRadius: 6, border: '1px solid #e5e7eb', cursor: 'pointer', fontSize: 13,
              background: tab === t ? '#6366f1' : '#fff', color: tab === t ? '#fff' : '#374151', fontWeight: tab === t ? 600 : 400 }}>
            {t === 'list' ? 'Cost Centers' : 'P&L Summary'}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>
      ) : tab === 'list' ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Code</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Name</th>
              <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Description</th>
              <th style={{ padding: '10px 12px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>MTD Net</th>
              <th style={{ padding: '10px 12px', textAlign: 'center', borderBottom: '1px solid #e5e7eb' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {centers.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No cost centers configured</td></tr>
            ) : centers.map(cc => (
              <tr key={cc.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontWeight: 600, color: '#6366f1' }}>{cc.code}</td>
                <td style={{ padding: '10px 12px', fontWeight: 500 }}>{cc.name}</td>
                <td style={{ padding: '10px 12px', color: '#6b7280' }}>{cc.description || '—'}</td>
                <td style={{ padding: '10px 12px', textAlign: 'right', color: parseFloat(cc.mtd_net || 0) >= 0 ? '#059669' : '#dc2626', fontWeight: 500 }}>
                  {fmt(cc.mtd_net)}
                </td>
                <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                  <button onClick={() => openEdit(cc)}
                    style={{ padding: '4px 8px', marginRight: 6, background: '#eff6ff', color: '#3b82f6', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                    <Edit2 size={13}/>
                  </button>
                  <button onClick={() => setPendingDel(cc.id)}
                    style={{ padding: '4px 8px', background: '#fef2f2', color: '#ef4444', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                    <Trash2 size={13}/>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 14px' }}>Cost Center P&L — Current Financial Year</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                <th style={{ padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Cost Center</th>
                <th style={{ padding: '10px 12px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Income</th>
                <th style={{ padding: '10px 12px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Expense</th>
                <th style={{ padding: '10px 12px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Net P&L</th>
              </tr>
            </thead>
            <tbody>
              {plSummary.length === 0 ? (
                <tr><td colSpan={4} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No data — post journal entries with cost center codes to see P&L</td></tr>
              ) : plSummary.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 500 }}>{r.code} — {r.name}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#059669' }}>{fmt(r.income)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', color: '#dc2626' }}>{fmt(r.expense)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700,
                    color: parseFloat(r.net_profit || 0) >= 0 ? '#059669' : '#dc2626' }}>
                    {fmt(r.net_profit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form.open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setForm({ open: false })}>
          <div style={{ background: '#fff', padding: 28, borderRadius: 12, width: 420, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 20px', fontSize: 16 }}>{form.editing ? 'Edit' : 'Add'} Cost Center</h3>
            {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>{error}</div>}
            {!form.editing && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Code *</label>
                <input value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))}
                  placeholder="e.g. CC-MFG" style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}/>
              </div>
            )}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Name *</label>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Manufacturing" style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}/>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Description</label>
              <input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                placeholder="Optional description" style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}/>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Parent Cost Center</label>
              <select value={form.parent_id} onChange={e => setForm(p => ({ ...p, parent_id: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}>
                <option value="">— None (top level) —</option>
                {centers.filter(c => c.id !== form.editing).map(c => (
                  <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setForm({ open: false })}
                style={{ padding: '8px 16px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={save}
                style={{ padding: '8px 16px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {form.editing ? 'Save Changes' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
