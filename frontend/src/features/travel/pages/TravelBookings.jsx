import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, X, Plane, Hotel, Car, Train } from 'lucide-react';
import api from '@/services/api/client';
import './TravelBookings.css';

const SAMPLE = [
  { id: 1, bookingRef: 'BK-001', type: 'Flight', tripRef: 'TR-002', details: 'IndiGo 6E-241 PNQ→BLR', travelDate: '2026-03-25', amount: 5800, bookedBy: 'Self', status: 'Confirmed' },
  { id: 2, bookingRef: 'BK-002', type: 'Hotel', tripRef: 'TR-002', details: 'Marriott Bengaluru, 2 nights', travelDate: '2026-03-25', amount: 9600, bookedBy: 'Admin', status: 'Confirmed' },
  { id: 3, bookingRef: 'BK-003', type: 'Flight', tripRef: 'TR-001', details: 'Vande Bharat PNQ→CSTM', travelDate: '2026-03-20', amount: 1200, bookedBy: 'Self', status: 'Completed' },
  { id: 4, bookingRef: 'BK-004', type: 'Cab', tripRef: 'TR-001', details: 'Airport transfer — Ola Corporate', travelDate: '2026-03-20', amount: 650, bookedBy: 'Self', status: 'Completed' },
  { id: 5, bookingRef: 'BK-005', type: 'Flight', tripRef: 'TR-003', details: 'Air India AI-865 PNQ→DEL', travelDate: '2026-04-02', amount: 7200, bookedBy: 'Admin', status: 'Pending' },
];

const TABS = ['All', 'Flight', 'Hotel', 'Train', 'Cab'];
const STATUS_COLORS = { Confirmed: '#dcfce7', Completed: '#e0e7ff', Pending: '#fef3c7', Cancelled: '#fee2e2' };
const STATUS_TEXT   = { Confirmed: '#15803d', Completed: '#4338ca', Pending: '#92400e', Cancelled: '#991b1b' };
const TYPE_ICONS    = { Flight: <Plane size={14} />, Hotel: <Hotel size={14} />, Train: <Train size={14} />, Cab: <Car size={14} /> };
const TYPE_COLORS   = { Flight: '#eef2ff', Hotel: '#fef3c7', Train: '#dcfce7', Cab: '#ede9fe' };
const TYPE_TEXT     = { Flight: '#4338ca', Hotel: '#92400e', Train: '#15803d', Cab: '#7c3aed' };
const fmt = n => `₹${Number(n).toLocaleString('en-IN')}`;
const BLANK = { type: 'Flight', tripRef: '', details: '', travelDate: '', amount: '', bookedBy: 'Self', notes: '' };

export default function TravelBookings() {
  const [bookings, setBookings] = useState(SAMPLE);
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
      if (fTab !== 'All') params.type = fTab;
      const res = await api.get('/travel/bookings', { params });
      const raw = res.data?.data ?? res.data;
      setBookings(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setBookings(SAMPLE); }
    finally { setLoading(false); }
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const filtered = bookings.filter(b =>
    (fTab === 'All' || b.type === fTab) &&
    (b.bookingRef?.toLowerCase().includes(search.toLowerCase()) ||
     b.details?.toLowerCase().includes(search.toLowerCase()) ||
     b.tripRef?.toLowerCase().includes(search.toLowerCase()))
  );

  const counts = TABS.reduce((acc, t) => ({
    ...acc, [t]: t === 'All' ? bookings.length : bookings.filter(b => b.type === t).length
  }), {});

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/travel/bookings', form);
      showToast('Booking added!');
      load();
    } catch {
      const nb = { id: Date.now(), bookingRef: `BK-${String(bookings.length + 1).padStart(3, '0')}`, ...form, status: 'Confirmed' };
      setBookings(prev => [nb, ...prev]);
      showToast('Booking saved (offline)');
    }
    setDrawer(null); setForm(BLANK); setSaving(false);
  };

  return (
    <div className="tvb-root">
      {toast && <div className={`tvb-toast tvb-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="tvb-header">
        <div>
          <h1 className="tvb-title">Travel Bookings</h1>
          <p className="tvb-sub">Track flight, hotel, train &amp; cab bookings</p>
        </div>
        <button className="tvb-btn-primary" onClick={() => { setForm(BLANK); setDrawer('create'); }}>
          <Plus size={15} /> Add Booking
        </button>
      </div>

      <div className="tvb-filters">
        <div className="tvb-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search bookings…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="tvb-tabs">
          {TABS.map(t => (
            <button key={t} className={`tvb-tab ${fTab === t ? 'tvb-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="tvb-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="tvb-loading"><div className="tvb-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="tvb-empty"><Plane size={32} color="#d1d5db" /><p>No bookings found</p></div>
      ) : (
        <div className="tvb-table-wrap">
          <table className="tvb-table">
            <thead>
              <tr><th>Booking Ref</th><th>Type</th><th>Trip Ref</th><th>Details</th><th>Travel Date</th><th>Amount</th><th>Booked By</th><th>Status</th></tr>
            </thead>
            <tbody>
              {filtered.map(b => (
                <tr key={b.id} className="tvb-row">
                  <td><span className="tvb-num">{b.bookingRef}</span></td>
                  <td>
                    <span className="tvb-type-badge" style={{ background: TYPE_COLORS[b.type], color: TYPE_TEXT[b.type] }}>
                      {TYPE_ICONS[b.type]} {b.type}
                    </span>
                  </td>
                  <td><span className="tvb-ref">{b.tripRef || '—'}</span></td>
                  <td>{b.details}</td>
                  <td>{new Date(b.travelDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td><span className="tvb-amount">{fmt(b.amount)}</span></td>
                  <td>{b.bookedBy}</td>
                  <td><span className="tvb-badge" style={{ background: STATUS_COLORS[b.status], color: STATUS_TEXT[b.status] }}>{b.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <div className="tvb-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="tvb-drawer">
            <div className="tvb-drawer-hd">
              <h3>Add Booking</h3>
              <button className="tvb-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="tvb-drawer-body" onSubmit={handleSubmit}>
              <div className="tvb-row2">
                <div className="tvb-field">
                  <label>Booking Type <span className="tvb-req">*</span></label>
                  <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                    {['Flight', 'Hotel', 'Train', 'Cab'].map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="tvb-field">
                  <label>Trip Reference</label>
                  <input value={form.tripRef} onChange={e => setForm(f => ({ ...f, tripRef: e.target.value }))} placeholder="e.g. TR-001" />
                </div>
              </div>
              <div className="tvb-field">
                <label>Booking Details <span className="tvb-req">*</span></label>
                <input value={form.details} onChange={e => setForm(f => ({ ...f, details: e.target.value }))} placeholder="e.g. IndiGo 6E-241 PNQ→BLR" required />
              </div>
              <div className="tvb-row2">
                <div className="tvb-field">
                  <label>Travel Date <span className="tvb-req">*</span></label>
                  <input type="date" value={form.travelDate} onChange={e => setForm(f => ({ ...f, travelDate: e.target.value }))} required />
                </div>
                <div className="tvb-field">
                  <label>Amount (₹) <span className="tvb-req">*</span></label>
                  <input type="number" min="0" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} placeholder="0" required />
                </div>
              </div>
              <div className="tvb-field">
                <label>Booked By</label>
                <select value={form.bookedBy} onChange={e => setForm(f => ({ ...f, bookedBy: e.target.value }))}>
                  {['Self', 'Admin', 'Travel Desk'].map(x => <option key={x}>{x}</option>)}
                </select>
              </div>
              <div className="tvb-field">
                <label>Notes</label>
                <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional notes…" />
              </div>
              <div className="tvb-drawer-ft">
                <button type="button" className="tvb-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="tvb-btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Booking'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
