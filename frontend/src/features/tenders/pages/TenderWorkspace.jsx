import { useState, useEffect, useCallback } from 'react';
import {
  Gavel, IndianRupee, CalendarClock, Trophy, FileCheck2, Plus, X, RefreshCw, Check,
} from 'lucide-react';
import api from '@/services/api/client';

const CARD = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 11, padding: 16 };
const TH = { padding: '9px 12px', textAlign: 'left', fontWeight: 600, fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.04em' };
const TD = { padding: '10px 12px', borderBottom: '1px solid #f9f9fb', fontSize: 13 };
const LABEL = { fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4, display: 'block' };
const INPUT = { width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' };
const btn = { cursor: 'pointer', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 8, padding: '7px 12px', fontSize: 13, fontWeight: 600, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 6 };
const btnPri = { ...btn, background: '#6B3FDB', color: '#fff', border: 'none' };
const fmtDate = (v) => v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const fmtINR = (n) => (n == null || n === '') ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const STAGE_COLOR = { bidding: '#6366f1', prospecting: '#6b7280', submitted: '#0891b2', negotiation: '#d97706', won: '#059669', lost: '#dc2626' };
const EMD_COLOR = { paid: '#0891b2', refunded: '#059669', forfeited: '#dc2626', returned: '#059669' };
function Chip({ text, color }) {
  return <span style={{ background: `${color}1a`, color, padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{String(text || '—').replace(/_/g, ' ')}</span>;
}
function Kpi({ icon: Icon, label, value, color }) {
  return (
    <div style={{ ...CARD, flex: 1, minWidth: 150, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: `${color}18`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={19} /></div>
      <div><div style={{ fontSize: 20, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{value}</div><div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{label}</div></div>
    </div>
  );
}

function CreateDrawer({ onClose, onSaved }) {
  const [f, setF] = useState({ opportunity_name: '', tender_number: '', tender_source: '', bid_type: 'open', submission_deadline: '', expected_value: '', emd_amount: '', emd_status: 'paid', stage: 'Bidding', region: '' });
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    if (!f.opportunity_name) { setErr('Tender title is required'); return; }
    setBusy(true); setErr(null);
    try { await api.post('/tenders', f); onSaved(); }
    catch (e) { setErr(e.response?.data?.error || 'Save failed'); } finally { setBusy(false); }
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div style={{ width: 440, maxWidth: '92vw', height: '100%', background: '#fff', padding: 20, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,.12)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>New tender</h2>
          <button onClick={onClose} style={{ ...btn, padding: 6 }}><X size={16} /></button>
        </div>
        {err && <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '8px 10px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'grid', gap: 12 }}>
          <div><label style={LABEL}>Tender title *</label><input style={INPUT} value={f.opportunity_name} onChange={set('opportunity_name')} placeholder="Supply of 400kVAr AHF — TNEB" /></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={LABEL}>Tender no.</label><input style={INPUT} value={f.tender_number} onChange={set('tender_number')} /></div>
            <div><label style={LABEL}>Source / portal</label><input style={INPUT} value={f.tender_source} onChange={set('tender_source')} placeholder="GeM / CPPP / …" /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={LABEL}>Bid type</label><select style={INPUT} value={f.bid_type} onChange={set('bid_type')}>{['open', 'limited', 'single', 'eoi', 'rate_contract'].map((v) => <option key={v} value={v}>{v}</option>)}</select></div>
            <div><label style={LABEL}>Submission deadline</label><input type="date" style={INPUT} value={f.submission_deadline} onChange={set('submission_deadline')} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={LABEL}>Est. value (₹)</label><input type="number" style={INPUT} value={f.expected_value} onChange={set('expected_value')} /></div>
            <div><label style={LABEL}>Region</label><input style={INPUT} value={f.region} onChange={set('region')} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={LABEL}>EMD (₹)</label><input type="number" style={INPUT} value={f.emd_amount} onChange={set('emd_amount')} /></div>
            <div><label style={LABEL}>EMD status</label><select style={INPUT} value={f.emd_status} onChange={set('emd_status')}>{['paid', 'exempt', 'refunded', 'forfeited'].map((v) => <option key={v} value={v}>{v}</option>)}</select></div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}><button style={btnPri} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Create'}</button><button style={btn} onClick={onClose}>Cancel</button></div>
        </div>
      </div>
    </div>
  );
}

function DetailDrawer({ id, onClose, onChange }) {
  const [t, setT] = useState(null);
  const [newDoc, setNewDoc] = useState('');
  const load = useCallback(() => { api.get(`/tenders/${id}`).then(({ data }) => setT(data)).catch(() => setT(null)); }, [id]);
  useEffect(() => { load(); }, [load]);
  const toggleDoc = async (d) => { await api.put(`/tenders/documents/${d.id}`, { status: d.status === 'submitted' ? 'pending' : 'submitted' }); load(); };
  const addDoc = async () => { if (!newDoc.trim()) return; await api.post(`/tenders/${id}/documents`, { doc_name: newDoc.trim() }); setNewDoc(''); load(); onChange?.(); };
  const setEmdRefunded = async () => { await api.put(`/tenders/${id}`, { emd_status: 'refunded', emd_refund_date: new Date().toISOString().slice(0, 10) }); load(); onChange?.(); };

  if (!t) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div style={{ width: 480, maxWidth: '94vw', height: '100%', background: '#fff', padding: 20, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,.12)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{t.opportunity_name}</h2>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.opportunity_number} {t.tender_number ? `· ${t.tender_number}` : ''}</div>
          </div>
          <button onClick={onClose} style={{ ...btn, padding: 6 }}><X size={16} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          <Chip text={t.stage} color={STAGE_COLOR[(t.stage || '').toLowerCase()] || '#6b7280'} />
          {t.loa_received && <Chip text="LOA received" color="#059669" />}
        </div>

        <div style={{ ...CARD, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
            <span style={{ color: '#6b7280' }}>Source</span><b>{t.tender_source || '—'}</b>
            <span style={{ color: '#6b7280' }}>Bid type</span><b style={{ textTransform: 'capitalize' }}>{t.bid_type || '—'}</b>
            <span style={{ color: '#6b7280' }}>Deadline</span><b>{fmtDate(t.submission_deadline)}</b>
            <span style={{ color: '#6b7280' }}>Est. value</span><b>{fmtINR(t.expected_value)}</b>
          </div>
        </div>

        <div style={{ ...CARD, marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>EMD</span>
            {t.emd_amount != null && !t.emd_refund_date && (t.emd_status || '').toLowerCase() !== 'refunded' &&
              <button style={{ ...btn, padding: '4px 10px', fontSize: 12 }} onClick={setEmdRefunded}>Mark refunded</button>}
          </div>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, flexWrap: 'wrap' }}>
            <span>Amount: <b>{fmtINR(t.emd_amount)}</b></span>
            <span>Status: <Chip text={t.emd_status} color={EMD_COLOR[(t.emd_status || '').toLowerCase()] || '#6b7280'} /></span>
            {t.emd_refund_date && <span style={{ color: '#6b7280' }}>Refunded {fmtDate(t.emd_refund_date)}</span>}
          </div>
        </div>

        <div style={CARD}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Document checklist</div>
          {t.documents?.length ? t.documents.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #f7f7f9' }}>
              <button onClick={() => toggleDoc(d)} title="toggle"
                style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${d.status === 'submitted' ? '#059669' : '#d1d5db'}`, background: d.status === 'submitted' ? '#059669' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
                {d.status === 'submitted' && <Check size={12} color="#fff" />}
              </button>
              <span style={{ flex: 1, fontSize: 13, color: d.status === 'submitted' ? '#9ca3af' : '#111827', textDecoration: d.status === 'submitted' ? 'line-through' : 'none' }}>{d.doc_name}</span>
              {d.due_date && <span style={{ fontSize: 11, color: '#9ca3af' }}>{fmtDate(d.due_date)}</span>}
            </div>
          )) : <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 8 }}>No documents yet.</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input style={INPUT} value={newDoc} onChange={(e) => setNewDoc(e.target.value)} placeholder="Add document (e.g. Technical Bid)" onKeyDown={(e) => e.key === 'Enter' && addDoc()} />
            <button style={btn} onClick={addDoc}><Plus size={14} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function TenderWorkspace() {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get('/tenders', { params: search ? { search } : {} }).then(({ data }) => setRows(Array.isArray(data) ? data : [])),
      api.get('/tenders/summary').then(({ data }) => setSummary(data || {})).catch(() => setSummary({})),
    ]).catch(() => {}).finally(() => setLoading(false));
  }, [search]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="pulse-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Gavel size={22} color="#6B3FDB" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>Tender Workspace</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh</button>
          <button onClick={() => setCreating(true)} style={btnPri}><Plus size={14} /> New tender</button>
        </div>
      </div>
      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>
        Government &amp; institutional bids — deadlines, EMD tracking, document checklists, and LOA, over the opportunity pipeline.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Kpi icon={Gavel} label="Active tenders" value={summary.active ?? 0} color="#6B3FDB" />
        <Kpi icon={IndianRupee} label="EMD blocked" value={summary.emd_blocked != null ? fmtINR(summary.emd_blocked) : '—'} color="#d97706" />
        <Kpi icon={CalendarClock} label="Due ≤14d" value={summary.due_soon ?? 0} color="#dc2626" />
        <Kpi icon={Trophy} label="Won" value={summary.won ?? 0} color="#059669" />
        <Kpi icon={FileCheck2} label="LOA received" value={summary.loa_received ?? 0} color="#0891b2" />
      </div>

      <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 12, borderBottom: '1px solid #f0f0f4' }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title or tender number…"
            style={{ width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
            <thead><tr>
              <th style={TH}>Tender</th><th style={TH}>Source</th><th style={TH}>Deadline</th>
              <th style={TH}>EMD</th><th style={TH}>Docs</th><th style={TH}>Value</th><th style={TH}>Stage</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => setSelected(r.id)} style={{ cursor: 'pointer' }}>
                  <td style={TD}>
                    <div style={{ fontWeight: 600, color: '#111827' }}>{r.opportunity_name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.tender_number || r.opportunity_number}{r.company_name ? ` · ${r.company_name}` : ''}</div>
                  </td>
                  <td style={{ ...TD, color: '#6b7280' }}>{r.tender_source || '—'}</td>
                  <td style={{ ...TD, color: r.is_overdue ? '#dc2626' : r.due_soon ? '#d97706' : '#6b7280', fontWeight: r.is_overdue || r.due_soon ? 700 : 400 }}>
                    {fmtDate(r.submission_deadline)}{r.is_overdue ? ' ⚠' : ''}
                  </td>
                  <td style={{ ...TD }}>{r.emd_amount != null ? <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>{fmtINR(r.emd_amount)} <Chip text={r.emd_status} color={EMD_COLOR[(r.emd_status || '').toLowerCase()] || '#6b7280'} /></span> : '—'}</td>
                  <td style={{ ...TD, color: '#6b7280' }}>{r.docs_total ? `${r.docs_submitted}/${r.docs_total}` : '—'}</td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmtINR(r.expected_value)}</td>
                  <td style={TD}><Chip text={r.stage} color={STAGE_COLOR[(r.stage || '').toLowerCase()] || '#6b7280'} /></td>
                </tr>
              ))}
              {!rows.length && !loading && <tr><td style={{ ...TD, textAlign: 'center', color: '#9ca3af' }} colSpan={7}>No tenders yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {creating && <CreateDrawer onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {selected && <DetailDrawer id={selected} onClose={() => setSelected(null)} onChange={load} />}
    </div>
  );
}
