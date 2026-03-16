import pool from "./src/config/db.js";

async function addCelebrationTestData() {
  try {
    console.log("🎉 Adding test celebration data...");

    const today = new Date();
    const todayMonth = today.getMonth() + 1;
    const todayDay = today.getDate();
    
    // Birthday today
    const birthdayDate = new Date(1990, today.getMonth(), today.getDate());
    const birthdayStr = birthdayDate.toISOString().split('T')[0];
    
    // Work anniversary (joined 5 years ago today)
    const anniversaryDate = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());
    const anniversaryStr = anniversaryDate.toISOString().split('T')[0];

    // Add employee with birthday today
    await pool.query(`
      INSERT INTO employees (
        first_name, last_name, company_email, department, designation, 
        dob, joining_date, status
      ) VALUES (
        'John', 'Doe', 'john.doe@company.com', 'Finance', 'Senior Analyst',
        $1, '2020-01-15', 'Active'
      )
      ON CONFLICT (company_email) DO UPDATE 
      SET dob = $1
    `, [birthdayStr]);
    console.log("✅ Added employee with birthday today: John Doe");

    // Add employee with work anniversary today
    await pool.query(`
      INSERT INTO employees (
        first_name, last_name, company_email, department, designation,
        dob, joining_date, status
      ) VALUES (
        'Jane', 'Smith', 'jane.smith@company.com', 'HR', 'HR Manager',
        '1985-05-20', $1, 'Active'
      )
      ON CONFLICT (company_email) DO UPDATE 
      SET joining_date = $1
    `, [anniversaryStr]);
    console.log("✅ Added employee with work anniversary today: Jane Smith (5 years)");

    // Add employee with both birthday and work anniversary today
    await pool.query(`
      INSERT INTO employees (
        first_name, last_name, company_email, department, designation,
        dob, joining_date, status
      ) VALUES (
        'Mike', 'Johnson', 'mike.johnson@company.com', 'Engineering', 'Tech Lead',
        $1, $2, 'Active'
      )
      ON CONFLICT (company_email) DO UPDATE 
      SET dob = $1, joining_date = $2
    `, [birthdayStr, anniversaryStr]);
    console.log("✅ Added employee with birthday AND work anniversary today: Mike Johnson");

    console.log("\n🎊 Test celebration data added successfully!");
    console.log(`📅 Today's date: ${today.toDateString()}`);
    console.log(`📅 Birthday date set to: ${birthdayStr}`);
    console.log(`📅 Anniversary date set to: ${anniversaryStr}`);
    
    process.exit(0);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

addCelebrationTestData();
