import { useState, useEffect, useCallback, useRef } from 'react';
import { AlertTriangle, Plus, X, CheckCircle, Clock, Filter, Search, RefreshCw, Flag } from 'lucide-react';
import { getProjectIssues, createProjectIssue, updateProjectIssue, deleteProjectIssue, getProjects, getProjectEmployees } from '../services/projectsService';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const SEVERITY_META = {
  critical: { bg: '#ffd4d4', color: '#b91c1c', label: 'Critical' },
  high:     { bg: '#fee2e2', color: '#dc2626', label: 'High' },
  medium:   { bg: '#fef3c7', color: '#92400e', label: 'Medium' },
  low:      { bg: '#f3f4f6', color: '#6b7280', label: 'Low' },
};

const STATUS_META = {
  open:        { bg: '#fee2e2', color: '#dc2626', label: 'Open' },
  in_progress: { bg: '#fef3c7', color: '#92400e', label: 'In Progress' },
  resolved:    { bg: '#dcfce7', color: '#15803d', label: 'Resolved' },
  closed:      { bg: '#f3f4f6', color: '#6b7280', label: 'Closed' },
  wont_fix:    { bg: '#e0e7ff', color: '#4338ca', label: "Won't Fix" },
};

const ISSUE_TYPES = ['general', 'technical', 'scope', 'resource', 'schedule', 'quality', 'commercial'];

const empty = () => ({
  title: '', description: '', issue_type: 'general', severity: 'medium',
  priority: 'medium', assigned_to: '', due_date: '', is_blocker: false,
  root_cause: '', status: 'open', resolution: '',
});

export default function IssueManagement({ setPage, urlParams }) {
  const [projects,    setProjects]    = useState([]);
  const [selectedPid, setSelectedPid] = useState('');
  const [issues,      setIssues]      = useState([]);
  const [employees,   setEmployees]   = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [drawer,      setDrawer]      = useState(false);
  const [editItem,    setEditItem]    = useState(null);
  const [form,        setForm]        = useState(empty());
  const [search,      setSearch]      = useState('');
  const [statusFilter,setStatusFilter]= useState('all');
  const [toast,       setToast]       = useState(null);
  const [pendingHandleDelete, setPendingHandleDelete] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const pid = urlParams?.id || sessionStorage.getItem('selectedProjectId');
    if (pid) setSelectedPid(String(pid));

    Promise.all([getProjects(), getProjectEmployees()]).then(([prjs, emps]) => {
      if (!isMounted.current) return;
      setProjects(prjs);
      setEmployees(emps);
    });
  }, []);

  const load = useCallback(async () => {
    if (!selectedPid) return;
    setLoading(true);
    try {
      const data = await getProjectIssues(selectedPid);
      if (isMounted.current) setIssues(Array.isArray(data) ? data : []);
    } catch { /* handled */ }
    if (isMounted.current) setLoading(false);
  }, [selectedPid]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => { setEditItem(null); setForm(empty()); setDrawer(true); };
  const openEdit   = (i) => { setEditItem(i); setForm({ ...i }); setDrawer(true); };

  const handleSave = async () => {
    if (!form.title) return showToast('Issue title required', 'error');
    if (!selectedPid) return showToast('Select a project first', 'error');
    try {
      if (editItem) {
        await updateProjectIssue(editItem.id, form);
        showToast('Issue updated');
      } else {
        await createProjectIssue(selectedPid, form);
        showToast('Issue created');
      }
      setDrawer(false);
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to save issue', 'error');
    }
  };

  const handleDelete = async () => {
    if (!pendingHandleDelete) return;
    const id = pendingHandleDelete;
    setPendingHandleDelete(null);
    try {
      await deleteProjectIssue(id);
      showToast('Issue deleted');
      load();
    } catch { showToast('Delete failed', 'error'); }
  };

  const handleStatusChange = async (issue, newStatus) => {
    try {
      await updateProjectIssue(issue.id, { ...issue, status: newStatus });
      setIssues(is => is.map(i => i.id === issue.id ? { ...i, status: newStatus } : i));
    } catch { showToast('Failed to update status', 'error'); }
  };

  const f = (v) => form[v];
  const sf = (k) => (e) => setForm(prev => ({ ...prev, [k]: e.target?.value ?? e }));

  const filtered = issues.filter(i => {
    const q = search.toLowerCase();
    const matchQ = !q || i.title?.toLowerCase().includes(q) || i.issue_code?.toLowerCase().includes(q);
    const matchS = statusFilter === 'all' || i.status === statusFilter;
    return matchQ && matchS;
  });

  const openCount    = issues.filter(i => i.status === 'open').length;
  const blockerCount = issues.filter(i => i.is_blocker).length;
  const resolvedCount= issues.filter(i => ['resolved','closed'].includes(i.status)).length;

  return (
    <div style={{ padding: '20px 24px' }}>

      <ConfirmDialog
        open={!!pendingHandleDelete}
        title="Delete Issue"
        message="Delete this issue?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingHandleDelete(null)}
      />
      {toast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, padding: '10px 16px', borderRadius: 8, zIndex: 9999,
          background: toast.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color: toast.type === 'error' ? '#dc2626' : '#15803d',
          border: `1px solid ${toast.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
        }}>{toast.msg}</div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            Issue Management
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>
            Track blockers, technical issues, scope deviations, and NCRs
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            <Plus size={14} /> Raise Issue
          </button>
        </div>
      </div>

      {/* Project selector */}
      <div style={{ marginBottom: 16 }}>
        <select
          value={selectedPid}
          onChange={e => setSelectedPid(e.target.value)}
          style={{ padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 6, minWidth: 280, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
        >
          <option value="">— Select Project —</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.project_code} — {p.project_name}</option>)}
        </select>
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Issues', value: issues.length, color: '#6366f1', bg: '#eef2ff' },
          { label: 'Open', value: openCount, color: '#dc2626', bg: '#fef2f2' },
          { label: 'Blockers', value: blockerCount, color: '#ea580c', bg: '#fff7ed' },
          { label: 'Resolved', value: resolvedCount, color: '#15803d', bg: '#f0fdf4' },
        ].map(k => (
          <div key={k.label} style={{ background: k.bg, borderRadius: 8, padding: '14px 16px', border: `1px solid ${k.color}22` }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: k.color }}>{k.value}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search issues…"
            style={{ width: '100%', padding: '8px 8px 8px 32px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}
          />
        </div>
        {['all', 'open', 'in_progress', 'resolved', 'closed'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)} style={{
            padding: '6px 12px', borderRadius: 20, cursor: 'pointer', fontWeight: 500, fontSize: 12,
            background: statusFilter === s ? '#dc2626' : 'var(--color-background)',
            color: statusFilter === s ? '#fff' : 'var(--color-text-secondary)',
            border: `1px solid ${statusFilter === s ? '#dc2626' : 'var(--color-border)'}`,
          }}>
            {STATUS_META[s]?.label || 'All'}
          </button>
        ))}
      </div>

      {/* Issue table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 48, color: 'var(--color-text-secondary)' }}>Loading issues…</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <AlertTriangle size={36} style={{ color: '#9ca3af', marginBottom: 8 }} />
          <p style={{ color: '#6b7280', margin: 0 }}>No issues {selectedPid ? 'found' : '— select a project first'}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(issue => {
            const sev = SEVERITY_META[issue.severity] || SEVERITY_META.medium;
            const sts = STATUS_META[issue.status] || STATUS_META.open;
            return (
              <div key={issue.id} style={{
                background: 'var(--color-background-secondary)',
                border: `1px solid ${issue.is_blocker ? '#fca5a5' : 'var(--color-border-tertiary)'}`,
                borderRadius: 8, padding: '14px 16px',
                borderLeft: `4px solid ${sev.color}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{issue.issue_code}</span>
                      <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: sev.bg, color: sev.color }}>
                        {sev.label}
                      </span>
                      <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: sts.bg, color: sts.color }}>
                        {sts.label}
                      </span>
                      {issue.is_blocker && (
                        <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: '#ffd4d4', color: '#b91c1c' }}>
                          🔴 BLOCKER
                        </span>
                      )}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-text-primary)', marginBottom: 4 }}>
                      {issue.title}
                    </div>
                    {issue.description && (
                      <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 6px', lineHeight: 1.4 }}>
                        {issue.description}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#9ca3af', flexWrap: 'wrap' }}>
                      <span>Type: <b style={{ color: 'var(--color-text-secondary)' }}>{issue.issue_type}</b></span>
                      {issue.assigned_to_name && <span>Assigned: <b style={{ color: 'var(--color-text-secondary)' }}>{issue.assigned_to_name}</b></span>}
                      {issue.raised_by_name && <span>Raised by: <b style={{ color: 'var(--color-text-secondary)' }}>{issue.raised_by_name}</b></span>}
                      {issue.due_date && <span style={{ color: new Date(issue.due_date) < new Date() && issue.status !== 'closed' ? '#dc2626' : undefined }}>Due: <b>{new Date(issue.due_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</b></span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    <select
                      value={issue.status}
                      onChange={e => handleStatusChange(issue, e.target.value)}
                      style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 12, background: 'var(--color-background)', color: 'var(--color-text-primary)', cursor: 'pointer' }}
                    >
                      {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                    <button onClick={() => openEdit(issue)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-background)', cursor: 'pointer', fontSize: 12 }}>Edit</button>
                    <button onClick={() => setPendingHandleDelete(issue.id)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid #fecaca', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', fontSize: 12 }}>Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Drawer */}
      {drawer && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}
          onClick={() => setDrawer(false)}>
          <div style={{ width: 520, background: 'var(--color-background)', height: '100%', overflowY: 'auto', padding: 24 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0 }}>{editItem ? 'Edit Issue' : 'Raise Issue'}</h3>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            {[
              { label: 'Title *', key: 'title', type: 'text', placeholder: 'Describe the issue…' },
              { label: 'Description', key: 'description', type: 'textarea' },
            ].map(field => (
              <div key={field.key} style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>{field.label}</label>
                {field.type === 'textarea'
                  ? <textarea rows={3} value={f(field.key)} onChange={sf(field.key)} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
                  : <input type={field.type} value={f(field.key)} onChange={sf(field.key)} placeholder={field.placeholder} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
                }
              </div>
            ))}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Issue Type</label>
                <select value={f('issue_type')} onChange={sf('issue_type')} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                  {ISSUE_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1).replace('_', ' ')}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Severity</label>
                <select value={f('severity')} onChange={sf('severity')} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                  {['critical','high','medium','low'].map(s => <option key={s} value={s}>{SEVERITY_META[s].label}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Assign To</label>
                <select value={f('assigned_to')} onChange={sf('assigned_to')} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                  <option value="">— Unassigned —</option>
                  {employees.map(e => <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Due Date</label>
                <input type="date" value={f('due_date')} onChange={sf('due_date')} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
            </div>

            {editItem && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Status</label>
                <select value={f('status')} onChange={sf('status')} style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', color: 'var(--color-text-primary)' }}>
                  {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Root Cause</label>
              <textarea rows={2} value={f('root_cause')} onChange={sf('root_cause')} placeholder="What caused this issue?" style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
            </div>

            {editItem && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>Resolution</label>
                <textarea rows={2} value={f('resolution')} onChange={sf('resolution')} placeholder="How was this resolved?" style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--color-border)', borderRadius: 6, resize: 'vertical', background: 'var(--color-background)', color: 'var(--color-text-primary)' }} />
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={f('is_blocker')} onChange={e => setForm(prev => ({ ...prev, is_blocker: e.target.checked }))} />
                <span style={{ fontSize: 13, fontWeight: 600, color: '#dc2626' }}>Mark as Blocker</span>
              </label>
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setDrawer(false)} style={{ padding: '10px 20px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-background)', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSave} style={{ padding: '10px 20px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}>
                {editItem ? 'Update Issue' : 'Raise Issue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
