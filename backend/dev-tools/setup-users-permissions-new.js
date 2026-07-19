import pool from "./src/config/db.js";
import bcrypt from "bcryptjs";

async function setupUsersAndPermissions() {
  try {
    console.log("🔧 Setting up users and permissions tables...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL CHECK (role IN ('employee', 'manager', 'department_head', 'admin', 'super_admin')),
        department VARCHAR(100),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("✅ Users table created");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        module VARCHAR(100) NOT NULL CHECK (module IN ('employees', 'finance', 'projects', 'reports', 'inventory', 'announcements', 'policies', 'downloads', 'leave', 'travel', 'service')),
        can_view BOOLEAN DEFAULT false,
        can_add BOOLEAN DEFAULT false,
        can_edit BOOLEAN DEFAULT false,
        can_delete BOOLEAN DEFAULT false,
        can_approve BOOLEAN DEFAULT false,
        can_export BOOLEAN DEFAULT false,
        UNIQUE(user_id, module)
      );
    `);
    console.log("✅ Permissions table created");

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_permissions_module ON permissions(module);
    `);
    console.log("✅ Indexes created");

    const password = await bcrypt.hash("password123", 10);
    
    await pool.query(`
      INSERT INTO users (name, email, password_hash, role, department, is_active)
      VALUES 
        ('Super Admin', 'superadmin@company.com', $1, 'super_admin', 'Executive', true),
        ('Admin User', 'admin@company.com', $1, 'admin', 'HR', true),
        ('Department Head', 'depthead@company.com', $1, 'department_head', 'Finance', true),
        ('Manager User', 'manager@company.com', $1, 'manager', 'Sales', true),
        ('Employee User', 'employee@company.com', $1, 'employee', 'Engineering', true)
      ON CONFLICT (email) DO NOTHING;
    `, [password]);
    console.log("✅ Test users created");

    const modules = ['employees', 'finance', 'projects', 'reports', 'inventory', 'announcements', 'policies', 'downloads', 'leave', 'travel', 'service'];
    
    for (let userId = 1; userId <= 5; userId++) {
      for (const module of modules) {
        let permissions = { view: false, add: false, edit: false, del: false, approve: false, exp: false };
        
        if (userId === 1) {
          permissions = { view: true, add: true, edit: true, del: true, approve: true, exp: true };
        } else if (userId === 2) {
          permissions = { view: true, add: true, edit: true, del: true, approve: true, exp: true };
        } else if (userId === 3) {
          permissions = { view: true, add: true, edit: true, del: false, approve: true, exp: true };
        } else if (userId === 4) {
          permissions = { view: true, add: true, edit: true, del: false, approve: false, exp: true };
        } else if (userId === 5) {
          permissions = { view: true, add: false, edit: false, del: false, approve: false, exp: false };
        }
        
        await pool.query(`
          INSERT INTO permissions (user_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (user_id, module) DO NOTHING;
        `, [userId, module, permissions.view, permissions.add, permissions.edit, permissions.del, permissions.approve, permissions.exp]);
      }
    }
    console.log("✅ Permissions created for all users");

    console.log("\n📋 Test Users:");
    console.log("  superadmin@company.com / password123 (super_admin)");
    console.log("  admin@company.com / password123 (admin)");
    console.log("  depthead@company.com / password123 (department_head)");
    console.log("  manager@company.com / password123 (manager)");
    console.log("  employee@company.com / password123 (employee)");
    console.log("\n🎉 Setup complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

setupUsersAndPermissions();
