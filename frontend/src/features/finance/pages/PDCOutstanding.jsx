import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useFY } from '@/context/FYContext';

const fmt = v =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v || 0);

const fmtDate = d => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const STATUS_COLOR = {
  pending:   { bg: '#fef9c3', color: '#854d0e' },
  deposited: { bg: '#dbeafe', color: '#1e40af' },
  cleared:   { bg: '#dcfce7', color: '#166534' },
  bounced:   { bg: '#fee2e2', color: '#991b1b' },
  cancelled: { bg: '#f3f4f6', color: '#374151' },
};

function StatusBadge({ status }) {
  const s = STATUS_COLOR[status] || STATUS_COLOR.cancelled;
  return (
    <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.color, textTransform: 'capitalize', whiteSpace: 'nowrap' }}>
      {status}
    </span>
  );
}

function KpiCard({ label, value, sub, color }) {
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '18px 22px',
      boxShadow: '0 1px 4px rgba(0,0,0,.08)', borderLeft: `4px solid ${color}`, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: '#6b7280', fontWeight: 500, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111827' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// ── Outstanding Tab ────────────────────────────────────────────────────────────

function OutstandingTab() {
  const toast = useToast();
  const [summary, setSummary] = useState(null);
  const [rows, setRows]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter]   = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionModal, setActionModal] = useState(null); // { id, action }
  const [actionData, setActionData]   = useState({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (typeFilter)   params.cheque_type = typeFilter;
    if (statusFilter) params.status      = statusFilter;
    else              params.status      = undefined; // outstanding only handled server-side below

    Promise.all([
      api.get('/finance/pdc/summary').catch(() => ({ data: {} })),
      api.get('/finance/pdc', { params: { ...params, status: statusFilter || undefined } }).catch(() => ({ data: [] })),
    ]).then(([s, d]) => {
      setSummary(s.data || {});
      // default: show only pending + deposited if no status filter
      let list = Array.isArray(d.data) ? d.data : [];
      if (!statusFilter) list = list.filter(r => ['pending', 'deposited'].includes(r.status));
      setRows(list);
    }).finally(() => setLoading(false));
  }, [typeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const doAction = async () => {
    setSaving(true);
    try {
      const { id, action } = actionModal;
      if (action === 'deposit') {
        await api.post(`/finance/pdc/${id}/deposit`, { deposit_date: actionData.date || new Date().toISOString().split('T')[0] });
      } else if (action === 'clear') {
        await api.post(`/finance/pdc/${id}/clear`, { cleared_date: actionData.date || new Date().toISOString().split('T')[0] });
      } else if (action === 'bounce') {
        await api.post(`/finance/pdc/${id}/bounce`, { bounce_reason: actionData.reason || '', bounce_charges: actionData.charges || 0 });
      } else if (action === 'cancel') {
        await api.post(`/finance/pdc/${id}/cancel`, { reason: actionData.reason || '' });
      }
      setActionModal(null);
      setActionData({});
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Action failed');
    } finally {
      setSaving(false);
    }
  };

  const ACTION_LABELS = { deposit: 'Mark Deposited', clear: 'Mark Cleared', bounce: 'Mark Bounced', cancel: 'Cancel Cheque' };

  return (
    <div>
      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 24 }}>
        <KpiCard label="Receivable PDCs" value={fmt(summary?.receivable_total)} sub={`${summary?.receivable_count ?? 0} cheques`} color="#3b82f6" />
        <KpiCard label="Payable PDCs"    value={fmt(summary?.payable_total)}    sub={`${summary?.payable_count ?? 0} cheques`}    color="#8b5cf6" />
        <KpiCard label="Due This Week"   value={fmt(summary?.due_week)}         sub="across all pending"                           color="#f59e0b" />
        <KpiCard label="Bounced Amount"  value={fmt(summary?.bounced_amount)}   sub={`${summary?.bounced_count ?? 0} cheques`}    color="#ef4444" />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          <option value="">All Types</option>
          <option value="receivable">Receivable</option>
          <option value="payable">Payable</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          <option value="">Outstanding (Pending + Deposited)</option>
          <option value="pending">Pending</option>
          <option value="deposited">Deposited</option>
        </select>
        <button onClick={load} style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff',
          border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Refresh</button>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 40, textAlign: 'center',
          color: '#9ca3af', boxShadow: '0 1px 4px rgba(0,0,0,.08)' }}>
          No outstanding post-dated cheques found.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Party', 'Type', 'Cheque #', 'Bank', 'Cheque Date', 'Days', 'Amount', 'Status', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600,
                      color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '9px 14px', fontWeight: 500 }}>{r.party_name || '—'}</td>
                    <td style={{ padding: '9px 14px', textTransform: 'capitalize' }}>{r.cheque_type}</td>
                    <td style={{ padding: '9px 14px', fontFamily: 'monospace' }}>{r.cheque_number || '—'}</td>
                    <td style={{ padding: '9px 14px' }}>{r.bank_name || r.account_bank || '—'}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>{fmtDate(r.cheque_date)}</td>
                    <td style={{ padding: '9px 14px', color: r.days_until_due < 0 ? '#dc2626' : r.days_until_due <= 7 ? '#d97706' : '#374151' }}>
                      {r.days_until_due != null ? `${r.days_until_due}d` : '—'}
                    </td>
                    <td style={{ padding: '9px 14px', fontWeight: 600, textAlign: 'right' }}>{fmt(r.amount)}</td>
                    <td style={{ padding: '9px 14px' }}><StatusBadge status={r.status} /></td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {r.status === 'pending' && (
                          <button onClick={() => { setActionModal({ id: r.id, action: 'deposit' }); setActionData({}); }}
                            style={{ padding: '3px 8px', fontSize: 11, background: '#dbeafe', color: '#1e40af',
                              border: 'none', borderRadius: 5, cursor: 'pointer' }}>Deposit</button>
                        )}
                        {r.status === 'deposited' && (
                          <button onClick={() => { setActionModal({ id: r.id, action: 'clear' }); setActionData({}); }}
                            style={{ padding: '3px 8px', fontSize: 11, background: '#dcfce7', color: '#166534',
                              border: 'none', borderRadius: 5, cursor: 'pointer' }}>Clear</button>
                        )}
                        {['pending', 'deposited'].includes(r.status) && (
                          <button onClick={() => { setActionModal({ id: r.id, action: 'bounce' }); setActionData({}); }}
                            style={{ padding: '3px 8px', fontSize: 11, background: '#fee2e2', color: '#991b1b',
                              border: 'none', borderRadius: 5, cursor: 'pointer' }}>Bounce</button>
                        )}
                        {r.status === 'pending' && (
                          <button onClick={() => { setActionModal({ id: r.id, action: 'cancel' }); setActionData({}); }}
                            style={{ padding: '3px 8px', fontSize: 11, background: '#f3f4f6', color: '#6b7280',
                              border: 'none', borderRadius: 5, cursor: 'pointer' }}>Cancel</button>
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

      {/* Action modal */}
      {actionModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 28, minWidth: 340, boxShadow: '0 8px 32px rgba(0,0,0,.18)' }}>
            <h3 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 700 }}>{ACTION_LABELS[actionModal.action]}</h3>

            {['deposit', 'clear'].includes(actionModal.action) && (
              <label style={{ display: 'block', marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>
                  {actionModal.action === 'deposit' ? 'Deposit Date' : 'Cleared Date'}
                </span>
                <input type="date" value={actionData.date || new Date().toISOString().split('T')[0]}
                  onChange={e => setActionData(d => ({ ...d, date: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 10px',
                    border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
              </label>
            )}

            {['bounce', 'cancel'].includes(actionModal.action) && (
              <label style={{ display: 'block', marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>
                  {actionModal.action === 'bounce' ? 'Bounce Reason' : 'Cancellation Reason'}
                </span>
                <input type="text" placeholder="Enter reason…" value={actionData.reason || ''}
                  onChange={e => setActionData(d => ({ ...d, reason: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 10px',
                    border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
              </label>
            )}

            {actionModal.action === 'bounce' && (
              <label style={{ display: 'block', marginBottom: 14 }}>
                <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>Bounce Charges (₹)</span>
                <input type="number" min="0" placeholder="0" value={actionData.charges || ''}
                  onChange={e => setActionData(d => ({ ...d, charges: e.target.value }))}
                  style={{ display: 'block', width: '100%', marginTop: 4, padding: '7px 10px',
                    border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
              </label>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={() => { setActionModal(null); setActionData({}); }}
                style={{ padding: '8px 18px', border: '1px solid #e5e7eb', borderRadius: 8,
                  background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doAction} disabled={saving}
                style={{ padding: '8px 18px', background: '#6B3FDB', color: '#fff',
                  border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── History & Report Tab ───────────────────────────────────────────────────────

function HistoryTab() {
  const { availableFYs } = useFY();
  const [rows, setRows]     = useState([]);
  const [stats, setStats]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate]     = useState('');
  const [typeFilter, setTypeFilter]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (fromDate)    params.from_date    = fromDate;
    if (toDate)      params.to_date      = toDate;
    if (typeFilter)  params.cheque_type  = typeFilter;
    if (statusFilter) params.status      = statusFilter;

    api.get('/finance/pdc/history', { params })
      .then(r => {
        setRows(Array.isArray(r.data?.cheques) ? r.data.cheques : []);
        setStats(r.data?.stats || null);
      })
      .catch(() => { setRows([]); setStats(null); })
      .finally(() => setLoading(false));
  }, [fromDate, toDate, typeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  const exportCSV = () => {
    const headers = ['Party', 'Type', 'Cheque #', 'Bank', 'Cheque Date', 'Amount', 'Status', 'Cleared/Bounce Date', 'Bounce Reason', 'Reference'];
    const csvRows = rows.map(r => [
      r.party_name || '',
      r.cheque_type,
      r.cheque_number || '',
      r.bank_name || r.account_bank || '',
      fmtDate(r.cheque_date),
      r.amount,
      r.status,
      fmtDate(r.cleared_date || r.updated_at),
      r.bounce_reason || '',
      r.reference_id || '',
    ]);
    const csv = [headers, ...csvRows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'pdc-register.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20, alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>Financial Year</span>
          <select
            value={availableFYs.find(f => f.startStr === fromDate && f.endStr === toDate)?.fy || ''}
            onChange={e => {
              const f = availableFYs.find(x => x.fy === e.target.value);
              if (f) { setFromDate(f.startStr); setToDate(f.endStr); }
              else   { setFromDate(''); setToDate(''); }
            }}
            style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
            <option value="">All FY</option>
            {availableFYs.map(f => <option key={f.fy} value={f.fy}>{f.label}</option>)}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>From Date</span>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>To Date</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
        </label>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          <option value="">All Types</option>
          <option value="receivable">Receivable</option>
          <option value="payable">Payable</option>
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}>
          <option value="">All Statuses</option>
          <option value="cleared">Cleared</option>
          <option value="bounced">Bounced</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button onClick={load} style={{ padding: '7px 16px', background: '#6B3FDB', color: '#fff',
          border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>Search</button>
        <button onClick={exportCSV} disabled={rows.length === 0}
          style={{ padding: '7px 16px', background: '#fff', color: '#374151',
            border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
          Export CSV
        </button>
      </div>

      {/* Stats cards */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 20 }}>
          <KpiCard label="Total Cleared" value={fmt(stats.cleared_total)} color="#16a34a" />
          <KpiCard label="Total Bounced" value={fmt(stats.bounced_total)} color="#dc2626" />
          <KpiCard label="Bounce Rate"
            value={`${stats.bounce_rate}%`}
            sub={parseFloat(stats.bounce_rate) > 5 ? 'Above threshold' : 'Within range'}
            color={parseFloat(stats.bounce_rate) > 5 ? '#dc2626' : '#16a34a'} />
          <KpiCard label="Avg Days to Clear" value={`${stats.avg_days_to_clear}d`} color="#6366f1" />
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading…</div>}

      {!loading && rows.length === 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 40, textAlign: 'center',
          color: '#9ca3af', boxShadow: '0 1px 4px rgba(0,0,0,.08)' }}>
          No history records found for the selected filters.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 4px rgba(0,0,0,.08)', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  {['Party', 'Type', 'Cheque #', 'Bank', 'Cheque Date', 'Amount', 'Status', 'Cleared/Bounce Date', 'Bounce Reason', 'Reference'].map(h => (
                    <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 600,
                      color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '9px 14px', fontWeight: 500 }}>{r.party_name || '—'}</td>
                    <td style={{ padding: '9px 14px', textTransform: 'capitalize' }}>{r.cheque_type}</td>
                    <td style={{ padding: '9px 14px', fontFamily: 'monospace' }}>{r.cheque_number || '—'}</td>
                    <td style={{ padding: '9px 14px' }}>{r.bank_name || r.account_bank || '—'}</td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>{fmtDate(r.cheque_date)}</td>
                    <td style={{ padding: '9px 14px', fontWeight: 600, textAlign: 'right' }}>{fmt(r.amount)}</td>
                    <td style={{ padding: '9px 14px' }}><StatusBadge status={r.status} /></td>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' }}>{fmtDate(r.cleared_date || (r.status === 'bounced' ? r.updated_at : null))}</td>
                    <td style={{ padding: '9px 14px', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.bounce_reason || '—'}</td>
                    <td style={{ padding: '9px 14px' }}>{r.reference_id ? `${r.reference_type || ''} #${r.reference_id}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 14px', fontSize: 12, color: '#6b7280', borderTop: '1px solid #f3f4f6' }}>
            {rows.length} record{rows.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function PDCOutstanding() {
  const [tab, setTab] = useState('outstanding');

  const tabs = [
    { id: 'outstanding', label: 'Outstanding' },
    { id: 'history',     label: 'History & Report' },
  ];

  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>PDC Management</h1>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '2px solid #e5e7eb', marginBottom: 24, gap: 0 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              padding: '8px 22px', fontSize: 14, fontWeight: tab === t.id ? 700 : 500,
              color: tab === t.id ? '#6B3FDB' : '#6b7280',
              background: 'none', border: 'none', borderBottom: tab === t.id ? '2px solid #6B3FDB' : '2px solid transparent',
              marginBottom: -2, cursor: 'pointer', transition: 'all .15s',
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'outstanding' && <OutstandingTab />}
      {tab === 'history'     && <HistoryTab />}
    </div>
  );
}
