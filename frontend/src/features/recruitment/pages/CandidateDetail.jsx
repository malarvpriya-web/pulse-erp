import React, { useState, useEffect, useCallback } from 'react';
import api from '@/services/api/client';
import useAppStore from '@/store/useAppStore';
import { useToast } from '@/context/ToastContext';
import './Recruitment.css';

const STAGE_LABELS = {
  applied:      'Applied',
  screening:    'Screening',
  '1st_level':  '1st Interview',
  '2nd_level':  '2nd Interview',
  offer:        'Offer',
  hired:        'Hired',
  not_suitable: 'Not Suitable',
  maybe:        'Maybe',
  future_use:   'Future Use',
  rejected:     'Rejected',
};

const ACTIVE_STAGES = ['applied', 'screening', '1st_level', '2nd_level', 'offer', 'hired'];

const STAGE_COLORS = {
  applied:      { bg: '#dbeafe', color: '#1e40af' },
  screening:    { bg: '#fef3c7', color: '#92400e' },
  '1st_level':  { bg: '#e0e7ff', color: '#4338ca' },
  '2nd_level':  { bg: '#fce7f3', color: '#9d174d' },
  offer:        { bg: '#dcfce7', color: '#15803d' },
  hired:        { bg: '#d1fae5', color: '#065f46' },
  not_suitable: { bg: '#fee2e2', color: '#991b1b' },
  maybe:        { bg: '#cffafe', color: '#0e7490' },
  future_use:   { bg: '#ede9fe', color: '#6d28d9' },
  rejected:     { bg: '#fee2e2', color: '#b91c1c' },
};

const CandidateDetail = ({ setPage }) => {
  const _toast = useToast();
  const toast  = useCallback((msg, type = 'success') => _toast({ message: msg, type }), [_toast]);

  const id = useAppStore(s => s.selectedCandidateId);

  const [candidate,          setCandidate]          = useState(null);
  const [loading,            setLoading]            = useState(true);
  const [history,            setHistory]            = useState([]);
  const [interviews,         setInterviews]         = useState([]);
  const [notes,              setNotes]              = useState([]);
  const [showInterviewForm,  setShowInterviewForm]  = useState(false);
  const [showNoteForm,       setShowNoteForm]       = useState(false);
  const [movingStage,        setMovingStage]        = useState(false);

  const [interviewData, setInterviewData] = useState({
    interview_date: '', interview_time: '', interview_mode: 'online',
    meeting_link: '', interviewer_name: '', notes: '',
  });
  const [noteData, setNoteData] = useState({
    interview_round: '', rating: '', comments: '', recommendation: 'hold',
  });

  const fetchAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    const [candRes, histRes, intRes, noteRes] = await Promise.allSettled([
      api.get(`/recruitment/candidates/${id}`),
      api.get(`/recruitment/candidates/${id}/history`),
      api.get('/recruitment/interviews', { params: { candidate_id: id } }),
      api.get(`/recruitment/interview-notes/${id}`),
    ]);
    setCandidate(candRes.status === 'fulfilled' ? candRes.value.data : null);
    setHistory(histRes.status === 'fulfilled' && Array.isArray(histRes.value.data) ? histRes.value.data : []);
    setInterviews(intRes.status === 'fulfilled' && Array.isArray(intRes.value.data) ? intRes.value.data : []);
    setNotes(noteRes.status === 'fulfilled' && Array.isArray(noteRes.value.data) ? noteRes.value.data : []);
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Guard: no candidate id selected
  if (!id) {
    return (
      <div className="recruitment-page">
        <div className="page-header">
          <button className="back-btn" onClick={() => setPage('AllCandidates')}>← Back</button>
        </div>
        <div style={{ textAlign: 'center', padding: '4rem 1rem', color: '#6b7280' }}>
          No candidate selected. Go back and select one.
        </div>
      </div>
    );
  }

  if (loading) return <div className="recruitment-page" style={{ padding: 24, color: '#6b7280' }}>Loading…</div>;

  if (!candidate) return (
    <div className="recruitment-page">
      <div className="page-header">
        <button className="back-btn" onClick={() => setPage('AllCandidates')}>← Back</button>
      </div>
      <div style={{ padding: 24, color: '#dc2626' }}>Failed to load candidate.</div>
    </div>
  );

  const handleScheduleInterview = async (e) => {
    e.preventDefault();
    try {
      await api.post('/recruitment/interviews', {
        candidate_id:   id,
        interview_date: interviewData.interview_date,
        interview_time: interviewData.interview_time,
        interview_mode: interviewData.interview_mode,
        meeting_link:   interviewData.meeting_link || null,
        notes: interviewData.interviewer_name
          ? `Interviewer: ${interviewData.interviewer_name}${interviewData.notes ? ' — ' + interviewData.notes : ''}`
          : interviewData.notes,
      });
      toast('Interview scheduled');
      setShowInterviewForm(false);
      setInterviewData({ interview_date: '', interview_time: '', interview_mode: 'online', meeting_link: '', interviewer_name: '', notes: '' });
      fetchAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Error scheduling interview', 'error');
    }
  };

  const handleAddNote = async (e) => {
    e.preventDefault();
    try {
      await api.post('/recruitment/interview-notes', { ...noteData, candidate_id: id });
      toast('Feedback added');
      setShowNoteForm(false);
      setNoteData({ interview_round: '', rating: '', comments: '', recommendation: 'hold' });
      fetchAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Error adding feedback', 'error');
    }
  };

  const handleMoveStage = async (newStage) => {
    if (movingStage || newStage === candidate.current_stage) return;
    setMovingStage(true);
    try {
      await api.post(`/recruitment/candidates/${id}/move-stage`, { new_stage: newStage });
      setCandidate(c => ({ ...c, current_stage: newStage }));
      toast(`Moved to ${STAGE_LABELS[newStage] || newStage}`);
      fetchAll();
    } catch (err) {
      toast(err?.response?.data?.error || 'Failed to move stage', 'error');
    } finally {
      setMovingStage(false);
    }
  };

  const sc = STAGE_COLORS[candidate.current_stage] || { bg: '#f3f4f6', color: '#374151' };

  return (
    <div className="recruitment-page">
      <div className="page-header">
        <div>
          <button className="back-btn" onClick={() => setPage('AllCandidates')}>← Back</button>
          <h1>{candidate.full_name}</h1>
        </div>
        <div className="header-actions">
          <button className="action-btn" onClick={() => setShowInterviewForm(true)}>Schedule Interview</button>
          <button className="action-btn" onClick={() => setShowNoteForm(true)}>Add Feedback</button>
        </div>
      </div>

      {/* Move Stage Section */}
      <div style={{ background: '#fff', borderRadius: 10, border: '1px solid #f0f0f4', padding: '14px 18px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 10 }}>
          Move Stage
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ACTIVE_STAGES.map(stage => {
            const isCurrent = candidate.current_stage === stage;
            const stageColor = STAGE_COLORS[stage] || { bg: '#f3f4f6', color: '#374151' };
            return (
              <button
                key={stage}
                onClick={() => handleMoveStage(stage)}
                disabled={movingStage}
                style={{
                  padding: '5px 12px',
                  borderRadius: 20,
                  border: isCurrent ? `2px solid ${stageColor.color}` : '2px solid transparent',
                  background: isCurrent ? stageColor.bg : '#f9fafb',
                  color: isCurrent ? stageColor.color : '#6b7280',
                  fontWeight: isCurrent ? 700 : 500,
                  fontSize: 12,
                  cursor: movingStage ? 'not-allowed' : 'pointer',
                  transition: 'all .15s',
                }}
              >
                {STAGE_LABELS[stage]}
                {isCurrent && ' ✓'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Schedule Interview Modal */}
      {showInterviewForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Schedule Interview</h2>
            <form onSubmit={handleScheduleInterview}>
              <div className="form-row">
                <div className="form-group">
                  <label>Interview Date *</label>
                  <input type="date" required
                    value={interviewData.interview_date}
                    onChange={e => setInterviewData(p => ({ ...p, interview_date: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Interview Time *</label>
                  <input type="time" required
                    value={interviewData.interview_time}
                    onChange={e => setInterviewData(p => ({ ...p, interview_time: e.target.value }))} />
                </div>
              </div>
              <div className="form-group">
                <label>Interview Mode</label>
                <select value={interviewData.interview_mode}
                  onChange={e => setInterviewData(p => ({ ...p, interview_mode: e.target.value }))}>
                  <option value="online">Online</option>
                  <option value="offline">In Person</option>
                  <option value="phone">Phone</option>
                </select>
              </div>
              {interviewData.interview_mode === 'online' && (
                <div className="form-group">
                  <label>Meeting Link</label>
                  <input type="url" placeholder="https://meet.google.com/…"
                    value={interviewData.meeting_link}
                    onChange={e => setInterviewData(p => ({ ...p, meeting_link: e.target.value }))} />
                </div>
              )}
              <div className="form-group">
                <label>Interviewer Name</label>
                <input placeholder="e.g. Rajesh Kumar"
                  value={interviewData.interviewer_name}
                  onChange={e => setInterviewData(p => ({ ...p, interviewer_name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <textarea rows={3}
                  value={interviewData.notes}
                  onChange={e => setInterviewData(p => ({ ...p, notes: e.target.value }))} />
              </div>
              <div className="form-actions">
                <button type="button" className="cancel-btn" onClick={() => setShowInterviewForm(false)}>Cancel</button>
                <button type="submit" className="submit-btn">Schedule</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Feedback Modal */}
      {showNoteForm && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h2>Add Interview Feedback</h2>
            <form onSubmit={handleAddNote}>
              <div className="form-group">
                <label>Interview Round *</label>
                <select required value={noteData.interview_round}
                  onChange={e => setNoteData(p => ({ ...p, interview_round: e.target.value }))}>
                  <option value="">-- Select Round --</option>
                  {['HR Round','Technical Round 1','Technical Round 2','Technical Round 3','Managerial Round','Final Round','Assignment','Reference Check'].map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Rating (1–5) *</label>
                  <input type="number" min="1" max="5" step="0.1" required
                    value={noteData.rating}
                    onChange={e => setNoteData(p => ({ ...p, rating: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Recommendation</label>
                  <select value={noteData.recommendation}
                    onChange={e => setNoteData(p => ({ ...p, recommendation: e.target.value }))}>
                    <option value="strong_hire">Strong Hire</option>
                    <option value="hire">Hire</option>
                    <option value="hold">Hold</option>
                    <option value="reject">Reject</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Comments *</label>
                <textarea rows={4} required
                  value={noteData.comments}
                  onChange={e => setNoteData(p => ({ ...p, comments: e.target.value }))} />
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
          <div className="info-row"><span className="label">Email:</span><span>{candidate.email}</span></div>
          <div className="info-row"><span className="label">Phone:</span><span>{candidate.phone}</span></div>
          <div className="info-row"><span className="label">Source:</span><span className="source-badge">{candidate.source}</span></div>
          <div className="info-row"><span className="label">Applied For:</span><span>{candidate.job_title || '—'}</span></div>
          <div className="info-row">
            <span className="label">Current Stage:</span>
            <span className="status-badge" style={{ background: sc.bg, color: sc.color }}>
              {candidate.current_stage?.replace(/_/g, ' ')}
            </span>
          </div>
          <div className="info-row"><span className="label">Status:</span><span className="status-badge">{candidate.overall_status}</span></div>
        </div>

        <div className="detail-card">
          <h3>Stage History</h3>
          <div className="timeline">
            {history.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13 }}>No history yet.</p>}
            {history.map((item, index) => (
              <div key={index} className="timeline-item">
                <div className="timeline-dot" />
                <div className="timeline-content">
                  <strong>{item.stage?.replace(/_/g, ' ')}</strong>
                  {item.notes && <p>{item.notes}</p>}
                  <small>{new Date(item.moved_date).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</small>
                  {item.moved_by_name && <small> by {item.moved_by_name}</small>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="section">
        <h2>Scheduled Interviews</h2>
        {interviews.length === 0
          ? <p style={{ color: '#9ca3af', fontSize: 13 }}>No interviews scheduled yet.</p>
          : (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th><th>Time</th><th>Mode</th><th>Interviewer</th><th>Status</th><th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {interviews.map(iv => (
                    <tr key={iv.id}>
                      <td>{iv.interview_date ? new Date(iv.interview_date + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}</td>
                      <td>{iv.interview_time}</td>
                      <td><span className="badge">{iv.interview_mode}</span></td>
                      <td>{iv.interviewer_name || 'TBD'}</td>
                      <td><span className="status-badge">{iv.status}</span></td>
                      <td>{iv.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <div className="section">
        <h2>Interview Feedback</h2>
        {notes.length === 0
          ? <p style={{ color: '#9ca3af', fontSize: 13 }}>No feedback yet.</p>
          : (
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
                      {note.recommendation?.replace(/_/g, ' ')}
                    </span>
                    <small>{note.interviewer_name} · {new Date(note.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
};

export default CandidateDetail;
