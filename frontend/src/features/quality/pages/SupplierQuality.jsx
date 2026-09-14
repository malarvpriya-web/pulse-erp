// frontend/src/features/quality/pages/SupplierQuality.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  Factory, RefreshCw, Users, Gauge, Award, AlertTriangle, Sigma,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell, StatBand, Stat } from '@/components/pulse-ui';

function ScoreGauge({ score }) {
  const color = score >= 90 ? '#16a34a' : score >= 70 ? '#6d28d9' : '#dc2626';
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'D';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 80, height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 4 }} />
      </div>
      <span style={{ fontWeight: 700, color, fontSize: 13 }}>{score}% ({grade})</span>
    </div>
  );
}

function VendorDetail({ vendor_id, vendor_name, onClose }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/quality/supplier-quality/${vendor_id}`).then(r => setData(r.data?.data || r.data)).catch(() => toast.error('Failed to load')).finally(() => setLoading(false));
  }, [vendor_id, toast]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ background: '#fff', width: 560, height: '100vh', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{vendor_name}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer' }}>×</button>
        </div>

        {loading ? <div style={{ color: '#6b7280' }}>Loading…</div> : !data ? <div style={{ color: '#dc2626' }}>No data available</div> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {[
                { label: 'Quality Score', value: <ScoreGauge score={Math.round(data.quality_score || 0)} /> },
                { label: 'PPM (Defective Parts per Million)', value: <span style={{ fontWeight: 700, fontSize: 18, color: data.ppm > 1000 ? '#dc2626' : '#16a34a' }}>{Math.round(data.ppm || 0).toLocaleString()}</span> },
                { label: 'Defect Rate', value: `${(parseFloat(data.defect_rate) || 0).toFixed(2)}%` },
                { label: 'Total NCRs (12 months)', value: data.total_ncrs || 0 },
                { label: 'Open NCRs', value: <span style={{ color: data.open_ncrs > 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>{data.open_ncrs || 0}</span> },
                { label: 'Deliveries Inspected', value: data.total_inspections || 0 },
              ].map(kpi => (
                <div key={kpi.label} style={{ background: '#f9fafb', borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>{kpi.label}</div>
                  <div style={{ fontSize: 15, fontWeight: kpi.label === 'Quality Score' ? 400 : 700 }}>{kpi.value}</div>
                </div>
              ))}
            </div>

            {data.ncrs?.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Recent NCRs</div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ background: '#f9fafb' }}>{['NCR #','Title','Severity','Status','Date'].map(h => <th key={h} style={{ padding: '7px 10px', textAlign: 'left', color: '#6b7280' }}>{h}</th>)}</tr></thead>
                  <tbody>
                    {data.ncrs.map(n => (
                      <tr key={n.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '7px 10px', fontWeight: 600, color: '#6B3FDB' }}>{n.ncr_number}</td>
                        <td style={{ padding: '7px 10px' }}>{n.title}</td>
                        <td style={{ padding: '7px 10px', color: n.severity === 'critical' ? '#dc2626' : n.severity === 'major' ? '#6d28d9' : '#16a34a', fontWeight: 700, fontSize: 11, textTransform: 'uppercase' }}>{n.severity}</td>
                        <td style={{ padding: '7px 10px' }}>{n.status}</td>
                        <td style={{ padding: '7px 10px', color: '#9ca3af' }}>{n.created_at ? new Date(n.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data.snapshots?.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>Quality History (Monthly)</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 400 }}>
                    <thead><tr style={{ background: '#f9fafb' }}>{['Period','Score','PPM','NCRs'].map(h => <th key={h} style={{ padding: '7px 10px', textAlign: 'left', color: '#6b7280' }}>{h}</th>)}</tr></thead>
                    <tbody>
                      {data.snapshots.slice(0,12).map((s, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '7px 10px' }}>{s.snapshot_month}</td>
                          <td style={{ padding: '7px 10px' }}>{s.quality_score}%</td>
                          <td style={{ padding: '7px 10px' }}>{s.ppm}</td>
                          <td style={{ padding: '7px 10px' }}>{s.ncr_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function SupplierQuality() {
  const toast = useToast();
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/quality/supplier-quality', { params: { limit: 100 } });
      setSuppliers(res.data?.data || res.data || []);
    } catch { toast.error('Failed to load supplier quality'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const filtered = suppliers.filter(s => !search || s.vendor_name?.toLowerCase().includes(search.toLowerCase()));

  const scoreOf   = s => Math.round(parseFloat(s.quality_score) || 0);
  const avgScore  = suppliers.length
    ? Math.round(suppliers.reduce((a, s) => a + scoreOf(s), 0) / suppliers.length)
    : 0;
  const gradeA    = suppliers.filter(s => scoreOf(s) >= 90).length;
  const atRisk    = suppliers.filter(s => scoreOf(s) < 70).length;
  const openNcrs  = suppliers.reduce((a, s) => a + (Number(s.open_ncrs) || 0), 0);
  const avgPpm    = suppliers.length
    ? Math.round(suppliers.reduce((a, s) => a + (parseFloat(s.ppm) || 0), 0) / suppliers.length)
    : 0;

  return (
    <PageShell dock={
        <PageHero
          icon={Factory}
          eyebrow="Quality"
          title="Supplier Quality Scorecards"
          subtitle="Vendor quality score, defect rate, PPM and non-conformance history"
          meta={[
            { value: suppliers.length, label: 'suppliers rated' },
            { value: `${avgScore}%`, label: 'avg score', tone: avgScore >= 90 ? 'good' : avgScore >= 70 ? 'warn' : 'bad' },
            { value: atRisk, label: 'at risk', tone: atRisk ? 'bad' : 'good' },
          ]}
          actions={
            <button className="plh-cta" onClick={load} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'plh-spin' : undefined} />
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          }
        />
    }>

      <StatBand cols={5}>
        <Stat index={0} icon={Users}         tone="primary" label="Suppliers"    value={suppliers.length} sub="with quality data" />
        <Stat index={1} icon={Gauge}         tone={avgScore >= 90 ? 'success' : avgScore >= 70 ? 'warning' : 'danger'} label="Avg Score" value={`${avgScore}%`} sub="quality score" />
        <Stat index={2} icon={Award}         tone="success" label="Grade A"      value={gradeA}   sub="score ≥ 90%" />
        <Stat index={3} icon={AlertTriangle} tone={atRisk ? 'danger' : 'success'} label="At Risk" value={atRisk} sub="score < 70%" />
        <Stat index={4} icon={Sigma}         tone="info"    label="Avg PPM"      value={avgPpm.toLocaleString()} sub={`${openNcrs} open NCRs`} />
      </StatBand>

      <div style={{ marginBottom: 16 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search supplier…" style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, width: 280 }} />
      </div>

      {loading ? <div style={{ color: '#6b7280', padding: 20 }}>Loading…</div> : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb' }}>
                {['Supplier','Quality Score','Defect Rate','PPM','Open NCRs','Total NCRs','Deliveries','Action'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0
                ? <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No supplier quality data yet — NCRs with vendor will appear here</td></tr>
                : filtered.map(s => {
                  const score = Math.round(parseFloat(s.quality_score) || 0);
                  return (
                    <tr key={s.vendor_id} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '10px 14px', fontWeight: 600 }}>{s.vendor_name || `Vendor #${s.vendor_id}`}</td>
                      <td style={{ padding: '10px 14px' }}><ScoreGauge score={score} /></td>
                      <td style={{ padding: '10px 14px', color: parseFloat(s.defect_rate) > 2 ? '#dc2626' : '#374151' }}>{(parseFloat(s.defect_rate) || 0).toFixed(2)}%</td>
                      <td style={{ padding: '10px 14px', fontWeight: 600 }}>{Math.round(parseFloat(s.ppm) || 0).toLocaleString()}</td>
                      <td style={{ padding: '10px 14px' }}><span style={{ color: s.open_ncrs > 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>{s.open_ncrs || 0}</span></td>
                      <td style={{ padding: '10px 14px' }}>{s.total_ncrs || 0}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{s.total_inspections || 0}</td>
                      <td style={{ padding: '10px 14px' }}>
                        <button onClick={() => setSelected(s)} style={{ background: '#dbeafe', color: '#2563eb', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>Details</button>
                      </td>
                    </tr>
                  );
                })
              }
            </tbody>
          </table>
        </div>
      )}

      {selected && <VendorDetail vendor_id={selected.vendor_id} vendor_name={selected.vendor_name} onClose={() => setSelected(null)} />}
    </PageShell>
  );
}
