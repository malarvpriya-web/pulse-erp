import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import api from '@/services/api/client';
import {
  Clock, AlertTriangle, Search, Download, RefreshCw, Users,
  TrendingUp, BarChart2, FileWarning, X, CheckCircle, Printer,
  Bell, Calendar, Shield,
} from 'lucide-react';

const pad     = n => String(n).padStart(2, '0');
const fmtMins = m => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;

// ─── Severity helpers ─────────────────────────────────────────────────────────
function delaySeverity(mins) {
  if (mins > 60) return { label: 'Critical', bg: '#fee2e2', color: '#991b1b' };
  if (mins > 30) return { label: 'High',     bg: '#fef3c7', color: '#92400e' };
  if (mins > 15) return { label: 'Moderate', bg: '#fff7ed', color: '#c2410c' };
  return          { label: 'Low',            bg: '#f0fdf4', color: '#166534' };
}
function riskBadge(count) {
  if (count >= 10) return { label: 'High',   bg: '#fee2e2', color: '#991b1b' };
  if (count >= 5)  return { label: 'Medium', bg: '#fef3c7', color: '#92400e' };
  return                   { label: 'Low',   bg: '#dcfce7', color: '#166534' };
}
const REPEAT_THRESHOLD = 3;   // highlight + warn button threshold

// ─── Warning Letter Modal ─────────────────────────────────────────────────────
function WarningModal({ employee, month, onClose, onIssued }) {
  const [sending, setSending]   = useState(false);
  const [sent,    setSent]      = useState(false);
  const [text,    setText]      = useState(
    `This letter serves as a formal warning regarding your attendance record for the month of ${month}. ` +
    `You have been marked late on ${employee.count} occasion(s) this month, which is in violation of the ` +
    `company's attendance policy. Please ensure punctuality going forward. ` +
    `Repeated violations may result in further disciplinary action including loss-of-pay deductions.`
  );

  const handleSend = async () => {
    setSending(true);
    try {
      await api.post('/attendance/late-arrivals/warning', {
        employee_id:   employee.id,
        employee_name: employee.name,
        department:    employee.dept,
        month,
        late_count:    employee.count,
        warning_text:  text,
      });
      setSent(true);
      setTimeout(() => { onIssued(); onClose(); }, 1400);
    } catch {
      setSending(false);
    }
  };

  const handlePrint = () => {
    const win = window.open('', '_blank', 'width=750,height=900');
    win.document.write(`<!DOCTYPE html><html><head><title>Warning Letter</title>
      <style>
        body{font-family:Arial,sans-serif;max-width:680px;margin:48px auto;color:#111;font-size:14px;line-height:1.7}
        h2{text-align:center;letter-spacing:1px;font-size:18px;margin-bottom:4px}
        .sub{text-align:center;color:#666;margin-bottom:24px;font-size:12px}
        hr{border:none;border-top:2px solid #222;margin:16px 0}
        .row{display:flex;gap:40px;margin:6px 0}
        .lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px}
        .val{font-weight:600}
        .body{margin-top:28px;padding:16px 0;border-top:1px solid #ddd}
        .sig{margin-top:72px;display:flex;gap:80px}
        .sig-box{min-width:160px}
        .sig-line{border-bottom:1px solid #333;margin-bottom:4px;height:40px}
        @media print{body{margin:24px}}
      </style></head><body>
      <h2>ATTENDANCE WARNING LETTER</h2>
      <div class="sub">Confidential — Human Resources</div>
      <hr/>
      <div class="row">
        <div><div class="lbl">Date</div><div class="val">${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</div></div>
        <div><div class="lbl">Reference Month</div><div class="val">${month}</div></div>
      </div>
      <div class="row">
        <div><div class="lbl">Employee Name</div><div class="val">${employee.name}</div></div>
        <div><div class="lbl">Department</div><div class="val">${employee.dept}</div></div>
      </div>
      <div class="row">
        <div><div class="lbl">Late Occurrences</div><div class="val" style="color:#c00">${employee.count}x</div></div>
        <div><div class="lbl">Total Late Time</div><div class="val">${fmtMins(employee.totalMins)}</div></div>
      </div>
      <div class="body">${text.replace(/\n/g,'<br/>')}</div>
      <div class="sig">
        <div class="sig-box"><div class="sig-line"></div><div>HR Manager</div></div>
        <div class="sig-box"><div class="sig-line"></div><div>Employee Acknowledgement</div></div>
      </div>
      </body></html>`);
    win.focus();
    win.print();
  };

  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,.55)', zIndex:1000,
      display:'flex', alignItems:'center', justifyContent:'center', padding:20,
    }}>
      <div style={{
        background:'#fff', borderRadius:16, maxWidth:640, width:'100%',
        padding:32, position:'relative', boxShadow:'0 20px 60px rgba(0,0,0,.25)',
      }}>
        <button onClick={onClose} style={{
          position:'absolute', top:14, right:14,
          background:'none', border:'none', cursor:'pointer', padding:4,
        }}>
          <X size={20} color="#9ca3af" />
        </button>

        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20 }}>
          <div style={{ background:'#fef2f2', borderRadius:8, padding:8 }}>
            <FileWarning size={20} color="#ef4444" />
          </div>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:'#111827' }}>Issue Warning Letter</div>
            <div style={{ fontSize:12, color:'#6b7280' }}>Letter will be saved and employee will be notified</div>
          </div>
        </div>

        <div style={{
          display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:18,
          padding:16, background:'#fef2f2', borderRadius:10, border:'1px solid #fecaca',
        }}>
          {[
            ['Employee',    employee.name],
            ['Department',  employee.dept],
            ['Late Count',  `${employee.count}x this month`],
            ['Total Delay', fmtMins(employee.totalMins)],
          ].map(([lbl, val]) => (
            <div key={lbl}>
              <div style={{ fontSize:10, color:'#9ca3af', textTransform:'uppercase', letterSpacing:.5 }}>{lbl}</div>
              <div style={{ fontWeight:700, color:'#111827', fontSize:13 }}>{val}</div>
            </div>
          ))}
        </div>

        <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:6 }}>
          Warning Letter Body
        </label>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          style={{
            width:'100%', height:130, padding:12, border:'1px solid #e5e7eb',
            borderRadius:8, fontSize:13, lineHeight:1.65, resize:'vertical',
            outline:'none', boxSizing:'border-box', fontFamily:'inherit',
          }}
        />

        <div style={{ display:'flex', gap:10, marginTop:16, justifyContent:'flex-end', flexWrap:'wrap' }}>
          <button onClick={onClose} style={{
            padding:'8px 16px', border:'1px solid #e5e7eb', borderRadius:8,
            cursor:'pointer', background:'#fff', fontSize:13, color:'#374151',
          }}>
            Cancel
          </button>
          <button onClick={handlePrint} style={{
            padding:'8px 16px', border:'1px solid #6366f1', borderRadius:8,
            cursor:'pointer', background:'#fff', fontSize:13, color:'#6366f1',
            display:'flex', alignItems:'center', gap:6,
          }}>
            <Printer size={14} /> Print Preview
          </button>
          <button
            onClick={handleSend}
            disabled={sending || sent}
            style={{
              padding:'8px 22px', border:'none', borderRadius:8, fontSize:13,
              fontWeight:600, cursor: (sending || sent) ? 'not-allowed' : 'pointer',
              background: sent ? '#10b981' : '#ef4444', color:'#fff',
              display:'flex', alignItems:'center', gap:6,
              opacity: sending ? .7 : 1,
            }}
          >
            {sent
              ? <><CheckCircle size={14} /> Warning Issued</>
              : sending
                ? 'Saving…'
                : <><FileWarning size={14} /> Issue Warning</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Custom Recharts tooltip ──────────────────────────────────────────────────
function WeekTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background:'#1f2937', color:'#fff', borderRadius:8, padding:'8px 12px',
      fontSize:12, boxShadow:'0 4px 12px rgba(0,0,0,.2)',
    }}>
      <div style={{ fontWeight:600 }}>{label}</div>
      <div style={{ color:'#fbbf24', marginTop:2 }}>{payload[0].value} late arrival{payload[0].value !== 1 ? 's' : ''}</div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function LateArrivals() {
  const [records,       setRecords]       = useState([]);
  const [warnings,      setWarnings]      = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [search,        setSearch]        = useState('');
  const [department,    setDepartment]    = useState('');
  const [month,         setMonth]         = useState(new Date().toISOString().slice(0, 7));
  const [departments,   setDepartments]   = useState([]);
  const [warningTarget, setWarningTarget] = useState(null);
  const [activeTab,     setActiveTab]     = useState('detail'); // 'detail' | 'summary' | 'trend'

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  // Load department master list once
  useEffect(() => {
    api.get('/attendance/departments')
      .then(r => {
        const depts = Array.isArray(r.data) ? r.data : [];
        if (isMounted.current && depts.length) setDepartments(depts);
      })
      .catch(() => {});
  }, []);

  const fetchData = useCallback(() => {
    setLoading(true);
    const [y, m]   = month.split('-');
    const lastDay  = new Date(Number(y), Number(m), 0).getDate();
    const start_date = `${month}-01`;
    const end_date   = `${month}-${pad(lastDay)}`;
    const params = { start_date, end_date };
    if (department) params.department = department;

    Promise.all([
      api.get('/attendance/late-arrivals', { params }),
      api.get('/attendance/late-arrivals/warnings', { params: { month } }).catch(() => ({ data: [] })),
    ])
      .then(([lateRes, warnRes]) => {
        if (!isMounted.current) return;
        const rows = Array.isArray(lateRes.data) ? lateRes.data : [];
        setRecords(rows);
        setWarnings(Array.isArray(warnRes.data) ? warnRes.data : []);
        // Fall back: augment departments from live data if master list was empty
        if (departments.length === 0) {
          const d = [...new Set(rows.map(x => x.department).filter(Boolean))].sort();
          if (d.length) setDepartments(d);
        }
      })
      .catch(() => { if (isMounted.current) { setRecords([]); setWarnings([]); } })
      .finally(() => { if (isMounted.current) setLoading(false); });
  }, [month, department]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(fetchData, [fetchData]);

  // ── Derived data ────────────────────────────────────────────────────────────

  const filtered = useMemo(() =>
    records.filter(r => {
      const q = search.toLowerCase();
      return !q || [r.employee_name, r.department].some(v => (v || '').toLowerCase().includes(q));
    }), [records, search]);

  // KPI stats — always keyed by employee_id (not name) to avoid collision
  const stats = useMemo(() => {
    if (!records.length) return { total: 0, employees: 0, avgMins: 0, worst: null, dept: '—' };
    const byEmp  = {};
    const byDept = {};
    records.forEach(r => {
      const mins = Number(r.late_minutes || 0);
      const id   = String(r.employee_id || r.employee_name || 'unk');
      const dept = r.department || 'Unknown';
      if (!byEmp[id])  byEmp[id]  = { name: r.employee_name || '—', totalMins: 0 };
      byEmp[id].totalMins += mins;
      byDept[dept] = (byDept[dept] || 0) + 1; // count, not minutes
    });
    const totalMins  = records.reduce((s, r) => s + Number(r.late_minutes || 0), 0);
    const worstEntry = Object.entries(byEmp).sort((a, b) => b[1].totalMins - a[1].totalMins)[0];
    const worstDept  = Object.entries(byDept).sort((a, b) => b[1] - a[1])[0];
    return {
      total:     records.length,
      employees: Object.keys(byEmp).length,
      avgMins:   Math.round(totalMins / records.length),
      worst:     worstEntry ? { name: worstEntry[1].name, mins: worstEntry[1].totalMins } : null,
      dept:      worstDept  ? `${worstDept[0]} (${worstDept[1]})` : '—',
    };
  }, [records]);

  // Per-employee summary — keyed by employee_id
  const employeeSummary = useMemo(() => {
    const byEmp = {};
    records.forEach(r => {
      const key = String(r.employee_id || r.employee_name || 'unk');
      const mins = Number(r.late_minutes || 0);
      if (!byEmp[key]) byEmp[key] = {
        id: r.employee_id, name: r.employee_name || '—',
        dept: r.department || '—', count: 0, totalMins: 0, maxMins: 0,
      };
      byEmp[key].count++;
      byEmp[key].totalMins += mins;
      byEmp[key].maxMins    = Math.max(byEmp[key].maxMins, mins);
    });
    return Object.values(byEmp).sort((a, b) => b.totalMins - a.totalMins);
  }, [records]);

  // Weekly trend — split month into 4 weeks
  const weeklyTrend = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return [
      { week: 'Week 1', from: 1,  to: 7 },
      { week: 'Week 2', from: 8,  to: 14 },
      { week: 'Week 3', from: 15, to: 21 },
      { week: 'Week 4', from: 22, to: lastDay },
    ].map(w => {
      const count = records.filter(r => {
        const d = parseInt(String(r.attendance_date || '').slice(8, 10));
        return d >= w.from && d <= w.to;
      }).length;
      return { week: w.week, count };
    });
  }, [records, month]);

  // Set of employee_ids that already have a warning issued this month
  const warnedIds = useMemo(
    () => new Set(warnings.map(w => String(w.employee_id))),
    [warnings]
  );

  // ── CSV export (client-side, respects search filter) ────────────────────────
  const downloadCSV = () => {
    const rows = [['Employee', 'Department', 'Date', 'Scheduled In', 'Actual Check-in', 'Delay (mins)', 'Occurrence #']];
    filtered.forEach(r => rows.push([
      r.employee_name  || '',
      r.department     || '',
      String(r.attendance_date || '').slice(0, 10),
      String(r.scheduled_time  || '09:00').slice(0, 5),
      r.check_in_time ? String(r.check_in_time).slice(0, 5) : '',
      r.late_minutes   || 0,
      r.occurrence_rank || '',
    ]));
    const csv  = rows.map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `late-arrivals-${month}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Styles helpers ───────────────────────────────────────────────────────────
  const kpiCards = [
    {
      icon:   <Clock size={20} color="#f59e0b" />,
      label:  'Total Late Records',
      value:  stats.total,
      bg:     '#fef3c7', border: '#fde68a',
    },
    {
      icon:   <Users size={20} color="#6366f1" />,
      label:  'Unique Employees',
      value:  stats.employees,
      bg:     '#ede9fe', border: '#c4b5fd',
    },
    {
      icon:   <TrendingUp size={20} color="#ef4444" />,
      label:  'Avg Delay',
      value:  stats.total ? `${stats.avgMins} mins` : '—',
      bg:     '#fee2e2', border: '#fca5a5',
    },
    {
      icon:   <BarChart2 size={20} color="#10b981" />,
      label:  'Most Affected Dept',
      value:  stats.dept,
      bg:     '#d1fae5', border: '#6ee7b7',
    },
  ];

  const TAB_STYLE = active => ({
    padding: '7px 18px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
    border: 'none',
    background: active ? '#6366f1' : 'transparent',
    color:       active ? '#fff'   : '#6b7280',
    transition: 'all .15s',
  });

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      {/* Warning modal */}
      {warningTarget && (
        <WarningModal
          employee={warningTarget}
          month={month}
          onClose={() => setWarningTarget(null)}
          onIssued={fetchData}
        />
      )}

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{
        display:'flex', justifyContent:'space-between', alignItems:'flex-start',
        marginBottom:20, flexWrap:'wrap', gap:12,
      }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>
            Late Arrivals — Monthly Report
          </h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>
            {filtered.length} record{filtered.length !== 1 ? 's' : ''} · {stats.employees} employee{stats.employees !== 1 ? 's' : ''} late this month
          </p>
        </div>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
          <input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            style={{
              padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8,
              fontSize:13, outline:'none', background:'#fff',
            }}
          />
          <select
            value={department}
            onChange={e => setDepartment(e.target.value)}
            style={{
              padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8,
              fontSize:13, outline:'none', background:'#fff', minWidth:150,
            }}
          >
            <option value="">All Departments</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <button
            onClick={fetchData}
            style={{
              padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8,
              fontSize:13, cursor:'pointer', background:'#fff',
              display:'flex', alignItems:'center', gap:6, color:'#374151',
            }}
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={downloadCSV}
            style={{
              padding:'8px 12px', border:'none', borderRadius:8, fontSize:13,
              cursor:'pointer', background:'#6366f1', color:'#fff',
              display:'flex', alignItems:'center', gap:6,
            }}
          >
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* ── KPI Cards ────────────────────────────────────────────────────── */}
      <div style={{
        display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',
        gap:16, marginBottom:20,
      }}>
        {kpiCards.map(k => (
          <div key={k.label} style={{
            background:k.bg, border:`1px solid ${k.border}`,
            borderRadius:12, padding:'16px 20px',
          }}>
            <div style={{ marginBottom:8 }}>{k.icon}</div>
            <div style={{ fontSize:22, fontWeight:700, color:'#111827' }}>{k.value}</div>
            <div style={{ fontSize:12, color:'#6b7280', marginTop:2 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* ── Top offender banner ──────────────────────────────────────────── */}
      {stats.worst && (
        <div style={{
          display:'flex', alignItems:'center', gap:10,
          padding:'10px 16px', background:'#fff7ed',
          border:'1px solid #fed7aa', borderRadius:10, marginBottom:20, fontSize:13,
        }}>
          <AlertTriangle size={16} color="#f59e0b" />
          <span>
            <strong>{stats.worst.name}</strong> had the most cumulative late time this month:{' '}
            <strong>{fmtMins(stats.worst.mins)}</strong> total
          </span>
        </div>
      )}

      {/* ── Warnings issued this month ───────────────────────────────────── */}
      {warnings.length > 0 && (
        <div style={{
          display:'flex', alignItems:'center', gap:10, padding:'10px 16px',
          background:'#fef2f2', border:'1px solid #fecaca',
          borderRadius:10, marginBottom:20, fontSize:13, flexWrap:'wrap',
        }}>
          <Shield size={16} color="#ef4444" />
          <span>
            <strong>{warnings.length} warning letter{warnings.length !== 1 ? 's' : ''}</strong>{' '}
            issued this month
          </span>
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginLeft:4 }}>
            {warnings.map(w => (
              <span key={w.id} style={{
                background:'#fee2e2', color:'#991b1b', borderRadius:20,
                padding:'2px 10px', fontSize:11, fontWeight:600,
              }}>
                {w.employee_name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div style={{
        display:'flex', gap:4, marginBottom:20,
        background:'#f3f4f6', borderRadius:10, padding:4, width:'fit-content',
      }}>
        {[
          { key:'detail',  label:'Daily Detail',      icon:<Clock size={13}/> },
          { key:'summary', label:'Employee Summary',  icon:<Users size={13}/> },
          { key:'trend',   label:'Weekly Trend',      icon:<BarChart2 size={13}/> },
        ].map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)} style={TAB_STYLE(activeTab === t.key)}>
            <span style={{ display:'flex', alignItems:'center', gap:5 }}>{t.icon}{t.label}</span>
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* TAB: DAILY DETAIL                                                 */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'detail' && (
        <div style={{
          background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden',
        }}>
          <div style={{
            padding:'14px 20px', borderBottom:'1px solid #f0f0f4',
            display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8,
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <Clock size={16} color="#f59e0b" />
              <span style={{ fontWeight:700, fontSize:14, color:'#111827' }}>Daily Detail</span>
              {filtered.length > 0 && (
                <span style={{
                  background:'#fef3c7', color:'#92400e', borderRadius:20,
                  padding:'1px 8px', fontSize:11, fontWeight:700,
                }}>
                  {filtered.length}
                </span>
              )}
            </div>
            <div style={{ position:'relative' }}>
              <Search size={13} style={{
                position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', color:'#9ca3af',
              }} />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search employee / dept…"
                style={{
                  paddingLeft:28, paddingRight:10, paddingTop:6, paddingBottom:6,
                  border:'1px solid #e5e7eb', borderRadius:8, fontSize:12,
                  outline:'none', width:210,
                }}
              />
            </div>
          </div>

          {loading ? (
            <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>
              <RefreshCw size={26} color="#d1d5db" style={{ display:'block', margin:'0 auto 10px', animation:'spin 1s linear infinite' }} />
              Loading records…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding:56, textAlign:'center', color:'#9ca3af' }}>
              <Clock size={36} color="#d1d5db" style={{ display:'block', margin:'0 auto 12px' }} />
              <p style={{ margin:0, fontSize:14 }}>No late arrivals found for this selection.</p>
            </div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ background:'#f9fafb' }}>
                    {['Employee', 'Dept', 'Date', 'Scheduled In', 'Actual Check-in', 'Delay', 'Occurrence', 'Severity'].map(h => (
                      <th key={h} style={{
                        padding:'10px 14px', textAlign:'left', fontWeight:600,
                        color:'#374151', borderBottom:'1px solid #f0f0f4', whiteSpace:'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => {
                    const delay    = Number(r.late_minutes || 0);
                    const sev      = delaySeverity(delay);
                    const occNum   = Number(r.occurrence_rank || 0);
                    const isRepeat = occNum >= REPEAT_THRESHOLD;
                    const rowBg    = isRepeat
                      ? (i % 2 === 0 ? '#fff5f5' : '#fff0f0')
                      : (i % 2 === 0 ? '#fff'    : '#fafafa');

                    return (
                      <tr key={r.id || i} style={{ borderBottom:'1px solid #f9fafb', background:rowBg }}>
                        <td style={{ padding:'10px 14px' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            {isRepeat && <AlertTriangle size={13} color="#ef4444" />}
                            <span style={{ fontWeight:600, color: isRepeat ? '#991b1b' : '#1f2937' }}>
                              {r.employee_name || '—'}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding:'10px 14px', color:'#6b7280' }}>{r.department || '—'}</td>
                        <td style={{ padding:'10px 14px', color:'#374151', whiteSpace:'nowrap' }}>
                          {String(r.attendance_date || '').slice(0, 10)}
                        </td>
                        <td style={{ padding:'10px 14px', color:'#374151' }}>
                          {String(r.scheduled_time || '09:00').slice(0, 5)}
                        </td>
                        <td style={{ padding:'10px 14px', fontWeight:600, color:'#374151' }}>
                          {r.check_in_time ? String(r.check_in_time).slice(0, 5) : '—'}
                        </td>
                        <td style={{ padding:'10px 14px' }}>
                          <span style={{
                            display:'flex', alignItems:'center', gap:4,
                            color: delay > 30 ? '#991b1b' : '#92400e', fontWeight:700,
                          }}>
                            {delay > 30 && <AlertTriangle size={11} />}
                            {delay} mins
                          </span>
                        </td>
                        <td style={{ padding:'10px 14px' }}>
                          {occNum > 0 && (
                            <span style={{
                              background: occNum >= REPEAT_THRESHOLD ? '#fee2e2' : '#f3f4f6',
                              color:      occNum >= REPEAT_THRESHOLD ? '#991b1b' : '#374151',
                              borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700,
                            }}>
                              #{occNum} {occNum >= REPEAT_THRESHOLD ? '⚠' : ''}
                            </span>
                          )}
                        </td>
                        <td style={{ padding:'10px 14px' }}>
                          <span style={{
                            background:sev.bg, color:sev.color,
                            padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700,
                          }}>
                            {sev.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* TAB: EMPLOYEE SUMMARY                                             */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'summary' && (
        <div style={{
          background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden',
        }}>
          <div style={{ padding:'14px 20px', borderBottom:'1px solid #f0f0f4', display:'flex', alignItems:'center', gap:8 }}>
            <Users size={16} color="#6366f1" />
            <span style={{ fontWeight:700, fontSize:14, color:'#111827' }}>Employee Summary</span>
            <span style={{ fontSize:12, color:'#9ca3af', marginLeft:4 }}>
              Repeat offenders (≥{REPEAT_THRESHOLD}×) highlighted — issue warning from here
            </span>
          </div>

          {loading ? (
            <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>Loading…</div>
          ) : employeeSummary.length === 0 ? (
            <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>No data for this period.</div>
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead>
                  <tr style={{ background:'#f9fafb' }}>
                    {['Employee', 'Department', 'Late Count', 'Total Late Time', 'Max Single Delay', 'Risk', 'Action'].map(h => (
                      <th key={h} style={{
                        padding:'10px 14px', textAlign:'left', fontWeight:600,
                        color:'#374151', borderBottom:'1px solid #f0f0f4',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {employeeSummary.map((emp, i) => {
                    const risk      = riskBadge(emp.count);
                    const isRepeat  = emp.count >= REPEAT_THRESHOLD;
                    const hasWarning = warnedIds.has(String(emp.id));
                    const rowBg     = isRepeat
                      ? (i % 2 === 0 ? '#fff5f5' : '#fff0f0')
                      : (i % 2 === 0 ? '#fff'    : '#fafafa');

                    return (
                      <tr key={i} style={{ borderBottom:'1px solid #f9fafb', background:rowBg }}>
                        <td style={{ padding:'10px 14px' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                            {isRepeat && <AlertTriangle size={13} color="#ef4444" />}
                            <span style={{ fontWeight:600, color: isRepeat ? '#991b1b' : '#1f2937' }}>
                              {emp.name}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding:'10px 14px', color:'#6b7280' }}>{emp.dept}</td>
                        <td style={{ padding:'10px 14px', fontWeight:700, color:'#f59e0b', fontSize:14 }}>
                          {emp.count}×
                        </td>
                        <td style={{ padding:'10px 14px', color:'#374151' }}>{fmtMins(emp.totalMins)}</td>
                        <td style={{ padding:'10px 14px', color:'#374151' }}>{emp.maxMins} mins</td>
                        <td style={{ padding:'10px 14px' }}>
                          <span style={{
                            background:risk.bg, color:risk.color,
                            padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:700,
                          }}>
                            {risk.label}
                          </span>
                        </td>
                        <td style={{ padding:'10px 14px' }}>
                          {isRepeat && (
                            hasWarning ? (
                              <span style={{
                                display:'inline-flex', alignItems:'center', gap:4,
                                color:'#10b981', fontSize:12, fontWeight:600,
                              }}>
                                <CheckCircle size={13} /> Warning Issued
                              </span>
                            ) : (
                              <button
                                onClick={() => setWarningTarget(emp)}
                                style={{
                                  padding:'5px 12px', border:'none', borderRadius:8, cursor:'pointer',
                                  background:'#fef2f2', color:'#ef4444', fontSize:12, fontWeight:600,
                                  display:'inline-flex', alignItems:'center', gap:5,
                                }}
                              >
                                <FileWarning size={13} /> Issue Warning
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════ */}
      {/* TAB: WEEKLY TREND                                                 */}
      {/* ══════════════════════════════════════════════════════════════════ */}
      {activeTab === 'trend' && (
        <div style={{
          background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden',
        }}>
          <div style={{ padding:'14px 20px', borderBottom:'1px solid #f0f0f4', display:'flex', alignItems:'center', gap:8 }}>
            <BarChart2 size={16} color="#6366f1" />
            <span style={{ fontWeight:700, fontSize:14, color:'#111827' }}>Weekly Trend</span>
            <span style={{ fontSize:12, color:'#9ca3af', marginLeft:4 }}>
              Late arrivals per week in {month}
            </span>
          </div>

          <div style={{ padding:'24px 20px' }}>
            {records.length === 0 ? (
              <div style={{ padding:48, textAlign:'center', color:'#9ca3af' }}>
                No late arrivals to chart for this period.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={weeklyTrend} barSize={48}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                  <XAxis
                    dataKey="week"
                    tick={{ fontSize:13, fill:'#6b7280' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize:12, fill:'#9ca3af' }}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                  />
                  <Tooltip content={<WeekTooltip />} cursor={{ fill:'#f9fafb' }} />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                    {weeklyTrend.map((entry, idx) => (
                      <Cell
                        key={idx}
                        fill={entry.count === Math.max(...weeklyTrend.map(w => w.count))
                          ? '#ef4444'
                          : '#818cf8'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}

            {/* Weekly breakdown cards */}
            <div style={{
              display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))',
              gap:12, marginTop:24,
            }}>
              {weeklyTrend.map(w => {
                const pct = stats.total > 0 ? Math.round((w.count / stats.total) * 100) : 0;
                return (
                  <div key={w.week} style={{
                    background:'#f9fafb', borderRadius:10, padding:'12px 16px',
                    border:'1px solid #f0f0f4',
                  }}>
                    <div style={{ fontSize:12, color:'#9ca3af', fontWeight:600 }}>{w.week}</div>
                    <div style={{ fontSize:24, fontWeight:700, color:'#1f2937', marginTop:4 }}>{w.count}</div>
                    <div style={{ fontSize:11, color:'#6b7280', marginTop:2 }}>{pct}% of month total</div>
                    <div style={{
                      height:4, background:'#e5e7eb', borderRadius:2, marginTop:8,
                    }}>
                      <div style={{
                        height:4, background:'#6366f1', borderRadius:2,
                        width:`${pct}%`, transition:'width .4s',
                      }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
