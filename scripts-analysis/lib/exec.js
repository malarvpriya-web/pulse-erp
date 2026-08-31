/**
 * Manifest Analyzer — process runner + step logger.
 *
 * All external tools are launched as `node <tool-entry>` with shell:false, so
 * arguments are passed as an argv array and never re-parsed by cmd.exe. A tool
 * that is missing, crashes, or exits non-zero degrades into a recorded result
 * instead of aborting the run — a partial report beats no report.
 */
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ROOT } from './config.js';

const MAX_BUFFER = 64 * 1024 * 1024; // dependency-cruiser JSON on this repo is large.

/**
 * Run `node <args>` and capture output. Never throws.
 * @returns {{ok:boolean, code:number|null, stdout:string, stderr:string, error:string|null, ms:number}}
 */
export function runNode(args, { cwd = ROOT, env = {} } = {}) {
  const started = performance.now();
  const res = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const ms = Math.round(performance.now() - started);
  return {
    ok: !res.error && res.status === 0,
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? res.error.message : null,
    ms,
  };
}

/** Run an arbitrary binary (used for `npm audit`). Never throws. */
export function runCmd(cmd, args, { cwd = ROOT } = {}) {
  const started = performance.now();
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    // npm on Windows is a .cmd shim, which requires a shell to launch.
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  const ms = Math.round(performance.now() - started);
  return {
    ok: !res.error && res.status === 0,
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    error: res.error ? res.error.message : null,
    ms,
  };
}

/** Collects timing + status for every step so the run can be summarised and logged. */
export class RunLog {
  constructor() {
    this.entries = [];
    this.startedAt = new Date();
  }

  record(step, status, detail = '', ms = 0) {
    const entry = { step, status, detail, ms, at: new Date().toISOString() };
    this.entries.push(entry);
    const icon = { ok: '[ok]', warn: '[warn]', fail: '[fail]', skip: '[skip]' }[status] ?? '[..]';
    const timing = ms ? ` (${(ms / 1000).toFixed(1)}s)` : '';
    console.log(`  ${icon} ${step}${timing}${detail ? ` — ${detail}` : ''}`);
    return entry;
  }

  ok(step, detail, ms) { return this.record(step, 'ok', detail, ms); }
  warn(step, detail, ms) { return this.record(step, 'warn', detail, ms); }
  fail(step, detail, ms) { return this.record(step, 'fail', detail, ms); }
  skip(step, detail) { return this.record(step, 'skip', detail, 0); }

  get counts() {
    return this.entries.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {});
  }

  toText() {
    const lines = [
      `Manifest Analyzer run log`,
      `Started: ${this.startedAt.toISOString()}`,
      `Finished: ${new Date().toISOString()}`,
      '',
    ];
    for (const e of this.entries) {
      lines.push(`${e.at}  ${e.status.toUpperCase().padEnd(5)}  ${e.step}${e.ms ? ` (${e.ms}ms)` : ''}`);
      if (e.detail) lines.push(`${' '.repeat(31)}${e.detail}`);
    }
    lines.push('', `Totals: ${JSON.stringify(this.counts)}`);
    return `${lines.join('\n')}\n`;
  }
}
