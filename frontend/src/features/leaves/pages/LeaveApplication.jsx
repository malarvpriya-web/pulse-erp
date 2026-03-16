import { useState, useEffect } from "react";
import api from "@/services/api/client";

export default function LeaveApplication() {
  const [employees, setEmployees] = useState([]);
  const [formData, setFormData] = useState({
    employee_id: "",
    leave_type: "Sick Leave",
    from_date: "",
    to_date: "",
    reason: "",
    file: null
  });
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    try {
      const response = await api.get("/employees");
      setEmployees(response.data.filter(e => e.status !== "Left"));
    } catch (err) {
      console.error("Error fetching employees:", err);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      const formDataToSend = new FormData();
      formDataToSend.append("employee_id", formData.employee_id);
      formDataToSend.append("leave_type", formData.leave_type);
      formDataToSend.append("from_date", formData.from_date);
      formDataToSend.append("to_date", formData.to_date);
      formDataToSend.append("reason", formData.reason);
      if (formData.file) {
        formDataToSend.append("file", formData.file);
      }

      const response = await api.post("/leaves", {
        employee_id: formData.employee_id,
        leave_type: formData.leave_type,
        from_date: formData.from_date,
        to_date: formData.to_date,
        reason: formData.reason,
        file_path: formData.file ? `/uploads/${Date.now()}_${formData.file.name}` : null
      });

      setMessage("Leave application submitted successfully!");
      setFormData({
        employee_id: "",
        leave_type: "Sick Leave",
        from_date: "",
        to_date: "",
        reason: "",
        file: null
      });
      setTimeout(() => setMessage(""), 3000);
    } catch (err) {
      setMessage("Error: " + err.message);
    }
  };

  return (
    <div style={{ padding: "30px" }}>
      <h1>Leave Application</h1>
      <div style={{ background: "white", padding: "30px", borderRadius: "12px", maxWidth: "600px", marginTop: "20px" }}>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "600" }}>Employee</label>
            <select
              value={formData.employee_id}
              onChange={(e) => setFormData({ ...formData, employee_id: e.target.value })}
              required
              style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "18px" }}
            >
              <option value="">Select Employee</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>
                  {emp.office_id} - {emp.first_name} {emp.last_name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "600" }}>Leave Type</label>
            <select
              value={formData.leave_type}
              onChange={(e) => setFormData({ ...formData, leave_type: e.target.value })}
              style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "18px" }}
            >
              <option>Sick Leave</option>
              <option>Casual Leave</option>
              <option>Earned Leave</option>
              <option>Maternity Leave</option>
              <option>Paternity Leave</option>
            </select>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "20px", marginBottom: "20px" }}>
            <div>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "600" }}>From Date</label>
              <input
                type="date"
                value={formData.from_date}
                onChange={(e) => setFormData({ ...formData, from_date: e.target.value })}
                required
                style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "18px" }}
              />
            </div>
            <div>
              <label style={{ display: "block", marginBottom: "8px", fontWeight: "600" }}>To Date</label>
              <input
                type="date"
                value={formData.to_date}
                onChange={(e) => setFormData({ ...formData, to_date: e.target.value })}
                required
                style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "18px" }}
              />
            </div>
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "600" }}>Reason</label>
            <textarea
              value={formData.reason}
              onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
              required
              rows="4"
              style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "18px" }}
            />
          </div>

          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", marginBottom: "8px", fontWeight: "600" }}>Attach Document (Optional)</label>
            <input
              type="file"
              onChange={(e) => setFormData({ ...formData, file: e.target.files[0] })}
              style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "18px" }}
            />
          </div>

          <button
            type="submit"
            style={{
              background: "white",
              color: "black",
              border: "none",
              padding: "12px 24px",
              borderRadius: "8px",
              fontSize: "18px",
              fontWeight: "600",
              cursor: "pointer",
              transition: "0.2s"
            }}
            onMouseEnter={(e) => { e.target.style.background = "#0284c7"; e.target.style.color = "white"; }}
            onMouseLeave={(e) => { e.target.style.background = "white"; e.target.style.color = "black"; }}
          >
            Submit Leave Application
          </button>
        </form>

        {message && (
          <div style={{ marginTop: "20px", padding: "12px", borderRadius: "8px", background: message.includes("Error") ? "#fee2e2" : "#dcfce7", color: message.includes("Error") ? "#991b1b" : "#166534", textAlign: "center" }}>
            {message}
          </div>
        )}
      </div>
    </div>
  );
}
