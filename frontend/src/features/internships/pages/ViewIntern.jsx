import { useState, useEffect, useMemo, useCallback } from 'react';
import { GraduationCap } from 'lucide-react';
import api from '@/services/api/client';
import ResultDialog from '@/components/ResultDialog';
import { PageHero, PageShell, LoadingState, LoadError } from '@/components/pulse-ui';
import {
  openEmployeeFile, downloadEmployeeFile, loadEmployeeImage, probeEmployeeFiles, isExternalUrl,
} from '@/features/employees/shared/employeeFiles';
import PhotoLightbox from '@/features/employees/shared/PhotoLightbox';
import {
  formatDuration, durationLabel, inclusiveDays, StatusBadge, StageBadge, stipendLabel, money, fmtDate, fullName,
} from '../internship';
import { useAuth } from '@/context/AuthContext';
import InternEvaluationPanel from './InternEvaluationPanel';
import InternCompletionPanel from './InternCompletionPanel';
import './Internships.css';

const TABS = ['Overview', 'Personal', 'Education', 'Internship', 'Documents', 'Attendance / Progress', 'Evaluation', 'Notes'];
const CLOSED = ['Completed', 'Cancelled', 'Terminated'];

// Module level, for the same reason as EmployeeProfile's: a component declared
// inside the page is a new type every render and remounts its subtree.
const InfoRow = ({ label, value }) => (
  <div className="iv-row">
    <span className="iv-row-label">{label}</span>
    <span className="iv-row-value">{value === 0 ? '0' : (value || '—')}</span>
  </div>
);
const Card = ({ title, children }) => (
  <div className="iv-card"><div className="iv-card-title">{title}</div>{children}</div>
);

const todayIso = () => new Date().toLocaleDateString('en-CA');

export default function ViewIntern({ setPage, urlParams }) {
  const id = urlParams?.id || null;
  const initialTab = TABS.includes(urlParams?.tab) ? urlParams.tab : 'Overview';
  const [intern, setIntern] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(initialTab);
  const [photoSrc, setPhotoSrc] = useState(null);
  const [photoOpen, setPhotoOpen] = useState(false);
  const [presence, setPresence] = useState(null);
  const [fileError, setFileError] = useState('');
  const [dialog, setDialog] = useState(null);
  const [completing, setCompleting] = useState(null);   // the completion form, or null
  const { hasPermission } = useAuth();

  const load = useCallback(async () => {
    if (!id) { setError('No intern selected. Open one from the internship register.'); return; }
    setError(null);
    try {
      const { data } = await api.get(`/interns/${encodeURIComponent(id)}`);
      setIntern(data);
    } catch (e) {
      setError(e?.response?.status === 404
        ? 'That intern does not exist, or is not in your company.'
        : (e?.response?.data?.error || e?.message || 'Could not load the intern.'));
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // Photo through the authenticated file route; released on change/unmount.
  useEffect(() => {
    let revoke = null; let cancelled = false;
    setPhotoSrc(null);
    if (intern?.photo_url) {
      loadEmployeeImage(intern.photo_url).then(url => {
        if (cancelled) { if (url && !isExternalUrl(intern.photo_url)) URL.revokeObjectURL(url); return; }
        if (url && !isExternalUrl(intern.photo_url)) revoke = url;
        setPhotoSrc(url);
      });
    }
    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [intern?.photo_url]);

  // Which stored documents actually have a file behind them.
  useEffect(() => {
    if (tab !== 'Documents' || !intern) return;
    setPresence(null);
    probeEmployeeFiles([intern.photo_url, ...(intern.documents || []).map(d => d.file_url)]).then(setPresence);
  }, [tab, intern]);

  const name = fullName(intern);
  const initials = `${(intern?.first_name || '?').charAt(0)}${(intern?.last_name || '').charAt(0)}`.toUpperCase();
  const Avatar = useMemo(() => {
    const Chip = () => (photoSrc
      ? <button type="button" onClick={() => setPhotoOpen(true)} title="View full-size photo"
          aria-label={`View ${name || 'intern'}'s photo full size`} className="iv-avatar-btn">
          <img src={photoSrc} alt={name || 'Intern photo'} />
        </button>
      : <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '.02em' }}>{initials}</span>);
    return Chip;
  }, [photoSrc, initials, name]);
  const closePhoto = useCallback(() => setPhotoOpen(false), []);

  if (error) {
    return (
      <PageShell dock={<PageHero icon={GraduationCap} eyebrow="Internships" title="Intern" />}>
        <div className="page-container"><LoadError message={error} onRetry={id ? load : undefined} /></div>
      </PageShell>
    );
  }
  if (!intern) {
    return (
      <PageShell dock={<PageHero icon={GraduationCap} eyebrow="Internships" title="Intern" subtitle="Loading…" />}>
        <div className="page-container"><LoadingState shape="lines" rows={8} /></div>
      </PageShell>
    );
  }

  const total = intern.duration_days || inclusiveDays(intern.start_date, intern.end_date) || 0;
  const today = todayIso();
  const elapsed = today < intern.start_date ? 0 : Math.min(total, inclusiveDays(intern.start_date, today) || 0);
  const pct = total ? Math.round((elapsed / total) * 100) : 0;
  const remaining = Math.max(0, total - elapsed);
  const overdue = !CLOSED.includes(intern.status) && intern.end_date < today;
  const docs = intern.documents || [];

  // POST /interns/:id/complete — the only way to complete. The server re-checks
  // eligibility (an HR-approved evaluation recommending completion).
  const submitCompletion = async () => {
    const c = completing;
    if (!c.completed_on) { setCompleting({ ...c, error: 'Enter the completion date.' }); return; }
    setCompleting({ ...c, saving: true, error: null });
    try {
      const { data } = await api.post(`/interns/${intern.id}/complete`, { completed_on: c.completed_on });
      setIntern(data);
      setCompleting(null);
      setDialog({ type: 'success', title: 'Internship Completed',
        message: `${data.intern_code} is now Completed. Issue the certificate from the Internship tab.`, autoClose: 2600 });
    } catch (e) {
      setCompleting({ ...c, saving: false, error: e?.response?.data?.error || e?.message || 'Could not complete the internship.' });
    }
  };
  const completion = intern.completion || { eligible: false, reason: null };
  const conversion = intern.conversion || { eligible: false, reason: null };
  // Convert to Employee creates an employee (employees:add) and changes this
  // record (internships:edit); the API checks both, plus eligibility.
  const canConvert = hasPermission('employees', 'add') && hasPermission('internships', 'edit');
  const openEmployee = (empId) => {
    try { sessionStorage.setItem('selectedEmployeeId', String(empId)); } catch { /* storage unavailable */ }
    setPage('EmployeeProfile', { id: empId });
  };

  return (
    <PageShell dock={
      <PageHero
        icon={Avatar}
        eyebrow="Internships"
        title={name || intern.intern_code}
        subtitle={[intern.intern_code, intern.designation, intern.department].filter(Boolean).join(' · ')}
        meta={[
          { label: 'status', value: intern.status, tone: intern.status === 'Active' ? 'good' : intern.status === 'Terminated' ? 'bad' : undefined },
          ...(intern.completion_stage && intern.completion_stage !== intern.status
            ? [{ label: 'stage', value: intern.completion_stage, tone: intern.completion_stage === 'Evaluation Pending' ? 'warn' : undefined }]
            : []),
          { label: 'duration', value: formatDuration(intern.start_date, intern.end_date) },
          ...(overdue && intern.completion_stage !== 'Evaluation Pending' ? [{ label: 'past end date', value: 'Awaiting completion', tone: 'warn' }] : []),
        ]}
        actions={<>
          {intern.status === 'Active' && (
            <button className="plh-cta plh-cta--ghost" disabled={!completion.eligible}
              title={completion.eligible ? 'Record the completion' : (completion.reason || 'Not yet eligible')}
              onClick={() => setCompleting({ completed_on: intern.end_date <= today ? intern.end_date : today })}>
              ✓ Mark Completed
            </button>
          )}
          {intern.status === 'Completed' && !intern.converted_employee_id && canConvert && (
            <button className="plh-cta plh-cta--ghost" disabled={!conversion.eligible}
              title={conversion.eligible ? 'Open Add Employee pre-filled from this intern' : (conversion.reason || 'Not eligible')}
              onClick={() => setPage('AddEmployee', { fromIntern: intern.id })}>
              Convert to Employee
            </button>
          )}
          <button className="plh-cta" onClick={() => setPage('EditIntern', { id: intern.id })}>✏️ Edit Intern</button>
        </>}
      />
    }>
      <ResultDialog dialog={dialog} onClose={() => setDialog(null)} />
      {photoOpen && photoSrc && (
        <PhotoLightbox src={photoSrc} name={name} code={intern.intern_code} onClose={closePhoto}
          onDownload={async () => { const err = await downloadEmployeeFile(intern.photo_url); if (err) setFileError(err); }} />
      )}

      {completing && (
        <div className="iv-modal-backdrop" role="dialog" aria-modal="true" aria-label="Mark internship completed">
          <div className="iv-modal">
            <h3>Mark internship completed</h3>
            <p className="iv-muted">{name} · {intern.intern_code} · ends {fmtDate(intern.end_date)}</p>
            <label htmlFor="iv-completed-on">Completed on<span className="req" aria-hidden="true">*</span></label>
            <input id="iv-completed-on" type="date" max={today} value={completing.completed_on}
              onChange={e => setCompleting({ ...completing, completed_on: e.target.value })} />
            <p className="iv-muted" style={{ margin: '6px 0 0' }}>
              Based on the HR-approved mentor evaluation. The certificate is issued separately, from the Internship tab.
            </p>
            {completing.error && <p role="alert" className="iv-error">{completing.error}</p>}
            <div className="iv-modal-actions">
              <button className="pulse-btn-secondary" onClick={() => setCompleting(null)} disabled={completing.saving}>Cancel</button>
              <button className="pulse-btn-primary" onClick={submitCompletion} disabled={completing.saving}>
                {completing.saving ? 'Saving…' : 'Mark Completed'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="iv-tabs" role="tablist">
        {TABS.map(t => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'is-active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      <div className="iv-content">
        {fileError && <p role="alert" className="iv-error">{fileError}</p>}
        {intern.converted_employee_id && (
          <div className="iv-convert" role="status">
            <strong>Converted to Employee:</strong>
            <button type="button" className="ai-link" onClick={() => openEmployee(intern.converted_employee_id)}>
              {intern.converted_employee_code || `Employee #${intern.converted_employee_id}`}
            </button>
            {intern.converted_employee_name && <span>· {intern.converted_employee_name}</span>}
            {intern.converted_at && <span className="iv-muted">· {fmtDate(intern.converted_at)}{intern.converted_by_name ? ` by ${intern.converted_by_name}` : ''}</span>}
            <span className="iv-muted">· This internship record is kept as history.</span>
          </div>
        )}

        {tab === 'Overview' && (
          <div className="iv-grid">
            <Card title="Internship">
              <InfoRow label="Intern ID" value={intern.intern_code} />
              <InfoRow label="Status" value={<StatusBadge status={intern.status} />} />
              <InfoRow label="Stage" value={<StageBadge stage={intern.completion_stage} />} />
              <InfoRow label="Department" value={intern.department} />
              <InfoRow label="Role" value={intern.designation} />
              <InfoRow label="Mentor" value={intern.mentor_name ? `${intern.mentor_name}${intern.mentor_office_id ? ` · ${intern.mentor_office_id}` : ''}` : null} />
            </Card>
            <Card title="Dates">
              <InfoRow label="Start Date" value={fmtDate(intern.start_date)} />
              <InfoRow label="End Date" value={fmtDate(intern.end_date)} />
              <InfoRow label="Duration" value={durationLabel(intern.start_date, intern.end_date)} />
              <InfoRow label="Stipend" value={stipendLabel(intern.stipend, intern.stipend_frequency)} />
            </Card>
            <Card title="Education">
              <InfoRow label="College / Institution" value={intern.college} />
              <InfoRow label="Course" value={[intern.course, intern.specialization].filter(Boolean).join(' — ')} />
              <InfoRow label="Documents on file" value={`${docs.length}`} />
            </Card>
          </div>
        )}

        {tab === 'Personal' && (
          <div className="iv-grid">
            <Card title="Basic Info">
              <InfoRow label="Full Name" value={name} />
              <InfoRow label="Date of Birth" value={fmtDate(intern.dob)} />
              <InfoRow label="Gender" value={intern.gender} />
            </Card>
            <Card title="Contact">
              <InfoRow label="Personal Email" value={intern.personal_email} />
              <InfoRow label="Phone" value={intern.phone} />
              <InfoRow label="Address" value={intern.address} />
            </Card>
            <Card title="Emergency">
              <InfoRow label="Emergency Contact" value={intern.emergency_name} />
              <InfoRow label="Emergency Phone" value={intern.emergency_phone} />
              <InfoRow label="Relationship" value={intern.emergency_relationship} />
            </Card>
          </div>
        )}

        {tab === 'Education' && (
          <div className="iv-grid">
            <Card title="Institution">
              <InfoRow label="College / Institution" value={intern.college} />
              <InfoRow label="Course / Degree" value={intern.course} />
              <InfoRow label="Specialization" value={intern.specialization} />
            </Card>
            <Card title="Progress">
              <InfoRow label="Current Year / Semester" value={intern.current_year} />
              <InfoRow label="Graduation Year" value={intern.graduation_year} />
            </Card>
          </div>
        )}

        {tab === 'Internship' && (
          <div className="iv-grid">
            <Card title="Placement">
              <InfoRow label="Department" value={intern.department} />
              <InfoRow label="Internship Role" value={intern.designation} />
              <InfoRow label="Mentor / Reporting Manager" value={intern.mentor_name ? `${intern.mentor_name}${intern.mentor_designation ? ` — ${intern.mentor_designation}` : ''}` : null} />
              <InfoRow label="Internship Type" value={intern.internship_type} />
              <InfoRow label="Project / Work Area" value={intern.project_work_area} />
            </Card>
            <Card title="Period & Status">
              <InfoRow label="Start / End" value={`${fmtDate(intern.start_date)} → ${fmtDate(intern.end_date)}`} />
              <InfoRow label="Duration" value={durationLabel(intern.start_date, intern.end_date)} />
              <InfoRow label="Status" value={<StatusBadge status={intern.status} />} />
              {intern.status_reason && <InfoRow label="Reason" value={intern.status_reason} />}
            </Card>
            <Card title="Compensation">
              <InfoRow label="Stipend" value={intern.stipend != null ? money(intern.stipend) : null} />
              <InfoRow label="Frequency" value={intern.stipend_frequency} />
              <InfoRow label="Other Benefits" value={intern.other_benefits} />
            </Card>
            <InternCompletionPanel intern={intern} onChanged={setIntern} />
          </div>
        )}

        {tab === 'Documents' && (
          <div className="iv-card">
            <div className="iv-card-title">Documents</div>
            {!intern.photo_url && docs.length === 0 && (
              <p className="iv-muted">No documents on file. Add them from Edit Intern → Documents.</p>
            )}
            <table className="iv-doc-table">
              <tbody>
                {[...(intern.photo_url ? [{ id: 'photo', doc_type: 'Photo', file_url: intern.photo_url, original_name: 'Photo' }] : []), ...docs].map(d => {
                  const missing = presence && presence[d.file_url] === false;
                  return (
                    <tr key={d.id}>
                      <td><strong>{d.doc_type === 'Institution Letter' ? 'College / Institution Letter' : d.doc_type}</strong></td>
                      <td className="iv-muted">{d.title || d.original_name}</td>
                      <td className="iv-muted">{d.uploaded_at ? fmtDate(d.uploaded_at) : ''}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {presence == null ? <span className="iv-muted">Checking…</span>
                          : missing ? <span style={{ color: '#b45309', fontWeight: 600 }}>Missing from storage</span>
                          : (<>
                              <button className="ai-link" onClick={async () => setFileError((await openEmployeeFile(d.file_url)) || '')}>View</button>
                              {' · '}
                              <button className="ai-link" onClick={async () => setFileError((await downloadEmployeeFile(d.file_url)) || '')}>Download</button>
                            </>)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'Attendance / Progress' && (
          <div className="iv-grid">
            <Card title="Internship progress">
              <div className="iv-progress" aria-label={`${pct}% of the internship elapsed`}>
                <div className="iv-progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <InfoRow label="Elapsed" value={`${elapsed} of ${total} days (${pct}%)`} />
              <InfoRow label="Remaining" value={CLOSED.includes(intern.status) ? 'Closed' : `${remaining} days`} />
              {overdue && <InfoRow label="Action needed" value="The end date has passed. Completion needs the mentor's evaluation — see the Evaluation tab." />}
            </Card>
            <Card title="Attendance">
              <p className="iv-muted" style={{ margin: '8px 0 0' }}>
                Interns are not on the employee attendance roster, so there are no punches to show here.
                Record attendance or mentor feedback in Notes.
              </p>
            </Card>
          </div>
        )}

        {tab === 'Evaluation' && <InternEvaluationPanel intern={intern} onChanged={load} />}

        {tab === 'Notes' && (
          <div className="iv-card">
            <div className="iv-card-title">Notes</div>
            {intern.notes
              ? <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: 14 }}>{intern.notes}</p>
              : <p className="iv-muted">No notes yet. Add them from Edit Intern → Notes.</p>}
          </div>
        )}
      </div>
    </PageShell>
  );
}
