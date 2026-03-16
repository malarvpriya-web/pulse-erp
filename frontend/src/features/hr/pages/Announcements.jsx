import { useState, useEffect } from "react";
import api from "@/services/api/client";
import { formatDate } from "@/utils/dateFormatter";
import "@/features/employees/pages/EmployeesData.css";

export default function Announcements() {
  const [announcements, setAnnouncements] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [fromDate, setFromDate] = useState(new Date().toISOString().split('T')[0]);
  const [toDate, setToDate] = useState(new Date().toISOString().split('T')[0]);
  const [targetType, setTargetType] = useState("all");
  const [targetValue, setTargetValue] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    fetchAnnouncements();
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    try {
      const response = await api.get("/employees");
      setEmployees(response.data);
      const depts = [...new Set(response.data.map(e => e.department).filter(Boolean))];
      setDepartments(depts);
    } catch (err) {
      console.error("Error fetching employees:", err);
    }
  };

  const fetchAnnouncements = async () => {
    try {
      const response = await api.get("/announcements");
      setAnnouncements(response.data);
    } catch (err) {
      console.error("Error fetching announcements:", err);
    }
  };

  const handleSave = async () => {
    if (!title || !message || !fromDate || !toDate) {
      alert("Please fill all fields");
      return;
    }

    try {
      const data = {
        title,
        message,
        from_date: fromDate,
        to_date: toDate,
        target_type: targetType,
        target_value: targetType === "all" ? "" : targetValue,
        is_active: isActive
      };

      if (editingId) {
        await api.put(`/announcements/${editingId}`, data);
      } else {
        await api.post("/announcements", data);
      }
      handleClear();
      fetchAnnouncements();
    } catch (err) {
      console.error("Error details:", err.response?.data);
      alert("Error saving announcement: " + (err.response?.data?.message || err.message));
    }
  };

  const handleClear = () => {
    setTitle("");
    setMessage("");
    setFromDate(new Date().toISOString().split('T')[0]);
    setToDate(new Date().toISOString().split('T')[0]);
    setTargetType("all");
    setTargetValue("");
    setIsActive(true);
    setEditingId(null);
    setShowForm(false);
  };

  const handleEdit = (announcement) => {
    setTitle(announcement.title);
    setMessage(announcement.message);
    
    // Parse from_date
    const fromDateTime = new Date(announcement.from_date);
    const fromD = fromDateTime.toISOString().split('T')[0];
    
    // Parse to_date
    const toDateTime = new Date(announcement.to_date);
    const toD = toDateTime.toISOString().split('T')[0];
    
    setFromDate(fromD);
    setToDate(toD);
    setTargetType(announcement.target_type);
    setTargetValue(announcement.target_value || "");
    setIsActive(announcement.is_active);
    setEditingId(announcement.id);
    setShowForm(true);
  };

  const handleDelete = async (id) => {
    if (!confirm("Delete this announcement?")) return;
    try {
      await api.delete(`/announcements/${id}`);
      fetchAnnouncements();
    } catch (err) {
      alert("Error deleting announcement");
    }
  };

  const toggleDisplay = async (id, currentStatus) => {
    try {
      await api.put(`/announcements/${id}/toggle`, { is_active: !currentStatus });
      fetchAnnouncements();
    } catch (err) {
      alert("Error updating announcement");
    }
  };

  return (
    <div className="employees-page">
      <div className="employees-header">
        <h1>Announcements</h1>
        <button className="primary-btn" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Add Announcement"}
        </button>
      </div>

      {showForm && (
        <div className="widget" style={{ marginBottom: "20px", padding: "20px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "15px" }}>
            <input
              className="search-box"
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ width: "100%", fontSize: "14px" }}
            />
            <textarea
              className="search-box"
              placeholder="Message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows="4"
              style={{ width: "100%", resize: "vertical", fontFamily: "inherit", fontSize: "14px" }}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "15px" }}>
              <div>
                <label style={{ fontSize: "14px", fontWeight: "600", marginBottom: "5px", display: "block" }}>From Date</label>
                <input
                  type="date"
                  className="search-box"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  style={{ width: "100%", fontSize: "14px" }}
                />
              </div>
              <div>
                <label style={{ fontSize: "14px", fontWeight: "600", marginBottom: "5px", display: "block" }}>To Date</label>
                <input
                  type="date"
                  className="search-box"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  style={{ width: "100%", fontSize: "14px" }}
                />
              </div>
            </div>
            <div>
              <label style={{ fontSize: "14px", fontWeight: "600", marginBottom: "5px", display: "block" }}>Target Audience</label>
              <select
                className="filter"
                value={targetType}
                onChange={(e) => { setTargetType(e.target.value); setTargetValue(""); }}
                style={{ width: "100%", fontSize: "14px" }}
              >
                <option value="all">All Employees</option>
                <option value="employee">Specific Employee</option>
                <option value="department">Department</option>
              </select>
            </div>
            {targetType === "employee" && (
              <select
                className="filter"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                style={{ width: "100%", fontSize: "14px" }}
              >
                <option value="">Select Employee</option>
                {employees.map(emp => (
                  <option key={emp.id} value={emp.id}>{emp.first_name} {emp.last_name}</option>
                ))}
              </select>
            )}
            {targetType === "department" && (
              <select
                className="filter"
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                style={{ width: "100%", fontSize: "14px" }}
              >
                <option value="">Select Department</option>
                {departments.map(dept => (
                  <option key={dept} value={dept}>{dept}</option>
                ))}
              </select>
            )}
            <div style={{ display: "flex", gap: "10px" }}>
              <button className="primary-btn" onClick={handleSave}>
                {editingId ? "Update" : "Save"}
              </button>
              <button className="primary-btn" onClick={handleClear}>
                Clear
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="widget">
        {announcements.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            📭 No announcements yet
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "15px", padding: "20px", maxHeight: "600px", overflowY: "auto" }}>
            {announcements.map((ann) => (
              <div
                key={ann.id}
                style={{
                  background: ann.is_active ? "#f9fafb" : "#fee2e2",
                  padding: "20px",
                  borderRadius: "12px",
                  border: "1px solid #e5e7eb",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                  <div style={{ flex: 1 }}>
                    <h3 style={{ margin: "0 0 10px 0", fontSize: "18px" }}>{ann.title}</h3>
                    <p style={{ margin: "0 0 10px 0", fontSize: "18px", color: "#6b7280" }}>
                      {ann.message}
                    </p>
                    <p style={{ margin: 0, fontSize: "18px", color: "#9ca3af" }}>
                      From: {formatDate(ann.from_date)} | To: {formatDate(ann.to_date)}
                    </p>
                    <p style={{ margin: "5px 0 0 0", fontSize: "18px", color: "#6b7280" }}>
                      Target: {ann.target_type === "all" ? "All Employees" : ann.target_type === "employee" ? `Employee ID: ${ann.target_value}` : `Department: ${ann.target_value}`}
                    </p>
                    <p style={{ margin: "5px 0 0 0", fontSize: "18px", fontWeight: "600", color: ann.is_active ? "#16a34a" : "#dc2626" }}>
                      {ann.is_active ? "Active" : "Inactive"}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    <button
                      className="primary-btn"
                      onClick={() => toggleDisplay(ann.id, ann.is_active)}
                      style={{ padding: "6px 12px", fontSize: "18px" }}
                    >
                      {ann.is_active ? "Hide" : "Display"}
                    </button>
                    <button
                      className="primary-btn"
                      onClick={() => handleEdit(ann)}
                      style={{ padding: "6px 12px", fontSize: "18px" }}
                    >
                      Edit
                    </button>
                    <button
                      className="primary-btn"
                      onClick={() => handleDelete(ann.id)}
                      style={{ padding: "6px 12px", fontSize: "18px" }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
