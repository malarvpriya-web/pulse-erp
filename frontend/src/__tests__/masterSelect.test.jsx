/**
 * masterSelect.test.jsx — the MasterSelect / VocabSelect contract (§172).
 *
 * WHY HERE AND NOT IN PLAYWRIGHT
 * ------------------------------
 * 23-master-data.spec.ts drives the integration claim — a value added on one
 * page reaches the other pages and Master Data Setup. What it CANNOT drive
 * deterministically is the component's own behaviour under inputs that happen
 * to exist in the database on a given day:
 *
 *   • whether a stored value the master does not hold is offered back
 *   • which of the two render modes a picker takes (that depends on how many
 *     rows the master currently has, so a browser test asserting one of them is
 *     asserting the seed data, not the component)
 *   • whether "+ Add new…" is hidden from a role the backend would 403
 *
 * Those are contracts, so they are pinned here with the inputs stated.
 *
 * THE BUG THIS FILE EXISTS FOR
 * ----------------------------
 * A <select> whose options come from a fixed array renders a stored value it
 * does not know about as BLANK, and the next save writes that blank back. It is
 * silent loss on a field nobody touched, and it is why four of the seven
 * industries in `accounts`, one project's type and every project issue's type
 * were unreachable before this work. The first case below is that one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

vi.mock('@/services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

// hasAnyRole is what hides "+ Add new…", so the suite drives it directly.
const { auth } = vi.hoisted(() => ({ auth: { roles: ['admin'] } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { userId: 1, name: 'Admin' },
    hasAnyRole: (...wanted) => wanted.some(r => auth.roles.includes(r)),
  }),
}));

import api from '@/services/api/client';
import MasterSelect from '@/components/core/MasterSelect';
import VocabSelect, { __resetVocabRegistry } from '@/components/core/VocabSelect';

const rows = (...names) => names.map((name, i) => ({ id: i + 1, name }));

/**
 * The combobox input, once the list has actually loaded.
 *
 * ⚠ getByRole('combobox') matches a <select> AS WELL AS role="combobox", and
 * MasterSelect renders a <select> on its first paint — rows arrive a tick later
 * and only then does it switch modes. A plain `waitFor(() => getByRole(...))`
 * therefore returns the SELECT, which React then discards; firing events at
 * that detached node does nothing and the failure reads as "the menu never
 * opened". Wait for the tag, not just the role.
 */
const comboInput = () =>
  waitFor(() => {
    const el = screen.getByRole('combobox');
    expect(el.tagName).toBe('INPUT');
    return el;
  });


/**
 * The "+ Add new..." form, which is a portalled MODAL as of 2026-09-29.
 *
 * ⚠ These two helpers exist because the ADD AFFORDANCE CHANGED, not because
 * anything below was wrong. It used to be an inline row that REPLACED the
 * picker (`if (adding) return <addRow/>`), located in tests by the input's
 * `title` attribute and a button reading "Save". It is now a dialog rendered
 * beside the picker, with a real <label> and a button reading "Add <thing>".
 *
 * The assertions in every case below are untouched — what is proven is still
 * "posts to the canonical endpoint, reloads, auto-selects, and reports the
 * server's own message". Only how the two controls are found has moved, so the
 * selectors are named once here rather than repeated five times.
 *
 * The change was made because a value created from a data-entry form must say
 * where it can be managed afterwards; the modal carries that line. It also
 * fixed a real defect the inline row had: swapping the control out of the form
 * made the field, its label and its required marker vanish mid-edit.
 */
const addDialog = () => screen.getByRole('dialog');
/**
 * The NAME field in the add dialog.
 *
 * ⚠ Anchored to "<Thing> Name", not just "<Thing>". A module vocabulary's modal
 * offers Name AND an optional Code, and both labels contain the noun — a bare
 * /Industry/i matches two inputs and getByLabelText throws.
 */
const addInput = (labelText) =>
  within(addDialog()).getByLabelText(new RegExp(`^${labelText} Name`, 'i'));
/** The optional code field, on the masters that have a `code` column. */
const addCodeInput = (labelText) =>
  within(addDialog()).queryByLabelText(new RegExp(`^${labelText} Code`, 'i'));
/** The dialog's submit button — "Add Industry", not "Save". */
const addSubmit = (label) => within(addDialog()).getByRole('button', { name: new RegExp(`add ${label}`, 'i') });

/** Enough rows to push MasterSelect past SEARCH_THRESHOLD (12). */
const manyRows = rows(...Array.from({ length: 15 }, (_, i) => `Option ${i + 1}`));

beforeEach(() => {
  vi.clearAllMocks();
  auth.roles = ['admin'];
  __resetVocabRegistry();
});

describe('a stored value the master does not hold', () => {
  it('is offered back as its own option, so it survives a round trip', async () => {
    api.get.mockResolvedValue({ data: rows('Technology', 'Manufacturing') });

    render(
      <MasterSelect endpoint="/master/v/industries" label="Industry"
        value="IT Services" onChange={() => {}} />
    );

    // Not in the master — but the record carries it, so the control must show
    // it selected rather than falling back to the first option.
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('IT Services');
    });
    expect(screen.getByRole('option', { name: 'IT Services' })).toBeInTheDocument();
  });

  it('does not add a phantom option when the value IS in the master', async () => {
    api.get.mockResolvedValue({ data: rows('Technology', 'Manufacturing') });

    render(
      <MasterSelect endpoint="/master/v/industries" label="Industry"
        value="Technology" onChange={() => {}} />
    );

    await waitFor(() => {
      expect(screen.getAllByRole('option', { name: 'Technology' })).toHaveLength(1);
    });
  });
});

describe('the "+ Add new…" option', () => {
  it('is offered to a role the backend accepts', async () => {
    api.get.mockResolvedValue({ data: rows('Technology') });
    render(<MasterSelect endpoint="/x" label="Industry" addRoles={['admin']} onChange={() => {}} />);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /add new industry/i })).toBeInTheDocument();
    });
  });

  it('is hidden from a role whose POST would come back 403', async () => {
    auth.roles = ['employee'];
    api.get.mockResolvedValue({ data: rows('Technology') });
    render(<MasterSelect endpoint="/x" label="Industry" addRoles={['admin']} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Technology' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /add new/i })).not.toBeInTheDocument();
  });

  it('is hidden on a FILTER picker even for an admin', async () => {
    // A filter narrows what is already there. Minting a value from one produces
    // a filter that matches nothing, with no explanation on screen.
    api.get.mockResolvedValue({ data: rows('Technology') });
    render(<MasterSelect endpoint="/x" label="Industry" allowAdd={false} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Technology' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /add new/i })).not.toBeInTheDocument();
  });
});

describe('adding a value', () => {
  it('posts it, reloads the list, selects it, and says so', async () => {
    api.get
      .mockResolvedValueOnce({ data: rows('Technology') })
      .mockResolvedValue({ data: rows('Technology', 'Marine') });
    api.post.mockResolvedValue({ data: { id: 9, name: 'Marine' } });

    const onChange = vi.fn();
    render(<MasterSelect endpoint="/master/v/industries" label="Industry" onChange={onChange} />);

    await waitFor(() => expect(screen.getByRole('option', { name: /add new industry/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });

    fireEvent.change(addInput('Industry'), { target: { value: 'Marine' } });
    fireEvent.click(addSubmit('industry'));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/master/v/industries', { name: 'Marine' }));
    // Selected, not merely created: the user must not have to go back and find
    // the value they just typed.
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('Marine', expect.objectContaining({ name: 'Marine' })));
    // Wording changed 2026-09-29 by request: the confirmation names the VALUE,
    // not the plumbing. "added to the industry master and selected" described
    // the one thing the user can already see happening on screen.
    expect(await screen.findByText(/marine added successfully/i)).toBeInTheDocument();
  });

  it('offers an optional Code for a master that has one, and omits it otherwise', async () => {
    // ⚠ `master_values` (every module vocabulary) has a `code` column;
    // master_departments / master_designations / master_zones do NOT. Offering
    // a Code box on those would take input the API silently drops.
    api.get.mockResolvedValue({ data: rows('Technology') });
    const { unmount } = render(<MasterSelect endpoint="/master/v/industries" label="Industry" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /add new industry/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });
    expect(addInput('Industry')).toBeInTheDocument();
    expect(addCodeInput('Industry')).toBeInTheDocument();
    unmount();

    render(<MasterSelect endpoint="/master/departments" label="Department" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /add new department/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });
    expect(addInput('Department')).toBeInTheDocument();
    expect(addCodeInput('Department')).toBeNull();
  });

  it('is a compact ADD dialog, not a master-data admin screen', async () => {
    // The form's job is to pick a value, or add one when HR needs one. Edit and
    // Delete controls beside a dropdown option would put ERP-wide changes
    // behind a data-entry form.
    api.get.mockResolvedValue({ data: rows('Technology', 'Marine') });
    render(<MasterSelect endpoint="/master/v/industries" label="Industry" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /add new industry/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });

    const dlg = addDialog();
    // The dialog's accessible name and its visible heading are the same string.
    expect(dlg).toHaveAttribute('aria-label', 'Add Industry');
    expect(dlg.querySelector('strong')).toHaveTextContent('Add Industry');
    for (const forbidden of [/rename/i, /delete/i, /deactivate/i, /retire/i]) {
      expect(within(dlg).queryByRole('button', { name: forbidden }), String(forbidden)).toBeNull();
    }
    // …and it says where the value is managed instead.
    // ⚠ "Settings → Master Data", not "Administration". The sidebar group has
    // always been Settings; the old wording named a menu that does not exist.
    expect(within(dlg).getByText(/Settings/)).toBeInTheDocument();
    expect(within(dlg).getByText(/Master Data/)).toBeInTheDocument();
    expect(within(dlg).queryByText(/Administration/)).toBeNull();
  });

  it('offers a CLICKABLE "Manage" link that opens the right Master Data tab', async () => {
    // The requirement: not prose naming a 24-tab destination, but a control
    // that lands on the tab. Prose is the fallback when the host passes no
    // navigator; a real host always does.
    const onNavigate = vi.fn();
    api.get.mockResolvedValue({ data: rows('Technology') });
    render(<MasterSelect endpoint="/master/v/industries" label="Industry"
                         onChange={() => {}} onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /add new industry/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });

    const link = within(addDialog()).getByRole('button', { name: /manage industries/i });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('MasterSetup', { tab: 'v:industries' });
  });

  it('routes the Location picker to Branches, not to a Master Data tab', async () => {
    // A branch is an ENTITY with a code, an address and contact details. It has
    // its own screen, and "+ Add new" is deliberately not offered here.
    const onNavigate = vi.fn();
    api.get.mockResolvedValue({ data: [{ id: 1, name: 'Head Office' }] });
    render(<MasterSelect endpoint="/branches" label="Location" optionValue="id"
                         searchable allowAdd={false}
                         onChange={() => {}} onNavigate={onNavigate} />);
    const input = await waitFor(() => {
      const el = screen.getByRole('combobox');
      expect(el.tagName).toBe('INPUT');
      return el;
    });
    fireEvent.click(input);
    const menu = await screen.findByRole('listbox');
    // No create affordance…
    expect(menu.querySelector('[data-master-add]')).toBeNull();
    // …but the menu still says where branches are managed.
    const link = screen.getByRole('button', { name: /manage locations/i });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('BranchManagement', undefined);
  });

  it('refuses an empty value without calling the server', async () => {
    api.get.mockResolvedValue({ data: rows('Technology') });
    render(<MasterSelect endpoint="/x" label="Industry" onChange={() => {}} />);

    await waitFor(() => expect(screen.getByRole('option', { name: /add new industry/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });
    fireEvent.click(addSubmit('industry'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/required/i);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows the server duplicate message verbatim, naming the value that collided', async () => {
    api.get.mockResolvedValue({ data: rows('Technology') });
    api.post.mockRejectedValue({
      response: { status: 409, data: { error: '"Technology" is already an industry.' } },
    });

    render(<MasterSelect endpoint="/x" label="Industry" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /add new industry/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });
    fireEvent.change(addInput('Industry'), { target: { value: 'technology' } });
    fireEvent.click(addSubmit('industry'));

    // A generic "could not save" would hide WHICH value collided, which is the
    // only part the user can act on.
    expect(await screen.findByRole('alert')).toHaveTextContent(/"Technology" is already an industry/);
  });

  it('explains a 403 rather than showing the raw error', async () => {
    api.get.mockResolvedValue({ data: rows('Technology') });
    api.post.mockRejectedValue({ response: { status: 403, data: { error: 'Access denied' } } });

    render(<MasterSelect endpoint="/x" label="Industry" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /add new industry/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });
    fireEvent.change(addInput('Industry'), { target: { value: 'Marine' } });
    fireEvent.click(addSubmit('industry'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not have permission.*Master Data Setup/i);
  });
});

describe('render mode', () => {
  it('stays a native <select> for a short list', async () => {
    api.get.mockResolvedValue({ data: rows('A', 'B', 'C') });
    render(<MasterSelect endpoint="/x" label="Industry" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'A' })).toBeInTheDocument());
    expect(screen.getByRole('combobox').tagName).toBe('SELECT');
  });

  it('becomes a searchable combobox past the threshold', async () => {
    api.get.mockResolvedValue({ data: manyRows });
    render(<MasterSelect endpoint="/x" label="Industry" onChange={() => {}} />);
    expect(await comboInput()).toBeInTheDocument();
  });

  it('opens the WHOLE list on click, before anything is typed', async () => {
    // The app's own convention for entity pickers: a search box that shows
    // nothing until you type is unusable, because you have to already know a
    // name to get anywhere and there is no way to discover how many there are.
    api.get.mockResolvedValue({ data: manyRows });
    render(<MasterSelect endpoint="/x" label="Industry" onChange={() => {}} />);

    const input = await comboInput();
    fireEvent.click(input);

    expect(screen.getByText('Option 1')).toBeInTheDocument();
    expect(screen.getByText('Option 15')).toBeInTheDocument();
  });

  it('narrows as you type, and picks what you click', async () => {
    api.get.mockResolvedValue({ data: manyRows });
    const onChange = vi.fn();
    render(<MasterSelect endpoint="/x" label="Industry" onChange={onChange} />);

    const input = await comboInput();
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: 'Option 12' } });

    expect(screen.queryByText('Option 1')).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText('Option 12'));
    expect(onChange).toHaveBeenCalledWith('Option 12', expect.objectContaining({ name: 'Option 12' }));
  });

  it('re-opening a picker that already holds a value shows everything again', async () => {
    // Not just the one row matching the selection. Forcing a "clear" click
    // before you can browse is the failure this rule exists to prevent.
    api.get.mockResolvedValue({ data: manyRows });
    render(<MasterSelect endpoint="/x" label="Industry" value="Option 12" onChange={() => {}} />);

    const input = await comboInput();
    expect(input).toHaveValue('Option 12');
    fireEvent.click(input);
    expect(screen.getByText('Option 1')).toBeInTheDocument();
  });

  it('honours an explicit searchable={false} however long the list gets', async () => {
    api.get.mockResolvedValue({ data: manyRows });
    render(<MasterSelect endpoint="/x" label="Industry" searchable={false} onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Option 1' })).toBeInTheDocument());
    expect(screen.getByRole('combobox').tagName).toBe('SELECT');
  });
});

describe('response shapes', () => {
  // Three master endpoints in this codebase answer three different shapes, and
  // a mismatch does not throw — it silently empties the dropdown, which reads
  // as "there is nothing to pick".
  it.each([
    ['a bare array',        rows('Technology')],
    ['a { data } envelope', { data: rows('Technology') }],
    ['a named collection',  { categories: rows('Technology') }],
  ])('reads %s', async (_label, payload) => {
    api.get.mockResolvedValue({ data: payload });
    render(<MasterSelect endpoint="/x" label="Industry" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Technology' })).toBeInTheDocument());
  });
});

describe('VocabSelect', () => {
  it('resolves the endpoint and the add-roles from the server registry', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/master/v') {
        return Promise.resolve({ data: [{
          key: 'industries', label: 'Industry', module: 'CRM',
          endpoint: '/master/v/industries', roles: ['super_admin', 'admin', 'sales_manager'],
        }] });
      }
      return Promise.resolve({ data: rows('Technology') });
    });

    render(<VocabSelect vocab="industries" onChange={() => {}} />);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/master/v/industries'));
    expect(await screen.findByRole('option', { name: /add new industry/i })).toBeInTheDocument();
  });

  it('hides the add option when the registry says this role cannot write', async () => {
    auth.roles = ['employee'];
    api.get.mockImplementation((url) => {
      if (url === '/master/v') {
        return Promise.resolve({ data: [{
          key: 'industries', label: 'Industry', module: 'CRM',
          endpoint: '/master/v/industries', roles: ['super_admin', 'admin', 'sales_manager'],
        }] });
      }
      return Promise.resolve({ data: rows('Technology') });
    });

    render(<VocabSelect vocab="industries" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Technology' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: /add new/i })).not.toBeInTheDocument();
  });

  it('does not cache a failed registry fetch as "no vocabularies exist"', async () => {
    api.get.mockRejectedValueOnce(new Error('network'));
    const { unmount } = render(<VocabSelect vocab="industries" onChange={() => {}} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/master/v'));
    unmount();

    api.get.mockImplementation((url) =>
      url === '/master/v'
        ? Promise.resolve({ data: [{ key: 'industries', label: 'Industry', endpoint: '/master/v/industries', roles: ['admin'] }] })
        : Promise.resolve({ data: rows('Technology') }));

    render(<VocabSelect vocab="industries" onChange={() => {}} />);
    // The next picker to mount retries rather than inheriting the failure for
    // the rest of the session.
    await waitFor(() => expect(screen.getByRole('option', { name: 'Technology' })).toBeInTheDocument());
  });
});

// ── §173: a two-level vocabulary ─────────────────────────────────────────────
//
// Expense is one domain described by three lists: a hardcoded hierarchy in
// ExpenseClaims, a different lowercase one in EmployeeSelfService, and an
// `expense_categories` table nothing read. Folding them into one master needed
// the picker to cascade, which is the contract these pin.
describe('VocabSelect cascading', () => {
  const registry = [
    { key: 'expense-types', label: 'Expense Type', endpoint: '/master/v/expense-types', roles: ['admin'] },
    { key: 'expense-categories', label: 'Expense Category', endpoint: '/master/v/expense-categories',
      roles: ['admin'], parentOf: 'expense-types', parentLabel: 'Expense Type' },
  ];
  const serve = (byUrl) => api.get.mockImplementation((url) =>
    url === '/master/v' ? Promise.resolve({ data: registry })
                        : Promise.resolve({ data: byUrl[url] ?? [] }));

  it('says which field to fill first instead of showing an empty dropdown', async () => {
    // An empty list reads as "there is nothing to pick". The user needs to know
    // the other field gates this one.
    serve({});
    render(<VocabSelect vocab="expense-categories" onChange={() => {}} />);
    expect(await screen.findByText(/select expense type first/i)).toBeInTheDocument();
    // And it must not have gone and fetched the unscoped list in the meantime.
    expect(api.get).not.toHaveBeenCalledWith('/master/v/expense-categories');
  });

  it('fetches only the chosen parent children', async () => {
    serve({ '/master/v/expense-categories?parent=Food': rows('Breakfast', 'Lunch') });
    render(<VocabSelect vocab="expense-categories" parent="Food" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Lunch' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'Hotel' })).not.toBeInTheDocument();
  });

  it('re-fetches when the parent changes', async () => {
    // The parent is part of the endpoint, which is MasterSelect's only load
    // dependency — that is what makes the cascade work without a second effect
    // to keep in sync. If this regresses, changing the type leaves the previous
    // type's categories on screen and a claim gets a category from the wrong one.
    serve({
      '/master/v/expense-categories?parent=Food': rows('Breakfast', 'Lunch'),
      '/master/v/expense-categories?parent=Travel': rows('Flight', 'Taxi'),
    });
    const { rerender } = render(<VocabSelect vocab="expense-categories" parent="Food" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Lunch' })).toBeInTheDocument());

    rerender(<VocabSelect vocab="expense-categories" parent="Travel" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Flight' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'Lunch' })).not.toBeInTheDocument();
  });

  it('URL-encodes a parent that needs it', async () => {
    serve({ '/master/v/expense-categories?parent=Telephone%20%26%20Internet': rows('Mobile') });
    render(<VocabSelect vocab="expense-categories" parent="Telephone & Internet" onChange={() => {}} />);
    // An unencoded '&' would truncate the query string and silently return the
    // children of an empty parent — which the API answers with [].
    await waitFor(() => expect(screen.getByRole('option', { name: 'Mobile' })).toBeInTheDocument());
  });

  it('sends the parent with a newly added category', async () => {
    serve({ '/master/v/expense-categories?parent=Travel': rows('Flight') });
    api.post.mockResolvedValue({ data: { id: 7, name: 'Visa Fee' } });

    render(<VocabSelect vocab="expense-categories" parent="Travel" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: /add new expense category/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__master_select_add_new__' } });
    fireEvent.change(addInput('Expense Category'), { target: { value: 'Visa Fee' } });
    fireEvent.click(addSubmit('expense category'));

    // Without the parent the API refuses it — a child with none is a row no
    // cascading picker would ever show again.
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/master/v/expense-categories?parent=Travel',
      { parent: 'Travel', name: 'Visa Fee' }
    ));
  });

  it('leaves a single-level vocabulary alone when a parent is passed', async () => {
    serve({ '/master/v/expense-types': rows('Travel', 'Food') });
    render(<VocabSelect vocab="expense-types" parent="ignored" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Travel' })).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledWith('/master/v/expense-types');
  });
});

// ── orphanLabel: a stored id that is not in the list ─────────────────────────
// An id-keyed picker (Workforce Category) whose stored value has been
// deactivated would otherwise render its bare id.
describe('MasterSelect orphanLabel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('labels an out-of-list id with the given text instead of the number', async () => {
    api.get.mockResolvedValue({ data: [{ id: 1, name: 'Security' }] });
    render(<MasterSelect endpoint="/master/v/workforce-categories" label="Workforce Category"
                         optionValue="id" searchable={false} allowAdd={false}
                         value="17" orphanLabel="Driver (inactive)" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Security' })).toBeInTheDocument());
    const orphan = screen.getByRole('option', { name: 'Driver (inactive)' });
    expect(orphan).toHaveValue('17');
    expect(screen.queryByRole('option', { name: '17' })).toBeNull();
  });

  it('without orphanLabel, keeps showing the raw stored value (unchanged behaviour)', async () => {
    api.get.mockResolvedValue({ data: [{ id: 1, name: 'Security' }] });
    render(<MasterSelect endpoint="/x" label="Industry" searchable={false} allowAdd={false}
                         value="Legacy Value" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Legacy Value' })).toBeInTheDocument());
  });

  it('the searchable combobox shows orphanLabel as the selected text', async () => {
    api.get.mockResolvedValue({ data: [{ id: 1, name: 'Security' }] });
    render(<MasterSelect endpoint="/x" label="Workforce Category" optionValue="id" searchable
                         allowAdd={false} value="17" orphanLabel="Driver (inactive)" onChange={() => {}} />);
    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('Driver (inactive)'));
  });
});
