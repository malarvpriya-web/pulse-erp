/**
 * IoTHealth.jsx — is the MONITORING working?
 *
 * This page is deliberately not about equipment condition. Fleet Monitor answers
 * "is the machine in trouble"; this answers "is the pipeline that would tell us
 * still running". Conflating them is how a silent gateway reads as a healthy
 * plant: no telemetry means no breaches, which on an equipment dashboard looks
 * like good news.
 *
 * Five sections:
 *   Platform     — gateways, devices, ingest rate, outbox, ticket failures
 *   Data quality — expected vs received vs valid vs rejected, by device or metric
 *   Gateways     — per-gateway diagnostics, so an operator can tell an equipment
 *                  problem from a gateway problem from a network problem
 *   Service KPIs — MTTA / MTBF / MTTR / uptime from the event history, each of
 *                  which prints its reason instead of a number when the history
 *                  cannot support one
 *   Integrity    — the reconciliation checks (orphans, cross-company rows,
 *                  duplicates, legacy rows outside the state vocabulary)
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Activity, RefreshCw, AlertTriangle, CheckCircle2, Ban, Server, Database,
  Inbox, Gauge, ShieldAlert, RotateCw, Wifi, WifiOff, PlugZap,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '9px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13 };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };

const fmt = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const age = (secs) => {
  if (secs == null) return 'never';
  if (secs < 60) return `${Math.round(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
};

const GW_STATE = {
  online: { color: '#059669', bg: '#dcfce7', Icon: Wifi, label: 'Online' },
  stale: { color: '#b45309', bg: '#fef3c7', Icon: Activity, label: 'Stale' },
  offline: { color: '#dc2626', bg: '#fee2e2', Icon: WifiOff, label: 'Offline' },
  never_connected: { color: '#6b7280', bg: '#f3f4f6', Icon: PlugZap, label: 'Never connected' },
};

function Stat({ label, value, tone = 'neutral', sub, icon: Icon }) {
  const color = tone === 'bad' ? '#dc2626' : tone === 'warn' ? '#b45309' : tone === 'good' ? '#059669' : '#111827';
  return (
    <div style={{ ...CARD, flex: '1 1 140px', minWidth: 130 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
        {Icon && <Icon size={13} color="#9ca3af" />}
        <span style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

/** A ratio, rendered with its definition rather than as a bare number. */
function RatioBlock({ r }) {
  if (!r) return null;
  if (r.state !== 'OK') {
    return (
      <div style={{ ...CARD, flex: '1 1 220px' }}>
        <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>{r.label}</div>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#9ca3af', marginTop: 6 }}>
          {r.state === 'NO_DENOMINATOR' ? 'Undefined' : 'Insufficient data'}
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{r.note}</div>
      </div>
    );
  }
  return (
    <div style={{ ...CARD, flex: '1 1 220px' }}>
      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase' }}>{r.label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: r.value < 90 ? '#b45309' : '#059669', marginTop: 4 }}>
        {r.value}%
      </div>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
        {r.numerator} of {r.denominator} · {r.window}
      </div>
      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>{r.formula}</div>
    </div>
  );
}

export default function IoTHealth() {
  const [tab, setTab] = useState('platform');
  const [hours, setHours] = useState(24);
  const [health, setHealth] = useState(null);
  const [quality, setQuality] = useState(null);
  const [gateways, setGateways] = useState(null);
  const [reconcile, setReconcile] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [state, setState] = useState('LOADING');
  const [error, setError] = useState(null);
  const [groupBy, setGroupBy] = useState('device');

  const load = useCallback(() => {
    setState('LOADING'); setError(null);
    Promise.all([
      api.get('/iot/ops/health', { params: { hours } }),
      api.get('/iot/ops/data-quality', { params: { hours, group_by: groupBy } }),
      api.get('/iot/ops/gateways'),
      api.get('/iot/ops/reconcile'),
      api.get('/iot/ops/service-kpis', { params: { days: 90 } }),
    ])
      .then(([h, q, g, r, k]) => {
        setHealth(h.data); setQuality(q.data); setGateways(g.data);
        setReconcile(r.data); setKpis(k.data);
        setState('SUCCESS');
      })
      .catch((e) => {
        const status = e?.response?.status;
        setError({ message: e?.response?.data?.message || e?.response?.data?.error || e.message, status });
        setState(status === 403 ? 'UNAUTHORIZED' : 'ERROR');
      });
  }, [hours, groupBy]);

  useEffect(() => { load(); }, [load]);

  const replay = async (id) => {
    try { await api.post(`/iot/ops/outbox/${id}/replay`); load(); }
    catch (e) { setError({ message: e?.response?.data?.error || e.message }); }
  };

  if (state === 'LOADING') {
    return <PageShell dock={<PageHero icon={Activity} eyebrow="IoT" title="Platform Health" />}>
      <div style={{ ...CARD, color: '#9ca3af', textAlign: 'center', padding: 28 }}>Loading…</div>
    </PageShell>;
  }

  if (state !== 'SUCCESS') {
    return <PageShell dock={<PageHero icon={Activity} eyebrow="IoT" title="Platform Health" />}>
      <div style={{ ...CARD, borderColor: '#fecaca', background: '#fef2f2', display: 'flex', gap: 10 }}>
        {state === 'UNAUTHORIZED' ? <Ban size={18} color="#b45309" /> : <AlertTriangle size={18} color="#dc2626" />}
        <div>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#991b1b' }}>
            {state === 'UNAUTHORIZED' ? 'Access denied' : 'Health data could not be loaded'}
          </div>
          <div style={{ fontSize: 12, color: '#991b1b', marginTop: 3 }}>{error?.message}</div>
          <button onClick={load} style={{ ...btn, marginTop: 8 }}>Try again</button>
        </div>
      </div>
    </PageShell>;
  }

  const d = health.devices, g = health.gateways, t = health.telemetry, o = health.outbox;
  const problems = reconcile?.problems || [];

  return (
    <PageShell dock={
      <PageHero
        icon={Activity}
        eyebrow="IoT"
        title="Platform Health"
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}
              style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 7, padding: '5px 8px' }}>
              {[1, 6, 24, 24 * 7, 24 * 30].map((h) => <option key={h} value={h}>{h < 24 ? `${h}h` : `${h / 24}d`}</option>)}
            </select>
            <button className="plh-cta" onClick={load}><RefreshCw size={13} /> Refresh</button>
          </div>
        }
      />
    }>
      <div style={{ background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 9, padding: 11, marginBottom: 14, fontSize: 12, color: '#3730a3' }}>
        <b>This page is about the monitoring, not the equipment.</b> A quiet fleet with a dead gateway shows no alerts —
        which on an equipment dashboard is indistinguishable from a healthy plant. Equipment condition lives in Fleet Monitor.
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { k: 'platform', l: 'Platform' },
          { k: 'quality', l: 'Data quality' },
          { k: 'gateways', l: `Gateways (${gateways?.rows?.length || 0})` },
          { k: 'service', l: 'Service KPIs' },
          { k: 'integrity', l: `Integrity${problems.length ? ` (${problems.length})` : ''}` },
        ].map((x) => (
          <button key={x.k} onClick={() => setTab(x.k)}
            style={{ ...btn, background: tab === x.k ? '#6B3FDB' : '#fff', color: tab === x.k ? '#fff' : '#374151', borderColor: tab === x.k ? '#6B3FDB' : '#e5e7eb' }}>
            {x.l}
          </button>
        ))}
      </div>

      {tab === 'platform' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat icon={Server} label="Gateways connected" value={g.connected} tone={g.disconnected > 0 ? 'warn' : 'good'} sub={`${g.disconnected} not reporting`} />
            <Stat icon={Wifi} label="Devices live" value={d.online} tone="good" sub={`of ${d.provisioned} provisioned`} />
            <Stat icon={Activity} label="Stale" value={d.stale} tone={d.stale > 0 ? 'warn' : 'neutral'} />
            <Stat icon={WifiOff} label="Offline" value={d.offline} tone={d.offline > 0 ? 'bad' : 'neutral'} />
            <Stat icon={PlugZap} label="Never connected" value={d.never_connected} sub="not a fault — not commissioned" />
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat icon={Database} label={`Samples (${health.window_hours}h)`} value={t.received} sub={`${t.valid} valid · ${t.replay} replayed`} />
            <Stat icon={ShieldAlert} label="Rejected" value={t.rejected} tone={t.rejected > 0 ? 'warn' : 'good'} sub="quarantined, not stored" />
            <Stat icon={Inbox} label="Queued events" value={o.pending} tone={o.pending > 20 ? 'warn' : 'neutral'} />
            <Stat icon={AlertTriangle} label="Dead-letter" value={o.dead} tone={o.dead > 0 ? 'bad' : 'good'} sub="events that never delivered" />
            <Stat icon={Gauge} label="Gateway queue depth" value={g.queue_depth} sub={g.oldest_queued_ts ? `oldest ${fmt(g.oldest_queued_ts)}` : 'nothing queued'} />
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <RatioBlock r={health.ratios?.online} />
            <RatioBlock r={health.ratios?.sample_delivery} />
          </div>

          {health.caveats?.length > 0 && (
            <div style={{ ...CARD, background: '#fffbeb', borderColor: '#fde68a' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 6 }}>What these numbers do and do not mean</div>
              {health.caveats.map((c, i) => (
                <div key={i} style={{ fontSize: 12, color: '#92400e', padding: '2px 0' }}>· {c}</div>
              ))}
            </div>
          )}

          {health.ticket_failures > 0 && (
            <div style={{ ...CARD, background: '#fef2f2', borderColor: '#fecaca' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <AlertTriangle size={16} color="#dc2626" />
                <b style={{ fontSize: 13, color: '#991b1b' }}>
                  {health.ticket_failures} alert(s) failed to raise a service ticket
                </b>
              </div>
              <div style={{ fontSize: 12, color: '#991b1b', marginTop: 5 }}>
                These are dead-letter events. The alert exists and the telemetry is intact — only the ticket creation
                failed. Fix the cause, then replay them from the Integrity tab.
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'quality' && quality && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Group by</span>
            {['device', 'metric'].map((x) => (
              <button key={x} onClick={() => setGroupBy(x)}
                style={{ ...btn, background: groupBy === x ? '#f5f3ff' : '#fff', borderColor: groupBy === x ? '#ddd6fe' : '#e5e7eb' }}>
                {x}
              </button>
            ))}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              {quality.deduplication?.duplicate_samples} duplicate sample(s) absorbed across{' '}
              {quality.deduplication?.batches} batch(es) — the retry guard doing its job
            </span>
          </div>

          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead><tr>
                  <th style={TH}>{groupBy}</th><th style={TH}>Received</th><th style={TH}>Valid</th>
                  <th style={TH}>Suspect</th><th style={TH}>Late</th><th style={TH}>Other</th>
                  <th style={TH}>Valid %</th><th style={TH}>Last received</th>
                </tr></thead>
                <tbody>
                  {quality.rows.map((r) => {
                    const pct = r.received ? Math.round((r.valid / r.received) * 100) : null;
                    return (
                      <tr key={r.key_id}>
                        <td style={{ ...TD, fontWeight: 600 }}>{r.key_label}</td>
                        <td style={TD}>{r.received}</td>
                        <td style={{ ...TD, color: '#059669' }}>{r.valid}</td>
                        <td style={{ ...TD, color: r.suspect ? '#b45309' : '#d1d5db' }}>{r.suspect}</td>
                        <td style={{ ...TD, color: r.late ? '#b45309' : '#d1d5db' }}>{r.late}</td>
                        <td style={{ ...TD, color: r.other ? '#dc2626' : '#d1d5db' }}>{r.other}</td>
                        <td style={{ ...TD, fontWeight: 700, color: pct == null ? '#9ca3af' : pct >= 95 ? '#059669' : pct >= 80 ? '#b45309' : '#dc2626' }}>
                          {pct == null ? '—' : `${pct}%`}
                        </td>
                        <td style={{ ...TD, fontSize: 11, color: '#6b7280' }}>{fmt(r.last_received)}</td>
                      </tr>
                    );
                  })}
                  {!quality.rows.length && (
                    <tr><td style={{ ...TD, textAlign: 'center', color: '#9ca3af' }} colSpan={8}>
                      No telemetry received in this window.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {quality.rejections?.length > 0 && (
            <div style={CARD}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 10 }}>
                Why samples were rejected
              </div>
              {quality.rejections.map((r) => (
                <div key={r.reason} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid #f9f9fb', fontSize: 12 }}>
                  <span style={{ fontFamily: 'monospace', color: '#991b1b' }}>{r.reason}</span>
                  <span><b>{r.n}</b> <span style={{ color: '#9ca3af' }}>· last {fmt(r.last_seen)}</span></span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 10 }}>
                Rejected samples are quarantined in <code>iot_rejected_samples</code>, never stored as measurements.
                A persistent UNKNOWN_METRIC or OUT_OF_RANGE count is a gateway configuration problem, not a device fault.
              </div>
            </div>
          )}

          <div style={{ ...CARD, fontSize: 11, color: '#6b7280' }}>
            <b style={{ color: '#374151' }}>Legend.</b>{' '}
            {Object.entries(quality.legend || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
          </div>
        </div>
      )}

      {tab === 'gateways' && gateways && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ ...CARD, fontSize: 12, color: '#6b7280' }}>{gateways.note}</div>
          {gateways.rows.length === 0 ? (
            <div style={{ ...CARD, textAlign: 'center', padding: 28, color: '#6b7280', fontSize: 13 }}>
              No gateway has registered yet. A gateway registers itself on its first heartbeat;
              until then telemetry may still arrive, but there is no way to distinguish a gateway
              outage from an equipment outage.
            </div>
          ) : (
            <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                  <thead><tr>
                    <th style={TH}>Gateway</th><th style={TH}>Status</th><th style={TH}>Heartbeat</th>
                    <th style={TH}>Devices</th><th style={TH}>Queue</th><th style={TH}>Spool</th>
                    <th style={TH}>Errors</th><th style={TH}>Dead-letter</th><th style={TH}>Poll</th>
                  </tr></thead>
                  <tbody>
                    {gateways.rows.map((gw) => {
                      const meta = GW_STATE[gw.live_status] || GW_STATE.never_connected;
                      return (
                        <tr key={gw.id}>
                          <td style={TD}>
                            <div style={{ fontWeight: 600 }}>{gw.gateway_uid}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{gw.name || gw.site_location || '—'}{gw.version ? ` · v${gw.version}` : ''}</div>
                          </td>
                          <td style={TD}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: meta.bg, color: meta.color, padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600 }}>
                              <meta.Icon size={11} /> {meta.label}
                            </span>
                          </td>
                          <td style={{ ...TD, fontSize: 12, color: '#6b7280' }}>{age(Number(gw.heartbeat_age_secs))}</td>
                          <td style={TD}>{gw.linked_devices}</td>
                          <td style={{ ...TD, color: gw.queue_depth > 0 ? '#b45309' : '#6b7280' }}>
                            {gw.queue_depth}
                            {gw.oldest_queued_ts && <div style={{ fontSize: 10, color: '#9ca3af' }}>oldest {fmt(gw.oldest_queued_ts)}</div>}
                          </td>
                          <td style={{ ...TD, fontSize: 12, color: '#6b7280' }}>
                            {gw.spool_bytes ? `${Math.round(gw.spool_bytes / 1024)} KB` : '—'}
                            {gw.disk_free_bytes != null && (
                              <div style={{ fontSize: 10, color: gw.disk_free_bytes < 100e6 ? '#dc2626' : '#9ca3af' }}>
                                {Math.round(gw.disk_free_bytes / 1e6)} MB free
                              </div>
                            )}
                          </td>
                          <td style={{ ...TD, color: gw.error_count > 0 ? '#b45309' : '#d1d5db' }}>{gw.error_count}</td>
                          <td style={{ ...TD, color: gw.dead_letter_count > 0 ? '#dc2626' : '#d1d5db' }}>{gw.dead_letter_count}</td>
                          <td style={{ ...TD, fontSize: 12, color: '#6b7280' }}>{gw.poll_secs ? `${gw.poll_secs}s` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'service' && kpis && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ ...CARD, fontSize: 12, color: '#6b7280' }}>
            {kpis.note}
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Stat icon={AlertTriangle} label="Open incidents" value={kpis.counts.open_incidents}
              tone={kpis.counts.open_incidents > 0 ? 'warn' : 'good'} />
            <Stat icon={ShieldAlert} label="Critical" value={kpis.counts.critical_incidents}
              tone={kpis.counts.critical_incidents > 0 ? 'bad' : 'good'} />
            <Stat icon={Activity} label={`Incidents (${kpis.window_days}d)`} value={kpis.counts.incidents_in_window} />
            <Stat icon={Server} label="With a ticket" value={kpis.counts.with_ticket}
              sub={`of ${kpis.counts.incidents_in_window}`} />
          </div>

          {/* Each KPI renders its own state. A figure that cannot be supported by
              the event history prints the reason instead of a number — the whole
              point of the serviceKpis module. */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[kpis.mtta, kpis.mtbf, kpis.mttr, kpis.uptime].filter(Boolean).map((k) => (
              <div key={k.code} style={{ ...CARD, flex: '1 1 230px', minWidth: 210 }}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.03em' }}>
                  {k.label}
                </div>
                {k.state === 'OK' ? (
                  <>
                    <div style={{ fontSize: 26, fontWeight: 700, color: '#111827', marginTop: 6 }}>
                      {k.value}<span style={{ fontSize: 12, color: '#9ca3af', fontWeight: 500 }}> {k.unit}</span>
                    </div>
                    {k.low_confidence && (
                      <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                        Low confidence — {k.intervals ?? k.completed_repairs} interval(s) only
                      </div>
                    )}
                    {k.note && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{k.note}</div>}
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 6 }}>{k.formula}</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#9ca3af', marginTop: 8 }}>
                      Insufficient data
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 5 }}>{k.note}</div>
                  </>
                )}
              </div>
            ))}
          </div>

          <div style={{ ...CARD, background: '#fffbeb', borderColor: '#fde68a', fontSize: 12, color: '#92400e' }}>
            <b>Why some of these say "insufficient data".</b> MTBF needs at least two failures to have
            an interval to measure; MTTR needs two completed repairs; uptime needs at least 24 hours of
            recorded connection events, and is computed per device — pass a device to get it. These
            figures are derived from <code>iot_device_events</code>, not from the current connection
            state, because a snapshot cannot tell you how long anything lasted. A number printed here
            from two data points would be a coincidence quoted to three significant figures.
          </div>

          <div style={{ ...CARD, fontSize: 11, color: '#6b7280' }}>
            Based on {kpis.event_count} device event(s) over the last {kpis.window_days} days.
          </div>
        </div>
      )}

      {tab === 'integrity' && reconcile && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ ...CARD, background: reconcile.clean ? '#f0fdf4' : '#fffbeb', borderColor: reconcile.clean ? '#bbf7d0' : '#fde68a' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {reconcile.clean ? <CheckCircle2 size={16} color="#059669" /> : <AlertTriangle size={16} color="#b45309" />}
              <b style={{ fontSize: 13, color: reconcile.clean ? '#166534' : '#92400e' }}>
                {reconcile.clean ? 'All integrity checks clean' : `${problems.length} check(s) found rows to look at`}
              </b>
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>Checked {fmt(reconcile.as_of)}</div>
          </div>

          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={TH}>Check</th><th style={TH}>Rows</th><th style={TH}>Verdict</th></tr></thead>
              <tbody>
                {reconcile.checks.map((c) => (
                  <tr key={c.label}>
                    <td style={{ ...TD, fontFamily: 'monospace', fontSize: 12 }}>{c.label}</td>
                    <td style={{ ...TD, fontWeight: 700, color: (c.n ?? 0) > 0 ? '#b45309' : '#059669' }}>
                      {c.error ? '—' : c.n}
                    </td>
                    <td style={{ ...TD, fontSize: 12, color: '#6b7280' }}>
                      {c.error ? <span style={{ color: '#991b1b' }}>{c.error}</span>
                        : (c.n ?? 0) === 0 ? 'clean' : 'needs attention'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ ...CARD, fontSize: 12, color: '#6b7280' }}>{reconcile.note}</div>

          {o.dead > 0 && (
            <div style={CARD}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
                Dead-letter events ({o.dead})
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                These events exhausted their retries. The telemetry and the alerts they came from are intact;
                only the downstream action (ticket, notification) failed. Fix the cause, then replay.
              </div>
              <button onClick={() => replay('all')} style={{ ...btn, display: 'none' }} />
              <div style={{ fontSize: 11, color: '#9ca3af' }}>
                Replay an individual event with <code>POST /iot/ops/outbox/&lt;id&gt;/replay</code>,
                or from the alert's own detail drawer in the Alert Centre.
              </div>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
