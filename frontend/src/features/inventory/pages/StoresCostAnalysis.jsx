// frontend/src/features/inventory/pages/StoresCostAnalysis.jsx
// Management report: department-wise store inventory cost analysis.
// EOQ, ROP, orders/year, order interval, max/avg inventory, holding + setup
// cost and ABC classification — per store (Admin / Service / R&D / Production)
// and consolidated across all stores.
import { useEffect, useRef, useState } from 'react';
import { Package, IndianRupee, TrendingUp, Archive, Settings, Wallet } from 'lucide-react';
import api from '@/services/api/client';
import { PageLayout, PageHeader, KPICardGrid, KPICard, ContentCard, TableContainer, EmptyState } from '@/components/pulse-ui';

const COLUMNS = [
  'item_code', 'item_name', 'unit_of_measure', 'abc_category',
  'annual_demand', 'unit_cost', 'current_stock', 'stock_value',
  'eoq', 'num_orders', 'days_between_orders', 'rop',
  'max_inventory', 'avg_inventory',
  'annual_holding_cost', 'annual_setup_cost', 'total_annual_inventory_cost',
];

const HEADERS = {
  item_code: 'Item Code', item_name: 'Item Name', unit_of_measure: 'UOM',
  abc_category: 'ABC', annual_demand: 'Annual Demand', unit_cost: 'Unit Cost (₹)',
  current_stock: 'Current Stock', stock_value: 'Stock Value (₹)',
  eoq: 'EOQ', num_orders: 'Orders / Year', days_between_orders: 'Days Between Orders',
  rop: 'ROP', max_inventory: 'Max Inventory', avg_inventory: 'Avg Inventory',
  annual_holding_cost: 'Annual Holding Cost (₹)', annual_setup_cost: 'Annual Setup Cost (₹)',
  total_annual_inventory_cost: 'Total Annual Cost (₹)',
};

const NUMERIC_COLS = new Set(COLUMNS.filter(c =>
  !['item_code', 'item_name', 'unit_of_measure', 'abc_category'].includes(c)));

const ABC_COLORS = { A: ['#d1fae5', '#16a34a'], B: ['#fef3c7', '#d97706'], C: ['#f3f4f6', '#6b7280'] };

function fmtNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function fmtMoney(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '—' : '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function exportCSV(items, tabLabel) {
  const header = COLUMNS.map(c => HEADERS[c]).join(',');
  const body = items.map(r =>
    COLUMNS.map(c => {
      const v = String(r[c] ?? '');
      return v.includes(',') ? `"${v}"` : v;
    }).join(',')
  ).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stores-cost-analysis-${tabLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function AbcBadge({ cat }) {
  const [bg, color] = ABC_COLORS[cat] || ABC_COLORS.C;
  return (
    <span style={{ fontWeight: 700, color, background: bg, padding: '2px 10px', borderRadius: 8, fontSize: 12 }}>
      {cat}
    </span>
  );
}

function ItemsTable({ items }) {
  return (
    <TableContainer
      isEmpty={items.length === 0}
      emptyState={<EmptyState title="No stock movements recorded for this store yet." />}
      rowCount={items.length}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f9fafb' }}>
            {COLUMNS.map(c => (
              <th key={c} style={{ padding: '9px 12px', textAlign: NUMERIC_COLS.has(c) ? 'right' : 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' }}>
                {HEADERS[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((row, i) => (
            <tr key={row.item_id ?? i} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
              {COLUMNS.map(c => (
                <td key={c} style={{ padding: '8px 12px', textAlign: NUMERIC_COLS.has(c) ? 'right' : 'left', whiteSpace: 'nowrap' }}>
                  {c === 'abc_category' ? <AbcBadge cat={row[c]} /> : NUMERIC_COLS.has(c) ? fmtNum(row[c]) : String(row[c] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableContainer>
  );
}

function TotalsPanel({ totals, config }) {
  const abc = totals?.abc || { A: { count: 0 }, B: { count: 0 }, C: { count: 0 } };
  return (
    <>
      <KPICardGrid>
        <KPICard icon={Package} label="Items" value={fmtNum(totals?.item_count ?? 0)} />
        <KPICard icon={IndianRupee} label="Stock Value" value={fmtMoney(totals?.stock_value)} />
        <KPICard icon={TrendingUp} label="Annual Consumption" value={fmtMoney(totals?.annual_consumption_value)} sub="last 12 months" />
        <KPICard icon={Archive} label="Annual Holding Cost" value={fmtMoney(totals?.annual_holding_cost)} sub={`@ ${(config?.holding_cost_rate_annual * 100 || 0).toFixed(0)}% of unit cost`} />
        <KPICard icon={Settings} label="Annual Setup Cost" value={fmtMoney(totals?.annual_setup_cost)} sub={`₹${fmtNum(config?.ordering_cost)} per order`} />
        <KPICard icon={Wallet} label="Total Annual Inventory Cost" value={fmtMoney(totals?.total_annual_inventory_cost)} sub="purchase + holding + setup" tone="success" />
      </KPICardGrid>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {['A', 'B', 'C'].map(c => (
          <div key={c} style={{ flex: '1 1 200px' }}>
            <ContentCard>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <AbcBadge cat={c} />
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#1f2937' }}>{abc[c]?.count ?? 0} items</div>
                  <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmtMoney(abc[c]?.value)} consumption value</div>
                </div>
              </div>
            </ContentCard>
          </div>
        ))}
      </div>
    </>
  );
}

export default function StoresCostAnalysis() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('consolidated');
  const abortRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api.get('/inventory/dept-cost-analysis', { signal: controller.signal });
        setData(res.data);
      } catch (e) {
        if (e.name === 'CanceledError' || e.code === 'ERR_CANCELED') return;
        setError(e?.response?.data?.error || e.message || 'Failed to load analysis');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const departments = data?.departments || [];
  const tabs = [
    { key: 'consolidated', label: 'All Stores (Consolidated)' },
    ...departments.map(d => ({ key: d.department, label: d.label })),
  ];
  const active = activeTab === 'consolidated'
    ? { label: 'All Stores', items: data?.consolidated?.items || [], totals: data?.consolidated?.totals, warehouses: [] }
    : departments.find(d => d.department === activeTab) || { label: '', items: [], totals: null, warehouses: [] };

  return (
    <PageLayout>
      <PageHeader
        description="EOQ · ROP · ABC · holding & setup cost — per department store and consolidated (12-month consumption)"
        actions={active.items.length > 0 && (
          <button onClick={() => exportCSV(active.items, active.label)} className="pl-icon-btn">⬇ Export CSV</button>
        )}
        filters={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tabs.map(t => (
              <button
                key={t.key}
                type="button"
                className={`pl-icon-btn${activeTab === t.key ? ' pl-active' : ''}`}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />

      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 16px', marginBottom: 16, fontSize: 13, fontWeight: 600 }}>
          {error}
        </div>
      )}

      {loading && (
        <div style={{ textAlign: 'center', padding: 48, color: '#9ca3af', fontSize: 14 }}>Loading cost analysis…</div>
      )}

      {!loading && !error && data && (
        <>
          {activeTab !== 'consolidated' && active.warehouses?.length > 0 && (
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
              Warehouses: {active.warehouses.map(w => `${w.name}${w.code ? ` (${w.code})` : ''}`).join(', ')}
            </div>
          )}
          <TotalsPanel totals={active.totals} config={data.config} />
          <ItemsTable items={active.items} />
        </>
      )}
    </PageLayout>
  );
}
