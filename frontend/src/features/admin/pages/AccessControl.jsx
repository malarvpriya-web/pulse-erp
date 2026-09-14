import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Users, KeyRound, UserCog, ShieldCheck, Layers } from 'lucide-react';
import UserSetup from './UserSetup';
import RolesSetup from './RolesSetup';
import MenuPermissions from './MenuPermissions';
import ApproverSetup from './ApproverSetup';
import SecurityCenter from './SecurityCenter';
import { PageHero, PageShell } from '@/components/pulse-ui';

const TABS = [
  { id: 'users',     label: 'User Management',   icon: Users      },
  { id: 'roles',     label: 'Roles & Permissions', icon: KeyRound },
  { id: 'pages',     label: 'Page Access',       icon: Layers     },
  { id: 'approvers', label: 'Approver Chains',   icon: UserCog    },
  { id: 'security',  label: 'Security Center',   icon: ShieldCheck },
];
const IDS = TABS.map(t => t.id);

export default function AccessControl({ setPage }) {
  const [sp, setSp] = useSearchParams();
  const urlTab = sp.get('tab');
  const [active, setActive] = useState(IDS.includes(urlTab) ? urlTab : IDS[0]);

  useEffect(() => {
    if (IDS.includes(urlTab) && urlTab !== active) setActive(urlTab);
  }, [urlTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = id => { setActive(id); setSp({ tab: id }, { replace: true }); };

  return (
    <PageShell dock={
      <PageHero
        icon={ShieldCheck}
        eyebrow="Administration"
        title="Access Control"
        subtitle="Manage users, define roles and permissions, configure approval chains and security policies"
        actions={TABS.map(({ id, label, icon: Icon }) => {
            const on = active === id;
            return (
              <button className="plh-cta" key={id} onClick={() => go(id)}>
                <Icon size={14} />{label}
              </button>
            );
          })}
      />
    }>

      <div>
        {active === 'users'     && <UserSetup />}
        {active === 'roles'     && <RolesSetup />}
        {active === 'pages'     && <MenuPermissions />}
        {active === 'approvers' && <ApproverSetup setPage={setPage} />}
        {active === 'security'  && <SecurityCenter />}
      </div>
    </PageShell>
  );
}
