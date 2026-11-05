// frontend/src/features/inventory/pages/InventoryHealth.jsx
//
// The stock nobody is looking at: excess, obsolete, slow-moving, near-expiry,
// and everything currently in transit in either direction.
//
// All five were computed by endpoints with no screen. Excess, obsolete and
// slow-moving are deliberately kept as three separate lists rather than one
// "problem stock" number, because they call for three different actions — sell
// it down, write it off, or change how it is planned. Rolling them together is
// how a write-off decision gets made by accident.
import { useState } from 'react';
import { HeartPulse } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, Tabs, DataTable, useFetch,
  card, btnS, input, INK, MUT, fmt, inr,
} from '@/features/_shared/scmKit';

export default function InventoryHealth() {
  const toast = useToast();
  const [tab, setTab] = useState('excess');

  const policy   = useFetch('/inventory/scm/policy');
  const eo       = useFetch('/inventory/scm/excess-obsolete');
  const expiry   = useFetch('/inventory/scm/near-expiry');
  const transit  = useFetch('/inventory/scm/in-transit');

  const [draft, setDraft] = useState(null);
  const pol = draft ?? policy.data ?? {};

  const savePolicy = async () => {
    try {
      await api.put('/inventory/scm/policy', pol);
      toast?.success?.('Policy saved — the three lists below are recomputed against it');
      setDraft(null); policy.refetch(); eo.refetch(); expiry.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  // ── API contract (verified against the live endpoints 2026-09-16) ─────────
  // Every read below used to be one level too shallow, and the page had never
  // rendered because of it:
  //   /excess-obsolete -> { policy, excess|slow_moving|obsolete: {count,value,items}, … }
  //   /near-expiry     -> { horizon_days, count, lots }          (never `items`)
  //   /in-transit      -> { inbound|outbound: {lines,value,items} }
  // Reading `eo.data?.excess` handed valueOf() the WRAPPER OBJECT, so the very
  // first KPI threw "list.reduce is not a function" and the ErrorBoundary
  // replaced the whole page — which, now that this page is a tab of Inventory ›
  // Planning, took the hub's tab strip down with it.
  const asArray  = (v) => (Array.isArray(v) ? v : []);
  const excess   = asArray(eo.data?.excess?.items);
  const obsolete = asArray(eo.data?.obsolete?.items);
  const slow     = asArray(eo.data?.slow_moving?.items);
  const expiring = asArray(expiry.data?.lots);
  const inbound  = asArray(transit.data?.inbound?.items);
  const outbound = asArray(transit.data?.outbound?.items);

  // The server already totals each bucket; fall back to summing the rows only
  // if that is missing. `asArray` also keeps a future shape change from taking
  // the page down again — a wrong total is a bug, a blank page is an outage.
  const valueOf = (list) => asArray(list).reduce((s, r) => s + Number(r.value || r.stock_value || 0), 0);
  const bucketValue = (b, list) => (b?.value != null ? Number(b.value) : valueOf(list));

  const field = (key, label, hint) => (
    <label style={{ fontSize: 12, color: MUT, display: 'block' }}>
      {label}
      <input type="number" value={pol[key] ?? ''} style={{ ...input, display: 'block', marginTop: 2, width: 120 }}
             onChange={e => setDraft({ ...pol, [key]: e.target.value === '' ? null : Number(e.target.value) })} />
      <span style={{ fontSize: 10, color: MUT, opacity: 0.8 }}>{hint}</span>
    </label>
  );

  return (
    <PageShell dock={
      <PageHero
        icon={HeartPulse}
        eyebrow="Inventory"
        title="Inventory Health"
        subtitle="Excess, obsolete, slow-moving, near-expiry and in-transit stock — against a policy you set"
      />
    }>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Excess items" value={fmt(excess.length)} tint="#b45309" hint={inr(bucketValue(eo.data?.excess, excess))} />
        <KPI label="Obsolete items" value={fmt(obsolete.length)} tint="#b91c1c" hint={inr(bucketValue(eo.data?.obsolete, obsolete))} />
        <KPI label="Slow moving" value={fmt(slow.length)} tint="#1d4ed8" hint={inr(bucketValue(eo.data?.slow_moving, slow))} />
        <KPI label="Near expiry" value={fmt(expiring.length)} tint="#b45309"
             hint={pol.near_expiry_days ? `Within ${pol.near_expiry_days} days` : null} />
        <KPI label="In transit (in)" value={fmt(inbound.length)} hint={inr(transit.data?.inbound?.value)} />
        <KPI label="In transit (out)" value={fmt(outbound.length)} hint={inr(transit.data?.outbound?.value)} />
      </div>

      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Policy</div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {field('excess_cover_days', 'Excess above (days cover)', 'Stock beyond this much demand cover')}
          {field('obsolete_no_movement_days', 'Obsolete after (days idle)', 'No movement for this long')}
          {field('slow_moving_turns', 'Slow below (turns/yr)', 'Annual inventory turns')}
          {field('near_expiry_days', 'Near expiry (days)', 'Lots expiring within this window')}
          <button style={btnS} onClick={savePolicy} disabled={!draft}>Save policy</button>
        </div>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'excess',   label: 'Excess',       count: excess.length },
        { key: 'obsolete', label: 'Obsolete',     count: obsolete.length },
        { key: 'slow',     label: 'Slow moving',  count: slow.length },
        { key: 'expiry',   label: 'Near expiry',  count: expiring.length },
        { key: 'transit',  label: 'In transit',   count: inbound.length + outbound.length },
      ]} />

      {['excess', 'obsolete', 'slow'].includes(tab) && (
        <Panel loading={eo.loading} error={eo.error}
               empty={!(tab === 'excess' ? excess : tab === 'obsolete' ? obsolete : slow).length}
               emptyHint="Nothing meets this condition against the current policy — which on healthy stock is the right answer, not a missing feature.">
          <DataTable
            rows={tab === 'excess' ? excess : tab === 'obsolete' ? obsolete : slow}
            keyOf={r => r.item_id ?? r.id}
            columns={[
              { key: 'item_code', label: 'Item', render: r => (
                <div><div style={{ fontWeight: 700 }}>{r.item_code}</div>
                     <div style={{ fontSize: 11, color: MUT }}>{r.item_name}</div></div>) },
              { key: 'on_hand', label: 'On hand', align: 'right', render: r => fmt(r.on_hand ?? r.current_stock, 2) },
              { key: 'cover_days', label: 'Cover (d)', align: 'right', render: r => fmt(r.cover_days ?? r.days_cover, 0) },
              { key: 'last_issue', label: 'Last moved', render: r => r.last_issue ? fmtDate(r.last_issue) : 'never' },
              { key: 'turns', label: 'Turns/yr', align: 'right', render: r => fmt(r.turns ?? r.turnover, 2) },
              { key: 'value', label: 'Value', align: 'right', render: r => inr(r.value ?? r.stock_value) },
              { key: 'reason', label: 'Why', render: r => <span style={{ fontSize: 11, color: MUT }}>{r.reason || '—'}</span> },
            ]} />
        </Panel>
      )}

      {tab === 'expiry' && (
        <Panel loading={expiry.loading} error={expiry.error} empty={!expiring.length}
               emptyHint="No lot is inside the near-expiry window. Lots without an expiry date are not guessed at.">
          <DataTable rows={expiring} columns={[
            { key: 'item_code', label: 'Item' },
            { key: 'batch_number', label: 'Lot' },
            { key: 'quantity_available', label: 'Available', align: 'right', render: r => fmt(r.quantity_available, 2) },
            { key: 'expiry_date', label: 'Expires', render: r => fmtDate(r.expiry_date) },
            { key: 'days_to_expiry', label: 'In (days)', align: 'right' },
            { key: 'status', label: 'Status', render: r => <Pill tone={Number(r.days_to_expiry) < 0 ? 'bad' : 'warn'}>{r.status || (Number(r.days_to_expiry) < 0 ? 'expired' : 'near expiry')}</Pill> },
          ]} />
        </Panel>
      )}

      {tab === 'transit' && (
        <Panel loading={transit.loading} error={transit.error} empty={!inbound.length && !outbound.length}
               emptyHint="Nothing is in transit. Inbound counts dispatched-but-not-received; outbound counts shipped-but-not-delivered.">
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, margin: '4px 0 6px' }}>Inbound</div>
          <DataTable rows={inbound} empty="Nothing inbound." columns={[
            { key: 'reference', label: 'Reference', render: r => r.reference || '—' },
            { key: 'counterparty', label: 'From', render: r => r.counterparty || '—' },
            { key: 'item_name', label: 'Item' },
            { key: 'quantity', label: 'Qty', align: 'right', render: r => fmt(r.quantity, 2) },
            { key: 'due_date', label: 'Expected', render: r => r.due_date ? fmtDate(r.due_date) : '—' },
            { key: 'overdue', label: '', render: r => r.overdue ? <Pill tone="bad">overdue</Pill> : null },
            { key: 'value', label: 'Value', align: 'right', render: r => inr(r.value) },
          ]} />
          <div style={{ fontSize: 12, fontWeight: 700, color: INK, margin: '14px 0 6px' }}>Outbound</div>
          <DataTable rows={outbound} empty="Nothing outbound." columns={[
            { key: 'reference', label: 'Reference', render: r => r.reference || '—' },
            { key: 'counterparty', label: 'To', render: r => r.counterparty || '—' },
            { key: 'item_name', label: 'Item' },
            { key: 'quantity', label: 'Qty', align: 'right', render: r => fmt(r.quantity, 2) },
            { key: 'due_date', label: 'Promised', render: r => r.due_date ? fmtDate(r.due_date) : '—' },
            { key: 'overdue', label: '', render: r => r.overdue ? <Pill tone="bad">overdue</Pill> : null },
            { key: 'value', label: 'Value', align: 'right', render: r => inr(r.value) },
          ]} />
        </Panel>
      )}
    </PageShell>
  );
}
