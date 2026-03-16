import React, { useState, useEffect } from 'react';
import axios from 'axios';
import '../../crm/pages/Leads.css';

const Reports = () => {
  const [reportType, setReportType] = useState('attendance');
  const [reportData, setReportData] = useState([]);
  const [filters, setFilters] = useState({
    start_date: '',
    end_date: '',
    department: '',
    status: ''
  });

  const fetchReport = async () => {
    try {
      const token = localStorage.getItem('token');
      let url = `http://localhost:5000/api/reports/${reportType}`;
      
      const params = new URLSearchParams();
      Object.keys(filters).forEach(key => {
        if (filters[key]) params.append(key, filters[key]);
      });
      
      if (params.toString()) url += `?${params.toString()}`;
      
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setReportData(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const exportToExcel = () => {
    alert('Export to Excel functionality - integrate with library like xlsx');
  };

  const renderReportTable = () => {
    if (!reportData.length) return <p>No data available</p>;

    const columns = Object.keys(reportData[0]);

    return (
      <table className="leads-table">
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col}>{col.replace(/_/g, ' ').toUpperCase()}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {reportData.map((row, idx) => (
            <tr key={idx}>
              {columns.map(col => (
                <td key={col}>{row[col]?.toString() || '-'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  return (
    <div className="leads-page">
      <div className="leads-header">
        <h1>Reports</h1>
        <button className="primary-btn" onClick={exportToExcel}>Export to Excel</button>
      </div>

      <div style={{ background: 'white', padding: '20px', borderRadius: '12px', marginBottom: '20px' }}>
        <div className="form-row">
          <div className="form-group">
            <label>Report Type</label>
            <select value={reportType} onChange={(e) => setReportType(e.target.value)}>
              <option value="attendance">Attendance Report</option>
              <option value="leave">Leave Report</option>
              <option value="sales">Sales Report</option>
              <option value="stock">Stock Report</option>
              <option value="project-cost">Project Cost Report</option>
            </select>
          </div>

          {reportType !== 'stock' && (
            <>
              <div className="form-group">
                <label>Start Date</label>
                <input
                  type="date"
                  value={filters.start_date}
                  onChange={(e) => setFilters({ ...filters, start_date: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>End Date</label>
                <input
                  type="date"
                  value={filters.end_date}
                  onChange={(e) => setFilters({ ...filters, end_date: e.target.value })}
                />
              </div>
            </>
          )}

          <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button className="primary-btn" onClick={fetchReport}>Generate Report</button>
          </div>
        </div>
      </div>

      <div className="leads-table-container">
        {renderReportTable()}
      </div>
    </div>
  );
};

export default Reports;
