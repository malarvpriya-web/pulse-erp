// ──────────────────────────────────────────────────────────────────────────────
// menuPlacement — where a portalled dropdown menu goes.
//
// Its own module rather than a second export from MasterSelect.jsx: a file that
// exports both a component and a plain function loses Fast Refresh, and this is
// the one piece of the dropdown worth testing without a DOM tree around it.
//
// THE MENU IS `position: fixed` ON <body>. That is the whole point, and it is
// why this arithmetic exists at all. An absolutely-positioned menu inherits its
// coordinates from the field, which sounds convenient until an ancestor clips
// it: `.accordion { overflow: hidden }` on Add Employee cut every dropdown off
// at its section border, and a `display: flex` rule broad enough to match the
// menu (`.form-grid div > div`) laid its options out sideways. A child of
// <body> is out of reach of both, but it has to be told where to draw itself.
// ──────────────────────────────────────────────────────────────────────────────

/** Space between the field and the menu. */
export const MENU_GAP = 4;
/** Closest the menu may come to a viewport edge. */
export const VIEWPORT_MARGIN = 8;
/** Never taller than this, however much room there is. */
export const MENU_MAX_HEIGHT = 280;
/** Below this, opening downward is not worth it — flip above instead. */
export const MENU_MIN_HEIGHT = 132;

/**
 * Measure the menu box for a control.
 *
 * Opens downward by default and flips above the field when there is not enough
 * room below — the Add Employee accordion puts Zone and Status near the bottom
 * of the window, where a down-only menu is a menu you cannot read. Either way
 * the height is clamped to the space actually available, so the menu always
 * ends inside the viewport and scrolls internally instead of running off it.
 *
 * WIDTH is returned as a floor and a ceiling, not a number: the caller sets
 * `width: max-content` between them. So the menu is never narrower than the
 * control, never wider than the screen, and always wide enough for the longest
 * option — which is what makes `overflow-x: hidden` an assertion the menu can
 * keep rather than a way of hiding content.
 *
 * @param {DOMRect} rect  the control's bounding rect
 * @param {{innerWidth:number, innerHeight:number}} view  the viewport
 */
export function placeMenu(rect, view) {
  const roomBelow = view.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const roomAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN;
  const flip = roomBelow < MENU_MIN_HEIGHT && roomAbove > roomBelow;
  const room = flip ? roomAbove : roomBelow;

  // Clamp the LEFT edge too. A picker in the last column of the 4-up grid at
  // 1280 would otherwise let `max-content` run off the right-hand side, which
  // is a horizontal scrollbar on the PAGE — the other half of the reported bug.
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.left, view.innerWidth - VIEWPORT_MARGIN - rect.width),
  );

  return {
    flip,
    left,
    width: rect.width,
    maxWidth: Math.max(rect.width, view.innerWidth - left - VIEWPORT_MARGIN),
    top: rect.bottom + MENU_GAP,
    bottom: view.innerHeight - rect.top + MENU_GAP,
    maxHeight: Math.max(MENU_MIN_HEIGHT, Math.min(MENU_MAX_HEIGHT, room)),
  };
}

/** `placeMenu` against a live element and the real window. */
export const measureMenu = (anchor) => placeMenu(anchor.getBoundingClientRect(), window);

export default placeMenu;
