import { useState, useEffect, useCallback } from 'react';
import {
  Plus, RefreshCw, X, CheckCircle, XCircle, BarChart2, List, Rocket,
  Target, Filter,
} from 'lucide-react';
import api from '@/services/api/client';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';
import './OpportunitiesKanban.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

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
  if (p <= 60) return '#7c5cf0';
  if (p <= 80) return '#8b5cf6';
  return '#10b981';
};

/**
 * Stage columns are NOT defined here. `GET /crm/opportunities/kanban` returns
 * `{ board, stages }`, where `stages` is derived from the `crm_pipeline_stages`
 * master plus a trailing `Unmapped` bucket for opportunities whose stage matches
 * no configured stage. This board previously hardcoded six keys and read them
 * off the response root, which meant (a) it silently dropped every opportunity
 * in an unconfigured stage — ₹19,89,009 in `Bidding` was invisible while /stats
 * counted it, a 46.7% divergence — and (b) once the endpoint moved to the
 * `{ board, stages }` shape, `raw[key]` resolved to undefined for all six and
 * the board rendered completely empty.
 *
 * The list below is a render-time fallback for the first paint only; the server
 * response always replaces it.
 */
const FALLBACK_STAGES = [
  { key: 'Prospecting',   label: 'Prospecting',   color: '#5B6CF6', is_won: false, is_lost: false },
  { key: 'Qualification', label: 'Qualification',  color: '#2563EB', is_won: false, is_lost: false },
  { key: 'Proposal',      label: 'Proposal',       color: '#6d28d9', is_won: false, is_lost: false },
  { key: 'Negotiation',   label: 'Negotiation',    color: '#DC2626', is_won: false, is_lost: false },
  { key: 'Won',           label: 'Won',            color: '#059669', is_won: true,  is_lost: false },
  { key: 'Lost',          label: 'Lost',           color: '#6B7280', is_won: false, is_lost: true  },
];

// The data-quality bucket. It is a destination for nothing — you cannot move a
// card *into* an unconfigured stage, you can only move one out of it.
const UNMAPPED_KEY = 'Unmapped';

// A 12%-alpha wash of the stage colour, replacing the hand-picked `light` values
// the hardcoded list carried. Stage colours now come from the master, which has
// no companion tint column.
const tint = hex => `${hex}1F`;

const bandColor = band => (band === 'high' ? '#ef4444' : band === 'medium' ? '#7c5cf0' : '#6b7280');
const bandLight = band => (band === 'high' ? '#fef2f2' : band === 'medium' ? '#f5f3ff' : '#f3f4f6');

const emptyForm = () => ({
  opportunity_name: '', company_name: '', expected_value: '',
  probability_percentage: 50, stage: 'Prospecting',
  expected_closing_date: '', notes: '',
});

export default function OpportunitiesKanban({ setPage } = {}) {
  const { readOnly } = usePageAccess();
  const [board,          setBoard]          = useState({});
  const [stages,         setStages]         = useState(FALLBACK_STAGES);
  const [stats,          setStats]          = useState(null);
  const [leads,          setLeads]          = useState([]);
  const [loading,        setLoading]        = useState(false);
  const [loadError,      setLoadError]      = useState(null);
  const [view,           setView]           = useState('kanban'); // 'kanban' | 'list' | 'priority'
  const [priorityQueue,  setPriorityQueue]  = useState([]);
  const [priorityLoading, setPriorityLoading] = useState(false);
  const [drawer,         setDrawer]         = useState(false);
  const [form,           setForm]           = useState(emptyForm());
  const [submitting,     setSubmitting]     = useState(false);
  const [toast,          setToast]          = useState(null);
  const [pendingMove,    setPendingMove]    = useState(null);
  const [winLossReasons, setWinLossReasons] = useState([]);
  const [selectedReason, setSelectedReason] = useState('');
  const [competitorList, setCompetitorList] = useState([]);
  const [selectedCompetitor, setSelectedCompetitor] = useState('');
  // Close attribution on an *already* closed deal, edited from the detail
  // drawer. The close dialog only fires on the transition, so without this a
  // deal lost before the field existed stays untagged forever.
  const [closeEdit,    setCloseEdit]    = useState({ reason: '', competitor: '' });
  const [savingClose,  setSavingClose]  = useState(false);
  const [detailOpp,         setDetailOpp]         = useState(null);
  const [creatingLifecycle, setCreatingLifecycle] = useState(false);

  // Previously this only created an Operations `lifecycle_instances` stub
  // (project_id always null) — no row ever landed in `projects`, so Sales saw
  // a success toast while Projects/Finance had nothing to actually work with.
  // Now calls the endpoint that creates a real project via the opportunity_id
  // bridge column (see Project Master) and still sets up lifecycle tracking,
  // correctly linked to that new project this time.
  const handleCreateLifecycle = useCallback(async (opp) => {
    setCreatingLifecycle(true);
    try {
      const res = await api.post(`/crm/opportunities/${opp.id}/convert-to-project`);
      const project = res.data?.project;
      setDetailOpp(null);
      setToast({
        msg: res.data?.already_existed
          ? `Project ${project?.project_number || ''} already exists for "${opp.opportunity_name}".`
          : `Project ${project?.project_number || ''} created for "${opp.opportunity_name}".`,
        type: 'success',
      });
      setTimeout(() => setToast(null), 4000);
      if (project?.id && typeof setPage === 'function') {
        sessionStorage.setItem('selectedProjectId', project.id);
        setPage('ProjectDetail', { id: project.id });
      }
    } catch (e) {
      setToast({ msg: e.response?.data?.error || 'Failed to create project', type: 'error' });
      setTimeout(() => setToast(null), 3000);
    } finally {
      setCreatingLifecycle(false);
    }
  }, [setPage]);

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
    // The competitor master feeds the close dialog's "Lost To" picker. Without
    // it the only way to name a competitor is free text, which fragments the
    // Top Competitors roll-up into near-duplicate spellings.
    api.get('/sales/competitors', { params: { limit: 100 } })
      .then(res => setCompetitorList(Array.isArray(res.data) ? res.data : []))
      .catch(() => setCompetitorList([]));
  }, []);

  useEffect(() => {
    setCloseEdit({
      reason:     detailOpp?.lost_reason || detailOpp?.close_reason || '',
      competitor: detailOpp?.competitor  || '',
    });
  }, [detailOpp?.id, detailOpp?.lost_reason, detailOpp?.close_reason, detailOpp?.competitor]);

  const load = useCallback(async () => {
    setLoading(true);
    const [boardRes, leadsRes, statsRes] = await Promise.allSettled([
      api.get('/crm/opportunities/kanban'),
      api.get('/crm/leads', { params: { status: 'qualified' } }),
      api.get('/crm/opportunities/stats'),
    ]);

    if (boardRes.status === 'fulfilled') {
      const raw = boardRes.value.data ?? {};
      // `{ board, stages }` is the current contract; the bare-map form is the
      // pre-remediation shape, kept only so a stale backend degrades to the old
      // behaviour instead of a blank board.
      const rawBoard   = raw.board && typeof raw.board === 'object' ? raw.board : raw;
      const srvStages  = Array.isArray(raw.stages) && raw.stages.length ? raw.stages : FALLBACK_STAGES;

      // Bucket by the stage list the server actually sent, so a stage added to
      // crm_pipeline_stages shows up here without a frontend change — and an
      // opportunity in an unconfigured stage lands in `Unmapped` rather than
      // vanishing.
      const normalised = {};
      srvStages.forEach(({ key }) => {
        normalised[key] = rawBoard[key] || rawBoard[String(key).toLowerCase()] || [];
      });
      setStages(srvStages);
      setBoard(normalised);
      setLoadError(null);
    } else {
      // An empty board and an unreachable board are different business states.
      // Rendering `[]` here is what let a failed call read as "no pipeline".
      setBoard({});
      setLoadError(
        boardRes.reason?.response?.data?.error ||
        boardRes.reason?.message ||
        'Could not load the opportunity board.'
      );
    }

    const rawLeads = leadsRes.status === 'fulfilled' ? (leadsRes.value.data.leads || leadsRes.value.data || []) : [];
    setLeads(Array.isArray(rawLeads) ? rawLeads : []);

    if (statsRes.status === 'fulfilled') {
      setStats(statsRes.value.data);
    }

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadPriorityQueue = useCallback(async () => {
    setPriorityLoading(true);
    try {
      const res = await api.get('/ai/predict/lead-priority');
      setPriorityQueue(res.data?.data ?? []);
    } catch {
      setPriorityQueue([]);
    } finally {
      setPriorityLoading(false);
    }
  }, []);

  useEffect(() => { if (view === 'priority') loadPriorityQueue(); }, [view, loadPriorityQueue]);

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

  const executeMove = async (opp, newStage, reason = '', competitor = '') => {
    const prevBoard = JSON.parse(JSON.stringify(board));
    // Optimistic update. Iterating the board's own keys rather than a fixed
    // stage list matters for the Unmapped column: a card dragged out of it has
    // to be removed from a bucket the stage master does not contain.
    setBoard(b => {
      const updated = {};
      Object.keys(b).forEach(key => { updated[key] = (b[key] || []).filter(o => o.id !== opp.id); });
      updated[newStage] = [{ ...opp, stage: newStage }, ...(updated[newStage] || [])];
      return updated;
    });
    try {
      await api.patch(`/crm/opportunities/${opp.id}/stage`, {
        stage: newStage,
        close_reason: reason || undefined,
        competitor: competitor || undefined,
      });
      load(); // Refresh for server-computed fields (is_overdue, probability after won/lost)
    } catch (err) {
      setBoard(prevBoard);
      showToast(err.response?.data?.error || 'Failed to move opportunity', 'error');
    }
  };

  // Won/Lost are whatever the stage master flags as won/lost, not the two
  // literals this file used to hardcode — a company that renames "Won" to
  // "Order Received" still gets the close-reason dialog.
  // Every stage comparison on this page is case-insensitive, because the two
  // sides genuinely differ: `stages[].key` is the master's DISPLAY name
  // ('Won', 'Proposal') while `opp.stage` is the stored canonical key ('won',
  // 'proposal'). Compared with ===, an already-won deal read as still open —
  // no attribution panel, and "Mark Won"/"Mark Lost" offered on a closed deal.
  const sameStage   = (a, b) =>
    String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const closedKeys  = new Set(
    stages.filter(s => s.is_won || s.is_lost).map(s => String(s.key ?? '').toLowerCase())
  );
  const isClosed    = key => closedKeys.has(String(key ?? '').trim().toLowerCase());
  // The close dialog kept comparing against the literal 'Won', so on a renamed
  // stage master it offered loss reasons for a win. It reads the same flags as
  // `closedKeys` now; a stage flagged neither way falls back to the old literal.
  const stageMeta   = key => stages.find(s => sameStage(s.key, key)) || {};
  const isWonStage  = key => (stageMeta(key).is_won ?? sameStage(key, 'won'));
  // Stages you can move a card *to*: everything the master defines. `Unmapped`
  // is a symptom, never a destination.
  const targetStages = stages.filter(s => s.key !== UNMAPPED_KEY);

  const moveStage = (opp, newStage) => {
    if (sameStage(opp.stage, newStage)) return;
    if (isClosed(newStage)) {
      setSelectedReason('');
      setSelectedCompetitor('');
      setPendingMove({ opp, newStage });
    } else {
      executeMove(opp, newStage);
    }
  };

  const confirmClose = () => {
    if (!pendingMove) return;
    executeMove(pendingMove.opp, pendingMove.newStage, selectedReason, selectedCompetitor);
    setPendingMove(null);
    setSelectedReason('');
    setSelectedCompetitor('');
  };

  const saveCloseDetails = async () => {
    if (!detailOpp) return;
    setSavingClose(true);
    const competitor = closeEdit.competitor.trim();
    const reason     = closeEdit.reason.trim();
    try {
      // '' rather than undefined: clearing a mis-typed name has to reach the
      // column, and the repository maps '' on these fields to NULL.
      const { data } = await api.put(`/crm/opportunities/${detailOpp.id}`, {
        competitor,
        ...(isWonStage(detailOpp.stage) ? {} : { lost_reason: reason }),
        close_reason: reason,
      });
      setDetailOpp(d => (d ? { ...d, ...data } : d));
      showToast('Close details saved');
      load();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to save close details', 'error');
    } finally { setSavingClose(false); }
  };

  // Totals run over every bucket the board holds — including Unmapped — so the
  // header figure reconciles with /crm/opportunities/stats instead of quietly
  // excluding whatever the stage master doesn't know about.
  const boardKeys = Object.keys(board);
  const totalCount = boardKeys.reduce((s, key) => s + (board[key] || []).length, 0);
  const totalPipeline = boardKeys.reduce((acc, key) =>
    acc + (board[key] || []).reduce((s, o) => s + parseFloat(o.expected_value || 0), 0), 0);

  const allOpps = boardKeys.flatMap(key => (board[key] || []).map(o => ({ ...o, _stageKey: key })));

  return (
    <PageShell dock={
      <PageHero
        icon={Filter}
        eyebrow="CRM"
        title="Opportunities"
        actions={<>
          <button
            className="plh-cta plh-cta--ghost"
            onClick={() => setView('kanban')} title="Kanban view"><BarChart2 size={14} /></button>
          <button
            className="plh-cta plh-cta--ghost"
            onClick={() => setView('list')} title="List view"><List size={14} /></button>
          <button
            className="plh-cta plh-cta--ghost"
            onClick={() => setView('priority')} title="Priority queue — AI-ranked, work these first"><Target size={14} /></button>
          <button className="plh-cta plh-cta--ghost" onClick={() => (view === 'priority' ? loadPriorityQueue() : load())}><RefreshCw size={14} /></button>
          {!readOnly && (
            <button className="plh-cta" onClick={() => { setForm(emptyForm()); setDrawer(true); }}>
              <Plus size={14} /> New Opportunity
            </button>
          )}
        </>}
      />
    }>

      {toast && <div className={`ok-toast ok-toast-${toast.type}`}>{toast.msg}</div>}

      {readOnly && <ReadOnlyBanner />}

      {/* ── Header ── */}


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
      ) : loadError ? (
        /* A board that failed to load must not render as a board with nothing
           in it — "no pipeline" and "we could not read the pipeline" are
           different answers and only one of them is safe to act on. */
        <div className="ok-load-error" role="alert">
          <XCircle size={28} />
          <div>
            <div className="ok-load-error-title">Opportunity board unavailable</div>
            <div className="ok-load-error-msg">{loadError}</div>
          </div>
          <button className="ok-btn-outline" onClick={load}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : view === 'priority' ? (
        /* ── Priority Queue view — AI-ranked "work these first" ── */
        <div className="ok-list-wrap">
          {priorityLoading ? (
            <div className="ok-loading"><div className="ok-spinner" /></div>
          ) : priorityQueue.length === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af' }}>
              <Target size={36} style={{ marginBottom: 12, opacity: 0.3 }} />
              <div style={{ fontWeight: 600, color: '#374151' }}>No open opportunities to rank</div>
            </div>
          ) : (
            <table className="ok-table">
              <thead>
                <tr>
                  <th>Priority</th><th>Name</th><th>Stage</th><th>Value</th>
                  <th>Why</th><th>Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {priorityQueue.map(o => (
                  <tr key={o.opportunity_id}>
                    <td>
                      <span
                        className="ok-stage-badge"
                        style={{ background: bandLight(o.priority_band), color: bandColor(o.priority_band) }}
                        title={`Score: ${o.priority_score}/100`}
                      >
                        {o.priority_band} &middot; {o.priority_score}
                      </span>
                    </td>
                    <td>
                      <button
                        className="ok-link"
                        onClick={() => {
                          const found = allOpps.find(a => a.id === o.opportunity_id);
                          if (found) setDetailOpp(found);
                        }}
                      >
                        {o.opportunity_name}
                      </button>
                    </td>
                    <td>{o.stage}</td>
                    <td style={{ fontWeight: 600 }}>{fmt(o.expected_value)}</td>
                    <td style={{ color: '#6b7280', fontSize: 12 }}>{o.top_driver || '—'}</td>
                    <td style={{ fontSize: 12 }}>{o.recommendation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
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
                const stg = stages.find(s => s.key === opp._stageKey) || stages[0];
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
                      <span className="ok-stage-badge" style={{ background: tint(stg.color), color: stg.color }}>
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
          {stages.map(({ key, label, color }) => {
            const cards = board[key] || [];
            const stageValue = cards.reduce((s, o) => s + parseFloat(o.expected_value || 0), 0);
            const unmapped = key === UNMAPPED_KEY;
            // An empty Unmapped column is the healthy case — don't take up a
            // lane telling people nothing is wrong.
            if (unmapped && cards.length === 0) return null;
            const light = tint(color);
            return (
              <div key={key} className="ok-col">
                <div className="ok-col-hd" style={{ borderTop: `3px solid ${color}` }}>
                  <div className="ok-col-hd-top">
                    <span className="ok-col-title" style={{ color }}>{label || key}</span>
                    <span className="ok-col-count" style={{ background: light, color }}>{cards.length}</span>
                  </div>
                  {unmapped && (
                    <span className="ok-col-warn" title="These opportunities sit in a stage that is not configured in Pipeline Settings. They are counted in the pipeline total but cannot be worked until the stage is added or the opportunity is moved.">
                      Stage not in Pipeline Settings
                    </span>
                  )}
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
                              // `Unmapped` is not one of the options, so binding
                              // value to it would make the browser display the
                              // first option instead — the card would read as if
                              // it were already in Prospecting. Show the card's
                              // real (unconfigured) stage as a disabled entry.
                              value={unmapped ? '' : key}
                              onChange={e => e.target.value && moveStage(opp, e.target.value)}
                              onClick={e => e.stopPropagation()}
                            >
                              {unmapped && (
                                <option value="" disabled>
                                  {opp.stage ? `${opp.stage} — move to…` : 'Move to…'}
                                </option>
                              )}
                              {targetStages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                            </select>
                          )}
                        </div>
                        {/* Hover quick actions */}
                        {!readOnly && !isClosed(key) && (
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

      {/* Shared by the close dialog and the detail drawer's attribution editor;
          neither is mounted at the same time as the other, so the options live
          here rather than inside either one. */}
      <datalist id="ok-competitor-options">
        {competitorList.map(c => <option key={c.id} value={c.name} />)}
      </datalist>

      {/* ── Win/Loss Reason Modal ── */}
      {pendingMove && (
        <div className="ok-overlay" onClick={() => setPendingMove(null)}>
          <div className="ok-drawer" style={{ maxWidth: 440, top: '30%', height: 'auto' }} onClick={e => e.stopPropagation()}>
            <div className="ok-drawer-hd">
              <h3 style={{ color: isWonStage(pendingMove.newStage) ? '#059669' : '#6b7280' }}>
                Mark as {pendingMove.newStage}
              </h3>
              <button className="ok-icon-btn" onClick={() => setPendingMove(null)}><X size={16} /></button>
            </div>
            <div className="ok-drawer-body" style={{ flex: 'none' }}>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
                Select a {isWonStage(pendingMove.newStage) ? 'win' : 'loss'} reason for{' '}
                <strong>{pendingMove.opp.opportunity_name}</strong>
              </p>
              <div className="ok-field">
                <label>{isWonStage(pendingMove.newStage) ? 'Win' : 'Loss'} Reason</label>
                <select value={selectedReason} onChange={e => setSelectedReason(e.target.value)}>
                  <option value="">— Select a reason (optional) —</option>
                  {winLossReasons
                    .filter(r => r.type === (isWonStage(pendingMove.newStage) ? 'win' : 'loss') && r.is_active)
                    .map(r => <option key={r.id} value={r.reason}>{r.reason}</option>)}
                </select>
              </div>
              {/* Who the deal went to. This is the only place it gets captured,
                  and it is what the Sales Command Center's Top Competitors
                  panel counts. */}
              <div className="ok-field">
                <label>{isWonStage(pendingMove.newStage) ? 'Won Against' : 'Lost To'} (Competitor)</label>
                <input
                  list="ok-competitor-options"
                  value={selectedCompetitor}
                  onChange={e => setSelectedCompetitor(e.target.value)}
                  placeholder={competitorList.length
                    ? '— Select or type a competitor (optional) —'
                    : '— Type a competitor name (optional) —'}
                />
                <p style={{ margin: '6px 0 0', fontSize: 11, color: '#9ca3af' }}>
                  Feeds Top Competitors on the Sales Command Center.
                </p>
              </div>
            </div>
            <div className="ok-drawer-ft">
              <button className="ok-btn-outline" onClick={() => setPendingMove(null)}>Cancel</button>
              <button
                className="ok-btn-primary"
                style={{ background: isWonStage(pendingMove.newStage) ? '#059669' : '#6b7280' }}
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
                  const stg = stages.find(s => s.key === detailOpp.stage || s.key.toLowerCase() === (detailOpp.stage || '').toLowerCase()) || stages[stages.length - 1];
                  return stg ? (
                    <span className="ok-stage-badge" style={{ background: tint(stg.color), color: stg.color }}>
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
              {/* A closed deal's attribution stays editable. The close dialog
                  only fires on the transition, so this is the only way to tag
                  a deal that was already lost — the entire historical backlog. */}
              {isClosed(detailOpp.stage) && !readOnly && (
                <div className="ok-detail-notes">
                  <span className="ok-detail-label">
                    {isWonStage(detailOpp.stage) ? 'Win' : 'Loss'} Attribution
                  </span>
                  <div className="ok-field" style={{ marginTop: 8 }}>
                    <label>{isWonStage(detailOpp.stage) ? 'Win' : 'Loss'} Reason</label>
                    <select
                      value={closeEdit.reason}
                      onChange={e => setCloseEdit(c => ({ ...c, reason: e.target.value }))}
                    >
                      <option value="">— Not recorded —</option>
                      {/* A reason already on the record but no longer in the
                          master still has to be selectable, or saving would
                          silently drop it. */}
                      {closeEdit.reason &&
                        !winLossReasons.some(r => r.reason === closeEdit.reason) && (
                          <option value={closeEdit.reason}>{closeEdit.reason}</option>
                        )}
                      {winLossReasons
                        .filter(r => r.type === (isWonStage(detailOpp.stage) ? 'win' : 'loss') && r.is_active)
                        .map(r => <option key={r.id} value={r.reason}>{r.reason}</option>)}
                    </select>
                  </div>
                  <div className="ok-field" style={{ marginTop: 8 }}>
                    <label>{isWonStage(detailOpp.stage) ? 'Won Against' : 'Lost To'} (Competitor)</label>
                    <input
                      list="ok-competitor-options"
                      value={closeEdit.competitor}
                      onChange={e => setCloseEdit(c => ({ ...c, competitor: e.target.value }))}
                      placeholder="— Not recorded —"
                    />
                  </div>
                  <button
                    className="ok-btn-primary"
                    style={{ marginTop: 10, background: '#6d28d9' }}
                    disabled={savingClose}
                    onClick={saveCloseDetails}
                  >
                    {savingClose ? 'Saving…' : 'Save attribution'}
                  </button>
                </div>
              )}
            </div>
            {!isClosed(detailOpp.stage) && (
              <div className="ok-drawer-ft">
                <button className="ok-btn-outline" onClick={() => setDetailOpp(null)}>Close</button>
                {(sameStage(detailOpp.stage, 'proposal') || sameStage(detailOpp.stage, 'negotiation')) && (
                  <button
                    className="ok-btn-primary"
                    style={{ background: '#6d28d9' }}
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
            {isWonStage(detailOpp.stage) && (
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
                    {targetStages.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
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
    </PageShell>
  );
}
