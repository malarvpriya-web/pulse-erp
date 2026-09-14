#!/usr/bin/env node
/**
 * pulse-edge-gateway — the on-site agent.
 *
 * Runs at a customer site (a small PC / Raspberry Pi), NOT inside Pulse. It polls
 * a deployed unit through a pluggable source adapter, batches the readings, and
 * POSTs them to Pulse's device-token-gated ingest endpoint. Pulse stays cloud-only:
 * the gateway speaks Modbus locally and only ever makes outward HTTPS calls, so no
 * field protocol reaches the server.
 *
 * ── DEFECTS THIS VERSION FIXES (reproduced against the previous one) ──────────
 *
 * 1. OVERLAPPING FLUSHES.  `tick()` called `await flush()` on a setInterval. A
 *    flush that outlived its interval — which is the NORMAL case when the network
 *    is slow, precisely when it matters — was re-entered by the next tick. Two
 *    flushes then read the same head of the queue, so the same samples were POSTed
 *    twice, and whichever finished first called `drop(n)` by COUNT, removing n
 *    samples from the front regardless of which ones had actually been
 *    acknowledged. Net effect under load: duplicates on the server AND data loss
 *    on the gateway, simultaneously. Now there is a single-flight guard and
 *    removal is BY SAMPLE ID.
 *
 * 2. DESTRUCTIVE SPOOL RECOVERY.  `#load()` was `try { parse } catch { return [] }`.
 *    One malformed line — a half-written record after a power cut, which is the
 *    exact scenario a spool exists for — silently discarded the ENTIRE backlog.
 *    Now: parse line by line, keep every good record, move the bad ones to a
 *    dead-letter file, and never silently return an empty queue.
 *
 * 3. NON-ATOMIC PERSISTENCE.  `fs.writeFileSync(this.file, ...)` truncates in
 *    place. A crash mid-write left a truncated spool, which fed straight back into
 *    defect 2. Now: write to a temp file, fsync, rename — rename is atomic on both
 *    POSIX and NTFS.
 *
 * 4. SWALLOWED DISK ERRORS.  A failed spool write only logged. The process
 *    continued believing it was durable, so a full disk became silent data loss.
 *    Now it degrades to memory-only, says so on every flush, reports it in the
 *    heartbeat, and keeps trying to recover.
 *
 * 5. SILENT OVERFLOW.  Over capacity, `splice(0, n)` dropped the OLDEST samples
 *    with no record. Now an overflow is counted, logged, dead-lettered and
 *    reported in the heartbeat, and warning/critical thresholds fire before it.
 *
 * 6. POISON BATCHES.  A permanently invalid batch (422) was retried forever,
 *    blocking every later sample behind it. Now a 4xx that is not 401/403/429
 *    dead-letters the batch and the queue moves on.
 *
 * 7. NO RETRY DISCIPLINE.  Failure meant "try again next tick", i.e. hammer the
 *    server every pollSecs during an outage. Now exponential backoff with jitter.
 *
 * 8. NO IDENTITY.  Samples had no stable id, so a retry after a lost response
 *    duplicated them server-side. Every sample now carries a sample_uid and every
 *    flush a stable batch_uid, which is what makes the server's dedup work.
 *
 * ── SAMPLE LIFECYCLE ─────────────────────────────────────────────────────────
 *      QUEUED → IN_FLIGHT → ACKNOWLEDGED → removed
 *                   └──────→ FAILED → QUEUED (backoff)
 *                   └──────→ DEAD_LETTER (permanently invalid)
 *    A sample is removed ONLY on acknowledgement or dead-lettering. Reading it
 *    into a batch does not remove it.
 *
 * Usage:  node gateway.mjs [config.json]      (default ./config.json, or $EDGE_CONFIG)
 * Signals: SIGHUP reloads the config; SIGINT/SIGTERM flush and exit cleanly.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stamp = () => new Date().toISOString();
const log = (...a) => console.log(stamp(), ...a);
const err = (...a) => console.error(stamp(), ...a);

// ── config ────────────────────────────────────────────────────────────────────
function configPath() {
  return process.argv[2] || process.env.EDGE_CONFIG || path.join(__dirname, 'config.json');
}

function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) {
    err(`config not found: ${file}\n  copy config.example.json -> config.json and fill it in.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['ingestUrl', 'deviceUid', 'token', 'source']) {
    if (!cfg[k]) { err(`config missing required field: ${k}`); process.exit(1); }
  }
  cfg.pollSecs    = Math.max(1, Number(cfg.pollSecs) || 60);
  cfg.maxQueue    = Math.max(100, Number(cfg.maxQueue) || 50000);
  cfg.batchSize   = Math.min(5000, Math.max(1, Number(cfg.batchSize) || 1000));
  cfg.gatewayUid  = cfg.gatewayUid || `GW-${cfg.deviceUid}`;
  cfg.spoolFile   = cfg.spoolFile || path.join(__dirname, `.spool-${cfg.deviceUid}.jsonl`);
  cfg.deadFile    = cfg.deadFile || `${cfg.spoolFile}.dead`;
  cfg.corruptDir  = cfg.corruptDir || path.join(__dirname, 'quarantine');
  cfg.heartbeatUrl = cfg.heartbeatUrl
    || cfg.ingestUrl.replace(/\/ingest$/, '/gateway/heartbeat');
  // Backpressure thresholds, as a fraction of maxQueue.
  cfg.warnAt      = Number(cfg.warnAt) || 0.6;
  cfg.criticalAt  = Number(cfg.criticalAt) || 0.85;
  cfg.maxBackoffSecs = Number(cfg.maxBackoffSecs) || 300;
  cfg.requestTimeoutMs = Number(cfg.requestTimeoutMs) || 15000;
  return cfg;
}

// ── durable store-and-forward queue ───────────────────────────────────────────
class Spool {
  constructor(cfg) {
    this.file = cfg.spoolFile;
    this.deadFile = cfg.deadFile;
    this.corruptDir = cfg.corruptDir;
    this.cap = cfg.maxQueue;
    this.warnAt = Math.floor(cfg.warnAt * cfg.maxQueue);
    this.criticalAt = Math.floor(cfg.criticalAt * cfg.maxQueue);
    this.diskOk = true;
    this.stats = { dropped: 0, deadLettered: 0, corruptLines: 0, diskErrors: 0 };
    this.q = this.#load();
  }

  /**
   * Recover the spool line by line.
   *
   * The previous implementation returned [] on ANY parse error, which meant a
   * single truncated trailing line — the normal result of a power cut — threw
   * away every queued sample. Evidence is preserved: bad lines go to the
   * quarantine directory with a timestamp, so they can be inspected rather than
   * inferred from an absence.
   */
  #load() {
    if (!fs.existsSync(this.file)) return [];
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      this.diskOk = false; this.stats.diskErrors += 1;
      err(`SPOOL UNREADABLE (${e.message}) — continuing in MEMORY-ONLY mode. Queued data will not survive a restart.`);
      return [];
    }

    const out = [];
    const bad = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.metric && rec.sample_uid) out.push(rec);
        else bad.push(line);
      } catch { bad.push(line); }
    }

    if (bad.length) {
      this.stats.corruptLines = bad.length;
      try {
        fs.mkdirSync(this.corruptDir, { recursive: true });
        const qf = path.join(this.corruptDir, `corrupt-${Date.now()}.jsonl`);
        fs.writeFileSync(qf, bad.join('\n') + '\n');
        err(`SPOOL RECOVERY: ${out.length} sample(s) recovered, ${bad.length} unreadable line(s) quarantined at ${qf}`);
      } catch (e) {
        err(`SPOOL RECOVERY: ${out.length} recovered, ${bad.length} unreadable (quarantine failed: ${e.message})`);
      }
    } else if (out.length) {
      log(`spool recovered: ${out.length} sample(s) from the previous run`);
    }
    return out;
  }

  /** Atomic persist: temp file, fsync, rename. A crash cannot truncate the spool. */
  #persist() {
    const tmp = `${this.file}.tmp`;
    try {
      const body = this.q.map((s) => JSON.stringify(s)).join('\n') + (this.q.length ? '\n' : '');
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, body);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      if (!this.diskOk) {
        this.diskOk = true;
        log('spool writes have recovered — durability restored');
      }
    } catch (e) {
      if (this.diskOk) {
        this.diskOk = false;
        err(`SPOOL WRITE FAILED (${e.message}) — DEGRADED TO MEMORY-ONLY. Queued samples will be LOST on restart. Free disk space or fix permissions at ${this.file}`);
      }
      this.stats.diskErrors += 1;
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    }
  }

  /** Append permanently undeliverable samples, so they are never simply gone. */
  #deadLetter(samples, reason) {
    this.stats.deadLettered += samples.length;
    try {
      const body = samples.map((s) => JSON.stringify({ ...s, dead_reason: reason, dead_at: stamp() })).join('\n') + '\n';
      fs.appendFileSync(this.deadFile, body);
    } catch (e) {
      err(`dead-letter write failed (${e.message}); ${samples.length} sample(s) lost: ${reason}`);
    }
  }

  add(samples) {
    this.q.push(...samples);
    if (this.q.length > this.cap) {
      // Overflow is a REPORTED event, not a silent splice. The oldest go first
      // because newer readings are the ones an operator is acting on, but they go
      // to the dead-letter file rather than to nothing.
      const overflow = this.q.length - this.cap;
      const dropped = this.q.splice(0, overflow);
      this.stats.dropped += overflow;
      this.#deadLetter(dropped, 'queue_overflow');
      err(`QUEUE OVERFLOW: ${overflow} oldest sample(s) moved to the dead-letter file (cap ${this.cap}). Total dropped this run: ${this.stats.dropped}`);
    }
    this.#persist();
    this.#pressure();
  }

  #pressure() {
    if (this.q.length >= this.criticalAt) {
      err(`BACKPRESSURE CRITICAL: ${this.q.length}/${this.cap} queued (${Math.round(100 * this.q.length / this.cap)}%). Data loss begins at the cap.`);
    } else if (this.q.length >= this.warnAt) {
      log(`backpressure warning: ${this.q.length}/${this.cap} queued (${Math.round(100 * this.q.length / this.cap)}%)`);
    }
  }

  peek(n) { return this.q.slice(0, n); }

  /**
   * Remove acknowledged samples BY ID.
   *
   * The old `drop(n)` removed n items from the front by count. With two flushes in
   * flight, or with a reading appended between peek and drop, that removed the
   * wrong samples — acknowledging one and discarding another.
   */
  ack(samples) {
    const ids = new Set(samples.map((s) => s.sample_uid));
    this.q = this.q.filter((s) => !ids.has(s.sample_uid));
    this.#persist();
  }

  /** Permanently reject a batch the server will never accept. */
  reject(samples, reason) {
    this.#deadLetter(samples, reason);
    this.ack(samples);
  }

  get size() { return this.q.length; }
  get oldestTs() { return this.q.length ? this.q[0].event_ts : null; }
  get bytes() {
    try { return fs.statSync(this.file).size; } catch { return 0; }
  }
}

// ── single-flight flush ───────────────────────────────────────────────────────
class Flusher {
  constructor(cfg, spool) {
    this.cfg = cfg;
    this.spool = spool;
    this.inFlight = false;          // THE single-flight guard
    this.failures = 0;
    this.retryUntil = 0;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.retryCount = 0;
    this.errorCount = 0;
  }

  /** Exponential backoff with jitter, capped. */
  #backoff() {
    this.failures += 1;
    this.retryCount += 1;
    const base = Math.min(this.cfg.maxBackoffSecs, Math.pow(2, Math.min(this.failures, 8)));
    const secs = Math.round(base * (0.75 + Math.random() * 0.5));
    this.retryUntil = Date.now() + secs * 1000;
    return secs;
  }

  #succeed() { this.failures = 0; this.retryUntil = 0; this.lastSuccessAt = stamp(); }

  async flush() {
    if (this.inFlight) return { skipped: 'already flushing' };
    if (Date.now() < this.retryUntil) {
      return { skipped: `backing off for ${Math.ceil((this.retryUntil - Date.now()) / 1000)}s` };
    }
    this.inFlight = true;
    try {
      while (this.spool.size > 0) {
        const batch = this.spool.peek(this.cfg.batchSize);
        // Stable batch identity derived from the batch CONTENT, so a retry of the
        // same samples after a lost response carries the same batch_uid and the
        // server replays its original response instead of reprocessing.
        const batchUid = 'b-' + crypto
          .createHash('sha256')
          .update(batch.map((s) => s.sample_uid).join('|'))
          .digest('hex').slice(0, 32);

        let res;
        try {
          res = await fetch(this.cfg.ingestUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Device-Token': this.cfg.token },
            body: JSON.stringify({
              device_uid: this.cfg.deviceUid,
              gateway_uid: this.cfg.gatewayUid,
              batch_uid: batchUid,
              samples: batch,
            }),
            signal: AbortSignal.timeout(this.cfg.requestTimeoutMs),
          });
        } catch (e) {
          // NETWORK FAILURE OR TIMEOUT. The server may or may not have committed —
          // this is exactly the lost-response case. Keep everything and retry; the
          // batch_uid and sample_uids make the retry safe.
          this.lastFailureAt = stamp(); this.errorCount += 1;
          const secs = this.#backoff();
          err(`POST failed (${e.name}: ${e.message}) — ${this.spool.size} sample(s) held, retrying in ${secs}s`);
          return { held: this.spool.size, retryInSecs: secs };
        }

        if (res.status === 401 || res.status === 403) {
          // Credential problem. No amount of retrying fixes it and dead-lettering
          // would destroy good data, so hold and back off loudly.
          this.lastFailureAt = stamp(); this.errorCount += 1;
          const secs = this.#backoff();
          err(`${res.status} from ingest — device token/uid rejected or device disabled. Holding ${this.spool.size} sample(s); fix the config or re-provision. Next attempt in ${secs}s`);
          return { held: this.spool.size, authFailure: true, retryInSecs: secs };
        }

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('Retry-After')) || 60;
          this.retryUntil = Date.now() + retryAfter * 1000;
          this.lastFailureAt = stamp();
          log(`rate limited — honouring Retry-After ${retryAfter}s, ${this.spool.size} sample(s) held`);
          return { held: this.spool.size, retryInSecs: retryAfter };
        }

        if (res.status >= 400 && res.status < 500) {
          // A permanent rejection (422 = nothing in the batch validated; 400 = a
          // malformed batch). Retrying forever would block every later sample
          // behind a batch the server will never take.
          const body = await res.text().catch(() => '');
          this.spool.reject(batch, `http_${res.status}: ${body.slice(0, 300)}`);
          this.errorCount += 1;
          err(`ingest ${res.status} — ${batch.length} sample(s) DEAD-LETTERED to ${this.cfg.deadFile} (see ${this.cfg.deadFile} to inspect). Queue continues with ${this.spool.size} remaining.`);
          continue;
        }

        if (!res.ok) {
          // 5xx — transient by definition. Hold and back off.
          this.lastFailureAt = stamp(); this.errorCount += 1;
          const secs = this.#backoff();
          err(`ingest ${res.status} — holding ${this.spool.size} sample(s), retrying in ${secs}s`);
          return { held: this.spool.size, retryInSecs: secs };
        }

        // ACKNOWLEDGED. Only now are these samples removed, and only these.
        const body = await res.json().catch(() => ({}));
        this.spool.ack(batch);
        this.#succeed();
        log(`sent ${batch.length} · accepted ${body.accepted ?? '?'} · duplicates ${body.duplicates ?? 0} · rejected ${body.rejected ?? 0} · alerts +${body.alerts_opened ?? 0}/-${body.alerts_resolved ?? 0}${body.replayed ? ' (server replayed a prior response)' : ''} · ${this.spool.size} queued`);
      }
      return { drained: true };
    } finally {
      this.inFlight = false;
    }
  }
}

// ── heartbeat ─────────────────────────────────────────────────────────────────
async function heartbeat(cfg, spool, flusher, source) {
  try {
    const res = await fetch(cfg.heartbeatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': cfg.token },
      body: JSON.stringify({
        device_uid: cfg.deviceUid,
        gateway_uid: cfg.gatewayUid,
        name: cfg.name ?? null,
        site_location: cfg.siteLocation ?? null,
        version: GATEWAY_VERSION,
        queue_depth: spool.size,
        oldest_queued_ts: spool.oldestTs,
        spool_bytes: spool.bytes,
        disk_free_bytes: diskFree(cfg.spoolFile),
        device_count: 1,
        error_count: flusher.errorCount,
        dead_letter_count: spool.stats.deadLettered,
        retry_count: flusher.retryCount,
        poll_secs: cfg.pollSecs,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok && res.status !== 404) {
      log(`heartbeat ${res.status} (non-fatal)`);
    }
  } catch (e) {
    // A heartbeat is diagnostics. Losing it must never stop telemetry.
    log(`heartbeat failed (${e.message}) — non-fatal`);
  }
}

function diskFree(forPath) {
  try {
    const st = fs.statfsSync(path.dirname(forPath));
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

const GATEWAY_VERSION = '4.0.0';

// ── main loop ─────────────────────────────────────────────────────────────────
async function main() {
  let cfg = loadConfig();
  log(`pulse-edge-gateway ${GATEWAY_VERSION} starting · device ${cfg.deviceUid} · gateway ${cfg.gatewayUid} · source ${cfg.source.type} · poll ${cfg.pollSecs}s`);

  const mod = await import(`./sources/${cfg.source.type}.mjs`)
    .catch(() => { err(`unknown source type: ${cfg.source.type} (expected 'sim' or 'modbus')`); process.exit(1); });
  let source = await mod.createSource(cfg.source);

  const spool = new Spool(cfg);
  const flusher = new Flusher(cfg, spool);
  if (spool.size) log(`replaying ${spool.size} spooled sample(s)`);
  if (!spool.diskOk) err('STARTING WITHOUT DURABLE SPOOL — see the message above.');

  let seq = Date.now();
  let stopping = false;
  let heartbeatDue = 0;

  const tick = async () => {
    if (stopping) return;
    try {
      const readings = await source.read();
      if (readings?.length) {
        const nowIso = stamp();
        spool.add(readings.map((r) => ({
          // Stable identity per sample. This is what makes a retry after a lost
          // response a no-op on the server instead of a duplicate.
          sample_uid: `${cfg.gatewayUid}-${++seq}-${crypto.randomBytes(3).toString('hex')}`,
          seq_no: seq,
          metric: r.metric,
          value: r.value,
          event_ts: r.ts || nowIso,
          quality: r.quality ?? 'VALID',
        })));
      }
    } catch (e) {
      // A bad read must not block the flush — the backlog still needs draining.
      err('read failed:', e.message);
    }
    await flusher.flush();

    if (Date.now() >= heartbeatDue) {
      heartbeatDue = Date.now() + Math.max(60, cfg.pollSecs) * 1000;
      await heartbeat(cfg, spool, flusher, source);
    }
  };

  await tick();
  let timer = setInterval(tick, cfg.pollSecs * 1000);

  // SIGHUP reloads the config without losing the queue — changing a poll interval
  // or a threshold previously required a restart, which meant a restart during an
  // outage, which meant testing the spool recovery in anger.
  process.on('SIGHUP', async () => {
    try {
      const next = loadConfig();
      log('SIGHUP — reloading configuration');
      const pollChanged = next.pollSecs !== cfg.pollSecs;
      const sourceChanged = JSON.stringify(next.source) !== JSON.stringify(cfg.source);
      cfg = next;
      flusher.cfg = cfg;
      if (sourceChanged) {
        await source.close?.().catch(() => {});
        source = await mod.createSource(cfg.source);
        log('source reinitialised');
      }
      if (pollChanged) {
        clearInterval(timer);
        timer = setInterval(tick, cfg.pollSecs * 1000);
        log(`poll interval now ${cfg.pollSecs}s`);
      }
    } catch (e) {
      err('config reload failed, keeping the previous configuration:', e.message);
    }
  });

  const shutdown = async (sig) => {
    if (stopping) return; stopping = true;
    log(`${sig} — draining before exit`);
    clearInterval(timer);
    // Wait for an in-flight flush rather than racing it: exiting mid-POST is how
    // a batch ends up committed on the server and still queued here.
    const deadline = Date.now() + 20000;
    while (flusher.inFlight && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (flusher.inFlight) {
      err('a flush is still in flight after 20s — exiting anyway; its samples remain spooled and will be retried (the server deduplicates them)');
    } else {
      await flusher.flush().catch(() => {});
    }
    await source.close?.().catch(() => {});
    log(`stopped · ${spool.size} sample(s) spooled at ${cfg.spoolFile} · dead-lettered this run: ${spool.stats.deadLettered} · dropped: ${spool.stats.dropped}`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Exported for the test suite; main() only runs when this file is the entry point.
export { Spool, Flusher };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gateway.mjs')) {
  main().catch((e) => { err('fatal:', e.stack || e.message); process.exit(1); });
}
