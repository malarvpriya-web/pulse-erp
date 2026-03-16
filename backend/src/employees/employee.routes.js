import express from "express";
import { addEmployee, getEmployees, updateEmployee, getNextEmployeeCode } from "./employee.controller.js";
import { verifyToken, allowRoles } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/", verifyToken, allowRoles("admin"), getEmployees);
router.get("/next-code", verifyToken, allowRoles("admin"), getNextEmployeeCode);
router.post("/", verifyToken, allowRoles("admin"), addEmployee);
router.put("/:id", verifyToken, allowRoles("admin"), updateEmployee);

export default router;