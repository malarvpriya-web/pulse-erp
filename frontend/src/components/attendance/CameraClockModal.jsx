import { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, X, MapPin, RefreshCw, AlertTriangle, CheckCircle, RotateCcw } from 'lucide-react';
import { capturePhoto, isNative } from '@/mobile/native';
import { getLocationString } from './geo';

/**
 * CameraClockModal — the in-app punch for FIELD employees.
 *
 * Field staff clock in from customer sites, so the office face/biometric
 * terminal is not available to them and the shift window and geo-fence do not
 * apply. Their proof of presence is a live camera selfie plus GPS coordinates,
 * and POST /attendance/clock rejects a field clock-in missing either one
 * (see backend/src/shared/punchMode.js).
 *
 * Deliberately has NO face-recognition step and NO CDN dependency. The old face
 * flow downloaded @vladmandic/face-api and its models from jsdelivr and only
 * opened the camera after both had loaded, so on a site with no internet — or a
 * locked-down factory LAN — the camera never opened at all. A selfie needs
 * nothing but getUserMedia and a canvas.
 *
 * Props:
 *   employeeId – db employee id (label/debug only; the server pins to session)
 *   action     – 'in' | 'out'
 *   onCaptured – ({ selfie_url, location }) => void
 *   onClose    – () => void
 */

const SHOT_W = 480;
const SHOT_H = 360;

/**
 * getUserMedia across every shape browsers have shipped it in.
 *
 * Throws a tagged error instead of a raw TypeError when the API is missing
 * entirely — which is what happens on an insecure origin. Browsers expose
 * `navigator.mediaDevices` ONLY in a secure context (https, or localhost), so
 * an ERP opened over the LAN as http://192.168.x.x has `mediaDevices ===
 * undefined`, and the old code died on "Cannot read properties of undefined
 * (reading 'getUserMedia')" with no hint about the real cause.
 */
function requestCamera(constraints) {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (md?.getUserMedia) return md.getUserMedia(constraints);

  const legacy = typeof navigator !== 'undefined'
    ? (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia)
    : undefined;
  if (legacy) {
    return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
  }

  const loc = typeof window !== 'undefined' ? window.location : null;
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(loc?.hostname || '');
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false && !localHost;
  const err = new Error(
    insecure
      ? `Your browser blocks the camera on an insecure connection. Pulse is open at ${loc.protocol}//${loc.host} — reopen it over HTTPS (or on localhost) to use camera attendance.`
      : 'This browser does not support camera capture.'
  );
  err.name = insecure ? 'InsecureContextError' : 'NotSupportedError';
  return Promise.reject(err);
}

/** Turn a getUserMedia rejection into something an employee can act on. */
function cameraMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera permission was denied. Allow camera access for this site in your browser settings, then retry.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is already in use by another app. Close it and retry.';
    case 'OverconstrainedError':
      return 'This camera does not support the requested settings. Retry to use the default camera.';
    case 'SecurityError':
    case 'InsecureContextError':
    case 'NotSupportedError':
      return err.message;
    default:
      return err?.message || 'Could not start the camera.';
  }
}

// Draw whatever is on screen (a <video> frame, or a still <img>) into a canvas
// and return a JPEG data URL.
function toDataUrl(source, w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(source, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.7);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read the captured photo.'));
    img.src = dataUrl;
  });
}

export default function CameraClockModal({ action = 'in', onCaptured, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const aliveRef = useRef(true);

  const [phase, setPhase] = useState('starting'); // starting | live | still | shot | error
  const [message, setMessage] = useState('Starting camera…');
  const [shot, setShot] = useState(null); // captured data URL
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0); // bumping this retries the camera

  // GPS runs alongside the camera — it is slow and equally mandatory, so there
  // is no reason to make the employee wait for one before the other starts.
  const [location, setLocation] = useState(null);
  const [geoState, setGeoState] = useState('locating'); // locating | ok | failed

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const findLocation = useCallback(async () => {
    setGeoState('locating');
    const loc = await getLocationString();
    if (!aliveRef.current) return;
    setLocation(loc);
    setGeoState(loc ? 'ok' : 'failed');
  }, []);

  // `aliveRef` is armed on every mount, not just the first. Arming it only in
  // the cleanup of a mount-once effect leaves it false forever after React
  // StrictMode's double-invoke, which hangs the modal on "Starting camera…".
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => { findLocation(); }, [findLocation, attempt]);

  // Camera boot. Any failure to get a live stream drops to the still-photo path
  // (OS camera on device, file input with `capture` on mobile web) rather than
  // dead-ending — a selfie from the system camera is just as good as proof.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase('starting');
      setMessage('Starting camera…');
      try {
        const stream = await requestCamera({
          video: { facingMode: 'user', width: { ideal: SHOT_W }, height: { ideal: SHOT_H } },
          audio: false,
        });
        if (cancelled || !aliveRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setPhase('live');
        setMessage('');
      } catch (err) {
        if (cancelled || !aliveRef.current) return;
        // A denied permission is the one case worth stopping on: silently
        // falling back to a file picker would hide the fix from the employee.
        if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
          setPhase('error');
          setMessage(cameraMessage(err));
          return;
        }
        setPhase('still');
        setMessage(cameraMessage(err));
      }
    })();
    return () => { cancelled = true; stopCamera(); };
  }, [attempt, stopCamera]);

  const captureLive = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      setMessage('Camera is still warming up — try again in a second.');
      return;
    }
    setShot(toDataUrl(video, SHOT_W, SHOT_H));
    setPhase('shot');
    setMessage('');
    stopCamera();
  }, [stopCamera]);

  const captureStill = useCallback(async () => {
    setBusy(true);
    try {
      const dataUrl = await capturePhoto({ quality: 80, facing: 'user' });
      const img = await loadImage(dataUrl);
      if (!aliveRef.current) return;
      setShot(toDataUrl(img, SHOT_W, SHOT_H));
      setPhase('shot');
      setMessage('');
    } catch (err) {
      if (aliveRef.current) setMessage(err?.message || 'No photo captured.');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, []);

  const retake = useCallback(() => { setShot(null); setAttempt((a) => a + 1); }, []);

  const confirm = useCallback(() => {
    if (!shot || !location) return;
    stopCamera();
    onCaptured?.({ selfie_url: shot, location });
  }, [shot, location, onCaptured, stopCamera]);

  const close = useCallback(() => { stopCamera(); onClose?.(); }, [stopCamera, onClose]);

  const verb = action === 'out' ? 'Clock Out' : 'Clock In';
  const ready = !!shot && !!location;

  return (
    <div style={S.backdrop} role="dialog" aria-modal="true" aria-label={`Camera ${verb}`}>
      <div style={S.card}>
        <div style={S.header}>
          <span style={S.title}><Camera size={18} /> Camera {verb}</span>
          <button onClick={close} style={S.iconBtn} aria-label="Close"><X size={18} /></button>
        </div>

        <div style={S.stage}>
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            style={{ ...S.video, display: phase === 'live' ? 'block' : 'none' }}
          />
          {shot && <img src={shot} alt="Captured selfie" style={S.video} />}

          {phase === 'starting' && (
            <div style={S.overlay}>
              <RefreshCw size={26} style={{ animation: 'pulse-spin 1s linear infinite' }} />
              <span style={S.overlayText}>{message}</span>
            </div>
          )}
          {phase === 'still' && !shot && (
            <div style={S.overlay}>
              <Camera size={32} />
              <span style={S.overlayText}>{message || 'Use the button below to take your photo.'}</span>
            </div>
          )}
          {phase === 'error' && (
            <div style={S.overlay}>
              <AlertTriangle size={28} color="#fca5a5" />
              <span style={S.overlayText}>{message}</span>
            </div>
          )}
        </div>

        <div style={S.body}>
          {/* GPS is as mandatory as the photo, so its state is always visible. */}
          <div style={{ ...S.geo, color: geoState === 'ok' ? '#059669' : geoState === 'failed' ? '#b91c1c' : '#6b7280' }}>
            <MapPin size={13} />
            {geoState === 'locating' && 'Getting your location…'}
            {geoState === 'ok' && `Location captured (${location})`}
            {geoState === 'failed' && 'Location unavailable — enable GPS/location access, then retry.'}
            {geoState === 'failed' && <button onClick={findLocation} style={S.linkBtn}>Retry</button>}
          </div>

          {message && phase === 'shot' && <div style={S.msg}>{message}</div>}

          {phase === 'live' && (
            <button onClick={captureLive} style={btn(true, '#7c3aed')}>
              <Camera size={16} /> Take Photo
            </button>
          )}

          {phase === 'still' && !shot && (
            <button onClick={captureStill} disabled={busy} style={btn(!busy, '#7c3aed')}>
              <Camera size={16} /> {busy ? 'Opening camera…' : 'Take Photo'}
            </button>
          )}

          {phase === 'shot' && (
            <>
              <button onClick={confirm} disabled={!ready} style={btn(ready, '#16a34a')}>
                <CheckCircle size={16} /> {ready ? `${verb} Now` : 'Waiting for location…'}
              </button>
              <button
                onClick={retake}
                style={{ ...btn(true, '#7c3aed'), marginTop: 10, background: 'transparent', color: '#7c3aed', border: '1px solid #ddd6fe' }}
              >
                <RotateCcw size={15} /> Retake photo
              </button>
            </>
          )}

          {phase === 'error' && (
            <>
              <button onClick={() => setAttempt((a) => a + 1)} style={btn(true, '#7c3aed')}>
                <RefreshCw size={16} /> Retry camera
              </button>
              <button
                onClick={captureStill}
                disabled={busy}
                style={{ ...btn(!busy, '#7c3aed'), marginTop: 10, background: 'transparent', color: '#7c3aed', border: '1px solid #ddd6fe' }}
              >
                <Camera size={15} /> {isNative() ? 'Use device camera instead' : 'Upload a photo instead'}
              </button>
            </>
          )}
        </div>
      </div>
      <style>{`@keyframes pulse-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const S = {
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.72)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { background: '#fff', borderRadius: 16, width: 420, maxWidth: '95vw', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #f0f0f4' },
  title: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: '#4c1d95', fontSize: 15 },
  iconBtn: { border: 'none', background: 'none', cursor: 'pointer', color: '#6b7280' },
  stage: { position: 'relative', background: '#111827', aspectRatio: '4 / 3', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  video: { width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' },
  overlay: { position: 'absolute', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', padding: 24 },
  overlayText: { fontSize: 13, lineHeight: 1.5 },
  body: { padding: 18 },
  geo: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, marginBottom: 12, flexWrap: 'wrap' },
  linkBtn: { border: 'none', background: 'none', color: '#7c3aed', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', padding: 0, textDecoration: 'underline' },
  msg: { fontSize: 13, color: '#6b7280', marginBottom: 12, textAlign: 'center' },
};

function btn(active, color) {
  return {
    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    padding: '11px 0', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: 14,
    color: '#fff', background: active ? color : '#c4b5fd',
    cursor: active ? 'pointer' : 'default', opacity: active ? 1 : 0.85,
  };
}
