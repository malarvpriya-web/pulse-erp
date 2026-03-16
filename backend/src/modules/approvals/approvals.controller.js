import pool from "../../config/db.js";

export const getPendingApprovals = async (req, res) => {
  try {
    const userId = req.user.id;
    
    const query = `
      SELECT * FROM approvals 
      WHERE approver_id = $1 AND status = 'Pending'
      ORDER BY request_date ASC
    `;
    
    const result = await pool.query(query, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Get pending approvals error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getApprovalHistory = async (req, res) => {
  try {
    const userId = req.user.id;
    
    const query = `
      SELECT * FROM approvals 
      WHERE approver_id = $1 AND status IN ('Approved', 'Rejected')
      ORDER BY decision_date DESC
      LIMIT 100
    `;
    
    const result = await pool.query(query, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Get approval history error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const getApprovalStats = async (req, res) => {
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];
    
    const pending = await pool.query(
      "SELECT COUNT(*) as count FROM approvals WHERE approver_id = $1 AND status = 'Pending'",
      [userId]
    );
    
    const approvedToday = await pool.query(
      "SELECT COUNT(*) as count FROM approvals WHERE approver_id = $1 AND status = 'Approved' AND DATE(decision_date) = $2",
      [userId, today]
    );
    
    const rejectedToday = await pool.query(
      "SELECT COUNT(*) as count FROM approvals WHERE approver_id = $1 AND status = 'Rejected' AND DATE(decision_date) = $2",
      [userId, today]
    );
    
    const overdue = await pool.query(
      "SELECT COUNT(*) as count FROM approvals WHERE approver_id = $1 AND status = 'Pending' AND request_date < NOW() - INTERVAL '5 days'",
      [userId]
    );
    
    res.json({
      pending: parseInt(pending.rows[0].count),
      approvedToday: parseInt(approvedToday.rows[0].count),
      rejectedToday: parseInt(rejectedToday.rows[0].count),
      overdue: parseInt(overdue.rows[0].count)
    });
  } catch (err) {
    console.error("Get approval stats error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const approveRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    const query = `
      UPDATE approvals 
      SET status = 'Approved', decision_date = NOW(), approver_id = $1
      WHERE id = $2
      RETURNING *
    `;
    
    const result = await pool.query(query, [userId, id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Approve request error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const rejectRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;
    const userId = req.user.id;
    
    const query = `
      UPDATE approvals 
      SET status = 'Rejected', decision_date = NOW(), approver_id = $1, comments = $2
      WHERE id = $3
      RETURNING *
    `;
    
    const result = await pool.query(query, [userId, comment, id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Reject request error:", err);
    res.status(500).json({ error: err.message });
  }
};

export const bulkApprove = async (req, res) => {
  try {
    const { ids } = req.body;
    const userId = req.user.id;
    
    const query = `
      UPDATE approvals 
      SET status = 'Approved', decision_date = NOW(), approver_id = $1
      WHERE id = ANY($2::int[])
      RETURNING *
    `;
    
    const result = await pool.query(query, [userId, ids]);
    res.json({ count: result.rowCount, approvals: result.rows });
  } catch (err) {
    console.error("Bulk approve error:", err);
    res.status(500).json({ error: err.message });
  }
};
