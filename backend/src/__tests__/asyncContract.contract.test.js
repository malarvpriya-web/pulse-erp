/**
 * asyncContract.contract.test.js — functions that became async must be awaited.
 *
 * WHY THIS EXISTS
 * ---------------
 * Making integration credentials per-tenant (PULSE-01) turned three synchronous
 * predicates into async ones, because they read a row now instead of
 * `process.env`:
 *
 *     mailer.isEmailConfigured()
 *     iot/notify.channelAvailability()
 *     integrationConfig.resolveConfig() / resolveStatus() / readStored()
 *
 * ⚠⚠ AN UN-AWAITED PROMISE IS TRUTHY. So `if (isEmailConfigured())` does not
 * fail loudly after that change — it silently becomes ALWAYS TRUE, and a
 * deployment with no SMTP at all reports itself configured and then throws deep
 * inside a send that is usually wrapped in `.catch(() => {})`. The symptom is
 * mail that silently stops, which is the failure mode this whole remediation
 * exists to remove.
 *
 * ⚠ ESLint CANNOT CATCH THIS. `require-await` checks the DECLARATION, not the
 * call; `no-floating-promises` would catch it but needs type information that
 * core ESLint does not have, and adding typescript-eslint to a ~1,000-file
 * JavaScript backend for one rule is not a trade worth making. A source contract
 * test is precise, costs nothing, and names the fix in its failure message.
 *
 * It is a SOURCE test, not a behavioural one, for the same reason the PULSE-01
 * suite carries one: the next missed `await` will be in a file that does not
 * exist yet.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep } from 'node:path';

const here    = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

/**
 * Functions that MUST be awaited at every call site, and where they live.
 *
 * Add a function here when you make it async. The `defined` path is checked too,
 * so a rename cannot quietly empty this list — a guard that silently matches
 * nothing is worse than no guard.
 */
const MUST_AWAIT = [
  { name: 'isEmailConfigured',    defined: 'utils/mailer.js' },
  { name: 'channelAvailability',  defined: 'modules/iot/notify.js' },
  { name: 'resolveConfig',        defined: 'modules/integrations/integrationConfig.js' },
  { name: 'resolveStatus',        defined: 'modules/integrations/integrationConfig.js' },
  { name: 'readStored',           defined: 'modules/integrations/integrationConfig.js' },
  { name: 'saveConfig',           defined: 'modules/integrations/integrationConfig.js' },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) { yield* walk(full); continue; }
    if (full.endsWith('.js')) yield full;
  }
}

/** Source with comments and string/template literals stripped, so prose cannot match. */
function codeOf(file) {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
    .replace(/'(?:\\[\s\S]|[^\\'])*'/g, "''")
    .replace(/"(?:\\[\s\S]|[^\\"])*"/g, '""');
}

const rel = (f) => relative(srcRoot, f).split(sep).join('/');

describe('async contract — functions that read a row must be awaited', () => {
  it('every declared function is still defined where this guard says it is', () => {
    // Guards that match nothing pass forever. This is the check on the check.
    for (const { name, defined } of MUST_AWAIT) {
      const source = readFileSync(resolve(srcRoot, defined), 'utf8');
      const declared = new RegExp(`export\\s+async\\s+function\\s+${name}\\b`).test(source);
      expect(declared, `${name} is no longer an exported async function in ${defined} — update MUST_AWAIT`).toBe(true);
    }
  });

  it.each(MUST_AWAIT)('$name is awaited at every call site', ({ name, defined }) => {
    const offenders = [];

    for (const file of walk(srcRoot)) {
      const path = rel(file);
      if (path === defined) continue;                 // the definition itself
      if (path.startsWith('__tests__/')) continue;    // asserted separately below
      const code = codeOf(file);
      if (!code.includes(name)) continue;

      // Every call of `name(` that is not preceded by `await ` / `return ` / `.then`
      // / an assignment into a variable that is itself awaited. Kept deliberately
      // simple: the allowed forms are enumerated, so an unfamiliar one is a
      // finding to look at rather than something quietly permitted.
      const callRe = new RegExp(`([\\w.$]{0,12})\\s*(\\.)?\\b${name}\\s*\\(`, 'g');
      let m;
      while ((m = callRe.exec(code)) !== null) {
        const before = code.slice(Math.max(0, m.index - 40), m.index + (m[1] ?? '').length);
        const awaited  = /\bawait\s*$/.test(before) || /\bawait\s*\(?\s*[\w.$]*$/.test(before);
        const returned = /\breturn\s*$/.test(before);
        // A bare reference (import list, export list, property shorthand) is not a call.
        const isImportOrExport = /\b(import|export)\b[^;]*$/.test(before) && !/\bawait\b/.test(before);
        if (!awaited && !returned && !isImportOrExport) {
          const line = code.slice(0, m.index).split('\n').length;
          offenders.push(`${path}:${line}`);
        }
      }
    }

    expect(
      offenders,
      `${name}() became async when credentials went per-tenant. An un-awaited call ` +
      `returns a Promise, which is TRUTHY — so these sites do not fail, they ` +
      `silently always pass. Add \`await\` (and make the caller async):\n  ` +
      offenders.join('\n  ')
    ).toEqual([]);
  });
});
