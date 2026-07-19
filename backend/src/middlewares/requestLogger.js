import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR   = path.join(__dirname, '../../../logs');
const ACCESS_LOG = path.join(LOGS_DIR, 'access.log');

// In production, Render/Railway capture stdout — never write to the container filesystem
// (logs would be lost on restart). Only write to file in development when explicitly opted in.
const LOG_TO_FILE = process.env.NODE_ENV !== 'production' && process.env.LOG_TO_FILE === 'true';

if (LOG_TO_FILE) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function write(line) {
  if (LOG_TO_FILE) {
    fs.appendFile(ACCESS_LOG, line + '\n', () => {});
  }
}

// Paths that are too noisy to log individually
const SKIP_PATHS = new Set(['/api/health', '/']);

export const requestLogger = (req, res, next) => {
  const start = Date.now();
  if (SKIP_PATHS.has(req.path)) return next();

  res.on('finish', () => {
    const ms      = Date.now() - start;
    const status  = res.statusCode;
    const level   = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
    const entry   = JSON.stringify({
      ts:        new Date().toISOString(),
      level,
      requestId: req.id,
      method:    req.method,
      path:      req.path,
      status,
      ms,
      ip:        req.ip || req.headers['x-forwarded-for'],
      userId:    req.user?.userId ?? null,
    });

    if (level === 'ERROR') {
      console.error(entry);
    } else if (level === 'WARN') {
      console.warn(entry);
    } else if (process.env.NODE_ENV !== 'test') {
      console.log(entry);
    }

    write(entry);
  });

  next();
};
