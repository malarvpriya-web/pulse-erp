import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "./EmployeesData.css";

export default function ExEmployees({ setPage, setSelectedEmployee }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterDept, setFilterDept] = useState("All Departments");

  useEffect(() => {
    fetchEmployees();
  }, []);

  const fetchEmployees = async () => {
    try {
      setLoading(true);
      const response = await api.get("/employees");
      setEmployees(response.data || []);
    } catch (err) {
      console.error("Error fetching employees:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = (format) => {
    if (format === "Download") return;
    
    const headers = ["S.No", "Employee Name", "Department", "Role", "Exit Date", "Exit Reason", "Last Manager"];
    const rows = filteredEmployees.map((emp, index) => [
      index + 1,
      `${emp.first_name} ${emp.last_name}`,
      emp.department || "-",
      emp.designation || "-",
      emp.exit_date ? new Date(emp.exit_date).toLocaleDateString() : "-",
      emp.exit_reason || "-",
      emp.reporting_manager || "-"
    ]);

    if (format === "CSV") {
      const csv = [headers, ...rows].map(row => row.join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ex-employees.csv";
      a.click();
    } else if (format === "Excel") {
      const csv = [headers, ...rows].map(row => row.join(",")).join("\n");
      const blob = new Blob([csv], { type: "application/vnd.ms-excel" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "ex-employees.xls";
      a.click();
    }
  };

  const departments = ["All Departments", ...new Set(employees.map(e => e.department).filter(Boolean))];

  const filteredEmployees = employees.filter((emp) => {
    if (emp.status !== "Left") return false;

    const matchesSearch = 
      emp.first_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.last_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.company_email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emp.office_id?.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesDept = filterDept === "All Departments" || emp.department === filterDept;
    
    return matchesSearch && matchesDept;
  });

  return (
    <div className="employees-page">
      <div className="employees-header">
        <h1>Ex-Employees Data</h1>

        <div className="employees-actions">
          <input 
            className="search-box" 
            placeholder="Search ex-employee (Name, ID, Email)"
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
          <select className="filter" onChange={(e) => { if (e.target.value !== "Download") { handleDownload(e.target.value); e.target.value = "Download"; } }}>
            <option value="Download" hidden>Download</option>
            <option>CSV</option>
            <option>Excel</option>
          </select>
        </div>
      </div>

      <div className="widget">
        {loading ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            ⏳ Loading ex-employees...
          </div>
        ) : filteredEmployees.length === 0 ? (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ fontSize: "48px", marginBottom: "16px" }}>✅</div>
            <div style={{ fontSize: "18px", color: "#6b7280", fontWeight: 600 }}>No ex-employees found</div>
          </div>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th style={{ width: "60px" }}>S.No</th>
                <th>Employee Name</th>
                <th>Department</th>
                <th>Role</th>
                <th>Exit Date</th>
                <th>Exit Reason</th>
                <th>Last Manager</th>
                <th style={{ width: "200px" }}>Actions</th>
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
                  <td>{emp.first_name} {emp.last_name}</td>
                  <td>{emp.department || "-"}</td>
                  <td>{emp.designation || "-"}</td>
                  <td>{emp.exit_date ? new Date(emp.exit_date).toLocaleDateString() : "-"}</td>
                  <td>{emp.exit_reason || "Not specified"}</td>
                  <td>{emp.reporting_manager || "-"}</td>
                  <td>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        className="action-btn view-btn"
                        onClick={() => {
                          setSelectedEmployee(emp);
                          setPage("EmployeeProfile");
                        }}
                      >
                        View Profile
                      </button>
                      <button
                        className="action-btn rehire-btn"
                        onClick={async () => {
                          if (window.confirm(`Rehire ${emp.first_name} ${emp.last_name}?`)) {
                            try {
                              await api.put(`/employees/${emp.id}`, { status: "Active" });
                              await fetchEmployees();
                              alert("Employee rehired successfully");
                            } catch (err) {
                              alert("Failed: " + (err.response?.data?.error || err.message));
                            }
                          }
                        }}
                      >
                        Rehire
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
          Showing {filteredEmployees.length} ex-employees
        </div>
      )}
    </div>
  );
}
