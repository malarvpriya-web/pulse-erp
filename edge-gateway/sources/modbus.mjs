/**
 * modbus.mjs — reads a real device over Modbus TCP and maps registers to metrics.
 *
 * Requires the optional `modbus-serial` dependency:  npm i modbus-serial
 * (kept optional so the gateway installs and runs in `sim` mode on machines
 * without native build tooling; only sites with real hardware need it.)
 *
 * config.source = {
 *   type: "modbus",
 *   host: "192.168.1.50", port: 502, unitId: 1, timeoutMs: 2000,
 *   registers: [
 *     { metric: "thd_i", address: 40001, register: "holding", type: "float32", scale: 1 },
 *     { metric: "pf",    address: 40003, register: "holding", type: "int16",   scale: 0.001 },
 *     ...
 *   ]
 * }
 *   register — "holding" (4xxxx) or "input" (3xxxx)
 *   type     — int16 | uint16 | int32 | uint32 | float32   (32-bit = 2 registers)
 *   scale    — multiply the raw value (default 1); e.g. 0.001 for milli-units
 */

const WORDS = { int16: 1, uint16: 1, int32: 2, uint32: 2, float32: 2 };

function decode(type, regs) {
  const buf = Buffer.alloc(regs.length * 2);
  regs.forEach((r, i) => buf.writeUInt16BE(r & 0xffff, i * 2)); // big-endian word order
  switch (type) {
    case 'int16':   return buf.readInt16BE(0);
    case 'uint16':  return buf.readUInt16BE(0);
    case 'int32':   return buf.readInt32BE(0);
    case 'uint32':  return buf.readUInt32BE(0);
    case 'float32': return buf.readFloatBE(0);
    default: throw new Error(`unsupported register type: ${type}`);
  }
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

  const client = new Modbus();
  const connect = async () => {
    if (client.isOpen) return;
    await client.connectTCP(cfg.host, { port: cfg.port || 502 });
    client.setID(cfg.unitId ?? 1);
    client.setTimeout(cfg.timeoutMs ?? 2000);
  };

  return {
    async read() {
      await connect();
      const out = [];
      for (const r of registers) {
        const words = WORDS[r.type] ?? 1;
        // 4xxxx/3xxxx are 1-based; the wire protocol addresses from 0.
        const addr = (r.address % 10000) - 1;
        const fn = r.register === 'input' ? client.readInputRegisters : client.readHoldingRegisters;
        const res = await fn.call(client, addr, words);
        const value = decode(r.type, res.data) * (r.scale ?? 1);
        out.push({ metric: r.metric, value: Number(value.toFixed(4)) });
      }
      return out;
    },
    async close() { try { client.close(); } catch { /* ignore */ } },
  };
}
