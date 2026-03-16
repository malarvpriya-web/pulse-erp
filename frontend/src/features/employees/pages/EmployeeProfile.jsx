import { useState, useEffect } from "react";
import api from "@/services/api/client";

export default function EmployeeProfile({ employee, setPage }) {

  const [activeTab, setActiveTab] = useState("overview");
  const [notesText, setNotesText] = useState("");
  const [notesList, setNotesList] = useState([]);

  useEffect(() => {
    if (employee?.id) {
      fetchNotes();
    }
  }, [employee]);

  const fetchNotes = async () => {
    try {
      const response = await api.get(`/notes/${employee.id}`);
      setNotesList(response.data);
    } catch (err) {
      console.error("Error fetching notes:", err);
    }
  };

  const saveNote = async () => {
    if (!notesText.trim()) return;

    try {
      await api.post("/notes", {
        employeeId: employee.id,
        noteText: notesText
      });
      setNotesText("");
      fetchNotes();
    } catch (err) {
      console.error("Error saving note:", err);
      alert("Failed to save note");
    }
  };

  // safety check
  if (!employee) {
    return <h2 style={{ padding: "30px" }}>No employee selected</h2>;
  }

  return (
    <div className="employee-profile-page" style={{ padding: "30px" }}>

      {/* Back Button */}
      <div className="profile-topbar">
        <div></div>
        <div style={{ display: "flex", gap: "10px" }}>
          <button
            className="add-page-back-btn"
            onClick={() => {
              setPage("AddEmployee");
            }}
          >
            ✏️ Edit
          </button>
          <button
            className="add-page-back-btn"
            onClick={() => setPage("EmployeesData")}
          >
            ← Back
          </button>
        </div>
      </div>

      {/* Profile Header */}
      <div className="profile-card">
        <img
          src={employee.photo_url ? `http://localhost:5000${employee.photo_url}` : "https://i.pravatar.cc/120"}
          className="profile-photo"
          alt="profile"
        />

        <div>
          <h1>{employee.first_name} {employee.last_name}</h1>
          <p>{employee.designation} • {employee.department}</p>
          <p>{employee.company_email}</p>
          <p>{employee.phone}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="profile-tabs">
        {["overview","personal","job","payroll","documents","history","notes"].map(tab => (
          <div
            key={tab}
            className={`tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </div>
        ))}
      </div>

      <div className="profile-main-card">
        <div className="tab-content">

          {/* OVERVIEW */}
          {activeTab === "overview" && (
            <div className="snapshot-grid">
              <div className="snapshot-card">
                <h3>📋 Personal</h3>
                <p><b>Name:</b> {employee.first_name} {employee.last_name}</p>
                <p><b>Gender:</b> {employee.gender || "-"}</p>
                <p><b>Blood Group:</b> {employee.blood_group || "-"}</p>
                <p><b>Marital Status:</b> {employee.marital_status || "-"}</p>
                <p><b>DOB:</b> {employee.dob ? new Date(employee.dob).toLocaleDateString('en-GB') : "-"}</p>
                <p><b>Age:</b> {employee.dob ? Math.floor((new Date() - new Date(employee.dob)) / (365.25 * 24 * 60 * 60 * 1000)) : "-"} years</p>
              </div>

              <div className="snapshot-card">
                <h3>💼 Work</h3>
                <p><b>Department:</b> {employee.department || "-"}</p>
                <p><b>Designation:</b> {employee.designation || "-"}</p>
                <p><b>Manager:</b> {employee.reporting_manager || "-"}</p>
                <p><b>Location:</b> {employee.location || "-"}</p>
              </div>

              <div className="snapshot-card">
                <h3>📅 Joining</h3>
                <p><b>Joining Date:</b> {employee.joining_date ? new Date(employee.joining_date).toLocaleDateString('en-GB') : "-"}</p>
                <p><b>Experience:</b> {employee.joining_date ? Math.floor((new Date() - new Date(employee.joining_date)) / (365.25 * 24 * 60 * 60 * 1000)) : "-"} years</p>
                <p><b>Total Experience:</b> {((employee.previous_years_1 || 0) + (employee.previous_years_2 || 0) + (employee.joining_date ? Math.floor((new Date() - new Date(employee.joining_date)) / (365.25 * 24 * 60 * 60 * 1000)) : 0))} years</p>
                <p><b>Employment Type:</b> {employee.employment_type || "-"}</p>
                <p><b>Zone:</b> {employee.zone || "-"}</p>
              </div>
            </div>
          )}

          {/* PERSONAL */}
          {activeTab === "personal" && (
            <div className="snapshot-grid">
              <div className="snapshot-card">
                <h3>👤 Basic Info</h3>
                <p><b>DOB:</b> {employee.dob ? new Date(employee.dob).toLocaleDateString('en-GB') : "-"}</p>
                <p><b>Gender:</b> {employee.gender || "-"}</p>
                <p><b>Blood Group:</b> {employee.blood_group || "-"}</p>
                <p><b>Marital Status:</b> {employee.marital_status || "-"}</p>
                <p><b>Father:</b> {employee.father_name || "-"}</p>
              </div>

              <div className="snapshot-card">
                <h3>📞 Contact</h3>
                <p><b>Mobile:</b> {employee.phone || "-"}</p>
                <p><b>Company Email:</b> {employee.company_email || "-"}</p>
                <p><b>Personal Email:</b> {employee.personal_email || "-"}</p>
                <p><b>Current Address:</b> {employee.current_address || "-"}</p>
              </div>

              <div className="snapshot-card">
                <h3>👨‍👩‍👧‍👦 Family</h3>
                <p><b>Mother:</b> {employee.mother_name || "-"}</p>
                <p><b>Spouse:</b> {employee.spouse_name || "-"}</p>
                <p><b>Emergency Contact:</b> {employee.emergency_name || "-"}</p>
                <p><b>Emergency Phone:</b> {employee.emergency_phone || "-"}</p>
              </div>
            </div>
          )}

          {/* JOB */}
          {activeTab === "job" && (
            <div className="snapshot-grid">
              <div className="snapshot-card">
                <h3>💼 Position</h3>
                <p><b>Title:</b> {employee.designation || "-"}</p>
                <p><b>Department:</b> {employee.department || "-"}</p>
                <p><b>Reporting To:</b> {employee.reporting_manager || "-"}</p>
              </div>

              <div className="snapshot-card">
                <h3>📋 Employment</h3>
                <p><b>Type:</b> {employee.employment_type || "-"}</p>
                <p><b>Join Date:</b> {employee.joining_date ? new Date(employee.joining_date).toLocaleDateString('en-GB') : "-"}</p>
                <p><b>Location:</b> {employee.location || "-"}</p>
              </div>

              <div className="snapshot-card">
                <h3>🎯 Experience</h3>
                <p><b>Previous Company 1:</b> {employee.previous_company_1 || "-"}</p>
                <p><b>Previous Role:</b> {employee.previous_role_1 || "-"}</p>
                <p><b>Years:</b> {employee.previous_years_1 || "-"}</p>
              </div>
            </div>
          )}

          {/* PAYROLL */}
          {activeTab === "payroll" && (
            <div className="snapshot-grid">
              <div className="snapshot-card">
                <h3>🏦 Bank Details</h3>
                <p><b>Bank Name:</b> {employee.bank_name || "-"}</p>
                <p><b>Branch:</b> {employee.branch_name || "-"}</p>
                <p><b>Account:</b> {employee.account_number || "-"}</p>
                <p><b>IFSC:</b> {employee.ifsc_code || "-"}</p>
              </div>

              <div className="snapshot-card">
                <h3>👤 Nominee</h3>
                <p><b>Nominee Name:</b> {employee.nominee_name || "-"}</p>
              </div>

              <div className="snapshot-card">
                <h3>📱 Government IDs</h3>
                <p><b>PAN:</b> {employee.pan_number || "-"}</p>
                <p><b>Aadhaar:</b> {employee.aadhaar_number || "-"}</p>
                <p><b>PF Number:</b> {employee.pf_number || "-"}</p>
                <p><b>UAN:</b> {employee.uan_number || "-"}</p>
              </div>
            </div>
          )}

          {/* DOCUMENTS */}
          {activeTab === "documents" && (
            <div className="docs-grid">
              {employee.photo_url && <div className="doc-card" onClick={() => window.open(`http://localhost:5000${employee.photo_url}`, '_blank')}>📷 Photo <span>View</span></div>}
              {employee.resume_file && <div className="doc-card" onClick={() => window.open(`http://localhost:5000${employee.resume_file}`, '_blank')}>📄 Resume <span>View</span></div>}
              {employee.offer_letter_file && <div className="doc-card" onClick={() => window.open(`http://localhost:5000${employee.offer_letter_file}`, '_blank')}>📄 Offer Letter <span>View</span></div>}
              {employee.pan_file && <div className="doc-card" onClick={() => window.open(`http://localhost:5000${employee.pan_file}`, '_blank')}>📄 PAN Card <span>View</span></div>}
              {employee.aadhaar_file && <div className="doc-card" onClick={() => window.open(`http://localhost:5000${employee.aadhaar_file}`, '_blank')}>📄 Aadhaar <span>View</span></div>}
              {employee.cancelled_cheque_file && <div className="doc-card" onClick={() => window.open(`http://localhost:5000${employee.cancelled_cheque_file}`, '_blank')}>📄 Cancelled Cheque <span>View</span></div>}
              {employee.bank_statement_file && <div className="doc-card" onClick={() => window.open(`http://localhost:5000${employee.bank_statement_file}`, '_blank')}>📄 Bank Statement <span>View</span></div>}
              {!employee.photo_url && !employee.resume_file && !employee.offer_letter_file && !employee.pan_file && !employee.aadhaar_file && !employee.cancelled_cheque_file && !employee.bank_statement_file && (
                <p style={{color: "#94a3b8", padding: "20px"}}>No documents uploaded</p>
              )}
            </div>
          )}

          {/* HISTORY BAR CHART */}
          {activeTab === "history" && (
            <>
              <h2 className="section-title">Salary Growth</h2>
              <div className="bar-chart">
                <div className="bar"><div className="bar-fill" style={{height:"90px"}}></div><span>2023</span><p>₹25k</p></div>
                <div className="bar"><div className="bar-fill" style={{height:"130px"}}></div><span>2023 Jul</span><p>₹32k</p></div>
                <div className="bar"><div className="bar-fill" style={{height:"170px"}}></div><span>2024</span><p>₹40k</p></div>
                <div className="bar"><div className="bar-fill" style={{height:"220px"}}></div><span>2025</span><p>₹52k</p></div>
              </div>
            </>
          )}

          {/* NOTES */}
          {activeTab === "notes" && (
            <>
              <h2 className="section-title">HR Notes</h2>
              <textarea
                className="notes-input"
                placeholder="Write HR note..."
                value={notesText}
                onChange={(e)=>setNotesText(e.target.value)}
              />
              <button className="save-note-btn" onClick={saveNote}>
                Save Note
              </button>

              <div className="notes-list">
                {notesList.map((note)=>(
                  <div key={note.id} className="note-card">
                    <b>{new Date(note.created_at).toLocaleString()}</b>
                    <p>{note.note_text}</p>
                  </div>
                ))}
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}