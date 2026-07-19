import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Plus, X, Clock } from 'lucide-react';
import api from '@/services/api/client';

const PAGE_SIZE = 20;
const fmtDate = (d) => d ? d.slice(0, 10) : '—';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthYearOptions() {
  const opts = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    opts.push({ month: d.getMonth() + 1, year: d.getFullYear(), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
  }
  return opts;
}

const BLANK = { campaign_id: '', task_id: '', date: new Date().toISOString().slice(0, 10), hours: '', description: '' };

export default function TimesheetEntry() {
  const [rows, setRows]           = useState([]);
  const [summary, setSummary]     = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [tasks, setTasks]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState('');
  const [page, setPage]           = useState(1);
  const [showForm, setShowForm]   = useState(false);
  const [form, setForm]           = useState(BLANK);
  const [saving, setSaving]       = useState(false);
  const monthOpts = monthYearOptions();
  const [selectedMY, setSelectedMY] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    const opt = monthOpts[selectedMY];
    try {
      const params = { month: opt.month, year: opt.year };
      const [tsRes, sumRes, campsRes] = await Promise.allSettled([
        api.get('/marketing/timesheets', { params }),
        api.get('/marketing/timesheets/summary', { params }),
        api.get('/marketing/campaigns'),
      ]);
      setRows(tsRes.status === 'fulfilled' && Array.isArray(tsRes.value?.data) ? tsRes.value.data : []);
      setSummary(sumRes.status === 'fulfilled' && Array.isArray(sumRes.value?.data) ? sumRes.value.data : []);
      setCampaigns(campsRes.status === 'fulfilled' && Array.isArray(campsRes.value?.data) ? campsRes.value.data : []);
    } catch { setRows([]); }
    finally { setLoading(false); }
  }, [selectedMY]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load tasks when campaign_id changes in form
  useEffect(() => {
    if (!form.campaign_id) { setTasks([]); return; }
    api.get('/marketing/tasks', { params: { campaign_id: form.campaign_id } })
      .then(r => setTasks(Array.isArray(r.data) ? r.data : []))
      .catch(() => setTasks([]));
  }, [form.campaign_id]);

  useEffect(() => { load(); }, [load]);

  const filtered = rows.filter(r =>
    !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const openNew = () => { setForm(BLANK); setShowForm(true); };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/marketing/timesheets', form);
      setShowForm(false);
      load();
    } catch { /* silent */ }
    finally { setSaving(false); }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const totalHours = rows.reduce((s, r) => s + parseFloat(r.hours || 0), 0);

  const COLS = ['Date', 'Employee', 'Campaign', 'Task', 'Hours', 'Description'];

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)' }}>
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Timesheet Entry</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Log marketing hours by campaign and task</p>
        </div>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search…"
          style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', width: 160 }} />
        <select value={selectedMY} onChange={e => setSelectedMY(Number(e.target.value))}
          style={{ padding: '7px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
          {monthOpts.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
        </select>
        <button onClick={load} style={{ padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, background: 'var(--color-background-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 13 }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button onClick={openNew} style={{ padding: '7px 16px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Plus size={14} /> Log Time
        </button>
      </div>

      {/* Monthly summary strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 20 }}>
        <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Total Hours</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>{loading ? '…' : totalHours.toFixed(1)}h</div>
        </div>
        <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Team Members</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>{loading ? '…' : summary.length}</div>
        </div>
        <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, padding: '12px 16px' }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Entries</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>{loading ? '…' : rows.length}</div>
        </div>
      </div>

      {/* Top contributors */}
      {summary.length > 0 && (
        <div style={{ background: 'var(--color-background-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, padding: 16, marginBottom: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 12 }}>Hours by Team Member — {monthOpts[selectedMY].label}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {summary.map(s => (
              <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 500, color: 'var(--color-text-primary)' }}>{s.name}</span>
                <span style={{ fontWeight: 700, color: '#6B3FDB' }}>{parseFloat(s.total_hours).toFixed(1)}h</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Log time form */}
      {showForm && (
        <>
          <div onClick={() => setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }} />
          <div style={{ position: 'fixed', right: 0, top: 0, bottom: 0, width: 440, background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', zIndex: 50, padding: 24, overflowY: 'auto', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ margin: 0, color: 'var(--color-text-primary)', fontSize: 17 }}>Log Time</h3>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)' }}><X size={20} /></button>
            </div>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Date *</label>
                  <input type="date" value={form.date} required onChange={e => set('date', e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Hours *</label>
                  <input type="number" min="0.25" max="24" step="0.25" value={form.hours} required onChange={e => set('hours', e.target.value)}
                    placeholder="e.g. 1.5"
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }} />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Campaign</label>
                <select value={form.campaign_id} onChange={e => { set('campaign_id', e.target.value); set('task_id', ''); }}
                  style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                  <option value="">— None —</option>
                  {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              {tasks.length > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Task</label>
                  <select value={form.task_id} onChange={e => set('task_id', e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' }}>
                    <option value="">— None —</option>
                    {tasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 }}>Description</label>
                <textarea rows={3} value={form.description} onChange={e => set('description', e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)', resize: 'vertical' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                <button type="submit" disabled={saving} style={{ flex: 1, padding: '9px 0', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                  {saving ? 'Saving…' : 'Log Time'}
                </button>
                <button type="button" onClick={() => setShowForm(false)} style={{ flex: 1, padding: '9px 0', background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              </div>
            </form>
          </div>
        </>
      )}

      <div style={{ background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 10, overflow: 'hidden' }}>
        {loading ? (
          [1,2,3].map(i => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 16px', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
              {[80, 120, 140, 140, 50, 180].map((w, j) => (
                <div key={j} style={{ height: 14, width: w, background: 'var(--color-background-secondary)', borderRadius: 4, animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          ))
        ) : paged.length === 0 ? (
          <div style={{ padding: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 24px', textAlign: 'center', background: 'var(--color-background-secondary)', borderRadius: 10, border: '0.5px solid var(--color-border-tertiary)' }}>
              <Clock size={36} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
              <p style={{ fontWeight: 500, fontSize: 15, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>No timesheet entries</p>
              <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>Log your first hours against a campaign or task.</p>
              <button onClick={openNew} style={{ padding: '8px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Log Time</button>
            </div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--color-background-secondary)' }}>
                  {COLS.map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--color-text-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paged.map((r, i) => (
                  <tr key={r.id ?? i} style={{ borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                    <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 600, color: 'var(--color-text-primary)' }}>{r.employee_name || '—'}</td>
                    <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{r.campaign_name || '—'}</td>
                    <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)' }}>{r.task_name || '—'}</td>
                    <td style={{ padding: '10px 14px', fontWeight: 700, color: '#6B3FDB', whiteSpace: 'nowrap' }}>{r.hours != null ? `${r.hours}h` : '—'}</td>
                    <td style={{ padding: '10px 14px', color: 'var(--color-text-secondary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!loading && totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, fontSize: 13, color: 'var(--color-text-secondary)' }}>
          <span>{filtered.length} records · Page {page} of {totalPages}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === 1 ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === 1 ? 0.5 : 1, fontSize: 13 }}>Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
              style={{ padding: '5px 14px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 6, background: 'var(--color-background-secondary)', cursor: page === totalPages ? 'default' : 'pointer', color: 'var(--color-text-secondary)', opacity: page === totalPages ? 0.5 : 1, fontSize: 13 }}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
