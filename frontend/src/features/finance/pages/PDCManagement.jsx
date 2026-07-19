import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api/client';
import { useFY } from '@/context/FYContext';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n) =>
  '₹' + parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const fmtDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

function daysBadge(days) {
  const n = parseInt(days);
  if (isNaN(n)) return null;
  let bg, color, label;
  if (n < 0) { bg = '#fee2e2'; color = '#dc2626'; label = `${Math.abs(n)}d overdue`; }
  else if (n === 0) { bg = '#fee2e2'; color = '#dc2626'; label = 'Due Today'; }
  else if (n <= 7)  { bg = '#fef3c7'; color = '#d97706'; label = `${n}d`; }
  else if (n <= 30) { bg = '#fef9c3'; color = '#ca8a04'; label = `${n}d`; }
  else              { bg = '#dcfce7'; color = '#16a34a'; label = `${n}d`; }
  return (
    <span style={{ background: bg, color, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

function statusBadge(status) {
  const map = {
    pending:   { bg: '#e0f2fe', color: '#0369a1', label: 'Outstanding' },
    deposited: { bg: '#fef3c7', color: '#d97706', label: 'Deposited' },
    cleared:   { bg: '#dcfce7', color: '#16a34a', label: 'Cleared' },
    bounced:   { bg: '#fee2e2', color: '#dc2626', label: 'Bounced' },
    cancelled: { bg: '#f3f4f6', color: '#6b7280', label: 'Cancelled' },
  };
  const s = map[status] || { bg: '#f3f4f6', color: '#374151', label: status };
  return (
    <span style={{ background: s.bg, color: s.color, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
      {s.label}
    </span>
  );
}

function typeBadge(type) {
  if (type === 'receivable')
    return <span style={{ background: '#dcfce7', color: '#16a34a', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>Received</span>;
  return <span style={{ background: '#e0f2fe', color: '#0369a1', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>Issued</span>;
}

// ── KPI card ─────────────────────────────────────────────────────────────────
function KPICard({ label, value, subtext, color, alert }) {
  const colors = {
    green: { bg: '#f0fdf4', border: '#86efac', accent: '#16a34a' },
    blue:  { bg: '#eff6ff', border: '#93c5fd', accent: '#2563eb' },
    amber: { bg: '#fffbeb', border: '#fcd34d', accent: '#d97706' },
    red:   { bg: '#fff1f2', border: '#fca5a5', accent: '#dc2626' },
  };
  const c = colors[color] || colors.blue;
  return (
    <div style={{ background: c.bg, border: `1.5px solid ${c.border}`, borderRadius: 12, padding: '16px 20px', minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: c.accent, marginBottom: 2 }}>
        {value}
        {alert && <span style={{ marginLeft: 8, fontSize: 14 }}>⚠</span>}
      </div>
      {subtext && <div style={{ fontSize: 11, color: '#9ca3af' }}>{subtext}</div>}
    </div>
  );
}

// ── Modal wrapper ─────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, width: 500, maxWidth: '95vw', boxShadow: '0 20px 50px rgba(0,0,0,.2)', padding: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{title}</h2>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af' }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Add PDC form ──────────────────────────────────────────────────────────────
function AddPDCModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    cheque_type: 'receivable', cheque_number: '', cheque_date: '',
    amount: '', party_id: '', bank_name: '', bank_account_id: '',
    reference_type: '', notes: '',
  });
  const [parties, setParties] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/finance/parties').then(r => setParties(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    api.get('/finance/bank-accounts').then(r => setBankAccounts(Array.isArray(r.data) ? r.data : [])).catch(() => {});
  }, []);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.cheque_date || new Date(form.cheque_date) <= new Date()) {
      setError('Cheque date must be a future date for a post-dated cheque.');
      return;
    }
    if (!form.amount || parseFloat(form.amount) <= 0) {
      setError('Amount must be greater than zero.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/finance/pdc', {
        ...form,
        party_id: form.party_id || null,
        bank_account_id: form.bank_account_id || null,
        amount: parseFloat(form.amount),
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save PDC.');
    } finally {
      setSaving(false);
    }
  };

  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
  const row = { marginBottom: 14 };
  const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };

  return (
    <Modal title="Add Post-Dated Cheque" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <div style={row}>
            <label style={lbl}>Type *</label>
            <select style={inp} value={form.cheque_type} onChange={e => set('cheque_type', e.target.value)}>
              <option value="receivable">Received (from customer)</option>
              <option value="payable">Issued (to supplier)</option>
            </select>
          </div>
          <div style={row}>
            <label style={lbl}>Party</label>
            <select style={inp} value={form.party_id} onChange={e => set('party_id', e.target.value)}>
              <option value="">— Select party —</option>
              {parties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={row}>
            <label style={lbl}>Cheque Number *</label>
            <input style={inp} required value={form.cheque_number} onChange={e => set('cheque_number', e.target.value)} placeholder="e.g. 001234" />
          </div>
          <div style={row}>
            <label style={lbl}>Bank Name</label>
            <input style={inp} value={form.bank_name} onChange={e => set('bank_name', e.target.value)} placeholder="e.g. HDFC Bank" />
          </div>
          <div style={row}>
            <label style={lbl}>Cheque Date * (must be future)</label>
            <input type="date" style={inp} required value={form.cheque_date} onChange={e => set('cheque_date', e.target.value)} />
          </div>
          <div style={row}>
            <label style={lbl}>Amount (₹) *</label>
            <input type="number" style={inp} required min="0.01" step="0.01" value={form.amount} onChange={e => set('amount', e.target.value)} placeholder="0.00" />
          </div>
          <div style={{ ...row, gridColumn: '1 / -1' }}>
            <label style={lbl}>Bank Account (optional)</label>
            <select style={inp} value={form.bank_account_id} onChange={e => set('bank_account_id', e.target.value)}>
              <option value="">— Link to bank account —</option>
              {bankAccounts.map(b => <option key={b.id} value={b.id}>{b.account_name}</option>)}
            </select>
          </div>
          <div style={{ ...row, gridColumn: '1 / -1' }}>
            <label style={lbl}>Notes</label>
            <textarea style={{ ...inp, resize: 'vertical', minHeight: 60 }} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Optional notes..." />
          </div>
        </div>

        {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button type="submit" disabled={saving} style={{ padding: '8px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {saving ? 'Saving…' : 'Add PDC'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Deposit modal ─────────────────────────────────────────────────────────────
function DepositModal({ pdc, onClose, onSaved }) {
  const [depositDate, setDepositDate] = useState(new Date().toISOString().split('T')[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleDeposit = async () => {
    setSaving(true);
    try {
      await api.post(`/finance/pdc/${pdc.id}/deposit`, { deposit_date: depositDate });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to mark as deposited.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Mark as Deposited" onClose={onClose}>
      <p style={{ color: '#374151', fontSize: 13, marginBottom: 16 }}>
        Cheque <strong>#{pdc.cheque_number}</strong> — {fmt(pdc.amount)} — {pdc.party_name || '—'}
      </p>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Deposit Date</label>
      <input type="date" value={depositDate} onChange={e => setDepositDate(e.target.value)}
        style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', marginBottom: 16 }} />
      {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button onClick={handleDeposit} disabled={saving} style={{ padding: '8px 18px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          {saving ? 'Saving…' : 'Confirm Deposit'}
        </button>
      </div>
    </Modal>
  );
}

// ── Bounce modal ──────────────────────────────────────────────────────────────
function BounceModal({ pdc, onClose, onSaved }) {
  const [bounceReason, setBounceReason] = useState('');
  const [bounceCharges, setBounceCharges] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleBounce = async () => {
    if (!bounceReason.trim()) { setError('Please enter a bounce reason.'); return; }
    setSaving(true);
    try {
      await api.post(`/finance/pdc/${pdc.id}/bounce`, { bounce_reason: bounceReason, bounce_charges: parseFloat(bounceCharges) || 0 });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to mark as bounced.');
    } finally {
      setSaving(false);
    }
  };

  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', marginBottom: 12 };

  return (
    <Modal title="Mark as Bounced" onClose={onClose}>
      <p style={{ color: '#374151', fontSize: 13, marginBottom: 16 }}>
        Cheque <strong>#{pdc.cheque_number}</strong> — {fmt(pdc.amount)} — {pdc.party_name || '—'}
      </p>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Bounce Reason *</label>
      <select value={bounceReason} onChange={e => setBounceReason(e.target.value)} style={inp}>
        <option value="">— Select reason —</option>
        <option value="Insufficient funds">Insufficient funds</option>
        <option value="Signature mismatch">Signature mismatch</option>
        <option value="Account closed">Account closed</option>
        <option value="Stop payment">Stop payment</option>
        <option value="Post-dated">Post-dated</option>
        <option value="Stale cheque">Stale cheque</option>
        <option value="Other">Other</option>
      </select>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Bounce Charges (₹)</label>
      <input type="number" min="0" step="0.01" value={bounceCharges} onChange={e => setBounceCharges(e.target.value)} style={inp} placeholder="0.00" />
      {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button onClick={handleBounce} disabled={saving} style={{ padding: '8px 18px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          {saving ? 'Saving…' : 'Mark Bounced'}
        </button>
      </div>
    </Modal>
  );
}

// ── Mark Cleared modal ────────────────────────────────────────────────────────
function ClearModal({ pdc, onClose, onSaved }) {
  const [clearedDate, setClearedDate] = useState(new Date().toISOString().split('T')[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleClear = async () => {
    setSaving(true);
    try {
      await api.post(`/finance/pdc/${pdc.id}/clear`, { cleared_date: clearedDate });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to mark as cleared.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Mark as Cleared" onClose={onClose}>
      <p style={{ color: '#374151', fontSize: 13, marginBottom: 16 }}>
        Cheque <strong>#{pdc.cheque_number}</strong> — {fmt(pdc.amount)} — {pdc.party_name || '—'}
      </p>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Cleared Date</label>
      <input type="date" value={clearedDate} onChange={e => setClearedDate(e.target.value)}
        style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', marginBottom: 16 }} />
      {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
        <button onClick={handleClear} disabled={saving} style={{ padding: '8px 18px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          {saving ? 'Saving…' : 'Mark Cleared'}
        </button>
      </div>
    </Modal>
  );
}

// ── Cancel PDC modal ──────────────────────────────────────────────────────────
function CancelModal({ pdc, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleCancel = async () => {
    setSaving(true);
    try {
      await api.post(`/finance/pdc/${pdc.id}/cancel`, { reason });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to cancel PDC.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Cancel PDC" onClose={onClose}>
      <p style={{ color: '#374151', fontSize: 13, marginBottom: 16 }}>
        Cancel cheque <strong>#{pdc.cheque_number}</strong> — {fmt(pdc.amount)}?
      </p>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Reason (optional)</label>
      <input value={reason} onChange={e => setReason(e.target.value)}
        style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', marginBottom: 16 }}
        placeholder="e.g. Duplicate entry, party request…" />
      {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Back</button>
        <button onClick={handleCancel} disabled={saving} style={{ padding: '8px 18px', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          {saving ? 'Cancelling…' : 'Cancel PDC'}
        </button>
      </div>
    </Modal>
  );
}

// ── Re-present modal ──────────────────────────────────────────────────────────
function RepresentModal({ pdc, onClose, onSaved }) {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const [form, setForm] = useState({
    cheque_type: pdc.cheque_type,
    cheque_number: '',
    cheque_date: tomorrow,
    amount: pdc.amount,
    party_id: pdc.party_id || '',
    bank_name: pdc.bank_name || '',
    bank_account_id: pdc.bank_account_id || '',
    notes: `Re-presented (was #${pdc.cheque_number})`,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.cheque_date || new Date(form.cheque_date) <= new Date()) {
      setError('New cheque date must be a future date.');
      return;
    }
    setSaving(true);
    try {
      await api.post('/finance/pdc', {
        ...form,
        party_id: form.party_id || null,
        bank_account_id: form.bank_account_id || null,
        amount: parseFloat(form.amount),
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create re-presented PDC.');
    } finally {
      setSaving(false);
    }
  };

  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };

  return (
    <Modal title="Re-present Bounced Cheque" onClose={onClose}>
      <p style={{ color: '#6b7280', fontSize: 12, marginBottom: 16 }}>
        Creates a new PDC record. Original cheque <strong>#{pdc.cheque_number}</strong> ({fmt(pdc.amount)}) remains as bounced.
      </p>
      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>New Cheque Number *</label>
            <input style={inp} required value={form.cheque_number} onChange={e => set('cheque_number', e.target.value)} placeholder="e.g. 001235" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>New Cheque Date * (must be future)</label>
            <input type="date" style={inp} required value={form.cheque_date} onChange={e => set('cheque_date', e.target.value)} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Amount (₹) *</label>
            <input type="number" style={inp} required min="0.01" step="0.01" value={form.amount} onChange={e => set('amount', e.target.value)} />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Bank Name</label>
            <input style={inp} value={form.bank_name} onChange={e => set('bank_name', e.target.value)} />
          </div>
        </div>
        {error && <div style={{ background: '#fee2e2', color: '#dc2626', padding: '8px 12px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ padding: '8px 18px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button type="submit" disabled={saving} style={{ padding: '8px 18px', background: '#0369a1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            {saving ? 'Saving…' : 'Re-present'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Outstanding tab ───────────────────────────────────────────────────────────
function OutstandingTab() {
  const { availableFYs } = useFY();
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState('');
  const [statusFilter, setStatusFilter] = useState('outstanding');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [partySearch, setPartySearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [depositPdc, setDepositPdc] = useState(null);
  const [bouncePdc, setBouncePdc] = useState(null);
  const [clearPdc, setClearPdc] = useState(null);
  const [cancelPdc, setCancelPdc] = useState(null);
  const [representPdc, setRepresentPdc] = useState(null);
  const abortRef = useRef(null);

  const load = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setLoading(true);

    const statusMap = { outstanding: 'pending', deposited: 'deposited', bounced: 'bounced', all: '' };
    const params = new URLSearchParams();
    if (type) params.set('cheque_type', type);
    const mapped = statusMap[statusFilter] ?? statusFilter;
    if (mapped) params.set('status', mapped);
    // when mapped='' (all), omit status param to return all records
    if (fromDate) params.set('from_date', fromDate);
    if (toDate) params.set('to_date', toDate);

    Promise.all([
      api.get('/finance/pdc/summary'),
      api.get(`/finance/pdc?${params}`),
    ])
      .then(([s, r]) => {
        setSummary(s.data);
        setRows(Array.isArray(r.data) ? r.data : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [type, statusFilter, fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(r => {
    if (!partySearch) return true;
    return (r.party_name || '').toLowerCase().includes(partySearch.toLowerCase());
  });

  const handleExport = () => {
    const header = 'Type,Party,Cheque #,Bank,Cheque Date,Amount,Status,Days\n';
    const body = filtered.map(r =>
      [r.cheque_type, r.party_name || '', r.cheque_number, r.bank_name || r.account_name || '',
       fmtDate(r.cheque_date), r.amount, r.status, r.days_until_due ?? ''].join(',')
    ).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pdc-outstanding-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const onSaved = () => { setShowAdd(false); setDepositPdc(null); setBouncePdc(null); setClearPdc(null); setCancelPdc(null); setRepresentPdc(null); load(); };

  const sel = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', cursor: 'pointer' };
  const inp = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' };

  return (
    <div>
      {/* KPI Summary */}
      {summary && (
        <div style={{ display: 'flex', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
          <KPICard label="Cheques to Receive" value={fmt(summary.receivable_total)} subtext={`${summary.receivable_count} cheque${summary.receivable_count !== 1 ? 's' : ''}`} color="green" />
          <KPICard label="Cheques to Issue" value={fmt(summary.payable_total)} subtext={`${summary.payable_count} cheque${summary.payable_count !== 1 ? 's' : ''}`} color="blue" />
          <KPICard label="Due This Week" value={fmt(summary.due_week)} subtext="Deposit by end of week" color="amber" />
          <KPICard label="Bounced (unresolved)" value={fmt(summary.bounced_amount)} subtext={`${summary.bounced_count} cheque${summary.bounced_count !== 1 ? 's' : ''}`} color="red" alert={summary.bounced_count > 0} />
        </div>
      )}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <select style={sel} value={type} onChange={e => setType(e.target.value)}>
          <option value="">All Types</option>
          <option value="receivable">Received</option>
          <option value="payable">Issued</option>
        </select>
        <select style={sel} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="outstanding">Outstanding (Pending)</option>
          <option value="deposited">Deposited</option>
          <option value="bounced">Bounced</option>
          <option value="all">All</option>
        </select>
        <select style={sel}
          value={availableFYs.find(f => f.startStr === fromDate && f.endStr === toDate)?.fy || ''}
          onChange={e => {
            const f = availableFYs.find(x => x.fy === e.target.value);
            if (f) { setFromDate(f.startStr); setToDate(f.endStr); }
            else   { setFromDate(''); setToDate(''); }
          }}
          title="Filter by cheque-date Financial Year">
          <option value="">All FY</option>
          {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
        </select>
        <input style={inp} type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} title="From date" />
        <input style={inp} type="date" value={toDate} onChange={e => setToDate(e.target.value)} title="To date" />
        <input style={{ ...inp, minWidth: 180 }} placeholder="Search party…" value={partySearch} onChange={e => setPartySearch(e.target.value)} />
        <div style={{ flex: 1 }} />
        <button onClick={handleExport} style={{ padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Export CSV</button>
        <button onClick={() => setShowAdd(true)} style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>+ Add PDC</button>
      </div>

      {/* Table */}
      {loading && <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>}

      {!loading && filtered.length === 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', color: '#9ca3af', boxShadow: '0 1px 4px rgba(0,0,0,.08)', fontSize: 14 }}>
          No outstanding post-dated cheques found.
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Type', 'Party', 'Cheque #', 'Bank', 'Cheque Date', 'Amount', 'Status', 'Days', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 14px' }}>{typeBadge(row.cheque_type)}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 500 }}>{row.party_name || '—'}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12 }}>{row.cheque_number || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{row.bank_name || row.account_name || '—'}</td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{fmtDate(row.cheque_date)}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(row.amount)}</td>
                    <td style={{ padding: '10px 14px' }}>{statusBadge(row.status)}</td>
                    <td style={{ padding: '10px 14px' }}>{daysBadge(row.days_until_due)}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {row.status === 'pending' && (<>
                          <button onClick={() => setDepositPdc(row)}
                            style={{ padding: '3px 10px', background: '#dcfce7', color: '#16a34a', border: '1px solid #86efac', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                            Deposit
                          </button>
                          <button onClick={() => setCancelPdc(row)}
                            style={{ padding: '3px 10px', background: '#f3f4f6', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                            Cancel
                          </button>
                        </>)}
                        {row.status === 'deposited' && (<>
                          <button onClick={() => setClearPdc(row)}
                            style={{ padding: '3px 10px', background: '#dcfce7', color: '#16a34a', border: '1px solid #86efac', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                            Cleared
                          </button>
                          <button onClick={() => setBouncePdc(row)}
                            style={{ padding: '3px 10px', background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                            Bounce
                          </button>
                        </>)}
                        {row.status === 'bounced' && (
                          <button onClick={() => setRepresentPdc(row)}
                            style={{ padding: '3px 10px', background: '#e0f2fe', color: '#0369a1', border: '1px solid #93c5fd', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                            Re-present
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 16px', borderTop: '1px solid #f3f4f6', fontSize: 12, color: '#6b7280' }}>
            {filtered.length} record{filtered.length !== 1 ? 's' : ''} · Total: {fmt(filtered.reduce((s, r) => s + parseFloat(r.amount || 0), 0))}
          </div>
        </div>
      )}

      {showAdd && <AddPDCModal onClose={() => setShowAdd(false)} onSaved={onSaved} />}
      {depositPdc && <DepositModal pdc={depositPdc} onClose={() => setDepositPdc(null)} onSaved={onSaved} />}
      {bouncePdc && <BounceModal pdc={bouncePdc} onClose={() => setBouncePdc(null)} onSaved={onSaved} />}
      {clearPdc && <ClearModal pdc={clearPdc} onClose={() => setClearPdc(null)} onSaved={onSaved} />}
      {cancelPdc && <CancelModal pdc={cancelPdc} onClose={() => setCancelPdc(null)} onSaved={onSaved} />}
      {representPdc && <RepresentModal pdc={representPdc} onClose={() => setRepresentPdc(null)} onSaved={onSaved} />}
    </div>
  );
}

// ── History / Report tab ──────────────────────────────────────────────────────
function HistoryTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().split('T')[0];
  });
  const [toDate, setToDate] = useState(new Date().toISOString().split('T')[0]);
  const abortRef = useRef(null);

  const load = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    const params = new URLSearchParams();
    if (type) params.set('cheque_type', type);
    if (status) params.set('status', status);
    if (fromDate) params.set('from_date', fromDate);
    if (toDate) params.set('to_date', toDate);

    api.get(`/finance/pdc/history?${params}`)
      .then(r => setRows(Array.isArray(r.data?.cheques) ? r.data.cheques : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [type, status, fromDate, toDate]);

  useEffect(() => { load(); }, [load]);

  const cleared   = rows.filter(r => r.status === 'cleared');
  const bounced   = rows.filter(r => r.status === 'bounced');
  const totalCleared  = cleared.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const totalBounced  = bounced.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  const bounceRate    = rows.length > 0 ? ((bounced.length / rows.length) * 100).toFixed(1) : '0.0';

  const handleExport = () => {
    const header = 'Type,Party,Cheque #,Bank,Cheque Date,Amount,Status,Cleared Date,Bounce Reason\n';
    const body = rows.map(r =>
      [r.cheque_type, r.party_name || '', r.cheque_number, r.bank_name || r.account_name || '',
       fmtDate(r.cheque_date), r.amount, r.status, fmtDate(r.cleared_date), r.bounce_reason || ''].join(',')
    ).join('\n');
    const blob = new Blob([header + body], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pdc-history-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const sel = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', cursor: 'pointer' };
  const inp = { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' };

  return (
    <div>
      {/* Summary pills */}
      <div style={{ display: 'flex', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
        <KPICard label="Total Cleared" value={fmt(totalCleared)} subtext={`${cleared.length} cheques`} color="green" />
        <KPICard label="Total Bounced" value={fmt(totalBounced)} subtext={`${bounced.length} cheques`} color="red" alert={bounced.length > 0} />
        <KPICard label="Bounce Rate" value={`${bounceRate}%`} subtext="of all history records" color={parseFloat(bounceRate) > 5 ? 'red' : 'amber'} />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <select style={sel} value={type} onChange={e => setType(e.target.value)}>
          <option value="">All Types</option>
          <option value="receivable">Received</option>
          <option value="payable">Issued</option>
        </select>
        <select style={sel} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All Statuses</option>
          <option value="cleared">Cleared</option>
          <option value="bounced">Bounced</option>
          <option value="cancelled">Cancelled</option>
          <option value="deposited">Deposited</option>
        </select>
        <input style={inp} type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
        <input style={inp} type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
        <div style={{ flex: 1 }} />
        <button onClick={handleExport} style={{ padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Export CSV</button>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', color: '#9ca3af', boxShadow: '0 1px 4px rgba(0,0,0,.08)', fontSize: 14 }}>
          No PDC history records found for the selected filters.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Type', 'Party', 'Cheque #', 'Bank', 'Cheque Date', 'Amount', 'Status', 'Cleared Date', 'Bounce Reason', 'Charges'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '10px 14px' }}>{typeBadge(row.cheque_type)}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 500 }}>{row.party_name || '—'}</td>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12 }}>{row.cheque_number || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{row.bank_name || row.account_name || '—'}</td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{fmtDate(row.cheque_date)}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(row.amount)}</td>
                    <td style={{ padding: '10px 14px' }}>{statusBadge(row.status)}</td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', color: '#6b7280' }}>{fmtDate(row.cleared_date)}</td>
                    <td style={{ padding: '10px 14px', color: '#dc2626', fontSize: 12 }}>{row.bounce_reason || '—'}</td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>{row.bounce_charges > 0 ? fmt(row.bounce_charges) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 16px', borderTop: '1px solid #f3f4f6', fontSize: 12, color: '#6b7280' }}>
            {rows.length} record{rows.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PDCManagement() {
  const [tab, setTab] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get('tab') === 'history' ? 'history' : 'outstanding';
  });

  const tabStyle = (t) => ({
    padding: '9px 20px',
    border: 'none',
    borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent',
    background: 'none',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: tab === t ? 700 : 500,
    color: tab === t ? '#6B3FDB' : '#6b7280',
    transition: 'all .15s',
  });

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 6 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>PDC Management</h1>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>Post-Dated Cheques — Outstanding &amp; History</p>
      </div>

      {/* Tabs */}
      <div style={{ borderBottom: '1px solid #e5e7eb', marginBottom: 24, display: 'flex', gap: 4 }}>
        <button style={tabStyle('outstanding')} onClick={() => setTab('outstanding')}>Outstanding PDCs</button>
        <button style={tabStyle('history')} onClick={() => setTab('history')}>PDC History / Report</button>
      </div>

      {tab === 'outstanding' && <OutstandingTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}
