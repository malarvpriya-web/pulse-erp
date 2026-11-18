/**
 * Button Audit Smoke Tests
 * Verifies that previously-dead buttons now have real actions.
 * One describe block per fixed button / module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── API mock ──────────────────────────────────────────────────────────────────
vi.mock('../services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// ── Auth context mock (needed by LearningDevelopment) ─────────────────────────
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { employee_id: 7, id: 3, company_id: 1 } }),
}));

// ── Toast context mock ────────────────────────────────────────────────────────
vi.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

// ── FY context mock (needed by GSTModule) ─────────────────────────────────────
// GSTModule reads getMonthsInFY()/fyLabel and useFY() throws outside <FYProvider>,
// which failed the whole GSTModule block. One month keeps the GSTR tables small.
vi.mock('../context/FYContext', () => ({
  useFY: () => ({
    fyLabel: 'FY 2025-26',
    getMonthsInFY: () => ([
      { month: 'Apr 2025', startStr: '2025-04-01', endStr: '2025-04-30' },
    ]),
  }),
}));

// ── Recharts mock ─────────────────────────────────────────────────────────────
vi.mock('recharts', () => ({
  BarChart: ({ children }) => <>{children}</>,
  PieChart: ({ children }) => <>{children}</>,
  LineChart: ({ children }) => <>{children}</>,
  ResponsiveContainer: ({ children }) => <div style={{ width: 400, height: 300 }}>{children}</div>,
  Bar: () => null, Pie: () => null, Line: () => null, Cell: () => null,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null,
  Tooltip: () => null, Legend: () => null,
}));

import api from '../services/api/client';

// ── Imports ───────────────────────────────────────────────────────────────────
import SalesDocuments    from '../features/sales/pages/SalesDocuments';
import GSTModule         from '../features/finance/pages/GSTModule';
import CRMEmail          from '../features/crm/pages/CRMEmail';
import LearningDevelopment from '../features/hr/pages/LearningDevelopment';

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ data: [] });
  api.post.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

// ── 1. SalesDocuments — Upload Document button ────────────────────────────────
describe('SalesDocuments — Upload Document button', () => {
  it('renders the Upload Document button', () => {
    render(<SalesDocuments />);
    expect(screen.getByText('Upload Document')).toBeDefined();
  });

  it('clicking Upload Document opens the upload modal', async () => {
    render(<SalesDocuments />);
    fireEvent.click(screen.getByText('Upload Document'));
    await waitFor(() => expect(screen.getByText('Add Document')).toBeDefined());
  });

  it('upload modal has Document Name, Type, Customer Name, File URL fields', async () => {
    render(<SalesDocuments />);
    fireEvent.click(screen.getByText('Upload Document'));
    await waitFor(() => {
      expect(screen.getByText('Document Name *')).toBeDefined();
      expect(screen.getByText('Type')).toBeDefined();
      expect(screen.getByText('Customer')).toBeDefined();
      expect(screen.getByText('File URL')).toBeDefined();
    });
  });

  it('upload modal has Save Document and Cancel buttons', async () => {
    render(<SalesDocuments />);
    fireEvent.click(screen.getByText('Upload Document'));
    await waitFor(() => {
      expect(screen.getByText('Save')).toBeDefined();
      expect(screen.getByText('Cancel')).toBeDefined();
    });
  });

  it('submitting upload modal calls POST /sales/documents', async () => {
    api.post.mockResolvedValue({ data: { id: 1, name: 'Test Doc', type: 'Proposal' } });
    render(<SalesDocuments />);
    fireEvent.click(screen.getByText('Upload Document'));
    await waitFor(() => screen.getByText('Add Document'));

    fireEvent.change(screen.getByPlaceholderText('e.g. Client Proposal Q2'), { target: { value: 'Test Doc' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/sales/documents', expect.objectContaining({ name: 'Test Doc' })));
  });

  it('Cancel button closes the upload modal', async () => {
    render(<SalesDocuments />);
    fireEvent.click(screen.getByText('Upload Document'));
    await waitFor(() => screen.getByText('Add Document'));
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Add Document')).toBeNull());
  });
});

// ── 2. GSTModule — JSON button ─────────────────────────────────────────
describe('GSTModule — JSON button', () => {
  beforeEach(() => {
    api.get.mockImplementation((url) => {
      if (url.includes('/gst/gstr')) return Promise.resolve({ data: { summary: { b2b_invoices: 5 }, b2b: [] } });
      if (url.includes('/gst/gstr2')) return Promise.resolve({ data: { summary: {}, b2b: [] } });
      if (url.includes('/gst/gst-summary')) return Promise.resolve({ data: {} });
      if (url.includes('/gst/reconciliation')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
  });

  it('renders the JSON button', async () => {
    render(<GSTModule />);
    await waitFor(() => expect(screen.getByText('JSON')).toBeDefined());
  });

  it('JSON button is enabled after data loads', async () => {
    render(<GSTModule />);
    await waitFor(() => {
      const btn = screen.getByText('JSON').closest('button');
      expect(btn.disabled).toBe(false);
    });
  });

  it('clicking JSON triggers a download (URL.createObjectURL called)', async () => {
    const createObjectURL = vi.fn(() => 'blob:fake');
    const revokeObjectURL = vi.fn();
    const clickMock = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = origCreate(tag);
      if (tag === 'a') el.click = clickMock;
      return el;
    });

    render(<GSTModule />);
    await waitFor(() => screen.getByText('JSON'));
    fireEvent.click(screen.getByText('JSON'));

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickMock).toHaveBeenCalled();

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

// ── 3. CRMEmail — Forward, Sequence Edit & Delete ────────────────────────────
describe('CRMEmail — dead button fixes', () => {
  const mockEmail = {
    id: 1, subject: 'Hello', from_email: 'vendor@example.com',
    to_emails: ['me@company.com'], direction: 'inbound',
    body_text: 'Body text here.', sent_at: new Date().toISOString(),
  };

  const mockSequence = {
    id: 10, name: 'Nurture Flow', trigger_stage: 'Prospecting',
    steps: [{ day_offset: 0, template_id: '' }],
    enrolled_count: 2, is_active: true, step_count: 1,
  };

  beforeEach(() => {
    api.get.mockImplementation((url) => {
      if (url === '/crm/emails') return Promise.resolve({ data: { data: [mockEmail] } });
      if (url === '/crm/email-templates') return Promise.resolve({ data: { data: [] } });
      if (url === '/crm/email-sequences') return Promise.resolve({ data: { data: [mockSequence] } });
      if (url === '/crm/email-analytics') return Promise.resolve({ data: { data: null } });
      if (url === '/crm/email-accounts') return Promise.resolve({ data: { data: [{ id: 1, email_address: 'test@company.com', sync_status: 'synced', display_name: 'Test' }] } });
      return Promise.resolve({ data: { data: [] } });
    });
  });

  it('renders without crashing', () => {
    render(<CRMEmail />);
    expect(document.body.firstChild).not.toBeNull();
  });

  it('navigating to Sequences tab shows Edit and Delete buttons', async () => {
    render(<CRMEmail />);
    fireEvent.click(screen.getByText(/Sequences/, { selector: 'span' }));
    await waitFor(() => {
      expect(screen.getByText('Nurture Flow')).toBeDefined();
      expect(screen.getByText('Edit')).toBeDefined();
      expect(screen.getByText('Delete')).toBeDefined();
    });
  });

  it('clicking Edit on a sequence opens the SequenceDrawer in edit mode', async () => {
    render(<CRMEmail />);
    fireEvent.click(screen.getByText(/Sequences/, { selector: 'span' }));
    await waitFor(() => screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Edit'));
    await waitFor(() => expect(screen.getByText('Edit Sequence')).toBeDefined());
  });

  // Deleting a sequence goes through ConfirmDialog, not window.confirm — this
  // page moved off the native dialog in the alert()->ConfirmDialog cleanup, so
  // the old window.confirm spy meant the DELETE never fired and the test failed.
  it('clicking Delete on a sequence opens ConfirmDialog and does not delete yet', async () => {
    api.delete.mockResolvedValue({ data: {} });
    render(<CRMEmail />);
    fireEvent.click(screen.getByText(/Sequences/, { selector: 'span' }));
    await waitFor(() => screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined());
    expect(screen.getByText('Delete Sequence')).toBeDefined();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('confirming the dialog calls the DELETE API', async () => {
    api.delete.mockResolvedValue({ data: {} });
    render(<CRMEmail />);
    fireEvent.click(screen.getByText(/Sequences/, { selector: 'span' }));
    await waitFor(() => screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Delete'));

    // The row button and the dialog's confirm button share the label "Delete" —
    // scope to the dialog so this clicks the confirm, not the row again.
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Delete'));

    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith('/crm/email-sequences/10')
    );
  });

  it('cancelling the dialog does not delete', async () => {
    api.delete.mockResolvedValue({ data: {} });
    render(<CRMEmail />);
    fireEvent.click(screen.getByText(/Sequences/, { selector: 'span' }));
    await waitFor(() => screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Delete'));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Cancel'));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('Forward button is present in email detail when email is selected', async () => {
    render(<CRMEmail />);
    // Select the email in the inbox panel
    await waitFor(() => screen.getByText('Hello'));
    fireEvent.click(screen.getByText('Hello'));
    await waitFor(() => expect(screen.getByText('Forward')).toBeDefined());
  });

  it('clicking Forward opens ComposeDrawer with Fwd: prefilled subject', async () => {
    render(<CRMEmail />);
    await waitFor(() => screen.getByText('Hello'));
    fireEvent.click(screen.getByText('Hello'));
    await waitFor(() => screen.getByText('Forward'));
    fireEvent.click(screen.getByText('Forward'));
    await waitFor(() => {
      const subjectInput = screen.getByPlaceholderText('Email subject');
      expect(subjectInput.value).toContain('Fwd:');
    });
  });
});

// ── 4. Trainings (LearningDevelopment) — open a training, enrol, complete ──
// Rewritten 2026-11-18 with the Learning Center consolidation: HR enrols the
// people they pick (not themselves) and completion goes through a dialog.
describe('Trainings — open, enrol and complete', () => {
  const _now = new Date();
  const month = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}`;
  const program = {
    id: 5, title: 'React Workshop', category: 'Technical', trainer_name: 'Alice', mode: 'online', duration_hours: 8,
    max_participants: 20, scheduled_date: `${month}-15`, end_date: null, status: 'ongoing', enrolled_count: 1, completed_count: 0, total_cost: 0,
  };
  const detail = { ...program, enrollments: [{ id: 99, employee_id: 8, employee_name: 'Bala', status: 'enrolled', enrolled_via: 'hr' }],
    costs: [], sessions: [], rounds: [{ id: 5, status: 'ongoing', scheduled_date: program.scheduled_date }], assessments: [] };

  beforeEach(() => {
    api.get.mockImplementation((url) => {
      if (url.startsWith('/training/programs/5')) return Promise.resolve({ data: detail });
      if (url.startsWith('/training/programs')) return Promise.resolve({ data: [program] });
      if (url === '/training/employees') return Promise.resolve({ data: [{ id: 7, name: 'Asha' }, { id: 8, name: 'Bala' }] });
      return Promise.resolve({ data: [] });
    });
  });
  const renderPage = (path = '/LearningDevelopment') => render(<MemoryRouter initialEntries={[path]}><LearningDevelopment /></MemoryRouter>);

  it('renders the Trainings page with the training on the calendar', async () => {
    renderPage();
    expect(screen.getByText('Trainings')).toBeDefined();
    await waitFor(() => expect(screen.getByTitle('React Workshop')).toBeDefined());
  });

  it('opening a training and enrolling picked employees posts their ids', async () => {
    api.post.mockResolvedValue({ data: { enrolled: [7], skipped: [], message: '1 enrolled' } });
    renderPage('/LearningDevelopment?program=5');
    await waitFor(() => expect(screen.getByText('+ Enrol employees')).toBeDefined());
    fireEvent.click(screen.getByText('+ Enrol employees'));
    await waitFor(() => expect(screen.getByText('Asha')).toBeDefined());
    fireEvent.click(screen.getByText('Asha'));
    fireEvent.click(screen.getByText(/^Enrol 1/));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/training/programs/5/enroll', { employee_ids: [7] }));
  });

  it('Complete marks the participant completed', async () => {
    api.put.mockResolvedValue({ data: {} });
    renderPage('/LearningDevelopment?program=5');
    await waitFor(() => expect(screen.getByText('Complete')).toBeDefined());
    fireEvent.click(screen.getByText('Complete'));
    fireEvent.click(screen.getByText('Mark completed'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/training/enrollments/99', { status: 'completed', score: null }));
  });
});
