/**
 * MetricRegistry.jsx — the metric catalogue and device profiles, editable.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * Two things were only reachable through a SQL console:
 *
 *   1. A tenant-specific metric. The global catalogue covers the AHF/SVG/STATCOM
 *      contract, but a customer with an unusual sensor had no way to declare it —
 *      and an undeclared metric is rejected at ingest as UNKNOWN_METRIC, so the
 *      data silently never arrived.
 *
 *   2. A REGISTER MAP. This is the one that mattered most. The hardware pilot
 *      (IOT_HARDWARE_PILOT.md) requires entering a real device's register map —
 *      addressing mode, byte and word order, per-register type, scale and offset —
 *      and verifying each register against the device's own display. Without a UI
 *      that was a hand-written INSERT with a JSONB literal, which is not something
 *      to ask a commissioning engineer to do on site.
 *
 * THE DANGEROUS FIELDS ARE LABELLED AS DANGEROUS. Addressing mode and word order
 * do not fail loudly when they are wrong: they return a plausible number from the
 * wrong register or the wrong byte order. The form says so at the point of entry,
 * because that is the only moment anyone can catch it.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Ruler, Cpu, Plus, RefreshCw, AlertTriangle, Ban, Save, X, Trash2, Lock,
  Info, TriangleAlert, Copy,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '9px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13, verticalAlign: 'top' };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };
const input = { width: '100%', padding: '7px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' };
const label = { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.03em', display: 'block', marginBottom: 4 };

const BLANK_METRIC = {
  metric_code: '', display_name: '', unit: '', data_type: 'number', description: '',
  device_types: [], min_physical: '', max_physical: '', precision_digits: 3,
  sampling_expect_s: '', aggregation: 'avg', quality_policy: 'valid_only',
  rising_is_bad: false, is_counter: false, enabled: true,
};
const BLANK_PROFILE = {
  profile_code: '', device_type: 'AHF', manufacturer: '', model: '', firmware: '',
  register_map_ver: '', protocol: 'modbus_tcp', addressing_mode: 'one_based',
  byte_order: 'big', word_order: 'big', default_sampling_s: 60,
  capabilities: [], register_map: [], enabled: true,
};
const BLANK_REGISTER = { metric: '', address: '', register: 'holding', type: 'float32', scale: 1, offset: 0 };

export default function MetricRegistry() {
  const [tab, setTab] = useState('metrics');
  const [metrics, setMetrics] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [state, setState] = useState('LOADING');
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // {kind:'metric'|'profile', row}
  const [form, setForm] = useState(BLANK_METRIC);
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setState('LOADING'); setError(null);
    Promise.all([api.get('/iot/metrics'), api.get('/iot/profiles')])
      .then(([m, p]) => { setMetrics(m.data.rows || []); setProfiles(p.data.rows || []); setState('SUCCESS'); })
      .catch((e) => {
        const status = e?.response?.status;
        setError({ message: e?.response?.data?.message || e?.response?.data?.error || e.message, status });
        setState(status === 403 ? 'UNAUTHORIZED' : 'ERROR');
      });
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const openMetric = (row) => {
    setForm(row ? { ...BLANK_METRIC, ...row, min_physical: row.min_physical ?? '', max_physical: row.max_physical ?? '', sampling_expect_s: row.sampling_expect_s ?? '' } : BLANK_METRIC);
    setEditing({ kind: 'metric', row }); setSaveError(null);
  };
  const openProfile = (row) => {
    setForm(row ? { ...BLANK_PROFILE, ...row, register_map: row.register_map || [] } : BLANK_PROFILE);
    setEditing({ kind: 'profile', row }); setSaveError(null);
  };
  /** Copy a shipped template into an editable company profile — the intended path. */
  const cloneTemplate = (tpl) => {
    setForm({
      ...BLANK_PROFILE, ...tpl,
      profile_code: `${tpl.profile_code.replace(/^GENERIC_/, '')}_`,
      manufacturer: '', model: '', firmware: '', register_map_ver: '',
      register_map: [], id: undefined, company_id: undefined, is_template: false,
    });
    setEditing({ kind: 'profile', row: null }); setSaveError(null);
  };

  const save = async () => {
    setBusy(true); setSaveError(null);
    try {
      if (editing.kind === 'metric') {
        const body = {
          ...form,
          min_physical: form.min_physical === '' ? null : Number(form.min_physical),
          max_physical: form.max_physical === '' ? null : Number(form.max_physical),
          sampling_expect_s: form.sampling_expect_s === '' ? null : Number(form.sampling_expect_s),
          precision_digits: Number(form.precision_digits) || 3,
        };
        if (editing.row?.id) await api.put(`/iot/metrics/${editing.row.id}`, body);
        else await api.post('/iot/metrics', body);
      } else {
        const body = {
          ...form,
          default_sampling_s: Number(form.default_sampling_s) || 60,
          register_map: (form.register_map || []).map((r) => ({
            ...r, address: Number(r.address), scale: Number(r.scale ?? 1), offset: Number(r.offset ?? 0),
          })),
        };
        if (editing.row?.id) await api.put(`/iot/profiles/${editing.row.id}`, body);
        else await api.post('/iot/profiles', body);
      }
      setEditing(null); load();
    } catch (e) {
      const d = e?.response?.data;
      setSaveError([d?.error, d?.detail, d?.hint].filter(Boolean).join(' — ') || e.message);
    } finally { setBusy(false); }
  };

  const remove = async (kind, row) => {
    if (!window.confirm(`Delete ${kind} "${row.metric_code || row.profile_code}"?`)) return;
    try { await api.delete(`/iot/${kind === 'metric' ? 'metrics' : 'profiles'}/${row.id}`); load(); }
    catch (e) {
      const d = e?.response?.data;
      window.alert([d?.error, d?.detail, d?.hint].filter(Boolean).join('\n\n') || e.message);
    }
  };

  // ── register map editing ────────────────────────────────────────────────────
  const regs = form.register_map || [];
  const setReg = (i, k, v) => setForm((f) => {
    const next = [...(f.register_map || [])];
    next[i] = { ...next[i], [k]: v };
    return { ...f, register_map: next };
  });
  const addReg = () => setForm((f) => ({ ...f, register_map: [...(f.register_map || []), { ...BLANK_REGISTER }] }));
  const delReg = (i) => setForm((f) => ({ ...f, register_map: (f.register_map || []).filter((_, x) => x !== i) }));

  return (
    <PageShell dock={
      <PageHero
        icon={Ruler}
        eyebrow="IoT"
        title="Metric & Device Registry"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="plh-cta" onClick={() => (tab === 'metrics' ? openMetric(null) : openProfile(null))}>
              <Plus size={13} /> New {tab === 'metrics' ? 'metric' : 'profile'}
            </button>
            <button className="plh-cta" onClick={load}><RefreshCw size={13} /> Refresh</button>
          </div>
        }
      />
    }>
      <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: 13 }}>
        What a reading MEANS, and how a device's registers map onto it. A metric that is not declared here is
        rejected at ingest as <code>UNKNOWN_METRIC</code>, so the data never silently arrives as a number nobody can interpret.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[{ k: 'metrics', l: `Metrics (${metrics.length})` }, { k: 'profiles', l: `Device profiles (${profiles.length})` }].map((x) => (
          <button key={x.k} onClick={() => setTab(x.k)}
            style={{ ...btn, background: tab === x.k ? '#6B3FDB' : '#fff', color: tab === x.k ? '#fff' : '#374151', borderColor: tab === x.k ? '#6B3FDB' : '#e5e7eb' }}>
            {x.l}
          </button>
        ))}
      </div>

      {state === 'LOADING' && <div style={{ ...CARD, color: '#9ca3af', textAlign: 'center', padding: 28 }}>Loading…</div>}

      {(state === 'ERROR' || state === 'UNAUTHORIZED') && (
        <div style={{ ...CARD, borderColor: '#fecaca', background: '#fef2f2', display: 'flex', gap: 10 }}>
          {state === 'UNAUTHORIZED' ? <Ban size={18} color="#b45309" /> : <AlertTriangle size={18} color="#dc2626" />}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#991b1b' }}>Could not load the registry</div>
            <div style={{ fontSize: 12, color: '#991b1b', marginTop: 3 }}>{error?.message}</div>
          </div>
        </div>
      )}

      {state === 'SUCCESS' && tab === 'metrics' && (
        <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
              <thead><tr>
                <th style={TH}>Code</th><th style={TH}>Name</th><th style={TH}>Unit</th>
                <th style={TH}>Valid range</th><th style={TH}>Aggregation</th>
                <th style={TH}>Device types</th><th style={TH}>Flags</th><th style={TH}>Scope</th><th style={TH} />
              </tr></thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.metric_code} style={{ opacity: m.enabled ? 1 : 0.5 }}>
                    <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{m.metric_code}</td>
                    <td style={TD}>{m.display_name}</td>
                    <td style={TD}>{m.unit}</td>
                    <td style={{ ...TD, fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
                      {m.min_physical ?? '−∞'} … {m.max_physical ?? '∞'}
                    </td>
                    <td style={{ ...TD, fontSize: 12 }}>{m.aggregation}</td>
                    <td style={{ ...TD, fontSize: 11, color: '#6b7280' }}>{(m.device_types || []).join(', ') || '—'}</td>
                    <td style={{ ...TD, fontSize: 11 }}>
                      {m.rising_is_bad && <span style={{ color: '#b45309' }}>rising=bad </span>}
                      {m.is_counter && <span style={{ color: '#2563eb' }}>counter</span>}
                    </td>
                    <td style={TD}>
                      {m.company_id == null
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6b7280' }}>
                            <Lock size={10} /> global
                          </span>
                        : <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>company</span>}
                    </td>
                    <td style={{ ...TD, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {m.company_id == null ? (
                        <button onClick={() => { setForm({ ...BLANK_METRIC, ...m, id: undefined, company_id: undefined }); setEditing({ kind: 'metric', row: null }); }}
                          style={{ ...btn, fontSize: 11 }} title="Create a company override with this code">
                          <Copy size={11} /> Override
                        </button>
                      ) : (
                        <>
                          <button onClick={() => openMetric(m)} style={{ ...btn, marginRight: 6, fontSize: 11 }}>Edit</button>
                          <button onClick={() => remove('metric', m)} style={{ ...btn, color: '#991b1b', borderColor: '#fecaca', fontSize: 11 }}>
                            <Trash2 size={11} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {state === 'SUCCESS' && tab === 'profiles' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 9, padding: 11, fontSize: 12, color: '#3730a3' }}>
            <b>Shipped profiles carry no register map on purpose.</b> A register map is specific to a
            manufacturer, model and firmware; a generic one would be a guess presented as a fact. Copy a
            template to a company profile and enter the real map — see <code>IOT_HARDWARE_PILOT.md</code> for the
            verification protocol.
          </div>
          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                <thead><tr>
                  <th style={TH}>Profile</th><th style={TH}>Type</th><th style={TH}>Make / model</th>
                  <th style={TH}>Conventions</th><th style={TH}>Registers</th><th style={TH}>Capabilities</th>
                  <th style={TH}>Scope</th><th style={TH} />
                </tr></thead>
                <tbody>
                  {profiles.map((p) => (
                    <tr key={p.id} style={{ opacity: p.enabled ? 1 : 0.5 }}>
                      <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>{p.profile_code}</td>
                      <td style={TD}>{p.device_type}</td>
                      <td style={{ ...TD, fontSize: 12 }}>
                        {p.manufacturer || p.model
                          ? <>{p.manufacturer || '—'} {p.model || ''}<div style={{ fontSize: 11, color: '#9ca3af' }}>fw {p.firmware || '—'} · map {p.register_map_ver || '—'}</div></>
                          : <span style={{ color: '#9ca3af' }}>not specified</span>}
                      </td>
                      <td style={{ ...TD, fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' }}>
                        {p.addressing_mode}<br />byte {p.byte_order} · word {p.word_order}
                      </td>
                      <td style={TD}>
                        {(p.register_map || []).length
                          ? <b>{p.register_map.length}</b>
                          : <span style={{ color: '#b45309', fontSize: 11 }}>none — cannot poll</span>}
                      </td>
                      <td style={{ ...TD, fontSize: 11, color: '#6b7280' }}>{(p.capabilities || []).length} metric(s)</td>
                      <td style={TD}>
                        {p.company_id == null
                          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6b7280' }}><Lock size={10} /> template</span>
                          : <span style={{ fontSize: 11, color: '#059669', fontWeight: 600 }}>company</span>}
                      </td>
                      <td style={{ ...TD, whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {p.company_id == null ? (
                          <button onClick={() => cloneTemplate(p)} style={{ ...btn, fontSize: 11 }}>
                            <Copy size={11} /> Copy to company
                          </button>
                        ) : (
                          <>
                            <button onClick={() => openProfile(p)} style={{ ...btn, marginRight: 6, fontSize: 11 }}>Edit</button>
                            <button onClick={() => remove('profile', p)} style={{ ...btn, color: '#991b1b', borderColor: '#fecaca', fontSize: 11 }}>
                              <Trash2 size={11} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── editor ────────────────────────────────────────────────────────────── */}
      {editing && (
        <>
          <div onClick={() => setEditing(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 1199 }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(680px, 100vw)', background: '#fff',
            borderLeft: '1px solid #e5e7eb', boxShadow: '-8px 0 30px rgba(0,0,0,.12)', zIndex: 1200,
            overflowY: 'auto', padding: 18,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>
                {editing.row?.id ? 'Edit' : 'New'} {editing.kind === 'metric' ? 'metric' : 'device profile'}
              </span>
              <button onClick={() => setEditing(null)} style={{ ...btn, border: 'none' }}><X size={16} /></button>
            </div>

            {editing.kind === 'metric' ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={label}>Metric code</label>
                    <input style={{ ...input, fontFamily: 'monospace' }} value={form.metric_code}
                      onChange={(e) => setForm((f) => ({ ...f, metric_code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') }))}
                      disabled={!!editing.row?.id} placeholder="THD_I_L4" />
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                      The gateway sends this verbatim. A case or spacing difference becomes an UNKNOWN_METRIC rejection.
                    </div>
                  </div>
                  <div>
                    <label style={label}>Unit</label>
                    <input style={input} value={form.unit} onChange={set('unit')} placeholder="%, A, V, degC…" />
                  </div>
                </div>

                <div>
                  <label style={label}>Display name</label>
                  <input style={input} value={form.display_name} onChange={set('display_name')} />
                </div>
                <div>
                  <label style={label}>Description</label>
                  <input style={input} value={form.description || ''} onChange={set('description')} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={label}>Minimum physical</label>
                    <input style={input} type="number" step="any" value={form.min_physical} onChange={set('min_physical')} placeholder="none" />
                  </div>
                  <div>
                    <label style={label}>Maximum physical</label>
                    <input style={input} type="number" step="any" value={form.max_physical} onChange={set('max_physical')} placeholder="none" />
                  </div>
                  <div>
                    <label style={label}>Precision</label>
                    <input style={input} type="number" value={form.precision_digits} onChange={set('precision_digits')} />
                  </div>
                </div>
                <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, fontSize: 11, color: '#6b7280', display: 'flex', gap: 8 }}>
                  <Info size={13} style={{ flex: 'none', marginTop: 1 }} />
                  <span>
                    The physical range is enforced at ingest: a reading outside it is quarantined as
                    OUT_OF_RANGE rather than stored. Leaving it empty means anything is accepted — which is
                    how a THD of 899 became a measurement.
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={label}>Aggregation</label>
                    <select style={input} value={form.aggregation} onChange={set('aggregation')}>
                      {['avg', 'min', 'max', 'sum', 'last', 'counter', 'pf_energy'].map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={label}>Expected sampling (s)</label>
                    <input style={input} type="number" value={form.sampling_expect_s} onChange={set('sampling_expect_s')} placeholder="from the device" />
                  </div>
                </div>

                <div>
                  <label style={label}>Device types (comma separated)</label>
                  <input style={input} value={(form.device_types || []).join(', ')}
                    onChange={(e) => setForm((f) => ({ ...f, device_types: e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) }))}
                    placeholder="AHF, SVG, STATCOM" />
                </div>

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!form.rising_is_bad} onChange={set('rising_is_bad')} />
                    Rising is degradation
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!form.is_counter} onChange={set('is_counter')} />
                    Monotonic counter
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.enabled !== false} onChange={set('enabled')} />
                    Enabled
                  </label>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 10 }}>
                  <div>
                    <label style={label}>Profile code</label>
                    <input style={{ ...input, fontFamily: 'monospace' }} value={form.profile_code} onChange={set('profile_code')} placeholder="ACME_AHF100_v3" />
                  </div>
                  <div>
                    <label style={label}>Device type</label>
                    <select style={input} value={form.device_type} onChange={set('device_type')}>
                      {['AHF', 'SVG', 'STATCOM'].map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div><label style={label}>Manufacturer</label><input style={input} value={form.manufacturer || ''} onChange={set('manufacturer')} /></div>
                  <div><label style={label}>Model</label><input style={input} value={form.model || ''} onChange={set('model')} /></div>
                  <div><label style={label}>Firmware</label><input style={input} value={form.firmware || ''} onChange={set('firmware')} /></div>
                  <div><label style={label}>Register map version</label><input style={input} value={form.register_map_ver || ''} onChange={set('register_map_ver')} /></div>
                </div>

                {/* The three settings that fail silently */}
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 11 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
                    <TriangleAlert size={14} color="#b45309" style={{ flex: 'none', marginTop: 1 }} />
                    <span style={{ fontSize: 11, color: '#92400e' }}>
                      <b>These three do not fail loudly when they are wrong.</b> A wrong addressing mode reads the
                      NEIGHBOURING register; a wrong word order decodes a float to a finite, plausible, wrong number.
                      Take them from the device's register-map document, and verify against the device's own display
                      before trusting the values.
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                    <div>
                      <label style={label}>Addressing</label>
                      <select style={input} value={form.addressing_mode} onChange={set('addressing_mode')}>
                        <option value="one_based">one_based (40001 → 0)</option>
                        <option value="zero_based">zero_based (as documented)</option>
                      </select>
                    </div>
                    <div>
                      <label style={label}>Byte order</label>
                      <select style={input} value={form.byte_order} onChange={set('byte_order')}>
                        <option value="big">big</option><option value="little">little</option>
                      </select>
                    </div>
                    <div>
                      <label style={label}>Word order</label>
                      <select style={input} value={form.word_order} onChange={set('word_order')}>
                        <option value="big">big (ABCD)</option><option value="little">little (CDAB)</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={label}>Protocol</label>
                    <select style={input} value={form.protocol} onChange={set('protocol')}>
                      <option value="modbus_tcp">modbus_tcp</option>
                      <option value="modbus_rtu">modbus_rtu</option>
                      <option value="http">http</option>
                    </select>
                  </div>
                  <div>
                    <label style={label}>Default sampling (s)</label>
                    <input style={input} type="number" value={form.default_sampling_s} onChange={set('default_sampling_s')} />
                  </div>
                </div>

                <div>
                  <label style={label}>Capabilities — metrics this model publishes</label>
                  <select multiple size={6} style={{ ...input, height: 'auto', fontFamily: 'monospace', fontSize: 12 }}
                    value={form.capabilities || []}
                    onChange={(e) => setForm((f) => ({ ...f, capabilities: [...e.target.selectedOptions].map((o) => o.value) }))}>
                    {metrics.map((m) => <option key={m.metric_code} value={m.metric_code}>{m.metric_code} — {m.display_name}</option>)}
                  </select>
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                    A metric not listed here is rejected for this device as NOT_SUPPORTED_BY_PROFILE. Declare only
                    what the model actually publishes — {(form.capabilities || []).length} selected.
                  </div>
                </div>

                {/* register map */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <label style={{ ...label, marginBottom: 0 }}>Register map ({regs.length})</label>
                    <button onClick={addReg} style={{ ...btn, fontSize: 11 }}><Plus size={11} /> Add register</button>
                  </div>
                  {regs.length === 0 ? (
                    <div style={{ background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 8, padding: 14, fontSize: 12, color: '#6b7280', textAlign: 'center' }}>
                      No registers mapped. The gateway cannot poll this device over Modbus until at least one is defined.
                    </div>
                  ) : (
                    <div style={{ overflowX: 'auto', border: '1px solid #f0f0f4', borderRadius: 8 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 540, fontSize: 12 }}>
                        <thead><tr>
                          <th style={{ ...TH, padding: '6px 8px' }}>Metric</th>
                          <th style={{ ...TH, padding: '6px 8px' }}>Address</th>
                          <th style={{ ...TH, padding: '6px 8px' }}>Table</th>
                          <th style={{ ...TH, padding: '6px 8px' }}>Type</th>
                          <th style={{ ...TH, padding: '6px 8px' }}>Scale</th>
                          <th style={{ ...TH, padding: '6px 8px' }}>Offset</th>
                          <th style={{ ...TH, padding: '6px 8px' }} />
                        </tr></thead>
                        <tbody>
                          {regs.map((r, i) => (
                            <tr key={i}>
                              <td style={{ padding: 4 }}>
                                <select style={{ ...input, padding: '4px 6px', fontSize: 11, fontFamily: 'monospace' }}
                                  value={r.metric} onChange={(e) => setReg(i, 'metric', e.target.value)}>
                                  <option value="">select…</option>
                                  {(form.capabilities?.length ? metrics.filter((m) => form.capabilities.includes(m.metric_code)) : metrics)
                                    .map((m) => <option key={m.metric_code} value={m.metric_code}>{m.metric_code}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: 4 }}>
                                <input style={{ ...input, padding: '4px 6px', fontSize: 11 }} type="number"
                                  value={r.address} onChange={(e) => setReg(i, 'address', e.target.value)} placeholder="40001" />
                              </td>
                              <td style={{ padding: 4 }}>
                                <select style={{ ...input, padding: '4px 6px', fontSize: 11 }} value={r.register || 'holding'}
                                  onChange={(e) => setReg(i, 'register', e.target.value)}>
                                  <option value="holding">holding</option><option value="input">input</option>
                                </select>
                              </td>
                              <td style={{ padding: 4 }}>
                                <select style={{ ...input, padding: '4px 6px', fontSize: 11 }} value={r.type}
                                  onChange={(e) => setReg(i, 'type', e.target.value)}>
                                  {['int16', 'uint16', 'int32', 'uint32', 'float32', 'float64'].map((t) => <option key={t} value={t}>{t}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: 4 }}>
                                <input style={{ ...input, padding: '4px 6px', fontSize: 11 }} type="number" step="any"
                                  value={r.scale ?? 1} onChange={(e) => setReg(i, 'scale', e.target.value)} />
                              </td>
                              <td style={{ padding: 4 }}>
                                <input style={{ ...input, padding: '4px 6px', fontSize: 11 }} type="number" step="any"
                                  value={r.offset ?? 0} onChange={(e) => setReg(i, 'offset', e.target.value)} />
                              </td>
                              <td style={{ padding: 4, textAlign: 'right' }}>
                                <button onClick={() => delReg(i)} style={{ ...btn, padding: '3px 6px', color: '#991b1b', borderColor: '#fecaca' }}>
                                  <Trash2 size={10} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 5 }}>
                    Engineering value = raw × scale + offset. Verify every row against the device's own display
                    before commissioning — see IOT_HARDWARE_PILOT.md.
                  </div>
                </div>

                <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={form.enabled !== false} onChange={set('enabled')} /> Enabled
                </label>
              </div>
            )}

            {saveError && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10, fontSize: 12, color: '#991b1b', marginTop: 12 }}>
                {saveError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button onClick={save} disabled={busy}
                style={{ ...btn, background: '#6B3FDB', color: '#fff', borderColor: '#6B3FDB', padding: '8px 16px' }}>
                <Save size={13} /> {busy ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setEditing(null)} style={{ ...btn, padding: '8px 16px' }}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
