import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import api from "@/services/api/client";
import { Eye, EyeOff, Mail, Lock, ArrowLeft, CheckCircle,
         Shield, Zap, BarChart2, Users, TrendingUp,
         CheckSquare, Globe, Activity } from "lucide-react";
import logo from "../assets/logo.png";
import "./Login.css";

// ── Constants ─────────────────────────────────────────────────────────────────
const ROLE_REDIRECTS = {
  super_admin: "/ExecutiveDashboard",
  admin:       "/AdminDashboard",
  manager:     "/AdminDashboard",
  finance:     "/FinanceDashboardNew",
  hr:          "/HRDashboard",
  employee:    "/EmployeeDashboard",
};

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

const ERP_FEATURES = [
  { icon: BarChart2, label: "Real-Time Analytics",    desc: "Live dashboards across all modules" },
  { icon: Shield,    label: "Enterprise Security",    desc: "Role-based access & audit trails"  },
  { icon: Zap,       label: "AI-Powered Insights",    desc: "Anomaly detection & forecasting"   },
  { icon: Globe,     label: "GST & TDS Compliant",    desc: "100% Indian compliance built-in"   },
  { icon: Users,     label: "Multi-Department ERP",   desc: "HR, Finance, CRM, Production"      },
  { icon: Activity,  label: "Workflow Automation",    desc: "Approval chains & smart triggers"  },
];

const STAT_ITEMS = [
  { label: "ERP Modules",      value: "14+"   },
  { label: "Live Integrations",value: "8"     },
  { label: "Uptime SLA",       value: "99.9%" },
  { label: "GST Ready",        value: "✓"     },
];

// ── PKCE helpers ───────────────────────────────────────────────────────────────
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function genVerifier() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}
async function genChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  return b64url(await crypto.subtle.digest("SHA-256", data));
}

// ── Math CAPTCHA ──────────────────────────────────────────────────────────────
function newCaptcha() {
  const a = Math.floor(Math.random() * 9) + 1;
  const b = Math.floor(Math.random() * 9) + 1;
  return { a, b, answer: a + b };
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtCountdown(secs) {
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function pwStrength(pw) {
  if (!pw) return null;
  if (pw.length >= 12 && /[A-Z]/.test(pw) && /[0-9]/.test(pw)) return "strong";
  if (pw.length >= 8) return "medium";
  return "weak";
}

// ── Live Clock ────────────────────────────────────────────────────────────────
function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// ── Left Panel ────────────────────────────────────────────────────────────────
function LeftPanel({ sysHealth }) {
  const now = useClock();
  const timeStr = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

  return (
    <div className="lp-left">
      {/* Decorative blobs */}
      <div className="lp-left-blob lp-left-blob1" />
      <div className="lp-left-blob lp-left-blob2" />

      {/* Brand */}
      <div className="lp-left-brand">
        <div className="lp-left-logo-wrap">
          <img src={logo} alt="Pulse" className="lp-left-logo" />
        </div>
        <div>
          <div className="lp-left-brand-name">Pulse ERP</div>
          <div className="lp-left-brand-sub">Manifest Technologies</div>
        </div>
      </div>

      {/* Live clock */}
      <div className="lp-left-clock">
        <div className="lp-left-time">{timeStr}</div>
        <div className="lp-left-date">{dateStr}</div>
      </div>

      {/* Headline */}
      <div className="lp-left-headline">
        <h1 className="lp-left-h1">Enterprise ERP<br />for ₹1000Cr Scale</h1>
        <p className="lp-left-tagline">
          Integrated. Intelligent. Indian-compliant.
        </p>
      </div>

      {/* Stats strip */}
      <div className="lp-left-stats">
        {STAT_ITEMS.map(s => (
          <div key={s.label} className="lp-left-stat">
            <div className="lp-left-stat-val">{s.value}</div>
            <div className="lp-left-stat-lbl">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Feature list */}
      <div className="lp-left-features">
        {ERP_FEATURES.map(({ icon: Icon, label, desc }) => (
          <div key={label} className="lp-left-feature">
            <div className="lp-left-feature-icon"><Icon size={14} /></div>
            <div className="lp-left-feature-text">
              <span className="lp-left-feature-label">{label}</span>
              <span className="lp-left-feature-desc">{desc}</span>
            </div>
          </div>
        ))}
      </div>

      {/* System status */}
      <div className="lp-left-status">
        <span className={`lp-left-status-dot ${sysHealth.overall === "ok" ? "lp-status-ok" : sysHealth.overall === "checking" ? "lp-status-checking" : "lp-status-warn"}`} />
        <div className="lp-left-status-lines">
          {sysHealth.overall === "checking"
            ? <span className="lp-left-status-text">Checking system…</span>
            : <>
                <span className={`lp-left-status-text lp-left-status-row ${sysHealth.api === "online" ? "lp-status-svc-ok" : "lp-status-svc-err"}`}>
                  API: {sysHealth.api === "online" ? "Online" : "Offline"}
                </span>
                <span className={`lp-left-status-text lp-left-status-row ${sysHealth.db === "connected" ? "lp-status-svc-ok" : sysHealth.db === null ? "lp-status-svc-unk" : "lp-status-svc-err"}`}>
                  DB: {sysHealth.db === "connected" ? "Connected" : sysHealth.db === "failed" ? "Failed" : "—"}
                </span>
                <span className={`lp-left-status-text lp-left-status-row ${sysHealth.api === "online" ? "lp-status-svc-ok" : "lp-status-svc-err"}`}>
                  Auth: {sysHealth.api === "online" ? "Ready" : "Failed"}
                </span>
              </>
          }
        </div>
      </div>
    </div>
  );
}

// =============================================================================
export default function Login() {
  const { login, loginWithToken } = useAuth();
  const navigate = useNavigate();

  // ── View: 'login' | 'forgot-email' | 'forgot-otp' | 'forgot-reset' | 'forgot-done'
  const [view, setView] = useState("login");

  // ── Login form ─────────────────────────────────────────────────────────────
  const [email,    setEmail]    = useState(localStorage.getItem("pulse_remember_email") ?? "");
  const [password, setPassword] = useState("");
  const [showPw,   setShowPw]   = useState(false);
  const [remember, setRemember] = useState(!!localStorage.getItem("pulse_remember_email"));
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState("");

  const emailRef = useRef(null);

  // ── Failed-attempt tracking ────────────────────────────────────────────────
  const [failCount,    setFailCount]    = useState(0);
  const [captcha,      setCaptcha]      = useState(null);
  const [captchaInput, setCaptchaInput] = useState("");
  const [captchaError, setCaptchaError] = useState(false);

  // ── Server-side lockout ────────────────────────────────────────────────────
  const [lockedUntil,   setLockedUntil]   = useState(null);
  const [lockCountdown, setLockCountdown] = useState(0);

  // ── Banners ────────────────────────────────────────────────────────────────
  const [sessionMsg, setSessionMsg] = useState(() => {
    const reason = sessionStorage.getItem("auth_redirect");
    if (reason) sessionStorage.removeItem("auth_redirect");
    return reason === "session_expired"
      ? "Your session has expired. Please sign in again."
      : null;
  });
  const [lastLogin] = useState(() => localStorage.getItem("pulse_last_login"));

  // ── Forgot password ────────────────────────────────────────────────────────
  const [fEmail,   setFEmail]   = useState("");
  const [fOtp,     setFOtp]     = useState("");
  const [fPw,      setFPw]      = useState("");
  const [fShowPw,  setFShowPw]  = useState(false);
  const [fLoading, setFLoading] = useState(false);
  const [fError,   setFError]   = useState("");
  const [devOtp,   setDevOtp]   = useState("");

  // ── Page title ────────────────────────────────────────────────────────────
  useEffect(() => { document.title = "Sign in — Pulse ERP"; }, []);

  // ── System status (health check) ──────────────────────────────────────────
  const [sysHealth, setSysHealth] = useState({ overall: "checking", api: null, db: null });
  useEffect(() => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    api.get("/health", { signal: ctrl.signal })
      .then(({ data }) => {
        clearTimeout(timer);
        setSysHealth({
          overall: data.status === "ok" ? "ok" : "warn",
          api: "online",
          db: data.db?.status === "ok" ? "connected" : "failed",
        });
      })
      .catch(() => {
        clearTimeout(timer);
        setSysHealth({ overall: "warn", api: "offline", db: null });
      });
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, []);

  // ── Lockout countdown ticker ───────────────────────────────────────────────
  useEffect(() => {
    if (!lockedUntil) return;
    const tick = () => {
      const secs = Math.max(0, Math.ceil((new Date(lockedUntil) - Date.now()) / 1000));
      setLockCountdown(secs);
      if (secs === 0) { setLockedUntil(null); setError(""); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  // ── CAPTCHA after 3 failures ───────────────────────────────────────────────
  useEffect(() => {
    if (failCount >= 3 && !captcha) setCaptcha(newCaptcha());
  }, [failCount, captcha]);

  // ── Google OAuth PKCE callback ─────────────────────────────────────────────
  useEffect(() => {
    const params   = new URLSearchParams(window.location.search);
    const code     = params.get("code");
    const verifier = sessionStorage.getItem("pkce_verifier");
    if (!code || !verifier) return;
    window.history.replaceState({}, "", "/login");
    sessionStorage.removeItem("pkce_verifier");

    setError("");
    api.post("/auth/google", {
      code,
      code_verifier: verifier,
      redirect_uri:  `${window.location.origin}/login`,
    })
      .then(async ({ data }) => {
        const user = await loginWithToken(data.token, data.user);
        afterLogin(user, null);
      })
      .catch(err => {
        setError(err.response?.data?.error || "Google sign-in failed.");
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function afterLogin(user, rememberEmail) {
    if (user.last_login) localStorage.setItem("pulse_last_login", user.last_login);
    if (rememberEmail)        localStorage.setItem("pulse_remember_email", rememberEmail);
    else if (rememberEmail === false) localStorage.removeItem("pulse_remember_email");
    navigate(ROLE_REDIRECTS[user?.role] || "/", { replace: true });
  }

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    // Client-side email format guard (supplements HTML5 type="email" validation)
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Please enter a valid email address.");
      emailRef.current?.focus();
      return;
    }
    if (captcha) {
      if (parseInt(captchaInput, 10) !== captcha.answer) {
        setCaptchaError(true);
        setCaptcha(newCaptcha());
        setCaptchaInput("");
        return;
      }
      setCaptchaError(false);
    }
    setLoading(true);

    try {
      const user = await login(email, password, remember);
      afterLogin(user, remember ? email : false);
    } catch (err) {
      const status = err.response?.status ?? err.status;
      const data   = err.response?.data   ?? {};
      if (status === 423 || data.code === "ACCOUNT_LOCKED") {
        setLockedUntil(data.locked_until ? new Date(data.locked_until) : new Date(Date.now() + 15 * 60 * 1000));
        setError(data.error || "Account locked. Too many failed attempts.");
        setCaptcha(null); setCaptchaInput(""); setFailCount(0);
      } else {
        const next = failCount + 1;
        setFailCount(next);
        if (next >= 3) { setCaptcha(newCaptcha()); setCaptchaInput(""); }
        if (!err.response && !err.status) {
          const isTimeout = err.code === 'ECONNABORTED' || err.name === 'AbortError' || err.name === 'CanceledError';
          setError(isTimeout ? "Request timed out — the server may be overloaded." : "API server is offline — start the backend and try again.");
        } else if (status >= 500)         setError(`Server error (${status}) — please try again in a moment.`);
        else                              setError(data.error || "Invalid email or password.");
        emailRef.current?.focus();
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    if (!GOOGLE_CLIENT_ID) {
      setError("Google SSO is not configured on this server. Contact your administrator.");
      return;
    }
    const verifier  = genVerifier();
    const challenge = await genChallenge(verifier);
    sessionStorage.setItem("pkce_verifier", verifier);
    const params = new URLSearchParams({
      client_id:             GOOGLE_CLIENT_ID,
      redirect_uri:          `${window.location.origin}/login`,
      response_type:         "code",
      scope:                 "openid email profile",
      code_challenge:        challenge,
      code_challenge_method: "S256",
      state:                 crypto.randomUUID(),
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  };

  const handleForgotEmail = async (e) => {
    e?.preventDefault();
    setFError("");
    setFLoading(true);
    try {
      const { data } = await api.post("/auth/forgot-password", { email: fEmail });
      if (data.dev_otp) setDevOtp(data.dev_otp);
      setView("forgot-otp");
    } catch (err) {
      setFError(err.response?.data?.error || "Failed to send OTP. Try again.");
    } finally {
      setFLoading(false);
    }
  };

  const handleForgotOtp = async (e) => {
    e.preventDefault();
    setFError("");
    setFLoading(true);
    try {
      await api.post("/auth/verify-otp", { email: fEmail, otp: fOtp });
      setView("forgot-reset");
    } catch (err) {
      setFError(err.response?.data?.error || "Invalid or expired OTP.");
    } finally {
      setFLoading(false);
    }
  };

  const handleForgotReset = async (e) => {
    e.preventDefault();
    if (fPw.length < 8) { setFError("Password must be at least 8 characters."); return; }
    setFError("");
    setFLoading(true);
    try {
      await api.post("/auth/reset-password", { email: fEmail, otp: fOtp, password: fPw });
      setView("forgot-done");
    } catch (err) {
      setFError(err.response?.data?.error || "Failed to reset password. Try again.");
    } finally {
      setFLoading(false);
    }
  };

  const strength = pwStrength(fPw);

  return (
    <div className="lp-root">
      {/* Left branding panel */}
      <LeftPanel sysHealth={sysHealth} />

      {/* Right form panel */}
      <div className="lp-right">
        <div className="lp-card">

          {/* Top strip */}
          <div className="lp-top-strip">
            <div className="lp-logo-wrap"><img src={logo} alt="Pulse" className="lp-logo" /></div>
            <h2 className="lp-strip-title">Pulse ERP</h2>
            <p className="lp-strip-sub">Manifest Technologies</p>
          </div>

          {/* Session-expiry banner */}
          {sessionMsg && (
            <div className="lp-session-banner">
              <span>{sessionMsg}</span>
              <button type="button" aria-label="Dismiss" onClick={() => setSessionMsg(null)}>×</button>
            </div>
          )}

          {/* Body */}
          <div className="lp-body">

            {/* ══ LOGIN ══ */}
            {view === "login" && (
              <form className="lp-form" onSubmit={handleLogin}>

                {lastLogin && (
                  <div className="lp-last-login">Last sign-in: {fmtDate(lastLogin)}</div>
                )}

                {lockedUntil && (
                  <div className="lp-lockout-banner">
                    Account locked — try again in <strong>{fmtCountdown(lockCountdown)}</strong>
                  </div>
                )}

                <div className="lp-field">
                  <label className="lp-label" htmlFor="login-email">Email / Manifest ID</label>
                  <div className="lp-input-wrap">
                    <Mail size={14} className="lp-input-icon" />
                    <input
                      id="login-email" ref={emailRef}
                      className="lp-input" type="email" placeholder="you@manifest.com"
                      value={email} onChange={e => setEmail(e.target.value)}
                      required disabled={loading || !!lockedUntil} autoComplete="email"
                    />
                  </div>
                </div>

                <div className="lp-field">
                  <div className="lp-label-row">
                    <label className="lp-label" htmlFor="login-password">Password</label>
                    <button type="button" className="lp-forgot-link"
                      onClick={() => { setView("forgot-email"); setFEmail(email); setFError(""); }}>
                      Forgot password?
                    </button>
                  </div>
                  <div className="lp-input-wrap">
                    <Lock size={14} className="lp-input-icon" />
                    <input
                      id="login-password"
                      className="lp-input" type={showPw ? "text" : "password"} placeholder="••••••••"
                      value={password} onChange={e => setPassword(e.target.value)}
                      required disabled={loading || !!lockedUntil} autoComplete="current-password"
                    />
                    <button type="button" className="lp-pw-toggle" onClick={() => setShowPw(v => !v)} tabIndex={-1}>
                      {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>

                <div className="lp-remember-row">
                  <label className="lp-remember-label">
                    <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} className="lp-remember-check" />
                    Keep me signed in
                  </label>
                </div>

                {captcha && !lockedUntil && (
                  <div className="lp-captcha-box">
                    <label className="lp-captcha-label" htmlFor="login-captcha">Security check: What is {captcha.a} + {captcha.b}?</label>
                    <input
                      id="login-captcha"
                      className={`lp-captcha-input${captchaError ? " lp-captcha-err-input" : ""}`}
                      type="number" min="0" max="99" placeholder="Answer"
                      value={captchaInput}
                      onChange={e => { setCaptchaInput(e.target.value); setCaptchaError(false); }}
                      required disabled={loading}
                    />
                    {captchaError && <span className="lp-captcha-err">Incorrect — try the new question above.</span>}
                  </div>
                )}

                {error && !lockedUntil && <div className="lp-error" role="alert">{error}</div>}

                <button type="submit" className="lp-submit" disabled={loading || !!lockedUntil}>
                  {loading && <span className="lp-spinner" />}
                  {loading ? "Signing in…" : "Sign in"}
                </button>

                <div className="lp-or-divider"><span>or</span></div>

                <button type="button" className="lp-google-btn" onClick={handleGoogleLogin} disabled={loading}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  Continue with Google
                </button>

                {/* Security trust badges */}
                <div className="lp-trust-row">
                  <span className="lp-trust-badge"><Shield size={10} /> TLS Encrypted</span>
                  <span className="lp-trust-badge"><CheckSquare size={10} /> ISO 27001</span>
                  <span className="lp-trust-badge"><TrendingUp size={10} /> 99.9% Uptime</span>
                </div>

              </form>
            )}

            {/* ══ FORGOT — STEP 1 ══ */}
            {view === "forgot-email" && (
              <div className="lp-forgot-view">
                <button className="lp-back-btn" type="button" onClick={() => setView("login")}>
                  <ArrowLeft size={13} /> Back to sign in
                </button>
                <h3 className="lp-forgot-title">Reset your password</h3>
                <p className="lp-forgot-sub">Enter your account email. We'll send a 6-digit OTP valid for 10 minutes.</p>
                <form className="lp-form" onSubmit={handleForgotEmail}>
                  <div className="lp-field">
                    <label className="lp-label" htmlFor="forgot-email">Email address</label>
                    <div className="lp-input-wrap">
                      <Mail size={14} className="lp-input-icon" />
                      <input
                        id="forgot-email"
                        className="lp-input" type="email" placeholder="you@manifest.com"
                        value={fEmail} onChange={e => setFEmail(e.target.value)}
                        required disabled={fLoading} autoComplete="email"
                      />
                    </div>
                  </div>
                  {fError && <div className="lp-error" role="alert">{fError}</div>}
                  <button type="submit" className="lp-submit" disabled={fLoading}>
                    {fLoading && <span className="lp-spinner" />}
                    {fLoading ? "Sending…" : "Send OTP"}
                  </button>
                </form>
              </div>
            )}

            {/* ══ FORGOT — STEP 2 ══ */}
            {view === "forgot-otp" && (
              <div className="lp-forgot-view">
                <button className="lp-back-btn" type="button"
                  onClick={() => { setView("forgot-email"); setFError(""); setFOtp(""); }}>
                  <ArrowLeft size={13} /> Change email
                </button>
                <h3 className="lp-forgot-title">Enter the OTP</h3>
                <p className="lp-forgot-sub">
                  A 6-digit code was sent to <strong>{fEmail}</strong>.
                  {devOtp && <span className="lp-dev-otp"> [DEV: {devOtp}]</span>}
                </p>
                <form className="lp-form" onSubmit={handleForgotOtp}>
                  <div className="lp-field">
                    <label className="lp-label" htmlFor="forgot-otp">6-digit code</label>
                    <input
                      id="forgot-otp"
                      className="lp-otp-input" type="text" inputMode="numeric"
                      pattern="[0-9]{6}" maxLength={6} placeholder="— — — — — —"
                      value={fOtp} onChange={e => setFOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      required disabled={fLoading} autoComplete="one-time-code"
                    />
                  </div>
                  {fError && <div className="lp-error" role="alert">{fError}</div>}
                  <button type="submit" className="lp-submit" disabled={fLoading || fOtp.length !== 6}>
                    {fLoading && <span className="lp-spinner" />}
                    {fLoading ? "Verifying…" : "Verify OTP"}
                  </button>
                  <button type="button" className="lp-resend-link" disabled={fLoading}
                    onClick={() => { setFOtp(""); setFError(""); handleForgotEmail(null); }}>
                    Resend OTP
                  </button>
                </form>
              </div>
            )}

            {/* ══ FORGOT — STEP 3 ══ */}
            {view === "forgot-reset" && (
              <div className="lp-forgot-view">
                <h3 className="lp-forgot-title">Set new password</h3>
                <p className="lp-forgot-sub">Choose a strong password — at least 8 characters.</p>
                <form className="lp-form" onSubmit={handleForgotReset}>
                  <div className="lp-field">
                    <label className="lp-label" htmlFor="forgot-new-password">New password</label>
                    <div className="lp-input-wrap">
                      <Lock size={14} className="lp-input-icon" />
                      <input
                        id="forgot-new-password"
                        className="lp-input" type={fShowPw ? "text" : "password"} placeholder="Min. 8 characters"
                        value={fPw} onChange={e => setFPw(e.target.value)}
                        required minLength={8} disabled={fLoading} autoComplete="new-password"
                      />
                      <button type="button" className="lp-pw-toggle" onClick={() => setFShowPw(v => !v)} tabIndex={-1}>
                        {fShowPw ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    {fPw && (
                      <div className="lp-pw-strength">
                        <div className={`lp-pw-bar lp-pw-${strength}`} />
                        <span className={`lp-pw-label-${strength}`}>
                          {strength === "strong" ? "Strong" : strength === "medium" ? "Medium" : "Weak"}
                        </span>
                      </div>
                    )}
                  </div>
                  {fError && <div className="lp-error" role="alert">{fError}</div>}
                  <button type="submit" className="lp-submit" disabled={fLoading}>
                    {fLoading && <span className="lp-spinner" />}
                    {fLoading ? "Resetting…" : "Reset password"}
                  </button>
                </form>
              </div>
            )}

            {/* ══ FORGOT — DONE ══ */}
            {view === "forgot-done" && (
              <div className="lp-forgot-view lp-forgot-done">
                <CheckCircle size={40} className="lp-done-icon" />
                <h3 className="lp-forgot-title">Password reset!</h3>
                <p className="lp-forgot-sub">Your password has been updated. Sign in with your new credentials.</p>
                <button type="button" className="lp-submit" style={{ marginTop: 8 }}
                  onClick={() => { setView("login"); setPassword(""); setError(""); }}>
                  Back to sign in
                </button>
              </div>
            )}

          </div>

          <p className="lp-footer">© {new Date().getFullYear()} Manifest Technologies. All rights reserved.</p>
        </div>
      </div>
    </div>
  );
}
