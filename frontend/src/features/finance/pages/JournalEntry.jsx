import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, RefreshCw, Lock, Unlock,
  FileText, ArrowRight, Printer, Trash2, RotateCcw, Pencil,
} from 'lucide-react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { useFY } from '@/context/FYContext';
import { fmt, fmtFull, today } from '../financeUtils';
import './JournalEntry.css';


const ENTRY_TYPES = [
  { value:'manual',      label:'Manual Entry' },
  { value:'accrual',     label:'Accrual' },
  { value:'depreciation',label:'Depreciation' },
  { value:'adjustment',  label:'Adjustment' },
  { value:'reversal',    label:'Reversal' },
  { value:'opening',     label:'Opening Balance' },
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

const emptyLine = () => ({ account_id:'', account_name:'', account_code:'', debit:0, credit:0, narration:'' });

// ── Debit/Credit input ────────────────────────────────────────────────────────
const DCInput = ({ value, onChange, type }) => (
  <input
    type="number" min="0" step="0.01"
    value={value === 0 ? '' : value}
    placeholder="0.00"
    className={`je-dc-input ${value > 0 ? `je-dc-${type}` : ''}`}
    onChange={e => onChange(parseFloat(e.target.value) || 0)}
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
  const [entries,       setEntries]       = useState([]);
  const [accounts,      setAccounts]      = useState([]);
  const [loading,       setLoading]       = useState(false);
  const [drawer,        setDrawer]        = useState(null); // null | 'create' | entry object (edit)
  const [viewEntry,     setViewEntry]     = useState(null);
  const [search,        setSearch]        = useState('');
  const [statusFilter,  setStatusFilter]  = useState('');
  const { availableFYs } = useFY();
  const [fyFilter,      setFyFilter]      = useState('all');
  const [toast,         setToast]         = useState(null);
  const [submitting,    setSubmitting]    = useState(false);
  const [activeTab,     setActiveTab]     = useState('entries');
  const [actionId,      setActionId]      = useState(null); // entry id with pending action
  const [pendingDelete,  setPendingDelete]  = useState(null);
  const [pendingReverse, setPendingReverse] = useState(null);

  // GL tab state
  const fyYear = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const [glAccountId, setGlAccountId] = useState('');
  const [glData,      setGlData]      = useState(null);
  const [glLoading,   setGlLoading]   = useState(false);
  const [glDateFrom,  setGlDateFrom]  = useState(`${fyYear}-04-01`);
  const [glDateTo,    setGlDateTo]    = useState(today());

  // form state
  const [form, setForm] = useState({
    reference_number: '',
    entry_date:       today(),
    entry_type:       'manual',
    narration:        '',
    lines:            [emptyLine(), emptyLine()],
  });

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  // ── Load entries + accounts ───────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [jeRes, accRes] = await Promise.allSettled([
        api.get('/accounting/journal-entries', { params: { limit: 100 } }),
        api.get('/accounting/chart-of-accounts'),
      ]);
      setEntries(jeRes.status  === 'fulfilled' ? (jeRes.value.data?.entries  || []) : []);
      setAccounts(accRes.status === 'fulfilled' ? (accRes.value.data          || []) : []);
      if (accRes.status === 'rejected') {
        console.error('[JournalEntry] chart-of-accounts load failed:', accRes.reason);
        showToast('Could not load Chart of Accounts — account list will be empty', 'error');
      }
    } catch(e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── GL fetch ──────────────────────────────────────────────────────────────
  const loadGL = useCallback(async () => {
    if (!glAccountId) return;
    setGlLoading(true);
    try {
      const res = await api.get(`/accounting/general-ledger/${glAccountId}`, {
        params: { date_from: glDateFrom, date_to: glDateTo },
      });
      setGlData(res.data);
    } catch(e) {
      showToast('Failed to load general ledger', 'error');
      setGlData(null);
    } finally { setGlLoading(false); }
  }, [glAccountId, glDateFrom, glDateTo]);

  useEffect(() => { if (glAccountId) loadGL(); }, [glAccountId, loadGL]);

  // ── Line helpers ──────────────────────────────────────────────────────────
  const updateLine = (idx, field, val) => {
    setForm(f => {
      const lines = f.lines.map((l, i) => {
        if (i !== idx) return l;
        const updated = { ...l, [field]: val };
        if (field === 'debit'  && val > 0) updated.credit = 0;
        if (field === 'credit' && val > 0) updated.debit  = 0;
        return updated;
      });
      return { ...f, lines };
    });
  };

  const updateLineAccount = (idx, accountId) => {
    const acc = accounts.find(a => String(a.id) === String(accountId));
    setForm(f => {
      const lines = f.lines.map((l, i) =>
        i === idx
          ? { ...l, account_id: accountId, account_name: acc?.name || acc?.account_name || '', account_code: acc?.code || acc?.account_code || '' }
          : l
      );
      return { ...f, lines };
    });
  };

  const addLine    = () => setForm(f => ({ ...f, lines: [...f.lines, emptyLine()] }));
  const removeLine = (idx) => {
    if (form.lines.length <= 2) { showToast('Minimum 2 lines required', 'error'); return; }
    setForm(f => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }));
  };

  // ── Balance check ─────────────────────────────────────────────────────────
  const totalDebit  = form.lines.reduce((s, l) => s + parseFloat(l.debit  || 0), 0);
  const totalCredit = form.lines.reduce((s, l) => s + parseFloat(l.credit || 0), 0);
  const isBalanced  = Math.abs(totalDebit - totalCredit) < 0.01;
  const difference  = totalDebit - totalCredit;

  const autoBalance = () => {
    if (isBalanced) return;
    const diff = Math.abs(difference);
    let emptyIdx = -1;
    for (let i = form.lines.length - 1; i >= 0; i--) { if (!form.lines[i].debit && !form.lines[i].credit) { emptyIdx = i; break; } }
    if (emptyIdx >= 0) {
      updateLine(emptyIdx, difference > 0 ? 'credit' : 'debit', diff);
    } else {
      const newLine = { ...emptyLine(), [difference > 0 ? 'credit' : 'debit']: diff };
      setForm(f => ({ ...f, lines: [...f.lines, newLine] }));
    }
  };

  // ── CRUD handlers ─────────────────────────────────────────────────────────
  const handleSubmit = async (post = false) => {
    if (!form.narration.trim())                    { showToast('Narration is required', 'error'); return; }
    if (!isBalanced)                               { showToast('Entry must be balanced before posting', 'error'); return; }
    if (form.lines.some(l => !l.account_id))       { showToast('All lines must have an account selected', 'error'); return; }

    setSubmitting(true);
    try {
      const payload = {
        entry_date:  form.entry_date,
        description: form.narration,
        entry_type:  form.entry_type,
        lines: form.lines.map(l => ({
          // account_id is a UUID (chart_of_accounts.id) — never parseInt it, that
          // corrupts the id and the backend rejects the entry.
          account_id: l.account_id,
          debit:      parseFloat(l.debit  || 0),
          credit:     parseFloat(l.credit || 0),
          narration:  l.narration || '',
        })),
      };

      let savedEntry;
      if (drawer && drawer !== 'create' && drawer.id) {
        const res = await api.put(`/accounting/journal-entries/${drawer.id}`, payload);
        savedEntry = res.data;
      } else {
        const res = await api.post('/accounting/journal-entries', payload);
        savedEntry = res.data;
      }

      if (post && savedEntry?.id) {
        await api.post(`/accounting/journal-entries/${savedEntry.id}/post`);
      }

      showToast(post ? 'Journal entry posted successfully' : 'Saved as draft');
      setDrawer(null);
      resetForm();
      load();
    } catch(e) {
      showToast(e.response?.data?.error || 'Failed to save entry', 'error');
    } finally { setSubmitting(false); }
  };

  const handlePost = async (entryId) => {
    setActionId(entryId);
    try {
      await api.post(`/accounting/journal-entries/${entryId}/post`);
      showToast('Entry posted successfully');
      setViewEntry(null);
      load();
    } catch(e) {
      showToast(e.response?.data?.error || 'Failed to post entry', 'error');
    } finally { setActionId(null); }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const entryId = pendingDelete;
    setPendingDelete(null);
    setActionId(entryId);
    try {
      await api.delete(`/accounting/journal-entries/${entryId}`);
      showToast('Draft entry deleted');
      setViewEntry(null);
      setEntries(prev => prev.filter(e => e.id !== entryId));
    } catch(e) {
      showToast(e.response?.data?.error || 'Failed to delete entry', 'error');
    } finally { setActionId(null); }
  };

  const handleReverse = async () => {
    if (!pendingReverse) return;
    const entryId = pendingReverse;
    setPendingReverse(null);
    setActionId(entryId);
    try {
      await api.post(`/accounting/journal-entries/${entryId}/reverse`);
      showToast('Reversal entry created');
      setViewEntry(null);
      load();
    } catch(e) {
      showToast(e.response?.data?.error || 'Failed to create reversal', 'error');
    } finally { setActionId(null); }
  };

  const resetForm = () => setForm({
    reference_number: '',
    entry_date: today(),
    entry_type: 'manual',
    narration:  '',
    lines:      [emptyLine(), emptyLine()],
  });

  const openCreate = async () => {
    resetForm();
    setDrawer('create');
    try {
      const res = await api.get('/finance/next-journal-voucher');
      setForm(f => ({ ...f, reference_number: res.data.reference }));
    } catch {
      setForm(f => ({ ...f, reference_number: `JV-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase().slice(-6)}` }));
    }
  };

  const openEdit = (entry) => {
    setForm({
      reference_number: entry.entry_number || '',
      entry_date:  entry.entry_date?.split('T')[0] || today(),
      entry_type:  entry.reference_type || 'manual',
      narration:   entry.description || '',
      lines: (entry.lines || []).map(l => ({
        account_id:   String(l.account_id),
        account_name: l.account_name || '',
        account_code: l.account_code || '',
        debit:        parseFloat(l.debit  || 0),
        credit:       parseFloat(l.credit || 0),
        narration:    l.narration || '',
      })),
    });
    setDrawer(entry);
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const isEntryUnbalanced = (e) =>
    e.status === 'draft' &&
    Math.abs(parseFloat(e.total_debit || 0) - parseFloat(e.total_credit || 0)) > 0.01;

  const typeLabel = (val) =>
    ENTRY_TYPES.find(t => t.value === val)?.label || val || 'Manual';

  // ── Filter ────────────────────────────────────────────────────────────────
  const jeFyRange = availableFYs.find(f => f.fy === fyFilter) || null;
  const filtered = entries.filter(e => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      (e.entry_number || '').toLowerCase().includes(q) ||
      (e.description  || '').toLowerCase().includes(q);
    const matchStatus = !statusFilter || e.status === statusFilter;
    let matchFY = true;
    if (jeFyRange) {
      const d = (e.entry_date || '').slice(0, 10);
      matchFY = d && d >= jeFyRange.startStr && d <= jeFyRange.endStr;
    }
    return matchSearch && matchStatus && matchFY;
  });

  const exportJECsv = () => {
    const rows = [
      ['Entry #', 'Date', 'Type', 'Description', 'Total Debit', 'Total Credit', 'Status'],
      ...filtered.map(e => [
        e.entry_number, e.entry_date?.slice(0, 10) || '',
        typeLabel(e.entry_type), e.description || '',
        parseFloat(e.total_debit || 0).toFixed(2),
        parseFloat(e.total_credit || 0).toFixed(2),
        e.status || '',
      ])
    ];
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = `journal-entries-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
  };

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = {
    total:    entries.length,
    posted:   entries.filter(e => e.status === 'posted').length,
    draft:    entries.filter(e => e.status === 'draft').length,
    totalAmt: entries.reduce((s, e) => s + parseFloat(e.total_debit || 0), 0),
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="je-root">
      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete Draft Entry"
        message="Delete this draft entry? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={!!pendingReverse}
        title="Create Reversal"
        message="Create a reversal entry? The original will be marked as reversed."
        confirmLabel="Create Reversal"
        variant="warning"
        onConfirm={handleReverse}
        onCancel={() => setPendingReverse(null)}
      />

      {/* Toast */}
      {toast && (
        <div className={`je-toast je-toast-${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle size={14}/> : <AlertTriangle size={14}/>}
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
          <button className="je-btn-outline" onClick={exportJECsv}><Download size={14}/> Export</button>
          <button className="je-btn-outline" onClick={() => window.print()}><Printer size={14}/> Print</button>
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
        <button className={`je-tab${activeTab === 'entries' ? ' active' : ''}`}
          onClick={() => setActiveTab('entries')}>
          <FileText size={14}/> Journal Entries
        </button>
        <button className={`je-tab${activeTab === 'ledger' ? ' active' : ''}`}
          onClick={() => setActiveTab('ledger')}>
          <ArrowRight size={14}/> General Ledger
        </button>
      </div>

      {/* ── Entries Tab ── */}
      {activeTab === 'entries' && (
        <>
          <div className="je-filters">
            <div className="je-search">
              <Search size={14}/>
              <input placeholder="Search by reference or narration…"
                value={search} onChange={e => setSearch(e.target.value)}/>
              {search && <button className="je-clear" onClick={() => setSearch('')}><X size={12}/></button>}
            </div>
            <div className="je-filter-tabs">
              {[
                { value:'',         label:'All' },
                { value:'posted',   label:'Posted' },
                { value:'draft',    label:'Draft' },
                { value:'reversed', label:'Reversed' },
              ].map(s => (
                <button key={s.value}
                  className={`je-filter-tab${statusFilter === s.value ? ' active' : ''}`}
                  onClick={() => setStatusFilter(s.value)}>
                  {s.label}
                </button>
              ))}
            </div>
            <select value={fyFilter} onChange={e => setFyFilter(e.target.value)}
              title="Filter by entry Financial Year"
              style={{ marginLeft: 'auto', padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}>
              <option value="all">All Financial Years</option>
              {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
            </select>
          </div>

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
                  {filtered.map((entry, i) => {
                    const unbalanced = isEntryUnbalanced(entry);
                    return (
                      <tr key={entry.id || i} className="je-tr"
                          style={unbalanced ? { background:'#fff5f5' } : undefined}>
                        <td>
                          <button className="je-link" onClick={() => setViewEntry(entry)}>
                            {entry.entry_number}
                          </button>
                        </td>
                        <td className="je-td-date">
                          {entry.entry_date
                            ? new Date(entry.entry_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                            : '—'}
                        </td>
                        <td>
                          <span className="je-type-badge">
                            {typeLabel(entry.reference_type)}
                          </span>
                        </td>
                        <td className="je-td-narr">{entry.description}</td>
                        <td className="je-td-center">{entry.lines?.length || '—'}</td>
                        <td className="je-td-dr">{fmtFull(entry.total_debit)}</td>
                        <td className={`je-td-cr${unbalanced ? ' je-unbalanced-cell' : ''}`}>
                          {fmtFull(entry.total_credit)}
                          {unbalanced && (
                            <AlertTriangle size={12} color="#dc2626"
                              style={{ marginLeft:4, verticalAlign:'middle' }}
                              title={`Unbalanced: ₹${Math.abs(parseFloat(entry.total_debit||0) - parseFloat(entry.total_credit||0)).toFixed(2)} diff`}/>
                          )}
                        </td>
                        <td><StatusBadge status={entry.status}/></td>
                        <td>
                          <div className="je-row-actions">
                            <button className="je-action-btn" title="View"
                              onClick={() => setViewEntry(entry)}>
                              <Eye size={13}/>
                            </button>
                            {entry.status === 'draft' && (<>
                              <button className="je-action-btn" title="Edit"
                                onClick={() => openEdit(entry)}>
                                <Pencil size={13}/>
                              </button>
                              <button className="je-action-btn je-post-btn" title="Post Entry"
                                disabled={unbalanced || actionId === entry.id}
                                onClick={() => handlePost(entry.id)}>
                                <Lock size={13}/>
                              </button>
                              <button className="je-action-btn je-delete-btn" title="Delete Draft"
                                disabled={actionId === entry.id}
                                onClick={() => setPendingDelete(entry.id)}>
                                <Trash2 size={13}/>
                              </button>
                            </>)}
                            {entry.status === 'posted' && (
                              <button className="je-action-btn je-reverse-btn" title="Create Reversal"
                                disabled={actionId === entry.id}
                                onClick={() => setPendingReverse(entry.id)}>
                                <RotateCcw size={13}/>
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* ── General Ledger Tab ── */}
      {activeTab === 'ledger' && (
        <div className="je-ledger-wrap">
          <div className="je-ledger-header">
            <h3>General Ledger</h3>
            <span className="je-ledger-sub">Account-level transaction history with running balance</span>
          </div>

          <div style={{ display:'flex', gap:10, alignItems:'center', padding:'14px 20px', borderBottom:'1px solid #f0f0f4', flexWrap:'wrap' }}>
            <select className="je-line-select" style={{ flex:2, minWidth:220 }}
              value={glAccountId} onChange={e => setGlAccountId(e.target.value)}>
              <option value="">— Select Account —</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>
                  {(a.code || a.account_code || '')} — {(a.name || a.account_name || '')}
                </option>
              ))}
            </select>
            <input type="date" className="je-line-input" value={glDateFrom}
              onChange={e => setGlDateFrom(e.target.value)} style={{ width:140 }}/>
            <span style={{ color:'#6b7280', fontSize:13 }}>to</span>
            <input type="date" className="je-line-input" value={glDateTo}
              onChange={e => setGlDateTo(e.target.value)} style={{ width:140 }}/>
            <button className="je-btn-outline" onClick={loadGL} disabled={!glAccountId || glLoading}>
              <RefreshCw size={13}/> {glLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {!glAccountId && (
            <div className="je-empty">
              <FileText size={36} color="#d1d5db"/>
              <p>Select an account to view its ledger</p>
            </div>
          )}

          {glLoading && (
            <div className="je-loading"><div className="je-spinner"/><p>Loading ledger…</p></div>
          )}

          {glData && !glLoading && (
            <>
              <div style={{ padding:'10px 20px', background:'#f5f3ff', borderBottom:'1px solid #e9e4ff', fontSize:13, color:'#5b21b6' }}>
                <strong>{glData.account?.name || glData.account?.account_name}</strong>
                {' · '}Opening: <strong>{fmtFull(glData.opening_balance)}</strong>
                {' · '}Closing: <strong>{fmtFull(glData.closing_balance)}</strong>
              </div>
              {(glData.transactions || []).length === 0 ? (
                <div className="je-empty"><p>No transactions in this period</p></div>
              ) : (
                <table className="je-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Reference</th>
                      <th>Narration</th>
                      <th className="je-th-r">Debit (₹)</th>
                      <th className="je-th-r">Credit (₹)</th>
                      <th className="je-th-r">Running Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="je-tr" style={{ fontStyle:'italic', color:'#9ca3af' }}>
                      <td colSpan={5} style={{ paddingLeft:14 }}>Opening Balance</td>
                      <td className="je-td-bal">{fmtFull(glData.opening_balance)}</td>
                    </tr>
                    {glData.transactions.map((row, i) => (
                      <tr key={i} className="je-tr">
                        <td className="je-td-date">
                          {new Date(row.entry_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </td>
                        <td>
                          <button className="je-link" onClick={async () => {
                            try {
                              const res = await api.get(`/finance/accounting/journal-entries/${row.entry_id}`);
                              setViewEntry(res.data);
                            } catch { showToast('Could not load entry', 'error'); }
                          }}>{row.entry_number}</button>
                        </td>
                        <td className="je-td-narr">{row.je_description || row.narration || '—'}</td>
                        <td className="je-td-dr">{row.debit  ? fmtFull(row.debit)  : '—'}</td>
                        <td className="je-td-cr">{row.credit ? fmtFull(row.credit) : '—'}</td>
                        <td className="je-td-bal">
                          {fmtFull(row.running_balance)}
                          <span style={{ fontSize:10, marginLeft:4, color:'#9ca3af' }}>{row.balance_indicator}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="je-tfoot">
                      <td colSpan={3}>Closing Balance</td>
                      <td className="je-td-dr">{fmtFull(glData.transactions.reduce((s, r) => s + parseFloat(r.debit  || 0), 0))}</td>
                      <td className="je-td-cr">{fmtFull(glData.transactions.reduce((s, r) => s + parseFloat(r.credit || 0), 0))}</td>
                      <td className="je-td-bal">{fmtFull(glData.closing_balance)}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </>
          )}
        </div>
      )}

      {/* ── View Entry Modal ── */}
      {viewEntry && (
        <div className="je-overlay" onClick={() => setViewEntry(null)}>
          <div className="je-modal" onClick={e => e.stopPropagation()}>
            <div className="je-modal-hd">
              <div>
                <h3>{viewEntry.entry_number}</h3>
                <p className="je-modal-sub">
                  {viewEntry.entry_date
                    ? new Date(viewEntry.entry_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                    : ''}
                  {' · '}{typeLabel(viewEntry.reference_type)}
                </p>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <StatusBadge status={viewEntry.status}/>
                {isEntryUnbalanced(viewEntry) && (
                  <span style={{ fontSize:12, color:'#dc2626', fontWeight:600 }}>⚠ Unbalanced</span>
                )}
                <button className="je-icon-btn" onClick={() => setViewEntry(null)}><X size={16}/></button>
              </div>
            </div>
            <div className="je-modal-body">
              <div className="je-view-narr">
                <span>Narration:</span>
                <strong>{viewEntry.description}</strong>
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
                  {(viewEntry.lines || []).map((line, i) => (
                    <tr key={i}>
                      <td>{line.account_name}</td>
                      <td><span className="je-code-badge">{line.account_code}</span></td>
                      <td className="je-td-dr">{line.debit  ? fmtFull(line.debit)  : '—'}</td>
                      <td className="je-td-cr">{line.credit ? fmtFull(line.credit) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="je-tfoot">
                    <td colSpan={2}>TOTALS</td>
                    <td className="je-td-dr">{fmtFull((viewEntry.lines || []).reduce((s, l) => s + parseFloat(l.debit  || 0), 0))}</td>
                    <td className="je-td-cr">{fmtFull((viewEntry.lines || []).reduce((s, l) => s + parseFloat(l.credit || 0), 0))}</td>
                  </tr>
                </tfoot>
              </table>

              <div className="je-view-actions">
                <button className="je-btn-outline" onClick={() => window.print()}><Printer size={13}/> Print</button>

                {viewEntry.status === 'draft' && (<>
                  <button className="je-btn-outline"
                    onClick={() => { setViewEntry(null); openEdit(viewEntry); }}>
                    <Pencil size={13}/> Edit
                  </button>
                  <button className="je-btn-primary"
                    onClick={() => handlePost(viewEntry.id)}
                    disabled={isEntryUnbalanced(viewEntry) || actionId === viewEntry.id}
                    title={isEntryUnbalanced(viewEntry) ? 'Fix balance first' : 'Post this entry'}>
                    <Lock size={13}/> {actionId === viewEntry.id ? 'Posting…' : 'Post Entry'}
                  </button>
                  <button className="je-btn-outline" style={{ color:'#dc2626', borderColor:'#fca5a5' }}
                    onClick={() => setPendingDelete(viewEntry.id)}
                    disabled={actionId === viewEntry.id}>
                    <Trash2 size={13}/> Delete
                  </button>
                </>)}

                {viewEntry.status === 'posted' && (
                  <button className="je-btn-outline je-reverse-btn"
                    onClick={() => setPendingReverse(viewEntry.id)}
                    disabled={actionId === viewEntry.id}>
                    <Unlock size={13}/> {actionId === viewEntry.id ? 'Reversing…' : 'Create Reversal'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Create / Edit Drawer ── */}
      {drawer !== null && (
        <div className="je-drawer-overlay" onClick={() => setDrawer(null)}>
          <div className="je-drawer" onClick={e => e.stopPropagation()}>

            <div className="je-drawer-hd">
              <div>
                <h3>{drawer === 'create' ? 'New Journal Entry' : `Edit: ${drawer.entry_number}`}</h3>
                <p className="je-drawer-sub">Double-entry · Debits must equal Credits</p>
              </div>
              <button className="je-icon-btn" onClick={() => setDrawer(null)}><X size={18}/></button>
            </div>

            <div className="je-drawer-body">

              <div className="je-meta-row">
                <div className="je-field">
                  <label>Reference #</label>
                  <input value={form.reference_number} readOnly
                    style={{ color:'#9ca3af', background:'#f9fafb' }}/>
                </div>
                <div className="je-field">
                  <label>Entry Date *</label>
                  <input type="date" value={form.entry_date}
                    onChange={e => setForm(f => ({ ...f, entry_date: e.target.value }))}/>
                </div>
                <div className="je-field">
                  <label>Entry Type</label>
                  <select value={form.entry_type}
                    onChange={e => setForm(f => ({ ...f, entry_type: e.target.value }))}>
                    {ENTRY_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="je-field">
                <div className="je-narr-label-row">
                  <label>Narration *</label>
                  <div className="je-narr-templates">
                    <span>Quick fill:</span>
                    {NARRATION_TEMPLATES.slice(0, 3).map((t, i) => (
                      <button key={i} className="je-narr-chip"
                        onClick={() => setForm(f => ({ ...f, narration: t }))}>
                        {t.substring(0, 28)}…
                      </button>
                    ))}
                  </div>
                </div>
                <textarea rows={2} value={form.narration}
                  onChange={e => setForm(f => ({ ...f, narration: e.target.value }))}
                  placeholder="Being… (describe the purpose of this entry)"/>
              </div>

              {/* Balance indicator */}
              <div className={`je-balance-bar ${isBalanced ? 'balanced' : 'unbalanced'}`}>
                <div className="je-balance-side">
                  <span className="je-balance-label">Total Debit</span>
                  <span className="je-balance-amount je-dr-color">{fmtFull(totalDebit)}</span>
                </div>
                <div className="je-balance-mid">
                  {isBalanced
                    ? <><CheckCircle size={16} color="#10b981"/><span>Balanced</span></>
                    : <><AlertTriangle size={16} color="#ef4444"/>
                        <span>Diff: {fmtFull(Math.abs(difference))}</span>
                        <button className="je-auto-balance" onClick={autoBalance}>Auto-balance</button>
                      </>
                  }
                </div>
                <div className="je-balance-side je-balance-right">
                  <span className="je-balance-label">Total Credit</span>
                  <span className="je-balance-amount je-cr-color">{fmtFull(totalCredit)}</span>
                </div>
              </div>

              {/* Line items */}
              <div className="je-lines-section">
                <div className="je-lines-hd">
                  <span>Entry Lines</span>
                  <button className="je-add-line" onClick={addLine}><Plus size={12}/> Add Line</button>
                </div>
                <div className="je-lines-header-row">
                  <span style={{ flex:2 }}>Account</span>
                  <span style={{ flex:2 }}>Narration (optional)</span>
                  <span style={{ flex:1, textAlign:'right' }}>Debit (₹)</span>
                  <span style={{ flex:1, textAlign:'right' }}>Credit (₹)</span>
                  <span style={{ width:28 }}></span>
                </div>
                {form.lines.map((line, idx) => (
                  <div key={idx} className={`je-line-row ${idx % 2 === 0 ? 'je-line-even' : ''}`}>
                    <div style={{ flex:2 }}>
                      <select className="je-line-select" value={line.account_id}
                        onChange={e => updateLineAccount(idx, e.target.value)}>
                        <option value="">
                          {accounts.length ? '— Select Account —' : '— No accounts loaded —'}
                        </option>
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>
                            {(a.code || a.account_code || '')} — {(a.name || a.account_name || '')}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ flex:2 }}>
                      <input className="je-line-input" value={line.narration}
                        onChange={e => updateLine(idx, 'narration', e.target.value)}
                        placeholder="Optional note…"/>
                    </div>
                    <div style={{ flex:1 }}>
                      <DCInput value={line.debit}  onChange={v => updateLine(idx, 'debit',  v)} type="debit"/>
                    </div>
                    <div style={{ flex:1 }}>
                      <DCInput value={line.credit} onChange={v => updateLine(idx, 'credit', v)} type="credit"/>
                    </div>
                    <button className="je-remove-line" onClick={() => removeLine(idx)}><X size={12}/></button>
                  </div>
                ))}
                <div className="je-lines-totals">
                  <span style={{ flex:4 }}>Totals</span>
                  <span style={{ flex:1, textAlign:'right' }} className="je-dr-color">{fmtFull(totalDebit)}</span>
                  <span style={{ flex:1, textAlign:'right' }} className="je-cr-color">{fmtFull(totalCredit)}</span>
                  <span style={{ width:28 }}/>
                </div>
              </div>

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

              <div className="je-drawer-footer">
                <button className="je-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button className="je-btn-outline"
                  onClick={() => handleSubmit(false)} disabled={submitting}>
                  {submitting ? 'Saving…' : 'Save as Draft'}
                </button>
                <button className="je-btn-primary"
                  onClick={() => handleSubmit(true)}
                  disabled={!isBalanced || submitting}
                  title={!isBalanced ? 'Balance the entry first' : 'Post this entry'}>
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
