import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// Mounts every page the 2026-09-16 navigation audit newly surfaced in the
// menu. All of them were already routed and built — they simply had no link
// anywhere in the app, so nobody had ever opened them and nothing would have
// caught a render-time crash. Adding a menu row without this is how a menu
// item becomes a link to a white screen.
//
// These are render smoke tests, not behaviour tests: every dependency is
// mocked permissively and the only assertion is "mounts without throwing".

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
  Link: ({ children, to, ...p }) => <a href={to} {...p}>{children}</a>,
}));

vi.mock('../services/api/client', () => ({
  default: {
    get:    vi.fn(() => Promise.resolve({ data: {} })),
    post:   vi.fn(() => Promise.resolve({ data: {} })),
    put:    vi.fn(() => Promise.resolve({ data: {} })),
    patch:  vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 1, company_id: 1, name: 'Test' },
    role: 'super_admin',
    roles: ['super_admin'],
    hasPermission: () => true,
    hasAnyRole: () => true,
    isEmployeeOnly: false,
    menuAccess: () => null,
  }),
}));

// Recharts needs ResizeObserver, which jsdom does not provide.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return { ...actual, ResponsiveContainer: ({ children }) => <div>{children}</div> };
});

// ── The pages ───────────────────────────────────────────────────────────────
// Performance: eight pages that were built, routed and role-gated but carried
// no link of any kind — no NAV row, no hub tab, no setPage call.
import CalibrationCenter    from '../features/performance/pages/CalibrationCenter';
import IncrementPlanning    from '../features/performance/pages/IncrementPlanning';
import KRAManagement        from '../features/performance/pages/KRAManagement';
import OKRManagement        from '../features/performance/pages/OKRManagement';
import PerformanceDashboard from '../features/performance/pages/PerformanceDashboard';
import PerformanceReports   from '../features/performance/pages/PerformanceReports';
import PromotionPlanning    from '../features/performance/pages/PromotionPlanning';
import ReviewCycleManager   from '../features/performance/pages/ReviewCycleManager';
// Recruitment: four pages reachable only through an unused barrel export.
import EmailTemplates       from '../features/recruitment/pages/EmailTemplates';
import EmployeeAutoCreation from '../features/recruitment/pages/EmployeeAutoCreation';
import HiringForecasts      from '../features/recruitment/pages/HiringForecasts';
import InterviewQuestionBank from '../features/recruitment/pages/InterviewQuestionBank';
// Statutory payroll outputs, now tabs of Payroll Center.
import PayrollForm16        from '../features/hr/pages/PayrollForm16';
import PayrollForm24Q       from '../features/hr/pages/PayrollForm24Q';
// One-offs, each previously unlinked.
import Pursuits             from '../features/crm/pages/Pursuits';
import SerialTracking       from '../features/inventory/pages/SerialTracking';
import EngineeringDev       from '../features/engineering/pages/EngineeringDev';
import TallyIntegration     from '../features/admin/pages/TallyIntegration';
import ApprovalCenter       from '../features/approvals/pages/ApprovalCenter';  // also serves the MyRequests page key
import TravelExpenses       from '../features/travel/pages/TravelExpenses';
import ProjectProfitability from '../features/projects/pages/ProjectProfitability';
// The personal dashboard that predates the role-aware Home. Surfaced at
// HR > My Dashboard; previously reachable only via global search.
import EmployeeDashboard   from '../pages/EmployeeDashboard';
// Gate passes and visitor management. /BiometricAccess redirected to
// AttendanceSettings?tab=devices, which renders DeviceManagement and covers
// none of this page's three tabs — so two features with live tables and routes
// had no reachable screen. Surfaced at HR > Gate Pass & Visitors.
import BiometricAccess     from '../features/hr/pages/BiometricAccess';

const PAGES = [
  ['CalibrationCenter',     CalibrationCenter],
  ['IncrementPlanning',     IncrementPlanning],
  ['KRAManagement',         KRAManagement],
  ['OKRManagement',         OKRManagement],
  ['PerformanceDashboard',  PerformanceDashboard],
  ['PerformanceReports',    PerformanceReports],
  ['PromotionPlanning',     PromotionPlanning],
  ['ReviewCycleManager',    ReviewCycleManager],
  ['EmailTemplates',        EmailTemplates],
  ['EmployeeAutoCreation',  EmployeeAutoCreation],
  ['HiringForecasts',       HiringForecasts],
  ['InterviewQuestionBank', InterviewQuestionBank],
  ['PayrollForm16',         PayrollForm16],
  ['PayrollForm24Q',        PayrollForm24Q],
  ['Pursuits',              Pursuits],
  ['SerialTracking',        SerialTracking],
  ['EngineeringDev',        EngineeringDev],
  ['TallyIntegration',      TallyIntegration],
  ['ApprovalCenter',        ApprovalCenter],
  ['TravelExpenses',        TravelExpenses],
  ['ProjectProfitability',  ProjectProfitability],
  ['EmployeeDashboard',     EmployeeDashboard],
  ['BiometricAccess',       BiometricAccess],
];

beforeEach(() => { cleanup(); });

describe('pages newly linked into the menu', () => {
  it.each(PAGES)('%s mounts without throwing', (_name, Page) => {
    expect(() => render(<Page setPage={vi.fn()} urlParams={{}} />)).not.toThrow();
  });

  it('every one of them is a real component, not an accidental barrel', () => {
    for (const [name, Page] of PAGES) {
      expect(typeof Page, `${name} default export`).toBe('function');
    }
  });
});
