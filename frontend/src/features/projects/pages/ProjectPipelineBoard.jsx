import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw, ChevronDown, ChevronLeft, ChevronRight, Truck, ExternalLink, Lock,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';

// Canonical Manifest SST/HVDC production pipeline — mirrors PRODUCTION_STAGES in
// backend deliveryTracker.routes.js and STAGES in ProductionDeliveryTracker.jsx.
const STAGES = ['created', 'handover', 'dr_approval', 'procurement', 'production', 'clearing', 'dispatched'];
const PROJECT_TYPES = ['EPC', 'HVDC', 'STATCOM', 'SST', 'AMC', 'Installation', 'Commissioning', 'O&M', 'Supply', 'Turnkey'];

const STAGE_META = {
  created:     { label: 'Created',      bg: '#f3f4f6', color: '#6b7280' },
  handover:    { label: 'Handover',     bg: '#dbeafe', color: '#2563eb' },
  dr_approval: { label: 'Dr Approval',  bg: '#ede9fe', color: '#7c3aed' },
  procurement: { label: 'Procurement',  bg: '#fef3c7', color: '#d97706' },
  production:  { label: 'Production',   bg: '#e0e7ff', color: '#4338ca' },
  clearing:    { label: 'Clearing',     bg: '#e0f2fe', color: '#0891b2' },
  dispatched:  { label: 'Dispatched',   bg: '#d1fae5', color: '#16a34a' },
};
const meta = (s) => STAGE_META[s] || { label: s, bg: '#f3f4f6', color: '#6b7280' };

export default function ProjectPipelineBoard({ setPage }) {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects', 'edit');

  const [columns, setColumns] = useState(() => Object.fromEntries(STAGES.map(s => [s, []])));
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(false);
  const [toast, setToast]     = useState(null);
  const [moving, setMoving]   = useState(null);       // project_id being moved
  const [dragId, setDragId]   = useState(null);       // project_id being dragged
  const [dragOver, setDragOver] = useState(null);     // stage key hovered while dragging

  // Pending (panel) vs applied (query) filters — reference spec wants explicit Load.
  const [pendingStages, setPendingStages] = useState([]);
  const [appliedStages, setAppliedStages] = useState([]);
  const [pendingType, setPendingType]     = useState('');
  const [appliedType, setAppliedType]     = useState('');
  const [stageOpen, setStageOpen] = useState(false);

  const isMounted = useRef(true);
  const stageBoxRef = useRef(null);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const params = {};
      if (appliedStages.length) params.status = appliedStages.join(',');
      if (appliedType) params.project_type = appliedType;
      const res = await api.get('/delivery-tracker/board', { params });
      if (!isMounted.current) return;
      const cols = res.data?.columns || {};
      setColumns(Object.fromEntries(STAGES.map(s => [s, Array.isArray(cols[s]) ? cols[s] : []])));
    } catch {
      if (!isMounted.current) return;
      setError(true);
      setColumns(Object.fromEntries(STAGES.map(s => [s, []])));
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [appliedStages, appliedType]);

  useEffect(() => { load(); }, [load]);

  // Close the multi-select on outside click.
  useEffect(() => {
    const onClick = (e) => { if (stageBoxRef.current && !stageBoxRef.current.contains(e.target)) setStageOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const toggleStage = (s) => setPendingStages(p => p.includes(s) ? p.filter(x => x !== s) : [...p, s]);
  const applyFilter = () => { setAppliedStages(pendingStages); setAppliedType(pendingType); setStageOpen(false); };

  // Move a project card to another stage. Optimistic: update local columns,
  // roll back on failure. Only stages present in STAGES are valid targets.
  const moveCard = async (card, toStage) => {
    const fromStage = STAGES.includes(card.production_stage) ? card.production_stage : 'created';
    if (fromStage === toStage || !STAGES.includes(toStage)) return;
    const snapshot = columns;
    setMoving(card.project_id);
    // Optimistic local move.
    setColumns(prev => {
      const next = { ...prev };
      next[fromStage] = (next[fromStage] || []).filter(c => c.project_id !== card.project_id);
      next[toStage]   = [{ ...card, production_stage: toStage }, ...(next[toStage] || [])];
      return next;
    });
    try {
      await api.patch(`/projects/projects/${card.project_id}/stage`, { production_stage: toStage });
    } catch {
      if (isMounted.current) { setColumns(snapshot); showToast('Could not update stage — please try again', 'error'); load(); }
    } finally {
      if (isMounted.current) setMoving(null);
    }
  };

  const moveByArrow = (card, dir) => {
    const from = STAGES.includes(card.production_stage) ? card.production_stage : 'created';
    const nextIdx = STAGES.indexOf(from) + dir;
    if (nextIdx < 0 || nextIdx >= STAGES.length) return;
    moveCard(card, STAGES[nextIdx]);
  };

  const openProject = (card) => { if (card.ipp && setPage) setPage('ProjectDetail', { id: card.project_id }); };

  const boardTotal = STAGES.reduce((n, s) => n + (columns[s]?.length || 0), 0);

  // ── styles ───────────────────────────────────────────────────────────────
  const inputStyle = { padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' };
  const toolBtn = { ...inputStyle, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: 'var(--color-text-secondary)' };
  const primaryBtn = { padding: '7px 18px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13 };

  const stageLabel = pendingStages.length
    ? `All selected (${pendingStages.length})`
    : 'All Statuses';

  return (
    <div style={{ padding: 24, background: 'var(--color-background-primary)', minHeight: '100%' }}>
      <style>{`@keyframes ppspin { to { transform: rotate(360deg); } }
        .pp-col-body::-webkit-scrollbar{width:7px}
        .pp-col-body::-webkit-scrollbar-thumb{background:var(--color-border-tertiary);border-radius:4px}
      `}</style>

      {toast && (
        <div style={{ position: 'fixed', top: 18, right: 18, zIndex: 60, padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: '#fff', boxShadow: '0 6px 20px rgba(0,0,0,0.16)', background: toast.type === 'error' ? '#dc2626' : '#16a34a' }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--color-text-primary)' }}>Project Pipeline</h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--color-text-secondary)' }}>Production pipeline by stage — {boardTotal} project{boardTotal !== 1 ? 's' : ''} · drag a card, or use the arrows, to change stage</p>
        </div>
        <button onClick={load} title="Refresh" style={toolBtn}><RefreshCw size={14} /></button>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div ref={stageBoxRef} style={{ position: 'relative' }}>
          <button onClick={() => setStageOpen(o => !o)} style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 170 }}>
            <span style={{ flex: 1, textAlign: 'left' }}>{stageLabel}</span>
            <ChevronDown size={14} />
          </button>
          {stageOpen && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 30, minWidth: 200, padding: 6 }}>
              {STAGES.map(s => (
                <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 13, cursor: 'pointer', borderRadius: 6, color: 'var(--color-text-primary)' }}>
                  <input type="checkbox" checked={pendingStages.includes(s)} onChange={() => toggleStage(s)} />
                  {meta(s).label}
                </label>
              ))}
              {pendingStages.length > 0 && (
                <button onClick={() => setPendingStages([])} style={{ width: '100%', marginTop: 4, padding: '5px 0', border: 'none', background: 'none', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' }}>Clear</button>
              )}
            </div>
          )}
        </div>

        <select value={pendingType} onChange={e => setPendingType(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="">All Project Types</option>
          {PROJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>

        <button onClick={applyFilter} style={primaryBtn}>Load</button>
      </div>

      {/* Board */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '80px 0' }}>
          <RefreshCw size={22} style={{ color: 'var(--color-text-secondary)', animation: 'ppspin 1s linear infinite' }} />
        </div>
      ) : error ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '64px 24px', textAlign: 'center' }}>
          <Truck size={34} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
          <p style={{ fontWeight: 500, color: 'var(--color-text-primary)', margin: '0 0 4px' }}>Could not load the pipeline</p>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>Check your connection and try again.</p>
          <button onClick={load} style={primaryBtn}>Retry</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
          {STAGES.map(stage => {
            const m = meta(stage);
            const cards = columns[stage] || [];
            const isDropTarget = dragOver === stage;
            return (
              <div
                key={stage}
                onDragOver={(e) => { if (dragId != null) { e.preventDefault(); setDragOver(stage); } }}
                onDragLeave={() => setDragOver(o => (o === stage ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  const card = STAGES.flatMap(s => columns[s]).find(c => c.project_id === dragId);
                  if (card) moveCard(card, stage);
                  setDragId(null); setDragOver(null);
                }}
                style={{
                  flex: '0 0 272px', width: 272, display: 'flex', flexDirection: 'column',
                  background: isDropTarget ? 'rgba(107,63,219,0.06)' : 'var(--color-background-secondary)',
                  border: isDropTarget ? '1px dashed #6B3FDB' : '0.5px solid var(--color-border-tertiary)',
                  borderRadius: 10, maxHeight: 'calc(100vh - 250px)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '0.5px solid var(--color-border-tertiary)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: m.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>{m.label}</span>
                  <span style={{ marginLeft: 'auto', padding: '1px 9px', borderRadius: 10, fontSize: 12, fontWeight: 700, background: m.bg, color: m.color }}>{cards.length}</span>
                </div>

                <div className="pp-col-body" style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                  {cards.length === 0 ? (
                    <div style={{ padding: '22px 8px', textAlign: 'center', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>No projects</div>
                  ) : cards.map(card => {
                    const idx = STAGES.indexOf(stage);
                    const isMoving = moving === card.project_id;
                    const deliveryDate = card.actual_delivery_date || card.target_date;
                    return (
                      <div
                        key={card.project_id}
                        draggable={canEdit && !isMoving}
                        onDragStart={() => canEdit && setDragId(card.project_id)}
                        onDragEnd={() => { setDragId(null); setDragOver(null); }}
                        style={{
                          background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)',
                          borderRadius: 8, padding: '10px 11px', boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                          cursor: canEdit ? 'grab' : 'default', opacity: isMoving ? 0.55 : 1,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          {card.ipp ? (
                            <button onClick={() => openProject(card)} title="Open project"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#6B3FDB', fontWeight: 700, fontSize: 12.5 }}>
                              {card.ipp} <ExternalLink size={11} />
                            </button>
                          ) : (
                            <span style={{ color: 'var(--color-text-secondary)', fontSize: 12.5, fontWeight: 600 }}>{card.project_code || '—'}</span>
                          )}
                          {card.project_type && (
                            <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', padding: '1px 7px', borderRadius: 8 }}>{card.project_type}</span>
                          )}
                        </div>

                        <p style={{ margin: '0 0 4px', fontSize: 12.5, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.35 }}>{card.description || 'No description'}</p>
                        {card.customer_name && (
                          <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'var(--color-text-secondary)' }}>{card.customer_name}</p>
                        )}

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: canEdit ? 8 : 0 }}>
                          <span>Forecast: <b style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{fmtDate(card.forecast_date)}</b></span>
                          <span>Delivery: <b style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{fmtDate(deliveryDate)}</b></span>
                        </div>

                        {canEdit && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '0.5px solid var(--color-border-tertiary)', paddingTop: 6 }}>
                            <button onClick={() => moveByArrow(card, -1)} disabled={idx === 0 || isMoving} title="Previous stage"
                              style={{ background: 'none', border: 'none', cursor: idx === 0 || isMoving ? 'default' : 'pointer', color: idx === 0 ? 'var(--color-border-tertiary)' : 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', padding: 2 }}>
                              <ChevronLeft size={15} />
                            </button>
                            <button onClick={() => moveByArrow(card, 1)} disabled={idx === STAGES.length - 1 || isMoving} title="Next stage"
                              style={{ background: 'none', border: 'none', cursor: idx === STAGES.length - 1 || isMoving ? 'default' : 'pointer', color: idx === STAGES.length - 1 ? 'var(--color-border-tertiary)' : 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', padding: 2 }}>
                              <ChevronRight size={15} />
                            </button>
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

      {!canEdit && !loading && !error && (
        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Lock size={12} /> You have view-only access — stage changes are disabled.
        </p>
      )}
    </div>
  );
}
