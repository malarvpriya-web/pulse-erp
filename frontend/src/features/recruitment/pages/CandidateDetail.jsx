import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useParams, useNavigate } from 'react-router-dom';
import './Recruitment.css';

const CandidateDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [candidate, setCandidate] = useState(null);
  const [history, setHistory] = useState([]);
  const [interviews, setInterviews] = useState([]);
  const [notes, setNotes] = useState([]);
  const [showInterviewForm, setShowInterviewForm] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [interviewData, setInterviewData] = useState({
    interview_date: '',
    interview_time: '',
    interview_mode: 'online',
    meeting_link: '',
    interviewer_id: '',
    notes: ''
  });
  const [noteData, setNoteData] = useState({
    interview_round: '',
    rating: '',
    comments: '',
    recommendation: 'hold'
  });

  useEffect(() => {
    fetchCandidate();
    fetchHistory();
    fetchInterviews();
    fetchNotes();
  }, [id]);

  const fetchCandidate = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:5000/api/recruitment/candidates/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCandidate(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchHistory = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:5000/api/recruitment/candidates/${id}/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setHistory(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchInterviews = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:5000/api/recruitment/interviews?candidate_id=${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setInterviews(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const fetchNotes = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await axios.get(`http://localhost:5000/api/recruitment/interview-notes/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setNotes(res.data);
    } catch (error) {
      console.error('Error:', error);
    }
  };

  const handleScheduleInterview = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      await axios.post('http://localhost:5000/api/recruitment/interviews',
        { ...interviewData, candidate_id: id },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      alert('Interview scheduled successfully');
      setShowInterviewForm(false);
      setInterviewData({ interview_date: '', interview_time: '', interview_mode: 'online', meeting_link: '', interviewer_id: '', notes: '' });
      fetchInterviews();
    } catch (error) {
      alert('Error scheduling interview');
    }
  };

  const handleAddNote = async (e) => {
    e.preventDefault();
    try {
      const token = localStorage.getItem('token');
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      await axios.post('http://localhost:5000/api/recruitment/interview-notes',
        { ...noteData, candidate_id: id, interviewer_id: currentUser.id },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      alert('Note added successfully');
      setShowNoteForm(false);
      setNoteData({ interview_round: '', rating: '', comments: '', recommendation: 'hold' });
      fetchNotes();
    } catch (error) {
      alert('Error adding note');
    }
  };

  if (!candidate) return <div>Loading...</div>;

  return (
    <div className="recruitment-page">
      <div className="page-header">
        <div>
          <button className="back-btn" onClick={() => navigate(-1)}>← Back</button>
          <h1>{candidate.full_name}</h1>
        </div>
        <div className="header-actions">
          <button className="action-btn" onClick={() => setShowInterviewForm(true)}>Schedule Interview</button>
          <button className="action-btn" onClick={() => setShowNoteForm(true)}>Add Feedback</button>
        </div>
      </div>

      {showInterviewForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Schedule Interview</h2>
            <form onSubmit={handleScheduleInterview}>
              <div className="form-row">
                <div className="form-group">
                  <label>Interview Date *</label>
                  <input
                    type="date"
                    value={interviewData.interview_date}
                    onChange={(e) => setInterviewData({ ...interviewData, interview_date: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Interview Time *</label>
                  <input
                    type="time"
                    value={interviewData.interview_time}
                    onChange={(e) => setInterviewData({ ...interviewData, interview_time: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Interview Mode</label>
                <select
                  value={interviewData.interview_mode}
                  onChange={(e) => setInterviewData({ ...interviewData, interview_mode: e.target.value })}
                >
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                  <option value="phone">Phone</option>
                </select>
              </div>

              {interviewData.interview_mode === 'online' && (
                <div className="form-group">
                  <label>Meeting Link</label>
                  <input
                    type="url"
                    value={interviewData.meeting_link}
                    onChange={(e) => setInterviewData({ ...interviewData, meeting_link: e.target.value })}
                    placeholder="https://meet.google.com/..."
                  />
                </div>
              )}

              <div className="form-group">
                <label>Notes</label>
                <textarea
                  value={interviewData.notes}
                  onChange={(e) => setInterviewData({ ...interviewData, notes: e.target.value })}
                  rows="3"
                />
              </div>

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => setShowInterviewForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Schedule</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showNoteForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Add Interview Feedback</h2>
            <form onSubmit={handleAddNote}>
              <div className="form-group">
                <label>Interview Round *</label>
                <input
                  type="text"
                  value={noteData.interview_round}
                  onChange={(e) => setNoteData({ ...noteData, interview_round: e.target.value })}
                  placeholder="e.g., Technical Round 1"
                  required
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Rating (1-5) *</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    step="0.1"
                    value={noteData.rating}
                    onChange={(e) => setNoteData({ ...noteData, rating: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Recommendation</label>
                  <select
                    value={noteData.recommendation}
                    onChange={(e) => setNoteData({ ...noteData, recommendation: e.target.value })}
                  >
                    <option value="strong_hire">Strong Hire</option>
                    <option value="hire">Hire</option>
                    <option value="hold">Hold</option>
                    <option value="reject">Reject</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Comments *</label>
                <textarea
                  value={noteData.comments}
                  onChange={(e) => setNoteData({ ...noteData, comments: e.target.value })}
                  rows="4"
                  required
                />
              </div>

              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => setShowNoteForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Add Feedback</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="detail-grid">
        <div className="detail-card">
          <h3>Candidate Information</h3>
          <div className="info-row">
            <span className="label">Email:</span>
            <span>{candidate.email}</span>
          </div>
          <div className="info-row">
            <span className="label">Phone:</span>
            <span>{candidate.phone}</span>
          </div>
          <div className="info-row">
            <span className="label">Source:</span>
            <span className="source-badge">{candidate.source}</span>
          </div>
          <div className="info-row">
            <span className="label">Applied For:</span>
            <span>{candidate.job_title}</span>
          </div>
          <div className="info-row">
            <span className="label">Current Stage:</span>
            <span className="status-badge">{candidate.current_stage?.replace('_', ' ')}</span>
          </div>
          <div className="info-row">
            <span className="label">Status:</span>
            <span className="status-badge">{candidate.overall_status}</span>
          </div>
        </div>

        <div className="detail-card">
          <h3>Stage History</h3>
          <div className="timeline">
            {history.map((item, index) => (
              <div key={index} className="timeline-item">
                <div className="timeline-dot"></div>
                <div className="timeline-content">
                  <strong>{item.stage?.replace('_', ' ')}</strong>
                  <p>{item.notes}</p>
                  <small>{new Date(item.moved_date).toLocaleString()}</small>
                  {item.moved_by_name && <small> by {item.moved_by_name}</small>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="section">
        <h2>Scheduled Interviews</h2>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Time</th>
                <th>Mode</th>
                <th>Interviewer</th>
                <th>Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {interviews.map(interview => (
                <tr key={interview.id}>
                  <td>{new Date(interview.interview_date).toLocaleDateString()}</td>
                  <td>{interview.interview_time}</td>
                  <td><span className="badge">{interview.interview_mode}</span></td>
                  <td>{interview.interviewer_name || 'TBD'}</td>
                  <td><span className="status-badge">{interview.status}</span></td>
                  <td>{interview.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <h2>Interview Feedback</h2>
        <div className="notes-grid">
          {notes.map(note => (
            <div key={note.id} className="note-card">
              <div className="note-header">
                <strong>{note.interview_round}</strong>
                <span className="rating">⭐ {note.rating}/5</span>
              </div>
              <p>{note.comments}</p>
              <div className="note-footer">
                <span className={`recommendation-badge ${note.recommendation}`}>
                  {note.recommendation?.replace('_', ' ')}
                </span>
                <small>{note.interviewer_name} - {new Date(note.created_at).toLocaleDateString()}</small>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CandidateDetail;
