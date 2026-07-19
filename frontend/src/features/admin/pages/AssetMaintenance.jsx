// frontend/src/features/admin/pages/AssetMaintenance.jsx
import { useState, useEffect, useCallback } from 'react';
import { BarChart2, Wrench, Calendar, Clipboard, Package } from 'lucide-react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

function EmptyState({ icon: Icon, title, sub, action }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '48px 24px', textAlign: 'center', gap: 8,
      background: 'var(--color-background-secondary)',
      borderRadius: 'var(--border-radius-lg)',
      border: '0.5px solid var(--color-border-tertiary)',
    }}>
      {Icon && <Icon size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 4 }} />}
      <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--color-text-primary)', margin: 0 }}>{title}</p>
      {sub && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>{sub}</p>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

function FetchError({ msg, onRetry }) {
  return (
    <div style={{ padding: '32px', textAlign: 'center' }}>
      <p style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{msg}</p>
      <button onClick={onRetry} style={{
        background: '#6B3FDB', color: '#fff', border: 'none',
        borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
      }}>Retry</button>
    </div>
  );
}

function LoadingRows() {
  return (
    <div style={{ padding: '40px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
      Loading…
    </div>
  );
}

function formatINR(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '₹0';
  if (num >= 100000) return `₹${(num/100000).toFixed(2)}L`;
  return `₹${Math.round(num).toLocaleString('en-IN')}`;
}

/* ══════════════════
   TAB 1 — Schedule
══════════════════ */
function ScheduleTab() {
  const toast = useToast();
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showLogForm, setShowLog] = useState(null);
  const [logForm, setLogForm] = useState({ description: '', done_by: '', cost: '' });
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [assets, setAssets] = useState([]);
  const [addForm, setAddForm] = useState({ asset_id: '', maintenance_type: 'preventive', frequency_days: 90, next_due_date: '' });
  const [addSaving, setAddSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [schRes, astRes] = await Promise.allSettled([
        api.get('/maintenance/schedule'),
        api.get('/maintenance/assets'),
      ]);
      setSchedule(schRes.status === 'fulfilled' ? (schRes.value.data || []) : []);
      if (astRes.status === 'fulfilled') setAssets(astRes.value.data || []);
      if (schRes.status !== 'fulfilled') {
        setError(schRes.reason?.response?.data?.error || schRes.reason?.message || 'Failed to load schedules');
      }
    } catch (e) {
      setSchedule([]);
      setError(e?.response?.data?.error || e?.message || 'Failed to load maintenance schedules');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const logWork = async (item) => {
    setSaving(true);
    try {
      await api.post('/maintenance/logs', {
        asset_id: item.asset_id || item.id,
        schedule_id: item.id,
        log_type: item.maintenance_type,
        ...logForm,
        start_time: new Date().toISOString(),
      });
      setShowLog(null); setLogForm({ description: '', done_by: '', cost: '' });
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to log maintenance work');
      setShowLog(null);
    }
    setSaving(false);
  };

  const addSchedule = async () => {
    if (!addForm.asset_id || !addForm.next_due_date) {
      toast.error('Asset and next due date are required');
      return;
    }
    setAddSaving(true);
    try {
      await api.post('/maintenance/schedule', addForm);
      setShowAddForm(false);
      setAddForm({ asset_id: '', maintenance_type: 'preventive', frequency_days: 90, next_due_date: '' });
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to create schedule');
    }
    setAddSaving(false);
  };

  const typeStyle = (t) => t === 'preventive'
    ? { bg: '#dbeafe', color: '#2563eb' }
    : t === 'breakdown'
      ? { bg: '#fee2e2', color: '#dc2626' }
      : { bg: '#fef3c7', color: '#d97706' };

  if (loading) return <LoadingRows />;
  if (error) return <FetchError msg={error} onRetry={load} />;

  if (schedule.length === 0 && !showAddForm) return (
    <>
      <EmptyState
        icon={Calendar}
        title="No maintenance schedules yet."
        sub="Add your first preventive maintenance task."
        action={
          <button
            onClick={() => setShowAddForm(true)}
            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            + Add Schedule
          </button>
        }
      />
    </>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={() => setShowAddForm(v => !v)}
          style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
          {showAddForm ? '✕ Cancel' : '+ Add Schedule'}
        </button>
      </div>

      {showAddForm && (
        <div style={{ background: '#faf5ff', border: '1px solid #a78bfa', borderRadius: 10, padding: 16, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Asset</label>
              <select value={addForm.asset_id} onChange={e => setAddForm(f => ({ ...f, asset_id: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                <option value=''>Select asset…</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.asset_code} — {a.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Type</label>
              <select value={addForm.maintenance_type} onChange={e => setAddForm(f => ({ ...f, maintenance_type: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                <option value='preventive'>Preventive</option>
                <option value='inspection'>Inspection</option>
                <option value='calibration'>Calibration</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Frequency (days)</label>
              <input type='number' value={addForm.frequency_days} onChange={e => setAddForm(f => ({ ...f, frequency_days: parseInt(e.target.value) || 90 }))}
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Next Due Date</label>
              <input type='date' value={addForm.next_due_date} onChange={e => setAddForm(f => ({ ...f, next_due_date: e.target.value }))}
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={addSchedule} disabled={addSaving}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
              {addSaving ? 'Saving…' : 'Save Schedule'}
            </button>
            <button onClick={() => setShowAddForm(false)}
              style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {schedule.map(item => {
          const ts = typeStyle(item.maintenance_type);
          return (
            <div key={item.id}>
              <div style={{ padding: '14px 16px', border: `1px solid ${item.overdue ? '#fecaca' : '#e9e4ff'}`, borderRadius: 10, background: item.overdue ? '#fff5f5' : '#fff', display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, color: '#1f2937', fontSize: 13 }}>{item.asset_name}</span>
                    <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 8, fontWeight: 700, background: ts.bg, color: ts.color }}>
                      {item.maintenance_type}
                    </span>
                    {item.overdue && <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 8, fontWeight: 700, background: '#fee2e2', color: '#dc2626' }}>OVERDUE</span>}
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>
                    {item.asset_code} · {item.category} · Assigned: {item.assigned_to}
                  </div>
                  <div style={{ fontSize: 11, color: item.overdue ? '#dc2626' : '#374151', fontWeight: 600, marginTop: 3 }}>
                    Due: {item.next_due_date}
                    {item.days_until < 0
                      ? ` (${Math.abs(item.days_until)} days overdue)`
                      : ` (in ${item.days_until} days)`}
                  </div>
                </div>
                <button onClick={() => setShowLog(item.id)}
                  style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 12, flexShrink: 0 }}>
                  Log Work
                </button>
              </div>
              {showLogForm === item.id && (
                <div style={{ padding: 14, background: '#faf5ff', border: '1px solid #a78bfa', borderTop: 'none', borderRadius: '0 0 10px 10px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                    <input value={logForm.description} onChange={e => setLogForm(f => ({ ...f, description: e.target.value }))} placeholder="Work done description"
                      style={{ padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                    <input value={logForm.done_by} onChange={e => setLogForm(f => ({ ...f, done_by: e.target.value }))} placeholder="Technician name"
                      style={{ padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                    <input type="number" value={logForm.cost} onChange={e => setLogForm(f => ({ ...f, cost: e.target.value }))} placeholder="Cost ₹"
                      style={{ padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => logWork(item)} disabled={saving}
                      style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 12 }}>
                      {saving ? 'Saving…' : 'Save Log'}
                    </button>
                    <button onClick={() => setShowLog(null)}
                      style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════
   TAB 2 — Work Logs
══════════════════ */
function WorkLogsTab() {
  const toast = useToast();
  const [logs, setLogs] = useState([]);
  const [assets, setAssets] = useState([]);
  const [showNew, setNew] = useState(false);
  const [form, setForm] = useState({ asset_id: '', log_type: 'breakdown', description: '', done_by: '', parts_used: [] });
  const [_completing, setComp] = useState(null);

  const load = useCallback(async () => {
    try {
      const [lRes, aRes] = await Promise.allSettled([
        api.get('/maintenance/logs'),
        api.get('/maintenance/assets'),
      ]);
      if (lRes.status === 'fulfilled') setLogs(lRes.value.data || []);
      if (aRes.status === 'fulfilled') setAssets(aRes.value.data || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createLog = async () => {
    try {
      await api.post('/maintenance/logs', { ...form, start_time: new Date().toISOString() });
      setNew(false); setForm({ asset_id: '', log_type: 'breakdown', description: '', done_by: '', parts_used: [] });
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to create maintenance log');
      setNew(false);
      load();
    }
  };

  const complete = async (logId) => {
    try {
      await api.put(`/maintenance/logs/${logId}/complete`, { end_time: new Date().toISOString(), cost: 0 });
      setComp(null); load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to mark log as complete');
      setComp(null);
      load();
    }
  };

  const statusStyle = (s) => s === 'completed' ? { bg: '#d1fae5', color: '#16a34a' } : s === 'in-progress' ? { bg: '#dbeafe', color: '#2563eb' } : { bg: '#fef3c7', color: '#d97706' };
  const typeStyle = (t) => t === 'breakdown' ? '#dc2626' : t === 'preventive' ? '#2563eb' : '#d97706';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={() => setNew(n => !n)}
          style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
          {showNew ? '✕ Cancel' : '+ New Breakdown Log'}
        </button>
      </div>

      {showNew && (
        <div style={{ background: '#fff5f5', border: '1px solid #fecaca', borderRadius: 10, padding: 16, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Asset</label>
              <select value={form.asset_id} onChange={e => setForm(f => ({ ...f, asset_id: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                <option value=''>Select asset…</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.asset_code} — {a.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Type</label>
              <select value={form.log_type} onChange={e => setForm(f => ({ ...f, log_type: e.target.value }))}
                style={{ width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                <option value='breakdown'>Breakdown</option>
                <option value='preventive'>Preventive</option>
                <option value='inspection'>Inspection</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>Assigned To</label>
              <input value={form.done_by} onChange={e => setForm(f => ({ ...f, done_by: e.target.value }))} placeholder="Technician"
                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
            </div>
          </div>
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Problem description / work to be done…" rows={2}
            style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13, resize: 'vertical', marginBottom: 10 }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={createLog}
              style={{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
              Create Log
            </button>
            <button onClick={() => setNew(false)}
              style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {logs.length === 0 ? (
        <EmptyState
          icon={Clipboard}
          title="No work logs recorded."
          sub="Logs appear here after maintenance tasks are completed."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {logs.map(log => {
            const ss = statusStyle(log.status);
            return (
              <div key={log.id} style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: '#1f2937', fontSize: 13 }}>{log.asset_name}</span>
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 8, fontWeight: 700, color: typeStyle(log.log_type),
                        background: log.log_type === 'breakdown' ? '#fee2e2' : log.log_type === 'preventive' ? '#dbeafe' : '#fef3c7' }}>
                        {log.log_type}
                      </span>
                      <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 8, fontWeight: 700, background: ss.bg, color: ss.color }}>
                        {log.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: '#374151', marginBottom: 4 }}>{log.description}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>
                      {log.done_by} · Started: {new Date(log.start_time).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                      {log.downtime_hrs != null && ` · Downtime: ${log.downtime_hrs}h`}
                      {parseFloat(log.cost) > 0 && ` · Cost: ${formatINR(log.cost)}`}
                    </div>
                    {(log.parts_used || []).length > 0 && (
                      <div style={{ fontSize: 11, color: '#6B3FDB', marginTop: 4 }}>
                        Parts: {(log.parts_used || []).map(p => `${p.name} ×${p.qty}`).join(', ')}
                      </div>
                    )}
                  </div>
                  {log.status !== 'completed' && (
                    <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginLeft: 12 }}>
                      {log.status === 'open' && (
                        <button onClick={() => api.put(`/maintenance/logs/${log.id}`, { status: 'in-progress' }).catch(e => toast.error(e?.response?.data?.error || 'Failed to start log'))}
                          style={{ background: '#dbeafe', color: '#2563eb', border: 'none', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 11 }}>
                          Start
                        </button>
                      )}
                      <button onClick={() => complete(log.id)}
                        style={{ background: '#d1fae5', color: '#16a34a', border: 'none', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 11 }}>
                        Complete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══════════════════
   TAB 3 — Spare Parts
══════════════════ */
function SparePartsTab() {
  const toast = useToast();
  const [parts, setParts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [issueForm, setIssue] = useState(null);
  const [issueQty, setIssueQty] = useState('');
  const [msg, setMsg] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', category: '', unit: 'Nos', unit_cost: '', stock_qty: '', reorder_level: '' });
  const [addSaving, setAddSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await api.get('/maintenance/spare-parts');
      setParts(res.data || []);
    } catch (e) {
      setParts([]);
      setError(e?.response?.data?.error || e?.message || 'Failed to load spare parts');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const issue = async (part) => {
    if (!issueQty) return;
    try {
      await api.post('/maintenance/spare-parts/issue', { part_id: part.id, qty: parseFloat(issueQty) });
      setParts(prev => prev.map(p => p.id === part.id
        ? { ...p, stock_qty: Math.max(0, parseFloat(p.stock_qty) - parseFloat(issueQty)), low_stock: (Math.max(0, parseFloat(p.stock_qty) - parseFloat(issueQty))) <= parseFloat(p.reorder_level) }
        : p));
      setMsg(`✓ Issued ${issueQty} ${part.unit} of ${part.name}`);
      setIssue(null); setIssueQty('');
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to issue spare part');
      setIssue(null);
    }
    setTimeout(() => setMsg(''), 3000);
  };

  const addPart = async () => {
    if (!addForm.name) { toast.error('Part name is required'); return; }
    setAddSaving(true);
    try {
      await api.post('/maintenance/spare-parts', {
        ...addForm,
        unit_cost: parseFloat(addForm.unit_cost) || 0,
        stock_quantity: parseFloat(addForm.stock_qty) || 0,
        reorder_level: parseFloat(addForm.reorder_level) || 0,
      });
      setShowAddForm(false);
      setAddForm({ name: '', category: '', unit: 'Nos', unit_cost: '', stock_qty: '', reorder_level: '' });
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || e?.message || 'Failed to add spare part');
    }
    setAddSaving(false);
  };

  if (loading) return <LoadingRows />;
  if (error) return <FetchError msg={error} onRetry={load} />;

  if (parts.length === 0 && !showAddForm) return (
    <EmptyState
      icon={Package}
      title="No spare parts catalogued."
      sub="Add parts used in maintenance."
      action={
        <button
          onClick={() => setShowAddForm(true)}
          style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
          + Add Part
        </button>
      }
    />
  );

  return (
    <div>
      {msg && <div style={{ marginBottom: 12, padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600, background: '#d1fae5', color: '#16a34a' }}>{msg}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button onClick={() => setShowAddForm(v => !v)}
          style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '7px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
          {showAddForm ? '✕ Cancel' : '+ Add Part'}
        </button>
      </div>

      {showAddForm && (
        <div style={{ background: '#faf5ff', border: '1px solid #a78bfa', borderRadius: 10, padding: 16, marginBottom: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
            {[
              { label: 'Part Name *', key: 'name', placeholder: 'e.g. IGBT Module' },
              { label: 'Category', key: 'category', placeholder: 'e.g. Electrical' },
              { label: 'Unit', key: 'unit', placeholder: 'Nos / m / kg' },
              { label: 'Unit Cost ₹', key: 'unit_cost', placeholder: '0', type: 'number' },
              { label: 'Opening Stock', key: 'stock_qty', placeholder: '0', type: 'number' },
              { label: 'Reorder Level', key: 'reorder_level', placeholder: '0', type: 'number' },
            ].map(({ label, key, placeholder, type }) => (
              <div key={key}>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#4c1d95', marginBottom: 3 }}>{label}</label>
                <input type={type || 'text'} value={addForm[key]} onChange={e => setAddForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={addPart} disabled={addSaving}
              style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, padding: '7px 18px', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>
              {addSaving ? 'Saving…' : 'Save Part'}
            </button>
            <button onClick={() => setShowAddForm(false)}
              style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f5f3ff' }}>
            {['Part Code', 'Name', 'Compatible With', 'Stock', 'Reorder Level', 'Unit Cost', ''].map(h => (
              <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, fontSize: 12 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {parts.map(p => (
            <tr key={p.id} style={{ borderBottom: '1px solid #f0ebff', background: p.low_stock ? '#fffbeb' : '#fff' }}>
              <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontSize: 12, color: '#6b7280' }}>{p.part_code || p.part_number || '—'}</td>
              <td style={{ padding: '9px 12px', fontWeight: 600, color: '#1f2937' }}>
                {p.name}
                {p.low_stock && <span style={{ marginLeft: 8, fontSize: 10, background: '#fef3c7', color: '#d97706', padding: '1px 6px', borderRadius: 6, fontWeight: 700 }}>Low Stock</span>}
              </td>
              <td style={{ padding: '9px 12px', fontSize: 11 }}>
                {(typeof p.compatible_assets === 'string' ? JSON.parse(p.compatible_assets || '[]') : p.compatible_assets || []).map(a => (
                  <span key={a} style={{ background: '#f5f3ff', color: '#6B3FDB', fontSize: 10, padding: '1px 6px', borderRadius: 6, marginRight: 3 }}>{a}</span>
                ))}
              </td>
              <td style={{ padding: '9px 12px', fontWeight: 700, color: p.low_stock ? '#d97706' : '#16a34a' }}>
                {p.stock_qty} {p.unit}
              </td>
              <td style={{ padding: '9px 12px', color: '#6b7280' }}>{p.reorder_level} {p.unit}</td>
              <td style={{ padding: '9px 12px', fontWeight: 600 }}>{formatINR(p.unit_cost)}</td>
              <td style={{ padding: '9px 12px' }}>
                {issueForm === p.id ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type="number" value={issueQty} min={1} max={p.stock_qty} onChange={e => setIssueQty(e.target.value)}
                      style={{ width: 50, padding: '4px 6px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 12 }} />
                    <button onClick={() => issue(p)}
                      style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11 }}>✓</button>
                    <button onClick={() => setIssue(null)}
                      style={{ background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, padding: '4px 6px', cursor: 'pointer', fontSize: 11 }}>✕</button>
                  </div>
                ) : (
                  <button onClick={() => setIssue(p.id)}
                    style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 7, padding: '4px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                    Issue
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ══════════════════
   TAB 4 — Analytics
══════════════════ */
function AnalyticsTab() {
  const [kpis, setKPIs] = useState({ assets_due_maintenance: 0, open_breakdowns: 0, mttr_hrs: 0, maintenance_cost_mtd: 0, top_breakdown_assets: [] });
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [dashRes, analyticsRes] = await Promise.allSettled([
        api.get('/maintenance/dashboard'),
        api.get('/maintenance/analytics'),
      ]);
      if (dashRes.status === 'fulfilled' && dashRes.value.data) setKPIs(dashRes.value.data);
      if (analyticsRes.status === 'fulfilled' && analyticsRes.value.data) {
        setAnalytics(analyticsRes.value.data);
      } else {
        setAnalytics(null);
      }
      if (dashRes.status !== 'fulfilled' && analyticsRes.status !== 'fulfilled') {
        const err = dashRes.reason?.response?.data?.error || dashRes.reason?.message || 'Failed to load analytics';
        setError(err);
      }
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || 'Failed to load analytics');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingRows />;
  if (error) return <FetchError msg={error} onRetry={load} />;

  return (
    <div>
      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 14, marginBottom: 22 }}>
        {[
          { label: 'Assets Due (7 days)', value: kpis.assets_due_maintenance, color: '#d97706', bg: '#fef3c7' },
          { label: 'Open Breakdowns', value: kpis.open_breakdowns, color: '#dc2626', bg: '#fee2e2' },
          { label: 'MTTR (hrs)', value: `${kpis.mttr_hrs}h`, color: '#6B3FDB', bg: '#ede9fe' },
          { label: 'Maintenance Cost MTD', value: formatINR(kpis.maintenance_cost_mtd), color: '#2563eb', bg: '#dbeafe' },
        ].map(({ label, value, color, bg }) => (
          <div key={label} style={{ padding: '14px 16px', background: bg, borderRadius: 10 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
            <div style={{ fontSize: 12, color: '#374151', fontWeight: 600, marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {analytics === null ? (
        <EmptyState icon={BarChart2} title="No analytics data yet." sub="Data will appear once maintenance schedules and work logs are added." />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 }}>
            {/* MTTR by Category */}
            <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 16 }}>
              <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 13 }}>MTTR by Category (hours)</h4>
              <div style={{ height: 180 }}>
                {analytics.mttr.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: 13 }}>No repair data yet</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analytics.mttr} layout="vertical" margin={{ top: 4, right: 30, left: 10, bottom: 4 }}>
                      <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `${v}h`} />
                      <YAxis type="category" dataKey="category" tick={{ fontSize: 10 }} width={90} />
                      <Tooltip formatter={v => [`${v}h`, 'Avg Repair Time']} />
                      <Bar dataKey="mttr" fill="#6B3FDB" radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 10, formatter: v => `${v}h` }} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Cost Trend */}
            <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 16 }}>
              <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 13 }}>Maintenance Cost Trend (6 months)</h4>
              <div style={{ height: 180 }}>
                {analytics.cost_trend.length === 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: 13 }}>No cost data yet</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={analytics.cost_trend} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                      <XAxis dataKey="month" tick={{ fontSize: 9 }} />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={v => [formatINR(v), 'Cost']} />
                      <Line type="monotone" dataKey="cost" stroke="#6B3FDB" strokeWidth={2} dot={{ r: 4, fill: '#6B3FDB' }} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          {/* Top Breakdown Assets */}
          <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 16 }}>
            <h4 style={{ margin: '0 0 12px', color: '#4c1d95', fontSize: 13 }}>Top Assets by Breakdown Frequency (12 months)</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {analytics.top_breakdowns.length === 0 ? (
                <div style={{ color: '#9ca3af', fontSize: 13, padding: '12px 0', textAlign: 'center' }}>No breakdown records yet</div>
              ) : analytics.top_breakdowns.map((a, i) => (
                <div key={a.asset_code || i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: '#faf9ff', borderRadius: 8 }}>
                  <div style={{ width: 24, height: 24, borderRadius: '50%', background: i === 0 ? '#fee2e2' : i === 1 ? '#fef3c7' : '#f3f4f6', color: i === 0 ? '#dc2626' : i === 1 ? '#d97706' : '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 12 }}>{i + 1}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, color: '#1f2937', fontSize: 12 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{a.asset_code} · {a.department}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#dc2626' }}>{a.breakdowns_12m}</div>
                    <div style={{ fontSize: 10, color: '#9ca3af' }}>breakdowns</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ── MAIN ── */
const TABS = ['Maintenance Schedule', 'Work Logs', 'Spare Parts', 'Analytics'];

export default function AssetMaintenance() {
  const [tab, setTab] = useState('Maintenance Schedule');

  const tabStyle = (t) => ({
    padding: '9px 18px', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13,
    background: tab === t ? '#6B3FDB' : 'transparent',
    color: tab === t ? '#fff' : '#6B3FDB',
    borderBottom: tab === t ? '2px solid #6B3FDB' : '2px solid transparent',
  });

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 4px', color: '#4c1d95', fontSize: 22, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Wrench size={20} className="page-header-icon" />
          Asset Maintenance
        </h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Preventive schedules, work logs, spare parts, and reliability analytics</p>
      </div>
      <div style={{ display: 'flex', gap: 0, borderBottom: '2px solid #e9e4ff', background: '#fff', borderRadius: '10px 10px 0 0', padding: '0 8px', flexWrap: 'wrap' }}>
        {TABS.map(t => <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 0 10px 10px', padding: 20 }}>
        {tab === 'Maintenance Schedule' && <ScheduleTab />}
        {tab === 'Work Logs' && <WorkLogsTab />}
        {tab === 'Spare Parts' && <SparePartsTab />}
        {tab === 'Analytics' && <AnalyticsTab />}
      </div>
    </div>
  );
}
