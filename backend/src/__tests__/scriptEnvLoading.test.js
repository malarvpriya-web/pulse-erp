/**
 * Operational scripts: a value already in the environment wins over backend/.env,
 * and the database is chosen the way the app chooses it (DB-01, manual §245, §246).
 *
 * pre-deploy.js and post-deploy.js connect, and take backups, when they run, so
 * they are never executed here. Each script's real code is lifted from its source
 * and run on its own, against a temporary .env and a fake environment. No database,
 * no network, and the real .env is never read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbTarget, pgToolEnv, requiredDeployEnv, dbTargetOverrides } from '../config/dbTarget.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(here, '../../scripts');
const CHECKED = ['pre-deploy.js', 'post-deploy.js', 'generate-baseline.js', 'db-backup.js', 'db-restore.js'];
const source = (file) => readFileSync(path.join(SCRIPTS, file), 'utf8').replace(/\r\n/g, '\n');

/** The script's own loader and target line, exactly as written. */
function liftFrom(file) {
  const src = source(file);
  const start = src.indexOf("const dotenvPath = path.join(__dirname, '../.env');");
  expect(start, `${file}: loader not found`).toBeGreaterThan(-1);
  const loaderEnd = src.indexOf('\n}\n', start);
  const target = 'const DB = resolveDbTarget(process.env);';
  expect(src, `${file}: does not resolve its target`).toContain(target);
  return `${src.slice(start, loaderEnd + 3)}\n${target}\nreturn DB;`;
}

/** Run it with __dirname pointing at a temporary tree whose ../.env is the given text. */
function run(file, envFileText, env) {
  const root = mkdtempSync(path.join(tmpdir(), 'pulse-env-'));
  try {
    const dir = path.join(root, 'scripts');
    fs.mkdirSync(dir);
    if (envFileText !== null) writeFileSync(path.join(root, '.env'), envFileText);
    const fakeProcess = { env: { ...env } };
    const DB = new Function('fs', 'path', '__dirname', 'process', 'resolveDbTarget', liftFrom(file))(fs, path, dir, fakeProcess, resolveDbTarget);
    return { DB, env: fakeProcess.env };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ENV_FILE = [
  '# a comment',
  'DB_HOST=env-file-host',
  'DB_PORT=5999',
  'DB_NAME=env_file_db',
  'DB_USER=env_file_user',
  'DB_PASSWORD=env=file=secret',
  'JWT_SECRET=from-the-file',
  '',
].join('\n');
const URL_ENV = 'postgresql://url_user:s%40cret%2Fx@url-host:6543/url_db?sslmode=require';

describe.each(CHECKED)('%s', (file) => {
  it('explicit credentials are never overwritten by .env', () => {
    const { DB, env } = run(file, ENV_FILE, {
      DB_HOST: 'explicit-host', DB_PORT: '6000', DB_NAME: 'explicit_db', DB_USER: 'explicit_user', DB_PASSWORD: 'explicit-secret',
    });
    expect(DB).toMatchObject({ host: 'explicit-host', port: '6000', name: 'explicit_db', user: 'explicit_user', password: 'explicit-secret' });
    expect(env.DB_PASSWORD).toBe('explicit-secret');
  });

  it('with only some values explicit, the rest still come from .env', () => {
    const { DB, env } = run(file, ENV_FILE, { DB_USER: 'explicit_user', DB_PASSWORD: 'explicit-secret' });
    expect(DB).toMatchObject({ host: 'env-file-host', port: '5999', name: 'env_file_db', user: 'explicit_user', password: 'explicit-secret' });
    expect(env.JWT_SECRET).toBe('from-the-file');
  });

  it('with nothing explicit, .env is the local fallback, comments skipped and = in values kept', () => {
    const { DB, env } = run(file, ENV_FILE, {});
    expect(DB).toMatchObject({ host: 'env-file-host', port: '5999', name: 'env_file_db', user: 'env_file_user', password: 'env=file=secret' });
    expect(Object.keys(env)).not.toContain('# a comment');
  });

  it('a Windows-format .env loads the same way', () => {
    const { DB } = run(file, ENV_FILE.replace(/\n/g, '\r\n'), {});
    expect(DB).toMatchObject({ password: 'env=file=secret', user: 'env_file_user' });
  });

  it('an explicitly empty value is respected, not replaced', () => {
    const { env } = run(file, ENV_FILE, { DB_PASSWORD: '' });
    expect(env.DB_PASSWORD).toBe('');
  });

  it('missing everywhere: no .env and no environment falls to the documented defaults', () => {
    const { DB, env } = run(file, null, {});
    expect(DB).toMatchObject({ host: 'localhost', port: '5432', name: 'Pulse', user: 'postgres', password: '' });
    expect(env).toEqual({});
  });

  it('DATABASE_URL in the environment selects the database, as the app does', () => {
    const { DB } = run(file, ENV_FILE, { DATABASE_URL: URL_ENV });
    expect(DB).toMatchObject({ host: 'url-host', port: '6543', name: 'url_db', user: 'url_user', password: 's@cret/x', sslmode: 'require' });
  });

  it('DATABASE_URL in .env is honoured as a fallback', () => {
    const { DB } = run(file, `DATABASE_URL=${URL_ENV}\nDB_HOST=ignored\n`, {});
    expect(DB).toMatchObject({ host: 'url-host', name: 'url_db' });
  });

  it('imports the shared resolver from a path that exists', () => {
    const m = source(file).match(/from '(\.\.\/src\/config\/dbTarget\.js)'/);
    expect(m, `${file}: no import of dbTarget`).toBeTruthy();
    expect(existsSync(path.resolve(SCRIPTS, m[1]))).toBe(true);
    expect(source(file)).toMatch(/pgToolEnv\(DB, process\.env\)/);
  });
});

describe('every hand-written .env loader in scripts/', () => {
  // An assignment alone on its line must sit directly under an if that tests the same key.
  const unguarded = (src) => {
    const lines = src.replace(/\r\n/g, '\n').split('\n');
    return lines.filter((line, i) => /^\s*process\.env\[k\.trim\(\)\]\s*=/.test(line)
      && !/^\s*if \(.*process\.env\[k\.trim\(\)\]/.test(lines[i - 1] ?? ''));
  };

  it('none assigns over the environment without checking', () => {
    const offenders = readdirSync(SCRIPTS)
      .filter((f) => /\.(m?js|cjs)$/.test(f))
      .filter((f) => unguarded(readFileSync(path.join(SCRIPTS, f), 'utf8')).length > 0);
    expect(offenders).toEqual([]);
  });

  it('the check itself tells a guarded assignment from an unguarded one', () => {
    const assign = "    process.env[k.trim()] = rest.join('=').trim();";
    expect(unguarded(`for (const line of vars) {\n${assign}\n}`)).toHaveLength(1);
    expect(unguarded(`    if (!process.env[k.trim()]) {\n${assign}\n    }`)).toHaveLength(0);
    expect(unguarded(`    if (process.env[k.trim()] === undefined) process.env[k.trim()] = rest.join('=').trim();`)).toHaveLength(0);
  });
});

describe('resolveDbTarget', () => {
  it('prefers DATABASE_URL over DB_*', () => {
    expect(resolveDbTarget({ DATABASE_URL: URL_ENV, DB_HOST: 'other' })).toMatchObject({ host: 'url-host', source: 'DATABASE_URL' });
  });
  it('defaults the port and leaves sslmode unset when the URL has neither', () => {
    expect(resolveDbTarget({ DATABASE_URL: 'postgresql://u:p@h/db' })).toMatchObject({ port: '5432', sslmode: undefined, name: 'db' });
  });
  it('a malformed URL is refused without repeating it', () => {
    let message = '';
    try { resolveDbTarget({ DATABASE_URL: 'not a url with secret-pw' }); } catch (e) { message = e.message; }
    expect(message).toMatch(/not a valid connection URL/);
    expect(message).not.toContain('secret-pw');
  });
  it('pgToolEnv passes the password, and sslmode only when there is one', () => {
    expect(pgToolEnv({ password: 'p', sslmode: 'require' }, { A: '1' })).toEqual({ A: '1', PGPASSWORD: 'p', PGSSLMODE: 'require' });
    expect(pgToolEnv({ password: 'p' }, {})).toEqual({ PGPASSWORD: 'p' });
  });
});

describe('pre-deploy required variables', () => {
  it('with DATABASE_URL, the DB_* parts are not demanded', () => {
    expect(requiredDeployEnv({ DATABASE_URL: URL_ENV })).toEqual(['JWT_SECRET']);
  });
  it('without it, they are', () => {
    expect(requiredDeployEnv({})).toEqual(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET']);
  });
  it('pre-deploy.js uses this list', () => {
    expect(source('pre-deploy.js')).toMatch(/const required = requiredDeployEnv\(process\.env\);/);
  });
});

describe('a target that differs from .env is warned about', () => {
  const FILE = 'DB_HOST=localhost\nDB_NAME=Pulse\nDB_USER=postgres\nDB_PASSWORD=file-secret\n';
  it('nothing to say when they agree', () => {
    expect(dbTargetOverrides({ DB_HOST: 'localhost', DB_NAME: 'Pulse', DB_USER: 'postgres', DB_PASSWORD: 'file-secret' }, FILE)).toEqual([]);
  });
  it('a different database and login are named', () => {
    const notes = dbTargetOverrides({ DB_HOST: 'localhost', DB_NAME: 'other', DB_USER: 'pulse_backup', DB_PASSWORD: 'file-secret' }, FILE);
    expect(notes).toEqual([
      'DB_NAME="other" from the environment, not "Pulse" from .env',
      'DB_USER="pulse_backup" from the environment, not "postgres" from .env',
    ]);
  });
  it('a password or URL is named but its value never shown', () => {
    const notes = dbTargetOverrides({ DB_PASSWORD: 'explicit-secret' }, FILE).concat(dbTargetOverrides({ DATABASE_URL: URL_ENV }, FILE));
    expect(notes).toHaveLength(2);
    const text = notes.join(' ');
    for (const secret of ['explicit-secret', 'file-secret', 's%40cret', 'url-host']) expect(text).not.toContain(secret);
  });
  it('with no .env there is nothing to differ from, so a hosted URL does not fail --strict', () => {
    expect(dbTargetOverrides({ DB_NAME: 'other' }, '')).toEqual([]);
    expect(dbTargetOverrides({ DATABASE_URL: URL_ENV }, '')).toEqual([]);
    expect(dbTargetOverrides({ DATABASE_URL: URL_ENV }, 'JWT_SECRET=x\n')).toEqual([]);
  });
  it('a URL that agrees with .env is not reported', () => {
    expect(dbTargetOverrides({ DATABASE_URL: URL_ENV }, `DATABASE_URL=${URL_ENV}\n`)).toEqual([]);
  });
  it.each(['pre-deploy.js', 'post-deploy.js'])('%s reports them', (file) => {
    expect(source(file)).toMatch(/for \(const note of dbTargetOverrides\(process\.env, /);
  });
});

describe.each(['pre-deploy.js', 'post-deploy.js'])('%s fileChecksum', (file) => {
  const lift = () => {
    const src = source(file);
    const start = src.indexOf('function fileChecksum(filePath) {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', start);
    return new Function('fs', 'crypto', `${src.slice(start, end + 3)}\nreturn fileChecksum;`)(fs, crypto);
  };
  const runnerHash = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

  it('a Windows checkout of a migration hashes the same, and matches what the runner records', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pulse-sum-'));
    try {
      const lf = path.join(root, 'lf.js'), crlf = path.join(root, 'crlf.js');
      writeFileSync(lf, 'line one\nline two\n');
      writeFileSync(crlf, 'line one\r\nline two\r\n');
      const fn = lift();
      expect(fn(crlf)).toBe(fn(lf));
      expect(fn(crlf)).toBe(runnerHash('line one\nline two\n'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a real content change still shows', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pulse-sum-'));
    try {
      const a = path.join(root, 'a.js'), b = path.join(root, 'b.js');
      writeFileSync(a, 'one\n');
      writeFileSync(b, 'two\n');
      const fn = lift();
      expect(fn(a)).not.toBe(fn(b));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
