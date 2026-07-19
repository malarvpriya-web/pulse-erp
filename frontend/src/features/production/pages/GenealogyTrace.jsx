// frontend/src/features/production/pages/GenealogyTrace.jsx
//
// Batch / serial genealogy viewer. Search for a production order, serial, or
// batch, then render its two-directional trace: UPSTREAM (where the material
// came from) and DOWNSTREAM (where the finished product went). Drives /genealogy.
import { useState, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';

const PURPLE = '#6B3FDB', HEAD = '#4c1d95', INK = '#374151', MUT = '#6b7280';
const card = { background: '#fff', border: '1px solid #ede9fe', borderRadius: 12, padding: 16 };
const inp = { padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14 };
const btnP = { background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 13 };

const KIND = {
  production_order: ['🏭', '#ede9fe', PURPLE], serial: ['🔖', '#e0f2fe', '#0369a1'], serials: ['🔖', '#e0f2fe', '#0369a1'],
  batch: ['📦', '#fef3c7', '#d97706'], component: ['🧩', '#f5f3ff', PURPLE], source: ['🚚', '#dcfce7', '#16a34a'],
  sales_order: ['🧾', '#dbeafe', '#2563eb'], dispatch: ['📤', '#dbeafe', '#2563eb'], dispatches: ['📤', '#dbeafe', '#2563eb'],
  lifecycle: ['📜', '#f3f4f6', INK], event: ['•', '#f3f4f6', INK],
};

function TreeNode({ n, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  const [icon, bg, fg] = KIND[n.kind] || ['•', '#f3f4f6', INK];
  const hasKids = n.children && n.children.length > 0;
  return (
    <div style={{ marginLeft: depth ? 18 : 0, borderLeft: depth ? '2px solid #ede9fe' : 'none', paddingLeft: depth ? 12 : 0, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {hasKids
          ? <button onClick={() => setOpen(o => !o)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: MUT, fontSize: 12, width: 14 }}>{open ? '▾' : '▸'}</button>
          : <span style={{ width: 14, display: 'inline-block' }} />}
        <span style={{ fontSize: 14 }}>{icon}</span>
        <span style={{ background: bg, color: fg, padding: '3px 10px', borderRadius: 8, fontWeight: 700, fontSize: 13 }}>{n.label}</span>
        {n.sublabel && <span style={{ color: MUT, fontSize: 12 }}>{n.sublabel}</span>}
      </div>
      {hasKids && open && <div>{n.children.map((c, i) => <TreeNode key={i} n={c} depth={depth + 1} />)}</div>}
    </div>
  );
}

export default function GenealogyTrace() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [trace, setTrace] = useState(null);
  const [anchor, setAnchor] = useState(null);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    if (!q.trim()) return;
    setLoading(true);
    try { setResults((await api.get('/genealogy/search', { params: { q } })).data || []); setTrace(null); }
    catch (e) { toast.error(e.response?.data?.error || 'Search failed'); }
    finally { setLoading(false); }
  }, [q, toast]);

  const runTrace = async (r) => {
    setAnchor(r); setLoading(true);
    try { setTrace((await api.get('/genealogy/trace', { params: { type: r.type, id: r.id } })).data); }
    catch (e) { toast.error(e.response?.data?.error || 'Trace failed'); setTrace(null); }
    finally { setLoading(false); }
  };

  const typeChip = (t) => ({ production_order: ['🏭 Order', PURPLE], serial: ['🔖 Serial', '#0369a1'], batch: ['📦 Batch', '#d97706'] }[t] || [t, INK]);

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: '0 0 4px', color: HEAD, fontSize: 22 }}>🧬 Batch Genealogy & Traceability</h2>
        <p style={{ margin: 0, color: MUT, fontSize: 13 }}>Trace any production order, serial, or batch — upstream to source, downstream to customer</p>
      </div>

      <div style={{ ...card, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="Search order no, serial, or batch number…" style={{ ...inp, flex: '1 1 320px' }} />
        <button style={btnP} onClick={search} disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
      </div>

      {results.length > 0 && !trace && (
        <div style={{ ...card, marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 10px', color: HEAD, fontSize: 14 }}>Matches ({results.length})</h3>
          {results.map((r, i) => {
            const [lbl, col] = typeChip(r.type);
            return (
              <div key={i} onClick={() => runTrace(r)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 6px', borderBottom: '1px solid #f3f0ff', cursor: 'pointer' }}>
                <span style={{ background: '#f5f3ff', color: col, padding: '3px 9px', borderRadius: 8, fontSize: 11, fontWeight: 700, minWidth: 78, textAlign: 'center' }}>{lbl}</span>
                <span style={{ fontWeight: 700, color: INK }}>{r.label}</span>
                <span style={{ color: MUT, fontSize: 13 }}>{r.sublabel}</span>
                <span style={{ marginLeft: 'auto', color: PURPLE, fontSize: 12, fontWeight: 600 }}>Trace →</span>
              </div>
            );
          })}
        </div>
      )}

      {trace && (
        <div>
          <div style={{ ...card, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, color: MUT }}>Anchor</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: HEAD }}>{trace.anchor.label}</div>
              <div style={{ fontSize: 13, color: INK }}>{trace.anchor.sublabel}</div>
            </div>
            <button style={{ background: '#ede9fe', color: PURPLE, border: 'none', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }} onClick={() => { setTrace(null); setAnchor(null); }}>← Back to results</button>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ ...card, flex: '1 1 380px' }}>
              <h3 style={{ margin: '0 0 8px', color: '#16a34a', fontSize: 15 }}>⬆ Upstream — Where it came from</h3>
              {trace.upstream.length ? trace.upstream.map((n, i) => <TreeNode key={i} n={n} />) : <div style={{ color: MUT, fontSize: 13 }}>No upstream source records.</div>}
            </div>
            <div style={{ ...card, flex: '1 1 380px' }}>
              <h3 style={{ margin: '0 0 8px', color: '#2563eb', fontSize: 15 }}>⬇ Downstream — Where it went</h3>
              {trace.downstream.length ? trace.downstream.map((n, i) => <TreeNode key={i} n={n} />) : <div style={{ color: MUT, fontSize: 13 }}>No downstream usage records.</div>}
            </div>
          </div>
        </div>
      )}

      {!trace && results.length === 0 && !loading && (
        <div style={{ ...card, color: MUT, fontSize: 13 }}>Enter a production order number, serial number, or batch number to begin a trace.</div>
      )}
    </div>
  );
}
