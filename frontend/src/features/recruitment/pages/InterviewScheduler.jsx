import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import './Recruitment.css';

const InterviewScheduler = () => {
  const navigate = useNavigate();
  const [interviews, setInterviews] = useState([]);
  const [filter, setFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('');

  useEffect(() => {
    fetchInterviews();
  }, [filter, dateFilter]);

  const fetchInterviews = async () => {
    try {
      const token = localStorage.getItem('token');
      let url = 'http://localhost:5000/api/recruitment/interviews?';
      if (filter !== 'all') url += `status=${filter}&`;
      if (dateFilter) url += `interview_date=${dateFilter}`;
      
      const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setInterviews(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const updateInterviewStatus = async (id, status) => {
    try {
      const token = localStorage.getItem('token');
      await axios.put(`http://localhost:5000/api/recruitment/interviews/${id}`,
        { status },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      fetchInterviews();
    } catch (error) {
      alert('Error updating interview status');
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      scheduled: '#dbeafe',
      completed: '#dcfce7',
      cancelled: '#fee2e2',
      rescheduled: '#fef3c7'
    };
    return colors[status] || '#f3f4f6';
  };

  const getModeIcon = (mode) => {
    const icons = {
      online: '💻',
      offline: '🏢',
      phone: '📞'
    };
    return icons[mode] || '📅';
  };

  const groupByDate = () => {
    const grouped = {};
    interviews.forEach(interview => {
      const date = interview.interview_date;
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(interview);
    });
    return grouped;
  };

  const groupedInterviews = groupByDate();
  const sortedDates = Object.keys(groupedInterviews).sort();

  return (
    <div className="recruitment-page">
      <div className="page-header">
        <div>
          <button className="back-btn" onClick={() => navigate('/recruitment/dashboard')}>← Back</button>
          <h1>Interview Schedule</h1>
        </div>
        <div className="header-actions">
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="date-filter"
          />
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="filter-select">
            <option value="all">All Status</option>
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="rescheduled">Rescheduled</option>
          </select>
        </div>
      </div>

      <div className="interview-timeline">
        {sortedDates.map(date => (
          <div key={date} className="date-group">
            <div className="date-header">
              <h3>{new Date(date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</h3>
              <span className="count-badge">{groupedInterviews[date].length} interviews</span>
            </div>
            <div className="interviews-list">
              {groupedInterviews[date].map(interview => (
                <div key={interview.id} className="interview-card">
                  <div className="interview-time">
                    <span className="time">{interview.interview_time}</span>
                    <span className="mode-icon">{getModeIcon(interview.interview_mode)}</span>
                  </div>
                  <div className="interview-details">
                    <h4 onClick={() => navigate(`/recruitment/candidates/${interview.candidate_id}`)} style={{ cursor: 'pointer' }}>
                      {interview.candidate_name}
                    </h4>
                    <p className="interview-email">{interview.candidate_email}</p>
                    <div className="interview-meta">
                      <span className="badge">{interview.interview_mode}</span>
                      {interview.interviewer_name && <span>Interviewer: {interview.interviewer_name}</span>}
                    </div>
                    {interview.meeting_link && (
                      <a href={interview.meeting_link} target="_blank" rel="noopener noreferrer" className="meeting-link">
                        Join Meeting →
                      </a>
                    )}
                    {interview.notes && <p className="interview-notes">{interview.notes}</p>}
                  </div>
                  <div className="interview-actions">
                    <span 
                      className="status-badge" 
                      style={{ background: getStatusColor(interview.status) }}
                    >
                      {interview.status}
                    </span>
                    {interview.status === 'scheduled' && (
                      <div className="action-buttons">
                        <button 
                          className="action-btn-sm success"
                          onClick={() => updateInterviewStatus(interview.id, 'completed')}
                        >
                          Complete
                        </button>
                        <button 
                          className="action-btn-sm danger"
                          onClick={() => updateInterviewStatus(interview.id, 'cancelled')}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {sortedDates.length === 0 && (
        <div className="empty-state">
          <p>No interviews scheduled</p>
        </div>
      )}
    </div>
  );
};

export default InterviewScheduler;
