import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Users, CheckCircle, XCircle, Clock, MapPin, Zap, RefreshCw,
  Activity, AlertCircle, Building, AlertTriangle,
} from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import api from '@/services/api/client';
import '@/components/dashboard/dashkit.css';

function parseGPS(loc) {
  if (!loc) return null;
  try {
    const parts = String(loc).split(',');
    if (parts.length >= 2) {
      const lat = parseFloat(parts[0]);
      const lng = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lng)) return [lat, lng];
    }
  } catch { /* ignore */ }
  return null;
}

function FieldMap({ engineers }) {
  const containerRef = useRef(null);
  const mapRef       = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }

    const pinned = engineers
      .map(e => { const c = parseGPS(e.check_in_location); return c ? { ...e, lat: c[0], lng: c[1] } : null; })
      .filter(Boolean);

    const center = pinned.length > 0 ? [pinned[0].lat, pinned[0].lng] : [20.5937, 78.9629];
    const zoom   = pinned.length > 0 ? 13 : 5;

    const map = L.map(containerRef.current).setView(center, zoom);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    const icon = L.divIcon({
      className: '',
      html: '<div style="width:18px;height:18px;background:#0369a1;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(3,105,161,0.55)"></div>',
      iconSize: [18, 18], iconAnchor: [9, 9],
    });

    pinned.forEach(e => {
      L.marker([e.lat, e.lng], { icon })
        .bindPopup(`<strong>${e.name}</strong><br/>${e.department || ''}<br/>In: ${String(e.check_in_time || '').slice(0, 5)}`)
        .addTo(map);
    });

    mapRef.current = map;
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [engineers]);

  return <div ref={containerRef} style={{ height: 235, borderRadius: 10, overflow: 'hidden', marginBottom: 12, border: '1px solid #e0f2fe' }} />;
}

const P = '#6B3FDB';
const LIGHT = '#f5f3ff';
const CARD = { background: '#fff', borderRadius: 11, border: '1px solid #f0f0f4', padding: 14 };

const StatCard = ({ icon: Icon, label, value, sub, color, bg, index = 0 }) => (
  <div className="dk-anim" style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 12, '--dk-i': index }}>
    <div style={{
      width: 42, height: 42, borderRadius: 11,
      background: bg || LIGHT,
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <Icon size={19} color={color || P} />
    </div>
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12.5, color: '#6b7280', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{sub}</div>}
    </div>
  </div>
);

const StatusBadge = ({ status }) => {
  const map = {
    present: { bg: '#dcfce7', color: '#166534', label: 'Present' },
    late:    { bg: '#fef3c7', color: '#92400e', label: 'Late' },
    absent:  { bg: '#fee2e2', color: '#991b1b', label: 'Absent' },
    wfh:     { bg: '#dbeafe', color: '#1e40af', label: 'WFH' },
    field:   { bg: '#e0f2fe', color: '#0369a1', label: 'Field' },
  };
  const s = map[status] || { bg: '#f3f4f6', color: '#6b7280', label: status };
  return (
    <span style={{
      background: s.bg, color: s.color, borderRadius: 6,
      padding: '2px 8px', fontSize: 11, fontWeight: 600,
    }}>
      {s.label}
    </span>
  );
};

export default function LiveWorkforceDashboard() {
  const [data, setData]               = useState(null);
  const [loading, setLoading]         = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [activeTab, setActiveTab]     = useState('overview');
  const [geoViolations, setGeoViolations] = useState(0);
  const intervalRef = useRef(null);
  const isMounted   = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [res, geoViolRes] = await Promise.all([
        api.get('/attendance/live-dashboard'),
        api.get(`/attendance/geo-violations?from_date=${today}&to_date=${today}`).catch(() => ({ data: { summary: { today_violations: 0 } } })),
      ]);
      if (isMounted.current) {
        setData(res.data);
        setGeoViolations(geoViolRes.data?.summary?.today_violations || 0);
        setLastRefresh(new Date());
        setLoading(false);
      }
    } catch {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 60000);
    return () => clearInterval(intervalRef.current);
  }, [load]);

  const presence = data?.presence || {};
  const totalEmployees = presence.total_employees || 0;
  const present        = presence.present || 0;
  const absent         = presence.absent  || 0;
  const late           = presence.late    || 0;
  const wfh            = presence.wfh     || 0;
  const field          = presence.field   || 0;
  const onOT           = presence.on_overtime || 0;
  const stillInside    = presence.still_inside || 0;
  const attendancePct  = totalEmployees > 0 ? Math.round((present / totalEmployees) * 100) : 0;

  const tabs = [
    { id: 'overview',  label: 'Overview' },
    { id: 'shifts',    label: 'Shift Occupancy' },
    { id: 'field',     label: 'Field Engineers' },
    { id: 'punches',   label: 'Live Punches' },
  ];

  return (
    <div style={{ padding: '16px 18px 20px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>
            Live Workforce Dashboard
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981', animation: 'pulse 2s infinite' }} />
            <span style={{ fontSize: 13, color: '#6b7280' }}>
              {lastRefresh
                ? `Last updated ${lastRefresh.toLocaleTimeString('en-IN')} · Auto-refreshes every 60s`
                : 'Connecting…'}
            </span>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px', borderRadius: 8, border: `1px solid ${P}`,
            background: 'transparent', color: P, cursor: 'pointer', fontSize: 13,
          }}
        >
          <RefreshCw size={14} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          Refresh
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80, color: '#9ca3af' }}>Loading live data…</div>
      ) : (
        <>
          {/* KPI Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 10, marginBottom: 12 }}>
            <StatCard index={0} icon={Users}         label="Total Employees" value={totalEmployees} color="#6B3FDB" bg="#f5f3ff" />
            <StatCard index={1} icon={CheckCircle}   label="Present Today"   value={present}  sub={`${attendancePct}% attendance`} color="#10b981" bg="#dcfce7" />
            <StatCard index={2} icon={XCircle}       label="Absent Today"    value={absent}   color="#ef4444" bg="#fee2e2" />
            <StatCard index={3} icon={Clock}         label="Late Arrivals"   value={late}     color="#f59e0b" bg="#fef3c7" />
            <StatCard index={4} icon={MapPin}        label="WFH"             value={wfh}      color="#3b82f6" bg="#dbeafe" />
            <StatCard index={5} icon={Activity}      label="Field Engineers" value={field}    color="#0369a1" bg="#e0f2fe" />
            <StatCard index={6} icon={Zap}           label="On Overtime"     value={onOT}     color="#8b5cf6" bg="#ede9fe" />
            <StatCard index={7} icon={Building}      label="Still Inside"    value={stillInside} sub="not yet punched out" color="#059669" bg="#ecfdf5" />
            <StatCard index={8} icon={AlertTriangle} label="Geo Violations"  value={geoViolations} sub="today" color="#d97706" bg="#fef3c7" />
          </div>

          {/* Attendance gauge */}
          <div className="dk-anim" style={{ ...CARD, marginBottom: 12, '--dk-i': 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontWeight: 600, color: '#111827', fontSize: 14 }}>Overall Attendance Rate</span>
              <span style={{ fontSize: 21, fontWeight: 700, color: attendancePct >= 90 ? '#10b981' : attendancePct >= 70 ? '#f59e0b' : '#ef4444' }}>
                {attendancePct}%
              </span>
            </div>
            <div style={{ height: 12, background: '#f3f4f6', borderRadius: 99 }}>
              <div style={{
                height: '100%', borderRadius: 99,
                width: `${attendancePct}%`,
                background: attendancePct >= 90 ? '#10b981' : attendancePct >= 70 ? '#f59e0b' : '#ef4444',
                transition: 'width 0.8s ease',
              }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, color: '#9ca3af' }}>
              <span>0%</span>
              <span style={{ color: '#6b7280' }}>Target: 90%</span>
              <span>100%</span>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid #f0f0f4', paddingBottom: 0 }}>
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                style={{
                  padding: '8px 18px', border: 'none', cursor: 'pointer',
                  background: 'transparent', fontSize: 14, fontWeight: 500,
                  color: activeTab === t.id ? P : '#6b7280',
                  borderBottom: activeTab === t.id ? `2px solid ${P}` : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Tab: Overview — department breakdown */}
          {activeTab === 'overview' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {/* Presence summary */}
              <div style={CARD}>
                <div style={{ fontWeight: 600, color: '#111827', marginBottom: 10, fontSize: 13.5 }}>Presence Breakdown</div>
                {[
                  { label: 'Present',        value: present,     pct: totalEmployees > 0 ? Math.round(present/totalEmployees*100) : 0, color: '#10b981' },
                  { label: 'Absent',         value: absent,      pct: totalEmployees > 0 ? Math.round(absent/totalEmployees*100)  : 0, color: '#ef4444' },
                  { label: 'Late',           value: late,        pct: totalEmployees > 0 ? Math.round(late/totalEmployees*100)    : 0, color: '#f59e0b' },
                  { label: 'Work From Home', value: wfh,         pct: totalEmployees > 0 ? Math.round(wfh/totalEmployees*100)     : 0, color: '#3b82f6' },
                  { label: 'Field',          value: field,       pct: totalEmployees > 0 ? Math.round(field/totalEmployees*100)   : 0, color: '#0369a1' },
                  { label: 'Overtime',       value: onOT,        pct: totalEmployees > 0 ? Math.round(onOT/totalEmployees*100)    : 0, color: '#8b5cf6' },
                ].map(item => (
                  <div key={item.label} style={{ marginBottom: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                      <span style={{ color: '#374151' }}>{item.label}</span>
                      <span style={{ fontWeight: 600, color: '#111827' }}>{item.value} <span style={{ color: '#9ca3af', fontWeight: 400 }}>({item.pct}%)</span></span>
                    </div>
                    <div style={{ height: 6, background: '#f3f4f6', borderRadius: 99 }}>
                      <div style={{ height: '100%', borderRadius: 99, width: `${item.pct}%`, background: item.color }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Today's alerts */}
              <div style={CARD}>
                <div style={{ fontWeight: 600, color: '#111827', marginBottom: 10, fontSize: 13.5 }}>Today's Alerts</div>

                {/* No data yet — nobody has clocked in and system has employees */}
                {totalEmployees > 0 && present === 0 && absent === 0 && late === 0 && (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 12, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0', marginBottom: 10 }}>
                    <Clock size={16} color="#94a3b8" />
                    <span style={{ fontSize: 13, color: '#64748b' }}>No attendance recorded yet for today</span>
                  </div>
                )}

                {totalEmployees === 0 && (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 12, background: '#fff7f0', borderRadius: 8, border: '1px solid #fed7aa', marginBottom: 10 }}>
                    <AlertCircle size={16} color="#f97316" />
                    <span style={{ fontSize: 13, color: '#9a3412' }}>No active employees found — ensure employees are assigned to this company in HR settings</span>
                  </div>
                )}

                {totalEmployees > 0 && absent > totalEmployees * 0.2 && (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, background: '#fff1f2', borderRadius: 8, marginBottom: 10, border: '1px solid #fecdd3' }}>
                    <AlertCircle size={16} color="#ef4444" style={{ marginTop: 1, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: '#991b1b' }}>
                      High absenteeism — {Math.round(absent/totalEmployees*100)}% absent today
                    </span>
                  </div>
                )}
                {late > 10 && (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, background: '#fffbeb', borderRadius: 8, marginBottom: 10, border: '1px solid #fde68a' }}>
                    <Clock size={16} color="#f59e0b" style={{ marginTop: 1, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: '#92400e' }}>
                      {late} late arrivals recorded today
                    </span>
                  </div>
                )}
                {onOT > 0 && (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, background: '#f5f3ff', borderRadius: 8, marginBottom: 10, border: '1px solid #e9e4ff' }}>
                    <Zap size={16} color="#6B3FDB" style={{ marginTop: 1, flexShrink: 0 }} />
                    <span style={{ fontSize: 13, color: '#5b21b6' }}>
                      {onOT} employees working overtime
                    </span>
                  </div>
                )}
                {/* Full workforce present: ONLY when every active employee has checked in */}
                {totalEmployees > 0 && present === totalEmployees && late === 0 && (
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 12, background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0' }}>
                    <CheckCircle size={16} color="#10b981" />
                    <span style={{ fontSize: 13, color: '#166534' }}>Full workforce present with no late arrivals</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tab: Shift Occupancy */}
          {activeTab === 'shifts' && (
            <div style={CARD}>
              <div style={{ fontWeight: 600, color: '#111827', marginBottom: 10, fontSize: 13.5 }}>Shift Occupancy — Today</div>
              {(data?.shift_occupancy || []).length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No shift data available</div>
              ) : (
                <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr>
                      {['Shift', 'Time', 'Capacity', 'Present', 'Absent', 'Utilization'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 12, position: 'sticky', top: 0, background: '#fff', borderBottom: '1px solid #f0f0f4', zIndex: 1 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.shift_occupancy || []).map((s, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 500, color: '#111827' }}>{s.shift_name}</td>
                        <td style={{ padding: '10px 12px', color: '#6b7280' }}>
                          {String(s.start_time || '').slice(0, 5)} – {String(s.end_time || '').slice(0, 5)}
                        </td>
                        <td style={{ padding: '10px 12px' }}>{s.capacity}</td>
                        <td style={{ padding: '10px 12px', color: '#10b981', fontWeight: 600 }}>{s.present}</td>
                        <td style={{ padding: '10px 12px', color: '#ef4444' }}>{s.absent}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ flex: 1, height: 6, background: '#f3f4f6', borderRadius: 99 }}>
                              <div style={{
                                height: '100%', borderRadius: 99, width: `${s.utilization || 0}%`,
                                background: (s.utilization || 0) >= 80 ? '#10b981' : (s.utilization || 0) >= 60 ? '#f59e0b' : '#ef4444',
                              }} />
                            </div>
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', minWidth: 36 }}>{s.utilization || 0}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          )}

          {/* Tab: Field Engineers */}
          {activeTab === 'field' && (
            <div style={CARD}>
              <div style={{ fontWeight: 600, color: '#111827', marginBottom: 16 }}>
                Field Engineers — Active Today ({(data?.field_engineers || []).length})
              </div>
              {(data?.field_engineers || []).length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No field engineers active today</div>
              ) : (
                <>
                  <FieldMap engineers={data.field_engineers} />
                  {(() => {
                    const noGps = data.field_engineers.filter(f => !parseGPS(f.check_in_location)).length;
                    return noGps > 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#92400e', background: '#fffbeb', borderRadius: 6, padding: '6px 10px', marginBottom: 12 }}>
                        <AlertCircle size={13} color="#d97706" />
                        {noGps} engineer{noGps > 1 ? 's' : ''} checked in without GPS — not shown on map
                      </div>
                    ) : null;
                  })()}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10, maxHeight: '34vh', overflowY: 'auto', alignContent: 'start' }}>
                    {(data?.field_engineers || []).map((f, i) => {
                      const hasGps = !!parseGPS(f.check_in_location);
                      return (
                        <div key={i} style={{ border: `1px solid ${hasGps ? '#e0f2fe' : '#fde68a'}`, borderRadius: 10, padding: 11, background: hasGps ? '#f0f9ff' : '#fffbeb', alignSelf: 'start' }}>
                          <div style={{ fontWeight: 600, color: '#111827', marginBottom: 4 }}>{f.name}</div>
                          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>{f.department} · {f.designation}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: hasGps ? '#0369a1' : '#d97706' }}>
                            <MapPin size={12} />
                            {hasGps
                              ? `${String(f.check_in_location).slice(0, 26)}…`
                              : 'Location not captured'}
                          </div>
                          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                            Checked in: {String(f.check_in_time || '').slice(0, 5)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Tab: Live Punches */}
          {activeTab === 'punches' && (
            <div style={CARD}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
                <span style={{ fontWeight: 600, color: '#111827', fontSize: 13.5 }}>Recent Punches — Today</span>
              </div>
              {(data?.latest_punches || []).length === 0 ? (
                <div style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No punch records today</div>
              ) : (
                <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr>
                      {['Employee', 'Department', 'Status', 'Check In', 'Check Out', 'Mode'].map(h => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 500, fontSize: 12, position: 'sticky', top: 0, background: '#fff', borderBottom: '1px solid #f0f0f4', zIndex: 1 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.latest_punches || []).map((p, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f9fafb' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 500, color: '#111827' }}>{p.name}</td>
                        <td style={{ padding: '10px 12px', color: '#6b7280' }}>{p.department}</td>
                        <td style={{ padding: '10px 12px' }}><StatusBadge status={p.status} /></td>
                        <td style={{ padding: '10px 12px', color: '#374151' }}>{String(p.check_in_time || '').slice(0, 5) || '—'}</td>
                        <td style={{ padding: '10px 12px', color: '#374151' }}>{String(p.check_out_time || '').slice(0, 5) || '—'}</td>
                        <td style={{ padding: '10px 12px' }}>
                          <StatusBadge status={p.work_mode || 'office'} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes spin  { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
