import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, X, RefreshCw, ArrowLeft, TestTube2 } from 'lucide-react';
import api from '@/services/api/client';
import './PrototypeTracker.css';
import { useToast } from '@/context/ToastContext';

const STATUS_OPTS = ['building','ready','testing','passed','failed','scrapped'];
const RESULT_OPTS = ['pass','fail','partial'];

const STATUS_META = {
  building: { label: 'Building',  color: '#3b82f6', bg: '#eff6ff' },
  ready:    { label: 'Ready',     color: '#6366f1', bg: '#f5f3ff' },
  testing:  { label: 'Testing',   color: '#f59e0b', bg: '#fffbeb' },
  passed:   { label: 'Passed',    color: '#10b981', bg: '#ecfdf5' },
  failed:   { label: 'Failed',    color: '#ef4444', bg: '#fef2f2' },
  scrapped: { label: 'Scrapped',  color: '#9ca3af', bg: '#f3f4f6' },
};
const RESULT_META = {
  pass:    { label: 'Pass',    color: '#10b981' },
  fail:    { label: 'Fail',    color: '#ef4444' },
  partial: { label: 'Partial', color: '#f59e0b' },
};

function Badge({ value, meta }) {
  const m = meta[value];
  if (!m) return <span className="pt-badge-neutral">{value || '—'}</span>;
  return <span className="pt-badge" style={{ background: m.bg || m.color+'22', color: m.color }}>{m.label}</span>;
}

const EMPTY_FORM = {
  project_id: '', title: '', specs: '', materials: '',
  build_cost: '', build_date: '', assigned_to: '',
};

const EMPTY_UPDATE = {
  title: '', status: 'building', specs: '', materials: '', build_cost: '',
  build_date: '', test_date: '', test_result: '', test_notes: '', assigned_to: '',
};

function Modal({ title, onClose, children }) {
  return (
    <div className="pt-overlay" onClick={onClose}>
      <div className="pt-modal" onClick={e => e.stopPropagation()}>
        <div className="pt-modal-head">
          <h2>{title}</h2>
          <button className="pt-icon-btn" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="pt-modal-body">{children}</div>
      </div>
    </div>
  );
}

export default function PrototypeTracker({ pageParams, setPage }) {
  const projectId   = pageParams?.projectId   || null;
  const projectName = pageParams?.projectName || null;

  const toast = useToast();
  const [protos,    setProtos]    = useState([]);
  const [projects,  setProjects]  = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [modal,     setModal]     = useState(null); // null | 'create' | {edit: row}
  const [saving,    setSaving]    = useState(false);
  const [deleteId,  setDeleteId]  = useState(null);
  const [filterPid, setFilterPid] = useState(projectId || '');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ptRes, prRes] = await Promise.all([
        api.get('/engineering/prototypes', { params: filterPid ? { project_id: filterPid } : {} }),
        api.get('/engineering/rd-projects'),
      ]);
      setProtos(Array.isArray(ptRes.data.data) ? ptRes.data.data : []);
      setProjects(Array.isArray(prRes.data.data) ? prRes.data.data : []);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally { setLoading(false); }
  }, [filterPid]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (form) => {
    setSaving(true);
    try {
      await api.post('/engineering/prototypes', form);
      setModal(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleUpdate = async (form) => {
    setSaving(true);
    try {
      await api.put(`/engineering/prototypes/${modal.edit.id}`, form);
      setModal(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/engineering/prototypes/${deleteId}`);
      toast.success('Prototype deleted');
      setDeleteId(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed');
    }
  };

  const toDate = iso => iso ? iso.slice(0, 10) : '';

  return (
    <div className="pt-page">
      <div className="pt-header">
        <div className="pt-header-left">
          {setPage && projectId && (
            <button className="pt-back" onClick={() => setPage('DesignPhases', { projectId, projectName })}>
              <ArrowLeft size={14} /> Phases
            </button>
          )}
          <div>
            <h1 className="pt-title">Prototype Tracker</h1>
            <p className="pt-sub">{projectName || 'All Projects'} — prototype iterations</p>
          </div>
        </div>
        <div className="pt-header-right">
          <button className="pt-icon-btn" onClick={load}><RefreshCw size={15} /></button>
          <button className="pt-btn-new" onClick={() => setModal('create')}><Plus size={14} /> New Prototype</button>
        </div>
      </div>

      {/* Filter */}
      <div className="pt-toolbar">
        <select className="pt-filter" value={filterPid} onChange={e => setFilterPid(e.target.value)}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {loading && <div className="pt-center"><div className="pt-spinner" /></div>}
      {!loading && error && <div className="pt-err">{error}</div>}

      {!loading && !error && protos.length === 0 && (
        <div className="pt-empty">
          <TestTube2 size={40} className="pt-empty-icon" />
          <p>No prototypes yet. Log your first iteration.</p>
          <button className="pt-btn-new" onClick={() => setModal('create')}><Plus size={14} /> New Prototype</button>
        </div>
      )}

      {!loading && !error && protos.length > 0 && (
        <div className="pt-table-wrap">
          <table className="pt-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Project</th>
                <th>Title</th>
                <th>Status</th>
                <th>Assigned To</th>
                <th>Build Date</th>
                <th>Test Date</th>
                <th>Result</th>
                <th>Cost (₹)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {protos.map(pt => (
                <tr key={pt.id}>
                  <td className="pt-iter">v{pt.iteration}</td>
                  <td>
                    <div className="pt-proj-name">{pt.project_name}</div>
                    {pt.project_code && <div className="pt-proj-code">{pt.project_code}</div>}
                  </td>
                  <td className="pt-proto-title">{pt.title || `Prototype ${pt.iteration}`}</td>
                  <td><Badge value={pt.status} meta={STATUS_META} /></td>
                  <td>{pt.assigned_to || '—'}</td>
                  <td>{pt.build_date ? new Date(pt.build_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                  <td>{pt.test_date  ? new Date(pt.test_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })  : '—'}</td>
                  <td>
                    {pt.test_result
                      ? <span className="pt-result" style={{ color: RESULT_META[pt.test_result]?.color }}>{RESULT_META[pt.test_result]?.label || pt.test_result}</span>
                      : <span className="pt-result-none">—</span>
                    }
                  </td>
                  <td>{pt.build_cost ? `₹${Number(pt.build_cost).toLocaleString('en-IN')}` : '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="pt-icon-btn" onClick={() => setModal({ edit: pt })} title="Update"><Pencil size={13} /></button>
                      <button className="pt-icon-btn pt-icon-del" onClick={() => setDeleteId(pt.id)} title="Delete"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create modal */}
      {modal === 'create' && (
        <Modal title="New Prototype" onClose={() => setModal(null)}>
          <PrototypeForm
            initial={{ ...EMPTY_FORM, project_id: filterPid || '' }}
            projects={projects}
            onSave={handleCreate}
            onCancel={() => setModal(null)}
            saving={saving}
            isNew
          />
        </Modal>
      )}

      {/* Edit/update modal */}
      {modal?.edit && (
        <Modal title={`Update Prototype v${modal.edit.iteration}`} onClose={() => setModal(null)}>
          <PrototypeForm
            initial={{
              ...modal.edit,
              build_date: toDate(modal.edit.build_date),
              test_date:  toDate(modal.edit.test_date),
              build_cost: modal.edit.build_cost || '',
              test_result:modal.edit.test_result || '',
            }}
            projects={projects}
            onSave={handleUpdate}
            onCancel={() => setModal(null)}
            saving={saving}
          />
        </Modal>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <Modal title="Delete Prototype" onClose={() => setDeleteId(null)}>
          <p style={{ margin: '0 0 20px', color: '#374151' }}>
            Permanently delete this prototype? This cannot be undone.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="pt-btn-cancel" onClick={() => setDeleteId(null)}>Cancel</button>
            <button className="pt-btn-save" style={{ background: '#dc2626' }} onClick={handleDelete}>Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PrototypeForm({ initial, projects, onSave, onCancel, saving, isNew }) {
  const [form, setForm] = useState(initial);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <form className="pt-form" onSubmit={e => { e.preventDefault(); onSave(form); }}>
      {isNew && (
        <label>Project *
          <select required value={form.project_id} onChange={e => set('project_id', e.target.value)}>
            <option value="">— Select project —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      <label>Title
        <input value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Aluminium housing v2" />
      </label>
      {!isNew && (
        <label>Status
          <select value={form.status} onChange={e => set('status', e.target.value)}>
            {STATUS_OPTS.map(s => <option key={s} value={s}>{STATUS_META[s]?.label || s}</option>)}
          </select>
        </label>
      )}
      <label>Specifications
        <textarea rows={3} value={form.specs} onChange={e => set('specs', e.target.value)} placeholder="Dimensions, materials, tolerances…" />
      </label>
      <label>Materials Used
        <input value={form.materials} onChange={e => set('materials', e.target.value)} placeholder="e.g. SS304, Nylon PA6" />
      </label>
      <div className="pt-form-row">
        <label>Assigned To
          <input value={form.assigned_to} onChange={e => set('assigned_to', e.target.value)} />
        </label>
        <label>Build Cost (₹)
          <input type="number" min="0" value={form.build_cost} onChange={e => set('build_cost', e.target.value)} />
        </label>
      </div>
      <div className="pt-form-row">
        <label>Build Date
          <input type="date" value={form.build_date} onChange={e => set('build_date', e.target.value)} />
        </label>
        <label>Test Date
          <input type="date" value={form.test_date} onChange={e => set('test_date', e.target.value)} />
        </label>
      </div>
      {!isNew && (
        <>
          <label>Test Result
            <select value={form.test_result} onChange={e => set('test_result', e.target.value)}>
              <option value="">— Not tested —</option>
              {RESULT_OPTS.map(r => <option key={r} value={r}>{RESULT_META[r].label}</option>)}
            </select>
          </label>
          <label>Test Notes
            <textarea rows={3} value={form.test_notes} onChange={e => set('test_notes', e.target.value)} placeholder="Observations, failures, deviations…" />
          </label>
        </>
      )}
      <div className="pt-form-actions">
        <button type="button" className="pt-btn-cancel" onClick={onCancel}>Cancel</button>
        <button type="submit" className="pt-btn-save" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}
