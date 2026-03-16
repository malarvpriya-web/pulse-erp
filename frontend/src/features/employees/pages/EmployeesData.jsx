import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "./EmployeesData.css";

export default function EmployeesData({ setPage, setSelectedEmployee }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterDept, setFilterDept] = useState("All Departments");
  const [filterStatus, setFilterStatus] = useState("All Status");
  const [filterRole, setFilterRole] = useState("All Roles");

  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const response = await api.get("/employees?t=" + Date.now());
      setEmployees(response.data || []);
    } catch (err) {
      console.error('Error fetching employees:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = (format) => {
    if (format === "Download") return;
    
    const headers = ["S.No", "Employee ID", "Name", "Department", "Role", "Status", "Joining Date", "Manager"];
    const rows = filteredEmployees.map((emp, index) => [
      index + 1,
      emp.office_id || "-",
      `${emp.first_name} ${emp.last_name}`,
      emp.department || "-",
      emp.designation || "-",
      emp.status || "Active",
      emp.joining_date ? new Date(emp.joining_date).toLocaleDateString() : "-",
      emp.reporting_manager || "-"
    ]);

    if (format === "CSV") {
      const csv = [headers, ...rows].map(row => row.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "employees.csv";
      a.click();
    } else if (format === "Excel") {
      const csv = [headers, ...rows].map(row => row.join(",")).join("\n");
      const blob = new Blob([csv], { type: "application/vnd.ms-excel" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "employees.xls";
      a.click();
    }
  };

  const departments = ["All Departments", ...new Set(employees.map(e => e.department).filter(Boolean))];
  const roles = ["All Roles", ...new Set(employees.map(e => e.designation).filter(Boolean))];

  const filteredEmployees = employees.filter((emp) => {
    if (emp.status === "Left") return false;

    const matchesSearch = 
      emp.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.last_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.company_email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.office_id?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesDept = filterDept === "All Departments" || emp.department === filterDept;
    const matchesStatus = filterStatus === "All Status" || emp.status === filterStatus || (filterStatus === "Active" && !emp.status);
    const matchesRole = filterRole === "All Roles" || emp.designation === filterRole;
    
    return matchesSearch && matchesDept && matchesStatus && matchesRole;
  });

  return (
    <div className="employees-page">
      <div className="employees-header">
        <h1>Employees Data</h1>

        <div className="employees-actions">
          <input 
            className="search-box" 
            placeholder="Search employee (Name, ID, Email)"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <select 
            className="filter"
            value={filterDept}
            onChange={(e) => setFilterDept(e.target.value)}
          >
            {departments.map(dept => (
              <option key={dept} value={dept}>{dept}</option>
            ))}
          </select>
          <select 
            className="filter"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="All Status">All Status</option>
            <option value="Active">Active</option>
            <option value="Probation">Probation</option>
            <option value="Notice">Notice Period</option>
          </select>
          <select 
            className="filter"
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value)}
          >
            {roles.map(role => (
              <option key={role} value={role}>{role}</option>
            ))}
          </select>
          <button
            className="primary-btn"
            onClick={() => {
              setSelectedEmployee(null);
              setPage("AddEmployee");
            }}
          >
            Add Employee
          </button>
          <select className="filter" onChange={(e) => { if (e.target.value !== "Download") { handleDownload(e.target.value); e.target.value = "Download"; } }}>
            <option value="Download" hidden>Download</option>
            <option>CSV</option>
            <option>Excel</option>
          </select>
        </div>
      </div>

      <div className="widget" style={{ overflowX: "auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            ⏳ Loading employees...
          </div>
        ) : filteredEmployees.length === 0 && employees.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>📁</div>
            <div style={{ fontSize: "18px", color: "#6b7280", marginBottom: "20px", fontWeight: 600 }}>No employees added yet.</div>
            <button
              className="primary-btn"
              onClick={() => {
                setSelectedEmployee(null);
                setPage("AddEmployee");
              }}
            >
              Add Employee
            </button>
          </div>
        ) : filteredEmployees.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            📭 No employees found matching your filters
          </div>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th style={{ width: "60px" }}>S.No</th>
                <th>Employee ID</th>
                <th>Employee Name</th>
                <th>Department</th>
                <th>Role</th>
                <th>Status</th>
                <th>Joining Date</th>
                <th>Manager</th>
                <th style={{ width: "240px" }}>Actions</th>
              </tr>
            </thead>

            <tbody>
              {filteredEmployees.map((emp, index) => (
                <tr 
                  key={emp.id} 
                  style={{ transition: "background 0.2s" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "#f0f9ff"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "white"}
                >
                  <td>{index + 1}</td>
                  <td>{emp.office_id || "-"}</td>
                  <td>{emp.first_name} {emp.last_name}</td>
                  <td>{emp.department || "-"}</td>
                  <td>{emp.designation || "-"}</td>
                  <td>
                    <span style={{ 
                      padding: "4px 12px", 
                      borderRadius: "6px", 
                      fontSize: "12px", 
                      fontWeight: 600, 
                      background: emp.status === "Active" || !emp.status ? "#d1fae5" : emp.status === "Probation" ? "#fef3c7" : emp.status === "Notice" ? "#fee2e2" : "#e5e7eb", 
                      color: emp.status === "Active" || !emp.status ? "#065f46" : emp.status === "Probation" ? "#92400e" : emp.status === "Notice" ? "#991b1b" : "#374151" 
                    }}>
                      {emp.status || "Active"}
                    </span>
                  </td>
                  <td>{emp.joining_date ? new Date(emp.joining_date).toLocaleDateString() : "-"}</td>
                  <td>{emp.reporting_manager || "-"}</td>
                  <td>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        className="action-btn view-btn"
                        onClick={() => {
                          setSelectedEmployee(emp);
                          setPage("EmployeeProfile");
                        }}
                      >
                        View
                      </button>
                      <button
                        className="action-btn edit-btn"
                        onClick={() => {
                          setSelectedEmployee(emp);
                          setPage("EditEmployee");
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="action-btn deactivate-btn"
                        onClick={async () => {
                          if (window.confirm(`Deactivate ${emp.first_name} ${emp.last_name}?`)) {
                            try {
                              await api.put(`/employees/${emp.id}`, { status: "Left" });
                              await fetchEmployees();
                              alert("Employee deactivated");
                            } catch (err) {
                              alert("Failed: " + (err.response?.data?.error || err.message));
                            }
                          }
                        }}
                      >
                        Deactivate
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {filteredEmployees.length > 0 && (
        <div style={{ marginTop: "15px", textAlign: "center", color: "#94a3b8", fontSize: "14px" }}>
          Showing {filteredEmployees.length} of {employees.filter(e => e.status !== "Left").length} employees
        </div>
      )}

    </div>
  );
}
