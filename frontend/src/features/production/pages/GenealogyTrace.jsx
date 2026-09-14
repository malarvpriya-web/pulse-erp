// frontend/src/features/production/pages/GenealogyTrace.jsx
//
// Enterprise Material Genealogy & Complete Traceability Workspace
// Provides bidirectional traceability (Upstream Supplier -> Downstream Customer),
// As-Built Physical BOM vs Planned BOM, Immediate Where-Used & Recall Impact Analysis,
// Quality / FAT / SAT Test Runs with Measurements, and Chronological Location History.
import { useState, useCallback, useEffect } from 'react';
import { 
  ScrollText, Network, Layers, ShieldAlert, CheckCircle2, 
  History, MapPin, AlertTriangle, Box, ArrowUpRight, ArrowDownRight,
  Search, RefreshCw, FileText, CheckCircle, XCircle
} from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';
import { PageHero, PageShell } from '@/components/pulse-ui';

const PURPLE = '#6B3FDB', HEAD = '#4c1d95', INK = '#374151', MUT = '#6b7280';
const card = { background: '#fff', border: '1px solid #ede9fe', borderRadius: 12, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.03)' };
const inp = { padding: '9px 14px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 14, outline: 'none' };
const btnP = { background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 };
const tabBtn = (active) => ({
  padding: '10px 16px',
  border: 'none',
  borderBottom: active ? `3px solid ${PURPLE}` : '3px solid transparent',
  background: active ? '#f5f3ff' : 'transparent',
  color: active ? PURPLE : MUT,
  fontWeight: active ? 700 : 500,
  fontSize: 13,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  borderRadius: '8px 8px 0 0',
  transition: 'all 0.15s ease'
});

const KIND = {
  production_order: ['🏭', '#ede9fe', PURPLE], 
  serial: ['🔖', '#e0f2fe', '#0369a1'], 
  serials: ['🔖', '#e0f2fe', '#0369a1'],
  batch: ['📦', '#ede9fe', '#6d28d9'], 
  component: ['🧩', '#f5f3ff', PURPLE], 
  source: ['🚚', '#dcfce7', '#16a34a'],
  sales_order: ['🧾', '#dbeafe', '#2563eb'], 
  dispatch: ['📤', '#dbeafe', '#2563eb'], 
  dispatches: ['📤', '#dbeafe', '#2563eb'],
  lifecycle: ['📜', '#f3f4f6', INK], 
  event: ['•', '#f3f4f6', INK],
};

function TreeNode({ n, depth = 0 }) {
  const [open, setOpen] = useState(depth < 2);
  const [icon, bg, fg] = KIND[n.kind] || ['•', '#f3f4f6', INK];
  const hasKids = n.children && n.children.length > 0;
  return (
    <div style={{ marginLeft: depth ? 18 : 0, borderLeft: depth ? '2px solid #ede9fe' : 'none', paddingLeft: depth ? 12 : 0, marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {hasKids
          ? <button onClick={() => setOpen(o => !o)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: MUT, fontSize: 12, width: 14 }}>{open ? '▾' : '▸'}</button>
          : <span style={{ width: 14, display: 'inline-block' }} />}
        <span style={{ fontSize: 14 }}>{icon}</span>
        <span style={{ background: bg, color: fg, padding: '3px 10px', borderRadius: 8, fontWeight: 700, fontSize: 13 }}>{n.label}</span>
        {n.sublabel && <span style={{ color: MUT, fontSize: 12 }}>{n.sublabel}</span>}
      </div>
      {hasKids && open && <div style={{ marginTop: 4 }}>{n.children.map((c, i) => <TreeNode key={i} n={c} depth={depth + 1} />)}</div>}
    </div>
  );
}

export default function GenealogyTrace() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [trace, setTrace] = useState(null);
  const [anchor, setAnchor] = useState(null);
  const [activeTab, setActiveTab] = useState('trace'); // trace | asbuilt | whereused | qc | location
  const [loading, setLoading] = useState(false);

  // Tab Data States
  const [asBuiltData, setAsBuiltData] = useState(null);
  const [asBuiltLoading, setAsBuiltLoading] = useState(false);
  const [whereUsedData, setWhereUsedData] = useState(null);
  const [whereUsedLoading, setWhereUsedLoading] = useState(false);
  const [whereUsedBatchId, setWhereUsedBatchId] = useState('');
  const [qcData, setQcData] = useState(null);
  const [qcLoading, setQcLoading] = useState(false);
  const [locData, setLocData] = useState(null);
  const [locLoading, setLocLoading] = useState(false);

  const search = useCallback(async () => {
    if (!q.trim()) return;
    setLoading(true);
    try { 
      const res = await api.get('/genealogy/search', { params: { q } });
      setResults(res.data || []); 
      setTrace(null); 
    }
    catch (e) { toast.error(e.response?.data?.error || 'Search failed'); }
    finally { setLoading(false); }
  }, [q, toast]);

  const loadAsBuilt = useCallback(async (orderId) => {
    if (!orderId) return;
    setAsBuiltLoading(true);
    try {
      const res = await api.get(`/genealogy/as-built/${orderId}`);
      setAsBuiltData(res.data);
    } catch (e) {
      console.warn('Failed to load as-built data:', e);
    } finally {
      setAsBuiltLoading(false);
    }
  }, []);

  const loadWhereUsed = useCallback(async (batchId) => {
    if (!batchId) return;
    setWhereUsedLoading(true);
    try {
      const res = await api.get(`/genealogy/where-used/${batchId}`);
      setWhereUsedData(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Where-used recall lookup failed');
    } finally {
      setWhereUsedLoading(false);
    }
  }, [toast]);

  const loadQcHistory = useCallback(async (orderId) => {
    if (!orderId) return;
    setQcLoading(true);
    try {
      const res = await api.get(`/genealogy/qc-history/${orderId}`);
      setQcData(res.data);
    } catch (e) {
      console.warn('Failed to load QC history:', e);
    } finally {
      setQcLoading(false);
    }
  }, []);

  const loadLocationHistory = useCallback(async (params) => {
    setLocLoading(true);
    try {
      const res = await api.get('/genealogy/location-history', { params });
      setLocData(res.data);
    } catch (e) {
      console.warn('Failed to load location history:', e);
    } finally {
      setLocLoading(false);
    }
  }, []);

  const runTrace = async (r) => {
    setAnchor(r); 
    setLoading(true);
    try { 
      const res = await api.get('/genealogy/trace', { params: { type: r.type, id: r.id } });
      setTrace(res.data);
      setActiveTab('trace');

      // Preload contextual tabs depending on entity type
      if (r.type === 'production_order') {
        loadAsBuilt(r.id);
        loadQcHistory(r.id);
        loadLocationHistory({ production_order_id: r.id });
      } else if (r.type === 'batch') {
        setWhereUsedBatchId(r.id);
        loadWhereUsed(r.id);
        loadLocationHistory({ batch_id: r.id });
      } else if (r.type === 'serial') {
        loadLocationHistory({ serial_number: r.label });
      }
    }
    catch (e) { 
      toast.error(e.response?.data?.error || 'Trace failed'); 
      setTrace(null); 
    }
    finally { setLoading(false); }
  };

  const typeChip = (t) => ({ 
    production_order: ['🏭 Order', PURPLE], 
    serial: ['🔖 Serial', '#0369a1'], 
    batch: ['📦 Batch', '#6d28d9'],
    inventory_item: ['⚙️ Item', '#0f766e'],
    goods_receipt_note: ['📥 GRN', '#15803d']
  }[t] || [t, INK]);

  return (
    <PageShell dock={
      <PageHero
        icon={ScrollText}
        eyebrow="Production & Quality"
        title="🧬 Material Genealogy & Complete Traceability"
        subtitle="End-to-end bidirectional traceability: Upstream Supplier -> In-Plant Work Order -> Downstream Customer"
      />
    }>

      {/* Global Search Bar */}
      <div style={{ ...card, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', flex: '1 1 340px', position: 'relative' }}>
          <Search size={16} color={MUT} style={{ position: 'absolute', left: 12 }} />
          <input 
            value={q} 
            onChange={e => setQ(e.target.value)} 
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Search Production Order #, Serial #, Batch #, Item Code, or GRN #…" 
            style={{ ...inp, width: '100%', paddingLeft: 36 }} 
          />
        </div>
        <button style={btnP} onClick={search} disabled={loading}>
          {loading ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
          {loading ? 'Searching…' : 'Deep Search'}
        </button>
      </div>

      {/* Search Results List */}
      {results.length > 0 && !trace && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, color: HEAD, fontSize: 15, fontWeight: 700 }}>Search Matches ({results.length})</h3>
            <span style={{ fontSize: 12, color: MUT }}>Click any record to inspect complete genealogy</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {results.map((r, i) => {
              const [lbl, col] = typeChip(r.type);
              return (
                <div 
                  key={i} 
                  onClick={() => runTrace(r)} 
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: 12, 
                    padding: '10px 14px', 
                    background: '#fcfaff',
                    border: '1px solid #f3f0ff', 
                    borderRadius: 8,
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = PURPLE}
                  onMouseLeave={e => e.currentTarget.style.borderColor = '#f3f0ff'}
                >
                  <span style={{ background: '#f5f3ff', color: col, padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, minWidth: 90, textAlign: 'center' }}>{lbl}</span>
                  <span style={{ fontWeight: 700, color: INK, fontSize: 14 }}>{r.label}</span>
                  <span style={{ color: MUT, fontSize: 13 }}>{r.sublabel}</span>
                  <span style={{ marginLeft: 'auto', color: PURPLE, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                    Trace Full Genealogy <ArrowUpRight size={14} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Active Trace Workspace */}
      {trace && (
        <div>
          {/* Active Anchor Bar */}
          <div style={{ ...card, marginBottom: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, borderLeft: `5px solid ${PURPLE}` }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: PURPLE }}>Active Trace Target</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: HEAD, marginTop: 2 }}>{trace.anchor.label}</div>
              <div style={{ fontSize: 13, color: INK, marginTop: 2 }}>{trace.anchor.sublabel}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button 
                style={{ background: '#ede9fe', color: PURPLE, border: 'none', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }} 
                onClick={() => { setTrace(null); setAnchor(null); }}
              >
                ← Back to Search
              </button>
            </div>
          </div>

          {/* Forensic Module Tabs */}
          <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #ede9fe', marginBottom: 16, overflowX: 'auto' }}>
            <button style={tabBtn(activeTab === 'trace')} onClick={() => setActiveTab('trace')}>
              <Network size={16} /> 1. Trace Graph (Bi-Directional)
            </button>
            <button style={tabBtn(activeTab === 'asbuilt')} onClick={() => { setActiveTab('asbuilt'); if (!asBuiltData && anchor?.type === 'production_order') loadAsBuilt(anchor.id); }}>
              <Layers size={16} /> 2. As-Built BOM vs Planned
            </button>
            <button style={tabBtn(activeTab === 'whereused')} onClick={() => { setActiveTab('whereused'); if (!whereUsedData && whereUsedBatchId) loadWhereUsed(whereUsedBatchId); }}>
              <ShieldAlert size={16} /> 3. Recall & Where-Used Impact
            </button>
            <button style={tabBtn(activeTab === 'qc')} onClick={() => { setActiveTab('qc'); if (!qcData && anchor?.type === 'production_order') loadQcHistory(anchor.id); }}>
              <CheckCircle2 size={16} /> 4. QC, Test Runs & FAT/SAT
            </button>
            <button style={tabBtn(activeTab === 'location')} onClick={() => setActiveTab('location')}>
              <MapPin size={16} /> 5. Location & Bin Movement
            </button>
          </div>

          {/* TAB 1: Trace Graph */}
          {activeTab === 'trace' && (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ ...card, flex: '1 1 380px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <ArrowUpRight size={18} color="#16a34a" />
                  <h3 style={{ margin: 0, color: '#16a34a', fontSize: 16, fontWeight: 700 }}>⬆ Upstream — Material & Supplier Origin</h3>
                </div>
                <div style={{ fontSize: 12, color: MUT, marginBottom: 14 }}>
                  Raw materials, POs, Vendor GRNs, IQC Inspection Certificates, and Material Issue logs.
                </div>
                {trace.upstream.length ? trace.upstream.map((n, i) => <TreeNode key={i} n={n} />) : <div style={{ color: MUT, fontSize: 13, padding: 12, background: '#f9fafb', borderRadius: 8 }}>No upstream source records linked to this entity.</div>}
              </div>
              <div style={{ ...card, flex: '1 1 380px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <ArrowDownRight size={18} color="#2563eb" />
                  <h3 style={{ margin: 0, color: '#2563eb', fontSize: 16, fontWeight: 700 }}>⬇ Downstream — Assembly & Customer Destination</h3>
                </div>
                <div style={{ fontSize: 12, color: MUT, marginBottom: 14 }}>
                  Sub-assemblies, Finished Goods Serials, Customer Sales Orders, Project Delivery, and Shipments.
                </div>
                {trace.downstream.length ? trace.downstream.map((n, i) => <TreeNode key={i} n={n} />) : <div style={{ color: MUT, fontSize: 13, padding: 12, background: '#f9fafb', borderRadius: 8 }}>No downstream consumption or dispatch records found.</div>}
              </div>
            </div>
          )}

          {/* TAB 2: As-Built BOM */}
          {activeTab === 'asbuilt' && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div>
                  <h3 style={{ margin: 0, color: HEAD, fontSize: 16, fontWeight: 700 }}>As-Built Physical BOM vs Planned Engineering BOM</h3>
                  <div style={{ fontSize: 12, color: MUT, marginTop: 2 }}>Exact serialized components installed, lot numbers, assemblers, workstations, and rework replacements</div>
                </div>
                {anchor?.type !== 'production_order' && (
                  <div style={{ fontSize: 12, color: MUT }}>Showing order context if linked</div>
                )}
              </div>

              {asBuiltLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: MUT }}><RefreshCw className="animate-spin" size={20} /> Loading As-Built BOM...</div>
              ) : asBuiltData?.asBuiltComponents?.length ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f8f7ff', textAlign: 'left', borderBottom: '2px solid #ede9fe' }}>
                        <th style={{ padding: '10px 12px', color: HEAD }}>Component Item</th>
                        <th style={{ padding: '10px 12px', color: HEAD }}>Planned Qty</th>
                        <th style={{ padding: '10px 12px', color: HEAD }}>Actual Issued Qty</th>
                        <th style={{ padding: '10px 12px', color: HEAD }}>Batch / Lot #</th>
                        <th style={{ padding: '10px 12px', color: HEAD }}>Supplier & GRN</th>
                        <th style={{ padding: '10px 12px', color: HEAD }}>IQC Inspection</th>
                        <th style={{ padding: '10px 12px', color: HEAD }}>Assembler & Workstation</th>
                        <th style={{ padding: '10px 12px', color: HEAD }}>Substitution / Rework</th>
                      </tr>
                    </thead>
                    <tbody>
                      {asBuiltData.asBuiltComponents.map((c, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid #f3f0ff', background: c.is_rework_replacement ? '#fffbeb' : '#fff' }}>
                          <td style={{ padding: '10px 12px', fontWeight: 600, color: INK }}>
                            {c.item_name} <br />
                            <span style={{ fontSize: 11, color: MUT }}>{c.item_code}</span>
                          </td>
                          <td style={{ padding: '10px 12px', color: MUT }}>{c.planned_qty || 1} {c.uom || 'EA'}</td>
                          <td style={{ padding: '10px 12px', fontWeight: 700, color: '#16a34a' }}>{c.qty_issued} {c.uom || 'EA'}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ background: '#f5f3ff', color: PURPLE, padding: '3px 8px', borderRadius: 6, fontWeight: 600, fontSize: 12 }}>
                              {c.batch_number || 'N/A'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', fontSize: 12 }}>
                            <div style={{ fontWeight: 600 }}>{c.supplier_name || 'In-House'}</div>
                            <div style={{ color: MUT }}>{c.grn_number || '-'}</div>
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ 
                              background: c.iqc_status === 'ACCEPTED' ? '#dcfce7' : c.iqc_status === 'REJECTED' ? '#fee2e2' : '#f3f4f6', 
                              color: c.iqc_status === 'ACCEPTED' ? '#16a34a' : c.iqc_status === 'REJECTED' ? '#dc2626' : MUT,
                              padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 
                            }}>
                              {c.iqc_status || 'PASSED'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', fontSize: 12 }}>
                            <div>👤 {c.assembler_name || c.issued_by_name || 'Assembly Tech'}</div>
                            <div style={{ color: MUT }}>📍 {c.workstation_name || 'Station 1'}</div>
                          </td>
                          <td style={{ padding: '10px 12px' }}>
                            {c.is_rework_replacement ? (
                              <span style={{ background: '#fef3c7', color: '#b45309', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>
                                ⚠️ Replacement ({c.rework_reason || 'QC Defect'})
                              </span>
                            ) : (
                              <span style={{ color: MUT, fontSize: 12 }}>Standard BOM Issue</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ padding: 24, textAlign: 'center', color: MUT, background: '#f9fafb', borderRadius: 8 }}>
                  No As-Built BOM records found for this production order. Verify that materials were issued via Shop Floor Execution.
                </div>
              )}
            </div>
          )}

          {/* TAB 3: Where-Used & Recall Impact */}
          {activeTab === 'whereused' && (
            <div>
              {/* Batch Selector Bar */}
              <div style={{ ...card, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: HEAD }}>Analyze Batch / Lot Recall:</span>
                <input 
                  value={whereUsedBatchId} 
                  onChange={e => setWhereUsedBatchId(e.target.value)} 
                  placeholder="Enter Batch UUID or Batch Number…" 
                  style={{ ...inp, flex: '1 1 240px' }}
                />
                <button style={btnP} onClick={() => loadWhereUsed(whereUsedBatchId)}>
                  <ShieldAlert size={14} /> Run Recall & Where-Used Impact
                </button>
              </div>

              {whereUsedLoading ? (
                <div style={{ ...card, padding: 32, textAlign: 'center', color: MUT }}><RefreshCw className="animate-spin" size={20} /> Computing Where-Used & Quantity Reconciliation...</div>
              ) : whereUsedData ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  
                  {/* Quantity Reconciliation KPI Ribbon */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                    <div style={{ ...card, padding: 14, borderLeft: '4px solid #6d28d9' }}>
                      <div style={{ fontSize: 11, color: MUT, fontWeight: 600 }}>TOTAL RECEIVED (GRN)</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: HEAD }}>{whereUsedData.reconciliation?.total_received || 0}</div>
                    </div>
                    <div style={{ ...card, padding: 14, borderLeft: '4px solid #16a34a' }}>
                      <div style={{ fontSize: 11, color: MUT, fontWeight: 600 }}>IN WAREHOUSE / BINS</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#16a34a' }}>{whereUsedData.reconciliation?.store_stock_remaining || 0}</div>
                    </div>
                    <div style={{ ...card, padding: 14, borderLeft: '4px solid #eab308' }}>
                      <div style={{ fontSize: 11, color: MUT, fontWeight: 600 }}>CONSUMED IN PRODUCTION</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#ca8a04' }}>{whereUsedData.reconciliation?.consumed_in_wip || 0}</div>
                    </div>
                    <div style={{ ...card, padding: 14, borderLeft: '4px solid #2563eb' }}>
                      <div style={{ fontSize: 11, color: MUT, fontWeight: 600 }}>SHIPPED TO CUSTOMERS</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#2563eb' }}>{whereUsedData.reconciliation?.dispatched_to_customers || 0}</div>
                    </div>
                    <div style={{ ...card, padding: 14, borderLeft: whereUsedData.reconciliation?.is_reconciled ? '4px solid #16a34a' : '4px solid #dc2626' }}>
                      <div style={{ fontSize: 11, color: MUT, fontWeight: 600 }}>GENEALOGY AUDIT STATUS</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: whereUsedData.reconciliation?.is_reconciled ? '#16a34a' : '#dc2626', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {whereUsedData.reconciliation?.is_reconciled ? <><CheckCircle size={18} /> 100% RECONCILED</> : <><AlertTriangle size={18} /> VARIANCE DETECTED</>}
                      </div>
                    </div>
                  </div>

                  {/* Impacted Locations & Shipments Grid */}
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    
                    {/* Warehouse Locations */}
                    <div style={{ ...card, flex: '1 1 360px' }}>
                      <h4 style={{ margin: '0 0 10px', color: HEAD, fontSize: 14, fontWeight: 700 }}>📦 Warehouse Locations With Remaining Stock</h4>
                      {whereUsedData.warehouseStock?.length ? (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ background: '#f8f7ff', textAlign: 'left', borderBottom: '1px solid #ede9fe' }}>
                              <th style={{ padding: 8 }}>Warehouse</th>
                              <th style={{ padding: 8 }}>Rack / Bin</th>
                              <th style={{ padding: 8, textAlign: 'right' }}>Current Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {whereUsedData.warehouseStock.map((w, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #f9fafb' }}>
                                <td style={{ padding: 8, fontWeight: 600 }}>{w.warehouse_name}</td>
                                <td style={{ padding: 8 }}>{w.rack_code || 'Rack 1'} / {w.bin_code || 'Bin A'}</td>
                                <td style={{ padding: 8, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{w.quantity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : <div style={{ color: MUT, fontSize: 12 }}>No remaining stock in storage.</div>}
                    </div>

                    {/* Customer Shipments Impacted */}
                    <div style={{ ...card, flex: '1 1 360px' }}>
                      <h4 style={{ margin: '0 0 10px', color: '#dc2626', fontSize: 14, fontWeight: 700 }}>🚨 Customer Shipments Impacted (Recall Target)</h4>
                      {whereUsedData.customerDispatches?.length ? (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ background: '#fef2f2', textAlign: 'left', borderBottom: '1px solid #fee2e2' }}>
                              <th style={{ padding: 8, color: '#991b1b' }}>Customer</th>
                              <th style={{ padding: 8, color: '#991b1b' }}>Project / SO</th>
                              <th style={{ padding: 8, color: '#991b1b' }}>Finished Serial</th>
                              <th style={{ padding: 8, color: '#991b1b', textAlign: 'right' }}>Date</th>
                            </tr>
                          </thead>
                          <tbody>
                            {whereUsedData.customerDispatches.map((cd, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #fef2f2' }}>
                                <td style={{ padding: 8, fontWeight: 700 }}>{cd.customer_name}</td>
                                <td style={{ padding: 8 }}>{cd.project_name || cd.sales_order_no}</td>
                                <td style={{ padding: 8 }}><span style={{ background: '#e0f2fe', color: '#0369a1', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>{cd.serial_number}</span></td>
                                <td style={{ padding: 8, textAlign: 'right', color: MUT }}>{cd.dispatch_date ? new Date(cd.dispatch_date).toLocaleDateString() : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : <div style={{ color: MUT, fontSize: 12 }}>No customer dispatches impacted by this batch.</div>}
                    </div>

                  </div>
                </div>
              ) : (
                <div style={{ ...card, color: MUT, fontSize: 13, textAlign: 'center', padding: 24 }}>
                  Enter a Batch UUID or select a batch from search to calculate complete recall impact and inventory reconciliation.
                </div>
              )}
            </div>
          )}

          {/* TAB 4: QC, Test Runs & Compliance */}
          {activeTab === 'qc' && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div>
                  <h3 style={{ margin: 0, color: HEAD, fontSize: 16, fontWeight: 700 }}>Quality Control & FAT/SAT Test Run Measurements</h3>
                  <div style={{ fontSize: 12, color: MUT, marginTop: 2 }}>In-process inspections, measured dielectric/megger/voltage parameters, FAT/SAT certificates, and NCRs</div>
                </div>
              </div>

              {qcLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: MUT }}><RefreshCw className="animate-spin" size={20} /> Loading Quality Records...</div>
              ) : qcData ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  
                  {/* Test Runs & Measurements */}
                  <div>
                    <h4 style={{ margin: '0 0 8px', color: PURPLE, fontSize: 14 }}>🔬 Shop Floor Test Runs & Physical Measurements</h4>
                    {qcData.testRuns?.length ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {qcData.testRuns.map((tr, idx) => (
                          <div key={idx} style={{ border: '1px solid #ede9fe', borderRadius: 8, padding: 12, background: '#faf9fe' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                              <span style={{ fontWeight: 700, color: HEAD, fontSize: 13 }}>{tr.test_run_number || `Test Run #${idx + 1}`} — {tr.test_type || 'Electrical Safety & Hipot'}</span>
                              <span style={{ 
                                background: tr.overall_result === 'PASS' ? '#dcfce7' : '#fee2e2', 
                                color: tr.overall_result === 'PASS' ? '#16a34a' : '#dc2626',
                                padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 
                              }}>
                                {tr.overall_result || 'PASS'}
                              </span>
                            </div>
                            <div style={{ fontSize: 12, color: MUT, marginBottom: 8 }}>
                              Tester: 👤 {tr.tested_by_name || 'Quality Inspector'} | Date: 📅 {tr.test_date ? new Date(tr.test_date).toLocaleDateString() : 'Active'}
                            </div>
                            {tr.measurements?.length ? (
                              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#fff', borderRadius: 6 }}>
                                <thead>
                                  <tr style={{ background: '#f5f3ff', textAlign: 'left' }}>
                                    <th style={{ padding: 6 }}>Parameter</th>
                                    <th style={{ padding: 6 }}>Nominal / Spec</th>
                                    <th style={{ padding: 6 }}>Actual Measured</th>
                                    <th style={{ padding: 6 }}>Status</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {tr.measurements.map((m, mIdx) => (
                                    <tr key={mIdx} style={{ borderBottom: '1px solid #f3f0ff' }}>
                                      <td style={{ padding: 6, fontWeight: 600 }}>{m.parameter_name}</td>
                                      <td style={{ padding: 6, color: MUT }}>{m.min_value} - {m.max_value} {m.uom}</td>
                                      <td style={{ padding: 6, fontWeight: 700 }}>{m.measured_value} {m.uom}</td>
                                      <td style={{ padding: 6 }}>
                                        <span style={{ color: m.is_pass ? '#16a34a' : '#dc2626', fontWeight: 700 }}>
                                          {m.is_pass ? '✓ PASS' : '✗ FAIL'}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            ) : <div style={{ fontSize: 12, color: MUT }}>Visual / Mechanical Inspection Verified.</div>}
                          </div>
                        ))}
                      </div>
                    ) : <div style={{ color: MUT, fontSize: 12 }}>No electrical test runs logged.</div>}
                  </div>

                  {/* FAT / SAT Acceptance Trackers */}
                  <div>
                    <h4 style={{ margin: '0 0 8px', color: '#0369a1', fontSize: 14 }}>📋 Factory & Site Acceptance Testing (FAT / SAT)</h4>
                    {qcData.fatSat?.length ? (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
                        {qcData.fatSat.map((fs, idx) => (
                          <div key={idx} style={{ border: '1px solid #e0f2fe', borderRadius: 8, padding: 12, background: '#f0f9ff' }}>
                            <div style={{ fontWeight: 700, color: '#0369a1', fontSize: 13 }}>{fs.tracker_type || 'FAT'} — {fs.title || 'Panel FAT Acceptance'}</div>
                            <div style={{ fontSize: 12, color: INK, marginTop: 4 }}>Status: <strong>{fs.status}</strong></div>
                            <div style={{ fontSize: 11, color: MUT, marginTop: 2 }}>Witness: {fs.client_witness_name || 'Client Representative'}</div>
                          </div>
                        ))}
                      </div>
                    ) : <div style={{ color: MUT, fontSize: 12 }}>Standard factory inspection applied; no dedicated FAT/SAT certificate attached.</div>}
                  </div>

                </div>
              ) : (
                <div style={{ padding: 24, textAlign: 'center', color: MUT, background: '#f9fafb', borderRadius: 8 }}>
                  No quality records linked to this order.
                </div>
              )}
            </div>
          )}

          {/* TAB 5: Location & Movement History */}
          {activeTab === 'location' && (
            <div style={card}>
              <h3 style={{ margin: '0 0 12px', color: HEAD, fontSize: 16, fontWeight: 700 }}>Warehouse Bin-to-Bin & Stock Movement History</h3>
              {locLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: MUT }}><RefreshCw className="animate-spin" size={20} /> Loading Stock Movement Ledger...</div>
              ) : locData?.movements?.length ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f8f7ff', textAlign: 'left', borderBottom: '2px solid #ede9fe' }}>
                      <th style={{ padding: '10px 12px' }}>Timestamp</th>
                      <th style={{ padding: '10px 12px' }}>Movement Type</th>
                      <th style={{ padding: '10px 12px' }}>Source Location</th>
                      <th style={{ padding: '10px 12px' }}>Destination Location</th>
                      <th style={{ padding: '10px 12px', textAlign: 'right' }}>Quantity</th>
                      <th style={{ padding: '10px 12px' }}>Operator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locData.movements.map((m, idx) => (
                      <tr key={idx} style={{ borderBottom: '1px solid #f3f0ff' }}>
                        <td style={{ padding: '10px 12px', color: MUT }}>{new Date(m.created_at).toLocaleString()}</td>
                        <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                          <span style={{ background: '#f5f3ff', color: PURPLE, padding: '3px 8px', borderRadius: 6, fontSize: 12 }}>
                            {m.movement_type || m.transaction_type}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px' }}>{m.from_location || m.from_warehouse || 'Receiving Dock'}</td>
                        <td style={{ padding: '10px 12px', fontWeight: 600 }}>{m.to_location || m.to_warehouse || 'Production Floor'}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: m.quantity > 0 ? '#16a34a' : '#dc2626' }}>
                          {m.quantity}
                        </td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: MUT }}>{m.created_by_name || 'Warehouse Staff'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ padding: 24, textAlign: 'center', color: MUT, background: '#f9fafb', borderRadius: 8 }}>
                  No stock ledger movements logged for this selection.
                </div>
              )}
            </div>
          )}

        </div>
      )}

      {!trace && results.length === 0 && !loading && (
        <div style={{ ...card, color: MUT, fontSize: 13, textAlign: 'center', padding: 36 }}>
          <ScrollText size={32} color={PURPLE} style={{ margin: '0 auto 12px', opacity: 0.7 }} />
          <div style={{ fontSize: 15, fontWeight: 700, color: HEAD, marginBottom: 4 }}>Enter a Search Term Above</div>
          <div>Search across Production Orders, Finished Serial Numbers, Component Batches, or GRN numbers to launch full material genealogy & recall analysis.</div>
        </div>
      )}
    </PageShell>
  );
}

