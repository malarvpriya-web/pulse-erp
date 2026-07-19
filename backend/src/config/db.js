import pkg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool, types } = pkg;

// DATE columns (OID 1082): return the raw 'YYYY-MM-DD' string instead of a JS
// Date. pg's default parser builds a Date at LOCAL midnight, which res.json()
// then serialises via toISOString() to UTC — shifting the day back by one for
// any timezone ahead of UTC (e.g. IST +5:30: 2026-09-18 -> 2026-09-17T18:30Z).
// Keeping it as a string means dob / joining_date / etc. round-trip unchanged.
types.setTypeParser(1082, (val) => val);

const isProduction = process.env.NODE_ENV === "production";

if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
  throw new Error(
    "Database not configured. Set DATABASE_URL (Render/Neon/Supabase connection string) " +
    "or set DB_PASSWORD (plus optional DB_HOST, DB_NAME, DB_USER, DB_PORT) in your .env file."
  );
}

// In production without DATABASE_URL, require DB_HOST to be explicitly set so
// we never silently connect to localhost instead of the real database server.
if (!process.env.DATABASE_URL && isProduction && !process.env.DB_HOST) {
  throw new Error(
    "DB_HOST is required in production when DATABASE_URL is not set. " +
    "Set DATABASE_URL or provide DB_HOST, DB_NAME, DB_USER, DB_PASSWORD, DB_PORT."
  );
}

const POOL_OPTS = {
  max:                     30,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 15000,  // increased: cold-start has many concurrent module inits
  query_timeout:          30000,
};

// Managed Postgres (Render/Neon/Supabase) presents certs that fail default
// validation, so we disable it by default. Set DB_SSL_REJECT_UNAUTHORIZED=true
// once a proper CA is pinned to enforce certificate validation (MITM protection).
const rejectUnauthorized = String(process.env.DB_SSL_REJECT_UNAUTHORIZED).toLowerCase() === 'true';
const sslConfig = { rejectUnauthorized };

// DB_SSL=false turns SSL off entirely, for Postgres servers that don't speak
// it at all: the docker-compose db service and CI's postgres:16-alpine both
// refuse SSL handshakes, so forcing ssl here makes every connection fail with
// "The server does not support SSL connections". Unset or any other value
// keeps SSL on wherever it previously applied (managed Postgres unchanged).
const sslDisabled = String(process.env.DB_SSL).toLowerCase() === 'false';

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslDisabled ? false : sslConfig,   // required by Render / Neon / Supabase
      ...POOL_OPTS,
    })
  : new Pool({
      user:     process.env.DB_USER  || "postgres",
      host:     process.env.DB_HOST  || "localhost",
      database: process.env.DB_NAME  || "Pulse",
      password: process.env.DB_PASSWORD,
      port:     parseInt(process.env.DB_PORT || "5432"),
      ...(isProduction && !sslDisabled && { ssl: sslConfig }),
      ...POOL_OPTS,
    });

pool.on("error", (err) => {
  console.error("Unexpected DB pool error:", err.message);
});

export default pool;
