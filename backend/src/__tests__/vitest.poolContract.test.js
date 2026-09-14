/**
 * vitest.poolContract.test.js — the runner is running the pool we configured.
 *
 * `pool: 'threads'` in vitest.config.js is a FIX, not a preference: the forks
 * pool intermittently exits a worker with no stack and no test name, taking that
 * file's entire result with it (~1 run in 6-8). The config comment carries the
 * evidence and everything that was ruled out.
 *
 * ⚠ WHY THIS TEST EXISTS AT ALL. This very config has already had a key go
 * SILENTLY INERT once: Vitest 4 removed `test.poolOptions.threads`, and the old
 * block kept parsing, kept reading like an intentional cap in review, and simply
 * stopped being applied — the worker cap was gone for an unknown stretch and
 * nothing failed at the moment of regression. A pool setting that quietly stops
 * applying looks identical to one that works, right up until the flake returns
 * and somebody spends a day re-deriving what this file already knows.
 *
 * The discriminator is real rather than cosmetic: a vitest worker THREAD is a
 * `worker_threads` worker (`isMainThread === false`), while a FORK is a separate
 * process whose main thread is, from its own point of view, the main thread.
 */
import { describe, it, expect } from 'vitest';
import { isMainThread } from 'node:worker_threads';

describe('vitest pool contract', () => {
  it('runs suites on worker threads, not forked processes', () => {
    // If this fails, the pool has reverted to forks — either the key went inert
    // after a vitest upgrade, or someone passed --pool=forks. Read the config
    // comment before "fixing" the test: the flake it prevents is a runner crash
    // that silently drops a whole file from the run.
    expect(isMainThread).toBe(false);
  });
});
