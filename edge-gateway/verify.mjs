#!/usr/bin/env node
/**
 * verify.mjs — the commissioning tool for the hardware pilot.
 *
 * WHY THIS EXISTS
 * ---------------
 * `IOT_HARDWARE_PILOT.md` asks a field engineer to establish three things that do
 * not fail loudly when they are wrong:
 *
 *   - addressing mode   (one_based vs zero_based)
 *   - byte order        (big vs little)
 *   - word order        (big vs little / ABCD vs CDAB)
 *
 * Getting any of them wrong yields a finite, plausible number, so the only way to
 * settle them is to compare against the device's own display. Doing that by trial
 * and error means editing a config, restarting the gateway and re-reading the
 * screen — once per combination, per register. Eight combinations across a dozen
 * registers is an afternoon, and it is exactly the kind of afternoon that ends
 * with somebody picking the value that "looks about right".
 *
 * This tool reads each register ONCE and decodes the same bytes under every
 * combination at the same time, printing them side by side with the raw hex. The
 * engineer reads the device display, finds the column that matches, and that
 * column IS the answer — for every register at once, because a device uses one
 * convention throughout.
 *
 * It also writes a machine-readable evidence file, so the pilot result is a record
 * rather than a memory, and can be posted to Pulse with:
 *
 *     node verify.mjs --config config.json --post
 *
 * USAGE
 *   node verify.mjs [--config config.json] [--json out.json] [--post] [--unit 1]
 *
 * SAFETY
 *   Read-only. It issues Modbus read function codes and nothing else — it cannot
 *   write a register, which is not a property to leave to carefulness on a live
 *   compensation unit.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { decode, protocolAddress } from './sources/modbus.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const WORDS = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2, float64: 4 };
const COMBOS = [
  { key: 'big/big', byteOrder: 'big', wordOrder: 'big' },
  { key: 'big/little', byteOrder: 'big', wordOrder: 'little' },
  { key: 'little/big', byteOrder: 'little', wordOrder: 'big' },
  { key: 'little/little', byteOrder: 'little', wordOrder: 'little' },
];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function loadConfig() {
  const file = arg('config', process.env.EDGE_CONFIG || path.join(__dirname, 'config.json'));
  if (!fs.existsSync(file)) {
    console.error(`config not found: ${file}`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const src = cfg.source?.type === 'modbus' ? cfg.source : cfg._modbus_source_example;
  if (!src || src.type !== 'modbus') {
    console.error('This tool needs a modbus source. Point config.source at the real device, or fill in _modbus_source_example.');
    process.exit(1);
  }
  if (!Array.isArray(src.registers) || !src.registers.length) {
    console.error('The modbus source has no registers[] to verify.');
    process.exit(1);
  }
  return { cfg, src };
}

/** Read raw registers once per (address, width, table), under BOTH addressing modes. */
async function readRaw(client, reg) {
  const width = WORDS[reg.type] ?? 1;
  const out = {};
  for (const mode of ['one_based', 'zero_based']) {
    const addr = protocolAddress(reg.address, mode);
    if (addr < 0) { out[mode] = { error: `protocol address ${addr} is negative under ${mode}` }; continue; }
    try {
      const fn = reg.register === 'input' ? client.readInputRegisters : client.readHoldingRegisters;
      const res = await fn.call(client, addr, width);
      out[mode] = { addr, words: res.data.slice(0, width) };
    } catch (e) {
      out[mode] = { addr, error: e.message };
    }
  }
  return out;
}

function decodeAll(type, words, scale = 1, offset = 0) {
  const row = {};
  for (const c of COMBOS) {
    try {
      const raw = decode(type, words, { byteOrder: c.byteOrder, wordOrder: c.wordOrder });
      const value = raw * (scale ?? 1) + (offset ?? 0);
      row[c.key] = Number.isFinite(value) ? Number(value.toFixed(4)) : null;
    } catch (e) {
      row[c.key] = null;
    }
  }
  return row;
}

const hex = (words) => words.map((w) => '0x' + (w & 0xffff).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const pad = (s, n) => String(s ?? '').padEnd(n);
const padL = (s, n) => String(s ?? '').padStart(n);

async function main() {
  const { cfg, src } = loadConfig();
  const unitId = Number(arg('unit', src.unitId ?? 1));

  console.log(C.bold('\nPulse IoT — hardware commissioning verification'));
  console.log(C.dim('─'.repeat(78)));
  console.log(`device   ${src.host}:${src.port || 502}  unit ${unitId}`);
  console.log(`config   ${arg('config', 'config.json')}`);
  console.log(`declared ${src.addressingMode || 'one_based'} · byte ${src.byteOrder || 'big'} · word ${src.wordOrder || 'big'}`);
  console.log(C.dim('READ-ONLY — this tool issues Modbus read codes only and cannot write a register.'));
  console.log(C.dim('─'.repeat(78)));

  let ModbusRTU;
  try {
    ModbusRTU = require('modbus-serial');
  } catch {
    console.error(C.red("\nmodbus-serial is not installed. Run:  npm i modbus-serial\n"));
    process.exit(1);
  }

  const client = new ModbusRTU();
  try {
    await client.connectTCP(src.host, { port: src.port || 502 });
    client.setID(unitId);
    client.setTimeout(src.timeoutMs ?? 3000);
  } catch (e) {
    console.error(C.red(`\nCould not connect: ${e.message}`));
    console.error(C.dim('Check the IP, the port, that the panel is powered, and that this machine is on the same network.\n'));
    process.exit(1);
  }
  console.log(C.green('connected\n'));

  const results = [];
  for (const reg of src.registers) {
    const raw = await readRaw(client, reg);
    const entry = {
      metric: reg.metric,
      documented_address: reg.address,
      table: reg.register || 'holding',
      type: reg.type,
      scale: reg.scale ?? 1,
      offset: reg.offset ?? 0,
      unit: reg.unit ?? null,
      readings: {},
    };

    for (const mode of ['one_based', 'zero_based']) {
      const r = raw[mode];
      if (r.error) { entry.readings[mode] = { protocol_address: r.addr ?? null, error: r.error }; continue; }
      entry.readings[mode] = {
        protocol_address: r.addr,
        raw_hex: hex(r.words),
        raw_words: r.words,
        decoded: decodeAll(reg.type, r.words, reg.scale ?? 1, reg.offset ?? 0),
      };
    }
    results.push(entry);

    // ── print one block per register ──────────────────────────────────────────
    console.log(C.bold(`${entry.metric}`) + C.dim(`  documented ${reg.address} · ${entry.table} · ${reg.type} · scale ${entry.scale}${reg.offset ? ` · offset ${reg.offset}` : ''}${reg.unit ? ` · ${reg.unit}` : ''}`));

    const header = '  ' + pad('addressing', 12) + pad('protocol', 10) + pad('raw', 14)
      + COMBOS.map((c) => padL(c.key, 16)).join('');
    console.log(C.dim(header));

    for (const mode of ['one_based', 'zero_based']) {
      const r = entry.readings[mode];
      if (r.error) {
        console.log('  ' + pad(mode, 12) + pad(r.protocol_address ?? '—', 10) + C.red(`error: ${r.error}`));
        continue;
      }
      const cells = COMBOS.map((c) => padL(r.decoded[c.key] ?? '—', 16)).join('');
      console.log('  ' + pad(mode, 12) + pad(r.protocol_address, 10) + pad(r.raw_hex, 14) + cells);
    }
    console.log(C.cyan('  → read the device display for this quantity and find the matching column.'));
    console.log();
  }

  // Close and WAIT for it. modbus-serial's close() is callback-based; firing it
  // and moving on leaves the TCP socket holding the event loop open, so the
  // process prints everything and then hangs — and because ServerTCP serialises
  // connections, a hung run blocks the next one. Found by the test that runs this
  // tool as a process.
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    // The guard matters: resolving twice let process.exit() run while libuv was
    // still closing the socket, which aborts with
    //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\winsync.c
    // AFTER a completely successful run. On site that reads as a crash, and the
    // engineer has no way to know the evidence was already posted.
    const timer = setTimeout(finish, 1000);
    try { client.close(finish); } catch { finish(); }
  });

  // ── guidance ────────────────────────────────────────────────────────────────
  console.log(C.dim('─'.repeat(78)));
  console.log(C.bold('How to read this'));
  console.log(`
  Each row is the SAME bytes decoded under a different convention. A device uses
  ONE convention for everything, so the correct column is the one that matches the
  device display for ${C.bold('every')} register — not just for the first one you check.

  ${C.yellow('If two columns look plausible for one register, check another register.')}
  A voltage near 415 is easy to match by accident; a temperature or a power factor
  usually is not.

  ${C.yellow('If no column matches:')}
    · the documented address may be off — try the neighbouring register
    · the scale may be wrong (a factor of 10 or 1000 is the usual culprit)
    · the quantity may live in the other table (holding vs input)

  Once you have the answer, set it on the device profile in Pulse:
    ${C.cyan('IoT → Metric & Device Registry → Device profiles → your profile')}
  and record the comparison against the device display and a reference instrument
  as the pilot evidence (IOT_HARDWARE_PILOT.md section 3).
`);

  // ── evidence file ───────────────────────────────────────────────────────────
  const evidence = {
    tool: 'pulse-edge-gateway verify',
    version: '1.0.0',
    performed_at: new Date().toISOString(),
    device: {
      host: src.host, port: src.port || 502, unit_id: unitId,
      device_uid: cfg.deviceUid ?? null, gateway_uid: cfg.gatewayUid ?? null,
    },
    declared_conventions: {
      addressing_mode: src.addressingMode || 'one_based',
      byte_order: src.byteOrder || 'big',
      word_order: src.wordOrder || 'big',
    },
    // Deliberately left blank — a human fills these in from the device display and
    // the reference instrument. A tool that filled them itself would be inventing
    // the very evidence the pilot exists to collect.
    observed: {
      confirmed_addressing_mode: null,
      confirmed_byte_order: null,
      confirmed_word_order: null,
      engineer: null,
      reference_instrument: null,
      notes: null,
    },
    registers: results,
  };

  const outFile = arg('json', path.join(__dirname, `pilot-evidence-${Date.now()}.json`));
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2));
  console.log(C.green(`evidence written to ${outFile}`));
  console.log(C.dim('  The `observed` block is intentionally empty — fill it in from the device'));
  console.log(C.dim('  display and the reference instrument. This tool reads registers; it cannot'));
  console.log(C.dim('  witness what the device says about itself.\n'));

  if (flag('post')) {
    if (!cfg.ingestUrl || !cfg.token || !cfg.deviceUid) {
      console.error(C.red('--post needs ingestUrl, deviceUid and token in the config.'));
      process.exit(1);
    }
    const url = cfg.ingestUrl.replace(/\/ingest$/, '/pilot-evidence');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': cfg.token },
        body: JSON.stringify({ device_uid: cfg.deviceUid, evidence }),
      });
      const body = await res.text();
      if (res.ok) console.log(C.green(`posted to Pulse: ${body.slice(0, 200)}\n`));
      else console.error(C.red(`post failed ${res.status}: ${body.slice(0, 300)}\n`));
    } catch (e) {
      console.error(C.red(`post failed: ${e.message}\n`));
    }
  }
}

main()
  .then(() => {
    // Let the loop drain on its own rather than calling process.exit() outright —
    // an immediate exit races libuv's socket teardown and aborts the process after
    // a successful run. The unref'd fallback covers a handle that never closes, so
    // the tool still cannot hang on site.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 2000).unref();
  })
  .catch((e) => { console.error(C.red(`fatal: ${e.stack || e.message}`)); process.exit(1); });
