import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, X, ChevronRight, Search, RefreshCw } from 'lucide-react';
import api from '@/services/api/client';
import './RDProjects.css';
import { useToast } from '@/context/ToastContext';

const STATUS_OPTS = ['concept','design','prototype','testing','approved','cancelled'];
const PRIORITY_OPTS = ['low','medium','high'];
const CATEGORY_OPTS = ['Product Development','Process Improvement','Research','Feasibility Study','Regulatory','Other'];

const STATUS_COLOR = {
  concept:   '#6366f1', design: '#3b82f6', prototype: '#f59e0b',
  testing:   '#8b5cf6', approved: '#10b981', cancelled: '#6b7280',
};
const PRI_COLOR = { high: '#ef4444', medium: '#f59e0b', low: '#10b981' };

const EMPTY_FORM = {
  name: '', code: '', description: '', category: '', status: 'concept',
  priority: 'medium', manager_name: '', team_members: '', budget: '',
  start_date: '', target_date: '', tags: '',
};

function Modal({ title, onClose, children }) {
  return (
    <div className="rdp-overlay" onClick={onClose}>
      <div className="rdp-modal" onClick={e => e.stopPropagation()}>
        <div className="rdp-modal-head">
          <h2>{title}</h2>
          <button className="rdp-icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="rdp-modal-body">{children}</div>
      </div>
    </div>
  );
}

function ProjectForm({ initial, onSave, onCancel, saving }) {
  const [form, setForm] = useState(initial || EMPTY_FORM);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <form className="rdp-form" onSubmit={e => { e.preventDefault(); onSave(form); }}>
      <div className="rdp-form-row">
        <label>Project Name *
          <input required value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Precision Pump v3" />
        </label>
        <label>Code
          <input value={form.code} onChange={e => set('code', e.target.value)} placeholder="e.g. RD-2024-001" />
        </label>
      </div>
      <label>Description
        <textarea rows={3} value={form.description} onChange={e => set('description', e.target.value)} placeholder="Brief objective of this R&D project" />
      </label>
      <div className="rdp-form-row">
        <label>Category
          <select value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="">— Select —</option>
            {CATEGORY_OPTS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label>Status
          <select value={form.status} onChange={e => set('status', e.target.value)}>
            {STATUS_OPTS.map(s => <option key={s} value={s}>{s[0].toUpperCase()+s.slice(1)}</option>)}
          </select>
        </label>
        <label>Priority
          <select value={form.priority} onChange={e => set('priority', e.target.value)}>
            {PRIORITY_OPTS.map(p => <option key={p} value={p}>{p[0].toUpperCase()+p.slice(1)}</option>)}
          </select>
        </label>
      </div>
      <div className="rdp-form-row">
        <label>Project Manager
          <input value={form.manager_name} onChange={e => set('manager_name', e.target.value)} placeholder="Name" />
        </label>
        <label>Team Members
          <input value={form.team_members} onChange={e => set('team_members', e.target.value)} placeholder="Comma-separated names" />
        </label>
      </div>
      <div className="rdp-form-row">
        <label>Budget (₹)
          <input type="number" min="0" value={form.budget} onChange={e => set('budget', e.target.value)} placeholder="0" />
        </label>
        <label>Start Date
          <input type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
        </label>
        <label>Target Date
          <input type="date" value={form.target_date} onChange={e => set('target_date', e.target.value)} />
        </label>
      </div>
      <label>Tags
        <input value={form.tags} onChange={e => set('tags', e.target.value)} placeholder="e.g. hydraulics, pump, mechanical" />
      </label>
      <div className="rdp-form-actions">
        <button type="button" className="rdp-btn-cancel" onClick={onCancel}>Cancel</button>
        <button type="submit" className="rdp-btn-save" disabled={saving}>
          {saving ? 'Saving…' : 'Save Project'}
        </button>
      </div>
    </form>
  );
}

export default function RDProjects({ setPage }) {
  const toast = useToast();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [search, setSearch]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [modal, setModal]       = useState(null); // null | 'create' | {edit: row}
  const [saving, setSaving]     = useState(false);
  const [deleteId, setDeleteId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (search)       params.search = search;
      const r = await api.get('/engineering/rd-projects', { params });
      setProjects(Array.isArray(r.data.data) ? r.data.data : []);
    } catch (e) {
      setError(e.response?.data?.message || e.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (form) => {
    setSaving(true);
    try {
      await api.post('/engineering/rd-projects', form);
      setModal(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleEdit = async (form) => {
    setSaving(true);
    try {
      await api.put(`/engineering/rd-projects/${modal.edit.id}`, form);
      setModal(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    try {
      await api.delete(`/engineering/rd-projects/${deleteId}`);
      setDeleteId(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed');
    }
  };

  const toFormDate = iso => iso ? iso.slice(0, 10) : '';

  return (
    <div className="rdp-page">
      <div className="rdp-header">
        <div>
          <h1 className="rdp-title">R&amp;D Projects</h1>
          <p className="rdp-sub">Track research and development initiatives from concept to approval</p>
        </div>
        <button className="rdp-btn-new" onClick={() => setModal('create')}>
          <Plus size={15} /> New Project
        </button>
      </div>

      <div className="rdp-toolbar">
        <div className="rdp-search">
          <Search size={14} className="rdp-search-icon" />
          <input
            placeholder="Search projects…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="rdp-filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All Statuses</option>
          {STATUS_OPTS.map(s => <option key={s} value={s}>{s[0].toUpperCase()+s.slice(1)}</option>)}
        </select>
        <button className="rdp-icon-btn" onClick={load}><RefreshCw size={15} /></button>
      </div>

      {loading && <div className="rdp-center"><div className="rdp-spinner" /></div>}
      {!loading && error && <div className="rdp-err">{error}</div>}

      {!loading && !error && projects.length === 0 && (
        <div className="rdp-empty">
          <p>No R&amp;D projects found.</p>
          <button className="rdp-btn-new" onClick={() => setModal('create')}><Plus size={14} /> Create First Project</button>
        </div>
      )}

      {!loading && !error && projects.length > 0 && (
        <div className="rdp-grid">
          {projects.map(proj => (
            <div key={proj.id} className="rdp-card">
              <div className="rdp-card-top">
                <div>
                  <div className="rdp-card-name">{proj.name}</div>
                  {proj.code && <div className="rdp-card-code">{proj.code}</div>}
                </div>
                <div className="rdp-card-actions">
                  <button className="rdp-icon-btn" title="Edit" onClick={() => setModal({ edit: proj })}>
                    <Pencil size={14} />
                  </button>
                  <button className="rdp-icon-btn rdp-icon-del" title="Delete" onClick={() => setDeleteId(proj.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="rdp-card-pills">
                <span className="rdp-pill" style={{ background: STATUS_COLOR[proj.status]+'22', color: STATUS_COLOR[proj.status] }}>
                  {proj.status}
                </span>
                <span className="rdp-pill rdp-pri" style={{ background: PRI_COLOR[proj.priority]+'22', color: PRI_COLOR[proj.priority] }}>
                  {proj.priority}
                </span>
                {proj.category && <span className="rdp-pill rdp-cat">{proj.category}</span>}
              </div>

              {proj.description && <p className="rdp-card-desc">{proj.description}</p>}

              <div className="rdp-card-meta">
                {proj.manager_name && <span>👤 {proj.manager_name}</span>}
                {proj.target_date  && <span>📅 {new Date(proj.target_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</span>}
                {proj.budget       && <span>💰 ₹{Number(proj.budget).toLocaleString('en-IN')}</span>}
              </div>

              <div className="rdp-card-stats">
                <span>{proj.phase_count || 0} phases · {proj.phases_done || 0} done</span>
                <span>{proj.proto_count || 0} prototypes</span>
                <span>{proj.tests_passed || 0}/{proj.test_count || 0} tests ✓</span>
              </div>

              {setPage && (
                <button className="rdp-card-open" onClick={() => setPage('DesignPhases', { projectId: proj.id, projectName: proj.name })}>
                  View Design Phases <ChevronRight size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create modal */}
      {modal === 'create' && (
        <Modal title="New R&D Project" onClose={() => setModal(null)}>
          <ProjectForm onSave={handleCreate} onCancel={() => setModal(null)} saving={saving} />
        </Modal>
      )}

      {/* Edit modal */}
      {modal?.edit && (
        <Modal title="Edit Project" onClose={() => setModal(null)}>
          <ProjectForm
            initial={{
              ...modal.edit,
              start_date:  toFormDate(modal.edit.start_date),
              target_date: toFormDate(modal.edit.target_date),
              budget:      modal.edit.budget || '',
            }}
            onSave={handleEdit}
            onCancel={() => setModal(null)}
            saving={saving}
          />
        </Modal>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <Modal title="Delete Project" onClose={() => setDeleteId(null)}>
          <p style={{ margin: '0 0 20px', color: '#374151' }}>
            Are you sure? This will archive the project and all linked phases, prototypes and test plans.
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="rdp-btn-cancel" onClick={() => setDeleteId(null)}>Cancel</button>
            <button className="rdp-btn-del-confirm" onClick={handleDelete}>Delete</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
