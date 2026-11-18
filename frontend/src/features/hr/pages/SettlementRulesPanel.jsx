import { useEffect, useState } from 'react';
import api from '../../../services/api/client';
import FoldSection, { FoldAllButton, useFolds } from '../../../components/shared/FoldSection';

const TITLES = {
  'settlement.gratuity': 'Gratuity',
  'settlement.bonus': 'Statutory bonus',
  'settlement.wage_payment': 'Final wage deadline',
  'settlement.day_rate': 'Day rate',
  'settlement.notice': 'Notice',
  'settlement.tax': 'Tax on the settlement',
  'settlement.gl': 'Account codes',
  'settlement.leave': 'Earned leave at exit',
  'settlement.retrenchment': 'Retrenchment compensation',
};
const label = (k) => k.replace(/_/g, ' ');
const inputStyle = { display: 'block', width: '100%', padding: 6, marginTop: 4 };

/** Turn what was typed back into the rule's own types. */
function toValue(original, draft) {
  const out = {};
  for (const k of Object.keys(original)) {
    const was = original[k], now = draft[k];
    if (typeof was === 'number') out[k] = now === '' ? NaN : Number(now);
    else if (Array.isArray(was)) out[k] = String(now).split(',').map((x) => x.trim()).filter(Boolean);
    else if (typeof was === 'boolean') out[k] = now === true || now === 'true';
    else out[k] = String(now ?? '').trim() === '' ? null : (/^\d+(\.\d+)?$/.test(String(now)) && typeof was === 'number' ? Number(now) : String(now).trim());
  }
  return out;
}
const toDraft = (value) => Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')]));

function RuleCard({ rule, onSaved, readOnly, open, onToggle }) {
  const [draft, setDraft] = useState(() => toDraft(rule.value));
  const [source, setSource] = useState('');
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const confirmed = rule.status === 'confirmed';

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      await api.post('/payroll/statutory-rules', { rule_key: rule.key, effective_from: from, value: toValue(rule.value, draft), source_reference: source.trim() });
      setSource('');
      onSaved();
    } catch (err) {
      setError(err?.response?.data?.message || err?.response?.data?.error || 'The rule could not be saved.');
    } finally { setSaving(false); }
  };

  return (
    <FoldSection
      data-rule={rule.key}
      title={TITLES[rule.key] ?? rule.key}
      open={open}
      onToggle={onToggle}
      style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '8px 16px', marginBottom: 12, color: '#111827' }}
      right={(
        <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: confirmed ? '#d1fae5' : '#fef3c7', color: confirmed ? '#065f46' : '#92400e' }}>
          {confirmed ? 'Confirmed' : rule.status === 'decision_required' ? 'Your decision' : 'Not confirmed'}
        </span>
      )}
    >
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>From {rule.effective_from}. {rule.source}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, fontSize: 13 }}>
        {Object.keys(rule.value).map((k) => (
          <label key={k} style={{ textTransform: 'capitalize' }}>{label(k)}
            {typeof rule.value[k] === 'boolean' ? (
              <select disabled={readOnly} value={String(draft[k])} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value === 'true' }))} style={inputStyle}>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input readOnly={readOnly} type={typeof rule.value[k] === 'number' ? 'number' : 'text'} value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} style={inputStyle} />
            )}
          </label>
        ))}
        {!readOnly && (
          <>
            <label>Applies from
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
            </label>
            <label style={{ gridColumn: 'span 2' }}>Source, such as the adviser's letter (optional)
              <input type="text" value={source} onChange={(e) => setSource(e.target.value)} style={inputStyle} />
            </label>
          </>
        )}
      </div>
      {error && <div role="alert" style={{ marginTop: 8, fontSize: 12, color: '#b91c1c' }}>{error}</div>}
      {!readOnly && (
        <button type="button" disabled={saving} onClick={save} style={{ marginTop: 12, padding: '8px 16px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
          {saving ? 'Saving...' : 'Save and confirm'}
        </button>
      )}
      <div style={{ height: 8 }} />
    </FoldSection>
  );
}

/**
 * The settlement's rates and account codes, kept as inputs. Saving a value records it as a dated
 * version and counts as confirming it. Past settlements keep the rules they were computed with.
 */
export default function SettlementRulesPanel() {
  const [rules, setRules] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState(null);
  const folds = useFolds();

  const load = async () => {
    setError(null);
    try {
      const res = await api.get('/exit/fnf/rules');
      setRules(res.data?.data ?? []);
      setCanEdit(res.data?.can_edit === true);
    } catch (err) {
      setError(err?.response?.data?.error || 'The settlement rules could not be loaded.');
    }
  };
  useEffect(() => { load(); }, []);

  if (error) return <div role="alert" style={{ padding: 16, color: '#b91c1c' }}>{error}</div>;
  if (!rules) return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading settlement rules...</div>;
  const open = rules.filter((r) => r.status !== 'confirmed').length;
  return (
    <div>
      <div style={{ padding: '10px 16px', marginBottom: 12, borderRadius: 8, fontSize: 13, background: open ? '#fef3c7' : '#d1fae5', color: open ? '#92400e' : '#065f46' }}>
        {open ? `${open} of ${rules.length} rules are not confirmed. A settlement cannot be approved until every rule is confirmed.` : 'All rules are confirmed.'}
      </div>
      {!canEdit && (
        <div role="status" style={{ padding: '10px 16px', marginBottom: 12, borderRadius: 8, fontSize: 13, background: '#f3f4f6', color: '#374151' }}>
          Read only. Changing a rule needs the statutory rules edit right (Payroll Administrator or Administrator by default, set in Roles Setup).
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <FoldAllButton folds={folds} keys={rules.map((r) => r.key)} />
      </div>
      {rules.map((r) => (
        <RuleCard key={`${r.key}-${r.effective_from}-${r.status}`} rule={r} onSaved={load} readOnly={!canEdit}
          open={folds.isOpen(r.key)} onToggle={() => folds.toggle(r.key)} />
      ))}
    </div>
  );
}
