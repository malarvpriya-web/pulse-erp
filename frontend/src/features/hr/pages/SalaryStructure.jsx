// frontend/src/features/hr/pages/SalaryStructure.jsx
import { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';

/* ─── helpers ─────────────────────────────────────────────────── */
function fmtINR(n) {
  const v = Math.abs(parseFloat(n) || 0);
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000)   return `₹${(v / 100000).toFixed(2)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

// EMI = P × r × (1+r)^n / ((1+r)^n − 1); interest-free: P / n
function calcEMI(principal, annualRate, tenureMonths) {
  const P = parseFloat(principal) || 0;
  const n = parseInt(tenureMonths) || 0;
  const r = (parseFloat(annualRate) || 0) / 12 / 100;
  if (!P || !n) return 0;
  if (r === 0) return Math.round(P / n);
  return Math.round(P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
}

/* ─── default components ───────────────────────────────────────── */
const DEFAULT_COMPONENTS = [
  { name:'Basic',             type:'earning',   calculation_type:'percentage_of_ctc',   value:'40',   is_taxable:true,  is_pf_applicable:true  },
  { name:'HRA',               type:'earning',   calculation_type:'percentage_of_basic', value:'40',   is_taxable:false, is_pf_applicable:false },
  { name:'Conveyance',        type:'earning',   calculation_type:'fixed',               value:'1600', is_taxable:false, is_pf_applicable:false },
  { name:'Medical Allowance', type:'earning',   calculation_type:'fixed',               value:'1250', is_taxable:false, is_pf_applicable:false },
  { name:'Special Allowance', type:'earning',   calculation_type:'balancing',           value:'0',    is_taxable:true,  is_pf_applicable:false },
  { name:'Employee PF',       type:'statutory', calculation_type:'percentage_of_basic', value:'12',   is_taxable:false, is_pf_applicable:true  },
  { name:'Professional Tax',  type:'statutory', calculation_type:'fixed',               value:'200',  is_taxable:false, is_pf_applicable:false },
];

/* ─── preview computation ──────────────────────────────────────── */
function computePreview(components, ctc) {
  let gross = 0;
  let basicAmount = 0; // tracks computed Basic so percentage_of_basic uses the right base
  const lines = [];
  for (const c of components) {
    let amount = 0;
    if (c.calculation_type === 'fixed')
      amount = parseFloat(c.value) || 0;
    else if (c.calculation_type === 'percentage_of_ctc')
      amount = Math.round(ctc * (parseFloat(c.value) || 0) / 100);
    else if (c.calculation_type === 'percentage_of_basic') {
      // EPF statutory wage ceiling ₹15,000: cap the PF base for PF-type deductions
      const pfBase = (c.type === 'statutory' && c.is_pf_applicable)
        ? Math.min(basicAmount, 15000) : basicAmount;
      amount = Math.round(pfBase * (parseFloat(c.value) || 0) / 100);
    }
    else if (c.calculation_type === 'percentage_of_gross')
      amount = Math.round(gross * (parseFloat(c.value) || 0) / 100);
    // 'balancing' is resolved in a second pass below

    if (c.type === 'earning' && c.calculation_type !== 'balancing') gross += amount;
    if (c.name === 'Basic') basicAmount = amount; // capture for downstream % calculations
    lines.push({ ...c, computed_amount: amount });
  }
  // Second pass: balancing components (e.g. Special Allowance = CTC − other earnings)
  for (const l of lines) {
    if (l.calculation_type === 'balancing' && l.type === 'earning') {
      l.computed_amount = Math.max(0, ctc - gross);
      gross += l.computed_amount;
    }
  }
  const deductions = lines.filter(l => l.type !== 'earning').reduce((s, l) => s + l.computed_amount, 0);
  return { lines, gross, deductions, net: gross - deductions };
}

/* ─── arrears computation ──────────────────────────────────────── */
function computeArrears(oldBasic, newBasic, fromDate, toDate) {
  const P = parseFloat(oldBasic) || 0;
  const N = parseFloat(newBasic) || 0;
  if (!P || !N || !fromDate || !toDate) return [];
  const from = new Date(fromDate);
  const to   = new Date(toDate);
  if (from > to) return [];
  const diff = N - P;
  const rows = [];
  const cur  = new Date(from.getFullYear(), from.getMonth(), 1);
  while (cur <= to) {
    rows.push({
      month:     cur.toLocaleString('default', { month: 'long', year: 'numeric' }),
      old_basic: P,
      new_basic: N,
      arrears:   diff,
    });
    cur.setMonth(cur.getMonth() + 1);
  }
  return rows;
}

/* ─── shared styles ─────────────────────────────────────────────── */
const tabStyle = (active) => ({
  padding: '8px 20px', border: 'none', cursor: 'pointer', borderRadius: '6px 6px 0 0',
  fontWeight: 600, fontSize: 14,
  background: active ? '#6B3FDB' : '#e9e4ff',
  color:      active ? '#fff'    : '#6B3FDB',
});
const inp = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 };
const lbl = { fontSize: 12, fontWeight: 600, color: '#4c1d95', display: 'block', marginBottom: 4 };

/* ─── component ─────────────────────────────────────────────────── */
export default function SalaryStructure() {
  const [tab, setTab]               = useState('structures');
  const [structures, setStructures] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [loans, setLoans]           = useState([]);
  const [loading, setLoading]       = useState(false);
  const [msg, setMsg]               = useState({ text:'', type:'' });

  // structure form
  const [showForm, setShowForm]     = useState(false);
  const [editId, setEditId]         = useState(null);
  const [formName, setFormName]     = useState('');
  const [formDesc, setFormDesc]     = useState('');
  const [formDefault, setFormDefault] = useState(false);
  const [formMetro, setFormMetro]   = useState(false);
  const [components, setComponents] = useState(DEFAULT_COMPONENTS);
  const [previewBasic, setPreviewBasic] = useState(50000);

  // assign modal
  const [assignModal, setAssignModal] = useState(null);
  const [assignForm, setAssignForm]   = useState({ structure_id:'', basic_salary:'', effective_from:'' });

  // bulk assign modal
  const [bulkModal, setBulkModal]   = useState(false);
  const [bulkForm, setBulkForm]     = useState({ structure_id:'', effective_from:new Date().toISOString().split('T')[0] });
  const [bulkLoading, setBulkLoading] = useState(false);

  // search / filter
  const [assignSearch, setAssignSearch] = useState('');
  const [loanSearch,   setLoanSearch]   = useState('');

  // revision history modal
  const [historyModal, setHistoryModal]       = useState(null);
  const [revisionHistory, setRevisionHistory] = useState([]);
  const [historyLoading, setHistoryLoading]   = useState(false);

  // arrears calculator
  const [showArrears, setShowArrears] = useState(false);
  const [arrearsForm, setArrearsForm] = useState({ employee_id:'', old_basic:'', new_basic:'', from_date:'', to_date:'' });
  const [arrearsRows, setArrearsRows] = useState([]);

  // loan form + EMI calculator
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [loanForm, setLoanForm]         = useState({ employee_id:'', loan_type:'loan', principal_amount:'', emi_amount:'', start_date:'', reason:'' });
  const [loanCalc, setLoanCalc]         = useState({ interest_rate:'', tenure:'' });

  const flash = (text, type = 'success') => {
    setMsg({ text, type });
    setTimeout(() => setMsg({ text:'', type:'' }), 3500);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const [sRes, aRes, lRes] = await Promise.allSettled([
      api.get('/salary-structures'),
      api.get('/salary-structures/assignments'),
      api.get('/payroll/loan-advances'),
    ]);
    if (sRes.status === 'fulfilled') setStructures(Array.isArray(sRes.value.data) ? sRes.value.data : []);
    if (aRes.status === 'fulfilled') {
      const rows = Array.isArray(aRes.value.data) ? aRes.value.data : [];
      setAssignments(rows.map(a => {
        const basic = parseFloat(a.basic_salary) || 0;
        const grossComputed = parseFloat(a.gross_salary) || parseFloat(a.gross) || (basic * 1.4167);
        return {
          id:             a.id,
          employee_id:    a.employee_id,
          employee_name:  a.employee_name || `Employee #${a.employee_id}`,
          employee_code:  a.employee_code || '',
          department:     a.department || '',
          structure_name: a.structure_name || '—',
          basic_salary:   basic,
          gross:          grossComputed,
          effective_from: a.effective_from ? a.effective_from.split('T')[0] : '—',
        };
      }));
    }
    if (lRes.status === 'fulfilled') setLoans(Array.isArray(lRes.value.data) ? lRes.value.data : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Sync structure_id defaults to first loaded structure
  useEffect(() => {
    if (!structures.length) return;
    const firstId = String(structures[0].id);
    setAssignForm(f => f.structure_id ? f : { ...f, structure_id: firstId });
    setBulkForm(f => f.structure_id ? f : { ...f, structure_id: firstId });
  }, [structures]);

  const addComponent    = () => setComponents(c => [...c, { name:'', type:'earning', calculation_type:'fixed', value:'0', is_taxable:true, is_pf_applicable:false }]);
  const removeComponent = (i) => setComponents(c => c.filter((_, j) => j !== i));
  const updateComponent = (i, field, value) => setComponents(c => c.map((r, j) => j === i ? { ...r, [field]: value } : r));

  const toggleMetro = (isMetro) => {
    setFormMetro(isMetro);
    setComponents(prev => prev.map(c =>
      c.name === 'HRA' && c.calculation_type === 'percentage_of_basic'
        ? { ...c, value: isMetro ? '50' : '40' }
        : c
    ));
  };

  const openHistory = async (emp) => {
    setHistoryModal(emp);
    setRevisionHistory([]);
    setHistoryLoading(true);
    try {
      const r = await api.get(`/employees/${emp.employee_id}/salary-revisions`);
      setRevisionHistory(r.data || []);
    } catch {
      setRevisionHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const computedEMI = calcEMI(loanForm.principal_amount, loanCalc.interest_rate, loanCalc.tenure);

  const resetForm = () => {
    setShowForm(false); setEditId(null); setFormName(''); setFormDesc('');
    setFormDefault(false); setFormMetro(false); setComponents(DEFAULT_COMPONENTS); setPreviewBasic(50000);
  };

  const saveStructure = async (e) => {
    e.preventDefault();
    if (!formName.trim()) return flash('Structure name is required', 'error');
    setLoading(true);
    try {
      if (editId) await api.put(`/salary-structures/${editId}`, { name: formName, description: formDesc, is_default: formDefault, components });
      else        await api.post('/salary-structures', { name: formName, description: formDesc, is_default: formDefault, components });
      flash(editId ? 'Structure updated' : 'Structure created');
      resetForm(); load();
    } catch (err) { flash(err.response?.data?.message || 'Save failed', 'error'); setLoading(false); }
  };

  const saveAssign = async (e) => {
    e.preventDefault();
    if (!assignForm.structure_id) return flash('Select a structure', 'error');
    setLoading(true);
    try {
      await api.post(`/salary-structures/${assignForm.structure_id}/assign`, {
        employee_id:    assignModal.employee_id,
        basic_salary:   assignForm.basic_salary,
        effective_from: assignForm.effective_from,
      });
      flash(`Structure assigned to ${assignModal.employee_name}`);
      setAssignModal(null); load();
    } catch (err) { flash(err.response?.data?.message || 'Assignment failed', 'error'); setLoading(false); }
  };

  const saveBulkAssign = async (e) => {
    e.preventDefault();
    if (!bulkForm.structure_id) return flash('Select a structure', 'error');
    setBulkLoading(true);
    try {
      await Promise.all(
        filteredAssignments.map(a =>
          api.post(`/salary-structures/${bulkForm.structure_id}/assign`, {
            employee_id:    a.employee_id,
            basic_salary:   a.basic_salary,
            effective_from: bulkForm.effective_from,
          })
        )
      );
      flash(`Bulk assigned ${filteredAssignments.length} employees`);
      setBulkModal(false); load();
    } catch (err) { flash(err.response?.data?.message || 'Bulk assign failed', 'error'); }
    finally { setBulkLoading(false); }
  };

  const saveLoan = async (e) => {
    e.preventDefault();
    const emiToUse = loanForm.emi_amount || (computedEMI > 0 ? String(computedEMI) : '');
    setLoading(true);
    try {
      await api.post('/payroll/loan-advances', { ...loanForm, emi_amount: emiToUse });
      flash('Loan / Advance created');
      setShowLoanForm(false);
      setLoanForm({ employee_id:'', loan_type:'loan', principal_amount:'', emi_amount:'', start_date:'', reason:'' });
      setLoanCalc({ interest_rate:'', tenure:'' });
      load();
    } catch (err) { flash(err.response?.data?.message || 'Failed', 'error'); setLoading(false); }
  };

  const closeLoan = async (id) => {
    try {
      await api.post(`/payroll/loan-advances/${id}/close`);
      flash('Loan marked as closed');
      load();
    } catch { flash('Could not close loan', 'error'); }
  };

  const preview = computePreview(components, previewBasic);
  const CALC_TYPES = [
    { v:'fixed',               l:'Fixed Amount'          },
    { v:'percentage_of_ctc',   l:'% of CTC'             },
    { v:'percentage_of_basic', l:'% of Basic'           },
    { v:'percentage_of_gross', l:'% of Gross'           },
    { v:'balancing',           l:'Balancing (CTC − rest)' },
  ];
  const COMP_TYPES = [{ v:'earning', l:'Earning' }, { v:'deduction', l:'Deduction' }, { v:'statutory', l:'Statutory' }];

  const filteredAssignments = assignments.filter(a =>
    !assignSearch || [a.employee_name, a.employee_code, a.structure_name, a.department]
      .some(v => (v||'').toLowerCase().includes(assignSearch.toLowerCase()))
  );

  const filteredLoans = loans.filter(l =>
    !loanSearch || [l.employee_name, l.loan_type, l.employee_id]
      .some(v => String(v||'').toLowerCase().includes(loanSearch.toLowerCase()))
  );

  return (
    <div style={{ padding: 24, background: '#f5f3ff', minHeight: '100vh' }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: '#4c1d95', fontSize: 22 }}>Salary Structure Manager</h2>
        <p style={{ margin: 0, color: '#6b7280', fontSize: 13 }}>Define pay components, assign structures, manage loans &amp; advances</p>
      </div>

      {msg.text && (
        <div style={{ marginBottom: 12, padding: '10px 16px', borderRadius: 8, fontWeight: 500, fontSize: 14,
          background: msg.type === 'error' ? '#fef2f2' : '#f0fdf4',
          color:      msg.type === 'error' ? '#dc2626'  : '#16a34a',
          border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
          {msg.text}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e9e4ff', flexWrap: 'wrap' }}>
        <button style={tabStyle(tab==='structures')}  onClick={() => setTab('structures')}>Structures ({structures.length})</button>
        <button style={tabStyle(tab==='assignments')} onClick={() => setTab('assignments')}>Employee Assignments ({assignments.length})</button>
        <button style={tabStyle(tab==='loans')}       onClick={() => setTab('loans')}>Loans &amp; Advances ({loans.length})</button>
      </div>

      <div style={{ background: '#fff', border: '1px solid #e9e4ff', borderTop: 'none', borderRadius: '0 8px 8px 8px', padding: 20 }}>

        {/* ── STRUCTURES TAB ── */}
        {tab === 'structures' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <button onClick={() => showForm ? resetForm() : setShowForm(true)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontWeight: 600 }}>
                {showForm ? '✕ Cancel' : '+ Create Structure'}
              </button>
            </div>

            {/* structure list */}
            {!showForm && (
              structures.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: '#9ca3af' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>📄</div>
                  <p style={{ margin: '0 0 16px', fontSize: 14 }}>No salary structures defined yet.</p>
                  <button onClick={() => setShowForm(true)}
                    style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                    Create First Structure
                  </button>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 14 }}>
                  {structures.map(s => (
                    <div key={s.id} style={{ background: '#f5f3ff', border: '1px solid #e9e4ff', borderRadius: 12, padding: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontWeight: 700, color: '#1f2937' }}>{s.name}</div>
                          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{s.description}</div>
                        </div>
                        {s.is_default && <span style={{ fontSize: 10, fontWeight: 700, background: '#6B3FDB', color: '#fff', padding: '2px 8px', borderRadius: 10 }}>Default</span>}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 13 }}>
                        <span style={{ color: '#6b7280' }}>{s.component_count} components</span>
                        <button onClick={async () => {
                          try {
                            const r  = await api.get(`/salary-structures/${s.id}`);
                            const st = r.data;
                            setFormName(st.name); setFormDesc(st.description || '');
                            setFormDefault(st.is_default); setComponents(st.components || []);
                            setEditId(s.id); setShowForm(true);
                            const hra = (st.components || []).find(c => c.name === 'HRA');
                            setFormMetro(hra ? parseFloat(hra.value) >= 50 : false);
                          } catch { flash('Could not load structure', 'error'); }
                        }} style={{ color: '#6B3FDB', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Edit</button>
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}

            {/* create / edit form */}
            {showForm && (
              <form onSubmit={saveStructure}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                  <div>
                    <label style={lbl}>Structure Name *</label>
                    <input value={formName} onChange={e => setFormName(e.target.value)} required style={inp} />
                  </div>
                  <div>
                    <label style={lbl}>Description</label>
                    <input value={formDesc} onChange={e => setFormDesc(e.target.value)} style={inp} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      <input type="checkbox" checked={formDefault} onChange={e => setFormDefault(e.target.checked)} />
                      Set as Default
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                      <input type="checkbox" checked={formMetro} onChange={e => toggleMetro(e.target.checked)} />
                      Metro City <span style={{ fontSize: 11, color: '#6B3FDB', fontWeight: 700 }}>HRA {formMetro ? '50%' : '40%'}</span>
                    </label>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  {/* components table */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <h4 style={{ margin: 0, color: '#4c1d95' }}>Pay Components</h4>
                      <button type="button" onClick={addComponent}
                        style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                        + Add
                      </button>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: '#f5f3ff' }}>
                            {['Name','Type','Calc','Value','Taxable','PF',''].map(h => (
                              <th key={h} style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600, whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {components.map((c, i) => (
                            <tr key={i} style={{ borderBottom: '1px solid #f0ebff' }}>
                              <td style={{ padding: '4px 6px' }}>
                                <input value={c.name} onChange={e => updateComponent(i, 'name', e.target.value)}
                                  style={{ width: 100, padding: '3px 6px', border: '1px solid #e9e4ff', borderRadius: 5, fontSize: 12 }} />
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                <select value={c.type} onChange={e => updateComponent(i, 'type', e.target.value)}
                                  style={{ padding: '3px 6px', border: '1px solid #e9e4ff', borderRadius: 5, fontSize: 12 }}>
                                  {COMP_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                <select value={c.calculation_type} onChange={e => updateComponent(i, 'calculation_type', e.target.value)}
                                  style={{ padding: '3px 6px', border: '1px solid #e9e4ff', borderRadius: 5, fontSize: 12 }}>
                                  {CALC_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                                </select>
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                <input type="number" value={c.value} onChange={e => updateComponent(i, 'value', e.target.value)}
                                  style={{ width: 70, padding: '3px 6px', border: '1px solid #e9e4ff', borderRadius: 5, fontSize: 12 }} />
                              </td>
                              <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                                <input type="checkbox" checked={c.is_taxable} onChange={e => updateComponent(i, 'is_taxable', e.target.checked)} />
                              </td>
                              <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                                <input type="checkbox" checked={c.is_pf_applicable} onChange={e => updateComponent(i, 'is_pf_applicable', e.target.checked)} />
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                <button type="button" onClick={() => removeComponent(i)}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 14 }}>✕</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* live preview */}
                  <div style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, border: '1px solid #e9e4ff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                      <h4 style={{ margin: 0, color: '#4c1d95' }}>Live Preview</h4>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, color: '#6b7280' }}>Monthly CTC ₹</span>
                        <input type="number" value={previewBasic} onChange={e => setPreviewBasic(parseFloat(e.target.value) || 0)}
                          style={{ width: 90, padding: '4px 8px', border: '1px solid #c4b5fd', borderRadius: 6, fontSize: 13, fontWeight: 600, color: '#4c1d95', background: '#ede9fe' }} />
                      </div>
                    </div>
                    {preview.lines.filter(l => l.type === 'earning').map((l, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                        <span style={{ color: '#374151' }}>{l.name || '(unnamed)'}</span>
                        <span style={{ color: '#16a34a', fontWeight: 500 }}>{fmtINR(l.computed_amount)}</span>
                      </div>
                    ))}
                    <div style={{ borderTop: '1px solid #e9e4ff', margin: '8px 0', paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: '#4c1d95' }}>
                      <span>Gross Salary</span><span>{fmtINR(preview.gross)}</span>
                    </div>
                    {preview.lines.filter(l => l.type !== 'earning').map((l, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                        <span style={{ color: '#6b7280' }}>{l.name || '(unnamed)'}</span>
                        <span style={{ color: '#dc2626' }}>− {fmtINR(l.computed_amount)}</span>
                      </div>
                    ))}
                    <div style={{ borderTop: '2px solid #6B3FDB', marginTop: 8, paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 700, color: '#6B3FDB', fontSize: 16 }}>
                      <span>Net Pay</span><span>{fmtINR(preview.net)}</span>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                  <button type="submit" disabled={loading}
                    style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 24px', cursor: 'pointer', fontWeight: 600 }}>
                    {loading ? 'Saving…' : editId ? 'Update Structure' : 'Save Structure'}
                  </button>
                  <button type="button" onClick={resetForm}
                    style={{ background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '9px 20px', cursor: 'pointer', fontWeight: 600 }}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* ── ASSIGNMENTS TAB ── */}
        {tab === 'assignments' && (
          <div>
            {/* Toolbar */}
            <div style={{ marginBottom: 14, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flex: 1, flexWrap: 'wrap' }}>
                <button onClick={() => { setShowArrears(a => !a); setArrearsRows([]); }}
                  style={{ background: showArrears ? '#fef3c7' : '#ede9fe', color: showArrears ? '#92400e' : '#6B3FDB',
                    border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  {showArrears ? '✕ Close Arrears Calc' : '⊕ Arrears Calculator'}
                </button>
                <button onClick={() => setBulkModal(true)}
                  style={{ background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                  Bulk Assign Structure
                </button>
              </div>
              {/* Search */}
              <input
                value={assignSearch}
                onChange={e => setAssignSearch(e.target.value)}
                placeholder="Search employee or structure…"
                style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, outline: 'none', minWidth: 220 }}
              />
            </div>

            {/* Arrears Calculator panel */}
            {showArrears && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <h4 style={{ margin: '0 0 14px', color: '#92400e' }}>Backdated Arrears Calculator</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(155px,1fr))', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={{ ...lbl, color: '#92400e' }}>Employee</label>
                    <select value={arrearsForm.employee_id} onChange={e => setArrearsForm(f => ({ ...f, employee_id: e.target.value }))}
                      style={{ ...inp, borderColor: '#fde68a' }}>
                      <option value="">— Select —</option>
                      {assignments.map(a => <option key={a.employee_id} value={a.employee_id}>{a.employee_name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ ...lbl, color: '#92400e' }}>Old Basic (₹)</label>
                    <input type="number" value={arrearsForm.old_basic} onChange={e => setArrearsForm(f => ({ ...f, old_basic: e.target.value }))} style={{ ...inp, borderColor: '#fde68a' }} />
                  </div>
                  <div>
                    <label style={{ ...lbl, color: '#92400e' }}>New Basic (₹)</label>
                    <input type="number" value={arrearsForm.new_basic} onChange={e => setArrearsForm(f => ({ ...f, new_basic: e.target.value }))} style={{ ...inp, borderColor: '#fde68a' }} />
                  </div>
                  <div>
                    <label style={{ ...lbl, color: '#92400e' }}>Arrears From</label>
                    <input type="date" value={arrearsForm.from_date} onChange={e => setArrearsForm(f => ({ ...f, from_date: e.target.value }))} style={{ ...inp, borderColor: '#fde68a' }} />
                  </div>
                  <div>
                    <label style={{ ...lbl, color: '#92400e' }}>Arrears To</label>
                    <input type="date" value={arrearsForm.to_date} onChange={e => setArrearsForm(f => ({ ...f, to_date: e.target.value }))} style={{ ...inp, borderColor: '#fde68a' }} />
                  </div>
                </div>
                <button onClick={() => {
                  if (arrearsForm.from_date && arrearsForm.to_date && arrearsForm.from_date > arrearsForm.to_date) {
                    flash('"From" date must be before "To" date', 'error'); return;
                  }
                  setArrearsRows(computeArrears(arrearsForm.old_basic, arrearsForm.new_basic, arrearsForm.from_date, arrearsForm.to_date));
                }} style={{ background: '#d97706', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontWeight: 600 }}>
                  Compute Arrears
                </button>

                {arrearsRows.length > 0 && (
                  <div style={{ marginTop: 14, overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#fef3c7' }}>
                          {['Month','Old Basic','New Basic','Arrears'].map(h => (
                            <th key={h} style={{ padding: '7px 12px', textAlign: 'left', color: '#92400e', fontWeight: 600 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {arrearsRows.map((r, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #fde68a' }}>
                            <td style={{ padding: '7px 12px' }}>{r.month}</td>
                            <td style={{ padding: '7px 12px' }}>{fmtINR(r.old_basic)}</td>
                            <td style={{ padding: '7px 12px' }}>{fmtINR(r.new_basic)}</td>
                            <td style={{ padding: '7px 12px', fontWeight: 700, color: r.arrears >= 0 ? '#16a34a' : '#dc2626' }}>
                              {r.arrears >= 0 ? '+' : ''}{fmtINR(r.arrears)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr style={{ background: '#fef3c7', fontWeight: 700 }}>
                          <td colSpan={3} style={{ padding: '7px 12px', color: '#92400e' }}>
                            Total Arrears ({arrearsRows.length} month{arrearsRows.length !== 1 ? 's' : ''})
                          </td>
                          <td style={{ padding: '7px 12px', color: '#16a34a', fontSize: 15 }}>
                            {fmtINR(arrearsRows.reduce((s, r) => s + r.arrears, 0))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f5f3ff' }}>
                    {['Employee','Code','Structure','Effective From','Basic','Gross (Est.)','Payslip','Actions'].map(h => (
                      <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAssignments.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>
                      {assignSearch ? 'No employees match your search.' : 'No employee assignments found.'}
                    </td></tr>
                  ) : filteredAssignments.map(a => (
                    <tr key={a.employee_id} style={{ borderBottom: '1px solid #f0ebff' }}>
                      <td style={{ padding: '9px 12px', fontWeight: 600 }}>{a.employee_name}</td>
                      <td style={{ padding: '9px 12px', color: '#6b7280' }}>{a.employee_code}</td>
                      <td style={{ padding: '9px 12px' }}>{a.structure_name || '—'}</td>
                      <td style={{ padding: '9px 12px', color: '#6b7280' }}>{a.effective_from}</td>
                      <td style={{ padding: '9px 12px', fontWeight: 500 }}>{fmtINR(a.basic_salary)}</td>
                      <td style={{ padding: '9px 12px', color: '#16a34a', fontWeight: 600 }}>{fmtINR(a.gross)}</td>
                      <td style={{ padding: '9px 12px' }}>
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                          background: a.last_payslip_status === 'generated' ? '#d1fae5' : '#fef3c7',
                          color:      a.last_payslip_status === 'generated' ? '#16a34a' : '#d97706' }}>
                          {a.last_payslip_status || 'pending'}
                        </span>
                      </td>
                      <td style={{ padding: '9px 12px' }}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button onClick={() => {
                            setAssignModal(a);
                            setAssignForm({
                              structure_id:   structures.length ? String(structures[0].id) : '',
                              basic_salary:   a.basic_salary,
                              effective_from: new Date().toISOString().split('T')[0],
                            });
                          }} style={{ background: '#ede9fe', color: '#6B3FDB', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                            Assign
                          </button>
                          <button onClick={() => openHistory(a)}
                            style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                            History
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Assign modal */}
            {assignModal && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 420, maxWidth: '95vw' }}>
                  <h3 style={{ color: '#4c1d95', margin: '0 0 16px' }}>Assign Structure — {assignModal.employee_name}</h3>
                  <form onSubmit={saveAssign}>
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>Salary Structure *</label>
                      <select value={assignForm.structure_id} onChange={e => setAssignForm(f => ({ ...f, structure_id: e.target.value }))}
                        style={{ width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} required>
                        <option value="">— Select structure —</option>
                        {structures.map(s => <option key={s.id} value={s.id}>{s.name}{s.is_default ? ' (Default)' : ''}</option>)}
                      </select>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>Basic Salary (₹) *</label>
                      <input type="number" required value={assignForm.basic_salary} onChange={e => setAssignForm(f => ({ ...f, basic_salary: e.target.value }))} style={inp} />
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={lbl}>Effective From</label>
                      <input type="date" value={assignForm.effective_from} onChange={e => setAssignForm(f => ({ ...f, effective_from: e.target.value }))} style={inp} />
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button type="submit" disabled={loading}
                        style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                        {loading ? 'Saving…' : 'Assign'}
                      </button>
                      <button type="button" onClick={() => setAssignModal(null)}
                        style={{ background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* Bulk Assign modal */}
            {bulkModal && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 460, maxWidth: '95vw' }}>
                  <h3 style={{ color: '#4c1d95', margin: '0 0 8px' }}>Bulk Assign Structure</h3>
                  <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 16px' }}>
                    This will assign the selected structure to all <strong>{filteredAssignments.length}</strong> employees
                    {assignSearch ? ` matching "${assignSearch}"` : ''}.
                  </p>
                  <form onSubmit={saveBulkAssign}>
                    <div style={{ marginBottom: 12 }}>
                      <label style={lbl}>Salary Structure *</label>
                      <select value={bulkForm.structure_id} onChange={e => setBulkForm(f => ({ ...f, structure_id: e.target.value }))}
                        style={{ width: '100%', padding: '8px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }} required>
                        <option value="">— Select structure —</option>
                        {structures.map(s => <option key={s.id} value={s.id}>{s.name}{s.is_default ? ' (Default)' : ''}</option>)}
                      </select>
                    </div>
                    <div style={{ marginBottom: 16 }}>
                      <label style={lbl}>Effective From</label>
                      <input type="date" value={bulkForm.effective_from} onChange={e => setBulkForm(f => ({ ...f, effective_from: e.target.value }))} style={inp} />
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button type="submit" disabled={bulkLoading}
                        style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                        {bulkLoading ? 'Assigning…' : `Assign to ${filteredAssignments.length} Employees`}
                      </button>
                      <button type="button" onClick={() => setBulkModal(false)}
                        style={{ background: '#e9e4ff', color: '#6B3FDB', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* Revision history modal */}
            {historyModal && (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 660, maxWidth: '95vw', maxHeight: '80vh', overflowY: 'auto' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h3 style={{ color: '#4c1d95', margin: 0 }}>Salary Revision History — {historyModal.employee_name}</h3>
                    <button onClick={() => { setHistoryModal(null); setRevisionHistory([]); }}
                      style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#6b7280', lineHeight: 1 }}>✕</button>
                  </div>
                  {historyLoading ? (
                    <div style={{ textAlign: 'center', padding: 30, color: '#6b7280' }}>Loading history…</div>
                  ) : revisionHistory.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: 30, color: '#9ca3af', fontSize: 14 }}>
                      No revision history found. Salary assignments will appear here once saved.
                    </div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#f5f3ff' }}>
                          {['Effective From','Structure','Basic Salary','% Change','Assigned On'].map(h => (
                            <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#4c1d95', fontWeight: 600, borderBottom: '1px solid #e9e4ff' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {revisionHistory.map((r, i) => {
                          const prev = revisionHistory[i + 1];
                          const pct  = prev
                            ? ((parseFloat(r.basic_salary) - parseFloat(prev.basic_salary)) / parseFloat(prev.basic_salary) * 100).toFixed(1)
                            : null;
                          return (
                            <tr key={r.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                              <td style={{ padding: '8px 12px', fontWeight: 600 }}>{r.effective_from?.split('T')[0] || r.effective_from}</td>
                              <td style={{ padding: '8px 12px' }}>{r.structure_name || '—'}</td>
                              <td style={{ padding: '8px 12px', fontWeight: 700, color: '#4c1d95' }}>{fmtINR(r.basic_salary)}</td>
                              <td style={{ padding: '8px 12px' }}>
                                {pct !== null
                                  ? <span style={{ fontWeight: 700, color: parseFloat(pct) >= 0 ? '#16a34a' : '#dc2626' }}>{parseFloat(pct) >= 0 ? '+' : ''}{pct}%</span>
                                  : <span style={{ color: '#9ca3af' }}>Initial</span>}
                              </td>
                              <td style={{ padding: '8px 12px', color: '#6b7280' }}>{r.created_at?.split('T')[0]}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── LOANS & ADVANCES TAB ── */}
        {tab === 'loans' && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10, flexWrap: 'wrap' }}>
              <button onClick={() => setShowLoanForm(f => !f)}
                style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 18px', cursor: 'pointer', fontWeight: 600 }}>
                {showLoanForm ? '✕ Cancel' : '+ New Loan / Advance'}
              </button>
              <input
                value={loanSearch}
                onChange={e => setLoanSearch(e.target.value)}
                placeholder="Search employee or type…"
                style={{ padding: '8px 12px', border: '1px solid #e9e4ff', borderRadius: 8, fontSize: 13, outline: 'none', minWidth: 220 }}
              />
            </div>

            {showLoanForm && (
              <form onSubmit={saveLoan} style={{ background: '#f5f3ff', borderRadius: 10, padding: 16, marginBottom: 16, border: '1px solid #e9e4ff' }}>
                <h4 style={{ margin: '0 0 14px', color: '#4c1d95' }}>New Loan / Advance</h4>

                {/* EMI auto-calculator */}
                <div style={{ background: '#ede9fe', borderRadius: 8, padding: 12, marginBottom: 14, border: '1px solid #c4b5fd' }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#4c1d95', marginBottom: 8 }}>EMI Calculator</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 10, alignItems: 'end' }}>
                    <div>
                      <label style={lbl}>Annual Interest Rate (%)</label>
                      <input type="number" step="0.1" value={loanCalc.interest_rate}
                        onChange={e => setLoanCalc(c => ({ ...c, interest_rate: e.target.value }))}
                        placeholder="e.g. 10.5" style={inp} />
                    </div>
                    <div>
                      <label style={lbl}>Tenure (months)</label>
                      <input type="number" value={loanCalc.tenure}
                        onChange={e => setLoanCalc(c => ({ ...c, tenure: e.target.value }))}
                        placeholder="e.g. 24" style={inp} />
                    </div>
                    <div>
                      {computedEMI > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div style={{ fontSize: 12, color: '#4c1d95', fontWeight: 600 }}>Computed EMI</div>
                          <div style={{ fontSize: 18, fontWeight: 700, color: '#6B3FDB' }}>{fmtINR(computedEMI)}/mo</div>
                          <button type="button" onClick={() => setLoanForm(f => ({ ...f, emi_amount: String(computedEMI) }))}
                            style={{ background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 12, width: 'fit-content' }}>
                            Use This EMI ↓
                          </button>
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: '#9ca3af' }}>Enter principal + rate + tenure to compute</div>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
                  {/* Employee dropdown instead of raw ID input */}
                  <div>
                    <label style={lbl}>Employee *</label>
                    <select required value={loanForm.employee_id} onChange={e => setLoanForm(lf => ({ ...lf, employee_id: e.target.value }))}
                      style={{ ...inp }}>
                      <option value="">— Select employee —</option>
                      {assignments.map(a => (
                        <option key={a.employee_id} value={a.employee_id}>{a.employee_name} ({a.employee_code})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Principal Amount (₹) *</label>
                    <input type="number" required value={loanForm.principal_amount} onChange={e => setLoanForm(lf => ({ ...lf, principal_amount: e.target.value }))} style={inp} />
                  </div>
                  <div>
                    <label style={lbl}>EMI Amount (₹) *</label>
                    <input type="number" required value={loanForm.emi_amount} onChange={e => setLoanForm(lf => ({ ...lf, emi_amount: e.target.value }))} style={inp} />
                  </div>
                  <div>
                    <label style={lbl}>Start Date *</label>
                    <input type="date" required value={loanForm.start_date} onChange={e => setLoanForm(lf => ({ ...lf, start_date: e.target.value }))} style={inp} />
                  </div>
                  <div>
                    <label style={lbl}>Type</label>
                    <select value={loanForm.loan_type} onChange={e => setLoanForm(lf => ({ ...lf, loan_type: e.target.value }))}
                      style={{ width: '100%', padding: '7px 10px', border: '1px solid #e9e4ff', borderRadius: 7, fontSize: 13 }}>
                      <option value="loan">Salary Loan</option>
                      <option value="advance">Salary Advance</option>
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Reason</label>
                    <input value={loanForm.reason} onChange={e => setLoanForm(lf => ({ ...lf, reason: e.target.value }))} style={inp} />
                  </div>
                </div>

                {loanForm.principal_amount && loanForm.emi_amount && (
                  <div style={{ marginTop: 10, fontSize: 13, color: '#6B3FDB', fontWeight: 500 }}>
                    Estimated tenure: {Math.ceil(parseFloat(loanForm.principal_amount) / parseFloat(loanForm.emi_amount))} months
                  </div>
                )}
                <button type="submit" disabled={loading}
                  style={{ marginTop: 14, background: '#6B3FDB', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', cursor: 'pointer', fontWeight: 600 }}>
                  {loading ? 'Saving…' : 'Create'}
                </button>
              </form>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f5f3ff' }}>
                    {['Employee','Type','Principal','EMI','Outstanding','Progress','Start Date','Actions'].map(h => (
                      <th key={h} style={{ padding: '9px 12px', textAlign: 'left', borderBottom: '1px solid #e9e4ff', color: '#4c1d95', fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredLoans.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>
                      {loanSearch ? 'No loans match your search.' : 'No active loans or advances.'}
                    </td></tr>
                  ) : filteredLoans.map(l => {
                    const outstanding = parseFloat(l.outstanding_balance);
                    const pct = outstanding > 0
                      ? Math.round((1 - outstanding / parseFloat(l.principal_amount)) * 100)
                      : 100;
                    const isClosed = outstanding <= 0 || l.status === 'closed';
                    return (
                      <tr key={l.id} style={{ borderBottom: '1px solid #f0ebff' }}>
                        <td style={{ padding: '9px 12px', fontWeight: 600 }}>{l.employee_name}</td>
                        <td style={{ padding: '9px 12px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                            background: l.loan_type === 'advance' ? '#fef3c7' : '#ede9fe',
                            color:      l.loan_type === 'advance' ? '#d97706'  : '#6B3FDB' }}>
                            {l.loan_type}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px' }}>{fmtINR(l.principal_amount)}</td>
                        <td style={{ padding: '9px 12px', color: '#dc2626' }}>{fmtINR(l.emi_amount)}/mo</td>
                        <td style={{ padding: '9px 12px', fontWeight: 600, color: isClosed ? '#16a34a' : '#dc2626' }}>
                          {isClosed ? 'Cleared' : fmtINR(l.outstanding_balance)}
                        </td>
                        <td style={{ padding: '9px 12px', minWidth: 140 }}>
                          <div style={{ height: 6, background: '#e9e4ff', borderRadius: 3 }}>
                            <div style={{ height: '100%', width: `${Math.min(pct,100)}%`, background: isClosed ? '#16a34a' : '#6B3FDB', borderRadius: 3 }} />
                          </div>
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{pct}% repaid</div>
                        </td>
                        <td style={{ padding: '9px 12px', color: '#6b7280' }}>{l.start_date?.split('T')[0]}</td>
                        <td style={{ padding: '9px 12px' }}>
                          {!isClosed && (
                            <button onClick={() => closeLoan(l.id)}
                              style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 6,
                                padding: '4px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                              Close
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
