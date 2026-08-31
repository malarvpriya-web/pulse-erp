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
  },
});
