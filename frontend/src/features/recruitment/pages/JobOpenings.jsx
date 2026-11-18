import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search, Plus, RefreshCw, X, Briefcase, MapPin, Users, Clock,
  ChevronRight, Building2, Edit2, PauseCircle, PlayCircle, XCircle,
  UserPlus, Trash2, ArrowLeft,
} from 'lucide-react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import { matchesSearch } from '../shared/search';
import './JobOpenings.css';
import JobTimeline from '../shared/components/JobTimeline';
import { PageHero, PageShell } from '@/components/pulse-ui';
import MasterSelect from '@/components/core/MasterSelect';

const STATUS_META = {
  open:             { bg: '#dcfce7', color: '#15803d', label: 'Open'     },
  draft:            { bg: '#f3f4f6', color: '#6b7280', label: 'Draft'    },
  closed:           { bg: '#fee2e2', color: '#dc2626', label: 'Closed'   },
  on_hold:          { bg: '#ede9fe', color: '#5b21b6', label: 'On hold'  },
  paused:           { bg: '#ede9fe', color: '#5b21b6', label: 'On hold'  },
  cancelled:        { bg: '#f3f4f6', color: '#991b1b', label: 'Cancelled' },
  pending_approval: { bg: '#e0e7ff', color: '#4338ca', label: 'Pending'  },
};
const sm = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.draft;

const TYPE_META = {
  full_time: { bg: '#dbeafe', color: '#1d4ed8', label: 'Full Time'  },
  contract:  { bg: '#fce7f3', color: '#9d174d', label: 'Contract'   },
  intern:    { bg: '#ede9fe', color: '#5b21b6', label: 'Intern'      },
  part_time: { bg: '#f3e8ff', color: '#6B3FDB', label: 'Part Time'  },
};
const tm = t => TYPE_META[(t || '').toLowerCase()] || TYPE_META.full_time;

// Departments come from the master via <MasterSelect>, which also offers an
// inline add so a missing one does not mean a trip to Master Setup.
// The hardcoded array that was here disagreed with every other screen's, so a
// record created here could carry a department name no report could group by.
const EMP_TYPES   = ['full_time', 'contract', 'intern', 'part_time'];

// Each field is its own column (migration 20261117000002). Experience and
// salary are numeric ranges; they used to be free text squashed into one
// `requirements` string and lost on edit.
const emptyForm = () => ({
  requisition_id: '', job_title: '', department: '', employment_type: 'full_time',
  number_of_positions: 1, description: '', skills_required: '',
  experience_min: '', experience_max: '', salary_min: '', salary_max: '', location: '',
  closing_date: '',
});
const inr = (n) => (n == null || n === '' ? '' : `₹${Number(n).toLocaleString('en-IN')}`);
const rangeText = (a, b, fmt = (x) => x) => (a != null && b != null ? `${fmt(a)} – ${fmt(b)}` : a != null ? `from ${fmt(a)}` : b != null ? `up to ${fmt(b)}` : '');

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = (v) => {
  if (!v) return '';
  const d = new Date(String(v).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};
const STATUS_WORD = { open: 'reopened', on_hold: 'put on hold', closed: 'closed', cancelled: 'cancelled' };

/**
 * `embedded`: rendered inside the Jobs hub, which owns the page shell and
 * header (a second PageShell duplicated the header and steals clicks).
 *
 * `panelOnly` (2026-11-17, owner): the Job Openings tab was removed — a job is
 * posted and edited from its requisition. Requisitions renders this component
 * with `requisitionId` (post the job for that approved requisition) or
 * `openingId` (edit that job), and only the job panel is drawn. `onClose(msg)`
 * returns to the requisition; `onChanged()` asks it to reload after a status move.
 */
export default function JobOpenings({ setPage, embedded = false, panelOnly = false, requisitionId = null, openingId = null, onClose, onChanged }) {
  const setSelectedJobId = useAppStore(s => s.setSelectedJobId);
  const [jobs,       setJobs]       = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');
  const [drawer,     setDrawer]     = useState(false);
  const [editingId,  setEditingId]  = useState(null);
  const [timelineKey, setTimelineKey] = useState(0);
  // The view / form opens in place of the cards, inside the tab — not over
  // the page. Bring the top of the page into view when it opens.
  useEffect(() => {
    if (!drawer) return;
    try {
      document.querySelector('.page-content')?.scrollTo?.({ top: 0 });
      window.scrollTo?.({ top: 0 });
    } catch { /* jsdom */ }
  }, [drawer, editingId]);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);
  const [loadError,  setLoadError]  = useState('');
  const [requisitions, setRequisitions] = useState([]);
  // The requisition the form is bound to: its approved head count, budget,
  // department and type are the limits the opening must stay inside.
  const [linkedReq, setLinkedReq] = useState(null);
  const [sp, setSp] = useSearchParams();

  const loadRequisitions = useCallback(async () => {
    try {
      const res = await api.get('/recruitment/requisitions', { params: { status: 'approved' } });
      setRequisitions(Array.isArray(res.data) ? res.data : []);
      return Array.isArray(res.data) ? res.data : [];
    } catch { setRequisitions([]); return []; }
  }, []);

  // A requisition fills the form: the approved title, department, type, head
  // count, location and skills come with it.
  const applyRequisition = (r) => {
    const v = (x, fb) => (x == null || x === '' ? fb : String(x));
    setLinkedReq(r);
    setForm(f => ({
      ...f, requisition_id: String(r.id), job_title: r.job_title || f.job_title, department: r.department || f.department,
      employment_type: r.employment_type || f.employment_type, number_of_positions: r.number_of_positions || f.number_of_positions,
      location: r.location || f.location, skills_required: r.skills_required || f.skills_required,
      description: r.job_description || f.description,
      experience_min: v(r.experience_min, f.experience_min), experience_max: v(r.experience_max, f.experience_max),
      salary_min: v(r.salary_min, f.salary_min), salary_max: v(r.salary_max, f.salary_max),
    }));
  };

  const openCreate = async (presetId = null) => {
    setEditingId(null);
    setLinkedReq(null);
    setForm(emptyForm());
    setDrawer(true);
    const list = await loadRequisitions();
    const r = presetId && list.find(x => String(x.id) === String(presetId));
    if (r) applyRequisition(r);
  };

  // Arriving from Requisitions → "Post job opening" (prop), or an old
  // ?requisition=<id> link.
  useEffect(() => {
    if (panelOnly) { if (requisitionId) openCreate(requisitionId); return; }
    const id = sp.get('requisition');
    if (!id) return;
    openCreate(id);
    setSp(prev => { const n = new URLSearchParams(prev); n.delete('requisition'); return n; }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Every status is fetched and the tab filters here — fetching per tab made
  // every other tab's count read 0 and "All" show only the current tab.
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await api.get('/recruitment/openings');
      const raw = res.data?.openings || res.data || [];
      setJobs(Array.isArray(raw) ? raw : []);
    } catch (err) {
      setJobs([]);
      setLoadError(err?.response?.data?.error || 'Could not load job openings. Check your connection and try again.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Arriving from Requisitions → "View job" with ?opening=<id>: open that job
  // once the list has loaded.
  const [pendingOpening, setPendingOpening] = useState(() => (panelOnly ? openingId : sp.get('opening')));
  useEffect(() => {
    if (!pendingOpening || loading) return;
    const job = jobs.find(j => String(j.id) === String(pendingOpening));
    if (job) openEdit(job);
    else if (jobs.length || loadError) {
      if (panelOnly) { onClose?.('That job opening was not found'); return; }
      showToast('That job opening was not found', 'error');
    } else return;
    setPendingOpening(null);
    if (panelOnly) return;
    setSp(prev => { const n = new URLSearchParams(prev); n.delete('opening'); return n; }, { replace: true });
  }, [pendingOpening, loading, jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = async (asDraft = false) => {
    if (!form.job_title.trim()) return showToast('Job title is required', 'error');
    if (!String(form.department).trim()) return showToast('Department is required', 'error');
    if (!editingId && !form.requisition_id) return showToast('Choose the approved requisition this job is for', 'error');
    const num = (v) => (v === '' || v == null ? null : Number(v));
    if (num(form.experience_min) != null && num(form.experience_max) != null && num(form.experience_min) > num(form.experience_max))
      return showToast('Minimum experience is more than the maximum', 'error');
    if (num(form.salary_min) != null && num(form.salary_max) != null && num(form.salary_min) > num(form.salary_max))
      return showToast('Minimum salary is more than the maximum', 'error');
    if (linkedReq) {
      if (num(linkedReq.number_of_positions) != null && num(form.number_of_positions) > num(linkedReq.number_of_positions))
        return showToast(`The requisition approved ${linkedReq.number_of_positions} position(s)`, 'error');
      if (num(linkedReq.salary_max) != null && num(form.salary_max) != null && num(form.salary_max) > num(linkedReq.salary_max))
        return showToast(`Salary is above the approved budget (${inr(linkedReq.salary_max)})`, 'error');
    }
    const editing = jobs.find(j => j.id === editingId);
    const closingChanged = !editingId || (form.closing_date || '') !== (editing?.closing_date ? String(editing.closing_date).slice(0, 10) : '');
    if (form.closing_date && closingChanged && form.closing_date < todayIso())
      return showToast('The closing date cannot be in the past', 'error');
    setSubmitting(true);
    try {
      if (editingId) {
        const { requisition_id: _r, ...changes } = form;
        await api.put(`/recruitment/openings/${editingId}`, changes);
        if (panelOnly) { onClose?.('Job opening updated'); return; }
        showToast('Job opening updated');
      } else {
        await api.post('/recruitment/openings', { ...form, requisition_id: Number(form.requisition_id), status: asDraft ? 'draft' : 'open' });
        const msg = asDraft ? 'Saved as draft — publish it when ready' : 'Job posted — it is now on the careers website';
        if (panelOnly) { onClose?.(msg); return; }
        showToast(msg);
      }
      setDrawer(false);
      setForm(emptyForm());
      setEditingId(null);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to save job opening', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const changeStatus = async (job, newStatus) => {
    if (newStatus === 'closed' && !window.confirm(`Close "${job.job_title}"? It comes off the careers page and its requisition closes. You can reopen it later.`)) return;
    if (newStatus === 'cancelled' && !window.confirm(`Cancel the draft "${job.job_title}"? Its requisition closes.`)) return;
    try {
      await api.put(`/recruitment/openings/${job.id}`, { status: newStatus });
      showToast(job.status === 'draft' && newStatus === 'open' ? 'Job published' : `Job ${STATUS_WORD[newStatus] || newStatus}`);
      setTimelineKey(k => k + 1);
      // Cancelling the job from its own panel leaves nothing to edit.
      if (newStatus === 'cancelled' && editingId === job.id) {
        if (panelOnly) { onClose?.('Draft job cancelled'); return; }
        setDrawer(false); setEditingId(null);
      }
      onChanged?.();
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to update status', 'error');
    }
  };

  const openEdit = (job) => {
    setEditingId(job.id);
    setLinkedReq(null);
    if (job.requisition_id) {
      api.get(`/recruitment/requisitions/${job.requisition_id}`).then(r => setLinkedReq(r.data || null)).catch(() => {});
    }
    const v = (x) => (x == null ? '' : String(x));
    setForm({
      requisition_id: v(job.requisition_id), job_title: job.job_title || '', department: job.department || '',
      employment_type: job.employment_type || 'full_time', number_of_positions: job.number_of_positions || 1,
      description: job.description || '', skills_required: job.skills_required || '',
      experience_min: v(job.experience_min), experience_max: v(job.experience_max),
      salary_min: v(job.salary_min), salary_max: v(job.salary_max), location: job.location || '',
      closing_date: job.closing_date ? job.closing_date.toString().slice(0, 10) : '',
    });
    setDrawer(true);
  };

  const removeJob = async (job) => {
    if (!window.confirm(`Delete "${job.job_title}"? Only possible while nobody has applied. Its requisition becomes available again.`)) return;
    try {
      await api.delete(`/recruitment/openings/${job.id}`);
      showToast('Job opening deleted');
      load();
    } catch (err) { showToast(err?.response?.data?.error || 'Could not delete the job opening', 'error'); }
  };


  const displayed = jobs.filter(j =>
    matchesSearch(j, ['job_title', 'department', 'location'], search)
    && (!fStatus || j.status === fStatus)
  );

  const counts = { open: 0, draft: 0, closed: 0, on_hold: 0, cancelled: 0 };
  jobs.forEach(j => { if (counts[j.status] !== undefined) counts[j.status]++; });

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const actions = (
    <>
      <button className={embedded ? 'jo-btn-outline' : 'plh-cta plh-cta--ghost'} onClick={load} title="Refresh" aria-label="Refresh"><RefreshCw size={14} /></button>
      <button className={embedded ? 'jo-btn-primary' : 'plh-cta'} onClick={() => openCreate()}>
        <Plus size={14} /> Post Job
      </button>
    </>
  );
  const today = todayIso();
  const closePanel = () => {
    if (panelOnly) { onClose?.(); return; }
    setDrawer(false); setEditingId(null);
  };

  const body = (
    <>
      {toast && <div className={`jo-toast jo-toast-${toast.type}`}>{toast.msg}</div>}
      {!drawer && !panelOnly && (<>
      {embedded && <div className="jo-toolbar">{actions}</div>}



      <div className="jo-filters">
        <div className="jo-search">
          <Search size={14} />
          <input placeholder="Search title, department, location…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="jo-tabs">
          {[['', 'All', jobs.length], ['open', 'Open', counts.open], ['on_hold', 'On hold', counts.on_hold], ['draft', 'Draft', counts.draft], ['closed', 'Closed', counts.closed], ['cancelled', 'Cancelled', counts.cancelled]].map(([val, label, cnt]) => (
            <button key={val} className={`jo-tab${fStatus === val ? ' jo-tab-active' : ''}`} onClick={() => setFStatus(val)}>
              {label} <span className="jo-tab-count">{cnt}</span>
            </button>
          ))}
        </div>
      </div>

      {loadError && <div className="jo-error">{loadError} <button className="jo-btn-outline" onClick={load}>Retry</button></div>}

      {loading ? (
        <div className="jo-loading"><div className="jo-spinner" /></div>
      ) : displayed.length === 0 ? (
        !loadError && <div className="jo-empty">
          <Briefcase size={40} color="#d1d5db" />
          <p>{jobs.length ? 'No job openings match.' : 'No job openings yet. Post one from an approved requisition.'}</p>
          <button className="jo-btn-primary" onClick={() => openCreate()}><Plus size={14} /> Post Job</button>
        </div>
      ) : (
        <div className="jo-grid">
          {displayed.map(job => {
            const s = sm(job.status);
            const t = tm(job.employment_type);
            const filled = parseInt(job.positions_filled || 0);
            const total  = parseInt(job.number_of_positions || 1);
            return (
              <div key={job.id} className="jo-card">
                <div className="jo-card-hd">
                  <div className="jo-card-icon"><Briefcase size={18} /></div>
                  <div className="jo-card-meta-top">
                    <span className="jo-badge" style={{ background: s.bg, color: s.color }}>{s.label}</span>
                    <span className="jo-type-badge" style={{ background: t.bg, color: t.color }}>{t.label}</span>
                  </div>
                </div>
                <h3 className="jo-job-title">{job.job_title}</h3>
                <div className="jo-card-info">
                  {job.requisition_id && <span title="Requisition">REQ-{job.requisition_id}</span>}
                  <span><Building2 size={12} />{job.department}</span>
                  {job.location && <span><MapPin size={12} />{job.location}</span>}
                  {rangeText(job.experience_min, job.experience_max) && <span><Clock size={12} />{rangeText(job.experience_min, job.experience_max)} yrs</span>}
                </div>
                {job.skills_required && (
                  <div className="jo-skills">
                    {job.skills_required.split(',').slice(0, 3).map(sk => (
                      <span key={sk} className="jo-skill">{sk.trim()}</span>
                    ))}
                  </div>
                )}
                <div className="jo-card-ft">
                  <div className="jo-positions">
                    <span className="jo-pos-label">Positions</span>
                    <span className="jo-pos-val">{filled}/{total} filled</span>
                  </div>
                  <div className="jo-applicants">
                    <Users size={12} />
                    <span>{job.applicants_count || 0} applicant{job.applicants_count !== 1 ? 's' : ''}</span>
                  </div>
                </div>
                {rangeText(job.salary_min, job.salary_max, inr) && <div className="jo-salary">{rangeText(job.salary_min, job.salary_max, inr)} per year</div>}
                {job.closing_date && (
                  <div className="jo-closing" style={{ fontSize: 12, color: job.status === 'open' && String(job.closing_date).slice(0, 10) < today ? '#b91c1c' : '#6b7280', marginTop: 4 }}>
                    {job.status === 'open' && String(job.closing_date).slice(0, 10) < today
                      ? `Closing date ${fmtDate(job.closing_date)} has passed — not on the careers page. Close it or set a new date.`
                      : `Closes ${fmtDate(job.closing_date)}`}
                  </div>
                )}
                <div className="jo-card-actions">
                  <button className="jo-pipeline-btn" onClick={() => { setSelectedJobId(job.id); setPage && setPage('Candidates', { tab: 'pipeline' }); }}>
                    View Pipeline <ChevronRight size={13} />
                  </button>
                  <div style={{ display:'flex', gap:6 }}>
                    {job.status !== 'cancelled' && <button title="Edit the job and see its timeline" onClick={() => openEdit(job)}
                      style={{ padding:'5px 8px', background:'#f3f4f6', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#374151' }}>
                      <Edit2 size={12} /> Edit
                    </button>}
                    {job.status === 'open' && (
                      <button title="Pause" onClick={() => changeStatus(job, 'on_hold')}
                        style={{ padding:'5px 8px', background:'#ede9fe', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#5b21b6' }}>
                        <PauseCircle size={12} /> Pause
                      </button>
                    )}
                    {job.status === 'on_hold' && (
                      <button title="Reopen" onClick={() => changeStatus(job, 'open')}
                        style={{ padding:'5px 8px', background:'#dcfce7', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#15803d' }}>
                        <PlayCircle size={12} /> Reopen
                      </button>
                    )}
                    {job.status === 'draft' && (
                      <button title="Publish" onClick={() => changeStatus(job, 'open')}
                        style={{ padding:'5px 8px', background:'#dcfce7', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#15803d' }}>
                        <PlayCircle size={12} /> Publish
                      </button>
                    )}
                    {job.status === 'draft' && (
                      <button title="Cancel draft" onClick={() => changeStatus(job, 'cancelled')}
                        style={{ padding:'5px 8px', background:'#fee2e2', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#dc2626' }}>
                        <XCircle size={12} /> Cancel
                      </button>
                    )}
                    {['open','on_hold'].includes(job.status) && (
                      <button title="Close" onClick={() => changeStatus(job, 'closed')}
                        style={{ padding:'5px 8px', background:'#fee2e2', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#dc2626' }}>
                        <XCircle size={12} /> Close
                      </button>
                    )}
                    {job.status === 'closed' && filled < total && (
                      <button title="Reopen" onClick={() => changeStatus(job, 'open')}
                        style={{ padding:'5px 8px', background:'#dcfce7', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#15803d' }}>
                        <PlayCircle size={12} /> Reopen
                      </button>
                    )}
                    {job.status === 'closed' && filled >= total && (
                      <span title="Raise a new requisition for more hires" style={{ fontSize: 11, fontWeight: 600, color: '#15803d', alignSelf: 'center' }}>All positions filled</span>
                    )}
                    {!job.applicants_count && ['draft', 'cancelled', 'closed'].includes(job.status) && (
                      <button title="Delete (only while nobody has applied)" onClick={() => removeJob(job)} aria-label="Delete"
                        style={{ padding:'5px 8px', background:'#f3f4f6', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#6b7280' }}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </>)}

      {panelOnly && !drawer && <div className="jo-loading"><div className="jo-spinner" /></div>}
      {drawer && (
          <div className="jo-panel" role="region" aria-label={editingId ? 'Job opening' : 'Post new job'}>
            <div className="jo-panel-hd">
              <button className="jo-back" onClick={closePanel}><ArrowLeft size={14} /> {panelOnly ? 'Requisition' : 'Job openings'}</button>
              <h3>{editingId ? form.job_title || 'Job opening' : 'Post New Job'}</h3>
              {editingId && (() => { const j = jobs.find(x => x.id === editingId); const st = sm(j?.status); return j ? <span className="jo-badge" style={{ background: st.bg, color: st.color }}>{st.label}</span> : null; })()}
            </div>
            <div className="jo-panel-body jo-split">
            <div className="jo-split-main">
              <div className="jo-field">
                <label>Requisition <span className="jo-req">*</span></label>
                {editingId || panelOnly ? (
                  <input value={form.requisition_id ? (linkedReq?.requisition_no || `REQ-${form.requisition_id}`) : (editingId ? 'Not linked (created before requisitions were required)' : 'Loading…')} disabled />
                ) : (
                  <select value={form.requisition_id} onChange={e => {
                    const r = requisitions.find(x => String(x.id) === e.target.value);
                    if (r) applyRequisition(r); else setF('requisition_id', '');
                  }}>
                    <option value="">{requisitions.length ? 'Choose an approved requisition…' : 'No approved requisitions — raise one under Requisitions'}</option>
                    {requisitions.map(r => (
                      <option key={r.id} value={r.id}>{r.requisition_no || `REQ-${r.id}`} · {r.job_title} · {r.department} · {r.number_of_positions} position{r.number_of_positions === 1 ? '' : 's'}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Job Title <span className="jo-req">*</span></label>
                  <input value={form.job_title} onChange={e => setF('job_title', e.target.value)} placeholder="e.g. Senior Developer" />
                </div>
                <div className="jo-field">
                  <label>Department <span className="jo-req">*</span></label>
                  {linkedReq?.department || (editingId && form.requisition_id) ? (
                    <input value={form.department} disabled title="Set by the approved requisition" />
                  ) : (
                    <MasterSelect
                      endpoint="/master/departments"
                      label="Department"
                      value={form.department}
                      onChange={v => setF('department', v)}
                      placeholder="Select…"
                    />
                  )}
                </div>
              </div>
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Employment Type</label>
                  <select value={form.employment_type} onChange={e => setF('employment_type', e.target.value)}
                    disabled={!!(linkedReq?.employment_type || (editingId && form.requisition_id))} title={linkedReq ? 'Set by the approved requisition' : undefined}>
                    {EMP_TYPES.map(t => <option key={t} value={t}>{tm(t).label}</option>)}
                  </select>
                </div>
                <div className="jo-field">
                  <label>No. of Positions{linkedReq?.number_of_positions ? ` (approved: ${linkedReq.number_of_positions})` : ''}</label>
                  <input type="number" min="1" max={linkedReq?.number_of_positions || 9999} value={form.number_of_positions} onChange={e => setF('number_of_positions', e.target.value)} />
                </div>
              </div>
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Location</label>
                  <input value={form.location} onChange={e => setF('location', e.target.value)} placeholder="City…" />
                </div>
                <div className="jo-field">
                  <label>Closing Date</label>
                  <input type="date" min={todayIso()} value={form.closing_date} onChange={e => setF('closing_date', e.target.value)} />
                </div>
              </div>
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Experience from (years)</label>
                  <input type="number" min="0" max="60" value={form.experience_min} onChange={e => setF('experience_min', e.target.value)} />
                </div>
                <div className="jo-field">
                  <label>Experience to (years)</label>
                  <input type="number" min="0" max="60" value={form.experience_max} onChange={e => setF('experience_max', e.target.value)} />
                </div>
              </div>
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Salary from (₹ per year)</label>
                  <input type="number" min="0" value={form.salary_min} onChange={e => setF('salary_min', e.target.value)} />
                </div>
                <div className="jo-field">
                  <label>Salary to (₹ per year){linkedReq?.salary_max != null ? ` — budget ${inr(linkedReq.salary_max)}` : ''}</label>
                  <input type="number" min="0" value={form.salary_max} onChange={e => setF('salary_max', e.target.value)} />
                </div>
              </div>
              <div className="jo-field">
                <label>Skills Required</label>
                <input value={form.skills_required} onChange={e => setF('skills_required', e.target.value)} placeholder="React, Node.js, SQL…" />
              </div>
              <div className="jo-field">
                <label>Job Description</label>
                <textarea rows={4} value={form.description} onChange={e => setF('description', e.target.value)} placeholder="Role description and responsibilities…" />
              </div>
            </div>
            <aside className="jo-split-side">
              {form.requisition_id
                ? <JobTimeline requisitionId={form.requisition_id} refreshKey={timelineKey} setPage={setPage} />
                : <div className="jtl jtl-empty">Choose the requisition to see its timeline.</div>}
            </aside>
            </div>
            <div className="jo-panel-ft">
              {/* Status moves for this job, here as well as on its card. */}
              {editingId && (() => {
                const j = jobs.find(x => x.id === editingId);
                if (!j) return null;
                const seatsLeft = Number(j.positions_filled || 0) < Number(j.number_of_positions || 1);
                return (
                  <div className="jo-panel-status">
                    {j.status === 'draft' && <button className="jo-btn-outline" onClick={() => changeStatus(j, 'open')}><PlayCircle size={13} /> Publish</button>}
                    {j.status === 'draft' && <button className="jo-btn-outline" onClick={() => changeStatus(j, 'cancelled')}><XCircle size={13} /> Cancel draft</button>}
                    {j.status === 'open' && <button className="jo-btn-outline" onClick={() => changeStatus(j, 'on_hold')}><PauseCircle size={13} /> Pause</button>}
                    {['on_hold', 'closed'].includes(j.status) && (
                      <button className="jo-btn-outline" disabled={!seatsLeft}
                        title={seatsLeft ? '' : 'Every position is filled — raise a new requisition for more hires'}
                        onClick={() => changeStatus(j, 'open')}>
                        <PlayCircle size={13} /> {seatsLeft ? 'Reopen' : 'All positions filled'}
                      </button>
                    )}
                    {['open', 'on_hold'].includes(j.status) && <button className="jo-btn-outline" onClick={() => changeStatus(j, 'closed')}><XCircle size={13} /> Close job</button>}
                  </div>
                );
              })()}
              <button className="jo-btn-outline" onClick={closePanel}>Cancel</button>
              {!editingId && (
                <button className="jo-btn-outline" onClick={() => handleSubmit(true)} disabled={submitting}>Save as draft</button>
              )}
              <button className="jo-btn-primary" onClick={() => handleSubmit(false)} disabled={submitting}>
                {submitting ? 'Saving…' : editingId ? 'Save Changes' : 'Post Job'}
              </button>
            </div>
          </div>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={<PageHero icon={UserPlus} eyebrow="Recruitment" title="Job Openings" actions={actions} />}>
      {body}
    </PageShell>
  );
}
