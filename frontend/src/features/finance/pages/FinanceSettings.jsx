import React, { useState, useEffect } from 'react';
import { Landmark, ArrowLeft } from 'lucide-react';
import api from '@/services/api/client';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const INDIA_STATES = [
  '', // blank first option — forces explicit selection
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
  'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
  'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Delhi', 'Jammu & Kashmir', 'Ladakh', 'Puducherry', 'Chandigarh',
];

const GST_REGISTRATION_TYPES = [
  { value: '',             label: '— Select —' },
  { value: 'regular',     label: 'Regular' },
  { value: 'composition', label: 'Composition Scheme' },
  { value: 'unregistered',label: 'Unregistered' },
  { value: 'sez',         label: 'SEZ' },
  { value: 'deemed_export',label: 'Deemed Export' },
];

const TABS = ['General', 'Compliance', 'Fixed Assets', 'Payroll Link', 'Integrations'];

const SECTIONS = {
  General: [
    {
      title: 'Fiscal Year',
      description: 'Define your financial year boundaries and labelling',
      fields: [
        {
          key: 'fiscal_year_start_month',
          label: 'Fiscal Year Start Month',
          type: 'select',
          options: [{ value: '', label: '— Select month —' }, ...MONTHS],
        },
        {
          key: 'fy_label_format',
          label: 'Financial Year Label Format',
          type: 'select',
          options: [
            { value: '',      label: '— Select —' },
            { value: 'short', label: 'FY 2025-26' },
            { value: 'long',  label: '2025-2026' },
          ],
        },
      ],
    },
    {
      title: 'Currency & Number Format',
      description: 'Base currency and display formatting',
      fields: [
        {
          key: 'base_currency',
          label: 'Base Currency',
          type: 'select',
          options: [
            { value: '',    label: '— Select —' },
            { value: 'INR', label: 'INR' },
            { value: 'USD', label: 'USD' },
            { value: 'EUR', label: 'EUR' },
            { value: 'GBP', label: 'GBP' },
            { value: 'AED', label: 'AED' },
            { value: 'SGD', label: 'SGD' },
          ],
        },
        {
          key: 'decimal_places',
          label: 'Decimal Places',
          type: 'select',
          options: [
            { value: '',  label: '— Select —' },
            { value: '0', label: 'None (e.g. ₹1,234)' },
            { value: '2', label: '2 (e.g. ₹1,234.56)' },
          ],
        },
        {
          key: 'thousand_separator',
          label: 'Thousand Separator Style',
          type: 'select',
          options: [
            { value: '',        label: '— Select —' },
            { value: 'indian',  label: 'Indian (1,00,000)' },
            { value: 'western', label: 'Western (100,000)' },
            { value: 'none',    label: 'None (100000)' },
          ],
        },
        {
          key: 'date_format',
          label: 'Date Display Format',
          type: 'select',
          options: [
            { value: '',             label: '— Select —' },
            { value: 'DD/MM/YYYY',   label: 'DD/MM/YYYY (Indian standard)' },
            { value: 'YYYY-MM-DD',   label: 'YYYY-MM-DD (ISO)' },
            { value: 'MMM DD, YYYY', label: 'Mar 31, 2026' },
          ],
        },
      ],
    },
    {
      title: 'GST',
      description: 'Goods & Services Tax configuration',
      fields: [
        {
          key: 'default_gst_rate',
          label: 'Default GST Rate (%)',
          type: 'text',
          placeholder: 'e.g. 18',
          helpText: 'Applied when creating invoices without an explicit HSN/SAC rate',
        },
        {
          key: 'place_of_supply_state',
          label: 'Default Place of Supply (State)',
          type: 'select',
          options: INDIA_STATES,
          helpText: 'Determines CGST/SGST (intrastate) vs IGST (interstate) split',
        },
        {
          key: 'composition_scheme',
          label: 'Composition Scheme',
          type: 'toggle',
          helpText: 'Enable for businesses under the GST composition scheme (turnover < ₹1.5Cr)',
        },
        {
          key: 'gst_rounding',
          label: 'GST Rounding Method',
          type: 'select',
          options: [
            { value: '',      label: '— Select —' },
            { value: 'round', label: 'Round to nearest paisa' },
            { value: 'floor', label: 'Floor (round down)' },
            { value: 'ceil',  label: 'Ceiling (round up)' },
          ],
        },
      ],
    },
    {
      title: 'Accounting Controls',
      description: 'Journal entry rules and period management',
      fields: [
        {
          key: 'lock_date',
          label: 'Transaction Lock Date',
          type: 'text',
          placeholder: 'YYYY-MM-DD',
          helpText: 'Entries dated on or before this date are blocked. Leave blank to allow all dates.',
        },
        {
          key: 'auto_close_reminder_days',
          label: 'Month-End Close Reminder (days before)',
          type: 'text',
          placeholder: 'e.g. 3',
          helpText: 'System sends a closing-reminder notification N days before period end',
        },
        {
          key: 'cost_centers_enabled',
          label: 'Enable Cost Centers',
          type: 'toggle',
          helpText: 'Allow journal entries to be tagged with a cost center for department-wise P&L',
        },
        {
          key: 'require_narration',
          label: 'Require Narration on Journal Lines',
          type: 'toggle',
          helpText: 'Enforce a description on every journal entry line',
        },
      ],
    },
    {
      title: 'Reports',
      description: 'Default export and display settings for financial reports',
      fields: [
        {
          key: 'report_default_format',
          label: 'Default Export Format',
          type: 'select',
          options: [
            { value: '',      label: '— Select —' },
            { value: 'csv',   label: 'CSV' },
            { value: 'excel', label: 'Excel (.xlsx)' },
            { value: 'pdf',   label: 'PDF' },
          ],
        },
        {
          key: 'report_show_zeros',
          label: 'Show Zero-Balance Accounts in Reports',
          type: 'toggle',
          helpText: 'Include accounts with no activity in Trial Balance and P&L',
        },
      ],
    },
  ],

  Compliance: [
    {
      title: 'Statutory Identifiers',
      description: 'GST, PAN, and compliance identifiers required for tax filing and e-invoicing',
      fields: [
        {
          key: 'gstin',
          label: 'GSTIN',
          type: 'text',
          placeholder: '33AAAAA0000A1Z5',
          helpText: '15-character GST Identification Number. First 2 digits = state code.',
        },
        {
          key: 'pan',
          label: 'PAN',
          type: 'text',
          placeholder: 'AAAAA0000A',
          helpText: '10-character Permanent Account Number',
        },
        {
          key: 'gst_registration_type',
          label: 'GST Registration Type',
          type: 'select',
          options: GST_REGISTRATION_TYPES,
        },
        {
          key: 'gst_filing_frequency',
          label: 'GST Filing Frequency',
          type: 'select',
          options: [
            { value: '',          label: '— Select —' },
            { value: 'monthly',   label: 'Monthly (GSTR-1 + GSTR-3B)' },
            { value: 'quarterly', label: 'Quarterly (QRMP scheme)' },
          ],
        },
        {
          key: 'lut_bond_number',
          label: 'LUT / Bond Number',
          type: 'text',
          placeholder: 'AD290524123456',
          helpText: 'Letter of Undertaking for zero-rated exports. Leave blank if not applicable.',
        },
        {
          key: 'einvoice_applicable',
          label: 'E-Invoice Applicable',
          type: 'toggle',
          helpText: 'Mandatory for aggregate turnover > ₹5 Cr. Enables IRP e-invoice generation.',
        },
        {
          key: 'eway_bill_applicable',
          label: 'E-Way Bill Applicable',
          type: 'toggle',
          helpText: 'Required for goods movement > ₹50,000 in value.',
        },
        {
          key: 'tds_applicable',
          label: 'TDS Applicable',
          type: 'toggle',
          helpText: 'Enable TDS deduction tracking on vendor payments',
        },
        {
          key: 'tds_tan',
          label: 'TAN (Tax Deduction Account Number)',
          type: 'text',
          placeholder: 'AAAA00000A',
          helpText: 'Required if TDS is deducted and remitted to income tax dept.',
        },
        {
          key: 'msme_registered',
          label: 'MSME Registered',
          type: 'toggle',
          helpText: 'Mark for MSME payment tracking (45-day rule for overdue payments)',
        },
      ],
    },
  ],

  'Fixed Assets': [
    {
      title: 'Fixed Assets',
      description: 'Default depreciation settings for new assets',
      fields: [
        {
          key: 'default_depreciation_method',
          label: 'Default Depreciation Method',
          type: 'select',
          options: [
            { value: '',    label: '— Select —' },
            { value: 'SLM', label: 'Straight-Line Method (SLM)' },
            { value: 'WDV', label: 'Written-Down Value (WDV / Declining Balance)' },
          ],
          helpText: 'Applied to new assets unless overridden per asset',
        },
        {
          key: 'default_useful_life_years',
          label: 'Default Useful Life (years)',
          type: 'text',
          placeholder: 'e.g. 5',
        },
        {
          key: 'capex_threshold',
          label: 'Capitalisation Threshold (₹)',
          type: 'text',
          placeholder: 'e.g. 5000',
          helpText: 'Purchases below this amount are expensed; above it are capitalised',
        },
      ],
    },
  ],

  'Payroll Link': [
    {
      title: 'Payroll → Finance Link',
      description: 'Automatic journal entries when payroll is processed',
      fields: [
        {
          key: 'payroll_auto_post',
          label: 'Auto-post Payroll Journal on Run Completion',
          type: 'toggle',
          helpText: 'Creates DR Salaries / CR Salary Payable entry automatically',
        },
        {
          key: 'salary_expense_account',
          label: 'Salary Expense Account Code',
          type: 'text',
          placeholder: 'e.g. 5010',
          helpText: 'COA account to debit for gross salary (e.g. 5010 — Salaries & Wages)',
        },
        {
          key: 'salary_payable_account',
          label: 'Salary Payable Account Code',
          type: 'text',
          placeholder: 'e.g. 2040',
          helpText: 'COA account to credit when salary is accrued (e.g. 2040 — Salary Payable)',
        },
      ],
    },
  ],

  Integrations: [
    {
      title: 'Payment Gateway',
      description: 'Online payment collection via Razorpay or other providers',
      fields: [
        {
          key: 'pg_provider',
          label: 'Provider',
          type: 'select',
          options: [
            { value: '',         label: '— Select —' },
            { value: 'none',     label: 'Manual only (no gateway)' },
            { value: 'razorpay', label: 'Razorpay' },
            { value: 'paytm',    label: 'Paytm' },
            { value: 'ccavenue', label: 'CCAvenue' },
          ],
        },
        {
          key: 'pg_key_id',
          label: 'Key ID',
          type: 'text',
          placeholder: 'rzp_live_…',
          helpText: 'API key ID. Stored encrypted.',
        },
        {
          key: 'pg_key_secret',
          label: 'Key Secret',
          type: 'password',
          placeholder: '••••••••••••••••',
          helpText: 'API secret. Never displayed after save.',
        },
        {
          key: 'pg_webhook_secret',
          label: 'Webhook Secret',
          type: 'password',
          placeholder: '••••••••••••••••',
          helpText: 'Used to verify payment webhook signatures.',
        },
        {
          key: 'pg_mode',
          label: 'Mode',
          type: 'select',
          options: [
            { value: '',     label: '— Select —' },
            { value: 'test', label: 'Test (sandbox)' },
            { value: 'live', label: 'Live (production)' },
          ],
        },
      ],
    },
    {
      title: 'Forex Rates',
      description: 'Automatic exchange rate fetching for multi-currency invoices',
      fields: [
        {
          key: 'forex_provider',
          label: 'Forex Provider',
          type: 'select',
          options: [
            { value: '',             label: '— Select —' },
            { value: 'none',         label: 'Manual only' },
            { value: 'frankfurter',  label: 'Frankfurter (free, ECB rates)' },
            { value: 'exchangerate', label: 'ExchangeRate-API' },
          ],
        },
        {
          key: 'forex_auto_fetch',
          label: 'Auto-fetch Frequency',
          type: 'select',
          options: [
            { value: '',       label: '— Select —' },
            { value: 'manual', label: 'Manual only' },
            { value: 'daily',  label: 'Daily' },
            { value: '4hours', label: 'Every 4 hours' },
            { value: 'hourly', label: 'Hourly' },
          ],
        },
      ],
    },
    {
      title: 'Bank File Export',
      description: 'Default bank format for NEFT/RTGS payment batch exports',
      fields: [
        {
          key: 'bank_export_format',
          label: 'Primary Bank',
          type: 'select',
          options: [
            { value: '',            label: '— Select —' },
            { value: 'generic_csv', label: 'Generic CSV' },
            { value: 'sbi',         label: 'SBI' },
            { value: 'hdfc',        label: 'HDFC' },
            { value: 'icici',       label: 'ICICI' },
            { value: 'axis',        label: 'Axis' },
            { value: 'kotak',       label: 'Kotak' },
          ],
        },
      ],
    },
    {
      title: 'Accounting Software Export',
      description: 'Export journal entries to desktop accounting software',
      fields: [
        {
          key: 'tally_export_enabled',
          label: 'Tally Export',
          type: 'toggle',
          helpText: 'Export journal entries as Tally XML (TallyPrime / Tally ERP 9)',
        },
        {
          key: 'busy_export_enabled',
          label: 'Busy / Marg Export',
          type: 'toggle',
          helpText: 'Export for SMEs using Busy or Marg desktop accounting',
        },
      ],
    },
  ],
};

function buildBlanks(sections) {
  const vals = {};
  Object.values(sections).forEach(sectionList =>
    sectionList.forEach(section =>
      (section.fields || []).forEach(f => {
        vals[f.key] = f.type === 'toggle' ? false : '';
      })
    )
  );
  return vals;
}

function SectionCard({ section, values, set }) {
  const inputBase = {
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 13,
    background: '#fff',
    color: '#111827',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const renderField = (field) => {
    const val = values[field.key];
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
              background: on ? '#6B3FDB' : '#d1d5db',
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
            style={{ ...inputBase, maxWidth: 240, cursor: 'pointer' }}
          >
            {(field.options || []).map(o =>
              typeof o === 'string'
                ? <option key={o} value={o}>{o || '— Select —'}</option>
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
            style={{ ...inputBase, width: 380, minHeight: 80, resize: 'vertical', lineHeight: 1.5 }}
          />
        );
      case 'password':
        return (
          <input
            type="password"
            value={val ?? ''}
            placeholder={field.placeholder || ''}
            onChange={e => set(field.key, e.target.value)}
            style={{ ...inputBase, width: 240 }}
            autoComplete="new-password"
          />
        );
      default:
        return (
          <input
            type="text"
            value={val ?? ''}
            placeholder={field.placeholder || ''}
            onChange={e => set(field.key, e.target.value)}
            style={{ ...inputBase, width: 280 }}
          />
        );
    }
  };

  return (
    <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid #f0f0f4' }}>
        <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#6b7280' }}>
          {section.title}
        </div>
        {section.description && (
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 3 }}>{section.description}</div>
        )}
      </div>
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
            <div style={{ fontSize: 14, fontWeight: 500, color: '#1f2937' }}>{field.label}</div>
            {field.helpText && (
              <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{field.helpText}</div>
            )}
          </div>
          <div style={{ flexShrink: 0, paddingTop: field.type === 'textarea' ? 4 : 0 }}>
            {renderField(field)}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function FinanceSettings({ setPage }) {
  const blanks = buildBlanks(SECTIONS);

  const [activeTab, setActiveTab] = useState('General');
  const [values,    setValues]    = useState(blanks);
  const [saved,     setSaved]     = useState(blanks);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [toast,     setToast]     = useState(null);
  const [hasSaved,  setHasSaved]  = useState(false);

  const dirty = JSON.stringify(values) !== JSON.stringify(saved);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      api.get('/settings/finance').then(r => r.data || {}).catch(() => ({})),
      api.get('/company-profile').then(r => r.data || {}).catch(() => ({})),
    ]).then(([saved, profile]) => {
      if (!alive) return;
      const merged = { ...blanks, ...saved };
      // Auto-derive place of supply from company profile if not explicitly saved
      if (!saved.place_of_supply_state && profile.state) {
        merged.place_of_supply_state = profile.state;
      }
      if (!saved.gstin && profile.gstin) merged.gstin = profile.gstin;
      setValues(merged);
      setSaved(merged);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post('/settings/finance', values);
      setSaved({ ...values });
      setHasSaved(true);
      flash('Settings saved successfully');
    } catch (err) {
      flash(err?.response?.data?.message || err.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const set = (key, val) => setValues(v => ({ ...v, [key]: val }));
  const goBack = () => setPage && setPage('SettingsCenter');

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fb', fontFamily: 'inherit', display: 'flex', flexDirection: 'column' }}>

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
          <div style={{
            width: 40, height: 40, borderRadius: 10, background: '#f5f3ff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Landmark size={20} color="#6B3FDB" />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#111827', lineHeight: 1.3 }}>
                Finance Settings
              </h1>
              {dirty && <span style={{ color: '#d97706', fontSize: 15 }} title="Unsaved changes">●</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3 }}>
              <button onClick={goBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#6B3FDB', fontSize: 12 }}>
                Settings
              </button>
              <span style={{ color: '#d1d5db', fontSize: 12 }}>/</span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Finance</span>
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

      {/* Tab bar */}
      <div style={{
        background: '#fff', borderBottom: '1px solid #f0f0f4',
        padding: '0 28px', display: 'flex', gap: 0, flexShrink: 0,
      }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '12px 16px', fontSize: 13, fontWeight: 500,
              color: activeTab === tab ? '#6B3FDB' : '#6b7280',
              borderBottom: activeTab === tab ? '2px solid #6B3FDB' : '2px solid transparent',
              transition: 'color 0.15s',
              marginBottom: -1,
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '24px 28px 120px', overflowY: 'auto' }}>
        {loading ? (
          <div style={{ color: '#9ca3af', fontSize: 14, padding: 40, textAlign: 'center' }}>
            Loading settings…
          </div>
        ) : (
          <div style={{ maxWidth: 740, display: 'flex', flexDirection: 'column', gap: 18 }}>
            {(SECTIONS[activeTab] || []).map(section => (
              <SectionCard key={section.title} section={section} values={values} set={set} />
            ))}
          </div>
        )}
      </div>

      {/* Sticky save bar */}
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
              onClick={() => setValues({ ...saved })}
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
                background: '#6B3FDB', color: '#fff', fontSize: 13, fontWeight: 600,
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
