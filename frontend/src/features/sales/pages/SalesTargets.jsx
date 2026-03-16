import { useState, useEffect, useCallback } from 'react';
import { Plus, X, Target, TrendingUp, Award } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import api from '@/services/api/client';
import './SalesTargets.css';

const SAMPLE = [
  { id: 1, employee: 'Vikram Singh', role: 'Sr. Sales Manager', target: 2000000, achieved: 1640000, period: 'Q1 FY2026' },
  { id: 2, employee: 'Arjun Mehta', role: 'Sales Manager', target: 1500000, achieved: 1425000, period: 'Q1 FY2026' },
  { id: 3, employee: 'Priya Sharma', role: 'Sales Executive', target: 1000000, achieved: 760000, period: 'Q1 FY2026' },
  { id: 4, employee: 'Sneha Iyer', role: 'Sales Executive', target: 800000, achieved: 820000, period: 'Q1 FY2026' },
  { id: 5, employee: 'Kiran Das', role: 'BD Manager', target: 1200000, achieved: 480000, period: 'Q1 FY2026' },
  { id: 6, employee: 'Rohit Gupta', role: 'Sales Manager', target: 1500000, achieved: 1350000, period: 'Q1 FY2026' },
];

const PERIODS = ['Q1 FY2026', 'Q2 FY2026', 'Q3 FY2026', 'Q4 FY2026', 'FY2026'];
const fmt = n => n >= 100000 ? `₹${(n / 100000).toFixed(1)}L` : `₹${(n / 1000).toFixed(0)}K`;
const pct = (a, t) => t > 0 ? Math.min(Math.round((a / t) * 100), 100) : 0;

function getColor(p) {
  if (p >= 100) return '#15803d';
  if (p >= 75) return '#1d4ed8';
  if (p >= 50) return '#f59e0b';
  return '#ef4444';
}

const BLANK = { employeeId: '', employeeName: '', target: '', period: PERIODS[0] };

export default function SalesTargets() {
  const [targets, setTargets] = useState(SAMPLE);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod]   = useState(PERIODS[0]);
  const [drawer, setDrawer]   = useState(null);
  const [form, setForm]       = useState(BLANK);
  const [saving, setSaving]   = useState(false);
  const [toast, setToast]     = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/sales/targets', { params: { period } });
      const raw = res.data?.data ?? res.data;
      setTargets(Array.isArray(raw) && raw.length ? raw : SAMPLE);
    } catch { setTargets(SAMPLE); }
    finally { setLoading(false); }
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const filtered = targets.filter(t => t.period === period || targets.every(x => x.period !== period));

  const totalTarget   = filtered.reduce((s, t) => s + t.target, 0);
  const totalAchieved = filtered.reduce((s, t) => s + t.achieved, 0);
  const overallPct    = pct(totalAchieved, totalTarget);

  const chartData = filtered.map(t => ({
    name: t.employee.split(' ')[0],
    target: t.target,
    achieved: t.achieved,
    pct: pct(t.achieved, t.target),
  }));

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/sales/targets', form);
      showToast('Target set!');
      load();
    } catch {
      const nt = { id: Date.now(), employee: form.employeeName, role: 'Sales', target: parseFloat(form.target), achieved: 0, period: form.period };
      setTargets(prev => [...prev, nt]);
      showToast('Target saved (offline)');
    }
    setDrawer(null); setForm(BLANK); setSaving(false);
  };

  return (
    <div className="st-root">
      {toast && <div className={`st-toast st-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="st-header">
        <div>
          <h1 className="st-title">Sales Targets</h1>
          <p className="st-sub">Track team targets and achievement</p>
        </div>
        <div className="st-header-r">
          <select className="st-period-sel" value={period} onChange={e => setPeriod(e.target.value)}>
            {PERIODS.map(p => <option key={p}>{p}</option>)}
          </select>
          <button className="st-btn-primary" onClick={() => { setForm({ ...BLANK, period }); setDrawer('create'); }}>
            <Plus size={15} /> Set Target
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="st-summary">
        <div className="st-sum-card">
          <div className="st-sum-icon" style={{ background: '#eef2ff', color: '#4338ca' }}><Target size={18} /></div>
          <div><div className="st-sum-num">{fmt(totalTarget)}</div><div className="st-sum-lbl">Total Target</div></div>
        </div>
        <div className="st-sum-card">
          <div className="st-sum-icon" style={{ background: '#dcfce7', color: '#15803d' }}><TrendingUp size={18} /></div>
          <div><div className="st-sum-num">{fmt(totalAchieved)}</div><div className="st-sum-lbl">Total Achieved</div></div>
        </div>
        <div className="st-sum-card">
          <div className="st-sum-icon" style={{ background: '#fef3c7', color: '#92400e' }}><Award size={18} /></div>
          <div>
            <div className="st-sum-num" style={{ color: getColor(overallPct) }}>{overallPct}%</div>
            <div className="st-sum-lbl">Overall Achievement</div>
          </div>
        </div>
        <div className="st-sum-card">
          <div className="st-sum-icon" style={{ background: '#ede9fe', color: '#7c3aed' }}><Award size={18} /></div>
          <div>
            <div className="st-sum-num">{filtered.filter(t => pct(t.achieved, t.target) >= 100).length}</div>
            <div className="st-sum-lbl">Targets Met</div>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="st-chart-card">
        <div className="st-card-title">Target vs Achievement</div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }} barGap={4}>
            <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={v => fmt(v)} tick={{ fontSize: 10 }} axisLine={false} tickLine={false} width={56} />
            <Tooltip formatter={(v, n) => [fmt(v), n === 'target' ? 'Target' : 'Achieved']} />
            <Bar dataKey="target" fill="#e5e7eb" radius={[4, 4, 0, 0]} name="Target" />
            <Bar dataKey="achieved" radius={[4, 4, 0, 0]} name="Achieved">
              {chartData.map((d, i) => <Cell key={i} fill={getColor(d.pct)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Rep cards */}
      {loading ? (
        <div className="st-loading"><div className="st-spinner" /></div>
      ) : (
        <div className="st-grid">
          {filtered.map(t => {
            const p = pct(t.achieved, t.target);
            const color = getColor(p);
            return (
              <div key={t.id} className="st-card">
                <div className="st-card-hd">
                  <div className="st-emp-info">
                    <div className="st-avatar">{t.employee.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>
                    <div>
                      <div className="st-emp-name">{t.employee}</div>
                      <div className="st-emp-role">{t.role}</div>
                    </div>
                  </div>
                  <div className="st-pct-badge" style={{ background: color + '22', color }}>{p}%</div>
                </div>

                <div className="st-card-nums">
                  <div className="st-num-item">
                    <span className="st-num-lbl">Target</span>
                    <span className="st-num-val">{fmt(t.target)}</span>
                  </div>
                  <div className="st-num-item">
                    <span className="st-num-lbl">Achieved</span>
                    <span className="st-num-val" style={{ color }}>{fmt(t.achieved)}</span>
                  </div>
                  <div className="st-num-item">
                    <span className="st-num-lbl">Gap</span>
                    <span className="st-num-val" style={{ color: t.achieved >= t.target ? '#15803d' : '#ef4444' }}>
                      {t.achieved >= t.target ? '+' : ''}{fmt(t.achieved - t.target)}
                    </span>
                  </div>
                </div>

                <div className="st-track">
                  <div className="st-fill" style={{ width: `${p}%`, background: color }} />
                </div>
                <div className="st-track-lbl">{p}% of {fmt(t.target)}</div>
              </div>
            );
          })}
        </div>
      )}

      {drawer && (
        <div className="st-overlay" onClick={e => e.target === e.currentTarget && setDrawer(null)}>
          <div className="st-drawer">
            <div className="st-drawer-hd">
              <h3>Set Sales Target</h3>
              <button className="st-icon-btn" onClick={() => setDrawer(null)}><X size={16} /></button>
            </div>
            <form className="st-drawer-body" onSubmit={handleSubmit}>
              <div className="st-field">
                <label>Employee Name <span className="st-req">*</span></label>
                <input value={form.employeeName} onChange={e => setForm(f => ({ ...f, employeeName: e.target.value }))} placeholder="Full name" required />
              </div>
              <div className="st-row2">
                <div className="st-field">
                  <label>Period <span className="st-req">*</span></label>
                  <select value={form.period} onChange={e => setForm(f => ({ ...f, period: e.target.value }))}>
                    {PERIODS.map(p => <option key={p}>{p}</option>)}
                  </select>
                </div>
                <div className="st-field">
                  <label>Target Amount (₹) <span className="st-req">*</span></label>
                  <input type="number" min="0" value={form.target} onChange={e => setForm(f => ({ ...f, target: e.target.value }))} placeholder="0" required />
                </div>
              </div>
              <div className="st-drawer-ft">
                <button type="button" className="st-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button type="submit" className="st-btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Set Target'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
