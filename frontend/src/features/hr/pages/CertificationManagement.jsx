// frontend/src/features/hr/pages/CertificationManagement.jsx
import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/context/ToastContext';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const STATUS_COLORS = { active: '#16a34a', expired: '#dc2626', renewed: '#d97706' };

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.45)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>

      <ConfirmDialog
        open={!!pendingDeleteMaster}
        title="Delete Certification"
        message="Delete this certification?"
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteMaster}
        onCancel={() => setPendingDeleteMaster(null)}
      />
      <div style={{ background:'#fff', borderRadius:12, padding:24, width:'100%', maxWidth:540, maxHeight:'85vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h3 style={{ margin:0, color:'#4c1d95', fontSize:16 }}>{title}</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:20, color:'#6b7280' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom:12 }}>
      <label style={{ fontSize:12, fontWeight:600, color:'#4c1d95', display:'block', marginBottom:4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = { width:'100%', boxSizing:'border-box', padding:'8px 10px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 };

export default function CertificationManagement() {
  const toast = useToast();
  const [tab, setTab] = useState('master');
  const [masterCerts, setMasterCerts] = useState([]);
  const [empCerts, setEmpCerts] = useState([]);
  const [expiry, setExpiry] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [editRecord, setEditRecord] = useState(null);
  const [renewRecord, setRenewRecord] = useState(null);
  const [renewDate, setRenewDate] = useState('');
  const [form, setForm] = useState({ name:'', code:'', issuing_body:'', category:'', validity_months:12, is_mandatory:false, description:'' });
  const [empForm, setEmpForm] = useState({ employee_id:'', certification_id:'', certificate_number:'', issue_date:'', notes:'' });
  const [showEmpForm, setShowEmpForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [pendingDeleteMaster, setPendingDeleteMaster] = useState(null);

  const load = useCallback(async () => {
    const [mRes, eRes, xRes] = await Promise.allSettled([
      api.get('/certifications/master'),
      api.get('/certifications/employee' + (filterStatus ? `?status=${filterStatus}` : '')),
      api.get('/certifications/expiry-dashboard'),
    ]);
    if (mRes.status === 'fulfilled') setMasterCerts(mRes.value.data || []);
    if (eRes.status === 'fulfilled') setEmpCerts(eRes.value.data || []);
    if (xRes.status === 'fulfilled') setExpiry(xRes.value.data || {});
  }, [filterStatus]);

  useEffect(() => { load(); }, [load]);

  const saveMaster = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (editRecord) {
        await api.put(`/certifications/master/${editRecord.id}`, form);
        toast.success('Certification updated');
      } else {
        await api.post('/certifications/master', form);
        toast.success('Certification created');
      }
      setShowForm(false); setEditRecord(null);
      setForm({ name:'', code:'', issuing_body:'', category:'', validity_months:12, is_mandatory:false, description:'' });
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const deleteMaster = async () => {
    if (!pendingDeleteMaster) return;
    const id = pendingDeleteMaster;
    setPendingDeleteMaster(null);
    try { await api.delete(`/certifications/master/${id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
  };

  const saveEmpCert = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post('/certifications/employee', empForm);
      toast.success('Employee certification recorded');
      setShowEmpForm(false);
      setEmpForm({ employee_id:'', certification_id:'', certificate_number:'', issue_date:'', notes:'' });
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
    finally { setLoading(false); }
  };

  const doRenew = async () => {
    if (!renewDate) { toast.error('Enter new expiry date'); return; }
    try {
      await api.post(`/certifications/employee/${renewRecord.id}/renew`, { new_expiry_date: renewDate });
      toast.success('Certification renewed');
      setRenewRecord(null); setRenewDate('');
      load();
    } catch (err) { toast.error(err?.response?.data?.error || 'Failed'); }
  };

  const tabStyle = (k) => ({ padding:'8px 18px', border:'none', cursor:'pointer', borderRadius:'6px 6px 0 0', fontWeight:600, fontSize:14, background: tab===k ? '#6B3FDB' : '#e9e4ff', color: tab===k ? '#fff' : '#6B3FDB' });

  return (
    <div style={{ padding:24, background:'#f5f3ff', minHeight:'100vh' }}>
      <div style={{ marginBottom:16 }}>
        <h2 style={{ margin:0, color:'#4c1d95', fontSize:22 }}>📋 Certification Management</h2>
        <p style={{ margin:0, color:'#6b7280', fontSize:13 }}>Manage compliance certs, expiry tracking, and renewal workflows</p>
      </div>

      {/* Expiry KPIs */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))', gap:12, marginBottom:20 }}>
        {[
          { label:'Active', value: expiry.active || 0, color:'#16a34a', icon:'✅' },
          { label:'Expiring 30d', value: expiry.expiring_30d || 0, color:'#dc2626', icon:'⏰' },
          { label:'Expiring 60d', value: expiry.expiring_60d || 0, color:'#f97316', icon:'📅' },
          { label:'Expiring 90d', value: expiry.expiring_90d || 0, color:'#d97706', icon:'📆' },
          { label:'Expired', value: expiry.expired || 0, color:'#dc2626', icon:'❌' },
        ].map(k => (
          <div key={k.label} style={{ background:'#fff', border:'1px solid #e9e4ff', borderRadius:10, padding:'14px 16px' }}>
            <div style={{ fontSize:18 }}>{k.icon}</div>
            <div style={{ fontSize:22, fontWeight:800, color:k.color, marginTop:4 }}>{k.value}</div>
            <div style={{ fontSize:11, color:'#6b7280', marginTop:2 }}>{k.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display:'flex', gap:4, borderBottom:'2px solid #e9e4ff' }}>
        {[['master','Certification Library'],['employee','Employee Certifications']].map(([k,l]) => (
          <button key={k} style={tabStyle(k)} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div style={{ background:'#fff', border:'1px solid #e9e4ff', borderTop:'none', borderRadius:'0 8px 8px 8px', padding:20 }}>

        {/* ── MASTER TAB ── */}
        {tab === 'master' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <h3 style={{ margin:0, color:'#4c1d95' }}>Certification Library</h3>
              <button onClick={() => { setShowForm(true); setEditRecord(null); setForm({ name:'', code:'', issuing_body:'', category:'', validity_months:12, is_mandatory:false, description:'' }); }}
                style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', cursor:'pointer', fontWeight:600 }}>
                + Add Certification
              </button>
            </div>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead><tr style={{ background:'#f5f3ff' }}>
                {['Name','Code','Issuing Body','Category','Validity','Mandatory','Actions'].map(h => (
                  <th key={h} style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {masterCerts.map(c => (
                  <tr key={c.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                    <td style={{ padding:'8px 12px', fontWeight:600 }}>{c.name}</td>
                    <td style={{ padding:'8px 12px', color:'#6b7280' }}>{c.code || '—'}</td>
                    <td style={{ padding:'8px 12px', color:'#6b7280' }}>{c.issuing_body || '—'}</td>
                    <td style={{ padding:'8px 12px' }}>{c.category || '—'}</td>
                    <td style={{ padding:'8px 12px' }}>{c.validity_months} months</td>
                    <td style={{ padding:'8px 12px' }}>
                      <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600, background: c.is_mandatory ? '#fef2f2' : '#f0fdf4', color: c.is_mandatory ? '#dc2626' : '#16a34a' }}>
                        {c.is_mandatory ? 'Mandatory' : 'Optional'}
                      </span>
                    </td>
                    <td style={{ padding:'8px 12px' }}>
                      <div style={{ display:'flex', gap:6 }}>
                        <button onClick={() => { setEditRecord(c); setForm({ name:c.name, code:c.code||'', issuing_body:c.issuing_body||'', category:c.category||'', validity_months:c.validity_months, is_mandatory:c.is_mandatory, description:c.description||'' }); setShowForm(true); }}
                          style={{ padding:'4px 10px', background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Edit</button>
                        <button onClick={() => setPendingDeleteMaster(c.id)}
                          style={{ padding:'4px 10px', background:'#fef2f2', color:'#dc2626', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {masterCerts.length === 0 && (
                  <tr><td colSpan={7} style={{ padding:'32px 16px', textAlign:'center', color:'#9ca3af' }}>No certifications defined yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* ── EMPLOYEE TAB ── */}
        {tab === 'employee' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:10 }}>
              <h3 style={{ margin:0, color:'#4c1d95' }}>Employee Certifications</h3>
              <div style={{ display:'flex', gap:10 }}>
                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                  style={{ padding:'8px 12px', border:'1px solid #e9e4ff', borderRadius:7, fontSize:13 }}>
                  <option value="">All Status</option>
                  <option value="active">Active</option>
                  <option value="expired">Expired</option>
                  <option value="renewed">Renewed</option>
                </select>
                <button onClick={() => setShowEmpForm(true)}
                  style={{ background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'8px 18px', cursor:'pointer', fontWeight:600 }}>
                  + Record Certification
                </button>
              </div>
            </div>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead><tr style={{ background:'#f5f3ff' }}>
                {['Employee','Department','Certification','Issue Date','Expiry Date','Days Left','Status','Actions'].map(h => (
                  <th key={h} style={{ padding:'8px 12px', textAlign:'left', borderBottom:'1px solid #e9e4ff', color:'#4c1d95', fontWeight:600 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {empCerts.map(ec => {
                  const days = parseInt(ec.days_until_expiry);
                  const daysColor = days < 0 ? '#dc2626' : days < 30 ? '#f97316' : days < 90 ? '#d97706' : '#16a34a';
                  return (
                    <tr key={ec.id} style={{ borderBottom:'1px solid #f0ebff' }}>
                      <td style={{ padding:'8px 12px', fontWeight:600 }}>{ec.employee_name}</td>
                      <td style={{ padding:'8px 12px', color:'#6b7280' }}>{ec.department}</td>
                      <td style={{ padding:'8px 12px' }}>{ec.cert_name}</td>
                      <td style={{ padding:'8px 12px' }}>{ec.issue_date || '—'}</td>
                      <td style={{ padding:'8px 12px' }}>{ec.expiry_date || '—'}</td>
                      <td style={{ padding:'8px 12px', fontWeight:700, color: daysColor }}>
                        {ec.expiry_date ? (days < 0 ? `${Math.abs(days)}d overdue` : `${days}d`) : '—'}
                      </td>
                      <td style={{ padding:'8px 12px' }}>
                        <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:600, background:(STATUS_COLORS[ec.status]||'#6b7280')+'20', color:STATUS_COLORS[ec.status]||'#6b7280' }}>
                          {ec.status}
                        </span>
                      </td>
                      <td style={{ padding:'8px 12px' }}>
                        {ec.status === 'active' && (
                          <button onClick={() => { setRenewRecord(ec); setRenewDate(''); }}
                            style={{ padding:'4px 10px', background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:6, cursor:'pointer', fontWeight:600, fontSize:12 }}>Renew</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {empCerts.length === 0 && (
                  <tr><td colSpan={8} style={{ padding:'32px 16px', textAlign:'center', color:'#9ca3af' }}>No employee certifications recorded</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Master cert form modal */}
      {showForm && (
        <Modal title={editRecord ? 'Edit Certification' : 'Add Certification'} onClose={() => { setShowForm(false); setEditRecord(null); }}>
          <form onSubmit={saveMaster}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              <div style={{ gridColumn:'1/-1' }}>
                <Field label="Certification Name *">
                  <input required value={form.name} onChange={e => setForm(f => ({...f, name:e.target.value}))} style={inputStyle} />
                </Field>
              </div>
              <Field label="Code"><input value={form.code} onChange={e => setForm(f => ({...f, code:e.target.value}))} style={inputStyle} /></Field>
              <Field label="Issuing Body"><input value={form.issuing_body} onChange={e => setForm(f => ({...f, issuing_body:e.target.value}))} style={inputStyle} /></Field>
              <Field label="Category">
                <select value={form.category} onChange={e => setForm(f => ({...f, category:e.target.value}))} style={inputStyle}>
                  <option value="">-- Select Category --</option>
                  {['Technical','Safety','Quality','Leadership','Compliance','Finance','HR','IT','Operations','Other'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Validity (months)"><input type="number" value={form.validity_months} onChange={e => setForm(f => ({...f, validity_months:parseInt(e.target.value)||12}))} style={inputStyle} /></Field>
              <div style={{ gridColumn:'1/-1' }}>
                <Field label="Description">
                  <textarea value={form.description} onChange={e => setForm(f => ({...f, description:e.target.value}))} style={{...inputStyle, height:72, resize:'vertical'}} />
                </Field>
              </div>
              <div style={{ gridColumn:'1/-1', display:'flex', alignItems:'center', gap:10 }}>
                <input type="checkbox" id="mand" checked={form.is_mandatory} onChange={e => setForm(f => ({...f, is_mandatory:e.target.checked}))} />
                <label htmlFor="mand" style={{ fontSize:13, fontWeight:600, color:'#4c1d95' }}>Mandatory certification</label>
              </div>
            </div>
            <div style={{ display:'flex', gap:10, marginTop:16 }}>
              <button type="submit" disabled={loading} style={{ flex:1, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>
                {loading ? 'Saving…' : editRecord ? 'Update' : 'Create'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setEditRecord(null); }} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Employee cert form modal */}
      {showEmpForm && (
        <Modal title="Record Employee Certification" onClose={() => setShowEmpForm(false)}>
          <form onSubmit={saveEmpCert}>
            <Field label="Employee ID *"><input required value={empForm.employee_id} onChange={e => setEmpForm(f => ({...f, employee_id:e.target.value}))} style={inputStyle} placeholder="Employee ID" /></Field>
            <Field label="Certification *">
              <select required value={empForm.certification_id} onChange={e => setEmpForm(f => ({...f, certification_id:e.target.value}))} style={inputStyle}>
                <option value="">Select certification</option>
                {masterCerts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Certificate Number"><input value={empForm.certificate_number} onChange={e => setEmpForm(f => ({...f, certificate_number:e.target.value}))} style={inputStyle} /></Field>
            <Field label="Issue Date"><input type="date" value={empForm.issue_date} onChange={e => setEmpForm(f => ({...f, issue_date:e.target.value}))} style={inputStyle} /></Field>
            <Field label="Notes"><textarea value={empForm.notes} onChange={e => setEmpForm(f => ({...f, notes:e.target.value}))} style={{...inputStyle, height:60, resize:'vertical'}} /></Field>
            <div style={{ display:'flex', gap:10, marginTop:12 }}>
              <button type="submit" disabled={loading} style={{ flex:1, background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>
                {loading ? 'Saving…' : 'Record'}
              </button>
              <button type="button" onClick={() => setShowEmpForm(false)} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Renew modal */}
      {renewRecord && (
        <Modal title={`Renew — ${renewRecord.cert_name}`} onClose={() => setRenewRecord(null)}>
          <p style={{ fontSize:13, color:'#6b7280', margin:'0 0 16px' }}>
            Employee: <strong>{renewRecord.employee_name}</strong><br />
            Current expiry: <strong>{renewRecord.expiry_date || 'N/A'}</strong>
          </p>
          <Field label="New Expiry Date *">
            <input type="date" value={renewDate} onChange={e => setRenewDate(e.target.value)} style={inputStyle} required />
          </Field>
          <div style={{ display:'flex', gap:10, marginTop:12 }}>
            <button onClick={doRenew} style={{ flex:1, background:'#16a34a', color:'#fff', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Renew</button>
            <button onClick={() => setRenewRecord(null)} style={{ flex:1, background:'#e9e4ff', color:'#6B3FDB', border:'none', borderRadius:8, padding:'9px 0', cursor:'pointer', fontWeight:600 }}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
