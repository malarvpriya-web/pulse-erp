/**
 * HardwarePilots.jsx — the hardware pilot, recorded.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * The pilot is the one item still blocking certification, and it cannot be done
 * in software. What CAN be fixed is everything around it: until now the procedure
 * lived in a markdown file, which means the result lived in somebody's memory and
 * a photograph. Six months later, when a reading looks wrong, "was this register
 * ever verified, by whom, against what?" had no answer.
 *
 * This page makes the answer a record. It also makes the honest state visible:
 * with no passed pilot it says, at the top, that every register map in the
 * company is unverified — rather than letting a green Fleet Monitor imply
 * otherwise.
 *
 * THE PAGE CANNOT PASS A PILOT ON ITS OWN. Complete is disabled until a named
 * engineer, a named reference instrument, all three confirmed conventions and at
 * least one register comparison are present. The API refuses the same thing, and
 * so does a CHECK constraint. Three layers, because this is the one place where
 * a convenient shortcut would turn the whole certification into a claim about
 * nothing.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  ClipboardCheck, Plus, RefreshCw, AlertTriangle, Ban, Save, X, CheckCircle2,
  TriangleAlert, Info, Ruler, CircleAlert, Lock,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '8px 10px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '8px 10px', borderBottom: '1px solid #f9f9fb', fontSize: 13, verticalAlign: 'top' };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };
const input = { width: '100%', padding: '7px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' };
const label = { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.03em', display: 'block', marginBottom: 4 };

const VERDICT = {
  in_progress: { label: 'In progress', bg: '#fef3c7', color: '#92400e' },
  passed: { label: 'Passed', bg: '#dcfce7', color: '#166534' },
  failed: { label: 'Failed', bg: '#fee2e2', color: '#991b1b' },
  abandoned: { label: 'Abandoned', bg: '#f3f4f6', color: '#6b7280' },
};
const fmt = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

// Suggested tolerances from IOT_HARDWARE_PILOT.md, offered as defaults so an
// engineer is not inventing one per register at 11pm in a panel room.
const TOLERANCE = {
  V_L1: 0.5, V_L2: 0.5, V_L3: 0.5, V_L12: 0.5, V_L23: 0.5, V_L31: 0.5,
  I_L1: 0.5, I_L2: 0.5, I_L3: 0.5,
  FREQUENCY: 0.04, KW: 1, KVAR: 1, KVA: 1,
  PF: 1, PF_DISP: 1,
  THD_I_L1: 1, THD_I_L2: 1, THD_I_L3: 1, THD_V_L1: 1, THD_V_L2: 1, THD_V_L3: 1,
  TEMPERATURE: 2, ENERGY_KWH: 0.5, ENERGY_KVARH: 0.5,
};

function errState(e) {
  const status = e?.response?.status;
  if (status === 403) return { kind: 'UNAUTHORIZED', message: e.response?.data?.message || 'You do not have access to hardware pilots.' };
  return { kind: 'ERROR', message: e?.response?.data?.error || e?.message || 'The request failed.', status };
}

// ── one pilot, in detail ──────────────────────────────────────────────────────
function PilotDetail({ id, onClose, onChanged }) {
  const [p, setP] = useState(null);
  const [state, setState] = useState('LOADING');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({});

  const load = useCallback(() => {
    setState('LOADING');
    api.get(`/iot/pilots/${id}`)
      .then(({ data }) => {
        setP(data);
        setForm({
          confirmed_addressing_mode: data.confirmed_addressing_mode || '',
          confirmed_byte_order: data.confirmed_byte_order || '',
          confirmed_word_order: data.confirmed_word_order || '',
          reference_instrument: data.reference_instrument || '',
          engineer_name: data.engineer_name || '',
          notes: data.notes || '',
        });
        setState('SUCCESS');
      })
      .catch((e) => { const err = errState(e); setError(err); setState(err.kind); });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const saveHeader = async () => {
    setBusy(true);
    try {
      const body = { ...form };
      for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
      await api.put(`/iot/pilots/${id}`, body);
      load(); onChanged?.();
    } catch (e) { setError(errState(e)); }
    finally { setBusy(false); }
  };

  const saveReading = async (metric, patch) => {
    try {
      await api.put(`/iot/pilots/${id}/readings/${encodeURIComponent(metric)}`, patch);
      load(); onChanged?.();
    } catch (e) {
      const d = e?.response?.data;
      window.alert([d?.error, d?.detail].filter(Boolean).join('\n\n') || e.message);
    }
  };

  const complete = async (verdict) => {
    const note = window.prompt(`Mark this pilot ${verdict}. Notes (optional):`, '');
    if (note === null) return;
    setBusy(true);
    try {
      await api.post(`/iot/pilots/${id}/complete`, { verdict, notes: note || null });
      load(); onChanged?.();
    } catch (e) {
      const d = e?.response?.data;
      if (d?.blockers) {
        window.alert(`This pilot cannot be marked passed yet:\n\n${d.blockers.map((b) => '· ' + b).join('\n')}`);
      } else {
        window.alert(d?.error || e.message);
      }
    } finally { setBusy(false); }
  };

  const panel = {
    position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(760px, 100vw)',
    background: '#fff', borderLeft: '1px solid #e5e7eb', boxShadow: '-8px 0 30px rgba(0,0,0,.12)',
    zIndex: 1200, overflowY: 'auto', padding: 18,
  };

  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Hardware pilot</span>
        <button onClick={onClose} style={{ ...btn, border: 'none' }}><X size={16} /></button>
      </div>

      {state === 'LOADING' && <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>}
      {(state === 'ERROR' || state === 'UNAUTHORIZED') && (
        <div style={{ ...CARD, borderColor: '#fecaca', background: '#fef2f2', color: '#991b1b', fontSize: 13 }}>
          {error?.message}
        </div>
      )}

      {state === 'SUCCESS' && p && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ background: VERDICT[p.verdict]?.bg, color: VERDICT[p.verdict]?.color, padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                {VERDICT[p.verdict]?.label || p.verdict}
              </span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>{fmt(p.performed_at)}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginTop: 8 }}>
              {[p.manufacturer, p.model].filter(Boolean).join(' ') || 'Device not identified'}
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {p.equipment_name || 'no equipment linked'} · SN {p.serial_number || 'not recorded'}
              {p.firmware ? ` · fw ${p.firmware}` : ''} · profile {p.profile_code || 'none'}
              {p.host ? ` · ${p.host}:${p.port}` : ''}
            </div>
          </div>

          {/* what still blocks a pass */}
          {p.verdict === 'in_progress' && (
            p.blockers?.length ? (
              <div style={{ ...CARD, background: '#fffbeb', borderColor: '#fde68a' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <TriangleAlert size={15} color="#b45309" style={{ flex: 'none', marginTop: 1 }} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#92400e' }}>
                      Not yet passable — {p.blockers.length} item(s) outstanding
                    </div>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: '#92400e' }}>
                      {p.blockers.map((b, i) => <li key={i} style={{ padding: '1px 0' }}>{b}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ ...CARD, background: '#f0fdf4', borderColor: '#bbf7d0', display: 'flex', gap: 8, alignItems: 'center' }}>
                <CheckCircle2 size={15} color="#059669" />
                <span style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>
                  Every piece of evidence is recorded. This pilot can be completed.
                </span>
              </div>
            )
          )}

          {/* declared vs confirmed */}
          <div style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 4 }}>Decode conventions</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 12 }}>
              Left is what the configuration claims. Right is what you confirmed against the device's own
              display. They are separate on purpose — a wrong convention returns a plausible number, so the
              config agreeing with itself proves nothing.
            </div>
            {[
              ['Addressing', 'declared_addressing_mode', 'confirmed_addressing_mode', ['one_based', 'zero_based']],
              ['Byte order', 'declared_byte_order', 'confirmed_byte_order', ['big', 'little']],
              ['Word order', 'declared_word_order', 'confirmed_word_order', ['big', 'little']],
            ].map(([name, declKey, confKey, options]) => {
              const declared = p[declKey];
              const confirmed = form[confKey];
              const mismatch = confirmed && declared && confirmed !== declared;
              return (
                <div key={name} style={{ display: 'grid', gridTemplateColumns: '100px 1fr 1fr', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>{name}</span>
                  <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#9ca3af' }}>{declared || '—'}</span>
                  <div>
                    <select style={{ ...input, borderColor: mismatch ? '#fbbf24' : '#e5e7eb' }}
                      value={confirmed || ''} onChange={set(confKey)} disabled={p.verdict !== 'in_progress'}>
                      <option value="">not confirmed</option>
                      {options.map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                    {mismatch && (
                      <div style={{ fontSize: 10, color: '#b45309', marginTop: 3 }}>
                        differs from the configuration — the profile will be corrected on pass
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
              <div>
                <label style={label}>Reference instrument</label>
                <input style={input} value={form.reference_instrument} onChange={set('reference_instrument')}
                  placeholder="e.g. Fluke 435-II, cal. 2026-03" disabled={p.verdict !== 'in_progress'} />
              </div>
              <div>
                <label style={label}>Engineer</label>
                <input style={input} value={form.engineer_name} onChange={set('engineer_name')}
                  placeholder="who performed this" disabled={p.verdict !== 'in_progress'} />
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <label style={label}>Notes</label>
              <input style={input} value={form.notes} onChange={set('notes')} disabled={p.verdict !== 'in_progress'} />
            </div>

            {p.verdict === 'in_progress' && (
              <button onClick={saveHeader} disabled={busy} style={{ ...btn, marginTop: 12 }}>
                <Save size={12} /> {busy ? 'Saving…' : 'Save observations'}
              </button>
            )}
          </div>

          {/* per-register comparison */}
          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>
                Register comparison ({p.readings?.length || 0})
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                Enter what the DEVICE DISPLAY and the reference instrument showed at the moment of the read.
                The difference and the verdict are computed from those numbers — they cannot be asserted.
              </div>
            </div>
            {p.readings?.length ? (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                  <thead><tr>
                    <th style={TH}>Metric</th><th style={TH}>Raw</th><th style={TH}>Pulse</th>
                    <th style={TH}>Device display</th><th style={TH}>Reference</th>
                    <th style={TH}>Tol %</th><th style={TH}>Diff</th><th style={TH}>Verdict</th>
                  </tr></thead>
                  <tbody>
                    {p.readings.map((r) => (
                      <ReadingRow key={r.id} r={r} locked={p.verdict !== 'in_progress'}
                        onSave={(patch) => saveReading(r.metric, patch)} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '0 14px 18px', fontSize: 12, color: '#6b7280' }}>
                No registers recorded. Run <code>node verify.mjs --config config.json --post</code> on the
                gateway to capture the raw reads, then fill in what the device showed.
              </div>
            )}
          </div>

          {/* completion */}
          {p.verdict === 'in_progress' && (
            <div style={{ ...CARD, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => complete('passed')} disabled={busy || (p.blockers?.length > 0)}
                title={p.blockers?.length ? 'Outstanding evidence — see the list above' : 'Record this pilot as passed'}
                style={{
                  ...btn, padding: '8px 16px',
                  background: p.blockers?.length ? '#f3f4f6' : '#059669',
                  color: p.blockers?.length ? '#9ca3af' : '#fff',
                  borderColor: p.blockers?.length ? '#e5e7eb' : '#059669',
                  cursor: p.blockers?.length ? 'not-allowed' : 'pointer',
                }}>
                {p.blockers?.length ? <Lock size={13} /> : <CheckCircle2 size={13} />} Mark passed
              </button>
              <button onClick={() => complete('failed')} disabled={busy}
                style={{ ...btn, padding: '8px 16px', color: '#991b1b', borderColor: '#fecaca' }}>
                Mark failed
              </button>
              <button onClick={() => complete('abandoned')} disabled={busy} style={{ ...btn, padding: '8px 16px' }}>
                Abandon
              </button>
            </div>
          )}

          {p.verdict !== 'in_progress' && (
            <div style={{ ...CARD, fontSize: 12, color: '#6b7280' }}>
              Closed {fmt(p.completed_at)}{p.engineer_user_name ? ` by ${p.engineer_user_name}` : ''}.
              {p.verdict === 'passed' && p.profile_code && (
                <> The profile <b>{p.profile_code}</b> is now marked verified against this pilot.</>
              )}
              {p.notes && <div style={{ marginTop: 6, fontStyle: 'italic' }}>“{p.notes}”</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReadingRow({ r, locked, onSave }) {
  const [v, setV] = useState({
    pulse_value: r.pulse_value ?? '',
    device_display: r.device_display ?? '',
    reference_value: r.reference_value ?? '',
    tolerance_pct: r.tolerance_pct ?? TOLERANCE[r.metric] ?? 1,
  });
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));
  const dirty = ['pulse_value', 'device_display', 'reference_value', 'tolerance_pct']
    .some((k) => String(v[k] ?? '') !== String(r[k] ?? ''));

  const cell = { ...input, padding: '4px 6px', fontSize: 11, width: 82 };
  const diff = r.difference_pct;

  return (
    <tr>
      <td style={{ ...TD, fontFamily: 'monospace', fontWeight: 600 }}>
        {r.metric}
        <div style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'inherit', fontWeight: 400 }}>
          {r.documented_address ?? '—'} · {r.data_type || '—'}{r.unit ? ` · ${r.unit}` : ''}
        </div>
      </td>
      <td style={{ ...TD, fontFamily: 'monospace', fontSize: 11, color: '#6b7280' }}>
        {r.raw_hex || '—'}
        {r.decoded_variants && (
          <div style={{ fontSize: 9, color: '#9ca3af' }}>
            {Object.entries(r.decoded_variants).slice(0, 2).map(([k, val]) => `${k}=${val}`).join(' ')}
          </div>
        )}
      </td>
      <td style={TD}><input style={cell} type="number" step="any" value={v.pulse_value} onChange={set('pulse_value')} disabled={locked} /></td>
      <td style={TD}><input style={cell} type="number" step="any" value={v.device_display} onChange={set('device_display')} disabled={locked} /></td>
      <td style={TD}><input style={cell} type="number" step="any" value={v.reference_value} onChange={set('reference_value')} disabled={locked} /></td>
      <td style={TD}><input style={{ ...cell, width: 58 }} type="number" step="any" value={v.tolerance_pct} onChange={set('tolerance_pct')} disabled={locked} /></td>
      <td style={{ ...TD, fontSize: 12, fontWeight: 600, color: diff == null ? '#d1d5db' : r.within_tolerance ? '#059669' : '#dc2626' }}>
        {diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff}%`}
      </td>
      <td style={TD}>
        {dirty && !locked ? (
          <button onClick={() => onSave({
            pulse_value: v.pulse_value === '' ? null : Number(v.pulse_value),
            device_display: v.device_display === '' ? null : Number(v.device_display),
            reference_value: v.reference_value === '' ? null : Number(v.reference_value),
            tolerance_pct: v.tolerance_pct === '' ? null : Number(v.tolerance_pct),
            verdict: 'passed',
          })} style={{ ...btn, fontSize: 11, padding: '3px 8px' }}>
            <Save size={10} /> Save
          </button>
        ) : (
          <span style={{
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', padding: '2px 7px', borderRadius: 7,
            background: r.verdict === 'passed' ? '#dcfce7' : r.verdict === 'failed' ? '#fee2e2' : '#f3f4f6',
            color: r.verdict === 'passed' ? '#166534' : r.verdict === 'failed' ? '#991b1b' : '#6b7280',
          }}>{r.verdict}</span>
        )}
      </td>
    </tr>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function HardwarePilots() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(null);
  const [state, setState] = useState('LOADING');
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [devices, setDevices] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [form, setForm] = useState({ equipment_id: '', device_profile_id: '', manufacturer: '', model: '', firmware: '', register_map_ver: '', site: '', reference_instrument: '', engineer_name: '' });

  const load = useCallback(() => {
    setState('LOADING');
    Promise.all([api.get('/iot/pilots'), api.get('/iot/pilots/status')])
      .then(([p, s]) => { setRows(p.data.rows || []); setStatus(s.data); setState('SUCCESS'); })
      .catch((e) => { const err = errState(e); setError(err); setState(err.kind); });
  }, []);

  useEffect(() => {
    load();
    api.get('/iot/devices', { params: { limit: 300 } }).then(({ data }) => setDevices(data.rows || [])).catch(() => setDevices([]));
    api.get('/iot/profiles').then(({ data }) => setProfiles((data.rows || []).filter((x) => x.company_id != null))).catch(() => setProfiles([]));
  }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const create = async () => {
    try {
      const body = { ...form };
      for (const k of Object.keys(body)) if (body[k] === '') body[k] = null;
      if (body.equipment_id) body.equipment_id = Number(body.equipment_id);
      if (body.device_profile_id) body.device_profile_id = Number(body.device_profile_id);
      const prof = profiles.find((x) => x.id === body.device_profile_id);
      if (prof) {
        body.declared_addressing_mode = prof.addressing_mode;
        body.declared_byte_order = prof.byte_order;
        body.declared_word_order = prof.word_order;
      }
      const { data } = await api.post('/iot/pilots', body);
      setCreating(false); load(); setOpenId(data.id);
    } catch (e) { window.alert(e?.response?.data?.error || e.message); }
  };

  return (
    <PageShell dock={
      <PageHero
        icon={ClipboardCheck}
        eyebrow="IoT"
        title="Hardware Pilots"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="plh-cta" onClick={() => setCreating(true)}><Plus size={13} /> New pilot</button>
            <button className="plh-cta" onClick={load}><RefreshCw size={13} /> Refresh</button>
          </div>
        }
      />
    }>
      <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: 13 }}>
        Proof that a real device is being read correctly. A register map that has not been compared against
        the device's own display is a configuration, not a measurement.
      </p>

      {/* the honest headline */}
      {status && (
        <div style={{
          ...CARD, marginBottom: 14,
          background: status.hardware_validated ? '#f0fdf4' : '#fffbeb',
          borderColor: status.hardware_validated ? '#bbf7d0' : '#fde68a',
        }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            {status.hardware_validated
              ? <CheckCircle2 size={18} color="#059669" style={{ flex: 'none', marginTop: 1 }} />
              : <CircleAlert size={18} color="#b45309" style={{ flex: 'none', marginTop: 1 }} />}
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: status.hardware_validated ? '#166534' : '#92400e' }}>
                {status.hardware_validated ? 'Hardware validated' : 'Hardware NOT validated'}
              </div>
              <div style={{ fontSize: 12, marginTop: 4, color: status.hardware_validated ? '#166534' : '#92400e' }}>
                {status.statement}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                {status.passed} passed · {status.in_progress} in progress · {status.failed} failed ·
                {' '}{status.verified_profiles}/{status.company_profiles} profiles verified ·
                {' '}{status.with_register_map} with a register map
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ ...CARD, marginBottom: 14, background: '#eef2ff', borderColor: '#c7d2fe', fontSize: 12, color: '#3730a3' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <Info size={14} style={{ flex: 'none', marginTop: 1 }} />
          <div>
            <b>How to run one.</b> On the gateway: <code>node verify.mjs --config config.json --post</code>.
            It reads every register once, decodes the same bytes under all four conventions side by side, and
            posts the raw result here as a pilot. Then open it, enter what the device display and the reference
            instrument showed, and complete it. <b>The tool cannot pass a pilot</b> — only a person comparing
            against the device can.
          </div>
        </div>
      </div>

      {state === 'LOADING' && <div style={{ ...CARD, color: '#9ca3af', textAlign: 'center', padding: 28 }}>Loading…</div>}

      {(state === 'ERROR' || state === 'UNAUTHORIZED') && (
        <div style={{ ...CARD, borderColor: '#fecaca', background: '#fef2f2', display: 'flex', gap: 10 }}>
          {state === 'UNAUTHORIZED' ? <Ban size={18} color="#b45309" /> : <AlertTriangle size={18} color="#dc2626" />}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#991b1b' }}>Could not load pilots</div>
            <div style={{ fontSize: 12, color: '#991b1b', marginTop: 3 }}>{error?.message}</div>
          </div>
        </div>
      )}

      {state === 'SUCCESS' && (
        rows.length === 0 ? (
          <div style={{ ...CARD, textAlign: 'center', padding: 30 }}>
            <Ruler size={26} color="#b45309" style={{ marginBottom: 10 }} />
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>No hardware pilot has been run</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6, maxWidth: 520, margin: '6px auto 0' }}>
              Until one passes, every register map in this company is a configuration that has never been
              checked against a physical device. The decoder is tested and the transport is proven — what is
              missing is evidence that a particular unit's registers mean what the profile says they mean.
            </div>
            <button onClick={() => setCreating(true)} style={{ ...btn, marginTop: 14, padding: '7px 14px' }}>
              <Plus size={13} /> Open the first pilot
            </button>
          </div>
        ) : (
          <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                <thead><tr>
                  <th style={TH}>Device</th><th style={TH}>Equipment</th><th style={TH}>Profile</th>
                  <th style={TH}>Registers</th><th style={TH}>Engineer</th><th style={TH}>Performed</th>
                  <th style={TH}>Verdict</th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => setOpenId(r.id)} style={{ cursor: 'pointer' }}>
                      <td style={TD}>
                        <div style={{ fontWeight: 600, color: '#111827' }}>
                          {[r.manufacturer, r.model].filter(Boolean).join(' ') || 'not identified'}
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>
                          {r.firmware ? `fw ${r.firmware}` : ''}{r.register_map_ver ? ` · map ${r.register_map_ver}` : ''}
                        </div>
                      </td>
                      <td style={{ ...TD, fontSize: 12 }}>{r.equipment_name || '—'}</td>
                      <td style={{ ...TD, fontSize: 12, fontFamily: 'monospace' }}>{r.profile_code || '—'}</td>
                      <td style={{ ...TD, fontSize: 12 }}>
                        {r.readings} recorded
                        {r.readings_passed ? <span style={{ color: '#059669' }}> · {r.readings_passed} passed</span> : null}
                        {r.readings_failed ? <span style={{ color: '#dc2626' }}> · {r.readings_failed} failed</span> : null}
                      </td>
                      <td style={{ ...TD, fontSize: 12 }}>{r.engineer_user_name || r.engineer_name || <span style={{ color: '#d1d5db' }}>—</span>}</td>
                      <td style={{ ...TD, fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmt(r.performed_at)}</td>
                      <td style={TD}>
                        <span style={{ background: VERDICT[r.verdict]?.bg, color: VERDICT[r.verdict]?.color, padding: '2px 8px', borderRadius: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                          {VERDICT[r.verdict]?.label || r.verdict}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {/* new pilot */}
      {creating && (
        <>
          <div onClick={() => setCreating(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 1199 }} />
          <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(520px, 100vw)', background: '#fff', borderLeft: '1px solid #e5e7eb', boxShadow: '-8px 0 30px rgba(0,0,0,.12)', zIndex: 1200, overflowY: 'auto', padding: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>New hardware pilot</span>
              <button onClick={() => setCreating(false)} style={{ ...btn, border: 'none' }}><X size={16} /></button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={label}>Equipment</label>
                <select style={input} value={form.equipment_id} onChange={set('equipment_id')}>
                  <option value="">not linked</option>
                  {devices.map((d) => <option key={d.id} value={d.id}>{d.equipment_name} ({d.serial_number || d.id})</option>)}
                </select>
              </div>
              <div>
                <label style={label}>Device profile being verified</label>
                <select style={input} value={form.device_profile_id} onChange={set('device_profile_id')}>
                  <option value="">none</option>
                  {profiles.map((p) => <option key={p.id} value={p.id}>{p.profile_code}</option>)}
                </select>
                {!profiles.length && (
                  <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                    No company profile exists yet. Create one in Metric &amp; Device Registry first — a pilot
                    verifies a register map, so there has to be one to verify.
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div><label style={label}>Manufacturer</label><input style={input} value={form.manufacturer} onChange={set('manufacturer')} /></div>
                <div><label style={label}>Model</label><input style={input} value={form.model} onChange={set('model')} /></div>
                <div><label style={label}>Firmware</label><input style={input} value={form.firmware} onChange={set('firmware')} /></div>
                <div><label style={label}>Register map version</label><input style={input} value={form.register_map_ver} onChange={set('register_map_ver')} /></div>
              </div>
              <div><label style={label}>Site</label><input style={input} value={form.site} onChange={set('site')} /></div>
              <div><label style={label}>Reference instrument</label><input style={input} value={form.reference_instrument} onChange={set('reference_instrument')} placeholder="e.g. Fluke 435-II, cal. 2026-03" /></div>
              <div><label style={label}>Engineer</label><input style={input} value={form.engineer_name} onChange={set('engineer_name')} /></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={create} style={{ ...btn, background: '#6B3FDB', color: '#fff', borderColor: '#6B3FDB', padding: '8px 16px' }}>
                  <Save size={13} /> Open pilot
                </button>
                <button onClick={() => setCreating(false)} style={{ ...btn, padding: '8px 16px' }}>Cancel</button>
              </div>
            </div>
          </div>
        </>
      )}

      {openId && (
        <>
          <div onClick={() => setOpenId(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 1199 }} />
          <PilotDetail id={openId} onClose={() => { setOpenId(null); load(); }} onChanged={load} />
        </>
      )}
    </PageShell>
  );
}
