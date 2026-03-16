import { useState, useEffect } from "react";
import api from "@/services/api/client";
import "./ApprovalCenter.css";

function ApprovalCenter() {
  const [activeTab, setActiveTab] = useState("pending");
  const [approvals, setApprovals] = useState([]);
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState({});
  const [selectedApproval, setSelectedApproval] = useState(null);
  const [filters, setFilters] = useState({ type: "", department: "", priority: "", search: "" });
  const [selectedItems, setSelectedItems] = useState([]);
  const [rejectComment, setRejectComment] = useState("");
  const [showRejectModal, setShowRejectModal] = useState(false);

  useEffect(() => {
    fetchApprovals();
    fetchStats();
    if (activeTab === "history") fetchHistory();
  }, [activeTab]);

  const fetchApprovals = async () => {
    try {
      const res = await api.get("/approvals/pending");
      setApprovals(res.data);
    } catch (err) {
      console.error("Fetch approvals error:", err);
    }
  };

  const fetchHistory = async () => {
    try {
      const res = await api.get("/approvals/history");
      setHistory(res.data);
    } catch (err) {
      console.error("Fetch history error:", err);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await api.get("/approvals/stats");
      setStats(res.data);
    } catch (err) {
      console.error("Fetch stats error:", err);
    }
  };

  const handleApprove = async (id) => {
    try {
      await api.post(`/approvals/${id}/approve`);
      fetchApprovals();
      fetchStats();
      setSelectedApproval(null);
    } catch (err) {
      alert("Error approving request");
    }
  };

  const handleReject = async (id) => {
    if (!rejectComment.trim()) {
      alert("Please provide a reason for rejection");
      return;
    }
    try {
      await api.post(`/approvals/${id}/reject`, { comment: rejectComment });
      fetchApprovals();
      fetchStats();
      setSelectedApproval(null);
      setShowRejectModal(false);
      setRejectComment("");
    } catch (err) {
      alert("Error rejecting request");
    }
  };

  const handleBulkApprove = async () => {
    if (selectedItems.length === 0) return;
    try {
      await api.post("/approvals/bulk-approve", { ids: selectedItems });
      fetchApprovals();
      fetchStats();
      setSelectedItems([]);
    } catch (err) {
      alert("Error in bulk approval");
    }
  };

  const getRowClass = (approval) => {
    const daysWaiting = Math.floor((new Date() - new Date(approval.request_date)) / (1000 * 60 * 60 * 24));
    if (daysWaiting > 5) return "row-overdue";
    if (daysWaiting > 2) return "row-warning";
    return "row-new";
  };

  const filteredApprovals = approvals.filter(a => {
    if (filters.type && a.request_type !== filters.type) return false;
    if (filters.department && a.department !== filters.department) return false;
    if (filters.priority && a.priority !== filters.priority) return false;
    if (filters.search && !a.requested_by.toLowerCase().includes(filters.search.toLowerCase()) && 
        !a.request_title.toLowerCase().includes(filters.search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="approval-center">
      <h1>Approval Center</h1>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-value">{stats.pending || 0}</span>
          <span className="stat-label">Pending</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.approvedToday || 0}</span>
          <span className="stat-label">Approved Today</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{stats.rejectedToday || 0}</span>
          <span className="stat-label">Rejected Today</span>
        </div>
        <div className="stat-card overdue">
          <span className="stat-value">{stats.overdue || 0}</span>
          <span className="stat-label">Overdue</span>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${activeTab === "pending" ? "active" : ""}`} onClick={() => setActiveTab("pending")}>
          Pending Approvals
        </button>
        <button className={`tab ${activeTab === "history" ? "active" : ""}`} onClick={() => setActiveTab("history")}>
          My Approval History
        </button>
      </div>

      {activeTab === "pending" && (
        <>
          <div className="filters-bar">
            <input
              type="text"
              placeholder="Search by name or request..."
              className="search-input"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            />
            <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
              <option value="">All Types</option>
              <option value="Leave">Leave</option>
              <option value="Expense">Expense</option>
              <option value="Travel">Travel</option>
              <option value="Purchase">Purchase</option>
              <option value="Payment">Payment</option>
              <option value="Timesheet">Timesheet</option>
              <option value="Access">Access</option>
              <option value="Recruitment">Recruitment</option>
            </select>
            <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
              <option value="">All Priorities</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
            {selectedItems.length > 0 && (
              <button className="btn-bulk" onClick={handleBulkApprove}>
                Bulk Approve ({selectedItems.length})
              </button>
            )}
          </div>

          <div className="approvals-table-container">
            <table className="approvals-table">
              <thead>
                <tr>
                  <th><input type="checkbox" onChange={(e) => {
                    if (e.target.checked) setSelectedItems(filteredApprovals.map(a => a.id));
                    else setSelectedItems([]);
                  }} /></th>
                  <th>Type</th>
                  <th>Request Title</th>
                  <th>Requested By</th>
                  <th>Department</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Priority</th>
                  <th>Waiting</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredApprovals.map((approval) => (
                  <tr key={approval.id} className={getRowClass(approval)}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedItems.includes(approval.id)}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedItems([...selectedItems, approval.id]);
                          else setSelectedItems(selectedItems.filter(id => id !== approval.id));
                        }}
                      />
                    </td>
                    <td><span className={`type-badge ${approval.request_type.toLowerCase()}`}>{approval.request_type}</span></td>
                    <td>{approval.request_title}</td>
                    <td>{approval.requested_by}</td>
                    <td>{approval.department}</td>
                    <td>{new Date(approval.request_date).toLocaleDateString()}</td>
                    <td>{approval.amount ? `$${approval.amount.toLocaleString()}` : "-"}</td>
                    <td><span className={`priority-badge ${approval.priority.toLowerCase()}`}>{approval.priority}</span></td>
                    <td>{Math.floor((new Date() - new Date(approval.request_date)) / (1000 * 60 * 60 * 24))} days</td>
                    <td>
                      <button className="btn-view" onClick={() => setSelectedApproval(approval)}>View</button>
                      <button className="btn-approve" onClick={() => handleApprove(approval.id)}>✓</button>
                      <button className="btn-reject" onClick={() => { setSelectedApproval(approval); setShowRejectModal(true); }}>✗</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === "history" && (
        <div className="history-table-container">
          <table className="approvals-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Employee</th>
                <th>Decision</th>
                <th>Date</th>
                <th>Comments</th>
              </tr>
            </thead>
            <tbody>
              {history.map((item) => (
                <tr key={item.id}>
                  <td><span className={`type-badge ${item.request_type.toLowerCase()}`}>{item.request_type}</span></td>
                  <td>{item.requested_by}</td>
                  <td><span className={`decision-badge ${item.decision.toLowerCase()}`}>{item.decision}</span></td>
                  <td>{new Date(item.decision_date).toLocaleDateString()}</td>
                  <td>{item.comments || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedApproval && !showRejectModal && (
        <div className="side-panel">
          <div className="panel-overlay" onClick={() => setSelectedApproval(null)}></div>
          <div className="panel-content">
            <div className="panel-header">
              <h2>Approval Details</h2>
              <button className="close-btn" onClick={() => setSelectedApproval(null)}>×</button>
            </div>
            <div className="panel-body">
              <div className="detail-section">
                <h3>Requester Information</h3>
                <p><strong>Name:</strong> {selectedApproval.requested_by}</p>
                <p><strong>Department:</strong> {selectedApproval.department}</p>
                <p><strong>Email:</strong> {selectedApproval.requester_email}</p>
              </div>
              <div className="detail-section">
                <h3>Request Details</h3>
                <p><strong>Type:</strong> {selectedApproval.request_type}</p>
                <p><strong>Title:</strong> {selectedApproval.request_title}</p>
                <p><strong>Description:</strong> {selectedApproval.description}</p>
                <p><strong>Amount:</strong> {selectedApproval.amount ? `$${selectedApproval.amount.toLocaleString()}` : "N/A"}</p>
                <p><strong>Priority:</strong> {selectedApproval.priority}</p>
              </div>
              {selectedApproval.attachments && (
                <div className="detail-section">
                  <h3>Attachments</h3>
                  <p>{selectedApproval.attachments}</p>
                </div>
              )}
            </div>
            <div className="panel-footer">
              <button className="btn-approve-large" onClick={() => handleApprove(selectedApproval.id)}>Approve</button>
              <button className="btn-reject-large" onClick={() => setShowRejectModal(true)}>Reject</button>
            </div>
          </div>
        </div>
      )}

      {showRejectModal && (
        <div className="modal">
          <div className="modal-overlay" onClick={() => setShowRejectModal(false)}></div>
          <div className="modal-content">
            <h2>Reject Approval</h2>
            <p>Please provide a reason for rejection:</p>
            <textarea
              value={rejectComment}
              onChange={(e) => setRejectComment(e.target.value)}
              placeholder="Enter rejection reason..."
              rows="4"
            />
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => { setShowRejectModal(false); setRejectComment(""); }}>Cancel</button>
              <button className="btn-reject-confirm" onClick={() => handleReject(selectedApproval.id)}>Confirm Reject</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ApprovalCenter;
