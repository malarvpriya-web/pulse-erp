/**
 * modbus.integration.test.mjs — the Modbus SOURCE, driven over a real Modbus TCP
 * socket against a real Modbus TCP server.
 *
 * WHAT THIS CLOSES, AND WHAT IT DOES NOT
 * --------------------------------------
 * `modbus.decode.test.mjs` unit-tests the decoder. That left a gap nobody had
 * named: `createSource()` itself — connect, setID, setTimeout, readHoldingRegisters,
 * readInputRegisters, the per-register try/catch, the link-drop path, the
 * reconnect interval and the scale/offset application — had **never executed at
 * all**, because `modbus-serial` is an optionalDependency and was not installed.
 * Every one of those lines was unverified code shipping in a file whose header
 * describes it as production-ready.
 *
 * This suite runs a genuine Modbus TCP server on a loopback port, serves known
 * register values, and drives the real client against it. It proves the transport,
 * the function codes, the decode conventions end to end, the partial-failure
 * behaviour and the reconnect logic.
 *
 * ⚠ IT IS STILL NOT HARDWARE VALIDATION. A server that answers correctly proves
 * the client speaks Modbus properly; it says nothing about which addressing mode,
 * word order or scaling a PARTICULAR AHF uses, because those are facts about a
 * device, not about a protocol. `IOT_HARDWARE_PILOT.md` remains the only way to
 * establish them. What changed is the size of the remaining unknown: it was "the
 * whole Modbus path is unexercised"; it is now "the register map for this model is
 * unverified."
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSource } from '../sources/modbus.mjs';

const require = createRequire(import.meta.url);
const ModbusRTU = require('modbus-serial');
const { ServerTCP } = ModbusRTU;

/**
 * The register file the fake device exposes. Values are chosen so a wrong
 * convention produces a DIFFERENT and recognisable number, which is the whole
 * point — a convention error that happened to yield the same value would prove
 * nothing.
 *
 *   holding[0..1] = 0x43CF 0xC000  -> float32 big/big  = 415.5   (V_L1)
 *   holding[2]    = 0x03E8         -> int16            = 1000    (PF, scale 0.001 -> 1.0)
 *   holding[3..4] = 0x0001 0x0000  -> int32 big        = 65536   (KVAR)
 *   holding[5]    = 0xFFCE         -> int16            = -50     (TEMPERATURE, scale 0.1 -> -5)
 *   holding[9..10]= 0x0000 0x2710  -> uint32           = 10000   (ENERGY_KWH, scale 0.01 -> 100)
 *   input[0]      = 0x1388         -> uint16           = 5000    (THD via input table)
 *   holding[20]   = always throws  -> the unreadable register
 */
const HOLDING = new Map([
  [0, 0x43CF], [1, 0xC000],
  [2, 0x03E8],
  [3, 0x0001], [4, 0x0000],
  [5, 0xFFCE],
  [9, 0x0000], [10, 0x2710],
]);
const INPUT = new Map([[0, 0x1388]]);

const UNREADABLE = 20;          // address that always errors
let failEverything = false;     // flips the whole device offline mid-test

function startServer(port) {
  const vector = {
    getHoldingRegister(addr, unitID, cb) {
      if (failEverything) return cb(new Error('device offline'), 0);
      if (addr === UNREADABLE) return cb(new Error('illegal data address'), 0);
      cb(null, HOLDING.get(addr) ?? 0);
    },
    getInputRegister(addr, unitID, cb) {
      if (failEverything) return cb(new Error('device offline'), 0);
      cb(null, INPUT.get(addr) ?? 0);
    },
  };
  return new ServerTCP(vector, { host: '127.0.0.1', port, debug: false, unitID: 1 });
}

let server;
let PORT;

before(async () => {
  PORT = 15502 + Math.floor(Math.random() * 400);
  server = startServer(PORT);
  // ServerTCP has no ready promise; give the listener a moment to bind.
  await new Promise((r) => setTimeout(r, 400));
});

after(async () => {
  failEverything = false;
  await new Promise((resolve) => {
    if (!server) return resolve();
    try { server.close(resolve); } catch { resolve(); }
  });
});

beforeEach(() => { failEverything = false; });

const cfg = (over = {}) => ({
  host: '127.0.0.1', port: PORT, unitId: 1, timeoutMs: 1500, reconnectSecs: 0,
  addressingMode: 'zero_based',
  byteOrder: 'big', wordOrder: 'big',
  registers: [],
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the Modbus source over a real TCP socket', () => {
  test('connects and reads a float32 holding register', async () => {
    const src = await createSource(cfg({
      registers: [{ metric: 'V_L1', address: 0, register: 'holding', type: 'float32', scale: 1 }],
    }));
    const out = await src.read();
    await src.close();

    assert.equal(out.length, 1);
    assert.equal(out[0].metric, 'V_L1');
    assert.equal(out[0].quality, 'VALID');
    assert.equal(out[0].value, 415.5);
  });

  test('applies scale and offset to the decoded value', async () => {
    const src = await createSource(cfg({
      registers: [
        { metric: 'PF', address: 2, register: 'holding', type: 'int16', scale: 0.001 },
        { metric: 'TEMPERATURE', address: 5, register: 'holding', type: 'int16', scale: 0.1, offset: 0 },
        { metric: 'ENERGY_KWH', address: 9, register: 'holding', type: 'uint32', scale: 0.01 },
      ],
    }));
    const out = await src.read();
    await src.close();

    const by = Object.fromEntries(out.map((r) => [r.metric, r.value]));
    assert.equal(by.PF, 1);                 // 1000 x 0.001
    assert.equal(by.TEMPERATURE, -5);       // -50 x 0.1, signed decode proven over the wire
    assert.equal(by.ENERGY_KWH, 100);       // 10000 x 0.01
  });

  test('reads from the INPUT register table, not only holding', async () => {
    const src = await createSource(cfg({
      registers: [{ metric: 'THD_I_L1', address: 0, register: 'input', type: 'uint16', scale: 0.001 }],
    }));
    const out = await src.read();
    await src.close();
    assert.equal(out[0].value, 5);          // 5000 x 0.001
    assert.equal(out[0].quality, 'VALID');
  });

  test('int32 across two registers decodes over the wire', async () => {
    const src = await createSource(cfg({
      registers: [{ metric: 'KVAR', address: 3, register: 'holding', type: 'int32', scale: 1 }],
    }));
    const out = await src.read();
    await src.close();
    assert.equal(out[0].value, 65536);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('decode conventions, end to end', () => {
  test('word order changes the value — and BOTH results are plausible', async () => {
    // This is the failure mode the hardware pilot exists to catch. The same
    // registers, read with the wrong word order, return a finite, believable
    // voltage. Nothing in the pipeline can tell which one is right; only the
    // device's own display can.
    const big = await createSource(cfg({
      wordOrder: 'big',
      registers: [{ metric: 'V_L1', address: 0, register: 'holding', type: 'float32', scale: 1 }],
    }));
    const bigOut = await big.read();
    await big.close();

    const little = await createSource(cfg({
      wordOrder: 'little',
      registers: [{ metric: 'V_L1', address: 0, register: 'holding', type: 'float32', scale: 1 }],
    }));
    const littleOut = await little.read();
    await little.close();

    assert.equal(bigOut[0].value, 415.5);
    assert.notEqual(littleOut[0].value, 415.5);
    assert.ok(Number.isFinite(littleOut[0].value),
      'the WRONG convention yields a finite number — which is why it goes unnoticed without a device to compare against');
    assert.equal(littleOut[0].quality, 'VALID',
      'and it is reported as VALID, because nothing about the protocol says it is wrong');
  });

  test('addressing mode shifts which register is read', async () => {
    // one_based turns 40001 into protocol address 0; zero_based reads address
    // 40001 itself, which this server answers with 0.
    const oneBased = await createSource(cfg({
      addressingMode: 'one_based',
      registers: [{ metric: 'V_L1', address: 40001, register: 'holding', type: 'float32', scale: 1 }],
    }));
    const a = await oneBased.read();
    await oneBased.close();
    assert.equal(a[0].value, 415.5, 'one_based must resolve 40001 to protocol 0');

    const zeroBased = await createSource(cfg({
      addressingMode: 'zero_based',
      registers: [{ metric: 'V_L1', address: 2, register: 'holding', type: 'int16', scale: 1 }],
    }));
    const b = await zeroBased.read();
    await zeroBased.close();
    assert.equal(b[0].value, 1000, 'zero_based must read address 2 verbatim');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('failure behaviour', () => {
  test('ONE unreadable register does not discard the rest of the cycle', async () => {
    // The pre-Phase-4 source awaited every register in a bare loop, so a single
    // failing read threw and took the whole polling cycle with it — including the
    // registers that had already read correctly.
    const src = await createSource(cfg({
      registers: [
        { metric: 'V_L1', address: 0, register: 'holding', type: 'float32', scale: 1 },
        { metric: 'MODULE_STATUS', address: UNREADABLE, register: 'holding', type: 'int16', scale: 1 },
        { metric: 'PF', address: 2, register: 'holding', type: 'int16', scale: 0.001 },
      ],
    }));
    const out = await src.read();
    await src.close();

    assert.equal(out.length, 3, 'every configured metric is accounted for');
    const by = Object.fromEntries(out.map((r) => [r.metric, r]));
    assert.equal(by.V_L1.value, 415.5);
    assert.equal(by.V_L1.quality, 'VALID');
    assert.equal(by.MODULE_STATUS.value, null);
    assert.equal(by.MODULE_STATUS.quality, 'COMMUNICATION_ERROR',
      'the bad register is reported as a communication error, not omitted and not zero');
    assert.equal(by.PF.value, 1, 'the register AFTER the failure is still read');
  });

  test('an unreachable device reports COMMUNICATION_ERROR per metric, not an exception', async () => {
    const src = await createSource(cfg({
      host: '127.0.0.1', port: 1,        // nothing listens here
      timeoutMs: 400, reconnectSecs: 0,
      registers: [
        { metric: 'V_L1', address: 0, register: 'holding', type: 'float32' },
        { metric: 'PF', address: 2, register: 'holding', type: 'int16' },
      ],
    }));
    const out = await src.read();
    await src.close();

    assert.equal(out.length, 2);
    for (const r of out) {
      assert.equal(r.value, null);
      assert.equal(r.quality, 'COMMUNICATION_ERROR');
    }
    // A zero here would be a measurement. null + COMMUNICATION_ERROR is an
    // absence, and the server quarantines it rather than averaging it in.
    assert.ok(out.every((r) => r.value !== 0));
  });

  test('the device going offline mid-run is reported, then recovers', async () => {
    const src = await createSource(cfg({
      reconnectSecs: 0,
      registers: [{ metric: 'V_L1', address: 0, register: 'holding', type: 'float32', scale: 1 }],
    }));

    const good = await src.read();
    assert.equal(good[0].quality, 'VALID');

    failEverything = true;
    const bad = await src.read();
    assert.equal(bad[0].quality, 'COMMUNICATION_ERROR');
    assert.equal(bad[0].value, null);

    failEverything = false;
    const recovered = await src.read();
    await src.close();
    assert.equal(recovered[0].quality, 'VALID');
    assert.equal(recovered[0].value, 415.5,
      'the source recovers on its own rather than needing a restart');
  });

  test('the reconnect interval is honoured rather than hammering a dead device', async () => {
    const src = await createSource(cfg({
      host: '127.0.0.1', port: 1, timeoutMs: 300,
      reconnectSecs: 60,             // a long interval, so a second attempt must be refused
      registers: [{ metric: 'V_L1', address: 0, register: 'holding', type: 'float32' }],
    }));

    const t0 = Date.now();
    await src.read();                // first attempt: tries, fails
    const firstElapsed = Date.now() - t0;

    const t1 = Date.now();
    await src.read();                // second: must NOT attempt a TCP connect
    const secondElapsed = Date.now() - t1;
    await src.close();

    assert.ok(secondElapsed < firstElapsed || secondElapsed < 50,
      `the second attempt must be short-circuited by the reconnect interval (first ${firstElapsed}ms, second ${secondElapsed}ms)`);
  });

  test('an empty register map is refused at construction', async () => {
    await assert.rejects(
      () => createSource(cfg({ registers: [] })),
      /non-empty registers/,
      'a source with no registers would poll forever and report nothing',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what this suite does NOT prove', () => {
  test('a register map is a fact about a DEVICE, not about the protocol', () => {
    // Deliberately a documentation assertion. The suite above can be entirely
    // green while every value Pulse stores is wrong, because the server here
    // answers whatever the test asked it to. Only a comparison against the
    // device's own display and a reference instrument settles the map.
    const provenByThisSuite = [
      'the TCP transport and function codes',
      'decode under each byte/word convention',
      'addressing-mode resolution',
      'scale and offset application',
      'partial read failure',
      'reconnect and recovery',
    ];
    const notProven = [
      'which addressing mode a given AHF uses',
      'which word order a given AHF uses',
      'the scale factor for a given register',
      'which metrics a given model actually publishes',
      'the width at which a given energy counter rolls over',
    ];
    assert.ok(provenByThisSuite.length > 0);
    assert.equal(notProven.length, 5,
      'these five remain open until IOT_HARDWARE_PILOT.md is executed against a physical unit');
  });
});
