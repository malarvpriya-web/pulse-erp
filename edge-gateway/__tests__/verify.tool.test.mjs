/**
 * verify.tool.test.mjs — the commissioning tool, run against a real Modbus server.
 *
 * `verify.mjs` is the thing a field engineer will actually run on site, once,
 * under time pressure, on a live panel. A tool in that position that crashes, or
 * that silently produces a half-filled evidence file, is worse than no tool. So it
 * is tested the same way the gateway is: as a process, against a real server.
 *
 * The important assertion is the last one — the tool must NOT fill in the
 * `observed` block. That block is the human's judgement against the device
 * display, and a tool that pre-filled it would be manufacturing the exact evidence
 * the pilot exists to collect.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ModbusRTU = require('modbus-serial');
const { ServerTCP } = ModbusRTU;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.resolve(__dirname, '../verify.mjs');

const HOLDING = new Map([[0, 0x43CF], [1, 0xC000], [2, 0x03E8], [5, 0xFFCE]]);
let server, PORT, tmp;

before(async () => {
  PORT = 16100 + Math.floor(Math.random() * 300);
  server = new ServerTCP({
    getHoldingRegister: (addr, unitID, cb) => cb(null, HOLDING.get(addr) ?? 0),
    getInputRegister: (addr, unitID, cb) => cb(null, 0),
  }, { host: '127.0.0.1', port: PORT, debug: false, unitID: 1 });
  await new Promise((r) => setTimeout(r, 400));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-verify-'));
});

after(async () => {
  await new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeConfig(over = {}) {
  const file = path.join(tmp, `config-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    ingestUrl: 'http://127.0.0.1:1/api/v1/iot/ingest',
    deviceUid: 'PILOT-TEST-1',
    gatewayUid: 'GW-PILOT-TEST',
    token: 'not-used-without-post',
    source: {
      type: 'modbus',
      host: '127.0.0.1', port: PORT, unitId: 1, timeoutMs: 1500,
      addressingMode: 'zero_based', byteOrder: 'big', wordOrder: 'big',
      registers: [
        { metric: 'V_L1', address: 0, register: 'holding', type: 'float32', scale: 1, unit: 'V' },
        { metric: 'PF', address: 2, register: 'holding', type: 'int16', scale: 0.001, unit: 'ratio' },
        { metric: 'TEMPERATURE', address: 5, register: 'holding', type: 'int16', scale: 0.1, unit: 'degC' },
      ],
      ...over,
    },
  }, null, 2));
  return file;
}

const execFileAsync = promisify(execFile);

/**
 * MUST be async. The Modbus server under test lives in THIS process, so a
 * synchronous execFileSync blocks the event loop that has to answer the child's
 * read requests — every register then times out and the tool reports a device
 * that is sitting right there. Cost: one confusing run where the tool looked
 * broken and the test harness was at fault.
 */
async function run(configFile, jsonOut) {
  const { stdout } = await execFileAsync(
    process.execPath, [VERIFY, '--config', configFile, '--json', jsonOut],
    { encoding: 'utf8', timeout: 30_000 });
  return stdout;
}

describe('the commissioning tool', () => {
  test('reads every register and prints all four decode conventions side by side', async () => {
    const cfg = writeConfig();
    const out = path.join(tmp, 'evidence1.json');
    const stdout = await run(cfg, out);

    assert.match(stdout, /connected/);
    for (const metric of ['V_L1', 'PF', 'TEMPERATURE']) {
      assert.match(stdout, new RegExp(metric), `${metric} must appear in the report`);
    }
    for (const combo of ['big/big', 'big/little', 'little/big', 'little/little']) {
      assert.ok(stdout.includes(combo), `the ${combo} column must be shown`);
    }
    // both addressing modes attempted, so the engineer can see the off-by-one
    assert.match(stdout, /one_based/);
    assert.match(stdout, /zero_based/);
    assert.match(stdout, /READ-ONLY/);
  });

  test('the correct convention is present and identifiable in the output', async () => {
    const cfg = writeConfig();
    const out = path.join(tmp, 'evidence2.json');
    await run(cfg, out);
    const ev = JSON.parse(fs.readFileSync(out, 'utf8'));

    const v = ev.registers.find((r) => r.metric === 'V_L1');
    assert.equal(v.readings.zero_based.decoded['big/big'], 415.5);
    assert.notEqual(v.readings.zero_based.decoded['big/little'], 415.5);

    const t = ev.registers.find((r) => r.metric === 'TEMPERATURE');
    assert.equal(t.readings.zero_based.decoded['big/big'], -5,
      'the signed decode plus scale is what the engineer compares against the display');
  });

  test('the evidence file records the RAW bytes, not just an interpretation', async () => {
    const cfg = writeConfig();
    const out = path.join(tmp, 'evidence3.json');
    await run(cfg, out);
    const ev = JSON.parse(fs.readFileSync(out, 'utf8'));

    const v = ev.registers.find((r) => r.metric === 'V_L1');
    assert.equal(v.readings.zero_based.raw_hex, '0x43CF 0xC000');
    assert.deepEqual(v.readings.zero_based.raw_words, [0x43CF, 0xC000]);
    // Raw bytes matter: if the map turns out to be wrong six months later, the
    // recorded hex can be re-decoded. A stored engineering value cannot.
    assert.ok(v.readings.zero_based.protocol_address >= 0);
    assert.ok(ev.performed_at);
    assert.equal(ev.device.port, PORT);
  });

  test('an unreachable device exits with a diagnosis rather than a stack trace', async () => {
    const cfg = writeConfig({ host: '127.0.0.1', port: 1, timeoutMs: 400 });
    const out = path.join(tmp, 'evidence4.json');
    let stdout = '', stderr = '', failed = false;
    try {
      stdout = await run(cfg, out);
    } catch (e) {
      failed = true;
      stdout = e.stdout || '';
      stderr = e.stderr || '';
    }
    assert.ok(failed, 'it must exit non-zero when it cannot reach the device');
    const all = stdout + stderr;
    assert.match(all, /Could not connect/);
    assert.match(all, /Check the IP/);
    assert.ok(!/at Object\.<anonymous>/.test(all), 'a field engineer should not be shown a stack trace');
  });

  test('THE TOOL DOES NOT FILL IN THE OBSERVED BLOCK', async () => {
    // This is the assertion that matters most. The `observed` block is what a
    // human concluded by looking at the device and a reference instrument. A tool
    // that populated it — even helpfully, even from its own best guess — would be
    // manufacturing the evidence the pilot exists to collect, which is the exact
    // failure mode this whole phase has been removing.
    const cfg = writeConfig();
    const out = path.join(tmp, 'evidence5.json');
    await run(cfg, out);
    const ev = JSON.parse(fs.readFileSync(out, 'utf8'));

    assert.equal(ev.observed.confirmed_addressing_mode, null);
    assert.equal(ev.observed.confirmed_byte_order, null);
    assert.equal(ev.observed.confirmed_word_order, null);
    assert.equal(ev.observed.engineer, null);
    assert.equal(ev.observed.reference_instrument, null);

    // and the declared conventions are recorded as DECLARED, never as confirmed
    assert.equal(ev.declared_conventions.addressing_mode, 'zero_based');
    assert.ok(!('confirmed' in ev.declared_conventions));
  });
});
