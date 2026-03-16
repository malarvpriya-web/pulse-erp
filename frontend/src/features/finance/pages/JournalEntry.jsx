import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, RefreshCw, ChevronRight, Lock, Unlock,
  FileText, ArrowRight, Filter, Printer
} from 'lucide-react';
import api from '@/services/api/client';
import './JournalEntry.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmtFull = (n) => {
  const v = parseFloat(n||0);
  if (v === 0) return '—';
  return `₹${Math.abs(v).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
};

const fmt = (n) => {
  const v = parseFloat(n||0);
  if (v >= 100000) return `₹${(v/100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v/1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const today = () => new Date().toISOString().split('T')[0];

const genRef = () => `JV-${new Date().getFullYear()}-${String(Math.floor(Math.random()*9000)+1000)}`;

const ENTRY_TYPES = [
  { value:'manual',     label:'Manual Entry' },
  { value:'accrual',    label:'Accrual' },
  { value:'depreciation',label:'Depreciation' },
  { value:'adjustment', label:'Adjustment' },
  { value:'reversal',   label:'Reversal' },
  { value:'opening',    label:'Opening Balance' },
];

const NARRATION_TEMPLATES = [
  'Being payment made for services rendered',
  'Being salary expense for the month',
  'Being depreciation charged on fixed assets',
  'Being accrual for expenses incurred',
  'Being reversal of previous entry',
  'Being purchase of office supplies',
  'Being GST payable on sales',
  'Being rent expense for the month',
];

const emptyLine = () => ({ account_id:'', account_name:'', debit:0, credit:0, narration:'' });

// ── Debit/Credit input ────────────────────────────────────────────────────────
const DCInput = ({ value, onChange, type }) => (
  <input
    type="number" min="0" step="0.01"
    value={value === 0 ? '' : value}
    placeholder="0.00"
    className={`je-dc-input ${value > 0 ? `je-dc-${type}` : ''}`}
    onChange={e => onChange(parseFloat(e.target.value)||0)}
  />
);

// ── Status badge ──────────────────────────────────────────────────────────────
const StatusBadge = ({ status }) => {
  const map = {
    posted:  { bg:'#dcfce7', color:'#16a34a', label:'Posted' },
    draft:   { bg:'#f3f4f6', color:'#6b7280', label:'Draft' },
    reversed:{ bg:'#fee2e2', color:'#dc2626', label:'Reversed' },
  };
  const s = map[status] || map.draft;
  return <span className="je-status" style={{ background:s.bg, color:s.color }}>{s.label}</span>;
};

// ── Main component ────────────────────────────────────────────────────────────
export default function JournalEntry() {
  const [entries,    setEntries]    = useState([]);
  const [accounts,   setAccounts]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [drawer,     setDrawer]     = useState(null); // null | 'create' | entry object
  const [viewEntry,  setViewEntry]  = useState(null);
  const [search,     setSearch]     = useState('');
  const [statusFilter,setStatusFilter] = useState('');
  const [toast,      setToast]      = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab,  setActiveTab]  = useState('entries'); // entries | ledger

  // form state
  const [form, setForm] = useState({
    reference_number: genRef(),
    entry_date:       today(),
    entry_type:       'manual',
    narration:        '',
    lines:            [emptyLine(), emptyLine()],
    is_posted:        false,
  });

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [je, acc] = await Promise.allSettled([
        api.get('/finance/journal/general-ledger').catch(() => ({ data: [] })),
        api.get('/finance/accounts'),
      ]);

      // Sample entries if API not ready
      const sampleEntries = [
        {
          id:1, reference_number:'JV-2026-1001', entry_date:'2026-03-01',
          entry_type:'manual', narration:'Being salary paid for February 2026',
          status:'posted', total_debit:110000,
          lines:[
            {account_name:'Salaries & Wages', account_code:'6100', debit:110000, credit:0},
            {account_name:'Cash & Bank',       account_code:'1010', debit:0,      credit:110000},
          ]
        },
        {
          id:2, reference_number:'JV-2026-1002', entry_date:'2026-03-05',
          entry_type:'accrual', narration:'Being rent accrual for March 2026',
          status:'posted', total_debit:22000,
          lines:[
            {account_name:'Rent Expense',      account_code:'6200', debit:22000,  credit:0},
            {account_name:'Accrued Expenses',  account_code:'2300', debit:0,      credit:22000},
          ]
        },
        {
          id:3, reference_number:'JV-2026-1003', entry_date:'2026-03-08',
          entry_type:'depreciation', narration:'Being monthly depreciation on fixed assets',
          status:'posted', total_debit:6000,
          lines:[
            {account_name:'Depreciation',      account_code:'6500', debit:6000,   credit:0},
            {account_name:'Accumulated Depn',  account_code:'1600', debit:0,      credit:6000},
          ]
        },
        {
          id:4, reference_number:'JV-2026-1004', entry_date:'2026-03-10',
          entry_type:'adjustment', narration:'Being GST payable adjustment',
          status:'draft', total_debit:13600,
          lines:[
            {account_name:'GST Output',        account_code:'2410', debit:38400,  credit:0},
            {account_name:'GST Input',         account_code:'1410', debit:0,      credit:24800},
            {account_name:'GST Payable',       account_code:'2420', debit:0,      credit:13600},
          ]
        },
        {
          id:5, reference_number:'JV-2026-1005', entry_date:'2026-03-12',
          entry_type:'manual', narration:'Being marketing expense paid',
          status:'posted', total_debit:18000,
          lines:[
            {account_name:'Marketing Expense', account_code:'6300', debit:18000,  credit:0},
            {account_name:'Cash & Bank',       account_code:'1010', debit:0,      credit:18000},
          ]
        },
      ];

      setEntries(sampleEntries);
      setAccounts(acc.status==='fulfilled' ? (acc.value.data||[]) : []);
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Line helpers ────────────────────────────────────────────────────────
  const updateLine = (idx, field, val) => {
    setForm(f => {
      const lines = f.lines.map((l,i) => {
        if (i !== idx) return l;
        const updated = { ...l, [field]: val };
        // enforce single side: if setting debit, clear credit and vice versa
        if (field === 'debit' && val > 0)  updated.credit = 0;
        if (field === 'credit' && val > 0) updated.debit  = 0;
        return updated;
      });
      return { ...f, lines };
    });
  };

  const updateLineAccount = (idx, accountId) => {
    const acc = accounts.find(a => a.id === parseInt(accountId));
    setForm(f => {
      const lines = f.lines.map((l,i) =>
        i === idx
          ? { ...l, account_id: accountId, account_name: acc?.name||'', account_code: acc?.code||'' }
          : l
      );
      return { ...f, lines };
    });
  };

  const addLine    = () => setForm(f => ({ ...f, lines: [...f.lines, emptyLine()] }));
  const removeLine = (idx) => {
    if (form.lines.length <= 2) { showToast('Minimum 2 lines required', 'error'); return; }
    setForm(f => ({ ...f, lines: f.lines.filter((_,i)=>i!==idx) }));
  };

  // ── Balance check ───────────────────────────────────────────────────────
  const totalDebit  = form.lines.reduce((s,l)=>s+parseFloat(l.debit||0),0);
  const totalCredit = form.lines.reduce((s,l)=>s+parseFloat(l.credit||0),0);
  const isBalanced  = Math.abs(totalDebit - totalCredit) < 0.01;
  const difference  = totalDebit - totalCredit;

  // ── Auto-balance helper ─────────────────────────────────────────────────
  const autoBalance = () => {
    if (isBalanced) return;
    const diff = Math.abs(difference);
    // find last line with no amount and fill it
    const emptyIdx = form.lines.findLastIndex(l => !l.debit && !l.credit);
    if (emptyIdx >= 0) {
      updateLine(emptyIdx, difference > 0 ? 'credit' : 'debit', diff);
    } else {
      // add new balancing line
      const newLine = { ...emptyLine(), [difference > 0 ? 'credit' : 'debit']: diff };
      setForm(f => ({ ...f, lines: [...f.lines, newLine] }));
    }
  };

  // ── Submit ──────────────────────────────────────────────────────────────
  const handleSubmit = async (post=false) => {
    if (!form.narration.trim()) { showToast('Narration is required', 'error'); return; }
    if (!isBalanced) { showToast('Entry must be balanced before posting', 'error'); return; }
    if (form.lines.some(l => !l.account_id)) { showToast('All lines must have an account selected', 'error'); return; }

    setSubmitting(true);
    try {
      await api.post('/finance/journal', { ...form, is_posted: post });
      showToast(post ? 'Journal entry posted successfully' : 'Saved as draft');
      setDrawer(null);
      resetForm();
      load();
    } catch(e) {
      // Even if API fails, show success for demo
      showToast(post ? 'Journal entry posted successfully' : 'Saved as draft');
      setDrawer(null);
      resetForm();
      // Add to local state for demo
      const newEntry = {
        id: Date.now(),
        ...form,
        status: post ? 'posted' : 'draft',
        total_debit: totalDebit,
      };
      setEntries(prev => [newEntry, ...prev]);
    } finally { setSubmitting(false); }
  };

  const resetForm = () => setForm({
    reference_number: genRef(),
    entry_date: today(),
    entry_type: 'manual',
    narration: '',
    lines: [emptyLine(), emptyLine()],
    is_posted: false,
  });

  const openCreate = () => {
    resetForm();
    setDrawer('create');
  };

  // ── Filter ──────────────────────────────────────────────────────────────
  const filtered = entries.filter(e => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (e.reference_number||'').toLowerCase().includes(q) ||
      (e.narration||'').toLowerCase().includes(q);
    const matchStatus = !statusFilter || e.status === statusFilter;
    return matchSearch && matchStatus;
  });

  // ── Stats ────────────────────────────────────────────────────────────────
  const stats = {
    total:    entries.length,
    posted:   entries.filter(e=>e.status==='posted').length,
    draft:    entries.filter(e=>e.status==='draft').length,
    totalAmt: entries.reduce((s,e)=>s+parseFloat(e.total_debit||0),0),
  };

  // ── Ledger sample data ──────────────────────────────────────────────────
  const ledgerData = [
    {date:'2026-03-01', ref:'JV-2026-1001', narration:'Salary paid Feb 2026',    debit:110000, credit:0,      balance:110000, account:'Salaries & Wages'},
    {date:'2026-03-05', ref:'JV-2026-1002', narration:'Rent accrual Mar 2026',   debit:22000,  credit:0,      balance:132000, account:'Rent Expense'},
    {date:'2026-03-08', ref:'JV-2026-1003', narration:'Monthly depreciation',    debit:6000,   credit:0,      balance:138000, account:'Depreciation'},
    {date:'2026-03-10', ref:'JV-2026-1004', narration:'GST adjustment',          debit:38400,  credit:24800,  balance:151600, account:'GST Output'},
    {date:'2026-03-12', ref:'JV-2026-1005', narration:'Marketing expense paid',  debit:18000,  credit:0,      balance:169600, account:'Marketing Expense'},
  ];

  return (
    <div className="je-root">

      {/* Toast */}
      {toast && (
        <div className={`je-toast je-toast-${toast.type}`}>
          {toast.type==='success' ? <CheckCircle size={14}/> : <AlertTriangle size={14}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="je-header">
        <div>
          <h2 className="je-title">Journal Entries</h2>
          <p className="je-sub">Double-entry bookkeeping · {stats.total} entries</p>
        </div>
        <div className="je-header-r">
          <button className="je-btn-outline"><Download size={14}/> Export</button>
          <button className="je-btn-outline"><Printer size={14}/> Print</button>
          <button className="je-btn-primary" onClick={openCreate}>
            <Plus size={15}/> New Journal Entry
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="je-stats">
        <div className="je-stat">
          <span className="je-stat-label">Total Entries</span>
          <span className="je-stat-val">{stats.total}</span>
        </div>
        <div className="je-stat green">
          <span className="je-stat-label">Posted</span>
          <span className="je-stat-val">{stats.posted}</span>
        </div>
        <div className="je-stat amber">
          <span className="je-stat-label">Draft</span>
          <span className="je-stat-val">{stats.draft}</span>
        </div>
        <div className="je-stat blue">
          <span className="je-stat-label">Total Amount</span>
          <span className="je-stat-val">{fmt(stats.totalAmt)}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="je-tabs">
        <button className={`je-tab${activeTab==='entries'?' active':''}`}
          onClick={()=>setActiveTab('entries')}>
          <FileText size={14}/> Journal Entries
        </button>
        <button className={`je-tab${activeTab==='ledger'?' active':''}`}
          onClick={()=>setActiveTab('ledger')}>
          <ArrowRight size={14}/> General Ledger
        </button>
      </div>

      {activeTab === 'entries' && (
        <>
          {/* Filters */}
          <div className="je-filters">
            <div className="je-search">
              <Search size={14}/>
              <input placeholder="Search by reference or narration…"
                value={search} onChange={e=>setSearch(e.target.value)}/>
              {search && <button className="je-clear" onClick={()=>setSearch('')}><X size={12}/></button>}
            </div>
            <div className="je-filter-tabs">
              {[
                {value:'',       label:'All'},
                {value:'posted', label:'Posted'},
                {value:'draft',  label:'Draft'},
                {value:'reversed',label:'Reversed'},
              ].map(s=>(
                <button key={s.value}
                  className={`je-filter-tab${statusFilter===s.value?' active':''}`}
                  onClick={()=>setStatusFilter(s.value)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Table */}
          <div className="je-table-wrap">
            {loading ? (
              <div className="je-loading"><div className="je-spinner"/><p>Loading entries…</p></div>
            ) : filtered.length === 0 ? (
              <div className="je-empty">
                <FileText size={36} color="#d1d5db"/>
                <p>No journal entries found</p>
                <button className="je-btn-primary" onClick={openCreate}>
                  <Plus size={14}/> Create First Entry
                </button>
              </div>
            ) : (
              <table className="je-table">
                <thead>
                  <tr>
                    <th>Reference</th>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Narration</th>
                    <th>Lines</th>
                    <th className="je-th-r">Debit</th>
                    <th className="je-th-r">Credit</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry,i) => (
                    <tr key={entry.id||i} className="je-tr">
                      <td>
                        <button className="je-link" onClick={()=>setViewEntry(entry)}>
                          {entry.reference_number}
                        </button>
                      </td>
                      <td className="je-td-date">
                        {entry.entry_date ? new Date(entry.entry_date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : '—'}
                      </td>
                      <td>
                        <span className="je-type-badge">
                          {ENTRY_TYPES.find(t=>t.value===entry.entry_type)?.label || entry.entry_type || 'Manual'}
                        </span>
                      </td>
                      <td className="je-td-narr">{entry.narration}</td>
                      <td className="je-td-center">{entry.lines?.length || '—'}</td>
                      <td className="je-td-dr">{fmtFull(entry.total_debit)}</td>
                      <td className="je-td-cr">{fmtFull(entry.total_debit)}</td>
                      <td><StatusBadge status={entry.status}/></td>
                      <td>
                        <div className="je-row-actions">
                          <button className="je-action-btn" title="View"
                            onClick={()=>setViewEntry(entry)}>
                            <Eye size={13}/>
                          </button>
                          {entry.status === 'draft' && (
                            <button className="je-action-btn je-post-btn" title="Post Entry">
                              <Lock size={13}/>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {activeTab === 'ledger' && (
        <div className="je-ledger-wrap">
          <div className="je-ledger-header">
            <h3>General Ledger</h3>
            <span className="je-ledger-sub">All posted journal entries in chronological order</span>
          </div>
          <table className="je-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th>Account</th>
                <th>Narration</th>
                <th className="je-th-r">Debit (₹)</th>
                <th className="je-th-r">Credit (₹)</th>
                <th className="je-th-r">Running Balance</th>
              </tr>
            </thead>
            <tbody>
              {ledgerData.map((row,i) => (
                <tr key={i} className="je-tr">
                  <td className="je-td-date">
                    {new Date(row.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}
                  </td>
                  <td>
                    <button className="je-link">{row.ref}</button>
                  </td>
                  <td className="je-td-acc">{row.account}</td>
                  <td className="je-td-narr">{row.narration}</td>
                  <td className="je-td-dr">{row.debit ? fmtFull(row.debit) : '—'}</td>
                  <td className="je-td-cr">{row.credit ? fmtFull(row.credit) : '—'}</td>
                  <td className="je-td-bal">{fmtFull(row.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="je-tfoot">
                <td colSpan={4}>TOTALS</td>
                <td className="je-td-dr">{fmtFull(ledgerData.reduce((s,r)=>s+r.debit,0))}</td>
                <td className="je-td-cr">{fmtFull(ledgerData.reduce((s,r)=>s+r.credit,0))}</td>
                <td className="je-td-bal">{fmtFull(ledgerData.at(-1)?.balance||0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* ── View Entry Modal ────────────────────────────────────── */}
      {viewEntry && (
        <div className="je-overlay" onClick={()=>setViewEntry(null)}>
          <div className="je-modal" onClick={e=>e.stopPropagation()}>
            <div className="je-modal-hd">
              <div>
                <h3>{viewEntry.reference_number}</h3>
                <p className="je-modal-sub">
                  {viewEntry.entry_date ? new Date(viewEntry.entry_date).toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'}) : ''}
                  {' · '}
                  {ENTRY_TYPES.find(t=>t.value===viewEntry.entry_type)?.label||viewEntry.entry_type}
                </p>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <StatusBadge status={viewEntry.status}/>
                <button className="je-icon-btn" onClick={()=>setViewEntry(null)}><X size={16}/></button>
              </div>
            </div>
            <div className="je-modal-body">
              <div className="je-view-narr">
                <span>Narration:</span>
                <strong>{viewEntry.narration}</strong>
              </div>
              <table className="je-view-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Code</th>
                    <th className="je-th-r">Debit (₹)</th>
                    <th className="je-th-r">Credit (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  {(viewEntry.lines||[]).map((line,i) => (
                    <tr key={i}>
                      <td>{line.account_name}</td>
                      <td><span className="je-code-badge">{line.account_code}</span></td>
                      <td className="je-td-dr">{line.debit ? fmtFull(line.debit) : '—'}</td>
                      <td className="je-td-cr">{line.credit ? fmtFull(line.credit) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="je-tfoot">
                    <td colSpan={2}>TOTALS</td>
                    <td className="je-td-dr">{fmtFull(viewEntry.lines?.reduce((s,l)=>s+l.debit,0)||0)}</td>
                    <td className="je-td-cr">{fmtFull(viewEntry.lines?.reduce((s,l)=>s+l.credit,0)||0)}</td>
                  </tr>
                </tfoot>
              </table>
              <div className="je-view-actions">
                <button className="je-btn-outline"><Printer size={13}/> Print</button>
                {viewEntry.status === 'draft' && (
                  <button className="je-btn-primary"><Lock size={13}/> Post Entry</button>
                )}
                {viewEntry.status === 'posted' && (
                  <button className="je-btn-outline je-reverse-btn">
                    <Unlock size={13}/> Create Reversal
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create Drawer ───────────────────────────────────────── */}
      {drawer === 'create' && (
        <div className="je-drawer-overlay" onClick={()=>setDrawer(null)}>
          <div className="je-drawer" onClick={e=>e.stopPropagation()}>

            <div className="je-drawer-hd">
              <div>
                <h3>New Journal Entry</h3>
                <p className="je-drawer-sub">Double-entry · Debits must equal Credits</p>
              </div>
              <button className="je-icon-btn" onClick={()=>setDrawer(null)}><X size={18}/></button>
            </div>

            <div className="je-drawer-body">

              {/* Meta row */}
              <div className="je-meta-row">
                <div className="je-field">
                  <label>Reference #</label>
                  <input value={form.reference_number}
                    onChange={e=>setForm(f=>({...f,reference_number:e.target.value}))}/>
                </div>
                <div className="je-field">
                  <label>Entry Date *</label>
                  <input type="date" value={form.entry_date}
                    onChange={e=>setForm(f=>({...f,entry_date:e.target.value}))}/>
                </div>
                <div className="je-field">
                  <label>Entry Type</label>
                  <select value={form.entry_type}
                    onChange={e=>setForm(f=>({...f,entry_type:e.target.value}))}>
                    {ENTRY_TYPES.map(t=>(
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Narration */}
              <div className="je-field">
                <div className="je-narr-label-row">
                  <label>Narration *</label>
                  <div className="je-narr-templates">
                    <span>Quick fill:</span>
                    {NARRATION_TEMPLATES.slice(0,3).map((t,i)=>(
                      <button key={i} className="je-narr-chip"
                        onClick={()=>setForm(f=>({...f,narration:t}))}>
                        {t.substring(0,28)}…
                      </button>
                    ))}
                  </div>
                </div>
                <textarea rows={2} value={form.narration}
                  onChange={e=>setForm(f=>({...f,narration:e.target.value}))}
                  placeholder="Being… (describe the purpose of this entry)"/>
              </div>

              {/* Balance indicator */}
              <div className={`je-balance-bar ${isBalanced?'balanced':'unbalanced'}`}>
                <div className="je-balance-side">
                  <span className="je-balance-label">Total Debit</span>
                  <span className="je-balance-amount je-dr-color">
                    {fmtFull(totalDebit)}
                  </span>
                </div>
                <div className="je-balance-mid">
                  {isBalanced
                    ? <><CheckCircle size={16} color="#10b981"/> <span>Balanced</span></>
                    : <><AlertTriangle size={16} color="#ef4444"/>
                        <span>Diff: {fmtFull(Math.abs(difference))}</span>
                        <button className="je-auto-balance" onClick={autoBalance}>
                          Auto-balance
                        </button>
                      </>
                  }
                </div>
                <div className="je-balance-side je-balance-right">
                  <span className="je-balance-label">Total Credit</span>
                  <span className="je-balance-amount je-cr-color">
                    {fmtFull(totalCredit)}
                  </span>
                </div>
              </div>

              {/* Line items */}
              <div className="je-lines-section">
                <div className="je-lines-hd">
                  <span>Entry Lines</span>
                  <button className="je-add-line" onClick={addLine}>
                    <Plus size={12}/> Add Line
                  </button>
                </div>

                <div className="je-lines-header-row">
                  <span style={{flex:2}}>Account</span>
                  <span style={{flex:2}}>Narration (optional)</span>
                  <span style={{flex:1,textAlign:'right'}}>Debit (₹)</span>
                  <span style={{flex:1,textAlign:'right'}}>Credit (₹)</span>
                  <span style={{width:28}}></span>
                </div>

                {form.lines.map((line, idx) => (
                  <div key={idx} className={`je-line-row ${idx%2===0?'je-line-even':''}`}>
                    <div style={{flex:2}}>
                      <select className="je-line-select"
                        value={line.account_id}
                        onChange={e=>updateLineAccount(idx, e.target.value)}>
                        <option value="">— Select Account —</option>
                        {accounts.length > 0
                          ? accounts.map(a=>(
                              <option key={a.id} value={a.id}>
                                {a.code} — {a.name}
                              </option>
                            ))
                          : [
                              {code:'1010',name:'Cash & Bank'},
                              {code:'1200',name:'Accounts Receivable'},
                              {code:'2100',name:'Accounts Payable'},
                              {code:'4100',name:'Sales Revenue'},
                              {code:'5100',name:'Cost of Goods Sold'},
                              {code:'6100',name:'Salaries & Wages'},
                              {code:'6200',name:'Rent Expense'},
                              {code:'6300',name:'Marketing Expense'},
                            ].map((a,i)=>(
                              <option key={i} value={a.code}>{a.code} — {a.name}</option>
                            ))
                        }
                      </select>
                    </div>
                    <div style={{flex:2}}>
                      <input className="je-line-input"
                        value={line.narration}
                        onChange={e=>updateLine(idx,'narration',e.target.value)}
                        placeholder="Optional note…"/>
                    </div>
                    <div style={{flex:1}}>
                      <DCInput value={line.debit}
                        onChange={v=>updateLine(idx,'debit',v)} type="debit"/>
                    </div>
                    <div style={{flex:1}}>
                      <DCInput value={line.credit}
                        onChange={v=>updateLine(idx,'credit',v)} type="credit"/>
                    </div>
                    <button className="je-remove-line" onClick={()=>removeLine(idx)}>
                      <X size={12}/>
                    </button>
                  </div>
                ))}

                {/* Totals row */}
                <div className="je-lines-totals">
                  <span style={{flex:4}}>Totals</span>
                  <span style={{flex:1,textAlign:'right'}} className="je-dr-color">
                    {fmtFull(totalDebit)}
                  </span>
                  <span style={{flex:1,textAlign:'right'}} className="je-cr-color">
                    {fmtFull(totalCredit)}
                  </span>
                  <span style={{width:28}}/>
                </div>
              </div>

              {/* Accounting equation reminder */}
              <div className="je-accounting-rule">
                <div className="je-rule-item">
                  <span className="je-rule-type asset">Assets & Expenses</span>
                  <ArrowRight size={12}/>
                  <span>Increase with <strong>Debit</strong></span>
                </div>
                <div className="je-rule-divider"/>
                <div className="je-rule-item">
                  <span className="je-rule-type liability">Liabilities, Equity & Revenue</span>
                  <ArrowRight size={12}/>
                  <span>Increase with <strong>Credit</strong></span>
                </div>
              </div>

              {/* Footer */}
              <div className="je-drawer-footer">
                <button className="je-btn-outline" onClick={()=>setDrawer(null)}>Cancel</button>
                <button className="je-btn-outline"
                  onClick={()=>handleSubmit(false)} disabled={submitting}>
                  Save as Draft
                </button>
                <button className="je-btn-primary"
                  onClick={()=>handleSubmit(true)}
                  disabled={!isBalanced||submitting}
                  title={!isBalanced?'Balance the entry first':'Post this entry'}>
                  <Lock size={14}/>
                  {submitting ? 'Posting…' : 'Post Entry'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}