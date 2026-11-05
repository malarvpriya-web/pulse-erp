/**
 * testTenantIds.contract.test.js — no two suites may claim the same test tenant.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * The convention here is that a suite needing an isolated tenant picks an id in
 * the 9999xx range and creates it with `ON CONFLICT (id) DO NOTHING`. That
 * conflict clause is what makes a collision silent: the second suite to run
 * gets the first one's company and never learns it, because the insert
 * succeeds. Three pairs had already drifted into sharing before this guard
 * existed:
 *
 *   999901  procurementIntegrity (ZZPRC)   + procurementLifecycle (ZZLCF)
 *   999904  procurementAnalytics (ZZANA)   + segregationOfDuties (ZZSOD)
 *   999907  deliveryFollowupCron (CO_A)    + tcoPortfolio (CO)
 *
 * None of those was a passing-vs-failing difference on the day it was found,
 * which is exactly the problem: the files run in parallel across 4 workers, so
 * the day one of them writes a setting the other reads — segregationOfDuties
 * sets `allow_self_approval = TRUE` on its tenant and deletes the row in
 * afterAll — the failure arrives as a moving target in a file nobody edited.
 * tcoPortfolio's sweep is the sharper case: it deletes BY COMPANY, justified in
 * its own comment by "the tenant is this suite's alone", which was not true.
 *
 * The only reliable moment to catch this is when the id is typed. The suite
 * that documents the convention already kept a hand-written list of ids in use
 * ("In use at the time of writing: 999900-999908, 999911, 999912, 999999") —
 * a comment cannot fail a build, so this does the same job as an assertion.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SELF = 'testTenantIds.contract.test.js';

// Exactly six digits starting 9999 — so 9999999 and 999999999, which are
// "impossibly large id" sentinels for not-found assertions, are not tenants.
const TENANT_ID = /(?<![0-9])9999\d{2}(?![0-9])/g;

// 999999 is the one six-digit value used as a sentinel rather than a tenant
// (`?limit=999999`, `validateOpportunity(pool, 999999, …)`), so it is expected
// in several files at once and is not a claim on a company.
const SENTINELS = new Set(['999999']);

/**
 * Comments are not claims.
 *
 * Several files DISCUSS ids they do not use — the suite that documents the
 * convention lists the whole range in a comment, and each reassignment here
 * names the id it moved away from. Counting those as claims made the guard
 * report seven collisions, five of them prose. Quote state is tracked so a
 * '//' inside a string (a URL) does not eat the rest of its line.
 */
function stripComments(src) {
  let out = '', i = 0, quote = null;
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    if (quote) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

function claimsByFile() {
  const claims = new Map();          // id → Set(file)
  for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.js') && f !== SELF)) {
    const src = stripComments(fs.readFileSync(path.join(DIR, file), 'utf8'));
    for (const id of new Set(src.match(TENANT_ID) ?? [])) {
      if (SENTINELS.has(id)) continue;
      if (!claims.has(id)) claims.set(id, new Set());
      claims.get(id).add(file);
    }
  }
  return claims;
}

describe('test tenant id registry', () => {
  it('gives every 9999xx tenant to exactly one suite', () => {
    const shared = [...claimsByFile()]
      .filter(([, files]) => files.size > 1)
      .map(([id, files]) => `${id}: ${[...files].sort().join(' + ')}`);

    // Named in the message rather than counted, so the failure says which id to
    // change and which two files are fighting over it.
    expect(shared, `test tenant ids claimed by more than one suite:\n  ${shared.join('\n  ')}`)
      .toEqual([]);
  });

  it('finds the tenants it is supposed to be guarding', () => {
    // A regex that matched nothing would make the test above vacuously green.
    expect(claimsByFile().size).toBeGreaterThan(8);
  });
});

/**
 * ── THE OTHER DIMENSION: TAG PREFIXES ───────────────────────────────────────
 * The id registry above covers suites that claim a FIXED 9999xx company. A second
 * convention has grown up beside it: a suite declares `const TAG = 'ZZxxx'`,
 * creates companies with auto-increment ids and a `${TAG}`-derived `code`, and
 * cleans up with `DELETE FROM companies WHERE code LIKE '<TAG>%'`.
 *
 * That pattern has its own collision, and it is NOT an equality collision — it is
 * a PREFIX one, and it is destructive rather than merely confusing:
 *
 *     suite A:  TAG = 'ZZINV'      sweeps  code LIKE 'ZZINV%'
 *     suite B:  TAG = 'ZZINV2'     creates code 'ZZINV2A', 'ZZINV2B'
 *
 * A's sweep matches B's companies. The files run in parallel across 4 workers, so
 * A's `beforeAll` sweep can delete B's fixtures *while B is mid-run* — and B then
 * fails on a foreign-key violation or an empty result in a file nobody edited,
 * with no indication that another suite removed its data. A sweep that runs on the
 * way IN as well as out (the convention here, and the right one) makes this more
 * likely, not less.
 *
 * Equality is checked too, because two suites sharing a TAG outright sweep each
 * other's rows on every run.
 *
 * ⚠ Verified at the time of writing: 25 TAGs, no duplicates, no containments. This
 * guard is here so the 26th is not the one that finds out.
 */
const TAG_DECL = /^const TAG\s*=\s*'([^']+)'/gm;

function tagsByFile() {
  const tags = new Map();            // tag → Set(file)
  for (const file of fs.readdirSync(DIR).filter(f => f.endsWith('.js') && f !== SELF)) {
    // Comments stripped for the same reason as above: a file may DISCUSS a tag it
    // does not own, and prose must not count as a claim.
    const src = stripComments(fs.readFileSync(path.join(DIR, file), 'utf8'));
    for (const m of src.matchAll(TAG_DECL)) {
      const tag = m[1];
      if (!tags.has(tag)) tags.set(tag, new Set());
      tags.get(tag).add(file);
    }
  }
  return tags;
}

describe('test company code prefixes', () => {
  it('gives every TAG to exactly one suite', () => {
    const shared = [...tagsByFile()]
      .filter(([, files]) => files.size > 1)
      .map(([tag, files]) => `${tag}: ${[...files].sort().join(' + ')}`);

    expect(shared, `TAG claimed by more than one suite:\n  ${shared.join('\n  ')}`)
      .toEqual([]);
  });

  it('has no TAG that is a prefix of another suite\'s TAG', () => {
    const tags = tagsByFile();
    const owner = (t) => [...tags.get(t)].sort().join('+');
    const clashes = [];
    for (const a of tags.keys()) {
      for (const b of tags.keys()) {
        if (a !== b && b.startsWith(a)) {
          // `${a}%` matches b's rows, so whichever suite sweeps first wins.
          clashes.push(`'${a}' (${owner(a)}) is a prefix of '${b}' (${owner(b)}) — ` +
                       `a sweep on '${a}%' deletes ${owner(b)}'s companies`);
        }
      }
    }
    expect(clashes, `TAG prefix collisions:\n  ${clashes.join('\n  ')}`).toEqual([]);
  });

  it('finds the tags it is supposed to be guarding', () => {
    // A regex that matched nothing would make both tests above vacuously green.
    expect(tagsByFile().size).toBeGreaterThan(15);
  });
});
