// Visitor form — four uses:
//   checkin      a walk-in, registered for security       POST /visitors (approve_and_check_in for security)
//   preregister  an expected visitor                      POST /visitors { pre_register: true }
//   edit         an expected or inside visitor            PUT  /visitors/:id
//   arrive       an approved visitor reaches the gate     PUT  /visitors/:id/check-in ({ approve } for security)
// §273: no visitor enters until security has approved the visit.
// The ID number is masked by the server before it is stored; once saved only
// the last 4 characters are ever shown. Leaving the field empty on an edit or
// arrival keeps what is on file.
import { useState } from 'react';
import api from '@/services/api/client';
import { S, errText, phoneProblem, fmtStamp } from '../biometric/biometricShared';
import { EmployeeSelect } from '../biometric/biometricUi';
import { ID_TYPES, ID_HINT, toIso, toLocalInput, localIn } from './gateShared';
import { Modal } from './gateUi';

const TITLES = { checkin: 'Register a walk-in visitor', preregister: 'Pre-register a visitor', edit: 'Edit visitor', arrive: 'Visitor has arrived' };
const SUBMIT = { checkin: 'Register for approval', preregister: 'Pre-register', edit: 'Save changes', arrive: 'Check in now' };

export default function VisitorForm({ mode, initial = null, canPickHost, employees = [], canLookup = false, canApproveNow = false, onSaved, onCancel }) {
  // Security at the gate may approve and check in in one step (walk-in, or an
  // arrival not yet approved).
  const offerApprove = canApproveNow && (mode === 'checkin' || (mode === 'arrive' && !initial?.approved_at));
  const [approveNow, setApproveNow] = useState(offerApprove);
  const [f, setF] = useState(() => ({
    name: initial?.name || '', company: initial?.company || '', phone: initial?.phone || '', email: initial?.email || '',
    host_employee_id: initial?.host_employee_id ? String(initial.host_employee_id) : '', purpose: initial?.purpose || '',
    id_type: initial?.id_type || '', id_number: '', vehicle_number: initial?.vehicle_number || '',
    visitor_count: String(initial?.visitor_count || 1),
    expected_at: initial?.expected_at ? toLocalInput(initial.expected_at) : mode === 'preregister' ? localIn(24) : '',
  }));
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [returning, setReturning] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const expectedVisit = mode === 'preregister' || (mode === 'edit' && initial && !initial.check_in_time);
  const idOnFile = initial?.id_number || returning?.id_number_on_file || null;

  const lookup = async () => {
    if (!canLookup || mode !== 'checkin' || f.name.trim()) return;
    if (String(f.phone).replace(/\D/g, '').length < 10) return;
    try {
      const res = await api.get('/visitors/lookup', { params: { phone: f.phone } });
      if (!res.data?.found) { setReturning(null); return; }
      setReturning(res.data);
      setF((x) => ({
        ...x, name: x.name || res.data.name || '', company: x.company || res.data.company || '', email: x.email || res.data.email || '',
        id_type: x.id_type || res.data.id_type || '', vehicle_number: x.vehicle_number || res.data.vehicle_number || '',
      }));
    } catch { /* lookup is a convenience; ignore failures */ }
  };

  const submit = async (e) => {
    e.preventDefault();
    const p = [];
    if (!f.name.trim()) p.push('Enter the visitor’s name.');
    const phone = phoneProblem(f.phone);
    if (phone) p.push(phone);
    if (f.id_number.trim() && !f.id_type) p.push('Choose the ID type for the ID number.');
    if (expectedVisit && !f.expected_at) p.push('Enter when the visitor is expected.');
    if (mode === 'preregister' && canPickHost && !f.host_employee_id) p.push('Choose who the visitor is meeting.');
    const n = Number(f.visitor_count);
    if (!Number.isInteger(n) || n < 1 || n > 100) p.push('Number of people must be between 1 and 100.');
    setErrors(p);
    if (p.length) return;

    const body = {
      name: f.name.trim(), company: f.company.trim(), phone: f.phone.trim(), email: f.email.trim(), purpose: f.purpose.trim(),
      id_type: f.id_type, vehicle_number: f.vehicle_number.trim(), visitor_count: n,
      ...(canPickHost ? { host_employee_id: f.host_employee_id } : {}),
      ...(f.id_number.trim() ? { id_number: f.id_number.trim() } : mode === 'checkin' || mode === 'preregister' ? { id_number: '' } : {}),
      ...(expectedVisit ? { expected_at: toIso(f.expected_at) } : {}),
    };
    setSaving(true);
    try {
      let res;
      if (mode === 'checkin') res = await api.post('/visitors', approveNow && offerApprove ? { ...body, approve_and_check_in: true } : body);
      else if (mode === 'preregister') res = await api.post('/visitors', { ...body, pre_register: true });
      else if (mode === 'arrive') res = await api.put(`/visitors/${initial.id}/check-in`, offerApprove ? { ...body, approve: true } : body);
      else res = await api.put(`/visitors/${initial.id}`, body);
      onSaved(res.data);
    } catch (err) {
      setErrors(err.response?.data?.errors || [errText(err, 'Could not save the visitor')]);
    } finally { setSaving(false); }
  };

  return (
    <Modal title={TITLES[mode]} onClose={onCancel} busy={saving} width={640}>
      <form onSubmit={submit} noValidate data-testid="visitor-form">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
          <div>
            <label style={S.label} htmlFor="vf-phone">Contact number</label>
            <input id="vf-phone" type="tel" maxLength={20} value={f.phone} onChange={(e) => set('phone', e.target.value)} onBlur={lookup} style={S.input} />
          </div>
          <div>
            <label style={S.label} htmlFor="vf-name">Visitor name *</label>
            <input id="vf-name" maxLength={200} value={f.name} onChange={(e) => set('name', e.target.value)} style={S.input} />
          </div>
          <div>
            <label style={S.label} htmlFor="vf-company">Company</label>
            <input id="vf-company" maxLength={200} value={f.company} onChange={(e) => set('company', e.target.value)} style={S.input} />
          </div>
          <div>
            <label style={S.label} htmlFor="vf-email">Email</label>
            <input id="vf-email" type="email" maxLength={200} value={f.email} onChange={(e) => set('email', e.target.value)} style={S.input} />
          </div>
          {canPickHost && (
            <div>
              <label style={S.label} htmlFor="vf-host">Host employee{mode === 'preregister' ? ' *' : ''}</label>
              <EmployeeSelect id="vf-host" employees={employees} value={f.host_employee_id} onChange={(v) => set('host_employee_id', v)} placeholder="No host" />
            </div>
          )}
          <div>
            <label style={S.label} htmlFor="vf-count">People</label>
            <input id="vf-count" type="number" min="1" max="100" value={f.visitor_count} onChange={(e) => set('visitor_count', e.target.value)} style={S.input} />
          </div>
          {expectedVisit && (
            <div>
              <label style={S.label} htmlFor="vf-expected">Expected at *</label>
              <input id="vf-expected" type="datetime-local" value={f.expected_at} onChange={(e) => set('expected_at', e.target.value)} style={S.input} />
            </div>
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label} htmlFor="vf-purpose">Purpose</label>
            <input id="vf-purpose" maxLength={1000} value={f.purpose} onChange={(e) => set('purpose', e.target.value)} style={S.input} />
          </div>
          <div>
            <label style={S.label} htmlFor="vf-idtype">ID type</label>
            <select id="vf-idtype" value={f.id_type} onChange={(e) => set('id_type', e.target.value)} style={S.input}>
              <option value="">None shown</option>
              {ID_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={S.label} htmlFor="vf-idno">ID number</label>
            <input id="vf-idno" maxLength={30} autoComplete="off" value={f.id_number} onChange={(e) => set('id_number', e.target.value)} style={S.input}
              placeholder={idOnFile ? `On file: ${idOnFile}` : f.id_type ? ID_HINT[f.id_type] : ''} />
          </div>
          <div>
            <label style={S.label} htmlFor="vf-vehicle">Vehicle number</label>
            <input id="vf-vehicle" maxLength={30} value={f.vehicle_number} onChange={(e) => set('vehicle_number', e.target.value.toUpperCase())} style={S.input} />
          </div>
        </div>
        {offerApprove && mode === 'checkin' && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, fontSize: 13, color: '#4c1d95', fontWeight: 600 }}>
            <input type="checkbox" checked={approveNow} onChange={(e) => setApproveNow(e.target.checked)} />
            Approve entry and check in now (security)
          </label>
        )}
        {offerApprove && mode === 'arrive' && (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: '#4c1d95' }}>Not yet approved — saving approves entry as security and checks the visitor in.</p>
        )}
        {returning && (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: '#0f766e' }} data-testid="returning">
            Returning visitor — {returning.visits} earlier visit{returning.visits === 1 ? '' : 's'}, last {fmtStamp(returning.last_visit_at)}. Details filled in; check them.
          </p>
        )}
        <p style={{ margin: '10px 0 0', fontSize: 12, color: '#6b7280' }}>
          Only the last 4 characters of the ID number are kept.
          {mode === 'arrive' || (mode === 'checkin' && approveNow && offerApprove) ? ' Check-in time is recorded when you save, and the host is notified.' : ''}
          {mode === 'checkin' && !(approveNow && offerApprove) ? ' Security is notified and must approve entry before the visitor is checked in.' : ''}
          {mode === 'preregister' ? ' Security approves the visit; the gate checks them in on arrival.' : ''}
        </p>
        {errors.length > 0 && (
          <ul role="alert" style={{ margin: '10px 0 0', paddingLeft: 18, color: '#b91c1c', fontSize: 13 }}>
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} disabled={saving} style={S.secondary}>Cancel</button>
          <button type="submit" disabled={saving} style={{ ...S.primary, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : mode === 'checkin' && approveNow && offerApprove ? 'Approve & check in' : mode === 'arrive' && offerApprove ? 'Approve & check in' : SUBMIT[mode]}</button>
        </div>
      </form>
    </Modal>
  );
}
