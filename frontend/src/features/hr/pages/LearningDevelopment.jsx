// frontend/src/features/hr/pages/LearningDevelopment.jsx
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { TrendingUp, PieChart as PieChartIcon } from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import api from '@/services/api/client';

function EmptyState({ icon: Icon, title, sub }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '32px 16px', textAlign: 'center', gap: 8,
      background: 'var(--color-background-secondary)',
      borderRadius: 'var(--border-radius-lg)',
      border: '0.5px solid var(--color-border-tertiary)',
      height: '100%', justifyContent: 'center',
    }}>
      {Icon && <Icon size={28} style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }} />}
      <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>{sub}</p>}
    </div>
  );
}

/* ─── helpers ─────────────────────────────────────────────────── */
function fmtINR(n) {
  const v = parseFloat(n) || 0;
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const PROF_COLORS = { 1:'#dc2626', 2:'#f97316', 3:'#eab308', 4:'#86efac', 5:'#16a34a' };
const PROF_LABELS = { 1:'Beginner', 2:'Basic', 3:'Intermediate', 4:'Advanced', 5:'Expert' };
const PIE_COLORS  = ['#6B3FDB','#2563eb','#16a34a','#d97706','#dc2626'];

const SKILL_NAMES = ['Microsoft Excel','Python','SQL','Leadership','Communication','Project Management','Data Analysis','GST Knowledge','Quality Management'];

const STATUS_COLORS = { planned:'#6B3FDB', ongoing:'#2563eb', completed:'#16a34a', cancelled:'#dc2626' };
const MODE_COLORS   = { online:'#0891b2', offline:'#6B3FDB', hybrid:'#d97706' };

function tabStyle(active) {
  return { padding: '8px 20px', border: 'none', cursor: 'pointer', borderRadius: '6px 6px 0 0', fontWeight: 600, fontSize: 14, background: active ? '#6B3FDB' : '#e9e4ff', color: active ? '#fff' : '#6B3FDB' };
}

/* ─── Mini Calendar ────────────────────────────────────────────── */
function TrainingCalendar({ programs, onEnroll, onComplete }) {
  const [viewDate, setViewDate] = useState(new Date());
  const [selected, setSelected] = useState(null);

  const year  = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = []; for (let i = 0; i < firstDay; i++) cells.push(null); for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const programsByDate = {};
  programs.forEach(p => {
    if (!p.scheduled_date) return;
    const d = new Date(p.scheduled_date);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const key = d.getDate();
      if (!programsByDate[key]) programsByDate[key] = [];
      programsByDate[key].push(p);
    }
  });

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 16, alignItems: 'start' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <button onClick={() => setViewDate(new Date(year, month - 1, 1))} style={{ background: '#e9e4ff', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 700, color: '#6B3FDB' }}>‹</button>
          <span style={{ fontWeight: 700, fontSize: 15, color: '#4c1d95', minWidth: 140, textAlign: 'center' }}>{MONTHS[month]} {year}</span>
          <button onClick={() => setViewDate(new Date(year, month + 1, 1))} style={{ background: '#e9e4ff', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 700, color: '#6B3FDB' }}>›</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
          {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
            <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#6B3FDB', padding: '4px 0' }}>{d}</div>
          ))}
          {cells.map((d, i) => {
            const progs = d ? (programsByDate[d] || []) : [];
            return (
              <div key={i} onClick={() => d && progs.length && setSelected(progs[0])}
                style={{ minHeight: 56, padding: 4, borderRadius: 6, background: d ? (progs.length ? '#ede9fe' : '#fafafa') : 'transparent',
                  border: d ? '1px solid #e9e4ff' : 'none', cursor: progs.length ? 'pointer' : 'default' }}>
                {d && <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 2 }}>{d}</div>}
                {progs.slice(0, 2).map(p => (
                  <div key={p.id} style={{ fontSize: 10, background: STATUS_COLORS[p.status] + '20', color: STATUS_COLORS[p.status], borderRadius: 3, padding: '1px 4px', marginBottom: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.title.split(' ').slice(0, 2).join(' ')}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* detail drawer */}
      {selected && (
        <div style={{ background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 10, padding: 16, minWidth: 260, maxWidth: 300 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <h4 style={{ margin: 0, color: '#4c1d95', fontSize: 14 }}>{selected.title}</h4>
            <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 16 }}>✕</button>
          </div>
          {[
            ['Category',   selected.category],
            ['Trainer',    selected.trainer],
            ['Mode',       selected.mode],
            ['Duration',   `${selected.duration_hours}h`],
            ['Date',       selected.scheduled_date],
            ['Enrolled',   `${selected.enrolled_count} / ${selected.max_participants}`],
            ['Status',     selected.status],
            ['Cost/pax',   fmtINR(selected.cost_per_participant)],
          ].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: '#6b7280' }}>{k}:</span>
              <span style={{ fontWeight: 600, color: '#374151' }}>{v}</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
            <button onClick={() => onEnroll && onEnroll(selected)} style={{ flex: 1, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 0', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Enroll</button>
            {selected.status === 'ongoing' && <button onClick={() => onComplete && onComplete(selected)} style={{ flex: 1, background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 0', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Complete</button>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Skill Matrix Heatmap ─────────────────────────────────────── */
function SkillMatrixHeatmap({ data, employees, skills, gaps }) {
  const toast = useToast();
  const [editCell, setEditCell] = useState(null);
  const [hoveredCell, setHoveredCell] = useState(null);

  const getProficiency = (empId, skill) => {
    const row = data.find(r => r.employee_id === empId && r.skill_name === skill);
    return row?.proficiency_level || 0;
  };

  return (
    <div>
      <div style={{ overflowX: 'auto', marginBottom: 24 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ padding: '8px 12px', textAlign: 'left', color: '#4c1d95', fontWeight: 700, whiteSpace: 'nowrap', background: '#f5f3ff', borderBottom: '2px solid #e9e4ff' }}>Employee</th>
              {skills.map(s => (
                <th key={s} style={{ padding: '8px 8px', textAlign: 'center', color: '#4c1d95', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap', background: '#f5f3ff', borderBottom: '2px solid #e9e4ff', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {employees.map(emp => (
              <tr key={emp.employee_id} style={{ borderBottom: '1px solid #f0ebff' }}>
                <td style={{ padding: '6px 12px', fontWeight: 600, whiteSpace: 'nowrap', color: '#374151', background: '#fff' }}>
                  <div>{emp.employee_name}</div>
                  <div style={{ fontSize: 10, color: '#9ca3af' }}>{emp.department}</div>
                </td>
                {skills.map(skill => {
                  const prof = getProficiency(emp.employee_id, skill);
                  const isHovered = hoveredCell?.emp === emp.employee_id && hoveredCell?.skill === skill;
                  return (
                    <td key={skill} style={{ padding: 4, textAlign: 'center', position: 'relative' }}>
                      <div
                        onMouseEnter={() => setHoveredCell({ emp: emp.employee_id, skill })}
                        onMouseLeave={() => setHoveredCell(null)}
                        onClick={() => setEditCell({ empId: emp.employee_id, empName: emp.employee_name, skill, current: prof })}
                        style={{ width: 36, height: 36, margin: '0 auto', borderRadius: 6, cursor: 'pointer',
                          background: prof ? PROF_COLORS[prof] + (isHovered ? 'ff' : 'cc') : '#e5e7eb',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 13, fontWeight: 700, color: prof >= 4 ? '#fff' : (prof >= 2 ? '#1f2937' : '#fff'),
                          border: isHovered ? `2px solid #6B3FDB` : '2px solid transparent' }}>
                        {prof || '—'}
                      </div>
                      {isHovered && prof > 0 && (
                        <div style={{ position: 'absolute', bottom: 40, left: '50%', transform: 'translateX(-50%)', background: '#1f2937', color: '#fff', borderRadius: 6, padding: '4px 8px', fontSize: 11, whiteSpace: 'nowrap', zIndex: 100 }}>
                          {PROF_LABELS[prof]}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* legend */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {[1,2,3,4,5].map(p => (
          <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <div style={{ width: 16, height: 16, borderRadius: 3, background: PROF_COLORS[p] }} />
            <span>{p} — {PROF_LABELS[p]}</span>
          </div>
        ))}
      </div>

      {/* skill gap chart */}
      <h4 style={{ color: '#4c1d95', margin: '0 0 12px' }}>Skill Gap Analysis (Team Avg Proficiency)</h4>
      <div style={{ height: 220 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={gaps} layout="vertical" margin={{ left: 120, right: 20, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
            <XAxis type="number" domain={[0, 5]} tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="skill" tick={{ fontSize: 11 }} width={120} />
            <Tooltip formatter={(v) => [v, 'Avg Proficiency']} />
            <Bar dataKey="avg_proficiency" radius={[0,4,4,0]} name="Avg Proficiency">
              {gaps.map((g, i) => <Cell key={i} fill={g.gap ? '#dc2626' : '#16a34a'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* edit proficiency modal */}
      {editCell && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 340 }}>
            <h3 style={{ color: '#4c1d95', margin: '0 0 12px' }}>Update Proficiency</h3>
            <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}><strong>{editCell.empName}</strong> — {editCell.skill}</p>
            <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
              {[1,2,3,4,5].map(p => (
                <div key={p} onClick={() => setEditCell(ec => ({ ...ec, newVal: p }))}
                  style={{ flex: 1, height: 40, borderRadius: 8, background: PROF_COLORS[p], cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700, color: '#fff',
                    outline: editCell.newVal === p ? '3px solid #6B3FDB' : 'none' }}>
                  {p}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', marginBottom: 16 }}>
              {editCell.newVal ? PROF_LABELS[editCell.newVal] : 'Select proficiency level'}
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={async () => {
                if (!editCell.newVal) return;
                try {
                  await api.post('/training/skills', { employee_id: editCell.empId, skill_name: editCell.skill, proficiency_level: editCell.newVal });
                  setEditCell(null);
                } catch(e) {
                  toast.error(e?.response?.data?.error || e?.message || 'Failed to update skill proficiency');
                }
              }} style={{ flex: 1, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 0', cursor: 'pointer', fontWeight: 600 }}>Update</button>
              <button onClick={() => setEditCell(null)} style={{ flex: 1, background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '8px 0', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── main component ───────────────────────────────────────────── */
export default function LearningDevelopment() {
  const { user } = useAuth();
  const [tab, setTab]               = useState('calendar');
  const [programs, setPrograms]     = useState([]);
  const [matrixData, setMatrixData] = useState([]);
  const [matrixEmployees, setMatrixEmps] = useState([]);
  const [skillGaps, setSkillGaps]   = useState([]);
  const [dashboard, setDashboard]   = useState({ trainings_this_month: 0, completion_rate_pct: 0, total_training_cost: 0, employees_trained: 0, skill_gap_count: 0, mandatory_pending: 0, certs_expiring_30d: 0 });
  const [showProgForm, setShowProgForm] = useState(false);
  const [progForm, setProgForm]     = useState({ title:'', category:'Technical', trainer:'', mode:'offline', duration_hours:'8', cost_per_participant:'0', max_participants:'30', scheduled_date:'' });
  const [selEmpId, setSelEmpId]     = useState('1');
  const [empHistory, setEmpHistory] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [costMonthly, setCostMonthly] = useState([]);
  const [costByType, setCostByType]   = useState([]);
  const [msg, setMsg]               = useState({ text:'', type:'' });

  const flash = (text, type = 'success') => { setMsg({ text, type }); setTimeout(() => setMsg({ text:'', type:'' }), 3500); };

  const load = useCallback(async () => {

    const [pRes, mRes, dRes, cmRes, ctRes] = await Promise.allSettled([
      api.get('/training/programs'),
      api.get('/training/skills/matrix'),
      api.get('/training/dashboard'),
      api.get('/training/cost-trend'),
      api.get('/training/cost-by-type'),
    ]);
    if (pRes.status === 'fulfilled' && pRes.value.data?.length) setPrograms(pRes.value.data);
    if (mRes.status === 'fulfilled') {
      const m = mRes.value.data;
      if (m.employees?.length)  setMatrixEmps(m.employees);
      if (m.gaps?.length)       setSkillGaps(m.gaps);
      const flatData = [];
      if (m.employees && m.skills) {
        m.employees.forEach(emp => { m.skills.forEach(skill => { flatData.push({ employee_id: emp.employee_id, employee_name: emp.employee_name, department: emp.department, skill_name: skill, proficiency_level: emp.skills[skill]?.proficiency || 0 }); }); });
      }
      if (flatData.length) setMatrixData(flatData);
    }
    if (dRes.status === 'fulfilled') setDashboard(dRes.value.data);
    if (cmRes.status === 'fulfilled' && Array.isArray(cmRes.value.data)) setCostMonthly(cmRes.value.data);
    if (ctRes.status === 'fulfilled' && Array.isArray(ctRes.value.data)) setCostByType(ctRes.value.data);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadEmpHistory = async (empId) => {
    try {
      const r = await api.get(`/training/employee/${empId}/history`);
      setEmpHistory(r.data || []);
    } catch { setEmpHistory([]); }
  };
  useEffect(() => { if (tab === 'tracker') loadEmpHistory(selEmpId); }, [tab, selEmpId]);

  const saveProgram = async (e) => {
    e.preventDefault();

    try {
      await api.post('/training/programs', progForm);
      flash('Training program scheduled'); setShowProgForm(false); load();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); }
    finally { setLoading(false); }
  };

  const handleEnroll = async (program) => {
    const empId = user?.employee_id;
    if (!empId) { flash('No employee profile linked to your account', 'error'); return; }
    try {
      const res = await api.post(`/training/programs/${program.id}/enroll`, { employee_ids: [empId] });
      flash(`Enrolled in "${program.title}" — ${res.data?.message || ''}`);
      load();
    } catch (err) { flash(err.response?.data?.error || 'Enrollment failed', 'error'); }
  };

  const handleComplete = async (program) => {
    try {
      const detail = await api.get(`/training/programs/${program.id}`);
      const empId = user?.employee_id;
      const enrollment = detail.data?.enrollments?.find(e => e.employee_id === empId);
      if (!enrollment) { flash('No enrollment found for your account', 'error'); return; }
      await api.put(`/training/enrollments/${enrollment.id}/complete`);
      flash(`"${program.title}" marked as complete`);
      load();
    } catch (err) { flash(err.response?.data?.error || 'Could not mark complete', 'error'); }
  };

  const completionData = [{ name: 'Completed', value: Math.round(dashboard.completion_rate_pct) }, { name: 'Pending', value: 100 - Math.round(dashboard.completion_rate_pct) }];
  const costByProgram  = programs.slice(0, 5).map(p => ({ name: p.title.split(' ').slice(0, 3).join(' '), cost: parseFloat(p.total_cost) || 0 }));
  const allSkills      = [...new Set(matrixData.map(r => r.skill_name))].sort();

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>🎓 Learning & Development</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Training programs, skill matrix, certifications and cost analytics</p>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label:'Trainings This Month', value: dashboard.trainings_this_month, icon:'📅', color:'#6B3FDB' },
          { label:'Completion Rate',      value: `${dashboard.completion_rate_pct}%`, icon:'✅', color:'#16a34a' },
          { label:'Total Training Cost',  value: fmtINR(dashboard.total_training_cost), icon:'💰', color:'#d97706' },
          { label:'Employees Trained',    value: dashboard.employees_trained, icon:'👥', color:'#2563eb' },
          { label:'Skill Gaps (avg<3)',   value: dashboard.skill_gap_count, icon:'⚠️', color:'#dc2626' },
          { label:'Mandatory Pending',    value: dashboard.mandatory_pending, icon:'🔴', color:'#dc2626' },
          { label:'Certs Expiring 30d',   value: dashboard.certs_expiring_30d, icon:'📋', color:'#f97316' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 20 }}>{k.icon}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: k.color, marginTop: 4 }}>{k.value}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {msg.text && <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>}

      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }}>
        {[['calendar','Training Calendar'],['matrix','Skill Matrix'],['tracker','Course Tracker'],['costs','Training Costs']].map(([k,l]) => (
          <button key={k} style={tabStyle(tab===k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: 20 }}>

        {/* ── CALENDAR TAB ── */}
        {tab === 'calendar' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ margin: 0, color: '#4c1d95' }}>Training Schedule</h3>
              <button onClick={() => setShowProgForm(f => !f)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontWeight: 600 }}>
                {showProgForm ? '✕ Cancel' : '+ Schedule Training'}
              </button>
            </div>

            {showProgForm && (
              <form onSubmit={saveProgram} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 20, border: '1px solid #e9e4ff' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                  <div style={{ gridColumn: '1/-1' }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Training Title *</label>
                    <input value={progForm.title} required onChange={e => setProgForm(f => ({ ...f, title: e.target.value }))}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  {[['category','Category',['Technical','Soft Skills','Compliance','Safety','Leadership','Other']],
                    ['mode','Mode',['online','offline','hybrid']],
                  ].map(([key, label, opts]) => (
                    <div key={key}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>{label}</label>
                      <select value={progForm[key]} onChange={e => setProgForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                        {opts.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </div>
                  ))}
                  {[['trainer','Trainer Name','text'],['duration_hours','Duration (hrs)','number'],['cost_per_participant','Cost/participant (₹)','number'],['max_participants','Max Participants','number'],['scheduled_date','Scheduled Date','date']].map(([key, label, type]) => (
                    <div key={key}>
                      <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>{label}</label>
                      <input type={type} value={progForm[key]} onChange={e => setProgForm(f => ({ ...f, [key]: e.target.value }))}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                    </div>
                  ))}
                </div>
                <button type="submit" disabled={loading} style={{ marginTop: 14, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                  {loading ? 'Saving…' : 'Schedule Training'}
                </button>
              </form>
            )}

            <TrainingCalendar programs={programs} onEnroll={handleEnroll} onComplete={handleComplete} />

            {/* list below calendar */}
            <div style={{ marginTop: 24 }}>
              <h4 style={{ color: '#4c1d95', margin: '0 0 12px' }}>All Programs</h4>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: '#f5f3ff' }}>
                  {['Title','Category','Trainer','Mode','Date','Enrolled','Status'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {programs.map(p => (
                    <tr key={p.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 600 }}>{p.title}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280' }}>{p.category}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280' }}>{p.trainer}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: MODE_COLORS[p.mode] + '20', color: MODE_COLORS[p.mode] }}>{p.mode}</span>
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{p.scheduled_date}</td>
                      <td style={{ padding: '8px 12px' }}>{p.enrolled_count}/{p.max_participants}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: STATUS_COLORS[p.status] + '20', color: STATUS_COLORS[p.status] }}>{p.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── SKILL MATRIX TAB ── */}
        {tab === 'matrix' && (
          <div>
            <h3 style={{ color: '#4c1d95', margin: '0 0 16px' }}>Team Skill Heatmap</h3>
            <SkillMatrixHeatmap data={matrixData} employees={matrixEmployees} skills={allSkills} gaps={skillGaps} />
          </div>
        )}

        {/* ── COURSE TRACKER TAB ── */}
        {tab === 'tracker' && (
          <div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' }}>
              <div>
                <label style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 }}>Select Employee</label>
                <select value={selEmpId} onChange={e => { setSelEmpId(e.target.value); loadEmpHistory(e.target.value); }}
                  style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, minWidth: 200 }}>
                  {matrixEmployees.map(e => <option key={e.employee_id} value={e.employee_id}>{e.employee_name}</option>)}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, alignItems: 'start' }}>
              <div>
                {empHistory.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No training history found. API may be unavailable.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {empHistory.map(h => (
                      <div key={h.id} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, border: '1px solid #e9e4ff' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                          <div>
                            <div style={{ fontWeight: 700, color: '#1f2937', fontSize: 14 }}>{h.title}</div>
                            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{h.category} · {h.mode} · {h.duration_hours}h</div>
                          </div>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: STATUS_COLORS[h.status] + '20', color: STATUS_COLORS[h.status] }}>{h.status}</span>
                        </div>
                        {h.status === 'completed' && (
                          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#6b7280' }}>
                            <span>Completed: <strong>{h.completion_date}</strong></span>
                            {h.score && <span>Score: <strong style={{ color: '#6B3FDB' }}>{h.score}%</strong></span>}
                            {h.feedback_rating && <span>Rating: <strong>{'⭐'.repeat(h.feedback_rating)}</strong></span>}
                            {h.certificate_url && <a href={h.certificate_url} target="_blank" rel="noreferrer" style={{ color: '#6B3FDB', fontWeight: 600 }}>📜 Certificate</a>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* donut completion rate */}
              <div style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, border: '1px solid #e9e4ff', minWidth: 200 }}>
                <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 13 }}>Completion Rate</h4>
                <div style={{ height: 160 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={completionData} cx="50%" cy="50%" innerRadius={45} outerRadius={70} dataKey="value">
                        <Cell fill="#6B3FDB" />
                        <Cell fill="#e9e4ff" />
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div style={{ textAlign: 'center', fontSize: 20, fontWeight: 800, color: '#6B3FDB' }}>{dashboard.completion_rate_pct}%</div>
                <div style={{ textAlign: 'center', fontSize: 12, color: '#6b7280' }}>Overall Completion</div>
              </div>
            </div>
          </div>
        )}

        {/* ── COSTS TAB ── */}
        {tab === 'costs' && (
          <div>
            <h3 style={{ color: '#4c1d95', margin: '0 0 20px' }}>Training Cost Analytics</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
              <div style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, border: '1px solid #e9e4ff' }}>
                <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 14 }}>Cost by Program (₹)</h4>
                <div style={{ height: 200 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={costByProgram} margin={{ top: 4, right: 12, left: 0, bottom: 40 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                      <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₹${(v/1000).toFixed(0)}K`} />
                      <Tooltip formatter={v => [fmtINR(v), 'Cost']} />
                      <Bar dataKey="cost" fill="#6B3FDB" radius={[4,4,0,0]} name="Total Cost" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, border: '1px solid #e9e4ff' }}>
                <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 14 }}>Cost by Type</h4>
                <div style={{ height: 200 }}>
                  {costByType.length === 0 ? (
                    <EmptyState icon={PieChartIcon} title="No cost breakdown" sub="Training costs will appear here" />
                  ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={costByType} cx="50%" cy="50%" outerRadius={75} dataKey="value" label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={false}>
                        {costByType.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={v => [fmtINR(v), '']} />
                    </PieChart>
                  </ResponsiveContainer>
                  )}
                </div>
              </div>
            </div>
            <div style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, border: '1px solid #e9e4ff' }}>
              <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 14 }}>Monthly Training Spend (₹)</h4>
              <div style={{ height: 200 }}>
                {costMonthly.length === 0 ? (
                  <EmptyState icon={TrendingUp} title="No monthly trend" sub="Monthly cost data will appear here" />
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={costMonthly} margin={{ top: 4, right: 20, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e9e4ff" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v/1000).toFixed(0)}K`} />
                    <Tooltip formatter={v => [fmtINR(v), 'Spend']} />
                    <Line type="monotone" dataKey="cost" stroke="#6B3FDB" strokeWidth={2} dot={{ r: 4 }} name="Training Spend" />
                  </LineChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
