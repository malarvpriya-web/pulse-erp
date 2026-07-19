import React, { useState, useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import api from '@/services/api/client';

function buildDefaults(sections) {
  const vals = {};
  (sections || []).forEach(section =>
    (section.fields || []).forEach(f => {
      vals[f.key] =
        f.default !== undefined ? f.default
        : f.type === 'toggle'   ? false
        : f.type === 'number'   ? 0
        : '';
    })
  );
  return vals;
}

export default function ModuleSettingsPanel({
  moduleName,
  moduleIcon: Icon,
  apiEndpoint,
  setPage,
  sections,
}) {
  const defaults = buildDefaults(sections);

  const [values,   setValues]   = useState(defaults);
  const [saved,    setSaved]    = useState(defaults);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState(null);
  const [hasSaved, setHasSaved] = useState(false);

  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  // Sync defaults when sections change (e.g. async options loaded)
  useEffect(() => {
    const d = buildDefaults(sections);
    setValues(v => ({ ...d, ...v }));
    setSaved(s => ({ ...d, ...s }));
  }, [sections]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(apiEndpoint)
      .then(res => {
        if (!alive) return;
        const d = buildDefaults(sections);
        const merged = { ...d, ...(res.data || {}) };
        setValues(merged);
        setSaved(merged);
      })
      .catch(err => {
        if (!alive) return;
        if (err?.response?.status !== 404) {
          console.error('[ModuleSettingsPanel] load failed:', err.message);
        }
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apiEndpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post(apiEndpoint, values);
      setSaved({ ...values });
      setHasSaved(true);
      setTimeout(() => setHasSaved(false), 3000);
      flash('Settings saved successfully');
    } catch (err) {
      flash(err?.response?.data?.message || err.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => setValues({ ...saved });

  const set = (key, val) => setValues(v => ({ ...v, [key]: val }));

  const renderField = (field) => {
    const val = values[field.key];

    const base = {
      border: '1px solid #e5e7eb',
      borderRadius: 6,
      padding: '7px 10px',
      fontSize: 13,
      background: '#fff',
      color: '#111827',
      outline: 'none',
      boxSizing: 'border-box',
    };

    switch (field.type) {
      case 'toggle': {
        const on = Boolean(val);
        return (
          <button
            onClick={() => set(field.key, !on)}
            role="switch"
            aria-checked={on}
            style={{
              width: 44, height: 24, borderRadius: 12, border: 'none',
              background: on ? '#7c3aed' : '#d1d5db',
              cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0,
            }}
          >
            <span style={{
              position: 'absolute', top: 2,
              left: on ? 22 : 2,
              width: 20, height: 20, borderRadius: '50%', background: '#fff',
              transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
            }} />
          </button>
        );
      }

      case 'select':
        return (
          <select
            value={val ?? ''}
            onChange={e => set(field.key, e.target.value)}
            style={{ ...base, maxWidth: 220, cursor: 'pointer' }}
          >
            {(field.options || []).map(o =>
              typeof o === 'string'
                ? <option key={o} value={o}>{o}</option>
                : <option key={o.value} value={o.value}>{o.label}</option>
            )}
          </select>
        );

      case 'textarea':
        return (
          <textarea
            value={val ?? ''}
            placeholder={field.placeholder || ''}
            onChange={e => set(field.key, e.target.value)}
            style={{ ...base, width: 380, minHeight: 80, resize: 'vertical', lineHeight: 1.5 }}
          />
        );

      case 'number':
        return (
          <input
            type="number"
            value={val ?? 0}
            placeholder={field.placeholder || ''}
            onChange={e => set(field.key, e.target.value === '' ? 0 : Number(e.target.value))}
            style={{ ...base, width: 110 }}
          />
        );

      default:
        return (
          <input
            type="text"
            value={val ?? ''}
            placeholder={field.placeholder || ''}
            onChange={e => set(field.key, e.target.value)}
            style={{ ...base, width: 280 }}
          />
        );
    }
  };

  const goBack = () => setPage && setPage('SettingsCenter');

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fb', fontFamily: 'inherit', display: 'flex', flexDirection: 'column' }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 24, zIndex: 9999,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
          color: '#fff', padding: '10px 20px', borderRadius: 8,
          fontSize: 13, fontWeight: 500, boxShadow: '0 4px 14px rgba(0,0,0,0.15)',
        }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{
        background: '#fff', borderBottom: '1px solid #f0f0f4',
        padding: '16px 28px', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: 16, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {Icon && (
            <div style={{
              width: 40, height: 40, borderRadius: 10, background: '#f5f3ff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <Icon size={20} color="#7c3aed" />
            </div>
          )}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827', lineHeight: 1.3 }}>
                {moduleName} Settings
              </h1>
              {dirty && (
                <span style={{ color: '#d97706', fontSize: 15 }} title="Unsaved changes">●</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
              <button
                onClick={goBack}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#7c3aed', fontSize: 12 }}
              >
                Settings
              </button>
              <span style={{ color: '#d1d5db', fontSize: 12 }}>/</span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>{moduleName}</span>
            </div>
          </div>
        </div>

        <button
          onClick={goBack}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'none', border: '1px solid #e5e7eb', borderRadius: 7,
            padding: '7px 14px', cursor: 'pointer', color: '#374151', fontSize: 13, fontWeight: 500,
          }}
        >
          <ArrowLeft size={14} />
          Back to Settings
        </button>
      </div>

      {/* Sections */}
      <div style={{ flex: 1, padding: '24px 28px 120px', overflowY: 'auto' }}>
        {loading ? (
          <div style={{ color: '#9ca3af', fontSize: 14, padding: 40, textAlign: 'center' }}>
            Loading settings…
          </div>
        ) : (
          <div style={{ maxWidth: 740, display: 'flex', flexDirection: 'column', gap: 18 }}>
            {(sections || []).map(section => (
              <div key={section.title} style={{
                background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden',
              }}>
                {/* Section header */}
                <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4' }}>
                  <div style={{
                    fontSize: 12, fontWeight: 600, textTransform: 'uppercase',
                    letterSpacing: '0.05em', color: '#6b7280',
                  }}>
                    {section.title}
                  </div>
                  {section.description && (
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 3 }}>
                      {section.description}
                    </div>
                  )}
                </div>

                {/* Fields */}
                {(section.fields || []).map((field, fi) => (
                  <div key={field.key} style={{
                    display: 'flex',
                    alignItems: field.type === 'textarea' ? 'flex-start' : 'center',
                    justifyContent: 'space-between',
                    padding: '13px 20px',
                    gap: 16,
                    borderBottom: fi < section.fields.length - 1 ? '1px solid #f9f9fb' : 'none',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500, color: '#1f2937' }}>
                        {field.label}
                      </div>
                      {field.helpText && (
                        <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                          {field.helpText}
                        </div>
                      )}
                    </div>
                    <div style={{ flexShrink: 0, paddingTop: field.type === 'textarea' ? 4 : 0 }}>
                      {renderField(field)}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sticky bottom bar */}
      {!loading && (
        <div style={{
          position: 'sticky', bottom: 0, background: '#fff',
          borderTop: dirty ? '2px solid #fbbf24' : '1px solid #f0f0f4',
          padding: '13px 28px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          boxShadow: '0 -2px 8px rgba(0,0,0,0.04)', zIndex: 10,
        }}>
          <span style={{ fontSize: 13, color: dirty ? '#d97706' : '#9ca3af' }}>
            {dirty ? 'You have unsaved changes' : hasSaved ? '✓ All changes saved' : null}
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={handleDiscard}
              disabled={!dirty || saving}
              style={{
                padding: '8px 18px', borderRadius: 7, border: '1px solid #e5e7eb',
                background: '#fff', color: '#374151', fontSize: 13, fontWeight: 500,
                cursor: !dirty || saving ? 'default' : 'pointer',
                opacity: !dirty || saving ? 0.45 : 1,
              }}
            >
              Discard
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '8px 20px', borderRadius: 7, border: 'none',
                background: '#7c3aed', color: '#fff', fontSize: 13, fontWeight: 600,
                cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
