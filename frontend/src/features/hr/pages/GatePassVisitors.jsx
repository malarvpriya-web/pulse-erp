// HR → Gate Pass & Visitors — the gate register. MODULE_FEATURE_CONNECTION_MANUAL.md §272.
//
// Gated on the `gate_access` module (routes.jsx). Three tabs over
// hr/gateAccess.routes.js:
//   Gate Passes      people leaving during the day      /gate-passes?pass_type=person
//   Material Passes  goods leaving (RGP / NRGP)         /gate-passes?pass_type=material
//   Visitors         check-in, expected, check-out      /visitors
// and the summary over /gate-access/summary.
//
// The attendance import that used to be this page's first tab is
// Attendance → Punch Import now (PunchImport.jsx). Employees request their own
// passes and pre-register their visitors on My Gate Passes (MyGatePasses.jsx).
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DoorOpen } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { errText } from '../components/biometric/biometricShared';
import PassList from '../components/gate/PassList';
import VisitorList from '../components/gate/VisitorList';
import { Tile, tabStyle, useFlash } from '../components/gate/gateUi';

const TABS = [['passes', 'Gate Passes'], ['material', 'Material Passes'], ['visitors', 'Visitors']];

export default function GatePassVisitors() {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'passes';
  const setTab = (k) => setParams({ tab: k }, { replace: true });
  const [flash, banner] = useFlash();
  const [summary, setSummary] = useState(null);
  const [summaryError, setSummaryError] = useState('');
  const [employees, setEmployees] = useState([]);

  const can = {
    add: hasPermission('gate_access', 'add'),
    edit: hasPermission('gate_access', 'edit'),
    export: hasPermission('gate_access', 'export'),
    // §273: approve / refuse a visitor's entry (Security / Gate Desk).
    security: hasPermission('gate_security', 'approve'),
  };

  const loadSummary = useCallback(async () => {
    try { const res = await api.get('/gate-access/summary'); setSummary(res.data); setSummaryError(''); }
    catch (err) { setSummary(null); setSummaryError(errText(err, 'Could not load the summary')); }
  }, []);
  useEffect(() => {
    loadSummary();
    api.get('/biometric/employees/options').then((r) => setEmployees(Array.isArray(r.data) ? r.data : [])).catch(() => setEmployees([]));
  }, [loadSummary]);

  const s = summary;
  return (
    <PageShell dock={
      <PageHero icon={DoorOpen} eyebrow="Human Resources" title="Gate Pass & Visitors"
        subtitle="People and goods leaving the site, and visitors coming in — approvals, gate movements and history" />
    }>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, marginBottom: 6 }} data-testid="gate-summary">
        <Tile label="Waiting for approval" value={s?.pending} color="#6d28d9" onClick={() => setTab('passes')} />
        <Tile label="Approved, not yet out" value={s?.approved} color="#2563eb" />
        <Tile label="People out now" value={s?.people_out} color="#d97706" onClick={() => setTab('passes')} active={tab === 'passes'} />
        <Tile label="Goods out" value={s?.goods_out} color="#d97706" onClick={() => setTab('material')} active={tab === 'material'} />
        <Tile label="Overdue" value={s?.overdue} color="#dc2626" hint="past their due-back time" />
        <Tile label="Visitors awaiting security" value={s?.awaiting_security} color="#6d28d9" onClick={() => setTab('visitors')} />
        <Tile label="Visitors inside" value={s?.inside} color="#16a34a" onClick={() => setTab('visitors')} active={tab === 'visitors'}
          hint={s?.overstay ? `${s.overstay} since an earlier day` : null} />
        <Tile label="Expected today" value={s?.expected_today} color="#2563eb" />
      </div>
      <div style={{ fontSize: 11, color: summaryError ? '#b91c1c' : '#9ca3af', marginBottom: 14 }}>{summaryError || 'Live figures for today'}</div>

      {banner}

      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }} role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} style={tabStyle(tab === k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: 20, minWidth: 0 }}>
        {tab === 'passes' && (
          <PassList key="person" mode="register" passType="person" employees={employees} flash={flash} onChanged={loadSummary}
            canCreate={can.add} canPickEmployee={can.add} canExport={can.export} />
        )}
        {tab === 'material' && (
          <PassList key="material" mode="register" passType="material" employees={employees} flash={flash} onChanged={loadSummary}
            canCreate={can.add} canPickEmployee={can.add} canExport={can.export} />
        )}
        {tab === 'visitors' && (
          <VisitorList mode="register" employees={employees} flash={flash} onChanged={loadSummary}
            canCheckIn={can.add} canPreRegister={can.add} canPickHost={can.add || can.edit} canExport={can.export} canLookup={can.add || can.edit}
            canSecurity={can.security} />
        )}
      </div>
    </PageShell>
  );
}
