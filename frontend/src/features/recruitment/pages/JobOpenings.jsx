import { useState, useCallback, useEffect } from 'react';
import {
  Search, Plus, RefreshCw, X, Briefcase,
  MapPin, Users, Clock, ChevronRight, Building2,
  Edit2, PauseCircle, PlayCircle, XCircle,
} from 'lucide-react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import './JobOpenings.css';

const STATUS_META = {
  open:             { bg: '#dcfce7', color: '#15803d', label: 'Open'     },
  draft:            { bg: '#f3f4f6', color: '#6b7280', label: 'Draft'    },
  closed:           { bg: '#fee2e2', color: '#dc2626', label: 'Closed'   },
  paused:           { bg: '#fef3c7', color: '#92400e', label: 'Paused'   },
  pending_approval: { bg: '#e0e7ff', color: '#4338ca', label: 'Pending'  },
};
const sm = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.draft;

const TYPE_META = {
  full_time: { bg: '#dbeafe', color: '#1d4ed8', label: 'Full Time'  },
  contract:  { bg: '#fce7f3', color: '#9d174d', label: 'Contract'   },
  intern:    { bg: '#fef3c7', color: '#92400e', label: 'Intern'      },
  part_time: { bg: '#f3e8ff', color: '#6B3FDB', label: 'Part Time'  },
};
const tm = t => TYPE_META[(t || '').toLowerCase()] || TYPE_META.full_time;

const DEPARTMENTS = ['Engineering', 'Finance', 'HR', 'Sales', 'Operations', 'Marketing', 'Product', 'Legal'];
const EMP_TYPES   = ['full_time', 'contract', 'intern', 'part_time'];

const emptyForm = () => ({
  job_title: '', department: '', employment_type: 'full_time',
  number_of_positions: 1, job_description: '', skills_required: '',
  experience_required: '', location: '', salary_range: '',
  closing_date: '',
});

export default function JobOpenings({ setPage }) {
  const setSelectedJobId = useAppStore(s => s.setSelectedJobId);
  const [jobs,       setJobs]       = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');
  const [drawer,     setDrawer]     = useState(false);
  const [editingId,  setEditingId]  = useState(null);
  const [form,       setForm]       = useState(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [toast,      setToast]      = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = fStatus ? { status: fStatus } : {};
      const res = await api.get('/recruitment/openings', { params });
      const raw = res.data?.openings || res.data || [];
      setJobs(Array.isArray(raw) ? raw : []);
    } catch {
      setJobs([]);
    } finally { setLoading(false); }
  }, [fStatus]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    if (!form.job_title.trim()) return showToast('Job title is required', 'error');
    if (!form.department.trim()) return showToast('Department is required', 'error');
    setSubmitting(true);
    try {
      if (editingId) {
        await api.put(`/recruitment/openings/${editingId}`, form);
        showToast('Job opening updated');
      } else {
        await api.post('/recruitment/openings', form);
        showToast('Job opening created');
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
    try {
      await api.put(`/recruitment/openings/${job.id}`, { status: newStatus });
      showToast(`Job ${newStatus}`);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Failed to update status', 'error');
    }
  };

  const openEdit = (job) => {
    setEditingId(job.id);
    setForm({
      job_title: job.job_title || '',
      department: job.department || '',
      employment_type: job.employment_type || 'full_time',
      number_of_positions: job.number_of_positions || 1,
      job_description: job.description || '',
      skills_required: job.skills_required || '',
      experience_required: job.experience_required || '',
      location: job.location || '',
      salary_range: job.salary_range || '',
      closing_date: job.closing_date ? job.closing_date.toString().slice(0,10) : '',
    });
    setDrawer(true);
  };

  const displayed = jobs.filter(j => {
    const q = search.toLowerCase();
    return (!q || j.job_title?.toLowerCase().includes(q) || j.department?.toLowerCase().includes(q) || j.location?.toLowerCase().includes(q))
        && (!fStatus || j.status === fStatus);
  });

  const counts = { open: 0, draft: 0, closed: 0, paused: 0 };
  jobs.forEach(j => { if (counts[j.status] !== undefined) counts[j.status]++; });

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="jo-root">
      {toast && <div className={`jo-toast jo-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="jo-header">
        <div>
          <h2 className="jo-title">Job Openings</h2>
          <p className="jo-sub">{displayed.length} opening{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="jo-header-r">
          <button className="jo-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="jo-btn-primary" onClick={() => { setForm(emptyForm()); setEditingId(null); setDrawer(true); }}>
            <Plus size={14} /> Post Job
          </button>
        </div>
      </div>

      <div className="jo-filters">
        <div className="jo-search">
          <Search size={14} />
          <input placeholder="Search title, department, location…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="jo-tabs">
          {[['', 'All', jobs.length], ['open', 'Open', counts.open], ['draft', 'Draft', counts.draft], ['closed', 'Closed', counts.closed], ['paused', 'Paused', counts.paused]].map(([val, label, cnt]) => (
            <button key={val} className={`jo-tab${fStatus === val ? ' jo-tab-active' : ''}`} onClick={() => setFStatus(val)}>
              {label} <span className="jo-tab-count">{cnt}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="jo-loading"><div className="jo-spinner" /></div>
      ) : displayed.length === 0 ? (
        <div className="jo-empty">
          <Briefcase size={40} color="#d1d5db" />
          <p>No job openings found</p>
          <button className="jo-btn-primary" onClick={() => setDrawer(true)}><Plus size={14} /> Post Job</button>
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
                  <span><Building2 size={12} />{job.department}</span>
                  {job.location && <span><MapPin size={12} />{job.location}</span>}
                  {job.experience_required && <span><Clock size={12} />{job.experience_required}</span>}
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
                {job.salary_range && <div className="jo-salary">{job.salary_range}</div>}
                <div className="jo-card-actions">
                  <button className="jo-pipeline-btn" onClick={() => { setSelectedJobId(job.id); setPage && setPage('CandidatePipeline'); }}>
                    View Pipeline <ChevronRight size={13} />
                  </button>
                  <div style={{ display:'flex', gap:6 }}>
                    <button title="Edit" onClick={() => openEdit(job)}
                      style={{ padding:'5px 8px', background:'#f3f4f6', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#374151' }}>
                      <Edit2 size={12} /> Edit
                    </button>
                    {job.status === 'open' && (
                      <button title="Pause" onClick={() => changeStatus(job, 'paused')}
                        style={{ padding:'5px 8px', background:'#fef3c7', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#92400e' }}>
                        <PauseCircle size={12} /> Pause
                      </button>
                    )}
                    {job.status === 'paused' && (
                      <button title="Reopen" onClick={() => changeStatus(job, 'open')}
                        style={{ padding:'5px 8px', background:'#dcfce7', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#15803d' }}>
                        <PlayCircle size={12} /> Reopen
                      </button>
                    )}
                    {['open','paused','draft'].includes(job.status) && (
                      <button title="Close" onClick={() => changeStatus(job, 'closed')}
                        style={{ padding:'5px 8px', background:'#fee2e2', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#dc2626' }}>
                        <XCircle size={12} /> Close
                      </button>
                    )}
                    {job.status === 'closed' && (
                      <button title="Reopen" onClick={() => changeStatus(job, 'open')}
                        style={{ padding:'5px 8px', background:'#dcfce7', border:'none', borderRadius:7, cursor:'pointer', display:'flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'#15803d' }}>
                        <PlayCircle size={12} /> Reopen
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawer && (
        <div className="jo-overlay" onClick={() => setDrawer(false)}>
          <div className="jo-drawer" onClick={e => e.stopPropagation()}>
            <div className="jo-drawer-hd">
              <h3>{editingId ? 'Edit Job Opening' : 'Post New Job'}</h3>
              <button className="jo-icon-btn" onClick={() => { setDrawer(false); setEditingId(null); }}><X size={16} /></button>
            </div>
            <div className="jo-drawer-body">
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Job Title <span className="jo-req">*</span></label>
                  <input value={form.job_title} onChange={e => setF('job_title', e.target.value)} placeholder="e.g. Senior Developer" />
                </div>
                <div className="jo-field">
                  <label>Department <span className="jo-req">*</span></label>
                  <select value={form.department} onChange={e => setF('department', e.target.value)}>
                    <option value="">Select…</option>
                    {DEPARTMENTS.map(d => <option key={d}>{d}</option>)}
                  </select>
                </div>
              </div>
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Employment Type</label>
                  <select value={form.employment_type} onChange={e => setF('employment_type', e.target.value)}>
                    {EMP_TYPES.map(t => <option key={t} value={t}>{tm(t).label}</option>)}
                  </select>
                </div>
                <div className="jo-field">
                  <label>No. of Positions</label>
                  <input type="number" min="1" value={form.number_of_positions} onChange={e => setF('number_of_positions', e.target.value)} />
                </div>
              </div>
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Location</label>
                  <input value={form.location} onChange={e => setF('location', e.target.value)} placeholder="City…" />
                </div>
                <div className="jo-field">
                  <label>Experience Required</label>
                  <input value={form.experience_required} onChange={e => setF('experience_required', e.target.value)} placeholder="e.g. 3-5 years" />
                </div>
              </div>
              <div className="jo-row2">
                <div className="jo-field">
                  <label>Salary Range</label>
                  <input value={form.salary_range} onChange={e => setF('salary_range', e.target.value)} placeholder="e.g. ₹12L - ₹18L" />
                </div>
                <div className="jo-field">
                  <label>Closing Date</label>
                  <input type="date" value={form.closing_date} onChange={e => setF('closing_date', e.target.value)} />
                </div>
              </div>
              <div className="jo-field">
                <label>Skills Required</label>
                <input value={form.skills_required} onChange={e => setF('skills_required', e.target.value)} placeholder="React, Node.js, SQL…" />
              </div>
              <div className="jo-field">
                <label>Job Description</label>
                <textarea rows={4} value={form.job_description} onChange={e => setF('job_description', e.target.value)} placeholder="Role description and responsibilities…" />
              </div>
            </div>
            <div className="jo-drawer-ft">
              <button className="jo-btn-outline" onClick={() => { setDrawer(false); setEditingId(null); }}>Cancel</button>
              <button className="jo-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : editingId ? 'Save Changes' : 'Post Job'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
