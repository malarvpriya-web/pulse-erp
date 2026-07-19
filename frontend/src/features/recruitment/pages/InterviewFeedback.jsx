import { useState, useEffect, useCallback } from 'react';
import { Star, Plus, X, MessageSquare, ThumbsUp, ThumbsDown, Minus } from 'lucide-react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';

const RATING_LABELS = { 1:'Poor', 2:'Below Average', 3:'Average', 4:'Good', 5:'Excellent' };
const RECOMMENDATION_META = {
  hire:        { label:'Hire',         bg:'#d1fae5', color:'#065f46', icon: ThumbsUp },
  no_hire:     { label:'No Hire',      bg:'#fee2e2', color:'#991b1b', icon: ThumbsDown },
  hold:        { label:'Hold',         bg:'#fef3c7', color:'#92400e', icon: Minus },
};

const ROUNDS = ['HR Round', '1st Technical', '2nd Technical', 'Final Round', 'Management Round'];

function StarRating({ value, onChange }) {
  const [hover, setHover] = useState(0);
  return (
    <div style={{ display:'flex', gap:4 }}>
      {[1,2,3,4,5].map(n => (
        <button key={n} type="button"
          onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)}
          onClick={() => onChange(n)}
          style={{ background:'none', border:'none', cursor:'pointer', padding:2 }}>
          <Star size={22} fill={(hover||value) >= n ? '#f59e0b' : 'none'} color={(hover||value) >= n ? '#f59e0b' : '#d1d5db'} />
        </button>
      ))}
      {value > 0 && <span style={{ fontSize:12, color:'#6b7280', alignSelf:'center', marginLeft:4 }}>{RATING_LABELS[value]}</span>}
    </div>
  );
}

function FeedbackForm({ candidateId, candidateName, onSaved, onCancel, showToast }) {
  const [form, setForm] = useState({
    interview_round: 'HR Round',
    rating: 0,
    recommendation: '',
    comments: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const handleSave = async () => {
    if (!form.rating)        return showToast('Please give a rating', 'error');
    if (!form.recommendation) return showToast('Please select a recommendation', 'error');
    if (!form.comments.trim()) return showToast('Comments are required', 'error');
    setSaving(true);
    try {
      await api.post('/recruitment/interview-notes', {
        candidate_id: candidateId,
        ...form,
      });
      showToast('Feedback submitted');
      onSaved();
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to save feedback', 'error');
    } finally {
      setSaving(false);
    }
  };

  const inp = { width:'100%', padding:'8px 12px', border:'1px solid #e5e7eb', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box', fontFamily:'inherit' };
  const lbl = { display:'block', marginBottom:5, fontSize:11, fontWeight:700, color:'#374151', textTransform:'uppercase', letterSpacing:'.04em' };

  return (
    <div style={{ background:'#fff', borderRadius:14, border:'1.5px solid #e0e7ff', padding:24, marginBottom:16 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:700, color:'#111827' }}>Add Interview Feedback</div>
          <div style={{ fontSize:12, color:'#9ca3af', marginTop:2 }}>for {candidateName}</div>
        </div>
        <button onClick={onCancel} style={{ background:'#f3f4f6', border:'none', borderRadius:8, padding:7, cursor:'pointer', display:'flex' }}><X size={14} color="#6b7280"/></button>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:16 }}>
        <div>
          <label style={lbl}>Interview Round</label>
          <select style={inp} value={form.interview_round} onChange={e => set('interview_round', e.target.value)}>
            {ROUNDS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label style={lbl}>Recommendation</label>
          <div style={{ display:'flex', gap:8 }}>
            {Object.entries(RECOMMENDATION_META).map(([key, meta]) => {
              const Icon = meta.icon;
              const selected = form.recommendation === key;
              return (
                <button key={key} type="button" onClick={() => set('recommendation', key)}
                  style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:5, padding:'8px 10px', borderRadius:8, border:`2px solid ${selected?meta.color:'#e5e7eb'}`,
                    background: selected ? meta.bg : '#fff', color: selected ? meta.color : '#6b7280', cursor:'pointer', fontSize:12, fontWeight:700, transition:'all .15s' }}>
                  <Icon size={13} /> {meta.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ marginBottom:16 }}>
        <label style={lbl}>Rating</label>
        <StarRating value={form.rating} onChange={v => set('rating', v)} />
      </div>

      <div style={{ marginBottom:18 }}>
        <label style={lbl}>Detailed Comments *</label>
        <textarea style={{ ...inp, minHeight:100, resize:'vertical' }}
          value={form.comments} onChange={e => set('comments', e.target.value)}
          placeholder="Describe the candidate's performance, strengths, and areas of concern…" />
      </div>

      <div style={{ display:'flex', justifyContent:'flex-end', gap:10 }}>
        <button onClick={onCancel} style={{ padding:'8px 18px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f9fafb', color:'#374151', fontWeight:600, cursor:'pointer', fontSize:13 }}>Cancel</button>
        <button onClick={handleSave} disabled={saving}
          style={{ padding:'8px 22px', borderRadius:8, border:'none', background:'#4B2DCE', color:'#fff', fontWeight:700, cursor:'pointer', fontSize:13, opacity:saving?0.7:1 }}>
          {saving ? 'Saving…' : 'Submit Feedback'}
        </button>
      </div>
    </div>
  );
}

function FeedbackCard({ note }) {
  const rec = RECOMMENDATION_META[note.recommendation] || RECOMMENDATION_META.hold;
  const RecIcon = rec.icon;
  return (
    <div style={{ background:'#fff', borderRadius:12, border:'1px solid #f0f0f4', padding:18, marginBottom:12 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:12, flexWrap:'wrap', gap:8 }}>
        <div>
          <div style={{ fontWeight:700, fontSize:14, color:'#111827' }}>{note.interview_round || 'Interview'}</div>
          <div style={{ fontSize:12, color:'#9ca3af', marginTop:2 }}>
            by {note.interviewer_name || 'Interviewer'} · {new Date(note.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
          </div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <div style={{ display:'flex', gap:2 }}>
            {[1,2,3,4,5].map(n => <Star key={n} size={14} fill={note.rating >= n ? '#f59e0b' : 'none'} color={note.rating >= n ? '#f59e0b' : '#d1d5db'} />)}
          </div>
          <span style={{ padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:rec.bg, color:rec.color, display:'flex', alignItems:'center', gap:4 }}>
            <RecIcon size={10} /> {rec.label}
          </span>
        </div>
      </div>
      <p style={{ fontSize:13, color:'#374151', margin:0, lineHeight:1.6 }}>{note.comments}</p>
    </div>
  );
}

export default function InterviewFeedback({ candidateId, candidateName, onClose }) {
  const _toast = useToast();
  const showToast = useCallback((msg, type='success') => _toast({ message: msg, type }), [_toast]);

  const [notes,      setNotes]      = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [showForm,   setShowForm]   = useState(false);

  const load = useCallback(async () => {
    if (!candidateId) return;
    setLoading(true);
    try {
      const res = await api.get(`/recruitment/interview-notes/${candidateId}`);
      setNotes(Array.isArray(res.data) ? res.data : []);
    } catch {
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [candidateId]);

  useEffect(() => { load(); }, [load]);

  const avgRating = notes.length > 0
    ? (notes.reduce((s, n) => s + (n.rating||0), 0) / notes.length).toFixed(1)
    : null;

  return (
    <div style={{ padding:'20px 24px', maxWidth:720 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
        <div>
          <h2 style={{ fontSize:18, fontWeight:800, color:'#111827', margin:0 }}>Interview Feedback</h2>
          {candidateName && <p style={{ color:'#6b7280', margin:'3px 0 0', fontSize:13 }}>{candidateName}</p>}
        </div>
        <div style={{ display:'flex', gap:10, alignItems:'center' }}>
          {avgRating && (
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:20, background:'#fef3c7', color:'#92400e' }}>
              <Star size={13} fill="#f59e0b" color="#f59e0b" />
              <span style={{ fontWeight:700, fontSize:13 }}>{avgRating} avg</span>
            </div>
          )}
          <button onClick={() => setShowForm(true)} style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', background:'#4B2DCE', color:'#fff', border:'none', borderRadius:9, cursor:'pointer', fontWeight:700, fontSize:13 }}>
            <Plus size={13} /> Add Feedback
          </button>
          {onClose && (
            <button onClick={onClose} style={{ background:'#f3f4f6', border:'none', borderRadius:8, padding:7, cursor:'pointer', display:'flex' }}><X size={15} color="#6b7280"/></button>
          )}
        </div>
      </div>

      {showForm && (
        <FeedbackForm
          candidateId={candidateId}
          candidateName={candidateName}
          showToast={showToast}
          onCancel={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); load(); }}
        />
      )}

      {loading ? (
        <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>Loading…</div>
      ) : notes.length === 0 ? (
        <div style={{ textAlign:'center', padding:40, color:'#9ca3af' }}>
          <MessageSquare size={32} color="#d1d5db" style={{ display:'block', margin:'0 auto 8px' }}/>
          <p>No feedback submitted yet.</p>
        </div>
      ) : (
        <div>
          <div style={{ fontSize:12, color:'#9ca3af', marginBottom:12 }}>{notes.length} feedback record{notes.length !== 1 ? 's' : ''}</div>
          {notes.map(n => <FeedbackCard key={n.id} note={n} />)}
        </div>
      )}
    </div>
  );
}
