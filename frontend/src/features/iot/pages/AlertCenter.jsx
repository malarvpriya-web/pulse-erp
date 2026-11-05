/**
 * AlertCenter.jsx — fleet-level alert triage.
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * Alerts were only visible one device at a time, inside the Fleet Monitor's
 * detail panel. There was no way to answer "what is broken across the fleet right
 * now", "which incidents have no engineer assigned", or "which of these is
 * covered by an AMC" without opening devices one by one. The alert → service
 * ticket link existed as an integer in a column that nothing displayed, so the
 * chain the business depends on was, in practice, invisible.
 *
 * The right-hand drawer is Alert 360: the observed value against the threshold,
 * the telemetry evidence around the detection window, the state machine's legal
 * next moves, the service ticket with its technician, and the delivery record for
 * the outbox events the incident produced.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  AlertTriangle, RefreshCw, Filter, Ticket, X, Check, ShieldCheck, Clock,
  Activity, Ban, ExternalLink, Bell, Download, ChevronRight,
} from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const SEV = { critical: '#dc2626', warning: '#b45309', info: '#2563eb' };
const STATE_LABEL = {
  pending_confirmation: 'Pending confirmation',
  active: 'Active',
  acknowledged: 'Acknowledged',
  recovery_pending: 'Recovery pending',
  resolved: 'Resolved',
  suppressed: 'Suppressed',
};
const STATE_BG = {
  active: '#fee2e2', acknowledged: '#e0e7ff', recovery_pending: '#fef3c7',
  resolved: '#dcfce7', suppressed: '#f3f4f6', pending_confirmation: '#fef3c7',
};

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '10px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13, verticalAlign: 'top' };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 7, padding: '5px 10px', fontSize: 12, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 5 };

const fmt = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const dur = (secs) => {
  if (secs == null) return '—';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h`;
};

const VIEWS = [
  { key: 'open', label: 'Open' },
  { key: 'critical', label: 'Critical' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'awaiting_service', label: 'Awaiting service' },
  { key: 'acknowledged', label: 'Acknowledged' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
];

function errState(e) {
  if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') return null;
  const status = e?.response?.status;
  if (status === 403) return { kind: 'UNAUTHORIZED', message: e.response?.data?.message || 'You do not have access to IoT alerts.' };
  return { kind: 'ERROR', message: e?.response?.data?.error || e?.message || 'The request failed.', status };
}

// ── Alert 360 drawer ──────────────────────────────────────────────────────────
function AlertDrawer({ id, onClose, onChanged }) {
  const [a, setA] = useState(null);
  const [status, setStatus] = useState('LOADING');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const tokenRef = useRef(0);

  const load = useCallback(() => {
    const t = ++tokenRef.current;
    setStatus('LOADING');
    api.get(`/iot/alerts/${id}`)
      .then(({ data }) => { if (t === tokenRef.current) { setA(data); setStatus('SUCCESS'); } })
      .catch((e) => {
        const err = errState(e);
        if (!err || t !== tokenRef.current) return;
        setError(err); setStatus(err.kind);
      });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const act = async (verb) => {
    setBusy(true);
    try {
      await api.put(`/iot/alerts/${id}/${verb}`, { reason: reason || undefined });
      setReason('');
      load(); onChanged?.();
    } catch (e) {
      const d = e?.response?.data;
      // A refused transition is explained, not swallowed: the API returns which
      // moves are legal from the current state and the drawer shows exactly that.
      setError({
        kind: 'ERROR',
        message: d?.message || d?.error || 'The action failed.',
        allowed: d?.allowed,
      });
    } finally { setBusy(false); }
  };

  const panel = {
    position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(520px, 100vw)',
    background: '#fff', borderLeft: '1px solid #e5e7eb', boxShadow: '-8px 0 30px rgba(0,0,0,.12)',
    zIndex: 1200, overflowY: 'auto', padding: 18,
  };

  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>Alert detail</span>
        <button onClick={onClose} style={{ ...btn, border: 'none' }}><X size={16} /></button>
      </div>

      {status === 'LOADING' && <div style={{ color: '#9ca3af', fontSize: 13 }}>Loading…</div>}
      {(status === 'ERROR' || status === 'UNAUTHORIZED') && (
        <div style={{ ...CARD, borderColor: '#fecaca', background: '#fef2f2', color: '#991b1b', fontSize: 13 }}>
          {error?.message}
        </div>
      )}

      {status === 'SUCCESS' && a && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ background: SEV[a.severity] || '#6b7280', color: '#fff', padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                {a.severity}
              </span>
              <span style={{ background: STATE_BG[a.state] || '#f3f4f6', color: '#374151', padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600 }}>
                {STATE_LABEL[a.state] || a.state}
              </span>
              <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{a.incident_uid || `#${a.id}`}</span>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', marginTop: 8 }}>{a.message}</div>
          </div>

          {/* the measurement, against the rule that judged it */}
          <div style={{ ...CARD, padding: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10, fontSize: 12 }}>
              <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Metric</div><b>{a.metric}</b></div>
              <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Observed</div>
                <b style={{ color: SEV[a.severity] }}>{a.observed_value ?? a.value ?? '—'} {a.unit || ''}</b></div>
              <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Worst</div><b>{a.worst_value ?? '—'}</b></div>
              <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Threshold</div><b>{a.operator} {a.threshold ?? '—'}</b></div>
              <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Clears below</div><b>{a.clear_threshold ?? 'not set'}</b></div>
              <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Breaches</div><b>{a.breach_count}</b></div>
              <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Quality</div><b>{a.quality_code || 'VALID'}</b></div>
              <div><div style={{ color: '#9ca3af', fontSize: 10, textTransform: 'uppercase' }}>Duration</div><b>{dur(a.duration_secs)}</b></div>
            </div>
          </div>

          <div style={{ fontSize: 12, color: '#6b7280', display: 'grid', gap: 4 }}>
            <div>First detected: <b style={{ color: '#374151' }}>{fmt(a.first_detected_at || a.opened_at)}</b></div>
            <div>Last detected: <b style={{ color: '#374151' }}>{fmt(a.last_detected_at)}</b></div>
            {a.acknowledged_at && <div>Acknowledged: <b style={{ color: '#374151' }}>{fmt(a.acknowledged_at)}</b> by {a.acknowledged_by_name || `user ${a.acknowledged_by}`}</div>}
            {a.resolved_at && (
              <div>Resolved: <b style={{ color: '#374151' }}>{fmt(a.resolved_at)}</b>
                {a.resolved_by_name ? ` by ${a.resolved_by_name}` : ''} ({(a.resolution_source || '').replace(/_/g, ' ')})</div>
            )}
            {a.resolution_reason && <div style={{ fontStyle: 'italic' }}>“{a.resolution_reason}”</div>}
          </div>

          {/* equipment + business chain */}
          <div style={{ ...CARD, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Equipment</div>
            <div style={{ fontSize: 13, color: '#111827' }}>{a.equipment_name}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              {a.model_number || '—'} · SN {a.serial_number || 'not recorded'}
              {a.site_location ? ` · ${a.site_location}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
              <a href={`/iot/fleet-monitor?device=${a.equipment_id}`} style={{ ...btn, textDecoration: 'none' }}>
                <Activity size={12} /> Device 360
              </a>
              {a.customer_name && <span style={{ ...btn, cursor: 'default' }}>{a.customer_name}</span>}
              {a.project_name && <span style={{ ...btn, cursor: 'default' }}>{a.project_name}</span>}
              <span style={{ ...btn, cursor: 'default', color: String(a.amc_status).toLowerCase() === 'active' ? '#059669' : '#6b7280' }}>
                <ShieldCheck size={12} /> AMC: {a.amc_status || 'none'}
              </span>
            </div>
          </div>

          {/* the service chain, visible */}
          <div style={{ ...CARD, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Service</div>
            {a.ticket_id ? (
              <div style={{ fontSize: 13 }}>
                <a href={`/servicedesk/tickets?id=${a.ticket_id}`} style={{ color: '#6B3FDB', textDecoration: 'none', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <Ticket size={13} /> {a.ticket_number || `#${a.ticket_id}`} <ExternalLink size={11} />
                </a>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 5, display: 'grid', gap: 3 }}>
                  <div>Status: <b style={{ color: '#374151' }}>{a.ticket_status || '—'}</b> · Priority: <b style={{ color: '#374151' }}>{a.ticket_priority || '—'}</b></div>
                  <div>Technician: <b style={{ color: '#374151' }}>{a.technician_name || 'not assigned'}</b></div>
                  <div>Raised: {fmt(a.ticket_created_at)}{a.ticket_resolved_at ? ` · Resolved: ${fmt(a.ticket_resolved_at)}` : ''}</div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                No service ticket. Tickets are raised automatically for critical incidents on rules that request one.
              </div>
            )}
          </div>

          {/* telemetry evidence */}
          {a.evidence?.length > 0 && (
            <div style={{ ...CARD, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
                Telemetry evidence <span style={{ fontWeight: 400, color: '#9ca3af' }}>({a.evidence.length} samples around the detection window)</span>
              </div>
              <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace' }}>
                {a.evidence.map((e, i) => {
                  const breach = a.threshold != null && (
                    ['>', '>='].includes(a.operator) ? Number(e.value) > Number(a.threshold) : Number(e.value) < Number(a.threshold)
                  );
                  return (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: breach ? '#dc2626' : '#6b7280' }}>
                      <span>{new Date(e.ts).toLocaleTimeString('en-GB')}</span>
                      <span style={{ fontWeight: breach ? 700 : 400 }}>{e.value}</span>
                      <span style={{ color: e.quality_code === 'VALID' ? '#9ca3af' : '#b45309' }}>{e.quality_code}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* notification / ticket delivery — was it actually delivered? */}
          {a.delivery?.length > 0 && (
            <div style={{ ...CARD, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>
                <Bell size={12} style={{ verticalAlign: -2 }} /> Delivery
              </div>
              {a.delivery.map((d, i) => (
                <div key={i} style={{ fontSize: 11, color: d.status === 'dead' ? '#991b1b' : '#6b7280', padding: '2px 0' }}>
                  {d.topic} · <b>{d.status}</b> · {d.attempts} attempt(s)
                  {d.last_error ? ` · ${d.last_error.slice(0, 80)}` : ''}
                </div>
              ))}
            </div>
          )}

          {/* actions, gated by the state machine */}
          <div style={{ ...CARD, padding: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Actions</div>
            {a.allowed_transitions?.length ? (
              <>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recorded on the alert)"
                  style={{ width: '100%', padding: '6px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, marginBottom: 8 }} />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {a.allowed_transitions.includes('acknowledged') && (
                    <button onClick={() => act('ack')} disabled={busy} style={btn}><Check size={12} /> Acknowledge</button>
                  )}
                  {a.allowed_transitions.includes('resolved') && (
                    <button onClick={() => act('resolve')} disabled={busy} style={{ ...btn, color: '#059669', borderColor: '#a7f3d0' }}>
                      <Check size={12} /> Resolve
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                This incident is <b>{STATE_LABEL[a.state] || a.state}</b>. No further transition is permitted —
                a resolved incident is closed; a new breach opens a new incident.
              </div>
            )}
            {error?.allowed && (
              <div style={{ fontSize: 11, color: '#991b1b', marginTop: 8 }}>
                {error.message} Legal next states: {error.allowed.join(', ') || 'none'}.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function AlertCenter() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState('LOADING');
  const [error, setError] = useState(null);
  const [view, setView] = useState('open');
  const [filters, setFilters] = useState({ severity: '', metric: '', amc: '', search: '', from: '', to: '' });
  const [openId, setOpenId] = useState(null);
  const [metrics, setMetrics] = useState([]);
  const tokenRef = useRef(0);

  useEffect(() => {
    api.get('/iot/metrics').then(({ data }) => setMetrics(data.rows || [])).catch(() => setMetrics([]));
    const url = new URL(window.location.href);
    const a = url.searchParams.get('alert');
    if (a) setOpenId(Number(a));
  }, []);

  const load = useCallback(() => {
    const t = ++tokenRef.current;
    setState('LOADING');
    const params = { view, limit: 200 };
    for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
    api.get('/iot/alerts', { params })
      .then(({ data }) => {
        if (t !== tokenRef.current) return;
        setRows(data.rows || []); setTotal(data.total || 0);
        setState((data.rows || []).length ? 'SUCCESS' : 'EMPTY');
      })
      .catch((e) => {
        const err = errState(e);
        if (!err || t !== tokenRef.current) return;
        // NOT setRows([]) — an error is not "no alerts", and on this page in
        // particular "no alerts" is the reassuring answer.
        setError(err); setState(err.kind);
      });
  }, [view, filters]);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  const exportCsv = () => {
    const url = `${api.defaults.baseURL}/iot/export/alerts?days=90`;
    window.open(url, '_blank', 'noopener');
  };

  return (
    <PageShell dock={
      <PageHero
        icon={AlertTriangle}
        eyebrow="IoT"
        title="Alert Centre"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="plh-cta" onClick={load}><RefreshCw size={13} /> Refresh</button>
          </div>
        }
      />
    }>
      <p style={{ margin: '0 0 14px', color: '#6b7280', fontSize: 13 }}>
        Every IoT incident across the fleet, with the service ticket it raised and the engineer working it.
      </p>

      {/* views */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {VIEWS.map((v) => (
          <button key={v.key} onClick={() => setView(v.key)}
            style={{
              ...btn,
              background: view === v.key ? '#6B3FDB' : '#fff',
              color: view === v.key ? '#fff' : '#374151',
              borderColor: view === v.key ? '#6B3FDB' : '#e5e7eb',
            }}>
            {v.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={exportCsv} style={btn} title="Export the last 90 days as CSV">
          <Download size={12} /> Export
        </button>
      </div>

      {/* filters */}
      <div style={{ ...CARD, marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Filter size={14} color="#9ca3af" />
        <input value={filters.search} onChange={set('search')} placeholder="Equipment, serial, ticket…"
          style={{ flex: '1 1 180px', minWidth: 140, padding: '6px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12 }} />
        <select value={filters.severity} onChange={set('severity')} style={{ padding: '6px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12 }}>
          <option value="">Any severity</option>
          <option value="critical">Critical</option><option value="warning">Warning</option><option value="info">Info</option>
        </select>
        <select value={filters.metric} onChange={set('metric')} style={{ padding: '6px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, maxWidth: 190 }}>
          <option value="">Any metric</option>
          {metrics.map((m) => <option key={m.metric_code} value={m.metric_code}>{m.metric_code}</option>)}
        </select>
        <select value={filters.amc} onChange={set('amc')} style={{ padding: '6px 9px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12 }}>
          <option value="">AMC: any</option><option value="true">Under AMC</option><option value="false">Not under AMC</option>
        </select>
        <input type="date" value={filters.from} onChange={set('from')} title="From"
          style={{ padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12 }} />
        <input type="date" value={filters.to} onChange={set('to')} title="To"
          style={{ padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12 }} />
        {Object.values(filters).some(Boolean) && (
          <button onClick={() => setFilters({ severity: '', metric: '', amc: '', search: '', from: '', to: '' })} style={btn}>Clear</button>
        )}
      </div>

      {state === 'LOADING' && <div style={{ ...CARD, color: '#9ca3af', textAlign: 'center', padding: 28 }}>Loading…</div>}

      {(state === 'ERROR' || state === 'UNAUTHORIZED') && (
        <div style={{ ...CARD, borderColor: state === 'UNAUTHORIZED' ? '#fde68a' : '#fecaca', background: state === 'UNAUTHORIZED' ? '#fffbeb' : '#fef2f2' }}>
          <div style={{ display: 'flex', gap: 10 }}>
            {state === 'UNAUTHORIZED' ? <Ban size={18} color="#b45309" /> : <AlertTriangle size={18} color="#dc2626" />}
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: state === 'UNAUTHORIZED' ? '#92400e' : '#991b1b' }}>
                {state === 'UNAUTHORIZED' ? 'Access denied' : 'Alerts could not be loaded'}
              </div>
              <div style={{ fontSize: 12, marginTop: 3, color: state === 'UNAUTHORIZED' ? '#92400e' : '#991b1b' }}>
                {error?.message}{error?.status ? ` (HTTP ${error.status})` : ''}
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 6 }}>
                This is a failure to load, not an all-clear. Do not read it as “no alerts”.
              </div>
            </div>
          </div>
        </div>
      )}

      {state === 'EMPTY' && (
        <div style={{ ...CARD, color: '#6b7280', textAlign: 'center', padding: 28, fontSize: 13 }}>
          No alerts match this view. <span style={{ color: '#9ca3af' }}>(The request succeeded — there is genuinely nothing here.)</span>
        </div>
      )}

      {state === 'SUCCESS' && (
        <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #f0f0f4', fontSize: 11, color: '#6b7280' }}>
            Showing {rows.length} of {total}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead><tr>
                <th style={TH}>Severity</th><th style={TH}>Equipment</th><th style={TH}>Condition</th>
                <th style={TH}>State</th><th style={TH}>Detected</th><th style={TH}>Duration</th>
                <th style={TH}>Service</th><th style={TH} />
              </tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} onClick={() => setOpenId(a.id)} style={{ cursor: 'pointer' }}>
                    <td style={TD}>
                      <span style={{ background: SEV[a.severity] || '#6b7280', color: '#fff', padding: '2px 8px', borderRadius: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase' }}>
                        {a.severity}
                      </span>
                    </td>
                    <td style={TD}>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{a.equipment_name}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>
                        {a.serial_number || '—'}{a.customer_name ? ` · ${a.customer_name}` : ''}
                      </div>
                    </td>
                    <td style={TD}>
                      <div style={{ fontSize: 12 }}>{a.metric}</div>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>
                        {a.observed_value ?? a.value} {a.unit || ''} vs {a.threshold ?? '—'}
                        {a.breach_count > 1 ? ` · ${a.breach_count}×` : ''}
                      </div>
                    </td>
                    <td style={TD}>
                      <span style={{ background: STATE_BG[a.state] || '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 600 }}>
                        {STATE_LABEL[a.state] || a.state}
                      </span>
                    </td>
                    <td style={{ ...TD, whiteSpace: 'nowrap', color: '#6b7280', fontSize: 12 }}>{fmt(a.opened_at)}</td>
                    <td style={{ ...TD, whiteSpace: 'nowrap', color: '#6b7280', fontSize: 12 }}>
                      <Clock size={11} style={{ verticalAlign: -1 }} /> {dur(Number(a.duration_secs))}
                    </td>
                    <td style={TD}>
                      {a.ticket_id ? (
                        <div>
                          <div style={{ fontSize: 12, color: '#6B3FDB', fontWeight: 600 }}>{a.ticket_number || `#${a.ticket_id}`}</div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>
                            {a.ticket_status || '—'} · {a.technician_name || 'unassigned'}
                          </div>
                        </div>
                      ) : <span style={{ color: '#d1d5db', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ ...TD, textAlign: 'right' }}><ChevronRight size={14} color="#d1d5db" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {openId && (
        <>
          <div onClick={() => setOpenId(null)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 1199 }} />
          <AlertDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />
        </>
      )}
    </PageShell>
  );
}
