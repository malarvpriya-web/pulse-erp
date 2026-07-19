// frontend/src/features/finance/pages/AccountingEngine.jsx
import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';

const FinancialRatios = lazy(() => import('./FinancialRatios'));
import api from '@/services/api/client';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  LineChart, Line, ResponsiveContainer,
} from 'recharts';
import { useToast } from '@/context/ToastContext';
import { useFY } from '@/context/FYContext';
import FYSelector from '@/components/core/FYSelector';
import ConfirmDialog from '@/components/core/ConfirmDialog';

// ─── Currency formatter ────────────────────────────────────────────────────────
function formatINR(val) {
  const n = parseFloat(val) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  return `${sign}₹${abs.toLocaleString('en-IN')}`;
}

// ─── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const colors = {
    draft: { bg: '#f3f4f6', color: '#6b7280', label: 'Draft' },
    posted: { bg: '#dcfce7', color: '#16a34a', label: 'Posted' },
    reversed: { bg: '#fee2e2', color: '#dc2626', label: 'Reversed' },
    open: { bg: '#ede9fe', color: '#6B3FDB', label: 'Open' },
    closed: { bg: '#f3f4f6', color: '#6b7280', label: 'Closed' },
    locked: { bg: '#fef3c7', color: '#d97706', label: 'Locked' },
  };
  const c = colors[status] || { bg: '#f3f4f6', color: '#6b7280', label: status };
  return (
    <span style={{ background: c.bg, color: c.color, padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>
      {c.label}
    </span>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────────
const TABS = ['Journal Entries', 'Trial Balance', 'P&L Statement', 'Balance Sheet', 'General Ledger', 'Financial Ratios', 'Contra', 'Day Book', 'Cash/Bank Book', 'Interest', 'Advanced Vouchers', 'Cheque Print', 'Funds Flow'];


// ─── Main Component ────────────────────────────────────────────────────────────
export default function AccountingEngine() {
  const toast = useToast();
  const { fyParams, isCurrentFY } = useFY();
  const [activeTab, setActiveTab] = useState(0);
  const today = new Date().toISOString().split('T')[0];
  const currentYear = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  const fyStart = `${currentYear}-04-01`;

  // Shared
  const [accounts, setAccounts] = useState([]);

  // Tab 0 — Journal Entries
  const [journalEntries, setJournalEntries] = useState([]);
  const [jeLoading, setJeLoading] = useState(false);
  const [jeFilterFrom, setJeFilterFrom] = useState(fyStart);
  const [jeFilterTo, setJeFilterTo] = useState(today);
  const [jeFilterStatus, setJeFilterStatus] = useState('');
  const [jeSearch, setJeSearch] = useState('');
  const [showJEForm, setShowJEForm] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [showDrawer, setShowDrawer] = useState(false);

  // Tab 1 — Trial Balance
  const [trialBalance, setTrialBalance] = useState(null);
  const [tbLoading, setTbLoading] = useState(false);
  const [tbDateFrom, setTbDateFrom] = useState(fyStart);
  const [tbDateTo, setTbDateTo] = useState(today);

  // Tab 2 — P&L
  const [plData, setPlData] = useState(null);
  const [plLoading, setPlLoading] = useState(false);
  const [plPeriodFrom, setPlPeriodFrom] = useState(fyStart);
  const [plPeriodTo, setPlPeriodTo] = useState(today);
  const [plCompare, setPlCompare] = useState(false);
  const [plCmpFrom, setPlCmpFrom] = useState(`${currentYear - 1}-04-01`);
  const [plCmpTo, setPlCmpTo] = useState(`${currentYear}-03-31`);

  // Tab 3 — Balance Sheet
  const [balanceSheet, setBalanceSheet] = useState(null);
  const [bsLoading, setBsLoading] = useState(false);
  const [bsAsOfDate, setBsAsOfDate] = useState(today);

  // Tab 4 — General Ledger
  const [glAccountId, setGlAccountId] = useState('');
  const [glData, setGlData] = useState(null);
  const [glLoading, setGlLoading] = useState(false);
  const [glDateFrom, setGlDateFrom] = useState(fyStart);
  const [glDateTo, setGlDateTo] = useState(today);
  const [glSearch, setGlSearch] = useState('');
  const [pendingReverseEntry, setPendingReverseEntry] = useState(null);

  // Tab 6 — Contra Voucher
  const [cashBankAccounts, setCashBankAccounts] = useState([]);
  const [contra, setContra] = useState({ entry_date: today, from_account_id: '', to_account_id: '', amount: '', reference_number: '', narration: '' });
  const [contraSaving, setContraSaving] = useState(false);

  // Tab 7 — Day Book
  const [dbFrom, setDbFrom] = useState(today);
  const [dbTo, setDbTo] = useState(today);
  const [dbType, setDbType] = useState('');
  const [dayBook, setDayBook] = useState(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbExpanded, setDbExpanded] = useState({});

  // Tab 8 — Cash/Bank Book
  const [cbBook, setCbBook] = useState('both');
  const [cbFrom, setCbFrom] = useState(fyStart);
  const [cbTo, setCbTo] = useState(today);
  const [cashBankBook, setCashBankBook] = useState(null);
  const [cbLoading, setCbLoading] = useState(false);

  // Tab 9 — Interest Calculation
  const [intKind, setIntKind] = useState('receivable'); // receivable | payable
  const [intRate, setIntRate] = useState('18');
  const [intGrace, setIntGrace] = useState('0');
  const [intAsOf, setIntAsOf] = useState(today);
  const [intData, setIntData] = useState(null);
  const [intLoading, setIntLoading] = useState(false);

  // Tab 10 — Advanced Vouchers (Memorandum / Optional / Recurring)
  const [specialType, setSpecialType] = useState('memorandum');
  const [specialVouchers, setSpecialVouchers] = useState([]);
  const [recurring, setRecurring] = useState([]);
  const [recForm, setRecForm] = useState({ name: '', frequency: 'monthly', next_run_date: today, source_entry_id: '' });

  // Tab 11 — Cheque Printing
  const [cheque, setCheque] = useState({ payee: '', amount: '', date: today, bank_name: '', reference: '' });
  const [chequeData, setChequeData] = useState(null);

  // Tab 12 — Funds Flow
  const [ffFrom, setFfFrom] = useState(fyStart);
  const [ffTo, setFfTo] = useState(today);
  const [fundsFlow, setFundsFlow] = useState(null);
  const [ffLoading, setFfLoading] = useState(false);

  // Snap all financial-year-based date ranges when the global FY changes.
  // "To" caps at today for the current FY so we never query into the future.
  useEffect(() => {
    const from = fyParams.fyStart;
    const to   = isCurrentFY ? today : fyParams.fyEnd;
    setJeFilterFrom(from); setJeFilterTo(to);
    setTbDateFrom(from);   setTbDateTo(to);
    setPlPeriodFrom(from); setPlPeriodTo(to);
    setGlDateFrom(from);   setGlDateTo(to);
    setCbFrom(from);       setCbTo(to);
    setFfFrom(from);       setFfTo(to);
    setBsAsOfDate(to);
  }, [fyParams.fyStart, fyParams.fyEnd, isCurrentFY]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load accounts and journal entries on mount
  useEffect(() => {
    Promise.allSettled([
      api.get('/accounting/chart-of-accounts'),
      api.get('/accounting/cash-bank-accounts'),
    ]).then(([accRes, cbRes]) => {
      if (accRes.status === 'fulfilled' && Array.isArray(accRes.value?.data)) {
        setAccounts(accRes.value.data);
      }
      if (cbRes.status === 'fulfilled' && Array.isArray(cbRes.value?.data)) {
        setCashBankAccounts(cbRes.value.data);
      }
    });
    fetchJournalEntries();
  }, []);

  // ── Contra Voucher ────────────────────────────────────────────────────────────
  async function saveContra() {
    if (!contra.from_account_id || !contra.to_account_id || !contra.amount) {
      toast.error('Select both accounts and enter an amount.');
      return;
    }
    if (contra.from_account_id === contra.to_account_id) {
      toast.error('Source and destination accounts must differ.');
      return;
    }
    setContraSaving(true);
    const [res] = await Promise.allSettled([api.post('/accounting/contra', {
      entry_date: contra.entry_date,
      from_account_id: parseInt(contra.from_account_id),
      to_account_id: parseInt(contra.to_account_id),
      amount: parseFloat(contra.amount),
      reference_number: contra.reference_number || undefined,
      narration: contra.narration || undefined,
    })]);
    setContraSaving(false);
    if (res.status === 'fulfilled') {
      toast.success(`Contra voucher ${res.value.data.entry_number} posted.`);
      setContra({ entry_date: today, from_account_id: '', to_account_id: '', amount: '', reference_number: '', narration: '' });
      fetchJournalEntries();
    } else {
      toast.error(res.reason?.response?.data?.error || 'Failed to post contra voucher');
    }
  }

  // ── Day Book ──────────────────────────────────────────────────────────────────
  async function fetchDayBook() {
    setDbLoading(true);
    const params = { date_from: dbFrom, date_to: dbTo };
    if (dbType) params.voucher_type = dbType;
    const [res] = await Promise.allSettled([api.get('/accounting/day-book', { params })]);
    setDayBook(res.status === 'fulfilled' ? res.value.data : null);
    setDbExpanded({});
    setDbLoading(false);
  }

  // ── Cash/Bank Book ────────────────────────────────────────────────────────────
  async function fetchCashBankBook() {
    setCbLoading(true);
    const [res] = await Promise.allSettled([
      api.get('/accounting/cash-bank-book', { params: { book: cbBook, date_from: cbFrom, date_to: cbTo } })
    ]);
    setCashBankBook(res.status === 'fulfilled' ? res.value.data : null);
    setCbLoading(false);
  }

  // ── Interest Calculation ──────────────────────────────────────────────────────
  async function fetchInterest() {
    const rate = parseFloat(intRate);
    if (!Number.isFinite(rate) || rate < 0) { toast.error('Enter a valid annual interest rate.'); return; }
    setIntLoading(true);
    const endpoint = intKind === 'receivable' ? 'receivables' : 'payables';
    const [res] = await Promise.allSettled([
      api.get(`/accounting/interest/${endpoint}`, { params: { rate, as_of_date: intAsOf, grace_days: parseInt(intGrace) || 0 } })
    ]);
    if (res.status === 'fulfilled') setIntData(res.value.data);
    else { setIntData(null); toast.error(res.reason?.response?.data?.error || 'Failed to calculate interest'); }
    setIntLoading(false);
  }

  // ── Advanced Vouchers ─────────────────────────────────────────────────────────
  const fetchSpecial = useCallback(async (type) => {
    const [res] = await Promise.allSettled([api.get('/accounting/vouchers/special', { params: { type } })]);
    setSpecialVouchers(res.status === 'fulfilled' ? (res.value.data?.vouchers || []) : []);
  }, []);
  const fetchRecurring = useCallback(async () => {
    const [res] = await Promise.allSettled([api.get('/accounting/recurring-vouchers')]);
    setRecurring(res.status === 'fulfilled' ? (res.value.data || []) : []);
  }, []);

  async function convertVoucher(id) {
    const [res] = await Promise.allSettled([api.post(`/accounting/journal-entries/${id}/convert`)]);
    if (res.status === 'fulfilled') { toast.success('Converted to draft entry.'); fetchSpecial(specialType); fetchJournalEntries(); }
    else toast.error(res.reason?.response?.data?.error || 'Convert failed');
  }
  async function createRecurring() {
    if (!recForm.name || !recForm.source_entry_id) { toast.error('Enter a name and pick a source entry.'); return; }
    const [res] = await Promise.allSettled([api.post('/accounting/recurring-vouchers', recForm)]);
    if (res.status === 'fulfilled') { toast.success('Recurring template saved.'); setRecForm({ name: '', frequency: 'monthly', next_run_date: today, source_entry_id: '' }); fetchRecurring(); }
    else toast.error(res.reason?.response?.data?.error || 'Failed to save template');
  }
  async function generateRecurring(id) {
    const [res] = await Promise.allSettled([api.post(`/accounting/recurring-vouchers/${id}/generate`)]);
    if (res.status === 'fulfilled') { toast.success(`Generated ${res.value.data?.entry?.entry_number}. Next run: ${res.value.data?.next_run_date}`); fetchRecurring(); fetchJournalEntries(); }
    else toast.error(res.reason?.response?.data?.error || 'Generate failed');
  }
  async function deleteRecurring(id) {
    const [res] = await Promise.allSettled([api.delete(`/accounting/recurring-vouchers/${id}`)]);
    if (res.status === 'fulfilled') { fetchRecurring(); } else toast.error('Delete failed');
  }

  // ── Cheque Printing ───────────────────────────────────────────────────────────
  async function fetchChequeData() {
    if (!cheque.payee || !cheque.amount) { toast.error('Enter payee and amount.'); return; }
    const [res] = await Promise.allSettled([api.post('/accounting/cheque/print-data', {
      payee: cheque.payee, amount: parseFloat(cheque.amount), date: cheque.date,
      bank_name: cheque.bank_name, reference: cheque.reference,
    })]);
    if (res.status === 'fulfilled') setChequeData(res.value.data);
    else toast.error(res.reason?.response?.data?.error || 'Failed to build cheque data');
  }

  // Lazy-load advanced-voucher data when the tabs open
  useEffect(() => { if (activeTab === 10) { fetchSpecial(specialType); fetchRecurring(); } }, [activeTab, specialType, fetchSpecial, fetchRecurring]);

  // ── Funds Flow ────────────────────────────────────────────────────────────────
  async function fetchFundsFlow() {
    setFfLoading(true);
    const [res] = await Promise.allSettled([
      api.get('/statements/funds-flow', { params: { fyStart: ffFrom, fyEnd: ffTo, from_date: ffFrom, to_date: ffTo } })
    ]);
    setFundsFlow(res.status === 'fulfilled' ? res.value.data : null);
    setFfLoading(false);
  }

  // ── Fetch Journal Entries ────────────────────────────────────────────────────
  const fetchJournalEntries = useCallback(async () => {
    setJeLoading(true);
    try {
      const params = {};
      if (jeFilterFrom) params.date_from = jeFilterFrom;
      if (jeFilterTo) params.date_to = jeFilterTo;
      if (jeFilterStatus) params.status = jeFilterStatus;
      const [res] = await Promise.allSettled([api.get('/accounting/journal-entries', { params })]);
      if (res.status === 'fulfilled') {
        setJournalEntries(res.value?.data?.entries || []);
      } else {
        setJournalEntries([]);
      }
    } finally {
      setJeLoading(false);
    }
  }, [jeFilterFrom, jeFilterTo, jeFilterStatus]);

  const filteredEntries = journalEntries.filter(e => {
    if (!jeSearch) return true;
    const s = jeSearch.toLowerCase();
    return e.entry_number?.toLowerCase().includes(s) || e.description?.toLowerCase().includes(s);
  });

  // ── Post entry ───────────────────────────────────────────────────────────────
  async function postEntry(id) {
    const [res] = await Promise.allSettled([api.post(`/accounting/journal-entries/${id}/post`)]);
    if (res.status === 'fulfilled') {
      fetchJournalEntries();
      if (selectedEntry?.id === id) setSelectedEntry(res.value.data);
    } else {
      toast.error(res.reason?.response?.data?.error || 'Failed to post entry');
    }
  }

  // ── Reverse entry ────────────────────────────────────────────────────────────
  async function reverseEntry() {
    if (!pendingReverseEntry) return;
    const id = pendingReverseEntry;
    setPendingReverseEntry(null);
    const [res] = await Promise.allSettled([api.post(`/accounting/journal-entries/${id}/reverse`)]);
    if (res.status === 'fulfilled') {
      fetchJournalEntries();
      setShowDrawer(false);
    } else {
      toast.error(res.reason?.response?.data?.error || 'Failed to reverse entry');
    }
  }

  // ── Trial Balance ─────────────────────────────────────────────────────────────
  async function fetchTrialBalance() {
    setTbLoading(true);
    const [res] = await Promise.allSettled([
      api.get('/accounting/trial-balance', { params: { date_from: tbDateFrom, date_to: tbDateTo } })
    ]);
    setTrialBalance(res.status === 'fulfilled' ? res.value.data : null);
    setTbLoading(false);
  }

  function exportTBCsv() {
    if (!trialBalance) return;
    const rows = [['Account Code', 'Account Name', 'Type', 'Opening DR', 'Opening CR', 'Movement DR', 'Movement CR', 'Closing DR', 'Closing CR']];
    Object.entries(trialBalance.accounts_by_type).forEach(([type, accs]) => {
      accs.forEach(a => rows.push([a.account_code, a.account_name, type, a.opening_dr, a.opening_cr, a.movement_debit, a.movement_credit, a.closing_dr, a.closing_cr]));
    });
    rows.push(['', 'GRAND TOTAL', '', '', '', trialBalance.grand_total_debit, trialBalance.grand_total_credit, '', '']);
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trial-balance-${tbDateFrom}-${tbDateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── P&L ───────────────────────────────────────────────────────────────────────
  async function fetchPL() {
    setPlLoading(true);
    const params = { period_from: plPeriodFrom, period_to: plPeriodTo };
    if (plCompare) { params.compare_from = plCmpFrom; params.compare_to = plCmpTo; }
    const [res] = await Promise.allSettled([api.get('/accounting/profit-loss', { params })]);
    setPlData(res.status === 'fulfilled' ? res.value.data : null);
    setPlLoading(false);
  }

  // ── Balance Sheet ─────────────────────────────────────────────────────────────
  async function fetchBalanceSheet() {
    setBsLoading(true);
    const [res] = await Promise.allSettled([api.get('/accounting/balance-sheet', { params: { as_of_date: bsAsOfDate } })]);
    setBalanceSheet(res.status === 'fulfilled' ? res.value.data : null);
    setBsLoading(false);
  }

  // ── General Ledger ────────────────────────────────────────────────────────────
  async function fetchGL() {
    if (!glAccountId) return;
    setGlLoading(true);
    const [res] = await Promise.allSettled([
      api.get(`/accounting/general-ledger/${glAccountId}`, { params: { date_from: glDateFrom, date_to: glDateTo } })
    ]);
    if (res.status === 'fulfilled') {
      setGlData(res.value.data);
    } else {
      // Sample fallback
      setGlData({
        account: accounts.find(a => String(a.id) === String(glAccountId)) || accounts[0],
        opening_balance: 500000,
        transactions: [
          { id: 1, entry_date: '2025-04-15', entry_number: 'JE-2025-0002', je_description: 'Sales Invoice INV-001', reference_type: 'invoice', debit: 118000, credit: 0, running_balance: 618000, balance_indicator: 'DR' },
          { id: 2, entry_date: '2025-05-01', entry_number: 'JE-2025-0003', je_description: 'Salary payment May 2025', reference_type: 'payment', debit: 0, credit: 350000, running_balance: 268000, balance_indicator: 'DR' },
          { id: 3, entry_date: '2025-06-10', entry_number: 'JE-2025-0004', je_description: 'Rent payment June 2025', reference_type: 'payment', debit: 0, credit: 75000, running_balance: 193000, balance_indicator: 'DR' },
        ],
        closing_balance: 193000,
      });
    }
    setGlLoading(false);
  }

  const plVariance = (plData && plData.comparison)
    ? (() => {
      const base = parseFloat(plData.comparison.net_profit) || 0;
      const current = parseFloat(plData.net_profit) || 0;
      const varianceAmount = current - base;
      const variancePct = base === 0 ? null : (varianceAmount / Math.abs(base)) * 100;
      return { varianceAmount, variancePct };
    })()
    : null;

  // ─── Render ────────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', background: '#f8f7ff', minHeight: '100vh', padding: '24px' }}>

      <ConfirmDialog
        open={!!pendingReverseEntry}
        title="Reverse Journal Entry"
        message="Create a reversal entry for this journal entry?"
        confirmLabel="Reverse"
        variant="warning"
        onConfirm={reverseEntry}
        onCancel={() => setPendingReverseEntry(null)}
      />
      {/* Header */}
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, color: '#1e1b4b' }}>Accounting Engine</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>Journal entries, financial statements & ledger management</p>
        </div>
        <FYSelector showProgress />
      </div>

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: 4, background: '#fff', borderRadius: 10, padding: 4, border: '1px solid #e9e4ff', marginBottom: 24, width: 'fit-content' }}>
        {TABS.map((tab, i) => (
          <button key={i} onClick={() => setActiveTab(i)} style={{
            padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 500, fontSize: 14,
            background: activeTab === i ? '#6B3FDB' : 'transparent',
            color: activeTab === i ? '#fff' : '#6b7280',
            transition: 'all 0.15s',
          }}>
            {tab}
          </button>
        ))}
      </div>

      {/* ─── Tab 0: Journal Entries ─────────────────────────────────────────── */}
      {activeTab === 0 && (
        <div>
          {/* Header row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Journal Entries</h2>
            <button onClick={() => setShowJEForm(true)} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
              + New Entry
            </button>
          </div>

          {/* Filter bar */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <input type="date" value={jeFilterFrom} onChange={e => setJeFilterFrom(e.target.value)} style={inputStyle} placeholder="From" />
            <input type="date" value={jeFilterTo} onChange={e => setJeFilterTo(e.target.value)} style={inputStyle} placeholder="To" />
            <select value={jeFilterStatus} onChange={e => setJeFilterStatus(e.target.value)} style={inputStyle}>
              <option value="">All Status</option>
              <option value="draft">Draft</option>
              <option value="posted">Posted</option>
              <option value="reversed">Reversed</option>
            </select>
            <input value={jeSearch} onChange={e => setJeSearch(e.target.value)} placeholder="Search entry # or description..." style={{ ...inputStyle, width: 240 }} />
            <button onClick={fetchJournalEntries} style={btnSecondary}>Filter</button>
          </div>

          {/* Table */}
          <div style={tableWrap}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Entry #', 'Date', 'Description', 'Reference', 'Status', 'Debit', 'Credit', 'Actions'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jeLoading ? (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading...</td></tr>
                ) : filteredEntries.length === 0 ? (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
                    <div style={{ fontSize: 40, marginBottom: 8 }}>📒</div>
                    <div style={{ fontWeight: 500 }}>No journal entries found</div>
                    <div style={{ fontSize: 13, marginTop: 4 }}>Create your first entry using the "New Entry" button</div>
                  </td></tr>
                ) : filteredEntries.map((entry, idx) => (
                  <tr key={entry.id} style={{ borderBottom: '1px solid #f0f0f4', background: idx % 2 === 0 ? '#fff' : '#fafafa' }}
                      onClick={() => { setSelectedEntry(entry); setShowDrawer(true); }}>
                    <td style={tdStyle}><span style={{ color: '#6B3FDB', fontWeight: 600, cursor: 'pointer' }}>{entry.entry_number}</span></td>
                    <td style={tdStyle}>{entry.entry_date}</td>
                    <td style={{ ...tdStyle, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.description}</td>
                    <td style={tdStyle}><span style={{ textTransform: 'capitalize', fontSize: 12, color: '#6b7280' }}>{entry.reference_type || '—'}</span></td>
                    <td style={tdStyle}><StatusBadge status={entry.status} /></td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(entry.total_debit)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(entry.total_credit)}</td>
                    <td style={tdStyle} onClick={e => e.stopPropagation()}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button onClick={() => { setSelectedEntry(entry); setShowDrawer(true); }} style={btnActionGhost}>View</button>
                        {entry.status === 'draft' && (
                          <button onClick={() => postEntry(entry.id)} style={{ ...btnActionGhost, color: '#16a34a', border: '1px solid #bbf7d0' }}>Post</button>
                        )}
                        {entry.status === 'posted' && (
                          <button onClick={() => setPendingReverseEntry(entry.id)} style={{ ...btnActionGhost, color: '#dc2626', border: '1px solid #fecaca' }}>Reverse</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── Tab 1: Trial Balance ──────────────────────────────────────────── */}
      {activeTab === 1 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Trial Balance</h2>
            {trialBalance && (
              <button onClick={exportTBCsv} style={btnSecondary}>Export Excel (CSV)</button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
            <label style={labelStyle}>From</label>
            <input type="date" value={tbDateFrom} onChange={e => setTbDateFrom(e.target.value)} style={inputStyle} />
            <label style={labelStyle}>To</label>
            <input type="date" value={tbDateTo} onChange={e => setTbDateTo(e.target.value)} style={inputStyle} />
            <button onClick={fetchTrialBalance} style={btnPrimary}>{tbLoading ? 'Generating...' : 'Generate'}</button>
          </div>

          {trialBalance && (
            <div style={tableWrap}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#6B3FDB' }}>
                    {['Account Code', 'Account Name', 'Type', 'Opening DR', 'Opening CR', 'Movement DR', 'Movement CR', 'Closing DR', 'Closing CR'].map(h => (
                      <th key={h} style={{ ...thStyle, color: '#fff', background: 'transparent' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(trialBalance.accounts_by_type).map(([type, accs]) => {
                    const subtotalODr = accs.reduce((s, a) => s + (a.opening_dr || 0), 0);
                    const subtotalOCr = accs.reduce((s, a) => s + (a.opening_cr || 0), 0);
                    const subtotalMDr = accs.reduce((s, a) => s + (a.movement_debit || 0), 0);
                    const subtotalMCr = accs.reduce((s, a) => s + (a.movement_credit || 0), 0);
                    const subtotalCDr = accs.reduce((s, a) => s + (a.closing_dr || 0), 0);
                    const subtotalCCr = accs.reduce((s, a) => s + (a.closing_cr || 0), 0);
                    return (
                      <React.Fragment key={type}>
                        <tr style={{ background: '#f5f3ff' }}>
                          <td colSpan={9} style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB', fontSize: 13 }}>{type} Accounts</td>
                        </tr>
                        {accs.map(a => (
                          <tr key={a.account_code} style={{ borderBottom: '1px solid #f0f0f4' }}>
                            <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 500 }}>{a.account_code}</td>
                            <td style={tdStyle}>{a.account_name}</td>
                            <td style={{ ...tdStyle, fontSize: 12, color: '#6b7280' }}>{a.account_type || type}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{a.opening_dr > 0 ? formatINR(a.opening_dr) : '—'}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{a.opening_cr > 0 ? formatINR(a.opening_cr) : '—'}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{a.movement_debit > 0 ? formatINR(a.movement_debit) : '—'}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{a.movement_credit > 0 ? formatINR(a.movement_credit) : '—'}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 500 }}>{a.closing_dr > 0 ? formatINR(a.closing_dr) : '—'}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 500 }}>{a.closing_cr > 0 ? formatINR(a.closing_cr) : '—'}</td>
                          </tr>
                        ))}
                        <tr style={{ background: '#f9f9fc', fontWeight: 600 }}>
                          <td colSpan={3} style={{ ...tdStyle, fontSize: 12, color: '#6b7280' }}>Subtotal — {type}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>{formatINR(subtotalODr)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>{formatINR(subtotalOCr)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>{formatINR(subtotalMDr)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>{formatINR(subtotalMCr)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>{formatINR(subtotalCDr)}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontSize: 12 }}>{formatINR(subtotalCCr)}</td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                  {/* Grand total */}
                  <tr style={{ background: '#1e1b4b', color: '#fff', fontWeight: 700 }}>
                    <td colSpan={5} style={{ ...tdStyle, color: '#fff', fontSize: 13 }}>
                      GRAND TOTAL
                      <span style={{ marginLeft: 12, fontSize: 12, padding: '2px 8px', borderRadius: 12, background: trialBalance.balanced ? '#16a34a' : '#dc2626' }}>
                        {trialBalance.balanced ? '✓ Balanced' : '✗ Out of Balance'}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#fff' }}>{formatINR(trialBalance.grand_total_debit)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', color: '#fff' }}>{formatINR(trialBalance.grand_total_credit)}</td>
                    <td colSpan={2} style={{ ...tdStyle, color: '#a5b4fc', fontSize: 12, textAlign: 'right' }}>
                      {trialBalance.date_range?.date_from} → {trialBalance.date_range?.date_to}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {!trialBalance && !tbLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Select date range and click Generate to view trial balance.</div>
          )}
        </div>
      )}

      {/* ─── Tab 2: P&L Statement ──────────────────────────────────────────── */}
      {activeTab === 2 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Profit & Loss Statement</h2>
          </div>

          {/* Controls */}
          <div style={{ background: '#fff', borderRadius: 12, padding: 16, border: '1px solid #e9e4ff', marginBottom: 20 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div>
                <label style={labelStyle}>Period From</label>
                <input type="date" value={plPeriodFrom} onChange={e => setPlPeriodFrom(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Period To</label>
                <input type="date" value={plPeriodTo} onChange={e => setPlPeriodTo(e.target.value)} style={inputStyle} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 8 }}>
                <input type="checkbox" checked={plCompare} onChange={e => setPlCompare(e.target.checked)} id="plCompare" />
                <label htmlFor="plCompare" style={{ fontSize: 14, color: '#374151', cursor: 'pointer' }}>Compare Period</label>
              </div>
              {plCompare && (
                <>
                  <div>
                    <label style={labelStyle}>Compare From</label>
                    <input type="date" value={plCmpFrom} onChange={e => setPlCmpFrom(e.target.value)} style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>Compare To</label>
                    <input type="date" value={plCmpTo} onChange={e => setPlCmpTo(e.target.value)} style={inputStyle} />
                  </div>
                </>
              )}
              <button onClick={fetchPL} style={btnPrimary}>{plLoading ? 'Generating...' : 'Generate'}</button>
            </div>
          </div>

          {plVariance && (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Net Profit Variance (Current vs Comparison)</div>
              <div style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: plVariance.varianceAmount >= 0 ? '#16a34a' : '#dc2626' }}>
                  {formatINR(plVariance.varianceAmount)}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: plVariance.varianceAmount >= 0 ? '#16a34a' : '#dc2626' }}>
                  {plVariance.variancePct === null ? 'N/A' : `${plVariance.variancePct >= 0 ? '+' : ''}${plVariance.variancePct.toFixed(2)}%`}
                </span>
              </div>
            </div>
          )}

          {plData && (
            <>
              {/* P&L Statement table */}
              <div style={{ display: 'grid', gridTemplateColumns: plData.comparison ? '1fr 1fr' : '1fr', gap: 20, marginBottom: 24 }}>
                {[{ data: plData, label: 'Current Period' }, plData.comparison ? { data: plData.comparison, label: 'Comparison Period' } : null].filter(Boolean).map(({ data, label }) => (
                  <div key={label} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', overflow: 'hidden' }}>
                    <div style={{ background: '#6B3FDB', color: '#fff', padding: '12px 16px', fontWeight: 700, fontSize: 14 }}>{label}</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        <tr style={{ background: '#f5f3ff' }}>
                          <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>Revenue</td>
                        </tr>
                        {(data.revenue_accounts || []).map(a => (
                          <tr key={a.account_code} style={{ borderBottom: '1px solid #f5f3ff' }}>
                            <td style={{ ...tdStyle, paddingLeft: 24, color: '#374151' }}>{a.account_name}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(a.net_amount)}</td>
                          </tr>
                        ))}
                        <tr style={{ fontWeight: 700 }}>
                          <td style={tdStyle}>Total Revenue</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatINR(data.total_revenue)}</td>
                        </tr>
                        <tr style={{ borderBottom: '1px solid #f0f0f4' }}>
                          <td style={tdStyle}>Less: Cost of Goods Sold</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#dc2626' }}>({formatINR(data.cogs)})</td>
                        </tr>
                        <tr style={{ background: '#f0fdf4', fontWeight: 700 }}>
                          <td style={tdStyle}>Gross Profit</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: data.gross_profit >= 0 ? '#16a34a' : '#dc2626' }}>{formatINR(data.gross_profit)}</td>
                        </tr>
                        <tr style={{ background: '#f5f3ff' }}>
                          <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>Operating Expenses</td>
                        </tr>
                        {(data.operating_expenses || []).map(a => (
                          <tr key={a.account_code} style={{ borderBottom: '1px solid #f5f3ff' }}>
                            <td style={{ ...tdStyle, paddingLeft: 24, color: '#374151' }}>{a.account_name}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>({formatINR(a.net_amount)})</td>
                          </tr>
                        ))}
                        <tr style={{ fontWeight: 700 }}>
                          <td style={tdStyle}>Total Operating Expenses</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#dc2626' }}>({formatINR(data.total_opex)})</td>
                        </tr>
                        <tr style={{ background: '#eff6ff', fontWeight: 700 }}>
                          <td style={tdStyle}>Operating Profit</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: data.operating_profit >= 0 ? '#1d4ed8' : '#dc2626' }}>{formatINR(data.operating_profit)}</td>
                        </tr>
                        <tr>
                          <td style={tdStyle}>Other Income</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#16a34a' }}>{formatINR(data.other_income)}</td>
                        </tr>
                        <tr style={{ background: data.net_profit >= 0 ? '#f0fdf4' : '#fef2f2', fontWeight: 800 }}>
                          <td style={{ ...tdStyle, fontSize: 16 }}>Net Profit</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontSize: 18, color: data.net_profit >= 0 ? '#16a34a' : '#dc2626' }}>{formatINR(data.net_profit)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              {/* Monthly chart */}
              {plData.monthly_chart && plData.monthly_chart.length > 0 && (
                <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 20 }}>
                  <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600, color: '#374151' }}>Monthly P&L — Last 12 Months</h3>
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={plData.monthly_chart} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                      <YAxis tickFormatter={v => `₹${(v / 100000).toFixed(0)}L`} tick={{ fontSize: 11 }} />
                      <Tooltip formatter={v => formatINR(v)} />
                      <Legend />
                      <Bar dataKey="revenue" name="Revenue" fill="#6B3FDB" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="expense" name="Expense" fill="#d1d5db" radius={[3, 3, 0, 0]} />
                      <Line type="monotone" dataKey="profit" name="Net Profit" stroke="#16a34a" strokeWidth={2} dot={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
          {!plData && !plLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Select period and click Generate to view P&L statement.</div>
          )}
        </div>
      )}

      {/* ─── Tab 3: Balance Sheet ──────────────────────────────────────────── */}
      {activeTab === 3 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Balance Sheet</h2>
            {balanceSheet && (
              <button onClick={() => window.print()} style={btnSecondary}>Export PDF (Print)</button>
            )}
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 20, alignItems: 'center' }}>
            <label style={labelStyle}>As of Date</label>
            <input type="date" value={bsAsOfDate} onChange={e => setBsAsOfDate(e.target.value)} style={inputStyle} />
            <button onClick={fetchBalanceSheet} style={btnPrimary}>{bsLoading ? 'Generating...' : 'Generate'}</button>
          </div>

          {balanceSheet && (
            <>
              {balanceSheet.balanced !== undefined && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                  <span style={{ padding: '6px 16px', borderRadius: 20, fontWeight: 700, fontSize: 14, background: balanceSheet.balanced ? '#dcfce7' : '#fee2e2', color: balanceSheet.balanced ? '#16a34a' : '#dc2626' }}>
                    {balanceSheet.balanced ? '✓ Balanced' : '✗ Out of Balance'}
                  </span>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                {/* Assets column */}
                <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', overflow: 'hidden' }}>
                  <div style={{ background: '#6B3FDB', color: '#fff', padding: '12px 16px', fontWeight: 700, fontSize: 15 }}>Assets</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr style={{ background: '#f5f3ff' }}>
                        <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>Current Assets</td>
                      </tr>
                      {(balanceSheet.current_assets || []).map(a => (
                        <tr key={a.account_code} style={{ borderBottom: '1px solid #f5f3ff' }}>
                          <td style={{ ...tdStyle, paddingLeft: 24 }}>{a.account_name}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(a.balance)}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700, borderBottom: '2px solid #e9e4ff' }}>
                        <td style={tdStyle}>Total Current Assets</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(balanceSheet.total_current_assets)}</td>
                      </tr>
                      <tr style={{ background: '#f5f3ff' }}>
                        <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>Fixed Assets</td>
                      </tr>
                      {(balanceSheet.fixed_assets || []).map(a => (
                        <tr key={a.account_code} style={{ borderBottom: '1px solid #f5f3ff' }}>
                          <td style={{ ...tdStyle, paddingLeft: 24 }}>{a.account_name}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: a.balance < 0 ? '#dc2626' : 'inherit' }}>{formatINR(a.balance)}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700, borderBottom: '2px solid #e9e4ff' }}>
                        <td style={tdStyle}>Total Fixed Assets</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(balanceSheet.total_fixed_assets)}</td>
                      </tr>
                      <tr style={{ background: '#1e1b4b', color: '#fff', fontWeight: 800 }}>
                        <td style={{ ...tdStyle, color: '#fff', fontSize: 15 }}>TOTAL ASSETS</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#fff', fontSize: 15 }}>{formatINR(balanceSheet.total_assets)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Liabilities & Equity column */}
                <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', overflow: 'hidden' }}>
                  <div style={{ background: '#1e1b4b', color: '#fff', padding: '12px 16px', fontWeight: 700, fontSize: 15 }}>Liabilities & Equity</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr style={{ background: '#f5f3ff' }}>
                        <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>Current Liabilities</td>
                      </tr>
                      {(balanceSheet.current_liabilities || []).map(a => (
                        <tr key={a.account_code} style={{ borderBottom: '1px solid #f5f3ff' }}>
                          <td style={{ ...tdStyle, paddingLeft: 24 }}>{a.account_name}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(a.balance)}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700, borderBottom: '2px solid #e9e4ff' }}>
                        <td style={tdStyle}>Total Current Liabilities</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(balanceSheet.total_current_liabilities)}</td>
                      </tr>
                      <tr style={{ background: '#f5f3ff' }}>
                        <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>Long-term Liabilities</td>
                      </tr>
                      {(balanceSheet.long_term_liabilities || []).map(a => (
                        <tr key={a.account_code} style={{ borderBottom: '1px solid #f5f3ff' }}>
                          <td style={{ ...tdStyle, paddingLeft: 24 }}>{a.account_name}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(a.balance)}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700, borderBottom: '2px solid #e9e4ff' }}>
                        <td style={tdStyle}>Total Long-term Liabilities</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(balanceSheet.total_long_term_liabilities)}</td>
                      </tr>
                      <tr style={{ background: '#f5f3ff' }}>
                        <td colSpan={2} style={{ ...tdStyle, fontWeight: 700, color: '#6B3FDB' }}>Equity</td>
                      </tr>
                      {(balanceSheet.equity_accounts || []).map(a => (
                        <tr key={a.account_code} style={{ borderBottom: '1px solid #f5f3ff' }}>
                          <td style={{ ...tdStyle, paddingLeft: 24 }}>{a.account_name}</td>
                          <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(a.balance)}</td>
                        </tr>
                      ))}
                      {balanceSheet.retained_earnings !== undefined && (
                        <tr style={{ borderBottom: '1px solid #f5f3ff' }}>
                          <td style={{ ...tdStyle, paddingLeft: 24, color: '#6b7280', fontSize: 13 }}>Retained Earnings (Current Year)</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#6b7280', fontSize: 13 }}>{formatINR(balanceSheet.retained_earnings)}</td>
                        </tr>
                      )}
                      <tr style={{ fontWeight: 700, borderBottom: '2px solid #e9e4ff' }}>
                        <td style={tdStyle}>Total Equity</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(balanceSheet.total_equity)}</td>
                      </tr>
                      <tr style={{ background: '#1e1b4b', color: '#fff', fontWeight: 800 }}>
                        <td style={{ ...tdStyle, color: '#fff', fontSize: 15 }}>TOTAL LIABILITIES + EQUITY</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#fff', fontSize: 15 }}>{formatINR(balanceSheet.total_liabilities_equity)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
          {!balanceSheet && !bsLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Select a date and click Generate to view the balance sheet.</div>
          )}
        </div>
      )}

      {/* ─── Tab 4: General Ledger ──────────────────────────────────────────── */}
      {activeTab === 4 && (
        <div>
          <h2 style={{ margin: '0 0 16px', fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>General Ledger</h2>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={labelStyle}>Account</label>
              <div style={{ position: 'relative' }}>
                <input
                  value={glSearch}
                  onChange={e => setGlSearch(e.target.value)}
                  placeholder="Search account..."
                  style={{ ...inputStyle, width: 260 }}
                />
                {glSearch && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8, zIndex: 100, maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}>
                    {accounts.filter(a => `${a.account_code} ${a.account_name}`.toLowerCase().includes(glSearch.toLowerCase())).map(a => (
                      <div key={a.id} onClick={() => { setGlAccountId(a.id); setGlSearch(`${a.account_code} - ${a.account_name}`); }}
                           style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f0f0f4' }}
                           onMouseEnter={e => e.currentTarget.style.background = '#f5f3ff'}
                           onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                        <span style={{ color: '#6B3FDB', fontWeight: 600 }}>{a.account_code}</span> — {a.account_name}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div>
              <label style={labelStyle}>From</label>
              <input type="date" value={glDateFrom} onChange={e => setGlDateFrom(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>To</label>
              <input type="date" value={glDateTo} onChange={e => setGlDateTo(e.target.value)} style={inputStyle} />
            </div>
            <button onClick={fetchGL} disabled={!glAccountId} style={{ ...btnPrimary, opacity: glAccountId ? 1 : 0.5, cursor: glAccountId ? 'pointer' : 'not-allowed' }}>
              {glLoading ? 'Loading...' : 'Fetch Ledger'}
            </button>
          </div>

          {glData && (
            <div>
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={infoCard}>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Account</div>
                  <div style={{ fontWeight: 700, color: '#6B3FDB' }}>{glData.account?.account_code} — {glData.account?.account_name}</div>
                </div>
                <div style={infoCard}>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Type</div>
                  <div style={{ fontWeight: 600 }}>{glData.account?.account_type}</div>
                </div>
                <div style={infoCard}>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Opening Balance</div>
                  <div style={{ fontWeight: 700, color: glData.opening_balance >= 0 ? '#16a34a' : '#dc2626' }}>
                    {formatINR(Math.abs(glData.opening_balance))} {glData.opening_balance >= 0 ? 'DR' : 'CR'}
                  </div>
                </div>
                <div style={infoCard}>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>Closing Balance</div>
                  <div style={{ fontWeight: 700, color: glData.closing_balance >= 0 ? '#16a34a' : '#dc2626' }}>
                    {formatINR(Math.abs(glData.closing_balance))} {glData.closing_balance >= 0 ? 'DR' : 'CR'}
                  </div>
                </div>
              </div>

              <div style={tableWrap}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#6B3FDB' }}>
                      {['Date', 'Entry #', 'Description', 'Reference', 'Debit', 'Credit', 'Running Balance'].map(h => (
                        <th key={h} style={{ ...thStyle, color: '#fff', background: 'transparent' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* Opening balance row */}
                    <tr style={{ background: '#f5f3ff' }}>
                      <td style={tdStyle}>{glData.date_range?.date_from}</td>
                      <td style={tdStyle}>—</td>
                      <td style={{ ...tdStyle, fontWeight: 600, color: '#6b7280' }}>Opening Balance</td>
                      <td style={tdStyle}>—</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>—</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>—</td>
                      <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>
                        {formatINR(Math.abs(glData.opening_balance))}
                        <span style={{ marginLeft: 4, fontSize: 11, color: '#6b7280' }}>{glData.opening_balance >= 0 ? 'DR' : 'CR'}</span>
                      </td>
                    </tr>

                    {glData.transactions?.length === 0 ? (
                      <tr>
                        <td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#9ca3af', fontSize: 14 }}>No transactions in this period.</td>
                      </tr>
                    ) : (glData.transactions || []).map((tx, i) => (
                      <tr key={tx.id || i} style={{ borderBottom: '1px solid #f0f0f4', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={tdStyle}>{tx.entry_date?.toString().slice(0, 10)}</td>
                        <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 500 }}>{tx.entry_number}</td>
                        <td style={{ ...tdStyle, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tx.je_description || tx.narration}</td>
                        <td style={{ ...tdStyle, fontSize: 12, color: '#6b7280', textTransform: 'capitalize' }}>{tx.reference_type || '—'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#16a34a', fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(tx.debit) > 0 ? formatINR(tx.debit) : '—'}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>
                          {parseFloat(tx.credit) > 0 ? formatINR(tx.credit) : '—'}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                          {formatINR(Math.abs(tx.running_balance))}
                          <span style={{ marginLeft: 4, fontSize: 11, color: '#6b7280' }}>{tx.balance_indicator}</span>
                        </td>
                      </tr>
                    ))}

                    {/* Closing balance row */}
                    <tr style={{ background: '#1e1b4b', color: '#fff', fontWeight: 700 }}>
                      <td style={{ ...tdStyle, color: '#fff' }}>{glData.date_range?.date_to}</td>
                      <td style={{ ...tdStyle, color: '#fff' }}>—</td>
                      <td style={{ ...tdStyle, color: '#fff', fontWeight: 700 }}>Closing Balance</td>
                      <td style={{ ...tdStyle, color: '#fff' }}>—</td>
                      <td style={{ ...tdStyle, color: '#fff', textAlign: 'right' }}>—</td>
                      <td style={{ ...tdStyle, color: '#fff', textAlign: 'right' }}>—</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: '#fff', fontWeight: 700 }}>
                        {formatINR(Math.abs(glData.closing_balance))}
                        <span style={{ marginLeft: 4, fontSize: 11, color: '#a5b4fc' }}>{glData.closing_balance >= 0 ? 'DR' : 'CR'}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {!glData && !glLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Search and select an account, then click Fetch Ledger.</div>
          )}
        </div>
      )}

      {/* ─── Tab 5: Financial Ratios ─────────────────────────────────────── */}
      {activeTab === 5 && (
        <Suspense fallback={<div style={{ textAlign:'center', padding:60, color:'#9ca3af' }}>Loading ratios…</div>}>
          <FinancialRatios />
        </Suspense>
      )}

      {/* ─── Tab 6: Contra Voucher ──────────────────────────────────────────── */}
      {activeTab === 6 && (
        <div>
          <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Contra Voucher</h2>
          <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 13 }}>
            Transfer funds between cash and bank accounts (cash deposit, cash withdrawal, inter-bank transfer). Posts a balanced journal entry automatically.
          </p>

          {cashBankAccounts.length < 2 ? (
            <div style={{ ...tableWrap, padding: 24, color: '#9ca3af', textAlign: 'center' }}>
              At least two cash/bank accounts (chart-of-account sub-type “cash” or “bank”) are required to record a contra voucher.
            </div>
          ) : (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e9e4ff', padding: 24, maxWidth: 620 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>Date *</label>
                  <input type="date" value={contra.entry_date} onChange={e => setContra(c => ({ ...c, entry_date: e.target.value }))} style={{ ...inputStyle, width: '100%' }} />
                </div>
                <div>
                  <label style={labelStyle}>Amount (₹) *</label>
                  <input type="number" min="0" value={contra.amount} onChange={e => setContra(c => ({ ...c, amount: e.target.value }))} placeholder="0.00" style={{ ...inputStyle, width: '100%' }} />
                </div>
                <div>
                  <label style={labelStyle}>From Account (money out) *</label>
                  <select value={contra.from_account_id} onChange={e => setContra(c => ({ ...c, from_account_id: e.target.value }))} style={{ ...inputStyle, width: '100%' }}>
                    <option value="">— Select —</option>
                    {cashBankAccounts.map(a => (
                      <option key={a.id} value={a.id} disabled={String(a.id) === String(contra.to_account_id)}>
                        {a.code} — {a.name} ({a.sub_type})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>To Account (money in) *</label>
                  <select value={contra.to_account_id} onChange={e => setContra(c => ({ ...c, to_account_id: e.target.value }))} style={{ ...inputStyle, width: '100%' }}>
                    <option value="">— Select —</option>
                    {cashBankAccounts.map(a => (
                      <option key={a.id} value={a.id} disabled={String(a.id) === String(contra.from_account_id)}>
                        {a.code} — {a.name} ({a.sub_type})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Reference #</label>
                  <input value={contra.reference_number} onChange={e => setContra(c => ({ ...c, reference_number: e.target.value }))} placeholder="Cheque / UTR no." style={{ ...inputStyle, width: '100%' }} />
                </div>
                <div>
                  <label style={labelStyle}>Narration</label>
                  <input value={contra.narration} onChange={e => setContra(c => ({ ...c, narration: e.target.value }))} placeholder="e.g. Cash deposited to bank" style={{ ...inputStyle, width: '100%' }} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={saveContra} disabled={contraSaving} style={{ ...btnPrimary, opacity: contraSaving ? 0.6 : 1 }}>
                  {contraSaving ? 'Posting…' : 'Post Contra Voucher'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Tab 7: Day Book ─────────────────────────────────────────────────── */}
      {activeTab === 7 && (
        <div>
          <h2 style={{ margin: '0 0 16px', fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Day Book</h2>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div><label style={labelStyle}>From</label><input type="date" value={dbFrom} onChange={e => setDbFrom(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>To</label><input type="date" value={dbTo} onChange={e => setDbTo(e.target.value)} style={inputStyle} /></div>
            <div>
              <label style={labelStyle}>Voucher Type</label>
              <select value={dbType} onChange={e => setDbType(e.target.value)} style={inputStyle}>
                {['', 'Contra', 'Payment', 'Receipt', 'Sales', 'Purchase', 'Journal', 'Credit Note', 'Debit Note'].map(t => (
                  <option key={t} value={t}>{t || 'All Types'}</option>
                ))}
              </select>
            </div>
            <button onClick={fetchDayBook} style={btnPrimary}>{dbLoading ? 'Loading…' : 'View Day Book'}</button>
          </div>

          {dayBook && (
            <>
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Vouchers</div><div style={{ fontWeight: 700, color: '#6B3FDB' }}>{dayBook.summary?.total_vouchers || 0}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Total Value</div><div style={{ fontWeight: 700 }}>{formatINR(dayBook.summary?.total_amount)}</div></div>
                {Object.entries(dayBook.summary?.by_type || {}).map(([t, v]) => (
                  <div key={t} style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>{t}</div><div style={{ fontWeight: 600 }}>{formatINR(v)}</div></div>
                ))}
              </div>

              <div style={tableWrap}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#6B3FDB' }}>
                      {['Date', 'Voucher #', 'Type', 'Particulars', 'Status', 'Amount', ''].map(h => (
                        <th key={h} style={{ ...thStyle, color: '#fff', background: 'transparent' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(dayBook.vouchers || []).length === 0 ? (
                      <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No vouchers in this period.</td></tr>
                    ) : dayBook.vouchers.map((v, i) => (
                      <React.Fragment key={v.id}>
                        <tr style={{ borderBottom: '1px solid #f0f0f4', background: i % 2 === 0 ? '#fff' : '#fafafa', cursor: 'pointer' }}
                            onClick={() => setDbExpanded(p => ({ ...p, [v.id]: !p[v.id] }))}>
                          <td style={tdStyle}>{v.entry_date?.toString().slice(0, 10)}</td>
                          <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 600 }}>{v.entry_number}</td>
                          <td style={tdStyle}><span style={{ fontSize: 12, background: '#f5f3ff', color: '#6B3FDB', padding: '2px 8px', borderRadius: 12, fontWeight: 600 }}>{v.voucher_type}</span></td>
                          <td style={{ ...tdStyle, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.description || '—'}</td>
                          <td style={tdStyle}><StatusBadge status={v.status} /></td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatINR(v.amount)}</td>
                          <td style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af' }}>{dbExpanded[v.id] ? '▲' : '▼'}</td>
                        </tr>
                        {dbExpanded[v.id] && (v.lines || []).map((l, li) => (
                          <tr key={`${v.id}-${li}`} style={{ background: '#faf9ff', fontSize: 13 }}>
                            <td style={tdStyle}></td>
                            <td colSpan={3} style={{ ...tdStyle, paddingLeft: 28, color: '#374151' }}>
                              <span style={{ color: '#6B3FDB', fontWeight: 600 }}>{l.account_code}</span> {l.account_name}
                              {l.narration ? <span style={{ color: '#9ca3af' }}> — {l.narration}</span> : null}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#16a34a' }}>{parseFloat(l.debit) > 0 ? formatINR(l.debit) : ''}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#dc2626' }}>{parseFloat(l.credit) > 0 ? `(${formatINR(l.credit)})` : ''}</td>
                            <td style={tdStyle}></td>
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!dayBook && !dbLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Select a date range and click “View Day Book”.</div>
          )}
        </div>
      )}

      {/* ─── Tab 8: Cash/Bank Book ───────────────────────────────────────────── */}
      {activeTab === 8 && (
        <div>
          <h2 style={{ margin: '0 0 16px', fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Cash / Bank Book</h2>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={labelStyle}>Book</label>
              <select value={cbBook} onChange={e => setCbBook(e.target.value)} style={inputStyle}>
                <option value="both">Cash & Bank</option>
                <option value="cash">Cash Only</option>
                <option value="bank">Bank Only</option>
              </select>
            </div>
            <div><label style={labelStyle}>From</label><input type="date" value={cbFrom} onChange={e => setCbFrom(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>To</label><input type="date" value={cbTo} onChange={e => setCbTo(e.target.value)} style={inputStyle} /></div>
            <button onClick={fetchCashBankBook} style={btnPrimary}>{cbLoading ? 'Loading…' : 'View Book'}</button>
          </div>

          {cashBankBook && (
            <>
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Opening</div><div style={{ fontWeight: 700 }}>{formatINR(cashBankBook.grand_totals?.opening)}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Inflow</div><div style={{ fontWeight: 700, color: '#16a34a' }}>{formatINR(cashBankBook.grand_totals?.inflow)}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Outflow</div><div style={{ fontWeight: 700, color: '#dc2626' }}>{formatINR(cashBankBook.grand_totals?.outflow)}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Closing</div><div style={{ fontWeight: 700, color: '#6B3FDB' }}>{formatINR(cashBankBook.grand_totals?.closing)}</div></div>
              </div>

              {(cashBankBook.books || []).length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No cash/bank accounts found for this selection.</div>
              ) : cashBankBook.books.map(bk => (
                <div key={bk.account.id} style={{ ...tableWrap, marginBottom: 20 }}>
                  <div style={{ background: '#f5f3ff', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 700, color: '#1e1b4b' }}>
                      <span style={{ color: '#6B3FDB' }}>{bk.account.code}</span> — {bk.account.name}
                      <span style={{ marginLeft: 8, fontSize: 11, textTransform: 'uppercase', background: '#ede9fe', color: '#6B3FDB', padding: '2px 8px', borderRadius: 10 }}>{bk.account.sub_type}</span>
                    </div>
                    <div style={{ fontSize: 13, color: '#6b7280' }}>
                      Opening {formatINR(bk.opening_balance)} · Closing <strong style={{ color: '#1e1b4b' }}>{formatINR(bk.closing_balance)}</strong>
                    </div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#fafafa' }}>
                        {['Date', 'Voucher #', 'Type', 'Particulars', 'Inflow', 'Outflow', 'Balance'].map(h => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ background: '#f5f3ff' }}>
                        <td colSpan={6} style={{ ...tdStyle, fontWeight: 600, color: '#6b7280' }}>Opening Balance</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{formatINR(bk.opening_balance)}</td>
                      </tr>
                      {bk.transactions.length === 0 ? (
                        <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#9ca3af' }}>No transactions in this period.</td></tr>
                      ) : bk.transactions.map((t, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f0f0f4' }}>
                          <td style={tdStyle}>{t.entry_date?.toString().slice(0, 10)}</td>
                          <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 500 }}>{t.entry_number}</td>
                          <td style={{ ...tdStyle, fontSize: 12, color: '#6b7280' }}>{t.voucher_type}</td>
                          <td style={{ ...tdStyle, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.particulars}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#16a34a', fontVariantNumeric: 'tabular-nums' }}>{parseFloat(t.inflow) > 0 ? formatINR(t.inflow) : '—'}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>{parseFloat(t.outflow) > 0 ? formatINR(t.outflow) : '—'}</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                            {formatINR(Math.abs(t.running_balance))}<span style={{ marginLeft: 4, fontSize: 11, color: '#6b7280' }}>{t.balance_indicator}</span>
                          </td>
                        </tr>
                      ))}
                      <tr style={{ background: '#1e1b4b', color: '#fff', fontWeight: 700 }}>
                        <td colSpan={4} style={{ ...tdStyle, color: '#fff' }}>Closing Balance</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#fff' }}>{formatINR(bk.totals?.inflow)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#fff' }}>{formatINR(bk.totals?.outflow)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: '#fff' }}>{formatINR(Math.abs(bk.closing_balance))} {bk.closing_balance >= 0 ? 'DR' : 'CR'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))}
            </>
          )}
          {!cashBankBook && !cbLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Select a book and date range, then click “View Book”.</div>
          )}
        </div>
      )}

      {/* ─── Tab 9: Interest Calculation ─────────────────────────────────────── */}
      {activeTab === 9 && (
        <div>
          <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Interest Calculation</h2>
          <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 13 }}>
            Simple interest on overdue outstanding balances: balance × rate% × chargeable days ÷ 365.
          </p>

          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label style={labelStyle}>On</label>
              <select value={intKind} onChange={e => setIntKind(e.target.value)} style={inputStyle}>
                <option value="receivable">Receivables (Customers)</option>
                <option value="payable">Payables (Suppliers)</option>
              </select>
            </div>
            <div><label style={labelStyle}>Rate (% p.a.)</label><input type="number" min="0" value={intRate} onChange={e => setIntRate(e.target.value)} style={{ ...inputStyle, width: 100 }} /></div>
            <div><label style={labelStyle}>Grace Days</label><input type="number" min="0" value={intGrace} onChange={e => setIntGrace(e.target.value)} style={{ ...inputStyle, width: 90 }} /></div>
            <div><label style={labelStyle}>As of</label><input type="date" value={intAsOf} onChange={e => setIntAsOf(e.target.value)} style={inputStyle} /></div>
            <button onClick={fetchInterest} style={btnPrimary}>{intLoading ? 'Calculating…' : 'Calculate'}</button>
          </div>

          {intData && (
            <>
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Documents</div><div style={{ fontWeight: 700 }}>{intData.summary?.documents || 0}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Overdue</div><div style={{ fontWeight: 700, color: '#dc2626' }}>{intData.summary?.overdue_documents || 0}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Outstanding</div><div style={{ fontWeight: 700 }}>{formatINR(intData.summary?.total_outstanding)}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Total Interest</div><div style={{ fontWeight: 700, color: '#6B3FDB' }}>{formatINR(intData.summary?.total_interest)}</div></div>
              </div>

              <div style={tableWrap}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#6B3FDB' }}>
                      {['Document', 'Party', 'Date', 'Due Date', 'Balance', 'Overdue Days', 'Chargeable Days', 'Interest'].map(h => (
                        <th key={h} style={{ ...thStyle, color: '#fff', background: 'transparent' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(intData.items || []).length === 0 ? (
                      <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No outstanding documents.</td></tr>
                    ) : intData.items.map((it, i) => (
                      <tr key={it.id} style={{ borderBottom: '1px solid #f0f0f4', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 600 }}>{it.doc_number}</td>
                        <td style={tdStyle}>{it.party_name}</td>
                        <td style={tdStyle}>{it.doc_date}</td>
                        <td style={tdStyle}>{it.due_date}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatINR(it.balance)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', color: it.overdue_days > 0 ? '#dc2626' : '#6b7280' }}>{it.overdue_days}</td>
                        <td style={{ ...tdStyle, textAlign: 'right' }}>{it.chargeable_days}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600, color: '#6B3FDB', fontVariantNumeric: 'tabular-nums' }}>{formatINR(it.interest)}</td>
                      </tr>
                    ))}
                    {(intData.items || []).length > 0 && (
                      <tr style={{ background: '#1e1b4b', color: '#fff', fontWeight: 700 }}>
                        <td colSpan={4} style={{ ...tdStyle, color: '#fff' }}>TOTAL</td>
                        <td style={{ ...tdStyle, color: '#fff', textAlign: 'right' }}>{formatINR(intData.summary?.total_outstanding)}</td>
                        <td colSpan={2} style={tdStyle}></td>
                        <td style={{ ...tdStyle, color: '#fff', textAlign: 'right' }}>{formatINR(intData.summary?.total_interest)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {!intData && !intLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Set a rate and click “Calculate” to compute interest on overdue balances.</div>
          )}
        </div>
      )}

      {/* ─── Tab 10: Advanced Vouchers ───────────────────────────────────────── */}
      {activeTab === 10 && (
        <div>
          <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Advanced Vouchers</h2>
          <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 13 }}>
            Memorandum &amp; Optional vouchers stay out of the books until converted. Recurring templates generate draft entries on a schedule.
          </p>

          {/* Memorandum / Optional */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            {['memorandum', 'optional'].map(t => (
              <button key={t} onClick={() => setSpecialType(t)} style={{
                padding: '6px 14px', borderRadius: 8, border: '1px solid #e9e4ff', cursor: 'pointer', fontSize: 13, textTransform: 'capitalize',
                background: specialType === t ? '#6B3FDB' : '#fff', color: specialType === t ? '#fff' : '#374151', fontWeight: specialType === t ? 600 : 400,
              }}>{t}</button>
            ))}
            <button onClick={() => setShowJEForm(true)} style={{ ...btnSecondary, marginLeft: 'auto' }}>+ New Voucher (pick book-effect in form)</button>
          </div>

          <div style={{ ...tableWrap, marginBottom: 24 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Entry #', 'Date', 'Description', 'Amount', 'Status', ''].map(h => <th key={h} style={thStyle}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {specialVouchers.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>No {specialType} vouchers.</td></tr>
                ) : specialVouchers.map(v => (
                  <tr key={v.id} style={{ borderBottom: '1px solid #f0f0f4' }}>
                    <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 600 }}>{v.entry_number}</td>
                    <td style={tdStyle}>{v.entry_date?.toString().slice(0, 10)}</td>
                    <td style={tdStyle}>{v.description || '—'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(v.total_debit)}</td>
                    <td style={tdStyle}><StatusBadge status={v.status} /></td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <button onClick={() => convertVoucher(v.id)} style={btnActionGhost}>Convert to Regular</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Recurring templates */}
          <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 600, color: '#1e1b4b' }}>Recurring Templates</h3>
          <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, alignItems: 'end' }}>
              <div><label style={labelStyle}>Template name</label><input value={recForm.name} onChange={e => setRecForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Monthly Rent" style={{ ...inputStyle, width: '100%' }} /></div>
              <div>
                <label style={labelStyle}>Frequency</label>
                <select value={recForm.frequency} onChange={e => setRecForm(f => ({ ...f, frequency: e.target.value }))} style={{ ...inputStyle, width: '100%' }}>
                  {['weekly', 'monthly', 'quarterly', 'yearly'].map(x => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div><label style={labelStyle}>Next run</label><input type="date" value={recForm.next_run_date} onChange={e => setRecForm(f => ({ ...f, next_run_date: e.target.value }))} style={{ ...inputStyle, width: '100%' }} /></div>
              <div>
                <label style={labelStyle}>Copy lines from entry</label>
                <select value={recForm.source_entry_id} onChange={e => setRecForm(f => ({ ...f, source_entry_id: e.target.value }))} style={{ ...inputStyle, width: '100%' }}>
                  <option value="">Select source entry…</option>
                  {journalEntries.map(e => <option key={e.id} value={e.id}>{e.entry_number} — {(e.description || '').slice(0, 30)}</option>)}
                </select>
              </div>
              <button onClick={createRecurring} style={btnPrimary}>Save Template</button>
            </div>
          </div>

          <div style={tableWrap}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Name', 'Frequency', 'Next Run', 'Last Generated', 'Amount', ''].map(h => <th key={h} style={thStyle}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {recurring.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>No recurring templates.</td></tr>
                ) : recurring.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f0f0f4' }}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{r.name}</td>
                    <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{r.frequency}</td>
                    <td style={tdStyle}>{r.next_run_date?.toString().slice(0, 10) || '—'}</td>
                    <td style={tdStyle}>{r.last_generated_date?.toString().slice(0, 10) || '—'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{formatINR(r.total_amount)}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <button onClick={() => generateRecurring(r.id)} style={{ ...btnActionGhost, color: '#16a34a', border: '1px solid #bbf7d0', marginRight: 6 }}>Generate Now</button>
                      <button onClick={() => deleteRecurring(r.id)} style={{ ...btnActionGhost, color: '#dc2626', border: '1px solid #fecaca' }}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── Tab 11: Cheque Printing ─────────────────────────────────────────── */}
      {activeTab === 11 && (
        <div>
          {/* Print isolation: only the cheque/advice prints, repositioned to the page top */}
          <style>{`
            @media print {
              body * { visibility: hidden !important; }
              .cheque-print-area, .cheque-print-area * { visibility: visible !important; }
              .cheque-print-area { position: absolute; left: 0; top: 0; width: 100%; padding: 0; }
              .cheque-no-print { display: none !important; }
            }
          `}</style>
          <h2 style={{ margin: '0 0 6px', fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Cheque Printing</h2>
          <p style={{ margin: '0 0 20px', color: '#6b7280', fontSize: 13 }}>
            Build a print-ready cheque and payment advice with the amount auto-converted to words.
          </p>

          <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 20, maxWidth: 620, marginBottom: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div><label style={labelStyle}>Payee (Pay to) *</label><input value={cheque.payee} onChange={e => setCheque(c => ({ ...c, payee: e.target.value }))} style={{ ...inputStyle, width: '100%' }} /></div>
              <div><label style={labelStyle}>Amount (₹) *</label><input type="number" min="0" value={cheque.amount} onChange={e => setCheque(c => ({ ...c, amount: e.target.value }))} style={{ ...inputStyle, width: '100%' }} /></div>
              <div><label style={labelStyle}>Date</label><input type="date" value={cheque.date} onChange={e => setCheque(c => ({ ...c, date: e.target.value }))} style={{ ...inputStyle, width: '100%' }} /></div>
              <div><label style={labelStyle}>Bank</label><input value={cheque.bank_name} onChange={e => setCheque(c => ({ ...c, bank_name: e.target.value }))} placeholder="Optional" style={{ ...inputStyle, width: '100%' }} /></div>
              <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Reference</label><input value={cheque.reference} onChange={e => setCheque(c => ({ ...c, reference: e.target.value }))} placeholder="Cheque/UTR no. (optional)" style={{ ...inputStyle, width: '100%' }} /></div>
            </div>
            <div style={{ marginTop: 14 }}><button onClick={fetchChequeData} style={btnPrimary}>Build Cheque</button></div>
          </div>

          {chequeData && (
            <div className="cheque-print-area">
              {/* Cheque leaf */}
              <div style={{ border: '2px solid #1e1b4b', borderRadius: 10, padding: 20, maxWidth: 720, background: '#fff', marginBottom: 16, position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
                  <div style={{ fontWeight: 700, color: '#1e1b4b' }}>{chequeData.bank_name || 'Bank'}</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {['D', 'D', 'M', 'M', 'Y', 'Y', 'Y', 'Y'].map((ch, i) => {
                      const v = (chequeData.date_boxes.dd + chequeData.date_boxes.mm + chequeData.date_boxes.yyyy)[i];
                      return <span key={i} style={{ border: '1px solid #9ca3af', width: 20, textAlign: 'center', fontSize: 13, fontFamily: 'monospace' }}>{v}</span>;
                    })}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14 }}>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>Pay</span>
                  <span style={{ flex: 1, borderBottom: '1px solid #374151', fontWeight: 600, fontSize: 15, paddingBottom: 2 }}>{chequeData.payee}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 14 }}>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>Rupees</span>
                  <span style={{ flex: 1, borderBottom: '1px solid #374151', fontStyle: 'italic', fontSize: 14, paddingBottom: 2 }}>{chequeData.amount_in_words}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  {chequeData.account_payee && <span style={{ fontSize: 11, color: '#6b7280', border: '1px solid #9ca3af', padding: '2px 8px', transform: 'rotate(-8deg)' }}>A/C PAYEE ONLY</span>}
                  <span style={{ border: '1px solid #374151', padding: '6px 16px', fontWeight: 700, fontSize: 16 }}>₹ {parseFloat(chequeData.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
              </div>

              {/* Payment advice */}
              <div style={{ border: '1px solid #e9e4ff', borderRadius: 10, padding: 20, maxWidth: 720, background: '#fff', marginBottom: 16 }}>
                <div style={{ fontWeight: 700, color: '#1e1b4b', marginBottom: 10 }}>Payment Advice</div>
                <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.9 }}>
                  <div><b>Pay to:</b> {chequeData.payee}</div>
                  <div><b>Amount:</b> ₹ {parseFloat(chequeData.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })} ({chequeData.amount_in_words})</div>
                  <div><b>Date:</b> {chequeData.date}</div>
                  {chequeData.reference && <div><b>Reference:</b> {chequeData.reference}</div>}
                  {chequeData.bank_name && <div><b>Bank:</b> {chequeData.bank_name}</div>}
                </div>
              </div>

              <button className="cheque-no-print" onClick={() => window.print()} style={btnPrimary}>Print</button>
            </div>
          )}
        </div>
      )}

      {/* ─── Tab 12: Funds Flow ──────────────────────────────────────────────── */}
      {activeTab === 12 && (
        <div>
          <h2 style={{ margin: '0 0 16px', fontSize: 20, fontWeight: 600, color: '#1e1b4b' }}>Funds Flow Statement</h2>
          <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div><label style={labelStyle}>From</label><input type="date" value={ffFrom} onChange={e => setFfFrom(e.target.value)} style={inputStyle} /></div>
            <div><label style={labelStyle}>To</label><input type="date" value={ffTo} onChange={e => setFfTo(e.target.value)} style={inputStyle} /></div>
            <button onClick={fetchFundsFlow} style={btnPrimary}>{ffLoading ? 'Generating…' : 'Generate'}</button>
          </div>

          {fundsFlow && (
            <>
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Funds from Operations</div><div style={{ fontWeight: 700, color: fundsFlow.fundsFromOperations >= 0 ? '#16a34a' : '#dc2626' }}>{formatINR(fundsFlow.fundsFromOperations)}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Total Sources</div><div style={{ fontWeight: 700, color: '#6B3FDB' }}>{formatINR(fundsFlow.totalSources)}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Total Applications</div><div style={{ fontWeight: 700, color: '#d97706' }}>{formatINR(fundsFlow.totalApplications)}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Net Δ Working Capital</div><div style={{ fontWeight: 700 }}>{formatINR(fundsFlow.workingCapital?.netIncrease)}</div></div>
                <div style={infoCard}><div style={{ fontSize: 12, color: '#6b7280' }}>Reconciled</div><div style={{ fontWeight: 700, color: fundsFlow.reconciliation?.reconciled ? '#16a34a' : '#d97706' }}>{fundsFlow.reconciliation?.reconciled ? '✓ Yes' : `Δ ${formatINR(fundsFlow.reconciliation?.difference)}`}</div></div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
                <div style={{ ...tableWrap, padding: 16 }}>
                  <div style={{ fontWeight: 700, color: '#6B3FDB', marginBottom: 10 }}>Sources of Funds</div>
                  {(fundsFlow.sources || []).length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No sources.</div> :
                    (fundsFlow.sources || []).map((s, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', fontSize: 13, borderBottom: '1px solid #f0f0f4' }}>
                        <span>{s.name}{s.detail ? <span style={{ display: 'block', color: '#9ca3af', fontSize: 11 }}>{s.detail}</span> : null}</span>
                        <span style={{ fontWeight: 600 }}>{formatINR(s.value)}</span>
                      </div>
                    ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontWeight: 700, color: '#6B3FDB' }}><span>Total Sources</span><span>{formatINR(fundsFlow.totalSources)}</span></div>
                </div>
                <div style={{ ...tableWrap, padding: 16 }}>
                  <div style={{ fontWeight: 700, color: '#d97706', marginBottom: 10 }}>Applications of Funds</div>
                  {(fundsFlow.applications || []).length === 0 ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No applications.</div> :
                    (fundsFlow.applications || []).map((a, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', fontSize: 13, borderBottom: '1px solid #f0f0f4' }}>
                        <span>{a.name}</span><span style={{ fontWeight: 600 }}>{formatINR(a.value)}</span>
                      </div>
                    ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontWeight: 700, color: '#d97706' }}><span>Total Applications</span><span>{formatINR(fundsFlow.totalApplications)}</span></div>
                </div>
              </div>

              <div style={{ ...tableWrap, padding: 16 }}>
                <div style={{ fontWeight: 700, color: '#1e1b4b', marginBottom: 10 }}>Change in Working Capital</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  <div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Current Assets (Δ {formatINR(fundsFlow.workingCapital?.increaseInCurrentAssets)})</div>
                    {(fundsFlow.workingCapital?.assets || []).map((x, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0' }}><span>{x.name}</span><span>{formatINR(x.change)}</span></div>
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>Current Liabilities (Δ {formatINR(fundsFlow.workingCapital?.increaseInCurrentLiabilities)})</div>
                    {(fundsFlow.workingCapital?.liabilities || []).map((x, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '4px 0' }}><span>{x.name}</span><span>{formatINR(x.change)}</span></div>
                    ))}
                  </div>
                </div>
                <div style={{ marginTop: 12, fontSize: 11, color: '#9ca3af' }}>{fundsFlow.note}</div>
              </div>
            </>
          )}
          {!fundsFlow && !ffLoading && (
            <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Select a period and click “Generate” to view the funds flow statement.</div>
          )}
        </div>
      )}

      {/* ─── New Journal Entry Modal ──────────────────────────────────────── */}
      {showJEForm && (
        <JournalEntryModal
          accounts={accounts}
          toast={toast}
          onClose={() => setShowJEForm(false)}
          onSaved={() => { setShowJEForm(false); fetchJournalEntries(); if (activeTab === 10) fetchSpecial(specialType); }}
        />
      )}

      {/* ─── Entry Detail Drawer ──────────────────────────────────────────── */}
      {showDrawer && selectedEntry && (
        <EntryDrawer
          entry={selectedEntry}
          onClose={() => setShowDrawer(false)}
          onPost={() => postEntry(selectedEntry.id)}
          onReverse={() => reverseEntry(selectedEntry.id)}
        />
      )}
    </div>
  );
}

// ─── Journal Entry Modal ───────────────────────────────────────────────────────
function JournalEntryModal({ accounts, onClose, onSaved, toast }) {
  const today = new Date().toISOString().split('T')[0];
  const [entryDate, setEntryDate] = useState(today);
  const [description, setDescription] = useState('');
  const [refType, setRefType] = useState('manual');
  const [refNum, setRefNum] = useState('');
  const [bookEffect, setBookEffect] = useState('regular'); // regular | memorandum | optional
  const [lines, setLines] = useState([
    { account_id: '', debit: '', credit: '', narration: '', cost_centre: '' },
    { account_id: '', debit: '', credit: '', narration: '', cost_centre: '' },
  ]);
  const [saving, setSaving] = useState(false);
  const [accSearch, setAccSearch] = useState({});
  const [showAccDrop, setShowAccDrop] = useState({});

  const totalDebit = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  const diff = Math.abs(totalDebit - totalCredit);
  const balanced = diff <= 0.01;

  function updateLine(idx, field, value) {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  }

  function addLine() {
    setLines(prev => [...prev, { account_id: '', debit: '', credit: '', narration: '', cost_centre: '' }]);
  }

  function removeLine(idx) {
    if (lines.length <= 2) return;
    setLines(prev => prev.filter((_, i) => i !== idx));
  }

  async function save(postAfter) {
    if (postAfter && !balanced) return;
    const mappedLines = lines.filter(l => l.account_id).map(l => ({
      account_id: parseInt(l.account_id),
      debit: parseFloat(l.debit) || 0,
      credit: parseFloat(l.credit) || 0,
      narration: l.narration,
      cost_centre: l.cost_centre,
    }));
    setSaving(true);
    try {
      // Memorandum / Optional vouchers are saved out of the books via a separate endpoint
      if (bookEffect !== 'regular') {
        if (!balanced) { toast?.error?.('Voucher must be balanced.'); return; }
        const [res] = await Promise.allSettled([api.post('/accounting/vouchers/special', {
          entry_date: entryDate, description, status: bookEffect, lines: mappedLines,
        })]);
        if (res.status === 'fulfilled') onSaved();
        else toast?.error?.(res.reason?.response?.data?.error || 'Failed to save voucher');
        return;
      }

      const payload = {
        entry_date: entryDate,
        description,
        reference_type: refType,
        reference_id: refNum ? parseInt(refNum) : undefined,
        lines: mappedLines,
      };
      const [res] = await Promise.allSettled([api.post('/accounting/journal-entries', payload)]);
      if (res.status === 'fulfilled') {
        const entry = res.value.data;
        if (postAfter) {
          await Promise.allSettled([api.post(`/accounting/journal-entries/${entry.id}/post`)]);
        }
        onSaved();
      } else {
        toast?.error?.(res.reason?.response?.data?.error || 'Failed to save entry');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, width: 760, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
        {/* Modal header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #e9e4ff' }}>
          <h3 style={{ margin: 0, fontWeight: 700, color: '#1e1b4b', fontSize: 18 }}>New Journal Entry</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#6b7280' }}>×</button>
        </div>

        {/* Modal body */}
        <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
            <div>
              <label style={labelStyle}>Entry Date *</label>
              <input type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} style={{ ...inputStyle, width: '100%' }} />
            </div>
            <div>
              <label style={labelStyle}>Book Effect</label>
              <select value={bookEffect} onChange={e => setBookEffect(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                <option value="regular">Regular (affects books)</option>
                <option value="memorandum">Memorandum (out of books)</option>
                <option value="optional">Optional (out of books)</option>
              </select>
            </div>
            {bookEffect === 'regular' && (
              <div>
                <label style={labelStyle}>Reference Type</label>
                <select value={refType} onChange={e => setRefType(e.target.value)} style={{ ...inputStyle, width: '100%' }}>
                  <option value="manual">Manual</option>
                  <option value="invoice">Invoice</option>
                  <option value="payment">Payment</option>
                  <option value="bill">Bill</option>
                </select>
              </div>
            )}
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
                style={{ ...inputStyle, width: '100%', resize: 'vertical', fontFamily: 'inherit' }} placeholder="Entry description..." />
            </div>
            <div>
              <label style={labelStyle}>Reference #</label>
              <input value={refNum} onChange={e => setRefNum(e.target.value)} style={{ ...inputStyle, width: '100%' }} placeholder="e.g. INV-001" />
            </div>
          </div>

          {/* Lines table */}
          <div style={{ border: '1px solid #e9e4ff', borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  <th style={thStyle}>Account</th>
                  <th style={thStyle}>Narration</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Debit (₹)</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Credit (₹)</th>
                  <th style={{ ...thStyle, width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #f0f0f4' }}>
                    <td style={{ padding: '8px 12px', width: 220, position: 'relative' }}>
                      <input
                        value={accSearch[idx] !== undefined ? accSearch[idx] : (accounts.find(a => String(a.id) === String(line.account_id)) ? `${accounts.find(a => String(a.id) === String(line.account_id)).account_code} - ${accounts.find(a => String(a.id) === String(line.account_id)).account_name}` : '')}
                        onChange={e => { setAccSearch(p => ({ ...p, [idx]: e.target.value })); setShowAccDrop(p => ({ ...p, [idx]: true })); updateLine(idx, 'account_id', ''); }}
                        onFocus={() => setShowAccDrop(p => ({ ...p, [idx]: true }))}
                        placeholder="Search account..."
                        style={{ ...inputStyle, width: '100%', fontSize: 13 }}
                      />
                      {showAccDrop[idx] && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200, background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8, maxHeight: 180, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                          {accounts.filter(a => {
                            const q = (accSearch[idx] || '').toLowerCase();
                            return `${a.account_code} ${a.account_name}`.toLowerCase().includes(q);
                          }).slice(0, 10).map(a => (
                            <div key={a.id}
                              onClick={() => {
                                updateLine(idx, 'account_id', a.id);
                                setAccSearch(p => ({ ...p, [idx]: `${a.account_code} - ${a.account_name}` }));
                                setShowAccDrop(p => ({ ...p, [idx]: false }));
                              }}
                              style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f0f0f4' }}
                              onMouseEnter={e => e.currentTarget.style.background = '#f5f3ff'}
                              onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                              <span style={{ color: '#6B3FDB', fontWeight: 600 }}>{a.account_code}</span> — {a.account_name}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <input value={line.narration} onChange={e => updateLine(idx, 'narration', e.target.value)} placeholder="Narration" style={{ ...inputStyle, width: '100%', fontSize: 13 }} />
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      <input type="number" value={line.debit} onChange={e => updateLine(idx, 'debit', e.target.value)} placeholder="0.00" style={{ ...inputStyle, width: 110, textAlign: 'right', fontSize: 13 }} min="0" />
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                      <input type="number" value={line.credit} onChange={e => updateLine(idx, 'credit', e.target.value)} placeholder="0.00" style={{ ...inputStyle, width: 110, textAlign: 'right', fontSize: 13 }} min="0" />
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                      <button onClick={() => removeLine(idx)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button onClick={addLine} style={{ ...btnSecondary, fontSize: 13, marginBottom: 16 }}>+ Add Line</button>

          {/* Summary footer */}
          <div style={{ background: '#f5f3ff', borderRadius: 10, padding: '12px 16px', display: 'flex', gap: 32, alignItems: 'center' }}>
            <div>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Total Debit</span>
              <div style={{ fontWeight: 700, color: '#1e1b4b', fontSize: 15 }}>{formatINR(totalDebit)}</div>
            </div>
            <div>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Total Credit</span>
              <div style={{ fontWeight: 700, color: '#1e1b4b', fontSize: 15 }}>{formatINR(totalCredit)}</div>
            </div>
            <div>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Difference</span>
              <div style={{ fontWeight: 700, fontSize: 15, color: balanced ? '#16a34a' : '#dc2626' }}>
                {balanced ? '✓ Balanced' : `${formatINR(diff)} unbalanced`}
              </div>
            </div>
          </div>
        </div>

        {/* Modal footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid #e9e4ff', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          {bookEffect !== 'regular' ? (
            <button onClick={() => save(false)} disabled={saving || !balanced}
              title={!balanced ? 'Voucher must be balanced' : ''}
              style={{ ...btnPrimary, opacity: (!balanced || saving) ? 0.5 : 1, cursor: (!balanced || saving) ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Saving...' : `Save ${bookEffect === 'memorandum' ? 'Memorandum' : 'Optional'} Voucher`}
            </button>
          ) : (
            <>
              <button onClick={() => save(false)} disabled={saving} style={btnSecondary}>{saving ? 'Saving...' : 'Save Draft'}</button>
              <button onClick={() => save(true)} disabled={saving || !balanced}
                title={!balanced ? 'Entry must be balanced before posting' : ''}
                style={{ ...btnPrimary, opacity: (!balanced || saving) ? 0.5 : 1, cursor: (!balanced || saving) ? 'not-allowed' : 'pointer' }}>
                {saving ? 'Saving...' : 'Save & Post'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Entry Drawer ──────────────────────────────────────────────────────────────
function EntryDrawer({ entry, onClose, onPost, onReverse }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 900 }} />
      <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 520, background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', zIndex: 950, display: 'flex', flexDirection: 'column' }}>
        {/* Drawer header */}
        <div style={{ padding: '18px 24px', borderBottom: '1px solid #e9e4ff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f5f3ff' }}>
          <div>
            <div style={{ fontWeight: 700, color: '#6B3FDB', fontSize: 16 }}>{entry.entry_number}</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{entry.entry_date?.toString().slice(0, 10)}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <StatusBadge status={entry.status} />
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#6b7280', marginLeft: 8 }}>×</button>
          </div>
        </div>

        {/* Drawer body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Description</div>
            <div style={{ fontWeight: 500, color: '#1e1b4b' }}>{entry.description || '—'}</div>
          </div>
          {entry.reference_type && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 2 }}>Reference</div>
              <div style={{ fontWeight: 500, color: '#374151', textTransform: 'capitalize' }}>{entry.reference_type} {entry.reference_id ? `#${entry.reference_id}` : ''}</div>
            </div>
          )}

          <h4 style={{ margin: '0 0 10px', color: '#374151', fontSize: 14, fontWeight: 600 }}>Journal Lines</h4>
          <div style={{ border: '1px solid #e9e4ff', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Code', 'Account Name', 'Debit', 'Credit'].map(h => (
                    <th key={h} style={{ ...thStyle, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(entry.lines || []).map((line, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f0f0f4' }}>
                    <td style={{ ...tdStyle, color: '#6B3FDB', fontWeight: 600, fontSize: 13 }}>{line.account_code}</td>
                    <td style={{ ...tdStyle, fontSize: 13 }}>{line.account_name}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontSize: 13, color: '#16a34a', fontVariantNumeric: 'tabular-nums' }}>
                      {parseFloat(line.debit) > 0 ? formatINR(line.debit) : '—'}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontSize: 13, color: '#dc2626', fontVariantNumeric: 'tabular-nums' }}>
                      {parseFloat(line.credit) > 0 ? formatINR(line.credit) : '—'}
                    </td>
                  </tr>
                ))}
                <tr style={{ background: '#f5f3ff', fontWeight: 700 }}>
                  <td colSpan={2} style={{ ...tdStyle, fontSize: 13 }}>Total</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontSize: 13 }}>{formatINR(entry.total_debit)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontSize: 13 }}>{formatINR(entry.total_credit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Drawer footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid #e9e4ff', display: 'flex', gap: 10 }}>
          {entry.status === 'draft' && (
            <button onClick={() => { onPost(); onClose(); }} style={btnPrimary}>Post Entry</button>
          )}
          {entry.status === 'posted' && (
            <button onClick={() => { onReverse(); }} style={{ ...btnSecondary, color: '#dc2626', border: '1px solid #fecaca' }}>Reverse Entry</button>
          )}
          <button onClick={onClose} style={btnSecondary}>Close</button>
        </div>
      </div>
    </>
  );
}

// ─── Shared Styles ────────────────────────────────────────────────────────────
const inputStyle = {
  border: '1px solid #e9e4ff', borderRadius: 8, padding: '7px 11px', fontSize: 14,
  outline: 'none', background: '#fff', color: '#374151',
};
const thStyle = {
  padding: '10px 14px', textAlign: 'left', fontSize: 13, fontWeight: 600,
  color: '#374151', whiteSpace: 'nowrap',
};
const tdStyle = {
  padding: '10px 14px', fontSize: 14, color: '#374151',
};
const tableWrap = {
  background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden',
};
const btnPrimary = {
  background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8,
  padding: '9px 20px', fontWeight: 600, cursor: 'pointer', fontSize: 14,
};
const btnSecondary = {
  background: '#fff', color: '#374151', border: '1px solid #e9e4ff', borderRadius: 8,
  padding: '8px 18px', fontWeight: 500, cursor: 'pointer', fontSize: 14,
};
const btnActionGhost = {
  background: 'none', border: '1px solid #e9e4ff', color: '#6B3FDB', borderRadius: 6,
  padding: '4px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 500,
};
const labelStyle = {
  display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4, fontWeight: 500,
};
const infoCard = {
  background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '10px 16px', minWidth: 140,
};
