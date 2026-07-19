import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import api from "@/services/api/client";
import { Lock, Eye, EyeOff, ShieldCheck, LogOut } from "lucide-react";
import logo from "../assets/logo.png";

// Where each role lands once the forced change is complete.
const ROLE_REDIRECTS = {
  super_admin: "/ExecutiveDashboard",
  admin:       "/AdminDashboard",
  manager:     "/AdminDashboard",
  finance:     "/FinanceDashboardNew",
  hr:          "/HRDashboard",
  employee:    "/EmployeeDashboard",
};

function pwStrength(pw) {
  if (!pw) return null;
  if (pw.length >= 12 && /[A-Z]/.test(pw) && /[0-9]/.test(pw)) return "strong";
  if (pw.length >= 8) return "medium";
  return "weak";
}

export default function ForcePasswordChange() {
  const { user, updateUser, logout } = useAuth();
  const navigate = useNavigate();

  const [next,    setNext]    = useState("");
  const [confirm, setConfirm] = useState("");
  const [show,    setShow]    = useState(false);
  const [error,   setError]   = useState("");
  const [saving,  setSaving]  = useState(false);

  useEffect(() => { document.title = "Set your password — Pulse ERP"; }, []);

  const strength = pwStrength(next);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!next || !confirm) return setError("Please enter and confirm your new password.");
    if (next.length < 8)   return setError("New password must be at least 8 characters.");
    if (next !== confirm)  return setError("New passwords do not match.");

    setSaving(true);
    try {
      // Dedicated first-login endpoint — no temporary password needed; the server
      // only allows it while must_change_password is set for this account.
      await api.post("/auth/set-initial-password", { new_password: next });
      // Clear the gate locally so the app unlocks immediately.
      updateUser({ must_change_password: false });
      navigate(ROLE_REDIRECTS[user?.role] || "/", { replace: true });
    } catch (err) {
      setError(err.response?.data?.error || "Failed to set password. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const card = {
    width: "100%", maxWidth: 420, background: "#fff", borderRadius: 16,
    boxShadow: "0 10px 40px rgba(0,0,0,.12)", padding: "32px 28px",
    border: "1px solid #eef0f4",
  };
  const label = { display: "block", fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 6 };
  const wrap  = { position: "relative", marginBottom: 14 };
  const input = {
    width: "100%", height: 42, borderRadius: 9, border: "1px solid #d1d5db",
    padding: "0 38px 0 36px", fontSize: 14, outline: "none", boxSizing: "border-box",
    fontFamily: "inherit",
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(135deg,#f5f3ff 0%,#eef2ff 100%)", padding: 20,
    }}>
      <div style={card}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 20 }}>
          <img src={logo} alt="Pulse" style={{ height: 40, marginBottom: 12 }} />
          <div style={{
            display: "flex", alignItems: "center", gap: 8, color: "#6d28d9",
            fontSize: 13, fontWeight: 600,
          }}>
            <ShieldCheck size={16} /> Set your own password
          </div>
          <p style={{ margin: "8px 0 0", fontSize: 13, color: "#6b7280", textAlign: "center", lineHeight: 1.5 }}>
            {user?.name ? <>Welcome, <strong>{user.name}</strong>. </> : null}
            For your security, please replace the temporary password before continuing.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={wrap}>
            <label style={label} htmlFor="fpc-next">New password</label>
            <Lock size={14} style={{ position: "absolute", left: 12, top: 34, color: "#9ca3af" }} />
            <input
              id="fpc-next" style={input} type={show ? "text" : "password"}
              placeholder="Min. 8 characters"
              value={next} onChange={e => setNext(e.target.value)}
              disabled={saving} minLength={8} autoComplete="new-password"
            />
            <button type="button" onClick={() => setShow(v => !v)} tabIndex={-1}
              style={{ position: "absolute", right: 10, top: 32, background: "none", border: "none", cursor: "pointer", color: "#9ca3af" }}>
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            {next && (
              <div style={{ marginTop: 6, fontSize: 11, fontWeight: 600, color:
                strength === "strong" ? "#16a34a" : strength === "medium" ? "#d97706" : "#dc2626" }}>
                {strength === "strong" ? "Strong password" : strength === "medium" ? "Medium strength" : "Weak — add length, a capital and a number"}
              </div>
            )}
          </div>

          <div style={wrap}>
            <label style={label} htmlFor="fpc-confirm">Confirm new password</label>
            <Lock size={14} style={{ position: "absolute", left: 12, top: 34, color: "#9ca3af" }} />
            <input
              id="fpc-confirm" style={input} type={show ? "text" : "password"}
              placeholder="Re-enter new password"
              value={confirm} onChange={e => setConfirm(e.target.value)}
              disabled={saving} autoComplete="new-password"
            />
          </div>

          {error && (
            <div role="alert" style={{
              background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626",
              borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginBottom: 12,
            }}>{error}</div>
          )}

          <button type="submit" disabled={saving} style={{
            width: "100%", height: 44, borderRadius: 10, border: "none",
            background: saving ? "#a78bfa" : "#7c3aed", color: "#fff",
            fontSize: 14.5, fontWeight: 600, cursor: saving ? "default" : "pointer",
            fontFamily: "inherit",
          }}>
            {saving ? "Saving…" : "Set password & continue"}
          </button>
        </form>

        <button type="button" onClick={logout} style={{
          marginTop: 14, width: "100%", background: "none", border: "none",
          color: "#6b7280", fontSize: 12.5, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          fontFamily: "inherit",
        }}>
          <LogOut size={13} /> Sign out
        </button>
      </div>
    </div>
  );
}
