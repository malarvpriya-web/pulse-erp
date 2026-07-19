import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus, Search, X, CheckCircle, AlertTriangle, Eye,
  Download, Upload, Phone, Mail, MapPin, Building2,
  TrendingUp, TrendingDown, IndianRupee, FileText,
  Edit2, ToggleLeft, ToggleRight,
  Users, ShoppingCart, ArrowUpRight, ArrowDownRight,
  CreditCard, Calendar, Filter, AlertCircle
} from 'lucide-react';
import {
  getParties, createParty, updateParty,
  getPartyTransactions, getPartyAgeing, importParties,
} from '../services/financeService';
import { fmt, fmtFull } from '../financeUtils';
import { validateGSTIN, gstinToState } from '@/utils/gstinValidation';
import './Parties.css';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';

const INDIAN_STATES = [
  'Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat',
  'Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh',
  'Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab',
  'Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand',
  'West Bengal','Andaman and Nicobar Islands','Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu','Delhi','Jammu and Kashmir',
  'Ladakh','Lakshadweep','Puducherry',
];

const COUNTRIES = ['India','USA','UAE','UK','Singapore','Germany','Japan','Australia','Canada','Other'];

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

const CSV_TEMPLATE_HEADERS = [
  'name','type','party_code','email','phone','gstin','pan','state',
  'billing_address','city','pincode','payment_terms','credit_limit',
  'bank_name','account_number','ifsc_code',
];

const emptyForm = () => ({
  party_type:'Customer', name:'', contact_person:'', designation:'',
  email:'', phone:'', mobile:'', website:'',
  address:'', city:'', state:'', pincode:'', country:'India',
  gstin:'', pan:'', msme_number:'',
  industry:'', credit_limit:0, payment_terms:30, currency:'INR',
  bank_name:'', bank_account:'', ifsc:'',
  notes:'', is_active:true,
});

const TypeBadge = ({ type }) => {
  const map = {
    Customer:{ bg:'#dbeafe', color:'#1d4ed8' },
    Supplier:{ bg:'#dcfce7', color:'#15803d' },
    Both:    { bg:'#fef3c7', color:'#92400e' },
  };
  const s = map[type] || map.Customer;
  return <span className="pt-type-badge" style={{ background:s.bg, color:s.color }}>{type}</span>;
};

const StatusBadge = ({ status }) => {
  const map = {
    paid: { bg:'#dcfce7', color:'#15803d' },
    Paid: { bg:'#dcfce7', color:'#15803d' },
    draft: { bg:'#f1f5f9', color:'#64748b' },
    pending: { bg:'#fef3c7', color:'#92400e' },
    overdue: { bg:'#fee2e2', color:'#dc2626' },
    approved: { bg:'#dbeafe', color:'#1d4ed8' },
  };
  const s = map[status] || { bg:'#f1f5f9', color:'#64748b' };
  return <span style={{ background:s.bg, color:s.color, fontSize:11, padding:'2px 7px', borderRadius:10, fontWeight:500, textTransform:'capitalize' }}>{status}</span>;
};

export default function Parties({ setPage }) {
  const { readOnly } = usePageAccess();
  const [parties,    setParties]   = useState([]);
  const [loading,    setLoading]   = useState(false);
  const [search,     setSearch]    = useState('');
  const [typeFilter, setTypeFilter]= useState('');
  const [drawer,     setDrawer]    = useState(null); // null | 'create' | 'import'
  const [viewParty,  setViewParty] = useState(null);
  const [viewTab,    setViewTab]   = useState('overview');
  const [toast,      setToast]     = useState(null);
  const [submitting, setSubmitting]= useState(false);
  const [form,       setForm]      = useState(emptyForm());
  const [editMode,   setEditMode]  = useState(false);
  const [gstinErr,   setGstinErr]  = useState('');
  const [deactivateTarget, setDeactivateTarget] = useState(null);

  // Party detail sub-data
  const [txns,       setTxns]      = useState([]);
  const [txnLoading, setTxnLoading]= useState(false);
  const [ageing,     setAgeing]    = useState(null);
  const [ageLoading, setAgeLoading]= useState(false);

  // Import state
  const [importRows,   setImportRows]  = useState([]);
  const [importResult, setImportResult]= useState(null);
  const [importing,    setImporting]   = useState(false);
  const fileRef = useRef(null);

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = typeFilter ? { party_type: typeFilter } : {};
      const raw = await getParties(params);
      setParties(Array.isArray(raw) ? raw : []);
    } catch {
      setParties([]);
    } finally { setLoading(false); }
  }, [typeFilter]);

  useEffect(() => { load(); }, [load]);

  // Fetch transactions when switching to that tab
  useEffect(() => {
    if (viewParty && viewTab === 'transactions') {
      setTxnLoading(true);
      getPartyTransactions(viewParty.id).then(data => {
        setTxns(Array.isArray(data) ? data : []);
      }).finally(() => setTxnLoading(false));
    }
    if (viewParty && viewTab === 'outstanding') {
      setAgeLoading(true);
      getPartyAgeing(viewParty.id).then(data => {
        setAgeing(data);
      }).finally(() => setAgeLoading(false));
    }
  }, [viewParty, viewTab]);

  const filtered = parties.filter(p => {
    const q = search.toLowerCase();
    return !q ||
      (p.name||'').toLowerCase().includes(q) ||
      (p.party_code||'').toLowerCase().includes(q) ||
      (p.email||'').toLowerCase().includes(q) ||
      (p.contact_person||'').toLowerCase().includes(q) ||
      (p.gstin||'').toLowerCase().includes(q);
  });

  const customers = parties.filter(p => ['Customer','Both'].includes(p.party_type));
  const suppliers  = parties.filter(p => ['Supplier','Both'].includes(p.party_type));
  const totalAR    = customers.reduce((s,p)=>s+parseFloat(p.outstanding_balance||0),0);
  const totalAP    = suppliers.reduce((s,p)=>s+parseFloat(p.outstanding_balance||0),0);

  // ── Validation ───────────────────────────────────────────────────────────
  const handleGstinChange = (v) => {
    const val = v.toUpperCase();
    setForm(f=>({...f, gstin: val, state: val.length >= 2 ? gstinToState(val) || f.state : f.state}));
    if (val) {
      const result = validateGSTIN(val);
      setGstinErr(result.valid ? '' : result.error);
    } else {
      setGstinErr('');
    }
  };

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!form.name.trim()) { showToast('Party name is required','error'); return; }
    if (form.gstin && gstinErr) { showToast(gstinErr,'error'); return; }
    setSubmitting(true);
    try {
      if (editMode && viewParty) {
        await updateParty(viewParty.id, form);
        showToast('Party updated successfully');
      } else {
        await createParty(form);
        showToast('Party created successfully');
      }
      setDrawer(null); setEditMode(false); setForm(emptyForm()); setGstinErr('');
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Save failed','error');
    } finally { setSubmitting(false); }
  };

  const openCreate = () => { setForm(emptyForm()); setEditMode(false); setGstinErr(''); setDrawer('create'); };
  const openEdit = (party) => {
    setForm({ ...emptyForm(), ...party });
    setEditMode(true); setViewParty(party); setGstinErr(''); setDrawer('create');
  };

  const toggleStatus = async (party) => {
    if (party.is_active) { setDeactivateTarget(party); return; }
    try {
      await updateParty(party.id, { ...party, is_active: true });
    } finally {
      setParties(p => p.map(x => x.id===party.id ? {...x, is_active:true} : x));
      showToast('Party activated');
    }
  };

  const confirmDeactivate = async () => {
    const party = deactivateTarget;
    setDeactivateTarget(null);
    try {
      await updateParty(party.id, { ...party, is_active: false });
    } finally {
      setParties(p => p.map(x => x.id===party.id ? {...x, is_active:false} : x));
      showToast('Party deactivated');
    }
  };

  const openView = (party) => { setViewParty(party); setViewTab('overview'); setTxns([]); setAgeing(null); };

  const creditUtil = (party) => {
    if (!party.credit_limit || party.credit_limit === 0) return null;
    return Math.min(Math.round((party.outstanding_balance / party.credit_limit) * 100), 100);
  };

  // ── Export CSV ───────────────────────────────────────────────────────────
  const handleExport = () => {
    const rows = filtered.map(p => [
      p.party_code||'', p.name||'', p.party_type||'', p.email||'', p.phone||'',
      p.gstin||'', p.pan||'', p.state||'', p.address||'', p.city||'', p.pincode||'',
      p.payment_terms||30, p.credit_limit||0, p.bank_name||'', p.bank_account||'', p.ifsc||'',
      p.outstanding_balance||0, p.is_active ? 'Active':'Inactive',
    ]);
    const header = [
      'party_code','name','type','email','phone','gstin','pan','state',
      'billing_address','city','pincode','payment_terms','credit_limit',
      'bank_name','account_number','ifsc_code','outstanding_balance','status',
    ];
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href=url;
    const date = new Date().toISOString().split('T')[0];
    a.download = `parties-${date}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Import CSV ───────────────────────────────────────────────────────────
  const downloadTemplate = () => {
    const csv = CSV_TEMPLATE_HEADERS.join(',') + '\n' +
      '"Acme Corp","Customer","CUST-0001","accounts@acme.com","+91 98765 43210","29AABCA1234C1Z5","AABCA1234C","Karnataka","123 MG Road","Bengaluru","560001","30","100000","HDFC Bank","12345678901","HDFC0001234"\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='parties-import-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim().toLowerCase());
    return lines.slice(1).map(line => {
      const vals = line.split(',').map(v => v.replace(/^"|"$/g,'').trim());
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return obj;
    }).filter(r => r.name);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const rows = parseCSV(ev.target.result);
      setImportRows(rows);
      setImportResult(null);
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!importRows.length) return;
    setImporting(true);
    try {
      const result = await importParties(importRows);
      setImportResult(result);
      showToast(`${result.imported} parties imported`);
      load();
    } catch (err) {
      showToast(err?.response?.data?.error || 'Import failed','error');
    } finally { setImporting(false); }
  };

  // ── Ageing helpers ───────────────────────────────────────────────────────
  const AGEING_LABELS = [
    { key:'current', label:'Current' },
    { key:'1_30',    label:'1–30 days' },
    { key:'31_60',   label:'31–60 days' },
    { key:'61_90',   label:'61–90 days' },
    { key:'over_90', label:'Over 90 days' },
  ];
  const ageTotal = ageing ? Object.values(ageing).reduce((s,v)=>s+v,0) : 0;

  return (
    <div className="pt-root">
      <ConfirmDialog
        open={deactivateTarget !== null}
        title="Deactivate Party"
        message={`Deactivate "${deactivateTarget?.name}"? They will no longer appear in new transactions.`}
        confirmLabel="Deactivate"
        variant="warning"
        onConfirm={confirmDeactivate}
        onCancel={() => setDeactivateTarget(null)}
      />

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
          {!readOnly && (
            <button className="pt-btn-outline" onClick={() => { setDrawer('import'); setImportRows([]); setImportResult(null); }}>
              <Upload size={14}/> Import
            </button>
          )}
          <button className="pt-btn-outline" onClick={handleExport}>
            <Download size={14}/> Export
          </button>
          {!readOnly && (
            <button className="pt-btn-primary" onClick={openCreate}>
              <Plus size={15}/> Add Party
            </button>
          )}
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
            <Users size={48} color="#d1d5db" style={{ marginBottom: 12 }}/>
            {parties.length === 0 ? (
              <>
                <p style={{ fontWeight: 600, marginBottom: 6 }}>No customers or suppliers yet</p>
                <p style={{ color: 'var(--color-text-secondary, #6b7280)', fontSize: 13, marginBottom: 16 }}>Add your first party to start raising invoices and recording purchases.</p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  {!readOnly && <button className="pt-btn-primary" onClick={openCreate}><Plus size={14}/> Add Party</button>}
                </div>
              </>
            ) : (
              <>
                <p style={{ fontWeight: 500, marginBottom: 8 }}>No parties match your search</p>
                <button className="pt-btn-outline" onClick={() => { setSearch(''); setTypeFilter(''); }}>Clear Filters</button>
              </>
            )}
          </div>
        ) : (
          <table className="pt-table">
            <thead>
              <tr>
                <th>Code</th><th>Name</th><th>Type</th><th>Contact</th>
                <th>GSTIN</th><th>Payment Terms</th>
                <th className="pt-th-r">Outstanding</th>
                <th>Credit Limit</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((party,i) => {
                const util = creditUtil(party);
                return (
                  <tr key={party.id||i} className={`pt-tr ${!party.is_active?'pt-tr-inactive':''}`}>
                    <td><span className="pt-code">{party.party_code}</span></td>
                    <td>
                      <button className="pt-name-btn" onClick={()=>openView(party)}>
                        <div className="pt-name-avatar"
                          style={{background:party.party_type==='Customer'?'#dbeafe':party.party_type==='Supplier'?'#dcfce7':'#fef3c7',
                                  color:party.party_type==='Customer'?'#1d4ed8':party.party_type==='Supplier'?'#15803d':'#92400e'}}>
                          {party.name.charAt(0)}
                        </div>
                        <div>
                          <span className="pt-name">{party.name}</span>
                          {party.contact_person && <span className="pt-contact-sub">{party.contact_person}</span>}
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
                    <td><span className="pt-gstin">{party.gstin || '—'}</span></td>
                    <td><span className="pt-terms">{PAYMENT_TERMS.find(t=>t.value===party.payment_terms)?.label||`Net ${party.payment_terms}`}</span></td>
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
                              style={{width:`${util||0}%`,background:(util||0)>80?'#ef4444':(util||0)>60?'#f59e0b':'#10b981'}}/>
                          </div>
                          <span className="pt-credit-pct">{util||0}%</span>
                        </div>
                      ) : <span className="pt-no-limit">No limit</span>}
                    </td>
                    <td>
                      <span className={`pt-status ${party.is_active?'active':'inactive'}`}>
                        {party.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <div className="pt-actions">
                        <button className="pt-action-btn" title="View" onClick={()=>openView(party)}><Eye size={13}/></button>
                        {!readOnly && (
                          <>
                            <button className="pt-action-btn" title="Edit" onClick={()=>openEdit(party)}><Edit2 size={13}/></button>
                            <button className="pt-action-btn" title={party.is_active?'Deactivate':'Activate'} onClick={()=>toggleStatus(party)}>
                              {party.is_active ? <ToggleRight size={15} color="#10b981"/> : <ToggleLeft size={15} color="#9ca3af"/>}
                            </button>
                          </>
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

      {/* ── View Party Drawer ─────────────────────────────────────────────── */}
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
                {!readOnly && <button className="pt-btn-outline" onClick={()=>openEdit(viewParty)}><Edit2 size={13}/> Edit</button>}
                <button className="pt-icon-btn" onClick={()=>setViewParty(null)}><X size={18}/></button>
              </div>
            </div>

            {/* Financial strip */}
            <div className="pt-view-fin-strip">
              {viewParty.party_type !== 'Supplier' && (
                <>
                  <div className="pt-fin-item"><span>Total Invoiced</span><strong>{fmtFull(viewParty.total_invoiced||0)}</strong></div>
                  <div className="pt-fin-item"><span>Total Received</span><strong className="green">{fmtFull(viewParty.total_paid||0)}</strong></div>
                </>
              )}
              {viewParty.party_type !== 'Customer' && (
                <>
                  <div className="pt-fin-item"><span>Total Billed</span><strong>{fmtFull(viewParty.total_billed||0)}</strong></div>
                  <div className="pt-fin-item"><span>Total Paid Out</span><strong className="green">{fmtFull(viewParty.total_paid_out||0)}</strong></div>
                </>
              )}
              <div className="pt-fin-item pt-fin-outstanding">
                <span>Outstanding</span>
                <strong className={parseFloat(viewParty.outstanding_balance||0)>0?'amber':''}>
                  {fmtFull(viewParty.outstanding_balance||0)}
                </strong>
              </div>
              {viewParty.credit_limit > 0 && (
                <div className="pt-fin-item"><span>Credit Limit</span><strong>{fmtFull(viewParty.credit_limit)}</strong></div>
              )}
            </div>

            {/* Tabs */}
            <div className="pt-view-tabs">
              {['overview','transactions','outstanding','documents'].map(t=>(
                <button key={t} className={`pt-view-tab${viewTab===t?' active':''}`} onClick={()=>setViewTab(t)}>
                  {t.charAt(0).toUpperCase()+t.slice(1)}
                </button>
              ))}
            </div>

            <div className="pt-drawer-body">

              {/* ── OVERVIEW ─────────────────── */}
              {viewTab === 'overview' && (
                <div className="pt-view-overview">
                  <div className="pt-view-grid">
                    <div className="pt-view-section">
                      <h4>Contact Information</h4>
                      {viewParty.contact_person && <div className="pt-view-field"><Users size={13}/><div><span>Contact Person</span><strong>{viewParty.contact_person}</strong></div></div>}
                      {viewParty.email && <div className="pt-view-field"><Mail size={13}/><div><span>Email</span><strong>{viewParty.email}</strong></div></div>}
                      {viewParty.phone && <div className="pt-view-field"><Phone size={13}/><div><span>Phone</span><strong>{viewParty.phone}</strong></div></div>}
                      {viewParty.address && <div className="pt-view-field"><MapPin size={13}/><div><span>Address</span><strong>{viewParty.address}</strong></div></div>}
                    </div>
                    <div className="pt-view-section">
                      <h4>Tax & Compliance</h4>
                      <div className="pt-view-field"><Building2 size={13}/><div><span>GSTIN</span><strong className="pt-gstin-display">{viewParty.gstin||'—'}</strong></div></div>
                      <div className="pt-view-field"><FileText size={13}/><div><span>PAN</span><strong>{viewParty.pan||'—'}</strong></div></div>
                      {viewParty.msme_number && <div className="pt-view-field"><FileText size={13}/><div><span>MSME No.</span><strong>{viewParty.msme_number}</strong></div></div>}
                    </div>
                    <div className="pt-view-section">
                      <h4>Financial Terms</h4>
                      <div className="pt-view-field"><Calendar size={13}/><div><span>Payment Terms</span>
                        <strong>{PAYMENT_TERMS.find(t=>t.value===viewParty.payment_terms)?.label||`Net ${viewParty.payment_terms}`}</strong>
                      </div></div>
                      {viewParty.credit_limit > 0 && (
                        <>
                          <div className="pt-view-field"><CreditCard size={13}/><div><span>Credit Limit</span><strong>{fmtFull(viewParty.credit_limit)}</strong></div></div>
                          <div className="pt-credit-util">
                            <div className="pt-credit-util-hd"><span>Credit Utilization</span><span>{creditUtil(viewParty)||0}%</span></div>
                            <div className="pt-credit-util-bar">
                              <div style={{width:`${creditUtil(viewParty)||0}%`,background:(creditUtil(viewParty)||0)>80?'#ef4444':(creditUtil(viewParty)||0)>60?'#f59e0b':'#10b981'}}/>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                    {viewParty.bank_name && (
                      <div className="pt-view-section">
                        <h4>Bank Details</h4>
                        <div className="pt-view-field"><Building2 size={13}/><div><span>Bank</span><strong>{viewParty.bank_name}</strong></div></div>
                        {viewParty.bank_account && <div className="pt-view-field"><CreditCard size={13}/><div><span>Account #</span><strong>{viewParty.bank_account}</strong></div></div>}
                        {viewParty.ifsc && <div className="pt-view-field"><FileText size={13}/><div><span>IFSC</span><strong>{viewParty.ifsc}</strong></div></div>}
                      </div>
                    )}
                  </div>
                  <div className="pt-view-quick-actions">
                    {viewParty.party_type !== 'Supplier' && (
                      <button className="pt-quick-action" onClick={() => setPage && setPage('InvoicesNew')}>
                        <FileText size={14}/> Create Invoice
                      </button>
                    )}
                    {viewParty.party_type !== 'Customer' && (
                      <button className="pt-quick-action" onClick={() => setPage && setPage('SupplierBills')}>
                        <FileText size={14}/> Record Bill
                      </button>
                    )}
                    <button className="pt-quick-action" onClick={() => setPage && setPage('PaymentBatch')}>
                      <IndianRupee size={14}/> Record Payment
                    </button>
                    <button className="pt-quick-action" onClick={() => setViewTab('transactions')}>
                      <TrendingUp size={14}/> View Ledger
                    </button>
                  </div>
                </div>
              )}

              {/* ── TRANSACTIONS ─────────────── */}
              {viewTab === 'transactions' && (
                <div className="pt-view-transactions">
                  <div className="pt-txn-header">
                    <h4>Transaction History</h4>
                    <button className="pt-btn-sm-outline" onClick={() => {
                      const rows = [['Date','Reference','Type','Amount','Balance','Status'],
                        ...txns.map(t=>[t.txn_date?.slice(0,10)||'',t.reference||'',t.record_type||'',
                          parseFloat(t.amount||0).toFixed(2),parseFloat(t.balance||0).toFixed(2),t.status||''])];
                      const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
                      const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
                      a.download=`ledger-${viewParty?.name||'party'}-${new Date().toISOString().slice(0,10)}.csv`; a.click();
                    }}><Download size={12}/> Export Ledger</button>
                  </div>
                  {txnLoading ? (
                    <div className="pt-loading"><div className="pt-spinner"/></div>
                  ) : txns.length === 0 ? (
                    <div className="pt-empty-small"><FileText size={28} color="#d1d5db"/><p>No transactions found</p></div>
                  ) : (
                    <table className="pt-txn-table">
                      <thead>
                        <tr><th>Date</th><th>Reference</th><th>Type</th><th className="pt-th-r">Amount</th><th className="pt-th-r">Balance</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {txns.map((txn,i)=>(
                          <tr key={txn.id||i}>
                            <td className="pt-td-date">
                              {txn.txn_date ? new Date(txn.txn_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                            </td>
                            <td><span className="pt-txn-ref">{txn.reference}</span></td>
                            <td>
                              <span className={`pt-txn-type pt-txn-${txn.record_type}`}>
                                {txn.record_type === 'invoice' ? 'Invoice' : 'Bill'}
                              </span>
                            </td>
                            <td className="pt-td-r pt-dr-amt">{fmtFull(txn.amount)}</td>
                            <td className="pt-td-r pt-td-bal">{fmtFull(txn.balance)}</td>
                            <td><StatusBadge status={txn.status}/></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={4}><strong>Outstanding Balance</strong></td>
                          <td className="pt-td-r" colSpan={2}>
                            <strong className="amber">{fmtFull(viewParty.outstanding_balance||0)}</strong>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  )}
                </div>
              )}

              {/* ── OUTSTANDING / AGEING ─────── */}
              {viewTab === 'outstanding' && (
                <div className="pt-view-outstanding">
                  <h4 style={{marginBottom:16}}>Accounts Receivable Ageing</h4>
                  {ageLoading ? (
                    <div className="pt-loading"><div className="pt-spinner"/></div>
                  ) : !ageing ? (
                    <div className="pt-empty-small"><AlertCircle size={28} color="#d1d5db"/><p>Could not load ageing data</p></div>
                  ) : ageTotal === 0 ? (
                    <div className="pt-empty-small"><CheckCircle size={28} color="#10b981"/><p>No outstanding amounts</p></div>
                  ) : (
                    <div className="pt-ageing-grid">
                      {AGEING_LABELS.map(({key,label})=>{
                        const amt = ageing[key] || 0;
                        const pct = ageTotal > 0 ? Math.round((amt/ageTotal)*100) : 0;
                        const color = key==='current'?'#10b981':key==='1_30'?'#f59e0b':key==='31_60'?'#f97316':key==='61_90'?'#ef4444':'#991b1b';
                        return (
                          <div key={key} className="pt-ageing-card" style={{borderTop:`3px solid ${color}`}}>
                            <div className="pt-ageing-label">{label}</div>
                            <div className="pt-ageing-amt" style={{color}}>{fmtFull(amt)}</div>
                            <div className="pt-ageing-bar-wrap">
                              <div className="pt-ageing-bar" style={{width:`${pct}%`,background:color}}/>
                            </div>
                            <div className="pt-ageing-pct">{pct}% of total</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {ageing && ageTotal > 0 && (
                    <div className="pt-ageing-total">
                      <strong>Total Outstanding:</strong> <span className="amber">{fmtFull(ageTotal)}</span>
                    </div>
                  )}
                </div>
              )}

              {/* ── DOCUMENTS ────────────────── */}
              {viewTab === 'documents' && (
                <div className="pt-view-documents">
                  <div className="pt-empty-small">
                    <FileText size={28} color="#d1d5db"/>
                    <p>No documents uploaded yet</p>
                    <button className="pt-btn-sm-outline" onClick={() => document.getElementById('party-doc-upload')?.click()}>
                      <Upload size={12}/> Upload Document
                    </button>
                    <input id="party-doc-upload" type="file" style={{ display: 'none' }}
                      onChange={async e => {
                        const file = e.target.files[0]; if (!file) return;
                        const fd = new FormData(); fd.append('file', file);
                        try {
                          const api = (await import('@/services/api/client')).default;
                          await api.post(`/finance/parties/${viewParty.id}/documents`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
                        } catch { /* non-critical */ }
                        e.target.value = '';
                      }} />
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* ── Import Drawer ─────────────────────────────────────────────────── */}
      {drawer === 'import' && (
        <div className="pt-drawer-overlay" onClick={()=>setDrawer(null)}>
          <div className="pt-drawer" onClick={e=>e.stopPropagation()}>
            <div className="pt-drawer-hd">
              <div><h3>Import Parties</h3><p className="pt-drawer-sub">Upload a CSV file to bulk import customers & suppliers</p></div>
              <button className="pt-icon-btn" onClick={()=>setDrawer(null)}><X size={18}/></button>
            </div>
            <div className="pt-drawer-body">
              <div className="pt-import-section">
                <h4>Step 1 — Download Template</h4>
                <p className="pt-import-hint">Download the CSV template, fill in your data, then upload it below.</p>
                <button className="pt-btn-outline" onClick={downloadTemplate}>
                  <Download size={13}/> Download CSV Template
                </button>
              </div>

              <div className="pt-import-section">
                <h4>Step 2 — Upload CSV</h4>
                <div className="pt-upload-zone" onClick={()=>fileRef.current?.click()}>
                  <Upload size={24} color="#94a3b8"/>
                  <p>Click to select CSV file</p>
                  <span className="pt-upload-hint">or drag and drop</span>
                </div>
                <input ref={fileRef} type="file" accept=".csv" style={{display:'none'}} onChange={handleFileUpload}/>
              </div>

              {importRows.length > 0 && (
                <div className="pt-import-section">
                  <h4>Step 3 — Preview ({importRows.length} rows)</h4>
                  <div className="pt-preview-table-wrap">
                    <table className="pt-table" style={{fontSize:12}}>
                      <thead>
                        <tr><th>#</th><th>Name</th><th>Type</th><th>Email</th><th>GSTIN</th></tr>
                      </thead>
                      <tbody>
                        {importRows.slice(0,10).map((r,i)=>(
                          <tr key={i}>
                            <td>{i+1}</td>
                            <td>{r.name}</td>
                            <td>{r.type || r.party_type || 'Customer'}</td>
                            <td>{r.email}</td>
                            <td>{r.gstin}</td>
                          </tr>
                        ))}
                        {importRows.length > 10 && (
                          <tr><td colSpan={5} style={{textAlign:'center',color:'#64748b'}}>… and {importRows.length-10} more rows</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {importResult && (
                <div className={`pt-import-result ${importResult.errors?.length ? 'has-errors' : 'success'}`}>
                  <CheckCircle size={14} color="#10b981"/>
                  <strong>{importResult.imported} parties imported</strong>
                  {importResult.errors?.length > 0 && (
                    <div className="pt-import-errors">
                      {importResult.errors.map((e,i)=>(<div key={i} className="pt-import-error">Row {e.row} ({e.name}): {e.error}</div>))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="pt-drawer-footer">
              <button className="pt-btn-outline" onClick={()=>setDrawer(null)}>Cancel</button>
              <button className="pt-btn-primary" onClick={handleImport} disabled={!importRows.length || importing}>
                {importing ? 'Importing…' : `Import ${importRows.length} Parties`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create / Edit Drawer ─────────────────────────────────────────── */}
      {drawer === 'create' && (
        <div className="pt-drawer-overlay" onClick={()=>{setDrawer(null);setEditMode(false);}}>
          <div className="pt-drawer" onClick={e=>e.stopPropagation()}>

            <div className="pt-drawer-hd">
              <div>
                <h3>{editMode ? `Edit — ${viewParty?.name}` : 'Add New Party'}</h3>
                <p className="pt-drawer-sub">Customer, Supplier, or Both</p>
              </div>
              <button className="pt-icon-btn" onClick={()=>{setDrawer(null);setEditMode(false);}}><X size={18}/></button>
            </div>

            <div className="pt-drawer-body">

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

              <div className="pt-section-label">Basic Information</div>
              <div className="pt-form-row-3">
                <div className="pt-field pt-field-span2">
                  <label>Party Name *</label>
                  <input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Full legal name…"/>
                </div>
                <div className="pt-field">
                  <label>Industry</label>
                  <select value={form.industry} onChange={e=>setForm(f=>({...f,industry:e.target.value}))}>
                    <option value="">Select…</option>
                    {INDUSTRIES.map(i=><option key={i}>{i}</option>)}
                  </select>
                </div>
              </div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>Contact Person</label>
                  <input value={form.contact_person} onChange={e=>setForm(f=>({...f,contact_person:e.target.value}))} placeholder="Name…"/>
                </div>
                <div className="pt-field">
                  <label>Designation</label>
                  <select value={form.designation} onChange={e=>setForm(f=>({...f,designation:e.target.value}))}>
                    <option value="">-- Select Designation --</option>
                    {['CEO','CTO','CFO','COO','CMO','Director','VP','General Manager','Manager','Senior Manager','Deputy Manager','Assistant Manager','Team Lead','Senior Engineer','Engineer','Analyst','Consultant','Executive','Officer','Supervisor','Other'].map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div className="pt-field">
                  <label>Website</label>
                  <input value={form.website} onChange={e=>setForm(f=>({...f,website:e.target.value}))} placeholder="https://…"/>
                </div>
              </div>

              <div className="pt-section-label">Contact Details</div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>Email</label>
                  <input type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="email@company.com"/>
                </div>
                <div className="pt-field">
                  <label>Phone</label>
                  <input value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+91 XXXXX XXXXX"/>
                </div>
                <div className="pt-field">
                  <label>Mobile</label>
                  <input value={form.mobile} onChange={e=>setForm(f=>({...f,mobile:e.target.value}))} placeholder="+91 XXXXX XXXXX"/>
                </div>
              </div>
              <div className="pt-form-row-3">
                <div className="pt-field pt-field-span2">
                  <label>Address</label>
                  <input value={form.address} onChange={e=>setForm(f=>({...f,address:e.target.value}))} placeholder="Street address…"/>
                </div>
                <div className="pt-field">
                  <label>City</label>
                  <input value={form.city} onChange={e=>setForm(f=>({...f,city:e.target.value}))} placeholder="City…"/>
                </div>
              </div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>State</label>
                  <select value={form.state} onChange={e=>setForm(f=>({...f,state:e.target.value}))}>
                    <option value="">-- Select State --</option>
                    {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="pt-field">
                  <label>PIN Code</label>
                  <input value={form.pincode} onChange={e=>setForm(f=>({...f,pincode:e.target.value}))} placeholder="XXXXXX"/>
                </div>
                <div className="pt-field">
                  <label>Country</label>
                  <select value={form.country || 'India'} onChange={e=>setForm(f=>({...f,country:e.target.value}))}>
                    {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>

              <div className="pt-section-label">Tax & Compliance</div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>GSTIN</label>
                  <input value={form.gstin} onChange={e=>handleGstinChange(e.target.value)} placeholder="22AAAAA0000A1Z5" maxLength={15}/>
                  {gstinErr
                    ? <span className="pt-field-error">{gstinErr}</span>
                    : form.gstin && <span className="pt-field-hint" style={{color:'#10b981'}}>✓ Valid — {gstinToState(form.gstin)}</span>}
                </div>
                <div className="pt-field">
                  <label>PAN</label>
                  <input value={form.pan} onChange={e=>setForm(f=>({...f,pan:e.target.value.toUpperCase()}))} placeholder="AAAAA0000A" maxLength={10}/>
                </div>
                <div className="pt-field">
                  <label>MSME Number <span className="pt-opt">(optional)</span></label>
                  <input value={form.msme_number} onChange={e=>setForm(f=>({...f,msme_number:e.target.value}))} placeholder="UDYAM-XX-00-0000000"/>
                </div>
              </div>

              <div className="pt-section-label">Financial Terms</div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>Payment Terms</label>
                  <select value={form.payment_terms} onChange={e=>setForm(f=>({...f,payment_terms:parseInt(e.target.value)}))}>
                    {PAYMENT_TERMS.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                {form.party_type !== 'Supplier' && (
                  <div className="pt-field">
                    <label>Credit Limit (₹)</label>
                    <input type="number" min="0" value={form.credit_limit}
                      onChange={e=>setForm(f=>({...f,credit_limit:parseFloat(e.target.value)||0}))} placeholder="0 = no limit"/>
                  </div>
                )}
                <div className="pt-field">
                  <label>Currency</label>
                  <select value={form.currency} onChange={e=>setForm(f=>({...f,currency:e.target.value}))}>
                    <option value="INR">INR — Indian Rupee</option>
                    <option value="USD">USD — US Dollar</option>
                    <option value="EUR">EUR — Euro</option>
                    <option value="GBP">GBP — British Pound</option>
                  </select>
                </div>
              </div>

              <div className="pt-section-label">Bank Details <span className="pt-opt">(optional)</span></div>
              <div className="pt-form-row-3">
                <div className="pt-field">
                  <label>Bank Name</label>
                  <input value={form.bank_name} onChange={e=>setForm(f=>({...f,bank_name:e.target.value}))} placeholder="Bank name…"/>
                </div>
                <div className="pt-field">
                  <label>Account Number</label>
                  <input value={form.bank_account} onChange={e=>setForm(f=>({...f,bank_account:e.target.value}))} placeholder="Account number…"/>
                </div>
                <div className="pt-field">
                  <label>IFSC Code</label>
                  <input value={form.ifsc} onChange={e=>setForm(f=>({...f,ifsc:e.target.value.toUpperCase()}))} placeholder="BANK0001234"/>
                </div>
              </div>

              <div className="pt-form-row-2">
                <div className="pt-field">
                  <label>Internal Notes</label>
                  <textarea rows={3} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Any internal notes…"/>
                </div>
                <div className="pt-field">
                  <label>Status</label>
                  <div className="pt-toggle-wrap">
                    <button className={`pt-toggle ${form.is_active?'on':'off'}`} onClick={()=>setForm(f=>({...f,is_active:!f.is_active}))}>
                      <span className="pt-toggle-thumb"/>
                    </button>
                    <span className={form.is_active?'pt-active-lbl':'pt-inactive-lbl'}>{form.is_active ? 'Active' : 'Inactive'}</span>
                  </div>
                </div>
              </div>

            </div>

            <div className="pt-drawer-footer">
              <button className="pt-btn-outline" onClick={()=>{setDrawer(null);setEditMode(false);}}>Cancel</button>
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
