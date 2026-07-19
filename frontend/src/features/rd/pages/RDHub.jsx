import { useState, useEffect, useCallback } from 'react';
import {
  FlaskConical, Cpu, FileBadge, GitBranch, Plus, X, RefreshCw, CircuitBoard, Package,
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

const ART_STATUS = { draft: '#6b7280', in_review: '#d97706', released: '#059669', superseded: '#9ca3af', obsolete: '#dc2626' };
const ART_TYPE = { pcb: 'PCB', firmware: 'Firmware', software: 'Software', schematic: 'Schematic', mechanical: 'Mechanical', document: 'Document' };
const PAT_STATUS = { idea: '#6b7280', drafting: '#6366f1', filed: '#0369a1', published: '#0891b2', granted: '#059669', rejected: '#dc2626', lapsed: '#d97706', abandoned: '#9ca3af' };
const STAGE_COLOR = { concept: '#6b7280', design: '#6366f1', prototype: '#8b5cf6', validation: '#0891b2', production: '#059669', maintenance: '#d97706', eol: '#dc2626' };

function Chip({ text, color }) {
  return <span style={{ background: `${color}1a`, color, padding: '2px 9px', borderRadius: 9, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{String(text || '—').replace(/_/g, ' ')}</span>;
}
function Kpi({ icon: Icon, label, value, color }) {
  return (
    <div style={{ ...CARD, flex: 1, minWidth: 140, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 38, height: 38, borderRadius: 10, background: `${color}18`, color, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon size={19} /></div>
      <div><div style={{ fontSize: 20, fontWeight: 700, color: '#111827', lineHeight: 1 }}>{value}</div><div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{label}</div></div>
    </div>
  );
}

function Drawer({ title, onClose, children }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.35)', zIndex: 50, display: 'flex', justifyContent: 'flex-end' }} onClick={onClose}>
      <div style={{ width: 440, maxWidth: '92vw', height: '100%', background: '#fff', padding: 20, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,.12)' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{title}</h2>
          <button onClick={onClose} style={{ ...btn, padding: 6 }}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function RDHub() {
  const [tab, setTab] = useState('repository');
  const [summary, setSummary] = useState({});
  const [productLines, setProductLines] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadSummary = useCallback(() => {
    api.get('/rd/summary').then(({ data }) => setSummary(data || {})).catch(() => setSummary({}));
    api.get('/rd/lifecycle').then(({ data }) => setProductLines(data.data || [])).catch(() => {});
  }, []);
  useEffect(() => { loadSummary(); }, [loadSummary]);

  return (
    <div className="pulse-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <FlaskConical size={22} color="#6B3FDB" />
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>R&amp;D</h1>
        <button onClick={loadSummary} style={{ ...btn, marginLeft: 'auto' }}><RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh</button>
      </div>
      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>
        Versioned design repository, patents &amp; IP, and the product lifecycle (PLM) across product lines.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Kpi icon={CircuitBoard} label="Artifact families" value={summary.artifacts?.families ?? 0} color="#6B3FDB" />
        <Kpi icon={Package} label="Released versions" value={summary.artifacts?.released ?? 0} color="#059669" />
        <Kpi icon={FileBadge} label="Patents granted" value={summary.patents?.granted ?? 0} color="#0891b2" />
        <Kpi icon={GitBranch} label="In production" value={summary.lifecycle?.in_production ?? 0} color="#d97706" />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid #eee' }}>
        {[['repository', 'Repository', Cpu], ['patents', 'Patents & IP', FileBadge], ['lifecycle', 'Product Lifecycle', GitBranch]].map(([k, l, Ic]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ cursor: 'pointer', border: 'none', background: 'none', padding: '8px 14px', fontSize: 13, fontWeight: 600,
              color: tab === k ? '#6B3FDB' : '#6b7280', borderBottom: tab === k ? '2px solid #6B3FDB' : '2px solid transparent', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Ic size={15} /> {l}
          </button>
        ))}
      </div>

      {tab === 'repository' && <Repository productLines={productLines} onChange={loadSummary} />}
      {tab === 'patents' && <Patents productLines={productLines} onChange={loadSummary} />}
      {tab === 'lifecycle' && <Lifecycle rows={productLines} onChange={loadSummary} />}
    </div>
  );
}

// ── Repository ────────────────────────────────────────────────────────────────
function Repository({ productLines, onChange }) {
  const [rows, setRows] = useState([]);
  const [typeF, setTypeF] = useState('all');
  const [drawer, setDrawer] = useState(false);
  const load = useCallback(() => {
    api.get('/rd/artifacts').then(({ data }) => setRows(Array.isArray(data) ? data : [])).catch(() => setRows([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  const shown = typeF === 'all' ? rows : rows.filter((r) => r.artifact_type === typeF);

  return (
    <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 12, borderBottom: '1px solid #f0f0f4', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select style={{ ...INPUT, width: 'auto' }} value={typeF} onChange={(e) => setTypeF(e.target.value)}>
          <option value="all">All types</option>
          {Object.entries(ART_TYPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button style={{ ...btnPri, marginLeft: 'auto' }} onClick={() => setDrawer(true)}><Plus size={14} /> New artifact / version</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
          <thead><tr><th style={TH}>Artifact</th><th style={TH}>Type</th><th style={TH}>Product line</th><th style={TH}>Latest</th><th style={TH}>Status</th><th style={TH}>Versions</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td style={TD}><div style={{ fontWeight: 600, color: '#111827' }}>{r.name}</div>{r.description && <div style={{ fontSize: 11, color: '#9ca3af' }}>{r.description}</div>}</td>
                <td style={TD}><Chip text={ART_TYPE[r.artifact_type] || r.artifact_type} color="#6366f1" /></td>
                <td style={{ ...TD, color: '#6b7280' }}>{r.product_line || '—'}</td>
                <td style={{ ...TD, fontWeight: 600 }}>{r.version}</td>
                <td style={TD}><Chip text={r.status} color={ART_STATUS[r.status] || '#6b7280'} /></td>
                <td style={{ ...TD, color: '#6b7280' }}>{r.version_count}</td>
              </tr>
            ))}
            {!shown.length && <tr><td style={{ ...TD, textAlign: 'center', color: '#9ca3af' }} colSpan={6}>No artifacts yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {drawer && <ArtifactDrawer productLines={productLines} onClose={() => setDrawer(false)} onSaved={() => { setDrawer(false); load(); onChange(); }} />}
    </div>
  );
}

function ArtifactDrawer({ productLines, onClose, onSaved }) {
  const [f, setF] = useState({ artifact_type: 'pcb', name: '', version: '', status: 'draft', product_line_id: '', file_url: '', description: '' });
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    if (!f.name) { setErr('Name is required'); return; }
    setBusy(true); setErr(null);
    try { await api.post('/rd/artifacts', { ...f, product_line_id: f.product_line_id || null, version: f.version || undefined }); onSaved(); }
    catch (e) { setErr(e.response?.data?.error || 'Save failed'); } finally { setBusy(false); }
  };
  return (
    <Drawer title="New artifact / version" onClose={onClose}>
      {err && <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '8px 10px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{err}</div>}
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={LABEL}>Type</label><select style={INPUT} value={f.artifact_type} onChange={set('artifact_type')}>{Object.entries(ART_TYPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          <div><label style={LABEL}>Version</label><input style={INPUT} value={f.version} onChange={set('version')} placeholder="auto (v1, v2…)" /></div>
        </div>
        <div><label style={LABEL}>Name *</label><input style={INPUT} value={f.name} onChange={set('name')} placeholder="AHF Control Board" /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={LABEL}>Product line</label><select style={INPUT} value={f.product_line_id} onChange={set('product_line_id')}><option value="">—</option>{productLines.map((p) => <option key={p.product_line_id} value={p.product_line_id}>{p.product_line}</option>)}</select></div>
          <div><label style={LABEL}>Status</label><select style={INPUT} value={f.status} onChange={set('status')}>{Object.keys(ART_STATUS).map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        </div>
        <div><label style={LABEL}>File URL</label><input style={INPUT} value={f.file_url} onChange={set('file_url')} placeholder="link to design file" /></div>
        <div><label style={LABEL}>Description</label><textarea style={{ ...INPUT, minHeight: 56 }} value={f.description} onChange={set('description')} /></div>
        <div style={{ display: 'flex', gap: 10 }}><button style={btnPri} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button style={btn} onClick={onClose}>Cancel</button></div>
      </div>
    </Drawer>
  );
}

// ── Patents ───────────────────────────────────────────────────────────────────
function Patents({ productLines, onChange }) {
  const [rows, setRows] = useState([]);
  const [drawer, setDrawer] = useState(false);
  const load = useCallback(() => { api.get('/rd/patents').then(({ data }) => setRows(Array.isArray(data) ? data : [])).catch(() => setRows([])); }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: 12, borderBottom: '1px solid #f0f0f4', display: 'flex' }}>
        <button style={{ ...btnPri, marginLeft: 'auto' }} onClick={() => setDrawer(true)}><Plus size={14} /> New IP record</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
          <thead><tr><th style={TH}>Title</th><th style={TH}>Type</th><th style={TH}>Application #</th><th style={TH}>Jurisdiction</th><th style={TH}>Status</th><th style={TH}>Filed</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td style={TD}><div style={{ fontWeight: 600, color: '#111827' }}>{p.title}</div>{p.product_line && <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.product_line}</div>}</td>
                <td style={TD}><Chip text={p.ip_type} color="#6366f1" /></td>
                <td style={{ ...TD, color: '#6b7280' }}>{p.application_no || '—'}</td>
                <td style={{ ...TD, color: '#6b7280' }}>{p.jurisdiction || '—'}</td>
                <td style={TD}><Chip text={p.status} color={PAT_STATUS[p.status] || '#6b7280'} /></td>
                <td style={{ ...TD, color: '#6b7280' }}>{fmtDate(p.filing_date)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td style={{ ...TD, textAlign: 'center', color: '#9ca3af' }} colSpan={6}>No IP records yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {drawer && <PatentDrawer productLines={productLines} onClose={() => setDrawer(false)} onSaved={() => { setDrawer(false); load(); onChange(); }} />}
    </div>
  );
}

function PatentDrawer({ productLines, onClose, onSaved }) {
  const [f, setF] = useState({ title: '', ip_type: 'patent', application_no: '', jurisdiction: '', status: 'idea', filing_date: '', inventors: '', product_line_id: '' });
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    if (!f.title) { setErr('Title is required'); return; }
    setBusy(true); setErr(null);
    try { await api.post('/rd/patents', { ...f, product_line_id: f.product_line_id || null, filing_date: f.filing_date || null }); onSaved(); }
    catch (e) { setErr(e.response?.data?.error || 'Save failed'); } finally { setBusy(false); }
  };
  return (
    <Drawer title="New IP record" onClose={onClose}>
      {err && <div style={{ background: '#fee2e2', color: '#b91c1c', padding: '8px 10px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{err}</div>}
      <div style={{ display: 'grid', gap: 12 }}>
        <div><label style={LABEL}>Title *</label><input style={INPUT} value={f.title} onChange={set('title')} placeholder="Adaptive harmonic filter control method" /></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={LABEL}>Type</label><select style={INPUT} value={f.ip_type} onChange={set('ip_type')}>{['patent', 'trademark', 'design', 'copyright'].map((v) => <option key={v} value={v}>{v}</option>)}</select></div>
          <div><label style={LABEL}>Status</label><select style={INPUT} value={f.status} onChange={set('status')}>{Object.keys(PAT_STATUS).map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={LABEL}>Application #</label><input style={INPUT} value={f.application_no} onChange={set('application_no')} /></div>
          <div><label style={LABEL}>Jurisdiction</label><input style={INPUT} value={f.jurisdiction} onChange={set('jurisdiction')} placeholder="India / PCT / US" /></div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={LABEL}>Filing date</label><input type="date" style={INPUT} value={f.filing_date} onChange={set('filing_date')} /></div>
          <div><label style={LABEL}>Product line</label><select style={INPUT} value={f.product_line_id} onChange={set('product_line_id')}><option value="">—</option>{productLines.map((p) => <option key={p.product_line_id} value={p.product_line_id}>{p.product_line}</option>)}</select></div>
        </div>
        <div><label style={LABEL}>Inventors</label><input style={INPUT} value={f.inventors} onChange={set('inventors')} /></div>
        <div style={{ display: 'flex', gap: 10 }}><button style={btnPri} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button style={btn} onClick={onClose}>Cancel</button></div>
      </div>
    </Drawer>
  );
}

// ── Lifecycle (PLM) ───────────────────────────────────────────────────────────
const STAGES = ['concept', 'design', 'prototype', 'validation', 'production', 'maintenance', 'eol'];
function Lifecycle({ rows, onChange }) {
  const setStage = async (plid, to_stage) => {
    await api.post(`/rd/lifecycle/${plid}/set-stage`, { to_stage });
    onChange();
  };
  return (
    <div style={{ ...CARD, padding: 0, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
          <thead><tr><th style={TH}>Product line</th><th style={TH}>Voltage</th><th style={TH}>Stage</th><th style={TH}>Artifacts</th><th style={TH}>Patents</th><th style={TH}>Set stage</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product_line_id}>
                <td style={TD}><span style={{ fontWeight: 600, color: '#111827' }}>{r.product_line}</span></td>
                <td style={{ ...TD, color: '#6b7280' }}>{r.voltage_class || '—'}</td>
                <td style={TD}>{r.current_stage ? <Chip text={r.current_stage} color={STAGE_COLOR[r.current_stage] || '#6b7280'} /> : <span style={{ fontSize: 11, color: '#9ca3af' }}>Not tracked</span>}</td>
                <td style={{ ...TD, color: '#6b7280' }}>{r.artifact_count || 0}</td>
                <td style={{ ...TD, color: '#6b7280' }}>{r.patent_count || 0}</td>
                <td style={TD}>
                  <select style={{ ...INPUT, width: 'auto', padding: '4px 8px', fontSize: 12 }} value={r.current_stage || ''} onChange={(e) => setStage(r.product_line_id, e.target.value)}>
                    <option value="" disabled>Set…</option>
                    {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td style={{ ...TD, textAlign: 'center', color: '#9ca3af' }} colSpan={6}>No product lines.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
