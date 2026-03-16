import { useState, useEffect, useCallback } from 'react';
import { Plus, X, Edit2, ChevronRight, GitBranch, Check } from 'lucide-react';
import api from '@/services/api/client';
import './WorkflowConfiguration.css';

const SAMPLE = [
  { id: 1, name: 'Leave Approval', module: 'HR', stages: ['Employee', 'Manager', 'HR Head'], active: true, description: 'Multi-level leave request approval flow' },
  { id: 2, name: 'Travel Request', module: 'Travel', stages: ['Employee', 'Manager', 'Finance', 'HR Admin'], active: true, description: 'Travel request and advance approval' },
  { id: 3, name: 'Purchase Request', module: 'Procurement', stages: ['Requester', 'Department Head', 'Finance', 'CEO'], active: true, description: 'Purchase order and procurement approval' },
  { id: 4, name: 'Expense Reimbursement', module: 'Finance', stages: ['Employee', 'Manager', 'Finance Head'], active: true, description: 'Expense claim verification and reimbursement' },
  { id: 5, name: 'New Hire Onboarding', module: 'HR', stages: ['HR', 'IT', 'Admin', 'Manager'], active: false, description: 'Onboarding checklist workflow for new employees' },
  { id: 6, name: 'Project Budget Approval', module: 'Projects', stages: ['PM', 'Department Head', 'Finance', 'CEO'], active: true, description: 'Project budget sign-off process' },
];

const MODULE_COLORS = { HR: '#eef2ff', Travel: '#dcfce7', Procurement: '#fef3c7', Finance: '#fee2e2', Projects: '#ede9fe' };
const MODULE_TEXT   = { HR: '#4338ca', Travel: '#15803d', Procurement: '#92400e', Finance: '#dc2626', Projects: '#7c3aed' };
const BLANK = { name: '', module: 'HR', description: '', stages: ['', ''] };

export default function WorkflowConfiguration() {
  const [workflows, setWorkflows] = useState(SAMPLE);
  const [loading, setLoading]     = useState(false);
  const [drawer, setDrawer]       = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm]           = useState(BLANK);
  const [saving, setSaving]       = useState(false);
  const [toast, setToast]         = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/operations/workflows');
      const raw = res.data?.data ?? res.data;
      setWorkflows(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setWorkflows(SAMPLE); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditTarget(null); setForm(BLANK); setDrawer('edit'); };
  const openEdit   = (wf) => { setEditTarget(wf.id); setForm({ name: wf.name, module: wf.module, description: wf.description, stages: [...wf.stages] }); setDrawer('edit'); };

  const addStage = () => setForm(f => ({ ...f, stages: [...f.stages, ''] }));
  const removeStage = i => setForm(f => ({ ...f, stages: f.stages.filter((_, idx) => idx !== i) }));
  const updateStage = (i, v) => setForm(f => ({ ...f, stages: f.stages.map((s, idx) => idx === i ? v : s) }));

  const handleSubmit = async e => {
    e.preventDefault();
    const validStages = form.stages.filter(s => s.trim());
    if (validStages.length < 2) { showToast('At least 2 stages required', 'error'); return; }
    setSaving(true);
    const payload = { ...form, stages: validStages };
    try {
      if (editTarget) await api.put(`/operations/workflows/${editTarget}`, payload);
      else await api.post('/operations/workflows', payload);
      showToast(editTarget ? 'Workflow updated!' : 'Workflow created!');
      load();
    } catch {
      if (editTarget) {
        setWorkflows(prev => prev.map(w => w.id === editTarget ? { ...w, ...payload } : w));
      } else {
        setWorkflows(prev => [...prev, { id: Date.now(), ...payload, active: true }]);
      }
      showToast(editTarget ? 'Workflow updated (offline)' : 'Workflow created (offline)');
    }
    setDrawer(null); setForm(BLANK); setSaving(false);
  };

  const toggleActive = async (id, currentState) => {
    const newState = !currentState;
    try { await api.put(`/operations/workflows/${id}/toggle`, { active: newState }); }
    catch { /* optimistic */ }
    setWorkflows(prev => prev.map(w => w.id === id ? { ...w, active: newState } : w));
    showToast(`Workflow ${newState ? 'enabled' : 'disabled'}!`);
  };

  return (
    <div className="wfc-root">
      {toast && <div className={`wfc-toast wfc-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="wfc-header">
        <div>
          <h1 className="wfc-title">Workflow Configuration</h1>
          <p className="wfc-sub">Define and manage approval workflows across modules</p>
        </div>
        <button className="wfc-btn-primary" onClick={openCreate}>
          <Plus size={15} /> New Workflow
        </button>
      </div>

      {loading ? (
        <div className="wfc-loading"><div className="wfc-spinner" /></div>
      ) : (
        <div className="wfc-grid">
          {workflows.map(wf => (
            <div key={wf.id} className={`wfc-card ${!wf.active ? 'wfc-card-inactive' : ''}`}>
              <div className="wfc-card-hd">
                <div className="wfc-card-info">
                  <div className="wfc-card-icon"><GitBranch size={16} /></div>
                  <div>
                    <div className="wfc-wf-name">{wf.name}</div>
                    <span className="wfc-module-badge" style={{ background: MODULE_COLORS[wf.module], color: MODULE_TEXT[wf.module] }}>{wf.module}</span>
                  </div>
                </div>
                <div className="wfc-card-actions">
                  <button className="wfc-edit-btn" onClick={() => openEdit(wf)}><Edit2 size={13} /></button>
                  <button
                    className={`wfc-toggle-btn ${wf.active ? 'wfc-toggle-on' : 'wfc-toggle-off'}`}
                    onClick={() => toggleActive(wf.id, wf.active)}
                    title={wf.active ? 'Disable' : 'Enable'}
                  >
                    {wf.active ? <Check size={12} /> : null}
                    {wf.active ? 'Active' : 'Inactive'}
                  </button>
                </div>
              </div>

              <p className="wfc-wf-desc">{wf.description}</p>

              <div className="wfc-stages">
                {wf.stages.map((stage, i) => (
                  <div key={i} className="wfc-stage-row">
                    <div className="wfc-stage-num">{i + 1}</div>
                    <div className="wfc-stage-name">{stage}</div>
                    {i < wf.stages.length - 1 && <ChevronRight size={12} className="wfc-stage-arrow" />}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {drawer && (
        <div className="wfc-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="wfc-drawer">
            <div className="wfc-drawer-hd">
              <h3>{editTarget ? 'Edit Workflow' : 'New Workflow'}</h3>
              <button className="wfc-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="wfc-drawer-body" onSubmit={handleSubmit}>
              <div className="wfc-field">
                <label>Workflow Name <span className="wfc-req">*</span></label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Leave Approval" required />
              </div>
              <div className="wfc-row2">
                <div className="wfc-field">
                  <label>Module <span className="wfc-req">*</span></label>
                  <select value={form.module} onChange={e => setForm(f => ({ ...f, module: e.target.value }))}>
                    {Object.keys(MODULE_COLORS).map(m => <option key={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              <div className="wfc-field">
                <label>Description</label>
                <textarea rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Brief description of this workflow…" />
              </div>

              <div className="wfc-stages-section">
                <div className="wfc-stages-hd">
                  <span>Approval Stages</span>
                  <button type="button" className="wfc-add-stage-btn" onClick={addStage}><Plus size={12} /> Add Stage</button>
                </div>
                {form.stages.map((stage, i) => (
                  <div key={i} className="wfc-stage-input-row">
                    <div className="wfc-stage-num-input">{i + 1}</div>
                    <input
                      value={stage}
                      onChange={e => updateStage(i, e.target.value)}
                      placeholder={`Stage ${i + 1} approver`}
                      className="wfc-stage-input"
                    />
                    {form.stages.length > 2 && (
                      <button type="button" className="wfc-remove-stage-btn" onClick={() => removeStage(i)}><X size={12} /></button>
                    )}
                  </div>
                ))}
              </div>

              <div className="wfc-drawer-ft">
                <button type="button" className="wfc-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="wfc-btn-primary" disabled={saving}>{saving ? 'Saving…' : editTarget ? 'Update Workflow' : 'Create Workflow'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
