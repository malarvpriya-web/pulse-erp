import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, FileText, Plus, RefreshCw, Search, X, UserPlus, Pencil, Trash2, Briefcase, Ban, CheckCircle2, Clock, ArrowLeft, Users, Globe, Copy } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { requisitionPriority, REQUISITION_PRIORITIES } from '../shared/constants';
import api from '@/services/api/client';
import MasterSelect from '@/components/core/MasterSelect';
import JobTimeline from '../shared/components/JobTimeline';
import JobOpenings from './JobOpenings';
import useAppStore from '@/store/useAppStore';
import './JobRequisitionPipeline.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

const EMPTY_FORM = {
  job_title: '',
  department: '',
  priority: 'medium',
  employment_type: 'full_time',
  number_of_positions: 1,
  hiring_reason: 'new_position',
  replacing_employee_id: '',
  justification: '',
  job_description: '',
  skills_required: '',
  experience_min: '',
  experience_max: '',
  location: '',
  salary_min: '',
  salary_max: '',
};

// Must match job_requisitions statuses (REQUISITION_STATUSES in recruitment.schemas.js).
const STATUS_META = {
  draft:            { label: 'Draft',            bg: '#f3f4f6', color: '#4b5563' },
  pending_approval: { label: 'Pending Approval', bg: '#fef3c7', color: '#92400e' },
  approved:         { label: 'Approved',         bg: '#dcfce7', color: '#166534' },
  open:             { label: 'Job posted',       bg: '#ede9fe', color: '#6d28d9' },
  closed:           { label: 'Closed',           bg: '#fee2e2', color: '#991b1b' },
  cancelled:        { label: 'Cancelled',        bg: '#f3f4f6', color: '#991b1b' },
};
const STATUS_TABS = ['all', 'draft', 'pending_approval', 'approved', 'open', 'closed', 'cancelled'];

const EMP_TYPES = [
  ['full_time', 'Full Time'], ['contract', 'Contract'], ['intern', 'Intern'], ['part_time', 'Part Time'],
];
const empTypeLabel = (v) => EMP_TYPES.find(([k]) => k === v)?.[1] || '-';
const OPENING_STATUS = { open: 'Open', draft: 'Draft', on_hold: 'On hold', closed: 'Closed', cancelled: 'Cancelled' };

const asArray = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.requisitions)) return payload.requisitions;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const formatDate = (value) => {
  if (!value) return '-';
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};
const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
const has = (v) => v !== null && v !== undefined && v !== '';
const rangeText = (a, b, fmt = (x) => x) =>
  has(a) && has(b) ? `${fmt(a)} – ${fmt(b)}` : has(a) ? `from ${fmt(a)}` : has(b) ? `up to ${fmt(b)}` : '';
const reqNo = (r) => r.requisition_no || `REQ-${r.id}`;

/**
 * Requisitions — raise a hiring request, get it approved, then post the job.
 *
 * The job opening is part of the requisition (owner, 2026-11-17): the Job
 * Openings tab was removed, and "Post job opening" / "Edit job" open the job
 * form here, in place of the requisition (JobOpenings panelOnly). Candidates
 * apply on the company website, which lists the open jobs through the public
 * careers API (see the Careers Website tab).
 *
 * `embedded`: rendered as a tab of the Jobs hub, which owns the page shell and
 * header. A second PageShell inside a tab duplicated the header ("Recruitment /
 * Requisition Pipeline" under "Jobs") and a nested shell steals clicks.
 */
export default function JobRequisitionPipeline({ setPage, embedded = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [activeRow, setActiveRow] = useState(null);
  const [createForm, setCreateForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [employees, setEmployees] = useState([]);
  const [decisionComment, setDecisionComment] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [timelineKey, setTimelineKey] = useState(0);
  const [access, setAccess] = useState(null);
  const [notice, setNotice] = useState('');
  // The job form for the open requisition: { requisitionId } to post it,
  // { openingId } to edit it. Drawn in place of the requisition.
  const [jobPanel, setJobPanel] = useState(null);
  const [websiteUrl, setWebsiteUrl] = useState('');
  const setSelectedJobId = useAppStore(st => st.setSelectedJobId);
  const [sp, setSp] = useSearchParams();
  // The view and the forms open in place of the list, inside the tab — not
  // over the page. Bring the top of the page into view when one opens.
  const panelOpen = showCreate || !!activeRow || !!jobPanel;
  useEffect(() => {
    if (!panelOpen) return;
    try {
      document.querySelector('.page-content')?.scrollTo?.({ top: 0 });
      window.scrollTo?.({ top: 0 });
    } catch { /* jsdom */ }
  }, [panelOpen, activeRow?.id, jobPanel]);

  // Old links (?tab=openings&opening=<id> or &requisition=<id>) open the job
  // form directly; Back then returns to the list.
  useEffect(() => {
    const opening = sp.get('opening');
    const requisition = sp.get('requisition');
    if (!opening && !requisition) return;
    setJobPanel(opening ? { openingId: opening } : { requisitionId: requisition });
    setSp(prev => { const n = new URLSearchParams(prev); n.delete('opening'); n.delete('requisition'); return n; }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The company's careers page address, for "Copy careers page link".
  useEffect(() => {
    api.get('/recruitment/careers-portal')
      .then(r => setWebsiteUrl(r.data?.website_url || ''))
      .catch(() => setWebsiteUrl(''));
  }, []);

  const closeJobPanel = (msg) => {
    setJobPanel(null);
    if (msg) setNotice(msg);
    setTimelineKey(k => k + 1);
    loadData();
  };

  const copyWebsite = async () => {
    try { await navigator.clipboard.writeText(websiteUrl); setNotice('Careers page link copied'); }
    catch { setError('Could not copy. Open the Careers Website tab and copy it from there.'); }
  };

  const viewApplicants = (openingId) => {
    setSelectedJobId?.(openingId);
    setPage?.('Candidates', { tab: 'pipeline' });
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      // All statuses are fetched and filtered here, so every tab's count stays
      // right whichever tab is open.
      const res = await api.get('/recruitment/requisitions');
      const list = asArray(res.data);
      setRows(list);
      setActiveRow(prev => (prev ? list.find(r => r.id === prev.id) || null : prev));
    } catch (e) {
      setRows([]);
      setLoadError(e?.response?.data?.error || 'Could not load requisitions. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Employees, for "replacing whom". Same list the interview scheduler uses.
  useEffect(() => {
    // Who may raise (HR: any department; a department head: their own) and
    // who may approve (Super Admin) — the API enforces the same rules.
    api.get('/recruitment/requisitions/access')
      .then(r => setAccess({ can_raise: false, any_department: false, departments: [], can_approve: false, ...(r.data || {}) }))
      .catch(() => setAccess({ can_raise: false, any_department: false, departments: [], can_approve: false }));
    api.get('/recruitment/meta/candidate-workbench')
      .then(r => setEmployees(Array.isArray(r.data?.employees) ? r.data.employees : []))
      .catch(() => setEmployees([]));
  }, []);

  const counts = useMemo(() => {
    const map = Object.fromEntries(STATUS_TABS.map(k => [k, 0]));
    map.all = rows.length;
    rows.forEach((r) => {
      const key = String(r.status || '').toLowerCase();
      if (map[key] != null) map[key] += 1;
    });
    return map;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const byStatus = statusFilter === 'all' || String(r.status || '').toLowerCase() === statusFilter;
      if (!byStatus) return false;
      if (!q) return true;
      return [r.job_title, r.department, reqNo(r), r.requested_by_name, r.location]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [rows, search, statusFilter]);

  // Positions count only what is still live: drafts, waiting, approved and
  // posted. Closed and cancelled requests are not headcount anyone is hiring.
  const summary = useMemo(() => {
    const live = rows.filter(r => ['draft', 'pending_approval', 'approved', 'open'].includes(r.status));
    return {
      pending: counts.pending_approval,
      toPost: counts.approved,
      posted: counts.open,
      positions: live.reduce((acc, r) => acc + Number(r.number_of_positions || 0), 0),
    };
  }, [rows, counts]);

  const setField = (key, value) => setCreateForm((prev) => ({ ...prev, [key]: value }));

  const openNew = () => {
    setEditingId(null);
    setCreateForm(EMPTY_FORM);
    setFormError('');
    setShowCreate(true);
  };

  const formProblem = () => {
    const f = createForm;
    if (!f.job_title.trim()) return 'Enter the job title.';
    if (!String(f.department).trim()) return 'Choose the department.';
    if (!(Number(f.number_of_positions) >= 1)) return 'Enter how many positions are needed.';
    if (f.hiring_reason === 'replacement' && !f.replacing_employee_id) return 'Choose the employee this hire replaces.';
    if (has(f.experience_min) && has(f.experience_max) && Number(f.experience_min) > Number(f.experience_max)) return 'Minimum experience is more than the maximum.';
    if (has(f.salary_min) && has(f.salary_max) && Number(f.salary_min) > Number(f.salary_max)) return 'Minimum salary is more than the maximum.';
    return '';
  };

  const submitCreate = async (thenSubmit = false) => {
    const problem = formProblem();
    if (problem) { setFormError(problem); return; }
    if (thenSubmit && !createForm.justification.trim()) { setFormError('Add a justification before submitting for approval.'); return; }
    setSubmitting(true);
    setFormError('');
    const payload = {
      ...createForm,
      number_of_positions: Number(createForm.number_of_positions),
      replacing_employee_id: createForm.hiring_reason === 'replacement' ? createForm.replacing_employee_id : '',
    };
    try {
      const res = editingId
        ? await api.put(`/recruitment/requisitions/${editingId}`, payload)
        : await api.post('/recruitment/requisitions', payload);
      const id = editingId || res?.data?.id;
      if (thenSubmit && id) await api.put(`/recruitment/requisitions/${id}`, { status: 'pending_approval' });
      setShowCreate(false);
      setEditingId(null);
      setCreateForm(EMPTY_FORM);
      await loadData();
    } catch (e) {
      setFormError(e?.response?.data?.error || 'Could not save the requisition.');
      // A failed submit after a successful create still created a draft.
      if (!editingId) loadData();
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (row) => {
    const v = (x) => (x == null ? '' : String(x));
    setEditingId(row.id);
    setCreateForm({
      job_title: row.job_title || '', department: row.department || '', priority: row.priority || 'medium',
      employment_type: row.employment_type || 'full_time', number_of_positions: row.number_of_positions || 1,
      hiring_reason: row.hiring_reason || 'new_position', replacing_employee_id: v(row.replacing_employee_id),
      justification: row.justification || '',
      job_description: row.job_description || '', skills_required: row.skills_required || '',
      experience_min: v(row.experience_min), experience_max: v(row.experience_max), location: row.location || '',
      salary_min: v(row.salary_min), salary_max: v(row.salary_max),
    });
    setFormError('');
    setActiveRow(null);
    setShowCreate(true);
  };

  const removeRequisition = async (row) => {
    if (!window.confirm(`Delete ${reqNo(row)}? This cannot be undone.`)) return;
    setError('');
    try {
      await api.delete(`/recruitment/requisitions/${row.id}`);
      setActiveRow(null);
      loadData();
    } catch (e) { setError(e?.response?.data?.error || 'Could not delete the requisition.'); }
  };

  const openDetail = (row) => {
    setActiveRow(row);
    setDecisionComment('');
    setError('');
    setNotice('');
  };

  const act = async (fn) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
      await loadData();
      setTimelineKey(k => k + 1);
    } catch (e) {
      setError(e?.response?.data?.error || 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const moveStatus = (nextStatus) => act(async () => {
    // pending_approval -> approved is decided in the Approval Center flow
    // (approver role, self-approval blocked, history recorded), never by a
    // plain status edit — the requisition PUT rejects 'approved'.
    if (nextStatus === 'approved') {
      await api.post(`/approvals/requisition:${activeRow.id}/approve`, { comment: decisionComment || undefined });
      return;
    }
    await api.put(`/recruitment/requisitions/${activeRow.id}`, { status: nextStatus });
  });

  const sendBack = () => {
    if (!decisionComment.trim()) { setError('Say what needs to change before sending it back.'); return; }
    act(() => api.post(`/approvals/requisition:${activeRow.id}/reject`, { comment: decisionComment }));
  };

  const current = String(activeRow?.status || '').toLowerCase();
  const lower = (s) => String(s || '').trim().toLowerCase();
  const canManage = !!access && (access.any_department
    || (activeRow && access.departments.some(d => lower(d) === lower(activeRow.department))));
  // Super Admin approves, including a requisition they raised themselves (owner, 2026-11-17).
  const canDecide = !!access?.can_approve;
  // Close / reopen / cancel / restore: also Super Admin (status moves only).
  const canMove = canManage || !!access?.can_approve;

  const toolbar = (
    <>
      <button className={embedded ? 'jrp-btn-outline' : 'plh-cta plh-cta--ghost'} onClick={loadData} title="Refresh"><RefreshCw size={14} /> Refresh</button>
      {access?.can_raise && (
        <button className={embedded ? 'jrp-btn-primary' : 'plh-cta'} onClick={openNew}><Plus size={14} /> New Requisition</button>
      )}
    </>
  );

  const body = (
    <>
      {!panelOpen && (<>
      {embedded && <div className="jrp-toolbar">{toolbar}</div>}

      <div className="jrp-summary">
        <SumCard icon={Clock} bg="#fef3c7" fg="#92400e" n={summary.pending} label="Waiting for approval" onClick={() => setStatusFilter('pending_approval')} />
        <SumCard icon={CheckCircle2} bg="#dcfce7" fg="#166534" n={summary.toPost} label="Approved, job not posted" onClick={() => setStatusFilter('approved')} />
        <SumCard icon={Briefcase} bg="#ede9fe" fg="#6d28d9" n={summary.posted} label="Job posted" onClick={() => setStatusFilter('open')} />
        <SumCard icon={FileText} bg="#e0f2fe" fg="#0369a1" n={summary.positions} label="Positions requested (live)" />
      </div>

      <div className="jrp-filters">
        <div className="jrp-search">
          <Search size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search requisition, title, department, requester" />
          {!!search && <button onClick={() => setSearch('')} aria-label="Clear search"><X size={12} /></button>}
        </div>
        <div className="jrp-tabs">
          {STATUS_TABS.map((key) => (
            <button key={key} className={`jrp-tab ${statusFilter === key ? 'jrp-tab-active' : ''}`} onClick={() => setStatusFilter(key)}>
              {key === 'all' ? 'All' : STATUS_META[key].label} <span className="jrp-tab-count">{counts[key] || 0}</span>
            </button>
          ))}
        </div>
      </div>
      {!!error && !activeRow && <div className="jrp-error">{error}</div>}
      {!!notice && !activeRow && <div className="jrp-notice">{notice}</div>}
      {!!loadError && <div className="jrp-error">{loadError} <button className="jrp-btn-outline" onClick={loadData}>Retry</button></div>}

      {loading ? (
        <div className="jrp-loading"><div className="jrp-spinner" /></div>
      ) : (
        <div className="jrp-table-wrap">
          <table className="jrp-table">
            <thead>
              <tr>
                <th>Req No</th>
                <th>Job Title</th>
                <th>Department</th>
                <th className="jrp-center">Positions</th>
                <th className="jrp-center">Priority</th>
                <th>Requested by</th>
                <th className="jrp-center">Stage</th>
                <th>Job opening</th>
                <th className="jrp-center">Created</th>
                <th className="jrp-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr className="jrp-row"><td colSpan={10} className="jrp-center">
                  {rows.length === 0 && !loadError ? (access?.can_raise ? 'No requisitions yet. Raise one with “New Requisition”.' : 'No requisitions yet. HR or a department head raises them.') : 'No requisitions match.'}
                </td></tr>
              ) : filteredRows.map((row) => {
                const statusKey = String(row.status || 'draft').toLowerCase();
                const statusMeta = STATUS_META[statusKey] || STATUS_META.draft;
                const pr = requisitionPriority(row.priority);
                const sentBack = statusKey === 'draft' && row.last_decision === 'Rejected';
                return (
                  <tr className="jrp-row" key={row.id} onClick={() => openDetail(row)} style={{ cursor: 'pointer' }}>
                    <td className="jrp-no">{reqNo(row)}</td>
                    <td className="jrp-title-cell">{row.job_title || '-'}</td>
                    <td><span className="jrp-dept">{row.department || '-'}</span></td>
                    <td className="jrp-center">{row.number_of_positions || 0}</td>
                    <td className="jrp-center jrp-priority">
                      <span style={{ background: pr.bg, color: pr.color, padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600 }}>{pr.label}</span>
                    </td>
                    <td>{row.requested_by_name || '-'}</td>
                    <td className="jrp-center">
                      <span className="jrp-stage-badge" style={{ background: statusMeta.bg, color: statusMeta.color }}>{statusMeta.label}</span>
                      {sentBack && <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>Sent back</div>}
                    </td>
                    <td>{row.opening_id
                      ? <span>{OPENING_STATUS[row.opening_status] || row.opening_status} · {row.positions_filled || 0}/{row.number_of_positions || 0} filled</span>
                      : '-'}</td>
                    <td className="jrp-center">{formatDate(row.created_at)}</td>
                    <td className="jrp-center"><button className="jrp-view-btn" aria-label={`Open ${reqNo(row)}`} onClick={(e) => { e.stopPropagation(); openDetail(row); }}><Eye size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      </>)}

      {showCreate && (
          <div className="jrp-panel" role="region" aria-label={editingId ? 'Edit requisition' : 'New requisition'}>
            <div className="jrp-panel-hd">
              <button className="jrp-back" onClick={() => setShowCreate(false)}><ArrowLeft size={14} /> Requisitions</button>
              <h3>{editingId ? 'Edit requisition' : 'New requisition'}</h3>
            </div>
            <div className="jrp-panel-body">
              {!!formError && <div className="jrp-error">{formError}</div>}
              <div className="jrp-form-grid">
                <div className="jrp-field"><label>Job Title *</label><input value={createForm.job_title} onChange={(e) => setField('job_title', e.target.value)} maxLength={200} /></div>
                <div className="jrp-field"><label>Department *</label>
                  {access && !access.any_department ? (
                    // A department head raises for the department(s) they head only.
                    <select value={createForm.department} onChange={(e) => setField('department', e.target.value)}>
                      <option value="">Select department…</option>
                      {access.departments.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  ) : (
                    <MasterSelect endpoint="/master/departments" label="Department" value={createForm.department}
                      onChange={v => setField('department', v)} placeholder="Select department…" />
                  )}
                </div>
                <div className="jrp-field"><label>Employment Type</label>
                  <select value={createForm.employment_type} onChange={(e) => setField('employment_type', e.target.value)}>
                    {EMP_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </select>
                </div>
                <div className="jrp-field"><label>Priority</label>
                  <select value={createForm.priority} onChange={(e) => setField('priority', e.target.value)}>
                    {REQUISITION_PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <div className="jrp-field"><label>Positions *</label><input type="number" min="1" max="9999" value={createForm.number_of_positions} onChange={(e) => setField('number_of_positions', e.target.value)} /></div>
                <div className="jrp-field"><label>Location</label><input value={createForm.location} onChange={(e) => setField('location', e.target.value)} maxLength={200} /></div>
                <div className="jrp-field"><label>Reason for hiring *</label>
                  <select value={createForm.hiring_reason} onChange={(e) => setField('hiring_reason', e.target.value)}>
                    <option value="new_position">New position (added headcount)</option>
                    <option value="replacement">Replacement</option>
                  </select>
                </div>
                <div className="jrp-field"><label>Replacing {createForm.hiring_reason === 'replacement' ? '*' : ''}</label>
                  <select value={createForm.replacing_employee_id} disabled={createForm.hiring_reason !== 'replacement'}
                    onChange={(e) => setField('replacing_employee_id', e.target.value)}>
                    <option value="">{createForm.hiring_reason === 'replacement' ? 'Choose the employee…' : 'Not a replacement'}</option>
                    {employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.designation ? ` — ${e.designation}` : ''}</option>)}
                  </select>
                </div>
                <div className="jrp-field"><label>Experience from (years)</label><input type="number" min="0" max="60" value={createForm.experience_min} onChange={(e) => setField('experience_min', e.target.value)} /></div>
                <div className="jrp-field"><label>Experience to (years)</label><input type="number" min="0" max="60" value={createForm.experience_max} onChange={(e) => setField('experience_max', e.target.value)} /></div>
                <div className="jrp-field"><label>Budget from (₹ per year)</label><input type="number" min="0" step="1000" value={createForm.salary_min} onChange={(e) => setField('salary_min', e.target.value)} /></div>
                <div className="jrp-field"><label>Budget up to (₹ per year)</label><input type="number" min="0" step="1000" value={createForm.salary_max} onChange={(e) => setField('salary_max', e.target.value)} /></div>
                <div className="jrp-field jrp-field-full"><label>Justification (needed to submit)</label>
                  <textarea rows={3} value={createForm.justification} maxLength={2000} onChange={(e) => setField('justification', e.target.value)}
                    placeholder="Why this hire is needed now — workload, project, attrition…" />
                </div>
                <div className="jrp-field jrp-field-full"><label>Skills Required</label><input value={createForm.skills_required} onChange={(e) => setField('skills_required', e.target.value)} placeholder="Comma-separated, e.g. PLC, SCADA, AutoCAD" /></div>
                <div className="jrp-field jrp-field-full"><label>Description</label><textarea rows={4} value={createForm.job_description} onChange={(e) => setField('job_description', e.target.value)} /></div>
              </div>
            </div>
            <div className="jrp-panel-ft">
              <button className="jrp-btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="jrp-btn-outline" onClick={() => submitCreate(false)} disabled={submitting}>{submitting ? 'Saving…' : editingId ? 'Save changes' : 'Save as draft'}</button>
              <button className="jrp-btn-primary" onClick={() => submitCreate(true)} disabled={submitting}>{submitting ? 'Saving…' : 'Save & submit for approval'}</button>
            </div>
          </div>
      )}

      {jobPanel && (
        <JobOpenings
          key={jobPanel.openingId ? `o${jobPanel.openingId}` : `r${jobPanel.requisitionId}`}
          setPage={setPage}
          embedded
          panelOnly
          requisitionId={jobPanel.requisitionId || null}
          openingId={jobPanel.openingId || null}
          onClose={closeJobPanel}
          onChanged={() => { loadData(); setTimelineKey(k => k + 1); }}
        />
      )}

      {activeRow && !jobPanel && (
          <div className="jrp-panel" role="region" aria-label={reqNo(activeRow)}>
            <div className="jrp-panel-hd">
              <button className="jrp-back" onClick={() => setActiveRow(null)}><ArrowLeft size={14} /> Requisitions</button>
              <h3>{reqNo(activeRow)} · {activeRow.job_title}</h3>
              <span className="jrp-stage-badge" style={{ background: (STATUS_META[current] || STATUS_META.draft).bg, color: (STATUS_META[current] || STATUS_META.draft).color }}>
                {(STATUS_META[current] || STATUS_META.draft).label}
              </span>
            </div>
            <div className="jrp-panel-body jrp-split">
              <div className="jrp-split-main">
              {!!error && <div className="jrp-error">{error}</div>}
              {!!notice && <div className="jrp-notice">{notice}</div>}
              {activeRow.opening_id && activeRow.opening_status === 'open' && (
                <div className="jrp-live">
                  <Globe size={14} />
                  <span>This job is live on the careers website. Candidates who apply there appear under it automatically.</span>
                  {websiteUrl && <button className="jrp-btn-outline" onClick={copyWebsite}><Copy size={12} /> Copy careers page link</button>}
                </div>
              )}
              {activeRow.last_decision && (
                <div className="jrp-decision" style={{
                  background: activeRow.last_decision === 'Rejected' ? '#fffbeb' : '#f0fdf4',
                  border: `1px solid ${activeRow.last_decision === 'Rejected' ? '#fcd34d' : '#bbf7d0'}`,
                  borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13,
                }}>
                  <strong>{activeRow.last_decision === 'Rejected' ? 'Sent back' : 'Approved'}</strong>
                  {activeRow.last_decision_by ? ` by ${activeRow.last_decision_by}` : ''}
                  {activeRow.last_decision_at ? ` on ${formatDate(activeRow.last_decision_at)}` : ''}
                  {activeRow.last_decision_comment ? <div style={{ marginTop: 4 }}>“{activeRow.last_decision_comment}”</div> : null}
                </div>
              )}
              <div className="jrp-detail-grid">
                <Detail label="Stage" value={(STATUS_META[current] || STATUS_META.draft).label} />
                <Detail label="Department" value={activeRow.department} />
                <Detail label="Employment Type" value={empTypeLabel(activeRow.employment_type)} />
                <Detail label="Positions" value={activeRow.number_of_positions} />
                <Detail label="Priority" value={requisitionPriority(activeRow.priority).label} />
                <Detail label="Requested By" value={activeRow.requested_by_name} />
                <Detail label="Reason" value={activeRow.hiring_reason === 'replacement'
                  ? `Replacement${activeRow.replacing_employee_name ? ` for ${activeRow.replacing_employee_name}` : ''}` : 'New position'} />
                <Detail label="Created" value={formatDate(activeRow.created_at)} />
                <Detail label="Location" value={activeRow.location} />
                <Detail label="Experience" value={rangeText(activeRow.experience_min, activeRow.experience_max) && `${rangeText(activeRow.experience_min, activeRow.experience_max)} yrs`} />
                <Detail label="Budget" value={rangeText(activeRow.salary_min, activeRow.salary_max, inr) && `${rangeText(activeRow.salary_min, activeRow.salary_max, inr)} per year`} full />
                <Detail label="Justification" value={activeRow.justification} full />
                <Detail label="Skills" value={activeRow.skills_required} full />
                <Detail label="Description" value={activeRow.job_description} full />
                {activeRow.opening_id && (
                  <Detail label="Job opening" full value={`${activeRow.opening_title} — ${OPENING_STATUS[activeRow.opening_status] || activeRow.opening_status}, ${activeRow.applicants_count || 0} applicant${activeRow.applicants_count === 1 ? '' : 's'}, ${activeRow.positions_filled || 0} of ${activeRow.number_of_positions} filled`} />
                )}
              </div>
              {current === 'pending_approval' && canDecide && (
                <div className="jrp-field jrp-field-full" style={{ marginTop: 16 }}>
                  <label>Approver comment (required to send back)</label>
                  <textarea rows={2} value={decisionComment} onChange={(e) => setDecisionComment(e.target.value)}
                    placeholder="Shown to the requester" />
                </div>
              )}
              {current === 'pending_approval' && !canDecide && (
                <div className="jrp-wait">Waiting for Super Admin approval.</div>
              )}
              </div>
              <aside className="jrp-split-side">
                <JobTimeline requisitionId={activeRow.id} refreshKey={timelineKey} setPage={setPage} />
              </aside>
            </div>
            <div className="jrp-panel-ft">
              <button className="jrp-btn-outline" onClick={() => setActiveRow(null)}>Back to list</button>
              {canManage && current === 'draft' && <button className="jrp-btn-outline" disabled={busy} onClick={() => openEdit(activeRow)}><Pencil size={13} /> Edit</button>}
              {canManage && ['draft', 'cancelled'].includes(current) && <button className="jrp-btn-outline" disabled={busy} onClick={() => removeRequisition(activeRow)}><Trash2 size={13} /> Delete</button>}
              {canMove && ['draft', 'pending_approval', 'approved'].includes(current) && (
                <button className="jrp-btn-outline" disabled={busy} onClick={() => { if (window.confirm(`Cancel ${reqNo(activeRow)}? It can then only be deleted.`)) moveStatus('cancelled'); }}><Ban size={13} /> Cancel requisition</button>
              )}
              {canManage && current === 'pending_approval' && <button className="jrp-btn-outline" disabled={busy} onClick={() => moveStatus('draft')}>Withdraw to draft</button>}
              {canDecide && current === 'pending_approval' && <button className="jrp-btn-outline" disabled={busy} onClick={sendBack}>Send back</button>}
              {canManage && current === 'draft' && (
                <button className="jrp-btn-primary" disabled={busy} title={activeRow.justification ? '' : 'Add a justification first (Edit)'}
                  onClick={() => (activeRow.justification ? moveStatus('pending_approval') : openEdit(activeRow))}>
                  Submit for approval
                </button>
              )}
              {canDecide && current === 'pending_approval' && <button className="jrp-btn-primary" disabled={busy} onClick={() => moveStatus('approved')}>Approve</button>}
              {activeRow.opening_id && (
                <button className="jrp-btn-outline" onClick={() => viewApplicants(activeRow.opening_id)}><Users size={13} /> View applicants ({activeRow.applicants_count || 0})</button>
              )}
              {current === 'approved' && activeRow.opening_id && (
                // A draft job, saved but not published yet.
                <button className="jrp-btn-primary" onClick={() => setJobPanel({ openingId: activeRow.opening_id })}>
                  <Briefcase size={13} /> Open draft job
                </button>
              )}
              {current === 'approved' && !activeRow.opening_id && (
                <button className="jrp-btn-primary" onClick={() => setJobPanel({ requisitionId: activeRow.id })}>
                  <Briefcase size={13} /> Post job opening
                </button>
              )}
              {current === 'open' && (
                <>
                  <button className="jrp-btn-outline" onClick={() => setJobPanel({ openingId: activeRow.opening_id })}><Pencil size={13} /> Edit job</button>
                  {canMove && (
                    <button className="jrp-btn-outline" disabled={busy}
                      onClick={() => { if (window.confirm('Close this requisition? Its job opening closes too and comes off the careers page.')) moveStatus('closed'); }}>
                      Close requisition
                    </button>
                  )}
                </>
              )}
              {current === 'closed' && (() => {
                const filled = Number(activeRow.positions_filled || 0) >= Number(activeRow.number_of_positions || 1) && activeRow.opening_id;
                return (
                  <>
                    {activeRow.opening_id && (
                      <button className="jrp-btn-outline" onClick={() => setJobPanel({ openingId: activeRow.opening_id })}><Pencil size={13} /> Edit job</button>
                    )}
                    {canMove && <button className="jrp-btn-primary" disabled={busy || filled}
                      title={filled ? 'Every position is filled — raise a new requisition for more hires' : ''}
                      onClick={() => {
                        const msg = activeRow.opening_id && activeRow.opening_status !== 'cancelled'
                          ? 'Reopen this requisition? Its job opening reopens too and goes back on the careers page.'
                          : 'Reopen this requisition? It goes back to Approved so a job can be posted against it.';
                        if (window.confirm(msg)) moveStatus('open');
                      }}>
                      <RefreshCw size={13} /> {filled ? 'All positions filled' : 'Reopen requisition'}
                    </button>}
                  </>
                );
              })()}
              {canMove && current === 'cancelled' && (
                <button className="jrp-btn-primary" disabled={busy}
                  onClick={() => { if (window.confirm('Restore this requisition to draft? It must be submitted and approved again.')) moveStatus('draft'); }}>
                  <RefreshCw size={13} /> Restore to draft
                </button>
              )}
            </div>
          </div>
      )}
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={
      <PageHero
        icon={UserPlus}
        eyebrow="Recruitment"
        title="Requisitions"
        subtitle="Raise hiring requests and get them approved"
        actions={toolbar}
      />
    }>
      {body}
    </PageShell>
  );
}

function SumCard({ icon: Icon, bg, fg, n, label, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className="jrp-sum-card" onClick={onClick} style={onClick ? { cursor: 'pointer', textAlign: 'left', border: 'none', font: 'inherit' } : undefined}>
      <div className="jrp-sum-icon" style={{ background: bg, color: fg }}><Icon size={16} /></div>
      <div><div className="jrp-sum-num">{n}</div><div className="jrp-sum-lbl">{label}</div></div>
    </Tag>
  );
}

function Detail({ label, value, full = false }) {
  return (
    <div className={`jrp-detail-item${full ? ' jrp-detail-full' : ''}`}>
      <span className="jrp-detail-lbl">{label}</span>
      <span className="jrp-detail-val" style={{ whiteSpace: 'pre-wrap' }}>{has(value) ? value : '-'}</span>
    </div>
  );
}
