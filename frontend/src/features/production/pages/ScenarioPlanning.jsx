// frontend/src/features/production/pages/ScenarioPlanning.jsx
//
// What-if planning: run the REAL MRP and CRP engines against temporarily
// adjusted inputs, then reverse them.
//
// This is deliberately not a parallel simulator. A separate simulation path
// drifts from the plan it is being compared against — slowly, silently, and
// usually in the direction that makes the scenario look better. Running the
// production engines against adjusted inputs costs more and is the only way the
// comparison stays honest.
//
// Booked maintenance downtime lives here too, because that is what it is: a
// change to available capacity. Downtime is capped at productive hours — a
// two-day service on a line that runs 16 hours a day removes 32 hours, not 48,
// and the uncapped version zeroed the work centre instead of halving it.
import { useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  KPI, Panel, Pill, Tabs, DataTable, useFetch,
  card, btnP, btnS, input, INK, MUT, fmt, inr, pct,
} from '@/features/_shared/scmKit';

export default function ScenarioPlanning() {
  const toast = useToast();
  const [tab, setTab] = useState('scenarios');
  const [running, setRunning] = useState(false);
  const [form, setForm] = useState({
    name: '', demand_pct: 0, lead_time_days: 0, capacity_pct: 0, horizon_days: 90,
  });

  const scenarios = useFetch('/scm/scenarios');
  const downtime  = useFetch('/scm/downtime');
  const centres   = useFetch('/crp/work-centre-capacity');
  const [dt, setDt] = useState({ work_centre_id: '', start_at: '', hours_lost: 16, reason: '', probability_pct: 100 });
  const [detail, setDetail] = useState(null);

  const rows = scenarios.data?.scenarios || (Array.isArray(scenarios.data) ? scenarios.data : []);
  const dtRows = downtime.data?.downtime || (Array.isArray(downtime.data) ? downtime.data : []);

  const run = async () => {
    setRunning(true);
    try {
      const { data } = await api.post('/scm/scenarios/run', {
        name: form.name || `Scenario ${new Date().toISOString().slice(0, 16)}`,
        horizon_days: Number(form.horizon_days),
        adjustments: {
          demand_pct:     Number(form.demand_pct) || 0,
          lead_time_days: Number(form.lead_time_days) || 0,
          capacity_pct:   Number(form.capacity_pct) || 0,
        },
      });
      toast?.success?.('Scenario run against the real engines, then reversed');
      setDetail(data?.scenario ? { ...data.scenario, results: data.results || data.scenario.results } : data);
      scenarios.refetch();
      setTab('result');
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
    finally { setRunning(false); }
  };

  const open = async (s) => {
    try {
      const { data } = await api.get(`/scm/scenarios/${s.id}`);
      setDetail(data?.scenario || data);
      setTab('result');
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const bookDowntime = async () => {
    if (!dt.work_centre_id || !dt.start_at) { toast?.error?.('Work centre and start are required'); return; }
    try {
      await api.post('/scm/downtime', {
        work_centre_id: Number(dt.work_centre_id),
        start_at: dt.start_at,
        hours_lost: Number(dt.hours_lost),
        reason: dt.reason || null,
        probability_pct: Number(dt.probability_pct),
      });
      toast?.success?.('Downtime booked — CRP availability drops for those buckets');
      setDt({ work_centre_id: '', start_at: '', hours_lost: 16, reason: '', probability_pct: 100 });
      downtime.refetch();
    } catch (e) { toast?.error?.(e?.response?.data?.error || e.message); }
  };

  const res = detail?.results || {};
  const base = res.baseline || {};
  const scen = res.scenario || {};
  const delta = (a, b) => (a == null || b == null ? null : Number(b) - Number(a));

  return (
    <PageShell dock={
      <PageHero
        icon={GitBranch}
        eyebrow="Production · Planning"
        title="Scenario Planning"
        subtitle="What-if against the real MRP and CRP engines, plus the maintenance downtime that changes capacity"
      />
    }>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 18 }}>
        <KPI label="Scenarios run" value={fmt(rows.length)} />
        <KPI label="Downtime booked" value={fmt(dtRows.length)} tint="#b45309" />
        <KPI label="Work centres" value={fmt((centres.data || []).length)} />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'scenarios', label: 'Scenarios', count: rows.length },
        { key: 'downtime',  label: 'Maintenance downtime', count: dtRows.length },
        ...(detail ? [{ key: 'result', label: 'Result' }] : []),
      ]} />

      {tab === 'scenarios' && (
        <>
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Run a scenario</div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12, color: MUT, flex: '1 1 220px' }}>Name
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                       placeholder="e.g. Demand +30%, supplier slips a week"
                       style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Demand ±%
                <input type="number" value={form.demand_pct} onChange={e => setForm({ ...form, demand_pct: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 100 }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Lead time ± days
                <input type="number" value={form.lead_time_days} onChange={e => setForm({ ...form, lead_time_days: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 120 }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Capacity ±%
                <input type="number" value={form.capacity_pct} onChange={e => setForm({ ...form, capacity_pct: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 110 }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Horizon (days)
                <input type="number" value={form.horizon_days} onChange={e => setForm({ ...form, horizon_days: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 110 }} />
              </label>
              <button style={{ ...btnP, opacity: running ? 0.6 : 1 }} onClick={run} disabled={running}>
                {running ? 'Running…' : '▶ Run scenario'}
              </button>
            </div>
          </div>
          <Panel loading={scenarios.loading} error={scenarios.error} empty={!rows.length}
                 emptyHint="No scenarios yet.">
            <DataTable rows={rows} columns={[
              { key: 'name', label: 'Scenario' },
              { key: 'scenario_type', label: 'Type', render: s => <Pill tone="mute">{s.scenario_type || 'what_if'}</Pill> },
              { key: 'created_at', label: 'Run', render: s => fmtDate(s.created_at) },
              { key: 'status', label: 'Status', render: s => <Pill tone={s.status === 'completed' ? 'ok' : 'warn'}>{s.status}</Pill> },
              { key: 'act', label: '', render: s => <button style={btnS} onClick={() => open(s)}>Open</button> },
            ]} />
          </Panel>
        </>
      )}

      {tab === 'downtime' && (
        <>
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: INK, marginBottom: 10 }}>Book downtime</div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ fontSize: 12, color: MUT }}>Work centre
                <select value={dt.work_centre_id} onChange={e => setDt({ ...dt, work_centre_id: e.target.value })}
                        style={{ ...input, display: 'block', marginTop: 2, minWidth: 220 }}>
                  <option value="">Select…</option>
                  {(centres.data || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Starts
                <input type="datetime-local" value={dt.start_at} onChange={e => setDt({ ...dt, start_at: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2 }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Hours lost
                <input type="number" min={0} value={dt.hours_lost} onChange={e => setDt({ ...dt, hours_lost: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 100 }} />
              </label>
              <label style={{ fontSize: 12, color: MUT }}>Likelihood %
                <input type="number" min={1} max={100} value={dt.probability_pct}
                       onChange={e => setDt({ ...dt, probability_pct: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: 110 }} />
                <span style={{ fontSize: 10, color: MUT }}>100 = booked; less = predicted risk</span>
              </label>
              <label style={{ fontSize: 12, color: MUT, flex: '1 1 200px' }}>Reason
                <input value={dt.reason} onChange={e => setDt({ ...dt, reason: e.target.value })}
                       style={{ ...input, display: 'block', marginTop: 2, width: '100%' }} />
              </label>
              <button style={btnP} onClick={bookDowntime}>Book</button>
            </div>
          </div>
          <Panel loading={downtime.loading} error={downtime.error} empty={!dtRows.length}
                 emptyHint="No downtime booked. CRP is therefore planning against full capacity — which is right only if nothing is ever serviced.">
            <DataTable rows={dtRows} columns={[
              { key: 'work_centre_name', label: 'Work centre', render: d => d.work_centre_name || d.work_centre_id },
              { key: 'start_at', label: 'Starts', render: d => fmtDate(d.start_at) },
              { key: 'hours_lost', label: 'Hours', align: 'right', render: d => fmt(d.hours_lost, 1) },
              { key: 'probability_pct', label: 'Likelihood', align: 'right', render: d => pct(d.probability_pct, 0) },
              { key: 'reason', label: 'Reason' },
              { key: 'source', label: 'Source', render: d => <Pill tone="mute">{d.source || 'planned'}</Pill> },
            ]} />
          </Panel>
        </>
      )}

      {tab === 'result' && detail && (
        <>
          <div style={{ ...card, marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>{detail.name}</div>
            <div style={{ fontSize: 11, color: MUT, marginTop: 4 }}>
              Adjustments: {JSON.stringify(detail.adjustments || {})}
            </div>
          </div>
          <DataTable
            rows={[
              { k: 'Planned orders', b: base.planned_orders, s: scen.planned_orders },
              { k: 'Purchase value', b: base.purchase_value, s: scen.purchase_value, money: true },
              { k: 'Exceptions', b: base.exceptions, s: scen.exceptions },
              { k: 'Capacity infeasible', b: base.capacity_infeasible, s: scen.capacity_infeasible },
              { k: 'Peak work-centre load', b: base.peak_load_pct, s: scen.peak_load_pct, percent: true },
            ].filter(r => r.b != null || r.s != null)}
            keyOf={r => r.k}
            empty="This scenario recorded no comparable result."
            columns={[
              { key: 'k', label: 'Measure' },
              { key: 'b', label: 'Baseline', align: 'right',
                render: r => r.money ? inr(r.b) : r.percent ? pct(r.b) : fmt(r.b) },
              { key: 's', label: 'Scenario', align: 'right',
                render: r => r.money ? inr(r.s) : r.percent ? pct(r.s) : fmt(r.s) },
              { key: 'd', label: 'Change', align: 'right', render: r => {
                const d = delta(r.b, r.s);
                if (d === null) return '—';
                const txt = r.money ? inr(Math.abs(d)) : r.percent ? pct(Math.abs(d)) : fmt(Math.abs(d));
                return <Pill tone={d === 0 ? 'mute' : d > 0 ? 'warn' : 'ok'}>{d > 0 ? '+' : d < 0 ? '−' : ''}{txt}</Pill>;
              } },
            ]} />
        </>
      )}
    </PageShell>
  );
}
