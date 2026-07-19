import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  ArrowLeft, Plus, Pencil, Trash2, ChevronUp, ChevronDown,
  CheckSquare, MessageSquare, FileText, Mail, List, Zap
} from 'lucide-react';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const STEP_TYPES = ['action', 'talk_track', 'checklist', 'email_template', 'document'];
const CAT_COLORS = {
  prospecting:  { bg: '#dbeafe', color: '#1d4ed8' },
  qualification:{ bg: '#fef3c7', color: '#92400e' },
  proposal:     { bg: '#ede9fe', color: '#6B3FDB' },
  negotiation:  { bg: '#fee2e2', color: '#b91c1c' },
  closing:      { bg: '#d1fae5', color: '#065f46' },
  general:      { bg: '#f3f4f6', color: '#374151' },
};
const TYPE_ICONS = {
  action:         <Zap       size={12} />,
  talk_track:     <MessageSquare size={12} />,
  checklist:      <CheckSquare size={12} />,
  email_template: <Mail      size={12} />,
  document:       <FileText  size={12} />,
};
const TYPE_COLORS = {
  action:         { bg: '#dbeafe', color: '#1d4ed8' },
  talk_track:     { bg: '#fef3c7', color: '#92400e' },
  checklist:      { bg: '#d1fae5', color: '#065f46' },
  email_template: { bg: '#fce7f3', color: '#9d174d' },
  document:       { bg: '#f3f4f6', color: '#374151' },
};

function catColor(cat) {
  return CAT_COLORS[(cat || '').toLowerCase()] || CAT_COLORS.general;
}

const EMPTY_STEP = { title: '', description: '', step_type: 'action', content: '', is_mandatory: true };
const EMPTY_HEADER = { name: '', category: '', applicable_stage: '', description: '', is_active: true };

export default function PlaybookDetail({ setPage, urlParams }) {
  const toast = useToast();
  const [playbook, setPlaybook] = useState(null);
  const [steps,    setSteps]    = useState([]);
  const [loading,  setLoading]  = useState(true);

  // Step modal
  const [stepModal,    setStepModal]    = useState(false);
  const [editingStep,  setEditingStep]  = useState(null); // null = new
  const [stepForm,     setStepForm]     = useState(EMPTY_STEP);
  const [savingStep,   setSavingStep]   = useState(false);

  // Header edit modal
  const [headerModal,  setHeaderModal]  = useState(false);
  const [headerForm,   setHeaderForm]   = useState(EMPTY_HEADER);
  const [savingHeader, setSavingHeader] = useState(false);
  const [pendingDeleteStep, setPendingDeleteStep] = useState(null);

  const playbookId = urlParams?.id || sessionStorage.getItem('selectedPlaybookId');

  const load = useCallback(() => {
    if (!playbookId) return;
    setLoading(true);
    api.get(`/sales/playbooks/${playbookId}`)
      .then(r => {
        const d = r.data?.data ?? {};
        setPlaybook(d);
        setSteps(d.steps ?? []);
      })
      .catch(() => toast.error('Failed to load playbook'))
      .finally(() => setLoading(false));
  }, [playbookId]);

  useEffect(() => { load(); }, [load]);

  // ── Header edit ──────────────────────────────────────────────────────────
  const openHeaderEdit = () => {
    setHeaderForm({
      name:             playbook?.name             || '',
      category:         playbook?.category         || '',
      applicable_stage: playbook?.applicable_stage || '',
      description:      playbook?.description      || '',
      is_active:        playbook?.is_active ?? true,
    });
    setHeaderModal(true);
  };

  const saveHeader = async () => {
    if (!headerForm.name.trim()) return;
    setSavingHeader(true);
    try {
      await api.put(`/sales/playbooks/${playbookId}`, headerForm);
      toast.success('Playbook updated');
      setHeaderModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Update failed');
    } finally { setSavingHeader(false); }
  };

  // ── Step modal ────────────────────────────────────────────────────────────
  const openAddStep = () => {
    setEditingStep(null);
    setStepForm(EMPTY_STEP);
    setStepModal(true);
  };

  const openEditStep = (s) => {
    setEditingStep(s);
    setStepForm({
      title:        s.title        || '',
      description:  s.description  || '',
      step_type:    s.step_type    || 'action',
      content:      s.content      || '',
      is_mandatory: s.is_mandatory ?? true,
    });
    setStepModal(true);
  };

  const saveStep = async () => {
    if (!stepForm.title.trim()) return;
    setSavingStep(true);
    try {
      if (editingStep) {
        await api.put(`/sales/playbooks/${playbookId}/steps/${editingStep.id}`, stepForm);
        toast.success('Step updated');
      } else {
        await api.post(`/sales/playbooks/${playbookId}/steps`, stepForm);
        toast.success('Step added');
      }
      setStepModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSavingStep(false); }
  };

  const deleteStep = async () => {
    if (!pendingDeleteStep) return;
    const stepId = pendingDeleteStep;
    setPendingDeleteStep(null);
    try {
      await api.delete(`/sales/playbooks/${playbookId}/steps/${stepId}`);
      toast.success('Step deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  // ── Reorder (up/down) ────────────────────────────────────────────────────
  const moveStep = async (idx, dir) => {
    const newSteps = [...steps];
    const target   = idx + dir;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[idx], newSteps[target]] = [newSteps[target], newSteps[idx]];
    setSteps(newSteps); // optimistic
    try {
      await api.put(`/sales/playbooks/${playbookId}/steps/reorder`, {
        ordered_ids: newSteps.map(s => s.id),
      });
    } catch (err) {
      toast.error('Reorder failed');
      load(); // revert
    }
  };

  if (loading) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
  );

  if (!playbook) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
      Playbook not found.{' '}
      <button onClick={() => setPage && setPage('SalesPlaybooks')}
        style={{ color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
        Back to Playbooks
      </button>
    </div>
  );

  const cc = catColor(playbook.category);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100%' }}>

      <ConfirmDialog
        open={!!pendingDeleteStep}
        title="Delete Step"
        message="Delete this step?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteStep}
        onCancel={() => setPendingDeleteStep(null)}
      />

      {/* Back + header */}
      <button onClick={() => setPage && setPage('SalesPlaybooks')}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none',
                 border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 13,
                 marginBottom: 16, padding: 0 }}>
        <ArrowLeft size={15} /> Back to Playbooks
      </button>

      <div style={{ background: '#fff', borderRadius: 12, padding: 24,
                    border: '1px solid #f0f0f4', marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1f2937', margin: 0 }}>
                {playbook.name}
              </h1>
              {playbook.category && (
                <span style={{ background: cc.bg, color: cc.color, padding: '3px 10px',
                               borderRadius: 20, fontSize: 11, fontWeight: 700,
                               textTransform: 'uppercase', letterSpacing: '.4px' }}>
                  {playbook.category}
                </span>
              )}
              {playbook.applicable_stage && (
                <span style={{ background: '#f3f4f6', color: '#6b7280', padding: '3px 10px',
                               borderRadius: 20, fontSize: 11 }}>
                  Stage: {playbook.applicable_stage}
                </span>
              )}
              <span style={{ background: playbook.is_active ? '#d1fae5' : '#f3f4f6',
                             color:      playbook.is_active ? '#065f46' : '#9ca3af',
                             padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                {playbook.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>
            {playbook.description && (
              <p style={{ color: '#6b7280', fontSize: 14, margin: 0, lineHeight: 1.6 }}>
                {playbook.description}
              </p>
            )}
          </div>
          <button onClick={openHeaderEdit}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px',
                     background: '#f5f3ff', color: '#6B3FDB', border: '1px solid #ede9fe',
                     borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                     flexShrink: 0, marginLeft: 16 }}>
            <Pencil size={13} /> Edit
          </button>
        </div>
      </div>

      {/* Steps */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '16px 20px', borderBottom: '1px solid #f5f3ff' }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#1f2937' }}>
            Steps <span style={{ color: '#6B3FDB', fontSize: 13 }}>({steps.length})</span>
          </div>
          <button onClick={openAddStep}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px',
                     background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8,
                     cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={14} /> Add Step
          </button>
        </div>

        {steps.length === 0 ? (
          <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
            <List size={32} color="#d1d5db" style={{ marginBottom: 10 }} />
            <p style={{ margin: 0, fontSize: 14 }}>No steps yet. Add your first step.</p>
          </div>
        ) : (
          <div>
            {steps.map((s, idx) => {
              const tc = TYPE_COLORS[s.step_type] || TYPE_COLORS.action;
              return (
                <div key={s.id}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 14,
                            padding: '14px 20px', borderBottom: idx < steps.length - 1 ? '1px solid #f5f3ff' : 'none' }}>
                  {/* Step number */}
                  <div style={{ width: 28, height: 28, borderRadius: '50%',
                                background: '#ede9fe', color: '#6B3FDB',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 2 }}>
                    {s.step_order}
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{s.title}</span>
                      <span style={{ background: tc.bg, color: tc.color,
                                     padding: '2px 8px', borderRadius: 20,
                                     fontSize: 10, fontWeight: 600,
                                     display: 'flex', alignItems: 'center', gap: 3 }}>
                        {TYPE_ICONS[s.step_type]} {(s.step_type || 'action').replace('_', ' ')}
                      </span>
                      {!s.is_mandatory && (
                        <span style={{ background: '#f3f4f6', color: '#9ca3af',
                                       padding: '2px 8px', borderRadius: 20, fontSize: 10 }}>
                          Optional
                        </span>
                      )}
                    </div>
                    {s.description && (
                      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 4px', lineHeight: 1.5 }}>
                        {s.description}
                      </p>
                    )}
                    {s.content && (
                      <pre style={{ fontSize: 12, color: '#374151', margin: 0,
                                    background: '#f9fafb', padding: '8px 12px',
                                    borderRadius: 6, whiteSpace: 'pre-wrap',
                                    fontFamily: 'inherit', lineHeight: 1.6 }}>
                        {s.content}
                      </pre>
                    )}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                    <button onClick={() => moveStep(idx, -1)} disabled={idx === 0}
                      style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'default' : 'pointer',
                               color: idx === 0 ? '#d1d5db' : '#9ca3af', padding: '2px 4px' }}>
                      <ChevronUp size={15} />
                    </button>
                    <button onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1}
                      style={{ background: 'none', border: 'none',
                               cursor: idx === steps.length - 1 ? 'default' : 'pointer',
                               color: idx === steps.length - 1 ? '#d1d5db' : '#9ca3af', padding: '2px 4px' }}>
                      <ChevronDown size={15} />
                    </button>
                    <button onClick={() => openEditStep(s)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer',
                               color: '#6B3FDB', padding: '2px 4px' }}>
                      <Pencil size={14} />
                    </button>
                    <button onClick={() => setPendingDeleteStep(s.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer',
                               color: '#dc2626', padding: '2px 4px' }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Header Edit Modal */}
      {headerModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000,
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}
             onClick={() => setHeaderModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 500,
                        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}
               onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: '0 0 20px' }}>
              Edit Playbook
            </h2>
            <div style={{ display: 'grid', gap: 14 }}>
              {[
                { label: 'Name *', key: 'name', type: 'input', placeholder: 'Playbook name' },
                { label: 'Category', key: 'category', type: 'input', placeholder: 'e.g. qualification' },
                { label: 'Applicable Stage', key: 'applicable_stage', type: 'input', placeholder: 'e.g. qualification' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                   color: '#374151', marginBottom: 4 }}>{f.label}</label>
                  <input value={headerForm[f.key] || ''}
                         onChange={e => setHeaderForm(h => ({ ...h, [f.key]: e.target.value }))}
                         placeholder={f.placeholder}
                         style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                  borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
                </div>
              ))}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Description</label>
                <textarea value={headerForm.description || ''}
                          onChange={e => setHeaderForm(h => ({ ...h, description: e.target.value }))}
                          rows={3}
                          style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                   borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical',
                                   boxSizing: 'border-box' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" id="pb_active"
                       checked={!!headerForm.is_active}
                       onChange={e => setHeaderForm(h => ({ ...h, is_active: e.target.checked }))} />
                <label htmlFor="pb_active" style={{ fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                  Active
                </label>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setHeaderModal(false)}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8,
                         background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={saveHeader} disabled={savingHeader || !headerForm.name.trim()}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none',
                         borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                         opacity: savingHeader || !headerForm.name.trim() ? .6 : 1 }}>
                {savingHeader ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Step Add/Edit Modal */}
      {stepModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000,
                      display: 'flex', alignItems: 'center', justifyContent: 'center' }}
             onClick={() => setStepModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 32, width: 520,
                        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}
               onClick={e => e.stopPropagation()}>
            <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: '0 0 20px' }}>
              {editingStep ? 'Edit Step' : 'Add Step'}
            </h2>
            <div style={{ display: 'grid', gap: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Title *</label>
                <input value={stepForm.title}
                       onChange={e => setStepForm(f => ({ ...f, title: e.target.value }))}
                       placeholder="e.g. Send company overview deck"
                       style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Type</label>
                <select value={stepForm.step_type}
                        onChange={e => setStepForm(f => ({ ...f, step_type: e.target.value }))}
                        style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                 borderRadius: 8, fontSize: 13, outline: 'none' }}>
                  {STEP_TYPES.map(t => (
                    <option key={t} value={t}>{t.replace('_', ' ')}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Description</label>
                <textarea value={stepForm.description}
                          onChange={e => setStepForm(f => ({ ...f, description: e.target.value }))}
                          rows={2} placeholder="What this step involves…"
                          style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                   borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical',
                                   boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
                                 color: '#374151', marginBottom: 4 }}>Content</label>
                <textarea value={stepForm.content}
                          onChange={e => setStepForm(f => ({ ...f, content: e.target.value }))}
                          rows={4} placeholder="Talk track script, checklist items, email body…"
                          style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
                                   borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical',
                                   boxSizing: 'border-box', fontFamily: 'inherit' }} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" id="step_mandatory"
                       checked={!!stepForm.is_mandatory}
                       onChange={e => setStepForm(f => ({ ...f, is_mandatory: e.target.checked }))} />
                <label htmlFor="step_mandatory" style={{ fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                  Mandatory step
                </label>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={() => setStepModal(false)}
                style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8,
                         background: '#fff', cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={saveStep} disabled={savingStep || !stepForm.title.trim()}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none',
                         borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                         opacity: savingStep || !stepForm.title.trim() ? .6 : 1 }}>
                {savingStep ? 'Saving…' : editingStep ? 'Save Changes' : 'Add Step'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
