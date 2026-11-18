import { useEffect, useState } from 'react';
import { X, Upload, Wand2, UserPlus } from 'lucide-react';
import api from '@/services/api/client';
import Dialog from './Dialog';
import useRecruitmentSettings from '../useRecruitmentSettings';
import { sourceOptions, QUALIFICATIONS } from '../constants';

/**
 * Add candidate — the one form for creating a candidate.
 *
 * There used to be three (Pipeline, Résumé Database, Talent Pool detail) on two
 * different APIs with different fields. This posts to /recruitment/candidates,
 * whose createCandidate() owns the duplicate-email guard and the closed-opening
 * guard, and can read the résumé first to pre-fill the form.
 *
 * Props: open, onClose, onCreated(candidate), defaultJobId.
 */
const EMPTY = {
  full_name: '', email: '', phone: '', source: 'manual', source_agency_id: '', applied_job_id: '',
  current_company: '', current_designation: '', experience_years: '', notice_period_days: '',
  expected_ctc: '', location: '', qualification: '', specialisation: '', institution: '',
  graduation_year: '', skills: '', notes: '',
};

const S = {
  head: { padding: '16px 20px', borderBottom: '1px solid #eef0f4', display: 'flex', alignItems: 'center', gap: 10 },
  body: { padding: 20, overflowY: 'auto', flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  foot: { padding: '12px 20px', borderTop: '1px solid #eef0f4', display: 'flex', justifyContent: 'flex-end', gap: 8 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input: { width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box', background: '#fff' },
  wide: { gridColumn: '1 / -1' },
  err: { gridColumn: '1 / -1', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 13 },
  note: { gridColumn: '1 / -1', fontSize: 12, color: '#6b7280' },
};

export default function AddCandidateDialog({ open, onClose, onCreated, defaultJobId = '' }) {
  const settings = useRecruitmentSettings();
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState(null);
  const [openings, setOpenings] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseNote, setParseNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, applied_job_id: defaultJobId ? String(defaultJobId) : '' });
    setFile(null); setError(''); setParseNote('');
    api.get('/recruitment/openings', { params: { status: 'open' } })
      .then(r => setOpenings(Array.isArray(r.data) ? r.data : [])).catch(() => setOpenings([]));
    api.get('/talent/agencies')
      .then(r => setAgencies(Array.isArray(r.data?.data) ? r.data.data : (Array.isArray(r.data) ? r.data : []))).catch(() => setAgencies([]));
  }, [open, defaultJobId]);

  if (!open) return null;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const readResume = async () => {
    if (!file) return;
    setParsing(true); setParseNote(''); setError('');
    try {
      const fd = new FormData();
      fd.append('resume', file);
      const res = await api.post('/recruitment/resume/parse', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const got = res.data?.fields || res.data || {};
      let filled = 0;
      setForm(f => {
        const next = { ...f };
        const put = (k, v) => { if (v != null && v !== '' && !String(next[k] || '').trim()) { next[k] = String(v); filled++; } };
        put('full_name', got.full_name); put('email', got.email); put('phone', got.phone);
        put('current_company', got.current_company); put('current_designation', got.current_designation);
        put('experience_years', got.experience_years); put('notice_period_days', got.notice_period_days);
        put('expected_ctc', got.expected_ctc); put('location', got.location);
        if (QUALIFICATIONS.includes(got.qualification)) put('qualification', got.qualification);
        put('specialisation', got.specialisation); put('institution', got.institution);
        put('graduation_year', got.graduation_year);
        if (Array.isArray(got.skills) && got.skills.length) put('skills', got.skills.join(', '));
        return next;
      });
      setParseNote(filled ? 'Filled from the résumé — check each value before saving.' : 'Nothing could be read from this résumé; fill the form by hand.');
    } catch (e) {
      setParseNote(e?.response?.data?.error || 'The résumé could not be read; fill the form by hand.');
    } finally { setParsing(false); }
  };

  const save = async () => {
    if (!form.full_name.trim()) return setError('Name is required.');
    if (!form.email.trim() && !form.phone.trim()) return setError('Give an email or a phone number so the candidate can be contacted.');
    if (form.source === 'agency' && !form.source_agency_id) return setError('Choose the agency that supplied this candidate.');
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => {
        if (k === 'skills') {
          const list = String(v).split(',').map(x => x.trim()).filter(Boolean);
          if (list.length) fd.append('skills', JSON.stringify(list));
        } else if (String(v).trim() !== '') fd.append(k, String(v).trim());
      });
      if (file) fd.append('resume', file);
      const res = await api.post('/recruitment/candidates', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      onCreated?.(res.data);
      onClose?.();
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not add the candidate.');
    } finally { setSaving(false); }
  };

  const field = (label, key, props = {}) => (
    <div style={props.wide ? S.wide : undefined}>
      <label style={S.label} htmlFor={`acd-${key}`}>{label}</label>
      <input id={`acd-${key}`} style={S.input} value={form[key]} onChange={e => set(key, e.target.value)} {...props.input} />
    </div>
  );

  return (
    <Dialog width="min(680px, 100%)" overflowY="hidden">
      <div style={S.head}>
        <UserPlus size={18} color="var(--color-primary, #6B3FDB)" />
        <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>Add candidate</h3>
        <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><X size={18} /></button>
      </div>
      <div style={S.body}>
        <div style={S.wide}>
          <label style={S.label} htmlFor="acd-resume">Résumé (PDF or Word, up to 5 MB)</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label htmlFor="acd-resume" style={{ ...S.input, width: 'auto', flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: file ? '#111827' : '#6b7280' }}>
              <Upload size={14} /> {file ? file.name : 'Choose a file'}
            </label>
            <input id="acd-resume" type="file" accept=".pdf,.doc,.docx" style={{ display: 'none' }}
                   onChange={e => { setFile(e.target.files?.[0] || null); setParseNote(''); }} />
            <button type="button" className="pulse-btn-secondary" disabled={!file || parsing} onClick={readResume}>
              <Wand2 size={14} /> {parsing ? 'Reading…' : 'Read résumé'}
            </button>
          </div>
        </div>
        {parseNote && <div style={S.note}>{parseNote}</div>}

        {field('Full name *', 'full_name', { wide: true })}
        {field('Email', 'email', { input: { type: 'email' } })}
        {field('Phone', 'phone')}

        <div>
          <label style={S.label} htmlFor="acd-job">Applying for</label>
          <select id="acd-job" style={S.input} value={form.applied_job_id} onChange={e => set('applied_job_id', e.target.value)}>
            <option value="">No specific opening (keep on file)</option>
            {openings.map(o => <option key={o.id} value={o.id}>{o.job_title}{o.department ? ` — ${o.department}` : ''}</option>)}
          </select>
        </div>
        <div>
          <label style={S.label} htmlFor="acd-source">Source</label>
          <select id="acd-source" style={S.input} value={form.source} onChange={e => set('source', e.target.value)}>
            {sourceOptions(settings).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {form.source === 'agency' && (
          <div style={S.wide}>
            <label style={S.label} htmlFor="acd-agency">Agency *</label>
            <select id="acd-agency" style={S.input} value={form.source_agency_id} onChange={e => set('source_agency_id', e.target.value)}>
              <option value="">Choose the agency…</option>
              {agencies.filter(a => a.is_active !== false).map(a => <option key={a.id} value={a.id}>{a.agency_name || a.name}</option>)}
            </select>
          </div>
        )}

        {field('Current company', 'current_company')}
        {field('Current designation', 'current_designation')}
        {field('Total experience (years)', 'experience_years', { input: { type: 'number', min: 0, step: 0.5 } })}
        {field('Notice period (days)', 'notice_period_days', { input: { type: 'number', min: 0 } })}
        {field('Expected CTC (₹ per year)', 'expected_ctc', { input: { type: 'number', min: 0 } })}
        {field('Location', 'location')}
        <div>
          <label style={S.label} htmlFor="acd-qual">Qualification</label>
          <select id="acd-qual" style={S.input} value={form.qualification} onChange={e => set('qualification', e.target.value)}>
            <option value="">Not given</option>
            {QUALIFICATIONS.map(q => <option key={q} value={q}>{q}</option>)}
          </select>
        </div>
        {field('Specialisation', 'specialisation')}
        {field('Institution', 'institution')}
        {field('Graduation year', 'graduation_year', { input: { type: 'number', min: 1950, max: 2100 } })}
        {field('Skills (comma-separated)', 'skills', { wide: true, input: { placeholder: 'Power Electronics, MATLAB' } })}
        <div style={S.wide}>
          <label style={S.label} htmlFor="acd-notes">Notes</label>
          <textarea id="acd-notes" rows={3} style={S.input} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
        {error && <div style={S.err} role="alert">{error}</div>}
      </div>
      <div style={S.foot}>
        <button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="pulse-btn-primary" onClick={save} disabled={saving}>{saving ? 'Adding…' : 'Add candidate'}</button>
      </div>
    </Dialog>
  );
}
