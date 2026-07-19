import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, RefreshCw, AlertCircle, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const inp = { background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, width: '100%', color: 'var(--color-text-primary)' };

const BLANK_DEF = { name: '', description: '', weightage: 100, department: '', role_level: '' };

export default function KRAManagement() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid these controls from anyone holding manager/hr
  // as a secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isHR  = hasAnyRole('hr', 'super_admin', 'admin');
  const isMgr = hasAnyRole('manager', 'hr', 'super_admin', 'admin');

  const [tab, setTab]           = useState('definitions');
  const [defs, setDefs]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId]     = useState(null);
  const [form, setForm]         = useState(BLANK_DEF);
  const [saving, setSaving]     = useState(false);
  const [analytics, setAnalytics] = useState([]);
  const [pendingDeactivate, setPendingDeactivate] = useState(null);
  const [deptList, setDeptList] = useState([]);

  async function loadDefs() {
    setLoading(true);
    try {
      const res = await api.get('/performance/kras/definitions');
      setDefs(res.data || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  async function loadAnalytics() {
    try {
      const res = await api.get('/performance/kras/analytics/summary');
      setAnalytics(res.data || []);
    } catch { /* non-fatal */ }
  }

  useEffect(() => {
    loadDefs();
    loadAnalytics();
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  function openNew()   { setForm(BLANK_DEF); setEditId(null); setShowForm(true); }
  function openEdit(d) { setForm({ name: d.name, description: d.description || '', weightage: d.weightage, department: d.department || '', role_level: d.role_level || '' }); setEditId(d.id); setShowForm(true); }

  async function save() {
    if (!form.name) return;
    setSaving(true);
    try {
      if (editId) await api.patch(`/performance/kras/definitions/${editId}`, form);
      else        await api.post('/performance/kras/definitions', form);
      setShowForm(false);
      loadDefs();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  async function deactivate() {
    if (!pendingDeactivate) return;
    const id = pendingDeactivate;
    setPendingDeactivate(null);
    try { await api.delete(`/performance/kras/definitions/${id}`); loadDefs(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div style={{ padding: 24 }}>

      <ConfirmDialog
        open={!!pendingDeactivate}
        title="Deactivate KRA"
        message="Deactivate this KRA definition?"
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={deactivate}
        onCancel={() => setPendingDeactivate(null)}
      />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--color-text-primary)' }}>KRA Framework</h1>
        {isHR && (
          <button onClick={openNew} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={15} /> New KRA
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid var(--color-border-tertiary)' }}>
        {['definitions', 'analytics'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 20px', border: 'none', background: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: tab === t ? 600 : 400,
            color: tab === t ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            borderBottom: tab === t ? '2px solid var(--color-primary)' : '2px solid transparent',
            marginBottom: -1, textTransform: 'capitalize',
          }}>{t}</button>
        ))}
      </div>

      {error && (
        <div style={{ background: '#ef444418', color: '#ef4444', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertCircle size={15} /> {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><X size={14} /></button>
        </div>
      )}

      {tab === 'definitions' && (
        <>
          {showForm && (
            <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 12, padding: 20, marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 16px' }}>{editId ? 'Edit KRA Definition' : 'New KRA Definition'}</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Name *</label><input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Revenue Achievement" /></div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Weightage (%)</label><input type="number" style={inp} value={form.weightage} onChange={e => setForm(f => ({ ...f, weightage: e.target.value }))} /></div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Department</label>
                  <select style={inp} value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))}>
                    <option value="">All Departments</option>
                    {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Role Level</label>
                <select style={inp} value={form.role_level} onChange={e => setForm(f => ({ ...f, role_level: e.target.value }))}>
                  <option value="">-- All Levels --</option>
                  {['Junior','Mid-Level','Senior','Lead','Manager','Senior Manager','Director','VP','C-Level'].map(l => <option key={l} value={l}>{l}</option>)}
                </select></div>
                <div style={{ gridColumn: '1 / -1' }}><label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Description</label><textarea style={{ ...inp, resize: 'vertical', minHeight: 56 }} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What does this KRA measure?" /></div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button onClick={save} disabled={saving} style={{ padding: '8px 20px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{saving ? 'Saving...' : editId ? 'Update' : 'Create'}</button>
                <button onClick={() => setShowForm(false)} style={{ padding: '8px 20px', background: 'var(--color-background)', border: '1px solid var(--color-border-tertiary)', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </div>
          )}

          {loading ? (
            <div style={{ textAlign: 'center', padding: 48, color: 'var(--color-text-secondary)' }}><RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} /></div>
          ) : defs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
              <p style={{ margin: 0, fontWeight: 500 }}>No KRA definitions yet</p>
              <p style={{ margin: '4px 0 0', fontSize: 13 }}>Create KRA templates that managers can assign to employees during reviews</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {defs.map(d => (
                <div key={d.id} style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: '14px 18px', display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: '0 0 4px', fontWeight: 600, fontSize: 14, color: 'var(--color-text-primary)' }}>{d.name}</p>
                    {d.description && <p style={{ margin: '0 0 4px', fontSize: 13, color: 'var(--color-text-secondary)' }}>{d.description}</p>}
                    <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                      <span>Weightage: <strong style={{ color: 'var(--color-text-primary)' }}>{d.weightage}%</strong></span>
                      {d.department && <span>Dept: {d.department}</span>}
                      {d.role_level && <span>Level: {d.role_level}</span>}
                    </div>
                  </div>
                  {isHR && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => openEdit(d)} style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><Edit2 size={14} /></button>
                      <button onClick={() => setPendingDeactivate(d.id)} style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444' }}><Trash2 size={14} /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'analytics' && (
        <div>
          {analytics.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 48, background: 'var(--color-background-secondary)', borderRadius: 12, border: '0.5px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
              <p style={{ margin: 0 }}>No KRA scores yet</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border-tertiary)' }}>
                    {['Department', 'Employees with KRAs', 'Total KRAs', 'Avg KRA Score', 'Avg Weightage'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {analytics.map((a, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 500 }}>{a.department || '—'}</td>
                      <td style={{ padding: '10px 12px' }}>{a.employees_with_kras}</td>
                      <td style={{ padding: '10px 12px' }}>{a.total_kras}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {a.avg_kra_score ? (
                          <span style={{ background: '#10b98118', color: '#10b981', padding: '2px 8px', borderRadius: 12, fontWeight: 600, fontSize: 12 }}>{a.avg_kra_score}</span>
                        ) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px' }}>{a.avg_weightage ? `${a.avg_weightage}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
