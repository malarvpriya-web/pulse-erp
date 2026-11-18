// frontend/src/features/hr/pages/TrainerManagement.jsx
// Trainers (2026-11-18) — a tab of L&D Setup. The list a training's trainer is
// chosen from; internal trainers are picked employees. Programme counts,
// people trained and ratings are computed from real trainings.
import { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { Pill, Empty, LndDialog, EmployeeSelect, resetLndOptions, fmtDate, toQuery, errText, downloadCsv } from '@/features/hr/learning/lndUi';

function TrainerForm({ trainer, onClose, onSaved }) {
  const [f, setF] = useState({ name: trainer?.name || '', trainer_type: trainer?.trainer_type || 'internal', employee_id: trainer?.employee_id || '',
    email: trainer?.email || '', phone: trainer?.phone || '', specialization: trainer?.specialization || '', is_active: trainer?.is_active ?? true });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try { trainer ? await api.put(`/trainers/${trainer.id}`, f) : await api.post('/trainers', f); resetLndOptions(); onSaved(); }
    catch (x) { setErr(errText(x)); }
  };
  return (
    <LndDialog title={trainer ? 'Edit trainer' : 'Add trainer'} onClose={onClose} width={560} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="lnd-trn" className="pulse-btn-primary">Save</button></>}>
      <form id="lnd-trn" className="lnd-form" onSubmit={save}>
        <label>Type<select value={f.trainer_type} onChange={set('trainer_type')}><option value="internal">Internal (employee)</option><option value="external">External</option></select></label>
        {f.trainer_type === 'internal'
          ? <label>Employee *<EmployeeSelect value={f.employee_id} onChange={v => setF(p => ({ ...p, employee_id: v }))} required /></label>
          : <label>Name *<input required value={f.name} onChange={set('name')} /></label>}
        {f.trainer_type === 'internal' && <label>Display name<input value={f.name} onChange={set('name')} placeholder="Blank = employee name" /></label>}
        <label>Email<input type="email" value={f.email} onChange={set('email')} /></label>
        <label>Phone<input value={f.phone} onChange={set('phone')} /></label>
        <label className="full">Specialisation<input value={f.specialization} onChange={set('specialization')} placeholder="e.g. Fire safety, PLC programming" /></label>
        {trainer && <label className="lnd-inline"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} /> Active</label>}
      </form>
    </LndDialog>
  );
}

function TrainerPrograms({ trainer, onClose }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get(`/trainers/${trainer.id}/programs`).then(r => setRows(r.data)).catch(() => setRows([])); }, [trainer.id]);
  return (
    <LndDialog title={`Trainings by ${trainer.name}`} onClose={onClose} width={720}>
      {!rows ? <Empty>Loading…</Empty> : rows.length ? (
        <table className="lnd-table" style={{ width: '100%' }}><thead><tr><th>Date</th><th>Training</th><th>Status</th><th className="num">Enrolled</th><th className="num">Done</th><th className="num">Rating</th></tr></thead>
          <tbody>{rows.map(p => <tr key={p.id}><td>{fmtDate(p.scheduled_date)}</td><td>{p.title}</td><td><Pill status={p.status} /></td>
            <td className="num">{p.enrolled_count}</td><td className="num">{p.completed_count}</td><td className="num">{p.avg_rating ?? '—'}</td></tr>)}</tbody></table>
      ) : <Empty>No trainings yet.</Empty>}
    </LndDialog>
  );
}

export function TrainersPanel() {
  const toast = useToast();
  const [f, setF] = useState({ status: 'active', trainer_type: '', q: '' });
  const [rows, setRows] = useState(null);
  const [dlg, setDlg] = useState(null);
  const load = useCallback(() => api.get(`/trainers${toQuery(f)}`).then(r => setRows(r.data)).catch(e => { toast.error(errText(e)); setRows([]); }), [f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  const deactivate = async () => {
    const id = dlg.id; setDlg(null);
    try { await api.delete(`/trainers/${id}`); toast.success('Deactivated'); resetLndOptions(); load(); } catch (e) { toast.error(errText(e)); }
  };
  return (
    <div className="lnd">
      <div className="lnd-filters">
        <label>Type<select value={f.trainer_type} onChange={e => setF(v => ({ ...v, trainer_type: e.target.value }))}><option value="">All</option><option value="internal">Internal</option><option value="external">External</option></select></label>
        <label>Status<select value={f.status} onChange={e => setF(v => ({ ...v, status: e.target.value }))}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></label>
        <label>Search<input type="search" value={f.q} onChange={e => setF(v => ({ ...v, q: e.target.value }))} placeholder="Name, specialisation, email" /></label>
        <button type="button" className="pulse-btn-primary lnd-btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setDlg({ type: 'form' })}>+ Add trainer</button>
      </div>
      <div className="lnd-card">
        <div className="lnd-card-title"><span>{rows?.length ?? 0} trainer(s)</span>{rows?.length > 0 && <button type="button" className="lnd-link" onClick={() => downloadCsv(rows, 'trainers')}>Export CSV</button>}</div>
        {!rows ? <Empty>Loading…</Empty> : rows.length ? (
          <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>Trainer</th><th>Type</th><th>Specialisation</th><th>Contact</th><th className="num">Trainings</th><th className="num">People trained</th><th className="num">Rating</th><th>Last</th><th /></tr></thead>
            <tbody>{rows.map(t => (
              <tr key={t.id}><td>{t.name} {!t.is_active && <Pill>Inactive</Pill>}{t.trainer_type === 'internal' && t.office_id && <div className="lnd-muted">{t.office_id} · {t.department}</div>}</td>
                <td><Pill tone={t.trainer_type === 'internal' ? 'brand' : 'info'}>{t.trainer_type}</Pill></td><td>{t.specialization || '—'}</td>
                <td>{[t.email, t.phone].filter(Boolean).join(' · ') || '—'}</td><td className="num">{t.programs_count}</td><td className="num">{t.employees_trained}</td>
                <td className="num">{t.avg_rating ?? '—'}</td><td>{fmtDate(t.last_program_date)}</td>
                <td><div className="lnd-actions"><button type="button" className="lnd-link" onClick={() => setDlg({ type: 'programs', trainer: t })}>Trainings</button>
                  <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'form', trainer: t })}>Edit</button>
                  {t.is_active && <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'off', id: t.id })}>Deactivate</button>}</div></td></tr>
            ))}</tbody></table></div>
        ) : <Empty>No trainers yet.</Empty>}
      </div>
      {dlg?.type === 'form' && <TrainerForm trainer={dlg.trainer} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); toast.success('Saved'); load(); }} />}
      {dlg?.type === 'programs' && <TrainerPrograms trainer={dlg.trainer} onClose={() => setDlg(null)} />}
      <ConfirmDialog open={dlg?.type === 'off'} title="Deactivate trainer" message="Deactivate this trainer? Past trainings keep their name; new trainings cannot choose them." confirmLabel="Deactivate" variant="warning" onConfirm={deactivate} onCancel={() => setDlg(null)} />
    </div>
  );
}

export default function TrainerManagement({ embedded }) {
  if (embedded) return <TrainersPanel />;
  return <PageShell dock={<PageHero icon={Users} eyebrow="Learning Center" title="Trainers" subtitle="Internal and external trainers" />}><TrainersPanel /></PageShell>;
}
