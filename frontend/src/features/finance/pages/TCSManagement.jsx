// frontend/src/features/finance/pages/TCSManagement.jsx
// Tax Collected at Source (Section 206C) — mirrors the TDS module.
import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '@/services/api/client';

const PURPLE = '#6B3FDB';
const LIGHT_BG = '#f5f3ff';
const BORDER = '#e9e4ff';
const TABS = ['Collectees', 'Transactions', 'Quarterly Filing', 'Form 27D'];

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
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  return `${sign}₹${abs.toLocaleString('en-IN')}`;
}

function badge(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('issued') || s.includes('deposited')) return { background: '#dcfce7', color: '#166534' };
  if (s.includes('pending') || s.includes('draft')) return { background: '#fef3c7', color: '#92400e' };
  return { background: LIGHT_BG, color: '#5b21b6' };
}

const inputStyle = { border: `1px solid ${BORDER}`, background: '#fff', borderRadius: 8, padding: '8px 10px', fontSize: 13, color: '#111827', outline: 'none', width: '100%', boxSizing: 'border-box' };
const tableStyle = { width: '100%', borderCollapse: 'collapse' };
const thStyle = { padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#374151', fontWeight: 700, borderBottom: `1px solid ${BORDER}` };
const tdStyle = { padding: '10px 12px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f3f4f6' };
const primaryBtn = { border: 'none', borderRadius: 8, padding: '8px 14px', background: PURPLE, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const secondaryBtn = { border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 12px', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 700, cursor: 'pointer' };

function Panel({ title, children, right }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', padding: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 14, color: '#374151', fontWeight: 700 }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

export default function TCSManagement() {
  const [activeTab, setActiveTab] = useState(0);
  const [notice, setNotice] = useState('');
  const [sections, setSections] = useState({});
  const [collectees, setCollectees] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [quarterly, setQuarterly] = useState(null);
  const [form27eq, setForm27eq] = useState(null);
  const [certificates, setCertificates] = useState([]);
  const [selectedCert, setSelectedCert] = useState(null);
  const [computePreview, setComputePreview] = useState(null);

  const [collForm, setCollForm] = useState({ party_name: '', pan: '', collectee_type: 'company', section: '206C(1H)', threshold_limit: '5000000', rate_with_pan: '0.1', rate_without_pan: '1' });
  const [txnForm, setTxnForm] = useState({ collectee_id: '', receipt_amount: '', receipt_date: new Date().toISOString().slice(0, 10) });
  const [qFilter, setQFilter] = useState({ financial_year: getCurrentFY(), quarter: 'Q4' });
  const [certForm, setCertForm] = useState({ collectee_id: '', financial_year: getCurrentFY(), quarter: 'Q4' });

  const selectedCollectee = useMemo(() => collectees.find(c => String(c.id) === String(txnForm.collectee_id)), [collectees, txnForm.collectee_id]);

  const loadCollectees = useCallback(async () => {
    const [res] = await Promise.allSettled([api.get('/tcs/collectees')]);
    setCollectees(res.status === 'fulfilled' && Array.isArray(res.value?.data) ? res.value.data : []);
  }, []);
  const loadTransactions = useCallback(async () => {
    const [res] = await Promise.allSettled([api.get('/tcs/transactions')]);
    setTransactions(res.status === 'fulfilled' && Array.isArray(res.value?.data) ? res.value.data : []);
  }, []);
  const loadCertificates = useCallback(async () => {
    const [res] = await Promise.allSettled([api.get('/tcs/form27d')]);
    setCertificates(res.status === 'fulfilled' && Array.isArray(res.value?.data) ? res.value.data : []);
  }, []);

  useEffect(() => {
    api.get('/tcs/sections').then(r => setSections(r.data || {})).catch(() => {});
    loadCollectees(); loadTransactions();
  }, [loadCollectees, loadTransactions]);

  useEffect(() => { if (activeTab === 3) loadCertificates(); }, [activeTab, loadCertificates]);

  // When a section is picked in the collectee form, prefill rates/threshold from the master
  function pickSection(sec) {
    const s = sections[sec] || {};
    setCollForm(f => ({
      ...f, section: sec,
      threshold_limit: String(s.threshold ?? f.threshold_limit),
      rate_with_pan: String(s.rate_with_pan ?? f.rate_with_pan),
      rate_without_pan: String(s.rate_without_pan ?? f.rate_without_pan),
    }));
  }

  async function addCollectee() {
    if (!collForm.party_name.trim()) { setNotice('Buyer name is required.'); return; }
    const [res] = await Promise.allSettled([api.post('/tcs/collectees', collForm)]);
    if (res.status === 'fulfilled') {
      setNotice('Collectee added.'); setCollForm(f => ({ ...f, party_name: '', pan: '' })); loadCollectees();
    } else setNotice(res.reason?.response?.data?.error || 'Failed to add collectee.');
  }

  async function runCompute() {
    if (!txnForm.collectee_id || !txnForm.receipt_amount) { setNotice('Select a collectee and enter the receipt amount.'); return; }
    const [res] = await Promise.allSettled([api.post('/tcs/compute', txnForm)]);
    if (res.status === 'fulfilled') { setComputePreview(res.value.data); setNotice(''); }
    else setNotice(res.reason?.response?.data?.error || 'Compute failed.');
  }

  async function recordTransaction() {
    if (!computePreview) { setNotice('Compute the TCS first.'); return; }
    const payload = {
      collectee_id: txnForm.collectee_id,
      party_id: selectedCollectee?.party_id || null,
      section: computePreview.section,
      receipt_date: txnForm.receipt_date,
      receipt_amount: computePreview.receipt_amount,
      tcs_rate: computePreview.tcs_rate,
      tcs_amount: computePreview.tcs_amount,
      surcharge: computePreview.surcharge,
      education_cess: computePreview.education_cess,
    };
    const [res] = await Promise.allSettled([api.post('/tcs/transactions', payload)]);
    if (res.status === 'fulfilled') { setNotice('TCS transaction recorded.'); setComputePreview(null); setTxnForm(f => ({ ...f, receipt_amount: '' })); loadTransactions(); loadCollectees(); }
    else setNotice(res.reason?.response?.data?.error || 'Failed to record transaction.');
  }

  async function markDeposited(id) {
    const challan = prompt('Challan number (BSR/CIN):');
    if (challan === null) return;
    const [res] = await Promise.allSettled([api.post(`/tcs/transactions/${id}/mark-deposited`, { challan_number: challan, challan_date: new Date().toISOString().slice(0, 10), bsr_code: '' })]);
    if (res.status === 'fulfilled') { setNotice('Marked deposited.'); loadTransactions(); }
    else setNotice(res.reason?.response?.data?.error || 'Failed.');
  }

  async function loadQuarterly() {
    const [q, eq] = await Promise.allSettled([
      api.get('/tcs/quarterly-summary', { params: { financial_year: qFilter.financial_year } }),
      api.get('/tcs/form27eq', { params: qFilter }),
    ]);
    setQuarterly(q.status === 'fulfilled' ? q.value.data : null);
    setForm27eq(eq.status === 'fulfilled' ? eq.value.data : null);
  }

  async function generateCert() {
    if (!certForm.collectee_id) { setNotice('Select a collectee.'); return; }
    const [res] = await Promise.allSettled([api.post('/tcs/form27d/generate', certForm)]);
    if (res.status === 'fulfilled') { setNotice('Form 27D generated.'); setSelectedCert(res.value.data.certificate_data); loadCertificates(); }
    else setNotice(res.reason?.response?.data?.error || 'Failed to generate certificate.');
  }

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>TCS Management</h1>
        <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>Tax Collected at Source (Section 206C) — collection register, Form 27EQ &amp; Form 27D.</p>
      </div>

      {notice && <div style={{ background: LIGHT_BG, color: '#5b21b6', padding: '8px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{notice}</div>}

      <div style={{ display: 'flex', gap: 4, background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 4, width: 'fit-content', marginBottom: 20 }}>
        {TABS.map((t, i) => (
          <button key={t} onClick={() => setActiveTab(i)} style={{
            padding: '8px 16px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13,
            background: activeTab === i ? PURPLE : 'transparent', color: activeTab === i ? '#fff' : '#6b7280',
            fontWeight: activeTab === i ? 600 : 400,
          }}>{t}</button>
        ))}
      </div>

      {/* ── Collectees ── */}
      {activeTab === 0 && (
        <>
          <Panel title="Add Collectee (Buyer)">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
              <input style={inputStyle} placeholder="Buyer name" value={collForm.party_name} onChange={e => setCollForm(f => ({ ...f, party_name: e.target.value }))} />
              <input style={inputStyle} placeholder="PAN" value={collForm.pan} onChange={e => setCollForm(f => ({ ...f, pan: e.target.value.toUpperCase() }))} />
              <select style={inputStyle} value={collForm.section} onChange={e => pickSection(e.target.value)}>
                {Object.entries(sections).map(([code, s]) => <option key={code} value={code}>{code} — {s.description}</option>)}
              </select>
              <select style={inputStyle} value={collForm.collectee_type} onChange={e => setCollForm(f => ({ ...f, collectee_type: e.target.value }))}>
                <option value="company">Company</option><option value="individual">Individual</option><option value="huf">HUF</option>
              </select>
              <input style={inputStyle} type="number" placeholder="Threshold ₹" value={collForm.threshold_limit} onChange={e => setCollForm(f => ({ ...f, threshold_limit: e.target.value }))} />
              <input style={inputStyle} type="number" step="0.01" placeholder="Rate (PAN) %" value={collForm.rate_with_pan} onChange={e => setCollForm(f => ({ ...f, rate_with_pan: e.target.value }))} />
              <input style={inputStyle} type="number" step="0.01" placeholder="Rate (No PAN) %" value={collForm.rate_without_pan} onChange={e => setCollForm(f => ({ ...f, rate_without_pan: e.target.value }))} />
              <button style={primaryBtn} onClick={addCollectee}>Add Collectee</button>
            </div>
          </Panel>

          <Panel title={`Collectees (${collectees.length})`}>
            <table style={tableStyle}>
              <thead><tr>{['Buyer', 'PAN', 'Section', 'Threshold', 'Receipts (FY)', 'TCS (FY)', 'Txns'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {collectees.length === 0 ? (
                  <tr><td colSpan={7} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af' }}>No collectees yet.</td></tr>
                ) : collectees.map(c => (
                  <tr key={c.id}>
                    <td style={tdStyle}>{c.party_name}</td>
                    <td style={tdStyle}>{c.pan || '—'}</td>
                    <td style={tdStyle}>{c.section}</td>
                    <td style={tdStyle}>{formatINR(c.threshold_limit)}</td>
                    <td style={tdStyle}>{formatINR(c.receipts_this_fy)}</td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: PURPLE }}>{formatINR(c.tcs_this_fy)}</td>
                    <td style={tdStyle}>{c.transaction_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      {/* ── Transactions ── */}
      {activeTab === 1 && (
        <>
          <Panel title="Compute & Record TCS">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, alignItems: 'end' }}>
              <select style={inputStyle} value={txnForm.collectee_id} onChange={e => { setTxnForm(f => ({ ...f, collectee_id: e.target.value })); setComputePreview(null); }}>
                <option value="">Select collectee…</option>
                {collectees.map(c => <option key={c.id} value={c.id}>{c.party_name} ({c.section})</option>)}
              </select>
              <input style={inputStyle} type="number" placeholder="Receipt amount ₹" value={txnForm.receipt_amount} onChange={e => { setTxnForm(f => ({ ...f, receipt_amount: e.target.value })); setComputePreview(null); }} />
              <input style={inputStyle} type="date" value={txnForm.receipt_date} onChange={e => setTxnForm(f => ({ ...f, receipt_date: e.target.value }))} />
              <button style={secondaryBtn} onClick={runCompute}>Compute TCS</button>
              <button style={{ ...primaryBtn, opacity: computePreview ? 1 : 0.5 }} disabled={!computePreview} onClick={recordTransaction}>Record</button>
            </div>
            {computePreview && (
              <div style={{ marginTop: 12, background: LIGHT_BG, borderRadius: 8, padding: 12, fontSize: 13, color: '#374151' }}>
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                  <span>Taxable base: <b>{formatINR(computePreview.taxable_base)}</b></span>
                  <span>Rate: <b>{computePreview.tcs_rate}%</b></span>
                  <span>TCS: <b style={{ color: PURPLE }}>{formatINR(computePreview.total_tcs)}</b></span>
                  <span>Collectible (incl. TCS): <b>{formatINR(computePreview.amount_collectible)}</b></span>
                </div>
                <div style={{ marginTop: 6, color: '#6b7280', fontSize: 12 }}>{computePreview.breakdown_note}</div>
              </div>
            )}
          </Panel>

          <Panel title={`Transactions (${transactions.length})`}>
            <table style={tableStyle}>
              <thead><tr>{['Date', 'Collectee', 'Section', 'Receipt', 'TCS', 'Deposited', ''].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {transactions.length === 0 ? (
                  <tr><td colSpan={7} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af' }}>No transactions.</td></tr>
                ) : transactions.map(t => (
                  <tr key={t.id}>
                    <td style={tdStyle}>{String(t.receipt_date).slice(0, 10)}</td>
                    <td style={tdStyle}>{t.party_name || '—'}</td>
                    <td style={tdStyle}>{t.section}</td>
                    <td style={tdStyle}>{formatINR(t.receipt_amount)}</td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: PURPLE }}>{formatINR(t.total_tcs)}</td>
                    <td style={tdStyle}><span style={{ ...badge(t.deposited ? 'deposited' : 'pending'), padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{t.deposited ? 'Deposited' : 'Pending'}</span></td>
                    <td style={tdStyle}>{!t.deposited && <button style={secondaryBtn} onClick={() => markDeposited(t.id)}>Mark Deposited</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      {/* ── Quarterly Filing ── */}
      {activeTab === 2 && (
        <>
          <Panel title="Quarterly Filing (Form 27EQ)" right={
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...inputStyle, width: 120 }} value={qFilter.financial_year} onChange={e => setQFilter(f => ({ ...f, financial_year: e.target.value }))} placeholder="FY" />
              <select style={{ ...inputStyle, width: 90 }} value={qFilter.quarter} onChange={e => setQFilter(f => ({ ...f, quarter: e.target.value }))}>
                {['Q1', 'Q2', 'Q3', 'Q4'].map(q => <option key={q} value={q}>{q}</option>)}
              </select>
              <button style={primaryBtn} onClick={loadQuarterly}>Load</button>
            </div>
          }>
            {quarterly ? (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                <div style={{ background: LIGHT_BG, borderRadius: 8, padding: '10px 16px' }}><div style={{ fontSize: 11, color: '#6b7280' }}>Total TCS</div><div style={{ fontWeight: 700, color: PURPLE }}>{formatINR(quarterly.total_tcs_collected)}</div></div>
                <div style={{ background: LIGHT_BG, borderRadius: 8, padding: '10px 16px' }}><div style={{ fontSize: 11, color: '#6b7280' }}>Deposited</div><div style={{ fontWeight: 700, color: '#166534' }}>{formatINR(quarterly.total_deposited)}</div></div>
                <div style={{ background: LIGHT_BG, borderRadius: 8, padding: '10px 16px' }}><div style={{ fontSize: 11, color: '#6b7280' }}>Pending</div><div style={{ fontWeight: 700, color: '#92400e' }}>{formatINR(quarterly.pending_amount)}</div></div>
              </div>
            ) : <div style={{ color: '#9ca3af', fontSize: 13 }}>Select FY and quarter, then Load.</div>}
          </Panel>

          {form27eq && (form27eq.quarters || []).map(q => (
            <Panel key={q.quarter} title={`${q.quarter} — Receipts ${formatINR(q.totals?.receipt)} · TCS ${formatINR(q.totals?.tcs)}`}>
              {(q.sections || []).map(sec => (
                <div key={sec.section} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Section {sec.section}</div>
                  <table style={tableStyle}>
                    <thead><tr>{['#', 'Collectee', 'PAN', 'Date', 'Received', 'TCS', 'Challan'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
                    <tbody>
                      {sec.entries.map(e => (
                        <tr key={e.sno}>
                          <td style={tdStyle}>{e.sno}</td>
                          <td style={tdStyle}>{e.collectee_name}</td>
                          <td style={tdStyle}>{e.collectee_pan}</td>
                          <td style={tdStyle}>{String(e.receipt_date).slice(0, 10)}</td>
                          <td style={tdStyle}>{formatINR(e.amount_received)}</td>
                          <td style={{ ...tdStyle, color: PURPLE, fontWeight: 600 }}>{formatINR(e.total_tcs)}</td>
                          <td style={tdStyle}>{e.challan_number || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </Panel>
          ))}
        </>
      )}

      {/* ── Form 27D ── */}
      {activeTab === 3 && (
        <>
          <Panel title="Generate Form 27D Certificate">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
              <select style={{ ...inputStyle, width: 220 }} value={certForm.collectee_id} onChange={e => setCertForm(f => ({ ...f, collectee_id: e.target.value }))}>
                <option value="">Select collectee…</option>
                {collectees.map(c => <option key={c.id} value={c.id}>{c.party_name}</option>)}
              </select>
              <input style={{ ...inputStyle, width: 120 }} value={certForm.financial_year} onChange={e => setCertForm(f => ({ ...f, financial_year: e.target.value }))} placeholder="FY" />
              <select style={{ ...inputStyle, width: 90 }} value={certForm.quarter} onChange={e => setCertForm(f => ({ ...f, quarter: e.target.value }))}>
                {['Q1', 'Q2', 'Q3', 'Q4'].map(q => <option key={q} value={q}>{q}</option>)}
              </select>
              <button style={primaryBtn} onClick={generateCert}>Generate</button>
            </div>
          </Panel>

          {selectedCert && (
            <Panel title={`Certificate ${selectedCert.certificate_number}`}>
              <div style={{ fontSize: 13, color: '#374151' }}>
                <div><b>Collector:</b> {selectedCert.collector_details?.name} · TAN {selectedCert.collector_details?.tan}</div>
                <div><b>Collectee:</b> {selectedCert.collectee?.name} · PAN {selectedCert.collectee?.pan}</div>
                <div style={{ marginTop: 6 }}><b>Total Received:</b> {formatINR(selectedCert.total_receipt)} · <b>Total TCS:</b> {formatINR(selectedCert.total_tcs)}</div>
              </div>
            </Panel>
          )}

          <Panel title={`Issued Certificates (${certificates.length})`}>
            <table style={tableStyle}>
              <thead><tr>{['Certificate #', 'Collectee', 'FY', 'Qtr', 'Received', 'TCS', 'Status'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {certificates.length === 0 ? (
                  <tr><td colSpan={7} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af' }}>No certificates issued.</td></tr>
                ) : certificates.map(c => (
                  <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedCert(c.certificate_data)}>
                    <td style={{ ...tdStyle, color: PURPLE, fontWeight: 600 }}>{c.certificate_number}</td>
                    <td style={tdStyle}>{c.party_name || '—'}</td>
                    <td style={tdStyle}>{c.financial_year}</td>
                    <td style={tdStyle}>{c.quarter}</td>
                    <td style={tdStyle}>{formatINR(c.total_receipt)}</td>
                    <td style={{ ...tdStyle, color: PURPLE, fontWeight: 600 }}>{formatINR(c.total_tcs)}</td>
                    <td style={tdStyle}><span style={{ ...badge(c.status), padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>{c.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </div>
  );
}
