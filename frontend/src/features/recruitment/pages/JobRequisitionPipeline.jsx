import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, FileText, Plus, RefreshCw, Search, X } from 'lucide-react';
import api from '@/services/api/client';
import './JobRequisitionPipeline.css';

const EMPTY_FORM = {
  job_title: '',
  department_id: '',
  employment_type: 'full_time',
  number_of_positions: 1,
  job_description: '',
  skills_required: '',
  experience_required: '',
  location: '',
  salary_range: '',
};

// Must match DB CHECK constraint: ('draft', 'pending_approval', 'approved', 'open', 'closed')
const STATUS_ORDER = ['draft', 'pending_approval', 'approved', 'open', 'closed'];

const STATUS_META = {
  draft:            { label: 'Draft',            bg: '#f3f4f6', color: '#4b5563' },
  pending_approval: { label: 'Pending Approval', bg: '#dbeafe', color: '#1d4ed8' },
  approved:         { label: 'Approved',         bg: '#dcfce7', color: '#166534' },
  open:             { label: 'Open',             bg: '#fef3c7', color: '#a16207' },
  closed:           { label: 'Closed',           bg: '#fee2e2', color: '#991b1b' },
};

const asArray = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.requisitions)) return payload.requisitions;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const toLabel = (value) => {
  const text = String(value || '').replace(/_/g, ' ').trim();
  if (!text) return '-';
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const formatDate = (value) => {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return '-';
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};

const getPriority = (item) => {
  const positions = Number(item.number_of_positions || 0);
  if (positions >= 3) return 'High';
  if (positions === 2) return 'Medium';
  return 'Low';
};

export default function JobRequisitionPipeline() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const [activeRow, setActiveRow] = useState(null);
  const [createForm, setCreateForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [deptList, setDeptList] = useState([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = statusFilter === 'all' ? {} : { status: statusFilter };
      const res = await api.get('/recruitment/requisitions', { params });
      const list = asArray(res.data);
      setRows(list);
    } catch {
      setRows([]);
      setError('Unable to load requisitions from current API.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const loadDepts = async () => {
      try {
        const r = await api.get('/admin/config/departments');
        const list = Array.isArray(r.data) ? r.data.map(d => d.name || d) : [];
        if (list.length > 0) { setDeptList(list); return; }
      } catch {}
      try {
        const r = await api.get('/orgchart/departments');
        const raw = r.data?.data ?? r.data ?? [];
        setDeptList(Array.isArray(raw) ? raw.map(d => d.name || d) : []);
      } catch { setDeptList([]); }
    };
    loadDepts();
  }, []);

  const counts = useMemo(() => {
    const map = { all: rows.length, draft: 0, pending_approval: 0, approved: 0, open: 0, closed: 0 };
    rows.forEach((r) => {
      const key = String(r.status || '').toLowerCase();
      if (map[key] != null) map[key] += 1;
    });
    return map;
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const byStatus = statusFilter === 'all' || String(r.status || '').toLowerCase() === statusFilter;
      if (!byStatus) return false;
      if (!q) return true;
      return (
        String(r.job_title || '').toLowerCase().includes(q) ||
        String(r.department || '').toLowerCase().includes(q) ||
        String(r.requisition_no || `REQ-${r.id}`).toLowerCase().includes(q)
      );
    });
  }, [rows, search, statusFilter]);

  const summary = useMemo(() => {
    const totalPositions = rows.reduce((acc, r) => acc + Number(r.number_of_positions || 0), 0);
    const openCount = rows.filter((r) => String(r.status || '').toLowerCase() === 'open').length;
    const pendingCount = rows.filter((r) => ['draft', 'pending_approval'].includes(String(r.status || '').toLowerCase())).length;
    return {
      total: rows.length,
      positions: totalPositions,
      pending: pendingCount,
      open: openCount,
    };
  }, [rows]);

  const setField = (key, value) => setCreateForm((prev) => ({ ...prev, [key]: value }));

  const submitCreate = async () => {
    if (!createForm.job_title.trim() || !createForm.department_id.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post('/recruitment/requisitions', { ...createForm });
      setShowCreate(false);
      setCreateForm(EMPTY_FORM);
      await loadData();
    } catch {
      setError('Create requisition failed. API did not accept the request.');
    } finally {
      setSubmitting(false);
    }
  };

  const openDetail = (row) => {
    setActiveRow(row);
    setShowDetail(true);
  };

  const moveStatus = async (nextStatus) => {
    if (!activeRow?.id) return;
    setError('');
    try {
      const res = await api.put(`/recruitment/requisitions/${activeRow.id}`, { status: nextStatus });
      const updated = res?.data || { ...activeRow, status: nextStatus };
      setRows((prev) => prev.map((r) => (r.id === activeRow.id ? { ...r, ...updated } : r)));
      setActiveRow((prev) => ({ ...prev, ...updated }));
    } catch {
      setError('Status update failed. API did not accept the status change.');
    }
  };

  const nextStatus = useMemo(() => {
    const current = String(activeRow?.status || '').toLowerCase();
    const idx = STATUS_ORDER.indexOf(current);
    if (idx < 0 || idx >= STATUS_ORDER.length - 1) return null;
    return STATUS_ORDER[idx + 1];
  }, [activeRow]);

  return (
    <div className="jrp-root">
      <div className="jrp-header">
        <div>
          <h2 className="jrp-title">Requisition Pipeline</h2>
          <p className="jrp-sub">Track requisitions through approval and opening stages</p>
        </div>
        <div className="jrp-header-actions">
          <button className="jrp-btn-outline" onClick={loadData}><RefreshCw size={14} /> Refresh</button>
          <button className="jrp-btn-primary" onClick={() => setShowCreate(true)}><Plus size={14} /> New Requisition</button>
        </div>
      </div>

      <div className="jrp-summary">
        <div className="jrp-sum-card"><div className="jrp-sum-icon" style={{ background: '#eef2ff', color: '#4338ca' }}><FileText size={16} /></div><div><div className="jrp-sum-num">{summary.total}</div><div className="jrp-sum-lbl">Total Requisitions</div></div></div>
        <div className="jrp-sum-card"><div className="jrp-sum-icon" style={{ background: '#fef3c7', color: '#a16207' }}><FileText size={16} /></div><div><div className="jrp-sum-num">{summary.pending}</div><div className="jrp-sum-lbl">Pending Review</div></div></div>
        <div className="jrp-sum-card"><div className="jrp-sum-icon" style={{ background: '#dcfce7', color: '#166534' }}><FileText size={16} /></div><div><div className="jrp-sum-num">{summary.open}</div><div className="jrp-sum-lbl">Converted to Open</div></div></div>
        <div className="jrp-sum-card"><div className="jrp-sum-icon" style={{ background: '#e0f2fe', color: '#0369a1' }}><FileText size={16} /></div><div><div className="jrp-sum-num">{summary.positions}</div><div className="jrp-sum-lbl">Requested Positions</div></div></div>
      </div>

      <div className="jrp-filters">
        <div className="jrp-search">
          <Search size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search requisition, title, department" />
          {!!search && <button onClick={() => setSearch('')}><X size={12} /></button>}
        </div>
        <div className="jrp-tabs">
          {['all', 'draft', 'pending_approval', 'approved', 'open', 'closed'].map((key) => (
            <button key={key} className={`jrp-tab ${statusFilter === key ? 'jrp-tab-active' : ''}`} onClick={() => setStatusFilter(key)}>
              {toLabel(key)} <span className="jrp-tab-count">{counts[key] || 0}</span>
            </button>
          ))}
        </div>
      </div>
      {!!error && <div className="jrp-error">{error}</div>}

      {loading ? (
        <div className="jrp-loading"><div className="jrp-spinner" /></div>
      ) : (
        <div className="jrp-table-wrap">
          <table className="jrp-table">
            <thead>
              <tr>
                <th>Req No</th>
                <th>Job Title</th>
                <th>Department</th>
                <th className="jrp-center">Positions</th>
                <th className="jrp-center">Priority</th>
                <th className="jrp-center">Stage</th>
                <th className="jrp-center">Created</th>
                <th className="jrp-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr className="jrp-row"><td colSpan={8} className="jrp-center">No requisitions found.</td></tr>
              ) : filteredRows.map((row) => {
                const statusKey = String(row.status || 'draft').toLowerCase();
                const statusMeta = STATUS_META[statusKey] || STATUS_META.draft;
                return (
                  <tr className="jrp-row" key={row.id}>
                    <td className="jrp-no">{row.requisition_no || `REQ-${row.id}`}</td>
                    <td className="jrp-title-cell">{row.job_title || '-'}</td>
                    <td><span className="jrp-dept">{row.department || '-'}</span></td>
                    <td className="jrp-center">{row.number_of_positions || 0}</td>
                    <td className="jrp-center jrp-priority">{getPriority(row)}</td>
                    <td className="jrp-center"><span className="jrp-stage-badge" style={{ background: statusMeta.bg, color: statusMeta.color }}>{statusMeta.label}</span></td>
                    <td className="jrp-center">{formatDate(row.created_at)}</td>
                    <td className="jrp-center"><button className="jrp-view-btn" onClick={() => openDetail(row)}><Eye size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="jrp-overlay" onClick={() => setShowCreate(false)}>
          <div className="jrp-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="jrp-drawer-hd">
              <h3>Create Requisition</h3>
              <button className="jrp-icon-btn" onClick={() => setShowCreate(false)}><X size={16} /></button>
            </div>
            <div className="jrp-drawer-body">
              <div className="jrp-form-grid">
                <div className="jrp-field"><label>Job Title *</label><input value={createForm.job_title} onChange={(e) => setField('job_title', e.target.value)} /></div>
                <div className="jrp-field"><label>Department *</label>
                  <select value={createForm.department_id} onChange={(e) => setField('department_id', e.target.value)}>
                    <option value="">-- Select Department --</option>
                    {deptList.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div className="jrp-field"><label>Employment Type</label><select value={createForm.employment_type} onChange={(e) => setField('employment_type', e.target.value)}><option value="full_time">Full Time</option><option value="contract">Contract</option><option value="intern">Intern</option><option value="part_time">Part Time</option></select></div>
                <div className="jrp-field"><label>Positions</label><input type="number" min="1" value={createForm.number_of_positions} onChange={(e) => setField('number_of_positions', e.target.value)} /></div>
                <div className="jrp-field"><label>Experience</label><input value={createForm.experience_required} onChange={(e) => setField('experience_required', e.target.value)} /></div>
                <div className="jrp-field"><label>Location</label><input value={createForm.location} onChange={(e) => setField('location', e.target.value)} /></div>
                <div className="jrp-field jrp-field-full"><label>Salary Range</label><input value={createForm.salary_range} onChange={(e) => setField('salary_range', e.target.value)} /></div>
                <div className="jrp-field jrp-field-full"><label>Skills Required</label><input value={createForm.skills_required} onChange={(e) => setField('skills_required', e.target.value)} /></div>
                <div className="jrp-field jrp-field-full"><label>Description</label><textarea rows={4} value={createForm.job_description} onChange={(e) => setField('job_description', e.target.value)} /></div>
              </div>
            </div>
            <div className="jrp-drawer-ft">
              <button className="jrp-btn-outline" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="jrp-btn-primary" onClick={submitCreate} disabled={submitting || !createForm.job_title.trim() || !createForm.department_id.trim()}>{submitting ? 'Saving...' : 'Create'}</button>
            </div>
          </div>
        </div>
      )}

      {showDetail && activeRow && (
        <div className="jrp-overlay" onClick={() => setShowDetail(false)}>
          <div className="jrp-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="jrp-drawer-hd">
              <h3>{activeRow.requisition_no || `REQ-${activeRow.id}`}</h3>
              <button className="jrp-icon-btn" onClick={() => setShowDetail(false)}><X size={16} /></button>
            </div>
            <div className="jrp-drawer-body">
              <div className="jrp-detail-grid">
                <div className="jrp-detail-item"><span className="jrp-detail-lbl">Job Title</span><span className="jrp-detail-val">{activeRow.job_title || '-'}</span></div>
                <div className="jrp-detail-item"><span className="jrp-detail-lbl">Department</span><span className="jrp-detail-val">{activeRow.department || '-'}</span></div>
                <div className="jrp-detail-item"><span className="jrp-detail-lbl">Employment Type</span><span className="jrp-detail-val">{toLabel(activeRow.employment_type)}</span></div>
                <div className="jrp-detail-item"><span className="jrp-detail-lbl">Positions</span><span className="jrp-detail-val">{activeRow.number_of_positions || '-'}</span></div>
                <div className="jrp-detail-item"><span className="jrp-detail-lbl">Requested By</span><span className="jrp-detail-val">{activeRow.requested_by_name || '-'}</span></div>
                <div className="jrp-detail-item"><span className="jrp-detail-lbl">Created</span><span className="jrp-detail-val">{formatDate(activeRow.created_at)}</span></div>
                <div className="jrp-detail-item"><span className="jrp-detail-lbl">Location</span><span className="jrp-detail-val">{activeRow.location || '-'}</span></div>
                <div className="jrp-detail-item"><span className="jrp-detail-lbl">Experience</span><span className="jrp-detail-val">{activeRow.experience_required || '-'}</span></div>
                <div className="jrp-detail-item jrp-detail-full"><span className="jrp-detail-lbl">Skills</span><span className="jrp-detail-val">{activeRow.skills_required || '-'}</span></div>
                <div className="jrp-detail-item jrp-detail-full"><span className="jrp-detail-lbl">Description</span><span className="jrp-detail-val">{activeRow.job_description || '-'}</span></div>
              </div>
            </div>
            <div className="jrp-drawer-ft">
              <button className="jrp-btn-outline" onClick={() => setShowDetail(false)}>Close</button>
              {nextStatus && <button className="jrp-btn-primary" onClick={() => moveStatus(nextStatus)}>Move to {toLabel(nextStatus)}</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
