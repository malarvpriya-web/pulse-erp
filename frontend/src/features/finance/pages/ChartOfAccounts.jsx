import { useState, useEffect, useCallback } from 'react';
import {
  Plus, Search, ChevronRight, ChevronDown, Edit2, ToggleLeft,
  ToggleRight, Download, Upload, X, CheckCircle, AlertTriangle,
  FolderOpen, Folder, FileText, TrendingUp, TrendingDown,
  DollarSign, CreditCard, BarChart2, Briefcase
} from 'lucide-react';
import api from '@/services/api/client';
import './ChartOfAccounts.css';

// ── constants ───────────────────────────────────────────────────────────────
const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'];

const TYPE_META = {
  Asset:     { color:'#3b82f6', bg:'#eff6ff', icon: DollarSign,   desc:'Resources owned by the business' },
  Liability: { color:'#ef4444', bg:'#fff8f8', icon: CreditCard,   desc:'Amounts owed to others' },
  Equity:    { color:'#8b5cf6', bg:'#f5f3ff', icon: BarChart2,    desc:'Owner\'s stake in the business' },
  Revenue:   { color:'#10b981', bg:'#f0fdf4', icon: TrendingUp,   desc:'Income from business operations' },
  Expense:   { color:'#f59e0b', bg:'#fffbeb', icon: TrendingDown, desc:'Costs incurred in operations' },
};

const TYPE_CODES = {
  Asset: '1', Liability: '2', Equity: '3', Revenue: '4', Expense: '5',
};

const fmt = (n) => {
  const v = parseFloat(n||0);
  if (v >= 100000) return `₹${(v/100000).toFixed(1)}L`;
  if (v >= 1000)   return `₹${(v/1000).toFixed(0)}K`;
  return `₹${v.toFixed(0)}`;
};

// ── Tree node ────────────────────────────────────────────────────────────────
const AccountRow = ({ account, level, onToggle, expanded, onEdit, onStatusToggle }) => {
  const hasChildren = account.children && account.children.length > 0;
  const meta = TYPE_META[account.account_type] || TYPE_META.Asset;
  const indent = level * 24;

  return (
    <>
      <tr className={`coa-tr coa-level-${level} ${!account.is_active ? 'coa-tr-inactive' : ''}`}>
        <td style={{ paddingLeft: `${16 + indent}px` }}>
          <div className="coa-name-cell">
            {hasChildren ? (
              <button className="coa-expand-btn" onClick={() => onToggle(account.id)}>
                {expanded[account.id]
                  ? <ChevronDown size={14}/>
                  : <ChevronRight size={14}/>}
              </button>
            ) : (
              <span className="coa-expand-placeholder"/>
            )}
            <span className="coa-node-icon">
              {hasChildren
                ? (expanded[account.id] ? <FolderOpen size={14} color={meta.color}/> : <Folder size={14} color={meta.color}/>)
                : <FileText size={13} color={meta.color}/>}
            </span>
            <span className={`coa-acc-name ${level === 0 ? 'coa-acc-name-bold' : ''}`}>
              {account.name}
            </span>
          </div>
        </td>
        <td>
          <span className="coa-code">{account.code}</span>
        </td>
        <td>
          <span className="coa-type-badge"
            style={{ background: meta.bg, color: meta.color }}>
            {account.account_type}
          </span>
        </td>
        <td className="coa-td-desc">{account.description || '—'}</td>
        <td className="coa-td-bal">
          {account.balance !== undefined && account.balance !== null
            ? <span className={parseFloat(account.balance) >= 0 ? 'coa-bal-pos' : 'coa-bal-neg'}>
                {fmt(Math.abs(account.balance))}
              </span>
            : <span className="coa-bal-na">—</span>}
        </td>
        <td>
          <span className={`coa-status ${account.is_active ? 'active' : 'inactive'}`}>
            {account.is_active ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td>
          <div className="coa-actions">
            <button className="coa-action-btn" title="Edit" onClick={() => onEdit(account)}>
              <Edit2 size={13}/>
            </button>
            <button className="coa-action-btn" title={account.is_active ? 'Deactivate' : 'Activate'}
              onClick={() => onStatusToggle(account)}>
              {account.is_active
                ? <ToggleRight size={15} color="#10b981"/>
                : <ToggleLeft  size={15} color="#9ca3af"/>}
            </button>
          </div>
        </td>
      </tr>
      {hasChildren && expanded[account.id] && account.children.map(child => (
        <AccountRow key={child.id} account={child} level={level + 1}
          onToggle={onToggle} expanded={expanded}
          onEdit={onEdit} onStatusToggle={onStatusToggle}/>
      ))}
    </>
  );
};

// ── Main component ───────────────────────────────────────────────────────────
export default function ChartOfAccounts() {
  const [accounts,   setAccounts]   = useState([]);
  const [flat,       setFlat]       = useState([]); // flat list for selects
  const [loading,    setLoading]    = useState(true);
  const [expanded,   setExpanded]   = useState({});
  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [drawer,     setDrawer]     = useState(null); // null | 'create' | account
  const [toast,      setToast]      = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab,  setActiveTab]  = useState('tree'); // tree | list

  const [form, setForm] = useState({
    code: '', name: '', account_type: 'Asset',
    parent_id: '', description: '', is_active: true,
  });

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tree, flatRes] = await Promise.allSettled([
        api.get('/finance/accounts/tree'),
        api.get('/finance/accounts'),
      ]);
      const treeData = tree.status === 'fulfilled' ? (tree.value.data || []) : [];
      const flatData = flatRes.status === 'fulfilled' ? (flatRes.value.data || []) : [];
      setAccounts(treeData);
      setFlat(flatData);
      // Auto-expand top level
      const exp = {};
      treeData.forEach(a => { exp[a.id] = true; });
      setExpanded(exp);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleExpand = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));

  const expandAll   = () => {
    const exp = {};
    const walk = (nodes) => nodes.forEach(n => { exp[n.id] = true; if (n.children) walk(n.children); });
    walk(accounts);
    setExpanded(exp);
  };
  const collapseAll = () => setExpanded({});

  // ── Filter logic (for flat/search view) ─────────────────────────────────
  const filteredFlat = flat.filter(a => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      a.name.toLowerCase().includes(q) ||
      a.code.toLowerCase().includes(q) ||
      (a.description||'').toLowerCase().includes(q);
    const matchType = !typeFilter || a.account_type === typeFilter;
    return matchSearch && matchType;
  });

  // ── Filter tree for search ───────────────────────────────────────────────
  const filterTree = (nodes, q, type) => {
    if (!q && !type) return nodes;
    const result = [];
    nodes.forEach(node => {
      const matchSelf = (!q || node.name.toLowerCase().includes(q) || node.code.toLowerCase().includes(q))
                     && (!type || node.account_type === type);
      const filteredChildren = node.children ? filterTree(node.children, q, type) : [];
      if (matchSelf || filteredChildren.length > 0) {
        result.push({ ...node, children: filteredChildren });
      }
    });
    return result;
  };

  const displayTree = filterTree(accounts, search.toLowerCase(), typeFilter);

  // ── Stats ────────────────────────────────────────────────────────────────
  const stats = ACCOUNT_TYPES.reduce((acc, type) => {
    acc[type] = flat.filter(a => a.account_type === type).length;
    return acc;
  }, {});
  const totalActive   = flat.filter(a => a.is_active).length;
  const totalInactive = flat.filter(a => !a.is_active).length;

  // ── Auto-suggest code ─────────────────────────────────────────────────────
  const suggestCode = (type) => {
    const prefix = TYPE_CODES[type] || '9';
    const existing = flat
      .filter(a => a.code.startsWith(prefix))
      .map(a => parseInt(a.code))
      .filter(n => !isNaN(n))
      .sort((a,b)=>b-a);
    if (existing.length === 0) return `${prefix}000`;
    const last = existing[0];
    return String(last + 10).padStart(4, '0');
  };

  const handleTypeChange = (type) => {
    setForm(f => ({ ...f, account_type: type, code: suggestCode(type) }));
  };

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!form.code) { showToast('Account code is required', 'error'); return; }
    if (!form.name) { showToast('Account name is required', 'error'); return; }
    setSubmitting(true);
    try {
      if (drawer?.id) {
        await api.put(`/finance/accounts/${drawer.id}`, form);
        showToast('Account updated successfully');
      } else {
        await api.post('/finance/accounts', form);
        showToast('Account created successfully');
      }
      setDrawer(null);
      setForm({ code:'', name:'', account_type:'Asset', parent_id:'', description:'', is_active:true });
      load();
    } catch(e) {
      showToast('Error: ' + (e.response?.data?.error || e.message), 'error');
    } finally { setSubmitting(false); }
  };

  const openEdit = (account) => {
    setForm({
      code: account.code, name: account.name,
      account_type: account.account_type,
      parent_id: account.parent_id || '',
      description: account.description || '',
      is_active: account.is_active,
    });
    setDrawer(account);
  };

  const handleStatusToggle = async (account) => {
    try {
      await api.put(`/finance/accounts/${account.id}`, { ...account, is_active: !account.is_active });
      showToast(`Account ${account.is_active ? 'deactivated' : 'activated'}`);
      load();
    } catch(e) { showToast('Failed to update status', 'error'); }
  };

  const openCreate = () => {
    setForm({ code: suggestCode('Asset'), name:'', account_type:'Asset', parent_id:'', description:'', is_active:true });
    setDrawer('create');
  };

  return (
    <div className="coa-root">

      {/* Toast */}
      {toast && (
        <div className={`coa-toast coa-toast-${toast.type}`}>
          {toast.type==='success' ? <CheckCircle size={14}/> : <AlertTriangle size={14}/>}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="coa-header">
        <div>
          <h2 className="coa-title">Chart of Accounts</h2>
          <p className="coa-sub">{flat.length} accounts · {totalActive} active · {totalInactive} inactive</p>
        </div>
        <div className="coa-header-r">
          <button className="coa-btn-outline"><Upload size={14}/> Import</button>
          <button className="coa-btn-outline"><Download size={14}/> Export</button>
          <button className="coa-btn-primary" onClick={openCreate}>
            <Plus size={15}/> Add Account
          </button>
        </div>
      </div>

      {/* Type summary cards */}
      <div className="coa-type-cards">
        {ACCOUNT_TYPES.map(type => {
          const meta = TYPE_META[type];
          const Icon = meta.icon;
          return (
            <div key={type} className="coa-type-card"
              style={{ borderTopColor: meta.color, cursor:'pointer' }}
              onClick={() => setTypeFilter(typeFilter === type ? '' : type)}>
              <div className="coa-type-card-icon" style={{ background: meta.bg, color: meta.color }}>
                <Icon size={16}/>
              </div>
              <div className="coa-type-card-body">
                <span className="coa-type-card-label">{type}</span>
                <span className="coa-type-card-count">{stats[type] || 0}</span>
                <span className="coa-type-card-desc">{meta.desc}</span>
              </div>
              {typeFilter === type && (
                <span className="coa-type-card-active">●</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Toolbar */}
      <div className="coa-toolbar">
        <div className="coa-search">
          <Search size={14}/>
          <input placeholder="Search account name, code…"
            value={search} onChange={e => setSearch(e.target.value)}/>
          {search && <button className="coa-clear" onClick={() => setSearch('')}><X size={12}/></button>}
        </div>
        <div className="coa-toolbar-r">
          <div className="coa-view-tabs">
            <button className={`coa-view-tab${activeTab==='tree'?' active':''}`}
              onClick={() => setActiveTab('tree')}>🌲 Tree View</button>
            <button className={`coa-view-tab${activeTab==='list'?' active':''}`}
              onClick={() => setActiveTab('list')}>≡ List View</button>
          </div>
  <>
    <button className="coa-btn-sm" onClick={expandAll}>Expand All</button>
    <button className="coa-btn-sm" onClick={collapseAll}>Collapse All</button>
  </>

        </div>
      </div>

      {/* Table */}
      <div className="coa-table-wrap">
        {loading ? (
          <div className="coa-loading"><div className="coa-spinner"/><p>Loading accounts…</p></div>
        ) : (
          <table className="coa-table">
            <thead>
              <tr>
                <th style={{width:'32%'}}>Account Name</th>
                <th style={{width:'10%'}}>Code</th>
                <th style={{width:'12%'}}>Type</th>
                <th style={{width:'24%'}}>Description</th>
                <th style={{width:'10%'}}>Balance</th>
                <th style={{width:'7%'}}>Status</th>
                <th style={{width:'5%'}}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeTab === 'tree' ? (
                displayTree.length === 0 ? (
                  <tr><td colSpan={7} className="coa-empty-cell">No accounts found</td></tr>
                ) : (
                  displayTree.map(account => (
                    <AccountRow key={account.id} account={account} level={0}
                      onToggle={toggleExpand} expanded={expanded}
                      onEdit={openEdit} onStatusToggle={handleStatusToggle}/>
                  ))
                )
              ) : (
                filteredFlat.length === 0 ? (
                  <tr><td colSpan={7} className="coa-empty-cell">No accounts found</td></tr>
                ) : (
                  filteredFlat.map(account => {
                    const meta = TYPE_META[account.account_type] || TYPE_META.Asset;
                    return (
                      <tr key={account.id} className={`coa-tr ${!account.is_active ? 'coa-tr-inactive' : ''}`}>
                        <td>
                          <div className="coa-name-cell">
                            <FileText size={13} color={meta.color}/>
                            <span className="coa-acc-name">{account.name}</span>
                          </div>
                        </td>
                        <td><span className="coa-code">{account.code}</span></td>
                        <td>
                          <span className="coa-type-badge" style={{ background: meta.bg, color: meta.color }}>
                            {account.account_type}
                          </span>
                        </td>
                        <td className="coa-td-desc">{account.description || '—'}</td>
                        <td className="coa-td-bal">
                          {account.balance !== undefined && account.balance !== null
                            ? <span className={parseFloat(account.balance) >= 0 ? 'coa-bal-pos' : 'coa-bal-neg'}>
                                {fmt(Math.abs(account.balance))}
                              </span>
                            : <span className="coa-bal-na">—</span>}
                        </td>
                        <td>
                          <span className={`coa-status ${account.is_active ? 'active' : 'inactive'}`}>
                            {account.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td>
                          <div className="coa-actions">
                            <button className="coa-action-btn" onClick={() => openEdit(account)}><Edit2 size={13}/></button>
                            <button className="coa-action-btn" onClick={() => handleStatusToggle(account)}>
                              {account.is_active
                                ? <ToggleRight size={15} color="#10b981"/>
                                : <ToggleLeft  size={15} color="#9ca3af"/>}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Legend */}
      <div className="coa-legend">
        <span className="coa-legend-item">
          <FolderOpen size={12} color="#6366f1"/> Parent account
        </span>
        <span className="coa-legend-item">
          <FileText size={12} color="#9ca3af"/> Sub-account
        </span>
        <span className="coa-legend-item">
          <span className="coa-legend-dot" style={{background:'#10b981'}}/>Active
        </span>
        <span className="coa-legend-item">
          <span className="coa-legend-dot" style={{background:'#d1d5db'}}/>Inactive
        </span>
      </div>

      {/* ── Create / Edit Drawer ──────────────────────────────────── */}
      {drawer && (
        <div className="coa-overlay" onClick={() => setDrawer(null)}>
          <div className="coa-drawer" onClick={e => e.stopPropagation()}>

            <div className="coa-drawer-hd">
              <h3>{drawer === 'create' ? 'Add New Account' : `Edit — ${drawer.name}`}</h3>
              <button className="coa-drawer-close" onClick={() => setDrawer(null)}><X size={18}/></button>
            </div>

            <div className="coa-drawer-body">

              {/* Account Type selector */}
              <div className="coa-field">
                <label>Account Type *</label>
                <div className="coa-type-btns">
                  {ACCOUNT_TYPES.map(type => {
                    const meta = TYPE_META[type];
                    return (
                      <button key={type}
                        className={`coa-type-btn${form.account_type === type ? ' active' : ''}`}
                        style={form.account_type === type
                          ? { background: meta.color, color: '#fff', borderColor: meta.color }
                          : { borderColor: meta.color, color: meta.color }}
                        onClick={() => handleTypeChange(type)}>
                        {type}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Code & Name */}
              <div className="coa-form-row">
                <div className="coa-field">
                  <label>Account Code *</label>
                  <input value={form.code}
                    onChange={e => setForm(f => ({...f, code: e.target.value}))}
                    placeholder="e.g. 1010"/>
                  <span className="coa-field-hint">
                    Suggested: {suggestCode(form.account_type)} for {form.account_type}s
                  </span>
                </div>
                <div className="coa-field">
                  <label>Account Name *</label>
                  <input value={form.name}
                    onChange={e => setForm(f => ({...f, name: e.target.value}))}
                    placeholder="e.g. Cash and Bank"/>
                </div>
              </div>

              {/* Parent */}
              <div className="coa-field">
                <label>Parent Account</label>
                <select value={form.parent_id}
                  onChange={e => setForm(f => ({...f, parent_id: e.target.value}))}>
                  <option value="">— None (Top Level Account) —</option>
                  {flat
                    .filter(a => a.account_type === form.account_type && a.id !== drawer?.id)
                    .map(a => (
                      <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                    ))}
                </select>
                <span className="coa-field-hint">Only showing {form.account_type} accounts</span>
              </div>

              {/* Description */}
              <div className="coa-field">
                <label>Description</label>
                <textarea rows={3} value={form.description}
                  onChange={e => setForm(f => ({...f, description: e.target.value}))}
                  placeholder="Brief description of this account's purpose…"/>
              </div>

              {/* GST / Tax settings */}
              {(form.account_type === 'Revenue' || form.account_type === 'Expense') && (
                <div className="coa-field">
                  <label>GST Treatment</label>
                  <select>
                    <option>Taxable — Standard Rate</option>
                    <option>Taxable — Reduced Rate</option>
                    <option>Tax Exempt</option>
                    <option>Out of Scope</option>
                  </select>
                </div>
              )}

              {/* Reference codes */}
              <div className="coa-form-row">
                <div className="coa-field">
                  <label>Bank Account # <span className="coa-opt">(optional)</span></label>
                  <input placeholder="For bank accounts only"
                    value={form.bank_account_number || ''}
                    onChange={e => setForm(f => ({...f, bank_account_number: e.target.value}))}/>
                </div>
                <div className="coa-field">
                  <label>Opening Balance <span className="coa-opt">(₹)</span></label>
                  <input type="number" placeholder="0.00"
                    value={form.opening_balance || ''}
                    onChange={e => setForm(f => ({...f, opening_balance: e.target.value}))}/>
                </div>
              </div>

              {/* Active toggle */}
              <div className="coa-field-row">
                <label>Account Status</label>
                <div className="coa-toggle-wrap">
                  <button className={`coa-toggle ${form.is_active ? 'on' : 'off'}`}
                    onClick={() => setForm(f => ({...f, is_active: !f.is_active}))}>
                    <span className="coa-toggle-thumb"/>
                  </button>
                  <span className={form.is_active ? 'coa-active-lbl' : 'coa-inactive-lbl'}>
                    {form.is_active ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>

              {/* Info box */}
              <div className="coa-info-box" style={{ borderColor: TYPE_META[form.account_type]?.color }}>
                <div className="coa-info-type" style={{ color: TYPE_META[form.account_type]?.color }}>
                  {form.account_type} Account
                </div>
                <p className="coa-info-desc">{TYPE_META[form.account_type]?.desc}</p>
                <div className="coa-info-row">
                  <span>Normal Balance:</span>
                  <strong>{['Asset','Expense'].includes(form.account_type) ? 'Debit' : 'Credit'}</strong>
                </div>
                <div className="coa-info-row">
                  <span>Financial Statement:</span>
                  <strong>
                    {form.account_type === 'Asset'     ? 'Balance Sheet' :
                     form.account_type === 'Liability' ? 'Balance Sheet' :
                     form.account_type === 'Equity'    ? 'Balance Sheet' :
                     'Income Statement (P&L)'}
                  </strong>
                </div>
                <div className="coa-info-row">
                  <span>Code Range:</span>
                  <strong>{TYPE_CODES[form.account_type]}000 – {TYPE_CODES[form.account_type]}999</strong>
                </div>
              </div>

              {/* Footer */}
              <div className="coa-drawer-footer">
                <button className="coa-btn-outline" onClick={() => setDrawer(null)}>Cancel</button>
                <button className="coa-btn-primary" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? 'Saving…' : drawer === 'create' ? 'Create Account' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}