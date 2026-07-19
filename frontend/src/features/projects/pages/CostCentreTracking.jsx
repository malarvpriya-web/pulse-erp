import { useEffect, useState, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const P = '#6B3FDB';
const LIGHT = '#f5f3ff';
const BORDER = '#e9e4ff';

const cr = (n) => {
  const v = parseFloat(n || 0);
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

const EMPTY_CC = { code: '', name: '', department: '', description: '' };
const TABS = ['Cost Centres', 'Unallocated Costs', 'Cost by Department'];

export default function CostCentreTracking({ setPage }) {
  const toast = useToast();
  const [tab, setTab]               = useState('Cost Centres');
  const [centers, setCenters]       = useState([]);
  const [unallocated, setUnallocated] = useState(null);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [form, setForm]             = useState(EMPTY_CC);
  const [editId, setEditId]         = useState(null);
  const [saving, setSaving]         = useState(false);
  const [depts, setDepts]           = useState([]);
  const [txByCC, setTxByCC]         = useState([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [ccRes, uaRes, deptRes, txRes] = await Promise.allSettled([
        api.get('/project-cost-engine/cost-centers'),
        api.get('/project-cost-engine/unallocated'),
        api.get('/admin/config/departments').catch(() => api.get('/orgchart/departments').catch(() => ({ data: [] }))),
        api.get('/project-cost-engine/transactions', { params: { limit: 500 } }),
      ]);

      if (ccRes.status === 'fulfilled') setCenters(ccRes.value.data);
      if (uaRes.status === 'fulfilled') setUnallocated(uaRes.value.data);

      if (deptRes.status === 'fulfilled') {
        const d = deptRes.value.data;
        const raw = Array.isArray(d) ? d : (d?.data || d?.departments || []);
        setDepts(raw.map(item => typeof item === 'string' ? { id: item, name: item } : item));
      }

      if (txRes.status === 'fulfilled') {
        const rows = txRes.value.data.rows || txRes.value.data || [];
        // Group by cost_centre for dept analysis
        const byCostType = {};
        rows.forEach(r => {
          const dept = r.cost_center_name || 'Unassigned';
          if (!byCostType[dept]) byCostType[dept] = { name: dept, total: 0, count: 0 };
          byCostType[dept].total += parseFloat(r.amount || 0);
          byCostType[dept].count += 1;
        });
        setTxByCC(Object.values(byCostType).sort((a, b) => b.total - a.total));
      }
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed to load cost centre data'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editId) {
        await api.put(`/project-cost-engine/cost-centers/${editId}`, form);
      } else {
        await api.post('/project-cost-engine/cost-centers', form);
      }
      setShowForm(false);
      setForm(EMPTY_CC);
      setEditId(null);
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  const handleEdit = (cc) => {
    setForm({ code: cc.code, name: cc.name, department: cc.department || '', description: cc.description || '' });
    setEditId(cc.id);
    setShowForm(true);
  };

  const maxSpend = Math.max(...centers.map(c => parseFloat(c.total_spend || 0)), 1);
  const uaRows   = unallocated?.unallocated_costs || [];
  const maxCC    = txByCC[0]?.total || 1;

  return (
    <div style={{ padding: 24 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111' }}>Cost Centre Tracking</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Every cost linked to Department · Cost Centre · Project · Customer · Site · PO
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setPage?.('CostTransactions')}
            style={{ padding: '8px 14px', background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 8, color: P, fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
            ← Transactions
          </button>
          <button onClick={() => { setForm(EMPTY_CC); setEditId(null); setShowForm(true); }}
            style={{ padding: '8px 16px', background: P, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
            + Cost Centre
          </button>
        </div>
      </div>

      {/* Unallocated Alert */}
      {(unallocated?.count || 0) > 0 && (
        <div style={{ marginBottom: 16, padding: '12px 16px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 700, color: '#92400e', fontSize: 14 }}>
              ⚠ {unallocated.count} UNALLOCATED COSTS — {cr(unallocated.total_unallocated)}
            </div>
            <div style={{ color: '#78350f', fontSize: 12, marginTop: 2 }}>
              These expenses are not linked to Customer / Project / PO / Cost Centre. Review and assign them.
            </div>
          </div>
          <button onClick={() => setTab('Unallocated Costs')}
            style={{ padding: '6px 14px', background: '#92400e', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
            Review Now
          </button>
        </div>
      )}

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Cost Centres', value: centers.length, color: P },
          { label: 'Total Tracked Spend', value: cr(centers.reduce((s, c) => s + parseFloat(c.total_spend || 0), 0)), color: '#059669' },
          { label: 'Unallocated Costs', value: unallocated?.count || 0, color: '#dc2626', warn: (unallocated?.count || 0) > 0 },
          { label: 'Unallocated Amount', value: cr(unallocated?.total_unallocated || 0), color: '#dc2626', warn: (unallocated?.total_unallocated || 0) > 0 },
          { label: 'Departments Tracked', value: new Set(centers.map(c => c.department).filter(Boolean)).size, color: '#2563eb' },
        ].map(card => (
          <div key={card.label} style={{
            background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12,
            padding: '14px 16px', borderLeft: `4px solid ${card.warn ? '#dc2626' : card.color}`,
          }}>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>{card.label}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: card.warn ? '#dc2626' : '#111', marginTop: 4 }}>{card.value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `2px solid ${BORDER}`, marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '8px 16px', border: 'none', background: 'none',
            borderBottom: tab === t ? `2px solid ${P}` : '2px solid transparent',
            color: tab === t ? P : '#6b7280', fontWeight: tab === t ? 600 : 400,
            cursor: 'pointer', fontSize: 13, marginBottom: -2,
          }}>{t}</button>
        ))}
      </div>

      {/* ── Cost Centres tab ── */}
      {tab === 'Cost Centres' && (
        <div>
          {showForm && (
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14 }}>{editId ? 'Edit Cost Centre' : 'New Cost Centre'}</div>
              <form onSubmit={handleSubmit}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                  {[
                    { field: 'code', label: 'Code *', required: true },
                    { field: 'name', label: 'Name *', required: true },
                    { field: 'department', label: 'Department' },
                    { field: 'description', label: 'Description' },
                  ].map(({ field, label, required }) => (
                    <div key={field}>
                      <label style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{label}</label>
                      <input
                        value={form[field]} required={required}
                        onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
                        style={{ display: 'block', width: '100%', marginTop: 4, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
                  <button type="submit" disabled={saving}
                    style={{ padding: '8px 18px', background: P, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
                    {saving ? 'Saving…' : editId ? 'Update' : 'Create'}
                  </button>
                  <button type="button" onClick={() => { setShowForm(false); setForm(EMPTY_CC); setEditId(null); }}
                    style={{ padding: '8px 14px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
          ) : centers.length === 0 ? (
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              No cost centres defined yet. Click <strong>+ Cost Centre</strong> to add one.
              <div style={{ marginTop: 8, fontSize: 12 }}>Examples: SALES-DEPT · ENG-DEPT · PROD-DEPT · SERVICE-DEPT · CORP</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
              {centers.map(cc => {
                const spendPct = maxSpend > 0 ? Math.min(100, (parseFloat(cc.total_spend || 0) / maxSpend) * 100) : 0;
                return (
                  <div key={cc.id} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15, color: '#111' }}>{cc.code}</div>
                        <div style={{ fontSize: 13, color: '#374151', marginTop: 2 }}>{cc.name}</div>
                        {cc.department && (
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                            <span style={{ background: LIGHT, color: P, borderRadius: 8, padding: '1px 7px', fontSize: 11 }}>{cc.department}</span>
                          </div>
                        )}
                      </div>
                      <button onClick={() => handleEdit(cc)}
                        style={{ padding: '3px 10px', background: LIGHT, border: `1px solid ${BORDER}`, borderRadius: 6, color: P, cursor: 'pointer', fontSize: 12 }}>
                        Edit
                      </button>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#374151', marginBottom: 6 }}>
                      <span>{cc.tx_count || 0} transactions</span>
                      <span style={{ fontWeight: 700, color: '#111' }}>{cr(cc.total_spend)}</span>
                    </div>
                    <div style={{ background: '#f3f4f6', borderRadius: 4, height: 6 }}>
                      <div style={{ width: `${spendPct}%`, background: P, height: '100%', borderRadius: 4 }} />
                    </div>
                    {cc.description && (
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>{cc.description}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Unallocated Costs tab ── */}
      {tab === 'Unallocated Costs' && (
        <div>
          <div style={{ marginBottom: 14, color: '#374151', fontSize: 13 }}>
            <strong>Validation Rule:</strong> Every cost must be linked to Customer · Project · PO · Cost Centre. Costs missing any of these are flagged as UNALLOCATED.
          </div>
          {uaRows.length === 0 ? (
            <div style={{ background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 12, padding: 48, textAlign: 'center', color: '#059669', fontSize: 14 }}>
              ✓ No unallocated costs — all expenses are properly linked!
            </div>
          ) : (
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: '#92400e' }}>
                  {uaRows.length} Unallocated Costs — {cr(unallocated?.total_unallocated)}
                </div>
                <span style={{ fontSize: 12, color: '#6b7280' }}>Resolve by editing each entry in Cost Transactions</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#fafafa', borderBottom: `1px solid ${BORDER}` }}>
                      {['Date','Cost Type','Description','Amount','Missing Fields','Added By'].map(h => (
                        <th key={h} style={{ padding: '10px 12px', textAlign: h === 'Amount' ? 'right' : 'left', fontWeight: 600, color: '#374151' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {uaRows.map((r, i) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fffbeb' : '#fef9c3' }}>
                        <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: '#374151' }}>{r.transaction_date?.slice(0, 10)}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 10, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>
                            {r.cost_type?.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px', color: '#374151', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {r.description || '—'}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 600, color: '#dc2626' }}>{cr(r.amount)}</td>
                        <td style={{ padding: '9px 12px', color: '#92400e', fontSize: 12 }}>{r.unallocated_reason}</td>
                        <td style={{ padding: '9px 12px', color: '#374151' }}>{r.created_by_name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: `2px solid ${BORDER}`, background: '#fafafa' }}>
                      <td colSpan={3} style={{ padding: '10px 12px', fontWeight: 600 }}>Total Unallocated</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{cr(unallocated?.total_unallocated)}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Cost by Department tab ── */}
      {tab === 'Cost by Department' && (
        <div>
          {txByCC.length === 0 ? (
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              No cost centre data yet. Add transactions with cost centres assigned to see breakdown here.
            </div>
          ) : (
            <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 16 }}>Spend by Cost Centre / Department</div>
              {txByCC.map((item, i) => {
                const pctVal = maxCC > 0 ? Math.min(100, (item.total / maxCC) * 100) : 0;
                return (
                  <div key={item.name} style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                      <span style={{ fontWeight: 500, color: '#111' }}>{item.name}</span>
                      <span style={{ display: 'flex', gap: 12, color: '#374151' }}>
                        <span style={{ color: '#6b7280' }}>{item.count} entries</span>
                        <span style={{ fontWeight: 700, color: '#111' }}>{cr(item.total)}</span>
                      </span>
                    </div>
                    <div style={{ background: '#f3f4f6', borderRadius: 6, height: 18, overflow: 'hidden' }}>
                      <div style={{
                        width: `${pctVal}%`, background: [P, '#2563eb', '#0891b2', '#d97706', '#dc2626', '#059669'][i % 6],
                        height: '100%', borderRadius: 6, display: 'flex', alignItems: 'center', paddingLeft: 8,
                      }}>
                        {pctVal > 15 && <span style={{ fontSize: 10, color: '#fff', fontWeight: 600 }}>{pctVal.toFixed(0)}%</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
