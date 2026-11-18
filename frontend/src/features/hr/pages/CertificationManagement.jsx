// frontend/src/features/hr/pages/CertificationManagement.jsx
// Certifications (2026-11-18) — the one register of who holds which
// certificate. Employee picked from a list (was a typed id), file uploaded,
// records editable / renewable / deletable, expiry real (status turns Expired
// by itself), mandatory coverage shows who is missing one.
import { useCallback, useEffect, useState } from 'react';
import { Award } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { openEmployeeFile } from '@/features/employees/shared/employeeFiles';
import { PageHero, PageShell } from '@/components/pulse-ui';
import { Filters, Pill, Empty, Tabs, Kpi, LndDialog, EmployeeSelect, useLndOptions, fmtDate, toQuery, errText, downloadCsv, today } from '@/features/hr/learning/lndUi';

function MasterForm({ cert, onClose, onSaved }) {
  const o = useLndOptions();
  const [f, setF] = useState({ name: cert?.name || '', code: cert?.code || '', issuing_body: cert?.issuing_body || '', category: cert?.category || '',
    validity_months: cert?.validity_months ?? 12, is_mandatory: !!cert?.is_mandatory, competency_id: cert?.competency_id || '', description: cert?.description || '', is_active: cert?.is_active ?? true });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    try { cert ? await api.put(`/certifications/master/${cert.id}`, f) : await api.post('/certifications/master', f); onSaved(); }
    catch (x) { setErr(errText(x)); }
  };
  return (
    <LndDialog title={cert ? 'Edit certification' : 'Add certification'} onClose={onClose} width={620} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="lnd-cert" className="pulse-btn-primary">Save</button></>}>
      <form id="lnd-cert" className="lnd-form" onSubmit={save}>
        <label className="full">Name *<input required value={f.name} onChange={set('name')} /></label>
        <label>Code<input value={f.code} onChange={set('code')} /></label>
        <label>Issuing body<input value={f.issuing_body} onChange={set('issuing_body')} /></label>
        <label>Category<select value={f.category} onChange={set('category')}><option value="">—</option>{o.categories.map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Valid for (months)<input type="number" min="0" max="600" value={f.validity_months} onChange={set('validity_months')} /><span className="hint">0 = never expires</span></label>
        <label>Proves skill<select value={f.competency_id} onChange={set('competency_id')}><option value="">—</option>{o.competencies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="lnd-inline"><input type="checkbox" checked={f.is_mandatory} onChange={set('is_mandatory')} /> Mandatory for every active employee</label>
        {cert && <label className="lnd-inline"><input type="checkbox" checked={f.is_active} onChange={set('is_active')} /> Active</label>}
        <label className="full">Description<textarea value={f.description} onChange={set('description')} /></label>
      </form>
    </LndDialog>
  );
}

function RecordForm({ record, masters, mode, onClose, onSaved }) {
  // mode: 'new' | 'edit' | 'renew'
  const [f, setF] = useState({ employee_id: record?.employee_id || '', certification_id: record?.certification_id || '',
    certificate_number: mode === 'renew' ? '' : record?.certificate_number || '', issue_date: mode === 'edit' ? record?.issue_date || '' : today(),
    expiry_date: mode === 'edit' ? record?.expiry_date || '' : '', issued_by: record?.issued_by || '', notes: mode === 'renew' ? '' : record?.notes || '', status: record?.status || 'active' });
  const [file, setFile] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF(p => ({ ...p, [k]: e.target.value }));
  const cert = masters.find(m => m.id === Number(f.certification_id));
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    const fd = new FormData();
    for (const [k, v] of Object.entries(f)) if (v !== '' && v != null) fd.append(mode === 'renew' && k === 'expiry_date' ? 'new_expiry_date' : k, v);
    if (file) fd.append('file', file);
    try {
      if (mode === 'new') await api.post('/certifications/employee', fd);
      else if (mode === 'renew') await api.post(`/certifications/employee/${record.id}/renew`, fd);
      else await api.put(`/certifications/employee/${record.id}`, fd);
      onSaved();
    } catch (x) { setErr(errText(x)); } finally { setBusy(false); }
  };
  return (
    <LndDialog title={mode === 'new' ? 'Record a certificate' : mode === 'renew' ? `Renew — ${record.cert_name}` : `Edit — ${record.cert_name}`} onClose={onClose} width={600} error={err}
      footer={<><button type="button" className="pulse-btn-secondary" onClick={onClose}>Cancel</button><button type="submit" form="lnd-rec" className="pulse-btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <form id="lnd-rec" className="lnd-form" onSubmit={save}>
        {mode === 'new' ? (<>
          <label className="full">Employee *<EmployeeSelect value={f.employee_id} onChange={v => setF(p => ({ ...p, employee_id: v }))} required /></label>
          <label className="full">Certification *<select required value={f.certification_id} onChange={set('certification_id')}><option value="">Choose…</option>
            {masters.filter(m => m.is_active).map(m => <option key={m.id} value={m.id}>{m.name}{m.issuing_body ? ` — ${m.issuing_body}` : ''}</option>)}</select></label>
        </>) : <p className="full" style={{ margin: 0 }}><strong>{record.employee_name}</strong> · {record.cert_name}</p>}
        <label>{mode === 'renew' ? 'New issue date *' : 'Issue date *'}<input type="date" required value={f.issue_date} onChange={set('issue_date')} /></label>
        <label>Expiry date<input type="date" value={f.expiry_date} min={f.issue_date} onChange={set('expiry_date')} />
          <span className="hint">{cert?.validity_months || record?.validity_months ? `Blank = issue date + ${cert?.validity_months || record?.validity_months} months` : 'Blank = never expires'}</span></label>
        <label>Certificate number<input value={f.certificate_number} onChange={set('certificate_number')} /></label>
        <label>Issued by<input value={f.issued_by} onChange={set('issued_by')} /></label>
        {mode === 'edit' && <label>Status<select value={f.status} onChange={set('status')}><option value="active">Active</option><option value="expired">Expired</option><option value="revoked">Revoked</option></select></label>}
        <label className="full">Certificate file (PDF / image, 5 MB)<input type="file" accept=".pdf,image/*" onChange={e => setFile(e.target.files?.[0] || null)} />
          {mode === 'edit' && record.certificate_url && <span className="hint">A file is attached — choosing a new one replaces it.</span>}</label>
        <label className="full">Notes<textarea value={f.notes} onChange={set('notes')} /></label>
      </form>
    </LndDialog>
  );
}

export default function CertificationManagement() {
  const toast = useToast();
  const [tab, setTab] = useState('employee');
  const [masters, setMasters] = useState([]);
  const [records, setRecords] = useState(null);
  const [cov, setCov] = useState(null);
  const [k, setK] = useState({});
  const [mf, setMf] = useState({ status: 'active', category: '', mandatory: '', q: '' });
  const [ef, setEf] = useState({ status: '', department: '', category: '', mandatory: '', certification_id: '', expiring_days: '', q: '' });
  const [cf, setCf] = useState({ department: '', status: '', certification_id: '' });
  const [dlg, setDlg] = useState(null);

  const loadMasters = useCallback(() => api.get(`/certifications/master${toQuery(mf)}`).then(r => setMasters(r.data)).catch(e => toast.error(errText(e))), [mf]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadRecords = useCallback(() => { setRecords(null); return api.get(`/certifications/employee${toQuery(ef)}`).then(r => setRecords(r.data)).catch(e => { toast.error(errText(e)); setRecords([]); }); }, [ef]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadCov = useCallback(() => api.get(`/certifications/coverage${toQuery(cf)}`).then(r => setCov(r.data)).catch(() => setCov({ rows: [], summary: {} })), [cf]);
  const loadK = useCallback(() => api.get(`/certifications/expiry-dashboard${ef.department ? `?department=${encodeURIComponent(ef.department)}` : ''}`).then(r => setK(r.data)).catch(() => {}), [ef.department]);
  useEffect(() => { loadMasters(); }, [loadMasters]);
  useEffect(() => { loadRecords(); }, [loadRecords]);
  useEffect(() => { if (tab === 'coverage') loadCov(); }, [tab, loadCov]);
  useEffect(() => { loadK(); }, [loadK]);
  const refresh = () => { loadMasters(); loadRecords(); loadK(); if (tab === 'coverage') loadCov(); };

  const confirmDelete = async () => {
    const d = dlg; setDlg(null);
    try { await api.delete(d.url); toast.success('Deleted'); refresh(); } catch (e) { toast.error(errText(e)); }
  };
  const allMasters = masters;

  return (
    <PageShell dock={<PageHero icon={Award} eyebrow="Learning Center" title="Certifications" subtitle="Who holds which certificate, what is expiring, who is missing a mandatory one"
      actions={<button type="button" className="plh-cta" onClick={() => setDlg({ type: 'record', mode: 'new' })}>+ Record certificate</button>} />}>
      <div className="lnd">
        <div className="lnd-kpis">
          <Kpi label="Active" value={k.active ?? 0} tone="good" onClick={() => { setTab('employee'); setEf(v => ({ ...v, status: 'active', expiring_days: '' })); }} />
          <Kpi label="Expiring in 30 days" value={k.expiring_30d ?? 0} tone={k.expiring_30d ? 'warn' : undefined} onClick={() => { setTab('employee'); setEf(v => ({ ...v, status: '', expiring_days: '30' })); }} />
          <Kpi label="31–60 days" value={k.expiring_60d ?? 0} onClick={() => { setTab('employee'); setEf(v => ({ ...v, status: '', expiring_days: '60' })); }} />
          <Kpi label="61–90 days" value={k.expiring_90d ?? 0} onClick={() => { setTab('employee'); setEf(v => ({ ...v, status: '', expiring_days: '90' })); }} />
          <Kpi label="Expired" value={k.expired ?? 0} tone={k.expired ? 'bad' : undefined} onClick={() => { setTab('employee'); setEf(v => ({ ...v, status: 'expired', expiring_days: '' })); }} />
          <Kpi label="Mandatory coverage" value={`${k.mandatory_coverage_pct ?? 100}%`} sub={`${k.mandatory_missing ?? 0} missing or expired`} tone={k.mandatory_missing ? 'bad' : 'good'} onClick={() => setTab('coverage')} />
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'employee', label: 'Employee certificates' }, { id: 'coverage', label: 'Mandatory coverage' }, { id: 'library', label: 'Certification library', count: masters.length }]} />

        {tab === 'employee' && (<>
          <Filters value={ef} onChange={setEf} fields={['department', 'category', 'mandatory', 'q']} onReset={() => setEf({ status: '', department: '', category: '', mandatory: '', certification_id: '', expiring_days: '', q: '' })}
            extra={<>
              <label>Status<select value={ef.status} onChange={e => setEf(v => ({ ...v, status: e.target.value }))}><option value="">Current (not renewed)</option><option value="active">Active</option><option value="expired">Expired</option><option value="revoked">Revoked</option><option value="renewed">Renewed (history)</option></select></label>
              <label>Certification<select value={ef.certification_id} onChange={e => setEf(v => ({ ...v, certification_id: e.target.value }))}><option value="">All</option>{allMasters.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
              <label>Expiring within<select value={ef.expiring_days} onChange={e => setEf(v => ({ ...v, expiring_days: e.target.value }))}><option value="">Any time</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="180">6 months</option></select></label>
            </>} />
          <div className="lnd-card">
            <div className="lnd-card-title"><span>{records?.length ?? 0} record(s)</span>
              <button type="button" className="lnd-link" onClick={() => downloadCsv(records || [], 'certificates', [{ key: 'employee_name', label: 'Employee' }, { key: 'office_id', label: 'Code' }, { key: 'department', label: 'Department' },
                { key: 'cert_name', label: 'Certification' }, { key: 'certificate_number', label: 'Number' }, { key: 'issue_date', label: 'Issued' }, { key: 'expiry_date', label: 'Expires' }, { key: 'status', label: 'Status' }])}>Export CSV</button></div>
            {!records ? <Empty>Loading…</Empty> : records.length ? (
              <div className="lnd-table-wrap"><table className="lnd-table">
                <thead><tr><th>Employee</th><th>Certification</th><th>Number</th><th>Issued</th><th>Expires</th><th className="num">Days left</th><th>Status</th><th /></tr></thead>
                <tbody>{records.map(r => (
                  <tr key={r.id}>
                    <td>{r.employee_name}<div className="lnd-muted">{r.office_id} · {r.department}</div></td>
                    <td>{r.cert_name} {r.is_mandatory && <Pill tone="bad">Mandatory</Pill>}<div className="lnd-muted">{r.issuing_body}</div></td>
                    <td>{r.certificate_number || '—'}</td><td>{fmtDate(r.issue_date)}</td><td>{r.expiry_date ? fmtDate(r.expiry_date) : 'Never'}</td>
                    <td className="num">{r.expiry_date ? (r.days_until_expiry < 0 ? <span style={{ color: 'var(--color-danger)' }}>{-r.days_until_expiry} late</span> : r.days_until_expiry) : '—'}</td>
                    <td><Pill status={r.status} /></td>
                    <td><div className="lnd-actions">
                      {r.certificate_url && <button type="button" className="lnd-link" onClick={() => openEmployeeFile(r.certificate_url)}>File</button>}
                      {['active', 'expired'].includes(r.status) && <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'record', mode: 'renew', record: r })}>Renew</button>}
                      <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'record', mode: 'edit', record: r })}>Edit</button>
                      <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'delete', url: `/certifications/employee/${r.id}`, msg: 'Delete this certificate record?' })}>Delete</button>
                    </div></td>
                  </tr>
                ))}</tbody></table></div>
            ) : <Empty>No certificates match.</Empty>}
          </div>
        </>)}

        {tab === 'coverage' && (<>
          <div className="lnd-filters">
            <label>Department<select value={cf.department} onChange={e => setCf(v => ({ ...v, department: e.target.value }))}><option value="">All</option>{[...new Set((cov?.rows || []).map(r => r.department).filter(Boolean))].map(d => <option key={d}>{d}</option>)}</select></label>
            <label>Certification<select value={cf.certification_id} onChange={e => setCf(v => ({ ...v, certification_id: e.target.value }))}><option value="">All mandatory</option>{masters.filter(m => m.is_mandatory).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
            <label>Show<select value={cf.status} onChange={e => setCf(v => ({ ...v, status: e.target.value }))}><option value="">Everyone</option><option value="missing,expired">Missing or expired</option><option value="missing">Missing</option><option value="expired">Expired</option><option value="valid">Valid</option></select></label>
            {cov?.rows?.length > 0 && <button type="button" className="lnd-link" onClick={() => downloadCsv(cov.rows, 'mandatory-certificate-coverage')}>Export CSV</button>}
          </div>
          <div className="lnd-card">
            {!cov ? <Empty>Loading…</Empty> : cov.rows.length ? (<>
              <p className="lnd-muted" style={{ marginTop: 0 }}>{cov.summary.valid} valid · {cov.summary.expired} expired · {cov.summary.missing} missing — {cov.summary.coverage_pct}% covered</p>
              <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>Employee</th><th>Department</th><th>Certification</th><th>Expiry</th><th>Status</th><th /></tr></thead>
                <tbody>{cov.rows.map((r, i) => (
                  <tr key={i}><td>{r.employee_name}<div className="lnd-muted">{r.office_id}</div></td><td>{r.department}</td><td>{r.cert_name}</td><td>{fmtDate(r.expiry_date)}</td><td><Pill status={r.status} /></td>
                    <td>{r.status === 'missing' && <button type="button" className="lnd-link" onClick={() => setDlg({ type: 'record', mode: 'new', record: { employee_id: r.employee_id, certification_id: r.certification_id } })}>Record</button>}</td></tr>
                ))}</tbody></table></div>
            </>) : <Empty>No mandatory certifications. Tick “Mandatory” on a certification in the library to track coverage.</Empty>}
          </div>
        </>)}

        {tab === 'library' && (<>
          <Filters value={mf} onChange={setMf} fields={['category', 'mandatory', 'q']} onReset={() => setMf({ status: 'active', category: '', mandatory: '', q: '' })}
            extra={<label>Status<select value={mf.status} onChange={e => setMf(v => ({ ...v, status: e.target.value }))}><option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option></select></label>} />
          <div className="lnd-card">
            <div className="lnd-card-title"><span>Library</span><button type="button" className="pulse-btn-primary lnd-btn-sm" onClick={() => setDlg({ type: 'master' })}>+ Add certification</button></div>
            {masters.length ? (
              <div className="lnd-table-wrap"><table className="lnd-table"><thead><tr><th>Name</th><th>Code</th><th>Issuing body</th><th>Category</th><th>Validity</th><th>Proves skill</th><th className="num">Holders</th><th /></tr></thead>
                <tbody>{masters.map(m => (
                  <tr key={m.id}><td>{m.name} {m.is_mandatory && <Pill tone="bad">Mandatory</Pill>} {!m.is_active && <Pill>Inactive</Pill>}</td><td>{m.code || '—'}</td><td>{m.issuing_body || '—'}</td>
                    <td>{m.category || '—'}</td><td>{m.validity_months ? `${m.validity_months} months` : 'Never expires'}</td><td>{m.competency_name || '—'}</td>
                    <td className="num">{m.active_holders}</td>
                    <td><div className="lnd-actions"><button type="button" className="lnd-link" onClick={() => setDlg({ type: 'master', cert: m })}>Edit</button>
                      <button type="button" className="lnd-link is-danger" onClick={() => setDlg({ type: 'delete', url: `/certifications/master/${m.id}`, msg: m.total_records ? `${m.total_records} records use it — it cannot be deleted. Deactivate it with Edit instead.` : 'Delete this certification?' })}>Delete</button></div></td></tr>
                ))}</tbody></table></div>
            ) : <Empty>No certifications in the library yet.</Empty>}
          </div>
        </>)}
      </div>
      {dlg?.type === 'master' && <MasterForm cert={dlg.cert} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); toast.success('Saved'); refresh(); }} />}
      {dlg?.type === 'record' && <RecordForm mode={dlg.mode} record={dlg.record} masters={allMasters} onClose={() => setDlg(null)} onSaved={() => { setDlg(null); toast.success('Saved'); refresh(); }} />}
      <ConfirmDialog open={dlg?.type === 'delete'} title="Delete" message={dlg?.msg} confirmLabel="Delete" variant="danger" onConfirm={confirmDelete} onCancel={() => setDlg(null)} />
    </PageShell>
  );
}
