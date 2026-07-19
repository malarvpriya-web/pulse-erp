import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '@/services/api/client';
import {
  IndianRupee, Layers, ShieldCheck, Users, FileText,
  Zap, ChevronRight, ChevronLeft, Check, PlayCircle, Star, CheckCircle, X,
} from 'lucide-react';

const P  = '#6B3FDB';
const PL = '#f5f3ff';
const PB = '#e9e4ff';

const STEPS = [
  {
    id: 'salary_structures',
    title: 'Salary Structures',
    subtitle: 'Define CTC components for each pay grade',
    icon: Layers,
    color: '#6B3FDB',
    desc: 'Create salary structures that define how the CTC is split across Basic, HRA, Special Allowance, and other components. These structures are assigned to employees during onboarding or annual revision.',
    tasks: [
      'Create Grade A structure (Senior/Manager)',
      'Create Grade B structure (Officer/Executive)',
      'Create Grade C structure (Staff/Worker)',
      'Set Basic salary % of CTC (typically 40–50%)',
      'Configure HRA (50% of Basic for metro, 40% for non-metro)',
      'Add Special Allowance and other components',
    ],
    page: 'SalaryStructure',
    tip: 'Keep Basic at minimum 40% of CTC — it is the base for PF, gratuity, and leave encashment calculations under Indian labour law.',
  },
  {
    id: 'deductions',
    title: 'Statutory Deductions',
    subtitle: 'Configure PF, ESI, PT, and TDS rules',
    icon: ShieldCheck,
    color: '#0891b2',
    desc: 'Configure mandatory statutory deductions. Pulse auto-calculates PF, ESI, and PT based on salary slabs. TDS is computed from Form 12B declarations submitted by employees.',
    tasks: [
      'Enable Employee PF @ 12% of Basic (₹15,000 cap)',
      'Enable Employer PF @ 12% of Basic',
      'Enable ESI @ 0.75% employee / 3.25% employer (₹21,000 gross cap)',
      'Configure Karnataka PT: ₹0 (≤ ₹14,999) / ₹150/mo (₹15k–₹29,999) / ₹200/mo (≥ ₹30,000) — ₹2,400/yr max',
      'Enable TDS based on IT declaration',
      'Set LWF (Labour Welfare Fund) if applicable',
    ],
    page: 'Payroll',
    tip: 'Karnataka PT: ₹150/month (₹15k–₹29,999 gross) and ₹200/month (₹30,000+ gross) = ₹2,400/year max. ESI applies only to employees earning ≤ ₹21,000 gross/month. New joinees get proportional ESI for their joining month.',
  },
  {
    id: 'payroll_policies',
    title: 'Payroll Policies',
    subtitle: 'Set processing cycle, cut-off dates, and LOP rules',
    icon: IndianRupee,
    color: '#059669',
    desc: 'Define the payroll calendar, attendance lock date, and Loss of Pay (LOP) rules. These settings control when payroll can be processed and how attendance gaps affect pay.',
    tasks: [
      'Set monthly payroll processing date (e.g. 28th)',
      'Set attendance lock date (e.g. 25th)',
      'Configure LOP calculation method (calendar days or working days)',
      'Set arrear processing rules for mid-month joiners',
      'Configure advance salary rules (if enabled)',
      'Set payroll revision effective date policy',
    ],
    page: 'Payroll',
    tip: 'Lock attendance 3 days before payroll processing to allow HR time to correct exceptions. Never process payroll with unlocked attendance.',
  },
  {
    id: 'approvals',
    title: 'Payroll Approvals',
    subtitle: 'Configure who authorises payroll runs',
    icon: Users,
    color: '#d97706',
    desc: 'Set up the payroll approval chain. Typically HR prepares payroll, Finance reviews, and MD/CFO approves disbursement. Multi-level approval ensures compliance and prevents errors.',
    tasks: [
      'Assign HR Manager as payroll preparer',
      'Assign Finance Manager as first-level reviewer',
      'Assign MD/CFO as final approver',
      'Set approval deadline (24–48 hours)',
      'Configure bank transfer confirmation step',
      'Enable payslip distribution after approval',
    ],
    page: 'ApproverSetup',
    tip: 'Segregation of duties is a key audit requirement — the person who prepares payroll must not be the same person who approves it.',
  },
  {
    id: 'payslip',
    title: 'Payslip Template',
    subtitle: 'Configure payslip format and distribution',
    icon: FileText,
    color: '#8b5cf6',
    desc: 'Configure the payslip format to include your company logo, CIN, registered address, and all statutory components. Set up automatic email distribution to employees after payroll approval.',
    tasks: [
      'Upload company logo for payslip header',
      'Add CIN and GST number to payslip',
      'Configure earnings columns (Basic, HRA, Allowances)',
      'Configure deductions columns (PF, ESI, PT, TDS)',
      'Set email template for payslip distribution',
      'Test payslip PDF generation with sample employee',
    ],
    page: 'PayslipGenerator',
    tip: 'Password-protect payslip PDFs using employee DOB (DDMMYYYY format). This is expected by most employees and auditors.',
  },
  {
    id: 'activate',
    title: 'Activate Payroll',
    subtitle: 'Run first payroll and go live',
    icon: Zap,
    color: '#f59e0b',
    desc: 'Complete final validation and run the first payroll cycle. Process a test month with 2–3 employees before doing full company payroll. Verify statutory amounts match manual calculations.',
    tasks: [
      'Verify salary structures assigned to all employees',
      'Check PF/ESI eligibility flags on employee records',
      'Process test payroll for pilot employees',
      'Verify PF challan amounts match EPFO portal',
      'Verify ESI challan amounts match ESIC portal',
      'Run full payroll and distribute payslips',
    ],
    page: 'Payroll',
    tip: 'The first month\'s payroll typically takes 2x longer. Process it a week before month-end. By month 3 it should take under 2 hours.',
  },
];

const DEFAULT_GRADES = [
  { grade: 'A', label: 'Grade A — Senior / Manager',    basicPct: 50, hraPct: 50, specialAllowancePct: 10 },
  { grade: 'B', label: 'Grade B — Officer / Executive', basicPct: 45, hraPct: 40, specialAllowancePct: 10 },
  { grade: 'C', label: 'Grade C — Staff / Worker',      basicPct: 40, hraPct: 40, specialAllowancePct: 10 },
];

export default function PayrollSetupWizard({ setPage }) {
  const navigate = useNavigate();
  const [step, setStep]           = useState(0);
  const [completed, setCompleted] = useState(new Set());

  const [showGradeForm, setShowGradeForm] = useState(false);
  const [gradesSaving, setGradesSaving]   = useState(false);
  const [gradesMsg, setGradesMsg]         = useState('');
  const [salaryGrades, setSalaryGrades]   = useState(DEFAULT_GRADES);

  const goto = (page) => navigate(`/${page}`);
  const current = STEPS[step];
  const Icon = current.icon;

  const markDone = () => {
    setCompleted(prev => new Set([...prev, step]));
  };

  const finish = () => navigate('/SystemSettings');

  const saveGrades = async () => {
    setGradesSaving(true);
    setGradesMsg('');
    try {
      await Promise.all(
        (salaryGrades ?? []).map(g =>
          api.post('/salary-structures', {
            name: `Grade ${g.grade} — ${g.label.split('—')[1]?.trim() ?? g.label}`,
            description: 'Auto-created via Payroll Setup Wizard',
            is_default: g.grade === 'A',
            components: [
              { name: 'Basic',             type: 'earning',   calculation_type: 'percentage_of_ctc',   value: g?.basicPct ?? 40, is_taxable: true,  is_pf_applicable: true  },
              { name: 'HRA',               type: 'earning',   calculation_type: 'percentage_of_basic', value: g?.hraPct ?? 50,   is_taxable: false, is_pf_applicable: false },
              { name: 'Special Allowance', type: 'earning',   calculation_type: 'balancing',           value: 0,                 is_taxable: true,  is_pf_applicable: false },
              { name: 'Employee PF',       type: 'statutory', calculation_type: 'percentage_of_basic', value: 12,                is_taxable: false, is_pf_applicable: true  },
              { name: 'Professional Tax',  type: 'statutory', calculation_type: 'fixed',               value: 200,               is_taxable: false, is_pf_applicable: false },
            ],
          })
        )
      );
      setGradesMsg('✓ Grade A, B, C structures created');
      markDone();
      setTimeout(() => { setShowGradeForm(false); setGradesMsg(''); }, 1500);
    } catch (err) {
      setGradesMsg(err?.response?.data?.message ?? 'Save failed — check your connection');
    } finally {
      setGradesSaving(false);
    }
  };

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
              <div style={{ fontSize: 16, fontWeight: 800, color: '#1f2937' }}>Payroll Setup Wizard</div>
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

            {/* Inline Grade quick-configure form (salary_structures step only) */}
            {showGradeForm && current.id === 'salary_structures' && (
              <div style={{ padding: '20px 32px', borderBottom: '1px solid #f0f0f4', background: '#fafbff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>Quick-Configure Grade Structures</div>
                  <button onClick={() => setShowGradeForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}>
                    <X size={16} />
                  </button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f5f3ff' }}>
                        {['Grade', 'Basic % of CTC', 'HRA % of Basic', 'Spec. Allowance %', 'Preview (₹50k CTC)'].map(h => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: '#4c1d95', fontWeight: 600, borderBottom: '1px solid #e9e4ff' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {salaryGrades?.map((g, i) => {
                        const basic = Math.round(50000 * (g?.basicPct ?? 40) / 100);
                        const hra   = Math.round(basic  * (g?.hraPct ?? 50) / 100);
                        return (
                          <tr key={g.grade} style={{ borderBottom: '1px solid #f0ebff' }}>
                            <td style={{ padding: '8px 12px', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{g?.label}</td>
                            <td style={{ padding: '8px 12px' }}>
                              <input type="number" min={30} max={60} value={g?.basicPct ?? 40}
                                onChange={e => setSalaryGrades(gs => gs?.map((x, j) => j === i ? { ...x, basicPct: +e.target.value } : x))}
                                style={{ width: 64, padding: '5px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                            </td>
                            <td style={{ padding: '8px 12px' }}>
                              <input type="number" min={30} max={60} value={g?.hraPct ?? 50}
                                onChange={e => setSalaryGrades(gs => gs?.map((x, j) => j === i ? { ...x, hraPct: +e.target.value } : x))}
                                style={{ width: 64, padding: '5px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                            </td>
                            <td style={{ padding: '8px 12px' }}>
                              <input type="number" min={0} max={30} value={g?.specialAllowancePct ?? 10}
                                onChange={e => setSalaryGrades(gs => gs?.map((x, j) => j === i ? { ...x, specialAllowancePct: +e.target.value } : x))}
                                style={{ width: 64, padding: '5px 8px', border: '1px solid #e9e4ff', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                            </td>
                            <td style={{ padding: '8px 12px', fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>
                              Basic ₹{basic.toLocaleString('en-IN')} · HRA ₹{hra.toLocaleString('en-IN')} · PF ₹{Math.round(Math.min(basic, 15000) * 0.12).toLocaleString('en-IN')} · PT ₹200
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {gradesMsg && (
                  <div style={{ marginTop: 10, padding: '8px 14px', borderRadius: 7, fontSize: 13, fontWeight: 500,
                    background: gradesMsg.startsWith('✓') ? '#f0fdf4' : '#fef2f2',
                    color:      gradesMsg.startsWith('✓') ? '#16a34a' : '#dc2626',
                    border: `1px solid ${gradesMsg.startsWith('✓') ? '#bbf7d0' : '#fecaca'}` }}>
                    {gradesMsg}
                  </div>
                )}
                <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
                  <button
                    disabled={gradesSaving}
                    onClick={saveGrades}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 20px', borderRadius: 8,
                      border: 'none', background: P, color: '#fff', fontSize: 13, fontWeight: 600,
                      cursor: gradesSaving ? 'not-allowed' : 'pointer', opacity: gradesSaving ? 0.7 : 1 }}>
                    <CheckCircle size={14} /> {gradesSaving ? 'Saving…' : 'Save Grade Structures'}
                  </button>
                  <button onClick={() => setShowGradeForm(false)} style={{ padding: '8px 16px', borderRadius: 8,
                    border: '1px solid #e5e7eb', background: '#fff', fontSize: 13, color: '#6b7280', cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Pro tip */}
            <div style={{ padding: '16px 32px', background: '#fffbeb', borderBottom: '1px solid #fef3c7' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Star size={14} color="#d97706" style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12, color: '#92400e', lineHeight: 1.5 }}>
                  <strong>Pro tip:</strong> {current.tip}
                </div>
              </div>
            </div>

            {/* Navigation actions */}
            <div style={{ padding: '20px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button
                onClick={() => setStep(s => Math.max(0, s - 1))}
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
                {!completed.has(step) && (
                  <button
                    onClick={() => {
                      if (current.id === 'salary_structures') {
                        setShowGradeForm(f => !f);
                      } else {
                        markDone();
                        goto(current.page);
                      }
                    }}
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
                      background: '#10b981', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    <Zap size={14} /> Complete Setup
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
