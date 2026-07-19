#!/usr/bin/env node
/**
 * pulse-edge-gateway — the on-site agent (Phase 4 of IoT / Device Telemetry).
 *
 * Runs at a customer site (a small PC / Raspberry Pi), NOT inside Pulse. It
 * polls a deployed unit through a pluggable source adapter, batches the readings,
 * and POSTs them to Pulse's device-token-gated ingest endpoint:
 *
 *     POST {ingestUrl}   X-Device-Token: {token}
 *     { "device_uid": "...", "samples": [ { metric, value, ts, quality }, ... ] }
 *
 * Design goals:
 *   - Keep Pulse cloud-only: the gateway speaks Modbus (or whatever) locally and
 *     only ever makes plain HTTPS calls outward, so no field protocol reaches the
 *     server. (See the build plan, Decision 1.)
 *   - Never lose data on a network blip: readings are store-and-forward. They
 *     queue in memory and spool to disk (JSONL) so a crash/restart replays them.
 *   - Be testable without hardware: the `sim` source generates realistic values
 *     so the whole chain can be verified before a Modbus device is wired up.
 *
 * Usage:  node gateway.mjs [config.json]      (default ./config.json, or $EDGE_CONFIG)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const err = (...a) => console.error(new Date().toISOString(), ...a);

// ── config ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const file = process.argv[2] || process.env.EDGE_CONFIG || path.join(__dirname, 'config.json');
  if (!fs.existsSync(file)) {
    err(`config not found: ${file}\n  copy config.example.json → config.json and fill it in.`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['ingestUrl', 'deviceUid', 'token', 'source']) {
    if (!cfg[k]) { err(`config missing required field: ${k}`); process.exit(1); }
  }
  cfg.pollSecs = Math.max(1, Number(cfg.pollSecs) || 60);
  cfg.maxQueue = Math.max(100, Number(cfg.maxQueue) || 50000); // cap so a long outage can't OOM
  cfg.spoolFile = cfg.spoolFile || path.join(__dirname, `.spool-${cfg.deviceUid}.jsonl`);
  return cfg;
}

// ── store-and-forward queue (memory + disk spool) ──────────────────────────────
class Spool {
  constructor(file, cap) { this.file = file; this.cap = cap; this.q = this.#load(); }
  #load() {
    try {
      if (!fs.existsSync(this.file)) return [];
      return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }
  #persist() {
    try { fs.writeFileSync(this.file, this.q.map((s) => JSON.stringify(s)).join('\n') + (this.q.length ? '\n' : '')); }
    catch (e) { err('spool write failed:', e.message); }
  }
  add(samples) {
    this.q.push(...samples);
    if (this.q.length > this.cap) this.q.splice(0, this.q.length - this.cap); // drop oldest
    this.#persist();
  }
  peek(n) { return this.q.slice(0, n); }
  drop(n) { this.q.splice(0, n); this.#persist(); }
  get size() { return this.q.length; }
}

// ── ingest POST ────────────────────────────────────────────────────────────────
async function flush(cfg, spool) {
  const BATCH = 5000; // server cap
  while (spool.size > 0) {
    const batch = spool.peek(BATCH);
    let res;
    try {
      res = await fetch(cfg.ingestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': cfg.token },
        body: JSON.stringify({ device_uid: cfg.deviceUid, samples: batch }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      err(`POST failed (${e.name}: ${e.message}) — ${spool.size} sample(s) held for retry`);
      return; // keep everything; try again next cycle
    }
    if (res.status === 401) {
      err('401 from ingest — device token/uid rejected. Fix config; holding data.');
      return;
    }
    if (!res.ok) {
      err(`ingest ${res.status} — holding ${spool.size} sample(s) for retry`);
      return;
    }
    const body = await res.json().catch(() => ({}));
    spool.drop(batch.length);
    log(`sent ${batch.length} sample(s) · accepted ${body.accepted ?? '?'} · alerts ${body.alerts ?? 0} · ${spool.size} queued`);
  }
}

// ── main loop ───────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  log(`pulse-edge-gateway starting · device ${cfg.deviceUid} · source ${cfg.source.type} · poll ${cfg.pollSecs}s`);

  const { createSource } = await import(`./sources/${cfg.source.type}.mjs`)
    .catch(() => { err(`unknown source type: ${cfg.source.type} (expected 'sim' or 'modbus')`); process.exit(1); });
  const source = await createSource(cfg.source);
  const spool = new Spool(cfg.spoolFile, cfg.maxQueue);
  if (spool.size) log(`replaying ${spool.size} spooled sample(s) from previous run`);

  let stopping = false;
  const tick = async () => {
    if (stopping) return;
    try {
      const readings = await source.read();
      if (readings?.length) {
        const now = new Date().toISOString();
        spool.add(readings.map((r) => ({ metric: r.metric, value: r.value, ts: r.ts || now, quality: r.quality ?? 0 })));
      }
    } catch (e) {
      err('read failed:', e.message); // don't flush-block on a bad read; retry next tick
    }
    await flush(cfg, spool);
  };

  await tick(); // fire once immediately
  const timer = setInterval(tick, cfg.pollSecs * 1000);

  const shutdown = async (sig) => {
    if (stopping) return; stopping = true;
    log(`${sig} — flushing and exiting`);
    clearInterval(timer);
    await flush(cfg, spool).catch(() => {});
    await source.close?.().catch(() => {});
    log(`stopped · ${spool.size} sample(s) left spooled at ${cfg.spoolFile}`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => { err('fatal:', e.stack || e.message); process.exit(1); });
