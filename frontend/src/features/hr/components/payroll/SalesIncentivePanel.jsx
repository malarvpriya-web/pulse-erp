import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import api from '@/services/api/client';

/**
 * Payroll Processing → Yearly sales incentive.
 *
 * Each salesperson's yearly target (Sales → Targets), what they achieved (from
 * their sales orders), the slab it falls in (Settings → Sales incentive) and the
 * amount. After 31 March, "Add to <month>" puts each amount into the selected
 * payroll month as a one-time earning "Sales incentive FY 2026-27", which then
 * goes through that month's approval. Anyone already given it is skipped.
 */
const fmt = (n) => `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;
const fyStartOf = (d = new Date()) => (d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1);
const slabText = (s) => {
  if (!s) return '—';
  const range = `${s.from_pct}%${s.to_pct != null ? ` to ${s.to_pct}%` : ' and above'}`;
  const pays = s.type === 'fixed' ? fmt(s.amount) : s.type === 'pct_sales' ? `${s.amount}% of sales` : `${s.amount}% of salary`;
  return `${range}: ${pays}`;
};

export default function SalesIncentivePanel({ month, year, period, canEdit = false, onChanged, notify }) {
  const [open, setOpen] = useState(false);
  // In April–June the year just ended is the one to pay; otherwise the running year.
  const [fy, setFy] = useState(() => { const now = new Date(); const cur = fyStartOf(now); return now.getMonth() + 1 >= 4 && now.getMonth() + 1 <= 6 ? cur - 1 : cur; });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setData((await api.get('/payroll/sales-incentives', { params: { fy } })).data?.data || null); }
    catch (e) { setData(null); setError(e?.response?.data?.message || 'Could not load the sales incentives'); }
  }, [fy]);
  useEffect(() => { if (open) load(); }, [open, load]);

  const add = async () => {
    if (saving || !data) return;
    if (!window.confirm(`Add the ${data.fy_label} sales incentive to the ${period} payroll for everyone below with an amount?`)) return;
    setSaving(true); setError(null);
    try {
      const r = await api.post('/payroll/sales-incentives/add', { fy, month, year });
      notify?.(r.data?.message || 'Added');
      await load(); onChanged?.();
    } catch (e) { setError(e?.response?.data?.message || 'Not added'); }
    finally { setSaving(false); }
  };

  const rows = data?.rows || [];
  const payable = rows.filter((r) => r.amount > 0 && !r.added_to_payroll);
  const total = payable.reduce((s, r) => s + r.amount, 0);
  const noSlabs = data && !(data.rule?.slabs || []).length;
  const thisFy = fyStartOf();
  const years = [thisFy - 2, thisFy - 1, thisFy];

  return (
    <section style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 700, fontSize: 13, color: '#111827' }}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Yearly sales incentive
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, fontSize: 12 }}>
            <label>Financial year{' '}
              <select aria-label="Financial year" value={fy} onChange={(e) => setFy(Number(e.target.value))} style={{ padding: '4px 6px', fontSize: 12 }}>
                {years.map((y) => <option key={y} value={y}>FY {y}-{String(y + 1).slice(2)}</option>)}
              </select>
            </label>
            <span style={{ color: '#6b7280' }}>
              Targets come from Sales → Targets; achieved is from each person&apos;s sales orders (value before GST). Slabs are in Settings → Sales incentive.
            </span>
          </div>
          {noSlabs && <p style={{ fontSize: 12, color: '#92400e', margin: '0 0 8px' }}>No incentive slabs are set yet, so every amount is ₹0. Enter them in Payroll Center → Settings → Sales incentive.</p>}
          {data && !data.year_closed && <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>{data.fy_label} is still running: these are the figures so far. It can be added to payroll after 31 March.</p>}
          {data === null && !error ? <p style={{ fontSize: 12 }}>Loading…</p> : rows.length === 0 ? (
            !error && <p style={{ fontSize: 12, color: '#6b7280' }}>No salesperson has a yearly target for {data?.fy_label}. Set targets in Sales → Targets (period: Annual).</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 12 }}>
              <thead><tr style={{ background: '#f9fafb' }}>{['Salesperson', 'Yearly target', 'Achieved', '%', 'Slab', 'Incentive', 'In payroll'].map((h) => <th key={h} style={{ textAlign: 'left', padding: 6 }}>{h}</th>)}</tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.employee_id} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={{ padding: 6 }}>{r.name} <span style={{ color: '#9ca3af' }}>{r.employee_code}</span>{r.status && !/^(active|probation)$/i.test(r.status) && <span style={{ color: '#92400e' }}> · {r.status}</span>}</td>
                  <td style={{ padding: 6 }}>{fmt(r.target)}</td>
                  <td style={{ padding: 6 }}>{fmt(r.achieved)}</td>
                  <td style={{ padding: 6, fontWeight: 600 }}>{r.pct == null ? '—' : `${r.pct}%`}</td>
                  <td style={{ padding: 6 }}>{slabText(r.slab)}</td>
                  <td style={{ padding: 6 }} title={r.basis}>{fmt(r.amount)}</td>
                  <td style={{ padding: 6, color: '#6b7280' }}>{r.added_to_payroll ? `Added ${r.added_to_payroll.month}/${r.added_to_payroll.year}` : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {canEdit && data?.year_closed && payable.length > 0 && (
            <button type="button" className="pulse-btn-primary" onClick={add} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Plus size={13} /> {saving ? 'Adding…' : `Add ${payable.length} incentive(s), ${fmt(total)}, to ${period}`}
            </button>
          )}
          {error && <p role="alert" style={{ color: '#b91c1c', fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>
      )}
    </section>
  );
}
