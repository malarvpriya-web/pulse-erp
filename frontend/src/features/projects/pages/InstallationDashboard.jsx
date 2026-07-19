import { useState, useEffect, useRef, useMemo } from 'react';
import { Hammer, CheckCircle, Clock, AlertTriangle, RefreshCw, Download, MapPin } from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, LabelList,
} from 'recharts';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import * as XLSX from 'xlsx';
import api from '@/services/api/client';
import '@/components/dashboard/dashkit.css';

const STATUS_META = {
  active:      { label: 'Active',      bg: '#ede9fe', color: '#4f46e5' },
  planning:    { label: 'Planning',    bg: '#fef3c7', color: '#92400e' },
  completed:   { label: 'Completed',   bg: '#dcfce7', color: '#15803d' },
  on_hold:     { label: 'On Hold',     bg: '#f3f4f6', color: '#6b7280' },
  cancelled:   { label: 'Cancelled',   bg: '#fee2e2', color: '#dc2626' },
};

const COMMISSION_META = {
  completed:   { label: 'Done',        bg: '#dcfce7', color: '#15803d' },
  in_progress: { label: 'In Progress', bg: '#ede9fe', color: '#4f46e5' },
  scheduled:   { label: 'Scheduled',   bg: '#fef3c7', color: '#92400e' },
  pending:     { label: 'Pending',     bg: '#f3f4f6', color: '#6b7280' },
};

// Categorical palette (brand purple lead; blue/green/amber series follow).
const PALETTE = ['#6B3FDB', '#2563eb', '#059669', '#f59e0b', '#dc2626', '#0891b2', '#8b5cf6', '#db2777', '#65a30d'];
const UNASSIGNED = 'Unassigned';

function Badge({ value, meta }) {
  const m = (value && meta[value]) || { label: value || '—', bg: '#f3f4f6', color: '#6b7280' };
  return (
    <span style={{
      background: m.bg, color: m.color,
      padding: '2px 8px', borderRadius: 9, fontSize: 11, fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

function ProgressBar({ pct }) {
  const p = Math.min(100, Math.max(0, Number(pct) || 0));
  const color = p >= 80 ? '#059669' : p >= 40 ? '#6B3FDB' : '#d97706';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 120 }}>
      <div style={{ flex: 1, height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${p}%`, height: '100%', background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, color: '#6b7280', minWidth: 28 }}>{p}%</span>
    </div>
  );
}

const fmtDate = (v) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmtCr = (n) => (n && Number(n) > 0) ? `₹${(Number(n) / 1e5).toFixed(1)}L` : '—';

const TH = { padding: '9px 14px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#fafafa', zIndex: 1 };
const TD = { padding: '9px 14px', borderBottom: '1px solid #f9f9fb' };

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const SELECT = { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', fontSize: 13, color: '#374151', minWidth: 140 };
const LABEL = { fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, display: 'block' };

// ─── Clustered installation map (vanilla Leaflet + markercluster) ─────────────
function InstallationMap({ sites }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const clusterRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView([20.5937, 78.9629], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    const cluster = L.markerClusterGroup({ maxClusterRadius: 50, showCoverageOnHover: false });
    map.addLayer(cluster);
    mapRef.current = map;
    clusterRef.current = cluster;
    return () => { map.remove(); mapRef.current = null; clusterRef.current = null; };
  }, []);

  useEffect(() => {
    const cluster = clusterRef.current, map = mapRef.current;
    if (!cluster || !map) return;
    cluster.clearLayers();
    const bounds = [];
    sites.forEach((s) => {
      const count = s.projects.length;
      // Marker size + colour scale with the installation count at this site.
      const size  = count >= 5 ? 42 : count >= 3 ? 36 : count >= 2 ? 30 : 24;
      const color = count >= 5 ? '#dc2626' : count >= 3 ? '#ea580c' : count >= 2 ? '#6B3FDB' : '#8b5cf6';
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:${size}px;height:${size}px;background:${color};color:#fff;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:${size > 30 ? 13 : 11}px;font-weight:700">${count}</div>`,
        iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      });
      const m = L.marker([s.lat, s.lng], { icon });
      const list = s.projects
        .map((p) => `<div style="padding:2px 0">• ${p.project_name || '—'} <span style="color:#6b7280">(${p.project_type || '—'})</span></div>`)
        .join('');
      m.bindPopup(
        `<div style="min-width:190px">
           <div style="font-weight:700;margin-bottom:2px">${s.city || s.zone || 'Installation site'}</div>
           <div style="font-size:11px;color:#6b7280;margin-bottom:6px">${s.zone || ''}${s.zone ? ' · ' : ''}${count} installation${count > 1 ? 's' : ''}</div>
           ${list}
         </div>`,
      );
      cluster.addLayer(m);
      bounds.push([s.lat, s.lng]);
    });
    if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
  }, [sites]);

  return <div ref={containerRef} style={{ height: 420, width: '100%', borderRadius: 11, overflow: 'hidden' }} />;
}

// Current Indian financial years for the FY dropdown (start year is the value).
const FY_YEARS = (() => {
  const now = new Date();
  const startYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // Apr = month 3
  return Array.from({ length: 5 }, (_, i) => startYear - i);
})();

export default function InstallationDashboard() {
  const [data, setData]       = useState([]);
  const [options, setOptions] = useState({ customers: [], zones: [], project_types: [] });
  const [filters, setFilters] = useState({ customer: 'all', zone: 'all', project_type: 'all', fy: 'all' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const alive = useRef(true);

  const load = (f) => {
    alive.current = true;
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (f.customer && f.customer !== 'all') qs.set('customer', f.customer);
    if (f.zone && f.zone !== 'all') qs.set('zone', f.zone);
    if (f.project_type && f.project_type !== 'all') qs.set('project_type', f.project_type);
    if (f.fy && f.fy !== 'all') qs.set('fy', f.fy);
    const suffix = qs.toString() ? `?${qs}` : '';
    api.get(`/projects/installation-dashboard${suffix}`)
      .then(r => { if (alive.current) setData(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive.current) setError('Could not load installation data. Please try again.'); })
      .finally(() => { if (alive.current) setLoading(false); });
  };

  useEffect(() => {
    load(filters);
    api.get('/projects/installation-dashboard/filters')
      .then(r => { if (alive.current && r.data) setOptions(r.data); })
      .catch(() => {});
    return () => { alive.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = {
    total: data.length,
    active: data.filter(d => d.status === 'active').length,
    commissioned: data.filter(d => d.commissioning_status === 'completed').length,
    avgCompletion: data.length
      ? Math.round(data.reduce((s, d) => s + (Number(d.completion_percentage) || 0), 0) / data.length)
      : 0,
  };

  // ── Single source for BOTH charts: count of installations per zone (state) ──
  const zoneAgg = useMemo(() => {
    const m = new Map();
    data.forEach((d) => {
      const z = (d.zone && String(d.zone).trim()) || UNASSIGNED;
      m.set(z, (m.get(z) || 0) + 1);
    });
    return Array.from(m, ([zone, count]) => ({ zone, count })).sort((a, b) => b.count - a.count);
  }, [data]);

  // Pie = top 8 zones + an "Others" roll-up (derived from the same zoneAgg).
  const pieData = useMemo(() => {
    if (zoneAgg.length <= 9) return zoneAgg;
    const top = zoneAgg.slice(0, 8);
    const rest = zoneAgg.slice(8).reduce((s, z) => s + z.count, 0);
    return [...top, { zone: 'Others', count: rest }];
  }, [zoneAgg]);

  // Map sites: one marker per distinct lat/lng, carrying all projects at it.
  const sites = useMemo(() => {
    const m = new Map();
    data.forEach((d) => {
      const lat = Number(d.latitude), lng = Number(d.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return;
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      if (!m.has(key)) m.set(key, { lat, lng, city: d.site_city, zone: d.zone, projects: [] });
      m.get(key).projects.push(d);
    });
    return Array.from(m.values());
  }, [data]);

  const setF = (k, v) => setFilters(prev => ({ ...prev, [k]: v }));

  const exportXlsx = () => {
    const rowsOut = data.map(r => ({
      Project: r.project_name || '',
      Code: r.project_code || '',
      Type: r.project_type || '',
      Customer: r.customer_name || '',
      Zone: r.zone || '',
      City: r.site_city || '',
      Status: r.status || '',
      Commissioning: r.commissioning_status || '',
      'Commission Date': r.commissioning_date ? fmtDate(r.commissioning_date) : '',
      'Completion %': Number(r.completion_percentage) || 0,
      'Contract Value': Number(r.contract_value) || 0,
      Latitude: r.latitude ?? '',
      Longitude: r.longitude ?? '',
    }));
    const ws = XLSX.utils.json_to_sheet(rowsOut);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Installations');
    XLSX.writeFile(wb, `installations_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const hasData = !loading && !error && data.length > 0;

  return (
    <div style={{ padding: '16px 18px 20px', minHeight: '100vh', background: '#f8f9fb' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Hammer size={18} color="#6B3FDB" />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#111827' }}>Installation Dashboard</h1>
            <p style={{ margin: 0, fontSize: 12.5, color: '#6b7280' }}>Where Manifest&rsquo;s SST, HVDC, STATCOM &amp; EPC installations are deployed</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={exportXlsx}
            disabled={!hasData}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 8,
              background: '#fff', cursor: hasData ? 'pointer' : 'not-allowed', fontSize: 13,
              color: hasData ? '#374151' : '#c0c4cc',
            }}
          >
            <Download size={14} />
            Export
          </button>
          <button
            onClick={() => load(filters)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 8,
              background: '#fff', cursor: 'pointer', fontSize: 13, color: '#374151',
            }}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ ...CARD, padding: 14, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <div>
          <label style={LABEL}>Customer</label>
          <select style={SELECT} value={filters.customer} onChange={e => setF('customer', e.target.value)}>
            <option value="all">All customers</option>
            {options.customers.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label style={LABEL}>Zone (state)</label>
          <select style={SELECT} value={filters.zone} onChange={e => setF('zone', e.target.value)}>
            <option value="all">All zones</option>
            {options.zones.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        <div>
          <label style={LABEL}>Project type</label>
          <select style={SELECT} value={filters.project_type} onChange={e => setF('project_type', e.target.value)}>
            <option value="all">All types</option>
            {options.project_types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label style={LABEL}>Financial year</label>
          <select style={SELECT} value={filters.fy} onChange={e => setF('fy', e.target.value)}>
            <option value="all">All years</option>
            {FY_YEARS.map(y => <option key={y} value={y}>{`FY ${y}-${String(y + 1).slice(-2)}`}</option>)}
          </select>
        </div>
        <button
          onClick={() => load(filters)}
          className="pulse-btn-primary"
          style={{
            padding: '8px 18px', border: 'none', borderRadius: 8,
            background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}
        >
          Apply Filter
        </button>
      </div>

      {/* KPI cards */}
      {hasData && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
          {[
            { label: 'Total Projects',    value: summary.total,              icon: Hammer,        bg: '#f5f3ff', ic: '#6B3FDB' },
            { label: 'Active',            value: summary.active,             icon: Clock,         bg: '#fef3c7', ic: '#92400e' },
            { label: 'Commissioned',      value: summary.commissioned,       icon: CheckCircle,   bg: '#dcfce7', ic: '#059669' },
            { label: 'Avg. Completion',   value: `${summary.avgCompletion}%`,icon: AlertTriangle, bg: '#fff7ed', ic: '#f97316' },
          ].map(({ label, value, icon: Icon, bg, ic }, i) => (
            <div key={label} className="dk-anim" style={{
              background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11,
              padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 11, '--dk-i': i,
            }}>
              <div style={{ width: 32, height: 32, borderRadius: 9, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon size={16} color={ic} />
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>{value}</div>
                <div style={{ fontSize: 11.5, color: '#6b7280', marginTop: 1 }}>{label}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af', fontSize: 14 }}>Loading…</div>
      )}

      {/* Error */}
      {!loading && error && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 48, textAlign: 'center', border: '1px solid #fee2e2' }}>
          <AlertTriangle size={32} color="#dc2626" style={{ marginBottom: 10 }} />
          <p style={{ color: '#dc2626', margin: 0, fontWeight: 500 }}>{error}</p>
          <button
            onClick={() => load(filters)}
            style={{ marginTop: 14, padding: '7px 18px', borderRadius: 7, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13 }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && data.length === 0 && (
        <div style={{ background: '#fff', borderRadius: 12, padding: 60, textAlign: 'center', border: '1px solid #f0f0f4' }}>
          <Hammer size={36} color="#d1d5db" style={{ marginBottom: 12 }} />
          <p style={{ color: '#6b7280', margin: 0, fontSize: 14, fontWeight: 500 }}>No installations match these filters</p>
          <p style={{ color: '#9ca3af', margin: '4px 0 0', fontSize: 13 }}>
            Projects of type EPC, HVDC, STATCOM, SST or Commissioning will appear here once created.
          </p>
        </div>
      )}

      {/* Charts */}
      {hasData && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div className="dk-anim" style={{ ...CARD, '--dk-i': 4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 }}>Installations by zone</div>
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              <ResponsiveContainer width="100%" height={Math.max(200, zoneAgg.length * 34)}>
                <BarChart layout="vertical" data={zoneAgg} margin={{ top: 4, right: 34, bottom: 4, left: 4 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="zone" width={120} tick={{ fontSize: 12, fill: '#374151' }} />
                  <Tooltip cursor={{ fill: '#f5f3ff' }} />
                  <Bar dataKey="count" fill="#6B3FDB" radius={[0, 4, 4, 0]} barSize={18}>
                    <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: '#374151', fontWeight: 600 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="dk-anim" style={{ ...CARD, '--dk-i': 5 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 }}>Zone share</div>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={pieData} dataKey="count" nameKey="zone"
                  cx="50%" cy="50%" outerRadius={88}
                  label={({ name, value }) => `${name}: ${value}`}
                  labelLine
                >
                  {pieData.map((e, i) => <Cell key={e.zone} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Map */}
      {hasData && (
        <div className="dk-anim" style={{ ...CARD, padding: 0, marginBottom: 14, overflow: 'hidden', '--dk-i': 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '12px 16px', borderBottom: '1px solid #f0f0f4' }}>
            <MapPin size={15} color="#6B3FDB" />
            <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>Installation map</span>
            <span style={{ fontSize: 11.5, color: '#9ca3af', marginLeft: 4 }}>
              {sites.length} geo-located site{sites.length === 1 ? '' : 's'}
            </span>
          </div>
          {sites.length > 0 ? (
            <InstallationMap sites={sites} />
          ) : (
            <div style={{ height: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
              <MapPin size={28} style={{ marginBottom: 8 }} />
              <p style={{ margin: 0, fontSize: 13 }}>No geo-located installations yet</p>
              <p style={{ margin: '2px 0 0', fontSize: 12 }}>Add latitude/longitude to a project to plot it here.</p>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      {hasData && (
        <div className="dk-anim" style={{ background: '#fff', borderRadius: 11, border: '1px solid #f0f0f4', overflow: 'hidden', '--dk-i': 7 }}>
          <div style={{ overflowX: 'auto', maxHeight: 'calc(100vh - 245px)', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={TH}>Project</th>
                  <th style={TH}>Type</th>
                  <th style={TH}>Customer</th>
                  <th style={TH}>Zone</th>
                  <th style={TH}>Stage</th>
                  <th style={TH}>Status</th>
                  <th style={TH}>Commissioning</th>
                  <th style={TH}>Commission Date</th>
                  <th style={{ ...TH, textAlign: 'center' }}>FAT</th>
                  <th style={{ ...TH, textAlign: 'center' }}>SAT</th>
                  <th style={TH}>Completion</th>
                  <th style={TH}>Contract Value</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr key={row.id ?? i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={TD}>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{row.project_name || '—'}</div>
                      {row.project_code && (
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{row.project_code}</div>
                      )}
                    </td>
                    <td style={{ ...TD, color: '#6b7280' }}>{row.project_type || '—'}</td>
                    <td style={{ ...TD, color: '#374151' }}>{row.customer_name || '—'}</td>
                    <td style={{ ...TD, color: '#6b7280' }}>{row.zone || '—'}</td>
                    <td style={{ ...TD, color: '#6b7280', textTransform: 'capitalize' }}>
                      {row.lifecycle_stage || '—'}
                    </td>
                    <td style={TD}><Badge value={row.status} meta={STATUS_META} /></td>
                    <td style={TD}><Badge value={row.commissioning_status} meta={COMMISSION_META} /></td>
                    <td style={{ ...TD, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtDate(row.commissioning_date)}</td>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <span style={{ fontSize: 12, color: Number(row.fat_passed) > 0 ? '#059669' : '#9ca3af' }}>
                        {row.fat_passed ?? 0}/{row.fat_count ?? 0}
                      </span>
                    </td>
                    <td style={{ ...TD, textAlign: 'center' }}>
                      <span style={{ fontSize: 12, color: Number(row.sat_passed) > 0 ? '#059669' : '#9ca3af' }}>
                        {row.sat_passed ?? 0}/{row.sat_count ?? 0}
                      </span>
                    </td>
                    <td style={TD}><ProgressBar pct={row.completion_percentage} /></td>
                    <td style={{ ...TD, color: '#374151', whiteSpace: 'nowrap' }}>{fmtCr(row.contract_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
