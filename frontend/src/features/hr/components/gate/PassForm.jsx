// Create or edit a gate pass — a person pass or a material (goods) pass.
// The server re-validates everything (validateGatePass in gateAccess.routes.js);
// the checks here only spare a round trip for the common mistakes.
import { useState } from 'react';
import api from '@/services/api/client';
import { S, errText } from '../biometric/biometricShared';
import { EmployeeSelect } from '../biometric/biometricUi';
import { CATEGORIES, toIso, toLocalInput, localIn } from './gateShared';
import { Modal } from './gateUi';

const UNITS = ['Nos', 'Set', 'Kg', 'g', 'm', 'mm', 'L', 'Box', 'Pack', 'Roll', 'Pair', 'Lot'];
const blankItem = () => ({ description: '', item_code: '', quantity: '', unit: 'Nos', remarks: '' });

function initialForm(passType, initial, visitor) {
  if (initial) {
    return {
      employee_id: initial.employee_id ? String(initial.employee_id) : '',
      category: initial.category || '',
      purpose: initial.purpose || '',
      valid_from: toLocalInput(initial.valid_from),
      valid_to: toLocalInput(initial.valid_to),
      returnable: initial.returnable == null ? '' : String(initial.returnable),
      expected_return_at: toLocalInput(initial.expected_return_at),
      vehicle_number: initial.vehicle_number || '',
      carried_by: initial.carried_by || '',
      destination: initial.destination || '',
      items: (initial.items || []).map((it) => ({
        description: it.description, item_code: it.item_code || '', quantity: String(it.quantity), unit: it.unit, remarks: it.remarks || '',
      })),
    };
  }
  return {
    employee_id: '', category: '', purpose: '',
    valid_from: passType === 'person' ? localIn(0) : '', valid_to: passType === 'person' ? localIn(2) : '',
    returnable: '', expected_return_at: '', vehicle_number: visitor?.vehicle_number || '',
    carried_by: visitor ? `${visitor.name}${visitor.company ? ` (${visitor.company})` : ''}` : '',
    destination: visitor ? visitor.company || 'Leaves with the visitor' : '',
    items: passType === 'material' ? [blankItem()] : [],
  };
}

function problems(f, passType) {
  const out = [];
  if (!f.purpose.trim()) out.push(passType === 'material' ? 'Say why the goods are leaving.' : 'Give the reason for the pass.');
  const from = f.valid_from ? new Date(f.valid_from) : null;
  const to = f.valid_to ? new Date(f.valid_to) : null;
  if (passType === 'person') {
    if (!f.category) out.push('Choose the type of pass.');
    if (!from) out.push('Enter when the employee leaves.');
    if (!to) out.push('Enter when the employee is due back.');
  }
  if (from && to && to <= from) out.push('“Due back” must be after “Leaves at”.');
  else if (to && to <= new Date()) out.push('That time is already past — the pass would be created expired.');
  if (passType === 'material') {
    if (f.returnable === '') out.push('Say whether the goods are coming back.');
    if (!f.destination.trim()) out.push('Enter where the goods are going.');
    if (f.returnable === 'true') {
      const due = f.expected_return_at ? new Date(f.expected_return_at) : null;
      if (!due) out.push('Enter when the goods are due back.');
      else if (due <= new Date()) out.push('The return date must be in the future.');
    }
    const lines = f.items.filter((it) => it.description.trim() || it.quantity);
    if (!lines.length) out.push('Add at least one item.');
    lines.forEach((it, i) => {
      if (!it.description.trim()) out.push(`Item ${i + 1}: describe the item.`);
      if (!(Number(it.quantity) > 0)) out.push(`Item ${i + 1}: quantity must be more than 0.`);
    });
  }
  return out;
}

// `visitor` (§273): goods leaving with a visitor who is inside — the host
// approves (automatically when the host raises it) and security releases it.
export default function PassForm({ passType, initial = null, canPickEmployee, employees, onSaved, onCancel, visitor = null }) {
  const [f, setF] = useState(() => initialForm(passType, initial, visitor));
  const forVisitor = visitor || (initial?.visitor_id ? { id: initial.visitor_id, name: initial.visitor_ref_name } : null);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setItem = (i, k, v) => setF((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, [k]: v } : it)) }));
  const material = passType === 'material';
  const editing = !!initial;

  const submit = async (e) => {
    e.preventDefault();
    const p = problems(f, passType);
    setErrors(p);
    if (p.length) return;
    const body = {
      pass_type: passType,
      employee_id: canPickEmployee && !forVisitor ? f.employee_id : undefined,
      ...(visitor ? { visitor_id: visitor.id } : {}),
      category: material ? undefined : f.category,
      purpose: f.purpose.trim(),
      valid_from: toIso(f.valid_from),
      valid_to: toIso(f.valid_to),
      vehicle_number: f.vehicle_number.trim(),
      carried_by: f.carried_by.trim(),
      destination: f.destination.trim(),
      ...(material ? {
        returnable: f.returnable === 'true',
        expected_return_at: f.returnable === 'true' ? toIso(f.expected_return_at) : '',
        items: f.items.filter((it) => it.description.trim() || it.quantity).map((it) => ({
          description: it.description.trim(), item_code: it.item_code.trim(), quantity: Number(it.quantity), unit: it.unit, remarks: it.remarks.trim(),
        })),
      } : {}),
    };
    setSaving(true);
    try {
      const res = editing ? await api.put(`/gate-passes/${initial.id}`, body) : await api.post('/gate-passes', body);
      onSaved(res.data);
    } catch (err) {
      setErrors(err.response?.data?.errors || [errText(err, 'Could not save the pass')]);
    } finally { setSaving(false); }
  };

  const title = editing ? `Edit ${initial.pass_number}` : forVisitor ? `Goods leaving with ${forVisitor.name}` : material ? 'New material gate pass' : 'New gate pass';
  return (
    <Modal title={title} onClose={onCancel} busy={saving} width={material ? 760 : 560}>
      <form onSubmit={submit} noValidate data-testid="pass-form">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
          {forVisitor && (
            <div style={{ gridColumn: '1 / -1', fontSize: 13, color: '#4b5563', background: '#fff', border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 12px' }} data-testid="pf-visitor">
              Visitor: <strong>{forVisitor.name}</strong>{forVisitor.company ? ` · ${forVisitor.company}` : ''}{forVisitor.host_name ? ` · host ${forVisitor.host_name}` : ''}
            </div>
          )}
          {canPickEmployee && !forVisitor && (
            <div>
              <label style={S.label} htmlFor="pf-employee">{material ? 'Responsible employee' : 'Employee'}</label>
              <EmployeeSelect id="pf-employee" employees={employees} value={f.employee_id} onChange={(v) => set('employee_id', v)}
                placeholder={editing ? 'Select employee' : 'Myself'} />
            </div>
          )}
          {!material && (
            <div>
              <label style={S.label} htmlFor="pf-category">Type of pass *</label>
              <select id="pf-category" value={f.category} onChange={(e) => set('category', e.target.value)} style={S.input}>
                <option value="">Choose…</option>
                {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          )}
          {material && (
            <div>
              <label style={S.label} htmlFor="pf-returnable">Goods *</label>
              <select id="pf-returnable" value={f.returnable} onChange={(e) => set('returnable', e.target.value)} style={S.input}>
                <option value="">Choose…</option>
                <option value="true">Returnable (RGP) — coming back</option>
                <option value="false">Non-returnable (NRGP) — not coming back</option>
              </select>
            </div>
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label} htmlFor="pf-purpose">{material ? 'Purpose *' : 'Reason *'}</label>
            <input id="pf-purpose" maxLength={1000} value={f.purpose} onChange={(e) => set('purpose', e.target.value)} style={S.input}
              placeholder={material ? 'e.g. Motor sent for rewinding' : 'e.g. Client meeting at their office'} />
          </div>
          {material && (
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={S.label} htmlFor="pf-dest">Destination *</label>
              <input id="pf-dest" maxLength={300} value={f.destination} onChange={(e) => set('destination', e.target.value)} style={S.input}
                placeholder="Party name and place" />
            </div>
          )}
          <div>
            <label style={S.label} htmlFor="pf-from">{material ? 'Goods leave from' : 'Leaves at *'}</label>
            <input id="pf-from" type="datetime-local" value={f.valid_from} onChange={(e) => set('valid_from', e.target.value)} style={S.input} />
          </div>
          <div>
            <label style={S.label} htmlFor="pf-to">{material ? 'Pass valid until' : 'Due back *'}</label>
            <input id="pf-to" type="datetime-local" min={f.valid_from || undefined} value={f.valid_to} onChange={(e) => set('valid_to', e.target.value)} style={S.input} />
          </div>
          {material && f.returnable === 'true' && (
            <div>
              <label style={S.label} htmlFor="pf-due">Goods due back *</label>
              <input id="pf-due" type="datetime-local" min={f.valid_from || undefined} value={f.expected_return_at} onChange={(e) => set('expected_return_at', e.target.value)} style={S.input} />
            </div>
          )}
          <div>
            <label style={S.label} htmlFor="pf-vehicle">Vehicle number</label>
            <input id="pf-vehicle" maxLength={30} value={f.vehicle_number} onChange={(e) => set('vehicle_number', e.target.value.toUpperCase())} style={S.input} placeholder="Optional" />
          </div>
          {material && (
            <div>
              <label style={S.label} htmlFor="pf-carrier">Carried by</label>
              <input id="pf-carrier" maxLength={200} value={f.carried_by} onChange={(e) => set('carried_by', e.target.value)} style={S.input} placeholder="Driver / transporter (optional)" />
            </div>
          )}
        </div>

        {material && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#4c1d95', marginBottom: 6 }}>Items *</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }} data-testid="pass-items">
                <thead><tr style={{ background: '#f5f3ff' }}>
                  {['#', 'Description', 'Item code', 'Qty', 'Unit', 'Remarks', ''].map((h) => <th key={h} style={{ ...S.th, padding: '6px 8px' }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {f.items.map((it, i) => (
                    <tr key={i}>
                      <td style={{ padding: 4, color: '#6b7280' }}>{i + 1}</td>
                      <td style={{ padding: 4, minWidth: 180 }}><input aria-label={`Item ${i + 1} description`} maxLength={300} value={it.description} onChange={(e) => setItem(i, 'description', e.target.value)} style={S.input} /></td>
                      <td style={{ padding: 4, minWidth: 100 }}><input aria-label={`Item ${i + 1} code`} maxLength={100} value={it.item_code} onChange={(e) => setItem(i, 'item_code', e.target.value)} style={S.input} /></td>
                      <td style={{ padding: 4, width: 90 }}><input aria-label={`Item ${i + 1} quantity`} type="number" min="0" step="any" value={it.quantity} onChange={(e) => setItem(i, 'quantity', e.target.value)} style={S.input} /></td>
                      <td style={{ padding: 4, width: 90 }}>
                        <select aria-label={`Item ${i + 1} unit`} value={it.unit} onChange={(e) => setItem(i, 'unit', e.target.value)} style={S.input}>
                          {[...new Set([...UNITS, it.unit])].map((u) => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: 4, minWidth: 120 }}><input aria-label={`Item ${i + 1} remarks`} maxLength={500} value={it.remarks} onChange={(e) => setItem(i, 'remarks', e.target.value)} style={S.input} /></td>
                      <td style={{ padding: 4 }}>
                        <button type="button" aria-label={`Remove item ${i + 1}`} disabled={f.items.length === 1}
                          onClick={() => setF((x) => ({ ...x, items: x.items.filter((_, j) => j !== i) }))}
                          style={{ ...S.small('#fee2e2', '#b91c1c'), opacity: f.items.length === 1 ? 0.4 : 1 }}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button type="button" onClick={() => setF((x) => ({ ...x, items: [...x.items, blankItem()] }))} disabled={f.items.length >= 50}
              style={{ ...S.secondary, padding: '5px 12px', marginTop: 8 }}>+ Add item</button>
          </div>
        )}

        {errors.length > 0 && (
          <ul role="alert" style={{ margin: '12px 0 0', paddingLeft: 18, color: '#b91c1c', fontSize: 13 }}>
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        <p style={{ margin: '12px 0 0', fontSize: 12, color: '#6b7280' }}>
          {editing ? 'A pass can be edited until it is approved.'
            : forVisitor ? 'The visitor’s host approves the goods (automatically if you are the host); security checks and releases them at the gate. The visitor cannot check out until then.'
              : 'The pass goes to the department head for approval (else the reporting manager, else HR). They are notified.'}
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} disabled={saving} style={S.secondary}>Cancel</button>
          <button type="submit" disabled={saving} style={{ ...S.primary, opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Submit for approval'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
