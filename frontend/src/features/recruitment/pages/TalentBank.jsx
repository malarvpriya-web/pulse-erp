import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Archive, Search, X, CalendarClock, Users2, ChevronRight, RotateCcw, Check,
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
import './talent-bank.css';

/**
 * TalentBank — §17's long-term repository and §19's search over it.
 *
 * ── WHY THIS IS A SEPARATE SCREEN FROM THE CANDIDATE LIST ───────────────────
 * They answer different questions. The candidate list answers "who is in play for
 * the roles we are hiring for now"; the Talent Bank answers "who have we met who
 * would suit a role we are about to open". §41 is the reason both exist:
 * recruitment as "build Manifest's long-term talent ecosystem" rather than "fill
 * today's vacancy".
 *
 * So the filters here are the ones you use when you have a NEW opening and want
 * to know who you already know — §19's worked example, "Power electronics + 2-5
 * years + Tamil Nadu + willing to relocate", is four controls on this page and
 * one request.
 *
 * ── WHAT COUNTS AS "IN THE BANK" ───────────────────────────────────────────
 * Either an explicit disposition (talent_bank / future_opportunity) OR membership
 * of any pool. Both, because a recruiter who adds someone to the Power Electronics
 * pool has banked them whatever the disposition column says, and a candidate
 * dispositioned to the bank is banked before anybody picked a category.
 */

const EXPERIENCE_BANDS = [
  { value: 'all',  label: 'Any experience', min: undefined, max: undefined },
  { value: '0-2',  label: '0-2 years',  min: 0,  max: 2 },
  { value: '2-5',  label: '2-5 years',  min: 2,  max: 5 },
  { value: '5-10', label: '5-10 years', min: 5,  max: 10 },
  { value: '10',   label: '10+ years',  min: 10, max: undefined },
];

const QUALIFICATIONS = ['Diploma', 'BE/BTech', 'ME/MTech', 'MBA', 'MCA', 'BCA', 'BSc', 'MSc', 'BCom', 'PhD', 'Other'];

const PARAMS = {
  q: 'q', pool: 'pool', dept: 'dept', exp: 'exp', state: 'state', city: 'city',
  relocate: 'relo', qual: 'qual', spec: 'spec', company: 'co', role: 'role',
  notice: 'notice', ctc: 'ctc', score: 'score', tags: 'tags', rtext: 'rtext',
  prev: 'prev', disp: 'disp', cls: 'cls',
};

const DEFAULTS = {
  q: '', pool: 'all', dept: 'all', exp: 'all', state: '', city: '',
  relocate: 'all', qual: 'all', spec: '', company: '', role: '',
  notice: 'all', ctc: '', score: 'all', tags: '', rtext: '',
  prev: 'all', disp: 'all', cls: 'all',
};

export default function TalentBank({ setPage, embedded = false }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);

  const [sp, setSp] = useSearchParams();

  // Same URL-as-store approach as the candidate workbench, and for the same
  // reason: a Talent Bank search is a piece of work worth keeping — often worth
  // sending to a colleague as a link — and losing it on every profile visit makes
  // the screen useless for the job it exists to do.
  const f = useMemo(() => {
    const out = { ...DEFAULTS };
    for (const [k, p] of Object.entries(PARAMS)) {
      const v = sp.get(p);
      if (v !== null && v !== '') out[k] = v;
    }
    return out;
  }, [sp]);

  const set = useCallback((key, value) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      const p = PARAMS[key];
      if (!p) return next;
      if (value === '' || value === null || value === undefined || value === DEFAULTS[key]) next.delete(p);
      else next.set(p, String(value));
      return next;
    }, { replace: true });
  }, [setSp]);

  const reset = useCallback(() => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const p of Object.values(PARAMS)) next.delete(p);
      return next;
    }, { replace: true });
  }, [setSp]);

  const activeCount = useMemo(
    () => Object.keys(DEFAULTS).filter(k => f[k] !== DEFAULTS[k]).length,
    [f]
  );

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [pools, setPools] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [due, setDue] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.get('/recruitment/talent-bank/pools'),
      api.get('/recruitment/meta/candidate-workbench'),
      api.get('/recruitment/recontacts', { params: { due_only: true, limit: 25 } }),
    ]).then(([p, m, r]) => {
      if (p.status === 'fulfilled') setPools(Array.isArray(p.value.data) ? p.value.data : []);
      if (m.status === 'fulfilled') setDepartments(m.value.data?.departments || []);
      if (r.status === 'fulfilled') setDue(Array.isArray(r.value.data) ? r.value.data : []);
    });
  }, []);

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
    if (f.tags.trim())    p.set('tags', f.tags.trim());
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
    } catch (e) {
      setRows([]); setTotal(0);
      if (e?.code !== 'ERR_CANCELED') toast(e?.response?.data?.error || 'Search failed', 'error');
    } finally { setLoading(false); }
  }, [query, toast]);

  useEffect(() => {
    const t = setTimeout(search, 280);
    return () => clearTimeout(t);
  }, [search]);

  const open = (id) => { setSelectedCandidateId(id); setPage?.('CandidateDetail'); };

  const completeRecontact = async (rc, reengage) => {
    try {
      await api.post(`/recruitment/recontacts/${rc.id}/complete`, { status: 'done', reengage });
      toast(reengage ? `${rc.full_name} back in active consideration` : 'Marked as recontacted');
      setDue(d => d.filter(x => x.id !== rc.id));
      search();
    } catch (e) { toast(e?.response?.data?.error || 'Could not update', 'error'); }
  };

  const groupedPools = useMemo(() => {
    const map = new Map();
    for (const p of pools) {
      const k = p.category || 'other';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    const ORDER = ['engineering', 'product', 'operations', 'commercial', 'corporate', 'pipeline', 'other'];
    return [...map.entries()].sort((a, b) =>
      (ORDER.indexOf(a[0]) === -1 ? 99 : ORDER.indexOf(a[0])) - (ORDER.indexOf(b[0]) === -1 ? 99 : ORDER.indexOf(b[0]))
    );
  }, [pools]);

  const CATEGORY_LABELS = {
    engineering: 'Engineering', product: 'Product / Technology', operations: 'Operations',
    commercial: 'Commercial', corporate: 'Corporate', pipeline: 'Pipeline', other: 'Other',
  };

  const body = (
    <div className="tbank">
      {/* ── §18's reminders, at the top because they are the one thing on this
             page with a deadline. ─────────────────────────────────────────── */}
      {due.length > 0 && (
        <section className="tbank-due">
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
                  <button type="button" className="tbank-mini tbank-mini--go" onClick={() => completeRecontact(rc, true)}>
                    <RotateCcw size={12} /> Bring back
                  </button>
                  <button type="button" className="tbank-mini" onClick={() => completeRecontact(rc, false)}>
                    <Check size={12} /> Contacted
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Category chips (§17) ─────────────────────────────────────────── */}
      <section className="tbank-cats">
        <button
          type="button"
          className={`tbank-cat${f.pool === 'all' ? ' is-on' : ''}`}
          onClick={() => set('pool', 'all')}
        >
          Everyone <span className="tbank-cat-n">{total}</span>
        </button>
        {groupedPools.map(([cat, list]) => (
          <div key={cat} className="tbank-cat-group">
            <span className="tbank-cat-label">{CATEGORY_LABELS[cat] || cat}</span>
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
      </section>

      {/* ── §19's search ─────────────────────────────────────────────────── */}
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
          {activeCount > 0 && (
            <button type="button" className="tbank-reset" onClick={reset}>Clear {activeCount} filter{activeCount === 1 ? '' : 's'}</button>
          )}
        </div>

        <div className="tbank-filters">
          <F label="Skills — all of them"><input className="tbank-in" value={f.tags} onChange={e => set('tags', e.target.value)} placeholder="AHF, STATCOM" /></F>
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
          <F label="City"><input className="tbank-in" value={f.city} onChange={e => set('city', e.target.value)} placeholder="Madurai" /></F>
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
          <F label="Qualification">
            <select className="tbank-sel" value={f.qual} onChange={e => set('qual', e.target.value)}>
              <option value="all">Any</option>
              {QUALIFICATIONS.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </F>
          <F label="Specialisation"><input className="tbank-in" value={f.spec} onChange={e => set('spec', e.target.value)} placeholder="Electrical" /></F>
          <F label="Previous company"><input className="tbank-in" value={f.company} onChange={e => set('company', e.target.value)} placeholder="Acme Power" /></F>
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
          <F label="Expected CTC up to"><input className="tbank-in" value={f.ctc} onChange={e => set('ctc', e.target.value)} placeholder="800000" /></F>
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
              <option value="active">Active</option>
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
      </section>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      <div className="tbank-count">
        {loading ? 'Searching…' : `${total} candidate${total === 1 ? '' : 's'} in the Talent Bank`}
        {!loading && rows.length < total && <span className="tbank-count-dim"> · showing {rows.length}</span>}
      </div>

      <div className="tbank-results">
        {rows.map(c => (
          <article key={c.id} className="tbank-card">
            <header className="tbank-card-head">
              <button type="button" className="tbank-link tbank-link--lg" onClick={() => open(c.id)}>
                {c.full_name}
              </button>
              <span className="tbank-chip" style={dispositionColor(c.disposition)}>
                {dispositionLabel(c.disposition)}
              </span>
            </header>

            <p className="tbank-card-role">
              {[c.current_designation, c.current_company].filter(Boolean).join(' · ') || 'Role not recorded'}
            </p>

            <div className="tbank-card-facts">
              <span>{c.experience_years != null ? `${c.experience_years} yrs` : 'exp —'}</span>
              <span>{[c.current_city, c.current_state].filter(Boolean).join(', ') || c.location || 'location —'}</span>
              <span>{[c.qualification, c.specialisation].filter(Boolean).join(' ') || 'education —'}</span>
              {c.notice_period_days != null && <span>{c.notice_period_days}d notice</span>}
              {c.expected_ctc != null && <span>{Number(c.expected_ctc).toLocaleString('en-IN')}</span>}
            </div>

            <div className="tbank-card-chips">
              {c.willing_to_relocate && c.willing_to_relocate !== 'unknown' && (
                <span className="tbank-chip tbank-chip--xs" style={relocationColor(c.willing_to_relocate)}>
                  {relocationLabel(c.willing_to_relocate)}
                </span>
              )}
              {c.best_screening_score != null && (
                <span className="tbank-chip tbank-chip--xs tbank-chip--score">Screened {c.best_screening_score}/100</span>
              )}
              {c.application_count > 0 && (
                <span className="tbank-chip tbank-chip--xs tbank-chip--dim">
                  {c.application_count} previous application{c.application_count === 1 ? '' : 's'}
                </span>
              )}
              {c.recontact_on && (
                <span className="tbank-chip tbank-chip--xs tbank-chip--due">
                  <CalendarClock size={10} /> {fmtDate(c.recontact_on)}
                </span>
              )}
            </div>

            {/* Which categories they are banked under, and which departments they
                were judged suitable for — the two things you want when you have a
                new opening and are looking for someone you already know. */}
            {Array.isArray(c.pools) && c.pools.length > 0 && (
              <div className="tbank-card-pools">
                {c.pools.map(p => <span key={p} className="tbank-chip tbank-chip--xs tbank-chip--pool">{p}</span>)}
              </div>
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
              <button type="button" className="tbank-open" onClick={() => open(c.id)}>
                Open profile <ChevronRight size={13} />
              </button>
            </footer>
          </article>
        ))}
      </div>

      {!loading && rows.length === 0 && (
        <div className="tbank-empty">
          <Archive size={38} strokeWidth={1.4} />
          <p className="tbank-empty-title">
            {activeCount > 0 ? 'No banked candidates match this search' : 'The Talent Bank is empty'}
          </p>
          <p className="tbank-empty-sub">
            {activeCount > 0
              ? 'Try widening the experience band or clearing the location filters.'
              : 'Candidates arrive here when a recruiter keeps them — from a screening outcome, the candidate list, or a candidate profile. Nothing is ever deleted to get here.'}
          </p>
          {activeCount > 0 && <button type="button" className="tbank-btn" onClick={reset}>Clear filters</button>}
        </div>
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
        subtitle="Everyone Manifest has met and decided to keep. Search it when a role opens, not when one closes."
        meta={[
          { label: 'in the bank', value: total },
          { label: 'due for recontact', value: due.length, tone: due.length ? 'warn' : undefined },
          { label: 'categories', value: pools.length },
        ]}
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
