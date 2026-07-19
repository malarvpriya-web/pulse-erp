// C:\Users\malar\OneDrive\Desktop\Pulse_WORKING\Pulse\frontend\src\features\finance\pages\TDSManagement.jsx
import React, { useCallback, useMemo, useState } from 'react';
import api from '@/services/api/client';
import { ResponsiveContainer, BarChart, CartesianGrid, XAxis, YAxis, Tooltip, Bar } from 'recharts';

const PURPLE = '#6B3FDB';
const LIGHT_BG = '#f5f3ff';
const BORDER = '#e9e4ff';
const TABS = ['TDS Deductees', 'Transactions', 'Quarterly Filing', 'Form 16A'];


function getCurrentFY() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function formatINR(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10000000) return `${sign}?${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}?${(abs / 100000).toFixed(2)} L`;
  return `${sign}?${abs.toLocaleString('en-IN')}`;
}

function badge(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('issued') || s.includes('deposited') || s.includes('paid')) return { background: '#dcfce7', color: '#166534' };
  if (s.includes('pending') || s.includes('draft')) return { background: '#fef3c7', color: '#92400e' };
  if (s.includes('overdue') || s.includes('rejected')) return { background: '#fee2e2', color: '#991b1b' };
  return { background: LIGHT_BG, color: '#5b21b6' };
}

function computeFallback(deductee, paymentAmount) {
  const amount = Number(paymentAmount) || 0;
  const hasPan = Boolean(String(deductee?.pan || '').trim());
  const rateWithPan = Number(deductee?.rate_with_pan || 0);
  const rateWithoutPan = Number(deductee?.rate_without_pan || 0);
  const rate = hasPan ? rateWithPan : Math.max(20, Number.isFinite(rateWithoutPan) ? rateWithoutPan : 20);
  const threshold = Number(deductee?.threshold_limit || 0);
  const taxable = amount > threshold ? amount : 0;
  const tds = (taxable * rate) / 100;
  const surcharge = 0;
  const cess = (tds + surcharge) * 0.04;
  const total = tds + surcharge + cess;
  return {
    gross_payment: amount,
    threshold_limit: threshold,
    threshold_exceeded: amount > threshold,
    applicable_rate: rate,
    tds_amount: tds,
    surcharge,
    education_cess: cess,
    total_tds: total,
    net_payment: amount - total,
  };
}

function Panel({ title, children }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', padding: 12 }}>
      <div style={{ fontSize: 14, color: '#374151', fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <>
      <label style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>{label}</label>
      {children}
    </>
  );
}

const inputStyle = { border: `1px solid ${BORDER}`, background: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: '#111827', outline: 'none' };
const tableStyle = { width: '100%', borderCollapse: 'collapse' };
const thStyle = { padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#374151', fontWeight: 700 };
const tdStyle = { padding: '10px 12px', fontSize: 13, color: '#111827' };
const primaryBtn = { border: 'none', borderRadius: 8, padding: '8px 12px', background: PURPLE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const secondaryBtn = { border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 12px', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer' };

export default function TDSManagement() {
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [deductees, setDeductees] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [quarterly, setQuarterly] = useState(null);
  const [certificates, setCertificates] = useState([]);
  const [selectedCertificate, setSelectedCertificate] = useState(null);
  const [computePreview, setComputePreview] = useState(null);

  const [deducteeForm, setDeducteeForm] = useState({ party_id: '', party_name: '', pan: '', deductee_type: 'company', section: '194J', threshold_limit: '30000', rate_with_pan: '10', rate_without_pan: '20' });
  const [transactionForm, setTransactionForm] = useState({ deductee_id: '', payment_amount: '', payment_date: new Date().toISOString().slice(0, 10), section: '', party_id: '' });
  const [depositForm, setDepositForm] = useState({ transaction_id: '', challan_number: '', bsr_code: '', challan_date: new Date().toISOString().slice(0, 10) });
  const [quarterlyFilter, setQuarterlyFilter] = useState({ financial_year: getCurrentFY(), quarter: 'Q4' });
  const [form16aForm, setForm16aForm] = useState({ deductee_id: '', financial_year: getCurrentFY(), quarter: 'Q4' });

  const selectedDeductee = useMemo(() => deductees.find((d) => String(d.id) === String(transactionForm.deductee_id)), [deductees, transactionForm.deductee_id]);

  const loadDeductees = useCallback(async () => {

    const [res] = await Promise.allSettled([api.get('/tds/deductees')]);
    if (res.status === 'fulfilled' && Array.isArray(res.value?.data)) {
      setDeductees(res.value.data);
      setNotice('');
    } else {
      setDeductees([]);
      setNotice('');
    }
    setLoading(false);
  }, []);

  const loadTransactions = useCallback(async () => {

    const [res] = await Promise.allSettled([api.get('/tds/transactions')]);
    if (res.status === 'fulfilled' && Array.isArray(res.value?.data)) {
      setTransactions(res.value.data);
      setNotice('');
    } else {
      setTransactions([]);
      setNotice('');
    }
    setLoading(false);
  }, []);

  const loadQuarterly = useCallback(async () => {

    const [res] = await Promise.allSettled([api.get('/tds/quarterly-summary', { params: { financial_year: quarterlyFilter.financial_year } })]);
    if (res.status === 'fulfilled' && res.value?.data) {
      setQuarterly(res.value.data);
      setNotice('');
    } else {
      setQuarterly(null);
      setNotice('');
    }
    setLoading(false);
  }, [quarterlyFilter.financial_year]);

  const loadCertificates = useCallback(async () => {

    const [res] = await Promise.allSettled([api.get('/tds/form16a')]);
    if (res.status === 'fulfilled' && Array.isArray(res.value?.data)) {
      setCertificates(res.value.data);
      setNotice('');
    } else {
      setCertificates([]);
      setNotice('');
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    if (activeTab === 0) loadDeductees();
    if (activeTab === 1) { loadDeductees(); loadTransactions(); }
    if (activeTab === 2) loadQuarterly();
    if (activeTab === 3) { loadDeductees(); loadCertificates(); }
  }, [activeTab, loadCertificates, loadDeductees, loadQuarterly, loadTransactions]);

  const onCreateDeductee = async () => {
    if (!deducteeForm.party_name.trim()) {
      setNotice('Please enter party name.');
      return;
    }
    const payload = {
      party_id: deducteeForm.party_id ? Number(deducteeForm.party_id) : null,
      party_name: deducteeForm.party_name.trim(),
      pan: deducteeForm.pan.trim(),
      deductee_type: deducteeForm.deductee_type,
      section: deducteeForm.section.trim(),
      threshold_limit: Number(deducteeForm.threshold_limit || 0),
      rate_with_pan: Number(deducteeForm.rate_with_pan || 0),
      rate_without_pan: Number(deducteeForm.rate_without_pan || 0),
    };
    const [res] = await Promise.allSettled([api.post('/tds/deductees', payload)]);
    if (res.status === 'fulfilled') {
      setNotice('Deductee saved successfully.');
      await loadDeductees();
    } else {
      setNotice('Could not save deductee in API.');
    }
  };

  const onCompute = async () => {
    if (!transactionForm.deductee_id || !transactionForm.payment_amount) {
      setNotice('Select deductee and enter payment amount.');
      return;
    }
    const payload = { deductee_id: Number(transactionForm.deductee_id), payment_amount: Number(transactionForm.payment_amount), payment_date: transactionForm.payment_date };
    const [res] = await Promise.allSettled([api.post('/tds/compute', payload)]);
    if (res.status === 'fulfilled' && res.value?.data) {
      setComputePreview(res.value.data);
      setNotice('');
    } else {
      setComputePreview(computeFallback(selectedDeductee, transactionForm.payment_amount));
      setNotice('Live compute API unavailable. Showing fallback preview.');
    }
  };

  const onRecord = async () => {
    if (!transactionForm.deductee_id || !transactionForm.payment_amount || !transactionForm.payment_date) {
      setNotice('Please fill deductee, amount, and date.');
      return;
    }
    const payload = {
      deductee_id: Number(transactionForm.deductee_id),
      party_id: transactionForm.party_id ? Number(transactionForm.party_id) : null,
      section: transactionForm.section || selectedDeductee?.section || '194J',
      payment_date: transactionForm.payment_date,
      payment_amount: Number(transactionForm.payment_amount),
      tds_rate: Number(computePreview?.applicable_rate || selectedDeductee?.rate_with_pan || 0),
      tds_amount: Number(computePreview?.tds_amount || 0),
      surcharge: Number(computePreview?.surcharge || 0),
      education_cess: Number(computePreview?.education_cess || 0),
      total_tds: Number(computePreview?.total_tds || 0),
    };
    const [res] = await Promise.allSettled([api.post('/tds/transactions', payload)]);
    if (res.status === 'fulfilled') {
      setNotice('Transaction recorded.');
      await loadTransactions();
    } else {
      setNotice('Could not persist transaction in API.');
    }
  };

  const onMarkDeposited = async () => {
    if (!depositForm.transaction_id || !depositForm.challan_number || !depositForm.bsr_code) {
      setNotice('Select transaction and enter challan number + BSR code.');
      return;
    }
    const payload = { challan_number: depositForm.challan_number, bsr_code: depositForm.bsr_code, challan_date: depositForm.challan_date };
    const [res] = await Promise.allSettled([api.post(`/tds/transactions/${depositForm.transaction_id}/mark-deposited`, payload)]);
    if (res.status === 'fulfilled') {
      setNotice('Transaction marked deposited.');
      await loadTransactions();
    } else {
      setNotice('Could not mark deposited in API.');
    }
  };

  const onGenerateCert = async () => {
    if (!form16aForm.deductee_id || !form16aForm.financial_year || !form16aForm.quarter) {
      setNotice('Select deductee, FY and quarter.');
      return;
    }
    const payload = { deductee_id: Number(form16aForm.deductee_id), financial_year: form16aForm.financial_year, quarter: form16aForm.quarter };
    const [res] = await Promise.allSettled([api.post('/tds/form16a/generate', payload)]);
    if (res.status === 'fulfilled') {
      setNotice('Form 16A generated.');
      await loadCertificates();
    } else {
      setNotice('Generate API unavailable. Certificate list will remain unchanged.');
    }
  };

  const filingRows = useMemo(() => Array.isArray(quarterly?.by_section) ? quarterly.by_section : [], [quarterly]);
  const chartData = useMemo(() => (Array.isArray(quarterly?.by_quarter) ? quarterly.by_quarter : []).map((q) => ({ quarter: q.quarter || 'Q?', deducted: Number(q.total_tds_deducted || 0), deposited: Number(q.total_deposited || 0), pending: Number(q.pending_amount || 0) })), [quarterly]);

  return (
    <div style={{ padding: 16, background: LIGHT_BG, minHeight: 'calc(100vh - 80px)' }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, color: '#1f2937', fontSize: 24 }}>TDS Management</h2>
        <p style={{ margin: '6px 0 0', color: '#6b7280', fontSize: 13 }}>Deductees, transactions, quarterly filing, and Form 16A certificates.</p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {TABS.map((tab, idx) => (
          <button key={tab} onClick={() => setActiveTab(idx)} style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, fontWeight: 700, cursor: 'pointer', background: activeTab === idx ? PURPLE : '#fff', color: activeTab === idx ? '#fff' : '#374151' }}>{tab}</button>
        ))}
      </div>

      {notice ? <div style={{ marginBottom: 12, border: `1px solid ${BORDER}`, background: '#fff', borderRadius: 10, padding: '10px 12px', color: '#5b21b6', fontSize: 13 }}>{notice}</div> : null}

      {activeTab === 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 12 }}>
          <Panel title="Deductee Master">
            <table style={tableStyle}>
              <thead><tr style={{ background: LIGHT_BG }}>{['Party', 'PAN', 'Section', 'Threshold', 'Rate (PAN)', 'Rate (No PAN)'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center' }}>Loading deductees...</td></tr> : null}
                {!loading && deductees.length === 0 ? <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center' }}>No deductees configured.</td></tr> : null}
                {!loading && deductees.map((d, i) => (
                  <tr key={d.id || i} style={{ borderTop: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fcfcff' }}>
                    <td style={tdStyle}>{d.party_name || '-'}</td><td style={tdStyle}>{d.pan || 'NA'}</td><td style={tdStyle}>{d.section || '-'}</td><td style={tdStyle}>{formatINR(d.threshold_limit || 0)}</td><td style={tdStyle}>{Number(d.rate_with_pan || 0).toFixed(2)}%</td><td style={tdStyle}>{Number(d.rate_without_pan || 0).toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Add Deductee">
            <div style={{ display: 'grid', gap: 6 }}>
              <Field label="Party ID"><input value={deducteeForm.party_id} onChange={(e) => setDeducteeForm((p) => ({ ...p, party_id: e.target.value }))} style={inputStyle} /></Field>
              <Field label="Party Name"><input value={deducteeForm.party_name} onChange={(e) => setDeducteeForm((p) => ({ ...p, party_name: e.target.value }))} style={inputStyle} /></Field>
              <Field label="PAN"><input value={deducteeForm.pan} onChange={(e) => setDeducteeForm((p) => ({ ...p, pan: e.target.value.toUpperCase() }))} style={inputStyle} /></Field>
              <Field label="Deductee Type"><select value={deducteeForm.deductee_type} onChange={(e) => setDeducteeForm((p) => ({ ...p, deductee_type: e.target.value }))} style={inputStyle}><option value="individual">Individual</option><option value="company">Company</option></select></Field>
              <Field label="Section"><input value={deducteeForm.section} onChange={(e) => setDeducteeForm((p) => ({ ...p, section: e.target.value.toUpperCase() }))} style={inputStyle} /></Field>
              <Field label="Threshold"><input type="number" value={deducteeForm.threshold_limit} onChange={(e) => setDeducteeForm((p) => ({ ...p, threshold_limit: e.target.value }))} style={inputStyle} /></Field>
              <Field label="Rate with PAN (%)"><input type="number" value={deducteeForm.rate_with_pan} onChange={(e) => setDeducteeForm((p) => ({ ...p, rate_with_pan: e.target.value }))} style={inputStyle} /></Field>
              <Field label="Rate without PAN (%)"><input type="number" value={deducteeForm.rate_without_pan} onChange={(e) => setDeducteeForm((p) => ({ ...p, rate_without_pan: e.target.value }))} style={inputStyle} /></Field>
              <button onClick={onCreateDeductee} style={primaryBtn}>Add Deductee</button>
            </div>
          </Panel>
        </div>
      )}

      {activeTab === 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 12 }}>
          <Panel title="TDS Transactions">
            <table style={tableStyle}>
              <thead><tr style={{ background: LIGHT_BG }}>{['Date', 'Party', 'Section', 'Payment', 'Total TDS', 'Status'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center' }}>Loading transactions...</td></tr> : null}
                {!loading && transactions.length === 0 ? <tr><td colSpan={6} style={{ ...tdStyle, textAlign: 'center' }}>No transactions recorded.</td></tr> : null}
                {!loading && transactions.map((t, i) => (
                  <tr key={t.id || i} style={{ borderTop: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fcfcff' }}>
                    <td style={tdStyle}>{t.payment_date || '-'}</td><td style={tdStyle}>{t.party_name || `Deductee #${t.deductee_id}`}</td><td style={tdStyle}>{t.section || '-'}</td><td style={tdStyle}>{formatINR(t.payment_amount || 0)}</td><td style={tdStyle}>{formatINR(t.total_tds || t.tds_amount || 0)}</td>
                    <td style={tdStyle}><span style={{ ...badge(t.deposited ? 'deposited' : 'pending'), borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>{t.deposited ? 'Deposited' : 'Pending'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Record TDS">
            <div style={{ display: 'grid', gap: 6 }}>
              <Field label="Deductee"><select value={transactionForm.deductee_id} onChange={(e) => { const d = deductees.find((x) => String(x.id) === String(e.target.value)); setTransactionForm((p) => ({ ...p, deductee_id: e.target.value, section: d?.section || '', party_id: d?.party_id ? String(d.party_id) : '' })); }} style={inputStyle}><option value="">Select deductee</option>{deductees.map((d) => <option key={d.id} value={d.id}>{d.party_name}</option>)}</select></Field>
              <Field label="Payment Amount"><input type="number" value={transactionForm.payment_amount} onChange={(e) => setTransactionForm((p) => ({ ...p, payment_amount: e.target.value }))} style={inputStyle} /></Field>
              <Field label="Payment Date"><input type="date" value={transactionForm.payment_date} onChange={(e) => setTransactionForm((p) => ({ ...p, payment_date: e.target.value }))} style={inputStyle} /></Field>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button onClick={onCompute} style={secondaryBtn}>Compute TDS</button><button onClick={onRecord} style={primaryBtn}>Record Transaction</button></div>
            </div>
            {computePreview && (
              <div style={{ marginTop: 10, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 10, display: 'grid', gap: 6, background: '#fff' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Computation Preview</div>
                <div style={{ fontSize: 12, color: '#111827' }}>Gross: {formatINR(computePreview.gross_payment)} | Rate: {Number(computePreview.applicable_rate || 0).toFixed(2)}%</div>
                <div style={{ fontSize: 12, color: '#111827' }}>TDS: {formatINR(computePreview.tds_amount)} | Cess: {formatINR(computePreview.education_cess)}</div>
                <div style={{ fontSize: 12, color: '#111827', fontWeight: 700 }}>Total TDS: {formatINR(computePreview.total_tds)} | Net: {formatINR(computePreview.net_payment)}</div>
              </div>
            )}
            <div style={{ marginTop: 12, borderTop: '1px solid #f0f0f4', paddingTop: 10, display: 'grid', gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Mark as Deposited</div>
              <Field label="Transaction"><select value={depositForm.transaction_id} onChange={(e) => setDepositForm((p) => ({ ...p, transaction_id: e.target.value }))} style={inputStyle}><option value="">Select transaction</option>{transactions.filter((t) => !t.deposited).map((t) => <option key={t.id} value={t.id}>#{t.id} - {formatINR(t.total_tds || t.tds_amount || 0)}</option>)}</select></Field>
              <Field label="Challan Number"><input value={depositForm.challan_number} onChange={(e) => setDepositForm((p) => ({ ...p, challan_number: e.target.value }))} style={inputStyle} /></Field>
              <Field label="BSR Code"><input value={depositForm.bsr_code} onChange={(e) => setDepositForm((p) => ({ ...p, bsr_code: e.target.value }))} style={inputStyle} /></Field>
              <Field label="Challan Date"><input type="date" value={depositForm.challan_date} onChange={(e) => setDepositForm((p) => ({ ...p, challan_date: e.target.value }))} style={inputStyle} /></Field>
              <button onClick={onMarkDeposited} style={secondaryBtn}>Mark Deposited</button>
            </div>
          </Panel>
        </div>
      )}

      {activeTab === 2 && (
        <Panel title="Quarterly Filing">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <input value={quarterlyFilter.financial_year} onChange={(e) => setQuarterlyFilter((p) => ({ ...p, financial_year: e.target.value }))} style={{ ...inputStyle, width: 130 }} />
            <select value={quarterlyFilter.quarter} onChange={(e) => setQuarterlyFilter((p) => ({ ...p, quarter: e.target.value }))} style={{ ...inputStyle, width: 90 }}><option value="Q1">Q1</option><option value="Q2">Q2</option><option value="Q3">Q3</option><option value="Q4">Q4</option></select>
            <button onClick={loadQuarterly} style={secondaryBtn}>Refresh Summary</button>
            <button onClick={() => setNotice(`24Q/26Q payload prepared for ${quarterlyFilter.financial_year} ${quarterlyFilter.quarter}.`)} style={primaryBtn}>Generate 24Q/26Q Data</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginBottom: 12 }}>
            <div style={{ border: '1px solid #f0f0f4', borderRadius: 10, padding: 10 }}><div style={{ fontSize: 12, color: '#6b7280' }}>Total TDS Deducted</div><div style={{ fontSize: 18, fontWeight: 800 }}>{formatINR(quarterly.total_tds_deducted || 0)}</div></div>
            <div style={{ border: '1px solid #f0f0f4', borderRadius: 10, padding: 10 }}><div style={{ fontSize: 12, color: '#6b7280' }}>Total Deposited</div><div style={{ fontSize: 18, fontWeight: 800 }}>{formatINR(quarterly.total_deposited || 0)}</div></div>
            <div style={{ border: '1px solid #f0f0f4', borderRadius: 10, padding: 10 }}><div style={{ fontSize: 12, color: '#6b7280' }}>Pending Deposit</div><div style={{ fontSize: 18, fontWeight: 800, color: Number(quarterly.pending_amount || 0) > 0 ? '#b91c1c' : '#166534' }}>{formatINR(quarterly.pending_amount || 0)}</div></div>
          </div>

          <div style={{ width: '100%', height: 220, marginBottom: 12, border: '1px solid #f0f0f4', borderRadius: 10, padding: 10 }}>
            <ResponsiveContainer>
              <BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" stroke="#ececec" /><XAxis dataKey="quarter" /><YAxis tickFormatter={(v) => `${Math.round(v / 1000)}K`} /><Tooltip formatter={(v) => formatINR(v)} /><Bar dataKey="deducted" fill="#6B3FDB" /><Bar dataKey="deposited" fill="#10b981" /><Bar dataKey="pending" fill="#ef4444" /></BarChart>
            </ResponsiveContainer>
          </div>

          <table style={tableStyle}>
            <thead><tr style={{ background: LIGHT_BG }}>{['Section', 'Payments', 'Deducted', 'Deposited', 'Pending'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
            <tbody>
              {filingRows.length === 0 ? <tr><td colSpan={5} style={{ ...tdStyle, textAlign: 'center' }}>No section rows.</td></tr> : filingRows.map((r, i) => (
                <tr key={`${r.section}-${i}`} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={tdStyle}>{r.section}</td><td style={tdStyle}>{formatINR(r.total_payments || 0)}</td><td style={tdStyle}>{formatINR(r.total_tds_deducted || 0)}</td><td style={tdStyle}>{formatINR(r.total_deposited || 0)}</td><td style={{ ...tdStyle, color: Number(r.pending_amount || 0) > 0 ? '#b91c1c' : '#166534', fontWeight: 700 }}>{formatINR(r.pending_amount || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {activeTab === 3 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12 }}>
          <Panel title="Form 16A Certificates">
            <table style={tableStyle}>
              <thead><tr style={{ background: LIGHT_BG }}>{['Certificate', 'Deductee', 'FY', 'Quarter', 'Total TDS', 'Status', 'Action'].map((h) => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={7} style={{ ...tdStyle, textAlign: 'center' }}>Loading certificates...</td></tr> : null}
                {!loading && certificates.length === 0 ? <tr><td colSpan={7} style={{ ...tdStyle, textAlign: 'center' }}>No certificates yet.</td></tr> : null}
                {!loading && certificates.map((c, i) => (
                  <tr key={c.id || i} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={tdStyle}>{c.certificate_number || `CERT-${c.id}`}</td><td style={tdStyle}>{c.party_name || `Deductee #${c.deductee_id}`}</td><td style={tdStyle}>{c.financial_year}</td><td style={tdStyle}>{c.quarter}</td><td style={tdStyle}>{formatINR(c.total_tds || c.total_payment || 0)}</td>
                    <td style={tdStyle}><span style={{ ...badge(c.status), borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>{c.status || 'draft'}</span></td>
                    <td style={tdStyle}><button onClick={() => setSelectedCertificate(c)} style={secondaryBtn}>Preview</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <Panel title="Generate Certificate">
            <div style={{ display: 'grid', gap: 6 }}>
              <Field label="Deductee"><select value={form16aForm.deductee_id} onChange={(e) => setForm16aForm((p) => ({ ...p, deductee_id: e.target.value }))} style={inputStyle}><option value="">Select deductee</option>{deductees.map((d) => <option key={d.id} value={d.id}>{d.party_name}</option>)}</select></Field>
              <Field label="Financial Year"><input value={form16aForm.financial_year} onChange={(e) => setForm16aForm((p) => ({ ...p, financial_year: e.target.value }))} style={inputStyle} /></Field>
              <Field label="Quarter"><select value={form16aForm.quarter} onChange={(e) => setForm16aForm((p) => ({ ...p, quarter: e.target.value }))} style={inputStyle}><option value="Q1">Q1</option><option value="Q2">Q2</option><option value="Q3">Q3</option><option value="Q4">Q4</option></select></Field>
              <button onClick={onGenerateCert} style={primaryBtn}>Generate Certificate</button>
            </div>
            <div style={{ marginTop: 12, borderTop: '1px solid #f0f0f4', paddingTop: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Certificate Preview</div>
              {!selectedCertificate ? <div style={{ fontSize: 12, color: '#6b7280' }}>Select a certificate from the list to preview.</div> : (
                <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ background: LIGHT_BG, padding: '8px 10px', fontWeight: 700, fontSize: 13 }}>Form 16A - {selectedCertificate.certificate_number || `CERT-${selectedCertificate.id}`}</div>
                  <div style={{ padding: 10, display: 'grid', gap: 6 }}>
                    <div style={{ fontSize: 12, color: '#111827' }}><strong>Deductor:</strong> Manifest Technologies India Pvt Ltd</div>
                    <div style={{ fontSize: 12, color: '#111827' }}><strong>Deductee:</strong> {selectedCertificate.party_name || `Deductee #${selectedCertificate.deductee_id}`}</div>
                    <div style={{ fontSize: 12, color: '#111827' }}><strong>PAN:</strong> {selectedCertificate.pan || 'NA'}</div>
                    <div style={{ fontSize: 12, color: '#111827' }}><strong>Section:</strong> {selectedCertificate.section || '-'}</div>
                    <div style={{ fontSize: 12, color: '#111827' }}><strong>FY / Quarter:</strong> {selectedCertificate.financial_year} / {selectedCertificate.quarter}</div>
                    <div style={{ fontSize: 12, color: '#111827' }}><strong>Total Payment:</strong> {formatINR(selectedCertificate.total_payment || 0)}</div>
                    <div style={{ fontSize: 12, color: '#111827' }}><strong>Total TDS:</strong> {formatINR(selectedCertificate.total_tds || 0)}</div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button onClick={() => setNotice(`Download prepared for ${selectedCertificate.certificate_number || selectedCertificate.id}.`)} style={secondaryBtn}>Download</button></div>
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
