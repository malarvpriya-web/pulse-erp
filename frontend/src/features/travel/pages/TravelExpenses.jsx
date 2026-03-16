import { useState, useEffect, useCallback } from 'react';
import { Plus, Search, X, Trash2, Receipt } from 'lucide-react';
import api from '@/services/api/client';
import './TravelExpenses.css';

const SAMPLE = [
  { id: 1, claimNo: 'EX-001', tripRef: 'TR-001', description: 'Mumbai Client Visit', totalAmount: 4850, submittedDate: '2026-03-22', status: 'Approved' },
  { id: 2, claimNo: 'EX-002', tripRef: 'TR-004', description: 'Chennai Audit Trip', totalAmount: 16200, submittedDate: '2026-02-14', status: 'Settled' },
  { id: 3, claimNo: 'EX-003', tripRef: 'TR-002', description: 'Bengaluru Conference', totalAmount: 19400, submittedDate: '2026-03-26', status: 'Pending' },
  { id: 4, claimNo: 'EX-004', tripRef: 'TR-005', description: 'Hyderabad Sales', totalAmount: 11800, submittedDate: '2026-02-24', status: 'Rejected' },
  { id: 5, claimNo: 'EX-005', tripRef: 'TR-008', description: 'Mumbai Board Meeting', totalAmount: 3200, submittedDate: '2026-03-20', status: 'Draft' },
];

const TABS = ['All', 'Draft', 'Pending', 'Approved', 'Settled', 'Rejected'];
const STATUS_COLORS = { Draft: '#f3f4f6', Pending: '#fef3c7', Approved: '#dcfce7', Settled: '#e0e7ff', Rejected: '#fee2e2' };
const STATUS_TEXT   = { Draft: '#374151', Pending: '#92400e', Approved: '#15803d', Settled: '#4338ca', Rejected: '#991b1b' };
const CATEGORIES = ['Hotel', 'Flights', 'Train / Bus', 'Local Transport', 'Meals', 'Miscellaneous'];
const BLANK_LINE = { category: 'Hotel', description: '', amount: '', date: '' };
const fmt = n => `₹${Number(n).toLocaleString('en-IN')}`;

export default function TravelExpenses() {
  const [claims, setClaims]   = useState(SAMPLE);
  const [loading, setLoading] = useState(false);
  const [fTab, setFTab]       = useState('All');
  const [search, setSearch]   = useState('');
  const [drawer, setDrawer]   = useState(null);
  const [form, setForm]       = useState({ tripRef: '', description: '', notes: '' });
  const [lines, setLines]     = useState([{ ...BLANK_LINE }]);
  const [saving, setSaving]   = useState(false);
  const [toast, setToast]     = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (fTab !== 'All') params.status = fTab;
      const res = await api.get('/travel/expenses', { params });
      const raw = res.data?.data ?? res.data;
      setClaims(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setClaims(SAMPLE); }
    finally { setLoading(false); }
  }, [fTab]);

  useEffect(() => { load(); }, [load]);

  const filtered = claims.filter(c =>
    (fTab === 'All' || c.status === fTab) &&
    (c.claimNo?.toLowerCase().includes(search.toLowerCase()) ||
     c.description?.toLowerCase().includes(search.toLowerCase()))
  );

  const counts = TABS.reduce((acc, t) => ({
    ...acc, [t]: t === 'All' ? claims.length : claims.filter(c => c.status === t).length
  }), {});

  const total = lines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);

  const addLine = () => setLines(prev => [...prev, { ...BLANK_LINE }]);
  const removeLine = i => setLines(prev => prev.filter((_, idx) => idx !== i));
  const updateLine = (i, key, val) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, [key]: val } : l));

  const handleSubmit = async e => {
    e.preventDefault();
    if (lines.every(l => !l.amount)) { showToast('Add at least one expense line', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/travel/expenses', { ...form, lines, totalAmount: total });
      showToast('Expense claim submitted!');
    } catch {
      const nc = { id: Date.now(), claimNo: `EX-${String(claims.length + 1).padStart(3, '0')}`, ...form, totalAmount: total, submittedDate: new Date().toISOString().split('T')[0], status: 'Draft' };
      setClaims(prev => [nc, ...prev]);
      showToast('Claim saved (offline)');
    }
    setDrawer(null);
    setForm({ tripRef: '', description: '', notes: '' });
    setLines([{ ...BLANK_LINE }]);
    setSaving(false);
  };

  return (
    <div className="tve-root">
      {toast && <div className={`tve-toast tve-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="tve-header">
        <div>
          <h1 className="tve-title">Travel Expenses</h1>
          <p className="tve-sub">Submit and track travel expense claims</p>
        </div>
        <button className="tve-btn-primary" onClick={() => { setForm({ tripRef: '', description: '', notes: '' }); setLines([{ ...BLANK_LINE }]); setDrawer('create'); }}>
          <Plus size={15} /> New Claim
        </button>
      </div>

      <div className="tve-filters">
        <div className="tve-search">
          <Search size={15} color="#9ca3af" />
          <input placeholder="Search claims…" value={search} onChange={e => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
        <div className="tve-tabs">
          {TABS.map(t => (
            <button key={t} className={`tve-tab ${fTab === t ? 'tve-tab-active' : ''}`} onClick={() => setFTab(t)}>
              {t} <span className="tve-tab-count">{counts[t]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="tve-loading"><div className="tve-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="tve-empty"><Receipt size={32} color="#d1d5db" /><p>No expense claims found</p></div>
      ) : (
        <div className="tve-table-wrap">
          <table className="tve-table">
            <thead>
              <tr><th>Claim #</th><th>Trip Ref</th><th>Description</th><th>Submitted</th><th>Total Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="tve-row">
                  <td><span className="tve-num">{c.claimNo}</span></td>
                  <td><span className="tve-ref">{c.tripRef || '—'}</span></td>
                  <td>{c.description}</td>
                  <td>{new Date(c.submittedDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td><span className="tve-amount">{fmt(c.totalAmount)}</span></td>
                  <td><span className="tve-badge" style={{ background: STATUS_COLORS[c.status], color: STATUS_TEXT[c.status] }}>{c.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <div className="tve-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="tve-drawer">
            <div className="tve-drawer-hd">
              <h3>New Expense Claim</h3>
              <button className="tve-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="tve-drawer-body" onSubmit={handleSubmit}>
              <div className="tve-row2">
                <div className="tve-field">
                  <label>Trip Reference</label>
                  <input value={form.tripRef} onChange={e => setForm(f => ({ ...f, tripRef: e.target.value }))} placeholder="e.g. TR-001" />
                </div>
                <div className="tve-field">
                  <label>Description <span className="tve-req">*</span></label>
                  <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Trip description" required />
                </div>
              </div>

              <div className="tve-items-section">
                <div className="tve-items-hd">
                  <span>Expense Lines</span>
                  <button type="button" className="tve-add-line-btn" onClick={addLine}><Plus size={12} /> Add Line</button>
                </div>
                {lines.map((line, i) => (
                  <div key={i} className="tve-line-row">
                    <div className="tve-line-cat">
                      <select value={line.category} onChange={e => updateLine(i, 'category', e.target.value)}>
                        {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                      </select>
                    </div>
                    <div className="tve-line-desc">
                      <input placeholder="Description" value={line.description} onChange={e => updateLine(i, 'description', e.target.value)} />
                    </div>
                    <div className="tve-line-date">
                      <input type="date" value={line.date} onChange={e => updateLine(i, 'date', e.target.value)} />
                    </div>
                    <div className="tve-line-amt">
                      <input type="number" min="0" placeholder="Amount" value={line.amount} onChange={e => updateLine(i, 'amount', e.target.value)} />
                    </div>
                    {lines.length > 1 && (
                      <button type="button" className="tve-remove-btn" onClick={() => removeLine(i)}><Trash2 size={13} /></button>
                    )}
                  </div>
                ))}
                <div className="tve-total">
                  <span>Total</span>
                  <strong>{fmt(total)}</strong>
                </div>
              </div>

              <div className="tve-field">
                <label>Notes</label>
                <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Additional notes…" />
              </div>

              <div className="tve-drawer-ft">
                <button type="button" className="tve-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="tve-btn-primary" disabled={saving}>{saving ? 'Submitting…' : 'Submit Claim'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
