import { useState, useEffect, useRef } from 'react';
import { RefreshCw, Plus, X, CheckCircle, AlertOctagon, ClipboardList, Paperclip } from 'lucide-react';
import api from '@/services/api/client';

const RESULT_CFG = {
  pass:        { label: 'Pass',        bg: '#dcfce7', color: '#166534' },
  fail:        { label: 'Fail',        bg: '#fee2e2', color: '#991b1b' },
  conditional: { label: 'Conditional', bg: '#fef3c7', color: '#92400e' },
};
const SEV_CFG = {
  minor:    { label: 'Minor',    bg: '#fef3c7', color: '#92400e' },
  major:    { label: 'Major',    bg: '#ffedd5', color: '#c2410c' },
  critical: { label: 'Critical', bg: '#fee2e2', color: '#991b1b' },
};

function Badge({ cfg }) {
  return <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, color: cfg.color, background: cfg.bg }}>{cfg.label}</span>;
}

const EMPTY_NCR = { grn_id: '', vendor_id: '', defect_description: '', quantity_affected: 1, severity: 'minor', disposition: 'return' };

export default function QualityInspection() {
  const [tab, setTab]           = useState('inspections');
  const [inspections, setInspections] = useState([]);
  const [ncrs,        setNcrs]        = useState([]);
  const [grns,        setGrns]        = useState([]);
  const [vendors,     setVendors]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [ncrModal,    setNcrModal]    = useState(false);
  const [ncrForm,     setNcrForm]     = useState(EMPTY_NCR);
  const [ncrFile,     setNcrFile]     = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [toast,       setToast]       = useState(null);
  const isMounted = useRef(true);
  const ncrFileRef = useRef(null);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => { if (isMounted.current) setToast(null); }, 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const [insR, ncrR, grnR, venR] = await Promise.allSettled([
        api.get('/procurement/quality-inspections'),
        api.get('/procurement/ncr'),
        api.get('/procurement/grn'),
        api.get('/procurement/vendors'),
      ]);
      if (!isMounted.current) return;
      setInspections(insR.status === 'fulfilled' ? (insR.value.data || []) : []);
      setNcrs(ncrR.status === 'fulfilled' ? (ncrR.value.data || []) : []);
      setGrns(grnR.status === 'fulfilled' ? (grnR.value.data || []) : []);
      setVendors(venR.status === 'fulfilled' ? (venR.value.data?.vendors || []) : []);
    } finally { if (isMounted.current) setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const saveNCR = async () => {
    if (!ncrForm.defect_description.trim()) return showToast('Defect description is required', 'error');
    setSaving(true);
    try {
      const res = await api.post('/procurement/ncr', ncrForm);
      if (!isMounted.current) return;
      if (ncrFile && res.data?.id) {
        try {
          const fd = new FormData();
          fd.append('file', ncrFile);
          await api.patch(`/procurement/ncr/${res.data.id}/attachment`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        } catch { /* attachment upload failure is non-fatal */ }
      }
      showToast('NCR created');
      setNcrModal(false);
      setNcrForm(EMPTY_NCR);
      setNcrFile(null);
      if (ncrFileRef.current) ncrFileRef.current.value = '';
      load();
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to create NCR', 'error');
    } finally { if (isMounted.current) setSaving(false); }
  };

  const closeNCR = async (id) => {
    const action = prompt('CAPA Action taken:');
    if (!action) return;
    try {
      await api.patch(`/procurement/ncr/${id}/close`, { capa_action: action });
      if (!isMounted.current) return;
      showToast('NCR closed');
      load();
    } catch { showToast('Failed to close NCR', 'error'); }
  };

  const tabStyle = active => ({
    padding: '8px 18px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer',
    background: active ? '#10b981' : 'transparent',
    color: active ? '#fff' : '#6b7280',
    border: active ? 'none' : '1px solid #e5e7eb',
  });

  const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' };

  return (
    <div style={{ padding: '24px 28px' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, zIndex: 9999, padding: '10px 20px', borderRadius: 8, background: toast.type === 'error' ? '#fee2e2' : '#dcfce7', color: toast.type === 'error' ? '#991b1b' : '#166534', fontWeight: 600, fontSize: 14 }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111' }}>Quality Inspection</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>Incoming quality control, NCR management, and CAPA tracking</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={load} style={{ background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => { setNcrForm(EMPTY_NCR); setNcrModal(true); }}
            style={{ background: '#ef4444', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', color: '#fff', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> Raise NCR
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          { label: 'Inspections Done', value: inspections.length, color: '#10b981', bg: '#d1fae5' },
          { label: 'Pass Rate', value: inspections.length ? `${Math.round((inspections.filter(i => i.overall_result === 'pass').length / inspections.length) * 100)}%` : '—', color: '#166534', bg: '#d1fae5' },
          { label: 'Open NCRs', value: ncrs.filter(n => n.status === 'open').length, color: '#dc2626', bg: '#fee2e2' },
          { label: 'Critical NCRs', value: ncrs.filter(n => n.severity === 'critical' && n.status === 'open').length, color: '#991b1b', bg: '#fee2e2' },
        ].map(({ label, value, color, bg }) => (
          <div key={label} style={{ background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,.07)', flex: 1, minWidth: 140 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button style={tabStyle(tab === 'inspections')} onClick={() => setTab('inspections')}>Inspections ({inspections.length})</button>
        <button style={tabStyle(tab === 'ncr')} onClick={() => setTab('ncr')}>NCR / CAPA ({ncrs.filter(n => n.status === 'open').length} open)</button>
      </div>

      {/* ── Inspections Tab ── */}
      {tab === 'inspections' && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.07)', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          ) : inspections.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              <ClipboardList size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
              <p>No quality inspections recorded yet.</p>
              <p style={{ fontSize: 12 }}>Quality inspections are created automatically when a GRN is processed.</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
                  {['GRN No', 'Inspection Date', 'Inspector', 'Overall Result', 'Notes'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inspections.map((ins, i) => (
                  <tr key={ins.id || i} style={{ borderBottom: '1px solid #f5f5f5' }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{ins.grn_number || '—'}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{(ins.inspection_date || '').slice(0, 10)}</td>
                    <td style={{ padding: '10px 14px' }}>{ins.inspector_name || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <Badge cfg={RESULT_CFG[ins.overall_result] || RESULT_CFG.pass} />
                    </td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{ins.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── NCR Tab ── */}
      {tab === 'ncr' && (
        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,.07)', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
          ) : ncrs.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              <AlertOctagon size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
              <p>No Non-Conformance Reports raised.</p>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb', borderBottom: '1px solid #f0f0f4' }}>
                  {['NCR No', 'GRN No', 'Vendor', 'Defect Description', 'Qty Affected', 'Severity', 'Disposition', 'Status', 'CAPA', 'File', 'Actions'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ncrs.map((n, i) => (
                  <tr key={n.id || i} style={{ borderBottom: '1px solid #f5f5f5' }}>
                    <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontWeight: 600 }}>{n.ncr_number}</td>
                    <td style={{ padding: '10px 14px' }}>{n.grn_number || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>{n.vendor_name || '—'}</td>
                    <td style={{ padding: '10px 14px', maxWidth: 200 }}>{n.defect_description}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'center' }}>{n.quantity_affected}</td>
                    <td style={{ padding: '10px 14px' }}><Badge cfg={SEV_CFG[n.severity] || SEV_CFG.minor} /></td>
                    <td style={{ padding: '10px 14px', textTransform: 'capitalize' }}>{(n.disposition || '').replace(/_/g, ' ')}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                        color: n.status === 'closed' ? '#166534' : '#92400e',
                        background: n.status === 'closed' ? '#dcfce7' : '#fef3c7' }}>
                        {n.status}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', maxWidth: 180, color: '#6b7280', fontSize: 12 }}>{n.capa_action || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      {n.attachment_url
                        ? <a href={n.attachment_url} target="_blank" rel="noopener noreferrer" style={{ color: '#6B3FDB', fontSize: 12 }}><Paperclip size={12} style={{ verticalAlign: 'middle' }} /> View</a>
                        : <span style={{ color: '#d1d5db', fontSize: 12 }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {n.status === 'open' && (
                        <button onClick={() => closeNCR(n.id)}
                          style={{ padding: '4px 12px', borderRadius: 6, background: '#10b981', border: 'none', cursor: 'pointer', fontSize: 12, color: '#fff' }}>
                          Close
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── NCR Modal ── */}
      {ncrModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 500, maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Raise Non-Conformance Report</h3>
              <button onClick={() => setNcrModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {[
              ['GRN Reference', <select style={inp} value={ncrForm.grn_id} onChange={e => setNcrForm(f => ({ ...f, grn_id: e.target.value }))}>
                <option value="">Select GRN…</option>
                {grns.map(g => <option key={g.id} value={g.id}>{g.grn_number}</option>)}
              </select>],
              ['Vendor', <select style={inp} value={ncrForm.vendor_id} onChange={e => setNcrForm(f => ({ ...f, vendor_id: e.target.value }))}>
                <option value="">Select vendor…</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
              </select>],
            ].map(([label, field]) => (
              <div key={label} style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
                {field}
              </div>
            ))}

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Defect Description *</label>
              <textarea rows={3} style={{ ...inp, resize: 'vertical' }} value={ncrForm.defect_description}
                onChange={e => setNcrForm(f => ({ ...f, defect_description: e.target.value }))}
                placeholder="Describe the defect or non-conformance…" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Qty Affected</label>
                <input type="number" min={1} style={inp} value={ncrForm.quantity_affected}
                  onChange={e => setNcrForm(f => ({ ...f, quantity_affected: +e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Severity</label>
                <select style={inp} value={ncrForm.severity} onChange={e => setNcrForm(f => ({ ...f, severity: e.target.value }))}>
                  <option value="minor">Minor</option>
                  <option value="major">Major</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Disposition</label>
              <select style={inp} value={ncrForm.disposition} onChange={e => setNcrForm(f => ({ ...f, disposition: e.target.value }))}>
                <option value="return">Return to Vendor</option>
                <option value="rework">Rework</option>
                <option value="use_as_is">Use As-Is (with deviation)</option>
                <option value="scrap">Scrap</option>
              </select>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                <Paperclip size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Attachment (optional)
              </label>
              <input ref={ncrFileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx,.doc,.docx"
                onChange={e => setNcrFile(e.target.files[0] || null)}
                style={{ ...inp, padding: '6px 10px' }} />
              {ncrFile && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Paperclip size={11} /> {ncrFile.name}
                  <button type="button" onClick={() => { setNcrFile(null); if (ncrFileRef.current) ncrFileRef.current.value = ''; }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 0 }}>
                    <X size={11} />
                  </button>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button onClick={() => { setNcrModal(false); setNcrFile(null); }} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={saveNCR} disabled={saving}
                style={{ padding: '9px 20px', borderRadius: 8, background: '#ef4444', border: 'none', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                {saving ? 'Creating…' : 'Raise NCR'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
