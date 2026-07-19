/**
 * sim.mjs — synthetic telemetry source for testing the gateway end-to-end
 * without a Modbus device. Emits each configured metric around a baseline with
 * gentle noise, and occasionally spikes so alert rules can be exercised.
 *
 * config.source = {
 *   type: "sim",
 *   metrics: [ { metric: "thd_i", base: 4.0, jitter: 0.6, spikeTo: 9.0, spikeEvery: 20 }, ... ]
 * }
 *   base       — nominal value
 *   jitter     — ± random noise band (default 5% of base)
 *   spikeTo    — value to emit on a spike (optional)
 *   spikeEvery — 1-in-N reads produce a spike (optional)
 */

export async function createSource(cfg) {
  const metrics = Array.isArray(cfg.metrics) ? cfg.metrics : [];
  if (!metrics.length) throw new Error('sim source needs a non-empty metrics[] array');
  let n = 0;

  return {
    async read() {
      n += 1;
      return metrics.map((m) => {
        const jitter = m.jitter ?? Math.abs(m.base) * 0.05;
        let value = m.base + (Math.random() - 0.5) * 2 * jitter;
        if (m.spikeTo != null && m.spikeEvery > 0 && n % m.spikeEvery === 0) value = m.spikeTo;
        return { metric: m.metric, value: Number(value.toFixed(3)) };
      });
    },
    async close() { /* nothing to release */ },
  };
}
