import React, { useState, useEffect } from 'react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import { fmtDate } from '@/utils/dateFormatter';
import { matchesSearch } from '../shared/search';
import DataTable from '@/components/core/DataTable';
import FilterBar from '@/components/core/FilterBar';
import { exportCSV } from '@/features/_shared/exportUtils';
import './Recruitment.css';

const STAGE_OPTIONS = [
  { value: 'all', label: 'All Stages' },
  { value: 'applied', label: 'Applied' },
  { value: 'screening', label: 'Screening' },
  { value: '1st_level', label: '1st Interview' },
  { value: '2nd_level', label: '2nd Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'hired', label: 'Hired' },
  { value: 'not_suitable', label: 'Not Suitable' },
  { value: 'maybe', label: 'Maybe' },
  { value: 'future_use', label: 'Future Use' },
  { value: 'rejected', label: 'Rejected' },
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Status' },
  { value: 'active', label: 'Active' },
  { value: 'hired', label: 'Hired' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

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

  const filteredCandidates = candidates.filter(c => matchesSearch(c, ['full_name', 'email'], search));

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
          <button
            onClick={() => setPage('CandidatePipeline')}
            style={{ background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            + Add via Pipeline
          </button>
        </div>
      </div>

      <FilterBar
        filters={[
          { key: 'stage', label: 'Stage', type: 'select', options: STAGE_OPTIONS, defaultValue: 'all' },
          { key: 'status', label: 'Status', type: 'select', options: STATUS_OPTIONS, defaultValue: 'all' },
          { key: 'q', label: 'Search', type: 'search', placeholder: 'Search candidates...' },
        ]}
        values={{ stage: stageFilter, status: statusFilter, q: search }}
        onChange={(key, val) => {
          if (key === 'stage') setStageFilter(val);
          else if (key === 'status') setStatusFilter(val);
          else if (key === 'q') setSearch(val);
        }}
        onReset={() => { setSearch(''); setStageFilter('all'); setStatusFilter('all'); }}
        onExport={(fmt) => {
          if (fmt !== 'csv') return;
          exportCSV(filteredCandidates, 'candidates', {
            full_name: 'Name', email: 'Email', phone: 'Phone', job_title: 'Applied For',
            source: 'Source', current_stage: 'Stage', overall_status: 'Status', created_at: 'Applied Date',
          });
        }}
      />
      <div className="results-count" style={{ marginBottom: 8 }}>
        Showing {filteredCandidates.length} candidates
      </div>

      <DataTable
        selectable={false}
        emptyText="No candidates found"
        columns={[
          {
            key: 'full_name', label: 'Name', sortable: true,
            render: (v, row) => (
              <strong style={{ color: '#6366f1', cursor: 'pointer' }} onClick={() => openCandidate(row.id)}>{v}</strong>
            ),
          },
          { key: 'email', label: 'Email' },
          { key: 'phone', label: 'Phone' },
          { key: 'job_title', label: 'Applied For', render: v => v || 'N/A' },
          { key: 'source', label: 'Source', render: v => <span className="source-badge">{v}</span> },
          {
            key: 'current_stage', label: 'Current Stage', sortable: true,
            render: v => (
              <span className="status-badge" style={{ background: getStageColor(v) }}>
                {v?.replace(/_/g, ' ')}
              </span>
            ),
          },
          {
            key: 'overall_status', label: 'Status', sortable: true,
            render: v => (
              <span className="status-badge" style={{ background: getStatusColor(v) }}>{v}</span>
            ),
          },
          { key: 'created_at', label: 'Applied Date', sortable: true, render: v => fmtDate(v) },
          {
            key: 'actions', label: 'Actions',
            render: (_, row) => (
              <button className="action-btn" onClick={() => openCandidate(row.id)}>View</button>
            ),
          },
        ]}
        rows={filteredCandidates}
      />

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
