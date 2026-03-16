import { useState, useCallback } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, RefreshCw, Building2, CreditCard, ArrowUpRight,
  ArrowDownRight, TrendingUp, TrendingDown, Clock, Filter,
  ChevronRight, ChevronDown, Banknote, RotateCcw, Check,
  AlertCircle, FileText, Edit2, Link, Unlink
} from 'lucide-react';
import './BankAccounts.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n) => {
  const v = parseFloat(n||0);
  if (v >= 100000) return `₹${(v/100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v/1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};
const fmtFull = (n) =>
  `₹${parseFloat(n||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const today = () => new Date().toISOString().split('T')[0];

// ── Sample data ───────────────────────────────────────────────────────────────
const SAMPLE_ACCOUNTS = [
  {
    id:1, account_name:'HDFC Current Account', bank:'HDFC Bank',
    account_number:'50200012345678', ifsc:'HDFC0001234',
    account_type:'current', currency:'INR',
    balance:125000, book_balance:122800,
    unreconciled:3, last_reconciled:'2026-02-28',
    is_active:true, color:'#2563eb',
    transactions:[
      {id:1,  date:'2026-03-14', desc:'Payment to Vendor',       ref:'NEFT001', debit:28000,  credit:0,      balance:125000, type:'debit',  matched:true},
      {id:2,  date:'2026-03-13', desc:'Client Receipt',          ref:'RTGS002', debit:0,      credit:85000,  balance:153000, type:'credit', matched:true},
      {id:3,  date:'2026-03-12', desc:'Salary Transfer',         ref:'NEFT003', debit:110000, credit:0,      balance:68000,  type:'debit',  matched:true},
      {id:4,  date:'2026-03-11', desc:'Cloud Services Payment',  ref:'UPI004',  debit:28000,  credit:0,      balance:178000, type:'debit',  matched:false},
      {id:5,  date:'2026-03-10', desc:'Invoice Payment Received',ref:'RTGS005', debit:0,      credit:45000,  balance:206000, type:'credit', matched:false},
      {id:6,  date:'2026-03-09', desc:'Office Rent',             ref:'CHQ006',  debit:22000,  credit:0,      balance:161000, type:'debit',  matched:false},
      {id:7,  date:'2026-03-08', desc:'TDS Refund',              ref:'NEFT007', debit:0,      credit:12000,  balance:183000, type:'credit', matched:true},
    ]
  },
  {
    id:2, account_name:'ICICI Current Account', bank:'ICICI Bank',
    account_number:'001234567890', ifsc:'ICIC0000123',
    account_type:'current', currency:'INR',
    balance:87000, book_balance:87000,
    unreconciled:0, last_reconciled:'2026-03-10',
    is_active:true, color:'#7c3aed',
    transactions:[
      {id:8,  date:'2026-03-12', desc:'Marketing Campaign',     ref:'NEFT008', debit:35000, credit:0,      balance:87000,  type:'debit',  matched:true},
      {id:9,  date:'2026-03-10', desc:'Project Advance',        ref:'RTGS009', debit:0,     credit:120000, balance:122000, type:'credit', matched:true},
      {id:10, date:'2026-03-08', desc:'Software License',       ref:'UPI010',  debit:15000, credit:0,      balance:2000,   type:'debit',  matched:true},
    ]
  },
  {
    id:3, account_name:'SBI Savings Account', bank:'State Bank of India',
    account_number:'31234567890123', ifsc:'SBIN0001234',
    account_type:'savings', currency:'INR',
    balance:42000, book_balance:41500,
    unreconciled:1, last_reconciled:'2026-03-01',
    is_active:true, color:'#059669',
    transactions:[
      {id:11, date:'2026-03-05', desc:'Interest Credit',     ref:'INT001', debit:0,    credit:500,   balance:42000, type:'credit', matched:false},
      {id:12, date:'2026-03-01', desc:'Expense Reimbursement',ref:'NEFT011',debit:3000, credit:0,   balance:41500, type:'debit',  matched:true},
    ]
  },
  {
    id:4, account_name:'Petty Cash', bank:'Internal',
    account_number:'CASH-001', ifsc:'—',
    account_type:'cash', currency:'INR',
    balance:8500, book_balance:8500,
    unreconciled:0, last_reconciled:'2026-03-15',
    is_active:true, color:'#d97706',
    transactions:[
      {id:13, date:'2026-03-15', desc:'Stationery Purchase',   ref:'PC001', debit:1200, credit:0,    balance:8500,  type:'debit',  matched:true},
      {id:14, date:'2026-03-14', desc:'Cash Top-up',           ref:'PC002', debit:0,    credit:5000, balance:9700,  type:'credit', matched:true},
    ]
  },
];

const BANK_STATEMENT = [
  {id:'S1', date:'2026-03-14', desc:'NEFT Payment — Vendor',    ref:'NEFT001', debit:28000,  credit:0,      balance:125000, matched:true,  jv_ref:'JV-2026-1005'},
  {id:'S2', date:'2026-03-13', desc:'RTGS Receipt',             ref:'RTGS002', debit:0,      credit:85000,  balance:153000, matched:true,  jv_ref:'JV-2026-1004'},
  {id:'S3', date:'2026-03-12', desc:'Salary — NEFT Batch',      ref:'NEFT003', debit:110000, credit:0,      balance:68000,  matched:true,  jv_ref:'JV-2026-1003'},
  {id:'S4', date:'2026-03-11', desc:'UPI Payment',              ref:'UPI004',  debit:28000,  credit:0,      balance:178000, matched:false, jv_ref:null},
  {id:'S5', date:'2026-03-10', desc:'RTGS Inward',              ref:'RTGS005', debit:0,      credit:45000,  balance:206000, matched:false, jv_ref:null},
  {id:'S6', date:'2026-03-09', desc:'Cheque Clearance',         ref:'CHQ006',  debit:22000,  credit:0,      balance:161000, matched:false, jv_ref:null},
  {id:'S7', date:'2026-03-08', desc:'TDS Refund',               ref:'NEFT007', debit:0,      credit:12000,  balance:183000, matched:true,  jv_ref:'JV-2026-1001'},
];

const typeColor = (t) => {
  const map = { current:{bg:'#dbeafe',c:'#1d4ed8'}, savings:{bg:'#dcfce7',c:'#15803d'}, cash:{bg:'#fef3c7',c:'#92400e'} };
  return map[t] || map.current;
};

export default function BankAccounts() {
  const [accounts,    setAccounts]    = useState(SAMPLE_ACCOUNTS);
  const [activeAcct,  setActiveAcct]  = useState(null);
  const [activeTab,   setActiveTab]   = useState('accounts'); // accounts | reconcile
  const [recAcct,     setRecAcct]     = useState(null);
  const [statement,   setStatement]   = useState(BANK_STATEMENT);
  const [checkedStmt, setCheckedStmt] = useState({});
  const [checkedBook, setCheckedBook] = useState({});
  const [drawer,      setDrawer]      = useState(null);
  const [toast,       setToast]       = useState(null);
  const [search,      setSearch]      = useState('');
  const [statementBalance, setStatementBalance] = useState('125000');
  const [form,        setForm]        = useState({
    account_name:'', bank:'', account_number:'', ifsc:'',
    account_type:'current', currency:'INR',
    opening_balance:0, is_active:true,
  });

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(()=>setToast(null), 3500);
  };

  // ── Reconciliation logic ─────────────────────────────────────────────────
  const toggleStmt = (id) => setCheckedStmt(p=>({...p,[id]:!p[id]}));
  const toggleBook = (id) => setCheckedBook(p=>({...p,[id]:!p[id]}));

  const matchedStmt    = statement.filter(s=>s.matched).length;
  const unmatchedStmt  = statement.filter(s=>!s.matched).length;
  const checkedStmtAmt = statement.filter(s=>checkedStmt[s.id]).reduce((a,s)=>a+(s.credit||0)-(s.debit||0),0);
  const bookBalance    = recAcct?.book_balance || 0;
  const stmtBal        = parseFloat(statementBalance||0);
  const difference     = stmtBal - bookBalance;
  const isReconciled   = Math.abs(difference) < 0.01;

  const handleMatchItem = (stmtId) => {
    setStatement(p=>p.map(s=>s.id===stmtId?{...s,matched:true,jv_ref:`JV-AUTO-${Date.now()}`}:s));
    showToast('Transaction matched to journal entry');
  };

  const handleCompleteReconciliation = () => {
    if (!isReconciled) { showToast('Difference must be zero before closing','error'); return; }
    setAccounts(p=>p.map(a=>a.id===recAcct.id
      ? {...a, unreconciled:0, last_reconciled:today()}
      : a));
    showToast(`${recAcct.account_name} reconciled successfully for ${new Date().toLocaleDateString('en-IN',{month:'long',year:'numeric'})}`);
    setActiveTab('accounts');
  };

  const startReconcile = (acct) => {
    setRecAcct(acct);
    setActiveTab('reconcile');
    setCheckedStmt({});
    setCheckedBook({});
    setStatementBalance(String(acct.balance));
  };

  const handleAddAccount = () => {
    if (!form.account_name || !form.bank) { showToast('Name and bank required','error'); return; }
    const newAcct = {
      ...form, id:Date.now(),
      balance:parseFloat(form.opening_balance||0),
      book_balance:parseFloat(form.opening_balance||0),
      unreconciled:0, last_reconciled:today(), color:'#6366f1',
      transactions:[],
    };
    setAccounts(p=>[...p,newAcct]);
    showToast('Bank account added');
    setDrawer(null);
    setForm({account_name:'',bank:'',account_number:'',ifsc:'',account_type:'current',currency:'INR',opening_balance:0,is_active:true});
  };

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalBalance   = accounts.reduce((s,a)=>s+a.balance,0);
  const totalUnrecon   = accounts.reduce((s,a)=>s+a.unreconciled,0);
  const needsRecon     = accounts.filter(a=>a.unreconciled>0).length;

  return (
    <div className="ba-root">

      {toast && (
        <div className={`ba-toast ba-toast-${toast.type}`}>
          {toast.type==='success' ? <CheckCircle size={14}/> : <AlertTriangle size={14}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="ba-header">
        <div>
          <h2 className="ba-title">Bank Accounts & Reconciliation</h2>
          <p className="ba-sub">
            {accounts.length} accounts · Total balance: {fmtFull(totalBalance)}
          </p>
        </div>
        <div className="ba-header-r">
          <button className="ba-btn-outline"><Download size={14}/> Export</button>
          <button className="ba-btn-primary" onClick={()=>setDrawer('create')}>
            <Plus size={15}/> Add Account
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="ba-summary">
        <div className="ba-sum-card ba-sum-main">
          <Banknote size={20} color="#6366f1"/>
          <div>
            <p className="ba-sum-label">Total Cash & Bank</p>
            <p className="ba-sum-big">{fmtFull(totalBalance)}</p>
            <p className="ba-sum-sub">Across {accounts.length} accounts</p>
          </div>
        </div>
        <div className="ba-sum-card">
          <TrendingUp size={18} color="#10b981"/>
          <div>
            <p className="ba-sum-label">Total Inflow (MTD)</p>
            <p className="ba-sum-val green">
              {fmtFull(accounts.flatMap(a=>a.transactions).filter(t=>t.type==='credit').reduce((s,t)=>s+t.credit,0))}
            </p>
          </div>
        </div>
        <div className="ba-sum-card">
          <TrendingDown size={18} color="#ef4444"/>
          <div>
            <p className="ba-sum-label">Total Outflow (MTD)</p>
            <p className="ba-sum-val red">
              {fmtFull(accounts.flatMap(a=>a.transactions).filter(t=>t.type==='debit').reduce((s,t)=>s+t.debit,0))}
            </p>
          </div>
        </div>
        <div className={`ba-sum-card ${totalUnrecon>0?'ba-sum-warn':''}`}>
          <AlertCircle size={18} color={totalUnrecon>0?'#f59e0b':'#10b981'}/>
          <div>
            <p className="ba-sum-label">Unreconciled</p>
            <p className={`ba-sum-val ${totalUnrecon>0?'amber':''}`}>{totalUnrecon} transactions</p>
            <p className="ba-sum-sub">{needsRecon} account{needsRecon!==1?'s':''} need reconciliation</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="ba-tabs">
        <button className={`ba-tab${activeTab==='accounts'?' active':''}`}
          onClick={()=>setActiveTab('accounts')}>
          <Building2 size={14}/> Accounts
        </button>
        <button className={`ba-tab${activeTab==='reconcile'?' active':''}`}
          onClick={()=>recAcct && setActiveTab('reconcile')}>
          <RotateCcw size={14}/> Reconciliation
          {totalUnrecon>0 && <span className="ba-tab-badge">{totalUnrecon}</span>}
        </button>
      </div>

      {/* ── ACCOUNTS TAB ─────────────────────────────────────── */}
      {activeTab === 'accounts' && (
        <div className="ba-accounts-grid">
          {accounts.map(acct => {
            const tc = typeColor(acct.account_type);
            const diff = acct.balance - acct.book_balance;
            return (
              <div key={acct.id} className="ba-acct-card">
                <div className="ba-acct-card-hd" style={{borderTopColor:acct.color}}>
                  <div className="ba-acct-icon" style={{background:acct.color+'18',color:acct.color}}>
                    {acct.account_type==='cash' ? <Banknote size={18}/> : <Building2 size={18}/>}
                  </div>
                  <div className="ba-acct-info">
                    <h4 className="ba-acct-name">{acct.account_name}</h4>
                    <p className="ba-acct-bank">{acct.bank}</p>
                  </div>
                  <span className="ba-acct-type-badge" style={{background:tc.bg,color:tc.c}}>
                    {acct.account_type}
                  </span>
                </div>

                <div className="ba-acct-card-body">
                  <div className="ba-acct-balance-row">
                    <div>
                      <p className="ba-bal-label">Bank Balance</p>
                      <p className="ba-bal-val" style={{color:acct.color}}>
                        {fmtFull(acct.balance)}
                      </p>
                    </div>
                    <div className="ba-bal-right">
                      <p className="ba-bal-label">Book Balance</p>
                      <p className="ba-bal-book">{fmtFull(acct.book_balance)}</p>
                    </div>
                  </div>

                  {Math.abs(diff) > 0.01 && (
                    <div className="ba-diff-warn">
                      <AlertTriangle size={12}/>
                      <span>Difference: {fmtFull(Math.abs(diff))}</span>
                    </div>
                  )}

                  <div className="ba-acct-meta">
                    <div className="ba-acct-meta-item">
                      <span>Account #</span>
                      <strong>••{(acct.account_number||'').slice(-4)}</strong>
                    </div>
                    <div className="ba-acct-meta-item">
                      <span>IFSC</span>
                      <strong>{acct.ifsc||'—'}</strong>
                    </div>
                    <div className="ba-acct-meta-item">
                      <span>Unreconciled</span>
                      <strong className={acct.unreconciled>0?'amber':''}>
                        {acct.unreconciled} txns
                      </strong>
                    </div>
                    <div className="ba-acct-meta-item">
                      <span>Last Reconciled</span>
                      <strong>
                        {acct.last_reconciled
                          ? new Date(acct.last_reconciled).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})
                          : 'Never'}
                      </strong>
                    </div>
                  </div>

                  {/* Recent transactions mini */}
                  <div className="ba-mini-txns">
                    {(acct.transactions||[]).slice(0,3).map((txn,i)=>(
                      <div key={i} className="ba-mini-txn">
                        <span className="ba-mini-date">
                          {new Date(txn.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}
                        </span>
                        <span className="ba-mini-desc">{txn.desc}</span>
                        <span className={`ba-mini-amt ${txn.type==='credit'?'green':'red'}`}>
                          {txn.type==='credit'?'+':'-'}{fmt(txn.credit||txn.debit)}
                        </span>
                        {txn.matched
                          ? <Link size={11} color="#10b981"/>
                          : <Unlink size={11} color="#f59e0b"/>}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="ba-acct-card-footer">
                  <button className="ba-acct-btn"
                    onClick={()=>setActiveAcct(acct)}>
                    <Eye size={13}/> Transactions
                  </button>
                  <button className="ba-acct-btn ba-recon-btn"
                    onClick={()=>startReconcile(acct)}>
                    <RotateCcw size={13}/>
                    {acct.unreconciled>0 ? `Reconcile (${acct.unreconciled})` : 'Reconcile'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── RECONCILIATION TAB ───────────────────────────────── */}
      {activeTab === 'reconcile' && recAcct && (
        <div className="ba-recon-wrap">

          {/* Account selector */}
          <div className="ba-recon-acct-bar">
            <span className="ba-recon-label">Reconciling:</span>
            <div className="ba-recon-acct-pills">
              {accounts.map(a=>(
                <button key={a.id}
                  className={`ba-recon-pill ${recAcct.id===a.id?'active':''}`}
                  style={recAcct.id===a.id?{background:a.color,borderColor:a.color}:{}}
                  onClick={()=>startReconcile(a)}>
                  {a.account_name}
                  {a.unreconciled>0 && <span className="ba-pill-badge">{a.unreconciled}</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Balance reconciliation panel */}
          <div className="ba-balance-panel">
            <div className="ba-bp-item">
              <span className="ba-bp-label">Statement Closing Balance</span>
              <div className="ba-bp-input-wrap">
                <span className="ba-bp-prefix">₹</span>
                <input className="ba-bp-input"
                  type="number" value={statementBalance}
                  onChange={e=>setStatementBalance(e.target.value)}/>
              </div>
            </div>
            <div className="ba-bp-sep">—</div>
            <div className="ba-bp-item">
              <span className="ba-bp-label">Book Balance</span>
              <span className="ba-bp-val">{fmtFull(bookBalance)}</span>
            </div>
            <div className="ba-bp-sep">=</div>
            <div className={`ba-bp-item ba-bp-diff ${isReconciled?'ba-bp-ok':'ba-bp-err'}`}>
              <span className="ba-bp-label">Difference</span>
              <span className="ba-bp-diff-val">
                {isReconciled
                  ? <><CheckCircle size={14}/> Balanced</>
                  : fmtFull(Math.abs(difference))}
              </span>
            </div>
            {isReconciled && (
              <button className="ba-complete-btn" onClick={handleCompleteReconciliation}>
                <CheckCircle size={14}/> Complete Reconciliation
              </button>
            )}
          </div>

          {/* Stats */}
          <div className="ba-recon-stats">
            <div className="ba-rs-item green">
              <Link size={13}/>
              <span>{matchedStmt} matched</span>
            </div>
            <div className="ba-rs-item amber">
              <Unlink size={13}/>
              <span>{unmatchedStmt} unmatched</span>
            </div>
            <div className="ba-rs-item">
              <FileText size={13}/>
              <span>{statement.length} total transactions</span>
            </div>
          </div>

          {/* Two-column: Bank Statement | Book Entries */}
          <div className="ba-recon-columns">

            {/* Bank Statement */}
            <div className="ba-recon-col">
              <div className="ba-recon-col-hd">
                <h4>Bank Statement</h4>
                <button className="ba-upload-stmt"><Download size={12}/> Upload Statement</button>
              </div>
              <table className="ba-recon-table">
                <thead>
                  <tr>
                    <th style={{width:28}}></th>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="ba-th-r">Debit</th>
                    <th className="ba-th-r">Credit</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.map(txn => (
                    <tr key={txn.id}
                      className={`ba-recon-tr ${txn.matched?'ba-tr-matched':''} ${checkedStmt[txn.id]?'ba-tr-checked':''}`}>
                      <td>
                        <input type="checkbox" className="ba-checkbox"
                          checked={!!checkedStmt[txn.id]}
                          onChange={()=>toggleStmt(txn.id)}
                          disabled={txn.matched}/>
                      </td>
                      <td className="ba-td-date">
                        {new Date(txn.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}
                      </td>
                      <td>
                        <div>
                          <span className="ba-td-desc">{txn.desc}</span>
                          <span className="ba-td-ref">{txn.ref}</span>
                        </div>
                      </td>
                      <td className="ba-th-r ba-td-dr">
                        {txn.debit ? fmtFull(txn.debit) : '—'}
                      </td>
                      <td className="ba-th-r ba-td-cr">
                        {txn.credit ? fmtFull(txn.credit) : '—'}
                      </td>
                      <td>
                        {txn.matched ? (
                          <div className="ba-matched-badge">
                            <Link size={11}/> {txn.jv_ref}
                          </div>
                        ) : (
                          <button className="ba-match-btn"
                            onClick={()=>handleMatchItem(txn.id)}>
                            <Link size={11}/> Match
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Book Entries */}
            <div className="ba-recon-col">
              <div className="ba-recon-col-hd">
                <h4>Book Entries (Journal)</h4>
                <span className="ba-recon-col-sub">Unmatched entries from ledger</span>
              </div>
              <table className="ba-recon-table">
                <thead>
                  <tr>
                    <th style={{width:28}}></th>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="ba-th-r">Debit</th>
                    <th className="ba-th-r">Credit</th>
                    <th>Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {(recAcct.transactions||[]).map(txn => (
                    <tr key={txn.id}
                      className={`ba-recon-tr ${txn.matched?'ba-tr-matched':''} ${checkedBook[txn.id]?'ba-tr-checked':''}`}>
                      <td>
                        <input type="checkbox" className="ba-checkbox"
                          checked={!!checkedBook[txn.id]}
                          onChange={()=>toggleBook(txn.id)}
                          disabled={txn.matched}/>
                      </td>
                      <td className="ba-td-date">
                        {new Date(txn.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}
                      </td>
                      <td>
                        <div>
                          <span className="ba-td-desc">{txn.desc}</span>
                          <span className="ba-td-ref">{txn.ref}</span>
                        </div>
                      </td>
                      <td className="ba-th-r ba-td-dr">
                        {txn.debit ? fmtFull(txn.debit) : '—'}
                      </td>
                      <td className="ba-th-r ba-td-cr">
                        {txn.credit ? fmtFull(txn.credit) : '—'}
                      </td>
                      <td>
                        {txn.matched ? (
                          <div className="ba-matched-badge"><Link size={11}/> Matched</div>
                        ) : (
                          <span className="ba-unmatched-badge"><Unlink size={11}/> Open</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Match selected */}
              {(Object.values(checkedStmt).some(Boolean) || Object.values(checkedBook).some(Boolean)) && (
                <div className="ba-match-action">
                  <span>Selected: Statement {fmt(Math.abs(checkedStmtAmt))}</span>
                  <button className="ba-match-selected-btn"
                    onClick={()=>{
                      Object.keys(checkedStmt).filter(k=>checkedStmt[k]).forEach(id=>handleMatchItem(id));
                      setCheckedStmt({});
                      setCheckedBook({});
                    }}>
                    <Link size={13}/> Match Selected
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Reconciliation summary */}
          <div className="ba-recon-summary">
            <h4>Reconciliation Summary</h4>
            <div className="ba-rs-grid">
              <div className="ba-rs-row"><span>Opening Balance (Book)</span><strong>{fmtFull(recAcct.book_balance - (recAcct.transactions?.slice(0,3).reduce((s,t)=>s+(t.credit||0)-(t.debit||0),0)||0))}</strong></div>
              <div className="ba-rs-row"><span>+ Deposits / Credits</span><strong className="green">{fmtFull(recAcct.transactions?.filter(t=>t.type==='credit').reduce((s,t)=>s+t.credit,0)||0)}</strong></div>
              <div className="ba-rs-row"><span>- Withdrawals / Debits</span><strong className="red">{fmtFull(recAcct.transactions?.filter(t=>t.type==='debit').reduce((s,t)=>s+t.debit,0)||0)}</strong></div>
              <div className="ba-rs-row ba-rs-total"><span>Closing Book Balance</span><strong>{fmtFull(bookBalance)}</strong></div>
              <div className="ba-rs-row"><span>Bank Statement Balance</span><strong>{fmtFull(stmtBal)}</strong></div>
              <div className={`ba-rs-row ba-rs-diff ${isReconciled?'ba-rs-ok':'ba-rs-warn'}`}>
                <span>Difference</span>
                <strong>{isReconciled ? '₹0.00 ✓' : fmtFull(Math.abs(difference))}</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Transaction Detail Drawer ──────────────────────── */}
      {activeAcct && (
        <div className="ba-overlay" onClick={()=>setActiveAcct(null)}>
          <div className="ba-drawer" onClick={e=>e.stopPropagation()}>
            <div className="ba-drawer-hd">
              <div>
                <h3>{activeAcct.account_name}</h3>
                <p className="ba-drawer-sub">{activeAcct.bank} · ••{activeAcct.account_number.slice(-4)}</p>
              </div>
              <button className="ba-icon-btn" onClick={()=>setActiveAcct(null)}><X size={18}/></button>
            </div>
            <div className="ba-drawer-body">
              <div className="ba-txn-summary">
                <div className="ba-txn-bal">
                  <span>Current Balance</span>
                  <strong style={{color:activeAcct.color}}>{fmtFull(activeAcct.balance)}</strong>
                </div>
                <div className="ba-txn-bal">
                  <span>Unreconciled</span>
                  <strong className={activeAcct.unreconciled>0?'amber':''}>{activeAcct.unreconciled} txns</strong>
                </div>
                <div className="ba-txn-bal">
                  <span>Last Reconciled</span>
                  <strong>{activeAcct.last_reconciled ? new Date(activeAcct.last_reconciled).toLocaleDateString('en-IN') : 'Never'}</strong>
                </div>
              </div>
              <table className="ba-txn-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Ref</th>
                    <th className="ba-th-r">Debit</th>
                    <th className="ba-th-r">Credit</th>
                    <th className="ba-th-r">Balance</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(activeAcct.transactions||[]).map((txn,i)=>(
                    <tr key={i}>
                      <td className="ba-td-date">
                        {new Date(txn.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}
                      </td>
                      <td className="ba-td-desc">{txn.desc}</td>
                      <td><span className="ba-txn-ref">{txn.ref}</span></td>
                      <td className="ba-th-r ba-td-dr">{txn.debit ? fmtFull(txn.debit) : '—'}</td>
                      <td className="ba-th-r ba-td-cr">{txn.credit ? fmtFull(txn.credit) : '—'}</td>
                      <td className="ba-th-r ba-td-bal">{fmtFull(txn.balance)}</td>
                      <td>
                        {txn.matched
                          ? <span className="ba-matched-sm"><Link size={11}/> Matched</span>
                          : <span className="ba-open-sm"><Unlink size={11}/> Open</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="ba-start-recon-btn" onClick={()=>{setActiveAcct(null);startReconcile(activeAcct);}}>
                <RotateCcw size={14}/> Start Reconciliation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Account Drawer ────────────────────────────── */}
      {drawer === 'create' && (
        <div className="ba-overlay" onClick={()=>setDrawer(null)}>
          <div className="ba-drawer" onClick={e=>e.stopPropagation()}>
            <div className="ba-drawer-hd">
              <div>
                <h3>Add Bank Account</h3>
                <p className="ba-drawer-sub">Connect a new bank account</p>
              </div>
              <button className="ba-icon-btn" onClick={()=>setDrawer(null)}><X size={18}/></button>
            </div>
            <div className="ba-drawer-body">
              <div className="ba-form-row">
                <div className="ba-field">
                  <label>Account Name *</label>
                  <input value={form.account_name}
                    onChange={e=>setForm(f=>({...f,account_name:e.target.value}))}
                    placeholder="e.g. HDFC Current Account"/>
                </div>
                <div className="ba-field">
                  <label>Bank *</label>
                  <input value={form.bank}
                    onChange={e=>setForm(f=>({...f,bank:e.target.value}))}
                    placeholder="Bank name…"/>
                </div>
              </div>
              <div className="ba-form-row">
                <div className="ba-field">
                  <label>Account Number</label>
                  <input value={form.account_number}
                    onChange={e=>setForm(f=>({...f,account_number:e.target.value}))}
                    placeholder="Full account number"/>
                </div>
                <div className="ba-field">
                  <label>IFSC Code</label>
                  <input value={form.ifsc}
                    onChange={e=>setForm(f=>({...f,ifsc:e.target.value.toUpperCase()}))}
                    placeholder="BANK0001234"/>
                </div>
              </div>
              <div className="ba-form-row">
                <div className="ba-field">
                  <label>Account Type</label>
                  <select value={form.account_type}
                    onChange={e=>setForm(f=>({...f,account_type:e.target.value}))}>
                    <option value="current">Current Account</option>
                    <option value="savings">Savings Account</option>
                    <option value="cash">Petty Cash</option>
                    <option value="fixed">Fixed Deposit</option>
                  </select>
                </div>
                <div className="ba-field">
                  <label>Currency</label>
                  <select value={form.currency}
                    onChange={e=>setForm(f=>({...f,currency:e.target.value}))}>
                    <option value="INR">INR — Indian Rupee</option>
                    <option value="USD">USD — US Dollar</option>
                    <option value="EUR">EUR — Euro</option>
                  </select>
                </div>
              </div>
              <div className="ba-field">
                <label>Opening Balance (₹)</label>
                <input type="number" value={form.opening_balance}
                  onChange={e=>setForm(f=>({...f,opening_balance:e.target.value}))}
                  placeholder="0.00"/>
              </div>
              <div className="ba-drawer-footer">
                <button className="ba-btn-outline" onClick={()=>setDrawer(null)}>Cancel</button>
                <button className="ba-btn-primary" onClick={handleAddAccount}>
                  <Plus size={14}/> Add Account
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}