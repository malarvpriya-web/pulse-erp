/**
 * Remember where the recruiter was in the candidate list, so returning from a
 * profile puts them back there.
 *
 * ── WHY THIS IS NEEDED AT ALL ───────────────────────────────────────────────
 * The workbench keeps its filters in the URL query string, which is the right
 * store: the back button, a refresh and a pasted link all reproduce the same list.
 * But `setPage(page, params)` in Layout.jsx navigates to `/<Page>?<params>` and
 * REPLACES the whole query string — so `setPage('CandidateDetail')` necessarily
 * discards the filters on the way out, and `setPage('Candidates', { tab: 'all' })`
 * on the way back sets only the tab.
 *
 * The browser's own Back button does restore the filtered URL, and the quick-view
 * drawer means most candidates never require leaving the list. This covers the
 * case that remains: the recruiter opened the full profile to read a résumé and
 * pressed the page's own "Candidates" button.
 *
 * ── WHY sessionStorage ──────────────────────────────────────────────────────
 * It is per-tab and dies with the tab, which is exactly the lifetime of "the list
 * I was just looking at". localStorage would resurrect a filter set from last
 * Tuesday on a fresh visit, which is worse than not restoring anything. Every
 * access is wrapped: sessionStorage throws in some privacy modes, and a filter
 * convenience must never be able to break the page.
 */

const KEY = 'pulse.recruitment.candidateList.return';

/** Called by the list on every filter change. `search` includes the leading '?'. */
export function rememberCandidateList(search) {
  try {
    sessionStorage.setItem(KEY, search || '');
  } catch { /* private mode, blocked storage — the list simply will not be restored */ }
}

/**
 * The params to hand `setPage('Candidates', …)` so the list comes back as it was.
 *
 * Always carries `tab: 'all'`, because the workbench is one tab of the Candidates
 * hub and restoring filters onto the Kanban tab would show the filters as inactive.
 */
export function candidateListReturnParams() {
  let stored = '';
  try {
    stored = sessionStorage.getItem(KEY) || '';
  } catch { /* fall through to the bare tab */ }

  const params = new URLSearchParams(stored.replace(/^\?/, ''));
  params.set('tab', 'all');
  return Object.fromEntries(params.entries());
}
