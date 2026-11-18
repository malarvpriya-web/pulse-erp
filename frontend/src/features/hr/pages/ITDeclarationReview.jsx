// frontend/src/features/hr/pages/ITDeclarationReview.jsx
//
// Payroll Center → Tax & Statutory → IT declarations (§203, §263; moved from the
// HR menu in §265 — the old /ITDeclarationReview key redirects there). Since
// 2026-11-11 employees no longer file their own: Finance (it_declarations:add)
// enters each one here from the employee's proofs (AddDeclarationForm), and it
// is reviewed below. It reads and moves the SAME
// it_declarations rows (GET /self-service/it-declarations/review, PUT
// /self-service/it-declarations/:id) — no copy, no second record.
//   it_declarations:view     open this page, see the company's declarations
//   it_declarations:add      enter a declaration for an employee
//   it_declarations:approve  approve (in full, or less than declared with a
//                            reason) / reject (a reason is required) / reopen
// Nobody reviews their own declaration: the server refuses it and the row says so.
// Each row shows the employee's tax regime — only the old regime uses
// declarations — and their section total against the old-regime limit.
import { useState, useEffect, useCallback, useMemo } from 'react';
import { FileCheck2 } from 'lucide-react';
import api from '@/services/api/client';
import { useAuth } from '@/context/AuthContext';
import { PageHero, PageShell, EmptyState } from '@/components/pulse-ui';
import { fmtDate } from '@/utils/dateFormatter';
import { openEmployeeFile } from '@/features/employees/shared/employeeFiles';
import AddDeclarationForm from '../components/payroll/AddDeclarationForm';

function currentFY() {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() + 1 >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}
const fyOptions = () => {
  const start = Number(currentFY().slice(0, 4));
  return [start + 1, start, start - 1, start - 2].map(y => `${y}-${y + 1}`);
};
const STATUSES = [['submitted', 'Waiting for review'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['all', 'All']];
const STATUS_LABEL = { submitted: 'Waiting for review', approved: 'Approved', rejected: 'Rejected' };
const STATUS_COLOR = { submitted: '#6d28d9', approved: '#16a34a', rejected: '#dc2626' };
const SECTION_LABEL = {
  '80C': '80C', '80CCD': 'NPS (own)', '80D': '80D health insurance', HOME_LOAN: 'Home-loan interest',
  HRA: 'HRA (rent)', LTA: 'LTA', other: 'Other',
};
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
// Proof links are stored as typed; only open web links.
const safeLink = (u) => (/^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : null);

const btn = (bg, fg = '#fff') => ({ padding: '6px 12px', background: bg, color: fg, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 });
const inputStyle = { padding: '7px 10px', borderRadius: 7, border: '1px solid #e9e4ff', fontSize: 13 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#4c1d95', marginBottom: 4 };
const small = { fontSize: 11, color: '#6b7280' };

export default function ITDeclarationReview({ embedded = false } = {}) {
  const { hasPermission } = useAuth();
  const mayApprove = hasPermission('it_declarations', 'approve');
  const mayAdd = hasPermission('it_declarations', 'add');
  const [adding, setAdding] = useState(false);
  const [fy, setFy] = useState(currentFY());
  const [status, setStatus] = useState('submitted');
  const [search, setSearch] = useState('');
  const [section, setSection] = useState('all');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [panel, setPanel] = useState(null);           // { id, kind: 'reject'|'partial', reason, amount }
  const [history, setHistory] = useState({});         // id → events | 'loading' | 'error'
  const [busy, setBusy] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [bulk, setBulk] = useState(null);             // { done, total } while approving selected
  const [policy, setPolicy] = useState(null);         // { cutoff_month, cutoff_label, counts_now }

  useEffect(() => {
    api.get('/self-service/it-declarations/policy')
      .then(({ data }) => setPolicy(data && !Array.isArray(data) && Array.isArray(data.counts_now) ? data : null))
      .catch(() => setPolicy(null));
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/self-service/it-declarations/review', { params: { financial_year: fy, status } });
      setRows(Array.isArray(data) ? data : []);
      setSelected(new Set());
    } catch (err) {
      setRows([]);
      setError(err.response?.data?.message || 'Could not load declarations');
    } finally { setLoading(false); }
  }, [fy, status]);
  useEffect(() => { load(); }, [load]);

  const decide = async (row, next, { remarks, amount } = {}) => {
    setBusy(row.id); setMsg(null);
    try {
      const { data } = await api.put(`/self-service/it-declarations/${row.id}`, {
        status: next, ...(remarks ? { remarks } : {}), ...(amount != null ? { amount } : {}),
      });
      const verb = next === 'approved' ? `approved at ${inr(data?.amount ?? amount ?? row.claimed_amount)}`
        : next === 'rejected' ? 'rejected' : 'reopened for review';
      setMsg({ type: 'ok', text: `${row.employee_name} — ${SECTION_LABEL[row.declaration_type] || row.declaration_type}: ${verb}. The employee has been notified.` });
      setPanel(null);
      setHistory(h => { const n = { ...h }; delete n[row.id]; return n; });
      load();
    } catch (err) {
      setMsg({ type: 'error', text: err.response?.data?.message || 'The decision was not saved' });
    } finally { setBusy(null); }
  };

  // Approve every ticked declaration in full, one by one through the same
  // endpoint (each still checked on the server); reports what failed.
  const approveSelected = async () => {
    const list = rows.filter(r => selected.has(r.id));
    if (!list.length) return;
    setMsg(null); setBulk({ done: 0, total: list.length });
    const failed = [];
    for (const [i, r] of list.entries()) {
      try { await api.put(`/self-service/it-declarations/${r.id}`, { status: 'approved' }); }
      catch (err) { failed.push(`${r.employee_name} (${SECTION_LABEL[r.declaration_type] || r.declaration_type}): ${err.response?.data?.message || 'not saved'}`); }
      setBulk({ done: i + 1, total: list.length });
    }
    setBulk(null);
    const ok = list.length - failed.length;
    setMsg(failed.length
      ? { type: 'error', text: `${ok} approved; ${failed.length} not approved — ${failed.join('; ')}` }
      : { type: 'ok', text: `${ok} declaration${ok === 1 ? '' : 's'} approved in full. The employees have been notified.` });
    setHistory({});
    load();
  };

  const toggleHistory = async (id) => {
    if (history[id]) { setHistory(h => { const n = { ...h }; delete n[id]; return n; }); return; }
    setHistory(h => ({ ...h, [id]: 'loading' }));
    try {
      const { data } = await api.get(`/self-service/it-declarations/${id}/history`);
      setHistory(h => ({ ...h, [id]: Array.isArray(data?.events) ? data.events : [] }));
    } catch { setHistory(h => ({ ...h, [id]: 'error' })); }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => (section === 'all' || r.declaration_type === section)
      && (!q || `${r.employee_name || ''} ${r.employee_code || ''} ${r.department || ''}`.toLowerCase().includes(q)));
  }, [rows, search, section]);
  const live = shown.filter(r => r.status !== 'rejected');
  const total = live.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const allNewRegime = shown.length > 0 && shown.every(r => r.regime !== 'old');
  const selectable = shown.filter(r => mayApprove && r.can_review && r.status === 'submitted');
  const selectedShown = selectable.filter(r => selected.has(r.id));
  const toggleOne = (id) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(s => (selectedShown.length === selectable.length ? new Set() : new Set([...s, ...selectable.map(r => r.id)])));

  const partialAmount = Number(panel?.amount);
  const partialRow = panel?.kind === 'partial' ? rows.find(r => r.id === panel.id) : null;
  const partialOk = partialRow && Number.isFinite(partialAmount) && partialAmount > 0
    && partialAmount < Number(partialRow.claimed_amount) && panel.reason.trim();

  const content = (
    <>
      <div data-testid="itdr-explainer" style={{ marginBottom: 14, padding: '12px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.5, background: '#fafafa', border: '1px solid #ececec', color: '#374151' }}>
        <strong>What this is:</strong> employees hand Finance the proof of their tax savings (for example PPF under 80C,
        rent under HRA, health insurance under 80D) and Finance enters each one here with <em>Add declaration</em>.
        Check each claim and its proof, then approve, approve less, or reject.
        Approved claims lower the employee&apos;s taxable income, so payroll deducts less income tax (TDS) from their salary.
        It applies only to employees on the <strong>old tax regime</strong>; under the new regime these claims do not change tax.
      </div>
      {mayAdd && adding && (
        <AddDeclarationForm financialYear={fy} onCancel={() => setAdding(false)}
          onSaved={({ name, proofError }) => {
            setAdding(false);
            setMsg(proofError
              ? { type: 'error', text: `Declaration saved for ${name}, but the proof was not attached: ${proofError}.` }
              : { type: 'ok', text: `Declaration saved for ${name} — waiting for review.` });
            load();
          }} />
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 16 }}>
        {mayAdd && !adding && (
          <button type="button" onClick={() => setAdding(true)} style={{ ...btn('#6B3FDB'), padding: '8px 14px', fontSize: 13 }}>
            + Add declaration
          </button>
        )}
        <div>
          <label htmlFor="itdr-fy" style={labelStyle}>Financial year</label>
          <select id="itdr-fy" value={fy} onChange={e => setFy(e.target.value)} style={inputStyle}>
            {fyOptions().map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="itdr-section" style={labelStyle}>Section</label>
          <select id="itdr-section" value={section} onChange={e => setSection(e.target.value)} style={inputStyle}>
            <option value="all">All sections</option>
            {Object.entries(SECTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="itdr-search" style={labelStyle}>Employee</label>
          <input id="itdr-search" type="search" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Name, code or department" style={{ ...inputStyle, width: 220 }} />
        </div>
        <div role="tablist" aria-label="Status" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {STATUSES.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={status === k} onClick={() => setStatus(k)}
              style={{ ...btn(status === k ? '#6B3FDB' : '#ede9fe', status === k ? '#fff' : '#6B3FDB'), padding: '8px 14px' }}>{l}</button>
          ))}
        </div>
        {!mayApprove && <span style={small}>View only — reviewing needs the IT declaration approval permission.</span>}
      </div>

      {policy && (
        <div data-testid="itdr-policy" style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, background: '#f5f3ff', color: '#4c1d95' }}>
          {policy.counts_now.includes('submitted')
            ? <>This month, declarations <strong>waiting for review</strong> reduce TDS as well as approved ones (old regime).{policy.cutoff_label ? <> From the <strong>{policy.cutoff_label}</strong> payroll only approved declarations count — review before then.</> : ''}</>
            : <>Only <strong>approved</strong> declarations reduce TDS now{policy.cutoff_label ? ` (proof cut-off: ${policy.cutoff_label} payroll)` : ''}. Declarations still waiting are not counted until approved.</>}
          {' '}<span style={{ color: '#6b7280' }}>Payroll Center → Settings sets the cut-off.</span>
        </div>
      )}

      {msg && <div role="status" style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4', color: msg.type === 'error' ? '#dc2626' : '#16a34a' }}>{msg.text}</div>}

      {!loading && !error && allNewRegime && (
        <div role="note" style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 13, background: '#fffbeb', color: '#92400e' }}>
          Every employee listed is taxed under the new regime for {fy}, so these declarations do not change anyone&apos;s TDS. Review them for the record, or in case an employee moves to the old regime.
        </div>
      )}

      {loading ? <div style={{ color: '#6b7280', fontSize: 13 }}>Loading declarations…</div>
        : error ? <EmptyState title="Declarations could not be loaded" subtitle={error} action={<button onClick={load} style={btn('#6B3FDB')}>Retry</button>} />
        : shown.length === 0 ? <EmptyState icon={FileCheck2} title="Nothing here"
            subtitle={rows.length ? 'No declarations match the section or employee filter.' : `No ${status === 'all' ? '' : `${STATUS_LABEL[status].toLowerCase()} `}declarations for ${fy}.`} />
        : (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              <span>{shown.length} declaration{shown.length === 1 ? '' : 's'} · {inr(total)}{status === 'all' || status === 'rejected' ? ' (rejected not counted)' : ''}</span>
              {selectable.length > 0 && (
                <button onClick={approveSelected} disabled={!selectedShown.length || !!bulk} style={btn(selectedShown.length ? '#16a34a' : '#d1d5db')}>
                  {bulk ? `Approving ${bulk.done}/${bulk.total}…` : `Approve selected in full (${selectedShown.length})`}
                </button>
              )}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: '#f5f3ff', textAlign: 'left' }}>
                  <th style={{ padding: '8px 10px', width: 28 }}>
                    {selectable.length > 0 && (
                      <input type="checkbox" aria-label="Select all waiting declarations" checked={selectedShown.length === selectable.length}
                        onChange={toggleAll} />
                    )}
                  </th>
                  {['Employee', 'Section', 'Amount', 'Regime', 'Description', 'Proof', 'Status', ''].map(h => <th key={h} style={{ padding: '8px 10px', color: '#4c1d95' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {shown.map(r => {
                    const proof = safeLink(r.proof_url);
                    const hist = history[r.id];
                    const claimed = Number(r.claimed_amount ?? r.amount);
                    const reduced = Number(r.amount) < claimed;
                    const overLimit = r.section_limit != null && Number(r.section_total) > Number(r.section_limit);
                    return (
                      <FragmentRow key={r.id}>
                        <tr data-testid="itdr-row" style={{ borderTop: '1px solid #f0ebff', verticalAlign: 'top' }}>
                          <td style={{ padding: '8px 10px' }}>
                            {mayApprove && r.can_review && r.status === 'submitted' && (
                              <input type="checkbox" aria-label={`Select ${r.employee_name} ${r.declaration_type}`} checked={selected.has(r.id)} onChange={() => toggleOne(r.id)} />
                            )}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <div style={{ fontWeight: 600 }}>{r.employee_name}</div>
                            <div style={small}>{r.employee_code}{r.department ? ` · ${r.department}` : ''}</div>
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            {SECTION_LABEL[r.declaration_type] || r.declaration_type}
                            {r.declaration_type === 'HRA' && <div style={small}>{r.metro_city ? 'Metro city (50% of Basic)' : 'Non-metro (40% of Basic)'}</div>}
                            {r.declaration_type === 'HRA' && (r.landlord_name || r.landlord_pan) && (
                              <div style={small}>Landlord: {r.landlord_name || '—'}{r.landlord_pan ? ` · PAN ${r.landlord_pan}` : ' · no PAN'}</div>
                            )}
                            {r.declaration_type === '80D' && (
                              <div style={small}>{r.insured_for === 'parents' ? `Parents${r.parents_senior ? ' (60 or over)' : ''}` : 'Self, spouse, children'}</div>
                            )}
                            {r.declaration_type === 'other' && <div style={small}>Kept for the record; never reduces tax</div>}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <div style={{ fontWeight: 600 }}>{inr(r.amount)}</div>
                            {reduced && <div style={small}>declared {inr(claimed)}</div>}
                            {r.section_limit != null && (
                              <div style={{ ...small, color: overLimit ? '#b45309' : '#6b7280' }}>
                                {overLimit ? 'Over the limit: ' : ''}section total {inr(r.section_total)} of {inr(r.section_limit)}
                                {r.declaration_type === '80C' ? ' (with PF)' : ''}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <span style={{ fontWeight: 600, color: r.regime === 'old' ? '#4c1d95' : '#6b7280' }}>{r.regime === 'old' ? 'Old' : 'New'}</span>
                            <div style={small}>{r.regime_source === 'employee' ? 'employee choice' : 'company default'}</div>
                            {!r.counts_for_tax && r.declaration_type !== 'other' && <div style={small}>does not change TDS</div>}
                          </td>
                          <td style={{ padding: '8px 10px', maxWidth: 240 }}>{r.description || '—'}</td>
                          <td style={{ padding: '8px 10px' }}>
                            {r.proof_file && (
                              <button type="button" onClick={() => openEmployeeFile(r.proof_file).catch(() => setMsg({ type: 'error', text: 'The proof file could not be opened' }))}
                                style={{ ...btn('#ede9fe', '#6B3FDB'), padding: '3px 8px', fontSize: 11 }}>Open file</button>
                            )}
                            {proof && <div><a href={proof} target="_blank" rel="noreferrer noopener">Link</a></div>}
                            {!r.proof_file && !proof && <span style={{ color: '#9ca3af' }}>{r.proof_url ? 'Not a link' : 'None'}</span>}
                          </td>
                          <td style={{ padding: '8px 10px' }}>
                            <span style={{ fontWeight: 700, color: STATUS_COLOR[r.status] || '#6b7280' }}>{STATUS_LABEL[r.status] || r.status}</span>
                            {r.reviewed_by_name && <div style={small}>by {r.reviewed_by_name}{r.reviewed_at ? `, ${fmtDate(r.reviewed_at)}` : ''}</div>}
                            {r.last_remarks && r.status !== 'submitted' && <div style={{ fontSize: 11, color: r.status === 'rejected' ? '#dc2626' : '#6b7280' }}>{r.last_remarks}</div>}
                          </td>
                          <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {mayApprove && r.can_review && r.status !== 'approved' && (<>
                                <button onClick={() => decide(r, 'approved')} disabled={busy === r.id} style={btn('#16a34a')}>Approve {inr(claimed)}</button>
                                <button onClick={() => setPanel({ id: r.id, kind: 'partial', reason: '', amount: '' })} disabled={busy === r.id} style={btn('#dcfce7', '#166534')}>Approve less…</button>
                              </>)}
                              {mayApprove && r.can_review && r.status !== 'rejected' && (
                                <button onClick={() => setPanel({ id: r.id, kind: 'reject', reason: '' })} disabled={busy === r.id} style={btn('#dc2626')}>Reject</button>
                              )}
                              {mayApprove && r.can_review && r.status !== 'submitted' && (
                                <button onClick={() => decide(r, 'submitted')} disabled={busy === r.id} style={btn('#ede9fe', '#6B3FDB')}>Reopen</button>
                              )}
                              {!r.can_review && mayApprove && <span style={small}>Your own — another reviewer decides</span>}
                              <button onClick={() => toggleHistory(r.id)} style={btn('#f3f4f6', '#374151')} aria-expanded={!!hist}>History</button>
                            </div>
                          </td>
                        </tr>
                        {panel?.id === r.id && panel.kind === 'reject' && (
                          <tr><td colSpan={9} style={{ padding: '8px 10px', background: '#fef2f2' }}>
                            <label htmlFor={`itdr-reason-${r.id}`} style={{ fontSize: 12, fontWeight: 600 }}>Reason for rejection * <span style={{ fontWeight: 400, color: '#6b7280' }}>(the employee sees this)</span></label>
                            <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                              <input id={`itdr-reason-${r.id}`} value={panel.reason} maxLength={500} onChange={e => setPanel(p => ({ ...p, reason: e.target.value }))}
                                style={{ ...inputStyle, flex: '1 1 240px', border: '1px solid #fecaca' }} />
                              <button onClick={() => decide(r, 'rejected', { remarks: panel.reason.trim() })} disabled={!panel.reason.trim() || busy === r.id} style={btn('#dc2626')}>Confirm rejection</button>
                              <button onClick={() => setPanel(null)} style={btn('#fff', '#374151')}>Cancel</button>
                            </div>
                          </td></tr>
                        )}
                        {panel?.id === r.id && panel.kind === 'partial' && (
                          <tr><td colSpan={9} style={{ padding: '8px 10px', background: '#f0fdf4' }}>
                            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Approve less than the {inr(claimed)} declared — e.g. only part of it is proved</div>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                              <div>
                                <label htmlFor={`itdr-amount-${r.id}`} style={{ ...labelStyle, color: '#166534' }}>Approved amount (₹) *</label>
                                <input id={`itdr-amount-${r.id}`} type="number" min="1" step="1" max={claimed - 1} value={panel.amount}
                                  onChange={e => setPanel(p => ({ ...p, amount: e.target.value }))} style={{ ...inputStyle, width: 140 }} />
                              </div>
                              <div style={{ flex: '1 1 240px' }}>
                                <label htmlFor={`itdr-preason-${r.id}`} style={{ ...labelStyle, color: '#166534' }}>Reason * <span style={{ fontWeight: 400, color: '#6b7280' }}>(the employee sees this)</span></label>
                                <input id={`itdr-preason-${r.id}`} value={panel.reason} maxLength={500} onChange={e => setPanel(p => ({ ...p, reason: e.target.value }))}
                                  style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} />
                              </div>
                              <button onClick={() => decide(r, 'approved', { amount: partialAmount, remarks: panel.reason.trim() })} disabled={!partialOk || busy === r.id} style={btn('#16a34a')}>Approve {panel.amount ? inr(panel.amount) : ''}</button>
                              <button onClick={() => setPanel(null)} style={btn('#fff', '#374151')}>Cancel</button>
                            </div>
                            {panel.amount !== '' && !(partialAmount > 0 && partialAmount < claimed) && (
                              <div style={{ ...small, color: '#b45309', marginTop: 4 }}>Enter an amount above ₹0 and below {inr(claimed)}. To approve the full amount, use Approve.</div>
                            )}
                          </td></tr>
                        )}
                        {hist && (
                          <tr><td colSpan={9} style={{ padding: '8px 10px', background: '#fafafa', fontSize: 12 }}>
                            {hist === 'loading' ? 'Loading history…'
                              : hist === 'error' ? 'History could not be loaded.'
                              : hist.length === 0 ? `Filed ${fmtDate(r.created_at)} — no changes or review yet.`
                              : (
                                <ol style={{ margin: 0, paddingLeft: 18 }}>
                                  <li>Filed {fmtDate(r.created_at)}</li>
                                  {hist.map(ev => <li key={ev.id}>{describeEvent(ev)}</li>)}
                                </ol>
                              )}
                          </td></tr>
                        )}
                      </FragmentRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
    </>
  );

  // Inside Payroll Center → Tax & Statutory (§265) the hub provides the heading.
  if (embedded) return <div className="itdr-embedded">{content}</div>;
  return (
    <PageShell dock={
      <PageHero icon={FileCheck2} eyebrow="Payroll" title="IT Declarations"
        subtitle="Employees' tax-saving claims: check the proof, then approve, approve less, or reject. Approved claims lower their TDS (old regime only)." />
    }>
      {content}
    </PageShell>
  );
}

const ACTION_LABEL = { approve: 'approved', reject: 'rejected', reopen: 'reopened', update: 'edited by the employee' };
function describeEvent(ev) {
  const what = ACTION_LABEL[ev.action] || (ev.from_status !== ev.to_status ? `${ev.from_status || '—'} → ${ev.to_status || '—'}` : 'changed');
  const amountChanged = ev.from_amount != null && ev.to_amount != null && Number(ev.from_amount) !== Number(ev.to_amount);
  return `${fmtDate(ev.at)} — ${ev.by_name || 'Someone'}: ${what}`
    + (amountChanged ? `, amount ${inr(ev.from_amount)} → ${inr(ev.to_amount)}` : '')
    + (ev.remarks ? ` (“${ev.remarks}”)` : '');
}

function FragmentRow({ children }) { return <>{children}</>; }
