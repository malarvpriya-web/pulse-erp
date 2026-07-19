import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CheckSquare, Square, ChevronDown, ChevronUp, AlertCircle, Download, Bell, Users } from 'lucide-react';
import api from '@/services/api/client';
import { exportCSV } from '@/features/_shared/exportUtils';
import ConfirmDialog from '@/components/core/ConfirmDialog';

const DEFAULT_TEMPLATE = [
  { category: 'IT & Access',    item_label: 'Revoke system access',                   default_assignee: 'IT' },
  { category: 'IT & Access',    item_label: 'Collect company laptop/devices',          default_assignee: 'IT' },
  { category: 'IT & Access',    item_label: 'Delete email account',                   default_assignee: 'IT' },
  { category: 'IT & Access',    item_label: 'Revoke VPN access',                      default_assignee: 'IT' },
  { category: 'IT & Access',    item_label: 'Deactivate Slack/Teams account',         default_assignee: 'IT' },
  { category: 'IT & Access',    item_label: 'Remove from email distribution lists',   default_assignee: 'IT' },
  { category: 'HR & Payroll',   item_label: 'Process final settlement',               default_assignee: 'Finance' },
  { category: 'HR & Payroll',   item_label: 'Issue experience letter',                default_assignee: 'HR' },
  { category: 'HR & Payroll',   item_label: 'Complete tax documents (Form 16)',       default_assignee: 'Finance' },
  { category: 'Finance',        item_label: 'Settle pending advances',               default_assignee: 'Finance' },
  { category: 'Finance',        item_label: 'Process leave encashment',              default_assignee: 'Finance' },
  { category: 'Finance',        item_label: 'Generate final payslip',               default_assignee: 'Finance' },
  { category: 'Assets',         item_label: 'Return access cards/ID badge',         default_assignee: 'Admin' },
  { category: 'Assets',         item_label: 'Return keys/locker',                   default_assignee: 'Admin' },
  { category: 'Documents',      item_label: 'Issue relieving letter',               default_assignee: 'HR' },
  { category: 'Documents',      item_label: 'Issue NOC if applicable',             default_assignee: 'HR' },
  { category: 'Exit Interview', item_label: 'Exit interview conducted',             default_assignee: 'HR' },
  { category: 'Exit Interview', item_label: 'Record exit feedback',                default_assignee: 'HR' },
  { category: 'Manager',        item_label: 'Handover of ongoing projects',        default_assignee: 'Manager' },
  { category: 'Manager',        item_label: 'Knowledge transfer session completed', default_assignee: 'Manager' },
];

const ASSIGNEES = ['HR', 'IT', 'Finance', 'Manager', 'Admin'];

// ── helpers ───────────────────────────────────────────────────────────────────
const ymd = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const fmtDate = (v) => {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const isOverdue = (item) =>
  !item.done && item.due_date && new Date(item.due_date) < new Date(new Date().toDateString());

// ── component ─────────────────────────────────────────────────────────────────
export default function Offboarding({ setPage }) {
  const [employees,        setEmployees]        = useState([]);
  const [loading,          setLoading]          = useState(false);
  const [error,            setError]            = useState(null);
  const [selectedEmp,      setSelectedEmp]      = useState(null);
  const [checklist,        setChecklist]        = useState([]);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [expanded,         setExpanded]         = useState({});
  const [templateRows,     setTemplateRows]     = useState([]);
  const [templateForm,     setTemplateForm]     = useState({ category: '', item_label: '', default_assignee: 'HR' });
  const [templateDupe,     setTemplateDupe]     = useState(false);
  const [showTemplate,     setShowTemplate]     = useState(false);
  const [saving,           setSaving]           = useState(false);
  const [completing,       setCompleting]       = useState(false);
  const [toast,            setToast]            = useState(null);
  const [pendingMarkComplete, setPendingMarkComplete] = useState(false);

  const isMounted     = useRef(true);
  const toastTimer    = useRef(null);
  const autoSaveTimer = useRef(null);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      clearTimeout(toastTimer.current);
      clearTimeout(autoSaveTimer.current);
    };
  }, []);

  // stable toast — clears any previous timer before setting a new one
  const showToast = useCallback((msg, type = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ msg, type });
    toastTimer.current = setTimeout(() => {
      if (isMounted.current) setToast(null);
    }, 3000);
  }, []);

  // ── data fetching ───────────────────────────────────────────────────────────
  const fetchEmployees = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/hr/offboarding');
      if (!isMounted.current) return;
      const data = res.data;
      setEmployees(Array.isArray(data) ? data : (data?.results ?? []));
    } catch (err) {
      if (!isMounted.current) return;
      setError(err.response?.data?.error || err.message || 'Failed to load offboarding employees');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  const fetchTemplate = useCallback(async () => {
    try {
      const res = await api.get('/hr/offboarding/templates');
      if (!isMounted.current) return;
      const rows = Array.isArray(res.data) && res.data.length ? res.data : DEFAULT_TEMPLATE;
      setTemplateRows(rows.map((r) => ({
        category:         r.category,
        item_label:       r.item_label,
        default_assignee: r.default_assignee || 'HR',
      })));
    } catch {
      if (isMounted.current) setTemplateRows(DEFAULT_TEMPLATE);
    }
  }, []);

  useEffect(() => { fetchEmployees(); fetchTemplate(); }, [fetchEmployees, fetchTemplate]);

  // ── derived checklist state ─────────────────────────────────────────────────
  const groupedChecklist = useMemo(() => {
    const map = {};
    checklist.forEach((item) => {
      if (!map[item.category]) map[item.category] = [];
      map[item.category].push(item);
    });
    return map;
  }, [checklist]);

  const categories = useMemo(() => Object.keys(groupedChecklist), [groupedChecklist]);
  const totalItems = checklist.length;
  const doneItems  = checklist.filter((i) => i.done).length;
  const pct        = totalItems ? Math.round((doneItems / totalItems) * 100) : 0;

  // ── checklist actions ───────────────────────────────────────────────────────
  const selectEmp = async (emp) => {
    setChecklistLoading(true);
    setSelectedEmp(emp);
    setChecklist([]);
    try {
      const res = await api.get(`/hr/offboarding/${emp.id}/checklist`);
      if (!isMounted.current) return;
      const rows   = Array.isArray(res.data) ? res.data : [];
      const chosen = rows.length ? rows : templateRows.map((t) => ({
        ...t,
        done:           false,
        assignee:       t.default_assignee || 'HR',
        due_date:       emp.exit_date || emp.last_day || null,
        handover_notes: '',
        completed_at:   null,
      }));
      setChecklist(chosen);
      const exp = {};
      chosen.forEach((r) => { exp[r.category] = true; });
      setExpanded(exp);
    } catch {
      if (!isMounted.current) return;
      showToast('Unable to load checklist', 'error');
    } finally {
      if (isMounted.current) setChecklistLoading(false);
    }
  };

  // saveChecklist is stable — recreated only when selectedEmp changes
  const saveChecklist = useCallback(async (rows, quiet = false) => {
    if (!selectedEmp?.id) return;
    if (!quiet) setSaving(true);
    try {
      await api.patch(`/hr/offboarding/${selectedEmp.id}/checklist`, { items: rows });
      if (!isMounted.current) return;
      if (!quiet) showToast('Checklist saved');
    } catch {
      if (!isMounted.current) return;
      if (!quiet) showToast('Failed to save checklist', 'error');
    } finally {
      if (!quiet && isMounted.current) setSaving(false);
    }
  }, [selectedEmp, showToast]);

  // debounced auto-save — fires 600 ms after last field change
  const updateItem = useCallback((idx, patch) => {
    setChecklist((prev) => {
      const next = prev.map((x, i) => (i === idx ? { ...x, ...patch } : x));
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = setTimeout(() => saveChecklist(next, true), 600);
      return next;
    });
  }, [saveChecklist]);

  const goBack = () => {
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = null;
    setSelectedEmp(null);
    setChecklist([]);
    setExpanded({});
  };

  const markComplete = async () => {
    if (!selectedEmp?.id) return;
    if (!pendingMarkComplete) return;
    setPendingMarkComplete(false);
    setCompleting(true);
    try {
      await api.post(`/hr/offboarding/${selectedEmp.id}/complete`);
      if (!isMounted.current) return;
      showToast('Offboarding complete — employee moved to Ex-Employees');
      setSelectedEmp(null);
      setChecklist([]);
      fetchEmployees();
    } catch (err) {
      if (!isMounted.current) return;
      showToast(err.response?.data?.error || 'Failed to complete offboarding', 'error');
    } finally {
      if (isMounted.current) setCompleting(false);
    }
  };

  const notifyAssignee = async (assignee) => {
    if (!selectedEmp?.id) return;
    try {
      await api.post(`/hr/offboarding/${selectedEmp.id}/checklist/notify`, { assignee });
      if (!isMounted.current) return;
      showToast(`Notification sent to ${assignee}`);
    } catch {
      if (!isMounted.current) return;
      showToast('Notification failed', 'error');
    }
  };

  // ── template actions ────────────────────────────────────────────────────────
  const addTemplateItem = () => {
    const cat  = templateForm.category.trim();
    const item = templateForm.item_label.trim();
    if (!cat || !item) return;
    const isDupe = templateRows.some((r) => r.category === cat && r.item_label === item);
    if (isDupe) {
      setTemplateDupe(true);
      setTimeout(() => { if (isMounted.current) setTemplateDupe(false); }, 2500);
      return;
    }
    setTemplateRows((p) => [
      ...p,
      { category: cat, item_label: item, default_assignee: templateForm.default_assignee || 'HR' },
    ]);
    setTemplateForm((f) => ({ ...f, item_label: '' }));
    setTemplateDupe(false);
  };

  const saveTemplate = async () => {
    try {
      await api.put('/hr/offboarding/templates', { items: templateRows });
      if (!isMounted.current) return;
      showToast('Checklist template saved');
      setShowTemplate(false);
    } catch {
      if (!isMounted.current) return;
      showToast('Unable to save template', 'error');
    }
  };

  const handleExport = () => exportCSV(employees, 'offboarding', {
    employee_id:   'Employee ID',
    employee_name: 'Name',
    department:    'Department',
    last_day:      'Last Day',
    checklist_pct: 'Checklist %',
    status:        'Status',
  });

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px', maxWidth: 960, margin: '0 auto' }}>
      <ConfirmDialog
        open={pendingMarkComplete}
        title="Complete Offboarding"
        message={selectedEmp ? `Mark ${selectedEmp.name || selectedEmp.employee_name}'s offboarding as complete? This will move them to Ex-Employees.` : ''}
        confirmLabel="Complete"
        variant="warning"
        onConfirm={markComplete}
        onCancel={() => setPendingMarkComplete(false)}
      />

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          padding: '10px 14px 10px 16px', borderRadius: 8, fontWeight: 600, fontSize: 12,
          boxShadow: '0 4px 14px rgba(0,0,0,.14)', display: 'flex', alignItems: 'center', gap: 10,
          color:      toast.type === 'error' ? '#b91c1c' : '#166534',
          background: toast.type === 'error' ? '#fee2e2' : '#dcfce7',
        }}>
          {toast.msg}
          <button
            onClick={() => { clearTimeout(toastTimer.current); setToast(null); }}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', fontSize: 16, lineHeight: 1, padding: 0 }}
          >×</button>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111827' }}>Offboarding</h2>
          {!selectedEmp && !loading && (
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              {employees.length > 0
                ? `${employees.length} employee${employees.length !== 1 ? 's' : ''} in offboarding process`
                : 'No active offboardings'}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {!selectedEmp && (
            <button
              onClick={() => setPage?.('ExitManagement')}
              style={{ border: 'none', background: '#6366f1', color: '#fff', borderRadius: 6, padding: '7px 14px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
            >
              + Initiate Offboarding
            </button>
          )}
          <button
            onClick={() => setShowTemplate((s) => !s)}
            style={{ border: '1px solid #e5e7eb', background: showTemplate ? '#f3f4f6' : '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer', color: '#374151' }}
          >
            Template Config
          </button>
          {!selectedEmp && (
            <button
              onClick={handleExport}
              disabled={employees.length === 0}
              style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #e5e7eb', background: '#fff', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: employees.length ? 'pointer' : 'not-allowed', opacity: employees.length ? 1 : 0.55, color: '#374151' }}
            >
              <Download size={13} /> Export CSV
            </button>
          )}
        </div>
      </div>

      {/* Template Config panel */}
      {showTemplate && (
        <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #e5e7eb', padding: 14, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>
              Checklist Template
              <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>({templateRows.length} items)</span>
            </span>
            <button
              onClick={() => setTemplateRows(DEFAULT_TEMPLATE)}
              style={{ border: '1px solid #e5e7eb', background: '#f9fafb', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: '#374151' }}
            >
              Reset to Defaults
            </button>
          </div>

          {/* Add row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 2fr 1fr auto', gap: 8 }}>
            <input
              value={templateForm.category}
              onChange={(e) => setTemplateForm((f) => ({ ...f, category: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && addTemplateItem()}
              placeholder="Category"
              style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12 }}
            />
            <input
              value={templateForm.item_label}
              onChange={(e) => { setTemplateDupe(false); setTemplateForm((f) => ({ ...f, item_label: e.target.value })); }}
              onKeyDown={(e) => e.key === 'Enter' && addTemplateItem()}
              placeholder="Checklist item description"
              style={{ padding: '7px 10px', border: templateDupe ? '1px solid #f87171' : '1px solid #d1d5db', borderRadius: 8, fontSize: 12 }}
            />
            <select
              value={templateForm.default_assignee}
              onChange={(e) => setTemplateForm((f) => ({ ...f, default_assignee: e.target.value }))}
              style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 12 }}
            >
              {ASSIGNEES.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <button
              onClick={addTemplateItem}
              style={{ border: 'none', background: '#6B3FDB', color: '#fff', borderRadius: 8, padding: '7px 14px', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
            >
              Add
            </button>
          </div>
          {templateDupe && (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#b91c1c' }}>This item already exists in the template.</p>
          )}

          {/* Item list */}
          <div style={{ marginTop: 10, maxHeight: 220, overflowY: 'auto', border: '1px solid #f3f4f6', borderRadius: 8 }}>
            {templateRows.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: '#9ca3af' }}>
                No items — click "Reset to Defaults" to seed the standard template.
              </div>
            ) : templateRows.map((r, i) => (
              <div
                key={`${r.category}-${r.item_label}-${i}`}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 10px', borderBottom: '1px solid #f3f4f6', background: i % 2 === 0 ? '#fff' : '#fafafa' }}
              >
                <span style={{ fontSize: 12, color: '#374151' }}>
                  <span style={{ color: '#6b7280', fontWeight: 500 }}>{r.category}</span>
                  {' | '}
                  {r.item_label}
                  {' '}
                  <span style={{ color: '#9ca3af', fontSize: 11 }}>({r.default_assignee})</span>
                </span>
                <button
                  onClick={() => setTemplateRows((p) => p.filter((_, j) => j !== i))}
                  title="Remove item"
                  style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#b91c1c', fontSize: 16, padding: '0 4px', flexShrink: 0, lineHeight: 1 }}
                >✕</button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button onClick={saveTemplate} style={{ border: 'none', background: '#0f766e', color: '#fff', borderRadius: 8, padding: '7px 16px', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
              Save Template
            </button>
            <button onClick={() => setShowTemplate(false)} style={{ border: '1px solid #e5e7eb', background: '#fff', borderRadius: 8, padding: '7px 12px', fontSize: 12, cursor: 'pointer', color: '#374151' }}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div style={{ background: '#fee2e2', color: '#dc2626', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <span>{error}</span>
          <button
            onClick={() => { setError(null); fetchEmployees(); }}
            style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 12, textDecoration: 'underline', flexShrink: 0 }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Employee List ─────────────────────────────────────────────────── */}
      {!selectedEmp && (
        <div style={{ display: 'grid', gap: 10 }}>
          {loading ? (
            <div style={{ background: '#f3f4f6', borderRadius: 10, padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 13 }}>
              Loading offboarding employees…
            </div>
          ) : employees.length === 0 ? (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '48px 24px', textAlign: 'center' }}>
              <Users size={40} color="#d1d5db" style={{ display: 'block', margin: '0 auto 14px' }} />
              <div style={{ fontWeight: 600, fontSize: 15, color: '#374151', marginBottom: 6 }}>No active offboardings</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 22 }}>
                All employees are currently active. Initiate an exit process to begin offboarding.
              </div>
              <button
                onClick={() => setPage?.('ExitManagement')}
                style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
              >
                + Initiate Offboarding
              </button>
            </div>
          ) : employees.map((emp) => {
            const pctDone  = emp.checklist_pct ?? 0;
            const started  = pctDone > 0;
            const empName  = emp.name || emp.employee_name || '-';
            return (
              <div key={emp.id} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '14px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{empName}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    {[emp.department, emp.designation].filter(Boolean).join(' · ')}
                    {' · Last day: '}
                    <strong style={{ color: '#374151' }}>{fmtDate(emp.exit_date || emp.last_day)}</strong>
                  </div>
                  {started && (
                    <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 160, background: '#f3f4f6', borderRadius: 99, height: 5, overflow: 'hidden' }}>
                        <div style={{ height: 5, background: pctDone === 100 ? '#10b981' : '#6366f1', width: `${pctDone}%`, transition: 'width 0.4s ease' }} />
                      </div>
                      <span style={{ fontSize: 11, color: '#6b7280' }}>{pctDone}% done</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={() => selectEmp(emp)}
                  style={{
                    background: started ? '#eff6ff' : '#6366f1',
                    color:      started ? '#1d4ed8' : '#fff',
                    border:     started ? '1px solid #bfdbfe' : 'none',
                    borderRadius: 8, padding: '7px 16px', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  {started ? 'Resume Checklist' : 'Start Checklist'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Checklist View ────────────────────────────────────────────────── */}
      {selectedEmp && (
        <>
          {/* Checklist header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>
                  {selectedEmp.name || selectedEmp.employee_name}
                </span>
                {selectedEmp.department && (
                  <span style={{ fontSize: 11, color: '#6b7280', background: '#f3f4f6', borderRadius: 4, padding: '2px 8px' }}>
                    {selectedEmp.department}
                  </span>
                )}
                {selectedEmp.status && (
                  <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: '#fef3c7', color: '#92400e', textTransform: 'capitalize' }}>
                    {selectedEmp.status}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                Last Day: <strong style={{ color: '#374151' }}>{fmtDate(selectedEmp.exit_date || selectedEmp.last_day)}</strong>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => saveChecklist(checklist)}
                disabled={saving || checklistLoading}
                style={{ border: 'none', background: '#0f766e', color: '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.7 : 1 }}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={goBack}
                style={{ border: '1px solid #e5e7eb', background: '#fff', borderRadius: 8, padding: '7px 12px', fontSize: 12, cursor: 'pointer', color: '#374151' }}
              >
                ← Back
              </button>
            </div>
          </div>

          {/* Progress bar */}
          {!checklistLoading && (
            <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '14px 16px', marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
                <span style={{ fontWeight: 600, color: '#374151' }}>Overall Progress</span>
                <span style={{ fontWeight: 700, color: pct === 100 ? '#059669' : '#6366f1' }}>
                  {doneItems}/{totalItems} ({pct}%)
                </span>
              </div>
              <div style={{ background: '#f3f4f6', borderRadius: 99, height: 8, overflow: 'hidden' }}>
                <div style={{ height: 8, background: pct === 100 ? '#10b981' : '#6366f1', width: `${pct}%`, transition: 'width 0.4s ease' }} />
              </div>
            </div>
          )}

          {/* Checklist loading spinner */}
          {checklistLoading ? (
            <div style={{ background: '#f3f4f6', borderRadius: 10, padding: 32, textAlign: 'center', color: '#6b7280', fontSize: 13, marginBottom: 16 }}>
              Loading checklist…
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              {categories.map((cat) => {
                const catItems = groupedChecklist[cat];
                const catDone  = catItems.filter((i) => i.done).length;
                const allDone  = catDone === catItems.length;
                return (
                  <div key={cat} style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                    <button
                      onClick={() => setExpanded((e) => ({ ...e, [cat]: !e[cat] }))}
                      style={{ width: '100%', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: '#111827' }}>{cat}</span>
                        <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 4, background: allDone ? '#dcfce7' : '#f3f4f6', color: allDone ? '#166534' : '#6b7280' }}>
                          {catDone}/{catItems.length}
                        </span>
                      </div>
                      {expanded[cat] ? <ChevronUp size={14} color="#9ca3af" /> : <ChevronDown size={14} color="#9ca3af" />}
                    </button>

                    {expanded[cat] && (
                      <div style={{ borderTop: '1px solid #f3f4f6', padding: '8px 16px 12px' }}>
                        {catItems.map((item) => {
                          const realIdx = checklist.findIndex(
                            (x) => x.category === item.category && x.item_label === item.item_label
                          );
                          const overdue = isOverdue(item);
                          return (
                            <div key={`${item.category}-${item.item_label}`} style={{ padding: '9px 0', borderBottom: '1px solid #f9fafb' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <button
                                  onClick={() => updateItem(realIdx, { done: !item.done })}
                                  style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}
                                >
                                  {item.done
                                    ? <CheckSquare size={16} color="#10b981" />
                                    : <Square size={16} color="#9ca3af" />}
                                </button>
                                <span style={{ fontSize: 13, flex: 1, textDecoration: item.done ? 'line-through' : 'none', color: item.done ? '#9ca3af' : '#111827' }}>
                                  {item.item_label}
                                </span>
                                {overdue && (
                                  <span style={{ fontSize: 11, color: '#b91c1c', background: '#fee2e2', borderRadius: 999, padding: '2px 8px', flexShrink: 0 }}>Overdue</span>
                                )}
                                {item.done && item.completed_at && (
                                  <span style={{ fontSize: 10, color: '#9ca3af', flexShrink: 0 }}>✓ {fmtDate(item.completed_at)}</span>
                                )}
                              </div>
                              <div style={{ display: 'grid', gridTemplateColumns: '140px 140px 1fr auto', gap: 8, marginTop: 8 }}>
                                <select
                                  value={item.assignee || 'HR'}
                                  onChange={(e) => updateItem(realIdx, { assignee: e.target.value })}
                                  style={{ padding: 6, borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12 }}
                                >
                                  {ASSIGNEES.map((a) => <option key={a} value={a}>{a}</option>)}
                                </select>
                                <input
                                  type="date"
                                  value={ymd(item.due_date)}
                                  onChange={(e) => updateItem(realIdx, { due_date: e.target.value || null })}
                                  style={{ padding: 6, borderRadius: 8, border: overdue ? '1px solid #f87171' : '1px solid #d1d5db', fontSize: 12 }}
                                />
                                <input
                                  value={item.handover_notes || ''}
                                  onChange={(e) => updateItem(realIdx, { handover_notes: e.target.value })}
                                  placeholder="Handover notes…"
                                  style={{ padding: 6, borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12 }}
                                />
                                <button
                                  onClick={() => notifyAssignee(item.assignee || 'HR')}
                                  title={`Notify ${item.assignee || 'HR'}`}
                                  style={{ border: '1px solid #e2e8f0', background: '#f8fafc', borderRadius: 8, padding: '6px 10px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', flexShrink: 0 }}
                                >
                                  <Bell size={12} /> Notify
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer status + complete button */}
          {!checklistLoading && totalItems > 0 && (
            <>
              {pct < 100 ? (
                <div style={{ background: '#fef3c7', borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, fontSize: 13, color: '#92400e' }}>
                  <AlertCircle size={14} />
                  {totalItems - doneItems} task{totalItems - doneItems !== 1 ? 's' : ''} remaining before offboarding can be completed
                </div>
              ) : (
                <div style={{ background: '#dcfce7', borderRadius: 8, padding: '10px 14px', display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, fontSize: 13, color: '#166534' }}>
                  <CheckSquare size={14} />
                  All tasks complete — ready to finalise offboarding
                </div>
              )}
              <button
                onClick={() => setPendingMarkComplete(true)}
                disabled={pct < 100 || completing}
                style={{
                  background: pct === 100 ? '#10b981' : '#d1d5db',
                  color: '#fff', border: 'none', borderRadius: 8,
                  padding: '10px 24px', fontWeight: 600, fontSize: 14,
                  cursor: pct === 100 && !completing ? 'pointer' : 'not-allowed',
                  opacity: completing ? 0.7 : 1,
                }}
              >
                {completing ? 'Completing…' : 'Mark Offboarding Complete'}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
