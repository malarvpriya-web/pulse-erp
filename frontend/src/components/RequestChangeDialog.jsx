import { useState } from 'react';
import { X } from 'lucide-react';
import api from '@/services/api/client';

/*
 * "Request change" — an employee asks HR or Finance to correct their record
 * (2026-11-11). Employees change nothing of their own: HR maintains the record,
 * Finance the tax regime and IT declarations. This raises a Record correction
 * ticket (POST /servicedesk/corrections); HR / Finance decide it in the Approval
 * Center and the answer comes back on the ticket (My Tickets) and as a
 * notification.
 *
 * `section` picks who it goes to: Tax & IT declarations → Finance, anything
 * else → HR.
 */
export const CHANGE_SECTIONS = [
  'Personal', 'Contact & Address', 'Emergency Contact & Nominee', 'Job', 'Education & Experience',
  'Statutory IDs (PAN, Aadhaar, UAN, PF, ESIC)', 'Bank (salary account)', 'Documents', 'Assets',
  'Tax regime & IT declarations', 'Something else',
];
export const sectionOwner = (section) => (section === 'Tax regime & IT declarations' ? 'Finance' : 'HR');

// The view page's tabs → the section a request from that tab is most likely about.
export const SECTION_FOR_TAB = {
  Overview: 'Personal', Personal: 'Personal', Job: 'Job', Payroll: 'Bank (salary account)',
  Documents: 'Documents', Assets: 'Assets', History: 'Job',
};

const input = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 8, font: 'inherit', fontSize: 13 };
const label = { display: 'block', fontSize: 12, fontWeight: 600, color: '#4c1d95', margin: '8px 0 4px' };

export default function RequestChangeDialog({ initialSection = 'Personal', onClose, onSent }) {
  const [section, setSection] = useState(CHANGE_SECTIONS.includes(initialSection) ? initialSection : 'Personal');
  const [field, setField] = useState('');
  const [current, setCurrent] = useState('');
  const [correct, setCorrect] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const to = sectionOwner(section);

  const send = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const { data } = await api.post('/servicedesk/corrections', {
        to, section, field: field.trim(), current_value: current.trim(), correct_value: correct.trim(), details: details.trim(),
      });
      onSent?.(data, to);
    } catch (err) {
      setError(err.response?.data?.error || 'The request could not be sent');
    } finally { setBusy(false); }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Request change"
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.45)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <form onSubmit={send} style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 480, padding: 20, boxShadow: '0 12px 40px rgba(0,0,0,.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>Request a change to my record</span>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', display: 'flex' }}><X size={16} /></button>
        </div>
        <p style={{ margin: '6px 0 4px', fontSize: 12.5, color: '#6b7280' }}>
          This goes to <b>{to}</b> as a ticket. They will check it, correct your record and reply — you will see the answer on My Details → Overview.
        </p>
        {error && <div role="alert" style={{ margin: '8px 0', padding: '8px 12px', borderRadius: 8, background: '#fef2f2', color: '#b91c1c', fontSize: 13 }}>{error}</div>}
        <label style={label} htmlFor="rcd-section">Section</label>
        <select id="rcd-section" style={input} value={section} onChange={e => setSection(e.target.value)}>
          {CHANGE_SECTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={label} htmlFor="rcd-field">Which detail is wrong? *</label>
        <input id="rcd-field" style={input} required maxLength={120} placeholder="e.g. Date of birth, IFSC, Designation" value={field} onChange={e => setField(e.target.value)} />
        <label style={label} htmlFor="rcd-current">What is shown now</label>
        <input id="rcd-current" style={input} maxLength={500} value={current} onChange={e => setCurrent(e.target.value)} />
        <label style={label} htmlFor="rcd-correct">What should it be?</label>
        <input id="rcd-correct" style={input} maxLength={500} value={correct} onChange={e => setCorrect(e.target.value)} />
        <label style={label} htmlFor="rcd-details">Anything else {to} should know</label>
        <textarea id="rcd-details" style={input} rows={3} maxLength={2000} placeholder="e.g. I will email the corrected PAN card copy"
          value={details} onChange={e => setDetails(e.target.value)} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" className="pulse-btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="pulse-btn-primary" disabled={busy || !field.trim() || (!correct.trim() && !details.trim())}>
            {busy ? 'Sending…' : `Send to ${to}`}
          </button>
        </div>
      </form>
    </div>
  );
}
