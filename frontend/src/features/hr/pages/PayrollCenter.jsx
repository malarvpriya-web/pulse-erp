import { useSearchParams } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import PayrollSettings from './PayrollSettings';
import Payroll from './Payroll';
import SalaryStructure from './SalaryStructure';
import PayslipGenerator from './PayslipGenerator';
import PayslipViewer from './PayslipViewer';
import PayrollForm16 from './PayrollForm16';
import PayrollForm24Q from './PayrollForm24Q';
import PayrollOverview from '../components/payroll/PayrollOverview';
import { SECTIONS, resolvePayrollTab, visibleViews } from '../components/payroll/payrollCenterTabs';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import './PayrollCenter.css';

/**
 * Payroll Center — the one Payroll destination (HR → Payroll Center).
 *
 * Six sections in workflow order. The pages behind them are the same
 * components that used to be seven flat tabs; nothing is re-implemented here,
 * and every API call and server-side gate is the page's own. Two sections hold
 * two pages each, switched with `?view=`:
 *   Payslips  — Payslip Generator (preview / distribute) · Payslip Viewer
 *   Tax       — Form 16 / Form No. 130 · Form 138 / Form 24Q
 *
 * Each page is rendered `embedded`: it drops its own hero, and `.plh-tabpanel`
 * un-freezes any nested dock so it cannot sit over this tab strip (§148).
 *
 * Deep links: `?tab=` takes the section ids in payrollCenterTabs.js, and the
 * old tab ids (payroll, structure, generate, view, form16, form24q) still
 * resolve through its LEGACY_TABS. The standalone page keys (/Payroll,
 * /SalaryStructure, …) are redirected here by Layout.jsx — see
 * PAYROLL_HUB_PAGES in menuCatalog.js.
 * PayslipViewer stays a standalone page as well: it is My Payslip for every
 * employee.
 */
export default function PayrollCenter({ setPage }) {
  const [sp, setSp] = useSearchParams();
  const { hasPermission } = useAuth();
  const allowed = (module, action) => typeof hasPermission === 'function' && hasPermission(module, action);
  const { section, view } = resolvePayrollTab(sp.get('tab'), sp.get('view'), allowed);
  const current = SECTIONS.find(s => s.id === section);
  const views = visibleViews(current, allowed);

  const go = (id, v) => {
    const next = { tab: id };
    if (v) next.view = v;
    setSp(next, { replace: true });
  };

  const body = () => {
    switch (section) {
      case 'overview':   return <PayrollOverview go={go} />;
      case 'processing': return <Payroll embedded setPage={setPage} />;
      case 'structures': return <SalaryStructure embedded />;
      case 'payslips':   return view === 'viewer' ? <PayslipViewer embedded setPage={setPage} /> : <PayslipGenerator embedded />;
      case 'statutory':  return view === 'form138' ? <PayrollForm24Q embedded setPage={setPage} /> : <PayrollForm16 embedded setPage={setPage} />;
      case 'settings':   return <PayrollSettings embedded setPage={setPage} />;
      default:           return null;
    }
  };

  return (
    <PageShell dock={
      <>
        <PageHero
          icon={Wallet}
          eyebrow="Human Resources"
          title="Payroll Center"
          subtitle="Settings → structures → processing → payslips → statutory returns"
        />
        <div className="pc-tabs" role="tablist" aria-label="Payroll Center sections">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={section === id}
              className={`pc-tab${section === id ? ' is-on' : ''}`}
              onClick={() => go(id)}
            >
              <Icon size={14} aria-hidden="true" />{label}
            </button>
          ))}
        </div>
      </>
    }>
      {views.length > 1 && (
        <div className="pc-views" role="tablist" aria-label={`${current.label} views`}>
          {views.map(v => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={`pc-view${view === v.id ? ' is-on' : ''}`}
              onClick={() => go(section, v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      )}
      <div className="plh-tabpanel pc-panel" role="tabpanel">
        {body()}
      </div>
    </PageShell>
  );
}
