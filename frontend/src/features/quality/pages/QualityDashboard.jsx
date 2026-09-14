// frontend/src/features/quality/pages/QualityDashboard.jsx
import { useState, useEffect, useCallback } from 'react';
import {
  Gauge, RefreshCw, CheckCircle2, AlertTriangle, Repeat, Search,
  Ruler, Pin, ClipboardList,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import useDashboardFilters from '@/hooks/useDashboardFilters';
import {
  DashboardFilterBar, PageHero, PageShell, StatBand, Stat, MeterCard, MeterGrid, SectionTitle,
} from '@/components/pulse-ui';
import '@/components/dashboard/dashkit.css';

export default function QualityDashboard() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [calAlerts, setCalAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  // Inspections, NCRs and defect categories follow the selected period; the
  // calibration-due panel is a forward-looking alert list and stays on 30 days.
  const filters = useDashboardFilters({ defaultPeriod: 'fytd', storageKey: 'quality-dashboard' });
  const { params } = filters;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, alerts] = await Promise.allSettled([
        api.get('/quality/dashboard', { params }),
        api.get('/quality/calibration/due-alerts?days=30'),
      ]);
      if (dash.status === 'fulfilled') setData(dash.value.data);
      if (alerts.status === 'fulfilled') setCalAlerts(alerts.value.data?.data || []);
    } catch {
      toast.error('Failed to load quality dashboard');
    } finally {
      setLoading(false);
    }
  }, [toast, params]);

  useEffect(() => { load(); }, [load]);

  const d = data;
  // Hero and filter bar stay mounted across refetches — unmounting them on
  // every period change made the controls flicker away mid-interaction.
  const chrome = (
    <>
      <PageHero
        icon={Gauge}
        eyebrow="Quality"
        title="Quality Dashboard"
        subtitle="Inspection pass rate, non-conformances, corrective actions & calibration status"
        meta={d ? [
          { value: `${d.pass_rate_pct}%`, label: 'pass rate', tone: d.pass_rate_pct >= 95 ? 'good' : d.pass_rate_pct >= 80 ? 'warn' : 'bad' },
          { value: d.open_ncrs_total, label: 'open NCRs', tone: d.open_ncrs_total > 0 ? 'bad' : 'good' },
          { value: d.overdue_capas, label: 'overdue CAPAs', tone: d.overdue_capas > 0 ? 'bad' : 'good' },
          ...(d.period_label ? [{ value: d.period_label, label: '' }] : []),
        ] : undefined}
        actions={
          <button className="plh-cta" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'plh-spin' : undefined} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />
      <DashboardFilterBar filters={filters} />
    </>
  );

  if (loading) return (
    <PageShell dock={chrome}>
      <StatBand cols={6}>
        {Array.from({ length: 6 }, (_, i) => (
          <Stat key={i} index={i} icon={ClipboardList} tone="neutral" label="Loading" value="—" />
        ))}
      </StatBand>
    </PageShell>
  );
  if (!d) return (
    <PageShell dock={chrome}>
      <div style={{ background: '#fff', border: '1px solid #fecaca', borderRadius: 12, padding: 32, textAlign: 'center', color: '#dc2626' }}>
        <AlertTriangle size={24} style={{ marginBottom: 8 }} />
        <div style={{ fontWeight: 600 }}>Failed to load dashboard data.</div>
      </div>
    </PageShell>
  );

  const sev = d.open_ncrs_by_severity || {};
  const sevTotal = (sev.critical || 0) + (sev.major || 0) + (sev.minor || 0);
  const pct = n => (sevTotal ? (n * 100) / sevTotal : 0);

  return (
    <PageShell dock={chrome}>

      {/* KPI band */}
      <StatBand cols={6}>
        <Stat index={0} icon={CheckCircle2}  label="Pass Rate"          value={`${d.pass_rate_pct}%`}   sub={`${d.inspections_in_period ?? d.inspections_this_month} inspections`} tone={d.pass_rate_pct >= 95 ? 'success' : d.pass_rate_pct >= 80 ? 'warning' : 'danger'} />
        <Stat index={1} icon={AlertTriangle} label="Open NCRs"          value={d.open_ncrs_total}       sub="non-conformances" tone={d.open_ncrs_total > 0 ? 'danger' : 'success'} />
        <Stat index={2} icon={Repeat}        label="Overdue CAPAs"      value={d.overdue_capas}         sub="past due date"    tone={d.overdue_capas > 0 ? 'danger' : 'success'} />
        <Stat index={3} icon={Search}        label="Total Inspections"  value={d.total_inspections}     sub="all time"         tone="info" />
        <Stat index={4} icon={Ruler}         label="Calibration Due"    value={d.calibration_due_count} sub="next 30 days"     tone={d.calibration_due_count > 0 ? 'warning' : 'success'} />
        <Stat index={5} icon={Pin}           label="Open Punch Points"  value={d.open_punch_points}     sub="FAT / SAT"        tone={d.open_punch_points > 0 ? 'warning' : 'success'} />
      </StatBand>

      {/* Meters */}
      <MeterGrid>
        <MeterCard
          title="Inspection Pass Rate"
          value={d.pass_rate_pct || 0}
          legend={[
            { value: d.inspections_in_period ?? d.inspections_this_month ?? 0, label: 'inspections', color: '#0891b2' },
            { value: d.total_inspections ?? 0, label: 'all time', color: '#475569' },
          ]}
        />
        <MeterCard
          title="Open NCRs by Severity"
          caption={sevTotal ? `${sevTotal} open` : 'none open'}
          tone="danger"
          segments={[
            { pct: pct(sev.critical || 0), tone: 'danger'  },
            { pct: pct(sev.major    || 0), tone: 'warning' },
            { pct: pct(sev.minor    || 0), tone: 'success' },
          ]}
          legend={[
            { value: sev.critical || 0, label: 'critical', color: '#dc2626' },
            { value: sev.major    || 0, label: 'major',    color: '#6d28d9' },
            { value: sev.minor    || 0, label: 'minor',    color: '#16a34a' },
          ]}
        />
      </MeterGrid>

      <SectionTitle rule>Defect Analysis &amp; Recent Activity</SectionTitle>

      {/* Defect categories beside recent NCRs. The old layout gave severity its
          own card here AND a stacked meter above — the same three numbers drawn
          twice, costing a full row of vertical space. The meter is the better
          of the two (it shows proportion), so the card went. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 2fr', gap: 10, marginBottom: 10, alignItems: 'start' }}>
        {/* Top defect categories */}
        <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 11, padding: 11, maxHeight: 'min(232px, 26vh)', overflowY: 'auto', boxShadow: '0 1px 4px rgba(0,0,0,.05)', '--dk-i': 6 }}>
          <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 12.5 }}>Top Defect Categories</div>
          {(d.top_defect_categories || []).length === 0
            ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No defects recorded</div>
            : (d.top_defect_categories || []).map((c, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 }}>
                <span style={{ textTransform: 'capitalize' }}>{c.category}</span>
                <span style={{ fontWeight: 700 }}>{c.count}</span>
              </div>
            ))
          }
        </div>

        {/* Recent NCRs */}
        <div className="dk-anim" style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 11, padding: 11, boxShadow: '0 1px 4px rgba(0,0,0,.05)', '--dk-i': 7 }}>
        <div style={{ fontWeight: 700, marginBottom: 7, fontSize: 12.5 }}>Recent NCRs</div>
        {(d.recent_ncrs || []).length === 0
          ? <div style={{ color: '#9ca3af', fontSize: 13 }}>No NCRs yet</div>
          : <div style={{ maxHeight: 'min(186px, 21vh)', overflowY: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['NCR #','Title','Vendor','Severity','Status','Date'].map(h => (
                    <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', position: 'sticky', top: 0, background: '#f9fafb', zIndex: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(d.recent_ncrs || []).map((r, i) => {
                  const sevColor = { critical:'#dc2626', major:'#6d28d9', minor:'#16a34a' }[r.severity] || '#6b7280';
                  const stBg = r.status === 'closed' ? '#d1fae5' : r.status === 'open' ? '#fee2e2' : '#ede9fe';
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
      </div>

      {/* Calibration due */}
      {calAlerts.length > 0 && (
        <div className="dk-anim" style={{ background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 11, padding: 11, '--dk-i': 9 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 700, marginBottom: 9, fontSize: 13, color: '#5b21b6' }}>
            <Ruler size={14} /> Calibration Due (Next 30 Days) — {calAlerts.length} instruments
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 'min(104px, 12vh)', overflowY: 'auto' }}>
            {calAlerts.slice(0, 8).map((e, i) => (
              <div key={i} style={{ background: '#fff', border: '1px solid #c4b5fd', borderRadius: 8, padding: '8px 14px', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{e.name}</div>
                <div style={{ color: '#6b7280' }}>{e.equipment_id} · {e.location || 'N/A'}</div>
                <div style={{ color: '#6d28d9', fontWeight: 600, marginTop: 2 }}>Due: {e.next_calibration_date ? new Date(e.next_calibration_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : 'N/A'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}
