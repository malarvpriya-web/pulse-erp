import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const fmt2 = (n) => parseFloat(n || 0).toFixed(2);
const fmtRs = (n) => `₹${parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const thStyle = { padding: '10px 16px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#6b7280', background: '#fafafa', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap' };
const tdStyle = { padding: '10px 16px', fontSize: 13, color: '#111827', borderBottom: '1px solid #f8f8fc' };
const tabStyle = (active) => ({ padding: '8px 20px', border: 'none', background: active ? '#6B3FDB' : 'transparent', color: active ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8, fontWeight: active ? 600 : 400, fontSize: 14 });
const cardStyle = { background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 16 };
const inputStyle = { width: '100%', padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' };

const REF_TYPES = ['manual', 'production_order', 'sales_order', 'project', 'maintenance'];

export default function MaterialConsumption() {
  const toast = useToast();
  const [activeTab, setActiveTab] = useState('by-project');
  const [byProject, setByProject] = useState([]);
  const [byType, setByType] = useState([]);
  const [allList, setAllList] = useState([]);
  const [loading, setLoading] = useState(false);

  // Filters for "All Allocations"
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Log Consumption modal
  const [showLog, setShowLog] = useState(false);
  const [logForm, setLogForm] = useState({ item_id: '', warehouse_id: '', quantity: '', reference_type: 'manual', reference_id: '', project_id: '', notes: '' });
  const [items, setItems] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [r1, r2, r3] = await Promise.allSettled([
      api.get('/inventory/consumption/by-project'),
      api.get('/inventory/consumption/by-type'),
      api.get('/inventory/consumption', { params: { start_date: startDate || undefined, end_date: endDate || undefined } }),
    ]);
    setByProject(r1.status === 'fulfilled' ? (r1.value.data || []) : []);
    setByType(r2.status === 'fulfilled' ? (r2.value.data || []) : []);
    setAllList(r3.status === 'fulfilled' ? (r3.value.data || []) : []);
    setLoading(false);
  }, [startDate, endDate]);

  useEffect(() => { load(); }, [load]);

  const openLogModal = async () => {
    setShowLog(true);
    try {
      const [ir, wr, pr] = await Promise.allSettled([
        api.get('/inventory/items'),
        api.get('/inventory/warehouses'),
        api.get('/projects').catch(() => ({ data: [] })),
      ]);
      setItems(ir.status === 'fulfilled' ? (ir.value.data?.items || ir.value.data || []) : []);
      setWarehouses(wr.status === 'fulfilled' ? (wr.value.data || []) : []);
      setProjects(pr.status === 'fulfilled' ? (pr.value.data?.projects || pr.value.data?.data || pr.value.data || []) : []);
    } catch { /* dropdowns empty is fine */ }
  };

  const submitLog = async () => {
    if (!logForm.item_id || !logForm.warehouse_id || !logForm.quantity) {
      toast.error('Item, warehouse, and quantity are required');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/inventory/consumption', {
        item_id: logForm.item_id,
        warehouse_id: logForm.warehouse_id,
        quantity: parseFloat(logForm.quantity),
        reference_type: logForm.reference_type,
        reference_id: logForm.reference_id || undefined,
        project_id: logForm.project_id || undefined,
        notes: logForm.notes || undefined,
      });
      toast.success('Consumption logged and stock deducted');
      setShowLog(false);
      setLogForm({ item_id: '', warehouse_id: '', quantity: '', reference_type: 'manual', reference_id: '', project_id: '', notes: '' });
      load();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to log consumption');
    } finally {
      setSubmitting(false);
    }
  };

  // Group by-type data by reference_type
  const grouped = byType.reduce((acc, row) => {
    const key = row.reference_type || 'manual';
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});

  return (
    <div style={{ padding: '24px', background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#111827', margin: 0 }}>Material Consumption</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 14 }}>Track material usage by project, type, and date</p>
        </div>
        <button onClick={openLogModal} style={{ padding: '10px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
          + Log Consumption
        </button>
      </div>

      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 24, width: 'fit-content' }}>
        {[['by-project', 'By Project'], ['by-type', 'By Type'], ['all-allocations', 'All Allocations']].map(([key, label]) => (
          <button key={key} style={tabStyle(activeTab === key)} onClick={() => setActiveTab(key)}>{label}</button>
        ))}
      </div>

      {activeTab === 'by-project' && (
        <div style={cardStyle}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
          ) : byProject.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>
              No project-linked consumption found. Log consumption with a project ID to see data here.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Project', 'Item Code', 'Item Name', 'Unit', 'Total Consumed', 'Avg Rate', 'Total Value', 'Transactions'].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byProject.map((row, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>
                      {row.project_name || row.project_code || `Project #${row.project_id}`}
                    </td>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{row.item_code}</td>
                    <td style={tdStyle}>{row.item_name}</td>
                    <td style={tdStyle}>{row.unit_of_measure}</td>
                    <td style={tdStyle}>{fmt2(row.total_consumed)}</td>
                    <td style={tdStyle}>{fmtRs(row.avg_rate)}</td>
                    <td style={{ ...tdStyle, fontWeight: 600, color: '#6B3FDB' }}>{fmtRs(row.total_value)}</td>
                    <td style={tdStyle}>{row.transaction_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === 'by-type' && (
        <div>
          {loading ? (
            <div style={{ ...cardStyle, padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
          ) : Object.keys(grouped).length === 0 ? (
            <div style={{ ...cardStyle, padding: 40, textAlign: 'center', color: '#6b7280' }}>No consumption records found.</div>
          ) : (
            Object.entries(grouped).map(([type, rows]) => (
              <div key={type} style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <span style={{ padding: '4px 14px', background: '#f0ebff', color: '#6B3FDB', borderRadius: 20, fontSize: 13, fontWeight: 600 }}>
                    {type.replace(/_/g, ' ').toUpperCase()}
                  </span>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>{rows.length} records</span>
                </div>
                <div style={cardStyle}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['Item', 'Warehouse', 'Reference ID', 'Quantity', 'Rate', 'Value', 'Date', 'Purpose'].map(h => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                          <td style={tdStyle}>{row.item_name} <span style={{ fontSize: 11, color: '#9ca3af' }}>({row.item_code})</span></td>
                          <td style={tdStyle}>{row.warehouse_name}</td>
                          <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{row.reference_id || '—'}</td>
                          <td style={tdStyle}>{fmt2(row.quantity)}</td>
                          <td style={tdStyle}>{fmtRs(row.rate)}</td>
                          <td style={{ ...tdStyle, fontWeight: 600 }}>{fmtRs(row.value)}</td>
                          <td style={tdStyle}>{row.allocation_date ? new Date(row.allocation_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                          <td style={tdStyle}>{row.purpose || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'all-allocations' && (
        <div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'flex-end' }}>
            <div>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>From Date</label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>To Date</label>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13 }} />
            </div>
            <button onClick={load} style={{ padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
              Apply Filter
            </button>
            {(startDate || endDate) && (
              <button onClick={() => { setStartDate(''); setEndDate(''); }}
                style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                Clear
              </button>
            )}
            <span style={{ fontSize: 13, color: '#6b7280', marginLeft: 'auto' }}>{allList.length} records</span>
          </div>

          <div style={cardStyle}>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Date', 'Item', 'Warehouse', 'Type', 'Reference', 'Project', 'Quantity', 'Rate', 'Value', 'Purpose'].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allList.length === 0 ? (
                    <tr><td colSpan={10} style={{ ...tdStyle, textAlign: 'center', color: '#9ca3af', padding: 32 }}>No records found</td></tr>
                  ) : allList.map((row, i) => (
                    <tr key={row.id || i} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                      <td style={tdStyle}>{row.allocation_date ? new Date(row.allocation_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                      <td style={tdStyle}>{row.item_name} <span style={{ fontSize: 11, color: '#9ca3af' }}>({row.item_code})</span></td>
                      <td style={tdStyle}>{row.warehouse_name}</td>
                      <td style={tdStyle}>
                        <span style={{ padding: '2px 8px', background: '#f0ebff', color: '#6B3FDB', borderRadius: 4, fontSize: 11 }}>
                          {(row.reference_type || row.allocation_type || 'manual').replace(/_/g, ' ')}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{row.reference_id || '—'}</td>
                      <td style={tdStyle}>{row.project_name || (row.project_id ? `#${row.project_id}` : '—')}</td>
                      <td style={tdStyle}>{fmt2(row.quantity)}</td>
                      <td style={tdStyle}>{fmtRs(row.rate)}</td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{fmtRs(parseFloat(row.quantity || 0) * parseFloat(row.rate || 0))}</td>
                      <td style={tdStyle}>{row.purpose || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {showLog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, width: 520, maxHeight: '90vh', overflow: 'auto' }}>
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #f0f0f4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Log Consumption</h2>
              <button onClick={() => setShowLog(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280' }}>✕</button>
            </div>
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Item *</label>
                <select value={logForm.item_id} onChange={e => setLogForm(p => ({ ...p, item_id: e.target.value }))} style={inputStyle}>
                  <option value="">Select item…</option>
                  {items.map(it => <option key={it.id} value={it.id}>{it.item_name} ({it.item_code})</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Warehouse *</label>
                <select value={logForm.warehouse_id} onChange={e => setLogForm(p => ({ ...p, warehouse_id: e.target.value }))} style={inputStyle}>
                  <option value="">Select warehouse…</option>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{w.warehouse_name || w.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Quantity *</label>
                <input type="number" min="0.01" step="0.01" placeholder="0.00" value={logForm.quantity}
                  onChange={e => setLogForm(p => ({ ...p, quantity: e.target.value }))} style={inputStyle} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Reference Type</label>
                  <select value={logForm.reference_type} onChange={e => setLogForm(p => ({ ...p, reference_type: e.target.value }))} style={inputStyle}>
                    {REF_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Reference ID</label>
                  <input type="text" placeholder="e.g. PO-1234" value={logForm.reference_id}
                    onChange={e => setLogForm(p => ({ ...p, reference_id: e.target.value }))} style={inputStyle} />
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Project</label>
                <select value={logForm.project_id} onChange={e => setLogForm(p => ({ ...p, project_id: e.target.value }))} style={inputStyle}>
                  <option value="">— No project —</option>
                  {projects.map(pr => <option key={pr.id} value={pr.id}>{pr.project_name} {pr.project_code ? `(${pr.project_code})` : ''}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: '#6b7280', display: 'block', marginBottom: 4 }}>Notes</label>
                <textarea rows={2} placeholder="Reason for consumption…" value={logForm.notes}
                  onChange={e => setLogForm(p => ({ ...p, notes: e.target.value }))}
                  style={{ ...inputStyle, resize: 'vertical' }} />
              </div>
            </div>
            <div style={{ padding: '16px 24px', borderTop: '1px solid #f0f0f4', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowLog(false)} style={{ padding: '8px 16px', background: '#f5f3ff', color: '#6b7280', border: '1px solid #e9e4ff', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}>
                Cancel
              </button>
              <button onClick={submitLog} disabled={submitting}
                style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                {submitting ? 'Saving…' : 'Log Consumption'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
