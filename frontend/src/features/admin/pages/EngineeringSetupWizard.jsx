import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Layers, GitBranch, RotateCcw, CheckSquare, HardDrive,
  ChevronRight, ChevronLeft, Check, PlayCircle, CheckCircle, Star,
  Save, FolderOpen,
} from 'lucide-react';
import api from '@/services/api/client';

const P = '#6B3FDB';
const PL = '#f5f3ff';
const PB = '#e9e4ff';

const STEPS = [
  {
    id: 'bom',
    title: 'Configure BOM Policies',
    subtitle: 'Define Bill of Materials rules and structure',
    icon: Layers,
    color: '#6B3FDB',
    desc: 'Set up your Bill of Materials structure, revision control rules, multi-level BOM depth limits, and component linkage to inventory items.',
    tasks: [
      'Define BOM numbering convention (e.g. BOM-2024-001)',
      'Set maximum BOM depth (levels)',
      'Configure component-to-item-master linking',
      'Set default quantity precision (decimal places)',
      'Enable multi-variant BOM support',
    ],
    page: 'BOMBuilder',
    tip: 'Keep BOM depth to 5–6 levels max. Deeper BOMs cause MRP explosion performance issues.',
  },
  {
    id: 'ecn',
    title: 'Configure ECN Workflow',
    subtitle: 'Set engineering change notice approval process',
    icon: GitBranch,
    color: '#8b5cf6',
    desc: 'Configure the Engineering Change Notice (ECN) workflow — who initiates, who reviews, who approves, and what notifications go out when a BOM changes.',
    tasks: [
      'Define ECN types (Design Change, Material Change, Process Change)',
      'Set ECN initiator roles (Engineer, Design Lead)',
      'Configure ECN review board (multi-department)',
      'Set approval authority by change impact level',
      'Configure change effectivity (from serial / from date / immediate)',
    ],
    page: 'EngineeringDashboard',
    tip: 'For HVDC and power electronics, track change effectivity by serial number to maintain traceability.',
  },
  {
    id: 'revision',
    title: 'Configure Revision Rules',
    subtitle: 'Define version control for BOMs and drawings',
    icon: RotateCcw,
    color: '#0891b2',
    desc: 'Set up revision numbering, document version control, and obsolescence rules for BOMs, drawings, and technical specifications.',
    tasks: [
      'Set revision numbering scheme (Rev A, Rev 01, or semantic)',
      'Configure draft → review → released → obsolete states',
      'Set revision locking (no change after release)',
      'Configure drawing storage integration',
      'Enable auto-revision on ECN approval',
    ],
    page: 'DesignPhases',
    tip: 'Use semantic versioning (1.0.0, 1.1.0) for complex products — major.minor.patch tracks change impact.',
  },
  {
    id: 'approvals',
    title: 'Configure Approvals',
    subtitle: 'Engineering sign-off and review gates',
    icon: CheckSquare,
    color: '#d97706',
    desc: 'Define multi-level approval gates for BOM release, ECN sign-off, prototype test approval, and design freeze decisions.',
    tasks: [
      'Set BOM release approver (Design Lead → Engineering Manager)',
      'Configure ECN sign-off authority by change class',
      'Set prototype test approval chain',
      'Configure design review meeting gate',
      'Enable cross-functional approval (Mfg + Quality sign-off)',
    ],
    page: 'ApproverSetup',
    tip: 'Cross-functional BOM approval (Engineering + Manufacturing + Quality) prevents downstream surprises.',
  },
  {
    id: 'documents',
    title: 'Configure Document Storage',
    subtitle: 'Link engineering documents to ERP records',
    icon: HardDrive,
    color: '#059669',
    desc: 'Set up document storage for BOMs, drawings, datasheets, test reports, and compliance certificates. Link documents to BOM revisions and product records.',
    tasks: [
      'Configure document folder structure (by product family)',
      'Set document types and naming conventions',
      'Link document approval to BOM release workflow',
      'Enable version-controlled document archive',
      'Configure Google Drive or server path integration',
    ],
    page: 'DocumentMaster',
    tip: 'Naming convention: PROJ-DOCTYPE-REVNO (e.g. HVDC-BOM-R02.pdf) enables instant identification.',
  },
];

const DEFAULT_BOM = {
  numberingConvention: 'BOM-{YYYY}-{seq}',
  maxDepth: 5,
  componentLinking: true,
  decimalPrecision: 2,
  multiVariant: false,
};

const DEFAULT_DOCS = {
  engineeringFolderId: '',
  engineeringFolderName: '',
  namingConvention: 'PROJ-DOCTYPE-REVNO',
};

export default function EngineeringSetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [completed, setCompleted] = useState(new Set());

  // BOM policy form state
  const [showBomForm, setShowBomForm] = useState(false);
  const [bomForm, setBomForm] = useState(DEFAULT_BOM);
  const [bomSaving, setBomSaving] = useState(false);
  const [bomSaveMsg, setBomSaveMsg] = useState('');

  // Document storage form state
  const [showDocsForm, setShowDocsForm] = useState(false);
  const [docsForm, setDocsForm] = useState(DEFAULT_DOCS);
  const [docsSaving, setDocsSaving] = useState(false);
  const [docsSaveMsg, setDocsSaveMsg] = useState('');

  useEffect(() => {
    api.get('/v1/engineering/settings/bom-policies')
      .then(r => {
        const s = r.data;
        if (s && Object.keys(s).length) {
          setBomForm({
            numberingConvention: s.numberingConvention ?? DEFAULT_BOM.numberingConvention,
            maxDepth:            s.maxDepth            ?? DEFAULT_BOM.maxDepth,
            componentLinking:    s.componentLinking    ?? DEFAULT_BOM.componentLinking,
            decimalPrecision:    s.decimalPrecision    ?? DEFAULT_BOM.decimalPrecision,
            multiVariant:        s.multiVariant        ?? DEFAULT_BOM.multiVariant,
          });
          setCompleted(prev => new Set([...prev, 0]));
        }
      })
      .catch(() => {});

    api.get('/v1/engineering/settings/docs')
      .then(r => {
        const s = r.data;
        if (s && Object.keys(s).length) {
          setDocsForm({
            engineeringFolderId:   s.engineeringFolderId   ?? '',
            engineeringFolderName: s.engineeringFolderName ?? '',
            namingConvention:      s.namingConvention      ?? DEFAULT_DOCS.namingConvention,
          });
          setCompleted(prev => new Set([...prev, 4]));
        }
      })
      .catch(() => {});
  }, []);

  const goto = (page) => navigate(`/${page}`);
  const current = STEPS[step];
  const Icon = current.icon;

  const markDone = (idx = step) => setCompleted(prev => new Set([...prev, idx]));
  const finish = () => navigate('/SystemSettings');

  const saveBomPolicies = async () => {
    setBomSaving(true);
    setBomSaveMsg('');
    try {
      await api.post('/v1/engineering/settings/bom-policies', bomForm);
      markDone(0);
      setShowBomForm(false);
      setBomSaveMsg('Saved');
    } catch {
      setBomSaveMsg('Save failed — please retry');
    } finally {
      setBomSaving(false);
    }
  };

  const saveDocSettings = async () => {
    setDocsSaving(true);
    setDocsSaveMsg('');
    try {
      await api.post('/v1/engineering/settings/docs', docsForm);
      markDone(4);
      setShowDocsForm(false);
      setDocsSaveMsg('Saved');
    } catch {
      setDocsSaveMsg('Save failed — please retry');
    } finally {
      setDocsSaving(false);
    }
  };

  const handleConfigureNow = () => {
    if (step === 0) { setShowBomForm(true); return; }
    if (step === 4) { setShowDocsForm(true); return; }
    markDone();
    goto(current.page);
  };

  return (
    <div style={{ minHeight: '100vh', background: '#fafbff', fontFamily: 'inherit' }}>

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
              <div style={{ fontSize: 16, fontWeight: 800, color: '#1f2937' }}>Engineering Setup Wizard</div>
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

        {/* Sidebar */}
        <div style={{ width: 240, flexShrink: 0 }}>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #f0f0f4', padding: '16px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af',
              textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12, paddingLeft: 8 }}>
              Setup Steps
            </div>
            {STEPS.map((s, i) => {
              const SIcon = s.icon;
              const isDone = completed.has(i);
              const isActive = i === step;
              return (
                <button key={s.id} onClick={() => setStep(i)} style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 10px', borderRadius: 8, border: 'none',
                  background: isActive ? PL : 'transparent',
                  cursor: 'pointer', textAlign: 'left', marginBottom: 2,
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                    background: isDone ? '#d1fae5' : isActive ? PB : '#f3f4f6',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: isActive ? `2px solid ${P}` : '2px solid transparent',
                  }}>
                    {isDone ? <Check size={13} color="#10b981" strokeWidth={3} />
                      : <SIcon size={13} color={isActive ? P : '#9ca3af'} />}
                  </div>
                  <div>
                    <div style={{
                      fontSize: 12, fontWeight: isActive ? 700 : 500,
                      color: isActive ? P : isDone ? '#374151' : '#6b7280',
                    }}>{s.title}</div>
                    {isDone && <div style={{ fontSize: 10, color: '#10b981' }}>Completed</div>}
                  </div>
                </button>
              );
            })}
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
                  width: `${(completed.size / STEPS.length) * 100}%`, transition: 'width 0.3s',
                }} />
              </div>
            </div>
          </div>
        </div>

        {/* Main panel */}
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
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#065f46',
                        background: '#d1fae5', padding: '2px 8px', borderRadius: 20 }}>
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

            {/* BOM Policies inline form (step 0) */}
            {step === 0 && showBomForm && (
              <div style={{ padding: '24px 32px', borderBottom: '1px solid #f0f0f4', background: '#fdfcff' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af',
                  textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16 }}>
                  BOM Policy Configuration
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                      Numbering Convention
                    </span>
                    <input
                      value={bomForm.numberingConvention ?? DEFAULT_BOM.numberingConvention}
                      onChange={e => setBomForm(f => ({ ...f, numberingConvention: e.target.value }))}
                      placeholder="BOM-{YYYY}-{seq}"
                      style={{
                        padding: '8px 10px', borderRadius: 7, border: '1px solid #e9e4ff',
                        fontSize: 13, color: '#1f2937', outline: 'none',
                      }}
                    />
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>
                      Tokens: {'{YYYY}'} year · {'{MM}'} month · {'{seq}'} sequence
                    </span>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                      Maximum BOM Depth (levels)
                    </span>
                    <input
                      type="number" min={1} max={20}
                      value={bomForm.maxDepth ?? DEFAULT_BOM.maxDepth}
                      onChange={e => setBomForm(f => ({ ...f, maxDepth: Number(e.target.value) }))}
                      style={{
                        padding: '8px 10px', borderRadius: 7, border: '1px solid #e9e4ff',
                        fontSize: 13, color: '#1f2937', outline: 'none',
                      }}
                    />
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>Recommended: 5–6</span>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                      Quantity Decimal Precision
                    </span>
                    <input
                      type="number" min={0} max={6}
                      value={bomForm.decimalPrecision ?? DEFAULT_BOM.decimalPrecision}
                      onChange={e => setBomForm(f => ({ ...f, decimalPrecision: Number(e.target.value) }))}
                      style={{
                        padding: '8px 10px', borderRadius: 7, border: '1px solid #e9e4ff',
                        fontSize: 13, color: '#1f2937', outline: 'none',
                      }}
                    />
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>Decimal places for component quantities</span>
                  </label>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={bomForm.componentLinking ?? DEFAULT_BOM.componentLinking}
                        onChange={e => setBomForm(f => ({ ...f, componentLinking: e.target.checked }))}
                        style={{ width: 16, height: 16, accentColor: P }}
                      />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                          Component-to-Item-Master Linking
                        </div>
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>
                          Enforce that every BOM component maps to an item in inventory
                        </div>
                      </div>
                    </label>

                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={bomForm.multiVariant ?? DEFAULT_BOM.multiVariant}
                        onChange={e => setBomForm(f => ({ ...f, multiVariant: e.target.checked }))}
                        style={{ width: 16, height: 16, accentColor: P }}
                      />
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                          Multi-Variant BOM Support
                        </div>
                        <div style={{ fontSize: 10, color: '#9ca3af' }}>
                          Allow multiple BOM variants per product (e.g. HVDC-500kV vs HVDC-230kV)
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
                  <button
                    onClick={saveBomPolicies}
                    disabled={bomSaving}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '9px 20px', borderRadius: 8, border: 'none',
                      background: bomSaving ? '#a78bfa' : P,
                      color: '#fff', fontSize: 13, fontWeight: 600,
                      cursor: bomSaving ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <Save size={14} /> {bomSaving ? 'Saving…' : 'Save BOM Policies'}
                  </button>
                  <button
                    onClick={() => setShowBomForm(false)}
                    style={{
                      padding: '9px 16px', borderRadius: 8, border: '1px solid #e5e7eb',
                      background: '#fff', fontSize: 13, color: '#6b7280', cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  {bomSaveMsg && (
                    <span style={{ fontSize: 12, color: bomSaveMsg === 'Saved' ? '#10b981' : '#ef4444' }}>
                      {bomSaveMsg}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Document Storage inline form (step 4) */}
            {step === 4 && showDocsForm && (
              <div style={{ padding: '24px 32px', borderBottom: '1px solid #f0f0f4', background: '#f0fdf4' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af',
                  textTransform: 'uppercase', letterSpacing: 1, marginBottom: 16 }}>
                  Google Drive — Engineering Folder Configuration
                </div>

                <div style={{
                  padding: '12px 16px', borderRadius: 8, background: '#ecfdf5',
                  border: '1px solid #bbf7d0', marginBottom: 16, fontSize: 12, color: '#065f46',
                }}>
                  <strong>Folder hierarchy:</strong> DRIVE_ROOT / Engineering / [Product Family] / [Doc Type]<br />
                  Engineering folder is auto-created by the Google Drive service when documents are uploaded.
                  Paste the Google Drive root folder ID from your Drive URL to link it here.
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                      Google Drive Root Folder ID
                    </span>
                    <input
                      value={docsForm.engineeringFolderId}
                      onChange={e => setDocsForm(f => ({ ...f, engineeringFolderId: e.target.value.trim() }))}
                      placeholder="1AbCdEfGhIjKlMnOpQ…"
                      style={{
                        padding: '8px 10px', borderRadius: 7, border: '1px solid #bbf7d0',
                        fontSize: 13, color: '#1f2937', outline: 'none',
                      }}
                    />
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>
                      Found in the Drive URL: /folders/[FOLDER_ID]
                    </span>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                      Engineering Folder Name
                    </span>
                    <input
                      value={docsForm.engineeringFolderName}
                      onChange={e => setDocsForm(f => ({ ...f, engineeringFolderName: e.target.value }))}
                      placeholder="Engineering Documents"
                      style={{
                        padding: '8px 10px', borderRadius: 7, border: '1px solid #bbf7d0',
                        fontSize: 13, color: '#1f2937', outline: 'none',
                      }}
                    />
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>
                      Label used in ERP document links
                    </span>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4, gridColumn: 'span 2' }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                      File Naming Convention
                    </span>
                    <input
                      value={docsForm.namingConvention}
                      onChange={e => setDocsForm(f => ({ ...f, namingConvention: e.target.value }))}
                      placeholder="PROJ-DOCTYPE-REVNO"
                      style={{
                        padding: '8px 10px', borderRadius: 7, border: '1px solid #bbf7d0',
                        fontSize: 13, color: '#1f2937', outline: 'none',
                      }}
                    />
                    <span style={{ fontSize: 10, color: '#9ca3af' }}>
                      Example: HVDC-BOM-R02.pdf — enables instant identification in shared folders
                    </span>
                  </label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
                  <button
                    onClick={saveDocSettings}
                    disabled={docsSaving}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '9px 20px', borderRadius: 8, border: 'none',
                      background: docsSaving ? '#6ee7b7' : '#059669',
                      color: '#fff', fontSize: 13, fontWeight: 600,
                      cursor: docsSaving ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <Save size={14} /> {docsSaving ? 'Saving…' : 'Save Document Config'}
                  </button>
                  <button
                    onClick={() => goto('DocumentMaster')}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '9px 16px', borderRadius: 8, border: '1px solid #bbf7d0',
                      background: '#f0fdf4', fontSize: 13, color: '#059669', cursor: 'pointer',
                    }}
                  >
                    <FolderOpen size={14} /> Open Document Master
                  </button>
                  <button
                    onClick={() => setShowDocsForm(false)}
                    style={{
                      padding: '9px 16px', borderRadius: 8, border: '1px solid #e5e7eb',
                      background: '#fff', fontSize: 13, color: '#6b7280', cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  {docsSaveMsg && (
                    <span style={{ fontSize: 12, color: docsSaveMsg === 'Saved' ? '#10b981' : '#ef4444' }}>
                      {docsSaveMsg}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Checklist */}
            <div style={{ padding: '24px 32px', borderBottom: '1px solid #f0f0f4' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#9ca3af',
                textTransform: 'uppercase', letterSpacing: 1, marginBottom: 14 }}>
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
                        : <span style={{ fontSize: 9, fontWeight: 800, color: P }}>{i + 1}</span>}
                    </div>
                    <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5 }}>{task}</div>
                  </div>
                ))}
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

            {/* Navigation */}
            <div style={{ padding: '20px 32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button
                onClick={() => { setShowBomForm(false); setShowDocsForm(false); setStep(s => Math.max(0, s - 1)); }}
                disabled={step === 0}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '9px 18px', borderRadius: 8, border: '1px solid #e5e7eb',
                  background: step === 0 ? '#f9fafb' : '#fff',
                  color: step === 0 ? '#d1d5db' : '#374151',
                  fontSize: 13, fontWeight: 600, cursor: step === 0 ? 'not-allowed' : 'pointer',
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
                {step < STEPS.length - 1 ? (
                  <button
                    onClick={() => { setShowBomForm(false); setShowDocsForm(false); if (!completed.has(step)) markDone(); setStep(s => s + 1); }}
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
