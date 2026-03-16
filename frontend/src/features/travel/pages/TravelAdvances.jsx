import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, X, CheckCircle, XCircle, Wallet } from 'lucide-react';
import api from '@/services/api/client';
import './TravelAdvances.css';

const SAMPLE = [
  { id: 1, advanceNo: 'ADV-001', tripRef: 'TR-002', employee: 'Priya Sharma', purpose: 'Conference travel advance', requestedAmount: 15000, disbursedAmount: 15000, requestedDate: '2026-03-18', status: 'Disbursed' },
  { id: 2, advanceNo: 'ADV-002', tripRef: 'TR-001', employee: 'Arjun Mehta', purpose: 'Client visit advance', requestedAmount: 4000, disbursedAmount: 0, requestedDate: '2026-03-16', status: 'Approved' },
  { id: 3, advanceNo: 'ADV-003', tripRef: 'TR-006', employee: 'Vikram Singh', purpose: 'Sales trip advance', requestedAmount: 4500, disbursedAmount: 0, requestedDate: '2026-03-20', status: 'Pending' },
  { id: 4, advanceNo: 'ADV-004', tripRef: 'TR-010', employee: 'Rohit Gupta', purpose: 'Kolkata site visit', requestedAmount: 20000, disbursedAmount: 0, requestedDate: '2026-03-22', status: 'Pending' },
  { id: 5, advanceNo: 'ADV-005', tripRef: 'TR-004', employee: 'Sneha Iyer', purpose: 'Chennai audit advance', requestedAmount: 12000, disbursedAmount: 12000, requestedDate: '2026-02-08', status: 'Settled' },
];

const TABS = ['All', 'Pending', 'Approved', 'Disbursed', 'Settled', 'Rejected'];
const STATUS_COLORS = { Pending: '#fef3c7', Approved: '#dbeafe', Disbursed: '#dcfce7', Settled: '#e0e7ff', Rejected: '#fee2e2' };
const STATUS_TEXT   = { Pending: '#92400e', Approved: '#1d4ed8', Disbursed: '#15803d', Settled: '#4338ca', Rejected: '#991b1b' };
const fmt = n => `₹${Number(n).toLocaleString('en-IN')}`;
const BLANK = { tripRef: '', purpose: '', requestedAmount: '', notes: '' };

export default function TravelAdvances() {
  const [advances, setAdvances] = useState(SAMPLE);
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
      const res = await api.get('/travel/advances', { params });
      const raw = res.data?.data ?? res.data;
      setAdvances(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setAdvances(SAMPLE); }
    finally { setLoading(false); }
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const filtered = advances.filter(a =>
    (fTab === 'All' || a.status === fTab) &&
    (a.advanceNo?.toLowerCase().includes(search.toLowerCase()) ||
     a.purpose?.toLowerCase().includes(search.toLowerCase()) ||
     a.employee?.toLowerCase().includes(search.toLowerCase()))
  );

  const counts = TABS.reduce((acc, t) => ({
    ...acc, [t]: t === 'All' ? advances.length : advances.filter(a => a.status === t).length
  }), {});

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/travel/advances', form);
      showToast('Advance request submitted!');
      load();
    } catch {
      const na = { id: Date.now(), advanceNo: `ADV-${String(advances.length + 1).padStart(3, '0')}`, ...form, disbursedAmount: 0, requestedDate: new Date().toISOString().split('T')[0], status: 'Pending' };
      setAdvances(prev => [na, ...prev]);
      showToast('Advance request saved (offline)');
    }
    setDrawer(null); setForm(BLANK); setSaving(false);
  };

  const quickAction = async (id, action) => {
    try {
      await api.put(`/travel/advances/${id}/status`, { status: action });
    } catch { /* optimistic */ }
    setAdvances(prev => prev.map(a => a.id === id ? { ...a, status: action } : a));
    showToast(`Advance ${action.toLowerCase()}!`);
  };

  return (
    <div className="tvadv-root">
      {toast && <div className={`tvadv-toast tvadv-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="tvadv-header">
        <div>
          <h1 className="tvadv-title">Travel Advances</h1>
          <p className="tvadv-sub">Request and track travel cash advances</p>
        </div>
        <button className="tvadv-btn-primary" onClick={() => { setForm(BLANK); setDrawer('create'); }}>
          <Plus size={15} /> Request Advance
        </button>
      </div>

      <div className="tvadv-filters">
        <div className="tvadv-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search advances…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="tvadv-tabs">
          {TABS.map(t => (
            <button key={t} className={`tvadv-tab ${fTab === t ? 'tvadv-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="tvadv-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="tvadv-loading"><div className="tvadv-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="tvadv-empty"><Wallet size={32} color="#d1d5db" /><p>No advance requests found</p></div>
      ) : (
        <div className="tvadv-table-wrap">
          <table className="tvadv-table">
            <thead>
              <tr><th>Advance #</th><th>Employee</th><th>Trip Ref</th><th>Purpose</th><th>Requested</th><th>Disbursed</th><th>Date</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {filtered.map(a => (
                <tr key={a.id} className="tvadv-row">
                  <td><span className="tvadv-num">{a.advanceNo}</span></td>
                  <td>
                    <div className="tvadv-emp">
                      <div className="tvadv-avatar">{(a.employee || '?').split(' ').map(w => w[0]).join('').slice(0,2)}</div>
                      {a.employee || 'Me'}
                    </div>
                  </td>
                  <td><span className="tvadv-ref">{a.tripRef || '—'}</span></td>
                  <td>{a.purpose}</td>
                  <td><span className="tvadv-amount">{fmt(a.requestedAmount)}</span></td>
                  <td>{a.disbursedAmount ? fmt(a.disbursedAmount) : '—'}</td>
                  <td>{new Date(a.requestedDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</td>
                  <td><span className="tvadv-badge" style={{ background: STATUS_COLORS[a.status], color: STATUS_TEXT[a.status] }}>{a.status}</span></td>
                  <td>
                    <div className="tvadv-row-actions">
                      {a.status === 'Pending' && (
                        <>
                          <button className="tvadv-approve-btn" onClick={() => quickAction(a.id, 'Approved')} title="Approve"><CheckCircle size={14} /></button>
                          <button className="tvadv-reject-btn"  onClick={() => quickAction(a.id, 'Rejected')} title="Reject"><XCircle size={14} /></button>
                        </>
                      )}
                      {a.status === 'Approved' && (
                        <button className="tvadv-disburse-btn" onClick={() => quickAction(a.id, 'Disbursed')}>Disburse</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <div className="tvadv-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="tvadv-drawer">
            <div className="tvadv-drawer-hd">
              <h3>Request Advance</h3>
              <button className="tvadv-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="tvadv-drawer-body" onSubmit={handleSubmit}>
              <div className="tvadv-field">
                <label>Trip Reference</label>
                <input value={form.tripRef} onChange={e => setForm(f => ({ ...f, tripRef: e.target.value }))} placeholder="e.g. TR-001" />
              </div>
              <div className="tvadv-field">
                <label>Purpose <span className="tvadv-req">*</span></label>
                <input value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))} placeholder="Advance purpose" required />
              </div>
              <div className="tvadv-field">
                <label>Requested Amount (₹) <span className="tvadv-req">*</span></label>
                <input type="number" min="0" value={form.requestedAmount} onChange={e => setForm(f => ({ ...f, requestedAmount: e.target.value }))} placeholder="0" required />
              </div>
              <div className="tvadv-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional notes…" />
              </div>
              <div className="tvadv-drawer-ft">
                <button type="button" className="tvadv-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="tvadv-btn-primary" disabled={saving}>{saving ? 'Submitting…' : 'Request Advance'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
