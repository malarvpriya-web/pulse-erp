import { useState, useEffect } from "react";
import api from "@/services/api/client";
import { formatDate } from "@/utils/dateFormatter";
import "../../employees/pages/EmployeesData.css";

export default function HolidayCalendar() {
  const [holidays, setHolidays] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");

  useEffect(() => {
    fetchHolidays();
  }, []);

  const fetchHolidays = async () => {
    try {
      const response = await api.get("/holidays");
      setHolidays(response.data);
    } catch (err) {
      console.error("Error fetching holidays:", err);
    }
  };

  const handleAdd = async () => {
    if (!name || !date) {
      alert("Please fill all fields");
      return;
    }
    try {
      await api.post("/holidays", { name, date });
      fetchHolidays();
      setName("");
      setDate("");
      setShowForm(false);
    } catch (err) {
      alert("Error adding holiday");
    }
  };

  const handleDelete = async (id) => {
    if (!confirm("Are you sure you want to delete this holiday?")) return;
    try {
      await api.delete(`/holidays/${id}`);
      fetchHolidays();
    } catch (err) {
      alert("Error deleting holiday");
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return "";
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return dateString;
    const day = String(d.getDate()).padStart(2, '0');
    const month = d.toLocaleString('default', { month: 'long' });
    const year = d.getFullYear();
    return `${day} ${month} ${year}`;
  };

  return (
    <div className="employees-page">
      <div className="employees-header">
        <h1>Holiday Calendar</h1>
        <button className="primary-btn" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancel" : "Add Holiday"}
        </button>
      </div>

      {showForm && (
        <div className="widget" style={{ marginBottom: "20px", padding: "20px" }}>
          <div style={{ display: "flex", gap: "15px", alignItems: "end" }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: "18px", fontWeight: "600", marginBottom: "5px", display: "block" }}>Holiday Name</label>
              <input
                className="search-box"
                placeholder="Holiday Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: "18px", fontWeight: "600", marginBottom: "5px", display: "block" }}>Date</label>
              <input
                type="date"
                className="search-box"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <button className="primary-btn" onClick={handleAdd}>Save</button>
          </div>
        </div>
      )}

      <div className="widget">
        {holidays.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            📅 No holidays added
          </div>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th>Holiday Name</th>
                <th>Date</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((holiday) => (
                <tr key={holiday.id}>
                  <td>{holiday.name}</td>
                  <td>{formatDate(holiday.date)}</td>
                  <td>
                    <button className="primary-btn" onClick={() => handleDelete(holiday.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
