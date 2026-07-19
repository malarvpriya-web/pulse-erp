import { useState, useEffect, useCallback } from 'react';

const DEFAULT_PAGE = 'Home';

function pageFromHash() {
  const raw = window.location.hash.slice(1); // '#FixedAssets' → 'FixedAssets'
  return raw || DEFAULT_PAGE;
}

/**
 * Drop-in replacement for useState('Home') that syncs page state with the URL
 * hash, giving back/forward support, bookmarkable URLs, and deep-linking.
 *
 * URL format: /#PageName  (e.g. /#FixedAssets, /#InvoicesNew)
 * Home maps to the bare path with no hash fragment.
 */
export function usePageRouter() {
  const [page, _setPage] = useState(pageFromHash);

  const setPage = useCallback((next) => {
    _setPage(next);
    window.history.pushState(
      { page: next },
      '',
      next === DEFAULT_PAGE ? window.location.pathname : `#${next}`,
    );
  }, []);

  useEffect(() => {
    // Stamp the initial history entry so popstate carries a page name when the
    // user navigates back past the first page they landed on.
    window.history.replaceState({ page: pageFromHash() }, '', window.location.href);

    const onPop = (e) => {
      _setPage(e.state?.page ?? pageFromHash());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return [page, setPage];
}
