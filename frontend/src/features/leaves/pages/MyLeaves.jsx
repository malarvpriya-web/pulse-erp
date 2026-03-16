import { useState, useEffect } from "react";
import api from "@/services/api/client";
import { formatDate } from "@/utils/dateFormatter";
import "../../employees/pages/EmployeesData.css";

export default function MyLeaves() {
  const [leaves, setLeaves] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMyLeaves();
  }, []);

  const fetchMyLeaves = async () => {
    try {
      setLoading(true);
      const response = await api.get("/leaves/my");
      setLeaves(response.data || []);
    } catch (err) {
      console.error("Error fetching leaves:", err);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status) => {
    const styles = {
      pending: { background: "#fed7aa", color: "#9a3412", padding: "4px 12px", borderRadius: "12px", fontSize: "12px", fontWeight: "600" },
      approved: { background: "#bbf7d0", color: "#166534", padding: "4px 12px", borderRadius: "12px", fontSize: "12px", fontWeight: "600" },
      rejected: { background: "#fecaca", color: "#991b1b", padding: "4px 12px", borderRadius: "12px", fontSize: "12px", fontWeight: "600" }
    };
    return <span style={styles[status]}>{status.toUpperCase()}</span>;
  };

  if (loading) {
    return (
      <div className="employees-page">
        <h1>My Leaves</h1>
        <div style={{ textAlign: "center", padding: "50px" }}>Loading...</div>
      </div>
    );
  }

  return (
    <div className="employees-page">
      <h1 style={{ marginBottom: "20px" }}>My Leave Applications</h1>

      <div className="widget">
        {leaves.length === 0 ? (
          <div style={{ textAlign: "center", padding: "50px", color: "#9ca3af" }}>
            📭 No leave applications found
          </div>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th>Leave Type</th>
                <th>Start Date</th>
                <th>End Date</th>
                <th>Days</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Manager Comment</th>
                <th>Applied On</th>
              </tr>
            </thead>
            <tbody>
              {leaves.map((leave) => (
                <tr key={leave.id}>
                  <td>{leave.leave_type}</td>
                  <td>{formatDate(leave.start_date)}</td>
                  <td>{formatDate(leave.end_date)}</td>
                  <td>{leave.days}</td>
                  <td style={{ maxWidth: "200px" }}>{leave.reason}</td>
                  <td>{getStatusBadge(leave.status)}</td>
                  <td style={{ maxWidth: "200px" }}>{leave.manager_comment || "-"}</td>
                  <td>{formatDate(leave.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
