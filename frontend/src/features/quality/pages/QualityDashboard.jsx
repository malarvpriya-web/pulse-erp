// frontend/src/features/quality/pages/QualityDashboard.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import '@/components/dashboard/dashkit.css';

const COLOR = {
  green:  ['#d1fae5','#16a34a'],
  red:    ['#fee2e2','#dc2626'],
  yellow: ['#fef3c7','#d97706'],
  blue:   ['#dbeafe','#2563eb'],
  purple: ['#ede9fe','#6B3FDB'],
  orange: ['#ffedd5','#ea580c'],
};

function KpiCard({ label, value, sub, color = 'blue', icon = '📊', index = 0 }) {
  const [bg, fg] = COLOR[color] || COLOR.blue;
  return (
    <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 11, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3, '--dk-i': index }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 12.5, color: '#6b7280', fontWeight: 500 }}>{label}</span>
        <span style={{ background: bg, color: fg, borderRadius: 8, padding: '3px 8px', fontSize: 17 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: '#111827', marginTop: 2 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 12, color: '#9ca3af' }}>{sub}</div>}
    </div>
  );
}

function SeverityBar({ data }) {
  const total = (data.critical || 0) + (data.major || 0) + (data.minor || 0);
  if (!total) return <div style={{ color: '#6b7280', fontSize: 13 }}>No open NCRs</div>;
  const bars = [
    { label: 'Critical', count: data.critical || 0, color: '#dc2626' },
    { label: 'Major',    count: data.major    || 0, color: '#d97706' },
    { label: 'Minor',    count: data.minor    || 0, color: '#16a34a' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {bars.map(b => (
        <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 60, fontSize: 12, color: '#6b7280' }}>{b.label}</span>
          <div style={{ flex: 1, background: '#f3f4f6', borderRadius: 4, height: 10 }}>
            <div style={{ width: `${Math.round(b.count * 100 / total)}%`, background: b.color, borderRadius: 4, height: '100%' }} />
          </div>
          <span style={{ width: 24, fontSize: 12, fontWeight: 700, color: b.color, textAlign: 'right' }}>{b.count}</span>
        </div>
      ))}
    </div>
  );
}

export default function QualityDashboard() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [calAlerts, setCalAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, alerts] = await Promise.allSettled([
        api.get('/quality/dashboard'),
        api.get('/quality/calibration/due-alerts?days=30'),
      ]);
      if (dash.status === 'fulfilled') setData(dash.value.data);
      if (alerts.status === 'fulfilled') setCalAlerts(alerts.value.data?.data || []);
    } catch (e) {
      toast.error('Failed to load quality dashboard');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 32, color: '#6b7280', fontSize: 15 }}>Loading quality dashboard…</div>;
  if (!data) return <div style={{ padding: 32, color: '#dc2626' }}>Failed to load dashboard data.</div>;

  const d = data;
  const passColor = d.pass_rate_pct >= 95 ? 'green' : d.pass_rate_pct >= 80 ? 'yellow' : 'red';

  return (
    <div style={{ padding: '16px 18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Quality Dashboard</h2>
        <button onClick={load} style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontSize: 13 }}>↻ Refresh</button>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))', gap: 10, marginBottom: 12 }}>
        <KpiCard index={0} label="Pass Rate (MTD)"      value={`${d.pass_rate_pct}%`}          color={passColor}  icon="✅" sub={`${d.inspections_this_month} inspections`} />
        <KpiCard index={1} label="Open NCRs"            value={d.open_ncrs_total}               color={d.open_ncrs_total > 0 ? 'red' : 'green'} icon="⚠️" sub="Non-conformances" />
        <KpiCard index={2} label="Overdue CAPAs"        value={d.overdue_capas}                 color={d.overdue_capas > 0 ? 'red' : 'green'}   icon="🔁" />
        <KpiCard index={3} label="Total Inspections"    value={d.total_inspections}             color="blue"   icon="🔍" />
        <KpiCard index={4} label="Calibration Due"      value={d.calibration_due_count}         color={d.calibration_due_count > 0 ? 'orange' : 'green'} icon="📏" sub="Next 30 days" />
        <KpiCard index={5} label="Open Punch Points"    value={d.open_punch_points}             color={d.open_punch_points > 0 ? 'yellow' : 'green'} icon="📌" sub="FAT/SAT" />
      </div>

      {/* Middle row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        {/* NCR by severity */}
        <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 11, padding: 14, '--dk-i': 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13.5 }}>Open NCRs by Severity</div>
          <SeverityBar data={d.open_ncrs_by_severity || {}} />
        </div>

        {/* Top defect categories */}
        <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 11, padding: 14, maxHeight: 230, overflowY: 'auto', '--dk-i': 7 }}>
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 13.5 }}>Top Defect Categories (90 days)</div>
          {(d.top_defect_categories || []).length === 0
            ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No defects recorded</div>
            : (d.top_defect_categories || []).map((c, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
                <span style={{ textTransform: 'capitalize' }}>{c.category}</span>
                <span style={{ fontWeight: 700 }}>{c.count}</span>
              </div>
            ))
          }
        </div>
      </div>

      {/* Recent NCRs */}
      <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 11, padding: 14, marginBottom: 12, '--dk-i': 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 9, fontSize: 13.5 }}>Recent NCRs</div>
        {(d.recent_ncrs || []).length === 0
          ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No NCRs yet</div>
          : <div style={{ maxHeight: '40vh', overflowY: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['NCR #','Title','Vendor','Severity','Status','Date'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(d.recent_ncrs || []).map((r, i) => {
                  const sevColor = { critical:'#dc2626', major:'#d97706', minor:'#16a34a' }[r.severity] || '#6b7280';
                  const stBg = r.status === 'closed' ? '#d1fae5' : r.status === 'open' ? '#fee2e2' : '#fef3c7';
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 600, color: '#6B3FDB' }}>{r.ncr_number}</td>
                      <td style={{ padding: '8px 12px' }}>{r.title}</td>
                      <td style={{ padding: '8px 12px', color: '#6b7280' }}>{r.vendor_name || '—'}</td>
                      <td style={{ padding: '8px 12px' }}><span style={{ color: sevColor, fontWeight: 700, fontSize: 11 }}>{r.severity?.toUpperCase()}</span></td>
                      <td style={{ padding: '8px 12px' }}><span style={{ background: stBg, padding: '2px 8px', borderRadius: 8, fontSize: 11 }}>{r.status}</span></td>
                      <td style={{ padding: '8px 12px', color: '#9ca3af' }}>{r.created_at ? new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
        }
      </div>

      {/* Calibration due */}
      {calAlerts.length > 0 && (
        <div className="dk-anim" style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 11, padding: 14, '--dk-i': 9 }}>
          <div style={{ fontWeight: 600, marginBottom: 9, fontSize: 13.5, color: '#92400e' }}>⚠ Calibration Due (Next 30 Days) — {calAlerts.length} instruments</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: 210, overflowY: 'auto' }}>
            {calAlerts.slice(0, 8).map((e, i) => (
              <div key={i} style={{ background: '#fff', border: '1px solid #fcd34d', borderRadius: 8, padding: '8px 14px', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{e.name}</div>
                <div style={{ color: '#6b7280' }}>{e.equipment_id} · {e.location || 'N/A'}</div>
                <div style={{ color: '#d97706', fontWeight: 600, marginTop: 2 }}>Due: {e.next_calibration_date ? new Date(e.next_calibration_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'N/A'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
