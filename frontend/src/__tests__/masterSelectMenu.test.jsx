/**
 * masterSelectMenu.test.jsx — the dropdown MENU contract (2026-09-29).
 *
 * THE BUG THIS FILE EXISTS FOR
 * ----------------------------
 * Department, Designation and Asset Type on Add Employee opened a popup that
 * was a narrow horizontally-scrolling strip: the option text clipped to two or
 * three characters each, with scroll-arrow buttons under it. One cause, in the
 * page's own stylesheet:
 *
 *     .form-grid div > div { display: flex; gap: 16px; align-items: center; }
 *
 * written for an inline radio row, and matching EVERY nested div under
 * .form-grid — including MasterSelect's popup, which is
 * `cell > wrapper > combo > MENU`. The menu became a horizontal flex row.
 *
 * Only those three pickers showed it because only they cross
 * SEARCH_THRESHOLD (12) and take the combobox path: Department has 14+ master
 * rows, Designation 24, Asset Type 13. Grade, Band, Qualification (7),
 * Employment Type (9) and Skill Type (3) stay native <select>s, whose popup
 * the OS draws outside the page entirely — which is why the report named
 * exactly three fields and not eight.
 *
 * WHY THESE ASSERTIONS AND NOT A SCREENSHOT
 * -----------------------------------------
 * jsdom does no layout, so "is it visually narrow?" is not a question that can
 * be asked here — 24-add-employee.spec.ts asks it in a real browser at 1280,
 * 1440 and 1920. What CAN be pinned here, deterministically and without a
 * database, are the structural facts that made the visual bug possible:
 *
 *   • the menu is not a descendant of the field (so no ancestor rule or
 *     `overflow: hidden` can reach it)
 *   • the menu declares its own layout inline (so a stylesheet cannot)
 *   • options do not truncate
 *   • the keyboard and ARIA contract
 *
 * Each one is a regression fence around a specific way the bug came back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

vi.mock('@/services/api/client', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const { auth } = vi.hoisted(() => ({ auth: { roles: ['admin'] } }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { userId: 1, name: 'Admin' },
    hasAnyRole: (...wanted) => wanted.some(r => auth.roles.includes(r)),
  }),
}));

import api from '@/services/api/client';
import MasterSelect from '@/components/core/MasterSelect';
import { placeMenu } from '@/components/core/menuPlacement';

/**
 * The real designation master, as `SELECT name FROM master_designations WHERE
 * is_active` returned it on 2026-09-29. 24 rows — over SEARCH_THRESHOLD, so
 * this is the combobox path, and the longest name is 'Operations Executive',
 * which is what a ~230px grid cell cannot show without either wrapping or
 * clipping.
 */
const DESIGNATIONS = [
  'Accountant', 'Analyst', 'Assistant Manager', 'CEO', 'CFO', 'CTO', 'Engineer',
  'Engineering Manager', 'Executive', 'Finance Analyst', 'General Manager',
  'HR Executive', 'HR Manager', 'Junior Engineer', 'Manager', 'Managing Director',
  'Operations Executive', 'Operations Manager', 'Sales Executive', 'Sales Manager',
  'Senior Engineer', 'Senior Manager', 'Software Engineer', 'Tech Lead',
].map((name, i) => ({ id: i + 1, name }));

beforeEach(() => {
  vi.clearAllMocks();
  auth.roles = ['admin'];
  api.get.mockResolvedValue({ data: DESIGNATIONS });
});

/**
 * ⚠ getByRole('combobox') matches a <select> AS WELL AS role="combobox", and
 * MasterSelect renders a <select> on its first paint — the rows arrive a tick
 * later and only then does it switch modes. Waiting on the role alone returns
 * the SELECT, which React then discards; events fired at that detached node do
 * nothing and the failure reads as "the menu never opened".
 */
const comboInput = () =>
  waitFor(() => {
    const el = screen.getByRole('combobox');
    expect(el.tagName).toBe('INPUT');
    return el;
  });

const renderPicker = (props = {}) =>
  render(
    // The exact nesting the bug needed: a .form-grid whose cells hold a div.
    // Without it a regression in the page stylesheet would not be reproduced
    // by this suite at all.
    <div className="form-grid">
      <div>
        <label htmlFor="d">Designation</label>
        <MasterSelect id="d" endpoint="/master/designations" label="Designation" {...props} />
      </div>
    </div>,
  );

/**
 * Render a picker, wait for the combobox to take over from the first-paint
 * <select>, and open it. Rendering is part of this helper on purpose: an
 * earlier draft had a bare openMenu() and half the cases silently drove a tree
 * the previous test had left behind.
 */
const openMenu = async (props = {}) => {
  const view = renderPicker(props);
  const input = await comboInput();
  fireEvent.click(input);
  const menu = await screen.findByRole('listbox');
  return { input, menu, ...view };
};

describe('dropdown menu — structure', () => {
  it('renders the menu OUTSIDE the field, as a child of <body>', async () => {
    // The root-cause fix. An ancestor cannot restyle, clip or out-stack an
    // element that is not its descendant. `.accordion { overflow: hidden }` on
    // Add Employee was clipping the menu, and `.form-grid div > div` was
    // relaying it out — both by reaching DOWN the tree from the field.
    const { container, menu } = await openMenu();

    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
  });

  it('declares its own layout inline, so no stylesheet can override it', async () => {
    // The specific failure: the menu inherited `display: flex` from the page
    // and laid its options out side by side. An inline style cannot be beaten
    // by a selector, so the menu states `display: block` itself.
    const { menu } = await openMenu();
    expect(menu.style.display).toBe('block');
    expect(menu.style.position).toBe('fixed');
  });

  it('can never show a horizontal scrollbar', async () => {
    // The visible symptom — the left/right arrow controls under the options.
    // Asserted rather than left to layout: the menu is sized to its content,
    // so hiding horizontal overflow cannot hide anything the user needs.
    const { menu } = await openMenu();
    expect(menu.style.overflowX).toBe('hidden');
    expect(menu.style.overflowY).toBe('auto');
  });

  it('wraps long option text instead of truncating it', async () => {
    // Options used to carry `white-space: nowrap` + `text-overflow: ellipsis`,
    // which is what turned 'Operations Executive' into partial characters once
    // the menu was squeezed. Wrapping cannot clip.
    const { menu } = await openMenu();
    const opt = within(menu).getByText('Operations Executive');
    expect(opt.style.whiteSpace).toBe('normal');
    expect(opt.style.textOverflow).not.toBe('ellipsis');
    // And the full name is really in the DOM, not an abbreviation of it.
    expect(opt.textContent).toBe('Operations Executive');
  });

  it('renders every master row, each on its own option element', async () => {
    const { menu } = await openMenu();
    const options = within(menu).getAllByRole('option');
    // 24 designations + the "+ Add new…" row (this caller is an admin).
    expect(options).toHaveLength(DESIGNATIONS.length + 1);
    for (const d of DESIGNATIONS) {
      expect(within(menu).getByText(d.name)).toBeTruthy();
    }
  });
});

describe('dropdown menu — placement arithmetic', () => {
  // placeMenu is pure, so the cases that need a viewport can be stated exactly
  // rather than approximated with a fake layout engine.
  const view = (innerWidth, innerHeight) => ({ innerWidth, innerHeight });
  const rect = (left, top, width = 230, height = 34) =>
    ({ left, top, width, height, right: left + width, bottom: top + height });

  it('opens downward when there is room', () => {
    const box = placeMenu(rect(100, 200), view(1440, 900));
    expect(box.flip).toBe(false);
    expect(box.top).toBe(238);            // bottom (234) + MENU_GAP (4)
  });

  it('flips above the field when the room below runs out', () => {
    // A picker near the foot of the window. Down-only, this menu would render
    // in a 40px sliver or off-screen; Status and Zone sit exactly here.
    const box = placeMenu(rect(100, 800), view(1440, 900));
    expect(box.flip).toBe(true);
    expect(box.bottom).toBe(104);         // 900 - 800 + 4
  });

  it('never proposes a menu taller than the space available', () => {
    const box = placeMenu(rect(100, 640), view(1440, 800));
    // 800 - 674 - 4 - 8 = 114, floored at MENU_MIN_HEIGHT.
    expect(box.maxHeight).toBeLessThanOrEqual(800);
    expect(box.maxHeight).toBeGreaterThanOrEqual(132);
  });

  it('keeps a last-column picker on screen at 1280', () => {
    // The 4-up grid puts the last column's right edge near the viewport edge.
    // `width: max-content` would otherwise run off it — a horizontal scrollbar
    // on the PAGE, which is the other half of "no horizontal overflow".
    const box = placeMenu(rect(1040, 300, 230), view(1280, 800));
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.left + box.maxWidth).toBeLessThanOrEqual(1280);
  });

  it('is never narrower than the control it belongs to', () => {
    for (const w of [1280, 1440, 1920]) {
      const box = placeMenu(rect(40, 300, 230), view(w, 900));
      expect(box.width).toBe(230);
      expect(box.maxWidth).toBeGreaterThanOrEqual(230);
    }
  });
});

describe('dropdown menu — keyboard and ARIA', () => {
  it('exposes the combobox/listbox contract a screen reader needs', async () => {
    const { input, menu } = await openMenu();
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-haspopup')).toBe('listbox');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    // aria-controls must point at the menu that is actually on screen.
    expect(input.getAttribute('aria-controls')).toBe(menu.id);
    // …and the active option must be an element that exists, or the attribute
    // is worse than absent.
    const active = input.getAttribute('aria-activedescendant');
    expect(document.getElementById(active)).toBeTruthy();
  });

  it('is labelled by its own <label>', async () => {
    // The labels on this form sat beside their controls with no htmlFor and no
    // id to point at, so every one of them was decorative.
    renderPicker();
    const input = await comboInput();
    expect(input.id).toBe('d');
    expect(document.querySelector('label[for="d"]').textContent).toContain('Designation');
  });

  it('ArrowDown moves the active option and Enter selects it', async () => {
    const onChange = vi.fn();
    const { input } = await openMenu({ onChange });

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Opened at index 0, one ArrowDown -> index 1 -> 'Analyst'.
    expect(onChange).toHaveBeenCalledWith('Analyst', expect.objectContaining({ name: 'Analyst' }));
  });

  it('Escape closes the menu and removes it from the document', async () => {
    const { input } = await openMenu();
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    // Not merely hidden: a portalled node left on <body> would keep taking
    // clicks over the rest of the page.
    expect(document.querySelectorAll('[data-master-menu]')).toHaveLength(0);
  });

  it('Tab closes the menu rather than leaving it floating on <body>', async () => {
    const { input } = await openMenu();
    fireEvent.keyDown(input, { key: 'Tab' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('Enter on a CLOSED picker does not get swallowed', async () => {
    // The picker lives in a <form> that submits on Enter. Swallowing Enter
    // unconditionally would break keyboard submission of the whole page.
    renderPicker();
    const input = await comboInput();
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('clicking an option selects it and closes the menu', async () => {
    const onChange = vi.fn();
    const { menu } = await openMenu({ onChange });

    fireEvent.mouseDown(within(menu).getByText('Tech Lead'));

    expect(onChange).toHaveBeenCalledWith('Tech Lead', expect.objectContaining({ name: 'Tech Lead' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('search narrows the list and leaves full names readable', async () => {
    const { input } = await openMenu();
    fireEvent.change(input, { target: { value: 'manager' } });

    const menu = await screen.findByRole('listbox');
    const names = within(menu).getAllByRole('option').map(o => o.textContent);
    expect(names).toContain('Assistant Manager');
    expect(names).toContain('Operations Manager');
    expect(names).not.toContain('Accountant');
  });
});

describe('dropdown menu — value matching', () => {
  it('matches a numeric id against a string value', async () => {
    // The Location picker is keyed on `optionValue="id"`, so the API's `id: 1`
    // meets form state's `'1'`. Under `===` the row matched nothing and the
    // control fell through to its orphan branch, displaying the bare id where
    // the branch name belongs — and writing that back on the next save.
    api.get.mockResolvedValue({
      data: [{ id: 1, name: 'Head Office' }, { id: 2, name: 'Sales Office' }],
    });
    render(
      <MasterSelect
        endpoint="/branches" label="Location" optionValue="id"
        searchable allowAdd={false}
        value="1" onChange={() => {}}
      />,
    );
    const input = await comboInput();
    await waitFor(() => expect(input.value).toBe('Head Office'));
  });
});
