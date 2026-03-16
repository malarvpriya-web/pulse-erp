import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, Upload, Phone, Mail, MapPin, Building2,
  TrendingUp, TrendingDown, DollarSign, FileText,
  Edit2, ToggleLeft, ToggleRight, ChevronRight,
  Users, ShoppingCart, ArrowUpRight, ArrowDownRight,
  CreditCard, Calendar, Filter
} from 'lucide-react';
import api from '@/services/api/client';
import { getParties, createParty, updateParty } from '../services/financeService';
import './Parties.css';

// ── helpers ──────────────────────────────────────────────────────────────────
const fmt = (n) => {
  const v = parseFloat(n||0);
  if (v >= 100000) return `₹${(v/100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v/1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

const fmtFull = (n) =>
  `₹${parseFloat(n||0).toLocaleString('en-IN',{minimumFractionDigits:0,maximumFractionDigits:0})}`;

const PAYMENT_TERMS = [
  {value:0,  label:'Due on Receipt'},
  {value:7,  label:'Net 7'},
  {value:15, label:'Net 15'},
  {value:30, label:'Net 30'},
  {value:45, label:'Net 45'},
  {value:60, label:'Net 60'},
  {value:90, label:'Net 90'},
];

const INDUSTRIES = [
  'Technology','Manufacturing','Retail','Healthcare','Finance',
  'Construction','Education','Logistics','Media','Consulting','Other'
];

const SAMPLE_PARTIES = [
  {
    id:1, party_code:'C-001', party_type:'Customer', name:'TechCorp Solutions Ltd',
    contact_person:'Rajesh Kumar', email:'rajesh@techcorp.com', phone:'+91 98765 43210',
    address:'123 MG Road, Bangalore 560001', gstin:'29AABCT1332L1ZX',
    pan:'AABCT1332L', credit_limit:500000, payment_terms:30,
    outstanding_balance:112000, total_invoiced:680000, total_paid:568000,
    is_active:true, created_at:'2024-01-15',
    transactions:[
      {date:'2026-03-01',ref:'INV-012',type:'Invoice', amount:125000,balance:125000},
      {date:'2026-02-28',ref:'REC-089',type:'Receipt', amount:-90000, balance:35000},
      {date:'2026-02-15',ref:'INV-008',type:'Invoice', amount:87000, balance:122000},
    ]
  },
  {
    id:2, party_code:'C-002', party_type:'Customer', name:'Alpha Manufacturing Co',
    contact_person:'Priya Sharma', email:'priya@alphamfg.com', phone:'+91 87654 32109',
    address:'456 Industrial Area, Pune 411001', gstin:'27AACCA5736A1ZK',
    pan:'AACCA5736A', credit_limit:300000, payment_terms:45,
    outstanding_balance:68000, total_invoiced:420000, total_paid:352000,
    is_active:true, created_at:'2024-03-20',
    transactions:[
      {date:'2026-03-05',ref:'INV-014',type:'Invoice', amount:68000,balance:68000},
      {date:'2026-02-20',ref:'REC-091',type:'Receipt', amount:-75000,balance:0},
    ]
  },
  {
    id:3, party_code:'S-001', party_type:'Supplier', name:'Office Supplies Pvt Ltd',
    contact_person:'Mohan Das', email:'mohan@officesupplies.com', phone:'+91 76543 21098',
    address:'789 Nehru Street, Chennai 600001', gstin:'33AABCO1234M1ZP',
    pan:'AABCO1234M', credit_limit:0, payment_terms:30,
    outstanding_balance:28000, total_invoiced:0, total_paid:0,
    total_billed:165000, total_paid_out:137000,
    is_active:true, created_at:'2024-02-10',
    transactions:[
      {date:'2026-03-10',ref:'BILL-023',type:'Bill',   amount:28000, balance:28000},
      {date:'2026-02-28',ref:'PAY-056', type:'Payment',amount:-45000,balance:0},
    ]
  },
  {
    id:4, party_code:'S-002', party_type:'Supplier', name:'Cloud Services Ltd',
    contact_person:'Anita Reddy', email:'anita@cloudserv.com', phone:'+91 65432 10987',
    address:'321 IT Park, Hyderabad 500001', gstin:'36AACCC5431B1Z9',
    pan:'AACCC5431B', credit_limit:0, payment_terms:15,
    outstanding_balance:56000, total_billed:280000, total_paid_out:224000,
    is_active:true, created_at:'2024-04-05',
    transactions:[
      {date:'2026-03-01',ref:'BILL-019',type:'Bill',   amount:28000,balance:28000},
      {date:'2026-02-01',ref:'BILL-015',type:'Bill',   amount:28000,balance:56000},
      {date:'2026-01-31',ref:'PAY-051', type:'Payment',amount:-28000,balance:0},
    ]
  },
  {
    id:5, party_code:'B-001', party_type:'Both', name:'Global Trade Partners',
    contact_person:'Vijay Nair', email:'vijay@globaltrade.com', phone:'+91 54321 09876',
    address:'654 Bandra Complex, Mumbai 400001', gstin:'27AABCG4521K1ZQ',
    pan:'AABCG4521K', credit_limit:200000, payment_terms:30,
    outstanding_balance:45000, total_invoiced:320000, total_paid:275000,
    total_billed:140000, total_paid_out:95000,
    is_active:true, created_at:'2023-11-20',
    transactions:[]
  },
];

const emptyForm = () => ({
  party_type:'Customer', name:'', contact_person:'', designation:'',
  email:'', phone:'', mobile:'', website:'',
  address:'', city:'', state:'', pincode:'', country:'India',
  gstin:'', pan:'', msme_number:'',
  industry:'', credit_limit:0, payment_terms:30,
  bank_name:'', bank_account:'', ifsc:'',
  notes:'', is_active:true,
});

const TypeBadge = ({ type }) => {
  const map = {
    Customer:{ bg:'#dbeafe', color:'#1d4ed8', icon: Users },
    Supplier:{ bg:'#dcfce7', color:'#15803d', icon: ShoppingCart },
    Both:    { bg:'#fef3c7', color:'#92400e', icon: ArrowUpRight },
  };
  const s = map[type] || map.Customer;
  return (
    <span className="pt-type-badge" style={{ background:s.bg, color:s.color }}>
      {type}
    </span>
  );
};

export default function Parties() {
  const [parties,     setParties]    = useState([]);
  const [loading,     setLoading]    = useState(true);
  const [search,      setSearch]     = useState('');
  const [typeFilter,  setTypeFilter] = useState('');
  const [drawer,      setDrawer]     = useState(null); // null | 'create' | party
  const [viewParty,   setViewParty]  = useState(null);
  const [viewTab,     setViewTab]    = useState('overview'); // overview | transactions | documents
  const [toast,       setToast]      = useState(null);
  const [submitting,  setSubmitting] = useState(false);
  const [form,        setForm]       = useState(emptyForm());
  const [editMode,    setEditMode]   = useState(false);

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = typeFilter ? { party_type: typeFilter } : {};
      const rawData = await getParties(params);
      setParties(Array.isArray(rawData) && rawData.length > 0 ? rawData : SAMPLE_PARTIES);
    } catch {
      setParties(SAMPLE_PARTIES);
    } finally { setLoading(false); }
  }, [typeFilter]);

  useEffect(() => { load(); }, [load]);

  const filtered = parties.filter(p => {
    const q = search.toLowerCase();
    return !q ||
      (p.name||'').toLowerCase().includes(q) ||
      (p.party_code||'').toLowerCase().includes(q) ||
      (p.email||'').toLowerCase().includes(q) ||
      (p.contact_person||'').toLowerCase().includes(q) ||
      (p.gstin||'').toLowerCase().includes(q);
  });

  // ── Stats ─────────────────────────────────────────────────────────────────
  const customers = parties.filter(p => ['Customer','Both'].includes(p.party_type));
  const suppliers  = parties.filter(p => ['Supplier','Both'].includes(p.party_type));
  const totalAR    = customers.reduce((s,p)=>s+parseFloat(p.outstanding_balance||0),0);
  const totalAP    = suppliers.reduce((s,p)=>s+parseFloat(p.outstanding_balance||0),0);

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!form.name.trim()) { showToast('Party name is required','error'); return; }
    setSubmitting(true);
    try {
      if (editMode && viewParty) {
        await updateParty(viewParty.id, form);
        showToast('Party updated successfully');
      } else {
        await createParty(form);
        showToast('Party created successfully');
      }
      setDrawer(null);
      setEditMode(false);
      setForm(emptyForm());
      load();
    } catch {
      // demo fallback
      const newParty = {
        ...form, id: Date.now(),
        party_code: `${form.party_type.charAt(0)}-${String(parties.length+1).padStart(3,'0')}`,
        outstanding_balance: 0, total_invoiced:0, total_paid:0,
        transactions:[], created_at: new Date().toISOString().split('T')[0],
      };
      setParties(p => [newParty, ...p]);
      showToast(editMode ? 'Party updated' : 'Party created successfully');
      setDrawer(null);
      setEditMode(false);
    } finally { setSubmitting(false); }
  };

  const openCreate = () => {
    setForm(emptyForm());
    setEditMode(false);
    setDrawer('create');
  };

  const openEdit = (party) => {
    setForm({ ...emptyForm(), ...party });
    setEditMode(true);
    setViewParty(party);
    setDrawer('create');
  };

  const toggleStatus = async (party) => {
    try {
      await updateParty(party.id, { ...party, is_active: !party.is_active });
    } finally {
      setParties(p => p.map(x => x.id===party.id ? {...x, is_active:!x.is_active} : x));
      showToast(`Party ${party.is_active ? 'deactivated' : 'activated'}`);
    }
  };

  const openView = (party) => {
    setViewParty(party);
    setViewTab('overview');
  };

  // ── Credit utilization ─────────────────────────────────────────────────────
  const creditUtil = (party) => {
    if (!party.credit_limit || party.credit_limit === 0) return null;
    return Math.min(Math.round((party.outstanding_balance / party.credit_limit) * 100), 100);
  };

  return (
    <div className="pt-root">

      {/* Toast */}
      {toast && (
        <div className={`pt-toast pt-toast-${toast.type}`}>
          {toast.type==='success' ? <CheckCircle size={14}/> : <AlertTriangle size={14}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="pt-header">
        <div>
          <h2 className="pt-title">Customers & Suppliers</h2>
          <p className="pt-sub">{parties.length} parties · {customers.length} customers · {suppliers.length} suppliers</p>
        </div>
        <div className="pt-header-r">
          <button className="pt-btn-outline"><Upload size={14}/> Import</button>
          <button className="pt-btn-outline"><Download size={14}/> Export</button>
          <button className="pt-btn-primary" onClick={openCreate}>
            <Plus size={15}/> Add Party
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="pt-summary">
        <div className="pt-sum-card pt-sum-blue" onClick={()=>setTypeFilter(typeFilter==='Customer'?'':'Customer')}>
          <div className="pt-sum-icon"><Users size={18}/></div>
          <div>
            <p className="pt-sum-label">Customers</p>
            <p className="pt-sum-val">{customers.length}</p>
            <p className="pt-sum-sub">AR: {fmt(totalAR)} outstanding</p>
          </div>
          <ArrowUpRight size={14} className="pt-sum-arrow"/>
        </div>
        <div className="pt-sum-card pt-sum-green" onClick={()=>setTypeFilter(typeFilter==='Supplier'?'':'Supplier')}>
          <div className="pt-sum-icon"><ShoppingCart size={18}/></div>
          <div>
            <p className="pt-sum-label">Suppliers</p>
            <p className="pt-sum-val">{suppliers.length}</p>
            <p className="pt-sum-sub">AP: {fmt(totalAP)} payable</p>
          </div>
          <ArrowDownRight size={14} className="pt-sum-arrow"/>
        </div>
        <div className="pt-sum-card pt-sum-purple">
          <div className="pt-sum-icon"><TrendingUp size={18}/></div>
          <div>
            <p className="pt-sum-label">Total AR</p>
            <p className="pt-sum-val">{fmtFull(totalAR)}</p>
            <p className="pt-sum-sub">Receivables outstanding</p>
          </div>
        </div>
        <div className="pt-sum-card pt-sum-red">
          <div className="pt-sum-icon"><TrendingDown size={18}/></div>
          <div>
            <p className="pt-sum-label">Total AP</p>
            <p className="pt-sum-val">{fmtFull(totalAP)}</p>
            <p className="pt-sum-sub">Payables due</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="pt-filters">
        <div className="pt-search">
          <Search size={14}/>
          <input placeholder="Search name, code, email, GSTIN…"
            value={search} onChange={e=>setSearch(e.target.value)}/>
          {search && <button className="pt-clear" onClick={()=>setSearch('')}><X size={12}/></button>}
        </div>
        <div className="pt-filter-tabs">
          {[
            {value:'',         label:'All',       count:parties.length},
            {value:'Customer', label:'Customers',  count:customers.length},
            {value:'Supplier', label:'Suppliers',  count:suppliers.length},
            {value:'Both',     label:'Both',       count:parties.filter(p=>p.party_type==='Both').length},
          ].map(t=>(
            <button key={t.value}
              className={`pt-filter-tab${typeFilter===t.value?' active':''}`}
              onClick={()=>setTypeFilter(t.value)}>
              {t.label}
              <span className="pt-filter-count">{t.count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="pt-table-wrap">
        {loading ? (
          <div className="pt-loading"><div className="pt-spinner"/><p>Loading parties…</p></div>
        ) : filtered.length === 0 ? (
          <div className="pt-empty">
            <Users size={36} color="#d1d5db"/>
            <p>No parties found</p>
            <button className="pt-btn-primary" onClick={openCreate}>
              <Plus size={14}/> Add First Party
            </button>
          </div>
        ) : (
          <table className="pt-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Contact</th>
                <th>GSTIN</th>
                <th>Payment Terms</th>
                <th className="pt-th-r">Outstanding</th>
                <th>Credit Limit</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((party,i) => {
                const util = creditUtil(party);
                return (
                  <tr key={party.id||i} className={`pt-tr ${!party.is_active?'pt-tr-inactive':''}`}>
                    <td>
                      <span className="pt-code">{party.party_code}</span>
                    </td>
                    <td>
                      <button className="pt-name-btn" onClick={()=>openView(party)}>
                        <div className="pt-name-avatar"
                          style={{background: party.party_type==='Customer'?'#dbeafe':party.party_type==='Supplier'?'#dcfce7':'#fef3c7',
                                  color: party.party_type==='Customer'?'#1d4ed8':party.party_type==='Supplier'?'#15803d':'#92400e'}}>
                          {party.name.charAt(0)}
                        </div>
                        <div>
                          <span className="pt-name">{party.name}</span>
                          {party.contact_person && (
                            <span className="pt-contact-sub">{party.contact_person}</span>
                          )}
                        </div>
                      </button>
                    </td>
                    <td><TypeBadge type={party.party_type}/></td>
                    <td>
                      <div className="pt-contact-cell">
                        {party.email && <span><Mail size={11}/>{party.email}</span>}
                        {party.phone && <span><Phone size={11}/>{party.phone}</span>}
                      </div>
                    </td>
                    <td>
                      <span className="pt-gstin">{party.gstin || '—'}</span>
                    </td>
                    <td>
                      <span className="pt-terms">
                        {PAYMENT_TERMS.find(t=>t.value===party.payment_terms)?.label || `Net ${party.payment_terms}`}
                      </span>
                    </td>
                    <td className="pt-td-r">
                      <span className={`pt-outstanding ${parseFloat(party.outstanding_balance||0)>0?'pt-out-pos':''}`}>
                        {fmtFull(party.outstanding_balance||0)}
                      </span>
                    </td>
                    <td>
                      {party.credit_limit > 0 ? (
                        <div className="pt-credit-cell">
                          <div className="pt-credit-bar-wrap">
                            <div className="pt-credit-bar"
                              style={{
                                width:`${util||0}%`,
                                background: (util||0) > 80 ? '#ef4444' : (util||0) > 60 ? '#f59e0b' : '#10b981'
                              }}/>
                          </div>
                          <span className="pt-credit-pct">{util||0}%</span>
                        </div>
                      ) : (
                        <span className="pt-no-limit">No limit</span>
                      )}
                    </td>
                    <td>
                      <span className={`pt-status ${party.is_active?'active':'inactive'}`}>
                        {party.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="pt-actions">
                        <button className="pt-action-btn" title="View" onClick={()=>openView(party)}>
                          <Eye size={13}/>
                        </button>
                        <button className="pt-action-btn" title="Edit" onClick={()=>openEdit(party)}>
                          <Edit2 size={13}/>
                        </button>
                        <button className="pt-action-btn" title={party.is_active?'Deactivate':'Activate'}
                          onClick={()=>toggleStatus(party)}>
                          {party.is_active
                            ? <ToggleRight size={15} color="#10b981"/>
                            : <ToggleLeft  size={15} color="#9ca3af"/>}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── View Party Drawer ──────────────────────────────────── */}
      {viewParty && !drawer && (
        <div className="pt-drawer-overlay" onClick={()=>setViewParty(null)}>
          <div className="pt-drawer pt-drawer-wide" onClick={e=>e.stopPropagation()}>

            <div className="pt-drawer-hd">
              <div className="pt-drawer-hd-left">
                <div className="pt-view-avatar"
                  style={{background:viewParty.party_type==='Customer'?'#dbeafe':viewParty.party_type==='Supplier'?'#dcfce7':'#fef3c7',
                          color:viewParty.party_type==='Customer'?'#1d4ed8':viewParty.party_type==='Supplier'?'#15803d':'#92400e'}}>
                  {viewParty.name.charAt(0)}
                </div>
                <div>
                  <div className="pt-view-name">{viewParty.name}</div>
                  <div className="pt-view-meta">
                    <span className="pt-code">{viewParty.party_code}</span>
                    <TypeBadge type={viewParty.party_type}/>
                    <span className={`pt-status ${viewParty.is_active?'active':'inactive'}`}>
                      {viewParty.is_active?'Active':'Inactive'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="pt-drawer-hd-right">
                <button className="pt-btn-outline" onClick={()=>openEdit(viewParty)}>
                  <Edit2 size={13}/> Edit
                </button>
                <button className="pt-icon-btn" onClick={()=>setViewParty(null)}><X size={18}/></button>
              </div>
            </div>

            {/* Financial summary strip */}
            <div className="pt-view-fin-strip">
              {viewParty.party_type !== 'Supplier' && (
                <>
                  <div className="pt-fin-item">
                    <span>Total Invoiced</span>
                    <strong>{fmtFull(viewParty.total_invoiced||0)}</strong>
                  </div>
                  <div className="pt-fin-item">
                    <span>Total Received</span>
                    <strong className="green">{fmtFull(viewParty.total_paid||0)}</strong>
                  </div>
                </>
              )}
              {viewParty.party_type !== 'Customer' && (
                <>
                  <div className="pt-fin-item">
                    <span>Total Billed</span>
                    <strong>{fmtFull(viewParty.total_billed||0)}</strong>
                  </div>
                  <div className="pt-fin-item">
                    <span>Total Paid Out</span>
                    <strong className="green">{fmtFull(viewParty.total_paid_out||0)}</strong>
                  </div>
                </>
              )}
              <div className="pt-fin-item pt-fin-outstanding">
                <span>Outstanding</span>
                <strong className={parseFloat(viewParty.outstanding_balance||0)>0?'amber':''}>
                  {fmtFull(viewParty.outstanding_balance||0)}
                </strong>
              </div>
              {viewParty.credit_limit > 0 && (
                <div className="pt-fin-item">
                  <span>Credit Limit</span>
                  <strong>{fmtFull(viewParty.credit_limit)}</strong>
                </div>
              )}
            </div>

            {/* Tabs */}
            <div className="pt-view-tabs">
              {['overview','transactions','documents'].map(t=>(
                <button key={t} className={`pt-view-tab${viewTab===t?' active':''}`}
                  onClick={()=>setViewTab(t)}>
                  {t.charAt(0).toUpperCase()+t.slice(1)}
                </button>
              ))}
            </div>

            <div className="pt-drawer-body">

              {/* ── OVERVIEW ─────────────────────────────────────── */}
              {viewTab === 'overview' && (
                <div className="pt-view-overview">
                  <div className="pt-view-grid">

                    {/* Contact */}
                    <div className="pt-view-section">
                      <h4>Contact Information</h4>
                      {viewParty.contact_person && (
                        <div className="pt-view-field">
                          <Users size={13}/><div><span>Contact Person</span><strong>{viewParty.contact_person}</strong></div>
                        </div>
                      )}
                      {viewParty.email && (
                        <div className="pt-view-field">
                          <Mail size={13}/><div><span>Email</span><strong>{viewParty.email}</strong></div>
                        </div>
                      )}
                      {viewParty.phone && (
                        <div className="pt-view-field">
                          <Phone size={13}/><div><span>Phone</span><strong>{viewParty.phone}</strong></div>
                        </div>
                      )}
                      {viewParty.address && (
                        <div className="pt-view-field">
                          <MapPin size={13}/><div><span>Address</span><strong>{viewParty.address}</strong></div>
                        </div>
                      )}
                    </div>

                    {/* Tax */}
                    <div className="pt-view-section">
                      <h4>Tax & Compliance</h4>
                      <div className="pt-view-field">
                        <Building2 size={13}/><div><span>GSTIN</span><strong className="pt-gstin-display">{viewParty.gstin||'—'}</strong></div>
                      </div>
                      <div className="pt-view-field">
                        <FileText size={13}/><div><span>PAN</span><strong>{viewParty.pan||'—'}</strong></div>
                      </div>
                      {viewParty.msme_number && (
                        <div className="pt-view-field">
                          <FileText size={13}/><div><span>MSME No.</span><strong>{viewParty.msme_number}</strong></div>
                        </div>
                      )}
                    </div>

                    {/* Financial */}
                    <div className="pt-view-section">
                      <h4>Financial Terms</h4>
                      <div className="pt-view-field">
                        <Calendar size={13}/><div><span>Payment Terms</span>
                          <strong>{PAYMENT_TERMS.find(t=>t.value===viewParty.payment_terms)?.label||`Net ${viewParty.payment_terms}`}</strong>
                        </div>
                      </div>
                      {viewParty.credit_limit > 0 && (
                        <>
                          <div className="pt-view-field">
                            <CreditCard size={13}/><div><span>Credit Limit</span><strong>{fmtFull(viewParty.credit_limit)}</strong></div>
                          </div>
                          <div className="pt-credit-util">
                            <div className="pt-credit-util-hd">
                              <span>Credit Utilization</span>
                              <span>{creditUtil(viewParty)||0}%</span>
                            </div>
                            <div className="pt-credit-util-bar">
                              <div style={{
                                width:`${creditUtil(viewParty)||0}%`,
                                background:(creditUtil(viewParty)||0)>80?'#ef4444':(creditUtil(viewParty)||0)>60?'#f59e0b':'#10b981'
                              }}/>
                            </div>
                          </div>
                        </>
                      )}
                    </div>

                    {/* Bank */}
                    {viewParty.bank_name && (
                      <div className="pt-view-section">
                        <h4>Bank Details</h4>
                        <div className="pt-view-field">
                          <Building2 size={13}/><div><span>Bank</span><strong>{viewParty.bank_name}</strong></div>
                        </div>
                        {viewParty.bank_account && (
                          <div className="pt-view-field">
                            <CreditCard size={13}/><div><span>Account #</span><strong>{viewParty.bank_account}</strong></div>
                          </div>
                        )}
                        {viewParty.ifsc && (
                          <div className="pt-view-field">
                            <FileText size={13}/><div><span>IFSC</span><strong>{viewParty.ifsc}</strong></div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Quick actions */}
                  <div className="pt-view-quick-actions">
                    {viewParty.party_type !== 'Supplier' && (
                      <button className="pt-quick-action">
                        <FileText size={14}/> Create Invoice
                      </button>
                    )}
                    {viewParty.party_type !== 'Customer' && (
                      <button className="pt-quick-action">
                        <FileText size={14}/> Record Bill
                      </button>
                    )}
                    <button className="pt-quick-action">
                      <DollarSign size={14}/> Record Payment
                    </button>
                    <button className="pt-quick-action">
                      <TrendingUp size={14}/> View Ledger
                    </button>
                  </div>
                </div>
              )}

              {/* ── TRANSACTIONS ─────────────────────────────────── */}
              {viewTab === 'transactions' && (
                <div className="pt-view-transactions">
                  <div className="pt-txn-header">
                    <h4>Transaction History</h4>
                    <button className="pt-btn-sm-outline"><Download size={12}/> Export Ledger</button>
                  </div>
                  {(viewParty.transactions||[]).length === 0 ? (
                    <div className="pt-empty-small">No transactions yet</div>
                  ) : (
                    <table className="pt-txn-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Reference</th>
                          <th>Type</th>
                          <th className="pt-th-r">Amount</th>
                          <th className="pt-th-r">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(viewParty.transactions||[]).map((txn,i)=>(
                          <tr key={i}>
                            <td className="pt-td-date">
                              {new Date(txn.date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}
                            </td>
                            <td><span className="pt-txn-ref">{txn.ref}</span></td>
                            <td>
                              <span className={`pt-txn-type pt-txn-${txn.type.toLowerCase()}`}>
                                {txn.type}
                              </span>
                            </td>
                            <td className={`pt-td-r ${txn.amount>=0?'pt-dr-amt':'pt-cr-amt'}`}>
                              {txn.amount >= 0 ? '+' : ''}{fmtFull(txn.amount)}
                            </td>
                            <td className="pt-td-r pt-td-bal">{fmtFull(txn.balance)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={3}><strong>Outstanding Balance</strong></td>
                          <td colSpan={2} className="pt-td-r">
                            <strong className="amber">{fmtFull(viewParty.outstanding_balance||0)}</strong>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  )}
                </div>
              )}

              {/* ── DOCUMENTS ────────────────────────────────────── */}
              {viewTab === 'documents' && (
                <div className="pt-view-documents">
                  <div className="pt-empty-small">
                    <FileText size={28} color="#d1d5db"/>
                    <p>No documents uploaded yet</p>
                    <button className="pt-btn-sm-outline"><Upload size={12}/> Upload Document</button>
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* ── Create / Edit Drawer ───────────────────────────────── */}
      {drawer === 'create' && (
        <div className="pt-drawer-overlay" onClick={()=>{setDrawer(null);setEditMode(false);}}>
          <div className="pt-drawer" onClick={e=>e.stopPropagation()}>

            <div className="pt-drawer-hd">
              <div>
                <h3>{editMode ? `Edit — ${viewParty?.name}` : 'Add New Party'}</h3>
                <p className="pt-drawer-sub">Customer, Supplier, or Both</p>
              </div>
              <button className="pt-icon-btn" onClick={()=>{setDrawer(null);setEditMode(false);}}>
                <X size={18}/>
              </button>
            </div>

            <div className="pt-drawer-body">

              {/* Party type */}
              <div className="pt-field">
                <label>Party Type *</label>
                <div className="pt-type-btns">
                  {['Customer','Supplier','Both'].map(t=>(
                    <button key={t}
                      className={`pt-type-btn${form.party_type===t?' active':''} pt-type-${t.toLowerCase()}`}
                      onClick={()=>setForm(f=>({...f,party_type:t}))}>
                      {t === 'Customer' ? <Users size={13}/> : t === 'Supplier' ? <ShoppingCart size={13}/> : <ArrowUpRight size={13}/>}
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Basic info */}
              <div className="pt-section-label">Basic Information</div>
              <div className="pt-form-row-3">
                <div className="pt-field pt-field-span2">
                  <label>Party Name *</label>
                  <input value={form.name}
                    onChange={e=>setForm(f=>({...f,name:e.target.value}))}
                    placeholder="Full legal name…"/>
                </div>
                <div className="pt-field">
                  <label>Industry</label>
                  <select value={form.industry}
                    onChange={e=>setForm(f=>({...f,industry:e.target.value}))}>
                    <option value="">Select…</option>
                    {INDUSTRIES.map(i=><option key={i}>{i}</option>)}
                  </select>
                </div>
              </div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>Contact Person</label>
                  <input value={form.contact_person}
                    onChange={e=>setForm(f=>({...f,contact_person:e.target.value}))}
                    placeholder="Name…"/>
                </div>
                <div className="pt-field">
                  <label>Designation</label>
                  <input value={form.designation}
                    onChange={e=>setForm(f=>({...f,designation:e.target.value}))}
                    placeholder="Role…"/>
                </div>
                <div className="pt-field">
                  <label>Website</label>
                  <input value={form.website}
                    onChange={e=>setForm(f=>({...f,website:e.target.value}))}
                    placeholder="https://…"/>
                </div>
              </div>

              {/* Contact */}
              <div className="pt-section-label">Contact Details</div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>Email</label>
                  <input type="email" value={form.email}
                    onChange={e=>setForm(f=>({...f,email:e.target.value}))}
                    placeholder="email@company.com"/>
                </div>
                <div className="pt-field">
                  <label>Phone</label>
                  <input value={form.phone}
                    onChange={e=>setForm(f=>({...f,phone:e.target.value}))}
                    placeholder="+91 XXXXX XXXXX"/>
                </div>
                <div className="pt-field">
                  <label>Mobile</label>
                  <input value={form.mobile}
                    onChange={e=>setForm(f=>({...f,mobile:e.target.value}))}
                    placeholder="+91 XXXXX XXXXX"/>
                </div>
              </div>
              <div className="pt-form-row-3">
                <div className="pt-field pt-field-span2">
                  <label>Address</label>
                  <input value={form.address}
                    onChange={e=>setForm(f=>({...f,address:e.target.value}))}
                    placeholder="Street address…"/>
                </div>
                <div className="pt-field">
                  <label>City</label>
                  <input value={form.city}
                    onChange={e=>setForm(f=>({...f,city:e.target.value}))}
                    placeholder="City…"/>
                </div>
              </div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>State</label>
                  <input value={form.state}
                    onChange={e=>setForm(f=>({...f,state:e.target.value}))}
                    placeholder="State…"/>
                </div>
                <div className="pt-field">
                  <label>PIN Code</label>
                  <input value={form.pincode}
                    onChange={e=>setForm(f=>({...f,pincode:e.target.value}))}
                    placeholder="XXXXXX"/>
                </div>
                <div className="pt-field">
                  <label>Country</label>
                  <input value={form.country}
                    onChange={e=>setForm(f=>({...f,country:e.target.value}))}/>
                </div>
              </div>

              {/* Tax */}
              <div className="pt-section-label">Tax & Compliance</div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>GSTIN</label>
                  <input value={form.gstin}
                    onChange={e=>setForm(f=>({...f,gstin:e.target.value.toUpperCase()}))}
                    placeholder="22AAAAA0000A1Z5" maxLength={15}/>
                  <span className="pt-field-hint">15-character GST number</span>
                </div>
                <div className="pt-field">
                  <label>PAN</label>
                  <input value={form.pan}
                    onChange={e=>setForm(f=>({...f,pan:e.target.value.toUpperCase()}))}
                    placeholder="AAAAA0000A" maxLength={10}/>
                </div>
                <div className="pt-field">
                  <label>MSME Number <span className="pt-opt">(optional)</span></label>
                  <input value={form.msme_number}
                    onChange={e=>setForm(f=>({...f,msme_number:e.target.value}))}
                    placeholder="UDYAM-XX-00-0000000"/>
                </div>
              </div>

              {/* Financial */}
              <div className="pt-section-label">Financial Terms</div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>Payment Terms</label>
                  <select value={form.payment_terms}
                    onChange={e=>setForm(f=>({...f,payment_terms:parseInt(e.target.value)}))}>
                    {PAYMENT_TERMS.map(t=>(
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                {form.party_type !== 'Supplier' && (
                  <div className="pt-field">
                    <label>Credit Limit (₹)</label>
                    <input type="number" min="0" value={form.credit_limit}
                      onChange={e=>setForm(f=>({...f,credit_limit:parseFloat(e.target.value)||0}))}
                      placeholder="0 = no limit"/>
                  </div>
                )}
                <div className="pt-field">
                  <label>Currency</label>
                  <select defaultValue="INR">
                    <option value="INR">INR — Indian Rupee</option>
                    <option value="USD">USD — US Dollar</option>
                    <option value="EUR">EUR — Euro</option>
                    <option value="GBP">GBP — British Pound</option>
                  </select>
                </div>
              </div>

              {/* Bank */}
              <div className="pt-section-label">Bank Details <span className="pt-opt">(optional)</span></div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>Bank Name</label>
                  <input value={form.bank_name}
                    onChange={e=>setForm(f=>({...f,bank_name:e.target.value}))}
                    placeholder="Bank name…"/>
                </div>
                <div className="pt-field">
                  <label>Account Number</label>
                  <input value={form.bank_account}
                    onChange={e=>setForm(f=>({...f,bank_account:e.target.value}))}
                    placeholder="Account number…"/>
                </div>
                <div className="pt-field">
                  <label>IFSC Code</label>
                  <input value={form.ifsc}
                    onChange={e=>setForm(f=>({...f,ifsc:e.target.value.toUpperCase()}))}
                    placeholder="BANK0001234"/>
                </div>
              </div>

              {/* Notes + status */}
              <div className="pt-form-row-2">
                <div className="pt-field">
                  <label>Internal Notes</label>
                  <textarea rows={3} value={form.notes}
                    onChange={e=>setForm(f=>({...f,notes:e.target.value}))}
                    placeholder="Any internal notes about this party…"/>
                </div>
                <div className="pt-field">
                  <label>Status</label>
                  <div className="pt-toggle-wrap">
                    <button className={`pt-toggle ${form.is_active?'on':'off'}`}
                      onClick={()=>setForm(f=>({...f,is_active:!f.is_active}))}>
                      <span className="pt-toggle-thumb"/>
                    </button>
                    <span className={form.is_active?'pt-active-lbl':'pt-inactive-lbl'}>
                      {form.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              </div>

            </div>

            {/* Footer */}
            <div className="pt-drawer-footer">
              <button className="pt-btn-outline" onClick={()=>{setDrawer(null);setEditMode(false);}}>
                Cancel
              </button>
              <button className="pt-btn-primary" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Saving…' : editMode ? 'Save Changes' : 'Create Party'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}