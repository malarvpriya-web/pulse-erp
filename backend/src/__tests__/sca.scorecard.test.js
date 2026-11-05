/**
 * The 198-component supply-chain scorecard, structural half.
 *
 * WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------
 * Each component in scripts/sca/sca-registry.mjs is scored by probes of four
 * kinds. Three of them are deterministic facts about the tree:
 *
 *   be    the backend implements it
 *   ep    a route exists AND is reachable from server.js's mount graph
 *   fe    the frontend calls it
 *   page  a screen is registered in ROUTES and reachable from NAV_ITEMS
 *
 * Those are asserted here, because they are exactly the things that rot
 * silently: a router that stops being mounted, a page dropped from the nav, an
 * endpoint renamed with its only caller left behind. None of it shows up as a
 * failing test anywhere else, and none of it is visible in review.
 *
 * The fourth kind — `sql`, "has this mechanism ever actually run" — is NOT
 * asserted here. Those probes read live rows, and rows are what the rest of this
 * suite spends its time creating and deleting; asserting them from inside the
 * suite would make this file fail whenever some unrelated test happened to be
 * mid-transaction. They are verified by running the scorecard against a real
 * database instead:
 *
 *     node scripts/sca/audit-198.mjs          198/198 or a non-zero exit
 *     node scripts/sca/exercise-chain.mjs     drives the chain that produces them
 *
 * So: this file catches the capability being disconnected. The script catches
 * the capability being dead. They are different failures and both have happened.
 */
import { describe, it, expect } from 'vitest';

const { COMPONENTS, GROUP_NAMES } = await import('../../scripts/sca/sca-registry.mjs');

const STRUCTURAL = new Set(['be', 'ep', 'fe', 'page']);

describe('SCA scorecard — structural coverage', () => {
  it('still describes exactly 198 components across 13 groups', () => {
    expect(COMPONENTS.length).toBe(198);
    expect(new Set(COMPONENTS.map(c => c.g)).size).toBe(13);
    for (const c of COMPONENTS) {
      expect(GROUP_NAMES[c.g], `group ${c.g} has no name`).toBeTruthy();
      expect(c.p.length, `${c.n} has no probes`).toBeGreaterThan(0);
    }
  });

  it('every component is reachable: implemented, mounted, called and navigable', async () => {
    const failures = [];
    for (const c of COMPONENTS) {
      for (const probe of c.p) {
        if (!STRUCTURAL.has(probe.kind)) continue;
        const out = await probe.run();
        if (!out.ok) failures.push(`${GROUP_NAMES[c.g]} · ${c.n} — ${probe.kind}: ${probe.label} (${out.evidence})`);
      }
    }
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
  });

  it('no component is scored by naming alone — each has a probe that can fail', () => {
    // A row whose only probe is a bare regex over the whole tree can be
    // satisfied by a comment mentioning the word. Every component must assert
    // something located: a mounted endpoint, a navigable page, a frontend call,
    // or live data.
    const weak = COMPONENTS.filter(c =>
      c.p.length === 1 && c.p[0].kind === 'be');
    expect(weak.map(c => c.n)).toEqual([]);
  });
});
