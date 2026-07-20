import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
// Two levels up from src/middlewares lands at the backend root (= /app in the
// container). A third '..' escaped to the container filesystem root, which is
// only writable by root — the non-root `node` user hit EACCES there at boot
// (this file's mkdirSync runs at import time and is unconditional whenever
// NODE_ENV=production, so it crashed every production/compose boot).
const LOGS_DIR   = path.join(__dirname, '../../logs');
const ERROR_LOG  = path.join(LOGS_DIR, 'errors.log');
const LOG_TO_FILE = process.env.LOG_TO_FILE === 'true' || process.env.NODE_ENV === 'production';

if (LOG_TO_FILE) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const status    = err.status || err.statusCode || 500;
  const message   = status < 500 ? err.message : 'Internal server error';
  const requestId = req.id || 'unknown';

  const entry = JSON.stringify({
    ts:        new Date().toISOString(),
    level:     'ERROR',
    requestId,
    method:    req.method,
    path:      req.path,
    status,
    error:     err.message,
    stack:     process.env.NODE_ENV !== 'production' ? err.stack : undefined,
    userId:    req.user?.userId ?? null,
  });

  console.error(entry);
  if (LOG_TO_FILE) {
    fs.appendFile(ERROR_LOG, entry + '\n', () => {});
  }

  if (res.headersSent) return;
  res.status(status).json({ error: message, requestId });
};
