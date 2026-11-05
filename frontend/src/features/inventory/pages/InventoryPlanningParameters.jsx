// frontend/src/features/inventory/pages/InventoryPlanningParameters.jsx
//
// EOQ, reorder point, safety stock and ABC/XYZ/FSN — computed, persisted, and
// for the first time visible to the person who has to live with them.
//
// The parameters were already being computed and written back. What nobody
// could do was LOOK at them: which figure MRP is honouring, whether it came
// from a calculation or from someone's memory, and what the projection says
// happens next. The manual-pin column matters most — `safety_stock_source`
// decides whether a recompute may overwrite a planner's decision, and until
// now that was invisible.
import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, Tabs, DataTable, useFetch,
  card, btnP, btnS, input, INK, MUT, fmt, inr, pct,
} from '@/features/_shared/scmKit';

const RISK_TONE = { critical: 'bad', high: 'bad', medium: 'warn', low: 'calm', none: 'ok', no_demand_signal: 'mute' };

export default function InventoryPlanningParameters() {
  const toast = useToast();
  const [tab, setTab] = useState('parameters');
  const [busy, setBusy] = useState(false);
  const [horizon, setHorizon] = useState(90);

  const params    = useFetch('/inventory/planning/parameters');
  const settings  = useFetch('/inventory/planning/settings');
  const abc       = useFetch('/inventory/planning/abc');
  const recon     = useFetch('/inventory/planning/reconciliation');
  const projected = useFetch('/inventory/planning/projected-stock', { params: { horizon_days: horizon } });
  const optim     = useFetch('/inventory/planning/optimisation');
  const leadTimes = useFetch('/inventory/planning/lead-times');

  const rows = Array.isArray(params.data) ? params.data : (params.data?.items || []);
  const proj = projected.data?.items || [];

  const recompute = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/inventory/planning/recompute', {});
      toast?.success?.(`Recomputed ${data?.run?.items_computed ?? data?.items_computed ?? rows.length} item(s) — manual pins left alone`);
      params.refetch(); abc.refetch(); optim.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const measureLeadTimes = async () => {
    try {
      const { data } = await api.post('/inventory/planning/lead-times/measure', { min_observations: 2 });
      toast?.success?.(`Measured ${data?.measured ?? 0} item(s) from receipts; applied to ${data?.applied ?? 0}`);
      leadTimes.refetch(); params.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const reconcile = async () => {
    try {
      const { data } = await api.post('/inventory/planning/reconcile', {});
      toast?.success?.(`Reconciled ${data?.repaired ?? 0} item(s) to the ledger`);
      recon.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const pin = async (row) => {
    const v = window.prompt(`Pin safety stock for ${row.item_code}. A pinned value survives every recompute.`, row.safety_stock ?? '');
    if (v === null) return;
    const qty = Number(v);
    if (!Number.isFinite(qty) || qty < 0) { toast?.error?.('Enter a non-negative quantity'); return; }
    try {
      await api.put(`/inventory/planning/parameters/${row.id || row.item_id}`, {
        safety_stock: qty, safety_stock_source: 'manual',
      });
      toast?.success?.('Pinned — recompute will not overwrite it');
      params.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const drift = recon.data?.divergent_items ?? recon.data?.divergent ?? null;
  const atRisk = projected.data?.summary?.at_risk ?? null;

  return (
    <PageShell dock={
      <PageHero
        icon={SlidersHorizontal}
        eyebrow="Inventory · Planning"
        title="Planning Parameters"
        subtitle="EOQ, reorder point, statistical safety stock and classification — with the projection they produce"
      />
    }>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        <button onClick={recompute} disabled={busy} style={{ ...btnP, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Computing…' : '▶ Recompute parameters'}
        </button>
        <button onClick={measureLeadTimes} style={btnS}>Measure lead times from receipts</button>
        <button onClick={reconcile} style={btnS}>Reconcile on-hand to ledger</button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Items planned" value={fmt(rows.length)} />
        <KPI label="Service level" value={settings.data?.service_level_pct ? pct(settings.data.service_level_pct, 0) : null}
             hint="Default; A/B/C items are optimised separately" />
        <KPI label="At stockout risk" value={atRisk === null ? null : fmt(atRisk)} tint="#b91c1c"
             hint={`Within ${horizon} days`} />
        <KPI label="Ledger divergence" value={drift === null ? null : fmt(drift)}
             tint={drift ? '#b91c1c' : '#15803d'}
             hint={drift ? 'Treat as a defect in whatever wrote it' : 'current_stock matches the ledger'} />
        <KPI label="Pooling saving" value={optim.data?.summary?.echelon_pooling_saving != null
               ? inr(optim.data.summary.echelon_pooling_saving) : null}
             tint="#1d4ed8" hint="If multi-location cover were pooled" />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'parameters', label: 'Parameters', count: rows.length },
        { key: 'projection', label: 'Projected stock', count: proj.length },
        { key: 'abc',        label: 'Classification' },
        { key: 'optimise',   label: 'Optimisation' },
        { key: 'leadtime',   label: 'Lead times' },
      ]} />

      {tab === 'parameters' && (
        <Panel loading={params.loading} error={params.error} empty={!rows.length}
               emptyHint="Run a recompute. Items without enough demand history get NULL parameters and a stated reason — never a zero.">
          <DataTable rows={rows} columns={[
            { key: 'item_code', label: 'Item', render: r => (
              <div><div style={{ fontWeight: 700 }}>{r.item_code}</div>
                   <div style={{ fontSize: 11, color: MUT }}>{r.item_name}</div></div>) },
            { key: 'abc_class_calculated', label: 'ABC', render: r => (
              <Pill tone={r.abc_class_calculated === 'A' ? 'bad' : r.abc_class_calculated === 'B' ? 'warn' : 'mute'}>
                {r.abc_class_calculated || '—'}</Pill>) },
            { key: 'eoq', label: 'EOQ', align: 'right', render: r => fmt(r.eoq, 2) },
            { key: 'safety_stock', label: 'Safety stock', align: 'right', render: r => (
              <div>{fmt(r.safety_stock, 2)}
                <div style={{ fontSize: 10, color: MUT }}>
                  {r.safety_stock_source === 'manual' ? 'pinned' : `calc ${fmt(r.safety_stock_calculated, 2)}`}</div>
              </div>) },
            { key: 'reorder_point_calculated', label: 'ROP', align: 'right', render: r => (
              <div>{fmt(r.reorder_point_calculated ?? r.reorder_level, 2)}
                <div style={{ fontSize: 10, color: MUT }}>{r.reorder_point_source || 'manual'}</div></div>) },
            { key: 'lead_time_days', label: 'Lead (d)', align: 'right' },
            { key: 'demand_cv', label: 'CV', align: 'right', render: r => fmt(r.demand_cv, 2) },
            { key: 'skip_reason', label: 'Note', render: r => r.skip_reason
              ? <span style={{ fontSize: 11, color: MUT }}>{r.skip_reason}</span> : '—' },
            { key: 'act', label: '', render: r => <button style={btnS} onClick={() => pin(r)}>Pin SS</button> },
          ]} />
        </Panel>
      )}

      {tab === 'projection' && (
        <>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: MUT }}>Horizon (days)
              <input type="number" min={7} max={365} value={horizon} onChange={e => setHorizon(e.target.value)}
                     style={{ ...input, display: 'block', marginTop: 2, width: 100 }} />
            </label>
            <button style={btnS} onClick={projected.refetch}>Reproject</button>
          </div>
          <Panel loading={projected.loading} error={projected.error} empty={!proj.length}
                 emptyHint="No active items to project.">
            <DataTable rows={proj} keyOf={r => r.item_id} columns={[
              { key: 'item_code', label: 'Item' },
              { key: 'on_hand', label: 'On hand', align: 'right', render: r => fmt(r.on_hand, 2) },
              { key: 'safety_stock', label: 'Safety', align: 'right', render: r => fmt(r.safety_stock, 2) },
              { key: 'min_projected', label: 'Lowest projected', align: 'right', render: r => fmt(r.min_projected, 2) },
              { key: 'days_to_safety_breach', label: 'Breaches safety in', align: 'right',
                render: r => r.days_to_safety_breach === null ? '—' : `${r.days_to_safety_breach} d` },
              { key: 'days_to_stockout', label: 'Runs out in', align: 'right',
                render: r => r.days_to_stockout === null ? '—' : `${r.days_to_stockout} d` },
              { key: 'lead_time_days', label: 'Lead (d)', align: 'right' },
              { key: 'stockout_risk', label: 'Risk', render: r => (
                <Pill tone={RISK_TONE[r.stockout_risk] || 'mute'}>
                  {r.stockout_risk === 'no_demand_signal' ? 'no demand signal' : r.stockout_risk}</Pill>) },
            ]} />
          </Panel>
        </>
      )}

      {tab === 'abc' && (
        <Panel loading={abc.loading} error={abc.error} empty={!(abc.data?.items || abc.data || []).length}
               emptyHint="Recompute to classify items by annual consumption value.">
          <DataTable rows={abc.data?.items || abc.data || []} columns={[
            { key: 'item_code', label: 'Item' },
            { key: 'abc_class', label: 'ABC', render: r => <Pill tone={(r.abc_class || r.abc_class_calculated) === 'A' ? 'bad' : 'mute'}>{r.abc_class || r.abc_class_calculated || '—'}</Pill> },
            { key: 'xyz_class', label: 'XYZ', render: r => <Pill tone="calm">{r.xyz_class || '—'}</Pill> },
            { key: 'fsn_class', label: 'FSN', render: r => <Pill tone="mute">{r.fsn_class || '—'}</Pill> },
            { key: 'annual_consumption_value', label: 'Annual value', align: 'right', render: r => inr(r.annual_consumption_value) },
            { key: 'abc_cumulative_pct', label: 'Cumulative', align: 'right', render: r => pct(r.abc_cumulative_pct) },
          ]} />
        </Panel>
      )}

      {tab === 'optimise' && (
        <Panel loading={optim.loading} error={optim.error} empty={!(optim.data?.recommendations || []).length}
               emptyHint="Nothing to optimise until parameters have been computed.">
          <div style={{ ...card, marginBottom: 12, fontSize: 13, color: INK }}>
            Current cover costs <strong>{inr(optim.data?.summary?.current_annual_holding_cost)}</strong> a year;
            a service level set by ABC class would cost <strong>{inr(optim.data?.summary?.optimised_annual_holding_cost)}</strong>.
            {optim.data?.summary?.multi_location_items > 0 && (
              <> Pooling cover for the {optim.data.summary.multi_location_items} item(s) held in more than one
              location would save about <strong>{inr(optim.data.summary.echelon_pooling_saving)}</strong> a year.</>)}
          </div>
          <DataTable rows={optim.data?.recommendations || []} keyOf={r => r.item_id} columns={[
            { key: 'item_code', label: 'Item' },
            { key: 'abc_class', label: 'ABC' },
            { key: 'current_safety_stock', label: 'Now', align: 'right', render: r => fmt(r.current_safety_stock, 2) },
            { key: 'recommended_safety_stock', label: 'Recommended', align: 'right', render: r => fmt(r.recommended_safety_stock, 2) },
            { key: 'locations', label: 'Locations', align: 'right' },
            { key: 'pooling_saving', label: 'Pooling saves', align: 'right', render: r => r.pooling_saving ? inr(r.pooling_saving) : '—' },
            { key: 'action', label: 'Action', render: r => (
              <Pill tone={r.action === 'raise_cover' ? 'warn' : r.action === 'release_cover' ? 'calm' : r.action === 'hold' ? 'ok' : 'mute'}>
                {String(r.action).replace(/_/g, ' ')}</Pill>) },
            { key: 'rationale', label: 'Why', render: r => <span style={{ fontSize: 11, color: MUT }}>{r.rationale}</span> },
          ]} />
        </Panel>
      )}

      {tab === 'leadtime' && (
        <Panel loading={leadTimes.loading} error={leadTimes.error} empty={!(leadTimes.data || []).length}
               emptyHint="No items yet.">
          <DataTable rows={leadTimes.data || []} columns={[
            { key: 'item_code', label: 'Item' },
            { key: 'lead_time_days', label: 'In use (d)', align: 'right' },
            { key: 'lead_time_measured_days', label: 'Measured (d)', align: 'right', render: r => fmt(r.lead_time_measured_days, 2) },
            { key: 'lead_time_observations', label: 'Receipts', align: 'right' },
            { key: 'lead_time_source', label: 'Source', render: r => (
              <Pill tone={r.lead_time_source === 'measured' ? 'ok' : r.lead_time_source === 'manual' ? 'warn' : 'mute'}>
                {r.lead_time_source || 'typed'}</Pill>) },
            { key: 'lead_time_measured_at', label: 'Measured', render: r => r.lead_time_measured_at ? fmtDate(r.lead_time_measured_at) : '—' },
          ]} />
        </Panel>
      )}
    </PageShell>
  );
}
