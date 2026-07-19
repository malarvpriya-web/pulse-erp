/**
 * PublicSigning.jsx — the recipient's no-login signing experience (/sign/:token)
 *
 * Renders the source PDF with the signer's assigned fields overlaid as fillable
 * widgets, captures a typed/drawn/uploaded signature, optionally verifies an
 * emailed OTP, and submits. Uses plain fetch so the authenticated api client's
 * token/refresh interceptor never interferes with this public flow.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import PdfCanvas from '../components/PdfCanvas';

const API = (import.meta.env.VITE_API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const PURPLE = '#6B3FDB';
const BORDER = '#e9e4ff';

const TEXT_TYPES = ['date', 'name', 'email', 'text', 'company', 'title'];

async function jget(path) {
  const r = await fetch(`${API}${path}`);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Request failed');
  return body;
}
async function jpost(path, data) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Request failed');
  return body;
}

/* ── Signature adopt modal ─────────────────────────────────────────────────── */
function SignaturePad({ onCapture }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const pos = (e, c) => { const r = c.getBoundingClientRect(); const s = e.touches ? e.touches[0] : e; return { x: s.clientX - r.left, y: s.clientY - r.top }; };
  const start = e => { const c = ref.current, ctx = c.getContext('2d'), { x, y } = pos(e, c); ctx.beginPath(); ctx.moveTo(x, y); drawing.current = true; };
  const move = e => { if (!drawing.current) return; e.preventDefault(); const c = ref.current, ctx = c.getContext('2d'), { x, y } = pos(e, c); ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.strokeStyle = '#111827'; ctx.lineTo(x, y); ctx.stroke(); };
  const stop = () => { drawing.current = false; onCapture(ref.current.toDataURL('image/png')); };
  const clear = () => { const c = ref.current; c.getContext('2d').clearRect(0, 0, c.width, c.height); onCapture(null); };
  return (
    <div>
      <canvas ref={ref} width={460} height={140}
        style={{ border: `1px solid ${BORDER}`, borderRadius: 8, width: '100%', touchAction: 'none', background: '#fff', cursor: 'crosshair' }}
        onMouseDown={start} onMouseMove={move} onMouseUp={stop} onMouseLeave={stop}
        onTouchStart={start} onTouchMove={move} onTouchEnd={stop} />
      <button onClick={clear} style={{ marginTop: 5, fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>
    </div>
  );
}

function AdoptModal({ signerName, onClose, onAdopt }) {
  const [mode, setMode] = useState('typed');
  const [typed, setTyped] = useState(signerName || '');
  const [drawn, setDrawn] = useState(null);
  const [uploaded, setUploaded] = useState(null);
  const onFile = e => { const f = e.target.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = ev => setUploaded(ev.target.result); rd.readAsDataURL(f); };
  const adopt = () => {
    if (mode === 'typed' && typed.trim()) return onAdopt({ type: 'typed', value: typed.trim(), name: typed.trim() });
    if (mode === 'drawn' && drawn) return onAdopt({ type: 'drawn', value: drawn });
    if (mode === 'uploaded' && uploaded) return onAdopt({ type: 'uploaded', value: uploaded });
  };
  const MODES = [{ k: 'typed', l: 'Type' }, { k: 'drawn', l: 'Draw' }, { k: 'uploaded', l: 'Upload' }];
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: 26, width: 520, maxWidth: '95vw' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 800 }}>Adopt your signature</h3>
        <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: '#f3f4f6', borderRadius: 9, padding: 3 }}>
          {MODES.map(m => (
            <button key={m.k} onClick={() => setMode(m.k)} style={{ flex: 1, padding: '7px 0', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 600, background: mode === m.k ? '#fff' : 'transparent', color: mode === m.k ? PURPLE : '#6b7280' }}>{m.l}</button>
          ))}
        </div>
        {mode === 'typed' && <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="Type your full name" style={{ width: '100%', padding: '10px 14px', border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 24, fontFamily: 'cursive', boxSizing: 'border-box' }} />}
        {mode === 'drawn' && <SignaturePad onCapture={setDrawn} />}
        {mode === 'uploaded' && <div><input type="file" accept="image/png,image/jpeg" onChange={onFile} /><br />{uploaded && <img src={uploaded} alt="" style={{ marginTop: 10, maxHeight: 70 }} />}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '9px 18px', border: `1px solid ${BORDER}`, borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
          <button onClick={adopt} style={{ padding: '9px 22px', background: PURPLE, color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Adopt & Sign</button>
        </div>
      </div>
    </div>
  );
}

export default function PublicSigning() {
  const { token } = useParams();
  const [state, setState] = useState('loading'); // loading | ready | error | done | declined
  const [errMsg, setErrMsg] = useState('');
  const [doc, setDoc] = useState(null);
  const [fileData, setFileData] = useState(null);
  const [values, setValues] = useState({});       // fieldId -> value
  const [signature, setSignature] = useState(null); // {type, value, name}
  const [showAdopt, setShowAdopt] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpChannel, setOtpChannel] = useState('email');
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const fileInputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const meta = await jget(`/sign/${token}`);
      setDoc(meta.data);
      if (meta.data.already_signed) { setState('done'); return; }
      if (meta.data.has_source) {
        const r = await fetch(`${API}/sign/${token}/source`);
        if (r.ok) setFileData(await r.arrayBuffer());
      }
      // Pre-fill obvious fields
      const init = {};
      (meta.data.fields || []).forEach(f => {
        if (f.field_type === 'date') init[f.id] = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
        if (f.field_type === 'name') init[f.id] = meta.data.signer?.name || '';
        if (f.field_type === 'email') init[f.id] = meta.data.signer?.email || '';
      });
      setValues(init);
      setState('ready');
    } catch (e) {
      setErrMsg(e.message); setState('error');
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const adopt = (sig) => {
    setSignature(sig);
    setShowAdopt(false);
    // Fill all signature/initials fields with the adopted signature
    setValues(v => {
      const next = { ...v };
      (doc.fields || []).forEach(f => {
        if (f.field_type === 'signature' || f.field_type === 'initials') next[f.id] = sig.value;
      });
      return next;
    });
  };

  const sendOtp = async () => {
    setBusy(true);
    try { const r = await jpost(`/sign/${token}/otp`, { channel: otpChannel }); setOtpSent(true); alert(r.message || 'Code sent'); }
    catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const loadRazorpay = () => new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });

  // Returns true once payment is captured (or simulated in dev)
  const runPayment = async () => {
    const ord = await jpost(`/sign/${token}/payment/order`);
    if (ord.already_paid) { setDoc(d => ({ ...d, payment_status: 'paid' })); return true; }
    if (ord.simulated) {
      await jpost(`/sign/${token}/payment/verify`, { razorpay_order_id: ord.order_id, razorpay_payment_id: `pay_sim_${Date.now()}` });
      setDoc(d => ({ ...d, payment_status: 'paid' }));
      return true;
    }
    const ok = await loadRazorpay();
    if (!ok || !window.Razorpay) { alert('Unable to load payment gateway.'); return false; }
    return new Promise((resolve) => {
      const rzp = new window.Razorpay({
        key: ord.key_id, amount: ord.amount, currency: ord.currency,
        name: 'Pulse Sign', description: doc.title, order_id: ord.order_id,
        prefill: { name: doc.signer?.name, email: doc.signer?.email },
        theme: { color: PURPLE },
        handler: async (resp) => {
          try {
            await jpost(`/sign/${token}/payment/verify`, {
              razorpay_order_id: resp.razorpay_order_id,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_signature: resp.razorpay_signature,
            });
            setDoc(d => ({ ...d, payment_status: 'paid' }));
            resolve(true);
          } catch (e) { alert(e.message); resolve(false); }
        },
        modal: { ondismiss: () => resolve(false) },
      });
      rzp.open();
    });
  };

  const uploadAttachment = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await fetch(`${API}/sign/${token}/attachment`, { method: 'POST', body: fd });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || 'Upload failed');
      setAttachments(a => [...a, b.data]);
    } catch (err) { alert(err.message); }
    finally { if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const delegate = async () => {
    const name = prompt('Delegate to — full name:'); if (!name) return;
    const email = prompt('Delegate email:'); if (!email) return;
    const reason = prompt('Reason (optional):') ?? '';
    setBusy(true);
    try {
      await jpost(`/sign/${token}/delegate`, { name, email, reason });
      alert(`Signing responsibility delegated to ${email}.`);
      setState('declined'); // this signer's slot is now the delegate's; close this session
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const missingRequired = () => (doc.fields || []).filter(f => f.required).some(f => {
    const v = values[f.id];
    if (f.field_type === 'checkbox') return false;
    return v == null || v === '';
  });

  const submit = async () => {
    if (!signature && (doc.fields || []).some(f => f.field_type === 'signature' || f.field_type === 'initials')) {
      setShowAdopt(true); return;
    }
    if (missingRequired()) { alert('Please complete all required fields.'); return; }
    if (doc.require_otp && !otp) { alert('Enter the verification code sent to you.'); return; }

    // Payment gate — collect payment before submitting the signature
    if (doc.payment_required && doc.payment_status !== 'paid') {
      setBusy(true);
      let paid = false;
      try { paid = await runPayment(); } catch (e) { alert(e.message); }
      finally { setBusy(false); }
      if (!paid) return;
    }

    setBusy(true);
    try {
      const fields = (doc.fields || []).map(f => ({ id: f.id, field_type: f.field_type, value: values[f.id] ?? (f.field_type === 'checkbox' ? 'false' : '') }));
      await jpost(`/sign/${token}/sign`, {
        otp: otp || undefined,
        fields,
        signature_type: signature?.type || 'typed',
        signature_data: signature && signature.type !== 'typed' ? signature.value : undefined,
        typed_name: signature?.type === 'typed' ? signature.name : undefined,
      });
      setState('done');
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  const decline = async () => {
    const reason = prompt('Reason for declining (optional):') ?? '';
    setBusy(true);
    try { await jpost(`/sign/${token}/decline`, { reason }); setState('declined'); }
    catch (e) { alert(e.message); }
    finally { setBusy(false); }
  };

  // ── Screens ──────────────────────────────────────────────────────────────
  if (state === 'loading') return <Centered>Loading document…</Centered>;
  if (state === 'error') return <Centered><b style={{ color: '#dc2626' }}>Unable to open</b><p style={{ color: '#6b7280' }}>{errMsg}</p></Centered>;
  if (state === 'declined') return <Centered><b>Declined</b><p style={{ color: '#6b7280' }}>You have declined to sign this document.</p></Centered>;
  if (state === 'done') return (
    <Centered>
      <div style={{ fontSize: 48 }}>✓</div>
      <b style={{ fontSize: 20 }}>Signed successfully</b>
      <p style={{ color: '#6b7280' }}>Thank you. A copy is available below.</p>
      <a href={`${API}/sign/${token}/signed-pdf`} style={{ marginTop: 12, background: PURPLE, color: '#fff', padding: '10px 22px', borderRadius: 8, textDecoration: 'none', fontWeight: 700 }}>Download signed PDF</a>
    </Centered>
  );

  const fieldsFor = (pageNum) => (doc.fields || []).filter(f => f.page === pageNum);

  return (
    <div style={{ minHeight: '100vh', background: '#f3f0fb' }}>
      {/* Header bar */}
      <div style={{ background: '#fff', borderBottom: `1px solid ${BORDER}`, padding: '14px 22px', display: 'flex', alignItems: 'center', gap: 14, position: 'sticky', top: 0, zIndex: 50 }}>
        <div style={{ fontWeight: 800, color: PURPLE, fontSize: 16 }}>Pulse Sign</div>
        <div style={{ fontWeight: 700, color: '#1f2937' }}>{doc.title}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {doc.payment_required && (
            <span style={{ padding: '5px 10px', borderRadius: 8, fontSize: 12, fontWeight: 700,
              background: doc.payment_status === 'paid' ? '#dcfce7' : '#fef3c7',
              color: doc.payment_status === 'paid' ? '#15803d' : '#b45309' }}>
              {doc.payment_status === 'paid' ? '✓ Paid' : `Pay ${doc.payment_currency || 'INR'} ${doc.payment_amount}`}
            </span>
          )}

          {doc.require_otp && !otpSent && doc.has_phone && (
            <div style={{ display: 'flex', border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden' }}>
              {['email', 'sms'].map(ch => (
                <button key={ch} onClick={() => setOtpChannel(ch)} style={{ padding: '7px 10px', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  background: otpChannel === ch ? PURPLE : '#fff', color: otpChannel === ch ? '#fff' : '#6b7280' }}>{ch === 'sms' ? 'SMS' : 'Email'}</button>
              ))}
            </div>
          )}
          {doc.require_otp && (
            otpSent
              ? <input value={otp} onChange={e => setOtp(e.target.value)} placeholder="Enter code" style={{ padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, width: 100, fontSize: 13 }} />
              : <button onClick={sendOtp} disabled={busy} style={{ padding: '8px 14px', border: `1px solid ${PURPLE}`, background: '#fff', color: PURPLE, borderRadius: 8, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>Send code</button>
          )}

          <input ref={fileInputRef} type="file" onChange={uploadAttachment} style={{ display: 'none' }} />
          <button onClick={() => fileInputRef.current?.click()} title="Attach a supporting file"
            style={{ padding: '8px 12px', border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', borderRadius: 8, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
            📎 Attach{attachments.length ? ` (${attachments.length})` : ''}
          </button>
          {doc.allow_delegate && (
            <button onClick={delegate} disabled={busy} style={{ padding: '8px 12px', border: `1px solid ${BORDER}`, background: '#fff', color: '#374151', borderRadius: 8, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>Delegate</button>
          )}
          <button onClick={decline} disabled={busy} style={{ padding: '8px 14px', border: '1px solid #fecaca', background: '#fff', color: '#dc2626', borderRadius: 8, fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>Decline</button>
          <button onClick={submit} disabled={busy} style={{ padding: '8px 20px', border: 'none', background: busy ? '#c4b5fd' : PURPLE, color: '#fff', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
            {busy ? 'Working…' : (doc.payment_required && doc.payment_status !== 'paid' ? 'Pay & Sign' : 'Finish & Sign')}
          </button>
        </div>
      </div>

      {doc.message && <div style={{ maxWidth: 800, margin: '14px auto 0', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: '10px 16px', fontSize: 13, color: '#4c1d95' }}>{doc.message}</div>}

      <div style={{ padding: '20px 0' }}>
        {fileData ? (
          <PdfCanvas
            fileData={fileData}
            width={800}
            renderOverlay={(pageNum) => (
              <div style={{ position: 'absolute', inset: 0 }}>
                {fieldsFor(pageNum).map(f => {
                  const style = {
                    position: 'absolute', left: `${f.x_ratio * 100}%`, top: `${f.y_ratio * 100}%`,
                    width: `${f.w_ratio * 100}%`, height: `${f.h_ratio * 100}%`,
                  };
                  if (f.field_type === 'signature' || f.field_type === 'initials') {
                    const v = values[f.id];
                    return (
                      <div key={f.id} onClick={() => setShowAdopt(true)}
                        style={{ ...style, border: `2px dashed ${PURPLE}`, background: v ? '#fff' : '#f5f3ff', borderRadius: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                        {v
                          ? (signature?.type === 'typed'
                            ? <span style={{ fontFamily: 'cursive', fontSize: 18, color: '#111' }}>{v}</span>
                            : <img src={v} alt="signature" style={{ maxHeight: '100%', maxWidth: '100%' }} />)
                          : <span style={{ fontSize: 10, color: PURPLE, fontWeight: 700 }}>{f.field_type === 'initials' ? 'Initials' : 'Sign here'}</span>}
                      </div>
                    );
                  }
                  if (f.field_type === 'checkbox') {
                    return <input key={f.id} type="checkbox" checked={values[f.id] === 'true'} onChange={e => setValues(v => ({ ...v, [f.id]: e.target.checked ? 'true' : 'false' }))} style={{ ...style }} />;
                  }
                  return (
                    <input key={f.id} value={values[f.id] || ''} onChange={e => setValues(v => ({ ...v, [f.id]: e.target.value }))}
                      placeholder={f.label || f.field_type}
                      style={{ ...style, border: `2px solid ${BORDER}`, borderRadius: 4, padding: '0 4px', fontSize: 11, background: '#fff' }} />
                  );
                })}
              </div>
            )}
          />
        ) : (
          // No source PDF — simple accept-and-sign card (metadata-only requests)
          <div style={{ maxWidth: 560, margin: '0 auto', background: '#fff', borderRadius: 14, padding: 28, border: `1px solid ${BORDER}` }}>
            <p style={{ fontSize: 14, color: '#374151' }}>Please review and apply your signature to <strong>{doc.title}</strong>.</p>
            <button onClick={() => setShowAdopt(true)} style={{ marginTop: 12, padding: '10px 20px', background: signature ? '#dcfce7' : PURPLE, color: signature ? '#15803d' : '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
              {signature ? '✓ Signature adopted' : 'Adopt signature'}
            </button>
          </div>
        )}
      </div>

      {showAdopt && <AdoptModal signerName={doc.signer?.name} onClose={() => setShowAdopt(false)} onAdopt={adopt} />}
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: '#f3f0fb', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: '40px 48px', textAlign: 'center', boxShadow: '0 10px 40px rgba(0,0,0,.08)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, maxWidth: 460 }}>
        {children}
      </div>
    </div>
  );
}
