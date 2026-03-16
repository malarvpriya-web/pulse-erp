import express from "express";
import { login, register, getPermissions } from "./auth.controller.js";
import { verifyToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/login", login);
router.post("/register", register);
router.get("/permissions", verifyToken, getPermissions);

export default router;