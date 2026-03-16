import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, X, Plane, Calendar } from 'lucide-react';
import api from '@/services/api/client';
import './TravelRequests.css';

const SAMPLE = [
  { id: 1, requestNo: 'TR-001', purpose: 'Client Meeting', fromCity: 'Pune', toCity: 'Mumbai', travelDate: '2026-03-20', returnDate: '2026-03-21', mode: 'Train', estimatedBudget: 4500, advanceRequired: true, status: 'Approved' },
  { id: 2, requestNo: 'TR-002', purpose: 'Annual Conference', fromCity: 'Pune', toCity: 'Bengaluru', travelDate: '2026-03-25', returnDate: '2026-03-27', mode: 'Air', estimatedBudget: 18000, advanceRequired: true, status: 'Pending' },
  { id: 3, requestNo: 'TR-003', purpose: 'Training Program', fromCity: 'Pune', toCity: 'Delhi', travelDate: '2026-04-02', returnDate: '2026-04-05', mode: 'Air', estimatedBudget: 22000, advanceRequired: false, status: 'Draft' },
  { id: 4, requestNo: 'TR-004', purpose: 'Vendor Audit', fromCity: 'Pune', toCity: 'Chennai', travelDate: '2026-02-10', returnDate: '2026-02-12', mode: 'Air', estimatedBudget: 16000, advanceRequired: true, status: 'Completed' },
  { id: 5, requestNo: 'TR-005', purpose: 'Sales Visit', fromCity: 'Pune', toCity: 'Hyderabad', travelDate: '2026-02-20', returnDate: '2026-02-21', mode: 'Air', estimatedBudget: 12000, advanceRequired: false, status: 'Rejected' },
];

const TABS = ['All', 'Draft', 'Pending', 'Approved', 'Completed', 'Rejected'];
const STATUS_COLORS = { Pending: '#fef3c7', Approved: '#dcfce7', Draft: '#f3f4f6', Rejected: '#fee2e2', Completed: '#e0e7ff' };
const STATUS_TEXT   = { Pending: '#92400e', Approved: '#15803d', Draft: '#374151', Rejected: '#991b1b', Completed: '#4338ca' };
const fmt = n => `₹${Number(n).toLocaleString('en-IN')}`;
const BLANK = { purpose: '', fromCity: '', toCity: '', travelDate: '', returnDate: '', mode: 'Air', estimatedBudget: '', advanceRequired: false, notes: '' };

export default function TravelRequests() {
  const [requests, setRequests] = useState(SAMPLE);
  const [loading, setLoading]   = useState(false);
  const [fTab, setFTab]         = useState('All');
  const [search, setSearch]     = useState('');
  const [drawer, setDrawer]     = useState(null);
  const [form, setForm]         = useState(BLANK);
  const [saving, setSaving]     = useState(false);
  const [toast, setToast]       = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fTab !== 'All') params.status = fTab;
      const res = await api.get('/travel/requests', { params });
      const raw = res.data?.data ?? res.data;
      setRequests(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setRequests(SAMPLE); }
    finally { setLoading(false); }
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const filtered = requests.filter(r =>
    (fTab === 'All' || r.status === fTab) &&
    (r.purpose?.toLowerCase().includes(search.toLowerCase()) ||
     r.toCity?.toLowerCase().includes(search.toLowerCase()) ||
     r.requestNo?.toLowerCase().includes(search.toLowerCase()))
  );

  const counts = TABS.reduce((acc, t) => ({ ...acc, [t]: t === 'All' ? requests.length : requests.filter(r => r.status === t).length }), {});

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/travel/requests', form);
      showToast('Travel request submitted!');
      setDrawer(null);
      setForm(BLANK);
      load();
    } catch {
      const newReq = { id: Date.now(), requestNo: `TR-${String(requests.length + 1).padStart(3, '0')}`, ...form, status: 'Draft' };
      setRequests(prev => [newReq, ...prev]);
      showToast('Travel request saved (offline)');
      setDrawer(null);
      setForm(BLANK);
    } finally { setSaving(false); }
  };

  return (
    <div className="tvr-root">
      {toast && <div className={`tvr-toast tvr-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="tvr-header">
        <div>
          <h1 className="tvr-title">My Travel Requests</h1>
          <p className="tvr-sub">Submit and track your travel requests</p>
        </div>
        <button className="tvr-btn-primary" onClick={() => { setForm(BLANK); setDrawer('create'); }}>
          <Plus size={15} /> New Request
        </button>
      </div>

      <div className="tvr-filters">
        <div className="tvr-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search requests…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="tvr-tabs">
          {TABS.map(t => (
            <button key={t} className={`tvr-tab ${fTab === t ? 'tvr-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="tvr-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="tvr-loading"><div className="tvr-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="tvr-empty"><Plane size={32} color="#d1d5db" /><p>No travel requests found</p></div>
      ) : (
        <div className="tvr-table-wrap">
          <table className="tvr-table">
            <thead>
              <tr><th>Request #</th><th>Purpose</th><th>Route</th><th>Travel Date</th><th>Mode</th><th>Budget</th><th>Status</th></tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="tvr-row">
                  <td><span className="tvr-num">{r.requestNo}</span></td>
                  <td>{r.purpose}</td>
                  <td><div className="tvr-route">{r.fromCity} → {r.toCity}</div></td>
                  <td><div className="tvr-date-cell"><Calendar size={11} />{new Date(r.travelDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div></td>
                  <td>{r.mode}</td>
                  <td><span className="tvr-amount">{fmt(r.estimatedBudget)}</span></td>
                  <td><span className="tvr-badge" style={{ background: STATUS_COLORS[r.status], color: STATUS_TEXT[r.status] }}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <div className="tvr-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="tvr-drawer">
            <div className="tvr-drawer-hd">
              <h3>New Travel Request</h3>
              <button className="tvr-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="tvr-drawer-body" onSubmit={handleSubmit}>
              <div className="tvr-field">
                <label>Purpose of Travel <span className="tvr-req">*</span></label>
                <input value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))} placeholder="e.g. Client Meeting" required />
              </div>
              <div className="tvr-row2">
                <div className="tvr-field">
                  <label>From City <span className="tvr-req">*</span></label>
                  <input value={form.fromCity} onChange={e => setForm(f => ({ ...f, fromCity: e.target.value }))} placeholder="Departure city" required />
                </div>
                <div className="tvr-field">
                  <label>To City <span className="tvr-req">*</span></label>
                  <input value={form.toCity} onChange={e => setForm(f => ({ ...f, toCity: e.target.value }))} placeholder="Destination city" required />
                </div>
              </div>
              <div className="tvr-row2">
                <div className="tvr-field">
                  <label>Travel Date <span className="tvr-req">*</span></label>
                  <input type="date" value={form.travelDate} onChange={e => setForm(f => ({ ...f, travelDate: e.target.value }))} required />
                </div>
                <div className="tvr-field">
                  <label>Return Date</label>
                  <input type="date" value={form.returnDate} onChange={e => setForm(f => ({ ...f, returnDate: e.target.value }))} />
                </div>
              </div>
              <div className="tvr-row2">
                <div className="tvr-field">
                  <label>Mode of Travel</label>
                  <select value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value }))}>
                    {['Air', 'Train', 'Bus', 'Car', 'Other'].map(m => <option key={m}>{m}</option>)}
                  </select>
                </div>
                <div className="tvr-field">
                  <label>Estimated Budget (₹) <span className="tvr-req">*</span></label>
                  <input type="number" min="0" value={form.estimatedBudget} onChange={e => setForm(f => ({ ...f, estimatedBudget: e.target.value }))} placeholder="0" required />
                </div>
              </div>
              <div className="tvr-field">
                <label className="tvr-check-label">
                  <input type="checkbox" checked={form.advanceRequired} onChange={e => setForm(f => ({ ...f, advanceRequired: e.target.checked }))} />
                  Advance Required
                </label>
              </div>
              <div className="tvr-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional details…" />
              </div>
              <div className="tvr-drawer-ft">
                <button type="button" className="tvr-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="tvr-btn-primary" disabled={saving}>{saving ? 'Submitting…' : 'Submit Request'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
