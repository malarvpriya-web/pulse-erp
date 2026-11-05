import { useState, useEffect } from 'react';
import { GraduationCap } from 'lucide-react';
import api from '@/services/api/client';
import ResultDialog from '@/components/ResultDialog';
import MasterSelect from '@/components/core/MasterSelect';
import VocabSelect from '@/components/core/VocabSelect';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { loadEmployeeImage, isExternalUrl, openEmployeeFile } from '@/features/employees/shared/employeeFiles';
import { durationLabel, inclusiveDays } from '../internship';
// The Add Employee stylesheet: same accordion, grid, upload tiles and save bar,
// so the two forms look like one product rather than a second copy of it.
import '@/features/employees/pages/AddEmployee.css';
import './Internships.css';

/** Which accordion section holds each field — used to open the right one on an error. */
const SECTION_OF = {
  first_name: 'personal', last_name: 'personal', dob: 'personal', gender: 'personal',
  personal_email: 'personal', phone: 'personal', address: 'personal',
  emergency_name: 'personal', emergency_phone: 'personal', emergency_relationship: 'personal',
  college: 'education', course: 'education', specialization: 'education',
  current_year: 'education', graduation_year: 'education',
  department: 'internship', designation: 'internship', mentor_employee_id: 'internship',
  internship_type: 'internship', start_date: 'internship', end_date: 'internship',
  status: 'internship', status_reason: 'internship', project_work_area: 'internship',
  stipend: 'compensation', stipend_frequency: 'compensation', other_benefits: 'compensation',
  notes: 'notes',
};
const SECTION_ORDER = ['personal', 'education', 'internship', 'compensation', 'completion', 'docs', 'notes'];
const SECTION_TITLE = {
  personal: 'Personal Information', education: 'Education', internship: 'Internship Information',
  compensation: 'Compensation', completion: 'Completion & Certificate', docs: 'Documents', notes: 'Notes',
};
const FIELD_ID = (k) => `ai-${k.replace(/_/g, '-')}`;

/** Every column the form owns, with its blank value. Add and Edit both send all of them. */
const BLANK = {
  first_name: '', last_name: '', dob: '', gender: '', personal_email: '', phone: '', address: '',
  emergency_name: '', emergency_phone: '', emergency_relationship: '',
  college: '', course: '', specialization: '', current_year: '', graduation_year: '',
  department: '', designation: '', mentor_employee_id: '', internship_type: '',
  start_date: '', end_date: '', status: 'Selected', status_reason: '', project_work_area: '',
  stipend: '', stipend_frequency: '', other_benefits: '',
  notes: '',
};

/** Seed the form from a stored record: every key in BLANK, nothing else. */
function seed(intern) {
  if (!intern) return { ...BLANK };
  const out = {};
  for (const [k, blank] of Object.entries(BLANK)) {
    const v = intern[k];
    if (typeof blank === 'boolean') out[k] = v === true;
    else out[k] = v == null ? '' : String(v).slice(0, k.endsWith('_date') || k === 'dob' ? 10 : undefined);
  }
  return out;
}

/**
 * Education dropdowns — master_values vocabularies (see
 * backend modules/master/vocabularies.js). One list, used by Add and Edit alike,
 * because they are the same form. The API validates each value against the same
 * vocabulary, scoped to the caller's company.
 */
export const EDUCATION_PICKERS = [
  { k: 'course',         label: 'Course / Degree',         vocab: 'courses',         required: true },
  { k: 'specialization', label: 'Specialization',          vocab: 'specializations', required: false },
  { k: 'current_year',   label: 'Current Year / Semester', vocab: 'academic-years',  required: false },
];

const Req = () => <span className="req" aria-hidden="true">*</span>;

/**
 * One form cell. DEFINED AT MODULE LEVEL — a component declared inside the page
 * body is a new type every render and remounts every field on every keystroke
 * (the AddEmployee bug, see the note there).
 */
const Field = ({ k, label, required = false, error, children, wide = false }) => (
  <div className={error ? 'is-invalid' : undefined} style={wide ? { gridColumn: '1 / -1' } : undefined}>
    <label htmlFor={FIELD_ID(k)}>{label}{required && <Req />}</label>
    {children}
    {error && <span className="field-error" id={`${FIELD_ID(k)}-err`} role="alert">{error}</span>}
  </div>
);

const today = () => new Date().toLocaleDateString('en-CA');

/**
 * ONE form for Add Intern and Edit Intern.
 *
 * Edit mode is `intern` set — EditIntern.jsx loads the FULL record and mounts
 * this with it, keyed by id. Every field Add captures is in BLANK, and BLANK is
 * both what is seeded from the record and what is sent on save, so a field
 * cannot exist on one mode and not the other.
 */
export default function AddIntern({ setPage, intern = null }) {
  const editing = !!intern;
  const [f, setF] = useState(() => seed(intern));
  const [errors, setErrors] = useState({});
  const [open, setOpen] = useState('personal');
  const [meta, setMeta] = useState(null);
  const [mentors, setMentors] = useState([]);
  const [code, setCode] = useState(intern?.intern_code || '');
  const [codeState, setCodeState] = useState(editing ? 'settled' : 'loading');
  const [dialog, setDialog] = useState(null);
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Photo
  const [photoFile, setPhotoFile] = useState(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoPreview, setPhotoPreview] = useState(null);
  // Documents: newly chosen files per doc-type key, a title per key, and the ids
  // of stored documents to remove on save.
  const [newDocs, setNewDocs] = useState({});
  const [docTitles, setDocTitles] = useState({});
  const [removeDocs, setRemoveDocs] = useState(() => new Set());
  const [inputGen, setInputGen] = useState({});
  const [fileError, setFileError] = useState('');

  const set = (k) => (v) => {
    setF(prev => ({ ...prev, [k]: v }));
    setErrors(e => (e[k] ? { ...e, [k]: undefined } : e));
  };
  const onInput = (k) => (e) => set(k)(e.target.type === 'checkbox' ? e.target.checked : e.target.value);

  useEffect(() => {
    api.get('/interns/meta').then(r => setMeta(r.data)).catch(() => setMeta(null));
    api.get('/interns/mentor-options').then(r => setMentors(Array.isArray(r.data) ? r.data : [])).catch(() => setMentors([]));
    if (!editing) {
      api.get('/interns/next-code')
        .then(r => setCode(typeof r.data?.code === 'string' ? r.data.code : ''))
        .catch(() => setCode(''))
        .finally(() => setCodeState('settled'));
    }
  }, [editing]);

  // Photo preview: a chosen file, else the stored photo fetched with the JWT.
  useEffect(() => {
    let revoke = null; let cancelled = false;
    if (photoFile) {
      revoke = URL.createObjectURL(photoFile);
      setPhotoPreview(revoke);
    } else if (intern?.photo_url && !removePhoto) {
      loadEmployeeImage(intern.photo_url).then(url => {
        if (cancelled) { if (url && !isExternalUrl(intern.photo_url)) URL.revokeObjectURL(url); return; }
        if (url && !isExternalUrl(intern.photo_url)) revoke = url;
        setPhotoPreview(url);
      });
    } else setPhotoPreview(null);
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [photoFile, intern?.photo_url, removePhoto]);

  // The statuses this form may offer: a new internship's starting statuses, or
  // the stored status plus the moves allowed from it (STATUS_TRANSITIONS on the
  // server, served by /interns/meta). Completed is never offered — it is
  // recorded from the intern record after HR approves the mentor's evaluation.
  const statusOptions = !meta ? [f.status]
    : editing ? [intern.status, ...((meta.transitions || {})[intern.status] || [])]
    : (meta.initial_statuses || []);

  const days = inclusiveDays(f.start_date, f.end_date);
  const durationText = f.start_date && f.end_date
    ? (days >= 1 ? durationLabel(f.start_date, f.end_date) : 'End date is before start date')
    : 'Set start and end dates';

  const storedDocs = intern?.documents || [];
  const errorCount = Object.values(errors).filter(Boolean).length;

  const jumpTo = (field) => {
    const section = SECTION_OF[field];
    if (section) setOpen(section);
    setTimeout(() => {
      const el = document.getElementById(FIELD_ID(field));
      el?.focus();
      el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }, 60);
  };

  /** The same required rules the API applies, checked first so the user is told on the field. */
  const validate = () => {
    const e = {};
    const blank = (v) => !String(v ?? '').trim();
    if (blank(f.first_name)) e.first_name = 'First name is required.';
    if (blank(f.college)) e.college = 'College / institution is required.';
    if (blank(f.course)) e.course = 'Course / degree is required.';
    if (blank(f.department)) e.department = 'Select a department.';
    if (blank(f.designation)) e.designation = 'Select an internship role.';
    if (blank(f.start_date)) e.start_date = 'Start date is required.';
    if (blank(f.end_date)) e.end_date = 'End date is required.';
    if (!e.start_date && !e.end_date && f.end_date < f.start_date) e.end_date = 'End date cannot be before the start date.';
    if (meta && days > meta.max_duration_days) e.end_date = `An internship cannot be longer than ${meta.max_duration_days} days.`;
    if (f.personal_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.personal_email)) e.personal_email = 'Enter a valid email address.';
    const phoneOk = (v) => !v || /^\+?[0-9]{10,13}$/.test(v.replace(/[\s\-()]/g, ''));
    if (!phoneOk(f.phone)) e.phone = 'Phone must be 10 to 13 digits.';
    if (!phoneOk(f.emergency_phone)) e.emergency_phone = 'Emergency phone must be 10 to 13 digits.';
    if (f.stipend !== '' && (!Number.isFinite(Number(f.stipend)) || Number(f.stipend) < 0)) e.stipend = 'Stipend must be a positive amount.';
    if (Number(f.stipend) > 0 && !f.stipend_frequency) e.stipend_frequency = 'Select how often the stipend is paid.';
    if (f.stipend_frequency === 'Unpaid' && Number(f.stipend) > 0) e.stipend = 'An unpaid internship cannot carry a stipend amount.';
    return e;
  };

  const save = async () => {
    if (saving || submitted) return;
    const e = validate();
    setErrors(e);
    const first = Object.keys(SECTION_OF).find(k => e[k]);
    if (first) { jumpTo(first); return; }

    setSaving(true);
    try {
      const fd = new FormData();
      for (const k of Object.keys(BLANK)) {
        const v = f[k];
        // '' is sent, never null: FormData turns null into the STRING "null".
        fd.append(k, v == null ? '' : String(v));
      }
      if (photoFile) fd.append('photo_file', photoFile);
      if (editing && removePhoto && !photoFile) fd.append('remove_photo', 'true');
      if (editing && removeDocs.size) fd.append('remove_documents', [...removeDocs].join(','));
      for (const [key, files] of Object.entries(newDocs)) {
        for (const file of files || []) fd.append(`doc_${key}`, file);
        if ((files || []).length && docTitles[key]?.trim()) fd.append(`title_${key}`, docTitles[key].trim());
      }

      const { data } = editing
        ? await api.put(`/interns/${intern.id}`, fd)
        : await api.post('/interns', fd);
      setSubmitted(true);
      setDialog({
        type: 'success',
        title: editing ? 'Intern Updated' : 'Intern Added',
        message: editing
          ? `${data.intern_code} has been updated.`
          : `${data.first_name} has been added as ${data.intern_code}.`,
        autoClose: 1800,
      });
      setTimeout(() => setPage('ViewIntern', { id: data.id }), 1900);
    } catch (err) {
      const body = err?.response?.data || {};
      const msg = body.error || body.message || err?.message || 'Could not save the intern.';
      if (body.field && SECTION_OF[body.field]) {
        setErrors(prev => ({ ...prev, [body.field]: msg }));
        jumpTo(body.field);
      } else {
        setDialog({ type: 'error', title: 'Save Failed', message: msg });
      }
    } finally {
      setSaving(false);
    }
  };

  const section = (key, body) => (
    <div className="accordion" key={key}>
      <div className="accordion-header" onClick={() => setOpen(key)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(key); } }}
        aria-expanded={open === key}>
        <h2>{SECTION_TITLE[key]}</h2>
        {SECTION_ORDER.indexOf(key) >= 0 && Object.keys(errors).some(k => errors[k] && SECTION_OF[k] === key) && (
          <span style={{ color: '#fecaca', fontSize: 11, fontWeight: 700 }}>needs attention</span>
        )}
      </div>
      {open === key && <div className="accordion-body">{body}</div>}
    </div>
  );

  const text = (k, label, opts = {}) => (
    <Field k={k} label={label} required={opts.required} error={errors[k]} wide={opts.wide}>
      {opts.textarea
        ? <textarea id={FIELD_ID(k)} value={f[k]} onChange={onInput(k)} rows={opts.rows || 3} placeholder={opts.placeholder} />
        : <input id={FIELD_ID(k)} type={opts.type || 'text'} value={f[k]} onChange={onInput(k)} placeholder={opts.placeholder}
            inputMode={opts.inputMode} min={opts.min} max={opts.max} step={opts.step}
            aria-describedby={errors[k] ? `${FIELD_ID(k)}-err` : undefined} />}
    </Field>
  );

  const docTypes = meta?.doc_types || [];

  return (
    <PageShell dock={
      <PageHero
        icon={GraduationCap}
        eyebrow="Internships"
        title={editing ? 'Edit Intern' : 'Add Intern'}
        subtitle={editing
          ? `Update ${[intern.first_name, intern.last_name].filter(Boolean).join(' ')} · ${intern.intern_code}`
          : 'Interns get an INT number and stay out of the employee register, headcount and payroll.'}
      />
    }>
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />
      <div className="page-container">
        <form noValidate onSubmit={(e) => { e.preventDefault(); save(); }} className="add-employee-form">
          <div className="form-wrapper">

            {section('personal', (
              <div className="form-grid">
                <div>
                  <label htmlFor="ai-intern-code">Intern ID</label>
                  <input id="ai-intern-code" readOnly disabled aria-readonly="true"
                    value={code || (codeState === 'loading' ? 'Fetching ID…' : 'Assigned on save')}
                    title={editing ? 'Intern IDs never change.' : 'A preview. The ID is reserved when the record is saved.'} />
                </div>
                {text('first_name', 'First Name', { required: true })}
                {text('last_name', 'Last Name')}
                {text('dob', 'Date of Birth', { type: 'date', max: today() })}
                <Field k="gender" label="Gender" error={errors.gender}>
                  <select id={FIELD_ID('gender')} value={f.gender} onChange={onInput('gender')}>
                    <option value="">-- Select Gender --</option>
                    <option>Male</option><option>Female</option><option>Other</option>
                  </select>
                </Field>
                {text('personal_email', 'Personal Email', { type: 'email' })}
                {text('phone', 'Phone', { type: 'tel', inputMode: 'numeric' })}
                {text('address', 'Address', { textarea: true })}
                {text('emergency_name', 'Emergency Contact')}
                {text('emergency_phone', 'Emergency Phone', { type: 'tel', inputMode: 'numeric' })}
                <Field k="emergency_relationship" label="Relationship" error={errors.emergency_relationship}>
                  <select id={FIELD_ID('emergency_relationship')} value={f.emergency_relationship} onChange={onInput('emergency_relationship')}>
                    <option value="">-- Select --</option>
                    {['Father', 'Mother', 'Guardian', 'Spouse', 'Brother', 'Sister', 'Friend', 'Other'].map(r => <option key={r}>{r}</option>)}
                    {f.emergency_relationship && !['Father', 'Mother', 'Guardian', 'Spouse', 'Brother', 'Sister', 'Friend', 'Other'].includes(f.emergency_relationship)
                      && <option>{f.emergency_relationship}</option>}
                  </select>
                </Field>
                <div>
                  <label htmlFor="ai-photo">Photo</label>
                  {photoPreview && (
                    <img src={photoPreview} alt="Intern photo preview"
                      style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #e9e4ff', margin: '6px 0', display: 'block' }} />
                  )}
                  <input id="ai-photo" type="file" accept="image/*" key={`photo-${inputGen.photo || 0}`}
                    onChange={e => { setPhotoFile(e.target.files?.[0] || null); setRemovePhoto(false); }} />
                  <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                    {photoFile && (
                      <button type="button" className="ai-link" onClick={() => { setPhotoFile(null); setInputGen(g => ({ ...g, photo: (g.photo || 0) + 1 })); }}>
                        Clear selection
                      </button>
                    )}
                    {editing && intern.photo_url && !photoFile && (
                      <button type="button" className="ai-link" style={{ color: removePhoto ? '#6B3FDB' : '#dc2626' }}
                        onClick={() => setRemovePhoto(r => !r)}>
                        {removePhoto ? 'Undo remove' : 'Remove photo'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {section('education', (
              <div className="form-grid">
                {text('college', 'College / Institution', { required: true })}
                {EDUCATION_PICKERS.map(p => (
                  <Field key={p.k} k={p.k} label={p.label} required={p.required} error={errors[p.k]}>
                    {/* searchable={false}: the native <select> keeps its "-- Select --"
                        row, which is how an optional value is CLEARED (the searchable
                        combobox has no way back to blank). A stored value that is not
                        in the master — free text from before these were dropdowns, or
                        a value since deactivated — is offered back as its own option,
                        so it is shown and kept, never blanked by the next save. */}
                    <VocabSelect onNavigate={setPage} searchable={false} vocab={p.vocab} id={FIELD_ID(p.k)}
                      value={f[p.k]} required={p.required}
                      orphanLabel={f[p.k] ? `${f[p.k]} (not in list)` : undefined}
                      onChange={(v) => set(p.k)(v ?? '')} placeholder={`-- Select ${p.label} --`} />
                  </Field>
                ))}
                {text('graduation_year', 'Graduation Year', { type: 'number', min: 1950, max: 2100, step: 1 })}
              </div>
            ))}

            {section('internship', (
              <div className="form-grid">
                <Field k="department" label="Department" required error={errors.department}>
                  <MasterSelect onNavigate={setPage} id={FIELD_ID('department')} endpoint="/master/departments"
                    label="Department" searchable required value={f.department} onChange={(v) => set('department')(v ?? '')} />
                </Field>
                <Field k="designation" label="Internship Role / Designation" required error={errors.designation}>
                  <MasterSelect onNavigate={setPage} id={FIELD_ID('designation')} endpoint="/master/designations"
                    label="Designation" searchable required value={f.designation} onChange={(v) => set('designation')(v ?? '')} />
                </Field>
                <Field k="mentor_employee_id" label="Mentor / Reporting Manager" error={errors.mentor_employee_id}>
                  <select id={FIELD_ID('mentor_employee_id')} value={f.mentor_employee_id} onChange={onInput('mentor_employee_id')}>
                    <option value="">— None —</option>
                    {/* A mentor who has since left is still this record's mentor
                        until someone changes it — offer them back rather than
                        letting the select fall to None and clear it on save. */}
                    {f.mentor_employee_id && !mentors.some(m => String(m.id) === f.mentor_employee_id) && (
                      <option value={f.mentor_employee_id}>{intern?.mentor_name || `Employee #${f.mentor_employee_id}`} (current)</option>
                    )}
                    {mentors.map(m => (
                      <option key={m.id} value={String(m.id)}>
                        {m.name || `Employee #${m.id}`}{m.office_id ? ` · ${m.office_id}` : ''}{m.designation ? ` — ${m.designation}` : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field k="internship_type" label="Internship Type" error={errors.internship_type}>
                  <VocabSelect onNavigate={setPage} searchable={false} vocab="internship-types" id={FIELD_ID('internship_type')}
                    value={f.internship_type} onChange={(v) => set('internship_type')(v ?? '')} placeholder="-- Select Type --" />
                </Field>
                {text('start_date', 'Start Date', { type: 'date', required: true })}
                {text('end_date', 'End Date', { type: 'date', required: true })}
                <div>
                  <label htmlFor="ai-duration">Duration</label>
                  <input id="ai-duration" readOnly disabled value={durationText} title="Calculated from the start and end dates." />
                </div>
                <Field k="status" label="Status" required error={errors.status}>
                  <select id={FIELD_ID('status')} value={f.status} onChange={onInput('status')}>
                    {statusOptions.map(s => <option key={s}>{s}</option>)}
                  </select>
                </Field>
                {text('project_work_area', 'Project / Work Area', { textarea: true, wide: true })}
                {['Cancelled', 'Terminated'].includes(f.status) && text('status_reason', `Reason ${f.status === 'Cancelled' ? 'for cancellation' : 'for termination'}`, { textarea: true, wide: true })}
              </div>
            ))}

            {section('compensation', (
              <>
                <div className="form-grid">
                  {text('stipend', 'Stipend (₹)', { type: 'number', min: 0, step: '0.01', inputMode: 'decimal' })}
                  <Field k="stipend_frequency" label="Stipend Frequency" error={errors.stipend_frequency}>
                    <select id={FIELD_ID('stipend_frequency')} value={f.stipend_frequency} onChange={onInput('stipend_frequency')}>
                      <option value="">-- Select --</option>
                      {(meta?.stipend_frequencies || []).map(s => <option key={s}>{s}</option>)}
                    </select>
                  </Field>
                  {text('other_benefits', 'Other Benefits', { textarea: true, placeholder: 'e.g. Laptop, meals, travel allowance' })}
                </div>
                <p style={{ fontSize: 11, color: '#6b7280', margin: '10px 0 0' }}>
                  A stipend is recorded on the internship only. It is not a salary and never reaches payroll.
                </p>
              </>
            ))}

            {section('completion', (
              <div>
                {intern?.status === 'Completed' ? (
                  <div className="form-grid">
                    <div><label>Completed On</label><input readOnly disabled value={intern.completed_on || ''} /></div>
                    <div><label>Certificate</label><input readOnly disabled
                      value={intern.certificate_issued ? `Issued — ${intern.certificate_number}` : 'Not issued'} /></div>
                  </div>
                ) : null}
                <p style={{ fontSize: 12, color: '#6b7280', margin: intern?.status === 'Completed' ? '10px 0 0' : 0 }}>
                  Completion and certificates are recorded from the intern record — <strong>Mark Completed</strong> once HR has
                  approved the mentor&apos;s evaluation, then <strong>Issue certificate</strong>. They are not edited here.
                </p>
              </div>
            ))}

            {section('docs', (
              <div className="upload-grid">
                {fileError && <p role="alert" style={{ gridColumn: '1 / -1', color: '#dc2626', fontSize: 12, margin: 0 }}>{fileError}</p>}
                {docTypes.map(dt => {
                  const stored = storedDocs.filter(d => d.doc_type === dt.label);
                  const chosen = newDocs[dt.key] || [];
                  const multiple = dt.key === 'other';
                  return (
                    <div className="upload-box" key={dt.key}>
                      <span>{dt.label === 'Institution Letter' ? 'College / Institution Letter'
                        : dt.label === 'Offer Letter' ? 'Internship Offer Letter'
                        : dt.label === 'NDA' ? 'NDA / Confidentiality' : dt.label === 'Other' ? 'Other Documents' : dt.label}
                        {' '}{(stored.some(d => !removeDocs.has(d.id)) || chosen.length > 0) && <span style={{ color: 'green', fontWeight: 'bold' }}>✓</span>}
                      </span>
                      {stored.map(d => {
                        const removing = removeDocs.has(d.id);
                        return (
                          <div key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, margin: '4px 0', flexWrap: 'wrap' }}>
                            <span style={{ color: removing ? '#b45309' : '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150, whiteSpace: 'nowrap' }}
                              title={d.title || d.original_name}>
                              {removing ? 'Will be removed' : (d.title || d.original_name || 'On file')}
                            </span>
                            {!removing && (
                              <button type="button" className="ai-link" onClick={async () => setFileError((await openEmployeeFile(d.file_url)) || '')}>View</button>
                            )}
                            <button type="button" className="ai-link" style={{ color: removing ? '#6B3FDB' : '#dc2626' }}
                              aria-label={removing ? `Keep ${d.original_name || dt.label}` : `Remove ${d.original_name || dt.label}`}
                              onClick={() => setRemoveDocs(prev => { const n = new Set(prev); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); return n; })}>
                              {removing ? 'Undo' : 'Remove'}
                            </button>
                          </div>
                        );
                      })}
                      <input type="file" multiple={multiple} key={`${dt.key}-${inputGen[dt.key] || 0}`}
                        accept="image/*,.pdf,.doc,.docx"
                        aria-label={`Upload ${dt.label}`}
                        onChange={e => setNewDocs(d => ({ ...d, [dt.key]: Array.from(e.target.files || []) }))} />
                      {multiple && chosen.length > 0 && (
                        <input type="text" placeholder="Describe these documents" value={docTitles[dt.key] || ''}
                          onChange={e => setDocTitles(t => ({ ...t, [dt.key]: e.target.value }))} style={{ marginTop: 6 }} />
                      )}
                      {chosen.length > 0 && (
                        <button type="button" className="ai-link" style={{ marginTop: 6 }}
                          onClick={() => { setNewDocs(d => ({ ...d, [dt.key]: [] })); setInputGen(g => ({ ...g, [dt.key]: (g[dt.key] || 0) + 1 })); }}>
                          Clear selection
                        </button>
                      )}
                    </div>
                  );
                })}
                <p style={{ gridColumn: '1 / -1', fontSize: 11, color: '#9ca3af', margin: 0 }}>
                  Images, PDF or Word, up to 5 MB each. Files are stored with the employee documents and opened only through the secure file service.
                </p>
              </div>
            ))}

            {section('notes', (
              <textarea id={FIELD_ID('notes')} className="notes-textarea" rows="5" value={f.notes} onChange={onInput('notes')}
                placeholder="Project assignment, mentor feedback, onboarding notes…" />
            ))}
          </div>

          <div className="ae-save-bar">
            <button type="submit" className="save-btn" disabled={saving || submitted}>
              {saving ? 'Saving…' : submitted ? 'Saved' : 'Save'}
            </button>
            <button type="button" className="pulse-btn-secondary" disabled={saving}
              onClick={() => (editing ? setPage('ViewIntern', { id: intern.id }) : setPage('Internships'))}>
              Cancel
            </button>
            <span className={`ae-save-hint${errorCount ? ' is-error' : ''}`} role="status" aria-live="polite">
              {saving ? 'Saving intern…'
                : submitted ? 'Saved. Opening the intern record…'
                : errorCount ? `${errorCount} field${errorCount === 1 ? '' : 's'} need${errorCount === 1 ? 's' : ''} attention.`
                : 'First name, college, course, department, role, start date and end date are required.'}
            </span>
          </div>
        </form>
      </div>
    </PageShell>
  );
}
