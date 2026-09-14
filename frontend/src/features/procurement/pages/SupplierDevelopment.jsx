/**
 * Supplier Development — the last stage of the supplier loop.
 *
 * Supplier development existed in this product only as a string in
 * sourcingStrategyEngine's strategy list: a label the advisory panel rendered,
 * with no plan, no owner, no target and no way to say afterwards whether the
 * supplier actually improved. This page is the object behind the label.
 *
 * THREE THINGS THIS SCREEN DELIBERATELY DOES
 *
 *  1. It RECOMMENDS, it does not auto-create. Findings are listed with the
 *     evidence behind them; a buyer opens the plan. Auto-opening a plan for
 *     every Critical supplier would fill the list with records nobody agreed to
 *     and nobody works.
 *
 *  2. It shows the rating BESIDE the plan, never instead of it. An open
 *     programme does not soften a Critical badge — a plan is a response to a bad
 *     score, not a cure for it. A supplier under development and a supplier
 *     nobody is helping must stay visibly different, and equally visibly bad.
 *
 *  3. It reports movement against a FROZEN baseline. Every plan names one metric
 *     from the scorecard, the reading is captured when the plan opens, and the
 *     page shows baseline → current so a programme that is achieving nothing
 *     cannot look busy.
 *
 * ⚠ Unmeasured renders as an em dash, never as 0 or 0%. The scorecard publishes
 * null for a KPI it could not measure, and `|| 0` on any of these is the worst
 * reading of "we have not looked yet" — the trap logged in
 * project_supplier_performance_index.
 */
import { useState, useEffect, useCallback } from 'react';
import { Sprout, Plus, X, Target, CalendarClock, CheckCircle2, AlertTriangle } from 'lucide-react';
import api from '@/services/api/client';
import { PageHero, PageShell, StatBand, Stat, SectionTitle } from '@/components/pulse-ui';

// ── Vocabulary ────────────────────────────────────────────────────────────────
const STATUS_TONE = {
  draft:     { label: 'Draft',      color: '#6b7280', bg: '#f3f4f6' },
  active:    { label: 'Active',     color: '#2563eb', bg: '#dbeafe' },
  in_review: { label: 'In review',  color: '#6d28d9', bg: '#ede9fe' },
  completed: { label: 'Completed',  color: '#16a34a', bg: '#dcfce7' },
  abandoned: { label: 'Abandoned',  color: '#6b7280', bg: '#f3f4f6' },
};

const HEALTH_TONE = {
  Preferred: { color: '#16a34a', bg: '#dcfce7' },
  Approved:  { color: '#2563eb', bg: '#dbeafe' },
  Watchlist: { color: '#6d28d9', bg: '#ede9fe' },
  Critical:  { color: '#dc2626', bg: '#fee2e2' },
  Unrated:   { color: '#6b7280', bg: '#f3f4f6' },
};

const EFFECTIVENESS_TONE = {
  improved:   { label: 'Improved',   color: '#16a34a' },
  no_change:  { label: 'No change',  color: '#6b7280' },
  worsened:   { label: 'Worsened',   color: '#dc2626' },
  // Not folded in with "no change": a programme whose effect could not be
  // measured is a gap in our evidence, not a verdict about the supplier.
  unmeasured: { label: 'Unmeasured', color: '#6d28d9' },
};

const METRIC_LABELS = {
  health_score: 'Health score', quality_score: 'Quality score', delivery_score: 'Delivery score',
  cost_score: 'Cost score', support_score: 'Responsiveness', otd_pct: 'On-time delivery %',
  pass_rate_pct: 'Inspection pass rate %', capa_closure_pct: 'CAPA closure %',
  fill_rate_pct: 'Fill rate %', lead_time_adherence_pct: 'Lead-time adherence %',
  ppv_pct: 'Purchase price variance %', open_ncr_count: 'Open NCRs',
};

/** Lower is better for these — see supplierDevelopmentEngine.assessEffectiveness. */
const LOWER_IS_BETTER = new Set(['ppv_pct', 'open_ncr_count']);

const SEVERITY_TONE = { high: '#dc2626', medium: '#6d28d9', low: '#6b7280' };

// ⚠ null renders as an em dash. Never `|| 0`.
const num = (v, digits = 1) => (v == null || v === '' ? '—' : Number(v).toFixed(digits));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

const Pill = ({ tone, children }) => (
  <span style={{
    display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11.5,
    fontWeight: 700, color: tone?.color || '#6b7280', background: tone?.bg || '#f3f4f6',
    whiteSpace: 'nowrap',
  }}>{children}</span>
);

const card = {
  background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
  padding: 16, marginBottom: 16,
};
const th = { textAlign: 'left', padding: '9px 12px', fontSize: 11.5, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, borderBottom: '1px solid #e5e7eb' };
const td = { padding: '10px 12px', fontSize: 13, borderBottom: '1px solid #f3f4f6', verticalAlign: 'middle' };
const btn = (primary) => ({
  padding: '7px 13px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
  border: primary ? 'none' : '1px solid #d1d5db',
  background: primary ? '#2563eb' : '#fff', color: primary ? '#fff' : '#374151',
});

export default function SupplierDevelopment() {
  const [plans, setPlans]       = useState([]);
  const [summary, setSummary]   = useState(null);
  const [vendors, setVendors]   = useState([]);
  const [methods, setMethods]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  const [recVendor, setRecVendor] = useState('');
  const [rec, setRec]             = useState(null);
  const [recLoading, setRecLoading] = useState(false);

  const [openPlan, setOpenPlan]   = useState(null);
  const [draft, setDraft]         = useState(null);
  const [busy, setBusy]           = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [p, s, m] = await Promise.all([
        api.get('/supplier-development'),
        api.get('/supplier-development/summary'),
        api.get('/supplier-development/methods'),
      ]);
      setPlans(p.data?.data || []);
      setSummary(s.data?.data || null);
      setMethods(m.data?.data || []);
    } catch (e) {
      // Surfaced, not swallowed into an empty table. An empty development board
      // reads as "nothing to do", which is the opposite of a failed load.
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.get('/vendors').then((r) => {
      const rows = r.data?.data || r.data || [];
      setVendors(Array.isArray(rows) ? rows : []);
    }).catch(() => setVendors([]));
  }, []);

  const loadRecommendation = async (vendorId) => {
    if (!vendorId) { setRec(null); return; }
    setRecLoading(true);
    try {
      const r = await api.get(`/supplier-development/recommendations/${vendorId}`);
      setRec(r.data?.data || null);
    } catch (e) {
      setRec({ error: e?.response?.data?.error || e.message });
    } finally {
      setRecLoading(false);
    }
  };

  const startPlanFrom = (reason) => {
    const v = vendors.find((x) => String(x.id) === String(recVendor));
    setDraft({
      vendor_id: recVendor,
      vendor_name: v ? (v.vendor_name || v.name) : '',
      method: reason?.method || 'other',
      title: reason ? `${METRIC_LABELS[reason.metric] || reason.metric} improvement` : '',
      objective: '',
      owner_employee_id: '',
      // The evidence travels onto the plan, so "why did we start this" outlives
      // whoever started it.
      trigger_reason: reason?.detail || '',
      target_metric: reason?.metric || 'health_score',
      target_value: '',
      target_date: '',
      review_date: '',
    });
  };

  const savePlan = async () => {
    setBusy(true);
    try {
      const body = { ...draft };
      delete body.vendor_name;
      ['owner_employee_id', 'target_value'].forEach((k) => { if (body[k] === '') body[k] = null; });
      ['target_date', 'review_date'].forEach((k) => { if (!body[k]) body[k] = null; });
      await api.post('/supplier-development', body);
      setDraft(null);
      await load();
      if (recVendor) await loadRecommendation(recVendor);
    } catch (e) {
      alert(e?.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  const openDetail = async (id) => {
    try {
      const r = await api.get(`/supplier-development/${id}`);
      setOpenPlan(r.data?.data || null);
    } catch (e) { alert(e?.response?.data?.error || e.message); }
  };

  const setStatus = async (id, status) => {
    setBusy(true);
    try {
      if (status === 'completed' || status === 'abandoned') {
        await api.post(`/supplier-development/${id}/close`, { status });
      } else {
        await api.patch(`/supplier-development/${id}`, { status });
      }
      await load();
      await openDetail(id);
    } catch (e) { alert(e?.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };

  const toggleAction = async (action) => {
    try {
      await api.patch(`/supplier-development/actions/${action.id}`, {
        status: action.status === 'done' ? 'open' : 'done',
      });
      await openDetail(openPlan.id);
      await load();
    } catch (e) { alert(e?.response?.data?.error || e.message); }
  };

  const addAction = async (planId, description, party) => {
    if (!description.trim()) return;
    try {
      await api.post(`/supplier-development/${planId}/actions`, {
        description, responsible_party: party,
      });
      await openDetail(planId);
      await load();
    } catch (e) { alert(e?.response?.data?.error || e.message); }
  };

  const c = summary?.counts || {};
  const outcomeCount = (k) => summary?.outcomes?.find((o) => o.effectiveness === k)?.c ?? 0;

  return (
    <PageShell>
      <PageHero
        icon={Sprout}
        eyebrow="Procurement"
        title="Supplier Development"
        subtitle="Improvement programmes run with suppliers, measured against the scorecard reading they started from."
        tone="violet"
      />

      <StatBand>
        <Stat label="Active plans"      value={c.active ?? 0} />
        <Stat label="Suppliers covered" value={c.suppliers ?? 0} />
        <Stat label="Reviews due"       value={summary?.reviews_due?.length ?? 0} />
        <Stat label="Improved"          value={outcomeCount('improved')} />
        <Stat label="No change"         value={outcomeCount('no_change')} />
        <Stat label="Worsened"          value={outcomeCount('worsened')} />
      </StatBand>

      {error && (
        <div style={{ ...card, borderColor: '#fecaca', background: '#fef2f2', color: '#b91c1c' }}>
          <strong>Could not load supplier development.</strong> {error}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        {/* ── Plans ─────────────────────────────────────────────────────────── */}
        <div>
          <SectionTitle>Development plans</SectionTitle>
          <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                <thead>
                  <tr>
                    <th style={th}>Plan</th>
                    <th style={th}>Supplier</th>
                    <th style={th}>Rating</th>
                    <th style={th}>Target</th>
                    <th style={th}>Baseline</th>
                    <th style={th}>Actions</th>
                    <th style={th}>Review</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {loading && (
                    <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={8}>Loading…</td></tr>
                  )}
                  {!loading && plans.length === 0 && (
                    <tr><td style={{ ...td, color: '#9ca3af' }} colSpan={8}>
                      No development plans yet. Pick a supplier on the right to see what its record argues for.
                    </td></tr>
                  )}
                  {plans.map((p) => (
                    <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(p.id)}>
                      <td style={{ ...td, fontWeight: 600 }}>
                        {p.plan_number}
                        <div style={{ fontWeight: 400, color: '#6b7280', fontSize: 12 }}>{p.title}</div>
                      </td>
                      <td style={td}>{p.vendor_name}</td>
                      {/* ⚠ The rating sits BESIDE the plan. An open programme
                          never softens it. */}
                      <td style={td}>
                        <Pill tone={HEALTH_TONE[p.health_status]}>
                          {p.health_status || 'Unrated'} {p.health_score == null ? '' : num(p.health_score, 1)}
                        </Pill>
                      </td>
                      <td style={td}>{METRIC_LABELS[p.target_metric] || p.target_metric}</td>
                      <td style={td}>
                        {num(p.baseline_value)} {p.target_value == null ? '' : <span style={{ color: '#6b7280' }}>→ {num(p.target_value)}</span>}
                      </td>
                      <td style={td}>
                        {p.actions_done ?? 0}/{p.action_count ?? 0}
                        {(p.actions_overdue ?? 0) > 0 && (
                          <span style={{ color: '#dc2626', fontWeight: 700, marginLeft: 6 }}>
                            {p.actions_overdue} overdue
                          </span>
                        )}
                      </td>
                      <td style={td}>{fmtDate(p.review_date)}</td>
                      <td style={td}>
                        <Pill tone={STATUS_TONE[p.status]}>{STATUS_TONE[p.status]?.label || p.status}</Pill>
                        {p.effectiveness && (
                          <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 3, color: EFFECTIVENESS_TONE[p.effectiveness]?.color }}>
                            {EFFECTIVENESS_TONE[p.effectiveness]?.label}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {summary?.reviews_due?.length > 0 && (
            <>
              <SectionTitle>Reviews due in the next 14 days</SectionTitle>
              <div style={card}>
                {summary.reviews_due.map((r) => (
                  <div key={r.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '6px 0', fontSize: 13 }}>
                    <CalendarClock size={15} color="#6d28d9" />
                    <strong>{fmtDate(r.review_date)}</strong>
                    <span style={{ color: '#6b7280' }}>{r.vendor_name}</span>
                    <span>{r.title}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── Recommendations ───────────────────────────────────────────────── */}
        <div>
          <SectionTitle>What the record argues for</SectionTitle>
          <div style={card}>
            <select
              value={recVendor}
              onChange={(e) => { setRecVendor(e.target.value); loadRecommendation(e.target.value); }}
              style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }}
            >
              <option value="">Select a supplier…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.vendor_name || v.name}</option>
              ))}
            </select>

            {recLoading && <p style={{ color: '#9ca3af', fontSize: 13, marginTop: 12 }}>Recomputing the scorecard…</p>}

            {rec?.error && <p style={{ color: '#b91c1c', fontSize: 13, marginTop: 12 }}>{rec.error}</p>}

            {rec && !rec.error && !recLoading && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <Pill tone={HEALTH_TONE[rec.health_status]}>
                    {rec.health_status} {num(rec.health_score)}
                  </Pill>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    {num(rec.coveragePct, 0)}% of the scorecard measured
                  </span>
                </div>

                {/* ⚠ Thin evidence is said out loud rather than dressed up as a
                    clean bill of health. */}
                {rec.withheld === 'insufficient_evidence' && (
                  <p style={{ fontSize: 13, color: '#6d28d9', lineHeight: 1.5 }}>
                    <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> Too little measured to prescribe
                    anything. This supplier needs orders and receipts on record before a development
                    programme would be aimed at anything real.
                  </p>
                )}

                {rec.withheld === 'no_finding' && (
                  <p style={{ fontSize: 13, color: '#16a34a', lineHeight: 1.5 }}>
                    <CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> Nothing in the measured record
                    argues for a development programme.
                  </p>
                )}

                {rec.reasons_unaddressed?.map((r, i) => (
                  <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 11, marginBottom: 9 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'start' }}>
                      <strong style={{ fontSize: 12.5, color: SEVERITY_TONE[r.severity] }}>
                        {METRIC_LABELS[r.metric] || r.metric}
                      </strong>
                      <button style={btn(true)} onClick={() => startPlanFrom(r)}>
                        <Plus size={12} style={{ verticalAlign: -2 }} /> Open plan
                      </button>
                    </div>
                    <p style={{ fontSize: 12.5, color: '#4b5563', margin: '6px 0 0', lineHeight: 1.5 }}>{r.detail}</p>
                  </div>
                ))}

                {/* Findings already being worked are shown, not hidden — the
                    problem still exists. */}
                {rec.reasons_open?.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <p style={{ fontSize: 11.5, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                      Already covered by an open plan
                    </p>
                    {rec.reasons_open.map((r, i) => (
                      <p key={i} style={{ fontSize: 12.5, color: '#6b7280', margin: '4px 0', lineHeight: 1.5 }}>
                        {METRIC_LABELS[r.metric] || r.metric} — {r.detail}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── New plan ────────────────────────────────────────────────────────── */}
      {draft && (
        <Modal title={`New plan — ${draft.vendor_name}`} onClose={() => setDraft(null)}>
          <Field label="Title">
            <input style={inputStyle} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>
          <Field label="Method">
            <select style={inputStyle} value={draft.method} onChange={(e) => setDraft({ ...draft, method: e.target.value })}>
              {methods.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Target metric" hint="Frozen once the plan is created — the baseline is captured against it.">
            <select style={inputStyle} value={draft.target_metric} onChange={(e) => setDraft({ ...draft, target_metric: e.target.value })}>
              {Object.entries(METRIC_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label={`Target value${LOWER_IS_BETTER.has(draft.target_metric) ? ' (lower is better)' : ''}`}>
            <input style={inputStyle} type="number" value={draft.target_value}
                   onChange={(e) => setDraft({ ...draft, target_value: e.target.value })} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Target date">
              <input style={inputStyle} type="date" value={draft.target_date}
                     onChange={(e) => setDraft({ ...draft, target_date: e.target.value })} />
            </Field>
            <Field label="Next review">
              <input style={inputStyle} type="date" value={draft.review_date}
                     onChange={(e) => setDraft({ ...draft, review_date: e.target.value })} />
            </Field>
          </div>
          <Field label="Objective">
            <textarea style={{ ...inputStyle, minHeight: 64 }} value={draft.objective}
                      onChange={(e) => setDraft({ ...draft, objective: e.target.value })} />
          </Field>
          <Field label="Why this was opened" hint="Carried from the finding, so the decision stays auditable.">
            <textarea style={{ ...inputStyle, minHeight: 54 }} value={draft.trigger_reason}
                      onChange={(e) => setDraft({ ...draft, trigger_reason: e.target.value })} />
          </Field>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button style={btn(false)} onClick={() => setDraft(null)}>Cancel</button>
            <button style={btn(true)} disabled={busy || !draft.title} onClick={savePlan}>
              {busy ? 'Saving…' : 'Create plan'}
            </button>
          </div>
        </Modal>
      )}

      {/* ── Plan detail ─────────────────────────────────────────────────────── */}
      {openPlan && (
        <Modal title={`${openPlan.plan_number} — ${openPlan.vendor_name}`} onClose={() => setOpenPlan(null)} wide>
          <PlanDetail
            plan={openPlan}
            busy={busy}
            onStatus={(s) => setStatus(openPlan.id, s)}
            onToggleAction={toggleAction}
            onAddAction={(d, p) => addAction(openPlan.id, d, p)}
          />
        </Modal>
      )}
    </PageShell>
  );
}

// ── Plan detail ───────────────────────────────────────────────────────────────
function PlanDetail({ plan, busy, onStatus, onToggleAction, onAddAction }) {
  const [desc, setDesc] = useState('');
  const [party, setParty] = useState('buyer');
  const closed = ['completed', 'abandoned'].includes(plan.status);
  const prog = plan.progress || {};

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <Pill tone={STATUS_TONE[plan.status]}>{STATUS_TONE[plan.status]?.label || plan.status}</Pill>
        <Pill tone={{ color: '#6b7280', bg: '#f3f4f6' }}>{plan.method}</Pill>
        {plan.owner_name && <Pill tone={{ color: '#2563eb', bg: '#dbeafe' }}>Owner: {plan.owner_name}</Pill>}
        {plan.vendor_contact_name && <Pill tone={{ color: '#6d28d9', bg: '#ede9fe' }}>Supplier: {plan.vendor_contact_name}</Pill>}
      </div>

      {plan.objective && <p style={{ fontSize: 13, color: '#374151', lineHeight: 1.55 }}>{plan.objective}</p>}
      {plan.trigger_reason && (
        <p style={{ fontSize: 12.5, color: '#6b7280', lineHeight: 1.55, borderLeft: '3px solid #e5e7eb', paddingLeft: 10 }}>
          {plan.trigger_reason}
        </p>
      )}

      {/* Movement against the frozen baseline. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, margin: '14px 0' }}>
        <Box label="Metric" value={METRIC_LABELS[plan.target_metric] || plan.target_metric} />
        <Box label="Baseline" value={num(plan.baseline_value)} sub={fmtDate(plan.baseline_captured_at)} />
        <Box label={closed ? 'At close' : 'Now'} value={num(closed ? plan.outcome_value : plan.current_value)} />
        <Box label="Target" value={num(plan.target_value)} sub={fmtDate(plan.target_date)} />
        <Box
          label={closed ? 'Effectiveness' : 'Movement'}
          value={EFFECTIVENESS_TONE[closed ? plan.effectiveness : prog.effectiveness]?.label || '—'}
          color={EFFECTIVENESS_TONE[closed ? plan.effectiveness : prog.effectiveness]?.color}
        />
      </div>

      <SectionTitle>Actions</SectionTitle>
      {(plan.actions || []).length === 0 && (
        <p style={{ fontSize: 13, color: '#9ca3af' }}>No actions yet. A plan without actions is an intention.</p>
      )}
      {(plan.actions || []).map((a) => (
        <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f3f4f6' }}>
          <input type="checkbox" checked={a.status === 'done'} onChange={() => onToggleAction(a)} disabled={closed} />
          <span style={{ flex: 1, fontSize: 13, textDecoration: a.status === 'done' ? 'line-through' : 'none', color: a.status === 'done' ? '#9ca3af' : '#374151' }}>
            {a.description}
          </span>
          <Pill tone={a.responsible_party === 'supplier' ? { color: '#6d28d9', bg: '#ede9fe' } : { color: '#2563eb', bg: '#dbeafe' }}>
            {a.responsible_party === 'supplier' ? 'Supplier' : 'Us'}
          </Pill>
          <span style={{ fontSize: 12, color: a.due_date && a.status !== 'done' && new Date(a.due_date) < new Date() ? '#dc2626' : '#6b7280' }}>
            {fmtDate(a.due_date)}
          </span>
        </div>
      ))}

      {!closed && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            style={{ ...inputStyle, flex: 1 }} placeholder="Add an action…"
            value={desc} onChange={(e) => setDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { onAddAction(desc, party); setDesc(''); } }}
          />
          <select style={{ ...inputStyle, width: 110 }} value={party} onChange={(e) => setParty(e.target.value)}>
            <option value="buyer">Us</option>
            <option value="supplier">Supplier</option>
          </select>
          <button style={btn(true)} onClick={() => { onAddAction(desc, party); setDesc(''); }}>Add</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18, flexWrap: 'wrap' }}>
        {plan.status === 'draft'  && <button style={btn(true)}  disabled={busy} onClick={() => onStatus('active')}>Activate</button>}
        {plan.status === 'active' && <button style={btn(false)} disabled={busy} onClick={() => onStatus('in_review')}>Move to review</button>}
        {!closed && (
          <>
            <button style={btn(false)} disabled={busy} onClick={() => onStatus('abandoned')}>Abandon</button>
            {/* Closing re-reads the scorecard and derives the verdict — it is not
                typed by the person closing their own plan. */}
            <button style={btn(true)} disabled={busy} onClick={() => onStatus('completed')}>
              <Target size={12} style={{ verticalAlign: -2 }} /> Complete &amp; measure
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Small pieces ──────────────────────────────────────────────────────────────
const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, fontFamily: 'inherit' };

const Field = ({ label, hint, children }) => (
  <div style={{ marginBottom: 12 }}>
    <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
    {children}
    {hint && <p style={{ fontSize: 11.5, color: '#9ca3af', margin: '4px 0 0' }}>{hint}</p>}
  </div>
);

const Box = ({ label, value, sub, color }) => (
  <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '9px 11px' }}>
    <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.3, fontWeight: 700 }}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: color || '#111827', marginTop: 2 }}>{value}</div>
    {sub && <div style={{ fontSize: 11.5, color: '#9ca3af' }}>{sub}</div>}
  </div>
);

function Modal({ title, children, onClose, wide }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }}
      onClick={onClose}
    >
      <div
        style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: wide ? 720 : 520, padding: 20, boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#6b7280' }}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
