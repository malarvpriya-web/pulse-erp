import { useState } from 'react';
import api from '@/services/api/client';

const OPTION_LABELS = {
  gross_excl_employer_contributions: 'Leave employer PF and statutory bonus out of the 50% test',
  include_employer_pf_and_statutory_bonus: 'Include employer PF and statutory bonus in the 50% test',
  gross: 'Gross pay',
  code_wages: 'Code wages',
};
const inputStyle = { display: 'block', width: '100%', padding: 6, marginTop: 4, fontSize: 12 };

/**
 * Records one rule blocker's confirmation or decision. A recorded version counts
 * as an authorised person's confirmation, so the person names the source they read.
 * A value that differs from the source is changed in Settings, Statutory rules & bonus.
 */
export default function StatutoryRuleRecorder({ blocker, onRecorded }) {
  const isDecision = Boolean(blocker.options?.length);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(blocker.value);
  const [source, setSource] = useState('');
  const [hasRead, setHasRead] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const shown = blocker.state && blocker.value?.[blocker.state] !== undefined ? blocker.value[blocker.state] : blocker.value;
  const changesFigures = isDecision && choice !== blocker.value;

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await api.post('/payroll/statutory-rules', {
        rule_key: blocker.key,
        effective_from: blocker.record_from,
        value: isDecision ? choice : blocker.value,
        source_reference: source.trim(),
      });
      onRecorded();
    } catch (err) {
      setError(err?.response?.data?.message || err?.response?.data?.error || 'The rule could not be recorded.');
    } finally { setSaving(false); }
  };

  if (!open) {
    return (
      <button type="button" className="pulse-btn-secondary" onClick={() => setOpen(true)} style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}>
        {isDecision ? 'Record decision' : 'Confirm rule'}
      </button>
    );
  }

  return (
    <div data-rule-form={blocker.key} style={{ background: '#fff', border: '1px solid #fecaca', borderRadius: 8, padding: 12, margin: '6px 0', color: '#374151' }}>
      {isDecision ? (
        <label>Company decision
          <select value={choice} onChange={(e) => setChoice(e.target.value)} style={inputStyle}>
            {blocker.options.map((o) => <option key={o} value={o}>{OPTION_LABELS[o] ?? o}</option>)}
          </select>
        </label>
      ) : (
        <details>
          <summary style={{ cursor: 'pointer' }}>Value you are confirming{blocker.state ? ` (${blocker.state})` : ''}</summary>
          <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', margin: '6px 0' }}>{JSON.stringify(shown, null, 2)}</pre>
        </details>
      )}
      <div style={{ marginTop: 8 }}>Applies from {blocker.record_from}.</div>
      {changesFigures && (
        <div style={{ marginTop: 4, color: '#92400e' }}>This changes payroll figures. Any existing draft for this period must be regenerated before approval.</div>
      )}
      <label style={{ display: 'block', marginTop: 8 }}>{isDecision ? 'Decision reference, such as the board note or adviser\'s letter (optional)' : 'Source you read, such as the notification number (optional)'}
        <input type="text" value={source} onChange={(e) => setSource(e.target.value)} style={inputStyle} />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>
        <input type="checkbox" checked={hasRead} onChange={(e) => setHasRead(e.target.checked)} style={{ marginRight: 6 }} />
        {isDecision ? 'I am authorised to record this decision for the company.' : 'I have read this source and it says the same. If it differs, change it in Settings, Statutory rules & bonus.'}
      </label>
      {error && <div role="alert" style={{ marginTop: 6, color: '#b91c1c' }}>{error}</div>}
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button type="button" className="pulse-btn-primary" disabled={saving || !hasRead} onClick={save}>
          {saving ? 'Recording...' : 'Record'}
        </button>
        <button type="button" className="pulse-btn-secondary" disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
