import { useState, useCallback } from 'react';
import {
  Lock, Unlock, CheckCircle, AlertTriangle, Clock, RefreshCw,
  ChevronRight, ChevronDown, X, Calendar, FileText, Shield,
  TrendingUp, DollarSign, Users, BarChart2, AlertCircle,
  Play, RotateCcw, Download, Eye
} from 'lucide-react';
import './PeriodClosing.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n) => {
  const v = parseFloat(n||0);
  if (v >= 100000) return `₹${(v/100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v/1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

const YEARS = [2024, 2025, 2026];

// ── Checklist items per closing type ─────────────────────────────────────────
const MONTH_CHECKLIST = [
  {
    id:'rec_bank',    category:'Reconciliation',
    title:'Bank Reconciliation',
    desc:'All bank accounts reconciled with statements',
    icon: DollarSign, critical:true,
  },
  {
    id:'rec_ar',      category:'Reconciliation',
    title:'Accounts Receivable Review',
    desc:'AR aging reviewed, bad debts provisioned',
    icon: FileText, critical:true,
  },
  {
    id:'rec_ap',      category:'Reconciliation',
    title:'Accounts Payable Review',
    desc:'All vendor invoices entered and reconciled',
    icon: FileText, critical:true,
  },
  {
    id:'acc_payroll', category:'Accruals',
    title:'Payroll Accrual',
    desc:'Salary and wage expenses accrued for the period',
    icon: Users, critical:true,
  },
  {
    id:'acc_prepaid', category:'Accruals',
    title:'Prepaid Expenses',
    desc:'Prepaid expenses amortized correctly',
    icon: Calendar, critical:false,
  },
  {
    id:'acc_depr',    category:'Accruals',
    title:'Depreciation Entry',
    desc:'Monthly depreciation posted for all assets',
    icon: BarChart2, critical:true,
  },
  {
    id:'acc_gst',     category:'Tax',
    title:'GST Reconciliation',
    desc:'Output GST, Input ITC, and net payable verified',
    icon: Shield, critical:true,
  },
  {
    id:'tax_tds',     category:'Tax',
    title:'TDS Entries',
    desc:'TDS deducted and payable entries posted',
    icon: Shield, critical:true,
  },
  {
    id:'rev_invoices',category:'Review',
    title:'Invoice Review',
    desc:'All customer invoices raised and sent',
    icon: FileText, critical:false,
  },
  {
    id:'rev_expenses',category:'Review',
    title:'Expense Claims',
    desc:'All approved expense claims reimbursed',
    icon: DollarSign, critical:false,
  },
  {
    id:'rev_tb',      category:'Review',
    title:'Trial Balance Check',
    desc:'Trial balance is balanced (Debits = Credits)',
    icon: BarChart2, critical:true,
  },
  {
    id:'rev_pl',      category:'Review',
    title:'P&L Review',
    desc:'Profit & Loss statement reviewed and approved',
    icon: TrendingUp, critical:true,
  },
];

const YEAR_EXTRA = [
  {
    id:'yr_audit',    category:'Year-End',
    title:'Audit Preparation',
    desc:'All documents compiled for statutory audit',
    icon: Shield, critical:true,
  },
  {
    id:'yr_tax',      category:'Year-End',
    title:'Income Tax Computation',
    desc:'Annual tax liability computed and provisioned',
    icon: Shield, critical:true,
  },
  {
    id:'yr_retain',   category:'Year-End',
    title:'Retained Earnings Transfer',
    desc:'Net profit transferred to retained earnings',
    icon: TrendingUp, critical:true,
  },
  {
    id:'yr_closing',  category:'Year-End',
    title:'Closing Entries',
    desc:'Revenue and expense accounts closed to P&L',
    icon: Lock, critical:true,
  },
  {
    id:'yr_budget',   category:'Year-End',
    title:'Budget vs Actual Analysis',
    desc:'Annual performance vs budget reviewed',
    icon: BarChart2, critical:false,
  },
];

// ── Period status history ─────────────────────────────────────────────────────
const PERIOD_HISTORY = [
  { period:'February 2026', type:'month', status:'closed', closedBy:'Finance Manager', closedAt:'2026-03-05', netProfit:58000 },
  { period:'January 2026',  type:'month', status:'closed', closedBy:'Finance Manager', closedAt:'2026-02-04', netProfit:52000 },
  { period:'December 2025', type:'month', status:'closed', closedBy:'CFO',             closedAt:'2026-01-06', netProfit:71000 },
  { period:'November 2025', type:'month', status:'closed', closedBy:'Finance Manager', closedAt:'2025-12-03', netProfit:48000 },
  { period:'FY 2024-25',    type:'year',  status:'closed', closedBy:'CFO',             closedAt:'2025-04-15', netProfit:620000},
];

// ── Summary data for current period ──────────────────────────────────────────
const CURRENT_SUMMARY = {
  revenue:     378000,
  expenses:    312000,
  netProfit:   66000,
  taxPayable:  13600,
  bankBalance: 125000,
  arOutstanding:112000,
  apOutstanding:94000,
  jvCount:     47,
  unreconciledTxns: 3,
};

export default function PeriodClosing() {
  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [selectedYear,  setSelectedYear]  = useState(now.getFullYear());
  const [closingType,   setClosingType]   = useState('month'); // month | year
  const [checkedItems,  setCheckedItems]  = useState({});
  const [expandedCats,  setExpandedCats]  = useState({ Reconciliation:true, Accruals:true, Tax:true, Review:true, 'Year-End':true });
  const [confirmModal,  setConfirmModal]  = useState(false);
  const [reopenModal,   setReopenModal]   = useState(null);
  const [toast,         setToast]         = useState(null);
  const [closing,       setClosing]       = useState(false);
  const [activeTab,     setActiveTab]     = useState('checklist'); // checklist | history | locked

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const checklist = closingType === 'year'
    ? [...MONTH_CHECKLIST, ...YEAR_EXTRA]
    : MONTH_CHECKLIST;

  const categories = [...new Set(checklist.map(i => i.category))];

  const totalItems    = checklist.length;
  const checkedCount  = checklist.filter(i => checkedItems[i.id]).length;
  const criticalItems = checklist.filter(i => i.critical);
  const criticalDone  = criticalItems.filter(i => checkedItems[i.id]).length;
  const allCriticalDone = criticalDone === criticalItems.length;
  const completionPct = Math.round((checkedCount / totalItems) * 100);
  const canClose      = allCriticalDone;

  const periodLabel = closingType === 'year'
    ? `FY ${selectedYear}-${String(selectedYear+1).slice(2)}`
    : `${MONTHS[selectedMonth]} ${selectedYear}`;

  const toggleCheck = (id) => {
    setCheckedItems(p => ({ ...p, [id]: !p[id] }));
  };

  const toggleCategory = (cat) => {
    setExpandedCats(p => ({ ...p, [cat]: !p[cat] }));
  };

  const checkAll = () => {
    const all = {};
    checklist.forEach(i => { all[i.id] = true; });
    setCheckedItems(all);
  };

  const uncheckAll = () => setCheckedItems({});

  const handleClose = useCallback(async () => {
    setClosing(true);
    await new Promise(r => setTimeout(r, 1800)); // simulate API call
    setClosing(false);
    setConfirmModal(false);
    showToast(`${periodLabel} closed successfully and locked`);
    setActiveTab('history');
  }, [periodLabel]);

  const handleReopen = useCallback(async (period) => {
    await new Promise(r => setTimeout(r, 800));
    setReopenModal(null);
    showToast(`${period} reopened — entries now editable`, 'warning');
  }, []);

  const getCategoryStatus = (cat) => {
    const items = checklist.filter(i => i.category === cat);
    const done  = items.filter(i => checkedItems[i.id]).length;
    if (done === items.length) return 'complete';
    if (done > 0) return 'partial';
    return 'pending';
  };

  return (
    <div className="pc-root">

      {/* Toast */}
      {toast && (
        <div className={`pc-toast pc-toast-${toast.type}`}>
          {toast.type==='success'  ? <CheckCircle size={14}/> :
           toast.type==='warning'  ? <AlertTriangle size={14}/> :
           <AlertCircle size={14}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="pc-header">
        <div>
          <h2 className="pc-title">Period Closing</h2>
          <p className="pc-sub">Month-end and year-end financial close process</p>
        </div>
        <div className="pc-header-r">
          <button className="pc-btn-outline"><Download size={14}/> Export Checklist</button>
        </div>
      </div>

      {/* Period selector */}
      <div className="pc-period-bar">
        <div className="pc-period-selector">
          <div className="pc-type-toggle">
            <button
              className={`pc-type-btn${closingType==='month'?' active':''}`}
              onClick={() => setClosingType('month')}>
              Monthly Close
            </button>
            <button
              className={`pc-type-btn${closingType==='year'?' active':''}`}
              onClick={() => setClosingType('year')}>
              Year-End Close
            </button>
          </div>

          {closingType === 'month' && (
            <select className="pc-select"
              value={selectedMonth}
              onChange={e=>setSelectedMonth(parseInt(e.target.value))}>
              {MONTHS.map((m,i)=>(
                <option key={i} value={i}>{m}</option>
              ))}
            </select>
          )}

          <select className="pc-select"
            value={selectedYear}
            onChange={e=>setSelectedYear(parseInt(e.target.value))}>
            {YEARS.map(y=>(
              <option key={y} value={y}>{y}</option>
            ))}
          </select>

          <div className="pc-period-label">
            <Calendar size={14}/>
            <span>{periodLabel}</span>
          </div>
        </div>

        {/* Progress */}
        <div className="pc-progress-wrap">
          <div className="pc-progress-info">
            <span>{checkedCount}/{totalItems} tasks</span>
            <span className="pc-progress-pct">{completionPct}%</span>
          </div>
          <div className="pc-progress-bar">
            <div className="pc-progress-fill"
              style={{ width:`${completionPct}%`,
                background: completionPct===100 ? '#10b981' : completionPct>50 ? '#f59e0b' : '#6366f1' }}/>
          </div>
          <div className="pc-critical-info">
            <span className={criticalDone===criticalItems.length?'pc-crit-done':'pc-crit-pend'}>
              {criticalDone}/{criticalItems.length} critical tasks done
            </span>
          </div>
        </div>
      </div>

      {/* Summary cards */}
      <div className="pc-summary-grid">
        <div className="pc-sum-card">
          <span className="pc-sum-label">Net Profit</span>
          <span className="pc-sum-val green">{fmt(CURRENT_SUMMARY.netProfit)}</span>
          <span className="pc-sum-sub">For {periodLabel}</span>
        </div>
        <div className="pc-sum-card">
          <span className="pc-sum-label">AR Outstanding</span>
          <span className="pc-sum-val amber">{fmt(CURRENT_SUMMARY.arOutstanding)}</span>
          <span className="pc-sum-sub">Receivables pending</span>
        </div>
        <div className="pc-sum-card">
          <span className="pc-sum-label">AP Outstanding</span>
          <span className="pc-sum-val red">{fmt(CURRENT_SUMMARY.apOutstanding)}</span>
          <span className="pc-sum-sub">Payables due</span>
        </div>
        <div className="pc-sum-card">
          <span className="pc-sum-label">GST Payable</span>
          <span className="pc-sum-val purple">{fmt(CURRENT_SUMMARY.taxPayable)}</span>
          <span className="pc-sum-sub">Net payable</span>
        </div>
        <div className="pc-sum-card">
          <span className="pc-sum-label">Journal Entries</span>
          <span className="pc-sum-val">{CURRENT_SUMMARY.jvCount}</span>
          <span className="pc-sum-sub">Posted this period</span>
        </div>
        <div className={`pc-sum-card ${CURRENT_SUMMARY.unreconciledTxns>0?'pc-sum-warn':''}`}>
          <span className="pc-sum-label">Unreconciled Txns</span>
          <span className={`pc-sum-val ${CURRENT_SUMMARY.unreconciledTxns>0?'red':''}`}>
            {CURRENT_SUMMARY.unreconciledTxns}
          </span>
          <span className="pc-sum-sub">
            {CURRENT_SUMMARY.unreconciledTxns > 0 ? '⚠ Needs attention' : '✓ All clear'}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="pc-tabs">
        <button className={`pc-tab${activeTab==='checklist'?' active':''}`}
          onClick={()=>setActiveTab('checklist')}>
          <CheckCircle size={14}/> Closing Checklist
        </button>
        <button className={`pc-tab${activeTab==='history'?' active':''}`}
          onClick={()=>setActiveTab('history')}>
          <Clock size={14}/> Period History
        </button>
        <button className={`pc-tab${activeTab==='locked'?' active':''}`}
          onClick={()=>setActiveTab('locked')}>
          <Lock size={14}/> Locked Periods
        </button>
      </div>

      {/* ── CHECKLIST TAB ──────────────────────────────────────── */}
      {activeTab === 'checklist' && (
        <div className="pc-checklist-wrap">

          {/* Warnings */}
          {CURRENT_SUMMARY.unreconciledTxns > 0 && (
            <div className="pc-warning-banner">
              <AlertTriangle size={15}/>
              <span>
                <strong>{CURRENT_SUMMARY.unreconciledTxns} unreconciled transactions</strong> found.
                Please reconcile before closing the period.
              </span>
              <button className="pc-warning-action">View Transactions</button>
            </div>
          )}

          {/* Actions */}
          <div className="pc-checklist-actions">
            <div className="pc-check-actions-l">
              <button className="pc-btn-sm" onClick={checkAll}>✓ Check All</button>
              <button className="pc-btn-sm" onClick={uncheckAll}>✕ Uncheck All</button>
            </div>
            <button
              className={`pc-close-btn${canClose?' pc-close-ready':' pc-close-disabled'}`}
              onClick={() => canClose && setConfirmModal(true)}
              title={!canClose ? 'Complete all critical tasks first' : `Close ${periodLabel}`}>
              <Lock size={15}/>
              {canClose ? `Close ${periodLabel}` : `${criticalItems.length - criticalDone} critical tasks remaining`}
            </button>
          </div>

          {/* Checklist by category */}
          {categories.map(cat => {
            const items = checklist.filter(i => i.category === cat);
            const catStatus = getCategoryStatus(cat);
            return (
              <div key={cat} className="pc-category">
                <div className="pc-cat-header" onClick={() => toggleCategory(cat)}>
                  <div className="pc-cat-left">
                    {expandedCats[cat]
                      ? <ChevronDown size={15}/>
                      : <ChevronRight size={15}/>}
                    <span className="pc-cat-name">{cat}</span>
                    <span className={`pc-cat-badge pc-cat-${catStatus}`}>
                      {catStatus === 'complete' ? '✓ Complete'
                       : catStatus === 'partial' ? `${items.filter(i=>checkedItems[i.id]).length}/${items.length}`
                       : 'Pending'}
                    </span>
                  </div>
                  <span className="pc-cat-count">{items.length} tasks</span>
                </div>

                {expandedCats[cat] && (
                  <div className="pc-cat-items">
                    {items.map(item => {
                      const done = !!checkedItems[item.id];
                      const Icon = item.icon;
                      return (
                        <div key={item.id}
                          className={`pc-check-item ${done?'pc-item-done':''}`}
                          onClick={() => toggleCheck(item.id)}>
                          <div className={`pc-checkbox ${done?'checked':''}`}>
                            {done && <CheckCircle size={14} color="#fff"/>}
                          </div>
                          <div className="pc-item-icon">
                            <Icon size={15} color={done?'#10b981':'#9ca3af'}/>
                          </div>
                          <div className="pc-item-body">
                            <div className="pc-item-title-row">
                              <span className={`pc-item-title ${done?'pc-item-title-done':''}`}>
                                {item.title}
                              </span>
                              {item.critical && !done && (
                                <span className="pc-critical-badge">Critical</span>
                              )}
                              {done && (
                                <span className="pc-done-badge">Done</span>
                              )}
                            </div>
                            <span className="pc-item-desc">{item.desc}</span>
                          </div>
                          <div className="pc-item-actions">
                            <button className="pc-item-view-btn"
                              onClick={e => { e.stopPropagation(); }}>
                              <Eye size={12}/> View
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* Bottom close button */}
          {checkedCount === totalItems && (
            <div className="pc-ready-banner">
              <CheckCircle size={18} color="#10b981"/>
              <div>
                <strong>All tasks complete!</strong>
                <p>{periodLabel} is ready to be closed and locked.</p>
              </div>
              <button className="pc-close-btn pc-close-ready"
                onClick={() => setConfirmModal(true)}>
                <Lock size={15}/> Close {periodLabel}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── HISTORY TAB ────────────────────────────────────────── */}
      {activeTab === 'history' && (
        <div className="pc-history-wrap">
          <table className="pc-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Type</th>
                <th>Net Profit</th>
                <th>Closed By</th>
                <th>Closed On</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {PERIOD_HISTORY.map((p,i) => (
                <tr key={i} className="pc-tr">
                  <td className="pc-td-period">{p.period}</td>
                  <td>
                    <span className={`pc-type-badge pc-type-${p.type}`}>
                      {p.type === 'year' ? 'Year-End' : 'Monthly'}
                    </span>
                  </td>
                  <td className="pc-td-profit green">{fmt(p.netProfit)}</td>
                  <td>{p.closedBy}</td>
                  <td className="pc-td-date">
                    {new Date(p.closedAt).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}
                  </td>
                  <td>
                    <span className="pc-status-closed">
                      <Lock size={11}/> Closed
                    </span>
                  </td>
                  <td>
                    <div className="pc-hist-actions">
                      <button className="pc-action-btn" title="View Report">
                        <Eye size={13}/>
                      </button>
                      <button className="pc-action-btn pc-reopen-btn"
                        title="Reopen Period"
                        onClick={() => setReopenModal(p.period)}>
                        <Unlock size={13}/>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── LOCKED PERIODS TAB ─────────────────────────────────── */}
      {activeTab === 'locked' && (
        <div className="pc-locked-wrap">
          <div className="pc-locked-info">
            <Shield size={20} color="#6366f1"/>
            <div>
              <h4>Period Lock Protection</h4>
              <p>Locked periods prevent backdated entries and unauthorized modifications. Only CFO or Finance Manager can reopen a locked period.</p>
            </div>
          </div>
          <div className="pc-locked-grid">
            {MONTHS.map((month, idx) => {
              const isClosed = idx < now.getMonth();
              const isCurrent = idx === now.getMonth();
              return (
                <div key={idx}
                  className={`pc-locked-card ${isClosed?'pc-locked-closed':isCurrent?'pc-locked-current':'pc-locked-future'}`}>
                  <div className="pc-locked-card-header">
                    <span className="pc-locked-month">{month}</span>
                    <span className="pc-locked-year">{selectedYear}</span>
                  </div>
                  <div className="pc-locked-status">
                    {isClosed ? (
                      <><Lock size={14} color="#10b981"/> <span className="green">Locked</span></>
                    ) : isCurrent ? (
                      <><Play size={14} color="#f59e0b"/> <span className="amber">In Progress</span></>
                    ) : (
                      <><Clock size={14} color="#9ca3af"/> <span className="gray">Future</span></>
                    )}
                  </div>
                  {isClosed && (
                    <button className="pc-unlock-btn"
                      onClick={() => setReopenModal(`${month} ${selectedYear}`)}>
                      <Unlock size={11}/> Reopen
                    </button>
                  )}
                  {isCurrent && (
                    <button className="pc-close-mini"
                      onClick={() => { setActiveTab('checklist'); }}>
                      <ChevronRight size={11}/> Close Now
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Confirm Close Modal ─────────────────────────────────── */}
      {confirmModal && (
        <div className="pc-overlay" onClick={() => !closing && setConfirmModal(false)}>
          <div className="pc-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="pc-confirm-icon">
              <Lock size={28} color="#6366f1"/>
            </div>
            <h3>Close {periodLabel}?</h3>
            <p className="pc-confirm-desc">
              This will lock <strong>{periodLabel}</strong> and prevent any new journal entries or modifications for this period.
              This action requires CFO approval to reverse.
            </p>

            <div className="pc-confirm-summary">
              <div className="pc-confirm-row">
                <span>Period</span><strong>{periodLabel}</strong>
              </div>
              <div className="pc-confirm-row">
                <span>Net Profit</span>
                <strong className="green">{fmt(CURRENT_SUMMARY.netProfit)}</strong>
              </div>
              <div className="pc-confirm-row">
                <span>Total Revenue</span>
                <strong>{fmt(CURRENT_SUMMARY.revenue)}</strong>
              </div>
              <div className="pc-confirm-row">
                <span>Total Expenses</span>
                <strong>{fmt(CURRENT_SUMMARY.expenses)}</strong>
              </div>
              <div className="pc-confirm-row">
                <span>Checklist</span>
                <strong>{checkedCount}/{totalItems} tasks completed</strong>
              </div>
            </div>

            <div className="pc-confirm-warning">
              <AlertTriangle size={13}/>
              <span>This action cannot be undone without CFO authorization.</span>
            </div>

            <div className="pc-confirm-footer">
              <button className="pc-btn-outline"
                onClick={() => setConfirmModal(false)}
                disabled={closing}>
                Cancel
              </button>
              <button className="pc-confirm-btn"
                onClick={handleClose} disabled={closing}>
                {closing ? (
                  <><div className="pc-mini-spinner"/>{' '}Closing period…</>
                ) : (
                  <><Lock size={14}/> Confirm & Lock Period</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reopen Confirmation Modal ───────────────────────────── */}
      {reopenModal && (
        <div className="pc-overlay" onClick={() => setReopenModal(null)}>
          <div className="pc-confirm-modal" onClick={e => e.stopPropagation()}>
            <div className="pc-confirm-icon pc-confirm-icon-warn">
              <Unlock size={28} color="#f59e0b"/>
            </div>
            <h3>Reopen {reopenModal}?</h3>
            <p className="pc-confirm-desc">
              Reopening this period will allow backdated journal entries and modifications.
              All changes will be logged in the audit trail.
            </p>
            <div className="pc-confirm-warning pc-warning-amber">
              <AlertTriangle size={13}/>
              <span>This action requires CFO authorization and will be logged.</span>
            </div>
            <div className="pc-confirm-footer">
              <button className="pc-btn-outline" onClick={() => setReopenModal(null)}>Cancel</button>
              <button className="pc-reopen-confirm-btn" onClick={() => handleReopen(reopenModal)}>
                <Unlock size={14}/> Reopen Period
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}