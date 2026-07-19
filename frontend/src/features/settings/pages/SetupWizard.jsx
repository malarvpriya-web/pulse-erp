import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api/client';
import { useSetupProgress } from '@/hooks/useSetupProgress';
import {
  Building2, Network, Users, Shield, IndianRupee, Calendar, Plug,
  Check, ChevronLeft, ChevronRight, X, Plus, Trash2, CheckCircle,
  Upload, RefreshCw, Zap, AlertCircle, LogOut, Eye, EyeOff, Landmark,
} from 'lucide-react';
import '@/features/settings/SetupWizard.css';

// ── Step catalogue ────────────────────────────────────────────────────────────
const STEPS = [
  { key: 'company',      label: 'Company Info',           icon: Building2  },
  { key: 'organization', label: 'Organization Structure', icon: Network    },
  { key: 'users',        label: 'User Accounts',          icon: Users      },
  { key: 'roles',        label: 'Roles & Permissions',    icon: Shield     },
  { key: 'payroll',      label: 'Payroll Structure',      icon: IndianRupee },
  { key: 'finance',      label: 'Bank Accounts',          icon: Landmark   },
  { key: 'leaves',       label: 'Leave Policies',         icon: Calendar   },
  { key: 'integrations', label: 'Integrations',           icon: Plug       },
];

// ── Permission matrix config ──────────────────────────────────────────────────
const PERM_MODULES = [
  'Employees', 'HR', 'Finance', 'CRM', 'Inventory', 'Projects',
  'Timesheets', 'Attendance', 'Leaves', 'Procurement', 'Production',
  'Service Desk', 'Reports', 'Analytics', 'Admin',
];
const PERM_ACTIONS = ['view', 'create', 'edit', 'delete'];

const ROLE_TEMPLATES = {
  Manager: {
    Employees: { view: true }, HR: { view: true }, Finance: {},
    CRM: { view: true }, Inventory: { view: true },
    Projects: { view: true, create: true, edit: true },
    Timesheets: { view: true, create: true }, Attendance: { view: true },
    Leaves: { view: true, create: true }, Procurement: { view: true },
    Production: { view: true }, 'Service Desk': { view: true },
    Reports: { view: true }, Analytics: { view: true }, Admin: {},
  },
  HR: {
    Employees: { view: true, create: true, edit: true, delete: true },
    HR: { view: true, create: true, edit: true, delete: true },
    Finance: { view: true }, CRM: {}, Inventory: {},
    Projects: { view: true }, Timesheets: { view: true },
    Attendance: { view: true, create: true, edit: true },
    Leaves: { view: true, create: true, edit: true, delete: true },
    Procurement: {}, Production: {}, 'Service Desk': { view: true },
    Reports: { view: true }, Analytics: { view: true }, Admin: {},
  },
  Finance: {
    Employees: { view: true }, HR: { view: true },
    Finance: { view: true, create: true, edit: true, delete: true },
    CRM: { view: true }, Inventory: { view: true },
    Projects: { view: true }, Timesheets: { view: true },
    Attendance: {}, Leaves: {},
    Procurement: { view: true, create: true }, Production: { view: true },
    'Service Desk': { view: true }, Reports: { view: true }, Analytics: { view: true }, Admin: {},
  },
  Employee: {
    Employees: {}, HR: {}, Finance: {}, CRM: {}, Inventory: {},
    Projects: {}, Timesheets: { view: true, create: true, edit: true },
    Attendance: { view: true, create: true },
    Leaves: { view: true, create: true },
    Procurement: {}, Production: {}, 'Service Desk': { view: true, create: true },
    Reports: {}, Analytics: {}, Admin: {},
  },
};

function emptyPerms() {
  return Object.fromEntries(PERM_MODULES.map(m => [m, {}]));
}

// ── CSV parser (no external libs) ────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], errorCount: 0 };
  const headers = lines[0].split(',').map(h =>
    h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z_]/g, '')
  );
  const rows = [];
  let errorCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map(c => c.trim());
    if (!cells.some(Boolean)) continue;
    if (cells.length < 2) { errorCount++; continue; }
    const row = { _id: `csv_${i}_${Date.now()}` };
    headers.forEach((h, idx) => { row[h] = cells[idx] || ''; });
    if (!row.name && !row.email) { errorCount++; continue; }
    rows.push({
      _id: row._id,
      name: row.name || '',
      email: row.email || '',
      department: row.department || '',
      designation: row.designation || '',
      role: row.role || 'employee',
    });
  }
  return { rows, errorCount };
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// ── Toggle helper ─────────────────────────────────────────────────────────────
function Toggle({ checked, onChange, label }) {
  return (
    <label className="wiz-toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="wiz-toggle-track">
        <span className="wiz-toggle-thumb" />
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}

// ── Step 1 — Company Info ─────────────────────────────────────────────────────
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_RE   = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

const INDUSTRY_OPTIONS = [
  'Electrical Equipment Manufacturing', 'Technology', 'Manufacturing',
  'Trading', 'Services', 'Healthcare', 'Education', 'Other',
];

function StepCompany({ data, onChange }) {
  const [logoPreview, setLogoPreview] = useState(null);
  const [errors, setErrors]           = useState({});
  const fileRef = useRef(null);

  const handleLogoChange = (e) => {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => setLogoPreview(ev.target.result);
    reader.readAsDataURL(file);
    onChange('logo', file);
  };

  const set = (k) => (e) => {
    let val = e.target.value;
    if (k === 'gstin' || k === 'pan' || k === 'cin') val = val.toUpperCase();
    onChange(k, val);
    if (errors[k]) setErrors(prev => ({ ...prev, [k]: '' }));
  };

  const validateField = (k) => () => {
    const val = (data[k] ?? '').trim();
    if (k === 'gstin' && val && !GSTIN_RE.test(val)) {
      setErrors(prev => ({ ...prev, gstin: 'Invalid GSTIN. Expected: 29AAAAA0000A1Z5' }));
    } else if (k === 'pan' && val && !PAN_RE.test(val)) {
      setErrors(prev => ({ ...prev, pan: 'Invalid PAN. Expected: AAAAA0000A' }));
    }
  };

  return (
    <div>
      <div className="wizard-section">
        <div className="wizard-section-title">Basic Information</div>
        <div className="wizard-grid-2">
          <div className="wizard-field">
            <label>Company Name <span className="req">*</span></label>
            <input type="text" value={data.company_name ?? ''} onChange={set('company_name')}
              placeholder="e.g. Manifest Technologies Pvt. Ltd." />
          </div>
          <div className="wizard-field">
            <label>Legal Name</label>
            <input type="text" value={data.legal_name ?? ''} onChange={set('legal_name')}
              placeholder="Official registered name" />
          </div>
          <div className="wizard-field">
            <label>GSTIN</label>
            <input type="text" value={data.gstin ?? ''} onChange={set('gstin')}
              onBlur={validateField('gstin')}
              placeholder="29AAAAA0000A1Z5" maxLength={15}
              className={errors.gstin ? 'error' : undefined} />
            {errors.gstin
              ? <div className="wizard-field-error">{errors.gstin}</div>
              : <div className="wizard-field-hint">First 2 digits = state code (29 = Karnataka). Auto-sets GST state.</div>
            }
          </div>
          <div className="wizard-field">
            <label>PAN</label>
            <input type="text" value={data.pan ?? ''} onChange={set('pan')}
              onBlur={validateField('pan')}
              placeholder="AAAAA0000A" maxLength={10}
              className={errors.pan ? 'error' : undefined} />
            {errors.pan && <div className="wizard-field-error">{errors.pan}</div>}
          </div>
          <div className="wizard-field">
            <label>CIN</label>
            <input type="text" value={data.cin ?? ''} onChange={set('cin')}
              placeholder="Company Identification Number" maxLength={21} />
          </div>
        </div>
      </div>

      <div className="wizard-section">
        <div className="wizard-section-title">Company Profile</div>
        <div className="wizard-grid-2">
          <div className="wizard-field">
            <label>Industry</label>
            <select value={data.industry ?? ''} onChange={set('industry')}>
              <option value="">Select industry</option>
              {INDUSTRY_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div className="wizard-field">
            <label>Company Size</label>
            <select value={data.company_size ?? ''} onChange={set('company_size')}>
              <option value="">Select size</option>
              {['1-10', '11-50', '51-200', '201-1000', '1000+']
                .map(v => <option key={v} value={v}>{v} employees</option>)}
            </select>
          </div>
          <div className="wizard-field">
            <label>Financial Year Start</label>
            <select value={data.fy_start ?? 'April'} onChange={set('fy_start')}>
              <option value="">Select month</option>
              <option value="April">April (India standard)</option>
              <option value="January">January (Calendar year)</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>
        <div className="wizard-field">
          <label>Registered Address</label>
          <textarea value={data.address ?? ''} onChange={set('address')}
            placeholder="Full registered office address including pin code" rows={3} />
        </div>
      </div>

      <div className="wizard-section">
        <div className="wizard-section-title">Company Logo</div>
        <div className="logo-upload-area" onClick={() => fileRef.current?.click()}>
          <div className="logo-preview-circle">
            {logoPreview
              ? <img src={logoPreview} alt="Logo preview" />
              : <Building2 size={24} color="#9ca3af" />
            }
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
              {logoPreview ? 'Click to change logo' : 'Click to upload logo'}
            </div>
            <div style={{ fontSize: 11, color: '#9ca3af' }}>PNG, JPG, SVG up to 2MB. Square preferred.</div>
          </div>
          <Upload size={16} color="#9ca3af" style={{ marginLeft: 'auto' }} />
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
          onChange={handleLogoChange} />
      </div>
    </div>
  );
}

// ── Step 2 — Organization Structure ──────────────────────────────────────────
function StepOrganization({ data, onChange }) {
  const [newDesig, setNewDesig] = useState({});

  const addDept = () => {
    const id = Date.now();
    onChange('departments', [
      ...data.departments,
      { id, name: '', designations: [] },
    ]);
  };

  const removeDept = (id) => {
    onChange('departments', data.departments.filter(d => d.id !== id));
  };

  const updateDeptName = (id, name) => {
    onChange('departments', data.departments.map(d => d.id === id ? { ...d, name } : d));
  };

  const addDesig = (deptId) => {
    const val = (newDesig[deptId] || '').trim();
    if (!val) return;
    onChange('departments', data.departments.map(d =>
      d.id === deptId
        ? { ...d, designations: [...d.designations, val] }
        : d
    ));
    setNewDesig(prev => ({ ...prev, [deptId]: '' }));
  };

  const removeDesig = (deptId, idx) => {
    onChange('departments', data.departments.map(d =>
      d.id === deptId
        ? { ...d, designations: d.designations.filter((_, i) => i !== idx) }
        : d
    ));
  };

  const totalDesig = data.departments.reduce((sum, d) => sum + d.designations.length, 0);

  return (
    <div>
      <div className="wizard-info-banner">
        Build your org structure below. Each department can have its own designations (job titles). You can add more from Master Setup later.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          <strong style={{ color: '#1f2937' }}>{data.departments.length}</strong> departments &middot;{' '}
          <strong style={{ color: '#1f2937' }}>{totalDesig}</strong> designations ready to create
        </div>
        <button className="btn-sm" onClick={addDept}>
          <Plus size={12} /> Add Department
        </button>
      </div>

      {data.departments.map((dept) => (
        <div className="dept-row" key={dept.id}>
          <div className="dept-header">
            <Building2 size={14} color="#9ca3af" />
            <input
              value={dept.name}
              onChange={e => updateDeptName(dept.id, e.target.value)}
              placeholder="Department name"
            />
            <button className="btn-icon" onClick={() => removeDept(dept.id)}>
              <Trash2 size={13} />
            </button>
          </div>

          <div className="desig-chips">
            {dept.designations.map((d, i) => (
              <span className="desig-chip" key={i}>
                {d}
                <button onClick={() => removeDesig(dept.id, i)} title="Remove">
                  <X size={9} />
                </button>
              </span>
            ))}
            {dept.designations.length === 0 && (
              <span style={{ fontSize: 11, color: '#d1d5db', fontStyle: 'italic' }}>
                No designations yet
              </span>
            )}
          </div>

          <div className="desig-add-row">
            <input
              className="desig-add-input"
              value={newDesig[dept.id] || ''}
              onChange={e => setNewDesig(prev => ({ ...prev, [dept.id]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') addDesig(dept.id); }}
              placeholder="Add designation (e.g. Software Engineer)"
            />
            <button className="btn-sm" onClick={() => addDesig(dept.id)}
              disabled={!(newDesig[dept.id] || '').trim()}>
              <Plus size={11} /> Add
            </button>
          </div>
        </div>
      ))}

      {data.departments.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: '#9ca3af', fontSize: 13 }}>
          No departments yet. Click "Add Department" to get started.
        </div>
      )}
    </div>
  );
}

// ── Step 3 — User Accounts ────────────────────────────────────────────────────
function StepUsers({ data, onChange, orgDepts = [] }) {
  const [csvError, setCsvError] = useState(null);
  const [parseInfo, setParseInfo] = useState(null);
  const csvRef = useRef(null);

  const addRow = () => {
    onChange('rows', [
      ...data.rows,
      { _id: `row_${Date.now()}`, name: '', email: '', department: '', designation: '', role: 'employee' },
    ]);
  };

  const updateRow = (id, field, value) => {
    onChange('rows', data.rows.map(r => r._id === id ? { ...r, [field]: value } : r));
  };

  const removeRow = (id) => {
    onChange('rows', data.rows.filter(r => r._id !== id));
  };

  const handleCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { rows, errorCount } = parseCSV(ev.target.result);
      if (rows.length === 0) {
        setCsvError('No valid rows found. Expected headers: Name, Email, Department, Designation, Role');
        return;
      }
      setCsvError(null);
      setParseInfo(`Imported ${rows.length} users${errorCount > 0 ? ` (${errorCount} rows skipped)` : ''}`);
      onChange('rows', [...data.rows, ...rows]);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const validCount = data.rows.filter(r => r.name && isValidEmail(r.email)).length;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          <strong style={{ color: '#1f2937' }}>{validCount}</strong> of{' '}
          {data.rows.length} users valid
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-sm" onClick={() => csvRef.current?.click()}>
            <Upload size={11} /> Import CSV
          </button>
          <input ref={csvRef} type="file" accept=".csv,text/plain" style={{ display: 'none' }}
            onChange={handleCSV} />
          <button className="btn-sm" onClick={addRow}>
            <Plus size={11} /> Add User
          </button>
        </div>
      </div>

      {csvError && (
        <div className="wizard-error-banner" style={{ marginBottom: 12 }}>
          <AlertCircle size={14} /> {csvError}
        </div>
      )}
      {parseInfo && !csvError && (
        <div className="wizard-info-banner" style={{ marginBottom: 12 }}>
          {parseInfo}. CSV format: Name, Email, Department, Designation, Role
        </div>
      )}

      {data.rows.length > 0 ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="user-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Department</th>
                <th>Designation</th>
                <th>Role</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(row => (
                <tr key={row._id}>
                  <td>
                    <input type="text" value={row.name} placeholder="Full name"
                      className={!row.name ? 'invalid' : ''}
                      onChange={e => updateRow(row._id, 'name', e.target.value)} />
                  </td>
                  <td>
                    <input type="email" value={row.email} placeholder="user@company.com"
                      className={row.email && !isValidEmail(row.email) ? 'invalid' : ''}
                      onChange={e => updateRow(row._id, 'email', e.target.value)} />
                  </td>
                  <td>
                    {orgDepts.length > 0 ? (
                      <select value={row.department} onChange={e => updateRow(row._id, 'department', e.target.value)}>
                        <option value="">-- Department --</option>
                        {orgDepts.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                      </select>
                    ) : (
                      <input type="text" value={row.department} placeholder="Department"
                        onChange={e => updateRow(row._id, 'department', e.target.value)} />
                    )}
                  </td>
                  <td>
                    <select value={row.designation} onChange={e => updateRow(row._id, 'designation', e.target.value)}>
                      <option value="">-- Designation --</option>
                      {['CEO','CTO','CFO','COO','CMO','Director','VP','General Manager','Manager','Senior Manager','Deputy Manager','Assistant Manager','Team Lead','Senior Engineer','Engineer','Analyst','Consultant','Executive','Officer','Supervisor','Other'].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={row.role}
                      onChange={e => updateRow(row._id, 'role', e.target.value)}>
                      <option value="employee">Employee</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                      <option value="hr">HR</option>
                    </select>
                  </td>
                  <td>
                    <button className="btn-icon" onClick={() => removeRow(row._id)}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '40px 20px', color: '#9ca3af', fontSize: 13,
          border: '1.5px dashed #e5e7eb', borderRadius: 10, background: '#fafbff' }}>
          <Users size={28} color="#e5e7eb" style={{ marginBottom: 10 }} />
          <div style={{ marginBottom: 6 }}>No users added yet</div>
          <div style={{ fontSize: 11 }}>Click "Add User" or "Import CSV" to get started</div>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 11, color: '#9ca3af' }}>
        CSV format (first row must be headers): <code>Name, Email, Department, Designation, Role</code>
      </div>
    </div>
  );
}

// ── Step 4 — Roles & Permissions ─────────────────────────────────────────────
function StepRoles({ data, onChange }) {
  const [showCreate, setShowCreate] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', description: '', perms: emptyPerms() });

  const applyTemplate = (tplName) => {
    setNewRole(prev => ({ ...prev, perms: { ...ROLE_TEMPLATES[tplName] } }));
  };

  const togglePerm = (mod, action) => {
    setNewRole(prev => ({
      ...prev,
      perms: {
        ...prev.perms,
        [mod]: { ...prev.perms[mod], [action]: !prev.perms[mod][action] },
      },
    }));
  };

  const saveNewRole = () => {
    if (!newRole.name.trim()) return;
    const permCount = Object.values(newRole.perms).reduce(
      (sum, p) => sum + Object.values(p).filter(Boolean).length, 0
    );
    onChange('newRoles', [...data.newRoles, { ...newRole, permCount }]);
    setNewRole({ name: '', description: '', perms: emptyPerms() });
    setShowCreate(false);
  };

  const removeNew = (idx) => {
    onChange('newRoles', data.newRoles.filter((_, i) => i !== idx));
  };

  return (
    <div>
      {/* Existing roles */}
      {data.existing.length > 0 && (
        <div className="wizard-section">
          <div className="wizard-section-title">Existing Roles</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.existing.map(r => (
              <div className="role-card" key={r.id || r.name}>
                <div className="role-card-icon">
                  <Shield size={16} color="#6B3FDB" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', marginBottom: 2 }}>
                    {r.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{r.description || 'No description'}</div>
                </div>
                <div className="role-perm-badge">
                  {r.permission_count || 0} permissions
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* New roles to create */}
      {data.newRoles.length > 0 && (
        <div className="wizard-section">
          <div className="wizard-section-title">New Roles to Create</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.newRoles.map((r, i) => (
              <div className="role-card" key={i}>
                <div className="role-card-icon">
                  <Shield size={16} color="#6B3FDB" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#1f2937', marginBottom: 2 }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{r.description || 'No description'}</div>
                </div>
                <div className="role-perm-badge">{r.permCount} permissions</div>
                <button className="btn-icon" onClick={() => removeNew(i)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Create role form */}
      {showCreate ? (
        <div style={{ border: '1.5px solid #e9e4ff', borderRadius: 12, padding: 20, background: '#fafbff' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937', marginBottom: 16 }}>
            Create New Role
          </div>

          <div className="wizard-grid-2" style={{ marginBottom: 16 }}>
            <div className="wizard-field">
              <label>Role Name <span className="req">*</span></label>
              <input type="text" value={newRole.name}
                onChange={e => setNewRole(p => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Senior Manager" />
            </div>
            <div className="wizard-field">
              <label>Description</label>
              <input type="text" value={newRole.description}
                onChange={e => setNewRole(p => ({ ...p, description: e.target.value }))}
                placeholder="Brief description" />
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px' }}>
              Quick Templates
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.keys(ROLE_TEMPLATES).map(t => (
                <button key={t} className="template-btn" onClick={() => applyTemplate(t)}>
                  {t} template
                </button>
              ))}
            </div>
          </div>

          <div className="perm-matrix-wrap">
            <table className="perm-matrix">
              <thead>
                <tr>
                  <th>Module</th>
                  {PERM_ACTIONS.map(a => <th key={a}>{a.charAt(0).toUpperCase() + a.slice(1)}</th>)}
                </tr>
              </thead>
              <tbody>
                {PERM_MODULES.map(mod => (
                  <tr key={mod}>
                    <td style={{ fontWeight: 500, color: '#374151' }}>{mod}</td>
                    {PERM_ACTIONS.map(action => (
                      <td key={action}>
                        <input type="checkbox"
                          checked={!!(newRole.perms[mod] && newRole.perms[mod][action])}
                          onChange={() => togglePerm(mod, action)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn-primary" onClick={saveNewRole} disabled={!newRole.name.trim()}>
              <Check size={13} /> Add Role
            </button>
          </div>
        </div>
      ) : (
        <button className="btn-ghost" style={{ width: '100%', justifyContent: 'center', padding: '12px 0' }}
          onClick={() => setShowCreate(true)}>
          <Plus size={14} /> Create New Role
        </button>
      )}
    </div>
  );
}

// ── Step 5 — Payroll Structure ────────────────────────────────────────────────
function StepPayroll({ data, onChange }) {
  const set = (key) => (val) => onChange(key, val);
  const setComp = (comp, field) => (val) => {
    onChange('components', { ...data.components, [comp]: { ...data.components[comp], [field]: val } });
  };
  const setDeduction = (type, field) => (val) => {
    onChange(type, { ...data[type], [field]: val });
  };

  const breakdown = useMemo(() => {
    const annual = Math.max(0, Number(data.sample_ctc)) || 600000;
    const monthly = Math.round(annual / 12);
    const c = data.components;

    const basic = c.basic.enabled ? Math.round(monthly * (c.basic.pct / 100)) : 0;
    const hra = c.hra.enabled ? Math.round(basic * (c.hra.pct / 100)) : 0;
    const conv = c.conveyance.enabled ? Math.min(1600, Math.round(monthly * (c.conveyance.pct / 100))) : 0;
    const med = c.medical.enabled ? Math.min(1250, Math.round(monthly * (c.medical.pct / 100))) : 0;
    const lta = c.lta.enabled ? Math.round(basic * (c.lta.pct / 100)) : 0;
    const special = Math.max(0, monthly - basic - hra - conv - med - lta);
    const gross = basic + hra + conv + med + lta + special;

    const pf = data.pf.enabled ? Math.round(basic * (Number(data.pf.emp_pct) / 100)) : 0;
    const esi = (data.esi.enabled && gross <= 21000)
      ? Math.round(gross * (Number(data.esi.emp_pct) / 100)) : 0;
    const net = gross - pf - esi;

    return { monthly, basic, hra, conv, med, lta, special, gross, pf, esi, net };
  }, [data]);

  const fmt = (n) => `₹${n.toLocaleString('en-IN')}`;

  const COMPONENTS = [
    { key: 'basic',      label: 'Basic',               pctOf: '% of CTC' },
    { key: 'hra',        label: 'HRA',                 pctOf: '% of Basic' },
    { key: 'conveyance', label: 'Conveyance Allowance', pctOf: '% of CTC (capped ₹1,600)' },
    { key: 'medical',    label: 'Medical Allowance',    pctOf: '% of CTC (capped ₹1,250)' },
    { key: 'lta',        label: 'LTA',                 pctOf: '% of Basic' },
  ];

  return (
    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="wizard-section">
          <div className="wizard-section-title">Pay Cycle</div>
          <div className="wizard-grid-2">
            <div className="wizard-field">
              <label>Pay Frequency</label>
              <select value={data.frequency} onChange={e => set('frequency')(e.target.value)}>
                <option value="Monthly">Monthly</option>
                <option value="Biweekly">Biweekly</option>
              </select>
            </div>
            <div className="wizard-field">
              <label>Pay Day (1–31)</label>
              <input type="number" min={1} max={31} value={data.pay_day}
                onChange={e => set('pay_day')(Number(e.target.value))} />
            </div>
            <div className="wizard-field">
              <label>Attendance Cutoff Day</label>
              <input type="number" min={1} max={31} value={data.cutoff_day}
                onChange={e => set('cutoff_day')(Number(e.target.value))} />
            </div>
          </div>
        </div>

        <div className="wizard-section">
          <div className="wizard-section-title">Salary Components</div>
          {COMPONENTS.map(({ key, label, pctOf }) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <Toggle
                checked={data.components[key].enabled}
                onChange={setComp(key, 'enabled')}
              />
              <span style={{ fontSize: 13, color: '#374151', width: 160, flexShrink: 0 }}>{label}</span>
              <input type="number" min={0} max={100} step={0.5}
                value={data.components[key].pct}
                onChange={e => setComp(key, 'pct')(Number(e.target.value))}
                disabled={!data.components[key].enabled}
                style={{
                  width: 80, padding: '6px 10px', border: '1.5px solid #e5e7eb', borderRadius: 7,
                  fontSize: 13, fontFamily: 'inherit', outline: 'none', textAlign: 'right',
                  opacity: data.components[key].enabled ? 1 : 0.4,
                }}
              />
              <span style={{ fontSize: 11, color: '#9ca3af' }}>{pctOf}</span>
            </div>
          ))}
        </div>

        <div className="wizard-section">
          <div className="wizard-section-title">Statutory Deductions</div>

          {/* PF */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <Toggle checked={data.pf.enabled} onChange={v => setDeduction('pf', 'enabled')(v)} />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Provident Fund (PF)</span>
            </div>
            {data.pf.enabled && (
              <div style={{ display: 'flex', gap: 12, paddingLeft: 44 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>Employee %</div>
                  <input type="number" min={0} max={100} value={data.pf.emp_pct}
                    onChange={e => setDeduction('pf', 'emp_pct')(Number(e.target.value))}
                    style={{ width: 70, padding: '5px 8px', border: '1.5px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>Employer %</div>
                  <input type="number" min={0} max={100} value={data.pf.employer_pct}
                    onChange={e => setDeduction('pf', 'employer_pct')(Number(e.target.value))}
                    style={{ width: 70, padding: '5px 8px', border: '1.5px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
                </div>
              </div>
            )}
          </div>

          {/* ESI */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <Toggle checked={data.esi.enabled} onChange={v => setDeduction('esi', 'enabled')(v)} />
              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>ESI (gross ≤ ₹21,000)</span>
            </div>
            {data.esi.enabled && (
              <div style={{ display: 'flex', gap: 12, paddingLeft: 44 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>Employee %</div>
                  <input type="number" min={0} max={100} step={0.01} value={data.esi.emp_pct}
                    onChange={e => setDeduction('esi', 'emp_pct')(Number(e.target.value))}
                    style={{ width: 70, padding: '5px 8px', border: '1.5px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>Employer %</div>
                  <input type="number" min={0} max={100} step={0.01} value={data.esi.employer_pct}
                    onChange={e => setDeduction('esi', 'employer_pct')(Number(e.target.value))}
                    style={{ width: 70, padding: '5px 8px', border: '1.5px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
                </div>
              </div>
            )}
          </div>

          {/* PT */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <Toggle checked={data.pt.enabled} onChange={v => onChange('pt', { ...data.pt, enabled: v })} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Professional Tax</span>
            {data.pt.enabled && (
              <select value={data.pt.state}
                onChange={e => onChange('pt', { ...data.pt, state: e.target.value })}
                style={{ padding: '5px 8px', border: '1.5px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none', marginLeft: 8 }}>
                {['Maharashtra', 'Karnataka', 'Gujarat', 'Tamil Nadu', 'West Bengal', 'Other']
                  .map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
          </div>

          {/* TDS */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle checked={data.tds_auto} onChange={v => onChange('tds_auto', v)} />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>TDS Auto-Calculate</span>
          </div>
        </div>
      </div>

      {/* Live preview */}
      <div className="payroll-preview" style={{ width: 220, position: 'sticky', top: 20 }}>
        <h4>CTC Preview</h4>
        <div className="wizard-field" style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 11 }}>Sample CTC (₹/year)</label>
          <input type="number" value={data.sample_ctc}
            onChange={e => onChange('sample_ctc', e.target.value)}
            style={{ padding: '5px 8px', border: '1.5px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontFamily: 'inherit', outline: 'none', width: '100%' }} />
        </div>
        {[
          { label: 'Monthly Gross', value: breakdown.monthly },
          { label: 'Basic',         value: breakdown.basic   },
          { label: 'HRA',           value: breakdown.hra     },
          { label: 'Conveyance',    value: breakdown.conv    },
          { label: 'Medical',       value: breakdown.med     },
          { label: 'Special Allw.', value: breakdown.special },
        ].filter(r => r.value > 0).map(r => (
          <div className="payroll-preview-row" key={r.label}>
            <span className="label">{r.label}</span>
            <span>{fmt(r.value)}</span>
          </div>
        ))}
        {(breakdown.pf > 0 || breakdown.esi > 0) && (
          <div style={{ fontSize: 10, color: '#9ca3af', padding: '6px 0 2px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px' }}>
            Deductions
          </div>
        )}
        {breakdown.pf > 0 && (
          <div className="payroll-preview-row">
            <span className="label">PF (Emp)</span>
            <span className="deduction">-{fmt(breakdown.pf)}</span>
          </div>
        )}
        {breakdown.esi > 0 && (
          <div className="payroll-preview-row">
            <span className="label">ESI (Emp)</span>
            <span className="deduction">-{fmt(breakdown.esi)}</span>
          </div>
        )}
        <div className="payroll-preview-row">
          <span>Net Take-Home</span>
          <span style={{ color: '#6B3FDB' }}>{fmt(breakdown.net)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Step 6 — Leave Policies ───────────────────────────────────────────────────
function StepLeaves({ data, onChange }) {
  const addRow = () => {
    onChange('types', [
      ...data.types,
      { _id: Date.now(), name: '', quota: 0, carry_forward: false, max_carry: 0, encashable: false, gender: 'All', approval: 'L1' },
    ]);
  };

  const updateRow = (id, field, value) => {
    onChange('types', data.types.map(r => r._id === id ? { ...r, [field]: value } : r));
  };

  const removeRow = (id) => {
    onChange('types', data.types.filter(r => r._id !== id));
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div className="wizard-field" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ margin: 0, fontSize: 13, fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
            Leave Year:
          </label>
          <select value={data.year_type} onChange={e => onChange('year_type', e.target.value)}
            style={{ padding: '6px 10px', border: '1.5px solid #e5e7eb', borderRadius: 7, fontSize: 13, fontFamily: 'inherit', outline: 'none' }}>
            <option value="April-March">April – March (India standard)</option>
            <option value="January-December">January – December (Calendar year)</option>
          </select>
        </div>
        <button className="btn-sm" onClick={addRow}>
          <Plus size={11} /> Add Leave Type
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="leave-table">
          <thead>
            <tr>
              <th style={{ minWidth: 130 }}>Leave Type</th>
              <th>Quota (days)</th>
              <th>Carry Fwd</th>
              <th>Max Carry</th>
              <th>Encashable</th>
              <th>Gender</th>
              <th>Approval</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.types.map(row => (
              <tr key={row._id}>
                <td>
                  <input type="text" value={row.name} placeholder="e.g. Earned Leave"
                    onChange={e => updateRow(row._id, 'name', e.target.value)} />
                </td>
                <td>
                  <input type="number" min={0} max={365} value={row.quota}
                    onChange={e => updateRow(row._id, 'quota', Number(e.target.value))} />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={row.carry_forward}
                    onChange={e => updateRow(row._id, 'carry_forward', e.target.checked)}
                    style={{ width: 15, height: 15, accentColor: '#6B3FDB', cursor: 'pointer' }} />
                </td>
                <td>
                  <input type="number" min={0} value={row.max_carry}
                    disabled={!row.carry_forward}
                    onChange={e => updateRow(row._id, 'max_carry', Number(e.target.value))}
                    style={{ opacity: row.carry_forward ? 1 : 0.4 }} />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={row.encashable}
                    onChange={e => updateRow(row._id, 'encashable', e.target.checked)}
                    style={{ width: 15, height: 15, accentColor: '#6B3FDB', cursor: 'pointer' }} />
                </td>
                <td>
                  <select value={row.gender} onChange={e => updateRow(row._id, 'gender', e.target.value)}>
                    <option value="All">All</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </td>
                <td>
                  <select value={row.approval} onChange={e => updateRow(row._id, 'approval', e.target.value)}>
                    <option value="L1">L1 only</option>
                    <option value="L1+L2">L1 + L2</option>
                    <option value="L1+L2+HR">L1 + L2 + HR</option>
                  </select>
                </td>
                <td>
                  <button className="btn-icon" onClick={() => removeRow(row._id)}>
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: '#9ca3af' }}>
        {data.types.length} leave type{data.types.length !== 1 ? 's' : ''} configured
      </div>
    </div>
  );
}

// ── Step 7 — Integrations ─────────────────────────────────────────────────────
const INTEGRATIONS = [
  {
    key: 'whatsapp',
    emoji: '💬',
    name: 'WhatsApp Business',
    desc: 'Send payslips, leave notifications, and alerts via WhatsApp.',
    fields: [
      { key: 'api_key',         label: 'API Key',          type: 'password', placeholder: 'WhatsApp Business API key' },
      { key: 'phone_number_id', label: 'Phone Number ID',  type: 'text',     placeholder: 'Phone number ID' },
    ],
  },
  {
    key: 'sendgrid',
    emoji: '📧',
    name: 'SendGrid',
    desc: 'Transactional email for onboarding, payslips, and alerts.',
    fields: [
      { key: 'api_key',    label: 'API Key',     type: 'password', placeholder: 'SG.xxxxxxxxxx' },
      { key: 'from_email', label: 'Sender Email', type: 'text',     placeholder: 'noreply@yourcompany.com' },
    ],
  },
  {
    key: 'razorpay',
    emoji: '💳',
    name: 'Razorpay',
    desc: 'Process salary disbursements and expense reimbursements.',
    fields: [
      { key: 'key_id',     label: 'Key ID',     type: 'text',     placeholder: 'rzp_live_xxxxxxxxxx' },
      { key: 'key_secret', label: 'Key Secret', type: 'password', placeholder: 'Secret key' },
    ],
  },
  {
    key: 'tally',
    emoji: '📊',
    name: 'Tally',
    desc: 'Sync payroll and accounting journals with Tally ERP.',
    fields: [
      { key: 'host',    label: 'Tally Host',    type: 'text', placeholder: 'localhost' },
      { key: 'port',    label: 'Port',          type: 'text', placeholder: '9000' },
      { key: 'company', label: 'Company Name',  type: 'text', placeholder: 'Your Tally company name' },
    ],
  },
  {
    key: 'zoho_sign',
    emoji: '✍️',
    name: 'ZohoSign',
    desc: 'Digital signatures for offer letters, contracts, and NDAs.',
    fields: [
      { key: 'client_id',     label: 'Client ID',     type: 'text',     placeholder: 'Zoho OAuth client ID' },
      { key: 'client_secret', label: 'Client Secret', type: 'password', placeholder: 'Client secret' },
    ],
  },
  {
    key: 'aws_s3',
    emoji: '☁️',
    name: 'AWS S3',
    desc: 'Store documents, payslips, and employee files securely.',
    fields: [
      { key: 'access_key', label: 'Access Key',  type: 'text',     placeholder: 'AKIAIOSFODNN7EXAMPLE' },
      { key: 'secret_key', label: 'Secret Key',  type: 'password', placeholder: 'wJalrXUtnFEMI...' },
      { key: 'bucket',     label: 'Bucket Name', type: 'text',     placeholder: 'my-company-docs' },
      { key: 'region',     label: 'Region',      type: 'text',     placeholder: 'ap-south-1' },
    ],
  },
];

function StepIntegrations({ data, onChange }) {
  const [expanded, setExpanded] = useState({});
  const [showPass, setShowPass] = useState({});

  const toggle = (key) => setExpanded(p => ({ ...p, [key]: !p[key] }));
  const togglePass = (k) => setShowPass(p => ({ ...p, [k]: !p[k] }));

  const updateField = (intKey, field, value) => {
    const updated = { ...data[intKey], [field]: value };
    const isConfigured = Object.entries(updated)
      .filter(([k]) => k !== 'configured')
      .some(([, v]) => v && String(v).trim());
    onChange(intKey, { ...updated, configured: isConfigured });
  };

  return (
    <div>
      <div className="wizard-info-banner">
        You can configure integrations later from <strong>Settings → Integrations</strong>.
        Skip this step if you want to set them up after initial deployment.
      </div>

      <div className="integration-grid">
        {INTEGRATIONS.map(({ key, emoji, name, desc, fields }) => {
          const isConfigured = data[key]?.configured;
          const isOpen = expanded[key];

          return (
            <div className={`integration-card ${isConfigured ? 'configured' : ''}`} key={key}>
              <div className="integration-card-header">
                <div className="integration-card-title">
                  <span className="integration-emoji">{emoji}</span>
                  <span className="integration-name">{name}</span>
                </div>
                {isConfigured && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 10, fontWeight: 700, color: '#059669', background: '#d1fae5',
                    padding: '2px 8px', borderRadius: 10 }}>
                    <Check size={10} strokeWidth={3} /> Set
                  </span>
                )}
              </div>

              <div className="integration-desc">{desc}</div>

              <button
                className={isConfigured ? 'btn-sm' : 'btn-sm'}
                style={isConfigured ? { borderColor: '#a7f3d0', color: '#059669' } : {}}
                onClick={() => toggle(key)}
              >
                {isOpen ? 'Hide' : (isConfigured ? 'Edit credentials' : 'Configure')}
              </button>

              {isOpen && (
                <div className="integration-form">
                  {fields.map(f => {
                    const passKey = `${key}_${f.key}`;
                    const isPass = f.type === 'password';
                    const showValue = showPass[passKey];
                    return (
                      <div key={f.key} style={{ position: 'relative' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 3, fontWeight: 600 }}>
                          {f.label}
                        </div>
                        <div style={{ position: 'relative' }}>
                          <input
                            type={isPass && !showValue ? 'password' : 'text'}
                            value={data[key]?.[f.key] || ''}
                            placeholder={f.placeholder}
                            onChange={e => updateField(key, f.key, e.target.value)}
                            style={{ paddingRight: isPass ? 32 : undefined }}
                          />
                          {isPass && (
                            <button
                              onClick={() => togglePass(passKey)}
                              style={{
                                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                                background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af',
                                display: 'flex', alignItems: 'center',
                              }}
                            >
                              {showValue ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          )}
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
    </div>
  );
}

// ── Step: Finance / Bank Accounts ─────────────────────────────────────────────
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const BANK_ACCOUNT_TYPES = [
  { value: 'current', label: 'Current Account'  },
  { value: 'savings', label: 'Savings Account'  },
  { value: 'cash',    label: 'Petty Cash'        },
  { value: 'od',      label: 'Overdraft (OD)'    },
];

function StepFinance({ data, onChange }) {
  const ifscValid = !data.ifsc_code || IFSC_RE.test(data.ifsc_code.toUpperCase());

  const f = (field) => (e) => onChange(field, field === 'is_primary' ? e.target.checked : e.target.value);

  return (
    <div>
      <div className="wizard-info-banner">
        Add your company's primary bank account to enable payment processing, cash flow tracking,
        and reconciliation. You can add more accounts later from <strong>Finance → Bank Accounts</strong>.
        This step is optional — click <em>Skip</em> to configure later.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <div className="wizard-field">
          <label>Account Name</label>
          <input value={data.account_name} onChange={f('account_name')}
            placeholder="e.g. HDFC Current Account — Bangalore" />
        </div>
        <div className="wizard-field">
          <label>Bank Name</label>
          <input value={data.bank_name} onChange={f('bank_name')}
            placeholder="HDFC / ICICI / SBI…" />
        </div>
        <div className="wizard-field">
          <label>Account Number</label>
          <input value={data.account_number} onChange={f('account_number')}
            placeholder="Full account number" />
        </div>
        <div className="wizard-field">
          <label>IFSC Code</label>
          <input value={data.ifsc_code}
            onChange={e => onChange('ifsc_code', e.target.value.toUpperCase())}
            placeholder="HDFC0001234" maxLength={11}
            style={{ borderColor: data.ifsc_code && !ifscValid ? '#ef4444' : undefined }} />
          {data.ifsc_code && !ifscValid && (
            <span style={{ color: '#ef4444', fontSize: 12 }}>Format: HDFC0001234</span>
          )}
        </div>
        <div className="wizard-field">
          <label>Account Type</label>
          <select value={data.account_type} onChange={f('account_type')}>
            {BANK_ACCOUNT_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="wizard-field">
          <label>Opening Balance (₹)</label>
          <input type="number" value={data.opening_balance} onChange={f('opening_balance')}
            placeholder="Current bank balance" min="0" />
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={data.is_primary} onChange={f('is_primary')} />
          Set as primary account (default for all payments)
        </label>
      </div>
    </div>
  );
}

// ── Default step data ─────────────────────────────────────────────────────────
function defaultStepData() {
  return {
    company: {
      company_name: '', legal_name: '', gstin: '', pan: '', cin: '',
      industry: '', company_size: '', fy_start: 'April', address: '', logo: null,
    },
    organization: {
      departments: [
        { id: 1, name: 'Engineering',  designations: ['Software Engineer', 'Tech Lead', 'Engineering Manager'] },
        { id: 2, name: 'HR',           designations: ['HR Manager', 'HR Executive'] },
        { id: 3, name: 'Finance',      designations: ['CFO', 'Accountant', 'Finance Analyst'] },
        { id: 4, name: 'Sales',        designations: ['Sales Manager', 'Sales Executive'] },
        { id: 5, name: 'Operations',   designations: ['Operations Manager', 'Operations Executive'] },
      ],
    },
    users: {
      rows: [],
    },
    roles: {
      existing: [],
      newRoles: [],
    },
    payroll: {
      frequency: 'Monthly', pay_day: 1, cutoff_day: 25,
      components: {
        basic:      { enabled: true,  pct: 50   },
        hra:        { enabled: true,  pct: 40   },
        conveyance: { enabled: true,  pct: 1600 },
        medical:    { enabled: true,  pct: 1250 },
        lta:        { enabled: false, pct: 0    },
      },
      pf:       { enabled: true,  emp_pct: 12,   employer_pct: 12   },
      esi:      { enabled: false, emp_pct: 0.75, employer_pct: 3.25 },
      pt:       { enabled: true,  state: 'Maharashtra' },
      tds_auto: true,
      sample_ctc: 600000,
    },
    leaves: {
      year_type: 'April-March',
      types: [
        { _id: 1, name: 'Casual Leave',     quota: 12,  carry_forward: false, max_carry: 0,  encashable: false, gender: 'All',    approval: 'L1'     },
        { _id: 2, name: 'Sick Leave',       quota: 12,  carry_forward: false, max_carry: 0,  encashable: false, gender: 'All',    approval: 'L1'     },
        { _id: 3, name: 'Earned Leave',     quota: 15,  carry_forward: true,  max_carry: 30, encashable: true,  gender: 'All',    approval: 'L1+L2'  },
        { _id: 4, name: 'Maternity Leave',  quota: 180, carry_forward: false, max_carry: 0,  encashable: false, gender: 'Female', approval: 'L1+L2+HR' },
        { _id: 5, name: 'Paternity Leave',  quota: 5,   carry_forward: false, max_carry: 0,  encashable: false, gender: 'Male',   approval: 'L1'     },
        { _id: 6, name: 'Compensatory Off', quota: 0,   carry_forward: true,  max_carry: 5,  encashable: false, gender: 'All',    approval: 'L1'     },
      ],
    },
    finance: {
      account_name:    '',
      bank_name:       '',
      account_number:  '',
      ifsc_code:       '',
      account_type:    'current',
      opening_balance: '',
      is_primary:      true,
    },
    integrations: {
      whatsapp:  { api_key: '',     phone_number_id: '',               configured: false },
      sendgrid:  { api_key: '',     from_email: '',                    configured: false },
      razorpay:  { key_id: '',      key_secret: '',                    configured: false },
      tally:     { host: '',        port: '', company: '',             configured: false },
      zoho_sign: { client_id: '',   client_secret: '',                 configured: false },
      aws_s3:    { access_key: '',  secret_key: '', bucket: '', region: '', configured: false },
    },
  };
}

// ── Main Wizard ───────────────────────────────────────────────────────────────
export default function SetupWizard({ setPage: setPageProp }) {
  const navigate  = useNavigate();
  const { clearNeedsSetup } = useAuth();
  const { progress, markStepDone, skipStep } = useSetupProgress();

  const [currentStep, setCurrentStep] = useState(() => {
    const saved = sessionStorage.getItem('wizard_current_step');
    return saved ? Math.min(parseInt(saved, 10), STEPS.length - 1) : 0;
  });

  const [stepData, setStepData]       = useState(defaultStepData);
  const [saving,   setSaving]         = useState(false);
  const [stepError, setStepError]     = useState(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [showSkipWarning, setShowSkipWarning] = useState(false);

  const go = useCallback((page) => {
    if (setPageProp) { setPageProp(page); } else { navigate(`/${page}`); }
  }, [setPageProp, navigate]);

  // Load existing roles on mount
  useEffect(() => {
    api.get('/auth/roles').then(({ data }) => {
      setStepData(prev => ({
        ...prev,
        roles: { ...prev.roles, existing: Array.isArray(data) ? data : [] },
      }));
    }).catch(() => {});
  }, []);

  // Load existing integrations on mount
  useEffect(() => {
    api.get('/settings/integrations').then(({ data }) => {
      if (data && typeof data === 'object') {
        setStepData(prev => ({
          ...prev,
          integrations: {
            whatsapp:  { ...prev.integrations.whatsapp,  ...(data.whatsapp  || {}), configured: !!(data.whatsapp?.api_key)  },
            sendgrid:  { ...prev.integrations.sendgrid,  ...(data.sendgrid  || {}), configured: !!(data.sendgrid?.api_key)  },
            razorpay:  { ...prev.integrations.razorpay,  ...(data.razorpay  || {}), configured: !!(data.razorpay?.key_id)   },
            tally:     { ...prev.integrations.tally,     ...(data.tally     || {}), configured: !!(data.tally?.host)        },
            zoho_sign: { ...prev.integrations.zoho_sign, ...(data.zoho_sign || {}), configured: !!(data.zoho_sign?.client_id) },
            aws_s3:    { ...prev.integrations.aws_s3,    ...(data.aws_s3    || {}), configured: !!(data.aws_s3?.access_key) },
          },
        }));
      }
    }).catch(() => {});
  }, []);

  // Prefill company step from saved DB data on mount
  useEffect(() => {
    api.get('/company-profile').then(({ data }) => {
      if (data) {
        setStepData(prev => ({
          ...prev,
          company: {
            ...prev.company,
            company_name: data.name    ?? prev.company.company_name,
            gstin:        data.gstin   ?? prev.company.gstin,
            pan:          data.pan     ?? prev.company.pan,
            cin:          data.cin     ?? prev.company.cin,
            address:      data.address ?? prev.company.address,
          },
        }));
      }
    }).catch(() => {});
    api.get('/settings/company').then(({ data }) => {
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        setStepData(prev => ({
          ...prev,
          company: {
            ...prev.company,
            legal_name:   data.legal_name   ?? prev.company.legal_name,
            industry:     data.industry     ?? prev.company.industry,
            company_size: data.company_size ?? prev.company.company_size,
            fy_start:     data.fy_start     ?? prev.company.fy_start,
          },
        }));
      }
    }).catch(() => {});
  }, []);

  const goToStep = (idx) => {
    setCurrentStep(idx);
    sessionStorage.setItem('wizard_current_step', idx);
    setStepError(null);
  };

  const updateStepField = (stepKey, field, value) => {
    setStepData(prev => ({
      ...prev,
      [stepKey]: { ...prev[stepKey], [field]: value },
    }));
  };

  const updateStepSubField = (stepKey, subKey, value) => {
    setStepData(prev => ({
      ...prev,
      [stepKey]: { ...prev[stepKey], [subKey]: value },
    }));
  };

  // Build API payloads per step
  const saveCurrentStep = async () => {
    const key = STEPS[currentStep].key;
    const d   = stepData[key];

    switch (key) {
      case 'company': {
        // PUT /company-profile updates the companies table — this is what drives
        // "Company & Organization" progress in Settings Center (checks gstin+address+state).
        await api.put('/company-profile', {
          name:    (d.company_name ?? '').trim(),
          gstin:   (d.gstin        ?? '').trim().toUpperCase(),
          pan:     (d.pan          ?? '').trim().toUpperCase(),
          cin:     (d.cin          ?? '').trim().toUpperCase(),
          address: (d.address      ?? '').trim(),
        });
        // Save extended fields (industry/size/fy_start/legal_name) to company_settings
        await api.post('/settings/company', {
          legal_name:   d.legal_name   ?? '',
          industry:     d.industry     ?? '',
          company_size: d.company_size ?? '',
          fy_start:     d.fy_start     ?? 'April',
        });
        break;
      }
      case 'organization': {
        const depts    = d.departments.filter(dep => dep.name.trim());
        const bulkDesig = depts.flatMap(dep =>
          dep.designations.map(name => ({ name, department: dep.name }))
        );
        await api.post('/master/departments/bulk', { departments: depts.map(dep => ({ name: dep.name })) });
        if (bulkDesig.length > 0) await api.post('/master/designations/bulk', { designations: bulkDesig });
        break;
      }
      case 'users': {
        const valid = d.rows.filter(r => r.name && isValidEmail(r.email));
        if (valid.length > 0) await api.post('/auth/users/bulk', { users: valid });
        break;
      }
      case 'roles': {
        if (d.newRoles.length > 0) {
          const payload = d.newRoles.map(r => ({
            name: r.name, description: r.description, permissions: r.perms,
          }));
          await api.post('/auth/roles/bulk', { roles: payload });
        }
        break;
      }
      case 'payroll':
        await api.post('/settings/payroll', d);
        break;
      case 'finance': {
        // Only save if the user filled in at least account_name and bank_name
        if (d.account_name?.trim() && d.bank_name?.trim()) {
          await api.post('/finance/bank-accounts', {
            account_name:    d.account_name.trim(),
            bank_name:       d.bank_name.trim(),
            account_number:  d.account_number || '',
            ifsc_code:       (d.ifsc_code || '').toUpperCase(),
            account_type:    d.account_type || 'current',
            currency:        'INR',
            opening_balance: parseFloat(d.opening_balance || 0),
            opening_date:    new Date().toISOString().split('T')[0],
            is_primary:      d.is_primary !== false,
          });
        }
        break;
      }
      case 'leaves': {
        const leaveTypes = d.types
          .filter(t => (t.name || '').trim())
          .map(t => ({
            leave_name:             t.name.trim(),
            default_days:           Number(t.quota) || 0,
            carry_forward_allowed:  !!t.carry_forward,
            max_carry_forward_days: t.carry_forward ? (Number(t.max_carry) || 0) : 0,
            is_encashable:          !!t.encashable,
            gender_restriction:     t.gender === 'All' ? null : t.gender,
            l2_required:            /L2/i.test(t.approval || ''),
          }));
        if (leaveTypes.length > 0) await api.post('/leaves/types/bulk', { leaveTypes });
        break;
      }
      case 'integrations': {
        const payload = {};
        Object.entries(d).forEach(([k, v]) => {
          const { configured, ...rest } = v;
          if (configured) payload[k] = rest;
        });
        await api.post('/settings/integrations', payload);
        break;
      }
      default: break;
    }
  };

  const handleSaveAndContinue = async () => {
    setSaving(true);
    setStepError(null);
    try {
      await saveCurrentStep();
    } catch (err) {
      setStepError(
        err?.response?.data?.error ||
        err?.response?.data?.message ||
        'Failed to save. Please check the form and try again.'
      );
      setSaving(false);
      return;
    }

    // Fire progress tracking in background — don't block navigation on it
    markStepDone(STEPS[currentStep].key).catch(() => {});

    setSaving(false);

    if (currentStep < STEPS.length - 1) {
      goToStep(currentStep + 1);
    } else {
      // Final step — mark complete in system_wizard table
      try {
        await api.post('/wizard/complete');
        clearNeedsSetup();
      } catch { /* non-fatal */ }
      sessionStorage.removeItem('wizard_current_step');
      go('SetupDashboard');
    }
  };

  const doSkip = useCallback(async () => {
    setShowSkipWarning(false);
    await skipStep(STEPS[currentStep].key);
    if (currentStep < STEPS.length - 1) {
      goToStep(currentStep + 1);
    } else {
      try { await api.post('/settings/setup-progress', { setup_complete: true }); } catch { /* ignore */ }
      sessionStorage.removeItem('wizard_current_step');
      go('SetupDashboard');
    }
  }, [currentStep, skipStep, go]);

  const handleSkip = () => {
    if (STEPS[currentStep].key === 'company') {
      const d = stepData.company;
      if (!d.gstin?.trim() || !d.address?.trim()) {
        setShowSkipWarning(true);
        return;
      }
    }
    doSkip();
  };

  const handleExitConfirm = async () => {
    try { await api.post('/wizard/dismiss'); } catch { /* best-effort */ }
    clearNeedsSetup();
    sessionStorage.setItem('wizard_seen', '1');
    go('Home');
  };

  const handleSaveForLater = async () => {
    try { await saveCurrentStep(); } catch { /* best-effort partial save */ }
    try { await api.post('/wizard/dismiss'); } catch { /* best-effort */ }
    clearNeedsSetup();
    sessionStorage.setItem('wizard_seen', '1');
    go('Home');
  };

  // Progress %
  const doneCount = STEPS.filter(s => progress.steps[s.key]?.done || progress.steps[s.key]?.skipped).length;
  const pct = (doneCount / STEPS.length) * 100;

  // Step status helpers
  const stepStatus = (key) => {
    if (progress.steps[key]?.done)    return 'done';
    if (progress.steps[key]?.skipped) return 'skipped';
    return 'pending';
  };

  // Render active step panel
  const renderPanel = () => {
    const key = STEPS[currentStep].key;
    switch (key) {
      case 'company':
        return (
          <StepCompany
            data={stepData.company}
            onChange={(field, val) => updateStepField('company', field, val)}
          />
        );
      case 'organization':
        return (
          <StepOrganization
            data={stepData.organization}
            onChange={(field, val) => updateStepField('organization', field, val)}
          />
        );
      case 'users':
        return (
          <StepUsers
            data={stepData.users}
            onChange={(field, val) => updateStepField('users', field, val)}
            orgDepts={stepData.organization?.departments || []}
          />
        );
      case 'roles':
        return (
          <StepRoles
            data={stepData.roles}
            onChange={(field, val) => updateStepField('roles', field, val)}
          />
        );
      case 'payroll':
        return (
          <StepPayroll
            data={stepData.payroll}
            onChange={(key2, val) => updateStepSubField('payroll', key2, val)}
          />
        );
      case 'finance':
        return (
          <StepFinance
            data={stepData.finance}
            onChange={(field, val) => updateStepField('finance', field, val)}
          />
        );
      case 'leaves':
        return (
          <StepLeaves
            data={stepData.leaves}
            onChange={(field, val) => updateStepField('leaves', field, val)}
          />
        );
      case 'integrations':
        return (
          <StepIntegrations
            data={stepData.integrations}
            onChange={(intKey, val) => updateStepSubField('integrations', intKey, val)}
          />
        );
      default: return null;
    }
  };

  return (
    <div className="wizard-layout">
      {/* ── Top progress bar ── */}
      <div className="wizard-progress-bar-track">
        <div className="wizard-progress-bar" style={{ width: `${pct}%` }} />
      </div>

      {/* ── Header ── */}
      <div className="wizard-header">
        <div className="wizard-header-title">
          <div className="wizard-header-logo">
            <Zap size={16} color="#6B3FDB" />
          </div>
          <div className="wizard-header-text">
            <h2>First-Time Setup</h2>
            <span>Pulse ERP — get started in 8 steps</span>
          </div>
        </div>
        <div className="wizard-header-actions">
          <span className="wizard-step-badge">Step {currentStep + 1} of {STEPS.length}</span>
          <button className="wizard-exit-btn" onClick={() => setConfirmExit(true)}>
            <X size={13} /> Exit wizard
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="wizard-body">
        {/* Sidebar */}
        <div className="wizard-sidebar">
          <div className="wizard-sidebar-label">Setup Checklist</div>
          {STEPS.map((s, i) => {
            const Icon   = s.icon;
            const status = stepStatus(s.key);
            const active = i === currentStep;
            return (
              <button
                key={s.key}
                className={`wizard-step-item ${active ? 'active' : ''} ${status}`}
                onClick={() => goToStep(i)}
              >
                <div className={`step-circle`}>
                  {status === 'done'
                    ? <Check size={12} strokeWidth={3} color="#059669" />
                    : status === 'skipped'
                      ? <span style={{ fontSize: 9 }}>⊘</span>
                      : <Icon size={12} color={active ? '#6B3FDB' : '#9ca3af'} />
                  }
                </div>
                <div className="step-label">
                  <div className="step-label-name">{s.label}</div>
                  <div className="step-label-status">
                    {status === 'done'    ? 'Complete' :
                     status === 'skipped' ? 'Skipped'  :
                     active              ? 'In progress' : 'Pending'}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Panel */}
        <div className="wizard-panel">
          {/* Step header */}
          <div style={{ marginBottom: 24 }}>
            <h1 style={{ margin: '0 0 5px', fontSize: 20, fontWeight: 800, color: '#1f2937' }}>
              {STEPS[currentStep].label}
            </h1>
            <div style={{ fontSize: 13, color: '#6b7280' }}>
              Step {currentStep + 1} of {STEPS.length} — fill in the details below and click "Save &amp; Continue"
            </div>
          </div>

          {/* Error banner */}
          {stepError && (
            <div className="wizard-error-banner">
              <AlertCircle size={14} /> {stepError}
            </div>
          )}

          {/* Active step content */}
          {renderPanel()}
        </div>
      </div>

      {/* ── Bottom bar ── */}
      <div className="wizard-bottom-bar">
        <div className="wizard-bottom-left">
          <button
            className="btn-ghost"
            disabled={currentStep === 0}
            onClick={() => goToStep(currentStep - 1)}
          >
            <ChevronLeft size={14} /> Back
          </button>
        </div>

        <div className="wizard-bottom-right">
          <button className="btn-link" onClick={handleSaveForLater}>
            Save for later
          </button>
          <button className="btn-ghost" onClick={handleSkip}>
            Skip this step
          </button>
          <button
            className="btn-primary"
            onClick={handleSaveAndContinue}
            disabled={saving}
          >
            {saving
              ? <><RefreshCw size={13} className="wizard-spin" /> Saving…</>
              : currentStep < STEPS.length - 1
                ? <>Save &amp; Continue <ChevronRight size={14} /></>
                : <><CheckCircle size={14} /> Finish Setup</>
            }
          </button>
        </div>
      </div>

      {/* ── Skip warning (company step) ── */}
      {showSkipWarning && (
        <div className="wizard-overlay">
          <div className="wizard-dialog">
            <h3>Skip Company Info?</h3>
            <p>
              {!stepData.company.gstin?.trim() && !stepData.company.address?.trim()
                ? 'GSTIN and Registered Address are missing.'
                : !stepData.company.gstin?.trim()
                  ? 'GSTIN is missing.'
                  : 'Registered Address is missing.'
              }
              {' '}Skipping Company Info will leave GST calculations and compliance
              features incomplete. Continue anyway?
            </p>
            <div className="wizard-dialog-actions">
              <button className="btn-ghost" onClick={() => setShowSkipWarning(false)}>
                Go Back &amp; Fill
              </button>
              <button className="btn-primary" onClick={doSkip}>
                Skip Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Exit confirmation dialog ── */}
      {confirmExit && (
        <div className="wizard-overlay">
          <div className="wizard-dialog">
            <h3>Exit Setup Wizard?</h3>
            <p>
              Your progress is saved automatically. You can return to this wizard any time from{' '}
              <strong>Settings → First-Time Setup</strong>.
            </p>
            <div className="wizard-dialog-actions">
              <button className="btn-ghost" onClick={() => setConfirmExit(false)}>
                Continue Setup
              </button>
              <button className="btn-primary" onClick={handleExitConfirm}>
                <LogOut size={13} /> Exit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
