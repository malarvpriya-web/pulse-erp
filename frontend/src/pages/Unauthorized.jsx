export default function Unauthorized({ setPage }) {
  return (
    <div style={{ padding: "40px", textAlign: "center" }}>
      <h1 style={{ fontSize: "32px", color: "#dc2626", marginBottom: "10px" }}>🚫 Access Denied</h1>
      <p style={{ fontSize: "16px", color: "#6b7280", marginBottom: "20px" }}>
        You do not have permission to access this page.
      </p>
      <button 
        onClick={() => setPage && setPage("Home")} 
        style={{ 
          padding: "10px 20px",
          background: "#0284c7",
          color: "white",
          border: "none",
          borderRadius: "6px",
          cursor: "pointer",
          fontSize: "14px"
        }}
      >
        Go to Home
      </button>
    </div>
  );
}
