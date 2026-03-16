import { useAuth } from "@/context/AuthContext";
import "./Topbar.css";
import logo from "../assets/logo.png";

export default function Topbar() {
  const { user, role, logout } = useAuth();

  const getUserDisplayName = () => {
    if (!user) return "User";
    if (user.name) return user.name;
    if (user.email) {
      const prefix = user.email.split('@')[0];
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
    return "User";
  };

  return (
    <div className="topbar">
      <div className="brand-center">
        <img src={logo} className="top-logo" alt="Logo" />
        <h1 className="brand-title">Manifest Technologies</h1>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "18px", fontWeight: "600", color: "#111827" }}>
            Welcome back, {getUserDisplayName()}
          </div>
        </div>
        <button className="logout-btn" onClick={logout}>
          Logout
        </button>
      </div>
    </div>
  );
}
