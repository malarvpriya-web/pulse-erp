import pkg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pkg;

const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  user:     process.env.DB_USER     || "postgres",
  host:     process.env.DB_HOST     || "localhost",
  database: process.env.DB_NAME     || "Pulse",
  password: process.env.DB_PASSWORD || "1234567890",
  port:     parseInt(process.env.DB_PORT || "5432"),
  ...(isProduction && {
    ssl: { rejectUnauthorized: false }, // required for Neon / Supabase / Render Postgres
  }),
});

pool.on("error", (err) => {
  console.error("Unexpected DB pool error:", err.message);
});

export default pool;
