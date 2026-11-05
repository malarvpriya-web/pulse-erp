// frontend/src/features/inventory/pages/RoutePlanning.jsx
//
// Group today's shipments into routes, sequence the stops, and close them as
// the driver arrives.
//
// Two honesty rules are built into this screen rather than left to a footnote:
//
//   Distances are GREAT-CIRCLE unless something better was used. The optimiser
//   is real — nearest-neighbour then 2-opt — but a straight line is not a road,
//   and `distance_source` is shown on every route so swapping in a road matrix
//   later changes the numbers visibly instead of silently rewriting what past
//   routes meant.
//
//   Promises outrank distance. Stops are banded by promised date and optimised
//   WITHIN each band, so a commitment is never resequenced behind a later one
//   just because it is nearer.
import { useState } from 'react';
import { Route } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, Tabs, DataTable, useFetch,
  card, btnP, btnS, input, INK, MUT, fmt, pct,
} from '@/features/_shared/scmKit';

export default function RoutePlanning() {
  const toast = useToast();
  const [tab, setTab] = useState('routes');
  const [selected, setSelected] = useState([]);
  const [routeName, setRouteName] = useState('');

  const routes     = useFetch('/scm/routes');
  const candidates = useFetch('/scm/routes/plan/candidates');
  const carriers   = useFetch('/logistics/carriers');
  const [detail, setDetail] = useState(null);

  const routeRows = routes.data?.routes || (Array.isArray(routes.data) ? routes.data : []);
  const candRows  = candidates.data?.candidates || (Array.isArray(candidates.data) ? candidates.data : []);

  const toggle = (id) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  const build = async () => {
    if (!selected.length) { toast?.error?.('Pick at least one shipment'); return; }
    try {
      const { data } = await api.post('/scm/routes', {
        name: routeName || `Route ${new Date().toISOString().slice(0, 10)}`,
        shipment_ids: selected,
      });
      toast?.success?.(`Route ${data?.route?.route_no || ''} built with ${data?.stops?.length ?? selected.length} stop(s)`);
      setSelected([]); setRouteName('');
      routes.refetch(); candidates.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const optimise = async (r) => {
    try {
      const { data } = await api.post(`/scm/routes/${r.id}/optimise`, {});
      const before = data?.before_km ?? data?.original_distance_km;
      const after  = data?.after_km  ?? data?.total_distance_km;
      toast?.success?.(before && after
        ? `Optimised: ${fmt(before, 1)} km → ${fmt(after, 1)} km (${pct(data?.saving_pct ?? ((before - after) / before) * 100)} saved)`
        : 'Route optimised');
      routes.refetch();
      if (detail?.id === r.id) openDetail(r);
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const openDetail = async (r) => {
    try {
      const { data } = await api.get(`/scm/routes/${r.id}`);
      setDetail(data?.route ? { ...data.route, stops: data.stops || [] } : data);
      setTab('detail');
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const arrive = async (stop) => {
    try {
      await api.patch(`/scm/routes/${detail.id}/stops/${stop.id}`, { status: 'arrived' });
      toast?.success?.('Arrival recorded — the shipment and its order close with it');
      openDetail(detail); routes.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  return (
    <PageShell dock={
      <PageHero
        icon={Route}
        eyebrow="Logistics"
        title="Route Planning"
        subtitle="Group shipments into routes, sequence the stops, and record arrivals"
      />
    }>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Routes" value={fmt(routeRows.length)} />
        <KPI label="Unrouted shipments" value={fmt(candRows.length)} tint="#b45309" />
        <KPI label="Optimised" value={fmt(routeRows.filter(r => r.optimised_at).length)} tint="#15803d" />
        <KPI label="Carriers" value={fmt((carriers.data || []).length)} />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'routes',     label: 'Routes', count: routeRows.length },
        { key: 'candidates', label: 'Plan a route', count: candRows.length },
        { key: 'carriers',   label: 'Carriers', count: (carriers.data || []).length },
        ...(detail ? [{ key: 'detail', label: detail.route_no || 'Route detail' }] : []),
      ]} />

      {tab === 'routes' && (
        <Panel loading={routes.loading} error={routes.error} empty={!routeRows.length}
               emptyHint="No routes built. Use “Plan a route” to group dispatched shipments by destination.">
          <DataTable rows={routeRows} columns={[
            { key: 'route_no', label: 'Route' },
            { key: 'name', label: 'Name' },
            { key: 'route_date', label: 'Date', render: r => r.route_date ? fmtDate(r.route_date) : fmtDate(r.created_at) },
            { key: 'stop_count', label: 'Stops', align: 'right' },
            { key: 'total_weight_kg', label: 'Weight (kg)', align: 'right', render: r => fmt(r.total_weight_kg, 1) },
            { key: 'total_distance_km', label: 'Distance', align: 'right',
              render: r => r.total_distance_km != null ? `${fmt(r.total_distance_km, 1)} km` : '—' },
            { key: 'distance_source', label: 'Basis', render: r => (
              <Pill tone="mute">{r.distance_source || 'not measured'}</Pill>) },
            { key: 'optimised_at', label: 'Optimised', render: r => r.optimised_at ? fmtDate(r.optimised_at) : '—' },
            { key: 'act', label: '', render: r => (
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btnS} onClick={() => openDetail(r)}>Open</button>
                <button style={btnS} onClick={() => optimise(r)}>Optimise</button>
              </div>) },
          ]} />
        </Panel>
      )}

      {tab === 'candidates' && (
        <>
          <div style={{ ...card, marginBottom: 14, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ fontSize: 12, color: MUT, flex: '1 1 260px' }}>Route name
              <input value={routeName} onChange={e => setRouteName(e.target.value)}
                     placeholder="e.g. Pune–Nashik Tuesday"
                     style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
            </label>
            <button style={btnP} onClick={build}>Build route from {selected.length} stop(s)</button>
          </div>
          <Panel loading={candidates.loading} error={candidates.error} empty={!candRows.length}
                 emptyHint="Nothing to route: every dispatched shipment is already on a route, or nothing has been dispatched.">
            <DataTable rows={candRows} keyOf={r => r.shipment_id ?? r.id} columns={[
              { key: 'sel', label: '', render: r => (
                <input type="checkbox" checked={selected.includes(r.shipment_id ?? r.id)}
                       onChange={() => toggle(r.shipment_id ?? r.id)} />) },
              { key: 'dispatch_ref', label: 'Shipment', render: r => r.dispatch_ref || r.shipment_id },
              { key: 'customer_name', label: 'Customer' },
              { key: 'city', label: 'City' },
              { key: 'promised_date', label: 'Promised', render: r => r.promised_date ? fmtDate(r.promised_date) : '—' },
              { key: 'weight_kg', label: 'Weight (kg)', align: 'right', render: r => fmt(r.weight_kg, 1) },
              { key: 'geocoded', label: '', render: r => (r.latitude != null && r.longitude != null)
                ? <Pill tone="ok">located</Pill> : <Pill tone="mute">no coordinates</Pill> },
            ]} />
          </Panel>
        </>
      )}

      {tab === 'carriers' && (
        <Panel loading={carriers.loading} error={carriers.error} empty={!(carriers.data || []).length}
               emptyHint="No carriers. Shipments will keep carrying a free-text courier name, which cannot be scored.">
          <DataTable rows={carriers.data || []} columns={[
            { key: 'carrier_code', label: 'Code' },
            { key: 'carrier_name', label: 'Carrier' },
            { key: 'mode', label: 'Mode' },
            { key: 'standard_lead_days', label: 'Lead (d)', align: 'right' },
            { key: 'shipment_count', label: 'Shipments', align: 'right' },
            { key: 'on_time_pct', label: 'On time', align: 'right',
              render: c => c.on_time_pct === null
                ? <span style={{ color: MUT, fontSize: 11 }}>not measurable yet</span>
                : pct(c.on_time_pct) },
            { key: 'status', label: 'Status', render: c => <Pill tone={c.status === 'active' ? 'ok' : 'mute'}>{c.status}</Pill> },
          ]} />
        </Panel>
      )}

      {tab === 'detail' && detail && (
        <>
          <div style={{ ...card, marginBottom: 14, fontSize: 13, color: INK }}>
            <strong>{detail.route_no}</strong> · {fmt(detail.stop_count)} stop(s) ·{' '}
            {detail.total_distance_km != null ? `${fmt(detail.total_distance_km, 1)} km` : 'distance not computed'} ·{' '}
            <Pill tone="mute">{detail.distance_source || 'not measured'}</Pill>
            <div style={{ fontSize: 11, color: MUT, marginTop: 6 }}>
              Stops are banded by promised date and optimised within each band, so an earlier commitment is never
              pushed behind a later one to save distance.
            </div>
          </div>
          <DataTable rows={detail.stops || []} columns={[
            { key: 'stop_seq', label: '#', align: 'right' },
            { key: 'customer_name', label: 'Customer' },
            { key: 'city', label: 'City' },
            { key: 'promised_date', label: 'Promised', render: s => s.promised_date ? fmtDate(s.promised_date) : '—' },
            { key: 'leg_distance_km', label: 'Leg', align: 'right', render: s => s.leg_distance_km != null ? `${fmt(s.leg_distance_km, 1)} km` : '—' },
            { key: 'status', label: 'Status', render: s => (
              <Pill tone={s.status === 'arrived' ? 'ok' : 'warn'}>{s.status || 'pending'}</Pill>) },
            { key: 'act', label: '', render: s => s.status !== 'arrived'
              ? <button style={btnS} onClick={() => arrive(s)}>Arrived</button> : null },
          ]} />
        </>
      )}
    </PageShell>
  );
}
