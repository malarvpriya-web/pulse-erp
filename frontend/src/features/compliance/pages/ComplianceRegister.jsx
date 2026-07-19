import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ShieldCheck, AlertTriangle, Clock, CalendarClock, RefreshCw, Plus, X, FileCheck2,
} from 'lucide-react';
import api from '@/services/api/client';

const STATUS_META = {
  certified:   { label: 'Certified',   bg: '#dcfce7', color: '#15803d' },
  in_progress: { label: 'In Progress', bg: '#ede9fe', color: '#4f46e5' },
  not_started: { label: 'Not Started', bg: '#f3f4f6', color: '#6b7280' },
  expired:     { label: 'Expired',     bg: '#fee2e2', color: '#dc2626' },
  lapsed:      { label: 'Lapsed',      bg: '#fef3c7', color: '#92400e' },
};
const CATEGORY_LABEL = { management_system: 'Management System', product: 'Product', regulatory: 'Regulatory' };
const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '9px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '10px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13 };
const LABEL = { fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, display: 'block' };
const INPUT = { width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 6 };
const btnPrimary = { ...btn, background: '#6B3FDB', color: '#fff', border: 'none' };

const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

function Pill({ status }) {
  const m = STATUS_META[status] || STATUS_META.not_started;
  return <span style={{ background: m.bg, color: m.color, padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>{m.label}</span>;
}

function Kpi({ icon: Icon, label, value, color }) {
  return (
    <div style={{ ...CARD, flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: `${color}18`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={19} /></div>
      <div><div style={{ fontSize: 21, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{value}</div><div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{label}</div></div>
    </div>
  );
}

const EMPTY = { code: '', title: '', category: 'management_system', status: 'not_started', certifying_body: '', certificate_number: '', issue_date: '', expiry_date: '', owner_name: '', notes: '' };

function StandardDrawer({ item, onClose, onSaved }) {
  const [f, setF] = useState(item?.id ? { ...EMPTY, ...item, issue_date: item.issue_date?.slice(0, 10) || '', expiry_date: item.expiry_date?.slice(0, 10) || '' } : EMPTY);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    if (!f.code || !f.title) { setErr('Code and title are required'); return; }
    setBusy(true); setErr(null);
    try {
      if (item?.id) await api.put(`/compliance/standards/${item.id}`, f);
      else await api.post('/compliance/standards', f);
      onSaved();
    } catch (e) { setErr(e.response?.data?.error || 'Save failed'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div style={{ width: 440, maxWidth: '92vw', height: '100%', background: '#fff', padding: 20, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,.12)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{item?.id ? 'Edit standard' : 'Add standard'}</h2>
          <button onClick={onClose} style={{ ...btn, padding: 6 }}><X size={16} /></button>
        </div>
        {err && <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '8px 10px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={LABEL}>Code *</label><input style={INPUT} value={f.code} onChange={set('code')} placeholder="ISO 14001" /></div>
            <div><label style={LABEL}>Category</label>
              <select style={INPUT} value={f.category} onChange={set('category')}>
                {Object.entries(CATEGORY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div><label style={LABEL}>Title *</label><input style={INPUT} value={f.title} onChange={set('title')} placeholder="Environmental Management System" /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={LABEL}>Status</label>
              <select style={INPUT} value={f.status} onChange={set('status')}>
                {Object.keys(STATUS_META).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
              </select>
            </div>
            <div><label style={LABEL}>Owner</label><input style={INPUT} value={f.owner_name || ''} onChange={set('owner_name')} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={LABEL}>Certifying body</label><input style={INPUT} value={f.certifying_body || ''} onChange={set('certifying_body')} placeholder="TÜV / BIS / …" /></div>
            <div><label style={LABEL}>Certificate #</label><input style={INPUT} value={f.certificate_number || ''} onChange={set('certificate_number')} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={LABEL}>Issue date</label><input type="date" style={INPUT} value={f.issue_date || ''} onChange={set('issue_date')} /></div>
            <div><label style={LABEL}>Expiry date</label><input type="date" style={INPUT} value={f.expiry_date || ''} onChange={set('expiry_date')} /></div>
          </div>
          <div><label style={LABEL}>Notes</label><textarea style={{ ...INPUT, minHeight: 60 }} value={f.notes || ''} onChange={set('notes')} /></div>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button style={btnPrimary} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button style={btn} onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ComplianceRegister() {
  const [standards, setStandards] = useState([]);
  const [audits, setAudits] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState(null); // {} for new, {..} for edit, null closed
  const [catFilter, setCatFilter] = useState('all');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/compliance/standards').then(({ data }) => setStandards(Array.isArray(data) ? data : [])),
      api.get('/compliance/audits', { params: { upcoming: 1 } }).then(({ data }) => setAudits(Array.isArray(data) ? data : [])).catch(() => setAudits([])),
      api.get('/compliance/summary').then(({ data }) => setSummary(data || {})).catch(() => setSummary({})),
    ]).catch(() => {}).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => catFilter === 'all' ? standards : standards.filter((s) => s.category === catFilter), [standards, catFilter]);

  return (
    <div className="pulse-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <ShieldCheck size={22} color="#6B3FDB" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>Compliance Register</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh</button>
          <button onClick={() => setDrawer({})} style={btnPrimary}><Plus size={14} /> Add standard</button>
        </div>
      </div>
      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>
        Certifications and standards the company holds — ISO, IEC, IEEE, BIS, RoHS, CE, UL — with status, evidence, and the audit calendar.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Kpi icon={ShieldCheck} label="Certified" value={summary.certified ?? 0} color="#059669" />
        <Kpi icon={Clock} label="In progress" value={summary.in_progress ?? 0} color="#6B3FDB" />
        <Kpi icon={CalendarClock} label="Expiring ≤90d" value={summary.expiring_soon ?? 0} color="#d97706" />
        <Kpi icon={AlertTriangle} label="Expired" value={summary.expired ?? 0} color="#dc2626" />
        <Kpi icon={AlertTriangle} label="Overdue audits" value={summary.overdue_audits ?? 0} color="#dc2626" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        {/* register */}
        <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: 12, borderBottom: '1px solid #f0f0f4', display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Category:</span>
            {['all', 'management_system', 'product', 'regulatory'].map((c) => (
              <button key={c} onClick={() => setCatFilter(c)}
                style={{ ...btn, padding: '4px 10px', fontSize: 12, ...(catFilter === c ? { background: '#f5f2ff', borderColor: '#6B3FDB', color: '#6B3FDB' } : {}) }}>
                {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
              </button>
            ))}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead><tr>
                <th style={TH}>Standard</th><th style={TH}>Category</th><th style={TH}>Status</th>
                <th style={TH}>Expiry</th><th style={TH}>Evidence</th><th style={TH}>Next audit</th>
              </tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} onClick={() => setDrawer(s)} style={{ cursor: 'pointer' }}>
                    <td style={TD}>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{s.code}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.title}</div>
                    </td>
                    <td style={{ ...TD, color: '#6b7280' }}>{CATEGORY_LABEL[s.category] || s.category}</td>
                    <td style={TD}><Pill status={s.is_expired && s.status === 'certified' ? 'expired' : s.status} /></td>
                    <td style={{ ...TD, color: s.is_expired ? '#dc2626' : s.expiring_soon ? '#d97706' : '#6b7280', fontWeight: s.is_expired || s.expiring_soon ? 700 : 400 }}>
                      {fmtDate(s.expiry_date)}
                    </td>
                    <td style={{ ...TD, color: '#6b7280' }}>{s.evidence_count > 0 ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FileCheck2 size={13} />{s.evidence_count}</span> : '—'}</td>
                    <td style={{ ...TD, color: '#6b7280' }}>{fmtDate(s.next_audit_date)}</td>
                  </tr>
                ))}
                {!rows.length && !loading && <tr><td style={{ ...TD, textAlign: 'center', color: '#9ca3af' }} colSpan={6}>No standards.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {/* audit calendar */}
        <div style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <CalendarClock size={15} color="#6B3FDB" />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Upcoming audits</span>
          </div>
          {audits.length ? audits.map((a) => (
            <div key={a.id} style={{ padding: '8px 0', borderBottom: '1px solid #f7f7f9' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#111827' }}>{a.standard_code || a.title || 'Audit'}</span>
                <span style={{ fontSize: 12, color: a.is_overdue ? '#dc2626' : '#6b7280', fontWeight: a.is_overdue ? 700 : 400 }}>{fmtDate(a.scheduled_date)}</span>
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'capitalize' }}>{a.audit_type}{a.auditor ? ` · ${a.auditor}` : ''}</div>
            </div>
          )) : <div style={{ color: '#9ca3af', fontSize: 13 }}>No upcoming audits scheduled.</div>}
        </div>
      </div>

      {drawer !== null && <StandardDrawer item={drawer} onClose={() => setDrawer(null)} onSaved={() => { setDrawer(null); load(); }} />}
    </div>
  );
}
