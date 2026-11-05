/**
 * AlertRules.jsx — operator-facing management of IoT alert rules.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * The rules CRUD API (GET/POST/PUT/DELETE /iot/rules) shipped in Phase 2 with NO
 * caller anywhere in the frontend. Rules could only be created with a direct API
 * call, which in practice meant they were not created at all — and a monitoring
 * system with no thresholds raises no alerts, which is indistinguishable from a
 * healthy fleet.
 *
 * The form deliberately exposes the state-machine parameters rather than hiding
 * them behind a single threshold field, because the difference between a rule
 * that works and a rule that floods a service desk is persistence, hysteresis and
 * cooldown — not the threshold.
 */

import { useState, useEffect, useCallback } from 'react';
import { useRoleCatalog } from '@/config/roleCatalog';
import {
  SlidersHorizontal, Plus, Trash2, RefreshCw, AlertTriangle, Ban, Save, X,
  Power, Info, Wrench, Bell, Mail, MessageSquare, Smartphone,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '10px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13, verticalAlign: 'top' };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };
const input = { width: '100%', padding: '7px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, boxSizing: 'border-box' };
const label = { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.03em', display: 'block', marginBottom: 4 };

const SEV = { critical: '#dc2626', warning: '#b45309', info: '#2563eb' };

const BLANK = {
  name: '', metric: '', operator: '>', threshold: '', clear_threshold: '',
  stale_secs: 900, severity: 'warning', equipment_id: '',
  persistence_secs: 0, recovery_secs: 0, cooldown_secs: 0,
  suppress_in_maintenance: true, create_ticket: true,
  escalation_mins: '', notify_channels: ['in_app'], notify_roles: [],
  active_from: '', active_to: '', quality_policy: 'valid_only', is_active: true,
};

/** A short, plain-language explanation of what a rule will actually do. */
function describeRule(r, unit) {
  if (r.operator === 'stale') {
    return `Raises a ${r.severity} alert when the device has not reported for ${Math.round((r.stale_secs || 900) / 60)} minutes.`;
  }
  const parts = [`Raises a ${r.severity} alert when ${r.metric} is ${r.operator} ${r.threshold}${unit ? ' ' + unit : ''}`];
  if (Number(r.persistence_secs) > 0) parts.push(`held for ${r.persistence_secs}s`);
  parts.push('.');
  if (r.clear_threshold != null && r.clear_threshold !== '') {
    parts.push(` Clears when it returns past ${r.clear_threshold}${unit ? ' ' + unit : ''}`);
    if (Number(r.recovery_secs) > 0) parts.push(` for ${r.recovery_secs}s`);
    parts.push('.');
  } else {
    parts.push(' Clears as soon as the value stops breaching — with no clear threshold a value sitting on the limit can flap.');
  }
  if (Number(r.cooldown_secs) > 0) parts.push(` A new incident cannot open for ${r.cooldown_secs}s after one resolves.`);
  if (r.create_ticket && r.severity === 'critical') parts.push(' Raises a service ticket.');
  return parts.join('');
}

export default function AlertRules() {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState('LOADING');
  const [error, setError] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const [devices, setDevices] = useState([]);
  const [channels, setChannels] = useState(null);
  const roles = useRoleCatalog();
  const [editing, setEditing] = useState(null);      // null | {} for new | row for edit
  const [form, setForm] = useState(BLANK);
  const [saveError, setSaveError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setState('LOADING');
    api.get('/iot/rules')
      .then(({ data }) => { setRows(data.rows || []); setState((data.rows || []).length ? 'SUCCESS' : 'EMPTY'); })
      .catch((e) => {
        const status = e?.response?.status;
        setError({ message: e?.response?.data?.message || e?.response?.data?.error || e.message, status });
        setState(status === 403 ? 'UNAUTHORIZED' : 'ERROR');
      });
  }, []);

  useEffect(() => {
    load();
    api.get('/iot/metrics').then(({ data }) => setMetrics(data.rows || [])).catch(() => setMetrics([]));
    api.get('/iot/devices', { params: { limit: 300 } })
      .then(({ data }) => setDevices(data.rows || [])).catch(() => setDevices([]));
    // Which channels this deployment can ACTUALLY deliver. The editor offers a
    // channel only when its provider is configured, so a switch never silently
    // does nothing — which is exactly what email/SMS did before 2026-09-15.
    api.get('/iot/notification-channels')
      .then(({ data }) => setChannels(data.channels || null)).catch(() => setChannels(null));
    // Roles come from useRoleCatalog() below, not from a fetch here. This used
    // to call GET /roles, which does not exist: it 404'd on every mount and the
    // picker fell back to four hardcoded codes, so 22 of the 26 real roles could
    // never be chosen as an escalation target — with no error shown anywhere.
    // roleCatalog.js is the single registry every role dropdown reads; this
    // screen was the one that did not.
  }, [load]);

  const metricDef = metrics.find((m) => m.metric_code === form.metric);

  const openNew = () => { setForm(BLANK); setEditing({}); setSaveError(null); };
  const openEdit = (r) => {
    setForm({
      ...BLANK, ...r,
      threshold: r.threshold ?? '', clear_threshold: r.clear_threshold ?? '',
      equipment_id: r.equipment_id ?? '', escalation_mins: r.escalation_mins ?? '',
      active_from: r.active_from ?? '', active_to: r.active_to ?? '',
    });
    setEditing(r); setSaveError(null);
  };

  const save = async () => {
    setBusy(true); setSaveError(null);
    const body = {
      ...form,
      threshold: form.operator === 'stale' ? null : Number(form.threshold),
      clear_threshold: form.clear_threshold === '' ? null : Number(form.clear_threshold),
      equipment_id: form.equipment_id === '' ? null : Number(form.equipment_id),
      escalation_mins: form.escalation_mins === '' ? null : Number(form.escalation_mins),
      active_from: form.active_from || null,
      active_to: form.active_to || null,
      persistence_secs: Number(form.persistence_secs) || 0,
      recovery_secs: Number(form.recovery_secs) || 0,
      cooldown_secs: Number(form.cooldown_secs) || 0,
    };
    try {
      if (editing?.id) await api.put(`/iot/rules/${editing.id}`, body);
      else await api.post('/iot/rules', body);
      setEditing(null); load();
    } catch (e) {
      // The API validates hysteresis direction and metric existence and returns a
      // specific message; showing it verbatim is more useful than "save failed".
      setSaveError(e?.response?.data?.error || e?.message || 'Save failed.');
    } finally { setBusy(false); }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete the rule "${r.name}"? Any open incidents it raised stay in the Alert Centre.`)) return;
    try { await api.delete(`/iot/rules/${r.id}`); load(); }
    catch (e) { setError({ message: e?.response?.data?.error || e.message }); }
  };

  const toggle = async (r) => {
    try { await api.put(`/iot/rules/${r.id}`, { is_active: !r.is_active }); load(); }
    catch (e) { setError({ message: e?.response?.data?.error || e.message }); }
  };

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  return (
    <PageShell dock={
      <PageHero
        icon={SlidersHorizontal}
        eyebrow="IoT"
        title="Alert Rules"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="plh-cta" onClick={openNew}><Plus size={13} /> New rule</button>
            <button className="plh-cta" onClick={load}><RefreshCw size={13} /> Refresh</button>
          </div>
        }
      />
    }>
      <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: 13 }}>
        The thresholds that decide when telemetry becomes an incident. A fleet with no rules raises no alerts —
        which looks exactly like a healthy fleet.
      </p>

      {state === 'LOADING' && <div style={{ ...CARD, color: '#9ca3af', textAlign: 'center', padding: 28 }}>Loading…</div>}

      {(state === 'ERROR' || state === 'UNAUTHORIZED') && (
        <div style={{ ...CARD, borderColor: '#fecaca', background: '#fef2f2', display: 'flex', gap: 10 }}>
          {state === 'UNAUTHORIZED' ? <Ban size={18} color="#b45309" /> : <AlertTriangle size={18} color="#dc2626" />}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: '#991b1b' }}>
              {state === 'UNAUTHORIZED' ? 'Access denied' : 'Rules could not be loaded'}
            </div>
            <div style={{ fontSize: 12, color: '#991b1b', marginTop: 3 }}>{error?.message}</div>
          </div>
        </div>
      )}

      {state === 'EMPTY' && (
        <div style={{ ...CARD, textAlign: 'center', padding: 30 }}>
          <AlertTriangle size={26} color="#b45309" style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>No alert rules are configured</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6, maxWidth: 480, margin: '6px auto 0' }}>
            Telemetry is being stored, but nothing is watching it. Until at least one rule exists, no incident
            can be raised and no service ticket can be created from a device condition.
          </div>
          <button onClick={openNew} style={{ ...btn, marginTop: 14, padding: '7px 14px' }}><Plus size={13} /> Create the first rule</button>
        </div>
      )}

      {state === 'SUCCESS' && (
        <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead><tr>
                <th style={TH}>Rule</th><th style={TH}>Applies to</th><th style={TH}>Condition</th>
                <th style={TH}>Timing</th><th style={TH}>Severity</th><th style={TH}>Live</th><th style={TH} />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ opacity: r.is_active ? 1 : 0.55 }}>
                    <td style={TD}>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>
                        {r.metric_name || r.metric}
                        {r.create_ticket ? ' · raises a ticket' : ' · no ticket'}
                        {r.suppress_in_maintenance ? ' · suppressed in maintenance' : ''}
                      </div>
                    </td>
                    <td style={{ ...TD, fontSize: 12 }}>
                      {r.equipment_id
                        ? <>{r.equipment_name}<div style={{ fontSize: 11, color: '#9ca3af' }}>{r.serial_number}</div></>
                        : <span style={{ color: '#6b7280' }}>Every device in the company</span>}
                    </td>
                    <td style={{ ...TD, fontSize: 12, fontFamily: 'monospace' }}>
                      {r.operator === 'stale'
                        ? `silent > ${Math.round((r.stale_secs || 900) / 60)}m`
                        : <>
                            {r.metric} {r.operator} {r.threshold}{r.unit ? ` ${r.unit}` : ''}
                            {r.clear_threshold != null && (
                              <div style={{ color: '#059669' }}>clears at {r.clear_threshold}</div>
                            )}
                            {r.clear_threshold == null && (
                              <div style={{ color: '#b45309', fontFamily: 'inherit', fontSize: 11 }}>no hysteresis</div>
                            )}
                          </>}
                    </td>
                    <td style={{ ...TD, fontSize: 11, color: '#6b7280' }}>
                      <div>hold {r.persistence_secs}s</div>
                      <div>recover {r.recovery_secs}s</div>
                      <div>cooldown {r.cooldown_secs}s</div>
                    </td>
                    <td style={TD}>
                      <span style={{ background: SEV[r.severity] || '#6b7280', color: '#fff', padding: '2px 8px', borderRadius: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                        {r.severity}
                      </span>
                    </td>
                    <td style={TD}>
                      {r.live_alerts > 0
                        ? <a href={`/iot/alert-center`} style={{ color: '#dc2626', fontWeight: 700, textDecoration: 'none' }}>{r.live_alerts}</a>
                        : <span style={{ color: '#d1d5db' }}>0</span>}
                    </td>
                    <td style={{ ...TD, whiteSpace: 'nowrap' }}>
                      <button onClick={() => toggle(r)} style={{ ...btn, marginRight: 6 }} title={r.is_active ? 'Disable' : 'Enable'}>
                        <Power size={12} color={r.is_active ? '#059669' : '#9ca3af'} />
                      </button>
                      <button onClick={() => openEdit(r)} style={{ ...btn, marginRight: 6 }}>Edit</button>
                      <button onClick={() => remove(r)} style={{ ...btn, color: '#991b1b', borderColor: '#fecaca' }}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* editor */}
      {editing && (
        <>
          <div onClick={() => setEditing(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 1199 }} />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(560px, 100vw)', background: '#fff',
            borderLeft: '1px solid #e5e7eb', boxShadow: '-8px 0 30px rgba(0,0,0,.12)', zIndex: 1200,
            overflowY: 'auto', padding: 18,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{editing.id ? 'Edit rule' : 'New rule'}</span>
              <button onClick={() => setEditing(null)} style={{ ...btn, border: 'none' }}><X size={16} /></button>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <label style={label}>Rule name</label>
                <input style={input} value={form.name} onChange={set('name')} placeholder="e.g. AHF current THD critical" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={label}>Metric</label>
                  <select style={input} value={form.metric} onChange={set('metric')}>
                    <option value="">Select a metric…</option>
                    {metrics.map((m) => (
                      <option key={m.metric_code} value={m.metric_code}>
                        {m.metric_code} — {m.display_name} ({m.unit})
                      </option>
                    ))}
                  </select>
                  {metricDef && (
                    <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                      Valid range {metricDef.min_physical ?? '−∞'} to {metricDef.max_physical ?? '∞'} {metricDef.unit}
                      {metricDef.rising_is_bad ? ' · rising is degradation' : ''}
                    </div>
                  )}
                </div>
                <div>
                  <label style={label}>Applies to</label>
                  <select style={input} value={form.equipment_id} onChange={set('equipment_id')}>
                    <option value="">Every device in the company</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>{d.equipment_name} ({d.serial_number || d.id})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 10 }}>
                <div>
                  <label style={label}>Operator</label>
                  <select style={input} value={form.operator} onChange={set('operator')}>
                    {['>', '>=', '<', '<=', '=', 'stale'].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                {form.operator === 'stale' ? (
                  <div style={{ gridColumn: 'span 2' }}>
                    <label style={label}>Silent for (seconds)</label>
                    <input style={input} type="number" value={form.stale_secs} onChange={set('stale_secs')} />
                  </div>
                ) : (
                  <>
                    <div>
                      <label style={label}>Trigger threshold</label>
                      <input style={input} type="number" step="any" value={form.threshold} onChange={set('threshold')} />
                    </div>
                    <div>
                      <label style={label}>Clear threshold (hysteresis)</label>
                      <input style={input} type="number" step="any" value={form.clear_threshold} onChange={set('clear_threshold')}
                        placeholder="optional but recommended" />
                    </div>
                  </>
                )}
              </div>

              {form.operator !== 'stale' && !form.clear_threshold && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 10, fontSize: 11, color: '#92400e', display: 'flex', gap: 8 }}>
                  <Info size={14} style={{ flex: 'none', marginTop: 1 }} />
                  <span>
                    Without a clear threshold the incident resolves the instant the value stops breaching. A metric
                    sitting on the limit will then open and close repeatedly. Set a clear threshold on the safe side
                    of the trigger to give it a dead band.
                  </span>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                <div>
                  <label style={label}>Hold for (s)</label>
                  <input style={input} type="number" value={form.persistence_secs} onChange={set('persistence_secs')} />
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>Ignores a single noisy sample</div>
                </div>
                <div>
                  <label style={label}>Recovery hold (s)</label>
                  <input style={input} type="number" value={form.recovery_secs} onChange={set('recovery_secs')} />
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>Must stay clear this long</div>
                </div>
                <div>
                  <label style={label}>Cooldown (s)</label>
                  <input style={input} type="number" value={form.cooldown_secs} onChange={set('cooldown_secs')} />
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>Blocks an immediate re-open</div>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={label}>Severity</label>
                  <select style={input} value={form.severity} onChange={set('severity')}>
                    <option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
                  </select>
                </div>
                <div>
                  <label style={label}>Escalate if unacknowledged (min)</label>
                  <input style={input} type="number" value={form.escalation_mins} onChange={set('escalation_mins')} placeholder="never" />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={label}>Active from (optional)</label>
                  <input style={input} type="time" value={form.active_from || ''} onChange={set('active_from')} />
                </div>
                <div>
                  <label style={label}>Active to (optional)</label>
                  <input style={input} type="time" value={form.active_to || ''} onChange={set('active_to')} />
                </div>
              </div>

              <div>
                <label style={label}>Quality policy</label>
                <select style={input} value={form.quality_policy} onChange={set('quality_policy')}>
                  <option value="valid_only">Only VALID samples (recommended)</option>
                  <option value="include_suspect">VALID and SUSPECT samples</option>
                </select>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                  Which telemetry this rule is allowed to judge. Communication errors and out-of-range readings never count.
                </div>
              </div>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!form.create_ticket} onChange={set('create_ticket')} />
                  Raise a service ticket (critical only)
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!form.suppress_in_maintenance} onChange={set('suppress_in_maintenance')} />
                  <Wrench size={12} /> Suppress during maintenance
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!form.is_active} onChange={set('is_active')} />
                  Active
                </label>
              </div>

              {/* plain-language preview, so the operator sees what they built */}
              {form.metric && (form.threshold !== '' || form.operator === 'stale') && (
                <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 8, padding: 11, fontSize: 12, color: '#4c1d95' }}>
                  <b>This rule will:</b> {describeRule(form, metricDef?.unit)}
                </div>
              )}

              {saveError && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10, fontSize: 12, color: '#991b1b' }}>
                  {saveError}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={save} disabled={busy} style={{ ...btn, background: '#6B3FDB', color: '#fff', borderColor: '#6B3FDB', padding: '8px 16px' }}>
                  <Save size={13} /> {busy ? 'Saving…' : 'Save rule'}
                </button>
                <button onClick={() => setEditing(null)} style={{ ...btn, padding: '8px 16px' }}>Cancel</button>
              </div>

              {/* Notification delivery — every channel here is wired to a real
                  sender. One that this deployment cannot use is shown disabled
                  with the reason, rather than being offered and silently ignored. */}
              <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
                <label style={label}>Notify on</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    { key: 'in_app', label: 'In-app', Icon: Bell },
                    { key: 'email', label: 'Email', Icon: Mail },
                    { key: 'sms', label: 'SMS', Icon: MessageSquare },
                    { key: 'push', label: 'Push', Icon: Smartphone },
                  ].map(({ key, label: chLabel, Icon }) => {
                    const info = channels?.[key];
                    const available = info ? info.available : key === 'in_app';
                    const on = (form.notify_channels || []).includes(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        disabled={!available}
                        title={info?.note || ''}
                        onClick={() => setForm((f) => {
                          const cur = new Set(f.notify_channels || []);
                          if (cur.has(key)) cur.delete(key); else cur.add(key);
                          cur.add('in_app');   // in-app always stays, so an alert is never fully silent
                          return { ...f, notify_channels: [...cur] };
                        })}
                        style={{
                          ...btn,
                          cursor: available ? 'pointer' : 'not-allowed',
                          opacity: available ? 1 : 0.45,
                          background: on && available ? '#f5f3ff' : '#fff',
                          borderColor: on && available ? '#ddd6fe' : '#e5e7eb',
                          color: on && available ? '#5b21b6' : '#374151',
                        }}>
                        <Icon size={12} /> {chLabel}
                        {!available && <span style={{ fontSize: 9, color: '#9ca3af' }}>(not configured)</span>}
                      </button>
                    );
                  })}
                </div>
                {channels && Object.entries(channels).filter(([, v]) => !v.available).length > 0 && (
                  <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 6 }}>
                    {Object.entries(channels).filter(([, v]) => !v.available)
                      .map(([k, v]) => `${k}: ${v.note}`).join(' · ')}
                  </div>
                )}
              </div>

              <div>
                <label style={label}>Notify these roles</label>
                <select multiple size={4} style={{ ...input, height: 'auto', fontSize: 12 }}
                  disabled={!roles.length}
                  value={form.notify_roles || []}
                  onChange={(e) => setForm((f) => ({ ...f, notify_roles: [...e.target.selectedOptions].map((o) => o.value) }))}>
                  {roles.map((r) => (
                    <option key={r.code || r} value={r.code || r}>{r.label || r.code || r}</option>
                  ))}
                </select>
                <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3 }}>
                  Roles are many-to-many, so anyone holding one of these is reached. With none selected the
                  company's own policy for this event decides the recipients; if that matches nobody, the
                  delivery log records "no recipients" rather than reporting a successful send.
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
