import { lazy, Suspense, useState } from 'react';

const InvoicesPanel           = lazy(() => import('./Invoices'));
const CustomerOutstandingPanel = lazy(() => import('./CustomerOutstanding'));
const CreditNotesPanel        = lazy(() => import('./CreditNotes'));

const GREEN  = '#059669';
const LIGHT  = '#ecfdf5';
const BORDER = '#a7f3d0';

const PAGE_TABS = [
  { key: 'invoices',     label: 'Invoices'             },
  { key: 'outstanding',  label: 'Customer Outstanding' },
  { key: 'credit-notes', label: 'Credit Notes'         },
];

const TabSuspense = ({ children }) => (
  <Suspense fallback={
    <div style={{ textAlign: 'center', padding: '60px 24px', color: '#9ca3af', fontSize: 14 }}>
      Loading…
    </div>
  }>
    {children}
  </Suspense>
);

export default function ReceivablesPage({ setPage }) {
  const initialTab = (() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      return PAGE_TABS.some(p => p.key === t) ? t : 'invoices';
    } catch { return 'invoices'; }
  })();

  const [activeTab, setActiveTab] = useState(initialTab);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>
          Receivables
        </h2>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' }}>
          Manage invoices, customer balances, and credit notes
        </p>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 20, borderBottom: `2px solid ${BORDER}`, paddingBottom: 0 }}>
        {PAGE_TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '9px 20px',
              borderRadius: '8px 8px 0 0',
              border: `1px solid ${activeTab === t.key ? BORDER : 'transparent'}`,
              borderBottom: activeTab === t.key ? `2px solid ${GREEN}` : '2px solid transparent',
              background: activeTab === t.key ? LIGHT : 'transparent',
              color:      activeTab === t.key ? GREEN  : '#6b7280',
              fontWeight: activeTab === t.key ? 700    : 500,
              fontSize: 13,
              cursor: 'pointer',
              transition: 'all 0.15s',
              marginBottom: -2,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {activeTab === 'invoices'     && <TabSuspense><InvoicesPanel setPage={setPage} /></TabSuspense>}
      {activeTab === 'outstanding'  && <TabSuspense><CustomerOutstandingPanel /></TabSuspense>}
      {activeTab === 'credit-notes' && <TabSuspense><CreditNotesPanel setPage={setPage} /></TabSuspense>}
    </div>
  );
}
