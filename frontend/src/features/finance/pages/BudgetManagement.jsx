import React, { useCallback, useMemo, useState } from 'react';
import api from '@/services/api/client';
import ConfirmDialog from '@/components/core/ConfirmDialog';
import { usePageAccess } from '@/hooks/usePageAccess';
import ReadOnlyBanner from '@/components/ReadOnlyBanner';

const TAB_LIST = ['Budget List', 'vs Actuals', 'Forecast', 'Variance Analysis', 'Cash Flow Projection'];

function getCurrentFY() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return month >= 4 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function getFYOptions() {
  const now = new Date();
  const startYear = now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1;
  const options = [];
  for (let y = startYear - 2; y <= startYear + 1; y++) {
    options.push(`${y}-${y + 1}`);
  }
  return options;
}

function formatINR(value) {
  const amount = Number(value) || 0;
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  return `${sign}₹${abs.toLocaleString('en-IN')}`;
}

function utilizationColor(pct) {
  if (pct > 90) return '#dc2626';
  if (pct > 75) return '#d97706';
  return '#15803d';
}

function parseRevisionCount(budget) {
  const match = String(budget?.name || '').match(/\[Rev\s+(\d+)\]/i);
  if (match) return parseInt(match[1], 10) || 0;
  return 0;
}

function getFYMonthRows(financialYear) {
  const fyMatch = /^(\d{4})-(\d{4})$/.exec(String(financialYear || ''));
  if (!fyMatch) return [];
  const startYear = Number(fyMatch[1]);
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    const date = new Date(startYear, 3 + i, 1);
    rows.push({
      key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
      label: date.toLocaleString('en-IN', { month: 'short', year: 'numeric' }),
      date,
    });
  }
  return rows;
}

function normalizeForecastPayload(payload, fallbackFy, fallbackDepartment) {
  return {
    financial_year: payload?.financial_year || fallbackFy,
    department: payload?.department || fallbackDepartment || 'All Departments',
    as_of_date: payload?.as_of_date || new Date().toISOString().slice(0, 10),
    total_budgeted: Number(payload?.total_budgeted) || 0,
    actual_to_date: Number(payload?.actual_to_date) || 0,
    last_3_month_trend_average: Number(payload?.last_3_month_trend_average) || 0,
    projected_remaining_months: Array.isArray(payload?.projected_remaining_months) ? payload.projected_remaining_months : [],
    projected_remaining_total: Number(payload?.projected_remaining_total) || 0,
    annual_forecast: Number(payload?.annual_forecast) || 0,
    forecast_variance_vs_budget: Number(payload?.forecast_variance_vs_budget) || 0,
  };
}

function normalizeVariancePayload(payload, fallbackFy, fallbackDepartment) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return {
    financial_year: payload?.financial_year || fallbackFy,
    department: payload?.department || fallbackDepartment || 'All Departments',
    rows: rows.map((row) => ({
      ...row,
      budget_amount: Number(row?.budget_amount) || 0,
      actual_amount: Number(row?.actual_amount) || 0,
      variance_amount: Number(row?.variance_amount) || 0,
      variance_pct: Number(row?.variance_pct) || 0,
      overspend_flag: Boolean(row?.overspend_flag),
      root_cause_category: String(row?.root_cause_category || 'timing variance'),
    })),
  };
}

function normalizeCashflowPayload(payload, fallbackFy, fallbackDepartment) {
  const metadata = payload?.metadata || {};
  return {
    financial_year: payload?.financial_year || fallbackFy,
    department: payload?.department || fallbackDepartment || 'All Departments',
    metadata: {
      as_of_date: metadata?.as_of_date || new Date().toISOString().slice(0, 10),
      opening_cash_balance: Number(metadata?.opening_cash_balance) || 0,
      minimum_cash_balance: Number(metadata?.minimum_cash_balance) || 0,
      assumptions: Array.isArray(metadata?.assumptions) ? metadata.assumptions : [],
      total_budgeted: Number(metadata?.total_budgeted) || 0,
      last_3_month_average_outflow: Number(metadata?.last_3_month_average_outflow) || 0,
    },
    monthly_projection: Array.isArray(payload?.monthly_projection)
      ? payload.monthly_projection.map((row) => ({
        ...row,
        inflow: Number(row?.inflow) || 0,
        outflow: Number(row?.outflow) || 0,
        net_movement: Number(row?.net_movement) || 0,
        net_cash_position: Number(row?.net_cash_position) || 0,
      }))
      : [],
    alerts: Array.isArray(payload?.alerts)
      ? payload.alerts.map((a) => ({
        ...a,
        net_cash_position: Number(a?.net_cash_position) || 0,
        minimum_cash_balance: Number(a?.minimum_cash_balance) || 0,
        shortfall: Number(a?.shortfall) || 0,
      }))
      : [],
  };
}

function noticeStyle(type) {
  if (type === 'success') return { marginBottom: 12, border: '1px solid #bbf7d0', background: '#f0fdf4', color: '#15803d', borderRadius: 10, padding: '10px 12px', fontSize: 13 };
  if (type === 'error')   return { marginBottom: 12, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', borderRadius: 10, padding: '10px 12px', fontSize: 13 };
  return { marginBottom: 12, border: '1px solid #e9e4ff', background: '#f5f3ff', color: '#5b21b6', borderRadius: 10, padding: '10px 12px', fontSize: 13 };
}

function StatusBadge({ status }) {
  const s = String(status || '').toLowerCase();
  const map = {
    draft:        { bg: '#f3f4f6', color: '#6b7280', label: 'Draft' },
    submitted:    { bg: '#f5f3ff', color: '#6B3FDB', label: 'Submitted' },
    under_review: { bg: '#fef3c7', color: '#b45309', label: 'Under Review' },
    approved:     { bg: '#dcfce7', color: '#15803d', label: 'Approved' },
    active:       { bg: '#dbeafe', color: '#1d4ed8', label: 'Active' },
    closed:       { bg: '#f3f4f6', color: '#374151', label: 'Closed' },
    rejected:     { bg: '#fee2e2', color: '#b91c1c', label: 'Rejected' },
  };
  const chosen = map[s] || { bg: '#f3f4f6', color: '#6b7280', label: status || 'Unknown' };
  return (
    <span style={{ background: chosen.bg, color: chosen.color, borderRadius: 999, fontSize: 12, fontWeight: 700, padding: '4px 10px', textTransform: 'capitalize' }}>
      {chosen.label}
    </span>
  );
}

function DeptSelect({ value, onChange, departments, placeholder = 'All Departments', width = 180 }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width }}>
      <option value="">{placeholder}</option>
      {departments.map((d) => <option key={d} value={d}>{d}</option>)}
    </select>
  );
}

function FYSelect({ value, onChange, fyOptions, width = 140 }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width }}>
      {fyOptions.map((fy) => <option key={fy} value={fy}>{fy}</option>)}
    </select>
  );
}

function NewBudgetModal({ onClose, onSave, saving, departments, fyOptions, initial = null }) {
  const isEdit = initial !== null;
  const [form, setForm] = useState({
    name:           initial?.name           || '',
    financial_year: initial?.financial_year || getCurrentFY(),
    department:     initial?.department     || '',
    budget_type:    initial?.budget_type    || 'annual',
    total_amount:   initial ? String(initial.total_amount ?? '') : '',
    notes:          initial?.notes          || '',
  });

  const canSave = form.name.trim() && form.financial_year.trim() && form.department.trim() && String(form.total_amount).trim();

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 620, maxWidth: '94vw', background: '#fff', borderRadius: 16, border: '1px solid #e9e4ff', overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #e9e4ff', background: '#f5f3ff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#1f2937' }}>{isEdit ? 'Edit Budget' : 'New Budget'}</div>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 22, color: '#6b7280', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Budget Name</label>
            <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} style={inputStyle} placeholder="e.g. Marketing FY 2026-2027" />
          </div>
          <div>
            <label style={labelStyle}>Financial Year</label>
            <select
              value={form.financial_year}
              onChange={(e) => setForm((p) => ({ ...p, financial_year: e.target.value }))}
              style={{ ...inputStyle, ...(isEdit ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}
              disabled={isEdit}
            >
              {fyOptions.map((fy) => <option key={fy} value={fy}>{fy}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Department</label>
            <select value={form.department} onChange={(e) => setForm((p) => ({ ...p, department: e.target.value }))} style={inputStyle}>
              <option value="">Select Department</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Budget Type</label>
            <select value={form.budget_type} onChange={(e) => setForm((p) => ({ ...p, budget_type: e.target.value }))} style={inputStyle}>
              <option value="annual">Annual</option>
              <option value="quarterly">Quarterly</option>
              <option value="monthly">Monthly</option>
              <option value="project">Project</option>
              <option value="ad_hoc">Ad-hoc</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Total Amount (₹)</label>
            <input type="number" value={form.total_amount} onChange={(e) => setForm((p) => ({ ...p, total_amount: e.target.value }))} style={inputStyle} placeholder="0" min="0" />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Notes</label>
            <textarea rows={3} value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} style={{ ...inputStyle, resize: 'vertical' }} placeholder="Optional notes" />
          </div>
        </div>

        <div style={{ padding: '14px 18px', borderTop: '1px solid #e9e4ff', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} style={secondaryBtn}>Cancel</button>
          <button
            onClick={() => onSave(form)}
            disabled={!canSave || saving}
            style={{ ...primaryBtn, opacity: !canSave || saving ? 0.6 : 1, cursor: !canSave || saving ? 'not-allowed' : 'pointer' }}
          >
            {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Save Budget'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BudgetManagement() {
  const { readOnly } = usePageAccess();
  const fyOptions = useMemo(() => getFYOptions(), []);

  // Role check: only these roles can approve/reject budgets
  const canApprove = useMemo(() => {
    const role = localStorage.getItem('role');
    return ['admin', 'super_admin', 'finance_admin', 'cfo', 'manager'].includes(role);
  }, []);

  const [activeTab, setActiveTab]   = useState(0);
  const [globalFY, setGlobalFY]     = useState(getCurrentFY);   // shared across all tabs
  const [loading, setLoading]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [budgets, setBudgets]       = useState([]);
  const [departments, setDepartments] = useState([]);
  const [showModal, setShowModal]   = useState(false);
  const [editBudget, setEditBudget] = useState(null);           // null = create, object = edit
  const [notice, setNotice]         = useState({ msg: '', type: '' });
  const [reviseModal, setReviseModal] = useState({ open: false, id: null, reason: '' });

  const [actualsLoading, setActualsLoading] = useState(false);
  const [actualsData, setActualsData]       = useState(null);
  const [actualsFilters, setActualsFilters] = useState({ department: '' });

  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastNotice, setForecastNotice]   = useState('');
  const [forecastData, setForecastData]       = useState(() => normalizeForecastPayload(null, getCurrentFY(), 'All Departments'));

  const [varianceLoading, setVarianceLoading]       = useState(false);
  const [varianceNotice, setVarianceNotice]         = useState('');
  const [varianceData, setVarianceData]             = useState(() => normalizeVariancePayload(null, getCurrentFY(), 'All Departments'));
  const [selectedVarianceRow, setSelectedVarianceRow] = useState(null);

  const [cashflowLoading, setCashflowLoading] = useState(false);
  const [cashflowNotice, setCashflowNotice]   = useState('');
  const [cashflowData, setCashflowData]       = useState(() => normalizeCashflowPayload(null, getCurrentFY(), 'All Departments'));

  // Per-tab filters (financial_year is now globalFY — shared)
  const [filters, setFilters]               = useState({ department: '', status: '' });
  const [forecastFilters, setForecastFilters]   = useState({ department: '' });
  const [varianceFilters, setVarianceFilters]   = useState({ department: '' });
  const [cashflowFilters, setCashflowFilters]   = useState({ department: '', opening_cash_balance: '0', minimum_cash_balance: '0' });
  const [pendingHandleDeleteBudget, setPendingHandleDeleteBudget] = useState(null);

  // Load departments once
  React.useEffect(() => {
    api.get('/orgchart/departments').then((res) => {
      const raw = res.data?.data || res.data || [];
      const list = Array.isArray(raw) ? raw.map((d) => d.department || d.name || d).filter(Boolean) : [];
      setDepartments([...new Set(list)].sort());
    }).catch(() => {});
  }, []);

  const loadBudgets = useCallback(async () => {
    setLoading(true);
    const params = {
      financial_year: globalFY || undefined,
      department: filters.department || undefined,
      status: filters.status || undefined,
    };
    const [result] = await Promise.allSettled([api.get('/budgets', { params })]);
    if (result.status === 'fulfilled' && Array.isArray(result.value?.data)) {
      setBudgets(result.value.data);
      setNotice({ msg: '', type: '' });
    } else {
      setBudgets([]);
      setNotice({ msg: '', type: '' });
    }
    setLoading(false);
  }, [filters.department, filters.status, globalFY]);

  React.useEffect(() => {
    loadBudgets();
  }, [loadBudgets]);

  const loadActuals = useCallback(async () => {
    setActualsLoading(true);
    const [result] = await Promise.allSettled([
      api.get('/budgets/report/vs-actuals', {
        params: {
          financial_year: globalFY || undefined,
          department: actualsFilters.department || undefined,
        },
      }),
    ]);
    setActualsData(result.status === 'fulfilled' ? (result.value?.data ?? null) : null);
    setActualsLoading(false);
  }, [actualsFilters.department, globalFY]);

  React.useEffect(() => {
    if (activeTab === 1) loadActuals();
  }, [activeTab, loadActuals]);

  const loadForecast = useCallback(async () => {
    setForecastLoading(true);
    const [result] = await Promise.allSettled([
      api.get('/budgets/forecast', {
        params: { financial_year: globalFY || undefined, department: forecastFilters.department || undefined },
      }),
    ]);
    setForecastData(normalizeForecastPayload(
      result.status === 'fulfilled' ? result.value?.data : null,
      globalFY, forecastFilters.department || 'All Departments',
    ));
    setForecastNotice('');
    setForecastLoading(false);
  }, [forecastFilters.department, globalFY]);

  React.useEffect(() => {
    if (activeTab === 2) loadForecast();
  }, [activeTab, loadForecast]);

  const loadVarianceAnalysis = useCallback(async () => {
    setVarianceLoading(true);
    const [result] = await Promise.allSettled([
      api.get('/budgets/variance-analysis', {
        params: { financial_year: globalFY || undefined, department: varianceFilters.department || undefined },
      }),
    ]);
    setVarianceData(normalizeVariancePayload(
      result.status === 'fulfilled' ? result.value?.data : null,
      globalFY, varianceFilters.department || 'All Departments',
    ));
    setVarianceNotice('');
    setVarianceLoading(false);
  }, [varianceFilters.department, globalFY]);

  React.useEffect(() => {
    if (activeTab === 3) {
      setSelectedVarianceRow(null);
      loadVarianceAnalysis();
    }
  }, [activeTab, loadVarianceAnalysis]);

  const loadCashflowProjection = useCallback(async () => {
    setCashflowLoading(true);
    const params = {
      financial_year: globalFY || undefined,
      department: cashflowFilters.department || undefined,
      opening_cash_balance: cashflowFilters.opening_cash_balance === '' ? undefined : cashflowFilters.opening_cash_balance,
      minimum_cash_balance: cashflowFilters.minimum_cash_balance === '' ? undefined : cashflowFilters.minimum_cash_balance,
    };
    const [result] = await Promise.allSettled([api.get('/budgets/cashflow-projection', { params })]);
    setCashflowData(normalizeCashflowPayload(
      result.status === 'fulfilled' ? result.value?.data : null,
      globalFY, cashflowFilters.department || 'All Departments',
    ));
    setCashflowNotice('');
    setCashflowLoading(false);
  }, [cashflowFilters.department, cashflowFilters.minimum_cash_balance, cashflowFilters.opening_cash_balance, globalFY]);

  React.useEffect(() => {
    if (activeTab === 4) loadCashflowProjection();
  }, [activeTab, loadCashflowProjection]);

  const listRows = useMemo(() => {
    return budgets.map((b) => ({
      ...b,
      revision_count: parseRevisionCount(b),
      total_amount_num: Number(b.total_amount) || 0,
      total_actual_num: Number(b.total_actual) || 0,
      utilization_pct_num: Math.max(0, Number(b.utilization_pct) || 0),
    }));
  }, [budgets]);

  const kpi = useMemo(() => {
    const total      = listRows.length;
    const allocated  = listRows.reduce((s, r) => s + r.total_amount_num, 0);
    const utilized   = listRows.reduce((s, r) => s + r.total_actual_num, 0);
    const overBudget = listRows.filter((r) => r.utilization_pct_num > 100).length;
    return { total, allocated, utilized, overBudget };
  }, [listRows]);

  const forecastRows = useMemo(() => {
    const rows = getFYMonthRows(forecastData.financial_year);
    if (rows.length === 0) return [];

    const projectedMap = new Map();
    forecastData.projected_remaining_months.forEach((item) => {
      const monthDate = new Date(`${item.month} 01`);
      if (!Number.isNaN(monthDate.getTime())) {
        const key = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}`;
        projectedMap.set(key, Number(item.projected_amount) || 0);
      }
    });

    const asOf = new Date(forecastData.as_of_date);
    const asOfMonthKey = Number.isNaN(asOf.getTime()) ? null : `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, '0')}`;
    const elapsedMonths = Math.max(1, rows.filter((row) => !asOfMonthKey || row.key <= asOfMonthKey).length);
    const estimatedActualPerMonth = forecastData.actual_to_date > 0 ? forecastData.actual_to_date / elapsedMonths : 0;

    return rows.map((row) => {
      const isPastOrCurrent = !asOfMonthKey || row.key <= asOfMonthKey;
      return { month: row.label, actual: isPastOrCurrent ? estimatedActualPerMonth : 0, projected: projectedMap.get(row.key) || 0 };
    });
  }, [forecastData]);

  // Handles both create (showModal) and edit (editBudget) flows
  async function handleSaveBudget(formData) {
    setSaving(true);
    if (editBudget) {
      const payload = {
        name: formData.name,
        department: formData.department,
        budget_type: formData.budget_type,
        total_amount: Number(formData.total_amount),
        notes: formData.notes,
      };
      const [result] = await Promise.allSettled([api.put(`/budgets/${editBudget.id}`, payload)]);
      setSaving(false);
      if (result.status === 'fulfilled') {
        setEditBudget(null);
        setNotice({ msg: 'Budget updated successfully.', type: 'success' });
        loadBudgets();
      } else {
        setNotice({ msg: result.reason?.response?.data?.error || 'Unable to update budget.', type: 'error' });
      }
    } else {
      const payload = { ...formData, total_amount: Number(formData.total_amount), line_items: [] };
      const [result] = await Promise.allSettled([api.post('/budgets', payload)]);
      setSaving(false);
      if (result.status === 'fulfilled') {
        setShowModal(false);
        setNotice({ msg: 'Budget created successfully.', type: 'success' });
        loadBudgets();
      } else {
        setNotice({ msg: result.reason?.response?.data?.error || 'Unable to create budget right now.', type: 'error' });
      }
    }
  }

  async function handleDeleteBudget() {
    if (!pendingHandleDeleteBudget) return;
    const budgetId = pendingHandleDeleteBudget;
    setPendingHandleDeleteBudget(null);
    const [result] = await Promise.allSettled([api.delete(`/budgets/${budgetId}`)]);
    if (result.status === 'fulfilled') {
      setNotice({ msg: 'Budget deleted.', type: 'success' });
      loadBudgets();
    } else {
      setNotice({ msg: result.reason?.response?.data?.error || 'Unable to delete budget.', type: 'error' });
    }
  }

  async function handleCloneNextFY(budget) {
    const parts = String(budget.financial_year || '').split('-').map(Number);
    if (parts.length < 2 || !parts[1]) {
      setNotice({ msg: 'Cannot determine next FY from this budget.', type: 'error' });
      return;
    }
    const nextFY   = `${parts[1]}-${parts[1] + 1}`;
    const baseName = String(budget.name || '').replace(/\s*\[Rev\s*\d+\]/i, '').replace(/\s*\(Clone\)\s*$/i, '').trim();
    const payload  = {
      name:           `${baseName} (Clone)`,
      financial_year: nextFY,
      department:     budget.department,
      budget_type:    budget.budget_type,
      total_amount:   Number(budget.total_amount),
      notes:          `Cloned from FY ${budget.financial_year} (Budget ID: ${budget.id})`,
      line_items:     [],
    };
    const [result] = await Promise.allSettled([api.post('/budgets', payload)]);
    if (result.status === 'fulfilled') {
      setNotice({ msg: `Cloned as draft for FY ${nextFY}.`, type: 'success' });
      loadBudgets();
    } else {
      setNotice({ msg: result.reason?.response?.data?.error || 'Unable to clone budget.', type: 'error' });
    }
  }

  async function handleWorkflowAction(budgetId, action) {
    const [result] = await Promise.allSettled([
      api.post('/budgets/approval-workflow', { budget_id: budgetId, action }),
    ]);
    if (result.status === 'fulfilled') {
      setNotice({ msg: `Budget ${action} successful.`, type: 'success' });
      loadBudgets();
    } else {
      setNotice({ msg: result.reason?.response?.data?.error || `Unable to perform: ${action}.`, type: 'error' });
    }
  }

  async function handleRevise(budgetId) {
    setReviseModal({ open: true, id: budgetId, reason: '' });
  }

  async function confirmRevise() {
    const { id, reason } = reviseModal;
    setReviseModal({ open: false, id: null, reason: '' });
    if (!id) return;
    const [result] = await Promise.allSettled([api.post(`/budgets/${id}/revise`, { revision_reason: reason })]);
    if (result.status === 'fulfilled') {
      setNotice({ msg: 'Budget revision created as draft.', type: 'success' });
      loadBudgets();
    } else {
      setNotice({ msg: result.reason?.response?.data?.error || 'Unable to create revision.', type: 'error' });
    }
  }

  const isFiltered = filters.department || filters.status || globalFY !== getCurrentFY();

  return (
    <div style={{ padding: 20, background: '#f8f7ff', minHeight: '100vh' }}>

      {readOnly && <ReadOnlyBanner />}

      <ConfirmDialog
        open={!!pendingHandleDeleteBudget}
        title="Delete Budget"
        message="Delete this draft budget? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeleteBudget}
        onCancel={() => setPendingHandleDeleteBudget(null)}
      />

      {reviseModal.open && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, fontWeight: 700 }}>Budget Revision Reason</h3>
            <textarea
              autoFocus
              rows={3}
              style={{ width: '100%', borderRadius: 8, border: '1px solid #d1d5db', padding: '8px 12px', fontSize: 13, resize: 'vertical' }}
              placeholder="Enter reason for revision..."
              value={reviseModal.reason}
              onChange={e => setReviseModal(m => ({ ...m, reason: e.target.value }))}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={() => setReviseModal({ open: false, id: null, reason: '' })} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: 'transparent', cursor: 'pointer' }}>Cancel</button>
              <button onClick={confirmRevise} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#6B3FDB', color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Revise</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, color: '#1f2937', fontWeight: 800 }}>Budget Management</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#6b7280' }}>Finance budget controls and approval actions</p>
      </div>

      <div style={{ display: 'flex', gap: 6, background: '#fff', border: '1px solid #e9e4ff', borderRadius: 10, padding: 4, width: 'fit-content', marginBottom: 16 }}>
        {TAB_LIST.map((tab, index) => (
          <button
            key={tab}
            onClick={() => setActiveTab(index)}
            style={{
              border: 'none', borderRadius: 8, padding: '8px 12px',
              background: activeTab === index ? '#6B3FDB' : 'transparent',
              color: activeTab === index ? '#fff' : '#6b7280',
              fontSize: 13, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* ── TAB 0: Budget List ─────────────────────────────────────────────── */}
      {activeTab === 0 && (
        <div>
          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
            {[
              { label: 'Total Budgets',   value: String(kpi.total),         color: '#111827' },
              { label: 'Total Allocated', value: formatINR(kpi.allocated),  color: '#111827' },
              { label: 'Total Utilized',  value: formatINR(kpi.utilized),   color: '#111827' },
              { label: 'Over Budget',     value: String(kpi.overBudget),    color: kpi.overBudget > 0 ? '#dc2626' : '#15803d' },
            ].map((card) => (
              <div key={card.label} style={{ background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4', padding: '12px 14px' }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{card.label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: card.color }}>{card.value}</div>
              </div>
            ))}
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <FYSelect value={globalFY} onChange={setGlobalFY} fyOptions={fyOptions} />
            <DeptSelect value={filters.department} onChange={(v) => setFilters((p) => ({ ...p, department: v }))} departments={departments} />
            <select value={filters.status} onChange={(e) => setFilters((p) => ({ ...p, status: e.target.value }))} style={{ ...inputStyle, width: 150 }}>
              <option value="">All Status</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="approved">Approved</option>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
              <option value="rejected">Rejected</option>
            </select>
            <button onClick={loadBudgets} style={secondaryBtn}>Refresh</button>
            {!readOnly && <button onClick={() => setShowModal(true)} style={primaryBtn}>+ New Budget</button>}
          </div>

          {notice.msg ? (
            <div style={noticeStyle(notice.type)}>{notice.msg}</div>
          ) : null}

          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Budget', 'Status', 'FY', 'Department', 'Total Amount', 'Utilization', 'Revision', 'Actions'].map((h) => (
                    <th key={h} style={{ padding: '10px 12px', fontSize: 12, textAlign: 'left', color: '#374151', fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={8} style={{ padding: 28, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>Loading budgets...</td></tr>
                ) : listRows.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
                      <div style={{ padding: 36, textAlign: 'center' }}>
                        {isFiltered ? (
                          <>
                            <div style={{ fontSize: 14, color: '#374151', marginBottom: 10 }}>No budgets match the current filters.</div>
                            <button
                              onClick={() => { setFilters({ department: '', status: '' }); setGlobalFY(getCurrentFY()); }}
                              style={secondaryBtn}
                            >
                              Clear Filters
                            </button>
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: 14, color: '#374151', fontWeight: 600, marginBottom: 6 }}>No budgets created yet for FY {globalFY}</div>
                            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>Create your first budget to start tracking spend against targets.</div>
                            {!readOnly && <button onClick={() => setShowModal(true)} style={primaryBtn}>+ New Budget</button>}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : listRows.map((row, idx) => {
                  const st = String(row.status || '').toLowerCase();
                  return (
                    <tr key={row.id} style={{ borderTop: '1px solid #f3f4f6', background: idx % 2 === 0 ? '#fff' : '#fcfcff' }}>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: '#111827', fontWeight: 600 }}>{row.name}</td>
                      <td style={{ padding: '10px 12px' }}><StatusBadge status={row.status} /></td>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: '#4b5563' }}>{row.financial_year}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: '#4b5563' }}>{row.department || 'Unassigned'}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: '#111827', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>{formatINR(row.total_amount_num)}</td>
                      <td style={{ padding: '10px 12px', minWidth: 200 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 8, borderRadius: 999, background: '#ede9fe', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(row.utilization_pct_num, 100)}%`, height: '100%', background: utilizationColor(row.utilization_pct_num) }} />
                          </div>
                          <span style={{ fontSize: 12, color: utilizationColor(row.utilization_pct_num), fontWeight: 700, minWidth: 36 }}>
                            {Math.round(row.utilization_pct_num)}%
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ border: '1px solid #e9e4ff', background: '#f5f3ff', color: '#6d28d9', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 }}>
                          Rev {row.revision_count}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          {readOnly ? (
                            <span style={{ fontSize: 11, color: '#9ca3af' }}>View only</span>
                          ) : (<>
                          {st === 'draft' && (
                            <>
                              <button onClick={() => handleWorkflowAction(row.id, 'submit')} style={miniBtn}>Submit</button>
                              <button onClick={() => setEditBudget(row)} style={{ ...miniBtn, borderColor: '#bfdbfe', color: '#1d4ed8' }}>Edit</button>
                              <button onClick={() => setPendingHandleDeleteBudget(row.id)} style={{ ...miniBtn, borderColor: '#fecaca', color: '#b91c1c' }}>Delete</button>
                            </>
                          )}
                          {st === 'submitted' && canApprove && (
                            <>
                              <button onClick={() => handleWorkflowAction(row.id, 'approve')} style={{ ...miniBtn, borderColor: '#bbf7d0', color: '#15803d' }}>Approve</button>
                              <button onClick={() => handleWorkflowAction(row.id, 'reject')} style={{ ...miniBtn, borderColor: '#fecaca', color: '#b91c1c' }}>Reject</button>
                            </>
                          )}
                          {st === 'submitted' && !canApprove && (
                            <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>Awaiting approval</span>
                          )}
                          {st === 'approved' && (
                            <>
                              <button onClick={() => handleWorkflowAction(row.id, 'activate')} style={{ ...miniBtn, borderColor: '#bfdbfe', color: '#1d4ed8' }}>Activate</button>
                              <button onClick={() => handleRevise(row.id)} style={miniBtn}>Revise</button>
                            </>
                          )}
                          {st === 'active' && (
                            <>
                              <button onClick={() => handleWorkflowAction(row.id, 'close')} style={miniBtn}>Close</button>
                              <button onClick={() => handleRevise(row.id)} style={miniBtn}>Revise</button>
                            </>
                          )}
                          {st === 'closed' && (
                            <button onClick={() => handleCloneNextFY(row)} style={{ ...miniBtn, borderColor: '#a5f3fc', color: '#0369a1' }}>Clone for Next FY</button>
                          )}
                          {st === 'rejected' && (
                            <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>Rejected</span>
                          )}
                          </>)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {(showModal || editBudget) && (
            <NewBudgetModal
              onClose={() => { setShowModal(false); setEditBudget(null); }}
              onSave={handleSaveBudget}
              saving={saving}
              departments={departments}
              fyOptions={fyOptions}
              initial={editBudget}
            />
          )}
        </div>
      )}

      {/* ── TAB 1: vs Actuals ─────────────────────────────────────────────── */}
      {activeTab === 1 && (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <FYSelect value={globalFY} onChange={setGlobalFY} fyOptions={fyOptions} />
            <DeptSelect value={actualsFilters.department} onChange={(v) => setActualsFilters((p) => ({ ...p, department: v }))} departments={departments} />
            <button onClick={loadActuals} style={secondaryBtn}>Refresh</button>
          </div>

          {actualsLoading ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#6b7280', fontSize: 13 }}>Loading actuals data...</div>
          ) : !actualsData ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#6b7280', fontSize: 13 }}>No actuals data available for the selected period.</div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
                {[
                  { label: 'Total Budgeted',      value: formatINR(actualsData.summary?.total_budgeted ?? 0),       color: '#111827' },
                  { label: 'Total Actual Spend',  value: formatINR(actualsData.summary?.total_actual ?? 0),         color: '#111827' },
                  { label: 'Total Variance',      value: formatINR(actualsData.summary?.total_variance ?? 0),       color: (actualsData.summary?.total_variance ?? 0) >= 0 ? '#15803d' : '#dc2626' },
                  { label: 'Overall Utilization', value: `${actualsData.summary?.overall_utilization ?? 0}%`,       color: utilizationColor(actualsData.summary?.overall_utilization ?? 0) },
                ].map((card) => (
                  <div key={card.label} style={{ background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4', padding: '12px 14px' }}>
                    <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{card.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: card.color }}>{card.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', background: '#f5f3ff' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Department Breakdown</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9f8ff' }}>
                      {['Department', 'Budgeted', 'Actual', 'Variance', 'Utilization'].map((h) => (
                        <th key={h} style={{ padding: '9px 12px', fontSize: 12, textAlign: h === 'Department' ? 'left' : 'right', color: '#374151', fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(actualsData.by_department ?? []).length === 0 ? (
                      <tr><td colSpan={5} style={{ padding: 20, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No department data available.</td></tr>
                    ) : (actualsData.by_department ?? []).map((row, idx) => {
                      const pct      = Number(row.utilization_pct) || 0;
                      const variance = Number(row.variance) || 0;
                      return (
                        <tr key={`dept-${idx}`} style={{ borderTop: '1px solid #f3f4f6', background: idx % 2 === 0 ? '#fff' : '#fcfcff' }}>
                          <td style={{ padding: '10px 12px', fontSize: 13, color: '#111827', fontWeight: 600 }}>{row.department || 'Unassigned'}</td>
                          <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{formatINR(row.budgeted)}</td>
                          <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{formatINR(row.actual)}</td>
                          <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, color: variance >= 0 ? '#15803d' : '#dc2626' }}>{formatINR(variance)}</td>
                          <td style={{ padding: '10px 12px', minWidth: 150 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ flex: 1, height: 6, borderRadius: 999, background: '#ede9fe', overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: utilizationColor(pct) }} />
                              </div>
                              <span style={{ fontSize: 11, fontWeight: 700, color: utilizationColor(pct), minWidth: 36 }}>{pct}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {(actualsData.by_category ?? []).length > 0 && (
                <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
                  <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', background: '#f5f3ff' }}>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Category Breakdown</span>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f9f8ff' }}>
                        {['Category', 'Budgeted', 'Actual', 'Variance'].map((h) => (
                          <th key={h} style={{ padding: '9px 12px', fontSize: 12, textAlign: h === 'Category' ? 'left' : 'right', color: '#374151', fontWeight: 700 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(actualsData.by_category ?? []).map((row, idx) => {
                        const variance = Number(row.variance) || 0;
                        return (
                          <tr key={`cat-${idx}`} style={{ borderTop: '1px solid #f3f4f6', background: idx % 2 === 0 ? '#fff' : '#fcfcff' }}>
                            <td style={{ padding: '10px 12px', fontSize: 13, color: '#111827', fontWeight: 600 }}>{row.category || 'Uncategorized'}</td>
                            <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{formatINR(row.budgeted)}</td>
                            <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{formatINR(row.actual)}</td>
                            <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, color: variance >= 0 ? '#15803d' : '#dc2626' }}>{formatINR(variance)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {(actualsData.alerts ?? []).length > 0 && (
                <div style={{ background: '#fff', border: '1px solid #fee2e2', borderRadius: 12, padding: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#b91c1c', marginBottom: 10 }}>High Utilization Alerts</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {actualsData.alerts.map((a, idx) => (
                      <div key={`alert-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', background: '#fff7f7', border: '1px solid #fecaca', borderRadius: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: a.severity === 'critical' ? '#b91c1c' : '#b45309' }}>{String(a.severity || 'warning').toUpperCase()}</span>
                        <span style={{ fontSize: 13, color: '#111827', flex: 1 }}>{a.department || 'Unknown'}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: utilizationColor(Number(a.utilization_pct)) }}>{Number(a.utilization_pct ?? 0).toFixed(1)}% utilized</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── TAB 2: Forecast ───────────────────────────────────────────────── */}
      {activeTab === 2 && (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <FYSelect value={globalFY} onChange={setGlobalFY} fyOptions={fyOptions} />
            <DeptSelect value={forecastFilters.department} onChange={(v) => setForecastFilters((p) => ({ ...p, department: v }))} departments={departments} />
            <button onClick={loadForecast} style={secondaryBtn}>Generate Forecast</button>
          </div>

          {forecastNotice ? <div style={noticeStyle('info')}>{forecastNotice}</div> : null}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginBottom: 14 }}>
            {[
              { label: 'Budgeted Total',      value: forecastData.total_budgeted,             color: '#111827' },
              { label: 'Actual To Date',       value: forecastData.actual_to_date,             color: '#111827' },
              { label: 'Projected Remaining', value: forecastData.projected_remaining_total,  color: '#111827' },
              { label: 'Annual Forecast',      value: forecastData.annual_forecast,            color: '#111827' },
              { label: 'Variance vs Budget',  value: forecastData.forecast_variance_vs_budget, color: forecastData.forecast_variance_vs_budget >= 0 ? '#15803d' : '#b91c1c' },
            ].map((item) => (
              <div key={item.label} style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{item.label}</div>
                <div style={{ fontSize: 20, color: item.color, fontWeight: 800 }}>{formatINR(item.value)}</div>
              </div>
            ))}
          </div>

          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 14, marginBottom: 14 }}>
            <div style={{ marginBottom: 10, fontSize: 13, color: '#374151', fontWeight: 700 }}>Forecast Waterfall</div>
            {forecastLoading ? <div style={{ color: '#6b7280', fontSize: 13 }}>Loading forecast...</div> : (
              <div style={{ display: 'grid', gap: 8 }}>
                {[
                  { label: 'Budgeted Total',      value: forecastData.total_budgeted,            color: '#6B3FDB' },
                  { label: 'Actual To Date',       value: forecastData.actual_to_date,            color: '#4338ca' },
                  { label: 'Projected Remaining', value: forecastData.projected_remaining_total, color: '#0ea5e9' },
                  { label: 'Annual Forecast',      value: forecastData.annual_forecast,           color: '#111827' },
                ].map((bar) => {
                  const base = Math.max(forecastData.total_budgeted, forecastData.annual_forecast, 1);
                  const pct  = Math.max(2, Math.min(100, (bar.value / base) * 100));
                  return (
                    <div key={bar.label}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#4b5563', marginBottom: 4 }}>
                        <span>{bar.label}</span><span style={{ fontWeight: 700 }}>{formatINR(bar.value)}</span>
                      </div>
                      <div style={{ height: 12, borderRadius: 999, background: '#ede9fe', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pct}%`, background: bar.color }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  <th style={{ padding: '10px 12px', fontSize: 12, textAlign: 'left',  color: '#374151', fontWeight: 700 }}>Month</th>
                  <th style={{ padding: '10px 12px', fontSize: 12, textAlign: 'right', color: '#374151', fontWeight: 700 }}>Actual</th>
                  <th style={{ padding: '10px 12px', fontSize: 12, textAlign: 'right', color: '#374151', fontWeight: 700 }}>Projected</th>
                </tr>
              </thead>
              <tbody>
                {forecastLoading ? (
                  <tr><td colSpan={3} style={{ padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>Loading monthly forecast...</td></tr>
                ) : forecastRows.length === 0 ? (
                  <tr><td colSpan={3} style={{ padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No monthly forecast data available.</td></tr>
                ) : forecastRows.map((row, idx) => (
                  <tr key={row.month} style={{ borderTop: '1px solid #f3f4f6', background: idx % 2 === 0 ? '#fff' : '#fcfcff' }}>
                    <td style={{ padding: '10px 12px', fontSize: 13, color: '#111827', fontWeight: 600 }}>{row.month}</td>
                    <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{row.actual > 0 ? formatINR(row.actual) : '-'}</td>
                    <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{row.projected > 0 ? formatINR(row.projected) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>As-of date: {forecastData.as_of_date}. Monthly actual values are evenly derived from actual-to-date.</div>
        </div>
      )}

      {/* ── TAB 3: Variance Analysis ──────────────────────────────────────── */}
      {activeTab === 3 && (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <FYSelect value={globalFY} onChange={setGlobalFY} fyOptions={fyOptions} />
            <DeptSelect value={varianceFilters.department} onChange={(v) => setVarianceFilters((p) => ({ ...p, department: v }))} departments={departments} />
            <button onClick={loadVarianceAnalysis} style={secondaryBtn}>Refresh Analysis</button>
          </div>

          {varianceNotice ? <div style={noticeStyle('info')}>{varianceNotice}</div> : null}

          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Budget Line', 'Budget Amount', 'Actual', 'Variance Amount', 'Variance %', 'Root Cause', 'Overspend'].map((h) => (
                    <th key={h} style={{ padding: '10px 12px', fontSize: 12, textAlign: h === 'Budget Line' || h === 'Root Cause' || h === 'Overspend' ? 'left' : 'right', color: '#374151', fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {varianceLoading ? (
                  <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>Loading variance analysis...</td></tr>
                ) : varianceData.rows.length === 0 ? (
                  <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No variance rows found for current filters.</td></tr>
                ) : varianceData.rows.map((row, idx) => {
                  const root = String(row.root_cause_category || '').toLowerCase();
                  const rootBadge = root.includes('price')
                    ? { bg: '#dbeafe', color: '#1d4ed8', label: 'Price Variance' }
                    : root.includes('volume')
                      ? { bg: '#fef3c7', color: '#b45309', label: 'Volume Variance' }
                      : { bg: '#f5f3ff', color: '#6d28d9', label: 'Timing Variance' };
                  return (
                    <tr
                      key={`${row.budget_id}-${row.category}-${idx}`}
                      style={{ borderTop: '1px solid #f3f4f6', background: idx % 2 === 0 ? '#fff' : '#fcfcff', cursor: 'pointer' }}
                      onClick={() => setSelectedVarianceRow(row)}
                    >
                      <td style={{ padding: '10px 12px', fontSize: 13, color: '#111827', fontWeight: 600 }}>
                        <div>{row.category || row.budget_name || 'Uncategorized'}</div>
                        <div style={{ marginTop: 2, fontSize: 11, color: '#6b7280' }}>{row.department || 'All Departments'}</div>
                      </td>
                      <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{formatINR(row.budget_amount)}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{formatINR(row.actual_amount)}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: row.variance_amount >= 0 ? '#15803d' : '#b91c1c', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>{formatINR(row.variance_amount)}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: row.variance_pct >= 0 ? '#15803d' : '#b91c1c', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>{row.variance_pct.toFixed(2)}%</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ background: rootBadge.bg, color: rootBadge.color, borderRadius: 999, fontSize: 12, fontWeight: 700, padding: '4px 10px' }}>{rootBadge.label}</span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {row.overspend_flag
                          ? <span style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 999, fontSize: 12, fontWeight: 700, padding: '4px 10px' }}>Overspend</span>
                          : <span style={{ background: '#dcfce7', color: '#15803d', borderRadius: 999, fontSize: 12, fontWeight: 700, padding: '4px 10px' }}>Within Limit</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selectedVarianceRow && (
            <div style={{ marginTop: 14, background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid #f3f4f6', background: '#f5f3ff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>Variance Drill-down</div>
                <button onClick={() => setSelectedVarianceRow(null)} style={{ border: 'none', background: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
              </div>
              <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                {[
                  { label: 'Budget',         value: selectedVarianceRow.budget_name },
                  { label: 'Category',       value: selectedVarianceRow.category },
                  { label: 'Department',     value: selectedVarianceRow.department },
                  { label: 'Budget Amount',  value: formatINR(selectedVarianceRow.budget_amount) },
                  { label: 'Actual Amount',  value: formatINR(selectedVarianceRow.actual_amount) },
                  { label: 'Variance',       value: `${formatINR(selectedVarianceRow.variance_amount)} (${selectedVarianceRow.variance_pct.toFixed(2)}%)`, color: selectedVarianceRow.variance_amount >= 0 ? '#15803d' : '#b91c1c' },
                ].map((item) => (
                  <div key={item.label} style={{ border: '1px solid #ede9fe', borderRadius: 10, padding: 10, background: '#fff' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: item.color || '#111827' }}>{item.value || '-'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB 4: Cash Flow Projection ───────────────────────────────────── */}
      {activeTab === 4 && (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14, alignItems: 'center' }}>
            <FYSelect value={globalFY} onChange={setGlobalFY} fyOptions={fyOptions} />
            <DeptSelect value={cashflowFilters.department} onChange={(v) => setCashflowFilters((p) => ({ ...p, department: v }))} departments={departments} />
            <input type="number" value={cashflowFilters.opening_cash_balance} onChange={(e) => setCashflowFilters((p) => ({ ...p, opening_cash_balance: e.target.value }))} style={{ ...inputStyle, width: 170 }} placeholder="Opening Cash Balance" />
            <input type="number" value={cashflowFilters.minimum_cash_balance} onChange={(e) => setCashflowFilters((p) => ({ ...p, minimum_cash_balance: e.target.value }))} style={{ ...inputStyle, width: 180 }} placeholder="Minimum Cash Balance" />
            <button onClick={loadCashflowProjection} style={secondaryBtn}>Run Projection</button>
          </div>

          {cashflowNotice ? <div style={noticeStyle('info')}>{cashflowNotice}</div> : null}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginBottom: 14 }}>
            {[
              { label: 'Opening Cash Balance',    value: cashflowData.metadata.opening_cash_balance },
              { label: 'Minimum Cash Threshold',  value: cashflowData.metadata.minimum_cash_balance },
              { label: 'Total Budgeted (FY)',      value: cashflowData.metadata.total_budgeted },
              { label: 'Recent Avg Outflow',       value: cashflowData.metadata.last_3_month_average_outflow },
            ].map((card) => (
              <div key={card.label} style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 12 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>{card.label}</div>
                <div style={{ fontSize: 20, color: '#111827', fontWeight: 800 }}>{formatINR(card.value)}</div>
              </div>
            ))}
          </div>

          <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, overflow: 'hidden', marginBottom: 14 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f5f3ff' }}>
                  {['Month', 'Inflow', 'Outflow', 'Net Movement', 'Net Cash Position', 'Risk'].map((h) => (
                    <th key={h} style={{ padding: '10px 12px', fontSize: 12, textAlign: h === 'Month' || h === 'Risk' ? 'left' : 'right', color: '#374151', fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cashflowLoading ? (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>Loading cashflow projection...</td></tr>
                ) : cashflowData.monthly_projection.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>No projection rows available.</td></tr>
                ) : cashflowData.monthly_projection.map((row, idx) => {
                  const belowMinimum = row.net_cash_position < cashflowData.metadata.minimum_cash_balance;
                  const belowZero    = row.net_cash_position < 0;
                  return (
                    <tr key={`${row.year}-${row.month}-${idx}`} style={{ borderTop: '1px solid #f3f4f6', background: belowZero ? '#fef2f2' : (belowMinimum ? '#fff7ed' : (idx % 2 === 0 ? '#fff' : '#fcfcff')) }}>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: '#111827', fontWeight: 600 }}>{row.month_label}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{formatINR(row.inflow)}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap' }}>{formatINR(row.outflow)}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: row.net_movement >= 0 ? '#15803d' : '#b91c1c', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>{formatINR(row.net_movement)}</td>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: belowZero ? '#b91c1c' : (belowMinimum ? '#b45309' : '#111827'), textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>{formatINR(row.net_cash_position)}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {belowZero
                          ? <span style={{ background: '#fee2e2', color: '#b91c1c', borderRadius: 999, fontSize: 12, fontWeight: 700, padding: '4px 10px' }}>Negative Cash</span>
                          : belowMinimum
                            ? <span style={{ background: '#fef3c7', color: '#b45309', borderRadius: 999, fontSize: 12, fontWeight: 700, padding: '4px 10px' }}>Below Minimum</span>
                            : <span style={{ background: '#dcfce7', color: '#15803d', borderRadius: 999, fontSize: 12, fontWeight: 700, padding: '4px 10px' }}>Healthy</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Assumption Metadata</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>As of: {cashflowData.metadata.as_of_date}</div>
              {cashflowData.metadata.assumptions.length === 0
                ? <div style={{ fontSize: 12, color: '#6b7280' }}>No assumptions provided by API.</div>
                : <ul style={{ margin: 0, paddingLeft: 18, color: '#4b5563', fontSize: 12, lineHeight: 1.5 }}>{cashflowData.metadata.assumptions.map((item, idx) => <li key={`assumption-${idx}`}>{item}</li>)}</ul>
              }
            </div>
            <div style={{ background: '#fff', border: '1px solid #f0f0f4', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Alerts</div>
              {cashflowData.alerts.length === 0
                ? <div style={{ fontSize: 12, color: '#15803d', fontWeight: 700 }}>No cash shortfall alerts.</div>
                : <div style={{ display: 'grid', gap: 8 }}>
                    {cashflowData.alerts.map((alert, idx) => (
                      <div key={`alert-${alert.month_label}-${idx}`} style={{ border: '1px solid #fee2e2', background: '#fff7f7', borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: alert.severity === 'critical' ? '#b91c1c' : '#b45309' }}>{alert.month_label} - {String(alert.severity || 'warning').toUpperCase()}</div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Net: {formatINR(alert.net_cash_position)} | Shortfall: {formatINR(alert.shortfall)}</div>
                      </div>
                    ))}
                  </div>
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle = {
  border: '1px solid #e9e4ff',
  background: '#fff',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 13,
  color: '#111827',
  outline: 'none',
};

const labelStyle = {
  fontSize: 12,
  color: '#6b7280',
  fontWeight: 600,
  marginBottom: 4,
  display: 'block',
};

const primaryBtn = {
  border: 'none',
  borderRadius: 8,
  padding: '8px 12px',
  background: '#6B3FDB',
  color: '#fff',
  fontWeight: 700,
  fontSize: 13,
  cursor: 'pointer',
};

const secondaryBtn = {
  border: '1px solid #e9e4ff',
  borderRadius: 8,
  padding: '8px 12px',
  background: '#fff',
  color: '#374151',
  fontWeight: 600,
  fontSize: 13,
  cursor: 'pointer',
};

const miniBtn = {
  border: '1px solid #e9e4ff',
  borderRadius: 8,
  padding: '5px 8px',
  background: '#fff',
  color: '#374151',
  fontWeight: 600,
  fontSize: 11,
  cursor: 'pointer',
};
