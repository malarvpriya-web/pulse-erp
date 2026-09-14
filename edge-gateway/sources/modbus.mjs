/**
 * modbus.mjs — reads a real device over Modbus TCP and maps registers to metrics.
 *
 * Requires the optional `modbus-serial` dependency:  npm i modbus-serial
 * (kept optional so the gateway installs and runs in `sim` mode on machines
 * without native build tooling; only sites with real hardware need it.)
 *
 * ── WHAT THE PREVIOUS VERSION ASSUMED, AND WHY THAT WAS WRONG ────────────────
 *
 * It hardcoded THREE conventions as if they were universal:
 *
 *   1. `const addr = (r.address % 10000) - 1`  — one-based 4xxxx/3xxxx notation.
 *      Plenty of devices document ZERO-based protocol addresses; on those, every
 *      register was read one position low and returned a neighbouring quantity.
 *      A voltage that is really a current is not an obvious failure: it is a
 *      plausible number in the wrong units.
 *
 *   2. Big-endian WORD order for 32-bit values. Little-endian word order (often
 *      called "word swap" or "CDAB") is at least as common. A float32 decoded with
 *      the words the wrong way round produces a number that is neither close to
 *      the truth nor obviously invalid.
 *
 *   3. Big-endian BYTE order within each word.
 *
 * All three are now per-device configuration, defaulting to the old behaviour so
 * an existing config keeps working.
 *
 * ── PARTIAL FAILURE ──────────────────────────────────────────────────────────
 * The old read() awaited every register in a loop with no error handling, so ONE
 * unreadable register threw and discarded the entire polling cycle — including
 * the registers that had already read correctly. Now each register is attempted
 * independently and a failure produces a COMMUNICATION_ERROR-quality sample, so
 * the server can distinguish "the device did not answer" from "the gateway is
 * down" from "nobody configured this metric".
 *
 * config.source = {
 *   type: "modbus",
 *   host: "192.168.1.50", port: 502, unitId: 1, timeoutMs: 2000,
 *   addressingMode: "one_based" | "zero_based",     // default one_based
 *   byteOrder: "big" | "little",                    // default big
 *   wordOrder: "big" | "little",                    // default big
 *   reconnectSecs: 10,
 *   registers: [
 *     { metric: "THD_I_L1", address: 40001, register: "holding",
 *       type: "float32", scale: 1, offset: 0, unit: "%" }
 *   ]
 * }
 *   register — "holding" (4xxxx) or "input" (3xxxx)
 *   type     — int16 | uint16 | int32 | uint32 | float32 | float64
 *   scale    — multiply the raw value (default 1)
 *   offset   — added AFTER scaling (default 0)
 */

const WORDS = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2, float64: 4 };

/**
 * Decode raw 16-bit registers into a number under an explicit convention.
 * Exported for unit testing — the decode conventions are exactly the thing that
 * must be verified against real hardware, and a test that cannot reach the
 * decoder can only test the mock.
 */
export function decode(type, regs, { byteOrder = 'big', wordOrder = 'big' } = {}) {
  const words = [...regs];
  if (wordOrder === 'little') words.reverse();

  const buf = Buffer.alloc(words.length * 2);
  words.forEach((r, i) => {
    const v = r & 0xffff;
    if (byteOrder === 'little') buf.writeUInt16LE(v, i * 2);
    else buf.writeUInt16BE(v, i * 2);
  });

  const be = byteOrder !== 'little';
  switch (type) {
    case 'int16':   return be ? buf.readInt16BE(0)   : buf.readInt16LE(0);
    case 'uint16':  return be ? buf.readUInt16BE(0)  : buf.readUInt16LE(0);
    case 'int32':   return be ? buf.readInt32BE(0)   : buf.readInt32LE(0);
    case 'uint32':  return be ? buf.readUInt32BE(0)  : buf.readUInt32LE(0);
    case 'float32': return be ? buf.readFloatBE(0)   : buf.readFloatLE(0);
    case 'float64': return be ? buf.readDoubleBE(0)  : buf.readDoubleLE(0);
    default: throw new Error(`unsupported register type: ${type}`);
  }
}

/**
 * Protocol address for a documented register address.
 * one_based: 40001 -> 0 (the classic 4xxxx convention)
 * zero_based: the documented number IS the protocol address
 */
export function protocolAddress(address, mode = 'one_based') {
  const a = Number(address);
  if (mode === 'zero_based') return a;
  return (a % 10000) - 1;
}

export async function createSource(cfg) {
  let Modbus;
  try {
    Modbus = (await import('modbus-serial')).default;
  } catch {
    throw new Error("modbus source needs the 'modbus-serial' package — run: npm i modbus-serial");
  }
  const registers = Array.isArray(cfg.registers) ? cfg.registers : [];
  if (!registers.length) throw new Error('modbus source needs a non-empty registers[] array');

  const conv = {
    byteOrder: cfg.byteOrder || 'big',
    wordOrder: cfg.wordOrder || 'big',
  };
  const addressing = cfg.addressingMode || 'one_based';
  const reconnectMs = (Number(cfg.reconnectSecs) || 10) * 1000;

  const client = new Modbus();
  let lastConnectAttempt = 0;
  let connected = false;

  const connect = async () => {
    if (client.isOpen) { connected = true; return; }
    if (Date.now() - lastConnectAttempt < reconnectMs) {
      throw new Error('waiting for the reconnect interval before retrying the TCP connection');
    }
    lastConnectAttempt = Date.now();
    await client.connectTCP(cfg.host, { port: cfg.port || 502 });
    client.setID(cfg.unitId ?? 1);
    client.setTimeout(cfg.timeoutMs ?? 2000);
    connected = true;
    console.log(new Date().toISOString(), `modbus connected ${cfg.host}:${cfg.port || 502} unit ${cfg.unitId ?? 1} (${addressing}, byte ${conv.byteOrder}, word ${conv.wordOrder})`);
  };

  return {
    async read() {
      try {
        await connect();
      } catch (e) {
        connected = false;
        // The whole device is unreachable. Report that per metric rather than
        // throwing the cycle away, so the server records a communication error
        // instead of an unexplained gap.
        return registers.map((r) => ({
          metric: r.metric, value: null, quality: 'COMMUNICATION_ERROR',
        }));
      }

      const out = [];
      for (const r of registers) {
        const words = WORDS[r.type] ?? 1;
        const addr = protocolAddress(r.address, addressing);
        try {
          const fn = r.register === 'input' ? client.readInputRegisters : client.readHoldingRegisters;
          const res = await fn.call(client, addr, words);
          const raw = decode(r.type, res.data, conv);
          const value = raw * (r.scale ?? 1) + (r.offset ?? 0);
          if (!Number.isFinite(value)) {
            out.push({ metric: r.metric, value: null, quality: 'INVALID' });
            continue;
          }
          out.push({ metric: r.metric, value: Number(value.toFixed(4)), quality: 'VALID' });
        } catch (e) {
          // ONE register failing does not invalidate the others.
          console.error(new Date().toISOString(), `modbus read failed for ${r.metric} @${r.address} (protocol ${addr}): ${e.message}`);
          out.push({ metric: r.metric, value: null, quality: 'COMMUNICATION_ERROR' });
          if (/timed out|ECONNRESET|EPIPE|port not open/i.test(e.message)) {
            try { client.close(); } catch { /* ignore */ }
            connected = false;
            break; // the link is gone; the remaining registers are reported below
          }
        }
      }
      // Registers not reached after a link drop still need a quality marker.
      for (const r of registers.slice(out.length)) {
        out.push({ metric: r.metric, value: null, quality: 'COMMUNICATION_ERROR' });
      }
      return out;
    },
    get connected() { return connected; },
    async close() { try { client.close(); } catch { /* ignore */ } },
  };
}
