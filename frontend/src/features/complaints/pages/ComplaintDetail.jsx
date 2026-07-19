import { useState, useEffect, useCallback } from 'react';
import {
  ArrowLeft, User, Mail, Phone, Tag, AlertTriangle, Clock,
  CheckCircle, MessageSquare, ChevronDown, Send
} from 'lucide-react';
import api from '@/services/api/client';
import { sm, VALID_TRANSITIONS } from './complaintsConstants';

const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';

function relTime(d) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  if (m < 1440)return `${Math.floor(m/60)}h ago`;
  return `${Math.floor(m/1440)}d ago`;
}

function TimelineIcon({ from, to }) {
  if (!from)                         return <div style={{ width:32, height:32, borderRadius:'50%', background:'#dbeafe', color:'#1d4ed8', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><MessageSquare size={14} /></div>;
  if (to==='resolved'||to==='closed')return <div style={{ width:32, height:32, borderRadius:'50%', background:'#dcfce7', color:'#15803d', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><CheckCircle size={14} /></div>;
  if (to==='escalated')              return <div style={{ width:32, height:32, borderRadius:'50%', background:'#fdf4ff', color:'#7e22ce', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><AlertTriangle size={14} /></div>;
  if (to==='assigned'||to==='in_progress') return <div style={{ width:32, height:32, borderRadius:'50%', background:'#fef3c7', color:'#92400e', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><User size={14} /></div>;
  return <div style={{ width:32, height:32, borderRadius:'50%', background:'#f3f4f6', color:'#6b7280', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><Clock size={14} /></div>;
}

function timelineDesc(h) {
  if (!h.from_status) return 'Complaint raised';
  if (h.from_status && h.to_status) return `Status: ${h.from_status.replace('_',' ')} → ${h.to_status.replace('_',' ')}`;
  return h.comment || 'Updated';
}

/**
 * @param {Function} setPage - navigate to another page key
 */
export default function ComplaintDetail({ setPage, urlParams }) {
  const [complaint, setComplaint]   = useState(null);
  const [loading,   setLoading]     = useState(false);
  const [comment,   setComment]     = useState('');
  const [statusDd,  setStatusDd]    = useState(false);
  const [submitting,setSubmitting]  = useState(false);
  const [toast,     setToast]       = useState(null);

  const showToast = (msg, type='success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    const id = urlParams?.id || sessionStorage.getItem('selectedComplaintId');
    if (!id) { setComplaint(null); setLoading(false); return; }
    try {
      const res = await api.get(`/complaints/${id}`);
      setComplaint(res.data || null);
    } catch {
      const stored = sessionStorage.getItem('selectedComplaint');
      setComplaint(stored ? { ...JSON.parse(stored), history: [] } : null);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const changeStatus = async (newStatus) => {
    setStatusDd(false);
    setSubmitting(true);
    try {
      await api.put(`/complaints/${complaint.id}/status`, { status: newStatus, comment });
      setComplaint(c => ({
        ...c, status: newStatus,
        history: [...(c.history||[]), {
          id: Date.now(), from_status: c.status, to_status: newStatus,
          changed_by_name: 'You', comment, created_at: new Date().toISOString(),
        }],
      }));
      setComment('');
      showToast(`Status changed to ${newStatus.replace('_',' ')}`);
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to update status', 'error');
    } finally { setSubmitting(false); }
  };

  const addComment = async () => {
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await api.post(`/complaints/${complaint.id}/comments`, { comment });
      setComplaint(c => ({
        ...c,
        history: [...(c.history||[]), {
          id: Date.now(), from_status: c.status, to_status: c.status,
          changed_by_name: 'You', comment, created_at: new Date().toISOString(),
        }],
      }));
      setComment('');
      showToast('Comment added');
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to post comment', 'error');
    } finally { setSubmitting(false); }
  };


  const c = complaint || {};
  const s = sm(c.status);
  const allowed = VALID_TRANSITIONS[c.status] || [];
  const isOverdue = c.sla_due && new Date(c.sla_due) < new Date();

  return (
    <div style={{ padding:24 }}>

      {toast && (
        <div style={{ position:'fixed', top:20, right:20, zIndex:9999, background: toast.type==='error'?'#fee2e2':'#dcfce7', color: toast.type==='error'?'#991b1b':'#166534', padding:'12px 20px', borderRadius:10, fontSize:13, fontWeight:600, boxShadow:'0 4px 12px rgba(0,0,0,0.15)' }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ marginBottom:20 }}>
        <button onClick={() => setPage && setPage('CustomerComplaintsIPCS')}
          style={{ display:'flex', alignItems:'center', gap:6, color:'#6b7280', background:'none', border:'none', cursor:'pointer', fontSize:13, marginBottom:12, padding:0 }}>
          <ArrowLeft size={14} /> Back to Complaints
        </button>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
          <div>
            <span style={{ fontSize:12, color:'#9ca3af', fontFamily:'monospace' }}>{c.complaint_number}</span>
            <h2 style={{ fontSize:20, fontWeight:800, color:'#111827', margin:'4px 0 8px' }}>{c.title}</h2>
            <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
              <span style={{ background:s.bg, color:s.color, padding:'3px 12px', borderRadius:20, fontSize:12, fontWeight:700 }}>{s.label}</span>
              <span style={{ background: c.priority==='High'?'#fee2e2':c.priority==='Critical'?'#fdf4ff':'#fef3c7', color: c.priority==='High'?'#dc2626':c.priority==='Critical'?'#7e22ce':'#92400e', padding:'3px 10px', borderRadius:5, fontSize:12, fontWeight:600 }}>{c.priority}</span>
              <span style={{ background:'#f3f4f6', color:'#374151', padding:'3px 10px', borderRadius:5, fontSize:12, fontWeight:600 }}>{c.category}</span>
            </div>
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            {/* Status change dropdown */}
            {allowed.length > 0 && (
              <div style={{ position:'relative' }}>
                <button onClick={() => setStatusDd(!statusDd)}
                  style={{ padding:'8px 14px', borderRadius:8, border:'1px solid #6366f1', background:'#fff', color:'#6366f1', cursor:'pointer', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6 }}>
                  Change Status <ChevronDown size={13} />
                </button>
                {statusDd && (
                  <div style={{ position:'absolute', right:0, top:'100%', marginTop:4, background:'#fff', border:'1px solid #e5e7eb', borderRadius:10, boxShadow:'0 4px 16px rgba(0,0,0,0.12)', zIndex:100, minWidth:160, padding:'4px 0', overflow:'hidden' }}>
                    {allowed.map(ns => {
                      const ns_m = sm(ns);
                      return (
                        <button key={ns} onClick={() => changeStatus(ns)}
                          style={{ display:'block', width:'100%', textAlign:'left', padding:'9px 16px', border:'none', background:'none', cursor:'pointer', fontSize:13, color:'#111827' }}
                          onMouseEnter={e => e.currentTarget.style.background='#f5f3ff'}
                          onMouseLeave={e => e.currentTarget.style.background='none'}>
                          <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:ns_m.color, marginRight:8 }} />
                          {ns_m.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Two-column layout */}
      <div style={{ display:'grid', gridTemplateColumns:'1.6fr 1fr', gap:20, alignItems:'start' }}>

        {/* LEFT — Timeline */}
        <div>
          <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:20, boxShadow:'0 1px 3px rgba(0,0,0,0.04)', marginBottom:20 }}>
            <h4 style={{ fontSize:14, fontWeight:700, color:'#111827', margin:'0 0 16px' }}>Description</h4>
            <p style={{ fontSize:13, color:'#374151', lineHeight:1.7, margin:0 }}>{c.description || '—'}</p>
          </div>

          <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:20, boxShadow:'0 1px 3px rgba(0,0,0,0.04)' }}>
            <h4 style={{ fontSize:14, fontWeight:700, color:'#111827', margin:'0 0 20px' }}>Timeline</h4>

            <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
              {(c.history||[]).map((h, idx) => (
                <div key={h.id} style={{ display:'flex', gap:14, paddingBottom: idx < (c.history.length-1) ? 20 : 0 }}>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'center' }}>
                    <TimelineIcon from={h.from_status} to={h.to_status} />
                    {idx < (c.history.length-1) && (
                      <div style={{ width:2, flex:1, background:'#f0f0f4', marginTop:4 }} />
                    )}
                  </div>
                  <div style={{ flex:1, paddingTop:4 }}>
                    <p style={{ fontSize:13, fontWeight:600, color:'#111827', margin:'0 0 2px' }}>{timelineDesc(h)}</p>
                    <p style={{ fontSize:11, color:'#9ca3af', margin:'0 0 4px' }}>{relTime(h.created_at)} · by {h.changed_by_name || 'System'}</p>
                    {h.comment && h.comment !== 'Complaint submitted.' && (
                      <p style={{ fontSize:12, color:'#374151', background:'#f9fafb', padding:'8px 12px', borderRadius:8, margin:'6px 0 0', borderLeft:'3px solid #e5e7eb' }}>{h.comment}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Add comment */}
            <div style={{ marginTop:24, paddingTop:20, borderTop:'1px solid #f0f0f4' }}>
              <h5 style={{ fontSize:13, fontWeight:700, color:'#111827', margin:'0 0 10px' }}>Add Comment</h5>
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder="Add a comment or update…"
                rows={3}
                style={{ width:'100%', border:'1px solid #e5e7eb', borderRadius:8, padding:'10px 12px', fontSize:13, resize:'vertical', outline:'none', fontFamily:'inherit', boxSizing:'border-box' }}
              />
              <div style={{ display:'flex', justifyContent:'flex-end', marginTop:8 }}>
                <button onClick={addComment} disabled={submitting || !comment.trim()}
                  style={{ padding:'8px 16px', borderRadius:8, border:'none', background: (!comment.trim()||submitting) ? '#e5e7eb' : '#6366f1', color: (!comment.trim()||submitting) ? '#9ca3af' : '#fff', cursor: (!comment.trim()||submitting) ? 'not-allowed' : 'pointer', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6 }}>
                  <Send size={13} /> {submitting ? 'Posting…' : 'Post Comment'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT — Details */}
        <div style={{ background:'#fff', border:'1px solid #f0f0f4', borderRadius:12, padding:20, boxShadow:'0 1px 3px rgba(0,0,0,0.04)' }}>
          <h4 style={{ fontSize:14, fontWeight:700, color:'#111827', margin:'0 0 16px' }}>Details</h4>
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
            {[
              ['Customer',    c.customer_name,  <User size={13} />],
              ['Email',       c.customer_email, <Mail size={13} />],
              ['Phone',       c.customer_phone, <Phone size={13} />],
              ['Category',    c.category,       <Tag size={13} />],
              ['Priority',    c.priority,       <AlertTriangle size={13} />],
              ['Department',  c.department,     null],
              ['Assigned To', c.assigned_to_name || '—', <User size={13} />],
              ['Created',     fmtDate(c.created_at), <Clock size={13} />],
              ['Last Updated',fmtDate(c.updated_at), null],
            ].map(([lbl, val, icon]) => (
              <div key={lbl} style={{ display:'flex', justifyContent:'space-between', gap:12, paddingBottom:12, borderBottom:'1px solid #f9fafb' }}>
                <span style={{ fontSize:12, color:'#9ca3af', fontWeight:500, display:'flex', alignItems:'center', gap:5 }}>
                  {icon}{lbl}
                </span>
                <span style={{ fontSize:13, color:'#111827', fontWeight:500, textAlign:'right', maxWidth:160, wordBreak:'break-word' }}>{val || '—'}</span>
              </div>
            ))}
            {/* SLA due */}
            <div style={{ display:'flex', justifyContent:'space-between', gap:12 }}>
              <span style={{ fontSize:12, color:'#9ca3af', fontWeight:500, display:'flex', alignItems:'center', gap:5 }}><Clock size={13} />SLA Due</span>
              <span style={{ fontSize:13, fontWeight:600, color: isOverdue ? '#dc2626' : '#111827' }}>
                {c.sla_due ? new Date(c.sla_due).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                {isOverdue && ' ⚠'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
