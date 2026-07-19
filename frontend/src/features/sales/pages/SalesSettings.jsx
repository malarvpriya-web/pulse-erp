import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Save, RefreshCw, Settings } from 'lucide-react';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const FY_OPTIONS = MONTHS.map((m, i) => ({ value: i + 1, label: m }));

const DEFAULTS = {
  default_currency:         'INR',
  quotation_validity_days:  30,
  order_prefix:             'SO',
  quotation_prefix:         'QUO',
  default_tax_rate:         18,
  default_place_of_supply:  'Karnataka',
  auto_invoice_on_delivery: false,
  require_approval_above:   '',
  fiscal_year_start:        4,
};

function Section({ title, children }) {
  return (
    <div style={{ background:'#fff', borderRadius:12, padding:24, border:'1px solid #f0f0f4', marginBottom:16 }}>
      <h3 style={{ fontSize:14, fontWeight:700, color:'#1f2937', margin:'0 0 18px', paddingBottom:12, borderBottom:'1px solid #f0f0f4' }}>{title}</h3>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, helpText, span, children }) {
  return (
    <div style={{ gridColumn: span ? '1/-1' : undefined }}>
      <label style={{ display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:4 }}>{label}</label>
      {children}
      {helpText && <p style={{ fontSize:11, color:'#9ca3af', margin:'4px 0 0' }}>{helpText}</p>}
    </div>
  );
}

const INPUT = { width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box', background:'#fff' };

export default function SalesSettings() {
  const toast = useToast();
  const [saved,    setSaved]    = useState(DEFAULTS);
  const [form,     setForm]     = useState(DEFAULTS);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);

  const isDirty = JSON.stringify(form) !== JSON.stringify(saved);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/sales/settings')
      .then(r => {
        const s = {
          default_currency:         r.data?.default_currency         ?? DEFAULTS.default_currency,
          quotation_validity_days:  r.data?.quotation_validity_days  ?? DEFAULTS.quotation_validity_days,
          order_prefix:             r.data?.order_prefix             ?? DEFAULTS.order_prefix,
          quotation_prefix:         r.data?.quotation_prefix         ?? DEFAULTS.quotation_prefix,
          default_tax_rate:         r.data?.default_tax_rate         ?? DEFAULTS.default_tax_rate,
          default_place_of_supply:  r.data?.default_place_of_supply  ?? DEFAULTS.default_place_of_supply,
          auto_invoice_on_delivery: r.data?.auto_invoice_on_delivery ?? DEFAULTS.auto_invoice_on_delivery,
          require_approval_above:   r.data?.require_approval_above   != null ? String(r.data.require_approval_above) : '',
          fiscal_year_start:        r.data?.fiscal_year_start        ?? DEFAULTS.fiscal_year_start,
        };
        setSaved(s);
        setForm(s);
      })
      .catch(() => toast.error('Could not load sales settings'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put('/sales/settings', {
        ...form,
        quotation_validity_days: Number(form.quotation_validity_days),
        default_tax_rate:        Number(form.default_tax_rate),
        fiscal_year_start:       Number(form.fiscal_year_start),
        require_approval_above:  form.require_approval_above !== '' ? Number(form.require_approval_above) : null,
      });
      toast.success('Settings saved');
      setSaved(form);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save settings');
    } finally { setSaving(false); }
  }

  if (loading) {
    return (
      <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>
        <RefreshCw size={24} style={{ marginBottom:8, display:'block', margin:'0 auto 8px' }}/>
        Loading settings...
      </div>
    );
  }

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ width:40, height:40, borderRadius:10, background:'#ede9fe', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <Settings size={20} color="#6B3FDB"/>
          </div>
          <div>
            <h1 style={{ fontSize:20, fontWeight:700, color:'#1f2937', margin:0 }}>Sales Settings</h1>
            <p style={{ color:'#9ca3af', fontSize:12, margin:'2px 0 0' }}>Configure defaults for Sales module</p>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {isDirty && <span style={{ fontSize:12, color:'#f59e0b', fontWeight:600 }}>Unsaved changes</span>}
          <button onClick={handleSave} disabled={saving || !isDirty}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 20px', background: isDirty ? '#6B3FDB' : '#e5e7eb', color: isDirty ? '#fff' : '#9ca3af', border:'none', borderRadius:8, cursor: isDirty ? 'pointer' : 'not-allowed', fontSize:13, fontWeight:600 }}>
            <Save size={14}/>{saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      <form onSubmit={handleSave}>

        {/* General */}
        <Section title="General">
          <Field label="Default Currency">
            <select value={form.default_currency} onChange={e => set('default_currency', e.target.value)} style={INPUT}>
              {['INR','USD','EUR','GBP','AED'].map(c => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Fiscal Year Start" helpText="India FY typically starts April">
            <select value={form.fiscal_year_start} onChange={e => set('fiscal_year_start', Number(e.target.value))} style={INPUT}>
              {FY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="Default Place of Supply" helpText="Used for GST place of supply on quotations">
            <input value={form.default_place_of_supply} onChange={e => set('default_place_of_supply', e.target.value)} placeholder="Karnataka" style={INPUT}/>
          </Field>
          <Field label="Default Tax Rate (%)" helpText="Pre-filled GST rate on new quotations">
            <input type="number" min="0" max="100" step="0.01" value={form.default_tax_rate} onChange={e => set('default_tax_rate', e.target.value)} placeholder="18" style={INPUT}/>
          </Field>
        </Section>

        {/* Quotations & Orders */}
        <Section title="Quotations & Orders">
          <Field label="Quotation Validity (days)" helpText="Default validity period for new quotations">
            <input type="number" min="1" value={form.quotation_validity_days} onChange={e => set('quotation_validity_days', e.target.value)} placeholder="30" style={INPUT}/>
          </Field>
          <Field label="Quotation Prefix" helpText="e.g. QUO → QUO-0001">
            <input value={form.quotation_prefix} onChange={e => set('quotation_prefix', e.target.value)} placeholder="QUO" maxLength={10} style={INPUT}/>
          </Field>
          <Field label="Sales Order Prefix" helpText="e.g. SO → SO-0001">
            <input value={form.order_prefix} onChange={e => set('order_prefix', e.target.value)} placeholder="SO" maxLength={10} style={INPUT}/>
          </Field>
          <Field label="Require Approval Above (₹)" helpText="Leave blank to disable approval gate">
            <input type="number" min="0" step="1" value={form.require_approval_above} onChange={e => set('require_approval_above', e.target.value)} placeholder="e.g. 500000" style={INPUT}/>
          </Field>
        </Section>

        {/* Automation */}
        <Section title="Automation">
          <Field label="Auto-Invoice on Delivery" helpText="Automatically raise an invoice when a sales order is marked delivered" span>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:4 }}>
              <input type="checkbox" id="auto_inv" checked={!!form.auto_invoice_on_delivery} onChange={e => set('auto_invoice_on_delivery', e.target.checked)} style={{ width:16, height:16, cursor:'pointer' }}/>
              <label htmlFor="auto_inv" style={{ fontSize:13, color:'#374151', cursor:'pointer' }}>
                {form.auto_invoice_on_delivery ? 'Enabled — invoice created automatically on delivery' : 'Disabled — invoice must be created manually'}
              </label>
            </div>
          </Field>
        </Section>

      </form>
    </div>
  );
}
