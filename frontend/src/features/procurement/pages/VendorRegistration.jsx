/**
 * Phase 49C-1 — Vendor Self-Registration Portal
 * Public multi-step wizard. No authentication required.
 * Steps: Company Info → Business Details → Contacts → Bank → Documents → Review → OTP
 */
import { useState, useCallback } from 'react';
import axios from 'axios';

const API = import.meta.env.VITE_API_URL || '';
const api = axios.create({ baseURL: `${API}/api/v1` });

const VENDOR_TYPES = [
  'Raw Material', 'Electrical Components', 'Electronics', 'Semiconductors',
  'Transformers', 'Fabrication', 'Machining', 'Packaging', 'Logistics',
  'Service Provider', 'Commissioning Partner', 'AMC Partner', 'Consultant',
  'Contract Labour', 'Other',
];

const CONTACT_TYPES = ['Commercial', 'Technical', 'Quality', 'Finance', 'Management'];
const DOC_TYPES = [
  'GST Certificate', 'PAN', 'MSME Certificate', 'Udyam Certificate',
  'ISO Certificate', 'Factory License', 'Bank Proof', 'Cancelled Cheque',
  'NDA', 'Supplier Agreement', 'Technical Catalogue', 'Quality Certificate',
  'Test Report',
];

const STEPS = [
  { id: 1, label: 'Company Info' },
  { id: 2, label: 'Business Details' },
  { id: 3, label: 'Contacts' },
  { id: 4, label: 'Bank Details' },
  { id: 5, label: 'Documents' },
  { id: 6, label: 'Review' },
  { id: 7, label: 'OTP Verify' },
];

function emptyContact() {
  return { type: 'Commercial', name: '', designation: '', phone: '', mobile: '', email: '' };
}

export default function VendorRegistration() {
  const [step, setStep] = useState(1);
  const [registrationId, setRegistrationId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [dupWarning, setDupWarning] = useState(null);

  // Step 1 — Company Info
  const [company, setCompany] = useState({
    vendor_name: '', vendor_type: '', gstin: '', pan: '',
    msme_status: false, udyam_number: '', iec: '', cin: '',
    website: '', year_established: '', employee_count: '', annual_turnover: '',
  });

  // Step 2 — Business Details
  const [business, setBusiness] = useState({
    address: '', city: '', state: '', country: 'India', pincode: '',
    contact_person: '', email: '', phone: '',
    products_services: '', technical_capability: '',
    factory_locations: '', office_locations: '',
  });

  // Step 3 — Contacts
  const [contacts, setContacts] = useState([emptyContact()]);

  // Step 4 — Bank
  const [bank, setBank] = useState({ bank_name: '', account_number: '', ifsc: '', branch: '' });

  // Step 5 — Documents
  const [docLinks, setDocLinks] = useState({});

  // Step 7 — OTP
  const [emailOtp, setEmailOtp] = useState('');
  const [mobileOtp, setMobileOtp] = useState('');
  const [emailVerified, setEmailVerified] = useState(false);
  const [mobileVerified, setMobileVerified] = useState(false);
  const [otpMsg, setOtpMsg] = useState('');

  const set = setter => e => setter(p => ({ ...p, [e.target.name]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  // ── Duplicate check on GSTIN/PAN blur ────────────────────────────────────
  const checkDuplicate = useCallback(async () => {
    try {
      const { data } = await api.post('/vendor-registration/check-duplicate', {
        gstin: company.gstin, pan: company.pan, vendor_name: company.vendor_name,
      });
      if (data.isDuplicate) setDupWarning(data.duplicates);
      else setDupWarning(null);
    } catch { /* ignore */ }
  }, [company.gstin, company.pan, company.vendor_name]);

  // ── Submit registration ───────────────────────────────────────────────────
  const submitRegistration = async () => {
    setSubmitting(true);
    setError('');
    try {
      const payload = {
        ...company,
        ...business,
        bank_name: bank.bank_name,
        account_number: bank.account_number,
        ifsc: bank.ifsc,
        branch: bank.branch,
        contact_details: contacts,
        factory_locations: business.factory_locations
          ? business.factory_locations.split(',').map(s => s.trim()).filter(Boolean)
          : [],
        office_locations: business.office_locations
          ? business.office_locations.split(',').map(s => s.trim()).filter(Boolean)
          : [],
      };

      const { data } = await api.post('/vendor-registration/submit', payload);
      setRegistrationId(data.registration_id);
      setStep(7);

      // Dev mode: auto-fill OTPs
      if (data._dev_email_otp)  setEmailOtp(data._dev_email_otp);
      if (data._dev_mobile_otp) setMobileOtp(data._dev_mobile_otp);
    } catch (err) {
      const errData = err.response?.data;
      if (errData?.isDuplicate) {
        setDupWarning(errData.duplicates);
        setError('Duplicate vendor detected. Please review the warnings above.');
      } else {
        setError(errData?.error || 'Submission failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const verifyEmailOtp = async () => {
    try {
      await api.post(`/vendor-registration/${registrationId}/verify-email`, { otp: emailOtp });
      setEmailVerified(true);
      setOtpMsg('Email verified!');
    } catch (err) { setOtpMsg(err.response?.data?.error || 'Invalid OTP'); }
  };

  const verifyMobileOtp = async () => {
    try {
      await api.post(`/vendor-registration/${registrationId}/verify-mobile`, { otp: mobileOtp });
      setMobileVerified(true);
      setOtpMsg(otpMsg + ' Mobile verified!');
    } catch (err) { setOtpMsg(err.response?.data?.error || 'Invalid OTP'); }
  };

  const finalizeRegistration = async () => {
    try {
      await api.post(`/vendor-registration/${registrationId}/finalize`);
      setSuccess(`Registration submitted successfully! Your registration ID is VR-${registrationId}. Our SCM team will review within 5–7 business days.`);
    } catch (err) { setError(err.response?.data?.error || 'Finalization failed'); }
  };

  const resendOtp = async (type) => {
    try {
      await api.post(`/vendor-registration/${registrationId}/resend-otp`, { type });
      setOtpMsg(`OTP resent to your ${type}.`);
    } catch { setOtpMsg('Resend failed.'); }
  };

  const addContact = () => setContacts(c => [...c, emptyContact()]);
  const removeContact = idx => setContacts(c => c.filter((_, i) => i !== idx));
  const updateContact = (idx, field, val) =>
    setContacts(c => c.map((ct, i) => i === idx ? { ...ct, [field]: val } : ct));

  if (success) return (
    <div style={styles.successBox}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
      <h2 style={{ color: '#16a34a', marginBottom: 12 }}>Registration Submitted!</h2>
      <p style={{ color: '#374151', lineHeight: 1.6, maxWidth: 500 }}>{success}</p>
      <p style={{ color: '#6b7280', marginTop: 16, fontSize: 14 }}>
        You can track your registration status at:<br />
        <strong>/vendor/status/{registrationId}</strong>
      </p>
    </div>
  );

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerInner}>
          <h1 style={styles.title}>Vendor Registration Portal</h1>
          <p style={styles.subtitle}>Register as an approved supplier. All information is kept confidential.</p>
        </div>
      </div>

      {/* Stepper */}
      <div style={styles.stepper}>
        {STEPS.map(s => (
          <div key={s.id} style={styles.stepItem}>
            <div style={{
              ...styles.stepCircle,
              background: step === s.id ? '#6B3FDB' : step > s.id ? '#16a34a' : '#e5e7eb',
              color: step >= s.id ? '#fff' : '#6b7280',
            }}>
              {step > s.id ? '✓' : s.id}
            </div>
            <span style={{ ...styles.stepLabel, color: step >= s.id ? '#374151' : '#9ca3af' }}>{s.label}</span>
          </div>
        ))}
      </div>

      <div style={styles.card}>
        {error && <div style={styles.errorBox}>{error}</div>}
        {dupWarning && (
          <div style={styles.warnBox}>
            <strong>Potential duplicate detected:</strong>
            {dupWarning.map((d, i) => (
              <div key={i}>· {d.field} matches existing vendor: <strong>{d.existing}</strong></div>
            ))}
            <div style={{ marginTop: 8, fontSize: 13, color: '#92400e' }}>
              If this is a different entity, please continue. Otherwise contact our procurement team.
            </div>
          </div>
        )}

        {/* ── STEP 1: Company Info ─────────────────────────────────────────── */}
        {step === 1 && (
          <div>
            <h2 style={styles.stepTitle}>Company Information</h2>
            <div style={styles.grid2}>
              <Field label="Company Name *" name="vendor_name" value={company.vendor_name} onChange={set(setCompany)} onBlur={checkDuplicate} />
              <div>
                <label style={styles.label}>Vendor Type *</label>
                <select name="vendor_type" value={company.vendor_type} onChange={set(setCompany)} style={styles.input}>
                  <option value="">Select type…</option>
                  {VENDOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <Field label="GSTIN" name="gstin" value={company.gstin} onChange={set(setCompany)} onBlur={checkDuplicate} placeholder="22AAAAA0000A1Z5" />
              <Field label="PAN" name="pan" value={company.pan} onChange={set(setCompany)} onBlur={checkDuplicate} placeholder="AAAAA0000A" />
              <Field label="Udyam Number" name="udyam_number" value={company.udyam_number} onChange={set(setCompany)} />
              <Field label="IEC Code" name="iec" value={company.iec} onChange={set(setCompany)} />
              <Field label="CIN" name="cin" value={company.cin} onChange={set(setCompany)} />
              <Field label="Website" name="website" value={company.website} onChange={set(setCompany)} placeholder="https://" />
              <Field label="Year Established" name="year_established" type="number" value={company.year_established} onChange={set(setCompany)} />
              <Field label="Employee Count" name="employee_count" type="number" value={company.employee_count} onChange={set(setCompany)} />
              <Field label="Annual Turnover (₹)" name="annual_turnover" type="number" value={company.annual_turnover} onChange={set(setCompany)} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 28 }}>
                <input type="checkbox" name="msme_status" checked={company.msme_status} onChange={set(setCompany)} id="msme" style={{ width: 18, height: 18 }} />
                <label htmlFor="msme" style={{ cursor: 'pointer', color: '#374151' }}>MSME Registered</label>
              </div>
            </div>
            <div style={styles.btnRow}>
              <button style={styles.btnPrimary} onClick={() => {
                if (!company.vendor_name || !company.vendor_type) { setError('Company Name and Vendor Type are required.'); return; }
                setError(''); setStep(2);
              }}>Next →</button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Business Details ─────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <h2 style={styles.stepTitle}>Business Details</h2>
            <div style={styles.grid2}>
              <Field label="Address *" name="address" value={business.address} onChange={set(setBusiness)} />
              <Field label="City *" name="city" value={business.city} onChange={set(setBusiness)} />
              <Field label="State *" name="state" value={business.state} onChange={set(setBusiness)} />
              <Field label="Country" name="country" value={business.country} onChange={set(setBusiness)} />
              <Field label="PIN Code" name="pincode" value={business.pincode} onChange={set(setBusiness)} />
              <Field label="Contact Person *" name="contact_person" value={business.contact_person} onChange={set(setBusiness)} />
              <Field label="Email *" name="email" type="email" value={business.email} onChange={set(setBusiness)} />
              <Field label="Phone *" name="phone" value={business.phone} onChange={set(setBusiness)} />
            </div>
            <div style={{ marginTop: 16 }}>
              <label style={styles.label}>Products / Services Offered *</label>
              <textarea name="products_services" value={business.products_services} onChange={set(setBusiness)} style={{ ...styles.input, height: 80, resize: 'vertical' }} placeholder="Describe your products and services…" />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={styles.label}>Technical Capability</label>
              <textarea name="technical_capability" value={business.technical_capability} onChange={set(setBusiness)} style={{ ...styles.input, height: 64, resize: 'vertical' }} placeholder="ISO certification, test equipment, processes…" />
            </div>
            <div style={styles.grid2}>
              <Field label="Factory Locations (comma separated)" name="factory_locations" value={business.factory_locations} onChange={set(setBusiness)} />
              <Field label="Office Locations (comma separated)" name="office_locations" value={business.office_locations} onChange={set(setBusiness)} />
            </div>
            <div style={styles.btnRow}>
              <button style={styles.btnSecondary} onClick={() => setStep(1)}>← Back</button>
              <button style={styles.btnPrimary} onClick={() => {
                if (!business.address || !business.email || !business.phone || !business.contact_person) {
                  setError('Address, Email, Phone, and Contact Person are required.'); return;
                }
                setError(''); setStep(3);
              }}>Next →</button>
            </div>
          </div>
        )}

        {/* ── STEP 3: Contacts ─────────────────────────────────────────────── */}
        {step === 3 && (
          <div>
            <h2 style={styles.stepTitle}>Contact Management</h2>
            <p style={{ color: '#6b7280', marginBottom: 16, fontSize: 14 }}>Add contacts for different departments. Commercial contact is required.</p>
            {contacts.map((c, idx) => (
              <div key={idx} style={styles.contactCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <strong style={{ color: '#374151' }}>Contact {idx + 1}</strong>
                  {idx > 0 && <button onClick={() => removeContact(idx)} style={styles.btnDanger}>Remove</button>}
                </div>
                <div style={styles.grid3}>
                  <div>
                    <label style={styles.label}>Type</label>
                    <select value={c.type} onChange={e => updateContact(idx, 'type', e.target.value)} style={styles.input}>
                      {CONTACT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <Field label="Name *" value={c.name} onChange={e => updateContact(idx, 'name', e.target.value)} />
                  <Field label="Designation" value={c.designation} onChange={e => updateContact(idx, 'designation', e.target.value)} />
                  <Field label="Phone" value={c.phone} onChange={e => updateContact(idx, 'phone', e.target.value)} />
                  <Field label="Mobile" value={c.mobile} onChange={e => updateContact(idx, 'mobile', e.target.value)} />
                  <Field label="Email" value={c.email} type="email" onChange={e => updateContact(idx, 'email', e.target.value)} />
                </div>
              </div>
            ))}
            <button onClick={addContact} style={styles.btnOutline}>+ Add Contact</button>
            <div style={styles.btnRow}>
              <button style={styles.btnSecondary} onClick={() => setStep(2)}>← Back</button>
              <button style={styles.btnPrimary} onClick={() => { setError(''); setStep(4); }}>Next →</button>
            </div>
          </div>
        )}

        {/* ── STEP 4: Bank Details ─────────────────────────────────────────── */}
        {step === 4 && (
          <div>
            <h2 style={styles.stepTitle}>Bank Details</h2>
            <p style={{ color: '#6b7280', marginBottom: 16, fontSize: 14 }}>Bank details will be verified by our Finance team before activation.</p>
            <div style={styles.grid2}>
              <Field label="Bank Name *" name="bank_name" value={bank.bank_name} onChange={set(setBank)} />
              <Field label="Account Number *" name="account_number" value={bank.account_number} onChange={set(setBank)} />
              <Field label="IFSC Code *" name="ifsc" value={bank.ifsc} onChange={set(setBank)} placeholder="SBIN0000001" />
              <Field label="Branch" name="branch" value={bank.branch} onChange={set(setBank)} />
            </div>
            <div style={styles.infoBox}>Finance verification is mandatory before your first purchase order payment.</div>
            <div style={styles.btnRow}>
              <button style={styles.btnSecondary} onClick={() => setStep(3)}>← Back</button>
              <button style={styles.btnPrimary} onClick={() => {
                if (!bank.bank_name || !bank.account_number || !bank.ifsc) {
                  setError('Bank Name, Account Number, and IFSC are required.'); return;
                }
                setError(''); setStep(5);
              }}>Next →</button>
            </div>
          </div>
        )}

        {/* ── STEP 5: Documents ────────────────────────────────────────────── */}
        {step === 5 && (
          <div>
            <h2 style={styles.stepTitle}>Document Links</h2>
            <p style={{ color: '#6b7280', marginBottom: 16, fontSize: 14 }}>
              Share Google Drive links to your documents. Our team will verify them after submission.
              Documents will be organized in a dedicated vendor folder in our Drive.
            </p>
            <div style={styles.grid2}>
              {DOC_TYPES.map(dt => (
                <div key={dt}>
                  <label style={styles.label}>{dt}</label>
                  <input
                    type="url"
                    placeholder="https://drive.google.com/…"
                    value={docLinks[dt] || ''}
                    onChange={e => setDocLinks(p => ({ ...p, [dt]: e.target.value }))}
                    style={styles.input}
                  />
                </div>
              ))}
            </div>
            <div style={styles.btnRow}>
              <button style={styles.btnSecondary} onClick={() => setStep(4)}>← Back</button>
              <button style={styles.btnPrimary} onClick={() => { setError(''); setStep(6); }}>Review →</button>
            </div>
          </div>
        )}

        {/* ── STEP 6: Review ───────────────────────────────────────────────── */}
        {step === 6 && (
          <div>
            <h2 style={styles.stepTitle}>Review & Submit</h2>
            <ReviewSection title="Company Information">
              <ReviewRow label="Company Name" value={company.vendor_name} />
              <ReviewRow label="Vendor Type" value={company.vendor_type} />
              <ReviewRow label="GSTIN" value={company.gstin} />
              <ReviewRow label="PAN" value={company.pan} />
              <ReviewRow label="MSME" value={company.msme_status ? 'Yes' : 'No'} />
              <ReviewRow label="Annual Turnover" value={company.annual_turnover ? `₹${Number(company.annual_turnover).toLocaleString('en-IN')}` : '—'} />
            </ReviewSection>
            <ReviewSection title="Business Details">
              <ReviewRow label="City / State" value={`${business.city}, ${business.state}`} />
              <ReviewRow label="Contact Person" value={business.contact_person} />
              <ReviewRow label="Email" value={business.email} />
              <ReviewRow label="Phone" value={business.phone} />
            </ReviewSection>
            <ReviewSection title="Bank Details">
              <ReviewRow label="Bank" value={bank.bank_name} />
              <ReviewRow label="Account" value={bank.account_number ? `****${bank.account_number.slice(-4)}` : '—'} />
              <ReviewRow label="IFSC" value={bank.ifsc} />
            </ReviewSection>
            <ReviewSection title="Contacts">
              {contacts.filter(c => c.name).map((c, i) => (
                <ReviewRow key={i} label={c.type} value={`${c.name} ${c.email ? `<${c.email}>` : ''}`} />
              ))}
            </ReviewSection>
            <div style={{ ...styles.infoBox, marginBottom: 20 }}>
              By submitting, you confirm that all information provided is accurate and you agree to our Supplier Code of Conduct.
            </div>
            <div style={styles.btnRow}>
              <button style={styles.btnSecondary} onClick={() => setStep(5)}>← Back</button>
              <button style={styles.btnPrimary} disabled={submitting} onClick={submitRegistration}>
                {submitting ? 'Submitting…' : 'Submit Registration'}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 7: OTP Verification ──────────────────────────────────────── */}
        {step === 7 && (
          <div style={{ textAlign: 'center', maxWidth: 440, margin: '0 auto' }}>
            <h2 style={styles.stepTitle}>Verify Your Contact</h2>
            <p style={{ color: '#6b7280', marginBottom: 24 }}>
              OTPs have been sent to <strong>{business.email}</strong> and <strong>{business.phone}</strong>.
            </p>
            {otpMsg && <div style={styles.infoBox}>{otpMsg}</div>}

            {/* Email OTP */}
            <div style={styles.otpGroup}>
              <label style={styles.label}>Email OTP</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={emailOtp} onChange={e => setEmailOtp(e.target.value)} maxLength={6}
                  style={{ ...styles.input, flex: 1, textAlign: 'center', letterSpacing: 6, fontSize: 20 }} disabled={emailVerified} />
                {emailVerified
                  ? <span style={styles.verified}>✓ Verified</span>
                  : <button style={styles.btnPrimary} onClick={verifyEmailOtp}>Verify</button>
                }
              </div>
              {!emailVerified && (
                <button style={styles.linkBtn} onClick={() => resendOtp('email')}>Resend email OTP</button>
              )}
            </div>

            {/* Mobile OTP */}
            <div style={styles.otpGroup}>
              <label style={styles.label}>Mobile OTP</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={mobileOtp} onChange={e => setMobileOtp(e.target.value)} maxLength={6}
                  style={{ ...styles.input, flex: 1, textAlign: 'center', letterSpacing: 6, fontSize: 20 }} disabled={mobileVerified} />
                {mobileVerified
                  ? <span style={styles.verified}>✓ Verified</span>
                  : <button style={styles.btnPrimary} onClick={verifyMobileOtp}>Verify</button>
                }
              </div>
              {!mobileVerified && (
                <button style={styles.linkBtn} onClick={() => resendOtp('mobile')}>Resend mobile OTP</button>
              )}
            </div>

            <button
              style={{ ...styles.btnPrimary, width: '100%', marginTop: 24, opacity: emailVerified ? 1 : 0.5 }}
              disabled={!emailVerified}
              onClick={finalizeRegistration}
            >
              Complete Registration
            </button>
            <p style={{ fontSize: 12, color: '#9ca3af', marginTop: 12 }}>
              Mobile OTP is optional but recommended. Email verification is mandatory.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Field({ label, name, value, onChange, onBlur, type = 'text', placeholder }) {
  return (
    <div>
      <label style={styles.label}>{label}</label>
      <input name={name} type={type} value={value} onChange={onChange} onBlur={onBlur}
        placeholder={placeholder} style={styles.input} />
    </div>
  );
}

function ReviewSection({ title, children }) {
  return (
    <div style={{ marginBottom: 20, background: '#f9fafb', borderRadius: 8, padding: '14px 18px' }}>
      <div style={{ fontWeight: 600, color: '#6B3FDB', marginBottom: 10, fontSize: 14 }}>{title}</div>
      {children}
    </div>
  );
}

function ReviewRow({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '4px 0', borderBottom: '1px solid #f3f4f6' }}>
      <span style={{ color: '#6b7280', fontSize: 13, width: 160, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#111827', fontSize: 13 }}>{value || '—'}</span>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = {
  root: { minHeight: '100vh', background: '#f3f4f6', fontFamily: 'system-ui, sans-serif' },
  header: { background: '#fff', padding: '28px 24px', borderBottom: '1px solid #e5e7eb' },
  headerInner: { maxWidth: 800, margin: '0 auto', textAlign: 'center' },
  title: { fontSize: 24, fontWeight: 700, margin: 0, color: '#111827' },
  subtitle: { marginTop: 6, fontSize: 14, color: '#6b7280' },
  stepper: { display: 'flex', justifyContent: 'center', gap: 0, padding: '20px 16px', background: '#fff', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' },
  stepItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 80, padding: '0 8px' },
  stepCircle: { width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 },
  stepLabel: { fontSize: 11, fontWeight: 500, textAlign: 'center' },
  card: { maxWidth: 800, margin: '28px auto', background: '#fff', borderRadius: 12, padding: '28px 32px', boxShadow: '0 1px 8px rgba(0,0,0,.08)' },
  stepTitle: { fontSize: 20, fontWeight: 700, color: '#111827', marginBottom: 20, marginTop: 0 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '14px 20px' },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px 16px' },
  label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 4 },
  input: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', outline: 'none' },
  btnRow: { display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 24 },
  btnPrimary: { padding: '10px 24px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  btnSecondary: { padding: '10px 24px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14 },
  btnOutline: { padding: '8px 18px', background: '#fff', color: '#6B3FDB', border: '1px solid #6B3FDB', borderRadius: 6, fontWeight: 600, cursor: 'pointer', fontSize: 14, marginTop: 12 },
  btnDanger: { padding: '4px 12px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13 },
  linkBtn: { background: 'none', border: 'none', color: '#6B3FDB', cursor: 'pointer', fontSize: 13, textDecoration: 'underline', marginTop: 4, display: 'block' },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '10px 14px', color: '#dc2626', marginBottom: 16, fontSize: 14 },
  warnBox: { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '10px 14px', color: '#92400e', marginBottom: 16, fontSize: 14 },
  infoBox: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '10px 14px', color: '#1d4ed8', fontSize: 13 },
  contactCard: { background: '#f9fafb', borderRadius: 8, padding: '16px', marginBottom: 16, border: '1px solid #e5e7eb' },
  otpGroup: { marginBottom: 20, textAlign: 'left' },
  verified: { padding: '8px 14px', background: '#dcfce7', color: '#16a34a', borderRadius: 6, fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center' },
  successBox: { minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6', textAlign: 'center', padding: 32 },
};
