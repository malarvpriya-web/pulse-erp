import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, X, RefreshCw, ArrowLeft, ClipboardList } from 'lucide-react';
import api from '@/services/api/client';
import './TestPlans.css';
import { useToast } from '@/context/ToastContext';

const TEST_TYPES   = ['Functional','Performance','Safety','Regulatory','User Acceptance','Environmental','Durability','Other'];
const PLAN_STATUSES= ['draft','scheduled','in_progress','passed','failed','blocked'];
const RESULT_OPTS  = ['pass','fail','partial'];

const STATUS_META = {
  draft:       { label: 'Draft',       color: '#9ca3af', bg: '#f3f4f6' },
  scheduled:   { label: 'Scheduled',   color: '#3b82f6', bg: '#eff6ff' },
  in_progress: { label: 'In Progress', color: '#f59e0b', bg: '#fffbeb' },
  passed:      { label: 'Passed',      color: '#10b981', bg: '#ecfdf5' },
  failed:      { label: 'Failed',      color: '#ef4444', bg: '#fef2f2' },
  blocked:     { label: 'Blocked',     color: '#8b5cf6', bg: '#f5f3ff' },
};
const RESULT_META = {
  pass:    { label: 'Pass',    color: '#10b981' },
  fail:    { label: 'Fail',    color: '#ef4444' },
  partial: { label: 'Partial', color: '#f59e0b' },
};

function StatusBadge({ status }) {
  const m = STATUS_META[status] || { label: status, color: '#6b7280', bg: '#f3f4f6' };
  return <span className="tp-badge" style={{ background: m.bg, color: m.color }}>{m.label}</span>;
}

function Modal({ title, onClose, children }) {
  return (
    <div className="tp-overlay" onClick={onClose}>
      <div className="tp-modal" onClick={e => e.stopPropagation()}>
        <div className="tp-modal-head">
          <h2>{title}</h2>
          <button className="tp-icon-btn" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="tp-modal-body">{children}</div>
      </div>
    </div>
  );
}

function TestPlanForm({ initial, projects, prototypes, onSave, onCancel, saving }) {
  const [form, setForm] = useState(initial);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const filteredProtos = prototypes.filter(p => String(p.project_id) === String(form.project_id));

  return (
    <form className="tp-form" onSubmit={e => { e.preventDefault(); onSave(form); }}>
      <div className="tp-form-row">
        <label>Project *
          <select required value={form.project_id} onChange={e => set('project_id', e.target.value)}>
            <option value="">— Select —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Prototype (optional)
          <select value={form.prototype_id} onChange={e => set('prototype_id', e.target.value)}>
            <option value="">— None —</option>
            {filteredProtos.map(p => (
              <option key={p.id} value={p.id}>v{p.iteration} — {p.title || `Prototype ${p.iteration}`}</option>
            ))}
          </select>
        </label>
      </div>
      <label>Test Title *
        <input required value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. High-pressure leak test" />
      </label>
      <div className="tp-form-row">
        <label>Test Type
          <select value={form.test_type} onChange={e => set('test_type', e.target.value)}>
            <option value="">— Select —</option>
            {TEST_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>Status
          <select value={form.status} onChange={e => set('status', e.target.value)}>
            {PLAN_STATUSES.map(s => <option key={s} value={s}>{STATUS_META[s]?.label || s}</option>)}
          </select>
        </label>
      </div>
      <label>Description
        <textarea rows={2} value={form.description} onChange={e => set('description', e.target.value)} placeholder="What is being tested and how" />
      </label>
      <label>Acceptance Criteria
        <textarea rows={2} value={form.acceptance_criteria} onChange={e => set('acceptance_criteria', e.target.value)} placeholder="Pass/fail thresholds, standards (e.g. ISO 9001)" />
      </label>
      <div className="tp-form-row">
        <label>Executed By
          <input value={form.executed_by} onChange={e => set('executed_by', e.target.value)} placeholder="Engineer name" />
        </label>
        <label>Planned Date
          <input type="date" value={form.planned_date} onChange={e => set('planned_date', e.target.value)} />
        </label>
      </div>

      {/* Result section — only when not draft */}
      {form.status !== 'draft' && form.status !== 'scheduled' && (
        <>
          <div className="tp-section-divider">Test Execution</div>
          <div className="tp-form-row">
            <label>Result
              <select value={form.result} onChange={e => set('result', e.target.value)}>
                <option value="">— Not yet —</option>
                {RESULT_OPTS.map(r => <option key={r} value={r}>{RESULT_META[r].label}</option>)}
              </select>
            </label>
            <label>Executed Date
              <input type="date" value={form.executed_date} onChange={e => set('executed_date', e.target.value)} />
            </label>
          </div>
          <label>Findings / Observations
            <textarea rows={3} value={form.findings} onChange={e => set('findings', e.target.value)} placeholder="Detailed test findings, deviations, corrective actions…" />
          </label>
        </>
      )}

      <div className="tp-form-actions">
        <button type="button" className="tp-btn-cancel" onClick={onCancel}>Cancel</button>
        <button type="submit" className="tp-btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save Test Plan'}</button>
      </div>
    </form>
  );
}

const EMPTY_FORM = {
  project_id: '', prototype_id: '', title: '', description: '',
  test_type: '', acceptance_criteria: '', status: 'draft',
  result: '', executed_by: '', planned_date: '', executed_date: '', findings: '',
};

export default function TestPlans({ pageParams, setPage }) {
  const toast = useToast();
  const projectId   = pageParams?.projectId   || null;
  const projectName = pageParams?.projectName || null;

  const [plans,     setPlans]     = useState([]);
  const [projects,  setProjects]  = useState([]);
  const [prototypes,setPrototypes]= useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [modal,     setModal]     = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [deleteId,  setDeleteId]  = useState(null);
  const [filterPid, setFilterPid] = useState(projectId || '');
  const [filterStatus, setFilterStatus] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tpRes, prRes, ptRes] = await Promise.all([
        api.get('/engineering/test-plans', { params: filterPid ? { project_id: filterPid } : {} }),
        api.get('/engineering/rd-projects'),
        api.get('/engineering/prototypes'),
      ]);
      setPlans(Array.isArray(tpRes.data.data) ? tpRes.data.data : []);
      setProjects(Array.isArray(prRes.data.data) ? prRes.data.data : []);
      setPrototypes(Array.isArray(ptRes.data.data) ? ptRes.data.data : []);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally { setLoading(false); }
  }, [filterPid]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (form) => {
    setSaving(true);
    try {
      await api.post('/engineering/test-plans', form);
      setModal(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleUpdate = async (form) => {
    setSaving(true);
    try {
      await api.put(`/engineering/test-plans/${modal.edit.id}`, form);
      setModal(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/engineering/test-plans/${deleteId}`);
      toast.success('Test plan deleted');
      setDeleteId(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed');
    }
  };

  const toDate = iso => iso ? iso.slice(0, 10) : '';

  const visiblePlans = filterStatus ? plans.filter(p => p.status === filterStatus) : plans;

  // Summary stats
  const total   = plans.length;
  const passed  = plans.filter(p => p.result === 'pass').length;
  const failed  = plans.filter(p => p.result === 'fail').length;
  const pending = plans.filter(p => p.status === 'draft' || p.status === 'scheduled').length;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  return (
    <div className="tp-page">
      <div className="tp-header">
        <div className="tp-header-left">
          {setPage && projectId && (
            <button className="tp-back" onClick={() => setPage('PrototypeTracker', { projectId, projectName })}>
              <ArrowLeft size={14} /> Prototypes
            </button>
          )}
          <div>
            <h1 className="tp-title">Test Plans</h1>
            <p className="tp-sub">{projectName || 'All Projects'} — test execution tracking</p>
          </div>
        </div>
        <div className="tp-header-right">
          <button className="tp-icon-btn" onClick={load}><RefreshCw size={15} /></button>
          <button className="tp-btn-new" onClick={() => setModal('create')}><Plus size={14} /> New Test Plan</button>
        </div>
      </div>

      {/* Summary strip */}
      {!loading && plans.length > 0 && (
        <div className="tp-summary">
          <div className="tp-summary-item">
            <span className="tp-sum-val">{total}</span>
            <span className="tp-sum-label">Total Plans</span>
          </div>
          <div className="tp-summary-item tp-sum-pass">
            <span className="tp-sum-val">{passed}</span>
            <span className="tp-sum-label">Passed</span>
          </div>
          <div className="tp-summary-item tp-sum-fail">
            <span className="tp-sum-val">{failed}</span>
            <span className="tp-sum-label">Failed</span>
          </div>
          <div className="tp-summary-item">
            <span className="tp-sum-val">{pending}</span>
            <span className="tp-sum-label">Pending</span>
          </div>
          <div className="tp-summary-item tp-sum-rate">
            <span className="tp-sum-val">{passRate}%</span>
            <span className="tp-sum-label">Pass Rate</span>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="tp-toolbar">
        <select className="tp-filter" value={filterPid} onChange={e => setFilterPid(e.target.value)}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="tp-filter" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {PLAN_STATUSES.map(s => <option key={s} value={s}>{STATUS_META[s]?.label || s}</option>)}
        </select>
      </div>

      {loading && <div className="tp-center"><div className="tp-spinner" /></div>}
      {!loading && error && <div className="tp-err">{error}</div>}

      {!loading && !error && visiblePlans.length === 0 && (
        <div className="tp-empty">
          <ClipboardList size={40} className="tp-empty-icon" />
          <p>{plans.length === 0 ? 'No test plans yet.' : 'No plans match the current filter.'}</p>
          {plans.length === 0 && (
            <button className="tp-btn-new" onClick={() => setModal('create')}><Plus size={14} /> Create First Test Plan</button>
          )}
        </div>
      )}

      {!loading && !error && visiblePlans.length > 0 && (
        <div className="tp-table-wrap">
          <table className="tp-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Project</th>
                <th>Type</th>
                <th>Status</th>
                <th>Result</th>
                <th>Prototype</th>
                <th>Executed By</th>
                <th>Planned</th>
                <th>Executed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visiblePlans.map(tp => (
                <tr key={tp.id}>
                  <td>
                    <div className="tp-plan-title">{tp.title}</div>
                    {tp.acceptance_criteria && (
                      <div className="tp-plan-criteria">{tp.acceptance_criteria.slice(0, 60)}{tp.acceptance_criteria.length > 60 ? '…' : ''}</div>
                    )}
                  </td>
                  <td>
                    <div className="tp-proj-name">{tp.project_name}</div>
                    {tp.project_code && <div className="tp-proj-code">{tp.project_code}</div>}
                  </td>
                  <td><span className="tp-type-chip">{tp.test_type || '—'}</span></td>
                  <td><StatusBadge status={tp.status} /></td>
                  <td>
                    {tp.result
                      ? <span className="tp-result" style={{ color: RESULT_META[tp.result]?.color }}>{RESULT_META[tp.result]?.label}</span>
                      : <span className="tp-no-result">—</span>
                    }
                  </td>
                  <td>
                    {tp.prototype_iteration
                      ? <span className="tp-proto-ref">v{tp.prototype_iteration}{tp.prototype_title ? ` · ${tp.prototype_title}` : ''}</span>
                      : '—'}
                  </td>
                  <td>{tp.executed_by || '—'}</td>
                  <td>{tp.planned_date   ? new Date(tp.planned_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })   : '—'}</td>
                  <td>{tp.executed_date  ? new Date(tp.executed_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })  : '—'}</td>
                  <td>
                    <div style={{ display:'flex', gap:4 }}>
                      <button className="tp-icon-btn" title="Edit" onClick={() => setModal({ edit: tp })}><Pencil size={13} /></button>
                      <button className="tp-icon-btn tp-del-btn" title="Delete" onClick={() => setDeleteId(tp.id)}><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create */}
      {modal === 'create' && (
        <Modal title="New Test Plan" onClose={() => setModal(null)}>
          <TestPlanForm
            initial={{ ...EMPTY_FORM, project_id: filterPid || '' }}
            projects={projects}
            prototypes={prototypes}
            onSave={handleCreate}
            onCancel={() => setModal(null)}
            saving={saving}
          />
        </Modal>
      )}

      {/* Edit */}
      {modal?.edit && (
        <Modal title="Edit Test Plan" onClose={() => setModal(null)}>
          <TestPlanForm
            initial={{
              ...modal.edit,
              planned_date:  toDate(modal.edit.planned_date),
              executed_date: toDate(modal.edit.executed_date),
              result:        modal.edit.result || '',
              findings:      modal.edit.findings || '',
            }}
            projects={projects}
            prototypes={prototypes}
            onSave={handleUpdate}
            onCancel={() => setModal(null)}
            saving={saving}
          />
        </Modal>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <Modal title="Delete Test Plan" onClose={() => setDeleteId(null)}>
          <p style={{ margin: '0 0 20px', color: '#374151' }}>Permanently delete this test plan?</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="tp-btn-cancel" onClick={() => setDeleteId(null)}>Cancel</button>
            <button className="tp-btn-del-confirm" onClick={handleDelete}>Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
