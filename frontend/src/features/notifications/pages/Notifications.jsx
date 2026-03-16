import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "../../employees/pages/EmployeesData.css";

export default function Notifications() {
  const [notifications, setNotifications] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [selectedNotif, setSelectedNotif] = useState(null);
  const [decision, setDecision] = useState("");
  const [rating, setRating] = useState(3);
  const [comments, setComments] = useState("");

  useEffect(() => {
    fetchNotifications();
  }, []);

  const fetchNotifications = async () => {
    try {
      const response = await api.get("/probation");
      setNotifications(response.data);
    } catch (err) {
      console.error("Error fetching notifications:", err);
    }
  };

  const handleDecision = async () => {
    if (!decision) {
      alert("Please select a decision");
      return;
    }
    try {
      await api.put(`/probation/${selectedNotif.id}`, {
        decision,
        performance_rating: rating,
        comments
      });
      alert("Decision submitted successfully");
      setShowModal(false);
      setDecision("");
      setRating(3);
      setComments("");
      fetchNotifications();
    } catch (err) {
      alert("Failed to submit decision");
    }
  };

  const pendingNotifications = notifications.filter(n => n.status === "pending");
  const completedNotifications = notifications.filter(n => n.status === "completed");

  return (
    <div className="employees-page">
      <div className="employees-header">
        <h1>Probation Notifications</h1>
      </div>

      <h2 style={{ marginTop: "20px", marginBottom: "15px", fontSize: "22px" }}>Pending ({pendingNotifications.length})</h2>
      <div className="widget" style={{ marginBottom: "30px" }}>
        {pendingNotifications.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            📭 No pending notifications
          </div>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th>Employee ID</th>
                <th>Name</th>
                <th>Department</th>
                <th>Notified To</th>
                <th>Role</th>
                <th>Date</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {pendingNotifications.map((notif) => (
                <tr key={notif.id}>
                  <td>{notif.office_id}</td>
                  <td>{notif.first_name} {notif.last_name}</td>
                  <td>{notif.department}</td>
                  <td>{notif.notified_to}</td>
                  <td>{notif.notified_role}</td>
                  <td>{new Date(notif.created_at).toLocaleDateString()}</td>
                  <td>
                    <button 
                      className="primary-btn"
                      onClick={() => {
                        setSelectedNotif(notif);
                        setShowModal(true);
                      }}
                    >
                      Decide
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 style={{ marginBottom: "15px", fontSize: "22px" }}>Completed ({completedNotifications.length})</h2>
      <div className="widget">
        {completedNotifications.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>
            📭 No completed notifications
          </div>
        ) : (
          <table className="employees-table">
            <thead>
              <tr>
                <th>Employee ID</th>
                <th>Name</th>
                <th>Decision</th>
                <th>Rating</th>
                <th>Decided By</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {completedNotifications.map((notif) => (
                <tr key={notif.id}>
                  <td>{notif.office_id}</td>
                  <td>{notif.first_name} {notif.last_name}</td>
                  <td>{notif.decision}</td>
                  <td>{notif.performance_rating}/5</td>
                  <td>{notif.notified_to}</td>
                  <td>{new Date(notif.decided_at).toLocaleDateString()}</td>
                </tr>
              ))}
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
            width: '600px',
            maxWidth: '90%'
          }}>
            <h2 style={{ marginBottom: '20px', fontSize: '22px' }}>Probation Decision</h2>
            <p style={{ marginBottom: '15px', fontSize: '18px' }}>
              <strong>Employee:</strong> {selectedNotif?.first_name} {selectedNotif?.last_name} ({selectedNotif?.office_id})
            </p>
            <p style={{ marginBottom: '15px', fontSize: '18px' }}>
              <strong>Department:</strong> {selectedNotif?.department}
            </p>
            <p style={{ marginBottom: '20px', fontSize: '18px' }}>
              <strong>Joining Date:</strong> {selectedNotif?.joining_date ? new Date(selectedNotif.joining_date).toLocaleDateString() : "-"}
            </p>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ fontSize: '18px', fontWeight: '600', marginBottom: '5px', display: 'block' }}>Decision</label>
              <select
                className="filter"
                value={decision}
                onChange={(e) => setDecision(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">Select Decision</option>
                <option value="Confirm">Confirm</option>
                <option value="Extend Probation">Extend Probation</option>
                <option value="Terminate">Terminate</option>
              </select>
            </div>

            <div style={{ marginBottom: '15px' }}>
              <label style={{ fontSize: '18px', fontWeight: '600', marginBottom: '5px', display: 'block' }}>
                Performance Rating: {rating}/5
              </label>
              <input
                type="range"
                min="1"
                max="5"
                value={rating}
                onChange={(e) => setRating(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ fontSize: '18px', fontWeight: '600', marginBottom: '5px', display: 'block' }}>Comments</label>
              <textarea
                className="search-box"
                placeholder="Add comments"
                value={comments}
                onChange={(e) => setComments(e.target.value)}
                rows="4"
                style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="primary-btn" onClick={handleDecision}>Submit</button>
              <button className="primary-btn" onClick={() => setShowModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
