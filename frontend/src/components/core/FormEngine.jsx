/**
 * FormEngine — Universal dynamic form component.
 *
 * Field types: text | email | number | password | textarea |
 *              select | date | file | checkbox | radio | hidden | divider | section
 */
import { useState, useCallback } from 'react';
import { AlertCircle, CheckCircle, Eye, EyeOff } from 'lucide-react';

const BASE_INPUT = {
  width: '100%', padding: '8px 10px',
  border: '1px solid #e5e7eb', borderRadius: 8,
  fontSize: 13, color: '#111827', background: '#fff',
  boxSizing: 'border-box', outline: 'none',
  transition: 'border-color .15s',
  fontFamily: 'inherit',
};
const ERR_INPUT = { borderColor: '#ef4444', background: '#fff5f5' };

function FieldWrapper({ field, error, children }) {
  if (field.type === 'hidden')  return children;
  if (field.type === 'divider') return (
    <div style={{ gridColumn: '1 / -1', borderTop: '1px solid #f0f0f4', margin: '8px 0' }} />
  );
  if (field.type === 'section') return (
    <div style={{ gridColumn: '1 / -1', paddingTop: 8 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>{field.label}</div>
      {field.helpText && <div style={{ fontSize: 12, color: '#9ca3af' }}>{field.helpText}</div>}
    </div>
  );
  return (
    <div style={{
      gridColumn: field.width === 'full' ? '1 / -1' : 'span 1',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      {field.type !== 'checkbox' && (
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
          {field.label}
          {field.required && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
        </label>
      )}
      {children}
      {field.helpText && !error && (
        <span style={{ fontSize: 11, color: '#9ca3af' }}>{field.helpText}</span>
      )}
      {error && (
        <span style={{ fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 3 }}>
          <AlertCircle size={11} /> {error}
        </span>
      )}
    </div>
  );
}

export default function FormEngine({
  schema        = [],
  initial       = {},
  onSubmit,
  onCancel,
  submitLabel   = 'Save',
  loading:      externalLoading = false,
  layout        = { columns: 2 },
}) {
  const [values,     setValues]     = useState(() => {
    const v = {};
    schema.forEach(f => { if (f.key) v[f.key] = initial[f.key] ?? f.default ?? ''; });
    return v;
  });
  const [errors,     setErrors]     = useState({});
  const [touched,    setTouched]    = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitErr,  setSubmitErr]  = useState(null);
  const [submitOK,   setSubmitOK]   = useState(false);
  const [showPwd,    setShowPwd]    = useState({});

  const setValue = useCallback((key, value) => {
    setValues(v => ({ ...v, [key]: value }));
    setTouched(t => ({ ...t, [key]: true }));
    setErrors(e => { const next = { ...e }; delete next[key]; return next; });
  }, []);

  const validate = useCallback(() => {
    const errs = {};
    schema.forEach(f => {
      if (!f.key || ['hidden', 'divider', 'section'].includes(f.type)) return;
      const v = values[f.key];
      if (f.required && (v === '' || v === null || v === undefined)) {
        errs[f.key] = `${f.label} is required`;
      } else if (f.validate) {
        const msg = f.validate(v, values);
        if (msg) errs[f.key] = msg;
      } else if (f.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        errs[f.key] = 'Enter a valid email address';
      } else if (f.type === 'number' && v !== '' && v !== undefined && isNaN(Number(v))) {
        errs[f.key] = 'Must be a valid number';
      }
    });
    return errs;
  }, [schema, values]);

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) {
      setErrors(errs);
      setTouched(Object.fromEntries(schema.filter(f => f.key).map(f => [f.key, true])));
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    setSubmitOK(false);
    try {
      await onSubmit?.(values);
      setSubmitOK(true);
    } catch (err) {
      setSubmitErr(err.message || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }, [values, validate, onSubmit, schema]);

  const isVisible = useCallback((field) => {
    if (!field.dependsOn) return true;
    const { field: depField, value: depValue } = field.dependsOn;
    const actual = values[depField];
    return Array.isArray(depValue) ? depValue.includes(actual) : actual === depValue;
  }, [values]);

  const busy = submitting || externalLoading;

  return (
    <form onSubmit={handleSubmit} style={{ width: '100%' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
        gap: '16px 20px',
        marginBottom: 20,
      }}>
        {schema.map((field, idx) => {
          if (!isVisible(field)) return null;
          const key  = field.key || `__${idx}`;
          const err  = touched[key] ? errors[key] : null;
          const fval = values[key] ?? '';
          const inputStyle = { ...BASE_INPUT, ...(err ? ERR_INPUT : {}) };

          let input = null;

          if (['text', 'email', 'number'].includes(field.type)) {
            input = (
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                {field.prefix && (
                  <span style={{ position: 'absolute', left: 10, fontSize: 13, color: '#6b7280', pointerEvents: 'none' }}>
                    {field.prefix}
                  </span>
                )}
                <input
                  type={field.type}
                  value={fval}
                  onChange={e => setValue(field.key, e.target.value)}
                  placeholder={field.placeholder || ''}
                  disabled={field.disabled || busy}
                  maxLength={field.maxLength}
                  style={{ ...inputStyle, paddingLeft: field.prefix ? 24 : 10, paddingRight: field.suffix ? 36 : 10 }}
                />
                {field.suffix && (
                  <span style={{ position: 'absolute', right: 10, fontSize: 12, color: '#9ca3af' }}>{field.suffix}</span>
                )}
              </div>
            );
          } else if (field.type === 'password') {
            input = (
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input
                  type={showPwd[field.key] ? 'text' : 'password'}
                  value={fval}
                  onChange={e => setValue(field.key, e.target.value)}
                  placeholder={field.placeholder || ''}
                  disabled={field.disabled || busy}
                  style={{ ...inputStyle, paddingRight: 36 }}
                />
                <button type="button" onClick={() => setShowPwd(s => ({ ...s, [field.key]: !s[field.key] }))}
                  style={{ position: 'absolute', right: 10, background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 0 }}>
                  {showPwd[field.key] ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            );
          } else if (field.type === 'textarea') {
            input = (
              <textarea
                value={fval}
                onChange={e => setValue(field.key, e.target.value)}
                placeholder={field.placeholder || ''}
                disabled={field.disabled || busy}
                rows={field.rows || 3}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            );
          } else if (field.type === 'select') {
            input = (
              <select
                value={fval}
                onChange={e => setValue(field.key, e.target.value)}
                disabled={field.disabled || busy}
                style={inputStyle}
              >
                <option value="">{field.placeholder || `— Select ${field.label} —`}</option>
                {(field.options || []).map(opt => (
                  <option key={opt.value ?? opt} value={opt.value ?? opt}>
                    {opt.label ?? opt}
                  </option>
                ))}
              </select>
            );
          } else if (field.type === 'date') {
            input = (
              <input
                type="date"
                value={fval}
                onChange={e => setValue(field.key, e.target.value)}
                disabled={field.disabled || busy}
                style={inputStyle}
              />
            );
          } else if (field.type === 'checkbox') {
            input = (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!fval}
                  onChange={e => setValue(field.key, e.target.checked)}
                  disabled={field.disabled || busy}
                  style={{ width: 16, height: 16, accentColor: '#6366f1' }}
                />
                {field.label}
                {field.required && <span style={{ color: '#ef4444' }}>*</span>}
              </label>
            );
          } else if (field.type === 'file') {
            input = (
              <input
                type="file"
                accept={field.accept || ''}
                onChange={e => setValue(field.key, e.target.files[0])}
                disabled={field.disabled || busy}
                style={{ fontSize: 13, color: '#374151' }}
              />
            );
          } else if (field.type === 'radio') {
            input = (
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {(field.options || []).map(opt => (
                  <label key={opt.value ?? opt} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      checked={fval === (opt.value ?? opt)}
                      onChange={() => setValue(field.key, opt.value ?? opt)}
                      disabled={field.disabled || busy}
                      style={{ accentColor: '#6366f1' }}
                    />
                    {opt.label ?? opt}
                  </label>
                ))}
              </div>
            );
          } else if (field.type === 'hidden') {
            return <input key={key} type="hidden" value={fval} />;
          }

          return (
            <FieldWrapper key={key} field={field} error={err}>
              {input}
            </FieldWrapper>
          );
        })}
      </div>

      {submitErr && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#fee2e2', borderRadius: 8, fontSize: 13, color: '#991b1b', marginBottom: 14 }}>
          <AlertCircle size={15} /> {submitErr}
        </div>
      )}
      {submitOK && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#dcfce7', borderRadius: 8, fontSize: 13, color: '#166534', marginBottom: 14 }}>
          <CheckCircle size={15} /> Saved successfully!
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}
            style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151' }}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy}
          style={{
            padding: '9px 22px',
            background: busy ? '#c7d2fe' : '#6366f1',
            color: '#fff', border: 'none', borderRadius: 8,
            fontSize: 13, fontWeight: 700,
            cursor: busy ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 7,
          }}>
          {busy
            ? <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #fff8', borderTopColor: '#fff', borderRadius: '50%', animation: 'fe-spin .6s linear infinite' }} />
            : <CheckCircle size={14} />}
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
      <style>{`@keyframes fe-spin { to { transform: rotate(360deg); } }`}</style>
    </form>
  );
}

