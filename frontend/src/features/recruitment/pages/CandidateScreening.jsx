import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ClipboardCheck, ChevronLeft, Save, Check, AlertTriangle, Info,
} from 'lucide-react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import { useToast } from '@/context/ToastContext';
import { PageHero, PageShell } from '@/components/pulse-ui';
import ResumeViewer from '../shared/components/ResumeViewer';
import {
  ConsiderOtherRolesDialog, TalentBankDialog, FutureOpportunityDialog,
} from '../shared/components/CandidateActionDialogs';
import {
  FIT_OPTIONS, NOTICE_FIT_OPTIONS, LOCATION_FIT_OPTIONS, SALARY_FIT_OPTIONS, fitColor,
  COMPETENCIES, JUDGEMENTS, RATING_SCALE, SCORE_SECTIONS,
  SCREENING_DECISIONS, DECISION_TONES, decisionLabel,
  relocationLabel,
} from '../shared/constants';
import './candidate-screening.css';

/**
 * CandidateScreening — §10 to §15's Stage-1 workspace.
 *
 * The brief is unusually specific about what this screen is FOR, and it is worth
 * quoting because it rules out the obvious design: "The purpose is NOT to conduct
 * a full interview." The one question it answers is "Should Manifest invest more
 * time in this candidate?"
 *
 * Which is why this is ONE screen, not a wizard. §42 forbids "a 10-page form", so
 * eligibility, the nine questions, seven competency ratings and the outcome all
 * live on a single scrolling page with the résumé beside them — because every one
 * of those judgements is made by reading the résumé, and a recruiter who has to
 * leave the form to see it will not make them.
 *
 * ── INCREMENTAL SAVE ────────────────────────────────────────────────────────
 * §31: "Screening should save incrementally where appropriate." Every field
 * change schedules a debounced PATCH, and the server recomputes the score and
 * returns it, so the scorecard on screen is always the score the server holds.
 * There is no separate "calculate" step to forget and no client-side copy of the
 * §14 weighting to drift from the server's.
 *
 * ── THE SCORE IS NOT A GATE ─────────────────────────────────────────────────
 * §14: "Do NOT make the system automatically reject candidates only because of a
 * numerical score. The score is decision support. The recruiter must be able to
 * override the recommendation with a reason." So all seven outcomes are always
 * enabled whatever the score says; the recommendation is shown as a suggestion;
 * and choosing against it asks for one line of reasoning, which the API requires
 * and stores.
 */

const AUTOSAVE_MS = 900;

export default function CandidateScreening({ setPage }) {
  const _toast = useToast();
  const toast = useCallback((m, t = 'success') => _toast({ message: m, type: t }), [_toast]);

  const candidateId = useAppStore(s => s.selectedCandidateId);
  const [sp] = useSearchParams();
  const applicationFromUrl = sp.get('application');

  const [candidate, setCandidate] = useState(null);
  const [applications, setApplications] = useState([]);
  const [applicationId, setApplicationId] = useState(
    applicationFromUrl ? parseInt(applicationFromUrl, 10) : null
  );
  const [questions, setQuestions] = useState([]);
  const [form, setForm] = useState({});
  const [answers, setAnswers] = useState({});
  const [score, setScore] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [breakdown, setBreakdown] = useState({});
  const [screeningId, setScreeningId] = useState(null);
  const [status, setStatus] = useState('draft');
  const [decision, setDecision] = useState(null);

  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState('idle');     // idle | saving | saved | error
  const [meta, setMeta] = useState({ departments: [], pools: [] });
  const [dialog, setDialog] = useState(null);
  const [outcome, setOutcome] = useState(null);           // the decision being confirmed
  const [overrideReason, setOverrideReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const saveTimer = useRef(null);
  // The generation guard: an autosave in flight when the next keystroke lands
  // would otherwise return a stale score and overwrite the fresher one.
  const saveGen = useRef(0);

  /**
   * The application being screened, as a REF as well as state.
   *
   * It was a `load` dependency, and `load` set it — so opening the page ran load
   * TWICE, and the second run called setForm() with the server's copy. A recruiter
   * who clicked a rating in the second or so before that landed had the click
   * silently discarded: the dot went on, the reload put the old value back, and the
   * debounced save then sent the old value. The score never moved and nothing said
   * why.
   *
   * Reading it from a ref keeps `load` stable, so it runs once per candidate and
   * again only when the recruiter deliberately switches application.
   */
  const appIdRef = useRef(applicationFromUrl ? parseInt(applicationFromUrl, 10) : null);

  /**
   * Has the recruiter typed or clicked something that is not yet saved?
   *
   * A second guard on the same problem, from the other end: whatever causes a
   * reload, it must never overwrite input the recruiter can see on screen. Cleared
   * once a save succeeds, because at that point the server's copy IS their input.
   */
  const dirtyRef = useRef(false);

  // ── Load ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!candidateId) { setLoading(false); return; }
    setLoading(true);
    const [candRes, appRes, scrRes, metaRes] = await Promise.allSettled([
      api.get(`/recruitment/candidates/${candidateId}`),
      api.get(`/recruitment/candidates/${candidateId}/applications`),
      api.get(`/recruitment/candidates/${candidateId}/screening`, {
        // The server resolves the primary application when none is named, so an
        // absent id is correct rather than a fallback.
        params: appIdRef.current ? { application_id: appIdRef.current } : {},
      }),
      api.get('/recruitment/meta/candidate-workbench'),
    ]);

    if (candRes.status === 'fulfilled') setCandidate(candRes.value.data);
    const apps = appRes.status === 'fulfilled' && Array.isArray(appRes.value.data) ? appRes.value.data : [];
    setApplications(apps);
    if (!appIdRef.current && apps.length) {
      // The primary application is the one the pipeline follows. Recorded in the
      // ref and mirrored into state for the picker — this does NOT re-run load().
      const primary = apps.find(a => a.is_primary)?.id ?? apps[0].id;
      appIdRef.current = primary;
      setApplicationId(primary);
    }
    if (metaRes.status === 'fulfilled') setMeta(metaRes.value.data || {});

    if (scrRes.status === 'fulfilled') {
      const { screening, questions: qs } = scrRes.value.data || {};
      setQuestions(Array.isArray(qs) ? qs : []);
      if (screening) {
        setScreeningId(screening.id);
        setStatus(screening.status);
        setDecision(screening.decision || null);
        setScore(screening.total_score);
        setRecommendation(screening.recommendation);
        setBreakdown(screening.score_breakdown || {});
        // The server tells us which application this screening is about, which is
        // authoritative — it resolves the primary one when the request omitted it.
        if (screening.application_id) {
          appIdRef.current = screening.application_id;
          setApplicationId(screening.application_id);
        }
        // Never overwrite unsaved input. A reload that lands while the recruiter is
        // part-way through a rating would otherwise throw their work away.
        if (!dirtyRef.current) {
          setForm(pickForm(screening));
          setAnswers(Object.fromEntries(
            (screening.responses || []).map(r => [r.question_id, {
              answer_text: r.answer_text || '', answer_choice: r.answer_choice || '',
            }])
          ));
        }
      }
    }
    setLoading(false);
  }, [candidateId]);

  useEffect(() => { load(); }, [load]);

  // ── Autosave ────────────────────────────────────────────────────────────
  const persist = useCallback(async (patch, { immediate = false } = {}) => {
    if (!candidateId) return;
    const mine = ++saveGen.current;
    setSaveState('saving');
    try {
      const res = await api.post(`/recruitment/candidates/${candidateId}/screening`, {
        ...patch,
        application_id: appIdRef.current || undefined,
      });
      if (mine !== saveGen.current && !immediate) return;   // a newer save is in flight
      const s = res.data;
      setScreeningId(s.id);
      setScore(s.total_score);
      setRecommendation(s.recommendation);
      setBreakdown(s.score_breakdown || {});
      // The server's copy now IS the recruiter's input, so a later reload may
      // safely replace the form again.
      dirtyRef.current = false;
      setSaveState('saved');
    } catch (e) {
      if (mine !== saveGen.current) return;
      setSaveState('error');
      toast(e?.response?.data?.error || 'Could not save the screening', 'error');
    }
  }, [candidateId, toast]);

  /**
   * Set a field and schedule the save.
   *
   * The whole form is sent, not just the changed field. The endpoint is an upsert
   * over a fixed column allowlist and COALESCEs absent fields, so a partial body
   * is safe — but sending the whole form means a save that lands after a lost
   * response still carries every value the recruiter has entered, rather than
   * re-applying one field to a stale row.
   */
  const setField = (key, value) => {
    dirtyRef.current = true;
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      clearTimeout(saveTimer.current);
      // An empty value means CLEAR, and that has to be said explicitly. The save
      // endpoint COALESCEs absent fields so a partial save stays partial, which
      // means '' and undefined both read as "unchanged" — so clicking the active
      // rating dot to un-rate a competency appeared to work and then silently
      // reverted on the next save. `clear` names the field to null.
      const empty = value === '' || value === null || value === undefined;
      saveTimer.current = setTimeout(
        () => persist(empty ? { ...next, clear: [key] } : next),
        AUTOSAVE_MS
      );
      return next;
    });
  };

  const setAnswer = (question, patch) => {
    dirtyRef.current = true;
    setAnswers((prev) => {
      const next = { ...prev, [question.id]: { ...(prev[question.id] || {}), ...patch } };
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => persist({
        ...form,
        responses: Object.entries(next).map(([qid, v]) => ({
          question_id: Number(qid),
          // `code` travels with the answer so the server can recognise Q9 and
          // write its choice onto candidates.willing_to_relocate — answering the
          // location question and setting the relocation field are one act.
          code: questions.find(q => q.id === Number(qid))?.code,
          ...v,
        })),
      }), AUTOSAVE_MS);
      return next;
    });
  };

  // A pending autosave must not be lost when the recruiter navigates away.
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const saveNow = async () => {
    clearTimeout(saveTimer.current);
    await persist({
      ...form,
      responses: Object.entries(answers).map(([qid, v]) => ({
        question_id: Number(qid),
        code: questions.find(q => q.id === Number(qid))?.code,
        ...v,
      })),
    }, { immediate: true });
    toast('Screening saved');
  };

  // ── Outcome (§15) ───────────────────────────────────────────────────────
  const assessedWeight = breakdown?._assessed_weight ?? 0;
  const overriding = Boolean(recommendation && outcome && recommendation !== outcome);

  const submitOutcome = async () => {
    if (!outcome) return;
    if (!screeningId) return toast('Save the screening first.', 'error');

    if (outcome === 'reject_from_manifest' && !rejectReason.trim()) {
      return toast('Rejecting a candidate from Manifest needs a reason.', 'error');
    }
    if (overriding && !overrideReason.trim()) {
      return toast('Please say why you are choosing something other than the recommendation.', 'error');
    }
    // These two decisions need extra input, so they hand off to their dialog
    // rather than being submitted half-complete. The dialog writes the suitability
    // or recontact row; the outcome is submitted after it returns.
    if (outcome === 'consider_other_roles') { setDialog('roles'); return; }
    if (outcome === 'future_opportunity')   { setDialog('future'); return; }

    await finalise({});
  };

  const finalise = async (extra) => {
    setSubmitting(true);
    try {
      clearTimeout(saveTimer.current);
      const res = await api.post(`/recruitment/screenings/${screeningId}/complete`, {
        decision: outcome,
        override_reason: overrideReason.trim() || null,
        reject_reason: rejectReason.trim() || null,
        summary_note: form.summary_note || null,
        ...extra,
      });
      setStatus('completed');
      setDecision(res.data?.decision || outcome);
      toast(`Recorded: ${decisionLabel(outcome)}`);
      setOutcome(null);
      load();
    } catch (e) {
      const d = e?.response?.data;
      if (d?.errors?.override_reason) toast(d.error, 'error');
      else toast(d?.error || 'Could not record the outcome', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const currentApp = applications.find(a => a.id === applicationId);

  if (!candidateId) {
    return (
      <PageShell dock={<PageHero icon={ClipboardCheck} eyebrow="Recruitment" title="Stage 1 Screening" />}>
        <div className="scr-blank">
          No candidate selected.
          <button type="button" className="scr-btn" onClick={() => setPage?.('Candidates')}>Back to candidates</button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell dock={
      <PageHero
        icon={ClipboardCheck}
        eyebrow="Recruitment · Stage 1"
        title={candidate?.full_name || 'Screening'}
        subtitle={
          currentApp
            ? `Screening for ${currentApp.job_title}${currentApp.department ? ` · ${currentApp.department}` : ''}`
            : 'Speculative screening — not tied to an opening'
        }
        meta={[
          { label: 'experience', value: candidate?.experience_years != null ? `${candidate.experience_years} yrs` : '—' },
          { label: 'location', value: [candidate?.current_city, candidate?.current_state].filter(Boolean).join(', ') || candidate?.location || '—' },
          { label: 'relocation', value: relocationLabel(candidate?.willing_to_relocate) },
        ]}
        actions={
          <>
            <button type="button" className="plh-cta" onClick={() => setPage?.('CandidateDetail')}>
              <ChevronLeft size={14} /> Full profile
            </button>
            <button type="button" className="plh-cta" onClick={saveNow}>
              <Save size={14} /> Save
            </button>
          </>
        }
      />
    }>
      {loading ? (
        <div className="scr-blank">Loading…</div>
      ) : (
        <div className="scr">
          {/* ── Left: the résumé, because every judgement below is made by
                 reading it (§5 + §10). ─────────────────────────────────── */}
          <div className="scr-left">
            <ResumeViewer candidate={candidate} minHeight={560} />

            {/* The scorecard sits under the résumé rather than in the form
                column: §14 asks for the breakdown to be shown, and it is a
                reference while filling the form in, not a field of it. */}
            <section className="scr-card scr-scorecard">
              <header className="scr-card-head">
                <h3>Stage 1 scorecard</h3>
                {/* No spec section numbers in recruiter-facing text. "§14" is meaningful
                    to whoever implemented this and to nobody using it. */}
                <span className="scr-hint">Weighted across 10 sections</span>
              </header>

              <div className="scr-score">
                <div className="scr-score-big">
                  {score ?? 0}<span>/100</span>
                </div>
                <div className="scr-score-side">
                  {/* Saying how much of the 100 has actually been assessed is what
                      stops a half-finished screening reading as a low score. */}
                  <p className="scr-score-assessed">
                    {assessedWeight
                      ? `${assessedWeight} of 100 points assessed`
                      : 'Nothing assessed yet'}
                  </p>
                  {recommendation && (
                    <p className="scr-rec">
                      <Info size={12} />
                      Suggests <strong>{decisionLabel(recommendation)}</strong>
                      <span className="scr-rec-note">— decision support only; you decide</span>
                    </p>
                  )}
                </div>
              </div>

              <ul className="scr-breakdown">
                {SCORE_SECTIONS.map(({ key, label, weight }) => {
                  const b = breakdown?.[key];
                  const scored = b?.scored;
                  const assessed = b?.assessed;
                  return (
                    <li key={key} className={assessed ? '' : 'is-unassessed'}>
                      <span className="scr-bd-label">{label}</span>
                      <span className="scr-bd-bar" aria-hidden>
                        <i style={{ width: `${assessed ? (scored / weight) * 100 : 0}%` }} />
                      </span>
                      <span className="scr-bd-num">
                        {assessed ? `${scored}/${weight}` : `—/${weight}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>

          {/* ── Right: the form ─────────────────────────────────────────── */}
          <div className="scr-right">
            <div className="scr-savebar">
              {applications.length > 1 && (
                <select
                  className="scr-sel"
                  value={applicationId || ''}
                  onChange={(e) => {
                    const id = parseInt(e.target.value, 10);
                    appIdRef.current = id;
                    setApplicationId(id);
                    // A deliberate switch to another application IS a reload — it is
                    // a different screening. Any unsaved input belonged to the one
                    // being left, so the guard is dropped first.
                    dirtyRef.current = false;
                    load();
                  }}
                  aria-label="Which application is this screening for"
                >
                  {applications.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.job_title}{a.is_primary ? ' (original)' : ''}
                    </option>
                  ))}
                </select>
              )}
              <span className={`scr-save scr-save--${saveState}`}>
                {saveState === 'saving' ? 'Saving…'
                  : saveState === 'saved' ? 'Saved'
                  : saveState === 'error' ? 'Not saved'
                  : 'Changes save automatically'}
              </span>
              {status === 'completed' && (
                <span className="scr-done">
                  <Check size={12} /> Completed — {decisionLabel(decision)}
                </span>
              )}
            </div>

            {/* ── §11 Eligibility ──────────────────────────────────────── */}
            <section className="scr-card">
              <header className="scr-card-head">
                <h3>A · Eligibility</h3>
                <span className="scr-hint">Worth 10 of the 100 points</span>
              </header>
              <div className="scr-fits">
                <FitRow label="Qualification" value={form.qualification_fit} options={FIT_OPTIONS}
                        onChange={(v) => setField('qualification_fit', v)} />
                <FitRow label="Experience" value={form.experience_fit} options={FIT_OPTIONS}
                        onChange={(v) => setField('experience_fit', v)} />
                <FitRow label="Relevant skills" value={form.skills_fit} options={FIT_OPTIONS}
                        onChange={(v) => setField('skills_fit', v)} />
                <FitRow label="Notice period" value={form.notice_fit} options={NOTICE_FIT_OPTIONS}
                        onChange={(v) => setField('notice_fit', v)}
                        hint={candidate?.notice_period_days != null ? `${candidate.notice_period_days} days on file` : 'not recorded'} />
                <FitRow label="Location" value={form.location_fit} options={LOCATION_FIT_OPTIONS}
                        onChange={(v) => setField('location_fit', v)}
                        hint="Scores the Location / Role Alignment section (5 pts)" />
                <FitRow label="Salary" value={form.salary_fit} options={SALARY_FIT_OPTIONS}
                        onChange={(v) => setField('salary_fit', v)}
                        hint={candidate?.expected_ctc != null ? `expects ${Number(candidate.expected_ctc).toLocaleString('en-IN')}` : 'not recorded'} />
              </div>
            </section>

            {/* ── §13 Questions ────────────────────────────────────────── */}
            <section className="scr-card">
              <header className="scr-card-head">
                <h3>B · Screening questions</h3>
                <span className="scr-hint">Evidence for the ratings below — none is mandatory</span>
              </header>
              {questions.length === 0 && <p className="scr-muted">No screening questions configured.</p>}
              {questions.map((q) => (
                <div key={q.id} className="scr-q">
                  <p className="scr-q-prompt">
                    <span className="scr-q-code">{q.code}</span>
                    {q.prompt}
                  </p>
                  {q.answer_type === 'single_choice' ? (
                    <div className="scr-q-choices">
                      {(q.options || []).map(o => (
                        <label key={o.value} className={`scr-choice${answers[q.id]?.answer_choice === o.value ? ' is-on' : ''}`}>
                          <input
                            type="radio"
                            name={`q-${q.id}`}
                            value={o.value}
                            checked={answers[q.id]?.answer_choice === o.value}
                            onChange={() => setAnswer(q, { answer_choice: o.value })}
                          />
                          {o.label}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <textarea
                      className="scr-textarea"
                      rows={2}
                      value={answers[q.id]?.answer_text || ''}
                      onChange={(e) => setAnswer(q, { answer_text: e.target.value })}
                      placeholder="What did they actually say?"
                    />
                  )}
                </div>
              ))}
            </section>

            {/* ── §12 Competencies ─────────────────────────────────────── */}
            <section className="scr-card">
              <header className="scr-card-head">
                <h3>C · Competencies</h3>
                <span className="scr-hint">1 = poor evidence · 5 = very strong evidence</span>
              </header>
              {[...JUDGEMENTS, ...COMPETENCIES].map(({ key, label, weight }) => (
                <RatingRow
                  key={key}
                  label={label}
                  weight={weight}
                  value={form[key]}
                  evidence={form[`${key}_evidence`]}
                  onRate={(v) => setField(key, v)}
                  onEvidence={form[`${key}_evidence`] !== undefined || COMPETENCIES.some(c => c.key === key)
                    ? (v) => setField(`${key}_evidence`, v)
                    : null}
                />
              ))}
            </section>

            {/* ── §15 Outcome ──────────────────────────────────────────── */}
            <section className="scr-card scr-outcome">
              <header className="scr-card-head">
                <h3>D · Stage 1 decision</h3>
                <span className="scr-hint">
                  Every option stays available whatever the score says
                </span>
              </header>

              <div className="scr-decisions">
                {SCREENING_DECISIONS.map((d) => {
                  const on = outcome === d.value;
                  const tone = DECISION_TONES[d.tone];
                  return (
                    <button
                      key={d.value}
                      type="button"
                      className={`scr-decision${on ? ' is-on' : ''}`}
                      style={on ? { background: tone.bg, color: tone.color, borderColor: tone.border } : undefined}
                      onClick={() => setOutcome(on ? null : d.value)}
                      aria-pressed={on}
                    >
                      <span className="scr-decision-label">{d.label}</span>
                      <span className="scr-decision-hint">{d.hint}</span>
                      {recommendation === d.value && <span className="scr-decision-rec">suggested</span>}
                    </button>
                  );
                })}
              </div>

              {/* §14's override. Asked for only when the human disagrees, and then
                  required — the API enforces it, so this field is the way to
                  satisfy that rather than a decoration. */}
              {overriding && (
                <div className="scr-override">
                  <p className="scr-override-head">
                    <AlertTriangle size={13} />
                    The scorecard suggests <strong>{decisionLabel(recommendation)}</strong>. That is fine — please say why.
                  </p>
                  <textarea
                    className="scr-textarea"
                    rows={2}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Scores well overall but no AHF exposure, which this particular role needs."
                  />
                </div>
              )}

              {outcome === 'reject_from_manifest' && (
                <div className="scr-reject">
                  <p className="scr-reject-head">
                    <AlertTriangle size={13} />
                    A reason is required, and it stays on the candidate&rsquo;s record. Consider whether the
                    Talent Bank or a Future Opportunity fits better.
                  </p>
                  <textarea
                    className="scr-textarea"
                    rows={2}
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Why is this person not right for Manifest at all?"
                  />
                </div>
              )}

              <label className="scr-label" htmlFor="scr-summary">Summary note</label>
              <textarea
                id="scr-summary"
                className="scr-textarea"
                rows={2}
                value={form.summary_note || ''}
                onChange={(e) => setField('summary_note', e.target.value)}
                placeholder="Strong electrical fundamentals. No direct AHF experience. Consider for Testing or Service."
              />

              <div className="scr-submit-row">
                <button
                  type="button"
                  className="scr-btn scr-btn--primary"
                  disabled={!outcome || submitting}
                  onClick={submitOutcome}
                >
                  {submitting ? 'Recording…' : outcome ? `Record: ${decisionLabel(outcome)}` : 'Pick a decision above'}
                </button>
                {status === 'completed' && (
                  <span className="scr-muted">
                    Recording again replaces the previous outcome; the change is kept on the timeline.
                  </span>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* §16 and §18 collect their extra detail in their own dialog, then the
          outcome is submitted with it — one action from the recruiter's side. */}
      {dialog === 'roles' && candidate && (
        <ConsiderOtherRolesDialog
          candidate={candidate}
          departments={meta.departments || []}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            finalise({
              suitable_departments: (saved?.saved || []).map(s => ({
                department: s.department, suitability: s.suitability, reason: s.reason,
              })),
            });
          }}
        />
      )}
      {dialog === 'future' && candidate && (
        <FutureOpportunityDialog
          candidate={candidate}
          departments={meta.departments || []}
          onClose={() => setDialog(null)}
          onSaved={(rc) => {
            setDialog(null);
            // The recontact row already exists; completing the screening with the
            // same date keeps the two consistent without creating a second one
            // (the endpoint only creates one when `recontact_on` is supplied AND
            // the decision is future_opportunity, and it is idempotent per row).
            finalise({ recontact_on: rc?.recontact_on });
          }}
        />
      )}
      {dialog === 'bank' && candidate && (
        <TalentBankDialog
          candidate={candidate}
          pools={meta.pools || []}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); load(); }}
        />
      )}
    </PageShell>
  );
}

/** Only the fields the form owns. Keeps server-managed columns out of the state. */
function pickForm(s) {
  const keys = [
    'qualification_fit', 'experience_fit', 'skills_fit', 'notice_fit', 'location_fit', 'salary_fit',
    ...COMPETENCIES.map(c => c.key), ...JUDGEMENTS.map(j => j.key),
    ...COMPETENCIES.map(c => `${c.key}_evidence`),
    'role_alignment_note', 'summary_note',
  ];
  const out = {};
  for (const k of keys) if (s[k] !== null && s[k] !== undefined) out[k] = s[k];
  return out;
}

function FitRow({ label, value, options, onChange, hint }) {
  const v = value || 'not_assessed';
  return (
    <div className="scr-fit">
      <div className="scr-fit-label">
        <span>{label}</span>
        {hint && <span className="scr-fit-hint">{hint}</span>}
      </div>
      <div className="scr-fit-opts">
        {options.map(o => (
          <button
            key={o.value}
            type="button"
            className={`scr-pill${v === o.value ? ' is-on' : ''}`}
            style={v === o.value ? fitColor(o.value) : undefined}
            onClick={() => onChange(o.value)}
            aria-pressed={v === o.value}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RatingRow({ label, weight, value, evidence, onRate, onEvidence }) {
  return (
    <div className="scr-rating">
      <div className="scr-rating-head">
        <span className="scr-rating-label">
          {label}
          {/* A competency that carries no score weight says so, rather than
              letting a recruiter assume their rating moved the number. §12 asks
              for adaptability; §14's table does not score it. */}
          {weight === 0
            ? <span className="scr-rating-weight scr-rating-weight--none">recorded, not scored</span>
            : <span className="scr-rating-weight">{weight} pts</span>}
        </span>
        <div className="scr-dots" role="group" aria-label={label}>
          {RATING_SCALE.map(({ value: n, label: meaning }) => (
            <button
              key={n}
              type="button"
              className={`scr-dot${Number(value) >= n ? ' is-on' : ''}`}
              onClick={() => onRate(Number(value) === n ? '' : n)}
              title={`${n} — ${meaning}`}
              aria-label={`${label}: ${n}, ${meaning}`}
              aria-pressed={Number(value) === n}
            >
              {n}
            </button>
          ))}
          <span className="scr-dot-meaning">
            {value ? RATING_SCALE.find(r => r.value === Number(value))?.label : 'not rated'}
          </span>
        </div>
      </div>
      {onEvidence && (
        <input
          className="scr-input"
          value={evidence || ''}
          onChange={(e) => onEvidence(e.target.value)}
          placeholder="Evidence — optional. e.g. “Learned inverter troubleshooting independently.”"
        />
      )}
    </div>
  );
}
