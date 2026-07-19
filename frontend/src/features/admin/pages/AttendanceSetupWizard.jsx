import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Clock, MapPin, Shield, CheckCircle, IndianRupee,
  Monitor, Zap, ChevronRight, ChevronLeft, Check,
  Calendar, Users, Fingerprint, Radio, PlayCircle, Star,
  Save, AlertCircle, Loader,
} from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';
const PL = '#f5f3ff';
const PB = '#e9e4ff';

const ALL_DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

const STEPS = [
  {
    id: 'timings',
    title: 'Company Timings',
    subtitle: 'Define your core working hours',
    icon: Clock,
    color: '#6B3FDB',
    desc: 'Set the standard working hours for your organization. These timings form the foundation for shift creation, overtime calculation, and late-arrival tracking.',
    tasks: [
      'Set standard work start time (e.g. 9:00 AM)',
      'Set standard work end time (e.g. 6:00 PM)',
      'Configure break duration',
      'Set minimum working hours per day',
      'Configure weekend definition (Sat/Sun)',
    ],
    page: 'AttendanceSettings',
    tip: 'You can create multiple shift variants after this step. Set your most common timing here.',
  },
  {
    id: 'shifts',
    title: 'Create Shifts',
    subtitle: 'Define all work shift patterns',
    icon: Calendar,
    color: '#0891b2',
    desc: 'Create shift schedules for different employee groups — general office shift, factory shifts, night shifts, and rotational patterns.',
    tasks: [
      'Create General Shift (office staff)',
      'Create Factory Shift A and B',
      'Create Night Shift (if applicable)',
      'Assign default shift to departments',
      'Configure shift rotation rules',
    ],
    page: 'ShiftManagement',
    tip: 'Assign shifts to departments in bulk after creation. Employees inherit the department shift.',
  },
  {
    id: 'geo',
    title: 'Configure Geo Attendance',
    subtitle: 'Set location-based attendance zones',
    icon: MapPin,
    color: '#059669',
    desc: 'Define geo-fencing zones for office locations, factories, and field staff. Employees must be within the zone to mark attendance.',
    tasks: [
      'Add Head Office geo-fence zone',
      'Add Factory / Plant locations',
      'Set radius for each zone (50m–2km)',
      'Enable mandatory geo for factory workers',
      'Configure field engineer flexible zones',
    ],
    page: 'GeoFencing',
    tip: 'Factory zones typically need 100–200m radius. Field engineers can use 5–10km city-level zones.',
  },
  {
    id: 'policies',
    title: 'Attendance Policies',
    subtitle: 'Define rules for late, absent, and overtime',
    icon: Shield,
    color: '#d97706',
    desc: 'Configure grace periods, late-mark rules, half-day rules, and overtime eligibility. These policies drive payroll deductions and approvals.',
    tasks: [
      'Set grace period for late arrival (e.g. 15 min)',
      'Configure late-mark deduction rules',
      'Define half-day and absent thresholds',
      'Set overtime eligibility criteria',
      'Configure regularization policy',
    ],
    page: 'AttendancePolicies',
    tip: 'Indian labor law requires clear documentation of OT rules. Set these before enabling overtime approval.',
  },
  {
    id: 'approvals',
    title: 'Configure Approvals',
    subtitle: 'Set up regularization and overtime approval chains',
    icon: Users,
    color: '#8b5cf6',
    desc: 'Define who approves attendance regularization requests and overtime claims. Set multi-level approval for factory-level compliance.',
    tasks: [
      'Set regularization approver (TL → HR)',
      'Set overtime approver (Supervisor → HR)',
      'Configure auto-approve for minor variations',
      'Set approval deadline (hours/days)',
      'Enable rejection notifications',
    ],
    page: 'ApproverSetup',
    tip: 'For factory workers, require supervisor + HR two-level approval for overtime to meet audit requirements.',
  },
  {
    id: 'payroll_sync',
    title: 'Configure Payroll Sync',
    subtitle: 'Link attendance data to payroll',
    icon: IndianRupee,
    color: '#ef4444',
    desc: 'Configure how attendance data flows into payroll. Set the attendance lock date, LOP rules, and OT pay multipliers.',
    tasks: [
      'Set monthly attendance cut-off date',
      'Configure LOP (Loss of Pay) rules',
      'Set overtime pay multiplier (e.g. 1.5x)',
      'Enable auto-payroll sync on lock',
      'Configure payslip attendance summary',
    ],
    page: 'PayrollSync',
    tip: 'Lock attendance before payroll run to prevent retroactive changes. Typically done on 25th of each month.',
  },
  {
    id: 'devices',
    title: 'Add Biometric Devices',
    subtitle: 'Connect fingerprint/RFID hardware',
    icon: Fingerprint,
    color: '#10b981',
    desc: 'Register biometric devices for automatic punch-in/out. Supports ZKTeco, ESSL, and generic RFID hardware via API bridge.',
    tasks: [
      'Register device serial number and location',
      'Configure device API endpoint or static IP',
      'Test device connectivity and sync',
      'Map device to geo-fencing zone',
      'Enable auto-sync interval (every 15 min)',
    ],
    page: 'DeviceManagement',
    tip: 'If biometric is not yet available, enable manual attendance + selfie verification as fallback.',
  },
  {
    id: 'activate',
    title: 'Activate Attendance',
    subtitle: 'Go live with the configured system',
    icon: Zap,
    color: '#f59e0b',
    desc: 'Run a final validation check and activate the attendance module. This enables employee clock-in, dashboard monitoring, and payroll data flow.',
    tasks: [
      'Verify all shifts are assigned to employees',
      'Test geo-fence with a sample punch-in',
      'Confirm approver chain is complete',
      'Run a test payroll sync',
      'Enable Live Workforce Dashboard',
    ],
    page: 'LiveWorkforceDashboard',
    tip: 'Run a pilot with 5–10 employees before full go-live to catch configuration gaps.',
  },
];

const DEFAULT_TIMINGS = {
  work_start_time: '09:00',
  work_end_time: '18:00',
  break_duration: 60,
  min_working_hours: 9.0,
  weekend_days: ['saturday', 'sunday'],
};

export default function AttendanceSetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [completed, setCompleted] = useState(new Set());

  // Step 1 inline form state
  const [showTimingsForm, setShowTimingsForm] = useState(false);
  const [timingsForm, setTimingsForm] = useState(DEFAULT_TIMINGS);
  const [timingsSaving, setTimingsSaving] = useState(false);
  const [timingsError, setTimingsError] = useState('');

  // Load previously saved timings so form shows current values
  useEffect(() => {
    api.get('/attendance/settings/company-timings')
      .then(res => {
        if (res.data) {
          setTimingsForm(prev => ({
            ...prev,
            work_start_time:   res.data.work_start_time   ?? prev.work_start_time,
            work_end_time:     res.data.work_end_time     ?? prev.work_end_time,
            break_duration:    res.data.break_duration    ?? prev.break_duration,
            min_working_hours: res.data.min_working_hours ?? prev.min_working_hours,
            weekend_days:      res.data.weekend_days      ?? prev.weekend_days,
          }));
          // If timings already configured, mark step 0 done
          if (res.data.work_start_time) {
            setCompleted(prev => new Set([...prev, 0]));
          }
        }
      })
      .catch(() => {});
  }, []);

  const goto = (page) => navigate(`/${page}`);
  const current = STEPS[step];
  const Icon = current.icon;

  const markDone = () => setCompleted(prev => new Set([...prev, step]));
  const finish   = () => navigate('/SystemSettings');

  const toggleWeekendDay = (day) => {
    setTimingsForm(f => ({
      ...f,
      weekend_days: f.weekend_days.includes(day)
        ? f.weekend_days.filter(d => d !== day)
        : [...f.weekend_days, day],
    }));
  };

  const handleTimingsSave = async () => {
    setTimingsSaving(true);
    setTimingsError('');
    try {
      await api.post('/attendance/settings/company-timings', {
        work_start_time:   timingsForm.work_start_time   ?? '09:00',
        work_end_time:     timingsForm.work_end_time     ?? '18:00',
        break_duration:    timingsForm.break_duration    ?? 60,
        min_working_hours: timingsForm.min_working_hours ?? 9.0,
        weekend_days:      timingsForm.weekend_days      ?? ['saturday', 'sunday'],
      });
      markDone();
      setShowTimingsForm(false);
    } catch (err) {
      setTimingsError(err?.response?.data?.error ?? 'Failed to save timings.');
    } finally {
      setTimingsSaving(false);
    }
  };

  const inp = {
    border: '1px solid #e9e4ff', borderRadius: 8,
    padding: '7px 10px', fontSize: 13, outline: 'none', width: 110,
  };

  const renderConfigureNow = () => {
    if (step === 0) {
      // Step 1: toggle inline form
      return (
        <button
          onClick={() => setShowTimingsForm(s => !s)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '9px 18px', borderRadius: 8,
            border: `1px solid ${PB}`, background: PL,
            color: P, fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <CheckCircle size={14} />
          {showTimingsForm ? 'Hide Form' : 'Configure Now'}
        </button>
      );
    }
    return (
      <button
        onClick={() => { markDone(); goto(current.page); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '9px 18px', borderRadius: 8,
          border: `1px solid ${PB}`, background: PL,
          color: P, fontSize: 13, fontWeight: 600, cursor: 'pointer',
        }}
      >
        <CheckCircle size={14} />
        Configure Now
      </button>
    );
  };

  const renderTimingsForm = () => (
    <div style={{
      margin: '0 32px 0', padding: 24, borderRadius: 10,
      border: '1px solid #e9e4ff', background: '#fafbff',
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: P, marginBottom: 18 }}>
        Company Timing Configuration
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
            Work Start Time
          </label>
          <input
            type="time"
            value={timingsForm.work_start_time ?? '09:00'}
            onChange={e => setTimingsForm(f => ({ ...f, work_start_time: e.target.value }))}
            style={inp}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
            Work End Time
          </label>
          <input
            type="time"
            value={timingsForm.work_end_time ?? '18:00'}
            onChange={e => setTimingsForm(f => ({ ...f, work_end_time: e.target.value }))}
            style={inp}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
            Break Duration (minutes)
          </label>
          <input
            type="number"
            min={0} max={180} step={5}
            value={timingsForm.break_duration ?? 60}
            onChange={e => setTimingsForm(f => ({ ...f, break_duration: parseInt(e.target.value) || 0 }))}
            style={inp}
          />
        </div>
        <div>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>
            Min Working Hours / Day
          </label>
          <input
            type="number"
            min={1} max={12} step={0.5}
            value={timingsForm.min_working_hours ?? 9.0}
            onChange={e => setTimingsForm(f => ({ ...f, min_working_hours: parseFloat(e.target.value) || 9 }))}
            style={inp}
          />
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 8 }}>
          Weekend Days <span style={{ fontWeight: 400, color: '#9ca3af' }}>(days off — not counted as absent)</span>
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ALL_DAYS.map(day => {
            const isWeekend = (timingsForm.weekend_days ?? ['saturday','sunday']).includes(day);
            return (
              <button
                key={day}
                onClick={() => toggleWeekendDay(day)}
                style={{
                  padding: '5px 12px', borderRadius: 6, border: '1px solid',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: isWeekend ? P : PL,
                  borderColor: isWeekend ? P : PB,
                  color: isWeekend ? '#fff' : P,
                  transition: 'all 0.15s',
                }}
              >
                {day.slice(0, 3).toUpperCase()}
              </button>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
          Selected weekend days will not be counted as absent — applies to all attendance marking logic.
        </div>
      </div>

      {timingsError && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', borderRadius: 8, marginBottom: 14,
          background: '#fef2f2', border: '1px solid #fca5a5', color: '#dc2626', fontSize: 13,
        }}>
          <AlertCircle size={14} /> {timingsError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button
          onClick={() => setShowTimingsForm(false)}
          style={{
            padding: '8px 16px', borderRadius: 8, border: '1px solid #e5e7eb',
            background: '#fff', color: '#6b7280', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleTimingsSave}
          disabled={timingsSaving}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 20px', borderRadius: 8, border: 'none',
            background: P, color: '#fff', fontSize: 13, fontWeight: 600,
            cursor: timingsSaving ? 'not-allowed' : 'pointer', opacity: timingsSaving ? 0.7 : 1,
          }}
        >
          {timingsSaving ? <Loader size={14} /> : <Save size={14} />}
          {timingsSaving ? 'Saving…' : 'Save Timings'}
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#fafbff', fontFamily: 'inherit' }}>

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
              <div style={{ fontSize: 16, fontWeight: 800, color: '#1f2937' }}>Attendance Setup Wizard</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>
                Step {step + 1} of {STEPS.length} — {current.title}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {completed.size > 0 && (
              <div style={{
                padding: '4px 12px', borderRadius: 20, background: '#d1fae5',
                fontSize: 12, fontWeight: 600, color: '#065f46',
              }}>
                {completed.size} step{completed.size > 1 ? 's' : ''} done
              </div>
            )}
            <button onClick={() => navigate('/SystemSettings')} style={{
              padding: '7px 14px', borderRadius: 7, border: '1px solid #e5e7eb',
              background: '#fff', fontSize: 12, color: '#6b7280', cursor: 'pointer',
            }}>
              Back to Settings
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', maxWidth: 1100, margin: '0 auto', padding: '32px 24px', gap: 28 }}>

        {/* Step tracker sidebar */}
        <div style={{ width: 240, flexShrink: 0 }}>
          <div style={{
            background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4',
            padding: '16px 12px',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af',
              textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12, paddingLeft: 8,
            }}>
              Setup Steps
            </div>
            {STEPS.map((s, i) => {
              const SIcon = s.icon;
              const isDone = completed.has(i);
              const isActive = i === step;
              return (
                <button
                  key={s.id}
                  onClick={() => setStep(i)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 10px', borderRadius: 8, border: 'none',
                    background: isActive ? PL : 'transparent',
                    cursor: 'pointer', textAlign: 'left', marginBottom: 2,
                  }}
                >
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                    background: isDone ? '#d1fae5' : isActive ? PB : '#f3f4f6',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: isActive ? `2px solid ${P}` : '2px solid transparent',
                  }}>
                    {isDone
                      ? <Check size={13} color="#10b981" strokeWidth={3} />
                      : <SIcon size={13} color={isActive ? P : '#9ca3af'} />
                    }
                  </div>
                  <div>
                    <div style={{
                      fontSize: 12, fontWeight: isActive ? 700 : 500,
                      color: isActive ? P : isDone ? '#374151' : '#6b7280',
                    }}>
                      {s.title}
                    </div>
                    {isDone && (
                      <div style={{ fontSize: 10, color: '#10b981' }}>Completed</div>
                    )}
                  </div>
                </button>
              );
            })}

            {/* Overall progress */}
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
                      textTransform: 'uppercase', letterSpacing: 0.5,
                    }}>
                      Step {step + 1} of {STEPS.length}
                    </div>
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

            {/* Tasks checklist */}
            <div style={{ padding: '24px 32px', borderBottom: '1px solid #f0f0f4' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af',
                textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14,
              }}>
                Configuration Checklist
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {current.tasks.map((task, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                      background: completed.has(step) ? '#d1fae5' : PB,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {completed.has(step)
                        ? <Check size={11} color="#10b981" strokeWidth={3} />
                        : <span style={{ fontSize: 9, fontWeight: 800, color: P }}>{i + 1}</span>
                      }
                    </div>
                    <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{task}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Inline timings form — only for step 1 */}
            {step === 0 && showTimingsForm && (
              <div style={{ borderBottom: '1px solid #f0f0f4', paddingBottom: 24, paddingTop: 20 }}>
                {renderTimingsForm()}
              </div>
            )}

            {/* Tip */}
            <div style={{ padding: '16px 32px', background: '#fffbeb', borderBottom: '1px solid #fef3c7' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Star size={14} color="#d97706" style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12, color: '#92400e', lineHeight: 1.5 }}>
                  <strong>Pro tip:</strong> {current.tip}
                </div>
              </div>
            </div>

            {/* Actions */}
            <div style={{ padding: '20px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button
                onClick={() => { setShowTimingsForm(false); setStep(s => Math.max(0, s - 1)); }}
                disabled={step === 0}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '9px 18px', borderRadius: 8,
                  border: '1px solid #e5e7eb', background: step === 0 ? '#f9fafb' : '#fff',
                  color: step === 0 ? '#d1d5db' : '#374151',
                  fontSize: 13, fontWeight: 600, cursor: step === 0 ? 'not-allowed' : 'pointer',
                }}
              >
                <ChevronLeft size={15} /> Previous
              </button>

              <div style={{ display: 'flex', gap: 10 }}>
                {!completed.has(step) && renderConfigureNow()}

                {step < STEPS.length - 1 ? (
                  <button
                    onClick={() => {
                      if (!completed.has(step)) markDone();
                      setShowTimingsForm(false);
                      setStep(s => s + 1);
                    }}
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
                      background: '#10b981', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
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
