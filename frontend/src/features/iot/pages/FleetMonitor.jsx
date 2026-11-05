/**
 * FleetMonitor.jsx — live status of deployed AHF / SVG / STATCOM units.
 *
 * WHAT THIS VERSION FIXES (Phase 4 audit, 2026-09-14)
 * ---------------------------------------------------
 *  1. IT IS NOW ACTUALLY LIVE. The page called itself "Live status" and was a
 *     one-shot fetch that only changed when a human pressed Refresh. It now polls
 *     on a visible, configurable interval, pauses while the tab is hidden (a
 *     backgrounded dashboard polling every 15s for eight hours is load nobody
 *     asked for), and shows when it last updated and how old the data is.
 *
 *  2. REQUEST RACE. Selecting device A then device B could leave A's late
 *     response rendered in B's panel — the device name said B and the readings
 *     were A's. Every request now carries a token that is checked on arrival, and
 *     in-flight requests are aborted on change.
 *
 *  3. API ERRORS NO LONGER LOOK LIKE EMPTY DATA. `.catch(() => setDevices([]))`
 *     turned a 500 or a 403 into "No devices found" — the same screen a company
 *     with no equipment sees. LOADING / SUCCESS / EMPTY / ERROR / UNAUTHORIZED
 *     are now distinct states with distinct screens.
 *
 *  4. KPIs COME FROM AN AGGREGATE ENDPOINT. They were computed in the browser
 *     from a list capped at 500 rows and filtered by the search box, so typing
 *     three characters changed the company's "devices online" figure. The list
 *     and the summary are now different questions with different endpoints.
 *
 *  5. MISSING GPS STAYS MISSING. Coordinates are only plotted when both are real
 *     numbers; a device without a location is listed as "Location not recorded"
 *     rather than being placed at 0,0 in the Gulf of Guinea.
 *
 *  6. RISK IS NAMED HONESTLY. "Predicted health / failure probability" became
 *     Condition Risk Score, and a device with no evidence reads INSUFFICIENT DATA
 *     instead of 0 / "No action needed".
 *
 *  7. NEVER CONNECTED IS ITS OWN STATE, not a flavour of offline — the first is a
 *     commissioning problem, the second is a fault, and they go to different people.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Radio, Wifi, WifiOff, AlertTriangle, RefreshCw, KeyRound, Copy, Check, Activity,
  MapPin, ShieldCheck, Gauge, TrendingUp, Cpu, Ban, Wrench, PlugZap, ExternalLink,
  CircleSlash, Pause, Play, Ticket, Building2, FolderKanban,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import api from '@/services/api/client';
import { VizCard, TrendArea } from '@/components/charts/PulseViz';
import { PageHero, PageShell } from '@/components/pulse-ui';

const RISK_COLOR = { high: '#dc2626', medium: '#6d28d9', low: '#059669' };

// ── connection-state vocabulary ───────────────────────────────────────────────
// 'never' is deliberately distinct from 'offline'. A unit that has never reported
// has not failed; nobody has finished installing it.
const STATE_META = {
  online:  { label: 'Live',          color: '#059669', bg: '#dcfce7', Icon: Wifi },
  stale:   { label: 'Stale',         color: '#b45309', bg: '#fef3c7', Icon: Activity },
  offline: { label: 'Offline',       color: '#dc2626', bg: '#fee2e2', Icon: WifiOff },
  never:   { label: 'Never connected', color: '#6b7280', bg: '#f3f4f6', Icon: PlugZap },
};
const SEV_COLOR = { critical: '#dc2626', warning: '#b45309', info: '#2563eb' };
const stateMeta = (s) => STATE_META[s] || STATE_META.never;

const fmtWhen = (v) => {
  if (!v) return 'never';
  const secs = (Date.now() - new Date(v).getTime()) / 1000;
  if (secs < 0) return 'in the future';
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};
const fmtAge = (secs) => {
  if (secs == null) return '—';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
};

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '9px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13 };
const btnSm = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 7, padding: '4px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };

/** One place that turns an axios failure into a state the UI can render truthfully. */
function toErrorState(e) {
  if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') return null;   // superseded, not a failure
  const status = e?.response?.status;
  if (status === 403) {
    return {
      kind: 'UNAUTHORIZED',
      message: e.response?.data?.message
        || 'You do not have access to IoT data for this company.',
      code: e.response?.data?.code,
    };
  }
  if (status === 404) return { kind: 'NOT_FOUND', message: 'Not found.' };
  return {
    kind: 'ERROR',
    message: e?.response?.data?.error || e?.message || 'The request failed.',
    status,
  };
}

function StatePill({ state }) {
  const m = stateMeta(state);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: m.bg, color: m.color, padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      <m.Icon size={12} /> {m.label}
    </span>
  );
}

function Kpi({ icon: Icon, label, value, color, sub }) {
  return (
    <div style={{ ...CARD, flex: '1 1 150px', minWidth: 140, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}18`, color, display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
        <Icon size={20} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

/** A shared, honest rendering for every non-success state. */
function StateBlock({ state, error, empty, onRetry, children }) {
  if (state === 'LOADING') {
    return <div style={{ ...CARD, color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: 28 }}>Loading…</div>;
  }
  if (state === 'ERROR' || state === 'UNAUTHORIZED') {
    const unauth = state === 'UNAUTHORIZED';
    return (
      <div style={{ ...CARD, borderColor: unauth ? '#fde68a' : '#fecaca', background: unauth ? '#fffbeb' : '#fef2f2' }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          {unauth ? <Ban size={18} color="#b45309" /> : <AlertTriangle size={18} color="#dc2626" />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, color: unauth ? '#92400e' : '#991b1b', fontSize: 13 }}>
              {unauth ? 'Access denied' : 'Could not load this data'}
            </div>
            <div style={{ fontSize: 12, color: unauth ? '#92400e' : '#991b1b', marginTop: 3 }}>
              {error?.message}
              {error?.status ? ` (HTTP ${error.status})` : ''}
              {error?.code ? ` · ${error.code}` : ''}
            </div>
            {/* Deliberate: no numbers are shown alongside this message. An error
                rendered next to a zero reads as a measurement of zero. */}
            {onRetry && !unauth && (
              <button onClick={onRetry} style={{ ...btnSm, marginTop: 8 }}>Try again</button>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (state === 'EMPTY') {
    return <div style={{ ...CARD, color: '#9ca3af', fontSize: 13, textAlign: 'center', padding: 28 }}>{empty}</div>;
  }
  return children;
}

// ── clustered fleet map ───────────────────────────────────────────────────────
function FleetMap({ devices, onSelect, selected }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const clusterRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19,
    }).addTo(map);
    const cluster = L.markerClusterGroup({ maxClusterRadius: 45, showCoverageOnHover: false });
    map.addLayer(cluster);
    mapRef.current = map; clusterRef.current = cluster;
    return () => { map.remove(); mapRef.current = null; clusterRef.current = null; };
  }, []);

  useEffect(() => {
    const cluster = clusterRef.current, map = mapRef.current;
    if (!cluster || !map) return;
    cluster.clearLayers();
    const bounds = [];
    devices.forEach((d) => {
      // A device with no coordinates is NOT placed at 0,0. That is a real
      // location — a point in the Atlantic — and putting unlocated equipment
      // there produced a permanent phantom cluster off the coast of Africa.
      if (d.gps_lat == null || d.gps_lng == null) return;
      const lat = Number(d.gps_lat), lng = Number(d.gps_lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (lat === 0 && lng === 0) return;            // a stored 0,0 is almost certainly a null that was coerced

      const alert = d.open_alerts > 0;
      const ring = alert ? (SEV_COLOR[d.max_severity] || '#dc2626') : stateMeta(d.connection_state).color;
      const size = alert ? 34 : 26;
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:${size}px;height:${size}px;background:${ring};color:#fff;border-radius:50%;border:3px solid ${selected === d.id ? '#111827' : '#fff'};box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">${alert ? d.open_alerts : ''}</div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      });
      const m = L.marker([lat, lng], { icon });
      m.bindPopup(`<div style="min-width:170px"><div style="font-weight:700">${d.equipment_name || '—'}</div><div style="font-size:11px;color:#6b7280">${d.model_number || ''} · ${stateMeta(d.connection_state).label}</div></div>`);
      m.on('click', () => onSelect(d.id));
      cluster.addLayer(m);
      bounds.push([lat, lng]);
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
  }, [devices, onSelect, selected]);

  const unlocated = devices.filter((d) => d.gps_lat == null || d.gps_lng == null).length;

  return (
    <div>
      <div ref={containerRef} style={{ height: 320, width: '100%', borderRadius: 11, overflow: 'hidden' }} />
      {unlocated > 0 && (
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
          <CircleSlash size={12} />
          {unlocated} device{unlocated === 1 ? '' : 's'} not shown — location not recorded
        </div>
      )}
    </div>
  );
}

// ── device detail panel ───────────────────────────────────────────────────────
function DeviceDetail({ id, onChanged, pollMs }) {
  const [d, setD] = useState(null);
  const [status, setStatus] = useState('LOADING');
  const [error, setError] = useState(null);
  const [metric, setMetric] = useState(null);
  const [hours, setHours] = useState(24);
  const [series, setSeries] = useState(null);
  const [seriesStatus, setSeriesStatus] = useState('LOADING');
  const [token, setToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [risk, setRisk] = useState(null);

  /**
   * THE RACE GUARD. Every load stamps a token; a response whose token is no
   * longer current is discarded. Without this, switching from device A to device
   * B while A's request was in flight rendered A's readings under B's name — and
   * because both responses were valid 200s, nothing looked wrong.
   */
  const reqToken = useRef(0);
  const abortRef = useRef(null);

  const load = useCallback((quiet = false) => {
    const myToken = ++reqToken.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!quiet) { setStatus('LOADING'); setError(null); }

    api.get(`/iot/devices/${id}`, { signal: controller.signal })
      .then(({ data }) => {
        if (myToken !== reqToken.current) return;      // superseded
        setD(data);
        setStatus('SUCCESS');
        // The selected metric is revalidated against the NEW device — a metric
        // the previous device published may not exist on this one.
        setMetric((m) => {
          const available = (data.latest || []).map((r) => r.metric);
          return m && available.includes(m) ? m : available[0] || null;
        });
      })
      .catch((e) => {
        const err = toErrorState(e);
        if (!err || myToken !== reqToken.current) return;
        setError(err); setStatus(err.kind); setD(null);
      });

    api.get(`/iot/devices/${id}/risk`, { signal: controller.signal })
      .then(({ data }) => { if (myToken === reqToken.current) setRisk(data); })
      .catch((e) => { if (toErrorState(e) && myToken === reqToken.current) setRisk(null); });
  }, [id]);

  useEffect(() => { setToken(null); setD(null); setRisk(null); load(); }, [load]);

  // Live refresh for the SELECTED device, not just the fleet list — the old page
  // refreshed the list and left the open panel frozen at its first read.
  useEffect(() => {
    if (!pollMs) return undefined;
    const t = setInterval(() => load(true), pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!id || !metric) { setSeries(null); setSeriesStatus('EMPTY'); return undefined; }
    const myToken = reqToken.current;
    setSeriesStatus('LOADING');
    const controller = new AbortController();
    api.get(`/iot/devices/${id}/telemetry`, { params: { metric, hours }, signal: controller.signal })
      .then(({ data }) => {
        if (myToken !== reqToken.current) return;
        setSeries(data);
        setSeriesStatus(data.points?.length ? 'SUCCESS' : 'EMPTY');
      })
      .catch((e) => {
        const err = toErrorState(e);
        if (!err || myToken !== reqToken.current) return;
        setSeries(null); setSeriesStatus('ERROR');
      });
    return () => controller.abort();
  }, [id, metric, hours]);

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); load(); onChanged?.(); }
    catch (e) { setError(toErrorState(e)); }
    finally { setBusy(false); }
  };

  const provision = (rotate) => act(async () => {
    const url = rotate ? `/iot/devices/${id}/rotate-token` : `/iot/devices/${id}/provision`;
    const { data } = await api.post(url, { reason: rotate ? 'operator rotation' : 'initial provisioning' });
    setToken(data);
  });

  const copy = () => {
    if (!token?.token) return;
    navigator.clipboard?.writeText(token.token);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  if (status !== 'SUCCESS') {
    return <StateBlock state={status} error={error} onRetry={() => load()} empty="No device selected." />;
  }

  const conn = d.connection || {};
  const chartData = (series?.points || []).map((p) => ({
    label: new Date(p.bucket).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
    value: p.value,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* identity + connection truth */}
      <div style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>{d.equipment_name}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {d.model_number || '—'} · SN {d.serial_number || 'not recorded'}
              {d.profile?.device_type ? ` · ${d.profile.device_type}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {d.in_maintenance && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#e0e7ff', color: '#3730a3', padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600 }}>
                <Wrench size={11} /> Maintenance
              </span>
            )}
            {d.device_status && d.device_status !== 'active' && (
              <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600 }}>
                {d.device_status}
              </span>
            )}
            <StatePill state={conn.state} />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 12, fontSize: 12, color: '#6b7280' }}>
          <span>
            <MapPin size={12} style={{ verticalAlign: -2 }} />{' '}
            {d.gps_lat != null && d.gps_lng != null
              ? `${Number(d.gps_lat).toFixed(3)}, ${Number(d.gps_lng).toFixed(3)}`
              : <em style={{ color: '#9ca3af' }}>Location not recorded</em>}
          </span>
          <span>Last telemetry: <b style={{ color: '#374151' }}>{fmtWhen(conn.last_telemetry_received)}</b></span>
          <span>Data age: <b style={{ color: '#374151' }}>{fmtAge(conn.data_age_secs)}</b></span>
          <span>
            Sampling: {conn.configured_sampling_secs ? `${conn.configured_sampling_secs}s` : 'not configured'}
            {conn.actual_sampling_secs && conn.actual_sampling_secs !== conn.configured_sampling_secs
              ? ` (gateway reports ${conn.actual_sampling_secs}s)` : ''}
          </span>
          <span>Warranty: {d.warranty_status || 'not recorded'}</span>
          <span>AMC: {d.amc_status || 'not recorded'}</span>
        </div>

        {/* the business chain, navigable rather than implied */}
        {d.business && (d.business.customer_name || d.business.project_name || d.business.amc_number) && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, paddingTop: 10, borderTop: '1px solid #f3f4f6' }}>
            {d.business.customer_id && (
              <a href={`/crm/accounts?id=${d.business.customer_id}`} style={{ ...btnSm, textDecoration: 'none' }}>
                <Building2 size={12} /> {d.business.customer_name}
              </a>
            )}
            {d.business.project_id && (
              <a href={`/projects/overview?id=${d.business.project_id}`} style={{ ...btnSm, textDecoration: 'none' }}>
                <FolderKanban size={12} /> {d.business.project_name}
              </a>
            )}
            {d.business.amc_id && (
              <a href={`/servicedesk/amc?id=${d.business.amc_id}`} style={{ ...btnSm, textDecoration: 'none' }}>
                <ShieldCheck size={12} /> AMC {d.business.amc_number}
              </a>
            )}
          </div>
        )}

        {d.gateway && (
          <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280' }}>
            Gateway <b style={{ color: '#374151' }}>{d.gateway.gateway_uid}</b> · heartbeat {fmtWhen(d.gateway.last_heartbeat_at)} · queue {d.gateway.queue_depth}
          </div>
        )}
      </div>

      {/* condition risk — named for what it is */}
      {risk && (
        <div style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Gauge size={15} color={risk.state === 'OK' ? RISK_COLOR[risk.band] : '#6b7280'} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Condition Risk Score</span>
          </div>
          {risk.state === 'INSUFFICIENT_DATA' ? (
            <div style={{ background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 9, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.04em' }}>
                Insufficient data
              </div>
              <div style={{ fontSize: 13, color: '#374151', marginTop: 4 }}>{risk.recommendation}</div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span style={{ fontSize: 34, fontWeight: 800, color: RISK_COLOR[risk.band], lineHeight: 1 }}>{risk.score}</span>
                <span style={{ fontSize: 13, color: '#9ca3af' }}>/ 100</span>
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: RISK_COLOR[risk.band] }}>
                  {risk.band} risk
                </div>
                <div style={{ fontSize: 13, color: '#374151', marginTop: 4 }}>{risk.recommendation}</div>
                {risk.drivers?.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {risk.drivers.slice(0, 5).map((dr, i) => (
                      <span key={i} title={dr.evidence} style={{ fontSize: 11, background: '#f3f4f6', color: '#4b5563', borderRadius: 7, padding: '2px 8px' }}>
                        {dr.factor} <b style={{ color: '#111827' }}>+{dr.points}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 10, lineHeight: 1.4 }}>
            A weighted sum of observed alert, connectivity, trend and contract-cover signals. Not a validated failure probability.
          </div>
          {/* projections, only where the trend actually supports one */}
          {risk.trends?.filter((t) => t.projection?.state === 'OK').map((t) => (
            <div key={t.metric} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280', marginTop: 8, paddingTop: 8, borderTop: '1px solid #f3f4f6' }}>
              <TrendingUp size={12} color="#6d28d9" />
              <b style={{ color: '#111827' }}>{t.metric}</b> rising — reaches {t.projection.threshold} in about{' '}
              <b style={{ color: '#111827' }}>{t.projection.days}d</b>
              <span style={{ fontSize: 10, color: '#9ca3af' }}>
                ({t.trend.n} samples / {t.trend.coverageHours}h, R²={t.trend.r2})
              </span>
            </div>
          ))}
          {risk.trends?.some((t) => t.trend?.state !== 'OK') && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
              {risk.trends.filter((t) => t.trend?.state !== 'OK').length} metric(s) have too little history for a trend
              (needs {risk.trend_requirements?.samples} samples over {risk.trend_requirements?.coverageHours}h).
            </div>
          )}
        </div>
      )}

      {/* latest readings, with units and quality */}
      <div style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Latest readings</div>
        {d.latest?.length ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {d.latest.map((r) => {
              const suspect = r.quality_code && r.quality_code !== 'VALID';
              return (
                <button key={r.metric} onClick={() => setMetric(r.metric)}
                  title={`${r.display_name || r.metric}${suspect ? ` · quality ${r.quality_code}` : ''}`}
                  style={{ textAlign: 'left', cursor: 'pointer', border: metric === r.metric ? '1.5px solid #6B3FDB' : '1px solid #eee', background: metric === r.metric ? '#f5f2ff' : '#fafafa', borderRadius: 9, padding: '8px 12px', minWidth: 104 }}>
                  <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.03em' }}>{r.metric}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: suspect ? '#b45309' : '#111827', fontVariantNumeric: 'tabular-nums' }}>
                    {r.value ?? '—'}<span style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500 }}> {r.unit || ''}</span>
                  </div>
                  <div style={{ fontSize: 10, color: suspect ? '#b45309' : '#9ca3af' }}>
                    {suspect ? r.quality_code : fmtWhen(r.event_ts)}
                  </div>
                </button>
              );
            })}
          </div>
        ) : <div style={{ color: '#9ca3af', fontSize: 13 }}>No telemetry recorded for this device yet.</div>}
      </div>

      {/* history with a selectable range, coverage and gaps */}
      {metric && (
        <VizCard
          title={`${metric}${series?.unit ? ` (${series.unit})` : ''}`}
          icon={<Activity size={15} />}
          action={
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}
              style={{ fontSize: 11, border: '1px solid #e5e7eb', borderRadius: 6, padding: '3px 6px' }}>
              {[1, 6, 24, 24 * 7, 24 * 14, 24 * 30, 24 * 90].map((h) => (
                <option key={h} value={h}>{h < 24 ? `${h}h` : `${h / 24}d`}</option>
              ))}
            </select>
          }
        >
          {seriesStatus === 'LOADING' && <div style={{ color: '#9ca3af', fontSize: 13, padding: 20 }}>Loading…</div>}
          {seriesStatus === 'ERROR' && (
            <div style={{ color: '#991b1b', fontSize: 13, padding: 20 }}>
              The history could not be loaded. This is a failure, not an absence of data.
            </div>
          )}
          {seriesStatus === 'EMPTY' && (
            <div style={{ color: '#9ca3af', fontSize: 13, padding: 20 }}>No samples in this window.</div>
          )}
          {seriesStatus === 'SUCCESS' && (
            <>
              <TrendArea data={chartData} height={180} name={metric} />
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 8, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                <span>{series.sample_count} samples ({series.valid_count} valid)</span>
                {series.coverage?.state === 'OK' && (
                  <span title={series.coverage.formula}>
                    Coverage <b style={{ color: series.coverage.value < 90 ? '#b45309' : '#374151' }}>{series.coverage.value}%</b>
                    {' '}({series.coverage.numerator} of {series.coverage.denominator} expected)
                  </span>
                )}
                {series.coverage?.state !== 'OK' && (
                  <span style={{ color: '#9ca3af' }}>Coverage unknown — {series.coverage?.note || 'no sampling interval configured'}</span>
                )}
                {series.gaps?.length > 0 && (
                  <span style={{ color: '#b45309' }}>
                    ⚠ {series.gaps.length} gap{series.gaps.length === 1 ? '' : 's'} in this window
                    {' '}(longest {Math.max(...series.gaps.map((g) => g.minutes))}m)
                  </span>
                )}
                <span style={{ color: '#9ca3af' }}>{series.bucket_mins}m buckets</span>
              </div>
            </>
          )}
        </VizCard>
      )}

      {/* alerts, with the ticket actually visible */}
      <div style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Alerts</span>
          <a href="/iot/alert-center" style={{ ...btnSm, textDecoration: 'none', fontSize: 11 }}>
            Alert Centre <ExternalLink size={11} />
          </a>
        </div>
        {d.alerts?.length ? d.alerts.slice(0, 10).map((a) => {
          const live = ['pending_confirmation', 'active', 'acknowledged', 'recovery_pending'].includes(a.state);
          return (
            <div key={a.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', borderBottom: '1px solid #f7f7f9' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[a.severity] || '#6b7280', flex: 'none', marginTop: 5 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: '#111827' }}>{a.message}</div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  {a.state} · {fmtWhen(a.opened_at)}
                  {a.breach_count > 1 ? ` · ${a.breach_count} breaches` : ''}
                  {a.resolution_source ? ` · resolved by ${a.resolution_source.replace(/_/g, ' ')}` : ''}
                </div>
                {a.ticket_id && (
                  <a href={`/servicedesk/tickets?id=${a.ticket_id}`}
                     style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6B3FDB', textDecoration: 'none', marginTop: 4 }}>
                    <Ticket size={11} /> {a.ticket_number || `Ticket #${a.ticket_id}`}
                    {a.ticket_status ? ` · ${a.ticket_status}` : ''}
                    {a.technician_name ? ` · ${a.technician_name}` : ' · unassigned'}
                  </a>
                )}
              </div>
              {live && (
                <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
                  {a.state === 'active' && (
                    <button onClick={() => act(() => api.put(`/iot/alerts/${a.id}/ack`))} disabled={busy} style={btnSm}>Ack</button>
                  )}
                  <button onClick={() => act(() => api.put(`/iot/alerts/${a.id}/resolve`, { reason: 'resolved from fleet monitor' }))}
                          disabled={busy} style={{ ...btnSm, color: '#059669', borderColor: '#a7f3d0' }}>Resolve</button>
                </div>
              )}
            </div>
          );
        }) : <div style={{ color: '#9ca3af', fontSize: 13 }}>No alerts recorded for this device.</div>}
      </div>

      {/* provisioning + credential lifecycle */}
      <div style={CARD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {d.provisioned ? <ShieldCheck size={15} color="#059669" /> : <KeyRound size={15} color="#6d28d9" />}
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
            {d.provisioned ? `Provisioned · ${d.device_status}` : 'Not provisioned'}
          </span>
        </div>
        {token ? (
          <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 9, padding: 12 }}>
            <div style={{ fontSize: 12, color: '#5b21b6', marginBottom: 6 }}>
              Store this token now — it cannot be retrieved again. device_uid: <b>{token.device_uid}</b>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{ flex: 1, fontSize: 12, background: '#fff', border: '1px solid #eee', borderRadius: 6, padding: '6px 8px', wordBreak: 'break-all' }}>{token.token}</code>
              <button onClick={copy} style={btnSm}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => provision(d.provisioned)} disabled={busy} style={{ ...btnSm, padding: '7px 12px' }}>
              {busy ? 'Working…' : d.provisioned ? 'Rotate token' : 'Provision device'}
            </button>
            {d.provisioned && d.device_status === 'active' && (
              <button
                onClick={() => act(() => api.post(`/iot/devices/${id}/revoke-token`, { reason: 'revoked from fleet monitor' }))}
                disabled={busy} style={{ ...btnSm, color: '#991b1b', borderColor: '#fecaca' }}>
                Revoke token
              </button>
            )}
            {d.device_status === 'disabled' && (
              <button onClick={() => act(() => api.post(`/iot/devices/${id}/enable`))} disabled={busy} style={btnSm}>
                Re-enable
              </button>
            )}
            {d.device_status === 'active' && (
              <button onClick={() => act(() => api.post(`/iot/devices/${id}/disable`, { reason: 'disabled from fleet monitor' }))}
                      disabled={busy} style={btnSm}>
                Disable
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
const POLL_OPTIONS = [
  { label: 'Off', ms: 0 },
  { label: '15s', ms: 15000 },
  { label: '30s', ms: 30000 },
  { label: '1m', ms: 60000 },
  { label: '5m', ms: 300000 },
];

export default function FleetMonitor() {
  const [devices, setDevices] = useState([]);
  const [listState, setListState] = useState('LOADING');
  const [listError, setListError] = useState(null);
  const [summary, setSummary] = useState(null);
  const [summaryState, setSummaryState] = useState('LOADING');
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [pollMs, setPollMs] = useState(30000);
  const [lastUpdated, setLastUpdated] = useState(null);
  // A ticking clock in state rather than Date.now() at render time: reading the
  // wall clock during render makes the output depend on when React happens to
  // re-render, which is exactly the impurity the lint rule is pointing at.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const listToken = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const loadList = useCallback((quiet = false) => {
    const myToken = ++listToken.current;
    if (!quiet) { setListState('LOADING'); setListError(null); }
    api.get('/iot/devices', { params: { ...(debounced ? { search: debounced } : {}), limit: 300 } })
      .then(({ data }) => {
        if (myToken !== listToken.current) return;
        const rows = data.rows || [];
        setDevices(rows);
        setListState(rows.length ? 'SUCCESS' : 'EMPTY');
        setLastUpdated(new Date());
      })
      .catch((e) => {
        const err = toErrorState(e);
        if (!err || myToken !== listToken.current) return;
        // NOT setDevices([]) — an error is not an empty fleet.
        setListError(err); setListState(err.kind);
      });
  }, [debounced]);

  /**
   * KPIs are a separate request over the WHOLE population. The search box changes
   * the list below and deliberately does not change these numbers.
   */
  const loadSummary = useCallback((quiet = false) => {
    if (!quiet) setSummaryState('LOADING');
    api.get('/iot/fleet/summary')
      .then(({ data }) => { setSummary(data); setSummaryState('SUCCESS'); })
      .catch((e) => {
        const err = toErrorState(e);
        if (!err) return;
        setSummary(null); setSummaryState(err.kind);
      });
  }, []);

  const refresh = useCallback((quiet = false) => { loadList(quiet); loadSummary(quiet); }, [loadList, loadSummary]);

  useEffect(() => { refresh(); }, [refresh]);

  // Live polling. Pauses while the tab is hidden: a dashboard left open
  // overnight should not spend the night polling.
  useEffect(() => {
    if (!pollMs) return undefined;
    let timer = null;
    const start = () => { timer = setInterval(() => { if (!document.hidden) refresh(true); }, pollMs); };
    start();
    const onVis = () => { if (!document.hidden) refresh(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [pollMs, refresh]);

  // Keeps "12s ago" honest between polls.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const ageSecs = lastUpdated ? Math.round((nowMs - lastUpdated.getTime()) / 1000) : null;

  const kpis = useMemo(() => {
    if (summaryState !== 'SUCCESS' || !summary) return null;
    return [
      { icon: Radio, label: 'Provisioned', value: summary.provisioned, color: '#6B3FDB', sub: `${summary.equipment_total} equipment records` },
      { icon: Wifi, label: 'Live', value: summary.online, color: '#059669' },
      { icon: Activity, label: 'Stale', value: summary.stale, color: '#b45309' },
      { icon: WifiOff, label: 'Offline', value: summary.offline, color: '#dc2626' },
      { icon: PlugZap, label: 'Never connected', value: summary.never_connected, color: '#6b7280', sub: 'not a fault — not yet commissioned' },
      { icon: AlertTriangle, label: 'Open alerts', value: summary.open_alerts, color: '#dc2626', sub: `${summary.critical} critical` },
      { icon: Wrench, label: 'In maintenance', value: summary.in_maintenance, color: '#3730a3' },
    ];
  }, [summary, summaryState]);

  return (
    <PageShell dock={
      <PageHero
        icon={Cpu}
        eyebrow="IoT"
        title="Fleet Monitor"
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select value={pollMs} onChange={(e) => setPollMs(Number(e.target.value))}
              title="Live refresh interval"
              style={{ fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 7, padding: '5px 8px', background: '#fff' }}>
              {POLL_OPTIONS.map((o) => <option key={o.ms} value={o.ms}>Auto: {o.label}</option>)}
            </select>
            <button className="plh-cta" onClick={() => refresh()} title="Refresh now">
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        }
      />
    }>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '0 0 14px' }}>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>
          Deployed AHF / SVG / STATCOM units, their latest readings, and open alerts.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#6b7280' }}>
          {pollMs ? <Play size={11} color="#059669" /> : <Pause size={11} />}
          {lastUpdated
            ? <>Updated {ageSecs < 5 ? 'just now' : `${fmtAge(ageSecs)} ago`}{pollMs ? ` · auto every ${POLL_OPTIONS.find((o) => o.ms === pollMs)?.label}` : ' · auto-refresh off'}</>
            : 'Not yet loaded'}
        </div>
      </div>

      {/* KPIs — whole-population, never derived from the list below */}
      {summaryState === 'SUCCESS' && kpis && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
          {kpis.map((k) => <Kpi key={k.label} {...k} />)}
        </div>
      )}
      {summaryState !== 'SUCCESS' && summaryState !== 'LOADING' && (
        <div style={{ marginBottom: 8 }}>
          <StateBlock state={summaryState} error={listError} onRetry={() => loadSummary()} />
        </div>
      )}
      {summary?.invalid_state_rows > 0 && (
        <div style={{ ...CARD, borderColor: '#fde68a', background: '#fffbeb', marginBottom: 12, fontSize: 12, color: '#92400e' }}>
          <b>{summary.invalid_state_rows} alert row(s)</b> hold a state outside the supported vocabulary (legacy seed data written before
          the state constraint existed). They are excluded from every count on this page. See IoT Health → Reconciliation.
        </div>
      )}

      <div className="iot-fleet-grid" style={{ display: 'grid', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div style={CARD}>
            <FleetMap devices={devices} onSelect={setSelected} selected={selected} />
          </div>

          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: 12, borderBottom: '1px solid #f0f0f4', display: 'flex', gap: 8, alignItems: 'center' }}>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, serial, model, tag…"
                style={{ flex: 1, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, minWidth: 0 }} />
              {search && (
                <span style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                  filtering the list only
                </span>
              )}
            </div>

            {listState !== 'SUCCESS' ? (
              <div style={{ padding: 14 }}>
                <StateBlock
                  state={listState}
                  error={listError}
                  onRetry={() => loadList()}
                  empty={search ? 'No device matches this search.' : 'No equipment records in this company yet.'}
                />
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                  <thead><tr>
                    <th style={TH}>Device</th><th style={TH}>State</th><th style={TH}>Last seen</th>
                    <th style={TH}>Alerts</th><th style={TH}>Cover</th>
                  </tr></thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.id} onClick={() => setSelected(d.id)}
                        style={{ cursor: 'pointer', background: selected === d.id ? '#f5f2ff' : 'transparent' }}>
                        <td style={TD}>
                          <div style={{ fontWeight: 600, color: '#111827' }}>{d.equipment_name}</div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>
                            {d.model_number || '—'}{d.serial_number ? ` · ${d.serial_number}` : ''}
                          </div>
                        </td>
                        <td style={TD}>
                          <StatePill state={d.provisioned ? d.connection_state : 'never'} />
                          {!d.provisioned && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>not provisioned</div>}
                          {d.in_maintenance && <div style={{ fontSize: 10, color: '#3730a3', marginTop: 2 }}>maintenance</div>}
                        </td>
                        <td style={{ ...TD, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtWhen(d.last_seen_at)}</td>
                        <td style={TD}>
                          {d.open_alerts > 0
                            ? <span style={{ color: SEV_COLOR[d.max_severity] || '#dc2626', fontWeight: 700 }}>{d.open_alerts}</span>
                            : <span style={{ color: '#d1d5db' }}>0</span>}
                        </td>
                        <td style={{ ...TD, fontSize: 11, color: '#6b7280' }}>
                          {String(d.amc_status || '').toLowerCase() === 'active' ? 'AMC'
                            : String(d.warranty_status || '').toLowerCase() === 'active' ? 'Warranty'
                            : <span style={{ color: '#d1d5db' }}>none</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="iot-detail-col">
          {selected
            ? <DeviceDetail id={selected} onChanged={() => refresh(true)} pollMs={pollMs} />
            : <div style={{ ...CARD, color: '#9ca3af', fontSize: 13 }}>
                Select a device on the map or in the list to inspect its readings, alerts and provisioning.
              </div>}
        </div>
      </div>

      {/* Responsive: the two-column layout collapses rather than being squeezed,
          and the detail panel stops being sticky on a phone (a sticky panel on a
          short viewport pins the content out of reach). */}
      <style>{`
        .iot-fleet-grid { grid-template-columns: minmax(0, 1.4fr) minmax(330px, 1fr); }
        .iot-detail-col { position: sticky; top: 12px; }
        @media (max-width: 1024px) {
          .iot-fleet-grid { grid-template-columns: 1fr; }
          .iot-detail-col { position: static; }
        }
      `}</style>
    </PageShell>
  );
}
