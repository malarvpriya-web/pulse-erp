import { useState, useMemo } from 'react';
import { fmt } from '@/utils/format';
import { Download, Send } from 'lucide-react';

const BUCKETS = [
  { key: 'current',  label: 'Current',   color: '#16a34a', bg: '#dcfce7' },
  { key: 'b1_30',    label: '1–30 Days', color: '#a16207', bg: '#fef9c3' },
  { key: 'b31_60',   label: '31–60 Days',color: '#c2410c', bg: '#fed7aa' },
  { key: 'b61_90',   label: '61–90 Days',color: '#dc2626', bg: '#fecaca' },
  { key: 'b90plus',  label: '90+ Days',  color: '#7c3aed', bg: '#ede9fe' },
];

const dash = (v) => (Number(v ?? 0) > 0 ? fmt(v) : '—');

function KPICard({ label, value, color, bg }) {
  return (
    <div style={{ background: bg, border: `1px solid ${color}30`, borderRadius: 10, padding: '14px 18px', minWidth: 140 }}>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function rowBg(row) {
  if (Number(row.b90plus ?? 0) > 0) return '#fff5f5';
  if (Number(row.b61_90 ?? 0) > 0) return '#fffbeb';
  return '#fff';
}

/**
 * AgeingTable — shared AR / AP ageing component.
 * Props:
 *   type          'AR' | 'AP'
 *   data          { rows: [], totals: {} }
 *   onExport      () => void
 *   onPayNow      (row) => void   (AR only)
 *   onSendReminder (row) => void  (AR only)
 */
export default function AgeingTable({ type = 'AR', data = {}, onExport, onPayNow, onSendReminder }) {
  const { rows = [], totals = {} } = data;

  const [asOf, setAsOf] = useState('');
  const [search, setSearch] = useState('');
  const [bucket, setBucket] = useState('all');

  const partyLabel = type === 'AR' ? 'Customer' : 'Supplier';

  const filtered = useMemo(() => {
    let r = rows;
    if (search) r = r.filter(x => (x.party_name ?? '').toLowerCase().includes(search.toLowerCase()) || (x.gstin ?? '').toLowerCase().includes(search.toLowerCase()));
    if (bucket !== 'all') r = r.filter(x => Number(x[bucket] ?? 0) > 0);
    return r;
  }, [rows, search, bucket]);

  const kpis = useMemo(() => {
    const sum = (k) => filtered.reduce((acc, r) => acc + Number(r[k] ?? 0), 0);
    return BUCKETS.map(b => ({ ...b, value: sum(b.key) }));
  }, [filtered]);

  return (
    <div style={{ fontFamily: 'inherit' }}>
      {/* KPI cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        {kpis.map(k => (
          <KPICard key={k.key} label={k.label} value={fmt(k.value)} color={k.color} bg={k.bg} />
        ))}
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <input
          type="date"
          value={asOf}
          onChange={e => setAsOf(e.target.value)}
          style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}
          title="As-of date"
        />
        <input
          placeholder={`Search ${partyLabel.toLowerCase()}…`}
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', fontSize: 13, width: 200 }}
        />
        <select
          value={bucket}
          onChange={e => setBucket(e.target.value)}
          style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}
        >
          <option value="all">All Buckets</option>
          {BUCKETS.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
        </select>
        {onExport && (
          <button
            onClick={onExport}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}
          >
            <Download size={14} /> Export
          </button>
        )}
      </div>

      {/* Table */}
      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
              <th style={th}>{partyLabel.toUpperCase()}</th>
              <th style={th}>GSTIN</th>
              {BUCKETS.map(b => <th key={b.key} style={{ ...th, color: b.color }}>{b.label.toUpperCase()}</th>)}
              <th style={th}>TOTAL</th>
              <th style={th}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>No outstanding {type} entries found.</td>
              </tr>
            ) : (
              filtered.map((row, i) => {
                const total = BUCKETS.reduce((s, b) => s + Number(row[b.key] ?? 0), 0);
                return (
                  <tr key={row.id ?? i} style={{ background: rowBg(row), borderBottom: '1px solid #f3f4f6' }}>
                    <td style={td}><span style={{ fontWeight: 600 }}>{row.party_name ?? '—'}</span></td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{row.gstin ?? '—'}</td>
                    {BUCKETS.map(b => (
                      <td key={b.key} style={{ ...td, textAlign: 'right', color: Number(row[b.key] ?? 0) > 0 ? b.color : '#9ca3af' }}>
                        {dash(row[b.key])}
                      </td>
                    ))}
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{total > 0 ? fmt(total) : '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {type === 'AR' && onPayNow && (
                          <button onClick={() => onPayNow(row)} style={actionBtn('#2563eb')}>Pay</button>
                        )}
                        {type === 'AR' && onSendReminder && (
                          <button onClick={() => onSendReminder(row)} style={{ ...actionBtn('#16a34a'), display: 'flex', alignItems: 'center', gap: 4 }}>
                            <Send size={11} /> Remind
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot>
              <tr style={{ background: '#f9fafb', fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
                <td style={td} colSpan={2}>TOTAL</td>
                {BUCKETS.map(b => (
                  <td key={b.key} style={{ ...td, textAlign: 'right', color: b.color }}>
                    {dash(totals[b.key] ?? filtered.reduce((s, r) => s + Number(r[b.key] ?? 0), 0))}
                  </td>
                ))}
                <td style={{ ...td, textAlign: 'right' }}>
                  {fmt(totals.total ?? filtered.reduce((s, r) => s + BUCKETS.reduce((bs, b) => bs + Number(r[b.key] ?? 0), 0), 0))}
                </td>
                <td style={td} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

const th = {
  padding: '10px 14px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 700,
  color: '#6b7280',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
};

const td = {
  padding: '10px 14px',
  verticalAlign: 'middle',
};

const actionBtn = (color) => ({
  padding: '3px 10px',
  fontSize: 11,
  fontWeight: 600,
  background: `${color}15`,
  color,
  border: `1px solid ${color}40`,
  borderRadius: 4,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
});
