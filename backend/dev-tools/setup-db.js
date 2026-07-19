import pool from "./src/config/db.js";

async function setupDB() {
  try {
    // Test connection
    await pool.query("SELECT NOW()");
    console.log("✅ Database connected");

    // Check if employees table exists
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'employees'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log("📝 Creating employees table...");
      await pool.query(`
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          first_name VARCHAR(100) NOT NULL,
          last_name VARCHAR(100),
          company_email VARCHAR(255) UNIQUE NOT NULL,
          personal_email VARCHAR(255),
          phone VARCHAR(20),
          gender VARCHAR(20),
          blood_group VARCHAR(10),
          dob DATE,
          father_name VARCHAR(100),
          mother_name VARCHAR(100),
          spouse_name VARCHAR(100),
          current_address TEXT,
          permanent_address TEXT,
          highest_qualification VARCHAR(100),
          basic_qualification VARCHAR(100),
          department VARCHAR(100),
          designation VARCHAR(100),
          reporting_manager VARCHAR(100),
          location VARCHAR(100),
          joining_date DATE,
          employment_type VARCHAR(50),
          skill_type VARCHAR(50),
          zone VARCHAR(50),
          previous_company_1 VARCHAR(200),
          previous_role_1 VARCHAR(100),
          previous_years_1 INTEGER,
          previous_company_2 VARCHAR(200),
          previous_role_2 VARCHAR(100),
          previous_years_2 INTEGER,
          bank_name VARCHAR(100),
          branch_name VARCHAR(100),
          account_number VARCHAR(50),
          ifsc_code VARCHAR(20),
          nominee_name VARCHAR(100),
          emergency_name VARCHAR(100),
          emergency_phone VARCHAR(20),
          emergency_relationship VARCHAR(50),
          pan_number VARCHAR(20),
          aadhaar_number VARCHAR(20),
          pf_number VARCHAR(50),
          uan_number VARCHAR(50),
          esic_number VARCHAR(50),
          status VARCHAR(20) DEFAULT 'Active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log("✅ Employees table created");
    } else {
      console.log("✅ Employees table exists");
    }

    // Check row count
    const count = await pool.query("SELECT COUNT(*) FROM employees");
    console.log(`📊 Total employees: ${count.rows[0].count}`);

    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

setupDB();
