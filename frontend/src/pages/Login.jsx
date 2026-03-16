import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import logo from "../assets/logo.png";
import "./Login.css";

export default function Login({ setPage }) {
  const { login } = useAuth();
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [error, setError]     = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const user = await login(email, password);

      const roleRedirects = {
        employee:        "Home",
        manager:         "ERPDashboard",
        department_head: "ERPDashboard",
        admin:           "ERPDashboard",
        super_admin:     "ERPDashboard"
      };
      setPage(roleRedirects[user.role] || "Home");
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || "Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <img src={logo} alt="Logo" style={{ width: "150px", marginBottom: "15px" }} />
        <h1>Pulse Login</h1>

        <form onSubmit={handleLogin}>
          <input
            placeholder="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
          />
          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading}
            style={{
              background: loading ? "#9ca3af" : "#b5b5b5",
              color: "white",
              cursor: loading ? "not-allowed" : "pointer",
              padding: "12px",
              border: "none",
              borderRadius: "6px",
              fontSize: "16px",
              fontWeight: "500",
              transition: "background 0.3s"
            }}
            onMouseEnter={(e) => !loading && (e.target.style.background = "#0284c7")}
            onMouseLeave={(e) => !loading && (e.target.style.background = "#b5b5b5")}
          >
            {loading ? "Logging in..." : "Login"}
          </button>
        </form>

        {error && (
          <div style={{
            color: "#ef4444",
            marginTop: "15px",
            padding: "10px",
            background: "#fee2e2",
            borderRadius: "6px",
            fontSize: "14px"
          }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
