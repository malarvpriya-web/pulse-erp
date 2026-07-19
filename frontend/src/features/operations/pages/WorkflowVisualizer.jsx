import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/services/api/client';
import { fmtL } from '@/utils/format';
import {
  TrendingUp, Lightbulb, ShoppingCart, Wrench, Factory,
  CheckSquare, Truck, MapPin, Headphones, Shield,
  ChevronRight, AlertTriangle, Clock, CheckCircle,
  ArrowRight, RefreshCw, BarChart2, Activity,
} from 'lucide-react';

const P = '#6B3FDB';
const PL = '#f5f3ff';
const PB = '#e9e4ff';
const CARD = { background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4' };

// ─── Stage definitions ────────────────────────────────────────────────────────
const STAGES = [
  {
    id: 'lead',
    label: 'Lead',
    icon: TrendingUp,
    color: '#0ea5e9',
    navPage: 'Leads',
    desc: 'Prospective customers in early qualification',
    kpiLabel: 'Active Leads',
  },
  {
    id: 'proposal',
    label: 'Proposal',
    icon: Lightbulb,
    color: '#8b5cf6',
    navPage: 'Quotations',
    desc: 'Quotations and proposals submitted to customers',
    kpiLabel: 'Proposals Sent',
  },
  {
    id: 'order',
    label: 'Order',
    icon: ShoppingCart,
    color: '#6B3FDB',
    navPage: 'SalesOrders',
    desc: 'Confirmed sales orders awaiting execution',
    kpiLabel: 'Active Orders',
  },
  {
    id: 'engineering',
    label: 'Engineering',
    icon: Wrench,
    color: '#6366f1',
    navPage: 'BOMBuilder',
    desc: 'BOM creation, ECN approvals, design freeze',
    kpiLabel: 'In Engineering',
  },
  {
    id: 'production',
    label: 'Production',
    icon: Factory,
    color: '#f59e0b',
    navPage: 'ProductionOrders',
    desc: 'Manufacturing in progress on shop floor',
    kpiLabel: 'In Production',
  },
  {
    id: 'quality',
    label: 'QC / FAT',
    icon: CheckSquare,
    color: '#10b981',
    navPage: 'QualityManagement',
    desc: 'Factory acceptance testing and quality inspection',
    kpiLabel: 'Under QC',
  },
  {
    id: 'dispatch',
    label: 'Dispatch',
    icon: Truck,
    color: '#d97706',
    navPage: 'LogisticsShipping',
    desc: 'Goods packed and ready for dispatch',
    kpiLabel: 'Ready to Dispatch',
  },
  {
    id: 'installation',
    label: 'Installation',
    icon: MapPin,
    color: '#ef4444',
    navPage: 'InstallationDashboard',
    desc: 'Field installation and commissioning at customer site',
    kpiLabel: 'Under Installation',
  },
  {
    id: 'service',
    label: 'Service',
    icon: Headphones,
    color: '#0891b2',
    navPage: 'FieldService',
    desc: 'Post-installation support, AMC, and service tickets',
    kpiLabel: 'Active Service',
  },
  {
    id: 'closed',
    label: 'Closed',
    icon: Shield,
    color: '#6b7280',
    navPage: 'LifecycleTracker',
    desc: 'Completed and closed project records',
    kpiLabel: 'Closed (30d)',
  },
];


// Use shared fmtL which correctly returns ₹0 for zero values

// ─── Stage card ───────────────────────────────────────────────────────────────
function StageCard({ stage, data, isSelected, onClick }) {
  const Icon = stage.icon;
  const totalAlerts = (data?.alerts ?? 0) + (data?.overdue ?? 0);

  return (
    <button
      onClick={onClick}
      style={{
        ...CARD,
        border: isSelected ? `2px solid ${stage.color}` : '1px solid #f0f0f4',
        padding: '16px', cursor: 'pointer', textAlign: 'left',
        background: isSelected ? stage.color + '08' : '#fff',
        transition: 'all 0.15s', position: 'relative',
        minWidth: 140,
      }}
    >
      {/* Alert badge */}
      {totalAlerts > 0 && (
        <div style={{
          position: 'absolute', top: 8, right: 8,
          width: 18, height: 18, borderRadius: '50%',
          background: '#ef4444', color: '#fff',
          fontSize: 10, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {totalAlerts}
        </div>
      )}

      <div style={{
        width: 36, height: 36, borderRadius: 8,
        background: stage.color + '18',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 12,
      }}>
        <Icon size={18} color={stage.color} />
      </div>

      <div style={{ fontSize: 18, fontWeight: 800, color: '#1f2937', marginBottom: 2 }}>
        {data?.count ?? 0}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{stage.label}</div>
      <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.4 }}>{stage.kpiLabel}</div>

      {data?.value > 0 && (
        <div style={{
          marginTop: 10, fontSize: 11, fontWeight: 700,
          color: stage.color, padding: '3px 8px',
          background: stage.color + '12', borderRadius: 6, display: 'inline-block',
        }}>
          {fmtL(data.value)}
        </div>
      )}
    </button>
  );
}

// ─── Alert row ────────────────────────────────────────────────────────────────
function AlertRow({ type, count, label, color, bg }) {
  if (!count) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', borderRadius: 8, background: bg,
    }}>
      <AlertTriangle size={13} color={color} />
      <span style={{ fontSize: 12, color, fontWeight: 600 }}>{count} {label}</span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function WorkflowVisualizer({ setPage }) {
  const navigate = useNavigate();
  const [data, setData]         = useState({});
  const [loading, setLoading]   = useState(false);
  const [selected, setSelected] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const load = () => {
    setLoading(true);
    api.get('/global-search/workflow-summary')
      .then(r => {
        if (isMounted.current) {
          setData(r.data || {});
          setLastRefresh(new Date());
        }
      })
      .catch(() => {
        if (isMounted.current) {
          setLastRefresh(new Date());
        }
      })
      .finally(() => { if (isMounted.current) setLoading(false); });
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const goto = (page) => navigate(`/${page}`);

  const selectedStage = selected ? STAGES.find(s => s.id === selected) : null;
  const selectedData  = selected ? data[selected] ?? null : null;

  // KPI totals — active includes all stages except Closed (last); overdue is a
  // cross-stage independent query on each table, not aliased from any single stage
  const totals = {
    active:   STAGES.slice(0, -1).reduce((s, st) => s + (data[st.id]?.count   ?? 0), 0),
    alerts:   STAGES.reduce((s, st) => s + (data[st.id]?.alerts  ?? 0), 0),
    overdue:  STAGES.reduce((s, st) => s + (data[st.id]?.overdue ?? 0), 0),
    pipeline: STAGES.slice(0, 3).reduce((s, st) => s + (data[st.id]?.value   ?? 0), 0),
  };

  return (
    <div style={{ minHeight: '100vh', background: '#fafbff', fontFamily: 'inherit' }}>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #f0f0f4', padding: '20px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10, background: PL,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Activity size={20} color={P} />
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#1f2937' }}>
                Business Workflow Board
              </div>
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                End-to-end visibility — Lead to Service · Last updated {lastRefresh.toLocaleTimeString()}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={load} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: '1px solid #e5e7eb', background: '#fff',
              fontSize: 12, color: '#6b7280', cursor: 'pointer',
            }}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
              Refresh
            </button>
            <button onClick={() => goto('LifecycleTracker')} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8, border: 'none',
              background: P, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}>
              <BarChart2 size={13} /> Order Tracker
            </button>
          </div>
        </div>
      </div>

      <div style={{ padding: '24px 32px' }}>

        {/* KPI summary bar */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28,
        }}>
          {[
            { label: 'Active Work Items', value: totals.active, icon: Activity, color: P, bg: PL },
            { label: 'Pending Alerts', value: totals.alerts, icon: AlertTriangle, color: '#ef4444', bg: '#fef2f2' },
            { label: 'Overdue Items', value: totals.overdue, icon: Clock, color: '#d97706', bg: '#fffbeb' },
            { label: 'Pipeline Value', value: fmtL(totals.pipeline), icon: BarChart2, color: '#10b981', bg: '#ecfdf5' },
          ].map(kpi => {
            const KIcon = kpi.icon;
            return (
              <div key={kpi.label} style={{ ...CARD, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 8, background: kpi.bg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <KIcon size={18} color={kpi.color} />
                </div>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#1f2937' }}>{kpi.value}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{kpi.label}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Stage pipeline */}
        <div style={{ ...CARD, padding: '24px', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>Business Pipeline</div>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>· Click any stage to inspect</div>
          </div>

          {/* Flow arrows */}
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, overflowX: 'auto', paddingBottom: 4 }}>
            {STAGES.map((stage, i) => (
              <div key={stage.id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <StageCard
                  stage={stage}
                  data={data[stage.id] ?? null}
                  isSelected={selected === stage.id}
                  onClick={() => setSelected(selected === stage.id ? null : stage.id)}
                />
                {i < STAGES.length - 1 && (
                  <ChevronRight size={18} color="#d1d5db" />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Stage detail panel */}
        {selectedStage && selectedData && (
          <div style={{ ...CARD, padding: '24px' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 10,
                  background: selectedStage.color + '18',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <selectedStage.icon size={22} color={selectedStage.color} />
                </div>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#1f2937' }}>
                    {selectedStage.label} Stage
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{selectedStage.desc}</div>
                </div>
              </div>
              <button
                onClick={() => goto(selectedStage.navPage)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '9px 18px', borderRadius: 8, border: 'none',
                  background: selectedStage.color, color: '#fff',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                Open Module <ArrowRight size={13} />
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 20 }}>
              {[
                { label: selectedStage?.kpiLabel, value: selectedData?.count ?? 0, color: selectedStage.color, bg: selectedStage.color + '10' },
                { label: 'Pipeline Value', value: fmtL(selectedData?.value ?? 0), color: '#10b981', bg: '#ecfdf5' },
                { label: 'Overdue', value: selectedData?.overdue ?? 0, color: '#ef4444', bg: '#fef2f2' },
              ].map(kpi => (
                <div key={kpi.label} style={{
                  padding: '16px', borderRadius: 10,
                  background: kpi.bg,
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: kpi.color }}>{kpi.value}</div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{kpi.label}</div>
                </div>
              ))}
            </div>

            {/* Alerts in this stage */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <AlertRow
                type="overdue"
                count={selectedData?.overdue ?? 0}
                label={`items overdue in ${selectedStage.label}`}
                color="#dc2626" bg="#fef2f2"
              />
              <AlertRow
                type="alerts"
                count={selectedData?.alerts ?? 0}
                label={`action items pending`}
                color="#d97706" bg="#fffbeb"
              />
              {!selectedData?.overdue && !selectedData?.alerts && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 14px', borderRadius: 8, background: '#ecfdf5' }}>
                  <CheckCircle size={14} color="#10b981" />
                  <span style={{ fontSize: 13, color: '#065f46', fontWeight: 500 }}>
                    No alerts — this stage is running smoothly
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Journey visualization */}
        <div style={{ ...CARD, padding: '20px 24px', marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', marginBottom: 16 }}>
            Full Business Lifecycle
          </div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
            {STAGES.map((stage, i) => {
              const d = data[stage.id] ?? {};
              const hasIssue = (d?.overdue || 0) + (d?.alerts || 0) > 0;
              return (
                <div key={stage.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div
                    onClick={() => { goto(stage.navPage); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                      padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                      background: hasIssue ? '#fef3c7' : (d?.count || 0) > 0 ? stage.color + '14' : '#f3f4f6',
                      color: hasIssue ? '#92400e' : (d?.count || 0) > 0 ? stage.color : '#9ca3af',
                      border: selected === stage.id ? `2px solid ${stage.color}` : '2px solid transparent',
                    }}
                  >
                    {hasIssue && <AlertTriangle size={10} />}
                    {stage.label}
                    {(d?.count || 0) > 0 && (
                      <span style={{ fontWeight: 800 }}>({d.count})</span>
                    )}
                  </div>
                  {i < STAGES.length - 1 && (
                    <ChevronRight size={12} color="#e5e7eb" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
