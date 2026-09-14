/**
 * sim.mjs — SIMULATOR. Synthetic telemetry for testing the gateway end-to-end
 * without a Modbus device.
 *
 * ⚠ THIS IS NOT EVIDENCE OF HARDWARE CORRECTNESS. It exercises the transport,
 * the spool, the dedup identity and the alert engine. It says nothing about
 * whether a register map, an addressing mode or an endianness setting is right
 * for a real device — that requires the hardware pilot described in
 * IOT_HARDWARE_PILOT.md. Telemetry produced here is marked so it can be told
 * apart from a real reading.
 *
 * config.source = {
 *   type: "sim",
 *   metrics: [ { metric: "THD_I_L1", base: 4.0, jitter: 0.6, spikeTo: 9.0, spikeEvery: 20 } ],
 *   qualityNoise: 0.0     // optional: fraction of samples emitted as SUSPECT
 * }
 *   base       — nominal value
 *   jitter     — ± random noise band (default 5% of base)
 *   spikeTo    — value to emit on a spike (optional)
 *   spikeEvery — 1-in-N reads produce a spike (optional)
 */

export async function createSource(cfg) {
  const metrics = Array.isArray(cfg.metrics) ? cfg.metrics : [];
  if (!metrics.length) throw new Error('sim source needs a non-empty metrics[] array');
  const qualityNoise = Number(cfg.qualityNoise) || 0;
  let n = 0;

  console.log(new Date().toISOString(),
    'SIMULATOR SOURCE ACTIVE — values are synthetic and are NOT hardware evidence.');

  return {
    simulated: true,
    async read() {
      n += 1;
      return metrics.map((m) => {
        const jitter = m.jitter ?? Math.abs(m.base) * 0.05;
        let value = m.base + (Math.random() - 0.5) * 2 * jitter;
        if (m.spikeTo != null && m.spikeEvery > 0 && n % m.spikeEvery === 0) value = m.spikeTo;
        const quality = qualityNoise > 0 && Math.random() < qualityNoise ? 'SUSPECT' : 'VALID';
        return { metric: m.metric, value: Number(value.toFixed(3)), quality };
      });
    },
    async close() { /* nothing to release */ },
  };
}
