import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';
import './OrgChart.css';

const OrgChart = () => {
  const [employees, setEmployees] = useState([]);
  const [orgData, setOrgData] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // Form State
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [selectedManager, setSelectedManager] = useState('');

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const res = await api.get('/employees');
      setEmployees(res.data);
      buildHierarchy(res.data);
    } catch (err) {
      console.error("Failed to fetch employees", err);
    } finally {
      setLoading(false);
    }
  };

  const buildHierarchy = (empList) => {
    // Simple hierarchy builder
    const hierarchy = empList.map(emp => ({
      id: emp.id,
      name: `${emp.first_name} ${emp.last_name}`,
      title: emp.designation,
      managerId: emp.reporting_manager_id, // Assuming ID is stored, or match by name
      children: []
    }));

    const rootNodes = [];
    const lookup = {};
    hierarchy.forEach(node => lookup[node.id] = node);

    hierarchy.forEach(node => {
      if (node.managerId && lookup[node.managerId]) {
        lookup[node.managerId].children.push(node);
      } else {
        rootNodes.push(node);
      }
    });

    setOrgData(rootNodes);
  };

  const handleUpdateManager = async () => {
    if (!selectedEmployee || !selectedManager) return;
    if (selectedEmployee === selectedManager) {
      alert("Employee cannot report to themselves");
      return;
    }

    try {
      // Assuming endpoint exists to update manager
      await api.put(`/employees/${selectedEmployee}`, { reporting_manager_id: selectedManager });
      alert("Reporting structure updated!");
      fetchData(); // Refresh tree
    } catch (err) {
      alert("Failed to update hierarchy");
    }
  };

  const renderTree = (nodes) => {
    return (
      <ul className="org-tree">
        {nodes.map(node => (
          <li key={node.id}>
            <div className="org-node">
              <strong>{node.name}</strong>
              <p>{node.title}</p>
            </div>
            {node.children.length > 0 && renderTree(node.children)}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="org-chart-page" style={{ padding: '20px' }}>
      <h1>Organization Chart</h1>

      <div className="org-controls widget" style={{ marginBottom: '20px', padding: '20px', display: 'flex', gap: '15px', alignItems: 'end' }}>
        <div>
          <label style={{ display: 'block', marginBottom: '5px' }}>Select Employee</label>
          <select 
            className="filter" 
            value={selectedEmployee} 
            onChange={e => setSelectedEmployee(e.target.value)}
            style={{ padding: '10px', width: '250px' }}
          >
            <option value="">-- Choose Employee --</option>
            {employees.map(e => (
              <option key={e.id} value={e.id}>{e.first_name} {e.last_name} ({e.designation})</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', marginBottom: '5px' }}>Assign Manager</label>
          <select 
            className="filter" 
            value={selectedManager} 
            onChange={e => setSelectedManager(e.target.value)}
            style={{ padding: '10px', width: '250px' }}
          >
            <option value="">-- Choose Manager --</option>
            {employees.map(e => (
              <option key={e.id} value={e.id}>{e.first_name} {e.last_name} ({e.designation})</option>
            ))}
          </select>
        </div>

        <button className="primary-btn" onClick={handleUpdateManager}>Update Hierarchy</button>
      </div>

      <div className="org-display widget" style={{ padding: '40px', overflowX: 'auto' }}>
        {loading ? <p>Loading...</p> : (
          orgData.length > 0 ? renderTree(orgData) : <p>No hierarchy data found. Assign managers to build the tree.</p>
        )}
      </div>
    </div>
  );
};

export default OrgChart;