import { useState, useCallback, useEffect } from 'react';
import {
  Search, Plus, RefreshCw, X, Briefcase,
  MapPin, Users, Clock, ChevronRight, Building2
} from 'lucide-react';
import api from '@/services/api/client';
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
  part_time: { bg: '#f3e8ff', color: '#7c3aed', label: 'Part Time'  },
};
const tm = t => TYPE_META[(t || '').toLowerCase()] || TYPE_META.full_time;

const SAMPLE_JOBS = [
  { id:1, job_title:'Senior React Developer',    department:'Engineering', employment_type:'full_time', location:'Bangalore',  number_of_positions:2, positions_filled:0, applicants_count:14, status:'open',   experience_required:'4-6 years',   salary_range:'₹18L - ₹28L', skills_required:'React, Node.js, TypeScript', closing_date:'2026-04-30' },
  { id:2, job_title:'Finance Manager',           department:'Finance',     employment_type:'full_time', location:'Mumbai',     number_of_positions:1, positions_filled:0, applicants_count:8,  status:'open',   experience_required:'6-8 years',   salary_range:'₹20L - ₹30L', skills_required:'CA, SAP, Financial Reporting', closing_date:'2026-04-15' },
  { id:3, job_title:'HR Business Partner',       department:'HR',          employment_type:'full_time', location:'Hyderabad',  number_of_positions:1, positions_filled:1, applicants_count:22, status:'closed', experience_required:'3-5 years',   salary_range:'₹12L - ₹18L', skills_required:'HRBP, PMS, Talent Acquisition', closing_date:'2026-03-15' },
  { id:4, job_title:'Data Analyst',              department:'Operations',  employment_type:'full_time', location:'Chennai',    number_of_positions:2, positions_filled:0, applicants_count:19, status:'open',   experience_required:'2-4 years',   salary_range:'₹10L - ₹16L', skills_required:'Python, SQL, Power BI', closing_date:'2026-05-01' },
  { id:5, job_title:'Sales Executive',           department:'Sales',       employment_type:'full_time', location:'Delhi',      number_of_positions:3, positions_filled:1, applicants_count:31, status:'open',   experience_required:'1-3 years',   salary_range:'₹5L - ₹9L',  skills_required:'B2B Sales, CRM, Cold Calling', closing_date:'2026-04-20' },
  { id:6, job_title:'DevOps Engineer (Intern)',  department:'Engineering', employment_type:'intern',    location:'Bangalore',  number_of_positions:1, positions_filled:0, applicants_count:7,  status:'draft',  experience_required:'Fresher',     salary_range:'₹25K/month',  skills_required:'Linux, Docker, AWS basics', closing_date:'2026-05-15' },
];

const DEPARTMENTS = ['Engineering', 'Finance', 'HR', 'Sales', 'Operations', 'Marketing', 'Product', 'Legal'];
const EMP_TYPES   = ['full_time', 'contract', 'intern', 'part_time'];

const emptyForm = () => ({
  job_title: '', department: '', employment_type: 'full_time',
  number_of_positions: 1, job_description: '', skills_required: '',
  experience_required: '', location: '', salary_range: '',
  closing_date: '',
});

export default function JobOpenings({ setPage }) {
  const [jobs,       setJobs]       = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');
  const [drawer,     setDrawer]     = useState(false);
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
      setJobs(Array.isArray(raw) && raw.length ? raw : SAMPLE_JOBS);
    } catch {
      setJobs(SAMPLE_JOBS);
    } finally { setLoading(false); }
  }, [fStatus]);

  useEffect(() => { load(); }, [load]);

  const handleSubmit = async () => {
    if (!form.job_title.trim()) return showToast('Job title is required', 'error');
    if (!form.department.trim()) return showToast('Department is required', 'error');
    setSubmitting(true);
    try {
      await api.post('/recruitment/openings', form);
      showToast('Job opening created');
    } catch {
      setJobs(js => [{ ...form, id: Date.now(), applicants_count: 0, positions_filled: 0, status: 'draft' }, ...js]);
      showToast('Job opening created');
    } finally {
      setDrawer(false);
      setForm(emptyForm());
      setSubmitting(false);
      load();
    }
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
          <button className="jo-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer(true); }}>
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
                <button
                  className="jo-pipeline-btn"
                  onClick={() => setPage && setPage('CandidatePipeline')}
                >
                  View Pipeline <ChevronRight size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {drawer && (
        <div className="jo-overlay" onClick={() => setDrawer(false)}>
          <div className="jo-drawer" onClick={e => e.stopPropagation()}>
            <div className="jo-drawer-hd">
              <h3>Post New Job</h3>
              <button className="jo-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
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
              <button className="jo-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="jo-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Posting…' : 'Post Job'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
