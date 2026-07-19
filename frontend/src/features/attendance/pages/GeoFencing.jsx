import { useState, useEffect, useCallback, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  MapPin, Plus, Edit2, Trash2, X, Check, AlertCircle,
  Radio, Navigation, Building, Briefcase, Wrench, Search, Crosshair,
  TestTube, Filter,
} from 'lucide-react';
import api from '@/services/api/client';
import { getPosition } from '@/mobile/native';

const P = '#6B3FDB';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24 };

const RULE_TYPES = [
  { id: 'office',   label: 'Office / Branch', icon: Building,   color: '#6B3FDB', desc: 'Standard office geo-fence for regular employees' },
  { id: 'factory',  label: 'Factory / Plant', icon: Wrench,     color: '#ef4444', desc: 'Manufacturing plant with strict geo-fencing' },
  { id: 'field',    label: 'Field Engineer',  icon: Navigation, color: '#10b981', desc: 'Flexible geo-fence for field staff' },
  { id: 'customer', label: 'Customer Site',   icon: Briefcase,  color: '#f59e0b', desc: 'Client premises for project work' },
];

const RADIUS_PRESETS = [
  { label: '50m', value: 50 }, { label: '100m', value: 100 },
  { label: '200m', value: 200 }, { label: '500m', value: 500 },
  { label: '1km', value: 1000 }, { label: '5km', value: 5000 },
  { label: '10km', value: 10000 },
];

const EMPTY_RULE = {
  name: '', location_name: '', lat: null, lng: null,
  radius_meters: 200, rule_type: 'office', is_mandatory: false, is_active: true,
  applicable_to: 'all', applicable_department: '',
};

// Haversine distance in metres — used by Test Location feature
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Leaflet map component ────────────────────────────────────────────────────
function GeoMap({ lat, lng, radius, onLocationSelect }) {
  const containerRef = useRef(null);
  const inst = useRef({ map: null, marker: null, circle: null, currentRadius: 200, icon: null });
  const callbackRef = useRef(onLocationSelect);

  useEffect(() => { callbackRef.current = onLocationSelect; });

  useEffect(() => {
    if (!containerRef.current) return;

    const mapIcon = L.divIcon({
      className: '',
      html: `<div style="width:22px;height:22px;background:#6B3FDB;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 10px rgba(107,63,219,0.55)"></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });

    inst.current.icon = mapIcon;

    const initLat = lat || 20.5937;
    const initLng = lng || 78.9629;
    const initZoom = lat && lng ? 15 : 5;

    const map = L.map(containerRef.current, { zoomControl: true }).setView([initLat, initLng], initZoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    inst.current.map = map;
    inst.current.currentRadius = radius || 200;

    if (lat && lng) {
      const m = L.marker([lat, lng], { icon: mapIcon, draggable: true }).addTo(map);
      m.on('dragend', e => {
        const p = e.target.getLatLng();
        const dLat = parseFloat(p.lat.toFixed(7));
        const dLng = parseFloat(p.lng.toFixed(7));
        if (inst.current.circle) inst.current.circle.setLatLng([dLat, dLng]);
        callbackRef.current(dLat, dLng);
      });
      inst.current.marker = m;
      const c = L.circle([lat, lng], { radius: radius || 200, color: P, fillColor: P, fillOpacity: 0.13, weight: 2 }).addTo(map);
      inst.current.circle = c;
    }

    map.on('click', e => {
      const cLat = parseFloat(e.latlng.lat.toFixed(7));
      const cLng = parseFloat(e.latlng.lng.toFixed(7));

      if (inst.current.marker) {
        inst.current.marker.setLatLng([cLat, cLng]);
        if (inst.current.circle) inst.current.circle.setLatLng([cLat, cLng]);
      } else {
        const m = L.marker([cLat, cLng], { icon: inst.current.icon, draggable: true }).addTo(map);
        m.on('dragend', ev => {
          const p = ev.target.getLatLng();
          const dLat = parseFloat(p.lat.toFixed(7));
          const dLng = parseFloat(p.lng.toFixed(7));
          if (inst.current.circle) inst.current.circle.setLatLng([dLat, dLng]);
          callbackRef.current(dLat, dLng);
        });
        inst.current.marker = m;
        const c = L.circle([cLat, cLng], { radius: inst.current.currentRadius || 200, color: P, fillColor: P, fillOpacity: 0.13, weight: 2 }).addTo(map);
        inst.current.circle = c;
      }

      callbackRef.current(cLat, cLng);
    });

    return () => {
      map.remove();
      inst.current = { map: null, marker: null, circle: null, currentRadius: 200, icon: null };
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!inst.current.map || lat == null || lng == null) return;
    const { map, icon } = inst.current;

    const ensureMarker = () => {
      if (inst.current.marker) {
        inst.current.marker.setLatLng([lat, lng]);
        if (inst.current.circle) inst.current.circle.setLatLng([lat, lng]);
      } else {
        const m = L.marker([lat, lng], { icon, draggable: true }).addTo(map);
        m.on('dragend', ev => {
          const p = ev.target.getLatLng();
          const dLat = parseFloat(p.lat.toFixed(7));
          const dLng = parseFloat(p.lng.toFixed(7));
          if (inst.current.circle) inst.current.circle.setLatLng([dLat, dLng]);
          callbackRef.current(dLat, dLng);
        });
        inst.current.marker = m;
        const c = L.circle([lat, lng], { radius: inst.current.currentRadius || 200, color: P, fillColor: P, fillOpacity: 0.13, weight: 2 }).addTo(map);
        inst.current.circle = c;
      }
    };

    ensureMarker();

    const bounds = map.getBounds();
    if (!bounds || !bounds.contains([lat, lng])) {
      map.setView([lat, lng], Math.max(map.getZoom(), 14));
    }
  }, [lat, lng]);

  useEffect(() => {
    inst.current.currentRadius = radius || 200;
    if (inst.current.circle) inst.current.circle.setRadius(radius || 200);
  }, [radius]);

  return (
    <div style={{ position: 'relative' }}>
      <div ref={containerRef} style={{ height: 300, width: '100%', borderRadius: 10, overflow: 'hidden' }} />
      {!lat && !lng && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', pointerEvents: 'none', zIndex: 500,
        }}>
          <div style={{
            background: 'rgba(255,255,255,0.93)', borderRadius: 10, padding: '10px 18px',
            fontSize: 13, color: '#6b7280', border: '1px dashed #d1d5db',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          }}>
            <MapPin size={13} style={{ verticalAlign: 'middle', marginRight: 6, color: P }} />
            Click anywhere on the map to place the geo-fence center
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Location search (Nominatim) ──────────────────────────────────────────────
function LocationSearch({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);

  const doSearch = useCallback(async (q) => {
    if (!q.trim() || q.trim().length < 3) { setResults([]); setOpen(false); return; }
    setSearching(true);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=6&accept-language=en`,
        { headers: { 'Accept-Language': 'en' } }
      );
      const data = await res.json();
      setResults(data);
      setOpen(data.length > 0);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 500);
  };

  const handleSelect = (item) => {
    const name = item.display_name.split(',')[0].trim();
    onSelect({ lat: parseFloat(item.lat), lng: parseFloat(item.lon), name });
    setQuery(item.display_name.split(',').slice(0, 2).join(', ').trim());
    setResults([]);
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', pointerEvents: 'none' }} />
        {searching && (
          <div style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, border: '2px solid #e9e4ff', borderTopColor: P, borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
        )}
        <input
          value={query}
          onChange={handleChange}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder="Search: factory name, address, city, place…"
          style={{ width: '100%', paddingLeft: 32, paddingRight: 34, paddingTop: 9, paddingBottom: 9, border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
        />
      </div>
      {open && results.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 2000,
          background: '#fff', borderRadius: 8, border: '1px solid #e9e4ff',
          boxShadow: '0 8px 24px rgba(0,0,0,0.12)', overflow: 'hidden', marginTop: 4,
        }}>
          {results.map((r, i) => (
            <button
              key={i}
              onMouseDown={() => handleSelect(r)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, width: '100%',
                padding: '9px 12px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
                borderBottom: i < results.length - 1 ? '1px solid #f5f3ff' : 'none',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5f3ff'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              <MapPin size={13} color={P} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: '#1f2937', lineHeight: 1.3 }}>
                  {r.display_name.split(',')[0]}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1, lineHeight: 1.3 }}>
                  {r.display_name.split(',').slice(1, 3).join(',')}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add / Edit form ──────────────────────────────────────────────────────────
function GeoRuleForm({ rule, onSave, onClose }) {
  const [form, setForm] = useState(() => rule
    ? {
        ...rule,
        lat: rule.lat ? parseFloat(rule.lat) : null,
        lng: rule.lng ? parseFloat(rule.lng) : null,
        applicable_to: rule.applicable_to || 'all',
        applicable_department: rule.applicable_department || '',
      }
    : { ...EMPTY_RULE }
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [locating, setLocating] = useState(false);
  const mapKey = useRef(`map-${Date.now()}`);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleMapClick = useCallback((lat, lng) => {
    setForm(f => ({ ...f, lat, lng }));
  }, []);

  const handleSearchSelect = useCallback(({ lat, lng, name }) => {
    setForm(f => ({ ...f, lat, lng, name: f.name || name }));
  }, []);

  const handleCurrentLocation = async () => {
    setLocating(true);
    setErr('');
    try {
      const { latitude, longitude } = await getPosition({ highAccuracy: true, timeout: 12000 });
      setForm(f => ({ ...f, lat: parseFloat(latitude.toFixed(7)), lng: parseFloat(longitude.toFixed(7)) }));
    } catch (geoErr) {
      const msgs = { 1: 'Location permission denied.', 2: 'Location unavailable.', 3: 'Location timed out.' };
      setErr(msgs[geoErr?.code] || 'Failed to get location. Please try again.');
    } finally {
      setLocating(false);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setErr('Zone name is required'); return; }
    if (form.lat == null || form.lng == null) { setErr('Please select a location on the map'); return; }
    if (form.applicable_to === 'department' && !form.applicable_department.trim()) {
      setErr('Please enter a department name'); return;
    }
    setSaving(true); setErr('');
    try {
      const payload = {
        name: form.name.trim(),
        location_name: form.location_name?.trim() || null,
        lat: parseFloat(form.lat),
        lng: parseFloat(form.lng),
        radius_meters: form.radius_meters || 200,
        rule_type: form.rule_type || 'office',
        is_mandatory: Boolean(form.is_mandatory),
        is_active: form.is_active !== false,
        applicable_to: form.applicable_to || 'all',
        applicable_department: form.applicable_to === 'department' ? form.applicable_department.trim() : null,
      };
      const res = form.id
        ? await api.put(`/attendance/geo-rules/${form.id}`, payload)
        : await api.post('/attendance/geo-rules', payload);
      onSave(res.data);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const inp = {
    border: '1px solid #e9e4ff', borderRadius: 8, padding: '9px 12px',
    fontSize: 14, width: '100%', outline: 'none', boxSizing: 'border-box',
  };

  const canSave = form.lat != null && form.lng != null && form.name.trim();

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 660, maxHeight: '95vh', overflow: 'auto', padding: 28 }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 22 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{form.id ? 'Edit Geo Zone' : 'Add Geo Zone'}</h2>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: '#9ca3af' }}>Search or click the map to set the geo-fence center</p>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 8, cursor: 'pointer', flexShrink: 0 }}>
            <X size={16} />
          </button>
        </div>

        {err && (
          <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#dc2626', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertCircle size={14} style={{ flexShrink: 0 }} />{err}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* Zone name */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>ZONE NAME *</label>
            <input style={inp} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Head Office, Plant A, Site Chennai" />
          </div>

          {/* Zone type */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>ZONE TYPE</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {RULE_TYPES.map(rt => (
                <button
                  key={rt.id}
                  onClick={() => set('rule_type', rt.id)}
                  style={{
                    padding: '10px 8px', borderRadius: 8, textAlign: 'left', cursor: 'pointer',
                    border: `2px solid ${form.rule_type === rt.id ? rt.color : '#e9e4ff'}`,
                    background: form.rule_type === rt.id ? `${rt.color}12` : '#fff',
                  }}
                >
                  <rt.icon size={15} color={rt.color} style={{ marginBottom: 5, display: 'block' }} />
                  <div style={{ fontSize: 11, fontWeight: 600, color: form.rule_type === rt.id ? rt.color : '#374151', lineHeight: 1.3 }}>{rt.label}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Location search + current location */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>FIND LOCATION</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <LocationSearch onSelect={handleSearchSelect} />
              </div>
              <button
                onClick={handleCurrentLocation}
                disabled={locating}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8,
                  border: '1px solid #e9e4ff', background: locating ? '#f5f3ff' : '#fff',
                  cursor: locating ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600,
                  color: P, whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                <Crosshair size={13} />
                {locating ? 'Locating…' : 'My Location'}
              </button>
            </div>
          </div>

          {/* Map */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>MAP — CLICK TO SET CENTER</label>
              {form.lat && form.lng && (
                <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>
                  {form.lat.toFixed(5)}, {form.lng.toFixed(5)}
                </span>
              )}
            </div>
            <GeoMap
              key={mapKey.current}
              lat={form.lat}
              lng={form.lng}
              radius={form.radius_meters}
              onLocationSelect={handleMapClick}
            />
          </div>

          {/* Radius */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>ATTENDANCE RADIUS</label>
              <span style={{ fontSize: 14, fontWeight: 700, color: P }}>
                {form.radius_meters >= 1000 ? `${(form.radius_meters / 1000).toFixed(1)} km` : `${form.radius_meters} m`}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {RADIUS_PRESETS.map(p => (
                <button
                  key={p.value}
                  onClick={() => set('radius_meters', p.value)}
                  style={{
                    padding: '4px 11px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${form.radius_meters === p.value ? P : '#e9e4ff'}`,
                    background: form.radius_meters === p.value ? '#f5f3ff' : '#fff',
                    color: form.radius_meters === p.value ? P : '#6b7280',
                    fontWeight: form.radius_meters === p.value ? 700 : 400,
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              type="range" min={50} max={10000} step={50}
              value={form.radius_meters}
              onChange={e => set('radius_meters', parseInt(e.target.value))}
              style={{ width: '100%', accentColor: P }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
              <span>50m (strict)</span><span>500m (office)</span><span>10km (field)</span>
            </div>
          </div>

          {/* Site / branch tag */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 4 }}>SITE / BRANCH TAG</label>
            <input style={inp} value={form.location_name || ''} onChange={e => set('location_name', e.target.value)} placeholder="e.g. Chennai HQ, Plant A, Warehouse North" />
          </div>

          {/* Applicable To */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', display: 'block', marginBottom: 6 }}>APPLICABLE TO</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: form.applicable_to === 'department' ? 10 : 0 }}>
              {[
                { id: 'all', label: 'All Employees', desc: 'Zone applies to every employee in the company' },
                { id: 'department', label: 'Specific Department', desc: 'Zone applies only to one department' },
              ].map(opt => (
                <button
                  key={opt.id}
                  onClick={() => { set('applicable_to', opt.id); if (opt.id !== 'department') set('applicable_department', ''); }}
                  title={opt.desc}
                  style={{
                    flex: 1, padding: '9px 12px', borderRadius: 8, textAlign: 'left', cursor: 'pointer',
                    border: `2px solid ${form.applicable_to === opt.id ? P : '#e9e4ff'}`,
                    background: form.applicable_to === opt.id ? '#f5f3ff' : '#fff',
                    fontSize: 13, fontWeight: form.applicable_to === opt.id ? 700 : 500,
                    color: form.applicable_to === opt.id ? P : '#374151',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {form.applicable_to === 'department' && (
              <input
                style={{ ...inp, marginTop: 4 }}
                value={form.applicable_department}
                onChange={e => set('applicable_department', e.target.value)}
                placeholder="e.g. Engineering, Sales, Operations"
              />
            )}
          </div>

          {/* Toggles */}
          <div style={{ display: 'flex', gap: 24, padding: '12px 16px', background: '#f9fafb', borderRadius: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={form.is_active !== false} onChange={e => set('is_active', e.target.checked)} style={{ accentColor: P, width: 15, height: 15 }} />
              <span style={{ fontWeight: 500 }}>Zone Active</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={Boolean(form.is_mandatory)} onChange={e => set('is_mandatory', e.target.checked)} style={{ accentColor: P, width: 15, height: 15 }} />
              <span style={{ fontWeight: 500 }}>Block Punch Outside Radius</span>
            </label>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '10px 22px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 14, cursor: 'pointer' }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !canSave}
            title={!canSave ? 'Select a map location first' : ''}
            style={{
              padding: '10px 22px', borderRadius: 8, border: 'none',
              background: canSave ? P : '#d1d5db', color: '#fff',
              fontSize: 14, fontWeight: 600,
              cursor: (saving || !canSave) ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.75 : 1,
            }}
          >
            {saving ? 'Saving…' : form.id ? 'Update Zone' : 'Add Zone'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Test Location modal ───────────────────────────────────────────────────────
function TestLocationModal({ rule, onClose }) {
  const [status, setStatus] = useState('idle'); // idle | acquiring | result | error
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState('');

  const runTest = async () => {
    setStatus('acquiring');
    try {
      const p = await getPosition({ highAccuracy: true, timeout: 12000 });
      const empLat = p.latitude, empLng = p.longitude;
      const dist   = haversineM(empLat, empLng, parseFloat(rule.lat), parseFloat(rule.lng));
      const inside = dist <= parseFloat(rule.radius_meters);
      setResult({
        dist: Math.round(dist),
        radius: parseFloat(rule.radius_meters),
        inside,
        accuracy: Math.round(p.accuracy),
        empLat: empLat.toFixed(5),
        empLng: empLng.toFixed(5),
      });
      setStatus('result');
    } catch (geoErr) {
      const msgs = { 1: 'Location permission denied. Please allow location access and retry.', 2: 'Location unavailable. Try again in a few seconds.', 3: 'Location request timed out.' };
      setErrMsg(msgs[geoErr?.code] || 'Failed to get your location.');
      setStatus('error');
    }
  };

  const rt = RULE_TYPES.find(r => r.id === rule.rule_type) || RULE_TYPES[0];

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 420, padding: 28 }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Test My Location</h3>
            <p style={{ margin: '3px 0 0', fontSize: 12, color: '#9ca3af' }}>{rule.name}</p>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: '#f5f3ff', borderRadius: 8, padding: 8, cursor: 'pointer' }}>
            <X size={15} />
          </button>
        </div>

        {/* Zone info */}
        <div style={{ background: `${rt.color}08`, border: `1px solid ${rt.color}30`, borderRadius: 10, padding: '12px 14px', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <rt.icon size={13} color={rt.color} />
            <span style={{ fontSize: 12, fontWeight: 600, color: rt.color }}>{rt.label}</span>
          </div>
          <div style={{ fontSize: 12, color: '#374151' }}>
            Center: <span style={{ fontFamily: 'monospace' }}>{parseFloat(rule.lat).toFixed(5)}, {parseFloat(rule.lng).toFixed(5)}</span>
          </div>
          <div style={{ fontSize: 12, color: '#374151', marginTop: 2 }}>
            Radius: <strong>{rule.radius_meters >= 1000 ? `${(rule.radius_meters / 1000).toFixed(1)} km` : `${rule.radius_meters} m`}</strong>
            {rule.is_mandatory && <span style={{ marginLeft: 8, background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 600 }}>Mandatory</span>}
          </div>
        </div>

        {/* Idle */}
        {status === 'idle' && (
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
              Click below to capture your current GPS location and check if you are inside this zone.
            </p>
            <button
              onClick={runTest}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '11px 24px', borderRadius: 10, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
            >
              <Crosshair size={15} /> Capture My Location
            </button>
          </div>
        )}

        {/* Acquiring */}
        {status === 'acquiring' && (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ width: 36, height: 36, border: '3px solid #e9e4ff', borderTopColor: P, borderRadius: '50%', margin: '0 auto 12px', animation: 'spin 0.7s linear infinite' }} />
            <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>Acquiring GPS coordinates…</p>
          </div>
        )}

        {/* Result */}
        {status === 'result' && result && (
          <div>
            <div style={{
              background: result.inside ? '#f0fdf4' : '#fef2f2',
              border: `2px solid ${result.inside ? '#86efac' : '#fca5a5'}`,
              borderRadius: 12, padding: '16px 18px', marginBottom: 16, textAlign: 'center',
            }}>
              <div style={{ fontSize: 32, marginBottom: 6 }}>{result.inside ? '✅' : '❌'}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: result.inside ? '#15803d' : '#dc2626', marginBottom: 4 }}>
                {result.inside ? 'Inside Zone' : 'Outside Zone'}
              </div>
              <div style={{ fontSize: 13, color: result.inside ? '#166534' : '#991b1b' }}>
                {result.inside
                  ? `You are ${result.dist}m from the center — within the ${result.radius}m radius.`
                  : `You are ${result.dist}m from the center — ${result.dist - result.radius}m beyond the ${result.radius}m radius.`
                }
              </div>
            </div>
            <div style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#6b7280' }}>
              <div>Your location: <span style={{ fontFamily: 'monospace', color: '#374151' }}>{result.empLat}, {result.empLng}</span></div>
              <div style={{ marginTop: 3 }}>GPS accuracy: ±{result.accuracy}m</div>
            </div>
            <button
              onClick={runTest}
              style={{ marginTop: 12, width: '100%', padding: '9px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 13, cursor: 'pointer', color: P, fontWeight: 600 }}
            >
              Test Again
            </button>
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 10, padding: '14px 16px', marginBottom: 14, color: '#dc2626', fontSize: 13 }}>
              <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />{errMsg}
            </div>
            <button
              onClick={runTest}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 20px', borderRadius: 8, border: '1px solid #e9e4ff', background: '#fff', fontSize: 13, cursor: 'pointer', color: P, fontWeight: 600 }}
            >
              <Crosshair size={13} /> Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Zone card visualization ──────────────────────────────────────────────────
function GeoCircleViz({ rule }) {
  const rt = RULE_TYPES.find(r => r.id === rule.rule_type) || RULE_TYPES[0];
  const pct = Math.min(100, (rule.radius_meters / 10000) * 100);
  const size = 80 + pct * 0.6;
  return (
    <div style={{ position: 'relative', width: 110, height: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <div style={{ position: 'absolute', width: size, height: size, borderRadius: '50%', background: `${rt.color}10`, border: `2px dashed ${rt.color}40` }} />
      <div style={{ position: 'absolute', width: 34, height: 34, borderRadius: '50%', background: `${rt.color}22`, border: `2px solid ${rt.color}` }} />
      <MapPin size={17} color={rt.color} style={{ position: 'relative', zIndex: 1 }} />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function GeoFencing() {
  const [rules, setRules]           = useState([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [editRule, setEditRule]     = useState(null);
  const [deleteId, setDeleteId]     = useState(null);
  const [testRule, setTestRule]     = useState(null);
  const [msg, setMsg]               = useState('');
  const [msgType, setMsgType]       = useState('success');
  const [filterType, setFilterType] = useState(null); // null = all, or rule_type id

  const notify = (text, type = 'success') => {
    setMsg(text); setMsgType(type);
    setTimeout(() => setMsg(''), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/attendance/geo-rules');
      setRules(res.data || []);
    } catch {
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = (saved) => {
    setRules(prev => {
      const exists = prev.find(r => r.id === saved.id);
      return exists ? prev.map(r => r.id === saved.id ? saved : r) : [...prev, saved];
    });
    setShowForm(false);
    setEditRule(null);
    notify(saved.id ? 'Geo zone updated successfully' : 'Geo zone added successfully');
  };

  const handleDelete = async (id) => {
    try {
      await api.delete(`/attendance/geo-rules/${id}`);
      setRules(prev => prev.filter(r => r.id !== id));
      setDeleteId(null);
      notify('Geo zone deleted');
    } catch (e) {
      notify(e.response?.data?.error || 'Failed to delete', 'error');
      setDeleteId(null);
    }
  };

  const toggleActive = async (rule) => {
    try {
      const res = await api.put(`/attendance/geo-rules/${rule.id}`, {
        name: rule.name,
        location_name: rule.location_name,
        lat: parseFloat(rule.lat),
        lng: parseFloat(rule.lng),
        radius_meters: rule.radius_meters,
        rule_type: rule.rule_type,
        is_mandatory: rule.is_mandatory,
        is_active: !rule.is_active,
        applicable_to: rule.applicable_to || 'all',
        applicable_department: rule.applicable_department || null,
      });
      setRules(prev => prev.map(r => r.id === rule.id ? res.data : r));
    } catch {
      notify('Failed to update zone status', 'error');
    }
  };

  const displayedRules = filterType ? rules.filter(r => r.rule_type === filterType) : rules;

  return (
    <div style={{ padding: 24, fontFamily: 'Inter, sans-serif', margin: '0 auto' }}>

      <style>{`@keyframes spin { to { transform: translateY(-50%) rotate(360deg); } }`}</style>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1f2937' }}>Geo-Fencing Manager</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Configure location-based attendance zones for branches, factories, and field engineers
          </p>
        </div>
        <button
          onClick={() => { setEditRule(null); setShowForm(true); }}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 10, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
        >
          <Plus size={16} /> Add Geo Zone
        </button>
      </div>

      {/* Toast */}
      {msg && (
        <div style={{
          background: msgType === 'error' ? '#fef2f2' : '#f0fdf4',
          border: `1px solid ${msgType === 'error' ? '#fca5a5' : '#86efac'}`,
          borderRadius: 8, padding: '10px 14px', marginBottom: 16,
          color: msgType === 'error' ? '#dc2626' : '#15803d', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {msgType === 'error' ? <AlertCircle size={13} /> : <Check size={13} />}
          {msg}
        </div>
      )}

      {/* KPI bar — clickable to filter */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
        {RULE_TYPES.map(rt => {
          const count  = rules.filter(r => r.rule_type === rt.id).length;
          const active = rules.filter(r => r.rule_type === rt.id && r.is_active !== false).length;
          const isSelected = filterType === rt.id;
          return (
            <button
              key={rt.id}
              onClick={() => setFilterType(isSelected ? null : rt.id)}
              title={isSelected ? 'Clear filter' : `Show only ${rt.label} zones`}
              style={{
                ...CARD, padding: 16, cursor: 'pointer', textAlign: 'left',
                border: `1px solid ${isSelected ? rt.color : '#f0f0f4'}`,
                background: isSelected ? `${rt.color}08` : '#fff',
                outline: 'none',
                transition: 'border-color 0.15s, background 0.15s',
                position: 'relative',
              }}
            >
              {isSelected && (
                <Filter size={10} color={rt.color} style={{ position: 'absolute', top: 8, right: 8, opacity: 0.7 }} />
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <rt.icon size={16} color={rt.color} />
                <span style={{ fontSize: 12, fontWeight: 600, color: isSelected ? rt.color : '#6b7280' }}>{rt.label}</span>
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: rt.color }}>{count}</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{active} active zone{active !== 1 ? 's' : ''}</div>
            </button>
          );
        })}
      </div>

      {/* Active filter pill */}
      {filterType && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          {(() => {
            const rt = RULE_TYPES.find(r => r.id === filterType);
            return (
              <>
                <Filter size={12} color={rt.color} />
                <span style={{ fontSize: 13, color: rt.color, fontWeight: 600 }}>Showing {rt.label} zones only</span>
                <button
                  onClick={() => setFilterType(null)}
                  style={{ fontSize: 12, color: '#9ca3af', border: 'none', background: 'none', cursor: 'pointer', padding: '0 4px', textDecoration: 'underline' }}
                >
                  Clear filter
                </button>
              </>
            );
          })()}
        </div>
      )}

      {/* Info banner */}
      <div style={{ background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Radio size={15} color={P} style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 13, color: '#4b5563' }}>
          <strong style={{ color: '#1f2937' }}>How it works:</strong>{' '}
          Employees can only clock in when their GPS location falls within the configured radius.
          When <strong>Block Punch Outside Radius</strong> is enabled, attendance from outside the zone is rejected.
          Field Engineer zones allow wider radii and GPS coordinates are logged for audit.
          <strong style={{ color: '#6B3FDB' }}> Click a type card above to filter zones by type.</strong>
        </div>
      </div>

      {/* Rules list */}
      {loading ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <div style={{ width: 32, height: 32, border: '3px solid #f0f0f4', borderTopColor: P, borderRadius: '50%', margin: '0 auto 12px', animation: 'spin 0.7s linear infinite' }} />
          Loading geo zones…
        </div>
      ) : displayedRules.length === 0 ? (
        <div style={{ ...CARD, textAlign: 'center', padding: 60 }}>
          <MapPin size={44} color="#d1d5db" style={{ marginBottom: 16 }} />
          {filterType ? (
            <>
              <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#374151' }}>
                No {RULE_TYPES.find(r => r.id === filterType)?.label} zones configured
              </h3>
              <p style={{ margin: '0 0 16px', color: '#9ca3af', fontSize: 13 }}>
                Add a zone of this type or{' '}
                <button onClick={() => setFilterType(null)} style={{ border: 'none', background: 'none', color: P, cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0 }}>
                  view all zones
                </button>.
              </p>
            </>
          ) : (
            <>
              <h3 style={{ margin: '0 0 8px', fontSize: 16, color: '#374151' }}>No geo zones configured</h3>
              <p style={{ margin: '0 0 20px', color: '#9ca3af', fontSize: 13 }}>
                Add your first geo zone to enable location-based attendance.
              </p>
            </>
          )}
          <button
            onClick={() => { setEditRule(null); setShowForm(true); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 20px', borderRadius: 10, border: 'none', background: P, color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
          >
            <Plus size={15} /> Add {filterType ? RULE_TYPES.find(r => r.id === filterType)?.label + ' ' : ''}Geo Zone
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {displayedRules.map(rule => {
            const rt = RULE_TYPES.find(r => r.id === rule.rule_type) || RULE_TYPES[0];
            const isActive = rule.is_active !== false;
            const appLabel = rule.applicable_to === 'department' && rule.applicable_department
              ? rule.applicable_department
              : null;
            return (
              <div key={rule.id} style={{ ...CARD, display: 'flex', gap: 16, alignItems: 'center', opacity: isActive ? 1 : 0.6 }}>
                <GeoCircleViz rule={rule} />

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{rule.name}</h3>
                    <span style={{ background: `${rt.color}15`, color: rt.color, borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                      <rt.icon size={10} style={{ verticalAlign: 'middle', marginRight: 3 }} />
                      {rt.label}
                    </span>
                    {!isActive && <span style={{ background: '#f3f4f6', color: '#9ca3af', borderRadius: 12, padding: '2px 8px', fontSize: 11 }}>Inactive</span>}
                    {rule.is_mandatory && <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>Mandatory</span>}
                    {appLabel && (
                      <span style={{ background: '#eff6ff', color: '#1d4ed8', borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 500 }}>
                        Dept: {appLabel}
                      </span>
                    )}
                  </div>
                  {rule.location_name && (
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
                      <Building size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />{rule.location_name}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 14, fontSize: 12, color: '#374151', flexWrap: 'wrap' }}>
                    <span>
                      <MapPin size={11} style={{ verticalAlign: 'middle', marginRight: 3, color: '#9ca3af' }} />
                      {parseFloat(rule.lat).toFixed(5)}, {parseFloat(rule.lng).toFixed(5)}
                    </span>
                    <span>
                      Radius: <strong style={{ color: P }}>{rule.radius_meters >= 1000 ? `${(rule.radius_meters / 1000).toFixed(1)} km` : `${rule.radius_meters} m`}</strong>
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', flexShrink: 0 }}>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      title="Test my location against this zone"
                      onClick={() => setTestRule(rule)}
                      style={{ border: 'none', background: '#f0fdf4', borderRadius: 6, padding: 7, cursor: 'pointer', color: '#15803d' }}
                    >
                      <TestTube size={13} />
                    </button>
                    <button
                      title="Edit"
                      onClick={() => { setEditRule(rule); setShowForm(true); }}
                      style={{ border: 'none', background: '#f0f9ff', borderRadius: 6, padding: 7, cursor: 'pointer', color: '#0369a1' }}
                    >
                      <Edit2 size={13} />
                    </button>
                    <button
                      title="Delete"
                      onClick={() => setDeleteId(rule.id)}
                      style={{ border: 'none', background: '#fef2f2', borderRadius: 6, padding: 7, cursor: 'pointer', color: '#dc2626' }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <button
                    onClick={() => toggleActive(rule)}
                    style={{
                      padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                      border: `1px solid ${isActive ? '#10b981' : '#d1d5db'}`,
                      background: isActive ? '#f0fdf4' : '#f9fafb',
                      color: isActive ? '#15803d' : '#6b7280',
                    }}
                  >
                    {isActive ? '● Active' : '○ Inactive'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: 28, maxWidth: 380, width: '100%', textAlign: 'center' }}>
            <AlertCircle size={38} color="#dc2626" style={{ marginBottom: 14 }} />
            <h3 style={{ margin: '0 0 8px', fontSize: 17 }}>Delete Geo Zone?</h3>
            <p style={{ margin: '0 0 22px', color: '#6b7280', fontSize: 13 }}>
              Attendance will no longer be geo-validated for this location. This cannot be undone.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => setDeleteId(null)} style={{ padding: '10px 22px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                Cancel
              </button>
              <button onClick={() => handleDelete(deleteId)} style={{ padding: '10px 22px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
                Delete Zone
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <GeoRuleForm
          rule={editRule}
          onSave={handleSave}
          onClose={() => { setShowForm(false); setEditRule(null); }}
        />
      )}

      {testRule && (
        <TestLocationModal rule={testRule} onClose={() => setTestRule(null)} />
      )}
    </div>
  );
}
