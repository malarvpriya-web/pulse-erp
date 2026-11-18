// frontend/src/features/hr/pages/SkillsCompetencies.jsx
// Skills & Competencies (2026-11-18) — replaces Skill Matrix and Competency
// Framework, which kept two separate skill registers that never met. One
// library (shared with Performance reviews), one 1–5 rating per person, the
// level each designation needs, and the gaps between them. Trainings, tests
// and certificates raise ratings by themselves; HR and the reporting manager
// rate here.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Target } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { Filters, Pill, Empty, Tabs, LndDialog, EmployeeSelect, useLndOptions, resetLndOptions, Level, LEVEL_LABEL, fmtDate, toQuery, errText, downloadCsv, statusLabel } from '@/features/hr/learning/lndUi';

function useCategories() {
  const [c, setC] = useState([]);
  useEffect(() => { api.get('/competencies/categories').then(r => setC(r.data)).catch(() => {}); }, []);
  return c;
}

/* ── matrix ────────────────────────────────────────────────────── */
function Matrix({ onRate }) {
  const o = useLndOptions();
  const cats = useCategories();
  const [f, setF] = useState({ department: '', designation: '', category: '', q: '', gaps_only: '' });
  const [d, setD] = useState(null);
  const load = useCallback(() => { setD(null); api.get(`/competencies/matrix${toQuery(f)}`).then(r => setD(r.data)).catch(() => setD({ employees: [], competencies: [], summary: [] })); }, [f]);
  useEffect(() => { load(); }, [load]);
  const exportRows = () => downloadCsv(d.employees.flatMap(e => d.competencies.map(c => ({ employee: e.name, code: e.office_id, department: e.department,
    designation: e.designation, skill: c.name, level: e.cells[c.id]?.level ?? '', required: e.cells[c.id]?.required ?? c.expected_level, gap: e.cells[c.id]?.gap ? 'yes' : '' }))), 'skill-matrix');
  return (<>
    <Filters value={f} onChange={setF} fields={['department', 'q']} onReset={() => setF({ department: '', designation: '', category: '', q: '', gaps_only: '' })} extra={<>
      <label>Designation<select value={f.designation} onChange={e => setF(v => ({ ...v, designation: e.target.value }))}><option value="">All</option>{o.designations.map(x => <option key={x}>{x}</option>)}</select></label>
      <label>Skill category<select value={f.category} onChange={e => setF(v => ({ ...v, category: e.target.value }))}><option value="">All</option>{cats.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select></label>
      <label className="lnd-check"><input type="checkbox" checked={f.gaps_only === 'true'} onChange={e => setF(v => ({ ...v, gaps_only: e.target.checked ? 'true' : '' }))} /> Only people with gaps</label>
    </>} />
    <div className="lnd-card">
      <div className="lnd-card-title"><span>{d ? `${d.employees.length} people × ${d.competencies.length} skills` : 'Loading…'}</span>
        <span className="lnd-actions"><span className="lnd-muted">Red outline = below the level the designation needs. Click a cell to rate.</span>
          {d?.employees.length > 0 && <button type="button" className="lnd-link" onClick={exportRows}>Export CSV</button>}</span></div>
      {!d ? <Empty>Loading…</Empty> : !d.competencies.length ? <Empty>The library is empty. Add skills in the Library tab.</Empty> : d.employees.length ? (
        <div className="lnd-table-wrap" style={{ maxHeight: 620 }}><table className="lnd-table">
          <thead><tr><th style={{ left: 0, position: 'sticky', zIndex: 2 }}>Employee</th>{d.competencies.map(c => <th key={c.id} title={c.category || ''} style={{ textAlign: 'center', minWidth: 70 }}>{c.name}</th>)}<th className="num">Gaps</th></tr></thead>
          <tbody>
            {d.employees.map(e => (
              <tr key={e.id}>
                <td style={{ position: 'sticky', left: 0, background: '#fff' }}><button type="button" className="lnd-link" onClick={() => onRate(e.id)}>{e.name}</button><div className="lnd-muted">{e.designation} · {e.department}</div></td>
                {d.competencies.map(c => { const cell = e.cells[c.id]; return (
                  <td key={c.id} style={{ textAlign: 'center' }}>
                    <Level level={cell?.level} gap={cell?.gap} onClick={() => onRate(e.id)}
                      title={`${c.name}: ${cell?.level ? `L${cell.level} ${LEVEL_LABEL[cell.level]} (${statusLabel(cell.source)}, ${fmtDate(cell.assessed_date)})` : 'not rated'}${cell?.required ? ` · needs L${cell.required}` : ''}`} />
                  </td>); })}
                <td className="num">{e.gaps || '—'}</td>
              </tr>
            ))}
            <tr><td style={{ position: 'sticky', left: 0, background: '#f5f3ff' }}><strong>Average</strong></td>
              {d.summary.map(s => <td key={s.competency_id} style={{ textAlign: 'center', background: '#f5f3ff' }}>{s.avg_level ?? '—'}<div className="lnd-muted">{s.rated} rated</div></td>)}<td style={{ background: '#f5f3ff' }} /></tr>
          </tbody></table></div>
      ) : <Empty>No employees match.</Empty>}
    </div>
  </>);
}

/* ── library ───────────────────────────────────────────────────── */
function CompForm({ comp, onClose, onSaved }) {
  const cats = useCategories();
  const [f, setF] = useState({ name: comp?.name || '', category: comp?.category || '', description: comp?.description || '', expected_level: comp?.expected_level || 3,
    level_1_descriptor: comp?.level_1_descriptor || 'Aware of the basics', level_2_descriptor: comp?.level_2_descriptor || 'Can apply with guidance',
    level_3_descriptor: comp?.level_3_descriptor || 'Works independently', level_4_descriptor: comp?.level_4_descriptor || 'Handles complex cases, guides others',
    level_5_descriptor: comp?.level_5_descriptor || 'Recognised expert, sets the standard', is_active: comp?.is_active ?? true });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try { comp ? await api.put(`/competencies/${comp.id}`, f) : await api.post('/competencies', f); resetLndOptions(); onSaved(); }
    catch (x) { setErr(errText(x)); }
  };
  return (
    <LndDialog title={comp ? 'Edit skill / competency' : 'Add skill / competency'} onClose={onClose} width={680} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="lnd-comp" className="pulse-btn-primary">Save</button></>}>
      <form id="lnd-comp" className="lnd-form" onSubmit={save}>
        <label className="full">Name *<input required value={f.name} onChange={set('name')} /></label>
        <label>Category<select value={f.category} onChange={set('category')}><option value="">—</option>{cats.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select>
          <span className="hint">Categories are kept in Master Setup → Skill Categories.</span></label>
        <label>Expected level (default)<select value={f.expected_level} onChange={set('expected_level')}>{[1, 2, 3, 4, 5].map(l => <option key={l} value={l}>L{l} {LEVEL_LABEL[l]}</option>)}</select>
          <span className="hint">Used when the designation has no requirement of its own.</span></label>
        <label className="full">Description<input value={f.description} onChange={set('description')} /></label>
        {[1, 2, 3, 4, 5].map(l => <label key={l}>L{l} {LEVEL_LABEL[l]}<input value={f[`level_${l}_descriptor`]} onChange={set(`level_${l}_descriptor`)} /></label>)}
        {comp && <label className="lnd-inline"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} /> Active</label>}
      </form>
    </LndDialog>
  );
}

function Library() {
  const toast = useToast();
  const cats = useCategories();
  const [f, setF] = useState({ status: 'active', category: '', q: '' });
  const [rows, setRows] = useState(null);
  const [dlg, setDlg] = useState(null);
  const load = useCallback(() => api.get(`/competencies${toQuery(f)}`).then(r => setRows(r.data)).catch(() => setRows([])), [f]);
  useEffect(() => { load(); }, [load]);
  const remove = async () => {
    const id = dlg.id; setDlg(null);
    try { const r = await api.delete(`/competencies/${id}`); toast.success(r.data.message); resetLndOptions(); load(); } catch (e) { toast.error(errText(e)); }
  };
  return (<>
    <Filters value={f} onChange={setF} fields={['q']} onReset={() => setF({ status: 'active', category: '', q: '' })} extra={<>
      <label>Category<select value={f.category} onChange={e => setF(v => ({ ...v, category: e.target.value }))}><option value="">All</option>{cats.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select></label>
      <label>Status<select value={f.status} onChange={e => setF(v => ({ ...v, status: e.target.value }))}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></label>
    </>} />
    <div className="lnd-card">
      <div className="lnd-card-title"><span>{rows?.length ?? 0} skill(s)</span><button type="button" className="pulse-btn-primary lnd-btn-sm" onClick={() => setDlg({ type: 'form' })}>+ Add skill</button></div>
      {!rows ? <Empty>Loading…</Empty> : rows.length ? (
        <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>Skill / competency</th><th>Category</th><th>Expected</th><th className="num">Rated</th><th className="num">Avg</th><th className="num">Roles</th><th className="num">Trainings</th><th /></tr></thead>
          <tbody>{rows.map(c => (
            <tr key={c.id}><td>{c.name} {!c.is_active && <Pill>Inactive</Pill>}{c.description && <div className="lnd-muted">{c.description}</div>}</td><td>{c.category || '—'}</td>
              <td>L{c.expected_level}</td><td className="num">{c.rated_count}</td><td className="num">{c.avg_level ?? '—'}</td><td className="num">{c.role_count}</td><td className="num">{c.program_count}</td>
              <td><div className="lnd-actions"><button type="button" className="lnd-link" onClick={() => setDlg({ type: 'form', comp: c })}>Edit</button>
                <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'del', id: c.id })}>Delete</button></div></td></tr>
          ))}</tbody></table></div>
      ) : <Empty>No skills yet.</Empty>}
    </div>
    {dlg?.type === 'form' && <CompForm comp={dlg.comp} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); toast.success('Saved'); load(); }} />}
    <ConfirmDialog open={dlg?.type === 'del'} title="Delete skill" message="Delete this skill? If anyone is rated on it, or a role, training or certificate uses it, it is deactivated instead." confirmLabel="Delete" variant="danger" onConfirm={remove} onCancel={() => setDlg(null)} />
  </>);
}

/* ── role requirements ─────────────────────────────────────────── */
function RoleRequirements() {
  const toast = useToast();
  const o = useLndOptions();
  const [comps, setComps] = useState([]);
  const [role, setRole] = useState('');
  const [reqs, setReqs] = useState([]);
  const [all, setAll] = useState([]);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/competencies').then(r => setComps(r.data)).catch(() => {}); }, []);
  const loadAll = useCallback(() => api.get('/competencies/role-requirements').then(r => setAll(r.data)).catch(() => {}), []);
  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { setReqs(all.filter(r => r.role_title.toLowerCase() === role.toLowerCase()).map(r => ({ competency_id: r.competency_id, required_level: r.required_level }))); }, [role, all]);
  const byRole = useMemo(() => all.reduce((m, r) => { (m[r.role_title] = m[r.role_title] || []).push(r); return m; }, {}), [all]);
  const save = async () => {
    setErr('');
    try { await api.put('/competencies/role-requirements', { role_title: role, requirements: reqs }); toast.success(`Saved for ${role}`); loadAll(); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <div className="lnd-grid lnd-grid-2">
      <div className="lnd-card">
        <h4 className="lnd-card-title"><span>Set what a designation needs</span></h4>
        {err && <div className="lnd-error">{err}</div>}
        <div className="lnd-form" style={{ marginBottom: 12 }}>
          <label className="full">Designation<select value={role} onChange={e => setRole(e.target.value)}><option value="">Choose…</option>{o.designations.map(d => <option key={d}>{d}</option>)}</select></label>
        </div>
        {role && (<>
          {reqs.map((r, i) => (
            <div key={i} className="lnd-actions" style={{ marginBottom: 6 }}>
              <select value={r.competency_id} style={{ flex: 1, padding: 7, borderRadius: 7, border: '1px solid #e9e4ff' }} onChange={e => setReqs(l => l.map((x, j) => j === i ? { ...x, competency_id: Number(e.target.value) } : x))}>
                {comps.filter(c => c.is_active && (c.id === r.competency_id || !reqs.some(x => x.competency_id === c.id))).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              <select value={r.required_level} style={{ padding: 7, borderRadius: 7, border: '1px solid #e9e4ff' }} onChange={e => setReqs(l => l.map((x, j) => j === i ? { ...x, required_level: Number(e.target.value) } : x))}>
                {[1, 2, 3, 4, 5].map(l => <option key={l} value={l}>L{l} {LEVEL_LABEL[l]}</option>)}</select>
              <button type="button" className="lnd-link is-danger" onClick={() => setReqs(l => l.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <div className="lnd-actions" style={{ marginTop: 8 }}>
            <button type="button" className="pulse-btn-secondary lnd-btn-sm" disabled={!comps.some(c => c.is_active && !reqs.some(x => x.competency_id === c.id))}
              onClick={() => { const c = comps.find(x => x.is_active && !reqs.some(r => r.competency_id === x.id)); if (c) setReqs(l => [...l, { competency_id: c.id, required_level: c.expected_level || 3 }]); }}>+ Add skill</button>
            <button type="button" className="pulse-btn-primary lnd-btn-sm" onClick={save}>Save requirements</button>
          </div>
        </>)}
      </div>
      <div className="lnd-card">
        <h4 className="lnd-card-title"><span>All designations with requirements</span></h4>
        {Object.keys(byRole).length ? Object.entries(byRole).map(([r, list]) => (
          <div key={r} style={{ marginBottom: 10 }}><button type="button" className="lnd-link" onClick={() => setRole(r)}>{r}</button>
            <div className="lnd-muted">{list.map(x => `${x.competency_name} L${x.required_level}`).join(' · ')}</div></div>
        )) : <Empty>None yet. Without requirements, each skill's expected level is used.</Empty>}
      </div>
    </div>
  );
}

/* ── rate one employee ─────────────────────────────────────────── */
function RateEmployee({ employeeId, setEmployeeId }) {
  const toast = useToast();
  const [d, setD] = useState(null);
  const [vals, setVals] = useState({});
  const [err, setErr] = useState('');
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => {
    if (!employeeId) { setD(null); return; }
    api.get(`/competencies/employee/${employeeId}`).then(r => { setD(r.data); setVals({}); setErr(''); }).catch(e => setErr(errText(e)));
  }, [employeeId]);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    const list = Object.entries(vals).map(([id, v]) => ({ competency_id: Number(id), assessed_level: v.level, notes: v.notes, years_experience: v.years }));
    try { await api.post(`/competencies/employee/${employeeId}/assess`, { assessments: list }); toast.success('Ratings saved'); load(); }
    catch (e) { setErr(errText(e)); }
  };
  const rows = d ? d.competencies.filter(c => showAll || c.rating_id || c.role_required) : [];
  return (
    <div className="lnd-card">
      <div className="lnd-form" style={{ marginBottom: 12 }}>
        <label>Employee<EmployeeSelect value={employeeId} onChange={setEmployeeId} /></label>
        {d && <label className="lnd-inline" style={{ alignSelf: 'end' }}><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} /> Show every skill in the library</label>}
      </div>
      {err && <div className="lnd-error">{err}</div>}
      {!employeeId ? <Empty>Choose an employee to see and rate their skills.</Empty> : !d ? <Empty>Loading…</Empty> : (<>
        <p className="lnd-muted">{d.employee.name} · {d.employee.designation || 'no designation'}. Skills required for the designation, and skills already rated, are listed.</p>
        {rows.length ? (
          <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>Skill</th><th>Current</th><th>Needs</th><th>Source</th><th>New rating</th><th>Years</th><th>Notes</th></tr></thead>
            <tbody>{rows.map(c => {
              const v = vals[c.id] || {};
              return (
                <tr key={c.id}><td>{c.name}<div className="lnd-muted">{c.category}</div></td>
                  <td><Level level={c.assessed_level} gap={c.assessed_level ? c.assessed_level < c.required_level : !!c.role_required} /></td>
                  <td>L{c.required_level}{c.role_required ? '' : <span className="lnd-muted"> (default)</span>}</td>
                  <td>{c.source ? <>{statusLabel(c.source)}<div className="lnd-muted">{fmtDate(c.assessed_date)}</div></> : '—'}</td>
                  <td>{d.can_rate ? <div style={{ display: 'flex', gap: 3 }}>{[1, 2, 3, 4, 5].map(l => (
                    <button key={l} type="button" className={`lnd-level l${(v.level ?? c.assessed_level) === l ? l : 0}`} title={c[`level_${l}_descriptor`] || LEVEL_LABEL[l]}
                      onClick={() => setVals(x => ({ ...x, [c.id]: { ...x[c.id], level: l } }))}>{l}</button>))}</div> : '—'}</td>
                  <td>{d.can_rate ? <input type="number" min="0" max="60" step="0.5" style={{ width: 60 }} value={v.years ?? c.years_experience ?? ''} onChange={e => setVals(x => ({ ...x, [c.id]: { level: x[c.id]?.level ?? c.assessed_level, ...x[c.id], years: e.target.value } }))} /> : c.years_experience ?? '—'}</td>
                  <td>{d.can_rate ? <input style={{ width: 160 }} value={v.notes ?? ''} placeholder={c.notes || ''} onChange={e => setVals(x => ({ ...x, [c.id]: { level: x[c.id]?.level ?? c.assessed_level, ...x[c.id], notes: e.target.value } }))} /> : c.notes || '—'}</td></tr>
              );
            })}</tbody></table></div>
        ) : <Empty>Nothing rated or required yet — tick “Show every skill” to rate.</Empty>}
        {d.can_rate && <div className="lnd-actions" style={{ marginTop: 10 }}><button type="button" className="pulse-btn-primary" disabled={!Object.values(vals).some(v => v.level)} onClick={save}>Save ratings</button></div>}
      </>)}
    </div>
  );
}

/* ── gaps ──────────────────────────────────────────────────────── */
function Gaps() {
  const cats = useCategories();
  const [f, setF] = useState({ group: 'department', department: '', category: '' });
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); api.get(`/competencies/gaps${toQuery(f)}`).then(r => setRows(r.data)).catch(() => setRows([])); }, [f]);
  return (<>
    <Filters value={f} onChange={setF} fields={['department']} extra={<>
      <label>Group by<select value={f.group} onChange={e => setF(v => ({ ...v, group: e.target.value }))}><option value="department">Department</option><option value="designation">Designation</option></select></label>
      <label>Skill category<select value={f.category} onChange={e => setF(v => ({ ...v, category: e.target.value }))}><option value="">All</option>{cats.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}</select></label>
    </>} />
    <div className="lnd-card">
      {!rows ? <Empty>Loading…</Empty> : rows.length ? (<>
        <div className="lnd-card-title"><span>{rows.length} gap(s)</span><button type="button" className="lnd-link" onClick={() => downloadCsv(rows, 'skill-gaps')}>Export CSV</button></div>
        <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>{f.group === 'designation' ? 'Designation' : 'Department'}</th><th>Skill</th><th className="num">Rated</th><th className="num">Avg level</th><th className="num">Needs</th><th className="num">Below</th><th className="num">2+ levels short</th></tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}><td>{r.grp}</td><td>{r.competency}<div className="lnd-muted">{r.category}</div></td><td className="num">{r.rated}</td><td className="num">{r.avg_level}</td><td className="num">{r.avg_required}</td>
              <td className="num">{r.below_required}</td><td className="num">{r.critical ? <Pill tone="bad">{r.critical}</Pill> : 0}</td></tr>
          ))}</tbody></table></div>
        <p className="lnd-muted">Close a gap by linking a training to the skill (Trainings → Builds skill) and enrolling the people below the level.</p>
      </>) : <Empty>No gaps — or nobody rated yet.</Empty>}
    </div>
  </>);
}

export default function SkillsCompetencies() {
  const [tab, setTab] = useState('matrix');
  const [emp, setEmp] = useState('');
  return (
    <PageShell dock={<PageHero icon={Target} eyebrow="Learning Center" title="Skills & Competencies" subtitle="One skill library, one rating per person, the level each role needs" />}>
      <div className="lnd">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'matrix', label: 'Skill matrix' }, { id: 'rate', label: 'Rate an employee' }, { id: 'gaps', label: 'Gap analysis' },
          { id: 'roles', label: 'Role requirements' }, { id: 'library', label: 'Library' }]} />
        {tab === 'matrix' && <Matrix onRate={(id) => { setEmp(id); setTab('rate'); }} />}
        {tab === 'rate' && <RateEmployee employeeId={emp} setEmployeeId={setEmp} />}
        {tab === 'gaps' && <Gaps />}
        {tab === 'roles' && <RoleRequirements />}
        {tab === 'library' && <Library />}
      </div>
    </PageShell>
  );
}
