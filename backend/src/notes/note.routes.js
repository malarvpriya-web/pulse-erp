import express from "express";
import * as noteController from "./note.controller.js";
import { verifyToken } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/", verifyToken, noteController.createNote);
router.get("/:employeeId", verifyToken, noteController.getEmployeeNotes);

export default router;
