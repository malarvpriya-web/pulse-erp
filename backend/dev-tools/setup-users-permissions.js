import pool from "./src/config/db.js";
import bcrypt from "bcrypt";

async function setupUsersAndPermissions() {
  try {
    console.log("🔧 Setting up users and permissions tables...");

    // Create users table
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

    // Create permissions table
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

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_permissions_user_id ON permissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_permissions_module ON permissions(module);
    `);
    console.log("✅ Indexes created");

    // Seed sample users with bcrypt hashed passwords
    const password = await bcrypt.hash("password123", 10);
    
    await pool.query(`
      INSERT INTO users (name, email, password_hash, role, department, is_active)
      VALUES 
        ('Super Admin', 'superadmin@pulse.com', $1, 'super_admin', 'IT', true),
        ('Admin User', 'admin@pulse.com', $1, 'admin', 'HR', true),
        ('HR Head', 'hrhead@pulse.com', $1, 'department_head', 'HR', true),
        ('Finance Manager', 'financemanager@pulse.com', $1, 'manager', 'Finance', true),
        ('John Employee', 'john@pulse.com', $1, 'employee', 'Engineering', true)
      ON CONFLICT (email) DO NOTHING;
    `, [password]);
    console.log("✅ Sample users created");

    // Seed permissions for super_admin (user_id: 1)
    const modules = ['employees', 'finance', 'projects', 'reports', 'inventory', 'announcements', 'policies', 'downloads', 'leave', 'travel', 'service'];
    
    for (const module of modules) {
      await pool.query(`
        INSERT INTO permissions (user_id, module, can_view, can_add, can_edit, can_delete, can_approve, can_export)
        VALUES (1, $1, true, true, true, true, true, true)
        ON CONFLICT (user_id, module) DO NOTHING;
      `, [module]);
    }
    console.log("✅ Super admin permissions created");

    console.log("🎉 Setup complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

setupUsersAndPermissions();
