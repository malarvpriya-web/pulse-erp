import { useState, useEffect } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { Plus, X, Search, CheckCircle, Clock, AlertCircle, Building2, FileCheck, ChevronRight } from 'lucide-react';

const STAGES = ['Submitted','Pending SCM Review','Pending Quality Review','Pending Finance Review','Pending Management Review','Approved','Rejected'];

const STAGE_COLORS = {
  'Submitted':                   { bg:'#eff6ff', color:'#1d4ed8' },
  'Pending SCM Review':          { bg:'#fefce8', color:'#a16207' },
  'Pending Quality Review':      { bg:'#fff7ed', color:'#c2410c' },
  'Pending Finance Review':      { bg:'#f5f3ff', color:'#6B3FDB' },
  'Pending Management Review':   { bg:'#fdf2f8', color:'#9d174d' },
  'Under Review':                { bg:'#fefce8', color:'#a16207' },
  'Approved':                    { bg:'#f0fdf4', color:'#15803d' },
  'Rejected':                    { bg:'#fef2f2', color:'#b91c1c' },
};

const APPROVAL_FLOW = [
  { key:'scm',        label:'SCM Review',         col:'scm_reviewed_at' },
  { key:'quality',    label:'Quality Review',      col:'quality_reviewed_at' },
  { key:'finance',    label:'Finance Review',      col:'finance_reviewed_at' },
  { key:'management', label:'Management Approval', col:'mgmt_approved_at' },
];

const EMPTY_REG = {
  vendor_name:'', vendor_type:'Manufacturer', products_services:'',
  gstin:'', pan:'', msme_status:false, udyam_number:'',
  bank_name:'', account_number:'', ifsc:'',
  address:'', city:'', state:'', pincode:'',
  contact_person:'', email:'', phone:'', website:'',
  iso_certificates:'', quality_docs_link:'', nda_signed:false,
  technical_capability:'', annual_turnover:'', num_employees:'', year_established:'',
};

const VENDOR_TYPES = ['Manufacturer','Distributor','Service Provider','Contractor','Consultant','Trading'];

export default function VendorPortal({ setPage }) {
  const toast = useToast();
  const [registrations, setRegistrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showRegForm, setShowRegForm] = useState(false);
  const [form, setForm] = useState(EMPTY_REG);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [selected, setSelected] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewData, setReviewData] = useState({ stage:'', status:'Approved', remarks:'' });

  const load = () => {
    setLoading(true);
    api.get('/vendor-portal/registrations')
      .then(r => setRegistrations(Array.isArray(r.data) ? r.data : []))
      .catch(() => setRegistrations([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const fld = (key, val) => setForm(p => ({ ...p, [key]: val }));

  const handleRegister = async () => {
    if (!form.vendor_name || !form.email) { toast.error('Vendor Name and Email are required'); return; }
    setSaving(true);
    try {
      await api.post('/vendor-portal/registrations', { ...form, annual_turnover: Number(form.annual_turnover)||null, num_employees: Number(form.num_employees)||null, year_established: Number(form.year_established)||null });
      setShowRegForm(false); setForm(EMPTY_REG); load();
      toast.success('Registration submitted! Awaiting SCM review.');
    } catch (err) { toast.error(err.response?.data?.error || 'Submit failed'); }
    finally { setSaving(false); }
  };

  const handleReview = async () => {
    if (!reviewData.stage) { toast.error('Select approval stage'); return; }
    setSaving(true);
    try {
      await api.put(`/vendor-portal/registrations/${selected.id}/review`, reviewData);
      toast.success('Review submitted');
      setReviewing(false);
      load();
      const { data } = await api.get(`/vendor-portal/registrations/${selected.id}`);
      setSelected(data);
    } catch (err) { toast.error(err.response?.data?.error || 'Review failed'); }
    finally { setSaving(false); }
  };

  const filtered = registrations.filter(r => {
    const matchStatus = statusFilter === 'All' || r.status === statusFilter || (statusFilter === 'Pending' && r.status?.includes('Pending'));
    const matchSearch = !search || [r.vendor_name, r.email, r.gstin, r.city, r.contact_person]
      .some(v => (v||'').toLowerCase().includes(search.toLowerCase()));
    return matchStatus && matchSearch;
  });

  const counts = {
    total: registrations.length,
    pending: registrations.filter(r => r.status?.includes('Pending') || r.status === 'Submitted').length,
    approved: registrations.filter(r => r.status === 'Approved').length,
    rejected: registrations.filter(r => r.status === 'Rejected').length,
  };

  const inputStyle = { width:'100%', padding:'9px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' };
  const labelStyle = { display:'block', fontSize:12, fontWeight:600, color:'#374151', marginBottom:5 };

  return (
    <div style={{ padding:24, background:'#f9fafb', minHeight:'100vh' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h1 style={{ fontSize:22, fontWeight:700, color:'#1f2937', margin:0 }}>Vendor Registration Portal</h1>
          <p style={{ color:'#6b7280', margin:'4px 0 0', fontSize:13 }}>Manage vendor onboarding, approval workflow, and master creation</p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={() => setPage?.('VendorScorecard')}
            style={{ padding:'9px 16px', background:'#fff', color:'#6B3FDB', border:'1px solid #e9e4ff', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            Scorecards
          </button>
          <button onClick={() => setShowRegForm(true)}
            style={{ display:'flex', alignItems:'center', gap:6, padding:'9px 18px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            <Plus size={15}/> Register Vendor
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:14, marginBottom:20 }}>
        {[
          { label:'Total Registrations', value: counts.total, color:'#6366f1', icon: Building2 },
          { label:'Pending Review', value: counts.pending, color:'#f59e0b', icon: Clock },
          { label:'Approved', value: counts.approved, color:'#10b981', icon: CheckCircle },
          { label:'Rejected', value: counts.rejected, color:'#ef4444', icon: AlertCircle },
        ].map(k => (
          <div key={k.label} style={{ background:'#fff', borderRadius:12, padding:20, border:'1px solid #f0f0f4' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <div>
                <p style={{ fontSize:12, color:'#9ca3af', margin:'0 0 8px', fontWeight:500, textTransform:'uppercase' }}>{k.label}</p>
                <p style={{ fontSize:28, fontWeight:700, color:'#1f2937', margin:0 }}>{k.value}</p>
              </div>
              <div style={{ background:k.color+'18', borderRadius:10, padding:10 }}>
                <k.icon size={20} color={k.color}/>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:12, marginBottom:20, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#9ca3af' }}/>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search vendor name, email, GSTIN..."
            style={{ width:'100%', paddingLeft:32, paddingRight:12, paddingTop:8, paddingBottom:8, border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
        </div>
        {['All','Pending','Approved','Rejected'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)}
            style={{ padding:'7px 14px', borderRadius:8, border:'1px solid', fontSize:12, fontWeight:500, cursor:'pointer',
              borderColor: statusFilter===s ? '#6B3FDB' : '#e5e7eb',
              background:  statusFilter===s ? '#6B3FDB' : '#fff',
              color:       statusFilter===s ? '#fff'    : '#374151' }}>
            {s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', overflow:'hidden' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>No registrations found.</div>
        ) : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr style={{ background:'#f9fafb' }}>
                {['Vendor Name','Type','City','GSTIN','Contact','Submitted','Status',''].map(h => (
                  <th key={h} style={{ padding:'10px 16px', textAlign:'left', fontWeight:600, color:'#374151', borderBottom:'1px solid #f0f0f4' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const sc = STAGE_COLORS[r.status] || { bg:'#fafafa', color:'#6b7280' };
                return (
                  <tr key={r.id} style={{ borderBottom:'1px solid #f9fafb', background:i%2===0?'#fff':'#fafafa' }}>
                    <td style={{ padding:'10px 16px', fontWeight:600, color:'#1f2937' }}>{r.vendor_name}</td>
                    <td style={{ padding:'10px 16px', color:'#6b7280' }}>{r.vendor_type}</td>
                    <td style={{ padding:'10px 16px', color:'#6b7280' }}>{r.city}</td>
                    <td style={{ padding:'10px 16px', color:'#374151', fontFamily:'monospace', fontSize:12 }}>{r.gstin || '—'}</td>
                    <td style={{ padding:'10px 16px', color:'#6b7280' }}>
                      <div>{r.contact_person}</div>
                      <div style={{ fontSize:11 }}>{r.email}</div>
                    </td>
                    <td style={{ padding:'10px 16px', color:'#9ca3af', fontSize:12 }}>{r.created_at?.slice(0,10)}</td>
                    <td style={{ padding:'10px 16px' }}>
                      <span style={{ background:sc.bg, color:sc.color, padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600 }}>{r.status}</span>
                    </td>
                    <td style={{ padding:'10px 16px' }}>
                      <button onClick={() => { setSelected(r); setReviewing(false); }}
                        style={{ background:'#f5f3ff', color:'#6B3FDB', border:'none', borderRadius:6, padding:'4px 12px', cursor:'pointer', fontSize:12, fontWeight:600 }}>
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail / Review Modal */}
      {selected && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}
             onClick={e => { if (e.target === e.currentTarget) { setSelected(null); setReviewing(false); }}}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:680, maxHeight:'92vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>{selected.vendor_name}</h2>
              <button onClick={() => { setSelected(null); setReviewing(false); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>

            {/* Approval workflow progress */}
            <div style={{ display:'flex', gap:0, marginBottom:20, background:'#f9fafb', borderRadius:10, padding:'12px 16px' }}>
              {APPROVAL_FLOW.map((step, i) => {
                const done = !!selected[step.col];
                const active = !done && (
                  (i===0 && (selected.status === 'Submitted' || selected.status?.includes('SCM'))) ||
                  (i===1 && selected.status?.includes('Quality')) ||
                  (i===2 && selected.status?.includes('Finance')) ||
                  (i===3 && selected.status?.includes('Management'))
                );
                return (
                  <div key={step.key} style={{ display:'flex', alignItems:'center', flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', flex:1 }}>
                      <div style={{ width:28, height:28, borderRadius:'50%', background: done ? '#10b981' : active ? '#f59e0b' : '#e5e7eb', display:'flex', alignItems:'center', justifyContent:'center', marginBottom:4 }}>
                        {done ? <CheckCircle size={14} color="#fff"/> : <span style={{ fontSize:11, color: active ? '#fff' : '#9ca3af', fontWeight:600 }}>{i+1}</span>}
                      </div>
                      <span style={{ fontSize:10, color: done ? '#10b981' : active ? '#f59e0b' : '#9ca3af', textAlign:'center', fontWeight: active ? 700 : 400 }}>{step.label}</span>
                    </div>
                    {i < 3 && <ChevronRight size={14} color="#d1d5db" style={{ flexShrink:0 }}/>}
                  </div>
                );
              })}
            </div>

            {/* Vendor details */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, fontSize:13, marginBottom:16 }}>
              {[
                ['Vendor Type', selected.vendor_type],
                ['GSTIN', selected.gstin],
                ['PAN', selected.pan],
                ['MSME', selected.msme_status ? 'Yes' : 'No'],
                ['Udyam No', selected.udyam_number],
                ['Contact', selected.contact_person],
                ['Email', selected.email],
                ['Phone', selected.phone],
                ['City', selected.city],
                ['State', selected.state],
                ['Bank', selected.bank_name],
                ['Account', selected.account_number],
                ['IFSC', selected.ifsc],
                ['NDA Signed', selected.nda_signed ? 'Yes' : 'No'],
                ['Annual Turnover', selected.annual_turnover ? `₹${Number(selected.annual_turnover).toLocaleString('en-IN')}` : null],
                ['Employees', selected.num_employees],
                ['Est. Year', selected.year_established],
              ].filter(([,v]) => v).map(([lbl, val]) => (
                <div key={lbl}>
                  <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, textTransform:'uppercase', marginBottom:2 }}>{lbl}</div>
                  <div style={{ fontWeight:500, color:'#1f2937' }}>{val}</div>
                </div>
              ))}
            </div>

            {selected.products_services && (
              <div style={{ marginBottom:12, padding:12, background:'#f9fafb', borderRadius:8 }}>
                <div style={{ fontSize:11, color:'#9ca3af', fontWeight:600, marginBottom:4 }}>PRODUCTS / SERVICES</div>
                <div style={{ fontSize:13 }}>{selected.products_services}</div>
              </div>
            )}
            {selected.technical_capability && (
              <div style={{ marginBottom:12, padding:12, background:'#f5f3ff', borderRadius:8 }}>
                <div style={{ fontSize:11, color:'#6B3FDB', fontWeight:600, marginBottom:4 }}>TECHNICAL CAPABILITY</div>
                <div style={{ fontSize:13 }}>{selected.technical_capability}</div>
              </div>
            )}
            {selected.vendor_id && (
              <div style={{ marginBottom:16, padding:'10px 14px', background:'#f0fdf4', borderRadius:8, fontSize:13, color:'#15803d', fontWeight:600 }}>
                <CheckCircle size={14} style={{ verticalAlign:'middle', marginRight:6 }}/>Vendor Master Created (ID: {selected.vendor_id})
              </div>
            )}

            {/* Review section */}
            {!reviewing ? (
              <button onClick={() => { setReviewing(true); setReviewData({ stage:'scm', status:'Approved', remarks:'' }); }}
                style={{ width:'100%', padding:'10px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                Submit Review / Approval
              </button>
            ) : (
              <div style={{ border:'1px solid #e9e4ff', borderRadius:10, padding:16 }}>
                <div style={{ fontSize:13, fontWeight:700, color:'#1f2937', marginBottom:12 }}>Submit Review</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
                  <div>
                    <label style={labelStyle}>Review Stage</label>
                    <select value={reviewData.stage} onChange={e => setReviewData(p => ({...p, stage:e.target.value}))}
                      style={inputStyle}>
                      {APPROVAL_FLOW.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Decision</label>
                    <select value={reviewData.status} onChange={e => setReviewData(p => ({...p, status:e.target.value}))}
                      style={inputStyle}>
                      <option value="Approved">Approve</option>
                      <option value="Rejected">Reject</option>
                    </select>
                  </div>
                  <div style={{ gridColumn:'1/-1' }}>
                    <label style={labelStyle}>Remarks</label>
                    <textarea value={reviewData.remarks} onChange={e => setReviewData(p => ({...p, remarks:e.target.value}))} rows={3}
                      placeholder="Review remarks..."
                      style={{ ...inputStyle, resize:'vertical' }}/>
                  </div>
                </div>
                <div style={{ display:'flex', gap:10 }}>
                  <button onClick={() => setReviewing(false)}
                    style={{ flex:1, padding:'9px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
                  <button onClick={handleReview} disabled={saving}
                    style={{ flex:2, padding:'9px', background: reviewData.status==='Rejected' ? '#ef4444' : '#10b981', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                    {saving ? 'Submitting...' : reviewData.status === 'Rejected' ? 'Reject' : 'Approve'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Register Vendor Modal */}
      {showRegForm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#fff', borderRadius:16, padding:32, width:720, maxHeight:'93vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.2)' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
              <h2 style={{ fontSize:18, fontWeight:700, color:'#1f2937', margin:0 }}>New Vendor Registration</h2>
              <button onClick={() => { setShowRegForm(false); setForm(EMPTY_REG); }} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af' }}><X size={20}/></button>
            </div>

            {[
              { title:'Basic Info', fields:[
                ['Vendor Name *', 'vendor_name', 'text', 'Company / trade name'],
                ['Vendor Type', 'vendor_type', 'select', VENDOR_TYPES],
                ['Products / Services', 'products_services', 'textarea', 'Products or services offered'],
              ]},
              { title:'GST & Compliance', fields:[
                ['GSTIN', 'gstin', 'text', '27AABCU9603R1ZX'],
                ['PAN', 'pan', 'text', 'AABCU9603R'],
                ['MSME Registered', 'msme_status', 'checkbox'],
                ['Udyam Number', 'udyam_number', 'text', 'UDYAM-XX-00-0000000'],
        ]},
              { title:'Bank Details', fields:[
                ['Bank Name', 'bank_name', 'text', 'Bank name'],
                ['Account Number', 'account_number', 'text', 'Account number'],
                ['IFSC Code', 'ifsc', 'text', 'SBIN0001234'],
              ]},
              { title:'Contact Details', fields:[
                ['Contact Person', 'contact_person', 'text', 'Name'],
                ['Email *', 'email', 'email', 'email@company.com'],
                ['Phone', 'phone', 'text', '+91 98765 43210'],
                ['Website', 'website', 'text', 'https://company.com'],
                ['Address', 'address', 'textarea', 'Full address'],
                ['City', 'city', 'text', 'City'],
                ['State', 'state', 'text', 'State'],
                ['Pincode', 'pincode', 'text', '560001'],
              ]},
              { title:'Capability & Documents', fields:[
                ['ISO Certificates', 'iso_certificates', 'text', 'ISO 9001:2015, ...'],
                ['Quality Docs (Drive Link)', 'quality_docs_link', 'text', 'https://drive.google.com/...'],
                ['NDA Signed', 'nda_signed', 'checkbox'],
                ['Technical Capability', 'technical_capability', 'textarea', 'Describe technical capability...'],
                ['Annual Turnover (₹)', 'annual_turnover', 'number', '0'],
                ['Number of Employees', 'num_employees', 'number', '0'],
                ['Year Established', 'year_established', 'number', '2000'],
              ]},
            ].map(section => (
              <div key={section.title} style={{ marginBottom:24 }}>
                <div style={{ fontSize:12, fontWeight:700, color:'#6B3FDB', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:12 }}>{section.title}</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
                  {section.fields.map(([lbl, key, type, ph]) => (
                    <div key={key} style={{ gridColumn: type==='textarea' || (type==='text' && lbl.includes('Address')) ? '1/-1' : 'auto' }}>
                      {type === 'checkbox' ? (
                        <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, color:'#374151', cursor:'pointer', paddingTop:20 }}>
                          <input type="checkbox" checked={!!form[key]} onChange={e => fld(key, e.target.checked)} style={{ accentColor:'#6B3FDB', width:14, height:14 }}/>
                          {lbl}
                        </label>
                      ) : type === 'select' ? (
                        <>
                          <label style={labelStyle}>{lbl}</label>
                          <select value={form[key]} onChange={e => fld(key, e.target.value)} style={inputStyle}>
                            {ph.map(o => <option key={o}>{o}</option>)}
                          </select>
                        </>
                      ) : type === 'textarea' ? (
                        <>
                          <label style={labelStyle}>{lbl}</label>
                          <textarea value={form[key]} onChange={e => fld(key, e.target.value)} rows={3} placeholder={ph}
                            style={{ ...inputStyle, resize:'vertical' }}/>
                        </>
                      ) : (
                        <>
                          <label style={labelStyle}>{lbl}</label>
                          <input type={type} value={form[key]} onChange={e => fld(key, e.target.value)} placeholder={ph} style={inputStyle}/>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}

            <div style={{ display:'flex', gap:12, justifyContent:'flex-end' }}>
              <button onClick={() => { setShowRegForm(false); setForm(EMPTY_REG); }}
                style={{ padding:'9px 20px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13, color:'#374151' }}>Cancel</button>
              <button onClick={handleRegister} disabled={saving}
                style={{ padding:'9px 20px', background:'#6B3FDB', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600, opacity:saving?0.6:1 }}>
                {saving ? 'Submitting...' : 'Submit Registration'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
