import { useState, useEffect, useCallback } from 'react';
import {
  Wrench, MapPin, Camera, Play, CheckCircle2, RefreshCw, X, ChevronRight, Navigation,
} from 'lucide-react';
import api from '@/services/api/client';
import { getPosition, capturePhoto } from '@/mobile/native';

/**
 * EngineerHome — the field-engineer mobile home. A touch-first list of the
 * engineer's own assigned service jobs, each with on-site actions that use the
 * native bridge: GPS check-in (getPosition), site photo (capturePhoto), and
 * start / resolve. Every action posts a field-update logged to the ticket.
 */

const PRIORITY = { high: '#dc2626', medium: '#d97706', low: '#0369a1' };
const STATUS = { open: '#6b7280', 'in progress': '#6366f1', resolved: '#059669' };
const card = { background: '#fff', border: '1px solid #eceaf3', borderRadius: 14, padding: 16, boxShadow: '0 1px 2px rgba(17,24,39,.04)' };
const chip = (color) => ({ background: `${color}1a`, color, padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, textTransform: 'capitalize', whiteSpace: 'nowrap' });
const bigBtn = (bg, disabled) => ({ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: disabled ? '#c7c3d6' : bg, color: '#fff', fontSize: 15, fontWeight: 700, cursor: disabled ? 'default' : 'pointer' });

function JobSheet({ ticket, onClose, onChanged }) {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(null);
  const [msg, setMsg] = useState('');

  const post = async (payload, label) => {
    setBusy(label); setMsg('');
    try {
      const res = await api.post(`/servicedesk/tickets/${ticket.id}/field-update`, payload);
      setMsg('Saved ✓');
      onChanged?.(res.data?.status);
      return true;
    } catch (e) { setMsg(e.response?.data?.error || 'Failed'); return false; }
    finally { setBusy(''); }
  };

  const checkIn = async () => {
    setBusy('checkin'); setMsg('Getting location…');
    try {
      const { latitude, longitude } = await getPosition();
      await post({ lat: latitude, lng: longitude, note: note || undefined }, 'checkin');
    } catch { setMsg('Could not get GPS location'); setBusy(''); }
  };

  const takePhoto = async () => {
    setBusy('photo');
    try {
      const dataUrl = await capturePhoto({ quality: 70 });
      setPhoto(dataUrl);
      await post({ photo_captured: true, note: note || undefined }, 'photo');
    } catch { setMsg('Photo capture cancelled'); setBusy(''); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,.45)', zIndex: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ width: 'min(560px, 100%)', maxHeight: '92vh', overflowY: 'auto', background: '#fff', borderRadius: '18px 18px 0 0', padding: '18px 18px 28px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700, color: '#111827' }}>{ticket.title}</div>
            <div style={{ fontSize: 12.5, color: '#6b7280', marginTop: 3 }}>{ticket.ticket_number}{ticket.customer ? ` · ${ticket.customer}` : ''}{ticket.serial_number ? ` · SN ${ticket.serial_number}` : ''}</div>
          </div>
          <button onClick={onClose} style={{ border: 'none', background: '#f3f4f6', borderRadius: 10, padding: 8, cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
          <span style={chip(PRIORITY[(ticket.priority || '').toLowerCase()] || '#6b7280')}>{ticket.priority || '—'}</span>
          <span style={chip(STATUS[(ticket.status || '').toLowerCase()] || '#6b7280')}>{ticket.status}</span>
        </div>

        {photo && <img src={photo} alt="site" style={{ width: '100%', borderRadius: 12, marginBottom: 14, maxHeight: 220, objectFit: 'cover' }} />}

        <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)…"
          style={{ width: '100%', minHeight: 56, padding: 10, border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 14, boxSizing: 'border-box', marginBottom: 14 }} />

        <div style={{ display: 'grid', gap: 10 }}>
          <button style={bigBtn('#6B3FDB', busy === 'checkin')} onClick={checkIn} disabled={!!busy}>
            <MapPin size={18} /> {busy === 'checkin' ? 'Checking in…' : 'Check in at site'}
          </button>
          <button style={bigBtn('#0369a1', busy === 'photo')} onClick={takePhoto} disabled={!!busy}>
            <Camera size={18} /> {busy === 'photo' ? 'Capturing…' : 'Capture site photo'}
          </button>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button style={bigBtn('#6366f1', busy === 'start')} onClick={() => post({ status: 'start', note: note || undefined }, 'start')} disabled={!!busy}>
              <Play size={17} /> Start
            </button>
            <button style={bigBtn('#059669', busy === 'resolve')} onClick={() => post({ status: 'resolve', note: note || undefined }, 'resolve')} disabled={!!busy}>
              <CheckCircle2 size={17} /> Resolve
            </button>
          </div>
        </div>
        {msg && <div style={{ textAlign: 'center', marginTop: 12, fontSize: 13, color: msg.includes('✓') ? '#059669' : '#6b7280' }}>{msg}</div>}
      </div>
    </div>
  );
}

export default function EngineerHome() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/servicedesk/my-tickets')
      .then(({ data }) => setJobs(Array.isArray(data) ? data : []))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const highCount = jobs.filter((j) => (j.priority || '').toLowerCase() === 'high').length;

  return (
    <div className="pulse-page" style={{ maxWidth: 620, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <Wrench size={22} color="#6B3FDB" />
        <h1 style={{ margin: 0, fontSize: 21, fontWeight: 700, color: '#111827' }}>My Field Jobs</h1>
        <button onClick={load} title="Refresh" style={{ marginLeft: 'auto', border: '1px solid #e5e7eb', background: '#fff', borderRadius: 10, padding: 8, cursor: 'pointer' }}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>
        {jobs.length} open job{jobs.length === 1 ? '' : 's'} assigned to you{highCount ? ` · ${highCount} high priority` : ''}.
      </p>

      <div style={{ display: 'grid', gap: 12 }}>
        {jobs.map((j) => (
          <button key={j.id} onClick={() => setSelected(j)}
            style={{ ...card, textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, borderLeft: `4px solid ${PRIORITY[(j.priority || '').toLowerCase()] || '#e5e7eb'}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: '#111827', fontSize: 15 }}>{j.title}</div>
              <div style={{ fontSize: 12, color: '#9ca3af', margin: '3px 0 8px' }}>{j.ticket_number}{j.customer ? ` · ${j.customer}` : ''}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={chip(PRIORITY[(j.priority || '').toLowerCase()] || '#6b7280')}>{j.priority || '—'}</span>
                <span style={chip(STATUS[(j.status || '').toLowerCase()] || '#6b7280')}>{j.status}</span>
              </div>
            </div>
            <ChevronRight size={20} color="#c4b5fd" />
          </button>
        ))}
        {!jobs.length && !loading && (
          <div style={{ ...card, textAlign: 'center', color: '#9ca3af', padding: 40 }}>
            <Navigation size={30} style={{ opacity: .4 }} />
            <div style={{ marginTop: 10, fontSize: 14 }}>No open jobs assigned to you.</div>
          </div>
        )}
      </div>

      {selected && <JobSheet ticket={selected} onClose={() => setSelected(null)}
        onChanged={(status) => { load(); if (status === 'Resolved') setSelected(null); }} />}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } .spin { animation: spin 1s linear infinite; }`}</style>
    </div>
  );
}
