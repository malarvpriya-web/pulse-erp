import React, { useState, useEffect } from 'react';
import axios from 'axios';
import '../../crm/pages/Leads.css';

const LeaveSettings = () => {
  const [leaveTypes, setLeaveTypes] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [allocations, setAllocations] = useState([]);
  const [showTypeForm, setShowTypeForm] = useState(false);
  const [showAllocationForm, setShowAllocationForm] = useState(false);
  const [typeForm, setTypeForm] = useState({ leave_name: '', default_days: '', description: '' });
  const [allocationForm, setAllocationForm] = useState({ employee_id: '', leave_type_id: '', allocated_days: '', year: new Date().getFullYear() });

  useEffect(() => {
    fetchLeaveTypes();
    fetchEmployees();
    fetchAllocations();
  }, []);

  const fetchLeaveTypes = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/leaves-new/types', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setLeaveTypes(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchEmployees = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/employees', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setEmployees(res.data.filter(e => e.status !== 'Left'));
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchAllocations = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get('http://localhost:5000/api/leaves-new/allocations', {
        headers: { Authorization: `Bearer ${token}` }
      });
      setAllocations(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleAddLeaveType = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:5000/api/leaves-new/types', typeForm, {
        headers: { Authorization: `Bearer ${token}` }
      });
      alert('Leave type added successfully');
      setShowTypeForm(false);
      setTypeForm({ leave_name: '', default_days: '', description: '' });
      fetchLeaveTypes();
    } catch (error) {
      alert('Error adding leave type');
    }
  };

  const handleAllocateLeave = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:5000/api/leaves-new/allocate', allocationForm, {
        headers: { Authorization: `Bearer ${token}` }
      });
      alert('Leave allocated successfully');
      setShowAllocationForm(false);
      setAllocationForm({ employee_id: '', leave_type_id: '', allocated_days: '', year: new Date().getFullYear() });
      fetchAllocations();
    } catch (error) {
      alert('Error allocating leave');
    }
  };

  const handleBulkAllocate = async () => {
    if (!window.confirm('Allocate default leaves to all active employees for current year?')) return;
    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:5000/api/leaves-new/bulk-allocate', 
        { year: new Date().getFullYear() },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      alert('Bulk allocation completed');
      fetchAllocations();
    } catch (error) {
      alert('Error in bulk allocation');
    }
  };

  return (
    <div className="leads-page">
      <div className="leads-header">
        <h1>Leave Settings</h1>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className="primary-btn" onClick={() => setShowTypeForm(true)}>Add Leave Type</button>
          <button className="primary-btn" onClick={() => setShowAllocationForm(true)}>Allocate Leave</button>
          <button className="primary-btn" onClick={handleBulkAllocate}>Bulk Allocate</button>
        </div>
      </div>

      <div style={{ marginBottom: '30px' }}>
        <h2 style={{ fontSize: '24px', marginBottom: '15px' }}>Leave Types</h2>
        <div className="leads-table-container">
          <table className="leads-table">
            <thead>
              <tr>
                <th>Leave Name</th>
                <th>Default Days</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {leaveTypes.map(type => (
                <tr key={type.id}>
                  <td>{type.leave_name}</td>
                  <td>{type.default_days}</td>
                  <td>{type.description || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h2 style={{ fontSize: '24px', marginBottom: '15px' }}>Leave Allocations ({new Date().getFullYear()})</h2>
        <div className="leads-table-container">
          <table className="leads-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Leave Type</th>
                <th>Allocated Days</th>
                <th>Used Days</th>
                <th>Remaining</th>
                <th>Year</th>
              </tr>
            </thead>
            <tbody>
              {allocations.map(alloc => (
                <tr key={alloc.id}>
                  <td>{alloc.employee_name}</td>
                  <td>{alloc.leave_name}</td>
                  <td>{alloc.allocated_days}</td>
                  <td>{alloc.used_days}</td>
                  <td>{alloc.remaining_days}</td>
                  <td>{alloc.year}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showTypeForm && (
        <div className="form-modal">
          <div className="form-card">
            <h2>Add Leave Type</h2>
            <form onSubmit={handleAddLeaveType}>
              <div className="form-group">
                <label>Leave Name *</label>
                <input value={typeForm.leave_name} onChange={(e) => setTypeForm({ ...typeForm, leave_name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Default Days *</label>
                <input type="number" value={typeForm.default_days} onChange={(e) => setTypeForm({ ...typeForm, default_days: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea value={typeForm.description} onChange={(e) => setTypeForm({ ...typeForm, description: e.target.value })} rows="3" />
              </div>
              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => setShowTypeForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Add Leave Type</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAllocationForm && (
        <div className="form-modal">
          <div className="form-card">
            <h2>Allocate Leave</h2>
            <form onSubmit={handleAllocateLeave}>
              <div className="form-group">
                <label>Employee *</label>
                <select value={allocationForm.employee_id} onChange={(e) => setAllocationForm({ ...allocationForm, employee_id: e.target.value })} required>
                  <option value="">Select Employee</option>
                  {employees.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name} ({emp.office_id})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Leave Type *</label>
                <select value={allocationForm.leave_type_id} onChange={(e) => setAllocationForm({ ...allocationForm, leave_type_id: e.target.value })} required>
                  <option value="">Select Leave Type</option>
                  {leaveTypes.map(type => (
                    <option key={type.id} value={type.id}>{type.leave_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Allocated Days *</label>
                <input type="number" value={allocationForm.allocated_days} onChange={(e) => setAllocationForm({ ...allocationForm, allocated_days: e.target.value })} required />
              </div>
              <div className="form-group">
                <label>Year *</label>
                <input type="number" value={allocationForm.year} onChange={(e) => setAllocationForm({ ...allocationForm, year: e.target.value })} required />
              </div>
              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => setShowAllocationForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Allocate</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default LeaveSettings;
