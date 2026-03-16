import * as leaveService from "./leave.service.js";

export const createLeave = async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const employeeResult = await import("../config/db.js").then(m => m.default.query(
      "SELECT id FROM employees WHERE id = $1",
      [userId]
    ));
    
    if (employeeResult.rows.length === 0) {
      return res.status(404).json({ error: "Employee not found" });
    }
    
    const leave = await leaveService.createLeave(userId, req.body);
    res.status(201).json(leave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getMyLeaves = async (req, res) => {
  try {
    const userId = req.user.userId;
    const leaves = await leaveService.getMyLeaves(userId);
    res.json(leaves);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getTeamLeaves = async (req, res) => {
  try {
    const userId = req.user.userId;
    const leaves = await leaveService.getTeamLeaves(userId);
    res.json(leaves);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const getAllLeaves = async (req, res) => {
  try {
    const leaves = await leaveService.getAllLeaves();
    res.json(leaves);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const approveLeave = async (req, res) => {
  try {
    const { id } = req.params;
    const { manager_comment } = req.body;
    
    const leave = await leaveService.approveLeave(id, manager_comment || "");
    
    if (!leave) {
      return res.status(404).json({ error: "Leave not found" });
    }
    
    res.json(leave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const rejectLeave = async (req, res) => {
  try {
    const { id } = req.params;
    const { manager_comment } = req.body;
    
    const leave = await leaveService.rejectLeave(id, manager_comment || "");
    
    if (!leave) {
      return res.status(404).json({ error: "Leave not found" });
    }
    
    res.json(leave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
