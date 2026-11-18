// frontend/src/features/hr/succession/SuccessionPlanning.jsx
// Succession Center → Planning: the 9-box rating (the ONE source of readiness),
// the critical-role register with its successors, and bench strength.
import React, { useState, useEffect, useCallback } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { fmtScore } from '@/utils/format';
import { fmtDate, formatDateTime } from '@/utils/dateFormatter';
import { downloadSuccessionCsv } from '../utils/successionCsv';
import {
  READY_LABELS, RISK_COLORS, UNRATED_LABEL, INP, LBL, BTN, Chip, RiskBadge, ReadyBadge, PhaseBadge,
  Spinner, Flash, LoadError, useFlash, errText, useCurrentEmployees, empLabel,
} from '../utils/successionUi';

/* ─── constants ─────────────────────────────────────────────── */

const NINE_BOX_META = {
  '1_3': { label: 'Question Marks',    color: '#7c5cf0', bg: '#f5f3ff', desc: 'High potential, low performance'    },
  '2_3': { label: 'Diamonds',          color: '#8b5cf6', bg: '#f5f3ff', desc: 'High potential, medium performance' },
  '3_3': { label: '★ Stars',            color: '#6B3FDB', bg: '#ede9fe', desc: 'High performance & high potential'  },
  '1_2': { label: 'Underperformers',   color: '#ef4444', bg: '#fef2f2', desc: 'Medium potential, low performance'  },
  '2_2': { label: 'Core Contributors', color: '#2563eb', bg: '#eff6ff', desc: 'Solid performance & potential'      },
  '3_2': { label: 'High Performers',   color: '#16a34a', bg: '#f0fdf4', desc: 'High performance, medium potential' },
  '1_1': { label: 'Low Performance / Low Potential', color: '#6b7280', bg: '#f9fafb', desc: 'Low performance & potential' },
  '2_1': { label: 'Inconsistent',      color: '#6d28d9', bg: '#f5f3ff', desc: 'Low potential, medium performance'  },
  '3_1': { label: 'Workhorses',        color: '#0891b2', bg: '#ecfeff', desc: 'High performance, lower potential'  },
};
const PERF_LABELS  = { 1: 'Low', 2: 'Medium', 3: 'High' };
const PIE_COLORS     = ['#16a34a', '#6d28d9', '#dc2626'];
const READY_ORDER    = ['ready-now', '1-2-years', '3-5-years', 'not_ready', 'unclassified'];
const READY_BAR      = { 'ready-now': '#16a34a', '1-2-years': '#6d28d9', '3-5-years': '#6b7280', 'not_ready': '#ef4444', unclassified: '#d1d5db' };
const SUCCESSOR_TYPES = ['primary', 'secondary', 'tertiary', 'emergency'];
const MOBILITY_OPTS   = ['flexible', 'local_only', 'regional', 'international', 'remote_only'];
const TALENT_CLASS    = ['HiPo', 'Solid Performer', 'Emerging Talent', 'Specialist', 'Future Leader', 'At Risk'];
const HISTORY_ACTIONS = { reassessed: 'Re-rated', edited: 'Edited', deleted: 'Deleted', performance_sync: 'Synced from performance', performance_review: 'Performance review' };
const ALERT_LABELS = { employee_left: 'Employee left', employee_notice: 'Serving notice', zero_successor: 'No successor', single_successor: 'Single successor' };

const ASSESS_DEFAULT = {
  employee_id: '', performance_score: 3, potential_score: 3,
  flight_risk: 'low', readiness: '1-2-years', notes: '',
  leadership_score: 3, mobility: 'flexible', talent_classification: '', assessment_period: '',
};
const ROLE_DEFAULT = {
  role_title: '', department: '', current_holder_id: '',
  risk_level: 'medium', reason: '',
  knowledge_domain: '', vacancy_impact: '', expected_vacancy_date: '',
};
const CAND_DEFAULT = {
  candidate_employee_id: '', development_actions: '',
  is_emergency_successor: false, successor_type: 'secondary',
};

const tabStyle = (active) => ({
  padding: '8px 20px', border: 'none', cursor: 'pointer',
  borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14,
  background: active ? '#6B3FDB' : '#e9e4ff',
  color: active ? '#fff' : '#6B3FDB',
});

const drawerStyle = (width = 440) => ({
  position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', maxHeight: 'calc(100vh - 48px)', borderRadius: 12, maxWidth: 'calc(100vw - 32px)', width: `min(${width}px, 100vw)`,
  background: '#fff',
  boxShadow: '0 20px 60px rgba(0,0,0,.18)',
  zIndex: 999, overflowY: 'auto', padding: 24,
  boxSizing: 'border-box',
});

/* ─── tiny sub-components ───────────────────────────────────── */

const rankMedal = (rank) =>
  rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `#${rank}`;
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const titleCase = (s = '') => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function EmployeeChip({ emp, onSelect }) {
  return (
    <button type="button" onClick={() => onSelect(emp)}
         title={`${emp.name}${emp.designation ? ' — ' + emp.designation : ''}${emp.employment_phase === 'notice' ? ' (serving notice)' : ''}`}
         style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px',
                  borderRadius: 20, background: '#fff', border: `1px solid ${emp.employment_phase === 'notice' ? '#f59e0b' : '#e9e4ff'}`,
                  cursor: 'pointer', margin: '2px', fontSize: 12, fontWeight: 500, font: 'inherit',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.06)' }}>
      <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#ede9fe', color: '#6B3FDB',
                     display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700 }}>
        {initials(emp.name)}
      </span>
      {emp.name.split(' ')[0]}
      <span aria-label={`${emp.flight_risk || 'low'} flight risk`}
            style={{ width: 8, height: 8, borderRadius: '50%', background: RISK_COLORS[emp.flight_risk] ?? '#16a34a', flexShrink: 0 }} />
    </button>
  );
}

function EmptyState({ title, body }) {
  return (
    <div style={{ textAlign: 'center', padding: '44px 20px', color: '#9ca3af' }}>
      <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 15, marginBottom: 6 }}>{title}</div>
      {body && <div style={{ fontSize: 13 }}>{body}</div>}
    </div>
  );
}

function ScoreBar({ label, score, max = 5, color }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: '#6b7280' }}>{label}</span>
        <strong style={{ color }}>{fmtScore(score, max)}</strong>
      </div>
      <div style={{ height: 6, background: '#f0ebff', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(Number(score) / max) * 100}%`, background: color, borderRadius: 4,
                      transition: 'width .4s' }} />
      </div>
    </div>
  );
}

function ScoreButtons({ value, onChange, max = 5, activeColor = '#6B3FDB', label }) {
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {Array.from({ length: max }, (_, i) => i + 1).map(v => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          style={{ width: 34, height: 34, borderRadius: 6, border: 'none', cursor: 'pointer',
                   fontWeight: 700, fontSize: 13,
                   background: value === v ? activeColor : '#e9e4ff',
                   color: value === v ? '#fff' : activeColor }}>
          {v}
        </button>
      ))}
    </div>
  );
}

/* ─── main component ────────────────────────────────────────── */
export default function SuccessionPlanning() {
  const [tab, setTab]                 = useState('ninebox');
  const [nineBox, setNineBox]         = useState([]);
  const [critRoles, setCritRoles]     = useState([]);
  const [candidates, setCandidates]   = useState([]);
  const [selRole, setSelRole]         = useState(null);
  const [selEmp, setSelEmp]           = useState(null);
  const [dashData, setDashData]       = useState(null);
  const [employees, empError]         = useCurrentEmployees();
  const [deptList,  setDeptList]      = useState([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [loading, setLoading]         = useState(false);
  const [candLoading, setCandLoading] = useState(false);
  const [msg, flash]                  = useFlash();
  const [deptFilter, setDeptFilter]   = useState('');
  const [loadError, setLoadError]     = useState('');
  const [alerts, setAlerts]           = useState([]);
  const [showAlerts, setShowAlerts]   = useState(false);
  const [history, setHistory]         = useState(null);   // null = hidden
  const [syncPreview, setSyncPreview] = useState(null);

  const [showAssessForm, setShowAssessForm] = useState(false);
  const [editAssessId, setEditAssessId]     = useState(null);
  const [assessForm, setAssessForm]         = useState(ASSESS_DEFAULT);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const [showRoleForm, setShowRoleForm] = useState(false);
  const [editRoleId, setEditRoleId]     = useState(null);
  const [roleForm, setRoleForm]         = useState(ROLE_DEFAULT);

  const [showCandForm, setShowCandForm] = useState(false);
  const [candForm, setCandForm]         = useState(CAND_DEFAULT);

  const [pendingDeleteAssessment, setPendingDeleteAssessment] = useState(null);
  const [pendingDeleteRole,       setPendingDeleteRole]       = useState(null);
  const [pendingRemoveCandidate,  setPendingRemoveCandidate]  = useState(null);

  /* ── data loading ── */
  const load = useCallback(async () => {
    const [nbRes, crRes, dRes] = await Promise.allSettled([
      api.get('/succession/nine-box'),
      api.get('/succession/critical-roles'),
      api.get('/succession/dashboard'),
    ]);
    if (nbRes.status === 'fulfilled') setNineBox(nbRes.value.data || []);
    if (crRes.status === 'fulfilled') setCritRoles(crRes.value.data || []);
    if (dRes.status === 'fulfilled')  setDashData(dRes.value.data);
    // A failed request used to leave its section at zero with no word said,
    // which reads as "no successors" rather than "could not load".
    const failed = [nbRes, crRes, dRes].find(r => r.status === 'rejected');
    setLoadError(failed ? errText(failed.reason, 'Some succession data could not be loaded') : '');
    setPageLoading(false);
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const r = await api.get('/succession/alerts', { params: { unread: '1' } });
      setAlerts(r.data || []);
    } catch (err) { flash(errText(err, 'Could not load alerts'), 'error'); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleAlerts = () => {
    if (!showAlerts) loadAlerts();
    setShowAlerts(v => !v);
  };
  const markAlertRead = async (id) => {
    try {
      await api.patch(`/succession/alerts/${id}/read`);
      await loadAlerts();
      load();
    } catch (err) { flash(errText(err, 'Could not mark the alert read'), 'error'); }
  };
  const markAllRead = async () => {
    try {
      await api.patch('/succession/alerts/read-all');
      setAlerts([]);
      setShowAlerts(false);
      load();
    } catch (err) { flash(errText(err, 'Could not mark the alerts read'), 'error'); }
  };

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  useEffect(() => { setSelRole(null); setSelEmp(null); setHistory(null); }, [tab]);

  // Escape closes the open drawer.
  useEffect(() => {
    if (!selEmp && !selRole) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { setSelEmp(null); setSelRole(null); setHistory(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selEmp, selRole]);

  const loadCandidates = async (roleId) => {
    try {
      const r = await api.get(`/succession/critical-roles/${roleId}/candidates`);
      setCandidates(r.data || []);
    } catch (err) {
      setCandidates([]);
      flash(errText(err, 'Could not load the candidates'), 'error');
    }
  };

  /* ── assessment CRUD ── */
  const assessedIds = new Set(nineBox.flatMap(c => (c.employees || []).map(e => e.employee_id)));

  const saveAssessment = async () => {
    setLoading(true);
    try {
      const payload = {
        performance_score:    assessForm.performance_score,
        potential_score:      assessForm.potential_score,
        flight_risk:          assessForm.flight_risk,
        readiness:            assessForm.readiness,
        notes:                assessForm.notes || null,
        leadership_score:     assessForm.leadership_score || null,
        mobility:             assessForm.mobility,
        talent_classification: assessForm.talent_classification || null,
        assessment_period:    assessForm.assessment_period || null,
      };
      if (editAssessId) {
        await api.patch(`/succession/assessments/${editAssessId}`, payload);
        flash('Assessment updated');
      } else {
        await api.post('/succession/assessments', { ...payload, employee_id: Number(assessForm.employee_id) });
        flash('Assessment saved');
      }
      setShowAssessForm(false);
      setEditAssessId(null);
      setAssessForm(ASSESS_DEFAULT);
      setSelEmp(null);
      load();
    } catch (err) {
      flash(errText(err, 'Failed to save'), 'error');
    } finally { setLoading(false); }
  };

  const submitAssessment = (e) => {
    e.preventDefault();
    // A new rating for someone already on the grid replaces theirs (the old one
    // is kept in history). Say so before doing it.
    if (!editAssessId && assessedIds.has(Number(assessForm.employee_id))) { setConfirmReplace(true); return; }
    saveAssessment();
  };

  const startEditAssessment = (emp) => {
    setAssessForm({
      employee_id:           emp.employee_id,
      // numeric(3,2) arrives as "3.00"; a fractional synced rating (3.5)
      // highlights no button and is saved back unchanged unless one is picked.
      performance_score:     emp.performance_score == null ? emp.performance_score : Number(emp.performance_score),
      potential_score:       emp.potential_score,
      flight_risk:           emp.flight_risk || 'low',
      readiness:             READY_LABELS[emp.readiness] ? emp.readiness : '1-2-years',
      notes:                 emp.notes || '',
      leadership_score:      emp.leadership_score || 3,
      mobility:              emp.mobility || 'flexible',
      talent_classification: emp.talent_classification || '',
      assessment_period:     emp.assessment_period || '',
    });
    setEditAssessId(emp.id);
    setSelEmp(null);
    setHistory(null);
    setTab('ninebox');
    setShowAssessForm(true);
  };

  const cancelAssessForm = () => {
    setShowAssessForm(false);
    setEditAssessId(null);
    setAssessForm(ASSESS_DEFAULT);
  };

  const deleteAssessment = async () => {
    if (!pendingDeleteAssessment) return;
    const emp = pendingDeleteAssessment;
    setPendingDeleteAssessment(null);
    try {
      await api.delete(`/succession/assessments/${emp.id}`);
      flash('Assessment deleted (kept in its history)');
      setSelEmp(null);
      setHistory(null);
      load();
    } catch (err) { flash(errText(err, 'Failed to delete'), 'error'); }
  };

  const toggleHistory = async (emp) => {
    if (history) { setHistory(null); return; }
    try {
      const r = await api.get(`/succession/assessments/${emp.employee_id}/history`);
      setHistory(r.data || []);
    } catch (err) { flash(errText(err, 'Could not load the history'), 'error'); }
  };

  /* ── sync from performance reviews ── */
  const previewSync = async () => {
    try {
      const r = await api.post('/succession/assessments/sync-from-reviews', { dry_run: true });
      if (!r.data.would_update) { flash('Every rating already matches its latest completed performance review'); return; }
      setSyncPreview(r.data);
    } catch (err) { flash(errText(err, 'Could not check the performance reviews'), 'error'); }
  };
  const runSync = async () => {
    setSyncPreview(null);
    try {
      const r = await api.post('/succession/assessments/sync-from-reviews', {});
      flash(`${r.data.updated} performance score${r.data.updated === 1 ? '' : 's'} updated from completed reviews`);
      load();
    } catch (err) { flash(errText(err, 'Sync failed'), 'error'); }
  };

  /* ── critical role CRUD ── */
  const submitRole = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        ...roleForm,
        current_holder_id:    roleForm.current_holder_id ? Number(roleForm.current_holder_id) : null,
        department:           roleForm.department || null,
        reason:               roleForm.reason || null,
        knowledge_domain:     roleForm.knowledge_domain || null,
        vacancy_impact:       roleForm.vacancy_impact || null,
        expected_vacancy_date: roleForm.expected_vacancy_date || null,
      };
      if (editRoleId) {
        await api.patch(`/succession/critical-roles/${editRoleId}`, payload);
        flash('Critical role updated');
      } else {
        await api.post('/succession/critical-roles', payload);
        flash('Critical role added');
      }
      setShowRoleForm(false);
      setEditRoleId(null);
      setRoleForm(ROLE_DEFAULT);
      load();
    } catch (err) {
      flash(errText(err, 'Failed to save'), 'error');
    } finally { setLoading(false); }
  };

  const startEditRole = (role, e) => {
    e.stopPropagation();
    setRoleForm({
      role_title:           role.role_title,
      department:           role.department || '',
      current_holder_id:    role.current_holder_id || '',
      risk_level:           role.risk_level,
      reason:               role.reason || '',
      knowledge_domain:     role.knowledge_domain || '',
      vacancy_impact:       role.vacancy_impact || '',
      expected_vacancy_date: role.expected_vacancy_date?.split('T')[0] || '',
    });
    setEditRoleId(role.id);
    setSelRole(null);
    setShowRoleForm(true);
  };

  const cancelRoleForm = () => {
    setShowRoleForm(false);
    setEditRoleId(null);
    setRoleForm(ROLE_DEFAULT);
  };

  const deleteRole = async () => {
    if (!pendingDeleteRole) return;
    const id = pendingDeleteRole;
    setPendingDeleteRole(null);
    try {
      await api.delete(`/succession/critical-roles/${id}`);
      flash('Critical role deleted');
      setSelRole(null);
      load();
    } catch (err) { flash(errText(err, 'Failed to delete'), 'error'); }
  };

  /* ── candidate management ──
     The slate is saved whole. Readiness is not part of it: each candidate's
     readiness is their 9-box rating. */
  const slate = (list) => list.map((c, i) => ({
    candidate_employee_id: c.candidate_employee_id,
    rank:                  i + 1,
    development_actions:   Array.isArray(c.development_actions) ? c.development_actions : [],
    is_emergency_successor: !!c.is_emergency_successor,
    successor_type:        c.successor_type || 'secondary',
  }));

  const saveSlate = async (list, done) => {
    setCandLoading(true);
    try {
      await api.put(`/succession/critical-roles/${selRole.id}/candidates`, { candidates: slate(list) });
      await loadCandidates(selRole.id);
      load();
      flash(done);
      return true;
    } catch (err) {
      flash(errText(err, 'Failed to save the candidates'), 'error');
      return false;
    } finally { setCandLoading(false); }
  };

  const addCandidate = async (e) => {
    e.preventDefault();
    const devActions = candForm.development_actions.split('\n').map(s => s.trim()).filter(Boolean);
    const ok = await saveSlate([...candidates, {
      candidate_employee_id: Number(candForm.candidate_employee_id),
      development_actions:   devActions,
      is_emergency_successor: candForm.successor_type === 'emergency',
      successor_type:        candForm.successor_type,
    }], 'Candidate added to the succession plan');
    if (ok) { setCandForm(CAND_DEFAULT); setShowCandForm(false); }
  };

  const removeCandidate = async () => {
    if (!pendingRemoveCandidate) return;
    const { candidateEmployeeId } = pendingRemoveCandidate;
    setPendingRemoveCandidate(null);
    await saveSlate(candidates.filter(c => c.candidate_employee_id !== candidateEmployeeId), 'Candidate removed');
  };

  const moveCandidate = (index, delta) => {
    const next = [...candidates];
    const [c] = next.splice(index, 1);
    next.splice(index + delta, 0, c);
    saveSlate(next, 'Order saved');
  };

  /* ── CSV export (bench strength tab) ── */
  const exportBenchCSV = async () => {
    try { await downloadSuccessionCsv('bench-strength', 'bench_strength.csv'); }
    catch (err) { flash(err.message, 'error'); }
  };

  /* ── computed ── */
  const allDepts = [...new Set(
    nineBox.flatMap(cell => (cell.employees || []).map(e => e.department)).filter(Boolean)
  )].sort();

  const filteredNineBox = deptFilter
    ? nineBox.map(cell => ({
        ...cell,
        employees: (cell.employees || []).filter(e => e.department === deptFilter),
      }))
    : nineBox;

  const getCell = (perf, pot) =>
    filteredNineBox.find(c => c.performance === perf && c.potential === pot)
    || { performance: perf, potential: pot, employees: [] };

  const totalAssessed = nineBox.reduce((s, c) => s + (c.employees?.length || 0), 0);

  const flightData = [
    { name: 'Low',    value: dashData?.flight_risk?.low    || 0 },
    { name: 'Medium', value: dashData?.flight_risk?.medium || 0 },
    { name: 'High',   value: dashData?.flight_risk?.high   || 0 },
  ];
  const hasFlightData  = flightData.some(d => d.value > 0);
  const readyData      = [...(dashData?.readiness_summary || [])]
    .sort((a, b) => READY_ORDER.indexOf(a.readiness) - READY_ORDER.indexOf(b.readiness))
    .map(r => ({ key: r.readiness, name: READY_LABELS[r.readiness] || UNRATED_LABEL, count: parseInt(r.cnt) || 0 }));
  const benchPct       = dashData?.bench_strength_pct || 0;
  const hipo           = dashData?.hipo_thresholds || { potential: 4, performance: 3 };
  const addedCandIds   = new Set(candidates.map(c => c.candidate_employee_id));
  const candEmployees  = employees.filter(e => !addedCandIds.has(e.id));
  const editingEmployee = editAssessId
    ? (nineBox.flatMap(c => c.employees || []).find(e => e.id === editAssessId)
       || employees.find(e => e.id === Number(assessForm.employee_id)))
    : null;
  const pickedRated = employees.find(e => e.id === Number(candForm.candidate_employee_id) && assessedIds.has(e.id));
  const pickedReadiness = pickedRated
    ? nineBox.flatMap(c => c.employees || []).find(e => e.employee_id === pickedRated.id)?.readiness
    : null;

  /* ────────────────────────────────────────────────────────── */
  return (
    <div>
      <ConfirmDialog
        open={!!pendingDeleteAssessment}
        title="Delete Assessment"
        message={pendingDeleteAssessment ? `Delete the talent assessment for ${pendingDeleteAssessment.name}? It is kept in the rating history, and they leave the 9-box.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteAssessment}
        onCancel={() => setPendingDeleteAssessment(null)}
      />
      <ConfirmDialog
        open={confirmReplace}
        title="Replace Rating"
        message={`${employees.find(e => e.id === Number(assessForm.employee_id))?.name || 'This employee'} already has a 9-box rating. Saving replaces it; the current one is kept in their history.`}
        confirmLabel="Replace"
        variant="warning"
        onConfirm={() => { setConfirmReplace(false); saveAssessment(); }}
        onCancel={() => setConfirmReplace(false)}
      />
      <ConfirmDialog
        open={!!syncPreview}
        title="Sync from Performance Reviews"
        message={syncPreview ? `${syncPreview.would_update} performance score${syncPreview.would_update === 1 ? '' : 's'} will be replaced by the latest completed review: ${syncPreview.changes.map(c => `${c.name} ${c.current_score == null ? '(new)' : fmtScore(c.current_score, 5)} → ${fmtScore(c.score, 5)}`).join(', ')}. The current ratings are kept in history.` : ''}
        confirmLabel="Sync"
        variant="warning"
        onConfirm={runSync}
        onCancel={() => setSyncPreview(null)}
      />
      <ConfirmDialog
        open={!!pendingDeleteRole}
        title="Delete Critical Role"
        message="Delete this critical role and all its succession candidates? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteRole}
        onCancel={() => setPendingDeleteRole(null)}
      />
      <ConfirmDialog
        open={!!pendingRemoveCandidate}
        title="Remove Candidate"
        message={pendingRemoveCandidate ? `Remove ${pendingRemoveCandidate.name} from this succession plan?` : ''}
        confirmLabel="Remove"
        variant="warning"
        onConfirm={removeCandidate}
        onCancel={() => setPendingRemoveCandidate(null)}
      />

      <Flash msg={msg} />
      <LoadError text={loadError && `${loadError}. The figures below may be incomplete.`} onRetry={load} />
      <LoadError text={empError} />

      {/* Unread alerts banner */}
      {dashData?.unread_alerts > 0 && (
        <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8,
                      background: '#fff7ed', border: '1px solid #ddd6fe',
                      color: '#5b21b6', fontSize: 13, fontWeight: 500 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span>
              {dashData.unread_alerts} succession alert{dashData.unread_alerts > 1 ? 's' : ''} need attention
              {dashData.zero_successor_count > 0 &&
                ` — ${dashData.zero_successor_count} critical role${dashData.zero_successor_count > 1 ? 's' : ''} without any successor`}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={toggleAlerts} style={BTN('ghost', true)} aria-expanded={showAlerts}>
                {showAlerts ? 'Hide alerts' : 'Review alerts'}
              </button>
              {showAlerts && alerts.length > 1 && (
                <button type="button" onClick={markAllRead} style={BTN('outline', true)}>Mark all read</button>
              )}
            </span>
          </div>
          {showAlerts && (
            <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0 }}>
              {alerts.length === 0 && <li style={{ padding: '6px 0', fontWeight: 400 }}>No unread alerts.</li>}
              {alerts.map(a => (
                <li key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12,
                                        padding: '8px 0', borderTop: '1px solid #f0ebff', fontWeight: 400 }}>
                  <span>
                    <Chip color={a.severity === 'critical' ? '#dc2626' : a.alert_type === 'employee_notice' ? '#b45309' : '#6d28d9'}>
                      {ALERT_LABELS[a.alert_type] || 'Alert'}
                    </Chip>{' '}
                    {a.message}
                    <span style={{ color: '#9ca3af', fontSize: 11 }}> · {formatDateTime(a.created_at)}</span>
                  </span>
                  <button type="button" onClick={() => markAlertRead(a.id)} style={{ ...BTN('outline', true), flexShrink: 0, alignSelf: 'flex-start' }}>Mark read</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Tab bar */}
      <div role="tablist" aria-label="Planning views" style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }}>
        {[['ninebox', '9-Box Grid'], ['critical', 'Critical Roles'], ['bench', 'Bench Strength']].map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} style={tabStyle(tab === k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none',
                    borderRadius: '0 8px 8px 8px', padding: 20 }}>
        {pageLoading ? <Spinner /> : (
          <>
            {/* ══════════════════ 9-BOX GRID TAB ══════════════════ */}
            {tab === 'ninebox' && (
              <div>
                {/* Toolbar */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                              marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <h3 style={{ margin: 0, color: '#4c1d95' }}>9-Box Talent Grid</h3>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 5, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                      {[['#16a34a','Low'],['#6d28d9','Medium'],['#dc2626','High']].map(([c, l]) => (
                        <span key={l}>
                          <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%',
                                         background:c, marginRight:4 }} />
                          {l} flight risk
                        </span>
                      ))}
                      {totalAssessed > 0 && (
                        <span style={{ color: '#6B3FDB', fontWeight: 600 }}>
                          {totalAssessed} employee{totalAssessed !== 1 ? 's' : ''} assessed
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                      Current employees only. Readiness set here is used everywhere in Succession.
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {allDepts.length > 1 && (
                      <select aria-label="Department" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}
                        style={{ ...INP, width: 'auto', padding: '6px 10px', fontSize: 12 }}>
                        <option value="">All Departments</option>
                        {allDepts.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    )}
                    <button type="button" style={BTN('outline')} onClick={previewSync}
                      title="Update performance scores from each employee's latest completed performance review">
                      Sync from performance
                    </button>
                    <button type="button" style={BTN(showAssessForm ? 'secondary' : 'primary')}
                      onClick={() => { showAssessForm ? cancelAssessForm() : setShowAssessForm(true); }}>
                      {showAssessForm ? 'Cancel' : '+ Add Assessment'}
                    </button>
                  </div>
                </div>

                {/* Assessment form */}
                {showAssessForm && (
                  <form onSubmit={submitAssessment}
                    style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 20,
                             border: '1px solid #e9e4ff' }}>
                    <h4 style={{ margin: '0 0 14px', color: '#4c1d95' }}>
                      {editAssessId
                        ? `Edit Assessment — ${editingEmployee?.name || 'Employee'}`
                        : 'New Talent Assessment'}
                    </h4>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>

                      {editAssessId ? (
                        <div>
                          <span style={LBL}>Employee</span>
                          <div style={{ ...INP, background: '#f9fafb', color: '#374151', fontWeight: 600 }}>
                            {editingEmployee?.name || '—'}
                            {editingEmployee?.designation ? ` — ${editingEmployee.designation}` : ''}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label style={LBL} htmlFor="as-emp">Employee *</label>
                          <select id="as-emp" required value={assessForm.employee_id}
                            onChange={e => setAssessForm(f => ({ ...f, employee_id: e.target.value }))}
                            style={INP}>
                            <option value="">— Select employee —</option>
                            {employees.map(emp => (
                              <option key={emp.id} value={emp.id}>
                                {empLabel(emp)}{assessedIds.has(emp.id) ? ' (rated — will replace)' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {[['performance_score','Performance (1–5)','#16a34a'],
                        ['potential_score',  'Potential (1–5)',   '#6B3FDB'],
                        ['leadership_score', 'Leadership (1–5)',  '#0891b2']].map(([key, lbl, clr]) => (
                        <div key={key}>
                          <span style={LBL}>{lbl}</span>
                          <ScoreButtons label={lbl} value={assessForm[key]}
                            onChange={v => setAssessForm(f => ({ ...f, [key]: v }))}
                            activeColor={clr} />
                        </div>
                      ))}

                      <div>
                        <label style={LBL} htmlFor="as-risk">Flight Risk</label>
                        <select id="as-risk" value={assessForm.flight_risk}
                          onChange={e => setAssessForm(f => ({ ...f, flight_risk: e.target.value }))}
                          style={INP}>
                          {['low', 'medium', 'high'].map(r => (
                            <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label style={LBL} htmlFor="as-ready">Succession Readiness</label>
                        <select id="as-ready" value={assessForm.readiness}
                          onChange={e => setAssessForm(f => ({ ...f, readiness: e.target.value }))}
                          style={INP}>
                          {Object.entries(READY_LABELS).map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label style={LBL} htmlFor="as-mob">Mobility</label>
                        <select id="as-mob" value={assessForm.mobility}
                          onChange={e => setAssessForm(f => ({ ...f, mobility: e.target.value }))}
                          style={INP}>
                          {MOBILITY_OPTS.map(m => <option key={m} value={m}>{titleCase(m)}</option>)}
                        </select>
                      </div>

                      <div>
                        <label style={LBL} htmlFor="as-class">Talent Classification</label>
                        <select id="as-class" value={assessForm.talent_classification}
                          onChange={e => setAssessForm(f => ({ ...f, talent_classification: e.target.value }))}
                          style={INP}>
                          <option value="">— None —</option>
                          {TALENT_CLASS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>

                      <div>
                        <label style={LBL} htmlFor="as-period">Assessment Period</label>
                        <input id="as-period" value={assessForm.assessment_period} maxLength={100}
                          onChange={e => setAssessForm(f => ({ ...f, assessment_period: e.target.value }))}
                          placeholder="e.g. Q1 FY2026"
                          style={INP} />
                      </div>

                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL} htmlFor="as-notes">Notes</label>
                        <input id="as-notes" value={assessForm.notes} maxLength={2000}
                          onChange={e => setAssessForm(f => ({ ...f, notes: e.target.value }))}
                          placeholder="Optional observations..."
                          style={INP} />
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                      <button type="submit" disabled={loading} style={BTN('primary')}>
                        {loading ? 'Saving...' : editAssessId ? 'Update Assessment' : 'Save Assessment'}
                      </button>
                      <button type="button" onClick={cancelAssessForm} style={BTN('ghost')}>Cancel</button>
                    </div>
                  </form>
                )}

                {/* 9-Box grid */}
                <div style={{ overflowX: 'auto' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', minWidth: 560 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: 11, color: '#6b7280', fontWeight: 700,
                                writingMode: 'vertical-rl', textOrientation: 'mixed',
                                transform: 'rotate(180deg)', minHeight: 300, paddingRight: 4 }}>
                    POTENTIAL
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr 1fr', gap: 4 }}>
                      <div />
                      {[1, 2, 3].map(p => (
                        <div key={p} style={{ textAlign: 'center', fontWeight: 700, fontSize: 12,
                                              color: '#6B3FDB', padding: '6px 0',
                                              background: '#f5f3ff', borderRadius: '6px 6px 0 0' }}>
                          Performance: {PERF_LABELS[p]}
                        </div>
                      ))}

                      {[3, 2, 1].map(pot => (
                        <React.Fragment key={pot}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                                        fontSize: 11, fontWeight: 700, color: '#6B3FDB',
                                        paddingRight: 8, whiteSpace: 'nowrap' }}>
                            {['', 'Low', 'Med', 'High'][pot]}
                          </div>

                          {[1, 2, 3].map(perf => {
                            const cell = getCell(perf, pot);
                            const meta = NINE_BOX_META[`${perf}_${pot}`]
                              || { label: '', color: '#6b7280', bg: '#f9fafb', desc: '' };
                            const count = cell.employees?.length || 0;
                            return (
                              <div key={`${perf}_${pot}`}
                                style={{ background: meta.bg, border: `1px solid ${meta.color}40`,
                                         borderRadius: 8, padding: 12, minHeight: 100 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                                  <div style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>
                                    {meta.label}
                                  </div>
                                  {count > 0 && (
                                    <span style={{ fontSize: 11, fontWeight: 700,
                                                   background: meta.color + '20', color: meta.color,
                                                   padding: '1px 7px', borderRadius: 10 }}>
                                      {count}
                                    </span>
                                  )}
                                </div>
                                {count === 0 ? (
                                  <div style={{ fontSize: 10, color: meta.color + '80', fontStyle: 'italic' }}>
                                    {meta.desc}
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                                    {cell.employees.map(emp => (
                                      <EmployeeChip key={emp.employee_id} emp={emp} onSelect={(x) => { setSelEmp(x); setHistory(null); }} />
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </React.Fragment>
                      ))}
                    </div>
                    {/* X-axis label */}
                    <div style={{ textAlign: 'center', marginTop: 6, fontSize: 11,
                                  color: '#6b7280', fontWeight: 700 }}>
                      PERFORMANCE
                    </div>
                  </div>
                </div>
                </div>

                {totalAssessed === 0 && !showAssessForm && (
                  <EmptyState title="No talent assessments yet"
                    body="Click '+ Add Assessment' to place your first employee on the 9-box grid, or 'Sync from performance' to start from completed reviews." />
                )}

                {/* Employee detail side drawer */}
                {selEmp && (
                  <div style={drawerStyle(380)} role="dialog" aria-label={`${selEmp.name} rating`}>
                    <button type="button" aria-label="Close" onClick={() => { setSelEmp(null); setHistory(null); }}
                      style={{ position: 'absolute', top: 16, right: 16, background: 'none',
                               border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>
                      ×
                    </button>

                    <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#ede9fe',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 18, marginBottom: 12, fontWeight: 700, color: '#6B3FDB' }}>
                      {initials(selEmp.name)}
                    </div>
                    <h3 style={{ margin: '0 0 2px', color: '#4c1d95', paddingRight: 30 }}>{selEmp.name}</h3>
                    <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 8 }}>
                      {selEmp.designation}{selEmp.designation && selEmp.department ? ' · ' : ''}{selEmp.department}
                    </div>

                    <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                      {(() => {
                        const perf = selEmp.performance_score <= 2 ? 1 : selEmp.performance_score <= 3 ? 2 : 3;
                        const pot  = selEmp.potential_score  <= 2 ? 1 : selEmp.potential_score  <= 3 ? 2 : 3;
                        const meta = NINE_BOX_META[`${perf}_${pot}`];
                        return meta ? <Chip color={meta.color}>{meta.label}</Chip> : null;
                      })()}
                      {selEmp.talent_classification && <Chip color="#1d4ed8">{selEmp.talent_classification}</Chip>}
                      <PhaseBadge phase={selEmp.employment_phase} />
                    </div>

                    <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
                      <RiskBadge level={selEmp.flight_risk} />
                      <ReadyBadge level={selEmp.readiness} />
                      {selEmp.mobility && selEmp.mobility !== 'flexible' && (
                        <Chip color="#6b7280">{titleCase(selEmp.mobility)}</Chip>
                      )}
                    </div>

                    <ScoreBar label="Performance"  score={selEmp.performance_score} color="#16a34a" />
                    <ScoreBar label="Potential"    score={selEmp.potential_score}   color="#6B3FDB" />
                    {selEmp.leadership_score && (
                      <ScoreBar label="Leadership" score={selEmp.leadership_score} color="#0891b2" />
                    )}

                    {selEmp.assessment_period && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 12 }}>
                        Period: {selEmp.assessment_period}
                      </div>
                    )}

                    {selEmp.notes && (
                      <div style={{ background: '#f5f3ff', borderRadius: 8, padding: '10px 12px',
                                    fontSize: 12, color: '#4b5563', marginBottom: 20, fontStyle: 'italic' }}>
                        &ldquo;{selEmp.notes}&rdquo;
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, flexDirection: 'column' }}>
                      <button type="button" onClick={() => startEditAssessment(selEmp)} style={BTN('outline')}>
                        Edit Assessment
                      </button>
                      <button type="button" onClick={() => toggleHistory(selEmp)} style={BTN('secondary')} aria-expanded={!!history}>
                        {history ? 'Hide History' : 'Rating History'}
                      </button>
                      <button type="button" onClick={() => setPendingDeleteAssessment(selEmp)} style={BTN('danger-outline')}>
                        Delete Assessment
                      </button>
                    </div>

                    {history && (
                      <div style={{ marginTop: 18 }}>
                        <h4 style={{ margin: '0 0 8px', color: '#4c1d95', fontSize: 13 }}>Earlier versions ({history.length})</h4>
                        {history.length === 0 ? (
                          <div style={{ fontSize: 12, color: '#9ca3af' }}>No earlier versions. This is the first rating.</div>
                        ) : history.map(h => (
                          <div key={h.id} style={{ borderTop: '1px solid #f0ebff', padding: '8px 0', fontSize: 12 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                              <strong style={{ color: '#1f2937' }}>{HISTORY_ACTIONS[h.change_action] || 'Earlier version'}</strong>
                              <span style={{ color: '#9ca3af' }}>{formatDateTime(h.created_at)}</span>
                            </div>
                            <div style={{ color: '#6b7280', marginTop: 2 }}>
                              Perf {fmtScore(h.performance_score, 5)} · Pot {h.potential_score}/5 · {READY_LABELS[h.readiness] || UNRATED_LABEL} · {titleCase(h.flight_risk || '')} risk
                            </div>
                            <div style={{ color: '#9ca3af', marginTop: 2 }}>
                              Rated {fmtDate(h.assessment_date)}{h.assessed_by_name ? ` by ${h.assessed_by_name}` : ''}
                              {h.changed_by_name ? ` · changed by ${h.changed_by_name}` : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ══════════════════ CRITICAL ROLES TAB ══════════════════ */}
            {tab === 'critical' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between',
                              alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
                  <div>
                    <h3 style={{ margin: 0, color: '#4c1d95' }}>Critical Role Register</h3>
                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
                      {critRoles.length} role{critRoles.length !== 1 ? 's' : ''} tracked
                      {critRoles.filter(r => r.has_ready_now).length > 0
                        ? ` · ${critRoles.filter(r => r.has_ready_now).length} have a ready successor` : ''}
                    </p>
                  </div>
                  <button type="button" style={BTN(showRoleForm ? 'secondary' : 'primary')}
                    onClick={() => { showRoleForm ? cancelRoleForm() : setShowRoleForm(true); }}>
                    {showRoleForm ? 'Cancel' : '+ Add Critical Role'}
                  </button>
                </div>

                {/* Role form */}
                {showRoleForm && (
                  <form onSubmit={submitRole}
                    style={{ background: '#f5f3ff', borderRadius: 10, padding: 16,
                             marginBottom: 20, border: '1px solid #e9e4ff' }}>
                    <h4 style={{ margin: '0 0 14px', color: '#4c1d95' }}>
                      {editRoleId ? 'Edit Critical Role' : 'New Critical Role'}
                    </h4>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL} htmlFor="cr-title">Role / Position Title *</label>
                        <input id="cr-title" required maxLength={200} value={roleForm.role_title}
                          onChange={e => setRoleForm(f => ({ ...f, role_title: e.target.value }))}
                          placeholder="e.g. Chief Financial Officer"
                          style={INP} />
                      </div>
                      <div>
                        <label style={LBL} htmlFor="cr-dept">Department</label>
                        <select id="cr-dept" value={roleForm.department}
                          onChange={e => setRoleForm(f => ({ ...f, department: e.target.value }))}
                          style={INP}>
                          <option value="">-- Select Department --</option>
                          {roleForm.department && !deptList.includes(roleForm.department) && (
                            <option value={roleForm.department}>{roleForm.department}</option>
                          )}
                          {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={LBL} htmlFor="cr-holder">Current Holder</label>
                        <select id="cr-holder" value={roleForm.current_holder_id}
                          onChange={e => setRoleForm(f => ({ ...f, current_holder_id: e.target.value }))}
                          style={INP}>
                          <option value="">— None / Vacant —</option>
                          {roleForm.current_holder_id && !employees.some(e => e.id === Number(roleForm.current_holder_id)) && (
                            <option value={roleForm.current_holder_id}>
                              {critRoles.find(r => r.id === editRoleId)?.current_holder_name || 'Current holder'} (left)
                            </option>
                          )}
                          {employees.map(emp => (
                            <option key={emp.id} value={emp.id}>{empLabel(emp)}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={LBL} htmlFor="cr-risk">Risk Level</label>
                        <select id="cr-risk" value={roleForm.risk_level}
                          onChange={e => setRoleForm(f => ({ ...f, risk_level: e.target.value }))}
                          style={INP}>
                          {['high', 'medium', 'low'].map(r => (
                            <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={LBL} htmlFor="cr-domain">Knowledge Domain</label>
                        <input id="cr-domain" maxLength={200} value={roleForm.knowledge_domain}
                          onChange={e => setRoleForm(f => ({ ...f, knowledge_domain: e.target.value }))}
                          placeholder="e.g. HVDC Power Systems, DSP"
                          style={INP} />
                      </div>
                      <div>
                        <label style={LBL} htmlFor="cr-vac">Expected Vacancy Date</label>
                        <input id="cr-vac" type="date" value={roleForm.expected_vacancy_date}
                          onChange={e => setRoleForm(f => ({ ...f, expected_vacancy_date: e.target.value }))}
                          style={INP} />
                      </div>
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL} htmlFor="cr-reason">Reason / Business Impact</label>
                        <input id="cr-reason" maxLength={2000} value={roleForm.reason}
                          onChange={e => setRoleForm(f => ({ ...f, reason: e.target.value }))}
                          placeholder="Why is this role critical?"
                          style={INP} />
                      </div>
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL} htmlFor="cr-impact">Vacancy Impact</label>
                        <input id="cr-impact" maxLength={2000} value={roleForm.vacancy_impact}
                          onChange={e => setRoleForm(f => ({ ...f, vacancy_impact: e.target.value }))}
                          placeholder="What happens if this role is vacant?"
                          style={INP} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                      <button type="submit" disabled={loading} style={BTN('primary')}>
                        {loading ? 'Saving...' : editRoleId ? 'Update Role' : 'Add Role'}
                      </button>
                      <button type="button" onClick={cancelRoleForm} style={BTN('ghost')}>Cancel</button>
                    </div>
                  </form>
                )}

                {critRoles.length === 0 ? (
                  <EmptyState title="No critical roles defined"
                    body="Add your key positions to track succession pipelines and bench strength." />
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#f5f3ff' }}>
                          {['Role', 'Department', 'Current Holder', 'Risk', 'Candidates', 'Bench', 'Actions'].map(h => (
                            <th key={h} style={{ padding: '9px 12px', textAlign: 'left',
                                                 borderBottom: '1px solid #e9e4ff',
                                                 color: '#4c1d95', fontWeight: 600, whiteSpace: 'nowrap' }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {critRoles.map(r => (
                          <tr key={r.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                            <td style={{ padding: '9px 12px', fontWeight: 700, color: '#1f2937' }}>
                              {r.role_title}
                              {r.knowledge_domain && (
                                <div style={{ fontSize: 10, color: '#6B3FDB', fontWeight: 400, marginTop: 2 }}>
                                  {r.knowledge_domain}
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '9px 12px', color: '#6b7280' }}>{r.department || '—'}</td>
                            <td style={{ padding: '9px 12px' }}>
                              {r.current_holder_name
                                ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                                    {r.current_holder_name} <PhaseBadge phase={r.holder_phase} />
                                  </span>
                                : <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>Vacant</span>}
                            </td>
                            <td style={{ padding: '9px 12px' }}><RiskBadge level={r.risk_level} /></td>
                            <td style={{ padding: '9px 12px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                              {r.candidate_count > 0 ? (
                                <span style={{ fontWeight: 700, color: '#6B3FDB',
                                               background: '#ede9fe', borderRadius: 10,
                                               padding: '2px 8px', fontSize: 12 }}>
                                  {r.candidate_count}
                                </span>
                              ) : (
                                <span style={{ color: '#ef4444', fontSize: 12, fontWeight: 600 }}>0</span>
                              )}
                              {r.left_candidate_count > 0 && (
                                <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }} title="Candidates who have left are not counted">
                                  +{r.left_candidate_count} left
                                </div>
                              )}
                            </td>
                            <td style={{ padding: '9px 12px' }}>
                              <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                             background: r.has_ready_now ? '#d1fae5' : r.has_any_successor ? '#ede9fe' : '#fee2e2',
                                             color: r.has_ready_now ? '#16a34a' : r.has_any_successor ? '#6d28d9' : '#dc2626' }}>
                                {r.has_ready_now ? 'Ready Now' : r.has_any_successor ? 'Developing' : 'No Successor'}
                              </span>
                            </td>
                            <td style={{ padding: '9px 12px' }}>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <button type="button" onClick={() => {
                                    setSelRole(r);
                                    setShowCandForm(false);
                                    setCandForm(CAND_DEFAULT);
                                    loadCandidates(r.id);
                                  }}
                                  style={{ ...BTN('primary', true), fontSize: 11 }}>
                                  Successors
                                </button>
                                <button type="button" onClick={(e) => startEditRole(r, e)}
                                  style={{ ...BTN('outline', true), fontSize: 11 }}>
                                  Edit
                                </button>
                                <button type="button" onClick={(e) => { e.stopPropagation(); setPendingDeleteRole(r.id); }}
                                  style={{ ...BTN('danger-outline', true), fontSize: 11 }}>
                                  Delete
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Succession plan side drawer */}
                {selRole && (
                  <div style={drawerStyle(460)} role="dialog" aria-label={`${selRole.role_title} successors`}>
                    <button type="button" aria-label="Close" onClick={() => { setSelRole(null); setShowCandForm(false); setCandForm(CAND_DEFAULT); }}
                      style={{ position: 'absolute', top: 16, right: 16, background: 'none',
                               border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>
                      ×
                    </button>

                    <h3 style={{ margin: '0 0 4px', color: '#4c1d95', paddingRight: 32, fontSize: 17 }}>
                      {selRole.role_title}
                    </h3>
                    <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {selRole.department && <span>{selRole.department}</span>}
                      <RiskBadge level={selRole.risk_level} />
                    </div>
                    {selRole.knowledge_domain && (
                      <div style={{ fontSize: 12, color: '#6B3FDB', marginBottom: 8, fontWeight: 500 }}>
                        Domain: {selRole.knowledge_domain}
                      </div>
                    )}
                    {selRole.current_holder_name && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
                        Current: <strong style={{ color: '#1f2937' }}>{selRole.current_holder_name}</strong>
                        <PhaseBadge phase={selRole.holder_phase} />
                      </div>
                    )}
                    {selRole.expected_vacancy_date && (
                      <div style={{ fontSize: 12, color: '#6d28d9', marginBottom: 8 }}>
                        Expected vacancy: {fmtDate(selRole.expected_vacancy_date)}
                      </div>
                    )}
                    {selRole.reason && (
                      <div style={{ background: '#ede9fe', borderRadius: 8, padding: '8px 12px',
                                    marginBottom: 12, fontSize: 12, color: '#5b21b6' }}>
                        {selRole.reason}
                      </div>
                    )}
                    {selRole.vacancy_impact && (
                      <div style={{ background: '#fee2e2', borderRadius: 8, padding: '8px 12px',
                                    marginBottom: 16, fontSize: 12, color: '#991b1b' }}>
                        Impact if vacant: {selRole.vacancy_impact}
                      </div>
                    )}

                    {/* Candidates section */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <h4 style={{ color: '#4c1d95', margin: 0 }}>
                        Succession Pipeline
                        {candidates.length > 0 && (
                          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 12, color: '#6B3FDB' }}>
                            ({candidates.length})
                          </span>
                        )}
                      </h4>
                      {!showCandForm && (
                        <button type="button" onClick={() => setShowCandForm(true)} style={BTN('primary', true)}>
                          + Add Candidate
                        </button>
                      )}
                    </div>
                    <p style={{ margin: '0 0 12px', fontSize: 11, color: '#9ca3af' }}>
                      Readiness comes from each candidate&apos;s 9-box rating.
                    </p>

                    {/* Add candidate form */}
                    {showCandForm && (
                      <form onSubmit={addCandidate}
                        style={{ background: '#f5f3ff', borderRadius: 10, padding: 14,
                                 marginBottom: 16, border: '1px solid #e9e4ff' }}>
                        <div style={{ fontWeight: 600, color: '#4c1d95', fontSize: 13, marginBottom: 10 }}>
                          Add Succession Candidate
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          <div>
                            <label style={LBL} htmlFor="cd-emp">Employee *</label>
                            <select id="cd-emp" required value={candForm.candidate_employee_id}
                              onChange={e => setCandForm(f => ({ ...f, candidate_employee_id: e.target.value }))}
                              style={INP}>
                              <option value="">— Select employee —</option>
                              {candEmployees.map(emp => (
                                <option key={emp.id} value={emp.id}>{empLabel(emp)}</option>
                              ))}
                            </select>
                            {candForm.candidate_employee_id && (
                              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                                Readiness: <ReadyBadge level={pickedReadiness} />
                                {!pickedReadiness && <span>— rate them on the 9-Box Grid to set it</span>}
                              </div>
                            )}
                          </div>
                          <div>
                            <label style={LBL} htmlFor="cd-type">Successor Type</label>
                            <select id="cd-type" value={candForm.successor_type}
                              onChange={e => setCandForm(f => ({ ...f, successor_type: e.target.value, is_emergency_successor: e.target.value === 'emergency' }))}
                              style={INP}>
                              {SUCCESSOR_TYPES.map(t => (
                                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={LBL} htmlFor="cd-actions">Development Actions (one per line)</label>
                            <textarea id="cd-actions" value={candForm.development_actions}
                              onChange={e => setCandForm(f => ({ ...f, development_actions: e.target.value }))}
                              rows={3} placeholder={'e.g.\nShadow CFO for 6 months\nP&L ownership by Q3'}
                              style={{ ...INP, resize: 'vertical' }} />
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button type="submit" disabled={candLoading} style={BTN('primary', true)}>
                            {candLoading ? 'Adding...' : 'Add Candidate'}
                          </button>
                          <button type="button"
                            onClick={() => { setShowCandForm(false); setCandForm(CAND_DEFAULT); }}
                            style={BTN('ghost', true)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}

                    {/* Candidate list */}
                    {candidates.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '24px 0', color: '#9ca3af', fontSize: 13 }}>
                        No candidates yet. Click &quot;+ Add Candidate&quot; to build the pipeline.
                      </div>
                    ) : candidates.map((c, i) => (
                      <div key={c.id}
                        style={{ background: c.employment_phase === 'left' ? '#fef2f2' : c.is_emergency_successor ? '#fff7ed' : '#f5f3ff',
                                 borderRadius: 10, padding: 14, marginBottom: 10,
                                 border: `1px solid ${c.employment_phase === 'left' ? '#fecaca' : c.is_emergency_successor ? '#ddd6fe' : '#e9e4ff'}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between',
                                      alignItems: 'flex-start', marginBottom: 8, gap: 8 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, color: '#1f2937', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              {rankMedal(c.rank)} {c.candidate_name}
                              {c.is_emergency_successor && <Chip color="#5b21b6">Emergency</Chip>}
                              <PhaseBadge phase={c.employment_phase} />
                            </div>
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                              {c.designation}{c.designation && c.department ? ' · ' : ''}{c.department}
                              {c.successor_type && !c.is_emergency_successor ? ` · ${titleCase(c.successor_type)}` : ''}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                            <ReadyBadge level={c.readiness} />
                            <button type="button" aria-label={`Move ${c.candidate_name} up`} disabled={i === 0 || candLoading}
                              onClick={() => moveCandidate(i, -1)} style={{ ...BTN('ghost', true), padding: '2px 6px' }}>↑</button>
                            <button type="button" aria-label={`Move ${c.candidate_name} down`} disabled={i === candidates.length - 1 || candLoading}
                              onClick={() => moveCandidate(i, 1)} style={{ ...BTN('ghost', true), padding: '2px 6px' }}>↓</button>
                            <button type="button" onClick={() => setPendingRemoveCandidate({ candidateEmployeeId: c.candidate_employee_id, name: c.candidate_name })}
                              aria-label={`Remove ${c.candidate_name}`} title="Remove"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 16, padding: '0 4px' }}>
                              ×
                            </button>
                          </div>
                        </div>

                        {c.performance_score != null && (
                          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#6b7280', marginBottom: 6, flexWrap: 'wrap' }}>
                            <span>Perf: <strong style={{ color: '#16a34a' }}>{fmtScore(c.performance_score, 5)}</strong></span>
                            <span>Pot: <strong style={{ color: '#6B3FDB' }}>{c.potential_score}/5</strong></span>
                            {c.leadership_score && (
                              <span>Lead: <strong style={{ color: '#0891b2' }}>{c.leadership_score}/5</strong></span>
                            )}
                            {c.flight_risk && <RiskBadge level={c.flight_risk} />}
                          </div>
                        )}

                        {Array.isArray(c.development_actions) && c.development_actions.length > 0 && (
                          <div>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>
                              Dev Actions:
                            </div>
                            {c.development_actions.map((a, j) => (
                              <div key={j} style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 6, marginBottom: 3 }}>
                                <span style={{ color: '#6B3FDB' }}>-</span> {a}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ══════════════════ BENCH STRENGTH TAB ══════════════════ */}
            {tab === 'bench' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
                  <h3 style={{ color: '#4c1d95', margin: 0 }}>Bench Strength Dashboard</h3>
                  <button type="button" onClick={exportBenchCSV} style={BTN('outline', true)}>
                    Export CSV
                  </button>
                </div>

                {/* KPI row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
                              gap: 12, marginBottom: 24 }}>
                  {[
                    { label: 'Critical Roles',    value: dashData?.total_critical_roles || 0, color: '#4c1d95' },
                    { label: 'Ready Now',          value: dashData?.ready_now_count || 0,     color: '#16a34a' },
                    { label: 'No Successor',       value: dashData?.zero_successor_count || 0, color: '#dc2626' },
                    { label: 'Bench Strength',     value: `${benchPct}%`,                     color: benchPct >= 75 ? '#16a34a' : benchPct >= 40 ? '#6d28d9' : '#dc2626' },
                    { label: 'Active Dev Plans',   value: dashData?.development_summary?.active_plans || 0, color: '#0891b2' },
                    { label: 'Avg Plan Progress',  value: `${dashData?.development_summary?.avg_progress || 0}%`, color: '#6B3FDB' },
                  ].map(({ label, value, color }) => (
                    <div key={label} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16,
                                             border: '1px solid #e9e4ff', textAlign: 'center' }}>
                      <div style={{ fontSize: 26, fontWeight: 900, color }}>{value}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{label}</div>
                    </div>
                  ))}
                </div>
                <p style={{ margin: '-12px 0 20px', fontSize: 11, color: '#9ca3af' }}>
                  Counts include current employees only: anyone who has left is not counted.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
                              gap: 20, marginBottom: 28 }}>

                  {/* Overall bench strength donut */}
                  <div style={{ background: '#f5f3ff', borderRadius: 12, padding: 20,
                                border: '1px solid #e9e4ff', textAlign: 'center' }}>
                    <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 14 }}>
                      Bench Strength
                    </h4>
                    <div style={{ height: 160, position: 'relative' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={[{ value: benchPct || 0.01 }, { value: 100 - (benchPct || 0.01) }]}
                            cx="50%" cy="50%" innerRadius={50} outerRadius={70}
                            startAngle={90} endAngle={-270} dataKey="value">
                            <Cell fill={benchPct >= 75 ? '#16a34a' : benchPct >= 40 ? '#6d28d9' : '#6B3FDB'} />
                            <Cell fill="#e9e4ff" />
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ position: 'absolute', top: '50%', left: '50%',
                                    transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
                        <div style={{ fontSize: 28, fontWeight: 900,
                                      color: benchPct >= 75 ? '#16a34a' : benchPct >= 40 ? '#6d28d9' : '#6B3FDB' }}>
                          {benchPct}%
                        </div>
                        <div style={{ fontSize: 10, color: '#6b7280' }}>with a ready-now<br />successor</div>
                      </div>
                    </div>
                    {critRoles.length > 0 && (
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 8 }}>
                        {critRoles.filter(r => r.has_ready_now).length} of {critRoles.length} roles
                        have a ready-now successor
                      </div>
                    )}
                  </div>

                  {/* Flight risk pie */}
                  <div style={{ background: '#f5f3ff', borderRadius: 12, padding: 20, border: '1px solid #e9e4ff' }}>
                    <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 14 }}>
                      Flight Risk Distribution
                    </h4>
                    {!hasFlightData ? (
                      <div style={{ height: 160, display: 'flex', alignItems: 'center',
                                    justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                          Add talent assessments<br />to see flight risk data
                        </div>
                      </div>
                    ) : (
                      <div style={{ height: 160 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={flightData} cx="50%" cy="50%" outerRadius={65} dataKey="value"
                              label={({ name, value }) => value > 0 ? `${name}: ${value}` : ''}
                              labelLine={false}>
                              {flightData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i]} />)}
                            </Pie>
                            <Tooltip />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>

                  {/* Succession readiness bar */}
                  <div style={{ background: '#f5f3ff', borderRadius: 12, padding: 20, border: '1px solid #e9e4ff' }}>
                    <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 14 }}>
                      Successor Readiness
                    </h4>
                    {readyData.length === 0 ? (
                      <div style={{ height: 160, display: 'flex', alignItems: 'center',
                                    justifyContent: 'center', flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                          Add succession candidates<br />to see readiness breakdown
                        </div>
                      </div>
                    ) : (
                      <div style={{ height: 160 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={readyData} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                            <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                            <Tooltip />
                            <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                              {readyData.map((d) => <Cell key={d.key} fill={READY_BAR[d.key] || '#d1d5db'} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                </div>

                {/* Zero-successor roles alert list */}
                {(dashData?.zero_successor_roles || []).length > 0 && (
                  <div style={{ marginBottom: 28 }}>
                    <h4 style={{ color: '#dc2626', margin: '0 0 12px' }}>
                      Critical Roles With No Successor ({dashData.zero_successor_roles.length})
                    </h4>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {dashData.zero_successor_roles.map((r, i) => (
                        <div key={i} style={{ background: '#fee2e2', border: '1px solid #fca5a5',
                                             borderRadius: 8, padding: '8px 12px', fontSize: 12,
                                             display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                          <strong style={{ color: '#991b1b' }}>{r.role_title}</strong>
                          {r.department && <span style={{ color: '#6b7280' }}>{r.department}</span>}
                          <RiskBadge level={r.risk_level} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Top 10 high-potential */}
                <h4 style={{ color: '#4c1d95', margin: '0 0 12px' }}>
                  Top High-Potential Employees
                  <span style={{ fontWeight: 400, fontSize: 12, color: '#6b7280', marginLeft: 8 }}>
                    (potential &ge; {hipo.potential} and performance &ge; {hipo.performance}, from Settings)
                  </span>
                </h4>

                {(dashData?.top_high_potential || []).length === 0 ? (
                  <EmptyState title="No high-potential employees yet"
                    body={`Employees with potential ${hipo.potential}+ and performance ${hipo.performance}+ will appear here.`} />
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#f5f3ff' }}>
                          {['#', 'Name', 'Department', 'Designation', 'Perf', 'Potential', 'Leadership', 'Flight Risk', 'Readiness', 'Classification'].map(h => (
                            <th key={h} style={{ padding: '8px 12px', textAlign: 'left',
                                                 borderBottom: '1px solid #e9e4ff',
                                                 color: '#4c1d95', fontWeight: 600 }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(dashData.top_high_potential).map((emp, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                            <td style={{ padding: '8px 12px', fontWeight: 700,
                                         color: i < 3 ? '#6B3FDB' : '#6b7280' }}>
                              {i < 3 ? ['1st','2nd','3rd'][i] : i + 1}
                            </td>
                            <td style={{ padding: '8px 12px', fontWeight: 600 }}>{emp.name}</td>
                            <td style={{ padding: '8px 12px', color: '#6b7280' }}>{emp.department || '—'}</td>
                            <td style={{ padding: '8px 12px', color: '#6b7280' }}>{emp.designation || '—'}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 700, color: '#16a34a' }}>
                              {fmtScore(emp.performance_score, 5)}
                            </td>
                            <td style={{ padding: '8px 12px', fontWeight: 700, color: '#6B3FDB' }}>
                              {emp.potential_score}/5
                            </td>
                            <td style={{ padding: '8px 12px', color: '#0891b2' }}>
                              {emp.leadership_score ? `${emp.leadership_score}/5` : '—'}
                            </td>
                            <td style={{ padding: '8px 12px' }}>
                              <RiskBadge level={emp.flight_risk || 'low'} />
                            </td>
                            <td style={{ padding: '8px 12px' }}><ReadyBadge level={emp.readiness} /></td>
                            <td style={{ padding: '8px 12px' }}>
                              {emp.talent_classification
                                ? <Chip color="#1d4ed8">{emp.talent_classification}</Chip>
                                : <span style={{ color: '#9ca3af' }}>—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
