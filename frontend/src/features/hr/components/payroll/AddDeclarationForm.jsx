// Finance enters an employee's IT declaration (owner decision 2026-11-11).
//
// Employees no longer file their own (the Self-Service page is gone and
// self_service:add/edit are off); they hand their proofs to Finance, who enters
// each claim here. It is the SAME it_declarations row the review list below
// shows — POST /self-service/it-declarations with the employee's id, which the
// server allows only to it_declarations:add holders, for employees of their own
// company. The new row is 'submitted' and still goes through review.
//
// Employees come from GET /payroll/tax-setup (active / probation / notice staff
// of the company) — a plain <select>, so the whole list opens on click — and
// each shows their tax regime: declarations change tax only on the OLD regime.
import { useState, useEffect } from 'react';
import api from '@/services/api/client';

// The types payroll reads for tax (old regime only).
export const DECL_TYPES = [
  ['80C', '80C — PPF, ELSS, life insurance, tuition fees…'],
  ['80CCD', 'NPS — own contribution'],
  ['80D', '80D — health insurance'],
  ['HOME_LOAN', 'Home-loan interest (house they live in)'],
  ['HRA', 'HRA — rent paid for the year'],
  ['LTA', 'LTA — leave travel'],
  ['other', 'Other (not used for tax)'],
];
const DECL_HELP = {
  '80CCD': 'The first ₹50,000 is an extra deduction; the rest counts within the ₹1,50,000 80C limit (up to 10% of Basic).',
  HOME_LOAN: 'Interest (not principal) for the year on a loan for the house they live in, up to ₹2,00,000. Principal goes under 80C. Keep the lender\'s interest certificate as proof.',
};
// Form 12BB practice: the landlord's PAN is needed above ₹1,00,000 of rent a year (the server enforces it).
const LANDLORD_PAN_ABOVE = 100000;
const EMPTY = { employee_id: '', declaration_type: '80C', amount: '', description: '', proof_url: '', metro_city: false,
  landlord_name: '', landlord_pan: '', insured_for: 'self', parents_senior: false };

const input = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };
const label = { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 };

export default function AddDeclarationForm({ financialYear, onSaved, onCancel }) {
  const [form, setForm] = useState(EMPTY);
  const [proof, setProof] = useState(null);
  const [people, setPeople] = useState(null);   // null = loading
  const [peopleErr, setPeopleErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = patch => setForm(f => ({ ...f, ...patch }));

  useEffect(() => {
    let live = true;
    api.get('/payroll/tax-setup', { params: { financial_year: financialYear } })
      .then(({ data }) => { if (live) setPeople(data?.data?.employees || []); })
      .catch(err => { if (live) { setPeople([]); setPeopleErr(err.response?.data?.message || 'Could not load employees'); } });
    return () => { live = false; };
  }, [financialYear]);

  const chosen = (people || []).find(p => String(p.employee_id) === String(form.employee_id));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      const t = form.declaration_type;
      const { data: created } = await api.post('/self-service/it-declarations', {
        employee_id: Number(form.employee_id),
        financial_year: financialYear,
        declaration_type: t,
        amount: form.amount,
        description: form.description,
        ...(form.proof_url.trim() ? { proof_url: form.proof_url.trim() } : {}),
        ...(t === 'HRA' ? { metro_city: !!form.metro_city, landlord_name: form.landlord_name.trim(), landlord_pan: form.landlord_pan.trim().toUpperCase() } : {}),
        ...(t === '80D' ? { insured_for: form.insured_for, parents_senior: form.insured_for === 'parents' && !!form.parents_senior } : {}),
      });
      let proofError = null;
      if (proof && created?.id) {
        const fd = new FormData();
        fd.append('file', proof);
        try { await api.post(`/self-service/it-declarations/${created.id}/proof`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }); }
        catch (err) { proofError = err.response?.data?.message || 'the file could not be attached'; }
      }
      onSaved?.({ name: chosen?.name || 'the employee', proofError });
      setForm(EMPTY); setProof(null);
    } catch (err) {
      setError(err.response?.data?.message || 'The declaration could not be saved');
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} aria-label="Add declaration for an employee"
      style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
      <div style={{ fontWeight: 700, color: '#4c1d95', marginBottom: 4 }}>Add a declaration for an employee — FY {financialYear}</div>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
        Enter it from the proof the employee handed in. It is saved as <b>waiting for review</b> and is approved below like any other.
      </div>
      {error && <div role="alert" style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 7, background: '#fef2f2', color: '#b91c1c', fontSize: 13 }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 12 }}>
        <div>
          <label htmlFor="adf-emp" style={label}>Employee *</label>
          <select id="adf-emp" required value={form.employee_id} onChange={e => set({ employee_id: e.target.value })} style={input}
            disabled={people === null}>
            <option value="">{people === null ? 'Loading…' : 'Choose an employee'}</option>
            {(people || []).map(p => (
              <option key={p.employee_id} value={p.employee_id}>
                {p.name}{p.employee_code ? ` (${p.employee_code})` : ''}{p.department ? ` · ${p.department}` : ''}
              </option>
            ))}
          </select>
          {peopleErr && <div style={{ fontSize: 11, color: '#b91c1c', marginTop: 4 }}>{peopleErr}</div>}
          {chosen && (
            <div style={{ fontSize: 11, marginTop: 4, color: chosen.regime === 'old' ? '#15803d' : '#6d28d9' }}>
              {chosen.regime === 'old'
                ? 'Old tax regime — this declaration will reduce their TDS once approved.'
                : 'New tax regime — declarations do not change their tax. Record the regime in Tax setup first if they chose the old one.'}
            </div>
          )}
        </div>
        <div>
          <label htmlFor="adf-type" style={label}>Declaration type</label>
          <select id="adf-type" value={form.declaration_type} style={input}
            onChange={e => set({ declaration_type: e.target.value })}>
            {DECL_TYPES.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
          </select>
          {DECL_HELP[form.declaration_type] && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{DECL_HELP[form.declaration_type]}</div>}
        </div>
        <div>
          <label htmlFor="adf-amount" style={label}>Amount (₹) *</label>
          <input id="adf-amount" type="number" min="1" required value={form.amount} onChange={e => set({ amount: e.target.value })} style={input} />
        </div>
        <div>
          <label htmlFor="adf-desc" style={label}>Description *</label>
          <input id="adf-desc" required value={form.description} onChange={e => set({ description: e.target.value })} style={input} />
        </div>
        <div>
          <label htmlFor="adf-url" style={label}>Proof link (optional)</label>
          <input id="adf-url" type="url" placeholder="https://…" maxLength={2000} value={form.proof_url} onChange={e => set({ proof_url: e.target.value })} style={input} />
        </div>
        <div>
          <label htmlFor="adf-file" style={label}>Proof file (PDF, JPEG or PNG, up to 10 MB)</label>
          <input id="adf-file" type="file" accept="application/pdf,image/jpeg,image/png" onChange={e => setProof(e.target.files?.[0] || null)} style={{ fontSize: 12 }} />
        </div>
        {form.declaration_type === 'HRA' && (<>
          <div>
            <label htmlFor="adf-landlord" style={label}>Landlord name *</label>
            <input id="adf-landlord" required maxLength={200} value={form.landlord_name} onChange={e => set({ landlord_name: e.target.value })} style={input} />
          </div>
          <div>
            <label htmlFor="adf-landlord-pan" style={label}>
              Landlord PAN {Number(form.amount) > LANDLORD_PAN_ABOVE ? '*' : '(needed above ₹1,00,000 a year)'}
            </label>
            <input id="adf-landlord-pan" maxLength={10} placeholder="ABCDE1234F" value={form.landlord_pan}
              required={Number(form.amount) > LANDLORD_PAN_ABOVE} pattern="[A-Za-z]{5}[0-9]{4}[A-Za-z]"
              onChange={e => set({ landlord_pan: e.target.value.toUpperCase() })} style={input} />
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#374151' }}>
            <input type="checkbox" checked={!!form.metro_city} onChange={e => set({ metro_city: e.target.checked })} />
            Rents in Delhi, Mumbai, Kolkata or Chennai (metro city)
          </label>
        </>)}
        {form.declaration_type === '80D' && (<>
          <div>
            <label htmlFor="adf-insured" style={label}>Insurance is for</label>
            <select id="adf-insured" value={form.insured_for} style={input}
              onChange={e => set({ insured_for: e.target.value, parents_senior: e.target.value === 'parents' ? form.parents_senior : false })}>
              <option value="self">Self, spouse, children (up to ₹25,000; ₹50,000 if 60+)</option>
              <option value="parents">Parents (up to ₹25,000; ₹50,000 if a parent is 60+)</option>
            </select>
          </div>
          {form.insured_for === 'parents' && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#374151' }}>
              <input type="checkbox" checked={!!form.parents_senior} onChange={e => set({ parents_senior: e.target.checked })} />
              A parent covered is 60 or over
            </label>
          )}
        </>)}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button type="submit" disabled={saving}
          style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
          {saving ? 'Saving…' : 'Save declaration'}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}
            style={{ background: '#fff', color: '#4c1d95', border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
