import * as authService from "./auth.service.js";

export const register = async (req, res) => {
  try {
    const user = await authService.registerUser(
      req.body.name,
      req.body.email,
      req.body.password,
      req.body.role,
      req.body.department
    );
    res.json({
      message: "User created successfully",
      user,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

export const login = async (req, res) => {
  try {
    const data = await authService.loginUser(
      req.body.email,
      req.body.password
    );
    res.json(data);
  } catch (err) {
    console.error(err);
    const statusCode = err.message.includes("inactive") ? 403 : 401;
    res.status(statusCode).json({ error: err.message });
  }
};

export const getPermissions = async (req, res) => {
  try {
    const permissions = await authService.getUserPermissions(req.user.userId);
    res.json({ permissions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
