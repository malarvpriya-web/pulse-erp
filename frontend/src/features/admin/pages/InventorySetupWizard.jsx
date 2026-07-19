import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Package, Warehouse, RotateCw, BookOpen, CheckSquare,
  ChevronRight, ChevronLeft, Check, PlayCircle, CheckCircle,
  Star, X, Plus,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const P  = '#6B3FDB';
const PL = '#f5f3ff';
const PB = '#e9e4ff';

// warehouse_type value → checklist task index for the warehouse step
const TYPE_TASK_MAP = { raw_material: 0, finished_goods: 1, scrap: 2, sub_store: 3 };

const WH_PRESETS = [
  { label: 'Main Raw Material Store',    type: 'raw_material',   code: 'WH-RM-01' },
  { label: 'Finished Goods Warehouse',   type: 'finished_goods', code: 'WH-FG-01' },
  { label: 'Rejection / Scrap Bay',      type: 'scrap',          code: 'WH-SC-01' },
  { label: 'Sub-store (Prod Line 1)',    type: 'sub_store',      code: 'WH-SS-01' },
];

const WH_TYPES = [
  { value: 'raw_material',   label: 'Raw Material Store' },
  { value: 'finished_goods', label: 'Finished Goods Warehouse' },
  { value: 'scrap',          label: 'Rejection / Scrap Bay' },
  { value: 'sub_store',      label: 'Sub-store' },
  { value: 'bonded',         label: 'Bonded Warehouse' },
  { value: 'general',        label: 'General Store' },
];

const STEPS = [
  {
    id: 'warehouses',
    title: 'Create Warehouses',
    subtitle: 'Define your storage locations',
    icon: Warehouse,
    color: '#6B3FDB',
    desc: 'Set up your warehouse and storage structure. This includes main stores, sub-stores, bonded warehouses, finished goods stores, and scrap yards.',
    tasks: [
      'Create Main Raw Material Store',
      'Create Finished Goods Warehouse',
      'Create Rejection / Scrap Bay',
      'Create Sub-stores per production line',
      'Set bin and rack structure within each warehouse',
    ],
    page: 'WarehouseManagement',
    tip: 'Use a naming convention like WH-RM-01, WH-FG-01 to make warehouse codes self-explanatory.',
  },
  {
    id: 'categories',
    title: 'Configure Stock Categories',
    subtitle: 'Organize items by type and valuation method',
    icon: Package,
    color: '#0891b2',
    desc: 'Define item categories (Raw Material, WIP, Finished Goods, Consumables, Spares, Packaging) and assign valuation methods (FIFO, Weighted Average).',
    tasks: [
      'Define item category hierarchy',
      'Set valuation method per category (FIFO/WA)',
      'Configure UOM (unit of measure) list',
      'Set HSN/SAC codes for GST compliance',
      'Define ABC classification rules',
    ],
    page: 'ItemMaster',
    tip: 'GST compliance requires correct HSN codes. Map them at category level to auto-assign to new items.',
  },
  {
    id: 'reorder',
    title: 'Configure Reorder Rules',
    subtitle: 'Set safety stock and auto-PR triggers',
    icon: RotateCw,
    color: '#d97706',
    desc: 'Define reorder levels, safety stock, and maximum stock for each item category. Enable auto-PR generation when stock falls below reorder point.',
    tasks: [
      'Set minimum stock (safety stock) per item',
      'Set reorder quantity (economic order quantity)',
      'Set maximum stock level',
      'Enable auto-PR generation on breach',
      'Configure preferred vendor per item',
    ],
    page: 'StockAlertsAndSuggestions',
    tip: 'Start with A-category items for reorder rules. These high-value items benefit most from automation.',
  },
  {
    id: 'ledger',
    title: 'Configure Stock Ledger',
    subtitle: 'Set up inventory accounting integration',
    icon: BookOpen,
    color: '#059669',
    desc: 'Configure how inventory transactions post to your chart of accounts. Set up stock valuation entries, GRN accounting, and consumption journals.',
    tasks: [
      'Map inventory accounts in Chart of Accounts',
      'Configure GRN-to-stock posting rules',
      'Set material consumption journal',
      'Enable batch-wise stock ledger',
      'Configure period closing stock valuation',
    ],
    page: 'AccountingEngine',
    tip: 'Involve your CA/Finance team at this step — stock accounting impacts statutory reporting.',
  },
  {
    id: 'approvals',
    title: 'Configure Approvals',
    subtitle: 'Set up stock movement and PR approval chains',
    icon: CheckSquare,
    color: '#ef4444',
    desc: 'Define who approves stock issues, purchase requisitions, goods receipts, and inter-store transfers. Set value thresholds for escalation.',
    tasks: [
      'Set PR approval chain (Store → Purchase → Finance)',
      'Configure GRN approval (Quality → Store)',
      'Set stock issue approval (above ₹50,000)',
      'Configure inter-store transfer approval',
      'Enable auto-approve for consumable issues below ₹5,000',
    ],
    page: 'ApproverSetup',
    tip: 'Value-based auto-approval reduces approval bottlenecks for routine consumable issues.',
  },
];

// ── Warehouse modal (step 0 only) ─────────────────────────────────────────────

function WarehouseModal({ tasksDone, onTaskCheck, onClose, onComplete }) {
  const toast = useToast();
  const [warehouses, setWarehouses] = useState([]);
  const [form, setForm] = useState({
    warehouse_name: '', warehouse_code: '', warehouse_type: 'raw_material', location: '',
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/inventory/warehouses');
      const rows = Array.isArray(res.data) ? res.data : [];
      setWarehouses(rows);
      rows.forEach(w => {
        const idx = TYPE_TASK_MAP[w?.warehouse_type];
        if (idx !== undefined) onTaskCheck(idx);
      });
    } catch { /* modal still usable without pre-load */ }
  }, [onTaskCheck]);

  useEffect(() => { load(); }, [load]);

  const applyPreset = (p) =>
    setForm({ warehouse_name: p.label, warehouse_code: p.code, warehouse_type: p.type, location: '' });

  const save = async () => {
    if (!form.warehouse_name.trim()) { toast.error('Warehouse name is required'); return; }
    setSaving(true);
    try {
      const res = await api.post('/inventory/warehouses', form);
      const w = res.data;
      toast.success(`${w?.warehouse_name ?? 'Warehouse'} created`);
      const idx = TYPE_TASK_MAP[w?.warehouse_type];
      if (idx !== undefined) onTaskCheck(idx);
      setWarehouses(prev => [...prev, w]);
      setForm({ warehouse_name: '', warehouse_code: '', warehouse_type: 'raw_material', location: '' });
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Failed to create warehouse');
    } finally {
      setSaving(false);
    }
  };

  const typeLabel = (type) => WH_TYPES.find(t => t.value === type)?.label ?? type ?? 'general';

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: 16,
    }}>
      <div style={{
        background: '#fff', borderRadius: 14, width: '100%', maxWidth: 760,
        maxHeight: '90vh', display: 'flex', flexDirection: 'column',
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
      }}>
        {/* Modal header */}
        <div style={{
          padding: '20px 24px 16px', borderBottom: '1px solid #f0f0f4',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: PL,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Warehouse size={18} color={P} />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#1f2937' }}>Configure Warehouses</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                {warehouses?.length ?? 0} warehouse{(warehouses?.length ?? 0) !== 1 ? 's' : ''} created
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{
            width: 28, height: 28, borderRadius: 6, border: '1px solid #e5e7eb',
            background: '#fff', cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <X size={14} color="#6b7280" />
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'auto', display: 'flex', gap: 0 }}>
          {/* Left: presets + existing list */}
          <div style={{
            width: 260, flexShrink: 0, borderRight: '1px solid #f0f0f4',
            padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 14,
          }}>
            <div>
              <div style={{
                fontSize: 10, fontWeight: 700, color: '#9ca3af',
                textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8,
              }}>Quick Create</div>
              {WH_PRESETS.map(p => {
                const taskIdx = TYPE_TASK_MAP[p.type];
                const done = tasksDone?.has(taskIdx);
                return (
                  <button key={p.type} onClick={() => applyPreset(p)} style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 10px', borderRadius: 7, marginBottom: 4,
                    border: '1px solid', cursor: done ? 'default' : 'pointer',
                    borderColor: done ? '#a7f3d0' : '#e5e7eb',
                    background: done ? '#f0fdf4' : '#fafafa',
                    textAlign: 'left', opacity: done ? 0.8 : 1,
                  }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                      background: done ? '#d1fae5' : PB,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {done
                        ? <Check size={10} color="#10b981" strokeWidth={3} />
                        : <Plus size={10} color={P} />}
                    </div>
                    <span style={{ fontSize: 11, color: done ? '#065f46' : '#374151', fontWeight: 500 }}>
                      {p.label}
                    </span>
                  </button>
                );
              })}
            </div>

            {(warehouses?.length ?? 0) > 0 && (
              <div>
                <div style={{
                  fontSize: 10, fontWeight: 700, color: '#9ca3af',
                  textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8,
                }}>Created</div>
                {warehouses?.map(w => (
                  <div key={w?.id} style={{
                    display: 'flex', alignItems: 'center', gap: 7,
                    padding: '6px 8px', borderRadius: 6, marginBottom: 3,
                    background: '#f9fafb', border: '1px solid #f0f0f4',
                  }}>
                    <Check size={11} color="#10b981" strokeWidth={3} style={{ flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>
                        {w?.warehouse_name ?? 'Unnamed warehouse'}
                      </div>
                      <div style={{ fontSize: 10, color: '#9ca3af' }}>
                        {w?.warehouse_code ?? '—'} · {typeLabel(w?.warehouse_type ?? 'general')}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right: create form */}
          <div style={{ flex: 1, padding: '20px 24px' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 16 }}>
              New Warehouse
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
              <label style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>
                Warehouse Name *
                <input
                  value={form.warehouse_name}
                  onChange={e => setForm(f => ({ ...f, warehouse_name: e.target.value }))}
                  placeholder="e.g. Main Raw Material Store"
                  style={{
                    display: 'block', width: '100%', marginTop: 4,
                    padding: '8px 11px', borderRadius: 7, border: '1px solid #d1d5db',
                    fontSize: 13, color: '#1f2937', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>
                  Warehouse Code
                  <input
                    value={form.warehouse_code}
                    onChange={e => setForm(f => ({ ...f, warehouse_code: e.target.value }))}
                    placeholder="e.g. WH-RM-01"
                    style={{
                      display: 'block', width: '100%', marginTop: 4,
                      padding: '8px 11px', borderRadius: 7, border: '1px solid #d1d5db',
                      fontSize: 13, color: '#1f2937', outline: 'none', boxSizing: 'border-box',
                    }}
                  />
                </label>
                <label style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>
                  Type
                  <select
                    value={form.warehouse_type}
                    onChange={e => setForm(f => ({ ...f, warehouse_type: e.target.value }))}
                    style={{
                      display: 'block', width: '100%', marginTop: 4,
                      padding: '8px 11px', borderRadius: 7, border: '1px solid #d1d5db',
                      fontSize: 13, color: '#1f2937', background: '#fff',
                      outline: 'none', boxSizing: 'border-box',
                    }}
                  >
                    {WH_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>
                Location / Address
                <input
                  value={form.location}
                  onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                  placeholder="e.g. Plant A, Building 2, Floor 1"
                  style={{
                    display: 'block', width: '100%', marginTop: 4,
                    padding: '8px 11px', borderRadius: 7, border: '1px solid #d1d5db',
                    fontSize: 13, color: '#1f2937', outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </label>

              <button
                onClick={save}
                disabled={saving || !form.warehouse_name.trim()}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  padding: '10px 20px', borderRadius: 8, border: 'none',
                  background: saving || !form.warehouse_name.trim() ? '#e5e7eb' : P,
                  color: saving || !form.warehouse_name.trim() ? '#9ca3af' : '#fff',
                  fontSize: 13, fontWeight: 600,
                  cursor: saving || !form.warehouse_name.trim() ? 'not-allowed' : 'pointer',
                  alignSelf: 'flex-start',
                }}
              >
                <Plus size={14} />
                {saving ? 'Creating…' : 'Create Warehouse'}
              </button>
            </div>

            <div style={{
              marginTop: 20, padding: '12px 14px', borderRadius: 8,
              background: '#fffbeb', border: '1px solid #fef3c7',
            }}>
              <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
                <strong>Tip:</strong> For bin/rack structure, visit{' '}
                <button
                  onClick={() => window.open('/WarehouseManagement', '_blank')}
                  style={{
                    background: 'none', border: 'none', color: P,
                    fontSize: 11, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline',
                    padding: 0,
                  }}
                >
                  Warehouse Management
                </button>{' '}
                after creating your warehouses here.
              </div>
            </div>
          </div>
        </div>

        {/* Modal footer */}
        <div style={{
          padding: '14px 24px', borderTop: '1px solid #f0f0f4',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {tasksDone?.size ?? 0} of 5 tasks complete
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={{
              padding: '8px 16px', borderRadius: 7, border: '1px solid #e5e7eb',
              background: '#fff', fontSize: 12, fontWeight: 600,
              color: '#374151', cursor: 'pointer',
            }}>
              Close
            </button>
            <button onClick={onComplete} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 16px', borderRadius: 7, border: 'none',
              background: '#10b981', color: '#fff',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>
              <CheckCircle size={13} /> Mark Step Complete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export default function InventorySetupWizard() {
  const navigate  = useNavigate();
  const [step, setStep]           = useState(0);
  const [completed, setCompleted] = useState(new Set());
  const [showModal, setShowModal] = useState(false);
  // tasksDone[stepIdx] = Set<taskIdx> for per-task tracking (warehouse step only)
  const [tasksDone, setTasksDone] = useState({});

  const goto    = (page) => navigate(`/${page}`);
  const current = STEPS[step];
  const Icon    = current.icon;

  const markDone = useCallback(
    () => setCompleted(prev => new Set([...prev, step])),
    [step]
  );

  const finish = () => navigate('/SystemSettings');

  const handleTaskCheck = useCallback((stepIdx, taskIdx) => {
    setTasksDone(prev => {
      const s = new Set(prev[stepIdx] ?? []);
      s.add(taskIdx);
      return { ...prev, [stepIdx]: s };
    });
  }, []);

  // Auto-complete warehouse step when all 5 tasks are individually checked
  useEffect(() => {
    if ((tasksDone[0]?.size ?? 0) >= 5 && !completed.has(0)) {
      setCompleted(prev => new Set([...prev, 0]));
    }
  }, [tasksDone, completed]);

  const isTaskDone = (stepIdx, taskIdx) =>
    completed.has(stepIdx) || (tasksDone[stepIdx]?.has(taskIdx) ?? false);

  const toggleTask = (taskIdx) => {
    // Allow manual tick only for task 4 (bins/racks) on warehouse step
    if (step === 0 && taskIdx === 4) {
      handleTaskCheck(0, 4);
    }
  };

  const handleConfigureNow = () => {
    if (step === 0) {
      setShowModal(true);
    } else {
      markDone();
      goto(current.page);
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#fafbff', fontFamily: 'inherit' }}>

      {showModal && (
        <WarehouseModal
          tasksDone={tasksDone[0] ?? new Set()}
          onTaskCheck={(taskIdx) => handleTaskCheck(0, taskIdx)}
          onClose={() => setShowModal(false)}
          onComplete={() => { markDone(); setShowModal(false); }}
        />
      )}

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f4', padding: '16px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: PL,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <PlayCircle size={18} color={P} />
            </div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#1f2937' }}>Inventory Setup Wizard</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                Step {step + 1} of {STEPS.length} — {current.title}
              </div>
            </div>
          </div>
          <button onClick={() => navigate('/SystemSettings')} style={{
            padding: '7px 14px', borderRadius: 7, border: '1px solid #e5e7eb',
            background: '#fff', fontSize: 12, color: '#6b7280', cursor: 'pointer',
          }}>
            Back to Settings
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', maxWidth: 1100, margin: '0 auto', padding: '32px 24px', gap: 28 }}>

        {/* Step tracker sidebar */}
        <div style={{ width: 240, flexShrink: 0 }}>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: '16px 12px' }}>
            <div style={{
              fontSize: 11, fontWeight: 700, color: '#9ca3af',
              textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12, paddingLeft: 8,
            }}>
              Setup Steps
            </div>
            {STEPS.map((s, i) => {
              const SIcon  = s.icon;
              const isDone = completed.has(i);
              const isAct  = i === step;
              return (
                <button key={s.id} onClick={() => setStep(i)} style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 10px', borderRadius: 8, border: 'none',
                  background: isAct ? PL : 'transparent',
                  cursor: 'pointer', textAlign: 'left', marginBottom: 2,
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                    background: isDone ? '#d1fae5' : isAct ? PB : '#f3f4f6',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: isAct ? `2px solid ${P}` : '2px solid transparent',
                  }}>
                    {isDone
                      ? <Check size={13} color="#10b981" strokeWidth={3} />
                      : <SIcon size={13} color={isAct ? P : '#9ca3af'} />}
                  </div>
                  <div>
                    <div style={{
                      fontSize: 12, fontWeight: isAct ? 700 : 500,
                      color: isAct ? P : isDone ? '#374151' : '#6b7280',
                    }}>{s.title}</div>
                    {isDone && <div style={{ fontSize: 10, color: '#10b981' }}>Completed</div>}
                  </div>
                </button>
              );
            })}

            {/* Progress bar */}
            <div style={{ marginTop: 16, padding: '12px 10px', borderTop: '1px solid #f0f0f4' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: '#6b7280' }}>Progress</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: P }}>
                  {Math.round((completed.size / STEPS.length) * 100)}%
                </span>
              </div>
              <div style={{ height: 5, background: PB, borderRadius: 10 }}>
                <div style={{
                  height: '100%', background: P, borderRadius: 10,
                  width: `${(completed.size / STEPS.length) * 100}%`,
                  transition: 'width 0.3s',
                }} />
              </div>
            </div>
          </div>
        </div>

        {/* Step content */}
        <div style={{ flex: 1 }}>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', overflow: 'hidden' }}>

            {/* Step header */}
            <div style={{
              padding: '28px 32px', borderBottom: '1px solid #f0f0f4',
              background: `linear-gradient(135deg, ${current.color}10, ${PL})`,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                <div style={{
                  width: 52, height: 52, borderRadius: 12,
                  background: current.color + '20',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Icon size={26} color={current.color} />
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <div style={{
                      fontSize: 10, fontWeight: 700, color: current.color,
                      background: current.color + '18', padding: '2px 8px', borderRadius: 20,
                      textTransform: 'uppercase',
                    }}>Step {step + 1} of {STEPS.length}</div>
                    {completed.has(step) && (
                      <div style={{
                        fontSize: 10, fontWeight: 700, color: '#065f46',
                        background: '#d1fae5', padding: '2px 8px', borderRadius: 20,
                      }}>
                        ✓ Completed
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#1f2937' }}>{current.title}</div>
                  <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{current.subtitle}</div>
                </div>
              </div>
              <p style={{ marginTop: 16, fontSize: 14, color: '#374151', lineHeight: 1.7 }}>{current.desc}</p>
            </div>

            {/* Checklist */}
            <div style={{ padding: '24px 32px', borderBottom: '1px solid #f0f0f4' }}>
              <div style={{
                fontSize: 12, fontWeight: 700, color: '#9ca3af',
                textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14,
              }}>
                Configuration Checklist
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {current.tasks.map((task, i) => {
                  const done       = isTaskDone(step, i);
                  // Task 4 on warehouse step is manually clickable (bins/racks)
                  const clickable  = step === 0 && i === 4 && !done;
                  return (
                    <div
                      key={i}
                      onClick={clickable ? () => toggleTask(i) : undefined}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                        cursor: clickable ? 'pointer' : 'default',
                      }}
                    >
                      <div style={{
                        width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                        background: done ? '#d1fae5' : PB,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background 0.2s',
                      }}>
                        {done
                          ? <Check size={11} color="#10b981" strokeWidth={3} />
                          : <span style={{ fontSize: 9, fontWeight: 800, color: P }}>{i + 1}</span>}
                      </div>
                      <div style={{
                        fontSize: 13, color: done ? '#6b7280' : '#374151',
                        lineHeight: 1.5,
                        textDecoration: done ? 'line-through' : 'none',
                      }}>
                        {task}
                        {clickable && (
                          <span style={{ fontSize: 10, color: P, marginLeft: 6 }}>click to mark done</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Pro tip */}
            <div style={{ padding: '16px 32px', background: '#fffbeb', borderBottom: '1px solid #fef3c7' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Star size={14} color="#d97706" style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12, color: '#92400e', lineHeight: 1.5 }}>
                  <strong>Pro tip:</strong> {current.tip}
                </div>
              </div>
            </div>

            {/* Action buttons */}
            <div style={{
              padding: '20px 32px', display: 'flex',
              alignItems: 'center', justifyContent: 'space-between',
            }}>
              <button
                onClick={() => setStep(s => Math.max(0, s - 1))}
                disabled={step === 0}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '9px 18px', borderRadius: 8, border: '1px solid #e5e7eb',
                  background: step === 0 ? '#f9fafb' : '#fff',
                  color: step === 0 ? '#d1d5db' : '#374151',
                  fontSize: 13, fontWeight: 600,
                  cursor: step === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                <ChevronLeft size={15} /> Previous
              </button>

              <div style={{ display: 'flex', gap: 10 }}>
                {!completed.has(step) && (
                  <button
                    onClick={handleConfigureNow}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '9px 18px', borderRadius: 8, border: `1px solid ${PB}`,
                      background: PL, color: P, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    <CheckCircle size={14} /> Configure Now
                  </button>
                )}

                {/* For warehouse step: show Manage Warehouses after completion */}
                {step === 0 && completed.has(0) && (
                  <button
                    onClick={() => setShowModal(true)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '9px 18px', borderRadius: 8, border: `1px solid ${PB}`,
                      background: PL, color: P, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    <Warehouse size={14} /> Manage Warehouses
                  </button>
                )}

                {step < STEPS.length - 1 ? (
                  <button
                    onClick={() => { if (!completed.has(step)) markDone(); setStep(s => s + 1); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '9px 20px', borderRadius: 8, border: 'none',
                      background: P, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Next Step <ChevronRight size={15} />
                  </button>
                ) : (
                  <button
                    onClick={finish}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '9px 20px', borderRadius: 8, border: 'none',
                      background: '#10b981', color: '#fff',
                      fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    <CheckCircle size={15} /> Complete Setup
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
