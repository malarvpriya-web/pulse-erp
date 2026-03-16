import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "../../employees/pages/EmployeesData.css";

export default function Policies() {
  const [leavePolicy, setLeavePolicy] = useState([]);
  const [travelPolicy, setTravelPolicy] = useState([]);
  const [attendancePolicy, setAttendancePolicy] = useState([]);
  const [uniformPolicy, setUniformPolicy] = useState([]);
  const [showForm, setShowForm] = useState("");
  const [policyName, setPolicyName] = useState("");
  const [policyVersion, setPolicyVersion] = useState("");
  const [policyFile, setPolicyFile] = useState(null);

  useEffect(() => {
    fetchPolicies();
  }, []);

  const fetchPolicies = async () => {
    try {
      const response = await api.get("/policies");
      const all = response.data || [];
      setLeavePolicy(all.filter(p => p.category === "Leave"));
      setTravelPolicy(all.filter(p => p.category === "Travel"));
      setAttendancePolicy(all.filter(p => p.category === "Attendance"));
      setUniformPolicy(all.filter(p => p.category === "Uniform"));
    } catch (err) {
      console.error("Error fetching policies:", err);
    }
  };

  const handleAddPolicy = async (category) => {
    if (!policyName || !policyVersion || !policyFile) {
      alert("Please fill all fields");
      return;
    }
    
    try {
      const formData = new FormData();
      formData.append("name", policyName);
      formData.append("version", policyVersion);
      formData.append("category", category);
      formData.append("file", policyFile);
      formData.append("status", "active");

      await api.post("/policies", formData);
      
      setPolicyName("");
      setPolicyVersion("");
      setPolicyFile(null);
      setShowForm("");
      fetchPolicies();
    } catch (err) {
      alert("Error uploading policy");
    }
  };

  const handleDelete = async (category, id) => {
    if (!confirm("Delete this policy?")) return;
    try {
      await api.delete(`/policies/${id}`);
      fetchPolicies();
    } catch (err) {
      alert("Error deleting policy");
    }
  };

  const renderPolicySection = (title, policies, category) => (
    <div style={{ marginBottom: "40px" }}>
      <div className="employees-header">
        <h2>{title}</h2>
        <button className="primary-btn" onClick={() => setShowForm(showForm === category ? "" : category)}>
          {showForm === category ? "Cancel" : "Upload Policy"}
        </button>
      </div>

      {showForm === category && (
        <div className="widget" style={{ marginBottom: "20px", padding: "20px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "15px" }}>
            <div>
              <label style={{ fontSize: "18px", fontWeight: "600", marginBottom: "5px", display: "block" }}>Policy Name</label>
              <input
                className="search-box"
                placeholder="Policy Name"
                value={policyName}
                onChange={(e) => setPolicyName(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div>
              <label style={{ fontSize: "18px", fontWeight: "600", marginBottom: "5px", display: "block" }}>Version</label>
              <input
                className="search-box"
                placeholder="e.g., v1.0, v2.1"
                value={policyVersion}
                onChange={(e) => setPolicyVersion(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <label style={{ fontSize: "18px", fontWeight: "600", marginBottom: "5px", display: "block" }}>Upload File</label>
              <input
                type="file"
                accept=".pdf,.doc,.docx"
                onChange={(e) => setPolicyFile(e.target.files[0])}
                style={{ fontSize: "18px" }}
              />
            </div>
          </div>
          <button className="primary-btn" onClick={() => handleAddPolicy(category)} style={{ marginTop: "15px" }}>Save Policy</button>
        </div>
      )}

      <div className="widget">
        {policies.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            📂 No policies uploaded
          </div>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th>Policy Name</th>
                <th>Version</th>
                <th>File Name</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td>{policy.name}</td>
                  <td>{policy.version}</td>
                  <td>{policy.file_url ? policy.file_url.split('/').pop() : 'File'}</td>
                  <td>
                    <button className="primary-btn" onClick={() => handleDelete(category, policy.id)}>
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

  return (
    <div className="employees-page">
      <h1 style={{ marginBottom: "25px" }}>Company Policies</h1>
      {renderPolicySection("Leave Policy", leavePolicy, "Leave")}
      {renderPolicySection("Travel Policy", travelPolicy, "Travel")}
      {renderPolicySection("Attendance Policy", attendancePolicy, "Attendance")}
      {renderPolicySection("Uniform Policy", uniformPolicy, "Uniform")}
    </div>
  );
}