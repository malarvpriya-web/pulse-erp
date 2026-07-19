import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Boxes, Wallet, Wrench, UserCheck, ShieldAlert, RefreshCw, X, Layers,
} from 'lucide-react';
import api from '@/services/api/client';

const SOURCE_META = {
  finance:     { label: 'Fixed Asset', bg: '#ede9fe', color: '#4f46e5' },
  maintenance: { label: 'Serviceable', bg: '#e0f2fe', color: '#0369a1' },
  hr:          { label: 'Allocated',   bg: '#dcfce7', color: '#15803d' },
};
const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '9px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '10px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13 };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 6 };

const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmtINR = (n) => (n == null) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

function SourceTag({ source }) {
  const m = SOURCE_META[source] || { label: source, bg: '#f3f4f6', color: '#6b7280' };
  return <span style={{ background: m.bg, color: m.color, padding: '2px 8px', borderRadius: 7, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{m.label}</span>;
}

function Kpi({ icon: Icon, label, value, color }) {
  return (
    <div style={{ ...CARD, flex: 1, minWidth: 150, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: `${color}18`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={19} /></div>
      <div><div style={{ fontSize: 20, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{value}</div><div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{label}</div></div>
    </div>
  );
}

const PHASE_COLOR = { Acquisition: '#4f46e5', Assignment: '#15803d', Return: '#6b7280', Maintenance: '#0369a1', Disposal: '#dc2626' };

function AssetDrawer({ asset, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    const primary = asset.facets[0];
    api.get(`/assets/unified/${primary.source}/${primary.ref_id}`).then(({ data }) => setD(data)).catch(() => setD(null));
  }, [asset]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div style={{ width: 460, maxWidth: '92vw', height: '100%', background: '#fff', padding: 20, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,.12)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{asset.name}</h2>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{asset.code || '—'} · SN {asset.serial_number || '—'}</div>
          </div>
          <button onClick={onClose} style={{ ...btn, padding: 6 }}><X size={16} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {asset.sources.map((s) => <SourceTag key={s} source={s} />)}
        </div>

        {!d ? <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading lifecycle…</div> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {d.financial && (
              <div style={CARD}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#374151' }}>Financial</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>Purchase cost</span><b>{fmtINR(d.financial.purchase_cost)}</b>
                  <span style={{ color: '#6b7280' }}>Book value</span><b>{fmtINR(d.financial.current_book_value)}</b>
                  <span style={{ color: '#6b7280' }}>Accum. depreciation</span><b>{fmtINR(d.financial.accumulated_depreciation)}</b>
                  <span style={{ color: '#6b7280' }}>Method</span><b>{d.financial.method || '—'}</b>
                </div>
              </div>
            )}
            {d.maintenance && (
              <div style={CARD}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#374151' }}>Maintenance</div>
                {d.maintenance.logs?.length
                  ? d.maintenance.logs.slice(0, 5).map((m) => (
                    <div key={m.id} style={{ fontSize: 12, color: '#6b7280', padding: '3px 0' }}>{fmtDate(m.start_time || m.created_at)} · {m.log_type || 'service'} — {m.description || '—'}</div>))
                  : <div style={{ fontSize: 13, color: '#9ca3af' }}>No maintenance logged.</div>}
              </div>
            )}
            <div style={CARD}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: '#374151' }}>Lifecycle</div>
              {d.timeline?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                  {d.timeline.map((t, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, paddingBottom: 12, position: 'relative' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: PHASE_COLOR[t.phase] || '#6b7280', flex: 'none', marginTop: 3 }} />
                        {i < d.timeline.length - 1 && <span style={{ width: 2, flex: 1, background: '#eee', marginTop: 2 }} />}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: PHASE_COLOR[t.phase] || '#374151' }}>{t.phase} <span style={{ color: '#9ca3af', fontWeight: 400 }}>· {fmtDate(t.date)}</span></div>
                        <div style={{ fontSize: 12, color: '#6b7280' }}>{t.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <div style={{ fontSize: 13, color: '#9ca3af' }}>No lifecycle events.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AssetRegister() {
  const [assets, setAssets] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [srcFilter, setSrcFilter] = useState('all');
  const [selected, setSelected] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/assets/unified').then(({ data }) => setAssets(Array.isArray(data) ? data : [])),
      api.get('/assets/summary').then(({ data }) => setSummary(data || {})).catch(() => setSummary({})),
    ]).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    let r = assets;
    if (srcFilter !== 'all') r = r.filter((a) => a.sources.includes(srcFilter));
    if (search) {
      const q = search.toLowerCase();
      r = r.filter((a) => [a.code, a.name, a.serial_number, a.category].some((v) => v && String(v).toLowerCase().includes(q)));
    }
    return r;
  }, [assets, srcFilter, search]);

  return (
    <div className="pulse-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Boxes size={22} color="#6B3FDB" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>Asset Register</h1>
        <button onClick={load} style={{ ...btn, marginLeft: 'auto' }}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh</button>
      </div>
      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>
        Unified view across Finance fixed assets, Maintenance serviceable assets, and HR allocations — one register, full lifecycle.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Kpi icon={Wallet} label="Book value" value={summary.total_book_value != null ? fmtINR(summary.total_book_value) : '—'} color="#4f46e5" />
        <Kpi icon={Layers} label="Fixed assets" value={summary.fixed_assets ?? 0} color="#6B3FDB" />
        <Kpi icon={Wrench} label="Under maintenance" value={summary.under_maintenance ?? 0} color="#0369a1" />
        <Kpi icon={UserCheck} label="Allocated" value={summary.allocated ?? 0} color="#15803d" />
        <Kpi icon={ShieldAlert} label="Warranty ≤90d" value={summary.warranty_expiring ?? 0} color="#d97706" />
      </div>

      <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: '1px solid #f0f0f4', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, code, serial…"
            style={{ flex: 1, minWidth: 200, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
          {['all', 'finance', 'maintenance', 'hr'].map((s) => (
            <button key={s} onClick={() => setSrcFilter(s)}
              style={{ ...btn, padding: '5px 10px', fontSize: 12, ...(srcFilter === s ? { background: '#f5f2ff', borderColor: '#6B3FDB', color: '#6B3FDB' } : {}) }}>
              {s === 'all' ? 'All' : SOURCE_META[s].label}
            </button>
          ))}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead><tr>
              <th style={TH}>Asset</th><th style={TH}>Category</th><th style={TH}>Sources</th>
              <th style={TH}>Status</th><th style={TH}>Value</th><th style={TH}>Warranty</th>
            </tr></thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.key} onClick={() => setSelected(a)} style={{ cursor: 'pointer' }}>
                  <td style={TD}>
                    <div style={{ fontWeight: 600, color: '#111827' }}>{a.name || '—'}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{a.code || '—'}{a.serial_number ? ` · SN ${a.serial_number}` : ''}</div>
                  </td>
                  <td style={{ ...TD, color: '#6b7280' }}>{a.category || '—'}</td>
                  <td style={TD}><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{a.sources.map((s) => <SourceTag key={s} source={s} />)}</div></td>
                  <td style={{ ...TD, color: '#6b7280', textTransform: 'capitalize' }}>{a.status || '—'}</td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmtINR(a.value)}</td>
                  <td style={{ ...TD, color: '#6b7280' }}>{fmtDate(a.warranty_expiry)}</td>
                </tr>
              ))}
              {!rows.length && !loading && <tr><td style={{ ...TD, textAlign: 'center', color: '#9ca3af' }} colSpan={6}>No assets found.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <AssetDrawer asset={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
