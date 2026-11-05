import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw, ChevronDown, Truck, ExternalLink, Filter, Network, Info,
} from 'lucide-react';
import api from '@/services/api/client';
import { fmtDate } from '@/utils/dateFormatter';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import VocabSelect from '@/components/core/VocabSelect';
import { PROJECT_STAGES, UNAVAILABLE, STAGE_META, lifecycleErrorMessage } from '../shared/projectStage';

// The board shows each project in the column of the stage the backend DERIVES
// from its lifecycle (shared/projectStage.js). It no longer moves projects:
// dragging or arrowing a card used to set projects.production_stage directly —
// any column, either direction, no gate, no history. A stage now changes only
// by advancing the project's lifecycle through its gates (Lifecycle Tracker).
//
// Projects with no lifecycle in their company have no stage; they are listed
// in their own "Unavailable stage" column instead of being guessed into one.
const COLUMNS = [...PROJECT_STAGES, UNAVAILABLE];
const emptyColumns = () => Object.fromEntries(COLUMNS.map(s => [s, []]));

export default function ProjectPipelineBoard({ setPage }) {
  const { hasPermission } = useAuth();
  const canViewLifecycle = hasPermission('servicedesk', 'view');
  const [columns, setColumns] = useState(emptyColumns);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  // Pending (panel) vs applied (query) filters — reference spec wants explicit Load.
  const [pendingStages, setPendingStages] = useState([]);
  const [appliedStages, setAppliedStages] = useState([]);
  const [pendingType, setPendingType]     = useState('');
  const [appliedType, setAppliedType]     = useState('');
  const [stageOpen, setStageOpen] = useState(false);

  const isMounted = useRef(true);
  const stageBoxRef = useRef(null);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (appliedStages.length) params.status = appliedStages.join(',');
      if (appliedType) params.project_type = appliedType;
      const res = await api.get('/delivery-tracker/board', { params });
      if (!isMounted.current) return;
      const cols = res.data?.columns || {};
      setColumns({
        ...Object.fromEntries(PROJECT_STAGES.map(s => [s, Array.isArray(cols[s]) ? cols[s] : []])),
        [UNAVAILABLE]: Array.isArray(res.data?.unavailable) ? res.data.unavailable : [],
      });
    } catch (e) {
      if (!isMounted.current) return;
      setError(lifecycleErrorMessage(e, 'view the project pipeline'));
      setColumns(emptyColumns());
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

  const openProject = (card) => { if (setPage) setPage('ProjectDetail', { id: card.project_id }); };
  const openLifecycle = (card) => { if (setPage) setPage('LifecycleTracker', { lifecycleId: card.lifecycle_id }); };

  // ── styles ───────────────────────────────────────────────────────────────
  const inputStyle = { padding: '7px 12px', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 7, fontSize: 13, background: 'var(--color-background-secondary)', color: 'var(--color-text-primary)' };
  const primaryBtn = { padding: '7px 18px', border: 'none', borderRadius: 7, background: '#6B3FDB', color: '#fff', cursor: 'pointer', fontWeight: 600, fontSize: 13 };
  const linkBtn = { display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#6B3FDB', fontWeight: 600, fontSize: 11.5 };

  const stageLabel = pendingStages.length ? `Selected (${pendingStages.length})` : 'All Stages';

  return (
    <PageShell dock={
      <PageHero
        icon={Filter}
        eyebrow="Projects"
        title="Project Pipeline"
        actions={<button className="plh-cta" onClick={load} title="Refresh"><RefreshCw size={14} /></button>}
      />
    }>
      <style>{`@keyframes ppspin { to { transform: rotate(360deg); } }
        .pp-col-body::-webkit-scrollbar{width:7px}
        .pp-col-body::-webkit-scrollbar-thumb{background:var(--color-border-tertiary);border-radius:4px}
      `}</style>

      <p role="note" style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 12px', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
        <Info size={13} /> Stages follow each project&apos;s lifecycle. To move a project, open its lifecycle and advance it through the gates.
      </p>

      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <div ref={stageBoxRef} style={{ position: 'relative' }}>
          <button onClick={() => setStageOpen(o => !o)} style={{ ...inputStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', minWidth: 170 }}>
            <span style={{ flex: 1, textAlign: 'left' }}>{stageLabel}</span>
            <ChevronDown size={14} />
          </button>
          {stageOpen && (
            <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 30, minWidth: 200, padding: 6 }}>
              {COLUMNS.map(s => (
                <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', fontSize: 13, cursor: 'pointer', borderRadius: 6, color: 'var(--color-text-primary)' }}>
                  <input type="checkbox" checked={pendingStages.includes(s)} onChange={() => toggleStage(s)} />
                  {STAGE_META[s].label}
                </label>
              ))}
              {pendingStages.length > 0 && (
                <button onClick={() => setPendingStages([])} style={{ width: '100%', marginTop: 4, padding: '5px 0', border: 'none', background: 'none', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' }}>Clear</button>
              )}
            </div>
          )}
        </div>

        {/* allowAdd={false}: this is a filter. Minting a project type from it
            would just narrow the board to nothing. */}
        <VocabSelect vocab="project-types" allowAdd={false} value={pendingType}
          onChange={v => setPendingType(v)} placeholder="All Project Types"
          selectStyle={{ ...inputStyle, cursor: 'pointer' }} />

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
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: '0 0 16px' }}>{error}</p>
          <button onClick={load} style={primaryBtn}>Retry</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8, alignItems: 'flex-start' }}>
          {COLUMNS.map(stage => {
            const m = STAGE_META[stage];
            const cards = columns[stage] || [];
            const unavailable = stage === UNAVAILABLE;
            return (
              <section key={stage} aria-label={m.label}
                style={{
                  flex: '0 0 272px', width: 272, display: 'flex', flexDirection: 'column',
                  background: 'var(--color-background-secondary)',
                  border: unavailable ? '1px dashed var(--color-border-tertiary)' : '0.5px solid var(--color-border-tertiary)',
                  borderRadius: 10, maxHeight: 'calc(100vh - 250px)',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '0.5px solid var(--color-border-tertiary)' }}
                  title={unavailable ? 'Projects with no lifecycle in their company — no stage can be shown' : undefined}>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: m.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>{m.label}</span>
                  <span style={{ marginLeft: 'auto', padding: '1px 9px', borderRadius: 10, fontSize: 12, fontWeight: 700, background: m.bg, color: m.color }}>{cards.length}</span>
                </div>

                <div className="pp-col-body" style={{ overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                  {cards.length === 0 ? (
                    <div style={{ padding: '22px 8px', textAlign: 'center', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>No projects</div>
                  ) : cards.map(card => {
                    const deliveryDate = card.actual_delivery_date || card.target_date;
                    return (
                      <article key={card.project_id} data-testid="pipeline-card"
                        style={{
                          background: 'var(--color-background-primary)', border: '0.5px solid var(--color-border-tertiary)',
                          borderRadius: 8, padding: '10px 11px', boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
                        }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <button onClick={() => openProject(card)} title="Open project"
                            style={{ ...linkBtn, fontSize: 12.5, fontWeight: 700 }}>
                            {card.ipp || card.project_code || `Project ${card.project_id}`} <ExternalLink size={11} />
                          </button>
                          {card.project_type && (
                            <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, color: 'var(--color-text-secondary)', background: 'var(--color-background-secondary)', padding: '1px 7px', borderRadius: 8 }}>{card.project_type}</span>
                          )}
                        </div>

                        <p style={{ margin: '0 0 4px', fontSize: 12.5, fontWeight: 500, color: 'var(--color-text-primary)', lineHeight: 1.35 }}>{card.description || 'No description'}</p>
                        {card.customer_name && (
                          <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'var(--color-text-secondary)' }}>{card.customer_name}</p>
                        )}

                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                          <span>Forecast: <b style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{fmtDate(card.forecast_date)}</b></span>
                          <span>Delivery: <b style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{fmtDate(deliveryDate)}</b></span>
                        </div>

                        <div style={{ borderTop: '0.5px solid var(--color-border-tertiary)', paddingTop: 6, fontSize: 11.5 }}>
                          {card.lifecycle_id ? (
                            <button onClick={() => openLifecycle(card)} disabled={!canViewLifecycle}
                              style={canViewLifecycle ? linkBtn : { ...linkBtn, opacity: 0.5, cursor: 'not-allowed' }}
                              title={canViewLifecycle ? "Change the stage through the lifecycle's gated workflow" : 'Viewing lifecycles needs Service Desk view access'}>
                              <Network size={12} /> Open lifecycle
                              {card.stage_source === 'lifecycle_closed' ? ` (${card.lifecycle_status})` : ''}
                            </button>
                          ) : (
                            <span style={{ color: 'var(--color-text-secondary)' }}>No lifecycle — stage unavailable</span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
