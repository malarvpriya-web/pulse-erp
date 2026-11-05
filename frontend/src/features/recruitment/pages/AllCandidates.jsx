import React, { useState, useEffect, useCallback } from 'react';
import { UserPlus } from 'lucide-react';
import api from '@/services/api/client';
import { candidateRows, candidateTotal, SELECTABLE_SOURCES, SOURCE_LABELS } from '../shared/constants';
import useAppStore from '@/store/useAppStore';
import { fmtDate } from '@/utils/dateFormatter';
import DataTable from '@/components/core/DataTable';
import FilterBar from '@/components/core/FilterBar';
import { exportCSV } from '@/features/_shared/exportUtils';
import './Recruitment.css';
import { PageHero, PageShell } from '@/components/pulse-ui';

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

// Experience bands rather than two number boxes: "2-5 years" is how a recruiter
// thinks about it, and each band maps to the min/max the API already accepts.
const EXPERIENCE_BANDS = [
  { value: 'all',   label: 'Any experience', min: undefined, max: undefined },
  { value: '0',     label: 'Fresher',        min: 0,  max: 1 },
  { value: '0-2',   label: '0-2 years',      min: 0,  max: 2 },
  { value: '2-5',   label: '2-5 years',      min: 2,  max: 5 },
  { value: '5-10',  label: '5-10 years',     min: 5,  max: 10 },
  { value: '10',    label: '10+ years',      min: 10, max: undefined },
];

const NOTICE_OPTIONS = [
  { value: 'all', label: 'Any notice period' },
  { value: '15',  label: 'Within 15 days' },
  { value: '30',  label: 'Within 30 days' },
  { value: '60',  label: 'Within 60 days' },
  { value: '90',  label: 'Within 90 days' },
];

const RATING_OPTIONS = [
  { value: 'all', label: 'Any rating' },
  { value: '3',   label: '3+ stars' },
  { value: '3.5', label: '3.5+ stars' },
  { value: '4',   label: '4+ stars' },
  { value: '4.5', label: '4.5+ stars' },
];

const SOURCE_OPTIONS = [
  { value: 'all', label: 'Any source' },
  ...SELECTABLE_SOURCES.map(v => ({ value: v, label: SOURCE_LABELS[v] })),
  { value: 'resume_db', label: SOURCE_LABELS.resume_db },
];

const AllCandidates = ({ setPage }) => {
  const setSelectedCandidateId = useAppStore(s => s.setSelectedCandidateId);
  const [candidates, setCandidates] = useState([]);
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [expBand, setExpBand] = useState('all');
  const [noticeMax, setNoticeMax] = useState('all');
  const [minRating, setMinRating] = useState('all');
  const [location, setLocation] = useState('');
  const [skills, setSkills] = useState('');
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // Every predicate is sent to the API. Search used to be applied client-side
  // over whatever the unfiltered request returned, which meant it could only
  // ever find candidates already on the page — and only by name or email.
  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (stageFilter  !== 'all') params.append('current_stage', stageFilter);
      if (statusFilter !== 'all') params.append('overall_status', statusFilter);
      if (sourceFilter !== 'all') params.append('source', sourceFilter);
      if (noticeMax    !== 'all') params.append('notice_period_max', noticeMax);
      if (minRating    !== 'all') params.append('min_rating', minRating);
      if (location.trim())        params.append('location', location.trim());
      if (skills.trim())          params.append('skills', skills.trim());
      if (search.trim())          params.append('search', search.trim());

      const band = EXPERIENCE_BANDS.find(b => b.value === expBand);
      if (band?.min !== undefined) params.append('experience_min', String(band.min));
      if (band?.max !== undefined) params.append('experience_max', String(band.max));

      const res = await api.get(`/recruitment/candidates?${params.toString()}`);
      const rows = candidateRows(res.data);
      setCandidates(rows);
      setTotal(candidateTotal(res.data, rows));
    } catch (error) {
      console.error('Error:', error);
      setCandidates([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [stageFilter, statusFilter, sourceFilter, noticeMax, minRating, location, skills, search, expBand]);

  // Debounced so typing in Search / Location / Skills does not fire a request
  // per keystroke.
  useEffect(() => {
    const t = setTimeout(fetchCandidates, 300);
    return () => clearTimeout(t);
  }, [fetchCandidates]);

  const openCandidate = (id) => {
    setSelectedCandidateId(id);
    setPage('CandidateDetail');
  };

  // No second, narrower client-side pass — the API answered the same question
  // across more fields and the whole dataset.
  const filteredCandidates = candidates;

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
      screening:    '#ede9fe',
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
    <PageShell dock={
      <PageHero
        icon={UserPlus}
        eyebrow="Recruitment"
        title="All Candidates"
        actions={<button className="plh-cta"
            onClick={() => setPage('CandidatePipeline')}>
            + Add via Pipeline
          </button>}
      />
    }>


      <FilterBar
        filters={[
          { key: 'stage',    label: 'Stage',      type: 'select', options: STAGE_OPTIONS,      defaultValue: 'all' },
          { key: 'status',   label: 'Status',     type: 'select', options: STATUS_OPTIONS,     defaultValue: 'all' },
          { key: 'exp',      label: 'Experience', type: 'select', options: EXPERIENCE_BANDS.map(({ value, label }) => ({ value, label })), defaultValue: 'all' },
          { key: 'notice',   label: 'Notice',     type: 'select', options: NOTICE_OPTIONS,     defaultValue: 'all' },
          { key: 'rating',   label: 'Rating',     type: 'select', options: RATING_OPTIONS,     defaultValue: 'all' },
          { key: 'source',   label: 'Source',     type: 'select', options: SOURCE_OPTIONS,     defaultValue: 'all' },
          { key: 'location', label: 'Location',   type: 'search', placeholder: 'e.g. Bengaluru' },
          { key: 'skills',   label: 'Skills',     type: 'search', placeholder: 'e.g. Power Electronics, MATLAB' },
          { key: 'q',        label: 'Search',     type: 'search', placeholder: 'Name, email, employer, title…' },
        ]}
        values={{
          stage: stageFilter, status: statusFilter, exp: expBand, notice: noticeMax,
          rating: minRating, source: sourceFilter, location, skills, q: search,
        }}
        onChange={(key, val) => {
          if (key === 'stage')         setStageFilter(val);
          else if (key === 'status')   setStatusFilter(val);
          else if (key === 'exp')      setExpBand(val);
          else if (key === 'notice')   setNoticeMax(val);
          else if (key === 'rating')   setMinRating(val);
          else if (key === 'source')   setSourceFilter(val);
          else if (key === 'location') setLocation(val);
          else if (key === 'skills')   setSkills(val);
          else if (key === 'q')        setSearch(val);
        }}
        onReset={() => {
          setSearch(''); setStageFilter('all'); setStatusFilter('all');
          setExpBand('all'); setNoticeMax('all'); setMinRating('all');
          setSourceFilter('all'); setLocation(''); setSkills('');
        }}
        onExport={(fmt) => {
          if (fmt !== 'csv') return;
          exportCSV(filteredCandidates, 'candidates', {
            full_name: 'Name', email: 'Email', phone: 'Phone', job_title: 'Applied For',
            source: 'Source', current_stage: 'Stage', overall_status: 'Status', created_at: 'Applied Date',
          });
        }}
      />
      <div className="results-count" style={{ marginBottom: 8 }}>
        {loading
          ? 'Searching…'
          : total > filteredCandidates.length
            // The API caps a page at 200 rows. Saying "showing 200" without
            // saying "of 340" is how a truncated list gets mistaken for a
            // complete one.
            ? `Showing ${filteredCandidates.length} of ${total} candidates — narrow the filters to see the rest`
            : `${total} candidate${total === 1 ? '' : 's'}`}
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
              <button onClick={() => {
                setSearch(''); setStageFilter('all'); setStatusFilter('all');
                setExpBand('all'); setNoticeMax('all'); setMinRating('all');
                setSourceFilter('all'); setLocation(''); setSkills('');
              }} style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 14px', cursor: 'pointer' }}>Clear Filters</button>
            </>
          )}
        </div>
      )}
    </PageShell>
  );
};

export default AllCandidates;
