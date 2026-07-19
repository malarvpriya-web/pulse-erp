// PATH: frontend/src/features/documents/pages/DocumentMaster.jsx
// Phase 30E — Google Drive Document Architecture
// Documents uploaded here → stored in Drive → metadata in ERP DB
// Full revision history · approval workflow · signature linking · download audit

import { useState, useEffect, useCallback } from 'react';
import {
  Upload, FileText, AlertCircle,
  RefreshCw, Download, ChevronDown, ChevronUp, Eye,
  FolderOpen,
} from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const P = '#6366f1';
const BORDER = '#e5e7eb';

const MODULE_TYPES = [
  { value: 'engineering',  label: 'Engineering' },
  { value: 'quality',      label: 'Quality' },
  { value: 'hr',           label: 'HR' },
  { value: 'finance',      label: 'Finance' },
  { value: 'operations',   label: 'Operations' },
  { value: 'project',      label: 'Projects' },
  { value: 'procurement',  label: 'Procurement' },
  { value: 'sales',        label: 'Sales & CRM' },
  { value: 'maintenance',  label: 'Maintenance' },
];

const ENTITY_TYPES = [
  { value: 'ecn',                 label: 'ECN' },
  { value: 'bom',                 label: 'BOM' },
  { value: 'fat_report',          label: 'FAT Report' },
  { value: 'sat_report',          label: 'SAT Report' },
  { value: 'commissioning',       label: 'Commissioning' },
  { value: 'serial',              label: 'Serial / Equipment' },
  { value: 'service_report',      label: 'Service Report' },
  { value: 'employee',            label: 'Employee' },
  { value: 'invoice',             label: 'Invoice' },
  { value: 'project',             label: 'Project' },
  { value: 'drawing',             label: 'Drawing' },
];

const APPROVAL_META = {
  draft:            { color: '#9ca3af', bg: '#f3f4f6', label: 'Draft' },
  pending_approval: { color: '#d97706', bg: '#fef3c7', label: 'Pending Approval' },
  approved:         { color: '#16a34a', bg: '#dcfce7', label: 'Approved' },
  rejected:         { color: '#dc2626', bg: '#fee2e2', label: 'Rejected' },
};

function ApprovalBadge({ status }) {
  const m = APPROVAL_META[status] || APPROVAL_META.draft;
  return (
    <span style={{ display: 'inline-block', padding: '2px 10px', background: m.bg, color: m.color, borderRadius: 20, fontSize: 11, fontWeight: 600 }}>
      {m.label}
    </span>
  );
}

function formatBytes(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Upload Modal ─────────────────────────────────────────────────────── */
function UploadModal({ onClose, onUploaded }) {
  const toast = useToast();
  const [file, setFile]       = useState(null);
  const [form, setForm]       = useState({
    module_type: 'engineering',
    linked_entity_type: '',
    linked_entity_id: '',
    revision_label: '',
    is_confidential: false,
    access_level: 'internal',
  });
  const [uploading, setUploading] = useState(false);
  const [err, setErr]             = useState(null);
  const [progress, setProgress]   = useState(null);

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!file) { setErr('Select a file to upload.'); return; }
    setUploading(true);
    setErr(null);
    setProgress('Uploading to Google Drive…');

    const fd = new FormData();
    fd.append('file', file);
    Object.entries(form).forEach(([k, v]) => { if (v !== '' && v !== null) fd.append(k, v); });

    try {
      const r = await api.post('/document-master/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const data = r.data;
      if (!data.drive_stored) {
        setProgress(`Metadata saved. Drive not connected: ${data.drive_error || 'Check GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON'}`);
        setTimeout(() => { onUploaded(); }, 2000);
      } else {
        onUploaded();
      }
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 520, maxWidth: '95vw', boxShadow: '0 20px 60px rgba(0,0,0,.22)', maxHeight: '90vh', overflowY: 'auto' }}>
        <h2 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 700, color: '#111827' }}>Upload Document</h2>

        {/* File picker */}
        <div
          onClick={() => document.getElementById('_dm_file').click()}
          style={{
            border: `2px dashed ${file ? P : BORDER}`, borderRadius: 10, padding: '20px',
            textAlign: 'center', cursor: 'pointer', marginBottom: 18,
            background: file ? '#f5f3ff' : '#fafafa', transition: '.15s',
          }}
        >
          <input id="_dm_file" type="file" hidden onChange={e => setFile(e.target.files?.[0] || null)} />
          <Upload size={24} color={file ? P : '#9ca3af'} style={{ marginBottom: 8 }} />
          {file ? (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: P }}>{file.name}</div>
              <div style={{ fontSize: 11, color: '#9ca3af' }}>{formatBytes(file.size)}</div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: '#6b7280' }}>Click to select file (max 50 MB)</div>
          )}
        </div>

        {/* Module */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Module *</label>
          <select value={form.module_type} onChange={e => set('module_type', e.target.value)}
            style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, color: '#374151', boxSizing: 'border-box' }}>
            {MODULE_TYPES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>

        {/* Entity linkage */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Link to Entity</label>
            <select value={form.linked_entity_type} onChange={e => set('linked_entity_type', e.target.value)}
              style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, color: '#374151', boxSizing: 'border-box' }}>
              <option value="">— None —</option>
              {ENTITY_TYPES.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Entity ID</label>
            <input type="number" value={form.linked_entity_id} onChange={e => set('linked_entity_id', e.target.value)}
              placeholder="e.g. 42" disabled={!form.linked_entity_type}
              style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, color: '#374151', boxSizing: 'border-box' }} />
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Revision Label</label>
          <input value={form.revision_label} onChange={e => set('revision_label', e.target.value)}
            placeholder="e.g. Rev B (auto-generated if blank)"
            style={{ width: '100%', padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
        </div>

        <div style={{ display: 'flex', gap: 16, marginBottom: 18 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.is_confidential} onChange={e => set('is_confidential', e.target.checked)} />
            Confidential
          </label>
          <select value={form.access_level} onChange={e => set('access_level', e.target.value)}
            style={{ padding: '6px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 12, color: '#374151' }}>
            <option value="internal">Internal</option>
            <option value="restricted">Restricted</option>
            <option value="public">Public</option>
          </select>
        </div>

        {progress && <div style={{ fontSize: 12, color: '#6b7280', background: '#f3f4f6', padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}>{progress}</div>}
        {err && <div style={{ fontSize: 12, color: '#dc2626', background: '#fee2e2', padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', border: `1px solid ${BORDER}`, borderRadius: 8, background: '#fff', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={uploading || !file}
            style={{ padding: '9px 20px', background: P, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: (uploading || !file) ? .6 : 1 }}>
            {uploading ? 'Uploading…' : 'Upload to Drive'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════════════ */
export default function DocumentMaster() {
  const [docs, setDocs]           = useState([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [driveStatus, setDriveStatus] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [filterModule, setModule]   = useState('');
  const [filterEntity, setEntity]   = useState('');
  const [filterApproval, setApproval] = useState('');
  const [expandedIds, setExpanded]  = useState(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filterModule)   params.set('module_type', filterModule);
      if (filterEntity)   params.set('linked_entity_type', filterEntity);
      if (filterApproval) params.set('approval_status', filterApproval);

      const [docsRes, driveRes] = await Promise.allSettled([
        api.get(`/document-master?${params}`),
        api.get('/document-master/drive-status'),
      ]);

      if (docsRes.status === 'fulfilled') setDocs(docsRes.value.data?.data || []);
      if (driveRes.status === 'fulfilled') setDriveStatus(driveRes.value.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filterModule, filterEntity, filterApproval]);

  useEffect(() => { load(); }, [load]);

  const approve = async (id) => {
    try { await api.post(`/document-master/${id}/approve`); load(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Failed'); }
  };

  const reject = async (id) => {
    try { await api.post(`/document-master/${id}/reject`); load(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Failed'); }
  };

  const toggleExpand = (id) => setExpanded(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const downloadDoc = async (doc) => {
    // If the document has a Drive link and Drive is connected, open in new tab
    if (doc.drive_link && driveStatus?.ok) {
      window.open(doc.drive_link, '_blank', 'noreferrer');
      return;
    }
    // Otherwise stream through API (carries JWT token automatically)
    try {
      const resp = await api.get(`/document-master/${doc.id}/download`, { responseType: 'blob' });
      const url  = URL.createObjectURL(resp.data);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = doc.original_file_name || doc.file_name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Download failed');
    }
  };

  const approved   = docs.filter(d => d.approval_status === 'approved').length;
  const pending    = docs.filter(d => d.approval_status === 'pending_approval').length;
  const driveOk    = driveStatus?.ok;

  return (
    <div style={{ padding: 24, background: '#f8f9fc', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700, color: '#111827' }}>Document Master</h1>
          <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Google Drive storage · ERP metadata · Revision control · Approval workflow</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={{ padding: '8px 10px', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 8, cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center' }}>
            <RefreshCw size={14} />
          </button>
          <button onClick={() => setShowUpload(true)}
            style={{ padding: '8px 18px', background: P, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Upload size={14} /> Upload
          </button>
        </div>
      </div>

      {/* Drive Status Banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px',
        background: driveOk ? '#dcfce7' : '#fef3c7',
        border: `1px solid ${driveOk ? '#bbf7d0' : '#fde68a'}`,
        borderRadius: 10, marginBottom: 20, fontSize: 13,
        color: driveOk ? '#15803d' : '#92400e',
      }}>
        <FolderOpen size={16} />
        {driveStatus === null
          ? 'Checking Google Drive connectivity…'
          : driveOk
          ? 'Google Drive connected — files stored securely in Drive'
          : `Google Drive not connected — ${driveStatus?.message || 'configure service account credentials'}`}
      </div>

      {/* KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Documents', value: docs.length, color: P },
          { label: 'Approved',        value: approved,    color: '#16a34a' },
          { label: 'Pending Approval', value: pending,    color: '#d97706' },
          { label: 'In Drive',
            value: docs.filter(d => d.drive_file_id).length,
            color: '#0ea5e9' },
        ].map(k => (
          <div key={k.label} style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: '14px 18px' }}>
            <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 3 }}>{k.label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={filterModule} onChange={e => setModule(e.target.value)}
          style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}>
          <option value="">All Modules</option>
          {MODULE_TYPES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <select value={filterEntity} onChange={e => setEntity(e.target.value)}
          style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}>
          <option value="">All Entity Types</option>
          {ENTITY_TYPES.map(e => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>
        <select value={filterApproval} onChange={e => setApproval(e.target.value)}
          style={{ padding: '7px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, color: '#374151', background: '#fff' }}>
          <option value="">All Approval States</option>
          {Object.entries(APPROVAL_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>

      {/* Table */}
      {error ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#dc2626' }}><AlertCircle size={28} /><p>{error}</p></div>
      ) : loading && !docs.length ? (
        <div style={{ textAlign: 'center', padding: 40 }}><RefreshCw size={24} color={P} /></div>
      ) : docs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>
          <FileText size={40} style={{ marginBottom: 12, color: '#d1d5db' }} />
          <p>No documents yet. Upload the first one.</p>
        </div>
      ) : (
        <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', borderBottom: `1px solid ${BORDER}` }}>
                {['File', 'Module / Entity', 'Rev', 'Size', 'Approval', 'Drive', 'Uploaded', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {docs.map(doc => {
                const isExpanded = expandedIds.has(doc.id);
                const entityLabel = ENTITY_TYPES.find(e => e.value === doc.linked_entity_type)?.label;
                const moduleLabel = MODULE_TYPES.find(m => m.value === doc.module_type)?.label;
                return [
                  <tr key={doc.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ fontWeight: 500, color: '#111827' }}>{doc.file_name}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{doc.mime_type}</div>
                    </td>
                    <td style={{ padding: '11px 14px', color: '#6b7280' }}>
                      <div>{moduleLabel || doc.module_type}</div>
                      {entityLabel && <div style={{ fontSize: 11, color: '#9ca3af' }}>{entityLabel} #{doc.linked_entity_id}</div>}
                    </td>
                    <td style={{ padding: '11px 14px' }}>
                      <span style={{ background: '#ede9fe', color: P, padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>
                        {doc.revision_label || `Rev ${doc.revision}`}
                      </span>
                    </td>
                    <td style={{ padding: '11px 14px', color: '#9ca3af', fontSize: 12 }}>{formatBytes(doc.file_size_bytes)}</td>
                    <td style={{ padding: '11px 14px' }}><ApprovalBadge status={doc.approval_status} /></td>
                    <td style={{ padding: '11px 14px' }}>
                      {doc.drive_file_id
                        ? <span style={{ color: '#16a34a', fontSize: 11, fontWeight: 600 }}>✓ Drive</span>
                        : <span style={{ color: '#d1d5db', fontSize: 11 }}>Local only</span>}
                    </td>
                    <td style={{ padding: '11px 14px', color: '#9ca3af', fontSize: 11 }}>
                      {new Date(doc.uploaded_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                      <div>{doc.uploaded_by_name}</div>
                    </td>
                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        {doc.drive_link && (
                          <a href={doc.drive_link} target="_blank" rel="noreferrer"
                            style={{ padding: '4px 8px', background: '#dbeafe', color: '#2563eb', borderRadius: 6, fontSize: 11, textDecoration: 'none' }}>
                            <Eye size={10} style={{ marginRight: 3 }} />View
                          </a>
                        )}
                        <button onClick={() => downloadDoc(doc)}
                          style={{ padding: '4px 8px', background: '#dcfce7', color: '#16a34a', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
                          <Download size={10} />Download
                        </button>
                        {doc.approval_status === 'draft' && (
                          <button onClick={() => approve(doc.id)}
                            style={{ padding: '4px 8px', background: '#f0fdf4', color: '#16a34a', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                            Approve
                          </button>
                        )}
                        {doc.approval_status === 'approved' && (
                          <button onClick={() => reject(doc.id)}
                            style={{ padding: '4px 8px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}>
                            Reject
                          </button>
                        )}
                        <button onClick={() => toggleExpand(doc.id)}
                          style={{ padding: '4px 6px', background: '#f3f4f6', border: 'none', borderRadius: 6, cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center' }}>
                          {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                        </button>
                      </div>
                    </td>
                  </tr>,
                  isExpanded && (
                    <tr key={`${doc.id}-detail`} style={{ background: '#fafafa', borderBottom: '1px solid #f3f4f6' }}>
                      <td colSpan={8} style={{ padding: '12px 20px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 10, fontSize: 12, color: '#374151' }}>
                          {doc.checksum_sha256 && <div><span style={{ color: '#9ca3af' }}>SHA-256: </span><code style={{ fontSize: 10 }}>{doc.checksum_sha256.slice(0, 20)}…</code></div>}
                          {doc.drive_file_id   && <div><span style={{ color: '#9ca3af' }}>Drive ID: </span>{doc.drive_file_id}</div>}
                          {doc.approved_by     && <div><span style={{ color: '#9ca3af' }}>Approved by: </span>User #{doc.approved_by}</div>}
                          {doc.approved_at     && <div><span style={{ color: '#9ca3af' }}>Approved at: </span>{new Date(doc.approved_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>}
                          {doc.signed_status   && <div><span style={{ color: '#9ca3af' }}>Signed: </span>{doc.signed_status}</div>}
                          {doc.is_confidential && <div style={{ color: '#dc2626' }}>⚠ Confidential</div>}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onUploaded={() => { setShowUpload(false); load(); }} />}
    </div>
  );
}
