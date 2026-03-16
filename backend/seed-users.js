import pool from "./src/config/db.js";
import bcrypt from "bcryptjs";

async function seedUsers() {
  try {
    console.log("🌱 Creating users table if not exists...");
    
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    console.log("✅ Users table ready");
    
    // Hash password for test user
    const hashedPassword = await bcrypt.hash("password123", 10);
    
    // Insert test user
    const result = await pool.query(
      `INSERT INTO users (email, password, role) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (email) DO UPDATE SET password = $2
       RETURNING id, email, role;`,
      ["test@pulse.com", hashedPassword, "admin"]
    );
    
    console.log("✅ Test user created/updated:");
    console.log("   Email: test@pulse.com");
    console.log("   Password: password123");
    console.log("   Role: admin");
    console.log("\n🎉 Seeding complete!");
    
  } catch (err) {
    console.error("❌ Error seeding users:", err.message);
  } finally {
    process.exit(0);
  }
}

seedUsers();
