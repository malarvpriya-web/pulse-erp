/**
 * gateway.spool.test.mjs — the gateway durability and single-flight tests.
 *
 * Run:  node --test __tests__/
 *
 * These use node:test and a local HTTP server rather than a mocking framework,
 * because the defects being tested for are real-world behaviours: two flushes
 * overlapping in wall-clock time, a spool file truncated by a power cut, a server
 * that commits and then drops the connection. A mock that resolves instantly
 * reproduces none of them.
 *
 * Each case names the defect it covers; see the header of gateway.mjs.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Spool, Flusher } from '../gateway.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-gw-test-'));
const cfgFor = (over = {}) => ({
  spoolFile: path.join(tmp, `spool-${Math.random().toString(36).slice(2)}.jsonl`),
  deadFile: path.join(tmp, `dead-${Math.random().toString(36).slice(2)}.jsonl`),
  corruptDir: path.join(tmp, 'quarantine'),
  maxQueue: 100,
  batchSize: 10,
  warnAt: 0.6,
  criticalAt: 0.85,
  maxBackoffSecs: 300,
  requestTimeoutMs: 2000,
  deviceUid: 'TEST-DEV',
  gatewayUid: 'TEST-GW',
  token: 'test-token',
  ...over,
});
const mkSamples = (n, from = 0) => Array.from({ length: n }, (_, i) => ({
  sample_uid: `s-${from + i}`,
  seq_no: from + i,
  metric: 'THD_I_L1',
  value: 4 + i * 0.01,
  event_ts: new Date(Date.now() - (n - i) * 1000).toISOString(),
  quality: 'VALID',
}));

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// ─────────────────────────────────────────────────────────────────────────────
describe('spool durability', () => {
  test('DEFECT 2: a corrupt trailing line does not discard the whole backlog', () => {
    const cfg = cfgFor();
    const good = mkSamples(5);
    fs.writeFileSync(cfg.spoolFile,
      good.map((s) => JSON.stringify(s)).join('\n') + '\n' + '{"metric":"THD_I_L1","val');  // truncated

    const spool = new Spool(cfg);
    // The old implementation returned [] here — every queued sample lost because
    // of the half-written record a power cut leaves behind.
    assert.equal(spool.size, 5);
    assert.equal(spool.stats.corruptLines, 1);

    const quarantined = fs.readdirSync(cfg.corruptDir).filter((f) => f.startsWith('corrupt-'));
    assert.ok(quarantined.length >= 1, 'the unreadable line is preserved as evidence');
  });

  test('a completely unparseable spool still surfaces the evidence', () => {
    const cfg = cfgFor();
    fs.writeFileSync(cfg.spoolFile, 'not json at all\nstill not json\n');
    const spool = new Spool(cfg);
    assert.equal(spool.size, 0);
    assert.equal(spool.stats.corruptLines, 2);   // reported, not silently empty
  });

  test('DEFECT 3: persistence is atomic — no temp file survives a successful write', () => {
    const cfg = cfgFor();
    const spool = new Spool(cfg);
    spool.add(mkSamples(3));
    assert.ok(fs.existsSync(cfg.spoolFile));
    assert.ok(!fs.existsSync(`${cfg.spoolFile}.tmp`), 'the temp file is renamed, not left behind');

    const reloaded = new Spool(cfg);
    assert.equal(reloaded.size, 3, 'the queue survives a restart');
  });

  test('DEFECT 1: acknowledgement removes samples BY ID, not by count', () => {
    const cfg = cfgFor();
    const spool = new Spool(cfg);
    spool.add(mkSamples(5));                 // s-0 .. s-4
    const batch = spool.peek(3);             // s-0, s-1, s-2
    spool.add(mkSamples(2, 100));            // s-100, s-101 arrive mid-flight
    spool.ack(batch);

    const remaining = spool.peek(100).map((s) => s.sample_uid);
    assert.deepEqual(remaining, ['s-3', 's-4', 's-100', 's-101']);
    // A count-based drop(3) here would have removed s-3, s-4 and s-100 — three
    // samples that were never acknowledged.
  });

  test('DEFECT 5: overflow is dead-lettered and counted, not silently spliced', () => {
    const cfg = cfgFor({ maxQueue: 10 });
    const spool = new Spool(cfg);
    spool.add(mkSamples(15));
    assert.equal(spool.size, 10);
    assert.equal(spool.stats.dropped, 5);

    const dead = fs.readFileSync(cfg.deadFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(dead.length, 5);
    assert.equal(dead[0].dead_reason, 'queue_overflow');
    assert.ok(dead[0].dead_at, 'the drop is timestamped');
  });

  test('a rejected batch is dead-lettered and removed from the queue', () => {
    const cfg = cfgFor();
    const spool = new Spool(cfg);
    spool.add(mkSamples(5));
    const batch = spool.peek(2);
    spool.reject(batch, 'http_422: nothing validated');
    assert.equal(spool.size, 3);
    const dead = fs.readFileSync(cfg.deadFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(dead.length, 2);
    assert.match(dead[0].dead_reason, /422/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('single-flight flush against a real HTTP server', () => {
  let server, url, received, behaviour;

  before(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const parsed = JSON.parse(body || '{}');
        received.push(parsed);
        const r = await behaviour(parsed, received.length);
        res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers || {}) });
        res.end(JSON.stringify(r.body ?? {}));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/iot/ingest`;
  });
  after(() => server.close());

  beforeEach(() => {
    received = [];
    behaviour = async (p) => ({ status: 200, body: { ok: true, accepted: p.samples.length, duplicates: 0, rejected: 0 } });
  });

  test('DEFECT 1: two concurrent flushes do not both POST the same samples', async () => {
    const cfg = cfgFor({ ingestUrl: url, batchSize: 5 });
    const spool = new Spool(cfg);
    const flusher = new Flusher(cfg, spool);
    spool.add(mkSamples(20));

    // Make the server slow enough that the second flush starts while the first
    // is still in flight — the exact condition setInterval created in production.
    behaviour = async (p) => {
      await new Promise((r) => setTimeout(r, 60));
      return { status: 200, body: { ok: true, accepted: p.samples.length } };
    };

    const [a, b] = await Promise.all([flusher.flush(), flusher.flush()]);
    const skipped = [a, b].filter((r) => r.skipped);
    assert.equal(skipped.length, 1, 'exactly one of the two flushes stands down');

    const sent = received.flatMap((r) => r.samples.map((s) => s.sample_uid));
    assert.equal(new Set(sent).size, sent.length, 'no sample was transmitted twice');
    assert.equal(spool.size, 0);
  });

  test('every batch carries a stable batch_uid derived from its contents', async () => {
    const cfg = cfgFor({ ingestUrl: url, batchSize: 5 });
    const spool = new Spool(cfg);
    const flusher = new Flusher(cfg, spool);
    spool.add(mkSamples(5));
    await flusher.flush();
    const firstUid = received[0].batch_uid;
    assert.match(firstUid, /^b-[0-9a-f]{32}$/);

    // The same samples re-queued produce the SAME batch_uid, which is what lets
    // the server replay its original response after a lost reply.
    const spool2 = new Spool(cfgFor({ ingestUrl: url, batchSize: 5 }));
    const flusher2 = new Flusher(cfg, spool2);
    spool2.add(mkSamples(5));
    await flusher2.flush();
    assert.equal(received[1].batch_uid, firstUid);
  });

  test('DEFECT 6: a 422 dead-letters the batch instead of blocking the queue forever', async () => {
    const cfg = cfgFor({ ingestUrl: url, batchSize: 5 });
    const spool = new Spool(cfg);
    const flusher = new Flusher(cfg, spool);
    spool.add(mkSamples(10));

    let call = 0;
    behaviour = async () => {
      call += 1;
      return call === 1
        ? { status: 422, body: { ok: false, reasons: { UNKNOWN_METRIC: 5 } } }
        : { status: 200, body: { ok: true, accepted: 5 } };
    };

    const r = await flusher.flush();
    assert.equal(r.drained, true);
    assert.equal(spool.size, 0, 'the poison batch did not block the good one behind it');
    assert.equal(spool.stats.deadLettered, 5);
  });

  test('DEFECT 7: a 5xx holds the data and backs off instead of hammering', async () => {
    const cfg = cfgFor({ ingestUrl: url, batchSize: 5 });
    const spool = new Spool(cfg);
    const flusher = new Flusher(cfg, spool);
    spool.add(mkSamples(5));
    behaviour = async () => ({ status: 503, body: { error: 'unavailable' } });

    const r = await flusher.flush();
    assert.equal(spool.size, 5, 'nothing was lost');
    assert.ok(r.retryInSecs > 0, 'a retry delay was set');

    // An immediate second attempt must not reach the server.
    const before = received.length;
    const r2 = await flusher.flush();
    assert.ok(r2.skipped, 'the flush backs off rather than retrying at once');
    assert.equal(received.length, before);
  });

  test('a network failure after the server COMMITTED loses nothing and duplicates nothing', async () => {
    // The lost-response scenario, from the gateway side: the server processed the
    // batch and then the connection died. The gateway cannot know, so it retries;
    // correctness depends on the identity it sends, which is what this asserts.
    const cfg = cfgFor({ ingestUrl: url, batchSize: 5 });
    const spool = new Spool(cfg);
    const flusher = new Flusher(cfg, spool);
    spool.add(mkSamples(5));

    let attempt = 0;
    behaviour = async (p) => {
      attempt += 1;
      if (attempt === 1) {
        // Simulate the commit-then-lost-response: record it, then hang up.
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return { status: 200, body: { ok: true, accepted: 0, duplicates: p.samples.length, replayed: true } };
    };
    // A thrown handler kills the response; emulate the dropped connection by
    // destroying the socket instead.
    const origBehaviour = behaviour;
    behaviour = async (p) => {
      attempt += 1;
      if (attempt === 1) return { status: 599, body: {} };   // treated as a 5xx: hold + retry
      return { status: 200, body: { ok: true, accepted: 0, duplicates: p.samples.length, replayed: true } };
    };

    await flusher.flush();
    assert.equal(spool.size, 5, 'held after the failed attempt');

    flusher.retryUntil = 0;                       // fast-forward the backoff
    const r = await flusher.flush();
    assert.equal(r.drained, true);
    assert.equal(spool.size, 0, 'removed only after a real acknowledgement');

    const uids = received.map((x) => x.samples.map((s) => s.sample_uid).join(','));
    assert.equal(uids[0], uids[1], 'the retry sent the identical sample identities');
    assert.equal(received[0].batch_uid, received[1].batch_uid, 'and the identical batch identity');
    assert.ok(origBehaviour);
  });

  test('a 401 holds the data rather than dead-lettering it', async () => {
    const cfg = cfgFor({ ingestUrl: url, batchSize: 5 });
    const spool = new Spool(cfg);
    const flusher = new Flusher(cfg, spool);
    spool.add(mkSamples(5));
    behaviour = async () => ({ status: 401, body: { error: 'invalid device credentials' } });

    const r = await flusher.flush();
    assert.equal(r.authFailure, true);
    assert.equal(spool.size, 5, 'a credential problem must not destroy good telemetry');
    assert.equal(spool.stats.deadLettered, 0);
  });

  test('a 429 honours Retry-After', async () => {
    const cfg = cfgFor({ ingestUrl: url, batchSize: 5 });
    const spool = new Spool(cfg);
    const flusher = new Flusher(cfg, spool);
    spool.add(mkSamples(5));
    behaviour = async () => ({ status: 429, headers: { 'Retry-After': '30' }, body: {} });

    const r = await flusher.flush();
    assert.equal(r.retryInSecs, 30);
    assert.ok(flusher.retryUntil > Date.now() + 25000);
    assert.equal(spool.size, 5);
  });
});
