// frontend/src/features/production/pages/BOMBuilder.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';

function formatINR(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '₹0';
  if (num >= 100000) return `₹${(num / 100000).toFixed(2)}L`;
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}


/* ── BOM tree node renderer ── */
function BOMTreeNode({ node, level = 0, onAddChild, onDelete, onEdit, frozen }) {
  const [editing, setEditing] = useState(false);
  const [editQty, setEditQty] = useState(node.qty);

  const indent = level * 24;
  const lineCost = parseFloat(node.qty) * parseFloat(node.unit_cost || 0);

  return (
    <>
      <tr style={{ borderBottom: '1px solid #f0ebff' }}>
        <td style={{ padding: '8px 12px', paddingLeft: 12 + indent }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {level > 0 && <span style={{ color: '#c4b5fd', fontSize: 12 }}>└─</span>}
            <span style={{ fontWeight: 600, color: '#1f2937', fontSize: 13 }}>{node.component_name}</span>
          </div>
        </td>
        <td style={{ padding: '8px 12px' }}>
          {!frozen && editing ? (
            <div style={{ display: 'flex', gap: 4 }}>
              <input type="number" value={editQty} onChange={e => setEditQty(e.target.value)}
                style={{ width: 60, padding: '3px 6px', border: '1px solid #e9e4ff', borderRadius: 5, fontSize: 13 }} />
              <button onClick={() => { onEdit(node.id, editQty); setEditing(false); }}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 5, padding: '3px 8px', cursor: 'pointer', fontSize: 11 }}>✓</button>
            </div>
          ) : (
            <span
              onClick={() => !frozen && setEditing(true)}
              style={{ cursor: frozen ? 'default' : 'pointer', fontWeight: 600, color: '#374151' }}
              title={frozen ? 'BOM is frozen' : 'Click to edit'}
            >
              {node.qty}
            </span>
          )}
        </td>
        <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 12 }}>{node.unit}</td>
        <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 12 }}>{formatINR(node.unit_cost)}</td>
        <td style={{ padding: '8px 12px', fontWeight: 600, color: '#6B3FDB', fontSize: 12 }}>{formatINR(lineCost)}</td>
        <td style={{ padding: '8px 12px' }}>
          {frozen ? (
            <span style={{ fontSize: 11, color: '#9ca3af' }}>frozen</span>
          ) : (
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => onAddChild(node.id, level + 1)}
                style={{ background: '#d1fae5', color: '#16a34a', border: 'none', borderRadius: 5, padding: '3px 7px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                + Sub
              </button>
              <button onClick={() => onDelete(node.id)}
                style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 5, padding: '3px 7px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                ✕
              </button>
            </div>
          )}
        </td>
      </tr>
      {node.children?.map(child => (
        <BOMTreeNode key={child.id} node={child} level={level + 1}
          onAddChild={onAddChild} onDelete={onDelete} onEdit={onEdit} frozen={frozen} />
      ))}
    </>
  );
}

/* ── New Version Modal (ECN-gated) ── */
function NewVersionModal({ bom, onClose, onCreated }) {
  const [form, setForm] = useState({ reason: '', severity: 'medium', change_summary: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.reason.trim()) { setError('Change reason is required'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await api.post(`/bom/bom/${bom.id}/version`, form);
      setResult(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create version');
    } finally {
      setSaving(false);
    }
  };

  if (result) {
    return (
      <div style={overlay}>
        <div style={modal}>
          <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
            <div style={{ fontWeight: 700, color: '#16a34a', fontSize: 16, marginBottom: 6 }}>
              {bom.product_name} v{result.version} created
            </div>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
              ECN <strong style={{ color: '#6B3FDB' }}>{result.ecn_number}</strong> raised and linked to this version.
              Any further edits to the spec require a new ECN.
            </div>
            <button onClick={() => { onCreated(result); onClose(); }}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 28px', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
              Open v{result.version}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <h3 style={{ margin: 0, color: '#4c1d95', fontSize: 16 }}>Create New Version</h3>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
              {bom.product_name} · v{bom.version} → v{bom.version + 1}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>

        <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', marginBottom: 18, fontSize: 12, color: '#92400e' }}>
          A new ECN will be auto-raised and linked to this version. This creates an immutable audit trail of who changed what and why.
        </div>

        <label style={lbl}>Change Reason <span style={{ color: '#dc2626' }}>*</span></label>
        <textarea value={form.reason} onChange={set('reason')} rows={3} placeholder="e.g. Capacitor spec changed from 1000µF to 1200µF — supplier EOL notice for old part" style={ta} />

        <label style={lbl}>Severity</label>
        <select value={form.severity} onChange={set('severity')} style={sel}>
          {['low', 'medium', 'high', 'critical'].map(s => <option key={s}>{s}</option>)}
        </select>

        <label style={lbl}>Impact Summary (optional)</label>
        <textarea value={form.change_summary} onChange={set('change_summary')} rows={2}
          placeholder="Which production runs, drawings, or tests are affected?" style={ta} />

        {error && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onClose} style={btnSecondary}>Cancel</button>
          <button onClick={submit} disabled={saving} style={btnPrimary}>
            {saving ? 'Creating…' : 'Create v' + (bom.version + 1) + ' + ECN'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Version History Tab ── */
function VersionHistory({ bomId, currentId, onSelect }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/bom/bom/${bomId}/versions`)
      .then(r => setVersions(r.data))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [bomId]);

  if (loading) return <div style={{ padding: 20, textAlign: 'center', color: '#6B3FDB', fontSize: 13 }}>Loading…</div>;

  return (
    <div style={{ padding: 16 }}>
      {versions.length === 0 && (
        <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: 13, padding: 20 }}>No version history found</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {versions.map(v => (
          <div key={v.id}
            onClick={() => onSelect(v)}
            style={{
              padding: '12px 16px', borderRadius: 10, border: `1px solid ${v.id === currentId ? '#6B3FDB' : '#e9e4ff'}`,
              background: v.id === currentId ? '#ede9fe' : '#faf9ff',
              cursor: 'pointer', transition: 'background 0.1s',
            }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14 }}>v{v.version}</span>
                <span style={{
                  fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 700,
                  background: v.status === 'active' ? '#d1fae5' : '#fef3c7',
                  color: v.status === 'active' ? '#16a34a' : '#d97706',
                }}>{v.status}</span>
                {v.frozen_at && (
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8' }}>
                    frozen
                  </span>
                )}
                {v.id === currentId && (
                  <span style={{ fontSize: 10, color: '#6B3FDB', fontWeight: 600 }}>← viewing</span>
                )}
              </div>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>{formatDate(v.created_at)}</span>
            </div>
            {v.ecn_number && (
              <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
                ECN: <strong style={{ color: '#6B3FDB' }}>{v.ecn_number}</strong>
                {v.approved_by_name && (
                  <span> · Approved by {v.approved_by_name} on {formatDate(v.approved_at)}</span>
                )}
              </div>
            )}
            {v.change_reason && (
              <div style={{ marginTop: 4, fontSize: 12, color: '#374151', fontStyle: 'italic' }}>
                "{v.change_reason}"
              </div>
            )}
            {v.frozen_by_name && (
              <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280' }}>
                Frozen by {v.frozen_by_name} · {formatDate(v.frozen_at)}
              </div>
            )}
            <div style={{ marginTop: 4, fontSize: 11, color: '#9ca3af' }}>{v.component_count} components</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── MRP Result Modal ── */
function MRPModal({ bomId, bomName, onClose }) {
  const toast = useToast();
  const [qty, setQty]       = useState(1);
  const [running, setRun]   = useState(false);
  const [result, setResult] = useState(null);
  const [genPR, setGenPR]   = useState(false);

  const runMRP = async () => {
    setRun(true);
    setResult(null);
    try {
      const res = await api.post('/bom/mrp/run', { bom_id: bomId, quantity: qty });
      setResult(res.data);
    } catch (err) {
      const msg = err?.response?.data?.error || 'MRP run failed. Check BOM configuration and try again.';
      setResult({ error: msg });
    } finally { setRun(false); }
  };

  const genPRs = async () => {
    if (!result || result.error) return;
    setGenPR(true);
    try {
      const res = await api.post('/bom/mrp/run', { bom_id: bomId, quantity: qty, generate_prs: true });
      const prCount = res.data?.created_prs?.length || 0;
      if (prCount > 0) {
        toast.success(`${prCount} Purchase Request(s) created. Check Procurement → Purchase Requests.`);
      } else {
        toast.info('No shortages found — all materials are in stock.');
      }
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to generate PRs. Try again.');
    } finally { setGenPR(false); }
  };

  const shortageItems = result?.requirements?.filter(r => r.shortage > 0) || [];

  return (
    <div style={overlay}>
      <div style={{ ...modal, maxWidth: 700 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={{ margin: 0, color: '#4c1d95' }}>MRP Run — {bomName}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>

        {result?.error && (
          <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#991b1b', fontSize: 13 }}>
            <strong>MRP Error:</strong> {result.error}
            <br /><button onClick={() => setResult(null)} style={{ marginTop: 8, background: 'none', border: '1px solid #fca5a5', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', color: '#991b1b', fontSize: 12 }}>Try Again</button>
          </div>
        )}

        {!result && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 20 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>Production Quantity</label>
              <input type="number" value={qty} min={1} onChange={e => setQty(parseInt(e.target.value) || 1)}
                style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 15, width: 100 }} />
            </div>
            <button onClick={runMRP} disabled={running}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 24px', cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
              {running ? 'Running…' : '▶ Run MRP'}
            </button>
          </div>
        )}

        {result && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
              {[
                { label: 'Qty to Produce', value: result.quantity, color: '#6B3FDB', bg: '#ede9fe' },
                { label: 'Total Cost', value: formatINR(result.total_cost_estimate), color: '#16a34a', bg: '#d1fae5' },
                { label: 'Shortage Items', value: result.shortage_count, color: '#dc2626', bg: '#fee2e2' },
              ].map(({ label, value, color, bg }) => (
                <div key={label} style={{ padding: '10px 16px', background: bg, borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
                  <div style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{label}</div>
                </div>
              ))}
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Component', 'Required', 'In Stock', 'Shortage', 'Suggested PO Qty'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.requirements?.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f0ebff', background: r.shortage > 0 ? '#fff5f5' : '#fff' }}>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: '#1f2937' }}>{r.component}</td>
                    <td style={{ padding: '8px 10px' }}>{r.required} {r.unit}</td>
                    <td style={{ padding: '8px 10px', color: r.available < r.required ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{r.available}</td>
                    <td style={{ padding: '8px 10px' }}>
                      {r.shortage > 0
                        ? <span style={{ color: '#dc2626', fontWeight: 700 }}>⚠ {r.shortage} {r.unit}</span>
                        : <span style={{ color: '#16a34a' }}>✓ OK</span>}
                    </td>
                    <td style={{ padding: '8px 10px', color: '#6B3FDB', fontWeight: 600 }}>
                      {r.suggested_po_qty > 0 ? `${r.suggested_po_qty} ${r.unit}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 10 }}>
              {shortageItems.length > 0 && (
                <button onClick={genPRs} disabled={genPR}
                  style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                  {genPR ? 'Creating…' : `Generate ${shortageItems.length} Purchase Request(s)`}
                </button>
              )}
              <button onClick={() => setResult(null)}
                style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                Re-run
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Add Component Form ── */
function AddComponentForm({ bomId, parentLineId, level, onSave, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({ component_name: '', qty: '', unit: 'pcs', unit_cost: '' });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    if (!form.component_name.trim()) { toast.error('Component name is required'); return; }
    if (!form.qty || Number.isNaN(parseFloat(form.qty))) { toast.error('A valid quantity is required'); return; }
    try {
      await api.post(`/bom/bom/${bomId}/lines`, {
        ...form,
        unit_cost: form.unit_cost === '' ? 0 : form.unit_cost,
        level,
        parent_line_id: parentLineId || null,
      });
      onSave();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to add component');
    }
  };

  return (
    <tr style={{ background: '#faf5ff', borderBottom: '1px solid #e9e4ff' }}>
      <td style={{ padding: '8px 12px', paddingLeft: 12 + (level - 1) * 24 }}>
        <input placeholder="Component name" value={form.component_name} onChange={set('component_name')}
          style={{ width: '100%', padding: '5px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 13 }} />
      </td>
      <td style={{ padding: '8px 12px' }}>
        <input type="number" placeholder="Qty" value={form.qty} onChange={set('qty')} min={0}
          style={{ width: 60, padding: '5px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 13 }} />
      </td>
      <td style={{ padding: '8px 12px' }}>
        <select value={form.unit} onChange={set('unit')}
          style={{ padding: '5px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 12 }}>
          {['pcs', 'mtrs', 'kg', 'ltrs', 'set', 'nos', 'rolls'].map(u => <option key={u}>{u}</option>)}
        </select>
      </td>
      <td style={{ padding: '8px 12px' }}>
        <input type="number" placeholder="Unit cost ₹" value={form.unit_cost} onChange={set('unit_cost')}
          style={{ width: 90, padding: '5px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 13 }} />
      </td>
      <td />
      <td style={{ padding: '8px 12px' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={save}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>✓</button>
          <button onClick={onCancel}
            style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>✕</button>
        </div>
      </td>
    </tr>
  );
}

/* ── Shared styles ── */
const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modal   = { background: '#fff', borderRadius: 12, padding: 28, width: '95%', maxWidth: 540, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' };
const lbl     = { display: 'block', fontSize: 12, fontWeight: 600, color: '#4c1d95', marginBottom: 4, marginTop: 14 };
const ta      = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, resize: 'vertical', fontFamily: 'inherit' };
const sel     = { width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 };
const btnPrimary   = { background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 700, fontSize: 13 };
const btnSecondary = { background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 13 };


/* ── MAIN COMPONENT ── */
export default function BOMBuilder() {
  const toast = useToast();
  const [boms, setBoms]             = useState([]);
  const [selectedBOM, setSelected]  = useState(null);
  const [detail, setDetail]         = useState(null);
  const [workCentres, setWCs]       = useState([]);
  const [loading, setLoading]       = useState(false);
  const [tab, setTab]               = useState('bom');
  const [addingChild, setAdding]    = useState(null);
  const [showMRP, setShowMRP]       = useState(false);
  const [showNewBOM, setShowNew]    = useState(false);
  const [newBOMForm, setNewBOM]     = useState({ product_name: '', status: 'draft' });
  const [showVersionModal, setShowVersion] = useState(false);
  const [freezing, setFreezing]     = useState(false);
  const [pendingFreeze, setPendingFreeze] = useState(false);
  const [mrpFrom, setMrpFrom]       = useState(new Date().toISOString().split('T')[0]);
  const [mrpTo, setMrpTo]           = useState(new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]);
  const [mrpReqData, setMrpReqData] = useState(null);
  const [mrpReqLoading, setMrpReqLoad] = useState(false);
  const [genPRLoading, setGenPRLoad]   = useState(false);

  const [addingStep, setAddingStep]   = useState(false);
  const [stepForm,   setStepForm]     = useState({ operation: '', work_centre_id: '', std_time_hrs: '', setup_time_hrs: '', is_inspection: false, description: '' });
  const [stepSaving, setStepSaving]   = useState(false);

  const isFrozen = !!detail?.frozen_at;

  const loadBOMs = useCallback(async () => {
    try {
      const res = await api.get('/bom/bom');
      setBoms(res.data || []);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to load BOMs');
      setBoms([]);
    }
  }, [toast]);

  const loadDetail = useCallback(async (id) => {
    setLoading(true);
    try {
      const res = await api.get(`/bom/bom/${id}`);
      setDetail(res.data);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to load BOM detail');
      setDetail(null);
    } finally { setLoading(false); }
  }, [toast]);

  const loadWCs = useCallback(async () => {
    try {
      const res = await api.get('/bom/work-centres');
      if (res.data?.length) setWCs(res.data);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to load work centres');
      setWCs([]);
    }
  }, [toast]);

  useEffect(() => { loadBOMs(); loadWCs(); }, [loadBOMs, loadWCs]);

  useEffect(() => {
    if (selectedBOM) loadDetail(selectedBOM.id);
  }, [selectedBOM, loadDetail]);

  const handleSelect = (bom) => { setSelected(bom); setTab('bom'); };

  const runMRPReqs = async () => {
    setMrpReqLoad(true);
    setMrpReqData(null);
    try {
      const res = await api.get('/production/mrp/requirements', { params: { from_date: mrpFrom, to_date: mrpTo } });
      setMrpReqData(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'MRP computation failed. Try again.');
    }
    setMrpReqLoad(false);
  };

  const genMRPPRs = async () => {
    if (!mrpReqData) return;
    setGenPRLoad(true);
    try {
      const res = await api.post('/production/mrp/requirements/generate-prs', {
        requirements: mrpReqData.requirements.filter(r => r.shortage_qty > 0),
        from_date: mrpFrom,
        to_date: mrpTo,
      });
      const count = res.data?.created || 0;
      if (count > 0) {
        toast.success(`${count} Purchase Request(s) created. Check Procurement → Purchase Requests.`);
      } else {
        toast.info('No shortages to create PRs for.');
      }
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to create purchase requests.');
    }
    setGenPRLoad(false);
  };

  const handleDelete = async (lineId) => {
    try {
      await api.delete(`/bom/bom/lines/${lineId}`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to delete BOM line');
    } finally {
      if (selectedBOM) loadDetail(selectedBOM.id);
    }
  };

  const handleEdit = async (lineId, newQty) => {
    try {
      await api.put(`/bom/bom/lines/${lineId}`, { qty: newQty });
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to update BOM line quantity');
    } finally {
      if (selectedBOM) loadDetail(selectedBOM.id);
    }
  };

  const handleAddStep = async () => {
    if (!stepForm.operation || !stepForm.std_time_hrs) return toast.error('Operation and time are required');
    setStepSaving(true);
    try {
      const nextNo = (detail?.routing?.length || 0) + 1;
      await api.post(`/bom/bom/${selectedBOM.id}/routing`, { ...stepForm, step_no: nextNo });
      setAddingStep(false);
      setStepForm({ operation: '', work_centre_id: '', std_time_hrs: '', setup_time_hrs: '', is_inspection: false, description: '' });
      loadDetail(selectedBOM.id);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to add routing step');
    } finally { setStepSaving(false); }
  };

  const handleDeleteStep = async (stepId) => {
    try {
      await api.delete(`/bom/bom/routing/${stepId}`);
      loadDetail(selectedBOM.id);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to delete routing step');
    }
  };

  const handleFreeze = async () => {
    if (!selectedBOM) return;
    if (!pendingFreeze) return;
    setPendingFreeze(false);
    setFreezing(true);
    try {
      await api.post(`/bom/bom/${selectedBOM.id}/freeze`);
      loadDetail(selectedBOM.id);
      loadBOMs();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to freeze BOM');
    } finally {
      setFreezing(false);
    }
  };

  const createBOM = async () => {
    if (!newBOMForm.product_name) return;
    try {
      await api.post('/bom/bom', newBOMForm);
      setShowNew(false);
      setNewBOM({ product_name: '', status: 'draft' });
      loadBOMs();
    } catch(e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to create BOM');
    }
  };

  const totalCost = detail?.total_material_cost || 0;
  const totalHrs  = detail?.total_route_hrs || 0;

  const tabStyle = (t) => ({
    padding: '7px 16px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
    background: tab === t ? '#6B3FDB' : 'transparent',
    color:      tab === t ? '#fff'    : '#6B3FDB',
    borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent',
  });

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <ConfirmDialog
        open={pendingFreeze}
        title="Freeze BOM"
        message={selectedBOM ? `Freeze BOM "${selectedBOM.product_name}" v${selectedBOM.version}? Once frozen, no components or routing steps can be edited.` : ''}
        confirmLabel="Freeze"
        variant="warning"
        onConfirm={handleFreeze}
        onCancel={() => setPendingFreeze(false)}
      />
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', color: '#4c1d95', fontSize: 22 }}>BOM & MRP Engine</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Bill of Materials, routing, and Material Requirements Planning</p>
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>

        {/* ── Left: BOM List ── */}
        <div style={{ width: 260, flexShrink: 0, background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #e9e4ff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, color: '#4c1d95', fontSize: 14 }}>BOMs ({boms.length})</span>
            <button onClick={() => setShowNew(true)}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '4px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              + New
            </button>
          </div>

          {showNewBOM && (
            <div style={{ padding: 12, borderBottom: '1px solid #e9e4ff', background: '#faf5ff' }}>
              <input placeholder="Product name" value={newBOMForm.product_name}
                onChange={e => setNewBOM(f => ({ ...f, product_name: e.target.value }))}
                style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 13, marginBottom: 6 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={createBOM}
                  style={{ flex: 1, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                  Create
                </button>
                <button onClick={() => setShowNew(false)}
                  style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, padding: 6, cursor: 'pointer', fontSize: 12 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div style={{ maxHeight: 500, overflowY: 'auto' }}>
            {boms.map(bom => (
              <div key={bom.id} onClick={() => handleSelect(bom)}
                style={{ padding: '12px 16px', cursor: 'pointer', borderBottom: '1px solid #f0ebff',
                  background: selectedBOM?.id === bom.id ? '#ede9fe' : '#fff' }}>
                <div style={{ fontWeight: 600, color: '#1f2937', fontSize: 13, marginBottom: 4 }}>{bom.product_name}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, background: '#e9e4ff', color: '#6B3FDB', padding: '1px 6px', borderRadius: 8, fontWeight: 700 }}>
                    v{bom.version}
                  </span>
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 700,
                    background: bom.status === 'active' ? '#d1fae5' : '#fef3c7',
                    color: bom.status === 'active' ? '#16a34a' : '#d97706' }}>
                    {bom.status}
                  </span>
                  {bom.frozen_at && (
                    <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8' }}>
                      frozen
                    </span>
                  )}
                  {bom.ecn_number && (
                    <span style={{ fontSize: 10, color: '#6B3FDB', fontWeight: 600 }}>{bom.ecn_number}</span>
                  )}
                  <span style={{ fontSize: 10, color: '#9ca3af' }}>{bom.component_count} items</span>
                </div>
                <div style={{ fontSize: 11, color: '#6B3FDB', marginTop: 3, fontWeight: 600 }}>
                  {formatINR(bom.total_material_cost)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right: BOM Detail ── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!selectedBOM ? (
            <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 60, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
              <p>Select a BOM from the list or create a new one</p>
            </div>
          ) : (
            <>
              {/* Header bar */}
              <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: '14px 18px', marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#4c1d95', fontSize: 16 }}>{selectedBOM.product_name}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: '#9ca3af' }}>v{selectedBOM.version} · {selectedBOM.status}</span>
                      {isFrozen && (
                        <span style={{ fontSize: 11, background: '#dbeafe', color: '#1d4ed8', padding: '1px 8px', borderRadius: 8, fontWeight: 700 }}>
                          FROZEN
                        </span>
                      )}
                      {detail?.ecn_number && (
                        <span style={{ fontSize: 11, background: '#ede9fe', color: '#6B3FDB', padding: '1px 8px', borderRadius: 8, fontWeight: 600 }}>
                          {detail.ecn_number}
                        </span>
                      )}
                    </div>
                    {detail?.change_reason && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, fontStyle: 'italic', maxWidth: 400 }}>
                        "{detail.change_reason}"
                      </div>
                    )}
                    {isFrozen && (
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                        Frozen by {detail.frozen_by_name} · {formatDate(detail.frozen_at)}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => setShowVersion(true)}
                      style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                      New Version
                    </button>
                    {!isFrozen && (
                      <button onClick={() => setPendingFreeze(true)} disabled={freezing}
                        style={{ background: '#dbeafe', color: '#1d4ed8', border: 'none', borderRadius: 8, padding: '7px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                        {freezing ? 'Freezing…' : 'Freeze BOM'}
                      </button>
                    )}
                    <button onClick={() => setShowMRP(true)}
                      style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                      ▶ Run MRP
                    </button>
                  </div>
                </div>

                {isFrozen && (
                  <div style={{ marginTop: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '8px 14px', fontSize: 12, color: '#1e40af' }}>
                    This BOM is frozen. Component edits are locked. Use <strong>New Version</strong> to propose changes — this raises an ECN for traceability.
                  </div>
                )}
              </div>

              {/* Tabs */}
              <div style={{ display: 'flex', borderBottom: '2px solid #e9e4ff', background: '#fff', borderRadius: '10px 10px 0 0', padding: '0 8px', flexWrap: 'wrap' }}>
                <button style={tabStyle('bom')} onClick={() => setTab('bom')}>Components</button>
                <button style={tabStyle('routing')} onClick={() => setTab('routing')}>Routing Steps</button>
                <button style={tabStyle('mrp')} onClick={() => setTab('mrp')}>MRP Requirements</button>
                <button style={tabStyle('history')} onClick={() => setTab('history')}>Version History</button>
              </div>

              <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 0 10px 10px' }}>
                {loading ? (
                  <div style={{ padding: 30, textAlign: 'center', color: '#6B3FDB' }}>Loading…</div>
                ) : (
                  <>
                    {/* BOM TAB */}
                    {tab === 'bom' && (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: '#f5f3ff' }}>
                              {['Component', 'Qty', 'Unit', 'Unit Cost', 'Line Cost', 'Actions'].map(h => (
                                <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {detail?.tree?.map(node => (
                              <BOMTreeNode key={node.id} node={node} level={0}
                                onAddChild={(parentId, lvl) => setAdding({ parentLineId: parentId, level: lvl })}
                                onDelete={handleDelete}
                                onEdit={handleEdit}
                                frozen={isFrozen} />
                            ))}
                            {!isFrozen && (
                              addingChild ? (
                                <AddComponentForm
                                  bomId={selectedBOM.id}
                                  parentLineId={addingChild.parentLineId}
                                  level={addingChild.level}
                                  onSave={() => { setAdding(null); loadDetail(selectedBOM.id); }}
                                  onCancel={() => setAdding(null)} />
                              ) : (
                                <tr>
                                  <td colSpan={6} style={{ padding: '10px 12px' }}>
                                    <button onClick={() => setAdding({ parentLineId: null, level: 1 })}
                                      style={{ background: 'none', border: '1px dashed #a78bfa', borderRadius: 7, padding: '6px 16px', cursor: 'pointer', color: '#6B3FDB', fontWeight: 600, fontSize: 13 }}>
                                      + Add Component
                                    </button>
                                  </td>
                                </tr>
                              )
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* ROUTING TAB */}
                    {tab === 'routing' && (
                      <div style={{ padding: 16 }}>
                        {!isFrozen && (
                          <div style={{ marginBottom: 12 }}>
                            {addingStep ? (
                              <div style={{ background: '#faf5ff', border: '1px solid #e9e4ff', borderRadius: 8, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Operation *</div>
                                    <input value={stepForm.operation} onChange={e => setStepForm(f => ({ ...f, operation: e.target.value }))}
                                      placeholder="e.g. Winding, Curing, Assembly"
                                      style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 13 }} />
                                  </div>
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Work Centre</div>
                                    <select value={stepForm.work_centre_id} onChange={e => setStepForm(f => ({ ...f, work_centre_id: e.target.value }))}
                                      style={{ width: '100%', padding: '6px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 13 }}>
                                      <option value="">— None —</option>
                                      {workCentres.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                                    </select>
                                  </div>
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Std Time (hrs) *</div>
                                    <input type="number" min="0" step="0.5" value={stepForm.std_time_hrs}
                                      onChange={e => setStepForm(f => ({ ...f, std_time_hrs: e.target.value }))}
                                      style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 13 }} />
                                  </div>
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Setup Time (hrs)</div>
                                    <input type="number" min="0" step="0.5" value={stepForm.setup_time_hrs}
                                      onChange={e => setStepForm(f => ({ ...f, setup_time_hrs: e.target.value }))}
                                      style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', border: '1px solid #a78bfa', borderRadius: 6, fontSize: 13 }} />
                                  </div>
                                </div>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151', cursor: 'pointer' }}>
                                  <input type="checkbox" checked={stepForm.is_inspection}
                                    onChange={e => setStepForm(f => ({ ...f, is_inspection: e.target.checked }))} />
                                  Inspection gate (blocks next step until QC pass)
                                </label>
                                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                  <button onClick={() => setAddingStep(false)} style={btnSecondary}>Cancel</button>
                                  <button onClick={handleAddStep} disabled={stepSaving} style={btnPrimary}>
                                    {stepSaving ? 'Saving…' : '+ Add Step'}
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <button onClick={() => setAddingStep(true)}
                                style={{ background: 'none', border: '1px dashed #a78bfa', borderRadius: 7, padding: '6px 16px', cursor: 'pointer', color: '#6B3FDB', fontWeight: 600, fontSize: 13 }}>
                                + Add Routing Step
                              </button>
                            )}
                          </div>
                        )}

                        {detail?.routing?.length === 0 && !addingStep && (
                          <div style={{ textAlign: 'center', padding: 20, color: '#9ca3af', fontSize: 13 }}>
                            No routing steps defined yet
                          </div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {detail?.routing?.map((step) => {
                            const machineCost = parseFloat(step.std_time_hrs || 0) * parseFloat(step.cost_per_hour || 0);
                            return (
                              <div key={step.id} style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '12px 14px', background: '#faf9ff', borderRadius: 8, border: `1px solid ${step.is_inspection ? '#fcd34d' : '#e9e4ff'}` }}>
                                <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#6B3FDB', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                                  {step.step_no}
                                </div>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontWeight: 600, color: '#1f2937', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    {step.operation}
                                    {step.is_inspection && <span style={{ fontSize: 10, background: '#fef3c7', color: '#d97706', padding: '1px 6px', borderRadius: 8, fontWeight: 700 }}>QC GATE</span>}
                                  </div>
                                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                                    {step.work_centre_name || '—'} · {step.std_time_hrs}h std{step.setup_time_hrs ? ` · ${step.setup_time_hrs}h setup` : ''}
                                  </div>
                                </div>
                                <div style={{ textAlign: 'right' }}>
                                  <div style={{ fontSize: 12, color: '#6B3FDB', fontWeight: 700 }}>{step.std_time_hrs}h</div>
                                  {machineCost > 0 && <div style={{ fontSize: 11, color: '#6b7280' }}>{formatINR(machineCost)}</div>}
                                </div>
                                {!isFrozen && (
                                  <button onClick={() => handleDeleteStep(step.id)}
                                    style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 5, padding: '4px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                                    ✕
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* MRP REQUIREMENTS TAB */}
                    {tab === 'mrp' && (
                      <div style={{ padding: 20 }}>
                        <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
                          Aggregate material requirements across all planned/released orders in a date range — compared against current stock.
                        </p>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap' }}>
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>From Date</div>
                            <input type="date" value={mrpFrom} onChange={e => setMrpFrom(e.target.value)}
                              style={{ padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                          </div>
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, color: '#4c1d95', marginBottom: 4 }}>To Date</div>
                            <input type="date" value={mrpTo} onChange={e => setMrpTo(e.target.value)}
                              style={{ padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                          </div>
                          <button onClick={runMRPReqs} disabled={mrpReqLoading}
                            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 22px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                            {mrpReqLoading ? 'Computing…' : '▶ Compute Requirements'}
                          </button>
                        </div>

                        {mrpReqData && (
                          <>
                            <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                              {[
                                { label: 'Active Orders', value: mrpReqData.orders_count, color: '#6B3FDB', bg: '#ede9fe' },
                                { label: 'Material Lines', value: mrpReqData.summary?.total_items, color: '#2563eb', bg: '#dbeafe' },
                                { label: 'Need Procurement', value: mrpReqData.summary?.shortage_items, color: '#dc2626', bg: '#fee2e2' },
                                { label: 'Total Est. Cost', value: formatINR(mrpReqData.summary?.total_cost), color: '#16a34a', bg: '#d1fae5' },
                              ].map(({ label, value, color, bg }) => (
                                <div key={label} style={{ padding: '10px 18px', background: bg, borderRadius: 8, textAlign: 'center' }}>
                                  <div style={{ fontSize: 18, fontWeight: 800, color }}>{value}</div>
                                  <div style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{label}</div>
                                </div>
                              ))}
                            </div>

                            {mrpReqData.requirements?.length === 0 ? (
                              <div style={{ textAlign: 'center', color: '#9ca3af', padding: 24, fontSize: 13 }}>
                                ✅ All materials are available — no shortages in the selected period.
                              </div>
                            ) : (
                              <>
                                <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                    <thead>
                                      <tr style={{ background: '#f5f3ff' }}>
                                        {['Item', 'Required', 'In Stock', 'Shortage', 'Suggested PO Qty', 'Est. Cost'].map(h => (
                                          <th key={h} style={{ padding: '8px 10px', textAlign: 'left', color: '#4c1d95', fontWeight: 600, fontSize: 12, borderBottom: '1px solid #e9e4ff' }}>{h}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {mrpReqData.requirements.map((r, i) => (
                                        <tr key={i} style={{ borderBottom: '1px solid #f0ebff', background: r.shortage_qty > 0 ? '#fff5f5' : '#fff' }}>
                                          <td style={{ padding: '8px 10px', fontWeight: 600, color: '#1f2937' }}>{r.item_name}</td>
                                          <td style={{ padding: '8px 10px' }}>{r.required_qty} {r.unit}</td>
                                          <td style={{ padding: '8px 10px', color: r.available_qty < r.required_qty ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{r.available_qty}</td>
                                          <td style={{ padding: '8px 10px' }}>
                                            {r.shortage_qty > 0
                                              ? <span style={{ color: '#dc2626', fontWeight: 700 }}>⚠ {r.shortage_qty} {r.unit}</span>
                                              : <span style={{ color: '#16a34a' }}>✓ OK</span>}
                                          </td>
                                          <td style={{ padding: '8px 10px', color: '#6B3FDB', fontWeight: 600 }}>
                                            {r.suggested_po_qty > 0 ? `${r.suggested_po_qty} ${r.unit}` : '—'}
                                          </td>
                                          <td style={{ padding: '8px 10px', color: '#374151' }}>
                                            {r.suggested_po_qty > 0 ? formatINR(r.suggested_po_qty * r.unit_cost) : '—'}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>

                                {mrpReqData.summary?.shortage_items > 0 && (
                                  <button onClick={genMRPPRs} disabled={genPRLoading}
                                    style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
                                    {genPRLoading ? 'Creating…' : `Create Purchase Requests for ${mrpReqData.summary.shortage_items} Shortage Item(s)`}
                                  </button>
                                )}
                              </>
                            )}
                          </>
                        )}

                        {!mrpReqData && !mrpReqLoading && (
                          <div style={{ textAlign: 'center', padding: '32px 0', color: '#9ca3af' }}>
                            <div style={{ fontSize: 36, marginBottom: 8 }}>📦</div>
                            <p style={{ margin: 0, fontSize: 13 }}>Set date range and click <strong>Compute Requirements</strong> to see material planning across all active orders.</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* HISTORY TAB */}
                    {tab === 'history' && (
                      <VersionHistory
                        bomId={selectedBOM.id}
                        currentId={selectedBOM.id}
                        onSelect={(v) => {
                          const match = boms.find(b => b.id === v.id);
                          if (match) handleSelect(match);
                          else { setSelected(v); setTab('bom'); }
                        }}
                      />
                    )}
                  </>
                )}
              </div>

              {/* Bottom bar */}
              <div style={{ marginTop: 14, background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '12px 18px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>Cost per unit (materials): </span>
                  <strong style={{ color: '#6B3FDB', fontSize: 15 }}>{formatINR(totalCost)}</strong>
                </div>
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>Est. Production Time: </span>
                  <strong style={{ color: '#374151' }}>{totalHrs}h</strong>
                </div>
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: '#6b7280' }}>Components: </span>
                  <strong style={{ color: '#374151' }}>{detail?.tree?.length || 0}</strong>
                </div>
                {totalCost > 0 && totalHrs > 0 && (
                  <div style={{ fontSize: 13, marginLeft: 'auto', padding: '4px 12px', background: '#ede9fe', borderRadius: 8 }}>
                    <span style={{ color: '#6b7280' }}>Total unit cost (mat + mfg): </span>
                    <strong style={{ color: '#4c1d95', fontSize: 14 }}>
                      {formatINR(totalCost + (detail?.routing?.reduce((s, r) => s + parseFloat(r.std_time_hrs || 0) * parseFloat(r.cost_per_hour || 0), 0) || 0))}
                    </strong>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {showMRP && selectedBOM && (
        <MRPModal bomId={selectedBOM.id} bomName={selectedBOM.product_name} onClose={() => setShowMRP(false)} />
      )}

      {showVersionModal && selectedBOM && (
        <NewVersionModal
          bom={selectedBOM}
          onClose={() => setShowVersion(false)}
          onCreated={(newBOM) => {
            loadBOMs();
            setSelected(newBOM);
            setTab('bom');
          }}
        />
      )}
    </div>
  );
}
