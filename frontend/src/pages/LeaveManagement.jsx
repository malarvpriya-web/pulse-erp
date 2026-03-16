import { useState, useEffect } from "react";
import api from "@/services/api/client";

export default function LeaveManagement() {
  const [leaves, setLeaves] = useState([]);

  useEffect(() => {
    fetchLeaves();
  }, []);

  const fetchLeaves = async () => {
    try {
      const response = await api.get("/leaves");
      setLeaves(response.data);
    } catch (err) {
      console.error("Error fetching leaves:", err);
    }
  };

  const updateStatus = async (id, status) => {
    try {
      await api.put(`/leaves/${id}`, { status });
      fetchLeaves();
    } catch (err) {
      console.error("Error updating status:", err);
    }
  };

  return (
    <div style={{ padding: "30px" }}>
      <h1>Leave Management</h1>
      <div style={{ background: "white", padding: "30px", borderRadius: "12px", marginTop: "20px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: "#f3f4f6" }}>
              <th style={{ padding: "14px", textAlign: "left", fontSize: "18px", fontWeight: "600" }}>Employee</th>
              <th style={{ padding: "14px", textAlign: "left", fontSize: "18px", fontWeight: "600" }}>Leave Type</th>
              <th style={{ padding: "14px", textAlign: "left", fontSize: "18px", fontWeight: "600" }}>From</th>
              <th style={{ padding: "14px", textAlign: "left", fontSize: "18px", fontWeight: "600" }}>To</th>
              <th style={{ padding: "14px", textAlign: "left", fontSize: "18px", fontWeight: "600" }}>Reason</th>
              <th style={{ padding: "14px", textAlign: "left", fontSize: "18px", fontWeight: "600" }}>Status</th>
              <th style={{ padding: "14px", textAlign: "left", fontSize: "18px", fontWeight: "600" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {leaves.map(leave => (
              <tr key={leave.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "14px", fontSize: "18px" }}>
                  {leave.office_id} - {leave.first_name} {leave.last_name}
                </td>
                <td style={{ padding: "14px", fontSize: "18px" }}>{leave.leave_type}</td>
                <td style={{ padding: "14px", fontSize: "18px" }}>{new Date(leave.from_date).toLocaleDateString()}</td>
                <td style={{ padding: "14px", fontSize: "18px" }}>{new Date(leave.to_date).toLocaleDateString()}</td>
                <td style={{ padding: "14px", fontSize: "18px" }}>{leave.reason}</td>
                <td style={{ padding: "14px", fontSize: "18px" }}>
                  <span style={{
                    padding: "5px 10px",
                    borderRadius: "20px",
                    background: leave.status === "Approved" ? "#dcfce7" : leave.status === "Rejected" ? "#fee2e2" : "#fef3c7",
                    color: leave.status === "Approved" ? "#166534" : leave.status === "Rejected" ? "#991b1b" : "#92400e"
                  }}>
                    {leave.status}
                  </span>
                </td>
                <td style={{ padding: "14px", fontSize: "18px" }}>
                  {leave.status === "Pending" && (
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        onClick={() => updateStatus(leave.id, "Approved")}
                        style={{
                          background: "white",
                          color: "black",
                          border: "none",
                          padding: "6px 12px",
                          borderRadius: "8px",
                          fontSize: "18px",
                          cursor: "pointer",
                          transition: "0.2s"
                        }}
                        onMouseEnter={(e) => { e.target.style.background = "#0284c7"; e.target.style.color = "white"; }}
                        onMouseLeave={(e) => { e.target.style.background = "white"; e.target.style.color = "black"; }}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => updateStatus(leave.id, "Rejected")}
                        style={{
                          background: "white",
                          color: "black",
                          border: "none",
                          padding: "6px 12px",
                          borderRadius: "8px",
                          fontSize: "18px",
                          cursor: "pointer",
                          transition: "0.2s"
                        }}
                        onMouseEnter={(e) => { e.target.style.background = "#ef4444"; e.target.style.color = "white"; }}
                        onMouseLeave={(e) => { e.target.style.background = "white"; e.target.style.color = "black"; }}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
