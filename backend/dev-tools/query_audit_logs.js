import pool from "./src/config/db.js";

pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'audit_logs'")
  .then(res => console.log(res.rows))
  .catch(err => console.error(err))
  .finally(() => process.exit(0));
