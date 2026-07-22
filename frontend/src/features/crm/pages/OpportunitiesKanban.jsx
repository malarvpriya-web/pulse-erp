import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw, X, CheckCircle, XCircle, BarChart2, List, Rocket } from 'lucide-react';
import api from '@/services/api/client';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import './OpportunitiesKanban.css';

const fmt = n => {
  const v = parseFloat(n || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(1)}Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000)     return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const fmtPct = n => (parseFloat(n) || 0).toFixed(1) + '%';

const probColor = p => {
  if (p <= 30) return '#ef4444';
  if (p <= 60) return '#f59e0b';
  if (p <= 80) return '#eab308';
  return '#10b981';
};

const STAGES = [
  { key: 'Prospecting',   label: 'Prospecting',   color: '#5B6CF6', light: '#eef2ff' },
  { key: 'Qualification', label: 'Qualification',  color: '#2563EB', light: '#dbeafe' },
  { key: 'Proposal',      label: 'Proposal',       color: '#D97706', light: '#fef3c7' },
  { key: 'Negotiation',   label: 'Negotiation',    color: '#DC2626', light: '#fee2e2' },
  { key: 'Won',           label: 'Won',            color: '#059669', light: '#d1fae5' },
  { key: 'Lost',          label: 'Lost',           color: '#6B7280', light: '#f3f4f6' },
];

const CLOSED_STAGES = new Set(['Won', 'Lost']);

const emptyForm = () => ({
  opportunity_name: '', company_name: '', expected_value: '',
  probability_percentage: 50, stage: 'Prospecting',
  expected_closing_date: '', notes: '',
});

export default function OpportunitiesKanban({ setPage } = {}) {
  const { readOnly } = usePageAccess();
  const [board,          setBoard]          = useState({ Prospecting: [], Qualification: [], Proposal: [], Negotiation: [], Won: [], Lost: [] });
  const [stats,          setStats]          = useState(null);
  const [leads,          setLeads]          = useState([]);
  const [loading,        setLoading]        = useState(false);
  const [view,           setView]           = useState('kanban'); // 'kanban' | 'list'
  const [drawer,         setDrawer]         = useState(false);
  const [form,           setForm]           = useState(emptyForm());
  const [submitting,     setSubmitting]     = useState(false);
  const [toast,          setToast]          = useState(null);
  const [pendingMove,    setPendingMove]    = useState(null);
  const [winLossReasons, setWinLossReasons] = useState([]);
  const [selectedReason, setSelectedReason] = useState('');
  const [detailOpp,         setDetailOpp]         = useState(null);
  const [creatingLifecycle, setCreatingLifecycle] = useState(false);

  const handleCreateLifecycle = useCallback(async (opp) => {
    setCreatingLifecycle(true);
    try {
      await api.post('/lifecycle/instances', {
        customer_id: opp.lead_id || null,
        stage_notes: `Created from opportunity: ${opp.opportunity_name}`,
      });
      setDetailOpp(null);
      setToast({ msg: `Lifecycle project created for "${opp.opportunity_name}". Go to Operations › Lifecycle Tracker to manage it.`, type: 'success' });
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setToast({ msg: e.response?.data?.error || 'Failed to create lifecycle instance', type: 'error' });
      setTimeout(() => setToast(null), 3000);
    } finally {
      setCreatingLifecycle(false);
    }
  }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Previously this button just navigated to a blank Quotations page — the
  // backend endpoint that actually creates a real, opportunity-linked draft
  // quotation (carrying customer + expected value forward) already existed and
  // was never called. Now it is, and we land on Quotations pre-filtered to it.
  const [creatingQuotation, setCreatingQuotation] = useState(false);
  const handleCreateQuotation = useCallback(async (opp) => {
    setCreatingQuotation(true);
    try {
      const res = await api.post(`/crm/opportunities/${opp.id}/create-quotation`);
      const quotationNumber = res.data?.quotation?.quotation_number;
      setDetailOpp(null);
      showToast(`Quotation ${quotationNumber || ''} created from "${opp.opportunity_name}"`);
      if (typeof setPage === 'function') {
        setPage('Quotations', quotationNumber ? { search: quotationNumber } : undefined);
      }
    } catch (e) {
      if (e.response?.status === 409 && e.response?.data?.quotation_id) {
        showToast('A quotation already exists for this opportunity — opening it.', 'error');
        setDetailOpp(null);
        if (typeof setPage === 'function') setPage('Quotations');
      } else {
        showToast(e.response?.data?.error || 'Failed to create quotation', 'error');
      }
    } finally {
      setCreatingQuotation(false);
    }
  }, [setPage]);

  useEffect(() => {
    api.get('/crm/win-loss-reasons')
      .then(res => setWinLossReasons(res.data?.data ?? []))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [boardRes, leadsRes, statsRes] = await Promise.allSettled([
      api.get('/crm/opportunities/kanban'),
      api.get('/crm/leads', { params: { status: 'qualified' } }),
      api.get('/crm/opportunities/stats'),
    ]);

    if (boardRes.status === 'fulfilled') {
      const raw = boardRes.value.data;
      const normalised = {};
      STAGES.forEach(({ key }) => {
        normalised[key] = raw[key] || raw[key.toLowerCase()] || [];
      });
      setBoard(normalised);
    } else {
      setBoard({ Prospecting: [], Qualification: [], Proposal: [], Negotiation: [], Won: [], Lost: [] });
    }

    const rawLeads = leadsRes.status === 'fulfilled' ? (leadsRes.value.data.leads || leadsRes.value.data || []) : [];
    setLeads(Array.isArray(rawLeads) ? rawLeads : []);

    if (statsRes.status === 'fulfilled') {
      setStats(statsRes.value.data);
    }

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
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to create opportunity', 'error');
    } finally { setSubmitting(false); }
  };

  const executeMove = async (opp, newStage, reason = '') => {
    const prevBoard = JSON.parse(JSON.stringify(board));
    // Optimistic update
    setBoard(b => {
      const updated = {};
      STAGES.forEach(({ key }) => { updated[key] = (b[key] || []).filter(o => o.id !== opp.id); });
      updated[newStage] = [{ ...opp, stage: newStage }, ...(updated[newStage] || [])];
      return updated;
    });
    try {
      await api.patch(`/crm/opportunities/${opp.id}/stage`, { stage: newStage, close_reason: reason || undefined });
      load(); // Refresh for server-computed fields (is_overdue, probability after won/lost)
    } catch (err) {
      setBoard(prevBoard);
      showToast(err.response?.data?.error || 'Failed to move opportunity', 'error');
    }
  };

  const moveStage = (opp, newStage) => {
    if (opp.stage === newStage) return;
    if (CLOSED_STAGES.has(newStage)) {
      setSelectedReason('');
      setPendingMove({ opp, newStage });
    } else {
      executeMove(opp, newStage);
    }
  };

  const confirmClose = () => {
    if (!pendingMove) return;
    executeMove(pendingMove.opp, pendingMove.newStage, selectedReason);
    setPendingMove(null);
    setSelectedReason('');
  };

  const totalCount = STAGES.reduce((s, { key }) => s + (board[key] || []).length, 0);
  const totalPipeline = STAGES.reduce((acc, { key }) =>
    acc + (board[key] || []).reduce((s, o) => s + parseFloat(o.expected_value || 0), 0), 0);

  const allOpps = STAGES.flatMap(({ key }) => (board[key] || []).map(o => ({ ...o, _stageKey: key })));

  return (
    <div className="ok-root">

      {toast && <div className={`ok-toast ok-toast-${toast.type}`}>{toast.msg}</div>}

      {readOnly && <ReadOnlyBanner />}

      {/* ── Header ── */}
      <div className="ok-header">
        <div>
          <h2 className="ok-title">Opportunities</h2>
          <p className="ok-sub">
            Sales pipeline &middot; {totalCount} opportunities &middot; Total: {fmt(totalPipeline)}
          </p>
        </div>
        <div className="ok-header-r">
          <button
            className={`ok-view-btn ${view === 'kanban' ? 'active' : ''}`}
            onClick={() => setView('kanban')} title="Kanban view"
          ><BarChart2 size={14} /></button>
          <button
            className={`ok-view-btn ${view === 'list' ? 'active' : ''}`}
            onClick={() => setView('list')} title="List view"
          ><List size={14} /></button>
          <button className="ok-icon-btn" onClick={load}><RefreshCw size={14} /></button>
          {!readOnly && (
            <button className="ok-btn-primary" onClick={() => { setForm(emptyForm()); setDrawer(true); }}>
              <Plus size={14} /> New Opportunity
            </button>
          )}
        </div>
      </div>

      {/* ── KPI summary bar ── */}
      {stats && (
        <div className="ok-kpi-bar">
          <div className="ok-kpi-item">
            <span className="ok-kpi-label">Total Pipeline</span>
            <span className="ok-kpi-value">{fmt(stats.total_value)}</span>
          </div>
          <div className="ok-kpi-sep" />
          <div className="ok-kpi-item">
            <span className="ok-kpi-label">Won (FY)</span>
            <span className="ok-kpi-value" style={{ color: '#059669' }}>{fmt(stats.won_value)}</span>
          </div>
          <div className="ok-kpi-sep" />
          <div className="ok-kpi-item">
            <span className="ok-kpi-label">Win Rate</span>
            <span className="ok-kpi-value">{fmtPct(stats.win_rate)}</span>
          </div>
          <div className="ok-kpi-sep" />
          <div className="ok-kpi-item">
            <span className="ok-kpi-label">Overdue</span>
            <span className="ok-kpi-value" style={{ color: stats.overdue_count > 0 ? '#ef4444' : undefined }}>
              {stats.overdue_count}
            </span>
          </div>
          <div className="ok-kpi-sep" />
          <div className="ok-kpi-item">
            <span className="ok-kpi-label">Avg Deal</span>
            <span className="ok-kpi-value">{fmt(stats.avg_deal_size)}</span>
          </div>
        </div>
      )}

      {loading ? (
        <div className="ok-loading"><div className="ok-spinner" /></div>
      ) : view === 'list' ? (
        /* ── List view ── */
        <div className="ok-list-wrap">
          <table className="ok-table">
            <thead>
              <tr>
                <th>Name</th><th>Company</th><th>Value</th><th>Stage</th>
                <th>Probability</th><th>Close Date</th><th>Assigned</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {allOpps.map(opp => {
                const stg = STAGES.find(s => s.key === opp._stageKey) || STAGES[0];
                const prob = parseInt(opp.probability_percentage) || 0;
                return (
                  <tr key={opp.id} className={opp.is_overdue ? 'ok-tr-overdue' : ''}>
                    <td>
                      <button className="ok-link" onClick={() => setDetailOpp(opp)}>
                        {opp.opportunity_name}
                      </button>
                    </td>
                    <td>{opp.company_name || '—'}</td>
                    <td style={{ fontWeight: 600 }}>{fmt(opp.expected_value)}</td>
                    <td>
                      <span className="ok-stage-badge" style={{ background: stg.light, color: stg.color }}>
                        {opp.stage}
                      </span>
                    </td>
                    <td>{prob}%</td>
                    <td style={{ color: opp.is_overdue ? '#ef4444' : undefined }}>
                      {opp.expected_closing_date
                        ? new Date(opp.expected_closing_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                        : '—'}
                      {opp.is_overdue && <span className="ok-overdue-badge">Overdue</span>}
                    </td>
                    <td>
                      {opp.assigned_to_name
                        ? opp.assigned_to_name
                        : <span className="ok-unassigned">Unassigned</span>}
                    </td>
                    <td>
                      {!readOnly && (
                        <div className="ok-tbl-actions">
                          <button className="ok-act-won"  onClick={() => moveStage(opp, 'Won')}>Won</button>
                          <button className="ok-act-lost" onClick={() => moveStage(opp, 'Lost')}>Lost</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* ── Kanban view ── */
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
                    const pc = probColor(prob);
                    return (
                      <div
                        key={opp.id}
                        className={`ok-card${opp.is_overdue ? ' ok-card-overdue' : ''}`}
                        onClick={() => setDetailOpp(opp)}
                      >
                        {opp.is_overdue && (
                          <span className="ok-overdue-badge">Overdue</span>
                        )}
                        <div className="ok-card-title">{opp.opportunity_name}</div>
                        <div className="ok-card-company">{opp.company_name || '—'}</div>
                        <div className="ok-card-value" style={{ color }}>{fmt(opp.expected_value)}</div>
                        <div className="ok-prob-wrap">
                          <div className="ok-prob-track">
                            <div className="ok-prob-bar" style={{ width: `${prob}%`, background: pc }} />
                          </div>
                          <span className="ok-prob-num">{prob}%</span>
                        </div>
                        {opp.expected_closing_date && (
                          <div className="ok-card-date" style={{ color: opp.is_overdue ? '#ef4444' : undefined }}>
                            Close: {new Date(opp.expected_closing_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                          </div>
                        )}
                        <div className="ok-card-footer">
                          {opp.assigned_to_name
                            ? <span className="ok-assignee">{opp.assigned_to_name}</span>
                            : <span className="ok-unassigned">Unassigned</span>}
                          {!readOnly && (
                            <select
                              className="ok-move-sel"
                              value={key}
                              onChange={e => moveStage(opp, e.target.value)}
                              onClick={e => e.stopPropagation()}
                            >
                              {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                            </select>
                          )}
                        </div>
                        {/* Hover quick actions */}
                        {!readOnly && !CLOSED_STAGES.has(key) && (
                          <div className="ok-card-actions" onClick={e => e.stopPropagation()}>
                            <button
                              className="ok-qact-won"
                              onClick={() => moveStage(opp, 'Won')}
                              title="Mark Won"
                            ><CheckCircle size={12} /> Won</button>
                            <button
                              className="ok-qact-lost"
                              onClick={() => moveStage(opp, 'Lost')}
                              title="Mark Lost"
                            ><XCircle size={12} /> Lost</button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Win/Loss Reason Modal ── */}
      {pendingMove && (
        <div className="ok-overlay" onClick={() => setPendingMove(null)}>
          <div className="ok-drawer" style={{ maxWidth: 440, top: '30%', height: 'auto' }} onClick={e => e.stopPropagation()}>
            <div className="ok-drawer-hd">
              <h3 style={{ color: pendingMove.newStage === 'Won' ? '#059669' : '#6b7280' }}>
                Mark as {pendingMove.newStage}
              </h3>
              <button className="ok-icon-btn" onClick={() => setPendingMove(null)}><X size={16} /></button>
            </div>
            <div className="ok-drawer-body" style={{ flex: 'none' }}>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
                Select a {pendingMove.newStage === 'Won' ? 'win' : 'loss'} reason for{' '}
                <strong>{pendingMove.opp.opportunity_name}</strong>
              </p>
              <div className="ok-field">
                <label>{pendingMove.newStage === 'Won' ? 'Win' : 'Loss'} Reason</label>
                <select value={selectedReason} onChange={e => setSelectedReason(e.target.value)}>
                  <option value="">— Select a reason (optional) —</option>
                  {winLossReasons
                    .filter(r => r.type === (pendingMove.newStage === 'Won' ? 'win' : 'loss') && r.is_active)
                    .map(r => <option key={r.id} value={r.reason}>{r.reason}</option>)}
                </select>
              </div>
            </div>
            <div className="ok-drawer-ft">
              <button className="ok-btn-outline" onClick={() => setPendingMove(null)}>Cancel</button>
              <button
                className="ok-btn-primary"
                style={{ background: pendingMove.newStage === 'Won' ? '#059669' : '#6b7280' }}
                onClick={confirmClose}
              >
                Confirm {pendingMove.newStage}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Opportunity Detail Drawer ── */}
      {detailOpp && (
        <div className="ok-overlay" onClick={() => setDetailOpp(null)}>
          <div className="ok-drawer" onClick={e => e.stopPropagation()}>
            <div className="ok-drawer-hd">
              <div>
                <h3 style={{ marginBottom: 4 }}>{detailOpp.opportunity_name}</h3>
                {(() => {
                  const stg = STAGES.find(s => s.key === detailOpp.stage || s.key.toLowerCase() === (detailOpp.stage || '').toLowerCase());
                  return stg ? (
                    <span className="ok-stage-badge" style={{ background: stg.light, color: stg.color }}>
                      {detailOpp.stage}
                    </span>
                  ) : null;
                })()}
              </div>
              <button className="ok-icon-btn" onClick={() => setDetailOpp(null)}><X size={16} /></button>
            </div>
            <div className="ok-drawer-body">
              <div className="ok-detail-row">
                <span className="ok-detail-label">Value</span>
                <span className="ok-detail-value" style={{ fontSize: 18, fontWeight: 700 }}>
                  {fmt(detailOpp.expected_value)}
                </span>
              </div>
              <div className="ok-detail-row">
                <span className="ok-detail-label">Probability</span>
                <span className="ok-detail-value">
                  <div className="ok-prob-wrap" style={{ maxWidth: 160 }}>
                    <div className="ok-prob-track">
                      <div className="ok-prob-bar" style={{
                        width: `${detailOpp.probability_percentage || 0}%`,
                        background: probColor(parseInt(detailOpp.probability_percentage) || 0),
                      }} />
                    </div>
                    <span className="ok-prob-num">{detailOpp.probability_percentage || 0}%</span>
                  </div>
                </span>
              </div>
              <div className="ok-detail-row">
                <span className="ok-detail-label">Company</span>
                <span className="ok-detail-value">{detailOpp.company_name || '—'}</span>
              </div>
              <div className="ok-detail-row">
                <span className="ok-detail-label">Assigned To</span>
                <span className="ok-detail-value">
                  {detailOpp.assigned_to_name
                    ? detailOpp.assigned_to_name
                    : <span className="ok-unassigned">Unassigned</span>}
                </span>
              </div>
              <div className="ok-detail-row">
                <span className="ok-detail-label">Close Date</span>
                <span className="ok-detail-value" style={{ color: detailOpp.is_overdue ? '#ef4444' : undefined }}>
                  {detailOpp.expected_closing_date
                    ? new Date(detailOpp.expected_closing_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                    : '—'}
                  {detailOpp.is_overdue && <span className="ok-overdue-badge" style={{ marginLeft: 8 }}>Overdue</span>}
                </span>
              </div>
              <div className="ok-detail-row">
                <span className="ok-detail-label">Created</span>
                <span className="ok-detail-value">
                  {detailOpp.created_at
                    ? new Date(detailOpp.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
                    : '—'}
                </span>
              </div>
              {detailOpp.notes && (
                <div className="ok-detail-notes">
                  <span className="ok-detail-label">Notes</span>
                  <p>{detailOpp.notes}</p>
                </div>
              )}
            </div>
            {!CLOSED_STAGES.has(detailOpp.stage) && (
              <div className="ok-drawer-ft">
                <button className="ok-btn-outline" onClick={() => setDetailOpp(null)}>Close</button>
                {(detailOpp.stage === 'Proposal' || detailOpp.stage === 'Negotiation') && (
                  <button
                    className="ok-btn-primary"
                    style={{ background: '#d97706' }}
                    disabled={creatingQuotation}
                    onClick={() => handleCreateQuotation(detailOpp)}
                  >
                    {creatingQuotation ? 'Creating…' : 'Create Quotation'}
                  </button>
                )}
                <button
                  className="ok-btn-primary"
                  style={{ background: '#ef4444' }}
                  onClick={() => { moveStage(detailOpp, 'Lost'); setDetailOpp(null); }}
                >
                  <XCircle size={14} /> Mark Lost
                </button>
                <button
                  className="ok-btn-primary"
                  style={{ background: '#059669' }}
                  onClick={() => { moveStage(detailOpp, 'Won'); setDetailOpp(null); }}
                >
                  <CheckCircle size={14} /> Mark Won
                </button>
              </div>
            )}
            {detailOpp.stage === 'Won' && (
              <div className="ok-drawer-ft">
                <button className="ok-btn-outline" onClick={() => setDetailOpp(null)}>Close</button>
                <button
                  className="ok-btn-primary"
                  style={{ background: '#6B3FDB' }}
                  disabled={creatingLifecycle}
                  onClick={() => handleCreateLifecycle(detailOpp)}
                >
                  <Rocket size={14} /> {creatingLifecycle ? 'Creating…' : 'Convert to Project'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── New Opportunity Drawer ── */}
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
                <input value={form.opportunity_name}
                  onChange={e => setForm(f => ({ ...f, opportunity_name: e.target.value }))}
                  placeholder="Brief description of the deal…" />
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
                  <input value={form.company_name}
                    onChange={e => setForm(f => ({ ...f, company_name: e.target.value }))}
                    placeholder="Company name…" />
                )}
              </div>
              <div className="ok-row2">
                <div className="ok-field">
                  <label>Expected Value (₹) *</label>
                  <input type="number" min="0" value={form.expected_value}
                    onChange={e => setForm(f => ({ ...f, expected_value: e.target.value }))}
                    placeholder="0" />
                </div>
                <div className="ok-field">
                  <label>Probability %</label>
                  <input type="number" min="0" max="100" value={form.probability_percentage}
                    onChange={e => setForm(f => ({ ...f, probability_percentage: e.target.value }))} />
                </div>
              </div>
              <div className="ok-row2">
                <div className="ok-field">
                  <label>Stage</label>
                  <select value={form.stage} onChange={e => setForm(f => ({ ...f, stage: e.target.value }))}>
                    {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
                <div className="ok-field">
                  <label>Expected Close Date</label>
                  <input type="date" value={form.expected_closing_date}
                    onChange={e => setForm(f => ({ ...f, expected_closing_date: e.target.value }))} />
                </div>
              </div>
              <div className="ok-field">
                <label>Notes</label>
                <textarea rows={3} value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Any deal notes…" />
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
