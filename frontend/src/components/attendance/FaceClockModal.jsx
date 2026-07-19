import { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, X, ShieldCheck, RefreshCw, AlertTriangle, CheckCircle, UserPlus } from 'lucide-react';
import api from '@/services/api/client';
import { getPosition, capturePhoto, isNative } from '@/mobile/native';

/**
 * FaceClockModal — browser face-recognition for attendance.
 *
 * Loads @vladmandic/face-api from CDN (no bundled dependency), opens the webcam,
 * computes a 128-float descriptor and either:
 *   • enrolls it (first time), or
 *   • verifies it against the enrolled template via POST /attendance/face/verify.
 *
 * On a successful verify it calls `onVerified({ confidence })` so the parent can
 * run the real punch through the existing /attendance/clock endpoint (which keeps
 * all geo-fence / shift / late-policy logic in one place).
 *
 * Props:
 *   employeeId  – db employee id of the person clocking
 *   action      – 'in' | 'out' (label only; the punch itself is the parent's job)
 *   onVerified  – ({ confidence }) => void   called after a matched face
 *   onClose     – () => void
 */

const FACEAPI_SRC  = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/dist/face-api.min.js';
const MODEL_URL    = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';
const MIN_SCORE    = 0.75; // detector confidence required before we let you capture

// Load the face-api global once, shared across mounts.
let faceapiPromise = null;
function loadFaceApi() {
  if (window.faceapi) return Promise.resolve(window.faceapi);
  if (faceapiPromise) return faceapiPromise;
  faceapiPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = FACEAPI_SRC;
    s.async = true;
    s.onload = () => (window.faceapi ? resolve(window.faceapi) : reject(new Error('face-api failed to initialise')));
    s.onerror = () => reject(new Error('Could not load face recognition library (check your connection)'));
    document.head.appendChild(s);
  });
  return faceapiPromise;
}

// Resolve the device GPS position as a "lat,lng" string, or null when
// unavailable/denied. Routes through the native bridge — native GPS + OS
// permission inside the Capacitor app, browser Geolocation on web. The server
// decides whether location is mandatory.
export async function getLocationString(timeoutMs = 8000) {
  try {
    const { latitude, longitude } = await getPosition({ highAccuracy: true, timeout: timeoutMs });
    return `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  } catch {
    return null;
  }
}

// Load a data URL into a decoded <img> so face-api can run on a still frame.
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load captured photo'));
    img.src = dataUrl;
  });
}

let modelsLoaded = false;
async function loadModels(faceapi) {
  if (modelsLoaded) return;
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsLoaded = true;
}

// Eye Aspect Ratio — drops sharply when the eye closes. Used for blink-based
// liveness so a static photo (which never blinks) cannot pass verification.
function eyeAspectRatio(eye) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(eye[1], eye[5]) + d(eye[2], eye[4])) / (2 * d(eye[0], eye[3]));
}
const EAR_CLOSED = 0.21; // below this = eye considered shut
const EAR_OPEN   = 0.27; // above this after a close = blink complete

export default function FaceClockModal({ employeeId, action = 'in', onVerified, onClose }) {
  const videoRef  = useRef(null);
  const streamRef = useRef(null);
  const rafRef    = useRef(null);
  const faceapiRef = useRef(null);
  const blinkRef  = useRef({ closed: false, blinks: 0 }); // blink state machine

  const [phase, setPhase]   = useState('loading'); // loading | ready | working | success | error
  const [message, setMessage] = useState('Starting camera…');
  const [liveScore, setLiveScore] = useState(0);   // live detector score for the guidance ring
  const [live, setLive]     = useState(false);     // blink-liveness passed
  const [enrolled, setEnrolled]   = useState(null); // null=unknown, true/false once known
  const [busy, setBusy]     = useState(false);
  const [failCount, setFailCount] = useState(0); // consecutive verify failures → offer re-enroll
  // Native still-photo fallback: used only when the live camera stream can't
  // start inside the app (getUserMedia unavailable in the WebView). We then grab
  // a single frame via the OS camera plugin. Blink-liveness can't run on a still,
  // so it's skipped in this mode (native-only, verified separately on device).
  const [stillMode, setStillMode] = useState(false);

  const resetLiveness = useCallback(() => { blinkRef.current = { closed: false, blinks: 0 }; setLive(false); }, []);

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, []);

  // Continuous detection loop → drives the guidance ring, and runs the blink
  // state machine (eyes open → shut → open = one blink = liveness confirmed).
  const detectLoop = useCallback(async () => {
    const faceapi = faceapiRef.current;
    const video   = videoRef.current;
    if (!faceapi || !video || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(detectLoop);
      return;
    }
    try {
      const res = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224 }))
        .withFaceLandmarks();
      if (res) {
        setLiveScore(res.detection.score);
        const ear = (eyeAspectRatio(res.landmarks.getLeftEye()) + eyeAspectRatio(res.landmarks.getRightEye())) / 2;
        const st = blinkRef.current;
        if (ear < EAR_CLOSED) {
          st.closed = true;
        } else if (ear > EAR_OPEN && st.closed) {
          st.closed = false;
          st.blinks += 1;
          setLive(true);
        }
      } else {
        setLiveScore(0);
      }
    } catch { /* transient */ }
    rafRef.current = requestAnimationFrame(detectLoop);
  }, []);

  // Boot: load lib + models + enrollment status + camera.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const faceapi = await loadFaceApi();
        if (cancelled) return;
        faceapiRef.current = faceapi;
        setMessage('Loading face models…');
        await loadModels(faceapi);
        if (cancelled) return;

        // Are we already enrolled?
        try {
          const { data } = await api.get('/attendance/face/status', { params: { employee_id: employeeId } });
          if (!cancelled) setEnrolled(!!data?.enrolled);
        } catch { if (!cancelled) setEnrolled(false); }

        setMessage('Requesting camera…');
        let stream = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 480, height: 360 } });
        } catch (streamErr) {
          // Inside the native app, fall back to the OS camera (single still) when
          // the WebView won't give us a live stream. On web, re-throw so the
          // existing permission-denied messaging still shows.
          if (!isNative()) throw streamErr;
          if (cancelled) return;
          setStillMode(true);
          setPhase('ready');
          setMessage('Tap to capture your photo.');
          return;
        }
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setPhase('ready');
        setMessage('');
        rafRef.current = requestAnimationFrame(detectLoop);
      } catch (err) {
        if (cancelled) return;
        setPhase('error');
        setMessage(
          err?.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access and try again.'
            : (err?.message || 'Could not start face recognition.')
        );
      }
    })();
    return () => { cancelled = true; stopCamera(); };
  }, [employeeId, detectLoop, stopCamera]);

  // Grab one high-quality frame and return its descriptor + score. Source is the
  // live <video> normally, or an OS-camera still (loaded into an <img>) in the
  // native still-photo fallback.
  const captureDescriptor = useCallback(async () => {
    const faceapi = faceapiRef.current;
    let media = videoRef.current;
    if (stillMode) {
      const dataUrl = await capturePhoto({ quality: 90 });
      media = await loadImage(dataUrl);
    }
    const res = await faceapi
      .detectSingleFace(media, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!res) throw new Error('No face detected — face the camera in good light.');
    return { descriptor: Array.from(res.descriptor), score: res.detection.score };
  }, [stillMode]);

  const handleEnroll = useCallback(async () => {
    setBusy(true); setMessage('Capturing your face…');
    try {
      const { descriptor } = await captureDescriptor();
      await api.post('/attendance/face/self-enroll', { employee_id: employeeId, descriptor });
      setEnrolled(true);
      setFailCount(0);
      setMessage('Face enrolled! Blink again, then verify to clock in.');
    } catch (err) {
      setMessage(err?.response?.data?.message || err?.message || 'Enrollment failed. Try again.');
    } finally { resetLiveness(); setBusy(false); }
  }, [captureDescriptor, employeeId, resetLiveness]);

  const handleVerify = useCallback(async () => {
    setBusy(true); setPhase('working'); setMessage('Verifying…');
    try {
      const { descriptor } = await captureDescriptor();
      // Liveness confirmed client-side by a real blink → report a passing score.
      const { data } = await api.post('/attendance/face/verify', {
        employee_id: employeeId,
        descriptor,
        liveness_score: 0.95,
      });
      if (data?.match) {
        setPhase('success');
        setMessage('Face matched ✓');
        setFailCount(0);
        stopCamera();
        setTimeout(() => onVerified?.({ confidence: data.confidence, face_token: data.face_token }), 700);
        return;
      }
      setPhase('ready');
      setMessage('Face did not match. Try again.');
      setFailCount(c => c + 1);
      resetLiveness();
    } catch (err) {
      setPhase('ready');
      const code = err?.response?.data?.error;
      setMessage(
        code === 'account_locked'  ? 'Too many attempts — locked. Contact HR or try later.'
      : code === 'no_match'        ? 'Face did not match your enrolled photo. Try again.'
      : code === 'spoof_detected'  ? 'Liveness check failed. Use a real, well-lit face.'
      : code === 'employee_not_enrolled' ? 'You are not enrolled yet — enroll first.'
      : (err?.response?.data?.message || err?.message || 'Verification failed.')
      );
      if (code === 'employee_not_enrolled') setEnrolled(false);
      if (code === 'no_match' || code === 'spoof_detected') setFailCount(c => c + 1);
      resetLiveness();
    } finally { setBusy(false); }
  }, [captureDescriptor, employeeId, onVerified, stopCamera, resetLiveness]);

  const scoreReady = stillMode ? true : liveScore >= MIN_SCORE;
  const canAct     = stillMode ? true : (scoreReady && live);
  const ringColor  = phase === 'success' ? '#16a34a' : canAct ? '#16a34a' : scoreReady ? '#3b82f6' : liveScore > 0.3 ? '#f59e0b' : '#9ca3af';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.72)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: 420, maxWidth: '95vw', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}>
        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #f0f0f4' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#4c1d95', fontSize: 15 }}>
            <ShieldCheck size={18} /> Face {action === 'out' ? 'Clock Out' : 'Clock In'}
          </span>
          <button onClick={() => { stopCamera(); onClose?.(); }} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#6b7280' }} aria-label="Close"><X size={18} /></button>
        </div>

        {/* video */}
        <div style={{ position: 'relative', background: '#111827', aspectRatio: '4 / 3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', display: (phase === 'error' || stillMode) ? 'none' : 'block' }} />
          {/* guidance ring (live mode only) */}
          {phase !== 'error' && !stillMode && (
            <div style={{ position: 'absolute', width: 200, height: 200, borderRadius: '50%', border: `4px solid ${ringColor}`, boxShadow: `0 0 0 9999px rgba(0,0,0,0.28)`, transition: 'border-color 0.2s', pointerEvents: 'none' }} />
          )}
          {stillMode && phase !== 'success' && (
            <div style={{ position: 'absolute', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', padding: 24 }}>
              <Camera size={34} />
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>Use the camera button below to capture your photo.</span>
            </div>
          )}
          {phase === 'loading' && (
            <div style={{ position: 'absolute', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <RefreshCw size={26} style={{ animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: 13 }}>{message}</span>
            </div>
          )}
          {phase === 'error' && (
            <div style={{ position: 'absolute', color: '#fff', textAlign: 'center', padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <AlertTriangle size={28} color="#fca5a5" />
              <span style={{ fontSize: 13, lineHeight: 1.5 }}>{message}</span>
            </div>
          )}
          {phase === 'success' && (
            <div style={{ position: 'absolute', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <CheckCircle size={40} color="#4ade80" />
            </div>
          )}
        </div>

        {/* controls */}
        <div style={{ padding: 18 }}>
          {message && phase !== 'loading' && phase !== 'error' && (
            <div style={{ fontSize: 13, color: phase === 'success' ? '#16a34a' : '#6b7280', marginBottom: 12, textAlign: 'center', minHeight: 18 }}>{message}</div>
          )}

          {phase === 'ready' && enrolled === false && (
            <>
              <p style={{ fontSize: 12.5, color: '#6b7280', textAlign: 'center', margin: '0 0 12px' }}>
                First time here — enroll your face once. Center your face in the ring, then <strong>blink</strong> to confirm you're live.
              </p>
              <button onClick={handleEnroll} disabled={busy || !canAct}
                style={btn(canAct && !busy, '#7c3aed')}>
                <UserPlus size={16} /> {busy ? 'Enrolling…' : stillMode ? 'Take Photo & Enroll' : !scoreReady ? 'Position your face…' : !live ? 'Blink to continue…' : 'Enroll My Face'}
              </button>
            </>
          )}

          {phase === 'ready' && enrolled === true && (
            <>
              <button onClick={handleVerify} disabled={busy || !canAct}
                style={btn(canAct && !busy, '#16a34a')}>
                <Camera size={16} /> {busy ? 'Verifying…' : stillMode ? `Take Photo & Clock ${action === 'out' ? 'Out' : 'In'}` : !scoreReady ? 'Position your face…' : !live ? 'Blink to continue…' : `Verify & Clock ${action === 'out' ? 'Out' : 'In'}`}
              </button>
              {failCount >= 2 && (
                <button onClick={handleEnroll} disabled={busy || !canAct}
                  style={{ ...btn(canAct && !busy, '#7c3aed'), marginTop: 10, background: 'transparent', color: '#7c3aed', border: '1px solid #ddd6fe' }}>
                  <UserPlus size={15} /> Not matching? Re-enroll my face
                </button>
              )}
            </>
          )}

          {phase === 'working' && (
            <button disabled style={btn(false, '#16a34a')}><RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} /> Verifying…</button>
          )}

          {phase === 'error' && (
            <button onClick={() => { stopCamera(); onClose?.(); }} style={btn(true, '#6b7280')}>Close</button>
          )}
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function btn(active, color) {
  return {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '11px 0', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 14,
    color: '#fff', background: active ? color : '#c4b5fd',
    cursor: active ? 'pointer' : 'default', opacity: active ? 1 : 0.85,
  };
}
