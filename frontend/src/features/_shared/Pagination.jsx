import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * Reusable pagination bar.
 * @param {number}   page        - current page (1-indexed)
 * @param {number}   totalPages  - total number of pages
 * @param {number}   total       - total record count
 * @param {number}   pageSize    - rows per page
 * @param {Function} onNext      - go to next page
 * @param {Function} onPrev      - go to previous page
 * @param {Function} onGoTo      - go to specific page number
 * @param {Function} [onPageSizeChange] - rows-per-page setter. Omit to render the
 *                   selector as before (display-only); pass it to make it live.
 */
export default function Pagination({
  page, totalPages, total, pageSize, onNext, onPrev, onGoTo, onPageSizeChange
}) {
  // Keep the bar mounted when the size selector is live, otherwise a user who
  // paged down to a single page could never get back to a smaller page size.
  if (totalPages <= 1 && !onPageSizeChange) return null;

  const start = (page - 1) * pageSize + 1;
  const end   = Math.min(page * pageSize, total);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 0', borderTop: '1px solid #f3f4f6', marginTop: 8,
      fontSize: 13, color: '#6b7280',
    }}>
      <span>{start}–{end} of {total}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          onClick={onPrev} disabled={page === 1}
          aria-label="Previous page"
          style={{
            padding: '5px 8px', border: '1px solid #e5e7eb',
            borderRadius: 6, background: page === 1 ? '#f9fafb' : '#fff',
            cursor: page === 1 ? 'not-allowed' : 'pointer',
            color: page === 1 ? '#d1d5db' : '#374151',
            display: 'flex', alignItems: 'center',
          }}>
          <ChevronLeft size={14} aria-hidden="true" />
        </button>

        {/* page number pills — show at most 5 */}
        {Array.from({ length: totalPages }, (_, i) => i + 1)
          .filter(n => {
            if (totalPages <= 5) return true;
            if (n === 1 || n === totalPages) return true;
            return Math.abs(n - page) <= 1;
          })
          .reduce((acc, n, i, arr) => {
            if (i > 0 && n - arr[i - 1] > 1) {
              acc.push('...');
            }
            acc.push(n);
            return acc;
          }, [])
          .map((n, i) => n === '...' ? (
            <span key={`e${i}`} style={{ padding: '0 4px' }}>…</span>
          ) : (
            <button key={n} onClick={() => onGoTo(n)}
              aria-label={`Page ${n}`}
              aria-current={n === page ? 'page' : undefined}
              style={{
                width: 30, height: 30, border: '1px solid',
                borderColor: n === page ? '#6366f1' : '#e5e7eb',
                borderRadius: 6, background: n === page ? '#6366f1' : '#fff',
                color: n === page ? '#fff' : '#374151',
                cursor: 'pointer', fontWeight: n === page ? 600 : 400,
                fontSize: 13,
              }}>
              {n}
            </button>
          ))
        }

        <button
          onClick={onNext} disabled={page === totalPages}
          aria-label="Next page"
          style={{
            padding: '5px 8px', border: '1px solid #e5e7eb',
            borderRadius: 6,
            background: page === totalPages ? '#f9fafb' : '#fff',
            cursor: page === totalPages ? 'not-allowed' : 'pointer',
            color: page === totalPages ? '#d1d5db' : '#374151',
            display: 'flex', alignItems: 'center',
          }}>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <select
        value={pageSize}
        onChange={(e) => (onPageSizeChange ? onPageSizeChange(Number(e.target.value)) : onGoTo(1))}
        aria-label="Rows per page"
        style={{
          fontSize: 12, border: '1px solid #e5e7eb',
          borderRadius: 6, padding: '4px 8px',
          color: '#6b7280', cursor: 'pointer', outline: 'none',
        }}>
        {[10, 20, 50, 100].map(n => (
          <option key={n} value={n}>{n} per page</option>
        ))}
      </select>
    </div>
  );
}
