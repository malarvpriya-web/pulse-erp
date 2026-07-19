import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BarChart, Bar, LineChart, Line, RadarChart, Radar, PolarGrid, PolarAngleAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import api from '@/services/api/client';

/* ── helpers ──────────────────────────────────────────────────────────────── */
function formatINR(n) {
  if (n == null) return '₹0';
  const abs = Math.abs(Number(n));
  let str;
  if (abs >= 1_00_00_000)   str = (abs / 1_00_00_000).toFixed(2) + ' Cr';
  else if (abs >= 1_00_000) str = (abs / 1_00_000).toFixed(2) + ' L';
  else                      str = abs.toLocaleString('en-IN');
  return (n < 0 ? '-₹' : '₹') + str;
}

function stars(score) {
  const s = Math.round(score ?? 0);
  return '★'.repeat(s) + '☆'.repeat(5 - s);
}

function StarRating({ value }) {
  const full = Math.floor(+value || 0);
  const half = (+value || 0) - full >= 0.5;
  return (
    <span style={{ color: '#f59e0b', fontSize: 14 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} style={{ color: i <= full ? '#f59e0b' : (i === full + 1 && half ? '#fbbf24' : '#d1d5db') }}>★</span>
      ))}
      <span style={{ color: '#6b7280', fontSize: 12, marginLeft: 4 }}>{Number(value || 0).toFixed(1)}</span>
    </span>
  );
}

function StarPicker({ value, onChange }) {
  return (
    <span style={{ fontSize: 28, cursor: 'pointer', letterSpacing: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} onClick={() => onChange(i)} style={{ color: i <= value ? '#f59e0b' : '#d1d5db' }}>★</span>
      ))}
    </span>
  );
}

function Badge({ label, color, bg }) {
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, color, background: bg }}>
      {label}
    </span>
  );
}

function ProgressBar({ value, max = 5, color = '#6B3FDB' }) {
  return (
    <div style={{ background: '#f0f0f4', borderRadius: 6, height: 8, width: '100%' }}>
      <div style={{ width: `${(value / max) * 100}%`, background: color, borderRadius: 6, height: 8, transition: 'width .3s' }} />
    </div>
  );
}

function TabError({ message, onRetry }) {
  if (!message) return null;
  return (
    <div style={{ margin: '12px 0', padding: '10px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span>{message}</span>
      {onRetry && <button onClick={onRetry} style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', color: '#991b1b', fontSize: 12 }}>Retry</button>}
    </div>
  );
}

function EmptyChart({ message }) {
  return (
    <div style={{ height: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', gap: 8 }}>
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="12" width="4" height="8" rx="1" /><rect x="10" y="8" width="4" height="12" rx="1" /><rect x="17" y="4" width="4" height="16" rx="1" />
      </svg>
      <p style={{ margin: 0, fontSize: 12, textAlign: 'center', maxWidth: 240 }}>{message}</p>
    </div>
  );
}

const CHART_COLORS = ['#6B3FDB', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
const INR_TT = { formatter: (v, n) => [formatINR(v), n], contentStyle: { fontSize: 12, borderRadius: 8 } };

function pivotItemPrices(rows, vendorNames) {
  const byItem = {};
  for (const r of rows) {
    if (!r.item_name || !r.last_price) continue;
    if (!byItem[r.item_name]) byItem[r.item_name] = { item_name: r.item_name };
    byItem[r.item_name][r.vendor_name] = parseFloat(r.last_price);
  }
  return Object.values(byItem).filter(d => vendorNames.some(v => d[v] != null)).slice(0, 8);
}

function pivotHistory(rows, vendorNames) {
  const byMonth = {};
  for (const r of rows) {
    if (!byMonth[r.month]) byMonth[r.month] = { month: r.month };
    byMonth[r.month][r.vendor_name] = parseFloat(r.avg_price);
  }
  return Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)).slice(-18);
}

/* ── Price Compare tab ─────────────────────────────────────────────────────── */
function VendorPriceComparison({ vendors }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [itemRows,    setItemRows]    = useState([]);
  const [histRows,    setHistRows]    = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [itemFilter,  setItemFilter]  = useState('');
  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const toggle = id => setSelectedIds(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : prev.length < 5 ? [...prev, id] : prev
  );

  const load = useCallback(async () => {
    if (!selectedIds.length) { setItemRows([]); setHistRows([]); return; }
    setLoading(true); setError('');
    const q = selectedIds.join(',');
    const [iRes, hRes] = await Promise.allSettled([
      api.get(`/vendors/compare/items?ids=${q}`),
      api.get(`/vendors/price-history?ids=${q}`),
    ]);
    if (!isMounted.current) return;
    if (iRes.status === 'fulfilled') setItemRows(iRes.value.data || []);
    else setError('Item comparison failed.');
    if (hRes.status === 'fulfilled') setHistRows(hRes.value.data || []);
    setLoading(false);
  }, [selectedIds]);

  useEffect(() => { load(); }, [load]);

  const selectedVendors  = vendors.filter(v => selectedIds.includes(v.id));
  const vendorNames      = selectedVendors.map(v => v.vendor_name);
  const filteredItemRows = useMemo(() =>
    itemFilter ? itemRows.filter(r => r.item_name?.toLowerCase().includes(itemFilter.toLowerCase())) : itemRows
  , [itemRows, itemFilter]);
  const barData  = useMemo(() => pivotItemPrices(filteredItemRows, vendorNames), [filteredItemRows, vendorNames]);
  const lineData = useMemo(() => pivotHistory(histRows, vendorNames), [histRows, vendorNames]);

  return (
    <div>
      <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', marginBottom: 10 }}>
          Select vendors to compare <span style={{ fontWeight: 400, color: '#6b7280' }}>(up to 5)</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {vendors.map(v => {
            const active = selectedIds.includes(v.id);
            const color  = active ? CHART_COLORS[selectedIds.indexOf(v.id) % CHART_COLORS.length] : '#6b7280';
            return (
              <button key={v.id} onClick={() => toggle(v.id)} style={{
                padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                border: `2px solid ${active ? color : '#e5e7eb'}`,
                background: active ? color + '18' : '#fafafa', color: active ? color : '#374151',
                opacity: !active && selectedIds.length >= 5 ? 0.45 : 1,
              }}>
                {active && <span style={{ marginRight: 5 }}>●</span>}{v.vendor_name}
              </button>
            );
          })}
        </div>
        {!selectedIds.length && <p style={{ margin: '12px 0 0', fontSize: 12, color: '#9ca3af' }}>Select a vendor above to load price comparison.</p>}
      </div>
      {error && <TabError message={error} />}
      {loading && <div style={{ textAlign: 'center', padding: '48px 0', color: '#6B3FDB', fontWeight: 600 }}>Loading comparison data…</div>}
      {!loading && selectedIds.length > 0 && (
        <>
          {itemRows.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <input placeholder="Filter by item name…" value={itemFilter} onChange={e => setItemFilter(e.target.value)}
                style={{ padding: '7px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, width: 280 }} />
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937', marginBottom: 14 }}>Cross-Vendor Price Comparison</div>
              {barData.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={barData} barCategoryGap="25%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                    <XAxis dataKey="item_name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={48} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}`} />
                    <Tooltip {...INR_TT} /><Legend wrapperStyle={{ fontSize: 12 }} />
                    {vendorNames.map((name, i) => <Bar key={name} dataKey={name} fill={CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />)}
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyChart message="No item price data. Prices populate from PO lines and RFQ quotes." />}
            </div>
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937', marginBottom: 14 }}>Price History Timeline</div>
              {lineData.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={lineData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}`} />
                    <Tooltip {...INR_TT} /><Legend wrapperStyle={{ fontSize: 12 }} />
                    {vendorNames.map((name, i) => (
                      <Line key={name} type="monotone" dataKey={name} stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : <EmptyChart message="No price history. History builds from RFQ quotes and PO orders." />}
            </div>
          </div>
          {filteredItemRows.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20, marginTop: 16, overflowX: 'auto' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937', marginBottom: 14 }}>Detailed Price Breakdown</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    {['Item', 'UOM', 'Vendor', 'Avg Price', 'Min', 'Max', 'Last Price', 'Quotes', 'Last Date'].map(h => (
                      <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, color: '#6b7280', fontWeight: 600, borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredItemRows.map((r, i) => {
                    const isLowest = filteredItemRows.filter(x => x.item_name === r.item_name).every(x => (+r.last_price || +r.avg_price) <= (+x.last_price || +x.avg_price));
                    return (
                      <tr key={i} style={{ background: isLowest ? '#f0fdf4' : '#fff', borderBottom: '1px solid #f9f9fb' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 600 }}>{r.item_name}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{r.uom || '—'}</td>
                        <td style={{ padding: '9px 12px', color: '#6B3FDB', fontWeight: 600 }}>{r.vendor_name}</td>
                        <td style={{ padding: '9px 12px' }}>{formatINR(r.avg_price)}</td>
                        <td style={{ padding: '9px 12px', color: '#16a34a', fontWeight: 600 }}>{formatINR(r.min_price)}</td>
                        <td style={{ padding: '9px 12px', color: '#dc2626' }}>{formatINR(r.max_price)}</td>
                        <td style={{ padding: '9px 12px', fontWeight: 700 }}>{formatINR(r.last_price)}</td>
                        <td style={{ padding: '9px 12px' }}>{r.quote_count}</td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{r.last_date ? new Date(r.last_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── constants ─────────────────────────────────────────────────────────────── */
const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab',
  'Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand',
  'West Bengal','Andaman and Nicobar Islands','Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu','Delhi','Jammu and Kashmir',
  'Ladakh','Lakshadweep','Puducherry',
];

const VENDOR_CATEGORIES = [
  'Raw Materials',
  'Electronic Components (Active)',
  'Electronic Components (Passive)',
  'IGBT / Power Modules',
  'PCB Manufacturers',
  'Magnetics (Transformers / Inductors)',
  'Contract Manufacturers (EMS)',
  'Consumables',
  'IT',
  'Services',
  'Logistics',
  'Import Agents / CHA',
];

const EMPTY_VENDOR = { vendor_name: '', category: 'Raw Materials', gstin: '', pan: '', bank_name: '', account_number: '', ifsc: '', contact_person: '', email: '', phone: '', city: '', state: '', address: '', lead_time_days: 14, credit_limit: 0, payment_terms_days: 30, status: 'active' };
const EMPTY_RFQ    = { item_description: '', quantity: '', unit: 'Nos', required_by: '', linked_pr_id: '', vendor_ids: [] };
const EMPTY_MATCH  = { po_id: '', grn_id: '', vendor_invoice_no: '', vendor_invoice_date: '', vendor_invoice_amount: '' };
const EMPTY_RATING = { vendor_id: '', po_id: '', quality_score: 3, delivery_score: 3, price_score: 3, comments: '' };

const MATCH_STATUS_MAP = {
  matched:     ['#166534', '#dcfce7', 'Matched'],
  discrepancy: ['#991b1b', '#fee2e2', 'Discrepancy'],
  pending:     ['#92400e', '#fef3c7', 'Pending'],
  approved:    ['#1d4ed8', '#dbeafe', 'Approved'],
};
const RFQ_STATUS_MAP = {
  draft:               ['#92400e',  '#fef3c7'],
  sent:                ['#1d4ed8',  '#dbeafe'],
  responses_received:  ['#5b21b6',  '#ede9fe'],
  awarded:             ['#166534',  '#dcfce7'],
  closed:              ['#166534',  '#dcfce7'],
  cancelled:           ['#374151',  '#f3f4f6'],
};

/* ══════════════════════════════════════════════════════════════════════════════
   Main component
══════════════════════════════════════════════════════════════════════════════ */
export default function VendorManagement() {
  const [tab, setTab] = useState('vendors');

  const [vendors,       setVendors]       = useState([]);
  const [rfqs,          setRfqs]          = useState([]);
  const [matches,       setMatches]       = useState([]);
  const [vendorError,   setVendorError]   = useState('');
  const [rfqError,      setRfqError]      = useState('');
  const [matchError,    setMatchError]    = useState('');
  const [vendorLoading, setVendorLoading] = useState(false);
  const [rfqLoading,    setRfqLoading]    = useState(false);
  const [matchLoading,  setMatchLoading]  = useState(false);

  const [search,        setSearch]        = useState('');
  const [filterCat,     setFilterCat]     = useState('');
  const [filterStatus,  setFilterStatus]  = useState('');

  const [vendorModal,    setVendorModal]    = useState(false);
  const [editVendor,     setEditVendor]     = useState(null);
  const [vendorForm,     setVendorForm]     = useState(EMPTY_VENDOR);
  const [rfqModal,       setRfqModal]       = useState(false);
  const [rfqForm,        setRfqForm]        = useState(EMPTY_RFQ);
  const [viewQuotesRfq,  setViewQuotesRfq]  = useState(null);
  const [sendVendorsRfq, setSendVendorsRfq] = useState(null);
  const [sendVendorIds,  setSendVendorIds]  = useState([]);
  const [matchModal,     setMatchModal]     = useState(false);
  const [matchForm,      setMatchForm]      = useState(EMPTY_MATCH);
  const [rateModal,      setRateModal]      = useState(false);
  const [ratingForm,     setRatingForm]     = useState(EMPTY_RATING);
  const [scorecardVendor,setScorecardVendor]= useState(null);
  const [scorecardData,  setScorecardData]  = useState(null);
  const [saveError,      setSaveError]      = useState('');

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  /* ── fetch functions ── */
  const fetchVendors = useCallback(async () => {
    setVendorLoading(true); setVendorError('');
    try {
      const r = await api.get('/procurement/vendors');
      if (!isMounted.current) return;
      setVendors(r.data.vendors || []);
    } catch (e) {
      if (!isMounted.current) return;
      setVendorError('Vendors: ' + (e.response?.data?.error || e.message || 'Failed to load'));
      setVendors([]);
    } finally { if (isMounted.current) setVendorLoading(false); }
  }, []);

  const fetchRfqs = useCallback(async () => {
    setRfqLoading(true); setRfqError('');
    try {
      const r = await api.get('/procurement/rfqs');
      if (!isMounted.current) return;
      setRfqs(r.data.rfqs || []);
    } catch (e) {
      if (!isMounted.current) return;
      setRfqError('RFQs: ' + (e.response?.data?.error || e.message || 'Failed to load'));
      setRfqs([]);
    } finally { if (isMounted.current) setRfqLoading(false); }
  }, []);

  const fetchMatches = useCallback(async () => {
    setMatchLoading(true); setMatchError('');
    try {
      const r = await api.get('/procurement/three-way-match');
      if (!isMounted.current) return;
      setMatches(r.data.matches || []);
    } catch (e) {
      if (!isMounted.current) return;
      setMatchError('3-Way Match: ' + (e.response?.data?.error || e.message || 'Failed to load'));
      setMatches([]);
    } finally { if (isMounted.current) setMatchLoading(false); }
  }, []);

  useEffect(() => { fetchVendors(); fetchRfqs(); fetchMatches(); }, [fetchVendors, fetchRfqs, fetchMatches]);

  const fetchScorecard = useCallback(async (vendor) => {
    setScorecardVendor(vendor); setScorecardData(null);
    try {
      const r = await api.get(`/procurement/vendors/${vendor.id}/scorecard`);
      if (isMounted.current) setScorecardData(r.data);
    } catch {
      if (isMounted.current) setScorecardData({ ratings: [], avg_quality: 0, avg_delivery: 0, avg_price: 0, avg_overall: 0 });
    }
  }, []);

  /* ── Vendor actions ── */
  function openAddVendor() { setEditVendor(null); setVendorForm(EMPTY_VENDOR); setSaveError(''); setVendorModal(true); }
  function openEditVendor(v) { setEditVendor(v); setVendorForm({ ...v }); setSaveError(''); setVendorModal(true); }

  async function saveVendor() {
    setSaveError('');
    if (!vendorForm.vendor_name?.trim()) {
      setSaveError('Vendor name is required.');
      return;
    }
    try {
      if (editVendor) {
        const r = await api.put(`/procurement/vendors/${editVendor.id}`, vendorForm);
        if (!isMounted.current) return;
        setVendors(vs => vs.map(v => v.id === editVendor.id ? { ...r.data, avg_quality: v.avg_quality, avg_delivery: v.avg_delivery, avg_price: v.avg_price, avg_overall: v.avg_overall } : v));
      } else {
        await api.post('/procurement/vendors', vendorForm);
        if (!isMounted.current) return;
        fetchVendors();
      }
      setVendorModal(false);
    } catch (e) {
      if (!isMounted.current) return;
      setSaveError(e.response?.data?.error || e.message || 'Save failed.');
    }
  }

  /* ── RFQ actions ── */
  function openNewRFQ() { setRfqForm(EMPTY_RFQ); setSaveError(''); setRfqModal(true); }

  async function saveRFQ() {
    setSaveError('');
    if (!rfqForm.item_description?.trim()) {
      setSaveError('Item description is required.');
      return;
    }
    if (!rfqForm.quantity || Number(rfqForm.quantity) <= 0) {
      setSaveError('Quantity must be greater than 0.');
      return;
    }
    try {
      await api.post('/procurement/rfqs', rfqForm);
      if (!isMounted.current) return;
      setRfqModal(false);
      fetchRfqs();
    } catch (e) {
      if (!isMounted.current) return;
      setSaveError(e.response?.data?.error || e.message || 'Failed to create RFQ.');
    }
  }

  async function sendToVendors(rfq, vendorIds) {
    setSaveError('');
    try {
      await api.post(`/procurement/rfqs/${rfq.id}/send-to-vendors`, { vendor_ids: vendorIds });
      if (!isMounted.current) return;
      setSendVendorsRfq(null);
      fetchRfqs();
    } catch (e) {
      if (!isMounted.current) return;
      setSaveError(e.response?.data?.error || e.message || 'Failed to send RFQ.');
    }
  }

  async function awardVendor(rfq, quote) {
    try {
      await api.patch(`/procurement/rfqs/${rfq.id}/award/${quote.vendor_id}`);
      if (!isMounted.current) return;
      setViewQuotesRfq(null);
      fetchRfqs();
    } catch (e) {
      if (!isMounted.current) return;
      setSaveError(e.response?.data?.error || e.message || 'Failed to award vendor.');
    }
  }

  /* ── 3-Way Match actions ── */
  async function saveMatch() {
    setSaveError('');
    try {
      await api.post('/procurement/three-way-match', matchForm);
      if (!isMounted.current) return;
      setMatchModal(false);
      fetchMatches();
    } catch (e) {
      if (!isMounted.current) return;
      setSaveError(e.response?.data?.error || e.message || 'Failed to create match record.');
    }
  }

  async function approveMatch(m) {
    try {
      await api.patch(`/procurement/three-way-match/${m.id}/approve`);
      if (!isMounted.current) return;
      setMatches(ms => ms.map(x => x.id === m.id ? { ...x, match_status: 'approved' } : x));
    } catch { /* silent optimistic */ }
  }

  async function resolveMatch(m) {
    try {
      await api.patch(`/procurement/three-way-match/${m.id}/resolve`);
      if (!isMounted.current) return;
      setMatches(ms => ms.map(x => x.id === m.id ? { ...x, match_status: 'matched' } : x));
    } catch (e) {
      setSaveError(e.response?.data?.error || 'Failed to resolve match');
    }
  }

  /* ── Vendor Rating ── */
  function openRateVendor(vendor) { setRatingForm({ ...EMPTY_RATING, vendor_id: vendor.id }); setSaveError(''); setRateModal(true); }

  async function saveRating() {
    setSaveError('');
    try {
      await api.post('/procurement/vendor-ratings', ratingForm);
      if (!isMounted.current) return;
      setRateModal(false);
      fetchVendors();
      if (scorecardVendor?.id === ratingForm.vendor_id) fetchScorecard(scorecardVendor);
    } catch (e) {
      if (!isMounted.current) return;
      setSaveError(e.response?.data?.error || e.message || 'Failed to save rating.');
    }
  }

  /* ── Filtered vendors ── */
  const filteredVendors = useMemo(() => vendors.filter(v => {
    const s = search.toLowerCase();
    return (!s || (v.vendor_name || '').toLowerCase().includes(s) || (v.city || '').toLowerCase().includes(s))
      && (!filterCat    || v.category === filterCat)
      && (!filterStatus || v.status   === filterStatus);
  }), [vendors, search, filterCat, filterStatus]);

  const sortedScoreVendors = useMemo(() =>
    [...vendors].sort((a, b) => (+b.avg_overall || 0) - (+a.avg_overall || 0))
  , [vendors]);

  /* ── Style tokens ── */
  const card = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 20 };
  const tabBtn = active => ({ padding: '8px 20px', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14, background: active ? '#6B3FDB' : '#f5f3ff', color: active ? '#fff' : '#6B3FDB', transition: 'all .2s' });
  const btn = (v = 'primary') => ({ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13, background: v === 'primary' ? '#6B3FDB' : v === 'danger' ? '#ef4444' : '#f5f3ff', color: v === 'primary' || v === 'danger' ? '#fff' : '#6B3FDB' });
  const inp = { width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
  const TH  = { padding: '10px 12px', textAlign: 'left', fontSize: 12, color: '#6b7280', fontWeight: 600, borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
  const TD  = { padding: '10px 12px', fontSize: 13, color: '#1f2937', borderBottom: '1px solid #f9f9fb' };

  function fieldRow(label, children) {
    return (
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 4, fontWeight: 500 }}>{label}</label>
        {children}
      </div>
    );
  }

  /* ── Send-to-vendors modal: pre-fill from RFQ vendor_ids ── */
  useEffect(() => {
    if (sendVendorsRfq) setSendVendorIds((sendVendorsRfq.vendor_ids || []).map(String));
  }, [sendVendorsRfq]);

  /* ════════════════════════════════════════════════════════════════════════
     RENDER
  ════════════════════════════════════════════════════════════════════════ */
  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', background: '#fafafa' }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Vendor Management</h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Manifest Technologies — Procurement Portal</p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[['vendors', 'Vendors'], ['rfq', 'RFQ'], ['compare', 'Price Compare'], ['match', '3-Way Match'], ['scorecard', 'Scorecard']].map(([id, label]) => (
          <button key={id} style={tabBtn(tab === id)} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {/* ── VENDORS TAB ── */}
      {tab === 'vendors' && (
        <div style={card}>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <input placeholder="Search vendor or city…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inp, width: 220 }} />
            <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ ...inp, width: 160 }}>
              <option value="">All Categories</option>
              {VENDOR_CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inp, width: 130 }}>
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
            <button style={{ ...btn('ghost'), marginLeft: 'auto' }} onClick={fetchVendors}>Refresh</button>
            <button style={btn('primary')} onClick={openAddVendor}>+ Add Vendor</button>
          </div>
          <TabError message={vendorError} onRetry={fetchVendors} />
          {vendorLoading
            ? <div style={{ textAlign: 'center', padding: 32, color: '#6B3FDB' }}>Loading vendors…</div>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa' }}>
                      {['Vendor Name', 'Category', 'GSTIN', 'PAN', 'City', 'Quality★', 'Delivery★', 'Price★', 'Overall★', 'Status', 'Actions'].map(h => (
                        <th key={h} style={TH}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVendors.map(v => {
                      const q = +v.avg_quality  || +v.quality_rating  || 0;
                      const d = +v.avg_delivery || +v.delivery_rating || 0;
                      const p = +v.avg_price    || +v.price_rating    || 0;
                      const o = +v.avg_overall  || ((q + d + p) / 3);
                      return (
                        <tr key={v.id}>
                          <td style={{ ...TD, fontWeight: 600, color: '#6B3FDB' }}>{v.vendor_name}</td>
                          <td style={TD}><span style={{ background: '#f5f3ff', color: '#6B3FDB', padding: '2px 8px', borderRadius: 8, fontSize: 12 }}>{v.category}</span></td>
                          <td style={{ ...TD, fontFamily: 'monospace', fontSize: 12 }}>{v.gstin}</td>
                          <td style={{ ...TD, fontFamily: 'monospace', fontSize: 12 }}>{v.pan}</td>
                          <td style={TD}>{v.city}</td>
                          <td style={TD}><StarRating value={q} /></td>
                          <td style={TD}><StarRating value={d} /></td>
                          <td style={TD}><StarRating value={p} /></td>
                          <td style={TD}><StarRating value={o} /></td>
                          <td style={TD}>
                            <Badge
                              label={v.status === 'active' ? 'Active' : v.status === 'pending' ? 'Pending' : 'Inactive'}
                              color={v.status === 'active' ? '#166534' : v.status === 'pending' ? '#92400e' : '#6b7280'}
                              bg={v.status === 'active' ? '#dcfce7' : v.status === 'pending' ? '#fef3c7' : '#f3f4f6'}
                            />
                          </td>
                          <td style={TD}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button style={{ ...btn('ghost'), fontSize: 12, padding: '3px 8px' }} onClick={() => openEditVendor(v)}>Edit</button>
                              <button style={{ ...btn('ghost'), fontSize: 12, padding: '3px 8px' }} onClick={() => openRateVendor(v)}>Rate</button>
                              <button style={{ ...btn('ghost'), fontSize: 12, padding: '3px 8px' }} onClick={() => { fetchScorecard(v); setTab('scorecard'); }}>Scorecard</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!filteredVendors.length && (
                      <tr><td colSpan={11} style={{ ...TD, textAlign: 'center', color: '#9ca3af', padding: 32 }}>No vendors found</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )
          }
        </div>
      )}

      {/* ── RFQ TAB ── */}
      {tab === 'rfq' && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1f2937' }}>Request for Quotations</h2>
            <button style={btn('primary')} onClick={openNewRFQ}>+ New RFQ</button>
          </div>
          <TabError message={rfqError} onRetry={fetchRfqs} />
          {rfqLoading
            ? <div style={{ textAlign: 'center', padding: 32, color: '#6B3FDB' }}>Loading RFQs…</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    {['RFQ #', 'Item', 'Qty', 'Required By', 'Responses', 'Lowest Quote', 'Status', 'Actions'].map(h => (
                      <th key={h} style={TH}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rfqs.map(r => {
                    const [sc, sbg] = RFQ_STATUS_MAP[r.status] || ['#374151', '#f3f4f6'];
                    return (
                      <tr key={r.id}>
                        <td style={{ ...TD, fontWeight: 600, color: '#6B3FDB' }}>{r.rfq_number}</td>
                        <td style={TD}>{r.item_description}</td>
                        <td style={TD}>{r.quantity} {r.unit}</td>
                        <td style={TD}>{r.required_by ? new Date(r.required_by).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                        <td style={TD}>{r.response_count ?? (r.quotes || []).length}</td>
                        <td style={TD}>{r.lowest_quote ? formatINR(r.lowest_quote) : '—'}</td>
                        <td style={TD}><Badge label={r.status} color={sc} bg={sbg} /></td>
                        <td style={TD}>
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {r.status === 'draft' && (
                              <button style={{ ...btn('primary'), fontSize: 11, padding: '3px 8px' }} onClick={() => { setSendVendorsRfq(r); setSaveError(''); }}>
                                Send to Vendors
                              </button>
                            )}
                            {(r.status === 'sent' || r.status === 'responses_received') && (
                              <button style={{ ...btn('ghost'), fontSize: 11, padding: '3px 8px' }} onClick={() => setViewQuotesRfq(r)}>
                                {r.status === 'responses_received' ? 'Award Winner' : 'View Quotes'}
                              </button>
                            )}
                            {r.status === 'closed' && (
                              <button style={{ ...btn('ghost'), fontSize: 11, padding: '3px 8px' }} onClick={() => setViewQuotesRfq(r)}>View</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {!rfqs.length && <tr><td colSpan={8} style={{ ...TD, textAlign: 'center', color: '#9ca3af', padding: 32 }}>No RFQs found</td></tr>}
                </tbody>
              </table>
            )
          }
        </div>
      )}

      {/* ── PRICE COMPARE TAB ── */}
      {tab === 'compare' && <VendorPriceComparison vendors={vendors} />}

      {/* ── 3-WAY MATCH TAB ── */}
      {tab === 'match' && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1f2937' }}>3-Way Match — PO / Invoice / GRN</h2>
            <button style={btn('primary')} onClick={() => { setMatchForm(EMPTY_MATCH); setSaveError(''); setMatchModal(true); }}>+ Add Match</button>
          </div>
          <TabError message={matchError} onRetry={fetchMatches} />
          {matchLoading
            ? <div style={{ textAlign: 'center', padding: 32, color: '#6B3FDB' }}>Loading matches…</div>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    {['PO #', 'Vendor', 'PO Amt', 'Invoice Amt', 'GRN Amt', 'Invoice #', 'Status', 'Actions'].map(h => (
                      <th key={h} style={TH}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {!matches.length && (
                    <tr><td colSpan={8} style={{ ...TD, textAlign: 'center', color: '#9ca3af', padding: 32 }}>No records. Click "+ Add Match" to create one.</td></tr>
                  )}
                  {matches.map(m => {
                    const [sc, sbg, sl] = MATCH_STATUS_MAP[m.match_status] || ['#374151', '#f3f4f6', m.match_status];
                    return (
                      <tr key={m.id}>
                        <td style={{ ...TD, fontWeight: 600 }}>{m.po_number}</td>
                        <td style={TD}>{m.vendor_name || '—'}</td>
                        <td style={TD}>{formatINR(m.po_amount)}</td>
                        <td style={TD}>{formatINR(m.vendor_invoice_amount)}</td>
                        <td style={TD}>{formatINR(m.grn_amount)}</td>
                        <td style={{ ...TD, fontFamily: 'monospace', fontSize: 12 }}>{m.vendor_invoice_no || '—'}</td>
                        <td style={TD}><Badge label={sl} color={sc} bg={sbg} /></td>
                        <td style={TD}>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {m.match_status === 'matched' && (
                              <button style={{ ...btn('primary'), fontSize: 11, padding: '3px 8px' }} onClick={() => approveMatch(m)}>Approve</button>
                            )}
                            {m.match_status === 'discrepancy' && (
                              <button style={{ ...btn('danger'), fontSize: 11, padding: '3px 8px' }} onClick={() => resolveMatch(m)}>Resolve</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          }
        </div>
      )}

      {/* ── SCORECARD TAB ── */}
      {tab === 'scorecard' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#1f2937' }}>Vendor Scorecard</h2>
            <button style={btn('primary')} onClick={() => { setRatingForm(EMPTY_RATING); setSaveError(''); setRateModal(true); }}>+ Rate Vendor</button>
          </div>

          <div style={{ ...card, marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 10 }}>Select a vendor to view detailed scorecard:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {sortedScoreVendors.map(v => {
                const o = +v.avg_overall || 0;
                const active = scorecardVendor?.id === v.id;
                return (
                  <button key={v.id} onClick={() => fetchScorecard(v)} style={{
                    padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    border: `2px solid ${active ? '#6B3FDB' : '#e5e7eb'}`,
                    background: active ? '#f5f3ff' : '#fafafa', color: active ? '#6B3FDB' : '#374151',
                  }}>
                    {v.vendor_name}{o > 0 ? ` (${o.toFixed(1)}★)` : ''}
                  </button>
                );
              })}
            </div>
          </div>

          {scorecardVendor && scorecardData && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div style={card}>
                <div style={{ fontWeight: 700, fontSize: 15, color: '#1f2937', marginBottom: 4 }}>{scorecardVendor.vendor_name}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>{scorecardVendor.category} · {scorecardVendor.city}</div>
                {scorecardData.ratings.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <RadarChart data={[
                      { metric: 'Quality',  score: scorecardData.avg_quality  || 0 },
                      { metric: 'Delivery', score: scorecardData.avg_delivery || 0 },
                      { metric: 'Price',    score: scorecardData.avg_price    || 0 },
                    ]}>
                      <PolarGrid />
                      <PolarAngleAxis dataKey="metric" tick={{ fontSize: 12 }} />
                      <Radar dataKey="score" stroke="#6B3FDB" fill="#6B3FDB" fillOpacity={0.35} />
                    </RadarChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{ textAlign: 'center', padding: 32, color: '#9ca3af', fontSize: 13 }}>
                    No ratings yet. Click "+ Rate Vendor" to add the first rating.
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 12 }}>
                  {[['Quality', scorecardData.avg_quality, '#6B3FDB'], ['Delivery', scorecardData.avg_delivery, '#0ea5e9'], ['Price', scorecardData.avg_price, '#10b981']].map(([label, val, color]) => (
                    <div key={label}>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{label}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color }}>{(+val || 0).toFixed(1)}/5</div>
                      <ProgressBar value={+val || 0} max={5} color={color} />
                    </div>
                  ))}
                </div>
              </div>

              <div style={card}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#1f2937', marginBottom: 14 }}>Rating History</div>
                <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#fafafa' }}>
                        {['PO #', 'Quality', 'Delivery', 'Price', 'Overall', 'Date'].map(h => (
                          <th key={h} style={{ ...TH, padding: '8px 10px' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {!scorecardData.ratings.length && (
                        <tr><td colSpan={6} style={{ ...TD, textAlign: 'center', color: '#9ca3af', padding: 24 }}>No ratings yet</td></tr>
                      )}
                      {scorecardData.ratings.map(r => (
                        <tr key={r.id}>
                          <td style={{ ...TD, padding: '8px 10px' }}>{r.po_number || '—'}</td>
                          <td style={{ ...TD, padding: '8px 10px' }}>{stars(r.quality_score)}</td>
                          <td style={{ ...TD, padding: '8px 10px' }}>{stars(r.delivery_score)}</td>
                          <td style={{ ...TD, padding: '8px 10px' }}>{stars(r.price_score)}</td>
                          <td style={{ ...TD, padding: '8px 10px', fontWeight: 700 }}>{(+r.overall_score || 0).toFixed(1)}</td>
                          <td style={{ ...TD, padding: '8px 10px', color: '#6b7280', fontSize: 12 }}>
                            {r.rated_at ? new Date(r.rated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {!scorecardVendor && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: 16 }}>
              {sortedScoreVendors.map(v => {
                const q = +v.avg_quality  || +v.quality_rating  || 0;
                const d = +v.avg_delivery || +v.delivery_rating || 0;
                const p = +v.avg_price    || +v.price_rating    || 0;
                const o = +v.avg_overall  || ((q + d + p) / 3);
                return (
                  <div key={v.id} style={{ ...card, cursor: 'pointer' }} onClick={() => fetchScorecard(v)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15, color: '#1f2937' }}>{v.vendor_name}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{v.category} · {v.city}</div>
                      </div>
                      <div style={{ background: '#6B3FDB', color: '#fff', borderRadius: 12, padding: '6px 14px', fontSize: 22, fontWeight: 800 }}>{o.toFixed(1)}</div>
                    </div>
                    {[['Quality', q, '#6B3FDB'], ['Delivery', d, '#0ea5e9'], ['Price', p, '#10b981']].map(([label, val, color]) => (
                      <div key={label} style={{ marginBottom: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#374151', marginBottom: 3 }}>
                          <span>{label}</span><span style={{ fontWeight: 600 }}>{Number(val).toFixed(1)}/5</span>
                        </div>
                        <ProgressBar value={+val} max={5} color={color} />
                      </div>
                    ))}
                  </div>
                );
              })}
              {!sortedScoreVendors.length && <div style={{ color: '#9ca3af', fontSize: 13 }}>No vendors yet.</div>}
            </div>
          )}
        </div>
      )}

      {/* ═══ MODALS ═══ */}

      {/* Add/Edit Vendor */}
      {vendorModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 660, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1f2937' }}>{editVendor ? 'Edit Vendor' : 'Add Vendor'}</h2>
              <button style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }} onClick={() => setVendorModal(false)}>×</button>
            </div>
            {saveError && <div style={{ marginBottom: 12, padding: '10px 14px', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>{saveError}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {fieldRow('Vendor Name *', <input style={inp} value={vendorForm.vendor_name} onChange={e => setVendorForm(f => ({ ...f, vendor_name: e.target.value }))} />)}
              {fieldRow('Category', <select style={inp} value={vendorForm.category} onChange={e => setVendorForm(f => ({ ...f, category: e.target.value }))}>{VENDOR_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>)}
              {fieldRow('GSTIN', <input style={inp} value={vendorForm.gstin} onChange={e => setVendorForm(f => ({ ...f, gstin: e.target.value }))} placeholder="27AABCT3518Q1ZV" />)}
              {fieldRow('PAN', <input style={inp} value={vendorForm.pan} onChange={e => setVendorForm(f => ({ ...f, pan: e.target.value }))} placeholder="AABCT3518Q" />)}
              {fieldRow('Bank Name', <input style={inp} value={vendorForm.bank_name} onChange={e => setVendorForm(f => ({ ...f, bank_name: e.target.value }))} />)}
              {fieldRow('Account Number', <input style={inp} value={vendorForm.account_number} onChange={e => setVendorForm(f => ({ ...f, account_number: e.target.value }))} />)}
              {fieldRow('IFSC', <input style={inp} value={vendorForm.ifsc} onChange={e => setVendorForm(f => ({ ...f, ifsc: e.target.value }))} placeholder="HDFC0001234" />)}
              {fieldRow('Contact Person', <input style={inp} value={vendorForm.contact_person} onChange={e => setVendorForm(f => ({ ...f, contact_person: e.target.value }))} />)}
              {fieldRow('Email', <input style={inp} type="email" value={vendorForm.email} onChange={e => setVendorForm(f => ({ ...f, email: e.target.value }))} />)}
              {fieldRow('Phone', <input style={inp} value={vendorForm.phone} onChange={e => setVendorForm(f => ({ ...f, phone: e.target.value }))} />)}
              {fieldRow('City', <input style={inp} value={vendorForm.city} onChange={e => setVendorForm(f => ({ ...f, city: e.target.value }))} />)}
              {fieldRow('State', <select style={inp} value={vendorForm.state} onChange={e => setVendorForm(f => ({ ...f, state: e.target.value }))}>
                <option value="">-- Select State --</option>
                {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>)}
              {fieldRow('Status', <select style={inp} value={vendorForm.status} onChange={e => setVendorForm(f => ({ ...f, status: e.target.value }))}><option value="active">Active</option><option value="inactive">Inactive</option></select>)}
            </div>
            {fieldRow('Address', <textarea style={{ ...inp, height: 60, resize: 'vertical' }} value={vendorForm.address} onChange={e => setVendorForm(f => ({ ...f, address: e.target.value }))} />)}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button style={btn('ghost')} onClick={() => setVendorModal(false)}>Cancel</button>
              <button style={btn('primary')} onClick={saveVendor}>{editVendor ? 'Update Vendor' : 'Add Vendor'}</button>
            </div>
          </div>
        </div>
      )}

      {/* New RFQ */}
      {rfqModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1f2937' }}>New RFQ</h2>
              <button style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }} onClick={() => setRfqModal(false)}>×</button>
            </div>
            {saveError && <div style={{ marginBottom: 12, padding: '10px 14px', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>{saveError}</div>}
            {fieldRow('Item Description *', <input style={inp} value={rfqForm.item_description} onChange={e => setRfqForm(f => ({ ...f, item_description: e.target.value }))} />)}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
              {fieldRow('Quantity', <input style={inp} type="number" value={rfqForm.quantity} onChange={e => setRfqForm(f => ({ ...f, quantity: e.target.value }))} />)}
              {fieldRow('Unit', <input style={inp} value={rfqForm.unit} onChange={e => setRfqForm(f => ({ ...f, unit: e.target.value }))} placeholder="kg / pcs" />)}
            </div>
            {fieldRow('Required By', <input style={inp} type="date" value={rfqForm.required_by} onChange={e => setRfqForm(f => ({ ...f, required_by: e.target.value }))} />)}
            {fieldRow('Linked PR ID (optional)', <input style={inp} value={rfqForm.linked_pr_id} onChange={e => setRfqForm(f => ({ ...f, linked_pr_id: e.target.value }))} placeholder="PR0001" />)}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button style={btn('ghost')} onClick={() => setRfqModal(false)}>Cancel</button>
              <button style={btn('primary')} onClick={saveRFQ}>Create RFQ</button>
            </div>
          </div>
        </div>
      )}

      {/* Send to Vendors */}
      {sendVendorsRfq && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 480, maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1f2937' }}>Send RFQ to Vendors</h2>
              <button style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }} onClick={() => setSendVendorsRfq(null)}>×</button>
            </div>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>{sendVendorsRfq.rfq_number} · {sendVendorsRfq.item_description}</p>
            {saveError && <div style={{ marginBottom: 12, padding: '10px 14px', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>{saveError}</div>}
            <div style={{ border: '1px solid #e9e4ff', borderRadius: 8, padding: 10, maxHeight: 200, overflowY: 'auto' }}>
              {vendors.filter(v => v.status === 'active').map(v => (
                <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={sendVendorIds.includes(String(v.id))} onChange={e => {
                    setSendVendorIds(prev => e.target.checked ? [...prev, String(v.id)] : prev.filter(x => x !== String(v.id)));
                  }} />
                  <span style={{ fontWeight: 500 }}>{v.vendor_name}</span>
                  <span style={{ color: '#9ca3af', fontSize: 12 }}>{v.category} · {v.city}</span>
                </label>
              ))}
              {!vendors.filter(v => v.status === 'active').length && <p style={{ color: '#9ca3af', fontSize: 13, margin: 0 }}>No active vendors.</p>}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button style={btn('ghost')} onClick={() => setSendVendorsRfq(null)}>Cancel</button>
              <button style={{ ...btn('primary'), opacity: sendVendorIds.length ? 1 : 0.5 }}
                onClick={() => sendToVendors(sendVendorsRfq, sendVendorIds)} disabled={!sendVendorIds.length}>
                Send to {sendVendorIds.length || 0} vendor{sendVendorIds.length !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View Quotes / Award Winner */}
      {viewQuotesRfq && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 820, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1f2937' }}>Quotes — {viewQuotesRfq.rfq_number}</h2>
              <button style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }} onClick={() => setViewQuotesRfq(null)}>×</button>
            </div>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>{viewQuotesRfq.item_description} · {viewQuotesRfq.quantity} {viewQuotesRfq.unit}</p>
            {(() => {
              const quotes = viewQuotesRfq.quotes || [];
              if (!quotes.length) return <div style={{ textAlign: 'center', padding: 24, color: '#9ca3af' }}>No quotes received yet.</div>;
              const validPrices = quotes.map(q => +q.unit_price).filter(Boolean);
              const minPrice = validPrices.length ? Math.min(...validPrices) : null;
              const chartData = quotes.filter(q => q.unit_price).map(q => ({ vendor: q.vendor_name || String(q.vendor_id), price: +q.unit_price }));
              return (
                <>
                  {chartData.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <ResponsiveContainer width="100%" height={140}>
                        <BarChart data={chartData} barSize={40}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f4" />
                          <XAxis dataKey="vendor" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${v}`} />
                          <Tooltip formatter={v => [formatINR(v), 'Unit Price']} contentStyle={{ fontSize: 12 }} />
                          <Bar dataKey="price" radius={[4, 4, 0, 0]}>
                            {chartData.map((d, i) => <Cell key={i} fill={d.price === minPrice ? '#10b981' : '#6B3FDB'} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#fafafa' }}>
                        {['Vendor', 'Unit Price', 'Total', 'Delivery', 'Payment Terms', 'Notes', 'Action'].map(h => (
                          <th key={h} style={TH}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {quotes.map(q => (
                        <tr key={q.id} style={{ background: minPrice && +q.unit_price === minPrice ? '#f0fdf4' : '#fff' }}>
                          <td style={{ ...TD, fontWeight: 600 }}>{q.vendor_name || q.vendor_id}</td>
                          <td style={TD}>{q.unit_price ? formatINR(q.unit_price) : '—'}</td>
                          <td style={{ ...TD, fontWeight: 600, color: '#6B3FDB' }}>{q.total_amount ? formatINR(q.total_amount) : '—'}</td>
                          <td style={TD}>{q.delivery_days ? `${q.delivery_days}d` : '—'}</td>
                          <td style={TD}>{q.payment_terms || '—'}</td>
                          <td style={{ ...TD, maxWidth: 160, fontSize: 12, color: '#6b7280' }}>{q.notes || '—'}</td>
                          <td style={TD}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              {viewQuotesRfq.status !== 'closed' && q.unit_price && (
                                <button style={{ ...btn('primary'), fontSize: 11, padding: '4px 10px' }} onClick={() => awardVendor(viewQuotesRfq, q)}>Award</button>
                              )}
                              {minPrice && +q.unit_price === minPrice && <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700 }}>↓ Lowest</span>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              );
            })()}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={btn('ghost')} onClick={() => setViewQuotesRfq(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Add 3-Way Match */}
      {matchModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 500, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1f2937' }}>Add 3-Way Match</h2>
              <button style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }} onClick={() => setMatchModal(false)}>×</button>
            </div>
            {saveError && <div style={{ marginBottom: 12, padding: '10px 14px', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>{saveError}</div>}
            {fieldRow('PO ID *', <input style={inp} value={matchForm.po_id} onChange={e => setMatchForm(f => ({ ...f, po_id: e.target.value }))} placeholder="Numeric PO ID" />)}
            {fieldRow('GRN ID (optional)', <input style={inp} value={matchForm.grn_id} onChange={e => setMatchForm(f => ({ ...f, grn_id: e.target.value }))} placeholder="Numeric GRN ID" />)}
            {fieldRow('Vendor Invoice No', <input style={inp} value={matchForm.vendor_invoice_no} onChange={e => setMatchForm(f => ({ ...f, vendor_invoice_no: e.target.value }))} placeholder="INV-001" />)}
            {fieldRow('Invoice Date', <input style={inp} type="date" value={matchForm.vendor_invoice_date} onChange={e => setMatchForm(f => ({ ...f, vendor_invoice_date: e.target.value }))} />)}
            {fieldRow('Invoice Amount (₹)', <input style={inp} type="number" value={matchForm.vendor_invoice_amount} onChange={e => setMatchForm(f => ({ ...f, vendor_invoice_amount: e.target.value }))} placeholder="0.00" />)}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button style={btn('ghost')} onClick={() => setMatchModal(false)}>Cancel</button>
              <button style={btn('primary')} onClick={saveMatch}>Create Match</button>
            </div>
          </div>
        </div>
      )}

      {/* Rate Vendor */}
      {rateModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#1f2937' }}>Rate Vendor</h2>
              <button style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }} onClick={() => setRateModal(false)}>×</button>
            </div>
            {saveError && <div style={{ marginBottom: 12, padding: '10px 14px', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#991b1b' }}>{saveError}</div>}
            {fieldRow('Vendor *',
              <select style={inp} value={ratingForm.vendor_id} onChange={e => setRatingForm(f => ({ ...f, vendor_id: e.target.value }))}>
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
              </select>
            )}
            {fieldRow('Linked PO ID (optional)', <input style={inp} value={ratingForm.po_id} onChange={e => setRatingForm(f => ({ ...f, po_id: e.target.value }))} placeholder="Numeric PO ID" />)}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 6, fontWeight: 500 }}>Quality</label>
              <StarPicker value={ratingForm.quality_score} onChange={v => setRatingForm(f => ({ ...f, quality_score: v }))} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 6, fontWeight: 500 }}>Delivery</label>
              <StarPicker value={ratingForm.delivery_score} onChange={v => setRatingForm(f => ({ ...f, delivery_score: v }))} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#6b7280', marginBottom: 6, fontWeight: 500 }}>Price / Value</label>
              <StarPicker value={ratingForm.price_score} onChange={v => setRatingForm(f => ({ ...f, price_score: v }))} />
            </div>
            {fieldRow('Comments', <textarea style={{ ...inp, height: 60, resize: 'vertical' }} value={ratingForm.comments} onChange={e => setRatingForm(f => ({ ...f, comments: e.target.value }))} />)}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
              <button style={btn('ghost')} onClick={() => setRateModal(false)}>Cancel</button>
              <button style={btn('primary')} onClick={saveRating}>Submit Rating</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
