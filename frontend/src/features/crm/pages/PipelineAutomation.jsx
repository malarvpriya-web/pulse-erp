import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 24px', textAlign: 'center', gap: 8,
      background: 'var(--color-background-secondary, #f9f9fc)',
      borderRadius: 12,
      border: '0.5px solid var(--color-border-tertiary, #e9e4ff)',
    }}>
      {Icon && <Icon size={36} style={{ color: '#9ca3af', marginBottom: 4 }} />}
      <p style={{ fontSize: 15, fontWeight: 500, color: '#111', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>{sub}</p>}
      {action}
    </div>
  );
}

// ─── Shared style tokens ──────────────────────────────────────────────────────
const S = {
  card: {
    background: '#fff',
    border: '1px solid #f0f0f4',
    borderRadius: 12,
    padding: '20px 24px',
    marginBottom: 16,
  },
  btn: {
    background: '#6B3FDB',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '8px 16px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },
  btnGhost: {
    background: '#f5f3ff',
    color: '#6B3FDB',
    border: '1px solid #e9e4ff',
    borderRadius: 8,
    padding: '7px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },
  btnDanger: {
    background: '#fff',
    color: '#ef4444',
    border: '1px solid #fecaca',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  input: {
    border: '1px solid #e9e4ff',
    borderRadius: 8,
    padding: '8px 12px',
    fontSize: 13,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  },
  label: {
    fontSize: 12,
    fontWeight: 600,
    color: '#6b7280',
    marginBottom: 4,
    display: 'block',
  },
  th: {
    textAlign: 'left',
    padding: '10px 14px',
    fontSize: 12,
    fontWeight: 700,
    color: '#6b7280',
    borderBottom: '1px solid #f0f0f4',
    background: '#fafafa',
  },
  td: {
    padding: '11px 14px',
    fontSize: 13,
    color: '#374151',
    borderBottom: '1px solid #f0f0f4',
    verticalAlign: 'middle',
  },
};

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 16px', marginBottom: 16, color: '#166534', fontSize: 13 }}>
      {msg}
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#fff', borderRadius: 14, width: 480, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.18)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f0f0f4' }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: '20px 24px' }}>{children}</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1 — Pipeline Stages
// ═══════════════════════════════════════════════════════════════════════════════
function PipelineStagesTab() {
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newProb, setNewProb] = useState('');
  const [newColor, setNewColor] = useState('#8b5cf6');
  const [dragIdx, setDragIdx] = useState(null);
  const [toast, setToast] = useState('');
  const [pendingDeleteStage, setPendingDeleteStage] = useState(null);
  const toastTimer = useRef(null);

  const showToast = msg => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/crm/pipeline-stages');
      setStages(res.data?.data ?? res.data?.stages ?? []);
    } catch {
      setStages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDragStart = (e, idx) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, idx) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    const updated = [...stages];
    const [moved] = updated.splice(dragIdx, 1);
    updated.splice(idx, 0, moved);
    setDragIdx(idx);
    setStages(updated.map((s, i) => ({ ...s, sort_order: i + 1 })));
  };

  const handleDrop = e => { e.preventDefault(); setDragIdx(null); };

  const saveOrder = async () => {
    setSaving(true);
    try {
      await api.put('/crm/pipeline-stages/reorder', { ordered_ids: stages.map(s => s.id) });
      showToast('Stage order saved');
    } catch {
      showToast('Order saved locally (API unavailable)');
    } finally {
      setSaving(false);
    }
  };

  const addStage = async () => {
    if (!newName.trim()) return;
    const prob = Math.min(100, Math.max(0, parseInt(newProb) || 0));
    const payload = { name: newName.trim(), probability: prob, color: newColor };
    try {
      const res = await api.post('/crm/pipeline-stages', payload);
      setStages(prev => [...prev, res.data?.data ?? res.data]);
    } catch {
      setStages(prev => [...prev, { id: Date.now(), ...payload, sort_order: stages.length + 1 }]);
    }
    setNewName(''); setNewProb(''); setNewColor('#8b5cf6'); setShowAdd(false);
    showToast(`Stage "${payload.name}" added`);
  };

  const deleteStage = async () => {
    if (!pendingDeleteStage) return;
    const { id, name } = pendingDeleteStage;
    setPendingDeleteStage(null);
    try {
      await api.delete(`/crm/pipeline-stages/${id}`);
      setStages(prev => prev.filter(s => s.id !== id));
      showToast(`Stage "${name}" deleted`);
    } catch (err) {
      const msg = err?.response?.data?.error || 'Delete failed';
      showToast(msg);
    }
  };

  if (loading) return <div style={{ padding: 40, color: '#9ca3af', textAlign: 'center' }}>Loading stages…</div>;

  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeleteStage}
        title="Delete Stage"
        message={pendingDeleteStage ? `Delete stage "${pendingDeleteStage.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteStage}
        onCancel={() => setPendingDeleteStage(null)}
      />
      <Toast msg={toast} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>Pipeline Stages</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Drag to reorder. Changes affect all pipelines.</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button style={S.btnGhost} onClick={() => setShowAdd(v => !v)}>+ Add Stage</button>
          <button style={{ ...S.btn, opacity: saving ? 0.7 : 1 }} onClick={saveOrder} disabled={saving}>
            {saving ? 'Saving…' : 'Save Order'}
          </button>
        </div>
      </div>

      {showAdd && (
        <div style={{ ...S.card, background: '#fafaff', border: '1px solid #e9e4ff', marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 14px', fontSize: 14, fontWeight: 700, color: '#6B3FDB' }}>New Stage</h4>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 80px', gap: 12, marginBottom: 14 }}>
            <div>
              <label style={S.label}>Stage Name</label>
              <input style={S.input} value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Discovery" />
            </div>
            <div>
              <label style={S.label}>Probability %</label>
              <input style={S.input} type="number" min="0" max="100" value={newProb} onChange={e => setNewProb(e.target.value)} placeholder="0–100" />
            </div>
            <div>
              <label style={S.label}>Color</label>
              <input style={{ ...S.input, padding: '4px 8px', height: 38 }} type="color" value={newColor} onChange={e => setNewColor(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={S.btn} onClick={addStage}>Add Stage</button>
            <button style={S.btnGhost} onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {stages.length === 0 ? (
        <EmptyState title="No stages configured" sub="Add your first pipeline stage above" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stages.map((stage, idx) => (
            <div
              key={stage.id}
              draggable
              onDragStart={e => handleDragStart(e, idx)}
              onDragOver={e => handleDragOver(e, idx)}
              onDrop={handleDrop}
              style={{
                ...S.card, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 14,
                cursor: 'grab', opacity: dragIdx === idx ? 0.5 : 1,
                transition: 'opacity 0.15s, box-shadow 0.15s',
                boxShadow: dragIdx === idx ? '0 4px 20px rgba(107,63,219,0.18)' : 'none',
              }}
            >
              <span style={{ color: '#9ca3af', fontSize: 18, cursor: 'grab', userSelect: 'none', flexShrink: 0 }}>⣿</span>
              <span style={{ width: 14, height: 14, borderRadius: '50%', background: stage.color, flexShrink: 0, border: '2px solid rgba(0,0,0,0.08)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#111' }}>{stage.name}</div>
                <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                  {stage.is_won && <span style={{ background: '#dcfce7', color: '#166534', borderRadius: 6, padding: '1px 8px', fontSize: 11, fontWeight: 700, marginRight: 6 }}>WON</span>}
                  {stage.is_lost && <span style={{ background: '#fee2e2', color: '#991b1b', borderRadius: 6, padding: '1px 8px', fontSize: 11, fontWeight: 700, marginRight: 6 }}>LOST</span>}
                  Stage key: {stage.stage_key}
                </div>
              </div>
              <div style={{ textAlign: 'center', minWidth: 60 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: stage.color }}>{stage.probability}%</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>probability</div>
              </div>
              <div style={{ background: '#f5f3ff', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 700, color: '#6B3FDB', minWidth: 60, textAlign: 'center' }}>
                #{idx + 1}
              </div>
              {!stage.is_won && !stage.is_lost && (
                <button style={S.btnDanger} onClick={() => setPendingDeleteStage({ id: stage.id, name: stage.name })}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16, padding: '12px 16px', background: '#f5f3ff', borderRadius: 8, fontSize: 12, color: '#6B3FDB' }}>
        ⣿ Drag the handle on the left to reorder. Click "Save Order" to persist changes.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2 — Lead Scoring
// ═══════════════════════════════════════════════════════════════════════════════
const SCORING_FIELDS = ['source', 'industry', 'email', 'phone', 'company', 'job_title'];
const SCORING_OPERATORS = ['equals', 'contains', 'is_set', 'not_set'];

function LeadScoringTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editRule, setEditRule] = useState(null);
  const [form, setForm] = useState({ field: 'source', operator: 'equals', value: '', score_delta: 10 });
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  const showToast = msg => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/crm/lead-scoring-rules');
      setRules(res.data?.data ?? []);
    } catch { setRules([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setEditRule(null); setForm({ field: 'source', operator: 'equals', value: '', score_delta: 10 }); setShowModal(true); };
  const openEdit = rule => { setEditRule(rule); setForm({ field: rule.field, operator: rule.operator, value: rule.value || '', score_delta: rule.score_delta }); setShowModal(true); };

  const save = async () => {
    try {
      if (editRule) {
        const res = await api.put(`/crm/lead-scoring-rules/${editRule.id}`, form);
        setRules(prev => prev.map(r => r.id === editRule.id ? (res.data?.data ?? res.data) : r));
      } else {
        const res = await api.post('/crm/lead-scoring-rules', form);
        setRules(prev => [...prev, res.data?.data ?? res.data]);
      }
    } catch {
      if (editRule) {
        setRules(prev => prev.map(r => r.id === editRule.id ? { ...r, ...form } : r));
      } else {
        setRules(prev => [...prev, { id: Date.now(), ...form, is_active: true }]);
      }
    }
    showToast(editRule ? 'Rule updated' : 'Rule added');
    setShowModal(false);
  };

  const toggleActive = async rule => {
    const updated = { ...rule, is_active: !rule.is_active };
    try { await api.put(`/crm/lead-scoring-rules/${rule.id}`, { is_active: updated.is_active }); } catch { /* local */ }
    setRules(prev => prev.map(r => r.id === rule.id ? updated : r));
  };

  const deleteRule = async (id) => {
    try { await api.delete(`/crm/lead-scoring-rules/${id}`); } catch { /* local */ }
    setRules(prev => prev.filter(r => r.id !== id));
    showToast('Rule deleted');
  };

  if (loading) return <div style={{ padding: 40, color: '#9ca3af', textAlign: 'center' }}>Loading rules…</div>;

  return (
    <div>
      <Toast msg={toast} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>Lead Scoring Rules</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Rules auto-calculate a score (0–100) when a lead is created or updated.</p>
        </div>
        <button style={S.btn} onClick={openAdd}>+ Add Rule</button>
      </div>

      {rules.length === 0 ? (
        <EmptyState title="No scoring rules" sub="Add rules to automatically score incoming leads" action={<button style={S.btn} onClick={openAdd}>+ Add First Rule</button>} />
      ) : (
        <div style={S.card}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['Field', 'Operator', 'Value', 'Score Δ', 'Active', 'Actions'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rules.map((rule, idx) => (
                <tr key={rule.id} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ ...S.td, fontWeight: 700, textTransform: 'capitalize' }}>{rule.field}</td>
                  <td style={S.td}><span style={{ background: '#f0f0f4', borderRadius: 6, padding: '2px 8px', fontSize: 11 }}>{rule.operator}</span></td>
                  <td style={{ ...S.td, color: '#6b7280' }}>{rule.value || <em style={{ color: '#d1d5db' }}>any</em>}</td>
                  <td style={S.td}>
                    <span style={{ fontWeight: 800, fontSize: 14, color: rule.score_delta >= 0 ? '#059669' : '#dc2626' }}>
                      {rule.score_delta >= 0 ? '+' : ''}{rule.score_delta}
                    </span>
                  </td>
                  <td style={S.td}>
                    <button onClick={() => toggleActive(rule)} style={{ background: rule.is_active ? '#dcfce7' : '#f3f4f6', color: rule.is_active ? '#166534' : '#9ca3af', border: 'none', borderRadius: 12, padding: '3px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      {rule.is_active ? 'Active' : 'Off'}
                    </button>
                  </td>
                  <td style={S.td}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button style={S.btnGhost} onClick={() => openEdit(rule)}>Edit</button>
                      <button style={S.btnDanger} onClick={() => deleteRule(rule.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal title={editRule ? 'Edit Rule' : 'Add Scoring Rule'} onClose={() => setShowModal(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={S.label}>Field</label>
              <select style={S.input} value={form.field} onChange={e => setForm(f => ({ ...f, field: e.target.value }))}>
                {SCORING_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Operator</label>
              <select style={S.input} value={form.operator} onChange={e => setForm(f => ({ ...f, operator: e.target.value }))}>
                {SCORING_OPERATORS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            {!['is_set', 'not_set'].includes(form.operator) && (
              <div>
                <label style={S.label}>Value</label>
                <input style={S.input} value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} placeholder="e.g. Referral" />
              </div>
            )}
            <div>
              <label style={S.label}>Score Delta (use negative for penalty)</label>
              <input style={S.input} type="number" min="-100" max="100" value={form.score_delta} onChange={e => setForm(f => ({ ...f, score_delta: parseInt(e.target.value) || 0 }))} />
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button style={S.btn} onClick={save}>{editRule ? 'Update' : 'Add Rule'}</button>
              <button style={S.btnGhost} onClick={() => setShowModal(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3 — Auto-Assignment
// ═══════════════════════════════════════════════════════════════════════════════
function AutoAssignmentTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editRule, setEditRule] = useState(null);
  const [form, setForm] = useState({ name: '', condition_field: 'source', condition_value: '', assign_to_name: '', priority: 10, is_active: true });
  const [toast, setToast] = useState('');
  const [pendingDeleteRule, setPendingDeleteRule] = useState(null);
  const toastTimer = useRef(null);

  const showToast = msg => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/crm/assignment-rules');
      setRules(res.data?.data ?? []);
    } catch { setRules([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => { setEditRule(null); setForm({ name: '', condition_field: 'source', condition_value: '', assign_to_name: '', priority: 10, is_active: true }); setShowModal(true); };
  const openEdit = rule => { setEditRule(rule); setForm({ name: rule.name, condition_field: rule.condition_field, condition_value: rule.condition_value, assign_to_name: rule.assign_to_name, priority: rule.priority, is_active: rule.is_active }); setShowModal(true); };

  const save = async () => {
    if (!form.name.trim()) return;
    try {
      if (editRule) {
        const res = await api.put(`/crm/assignment-rules/${editRule.id}`, form);
        setRules(prev => prev.map(r => r.id === editRule.id ? (res.data?.data ?? res.data) : r));
      } else {
        const res = await api.post('/crm/assignment-rules', form);
        setRules(prev => [...prev, res.data?.data ?? res.data].sort((a, b) => a.priority - b.priority));
      }
    } catch {
      if (editRule) {
        setRules(prev => prev.map(r => r.id === editRule.id ? { ...r, ...form } : r));
      } else {
        setRules(prev => [...prev, { id: Date.now(), ...form }].sort((a, b) => a.priority - b.priority));
      }
    }
    showToast(editRule ? 'Rule updated' : 'Rule added');
    setShowModal(false);
  };

  const deleteRule = async () => {
    if (!pendingDeleteRule) return;
    const { id } = pendingDeleteRule;
    setPendingDeleteRule(null);
    try { await api.delete(`/crm/assignment-rules/${id}`); } catch { /* local */ }
    setRules(prev => prev.filter(r => r.id !== id));
    showToast('Rule deleted');
  };

  const toggleActive = async rule => {
    const updated = { ...rule, is_active: !rule.is_active };
    try { await api.put(`/crm/assignment-rules/${rule.id}`, { is_active: updated.is_active }); } catch { /* local */ }
    setRules(prev => prev.map(r => r.id === rule.id ? updated : r));
  };

  if (loading) return <div style={{ padding: 40, color: '#9ca3af', textAlign: 'center' }}>Loading rules…</div>;

  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeleteRule}
        title="Delete Rule"
        message={pendingDeleteRule ? `Delete rule "${pendingDeleteRule.name}"?` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteRule}
        onCancel={() => setPendingDeleteRule(null)}
      />
      <Toast msg={toast} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>Auto-Assignment Rules</h3>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Evaluated top-down by priority. First matching rule wins.</p>
        </div>
        <button style={S.btn} onClick={openAdd}>+ Add Rule</button>
      </div>

      {rules.length === 0 ? (
        <EmptyState title="No assignment rules" sub="Add rules to auto-assign leads to sales reps" action={<button style={S.btn} onClick={openAdd}>+ Add First Rule</button>} />
      ) : (
        <div style={S.card}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>{['Priority', 'Rule Name', 'Condition Field', 'Condition Value', 'Assign To', 'Status', 'Actions'].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rules.map((rule, idx) => (
                <tr key={rule.id} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                  <td style={{ ...S.td, textAlign: 'center' }}>
                    <span style={{ background: '#f5f3ff', color: '#6B3FDB', borderRadius: 6, padding: '3px 10px', fontWeight: 800, fontSize: 13 }}>#{rule.priority}</span>
                  </td>
                  <td style={{ ...S.td, fontWeight: 700 }}>{rule.name}</td>
                  <td style={S.td}><span style={{ background: '#e0f2fe', color: '#0369a1', borderRadius: 12, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>{rule.condition_field}</span></td>
                  <td style={{ ...S.td, color: '#6b7280' }}>{rule.condition_value || '—'}</td>
                  <td style={{ ...S.td, fontWeight: 600 }}>{rule.assign_to_name || '—'}</td>
                  <td style={S.td}>
                    <button onClick={() => toggleActive(rule)} style={{ background: rule.is_active ? '#dcfce7' : '#f3f4f6', color: rule.is_active ? '#166534' : '#9ca3af', border: 'none', borderRadius: 12, padding: '3px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      {rule.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td style={S.td}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button style={S.btnGhost} onClick={() => openEdit(rule)}>Edit</button>
                      <button style={S.btnDanger} onClick={() => setPendingDeleteRule({ id: rule.id, name: rule.name })}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal title={editRule ? 'Edit Rule' : 'Add Assignment Rule'} onClose={() => setShowModal(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={S.label}>Rule Name *</label>
              <input style={S.input} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. North India Territory" />
            </div>
            <div>
              <label style={S.label}>Condition Field</label>
              <select style={S.input} value={form.condition_field} onChange={e => setForm(f => ({ ...f, condition_field: e.target.value }))}>
                <option value="source">Source</option>
                <option value="industry">Industry</option>
                <option value="location">Location</option>
                <option value="company_size">Company Size</option>
              </select>
            </div>
            <div>
              <label style={S.label}>Condition Value</label>
              <input style={S.input} value={form.condition_value} onChange={e => setForm(f => ({ ...f, condition_value: e.target.value }))} placeholder="e.g. Maharashtra" />
            </div>
            <div>
              <label style={S.label}>Assign To (name or team)</label>
              <input style={S.input} value={form.assign_to_name} onChange={e => setForm(f => ({ ...f, assign_to_name: e.target.value }))} placeholder="Sales rep name or team" />
            </div>
            <div>
              <label style={S.label}>Priority (lower = higher priority)</label>
              <input style={S.input} type="number" min="1" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: parseInt(e.target.value) || 10 }))} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input type="checkbox" id="rule_active" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} style={{ width: 16, height: 16, cursor: 'pointer' }} />
              <label htmlFor="rule_active" style={{ ...S.label, margin: 0, cursor: 'pointer', color: '#374151', fontWeight: 600 }}>Active</label>
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button style={S.btn} onClick={save}>{editRule ? 'Update Rule' : 'Add Rule'}</button>
              <button style={S.btnGhost} onClick={() => setShowModal(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 4 — Email Sequences
// ═══════════════════════════════════════════════════════════════════════════════
function EmailSequencesTab() {
  const [sequences, setSequences] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newSeqForm, setNewSeqForm] = useState({ name: '', trigger: 'Prospecting' });
  const [showAddStep, setShowAddStep] = useState(false);
  const [stepForm, setStepForm] = useState({ delay_days: 1, subject: '', body: '' });
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);

  const showToast = msg => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 3000); };

  const STAGE_OPTIONS = ['Prospecting', 'Qualification', 'Proposal', 'Negotiation', 'Won'];

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/crm/email-sequences');
      const seqs = res.data?.sequences ?? res.data?.data ?? [];
      setSequences(Array.isArray(seqs) ? seqs : []);
      setSelected(seqs[0] || null);
    } catch {
      setSequences([]); setSelected(null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createSequence = async () => {
    if (!newSeqForm.name.trim()) return;
    const payload = { ...newSeqForm, steps: [], is_active: true };
    try {
      const res = await api.post('/crm/email-sequences', payload);
      const newSeq = res.data?.data ?? res.data;
      setSequences(prev => [...prev, newSeq]);
      setSelected(newSeq);
    } catch {
      const newSeq = { id: Date.now(), ...payload };
      setSequences(prev => [...prev, newSeq]);
      setSelected(newSeq);
    }
    showToast(`Sequence "${newSeqForm.name}" created`);
    setShowNewModal(false);
    setNewSeqForm({ name: '', trigger: 'Prospecting' });
  };

  const addStep = async () => {
    if (!stepForm.subject.trim() || !selected) return;
    const newStep = { id: Date.now(), delay_days: parseInt(stepForm.delay_days) || 1, subject: stepForm.subject.trim(), body: stepForm.body.trim(), step_order: (selected.steps?.length || 0) + 1 };
    const updatedSeq = { ...selected, steps: [...(selected.steps || []), newStep] };
    try { await api.put(`/crm/email-sequences/${selected.id}`, { steps: updatedSeq.steps }); } catch { /* local */ }
    setSequences(prev => prev.map(s => s.id === selected.id ? updatedSeq : s));
    setSelected(updatedSeq);
    showToast('Step added');
    setShowAddStep(false);
    setStepForm({ delay_days: 1, subject: '', body: '' });
  };

  const deleteStep = async stepId => {
    if (!selected) return;
    const updatedSeq = { ...selected, steps: selected.steps.filter(s => s.id !== stepId) };
    try { await api.put(`/crm/email-sequences/${selected.id}`, { steps: updatedSeq.steps }); } catch { /* local */ }
    setSequences(prev => prev.map(s => s.id === selected.id ? updatedSeq : s));
    setSelected(updatedSeq);
    showToast('Step removed');
  };

  const toggleSeqActive = async seq => {
    const updated = { ...seq, is_active: !seq.is_active };
    try { await api.put(`/crm/email-sequences/${seq.id}`, { is_active: updated.is_active }); } catch { /* local */ }
    setSequences(prev => prev.map(s => s.id === seq.id ? updated : s));
    if (selected?.id === seq.id) setSelected(updated);
  };

  if (loading) return <div style={{ padding: 40, color: '#9ca3af', textAlign: 'center' }}>Loading sequences…</div>;

  return (
    <div>
      <Toast msg={toast} />
      <div style={{ display: 'flex', gap: 20, minHeight: 500 }}>
        <div style={{ width: 280, flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#111' }}>Sequences</span>
            <button style={S.btn} onClick={() => setShowNewModal(true)}>+ New</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sequences.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13 }}>No sequences yet</p>}
            {sequences.map(seq => (
              <div key={seq.id} onClick={() => setSelected(seq)} style={{ ...S.card, padding: '14px 16px', cursor: 'pointer', marginBottom: 0, border: selected?.id === seq.id ? '2px solid #6B3FDB' : '1px solid #f0f0f4', background: selected?.id === seq.id ? '#fafaff' : '#fff', transition: 'all 0.15s' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#111', marginBottom: 4 }}>{seq.name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Trigger: <span style={{ color: '#6B3FDB', fontWeight: 600 }}>{seq.trigger || seq.trigger_stage || '—'}</span></div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{seq.steps?.length || 0} step{(seq.steps?.length || 0) !== 1 ? 's' : ''}</div>
                  </div>
                  <span style={{ background: seq.is_active ? '#dcfce7' : '#f3f4f6', color: seq.is_active ? '#166534' : '#9ca3af', borderRadius: 10, padding: '2px 8px', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{seq.is_active ? 'ON' : 'OFF'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: 1 }}>
          {selected ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>{selected.name}</h3>
                  <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
                    Triggered when lead enters <strong style={{ color: '#6B3FDB' }}>{selected.trigger || selected.trigger_stage}</strong> stage
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button style={S.btnGhost} onClick={() => toggleSeqActive(selected)}>{selected.is_active ? 'Deactivate' : 'Activate'}</button>
                  <button style={S.btn} onClick={() => setShowAddStep(v => !v)}>+ Add Step</button>
                </div>
              </div>

              {showAddStep && (
                <div style={{ ...S.card, background: '#fafaff', border: '1px solid #e9e4ff', marginBottom: 16 }}>
                  <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#6B3FDB' }}>New Email Step</h4>
                  <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: 12, marginBottom: 12 }}>
                    <div>
                      <label style={S.label}>Send on Day</label>
                      <input style={S.input} type="number" min="1" value={stepForm.delay_days} onChange={e => setStepForm(f => ({ ...f, delay_days: e.target.value }))} />
                    </div>
                    <div>
                      <label style={S.label}>Email Subject</label>
                      <input style={S.input} value={stepForm.subject} onChange={e => setStepForm(f => ({ ...f, subject: e.target.value }))} placeholder="Subject line…" />
                    </div>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={S.label}>Email Body</label>
                    <textarea style={{ ...S.input, height: 100, resize: 'vertical', fontFamily: 'inherit' }} value={stepForm.body} onChange={e => setStepForm(f => ({ ...f, body: e.target.value }))} placeholder="Use {name}, {company} for personalisation…" />
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button style={S.btn} onClick={addStep}>Add Step</button>
                    <button style={S.btnGhost} onClick={() => setShowAddStep(false)}>Cancel</button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {(selected.steps || []).length === 0 ? (
                  <div style={{ ...S.card, textAlign: 'center', padding: 40, color: '#9ca3af' }}>No steps yet. Click "+ Add Step" to create the first email.</div>
                ) : (
                  selected.steps.map((step, idx) => (
                    <div key={step.id} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4 }}>
                        <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#6B3FDB', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 13, flexShrink: 0 }}>{idx + 1}</div>
                        {idx < selected.steps.length - 1 && <div style={{ width: 2, height: 32, background: '#e9e4ff', marginTop: 4 }} />}
                      </div>
                      <div style={{ ...S.card, flex: 1, marginBottom: 0, padding: '14px 18px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                              <span style={{ background: '#f5f3ff', color: '#6B3FDB', borderRadius: 6, padding: '2px 10px', fontSize: 11, fontWeight: 700 }}>Day {step.delay_days}</span>
                              <span style={{ fontWeight: 700, fontSize: 14, color: '#111' }}>{step.subject}</span>
                            </div>
                            <p style={{ margin: 0, fontSize: 12, color: '#6b7280', lineHeight: 1.5, maxWidth: 600 }}>
                              {step.body?.length > 120 ? step.body.slice(0, 120) + '…' : step.body}
                            </p>
                          </div>
                          <button style={{ ...S.btnDanger, marginLeft: 12, flexShrink: 0 }} onClick={() => deleteStep(step.id)}>×</button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <div style={{ ...S.card, textAlign: 'center', padding: 60, color: '#9ca3af' }}>
              Select a sequence from the left panel to view and edit its steps.
            </div>
          )}
        </div>
      </div>

      {showNewModal && (
        <Modal title="New Email Sequence" onClose={() => setShowNewModal(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={S.label}>Sequence Name *</label>
              <input style={S.input} value={newSeqForm.name} onChange={e => setNewSeqForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Enterprise Nurture Sequence" />
            </div>
            <div>
              <label style={S.label}>Trigger Stage</label>
              <select style={S.input} value={newSeqForm.trigger} onChange={e => setNewSeqForm(f => ({ ...f, trigger: e.target.value }))}>
                {STAGE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <p style={{ margin: 0, fontSize: 12, color: '#9ca3af' }}>Automatically starts when a lead enters the selected stage.</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={S.btn} onClick={createSequence}>Create Sequence</button>
              <button style={S.btnGhost} onClick={() => setShowNewModal(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 5 — Win/Loss Reasons (configurable, not analytics)
// ═══════════════════════════════════════════════════════════════════════════════
function WinLossTab() {
  const [reasons, setReasons] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [newReason, setNewReason] = useState('');
  const [newType, setNewType] = useState('win');
  const [toast, setToast] = useState('');
  const [pendingDeleteReason, setPendingDeleteReason] = useState(null);
  const toastTimer = useRef(null);

  const showToast = msg => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/crm/win-loss-reasons');
      setReasons(res.data?.data ?? []);
    } catch { setReasons([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addReason = async () => {
    if (!newReason.trim()) return;
    try {
      const res = await api.post('/crm/win-loss-reasons', { type: newType, reason: newReason.trim() });
      setReasons(prev => [...prev, res.data?.data ?? res.data]);
    } catch {
      setReasons(prev => [...prev, { id: Date.now(), type: newType, reason: newReason.trim(), is_active: true }]);
    }
    showToast(`"${newReason}" added`);
    setNewReason(''); setShowModal(false);
  };

  const toggleActive = async reason => {
    const updated = { ...reason, is_active: !reason.is_active };
    try { await api.put(`/crm/win-loss-reasons/${reason.id}`, { is_active: updated.is_active }); } catch { /* local */ }
    setReasons(prev => prev.map(r => r.id === reason.id ? updated : r));
  };

  const deleteReason = async () => {
    if (!pendingDeleteReason) return;
    const { id } = pendingDeleteReason;
    setPendingDeleteReason(null);
    try { await api.delete(`/crm/win-loss-reasons/${id}`); } catch { /* local */ }
    setReasons(prev => prev.filter(r => r.id !== id));
    showToast('Reason deleted');
  };

  const winReasons = reasons.filter(r => r.type === 'win');
  const lossReasons = reasons.filter(r => r.type === 'loss');

  if (loading) return <div style={{ padding: 40, color: '#9ca3af', textAlign: 'center' }}>Loading reasons…</div>;

  const ReasonList = ({ items, type }) => (
    <div style={S.card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: type === 'win' ? '#059669' : '#dc2626' }}>
          {type === 'win' ? '🏆 Win Reasons' : '📉 Loss Reasons'}
        </h4>
        <button style={{ ...S.btn, background: type === 'win' ? '#059669' : '#dc2626' }} onClick={() => { setNewType(type); setNewReason(''); setShowModal(true); }}>+ Add</button>
      </div>
      {items.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 13, margin: 0 }}>No {type} reasons configured</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: r.is_active ? '#fff' : '#fafafa', borderRadius: 8, border: `1px solid ${r.is_active ? '#f0f0f4' : '#f3f4f6'}` }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: r.is_active ? (type === 'win' ? '#059669' : '#dc2626') : '#d1d5db', flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: r.is_active ? '#111' : '#9ca3af' }}>{r.reason}</span>
              <button onClick={() => toggleActive(r)} style={{ background: r.is_active ? '#dcfce7' : '#f3f4f6', color: r.is_active ? '#166534' : '#9ca3af', border: 'none', borderRadius: 12, padding: '2px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                {r.is_active ? 'Active' : 'Off'}
              </button>
              <button style={S.btnDanger} onClick={() => setPendingDeleteReason({ id: r.id, reason: r.reason })}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeleteReason}
        title="Delete Reason"
        message={pendingDeleteReason ? `Delete reason "${pendingDeleteReason.reason}"?` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteReason}
        onCancel={() => setPendingDeleteReason(null)}
      />
      <Toast msg={toast} />
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111' }}>Win / Loss Reasons</h3>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
          These reasons populate the dropdown when marking an opportunity as Won or Lost.
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <ReasonList items={winReasons} type="win" />
        <ReasonList items={lossReasons} type="loss" />
      </div>

      {showModal && (
        <Modal title={`Add ${newType === 'win' ? 'Win' : 'Loss'} Reason`} onClose={() => setShowModal(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={S.label}>Reason *</label>
              <input
                style={S.input}
                value={newReason}
                onChange={e => setNewReason(e.target.value)}
                placeholder={newType === 'win' ? 'e.g. Best Price' : 'e.g. Budget Constraints'}
                onKeyDown={e => e.key === 'Enter' && addReason()}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={{ ...S.btn, background: newType === 'win' ? '#059669' : '#dc2626' }} onClick={addReason}>Add Reason</button>
              <button style={S.btnGhost} onClick={() => setShowModal(false)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
const TABS = [
  { key: 'stages',     label: 'Stages' },
  { key: 'scoring',    label: 'Lead Scoring' },
  { key: 'assignment', label: 'Auto-Assignment' },
  { key: 'sequences',  label: 'Email Sequences' },
  { key: 'winloss',    label: 'Win/Loss' },
];

export default function PipelineAutomation() {
  const [activeTab, setActiveTab] = useState('stages');

  return (
    <div style={{ padding: '24px 28px', background: '#f8f8fc', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111' }}>Pipeline Automation</h1>
        <p style={{ margin: '6px 0 0', fontSize: 14, color: '#6b7280' }}>
          Configure pipeline stages, lead scoring, assignment rules, email sequences and win/loss reasons.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #f0f0f4', marginBottom: 24 }}>
        {TABS.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{ background: 'none', border: 'none', borderBottom: activeTab === tab.key ? '2px solid #6B3FDB' : '2px solid transparent', marginBottom: -2, padding: '10px 20px', cursor: 'pointer', fontSize: 14, fontWeight: activeTab === tab.key ? 700 : 500, color: activeTab === tab.key ? '#6B3FDB' : '#6b7280', transition: 'all 0.15s', whiteSpace: 'nowrap' }}>
            {tab.label}
          </button>
        ))}
      </div>

      <div>
        {activeTab === 'stages'     && <PipelineStagesTab />}
        {activeTab === 'scoring'    && <LeadScoringTab />}
        {activeTab === 'assignment' && <AutoAssignmentTab />}
        {activeTab === 'sequences'  && <EmailSequencesTab />}
        {activeTab === 'winloss'    && <WinLossTab />}
      </div>
    </div>
  );
}
