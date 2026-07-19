import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Search, Plus, RefreshCw, X, FolderKanban,
  Users, Calendar, ChevronRight, Lock, AlertCircle, MapPin
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import { getProjects, createProject } from '../services/projectsService';
import WorkflowBadge from '@/features/_shared/WorkflowBadge';
import './Projects.css';

const STATUS_META = {
  active:    { bg: '#dcfce7', color: '#15803d', label: 'Active'    },
  planning:  { bg: '#dbeafe', color: '#1d4ed8', label: 'Planning'  },
  on_hold:   { bg: '#fef3c7', color: '#92400e', label: 'On Hold'   },
  completed: { bg: '#f3f4f6', color: '#6b7280', label: 'Completed' },
  cancelled: { bg: '#fee2e2', color: '#dc2626', label: 'Cancelled' },
};
const sm = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.planning;

const HEALTH = p => {
  const pct    = p.total_tasks    ? (p.completed_tasks / p.total_tasks) * 100 : 0;
  const budPct = p.budget_amount  ? (p.actual_cost / p.budget_amount) * 100   : 0;
  if (p.status === 'completed') return { label: 'Completed', color: '#10b981' };
  if (budPct > 90 || (p.end_date && new Date(p.end_date) < new Date() && pct < 100)) return { label: 'Delayed',  color: '#ef4444' };
  if (budPct > 75 || pct < 30) return { label: 'At Risk',  color: '#f59e0b' };
  return { label: 'On Track', color: '#10b981' };
};

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const STATUSES  = ['active', 'planning', 'on_hold', 'completed', 'cancelled'];
const PROJECT_TYPES = ['EPC', 'HVDC', 'STATCOM', 'SST', 'AMC', 'Installation', 'Commissioning', 'O&M', 'Supply', 'Turnkey'];
const today     = new Date().toISOString().slice(0, 10);
const emptyForm = () => ({
  project_code: '', project_name: '', customer_name: '',
  project_manager_id: '',
  start_date: today, end_date: '', budget_amount: '',
  status: 'planning', description: '',
  project_type: 'EPC',
  zone: '', site_city: '', site_address: '', latitude: '', longitude: '',
});

/** Extracts user-friendly error strings from an Axios error response. */
function parseApiErrors(err) {
  const data = err?.response?.data;
  if (!data) return ['Something went wrong. Please try again.'];
  if (Array.isArray(data.details)) return data.details.map(d => d.message || String(d));
  if (Array.isArray(data.errors))  return data.errors.map(e => e.message || String(e));
  if (typeof data.error   === 'string') return [data.error];
  if (typeof data.message === 'string') return [data.message];
  return ['Something went wrong. Please try again.'];
}

function ValidationErrors({ errors }) {
  if (!errors || errors.length === 0) return null;
  return (
    <div style={{
      background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8,
      padding: '10px 14px', marginBottom: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#b91c1c', fontWeight: 600, fontSize: 13, marginBottom: errors.length > 1 ? 6 : 0 }}>
        <AlertCircle size={14} /> Please fix the following:
      </div>
      {errors.length > 1 ? (
        <ul style={{ margin: 0, paddingLeft: 18, color: '#991b1b', fontSize: 12, lineHeight: 1.7 }}>
          {errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      ) : (
        <p style={{ margin: 0, color: '#991b1b', fontSize: 12 }}>{errors[0]}</p>
      )}
    </div>
  );
}

export default function Projects({ setPage }) {
  const { hasPermission } = useAuth();
  const { readOnly } = usePageAccess();

  const canAdd    = !readOnly && hasPermission('projects', 'add');
  const canEdit   = !readOnly && hasPermission('projects', 'edit');
  const canDelete = !readOnly && hasPermission('projects', 'delete');

  const [projects,    setProjects]    = useState([]);
  const [employees,   setEmployees]   = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [wfStatuses,  setWfStatuses]  = useState({});  // { projectId: workflowObj }
  const [wfLoading,   setWfLoading]   = useState(false);
  const [search,      setSearch]      = useState('');
  const [fStatus,     setFStatus]     = useState('');
  const [drawer,      setDrawer]      = useState(false);
  const [form,        setForm]        = useState(emptyForm());
  const [submitting,  setSubmitting]  = useState(false);
  const [formErrors,  setFormErrors]  = useState([]);
  const [toast,       setToast]       = useState(null);
  const [geocoding,   setGeocoding]   = useState(false);
  const [geoMsg,      setGeoMsg]      = useState(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ---- fetch workflow statuses (batch) after projects load -----------------
  const fetchWorkflowStatuses = useCallback(async (projectList) => {
    if (!projectList.length) return;

    try {
      const ids = projectList.map(p => p.id);
      const res = await api.post('/workflows/batch-status', { module: 'Project', entity_ids: ids });
      if (!isMounted.current) return;
      setWfStatuses(res.data || {});
    } catch {
      // non-critical
    } finally {
      if (isMounted.current) setWfLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await getProjects(fStatus ? { status: fStatus } : {});
      if (!isMounted.current) return;
      const list = Array.isArray(raw) ? raw : [];
      setProjects(list);
      fetchWorkflowStatuses(list);
    } catch {
      if (!isMounted.current) return;
      setProjects([]);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [fStatus, fetchWorkflowStatuses]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const handler = () => load();
    window.addEventListener('pulse:tasks-updated', handler);
    return () => window.removeEventListener('pulse:tasks-updated', handler);
  }, [load]);

  useEffect(() => {
    api.get('/projects/employees')
      .then(res => { if (isMounted.current) setEmployees(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (isMounted.current) setEmployees([]); });
  }, []);

  const openDrawer = async () => {
    if (!canAdd) return;
    const f = emptyForm();
    try {
      const res = await api.get('/projects/projects/next-code');
      f.project_code = res.data?.code || '';
    } catch { /* leave blank */ }
    setForm(f);
    setFormErrors([]);
    setGeoMsg(null);
    setDrawer(true);
  };

  const handleSubmit = async () => {
    if (!form.project_name.trim()) {
      setFormErrors(['Project name is required.']);
      return;
    }
    setSubmitting(true);
    setFormErrors([]);
    try {
      const payload = {
        ...form,
        end_date:           form.end_date           || null,
        budget_amount:      form.budget_amount       || null,
        // `budget` mirrors budget_amount: the projects module's active validation
        // rule targets `budget` and rejects an absent value, so always send a number.
        budget:             Number(form.budget_amount) || 0,
        project_manager_id: form.project_manager_id || null,
        latitude:           form.latitude  === '' ? null : form.latitude,
        longitude:          form.longitude === '' ? null : form.longitude,
      };
      await createProject(payload);
      showToast('Project created');
      setDrawer(false);
      setForm(emptyForm());
      load();
    } catch (err) {
      setFormErrors(parseApiErrors(err));
    } finally { setSubmitting(false); }
  };

  // Geocode the site address/city/state → lat/lng via Nominatim (same free
  // service the Attendance geo-fence map uses). Fills only blank location fields.
  const geocodeSite = async () => {
    const q = [form.site_address, form.site_city, form.zone].filter(Boolean).join(', ');
    if (!q.trim()) { setGeoMsg('Enter a site address, city or state first.'); return; }
    setGeocoding(true);
    setGeoMsg(null);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=1&accept-language=en`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        const hit = data[0];
        const a = hit.address || {};
        setForm(f => ({
          ...f,
          latitude:  parseFloat(hit.lat).toFixed(7),
          longitude: parseFloat(hit.lon).toFixed(7),
          zone:      f.zone      || a.state || '',
          site_city: f.site_city || a.city || a.town || a.village || a.county || '',
        }));
        setGeoMsg('Coordinates found — review and adjust if needed.');
      } else {
        setGeoMsg('No match found. Enter latitude/longitude manually.');
      }
    } catch {
      setGeoMsg('Lookup failed. Enter latitude/longitude manually.');
    } finally { setGeocoding(false); }
  };

  const openProject = p => {
    sessionStorage.setItem('selectedProjectId', p.id);
    sessionStorage.setItem('selectedProject', JSON.stringify(p));
    if (setPage) setPage('ProjectDetail', { id: p.id });
  };

  const displayed = projects.filter(p => {
    const q = search.toLowerCase();
    return (!q || p.project_name?.toLowerCase().includes(q) || p.customer_name?.toLowerCase().includes(q) || p.manager_name?.toLowerCase().includes(q))
        && (!fStatus || p.status === fStatus);
  });

  const counts = STATUSES.reduce((acc, s) => {
    acc[s] = projects.filter(p => p.status === s).length;
    return acc;
  }, {});

  const setF = (k, v) => { setForm(f => ({ ...f, [k]: v })); if (formErrors.length) setFormErrors([]); };

  return (
    <div className="pj-root">
      {toast && <div className={`pj-toast pj-toast-${toast.type}`}>{toast.msg}</div>}

      {readOnly && <ReadOnlyBanner />}

      <div className="pj-header">
        <div>
          <h2 className="pj-title">Projects</h2>
          <p className="pj-sub">{displayed.length} project{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="pj-header-r">
          <button className="pj-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          {canAdd ? (
            <button className="pj-btn-primary" onClick={openDrawer}>
              <Plus size={14} /> New Project
            </button>
          ) : (
            <button className="pj-btn-primary" disabled
              title="You don't have permission to create projects"
              style={{ opacity: 0.45, cursor: 'not-allowed' }}>
              <Lock size={13} /> New Project
            </button>
          )}
        </div>
      </div>

      <div className="pj-filters">
        <div className="pj-search">
          <Search size={14} />
          <input placeholder="Search project, customer, manager…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="pj-tabs">
          <button className={`pj-tab${!fStatus ? ' pj-tab-active' : ''}`} onClick={() => setFStatus('')}>
            All <span className="pj-tab-count">{projects.length}</span>
          </button>
          {STATUSES.map(s => (
            <button key={s} className={`pj-tab${fStatus === s ? ' pj-tab-active' : ''}`} onClick={() => setFStatus(s)}>
              {sm(s).label} <span className="pj-tab-count">{counts[s] || 0}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="pj-loading"><div className="pj-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="pj-empty">
          <FolderKanban size={40} color="#d1d5db" />
          <p>No projects found</p>
          {canAdd && <button className="pj-btn-primary" onClick={openDrawer}><Plus size={14} /> New Project</button>}
        </div>
      ) : (
        <div className="pj-grid">
          {displayed.map(p => {
            const s       = sm(p.status);
            const h       = HEALTH(p);
            const taskPct = p.total_tasks    ? Math.round((p.completed_tasks / p.total_tasks) * 100) : 0;
            const budPct  = p.budget_amount  ? Math.round((p.actual_cost    / p.budget_amount) * 100) : 0;
            const wf      = wfStatuses[p.id] ?? null;

            return (
              <div key={p.id} className="pj-card" onClick={() => openProject(p)}>
                <div className="pj-card-hd">
                  <div>
                    <span className="pj-code">{p.project_code}</span>
                    <h3 className="pj-name">{p.project_name}</h3>
                  </div>
                  <div className="pj-card-badges">
                    <span className="pj-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span>
                    <span className="pj-health" style={{ color: h.color }}>● {h.label}</span>
                  </div>
                </div>

                <div className="pj-card-meta">
                  <span><Users size={12} /> {p.manager_name || '—'}</span>
                  {p.end_date && (
                    <span>
                      <Calendar size={12} /> {new Date(p.end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                    </span>
                  )}
                  {p.team_size && <span><Users size={12} /> {p.team_size} members</span>}
                </div>

                {/* ── Workflow status (shows when a workflow instance exists) ── */}
                {(wf || wfLoading) && (
                  <div style={{ margin: '8px 0 4px', borderTop: '1px solid #f3f4f6', paddingTop: 8 }}
                    onClick={e => e.stopPropagation()}>
                    <WorkflowBadge workflow={wf} loading={wfLoading} compact />
                  </div>
                )}

                <div className="pj-prog-row">
                  <div className="pj-prog-item">
                    <div className="pj-prog-lbl">
                      <span>Tasks</span>
                      <span>{p.completed_tasks || 0}/{p.total_tasks || 0}</span>
                    </div>
                    <div className="pj-track"><div className="pj-fill" style={{ width: `${taskPct}%`, background: '#6366f1' }} /></div>
                  </div>
                  <div className="pj-prog-item">
                    <div className="pj-prog-lbl">
                      <span>Budget</span>
                      <span style={{ color: budPct > 85 ? '#ef4444' : undefined }}>{fmt(p.actual_cost)} / {fmt(p.budget_amount)}</span>
                    </div>
                    <div className="pj-track"><div className="pj-fill" style={{ width: `${Math.min(budPct, 100)}%`, background: budPct > 85 ? '#ef4444' : '#10b981' }} /></div>
                  </div>
                </div>

                <div className="pj-card-ft">
                  <span className="pj-customer">{p.customer_name || '—'}</span>
                  <ChevronRight size={14} color="#9ca3af" />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Project Drawer */}
      {drawer && (
        <div className="pj-overlay" onClick={() => setDrawer(false)}>
          <div className="pj-drawer" onClick={e => e.stopPropagation()}>
            <div className="pj-drawer-hd">
              <h3>New Project</h3>
              <button className="pj-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="pj-drawer-body">
              <ValidationErrors errors={formErrors} />

              <div className="pj-field">
                <label>Project Code</label>
                <input value={form.project_code} readOnly style={{ background: '#f9fafb', color: '#6b7280' }} />
              </div>
              <div className="pj-field">
                <label>Project Name <span className="pj-req">*</span></label>
                <input value={form.project_name} onChange={e => setF('project_name', e.target.value)} placeholder="Project name…" />
              </div>
              <div className="pj-row2">
                <div className="pj-field">
                  <label>Customer</label>
                  <input value={form.customer_name} onChange={e => setF('customer_name', e.target.value)} placeholder="Customer name…" />
                </div>
                <div className="pj-field">
                  <label>Project Manager</label>
                  <select value={form.project_manager_id} onChange={e => setF('project_manager_id', e.target.value)}>
                    <option value="">— Select manager —</option>
                    {employees.map(emp => (
                      <option key={emp.id} value={emp.id}>{`${emp.first_name || ''} ${emp.last_name || ''}`.trim()}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="pj-row2">
                <div className="pj-field">
                  <label>Start Date</label>
                  <input type="date" value={form.start_date} onChange={e => setF('start_date', e.target.value)} />
                </div>
                <div className="pj-field">
                  <label>End Date</label>
                  <input type="date" value={form.end_date} onChange={e => setF('end_date', e.target.value)} />
                </div>
              </div>
              <div className="pj-row2">
                <div className="pj-field">
                  <label>Budget (₹)</label>
                  <input type="number" value={form.budget_amount} onChange={e => setF('budget_amount', e.target.value)} placeholder="0" />
                </div>
                <div className="pj-field">
                  <label>Status</label>
                  <select value={form.status} onChange={e => setF('status', e.target.value)}>
                    {STATUSES.map(s => <option key={s} value={s}>{sm(s).label}</option>)}
                  </select>
                </div>
              </div>
              <div className="pj-field">
                <label>Project Type</label>
                <select value={form.project_type} onChange={e => setF('project_type', e.target.value)}>
                  {PROJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="pj-field">
                <label>Description</label>
                <textarea rows={3} value={form.description} onChange={e => setF('description', e.target.value)} placeholder="Project description…" />
              </div>

              {/* Installation site — powers the Installation Dashboard map & zone charts */}
              <div style={{ margin: '10px 0 2px', fontSize: 11.5, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, display: 'flex', alignItems: 'center', gap: 6 }}>
                <MapPin size={13} /> Installation Site
              </div>
              <div className="pj-row2">
                <div className="pj-field">
                  <label>State (Zone)</label>
                  <input value={form.zone} onChange={e => setF('zone', e.target.value)} placeholder="e.g. Tamil Nadu" />
                </div>
                <div className="pj-field">
                  <label>City</label>
                  <input value={form.site_city} onChange={e => setF('site_city', e.target.value)} placeholder="e.g. Chennai" />
                </div>
              </div>
              <div className="pj-field">
                <label>Site Address</label>
                <input value={form.site_address} onChange={e => setF('site_address', e.target.value)} placeholder="Installation site address…" />
              </div>
              <div className="pj-row2">
                <div className="pj-field">
                  <label>Latitude</label>
                  <input type="number" step="0.0000001" value={form.latitude} onChange={e => setF('latitude', e.target.value)} placeholder="e.g. 13.0827" />
                </div>
                <div className="pj-field">
                  <label>Longitude</label>
                  <input type="number" step="0.0000001" value={form.longitude} onChange={e => setF('longitude', e.target.value)} placeholder="e.g. 80.2707" />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
                <button type="button" className="pj-btn-outline" onClick={geocodeSite} disabled={geocoding}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <MapPin size={14} /> {geocoding ? 'Locating…' : 'Locate from address'}
                </button>
                {geoMsg && <span style={{ fontSize: 12, color: '#6b7280' }}>{geoMsg}</span>}
              </div>
            </div>
            <div className="pj-drawer-ft">
              <button className="pj-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="pj-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
