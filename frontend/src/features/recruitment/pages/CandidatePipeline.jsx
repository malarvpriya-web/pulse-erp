import { useState, useCallback, useEffect } from 'react';
import { Plus, RefreshCw, ChevronRight, ChevronLeft, Mail, Phone, Star, UserPlus } from 'lucide-react';
import api from '@/services/api/client';
import {
  candidateRows, stageColumns, ACTIVE_STAGES, DEADEND_STAGES, sourceLabel, sourceColor,
} from '../shared/constants';
import { useToast } from '@/context/ToastContext';
import useAppStore from '@/store/useAppStore';
import { rememberCandidateSequence } from '../shared/listReturn';
import AddCandidateDialog from '../shared/components/AddCandidateDialog';
import './CandidatePipeline.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

/**
 * Pipeline board for one job opening.
 *
 * Columns come from shared/constants.js (ACTIVE_STAGES), the same list the API
 * enforces. This page used to keep its own six-stage copy with no Shortlisted,
 * Assessment or Selected column, so candidates in those stages vanished from
 * the board (audit 2026-11-17).
 *
 * `embedded`: rendered as a tab of the Candidates hub, which owns the shell and
 * the "Add candidate" button (passed in as onAdd).
 */
const STAGES = stageColumns(ACTIVE_STAGES);
const PARKED = stageColumns(DEADEND_STAGES);

export default function CandidatePipeline({ setPage, embedded = false, onAdd }) {
  const selectedJobId    = useAppStore(s => s.selectedJobId);
  const setSelectedJobId = useAppStore(s => s.setSelectedJobId);
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);
  const [openings,    setOpenings]    = useState([]);
  const [candidates,  setCandidates]  = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [selJob,      setSelJob]      = useState(selectedJobId || '');
  const [moving,      setMoving]      = useState(null);
  const [showParked,  setShowParked]  = useState(false);
  const [adding,      setAdding]      = useState(false);

  const _toast = useToast();
  const showToast = useCallback((msg, type = 'success') => _toast({ message: msg, type }), [_toast]);

  const loadOpenings = useCallback(async () => {
    try {
      const res = await api.get('/recruitment/openings', { params: { status: 'open' } });
      const list = Array.isArray(res.data) ? res.data : [];
      setOpenings(list);
      const preferred = selectedJobId || '';
      const valid = preferred && list.some(o => String(o.id) === String(preferred));
      setSelJob(j => j || (valid ? preferred : list.length ? list[0].id : ''));
    } catch (err) {
      showToast(err?.response?.data?.error || 'Could not load job openings', 'error');
      setOpenings([]);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCandidates = useCallback(async () => {
    if (!selJob) { setCandidates([]); return; }
    setLoading(true);
    try {
      const res = await api.get('/recruitment/candidates', { params: { applied_job_id: selJob, limit: 500 } });
      setCandidates(candidateRows(res.data));
    } catch (err) {
      showToast(err?.response?.data?.error || 'Could not load candidates', 'error');
      setCandidates([]);
    } finally { setLoading(false); }
  }, [selJob, showToast]);

  useEffect(() => { loadOpenings(); }, [loadOpenings]);
  useEffect(() => { loadCandidates(); }, [loadCandidates]);
  // The add drawer defaults to the job on screen.
  useEffect(() => { if (selJob) setSelectedJobId(selJob); }, [selJob, setSelectedJobId]);

  const moveStage = async (candidate, direction) => {
    const idx = ACTIVE_STAGES.indexOf(candidate.current_stage);
    const next = ACTIVE_STAGES[idx + direction];
    if (idx < 0 || !next) return;
    setMoving(candidate.id);
    try {
      await api.post(`/recruitment/candidates/${candidate.id}/move-stage`, { new_stage: next });
      setCandidates(cs => cs.map(c => c.id === candidate.id ? { ...c, current_stage: next } : c));
      showToast(`${candidate.full_name} → ${STAGES[idx + direction].title}`);
    } catch (err) {
      showToast(err?.response?.data?.error || 'Could not move the candidate', 'error');
    } finally {
      setMoving(null);
    }
  };

  const openProfile = (id) => {
    // Previous / Next on the profile walks the board column by column.
    rememberCandidateSequence(columns.flatMap(s => board[s.key].map(c => c.id)));
    setSelectedCandidateId(id);
    setPage?.('CandidateDetail');
  };

  const board = [...STAGES, ...PARKED].reduce((acc, s) => {
    acc[s.key] = candidates.filter(c => c.current_stage === s.key);
    return acc;
  }, {});
  const activeCount = STAGES.reduce((n, s) => n + board[s.key].length, 0);
  const parkedCount = PARKED.reduce((n, s) => n + board[s.key].length, 0);
  const columns = showParked ? [...STAGES, ...PARKED] : STAGES;
  const add = () => (onAdd ? onAdd() : setAdding(true));

  const body = (
    <>
      <div className="cp-header">
        <p className="cp-sub">{activeCount} in the pipeline · {parkedCount} parked</p>
        <div className="cp-header-r">
          <select className="cp-job-sel" value={selJob} onChange={e => setSelJob(e.target.value)} aria-label="Job opening">
            {openings.length === 0 && <option value="">No open jobs</option>}
            {openings.map(o => <option key={o.id} value={o.id}>{o.job_title}{o.department ? ` — ${o.department}` : ''}</option>)}
          </select>
          <button
            className={showParked ? 'cp-btn-outline cp-btn-active' : 'cp-btn-outline'}
            onClick={() => setShowParked(v => !v)}
            title="Show or hide the Maybe, Future Use, Not Suitable and Rejected columns"
          >
            {showParked ? 'Hide' : 'Show'} parked {parkedCount > 0 ? `(${parkedCount})` : ''}
          </button>
          <button className="cp-icon-btn" onClick={loadCandidates} aria-label="Refresh"><RefreshCw size={14} /></button>
          {!onAdd && <button className="cp-btn-primary" onClick={add}><Plus size={14} /> Add candidate</button>}
        </div>
      </div>

      {loading ? (
        <div className="cp-loading"><div className="cp-spinner" /></div>
      ) : openings.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <p style={{ fontWeight: 600, marginBottom: 6 }}>No open jobs</p>
          <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>Open a job under Jobs → Job Openings to see its pipeline here.</p>
          <button className="pulse-btn-secondary" onClick={() => setPage?.('Jobs')}>Go to Jobs</button>
        </div>
      ) : (
        <div className="cp-board">
          {columns.map((stage) => {
            const inFlow = ACTIVE_STAGES.indexOf(stage.key);
            return (
              <div key={stage.key} className="cp-col">
                <div className="cp-col-hd" style={{ background: stage.bg }}>
                  <span className="cp-col-title" style={{ color: stage.color }}>{stage.title}</span>
                  <span className="cp-col-count" style={{ color: stage.color }}>{board[stage.key].length}</span>
                </div>
                <div className="cp-col-body">
                  {board[stage.key].length === 0 && <div className="cp-col-empty">No candidates</div>}
                  {board[stage.key].map(c => {
                    const rating = Number(c.overall_rating) || 0;
                    const src = sourceColor(c.source);
                    return (
                      <div key={c.id} className="cp-card">
                        <button type="button" className="cp-card-hd" onClick={() => openProfile(c.id)}
                                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', width: '100%' }}>
                          <div className="cp-avatar">{(c.full_name || '?').charAt(0)}</div>
                          <div>
                            <h4 className="cp-cname">{c.full_name}</h4>
                            <span className="cp-role">{c.current_designation || c.job_title || '—'}</span>
                          </div>
                        </button>
                        <div className="cp-card-info">
                          {c.email && <span className="cp-email"><Mail size={11} />{c.email}</span>}
                          {c.phone && <span className="cp-phone"><Phone size={11} />{c.phone}</span>}
                        </div>
                        <div className="cp-card-ft">
                          <span className="cp-src-badge" style={{ background: src.bg, color: src.color }}>{sourceLabel(c.source)}</span>
                          {rating > 0 && (
                            <div className="cp-score" title="Average interview rating">
                              <Star size={11} color="var(--color-primary, #6B3FDB)" />
                              <span>{rating.toFixed(1)}/5</span>
                            </div>
                          )}
                        </div>
                        {inFlow >= 0 && (
                          <div className="cp-card-moves">
                            <button className="cp-move-btn" disabled={inFlow === 0 || moving === c.id} onClick={() => moveStage(c, -1)} title="Move back" aria-label="Move back">
                              <ChevronLeft size={13} />
                            </button>
                            <button className="cp-move-btn" disabled={inFlow === ACTIVE_STAGES.length - 1 || moving === c.id} onClick={() => moveStage(c, 1)} title="Move forward" aria-label="Move forward">
                              <ChevronRight size={13} />
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

      {!onAdd && (
        <AddCandidateDialog open={adding} onClose={() => setAdding(false)} defaultJobId={selJob}
                            onCreated={() => { showToast('Candidate added'); loadCandidates(); }} />
      )}
    </>
  );

  if (embedded) return body;
  return (
    <PageShell dock={<PageHero icon={UserPlus} eyebrow="Recruitment" title="Candidate Pipeline" />}>
      {body}
    </PageShell>
  );
}
