import { useState, useEffect, useRef } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Building2, Save, RefreshCw } from 'lucide-react';

// GSTIN prefix → state mapping (first 2 digits)
const GSTIN_PREFIX_TO_STATE = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli', '27': 'Maharashtra',
  '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
  '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh',
};

const STATE_TO_PREFIX = Object.fromEntries(
  Object.entries(GSTIN_PREFIX_TO_STATE).map(([k, v]) => [v, k])
);

function validateGSTIN(gstin, selectedState) {
  if (!gstin || gstin.length !== 15) return 'GSTIN must be exactly 15 characters';
  const prefix = gstin.substring(0, 2);
  if (!/^\d{2}$/.test(prefix)) return 'GSTIN must start with a 2-digit state code';
  if (selectedState) {
    const expectedPrefix = STATE_TO_PREFIX[selectedState];
    if (expectedPrefix && prefix !== expectedPrefix) {
      return `GSTIN code ${prefix} does not match ${selectedState} (expected ${expectedPrefix}...)`;
    }
  }
  return null;
}

function deriveStateFromGSTIN(gstin) {
  if (!gstin || gstin.length < 2) return null;
  return GSTIN_PREFIX_TO_STATE[gstin.substring(0, 2)] || null;
}

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab',
  'Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand',
  'West Bengal','Andaman and Nicobar Islands','Chandigarh','Dadra and Nagar Haveli',
  'Daman and Diu','Delhi','Lakshadweep','Puducherry','Jammu and Kashmir','Ladakh',
];

const EMPTY = {
  name: '', gstin: '', pan: '', tan: '', cin: '',
  address: '', city: '', state: '', country: 'India', pincode: '',
  phone: '', email: '', website: '', logo_url: '',
};

function Field({ label, value, onChange, placeholder, hint, type = 'text', required = false }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
        {label}{required && <span style={{ color: '#ef4444' }}> *</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder || label}
        style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' }}
      />
      {hint && <p style={{ fontSize: 11, color: '#9ca3af', margin: '3px 0 0' }}>{hint}</p>}
    </div>
  );
}

export default function CompanyProfile() {
  const [form, setForm]       = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [companyId, setCompanyId] = useState(null);
  const [gstinError, setGstinError] = useState(null);
  const isMounted = useRef(true);
  const toast = useToast();

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = () => {
    setLoading(true);
    api.get('/company-profile')
      .then(r => {
        if (!isMounted.current) return;
        const d = r.data;
        if (d) {
          setCompanyId(d.id);
          setForm({
            name:     d.name     || '',
            gstin:    d.gstin    || '',
            pan:      d.pan      || '',
            tan:      d.tan      || '',
            cin:      d.cin      || '',
            address:  d.address  || '',
            city:     d.city     || '',
            state:    d.state    || '',
            country:  d.country  || 'India',
            pincode:  d.pincode  || '',
            phone:    d.phone    || '',
            email:    d.email    || '',
            website:  d.website  || '',
            logo_url: d.logo_url || '',
          });
        }
      })
      .catch(() => { if (isMounted.current) toast.error('Could not load company profile'); })
      .finally(() => { if (isMounted.current) setLoading(false); });
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (field) => (val) => setForm(p => ({ ...p, [field]: val }));

  const handleGSTINChange = (val) => {
    const upper = val.toUpperCase();
    set('gstin')(upper);
    if (upper.length >= 2) {
      const derivedState = deriveStateFromGSTIN(upper);
      if (derivedState && !form.state) {
        setForm(p => ({ ...p, gstin: upper, state: derivedState }));
        return;
      }
    }
    if (upper.length === 15) {
      setGstinError(validateGSTIN(upper, form.state));
    } else {
      setGstinError(null);
    }
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('Company name is required'); return; }
    if (form.gstin && form.gstin.length > 0) {
      const gstErr = validateGSTIN(form.gstin, form.state);
      if (gstErr) { toast.error(gstErr); setGstinError(gstErr); return; }
    }
    setSaving(true);
    try {
      await api.put('/company-profile', form);
      toast.success('Company profile saved');
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally { if (isMounted.current) setSaving(false); }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>;

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ background: '#ede9fe', borderRadius: 10, padding: 10 }}><Building2 size={20} color="#6B3FDB" /></div>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: '#1f2937', margin: 0 }}>Company Profile</h1>
            <p style={{ color: '#6b7280', margin: 0, fontSize: 13 }}>Legal identity, tax registration numbers, and contact details</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.7 : 1 }}
        >
          {saving ? <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />}
          {saving ? 'Saving...' : 'Save Profile'}
        </button>
      </div>

      {/* Info banner */}
      <div style={{ background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 10, padding: '12px 16px', marginBottom: 24, fontSize: 13, color: '#5b21b6' }}>
        GSTIN, PAN, and TAN appear on GST exports, TDS returns, and payslips. Keep these accurate before going live.
      </div>

      {/* Section: Company Identity */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#1f2937', marginTop: 0, marginBottom: 16 }}>Company Identity</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ gridColumn: '1/-1' }}>
            <Field label="Company Name" value={form.name} onChange={set('name')} required placeholder="Manifest Technologies Pvt. Ltd." />
          </div>
          <div>
            <Field
              label="GSTIN"
              value={form.gstin}
              onChange={handleGSTINChange}
              placeholder="29AAAAA0000A1ZX"
              hint="15-character GST Identification Number (first 2 digits = state code)"
            />
            {gstinError && (
              <p style={{ fontSize: 11, color: '#ef4444', margin: '3px 0 0', fontWeight: 500 }}>{gstinError}</p>
            )}
          </div>
          <Field
            label="PAN"
            value={form.pan}
            onChange={v => set('pan')(v.toUpperCase())}
            placeholder="AAAAA0000A"
            hint="10-character Permanent Account Number"
          />
          <Field
            label="TAN"
            value={form.tan}
            onChange={v => set('tan')(v.toUpperCase())}
            placeholder="AAAA00000A"
            hint="Tax Deduction and Collection Account Number"
          />
          <Field
            label="CIN"
            value={form.cin}
            onChange={v => set('cin')(v.toUpperCase())}
            placeholder="U72900KA2010PTC123456"
            hint="Corporate Identification Number (21 characters)"
          />
        </div>
      </div>

      {/* Section: Address */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#1f2937', marginTop: 0, marginBottom: 16 }}>Registered Address</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div style={{ gridColumn: '1/-1' }}>
            <Field label="Street Address" value={form.address} onChange={set('address')} placeholder="Plot No, Street, Area" />
          </div>
          <Field label="City" value={form.city} onChange={set('city')} />
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>State</label>
            <select
              value={form.state}
              onChange={e => set('state')(e.target.value)}
              style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}
            >
              <option value="">Select State</option>
              {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <Field label="Pincode" value={form.pincode} onChange={set('pincode')} placeholder="560001" />
          <Field label="Country" value={form.country} onChange={set('country')} />
        </div>
      </div>

      {/* Section: Contact */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: 24, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#1f2937', marginTop: 0, marginBottom: 16 }}>Contact Details</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Phone" value={form.phone} onChange={set('phone')} placeholder="+91 80 1234 5678" />
          <Field label="Email" value={form.email} onChange={set('email')} type="email" placeholder="info@company.com" />
          <div style={{ gridColumn: '1/-1' }}>
            <Field label="Website" value={form.website} onChange={set('website')} placeholder="https://www.company.com" />
          </div>
          <div style={{ gridColumn: '1/-1' }}>
            <Field label="Logo URL" value={form.logo_url} onChange={set('logo_url')} placeholder="https://..." hint="Paste a public URL to your company logo. Used in payslips and documents." />
            {form.logo_url && (
              <img src={form.logo_url} alt="Logo preview" onError={e => { e.target.style.display = 'none'; }}
                style={{ marginTop: 8, height: 48, objectFit: 'contain', border: '1px solid #f0f0f4', borderRadius: 6, padding: 4 }} />
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 24px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600, opacity: saving ? 0.7 : 1 }}
        >
          <Save size={15} /> {saving ? 'Saving...' : 'Save Profile'}
        </button>
      </div>
    </div>
  );
}
