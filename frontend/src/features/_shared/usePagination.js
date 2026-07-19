import { useState, useMemo } from 'react';

/**
 * Client-side pagination hook.
 * @param {Array}  data            - full dataset to paginate
 * @param {number} initialPageSize - rows per page (default 20)
 */
export function usePagination(data, initialPageSize = 20) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(initialPageSize);

  const totalPages = Math.max(1, Math.ceil((data?.length || 0) / pageSize));

  // Reset to page 1 when data changes (e.g. after filter/search)
  const safeData = data ?? [];
  const slice = useMemo(() => {
    const start = (page - 1) * pageSize;
    return safeData.slice(start, start + pageSize);
  }, [safeData, page, pageSize]);

  const goTo   = (n) => setPage(Math.min(Math.max(1, n), totalPages));
  const next   = ()  => goTo(page + 1);
  const prev   = ()  => goTo(page - 1);
  const reset  = ()  => setPage(1);

  // Changing page size invalidates the current offset — always land back on page 1.
  const setPageSize = (n) => { setPageSizeRaw(Number(n) || initialPageSize); setPage(1); };

  return { page, totalPages, slice, goTo, next, prev, reset,
           pageSize, setPageSize, total: safeData.length };
}
