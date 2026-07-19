import { useState, useCallback } from "react";
import { Play, CheckCircle, XCircle, RefreshCw, Database } from "lucide-react";
import api from "@/services/api/client";

const WRITE_TESTS = [
  {
    id: 'employee_create', name: 'Create Employee', module: 'HR',
    method: 'post', endpoint: '/employees',
    payload: {
      first_name: 'Test', last_name: 'User_DB_Check',
      office_id: 'TST999', department: 'Engineering',
      designation: 'Test Role', status: 'active',
      company_email: 'test.dbcheck@company.com',
    },
  },
  {
    id: 'leave_create', name: 'Create Leave Request', module: 'Leaves',
    method: 'post', endpoint: '/leaves',
    payload: {
      leave_type: 'Casual Leave', start_date: '2026-04-20',
      end_date: '2026-04-20', days: 1, duration_days: 1,
      reason: 'DB write test - can delete',
    },
  },
  {
    id: 'announcement_create', name: 'Create Announcement', module: 'Announcements',
    method: 'post', endpoint: '/announcements',
    payload: {
      title: 'DB Write Test Announcement',
      message: 'This is an automated DB write test - can be deleted',
      target_audience: 'Everyone', priority: 'Normal', expires_at: '2026-04-30',
    },
  },
  {
    id: 'crm_lead_create', name: 'Create CRM Lead', module: 'CRM',
    method: 'post', endpoint: '/crm/leads',
    payload: {
      company_name: 'DB Test Company', contact_person: 'Test Contact',
      email: 'test@dbtest.com', lead_source: 'Direct',
      status: 'New', value: 100000,
    },
  },
  {
    id: 'travel_request', name: 'Create Travel Request', module: 'Travel',
    method: 'post', endpoint: '/travel/requests',
    payload: {
      destination: 'Mumbai', purpose: 'DB write test',
      from_date: '2026-04-25', to_date: '2026-04-26', budget: 5000,
    },
  },
];

const READ_TESTS = [
  { id:'emp_r',     name:'Employees List',      endpoint:'/employees',          check: d => Array.isArray(d) && d.length > 0, label:'array count > 0' },
  { id:'inv_r',     name:'Finance Invoices',    endpoint:'/finance/invoices',   check: d => Array.isArray(d),                 label:'returns array' },
  { id:'leads_r',   name:'CRM Leads',           endpoint:'/crm/leads',          check: d => Array.isArray(d),                 label:'returns array' },
  { id:'acc_r',     name:'CRM Accounts',        endpoint:'/crm/accounts',       check: d => Array.isArray(d),                 label:'returns array' },
  { id:'leaves_r',  name:'Leave Requests',      endpoint:'/leaves',             check: d => Array.isArray(d),                 label:'returns array' },
  { id:'hols_r',    name:'Holidays',            endpoint:'/holidays',           check: d => Array.isArray(d) && d.length > 0, label:'array count > 0' },
  { id:'payroll_r', name:'Payroll Records',     endpoint:'/payroll',            check: d => Array.isArray(d),                 label:'returns array' },
  { id:'anal_r',    name:'Analytics Headcount', endpoint:'/analytics/headcount',check: d => d && typeof d === 'object',       label:'returns object' },
];

const S = {
  pass:    { bg:'#dcfce7', color:'#166534', border:'#bbf7d0' },
  fail:    { bg:'#fee2e2', color:'#991b1b', border:'#fecaca' },
  running: { bg:'#dbeafe', color:'#1e40af', border:'#bfdbfe' },
  idle:    { bg:'#f3f4f6', color:'#6b7280', border:'#e5e7eb' },
};
const statusStyle = (s) => S[s] || S.idle;

export default function DatabaseTest() {
  const [writeResults, setWriteResults] = useState({});
  const [readResults,  setReadResults]  = useState({});
  const [counts,       setCounts]       = useState(null);
  const [isRunning,    setIsRunning]    = useState(false);
  const [lastRun,      setLastRun]      = useState(null);
  const [dbStatus,     setDbStatus]     = useState(null);

  const runWriteTest = async (test) => {
    const start = Date.now();
    setWriteResults(prev => ({ ...prev, [test.id]: { status:'running' } }));
    try {
      const res = await api[test.method](test.endpoint, test.payload);
      const ms = Date.now() - start;
      setWriteResults(prev => ({ ...prev, [test.id]: {
        status:'pass', ms, data: JSON.stringify(res.data).slice(0, 120),
      }}));
    } catch (err) {
      const ms = Date.now() - start;
      const errData = err.response?.data;
      // eslint-disable-next-line react-hooks/invariant
      setWriteResults(prev => ({ ...prev, [test.id]: {
        status:'fail', ms,
        data: typeof errData === 'object' ? JSON.stringify(errData).slice(0,120) : (err.message || 'Error'),
      }}));
    }
  };

  const runReadTest = async (test) => {
    const start = Date.now();
    setReadResults(prev => ({ ...prev, [test.id]: { status:'running' } }));
    try {
      const res = await api.get(test.endpoint);
      const ms = Date.now() - start;
      const ok = test.check(res.data);
      const count = Array.isArray(res.data) ? ` (${res.data.length} rows)` : '';
      setReadResults(prev => ({ ...prev, [test.id]: {
        status: ok ? 'pass' : 'fail', ms,
        data: ok ? `✓ ${test.label}${count}` : `Expected ${test.label}`,
      }}));
    } catch (err) {
      const ms = Date.now() - start;
      const code = err.response?.status;
      setReadResults(prev => ({ ...prev, [test.id]: {
        status:'fail', ms,
        data: code === 403 ? '403 Forbidden (auth required)' : (err.message || 'Error'),
      }}));
    }
  };

  const loadCounts = async () => {
    try {
      const res = await api.get('/status/counts');
      setCounts(res.data?.counts || null);
    } catch { /* counts unavailable */ }
  };

  const runAll = useCallback(async () => {
    setIsRunning(true);
    setLastRun(new Date());
    // DB health check
    try {
      const h = await api.get('/health');
      setDbStatus(h.data?.db === 'connected' ? 'connected' : 'degraded');
    } catch { setDbStatus('error'); }
    // Write tests
    for (const t of WRITE_TESTS) await runWriteTest(t);
    // Read tests
    for (const t of READ_TESTS) await runReadTest(t);
    // Table counts
    await loadCounts();
    setIsRunning(false);
  }, []);

  const writePassed = WRITE_TESTS.filter(t => writeResults[t.id]?.status === 'pass').length;
  const readPassed  = READ_TESTS.filter(t  => readResults[t.id]?.status  === 'pass').length;

  return (
    <div style={{ padding:24 }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24 }}>
        <div>
          <h2 style={{ margin:0, fontSize:20, fontWeight:700 }}>Database Write Tests</h2>
          <p style={{ margin:'4px 0 0', fontSize:13, color:'#6b7280' }}>Verify all modules save data to PostgreSQL</p>
        </div>
        <button onClick={runAll} disabled={isRunning}
          style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 20px',
            background: isRunning ? '#e5e7eb' : '#6366f1',
            color: isRunning ? '#9ca3af' : '#fff',
            border:'none', borderRadius:8, cursor: isRunning ? 'not-allowed' : 'pointer',
            fontSize:13, fontWeight:600 }}>
          {isRunning
            ? <RefreshCw size={14} style={{ animation:'spin 1s linear infinite' }}/>
            : <Play size={14}/>
          }
          {isRunning ? 'Running…' : 'Run All Tests'}
        </button>
      </div>

      {/* Summary bar */}
      {lastRun && (
        <div style={{ display:'flex', gap:12, marginBottom:20, flexWrap:'wrap' }}>
          {[
            { label:'Write Tests', value:`${writePassed}/${WRITE_TESTS.length} passed`, ok: writePassed === WRITE_TESTS.length },
            { label:'Read Tests',  value:`${readPassed}/${READ_TESTS.length} passed`,   ok: readPassed  === READ_TESTS.length  },
            { label:'Database',    value: dbStatus === 'connected' ? 'Connected ✓' : (dbStatus || '…'), ok: dbStatus === 'connected' },
            { label:'Last Run',    value: lastRun.toLocaleTimeString('en-IN'), ok: true },
          ].map((s, i) => (
            <div key={i} style={{ background:'#fff', border:`1px solid ${s.ok ? '#bbf7d0':'#fecaca'}`, borderRadius:8, padding:'8px 14px' }}>
              <div style={{ fontSize:11, color:'#9ca3af', marginBottom:2 }}>{s.label}</div>
              <div style={{ fontSize:13, fontWeight:700, color: s.ok ? '#166534':'#991b1b' }}>{s.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Write Tests */}
      <ResultTable
        title="Write Tests"
        subtitle="create records in each module"
        iconColor="#6366f1"
        columns={['Module','Test Name','Endpoint','Status','Time','Result','Data Preview']}
        rows={WRITE_TESTS.map(t => {
          const r = writeResults[t.id];
          const s = statusStyle(r?.status);
          return [
            <span style={{ color:'#374151' }}>{t.module}</span>,
            <span style={{ fontWeight:500 }}>{t.name}</span>,
            <span style={{ fontFamily:'monospace', fontSize:11, color:'#6b7280' }}>
              <span style={{ background:'#f3f4f6', padding:'2px 6px', borderRadius:4 }}>{t.method.toUpperCase()}</span>{' '}{t.endpoint}
            </span>,
            <span style={{ ...s, padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:600, border:`1px solid ${s.border}` }}>
              {r?.status === 'running' ? 'Running…' : (r?.status?.toUpperCase() || 'IDLE')}
            </span>,
            <span style={{ color:'#6b7280', fontSize:12 }}>{r?.ms != null ? `${r.ms}ms` : '—'}</span>,
            r?.status === 'pass' ? <CheckCircle size={16} color='#10b981'/>
              : r?.status === 'fail' ? <XCircle size={16} color='#ef4444'/>
              : <div style={{ width:16, height:16, borderRadius:'50%', background:'#e5e7eb' }}/>,
            <span style={{ fontFamily:'monospace', fontSize:11, color:'#6b7280' }}>{r?.data || '—'}</span>,
          ];
        })}
      />

      {/* Read Tests */}
      <div style={{ margin:'20px 0' }}>
        <ResultTable
          title="Read Tests"
          subtitle="verify data is returned from DB"
          iconColor="#10b981"
          columns={['Test Name','Endpoint','Expected','Status','Time','Result']}
          rows={READ_TESTS.map(t => {
            const r = readResults[t.id];
            const s = statusStyle(r?.status);
            return [
              <span style={{ fontWeight:500 }}>{t.name}</span>,
              <span style={{ fontFamily:'monospace', fontSize:11, color:'#6b7280' }}>
                <span style={{ background:'#f3f4f6', padding:'2px 6px', borderRadius:4 }}>GET</span>{' '}{t.endpoint}
              </span>,
              <span style={{ fontSize:12, color:'#6b7280' }}>{t.label}</span>,
              <span style={{ ...s, padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:600, border:`1px solid ${s.border}` }}>
                {r?.status === 'running' ? 'Running…' : (r?.status?.toUpperCase() || 'IDLE')}
              </span>,
              <span style={{ color:'#6b7280', fontSize:12 }}>{r?.ms != null ? `${r.ms}ms` : '—'}</span>,
              <span style={{ fontSize:12, color: r?.status==='pass' ? '#166534' : r?.status==='fail' ? '#991b1b' : '#9ca3af' }}>
                {r?.data || '—'}
              </span>,
            ];
          })}
        />
      </div>

      {/* DB Record Counts */}
      <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'14px 16px', borderBottom:'1px solid #f3f4f6', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <Database size={16} color='#f59e0b'/>
            <span style={{ fontWeight:700, fontSize:14 }}>DB Record Counts</span>
          </div>
          <button onClick={loadCounts}
            style={{ background:'none', border:'1px solid #e5e7eb', borderRadius:6, padding:'5px 10px',
              cursor:'pointer', fontSize:12, color:'#6b7280', display:'flex', alignItems:'center', gap:4 }}>
            <RefreshCw size={12}/> Refresh
          </button>
        </div>
        {!counts ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af', fontSize:13 }}>
            Run all tests to load record counts
          </div>
        ) : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))', gap:1, background:'#f3f4f6' }}>
            {Object.entries(counts).map(([table, count]) => (
              <div key={table} style={{ background:'#fff', padding:16, textAlign:'center' }}>
                <div style={{ fontSize:24, fontWeight:700,
                  color: count < 0 ? '#9ca3af' : count === 0 ? '#ef4444' : '#111827' }}>
                  {count < 0 ? '—' : count}
                </div>
                <div style={{ fontSize:11, color:'#6b7280', marginTop:4, fontFamily:'monospace' }}>{table}</div>
                {count < 0  && <div style={{ fontSize:10, color:'#9ca3af' }}>not found</div>}
                {count === 0 && count >= 0 && <div style={{ fontSize:10, color:'#ef4444' }}>empty</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ResultTable({ title, subtitle, iconColor, columns, rows }) {
  return (
    <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden' }}>
      <div style={{ padding:'14px 16px', borderBottom:'1px solid #f3f4f6', display:'flex', alignItems:'center', gap:8 }}>
        <Database size={16} color={iconColor}/>
        <span style={{ fontWeight:700, fontSize:14 }}>{title}</span>
        <span style={{ fontSize:12, color:'#9ca3af' }}>— {subtitle}</span>
      </div>
      <div style={{ overflowX:'auto' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:'#f9fafb' }}>
              {columns.map(h => (
                <th key={h} style={{ padding:'10px 14px', textAlign:'left', fontSize:11, fontWeight:600,
                  color:'#6b7280', borderBottom:'1px solid #e5e7eb', whiteSpace:'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((cells, i) => (
              <tr key={i} style={{ borderBottom:'1px solid #f3f4f6' }}>
                {cells.map((cell, j) => (
                  <td key={j} style={{ padding:'10px 14px', maxWidth: j === cells.length-1 ? 220 : undefined,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace: j === cells.length-1 ? 'nowrap' : undefined }}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
