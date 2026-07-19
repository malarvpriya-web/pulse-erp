// Set required env vars before any module imports
process.env.JWT_SECRET = 'test-secret-for-vitest-suite-minimum-32-chars';
process.env.NODE_ENV   = 'test';
process.env.DB_PASSWORD = 'test-db-password';
