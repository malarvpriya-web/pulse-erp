import jwt from "jsonwebtoken";

export const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader)
    return res.status(401).json({ error: "Session expired" });

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "mysupersecretkey");
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired" });
  }
};

export const allowRoles = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: "Access denied" });

    next();
  };
};

export const checkPermission = (module, action) => {
  return async (req, res, next) => {
    try {
      const pool = (await import("../config/db.js")).default;
      const result = await pool.query(
        `SELECT ${action} FROM permissions WHERE user_id = $1 AND module = $2`,
        [req.user.userId, module]
      );

      if (result.rows.length === 0 || !result.rows[0][action]) {
        return res.status(403).json({ error: "Access denied" });
      }

      next();
    } catch (err) {
      return res.status(500).json({ error: "Permission check failed" });
    }
  };
};