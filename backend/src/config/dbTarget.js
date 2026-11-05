/**
 * Which database an operational tool talks to (DB-01, manual §246).
 *
 * The server and `npm run migrate` prefer DATABASE_URL (config/db.js). Tools that
 * read only DB_HOST and friends would go to localhost on a host that supplies just
 * the URL, so the deploy checks and backups could report on the wrong database.
 * pg_dump and psql take separate connection flags, so the URL is split here, with
 * the same precedence. Importing this file opens no connection.
 */
const DB_KEYS = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER'];

export function resolveDbTarget(env = process.env) {
  if (env.DATABASE_URL) {
    let u;
    // The URL holds a password, and a parse error would repeat it.
    try { u = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL is not a valid connection URL'); }
    return {
      host:     u.hostname,
      port:     u.port || '5432',
      name:     decodeURIComponent(u.pathname.slice(1)),
      user:     decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      sslmode:  u.searchParams.get('sslmode') || undefined,
      source:   'DATABASE_URL',
    };
  }
  return {
    host:     env.DB_HOST     || 'localhost',
    port:     env.DB_PORT     || '5432',
    name:     env.DB_NAME     || 'Pulse',
    user:     env.DB_USER     || 'postgres',
    password: env.DB_PASSWORD || '',
    source:   'DB_*',
  };
}

/** The environment for pg_dump, psql and friends. */
export function pgToolEnv(db, env = process.env) {
  return { ...env, PGPASSWORD: db.password, ...(db.sslmode ? { PGSSLMODE: db.sslmode } : {}) };
}

/** A deploy check needs a database target and a signing secret. */
export function requiredDeployEnv(env = process.env) {
  return env.DATABASE_URL ? ['JWT_SECRET'] : ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET'];
}

/**
 * Warnings for a target that differs from backend/.env. A value in the environment
 * wins on purpose, but one left over in a shell would otherwise pass unnoticed.
 * Passwords and URLs can hold secrets, so those are named but never shown. A host with
 * no .env target, the normal case with a supplied DATABASE_URL, has nothing to differ from.
 */
export function dbTargetOverrides(env, envFileText) {
  const file = {};
  for (const line of String(envFileText ?? '').split('\n')) {
    if (!line.trim() || line.startsWith('#') || !line.includes('=')) continue;
    const [k, ...rest] = line.split('=');
    file[k.trim()] = rest.join('=').trim();
  }
  const notes = [];
  const fileHasTarget = file.DATABASE_URL !== undefined || DB_KEYS.some((k) => file[k] !== undefined);
  if (env.DATABASE_URL && fileHasTarget && env.DATABASE_URL !== file.DATABASE_URL) {
    notes.push('DATABASE_URL in the environment selects the database; .env names a different target');
  }
  if (!env.DATABASE_URL) {
    for (const k of DB_KEYS) {
      if (file[k] !== undefined && env[k] !== undefined && env[k] !== file[k]) notes.push(`${k}="${env[k]}" from the environment, not "${file[k]}" from .env`);
    }
    if (file.DB_PASSWORD !== undefined && env.DB_PASSWORD !== undefined && env.DB_PASSWORD !== file.DB_PASSWORD) {
      notes.push('DB_PASSWORD from the environment differs from .env');
    }
  }
  return notes;
}
