// ──────────────────────────────────────────────────────────────────────────────
// One employee's Background Verification case.
//
// Reached from Employees → Background Verification → View BGV, and from the
// View Employee → Background Verification tab. `?employee_id=<id>`.
//
// ⚠ Keyed on the EMPLOYEE, not on a case id, because the page has to open for
// someone whose BGV has not been started — it then offers "Start BGV" instead of
// 404ing on a record that does not exist yet.
//
// ⚠ Status and Result are drawn as TWO badges, always. A Completed check with a
// Discrepancy result must never read as cleared; that is the whole reason the two
// are separate columns.
//
// ⚠ Every component here is declared at MODULE level. See the note at the top of
// BackgroundVerification.jsx.
// ──────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShieldCheck, ArrowLeft, Plus, RefreshCw, Upload, FileText, Folder,
  Phone, Lock, Unlock, Pencil, Trash2, AlertTriangle, X, ListChecks,
  SkipForward, RotateCcw,
} from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import MasterSelect from '@/components/core/MasterSelect';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { display } from '../displayValue';
import {
  CHECK_STATUSES, CHECK_RESULTS, PAYMENT_STATUSES, APPLICABILITY,
  CONTACT_TYPES, CONTACT_METHODS, CONTACT_RESPONSES,
  badgeFor, money, shortDate, requiredProgressLabel, requiredPct, blocksClosure,
} from '../bgv';
import './BackgroundVerification.css';

const HR_ADD_ROLES = ['super_admin', 'admin', 'hr', 'hr_manager', 'hr_exec'];

/** A field that mirrors master data rather than collecting it. */
const READONLY = { background: '#f9fafb', color: '#4b5563', cursor: 'default' };

const Badge = ({ value }) => {
  if (!value) return <span>—</span>;
  const { bg, color } = badgeFor(value);
  return <span className="bgv-badge" style={{ background: bg, color }}>{value}</span>;
};

const Field = ({ label, children, hint }) => (
  <div className="bgv-field">
    <label>{label}</label>
    {children}
    {hint && <span style={{ fontSize: 11, color: '#9ca3af' }}>{hint}</span>}
  </div>
);

const SummaryTile = ({ label, value, tone }) => (
  <div className="bgv-kpi" style={{ cursor: 'default' }}>
    <span className="bgv-kpi-val" style={tone === 'bad' ? { color: '#991b1b' } : undefined}>{value}</span>
    <span className="bgv-kpi-label">{label}</span>
  </div>
);

const CHECK_BLANK = {
  check_type: '', applicability: 'Required',
  agency_id: '', contact_person: '', contact_email: '', contact_phone: '',
  request_date: '', expected_date: '', completed_date: '',
  status: 'Pending', result: 'Pending', remarks: '',
  amount: '', tax_amount: '', invoice_number: '', payment_date: '',
  payment_status: 'Pending', cost_remarks: '',
  followup_on: '', followup_owner: '', followup_notes: '',
};

/**
 * Open a stored report.
 *
 * ⚠ Fetched as a blob through the api client, NOT linked with an <a href>. The
 * only route that serves a BGV report is `GET /api/files/:filename`, which
 * requires a Bearer token — a plain link sends no Authorization header and comes
 * back 401, which on screen looks like a broken document rather than a missing
 * header. `?disposition=inline` opts into the route's short inline allowlist
 * (PDF and raster images) so a report renders instead of downloading.
 */
async function openReport(filename, { download = false } = {}) {
  const res = await api.get(`/files/${encodeURIComponent(filename)}`, {
    params: download ? undefined : { disposition: 'inline' },
    responseType: 'blob',
  });
  const url = URL.createObjectURL(res.data);
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } else {
    window.open(url, '_blank', 'noopener');
  }
  // Revoked late: a freshly-opened tab still needs the blob. 60s is generous for
  // the browser to have read it and short enough not to leak the object.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** One file row inside a check's folder. */
const FileRow = ({ file, canDelete, onDelete, onError }) => {
  const missing = file.file_present === false;
  const open = async (download) => {
    try { await openReport(file.filename, { download }); }
    catch (err) {
      onError(err.response?.status === 404
        ? 'That file is no longer in storage.'
        : err.response?.status === 403
          ? 'You do not have permission to open this report.'
          : 'The report could not be opened.');
    }
  };
  return (
    <div className="bgv-file">
      <FileText size={14} style={{ color: missing ? '#9ca3af' : 'var(--color-primary, #6B3FDB)', flexShrink: 0 }} />
      <button type="button" className="bgv-file-name" disabled={missing} onClick={() => open(false)}>
        {display(file.document_name)}
      </button>
      <span className="bgv-file-meta">
        {display(file.document_type)} · uploaded {shortDate(file.uploaded_at)}
        {file.uploaded_by_name ? ` by ${file.uploaded_by_name}` : ''}
      </span>
      {/* "If the physical file is missing from storage, clearly show 'File not in
          storage'. Do not show a misleading 'On file' status." */}
      {missing && <span className="bgv-danger" style={{ fontSize: 12 }}>File not in storage</span>}
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        {!missing && (
          <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => open(true)}>Download</button>
        )}
        {canDelete && (
          <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => onDelete(file)} title="Remove from this check — the file is retained for audit">
            <Trash2 size={12} />
          </button>
        )}
      </span>
    </div>
  );
};

/** The add / edit form for one verification check. */
function CheckModal({ initial, agencies, caseId, onClose, onSaved, setPage }) {
  // ⚠⚠ A caller without `bgv_sensitive` receives the REDACTED placeholder in
  // remarks / followup_notes / cost_remarks. Those must never be editable and
  // must never be posted back: saving would overwrite the real finding with the
  // string "Restricted — visible to HR Manager / Admin only". Silent data loss,
  // caused by the redaction that was supposed to protect the data.
  const restricted = initial?.detail_restricted === true;

  const [form, setForm] = useState(() => {
    const base = { ...CHECK_BLANK, ...(initial || {}) };
    // Nulls from the API must become '' or a controlled input warns and then
    // posts the string "null" — the defect that stopped every employee being
    // saved from Add Employee. [[project_view_employee_review_2026-09-30]]
    for (const k of Object.keys(base)) if (base[k] == null) base[k] = '';
    return base;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  /**
   * Is this check carrying its OWN contact, or the agency's?
   *
   * Seeded from the record: the backend stores NULL in the three contact columns
   * when they match the agency master, so a stored value is by definition an
   * override. `contact_is_override` is computed server-side and shipped with the
   * check so the page does not have to re-derive it (and cannot derive it
   * differently).
   */
  const [overriding, setOverriding] = useState(
    () => initial?.contact_is_override === true
      || !!(initial?.contact_person || initial?.contact_email || initial?.contact_phone));

  const agency = agencies.find(a => String(a.id) === String(form.agency_id)) || null;

  /** Start from the agency's card rather than three empty boxes. */
  const startOverride = () => {
    setForm(f => ({
      ...f,
      contact_person: f.contact_person || agency?.contact_person || '',
      contact_email:  f.contact_email  || agency?.email          || '',
      contact_phone:  f.contact_phone  || agency?.phone          || '',
    }));
    setOverriding(true);
  };

  /**
   * Drop the override.
   *
   * ⚠ Clears the three fields to '' — which the save path turns into null, i.e.
   * "use the agency master". Leaving the typed values in place would send them
   * back and (but for the server's de-duplication) freeze a copy.
   */
  const clearOverride = () => {
    setForm(f => ({ ...f, contact_person: '', contact_email: '', contact_phone: '' }));
    setOverriding(false);
  };

  const completedWithoutResult = form.status === 'Completed' && form.result === 'Pending';

  const save = async () => {
    if (saving) return;
    if (!String(form.check_type).trim()) { setError('Choose a verification type.'); return; }
    if (completedWithoutResult) {
      setError('A completed check needs a result — Clear, Discrepancy or Unable to Verify. "Completed" does not mean "Clear".');
      return;
    }
    setSaving(true); setError('');
    // Blanks are sent as null, not ''. A DATE column rejects '' and a NUMERIC
    // column turns '' into 0 — which would make an uncaptured cost read as free.
    const SENSITIVE_TEXT = ['remarks', 'followup_notes', 'cost_remarks'];
    const payload = Object.fromEntries(
      Object.entries(form)
        .filter(([k]) => k in CHECK_BLANK)
        // An omitted key means "leave it alone" to the PATCH handler, which is
        // exactly right for a field this caller was not allowed to read.
        .filter(([k]) => !(restricted && SENSITIVE_TEXT.includes(k)))
        .map(([k, v]) => [k, v === '' ? null : v])
    );
    try {
      if (initial?.id) await api.patch(`/bgv/checks/${initial.id}`, payload);
      else await api.post(`/bgv/cases/${caseId}/checks`, payload);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save this check.');
    } finally { setSaving(false); }
  };

  return (
    <div className="bgv-modal-mask" onClick={onClose}>
      <div className="bgv-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="bgv-modal-title">{initial?.id ? 'Edit verification check' : 'New verification check'}</h3>
        <p className="bgv-note">
          <strong>Status</strong> is where the work is. <strong>Result</strong> is what it found.
          They are recorded separately — a completed check is not automatically a clear one.
        </p>
        {error && <p className="bgv-danger" style={{ fontSize: 13 }}>{error}</p>}

        <h4 className="bgv-card-title" style={{ marginTop: 6 }}>Verification</h4>
        <div className="bgv-filters" style={{ marginBottom: 6 }}>
          <div className="bgv-field">
            <label>Verification type *</label>
            {/* The BGV_CHECK_TYPE master, through the same MasterSelect every
                other picker in the app uses — so "+ Add new…" lands in the
                master rather than minting a value only this record carries. */}
            <MasterSelect
              endpoint="/master/v/bgv-check-types"
              label="BGV Check Type"
              value={form.check_type}
              onChange={(v) => setForm(f => ({ ...f, check_type: v }))}
              addRoles={HR_ADD_ROLES}
              placeholder="Select a verification type"
              searchable
              onNavigate={setPage}
              ariaLabel="Verification type"
            />
          </div>
          <Field label="Agency / vendor">
            <select value={form.agency_id || ''} onChange={set('agency_id')}>
              <option value="">Not assigned</option>
              {agencies.filter(a => a.is_active || String(a.id) === String(form.agency_id))
                .map(a => <option key={a.id} value={a.id}>{a.agency_name}{a.is_active ? '' : ' (inactive)'}</option>)}
            </select>
          </Field>
          <Field label="Applies to this employee"
                 hint={form.applicability === 'Not Applicable'
                   ? 'Kept on file as a decision — never counted as pending, never blocks closure'
                   : undefined}>
            <select value={form.applicability} onChange={set('applicability')}>
              {APPLICABILITY.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={form.status} onChange={set('status')}>
              {CHECK_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Result" hint={completedWithoutResult ? 'Required once the status is Completed' : undefined}>
            <select value={form.result} onChange={set('result')}
                    style={completedWithoutResult ? { borderColor: '#dc2626' } : undefined}>
              {CHECK_RESULTS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Request date"><input type="date" value={form.request_date} onChange={set('request_date')} /></Field>
          <Field label="Expected completion"><input type="date" value={form.expected_date} onChange={set('expected_date')} /></Field>
          <Field label="Completed date"><input type="date" value={form.completed_date} onChange={set('completed_date')} /></Field>
        </div>

        {/* ── Agency contact ───────────────────────────────────────────────────
            Read-only and filled from the agency master. HR picked the agency two
            fields above; asking them to retype its contact card is not merely
            tedious — a retyped contact is a second copy that goes stale the
            moment the agency changes hands, and then the record says who we used
            to call. "Use a different contact" is the escape for the one check
            that genuinely needs one, and it overrides for THAT check only. */}
        <h4 className="bgv-card-title" style={{ marginTop: 14 }}>
          Agency contact
          {!overriding && agency && (
            <span style={{ fontWeight: 500, color: '#6b7280', fontSize: 12, marginLeft: 8 }}>
              from {agency.agency_name}
            </span>
          )}
        </h4>

        {!agency && (
          <p className="bgv-note" style={{ marginTop: 0 }}>
            Select an agency above and its contact details appear here automatically.
          </p>
        )}

        {agency && !overriding && (
          <>
            <div className="bgv-filters" style={{ marginBottom: 6 }}>
              <Field label="Contact person">
                <input readOnly value={agency.contact_person || '—'} style={READONLY} />
              </Field>
              <Field label="Contact email">
                <input readOnly value={agency.email || '—'} style={READONLY} />
              </Field>
              <Field label="Contact phone">
                <input readOnly value={agency.phone || '—'} style={READONLY} />
              </Field>
            </div>
            <p className="bgv-note" style={{ marginTop: 2 }}>
              Kept in step with the agency master — update it once there and every check
              that uses this agency follows.{' '}
              <button type="button" className="bgv-file-name" onClick={startOverride}>
                Use a different contact for this check
              </button>
            </p>
          </>
        )}

        {agency && overriding && (
          <>
            <div className="bgv-filters" style={{ marginBottom: 6 }}>
              <Field label="Contact person"><input value={form.contact_person} onChange={set('contact_person')} /></Field>
              <Field label="Contact email"><input type="email" value={form.contact_email} onChange={set('contact_email')} /></Field>
              <Field label="Contact phone"><input value={form.contact_phone} onChange={set('contact_phone')} /></Field>
            </div>
            <p className="bgv-note" style={{ marginTop: 2 }}>
              This contact applies to <strong>this check only</strong>. The agency master is unchanged.{' '}
              <button type="button" className="bgv-file-name" onClick={clearOverride}>
                Go back to the agency contact
              </button>
            </p>
          </>
        )}

        <h4 className="bgv-card-title" style={{ marginTop: 14 }}>Cost</h4>
        <div className="bgv-filters" style={{ marginBottom: 6 }}>
          <Field label="Amount (₹)" hint="Leave blank if not billed yet — blank is not ₹0">
            <input type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} />
          </Field>
          <Field label="Tax (₹)">
            <input type="number" min="0" step="0.01" value={form.tax_amount} onChange={set('tax_amount')} />
          </Field>
          <Field label="Total" hint="Calculated — amount + tax">
            <input
              readOnly
              value={form.amount === '' && form.tax_amount === ''
                ? '—'
                : money(Number(form.amount || 0) + Number(form.tax_amount || 0))}
              style={{ background: '#f9fafb', color: '#6b7280' }}
            />
          </Field>
          <Field label="Invoice / reference no"><input value={form.invoice_number} onChange={set('invoice_number')} /></Field>
          <Field label="Payment status">
            <select value={form.payment_status} onChange={set('payment_status')}>
              {PAYMENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Payment date"><input type="date" value={form.payment_date} onChange={set('payment_date')} /></Field>
        </div>
        <Field label="Cost remarks">
          {restricted
            ? <input readOnly value="Restricted" style={READONLY} />
            : <textarea rows={2} value={form.cost_remarks} onChange={set('cost_remarks')} />}
        </Field>

        <h4 className="bgv-card-title" style={{ marginTop: 14 }}>Follow-up &amp; remarks</h4>
        <div className="bgv-filters" style={{ marginBottom: 6 }}>
          <Field label="Follow up on"><input type="date" value={form.followup_on} onChange={set('followup_on')} /></Field>
          <Field label="Follow-up owner"><input value={form.followup_owner} onChange={set('followup_owner')} /></Field>
        </div>
        <Field label="Follow-up notes">
          {restricted
            ? <input readOnly value="Restricted" style={READONLY} />
            : <textarea rows={2} value={form.followup_notes} onChange={set('followup_notes')} />}
        </Field>
        <div style={{ marginTop: 10 }}>
          <Field label="Remarks">
            {restricted
              ? <input readOnly value="Restricted" style={READONLY} />
              : <textarea rows={2} value={form.remarks} onChange={set('remarks')} />}
          </Field>
        </div>
        {restricted && (
          <p className="bgv-note" style={{ marginTop: 6, marginBottom: 0 }}>
            This check returned a discrepancy. Its findings are restricted to HR Manager /
            Admin roles — they are left unchanged when you save.
          </p>
        )}

        <div className="bgv-modal-actions">
          <button type="button" className="bgv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="bgv-btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Add check'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ── THE CHECKLIST ────────────────────────────────────────────────────────────
 * Pick a profile, tick the checks that apply, set each one's applicability, and
 * create them all in one action.
 *
 * This replaced creating verification checks one at a time, which is not how BGV
 * is run: you decide the SET of checks for a person once, from what kind of hire
 * they are, and then work through it. Ten clicks and ten modals to start a case
 * was the workflow defect, not a UX nicety.
 *
 * ⚠ The profiles come from GET /bgv/profiles, not from a constant in this file.
 * "What does a fresher need verified" is a business rule, and a copy here would
 * drift from the server's the first time either changed.
 *
 * ⚠ A row ticked as 'Not Applicable' IS created. That is the point: it records
 * that the check was considered and ruled out, so an auditor asking "did you
 * verify their employment?" gets "there was none to verify" rather than silence.
 * Unticked rows leave no trace at all.
 */
function ChecklistModal({ caseId, employeeId, employeeName, agencies, existingTypes, onClose, onSaved }) {
  const [profiles, setProfiles] = useState(null);
  const [profileKey, setProfileKey] = useState(null);
  const [rows, setRows] = useState([]);
  const [agencyId, setAgencyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api.get('/bgv/profiles')
      .then(r => {
        if (!alive) return;
        setProfiles(r.data);
        // Experienced is the common case, so it is the landing choice — but
        // nothing is created until Create is pressed.
        applyProfile(r.data, 'experienced');
      })
      .catch(err => { if (alive) setError(err.response?.data?.message || 'Could not load the verification profiles.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Load a profile's checklist into the form.
   *
   * ⚠ A type the case ALREADY has is shown, disabled and unticked, with a note —
   * rather than hidden. Hiding it makes the list look different from the profile
   * HR chose and invites them to wonder what happened to it; the server would
   * skip it anyway, so saying so up front is the honest version.
   */
  const applyProfile = (data, key) => {
    const profile = (data?.profiles || []).find(p => p.key === key);
    if (!profile) return;
    setProfileKey(key);
    setRows(profile.checks.map(c => {
      const already = existingTypes.has(String(c.check_type).trim().toLowerCase());
      return {
        check_type: c.check_type,
        applicability: c.applicability,
        selected: already ? false : c.selected,
        already,
        missing_from_master: c.missing_from_master,
      };
    }));
  };

  const setRow = (type, patch) =>
    setRows(rs => rs.map(r => (r.check_type === type ? { ...r, ...patch } : r)));

  const chosen = rows.filter(r => r.selected && !r.already);
  const requiredCount = chosen.filter(r => r.applicability === 'Required').length;
  const naCount = chosen.filter(r => r.applicability === 'Not Applicable').length;

  const save = async () => {
    if (saving) return;
    if (chosen.length === 0) { setError('Tick at least one verification check.'); return; }
    setSaving(true); setError('');
    const payload = {
      profile: profileKey,
      primary_agency_id: agencyId || null,
      checks: chosen.map(r => ({
        check_type: r.check_type,
        applicability: r.applicability,
        agency_id: agencyId || null,
      })),
    };
    try {
      // One endpoint whether or not the case exists yet: /start opens it if
      // needed (ON CONFLICT DO NOTHING) and then creates the checklist, so
      // "Start BGV" and "Add checks" are the same action with the same guards.
      const url = caseId
        ? `/bgv/cases/${caseId}/checks/bulk`
        : `/bgv/employees/${employeeId}/start`;
      const { data } = await api.post(url, caseId ? { checks: payload.checks } : payload);
      onSaved(data);
    } catch (err) {
      setError(err.response?.data?.message || 'The checklist could not be created.');
    } finally { setSaving(false); }
  };

  return (
    <div className="bgv-modal-mask" onClick={onClose}>
      <div className="bgv-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="bgv-modal-title">
          {caseId ? 'Add verification checks' : 'Start background verification'}
        </h3>
        <p className="bgv-note">
          {employeeName ? <>For <strong>{employeeName}</strong>. </> : null}
          Choose a profile, tick what applies, and create them all at once. Each check
          is then managed individually — agency, dates, cost, report and result.
        </p>
        {error && <p className="bgv-danger" style={{ fontSize: 13 }}>{error}</p>}
        {loading && <p className="bgv-note">Loading profiles…</p>}

        {!loading && profiles && (
          <>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {(profiles.profiles || []).map(p => (
                <button
                  key={p.key}
                  type="button"
                  className={profileKey === p.key ? 'bgv-btn-primary' : 'bgv-btn'}
                  onClick={() => applyProfile(profiles, p.key)}
                  title={p.description}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="bgv-note" style={{ marginTop: -6 }}>
              {(profiles.profiles || []).find(p => p.key === profileKey)?.description}
            </p>

            <div className="bgv-field" style={{ maxWidth: 320, marginBottom: 14 }}>
              <label>Agency for all of these (optional)</label>
              <select value={agencyId} onChange={(e) => setAgencyId(e.target.value)}>
                <option value="">Not assigned — set per check later</option>
                {agencies.filter(a => a.is_active).map(a => (
                  <option key={a.id} value={a.id}>{a.agency_name}</option>
                ))}
              </select>
            </div>

            <div className="bgv-table-wrap" style={{ maxHeight: 340 }}>
              <table className="bgv-table" style={{ minWidth: 520 }}>
                <thead>
                  <tr><th style={{ width: 40 }} /><th>Verification</th><th>Applies</th></tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.check_type} style={r.already ? { opacity: .55 } : undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={r.selected}
                          disabled={r.already}
                          aria-label={r.check_type}
                          onChange={(e) => setRow(r.check_type, { selected: e.target.checked })}
                        />
                      </td>
                      <td style={{ fontWeight: r.selected ? 700 : 500 }}>
                        {r.check_type}
                        {r.already && <span className="bgv-file-meta"> · already on this case</span>}
                        {r.missing_from_master && (
                          <span className="bgv-warn" style={{ fontSize: 11 }}> · not in your check-type master</span>
                        )}
                      </td>
                      <td>
                        <select
                          value={r.applicability}
                          disabled={!r.selected || r.already}
                          aria-label={`${r.check_type} applicability`}
                          onChange={(e) => setRow(r.check_type, { applicability: e.target.value })}
                          style={{ padding: '4px 8px', fontSize: 12, borderRadius: 6,
                                   border: '1px solid var(--color-border, #d1d5db)' }}
                        >
                          {(profiles.applicability || APPLICABILITY).map(a => (
                            <option key={a} value={a}>{a}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="bgv-note" style={{ marginTop: 10 }}>
              <strong>{chosen.length}</strong> check{chosen.length === 1 ? '' : 's'} will be created
              {requiredCount > 0 && <> — {requiredCount} required</>}
              {naCount > 0 && (
                <>, {naCount} recorded as <strong>Not Applicable</strong> (kept on file as a
                decision, never counted as pending work)</>
              )}.
            </p>
          </>
        )}

        <div className="bgv-modal-actions">
          <button type="button" className="bgv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="bgv-btn-primary" onClick={save}
                  disabled={saving || loading || chosen.length === 0}>
            {saving ? 'Creating…' : `Create ${chosen.length || ''} check${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

const CONTACT_BLANK = {
  contact_type: 'Previous Employer', contact_person: '', organization: '',
  phone: '', email: '', contacted_on: '', method: 'Phone', response: 'Pending', notes: '',
};

/**
 * The contact history for one check: a LOG, not a record to edit.
 *
 * There is no edit and no delete, by design — "this should create a history
 * rather than overwriting previous contact attempts". Ringing the same employer a
 * second time is a second row, so "we tried three times and got nothing" is still
 * readable a year later.
 */
function ContactModal({ check, onClose, onError }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(CONTACT_BLANK);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/bgv/checks/${check.id}/contacts`);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the contact history.');
    } finally { setLoading(false); }
  }, [check.id]);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      await api.post(`/bgv/checks/${check.id}/contacts`, Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v === '' ? null : v])
      ));
      setForm(CONTACT_BLANK);
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record the contact.');
      onError?.();
    } finally { setSaving(false); }
  };

  return (
    <div className="bgv-modal-mask" onClick={onClose}>
      <div className="bgv-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="bgv-modal-title">Contact history — {check.check_type}</h3>
        <p className="bgv-note">
          Who we contacted, when, and what came back. Entries are append-only: a repeat
          attempt is a new row, never an overwrite of the last one.
        </p>
        {error && <p className="bgv-danger" style={{ fontSize: 13 }}>{error}</p>}

        <div className="bgv-table-wrap" style={{ marginBottom: 16 }}>
          <table className="bgv-table" style={{ minWidth: 640 }}>
            <thead>
              <tr><th>Date</th><th>Type</th><th>Person</th><th>Organization</th>
                  <th>Method</th><th>Response</th><th>Notes</th><th>Logged by</th></tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{shortDate(r.contacted_on)}</td>
                  <td>{display(r.contact_type)}</td>
                  <td>{display(r.contact_person)}</td>
                  <td>{display(r.organization)}</td>
                  <td>{display(r.method)}</td>
                  <td><Badge value={r.response} /></td>
                  <td style={{ maxWidth: 220, whiteSpace: 'pre-wrap' }}>
                    {r.detail_restricted
                      ? <span className="bgv-file-meta"><Lock size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />Restricted</span>
                      : display(r.notes)}
                  </td>
                  <td>{display(r.logged_by_name)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={8} className="bgv-empty">Nobody has been contacted for this check yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <h4 className="bgv-card-title">Record a contact</h4>
        <div className="bgv-filters" style={{ marginBottom: 6 }}>
          <Field label="Contact type">
            <select value={form.contact_type} onChange={set('contact_type')}>
              {CONTACT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Contact person"><input value={form.contact_person} onChange={set('contact_person')} /></Field>
          <Field label="Organization"><input value={form.organization} onChange={set('organization')} /></Field>
          <Field label="Phone"><input value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={set('email')} /></Field>
          <Field label="Date contacted"><input type="date" value={form.contacted_on} onChange={set('contacted_on')} /></Field>
          <Field label="Method">
            <select value={form.method} onChange={set('method')}>
              {CONTACT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Response">
            <select value={form.response} onChange={set('response')}>
              {CONTACT_RESPONSES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Notes"><textarea rows={2} value={form.notes} onChange={set('notes')} /></Field>

        <div className="bgv-modal-actions">
          <button type="button" className="bgv-btn" onClick={onClose}>Close</button>
          <button type="button" className="bgv-btn-primary" onClick={add} disabled={saving}>
            {saving ? 'Recording…' : 'Record contact'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Upload a report against one check. */
function UploadModal({ check, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [docType, setDocType] = useState('Verification Report');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const send = async () => {
    if (saving) return;
    if (!file) { setError('Choose a file first.'); return; }
    setSaving(true); setError('');
    const fd = new FormData();
    fd.append('file', file);
    // ⚠ Only append a value that exists. `formData.append(k, null)` sends the
    // four-character STRING "null", which beats every truthiness guard on the
    // server. [[project_view_employee_review_2026-09-30]]
    if (name.trim()) fd.append('document_name', name.trim());
    if (docType.trim()) fd.append('document_type', docType.trim());
    if (notes.trim()) fd.append('notes', notes.trim());
    try {
      await api.post(`/bgv/checks/${check.id}/documents`, fd);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.message || 'The report could not be uploaded.');
    } finally { setSaving(false); }
  };

  return (
    <div className="bgv-modal-mask" onClick={onClose}>
      <div className="bgv-modal" style={{ width: 'min(540px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <h3 className="bgv-modal-title">Attach a report</h3>
        <p className="bgv-note">
          Filed against <strong>{check.check_type}</strong>. Stored through the
          authenticated document store — it is never reachable from a public URL.
        </p>
        {error && <p className="bgv-danger" style={{ fontSize: 13 }}>{error}</p>}
        <Field label="File">
          <input type="file" onChange={(e) => {
            const f = e.target.files?.[0] || null;
            setFile(f);
            if (f && !name) setName(f.name);
          }} />
        </Field>
        <div style={{ marginTop: 10 }}>
          <Field label="Document name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label="Document type" hint="e.g. Verification Report, Employer Response, Certificate">
            <input value={docType} onChange={(e) => setDocType(e.target.value)} />
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label="Notes"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <div className="bgv-modal-actions">
          <button type="button" className="bgv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="bgv-btn-primary" onClick={send} disabled={saving}>
            {saving ? 'Uploading…' : 'Upload report'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function EmployeeBGV({ setPage, urlParams, employee }) {
  const { hasPermission } = useAuth();
  const canAdd = hasPermission('bgv', 'add');
  const canEdit = hasPermission('bgv', 'edit');
  const canDelete = hasPermission('bgv', 'delete');
  // Gates the discrepancy detail AND reopening a closed case — both are
  // judgements about a settled or sensitive record, not ordinary editing.
  const canSeeSensitive = hasPermission('bgv_sensitive', 'view');

  // The id may come from the URL (a deep link, or the list's View BGV) or from
  // the employee the app already had selected.
  const employeeId = Number(urlParams?.employee_id) || employee?.id || null;

  const [data, setData] = useState(null);
  const [folders, setFolders] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [checkModal, setCheckModal] = useState(null);   // null | {} | row
  const [checklist, setChecklist] = useState(false);
  const [uploadFor, setUploadFor] = useState(null);
  const [contactFor, setContactFor] = useState(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    if (!employeeId) { setLoading(false); setError('No employee was selected.'); return; }
    setLoading(true); setError('');
    try {
      const { data: d } = await api.get(`/bgv/employees/${employeeId}`);
      if (!mounted.current) return;
      setData(d);
      const [ag, fold] = await Promise.all([
        api.get('/bgv/agencies'),
        d.case_id ? api.get(`/bgv/cases/${d.case_id}/documents`) : Promise.resolve({ data: { folders: [] } }),
      ]);
      if (!mounted.current) return;
      setAgencies(Array.isArray(ag.data) ? ag.data : []);
      setFolders(fold.data?.folders || []);
    } catch (err) {
      if (err.name === 'CanceledError') return;
      if (mounted.current) {
        setError(err.response?.status === 403
          ? 'You do not have permission to view background verification records.'
          : err.response?.data?.message || 'Could not load this BGV case.');
      }
    } finally { if (mounted.current) setLoading(false); }
  }, [employeeId]);

  useEffect(() => { mounted.current = true; load(); }, [load]);

  // NOTE: there is no longer a "just open an empty case" action. Starting BGV
  // means choosing the checks, so POST /bgv/employees/:id/start does both. The
  // bare POST .../case endpoint still exists for API callers.

  /**
   * Close the case.
   *
   * ⚠ There is no "close anyway". An open check BLOCKS closure, and the server
   * refuses it outright — this used to offer a confirm-anyway dialog, which put a
   * real gap in the record behind a button that read like a warning. A closed BGV
   * case is what HR, an auditor and a client rely on to mean "this person's
   * background was verified"; a case closed over a Pending employment check does
   * not mean that. The open checks are named so HR knows what to finish, and
   * cancelling one they have genuinely abandoned is the honest way through.
   */
  const closeCase = async () => {
    // ⚠⚠ `blocksClosure` — REQUIRED and unresolved. NOT `isOutstanding`, which
    // also counts Optional work, and NOT a status-only filter.
    //
    // Two earlier versions of this line were wrong in different ways:
    //   · a status-only filter ignored applicability, so for a fresher it named
    //     Employment Verification (Not Applicable) as a blocker and told HR to
    //     resolve a check that by definition cannot be resolved;
    //   · `isOutstanding` then blocked on Optional too, which made "optional"
    //     mean nothing.
    //
    // Both are the same mistake: restating a business rule next to the server's
    // instead of sharing it. `blocksClosure` lives in features/employees/bgv.js
    // and the server's guard is the same predicate in SQL.
    const openNow = (data.checks || []).filter(blocksClosure);
    if (openNow.length > 0) {
      // Answered on the client too, so HR is told what to do instead of clicking
      // a button that can only fail. The server is still the authority.
      setError(
        `${openNow.length} required verification check${openNow.length === 1 ? '' : 's'} ` +
        `${openNow.length === 1 ? 'is' : 'are'} still open: ` +
        `${openNow.map(o => `${o.check_type} (${o.status})`).join(', ')}. ` +
        'Complete or cancel each one before closing the case.');
      return;
    }
    const remarks = window.prompt('Closing remarks (optional):', '');
    if (remarks === null) return;
    try {
      await api.post(`/bgv/cases/${data.case_id}/close`, { closure_remarks: remarks || null });
      setNotice('BGV case closed.');
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not close the case.');
    }
  };

  /**
   * Reopen a closed case.
   *
   * ⚠ Needs `bgv_sensitive` AND a reason, both enforced on the server. The
   * reason is asked for here rather than sent blank and rejected, and it is
   * checked client-side too so HR is told what is needed instead of watching a
   * button fail. A closed BGV case is the record that says "this person's
   * background was verified and the file is settled" — unsettling it is not a
   * silent act.
   */
  const reopenCase = async () => {
    const reason = window.prompt(
      ['Why is this closed BGV case being reopened?', '',
       'This is recorded on the case and in the audit log.'].join('\n'));
    if (reason === null) return;
    if (!reason.trim() || reason.trim().length < 5) {
      setError('A reason of at least 5 characters is required to reopen a closed BGV case.');
      return;
    }
    try {
      await api.post(`/bgv/cases/${data.case_id}/reopen`, { reason: reason.trim() });
      setNotice('BGV case reopened. The reason is recorded on the case.');
      load();
    } catch (err) {
      setError(err.response?.data?.code === 'BGV_SENSITIVE_REQUIRED'
        ? 'Reopening a closed BGV case is restricted to HR Manager / Admin roles.'
        : err.response?.data?.message || 'Could not reopen the case.');
    }
  };

  /**
   * Skip an OPTIONAL check that is still open.
   *
   * ⚠ Only offered for Optional. A required check cannot be skipped — that would
   * bypass the closure guard, which is the whole point of "required". The server
   * refuses it too (409 CANNOT_SKIP_REQUIRED); HR must change its applicability
   * first, which is recorded as its own audited decision.
   */
  const skipCheck = async (row) => {
    const reason = window.prompt(
      [`Skip the ${row.check_type} check?`, '',
       'It is marked Cancelled with your reason, which is recorded on the check',
       'and in the audit log. Optional checks do not block closing the case.'].join('\n'));
    if (reason === null) return;
    if (!reason.trim() || reason.trim().length < 5) {
      setError('A reason of at least 5 characters is required to skip a check.');
      return;
    }
    try {
      await api.post(`/bgv/checks/${row.id}/skip`, { reason: reason.trim() });
      setNotice(`${row.check_type} skipped. The reason is recorded on the check.`);
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not skip the check.');
    }
  };

  /**
   * Re-run a verification that has already been resolved.
   *
   * Opens a NEW check linked to the one it supersedes. Nothing is overwritten —
   * the previous result, remarks, contact history and documents all stay where
   * they are, because a re-verification is a second attempt on the record rather
   * than a correction of the first.
   */
  const reverifyCheck = async (row) => {
    const reason = window.prompt(
      [`Re-verify ${row.check_type}?`, '',
       'This opens a NEW check of the same type and keeps the previous result,',
       'its remarks and its documents exactly as they are.'].join('\n'));
    if (reason === null) return;
    if (!reason.trim() || reason.trim().length < 5) {
      setError('A reason of at least 5 characters is required to re-verify a check.');
      return;
    }
    try {
      await api.post(`/bgv/checks/${row.id}/reverify`, { reason: reason.trim() });
      setNotice(`${row.check_type} re-verification opened. The previous result is kept on file.`);
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not start a re-verification.');
    }
  };

  const deleteCheck = async (row) => {
    if (!window.confirm(`Delete the ${row.check_type} check?`)) return;
    try {
      await api.delete(`/bgv/checks/${row.id}`);
      load();
    } catch (err) {
      if (err.response?.data?.code === 'HAS_EVIDENCE') {
        setError(err.response.data.message);
        return;
      }
      setError(err.response?.data?.message || 'Could not delete the check.');
    }
  };

  const deleteDocument = async (file) => {
    if (!window.confirm(
      // The wording matters: HR must not believe they are destroying evidence,
      // and must not believe the file is gone when it is not.
      `Remove "${file.document_name}" from this check?\n\n` +
      `It stops appearing here. The stored file and its record are RETAINED for ` +
      `audit — nothing is deleted from storage.`)) return;
    try {
      await api.delete(`/bgv/documents/${file.id}`);
      load();
    } catch (err) { setError(err.response?.data?.message || 'Could not remove the document.'); }
  };

  const closed = !!data?.closed_at;
  const writable = canEdit && !closed;

  const hero = (
    <PageHero
      icon={ShieldCheck}
      eyebrow="Background Verification"
      title={data ? `${display(data.employee_code)} — ${display(data.employee_name)}` : 'Background Verification'}
      subtitle={data
        ? `${display(data.designation)}${data.department ? ` · ${data.department}` : ''} · joined ${shortDate(data.joining_date)}`
        : 'Loading…'}
      meta={data ? [
        { label: 'BGV status', value: data.bgv_status },
        { label: 'checks', value: `${data.checks_completed}/${data.checks_total}` },
        { label: 'spent', value: money(data.total_cost) },
        ...(Number(data.checks_discrepancy) > 0
          ? [{ label: 'discrepancies', value: data.checks_discrepancy, tone: 'bad' }] : []),
      ] : []}
      actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="plh-cta" onClick={() => setPage?.('BackgroundVerification', { tab: 'employees' })}>
            <ArrowLeft size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />All BGV
          </button>
          <button type="button" className="plh-cta" onClick={load} disabled={loading}>
            <RefreshCw size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />Refresh
          </button>
        </div>
      }
    />
  );

  return (
    <PageShell dock={hero}>
      {error && (
        <div className="bgv-card" style={{ borderColor: '#fecaca', background: '#fef2f2', marginBottom: 16 }}>
          <span className="bgv-danger">{error}</span>
          <button type="button" className="bgv-btn bgv-btn-sm" style={{ marginLeft: 12 }} onClick={() => setError('')}>
            <X size={12} />
          </button>
        </div>
      )}
      {notice && (
        <div className="bgv-card" style={{ borderColor: '#bbf7d0', background: '#f0fdf4', marginBottom: 16 }}>
          <span style={{ color: '#166534', fontWeight: 600, fontSize: 13 }}>{notice}</span>
          <button type="button" className="bgv-btn bgv-btn-sm" style={{ marginLeft: 12 }} onClick={() => setNotice('')}>
            <X size={12} />
          </button>
        </div>
      )}

      {loading && !data && <div className="bgv-card"><span className="bgv-note">Loading…</span></div>}

      {data && !data.case_id && (
        <div className="bgv-card">
          <h3 className="bgv-card-title">No BGV case yet</h3>
          <p className="bgv-note">
            Background verification has not been started for {display(data.employee_name)}.
            Starting it opens one case for this employee — every check, report and cost is
            filed against it — and lets you pick the applicable checks in one go from a
            <strong> Fresher</strong>, <strong>Experienced</strong> or <strong>Custom</strong> profile.
          </p>
          {canAdd
            ? <button type="button" className="bgv-btn-primary" onClick={() => setChecklist(true)}>
                <ListChecks size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />Start BGV
              </button>
            : <p className="bgv-note" style={{ margin: 0 }}>Your role cannot start a BGV case.</p>}
        </div>
      )}

      {data?.case_id && (
        <>
          {/* ── Summary ─────────────────────────────────────────────────────── */}
          {/* ── Progress ──────────────────────────────────────────────────────
              ⚠ Replaces a "{completed}/{total} checks" line that counted EVERY
              check, Not Applicable ones included — so a fresher with all four
              required checks done read "4/5", and a case whose only check was
              Not Applicable read "0/1". The denominator is REQUIRED checks; the
              other states are reported beside it rather than folded in. */}
          <div className="bgv-kpis">
            <SummaryTile label="Required checks" value={data.required_total} />
            <SummaryTile label="Completed" value={data.required_completed} />
            <SummaryTile label="In Progress" value={data.required_in_progress} />
            <SummaryTile label="Pending" value={data.required_pending} />
            <SummaryTile label="Not Applicable" value={data.not_applicable} />
            <SummaryTile label="Discrepancies" value={data.checks_discrepancy}
                         tone={Number(data.checks_discrepancy) > 0 ? 'bad' : undefined} />
            <SummaryTile label="Total spent" value={money(data.total_cost)} />
            <SummaryTile label="BGV status" value={<Badge value={data.bgv_status} />} />
          </div>

          <div className="bgv-card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 15, color: '#111827' }}>{requiredProgressLabel(data)}</strong>
              {requiredPct(data) != null && (
                <span className="bgv-file-meta">{requiredPct(data)}% complete</span>
              )}
              {Number(data.optional_total) > 0 && (
                <span className="bgv-file-meta">
                  · {data.optional_total} optional
                </span>
              )}
              {Number(data.not_applicable) > 0 && (
                <span className="bgv-file-meta">
                  · {data.not_applicable} not applicable (not counted)
                </span>
              )}
            </div>
            {/* No bar at all when nothing is required — a bar pinned at 0%% would
                say "no progress" when the truth is "nothing to do". */}
            {requiredPct(data) != null && (
              <div className="bgv-bar-track" style={{ marginTop: 10, height: 8 }}>
                <div className="bgv-bar-fill" style={{ width: `${requiredPct(data)}%` }} />
              </div>
            )}
            {/* ⚠ Two different sentences, because they are two different facts.
                A required check BLOCKS closure; an optional one is outstanding
                work HR may skip. Saying "the case cannot be closed" about an
                optional check is the lie that made "optional" meaningless. */}
            {Number(data.open_required) > 0 && (
              <p className="bgv-note" style={{ marginTop: 10, marginBottom: 0 }}>
                <Lock size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
                {data.open_required} <strong>required</strong> check
                {Number(data.open_required) === 1 ? ' is' : 's are'} still open — the case
                cannot be closed until each is completed or cancelled.
              </p>
            )}
            {Number(data.open_optional) > 0 && (
              <p className="bgv-note" style={{ marginTop: 6, marginBottom: 0 }}>
                {data.open_optional} optional check{Number(data.open_optional) === 1 ? '' : 's'} still
                open. {Number(data.open_optional) === 1 ? 'It does' : 'They do'} not block closure —
                complete {Number(data.open_optional) === 1 ? 'it' : 'them'}, or use Skip to record
                why {Number(data.open_optional) === 1 ? 'it was' : 'they were'} not needed.
              </p>
            )}
          </div>

          <div className="bgv-card" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
              <div>
                <div className="bgv-kpi-label">Primary agency</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{display(data.primary_agency_name)}</div>
              </div>
              <div>
                <div className="bgv-kpi-label">Started</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>
                  {shortDate(data.initiated_on || data.first_request_date)}
                </div>
              </div>
              <div>
                <div className="bgv-kpi-label">Last check completed</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{shortDate(data.last_completed_date)}</div>
              </div>
              <div>
                <div className="bgv-kpi-label">Unpaid</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{money(data.unpaid_cost)}</div>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {canEdit && !closed && (
                  <button type="button" className="bgv-btn" onClick={() => closeCase(false)}>
                    <Lock size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />Close case
                  </button>
                )}
                {canEdit && closed && canSeeSensitive && (
                  <button type="button" className="bgv-btn" onClick={reopenCase}>
                    <Unlock size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />Reopen case
                  </button>
                )}
                {canEdit && closed && !canSeeSensitive && (
                  <span className="bgv-file-meta">
                    <Lock size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
                    Reopening is restricted to HR Manager / Admin
                  </span>
                )}
              </div>
            </div>
            {closed && (
              <p className="bgv-note" style={{ marginTop: 12, marginBottom: 0 }}>
                <Lock size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
                Closed on {shortDate(data.closed_at)}. Reopen the case to record anything further.
                {data.closure_remarks && <> Remarks: {data.closure_remarks}</>}
              </p>
            )}
            {/* Said out loud, because a page that quietly shows fewer files than
                the check's own count claims reads as a bug. */}
            {data.reopened_at && !closed && (
              <p className="bgv-note" style={{ marginTop: 12, marginBottom: 0 }}>
                <Unlock size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
                Reopened on {shortDate(data.reopened_at)}
                {data.reopen_reason ? <> — {data.reopen_reason}</> : null}
              </p>
            )}
            {Number(data.restricted_checks) > 0 && (
              <p className="bgv-note" style={{ marginTop: 10, marginBottom: 0 }}>
                <Lock size={12} style={{ marginRight: 5, verticalAlign: '-2px' }} />
                {data.restricted_checks} check{Number(data.restricted_checks) === 1 ? '' : 's'} returned a
                discrepancy. The status and result are shown; the findings, notes and reports are
                restricted to HR Manager / Admin roles.
              </p>
            )}
            {Number(data.reports_missing) > 0 && (
              <p className="bgv-note" style={{ marginTop: 10, marginBottom: 0 }}>
                <AlertTriangle size={12} className="bgv-warn" style={{ marginRight: 5, verticalAlign: '-2px' }} />
                <span className="bgv-warn">{data.reports_missing}</span> check(s) have no report attached.
              </p>
            )}
          </div>

          {/* ── Checks ──────────────────────────────────────────────────────── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
            <h3 className="bgv-card-title" style={{ margin: 0 }}>
              Verification checks — {requiredProgressLabel(data)}
            </h3>
            {canAdd && !closed && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {/* The checklist is the primary way to add work; the single form
                    stays for a one-off (including a deliberate re-check of a
                    type the case already has, which the checklist skips). */}
                <button type="button" className="bgv-btn-primary" onClick={() => setChecklist(true)}>
                  <ListChecks size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />Add checks from a profile
                </button>
                <button type="button" className="bgv-btn" onClick={() => setCheckModal({})}>
                  <Plus size={13} style={{ marginRight: 5, verticalAlign: '-2px' }} />Add one check
                </button>
              </div>
            )}
          </div>

          <div className="bgv-table-wrap" style={{ marginBottom: 24 }}>
            {/* `bgv-checks-table` so a selector can name THIS table: a bare
                `.bgv-table` also matches the contact-history modal's. */}
            <table className="bgv-table bgv-checks-table">
              <thead>
                <tr>
                  <th>Verification</th><th>Applies</th><th>Agency</th><th>Status</th><th>Result</th>
                  <th>Requested</th><th>Expected</th><th>Completed</th>
                  <th className="bgv-num">Cost</th><th>Payment</th>
                  <th className="bgv-num">Reports</th><th className="bgv-num">Contacts</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(data.checks || []).map(ch => {
                  // ⚠ A Not Applicable check is never overdue and never owes a
                  // report — it is a decision, not work in flight.
                  const applies = ch.applicability !== 'Not Applicable';
                  const overdue = applies && ch.status !== 'Completed' && ch.status !== 'Cancelled'
                    && ch.expected_date && new Date(`${ch.expected_date}T00:00:00`) < new Date();
                  return (
                    <tr key={ch.id}>
                      <td style={{ fontWeight: 700 }}>{display(ch.check_type)}</td>
                      <td><Badge value={ch.applicability} /></td>
                      <td>{display(ch.agency_name)}</td>
                      <td><Badge value={ch.status} /></td>
                      <td><Badge value={ch.result} /></td>
                      <td>{shortDate(ch.request_date)}</td>
                      <td className={overdue ? 'bgv-warn' : undefined}>
                        {shortDate(ch.expected_date)}{overdue ? ' · overdue' : ''}
                      </td>
                      <td>{shortDate(ch.completed_date)}</td>
                      <td className="bgv-num">{money(ch.total_amount)}</td>
                      <td><Badge value={ch.payment_status} /></td>
                      <td className="bgv-num">
                        {ch.detail_restricted
                          ? <Lock size={12} style={{ color: '#6b7280' }} title="Reports restricted to HR Manager / Admin" />
                          : ch.document_count}
                        {!ch.detail_restricted && applies && ch.status !== 'Cancelled' && Number(ch.document_count) === 0 && (
                          <span className="bgv-warn" title="No report attached"> ⚑</span>
                        )}
                      </td>
                      <td className="bgv-num">{ch.contact_count}</td>
                      <td>
                        <div className="bgv-row-actions">
                          {writable && (
                            <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => setCheckModal(ch)} title="Edit">
                              <Pencil size={12} />
                            </button>
                          )}
                          {canAdd && !closed && (
                            <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => setUploadFor(ch)} title="Attach report">
                              <Upload size={12} />
                            </button>
                          )}
                          {/* Skip: OPTIONAL and still open. Not offered for a
                              required check — the server refuses that, and a
                              button that can only 409 is worse than no button. */}
                          {writable && ch.applicability === 'Optional'
                            && !['Completed', 'Cancelled'].includes(ch.status) && (
                            <button type="button" className="bgv-btn bgv-btn-sm"
                                    onClick={() => skipCheck(ch)}
                                    // Named per ROW. These actions are icon-only,
                                    // so without this a screen reader reads six
                                    // identical buttons in a table and the
                                    // caller cannot tell which check each one
                                    // acts on.
                                    aria-label={`Skip ${ch.check_type}`}
                                    title="Skip this optional check, with a reason">
                              <SkipForward size={12} />
                            </button>
                          )}
                          {/* Re-verify: only once the previous attempt is
                              resolved. Two open checks of one type is what an
                              accidental duplicate looks like. */}
                          {canAdd && !closed
                            && ['Completed', 'Cancelled'].includes(ch.status) && (
                            <button type="button" className="bgv-btn bgv-btn-sm"
                                    onClick={() => reverifyCheck(ch)}
                                    aria-label={`Re-verify ${ch.check_type}`}
                                    title="Run this verification again, keeping the previous result">
                              <RotateCcw size={12} />
                            </button>
                          )}
                          <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => setContactFor(ch)} title="Contact history">
                            <Phone size={12} />
                          </button>
                          {canDelete && !closed && (
                            <button type="button" className="bgv-btn bgv-btn-sm" onClick={() => deleteCheck(ch)} title="Delete">
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {(data.checks || []).length === 0 && (
                  <tr><td colSpan={13} className="bgv-empty">
                    No verification checks yet. Add the first one — identity, address,
                    employment, education, and so on.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* ── Documents folder ────────────────────────────────────────────── */}
          <h3 className="bgv-card-title">BGV Documents</h3>
          <p className="bgv-note">
            One folder per verification check — the report is filed against the check that
            produced it, not mixed into the employee&rsquo;s general Documents tab. Clicking a
            file opens it through the authenticated document viewer.
          </p>
          {folders.length === 0 && (
            <div className="bgv-card"><span className="bgv-note">
              No checks yet, so there are no document folders.
            </span></div>
          )}
          {folders.map(f => (
            <div className="bgv-folder" key={f.check_id}>
              <div className="bgv-folder-head">
                <Folder size={15} style={{ color: 'var(--color-primary, #6B3FDB)' }} />
                {f.check_type}
                <Badge value={f.status} />
                <Badge value={f.result} />
                {f.agency_name && <span className="bgv-file-meta">{f.agency_name}</span>}
                <span style={{ marginLeft: 'auto' }} className="bgv-file-meta">
                  {f.restricted
                    ? `${f.restricted_file_count || 0} file${(f.restricted_file_count || 0) === 1 ? '' : 's'} · restricted`
                    : `${f.files.length} file${f.files.length === 1 ? '' : 's'}`}
                </span>
              </div>
              {/* ⚠ "Restricted" and "empty" must not look the same. "No report
                  attached yet" is a job to do; "you may not see this" is a
                  permission — drawing them alike would send an HR executive
                  chasing an agency that already delivered. */}
              {f.restricted
                ? <div className="bgv-folder-empty">
                    <Lock size={12} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                    {f.restricted_file_count
                      ? `${f.restricted_file_count} report${f.restricted_file_count === 1 ? '' : 's'} on file — restricted to HR Manager / Admin.`
                      : 'Reports for a discrepancy are restricted to HR Manager / Admin.'}
                  </div>
                : f.files.length === 0
                ? <div className="bgv-folder-empty">No report attached for this check yet.</div>
                : f.files.map(file => (
                    <FileRow key={file.id} file={file} canDelete={canDelete && !closed}
                             onDelete={deleteDocument} onError={setError} />
                  ))}
            </div>
          ))}
        </>
      )}

      {checklist && (
        <ChecklistModal
          caseId={data?.case_id ?? null}
          employeeId={employeeId}
          employeeName={data?.employee_name}
          agencies={agencies}
          // So the modal can show a type the case already has as disabled
          // rather than offering it and letting the server skip it silently.
          existingTypes={new Set((data?.checks || [])
            .map(c => String(c.check_type).trim().toLowerCase()))}
          onClose={() => setChecklist(false)}
          onSaved={(out) => {
            setChecklist(false);
            const made = out?.created?.length ?? 0;
            const skipped = out?.skipped?.length ?? 0;
            setNotice(
              `${made} check${made === 1 ? '' : 's'} created` +
              (skipped ? ` · ${skipped} already on this case and left alone` : ''));
            load();
          }}
        />
      )}
      {checkModal && (
        <CheckModal
          initial={checkModal.id ? checkModal : null}
          agencies={agencies}
          caseId={data?.case_id}
          setPage={setPage}
          onClose={() => setCheckModal(null)}
          onSaved={() => { setCheckModal(null); load(); }}
        />
      )}
      {uploadFor && (
        <UploadModal check={uploadFor} onClose={() => setUploadFor(null)}
                     onSaved={() => { setUploadFor(null); load(); }} />
      )}
      {contactFor && (
        <ContactModal check={contactFor} onClose={() => { setContactFor(null); load(); }} />
      )}
    </PageShell>
  );
}
