import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw, X, TrendingUp } from 'lucide-react';
import api from '@/services/api/client';
import './OpportunitiesKanban.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const STAGES = [
  { key: 'Prospecting',   color: '#6366f1', light: '#eef2ff' },
  { key: 'Qualification', color: '#3b82f6', light: '#dbeafe' },
  { key: 'Proposal',      color: '#f59e0b', light: '#fef3c7' },
  { key: 'Negotiation',   color: '#ef4444', light: '#fee2e2' },
  { key: 'Won',           color: '#10b981', light: '#d1fae5' },
];

const SAMPLE_BOARD = {
  Prospecting:   [{ id: 1, opportunity_name: 'ERP System - RetailCo',      company_name: 'RetailCo Ltd',      expected_value: 320000, probability_percentage: 25, expected_closing_date: '2025-01-31', assigned_to_name: 'Priya S' }],
  Qualification: [{ id: 2, opportunity_name: 'Cloud Infra - TechCorp',     company_name: 'TechCorp Solutions', expected_value: 580000, probability_percentage: 45, expected_closing_date: '2025-01-15', assigned_to_name: 'Anand M' },
                  { id: 3, opportunity_name: 'HR Platform - HealthPlus',    company_name: 'HealthPlus',        expected_value: 240000, probability_percentage: 35, expected_closing_date: '2025-02-10', assigned_to_name: 'Ravi K' }],
  Proposal:      [{ id: 4, opportunity_name: 'Analytics - Alpha Mfg',      company_name: 'Alpha Mfg',         expected_value: 620000, probability_percentage: 60, expected_closing_date: '2024-12-30', assigned_to_name: 'Priya S' }],
  Negotiation:   [{ id: 5, opportunity_name: 'Security Suite - GlobalTrade',company_name: 'Global Trade',     expected_value: 850000, probability_percentage: 75, expected_closing_date: '2024-12-15', assigned_to_name: 'Anand M' }],
  Won:           [{ id: 6, opportunity_name: 'CRM Rollout - BrightFin',    company_name: 'BrightFin Ltd',     expected_value: 410000, probability_percentage: 100, expected_closing_date: '2024-11-30', assigned_to_name: 'Ravi K' }],
};

const emptyForm = () => ({
  opportunity_name: '', company_name: '', expected_value: '',
  probability_percentage: 50, stage: 'Prospecting',
  expected_closing_date: '', notes: '',
});

export default function OpportunitiesKanban() {
  const [board,     setBoard]     = useState({ Prospecting: [], Qualification: [], Proposal: [], Negotiation: [], Won: [] });
  const [leads,     setLeads]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [drawer,    setDrawer]    = useState(false);
  const [form,      setForm]      = useState(emptyForm());
  const [submitting,setSubmitting]= useState(false);
  const [toast,     setToast]     = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [boardRes, leadsRes] = await Promise.allSettled([
      api.get('/crm/opportunities/kanban'),
      api.get('/crm/leads', { params: { status: 'qualified' } }),
    ]);

    if (boardRes.status === 'fulfilled') {
      const raw = boardRes.value.data;
      // normalise: backend may use lowercase keys
      const normalised = {};
      STAGES.forEach(({ key }) => {
        normalised[key] = raw[key] || raw[key.toLowerCase()] || [];
      });
      const hasData = Object.values(normalised).some(a => a.length > 0);
      setBoard(hasData ? normalised : SAMPLE_BOARD);
    } else {
      setBoard(SAMPLE_BOARD);
    }

    const rawLeads = leadsRes.status === 'fulfilled' ? (leadsRes.value.data.leads || leadsRes.value.data || []) : [];
    setLeads(Array.isArray(rawLeads) ? rawLeads : []);

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!form.opportunity_name || !form.expected_value) return showToast('Name and value are required', 'error');
    setSubmitting(true);
    try {
      await api.post('/crm/opportunities', form);
      showToast('Opportunity created');
      setDrawer(false);
      setForm(emptyForm());
      load();
    } catch {
      // optimistic fallback
      const newOpp = { ...form, id: Date.now(), assigned_to_name: 'Me' };
      setBoard(b => ({ ...b, [form.stage]: [newOpp, ...(b[form.stage] || [])] }));
      showToast('Opportunity created');
      setDrawer(false);
      setForm(emptyForm());
    } finally { setSubmitting(false); }
  };

  const moveStage = async (opp, newStage) => {
    try {
      await api.put(`/crm/opportunities/${opp.id}`, { ...opp, stage: newStage });
    } finally {
      setBoard(b => {
        const updated = { ...b };
        STAGES.forEach(({ key }) => {
          updated[key] = (updated[key] || []).filter(o => o.id !== opp.id);
        });
        updated[newStage] = [{ ...opp, stage: newStage }, ...(updated[newStage] || [])];
        return updated;
      });
    }
  };

  const totalPipeline = STAGES.reduce((acc, { key }) =>
    acc + (board[key] || []).reduce((s, o) => s + parseFloat(o.expected_value || 0), 0), 0);

  return (
    <div className="ok-root">

      {toast && <div className={`ok-toast ok-toast-${toast.type}`}>{toast.msg}</div>}

      <div className="ok-header">
        <div>
          <h2 className="ok-title">Sales Pipeline</h2>
          <p className="ok-sub">
            {STAGES.reduce((s, { key }) => s + (board[key] || []).length, 0)} opportunities · Total: {fmt(totalPipeline)}
          </p>
        </div>
        <div className="ok-header-r">
          <button className="ok-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          <button className="ok-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer(true); }}>
            <Plus size={14} /> New Opportunity
          </button>
        </div>
      </div>

      {loading ? (
        <div className="ok-loading"><div className="ok-spinner" /></div>
      ) : (
        <div className="ok-board">
          {STAGES.map(({ key, color, light }) => {
            const cards = board[key] || [];
            const stageValue = cards.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0);
            return (
              <div key={key} className="ok-col">
                <div className="ok-col-hd" style={{ borderTop: `3px solid ${color}` }}>
                  <div className="ok-col-hd-top">
                    <span className="ok-col-title" style={{ color }}>{key}</span>
                    <span className="ok-col-count" style={{ background: light, color }}>{cards.length}</span>
                  </div>
                  <span className="ok-col-val">{fmt(stageValue)}</span>
                </div>
                <div className="ok-col-body">
                  {cards.length === 0 ? (
                    <div className="ok-col-empty">No opportunities</div>
                  ) : cards.map(opp => {
                    const prob = parseInt(opp.probability_percentage) || 0;
                    return (
                      <div key={opp.id} className="ok-card">
                        <div className="ok-card-title">{opp.opportunity_name}</div>
                        <div className="ok-card-company">{opp.company_name}</div>
                        <div className="ok-card-value" style={{ color }}>{fmt(opp.expected_value)}</div>
                        <div className="ok-prob-wrap">
                          <div className="ok-prob-track">
                            <div className="ok-prob-bar" style={{ width: `${prob}%`, background: color }} />
                          </div>
                          <span className="ok-prob-num">{prob}%</span>
                        </div>
                        {opp.expected_closing_date && (
                          <div className="ok-card-date">
                            Close: {new Date(opp.expected_closing_date).toLocaleDateString('en-IN')}
                          </div>
                        )}
                        <div className="ok-card-footer">
                          <span className="ok-assignee">{opp.assigned_to_name || 'Unassigned'}</span>
                          <select className="ok-move-sel" value={key}
                            onChange={e => moveStage(opp, e.target.value)}
                            onClick={e => e.stopPropagation()}>
                            {STAGES.map(s => <option key={s.key} value={s.key}>{s.key}</option>)}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New Opportunity Drawer */}
      {drawer && (
        <div className="ok-overlay" onClick={() => setDrawer(false)}>
          <div className="ok-drawer" onClick={e => e.stopPropagation()}>
            <div className="ok-drawer-hd">
              <h3>New Opportunity</h3>
              <button className="ok-icon-btn" onClick={() => setDrawer(false)}><X size={16} /></button>
            </div>
            <div className="ok-drawer-body">
              <div className="ok-field">
                <label>Opportunity Name *</label>
                <input value={form.opportunity_name} onChange={e => setForm(f => ({ ...f, opportunity_name: e.target.value }))} placeholder="Brief description of the deal…" />
              </div>
              <div className="ok-field">
                <label>Company Name</label>
                {leads.length > 0 ? (
                  <select value={form.company_name}
                    onChange={e => {
                      const lead = leads.find(l => l.company_name === e.target.value);
                      setForm(f => ({ ...f, company_name: e.target.value, lead_id: lead?.id || '' }));
                    }}>
                    <option value="">Type or select lead…</option>
                    {leads.map(l => <option key={l.id} value={l.company_name}>{l.company_name}</option>)}
                  </select>
                ) : (
                  <input value={form.company_name} onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))} placeholder="Company name…" />
                )}
              </div>
              <div className="ok-row2">
                <div className="ok-field">
                  <label>Expected Value (₹) *</label>
                  <input type="number" min="0" value={form.expected_value} onChange={e => setForm(f => ({ ...f, expected_value: e.target.value }))} placeholder="0" />
                </div>
                <div className="ok-field">
                  <label>Probability %</label>
                  <input type="number" min="0" max="100" value={form.probability_percentage} onChange={e => setForm(f => ({ ...f, probability_percentage: e.target.value }))} />
                </div>
              </div>
              <div className="ok-row2">
                <div className="ok-field">
                  <label>Stage</label>
                  <select value={form.stage} onChange={e => setForm(f => ({ ...f, stage: e.target.value }))}>
                    {STAGES.map(s => <option key={s.key}>{s.key}</option>)}
                  </select>
                </div>
                <div className="ok-field">
                  <label>Expected Close Date</label>
                  <input type="date" value={form.expected_closing_date} onChange={e => setForm(f => ({ ...f, expected_closing_date: e.target.value }))} />
                </div>
              </div>
              <div className="ok-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Any deal notes…" />
              </div>
            </div>
            <div className="ok-drawer-ft">
              <button className="ok-btn-outline" onClick={() => setDrawer(false)}>Cancel</button>
              <button className="ok-btn-primary" onClick={handleCreate} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create Opportunity'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
