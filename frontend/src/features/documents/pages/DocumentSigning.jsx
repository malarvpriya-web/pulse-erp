/**
 * DocumentSigning.jsx — Unified Native Digital Signature Engine (Phase 46)
 *
 * Merged from DocumentSigning + NativeSignature.
 * 100% native — no Zoho Sign dependency.
 * Features: list/filter, create, typed/drawn/uploaded signing,
 *           multi-signer with OTP, workflow linking, audit trail.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '@/services/api/client';
import SignatureDesigner from '../components/SignatureDesigner';

/* Download an authenticated file (signed PDF / certificate) via the api client */
async function downloadAuthed(url, filename, onError) {
  try {
    const res = await api.get(url, { responseType: 'blob' });
    const blobUrl = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = blobUrl; a.download = filename; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(blobUrl);
  } catch (e) {
    onError?.(e?.response?.data?.error || 'Download not available yet');
  }
}

const PURPLE = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

const WORKFLOW_TYPES = [
  { value: '',                    label: 'None (standalone)' },
  { value: 'ecn',                 label: 'ECN Approval' },
  { value: 'fat',                 label: 'FAT Sign-off' },
  { value: 'sat',                 label: 'SAT Sign-off' },
  { value: 'commissioning',       label: 'Commissioning Approval' },
  { value: 'qc',                  label: 'QC Approval' },
  { value: 'customer_acceptance', label: 'Customer Acceptance' },
  { value: 'document_approval',   label: 'Document Approval' },
];

const DOC_TYPES = [
  'Offer Letter', 'Employment Contract', 'NDA', 'Policy Acknowledgement',
  'Appraisal Letter', 'Relieving Letter', 'Salary Revision Letter',
  'Purchase Order', 'Service Contract', 'AMC Contract', 'Other',
];

const STATUS_META = {
  pending:  { bg: '#fef3c7', color: '#b45309', label: 'Pending' },
  sent:     { bg: '#dbeafe', color: '#1d4ed8', label: 'Awaiting' },
  signed:   { bg: '#dcfce7', color: '#15803d', label: 'Signed' },
  declined: { bg: '#fee2e2', color: '#dc2626', label: 'Declined' },
  expired:  { bg: '#f3f4f6', color: '#6b7280', label: 'Expired' },
};

const sm      = s => STATUS_META[(s || '').toLowerCase()] || STATUS_META.pending;
const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

/* ── Canvas signature pad ──────────────────────────────────────────────────── */
function SignaturePad({ onCapture }) {
  const ref     = useRef(null);
  const drawing = useRef(false);

  const pos = (e, c) => {
    const r   = c.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  };

  const start = e => { const c = ref.current, ctx = c.getContext('2d'), { x, y } = pos(e, c); ctx.beginPath(); ctx.moveTo(x, y); drawing.current = true; };
  const move  = e => {
    if (!drawing.current) return;
    e.preventDefault();
    const c = ref.current, ctx = c.getContext('2d'), { x, y } = pos(e, c);
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111827';
    ctx.lineTo(x, y); ctx.stroke();
  };
  const stop  = () => { drawing.current = false; onCapture(ref.current.toDataURL('image/png')); };
  const clear = () => { const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); onCapture(null); };

  return (
    <div>
      <canvas ref={ref} width={460} height={120}
        style={{ border: `1px solid ${BORDER}`, borderRadius: 8, display: 'block', touchAction: 'none', background: '#fff', cursor: 'crosshair', width: '100%' }}
        onMouseDown={start} onMouseMove={move} onMouseUp={stop} onMouseLeave={stop}
        onTouchStart={start} onTouchMove={move} onTouchEnd={stop}
      />
      <button onClick={clear} style={{ marginTop: 5, fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
    </div>
  );
}

/* ── Sign modal ────────────────────────────────────────────────────────────── */
function SignModal({ doc, onClose, onSigned }) {
  const [mode,    setMode]    = useState('typed');
  const [typed,   setTyped]   = useState('');
  const [drawn,   setDrawn]   = useState(null);
  const [uploaded,setUploaded]= useState(null);
  const [busy,    setBusy]    = useState(false);
  const [err,     setErr]     = useState(null);

  const onFile = e => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = ev => setUploaded(ev.target.result);
    reader.readAsDataURL(f);
  };

  const submit = async () => {
    setErr(null);
    if (mode === 'typed'    && !typed.trim())  { setErr('Enter your full name.'); return; }
    if (mode === 'drawn'    && !drawn)          { setErr('Draw your signature.'); return; }
    if (mode === 'uploaded' && !uploaded)       { setErr('Upload a signature image.'); return; }
    setBusy(true);
    try {
      await api.post(`/signatures/${doc.id}/sign`, {
        signature_type: mode,
        typed_name:     mode === 'typed'    ? typed.trim() : null,
        signature_data: mode !== 'typed'    ? (drawn || uploaded) : null,
      });
      onSigned();
    } catch (e) { setErr(e?.response?.data?.error || 'Failed to sign'); }
    finally     { setBusy(false); }
  };

  const MODES = [{ k: 'typed', l: 'Type Name' }, { k: 'drawn', l: 'Draw' }, { k: 'uploaded', l: 'Upload' }];

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ background:'#fff', borderRadius:14, padding:28, width:520, maxWidth:'95vw', boxShadow:'0 20px 60px rgba(0,0,0,.25)' }}>
        <h3 style={{ margin:'0 0 6px', fontSize:16, fontWeight:700, color:'#111827' }}>Sign Document</h3>
        <p style={{ margin:'0 0 18px', fontSize:13, color:'#6b7280' }}>{doc.title}</p>

        {/* mode tabs */}
        <div style={{ display:'flex', gap:4, marginBottom:18, background:'#f3f4f6', borderRadius:9, padding:3 }}>
          {MODES.map(m => (
            <button key={m.k} onClick={() => setMode(m.k)} style={{
              flex:1, padding:'7px 0', border:'none', borderRadius:7, cursor:'pointer',
              fontSize:12, fontWeight:600,
              background: mode===m.k ? '#fff' : 'transparent',
              color:      mode===m.k ? PURPLE : '#6b7280',
              boxShadow:  mode===m.k ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
            }}>{m.l}</button>
          ))}
        </div>

        {mode==='typed'    && <input value={typed} onChange={e=>setTyped(e.target.value)} placeholder="Type your full legal name"
          style={{ width:'100%', padding:'10px 14px', border:`1px solid ${BORDER}`, borderRadius:8, fontSize:22, fontFamily:'cursive', boxSizing:'border-box' }} />}
        {mode==='drawn'    && <SignaturePad onCapture={setDrawn} />}
        {mode==='uploaded' && (
          <div>
            <input type="file" accept="image/png,image/jpeg" onChange={onFile} style={{ fontSize:13 }} />
            {uploaded && <img src={uploaded} alt="" style={{ marginTop:10, maxHeight:80, border:`1px solid ${BORDER}`, borderRadius:6 }} />}
          </div>
        )}

        {err && <div style={{ marginTop:12, fontSize:12, color:'#dc2626', background:'#fee2e2', padding:'8px 12px', borderRadius:6 }}>{err}</div>}

        <div style={{ display:'flex', gap:10, marginTop:22, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ padding:'9px 18px', border:`1px solid ${BORDER}`, borderRadius:8, background:'#fff', fontSize:13, cursor:'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={busy}
            style={{ padding:'9px 20px', background: busy?'#d1d5db':PURPLE, color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:600, cursor: busy?'not-allowed':'pointer' }}>
            {busy ? 'Signing…' : 'Apply Signature'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Create request modal ──────────────────────────────────────────────────── */
function CreateModal({ onClose, onCreated }) {
  const [form, setForm] = useState({
    title:'', doc_type:'Other', recipient_name:'', recipient_email:'', recipient_phone:'',
    message:'', expiry_date:'', workflow_type:'', linked_entity_id:'',
    require_otp:false, auto_reminder:false, reminder_interval_days:3, max_reminders:3,
    payment_required:false, payment_amount:'', payment_currency:'INR',
  });
  const [signers,   setSigners]   = useState([]);
  const [newSigner, setNewSigner] = useState({ name:'', email:'', phone:'', order:2, role:'signer' });
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState(null);

  const set = (k,v) => setForm(p => ({ ...p, [k]: v }));

  const addSigner = () => {
    if (!newSigner.name || !newSigner.email) return;
    setSigners(s => [...s, { ...newSigner }]);
    setNewSigner({ name:'', email:'', phone:'', order: signers.length+3, role:'signer' });
  };

  const submit = async () => {
    if (!form.title || !form.recipient_name || !form.recipient_email) {
      setErr('Title, recipient name and email are required.'); return;
    }
    setBusy(true); setErr(null);
    try {
      const res = await api.post('/signatures', {
        ...form,
        linked_entity_id: form.linked_entity_id ? parseInt(form.linked_entity_id) : undefined,
      });
      const docId = res.data?.data?.id;
      if (docId) {
        for (const s of signers) {
          await api.post(`/signatures/${docId}/signers`, {
            signer_name: s.name, signer_email: s.email, signer_phone: s.phone || undefined,
            signing_order: s.order, role: s.role,
          }).catch(() => {});
        }
      }
      onCreated();
    } catch (e) { setErr(e?.response?.data?.error || e?.message || 'Failed to create'); }
    finally     { setBusy(false); }
  };

  const inp = (label, key, type='text', ph='', extra={}) => (
    <div key={key}>
      <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>{label}</label>
      <input type={type} value={form[key]} onChange={e=>set(key,e.target.value)} placeholder={ph}
        style={{ width:'100%', padding:'9px 12px', border:`1px solid ${BORDER}`, borderRadius:8, fontSize:13, boxSizing:'border-box' }} {...extra} />
    </div>
  );

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'#fff', borderRadius:14, padding:28, width:580, maxWidth:'95vw', maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.25)' }}>
        <h3 style={{ margin:'0 0 20px', fontSize:17, fontWeight:700, color:'#111827' }}>New Signing Request</h3>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:14 }}>
          <div style={{ gridColumn:'1/-1' }}>{inp('Document Title *','title','text','e.g. Employment Contract — Arjun Sharma')}</div>
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Document Type</label>
            <select value={form.doc_type} onChange={e=>set('doc_type',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:`1px solid ${BORDER}`, borderRadius:8, fontSize:13 }}>
              {DOC_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Workflow Type</label>
            <select value={form.workflow_type} onChange={e=>set('workflow_type',e.target.value)} style={{ width:'100%', padding:'9px 12px', border:`1px solid ${BORDER}`, borderRadius:8, fontSize:13 }}>
              {WORKFLOW_TYPES.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {form.workflow_type && inp('Linked Record ID','linked_entity_id','number','e.g. 42')}
          {inp('Expiry Date','expiry_date','date')}
        </div>

        {/* Primary recipient */}
        <div style={{ background:LIGHT, borderRadius:10, padding:14, marginBottom:14 }}>
          <p style={{ margin:'0 0 10px', fontSize:13, fontWeight:700, color:'#374151' }}>Primary Recipient</p>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
            {inp('Name *','recipient_name','text','Full name')}
            {inp('Email *','recipient_email','email','email@example.com')}
            {inp('Phone (SMS OTP)','recipient_phone','tel','+9198…')}
          </div>
        </div>

        {/* Security & automation */}
        <div style={{ border:`1px solid ${BORDER}`, borderRadius:10, padding:14, marginBottom:14 }}>
          <p style={{ margin:'0 0 10px', fontSize:13, fontWeight:700, color:'#374151' }}>Security & Automation</p>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, marginBottom:8, cursor:'pointer' }}>
            <input type="checkbox" checked={form.require_otp} onChange={e=>set('require_otp',e.target.checked)} />
            Require OTP verification before signing (email or SMS)
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, marginBottom:8, cursor:'pointer' }}>
            <input type="checkbox" checked={form.auto_reminder} onChange={e=>set('auto_reminder',e.target.checked)} />
            Auto-remind pending signers
          </label>
          {form.auto_reminder && (
            <div style={{ display:'flex', gap:12, margin:'0 0 10px 26px', fontSize:12, color:'#6b7280', alignItems:'center' }}>
              <span>every</span>
              <input type="number" min="1" value={form.reminder_interval_days} onChange={e=>set('reminder_interval_days',parseInt(e.target.value)||1)} style={{ width:52, padding:'5px 6px', border:`1px solid ${BORDER}`, borderRadius:6 }} />
              <span>days · up to</span>
              <input type="number" min="1" value={form.max_reminders} onChange={e=>set('max_reminders',parseInt(e.target.value)||1)} style={{ width:52, padding:'5px 6px', border:`1px solid ${BORDER}`, borderRadius:6 }} />
              <span>times</span>
            </div>
          )}
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer' }}>
            <input type="checkbox" checked={form.payment_required} onChange={e=>set('payment_required',e.target.checked)} />
            Collect payment before signing
          </label>
          {form.payment_required && (
            <div style={{ display:'flex', gap:8, margin:'8px 0 0 26px', alignItems:'center' }}>
              <select value={form.payment_currency} onChange={e=>set('payment_currency',e.target.value)} style={{ padding:'6px 8px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:12 }}>
                {['INR','USD','EUR','GBP','AED'].map(c=><option key={c} value={c}>{c}</option>)}
              </select>
              <input type="number" min="1" value={form.payment_amount} onChange={e=>set('payment_amount',e.target.value)} placeholder="Amount" style={{ width:120, padding:'6px 8px', border:`1px solid ${BORDER}`, borderRadius:6, fontSize:12 }} />
            </div>
          )}
        </div>

        {/* Additional signers */}
        <div style={{ marginBottom:14 }}>
          <p style={{ margin:'0 0 8px', fontSize:13, fontWeight:700, color:'#374151' }}>Additional Signers (multi-signer)</p>
          {signers.map((s,i) => (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', background:'#f9fafb', borderRadius:7, marginBottom:6, fontSize:13 }}>
              <span style={{ fontWeight:600 }}>#{s.order}</span>
              <span>{s.name}</span>
              <span style={{ color:'#6b7280' }}>{s.email}</span>
              <span style={{ padding:'1px 7px', background:LIGHT, color:PURPLE, borderRadius:8, fontSize:11, fontWeight:600 }}>{s.role}</span>
              <button onClick={() => setSigners(p=>p.filter((_,j)=>j!==i))}
                style={{ marginLeft:'auto', background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:6, padding:'2px 8px', cursor:'pointer', fontSize:11 }}>✕</button>
            </div>
          ))}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr auto auto auto', gap:8, alignItems:'end' }}>
            <input value={newSigner.name}  onChange={e=>setNewSigner(p=>({...p,name:e.target.value}))}  placeholder="Name"
              style={{ padding:'7px 10px', border:`1px solid ${BORDER}`, borderRadius:7, fontSize:12 }} />
            <input type="email" value={newSigner.email} onChange={e=>setNewSigner(p=>({...p,email:e.target.value}))} placeholder="Email"
              style={{ padding:'7px 10px', border:`1px solid ${BORDER}`, borderRadius:7, fontSize:12 }} />
            <input type="tel" value={newSigner.phone} onChange={e=>setNewSigner(p=>({...p,phone:e.target.value}))} placeholder="Phone (SMS)"
              style={{ padding:'7px 10px', border:`1px solid ${BORDER}`, borderRadius:7, fontSize:12 }} />
            <input type="number" value={newSigner.order} onChange={e=>setNewSigner(p=>({...p,order:parseInt(e.target.value)||2}))} min="2"
              style={{ padding:'7px 8px', border:`1px solid ${BORDER}`, borderRadius:7, fontSize:12, width:56 }} />
            <select value={newSigner.role} onChange={e=>setNewSigner(p=>({...p,role:e.target.value}))}
              style={{ padding:'7px 8px', border:`1px solid ${BORDER}`, borderRadius:7, fontSize:12 }}>
              <option value="signer">Signer</option>
              <option value="witness">Witness</option>
              <option value="cc">CC</option>
            </select>
            <button onClick={addSigner} style={{ padding:'7px 14px', background:PURPLE, color:'#fff', border:'none', borderRadius:7, fontSize:12, fontWeight:700, cursor:'pointer' }}>Add</button>
          </div>
        </div>

        <div style={{ marginBottom:16 }}>
          <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Message to Recipient</label>
          <textarea value={form.message} onChange={e=>set('message',e.target.value)} rows={2} placeholder="Optional message…"
            style={{ width:'100%', padding:'9px 12px', border:`1px solid ${BORDER}`, borderRadius:8, fontSize:13, resize:'vertical', boxSizing:'border-box' }} />
        </div>

        {err && <div style={{ marginBottom:14, fontSize:12, color:'#dc2626', background:'#fee2e2', padding:'8px 12px', borderRadius:6 }}>{err}</div>}

        <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ padding:'9px 18px', border:`1px solid ${BORDER}`, borderRadius:8, background:'#fff', fontSize:13, cursor:'pointer' }}>Cancel</button>
          <button onClick={submit} disabled={busy}
            style={{ padding:'9px 24px', background: busy?'#d1d5db':PURPLE, color:'#fff', border:'none', borderRadius:8, fontSize:13, fontWeight:700, cursor: busy?'not-allowed':'pointer' }}>
            {busy ? 'Creating…' : 'Create Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Audit trail panel ─────────────────────────────────────────────────────── */
function AuditPanel({ docId, onClose }) {
  const [trail,   setTrail]   = useState([]);
  const [signers, setSigners] = useState([]);

  useEffect(() => {
    api.get(`/signatures/${docId}/audit`).then(r=>setTrail(r.data.data||[])).catch(()=>{});
    api.get(`/signatures/${docId}/signers`).then(r=>setSigners(r.data.data||[])).catch(()=>{});
  }, [docId]);

  const fmtTs = ts => ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'#fff', borderRadius:14, padding:24, width:520, maxHeight:'85vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,.25)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:18 }}>
          <h3 style={{ margin:0, fontSize:16, fontWeight:700 }}>Audit Trail</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'#6b7280' }}>✕</button>
        </div>

        {signers.length > 0 && (
          <div style={{ marginBottom:18 }}>
            <p style={{ margin:'0 0 8px', fontSize:12, fontWeight:700, color:'#374151' }}>Signers</p>
            {signers.map(s => {
              const meta = STATUS_META[s.status] || STATUS_META.pending;
              return (
                <div key={s.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 12px', background:'#f9fafb', borderRadius:8, marginBottom:6 }}>
                  <div>
                    <div style={{ fontWeight:600, fontSize:13 }}>#{s.signing_order} — {s.signer_name}</div>
                    <div style={{ fontSize:11, color:'#6b7280' }}>{s.signer_email} · {s.role}</div>
                    {s.signed_at && <div style={{ fontSize:11, color:'#6b7280' }}>Signed: {fmtTs(s.signed_at)}</div>}
                  </div>
                  <span style={{ padding:'2px 8px', background:meta.bg, color:meta.color, borderRadius:8, fontSize:11, fontWeight:700 }}>{s.status}</span>
                </div>
              );
            })}
          </div>
        )}

        <p style={{ margin:'0 0 8px', fontSize:12, fontWeight:700, color:'#374151' }}>Event Log</p>
        {trail.length === 0
          ? <p style={{ fontSize:13, color:'#9ca3af', textAlign:'center', padding:16 }}>No events recorded yet.</p>
          : trail.map(e => (
            <div key={e.id} style={{ display:'flex', gap:12, paddingBottom:12, borderBottom:`1px solid ${BORDER}`, marginBottom:12 }}>
              <div style={{ flexShrink:0, width:8, height:8, marginTop:5, borderRadius:'50%', background:PURPLE }} />
              <div>
                <div style={{ fontWeight:700, fontSize:12, color:'#374151', textTransform:'capitalize' }}>{e.event.replace(/_/g,' ')}</div>
                <div style={{ fontSize:11, color:'#6b7280' }}>{e.actor_name} · {fmtTs(e.occurred_at)}</div>
                {e.actor_ip && <div style={{ fontSize:11, color:'#9ca3af' }}>IP: {e.actor_ip}</div>}
              </div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

/* ── Prepare flow: upload source PDF (if needed) then open the field designer ── */
function PrepareFlow({ doc, onClose, onDone, notify }) {
  const [hasSource, setHasSource] = useState(!!doc.source_file_path);
  const [uploading, setUploading] = useState(false);
  const [current,   setCurrent]   = useState(doc);

  const onFile = async e => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.type !== 'application/pdf') { notify?.('Only PDF files can be prepared for signing', 'error'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await api.post(`/signatures/${doc.id}/source`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setCurrent(res.data.data || doc);
      setHasSource(true);
      notify?.('Document uploaded');
    } catch (err) {
      notify?.(err?.response?.data?.error || 'Upload failed', 'error');
    } finally { setUploading(false); }
  };

  if (hasSource) {
    return <SignatureDesigner signing={current} onClose={onClose} onSent={onDone} notify={notify} />;
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 32, width: 480, maxWidth: '95vw', textAlign: 'center' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 17, fontWeight: 800 }}>Upload document to sign</h3>
        <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>{doc.title}</p>
        <label style={{ display: 'block', border: `2px dashed ${BORDER}`, borderRadius: 12, padding: '36px 20px', cursor: 'pointer', background: LIGHT }}>
          <input type="file" accept="application/pdf" onChange={onFile} style={{ display: 'none' }} />
          <div style={{ fontSize: 40 }}>📄</div>
          <div style={{ fontWeight: 700, color: PURPLE, marginTop: 8 }}>{uploading ? 'Uploading…' : 'Choose a PDF file'}</div>
          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>Only PDF · up to 25 MB</div>
        </label>
        <button onClick={onClose} style={{ marginTop: 18, padding: '9px 18px', border: `1px solid ${BORDER}`, borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
      </div>
    </div>
  );
}

/* ── Templates library ─────────────────────────────────────────────────────── */
function TemplatesModal({ onClose, onUse, notify }) {
  const [list, setList] = useState([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', doc_type: 'Other', file: null });

  const load = useCallback(async () => {
    try { const r = await api.get('/signatures/templates'); setList(r.data.data || []); } catch { setList([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.name || !form.file) { notify?.('Name and PDF file are required', 'error'); return; }
    setCreating(true);
    try {
      const fd = new FormData();
      fd.append('name', form.name);
      fd.append('doc_type', form.doc_type);
      fd.append('file', form.file);
      await api.post('/signatures/templates', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      notify?.('Template created');
      setForm({ name: '', doc_type: 'Other', file: null });
      load();
    } catch (e) { notify?.(e?.response?.data?.error || 'Failed', 'error'); }
    finally { setCreating(false); }
  };

  const del = async (id) => { if (!confirm('Delete template?')) return; await api.delete(`/signatures/templates/${id}`); load(); };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 26, width: 560, maxWidth: '95vw', maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Signing Templates</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#6b7280' }}>✕</button>
        </div>

        <div style={{ background: LIGHT, borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 700 }}>New template from PDF</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Template name" style={{ padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13 }} />
            <select value={form.doc_type} onChange={e => setForm(p => ({ ...p, doc_type: e.target.value }))} style={{ padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 7, fontSize: 13 }}>
              {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <input type="file" accept="application/pdf" onChange={e => setForm(p => ({ ...p, file: e.target.files?.[0] || null }))} style={{ fontSize: 12 }} />
          <button onClick={create} disabled={creating} style={{ marginTop: 10, padding: '8px 16px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>{creating ? 'Creating…' : 'Create Template'}</button>
        </div>

        {list.length === 0
          ? <p style={{ fontSize: 13, color: '#9ca3af', textAlign: 'center', padding: 16 }}>No templates yet.</p>
          : list.map(t => (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{t.doc_type} · {t.page_count || 0} pages</div>
              </div>
              <button onClick={() => onUse(t)} style={{ padding: '5px 12px', background: LIGHT, color: PURPLE, border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Use</button>
              <button onClick={() => del(t.id)} style={{ padding: '5px 10px', background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Delete</button>
            </div>
          ))}
      </div>
    </div>
  );
}

/* ── Bulk send: one template → many recipients ─────────────────────────────── */
function BulkSendModal({ onClose, onSent, notify }) {
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [raw, setRaw] = useState('');
  const [opts, setOpts] = useState({ message:'', require_otp:false, auto_reminder:false, expiry_date:'' });
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get('/signatures/templates').then(r=>setTemplates(r.data.data||[])).catch(()=>{}); }, []);

  const parseRecipients = () => raw.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [name, email, phone] = line.split(',').map(x => (x || '').trim());
    return { name, email, phone };
  }).filter(r => r.name && r.email);

  const submit = async () => {
    const recipients = parseRecipients();
    if (!templateId) { notify?.('Select a template', 'error'); return; }
    if (!recipients.length) { notify?.('Add at least one valid recipient line (Name, email)', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.post('/signatures/bulk', { template_id: parseInt(templateId), recipients, ...opts });
      const anySent = (r.data.created || []).some(c => c.sent);
      notify?.(`Bulk sent to ${r.data.count} recipient(s)${anySent ? '' : ' (SMTP off — links logged)'}`);
      onSent?.();
    } catch (e) { notify?.(e?.response?.data?.error || 'Bulk send failed', 'error'); }
    finally { setBusy(false); }
  };

  const count = parseRecipients().length;
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:9998, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'#fff', borderRadius:14, padding:26, width:600, maxWidth:'95vw', maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h3 style={{ margin:0, fontSize:16, fontWeight:800 }}>Bulk Send from Template</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'#6b7280' }}>✕</button>
        </div>
        {templates.length === 0 ? (
          <p style={{ fontSize:13, color:'#9ca3af' }}>No templates yet. Create one first via <strong>Templates</strong>.</p>
        ) : (
          <>
            <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>Template</label>
            <select value={templateId} onChange={e=>setTemplateId(e.target.value)} style={{ width:'100%', padding:'9px 12px', border:`1px solid ${BORDER}`, borderRadius:8, fontSize:13, marginBottom:14 }}>
              <option value="">Select a template…</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name} ({t.page_count||0}p)</option>)}
            </select>

            <label style={{ fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:4 }}>
              Recipients — one per line: <span style={{ color:'#9ca3af' }}>Name, email, phone(optional)</span>
            </label>
            <textarea value={raw} onChange={e=>setRaw(e.target.value)} rows={6} placeholder={"Arjun Sharma, arjun@acme.com, +919812345678\nMeera Nair, meera@acme.com"}
              style={{ width:'100%', padding:'9px 12px', border:`1px solid ${BORDER}`, borderRadius:8, fontSize:13, fontFamily:'monospace', boxSizing:'border-box', marginBottom:6 }} />
            <div style={{ fontSize:12, color: count?'#15803d':'#9ca3af', marginBottom:12 }}>{count} valid recipient(s) detected</div>

            <textarea value={opts.message} onChange={e=>setOpts(o=>({...o,message:e.target.value}))} rows={2} placeholder="Optional message to all recipients…"
              style={{ width:'100%', padding:'9px 12px', border:`1px solid ${BORDER}`, borderRadius:8, fontSize:13, boxSizing:'border-box', marginBottom:12 }} />
            <div style={{ display:'flex', gap:16, marginBottom:16, flexWrap:'wrap' }}>
              <label style={{ fontSize:13, display:'flex', gap:6, alignItems:'center', cursor:'pointer' }}><input type="checkbox" checked={opts.require_otp} onChange={e=>setOpts(o=>({...o,require_otp:e.target.checked}))}/> Require OTP</label>
              <label style={{ fontSize:13, display:'flex', gap:6, alignItems:'center', cursor:'pointer' }}><input type="checkbox" checked={opts.auto_reminder} onChange={e=>setOpts(o=>({...o,auto_reminder:e.target.checked}))}/> Auto-remind</label>
              <label style={{ fontSize:13, display:'flex', gap:6, alignItems:'center' }}>Expiry <input type="date" value={opts.expiry_date} onChange={e=>setOpts(o=>({...o,expiry_date:e.target.value}))} style={{ padding:'5px 8px', border:`1px solid ${BORDER}`, borderRadius:6 }} /></label>
            </div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <button onClick={onClose} style={{ padding:'9px 18px', border:`1px solid ${BORDER}`, borderRadius:8, background:'#fff', cursor:'pointer', fontSize:13 }}>Cancel</button>
              <button onClick={submit} disabled={busy} style={{ padding:'9px 22px', background:busy?'#c4b5fd':PURPLE, color:'#fff', border:'none', borderRadius:8, fontWeight:700, cursor:'pointer', fontSize:13 }}>{busy?'Sending…':`Send to ${count||0}`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Webhooks manager ──────────────────────────────────────────────────────── */
const WEBHOOK_EVENTS = ['all','request.sent','signer.signed','request.completed','request.declined','signer.delegated','payment.captured'];
function WebhooksModal({ onClose, notify }) {
  const [list, setList] = useState([]);
  const [form, setForm] = useState({ url:'', events:['all'], description:'' });
  const [secret, setSecret] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { api.get('/signatures/webhooks').then(r=>setList(r.data.data||[])).catch(()=>{}); }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!/^https?:\/\//i.test(form.url)) { notify?.('Enter a valid http(s) URL', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.post('/signatures/webhooks', form);
      setSecret(r.data.data?.secret || null);
      setForm({ url:'', events:['all'], description:'' });
      notify?.('Webhook added');
      load();
    } catch (e) { notify?.(e?.response?.data?.error || 'Failed', 'error'); }
    finally { setBusy(false); }
  };
  const toggle = async (w) => { await api.put(`/signatures/webhooks/${w.id}`, { active: !w.active }); load(); };
  const del = async (id) => { if (!confirm('Delete webhook?')) return; await api.delete(`/signatures/webhooks/${id}`); load(); };
  const test = async (id) => {
    try { const r = await api.post(`/signatures/webhooks/${id}/test`); notify?.(r.data.success ? `Test OK (HTTP ${r.data.status})` : `Test failed: ${r.data.error||r.data.status}`, r.data.success?'success':'error'); load(); }
    catch { notify?.('Test failed', 'error'); }
  };
  const toggleEvent = (ev) => setForm(f => {
    if (ev === 'all') return { ...f, events:['all'] };
    const has = f.events.includes(ev);
    const next = has ? f.events.filter(x=>x!==ev) : [...f.events.filter(x=>x!=='all'), ev];
    return { ...f, events: next.length ? next : ['all'] };
  });

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:9998, display:'flex', alignItems:'center', justifyContent:'center', padding:16 }}>
      <div style={{ background:'#fff', borderRadius:14, padding:26, width:600, maxWidth:'95vw', maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h3 style={{ margin:0, fontSize:16, fontWeight:800 }}>Signing Webhooks</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:18, cursor:'pointer', color:'#6b7280' }}>✕</button>
        </div>

        {secret && (
          <div style={{ background:'#fef9c3', border:'1px solid #fde047', borderRadius:8, padding:'10px 12px', marginBottom:14, fontSize:12 }}>
            <strong>Signing secret (shown once):</strong>
            <div style={{ fontFamily:'monospace', wordBreak:'break-all', marginTop:4 }}>{secret}</div>
            <div style={{ color:'#854d0e', marginTop:4 }}>Verify the <code>X-Pulse-Signature</code> HMAC-SHA256 header with this secret.</div>
          </div>
        )}

        <div style={{ background:LIGHT, borderRadius:10, padding:14, marginBottom:16 }}>
          <p style={{ margin:'0 0 8px', fontSize:13, fontWeight:700 }}>Add endpoint</p>
          <input value={form.url} onChange={e=>setForm(f=>({...f,url:e.target.value}))} placeholder="https://your-app.com/webhooks/pulse-sign"
            style={{ width:'100%', padding:'8px 10px', border:`1px solid ${BORDER}`, borderRadius:7, fontSize:13, boxSizing:'border-box', marginBottom:8 }} />
          <input value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} placeholder="Description (optional)"
            style={{ width:'100%', padding:'8px 10px', border:`1px solid ${BORDER}`, borderRadius:7, fontSize:13, boxSizing:'border-box', marginBottom:8 }} />
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
            {WEBHOOK_EVENTS.map(ev => (
              <button key={ev} onClick={()=>toggleEvent(ev)} style={{ padding:'4px 9px', borderRadius:12, fontSize:11, fontWeight:600, cursor:'pointer',
                border:`1px solid ${form.events.includes(ev)?PURPLE:BORDER}`, background:form.events.includes(ev)?PURPLE:'#fff', color:form.events.includes(ev)?'#fff':'#6b7280' }}>{ev}</button>
            ))}
          </div>
          <button onClick={create} disabled={busy} style={{ padding:'8px 16px', background:PURPLE, color:'#fff', border:'none', borderRadius:7, fontWeight:700, fontSize:12, cursor:'pointer' }}>{busy?'Adding…':'Add Webhook'}</button>
        </div>

        {list.length === 0
          ? <p style={{ fontSize:13, color:'#9ca3af', textAlign:'center', padding:16 }}>No webhooks configured.</p>
          : list.map(w => (
            <div key={w.id} style={{ border:`1px solid ${BORDER}`, borderRadius:8, padding:'10px 12px', marginBottom:8 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ width:8, height:8, borderRadius:'50%', background:w.active?'#16a34a':'#9ca3af' }} />
                <div style={{ flex:1, fontSize:13, fontWeight:600, wordBreak:'break-all' }}>{w.url}</div>
                <button onClick={()=>test(w.id)} style={{ padding:'3px 9px', background:'#f3f4f6', border:'none', borderRadius:6, fontSize:11, fontWeight:600, cursor:'pointer' }}>Test</button>
                <button onClick={()=>toggle(w)} style={{ padding:'3px 9px', background:LIGHT, color:PURPLE, border:'none', borderRadius:6, fontSize:11, fontWeight:600, cursor:'pointer' }}>{w.active?'Pause':'Enable'}</button>
                <button onClick={()=>del(w.id)} style={{ padding:'3px 9px', background:'#fee2e2', color:'#dc2626', border:'none', borderRadius:6, fontSize:11, fontWeight:600, cursor:'pointer' }}>✕</button>
              </div>
              <div style={{ fontSize:11, color:'#9ca3af', marginTop:4 }}>
                {(Array.isArray(w.events)?w.events:[]).join(', ')}
                {w.last_status ? ` · last: HTTP ${w.last_status}` : ''}{w.failure_count>0 ? ` · ${w.failure_count} failures` : ''}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────────────────────── */
export default function DocumentSigning() {
  const [docs,       setDocs]       = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [search,     setSearch]     = useState('');
  const [statusTab,  setStatusTab]  = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [signing,    setSigning]    = useState(null);
  const [auditing,   setAuditing]   = useState(null);
  const [preparing,  setPreparing]  = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showBulk,   setShowBulk]   = useState(false);
  const [showWebhooks, setShowWebhooks] = useState(false);
  const [toast,      setToast]      = useState(null);

  const notify = (msg, type='success') => { setToast({msg,type}); setTimeout(()=>setToast(null),3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ limit:'100' });
      if (statusTab) p.set('status', statusTab);
      const r = await api.get(`/signatures?${p}`);
      setDocs(r.data.data || []);
    } catch { setDocs([]); }
    finally { setLoading(false); }
  }, [statusTab]);

  useEffect(() => { load(); }, [load]);

  const revoke = async id => {
    if (!confirm('Revoke this signing request?')) return;
    try { await api.post(`/signatures/${id}/revoke`); notify('Request revoked'); load(); }
    catch { notify('Failed to revoke','error'); }
  };

  const remind = async id => {
    try {
      const r = await api.post(`/signatures/${id}/remind`);
      const any = (r.data.reminded || []).some(x => x.sent);
      notify(any ? 'Reminder emailed' : 'Reminder logged (SMTP not configured)');
    } catch { notify('Failed to send reminder', 'error'); }
  };

  const useTemplate = async (tpl) => {
    const title = prompt('Document title for this signing request:', tpl.name);
    if (!title) return;
    const recipient_name  = prompt('Primary recipient name:') || '';
    const recipient_email = prompt('Primary recipient email:') || '';
    if (!recipient_name || !recipient_email) { notify('Recipient name and email are required', 'error'); return; }
    try {
      const r = await api.post(`/signatures/templates/${tpl.id}/use`, { title, recipient_name, recipient_email });
      setShowTemplates(false);
      notify('Request created from template');
      load();
      setPreparing(r.data.data); // jump straight into the designer
    } catch (e) { notify(e?.response?.data?.error || 'Failed to use template', 'error'); }
  };

  const signInPerson = async (doc) => {
    // Open the tab synchronously (inside the click gesture) so it is not treated
    // as a popup and blocked; we redirect it once the token comes back.
    const tab = window.open('', '_blank');
    try {
      const r = await api.post(`/signatures/${doc.id}/in-person`);
      const token = r.data?.token;
      if (!token) {
        if (tab) tab.close();
        notify('No signer is available for in-person signing.', 'error');
        return;
      }
      const url = `/sign/${token}`;
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener'); // fallback if the sync open was blocked
      notify('In-person session opened in a new tab');
      load();
    } catch (e) {
      if (tab) tab.close();
      notify(e?.response?.data?.error || 'Could not start in-person signing', 'error');
    }
  };

  const STATUS_TABS = ['', 'pending', 'sent', 'signed', 'declined'];

  const filtered = docs.filter(d =>
    !search ||
    d.title?.toLowerCase().includes(search.toLowerCase()) ||
    d.recipient_name?.toLowerCase().includes(search.toLowerCase()) ||
    d.recipient_email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding:24, margin:'0 auto' }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position:'fixed', top:20, right:24, zIndex:99999,
          padding:'12px 20px', borderRadius:10, fontWeight:600, fontSize:13,
          background: toast.type==='success' ? '#dcfce7' : '#fee2e2',
          color:      toast.type==='success' ? '#15803d' : '#dc2626',
          boxShadow:'0 4px 16px rgba(0,0,0,.12)',
        }}>
          {toast.type==='success'?'✓ ':'✗ '}{toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:24 }}>
        <div>
          <h2 style={{ fontWeight:800, fontSize:22, color:'#1f2937', margin:0 }}>Document Signing</h2>
          <p style={{ color:'#6b7280', fontSize:13, marginTop:4 }}>
            Native e-signatures — typed, drawn, or uploaded · Multi-signer with OTP · Immutable audit trail
          </p>
        </div>
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={load} disabled={loading}
            style={{ padding:'9px 16px', borderRadius:8, border:`1px solid ${BORDER}`, background:'#fff', color:'#374151', fontWeight:600, fontSize:13, cursor:'pointer' }}>
            {loading ? '…' : '↻ Refresh'}
          </button>
          <button onClick={()=>setShowWebhooks(true)}
            style={{ padding:'9px 14px', borderRadius:8, border:`1px solid ${BORDER}`, background:'#fff', color:'#374151', fontWeight:600, fontSize:13, cursor:'pointer' }}>
            ⚡ Webhooks
          </button>
          <button onClick={()=>setShowBulk(true)}
            style={{ padding:'9px 14px', borderRadius:8, border:`1px solid ${BORDER}`, background:'#fff', color:'#374151', fontWeight:600, fontSize:13, cursor:'pointer' }}>
            ⇉ Bulk Send
          </button>
          <button onClick={()=>setShowTemplates(true)}
            style={{ padding:'9px 16px', borderRadius:8, border:`1px solid ${BORDER}`, background:'#fff', color:PURPLE, fontWeight:600, fontSize:13, cursor:'pointer' }}>
            ▤ Templates
          </button>
          <button onClick={()=>setShowCreate(true)}
            style={{ padding:'9px 20px', borderRadius:8, background:PURPLE, color:'#fff', fontWeight:700, fontSize:13, border:'none', cursor:'pointer' }}>
            + New Request
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:24 }}>
        {[
          { l:'Total',    n: docs.length,                                                  c:'#374151' },
          { l:'Awaiting', n: docs.filter(d=>['pending','sent'].includes(d.status)).length, c:'#1d4ed8' },
          { l:'Signed',   n: docs.filter(d=>d.status==='signed').length,                   c:'#15803d' },
          { l:'Declined', n: docs.filter(d=>d.status==='declined').length,                 c:'#dc2626' },
        ].map(s => (
          <div key={s.l} style={{ background:'#fff', border:'1px solid #e9ecf3', borderRadius:10, padding:'14px 18px', boxShadow:'0 1px 3px rgba(0,0,0,.04)' }}>
            <div style={{ fontSize:26, fontWeight:800, color:s.c }}>{s.n}</div>
            <div style={{ fontSize:12, color:s.c, fontWeight:600 }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display:'flex', gap:10, marginBottom:18, flexWrap:'wrap' }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search title, recipient…"
          style={{ flex:1, minWidth:200, padding:'8px 12px', borderRadius:8, border:`1px solid ${BORDER}`, fontSize:13 }} />
        <div style={{ display:'flex', gap:6 }}>
          {STATUS_TABS.map(s => (
            <button key={s} onClick={()=>setStatusTab(s)} style={{
              padding:'7px 14px', borderRadius:7,
              border:`1px solid ${statusTab===s?PURPLE:BORDER}`,
              background: statusTab===s ? LIGHT : '#fff',
              color:      statusTab===s ? PURPLE : '#6b7280',
              fontWeight:600, fontSize:12, cursor:'pointer',
            }}>
              {s ? s.charAt(0).toUpperCase()+s.slice(1) : 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ background:'#fff', border:`1px solid ${BORDER}`, borderRadius:12, overflow:'hidden' }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
          <thead>
            <tr style={{ background:LIGHT }}>
              {['Title','Recipient','Workflow','Date','Status','Actions'].map(h=>(
                <th key={h} style={{ padding:'11px 14px', textAlign:'left', fontWeight:700, color:'#374151', borderBottom:`1px solid ${BORDER}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>Loading…</td></tr>
            ) : filtered.length===0 ? (
              <tr><td colSpan={6} style={{ padding:40, textAlign:'center', color:'#9ca3af' }}>
                {search||statusTab ? 'No matching documents.' : 'No signing requests yet — click + New Request to start.'}
              </td></tr>
            ) : filtered.map(doc => {
              const { bg, color, label } = sm(doc.status);
              const wf = WORKFLOW_TYPES.find(w=>w.value===doc.workflow_type);
              return (
                <tr key={doc.id} style={{ borderBottom:`1px solid ${BORDER}` }}>
                  <td style={{ padding:'11px 14px' }}>
                    <div style={{ fontWeight:700, color:'#1f2937' }}>{doc.title}</div>
                    {doc.doc_type && <div style={{ fontSize:11, color:'#9ca3af' }}>{doc.doc_type}</div>}
                  </td>
                  <td style={{ padding:'11px 14px' }}>
                    <div style={{ fontWeight:600 }}>{doc.recipient_name}</div>
                    <div style={{ fontSize:11, color:'#6b7280' }}>{doc.recipient_email}</div>
                  </td>
                  <td style={{ padding:'11px 14px' }}>
                    {wf?.value
                      ? <span style={{ padding:'2px 8px', background:LIGHT, color:PURPLE, borderRadius:8, fontSize:11, fontWeight:600 }}>{wf.label}</span>
                      : <span style={{ color:'#9ca3af', fontSize:12 }}>—</span>}
                  </td>
                  <td style={{ padding:'11px 14px', color:'#6b7280', fontSize:12 }}>
                    {fmtDate((doc.sent_date||doc.created_at||'').split('T')[0])}
                    {doc.expiry_date && <div style={{ fontSize:11, color:'#9ca3af' }}>Exp: {fmtDate(doc.expiry_date)}</div>}
                  </td>
                  <td style={{ padding:'11px 14px' }}>
                    <span style={{ padding:'3px 10px', background:bg, color, borderRadius:12, fontSize:11, fontWeight:700 }}>{label}</span>
                    {doc.total_signers>1 && (
                      <div style={{ fontSize:10, color:'#9ca3af', marginTop:3 }}>{doc.signed_count||0}/{doc.total_signers} signed</div>
                    )}
                  </td>
                  <td style={{ padding:'11px 14px' }}>
                    <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                      {!doc.is_locked && !['signed','declined'].includes(doc.status) && (
                        <button onClick={()=>setPreparing(doc)}
                          style={{ padding:'4px 10px', borderRadius:6, background:PURPLE, color:'#fff', fontWeight:600, fontSize:11, border:'none', cursor:'pointer' }}>Prepare & Send</button>
                      )}
                      {!doc.is_locked && !['signed','declined'].includes(doc.status) && (
                        <button onClick={()=>setSigning(doc)}
                          style={{ padding:'4px 10px', borderRadius:6, background:LIGHT, color:PURPLE, fontWeight:600, fontSize:11, border:'none', cursor:'pointer' }}>Quick Sign</button>
                      )}
                      {!doc.is_locked && !['signed','declined'].includes(doc.status) && (
                        <button onClick={()=>signInPerson(doc)}
                          style={{ padding:'4px 10px', borderRadius:6, background:'#fef3c7', color:'#b45309', fontWeight:600, fontSize:11, border:'none', cursor:'pointer' }}>In-Person</button>
                      )}
                      {doc.status==='sent' && !doc.is_locked && (
                        <button onClick={()=>remind(doc.id)}
                          style={{ padding:'4px 10px', borderRadius:6, background:'#dbeafe', color:'#1d4ed8', fontWeight:600, fontSize:11, border:'none', cursor:'pointer' }}>Remind</button>
                      )}
                      {doc.status==='signed' && (
                        <>
                          <button onClick={()=>downloadAuthed(`/signatures/${doc.id}/signed-pdf`, `signed-${doc.id}.pdf`, m=>notify(m,'error'))}
                            style={{ padding:'4px 10px', borderRadius:6, background:'#dcfce7', color:'#15803d', fontWeight:600, fontSize:11, border:'none', cursor:'pointer' }}>Download</button>
                          <button onClick={()=>downloadAuthed(`/signatures/${doc.id}/certificate`, `certificate-${doc.id}.pdf`, m=>notify(m,'error'))}
                            style={{ padding:'4px 10px', borderRadius:6, background:'#f3f4f6', color:'#374151', fontWeight:600, fontSize:11, border:'none', cursor:'pointer' }}>Certificate</button>
                        </>
                      )}
                      <button onClick={()=>setAuditing(doc.id)}
                        style={{ padding:'4px 10px', borderRadius:6, background:'#f3f4f6', color:'#374151', fontWeight:600, fontSize:11, border:'none', cursor:'pointer' }}>Audit</button>
                      {!doc.is_locked && doc.status!=='signed' && (
                        <button onClick={()=>revoke(doc.id)}
                          style={{ padding:'4px 10px', borderRadius:6, background:'#fee2e2', color:'#dc2626', fontWeight:600, fontSize:11, border:'none', cursor:'pointer' }}>Revoke</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Modals */}
      {showCreate && <CreateModal onClose={()=>setShowCreate(false)} onCreated={()=>{setShowCreate(false);notify('Signing request created');load();}} />}
      {signing    && <SignModal   doc={signing} onClose={()=>setSigning(null)} onSigned={()=>{setSigning(null);notify('Document signed');load();}} />}
      {auditing   && <AuditPanel docId={auditing} onClose={()=>setAuditing(null)} />}
      {preparing  && <PrepareFlow doc={preparing} notify={notify} onClose={()=>setPreparing(null)} onDone={()=>{setPreparing(null);notify('Sent for signing');load();}} />}
      {showTemplates && <TemplatesModal notify={notify} onClose={()=>setShowTemplates(false)} onUse={useTemplate} />}
      {showBulk && <BulkSendModal notify={notify} onClose={()=>setShowBulk(false)} onSent={()=>{setShowBulk(false);notify('Bulk send complete');load();}} />}
      {showWebhooks && <WebhooksModal notify={notify} onClose={()=>setShowWebhooks(false)} />}
    </div>
  );
}
