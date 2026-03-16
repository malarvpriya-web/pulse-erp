import * as service from "./employee.service.js";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const addEmployee = async (req, res) => {
  try {
    console.log("📥 POST /api/employees received");
    console.log("👤 User info:", req.user);
    console.log("📋 req.body keys:", req.body ? Object.keys(req.body).slice(0, 10) : "EMPTY");
    console.log("📎 req.files:", req.files ? `${req.files.length} files` : "No files");
    
    // Handle file uploads
    const uploadDir = path.join(__dirname, "../../uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const fileFields = {};
    if (req.files && req.files.length > 0) {
      req.files.forEach(file => {
        const fileName = `${Date.now()}_${file.originalname}`;
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, file.buffer);
        fileFields[file.fieldname] = `/uploads/${fileName}`;
      });
    }

    const employeeData = { ...req.body, ...fileFields };
    const emp = await service.addEmployee(employeeData);
    console.log("✅ Employee added successfully with ID:", emp.id);
    res.json(emp);
  } catch (err) {
    console.error("❌ ADD EMPLOYEE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const getEmployees = async (req, res) => {
  try {
    console.log("📥 GET /api/employees received");
    console.log("👤 User info:", req.user);
    const employees = await service.getEmployees();
    console.log("✅ Fetched", employees.length, "employees");
    res.json(employees);
  } catch (err) {
    console.error("❌ GET EMPLOYEES ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const getNextEmployeeCode = async (req, res) => {
  try {
    const code = await service.getNextEmployeeCode();
    res.json({ code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateEmployee = async (req, res) => {
  try {
    console.log("📥 PUT /api/employees/:id received");
    console.log("👤 User info:", req.user);
    console.log("📋 Employee ID:", req.params.id);
    console.log("📋 req.body keys:", req.body ? Object.keys(req.body).slice(0, 10) : "EMPTY");
    
    const emp = await service.updateEmployee(req.params.id, req.body);
    console.log("✅ Employee updated successfully with ID:", emp.id);
    res.json(emp);
  } catch (err) {
    console.error("❌ UPDATE EMPLOYEE ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
};

export const deleteEmployee = async (req, res) => {
  try {
    await service.deleteEmployee(req.params.id);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};