import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const PURPLE = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const SECTIONS = [
  {
    id: 'gst',
    title: 'GST Configuration',
    icon: '🏛️',
    fields: [
      { key: 'gstin', label: 'Company GSTIN', type: 'text', placeholder: '27AAPFU0939F1ZV' },
      { key: 'gst_filing_frequency', label: 'Filing Frequency', type: 'select', options: ['Monthly','Quarterly'] },
      { key: 'gstr1_due_day', label: 'GSTR-1 Due Day of Month', type: 'number', placeholder: '11' },
      { key: 'gstr3b_due_day', label: 'GSTR-3B Due Day of Month', type: 'number', placeholder: '20' },
      { key: 'auto_gstr1_prepare', label: 'Auto-prepare GSTR-1 data', type: 'toggle' },
      { key: 'einvoice_enabled', label: 'e-Invoice enabled (above ₹5Cr turnover)', type: 'toggle' },
    ],
  },
  {
    id: 'tds',
    title: 'TDS Configuration',
    icon: '📋',
    fields: [
      { key: 'tan', label: 'TAN Number', type: 'text', placeholder: 'MUMB12345A' },
      { key: 'tds_payment_due_day', label: 'TDS Deposit Due Day', type: 'number', placeholder: '7' },
      { key: 'form24q_quarterly', label: 'File Form 24Q Quarterly', type: 'toggle' },
      { key: 'lower_deduction_check', label: 'Check Lower Deduction Certificates', type: 'toggle' },
    ],
  },
  {
    id: 'statutory',
    title: 'Statutory Compliance',
    icon: '⚖️',
    fields: [
      { key: 'pf_enabled', label: 'Provident Fund (PF)', type: 'toggle' },
      { key: 'esic_enabled', label: 'ESIC', type: 'toggle' },
      { key: 'pt_enabled', label: 'Professional Tax', type: 'toggle' },
      { key: 'lwf_enabled', label: 'Labour Welfare Fund', type: 'toggle' },
      { key: 'pf_number', label: 'PF Registration Number', type: 'text', placeholder: 'MH/MUM/000000/000' },
      { key: 'esic_number', label: 'ESIC Code', type: 'text', placeholder: '31000000000000000' },
    ],
  },
  {
    id: 'audit',
    title: 'Audit & Retention',
    icon: '📂',
    fields: [
      { key: 'audit_log_retention_years', label: 'Audit Log Retention (years)', type: 'number', placeholder: '7' },
      { key: 'financial_record_retention_years', label: 'Financial Record Retention (years)', type: 'number', placeholder: '8' },
      { key: 'enforce_document_numbering', label: 'Enforce sequential document numbering', type: 'toggle' },
    ],
  },
  {
    id: 'notifications',
    title: 'Compliance Alerts',
    icon: '🔔',
    fields: [
      { key: 'alert_gst_due', label: 'Alert 5 days before GST due date', type: 'toggle' },
      { key: 'alert_tds_due', label: 'Alert 3 days before TDS deposit due', type: 'toggle' },
      { key: 'alert_pf_due', label: 'Alert before PF/ESIC payment due', type: 'toggle' },
      { key: 'alert_itc_mismatch', label: 'Alert on GSTR-2B ITC mismatch', type: 'toggle' },
    ],
  },
];

export default function ComplianceSettings({ setPage }) {
  const [settings, setSettings] = useState({});
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.get('/settings/compliance').then(r => {
      setSettings(r.data || {});
    }).catch(() => toast.error('Could not load compliance settings'));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.post('/settings/compliance', settings);
      toast.success('Compliance settings saved');
    } catch {
      toast.error('Failed to save settings');
    } finally { setSaving(false); }
  };

  const set = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  return (
    <div style={{ padding: 24, maxWidth: 820, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontWeight: 800, fontSize: 22, color: '#1f2937', margin: 0 }}>Compliance Settings</h2>
        <p style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          Configure GST, TDS, PF/ESIC, and audit retention policies. These settings affect statutory filings.
        </p>
      </div>

      {SECTIONS.map(section => (
        <div key={section.id} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <h3 style={{ fontWeight: 700, fontSize: 15, color: '#1f2937', margin: '0 0 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>{section.icon}</span>{section.title}
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
            {section.fields.map(field => (
              <div key={field.key}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{field.label}</label>
                {field.type === 'toggle' ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={!!settings[field.key]} onChange={e => set(field.key, e.target.checked)} style={{ width: 16, height: 16, accentColor: PURPLE }} />
                    <span style={{ fontSize: 13, color: '#6b7280' }}>{settings[field.key] ? 'Enabled' : 'Disabled'}</span>
                  </label>
                ) : field.type === 'select' ? (
                  <select value={settings[field.key] || ''} onChange={e => set(field.key, e.target.value)} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13 }}>
                    <option value="">Select…</option>
                    {field.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input type={field.type} value={settings[field.key] ?? ''} onChange={e => set(field.key, e.target.value)} placeholder={field.placeholder} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 13, boxSizing: 'border-box' }} />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
        <button onClick={() => setPage?.('GSTModule')} style={{ padding: '10px 24px', borderRadius: 8, border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ padding: '10px 24px', borderRadius: 8, background: saving ? '#d1d5db' : PURPLE, color: '#fff', fontWeight: 700, fontSize: 14, border: 'none', cursor: saving ? 'not-allowed' : 'pointer' }}>{saving ? 'Saving…' : 'Save Settings'}</button>
      </div>
    </div>
  );
}
