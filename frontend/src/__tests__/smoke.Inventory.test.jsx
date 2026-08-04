import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ── CSS mocks ─────────────────────────────────────────────────────────────────
vi.mock('@/features/inventory/pages/StockMovements.css', () => ({}));
vi.mock('@/features/inventory/pages/ItemMaster.css',      () => ({}));

// ── React Router ──────────────────────────────────────────────────────────────
// PageHeader (components/pulse-ui) and usePageAccess both call useParams(), and
// PageHeader's breadcrumb "Home" crumb calls useNavigate() — mocking beats
// wrapping every render in a MemoryRouter, same rationale as smoke.leaves.test.jsx.
const { mockRouteState } = vi.hoisted(() => ({ mockRouteState: { page: 'Home' } }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ page: mockRouteState.page }),
}));

// ── API client ────────────────────────────────────────────────────────────────
vi.mock('@/services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// ── Auth / Toast contexts ────────────────────────────────────────────────────
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { userId: 1, id: 1, employee_id: 1, name: 'Admin', role: 'admin' },
    menuAccess: () => null, // no page-access override → readOnly === false everywhere
  }),
}));
vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

// QualityTestsPanel pulls in the whole quality feature's dependency tree —
// stub it, WarehouseManagement only conditionally renders it inside Inward QC.
vi.mock('@/features/quality/components/QualityTestsPanel', () => ({ default: () => null }));

import api from '@/services/api/client';
import StockMovements       from '@/features/inventory/pages/StockMovements.jsx';
import ItemMaster            from '@/features/inventory/pages/ItemMaster.jsx';
import WarehouseManagement   from '@/features/inventory/pages/WarehouseManagement.jsx';
import InventorySettings     from '@/features/inventory/pages/InventorySettings.jsx';

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: [] });
});

// ── StockMovements — full-rebuild reference ────────────────────────────────────

describe('StockMovements — smoke', () => {
  beforeEach(() => { mockRouteState.page = 'StockMovements'; });

  it('renders without crashing and shows the derived page title', async () => {
    render(<StockMovements />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Stock Movements' })).toBeDefined());
  });

  it('shows the empty state when there are no movements', async () => {
    render(<StockMovements />);
    await waitFor(() => expect(screen.getByText('No movements found')).toBeDefined());
  });

  it('shows the Stock Adjustment button (not read-only)', async () => {
    render(<StockMovements />);
    await waitFor(() => expect(screen.getByText('Stock Adjustment')).toBeDefined());
  });
});

// ── ItemMaster — richest "wrap" reference ──────────────────────────────────────

describe('ItemMaster — smoke', () => {
  beforeEach(() => { mockRouteState.page = 'ItemMaster'; });

  it('renders without crashing and shows the derived page title', async () => {
    render(<ItemMaster />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Item Master' })).toBeDefined());
  });

  it('shows the empty state when there are no items', async () => {
    render(<ItemMaster />);
    await waitFor(() => expect(screen.getByText('No items found')).toBeDefined());
  });

  it('shows the Add Item button and the column-picker toolbar control', async () => {
    render(<ItemMaster />);
    await waitFor(() => expect(screen.getByText('Add Item')).toBeDefined());
    expect(screen.getByText(/Columns/)).toBeDefined();
  });
});

// ── WarehouseManagement — light-touch, multi-tab wrap ──────────────────────────

describe('WarehouseManagement — smoke', () => {
  beforeEach(() => { mockRouteState.page = 'WarehouseManagement'; });

  it('renders without crashing and shows the derived page title', async () => {
    render(<WarehouseManagement />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Warehouse Management' })).toBeDefined());
  });

  it('renders all four tab buttons, defaulting to Bin Locations', async () => {
    render(<WarehouseManagement />);
    await waitFor(() => expect(screen.getByText('Bin Locations')).toBeDefined());
    ['Pick-Pack-Ship', 'Inward QC', 'Cycle Count'].forEach(tab =>
      expect(screen.getByText(tab)).toBeDefined()
    );
  });
});

// ── InventorySettings — regression guard: untouched, still owns its own shell ──

describe('InventorySettings — smoke (untouched by this pass)', () => {
  beforeEach(() => { mockRouteState.page = 'InventorySettings'; });

  it('renders without crashing via ModuleSettingsPanel', async () => {
    render(<InventorySettings />);
    await waitFor(() => expect(screen.getByText('General')).toBeDefined());
  });

  it('renders its own settings sections (not wrapped in PageHeader)', async () => {
    render(<InventorySettings />);
    await waitFor(() => expect(screen.getByText('Stock Rules')).toBeDefined());
    expect(screen.getByText('Valuation')).toBeDefined();
  });
});
