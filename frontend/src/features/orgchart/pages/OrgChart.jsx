// PATH: frontend/src/features/orgchart/pages/OrgChart.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Users, ChevronDown, ChevronRight, RefreshCw, AlertCircle, Building2, List } from 'lucide-react';
import api from '@/services/api/client';
import './OrgChart.css';

const DEPT_COLORS = [
  '#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444',
  '#8b5cf6','#ec4899','#14b8a6','#f97316','#84cc16',
];

function initials(name = '') {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function deptColor(dept, depts) {
  const idx = depts.indexOf(dept);
  return DEPT_COLORS[idx % DEPT_COLORS.length] || '#6b7280';
}

function OrgNode({ node, depth, departments, expanded, toggleNode, onNodeClick }) {
  const hasChildren = node.children?.length > 0;
  const isOpen = expanded.has(node.id);
  const color = deptColor(node.department, departments);

  return (
    <li className="org-node-wrap">
      <div className={`org-node-card org-depth-${Math.min(depth, 4)}`} style={{ '--nd': color }}>
        {node.photo
          ? <img src={node.photo} alt={node.name} className="org-node-avatar org-node-photo" style={{ background: color }} />
          : <div className="org-node-avatar" style={{ background: color }}>{initials(node.name)}</div>
        }
        <div className="org-node-info">
          <div
            className="org-node-name org-node-link"
            onClick={() => onNodeClick && onNodeClick(node)}
            title="View profile"
            style={{ cursor: onNodeClick ? 'pointer' : 'default' }}
          >{node.name}</div>
          <div className="org-node-title">{node.designation || '—'}</div>
          <div className="org-node-dept">{node.department || '—'}</div>
        </div>
        {hasChildren && (
          <button className="org-node-toggle" onClick={() => toggleNode(node.id)} title={isOpen ? 'Collapse' : 'Expand'}>
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{node.children.length}</span>
          </button>
        )}
      </div>
      {hasChildren && isOpen && (
        <ul className="org-children">
          {node.children.map(child => (
            <OrgNode
              key={child.id}
              node={child}
              depth={depth + 1}
              departments={departments}
              expanded={expanded}
              toggleNode={toggleNode}
              onNodeClick={onNodeClick}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function countNodes(nodes) {
  return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children || []), 0);
}

function collectIds(nodes, ids = new Set()) {
  nodes.forEach(n => { ids.add(n.id); collectIds(n.children || [], ids); });
  return ids;
}

function collectIdsUpToDepth(nodes, maxDepth, depth = 0, ids = new Set()) {
  if (depth >= maxDepth) return ids;
  nodes.forEach(n => {
    ids.add(n.id);
    if (n.children?.length) collectIdsUpToDepth(n.children, maxDepth, depth + 1, ids);
  });
  return ids;
}

// Deep check: node matches if it OR any descendant belongs to the dept
function nodeMatchesDept(node, dept) {
  if ((node.department || '') === dept) return true;
  return (node.children || []).some(c => nodeMatchesDept(c, dept));
}

export default function OrgChart({ setPage, setSelectedEmployee }) {
  const [tree, setTree]         = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepts] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [filterDept, setFilter] = useState('');
  const [showEmpList, setShowEmpList] = useState(true);
  const [empSearch, setEmpSearch] = useState('');

  // Manual assignment panel
  const [selEmployee, setSelEmployee] = useState('');
  const [selManager, setSelManager]   = useState('');
  const [saving, setSaving]           = useState(false);
  const [saveMsg, setSaveMsg]         = useState(null);

  const isMounted = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; }; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [autoRes, flatRes, deptRes] = await Promise.allSettled([
        api.get('/orgchart/auto-tree'),
        api.get('/orgchart/hierarchy'),
        api.get('/orgchart/departments'),
      ]);

      if (!isMounted.current) return;

      const treeData = autoRes.status === 'fulfilled' ? (autoRes.value.data?.data || []) : [];
      const flatData = flatRes.status === 'fulfilled' ? (flatRes.value.data || []) : [];
      const deptData = deptRes.status === 'fulfilled' ? (deptRes.value.data?.data || []) : [];

      setTree(treeData);
      setEmployees(flatData);
      setDepts(deptData);
      // Expand first 2 levels so 3 levels are visible by default
      setExpanded(collectIdsUpToDepth(treeData, 2));
    } catch (err) {
      if (isMounted.current) setError(err.message || 'Failed to load org chart');
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleNode = useCallback((id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const expandAll = () => setExpanded(collectIds(tree));
  const collapseAll = () => setExpanded(new Set());

  const handleUpdateManager = async () => {
    if (!selEmployee || !selManager) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.post('/orgchart/relationship', { employee_id: selEmployee, manager_id: selManager });
      setSaveMsg({ type: 'ok', text: 'Reporting structure updated' });
      await load();
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Failed to update';
      setSaveMsg({ type: 'err', text: msg });
    } finally {
      setSaving(false);
    }
  };

  const handleNodeClick = (node) => {
    if (!setPage || !setSelectedEmployee) return;
    const emp = { id: node.id, name: node.name, designation: node.designation, department: node.department, photo_url: node.photo };
    sessionStorage.setItem('selectedEmployeeId', String(node.id));
    sessionStorage.setItem('selectedEmployee', JSON.stringify(emp));
    setSelectedEmployee(emp);
    setPage('EmployeeProfile');
  };

  const visibleTree = filterDept
    ? tree.filter(n => nodeMatchesDept(n, filterDept))
    : tree;

  const total = countNodes(tree);

  return (
    <div className="org-page">
      {/* Header */}
      <div className="org-header">
        <div>
          <h1 className="org-title">Organization Chart</h1>
          <p className="org-sub">Auto-generated from employee reporting hierarchy · {total} people</p>
        </div>
        <div className="org-header-actions">
          <button className="org-btn-ghost" onClick={expandAll}>Expand All</button>
          <button className="org-btn-ghost" onClick={collapseAll}>Collapse All</button>
          <button className="org-btn-refresh" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'org-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="org-toolbar">
        <select className="org-select" value={filterDept} onChange={e => setFilter(e.target.value)}>
          <option value="">All Departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <div className="org-legend">
          {departments.slice(0, 6).map((d, i) => (
            <span key={d} className="org-legend-item">
              <span className="org-legend-dot" style={{ background: DEPT_COLORS[i % DEPT_COLORS.length] }} />
              {d}
            </span>
          ))}
        </div>
      </div>

      {/* Manual assignment panel */}
      <div className="org-assign-panel">
        <div className="org-assign-title"><Building2 size={14} /> Assign Reporting Manager</div>
        <div className="org-assign-row">
          <select className="org-select" value={selEmployee} onChange={e => setSelEmployee(e.target.value)}>
            <option value="">Select Employee</option>
            {employees.map(e => <option key={e.id} value={e.id}>{e.name} — {e.designation || '—'}</option>)}
          </select>
          <span className="org-assign-arrow">→</span>
          <select className="org-select" value={selManager} onChange={e => setSelManager(e.target.value)}>
            <option value="">Select Manager</option>
            {employees.filter(e => String(e.id) !== selEmployee).map(e => (
              <option key={e.id} value={e.id}>{e.name} — {e.designation || '—'}</option>
            ))}
          </select>
          <button className="org-btn-primary" onClick={handleUpdateManager} disabled={!selEmployee || !selManager || saving}>
            {saving ? 'Saving…' : 'Update'}
          </button>
        </div>
        {saveMsg && (
          <div className={`org-save-msg org-save-${saveMsg.type}`}>{saveMsg.text}</div>
        )}
      </div>

      {/* Employees List */}
      <div className="org-emp-panel">
        <div className="org-emp-panel-header" onClick={() => setShowEmpList(v => !v)}>
          <span className="org-emp-panel-title">
            <List size={14} /> All Employees
            <span className="org-emp-count">{employees.length}</span>
          </span>
          {showEmpList ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        {showEmpList && (
          <div className="org-emp-body">
            <input
              className="org-emp-search"
              placeholder="Search by name, department or designation…"
              value={empSearch}
              onChange={e => setEmpSearch(e.target.value)}
            />
            <table className="org-emp-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Designation</th>
                  <th>Department</th>
                  <th>Reporting Manager</th>
                  <th>Email</th>
                </tr>
              </thead>
              <tbody>
                {employees
                  .filter(emp => {
                    if (!empSearch) return true;
                    const q = empSearch.toLowerCase();
                    return (
                      (emp.name || '').toLowerCase().includes(q) ||
                      (emp.designation || '').toLowerCase().includes(q) ||
                      (emp.department || '').toLowerCase().includes(q)
                    );
                  })
                  .map(emp => (
                    <tr key={emp.id} style={{ cursor: setPage ? 'pointer' : 'default' }} onClick={() => handleNodeClick(emp)} title="View profile">
                      <td>
                        {emp.photo
                          ? <img src={emp.photo} alt={emp.name} className="org-emp-avatar" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', verticalAlign: 'middle', marginRight: 6 }} />
                          : <span className="org-emp-avatar" style={{ background: deptColor(emp.department, departments) }}>{initials(emp.name)}</span>
                        }
                        <span style={{ color: setPage ? '#6B3FDB' : 'inherit', fontWeight: 600 }}>{emp.name}</span>
                      </td>
                      <td>{emp.designation || '—'}</td>
                      <td>
                        {emp.department ? (
                          <span className="org-emp-dept-badge" style={{ background: deptColor(emp.department, departments) + '22', color: deptColor(emp.department, departments) }}>
                            {emp.department}
                          </span>
                        ) : '—'}
                      </td>
                      <td>{emp.manager_name || '—'}</td>
                      <td className="org-emp-email">{emp.email || '—'}</td>
                    </tr>
                  ))}
                {employees.length === 0 && (
                  <tr><td colSpan={5} className="org-emp-empty">No employees found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Tree */}
      <div className="org-tree-wrap">
        {loading && !tree.length ? (
          <div className="org-state-center">
            <RefreshCw size={28} className="org-spin" style={{ color: '#6366f1' }} />
            <p>Building hierarchy…</p>
          </div>
        ) : error ? (
          <div className="org-state-center">
            <AlertCircle size={28} style={{ color: '#dc2626' }} />
            <p style={{ color: '#dc2626' }}>{error}</p>
            <button className="org-btn-primary" onClick={load}>Retry</button>
          </div>
        ) : visibleTree.length === 0 ? (
          <div className="org-state-center">
            <Users size={40} style={{ color: '#d1d5db' }} />
            <p style={{ color: '#9ca3af' }}>
              No hierarchy found. Set a <strong>Reporting Manager</strong> on employee profiles or use the panel above.
            </p>
          </div>
        ) : (
          <ul className="org-root">
            {visibleTree.map(node => (
              <OrgNode
                key={node.id}
                node={node}
                depth={0}
                departments={departments}
                expanded={expanded}
                toggleNode={toggleNode}
                onNodeClick={handleNodeClick}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
