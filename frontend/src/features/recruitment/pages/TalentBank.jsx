import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Archive, Search, X, CalendarClock, Users2, ChevronRight, Check, Settings2,
  Shuffle, SlidersHorizontal, Trash2, Pencil, Plus, Bell,
} from 'lucide-react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/dateFormatter';
import { PageHero, PageShell } from '@/components/pulse-ui';
import {
  dispositionLabel, dispositionColor, relocationLabel, relocationColor,
  stageLabelShort, stageColor, CLASSIFICATION_LABELS,
} from '../shared/constants';
import {
  Modal, PutForwardDialog, RemoveFromBankDialog, FutureOpportunityDialog,
} from '../shared/components/CandidateActionDialogs';
import './talent-bank.css';

/**
 * TalentBank — good candidates Manifest has met and decided to keep, searched
 * when a new role opens.
 *
 * The candidate list answers "who is in play for the roles we are hiring for
 * now"; the Talent Bank answers "who have we already met who would suit a role
 * we are about to open".
 *
 * ── HOW PEOPLE GET IN ───────────────────────────────────────────────────────
 * A recruiter keeps them from Screening (outcome Talent Bank / Future
 * Opportunity), from the Candidates list, or from the candidate profile. They
 * are kept under one or more CATEGORIES (table talent_pools). Future
 * Opportunity also sets a date to contact them again.
 *
 * ── HOW THEY GET OUT ────────────────────────────────────────────────────────
 * "Put forward" adds them to open jobs and brings them back into active hiring.
 * "Remove" takes them out of a category or out of the bank. Nothing is deleted.
 *
 * ── CATEGORIES ──────────────────────────────────────────────────────────────
 * Managed here (Manage categories). Until 2026-11-17 they were also a separate
 * "Talent Pools" page under Sourcing, with its own add-member path that skipped
 * status, stage and history — same table, two screens, two behaviours. That page
 * and its detail page were removed.
 *
 * ── WHAT COUNTS AS "IN THE BANK" ───────────────────────────────────────────
 * Status Talent Bank / Future Opportunity, OR membership of any category.
 */

const EXPERIENCE_BANDS = [
  { value: 'all',  label: 'Any experience', min: undefined, max: undefined },
  { value: '0-2',  label: '0-2 years',  min: 0,  max: 2 },
  { value: '2-5',  label: '2-5 years',  min: 2,  max: 5 },
  { value: '5-10', label: '5-10 years', min: 5,  max: 10 },
  { value: '10',   label: '10+ years',  min: 10, max: undefined },
];

const QUALIFICATIONS = ['Diploma', 'BE/BTech', 'ME/MTech', 'MBA', 'MCA', 'BCA', 'BSc', 'MSc', 'BCom', 'PhD', 'Other'];

export const CATEGORY_GROUPS = [
  { value: 'engineering', label: 'Engineering' },
  { value: 'product',     label: 'Product / Technology' },
  { value: 'operations',  label: 'Operations' },
  { value: 'commercial',  label: 'Commercial' },
  { value: 'corporate',   label: 'Corporate' },
  { value: 'pipeline',    label: 'Pipeline' },
  { value: 'other',       label: 'Other' },
];
const GROUP_LABEL = Object.fromEntries(CATEGORY_GROUPS.map(g => [g.value, g.label]));
const GROUP_ORDER = CATEGORY_GROUPS.map(g => g.value);

const PARAMS = {
  q: 'q', pool: 'pool', dept: 'dept', exp: 'exp', state: 'state', city: 'city',
  relocate: 'relo', qual: 'qual', spec: 'spec', company: 'co', role: 'role',
  notice: 'notice', ctc: 'ctc', score: 'score', skills: 'skills', rtext: 'rtext',
  prev: 'prev', disp: 'disp', cls: 'cls',
};

const DEFAULTS = {
  q: '', pool: 'all', dept: 'all', exp: 'all', state: '', city: '',
  relocate: 'all', qual: 'all', spec: '', company: '', role: '',
  notice: 'all', ctc: '', score: 'all', skills: '', rtext: '',
  prev: 'all', disp: 'all', cls: 'all',
};

// Shown behind "More filters". The five always-visible ones are the brief's
// worked example: skills + experience + location + relocation + department.
const MORE_KEYS = ['city', 'qual', 'spec', 'company', 'role', 'notice', 'ctc', 'score', 'prev', 'disp', 'cls', 'rtext'];

function groupPools(pools) {
  const map = new Map();
  for (const p of pools) {
    const k = p.category || 'other';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(p);
  }
  return [...map.entries()].sort((a, b) =>
    (GROUP_ORDER.indexOf(a[0]) === -1 ? 99 : GROUP_ORDER.indexOf(a[0])) - (GROUP_ORDER.indexOf(b[0]) === -1 ? 99 : GROUP_ORDER.indexOf(b[0]))
  );
}

export default function TalentBank({ setPage, embedded = false }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);

  const [sp, setSp] = useSearchParams();

  // URL-as-store: a Talent Bank search is worth keeping and sending as a link.
  const f = useMemo(() => {
    const out = { ...DEFAULTS };
    for (const [k, p] of Object.entries(PARAMS)) {
      const v = sp.get(p);
      if (v !== null && v !== '') out[k] = v;
    }
    // Old links used ?tags= for the skills box.
    if (!out.skills && sp.get('tags')) out.skills = sp.get('tags');
    return out;
  }, [sp]);

  const set = useCallback((key, value) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      const p = PARAMS[key];
      if (!p) return next;
      if (key === 'skills') next.delete('tags');
      if (value === '' || value === null || value === undefined || value === DEFAULTS[key]) next.delete(p);
      else next.set(p, String(value));
      return next;
    }, { replace: true });
  }, [setSp]);

  const reset = useCallback(() => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const p of Object.values(PARAMS)) next.delete(p);
      next.delete('tags');
      return next;
    }, { replace: true });
  }, [setSp]);

  const activeCount = useMemo(
    () => Object.keys(DEFAULTS).filter(k => f[k] !== DEFAULTS[k]).length,
    [f]
  );
  const moreActive = useMemo(() => MORE_KEYS.filter(k => f[k] !== DEFAULTS[k]).length, [f]);
  const [showMore, setShowMore] = useState(false);
  useEffect(() => { if (moreActive > 0) setShowMore(true); }, [moreActive]);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [bankSize, setBankSize] = useState(0);
  const [pools, setPools] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [due, setDue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // dialogs
  const [putForward, setPutForward] = useState(null);       // candidate
  const [removing, setRemoving] = useState(null);           // { candidate, poolId, poolName }
  const [remindLater, setRemindLater] = useState(null);     // recontact row
  const [managing, setManaging] = useState(false);

  const loadPools = useCallback(() => api.get('/recruitment/talent-bank/pools')
    .then(p => setPools(Array.isArray(p.data) ? p.data : []))
    .catch(() => setPools([])), []);

  const loadDue = useCallback(() => api.get('/recruitment/recontacts', { params: { due_only: true, limit: 25 } })
    .then(r => setDue(Array.isArray(r.data) ? r.data : []))
    .catch(() => setDue([])), []);

  useEffect(() => {
    loadPools();
    loadDue();
    api.get('/recruitment/meta/candidate-workbench')
      .then(m => setDepartments(m.data?.departments || []))
      .catch(() => {});
  }, [loadPools, loadDue]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    const band = EXPERIENCE_BANDS.find(b => b.value === f.exp);
    if (f.q.trim())      p.set('search', f.q.trim());
    if (f.pool !== 'all') p.set('pool_id', f.pool);
    if (f.dept !== 'all') p.set('department', f.dept);
    if (f.disp !== 'all') p.set('disposition', f.disp);
    if (f.cls !== 'all')  p.set('classification', f.cls);
    if (f.state.trim())   p.set('state', f.state.trim());
    if (f.city.trim())    p.set('city', f.city.trim());
    if (f.relocate !== 'all') p.set('willing_to_relocate', f.relocate);
    if (f.qual !== 'all') p.set('qualification', f.qual);
    if (f.spec.trim())    p.set('specialisation', f.spec.trim());
    if (f.company.trim()) p.set('previous_company', f.company.trim());
    if (f.role.trim())    p.set('current_role', f.role.trim());
    if (f.notice !== 'all') p.set('notice_period_max', f.notice);
    if (f.ctc.trim())     p.set('expected_ctc_max', f.ctc.trim());
    if (f.score !== 'all') p.set('min_screening_score', f.score);
    // Candidate skills OR banking tags, every term required (backend).
    if (f.skills.trim())  p.set('skills', f.skills.trim());
    if (f.rtext.trim())   p.set('resume_text', f.rtext.trim());
    if (f.prev === 'yes') p.set('has_previous_application', 'true');
    if (band?.min !== undefined) p.set('experience_min', String(band.min));
    if (band?.max !== undefined) p.set('experience_max', String(band.max));
    p.set('limit', '60');
    return p;
  }, [f]);

  const search = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/recruitment/talent-bank?${query.toString()}`);
      setRows(res.data?.rows || []);
      setTotal(res.data?.total ?? 0);
      setBankSize(res.data?.bank_size ?? res.data?.total ?? 0);
      setLoadError(null);
    } catch (e) {
      if (e?.code === 'ERR_CANCELED') return;
      setRows([]); setTotal(0);
      setLoadError(e?.response?.data?.error || 'Could not load the Talent Bank.');
    } finally { setLoading(false); }
  }, [query]);

  useEffect(() => {
    const t = setTimeout(search, 280);
    return () => clearTimeout(t);
  }, [search]);

  const refreshAll = useCallback(() => { search(); loadPools(); loadDue(); }, [search, loadPools, loadDue]);

  const open = (id) => { setSelectedCandidateId(id); setPage?.('CandidateDetail'); };

  const markContacted = async (rc) => {
    try {
      await api.post(`/recruitment/recontacts/${rc.id}/complete`, { status: 'done', reengage: false });
      toast(`${rc.full_name} marked as contacted. They stay in the Talent Bank.`);
      refreshAll();
    } catch (e) { toast(e?.response?.data?.error || 'Could not update', 'error'); }
  };

  // "Remind later": the new reminder is saved first (the dialog), and only then
  // is the old one closed — cancelling the dialog leaves the old one due.
  const afterRemindLater = async () => {
    const rc = remindLater;
    setRemindLater(null);
    try {
      await api.post(`/recruitment/recontacts/${rc.id}/complete`, {
        status: 'done', reengage: false, outcome_note: 'Contacted — asked to be reminded again later',
      });
    } catch { /* the new reminder is saved; the old one simply stays listed */ }
    refreshAll();
  };

  const groupedPools = useMemo(() => groupPools(pools), [pools]);
  const poolName = (id) => pools.find(p => String(p.id) === String(id))?.pool_name;

  const body = (
    <div className="tbank">
      {/* ── Reminders due — the one thing on this page with a deadline ───── */}
      {due.length > 0 && (
        <section className="tbank-due" aria-label="Recontacts due">
          <header className="tbank-due-head">
            <CalendarClock size={15} />
            <h3>{due.length} candidate{due.length === 1 ? '' : 's'} due for recontact</h3>
          </header>
          <div className="tbank-due-list">
            {due.map(rc => (
              <div key={rc.id} className="tbank-due-row">
                <div className="tbank-due-main">
                  <button type="button" className="tbank-link" onClick={() => open(rc.candidate_id)}>
                    {rc.full_name}
                  </button>
                  <span className="tbank-due-sub">
                    {rc.potential_role || rc.department || 'no role noted'}
                    {' · due '}{fmtDate(rc.recontact_on)}
                    {rc.days_until_due < 0 ? ` (${Math.abs(rc.days_until_due)}d overdue)` : ''}
                  </span>
                </div>
                <div className="tbank-due-acts">
                  <button type="button" className="tbank-mini tbank-mini--go"
                    title="Add them to an open job — brings them back into hiring"
                    onClick={() => setPutForward({ id: rc.candidate_id, full_name: rc.full_name })}>
                    <Shuffle size={12} /> Put forward
                  </button>
                  <button type="button" className="tbank-mini" title="Contacted, no role for them yet"
                    onClick={() => markContacted(rc)}>
                    <Check size={12} /> Contacted
                  </button>
                  <button type="button" className="tbank-mini" title="Set a new date to contact them"
                    onClick={() => setRemindLater(rc)}>
                    <Bell size={12} /> Remind later
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Categories ───────────────────────────────────────────────────── */}
      <section className="tbank-cats" aria-label="Categories">
        <button
          type="button"
          className={`tbank-cat${f.pool === 'all' ? ' is-on' : ''}`}
          onClick={() => set('pool', 'all')}
        >
          Everyone <span className="tbank-cat-n">{bankSize}</span>
        </button>
        {groupedPools.map(([cat, list]) => (
          <div key={cat} className="tbank-cat-group">
            <span className="tbank-cat-label">{GROUP_LABEL[cat] || cat}</span>
            {list.map(p => (
              <button
                key={p.id}
                type="button"
                className={`tbank-cat${String(f.pool) === String(p.id) ? ' is-on' : ''}`}
                onClick={() => set('pool', String(f.pool) === String(p.id) ? 'all' : p.id)}
              >
                {p.pool_name}
                {p.member_count > 0 && <span className="tbank-cat-n">{p.member_count}</span>}
              </button>
            ))}
          </div>
        ))}
        {/* The page header carries this button; embedded there is no header. */}
        {embedded && (
          <button type="button" className="tbank-manage" onClick={() => setManaging(true)}>
            <Settings2 size={12} /> Manage categories
          </button>
        )}
      </section>

      {/* ── Search ───────────────────────────────────────────────────────── */}
      <section className="tbank-search">
        <div className="tbank-search-row">
          <div className="tbank-q">
            <Search size={15} className="tbank-q-icon" />
            <input
              className="tbank-q-input"
              value={f.q}
              onChange={(e) => set('q', e.target.value)}
              placeholder="Name, phone, email, candidate ID, employer, designation…"
              aria-label="Search the Talent Bank"
            />
            {f.q && <button type="button" className="tbank-q-clear" onClick={() => set('q', '')} aria-label="Clear"><X size={13} /></button>}
          </div>
          <button type="button" className={`tbank-more${showMore ? ' is-on' : ''}`} onClick={() => setShowMore(v => !v)}
            aria-expanded={showMore}>
            <SlidersHorizontal size={13} /> More filters{moreActive ? ` (${moreActive})` : ''}
          </button>
          {activeCount > 0 && (
            <button type="button" className="tbank-reset" onClick={reset}>Clear {activeCount} filter{activeCount === 1 ? '' : 's'}</button>
          )}
        </div>

        <div className="tbank-filters">
          <F label="Skills — all of them"><input className="tbank-in" value={f.skills} onChange={e => set('skills', e.target.value)} placeholder="AHF, STATCOM" /></F>
          <F label="Suited to department">
            <select className="tbank-sel" value={f.dept} onChange={e => set('dept', e.target.value)}>
              <option value="all">Any department</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </F>
          <F label="Experience">
            <select className="tbank-sel" value={f.exp} onChange={e => set('exp', e.target.value)}>
              {EXPERIENCE_BANDS.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
          </F>
          <F label="State"><input className="tbank-in" value={f.state} onChange={e => set('state', e.target.value)} placeholder="Tamil Nadu" /></F>
          <F label="Relocation">
            <select className="tbank-sel" value={f.relocate} onChange={e => set('relocate', e.target.value)}>
              <option value="all">Any answer</option>
              <option value="true">Can be at the site</option>
              <option value="already_local">Already lives nearby</option>
              <option value="willing">Can relocate</option>
              <option value="willing_with_support">Can relocate, with support</option>
              <option value="needs_information">Needs more information</option>
              <option value="not_currently">Not currently</option>
              <option value="no">No</option>
            </select>
          </F>
        </div>

        {showMore && (
          <div className="tbank-filters tbank-filters--more">
            <F label="City"><input className="tbank-in" value={f.city} onChange={e => set('city', e.target.value)} placeholder="Madurai" /></F>
            <F label="Qualification">
              <select className="tbank-sel" value={f.qual} onChange={e => set('qual', e.target.value)}>
                <option value="all">Any</option>
                {QUALIFICATIONS.map(q => <option key={q} value={q}>{q}</option>)}
              </select>
            </F>
            <F label="Specialisation"><input className="tbank-in" value={f.spec} onChange={e => set('spec', e.target.value)} placeholder="Electrical" /></F>
            <F label="Current company"><input className="tbank-in" value={f.company} onChange={e => set('company', e.target.value)} placeholder="Acme Power" /></F>
            <F label="Current role"><input className="tbank-in" value={f.role} onChange={e => set('role', e.target.value)} placeholder="Test Engineer" /></F>
            <F label="Notice period">
              <select className="tbank-sel" value={f.notice} onChange={e => set('notice', e.target.value)}>
                <option value="all">Any</option>
                <option value="15">Within 15 days</option>
                <option value="30">Within 30 days</option>
                <option value="60">Within 60 days</option>
                <option value="90">Within 90 days</option>
              </select>
            </F>
            <F label="Expected CTC up to (₹/yr)"><input className="tbank-in" inputMode="numeric" value={f.ctc} onChange={e => set('ctc', e.target.value.replace(/[^\d]/g, ''))} placeholder="800000" /></F>
            <F label="Previous screening score">
              <select className="tbank-sel" value={f.score} onChange={e => set('score', e.target.value)}>
                <option value="all">Any</option>
                <option value="50">50+</option>
                <option value="60">60+</option>
                <option value="70">70+</option>
                <option value="80">80+</option>
              </select>
            </F>
            <F label="Applied before">
              <select className="tbank-sel" value={f.prev} onChange={e => set('prev', e.target.value)}>
                <option value="all">Either</option>
                <option value="yes">Has applied to us before</option>
              </select>
            </F>
            <F label="Status">
              <select className="tbank-sel" value={f.disp} onChange={e => set('disp', e.target.value)}>
                <option value="all">Any</option>
                <option value="talent_bank">Talent Bank</option>
                <option value="future_opportunity">Future Opportunity</option>
                <option value="active">Back in hiring</option>
              </select>
            </F>
            <F label="Classification">
              <select className="tbank-sel" value={f.cls} onChange={e => set('cls', e.target.value)}>
                <option value="all">Any</option>
                {Object.entries(CLASSIFICATION_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </F>
            <F label="Résumé content"><input className="tbank-in" value={f.rtext} onChange={e => set('rtext', e.target.value)} placeholder="inverter troubleshooting" /></F>
          </div>
        )}
      </section>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      <div className="tbank-count">
        {loading ? 'Searching…'
          : activeCount > 0 ? `${total} of ${bankSize} in the Talent Bank match`
          : `${total} candidate${total === 1 ? '' : 's'} in the Talent Bank`}
        {!loading && rows.length < total && <span className="tbank-count-dim"> · showing the {rows.length} most recently active</span>}
      </div>

      {loadError && !loading && (
        <div className="tbank-error" role="alert">
          {loadError} <button type="button" className="tbank-reset" onClick={search}>Try again</button>
        </div>
      )}

      <div className="tbank-results">
        {rows.map(c => {
          const poolList = Array.isArray(c.pool_list) ? c.pool_list
            : (Array.isArray(c.pools) ? c.pools.map(n => ({ id: null, name: n })) : []);
          const tags = Array.isArray(c.bank_tags) ? c.bank_tags : [];
          return (
            <article key={c.id} className="tbank-card">
              <header className="tbank-card-head">
                <button type="button" className="tbank-link tbank-link--lg" onClick={() => open(c.id)}>
                  {c.full_name}
                </button>
                <span className="tbank-chip" style={dispositionColor(c.disposition)}>
                  {c.disposition === 'active' ? 'Back in hiring' : dispositionLabel(c.disposition)}
                </span>
              </header>

              <p className="tbank-card-role">
                {[c.current_designation, c.current_company].filter(Boolean).join(' · ') || 'Role not recorded'}
              </p>

              <div className="tbank-card-facts">
                <span>{c.experience_years != null ? `${Number(c.experience_years)} yrs` : 'exp —'}</span>
                <span>{[c.current_city, c.current_state].filter(Boolean).join(', ') || c.location || 'location —'}</span>
                <span>{[c.qualification, c.specialisation].filter(Boolean).join(' ') || 'education —'}</span>
                {c.notice_period_days != null && <span>{c.notice_period_days}d notice</span>}
                {c.expected_ctc != null && <span>₹{Number(c.expected_ctc).toLocaleString('en-IN')}/yr</span>}
              </div>

              <div className="tbank-card-chips">
                {c.willing_to_relocate && c.willing_to_relocate !== 'unknown' && (
                  <span className="tbank-chip tbank-chip--xs" style={relocationColor(c.willing_to_relocate)}>
                    {relocationLabel(c.willing_to_relocate)}
                  </span>
                )}
                {c.best_screening_score != null && (
                  <span className="tbank-chip tbank-chip--xs tbank-chip--score">Screened {Number(c.best_screening_score)}/100</span>
                )}
                {c.application_count > 0 && (
                  <span className="tbank-chip tbank-chip--xs tbank-chip--dim">
                    {c.application_count} application{c.application_count === 1 ? '' : 's'}
                  </span>
                )}
                {c.recontact_on && (
                  <span className="tbank-chip tbank-chip--xs tbank-chip--due" title="Recontact date">
                    <CalendarClock size={10} /> {fmtDate(c.recontact_on)}
                  </span>
                )}
              </div>

              {poolList.length > 0 && (
                <div className="tbank-card-pools">
                  {poolList.map(p => (
                    <span key={p.id ?? p.name} className="tbank-chip tbank-chip--xs tbank-chip--pool">
                      {p.name}
                      {p.id && (
                        <button type="button" className="tbank-chip-x" aria-label={`Remove from ${p.name}`}
                          title={`Remove from ${p.name}`}
                          onClick={() => setRemoving({ candidate: c, poolId: p.id, poolName: p.name })}>
                          <X size={9} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {tags.length > 0 && (
                <p className="tbank-card-suited">Tags: {tags.join(', ')}</p>
              )}
              {Array.isArray(c.suitable_departments) && c.suitable_departments.length > 0 && (
                <p className="tbank-card-suited">
                  <Users2 size={11} /> Suited to {c.suitable_departments.join(', ')}
                </p>
              )}

              <footer className="tbank-card-foot">
                <span className="tbank-chip tbank-chip--xs" style={stageColor(c.current_stage)}>
                  {stageLabelShort(c.current_stage)}
                </span>
                <div className="tbank-card-acts">
                  <button type="button" className="tbank-mini tbank-mini--go" onClick={() => setPutForward(c)}
                    title="Add them to an open job">
                    <Shuffle size={12} /> Put forward
                  </button>
                  <button type="button" className="tbank-mini tbank-mini--icon" onClick={() => setRemoving({ candidate: c })}
                    title="Remove from the Talent Bank" aria-label={`Remove ${c.full_name} from the Talent Bank`}>
                    <Trash2 size={12} />
                  </button>
                  <button type="button" className="tbank-open" onClick={() => open(c.id)}>
                    Profile <ChevronRight size={13} />
                  </button>
                </div>
              </footer>
            </article>
          );
        })}
      </div>

      {!loading && !loadError && rows.length === 0 && (
        <div className="tbank-empty">
          <Archive size={38} strokeWidth={1.4} />
          <p className="tbank-empty-title">
            {activeCount > 0 ? 'No one in the Talent Bank matches this search' : 'The Talent Bank is empty'}
          </p>
          <p className="tbank-empty-sub">
            {activeCount > 0
              ? `Try widening the experience band or clearing the location filters.${f.pool !== 'all' ? ` No one is kept under ${poolName(f.pool) || 'this category'} with these filters.` : ''}`
              : 'Candidates arrive here when a recruiter keeps them — the "Talent Bank" or "Future Opportunity" outcome in Screening, or "To Talent Bank" on the Candidates list or a candidate profile. Nothing is ever deleted to get here.'}
          </p>
          {activeCount > 0
            ? <button type="button" className="tbank-btn" onClick={reset}>Clear filters</button>
            : <button type="button" className="tbank-btn" onClick={() => setPage?.('Candidates')}>Go to Candidates</button>}
        </div>
      )}

      {putForward && (
        <PutForwardDialog candidate={putForward} onClose={() => setPutForward(null)} onSaved={refreshAll} />
      )}
      {removing && (
        <RemoveFromBankDialog candidate={removing.candidate} poolId={removing.poolId} poolName={removing.poolName}
          onClose={() => setRemoving(null)} onSaved={refreshAll} />
      )}
      {remindLater && (
        <FutureOpportunityDialog
          candidate={{ id: remindLater.candidate_id, full_name: remindLater.full_name }}
          departments={departments}
          onClose={() => setRemindLater(null)}
          onSaved={afterRemindLater}
        />
      )}
      {managing && (
        <ManageCategoriesDialog departments={departments} onClose={() => setManaging(false)}
          onChanged={() => { loadPools(); search(); }} />
      )}
    </div>
  );

  if (embedded) return body;

  return (
    <PageShell dock={
      <PageHero
        icon={Archive}
        eyebrow="Recruitment"
        title="Talent Bank"
        subtitle="Good candidates we have met and kept. Search here first when a role opens."
        meta={[
          { label: 'in the bank', value: bankSize },
          { label: 'due for recontact', value: due.length, tone: due.length ? 'warn' : undefined },
          { label: 'categories', value: pools.length },
        ]}
        actions={<button type="button" className="plh-cta" onClick={() => setManaging(true)}>
          <Settings2 size={15} /> Manage categories
        </button>}
      />
    }>
      {body}
    </PageShell>
  );
}

function F({ label, children }) {
  return (
    <label className="tbank-field">
      <span className="tbank-field-label">{label}</span>
      {children}
    </label>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Manage categories — replaces the old Talent Pools page.
 * ═══════════════════════════════════════════════════════════════════════════ */
const EMPTY_CAT = { pool_name: '', category: 'engineering', department: '', description: '', is_active: true };

function ManageCategoriesDialog({ departments = [], onClose, onChanged }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);
  const [list, setList] = useState(null);
  const [editing, setEditing] = useState(null);   // null | 'new' | pool row
  const [form, setForm] = useState(EMPTY_CAT);
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);

  const load = useCallback(() => api.get('/talent/pools')
    .then(r => setList(r.data?.data ?? []))
    .catch((e) => { setList([]); toast(e?.response?.data?.error || 'Could not load categories', 'error'); }), [toast]);
  useEffect(() => { load(); }, [load]);

  const startNew = () => { setEditing('new'); setForm(EMPTY_CAT); };
  const startEdit = (p) => {
    setEditing(p);
    setForm({
      pool_name: p.pool_name || '', category: p.category || 'other', department: p.department || '',
      description: p.description || '', is_active: p.is_active !== false,
    });
  };

  const save = async () => {
    if (!form.pool_name.trim()) return toast('Give the category a name.', 'error');
    setSaving(true);
    try {
      if (editing === 'new') {
        await api.post('/talent/pools', { ...form, pool_name: form.pool_name.trim() });
        toast(`Category "${form.pool_name.trim()}" added`);
      } else {
        await api.put(`/talent/pools/${editing.id}`, { ...form, pool_name: form.pool_name.trim() });
        toast(`Category "${form.pool_name.trim()}" saved`);
      }
      setEditing(null);
      await load();
      onChanged?.();
    } catch (e) {
      toast(e?.response?.data?.error || 'Could not save the category', 'error');
    } finally { setSaving(false); }
  };

  const toggleActive = async (p) => {
    try {
      await api.put(`/talent/pools/${p.id}`, { is_active: !p.is_active });
      toast(p.is_active ? `"${p.pool_name}" switched off — hidden from the Talent Bank` : `"${p.pool_name}" switched on`);
      await load();
      onChanged?.();
    } catch (e) { toast(e?.response?.data?.error || 'Could not update', 'error'); }
  };

  const doDelete = async (p) => {
    setConfirmDel(null);
    try {
      const res = await api.delete(`/talent/pools/${p.id}`);
      toast(res?.data?.message || 'Category deleted');
      await load();
      onChanged?.();
    } catch (e) { toast(e?.response?.data?.error || 'Could not delete', 'error'); }
  };

  const grouped = useMemo(() => groupPools(list || []), [list]);

  return (
    <Modal
      wide
      title="Talent Bank categories"
      subtitle="The groups candidates are kept under. Switching one off hides it from the Talent Bank without losing anyone in it."
      icon={Settings2}
      tone="keep"
      onClose={onClose}
      footer={editing ? (
        <>
          <button type="button" className="cad-btn" onClick={() => setEditing(null)}>Back</button>
          <button type="button" className="cad-btn cad-btn--keep" onClick={save} disabled={saving || !form.pool_name.trim()}>
            {saving ? 'Saving…' : (editing === 'new' ? 'Add category' : 'Save')}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="cad-btn" onClick={onClose}>Close</button>
          <button type="button" className="cad-btn cad-btn--keep" onClick={startNew}><Plus size={13} /> New category</button>
        </>
      )}
    >
      {editing ? (
        <div className="cad-grid2">
          <div>
            <label className="cad-label" htmlFor="tbc-name">Name <span className="cad-req">required</span></label>
            <input id="tbc-name" className="cad-input" value={form.pool_name} autoFocus
              onChange={(e) => setForm(v => ({ ...v, pool_name: e.target.value }))} placeholder="Battery Systems" />
          </div>
          <div>
            <label className="cad-label" htmlFor="tbc-group">Group</label>
            <select id="tbc-group" className="cad-select" value={form.category}
              onChange={(e) => setForm(v => ({ ...v, category: e.target.value }))}>
              {CATEGORY_GROUPS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </div>
          <div>
            <label className="cad-label" htmlFor="tbc-dept">Department <span className="cad-optional">optional</span></label>
            <select id="tbc-dept" className="cad-select" value={form.department}
              onChange={(e) => setForm(v => ({ ...v, department: e.target.value }))}>
              <option value="">—</option>
              {[...new Set([...departments, form.department].filter(Boolean))].map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="cad-label" htmlFor="tbc-active">Shown in the Talent Bank</label>
            <select id="tbc-active" className="cad-select" value={form.is_active ? 'yes' : 'no'}
              onChange={(e) => setForm(v => ({ ...v, is_active: e.target.value === 'yes' }))}>
              <option value="yes">Yes</option>
              <option value="no">No — switched off</option>
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="cad-label" htmlFor="tbc-desc">Description <span className="cad-optional">optional</span></label>
            <textarea id="tbc-desc" className="cad-textarea" rows={2} value={form.description}
              onChange={(e) => setForm(v => ({ ...v, description: e.target.value }))}
              placeholder="Who belongs here, so other recruiters pick it consistently." />
          </div>
        </div>
      ) : list === null ? (
        <p className="cad-empty">Loading…</p>
      ) : list.length === 0 ? (
        <p className="cad-empty">No categories yet.</p>
      ) : (
        <div className="tbc-list">
          {grouped.map(([cat, items]) => (
            <div key={cat} className="tbc-group">
              <h4 className="cad-pool-cat">{GROUP_LABEL[cat] || cat}</h4>
              {items.map(p => (
                <div key={p.id} className={`tbc-row${p.is_active ? '' : ' is-off'}`}>
                  <div className="tbc-main">
                    <span className="tbc-name">{p.pool_name}</span>
                    <span className="tbc-sub">
                      {p.member_count} candidate{p.member_count === 1 ? '' : 's'}
                      {p.department ? ` · ${p.department}` : ''}
                      {p.is_seeded ? ' · standard' : ''}
                      {!p.is_active ? ' · switched off' : ''}
                    </span>
                  </div>
                  {confirmDel === p.id ? (
                    <div className="tbc-acts">
                      <span className="tbc-sub">{p.is_seeded ? 'Switch off this standard category?' : 'Delete this category?'}</span>
                      <button type="button" className="tbank-mini tbank-mini--stop" onClick={() => doDelete(p)}>Yes</button>
                      <button type="button" className="tbank-mini" onClick={() => setConfirmDel(null)}>No</button>
                    </div>
                  ) : (
                    <div className="tbc-acts">
                      <button type="button" className="tbank-mini" onClick={() => toggleActive(p)}>
                        {p.is_active ? 'Switch off' : 'Switch on'}
                      </button>
                      <button type="button" className="tbank-mini tbank-mini--icon" onClick={() => startEdit(p)}
                        aria-label={`Edit ${p.pool_name}`} title="Edit"><Pencil size={12} /></button>
                      <button type="button" className="tbank-mini tbank-mini--icon"
                        disabled={p.member_count > 0}
                        title={p.member_count > 0 ? 'Candidates are kept under it — remove them first, or switch it off' : (p.is_seeded ? 'Standard category — it will be switched off' : 'Delete')}
                        aria-label={`Delete ${p.pool_name}`}
                        onClick={() => setConfirmDel(p.id)}><Trash2 size={12} /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
