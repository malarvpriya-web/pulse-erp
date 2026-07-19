import { useNavigate } from 'react-router-dom';
import {
  CheckCircle, AlertCircle, Clock, ArrowRight, Rocket, RefreshCw, PlayCircle, Play,
  Building2, Network, Users, Shield, IndianRupee, Landmark, Calendar, Plug,
  ChevronRight, Users2, BarChart2, Workflow, CreditCard,
} from 'lucide-react';
import { useSetupProgress } from '@/hooks/useSetupProgress';
import { useAuth } from '@/context/AuthContext';

const P  = '#6B3FDB';
const PL = '#f5f3ff';
const PB = '#e9e4ff';

// wizardIdx must match the STEPS order in SetupWizard.jsx exactly
const STEPS = [
  { key: 'company',      label: 'Company Info',           icon: Building2,   color: '#4f46e5', wizardIdx: 0 },
  { key: 'organization', label: 'Organization Structure', icon: Network,     color: '#6B3FDB', wizardIdx: 1 },
  { key: 'users',        label: 'User Accounts',          icon: Users,       color: '#059669', wizardIdx: 2 },
  { key: 'roles',        label: 'Roles & Permissions',    icon: Shield,      color: '#0891b2', wizardIdx: 3 },
  { key: 'payroll',      label: 'Payroll Structure',      icon: IndianRupee, color: '#d97706', wizardIdx: 4 },
  { key: 'finance',      label: 'Bank Accounts',          icon: Landmark,    color: '#8b5cf6', wizardIdx: 5 },
  { key: 'leaves',       label: 'Leave Policies',         icon: Calendar,    color: '#ef4444', wizardIdx: 6 },
  { key: 'integrations', label: 'Integrations',           icon: Plug,        color: '#0d9488', wizardIdx: 7 },
];

const NEXT_STEPS = [
  { icon: Users2,     label: 'Import Employee Data',         desc: 'Bulk-import your workforce from a spreadsheet.',                 page: 'EmployeesData'      },
  { icon: BarChart2,  label: 'Set Up Attendance Devices',    desc: 'Configure biometric or mobile attendance tracking.',            page: 'AttendanceSettings' },
  { icon: Workflow,   label: 'Configure Approval Workflows', desc: 'Set up multi-level approval chains for leaves and expenses.',   page: 'WorkflowBuilder'    },
  { icon: CreditCard, label: 'Run First Payroll',            desc: 'Process and disburse salary for your first pay cycle.',         page: 'Payroll'            },
];

function StatusBadge({ done, skipped }) {
  if (done)    return <span style={{ padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#059669', fontSize: 10, fontWeight: 700 }}>Done</span>;
  if (skipped) return <span style={{ padding: '2px 8px', borderRadius: 10, background: '#f3f4f6', color: '#9ca3af', fontSize: 10, fontWeight: 700 }}>Skipped</span>;
  return           <span style={{ padding: '2px 8px', borderRadius: 10, background: '#fef3c7', color: '#d97706', fontSize: 10, fontWeight: 700 }}>Pending</span>;
}

export default function SetupDashboard({ setPage: setPageProp }) {
  const navigate = useNavigate();
  const { role }  = useAuth();
  const { progress, isLoading, refetch } = useSetupProgress();

  const go = (page) => {
    if (setPageProp) { setPageProp(page); } else { navigate(`/${page}`); }
  };

  const goToWizardStep = (wizardIdx) => {
    sessionStorage.setItem('wizard_current_step', wizardIdx);
    go('SetupWizard');
  };

  const doneCount    = STEPS.filter(s => progress.steps[s.key]?.done).length;
  const skippedCount = STEPS.filter(s => progress.steps[s.key]?.skipped).length;
  const totalDone    = doneCount + skippedCount;
  const pct          = Math.round((totalDone / STEPS.length) * 100);

  const skippedSteps = STEPS.filter(s => progress.steps[s.key]?.skipped && !progress.steps[s.key]?.done);

  const dashboardPage = role === 'super_admin' ? 'ExecutiveDashboard' : 'AdminDashboard';

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 10 }}>
        <RefreshCw size={20} color="#9ca3af" style={{ animation: 'spin 0.9s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <span style={{ fontSize: 14, color: '#9ca3af' }}>Loading setup status…</span>
      </div>
    );
  }

  // ── Hero content driven by completion percentage ──────────────────────────
  let heroIcon, heroBg, heroRing, heroHeading, heroSubtext;
  if (pct === 100) {
    heroIcon    = <CheckCircle size={40} color="#10b981" />;
    heroBg      = '#d1fae5';
    heroRing    = '#f0fdf4';
    heroHeading = 'Pulse ERP is ready';
    heroSubtext = `All ${STEPS.length} setup steps completed.`;
  } else if (pct === 0) {
    heroIcon    = <AlertCircle size={40} color="#d97706" />;
    heroBg      = '#fef3c7';
    heroRing    = '#fffbeb';
    heroHeading = "Let's get Pulse ERP set up";
    heroSubtext = `0 of ${STEPS.length} steps completed. Complete setup to unlock full functionality.`;
  } else {
    heroIcon    = <Clock size={40} color="#6B3FDB" />;
    heroBg      = '#ede9fe';
    heroRing    = '#f5f3ff';
    heroHeading = 'Setup in progress';
    heroSubtext = `${totalDone} of ${STEPS.length} steps completed. Here's what's left to configure.`;
  }

  return (
    <div style={{ minHeight: '100vh', background: '#fafbff', padding: '20px 18px', fontFamily: 'inherit' }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      <div style={{ maxWidth: 960, margin: '0 auto' }}>

        {/* ── Hero ── */}
        <div style={{
          textAlign: 'center', marginBottom: 18,
          padding: '26px 28px 22px',
          background: '#fff', borderRadius: 18, border: '1px solid #f0f0f4',
          boxShadow: '0 1px 8px rgba(0,0,0,.04)',
        }}>
          <div style={{
            width: 62, height: 62, borderRadius: '50%', background: heroBg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 13px', boxShadow: `0 0 0 12px ${heroRing}`,
          }}>
            {heroIcon}
          </div>
          <h1 style={{ margin: '0 0 7px', fontSize: 22, fontWeight: 800, color: '#1f2937' }}>
            {heroHeading}
          </h1>
          <p style={{ margin: '0 0 15px', fontSize: 13.5, color: '#6b7280', lineHeight: 1.55, maxWidth: 500, marginLeft: 'auto', marginRight: 'auto' }}>
            {heroSubtext}
          </p>

          {/* Progress bar */}
          <div style={{ maxWidth: 360, margin: '0 auto 15px', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>Setup completion</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: P }}>{pct}%</span>
            </div>
            <div style={{ height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${pct}%`, borderRadius: 4,
                background: `linear-gradient(90deg, ${P}, #8b5cf6)`,
                transition: 'width .5s ease',
              }} />
            </div>
          </div>

          {/* CTA — primary-only when 0%, both when partially/fully done */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
            {pct === 0 ? (
              <button
                onClick={() => go('SetupWizard')}
                style={{
                  padding: '10px 22px', borderRadius: 9, border: 'none',
                  background: P, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'inherit',
                  boxShadow: '0 4px 14px rgba(107,63,219,.35)',
                }}
              >
                <Play size={15} /> Continue Setup
              </button>
            ) : (
              <>
                <button
                  onClick={() => go('SetupWizard')}
                  style={{
                    padding: '10px 22px', borderRadius: 9, border: `1px solid ${PB}`,
                    background: PL, color: P, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'inherit',
                  }}
                >
                  <PlayCircle size={15} /> Continue Setup
                </button>
                <button
                  onClick={() => go(dashboardPage)}
                  style={{
                    padding: '10px 22px', borderRadius: 9, border: 'none',
                    background: P, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'inherit',
                    boxShadow: '0 4px 14px rgba(107,63,219,.35)',
                  }}
                >
                  <Rocket size={15} /> Go to Dashboard
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Summary cards grid ── */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#1f2937', marginBottom: 16 }}>
            {pct === 0 ? 'Setup Steps' : pct === 100 ? 'What was configured' : 'Setup overview'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
            {STEPS.map(s => {
              const Icon    = s.icon;
              const stepSt  = progress.steps[s.key] || {};
              const done    = !!stepSt.done;
              const skipped = !!stepSt.skipped;

              return (
                <div
                  key={s.key}
                  style={{
                    background: '#fff', borderRadius: 12,
                    border: `1.5px solid ${done ? '#bbf7d0' : skipped ? '#f3f4f6' : '#e5e7eb'}`,
                    padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
                    cursor: 'pointer', transition: 'box-shadow 0.15s',
                  }}
                  onClick={() => goToWizardStep(s.wizardIdx)}
                  role="button"
                >
                  <div style={{
                    width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                    background: done ? '#d1fae5' : `${s.color}14`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {done
                      ? <CheckCircle size={18} color="#10b981" />
                      : <Icon size={18} color={s.color} />
                    }
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', marginBottom: 2 }}>
                      {s.label}
                    </div>
                    <StatusBadge done={done} skipped={skipped} />
                  </div>
                  <ChevronRight size={14} color="#d1d5db" />
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Remaining setup (skipped steps) ── */}
        {skippedSteps.length > 0 && (
          <div style={{
            background: '#fff', borderRadius: 14, border: '1.5px solid #fef3c7',
            padding: '20px 24px', marginBottom: 32,
            boxShadow: '0 1px 4px rgba(0,0,0,.04)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#1f2937', marginBottom: 14 }}>
              Remaining Setup
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {skippedSteps.map(s => {
                const Icon = s.icon;
                return (
                  <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{
                      width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                      background: `${s.color}14`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Icon size={14} color={s.color} />
                    </div>
                    <span style={{ flex: 1, fontSize: 13, color: '#374151' }}>{s.label}</span>
                    <button
                      onClick={() => goToWizardStep(s.wizardIdx)}
                      style={{
                        padding: '5px 12px', borderRadius: 6, border: 'none',
                        background: PL, color: P, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'inherit',
                      }}
                    >
                      Complete now <ArrowRight size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Recommended next steps ── */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#1f2937', marginBottom: 16 }}>
            Recommended Next Steps
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(195px, 1fr))', gap: 10 }}>
            {NEXT_STEPS.map(({ icon: Icon, label, desc, page }) => (
              <button
                key={page}
                onClick={() => go(page)}
                style={{
                  background: '#fff', borderRadius: 12, border: '1.5px solid #e5e7eb',
                  padding: '18px 16px', textAlign: 'left', cursor: 'pointer',
                  fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 10,
                  transition: 'border-color 0.15s, box-shadow 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = PB; e.currentTarget.style.boxShadow = '0 2px 10px rgba(107,63,219,.08)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.boxShadow = 'none'; }}
              >
                <div style={{
                  width: 36, height: 36, borderRadius: 9, background: PL,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon size={17} color={P} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', marginBottom: 4 }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.5 }}>{desc}</div>
                </div>
                <div style={{ fontSize: 12, color: P, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, marginTop: 'auto' }}>
                  Get started <ArrowRight size={11} />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Footer ── */}
        <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
          <button
            onClick={refetch}
            style={{
              background: 'none', border: 'none', color: '#9ca3af', fontSize: 11,
              cursor: 'pointer', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}
          >
            <RefreshCw size={10} /> Refresh status
          </button>
        </div>

      </div>
    </div>
  );
}
