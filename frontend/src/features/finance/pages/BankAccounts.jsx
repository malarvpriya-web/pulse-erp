import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, RefreshCw, Building2, CreditCard, ArrowUpRight,
  ArrowDownRight, TrendingUp, TrendingDown, Clock, Filter,
  ChevronRight, ChevronDown, Banknote, RotateCcw, Check,
  AlertCircle, FileText, Edit2, Link, Unlink, Upload,
} from 'lucide-react';
import './BankAccounts.css';
import api from '@/services/api/client';
import { fmt, fmtFull, today } from '../financeUtils';

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

const ACCOUNT_COLORS = {
  current: '#6366f1',
  savings: '#10b981',
  cash:    '#f59e0b',
  od:      '#ef4444',
  cc:      '#8b5cf6',
  fixed:   '#0ea5e9',
};

const typeColor = (t) => {
  const map = {
    current: { bg: '#dbeafe', c: '#1d4ed8' },
    savings: { bg: '#dcfce7', c: '#15803d' },
    cash:    { bg: '#fef3c7', c: '#92400e' },
    od:      { bg: '#fee2e2', c: '#b91c1c' },
    cc:      { bg: '#ede9fe', c: '#6d28d9' },
    fixed:   { bg: '#e0f2fe', c: '#0369a1' },
  };
  return map[t] || map.current;
};

const EMPTY_FORM = {
  account_name: '', bank_name: '', account_number: '', ifsc_code: '',
  account_type: 'current', currency: 'INR',
  opening_balance: '', opening_date: today(),
  is_primary: false, branch: '',
};

export default function BankAccounts() {
  const [accounts,       setAccounts]       = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [activeAcct,     setActiveAcct]     = useState(null);
  const [acctTxns,       setAcctTxns]       = useState([]);
  const [txnsLoading,    setTxnsLoading]    = useState(false);
  const [activeTab,      setActiveTab]      = useState('accounts');
  const [recAcct,        setRecAcct]        = useState(null);
  const [stmtLines,      setStmtLines]      = useState([]);
  const [bookTxns,       setBookTxns]       = useState([]);
  const [checkedStmt,    setCheckedStmt]    = useState({});
  const [checkedBook,    setCheckedBook]    = useState({});
  const [drawer,         setDrawer]         = useState(null);  // 'create' | 'edit'
  const [editTarget,     setEditTarget]     = useState(null);
  const [toast,          setToast]          = useState(null);
  const [statementBal,   setStatementBal]   = useState('');
  const [form,           setForm]           = useState(EMPTY_FORM);
  const [formErrors,     setFormErrors]     = useState({});
  const [saving,         setSaving]         = useState(false);
  const [autoMatching,   setAutoMatching]   = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/finance/bank-accounts');
      const data = Array.isArray(res.data) ? res.data
        : (res.data?.data || res.data?.accounts || []);
      setAccounts(data);
    } catch {
      setAccounts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  // ── Form validation ──────────────────────────────────────────────────────────
  const validateForm = (f) => {
    const errs = {};
    if (!f.account_name.trim()) errs.account_name = 'Required';
    if (!f.bank_name.trim())    errs.bank_name    = 'Required';
    if (f.ifsc_code && !IFSC_RE.test(f.ifsc_code.toUpperCase())) {
      errs.ifsc_code = 'Invalid IFSC — format: HDFC0001234';
    }
    if (f.opening_balance !== '' && isNaN(parseFloat(f.opening_balance))) {
      errs.opening_balance = 'Must be a number';
    }
    return errs;
  };

  const handleSaveAccount = async () => {
    const errs = validateForm(form);
    if (Object.keys(errs).length) { setFormErrors(errs); return; }
    setSaving(true);
    try {
      const payload = {
        ...form,
        ifsc_code: form.ifsc_code.toUpperCase(),
        opening_balance: parseFloat(form.opening_balance || 0),
      };
      if (editTarget) {
        const res = await api.put(`/finance/bank-accounts/${editTarget.id}`, payload);
        setAccounts(p => p.map(a => a.id === editTarget.id ? res.data : a));
        showToast('Bank account updated');
      } else {
        const res = await api.post('/finance/bank-accounts', payload);
        setAccounts(p => [...p, res.data]);
        showToast('Bank account added');
      }
      setDrawer(null);
      setEditTarget(null);
      setForm(EMPTY_FORM);
      setFormErrors({});
    } catch (e) {
      showToast(e?.response?.data?.error || 'Failed to save account', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (acct) => {
    setEditTarget(acct);
    setForm({
      account_name:    acct.account_name || '',
      bank_name:       acct.bank_name || '',
      account_number:  acct.account_number || '',
      ifsc_code:       acct.ifsc_code || '',
      account_type:    acct.account_type || 'current',
      currency:        acct.currency || 'INR',
      opening_balance: acct.opening_balance ?? '',
      opening_date:    acct.opening_date ? acct.opening_date.split('T')[0] : today(),
      is_primary:      acct.is_primary || false,
      branch:          acct.branch || '',
    });
    setFormErrors({});
    setDrawer('edit');
  };

  const handleDeactivate = async (acct) => {
    try {
      await api.delete(`/finance/bank-accounts/${acct.id}`);
      setAccounts(p => p.filter(a => a.id !== acct.id));
      showToast(`${acct.account_name} deactivated`);
      if (activeAcct?.id === acct.id) setActiveAcct(null);
    } catch {
      showToast('Failed to deactivate account', 'error');
    }
  };

  // ── Transaction drill-down ───────────────────────────────────────────────────
  const openTransactions = async (acct) => {
    setActiveAcct(acct);
    setAcctTxns([]);
    setTxnsLoading(true);
    try {
      const res = await api.get(`/finance/bank-accounts/${acct.id}/transactions`);
      setAcctTxns(Array.isArray(res.data) ? res.data : []);
    } catch {
      setAcctTxns([]);
    } finally {
      setTxnsLoading(false);
    }
  };

  // ── Reconciliation ───────────────────────────────────────────────────────────
  const toggleStmt = (id) => setCheckedStmt(p => ({ ...p, [id]: !p[id] }));
  const toggleBook = (id) => setCheckedBook(p => ({ ...p, [id]: !p[id] }));

  const startReconcile = async (acct) => {
    setRecAcct(acct);
    setActiveTab('reconcile');
    setCheckedStmt({});
    setCheckedBook({});
    setStatementBal(String(acct.current_balance || ''));
    // Load both statement lines and unreconciled book transactions
    try {
      const [sRes, bRes] = await Promise.all([
        api.get(`/finance/bank-accounts/${acct.id}/statement-lines`),
        api.get(`/finance/bank-accounts/${acct.id}/unreconciled`),
      ]);
      setStmtLines(Array.isArray(sRes.data) ? sRes.data : []);
      setBookTxns(Array.isArray(bRes.data) ? bRes.data : []);
    } catch {
      setStmtLines([]);
      setBookTxns([]);
    }
  };

  const handleAutoMatch = async () => {
    if (!recAcct) return;
    setAutoMatching(true);
    try {
      const res = await api.post(`/finance/bank-accounts/${recAcct.id}/auto-match`);
      showToast(`Auto-matched ${res.data.matched} transaction(s)`);
      await startReconcile(recAcct); // reload
    } catch {
      showToast('Auto-match failed', 'error');
    } finally {
      setAutoMatching(false);
    }
  };

  const handleManualMatch = async (stmtId, txnId) => {
    try {
      await api.post(`/finance/bank-accounts/${recAcct.id}/manual-match`, {
        statement_line_id: stmtId,
        transaction_id: txnId,
      });
      showToast('Transaction matched');
      await startReconcile(recAcct);
    } catch {
      showToast('Match failed', 'error');
    }
  };

  const handleCompleteReconciliation = async () => {
    if (!isReconciled) { showToast('Difference must be zero before closing', 'error'); return; }
    try {
      await api.post(`/finance/bank-accounts/${recAcct.id}/reconcile`);
      setAccounts(p => p.map(a => a.id === recAcct.id
        ? { ...a, unreconciled_count: 0, last_reconciled_at: new Date().toISOString() }
        : a));
      showToast(`${recAcct.account_name} reconciled successfully`);
      setActiveTab('accounts');
    } catch {
      showToast('Reconciliation failed', 'error');
    }
  };

  // Statement CSV import (parse in browser)
  const handleImportCSV = (e) => {
    const file = e.target.files?.[0];
    if (!file || !recAcct) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target.result;
      const rows = text.split('\n').slice(1).filter(Boolean); // skip header
      const lines = rows.map(row => {
        const cols = row.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        // Best-effort: date, description, debit, credit, balance
        return {
          date: cols[0] || today(),
          description: cols[1] || '',
          debit:  parseFloat(cols[2]) || 0,
          credit: parseFloat(cols[3]) || 0,
          balance: cols[4] ? parseFloat(cols[4]) : null,
        };
      }).filter(l => l.debit > 0 || l.credit > 0);
      try {
        await api.post(`/finance/bank-accounts/${recAcct.id}/statement-lines`, { lines });
        showToast(`Imported ${lines.length} statement lines`);
        await startReconcile(recAcct);
      } catch {
        showToast('Import failed', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // ── Stats ────────────────────────────────────────────────────────────────────
  const matchedStmt   = stmtLines.filter(s => s.reconciled).length;
  const unmatchedStmt = stmtLines.filter(s => !s.reconciled).length;
  const bookBalance   = parseFloat(recAcct?.current_balance || 0);
  const stmtBal       = parseFloat(statementBal || 0);
  const difference    = stmtBal - bookBalance;
  const isReconciled  = Math.abs(difference) < 0.01;

  const totalBalance  = accounts.reduce((s, a) => s + parseFloat(a.current_balance || 0), 0);
  const totalUnrecon  = accounts.reduce((s, a) => s + parseInt(a.unreconciled_count || 0), 0);
  const totalInflow   = accounts.reduce((s, a) => s + parseFloat(a.mtd_inflow || 0), 0);
  const totalOutflow  = accounts.reduce((s, a) => s + parseFloat(a.mtd_outflow || 0), 0);
  const needsRecon    = accounts.filter(a => parseInt(a.unreconciled_count || 0) > 0).length;

  return (
    <div className="ba-root">

      {toast && (
        <div className={`ba-toast ba-toast-${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="ba-header">
        <div>
          <h2 className="ba-title">Bank Accounts & Reconciliation</h2>
          <p className="ba-sub">
            {accounts.length} account{accounts.length !== 1 ? 's' : ''} · Total balance: {fmtFull(totalBalance)}
          </p>
        </div>
        <div className="ba-header-r">
          <button className="ba-btn-outline" onClick={loadAccounts}><RefreshCw size={14} /> Refresh</button>
          <button className="ba-btn-primary" onClick={() => { setEditTarget(null); setForm(EMPTY_FORM); setFormErrors({}); setDrawer('create'); }}>
            <Plus size={15} /> Add Account
          </button>
        </div>
      </div>

      {/* Summary KPI strip */}
      <div className="ba-summary">
        <div className="ba-sum-card ba-sum-main">
          <Banknote size={20} color="#6366f1" />
          <div>
            <p className="ba-sum-label">Total Cash & Bank</p>
            <p className="ba-sum-big">{fmtFull(totalBalance)}</p>
            <p className="ba-sum-sub">Across {accounts.length} accounts</p>
          </div>
        </div>
        <div className="ba-sum-card">
          <TrendingUp size={18} color="#10b981" />
          <div>
            <p className="ba-sum-label">Total Inflow (MTD)</p>
            <p className="ba-sum-val green">{fmtFull(totalInflow)}</p>
          </div>
        </div>
        <div className="ba-sum-card">
          <TrendingDown size={18} color="#ef4444" />
          <div>
            <p className="ba-sum-label">Total Outflow (MTD)</p>
            <p className="ba-sum-val red">{fmtFull(totalOutflow)}</p>
          </div>
        </div>
        <div className={`ba-sum-card ${totalUnrecon > 0 ? 'ba-sum-warn' : ''}`}>
          <AlertCircle size={18} color={totalUnrecon > 0 ? '#f59e0b' : '#10b981'} />
          <div>
            <p className="ba-sum-label">Unreconciled</p>
            <p className={`ba-sum-val ${totalUnrecon > 0 ? 'amber' : ''}`}>{totalUnrecon} transactions</p>
            <p className="ba-sum-sub">{needsRecon} account{needsRecon !== 1 ? 's' : ''} need reconciliation</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="ba-tabs">
        <button className={`ba-tab${activeTab === 'accounts' ? ' active' : ''}`}
          onClick={() => setActiveTab('accounts')}>
          <Building2 size={14} /> Accounts
        </button>
        <button className={`ba-tab${activeTab === 'reconcile' ? ' active' : ''}`}
          onClick={() => recAcct && setActiveTab('reconcile')}>
          <RotateCcw size={14} /> Reconciliation
          {totalUnrecon > 0 && <span className="ba-tab-badge">{totalUnrecon}</span>}
        </button>
      </div>

      {/* ── ACCOUNTS TAB ──────────────────────────────────── */}
      {activeTab === 'accounts' && (
        <>
          {loading ? (
            <div className="ba-loading">Loading accounts…</div>
          ) : accounts.length === 0 ? (
            <div className="ba-empty-state">
              <Building2 size={48} color="#9ca3af" />
              <h3>No bank accounts configured</h3>
              <p>Add your company's bank accounts to track cash flow, process payments, and reconcile transactions.</p>
              <button className="ba-btn-primary" onClick={() => { setDrawer('create'); }}>
                <Plus size={15} /> Add Bank Account
              </button>
              <ul className="ba-empty-tips">
                <li>Add your primary operating account first</li>
                <li>Link each account to a Chart of Accounts entry (1002 Bank Accounts)</li>
                <li>Opening balance = current bank balance as of today</li>
              </ul>
            </div>
          ) : (
            <div className="ba-accounts-grid">
              {accounts.map(acct => {
                const color = ACCOUNT_COLORS[acct.account_type] || ACCOUNT_COLORS.current;
                const tc = typeColor(acct.account_type);
                const unrecon = parseInt(acct.unreconciled_count || 0);
                return (
                  <div key={acct.id} className="ba-acct-card">
                    <div className="ba-acct-card-hd" style={{ borderTopColor: color }}>
                      <div className="ba-acct-icon" style={{ background: color + '18', color }}>
                        {acct.account_type === 'cash' ? <Banknote size={18} /> : <Building2 size={18} />}
                      </div>
                      <div className="ba-acct-info">
                        <h4 className="ba-acct-name">
                          {acct.account_name}
                          {acct.is_primary && <span className="ba-primary-badge">Primary</span>}
                        </h4>
                        <p className="ba-acct-bank">{acct.bank_name}</p>
                      </div>
                      <span className="ba-acct-type-badge" style={{ background: tc.bg, color: tc.c }}>
                        {acct.account_type}
                      </span>
                    </div>

                    <div className="ba-acct-card-body">
                      <div className="ba-acct-balance-row">
                        <div>
                          <p className="ba-bal-label">Current Balance</p>
                          <p className="ba-bal-val" style={{ color }}>
                            {fmtFull(acct.current_balance)}
                          </p>
                        </div>
                        <div className="ba-bal-right">
                          <p className="ba-bal-label">MTD Inflow / Outflow</p>
                          <p className="ba-bal-book">
                            <span className="green">+{fmt(acct.mtd_inflow)}</span>
                            {' / '}
                            <span className="red">-{fmt(acct.mtd_outflow)}</span>
                          </p>
                        </div>
                      </div>

                      <div className="ba-acct-meta">
                        <div className="ba-acct-meta-item">
                          <span>Account #</span>
                          <strong>••{(acct.account_number || '').slice(-4) || '—'}</strong>
                        </div>
                        <div className="ba-acct-meta-item">
                          <span>IFSC</span>
                          <strong>{acct.ifsc_code || '—'}</strong>
                        </div>
                        <div className="ba-acct-meta-item">
                          <span>Unreconciled</span>
                          <strong className={unrecon > 0 ? 'amber' : ''}>{unrecon} txns</strong>
                        </div>
                        <div className="ba-acct-meta-item">
                          <span>Last Reconciled</span>
                          <strong>
                            {acct.last_reconciled_at
                              ? new Date(acct.last_reconciled_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                              : 'Never'}
                          </strong>
                        </div>
                      </div>
                    </div>

                    <div className="ba-acct-card-footer">
                      <button className="ba-acct-btn" onClick={() => openTransactions(acct)}>
                        <Eye size={13} /> Transactions
                      </button>
                      <button className="ba-acct-btn ba-recon-btn" onClick={() => startReconcile(acct)}>
                        <RotateCcw size={13} />
                        {unrecon > 0 ? `Reconcile (${unrecon})` : 'Reconcile'}
                      </button>
                      <button className="ba-acct-btn" onClick={() => openEdit(acct)}><Edit2 size={13} /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ── RECONCILIATION TAB ──────────────────────────── */}
      {activeTab === 'reconcile' && recAcct && (
        <div className="ba-recon-wrap">

          {/* Account selector pills */}
          <div className="ba-recon-acct-bar">
            <span className="ba-recon-label">Reconciling:</span>
            <div className="ba-recon-acct-pills">
              {accounts.map(a => {
                const color = ACCOUNT_COLORS[a.account_type] || ACCOUNT_COLORS.current;
                return (
                  <button key={a.id}
                    className={`ba-recon-pill ${recAcct.id === a.id ? 'active' : ''}`}
                    style={recAcct.id === a.id ? { background: color, borderColor: color } : {}}
                    onClick={() => startReconcile(a)}>
                    {a.account_name}
                    {parseInt(a.unreconciled_count || 0) > 0 && (
                      <span className="ba-pill-badge">{a.unreconciled_count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Balance panel */}
          <div className="ba-balance-panel">
            <div className="ba-bp-item">
              <span className="ba-bp-label">Statement Closing Balance</span>
              <div className="ba-bp-input-wrap">
                <span className="ba-bp-prefix">₹</span>
                <input className="ba-bp-input" type="number" value={statementBal}
                  onChange={e => setStatementBal(e.target.value)} />
              </div>
            </div>
            <div className="ba-bp-sep">—</div>
            <div className="ba-bp-item">
              <span className="ba-bp-label">Book Balance (ERP)</span>
              <span className="ba-bp-val">{fmtFull(bookBalance)}</span>
            </div>
            <div className="ba-bp-sep">=</div>
            <div className={`ba-bp-item ba-bp-diff ${isReconciled ? 'ba-bp-ok' : 'ba-bp-err'}`}>
              <span className="ba-bp-label">Difference</span>
              <span className="ba-bp-diff-val">
                {isReconciled
                  ? <><CheckCircle size={14} /> Balanced</>
                  : fmtFull(Math.abs(difference))}
              </span>
            </div>
            {isReconciled && (
              <button className="ba-complete-btn" onClick={handleCompleteReconciliation}>
                <CheckCircle size={14} /> Complete Reconciliation
              </button>
            )}
          </div>

          {/* Controls: upload + auto-match */}
          <div className="ba-recon-controls">
            <div className="ba-recon-stats">
              <div className="ba-rs-item green"><Link size={13} /><span>{matchedStmt} matched</span></div>
              <div className="ba-rs-item amber"><Unlink size={13} /><span>{unmatchedStmt} unmatched</span></div>
              <div className="ba-rs-item"><FileText size={13} /><span>{stmtLines.length} statement lines</span></div>
            </div>
            <div className="ba-recon-actions">
              <label className="ba-btn-outline ba-upload-label">
                <Upload size={13} /> Upload Statement (CSV)
                <input type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImportCSV} />
              </label>
              <button className="ba-btn-primary" onClick={handleAutoMatch} disabled={autoMatching}>
                <RefreshCw size={13} /> {autoMatching ? 'Matching…' : 'Auto-Match'}
              </button>
            </div>
          </div>

          {/* Two-column: Bank Statement | Book Entries */}
          <div className="ba-recon-columns">

            {/* Bank Statement */}
            <div className="ba-recon-col">
              <div className="ba-recon-col-hd">
                <h4>Bank Statement</h4>
                <span className="ba-recon-col-sub">{stmtLines.length} imported lines</span>
              </div>
              {stmtLines.length === 0 ? (
                <div className="ba-recon-empty">
                  Upload a bank statement CSV to start matching
                </div>
              ) : (
                <table className="ba-recon-table">
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}></th>
                      <th>Date</th>
                      <th>Description</th>
                      <th className="ba-th-r">Debit</th>
                      <th className="ba-th-r">Credit</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stmtLines.map(line => (
                      <tr key={line.id}
                        className={`ba-recon-tr ${line.reconciled ? 'ba-tr-matched' : ''} ${checkedStmt[line.id] ? 'ba-tr-checked' : ''}`}>
                        <td>
                          <input type="checkbox" className="ba-checkbox"
                            checked={!!checkedStmt[line.id]}
                            onChange={() => toggleStmt(line.id)}
                            disabled={line.reconciled} />
                        </td>
                        <td className="ba-td-date">
                          {new Date(line.stmt_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </td>
                        <td><span className="ba-td-desc">{line.description}</span></td>
                        <td className="ba-th-r ba-td-dr">{parseFloat(line.debit) > 0 ? fmtFull(line.debit) : '—'}</td>
                        <td className="ba-th-r ba-td-cr">{parseFloat(line.credit) > 0 ? fmtFull(line.credit) : '—'}</td>
                        <td>
                          {line.reconciled
                            ? <div className="ba-matched-badge"><Link size={11} /> Matched</div>
                            : (
                              Object.keys(checkedBook).some(k => checkedBook[k])
                                ? (
                                  <button className="ba-match-btn"
                                    onClick={() => {
                                      const txnId = parseInt(Object.keys(checkedBook).find(k => checkedBook[k]));
                                      handleManualMatch(line.id, txnId);
                                      setCheckedBook({});
                                    }}>
                                    <Link size={11} /> Match
                                  </button>
                                )
                                : <span className="ba-unmatched-badge"><Unlink size={11} /> Open</span>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Book Entries */}
            <div className="ba-recon-col">
              <div className="ba-recon-col-hd">
                <h4>Book Entries (ERP)</h4>
                <span className="ba-recon-col-sub">Unreconciled transactions</span>
              </div>
              {bookTxns.length === 0 ? (
                <div className="ba-recon-empty">No unreconciled book entries</div>
              ) : (
                <table className="ba-recon-table">
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}></th>
                      <th>Date</th>
                      <th>Description</th>
                      <th className="ba-th-r">Debit</th>
                      <th className="ba-th-r">Credit</th>
                      <th>Ref</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookTxns.map(txn => (
                      <tr key={txn.id}
                        className={`ba-recon-tr ${checkedBook[txn.id] ? 'ba-tr-checked' : ''}`}>
                        <td>
                          <input type="checkbox" className="ba-checkbox"
                            checked={!!checkedBook[txn.id]}
                            onChange={() => toggleBook(txn.id)} />
                        </td>
                        <td className="ba-td-date">
                          {new Date(txn.transaction_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </td>
                        <td><span className="ba-td-desc">{txn.description}</span></td>
                        <td className="ba-th-r ba-td-dr">
                          {txn.transaction_type === 'Debit' ? fmtFull(txn.amount) : '—'}
                        </td>
                        <td className="ba-th-r ba-td-cr">
                          {txn.transaction_type === 'Credit' ? fmtFull(txn.amount) : '—'}
                        </td>
                        <td><span className="ba-txn-ref">{txn.reference_number || '—'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Reconciliation summary */}
          <div className="ba-recon-summary">
            <h4>Reconciliation Summary</h4>
            <div className="ba-rs-grid">
              <div className="ba-rs-row"><span>Book Balance (ERP)</span><strong>{fmtFull(bookBalance)}</strong></div>
              <div className="ba-rs-row"><span>Bank Statement Balance</span><strong>{fmtFull(stmtBal)}</strong></div>
              <div className={`ba-rs-row ba-rs-diff ${isReconciled ? 'ba-rs-ok' : 'ba-rs-warn'}`}>
                <span>Difference</span>
                <strong>{isReconciled ? '₹0.00 ✓' : fmtFull(Math.abs(difference))}</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Transaction Detail Drawer ──────────────────── */}
      {activeAcct && (
        <div className="ba-overlay" onClick={() => setActiveAcct(null)}>
          <div className="ba-drawer" onClick={e => e.stopPropagation()}>
            <div className="ba-drawer-hd">
              <div>
                <h3>{activeAcct.account_name}</h3>
                <p className="ba-drawer-sub">
                  {activeAcct.bank_name} · ••{(activeAcct.account_number || '').slice(-4) || '—'}
                </p>
              </div>
              <button className="ba-icon-btn" onClick={() => setActiveAcct(null)}><X size={18} /></button>
            </div>
            <div className="ba-drawer-body">
              <div className="ba-txn-summary">
                <div className="ba-txn-bal">
                  <span>Current Balance</span>
                  <strong style={{ color: ACCOUNT_COLORS[activeAcct.account_type] || '#6366f1' }}>
                    {fmtFull(activeAcct.current_balance)}
                  </strong>
                </div>
                <div className="ba-txn-bal">
                  <span>MTD Inflow</span>
                  <strong className="green">+{fmtFull(activeAcct.mtd_inflow)}</strong>
                </div>
                <div className="ba-txn-bal">
                  <span>Unreconciled</span>
                  <strong className={parseInt(activeAcct.unreconciled_count || 0) > 0 ? 'amber' : ''}>
                    {activeAcct.unreconciled_count || 0} txns
                  </strong>
                </div>
              </div>
              {txnsLoading ? (
                <div className="ba-loading">Loading transactions…</div>
              ) : acctTxns.length === 0 ? (
                <div className="ba-recon-empty">No transactions found for last 90 days</div>
              ) : (
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
                    {acctTxns.map((txn, i) => (
                      <tr key={i}>
                        <td className="ba-td-date">
                          {new Date(txn.transaction_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </td>
                        <td className="ba-td-desc">{txn.description}</td>
                        <td><span className="ba-txn-ref">{txn.reference_number || '—'}</span></td>
                        <td className="ba-th-r ba-td-dr">
                          {txn.transaction_type === 'Debit' ? fmtFull(txn.amount) : '—'}
                        </td>
                        <td className="ba-th-r ba-td-cr">
                          {txn.transaction_type === 'Credit' ? fmtFull(txn.amount) : '—'}
                        </td>
                        <td className="ba-th-r ba-td-bal">{fmtFull(txn.balance_after)}</td>
                        <td>
                          {txn.reconciled
                            ? <span className="ba-matched-sm"><Link size={11} /> Matched</span>
                            : <span className="ba-open-sm"><Unlink size={11} /> Open</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button className="ba-start-recon-btn"
                onClick={() => { const acct = activeAcct; setActiveAcct(null); startReconcile(acct); }}>
                <RotateCcw size={14} /> Start Reconciliation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add / Edit Account Drawer ──────────────────── */}
      {(drawer === 'create' || drawer === 'edit') && (
        <div className="ba-overlay" onClick={() => setDrawer(null)}>
          <div className="ba-drawer" onClick={e => e.stopPropagation()}>
            <div className="ba-drawer-hd">
              <div>
                <h3>{drawer === 'edit' ? 'Edit Bank Account' : 'Add Bank Account'}</h3>
                <p className="ba-drawer-sub">
                  {drawer === 'edit' ? 'Update account details' : 'Connect a new bank account'}
                </p>
              </div>
              <button className="ba-icon-btn" onClick={() => setDrawer(null)}><X size={18} /></button>
            </div>
            <div className="ba-drawer-body">
              <div className="ba-form-row">
                <div className="ba-field">
                  <label>Account Name *</label>
                  <input value={form.account_name}
                    className={formErrors.account_name ? 'ba-input-err' : ''}
                    onChange={e => setForm(f => ({ ...f, account_name: e.target.value }))}
                    placeholder="e.g. HDFC Current Account" />
                  {formErrors.account_name && <span className="ba-err">{formErrors.account_name}</span>}
                </div>
                <div className="ba-field">
                  <label>Bank Name *</label>
                  <input value={form.bank_name}
                    className={formErrors.bank_name ? 'ba-input-err' : ''}
                    onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))}
                    placeholder="HDFC / ICICI / SBI…" />
                  {formErrors.bank_name && <span className="ba-err">{formErrors.bank_name}</span>}
                </div>
              </div>
              <div className="ba-form-row">
                <div className="ba-field">
                  <label>Account Number</label>
                  <input value={form.account_number}
                    onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))}
                    placeholder="Full account number" />
                </div>
                <div className="ba-field">
                  <label>IFSC Code</label>
                  <input value={form.ifsc_code}
                    className={formErrors.ifsc_code ? 'ba-input-err' : ''}
                    onChange={e => setForm(f => ({ ...f, ifsc_code: e.target.value.toUpperCase() }))}
                    placeholder="HDFC0001234" maxLength={11} />
                  {formErrors.ifsc_code && <span className="ba-err">{formErrors.ifsc_code}</span>}
                </div>
              </div>
              <div className="ba-form-row">
                <div className="ba-field">
                  <label>Account Type</label>
                  <select value={form.account_type}
                    onChange={e => setForm(f => ({ ...f, account_type: e.target.value }))}>
                    <option value="current">Current Account</option>
                    <option value="savings">Savings Account</option>
                    <option value="cash">Petty Cash</option>
                    <option value="od">Overdraft (OD)</option>
                    <option value="cc">Cash Credit (CC)</option>
                    <option value="fixed">Fixed Deposit</option>
                  </select>
                </div>
                <div className="ba-field">
                  <label>Currency</label>
                  <select value={form.currency}
                    onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
                    <option value="INR">INR — Indian Rupee</option>
                    <option value="USD">USD — US Dollar</option>
                    <option value="EUR">EUR — Euro</option>
                  </select>
                </div>
              </div>
              <div className="ba-form-row">
                <div className="ba-field">
                  <label>Opening Balance (₹)</label>
                  <input type="number" value={form.opening_balance}
                    className={formErrors.opening_balance ? 'ba-input-err' : ''}
                    onChange={e => setForm(f => ({ ...f, opening_balance: e.target.value }))}
                    placeholder="0.00" />
                  {formErrors.opening_balance && <span className="ba-err">{formErrors.opening_balance}</span>}
                </div>
                <div className="ba-field">
                  <label>Opening Balance Date</label>
                  <input type="date" value={form.opening_date}
                    onChange={e => setForm(f => ({ ...f, opening_date: e.target.value }))} />
                </div>
              </div>
              <div className="ba-form-row">
                <div className="ba-field">
                  <label>Branch</label>
                  <input value={form.branch}
                    onChange={e => setForm(f => ({ ...f, branch: e.target.value }))}
                    placeholder="Branch name" />
                </div>
                <div className="ba-field ba-field-check">
                  <label className="ba-check-label">
                    <input type="checkbox" checked={form.is_primary}
                      onChange={e => setForm(f => ({ ...f, is_primary: e.target.checked }))} />
                    Set as Primary Account
                  </label>
                  <span className="ba-hint">Default account for payments</span>
                </div>
              </div>
              <div className="ba-drawer-footer">
                <button className="ba-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                {drawer === 'edit' && (
                  <button className="ba-btn-danger"
                    onClick={() => { handleDeactivate(editTarget); setDrawer(null); }}>
                    Deactivate
                  </button>
                )}
                <button className="ba-btn-primary" onClick={handleSaveAccount} disabled={saving}>
                  {saving ? 'Saving…' : (drawer === 'edit' ? 'Save Changes' : <><Plus size={14} /> Add Account</>)}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
