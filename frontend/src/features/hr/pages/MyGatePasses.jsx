// HR → Self Service → My Gate Passes. MODULE_FEATURE_CONNECTION_MANUAL.md §272.
//
// Any employee, no grant needed: request a gate pass (personal, official,
// medical) or a material pass for goods, follow it through approval, and
// pre-register the visitors they are expecting. The department head (else the
// reporting manager, else HR) is notified and approves in the Approval Center.
// The server limits every call here to the caller's own passes and visitors
// (hr/gateAccess.routes.js, scope=mine).
import { useSearchParams } from 'react-router-dom';
import { DoorOpen } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import PassList from '../components/gate/PassList';
import VisitorList from '../components/gate/VisitorList';
import { tabStyle, useFlash } from '../components/gate/gateUi';

const TABS = [['passes', 'My Passes'], ['visitors', 'My Visitors']];

export default function MyGatePasses({ setPage }) {
  const { user, hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'passes';
  const [flash, banner] = useFlash();
  const linked = user?.employee_id != null;
  const register = hasPermission('gate_access', 'view');

  return (
    <PageShell dock={
      <PageHero icon={DoorOpen} eyebrow="Self Service" title="My Gate Passes"
        subtitle="Request a pass to step out or to send goods out, and pre-register your visitors" />
    }>
      {!linked ? (
        <div role="status" style={{ padding: 20, background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, color: '#4b5563' }}>
          Your login is not linked to an employee record, so there are no gate passes or visitors to show here.
        </div>
      ) : (
        <>
          {banner}
          {register && setPage && (
            <p style={{ margin: '0 0 10px', fontSize: 13 }}>
              <button type="button" onClick={() => setPage('GatePassVisitors')} style={{ border: 'none', background: 'none', color: '#6B3FDB', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                Open the full gate register →
              </button>
            </p>
          )}
          <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }} role="tablist">
            {TABS.map(([k, l]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} style={tabStyle(tab === k)} onClick={() => setParams({ tab: k }, { replace: true })}>{l}</button>
            ))}
          </div>
          <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: 20, minWidth: 0 }}>
            {tab === 'passes' && <PassList mode="mine" passType="" flash={flash} canCreate canPickEmployee={false} canExport={false} />}
            {tab === 'visitors' && (
              <VisitorList mode="mine" flash={flash} canCheckIn={false} canPreRegister canPickHost={false} canExport={false} canLookup={false} />
            )}
          </div>
        </>
      )}
    </PageShell>
  );
}
