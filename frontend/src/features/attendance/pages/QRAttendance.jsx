import { useState, useEffect, useRef, useCallback } from 'react';
import api from '@/services/api/client';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { Camera, CameraOff, QrCode } from 'lucide-react';

const PURPLE = '#6B3FDB';
const LIGHT  = '#f5f3ff';
const BORDER = '#e9e4ff';

export default function QRAttendance() {
  // hasAnyRole, not user.role: `role` is only the PRIMARY role of a many-to-many
  // set, so gating on it alone hid the manager view from anyone holding manager
  // as a secondary role. See AuthContext.
  const { hasAnyRole } = useAuth();
  const isManager = hasAnyRole('admin', 'super_admin', 'manager');

  const [tab, setTab] = useState('scan');       // 'scan' | 'generate' | 'scans'
  const [scanning, setScanning] = useState(false);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [scanType, setScanType] = useState('in');
  const [lastScan, setLastScan] = useState(null);
  const [scanLoading, setScanLoading] = useState(false);

  const [codes, setCodes] = useState([]);
  const [scans, setScans] = useState([]);
  const [genForm, setGenForm] = useState({ location: '', scan_type: 'both', valid_hours: 8 });
  const [generating, setGenerating] = useState(false);

  const toast = useToast();
  const videoRef    = useRef(null);
  const streamRef   = useRef(null);
  const detectorRef = useRef(null);
  const rafRef      = useRef(null);
  const isMounted   = useRef(true);
  useEffect(() => { isMounted.current = true; return () => { isMounted.current = false; stopCamera(); }; }, []);

  /* ── Camera QR scanner using BarcodeDetector API ───────────────── */
  const stopCamera = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (isMounted.current) setCameraActive(false);
  };

  const startCamera = async () => {
    setCameraError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('Camera not supported in this browser.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraActive(true);

      // Use BarcodeDetector API if available, otherwise show fallback message
      if ('BarcodeDetector' in window) {
        detectorRef.current = new window.BarcodeDetector({ formats: ['qr_code'] });
        const detect = async () => {
          if (!isMounted.current || !streamRef.current) return;
          try {
            if (videoRef.current && videoRef.current.readyState === 4) {
              const barcodes = await detectorRef.current.detect(videoRef.current);
              if (barcodes.length > 0) {
                const rawValue = barcodes[0].rawValue;
                stopCamera();
                await submitScan(rawValue);
                return;
              }
            }
          } catch { /* non-blocking */ }
          rafRef.current = requestAnimationFrame(detect);
        };
        rafRef.current = requestAnimationFrame(detect);
      }
      // If BarcodeDetector not available, camera shows live feed — user reads token manually
    } catch (err) {
      const msg = err.name === 'NotAllowedError'
        ? 'Camera permission denied. Allow camera access in browser settings.'
        : err.name === 'NotFoundError'
        ? 'No camera found on this device.'
        : `Camera error: ${err.message}`;
      setCameraError(msg);
      stopCamera();
    }
  };

  /* ── fetch QR codes (admin) ─────────────────────────────────────── */
  const loadCodes = useCallback(async () => {
    try {
      const r = await api.get('/attendance/qr/codes');
      setCodes(r.data.data || []);
    } catch { /* silent */ }
  }, []);

  /* ── fetch recent scans ─────────────────────────────────────────── */
  const loadScans = useCallback(async () => {
    try {
      const r = await api.get('/attendance/qr/scans');
      setScans(r.data.data || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { if (tab === 'generate') loadCodes(); }, [tab, loadCodes]);
  useEffect(() => { if (tab === 'scans') loadScans(); }, [tab, loadScans]);

  /* ── submit scan ────────────────────────────────────────────────── */
  const submitScan = async (token) => {
    if (!token?.trim()) return;
    setScanLoading(true);
    try {
      const r = await api.post('/attendance/qr/scan', {
        code_token: token.trim(),
        scan_type: scanType,
      });
      setLastScan({ ...r.data.data, message: r.data.message });
      setManualToken('');
      toast.success(`✓ ${r.data.message}`);
    } catch (err) {
      const msg = err.response?.data?.error || 'Scan failed';
      toast.error(msg);
    } finally {
      setScanLoading(false);
    }
  };

  /* ── generate QR code ───────────────────────────────────────────── */
  const generateCode = async () => {
    setGenerating(true);
    try {
      const now = new Date();
      const until = new Date(now.getTime() + genForm.valid_hours * 60 * 60 * 1000);
      await api.post('/attendance/qr/generate', {
        location: genForm.location,
        scan_type: genForm.scan_type,
        valid_from: now.toISOString(),
        valid_until: until.toISOString(),
      });
      toast.success('QR code generated');
      await loadCodes();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to generate');
    } finally {
      setGenerating(false);
    }
  };

  const deactivateCode = async (id) => {
    try {
      await api.delete(`/attendance/qr/codes/${id}`);
      toast.success('QR code deactivated');
      await loadCodes();
    } catch { toast.error('Failed to deactivate'); }
  };

  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  const tabs = [
    { id: 'scan',     label: 'Scan QR' },
    ...(isManager ? [
      { id: 'generate', label: 'Manage QR Codes' },
      { id: 'scans',    label: 'Scan Logs' },
    ] : []),
  ];

  return (
    <div style={{ padding: 24, maxWidth: 860, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontWeight: 800, fontSize: 22, color: '#1f2937', margin: 0 }}>QR Attendance</h2>
        <p style={{ color: '#6b7280', fontSize: 13, marginTop: 4 }}>
          Scan a QR code to mark attendance, or generate codes for your site/shift.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: `2px solid ${BORDER}` }}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '8px 18px',
              fontWeight: tab === t.id ? 700 : 500,
              fontSize: 14,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: tab === t.id ? PURPLE : '#6b7280',
              borderBottom: tab === t.id ? `2px solid ${PURPLE}` : '2px solid transparent',
              marginBottom: -2,
            }}
          >{t.label}</button>
        ))}
      </div>

      {/* ── TAB: Scan ── */}
      {tab === 'scan' && (
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          {/* Scan type toggle */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {['in', 'out'].map(t => (
              <button
                key={t}
                onClick={() => setScanType(t)}
                style={{
                  flex: 1, padding: '10px 0', borderRadius: 8, border: `2px solid ${scanType === t ? PURPLE : BORDER}`,
                  background: scanType === t ? LIGHT : '#fff',
                  color: scanType === t ? PURPLE : '#6b7280',
                  fontWeight: 700, fontSize: 14, cursor: 'pointer',
                }}
              >
                Clock {t.toUpperCase()}
              </button>
            ))}
          </div>

          {/* Camera QR Scanner */}
          <div style={{ marginBottom: 20 }}>
            <div style={{
              position: 'relative', background: '#0f172a', borderRadius: 16,
              overflow: 'hidden', aspectRatio: '4/3', minHeight: 200,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <video ref={videoRef} playsInline muted
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: cameraActive ? 'block' : 'none' }} />
              {!cameraActive && (
                <div style={{ textAlign: 'center', color: '#94a3b8', padding: 24 }}>
                  <QrCode size={48} color="#475569" style={{ marginBottom: 12 }} />
                  <p style={{ margin: '0 0 4px', fontSize: 14, color: '#cbd5e1' }}>Camera QR Scanner</p>
                  <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                    {cameraError || "Tap the button below to start camera"}
                  </p>
                </div>
              )}
              {cameraActive && (
                <div style={{
                  position: 'absolute', top: '50%', left: '50%',
                  transform: 'translate(-50%,-50%)',
                  width: 180, height: 180,
                  border: '3px solid #6B3FDB',
                  borderRadius: 12,
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                  pointerEvents: 'none',
                }}>
                  <div style={{ position: 'absolute', top: -3, left: -3, width: 28, height: 28, borderTop: '4px solid #a78bfa', borderLeft: '4px solid #a78bfa', borderRadius: '10px 0 0 0' }} />
                  <div style={{ position: 'absolute', top: -3, right: -3, width: 28, height: 28, borderTop: '4px solid #a78bfa', borderRight: '4px solid #a78bfa', borderRadius: '0 10px 0 0' }} />
                  <div style={{ position: 'absolute', bottom: -3, left: -3, width: 28, height: 28, borderBottom: '4px solid #a78bfa', borderLeft: '4px solid #a78bfa', borderRadius: '0 0 0 10px' }} />
                  <div style={{ position: 'absolute', bottom: -3, right: -3, width: 28, height: 28, borderBottom: '4px solid #a78bfa', borderRight: '4px solid #a78bfa', borderRadius: '0 0 10px 0' }} />
                </div>
              )}
            </div>
            {cameraError && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', marginTop: 8, fontSize: 12, color: '#dc2626' }}>
                {cameraError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              {!cameraActive ? (
                <button onClick={startCamera}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', borderRadius: 10, border: 'none', background: PURPLE, color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                  <Camera size={16} /> Start Camera
                </button>
              ) : (
                <button onClick={stopCamera}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 0', borderRadius: 10, border: 'none', background: '#ef4444', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                  <CameraOff size={16} /> Stop Camera
                </button>
              )}
            </div>
            {'BarcodeDetector' in window
              ? <p style={{ margin: '6px 0 0', fontSize: 11, color: '#9ca3af', textAlign: 'center' }}>Point camera at QR code — auto-detects</p>
              : <p style={{ margin: '6px 0 0', fontSize: 11, color: '#f59e0b', textAlign: 'center' }}>Auto-detection not supported in this browser. Use manual entry below.</p>
            }
          </div>

          {/* Manual token entry */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
              Enter QR Code Token
            </label>
            <input
              value={manualToken}
              onChange={e => setManualToken(e.target.value)}
              placeholder="Paste or type the QR code token..."
              style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                border: `1px solid ${BORDER}`, fontSize: 14, outline: 'none', boxSizing: 'border-box',
              }}
              onKeyDown={e => e.key === 'Enter' && submitScan(manualToken)}
            />
          </div>

          <button
            onClick={() => submitScan(manualToken)}
            disabled={scanLoading || !manualToken.trim()}
            style={{
              width: '100%', padding: '12px 0', borderRadius: 8,
              background: scanLoading || !manualToken.trim() ? '#d1d5db' : PURPLE,
              color: '#fff', fontWeight: 700, fontSize: 15,
              border: 'none', cursor: scanLoading ? 'not-allowed' : 'pointer',
            }}
          >
            {scanLoading ? 'Marking Attendance…' : `Mark Clock ${scanType.toUpperCase()}`}
          </button>

          {/* Last scan result */}
          {lastScan && (
            <div style={{
              marginTop: 20, padding: 16, borderRadius: 10,
              background: '#dcfce7', border: '1px solid #86efac',
            }}>
              <div style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>✓ Attendance Recorded</div>
              <div style={{ fontSize: 13, color: '#166534', marginTop: 4 }}>
                {lastScan.message} at {fmtTime(lastScan.scan_time)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Generate ── */}
      {tab === 'generate' && (
        <div>
          {/* Generate form */}
          <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 24 }}>
            <h3 style={{ fontWeight: 700, fontSize: 16, color: '#1f2937', margin: '0 0 16px' }}>Generate New QR Code</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Location / Site</label>
                <input
                  value={genForm.location}
                  onChange={e => setGenForm(f => ({ ...f, location: e.target.value }))}
                  placeholder="e.g. Main Gate, Factory Floor B"
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>
              <div>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Valid For (hours)</label>
                <input
                  type="number" min="1" max="24"
                  value={genForm.valid_hours}
                  onChange={e => setGenForm(f => ({ ...f, valid_hours: parseInt(e.target.value) || 8 }))}
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: `1px solid ${BORDER}`, fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>Scan Type</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['in', 'out', 'both'].map(t => (
                  <button key={t} onClick={() => setGenForm(f => ({ ...f, scan_type: t }))}
                    style={{
                      padding: '7px 16px', borderRadius: 7, border: `1px solid ${genForm.scan_type === t ? PURPLE : BORDER}`,
                      background: genForm.scan_type === t ? LIGHT : '#fff',
                      color: genForm.scan_type === t ? PURPLE : '#6b7280',
                      fontWeight: 600, fontSize: 13, cursor: 'pointer',
                    }}
                  >{t === 'both' ? 'In & Out' : `Clock ${t.toUpperCase()}`}</button>
                ))}
              </div>
            </div>
            <button
              onClick={generateCode}
              disabled={generating}
              style={{
                padding: '10px 28px', borderRadius: 8, background: generating ? '#d1d5db' : PURPLE,
                color: '#fff', fontWeight: 700, fontSize: 14, border: 'none', cursor: generating ? 'not-allowed' : 'pointer',
              }}
            >
              {generating ? 'Generating…' : '+ Generate QR Code'}
            </button>
          </div>

          {/* Active codes */}
          <h3 style={{ fontWeight: 700, fontSize: 15, color: '#1f2937', marginBottom: 12 }}>Active QR Codes</h3>
          {codes.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
              No active QR codes. Generate one above.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {codes.map(c => (
                <div key={c.id} style={{
                  background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 16,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#1f2937', fontSize: 14 }}>{c.location || 'General'}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>
                      Valid: {fmtTime(c.valid_from)} → {fmtTime(c.valid_until)}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2, fontFamily: 'monospace' }}>
                      {c.code_token.substring(0, 20)}…
                    </div>
                    <span style={{
                      display: 'inline-block', marginTop: 6, padding: '2px 8px', borderRadius: 10,
                      background: '#dbeafe', color: '#1d4ed8', fontSize: 11, fontWeight: 700,
                    }}>
                      {c.scan_type === 'both' ? 'In & Out' : `Clock ${c.scan_type.toUpperCase()}`}
                    </span>
                  </div>
                  <button
                    onClick={() => deactivateCode(c.id)}
                    style={{
                      padding: '6px 14px', borderRadius: 7, background: '#fee2e2',
                      color: '#dc2626', fontWeight: 600, fontSize: 12, border: 'none', cursor: 'pointer',
                    }}
                  >Deactivate</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── TAB: Scan Logs ── */}
      {tab === 'scans' && (
        <div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: LIGHT }}>
                  {['Employee', 'Clock', 'Time', 'Location', 'Status'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, color: '#374151', borderBottom: `1px solid ${BORDER}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scans.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No scan records found.</td></tr>
                ) : scans.map(s => (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <td style={{ padding: '10px 14px', fontWeight: 600 }}>{s.employee_name}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                        background: s.scan_type === 'in' ? '#dcfce7' : '#fef3c7',
                        color: s.scan_type === 'in' ? '#15803d' : '#b45309',
                      }}>
                        {s.scan_type === 'in' ? 'IN' : 'OUT'}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{fmtTime(s.scan_time)}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>{s.qr_location || '—'}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                        background: s.status === 'valid' ? '#dcfce7' : '#fee2e2',
                        color: s.status === 'valid' ? '#15803d' : '#dc2626',
                      }}>
                        {s.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
