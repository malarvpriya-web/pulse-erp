import pool from "../config/db.js";

export const getActiveAnnouncements = async () => {
  const result = await pool.query(`
    SELECT id, title, message, created_by, created_at, expiry_date
    FROM announcements
    WHERE is_active = true 
    AND (expiry_date IS NULL OR expiry_date >= CURRENT_DATE)
    ORDER BY created_at DESC
  `);
  return result.rows;
};

export const getUpcomingEvents = async () => {
  const result = await pool.query(`
    SELECT id, title, department, event_date, description
    FROM events
    WHERE event_date >= CURRENT_DATE
    ORDER BY event_date ASC
    LIMIT 10
  `);
  return result.rows;
};

export const getTodaysCelebrations = async () => {
  const result = await pool.query(`
    SELECT 
      id,
      first_name,
      last_name,
      dob,
      joining_date,
      department,
      designation
    FROM employees
    WHERE status = 'Active'
  `);

  const today = new Date();
  const celebrations = [];

  result.rows.forEach(emp => {
    if (emp.dob) {
      const dob = new Date(emp.dob);
      if (dob.getMonth() === today.getMonth() && dob.getDate() === today.getDate()) {
        celebrations.push({
          id: emp.id,
          name: `${emp.first_name} ${emp.last_name}`,
          type: 'Birthday',
          department: emp.department,
          designation: emp.designation
        });
      }
    }

    if (emp.joining_date) {
      const joinDate = new Date(emp.joining_date);
      if (joinDate.getMonth() === today.getMonth() && 
          joinDate.getDate() === today.getDate() &&
          joinDate.getFullYear() < today.getFullYear()) {
        const years = today.getFullYear() - joinDate.getFullYear();
        celebrations.push({
          id: emp.id,
          name: `${emp.first_name} ${emp.last_name}`,
          type: 'Work Anniversary',
          years: years,
          department: emp.department,
          designation: emp.designation
        });
      }
    }
  });

  return celebrations;
};

export const getActivePolicies = async () => {
  const result = await pool.query(`
    SELECT id, name, version, file_url, updated_date, category
    FROM policies
    WHERE status = 'active'
    ORDER BY updated_date DESC
  `);
  return result.rows;
};

export const getResources = async () => {
  const result = await pool.query(`
    SELECT id, name, category, file_url, updated_date
    FROM downloads
    WHERE is_active = true
    ORDER BY category, name
  `);
  return result.rows;
};

export const getHolidays = async () => {
  const result = await pool.query(`
    SELECT id, name, date, description
    FROM holidays
    WHERE date >= CURRENT_DATE
    ORDER BY date ASC
  `);
  return result.rows;
};

export const getAllHolidays = async () => {
  const result = await pool.query(`
    SELECT id, name, date, description
    FROM holidays
    ORDER BY date ASC
  `);
  return result.rows;
};
