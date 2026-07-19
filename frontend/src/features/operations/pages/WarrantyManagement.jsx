import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api/client';
import { Plus, X, Shield, AlertTriangle, CheckCircle, Clock, RefreshCw, Download, FileWarning } from 'lucide-react';

const EMPTY_REG = {
  serial_number: '', product_name: '', customer_name: '',
  warranty_start: '', warranty_end: '', warranty_type: 'Comprehensive',
  coverage_parts: true, coverage_labour: true, coverage_travel: false,
  notes: '', lifecycle_instance_id: '', sales_order_id: '',
};

const EMPTY_CLAIM = {
  warranty_registration_id: '', serial_number: '', issue_description: '',
  failure_mode: '', labour_hours: '', claim_value: '',
};

const STATUS_COLOR = {
  Active:   { bg: '#d1fae5', color: '#065f46' },
  Expired:  { bg: '#fee2e2', color: '#991b1b' },
  Voided:   { bg: '#f3f4f6', color: '#6b7280' },
  Open:     { bg: '#dbeafe', color: '#1e40af' },
  approved: { bg: '#d1fae5', color: '#065f46' },
  closed:   { bg: '#f3f4f6', color: '#6b7280' },
  rejected: { bg: '#fee2e2', color: '#991b1b' },
};

const inputStyle = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };

function daysLeft(d) {
  if (!d) return null;
  return Math.ceil((new Date(d) - new Date()) / 86400000);
}

export default function WarrantyManagement() {
  const [tab,          setTab]          = useState(0);
  const [registrations, setRegistrations] = useState([]);
  const [claims,        setClaims]       = useState([]);
  const [loading,       setLoading]      = useState(false);
  const [showRegForm,   setShowRegForm]  = useState(false);
  const [showClaimForm, setShowClaimForm] = useState(false);
  const [regForm,       setRegForm]      = useState(EMPTY_REG);
  const [claimForm,     setClaimForm]    = useState(EMPTY_CLAIM);
  const [saving,        setSaving]       = useState(false);
  const [search,        setSearch]       = useState('');
  const [claimStatus,   setClaimStatus]  = useState('');
  const [toast,         setToast]        = useState(null);
  const [editingClaim,  setEditingClaim] = useState(null);
  const isMounted = useRef(true);

  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [regRes, claimRes] = await Promise.allSettled([
        api.get('/lifecycle/warranty'),
        api.get('/lifecycle/warranty-claims', { params: claimStatus ? { status: claimStatus } : {} }),
      ]);
      if (isMounted.current) {
        setRegistrations(regRes.status === 'fulfilled' ? regRes.value.data : []);
        setClaims(claimRes.status === 'fulfilled' ? claimRes.value.data : []);
      }
    } finally { if (isMounted.current) setLoading(false); }
  }, [claimStatus]);

  useEffect(() => { load(); }, [load]);

  const handleCreateReg = async () => {
    if (!regForm.serial_number || !regForm.warranty_start || !regForm.warranty_end) {
      showToast('Serial number, warranty start and end dates are required', 'error'); return;
    }
    setSaving(true);
    try {
      await api.post('/lifecycle/warranty', {
        ...regForm,
        lifecycle_instance_id: regForm.lifecycle_instance_id ? Number(regForm.lifecycle_instance_id) : null,
        sales_order_id        : regForm.sales_order_id ? Number(regForm.sales_order_id) : null,
      });
      showToast('Warranty registered successfully');
      setShowRegForm(false); setRegForm(EMPTY_REG); load();
    } catch (e) { showToast(e.response?.data?.error || 'Failed to register warranty', 'error'); }
    finally { setSaving(false); }
  };

  const handleCreateClaim = async () => {
    if (!claimForm.issue_description) { showToast('Issue description is required', 'error'); return; }
    setSaving(true);
    try {
      await api.post('/lifecycle/warranty-claims', {
        ...claimForm,
        warranty_registration_id: claimForm.warranty_registration_id ? Number(claimForm.warranty_registration_id) : null,
        labour_hours : claimForm.labour_hours ? Number(claimForm.labour_hours) : 0,
        claim_value  : claimForm.claim_value ? Number(claimForm.claim_value) : 0,
      });
      showToast('Warranty claim submitted');
      setShowClaimForm(false); setClaimForm(EMPTY_CLAIM); load();
    } catch (e) { showToast(e.response?.data?.error || 'Failed to submit claim', 'error'); }
    finally { setSaving(false); }
  };

  const updateClaim = async (id, status, resolution_notes) => {
    try {
      await api.put(`/lifecycle/warranty-claims/${id}`, { status, resolution_notes });
      showToast(`Claim ${status}`); setEditingClaim(null); load();
    } catch (e) { showToast(e.response?.data?.error || 'Update failed', 'error'); }
  };

  const exportWarranty = async () => {
    try {
      const rows = registrations.map(r => [
        r.warranty_number, r.serial_number, r.product_name, r.customer_name,
        (r.warranty_start || '').slice(0, 10), (r.warranty_end || '').slice(0, 10),
        r.warranty_type, r.status, r.is_expired ? 'Expired' : 'Active',
        r.days_remaining ?? '',
      ].join(','));
      const csv = ['Warranty#,Serial,Product,Customer,Start,End,Type,Status,Computed,Days Remaining', ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.download = `warranty_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch { showToast('Export failed', 'error'); }
  };

  const filteredRegs = registrations.filter(r =>
    !search || [r.serial_number, r.product_name, r.customer_name, r.warranty_number].some(s => (s || '').toLowerCase().includes(search.toLowerCase()))
  );

  const active  = registrations.filter(r => !r.is_expired).length;
  const expired = registrations.filter(r => r.is_expired).length;
  const expiring30 = registrations.filter(r => !r.is_expired && r.days_remaining !== null && r.days_remaining <= 30).length;
  const openClaims = claims.filter(c => c.status === 'Open').length;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 24, zIndex: 9999, padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: toast.type === 'error' ? '#fee2e2' : '#dcfce7', color: toast.type === 'error' ? '#dc2626' : '#15803d', boxShadow: '0 2px 8px rgba(0,0,0,.12)' }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1f2937', margin: 0 }}>Warranty Management</h1>
          <p style={{ color: '#6b7280', margin: '4px 0 0', fontSize: 13 }}>Warranty registrations, claims, and expiry tracking</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={exportWarranty}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
            <Download size={14} /> Export
          </button>
          <button onClick={() => setShowRegForm(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <Plus size={15} /> Register Warranty
          </button>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        {[
          { label: 'Active Warranties', value: active, icon: <CheckCircle size={18} color="#10b981" />, bg: '#d1fae5' },
          { label: 'Expired', value: expired, icon: <AlertTriangle size={18} color="#ef4444" />, bg: '#fee2e2' },
          { label: 'Expiring ≤30 days', value: expiring30, icon: <Clock size={18} color="#f59e0b" />, bg: '#fef3c7' },
          { label: 'Open Claims', value: openClaims, icon: <FileWarning size={18} color="#6366f1" />, bg: '#e0e7ff' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ background: k.bg, borderRadius: 10, padding: 10 }}>{k.icon}</div>
            <div>
              <div style={{ fontSize: 24, fontWeight: 700, color: '#1f2937' }}>{k.value}</div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{k.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, background: '#f0ebff', padding: 4, borderRadius: 10, marginBottom: 20, width: 'fit-content' }}>
        {['Warranty Registrations', 'Claims'].map((t, i) => (
          <button key={i} onClick={() => setTab(i)}
            style={{ padding: '8px 20px', border: 'none', background: tab === i ? '#6B3FDB' : 'transparent', color: tab === i ? '#fff' : '#6b7280', cursor: 'pointer', borderRadius: 8, fontWeight: tab === i ? 600 : 400, fontSize: 14 }}>
            {t}
          </button>
        ))}
      </div>

      {/* ── Tab 0: Registrations ── */}
      {tab === 0 && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by serial, product, customer..."
              style={{ flex: 1, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }} />
            <button onClick={load}
              style={{ padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>
              <RefreshCw size={14} color="#9ca3af" />
            </button>
          </div>

          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading...</div>
            ) : filteredRegs.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
                <Shield size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
                <p>No warranty registrations found</p>
                <button onClick={() => setShowRegForm(true)}
                  style={{ padding: '9px 20px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, marginTop: 8 }}>
                  Register First Warranty
                </button>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Warranty #', 'Serial Number', 'Product', 'Customer', 'Warranty Period', 'Type', 'Coverage', 'Days Left', 'Status', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', whiteSpace: 'nowrap', fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRegs.map((r, i) => {
                    const dl = r.days_remaining;
                    const dlColor = r.is_expired ? '#ef4444' : dl !== null && dl <= 30 ? '#f59e0b' : '#10b981';
                    const sc = STATUS_COLOR[r.is_expired ? 'Expired' : 'Active'] || {};
                    return (
                      <tr key={r.id || i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 600, color: '#6B3FDB' }}>{r.warranty_number || `WR-${r.id}`}</td>
                        <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: '#6366f1', fontWeight: 600 }}>{r.serial_number}</td>
                        <td style={{ padding: '10px 12px', fontWeight: 500 }}>{r.product_name}</td>
                        <td style={{ padding: '10px 12px', color: '#6b7280' }}>{r.customer_name}</td>
                        <td style={{ padding: '10px 12px', fontSize: 12, color: '#374151', whiteSpace: 'nowrap' }}>
                          <div>{(r.warranty_start || '').slice(0, 10)}</div>
                          <div style={{ color: '#9ca3af' }}>to {(r.warranty_end || '').slice(0, 10)}</div>
                        </td>
                        <td style={{ padding: '10px 12px', color: '#6b7280' }}>{r.warranty_type}</td>
                        <td style={{ padding: '10px 12px', fontSize: 11 }}>
                          {r.coverage_parts   && <span style={{ background: '#f0fdf4', color: '#065f46', padding: '1px 6px', borderRadius: 4, marginRight: 3 }}>Parts</span>}
                          {r.coverage_labour  && <span style={{ background: '#eff6ff', color: '#1e40af', padding: '1px 6px', borderRadius: 4, marginRight: 3 }}>Labour</span>}
                          {r.coverage_travel  && <span style={{ background: '#fefce8', color: '#854d0e', padding: '1px 6px', borderRadius: 4 }}>Travel</span>}
                        </td>
                        <td style={{ padding: '10px 12px', fontWeight: 600, color: dlColor, whiteSpace: 'nowrap' }}>
                          {r.is_expired ? 'Expired' : dl !== null ? `${dl}d` : '—'}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                            {r.is_expired ? 'Expired' : 'Active'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <button onClick={() => { setClaimForm({ ...EMPTY_CLAIM, warranty_registration_id: String(r.id), serial_number: r.serial_number }); setShowClaimForm(true); }}
                            style={{ padding: '3px 8px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                            + Claim
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Tab 1: Claims ── */}
      {tab === 1 && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
            <select value={claimStatus} onChange={e => setClaimStatus(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, outline: 'none' }}>
              <option value="">All Status</option>
              {['Open','approved','closed','rejected'].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <button onClick={() => { setShowClaimForm(true); setClaimForm(EMPTY_CLAIM); }}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              <Plus size={14} /> New Claim
            </button>
            <button onClick={load} style={{ padding: '8px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>
              <RefreshCw size={14} color="#9ca3af" />
            </button>
          </div>

          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>
            {claims.length === 0 ? (
              <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af' }}>
                <FileWarning size={36} color="#d1d5db" style={{ display: 'block', margin: '0 auto 12px' }} />
                <p>No warranty claims yet</p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Claim #', 'Serial / Warranty', 'Issue', 'Labour Hrs', 'Claim Value', 'Status', 'Filed', 'Actions'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', borderBottom: '1px solid #f0f0f4', fontSize: 12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c, i) => {
                    const sc = STATUS_COLOR[c.status] || { bg: '#f3f4f6', color: '#6b7280' };
                    return (
                      <tr key={c.id || i} style={{ borderBottom: '1px solid #f9fafb', background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                        <td style={{ padding: '10px 12px', fontWeight: 600, color: '#6B3FDB' }}>{c.claim_number}</td>
                        <td style={{ padding: '10px 12px', fontSize: 12 }}>
                          {c.serial_number && <div style={{ fontFamily: 'monospace', color: '#6366f1', fontWeight: 600 }}>{c.serial_number}</div>}
                          {c.warranty_serial && <div style={{ color: '#9ca3af' }}>{c.warranty_serial}</div>}
                        </td>
                        <td style={{ padding: '10px 12px', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.issue_description}</td>
                        <td style={{ padding: '10px 12px', color: '#374151' }}>{c.labour_hours || 0}h</td>
                        <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                          {c.claim_value > 0 ? `₹${Number(c.claim_value).toLocaleString('en-IN')}` : '—'}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <span style={{ background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
                            {c.status}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 12 }}>
                          {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <div style={{ display: 'flex', gap: 4 }}>
                            {c.status === 'Open' && (
                              <>
                                <button onClick={() => updateClaim(c.id, 'approved', '')}
                                  style={{ padding: '3px 8px', background: '#d1fae5', color: '#065f46', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Approve</button>
                                <button onClick={() => setEditingClaim(c)}
                                  style={{ padding: '3px 8px', background: '#fef3c7', color: '#92400e', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Resolve</button>
                                <button onClick={() => updateClaim(c.id, 'rejected', '')}
                                  style={{ padding: '3px 8px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Reject</button>
                              </>
                            )}
                            {c.status === 'approved' && (
                              <button onClick={() => setEditingClaim(c)}
                                style={{ padding: '3px 8px', background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>Close</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* ── Register Warranty Modal ── */}
      {showRegForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 580, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Register Warranty</h2>
              <button onClick={() => setShowRegForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div>
                <label style={labelStyle}>Serial Number *</label>
                <input value={regForm.serial_number} onChange={e => setRegForm(r => ({ ...r, serial_number: e.target.value }))} placeholder="e.g. MT-HVDC-001" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Product Name</label>
                <input value={regForm.product_name} onChange={e => setRegForm(r => ({ ...r, product_name: e.target.value }))} placeholder="Product / equipment name" style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Customer Name</label>
                <input value={regForm.customer_name} onChange={e => setRegForm(r => ({ ...r, customer_name: e.target.value }))} placeholder="Customer / site" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Warranty Start *</label>
                <input type="date" value={regForm.warranty_start} onChange={e => setRegForm(r => ({ ...r, warranty_start: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Warranty End *</label>
                <input type="date" value={regForm.warranty_end} onChange={e => setRegForm(r => ({ ...r, warranty_end: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Warranty Type</label>
                <select value={regForm.warranty_type} onChange={e => setRegForm(r => ({ ...r, warranty_type: e.target.value }))} style={inputStyle}>
                  {['Comprehensive','Parts Only','Labour Only','Limited'].map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Linked Lifecycle ID</label>
                <input type="number" value={regForm.lifecycle_instance_id} onChange={e => setRegForm(r => ({ ...r, lifecycle_instance_id: e.target.value }))} placeholder="Optional" style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Coverage</label>
                <div style={{ display: 'flex', gap: 16 }}>
                  {[['coverage_parts','Parts'],['coverage_labour','Labour'],['coverage_travel','Travel']].map(([k, label]) => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                      <input type="checkbox" checked={regForm[k]} onChange={e => setRegForm(r => ({ ...r, [k]: e.target.checked }))}
                        style={{ width: 15, height: 15, accentColor: '#6B3FDB' }} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Notes</label>
                <textarea value={regForm.notes} onChange={e => setRegForm(r => ({ ...r, notes: e.target.value }))} rows={2}
                  placeholder="Warranty terms, exclusions, notes..." style={{ ...inputStyle, resize: 'none' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowRegForm(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleCreateReg} disabled={saving}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Registering...' : 'Register Warranty'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── New Claim Modal ── */}
      {showClaimForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Submit Warranty Claim</h2>
              <button onClick={() => setShowClaimForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div>
                <label style={labelStyle}>Warranty Registration</label>
                <select value={claimForm.warranty_registration_id} onChange={e => setClaimForm(c => ({ ...c, warranty_registration_id: e.target.value }))} style={inputStyle}>
                  <option value="">Select warranty…</option>
                  {registrations.map(r => <option key={r.id} value={r.id}>{r.warranty_number} — {r.serial_number}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Serial Number</label>
                <input value={claimForm.serial_number} onChange={e => setClaimForm(c => ({ ...c, serial_number: e.target.value }))} placeholder="If not linked above" style={inputStyle} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={labelStyle}>Issue Description *</label>
                <textarea value={claimForm.issue_description} onChange={e => setClaimForm(c => ({ ...c, issue_description: e.target.value }))} rows={3}
                  placeholder="Describe the defect or issue in detail..." style={{ ...inputStyle, resize: 'none' }} />
              </div>
              <div>
                <label style={labelStyle}>Failure Mode</label>
                <input value={claimForm.failure_mode} onChange={e => setClaimForm(c => ({ ...c, failure_mode: e.target.value }))} placeholder="Component, root cause" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Labour Hours</label>
                <input type="number" step="0.5" value={claimForm.labour_hours} onChange={e => setClaimForm(c => ({ ...c, labour_hours: e.target.value }))} placeholder="0" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Claim Value (₹)</label>
                <input type="number" value={claimForm.claim_value} onChange={e => setClaimForm(c => ({ ...c, claim_value: e.target.value }))} placeholder="0" style={inputStyle} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowClaimForm(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={handleCreateClaim} disabled={saving}
                style={{ padding: '9px 18px', background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: saving ? 0.6 : 1 }}>
                {saving ? 'Submitting...' : 'Submit Claim'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Resolve Claim Modal ── */}
      {editingClaim && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 28, width: 440, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 17, fontWeight: 700, color: '#1f2937', margin: 0 }}>Resolve Claim — {editingClaim.claim_number}</h2>
              <button onClick={() => setEditingClaim(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af' }}><X size={20} /></button>
            </div>
            <label style={labelStyle}>Resolution Notes</label>
            <textarea id="res-notes" rows={4} placeholder="What was done to resolve the claim..."
              style={{ ...inputStyle, resize: 'none', marginBottom: 16 }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditingClaim(null)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button onClick={() => updateClaim(editingClaim.id, 'closed', document.getElementById('res-notes').value)}
                style={{ padding: '9px 18px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Mark Closed
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
