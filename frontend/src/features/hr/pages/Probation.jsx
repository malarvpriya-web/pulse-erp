import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "../../employees/pages/EmployeesData.css";

export default function Probation() {
  const [employees, setEmployees] = useState([]);
  const [allEmployees, setAllEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState(null);
  const [notifiedTo, setNotifiedTo] = useState("");
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    fetchProbationEmployees();
  }, []);

  const fetchProbationEmployees = async () => {
    try {
      setLoading(true);
      const response = await api.get("/employees");
      const probationEmps = response.data.filter(e => e.status === "Probation");
      setEmployees(probationEmps);
      setAllEmployees(response.data.filter(e => e.status !== "Left"));
    } catch (err) {
      console.error("Error fetching probation employees:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleNotify = async () => {
    if (!notifiedTo) {
      alert("Please enter name");
      return;
    }
    try {
      await api.post("/probation", {
        employee_id: selectedEmp.id,
        notified_to: notifiedTo,
        notified_role: "Manager",
        notification_type: "approval",
        module_name: "Probation"
      });
      alert("Notification sent successfully");
      setShowModal(false);
      setNotifiedTo("");
      setSuggestions([]);
    } catch (err) {
      alert("Failed to send notification");
    }
  };

  const handleInputChange = (value) => {
    setNotifiedTo(value);
    if (value.length > 0) {
      const filtered = allEmployees.filter(e => 
        `${e.first_name} ${e.last_name}`.toLowerCase().includes(value.toLowerCase()) ||
        e.office_id?.toLowerCase().includes(value.toLowerCase())
      ).slice(0, 5);
      setSuggestions(filtered);
    } else {
      setSuggestions([]);
    }
  };

  return (
    <div className="employees-page">
      <div className="employees-header">
        <h1>Probation Employees</h1>
      </div>

      <div className="widget">
        {loading ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            ⏳ Loading...
          </div>
        ) : employees.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            📭 No employees on probation
          </div>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th>Employee ID</th>
                <th>Name</th>
                <th>Department</th>
                <th>Joining Date</th>
                <th>Probation End</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((emp) => {
                const joiningDate = emp.joining_date ? new Date(emp.joining_date) : null;
                const probationEnd = joiningDate ? new Date(joiningDate.setMonth(joiningDate.getMonth() + 6)) : null;
                
                return (
                  <tr key={emp.id}>
                    <td>{emp.office_id || "-"}</td>
                    <td>{emp.first_name} {emp.last_name}</td>
                    <td>{emp.department || "-"}</td>
                    <td>{emp.joining_date ? new Date(emp.joining_date).toLocaleDateString() : "-"}</td>
                    <td>{probationEnd ? probationEnd.toLocaleDateString() : "-"}</td>
                    <td>
                      <button 
                        className="primary-btn"
                        onClick={() => {
                          setSelectedEmp(emp);
                          setShowModal(true);
                        }}
                      >
                        Notify
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            background: 'white',
            padding: '30px',
            borderRadius: '12px',
            width: '500px',
            maxWidth: '90%'
          }}>
            <h2 style={{ marginBottom: '20px', fontSize: '22px' }}>Send Notification</h2>
            <div style={{ background: '#f3f4f6', padding: '15px', borderRadius: '8px', marginBottom: '20px' }}>
              <p style={{ marginBottom: '8px', fontSize: '18px' }}><strong>Employee:</strong> {selectedEmp?.first_name} {selectedEmp?.last_name}</p>
              <p style={{ marginBottom: '8px', fontSize: '18px' }}><strong>Joining Date:</strong> {selectedEmp?.joining_date ? new Date(selectedEmp.joining_date).toLocaleDateString() : '-'}</p>
              <p style={{ marginBottom: '0', fontSize: '18px' }}><strong>Probation Ends:</strong> {selectedEmp?.joining_date ? (() => {
                const end = new Date(selectedEmp.joining_date);
                end.setMonth(end.getMonth() + 6);
                return end.toLocaleDateString();
              })() : '-'}</p>
            </div>
            
            <div style={{ marginBottom: '15px', position: 'relative' }}>
              <label style={{ fontSize: '18px', fontWeight: '600', marginBottom: '5px', display: 'block' }}>Notify To</label>
              <input
                className="search-box"
                placeholder="Enter or search employee name"
                value={notifiedTo}
                onChange={(e) => handleInputChange(e.target.value)}
                style={{ width: '100%' }}
              />
              {suggestions.length > 0 && (
                <div style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: '8px',
                  marginTop: '5px',
                  maxHeight: '200px',
                  overflowY: 'auto',
                  zIndex: 1000,
                  boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                }}>
                  {suggestions.map(emp => (
                    <div
                      key={emp.id}
                      onClick={() => {
                        setNotifiedTo(`${emp.first_name} ${emp.last_name}`);
                        setSuggestions([]);
                      }}
                      style={{
                        padding: '10px 14px',
                        cursor: 'pointer',
                        fontSize: '18px',
                        borderBottom: '1px solid #f3f4f6'
                      }}
                      onMouseEnter={(e) => e.target.style.background = '#f3f4f6'}
                      onMouseLeave={(e) => e.target.style.background = 'white'}
                    >
                      {emp.office_id} - {emp.first_name} {emp.last_name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="primary-btn" onClick={handleNotify}>Send</button>
              <button className="primary-btn" onClick={() => setShowModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
