import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import './Recruitment.css';

const AllCandidates = ({ setPage }) => {
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);
  const [candidates, setCandidates] = useState([]);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchCandidates = async () => {
    try {
      const params = new URLSearchParams();
      if (stageFilter !== 'all') params.append('current_stage', stageFilter);
      if (statusFilter !== 'all') params.append('overall_status', statusFilter);
      const res = await api.get(`/recruitment/candidates?${params.toString()}`);
      setCandidates(Array.isArray(res.data) ? res.data : []);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  useEffect(() => {
    fetchCandidates();
  }, [stageFilter, statusFilter]);

  const openCandidate = (id) => {
    setSelectedCandidateId(id);
    setPage('CandidateDetail');
  };

  const filteredCandidates = candidates.filter(c =>
    (c.full_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (c.email || '').toLowerCase().includes(search.toLowerCase())
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
      applied:      '#dbeafe',
      screening:    '#fef3c7',
      '1st_level':  '#e0e7ff',
      '2nd_level':  '#fce7f3',
      offer:        '#dcfce7',
      hired:        '#d1fae5',
      not_suitable: '#fee2e2',
      maybe:        '#cffafe',
      future_use:   '#ede9fe',
      rejected:     '#fee2e2',
    };
    return colors[stage] || '#f3f4f6';
  };

  return (
    <div className="recruitment-page">
      <div className="page-header">
        <div>
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
          <button
            onClick={() => setPage('CandidatePipeline')}
            style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            + Add via Pipeline
          </button>
        </div>
      </div>

      <div className="filters-bar">
        <div className="filter-group">
          <label>Stage:</label>
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} className="filter-select">
            <option value="all">All Stages</option>
            <option value="applied">Applied</option>
            <option value="screening">Screening</option>
            <option value="1st_level">1st Interview</option>
            <option value="2nd_level">2nd Interview</option>
            <option value="offer">Offer</option>
            <option value="hired">Hired</option>
            <option value="not_suitable">Not Suitable</option>
            <option value="maybe">Maybe</option>
            <option value="future_use">Future Use</option>
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
              <tr key={candidate.id} onClick={() => openCandidate(candidate.id)} style={{ cursor: 'pointer' }}>
                <td><strong>{candidate.full_name}</strong></td>
                <td>{candidate.email}</td>
                <td>{candidate.phone}</td>
                <td>{candidate.job_title || 'N/A'}</td>
                <td><span className="source-badge">{candidate.source}</span></td>
                <td>
                  <span className="status-badge" style={{ background: getStageColor(candidate.current_stage) }}>
                    {candidate.current_stage?.replace(/_/g, ' ')}
                  </span>
                </td>
                <td>
                  <span className="status-badge" style={{ background: getStatusColor(candidate.overall_status) }}>
                    {candidate.overall_status}
                  </span>
                </td>
                <td>{new Date(candidate.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button
                    className="action-btn"
                    onClick={() => openCandidate(candidate.id)}
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
        <div className="empty-state" style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <svg xmlns="http://www.w3.org/2000/svg" width={48} height={48} viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 12 }}><circle cx={12} cy={8} r={4}/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>
          {candidates.length === 0 ? (
            <>
              <p style={{ fontWeight: 600, marginBottom: 6 }}>No candidates yet</p>
              <p style={{ color: '#6b7280', fontSize: 13, marginBottom: 16 }}>Add candidates manually or open a job to start receiving applications.</p>
              <button onClick={() => setPage('CandidatePipeline')} style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 500 }}>+ Add Candidate</button>
            </>
          ) : (
            <>
              <p style={{ fontWeight: 500, marginBottom: 8 }}>No candidates match your filters</p>
              <button onClick={() => { setSearch(''); setStageFilter('all'); setStatusFilter('all'); }} style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 14px', cursor: 'pointer' }}>Clear Filters</button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default AllCandidates;
