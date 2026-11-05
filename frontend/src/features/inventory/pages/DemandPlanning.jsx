// frontend/src/features/inventory/pages/DemandPlanning.jsx
//
// The demand-planning workbench: run the forecast, see which method won and
// why, approve it, and score it once the period closes.
//
// All of this existed in the backend and none of it was reachable. A forecast
// engine that a planner cannot run, review or approve is not a forecast — it is
// a cron job nobody asked for. The approval step in particular has to be here,
// because MRP only consumes an APPROVED forecast: without a screen, the whole
// statistical chain terminated at 'draft' forever.
import { useState } from 'react';
import { LineChart } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, Tabs, DataTable, useFetch,
  card, btnP, btnS, input, INK, MUT, ACC, fmt, pct,
} from '@/features/_shared/scmKit';

const METHOD_LABEL = {
  moving_average: 'Moving average',
  exp_smoothing:  'Exponential smoothing',
  holt:           'Holt (trend)',
  seasonal:       'Seasonal',
  causal:         'Causal regression',
};

export default function DemandPlanning() {
  const toast = useToast();
  const [tab, setTab] = useState('forecast');
  const [horizon, setHorizon] = useState(6);
  const [lookback, setLookback] = useState(730);
  const [running, setRunning] = useState(false);

  const forecasts = useFetch('/inventory/planning/forecast');
  const runs      = useFetch('/inventory/planning/forecast/runs');
  const accuracy  = useFetch('/inventory/planning/forecast/accuracy');
  const drivers   = useFetch('/inventory/planning/drivers');
  const fits      = useFetch('/inventory/planning/drivers/fits');

  const rows = Array.isArray(forecasts.data) ? forecasts.data
             : (forecasts.data?.forecasts || []);
  const lastRun = Array.isArray(runs.data) ? runs.data[0] : null;

  const refreshAll = () => { forecasts.refetch(); runs.refetch(); accuracy.refetch(); };

  const runForecast = async () => {
    setRunning(true);
    try {
      const { data } = await api.post('/inventory/planning/forecast/run', {
        horizon_periods: Number(horizon), lookback_days: Number(lookback),
      });
      const r = data?.run || data;
      toast?.success?.(`Forecast run ${r?.run_no || ''} — ${r?.items_forecast ?? 0} item(s) forecast, ${r?.items_skipped ?? 0} skipped`);
      refreshAll();
    } catch (e) {
      toast?.error?.(e?.response?.data?.error || e.message);
    } finally { setRunning(false); }
  };

  const approve = async () => {
    // The endpoint requires a run_id or an explicit list of ids — approving
    // "everything draft" is not offered, deliberately: a planner approves the
    // output of a RUN they have looked at, not whatever happens to be lying
    // around in draft from some earlier experiment.
    if (!lastRun?.id) { toast?.error?.('Run a forecast first — there is nothing to approve'); return; }
    try {
      const { data } = await api.post('/inventory/planning/forecast/approve', { run_id: lastRun.id });
      toast?.success?.(`Approved ${data?.approved ?? 0} period(s) from ${lastRun.run_no} — MRP will now consume them`);
      refreshAll();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const measure = async () => {
    try {
      const { data } = await api.post('/inventory/planning/forecast/measure-accuracy', {});
      toast?.success?.(`Scored ${data?.measured ?? data?.scored ?? 0} closed period(s)`);
      accuracy.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const override = async (row) => {
    const v = window.prompt(`Override the forecast for ${row.item_code || row.product_name} (${fmtDate(row.period_start)})`, row.forecast_qty ?? row.quantity ?? '');
    if (v === null) return;
    const qty = Number(v);
    if (!Number.isFinite(qty) || qty < 0) { toast?.error?.('Enter a non-negative quantity'); return; }
    try {
      await api.put(`/inventory/planning/forecast/${row.id}`, { quantity: qty, is_manual_override: true });
      toast?.success?.('Judgemental override recorded — it will survive the next regeneration');
      forecasts.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const syncDrivers = async () => {
    try {
      const { data } = await api.post('/inventory/planning/drivers/sync', {});
      toast?.success?.(`Synced ${data?.synced ?? 0} driver value(s) from Pulse's own pipelines`);
      drivers.refetch(); fits.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const approvedCount = rows.filter(r => r.status === 'approved').length;
  const draftCount    = rows.filter(r => (r.status || 'draft') === 'draft').length;
  const accRows       = Array.isArray(accuracy.data) ? accuracy.data : (accuracy.data?.rows || []);

  return (
    <PageShell dock={
      <PageHero
        icon={LineChart}
        eyebrow="Inventory · Planning"
        title="Demand Planning"
        subtitle="Forecast independent demand, review which method won, approve it, and score it once the period closes"
      />
    }>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: MUT }}>Horizon (months)
          <input type="number" min={1} max={24} value={horizon} onChange={e => setHorizon(e.target.value)}
                 style={{ ...input, display: 'block', marginTop: 2, width: 90 }} />
        </label>
        <label style={{ fontSize: 12, color: MUT }}>Lookback (days)
          <input type="number" min={90} max={1825} value={lookback} onChange={e => setLookback(e.target.value)}
                 style={{ ...input, display: 'block', marginTop: 2, width: 110 }} />
        </label>
        <button onClick={runForecast} disabled={running} style={{ ...btnP, opacity: running ? 0.6 : 1 }}>
          {running ? 'Running…' : '▶ Run forecast'}
        </button>
        <button onClick={approve} style={btnS}>✓ Approve draft periods</button>
        <button onClick={measure} style={btnS}>Score closed periods</button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Forecast periods" value={fmt(rows.length)} />
        <KPI label="Approved" value={fmt(approvedCount)} tint="#15803d"
             hint="Only approved periods reach MRP" />
        <KPI label="Awaiting approval" value={fmt(draftCount)} tint="#b45309" />
        <KPI label="Last run MAPE" value={lastRun?.avg_mape != null ? pct(lastRun.avg_mape) : null}
             hint={lastRun ? `${lastRun.run_no} · ${lastRun.items_forecast} item(s)` : 'No run yet'} />
        <KPI label="Periods scored" value={fmt(accRows.length)} tint="#1d4ed8" />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'forecast', label: 'Forecast', count: rows.length },
        { key: 'runs',     label: 'Runs' },
        { key: 'accuracy', label: 'Forecast vs actual', count: accRows.length },
        { key: 'drivers',  label: 'Demand drivers' },
      ]} />

      {tab === 'forecast' && (
        <Panel loading={forecasts.loading} error={forecasts.error} empty={!rows.length}
               emptyHint="Run the forecast above. Items with fewer than two periods of demand history are skipped rather than given a zero.">
          <DataTable
            rows={rows}
            columns={[
              { key: 'item_code', label: 'Item', render: r => (
                <div><div style={{ fontWeight: 700 }}>{r.item_code || '—'}</div>
                     <div style={{ fontSize: 11, color: MUT }}>{r.product_name || r.item_name}</div></div>) },
              { key: 'period_start', label: 'Period', render: r => fmtDate(r.period_start) },
              { key: 'method', label: 'Method', render: r => (
                <Pill tone={r.is_manual_override ? 'warn' : 'calm'}>
                  {r.is_manual_override ? 'Judgemental' : (METHOD_LABEL[r.method] || r.method || '—')}
                </Pill>) },
              { key: 'forecast_qty', label: 'Forecast', align: 'right', render: r => fmt(r.forecast_qty ?? r.quantity, 2) },
              { key: 'consumed_qty', label: 'Consumed', align: 'right', render: r => fmt(r.consumed_qty, 2) },
              { key: 'status', label: 'Status', render: r => (
                <Pill tone={r.status === 'approved' ? 'ok' : r.status === 'superseded' ? 'mute' : 'warn'}>
                  {r.status || 'draft'}</Pill>) },
              { key: 'act', label: '', render: r => (
                <button style={btnS} onClick={() => override(r)}>Override</button>) },
            ]} />
        </Panel>
      )}

      {tab === 'runs' && (
        <Panel loading={runs.loading} error={runs.error} empty={!(runs.data || []).length}
               emptyHint="No forecast has been run for this company yet.">
          <DataTable
            rows={runs.data || []}
            columns={[
              { key: 'run_no', label: 'Run' },
              { key: 'created_at', label: 'When', render: r => fmtDate(r.created_at) },
              { key: 'items_forecast', label: 'Forecast', align: 'right', render: r => fmt(r.items_forecast) },
              { key: 'items_skipped', label: 'Skipped', align: 'right', render: r => fmt(r.items_skipped) },
              { key: 'avg_mape', label: 'MAPE', align: 'right', render: r => r.avg_mape != null ? pct(r.avg_mape) : '—' },
              { key: 'avg_bias', label: 'Bias', align: 'right', render: r => fmt(r.avg_bias, 2) },
              { key: 'status', label: 'Status', render: r => <Pill tone={r.status === 'completed' ? 'ok' : 'warn'}>{r.status}</Pill> },
            ]} />
        </Panel>
      )}

      {tab === 'accuracy' && (
        <Panel loading={accuracy.loading} error={accuracy.error} empty={!accRows.length}
               emptyHint="Accuracy is scored on CLOSED periods only — an open period has no actual to compare against. Use “Score closed periods”.">
          <DataTable
            rows={accRows}
            columns={[
              { key: 'item_code', label: 'Item' },
              { key: 'period_start', label: 'Period', render: r => fmtDate(r.period_start) },
              { key: 'method', label: 'Method', render: r => METHOD_LABEL[r.method] || r.method },
              { key: 'forecast_qty', label: 'Forecast', align: 'right', render: r => fmt(r.forecast_qty, 2) },
              { key: 'actual_qty', label: 'Actual', align: 'right', render: r => fmt(r.actual_qty, 2) },
              { key: 'pct_error', label: 'Error', align: 'right',
                render: r => r.pct_error != null ? pct(r.pct_error) : '— (zero actual)' },
              { key: 'bias', label: 'Bias', align: 'right', render: r => fmt(r.bias, 2) },
            ]} />
        </Panel>
      )}

      {tab === 'drivers' && (
        <>
          <div style={{ ...card, marginBottom: 14, fontSize: 13, color: INK }}>
            A causal model competes in the same backtest as the time-series methods and wins only if it
            forecasts better. <button style={{ ...btnS, marginLeft: 8 }} onClick={syncDrivers}>Sync internal drivers</button>
            <span style={{ color: MUT, marginLeft: 8 }}>pulls opportunity and tender pipeline values as leading indicators.</span>
          </div>
          <Panel loading={drivers.loading} error={drivers.error} empty={!(drivers.data || []).length}
                 emptyHint="No demand drivers registered. Without them, causal forecasting has nothing to regress against and is correctly excluded.">
            <DataTable
              rows={drivers.data || []}
              columns={[
                { key: 'driver_code', label: 'Driver' },
                { key: 'driver_name', label: 'Name' },
                { key: 'source_type', label: 'Source', render: r => <Pill tone="mute">{r.source_type}</Pill> },
                { key: 'lag_periods', label: 'Lag (months)', align: 'right' },
                { key: 'unit', label: 'Unit' },
              ]} />
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: INK, marginBottom: 6 }}>Fitted coefficients</div>
              <DataTable
                rows={fits.data || []}
                empty="No driver has yet explained an item's demand well enough to be fitted."
                columns={[
                  { key: 'item_code', label: 'Item' },
                  { key: 'driver_name', label: 'Driver' },
                  { key: 'coefficient', label: 'Coefficient', align: 'right', render: r => fmt(r.coefficient, 4) },
                  { key: 'r_squared', label: 'R²', align: 'right', render: r => fmt(r.r_squared, 3) },
                  { key: 'fitted_at', label: 'Fitted', render: r => fmtDate(r.fitted_at) },
                ]} />
            </div>
          </Panel>
        </>
      )}
    </PageShell>
  );
}
