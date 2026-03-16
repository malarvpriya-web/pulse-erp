import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './Recruitment.css';

const AllCandidates = () => {
  const navigate = useNavigate();
  const [candidates, setCandidates] = useState([]);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    fetchCandidates();
  }, [stageFilter, statusFilter]);

  const fetchCandidates = async () => {
    try {
      const token = localStorage.getItem('token');
      let url = 'http://localhost:5000/api/recruitment/candidates?';
      if (stageFilter !== 'all') url += `current_stage=${stageFilter}&`;
      if (statusFilter !== 'all') url += `overall_status=${statusFilter}`;
      
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCandidates(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const filteredCandidates = candidates.filter(c => 
    c.full_name.toLowerCase().includes(search.toLowerCase()) ||
    c.email.toLowerCase().includes(search.toLowerCase())
  );

  const getStatusColor = (status) => {
    const colors = {
      active: '#dcfce7',
      rejected: '#fee2e2',
      hired: '#d1fae5',
      withdrawn: '#f3f4f6'
    };
    return colors[status] || '#f3f4f6';
  };

  const getStageColor = (stage) => {
    const colors = {
      applied: '#dbeafe',
      screening: '#fef3c7',
      hr_round: '#fed7aa',
      technical_round: '#e0e7ff',
      final_round: '#fce7f3',
      offer: '#dcfce7',
      hired: '#d1fae5',
      rejected: '#fee2e2'
    };
    return colors[stage] || '#f3f4f6';
  };

  return (
    <div className="recruitment-page">
      <div className="page-header">
        <div>
          <button className="back-btn" onClick={() => navigate('/recruitment/dashboard')}>← Back</button>
          <h1>All Candidates</h1>
        </div>
        <div className="header-actions">
          <input
            type="text"
            placeholder="Search candidates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="search-input"
          />
        </div>
      </div>

      <div className="filters-bar">
        <div className="filter-group">
          <label>Stage:</label>
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="filter-select">
            <option value="all">All Stages</option>
            <option value="applied">Applied</option>
            <option value="screening">Screening</option>
            <option value="hr_round">HR Round</option>
            <option value="technical_round">Technical Round</option>
            <option value="final_round">Final Round</option>
            <option value="offer">Offer</option>
            <option value="hired">Hired</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <div className="filter-group">
          <label>Status:</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="filter-select">
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="hired">Hired</option>
            <option value="rejected">Rejected</option>
            <option value="withdrawn">Withdrawn</option>
          </select>
        </div>

        <div className="results-count">
          Showing {filteredCandidates.length} candidates
        </div>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Applied For</th>
              <th>Source</th>
              <th>Current Stage</th>
              <th>Status</th>
              <th>Applied Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredCandidates.map(candidate => (
              <tr key={candidate.id} onClick={() => navigate(`/recruitment/candidates/${candidate.id}`)} style={{ cursor: 'pointer' }}>
                <td><strong>{candidate.full_name}</strong></td>
                <td>{candidate.email}</td>
                <td>{candidate.phone}</td>
                <td>{candidate.job_title || 'N/A'}</td>
                <td><span className="source-badge">{candidate.source}</span></td>
                <td>
                  <span className="status-badge" style={{ background: getStageColor(candidate.current_stage) }}>
                    {candidate.current_stage?.replace('_', ' ')}
                  </span>
                </td>
                <td>
                  <span className="status-badge" style={{ background: getStatusColor(candidate.overall_status) }}>
                    {candidate.overall_status}
                  </span>
                </td>
                <td>{new Date(candidate.created_at).toLocaleDateString()}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button 
                    className="action-btn"
                    onClick={() => navigate(`/recruitment/candidates/${candidate.id}`)}
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filteredCandidates.length === 0 && (
        <div className="empty-state">
          <p>No candidates found</p>
        </div>
      )}
    </div>
  );
};

export default AllCandidates;
