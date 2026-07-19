import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import {
  Search, Upload, User, Briefcase, ExternalLink,
  Plus, X, Building2, Clock, Pencil,
} from 'lucide-react';

// ── Stage config ──────────────────────────────────────────────────────────────
const STAGES = [
  { value: 'all',       label: 'All' },
  { value: 'applied',   label: 'Applied' },
  { value: 'screening', label: 'Screening' },
  { value: '1st_level', label: '1st Level' },
  { value: '2nd_level', label: '2nd Level' },
  { value: 'offer',     label: 'Offer' },
  { value: 'hired',     label: 'Hired' },
  { value: 'rejected',  label: 'Rejected' },
];

const STAGE_LABEL = Object.fromEntries(STAGES.map(s => [s.value, s.label]));

const STAGE_COLOR = {
  applied:   { bg: '#dbeafe', color: '#1e40af' },
  screening: { bg: '#fef3c7', color: '#92400e' },
  '1st_level':{ bg: '#ede9fe', color: '#5b21b6' },
  '2nd_level':{ bg: '#f3e8ff', color: '#7e22ce' },
  offer:     { bg: '#d1fae5', color: '#065f46' },
  hired:     { bg: '#dcfce7', color: '#14532d' },
  rejected:  { bg: '#fee2e2', color: '#991b1b' },
};

// ── Upload Resume Modal ───────────────────────────────────────────────────────
function UploadResumeModal({ onClose, onSuccess }) {
  const [form, setForm] = useState({
    name: '', email: '', phone: '', current_company: '',
    current_designation: '', experience_years: '', notice_period_days: '',
    expected_ctc: '', notes: '', skills: '',
  });
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.email) { setError('Name and email are required.'); return; }
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => { if (v !== '') fd.append(k, k === 'skills' ? JSON.stringify(v.split(',').map(s => s.trim()).filter(Boolean)) : v); });
      if (file) fd.append('resume', file);
      await api.post('/talent/resumes', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onSuccess();
    } catch (err) {
      setError(err?.response?.data?.error || 'Upload failed.');
    } finally {
      setSaving(false);
    }
  };

  const inp = (label, key, type = 'text', placeholder = '') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{label}</label>
      <input type={type} value={form[key]} onChange={e => set(key, e.target.value)} placeholder={placeholder}
        style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none' }} />
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>Upload Resume</h2>
            <p style={{ fontSize: 12, color: '#6b7280', margin: '4px 0 0' }}>Add a candidate without a job opening</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
        </div>

        {error && <div style={{ background: '#fee2e2', color: '#991b1b', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 16 }}>{error}</div>}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {inp('Full Name *', 'name', 'text', 'Ravi Kumar')}
            {inp('Email *', 'email', 'email', 'ravi@example.com')}
            {inp('Phone', 'phone', 'tel', '+91 98765 43210')}
            {inp('Current Company', 'current_company', 'text', 'Infosys Ltd')}
            {inp('Current Designation', 'current_designation', 'text', 'Senior Developer')}
            {inp('Experience (yrs)', 'experience_years', 'number', '5')}
            {inp('Notice Period (days)', 'notice_period_days', 'number', '60')}
            {inp('Expected CTC (₹)', 'expected_ctc', 'number', '1200000')}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Skills <span style={{ color: '#9ca3af', fontWeight: 400 }}>(comma-separated)</span></label>
            <input value={form.skills} onChange={e => set('skills', e.target.value)} placeholder="React, Node.js, TypeScript"
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Notes</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={3} placeholder="Any notes about this candidate..."
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', resize: 'vertical' }} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Resume File</label>
            <label style={{ border: '2px dashed #e5e7eb', borderRadius: 8, padding: 16, textAlign: 'center', cursor: 'pointer', background: file ? '#f5f3ff' : '#fafafa' }}>
              <input type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }} onChange={e => setFile(e.target.files[0])} />
              <Upload size={20} color={file ? '#6B3FDB' : '#9ca3af'} style={{ margin: '0 auto 6px' }} />
              <p style={{ fontSize: 12, color: file ? '#6B3FDB' : '#9ca3af', margin: 0 }}>
                {file ? file.name : 'Click to attach PDF or Word document'}
              </p>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#6B3FDB', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? .7 : 1 }}>
              {saving ? 'Uploading…' : 'Upload Resume'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Add to Pool Modal ─────────────────────────────────────────────────────────
function AddToPoolModal({ candidate, pools, onClose, onSuccess }) {
  const toast = useToast();
  const [selectedPool, setSelectedPool] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!selectedPool) return;
    setSaving(true);
    try {
      await api.post(`/talent/pools/${selectedPool}/members`, { candidate_id: candidate.id });
      toast.success(`${candidate?.full_name || 'Candidate'} added to pool`);
      onSuccess();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to add to pool');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 400, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#1f2937', margin: 0 }}>Add to Talent Pool</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={18} /></button>
        </div>
        <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
          Adding <strong>{candidate?.full_name}</strong> to a pool
        </p>
        <select value={selectedPool} onChange={e => setSelectedPool(e.target.value)}
          style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 8, padding: '9px 10px', fontSize: 13, outline: 'none', marginBottom: 18 }}>
          <option value="">Select a pool…</option>
          {(pools ?? []).map(p => (
            <option key={p.id} value={p.id}>{p.pool_name}</option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleAdd} disabled={!selectedPool || saving}
            style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#6B3FDB', color: '#fff', fontSize: 13, fontWeight: 600, cursor: !selectedPool || saving ? 'not-allowed' : 'pointer', opacity: !selectedPool || saving ? .6 : 1 }}>
            {saving ? 'Adding…' : 'Add to Pool'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Edit Candidate Modal ──────────────────────────────────────────────────────
function EditCandidateModal({ candidate, onClose, onSuccess }) {
  const toast = useToast();
  const [form, setForm] = useState({
    full_name:           candidate?.full_name || '',
    email:               candidate?.email || '',
    phone:               candidate?.phone || '',
    current_company:     candidate?.current_company || '',
    current_designation: candidate?.current_designation || '',
    experience_years:    candidate?.experience_years ?? '',
    notice_period_days:  candidate?.notice_period_days ?? '',
    expected_ctc:        candidate?.expected_ctc ?? '',
    notes:               candidate?.notes || '',
    skills:              Array.isArray(candidate?.skills) ? candidate.skills.join(', ') : '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.full_name || !form.email) { setError('Name and email are required.'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        ...form,
        skills: form.skills.split(',').map(s => s.trim()).filter(Boolean),
      };
      await api.put(`/talent/resumes/${candidate.id}`, payload);
      toast.success('Candidate updated');
      onSuccess();
    } catch (err) {
      setError(err?.response?.data?.error || 'Update failed.');
    } finally {
      setSaving(false);
    }
  };

  const inp = (label, key, type = 'text', placeholder = '') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>{label}</label>
      <input type={type} value={form[key]} onChange={e => set(key, e.target.value)} placeholder={placeholder}
        style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none' }} />
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#1f2937', margin: 0 }}>Edit Candidate</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
        </div>
        {error && <div style={{ background: '#fee2e2', color: '#991b1b', borderRadius: 8, padding: '8px 12px', fontSize: 13, marginBottom: 16 }}>{error}</div>}
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {inp('Full Name *', 'full_name', 'text', 'Ravi Kumar')}
            {inp('Email *', 'email', 'email', 'ravi@example.com')}
            {inp('Phone', 'phone', 'tel', '+91 98765 43210')}
            {inp('Current Company', 'current_company', 'text', 'Infosys Ltd')}
            {inp('Current Designation', 'current_designation', 'text', 'Senior Developer')}
            {inp('Experience (yrs)', 'experience_years', 'number', '5')}
            {inp('Notice Period (days)', 'notice_period_days', 'number', '60')}
            {inp('Expected CTC (₹)', 'expected_ctc', 'number', '1200000')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Skills <span style={{ color: '#9ca3af', fontWeight: 400 }}>(comma-separated)</span></label>
            <input value={form.skills} onChange={e => set('skills', e.target.value)} placeholder="React, Node.js, TypeScript"
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>Notes</label>
            <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={3}
              style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', resize: 'vertical' }} />
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" onClick={onClose} style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}>Cancel</button>
            <button type="submit" disabled={saving} style={{ padding: '9px 20px', borderRadius: 8, border: 'none', background: '#6B3FDB', color: '#fff', fontSize: 13, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? .7 : 1 }}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Candidate Card ────────────────────────────────────────────────────────────
function CandidateCard({ candidate: c, onAddToPool, onEdit }) {
  const sc     = STAGE_COLOR[c?.current_stage] ?? { bg: '#f3f4f6', color: '#374151' };
  const label  = STAGE_LABEL[c?.current_stage] ?? c?.current_stage ?? 'Applied';
  const skills = Array.isArray(c?.skills) ? c.skills : [];
  const pools  = Array.isArray(c?.talent_pools) ? c.talent_pools : [];
  const resumeUrl = c?.resume_gdrive_url ?? c?.resume_file_url ?? null;

  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: 20, border: '1px solid #f0f0f4', boxShadow: '0 1px 3px rgba(0,0,0,.05)', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 38, height: 38, borderRadius: '50%', background: '#ede9fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#6B3FDB' }}>
              {(c?.full_name || '?')[0].toUpperCase()}
            </span>
          </div>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', margin: 0 }}>{c?.full_name || '—'}</p>
            <p style={{ fontSize: 11, color: '#9ca3af', margin: '2px 0 0' }}>{c?.email || '—'}</p>
          </div>
        </div>
        <span style={{ background: sc.bg, color: sc.color, padding: '3px 9px', borderRadius: 20, fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
          {label}
        </span>
      </div>

      {/* Company / designation */}
      {(c?.current_company || c?.current_designation) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151' }}>
          <Building2 size={12} color="#9ca3af" />
          <span style={{ fontWeight: 500 }}>{c?.current_designation || '—'}</span>
          {c?.current_company && <span style={{ color: '#9ca3af' }}>· {c.current_company}</span>}
        </div>
      )}

      {/* Experience */}
      {c?.experience_years != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280' }}>
          <Clock size={11} color="#9ca3af" />
          {c.experience_years} yr{c.experience_years !== 1 ? 's' : ''} experience
        </div>
      )}

      {/* Skills */}
      {skills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {skills.slice(0, 4).map((sk, i) => (
            <span key={i} style={{ background: '#f5f3ff', color: '#6B3FDB', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 500 }}>{sk}</span>
          ))}
          {skills.length > 4 && (
            <span style={{ background: '#f3f4f6', color: '#6b7280', padding: '2px 8px', borderRadius: 20, fontSize: 10 }}>+{skills.length - 4} more</span>
          )}
        </div>
      )}

      {/* Applied for */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151' }}>
        <Briefcase size={11} color="#9ca3af" />
        {c?.applied_for ? c.applied_for : <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>Speculative (no opening)</span>}
      </div>

      {/* Talent pools */}
      {pools.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {pools.map((p, i) => (
            <span key={i} style={{ background: '#ecfdf5', color: '#065f46', padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 500 }}>
              {p?.name ?? ''}
            </span>
          ))}
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, borderTop: '1px solid #f3f4f6', paddingTop: 10, flexWrap: 'wrap' }}>
        {resumeUrl ? (
          <a href={resumeUrl} target="_blank" rel="noopener noreferrer"
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6B3FDB', textDecoration: 'none', padding: '5px 10px', border: '1px solid #ede9fe', borderRadius: 6, background: '#faf5ff' }}>
            <ExternalLink size={11} /> View Resume
          </a>
        ) : (
          <span style={{ fontSize: 11, color: '#d1d5db', padding: '5px 10px', border: '1px dashed #e5e7eb', borderRadius: 6 }}>No resume</span>
        )}
        <button onClick={() => onEdit(c)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#374151', background: '#f9fafb', border: '1px solid #e5e7eb', padding: '5px 10px', borderRadius: 6, cursor: 'pointer' }}>
          <Pencil size={11} /> Edit
        </button>
        <button onClick={() => onAddToPool(c)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#059669', background: '#ecfdf5', border: '1px solid #d1fae5', padding: '5px 10px', borderRadius: 6, cursor: 'pointer' }}>
          <Plus size={11} /> Add to Pool
        </button>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ResumeDatabase() {
  const toast = useToast();
  const [resumes,         setResumes]         = useState([]);
  const [stats,           setStats]           = useState(null);
  const [topSkills,       setTopSkills]       = useState([]);
  const [pools,           setPools]           = useState([]);
  const [loading,         setLoading]         = useState(true);
  const [search,          setSearch]          = useState('');
  const [stageFilter,     setStageFilter]     = useState('all');
  const [skillFilter,     setSkillFilter]     = useState('');
  const [showUpload,      setShowUpload]      = useState(false);
  const [addToPool,       setAddToPool]       = useState(null);
  const [editCandidate,   setEditCandidate]   = useState(null);
  const searchTimer = useRef(null);

  const fetchResumes = useCallback(async (s = search, stage = stageFilter, skill = skillFilter) => {
    setLoading(true);
    try {
      const [resumeRes, statsRes, skillsRes, poolsRes] = await Promise.all([
        api.get('/talent/resumes', { params: { stage, search: s, skill } }),
        api.get('/talent/resumes/stats'),
        api.get('/talent/resumes/skills'),
        api.get('/talent/pools'),
      ]);
      setResumes(resumeRes.data?.data ?? []);
      setStats(statsRes.data?.data ?? null);
      setTopSkills(skillsRes.data?.data ?? []);
      setPools(poolsRes.data?.data ?? []);
    } catch (err) {
      setResumes([]);
      toast.error(err?.response?.data?.error || 'Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }, [search, stageFilter, skillFilter]);

  useEffect(() => { fetchResumes(); }, []); // eslint-disable-line

  // Debounced search
  const handleSearch = (val) => {
    setSearch(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchResumes(val, stageFilter, skillFilter), 400);
  };

  const handleStage = (val) => { setStageFilter(val); fetchResumes(search, val, skillFilter); };

  const handleSkill = (val) => {
    const next = skillFilter === val ? '' : val;
    setSkillFilter(next);
    fetchResumes(search, stageFilter, next);
  };

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Resume Database</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>
            All candidate profiles — active pipeline &amp; speculative uploads
          </p>
        </div>
        <button onClick={() => setShowUpload(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 9, border: 'none', background: '#6B3FDB', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          <Upload size={14} /> Upload Resume
        </button>
      </div>

      {/* Stats bar */}
      {stats && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Total', value: stats.total, color: '#1f2937' },
            { label: 'With Resume', value: stats.with_resume, color: '#059669' },
            { label: 'Without Resume', value: stats.without_resume, color: '#dc2626' },
            { label: 'Hired', value: stats.hired, color: '#6B3FDB' },
          ].map(s => (
            <div key={s.label} style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 10, padding: '10px 18px', minWidth: 110 }}>
              <p style={{ fontSize: 22, fontWeight: 700, color: s.color, margin: 0 }}>{s.value ?? 0}</p>
              <p style={{ fontSize: 11, color: '#9ca3af', margin: '2px 0 0' }}>{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Search + stage pills */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input value={search} onChange={e => handleSearch(e.target.value)}
            placeholder="Search name, company, skills…"
            style={{ width: '100%', paddingLeft: 32, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        {STAGES.map(s => (
          <button key={s.value} onClick={() => handleStage(s.value)}
            style={{ padding: '7px 13px', borderRadius: 8, border: '1px solid', fontSize: 12, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
              borderColor: stageFilter === s.value ? '#6B3FDB' : '#e5e7eb',
              background:   stageFilter === s.value ? '#6B3FDB' : '#fff',
              color:        stageFilter === s.value ? '#fff'    : '#374151' }}>
            {s.label}
          </button>
        ))}
      </div>

      {/* Skill chips */}
      {topSkills.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 600, marginRight: 4 }}>Skills:</span>
          {topSkills.map(sk => (
            <button key={sk} onClick={() => handleSkill(sk)}
              style={{ padding: '4px 11px', borderRadius: 20, border: '1px solid', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                borderColor: skillFilter === sk ? '#6B3FDB' : '#e5e7eb',
                background:   skillFilter === sk ? '#6B3FDB' : '#faf5ff',
                color:        skillFilter === sk ? '#fff'    : '#6B3FDB' }}>
              {sk}
            </button>
          ))}
          {skillFilter && (
            <button onClick={() => handleSkill('')}
              style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 9px', borderRadius: 20, border: '1px solid #fca5a5', background: '#fee2e2', color: '#dc2626', fontSize: 11, cursor: 'pointer' }}>
              <X size={10} /> Clear
            </button>
          )}
        </div>
      )}

      {/* Candidate grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>
      ) : resumes.length === 0 ? (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <User size={40} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#9ca3af', margin: 0 }}>No candidates found</p>
          <button onClick={() => setShowUpload(true)}
            style={{ marginTop: 14, padding: '8px 18px', borderRadius: 8, border: 'none', background: '#6B3FDB', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            + Upload First Resume
          </button>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 12, color: '#9ca3af', marginBottom: 12 }}>{resumes.length} candidate{resumes.length !== 1 ? 's' : ''}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {resumes.map(c => (
              <CandidateCard key={c.id} candidate={c} onAddToPool={setAddToPool} onEdit={setEditCandidate} />
            ))}
          </div>
        </>
      )}

      {/* Modals */}
      {showUpload && (
        <UploadResumeModal
          onClose={() => setShowUpload(false)}
          onSuccess={() => { setShowUpload(false); fetchResumes(); }}
        />
      )}
      {addToPool && (
        <AddToPoolModal
          candidate={addToPool}
          pools={pools}
          onClose={() => setAddToPool(null)}
          onSuccess={() => { setAddToPool(null); fetchResumes(); }}
        />
      )}
      {editCandidate && (
        <EditCandidateModal
          candidate={editCandidate}
          onClose={() => setEditCandidate(null)}
          onSuccess={() => { setEditCandidate(null); fetchResumes(); }}
        />
      )}
    </div>
  );
}
