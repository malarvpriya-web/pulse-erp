// frontend/src/features/hr/pages/SuccessionPlanning.jsx
import React, { useState, useEffect, useCallback } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

/* ─── constants ─────────────────────────────────────────────── */

const NINE_BOX_META = {
  '1_3': { label: 'Question Marks',    color: '#f59e0b', bg: '#fffbeb', desc: 'High potential, low performance'    },
  '2_3': { label: 'Diamonds',          color: '#8b5cf6', bg: '#f5f3ff', desc: 'High potential, medium performance' },
  '3_3': { label: '★ Stars',            color: '#6B3FDB', bg: '#ede9fe', desc: 'High performance & high potential'  },
  '1_2': { label: 'Underperformers',   color: '#ef4444', bg: '#fef2f2', desc: 'Medium potential, low performance'  },
  '2_2': { label: 'Core Contributors', color: '#2563eb', bg: '#eff6ff', desc: 'Solid performance & potential'      },
  '3_2': { label: 'High Performers',   color: '#16a34a', bg: '#f0fdf4', desc: 'High performance, medium potential' },
  '1_1': { label: 'Deadwood',          color: '#6b7280', bg: '#f9fafb', desc: 'Low performance & potential'        },
  '2_1': { label: 'Inconsistent',      color: '#d97706', bg: '#fffbeb', desc: 'Low potential, medium performance'  },
  '3_1': { label: 'Workhorses',        color: '#0891b2', bg: '#ecfeff', desc: 'High performance, lower potential'  },
};
const PERF_LABELS  = { 1: 'Low', 2: 'Medium', 3: 'High' };
const RISK_COLORS  = { high: '#dc2626', medium: '#d97706', low: '#16a34a' };
const READY_LABELS = {
  'ready-now':  'Ready Now',
  '1-2-years':  '1–2 Years',
  '3-5-years':  '3–5 Years',
  'not_ready':  'Not Ready',
};
const READY_COLORS = {
  'ready-now': '#16a34a', '1-2-years': '#d97706',
  '3-5-years': '#6b7280', 'not_ready': '#ef4444',
};
const PIE_COLORS     = ['#16a34a', '#d97706', '#dc2626'];
const SUCCESSOR_TYPES = ['primary', 'secondary', 'tertiary', 'emergency'];
const MOBILITY_OPTS   = ['flexible', 'local_only', 'regional', 'international', 'remote_only'];
const TALENT_CLASS    = ['HiPo', 'Solid Performer', 'Emerging Talent', 'Specialist', 'Future Leader', 'At Risk'];

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
  candidate_employee_id: '', readiness_level: '1-2-years', development_actions: '',
  is_emergency_successor: false, successor_type: 'secondary',
};

/* ─── style tokens ──────────────────────────────────────────── */

const INP = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px',
  border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13,
};
const LBL = { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 };
const BTN = (variant = 'primary', small = false) => ({
  border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600,
  fontSize: small ? 12 : 13,
  padding: small ? '4px 10px' : '8px 18px',
  background: variant === 'primary'       ? '#6B3FDB'
             : variant === 'danger'       ? '#ef4444'
             : variant === 'ghost'        ? 'none'
             : variant === 'outline'      ? 'none'
             : variant === 'success'      ? '#16a34a'
             : '#e9e4ff',
  color: variant === 'primary'  ? '#fff'
       : variant === 'danger'   ? '#fff'
       : variant === 'ghost'    ? '#6b7280'
       : variant === 'outline'  ? '#6B3FDB'
       : variant === 'success'  ? '#fff'
       : '#6B3FDB',
  ...(variant === 'outline'       ? { border: '1px solid #6B3FDB' } : {}),
  ...(variant === 'danger-outline' ? { border: '1px solid #ef4444', background: 'none', color: '#ef4444' } : {}),
});

const tabStyle = (active) => ({
  padding: '8px 20px', border: 'none', cursor: 'pointer',
  borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14,
  background: active ? '#6B3FDB' : '#e9e4ff',
  color: active ? '#fff' : '#6B3FDB',
});

/* ─── responsive drawer style (fixes mobile overflow) ─────── */
const drawerStyle = (width = 440) => ({
  position: 'fixed', right: 0, top: 0, bottom: 0,
  width: `min(${width}px, 100vw)`,
  background: '#fff',
  boxShadow: '-4px 0 24px rgba(0,0,0,0.13)',
  zIndex: 999, overflowY: 'auto', padding: 24,
  boxSizing: 'border-box',
});

/* ─── tiny sub-components ───────────────────────────────────── */

const rankMedal = (rank) =>
  rank === 1 ? '1st' : rank === 2 ? '2nd' : rank === 3 ? '3rd' : `#${rank}`;

function Chip({ color, children }) {
  return (
    <span style={{ padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                   background: color + '20', color }}>
      {children}
    </span>
  );
}
function RiskBadge({ level }) {
  const c = RISK_COLORS[level] ?? '#6b7280';
  const label = level ? level.charAt(0).toUpperCase() + level.slice(1) : '—';
  return <Chip color={c}>{label} Risk</Chip>;
}
function ReadyBadge({ level }) {
  const c = READY_COLORS[level] ?? '#6b7280';
  return <Chip color={c}>{READY_LABELS[level] ?? level}</Chip>;
}

function EmployeeChip({ emp, onSelect }) {
  return (
    <div onClick={() => onSelect(emp)}
         title={`${emp.name}${emp.designation ? ' — ' + emp.designation : ''}`}
         style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px',
                  borderRadius: 20, background: '#fff', border: '1px solid #e9e4ff', cursor: 'pointer',
                  margin: '2px', fontSize: 12, fontWeight: 500,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.06)' }}>
      <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#ede9fe',
                     display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>
        U
      </span>
      {emp.name.split(' ')[0]}
      <span style={{ width: 8, height: 8, borderRadius: '50%',
                     background: RISK_COLORS[emp.flight_risk] ?? '#16a34a', flexShrink: 0 }} />
    </div>
  );
}

function EmptyState({ icon = '-', title, body }) {
  return (
    <div style={{ textAlign: 'center', padding: '44px 20px', color: '#9ca3af' }}>
      <div style={{ fontSize: 42, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 15, marginBottom: 6 }}>{title}</div>
      {body && <div style={{ fontSize: 13 }}>{body}</div>}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ textAlign: 'center', padding: 48 }}>
      <style>{`@keyframes _spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ display: 'inline-block', width: 36, height: 36,
                    border: '3px solid #e9e4ff', borderTopColor: '#6B3FDB',
                    borderRadius: '50%', animation: '_spin .75s linear infinite' }} />
    </div>
  );
}

function ScoreBar({ label, score, max = 5, color }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: '#6b7280' }}>{label}</span>
        <strong style={{ color }}>{score}/{max}</strong>
      </div>
      <div style={{ height: 6, background: '#f0ebff', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(score / max) * 100}%`, background: color, borderRadius: 4,
                      transition: 'width .4s' }} />
      </div>
    </div>
  );
}

function ScoreButtons({ value, onChange, max = 5, activeColor = '#6B3FDB' }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {Array.from({ length: max }, (_, i) => i + 1).map(v => (
        <button key={v} type="button" onClick={() => onChange(v)}
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

/* ─── CSV export helper ─────────────────────────────────────── */
function downloadCSV(data, filename) {
  if (!data.length) return;
  const headers = Object.keys(data[0]);
  const escape  = (v) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(escape).join(','),
               ...data.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
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
  const [employees, setEmployees]     = useState([]);
  const [deptList,  setDeptList]      = useState([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [loading, setLoading]         = useState(false);
  const [candLoading, setCandLoading] = useState(false);
  const [msg, setMsg]                 = useState({ text: '', type: '' });
  const [deptFilter, setDeptFilter]   = useState('');

  const [showAssessForm, setShowAssessForm] = useState(false);
  const [editAssessId, setEditAssessId]     = useState(null);
  const [assessForm, setAssessForm]         = useState(ASSESS_DEFAULT);

  const [showRoleForm, setShowRoleForm] = useState(false);
  const [editRoleId, setEditRoleId]     = useState(null);
  const [roleForm, setRoleForm]         = useState(ROLE_DEFAULT);

  const [showCandForm, setShowCandForm] = useState(false);
  const [candForm, setCandForm]         = useState(CAND_DEFAULT);

  const [pendingDeleteAssessment, setPendingDeleteAssessment] = useState(null);
  const [pendingDeleteRole,       setPendingDeleteRole]       = useState(null);
  const [pendingRemoveCandidate,  setPendingRemoveCandidate]  = useState(null);

  /* ── flash ── */
  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text: '', type: '' }), 3500);
  };

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
    setPageLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/employees?status=active').then(r => setEmployees(r.data || [])).catch(() => {});
    api.get('/admin/config/departments')
      .then(r => setDeptList(Array.isArray(r.data) ? r.data.map(d => d.name || d) : []))
      .catch(() => setDeptList([]));
  }, []);

  useEffect(() => { setSelRole(null); setSelEmp(null); }, [tab]);

  const loadCandidates = async (roleId) => {
    try {
      const r = await api.get(`/succession/critical-roles/${roleId}/candidates`);
      setCandidates(r.data || []);
    } catch { setCandidates([]); }
  };

  /* ── assessment CRUD ── */
  const submitAssessment = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        performance_score:    assessForm.performance_score,
        potential_score:      assessForm.potential_score,
        flight_risk:          assessForm.flight_risk,
        readiness:            assessForm.readiness,
        notes:                assessForm.notes,
        leadership_score:     assessForm.leadership_score || null,
        mobility:             assessForm.mobility,
        talent_classification: assessForm.talent_classification || null,
        assessment_period:    assessForm.assessment_period || null,
      };
      if (editAssessId) {
        await api.patch(`/succession/assessments/${editAssessId}`, payload);
        flash('Assessment updated');
      } else {
        await api.post('/succession/assessments', { ...payload, employee_id: assessForm.employee_id });
        flash('Assessment saved');
      }
      setShowAssessForm(false);
      setEditAssessId(null);
      setAssessForm(ASSESS_DEFAULT);
      setSelEmp(null);
      load();
    } catch (err) {
      flash(err.response?.data?.message || 'Failed to save', 'error');
    } finally { setLoading(false); }
  };

  const startEditAssessment = (emp) => {
    setAssessForm({
      employee_id:           emp.employee_id,
      performance_score:     emp.performance_score,
      potential_score:       emp.potential_score,
      flight_risk:           emp.flight_risk || 'low',
      readiness:             emp.readiness || '1-2-years',
      notes:                 emp.notes || '',
      leadership_score:      emp.leadership_score || 3,
      mobility:              emp.mobility || 'flexible',
      talent_classification: emp.talent_classification || '',
      assessment_period:     emp.assessment_period || '',
    });
    setEditAssessId(emp.id);
    setSelEmp(null);
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
      flash('Assessment deleted');
      setSelEmp(null);
      load();
    } catch (err) { flash(err.response?.data?.message || 'Failed to delete', 'error'); }
  };

  /* ── critical role CRUD ── */
  const submitRole = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        ...roleForm,
        current_holder_id:    roleForm.current_holder_id || null,
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
      flash(err.response?.data?.message || 'Failed to save', 'error');
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
    } catch (err) { flash(err.response?.data?.message || 'Failed to delete', 'error'); }
  };

  /* ── candidate management ── */
  const addCandidate = async (e) => {
    e.preventDefault();
    setCandLoading(true);
    try {
      const devActions = candForm.development_actions
        .split('\n').map(s => s.trim()).filter(Boolean);
      const updated = [
        ...candidates.map(c => ({
          candidate_employee_id: c.candidate_employee_id,
          rank:                  c.rank,
          readiness_level:       c.readiness_level,
          development_actions:   Array.isArray(c.development_actions) ? c.development_actions : [],
          is_emergency_successor: c.is_emergency_successor || false,
          successor_type:        c.successor_type || 'secondary',
        })),
        {
          candidate_employee_id: parseInt(candForm.candidate_employee_id),
          rank:                  candidates.length + 1,
          readiness_level:       candForm.readiness_level,
          development_actions:   devActions,
          is_emergency_successor: candForm.is_emergency_successor,
          successor_type:        candForm.is_emergency_successor ? 'emergency' : candForm.successor_type,
        },
      ];
      await api.put(`/succession/critical-roles/${selRole.id}/candidates`, { candidates: updated });
      await loadCandidates(selRole.id);
      setCandForm(CAND_DEFAULT);
      setShowCandForm(false);
      load();
      flash('Candidate added to succession plan');
    } catch (err) {
      flash(err.response?.data?.message || 'Failed to add candidate', 'error');
    } finally { setCandLoading(false); }
  };

  const removeCandidate = async () => {
    if (!pendingRemoveCandidate) return;
    const { candidateEmployeeId, name } = pendingRemoveCandidate;
    setPendingRemoveCandidate(null);
    setCandLoading(true);
    try {
      const updated = candidates
        .filter(c => c.candidate_employee_id !== candidateEmployeeId)
        .map((c, i) => ({
          candidate_employee_id: c.candidate_employee_id,
          rank:                  i + 1,
          readiness_level:       c.readiness_level,
          development_actions:   Array.isArray(c.development_actions) ? c.development_actions : [],
          is_emergency_successor: c.is_emergency_successor || false,
          successor_type:        c.successor_type || 'secondary',
        }));
      await api.put(`/succession/critical-roles/${selRole.id}/candidates`, { candidates: updated });
      await loadCandidates(selRole.id);
      load();
      flash('Candidate removed');
    } catch (err) {
      flash(err.response?.data?.message || 'Failed', 'error');
    } finally { setCandLoading(false); }
  };

  /* ── CSV export (bench strength tab) ── */
  const exportBenchCSV = async () => {
    try {
      const r = await api.get('/succession/reports/bench-strength');
      downloadCSV(r.data, 'bench_strength.csv');
    } catch { flash('Export failed', 'error'); }
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
  const readyData      = (dashData?.readiness_summary || []).map(r => ({
    name:  READY_LABELS[r.readiness] || r.readiness,
    count: parseInt(r.cnt) || 0,
  }));
  const benchPct       = dashData?.bench_strength_pct || 0;
  const addedCandIds   = new Set(candidates.map(c => c.candidate_employee_id));
  const candEmployees  = employees.filter(e => !addedCandIds.has(e.id));
  const editingEmployee = editAssessId
    ? employees.find(e => e.id === parseInt(assessForm.employee_id))
    : null;

  /* ────────────────────────────────────────────────────────── */
  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <ConfirmDialog
        open={!!pendingDeleteAssessment}
        title="Delete Assessment"
        message={pendingDeleteAssessment ? `Delete the talent assessment for ${pendingDeleteAssessment.name}? This cannot be undone.` : ''}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteAssessment}
        onCancel={() => setPendingDeleteAssessment(null)}
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

      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Succession Planning</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          9-box talent grid · critical role tracking · bench strength analytics
        </p>
      </div>

      {/* Flash message */}
      {msg.text && (
        <div style={{
          marginBottom: 12, padding: '10px 16px', borderRadius: 8,
          fontWeight: 500, fontSize: 14,
          background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      msg.type === 'error' ? '#dc2626' : '#16a34a',
          border:     `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
        }}>
          {msg.type === 'error' ? 'Error: ' : 'Done: '}{msg.text}
        </div>
      )}

      {/* Unread alerts banner */}
      {dashData?.unread_alerts > 0 && (
        <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8,
                      background: '#fff7ed', border: '1px solid #fed7aa',
                      color: '#c2410c', fontSize: 13, fontWeight: 500 }}>
          {dashData.unread_alerts} succession alert{dashData.unread_alerts > 1 ? 's' : ''} need attention
          {dashData.zero_successor_count > 0 &&
            ` — ${dashData.zero_successor_count} critical role${dashData.zero_successor_count > 1 ? 's' : ''} without any successor`}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }}>
        {[['ninebox', '9-Box Grid'], ['critical', 'Critical Roles'], ['bench', 'Bench Strength']].map(([k, l]) => (
          <button key={k} style={tabStyle(tab === k)} onClick={() => setTab(k)}>{l}</button>
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
                      {[['#16a34a','Low'],['#d97706','Medium'],['#dc2626','High']].map(([c, l]) => (
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
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {allDepts.length > 1 && (
                      <select value={deptFilter} onChange={e => setDeptFilter(e.target.value)}
                        style={{ ...INP, width: 'auto', padding: '6px 10px', fontSize: 12 }}>
                        <option value="">All Departments</option>
                        {allDepts.map(d => <option key={d} value={d}>{d}</option>)}
                      </select>
                    )}
                    <button style={BTN(showAssessForm ? 'secondary' : 'primary')}
                      onClick={() => { showAssessForm ? cancelAssessForm() : setShowAssessForm(true); }}>
                      {showAssessForm ? 'X Cancel' : '+ Add Assessment'}
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
                          <label style={LBL}>Employee</label>
                          <div style={{ ...INP, background: '#f9fafb', color: '#374151', fontWeight: 600 }}>
                            {editingEmployee?.name || '—'}
                            {editingEmployee?.designation ? ` — ${editingEmployee.designation}` : ''}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <label style={LBL}>Employee *</label>
                          <select required value={assessForm.employee_id}
                            onChange={e => setAssessForm(f => ({ ...f, employee_id: e.target.value }))}
                            style={INP}>
                            <option value="">— Select employee —</option>
                            {employees.map(emp => (
                              <option key={emp.id} value={emp.id}>
                                {emp.name}{emp.designation ? ' — ' + emp.designation : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {[['performance_score','Performance (1–5)','#16a34a'],
                        ['potential_score',  'Potential (1–5)',   '#6B3FDB'],
                        ['leadership_score', 'Leadership (1–5)',  '#0891b2']].map(([key, lbl, clr]) => (
                        <div key={key}>
                          <label style={LBL}>{lbl}</label>
                          <ScoreButtons value={assessForm[key]}
                            onChange={v => setAssessForm(f => ({ ...f, [key]: v }))}
                            activeColor={clr} />
                        </div>
                      ))}

                      <div>
                        <label style={LBL}>Flight Risk</label>
                        <select value={assessForm.flight_risk}
                          onChange={e => setAssessForm(f => ({ ...f, flight_risk: e.target.value }))}
                          style={INP}>
                          {['low', 'medium', 'high'].map(r => (
                            <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label style={LBL}>Succession Readiness</label>
                        <select value={assessForm.readiness}
                          onChange={e => setAssessForm(f => ({ ...f, readiness: e.target.value }))}
                          style={INP}>
                          {Object.entries(READY_LABELS).map(([v, l]) => (
                            <option key={v} value={v}>{l}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label style={LBL}>Mobility</label>
                        <select value={assessForm.mobility}
                          onChange={e => setAssessForm(f => ({ ...f, mobility: e.target.value }))}
                          style={INP}>
                          {MOBILITY_OPTS.map(m => (
                            <option key={m} value={m}>{m.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label style={LBL}>Talent Classification</label>
                        <select value={assessForm.talent_classification}
                          onChange={e => setAssessForm(f => ({ ...f, talent_classification: e.target.value }))}
                          style={INP}>
                          <option value="">— None —</option>
                          {TALENT_CLASS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>

                      <div>
                        <label style={LBL}>Assessment Period</label>
                        <input value={assessForm.assessment_period}
                          onChange={e => setAssessForm(f => ({ ...f, assessment_period: e.target.value }))}
                          placeholder="e.g. Q1 FY2026"
                          style={INP} />
                      </div>

                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL}>Notes</label>
                        <input value={assessForm.notes}
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
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
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
                                      <EmployeeChip key={emp.employee_id} emp={emp} onSelect={setSelEmp} />
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

                {totalAssessed === 0 && !showAssessForm && (
                  <EmptyState icon="-" title="No talent assessments yet"
                    body="Click '+ Add Assessment' to place your first employee on the 9-box grid." />
                )}

                {/* Employee detail side drawer — RESPONSIVE */}
                {selEmp && (
                  <div style={drawerStyle(360)}>
                    <button onClick={() => setSelEmp(null)}
                      style={{ position: 'absolute', top: 16, right: 16, background: 'none',
                               border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>
                      X
                    </button>

                    <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#ede9fe',
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 20, marginBottom: 12, fontWeight: 700, color: '#6B3FDB' }}>
                      {selEmp.name.charAt(0)}
                    </div>
                    <h3 style={{ margin: '0 0 2px', color: '#4c1d95', paddingRight: 30 }}>{selEmp.name}</h3>
                    <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 4 }}>
                      {selEmp.designation}{selEmp.designation && selEmp.department ? ' · ' : ''}{selEmp.department}
                    </div>

                    {(() => {
                      const perf = selEmp.performance_score <= 2 ? 1 : selEmp.performance_score <= 3 ? 2 : 3;
                      const pot  = selEmp.potential_score  <= 2 ? 1 : selEmp.potential_score  <= 3 ? 2 : 3;
                      const meta = NINE_BOX_META[`${perf}_${pot}`];
                      return meta ? (
                        <span style={{ display: 'inline-block', marginBottom: 16, padding: '3px 10px',
                                       borderRadius: 12, fontSize: 12, fontWeight: 600,
                                       background: meta.color + '20', color: meta.color }}>
                          {meta.label}
                        </span>
                      ) : null;
                    })()}

                    {selEmp.talent_classification && (
                      <span style={{ display: 'inline-block', marginBottom: 8, marginLeft: 6,
                                     padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600,
                                     background: '#dbeafe', color: '#1d4ed8' }}>
                        {selEmp.talent_classification}
                      </span>
                    )}

                    <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
                      <RiskBadge level={selEmp.flight_risk} />
                      <ReadyBadge level={selEmp.readiness} />
                      {selEmp.mobility && selEmp.mobility !== 'flexible' && (
                        <Chip color="#6b7280">{selEmp.mobility.replace(/_/g,' ')}</Chip>
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
                        "{selEmp.notes}"
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, flexDirection: 'column' }}>
                      <button onClick={() => startEditAssessment(selEmp)} style={BTN('outline')}>
                        Edit Assessment
                      </button>
                      <button onClick={() => setPendingDeleteAssessment(selEmp)}
                        style={{ ...BTN('danger-outline'), border: '1px solid #ef4444' }}>
                        Delete Assessment
                      </button>
                    </div>
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
                  <button style={BTN(showRoleForm ? 'secondary' : 'primary')}
                    onClick={() => { showRoleForm ? cancelRoleForm() : setShowRoleForm(true); }}>
                    {showRoleForm ? 'X Cancel' : '+ Add Critical Role'}
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
                        <label style={LBL}>Role / Position Title *</label>
                        <input required value={roleForm.role_title}
                          onChange={e => setRoleForm(f => ({ ...f, role_title: e.target.value }))}
                          placeholder="e.g. Chief Financial Officer"
                          style={INP} />
                      </div>
                      <div>
                        <label style={LBL}>Department</label>
                        <select value={roleForm.department}
                          onChange={e => setRoleForm(f => ({ ...f, department: e.target.value }))}
                          style={INP}>
                          <option value="">-- Select Department --</option>
                          {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </div>
                      <div>
                        <label style={LBL}>Current Holder</label>
                        <select value={roleForm.current_holder_id}
                          onChange={e => setRoleForm(f => ({ ...f, current_holder_id: e.target.value }))}
                          style={INP}>
                          <option value="">— None / Vacant —</option>
                          {employees.map(emp => (
                            <option key={emp.id} value={emp.id}>
                              {emp.name}{emp.designation ? ' — ' + emp.designation : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={LBL}>Risk Level</label>
                        <select value={roleForm.risk_level}
                          onChange={e => setRoleForm(f => ({ ...f, risk_level: e.target.value }))}
                          style={INP}>
                          {['high', 'medium', 'low'].map(r => (
                            <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label style={LBL}>Knowledge Domain</label>
                        <input value={roleForm.knowledge_domain}
                          onChange={e => setRoleForm(f => ({ ...f, knowledge_domain: e.target.value }))}
                          placeholder="e.g. HVDC Power Systems, DSP"
                          style={INP} />
                      </div>
                      <div>
                        <label style={LBL}>Expected Vacancy Date</label>
                        <input type="date" value={roleForm.expected_vacancy_date}
                          onChange={e => setRoleForm(f => ({ ...f, expected_vacancy_date: e.target.value }))}
                          style={INP} />
                      </div>
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL}>Reason / Business Impact</label>
                        <input value={roleForm.reason}
                          onChange={e => setRoleForm(f => ({ ...f, reason: e.target.value }))}
                          placeholder="Why is this role critical?"
                          style={INP} />
                      </div>
                      <div style={{ gridColumn: '1/-1' }}>
                        <label style={LBL}>Vacancy Impact</label>
                        <input value={roleForm.vacancy_impact}
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
                  <EmptyState icon="B" title="No critical roles defined"
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
                          <tr key={r.id} style={{ borderBottom: '1px solid #f0ebff', cursor: 'pointer' }}
                            onClick={() => {
                              setSelRole(r);
                              setShowCandForm(false);
                              setCandForm(CAND_DEFAULT);
                              loadCandidates(r.id);
                            }}>
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
                              {r.current_holder_name || <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>Vacant</span>}
                            </td>
                            <td style={{ padding: '9px 12px' }}><RiskBadge level={r.risk_level} /></td>
                            <td style={{ padding: '9px 12px', textAlign: 'center' }}>
                              {r.candidate_count > 0 ? (
                                <span style={{ fontWeight: 700, color: '#6B3FDB',
                                               background: '#ede9fe', borderRadius: 10,
                                               padding: '2px 8px', fontSize: 12 }}>
                                  {r.candidate_count}
                                </span>
                              ) : (
                                <span style={{ color: '#ef4444', fontSize: 12, fontWeight: 600 }}>0</span>
                              )}
                            </td>
                            <td style={{ padding: '9px 12px' }}>
                              <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                                             background: r.has_ready_now ? '#d1fae5' : r.has_any_successor ? '#fef3c7' : '#fee2e2',
                                             color: r.has_ready_now ? '#16a34a' : r.has_any_successor ? '#d97706' : '#dc2626' }}>
                                {r.has_ready_now ? 'Ready Now' : r.has_any_successor ? 'Developing' : 'No Successor'}
                              </span>
                            </td>
                            <td style={{ padding: '9px 12px' }}>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <button onClick={(e) => startEditRole(r, e)}
                                  style={{ ...BTN('outline', true), fontSize: 11 }}>
                                  Edit
                                </button>
                                <button onClick={(e) => { e.stopPropagation(); setPendingDeleteRole(r.id); }}
                                  style={{ padding: '4px 8px', border: '1px solid #ef444440', borderRadius: 5,
                                           cursor: 'pointer', fontSize: 11, fontWeight: 600,
                                           background: 'none', color: '#ef4444' }}>
                                  Delete
                                </button>
                                <span style={{ color: '#6B3FDB', fontSize: 12, fontWeight: 600 }}>View</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Succession plan side drawer — RESPONSIVE */}
                {selRole && (
                  <div style={drawerStyle(440)}>
                    <button onClick={() => { setSelRole(null); setShowCandForm(false); setCandForm(CAND_DEFAULT); }}
                      style={{ position: 'absolute', top: 16, right: 16, background: 'none',
                               border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280' }}>
                      X
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
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                        Current: <strong style={{ color: '#1f2937' }}>{selRole.current_holder_name}</strong>
                      </div>
                    )}
                    {selRole.expected_vacancy_date && (
                      <div style={{ fontSize: 12, color: '#d97706', marginBottom: 8 }}>
                        Expected vacancy: {new Date(selRole.expected_vacancy_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                      </div>
                    )}
                    {selRole.reason && (
                      <div style={{ background: '#fef3c7', borderRadius: 8, padding: '8px 12px',
                                    marginBottom: 12, fontSize: 12, color: '#92400e' }}>
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                      <h4 style={{ color: '#4c1d95', margin: 0 }}>
                        Succession Pipeline
                        {candidates.length > 0 && (
                          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 12, color: '#6B3FDB' }}>
                            ({candidates.length})
                          </span>
                        )}
                      </h4>
                      {!showCandForm && (
                        <button onClick={() => setShowCandForm(true)} style={BTN('primary', true)}>
                          + Add Candidate
                        </button>
                      )}
                    </div>

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
                            <label style={LBL}>Employee *</label>
                            <select required value={candForm.candidate_employee_id}
                              onChange={e => setCandForm(f => ({ ...f, candidate_employee_id: e.target.value }))}
                              style={INP}>
                              <option value="">— Select employee —</option>
                              {candEmployees.map(emp => (
                                <option key={emp.id} value={emp.id}>
                                  {emp.name}{emp.designation ? ' — ' + emp.designation : ''}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={LBL}>Readiness Level</label>
                            <select value={candForm.readiness_level}
                              onChange={e => setCandForm(f => ({ ...f, readiness_level: e.target.value }))}
                              style={INP}>
                              {Object.entries(READY_LABELS).map(([v, l]) => (
                                <option key={v} value={v}>{l}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label style={LBL}>Successor Type</label>
                            <select value={candForm.successor_type}
                              onChange={e => setCandForm(f => ({ ...f, successor_type: e.target.value, is_emergency_successor: e.target.value === 'emergency' }))}
                              style={INP}>
                              {SUCCESSOR_TYPES.map(t => (
                                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                              ))}
                            </select>
                          </div>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                                          fontSize: 13, color: '#4c1d95', fontWeight: 500 }}>
                            <input type="checkbox" checked={candForm.is_emergency_successor}
                              onChange={e => setCandForm(f => ({
                                ...f,
                                is_emergency_successor: e.target.checked,
                                successor_type: e.target.checked ? 'emergency' : (f.successor_type === 'emergency' ? 'secondary' : f.successor_type),
                              }))} />
                            Emergency Successor
                          </label>
                          <div>
                            <label style={LBL}>Development Actions (one per line)</label>
                            <textarea value={candForm.development_actions}
                              onChange={e => setCandForm(f => ({ ...f, development_actions: e.target.value }))}
                              rows={3} placeholder="e.g.&#10;Shadow CFO for 6 months&#10;P&L ownership by Q3"
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
                        No candidates yet. Click "+ Add Candidate" to build the pipeline.
                      </div>
                    ) : candidates.map(c => (
                      <div key={c.id}
                        style={{ background: c.is_emergency_successor ? '#fff7ed' : '#f5f3ff',
                                 borderRadius: 10, padding: 14, marginBottom: 10,
                                 border: `1px solid ${c.is_emergency_successor ? '#fed7aa' : '#e9e4ff'}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between',
                                      alignItems: 'flex-start', marginBottom: 8 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 13, color: '#1f2937' }}>
                              {rankMedal(c.rank)} {c.candidate_name}
                              {c.is_emergency_successor && (
                                <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600,
                                               background: '#fed7aa', color: '#c2410c',
                                               padding: '1px 6px', borderRadius: 8 }}>
                                  EMERGENCY
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                              {c.designation}{c.designation && c.department ? ' · ' : ''}{c.department}
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            <ReadyBadge level={c.readiness_level} />
                            <button onClick={() => setPendingRemoveCandidate({ candidateEmployeeId: c.candidate_employee_id, name: c.candidate_name })}
                              title="Remove" style={{ background: 'none', border: 'none', cursor: 'pointer',
                                                      color: '#9ca3af', fontSize: 16, padding: '0 4px' }}>
                              X
                            </button>
                          </div>
                        </div>

                        {c.performance_score && (
                          <div style={{ display: 'flex', gap: 10, fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
                            <span>Perf: <strong style={{ color: '#16a34a' }}>{c.performance_score}/5</strong></span>
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
                            {c.development_actions.map((a, i) => (
                              <div key={i} style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 6, marginBottom: 3 }}>
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
                {/* Header with export */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              marginBottom: 20, flexWrap: 'wrap', gap: 8 }}>
                  <h3 style={{ color: '#4c1d95', margin: 0 }}>Bench Strength Dashboard</h3>
                  <button onClick={exportBenchCSV} style={BTN('outline', true)}>
                    Export CSV
                  </button>
                </div>

                {/* KPI row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))',
                              gap: 12, marginBottom: 24 }}>
                  {[
                    { label: 'Critical Roles',    value: dashData?.total_critical_roles || 0, color: '#4c1d95' },
                    { label: 'Ready Now',          value: dashData?.ready_now_count || 0,     color: '#16a34a' },
                    { label: 'No Successor',       value: dashData?.zero_successor_count || 0, color: '#dc2626' },
                    { label: 'Bench Strength',     value: `${benchPct}%`,                     color: benchPct >= 75 ? '#16a34a' : benchPct >= 40 ? '#d97706' : '#dc2626' },
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
                            <Cell fill={benchPct >= 75 ? '#16a34a' : benchPct >= 40 ? '#d97706' : '#6B3FDB'} />
                            <Cell fill="#e9e4ff" />
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                      <div style={{ position: 'absolute', top: '50%', left: '50%',
                                    transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
                        <div style={{ fontSize: 28, fontWeight: 900,
                                      color: benchPct >= 75 ? '#16a34a' : benchPct >= 40 ? '#d97706' : '#6B3FDB' }}>
                          {benchPct}%
                        </div>
                        <div style={{ fontSize: 10, color: '#6b7280' }}>critical roles<br />covered</div>
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
                      Succession Readiness
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
                              {readyData.map((_, i) => (
                                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                              ))}
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
                                             borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                          <strong style={{ color: '#991b1b' }}>{r.role_title}</strong>
                          {r.department && <span style={{ color: '#6b7280', marginLeft: 6 }}>{r.department}</span>}
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
                    (potential score &ge; 4)
                  </span>
                </h4>

                {(dashData?.top_high_potential || []).length === 0 ? (
                  <EmptyState icon="-" title="No high-potential employees yet"
                    body="Employees with a potential score of 4 or 5 will appear here." />
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#f5f3ff' }}>
                          {['#', 'Name', 'Department', 'Designation', 'Perf', 'Potential', 'Leadership', 'Flight Risk', 'Classification'].map(h => (
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
                            <td style={{ padding: '8px 12px', color: '#6b7280' }}>{emp.department}</td>
                            <td style={{ padding: '8px 12px', color: '#6b7280' }}>{emp.designation}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 700, color: '#16a34a' }}>
                              {emp.performance_score}/5
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
                            <td style={{ padding: '8px 12px' }}>
                              {emp.talent_classification
                                ? <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px',
                                                  background: '#dbeafe', color: '#1d4ed8', borderRadius: 8 }}>
                                    {emp.talent_classification}
                                  </span>
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
