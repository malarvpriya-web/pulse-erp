import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],

    /**
     * Worker count is pinned, not left to the core count, because it is one half
     * of a connection budget.
     *
     * Several suites here talk to the REAL database on purpose (the schema
     * invariants they assert cannot be mocked). Every vitest worker imports
     * src/config/db.js and builds its OWN pool, so the server-wide connection
     * count is `workers x pool.max`, not `pool.max`. Left to an 8-core box that
     * was 8 x 30 = 240 against a stock `max_connections = 100`: workers starved,
     * waited out the connection timeout, and whichever test held the short straw
     * failed with a bare "Test timed out in 5000ms" naming the test rather than
     * the cause. That is why the real-DB suites passed in isolation and failed at
     * random in a full run.
     *
     * The budget, with the test-mode pool of 6 set in src/config/db.js:
     *
     *     4 workers x 6 connections   = 24
     *   + a dev server pool at full ramp = 30
     *   + headroom for psql/migrations   ~ 10
     *   ------------------------------------
     *                                    64  of 100
     *
     * A developer running `npm run dev` alongside `npm test` is the normal case,
     * so the dev server's pool has to be inside the budget, not an exception to
     * it. Raising this number without lowering pool.max reintroduces the flake.
     *
     * These are TOP-LEVEL options. Vitest 4 removed `test.poolOptions.threads`,
     * and it removed it silently: the old block still parsed, still read as an
     * intentional cap, and simply stopped being applied. That let the worker
     * count fall back to the core count (8 here), putting the budget at
     * 7 x 6 + 30 = 72 rather than 64 -- the starvation this config exists to
     * prevent, reintroduced by an upgrade rather than by an edit. If a future
     * major renames these again, the symptom to expect is a real-DB suite
     * timing out with a message that names the test, never the pool.
     */
    maxWorkers: 4,
    minWorkers: 1,

    /**
     * WORKER THREADS, NOT FORKS — this is a fix, and it is the whole reason the
     * key is here.
     *
     * THE FAULT (first logged 2026-09-03 at 37 files, closed 2026-09-11 at 57):
     *
     *   Error: [vitest-pool]: Worker forks emitted error.
     *   Caused by: Error: Worker exited unexpectedly
     *
     * A fork exiting with no test failure, no stack and no stderr, taking
     * whichever file it was running with it. Victims were random and included
     * suites nobody was touching. It is a RUNNER crash, not a test failure: the
     * affected file's tests are never reported, so the run shows FEWER TESTS
     * rather than a red one. Roughly 1 run in 6-8, and it CLUSTERS — one period
     * gave 4 crashes in ~30 runs, another gave 24 consecutive clean runs with no
     * code change at all.
     *
     * ⚠⚠ THAT CLUSTERING IS A TRAP FOR WHOEVER INVESTIGATES NEXT. Any before/
     * after comparison shorter than ~30 runs per arm will "prove" whatever the
     * investigator already suspects. A 6-run clean streak was once read as
     * evidence that a newly added suite had caused it; it had not.
     *
     * RULED OUT, each with a measured experiment rather than an argument:
     *   - connection starvation — peak 24 of max_connections 100 measured DURING
     *     a run (not merely at idle); the budget above is intact
     *   - un-awaited service work firing after teardown
     *   - heap — persists at --max-old-space-size=4096
     *   - worker count — persists at --maxWorkers=3
     *   - file count — persists at 54 files as well as 57
     *   - one specific suite — persists with the newest suite removed, and a
     *     trivial read-only suite in its place does not reproduce it
     *   - child-process spawning — persists with analytics.schemaGuards
     *     (10 execFileSync spawns + a recursive cpSync) removed entirely
     *
     * What does hold: `pool: 'threads'` has now gone 43 runs with zero crashes
     * (18 + 10 + 15 across three sessions) against forks' 1-in-6. Same tests pass
     * (1257), same duration (~27s), and peak connections are slightly LOWER
     * (21 vs 24) because threads share a process.
     *
     * ⚠ The connection budget above still applies unchanged. A vitest worker
     * thread gets its own module registry, so it still builds its OWN pool —
     * `workers x pool.max` is the arithmetic either way. Do not raise maxWorkers
     * on the theory that threads are cheaper.
     *
     * If this ever needs reverting, `--pool=forks` restores the old behaviour
     * without a code change, and the symptom to expect is the one above.
     */
    pool: 'threads',

    /**
     * ⚠ READ THE TEST COUNT, NOT JUST THE COLOUR. A run reporting "1257 passed"
     * is complete; one reporting "1230 passed" of the same 1266 has silently
     * dropped a file. The runner does exit 1 when that happens (measured
     * 2026-09-11 — an earlier note here claimed it only printed "Errors 1 error"
     * and did not fail, which is no longer true), so CI catches it; but the
     * count is what tells you WHAT went missing.
     */
  },
});
