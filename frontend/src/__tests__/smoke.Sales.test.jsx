import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// ── CSS mocks ─────────────────────────────────────────────────────────────────
vi.mock('../features/sales/pages/Quotations.css',   () => ({}));
vi.mock('../features/sales/pages/SalesOrders.css',  () => ({}));

// ── React Router mock (SalesForecasts uses Link/navigate) ─────────────────────
// useParams/useSearchParams are stubbed too: without them every Quotations and
// SalesOrders test failed on "No useParams export is defined on the mock" — the
// pages reach router state through a shared component, not directly.
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null }),
  Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>,
}));

// ── API + context mocks ───────────────────────────────────────────────────────
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

// ── Auth context mock (SalesPartners gates its toolbar on hasPermission) ──────
// Grants everything: these are render smoke tests, not permission tests, and the
// real useAuth throws outside <AuthProvider>.
//
// menuAccess must be here even though no test asserts on it: Quotations and
// SalesOrders call usePageAccess(), which reads menuAccess() off this same
// context. Returning null means "no override / default access".
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 3, company_id: 1 },
    hasPermission: () => true,
    hasAnyRole: () => true,
    menuAccess: () => null,
  }),
}));

// ── Recharts mock (uses ResizeObserver not available in jsdom) ────────────────
vi.mock('recharts', () => ({
  LineChart:         ({ children }) => <>{children}</>,
  BarChart:          ({ children }) => <>{children}</>,
  PieChart:          ({ children }) => <>{children}</>,
  ResponsiveContainer: ({ children }) => <div style={{ width: 400, height: 300 }}>{children}</div>,
  Line: () => null, Bar: () => null, Pie: () => null, Cell: () => null,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null,
  Tooltip: () => null, Legend: () => null,
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import api from '../services/api/client';

import Quotations          from '../features/sales/pages/Quotations';
import SalesOrders         from '../features/sales/pages/SalesOrders';
import SalesTargets        from '../features/sales/pages/SalesTargets';
import SalesForecasts      from '../features/sales/pages/SalesForecasts';
import FulfilmentTracking  from '../features/sales/pages/FulfilmentTracking';
import Competitors         from '../features/sales/pages/Competitors';
import Territories         from '../features/sales/pages/Territories';
import SalesPartners       from '../features/sales/pages/SalesPartners';
import SalesPlaybooks      from '../features/sales/pages/SalesPlaybooks';
import SalesCalendar       from '../features/sales/pages/SalesCalendar';
import SalesDocuments      from '../features/sales/pages/SalesDocuments';
import Subscriptions       from '../features/sales/pages/Subscriptions';
import CommissionManagement from '../features/sales/pages/CommissionManagement';
import PricingEngine       from '../features/sales/pages/PricingEngine';

// ── Shared API stub ──────────────────────────────────────────────────────────
function stubApi(overrides = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/sales/quotations')               return Promise.resolve({ data: overrides.quotations    ?? [] });
    if (url === '/sales/quotations/next-number')   return Promise.resolve({ data: { number: 'QT-001' } });
    if (url.startsWith('/finance/parties'))        return Promise.resolve({ data: overrides.customers    ?? [] });
    if (url === '/inventory/items')                return Promise.resolve({ data: [] });
    if (url === '/sales/orders')                   return Promise.resolve({ data: { data: overrides.orders ?? [] } });
    if (url === '/sales/orders/next-number')       return Promise.resolve({ data: { number: 'SO-001' } });
    if (url === '/sales/targets')                        return Promise.resolve({ data: overrides.targets      ?? [] });
    if (url.startsWith('/sales/forecasts/summary'))      return Promise.resolve({ data: overrides.forecastSummary   ?? { forecasted: 0, achieved: 0, target: 0, achievement_pct: null } });
    if (url.startsWith('/sales/forecasts/by-month'))     return Promise.resolve({ data: overrides.forecastByMonth   ?? [] });
    if (url.startsWith('/sales/forecasts/by-rep'))       return Promise.resolve({ data: overrides.forecastByRep     ?? [] });
    if (url.startsWith('/sales/forecasts/pipeline-breakdown')) return Promise.resolve({ data: overrides.forecastPipeline ?? [] });
    if (url === '/sales/credit-limits')            return Promise.resolve({ data: overrides.creditLimits ?? [] });
    if (url === '/sales/fulfilment-rate')          return Promise.resolve({ data: null });
    if (url === '/sales/delivery-performance')     return Promise.resolve({ data: [] });
    if (url === '/sales/competitors')              return Promise.resolve({ data: overrides.competitors  ?? [] });
    if (url.startsWith('/sales/territories'))      return Promise.resolve({ data: overrides.territories  ?? [] });
    // The partner grid is paginated, so it returns an envelope rather than a bare
    // array — /filters and /:id/leads under the same prefix have their own shapes.
    if (url === '/sales/partners/filters')         return Promise.resolve({ data: overrides.partnerFilters ?? { association_types: ['System Integrator', 'Partner'], statuses: ['active'], states: [], cities: [] } });
    if (url.startsWith('/sales/partners'))         return Promise.resolve({ data: { data: overrides.partners ?? [], total: (overrides.partners ?? []).length, page: 1, page_size: 20, total_pages: 1 } });
    if (url.startsWith('/sales/playbooks'))        return Promise.resolve({ data: { data: overrides.playbooks ?? [] } });
    if (url.startsWith('/sales/activities'))       return Promise.resolve({ data: overrides.activities   ?? [] });
    if (url.startsWith('/sales/documents'))        return Promise.resolve({ data: overrides.documents    ?? [] });
    if (url.startsWith('/sales/subscriptions'))    return Promise.resolve({ data: overrides.subscriptions ?? [] });
    if (url === '/commissions/plans')              return Promise.resolve({ data: overrides.commissionPlans ?? [] });
    if (url === '/pricing/price-lists')            return Promise.resolve({ data: overrides.priceLists   ?? [] });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => vi.clearAllMocks());

// ── Quotations ─────────────────────────────────────────────────────────────────
describe('Quotations — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Quotations setPage={() => {}} />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Sales Quotations" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Quotations setPage={() => {}} />);
    expect(screen.getByText('Sales Quotations')).toBeDefined();
  });

  it('renders "New Quotation" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Quotations setPage={() => {}} />);
    expect(screen.getByText('New Quotation')).toBeDefined();
  });

  it('renders all 5 KPI card labels', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Quotations setPage={() => {}} />);
    ['Total Quotations', 'Accepted', 'Sent / Pending', 'Total Value', 'Acceptance Rate'].forEach(label =>
      expect(screen.getAllByText(label)[0]).toBeDefined()
    );
  });

  it('shows empty state when no quotations', async () => {
    stubApi();
    render(<Quotations setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('No quotations yet.')).toBeDefined());
  });

  it('renders table rows when quotations are loaded', async () => {
    stubApi({ quotations: [
      { id: 1, quotation_number: 'QT-0001', customer_name: 'Infosys Ltd', quotation_date: '2026-01-01', validity_date: '2026-02-01', total_amount: 285000, status: 'sent', version: 1, total_revisions: 1 },
    ]});
    render(<Quotations setPage={() => {}} />);
    await waitFor(() => expect(screen.getByText('Infosys Ltd')).toBeDefined());
    expect(screen.getByText('QT-0001')).toBeDefined();
  });
});

// ── SalesOrders ────────────────────────────────────────────────────────────────
describe('SalesOrders — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesOrders />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Sales Orders" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesOrders />);
    expect(screen.getByRole('heading', { name: 'Sales Orders' })).toBeDefined();
  });

  it('renders "New Order" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesOrders />);
    expect(screen.getByText('New Order')).toBeDefined();
  });

  it('renders tab buttons (Sales Orders, By Customer)', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesOrders />);
    expect(screen.getAllByText('Sales Orders').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('By Customer')).toBeDefined();
  });

  it('renders status filter tabs', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesOrders />);
    expect(screen.getAllByText('All').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('draft')).toBeDefined();
    expect(screen.getByText('confirmed')).toBeDefined();
  });

  it('shows empty state when no orders', async () => {
    stubApi();
    render(<SalesOrders />);
    await waitFor(() => expect(screen.getByText('No sales orders yet.')).toBeDefined());
  });

  it('renders order rows when orders are loaded', async () => {
    stubApi({ orders: [
      { id: 1, order_number: 'SO-0001', customer_name: 'Wipro Technologies', order_date: '2026-01-01', delivery_date: '2026-01-20', total_amount: 142000, status: 'confirmed' },
    ]});
    render(<SalesOrders />);
    await waitFor(() => expect(screen.getByText('Wipro Technologies')).toBeDefined());
    expect(screen.getByText('SO-0001')).toBeDefined();
  });
});

// ── SalesTargets ───────────────────────────────────────────────────────────────
describe('SalesTargets — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesTargets />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Sales Targets" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesTargets />);
    expect(screen.getByText('Sales Targets')).toBeDefined();
  });

  it('renders "Set Target" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesTargets />);
    expect(screen.getByText('Team Target')).toBeDefined();
  });

  it('renders all 3 KPI card labels', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesTargets />);
    expect(screen.getByText('Total Target')).toBeDefined();
    expect(screen.getByText('Total Achieved')).toBeDefined();
    expect(screen.getByText('Team Achievement')).toBeDefined();
  });

  it('shows empty state when no targets', async () => {
    stubApi();
    render(<SalesTargets />);
    await waitFor(() => expect(screen.getByText(/No targets set/i)).toBeDefined());
  });

  it('renders target rows when data is loaded', async () => {
    stubApi({ targets: [
      { id: 1, owner_name: 'Vikram Singh', target_amount: 2000000, achieved_amount: 1640000 },
    ]});
    render(<SalesTargets />);
    await waitFor(() => expect(screen.getByText('Vikram Singh')).toBeDefined());
  });
});

// ── SalesForecasts ─────────────────────────────────────────────────────────────
describe('SalesForecasts — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesForecasts />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Sales Forecasts" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesForecasts />);
    expect(screen.getByText('Sales Forecasts')).toBeDefined();
  });

  it('renders KPI labels (Total Forecasted, Total Achieved)', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesForecasts />);
    expect(screen.getByText('Total Forecasted')).toBeDefined();
    expect(screen.getByText('Total Achieved')).toBeDefined();
  });

  it('shows empty state when no forecast data', async () => {
    stubApi();
    render(<SalesForecasts />);
    await waitFor(() =>
      expect(screen.getByText('No opportunities with close dates in this period.')).toBeDefined()
    );
  });
});

// ── FulfilmentTracking ─────────────────────────────────────────────────────────
describe('FulfilmentTracking — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<FulfilmentTracking />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Fulfilment & Credit Control" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<FulfilmentTracking />);
    expect(screen.getByText('Fulfilment & Credit Control')).toBeDefined();
  });

  it('renders all three tab buttons', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<FulfilmentTracking />);
    expect(screen.getByText('Delivery Orders')).toBeDefined();
    expect(screen.getByText('Credit Control')).toBeDefined();
    expect(screen.getByText('Fulfilment Analytics')).toBeDefined();
  });

  it('shows empty state on Delivery Orders tab when no orders', async () => {
    stubApi();
    render(<FulfilmentTracking />);
    await waitFor(() =>
      expect(screen.getByText('No confirmed or dispatched orders to display.')).toBeDefined()
    );
  });

  it('switches to Credit Control tab on click', async () => {
    stubApi();
    render(<FulfilmentTracking />);
    await waitFor(() => screen.getByText('Credit Control'));
    fireEvent.click(screen.getByText('Credit Control'));
    await waitFor(() => expect(screen.getByText('No customers found.')).toBeDefined());
  });
});

// ── Competitors ────────────────────────────────────────────────────────────────
describe('Competitors — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Competitors />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Competitors" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Competitors />);
    expect(screen.getByText('Competitors')).toBeDefined();
  });

  it('renders "Add Competitor" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Competitors />);
    expect(screen.getByText('Add Competitor')).toBeDefined();
  });

  it('renders search input', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Competitors />);
    expect(screen.getByPlaceholderText('Search competitors...')).toBeDefined();
  });

  it('shows empty state when no competitors', async () => {
    stubApi();
    render(<Competitors />);
    await waitFor(() => expect(screen.getByText('No competitors tracked yet')).toBeDefined());
  });

  it('renders competitor rows when data loads', async () => {
    stubApi({ competitors: [
      { id: 1, name: 'RivalCorp', market_segment: 'Enterprise', threat_level: 'High' },
    ]});
    render(<Competitors />);
    await waitFor(() => expect(screen.getByText('RivalCorp')).toBeDefined());
  });
});

// ── Territories ────────────────────────────────────────────────────────────────
describe('Territories — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Territories />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Sales Territories" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Territories />);
    expect(screen.getByText('Sales Territories')).toBeDefined();
  });

  it('renders "Add Territory" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Territories />);
    expect(screen.getByText('Add Territory')).toBeDefined();
  });

  it('shows empty state when no territories', async () => {
    stubApi();
    render(<Territories />);
    await waitFor(() => expect(screen.getByText('No territories defined')).toBeDefined());
  });
});

// ── SalesPartners (IPU master grid) ────────────────────────────────────────────
describe('SalesPartners — smoke', () => {
  const partner = {
    id: 1, ipu_number: 'IPU-00001', name: 'Acme Integrators',
    association_type: 'System Integrator', email: 'hi@acme.com', phone: '+91 80 1234',
    website: 'acme.com', city: 'Bengaluru', state: 'Karnataka', country: 'India',
    gstin: '29AAAAA0000A1Z5', status: 'active', lead_count: 2,
  };

  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesPartners />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows the "Partners" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesPartners />);
    expect(screen.getByText('Partners')).toBeDefined();
  });

  it('renders the toolbar actions', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesPartners />);
    ['New', 'Edit', 'View Leads', 'Convert to Partner', 'Columns', 'Excel', 'PDF']
      .forEach(label => expect(screen.getByText(label)).toBeDefined());
  });

  it('shows empty state when no partners', async () => {
    stubApi();
    render(<SalesPartners />);
    await waitFor(() => expect(screen.getByText('No partners found')).toBeDefined());
  });

  it('renders the checklist columns', async () => {
    stubApi({ partners: [partner] });
    render(<SalesPartners />);
    await waitFor(() => expect(screen.getByText('IPU-00001')).toBeDefined());
    ['IPU ID', 'Partner Name', 'Association Type', 'Email', 'Contact', 'Website',
      'City', 'State', 'Country', 'GSTIN']
      .forEach(label => expect(screen.getByText(label)).toBeDefined());
  });

  it('renders partner row data including GSTIN', async () => {
    stubApi({ partners: [partner] });
    render(<SalesPartners />);
    await waitFor(() => expect(screen.getByText('Acme Integrators')).toBeDefined());
    expect(screen.getByText('29AAAAA0000A1Z5')).toBeDefined();
    // "System Integrator" is both the row's badge and an option in the association
    // filter, so match the set rather than a single node.
    expect(screen.getAllByText('System Integrator').length).toBeGreaterThan(0);
  });

  // The header suppression SalesMarket relies on for its Partners tab.
  it('hides its own heading when embedded', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesPartners embedded />);
    expect(screen.queryByText('Partner master (IPU)')).toBeNull();
  });
});

// ── SalesPlaybooks ─────────────────────────────────────────────────────────────
describe('SalesPlaybooks — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesPlaybooks />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Sales Playbooks" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesPlaybooks />);
    expect(screen.getByText('Sales Playbooks')).toBeDefined();
  });

  it('renders "New Playbook" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesPlaybooks />);
    expect(screen.getByText('New Playbook')).toBeDefined();
  });

  it('shows empty state when no playbooks', async () => {
    stubApi();
    render(<SalesPlaybooks />);
    await waitFor(() => expect(screen.getByText('No playbooks yet. Create your first sales playbook.')).toBeDefined());
  });

  it('renders playbook cards when data loads', async () => {
    stubApi({ playbooks: [
      { id: 1, name: 'Enterprise Outreach', category: 'Prospecting', description: 'Best practices for enterprise leads' },
    ]});
    render(<SalesPlaybooks />);
    await waitFor(() => expect(screen.getByText('Enterprise Outreach')).toBeDefined());
  });
});

// ── SalesCalendar ──────────────────────────────────────────────────────────────
describe('SalesCalendar — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesCalendar />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Sales Calendar" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesCalendar />);
    expect(screen.getByText('Sales Calendar')).toBeDefined();
  });

  it('renders all 7 day-of-week headers', async () => {
    stubApi();
    render(<SalesCalendar />);
    await waitFor(() => {
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(d =>
        expect(screen.getByText(d)).toBeDefined()
      );
    });
  });

  it('renders previous and next navigation buttons', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesCalendar />);
    const btns = screen.getAllByRole('button');
    expect(btns.length).toBeGreaterThanOrEqual(2);
  });

  it('displays current month and year', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesCalendar />);
    const now = new Date();
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    expect(screen.getByText(`${MONTHS[now.getMonth()]} ${now.getFullYear()}`)).toBeDefined();
  });
});

// ── SalesDocuments ─────────────────────────────────────────────────────────────
describe('SalesDocuments — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesDocuments />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Sales Documents" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesDocuments />);
    expect(screen.getByText('Sales Documents')).toBeDefined();
  });

  it('renders "Upload Document" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<SalesDocuments />);
    expect(screen.getByText('Upload Document')).toBeDefined();
  });

  it('shows empty state when no documents', async () => {
    stubApi();
    render(<SalesDocuments />);
    await waitFor(() =>
      expect(screen.getByText('No documents found. Upload proposals, contracts, and more here.')).toBeDefined()
    );
  });
});

// ── Subscriptions ──────────────────────────────────────────────────────────────
describe('Subscriptions — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Subscriptions />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Subscriptions" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Subscriptions />);
    expect(screen.getByText('Subscriptions')).toBeDefined();
  });

  it('renders "+ New Subscription" button', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Subscriptions />);
    expect(screen.getByRole('button', { name: /New Subscription/ })).toBeDefined();
  });

  it('shows empty state when no subscriptions', async () => {
    stubApi();
    render(<Subscriptions />);
    await waitFor(() => expect(screen.getByText(/No subscriptions found/i)).toBeDefined());
  });

  it('renders subscription rows when data loads', async () => {
    stubApi({ subscriptions: [
      { id: 1, customer_name: 'Acme Corp', plan_name: 'Enterprise', billing_cycle: 'Annual', monthly_value: 120000, status: 'Active' },
    ]});
    render(<Subscriptions />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeDefined());
    expect(screen.getByText('Enterprise')).toBeDefined();
  });
});

// ── CommissionManagement ───────────────────────────────────────────────────────
describe('CommissionManagement — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<CommissionManagement />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Commission Management" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<CommissionManagement />);
    expect(screen.getByText('Commission Management')).toBeDefined();
  });

  it('renders all four tab buttons', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<CommissionManagement />);
    ['Plans', 'Statements', 'Payouts', 'Leaderboard'].forEach(tab =>
      expect(screen.getByText(tab)).toBeDefined()
    );
  });

  it('shows Commission Plans sub-heading on default tab', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<CommissionManagement />);
    expect(screen.getByRole('heading', { name: 'Commission Plans' })).toBeDefined();
  });

  it('shows empty state in Plans tab when no plans', async () => {
    stubApi();
    render(<CommissionManagement />);
    await waitFor(() =>
      expect(screen.getByText('No commission plans yet. Create the first one.')).toBeDefined()
    );
  });
});

// ── PricingEngine ──────────────────────────────────────────────────────────────
describe('PricingEngine — smoke', () => {
  it('renders without crashing', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<PricingEngine />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('shows "Pricing Engine" heading', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<PricingEngine />);
    expect(screen.getByText('Pricing Engine')).toBeDefined();
  });

  it('renders all five tab buttons', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<PricingEngine />);
    ['Price Lists', 'Discount Rules', 'Promotions', 'Approvals', 'Price History'].forEach(tab =>
      expect(screen.getAllByText(tab).length).toBeGreaterThanOrEqual(1)
    );
  });

  it('renders "+ New Price List" button on default tab', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<PricingEngine />);
    expect(screen.getByText('+ New Price List')).toBeDefined();
  });

  it('renders KPI cards on Price Lists tab', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<PricingEngine />);
    expect(screen.getByText('Total Price Lists')).toBeDefined();
    expect(screen.getByText('Default List')).toBeDefined();
    expect(screen.getByText('Active Lists')).toBeDefined();
  });
});
