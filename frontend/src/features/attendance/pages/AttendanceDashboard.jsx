import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Clock,
  CheckCircle,
  X,
  Calendar,
  LogIn,
  LogOut,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  FileEdit,
  RefreshCw,
  MapPin,
  Download,
  Trophy,
  Coffee,
} from 'lucide-react';
import api from '@/services/api/client';
import { getPosition } from '@/mobile/native';
import { useAuth } from '@/context/AuthContext';
import FaceClockModal from '@/components/attendance/FaceClockModal';
import './AttendanceDashboard.css';

// ─── helpers ────────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

const formatTime12 = (date) => {
  let h = date.getHours();
  const m = date.getMinutes();
  const s = date.getSeconds();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${pad(h)}:${pad(m)}:${pad(s)} ${ampm}`;
};

const formatTime12Short = (date) => {
  let h = date.getHours();
  const m = date.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${pad(h)}:${pad(m)} ${ampm}`;
};

const toYMD = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// Parse "HH:MM AM/PM" → total minutes from midnight
const parseTimeToMinutes = (str) => {
  if (!str) return 0;
  const parts = str.trim().split(' ');
  const [hStr, mStr] = parts[0].split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  const ampm = parts[1];
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return h * 60 + m;
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATUS_COLORS = {
  present: { bg: '#dcfce7', text: '#166534', dot: '#16a34a' },
  absent:  { bg: '#fee2e2', text: '#991b1b', dot: '#dc2626' },
  late:    { bg: '#fef3c7', text: '#92400e', dot: '#d97706' },
  leave:   { bg: '#dbeafe', text: '#1e40af', dot: '#3b82f6' },
  holiday: { bg: '#ede9fe', text: '#5b21b6', dot: '#8b5cf6' },
  weekend: { bg: '#f9fafb', text: '#9ca3af', dot: '#d1d5db' },
  future:  { bg: '#ffffff', text: '#d1d5db', dot: '#e5e7eb' },
};

const REG_STATUS_COLORS = {
  pending:  { bg: '#fef3c7', text: '#92400e' },
  approved: { bg: '#dcfce7', text: '#166534' },
  rejected: { bg: '#fee2e2', text: '#991b1b' },
};

const fmtBreakTime = (t) => {
  if (!t) return '—';
  try {
    const d = new Date(t);
    if (!isNaN(d)) return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    const parts = String(t).split(':');
    if (parts.length >= 2) {
      let h = parseInt(parts[0], 10); const m = parseInt(parts[1], 10);
      const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
      return `${pad(h)}:${pad(m)} ${ampm}`;
    }
    return t;
  } catch { return t || '—'; }
};

// ─── Toast ───────────────────────────────────────────────────────────────────

let _setToastGlobal = null;
const showToast = (message, type = 'success') => {
  if (_setToastGlobal) _setToastGlobal({ message, type, id: Date.now() });
};

// ─── Main component ──────────────────────────────────────────────────────────

const AttendanceDashboard = () => {
  const { user } = useAuth();

  // ── state ──────────────────────────────────────────────────────────────────
  const [currentDate, setCurrentDate]         = useState(new Date());
  const [attendanceData, setAttendanceData]   = useState({});
  const [attendanceRecords, setAttendanceRecords] = useState([]);
  const [todayStatus, setTodayStatus]         = useState(null);
  const [monthlySummary, setMonthlySummary]   = useState(null);
  const [last7Days, setLast7Days]             = useState([]);
  const [holidays, setHolidays]               = useState({});     // { 'YYYY-MM-DD': name }
  const [workMode, setWorkMode]               = useState('office'); // 'office' | 'wfh'
  const [locationStatus, setLocationStatus]   = useState(null);   // null|'acquiring'|'acquired'|'denied'
  const [locationData, setLocationData]       = useState(null);
  const [regRequests, setRegRequests]         = useState([]);
  const [showRegForm, setShowRegForm]         = useState(false);
  const [regForm, setRegForm]                 = useState({ date: '', reason: '', check_in: '', check_out: '' });
  const [clocking, setClocking]               = useState(false);
  const [faceOpen, setFaceOpen]               = useState(false);
  const [loading, setLoading]                 = useState(false);
  const [liveTime, setLiveTime]               = useState(new Date());
  const [toast, setToast]                     = useState(null);
  const [selfieDataUrl, setSelfieDataUrl]      = useState(null);
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [activeBreak,  setActiveBreak]  = useState(null);
  const [breaks,       setBreaks]       = useState([]);
  const [breakType,    setBreakType]    = useState('lunch');
  const [breakLoading, setBreakLoading] = useState(false);
  const videoRef  = useRef(null);
  const canvasRef = useRef(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  useEffect(() => {
    _setToastGlobal = setToast;
    return () => { _setToastGlobal = null; };
  }, [setToast]);

  // ── live clock ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setLiveTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── auto-dismiss toast ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ── data loading ───────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!user?.employee_id) return;
    setLoading(true);
    const month = currentDate.getMonth() + 1;
    const year  = currentDate.getFullYear();

    const todayYMD = toYMD(new Date());
    const [monthRes, todayRes, holidaysRes, regRes, breaksRes] = await Promise.allSettled([
      api.get(`/attendance/employee/${user.employee_id}?month=${month}&year=${year}`),
      api.get(`/attendance/today/${user.employee_id}`),
      api.get('/holidays'),
      api.get(`/attendance/regularize/${user.employee_id}`),
      api.get(`/attendance/breaks/${user.employee_id}?date=${todayYMD}`),
    ]);

    if (!isMounted.current) return;

    // today status
    if (todayRes.status === 'fulfilled' && todayRes.value?.data) {
      const td = todayRes.value.data;
      setTodayStatus(td);
      if (td?.work_mode) setWorkMode(td.work_mode);
    } else {
      setTodayStatus(null);
    }

    // monthly data
    if (monthRes.status === 'fulfilled' && monthRes.value?.data) {
      const raw = monthRes.value.data;
      const map = {};
      const records = [];
      (raw.records || []).forEach((r) => {
        map[r.date] = r.status;
        records.push(r);
      });
      setAttendanceData(map);
      setAttendanceRecords(records);
      setMonthlySummary(raw.summary || null);
      setLast7Days(raw.last7Days || []);
    } else {
      setAttendanceData({});
      setAttendanceRecords([]);
      setMonthlySummary(null);
      setLast7Days([]);
    }

    // holidays — build date→name map
    if (holidaysRes.status === 'fulfilled' && Array.isArray(holidaysRes.value?.data)) {
      const hmap = {};
      holidaysRes.value.data.forEach((h) => {
        const d = h.date?.split('T')[0];
        if (d) hmap[d] = h.name;
      });
      setHolidays(hmap);
    }

    // regularization requests
    if (regRes.status === 'fulfilled' && Array.isArray(regRes.value?.data)) {
      setRegRequests(regRes.value.data);
    }

    // today's breaks
    if (breaksRes.status === 'fulfilled' && Array.isArray(breaksRes.value?.data)) {
      const bArr = breaksRes.value.data;
      setBreaks(bArr);
      setActiveBreak(bArr.find(b => b.is_active) || null);
    }

    setLoading(false);
  }, [user?.employee_id, currentDate]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── month navigation ───────────────────────────────────────────────────────
  const prevMonth = () =>
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1));
  const nextMonth = () =>
    setCurrentDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1));

  // ── GPS capture ────────────────────────────────────────────────────────────
  // Routes through the native bridge: native GPS + OS permission in the app,
  // browser Geolocation on web.
  const captureLocation = async () => {
    setLocationStatus('acquiring');
    try {
      const p = await getPosition({ highAccuracy: false, timeout: 6000 });
      const loc = { lat: p.latitude, lng: p.longitude, accuracy: Math.round(p.accuracy) };
      setLocationData(loc);
      setLocationStatus('acquired');
      return loc;
    } catch {
      setLocationStatus('denied');
      return null;
    }
  };

  // ── selfie capture ─────────────────────────────────────────────────────────
  const captureSelfie = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 320, height: 240 },
      });
      const video = videoRef.current;
      video.srcObject = stream;
      await new Promise((resolve) => {
        video.onloadedmetadata = () => { video.play(); setTimeout(resolve, 600); };
      });
      const canvas = canvasRef.current;
      canvas.getContext('2d').drawImage(video, 0, 0, 320, 240);
      setSelfieDataUrl(canvas.toDataURL('image/jpeg', 0.7));
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      showToast('Camera unavailable — clocking in without selfie', 'error');
    }
  };

  // ── offline queue helpers ──────────────────────────────────────────────────
  const openIDB = () => new Promise((resolve, reject) => {
    const req = indexedDB.open('pulse_attendance', 1);
    req.onupgradeneeded = (e) =>
      e.target.result.createObjectStore('offline_punches', { keyPath: 'id', autoIncrement: true });
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = reject;
  });

  useEffect(() => {
    openIDB().then((db) => {
      const tx    = db.transaction('offline_punches', 'readonly');
      const store = tx.objectStore('offline_punches');
      const req   = store.count();
      req.onsuccess = () => setOfflineQueueCount(req.result || 0);
    }).catch(() => {});
  }, []);

  // ── clock in / out ─────────────────────────────────────────────────────────
  const handleClockAction = async (faceData = null) => {
    if (clocking) return;
    setClocking(true);

    const isIn    = !todayStatus?.check_in;
    const timeStr = formatTime12Short(new Date());

    let loc = null;
    if (isIn) loc = await captureLocation();

    // snapshot for rollback on failure
    const prevStatus = todayStatus;

    // optimistic update
    setTodayStatus((prev) => ({
      ...prev,
      status:    'present',
      check_in:  isIn  ? timeStr : prev?.check_in,
      check_out: !isIn ? timeStr : prev?.check_out,
      work_mode: workMode,
    }));

    try {
      await api.post('/attendance/clock', {
        employee_id: user?.employee_id,
        action:      isIn ? 'in' : 'out',
        time:        timeStr,
        work_mode:   workMode,
        location:    loc ? `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` : null,
        selfie_url:  selfieDataUrl || undefined,
        ...(faceData?.face_token ? { face_token: faceData.face_token } : {}),
      });
      if (isMounted.current) {
        showToast(isIn ? `Clocked in at ${timeStr}` : `Clocked out at ${timeStr}`, 'success');
        setSelfieDataUrl(null);
      }
    } catch (err) {
      // Only queue for offline sync when there is no server response (network outage).
      // A server response (geo-fence denial, validation error, 4xx) must NOT be queued —
      // the server already rejected the punch for a policy reason.
      const isNetworkError = !err?.response;
      if (isNetworkError) {
        try {
          const token = localStorage.getItem('auth_token') || sessionStorage.getItem('token') || '';
          const db    = await openIDB();
          await new Promise((res, rej) => {
            const tx = db.transaction('offline_punches', 'readwrite');
            tx.objectStore('offline_punches').add({
              data: { action: isIn ? 'in' : 'out', punch_time: new Date().toISOString(), work_mode: workMode,
                      location: loc ? `${loc.lat},${loc.lng}` : null },
              auth_token: token, queued_at: new Date().toISOString(),
            });
            tx.oncomplete = res; tx.onerror = rej;
          });
          setOfflineQueueCount((c) => c + 1);
          if ('serviceWorker' in navigator && 'SyncManager' in window) {
            const reg = await navigator.serviceWorker.ready;
            await reg.sync.register('attendance-sync').catch(() => {});
          }
          if (isMounted.current) showToast('Offline — punch queued, will sync when online', 'success');
        } catch {
          if (isMounted.current) {
            setTodayStatus(prevStatus);
            showToast('Failed to record attendance. Please try again.', 'error');
          }
        }
      } else {
        // Server rejected the punch (geo-fence, auth, validation) — rollback optimistic update
        if (isMounted.current) {
          setTodayStatus(prevStatus);
          showToast(err.response?.data?.message || err.response?.data?.error || 'Attendance rejected by server. Please try again.', 'error');
        }
      }
    } finally {
      if (isMounted.current) setClocking(false);
    }
  };

  // ── regularisation submit ──────────────────────────────────────────────────
  const handleRegSubmit = async (e) => {
    e.preventDefault();
    if (!regForm.reason.trim()) {
      showToast('Please enter a reason.', 'error');
      return;
    }
    try {
      await api.post('/attendance/regularize', {
        employee_id: user?.employee_id,
        ...regForm,
      });
      showToast('Regularization request submitted.', 'success');
      setShowRegForm(false);
      setRegForm({ date: '', reason: '', check_in: '', check_out: '' });
      loadData();
    } catch {
      showToast('Failed to submit. Please try again.', 'error');
    }
  };

  const openRegDrawer = (dateStr) => {
    setRegForm({ date: dateStr, reason: '', check_in: '', check_out: '' });
    setShowRegForm(true);
  };

  // ── CSV download ───────────────────────────────────────────────────────────
  const downloadCSV = () => {
    const year       = currentDate.getFullYear();
    const month      = currentDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayYMD   = toYMD(new Date());

    const rows = [['Date', 'Day', 'Status', 'Check In', 'Check Out', 'Hours Worked', 'Work Mode']];
    for (let d = 1; d <= daysInMonth; d++) {
      const date    = new Date(year, month, d);
      const ymd     = toYMD(date);
      if (ymd > todayYMD) break;
      const rec     = attendanceRecords.find((r) => r.date === ymd);
      const dow     = date.getDay();
      const st      = holidays[ymd] ? 'holiday' : (dow === 0 || dow === 6 ? 'weekend' : (attendanceData[ymd] || 'absent'));
      const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dow];
      rows.push([
        ymd, dayName, rec?.status || st,
        rec?.check_in || '', rec?.check_out || '',
        rec?.hours_worked || '', rec?.work_mode || '',
      ]);
    }

    const csv  = rows.map((r) => r.map((v) => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `attendance-${MONTH_NAMES[month]}-${year}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── break tracking ────────────────────────────────────────────────────────
  const handleStartBreak = async () => {
    if (!user?.employee_id) return;
    setBreakLoading(true);
    try {
      const res = await api.post('/attendance/break/start', {
        employee_id: user.employee_id,
        break_type: breakType,
      });
      const nb = res.data;
      setBreaks(prev => [...prev, nb]);
      setActiveBreak(nb);
      showToast(`${breakType.charAt(0).toUpperCase() + breakType.slice(1)} break started`);
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to start break', 'error');
    } finally { setBreakLoading(false); }
  };

  const handleEndBreak = async () => {
    if (!user?.employee_id) return;
    setBreakLoading(true);
    try {
      const res = await api.post('/attendance/break/end', { employee_id: user.employee_id });
      const updated = res.data;
      setBreaks(prev => prev.map(b => b.is_active ? updated : b));
      setActiveBreak(null);
      showToast(`Break ended — ${updated.duration_minutes ?? 0} min`);
    } catch (e) {
      showToast(e.response?.data?.error || 'Failed to end break', 'error');
    } finally { setBreakLoading(false); }
  };

  // ── calendar grid ──────────────────────────────────────────────────────────
  const buildCalendarCells = () => {
    const year        = currentDate.getFullYear();
    const month       = currentDate.getMonth();
    const firstDow    = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayYMD    = toYMD(new Date());
    const cells       = [];

    for (let i = 0; i < firstDow; i++) cells.push(null);

    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const ymd  = toYMD(date);
      let status;
      const dow = date.getDay();
      if (ymd > todayYMD) {
        status = holidays[ymd] ? 'holiday' : 'future';
      } else if (holidays[ymd]) {
        status = 'holiday';
      } else if (dow === 0 || dow === 6) {
        status = attendanceData[ymd] || 'weekend';
      } else {
        status = attendanceData[ymd] || 'absent';
      }
      cells.push({ day: d, ymd, status, isToday: ymd === todayYMD, holidayName: holidays[ymd] });
    }
    return cells;
  };

  const calCells = buildCalendarCells();

  // ── derived today info ─────────────────────────────────────────────────────
  const todayCIN  = todayStatus?.check_in  || '--';
  const todayCOUT = todayStatus?.check_out || '--';

  const todayMins = (() => {
    if (todayStatus?.check_in && todayStatus?.check_out) {
      const diff = parseTimeToMinutes(todayStatus.check_out) - parseTimeToMinutes(todayStatus.check_in);
      return diff > 0 ? diff : 0;
    }
    return 0;
  })();

  const todayHrs = todayStatus?.hours_worked
    ? `${todayStatus.hours_worked}h`
    : todayMins > 0
    ? `${Math.floor(todayMins / 60)}h ${todayMins % 60}m`
    : '--';

  const isOvertime = todayMins > 9 * 60;

  const todayStatusKey = todayStatus?.status || 'pending';
  const statusLabels   = {
    present: 'Present', absent: 'Absent', late: 'Late Arrival',
    leave: 'On Leave', holiday: 'Holiday', weekend: 'Weekend',
  };

  // ── streak (consecutive present/late working days) ─────────────────────────
  const streak = useMemo(() => {
    const todayYMD = toYMD(new Date());
    let count = 0;
    const d   = new Date();
    for (let i = 0; i < 90; i++) {
      const ymd = toYMD(d);
      if (ymd > todayYMD) { d.setDate(d.getDate() - 1); continue; }
      const dow = d.getDay();
      if (dow === 0 || dow === 6 || holidays[ymd]) {
        d.setDate(d.getDate() - 1);
        continue;
      }
      const s = attendanceData[ymd];
      if (s === 'present' || s === 'late') count++;
      else break;
      d.setDate(d.getDate() - 1);
    }
    return count;
  }, [attendanceData, holidays]);

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="atd-root">

      {/* ── Toast ── */}
      {toast && (
        <div
          className="atd-toast"
          style={toast.type === 'error' ? { borderLeftColor: '#ef4444', color: '#991b1b' } : {}}
        >
          {toast.type === 'error'
            ? <AlertCircle size={16} color="#ef4444" />
            : <CheckCircle size={16} color="#10b981" />}
          <span>{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginLeft: 8, display: 'flex' }}
          >
            <X size={14} color="#9ca3af" />
          </button>
        </div>
      )}

      {/* ── Header ── */}
      <div className="atd-header">
        <h1 className="atd-title">My Attendance</h1>
        <div className="atd-nav">
          <button className="atd-nav-btn" onClick={prevMonth} title="Previous month">
            <ChevronLeft size={16} />
          </button>
          <span className="atd-month">
            {MONTH_NAMES[currentDate.getMonth()]} {currentDate.getFullYear()}
          </span>
          <button className="atd-nav-btn" onClick={nextMonth} title="Next month">
            <ChevronRight size={16} />
          </button>
          <button
            className="atd-icon-btn"
            onClick={downloadCSV}
            title="Download monthly CSV"
          >
            <Download size={15} />
          </button>
          <button
            className="atd-icon-btn"
            onClick={loadData}
            title="Refresh"
            style={loading ? { opacity: 0.5 } : {}}
            disabled={loading}
          >
            <RefreshCw size={15} style={loading ? { animation: 'atd-spin 1s linear infinite' } : {}} />
          </button>
        </div>
      </div>

      {/* ── Top row: Clock card + Summary ── */}
      <div className="atd-top-row">

        {/* Clock In/Out card */}
        <div className="atd-card">
          <div className="atd-card-hd">
            <span className="atd-card-title">Today&apos;s Attendance</span>
            <Clock size={16} color="#9ca3af" />
          </div>
          <div className="atd-card-body">
            <div className="atd-clock-time">{formatTime12(liveTime)}</div>
            <div className="atd-clock-date">
              {liveTime.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
            </div>

            {/* status badge */}
            <div
              className="atd-status-big"
              style={{
                background: STATUS_COLORS[todayStatusKey]?.bg || '#f3f4f6',
                color:      STATUS_COLORS[todayStatusKey]?.text || '#374151',
              }}
            >
              {todayStatusKey === 'present' && <CheckCircle size={15} />}
              {todayStatusKey === 'absent'  && <AlertCircle size={15} />}
              {todayStatusKey === 'late'    && <Clock size={15} />}
              {todayStatusKey === 'leave'   && <Calendar size={15} />}
              {statusLabels[todayStatusKey] || todayStatusKey}
              {todayStatus?.work_mode === 'wfh' && (
                <span className="atd-wfh-chip">WFH</span>
              )}
            </div>

            {/* check-in / check-out / hours */}
            <div className="atd-time-row">
              <div className="atd-time-item">
                <span className="atd-time-label">Check In</span>
                <span className="atd-time-val">{todayCIN}</span>
              </div>
              <div className="atd-time-item">
                <span className="atd-time-label">Check Out</span>
                <span className="atd-time-val">{todayCOUT}</span>
              </div>
              <div className="atd-time-item">
                <span className="atd-time-label">Hours</span>
                <span className="atd-time-val">
                  {todayHrs}
                  {isOvertime && <span className="atd-overtime-dot" title="Overtime" />}
                </span>
              </div>
            </div>

            {/* overtime badge */}
            {isOvertime && (
              <div className="atd-overtime-badge">
                Overtime — {Math.floor(todayMins / 60)}h {todayMins % 60}m worked
              </div>
            )}

            {/* offline queue indicator */}
            {offlineQueueCount > 0 && (
              <div style={{ background: '#fef3c7', color: '#92400e', padding: '4px 10px', borderRadius: 6, fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
                ⚡ {offlineQueueCount} punch{offlineQueueCount > 1 ? 'es' : ''} queued offline
              </div>
            )}

            {/* work mode selector — only before first clock-in */}
            {!todayStatus?.check_in && (
              <div className="atd-workmode">
                <button
                  className={`atd-workmode-btn${workMode === 'office' ? ' atd-workmode-active' : ''}`}
                  onClick={() => setWorkMode('office')}
                >
                  Office
                </button>
                <button
                  className={`atd-workmode-btn${workMode === 'wfh' ? ' atd-workmode-active' : ''}`}
                  onClick={() => setWorkMode('wfh')}
                >
                  <MapPin size={12} /> WFH
                </button>
              </div>
            )}

            {/* selfie capture — optional, only before clock-in */}
            {!todayStatus?.check_in && (
              <div style={{ marginTop: 6 }}>
                {!selfieDataUrl ? (
                  <button
                    onClick={captureSelfie}
                    style={{ background: 'none', border: '1px dashed #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#6b7280', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                    title="Optional: take a selfie for attendance verification"
                  >
                    📷 Take Selfie (optional)
                  </button>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <img src={selfieDataUrl} alt="selfie" style={{ width: 38, height: 38, borderRadius: '50%', objectFit: 'cover', border: '2px solid #10b981' }} />
                    <span style={{ fontSize: 12, color: '#059669' }}>Selfie captured</span>
                    <button onClick={() => setSelfieDataUrl(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: 14 }}>✕</button>
                  </div>
                )}
                <video ref={videoRef} style={{ display: 'none' }} autoPlay playsInline muted />
                <canvas ref={canvasRef} style={{ display: 'none' }} width={320} height={240} />
              </div>
            )}

            {/* location status indicator */}
            {locationStatus && (
              <div className={`atd-location-badge atd-location-${locationStatus}`}>
                <MapPin size={11} />
                {locationStatus === 'acquiring' && 'Getting location…'}
                {locationStatus === 'acquired' && locationData &&
                  `${locationData.lat.toFixed(4)}, ${locationData.lng.toFixed(4)} (±${locationData.accuracy}m)`}
                {locationStatus === 'denied' && 'Location unavailable — clocked in without GPS'}
              </div>
            )}

            {/* clock button */}
            {!todayStatus?.check_in ? (
              <button
                className="atd-clock-btn atd-clock-btn-in"
                onClick={() => (user?.employee_id ? setFaceOpen(true) : handleClockAction())}
                disabled={clocking}
              >
                <LogIn size={16} />
                {clocking ? 'Getting location…' : `Clock In${workMode === 'wfh' ? ' (WFH)' : ''}`}
              </button>
            ) : !todayStatus?.check_out ? (
              <button
                className="atd-clock-btn atd-clock-btn-out"
                onClick={() => handleClockAction()}
                disabled={clocking}
              >
                <LogOut size={16} />
                {clocking ? 'Processing…' : 'Clock Out'}
              </button>
            ) : (
              <button
                className="atd-clock-btn"
                style={{ background: '#f3f4f6', color: '#9ca3af', cursor: 'default' }}
                disabled
              >
                <CheckCircle size={16} />
                Day Complete
              </button>
            )}

            {/* face-verified clock-in */}
            {faceOpen && user?.employee_id && (
              <FaceClockModal
                employeeId={user.employee_id}
                action="in"
                onVerified={(fd) => { setFaceOpen(false); handleClockAction(fd); }}
                onClose={() => setFaceOpen(false)}
              />
            )}

            {/* ─── Break tracking ─── */}
            {todayStatus?.check_in && !todayStatus?.check_out && (
              <div style={{ marginTop: 12, borderTop: '1px solid #f0f0f4', paddingTop: 12 }}>
                {activeBreak ? (
                  <button
                    onClick={handleEndBreak}
                    disabled={breakLoading}
                    style={{ width: '100%', padding: '9px 0', borderRadius: 8, border: '1px solid #f59e0b', background: '#fffbeb', color: '#92400e', fontWeight: 700, fontSize: 13, cursor: breakLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  >
                    <Coffee size={14} />
                    {breakLoading ? 'Ending break…' : 'End Break'}
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select
                      value={breakType}
                      onChange={e => setBreakType(e.target.value)}
                      style={{ flex: 1, border: '1px solid #e9e4ff', borderRadius: 8, padding: '8px 10px', fontSize: 12, outline: 'none', fontFamily: 'Inter, sans-serif' }}
                    >
                      <option value="lunch">Lunch</option>
                      <option value="tea">Tea</option>
                      <option value="personal">Personal</option>
                    </select>
                    <button
                      onClick={handleStartBreak}
                      disabled={breakLoading}
                      style={{ flex: 2, padding: '8px 0', borderRadius: 8, border: '1px solid #e9e4ff', background: '#f5f3ff', color: '#6B3FDB', fontWeight: 700, fontSize: 13, cursor: breakLoading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    >
                      <Coffee size={14} />
                      {breakLoading ? 'Starting…' : 'Start Break'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ─── Today's break log ─── */}
            {breaks.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Today&apos;s Breaks</div>
                {breaks.map((b, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#374151', padding: '4px 0', borderBottom: i < breaks.length - 1 ? '1px solid #f5f5f7' : 'none' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Coffee size={11} color="#9ca3af" />
                      {(b.break_type || 'break').charAt(0).toUpperCase() + (b.break_type || 'break').slice(1)}
                      {b.is_active && <span style={{ background: '#fef3c7', color: '#92400e', borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>Active</span>}
                    </span>
                    <span style={{ color: '#6b7280' }}>
                      {fmtBreakTime(b.break_start)}
                      {' → '}
                      {b.is_active ? '…' : fmtBreakTime(b.break_end)}
                      {!b.is_active && b.duration_minutes != null && ` (${b.duration_minutes}m)`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Monthly summary */}
        <div className="atd-card">
          <div className="atd-card-hd">
            <span className="atd-card-title">
              Monthly Summary — {MONTH_NAMES[currentDate.getMonth()]} {currentDate.getFullYear()}
            </span>
            <Calendar size={16} color="#9ca3af" />
          </div>
          <div className="atd-card-body">
            {/* streak banner */}
            {streak > 0 && (
              <div className="atd-streak">
                <Trophy size={15} color="#f59e0b" />
                <span>
                  {streak}-day attendance streak
                  {streak >= 14 && ' — outstanding!'}
                  {streak >= 7 && streak < 14 && ' — keep it up!'}
                </span>
              </div>
            )}

            {monthlySummary ? (
              <div className="atd-summary-grid">
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#dcfce7' }}>
                    <CheckCircle size={17} color="#10b981" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.present ?? 0}</div>
                    <div className="atd-stat-lbl">Present</div>
                  </div>
                </div>
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#fee2e2' }}>
                    <AlertCircle size={17} color="#ef4444" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.absent ?? 0}</div>
                    <div className="atd-stat-lbl">Absent</div>
                  </div>
                </div>
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#fef3c7' }}>
                    <Clock size={17} color="#f59e0b" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.late ?? 0}</div>
                    <div className="atd-stat-lbl">Late</div>
                  </div>
                </div>
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#dbeafe' }}>
                    <Calendar size={17} color="#3b82f6" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.leave ?? 0}</div>
                    <div className="atd-stat-lbl">On Leave</div>
                  </div>
                </div>
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#ede9fe' }}>
                    <X size={17} color="#8b5cf6" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.holidays ?? 0}</div>
                    <div className="atd-stat-lbl">Holidays</div>
                  </div>
                </div>
                <div className="atd-stat-pill">
                  <div className="atd-stat-icon" style={{ background: '#ecfdf5' }}>
                    <CheckCircle size={17} color="#059669" />
                  </div>
                  <div>
                    <div className="atd-stat-val">{monthlySummary.percentage ?? 0}%</div>
                    <div className="atd-stat-lbl">Attendance %</div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ color: '#9ca3af', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                Loading summary…
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Monthly Calendar ── */}
      <div className="atd-cal-card">
        <div className="atd-card-hd">
          <span className="atd-card-title">Monthly Calendar</span>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            Click a past date to request regularization
          </span>
        </div>

        <div className="atd-cal-header">
          {DAY_NAMES.map((d) => (
            <div key={d} className="atd-cal-day-header">{d}</div>
          ))}
        </div>

        <div className="atd-cal-grid">
          {calCells.map((cell, idx) => {
            if (!cell) {
              return <div key={`empty-${idx}`} className="atd-cal-day atd-cal-empty" />;
            }
            const { day, ymd, status, isToday, holidayName } = cell;
            const colors             = STATUS_COLORS[status] || STATUS_COLORS.future;
            const isPast             = ymd <= toYMD(new Date()) && status !== 'future';
            const isWeekendOrHoliday = status === 'weekend' || status === 'holiday' || status === 'future';

            return (
              <div
                key={ymd}
                className={`atd-cal-day${isToday ? ' atd-cal-today' : ''}`}
                style={{ background: colors.bg, color: colors.text }}
                onClick={() => { if (isPast && !isWeekendOrHoliday) openRegDrawer(ymd); }}
                title={holidayName || (isPast && !isWeekendOrHoliday ? `Regularize ${ymd}` : undefined)}
              >
                <span style={{ fontWeight: isToday ? 700 : 500 }}>{day}</span>
                {status !== 'future' && (
                  <span
                    style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: colors.dot, marginTop: 2,
                      display: 'inline-block',
                    }}
                  />
                )}
                {holidayName && (
                  <span className="atd-cal-holiday-label" title={holidayName}>
                    {holidayName.length > 6 ? holidayName.slice(0, 5) + '…' : holidayName}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="atd-cal-legend">
          {Object.entries(STATUS_COLORS)
            .filter(([k]) => k !== 'future')
            .map(([key, val]) => (
              <div key={key} className="atd-legend-item">
                <span className="atd-legend-dot" style={{ background: val.dot }} />
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </div>
            ))}
        </div>
      </div>

      {/* ── Last 7 Days ── */}
      <div className="atd-card" style={{ marginBottom: 12 }}>
        <div className="atd-card-hd">
          <span className="atd-card-title">Last 7 Days</span>
        </div>
        <div className="atd-card-body">
          <div className="atd-7days">
            {last7Days.map((item) => {
              const d      = new Date(item.date + 'T00:00:00');
              const colors = STATUS_COLORS[item.status] || STATUS_COLORS.future;
              return (
                <div
                  key={item.date}
                  className="atd-day-card"
                  onClick={() => {
                    const skip = item.status === 'weekend' || item.status === 'holiday';
                    if (!skip) openRegDrawer(item.date);
                  }}
                >
                  <div className="atd-day-name">{DAY_NAMES[d.getDay()]}</div>
                  <div className="atd-day-num">{d.getDate()}</div>
                  <span
                    className="atd-day-badge"
                    style={{ background: colors.bg, color: colors.text }}
                  >
                    {item.status.charAt(0).toUpperCase() + item.status.slice(1)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── My Regularization Requests ── */}
      {regRequests.length > 0 && (
        <div className="atd-card" style={{ marginBottom: 12 }}>
          <div className="atd-card-hd">
            <span className="atd-card-title">My Regularization Requests</span>
            <FileEdit size={16} color="#9ca3af" />
          </div>
          <div className="atd-card-body" style={{ padding: '10px 15px' }}>
            <div className="atd-reg-list" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {regRequests.map((req) => {
                const sc = REG_STATUS_COLORS[req.status] || REG_STATUS_COLORS.pending;
                return (
                  <div key={req.id} className="atd-reg-item">
                    <div className="atd-reg-meta">
                      <span className="atd-reg-date">{req.date}</span>
                      {(req.check_in || req.check_out) && (
                        <span className="atd-reg-times">
                          {req.check_in && `In: ${req.check_in}`}
                          {req.check_in && req.check_out && ' · '}
                          {req.check_out && `Out: ${req.check_out}`}
                        </span>
                      )}
                    </div>
                    <p className="atd-reg-reason">{req.reason}</p>
                    <span
                      className="atd-reg-status"
                      style={{ background: sc.bg, color: sc.text }}
                    >
                      {req.status.charAt(0).toUpperCase() + req.status.slice(1)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Regularization Drawer ── */}
      {showRegForm && (
        <>
          <div className="atd-overlay" onClick={() => setShowRegForm(false)} />
          <div className="atd-drawer">
            <div className="atd-drawer-hd">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <FileEdit size={18} color="#6366f1" />
                <span style={{ fontWeight: 600, fontSize: 15, color: '#111827' }}>
                  Regularization Request
                </span>
              </div>
              <button className="atd-icon-btn" onClick={() => setShowRegForm(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="atd-drawer-body">
              <form id="reg-form" onSubmit={handleRegSubmit}>
                <div className="atd-form-group">
                  <label className="atd-label">Date</label>
                  <input
                    className="atd-input"
                    type="date"
                    value={regForm.date}
                    readOnly
                    style={{ background: '#f9fafb', color: '#6b7280', cursor: 'default' }}
                  />
                </div>

                <div className="atd-form-group">
                  <label className="atd-label">Check In Time</label>
                  <input
                    className="atd-input"
                    type="time"
                    value={regForm.check_in}
                    onChange={(e) => setRegForm({ ...regForm, check_in: e.target.value })}
                    placeholder="HH:MM"
                  />
                </div>

                <div className="atd-form-group">
                  <label className="atd-label">Check Out Time</label>
                  <input
                    className="atd-input"
                    type="time"
                    value={regForm.check_out}
                    onChange={(e) => setRegForm({ ...regForm, check_out: e.target.value })}
                    placeholder="HH:MM"
                  />
                </div>

                <div className="atd-form-group">
                  <label className="atd-label">
                    Reason <span style={{ color: '#ef4444' }}>*</span>
                  </label>
                  <textarea
                    className="atd-textarea"
                    rows={4}
                    value={regForm.reason}
                    onChange={(e) => setRegForm({ ...regForm, reason: e.target.value })}
                    placeholder="Explain why you need to regularize attendance for this date…"
                    required
                  />
                </div>

                <div
                  style={{
                    background: '#fffbeb', border: '1px solid #fde68a',
                    borderRadius: 8, padding: '10px 14px',
                    fontSize: 12, color: '#92400e', display: 'flex', gap: 8, alignItems: 'flex-start',
                  }}
                >
                  <AlertCircle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span>
                    Regularization requests are subject to manager approval.
                    You will be notified once reviewed.
                  </span>
                </div>
              </form>
            </div>

            <div className="atd-drawer-footer">
              <button className="atd-btn-ghost" onClick={() => setShowRegForm(false)}>
                Cancel
              </button>
              <button className="atd-btn-primary" type="submit" form="reg-form">
                Submit Request
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default AttendanceDashboard;
