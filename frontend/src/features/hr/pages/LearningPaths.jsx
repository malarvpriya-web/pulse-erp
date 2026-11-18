// frontend/src/features/hr/pages/LearningPaths.jsx
// Learning paths (2026-11-18): ordered trainings for a role, department or new
// joiner. Prerequisites, "assign on joining" for onboarding, days to complete,
// assign / unassign, progress with overdue flags, filters.
import { useCallback, useEffect, useState } from 'react';
import { Route } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { Filters, Pill, Empty, LndDialog, EmployeePicker, useLndOptions, fmtDate, fmtNum, toQuery, errText, statusLabel, downloadCsv } from '@/features/hr/learning/lndUi';

const TYPES = ['role', 'onboarding', 'upskilling', 'compliance', 'leadership'];
const DEFAULT = { path_type: '', target_department: '', target_role: '', q: '' };

function PathForm({ path, onClose, onSaved }) {
  const o = useLndOptions();
  const [f, setF] = useState({ name: path?.name || '', path_type: path?.path_type || 'role', description: path?.description || '',
    target_role: path?.target_role || '', target_department: path?.target_department || '', due_days: path?.due_days || '', auto_assign_on_join: !!path?.auto_assign_on_join });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try { const r = path ? await api.put(`/learning-paths/${path.id}`, f) : await api.post('/learning-paths', f); onSaved(r.data); }
    catch (x) { setErr(errText(x)); }
  };
  return (
    <LndDialog title={path ? 'Edit learning path' : 'New learning path'} onClose={onClose} width={620} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="lnd-path" className="pulse-btn-primary">Save</button></>}>
      <form id="lnd-path" className="lnd-form" onSubmit={save}>
        <label className="full">Name *<input required value={f.name} onChange={set('name')} /></label>
        <label>Type<select value={f.path_type} onChange={set('path_type')}>{TYPES.map(t => <option key={t} value={t}>{statusLabel(t)}</option>)}</select></label>
        <label>Days to complete<input type="number" min="1" max="730" value={f.due_days} onChange={set('due_days')} placeholder="No deadline" /></label>
        <label>For department<select value={f.target_department} onChange={set('target_department')}><option value="">Any</option>{o.departments.map(d => <option key={d}>{d}</option>)}</select></label>
        <label>For designation<select value={f.target_role} onChange={set('target_role')}><option value="">Any</option>{o.designations.map(d => <option key={d}>{d}</option>)}</select></label>
        <label className="lnd-inline full"><input type="checkbox" checked={f.auto_assign_on_join} onChange={set('auto_assign_on_join')} />
          Assign automatically to every new joiner who matches the department / designation</label>
        <label className="full">Description<textarea value={f.description} onChange={set('description')} /></label>
      </form>
    </LndDialog>
  );
}

function ItemsEditor({ path, onClose, onSaved }) {
  const toast = useToast();
  const [programs, setPrograms] = useState([]);
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get('/training/programs?status=planned,ongoing,completed').then(r => setPrograms(r.data)).catch(() => {});
    api.get(`/learning-paths/${path.id}`).then(r => setItems(r.data.items.map(i => ({ program_id: i.program_id, title: i.title, is_mandatory: i.is_mandatory,
      prerequisite_program_id: i.prerequisite_program_id || '', scheduled_date: i.scheduled_date })))).catch(e => setErr(errText(e)));
  }, [path.id]);
  const move = (i, d) => setItems(list => { const n = [...list]; const j = i + d; if (j < 0 || j >= n.length) return n; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const save = async () => {
    try {
      const r = await api.put(`/learning-paths/${path.id}/items`, { items: items.map(i => ({ program_id: i.program_id, is_mandatory: i.is_mandatory, prerequisite_program_id: i.prerequisite_program_id || null })) });
      toast.success(`Saved${r.data.new_enrolments ? ` — ${r.data.new_enrolments} new enrolment(s) for people already on the path` : ''}`);
      onSaved();
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <LndDialog title={`Trainings in ${path.name}`} onClose={onClose} width={780} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="pulse-btn-primary" disabled={!items} onClick={save}>Save</button></>}>
      {!items ? <Empty>Loading…</Empty> : (<>
        <div className="lnd-form" style={{ marginBottom: 12 }}>
          <label className="full">Add a training<select value="" onChange={e => {
            const p = programs.find(x => x.id === Number(e.target.value));
            if (p) setItems(l => [...l, { program_id: p.id, title: p.title, is_mandatory: true, prerequisite_program_id: '', scheduled_date: p.scheduled_date }]);
          }}><option value="">Choose…</option>{programs.filter(p => !items.some(i => i.program_id === p.id)).map(p => <option key={p.id} value={p.id}>{p.title} — {fmtDate(p.scheduled_date)}</option>)}</select></label>
        </div>
        {items.length ? (
          <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>#</th><th>Training</th><th>Mandatory</th><th>Needs first</th><th /></tr></thead>
            <tbody>{items.map((it, i) => (
              <tr key={it.program_id}><td>{i + 1}</td><td>{it.title}<div className="lnd-muted">{fmtDate(it.scheduled_date)}</div></td>
                <td><input type="checkbox" checked={it.is_mandatory} onChange={e => setItems(l => l.map((x, j) => j === i ? { ...x, is_mandatory: e.target.checked } : x))} /></td>
                <td><select value={it.prerequisite_program_id || ''} onChange={e => setItems(l => l.map((x, j) => j === i ? { ...x, prerequisite_program_id: e.target.value ? Number(e.target.value) : '' } : x))}>
                  <option value="">—</option>{items.slice(0, i).map(p => <option key={p.program_id} value={p.program_id}>{p.title}</option>)}</select></td>
                <td><div className="lnd-actions"><button type="button" className="lnd-link" onClick={() => move(i, -1)} disabled={!i}>↑</button>
                  <button type="button" className="lnd-link" onClick={() => move(i, 1)} disabled={i === items.length - 1}>↓</button>
                  <button type="button" className="lnd-link is-danger" onClick={() => setItems(l => l.filter((_, j) => j !== i).map(x => x.prerequisite_program_id === it.program_id ? { ...x, prerequisite_program_id: '' } : x))}>Remove</button></div></td></tr>
            ))}</tbody></table>
        ) : <Empty>No trainings yet.</Empty>}
        <p className="lnd-muted">A prerequisite must be completed before the later training can be marked complete for someone on this path.</p>
      </>)}
    </LndDialog>
  );
}

function AssignDialog({ path, onClose, onDone }) {
  const toast = useToast();
  const [ids, setIds] = useState([]);
  const [due, setDue] = useState('');
  const [err, setErr] = useState('');
  const save = async () => {
    try { const r = await api.post(`/learning-paths/${path.id}/assign`, { employee_ids: ids, due_date: due || undefined }); toast.success(r.data.message); onDone(); }
    catch (e) { setErr(errText(e)); }
  };
  return (
    <LndDialog title={`Assign ${path.name}`} onClose={onClose} width={620} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="pulse-btn-primary" disabled={!ids.length} onClick={save}>Assign {ids.length || ''}</button></>}>
      <EmployeePicker value={ids} onChange={setIds} />
      <div className="lnd-form" style={{ marginTop: 12 }}>
        <label>Due date<input type="date" value={due} onChange={e => setDue(e.target.value)} />
          <span className="hint">{path.due_days ? `Blank = ${path.due_days} days from today` : 'Blank = no deadline'}</span></label>
      </div>
      <p className="lnd-muted">Each person is enrolled in every planned or running training on the path, and notified.</p>
    </LndDialog>
  );
}

function ProgressDialog({ path, onClose }) {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('');
  const [un, setUn] = useState(null);
  const load = useCallback(() => api.get(`/learning-paths/${path.id}/progress${status ? `?status=${status}` : ''}`).then(r => setRows(r.data)).catch(() => setRows([])), [path.id, status]);
  useEffect(() => { load(); }, [load]);
  const unassign = async () => {
    const id = un; setUn(null);
    try { await api.delete(`/learning-paths/${path.id}/assign/${id}`); toast.success('Unassigned'); load(); } catch (e) { toast.error(errText(e)); }
  };
  return (
    <LndDialog title={`Progress — ${path.name}`} onClose={onClose} width={860}>
      <div className="lnd-actions" style={{ marginBottom: 10 }}>
        <select value={status} onChange={e => setStatus(e.target.value)} style={{ padding: '6px 8px', borderRadius: 7, border: '1px solid #e9e4ff' }}>
          <option value="">Assigned (all)</option><option value="in_progress">In progress</option><option value="overdue">Overdue</option><option value="completed">Completed</option><option value="withdrawn">Withdrawn</option></select>
        {rows?.length > 0 && <button type="button" className="lnd-link" onClick={() => downloadCsv(rows, `path-${path.id}-progress`)}>Export CSV</button>}
      </div>
      {!rows ? <Empty>Loading…</Empty> : rows.length ? (
        <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Employee</th><th>Progress</th><th>Assigned</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id}><td>{r.employee_name}<div className="lnd-muted">{r.office_id} · {r.department}</div></td>
              <td><div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><div className="lnd-bar" style={{ width: 110 }}><span style={{ width: `${r.progress_pct}%` }} /></div>{r.completed_items}/{r.total_items}</div></td>
              <td>{fmtDate(r.assigned_date)}</td><td>{fmtDate(r.due_date)}</td>
              <td>{r.overdue ? <Pill status="overdue" /> : <Pill status={r.status} />}</td>
              <td>{r.status === 'in_progress' && <button type="button" className="lnd-link is-danger" onClick={() => setUn(r.employee_id)}>Unassign</button>}</td></tr>
          ))}</tbody></table>
      ) : <Empty>Nobody here.</Empty>}
      <ConfirmDialog open={!!un} title="Unassign" message="Remove this person from the path? Their path trainings that have not started are withdrawn; completed ones stay." confirmLabel="Unassign" variant="warning" onConfirm={unassign} onCancel={() => setUn(null)} />
    </LndDialog>
  );
}

export default function LearningPaths() {
  const toast = useToast();
  const o = useLndOptions();
  const [f, setF] = useState(DEFAULT);
  const [paths, setPaths] = useState(null);
  const [dlg, setDlg] = useState(null);
  const load = useCallback(() => api.get(`/learning-paths${toQuery(f)}`).then(r => setPaths(r.data)).catch(e => { toast.error(errText(e)); setPaths([]); }), [f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const archive = async () => {
    const id = dlg.id; setDlg(null);
    try { await api.delete(`/learning-paths/${id}`); toast.success('Archived'); load(); } catch (e) { toast.error(errText(e)); }
  };
  return (
    <PageShell dock={<PageHero icon={Route} eyebrow="Learning Center" title="Learning Paths" subtitle="Step-by-step journeys for roles, departments and new joiners"
      actions={<button type="button" className="plh-cta" onClick={() => setDlg({ type: 'form' })}>+ New path</button>} />}>
      <div className="lnd">
        <Filters value={f} onChange={setF} fields={['q']} onReset={() => setF(DEFAULT)} extra={<>
          <label>Type<select value={f.path_type} onChange={e => setF(v => ({ ...v, path_type: e.target.value }))}><option value="">All types</option>{TYPES.map(t => <option key={t} value={t}>{statusLabel(t)}</option>)}</select></label>
          <label>Department<select value={f.target_department} onChange={e => setF(v => ({ ...v, target_department: e.target.value }))}><option value="">All</option>{o.departments.map(d => <option key={d}>{d}</option>)}</select></label>
          <label>Designation<select value={f.target_role} onChange={e => setF(v => ({ ...v, target_role: e.target.value }))}><option value="">All</option>{o.designations.map(d => <option key={d}>{d}</option>)}</select></label>
        </>} />
        {!paths ? <Empty>Loading…</Empty> : paths.length ? (
          <div className="lnd-grid lnd-grid-3">
            {paths.map(p => (
              <div key={p.id} className="lnd-card" style={{ margin: 0 }}>
                <div className="lnd-card-title"><span>{p.name}</span><Pill tone="brand">{statusLabel(p.path_type)}</Pill></div>
                {p.description && <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>{p.description}</p>}
                <div className="lnd-muted" style={{ marginBottom: 8 }}>
                  {[p.target_department, p.target_role].filter(Boolean).join(' · ') || 'Everyone'}{p.due_days ? ` · ${p.due_days} days` : ''}{p.auto_assign_on_join ? ' · auto on joining' : ''}
                </div>
                <div style={{ display: 'flex', gap: 14, fontSize: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                  <span><strong>{p.total_items || 0}</strong> trainings · {fmtNum(p.total_hours, 1)} h</span>
                  <span><strong>{p.assigned || 0}</strong> assigned</span><span><strong>{p.completed || 0}</strong> done</span>
                  {p.overdue > 0 && <Pill status="overdue">{p.overdue} overdue</Pill>}
                </div>
                <div className="lnd-actions">
                  <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => setDlg({ type: 'items', path: p })}>Trainings</button>
                  <button type="button" className="pulse-btn-primary lnd-btn-sm" disabled={!p.total_items} title={p.total_items ? '' : 'Add trainings first'} onClick={() => setDlg({ type: 'assign', path: p })}>Assign</button>
                  <button type="button" className="pulse-btn-secondary lnd-btn-sm" onClick={() => setDlg({ type: 'progress', path: p })}>Progress</button>
                  <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'form', path: p })}>Edit</button>
                  <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'archive', id: p.id })}>Archive</button>
                </div>
              </div>
            ))}
          </div>
        ) : <Empty>No learning paths yet. Create one, add trainings, then assign it.</Empty>}
      </div>
      {dlg?.type === 'form' && <PathForm path={dlg.path} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); toast.success('Saved'); load(); }} />}
      {dlg?.type === 'items' && <ItemsEditor path={dlg.path} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); load(); }} />}
      {dlg?.type === 'assign' && <AssignDialog path={dlg.path} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); }} />}
      {dlg?.type === 'progress' && <ProgressDialog path={dlg.path} onClose={() => { setDlg(null); load(); }} />}
      <ConfirmDialog open={dlg?.type === 'archive'} title="Archive path" message="Archive this learning path? Progress records stay." confirmLabel="Archive" variant="warning" onConfirm={archive} onCancel={() => setDlg(null)} />
    </PageShell>
  );
}
