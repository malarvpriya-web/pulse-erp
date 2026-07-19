import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Radio, Wifi, WifiOff, AlertTriangle, RefreshCw, KeyRound, Copy, Check,
  Activity, MapPin, ShieldCheck, Gauge, TrendingUp,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import api from '@/services/api/client';
import { VizCard, TrendArea, ProgressRing } from '@/components/charts/PulseViz';

const RISK_COLOR = { high: '#dc2626', medium: '#d97706', low: '#059669' };

// ── connection-state + severity vocab ─────────────────────────────────────────
const STATE_META = {
  online:  { label: 'Online',  color: '#059669', bg: '#dcfce7', Icon: Wifi },
  stale:   { label: 'Stale',   color: '#d97706', bg: '#fef3c7', Icon: Activity },
  offline: { label: 'Offline', color: '#6b7280', bg: '#f3f4f6', Icon: WifiOff },
  never:   { label: 'Never seen', color: '#9ca3af', bg: '#f3f4f6', Icon: WifiOff },
};
const SEV_COLOR = { critical: '#dc2626', warning: '#d97706', info: '#2563eb' };
const stateMeta = (s) => STATE_META[s] || STATE_META.never;

const fmtWhen = (v) => {
  if (!v) return 'never';
  const secs = (Date.now() - new Date(v).getTime()) / 1000;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '9px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13 };

function StatePill({ state }) {
  const m = stateMeta(state);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: m.bg, color: m.color, padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600 }}>
      <m.Icon size={12} /> {m.label}
    </span>
  );
}

function Kpi({ icon: Icon, label, value, color }) {
  return (
    <div style={{ ...CARD, flex: 1, minWidth: 150, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}18`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={20} />
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{value}</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{label}</div>
      </div>
    </div>
  );
}

// ── clustered fleet map ───────────────────────────────────────────────────────
function FleetMap({ devices, onSelect }) {
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
      const lat = Number(d.gps_lat), lng = Number(d.gps_lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const alert = d.open_alerts > 0;
      const ring = alert ? (SEV_COLOR[d.max_severity] || '#dc2626') : stateMeta(d.connection_state).color;
      const size = alert ? 34 : 26;
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:${size}px;height:${size}px;background:${ring};color:#fff;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">${alert ? d.open_alerts : ''}</div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      });
      const m = L.marker([lat, lng], { icon });
      m.bindPopup(`<div style="min-width:170px"><div style="font-weight:700">${d.equipment_name || '—'}</div><div style="font-size:11px;color:#6b7280">${d.model_number || ''} · ${stateMeta(d.connection_state).label}</div></div>`);
      m.on('click', () => onSelect(d.id));
      cluster.addLayer(m);
      bounds.push([lat, lng]);
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
  }, [devices, onSelect]);

  return <div ref={containerRef} style={{ height: 360, width: '100%', borderRadius: 11, overflow: 'hidden' }} />;
}

// ── device detail panel ───────────────────────────────────────────────────────
function DeviceDetail({ id, onChanged }) {
  const [d, setD] = useState(null);
  const [metric, setMetric] = useState(null);
  const [series, setSeries] = useState([]);
  const [token, setToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState(null);

  const load = useCallback(() => {
    api.get(`/iot/devices/${id}`).then(({ data }) => {
      setD(data);
      setMetric((m) => m || data.latest?.[0]?.metric || null);
    }).catch(() => setD(null));
    api.get(`/ai/predict/device-failure/${id}`)
      .then(({ data }) => setHealth(data.data))
      .catch(() => setHealth(null));
  }, [id]);

  useEffect(() => { setToken(null); load(); }, [load]);

  useEffect(() => {
    if (!id || !metric) { setSeries([]); return; }
    api.get(`/iot/devices/${id}/telemetry`, { params: { metric, hours: 24 } })
      .then(({ data }) => setSeries((data.points || []).map((p) => ({
        label: new Date(p.bucket).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        value: p.value,
      }))))
      .catch(() => setSeries([]));
  }, [id, metric]);

  const provision = async (rotate) => {
    setBusy(true);
    try {
      const url = rotate ? `/iot/devices/${id}/rotate-token` : `/iot/devices/${id}/provision`;
      const { data } = await api.post(url);
      setToken(data);
      load(); onChanged?.();
    } finally { setBusy(false); }
  };

  const copy = () => {
    if (!token?.token) return;
    navigator.clipboard?.writeText(token.token);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  if (!d) return <div style={{ ...CARD, color: '#9ca3af' }}>Select a device to inspect.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={CARD}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>{d.equipment_name}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{d.model_number || '—'} · SN {d.serial_number || '—'}</div>
          </div>
          <StatePill state={d.connection_state} />
        </div>
        <div style={{ display: 'flex', gap: 18, marginTop: 12, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
          <span><MapPin size={12} style={{ verticalAlign: -2 }} /> {d.gps_lat && d.gps_lng ? `${Number(d.gps_lat).toFixed(3)}, ${Number(d.gps_lng).toFixed(3)}` : 'no location'}</span>
          <span>Last seen: {fmtWhen(d.last_seen_at)}</span>
          <span>Warranty: {d.warranty_status || '—'}</span>
          <span>AMC: {d.amc_status || '—'}</span>
        </div>
      </div>

      {/* predicted health */}
      {health && (
        <div style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Gauge size={15} color={RISK_COLOR[health.risk_band]} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Predicted health</span>
          </div>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <ProgressRing value={health.risk_score} size={92} stroke={9}
              color={RISK_COLOR[health.risk_band]} label={`${health.risk_score}`} sublabel="risk" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: RISK_COLOR[health.risk_band] }}>
                {health.risk_band} risk
              </div>
              <div style={{ fontSize: 13, color: '#374151', marginTop: 4 }}>{health.recommendation}</div>
              {health.drivers?.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {health.drivers.slice(0, 4).map((dr, i) => (
                    <span key={i} style={{ fontSize: 11, background: '#f3f4f6', color: '#4b5563', borderRadius: 7, padding: '2px 8px' }}>
                      {dr.factor} <b style={{ color: '#111827' }}>+{dr.points}</b>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          {health.trends?.some((t) => t.days_to_threshold != null) && (
            <div style={{ marginTop: 12, borderTop: '1px solid #f3f4f6', paddingTop: 10 }}>
              {health.trends.filter((t) => t.days_to_threshold != null).map((t) => (
                <div key={t.metric} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280', padding: '2px 0' }}>
                  <TrendingUp size={12} color="#d97706" />
                  <b style={{ color: '#111827' }}>{t.metric}</b> rising — reaches {t.threshold} in ~<b style={{ color: '#111827' }}>{t.days_to_threshold}d</b>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* latest readings */}
      <div style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Latest readings</div>
        {d.latest?.length ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {d.latest.map((r) => (
              <button key={r.metric} onClick={() => setMetric(r.metric)}
                style={{ textAlign: 'left', cursor: 'pointer', border: metric === r.metric ? '1.5px solid #6B3FDB' : '1px solid #eee', background: metric === r.metric ? '#f5f2ff' : '#fafafa', borderRadius: 9, padding: '8px 12px', minWidth: 92 }}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.03em' }}>{r.metric}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#111827', fontVariantNumeric: 'tabular-nums' }}>{r.value ?? '—'}</div>
                <div style={{ fontSize: 10, color: '#9ca3af' }}>{fmtWhen(r.ts)}</div>
              </button>
            ))}
          </div>
        ) : <div style={{ color: '#9ca3af', fontSize: 13 }}>No telemetry yet.</div>}
      </div>

      {/* trend */}
      {metric && (
        <VizCard title={`${metric} · last 24h`} icon={<Activity size={15} />}>
          {series.length ? <TrendArea data={series} height={180} name={metric} />
            : <div style={{ color: '#9ca3af', fontSize: 13, padding: 20 }}>No samples in the last 24 hours.</div>}
        </VizCard>
      )}

      {/* alerts */}
      <div style={CARD}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Alerts</div>
        {d.alerts?.length ? d.alerts.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f7f7f9' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV_COLOR[a.severity] || '#6b7280', flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: '#111827' }}>{a.message}</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{a.state} · {fmtWhen(a.opened_at)}</div>
            </div>
            {a.state !== 'resolved' && (
              <div style={{ display: 'flex', gap: 6 }}>
                {a.state === 'open' && <button onClick={() => api.put(`/iot/alerts/${a.id}/ack`).then(() => { load(); onChanged?.(); })} style={btnSm}>Ack</button>}
                <button onClick={() => api.put(`/iot/alerts/${a.id}/resolve`).then(() => { load(); onChanged?.(); })} style={{ ...btnSm, color: '#059669', borderColor: '#a7f3d0' }}>Resolve</button>
              </div>
            )}
          </div>
        )) : <div style={{ color: '#9ca3af', fontSize: 13 }}>No alerts.</div>}
      </div>

      {/* provisioning */}
      <div style={CARD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          {d.provisioned ? <ShieldCheck size={15} color="#059669" /> : <KeyRound size={15} color="#d97706" />}
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
            {d.provisioned ? 'Provisioned for telemetry' : 'Not provisioned'}
          </span>
        </div>
        {token ? (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 9, padding: 12 }}>
            <div style={{ fontSize: 12, color: '#92400e', marginBottom: 6 }}>
              Store this token now — it cannot be retrieved again. device_uid: <b>{token.device_uid}</b>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{ flex: 1, fontSize: 12, background: '#fff', border: '1px solid #eee', borderRadius: 6, padding: '6px 8px', wordBreak: 'break-all' }}>{token.token}</code>
              <button onClick={copy} style={btnSm}>{copied ? <Check size={13} /> : <Copy size={13} />}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => provision(d.provisioned)} disabled={busy} style={{ ...btnSm, padding: '7px 12px' }}>
            {busy ? 'Working…' : d.provisioned ? 'Rotate token' : 'Provision device'}
          </button>
        )}
      </div>
    </div>
  );
}

const btnSm = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 7, padding: '4px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };

// ── page ──────────────────────────────────────────────────────────────────────
export default function FleetMonitor() {
  const [devices, setDevices] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [risk, setRisk] = useState({ map: {}, high: 0 });

  const load = useCallback(() => {
    setLoading(true);
    api.get('/iot/devices', { params: search ? { search } : {} })
      .then(({ data }) => setDevices(Array.isArray(data) ? data : []))
      .catch(() => setDevices([]))
      .finally(() => setLoading(false));
    api.get('/ai/predict/device-failure')
      .then(({ data }) => {
        const map = {};
        (data.data || []).forEach((r) => { map[r.equipment_id] = r; });
        setRisk({ map, high: data.summary?.high || 0 });
      })
      .catch(() => setRisk({ map: {}, high: 0 }));
  }, [search]);

  useEffect(() => { load(); }, [load]);

  const kpis = useMemo(() => {
    const online = devices.filter((d) => d.connection_state === 'online').length;
    const down = devices.filter((d) => ['offline', 'stale', 'never'].includes(d.connection_state)).length;
    const alerts = devices.reduce((s, d) => s + (d.open_alerts || 0), 0);
    return { total: devices.length, online, down, alerts };
  }, [devices]);

  return (
    <div className="pulse-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Radio size={22} color="#6B3FDB" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>Fleet Monitor</h1>
        <button onClick={load} title="Refresh" style={{ ...btnSm, marginLeft: 'auto' }}>
          <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
        </button>
      </div>
      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>
        Live status of deployed AHF / SVG / STATCOM units, their latest readings, and open alerts.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Kpi icon={Radio} label="Devices" value={kpis.total} color="#6B3FDB" />
        <Kpi icon={Wifi} label="Online" value={kpis.online} color="#059669" />
        <Kpi icon={WifiOff} label="Offline / stale" value={kpis.down} color="#6b7280" />
        <Kpi icon={AlertTriangle} label="Open alerts" value={kpis.alerts} color="#dc2626" />
        <Kpi icon={Gauge} label="High failure risk" value={risk.high} color="#dc2626" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div style={CARD}><FleetMap devices={devices} onSelect={setSelected} /></div>
          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: 12, borderBottom: '1px solid #f0f0f4' }}>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, serial, model…"
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480 }}>
                <thead><tr><th style={TH}>Device</th><th style={TH}>State</th><th style={TH}>Risk</th><th style={TH}>Last seen</th><th style={TH}>Alerts</th></tr></thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.id} onClick={() => setSelected(d.id)}
                      style={{ cursor: 'pointer', background: selected === d.id ? '#f5f2ff' : 'transparent' }}>
                      <td style={TD}>
                        <div style={{ fontWeight: 600, color: '#111827' }}>{d.equipment_name}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{d.model_number || '—'}</div>
                      </td>
                      <td style={TD}><StatePill state={d.connection_state} /></td>
                      <td style={TD}>
                        {risk.map[d.id]
                          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <span style={{ width: 8, height: 8, borderRadius: '50%', background: RISK_COLOR[risk.map[d.id].risk_band], flex: 'none' }} />
                              <span style={{ fontWeight: 700, color: '#374151', fontVariantNumeric: 'tabular-nums' }}>{risk.map[d.id].risk_score}</span>
                            </span>
                          : <span style={{ color: '#d1d5db' }}>—</span>}
                      </td>
                      <td style={{ ...TD, color: '#6b7280' }}>{fmtWhen(d.last_seen_at)}</td>
                      <td style={TD}>
                        {d.open_alerts > 0
                          ? <span style={{ color: SEV_COLOR[d.max_severity] || '#dc2626', fontWeight: 700 }}>{d.open_alerts}</span>
                          : <span style={{ color: '#d1d5db' }}>0</span>}
                      </td>
                    </tr>
                  ))}
                  {!devices.length && !loading && (
                    <tr><td style={{ ...TD, color: '#9ca3af', textAlign: 'center' }} colSpan={5}>No devices found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div style={{ position: 'sticky', top: 12 }}>
          {selected ? <DeviceDetail id={selected} onChanged={load} /> : <div style={{ ...CARD, color: '#9ca3af', fontSize: 13 }}>Select a device on the map or list to inspect its readings, alerts, and provisioning.</div>}
        </div>
      </div>
    </div>
  );
}
