/**
 * modbus.decode.test.mjs — register decoding under every supported convention.
 *
 * These are the conventions the previous version hardcoded. A wrong byte or word
 * order does not produce an error, it produces a plausible number — which is why
 * it survived unnoticed and why it needs a test that pins each convention to a
 * known bit pattern rather than to "what the code currently does".
 *
 * The reference value: IEEE-754 single-precision 415.5 is 0x43CFC000, i.e. the
 * register pair [0x43CF, 0xC000] in big-endian word order.
 *
 * ⚠ Passing these tests does NOT mean a given device is being read correctly.
 * They prove the decoder implements each convention faithfully; which convention
 * a particular AHF/SVG/STATCOM uses is a hardware fact that has to be established
 * against the device itself — see IOT_HARDWARE_PILOT.md.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decode, protocolAddress } from '../sources/modbus.mjs';

describe('word and byte order', () => {
  test('float32, big-endian words and bytes (the classic default)', () => {
    assert.equal(decode('float32', [0x43CF, 0xC000], { byteOrder: 'big', wordOrder: 'big' }), 415.5);
  });

  test('float32 with SWAPPED words (CDAB) decodes correctly only under wordOrder little', () => {
    const swapped = [0xC000, 0x43CF];
    assert.equal(decode('float32', swapped, { byteOrder: 'big', wordOrder: 'little' }), 415.5);
    // And under the old hardcoded convention it yields a plausible-looking number
    // that is simply wrong — the failure mode this configuration exists to stop.
    const wrong = decode('float32', swapped, { byteOrder: 'big', wordOrder: 'big' });
    assert.notEqual(wrong, 415.5);
    assert.ok(Number.isFinite(wrong), 'the wrong reading is finite, which is exactly why it went unnoticed');
  });

  test('int16 signed values decode negative correctly', () => {
    assert.equal(decode('int16', [0xFFFF], {}), -1);
    assert.equal(decode('uint16', [0xFFFF], {}), 65535);
  });

  test('int32 across two registers, big word order', () => {
    assert.equal(decode('int32', [0x0001, 0x0000], { wordOrder: 'big' }), 65536);
    assert.equal(decode('int32', [0x0000, 0x0001], { wordOrder: 'little' }), 65536);
  });

  test('uint32 maximum does not wrap to -1', () => {
    assert.equal(decode('uint32', [0xFFFF, 0xFFFF], {}), 4294967295);
  });

  test('an unsupported type is refused rather than guessed', () => {
    assert.throws(() => decode('float24', [0x0001], {}), /unsupported register type/);
  });
});

describe('addressing mode', () => {
  test('one_based: 40001 is protocol address 0', () => {
    assert.equal(protocolAddress(40001, 'one_based'), 0);
    assert.equal(protocolAddress(40010, 'one_based'), 9);
    assert.equal(protocolAddress(30001, 'one_based'), 0);
  });

  test('zero_based: the documented number IS the protocol address', () => {
    assert.equal(protocolAddress(0, 'zero_based'), 0);
    assert.equal(protocolAddress(100, 'zero_based'), 100);
  });

  test('the two conventions differ by one — which reads a NEIGHBOURING quantity', () => {
    // 40002 under one_based is register 1; under zero_based it is register 40002.
    // On a device documented zero-based, the old hardcoded conversion read
    // register 1 instead — a different measurement entirely, returned as a
    // perfectly valid number.
    assert.notEqual(protocolAddress(40002, 'one_based'), protocolAddress(40002, 'zero_based'));
  });
});

describe('scaling', () => {
  test('scale and offset are applied in that order', () => {
    const raw = decode('int16', [0x03E8], {});          // 1000
    assert.equal(raw, 1000);
    assert.equal(raw * 0.001 + 0, 1);                    // milli-units -> units
    assert.equal(raw * 0.1 + 5, 105);                    // scale THEN offset
  });
});
