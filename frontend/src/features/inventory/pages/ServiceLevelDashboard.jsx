// frontend/src/features/inventory/pages/ServiceLevelDashboard.jsx
//
// OTIF, fill rate, order fulfilment rate, stockout rate, order accuracy and
// delivery delay — the six measures of whether customers actually got what they
// were promised.
//
// The engine behind this was built and mounted and had no screen, which meant
// six separate SCA components were "implemented" and unreadable. Two things in
// here are load-bearing and easy to get wrong:
//
//   Everything is measured against the PROMISE, never the revised delivery
//   date. Re-promising a late order and then scoring it against the new date is
//   how an OTIF of 98% coexists with angry customers.
//
//   Orders that cannot be measured — no promise recorded, no delivery recorded —
//   are counted and shown, not quietly treated as successes.
import { useState } from 'react';
import { Target } from 'lucide-react';
import { fmtDate } from '@/utils/dateFormatter';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, Tabs, DataTable, useFetch,
  card, input, INK, MUT, fmt, pct,
} from '@/features/_shared/scmKit';

export default function ServiceLevelDashboard() {
  const [tab, setTab] = useState('summary');
  const [days, setDays] = useState(90);

  const summary = useFetch('/service-level/summary', { params: { days } });
  const trend   = useFetch('/service-level/trend', { params: { days } });
  const late    = useFetch('/service-level/late-orders', { params: { days } });

  const s = summary.data || {};
  const trendRows = trend.data?.periods || trend.data?.trend || (Array.isArray(trend.data) ? trend.data : []);
  const lateRows  = late.data?.orders || (Array.isArray(late.data) ? late.data : []);

  const tone = (v, good = 95, ok = 85) =>
    v === null || v === undefined ? '#6b7280' : v >= good ? '#15803d' : v >= ok ? '#b45309' : '#b91c1c';

  return (
    <PageShell dock={
      <PageHero
        icon={Target}
        eyebrow="Fulfilment"
        title="Service Level"
        subtitle="OTIF, fill rate, fulfilment, stockouts and accuracy — all scored against the original promise"
      />
    }>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: MUT }}>Window (days)
          <input type="number" min={7} max={730} value={days} onChange={e => setDays(e.target.value)}
                 style={{ ...input, display: 'block', marginTop: 2, width: 100 }} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="OTIF" value={s.otif_pct != null ? pct(s.otif_pct) : null} tint={tone(s.otif_pct)}
             hint="On time AND in full, against the promise" />
        <KPI label="Fill rate" value={s.fill_rate_pct != null ? pct(s.fill_rate_pct) : null} tint={tone(s.fill_rate_pct)}
             hint="Quantity shipped ÷ ordered" />
        <KPI label="Order fulfilment" value={s.fulfilment_rate_pct != null ? pct(s.fulfilment_rate_pct) : null} tint={tone(s.fulfilment_rate_pct)} />
        <KPI label="Order accuracy" value={s.order_accuracy_pct != null ? pct(s.order_accuracy_pct) : null} tint={tone(s.order_accuracy_pct)} />
        <KPI label="Stockout rate" value={s.stockout_rate_pct != null ? pct(s.stockout_rate_pct) : null}
             tint={tone(100 - Number(s.stockout_rate_pct ?? 0))} hint="Lines that could not be served from stock" />
        <KPI label="Avg delay" value={s.avg_delay_days != null ? `${fmt(s.avg_delay_days, 1)} d` : null} tint="#b45309" />
      </div>

      {s.unmeasurable_orders > 0 && (
        <div style={{ ...card, marginBottom: 16, borderColor: '#fde68a', background: '#fffbeb', fontSize: 13, color: INK }}>
          <strong>{fmt(s.unmeasurable_orders)} order(s) cannot be scored</strong> — they carry no promised date, or no
          delivery was recorded. They are excluded from every percentage above rather than counted as successes.
        </div>
      )}

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'summary', label: 'Breakdown' },
        { key: 'trend',   label: 'Trend', count: trendRows.length },
        { key: 'late',    label: 'Late orders', count: lateRows.length },
      ]} />

      {tab === 'summary' && (
        <Panel loading={summary.loading} error={summary.error} empty={!s || !Object.keys(s).length}
               emptyHint="No delivered orders in this window.">
          <DataTable
            rows={[
              { k: 'Orders in window', v: fmt(s.orders_total), note: 'Delivered or due within the window' },
              { k: 'Delivered on time', v: fmt(s.on_time_orders), note: 'Actual delivery ≤ promised date' },
              { k: 'Delivered in full', v: fmt(s.in_full_orders), note: 'Every line shipped complete' },
              { k: 'Delivered on time and in full', v: fmt(s.otif_orders), note: 'The OTIF numerator' },
              { k: 'Measurable orders', v: fmt(s.measurable_orders), note: 'Have both a promise and a delivery' },
              { k: 'Unmeasurable orders', v: fmt(s.unmeasurable_orders), note: 'Reported, never counted as a success' },
              { k: 'Lines ordered', v: fmt(s.lines_total) },
              { k: 'Lines short-shipped', v: fmt(s.lines_short) },
            ].filter(r => r.v !== '—')}
            keyOf={r => r.k}
            columns={[
              { key: 'k', label: 'Measure' },
              { key: 'v', label: 'Value', align: 'right' },
              { key: 'note', label: 'Definition', render: r => <span style={{ fontSize: 11, color: MUT }}>{r.note || ''}</span> },
            ]} />
        </Panel>
      )}

      {tab === 'trend' && (
        <Panel loading={trend.loading} error={trend.error} empty={!trendRows.length}
               emptyHint="Not enough delivered history in this window to draw a trend.">
          <DataTable rows={trendRows} keyOf={(r, i) => r.period || i} columns={[
            { key: 'period', label: 'Period', render: r => r.period_label || r.period || fmtDate(r.period_start) },
            { key: 'orders', label: 'Orders', align: 'right', render: r => fmt(r.orders ?? r.orders_total) },
            { key: 'otif_pct', label: 'OTIF', align: 'right', render: r => r.otif_pct != null ? pct(r.otif_pct) : '—' },
            { key: 'fill_rate_pct', label: 'Fill rate', align: 'right', render: r => r.fill_rate_pct != null ? pct(r.fill_rate_pct) : '—' },
            { key: 'avg_delay_days', label: 'Avg delay', align: 'right', render: r => r.avg_delay_days != null ? `${fmt(r.avg_delay_days, 1)} d` : '—' },
          ]} />
        </Panel>
      )}

      {tab === 'late' && (
        <Panel loading={late.loading} error={late.error} empty={!lateRows.length}
               emptyHint="No order in this window missed its promise.">
          <DataTable rows={lateRows} columns={[
            { key: 'order_number', label: 'Order' },
            { key: 'customer_name', label: 'Customer' },
            { key: 'promised_date', label: 'Promised', render: r => r.promised_date ? fmtDate(r.promised_date) : '—' },
            { key: 'actual_delivery', label: 'Delivered', render: r => r.actual_delivery ? fmtDate(r.actual_delivery) : 'not yet' },
            { key: 'delay_days', label: 'Late by', align: 'right', render: r => r.delay_days != null ? `${fmt(r.delay_days)} d` : '—' },
            { key: 'status', label: 'Status', render: r => (
              <Pill tone={r.actual_delivery ? 'warn' : 'bad'}>{r.actual_delivery ? 'delivered late' : 'still open'}</Pill>) },
          ]} />
        </Panel>
      )}
    </PageShell>
  );
}
