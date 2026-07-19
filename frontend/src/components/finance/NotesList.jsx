/**
 * NotesList — shared table + KPI component for Credit Notes (AR) and Debit Notes (AP).
 *
 * Props:
 *   type        'credit' | 'debit'   — drives labels, reason map, journal direction
 *   side        'AR' | 'AP'          — drives "Party" column label
 *   data        Note[]               — rows already fetched by parent
 *   total       number               — total count for subtitle
 *   kpis        object | null        — { total_count, draft_count, issued_count, issued_amount, total_value }
 *   loading     boolean
 *   error       string | null
 *   onRetry     () => void
 *   statusFilter string
 *   onStatus    (s) => void
 *   supplierFilter string
 *   onSupplier  (s) => void
 *   fromDate    string
 *   onFrom      (s) => void
 *   toDate      string
 *   onTo        (s) => void
 *   onResetFilters () => void
 *   onIssue     (id) => void
 *   onCancel    (id) => void
 *   onViewPDF   (id) => void
 *   onExport    () => void           — exports table to CSV
 *   onNew       () => void           — opens form in parent
 */

const PURPLE = '#7c3aed';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const STATUS_COLORS = {
  draft:     ['#fef3c7', '#b45309'],
  issued:    ['#dcfce7', '#15803d'],
  cancelled: ['#fee2e2', '#dc2626'],
};

const CREDIT_REASONS = {
  sales_return:           'Sales Return',
  price_revision:         'Price Revision',
  deficiency_of_service:  'Service Deficiency',
  post_sale_discount:     'Post-Sale Discount',
  other:                  'Other',
};

const DEBIT_REASONS = {
  purchase_return:   'Purchase Return',
  price_revision:    'Price Revision',
  short_supply:      'Short Supply',
  quality_rejection: 'Quality Rejection',
  other:             'Other',
};

const fmt = v =>
  v != null && v !== ''
    ? `₹${parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    : '₹0.00';

const fmtDate = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

function KpiCard({ label, value, sub, color = PURPLE }) {
  return (
    <div style={{
      flex: '1 1 150px', minWidth: 130,
      background: '#fff', border: `1px solid ${BORDER}`,
      borderRadius: 10, padding: '14px 16px',
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color, marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function NotesList({
  type = 'debit',
  side = 'AP',
  data = [],
  total = 0,
  kpis = null,
  loading = false,
  error = null,
  onRetry,
  statusFilter = '',
  onStatus,
  supplierFilter = '',
  onSupplier,
  fromDate = '',
  onFrom,
  toDate = '',
  onTo,
  onResetFilters,
  onIssue,
  onCancel,
  onViewPDF,
  onExport,
  onNew,
}) {
  const isDebit     = type === 'debit';
  const reasonMap   = isDebit ? DEBIT_REASONS : CREDIT_REASONS;
  const partyLabel  = side === 'AP' ? 'Supplier' : 'Customer';
  const numLabel    = isDebit ? 'DN Number' : 'CN Number';
  const numField    = isDebit ? 'debit_note_number'  : 'credit_note_number';
  const dateField   = isDebit ? 'debit_note_date'    : 'credit_note_date';
  const origLabel   = isDebit ? 'Original Bill'      : 'Original Inv.';
  const origField   = 'original_bill_number';
  const hasFilters  = statusFilter || supplierFilter || fromDate || toDate;

  return (
    <div>
      {/* KPI cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <KpiCard label="Total Notes"  value={kpis ? parseInt(kpis.total_count)  : '—'} sub="excl. cancelled" />
        <KpiCard label="Issued"       value={kpis ? parseInt(kpis.issued_count) : '—'} sub={kpis ? fmt(kpis.issued_amount) : ''} color="#15803d" />
        <KpiCard label="Draft"        value={kpis ? parseInt(kpis.draft_count)  : '—'} sub="pending issue"   color="#b45309" />
        <KpiCard label="Total Value"  value={kpis ? fmt(kpis.total_value)        : '—'} sub="issued + draft"  color="#0369a1" />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {['', 'draft', 'issued', 'cancelled'].map(s => (
          <button
            key={s}
            onClick={() => onStatus?.(s)}
            style={{
              padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${statusFilter === s ? PURPLE : BORDER}`,
              background: statusFilter === s ? LIGHT : '#fff',
              color: statusFilter === s ? PURPLE : '#6b7280',
            }}
          >
            {s ? s.charAt(0).toUpperCase() + s.slice(1) : 'All'}
          </button>
        ))}

        <div style={{ width: 1, height: 24, background: BORDER, margin: '0 2px' }} />

        <input
          type="text"
          placeholder={`Search ${partyLabel.toLowerCase()}…`}
          value={supplierFilter}
          onChange={e => onSupplier?.(e.target.value)}
          style={{ padding: '6px 12px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13, width: 160 }}
        />
        <input
          type="date"
          value={fromDate}
          onChange={e => onFrom?.(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }}
        />
        <span style={{ fontSize: 12, color: '#9ca3af' }}>to</span>
        <input
          type="date"
          value={toDate}
          onChange={e => onTo?.(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 7, border: `1px solid ${BORDER}`, fontSize: 13 }}
        />
        {hasFilters && (
          <button
            onClick={onResetFilters}
            style={{ padding: '6px 12px', borderRadius: 7, border: `1px solid ${BORDER}`, background: '#fff', color: '#6b7280', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            ✕ Reset
          </button>
        )}
        {onExport && (
          <button
            onClick={onExport}
            style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 7, border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
          >
            ↓ Export CSV
          </button>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ padding: '14px 18px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#dc2626', fontSize: 13, fontWeight: 600 }}>{error}</span>
          {onRetry && (
            <button
              onClick={onRetry}
              style={{ padding: '6px 16px', borderRadius: 7, background: '#dc2626', color: '#fff', fontWeight: 600, fontSize: 12, border: 'none', cursor: 'pointer' }}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: LIGHT }}>
              {[numLabel, partyLabel, 'Date', origLabel, 'Reason', 'Taxable', 'Tax', 'Total', 'Status', 'Actions'].map(h => (
                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, color: '#374151', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} style={{ padding: 40, textAlign: 'center' }}>
                  <div style={{
                    display: 'inline-block', width: 28, height: 28,
                    border: `3px solid ${BORDER}`, borderTopColor: PURPLE,
                    borderRadius: '50%', animation: 'nl-spin 0.8s linear infinite',
                  }} />
                  <style>{`@keyframes nl-spin { to { transform: rotate(360deg); } }`}</style>
                </td>
              </tr>
            ) : !error && data.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
                  No {isDebit ? 'debit' : 'credit'} notes found.{' '}
                  {hasFilters && (
                    <button
                      onClick={onResetFilters}
                      style={{ marginLeft: 6, color: PURPLE, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}
                    >
                      Clear filters
                    </button>
                  )}
                </td>
              </tr>
            ) : data.map(note => {
              const [bg, col] = STATUS_COLORS[note.status] ?? ['#f3f4f6', '#6b7280'];
              const tax = parseFloat(note.cgst || 0) + parseFloat(note.sgst || 0) + parseFloat(note.igst || 0);
              return (
                <tr key={note.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                  <td style={{ padding: '10px 12px', fontWeight: 700, color: PURPLE, whiteSpace: 'nowrap' }}>
                    {note[numField]}
                  </td>
                  <td style={{ padding: '10px 12px' }}>{note.party_name || '—'}</td>
                  <td style={{ padding: '10px 12px', color: '#6b7280', whiteSpace: 'nowrap' }}>
                    {fmtDate(note[dateField])}
                  </td>
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    {note[origField]
                      ? <span style={{ color: PURPLE, fontWeight: 600 }}>{note[origField]}</span>
                      : <span style={{ color: '#d1d5db' }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 12px', color: '#6b7280' }}>
                    {reasonMap[note.reason] ?? note.reason}
                  </td>
                  <td style={{ padding: '10px 12px' }}>{fmt(note.taxable_value)}</td>
                  <td style={{ padding: '10px 12px' }}>{fmt(tax)}</td>
                  <td style={{ padding: '10px 12px', fontWeight: 700 }}>{fmt(note.total_amount)}</td>
                  <td style={{ padding: '10px 12px' }}>
                    <span style={{ padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: bg, color: col }}>
                      {note.status}
                    </span>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {note.status === 'draft' && (
                        <button
                          onClick={() => onIssue?.(note.id)}
                          style={{ padding: '4px 10px', borderRadius: 6, background: '#dcfce7', color: '#15803d', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}
                        >
                          Issue
                        </button>
                      )}
                      {note.status !== 'cancelled' && (
                        <button
                          onClick={() => onCancel?.(note.id)}
                          style={{ padding: '4px 10px', borderRadius: 6, background: '#fee2e2', color: '#dc2626', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                      )}
                      {onViewPDF && (
                        <button
                          onClick={() => onViewPDF?.(note.id)}
                          style={{ padding: '4px 10px', borderRadius: 6, background: '#eff6ff', color: '#2563eb', fontWeight: 600, fontSize: 11, border: 'none', cursor: 'pointer' }}
                        >
                          PDF
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && total > data.length && (
        <p style={{ marginTop: 10, fontSize: 12, color: '#9ca3af', textAlign: 'right' }}>
          Showing {data.length} of {total} records
        </p>
      )}
    </div>
  );
}
